const fs = require('fs');
const ST = fs.readFileSync('supply_token.txt', 'utf8').trim();
(async () => {
  const vp = await (await fetch('https://test-supply.cxzyuan.com/basic-api/admin-api/vehicle/operation-area-manage/getStationsByViewport', { method: 'POST', headers: { Authorization: 'Bearer ' + ST, 'tenant-id': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ neLat: 23.20, neLng: 114.60, swLat: 23.00, swLng: 114.30 }) })).json();
  const hits = (vp.data || []).filter((s) => /PTV-区域测试-路线\d+-/.test(s.name || ''));
  let bound = 0; const unbound = [];
  for (const s of hits) {
    const d = await (await fetch('https://test-supply.cxzyuan.com/basic-api/admin-api/vehicle/operation-area-manage/getStationDetail', { method: 'POST', headers: { Authorization: 'Bearer ' + ST, 'tenant-id': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id }) })).json();
    if (d.data && d.data.customerId) bound++; else unbound.push(s.name);
  }
  console.log('supply 站点', hits.length, '| 已绑客户', bound, '| 未绑', unbound.length, unbound.slice(0, 5));
})();