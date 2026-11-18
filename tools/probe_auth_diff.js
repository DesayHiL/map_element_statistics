// 验证鉴权差异：页面内 fetch 带 omit credentials vs include，找出 Node fetch 401 的原因
const pw = require('../.pwtmp/node_modules/playwright-core').chromium;
(async () => {
  const ctx = await pw.launchPersistentContext('D:/workspace/map_element_statistics/.pwtmp/profile', {
    headless: false,
    executablePath: 'C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://test-bluejet.cxzyuan.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const res = await page.evaluate(async () => {
    const token = (localStorage.getItem('TOKEN__') || '').replace(/^Bearer\s+/, '');
    const call = async (opts) => {
      try {
        const r = await fetch('/basic-api/aid-cscm/web-api/strategy/station/list', Object.assign({
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'X-User-Id': '2048' },
          body: JSON.stringify({ pageNum: 1, pageSize: 2 }),
        }, opts));
        const j = await r.json();
        return { code: j.code, msg: (j.msg || '').slice(0, 40), n: Array.isArray(j.data) ? j.data.length : -1 };
      } catch (e) { return { err: e.message }; }
    };
    const out = {};
    out.url = location.href;
    out.hasToken = !!token;
    out.sameOrigin = await call({});
    out.omit = await call({ credentials: 'omit' });
    out.cookie = document.cookie;
    try {
      const r2 = await fetch('/basic-api/aid-cscm/web-api/strategy/station/list', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ pageNum: 1, pageSize: 2 }) });
      const j2 = await r2.json();
      out.noXUser = { code: j2.code, n: Array.isArray(j2.data) ? j2.data.length : -1 };
    } catch (e) { out.noXUser = { err: e.message }; }
    return out;
  });
  console.log(JSON.stringify(res, null, 1));
  await ctx.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });