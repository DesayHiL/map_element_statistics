// 查 123123123 (2120733212291371010) 在各端的落库特征：route-plan element/detail vs strategy station
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const token = fs.readFileSync(path.join(ROOT, 'token.txt'), 'utf8').trim();
const BASE = 'https://test-bluejet.cxzyuan.com/basic-api/aid-cscm/web-api';

async function call(ep, body, extra = {}) {
  const res = await fetch(BASE + ep, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
      'X-User-Id': '2048',
      'X-Customer-Host': 'test-bluejet.cxzyuan.com',
      ...extra,
    },
    body: JSON.stringify(body || {}),
  });
  const t = await res.text();
  console.log('==', ep, '→', res.status);
  console.log(t.slice(0, 1200));
  return t;
}

(async () => {
  // 1. route-plan station/detail
  await call('/route-plan/station/detail?id=2120733212291371010');
  // 2. route-plan element/list 按 viewport 拉它
  const el = await call('/route-plan/element/list', { swLng: 114.40, swLat: 22.95, neLng: 114.55, neLat: 23.06, elementTypes: ['STATION'] });
  // 3. strategy station/list（找同名/同坐标）
  await call('/strategy/station/list', { swLng: 114.40, swLat: 22.95, neLng: 114.55, neLat: 23.06 });
})().catch(e => console.error(e.message));