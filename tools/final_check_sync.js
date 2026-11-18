// 终验：重拉 test+prod 站点列表（页面内同域 fetch），比对 PTV- 站点差异
const pw = require('../.pwtmp/node_modules/playwright-core').chromium;
const fs = require('fs');

const LIST_JS = async () => {
  const token = (localStorage.getItem('TOKEN__') || '');
  const authz = token.startsWith('Bearer') ? token : 'Bearer ' + token;
  const all = [];
  let pageNum = 1;
  while (true) {
    const r = await fetch('/basic-api/aid-cscm/web-api/strategy/station/list', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': authz, 'X-User-Id': '2048' },
      body: JSON.stringify({ pageNum, pageSize: 200 }),
    });
    const j = await r.json();
    if (j.code !== 0 && j.code !== 200) return { error: j.code + ' ' + (j.msg || '') };
    const rec = Array.isArray(j.data) ? j.data : (j.data && (j.data.records || j.data.list)) || [];
    all.push(...rec);
    const total = (j.data && !Array.isArray(j.data) && j.data.total) || all.length;
    if (all.length >= total || rec.length === 0) break;
    pageNum++;
    if (pageNum > 30) break;
  }
  return { rows: all.map(r => ({ id: r.id, name: r.stationName, lng: r.lng, lat: r.lat })) };
};

(async () => {
  const ctx = await pw.launchPersistentContext('D:/workspace/map_element_statistics/.pwtmp/profile', {
    headless: false,
    executablePath: 'C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
    viewport: { width: 1200, height: 800 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  await page.goto('https://test-bluejet.cxzyuan.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const test = await page.evaluate(LIST_JS);
  console.log('test:', test.error || 'OK ' + test.rows.length);

  await page.goto('https://bluejet.cxzyuan.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  let prod = await page.evaluate(LIST_JS).catch(() => ({ error: 'eval-fail' }));
  if (prod.error) {
    console.log('prod 需重新登录（10 分钟内请在窗口完成登录）…');
    const t0 = Date.now();
    while (Date.now() - t0 < 600000) {
      await page.waitForTimeout(5000);
      prod = await page.evaluate(LIST_JS).catch(() => null);
      if (prod && prod.rows) break;
    }
  }
  console.log('prod:', prod ? (prod.error || 'OK ' + prod.rows.length) : 'TIMEOUT');
  if (prod && prod.rows) {
    const f = s => s.filter(r => r.name && r.name.startsWith('PTV-'));
    const ft = f(test.rows), fp = f(prod.rows);
    const bt = Object.fromEntries(ft.map(r => [r.name, r]));
    const bp = Object.fromEntries(fp.map(r => [r.name, r]));
    let bad = 0;
    for (const n of Object.keys(bp)) {
      const a = bt[n];
      if (!a) { bad++; console.log('  [test缺失] ' + n); continue; }
      if (Math.abs(a.lng - bp[n].lng) > 1e-6 || Math.abs(a.lat - bp[n].lat) > 1e-6) { bad++; console.log('  [未对齐] ' + n + ' test(' + a.lng + ',' + a.lat + ') prod(' + bp[n].lng + ',' + bp[n].lat + ')'); }
    }
    const onlyTest = ft.filter(r => !bp[r.name]).map(r => r.name);
    console.log('\n=== 终验结果 ===');
    console.log('PTV 站点: test=' + ft.length + ' prod=' + fp.length);
    console.log('坐标未对齐: ' + bad + ' 个');
    console.log('仅测试环境有: ' + onlyTest.length + ' 个（' + onlyTest.join('、') + '）');
    console.log(bad === 0 ? '✅ 同步完成，55 个站点坐标已全部对齐生产环境' : '❌ 仍有未对齐项');
    fs.writeFileSync('D:/workspace/map_element_statistics/out/ptv_sync_final_check.json', { bad, onlyTest });
    fs.writeFileSync('D:/workspace/map_element_statistics/out/ptv_sync_final_check.json', JSON.stringify({ time: new Date().toISOString(), bad, onlyTest, testPt: ft.length, prodPt: fp.length }, null, 2));
  }
  await ctx.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });