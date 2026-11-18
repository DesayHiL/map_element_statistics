// 批量同步 PTV 站点坐标：POST /strategy/station/update {id, type, stationName, lat, lng, line}
// 方向：prod 新坐标 → test（已试 1 个成功，本脚本跑剩余）
const fs = require('fs');
const diff = JSON.parse(fs.readFileSync('out/ptv_site_diff.json', 'utf8'));
const TOKEN = fs.readFileSync('token.txt', 'utf8').trim();
const H = { 'Authorization': 'Bearer ' + TOKEN, 'X-User-Id': '2048', 'X-Customer-Host': 'test-bluejet.cxzyuan.com', 'Content-Type': 'application/json' };
const BJ = 'https://test-bluejet.cxzyuan.com/basic-api/aid-cscm/web-api';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // 1. test 全量 strategy 站点按名索引
  const rows = [];
  for (let p = 1; p <= 30; p++) {
    const r = await fetch(BJ + '/strategy/station/list', { method: 'POST', headers: H, body: JSON.stringify({ pageNum: p, pageSize: 200 }) });
    const j = await r.json();
    const rec = Array.isArray(j.data) ? j.data : (j.data && (j.data.records || j.data.list)) || [];
    if (!rec.length) break;
    rows.push(...rec);
    if (rows.length >= (j.data && j.data.total || rows.length)) break;
    await sleep(150);
  }
  console.log('test 策略站点总数:', rows.length);
  const byName = new Map(rows.map(r => [r.stationName, r]));

  // 2. 差异对（跳过已完成的第 1 个：路线2-终点-康达学校）
  const bt = Object.fromEntries(diff.test.map(r => [r.name, r]));
  const pairs = diff.prod.filter(p => bt[p.name] &&
    (Math.abs(bt[p.name].lng - p.lng) > 1e-6 || Math.abs(bt[p.name].lat - p.lat) > 1e-6));
  const done1 = 'PTV-区域测试-路线2-小金口街道-终点-康达学校';
  const todo = pairs.filter(p => p.name !== done1);
  console.log('剩余待同步:', todo.length);

  const results = [];
  for (const p of todo) {
    const row = byName.get(p.name);
    if (!row) { results.push({ name: p.name, ok: false, msg: 'not-in-test' }); console.log('FAIL ' + p.name + ' :: not-in-test'); continue; }
    const payload = { id: row.id, type: row.type, stationName: row.stationName, lat: p.lat, lng: p.lng, line: [[p.lng, p.lat], [p.lng, p.lat]] };
    let j = null;
    for (let a = 0; a < 3; a++) {
      const r = await fetch(BJ + '/strategy/station/update', { method: 'POST', headers: H, body: JSON.stringify(payload) });
      j = await r.json();
      if (j.code === 200 || j.code === 0) break;
      await sleep(800);
    }
    const ok = j && (j.code === 200 || j.code === 0);
    results.push({ name: p.name, ok: !!ok, msg: ok ? 'done' : j.code + ' ' + (j.msg || '') });
    console.log((ok ? 'OK  ' : 'FAIL') + ' ' + p.name + ' :: ' + (ok ? 'done' : j.code + ' ' + j.msg));
    await sleep(250);
  }

  // 3. 终验：重拉 list，全部对齐 prod
  const rows2 = [];
  for (let p = 1; p <= 30; p++) {
    const r = await fetch(BJ + '/strategy/station/list', { method: 'POST', headers: H, body: JSON.stringify({ pageNum: p, pageSize: 200 }) });
    const j = await r.json();
    const rec = Array.isArray(j.data) ? j.data : (j.data && (j.data.records || j.data.list)) || [];
    if (!rec.length) break;
    rows2.push(...rec);
    if (rows2.length >= (j.data && j.data.total || rows2.length)) break;
    await sleep(150);
  }
  const byName2 = new Map(rows2.map(r => [r.stationName, r]));
  let bad = 0;
  for (const p of pairs) {
    const a = byName2.get(p.name);
    if (!a || Math.abs(a.lng - p.lng) > 1e-6 || Math.abs(a.lat - p.lat) > 1e-6) { bad++; console.log('未对齐: ' + p.name + ' now=(' + (a ? a.lng + ',' + a.lat : 'missing') + ') want=(' + p.lng + ',' + p.lat + ')'); }
  }
  console.log('\n批量结果: ok=' + results.filter(r => r.ok).length + ' fail=' + results.filter(r => !r.ok).length);
  console.log('终验未对齐: ' + bad + ' 个');
  fs.appendFileSync('out/sync_strategy_station_log.json', JSON.stringify({ time: new Date().toISOString(), batch: results.length, fail: results.filter(r => !r.ok).length, finalBad: bad, results }, null, 1) + '\n');
})();