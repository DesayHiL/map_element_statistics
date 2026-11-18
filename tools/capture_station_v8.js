// 抓包 v8：路线规划页 → +新建 → 下拉「站点」→ 填名称/经纬度 → 确定 → 抓真实建站 API
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
  console.log('URL:', page.url());

  // + 新建
  for (const sel of [page.getByText('+ 新建'), page.locator('button:has-text("新建")')]) {
    const b = sel.first();
    if (await b.isVisible().catch(() => false)) { await b.click(); console.log('点了新建'); break; }
  }
  await page.waitForTimeout(2000);
  // 下拉里的「站点」：限定在 popover/dropdown 容器内（.ant-popover / .ant-dropdown / 任意浮层）
  const opt = page.locator('.ant-popover, .ant-dropdown, .ant-select-dropdown').getByText('站点', { exact: true }).first();
  if (await opt.isVisible().catch(() => false)) { await opt.click({ force: true }); console.log('点了下拉-站点'); }
  else {
    // fallback: 浮层内 item-label=站点
    const alt = page.locator('[class*=popover] [class*=item], [class*=dropdown] [class*=item]').filter({ hasText: '站点' }).first();
    if (await alt.isVisible().catch(() => false)) { await alt.click({ force: true }); console.log('点了浮层item-站点'); }
    else console.log('未找到下拉站点项');
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap8_1.png') });

  const fill = async (label, val) => {
    const item = page.locator(`.ant-form-item:has-text("${label}") input`).first();
    if (await item.isVisible().catch(() => false)) { await item.fill(val); console.log('填', label); }
    else console.log('未找到', label);
  };
  await fill('名称', 'PTV-CAPTURE-测试站');
  await fill('经度', '114.480000');
  await fill('纬度', '23.000000');
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap8_2.png') });
  const ok = page.locator('.ant-modal .ant-btn-primary, .ant-drawer .ant-btn-primary').first();
  if (await ok.isVisible().catch(() => false)) { await ok.click({ force: true }); console.log('点了确定'); }
  await page.waitForTimeout(8000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap8_3.png') });
  require('fs').writeFileSync(path.join(ROOT, 'out', 'capture_station_req.json'), JSON.stringify(captured, null, 1));
  console.log('捕获数:', captured.length);
  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });