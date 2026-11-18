// 深挖：在登录页面上下文里发 list 请求，打印完整业务返回 + localStorage/cookie 里的 token 来源
const pw = require('../.pwtmp/node_modules/playwright-core').chromium;
const fs = require('fs');
(async () => {
  const ctx = await pw.launchPersistentContext('D:/workspace/map_element_statistics/.pwtmp/profile', {
    headless: false,
    executablePath: 'C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  // 记录所有带 Authorization 的请求
  const seen = [];
  page.on('request', (r) => {
    const h = r.headers()['authorization'] || '';
    if (h) seen.push({ url: r.url().slice(0, 90), auth: h.slice(0, 40) + '...len' + h.length, t: Date.now() });
  });
  await page.goto('https://test-bluejet.cxzyuan.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { });
  await page.waitForTimeout(8000);
  // 页面里发 list
  const body = await page.evaluate(async () => {
    const ls = {}; for (const k of Object.keys(localStorage)) ls[k] = (localStorage.getItem(k) || '').slice(0, 50);
    const ck = document.cookie.slice(0, 200);
    let api = null;
    try {
      const r = await fetch('/basic-api/aid-cscm/web-api/strategy/station/list', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: localStorage.getItem('ACCESS-Token') || '' },
        body: '{"pageNum":1,"pageSize":1}',
      });
      api = await r.text();
    } catch (e) { api = 'ERR ' + e.message; }
    return { ls, ck, api: api.slice(0, 200) };
  });
  console.log('localStorage:', JSON.stringify(body.ls));
  console.log('cookie:', body.ck);
  console.log('页面内 list 返回:', body.api);
  console.log('抓到的 Authorization 请求:', JSON.stringify(seen.slice(0, 5), null, 1));
  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });