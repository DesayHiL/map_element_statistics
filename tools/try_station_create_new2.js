// 用浏览器同款完整头重试 station/create
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const token = fs.readFileSync(path.join(ROOT, 'token.txt'), 'utf8').trim();
const BASE = 'https://test-bluejet.cxzyuan.com/basic-api/aid-cscm/web-api';
const H = {
  'Content-Type': 'application/json',
  'Authorization': 'Bearer ' + token,
  'X-User-Id': '2048',
  'X-Customer-Host': 'test-bluejet.cxzyuan.com',
  'Referer': 'https://test-bluejet.cxzyuan.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://test-bluejet.cxzyuan.com',
};
async function call(ep, body) {
  const res = await fetch(BASE + ep, { method: 'POST', headers: H, body: JSON.stringify(body || {}) });
  const t = await res.text();
  console.log('==', ep, '→', res.status, t.slice(0, 600));
  try { return JSON.parse(t); } catch { return null; }
}
(async () => {
  const r = await call('/route-plan/station/create', { name: 'PTV-V3TEST-NEW', lng: '114.474000', lat: '23.008000' });
  if (r && r.success) {
    console.log('★ 成功! id=', r.data?.id ?? r.data);
    const d = await call('/route-plan/station/detail?id=' + (r.data?.id ?? r.data));
  }
})().catch(e => console.error(e.message));