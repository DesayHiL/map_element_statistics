// 列出路线1试点已建的路线与站点（用大 viewport）
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const H = {
  'Content-Type': 'application/json',
  'Authorization': 'Bearer ' + fs.readFileSync(path.join(ROOT, 'token.txt'), 'utf8').trim(),
  'X-User-Id': '2048', 'X-Customer-Host': 'test-bluejet.cxzyuan.com',
};
const B = 'https://test-bluejet.cxzyuan.com/basic-api/aid-cscm/web-api';
(async () => {
  const box = { swLng: 114.0, swLat: 22.8, neLng: 115.0, neLat: 23.5 };
  const r = await fetch(B + '/route-plan/route/list', { method: 'POST', headers: H, body: JSON.stringify(box) });
  const j = await r.json();
  console.log('route/list resp keys:', JSON.stringify(j).slice(0, 400));
  const raw = j.data;
  const list = Array.isArray(raw) ? raw : (raw && (raw.list || raw.records || raw.rows)) || [];
  const mine = list.filter(x => (x.name || '').startsWith('PTV-区域测试-路线1'));
  console.log('路线数:', mine.length);
  for (const m of mine) console.log(m.id, m.name);
  const r2 = await fetch(B + '/route-plan/element/list', { method: 'POST', headers: H, body: JSON.stringify({ ...box, elementTypes: ['STATION'] }) });
  const j2 = await r2.json();
  console.log('element/list resp:', JSON.stringify(j2).slice(0, 400));
  const raw2 = j2.data;
  const st = (Array.isArray(raw2) ? raw2 : (raw2 && (raw2.list || raw2.records || raw2.rows)) || []).filter(x => (x.name || '').startsWith('PTV-区域测试-路线1'));
  console.log('站点数:', st.length);
  for (const s of st) console.log(s.id, s.name);
})().catch(e => console.error('ERR', e.message));