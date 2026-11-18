// 登录尝试：验证码当 888888 试
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
  let token = null;
  page.on('request', r => {
    if (r.url().includes('/basic-api/')) {
      const a = r.headers()['authorization'];
      if (a && a.startsWith('Bearer ') && a.length > 100) token = a;
    }
  });
  page.on('response', async r => {
    if (/sms|code|login|auth/i.test(r.url()) && r.request().method() === 'POST') {
      try { console.log('[RES]', r.url().slice(60, 140), r.status(), (await r.text()).slice(0, 300)); } catch {}
    }
  });
  await page.goto('https://test-bluejet.cxzyuan.com/#/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  if (!page.url().includes('/login')) { console.log('已有登录态，直接用:', page.url()); await ctx.close(); process.exit(0); }
  await page.locator('input[placeholder*="手机号"]').first().fill('18588749605');
  // 点获取验证码
  const getCode = page.locator('button:has-text("获取验证码"), span:has-text("获取验证码")').first();
  if (await getCode.isVisible().catch(() => false)) { await getCode.click({ force: true }); console.log('点了获取验证码'); }
  await page.waitForTimeout(2000);
  // 填验证码 888888
  const codeInp = page.locator('input[placeholder*="验证码"]').first();
  if (await codeInp.isVisible().catch(() => false)) { await codeInp.fill('888888'); console.log('填了 888888'); }
  await page.locator('button:has-text("登 录"), button:has-text("登录")').first().click({ force: true });
  console.log('点登录');
  const dl = Date.now() + 20000;
  while (Date.now() < dl) {
    await page.waitForTimeout(2000);
    if (!page.url().includes('/login')) break;
  }
  await page.screenshot({ path: path.join(ROOT, 'out', 'capL5.png') });
  console.log('URL:', page.url());
  if (!page.url().includes('/login') && token) {
    fs.writeFileSync(path.join(ROOT, 'token.txt'), token.replace('Bearer ', ''));
    console.log('★ 登录成功，token 已保存');
  } else {
    console.log('!! 888888 验证码无效');
  }
  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });