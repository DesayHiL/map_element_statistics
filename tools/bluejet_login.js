// 自动登录 test-bluejet 抓 token（持久化浏览器 user data，首次需人工扫码/登录一次，之后自动复用会话）
const pw = require('../.pwtmp/node_modules/playwright-core').chromium;
const fs = require('fs');

const USER_DATA = 'D:/workspace/map_element_statistics/.pwtmp/profile';
const OUT = 'D:/workspace/map_element_statistics/token.txt';

(async () => {
  const ctx = await pw.launchPersistentContext(USER_DATA, {
    headless: false,
    executablePath: 'C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  let token = null;
  page.on('request', r => {
    const h = r.headers()['authorization'] || '';
    if (!token && h.startsWith('Bearer eyJ')) token = h;
  });
  await page.goto('https://test-bluejet.cxzyuan.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
  // 等待登录后出现带 token 的请求（最长 5 分钟，等用户首次扫码）
  const t0 = Date.now();
  while (!token && Date.now() - t0 < 1800000) await page.waitForTimeout(2000);
  if (!token) { console.log('FAIL: no token captured in 5min'); await ctx.close(); process.exit(1); }
  fs.writeFileSync(OUT, token.replace(/^Bearer /, ''));
  // 验证
  const resp = await page.evaluate(async () => {
    const r = await fetch('/basic-api/aid-cscm/web-api/strategy/station/list', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: localStorage.getItem('ACCESS-Token') || '' },
      body: '{"pageNum":1,"pageSize":1}',
    });
    return r.status;
  }).catch(e => 'eval err ' + e.message);
  console.log('TOKEN_SAVED len', token.length, 'check', resp);
  await ctx.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
