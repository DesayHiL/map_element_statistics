// v16：登录态浏览器打开路线规划页，dump 全部 basic-api 请求的完整 headers，对比脚本头差异
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PW = require(path.join(ROOT, '.pwtmp', 'node_modules', 'playwright-core'));

(async () => {
  const ctx = await PW.chromium.launchPersistentContext(path.join(ROOT, '.pwtmp', 'profile2'), {
    headless: false,
    executablePath: 'C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
    viewport: { width: 1600, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const reqs = [];
  page.on('request', r => {
    if (r.url().includes('/basic-api/')) reqs.push({ url: r.url().slice(60, 130), headers: r.headers() });
  });
  await page.goto('https://test-bluejet.cxzyuan.com/#/delivery-manage/site-manage', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  console.log('URL:', page.url(), '请求样本数:', reqs.length);
  if (reqs.length) {
    console.log(JSON.stringify(reqs[0].headers, null, 1));
    fs.writeFileSync(path.join(ROOT, 'out', 'browser_headers.json'), JSON.stringify(reqs, null, 1));
  }
  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });