// v18：登录守护 + UI 建站全流程（含保存）→ 抓 station/create
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
  const captured = [];
  page.on('request', r => {
    const u = r.url();
    if (/station\/(create|update|save)|element\/(create|save)|check-name/.test(u)) {
      captured.push({ url: u, method: r.method(), headers: r.headers(), body: r.postData() });
      console.log('[REQ]', r.method(), u.slice(60, 140));
      if (r.postData()) console.log('  body:', r.postData().slice(0, 800));
    }
  });
  page.on('response', async r => {
    if (/station\/create|element\/create/.test(r.url())) {
      try { console.log('[RES]', r.status(), (await r.text()).slice(0, 500)); } catch {}
    }
  });

  async function ensureLogin() {
    await page.goto('https://test-bluejet.cxzyuan.com/#/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    if (!page.url().includes('/login')) { console.log('已有登录态:', page.url()); return; }
    // 切账号密码登录
    for (const t of ['密码登录', '账号密码登录', '账号密码']) {
      const tab = page.getByText(t, { exact: false }).first();
      if (await tab.isVisible().catch(() => false)) { await tab.click(); console.log('切到', t); break; }
    }
    await page.waitForTimeout(1000);
    const acc = page.locator('input[placeholder*="手机号"], input[placeholder*="账号"]').first();
    if (await acc.isVisible().catch(() => false)) await acc.fill('18588749605');
    const pwd = page.locator('input[type="password"]').first();
    if (await pwd.isVisible().catch(() => false)) await pwd.fill('888888');
    await page.locator('button:has-text("登"), button:has-text("登录")').first().click({ force: true });
    console.log('提交登录...');
    const dl = Date.now() + 30000;
    while (Date.now() < dl) {
      await page.waitForTimeout(2000);
      if (!page.url().includes('/login')) { console.log('登录成功:', page.url()); return; }
    }
    throw new Error('登录超时');
  }

  await ensureLogin();
  await page.goto('https://test-bluejet.cxzyuan.com/#/delivery-manage/site-manage', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  console.log('URL:', page.url());

  // + 新建
  for (const sel of [page.getByText('+ 新建'), page.locator('button:has-text("新建")')]) {
    const b = sel.first();
    if (await b.isVisible().catch(() => false)) { await b.click(); console.log('点了新建'); break; }
  }
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap18_new.png') });
  const opt = page.locator('.ant-popover, .ant-dropdown').getByText('站点', { exact: true }).first();
  if (await opt.isVisible().catch(() => false)) { await opt.click({ force: true }); console.log('点了下拉-站点'); }
  else {
    console.log('!! 下拉-站点不可见');
    await page.screenshot({ path: path.join(ROOT, 'out', 'cap18_popfail.png') });
    // 备选：任意浮层内含"站点"的项
    const alt = page.locator('[class*=popover] li, [class*=popover] div, [class*=dropdown] li').filter({ hasText: '站点' }).first();
    if (await alt.isVisible().catch(() => false)) { await alt.click({ force: true }); console.log('点了浮层备选项'); }
    else { console.log('!! 备选也失败，退出'); await ctx.close(); return; }
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap18_modal.png') });
  const name = page.locator('.ant-form-item:has-text("站点名称") input').first();
  if (await name.isVisible().catch(() => false)) { await name.fill('PTV-CAPTURE-测试站'); console.log('填名称'); }
  else console.log('!! 表单未出现');
  const ci = page.locator('.ant-form-item:has-text("经纬度") input');
  if (await ci.count() >= 2) { await ci.nth(0).fill('114.480000'); await ci.nth(1).fill('23.000000'); console.log('填经纬度'); }
  const nextBtn = page.getByText('下一步').first();
  if (!(await nextBtn.isVisible().catch(() => false))) { console.log('!! 下一步不可见'); await page.screenshot({ path: path.join(ROOT, 'out', 'cap18_noform.png') }); await ctx.close(); return; }
  await nextBtn.click({ force: true });
  console.log('点了下一步');
  await page.waitForTimeout(3000);
  // 打点
  const cnt = await page.locator('canvas').count();
  let target = null;
  for (let i = 0; i < cnt; i++) {
    const b = await page.locator('canvas').nth(i).boundingBox().catch(() => null);
    if (b && b.width > 600) target = b;
  }
  if (target) {
    await page.mouse.click(target.x + target.width * 0.55, target.y + target.height * 0.45);
    console.log('点了地图');
  }
  await page.waitForTimeout(4000);
  // 保存
  const save = page.locator('button:visible').filter({ hasText: '保存' }).first();
  if (await save.isVisible().catch(() => false)) { await save.click({ force: true }); console.log('点了保存'); }
  else console.log('!! 保存按钮未出现');
  await page.waitForTimeout(8000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap18_result.png') });
  fs.writeFileSync(path.join(ROOT, 'out', 'capture_v18.json'), JSON.stringify(captured, null, 1));
  console.log('捕获数:', captured.length);
  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });