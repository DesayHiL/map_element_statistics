// Playwright 打开 bluejet 路线规划页 → 点「站点采集」→ 填名称/经纬度 → 保存，抓 station/create 的真实请求
// 需要: .pwtmp/node_modules/playwright-core + chromium
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
    if (/station\/(create|update)|element/.test(r.url())) {
      captured.push({ url: r.url(), method: r.method(), headers: r.headers(), body: r.postData() });
      console.log('[REQ]', r.method(), r.url());
      console.log('  headers:', JSON.stringify(r.headers()).slice(0, 400));
      console.log('  body:', (r.postData() || '').slice(0, 400));
    }
  });
  page.on('response', async r => {
    if (/station\/(create|update)/.test(r.url())) {
      try { console.log('[RES]', r.status(), (await r.text()).slice(0, 300)); } catch {}
    }
  });
  await page.goto('https://test-bluejet.cxzyuan.com/#/delivery-manage/site-manage', { waitUntil: 'domcontentloaded' });
  console.log('页面已打开，等待你手动或脚本操作…');
  // 挂 5 分钟监听
  await new Promise(r => setTimeout(r, 5 * 60 * 1000));
  require('fs').writeFileSync(path.join(ROOT, 'out', 'capture_station_req.json'), JSON.stringify(captured, null, 1));
  console.log('捕获数:', captured.length);
  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });