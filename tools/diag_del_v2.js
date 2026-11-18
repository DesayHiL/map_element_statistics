// 诊断：删 ptv-路线1 站点的完整响应
const { bj } = require('./bj_auth');
(async () => {
  const box = { swLng: 114.0, swLat: 22.8, neLng: 115.0, neLat: 23.5 };
  const j2 = await bj('/route-plan/element/list', { ...box, elementTypes: ['STATION'] });
  const raw2 = j2.data;
  const sts = (Array.isArray(raw2) ? raw2 : (raw2 && (raw2.list || raw2.records)) || []).filter(x => (x.name || '').startsWith('ptv-路线1'));
  for (const s of sts) {
    const sid = s.elementId || s.id;
    const d = await bj('/route-plan/station/delete?id=' + sid, {});
    console.log(s.name, sid, JSON.stringify(d).slice(0, 200));
    await new Promise(s2 => setTimeout(s2, 300));
  }
})().catch(e => console.error('ERR', e.message));