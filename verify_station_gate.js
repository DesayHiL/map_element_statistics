// =============================================================================
// 站点落点最终关卡（hxa 终验标准）—— 任何站点坐标生效前必须过本关卡
// =============================================================================
// 背景（2026-10-29 用户连续抓出 3 个落点错误）：
//   52 鹅岭立交桥  → 落立交枢纽中心（几何检查"距桥28m"假通过，实际被匝道包围）
//   51 仲恺大道辅路 → OSM 过度排桥后 snap 到无名楼间道，落进楼栋区（盛康大厦旁）
//   46 惠新大道    → 用户质疑匝道停车（贴桥匝道口）
// 教训：OSM/宽凳自证 OSM/宽凳 = 假验证。必须让高德（独立第三方）亲口认领。
//
// 关卡标准（全部满足才算有效）：
//   G0 数据源优先级：宽凳 GCJ02 > 高德 > OSM。OSM 置信度最低，仅作辅助初筛（桥/快速路几何），
//      最终裁决权在宽凳/高德（用户 2026-10-29 定：ODD 多数以宽凳地图和高德为准）
//   G1 高德 regeo 认领道路：regeo roads[0].distance <= 5m（严于旧 25m——楼间道 7m 假通过教训）
//   G2 非桥非快速：OSM bridge 距 >30m、fast(trunk/motorway) 距 >30m（初筛；高架正下辅路需脱离投影段）
//   G3 盲区豁免：高德路网不覆盖的郊区点（regeo 无路），用驾车规划 API 验证可达
//      （宏达路/鹿岗大道案例：高德仅乡道 500m 外，实际路真实存在，driving 可达）
//   G4 站点-轨迹耦合：站点距所属路线 routePath <= 100m（站点从轨迹派生，脱轨=停靠时漏采 ODD 元素）
//      桥/立交类点（原点在桥面）例外：安全换覆盖的正确取舍，轨迹仍途经覆盖
// 用法：node verify_station_gate.js [odd_plan.json|out/kd_fix_final.json] [--couple platform_routes_now.json]
// =============================================================================
const fs = require('fs');
const ROOT = __dirname;
const { nextKey } = require(ROOT + '/amap_key.js');

const roads = JSON.parse(fs.readFileSync(ROOT + '/data/roads.json', 'utf8')).elements;
const PI = Math.PI;
const FAST = { motorway: 1, trunk: 1, motorway_link: 1, trunk_link: 1 };

function gcj2wgs(lon, lat) {
  const A = 6378245.0, EE = 0.00669342162296594323;
  function tLat(x, y) { let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x)); r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3; r += ((20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2) / 3; r += ((160 * Math.sin(y / 12 * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3; return r; }
  function tLon(x, y) { let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x)); r += ((20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2) / 3; r += ((150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2) / 3; return r; }
  let wl = lon, wt = lat;
  for (let i = 0; i < 3; i++) { const dL = tLat(wl - 105, wt - 35), dO = tLon(wl - 105, wt - 35); const rl = wt / 180 * PI; let mg = 1 - EE * Math.sin(rl) ** 2; mg = Math.sqrt(mg); wl = lon - (dO * 180) / ((A / mg) * Math.cos(rl) * PI); wt = lat - (dL * 180) / ((A * (1 - EE)) / (mg * mg) * PI); }
  return [wl, wt];
}

// 网格
const CELL = 0.005, og = new Map();
for (const w of roads) {
  const hw = (w.tags || {}).highway || '', nm = (w.tags || {}).name || '', bridge = !!(w.tags || {}).bridge;
  const fast = !!FAST[hw] && !/辅路|辅道/.test(nm);
  for (let i = 0; i < w.geometry.length - 1; i++) {
    const seg = { a: w.geometry[i], b: w.geometry[i + 1], hw, nm, bridge, fast };
    const x0 = Math.floor(Math.min(seg.a.lon, seg.b.lon) / CELL), x1 = Math.floor(Math.max(seg.a.lon, seg.b.lon) / CELL);
    const y0 = Math.floor(Math.min(seg.a.lat, seg.b.lat) / CELL), y1 = Math.floor(Math.max(seg.a.lat, seg.b.lat) / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = x + ',' + y; if (!og.has(k)) og.set(k, []); og.get(k).push(seg); }
  }
}
function osmDanger(gcjLon, gcjLat) {
  const [wl, wt] = gcj2wgs(gcjLon, gcjLat);
  const cx = Math.floor(wl / CELL), cy = Math.floor(wt / CELL);
  let bridgeD = 1e9, fastD = 1e9;
  for (let x = cx - 2; x <= cx + 2; x++) for (let y = cy - 2; y <= cy + 2; y++) {
    const a = og.get(x + ',' + y); if (!a) continue;
    for (const sg of a) {
      const R = 111320, c = Math.cos(wt * PI / 180);
      const ax = (sg.a.lon - wl) * c * R, ay = (sg.a.lat - wt) * R, bx = (sg.b.lon - wl) * c * R, by = (sg.b.lat - wt) * R;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (sg.bridge && d < bridgeD) bridgeD = d;
      if (sg.fast && d < fastD) fastD = d;
    }
  }
  return { bridgeD, fastD };
}

async function regeo(lon, lat) {
  const key = nextKey();
  const j = await (await fetch('https://restapi.amap.com/v3/geocode/regeo?location=' + lon.toFixed(6) + ',' + lat.toFixed(6) + '&extensions=all&radius=25&key=' + key)).json();
  if (j.infocode !== '10000') return { err: j.info };
  const road = j.regeocode && j.regeocode.roads && j.regeocode.roads[0];
  return { road: road ? road.name : null, dist: road ? Math.round(+road.distance) : null };
}
async function drivingReachable(lon, lat) {
  const key = nextKey();
  // 从 1km 外一点驾车到目标（粗略可达性验证，用于高德路网盲区豁免）
  const origin = (lon - 0.008).toFixed(6) + ',' + (lat + 0.006).toFixed(6);
  const j = await (await fetch('https://restapi.amap.com/v3/direction/driving?origin=' + origin + '&destination=' + lon + ',' + lat + '&strategy=3&key=' + key)).json();
  return j.infocode === '10000' && j.route && j.route.paths && j.route.paths.length > 0;
}

async function verify(lon, lat) {
  const danger = osmDanger(lon, lat);
  const g2 = danger.bridgeD > 30 && danger.fastD > 30;
  const r = await regeo(lon, lat);
  if (r.err) return { pass: false, why: 'regeo_error:' + r.err };
  if (r.road && r.dist !== null && r.dist <= 5) return { pass: g2, road: r.road, roadDist: r.dist, bridgeD: Math.round(danger.bridgeD), fastD: Math.round(danger.fastD), why: g2 ? null : '贴桥/贴快速' };
  // 盲区豁免：driving 可达且非桥非快
  if (g2) {
    const reach = await drivingReachable(lon, lat);
    if (reach) return { pass: true, road: '(高德盲区·驾车可达豁免)', roadDist: null, bridgeD: Math.round(danger.bridgeD), fastD: Math.round(danger.fastD) };
  }
  return { pass: false, why: '高德不认领道路(距认领路' + (r.dist !== null ? r.dist : '?') + 'm>5m)', road: r.road, roadDist: r.dist };
}

// —— G4 站点-轨迹耦合 ——
function distToPath(p, path) {
  let d = 1e9;
  for (let i = 0; i < path.length - 1; i++) {
    const ax = (path[i][0] - p[0]) * 102800, ay = (path[i][1] - p[1]) * 110900, bx = (path[i + 1][0] - p[0]) * 102800, by = (path[i + 1][1] - p[1]) * 110900;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    const dd = Math.hypot(ax + t * dx, ay + t * dy); if (dd < d) d = dd;
  }
  return d;
}
function verifyCoupling(fixes, routes) {
  const out = [];
  for (const f of fixes) {
    const m = (f.sname || '').match(/(标号\d+-路线\d+)/); if (!m) continue;
    const rt = routes.find(r => r.name.includes(m[1]));
    if (!rt || !rt.routePath) { out.push({ f, coupled: null, why: '无所属轨迹' }); continue; }
    const p = f.to || [f.lng, f.lat];
    const d = distToPath(p, rt.routePath);
    out.push({ f, coupled: d <= 100, dist: Math.round(d), why: d <= 100 ? null : '距所属路线轨迹 ' + Math.round(d) + 'm>100m（停靠时漏采该点 ODD 元素）' });
  }
  return out;
}

module.exports = { verify, verifyCoupling, distToPath };

if (require.main === module) {
  (async () => {
    const ai = process.argv.indexOf('--couple');
    const src = process.argv[2] || ROOT + '/out/kd_fix_final.json';
    const fixes = JSON.parse(fs.readFileSync(src, 'utf8'));
    let pass = 0, fail = [];
    for (let i = 0; i < fixes.length; i++) {
      const f = fixes[i];
      const to = f.to || [f.lng, f.lat];
      const v = await verify(to[0], to[1]);
      if (v.pass) { pass++; console.log('✅ ' + String(i + 1).padStart(2, '0') + ' ' + (f.sname || '').split('-').pop().slice(0, 14) + ' | ' + v.road); }
      else { fail.push(i + 1); console.log('🚩 ' + String(i + 1).padStart(2, '0') + ' ' + (f.sname || '').split('-').pop().slice(0, 14) + ' | ' + v.why + (v.road ? '(' + v.road + ' ' + v.roadDist + 'm)' : '')); }
      await new Promise(r => setTimeout(r, 120));
    }
    console.log('\nG1-G3 落点通过 ' + pass + '/' + fixes.length + (fail.length ? '；不通过 → ' + fail.join(',') : ''));
    if (ai > -1) {
      const routes = JSON.parse(fs.readFileSync(process.argv[ai + 1] || ROOT + '/out/platform_routes_now.json', 'utf8'));
      const coup = verifyCoupling(fixes, routes);
      const bad = coup.filter(c => c.coupled === false);
      console.log('G4 轨迹耦合 ' + (coup.length - bad.length) + '/' + coup.length + (bad.length ? '；脱轨 → ' + bad.map(c => c.f.sname.split('-').pop().slice(0, 12) + '(' + c.dist + 'm)').join('、') : ''));
    }
  })();
}
