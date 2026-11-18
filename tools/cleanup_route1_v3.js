// 清理路线1试点旧命名资产（PTV-区域测试-路线1-* 的路线与站点）
const { bj } = require('./bj_auth');
(async () => {
  const box = { swLng: 114.0, swLat: 22.8, neLng: 115.0, neLat: 23.5 };
  // 1. 路线
  const j = await bj('/route-plan/route/list', box);
  const routes = (j.data.list || []).filter(x => (x.name || '').startsWith('PTV-区域测试-路线1'));
  console.log('待删路线:', routes.length);
  for (const r of routes) {
    const d = await bj('/route-plan/route/delete?id=' + r.id, {});
    console.log('del route', r.name, d.code === 200 ? 'OK' : JSON.stringify(d).slice(0, 80));
    await new Promise(s => setTimeout(s, 200));
  }
  // 2. 站点（element/list）
  const j2 = await bj('/route-plan/element/list', { ...box, elementTypes: ['STATION'] });
  const raw2 = j2.data;
  const sts = (Array.isArray(raw2) ? raw2 : (raw2 && (raw2.list || raw2.records)) || []).filter(x => (x.name || '').startsWith('PTV-区域测试-路线1'));
  console.log('待删站点:', sts.length);
  for (const s of sts) {
    const sid = s.elementId || s.id;
    const d = await bj('/route-plan/station/delete?id=' + sid, {});
    console.log('del station', s.name, d.code === 200 ? 'OK' : JSON.stringify(d).slice(0, 80));
    await new Promise(s2 => setTimeout(s2, 200));
  }
  console.log('DONE');
})().catch(e => console.error('ERR', e.message));