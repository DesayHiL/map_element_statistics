// v14：打开登录页等用户手工登录（手机+验证码），登录成功后自动保存新 token 到 token.txt
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PW = require(path.join(ROOT, '.pwtmp', 'node_modules', 'playwright-core'));

(async () => {
  const ctx = await PW.chromium.launchPersistentContext(path.join(ROOT, '.pwtmp', 'profile2'), {
    headless: false,
    executablePath: 'C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
    viewport: { width: 1600, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  let saved = false;
  page.on('request', r => {
    const u = r.url();
    if (!saved && /Authorization|Bearer/.test(JSON.stringify(r.headers())) && u.includes('/basic-api/')) {
      const auth = r.headers()['authorization'];
      if (auth && auth.startsWith('Bearer ') && auth.length > 100 && !/undefined|null/.test(auth)) {
        fs.writeFileSync(path.join(ROOT, 'token.txt'), auth.replace('Bearer ', ''));
        console.log('[TOKEN 已保存]', new Date().toISOString(), 'len=' + (auth.length - 7));
        saved = true;
      }
    }
  });
  await page.goto('https://test-bluejet.cxzyuan.com/#/login', { waitUntil: 'domcontentloaded' });
  console.log('请在打开的浏览器窗口完成登录（手机号+验证码）。最长等待 5 分钟...');
  // 等待登录成功：URL 离开 /login
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    if (!page.url().includes('/login')) {
      console.log('登录成功! URL:', page.url());
      // 等待首页稳定后再确认 token 已捕获
      await page.waitForTimeout(5000);
      break;
    }
  }
  if (saved) {
    console.log('token.txt 已更新，可以继续脚本化操作');
  } else {
    // 兜底：从 localStorage/cookie 再找
    const info = await page.evaluate(() => {
      const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = (localStorage.getItem(k) || '').slice(0, 200); }
      return { ls, cookie: document.cookie };
    });
    console.log('未捕获到 Authorization 头。localStorage:', JSON.stringify(info.ls).slice(0, 800));
    console.log('cookie:', info.cookie.slice(0, 400));
  }
  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });