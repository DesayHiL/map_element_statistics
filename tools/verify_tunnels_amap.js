// 用高德 POI/地理检索核验 OSM 明确命名的道路隧道；结果仅作交叉核验，不替代现场确认。
const fs = require('fs');
const path = require('path');
const { KEYS } = require('../amap_key');
const names = ['金榜隧道', '金恺隧道', '西坑东隧道', '西坑西隧道', '九峰山隧道', '尖峰山隧道', '南山隧道'];
const OUT = path.join(__dirname, '..', 'out');
(async () => {
  const routes = JSON.parse(fs.readFileSync(path.join(OUT, 'routes.json'), 'utf8'));
  const amapRouteRoadNames = [];
  for (const s of (routes.routes || [])) for (const r of (s.routes || [])) amapRouteRoadNames.push(...(r.roads || []));
  for (const s of (routes.scenarioRoutes || [])) amapRouteRoadNames.push(...(s.roads || []));
  const rows = [];
  for (const name of names) {
    const url = `https://restapi.amap.com/v3/place/text?keywords=${encodeURIComponent(name)}&city=441302&citylimit=true&offset=10&page=1&extensions=all&key=${KEYS[0]}`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      const pois = (j.pois || []).map(p => ({ id: p.id, name: p.name, type: p.type, location: p.location, address: p.address, pname: p.pname, cityname: p.cityname }));
      // 不能把“西坑西隧道”查询返回的“西坑东隧道”误算为命中；要求名称精确一致。
      const exact = pois.filter(p => p.name === name && /隧道/.test(p.type || ''));
      const routeHits = amapRouteRoadNames.filter(x => x === name).length;
      const poiHit = j.status === '1' && exact.length > 0;
      rows.push({ name, status: poiHit || routeHits ? 'amap-confirmed' : 'not-confirmed', poiExactHit: poiHit, routeRoadNameHits: routeHits, count: exact.length, pois: exact, candidates: pois });
    } catch (e) { rows.push({ name, status: 'error', count: 0, error: String(e.message || e), pois: [] }); }
  }
  const result = { generated: new Date().toISOString(), source: '高德地图 Web 服务 POI 关键字检索（city=441302）', note: '高德命中仅证明有地图 POI 记录；路线可执行性仍需现场确认。', rows };
  fs.writeFileSync(path.join(OUT, 'tunnel_amap_verify.json'), JSON.stringify(result, null, 2));
  console.log(`tunnel_amap_verify.json: ${rows.filter(r => r.status === 'amap-confirmed').length}/${rows.length} 高德确认（POI 同名或算路道路名）`);
})().catch(e => { console.error(e); process.exit(1); });
