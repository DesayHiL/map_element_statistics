// 更新站点坐标：PUT /car/station/update（siteMana.js 逆向），字段 longitude/latitude
// 先试 1 个（trial），成功后 all
const fs = require('fs');
const diff = JSON.parse(fs.readFileSync('out/ptv_site_diff.json', 'utf8'));
const TOKEN = fs.readFileSync('token.txt', 'utf8').trim();
const H = { 'Authorization': 'Bearer ' + TOKEN, 'X-User-Id': '2048', 'X-Customer-Host': 'test-bluejet.cxzyuan.com', 'Content-Type': 'application/json' };
const BJ = 'https://test-bluejet.cxzyuan.com/basic-api/aid-cscm/web-api';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const mode = process.argv[2] || 'trial';
  const bt = Object.fromEntries(diff.test.map(r => [r.name, r]));
  const pairs = diff.prod.filter(p => bt[p.name] &&
    (Math.abs(bt[p.name].lng - p.lng) > 1e-6 || Math.abs(bt[p.name].lat - p.lat) > 1e-6))
    .map(p => ({ test: bt[p.name], prod: p }));
  console.log('待同步:', pairs.length, '个，模式:', mode);
  const todo = mode === 'trial' ? pairs.slice(0, 1) : mode === 'all' ? pairs : pairs.slice(1);

  // 1. 拉全部 car/station/page 行（按名索引）
  const rows = [];
  for (let p = 1; p <= 60; p++) {
    const r = await fetch(BJ + '/car/station/page?pageNum=' + p + '&pageSize=100', { headers: H });
    const j = await r.json();
    const rec = (j.data && (j.data.records || j.data.list)) || [];
    if (!rec.length) break;
    rows.push(...rec);
    const total = (j.data && j.data.total) || 0;
    if (rows.length >= total) break;
    await sleep(120);
  }
  console.log('car/station 总行数:', rows.length);
  const byName = new Map(rows.map(r => [r.stationName, r]));

  // 2. 逐个 PUT update
  const results = [];
  for (const t of todo) {
    const row = byName.get(t.test.name);
    if (!row) { results.push({ name: t.test.name, ok: false, msg: 'page-not-found' }); continue; }
    const payload = Object.assign({}, row, { longitude: t.prod.lng, latitude: t.prod.lat });
    const r = await fetch(BJ + '/car/station/update', { method: 'PUT', headers: H, body: JSON.stringify(payload) });
    const j = await r.json();
    if (j.code !== 200 && j.code !== 0) { results.push({ name: t.test.name, ok: false, msg: 'update ' + j.code + ' ' + (j.msg || '') + ' ' + JSON.stringify(j.data || '').slice(0, 120) }); continue; }
    await sleep(500);
    // 3. 反查验证（strategy/station/list 是另一套 id；用 car page 验证）
    const v = await fetch(BJ + '/car/station/page?pageNum=1&pageSize=20&name=' + encodeURIComponent(t.test.name), { headers: H });
    const vj = await v.json();
    const vrows = (vj.data && (vj.data.records || vj.data.list)) || [];
    const after = vrows.find(s => s.stationName === t.test.name);
    const ok = after && Math.abs(after.longitude - t.prod.lng) < 1e-6 && Math.abs(after.latitude - t.prod.lat) < 1e-6;
    results.push({ name: t.test.name, ok: !!ok, msg: ok ? 'done' : 'not-updated after=(' + (after ? after.longitude + ',' + after.latitude : 'gone') + ')' });
    await sleep(200);
  }
  let okN = 0, failN = 0;
  for (const r of results) { if (r.ok) okN++; else failN++; console.log((r.ok ? 'OK  ' : 'FAIL') + ' ' + r.name + ' :: ' + r.msg); }
  console.log('\n结果: ok=' + okN + ' fail=' + failN);
  fs.appendFileSync('out/sync_car_station_log.json', JSON.stringify({ time: new Date().toISOString(), mode, ok: okN, fail: failN, results }, null, 1) + '\n');
})();