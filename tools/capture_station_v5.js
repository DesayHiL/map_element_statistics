// 抓包 v5：打开首页 → 点左侧菜单「路线规划」→ 自动 +新建 → 站点采集 → 填表保存 → 抓真实建站 API
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
    if (/station\/create|element\/(create|save)/.test(r.url())) {
      try { console.log('[RES]', r.status(), (await r.text()).slice(0, 400)); } catch {}
    }
  });

  await page.goto('https://test-bluejet.cxzyuan.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  // 点左侧菜单「路线规划」
  const menu = page.locator('.ant-menu, [class*=menu], [class*=sidebar]').getByText('路线规划').first();
  const menuAny = page.getByText('路线规划', { exact: true }).first();
  for (const m of [menu, menuAny]) {
    if (await m.isVisible().catch(() => false)) { await m.click(); console.log('点了路线规划菜单'); break; }
  }
  await page.waitForTimeout(6000);
  console.log('URL now:', page.url());
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap5_1.png') });

  // + 新建（可能是 "+ 新建" 或含图标）
  for (const sel of [page.getByText('+ 新建'), page.getByText('新建', { exact: true }), page.locator('button:has-text("新建")')]) {
    const b = sel.first();
    if (await b.isVisible().catch(() => false)) { await b.click(); console.log('点了新建'); break; }
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap5_2.png') });
  // 弹出 Popover 里选「站点采集」
  for (const t of ['站点采集', '站点']) {
    const opt = page.getByText(t, { exact: true }).first();
    if (await opt.isVisible().catch(() => false)) { await opt.click(); console.log('点了', t); break; }
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap5_3.png') });
  // 填表
  const fill = async (label, val) => {
    const item = page.locator(`.ant-form-item:has-text("${label}") input`).first();
    if (await item.isVisible().catch(() => false)) { await item.fill(val); console.log('填', label); }
    else console.log('未找到', label);
  };
  await fill('名称', 'PTV-CAPTURE-测试站');
  await fill('经度', '114.480000');
  await fill('纬度', '23.000000');
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap5_4.png') });
  const ok = page.locator('.ant-modal .ant-btn-primary, .ant-drawer .ant-btn-primary').first();
  if (await ok.isVisible().catch(() => false)) { await ok.click(); console.log('点了确定'); }
  await page.waitForTimeout(6000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap5_5.png') });
  require('fs').writeFileSync(path.join(ROOT, 'out', 'capture_station_req.json'), JSON.stringify(captured, null, 1));
  console.log('捕获数:', captured.length);
  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });