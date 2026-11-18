// 抓包 v3：诊断页面状态 + 宽松等待登录 + 人工操作窗口
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
    if (/station\/(create|update|save)|route-plan|site/.test(u)) {
      captured.push({ url: u, method: r.method(), headers: r.headers(), body: r.postData() });
      console.log('[REQ]', r.method(), u.slice(0, 120));
      if (r.postData()) console.log('  body:', r.postData().slice(0, 500));
    }
  });
  page.on('response', async r => {
    if (/station\/(create|update|save)/.test(r.url())) {
      try { console.log('[RES]', r.status(), (await r.text()).slice(0, 300)); } catch {}
    }
  });

  await page.goto('https://test-bluejet.cxzyuan.com/#/delivery-manage/site-manage', { waitUntil: 'domcontentloaded' });
  // 60 秒诊断截图
  await page.waitForTimeout(60000);
  await page.screenshot({ path: path.join(ROOT, 'out', 'capture_diag.png') });
  console.log('诊断截图已存 out/capture_diag.png, URL=', page.url());
  console.log('title=', await page.title());
  // 再给 9 分钟人工登录+操作
  await page.waitForTimeout(9 * 60 * 1000);
  require('fs').writeFileSync(path.join(ROOT, 'out', 'capture_station_req.json'), JSON.stringify(captured, null, 1));
  console.log('捕获数:', captured.length, '已存 out/capture_station_req.json');
  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });