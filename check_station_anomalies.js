// 全量 311 站点异常落点统计：
// A. 距最近可行驶道路(非service/footway) >30m → 疑似落在建筑/小区内
// B. 落在桥梁桥面（OSM bridge=yes 的路段）
// C. 落在 trunk/motorway（含主路，复核上一轮是否漏网）
// D. service/内部道路（小区路/停车场道）→ 停靠可接受但标记
// E. 距路口中心 <15m（上轮遗留）
const fs = require('fs');
const roads = JSON.parse(fs.readFileSync('data/roads.json', 'utf8')).elements;
const odd = JSON.parse(fs.readFileSync('odd_plan.json', 'utf8'));
const PI = Math.PI, A = 6378245.0, EE = 0.00669342162296594323;
function tLat(x, y) { let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x)); r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3; r += ((20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2) / 3; r += ((160 * Math.sin(y / 12 * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3; return r; }
function tLon(x, y) { let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x)); r += ((20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2) / 3; r += ((150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2) / 3; return r; }
function gcj2wgs(lon, lat) { let wl = lon, wt = lat; for (let i = 0; i < 3; i++) { const dL = tLat(wl - 105, wt - 35), dO = tLon(wl - 105, wt - 35); const rl = wt / 180 * PI; let mg = 1 - EE * Math.sin(rl) ** 2; mg = Math.sqrt(mg); wl = lon - (dO * 180) / ((A / mg) * Math.cos(rl) * PI); wt = lat - (dL * 180) / ((A * (1 - EE)) / (mg * mg) * PI); } return [wl, wt]; }

// 路段网格
const CELL = 0.005;
const grid = new Map();
const FAST = { motorway: 1, trunk: 1, motorway_link: 1, trunk_link: 1 };
for (const w of roads) {
  const hw = (w.tags || {}).highway || '';
  const nm = (w.tags || {}).name || '';
  const bridge = !!(w.tags || {}).bridge;
  const g = w.geometry;
  for (let i = 0; i < g.length - 1; i++) {
    const seg = { a: g[i], b: g[i + 1], hw, nm, bridge, fast: !!FAST[hw] && !/辅路|辅道/.test(nm) };
    const lon0 = Math.min(g[i].lon, g[i + 1].lon), lon1 = Math.max(g[i].lon, g[i + 1].lon);
    const lat0 = Math.min(g[i].lat, g[i + 1].lat), lat1 = Math.max(g[i].lat, g[i + 1].lat);
    for (let x = Math.floor(lon0 / CELL); x <= Math.floor(lon1 / CELL); x++)
      for (let y = Math.floor(lat0 / CELL); y <= Math.floor(lat1 / CELL); y++) {
        const k = x + ',' + y; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(seg);
      }
  }
}
function nearSegs(lon, lat, r) {
  const cx = Math.floor(lon / CELL), cy = Math.floor(lat / CELL), out = [], span = Math.ceil(r / (CELL * 111320)) + 1;
  for (let x = cx - span; x <= cx + span; x++) for (let y = cy - span; y <= cy + span; y++) { const a = grid.get(x + ',' + y); if (a) out.push(...a); }
  return out;
}
function distToSeg(p, s) { const R = 111320, c = Math.cos(p.lat * PI / 180); const ax = (s.a.lon - p.lon) * c * R, ay = (s.a.lat - p.lat) * R, bx = (s.b.lon - p.lon) * c * R, by = (s.b.lat - p.lat) * R; const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy; const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0; return Math.hypot(ax + t * dx, ay + t * dy); }

const DRIVE = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street'];
const stats = { offroad: [], bridge: [], fast: [], service: [], total: 0 };
for (const r of odd) {
  for (const s of r.stations || []) {
    stats.total++;
    const [wl, wt] = gcj2wgs(s.lng, s.lat);
    const cand = nearSegs(wl, wt, 100);
    let bestDrive = null, bestAny = null, bestBridge = null, bestFast = null;
    for (const sg of cand) {
      const d = distToSeg({ lon: wl, lat: wt }, sg);
      if (DRIVE.includes(sg.hw) && (!bestDrive || d < bestDrive.d)) bestDrive = { d, sg };
      if (!bestAny || d < bestAny.d) bestAny = { d, sg };
      if (sg.bridge && (!bestBridge || d < bestBridge.d)) bestBridge = { d, sg };
      if (sg.fast && (!bestFast || d < bestFast.d)) bestFast = { d, sg };
    }
    const info = { street: r.street, rn: r.rn, name: (s.sname || '').split('-').pop(), lng: s.lng, lat: s.lat };
    if (bestBridge && bestBridge.d < 20) stats.bridge.push({ ...info, detail: bestBridge.sg.nm || '桥', d: Math.round(bestBridge.d) });
    if (bestFast && bestFast.d < 15) stats.fast.push({ ...info, detail: bestFast.sg.nm, d: Math.round(bestFast.d) });
    if (bestDrive && bestDrive.d > 30) stats.offroad.push({ ...info, detail: bestAny ? ('最近是 ' + (bestAny.sg.nm || bestAny.sg.hw) + '(' + Math.round(bestAny.d) + 'm) 可行驶路 ' + (bestDrive.sg.nm || bestDrive.sg.hw) + ' 距 ' + Math.round(bestDrive.d) + 'm') : '', d: Math.round(bestDrive.d) });
    else if (bestDrive && bestDrive.d > 15 && bestAny && bestAny.sg.hw === 'service') stats.service.push({ ...info, detail: `service 路上 ${Math.round(bestAny.d)}m（${bestAny.sg.nm || '未名'}），主干路 ${bestDrive.sg.nm || bestDrive.sg.hw} 距 ${Math.round(bestDrive.d)}m`, d: Math.round(bestDrive.d) });
  }
}
console.log('总站点:', stats.total);
console.log('\n== A. 疑似建筑/小区内（距可行驶路 >30m）==', stats.offroad.length);
stats.offroad.forEach((x) => console.log(` [${x.street}] ${x.rn} ${x.name} | ${x.detail}`));
console.log('\n== B. 桥梁桥面上（<20m）==', stats.bridge.length);
stats.bridge.forEach((x) => console.log(` [${x.street}] ${x.rn} ${x.name} | ${x.detail} ${x.d}m`));
console.log('\n== C. 快速路/高速主路（<15m，复核漏网）==', stats.fast.length);
stats.fast.forEach((x) => console.log(` [${x.street}] ${x.rn} ${x.name} | ${x.detail} ${x.d}m`));
console.log('\n== D. service/内部道路（15-30m 非主干）==', stats.service.length);
stats.service.slice(0, 40).forEach((x) => console.log(` [${x.street}] ${x.rn} ${x.name} | ${x.detail}`));
if (stats.service.length > 40) console.log(` ... 另 ${stats.service.length - 40} 个`);