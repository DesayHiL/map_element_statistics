// v13：登录页结构探查（截图+DOM 概要），确定登录方式
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PW = require(path.join(ROOT, '.pwtmp', 'node_modules', 'playwright-core'));

(async () => {
  const ctx = await PW.chromium.launchPersistentContext(path.join(ROOT, '.pwtmp', 'profile2'), {
    headless: false,
    executablePath: 'C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
    viewport: { width: 1600, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://test-bluejet.cxzyuan.com/#/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap13_login.png') });
  // DOM 概要
  const inputs = await page.locator('input').all();
  for (const inp of inputs) {
    const ph = await inp.getAttribute('placeholder').catch(() => null);
    const type = await inp.getAttribute('type').catch(() => null);
    console.log('input:', type, '|', ph);
  }
  const btns = await page.locator('button').all();
  for (const b of btns) {
    console.log('button:', (await b.textContent().catch(() => '')).trim().slice(0, 30));
  }
  // sessionStorage / cookie 概要
  const info = await page.evaluate(() => {
    const ss = {}; for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); ss[k] = (sessionStorage.getItem(k) || '').slice(0, 100); }
    return { ss, cookie: document.cookie.slice(0, 400) };
  });
  console.log('sessionStorage:', JSON.stringify(info.ss));
  console.log('cookie:', info.cookie);
  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });