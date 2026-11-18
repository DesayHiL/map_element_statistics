// 抓站点编辑接口：打开测试环境站点管理页，操作「编辑」弹窗，捕获真实更新请求
const pw = require('../.pwtmp/node_modules/playwright-core').chromium;
(async () => {
  const ctx = await pw.launchPersistentContext('D:/workspace/map_element_statistics/.pwtmp/profile', {
    headless: false,
    executablePath: 'C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
    viewport: { width: 1400, height: 1000 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const captured = [];
  page.on('request', r => {
    const u = r.url();
    if (u.includes('/station') && !u.includes('/list') && r.method() === 'POST') {
      captured.push({ url: u, body: r.postData() });
    }
  });
  await page.goto('https://test-bluejet.cxzyuan.com/#/delivery-manage/site-manage', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  console.log('已打开站点管理页。请在页面上：搜索站点「PTV-区域测试-路线2-小金口街道-终点-康达学校」，点编辑，随便改点什么（或直接确认提交）。我在抓请求，抓到后会自动退出。');
  const t0 = Date.now();
  while (captured.length === 0 && Date.now() - t0 < 600000) await page.waitForTimeout(2000);
  if (captured.length) {
    console.log('CAPTURED', captured.length);
    captured.forEach((c, i) => console.log('--- #' + i, c.url, '\n', String(c.body).slice(0, 800)));
    require('fs').writeFileSync('D:/workspace/map_element_statistics/out/station_edit_req.json', JSON.stringify(captured, null, 2));
  } else console.log('TIMEOUT 未捕获');
  await page.waitForTimeout(5000);
  await ctx.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });