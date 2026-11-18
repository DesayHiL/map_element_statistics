// 在已登录的浏览器页面内直接调站点列表 API 对比 test vs prod（页面内 fetch，绕开 token 抓取问题）
const pw = require('../.pwtmp/node_modules/playwright-core').chromium;
const fs = require('fs');
(async () => {
  const ctx = await pw.launchPersistentContext('D:/workspace/map_element_statistics/.pwtmp/profile', {
    headless: false,
    executablePath: 'C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://test-bluejet.cxzyuan.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const result = await page.evaluate(async () => {
    const token = (localStorage.getItem('TOKEN__') || '');
    const authz = token.startsWith('Bearer') ? token : 'Bearer ' + token;
    const call = async (host, body) => {
      const r = await fetch('https://' + host + '/basic-api/aid-cscm/web-api/strategy/station/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': authz, 'X-User-Id': '2048', 'X-Customer-Host': host },
        body: JSON.stringify(body),
      });
      return await r.json();
    };
    const test = await call('test-bluejet.cxzyuan.com', { pageNum: 1, pageSize: 500 });
    const prod = await call('bluejet.cxzyuan.com', { pageNum: 1, pageSize: 500 });
    const g = j => (j.data && (j.data.records || j.data.list)) || [];
    return { testCode: test.code, testMsg: test.msg, prodCode: prod.code, prodMsg: prod.msg,
             test: g(test), prod: g(prod), testTotal: test.data && test.data.total, prodTotal: prod.data && prod.data.total };
  });
  console.log('test:', result.testCode, result.testMsg, 'total=', result.testTotal);
  console.log('prod:', result.prodCode, result.prodMsg, 'total=', result.prodTotal);
  if (result.testCode === 0 && result.prodCode === 0) {
    const pt = new Set(result.test.map(r => r.name));
    const pp = new Set(result.prod.map(r => r.name));
    const onlyProd = [...pp].filter(n => !pt.has(n));
    const onlyTest = [...pt].filter(n => !pp.has(n));
    console.log('\n--- 仅生产环境有（需同步到测试）: ' + onlyProd.length + ' 个');
    onlyProd.forEach(n => console.log('  ' + n));
    console.log('\n--- 仅测试环境有: ' + onlyTest.length + ' 个');
    onlyTest.forEach(n => console.log('  ' + n));
    const bt = Object.fromEntries(result.test.map(r => [r.name, r]));
    const bp = Object.fromEntries(result.prod.map(r => [r.name, r]));
    let diff = 0;
    for (const n of pp) if (pt.has(n)) {
      const a = bt[n], b = bp[n];
      if (Math.abs((a.lng||0)-(b.lng||0)) > 1e-6 || Math.abs((a.lat||0)-(b.lat||0)) > 1e-6 || (a.address||'') !== (b.address||'')) {
        diff++; console.log('  [坐标/地址差异] ' + n + ' test(' + a.lng + ',' + a.lat + ',' + (a.address||'') + ') prod(' + b.lng + ',' + b.lat + ',' + (b.address||'') + ')');
      }
    }
    console.log('\n共名站点内容差异:', diff, '个');
    fs.writeFileSync('D:/workspace/map_element_statistics/out/site_diff.json', JSON.stringify({ prod: result.prod, test: result.test }, null, 2));
    console.log('完整数据已存 out/site_diff.json');
    // 同时把页面内有效的 token 存下来（供后续同步用）
    const tok = await page.evaluate(() => (localStorage.getItem('TOKEN__') || '').replace(/^Bearer\s+/, ''));
    if (tok.startsWith('eyJ')) { fs.writeFileSync('D:/workspace/map_element_statistics/token.txt', tok); console.log('页面内 token 已写回 token.txt（页面侧验证可用）'); }
  }
  await ctx.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });