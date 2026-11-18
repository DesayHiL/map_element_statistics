// v17：登录态有效下重跑 UI 建站全流程，抓 station/create 真实请求
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
      if (r.postData()) console.log('  body:', r.postData().slice(0, 600));
    }
  });
  page.on('response', async r => {
    if (/station\/create|element\/create/.test(r.url())) {
      try { console.log('[RES]', r.status(), (await r.text()).slice(0, 400)); } catch {}
    }
  });

  await page.goto('https://test-bluejet.cxzyuan.com/#/delivery-manage/site-manage', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  console.log('URL:', page.url());
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap17_0.png') });

  // + 新建
  for (const sel of [page.getByText('+ 新建'), page.locator('button:has-text("新建")')]) {
    const b = sel.first();
    if (await b.isVisible().catch(() => false)) { await b.click(); console.log('点了新建'); break; }
  }
  await page.waitForTimeout(2000);
  const opt = page.locator('.ant-popover, .ant-dropdown').getByText('站点', { exact: true }).first();
  if (await opt.isVisible().catch(() => false)) { await opt.click({ force: true }); console.log('点了下拉-站点'); }
  else { console.log('!! 下拉-站点不可见'); await page.screenshot({ path: path.join(ROOT, 'out', 'cap17_pop.png') }); }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap17_modal.png') });
  // 填表
  const name = page.locator('.ant-form-item:has-text("站点名称") input').first();
  if (await name.isVisible().catch(() => false)) { await name.fill('PTV-CAPTURE-测试站'); console.log('填名称'); }
  else console.log('!! 表单未出现');
  const ci = page.locator('.ant-form-item:has-text("经纬度") input');
  if (await ci.count() >= 2) { await ci.nth(0).fill('114.480000'); await ci.nth(1).fill('23.000000'); console.log('填经纬度'); }
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap17_fill.png') });
  // 下一步
  const next = page.getByText('下一步').first();
  if (await next.isVisible().catch(() => false)) { await next.click({ force: true }); console.log('点了下一步'); }
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap17_step2.png') });
  // 打点：点最大 canvas
  const canvases = page.locator('canvas');
  const cnt = await canvases.count();
  let target = null;
  for (let i = 0; i < cnt; i++) {
    const b = await canvases.nth(i).boundingBox().catch(() => null);
    if (b && b.width > 600) { target = b; }
  }
  if (target) {
    await page.mouse.move(target.x + target.width * 0.55, target.y + target.height * 0.45);
    await page.waitForTimeout(300);
    await page.mouse.click(target.x + target.width * 0.55, target.y + target.height * 0.45);
    console.log('点了地图');
  }
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap17_step3.png') });
  // 找后续按钮
  const btns = await page.locator('.ant-modal:visible button, .ant-drawer:visible button, button:visible').all();
  for (const b of btns) console.log('btn:', (await b.textContent().catch(() => '')).trim().slice(0, 20));
  // 点保存
  const save = page.locator('button:visible').filter({ hasText: '保存' }).first();
  if (await save.isVisible().catch(() => false)) { await save.click({ force: true }); console.log('点了保存'); }
  await page.waitForTimeout(6000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap17_step4.png') });
  await ctx.close();
  fs.writeFileSync(path.join(ROOT, 'out', 'capture_v17.json'), JSON.stringify(captured, null, 1));
  console.log('捕获数:', captured.length);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });