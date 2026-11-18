// 全量补绑：大 viewport 拉全部 PTV 站点，未绑重庆天天鲜面店的逐个绑定，最后复查
const fs = require('fs');
const ST = () => fs.readFileSync('supply_token.txt', 'utf8').trim();
const SP = 'https://test-supply.cxzyuan.com/basic-api/admin-api';
const H = () => ({ Authorization: 'Bearer ' + ST(), 'tenant-id': '1', 'Content-Type': 'application/json' });
const CUSTOMER_ID = '2064209631114588161'; // 算法测试客户企业（2026-10-29 最终确认；2115632236650123266 重庆天天鲜面店已弃用）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const vp = await (await fetch(SP + '/vehicle/operation-area-manage/getStationsByViewport', { method: 'POST', headers: H(), body: JSON.stringify({ neLat: 23.35, neLng: 114.70, swLat: 22.90, swLng: 114.20 }) })).json();
  const hits = (vp.data || []).filter((s) => /PTV-区域测试/.test(s.name || ''));
  console.log('PTV 站点总数:', hits.length);
  const unbound = [];
  for (const s of hits) {
    const d = await (await fetch(SP + '/vehicle/operation-area-manage/getStationDetail', { method: 'POST', headers: H(), body: JSON.stringify({ id: s.id }) })).json();
    if (!(d.data && d.data.customerId)) unbound.push(s);
    await sleep(60);
  }
  console.log('未绑:', unbound.length);
  let ok = 0, fail = 0;
  for (const s of unbound) {
    const b = await (await fetch(SP + '/vehicle/operation-area-manage/updateStationCustomer', { method: 'POST', headers: H(), body: JSON.stringify({ stationId: s.id, customerIds: [CUSTOMER_ID] }) })).json();
    if (b.code === 0 || b.code === 200) ok++; else { fail++; if (fail <= 5) console.log('  FAIL', s.name, b.msg); }
    await sleep(150);
  }
  console.log('补绑完成 ok=' + ok + ' fail=' + fail);
  // 复查
  const vp2 = await (await fetch(SP + '/vehicle/operation-area-manage/getStationsByViewport', { method: 'POST', headers: H(), body: JSON.stringify({ neLat: 23.35, neLng: 114.70, swLat: 22.90, swLng: 114.20 }) })).json();
  const hits2 = (vp2.data || []).filter((s) => /PTV-区域测试/.test(s.name || ''));
  let bound = 0; const miss = [];
  for (const s of hits2) {
    const d = await (await fetch(SP + '/vehicle/operation-area-manage/getStationDetail', { method: 'POST', headers: H(), body: JSON.stringify({ id: s.id }) })).json();
    if (d.data && d.data.customerId) bound++; else miss.push(s.name);
    await sleep(60);
  }
  console.log('终检: 总数', hits2.length, '已绑', bound, '未绑', miss.length, miss.slice(0, 5));
})();