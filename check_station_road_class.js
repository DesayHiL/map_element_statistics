// 站点/路线 途经快速路·匝道·路口 核查脚本
// 输入：out/routes.json（poly=GCJ 实际轨迹, anchors=GCJ 站点）、data/roads.json（WGS84 OSM 路网）
// 判定：站点/轨迹点 30m 内的 OSM 道路 highway 类型（motorway/trunk=快速路主干, *_link=匝道）
//       路口：站点 20m 内是否为 signals/roundabouts 位置
const fs = require('fs');
const path = require('path');

const roads = JSON.parse(fs.readFileSync('data/roads.json', 'utf8')).elements;
const plan = JSON.parse(fs.readFileSync('out/routes.json', 'utf8'));

// ---------- GCJ -> WGS ----------
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

// ---------- 空间索引（网格） ----------
const CELL = 0.005; // ~500m
const grid = new Map();
function gk(lon, lat) { return Math.floor(lon / CELL) + ',' + Math.floor(lat / CELL); }
function addToGrid(lon, lat, item) {
  const k = gk(lon, lat);
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(item);
}
const segs = []; // {way highway, name, seg}
for (const w of roads) {
  const hw = w.tags && w.tags.highway;
  const nm = (w.tags && (w.tags.name || w.tags['name:zh'])) || '';
  const g = w.geometry;
  for (let i = 0; i < g.length - 1; i++) {
    const seg = { a: g[i], b: g[i + 1], hw, nm, id: w.id };
    segs.push(seg);
    // 加到两端所在格及邻格
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
function distToSeg(p, s) { // p:{lon,lat} 度近似米
  const R = 111320;
  const ax = (s.a.lon - p.lon) * Math.cos(p.lat * PI / 180) * R, ay = (s.a.lat - p.lat) * R;
  const bx = (s.b.lon - p.lon) * Math.cos(p.lat * PI / 180) * R, by = (s.b.lat - p.lat) * R;
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
  const px = ax + t * dx, py = ay + t * dy;
  return Math.sqrt(px * px + py * py);
}
function nearRoads(lon, lat, radius, visitedCells) {
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

const FAST = { motorway: '高速', trunk: '快速路/主干(干道快速)', motorway_link: '高速匝道', trunk_link: '匝道/联络道' };

// ---------- 逐街道逐路线核查 ----------
console.log('====== A. 站点（anchors）落点核查 ======');
for (const st of plan.routes) {
  if (!st.routes) continue;
  for (const r of st.routes) {
    const hits = [];
    for (const an of (r.anchors || [])) {
      const gcj = an.gcj;
      if (!gcj) continue;
      const [lon, lat] = gcj2wgs(gcj[0], gcj[1]);
      const cand = nearRoads(lon, lat, 60);
      let best = null;
      for (const s of cand) {
        if (!FAST[s.hw]) continue;
        const d = distToSeg({ lon, lat }, s);
        if (d < 30 && (!best || d < best.d)) best = { d, hw: s.hw, nm: s.nm, name: an.name };
      }
      if (best) hits.push(`${an.name} → ${FAST[best.hw]}(${best.nm || '未名'}, ${best.d.toFixed(0)}m)`);
    }
    if (hits.length) console.log(`[${st.street}] ${r.kind} ${r.distKm}km\n  ${hits.join('\n  ')}`);
  }
}

console.log('\n====== B. 实际轨迹(poly)途经快速路/匝道占比 ======');
for (const st of plan.routes) {
  if (!st.routes) continue;
  for (const r of st.routes) {
    const poly = r.poly || [];
    if (poly.length < 2) continue;
    let n = 0, fast = 0; const fastNames = new Set();
    for (let i = 0; i < poly.length; i += 3) { // 抽样
      const [lon, lat] = gcj2wgs(poly[i][0], poly[i][1]);
      n++;
      const cand = nearRoads(lon, lat, 30);
      let best = null;
      for (const s of cand) {
        const d = distToSeg({ lon, lat }, s);
        if ((!best || d < best.d)) best = { d, hw: s.hw, nm: s.nm };
      }
      if (best && best.d < 20 && FAST[best.hw]) { fast++; fastNames.add(`${best.nm || FAST[best.hw]}`); }
    }
    const pct = (fast / n * 100).toFixed(0);
    if (fast > 0) console.log(`[${st.street}] ${r.kind} ${r.distKm}km | 快速路/匝道占比 ${pct}% (${fast}/${n}) | ${[...fastNames].join(',')}`);
  }
}

// ---------- C. 路口判定：站点距信号灯/环岛 ----------
const signals = JSON.parse(fs.readFileSync('data/signals.json', 'utf8'));
const roundabouts = JSON.parse(fs.readFileSync('data/roundabout.json', 'utf8'));
function flat(el) { // OSM elements -> [lon,lat]
  const out = [];
  const arr = el.elements ? el.elements : el;
  for (const e of arr) {
    if (e.lat && e.lon) out.push([e.lon, e.lat]);
    if (e.geometry) for (const g of e.geometry) out.push([g.lon, g.lat]);
  }
  return out;
}
const sigPts = flat(signals), rbPts = flat(roundabouts);
console.log(`\n====== C. 站点距信号灯/环岛 <25m（=落在路口）====== signals:${sigPts.length} roundabouts:${rbPts.length}`);
function minDist(pl, lon, lat) {
  let m = 1e9;
  for (const p of pl) {
    const d = Math.hypot((p[0] - lon) * Math.cos(lat * PI / 180) * 111320, (p[1] - lat) * 111320);
    if (d < m) m = d;
  }
  return m;
}
for (const st of plan.routes) {
  if (!st.routes) continue;
  for (const r of st.routes) {
    const hits = [];
    for (const an of (r.anchors || [])) {
      const gcj = an.gcj; if (!gcj) continue;
      const [lon, lat] = gcj2wgs(gcj[0], gcj[1]);
      const ds = minDist(sigPts, lon, lat), db = minDist(rbPts, lon, lat);
      const d = Math.min(ds, db);
      if (d < 25) hits.push(`${an.name} → ${d < 15 ? '信号灯/环岛' : '路口'}中心 ${d.toFixed(0)}m`);
    }
    if (hits.length) console.log(`[${st.street}] ${r.kind} ${r.distKm}km\n  ${hits.join('\n  ')}`);
  }
}
console.log('\ndone');