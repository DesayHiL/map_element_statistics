// 坐标框架错配审计（只读）：高德 POI 是 GCJ-02，OSM 街道多边形是 WGS-84。
// build_stats.js 直接用 GCJ-02 的点去做 WGS-84 的 point-in-polygon —— 这里量化它的代价。
const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, 'data');
const read = (n) => JSON.parse(fs.readFileSync(path.join(DATA, n + '.json'), 'utf8'));

// ---------- GCJ-02 <-> WGS-84 ----------
const A = 6378245.0, EE = 0.00669342162296594323;
const tLat = (x, y) => {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return r;
};
const tLon = (x, y) => {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return r;
};
const outOfChina = (lon, lat) => !(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55);
function wgs2gcj(lon, lat) {
  if (outOfChina(lon, lat)) return [lon, lat];
  let dLat = tLat(lon - 105, lat - 35), dLon = tLon(lon - 105, lat - 35);
  const radLat = (lat / 180) * Math.PI;
  let magic = Math.sin(radLat); magic = 1 - EE * magic * magic;
  const sq = Math.sqrt(magic);
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sq)) * Math.PI);
  dLon = (dLon * 180) / ((A / sq) * Math.cos(radLat) * Math.PI);
  return [lon + dLon, lat + dLat];
}
function gcj2wgs(lon, lat) { // 迭代反解
  let wlon = lon, wlat = lat;
  for (let i = 0; i < 40; i++) {
    const [glon, glat] = wgs2gcj(wlon, wlat);
    const dlon = glon - lon, dlat = glat - lat;
    if (Math.abs(dlon) < 1e-11 && Math.abs(dlat) < 1e-11) break;
    wlon -= dlon; wlat -= dlat;
  }
  return [wlon, wlat];
}

// ---------- geometry ----------
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPoly = (lon, lat, polys) => polys.some((p) => p.length && pointInRing(lon, lat, p[0]));
function stitchRings(segments) {
  const pool = segments.map((s) => s.slice()); const rings = [];
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  while (pool.length) {
    let cur = pool.shift(); let ext = true;
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
function ringsOf(el) {
  const segs = [];
  for (const m of el.members || []) {
    if (m.type !== 'way' || !m.geometry || m.geometry.length < 2 || m.role === 'inner') continue;
    segs.push(m.geometry.map((p) => [p.lon, p.lat]));
  }
  return stitchRings(segs);
}

const HC = new Set(read('hc_subnames').elements.map((e) => e.tags.name).filter(Boolean));
const areas = [];
let district = null;
for (const el of [...read('boundaries_geom').elements, ...read('lilin').elements]) {
  const t = el.tags || {};
  if (!t.name) continue;
  if (t.admin_level === '8' && HC.has(t.name)) areas.push({ name: t.name, polys: ringsOf(el).map((r) => [r]) });
  if (t.admin_level === '6' && t.name === '惠城区') district = ringsOf(el).map((r) => [r]);
}
console.log(`街道多边形 ${areas.length} 个；惠城区整体多边形 ${district ? district.length + ' ring' : '缺失'}`);

// 边界顶点（用于最近距离）
const bkVerts = [];
areas.forEach((a) => a.polys.forEach((p) => p[0].forEach((v, i) => { if (i % 3 === 0) bkVerts.push(v); })));
const distM = (a, b) => {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const nearestBk = (lon, lat) => {
  let m = Infinity;
  for (const v of bkVerts) { const d = distM([lon, lat], v); if (d < m) m = d; }
  return m;
};
const assign = (lon, lat) => { for (const a of areas) if (inPoly(lon, lat, a.polys)) return a.name; return null; };

// ---------- 逐类量化 ----------
const SETS = [
  ['parking', 'amap_parking', '停车场'],
  ['fuel', 'amap_fuel', '加油站'],
  ['charging', 'amap_charging', '充电站'],
  ['schools', 'amap_schools', '学校'],
  ['hospitals', 'amap_hospitals', '医院'],
  ['markets', 'amap_markets', '市场'],
];
console.log('\n类别       POI   GCJ直判  纠偏后  差异  县城外  城内未归属  错分街道  距界中位(m)');
const report = {};
for (const [key, file, label] of SETS) {
  const pois = read(file).pois || [];
  let rawIn = 0, wgsIn = 0, outside = 0, insideNoStreet = 0, reassigned = 0;
  const dropped = [];
  for (const p of pois) {
    const [lon, lat] = String(p.location || '').split(',').map(Number);
    if (!isFinite(lon) || !isFinite(lat)) continue;
    const raw = assign(lon, lat);
    const [wlon, wlat] = gcj2wgs(lon, lat);
    const cor = assign(wlon, wlat);
    if (raw) rawIn++;
    if (cor) wgsIn++;
    if (!cor) {
      dropped.push([wlon, wlat]);
      if (!district || !inPoly(wlon, wlat, district)) outside++; else insideNoStreet++;
    }
    if (raw && cor && raw !== cor) reassigned++;
    if (!raw && cor) reassigned++; // 纠偏后从不计入变为计入
  }
  const ds = dropped.map(([lo, la]) => nearestBk(lo, la)).sort((a, b) => a - b);
  const med = ds.length ? Math.round(ds[Math.floor(ds.length / 2)]) : 0;
  console.log(
    label.padEnd(8),
    String(pois.length).padStart(5),
    String(rawIn).padStart(8),
    String(wgsIn).padStart(7),
    String(wgsIn - rawIn).padStart(5),
    String(outside).padStart(7),
    String(insideNoStreet).padStart(11),
    String(reassigned).padStart(9),
    String(med).padStart(11)
  );
  report[key] = { label, total: pois.length, rawIn, wgsIn, delta: wgsIn - rawIn, outside, insideNoStreet, reassigned, droppedMedM: med };
}
console.log('\n注：GCJ直判 = build_stats.js 当前做法；纠偏后 = 先做 GCJ→WGS 再判归属。');
console.log('    县城外 = 纠偏后落在惠城区整体边界之外（属邻区，剔除合理）。');
console.log('    城内未归属 = 落在惠城区内却不属任何街道多边形（真丢失）。');
fs.writeFileSync(path.join(__dirname, 'out/coord_audit.json'), JSON.stringify({
  generated: new Date().toISOString(),
  gcjOffsetSample: (() => { const [a, b] = gcj2wgs(114.4, 23.08); return { lonDeltaM: Math.round((114.4 - a) * 111320 * Math.cos(23.08 * Math.PI / 180)), latDeltaM: Math.round((23.08 - b) * 110540) }; })(),
  boroughs: areas.length, rows: report,
}, null, 2));
console.log('\n→ out/coord_audit.json 已写出');
