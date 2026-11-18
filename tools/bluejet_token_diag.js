// 诊断：列出已登录窗口 localStorage 全部键，找出 token 存储位置，并逐个验证
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
  await page.waitForTimeout(5000);
  const info = await page.evaluate(async () => {
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = (localStorage.getItem(k) || '').slice(0, 80); }
    const ss = {};
    for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); ss[k] = (sessionStorage.getItem(k) || '').slice(0, 80); }
    // 逐个长值尝试请求
    const cands = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i); const v = localStorage.getItem(k) || '';
      if (v.length > 100) cands.push({ k, v });
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i); const v = sessionStorage.getItem(k) || '';
      if (v.length > 100) cands.push({ k, v });
    }
    const results = [];
    for (const c of cands) {
      const t = c.v.replace(/^Bearer\s+/, '').replace(/^"|"$/g, '');
      if (!t.startsWith('eyJ') && !/^[0-9a-f]{32}$/.test(t)) continue;
      try {
        const r = await fetch('/basic-api/aid-cscm/web-api/strategy/station/list', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: t.startsWith('eyJ') ? 'Bearer ' + t : t },
          body: '{"pageNum":1,"pageSize":1}',
        });
        const j = await r.json();
        results.push({ k: c.k, len: c.v.length, ok: j.code === 0, code: j.code, head: t.slice(0, 25) });
      } catch (e) { results.push({ k: c.k, len: c.v.length, err: e.message }); }
    }
    return { ls, ss, results };
  });
  console.log('localStorage keys:', JSON.stringify(info.ls, null, 1));
  console.log('sessionStorage keys:', JSON.stringify(info.ss, null, 1));
  console.log('候选验证:', JSON.stringify(info.results, null, 1));
  const okCand = info.results.find(r => r.ok);
  if (okCand) {
    // 重新取完整值写盘
    const full = await page.evaluate(k => localStorage.getItem(k) || sessionStorage.getItem(k), okCand.k);
    fs.writeFileSync('D:/workspace/map_element_statistics/token.txt', full.replace(/^Bearer\s+/, '').replace(/^"|"$/g, ''));
    console.log('TOKEN_SAVED key=' + okCand.k);
  } else console.log('NO_VALID_CANDIDATE');
  await ctx.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });