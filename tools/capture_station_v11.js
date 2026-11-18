// v11：抓页面加载的 route-plan 相关 JS chunk + 用正确地图容器打点
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
  const captured = [];
  const jsUrls = new Set();
  page.on('request', r => {
    const u = r.url();
    if (u.endsWith('.js')) jsUrls.add(u);
    if (/station\/(create|update|save)|element\/(create|save)/.test(u)) {
      captured.push({ url: u, headers: r.headers(), body: r.postData() });
      console.log('[CREATE-REQ]', r.method(), u.slice(60, 140), r.postData());
    }
  });
  page.on('response', async r => {
    if (/station\/create|element\/create/.test(r.url())) {
      try { console.log('[CREATE-RES]', r.status(), (await r.text()).slice(0, 400)); } catch {}
    }
  });

  await page.goto('https://test-bluejet.cxzyuan.com/#/delivery-manage/site-manage', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  // 下载所有加载的 js chunk 到 out/_bjchunks/
  const fs = require('fs');
  fs.mkdirSync(path.join(ROOT, 'out', '_bjchunks'), { recursive: true });
  for (const u of jsUrls) {
    if (!/assets|static|chunk/i.test(u)) continue;
    const name = u.split('/').pop();
    try {
      const res = await page.request.get(u);
      fs.writeFileSync(path.join(ROOT, 'out', '_bjchunks', name), await res.body());
    } catch {}
  }
  console.log('chunks 下载:', jsUrls.size);

  // UI 流程
  for (const sel of [page.getByText('+ 新建'), page.locator('button:has-text("新建")')]) {
    const b = sel.first();
    if (await b.isVisible().catch(() => false)) { await b.click(); console.log('点了新建'); break; }
  }
  await page.waitForTimeout(2000);
  const opt = page.locator('.ant-popover, .ant-dropdown').getByText('站点', { exact: true }).first();
  if (await opt.isVisible().catch(() => false)) { await opt.click({ force: true }); console.log('点了下拉-站点'); }
  await page.waitForTimeout(2000);
  await page.locator('.ant-form-item:has-text("站点名称") input').first().fill('PTV-CAPTURE-测试站');
  const ci = page.locator('.ant-form-item:has-text("经纬度") input');
  await ci.nth(0).fill('114.480000');
  await ci.nth(1).fill('23.000000');
  console.log('填表完成');
  await page.getByText('下一步').first().click({ force: true });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap11_step2.png') });
  // 列出地图容器候选
  for (const sel of ['#map', '.tmap', 'canvas', '[class*=map-container]']) {
    const n = await page.locator(sel).count().catch(() => 0);
    console.log('容器', sel, '=', n);
  }
  // 用最大的 canvas 打点（地图 canvas 通常是最大那块）
  const canvases = page.locator('canvas');
  const cnt = await canvases.count();
  let target = null;
  for (let i = 0; i < cnt; i++) {
    const b = await canvases.nth(i).boundingBox().catch(() => null);
    if (b && b.width > 600) { target = b; console.log('canvas', i, b.width, 'x', b.height); }
  }
  if (target) {
    await page.mouse.click(target.x + target.width * 0.55, target.y + target.height * 0.45);
    console.log('已点地图 canvas');
  }
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap11_step3.png') });
  // 若出现确认按钮再点
  for (const t of ['保存', '确定', '完成', '确 定']) {
    const b = page.locator(`.ant-modal:visible .ant-btn-primary, .ant-drawer:visible .ant-btn-primary`).getByText(t).first();
    if (await b.isVisible().catch(() => false)) { await b.click({ force: true }); console.log('点了', t); break; }
  }
  await page.waitForTimeout(6000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap11_step4.png') });
  fs.writeFileSync(path.join(ROOT, 'out', 'capture_create.json'), JSON.stringify(captured, null, 1));
  console.log('捕获数:', captured.length);
  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });