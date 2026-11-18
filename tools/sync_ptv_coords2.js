// 用 PUT /car/station/update 同步坐标（从 siteMana.js 逆向出的接口）
// 用法: node sync_ptv_coords2.js trial | all
const pw = require('../.pwtmp/node_modules/playwright-core').chromium;
const fs = require('fs');
const diff = JSON.parse(fs.readFileSync('D:/workspace/map_element_statistics/out/ptv_site_diff.json', 'utf8'));

(async () => {
  const mode = process.argv[2] || 'trial';
  const bt = Object.fromEntries(diff.test.map(r => [r.name, r]));
  const pairs = diff.prod.filter(p => bt[p.name] &&
    (Math.abs(bt[p.name].lng - p.lng) > 1e-6 || Math.abs(bt[p.name].lat - p.lat) > 1e-6))
    .map(p => ({ test: bt[p.name], prod: p }));
  console.log('待同步:', pairs.length, '个，模式:', mode);
  const todo = mode === 'trial' ? pairs.slice(0, 1) : pairs;

  const ctx = await pw.launchPersistentContext('D:/workspace/map_element_statistics/.pwtmp/profile', {
    headless: false,
    executablePath: 'C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://test-bluejet.cxzyuan.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);

  const res = await page.evaluate(async (todo) => {
    const token = (localStorage.getItem('TOKEN__') || '');
    const authz = token.startsWith('Bearer') ? token : 'Bearer ' + token;
    const H = { 'Content-Type': 'application/json', 'Authorization': authz, 'X-User-Id': '2048' };
    const out = [];
    const listAll = async (name) => {
      for (let p = 1; p <= 20; p++) {
        const r = await fetch('/basic-api/aid-cscm/web-api/strategy/station/list', { method: 'POST', headers: H, body: JSON.stringify({ pageNum: p, pageSize: 200 }) });
        const j = await r.json();
        const rec = Array.isArray(j.data) ? j.data : (j.data && (j.data.records || j.data.list)) || [];
        const hit = rec.find(s => s.stationName === name);
        if (hit) return hit;
        if (!rec.length) return null;
      }
      return null;
    };
    for (const t of todo) {
      try {
        const row = await listAll(t.test.name);
        if (!row) { out.push({ name: t.test.name, ok: false, msg: 'list-not-found' }); continue; }
        const payload = { id: row.id, stationId: row.stationId, name: row.stationName, stationName: row.stationName,
          lat: t.prod.lat, lng: t.prod.lng, line: [[t.prod.lng, t.prod.lat], [t.prod.lng, t.prod.lat]],
          type: row.type, areaId: row.areaId, heading: row.heading, parkingPolygon: row.parkingPolygon || [], bizType: row.bizType };
        const r = await fetch('/basic-api/aid-cscm/web-api/car/station/update', { method: 'PUT', headers: H, body: JSON.stringify(payload) });
        const j = await r.json();
        if (j.code !== 200 && j.code !== 0) { out.push({ name: t.test.name, ok: false, msg: 'update ' + j.code + ' ' + (j.msg || ''), raw: JSON.stringify(j).slice(0, 150) }); continue; }
        await new Promise(s2 => setTimeout(s2, 800));
        const after = await listAll(t.test.name);
        if (!after) { out.push({ name: t.test.name, ok: false, msg: 'after-not-found' }); continue; }
        const okCoord = Math.abs(after.lng - t.prod.lng) < 1e-6 && Math.abs(after.lat - t.prod.lat) < 1e-6;
        out.push({ name: t.test.name, ok: okCoord, msg: okCoord ? 'done' : 'coord-not-updated after=(' + after.lng + ',' + after.lat + ')' });
      } catch (e) { out.push({ name: t.test.name, ok: false, msg: e.message }); }
      await new Promise(s2 => setTimeout(s2, 300));
    }
    return out;
  }, todo);

  let ok = 0, fail = 0;
  for (const r of res) { if (r.ok) ok++; else fail++; console.log((r.ok ? 'OK ' : 'FAIL') + ' ' + r.name + ' ' + r.msg); }
  console.log('\n结果: ok=' + ok + ' fail=' + fail);
  fs.appendFileSync('D:/workspace/map_element_statistics/out/sync_ptv_coords2_log.json', JSON.stringify({ time: new Date().toISOString(), mode, ok, fail, detail: res }, null, 1) + '\n');
  await ctx.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });