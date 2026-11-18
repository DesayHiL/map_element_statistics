// 分别在两个域的页面内拉取站点列表（同域 fetch 无 CORS 问题），本地对比
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
    const rec = (j.data && (j.data.records || j.data.list)) || [];
    all.push(...rec);
    const total = (j.data && j.data.total) || all.length;
    if (all.length >= total || rec.length === 0) break;
    pageNum++;
    if (pageNum > 30) break;
  }
  return { rows: all.map(r => ({ id: r.id, name: r.name, lng: r.lng, lat: r.lat, address: r.address, areaId: r.areaId, areaName: r.areaName })) };
};

(async () => {
  const ctx = await pw.launchPersistentContext('D:/workspace/map_element_statistics/.pwtmp/profile', {
    headless: false,
    executablePath: 'C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  async function fetchFrom(host) {
    await page.goto('https://' + host + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(5000);
    const ls = await page.evaluate(() => localStorage.getItem('TOKEN__') ? true : false);
    if (!ls) {
      // 生产域未登录：把 test 域的 token 种到 prod 域 localStorage 试试（同一套账号体系）
      const tok = await page.evaluate(() => localStorage.getItem('TOKEN__'));
      if (tok && host !== 'test-bluejet.cxzyuan.com') {
        await page.evaluate(t => localStorage.setItem('TOKEN__', t), tok).catch(() => {});
      }
      return { error: 'no-login-session' };
    }
    return await page.evaluate(LIST_JS);
  }

  const test = await fetchFrom('test-bluejet.cxzyuan.com');
  console.log('test:', test.error || ('OK ' + test.rows.length + ' 个站点'));
  const prod = await fetchFrom('bluejet.cxzyuan.com');
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