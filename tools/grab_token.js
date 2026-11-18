// 从已登录页面取 TOKEN__ 写回 token.txt（修复 Node fetch 401 的根因：token.txt 是旧值）
const pw = require('../.pwtmp/node_modules/playwright-core').chromium;
const fs = require('fs');
(async () => {
  const ctx = await pw.launchPersistentContext('D:/workspace/map_element_statistics/.pwtmp/profile', {
    headless: false,
    executablePath: 'C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
    viewport: { width: 1000, height: 700 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://test-bluejet.cxzyuan.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const raw = await page.evaluate(() => localStorage.getItem('TOKEN__') || '');
  const t = raw.replace(/^Bearer\s+/, '');
  if (t.startsWith('eyJ')) {
    const p = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
    console.log('token exp:', new Date(p.exp * 1000).toLocaleString(), 'user:', p.username || p.user_name);
    fs.writeFileSync('D:/workspace/map_element_statistics/token.txt', t);
    console.log('written to token.txt');
  } else console.log('FAIL no token in localStorage', raw.slice(0, 50));
  await ctx.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });