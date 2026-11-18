// 新 token 重试 route-plan/station/create（最小 payload {name,lng,lat}）
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const token = fs.readFileSync(path.join(ROOT, 'token.txt'), 'utf8').trim();
const BASE = 'https://test-bluejet.cxzyuan.com/basic-api/aid-cscm/web-api';

async function call(ep, body) {
  const res = await fetch(BASE + ep, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
      'X-User-Id': '2048',
      'X-Customer-Host': 'test-bluejet.cxzyuan.com',
    },
    body: JSON.stringify(body || {}),
  });
  const t = await res.text();
  console.log('==', ep, '→', res.status);
  console.log(t.slice(0, 1000));
  return JSON.parse(t);
}

(async () => {
  const r = await call('/route-plan/station/create', { name: 'PTV-V3TEST-NEW', lng: '114.474000', lat: '23.008000' });
  if (r.success) console.log('★ station/create 成功!');
  // 验证落库
  await call('/route-plan/station/detail?id=' + (r.data?.id || r.data || ''));
})().catch(e => console.error(e.message));