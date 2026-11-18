// 对比 test vs prod 站点（v3：正确解析 data 数组/stationName；prod 无登录态时种 test token 后重试）
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

  // 1. test 域拉取，并取 token
  await page.goto('https://test-bluejet.cxzyuan.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const testTok = await page.evaluate(() => localStorage.getItem('TOKEN__') || '');
  const refreshTok = await page.evaluate(() => localStorage.getItem('REFRESH_TOKEN__') || '');
  const test = await page.evaluate(LIST_JS);
  console.log('test:', test.error || ('OK ' + test.rows.length + ' 个站点'));

  // 2. prod 域：无登录态则种 token 再试
  await page.goto('https://bluejet.cxzyuan.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  let hasTok = await page.evaluate(() => !!localStorage.getItem('TOKEN__'));
  if (!hasTok && testTok) {
    await page.evaluate(([t, rt]) => { localStorage.setItem('TOKEN__', t); if (rt) localStorage.setItem('REFRESH_TOKEN__', rt); }, [testTok, refreshTok]);
    console.log('已把 test token 种到 prod 域 localStorage');
  }
  let prod = await page.evaluate(LIST_JS);
  if (prod.error) {
    // 种 token 失败则尝试刷新页面让前端走自动续期
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(5000);
    prod = await page.evaluate(LIST_JS);
  }
  console.log('prod:', prod.error || ('OK ' + prod.rows.length + ' 个站点'));

  if (test.rows && prod.rows) {
    const pt = new Set(test.rows.map(r => r.name));
    const pp = new Set(prod.rows.map(r => r.name));
    const onlyProd = [...pp].filter(n => !pt.has(n));
    const onlyTest = [...pt].filter(n => !pp.has(n));
    console.log('\n=== 仅生产环境有（需同步到测试）: ' + onlyProd.length + ' 个 ===');
    onlyProd.forEach(n => { const s = prod.rows.find(r => r.name === n); console.log('  ' + n + '  (' + s.lng + ',' + s.lat + ') area=' + (s.areaName || s.areaId)); });
    console.log('\n=== 仅测试环境有: ' + onlyTest.length + ' 个 ===');
    onlyTest.forEach(n => console.log('  ' + n));
    const bt = Object.fromEntries(test.rows.map(r => [r.name, r]));
    const bp = Object.fromEntries(prod.rows.map(r => [r.name, r]));
    let diff = 0;
    for (const n of pp) if (pt.has(n)) {
      const a = bt[n], b = bp[n];
      if (Math.abs((a.lng||0)-(b.lng||0)) > 1e-6 || Math.abs((a.lat||0)-(b.lat||0)) > 1e-6 || (a.address||'') !== (b.address||'')) {
        diff++; console.log('  [差异] ' + n + '\n    test : ' + a.lng + ',' + a.lat + ' "' + (a.address||'') + '"\n    prod : ' + b.lng + ',' + b.lat + ' "' + (b.address||'') + '"');
      }
    }
    console.log('\n共名站点内容差异:', diff, '个');
    fs.writeFileSync('D:/workspace/map_element_statistics/out/site_diff.json', JSON.stringify({ prod: prod.rows, test: test.rows }, null, 2));
    console.log('完整数据已存 out/site_diff.json');
  }
  await ctx.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });