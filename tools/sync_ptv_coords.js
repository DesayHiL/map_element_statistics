// 同步坐标：把 test 环境 55 个落后站点更新为 prod 新坐标。
// 用法: node sync_ptv_coords.js trial   （先试 1 个）
//       node sync_ptv_coords.js all     （剩余全部）
// 在 test 域页面内执行（同域 fetch），站点更新走 /strategy/station/save 带 stationId。
const pw = require('../.pwtmp/node_modules/playwright-core').chromium;
const fs = require('fs');
const diff = JSON.parse(fs.readFileSync('D:/workspace/map_element_statistics/out/ptv_site_diff.json', 'utf8'));

(async () => {
  const mode = process.argv[2] || 'trial';
  // 差异集合（test 有但坐标 != prod）
  const bt = Object.fromEntries(diff.test.map(r => [r.name, r]));
  const bp = Object.fromEntries(diff.prod.map(r => [r.name, r]));
  const pairs = diff.prod.filter(p => bt[p.name] &&
    (Math.abs(bt[p.name].lng - p.lng) > 1e-6 || Math.abs(bt[p.name].lat - p.lat) > 1e-6))
    .map(p => ({ test: bt[p.name], prod: p }));
  console.log('待同步:', pairs.length, '个，模式:', mode);
  const todo = mode === 'trial' ? pairs.slice(0, 1) : pairs.slice(1);

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
      // 反查：翻页找该名站点
      for (let p = 1; p <= 15; p++) {
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
        // save 带 stationId = 更新（先读完整行再改坐标）
        const row = await listAll(t.test.name);
        if (!row) { out.push({ name: t.test.name, ok: false, msg: 'list-not-found' }); continue; }
        const payload = {
          stationId: row.stationId, id: row.id, strategyId: row.strategyId, routePlanStationId: row.routePlanStationId,
          name: row.stationName, stationName: row.stationName, type: row.type, areaId: row.areaId,
          lng: t.prod.lng, lat: t.prod.lat,
          line: [[t.prod.lng, t.prod.lat], [t.prod.lng, t.prod.lat]],
          heading: row.heading, parkingPolygon: row.parkingPolygon || [], bizType: row.bizType,
          province: row.province, city: row.city, district: row.district, address: row.address,
        };
        const r = await fetch('/basic-api/aid-cscm/web-api/strategy/station/save', { method: 'POST', headers: H, body: JSON.stringify(payload) });
        const j = await r.json();
        if (j.code !== 200 && j.code !== 0) { out.push({ name: t.test.name, ok: false, msg: 'save ' + j.code + ' ' + (j.msg || '') }); continue; }
        await new Promise(s2 => setTimeout(s2, 600));
        const after = await listAll(t.test.name);
        if (!after) { out.push({ name: t.test.name, ok: false, msg: 'after-not-found' }); continue; }
        const okCoord = Math.abs(after.lng - t.prod.lng) < 1e-6 && Math.abs(after.lat - t.prod.lat) < 1e-6;
        out.push({ name: t.test.name, ok: okCoord, msg: okCoord ? 'done' : 'coord-not-updated after=(' + after.lng + ',' + after.lat + ')' });
      } catch (e) { out.push({ name: t.test.name, ok: false, msg: e.message }); }
      await new Promise(s2 => setTimeout(s2, 250));
    }
    return out;
  }, todo);

  let ok = 0, fail = 0;
  for (const r of res) { if (r.ok) ok++; else fail++; console.log((r.ok ? 'OK ' : 'FAIL') + ' ' + r.name + ' ' + r.msg); }
  console.log('\n结果: ok=' + ok + ' fail=' + fail);
  fs.appendFileSync('D:/workspace/map_element_statistics/out/sync_ptv_coords_log.json', JSON.stringify({ time: new Date().toISOString(), mode, ok, fail, detail: res }, null, 1) + '\n');
  await ctx.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });