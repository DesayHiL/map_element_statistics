// OSM-vs-Amap length calibration: pick named two-way roads (longest single way
// each, in-district by midpoint), route the same stretch via Amap driving API
// with via points forced onto the way, then sum only the Amap step distance
// driven on the same-named road. One-way / dual-carriageway ways are excluded
// (they make Amap loop around and inflate distance).
const fs = require('fs');
const { nextKey } = require('./amap_key');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PI = Math.PI, A = 6378245, EE = 0.00669342162296594323;
function tLat(x, y) { let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x)); r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3; r += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3; r += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3; return r; }
function tLon(x, y) { let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x)); r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3; r += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3; r += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3; return r; }
function wgs2gcj(lon, lat) { let dLat = tLat(lon - 105, lat - 35), dLon = tLon(lon - 105, lat - 35); const radLat = (lat / 180) * PI; let magic = Math.sin(radLat); magic = 1 - EE * magic * magic; const sq = Math.sqrt(magic); dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sq)) * PI); dLon = (dLon * 180) / ((A / sq) * Math.cos(radLat) * PI); return [lon + dLon, lat + dLat]; }
const hav = (a, b) => { const R = 6371000, d = PI / 180, dl = (b[0] - a[0]) * d, dt = (b[1] - a[1]) * d; const x = Math.sin(dl / 2) ** 2 + Math.cos(a[1] * d) * Math.cos(b[1] * d) * Math.sin(dt / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
const wayKm = (g) => { let m = 0; for (let i = 1; i < g.length; i++) m += hav(g[i - 1], g[i]); return m / 1000; };

// district polygons (same stitch as build_stats.js)
const bg = JSON.parse(fs.readFileSync('data/boundaries_geom.json', 'utf8'));
const lilin = JSON.parse(fs.readFileSync('data/lilin.json', 'utf8'));
const hcs = new Set(JSON.parse(fs.readFileSync('data/hc_subnames.json', 'utf8')).elements.map((e) => e.tags && e.tags.name).filter(Boolean));
function stitch(segs) { const pool = segs.map((s) => s.slice()); const rings = []; const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9; while (pool.length) { let cur = pool.shift(); let ext = true; while (ext && !same(cur[0], cur[cur.length - 1])) { ext = false; for (let i = 0; i < pool.length; i++) { const s = pool[i]; if (same(cur[cur.length - 1], s[0])) { cur = cur.concat(s.slice(1)); pool.splice(i, 1); ext = true; break; } if (same(cur[cur.length - 1], s[s.length - 1])) { cur = cur.concat(s.slice(0, -1).reverse()); pool.splice(i, 1); ext = true; break; } if (same(cur[0], s[s.length - 1])) { cur = s.slice(0, -1).concat(cur); pool.splice(i, 1); ext = true; break; } if (same(cur[0], s[0])) { cur = s.slice(1).reverse().concat(cur); pool.splice(i, 1); ext = true; break; } } } if (cur.length >= 4) rings.push(cur); } return rings; }
const areas = [];
for (const el of [...bg.elements, ...lilin.elements]) { const t = el.tags || {}; if (t.admin_level !== '8' || !t.name || !hcs.has(t.name)) continue; const segs = []; for (const m of el.members || []) { if (m.type !== 'way' || !m.geometry || m.geometry.length < 2 || m.role === 'inner') continue; segs.push(m.geometry.map((p) => [p.lon, p.lat])); } const rings = stitch(segs); if (rings.length) areas.push({ name: t.name, rings }); }
const pip = (x, y, ring) => { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside; } return inside; };
const inHC = (x, y) => areas.some((a) => a.rings.some((r) => pip(x, y, r)));

// candidate roads: longest single way per name, per class, TWO-WAY only
const HW_CLS = { trunk: '快速路', primary: '主干路', secondary: '次干路', tertiary: '支路', residential: '街巷' };
const ONEWAY = new Set(['yes', '1', '-1']);
const best = new Map(); // name|cls -> {name, cls, way}
for (const e of JSON.parse(fs.readFileSync('data/roads.json', 'utf8')).elements) {
  if (e.type !== 'way' || !e.geometry || e.geometry.length < 2) continue;
  const t = e.tags || {}; if (!t.name || !t.highway || !HW_CLS[t.highway]) continue;
  if (ONEWAY.has(t.oneway)) continue; // skip one-way & dual-carriageway halves
  if (!/[\u4e00-\u9fa5]/.test(t.name)) continue; // need CJK name for Amap matching
  const pts = e.geometry.map((p) => [p.lon, p.lat]);
  const mid = pts[Math.floor(pts.length / 2)];
  if (!inHC(mid[0], mid[1])) continue;
  const k = `${t.name}|${t.highway}`;
  const cur = best.get(k);
  if (!cur || wayKm(pts) > wayKm(cur.way)) best.set(k, { name: t.name, cls: t.highway, way: pts });
}
const byCls = {};
for (const x of best.values()) (byCls[x.cls] = byCls[x.cls] || []).push(x);
const picks = [];
// 每等级多取几条（原为 3 → 8），长度门限 1.5km → 0.8km：
// 样本量从 8 提到 40+，校核结论才有统计意义。
const PER_CLASS = 8, MIN_KM = 0.8;
for (const cls of ['trunk', 'primary', 'secondary', 'tertiary', 'residential']) {
  const list = (byCls[cls] || []).filter((x) => wayKm(x.way) >= MIN_KM).sort((a, b) => wayKm(b.way) - wayKm(a.way));
  picks.push(...list.slice(0, PER_CLASS));
}
console.log(`calibrating ${picks.length} two-way roads (longest single way per name, in-district, ≥${MIN_KM}km)`);

const fmt = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
async function driveRoute(origin, waypoints, dest) {
  const qs = new URLSearchParams({ key: nextKey(), origin: fmt(origin), destination: fmt(dest), extensions: 'all', strategy: '3', output: 'json' });
  if (waypoints.length) qs.set('waypoints', waypoints.map(fmt).join(';'));
  const res = await fetch(`https://restapi.amap.com/v3/direction/driving?${qs.toString()}`);
  const j = await res.json();
  if (j.status === '1' && j.route && j.route.paths && j.route.paths.length) {
    const p = j.route.paths[0];
    return { distKm: +(Number(p.distance) / 1000).toFixed(2), steps: (p.steps || []).map((st) => ({ road: (st.road || '').trim(), km: Number(st.distance) / 1000 })).filter((st) => st.road) };
  }
  return null;
}
// 名称匹配：高德 step.road 可能是「199县道/仍泰公路」这种斜杠拼接名，
// 且同一路在两边的命名口径不同（仍泰路 ↔ 仍泰公路）。因此
//   ① 先按 / 拆段逐段精确/包含匹配；
//   ② 再比"去后缀"归一化名（去 公路/大道/大街/路/街/巷 与 县道/乡道/省道/国道 编号段）。
const strip = (s) => String(s || '').trim()
  .replace(/^\d+(县道|乡道|省道|国道)/, '')
  .replace(/(公路|大道|大街|路|街|巷)$/, '');
const nameMatch = (rn, name) => {
  const parts = String(rn || '').split('/').map((p) => p.trim()).filter(Boolean);
  if (parts.some((p) => p === name || p.includes(name) || name.includes(p))) return true;
  const t = strip(name);
  return !!t && parts.some((p) => strip(p) === t);
};

(async () => {
  const out = [];
  for (const x of picks) {
    const w = x.way, osmKm = +wayKm(w).toFixed(2);
    // via = interior points at 1/3 and 2/3 of the way, forcing Amap onto it
    const via = [w[Math.floor(w.length / 3)], w[Math.floor((2 * w.length) / 3)]].map((p) => wgs2gcj(p[0], p[1]));
    const r = await driveRoute(wgs2gcj(w[0][0], w[0][1]), via, wgs2gcj(w[w.length - 1][0], w[w.length - 1][1]));
    if (!r) { out.push({ name: x.name, cls: HW_CLS[x.cls], osmKm, valid: false, note: 'API FAIL' }); console.log(`  ${x.name}（${HW_CLS[x.cls]}） FAIL`); await sleep(600); continue; }
    const onRoadKm = +r.steps.filter((st) => nameMatch(st.road, x.name)).reduce((s, st) => s + st.km, 0).toFixed(2);
    const onFrac = onRoadKm / r.distKm;
    const noLoop = r.distKm <= osmKm * 1.8; // >1.8x means Amap looped/detoured
    const valid = onRoadKm > 0 && onFrac >= 0.45 && noLoop;
    out.push({ name: x.name, cls: HW_CLS[x.cls], osmKm, amapKm: r.distKm, onRoadKm, onFrac: +onFrac.toFixed(2), valid, roads: [...new Set(r.steps.map((s) => s.road))].slice(0, 5).join('/') });
    console.log(`  ${x.name}（${HW_CLS[x.cls]}） OSM ${osmKm}km | 高德全程 ${r.distKm}km 其中同名道路 ${onRoadKm}km (${(onFrac * 100).toFixed(0)}%) ${valid ? '✓' : noLoop ? '【同名占比过低，弃用】' : '【高德绕路，弃用】'}`);
    await sleep(600);
  }
  const ok = out.filter((x) => x.valid);
  const q = (a, p) => {
    if (!a.length) return null;
    const i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
  };
  let summary = null;
  if (ok.length) {
    const ratios = ok.map((x) => x.onRoadKm / x.osmKm).sort((a, b) => a - b);
    const med = +q(ratios, 0.5).toFixed(3);
    const p25 = +q(ratios, 0.25).toFixed(3);
    const p75 = +q(ratios, 0.75).toFixed(3);
    summary = { n: ok.length, tried: out.length, median: med, p25, p75, min: +ratios[0].toFixed(3), max: +ratios[ratios.length - 1].toFixed(3) };
    console.log(`\n有效样本 ${ok.length}/${out.length}（${((ok.length / out.length) * 100).toFixed(0)}%）`);
    console.log(`同名道路里程比 高德/OSM：中位 ${med}，四分位 ${p25}–${p75}，范围 ${summary.min}–${summary.max}`);
    console.log(`即：中心线口径中位偏差 ${((med - 1) * 100).toFixed(1)}%，四分位区间 ${((p25 - 1) * 100).toFixed(1)}% ~ ${((p75 - 1) * 100).toFixed(1)}%`);
  } else console.log('\n无有效样本');
  fs.writeFileSync('out/osm_calibration.json', JSON.stringify({ snapshot: '2026-09-22T08:45:51Z', calibratedAt: new Date().toISOString(), summary, samples: out, medianRatio: summary ? summary.median : null }, null, 1));
  console.log('wrote out/osm_calibration.json');
})();
