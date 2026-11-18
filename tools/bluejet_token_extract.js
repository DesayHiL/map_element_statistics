// 弹浏览器登录 bluejet（持久化 profile），轮询 localStorage 提取 access+refresh token
const pw = require('../.pwtmp/node_modules/playwright-core').chromium;
const fs = require('fs');
(async () => {
  const ctx = await pw.launchPersistentContext('D:/workspace/map_element_statistics/.pwtmp/profile', {
    headless: false,
    executablePath: 'C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://test-bluejet.cxzyuan.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
  const getTok = (kw) => page.evaluate((kw) => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i); const v = localStorage.getItem(k);
      if (k.includes(kw) && v && v.includes('eyJ')) return v.replace(/^Bearer\s*/, '');
    }
    return null;
  }, kw).catch(() => null);
  const t0 = Date.now(); let tok = null;
  while (Date.now() - t0 < 1800000) {
    tok = await getTok('TOKEN');
    if (tok) break;
    await page.waitForTimeout(2000);
  }
  if (tok) {
    fs.writeFileSync('D:/workspace/map_element_statistics/token.txt', tok);
    const rt = await getTok('REFRESH');
    if (rt) fs.writeFileSync('D:/workspace/map_element_statistics/bj_refresh.txt', rt);
    console.log('TOKEN_SAVED', tok.length, rt ? 'refresh-saved' : '');
  } else console.log('NO_TOKEN after 30min');
  await ctx.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
