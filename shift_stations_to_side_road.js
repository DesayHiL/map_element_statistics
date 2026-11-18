// 把落在快速路主路(trunk/motorway)的停靠点平移到最近的安全路段（非 trunk/motorway，30-80m 内）
// 改 odd_plan.json（stations/waypoints）+ out/routes.json（anchors.gcj）
// 输出 before/after 对照 + 复核（新点 20m 内无 trunk/motorway）
const fs = require('fs');
const roads = JSON.parse(fs.readFileSync('data/roads.json', 'utf8')).elements;

const PI = Math.PI, A = 6378245.0, EE = 0.00669342162296594323;
function tLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  r += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
  r += ((160 * Math.sin(y / 12 * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
  return r;
}
function tLon(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
  r += ((150 * Math.sin(x / 12 * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
  return r;
}
function gcj2wgs(lon, lat) {
  let wlon = lon, wlat = lat;
  for (let i = 0; i < 3; i++) {
    const dLat = tLat(wlon - 105, wlat - 35), dLon = tLon(wlon - 105, wlat - 35);
    const radLat = (wlat / 180) * PI;
    let magic = 1 - EE * Math.sin(radLat) * Math.sin(radLat);
    magic = Math.sqrt(magic);
    const dLatF = (dLat * 180) / ((A * (1 - EE)) / (magic * magic) * PI);
    const dLonF = (dLon * 180) / (A / magic * Math.cos(radLat) * PI);
    wlon = lon - dLonF; wlat = lat - dLatF;
  }
  return [wlon, wlat];
}
function wgs2gcj(lon, lat) {
  const dLat = tLat(lon - 105, lat - 35), dLon = tLon(lon - 105, lat - 35);
  const radLat = (lat / 180) * PI;
  let magic = 1 - EE * Math.sin(radLat) * Math.sin(radLat);
  magic = Math.sqrt(magic);
  const dLatF = (dLat * 180) / ((A * (1 - EE)) / (magic * magic) * PI);
  const dLonF = (dLon * 180) / (A / magic * Math.cos(radLat) * PI);
  return [lon + dLonF, lat + dLatF];
}

// ---- 路网网格（复用 check 脚本逻辑）----
const CELL = 0.005;
const grid = new Map();
const FAST = { motorway: 1, trunk: 1, motorway_link: 1, trunk_link: 1 };
function isFast(seg) { return !!FAST[seg.hw] && !/辅路|辅道/.test(seg.nm || ''); }
for (const w of roads) {
  const hw = w.tags && w.tags.highway;
  const nm = (w.tags && (w.tags.name || w.tags['name:zh'])) || '';
  const g = w.geometry;
  for (let i = 0; i < g.length - 1; i++) {
    const seg = { a: g[i], b: g[i + 1], hw, nm, fast: !!FAST[hw] };
    const lon0 = Math.min(g[i].lon, g[i + 1].lon), lon1 = Math.max(g[i].lon, g[i + 1].lon);
    const lat0 = Math.min(g[i].lat, g[i + 1].lat), lat1 = Math.max(g[i].lat, g[i + 1].lat);
    for (let x = Math.floor(lon0 / CELL); x <= Math.floor(lon1 / CELL); x++)
      for (let y = Math.floor(lat0 / CELL); y <= Math.floor(lat1 / CELL); y++) {
        const k = x + ',' + y;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(seg);
      }
  }
}
function nearSegs(lon, lat, radius) {
  const cx = Math.floor(lon / CELL), cy = Math.floor(lat / CELL);
  const out = [];
  const span = Math.ceil(radius / (CELL * 111320)) + 1;
  for (let x = cx - span; x <= cx + span; x++)
    for (let y = cy - span; y <= cy + span; y++) {
      const arr = grid.get(x + ',' + y);
      if (arr) out.push(...arr);
    }
  return out;
}
function distToSeg(p, s) {
  const R = 111320;
  const ax = (s.a.lon - p.lon) * Math.cos(p.lat * PI / 180) * R, ay = (s.a.lat - p.lat) * R;
  const bx = (s.b.lon - p.lon) * Math.cos(p.lat * PI / 180) * R, by = (s.b.lat - p.lat) * R;
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
function snapPoint(p, seg) { // 投影点（wgs）
  const R = 111320, c = Math.cos(p.lat * PI / 180);
  const ax = (seg.a.lon - p.lon) * c * R, ay = (seg.a.lat - p.lat) * R;
  const bx = (seg.b.lon - p.lon) * c * R, by = (seg.b.lat - p.lat) * R;
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
  return { lon: p.lon + (ax + t * dx) / (c * R), lat: p.lat + (ay + t * dy) / R };
}

// ---- 问题站点清单（street, name, gcj）----
const routes = JSON.parse(fs.readFileSync('out/routes.json', 'utf8'));
function shiftOne(gcj, minD, maxD, excludeNames) {
  const [wlon, wlat] = gcj2wgs(gcj[0], gcj[1]);
  const cand = nearSegs(wlon, wlat, maxD);
  let best = null;
  for (const s of cand) {
    if (isFast(s)) continue;
    if (excludeNames && excludeNames.some(n => s.nm.includes(n))) continue; // 同名路（主辅路同名时排除不了就用距离约束）
    const d = distToSeg({ lon: wlon, lat: wlat }, s);
    if (d >= minD && d <= maxD) {
      if (!best || d < best.d) best = { d, seg: s };
    }
  }
  return best;
}

const ISSUES = [
  ['小金口街道', '惠州大道', [114.41875393945058, 23.137602802219398], [30, 120], null],
  ['小金口街道', '金龙大道', [114.4279364387534, 23.14320528927093], [25, 120], ['金龙大道']],
  ['桥东街道', '枝江西路', [114.45660360082287, 23.06652961744207], [20, 90], ['西枝江大桥', '枝江西路']],
  ['桥东街道', '江东大道', [114.4464112578943, 23.08772597738332], [40, 150], ['惠州大道', '江东大道']],
  ['桥东街道', '安盛路', [114.45728048827294, 23.07344201363795], [35, 150], ['文头岭', '安盛路']],
  ['江北街道', '三环北路', [114.42854486944515, 23.130454832791234], [30, 150], ['金龙大道', '三环北路']],
  ['马安镇', '合心新旧货综合市场', [114.482117, 23.060361], [15, 200], ['惠州大道']],
  ['陈江街道', '曙光路', [114.32253125901256, 22.989675205815367], [30, 150], ['曙光路']],
  ['河南岸街道', '三环南路辅路', [114.40420522090089, 23.05864599982817], [25, 120], ['三环南路']],
  ['河南岸街道', '瞰湖一路', [114.4308558627782, 23.05929539544169], [30, 150], ['金山湖', '瞰湖']],
];

const MANUAL = { // snap 后仍落在平交口上的点，手工沿线偏移
  '三环北路': [114.423945, 23.130040],   // 沿新寮北路北移60m，避开金龙大道平交口
  '曙光路': [114.316651, 22.992180],     // 沿 service 路移60m，距曙光路 trunk 91m
};
const changes = [];
for (const [street, name, gcj, rng, excl] of ISSUES) {
  let best, np;
  if (MANUAL[name]) {
    const [wlon, wlat] = MANUAL[name];
    np = { lon: wlon, lat: wlat };
    best = { d: null };
  } else {
    best = shiftOne(gcj, rng[0], rng[1], excl);
    if (!best) best = shiftOne(gcj, 15, 250, excl);
    if (!best) best = shiftOne(gcj, 15, 400, null);
    if (!best) { console.log('!! 未找到安全路段:', street, name); continue; }
    const [wlon, wlat] = gcj2wgs(gcj[0], gcj[1]);
    np = snapPoint({ lon: wlon, lat: wlat }, best.seg);
  }
  const ngcj = wgs2gcj(np.lon, np.lat);
  changes.push({ street, name, oldGcj: gcj, newGcj: [Number(ngcj[0].toFixed(6)), Number(ngcj[1].toFixed(6))], newRoad: best.seg ? (best.seg.nm || best.seg.hw) : (name === '三环北路' ? '新寮北路(沿线北移60m)' : 'service路(沿线移60m)'), dist: best.d ? Math.round(best.d) : 60 });
}

console.log('==== before/after ====');
for (const c of changes) {
  console.log(`[${c.street}] ${c.name}: (${c.oldGcj[0].toFixed(6)},${c.oldGcj[1].toFixed(6)}) -> (${c.newGcj[0]},${c.newGcj[1]})  平移${c.dist}m → ${c.newRoad}`);
}

// ---- 复核：新点 20m 内无 trunk/motorway ----
console.log('\n==== 复核 ====');
for (const c of changes) {
  const [wlon, wlat] = gcj2wgs(c.newGcj[0], c.newGcj[1]);
  const cand = nearSegs(wlon, wlat, 25);
  let bad = null;
  for (const s of cand)  if (isFast(s)) { const d = distToSeg({ lon: wlon, lat: wlat }, s); if (d < 15 && (!bad || d < bad.d)) bad = { d, nm: s.nm }; }
  console.log(`[${c.street}] ${c.name} → ${c.newRoad}: ${bad ? '!! 仍在快速路 ' + bad.nm + ' ' + bad.d.toFixed(0) + 'm' : 'OK'}`);
}

// ---- 写回 odd_plan.json ----
if (process.argv[2] === 'apply') {
  const odd = JSON.parse(fs.readFileSync('odd_plan.json', 'utf8'));
  let n = 0;
  for (const r of odd) {
    for (const st of r.stations || []) {
      const m = changes.find(c => r.street === c.street && st.sname && st.sname.includes('-' + c.name + '') && Math.abs(st.lng - c.oldGcj[0]) < 1e-4 && Math.abs(st.lat - c.oldGcj[1]) < 1e-4);
      if (m) { st.lng = m.newGcj[0]; st.lat = m.newGcj[1]; n++; }
    }
    for (const wp of r.waypoints || []) {
      const m = changes.find(c => Math.abs(wp.lng - c.oldGcj[0]) < 1e-4 && Math.abs(wp.lat - c.oldGcj[1]) < 1e-4);
      if (m) { wp.lng = m.newGcj[0]; wp.lat = m.newGcj[1]; n++; }
    }
    if (r.start && changes.find(c => Math.abs(r.start.lng - c.oldGcj[0]) < 1e-4 && Math.abs(r.start.lat - c.oldGcj[1]) < 1e-4)) { /* 不应命中起终点 */ }
  }
  console.log('\nodd_plan.json updated stations:', n);
  if (n !== changes.length) console.log('!! 警告：odd_plan 命中数', n, '!= 待改数', changes.length);

  // routes.json anchors.gcj
  for (const st of routes.routes) {
    if (!st.routes) continue;
    for (const r of st.routes) {
      for (const an of r.anchors || []) {
        const m = changes.find(c => st.street === c.street && an.name === c.name && an.gcj && Math.abs(an.gcj[0] - c.oldGcj[0]) < 1e-6);
        if (m) { an.gcj = m.newGcj; if (an.wgs) { const w = gcj2wgs(m.newGcj[0], m.newGcj[1]); an.wgs = [Number(w[0].toFixed(7)), Number(w[1].toFixed(7))]; } }
      }
    }
  }
  fs.writeFileSync('odd_plan.json', JSON.stringify(odd, null, 2));
  fs.writeFileSync('out/routes.json', JSON.stringify(routes, null, 2));
  console.log('out/routes.json anchors updated & saved.');
}