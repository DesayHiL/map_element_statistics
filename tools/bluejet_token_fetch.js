// 用 localStorage 的 TOKEN__ 和 REFRESH_TOKEN__ 获取有效 token
const pw = require('../.pwtmp/node_modules/playwright-core').chromium;
const fs = require('fs');
(async () => {
  const ctx = await pw.launchPersistentContext('D:/workspace/map_element_statistics/.pwtmp/profile', {
    headless: false,
    executablePath: 'C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://test-bluejet.cxzyuan.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const res = await page.evaluate(async () => {
    const access = (localStorage.getItem('TOKEN__') || '').replace(/^Bearer\s+/, '');
    const refresh = (localStorage.getItem('REFRESH_TOKEN__') || '').replace(/^Bearer\s+/, '');
    const verify = async (t) => {
      const r = await fetch('/basic-api/aid-cscm/web-api/strategy/station/list', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: t.startsWith('eyJ') ? 'Bearer ' + t : t },
        body: JSON.stringify({ pageNum: 1, pageSize: 1 }),
      });
      return await r.json();
    };
    const out = {};
    out.accessLen = access.length;
    out.refreshLen = refresh.length;
    out.jwtExp = (() => { try { const p = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString()); return new Date(p.exp * 1000).toLocaleString(); } catch (e) { return 'parse-fail'; } })();
    // 直接验证 access
    const v1 = await verify(access);
    out.accessVerifyCode = v1.code; out.accessVerifyMsg = v1.msg || '';
    // 尝试用 refresh token 直接调 refresh 接口换新 access
    try {
      const rt = refresh;
      const q = encodeURIComponent(rt);
      const rr = await fetch('/basic-api/aid-admin/auth/refresh-token?refreshToken=' + q, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Customer-Host': 'test-bluejet.cxzyuan.com' } });
      const rj = await rr.json();
      out.refreshResult = { code: rj.code, hasData: !!rj.data };
      if (rj.data && (rj.data.access_token || rj.data.accessToken || rj.data.token)) {
        const nt = rj.data.access_token || rj.data.accessToken || rj.data.token;
        out.newTokenHead = String(nt).slice(0, 30);
        out.newTokenPayload = (() => { try { const p = JSON.parse(Buffer.from(String(nt).split('.')[1], 'base64url').toString()); return { exp: new Date(p.exp * 1000).toLocaleString() }; } catch (e) { return 'na'; } })();
        // 用新 token 验证
        const v2 = await verify(String(nt));
        out.newVerifyCode = v2.code;
        out.newTokenVal = v2.code === 0 ? String(nt) : null;
      } else {
        out.refreshResult.raw = JSON.stringify(rj).slice(0, 300);
      }
    } catch (e) { out.refreshErr = e.message; }
    return out;
  });
  console.log(JSON.stringify(res, null, 2));
  // 写回
  if (res.accessVerifyCode === 0) {
    fs.writeFileSync('D:/workspace/map_element_statistics/token.txt', await page.evaluate(() => (localStorage.getItem('TOKEN__') || '').replace(/^Bearer\s+/, '')));
    console.log('使用已登录 TOKEN__ 写入 token.txt');
  } else if (res.newTokenVal) {
    fs.writeFileSync('D:/workspace/map_element_statistics/token.txt', res.newTokenVal);
    console.log('使用 refresh 换新 token 写入 token.txt');
  } else {
    console.log('两种途径均未获得可用 token');
  }
  await ctx.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });