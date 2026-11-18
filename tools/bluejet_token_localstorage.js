// 直接从持久化 profile 的 localStorage 抓 ACCESS-Token（login 脚本抓 request header 拿到的是旧值）
const pw = require('../.pwtmp/node_modules/playwright-core').chromium;
const fs = require('fs');
(async () => {
  const ctx = await pw.launchPersistentContext('D:/workspace/map_element_statistics/.pwtmp/profile', {
    headless: false,
    executablePath: 'C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://test-bluejet.cxzyuan.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { });
  await page.waitForTimeout(5000);
  const tok = await page.evaluate(() => {
    for (const k of ['ACCESS-Token', 'accessToken', 'ACCESS_TOKEN', 'token']) {
      const v = localStorage.getItem(k);
      if (v && v.length > 50) return { k, v };
    }
    const keys = Object.keys(localStorage);
    return { keys };
  });
  if (tok.v) {
    fs.writeFileSync('token.txt', tok.v.replace(/^Bearer /, ''));
    console.log('saved from localStorage key:', tok.k, 'len', tok.v.length);
    // 验证
    const resp = await page.evaluate(async () => {
      const r = await fetch('/basic-api/aid-cscm/web-api/strategy/station/list', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: localStorage.getItem('ACCESS-Token') || '' },
        body: '{"pageNum":1,"pageSize":1}',
      });
      return r.status;
    }).catch((e) => 'eval err ' + e.message);
    console.log('check', resp);
  } else {
    console.log('localStorage keys:', JSON.stringify(tok.keys));
  }
  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });