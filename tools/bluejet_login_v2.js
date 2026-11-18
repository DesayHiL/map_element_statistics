// 自动登录 test-bluejet 抓 token（v2：轮询 localStorage 的 ACCESS-Token，服务端验证通过才写 token.txt）
const pw = require('../.pwtmp/node_modules/playwright-core').chromium;
const fs = require('fs');

const USER_DATA = 'D:/workspace/map_element_statistics/.pwtmp/profile';
const OUT = 'D:/workspace/map_element_statistics/token.txt';

(async () => {
  const ctx = await pw.launchPersistentContext(USER_DATA, {
    headless: false,
    executablePath: 'C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://test-bluejet.cxzyuan.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  console.log('页面已打开。若显示登录页请重新登录（账号 huangxiaoan）。会持续轮询有效 token，最长 30 分钟。');

  const t0 = Date.now();
  let saved = false;
  let lastMsg = '';
  while (!saved && Date.now() - t0 < 1800000) {
    await page.waitForTimeout(3000);
    const res = await page.evaluate(async () => {
      const raw = localStorage.getItem('ACCESS-Token') || localStorage.getItem('accessToken') || '';
      const t = raw.replace(/^Bearer /, '');
      if (!t.startsWith('eyJ')) return { ok: false, msg: 'no-token' };
      try {
        const r = await fetch('/basic-api/aid-cscm/web-api/strategy/station/list', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
          body: '{"pageNum":1,"pageSize":1}',
        });
        const j = await r.json();
        return { ok: j.code === 0, msg: 'code=' + j.code, token: t };
      } catch (e) { return { ok: false, msg: 'fetch err ' + e.message }; }
    }).catch(e => ({ ok: false, msg: 'eval err ' + e.message }));
    if (res.msg !== lastMsg) { console.log(new Date().toLocaleTimeString(), res.msg); lastMsg = res.msg; }
    if (res.ok) {
      fs.writeFileSync(OUT, res.token);
      console.log('TOKEN_SAVED_AND_VERIFIED len', res.token.length);
      saved = true;
    }
  }
  if (!saved) { console.log('FAIL: 30 分钟内未取到有效 token'); process.exitCode = 1; }
  await ctx.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });