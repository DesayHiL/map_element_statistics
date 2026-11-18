// 打开生产域登录页，等用户登录后拉取 prod 站点，与 test（已有 1236 个）对比 PTV- 站点
const pw = require('../.pwtmp/node_modules/playwright-core').chromium;
const fs = require('fs');

const LIST_JS = async () => {
  const token = (localStorage.getItem('TOKEN__') || '');
  const authz = token.startsWith('Bearer') ? token : 'Bearer ' + token;
  const all = [];
  let pageNum = 1;
  while (true) {
    const r = await fetch('/basic-api/aid-cscm/web-api/strategy/station/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authz, 'X-User-Id': '2048' },
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
  return { rows: all.map(r => ({ id: r.id, name: r.stationName, lng: r.lng, lat: r.lat, address: r.address, areaId: r.areaId, areaName: r.areaName })) };
};

(async () => {
  const ctx = await pw.launchPersistentContext('D:/workspace/map_element_statistics/.pwtmp/profile', {
    headless: false,
    executablePath: 'C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  // 1. test 拉取
  await page.goto('https://test-bluejet.cxzyuan.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const test = await page.evaluate(LIST_JS);
  console.log('test:', test.error || ('OK ' + test.rows.length + ' 个站点'));

  // 2. prod：打开等待人工登录（最长 20 分钟），轮询 TOKEN__ 直到拉取成功
  await page.goto('https://bluejet.cxzyuan.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  console.log('请在弹出的 Chromium 窗口登录生产环境 bluejet.cxzyuan.com ...');
  let prod = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 1200000) {
    await page.waitForTimeout(4000);
    prod = await page.evaluate(LIST_JS).catch(() => null);
    if (prod && prod.rows) break;
    if (prod && prod.error && !String(prod.error).startsWith('401') && !String(prod.error).includes('登录')) break;
  }
  console.log('prod:', prod ? (prod.error || ('OK ' + prod.rows.length + ' 个站点')) : 'TIMEOUT');

  if (prod && prod.rows) {
    const f = s => s.filter(r => r.name && r.name.startsWith('PTV-'));
    const ft = f(test.rows), fp = f(prod.rows);
    console.log('\ntest PTV- 站点: ' + ft.length + ' 个 | prod PTV- 站点: ' + fp.length + ' 个');
    const pt = new Set(ft.map(r => r.name));
    const pp = new Set(fp.map(r => r.name));
    const onlyProd = [...pp].filter(n => !pt.has(n));
    const onlyTest = [...pt].filter(n => !pp.has(n));
    console.log('\n=== 仅生产环境有（需同步到测试）: ' + onlyProd.length + ' 个 ===');
    onlyProd.forEach(n => { const s = fp.find(r => r.name === n); console.log('  ' + n + '  (' + s.lng + ',' + s.lat + ') area=' + (s.areaName || s.areaId)); });
    console.log('\n=== 仅测试环境有: ' + onlyTest.length + ' 个 ===');
    onlyTest.forEach(n => console.log('  ' + n));
    const bt = Object.fromEntries(ft.map(r => [r.name, r]));
    const bp = Object.fromEntries(fp.map(r => [r.name, r]));
    let diff = 0;
    for (const n of pp) if (pt.has(n)) {
      const a = bt[n], b = bp[n];
      if (Math.abs((a.lng||0)-(b.lng||0)) > 1e-6 || Math.abs((a.lat||0)-(b.lat||0)) > 1e-6) {
        diff++; console.log('  [坐标差异] ' + n + '  test(' + a.lng + ',' + a.lat + ') prod(' + b.lng + ',' + b.lat + ')');
      }
    }
    console.log('\n共名 PTV 站点坐标差异:', diff, '个');
    fs.writeFileSync('D:/workspace/map_element_statistics/out/ptv_site_diff.json', JSON.stringify({ prod: fp, test: ft }, null, 2));
    console.log('PTV 站点明细已存 out/ptv_site_diff.json');
  }
  await ctx.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });