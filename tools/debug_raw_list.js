// 原始调试：页面内调站点列表，打印原始 JSON 响应（test 域），以及 prod 域登录态测试
const pw = require('../.pwtmp/node_modules/playwright-core').chromium;
(async () => {
  const ctx = await pw.launchPersistentContext('D:/workspace/map_element_statistics/.pwtmp/profile', {
    headless: false,
    executablePath: 'C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  await page.goto('https://test-bluejet.cxzyuan.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const raw = await page.evaluate(async () => {
    const token = (localStorage.getItem('TOKEN__') || '');
    const authz = token.startsWith('Bearer') ? token : 'Bearer ' + token;
    const r = await fetch('/basic-api/aid-cscm/web-api/strategy/station/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authz, 'X-User-Id': '2048' },
      body: JSON.stringify({ pageNum: 1, pageSize: 200 }),
    });
    const text = await r.text();
    return { status: r.status, body: text.slice(0, 1500) };
  });
  console.log('test 域原始响应: HTTP', raw.status, '\n', raw.body);

  // prod 域
  await page.goto('https://bluejet.cxzyuan.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const prodLs = await page.evaluate(() => ({ hasToken: !!localStorage.getItem('TOKEN__'), url: location.href }));
  console.log('\nprod 域 localStorage:', JSON.stringify(prodLs));
  await ctx.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });