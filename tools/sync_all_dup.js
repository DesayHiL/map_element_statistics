// 对 test 环境所有 PTV 站点（含全部重名行）按 prod 快照对齐坐标
const fs = require('fs');
const diff = JSON.parse(fs.readFileSync('out/ptv_site_diff.json', 'utf8'));
const TOKEN = fs.readFileSync('token.txt', 'utf8').trim();
const H = { 'Authorization': 'Bearer ' + TOKEN, 'X-User-Id': '2048', 'X-Customer-Host': 'test-bluejet.cxzyuan.com', 'Content-Type': 'application/json' };
const BJ = 'https://test-bluejet.cxzyuan.com/basic-api/aid-cscm/web-api';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // prod 目标坐标表
  const want = new Map(diff.prod.map(r => [r.name, r]));

  // 拉全量 test
  const rows = [];
  for (let p = 1; p <= 40; p++) {
    const r = await fetch(BJ + '/strategy/station/list', { method: 'POST', headers: H, body: JSON.stringify({ pageNum: p, pageSize: 200 }) });
    const j = await r.json();
    const rec = Array.isArray(j.data) ? j.data : [];
    if (!rec.length) break;
    rows.push(...rec);
    if (rows.length >= (j.data && j.data.total || rows.length)) break;
    await sleep(150);
  }
  const ptvRows = rows.filter(r => (r.stationName || '').startsWith('PTV-'));
  console.log('test PTV 行数（含重名）:', ptvRows.length, '| prod 目标:', want.size);

  // 需要更新的行：名字在 prod 有记录 且 坐标不一致
  const todo = ptvRows.filter(r => {
    const w = want.get(r.stationName);
    return w && (Math.abs(r.lng - w.lng) > 1e-6 || Math.abs(r.lat - w.lat) > 1e-6);
  });
  console.log('需更新行:', todo.length);
  let ok = 0, fail = 0;
  for (const r of todo) {
    const w = want.get(r.stationName);
    const payload = { id: r.id, type: r.type, stationName: r.stationName, lat: w.lat, lng: w.lng, line: [[w.lng, w.lat], [w.lng, w.lat]] };
    let j = null;
    for (let a = 0; a < 3; a++) {
      const resp = await fetch(BJ + '/strategy/station/update', { method: 'POST', headers: H, body: JSON.stringify(payload) });
      j = await resp.json();
      if (j.code === 200 || j.code === 0) break;
      await sleep(800);
    }
    const good = j && (j.code === 200 || j.code === 0);
    if (good) ok++; else { fail++; console.log('FAIL ' + r.stationName + ' id=' + r.id + ' :: ' + (j ? j.code + ' ' + j.msg : 'null')); }
    await sleep(200);
  }
  console.log('更新完成: ok=' + ok + ' fail=' + fail);

  // 终验
  const rows2 = [];
  for (let p = 1; p <= 40; p++) {
    const r = await fetch(BJ + '/strategy/station/list', { method: 'POST', headers: H, body: JSON.stringify({ pageNum: p, pageSize: 200 }) });
    const j = await r.json();
    const rec = Array.isArray(j.data) ? j.data : [];
    if (!rec.length) break;
    rows2.push(...rec);
    if (rows2.length >= (j.data && j.data.total || rows2.length)) break;
    await sleep(150);
  }
  let bad = 0;
  for (const r of rows2.filter(x => (x.stationName || '').startsWith('PTV-'))) {
    const w = want.get(r.stationName);
    if (w && (Math.abs(r.lng - w.lng) > 1e-6 || Math.abs(r.lat - w.lat) > 1e-6)) { bad++; console.log('[未对齐] ' + r.stationName + ' id=' + r.id + ' (' + r.lng + ',' + r.lat + ')'); }
  }
  const namesOnly = new Set(rows2.filter(x => (x.stationName || '').startsWith('PTV-')).map(x => x.stationName));
  const prodNoTest = [...want.keys()].filter(n => !namesOnly.has(n));
  console.log('\n=== 终验 ===');
  console.log('与 prod 坐标未对齐:', bad, '个 | prod 有而 test 缺:', prodNoTest.length, '个');
  if (prodNoTest.length) prodNoTest.forEach(n => console.log(' [test缺] ' + n));
  console.log(bad === 0 && prodNoTest.length === 0 ? '✅ 全部对齐' : '❌ 有差异');
  fs.appendFileSync('out/sync_all_dup_log.json', JSON.stringify({ time: new Date().toISOString(), updated: ok, fail, bad, prodNoTest }, null, 1) + '\n');
})();