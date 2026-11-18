// 登录诊断：截图 + DOM dump
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
  page.on('request', r => { if (r.url().includes('login') || r.url().includes('auth')) console.log('[REQ]', r.url().slice(60, 140), (r.postData() || '').slice(0, 200)); });
  page.on('response', async r => {
    if (/login|auth/.test(r.url())) { try { console.log('[RES]', r.status(), (await r.text()).slice(0, 300)); } catch {} }
  });
  await page.goto('https://test-bluejet.cxzyuan.com/#/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'capL1.png') });
  // dump 输入框
  const n = await page.locator('input').count();
  for (let i = 0; i < n; i++) {
    const inp = page.locator('input').nth(i);
    console.log('input', i, 'type=', await inp.getAttribute('type').catch(() => ''), 'ph=', await inp.getAttribute('placeholder').catch(() => ''));
  }
  // 找密码tab
  for (const t of ['密码登录', '账号密码']) {
    const b = page.getByText(t).first();
    console.log('tab', t, await b.isVisible().catch(() => false));
  }
  // 试账号密码登录
  const tabs = ['密码登录', '账号密码登录', '账号密码'];
  for (const t of tabs) {
    const tab = page.getByText(t, { exact: false }).first();
    if (await tab.isVisible().catch(() => false)) { await tab.click(); console.log('切到', t); break; }
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(ROOT, 'out', 'capL2.png') });
  const n2 = await page.locator('input').count();
  for (let i = 0; i < n2; i++) {
    const inp = page.locator('input').nth(i);
    console.log('after input', i, 'type=', await inp.getAttribute('type').catch(() => ''), 'ph=', await inp.getAttribute('placeholder').catch(() => ''));
  }
  const acc = page.locator('input[placeholder*="手机号"], input[placeholder*="账号"]').first();
  if (await acc.isVisible().catch(() => false)) { await acc.fill('18588749605'); console.log('账号已填'); }
  const pwd = page.locator('input[type="password"]').first();
  if (await pwd.isVisible().catch(() => false)) { await pwd.fill('888888'); console.log('密码已填'); }
  await page.screenshot({ path: path.join(ROOT, 'out', 'capL3.png') });
  await page.locator('button').filter({ hasText: '登' }).first().click({ force: true });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'capL4.png') });
  console.log('URL after:', page.url());
  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });