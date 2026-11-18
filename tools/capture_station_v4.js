// 抓包 v4：自动在路线规划页点 +新建 → 站点 → 填表保存，抓真实建站 API
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
    if (/station|route-plan|element/.test(u)) {
      captured.push({ url: u, method: r.method(), headers: r.headers(), body: r.postData() });
      console.log('[REQ]', r.method(), u.slice(0, 140));
      if (r.postData()) console.log('  body:', r.postData().slice(0, 600));
    }
  });
  page.on('response', async r => {
    if (/station\/(create|update|save)/.test(r.url())) {
      try { console.log('[RES]', r.status(), (await r.text()).slice(0, 400)); } catch {}
    }
  });

  await page.goto('https://test-bluejet.cxzyuan.com/#/delivery-manage/route-plan', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap4_1.png') });

  // 1. 点「+ 新建」
  const btn = page.getByText('新建', { exact: true }).first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
    console.log('已点新建');
  } else console.log('未见「新建」按钮');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap4_2.png') });

  // 2. 若出现类型选择（站点采集 / 站点），点含「站点」的选项
  for (const t of ['站点采集', '站点']) {
    const opt = page.getByText(t, { exact: true }).first();
    if (await opt.isVisible().catch(() => false)) { await opt.click(); console.log('点了', t); break; }
  }
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap4_3.png') });

  // 3. 弹窗内填 名称/经度/纬度（ant modal）
  const fill = async (label, val) => {
    // antd Form: label 所在 form-item 的 input
    const item = page.locator(`.ant-form-item:has-text("${label}") input`).first();
    if (await item.isVisible().catch(() => false)) { await item.fill(val); console.log('填', label, val); }
    else console.log('未找到输入框', label);
  };
  await fill('名称', 'PTV-CAPTURE-测试站');
  await fill('经度', '114.480000');
  await fill('纬度', '23.000000');
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap4_4.png') });
  // 4. 确定
  const ok = page.locator('.ant-modal .ant-btn-primary, .ant-drawer .ant-btn-primary').first();
  if (await ok.isVisible().catch(() => false)) { await ok.click(); console.log('已点确定'); }
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'cap4_5.png') });
  require('fs').writeFileSync(path.join(ROOT, 'out', 'capture_station_req.json'), JSON.stringify(captured, null, 1));
  console.log('捕获数:', captured.length);
  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });