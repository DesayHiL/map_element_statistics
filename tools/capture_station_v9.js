// 抓包 v9：新建站点全流程——填表(修正经纬度顺序) → 下一步地图打点 → 保存 → 抓真实建站 API
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
  page.on('request', r => {
    const u = r.url();
    if (/station\/(create|update|save)|element\/(create|save)|check-name/.test(u)) {
      captured.push({ url: u, method: r.method(), headers: r.headers(), body: r.postData() });
      console.log('[REQ]', r.method(), u.slice(0, 140));
      if (r.postData()) console.log('  body:', r.postData().slice(0, 800));
    }
  });
  page.on('response', async r => {
    if (/station\/create|element\/create/.test(r.url())) {
      try { console.log('[RES]', r.status(), (await r.text()).slice(0, 500)); } catch {}
    }
  });

  await page.goto('https://test-bluejet.cxzyuan.com/#/delivery-manage/site-manage', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  for (const sel of [page.getByText('+ 新建'), page.locator('button:has-text("新建")')]) {
    const b = sel.first();
    if (await b.isVisible().catch(() => false)) { await b.click(); console.log('点了新建'); break; }
  }
  await page.waitForTimeout(2000);
  const opt = page.locator('.ant-popover, .ant-dropdown').getByText('站点', { exact: true }).first();
  if (await opt.isVisible().catch(() => false)) { await opt.click({ force: true }); console.log('点了下拉-站点'); }
  await page.waitForTimeout(2000);

  // 弹窗: 站点名称 / 经纬度（选填）两格: 第一格=经度, 第二格=纬度
  const name = page.locator('.ant-form-item:has-text("站点名称") input').first();
  if (await name.isVisible().catch(() => false)) { await name.fill('PTV-CAPTURE-测试站'); console.log('填名称'); }
  // 经纬度输入组: 找 "经纬度" form-item 下的两个 input
  const coordInputs = page.locator('.ant-form-item:has-text("经纬度") input');
  const cn = await coordInputs.count().catch(() => 0);
  console.log('坐标输入框数:', cn);
  if (cn >= 2) {
    await coordInputs.nth(0).fill('114.480000'); // 经度
    await coordInputs.nth(1).fill('23.000000');  // 纬度
    console.log('填经纬度(经度第一格)');
  }
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap9_1.png') });
  // 点「下一步：在地图上打点」
  const next = page.getByText('下一步').first();
  if (await next.isVisible().catch(() => false)) { await next.click({ force: true }); console.log('点了下一步'); }
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap9_2.png') });
  // 在地图中心打点
  const map = page.locator('#map, .map-container, [class*=map]').first();
  const box = await map.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    console.log('地图打点');
  }
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap9_3.png') });
  // 找保存/确定按钮
  for (const t of ['保存', '确 定', '确定', '完成']) {
    const b = page.locator('.ant-modal .ant-btn-primary, .ant-drawer .ant-btn-primary, .ant-btn-primary').getByText(t).first();
    if (await b.isVisible().catch(() => false)) { await b.click({ force: true }); console.log('点了', t); break; }
  }
  await page.waitForTimeout(8000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap9_4.png') });
  require('fs').writeFileSync(path.join(ROOT, 'out', 'capture_station_req.json'), JSON.stringify(captured, null, 1));
  console.log('捕获数:', captured.length);
  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });