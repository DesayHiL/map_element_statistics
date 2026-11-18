// v12：在登录页面上下文里 fetch 直调 station/create（模拟前端真实调用）
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
  await page.goto('https://test-bluejet.cxzyuan.com/#/delivery-manage/site-manage', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  console.log('URL:', page.url());

  // 真实站点坐标（惠城区，参照 123123123: 114.4724, 23.0065 附近偏移避免重叠）
  const payload = {
    name: 'PTV-CAPTURE-API站',
    lng: '114.474000',
    lat: '23.008000',
  };
  const result = await page.evaluate(async (p) => {
    // 取页面里 axios 实例可能附加的头——先抓一个已知请求的默认头。直接用 fetch + 与前端一致的 headers
    const token = localStorage.getItem('token') || sessionStorage.getItem('token');
    // 尝试常见的存储键
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      ls[k] = (localStorage.getItem(k) || '').slice(0, 120);
    }
    const headers = {
      'Content-Type': 'application/json',
      'X-Customer-Host': 'test-bluejet.cxzyuan.com',
    };
    // 从 ls 中找 token
    for (const k of Object.keys(ls)) {
      if (/token|Token/.test(k) && ls[k].length > 30) {
        try {
          const v = localStorage.getItem(k);
          const j = JSON.parse(v);
          headers['Authorization'] = j.accessToken ? 'Bearer ' + j.accessToken : v;
        } catch { headers['Authorization'] = 'Bearer ' + localStorage.getItem(k); }
      }
    }
    const res = await fetch('/basic-api/aid-cscm/web-api/route-plan/station/create', {
      method: 'POST',
      headers,
      body: JSON.stringify(p),
    });
    const text = await res.text();
    return { status: res.status, text: text.slice(0, 800), lsKeys: Object.keys(ls), ls };
  }, payload);
  console.log('STATUS:', result.status);
  console.log('RES:', result.text);
  console.log('LS keys:', result.lsKeys.join(', '));
  require('fs').writeFileSync(path.join(ROOT, 'out', 'cap12_result.json'), JSON.stringify(result, null, 1));
  await ctx.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });