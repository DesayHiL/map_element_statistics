// 量化污染进入「配额 / 途经量」的程度（真实 stitchRings 版，与 plan_routes_v2.js 同源）
// 用法: node tools/audit_pollution_impact.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const D = (n) => path.join(ROOT, 'data', n + '.json');
const read = (n) => JSON.parse(fs.readFileSync(D(n), 'utf8'));

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInPolygon(lon, lat, polys) {
  for (const poly of polys) {
    if (!poly.length) continue;
    if (pointInRing(lon, lat, poly[0])) {
      let hole = false;
      for (let h = 1; h < poly.length; h++) if (pointInRing(lon, lat, poly[h])) { hole = true; break; }
      if (!hole) return true;
    }
  }
  return false;
}
function stitchRings(segments) {
  const pool = segments.map((s) => s.slice());
  const rings = [];
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  while (pool.length) {
    let cur = pool.shift();
    let ext = true;
    while (ext && !same(cur[0], cur[cur.length - 1])) {
      ext = false;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i];
        if (same(cur[cur.length - 1], s[0])) { cur = cur.concat(s.slice(1)); pool.splice(i, 1); ext = true; break; }
        if (same(cur[cur.length - 1], s[s.length - 1])) { cur = cur.concat(s.slice(0, -1).reverse()); pool.splice(i, 1); ext = true; break; }
        if (same(cur[0], s[s.length - 1])) { cur = s.slice(0, -1).concat(cur); pool.splice(i, 1); ext = true; break; }
        if (same(cur[0], s[0])) { cur = s.slice(1).reverse().concat(cur); pool.splice(i, 1); ext = true; break; }
      }
    }
    if (cur.length >= 4) rings.push(cur);
  }
  return rings;
}

const HC_SUBS = new Set(read('hc_subnames').elements.map((e) => e.tags.name).filter(Boolean));
function buildAreas() {
  const bnd = read('boundaries_geom'), extra = read('lilin');
  const areas = [];
  for (const el of [...bnd.elements, ...extra.elements]) {
    const t = el.tags || {};
    if (t.admin_level !== '8' || !t.name || !HC_SUBS.has(t.name)) continue;
    const segments = [];
    for (const m of el.members || []) {
      if (m.type !== 'way' || !m.geometry || m.geometry.length < 2) continue;
      if (m.role === 'inner') continue;
      segments.push(m.geometry.map((p) => [p.lon, p.lat]));
    }
    const rings = stitchRings(segments);
    if (rings.length) areas.push({ name: t.name, polygons: rings.map((r) => [r]) });
  }
  return areas;
}
const areas = buildAreas();
const assign = (lon, lat) => { for (const a of areas) if (pointInPolygon(lon, lat, a.polygons)) return a.name; return null; };

const VEHICLE = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|track)(_link)?$/;
const HWDOM = /^(motorway|trunk)$|_link$/;

function kind(e) {
  const g = e.tags || {};
  if (g.railway) return 'railway';
  if (g.waterway) return 'waterway';
  if (!g.highway) return 'nolabel';
  if (!VEHICLE.test(g.highway)) return 'nonveh:' + g.highway;
  if (HWDOM.test(g.highway)) return 'hwdom:' + g.highway;
  return 'veh:' + g.highway;
}
// 判定「真 ODD 车行隧道/桥梁」：有车辆路标签 且 不在高速域
const pure = (e) => {
  const k = kind(e);
  return k.startsWith('veh:');
};

console.log('区内范围（惠城区 18 个镇街）统计：\n');
for (const key of ['tunnels', 'bridges']) {
  const els = read(key).elements;
  let inScope = 0, pureN = 0;
  const detail = {};
  for (const e of els) {
    const c = e.type === 'node' ? [e.lon, e.lat] : e.center ? [e.center.lon, e.center.lat] : null;
    if (!c) continue;
    if (!assign(c[0], c[1])) continue;
    inScope++;
    if (pure(e)) pureN++;
    else { const k = kind(e); detail[k] = (detail[k] || 0) + 1; }
  }
  console.log(`【${key}】区内 ${inScope} 条 · 真 ODD 车行 ${pureN} · 非 ODD 载体 ${inScope - pureN}（${((inScope - pureN) / inScope * 100).toFixed(1)}%）`);
  Object.entries(detail).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('     ', String(v).padStart(4), k));
  console.log();
}
