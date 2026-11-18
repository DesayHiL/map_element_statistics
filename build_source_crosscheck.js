// 来源完备度交叉验证：同一行政区、同一类别下，OSM 计数 vs 高德 POI 计数。
//
// 为什么需要：报告第 7 节的元素计数是「高德 POI + OSM」两种来源混合。
// 对 OSM 只源类，"OSM 少标了多少" 一直是未知量。本脚本把它量化 ——
// 用同区域的高德 POI 数作基准，算出 OSM/高德 的计数比。
//
// 口径：两边都只统计落在惠城区 18 个街道/镇边界内、且能归到某个街道的元素，
// 与 build_stats.js 的 assign() 完全一致（way 取几何中点）。
// 类别对应关系必须一一对齐，对不上的类别不纳入（宁缺毋滥，不做跨类别比较）。
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const OUT = path.join(__dirname, 'out');
const E = (f) => {
  const j = JSON.parse(fs.readFileSync(path.join(DATA, f + '.json'), 'utf8'));
  return Array.isArray(j) ? j : (j.elements || []);
};
const POIS = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f + '.json'), 'utf8')).pois;

// ---------- 1. 行政区（与 build_stats.js 同一套 18 街道/镇边界） ----------
const bg = JSON.parse(fs.readFileSync(path.join(DATA, 'boundaries_geom.json'), 'utf8'));
const lilin = JSON.parse(fs.readFileSync(path.join(DATA, 'lilin.json'), 'utf8'));
const hcs = new Set(E('hc_subnames').map((e) => e.tags && e.tags.name).filter(Boolean));
function stitch(segs) {
  const pool = segs.map((s) => s.slice()); const rings = [];
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
const areas = [];
for (const el of [...(bg.elements || []), ...(lilin.elements || [])]) {
  const t = el.tags || {};
  if (t.admin_level !== '8' || !t.name || !hcs.has(t.name)) continue;
  const segs = [];
  for (const m of el.members || []) {
    if (m.type !== 'way' || !m.geometry || m.geometry.length < 2 || m.role === 'inner') continue;
    segs.push(m.geometry.map((p) => [p.lon, p.lat]));
  }
  const rings = stitch(segs);
  if (rings.length) areas.push({ name: t.name, rings });
}
const pip = (x, y, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const assign = (lon, lat) => {
  for (const a of areas) if (a.rings.some((r) => pip(lon, lat, r))) return a.name;
  return null;
};

// ---------- 1b. GCJ-02 → WGS-84（高德 POI 必须纠偏后才能与本工程的 WGS-84 边界比较） ----------
// 与 build_stats.js / select_odd.js 同一实现，否则两边的归属口径会再次分叉。
function tLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return r;
}
function tLon(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return r;
}
function gcj2wgs(gcj) {
  const a = 6378245, ee = 0.00669342162296594323;
  const [lon, lat] = gcj;
  if (lat < 0.8293 || lat > 55.8293) return [lon, lat];
  let dLat = tLat(lon - 105, lat - 35), dLon = tLon(lon - 105, lat - 35);
  const radLat = (lat / 180) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sm = Math.sqrt(magic);
  dLat = (dLat * 180) / ((a * (1 - ee)) / (magic * sm) * Math.PI);
  dLon = (dLon * 180) / (a / sm * Math.cos(radLat) * Math.PI);
  return [lon * 2 - (lon + dLon), lat * 2 - (lat + dLat)];
}

// ---------- 2. 计数 ----------
// OSM 里 node 用 lon/lat，way 用 center{lon,lat}（不是 geometry —— 本工程的
// fetch_osm 只保留了 center 与 nodes 引用）。按这个顺序取点，否则 way 类要素会被整批漏掉。
const osmPoint = (el) => {
  if (el.lon != null && el.lat != null) return [el.lon, el.lat];
  if (el.center && el.center.lon != null) return [el.center.lon, el.center.lat];
  const g = el.geometry;
  if (g && g.length) { const m = g[Math.floor(g.length / 2)]; return [m.lon != null ? m.lon : m[0], m.lat != null ? m.lat : m[1]]; }
  return null;
};
const countOsm = (file, filter) => {
  let n = 0;
  for (const el of E(file)) {
    if (filter && !filter(el.tags || {})) continue;
    const p = osmPoint(el);
    if (p && assign(p[0], p[1])) n++;
  }
  return n;
};
const countAmap = (file, typePrefix) => {
  if (!fs.existsSync(path.join(DATA, file + '.json'))) return null;
  let n = 0;
  for (const p of POIS(file)) {
    if (typePrefix && !String(p.typecode || '').startsWith(typePrefix)) continue;
    const [gLon, gLat] = String(p.location || '').split(',').map(Number);
    if (!isFinite(gLon) || !isFinite(gLat)) continue;
    const [lon, lat] = gcj2wgs([gLon, gLat]); // GCJ-02 → WGS-84，同 build_stats.js
    if (assign(lon, lat)) n++;
  }
  return n;
};

// 类别对应关系：只有口径真正对得上的才纳入（宁缺毋滥，不做跨类别比较）。
// caveat 字段随行输出，报告里要一并写出，避免把近似口径说成严格等价。
const SPECS = [
  { label: '加油站', osmLbl: 'OSM amenity=fuel', osmFile: 'fuel', osmFilter: (t) => t.amenity === 'fuel', amapFile: 'amap_fuel', amapLbl: '高德 010100', amapType: null, caveat: '严格等价' },
  { label: '充电站', osmLbl: 'OSM amenity=charging_station', osmFile: 'charging', osmFilter: (t) => t.amenity === 'charging_station', amapFile: 'amap_charging', amapLbl: '高德 011100', amapType: null, caveat: '严格等价' },
  { label: '停车场', osmLbl: 'OSM amenity=parking', osmFile: 'parking', osmFilter: (t) => t.amenity === 'parking', amapFile: 'amap_parking', amapLbl: '高德 150904', amapType: null, caveat: '严格等价' },
  { label: '学校', osmLbl: 'OSM 学前~高校', osmFile: 'schools', osmFilter: (t) => ['school', 'kindergarten', 'college', 'university'].includes(t.amenity), amapFile: 'amap_schools', amapLbl: '高德 141200', amapType: null, caveat: '严格等价（两侧均含幼儿园至高校）' },
  { label: '医院/诊所', osmLbl: 'OSM hospital+clinic', osmFile: 'hospitals', osmFilter: (t) => ['hospital', 'clinic'].includes(t.amenity), amapFile: 'amap_hospitals', amapLbl: '高德 090100', amapType: '0901', caveat: '近似口径（高德侧含卫生院，OSM 侧含诊所）' },
  { label: '市场/农贸', osmLbl: 'OSM amenity=marketplace', osmFile: 'markets', osmFilter: (t) => t.amenity === 'marketplace', amapFile: 'amap_markets', amapLbl: '高德 060700', amapType: null, caveat: '口径已对齐：两侧均为综合/农贸实体市场（OSM 侧刻意不含便利店/菜店，那是另一类实体）' },
  { label: '公交站', osmLbl: 'OSM bus_stop+platform', osmFile: 'bus_stops', osmFilter: (t) => t.highway === 'bus_stop' || t.public_transport === 'platform', amapFile: 'amap_bus_stops', amapLbl: '高德 150700', amapType: null, caveat: '反例：OSM 在此类比高德更全（含对向站台，物理上确实分设）；报告保留 OSM 源' },
  // 消防/公安：本轮新纳入。OSM 侧即便补上 node 形式也仅 5 / 14 个（probe_gaps.js 实测
  // node+way+relation 全量写法结果相同），高德同口径 80 / 182 个 —— 差一个数量级，
  // OSM 在这两类上不可用，报告源已切换为高德。
  { label: '消防站', osmLbl: 'OSM amenity=fire_station', osmFile: 'probe_fire', osmFilter: (t) => t.amenity === 'fire_station', amapFile: 'amap_fire_stations', amapLbl: '高德 130504', amapType: null, caveat: '严格等价（消防机构）；OSM 严重不全，报告源已切高德' },
  { label: '派出所', osmLbl: 'OSM amenity=police', osmFile: 'probe_police', osmFilter: (t) => t.amenity === 'police', amapFile: 'amap_police_stations', amapLbl: '高德 130501', amapType: null, caveat: '近似口径（高德为公安警察，不含交警中队 130601）；OSM 严重不全，报告源已切高德' },
];

const rows = SPECS.map((s) => {
  const osmCount = countOsm(s.osmFile, s.osmFilter);
  const amapCount = countAmap(s.amapFile, s.amapType);
  return {
    label: s.label,
    osmLabel: s.osmLbl,
    amapLabel: s.amapLbl,
    osmCount,
    amapCount,
    ratio: amapCount ? +(osmCount / amapCount * 100).toFixed(0) : null,
    gap: amapCount ? amapCount - osmCount : null,
    caveat: s.caveat,
  };
});

const result = {
  generatedAt: new Date().toISOString(),
  area: `${areas.length} 个街道/镇（惠城区）`,
  note: '同一行政区内、同一类别口径的计数对比。OSM 计数偏低 = OSM 众包标注不全（不代表高德全对，只说明基准差异）。'
    + ' 反之亦然：公交站 OSM > 高德，故该类的报告源保留 OSM —— 换源是逐类判定，不是一刀切。',
  rows,
};
fs.writeFileSync(path.join(OUT, 'source_crosscheck.json'), JSON.stringify(result, null, 1));

console.log(`行政区: ${areas.length} 个街道/镇（同区域、同口径计数对比）\n`);
console.log(`${'元素类'.padEnd(12)} ${'OSM'.padStart(6)} ${'高德POI'.padStart(8)} ${'OSM/高德'.padStart(9)} ${'高德多出'.padStart(8)}  口径`);
for (const r of rows) {
  console.log(`${r.label.padEnd(12)} ${String(r.osmCount).padStart(6)} ${String(r.amapCount ?? '—').padStart(8)} ${String(r.ratio != null ? r.ratio + '%' : '—').padStart(9)} ${String(r.gap ?? '—').padStart(8)}  ${r.osmLabel} vs ${r.amapLabel}（${r.caveat}）`);
}
console.log('\nwrote out/source_crosscheck.json');
