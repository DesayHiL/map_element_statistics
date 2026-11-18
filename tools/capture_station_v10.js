// v10：全请求监听 + 下一步后停住观察（不点地图），确定被拦接口与弹窗第二步形态
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
  const log = [];
  page.on('request', r => {
    const u = r.url();
    if (u.includes('/basic-api/')) {
      log.push({ url: u, method: r.method(), body: r.postData(), ts: Date.now() });
      console.log('[REQ]', r.method(), u.replace('https://test-bluejet.cxzyuan.com/basic-api/', ''), r.postData() ? '| ' + r.postData().slice(0, 300) : '');
    }
  });
  page.on('response', async r => {
    const u = r.url();
    if (u.includes('/basic-api/') && !/list|check-name|area/.test(u)) {
      try {
        const t = await r.text();
        if (r.status() >= 400 || /失败|无权限|error/i.test(t)) console.log('[RES-ERR]', r.status(), u.slice(60, 140), t.slice(0, 200));
      } catch {}
    }
  });

  await page.goto('https://test-bluejet.cxzyuan.com/#/delivery-manage/site-manage', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  // 记录基准时间戳
  const t0 = Date.now();

  for (const sel of [page.getByText('+ 新建'), page.locator('button:has-text("新建")')]) {
    const b = sel.first();
    if (await b.isVisible().catch(() => false)) { await b.click(); console.log('点了新建'); break; }
  }
  await page.waitForTimeout(2000);
  const opt = page.locator('.ant-popover, .ant-dropdown').getByText('站点', { exact: true }).first();
  if (await opt.isVisible().catch(() => false)) { await opt.click({ force: true }); console.log('点了下拉-站点'); }
  await page.waitForTimeout(2000);
  const name = page.locator('.ant-form-item:has-text("站点名称") input').first();
  if (await name.isVisible().catch(() => false)) { await name.fill('PTV-CAPTURE-测试站'); console.log('填名称'); }
  const coordInputs = page.locator('.ant-form-item:has-text("经纬度") input');
  if (await coordInputs.count() >= 2) {
    await coordInputs.nth(0).fill('114.480000');
    await coordInputs.nth(1).fill('23.000000');
    console.log('填经纬度');
  }
  const next = page.getByText('下一步').first();
  if (await next.isVisible().catch(() => false)) { await next.click({ force: true }); console.log('点了下一步'); }
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap10_step2.png') });
  // 列出 t0 之后的所有请求
  console.log('--- 点下一步之后的请求 ---');
  log.filter(l => l.ts > t0).forEach(l => console.log(l.method, l.url.replace('https://test-bluejet.cxzyuan.com/basic-api/', ''), (l.body || '').slice(0, 300)));
  require('fs').writeFileSync(path.join(ROOT, 'out', 'cap10_requests.json'), JSON.stringify(log, null, 1));
  console.log('总请求数:', log.length);
  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });