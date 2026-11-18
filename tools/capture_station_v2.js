// 自动抓包 v2：打开 bluejet 站点管理页 → 等登录 → 提示人工点新建 → 抓真实建站 API
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
    if (/station\/(create|update|save)|route-plan/.test(u)) {
      captured.push({ url: u, method: r.method(), headers: r.headers(), body: r.postData() });
      console.log('[REQ]', r.method(), u);
      console.log('  body:', (r.postData() || '').slice(0, 500));
    }
  });
  page.on('response', async r => {
    if (/station\/(create|update|save)/.test(r.url())) {
      try { console.log('[RES]', r.status(), (await r.text()).slice(0, 300)); } catch {}
    }
  });

  await page.goto('https://test-bluejet.cxzyuan.com/#/delivery-manage/site-manage', { waitUntil: 'domcontentloaded' });
  console.log('等待登录/页面加载…（若需登录请在弹出的浏览器中登录）');
  let ready = false;
  for (let i = 0; i < 150; i++) {
    await page.waitForTimeout(2000);
    ready = await page.getByText('站点管理').first().isVisible().catch(() => false);
    if (ready) break;
  }
  console.log('页面就绪:', ready);
  if (!ready) { console.log('5 分钟未就绪，退出'); await ctx.close(); return; }

  console.log('=== 请在浏览器中手工点「新建站点」，填名称 PTV-CAPTURE-测试 / 经度 114.48 / 纬度 23.0 并保存（10 分钟内） ===');
  await page.waitForTimeout(10 * 60 * 1000);
  require('fs').writeFileSync(path.join(ROOT, 'out', 'capture_station_req.json'), JSON.stringify(captured, null, 1));
  console.log('捕获数:', captured.length, '已存 out/capture_station_req.json');
  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });