// v15：账号密码登录（18588749605/888888），成功后保存 token
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
  let tokenVal = null;
  page.on('request', r => {
    const u = r.url();
    if (u.includes('/basic-api/')) {
      const auth = r.headers()['authorization'];
      if (auth && auth.startsWith('Bearer ') && auth.length > 100) {
        if (!tokenVal || auth.length > tokenVal.length) {
          tokenVal = auth;
          fs.writeFileSync(path.join(ROOT, 'token.txt'), auth.replace('Bearer ', ''));
          if (!saved) { console.log('[TOKEN 已保存] len=' + (auth.length - 7)); saved = true; }
        }
      }
    }
    if (/login|auth/.test(u)) console.log('[REQ]', u.slice(60, 140), r.postData() ? r.postData().slice(0, 200) : '');
  });

  await page.goto('https://test-bluejet.cxzyuan.com/#/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  // 找密码登录 tab（页面可能有 账号密码/短信 切换）
  for (const t of ['密码登录', '账号密码登录', '账号密码']) {
    const tab = page.getByText(t, { exact: false }).first();
    if (await tab.isVisible().catch(() => false)) { await tab.click(); console.log('切到', t); break; }
  }
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap15_login.png') });
  // 填账号密码
  const inputs = page.locator('input');
  const n = await inputs.count();
  console.log('inputs:', n);
  for (let i = 0; i < n; i++) {
    const ph = await inputs.nth(i).getAttribute('placeholder').catch(() => '');
    console.log('ph:', i, ph);
  }
  const acc = page.locator('input[placeholder*="手机号"], input[placeholder*="账号"], input[placeholder*="用户"]').first();
  if (await acc.isVisible().catch(() => false)) { await acc.fill('18588749605'); console.log('填账号'); }
  const pwd = page.locator('input[type="password"], input[placeholder*="密码"]').first();
  if (await pwd.isVisible().catch(() => false)) { await pwd.fill('888888'); console.log('填密码'); }
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap15_fill.png') });
  const btn = page.locator('button:has-text("登 录"), button:has-text("登录")').first();
  if (await btn.isVisible().catch(() => false)) { await btn.click(); console.log('点登录'); }
  // 等待跳转
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    if (!page.url().includes('/login')) { console.log('登录成功! URL:', page.url()); break; }
  }
  await page.waitForTimeout(6000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap15_after.png') });
  console.log('token 保存:', saved, tokenVal ? 'len=' + (tokenVal.length - 7) : '');
  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });