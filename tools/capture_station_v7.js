// 抓包 v6：首页 → 逐个尝试点「路线规划」菜单 → 自动 +新建 → 站点采集 → 填表保存 → 抓建站 API
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
      if (r.postData()) console.log('  body:', r.postData().slice(0, 600));
    }
  });
  page.on('response', async r => {
    if (/station\/create|element\/create/.test(r.url())) {
      try { console.log('[RES]', r.status(), (await r.text()).slice(0, 400)); } catch {}
    }
  });

  await page.goto('https://test-bluejet.cxzyuan.com/#/data-overview', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  // 逐个「路线规划」文本节点点击
  const cands = page.getByText('路线规划');
  const n = await cands.count();
  console.log('路线规划匹配数:', n);
  for (let i = 0; i < n; i++) {
    const el = cands.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    await el.click({ timeout: 3000 }).then(() => console.log('点击第', i, '个')).catch(() => {});
    await page.waitForTimeout(3000);
    if (/route-plan|routeplan/i.test(page.url())) { console.log('进入路线规划页:', page.url()); break; }
  }
  console.log('URL:', page.url());
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap6_1.png') });

  // + 新建
  for (const sel of [page.getByText('+ 新建'), page.getByText('新建', { exact: true }), page.locator('button:has-text("新建")'), page.getByText('新建')]) {
    const b = sel.first();
    if (await b.isVisible().catch(() => false)) { await b.click(); console.log('点了新建'); break; }
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap6_2.png') });
  for (const t of ['站点采集', '站点']) {
    const opt = page.getByText(t, { exact: true }).first();
    if (await opt.isVisible().catch(() => false)) { await opt.click({ force: true }); console.log('点了', t); break; }
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap6_3.png') });
  const fill = async (label, val) => {
    const item = page.locator(`.ant-form-item:has-text("${label}") input`).first();
    if (await item.isVisible().catch(() => false)) { await item.fill(val); console.log('填', label); }
    else console.log('未找到', label);
  };
  await fill('名称', 'PTV-CAPTURE-测试站');
  await fill('经度', '114.480000');
  await fill('纬度', '23.000000');
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap6_4.png') });
  const ok = page.locator('.ant-modal .ant-btn-primary, .ant-drawer .ant-btn-primary').first();
  if (await ok.isVisible().catch(() => false)) { await ok.click(); console.log('点了确定'); }
  await page.waitForTimeout(6000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap6_5.png') });
  require('fs').writeFileSync(path.join(ROOT, 'out', 'capture_station_req.json'), JSON.stringify(captured, null, 1));
  console.log('捕获数:', captured.length);
  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });