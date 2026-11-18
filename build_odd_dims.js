// Compute the ODD "dimension" domains that §5 ① needs beyond the four it already had
// (区域 / 道路等级 / 场景元素 / 时段).
//
// Adds four tag-derived domains that ARE mappable for vehicles, straight from the
// OSM way tags that already carry geometry (data/roads.json, 18,236 ways):
//   速度域   maxspeed  → ≤30 / 31–50 / 51–70 / >70
//   车道域   lanes     → 1 / 2 / 3 / ≥4
//   单行域   oneway    → 单向 / 双向
//   路面域   surface   → 沥青 / 混凝土 / 其他铺装 / 未铺装
//
// And records the four domains OSM simply does not populate for drivable roads
// (incline 13 / width 8 / smoothness 3 / calming 1 — all on footways/steps/paths),
// so the report can label them「数据不足 · 仅定性」instead of pretending to cover them.
//
// Everything is km-weighted on the NON-MOTORWAY centerline basis, matching the
// rest of the report (无人小车不上高速主线). Attribution to a subdistrict uses
// the way midpoint, same rule as build_stats.js.
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const OUT = path.join(__dirname, 'out');
const readRaw = (n) => JSON.parse(fs.readFileSync(path.join(DATA, n + '.json'), 'utf8'));
const els = (n) => { const j = readRaw(n); return Array.isArray(j) ? j : (j.elements || []); };

// ---------- geometry helpers (identical to build_stats.js) ----------
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInPolygon(lon, lat, polygons) {
  for (const poly of polygons) {
    if (!poly.length) continue;
    if (pointInRing(lon, lat, poly[0])) {
      let inHole = false;
      for (let h = 1; h < poly.length; h++) if (pointInRing(lon, lat, poly[h])) { inHole = true; break; }
      if (!inHole) return true;
    }
  }
  return false;
}
function dist(a, b) {
  const R = 6371008.8, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]);
  const la1 = toRad(a[1]), la2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const lineLength = (c) => { let m = 0; for (let i = 1; i < c.length; i++) m += dist(c[i - 1], c[i]); return m; };

function stitchRings(segments) {
  const pool = segments.map((s) => s.slice());
  const rings = [];
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  while (pool.length) {
    let cur = pool.shift(), extended = true;
    while (extended && !same(cur[0], cur[cur.length - 1])) {
      extended = false;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i];
        if (same(cur[cur.length - 1], s[0])) { cur = cur.concat(s.slice(1)); pool.splice(i, 1); extended = true; break; }
        if (same(cur[cur.length - 1], s[s.length - 1])) { cur = cur.concat(s.slice(0, -1).reverse()); pool.splice(i, 1); extended = true; break; }
        if (same(cur[0], s[s.length - 1])) { cur = s.slice(0, -1).concat(cur); pool.splice(i, 1); extended = true; break; }
        if (same(cur[0], s[0])) { cur = s.slice(1).reverse().concat(cur); pool.splice(i, 1); extended = true; break; }
      }
    }
    if (cur.length >= 4) rings.push(cur);
  }
  return rings;
}

const HC = new Set(els('hc_subnames').map((e) => (e.tags || {}).name).filter(Boolean));
function buildAreas() {
  const areas = [];
  for (const el of [...els('boundaries_geom'), ...els('lilin')]) {
    const t = el.tags || {};
    if (t.admin_level !== '8' || !t.name || !HC.has(t.name)) continue;
    const segs = [];
    for (const m of el.members || []) {
      if (m.type !== 'way' || !m.geometry || m.geometry.length < 2) continue;
      if (m.role === 'inner') continue;
      segs.push(m.geometry.map((p) => [p.lon, p.lat]));
    }
    const rings = stitchRings(segs);
    if (rings.length) areas.push({ name: t.name, polygons: rings.map((r) => [r]) });
  }
  return areas;
}

// ---------- tag classifiers ----------
// maxspeed may be "40", "30;50", "walk", "none", "signals", "HK:50". Take the
// highest numeric value it names; non-numeric values count as 未标注.
function speedOf(v) {
  if (v === undefined) return null;
  const nums = String(v).match(/\d+/g);
  if (!nums) return null;
  return Math.max(...nums.map(Number));
}
function speedBucket(v) {
  const n = speedOf(v);
  if (n === null) return '未标注';
  if (n <= 30) return '≤30 km/h';
  if (n <= 50) return '31–50 km/h';
  if (n <= 70) return '51–70 km/h';
  return '>70 km/h';
}
function laneBucket(v) {
  const n = v === undefined ? NaN : parseInt(String(v).match(/\d+/)?.[0] ?? '', 10);
  if (!Number.isFinite(n)) return '未标注';
  if (n <= 1) return '1 车道';
  if (n === 2) return '2 车道';
  if (n === 3) return '3 车道';
  return '≥4 车道';
}
function onewayBucket(t) {
  const v = t.oneway;
  if (v === 'yes' || v === '1' || v === '-1') return '单向（单行线）';
  if (t.junction === 'roundabout') return '单向（单行线）'; // 环岛一律单向，并入同档（全区仅 1 条）
  if (v === 'no') return '双向（明标）';
  return '未标注';
}
function surfaceBucket(v) {
  if (v === undefined) return '未标注';
  const s = String(v);
  if (s === 'asphalt') return '沥青';
  if (s === 'concrete' || s === 'concrete:plates' || s === 'cement') return '混凝土';
  if (['paved', 'paving_stones', 'sett', 'cobblestone', 'metal', 'wood'].includes(s)) return '其他铺装';
  if (['unpaved', 'gravel', 'fine_gravel', 'compacted', 'ground', 'dirt', 'earth', 'sand', 'grass'].includes(s)) return '未铺装';
  return '其他/未标注';
}
const r1 = (x) => Math.round(x * 10) / 10;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

function main() {
  const areas = buildAreas();
  const assign = (lon, lat) => {
    for (const a of areas) if (pointInPolygon(lon, lat, a.polygons)) return a.name;
    return null;
  };

  // selected road keys from the ODD selection ("name|class")
  const selKeys = new Set();
  try {
    const os = JSON.parse(fs.readFileSync(path.join(OUT, 'odd_selection.json'), 'utf8'));
    for (const arr of Object.values(os.tiers.std.byStreet || {})) for (const k of arr) selKeys.add(k);
  } catch (_) { /* not generated yet */ }

  const ROAD_CLASSES = {
    motorway: 'motorway', trunk: 'express', primary: 'arterial', secondary: 'subArterial',
    tertiary: 'collector', residential: 'local', living_street: 'local',
    unclassified: 'rural', track: 'rural', service: 'service',
  };

  const total = { km: 0, ways: 0 };
  const selTotal = { km: 0, ways: 0 };
  let unassignedKm = 0;

  const mk = (keys) => Object.fromEntries(keys.map((k) => [k, { km: 0, ways: 0, selKm: 0, selWays: 0 }]));
  const SPEED_KEYS = ['≤30 km/h', '31–50 km/h', '51–70 km/h', '>70 km/h', '未标注'];
  const LANE_KEYS = ['1 车道', '2 车道', '3 车道', '≥4 车道', '未标注'];
  const ONEWAY_KEYS = ['单向（单行线）', '双向（明标）', '未标注'];
  const SURFACE_KEYS = ['沥青', '混凝土', '其他铺装', '未铺装', '其他/未标注', '未标注'];
  const speed = mk(SPEED_KEYS), lane = mk(LANE_KEYS), oneway = mk(ONEWAY_KEYS), surface = mk(SURFACE_KEYS);
  const byStreet = {}; // street -> { speed:{...}, lane:{...} }  km only, for the per-street column
  const speedRoads = {}; // bucket -> {name, km}[]  (which roads carry each speed, top 3)

  for (const el of els('roads')) {
    const g = el.geometry;
    if (!g || g.length < 2) continue;
    const coords = g.map((p) => [p.lon, p.lat]);
    const mid = coords[Math.floor(coords.length / 2)];
    const street = assign(mid[0], mid[1]);
    const km = lineLength(coords) / 1000;
    if (!street) { unassignedKm += km; continue; }
    const t = el.tags || {};
    if (t.highway === 'motorway') continue; // 高速不进 ODD 覆盖口径

    total.km += km; total.ways++;
    const ck = ROAD_CLASSES[t.highway];
    const isSel = !!(t.name && ck && selKeys.has(`${t.name}|${ck}`));
    if (isSel) { selTotal.km += km; selTotal.ways++; }

    const bump = (bag, key) => {
      const b = bag[key];
      b.km += km; b.ways++;
      if (isSel) { b.selKm += km; b.selWays++; }
    };
    const sb = speedBucket(t.maxspeed);
    bump(speed, sb);
    bump(lane, laneBucket(t.lanes));
    bump(oneway, onewayBucket(t));
    bump(surface, surfaceBucket(t.surface));

    const st = (byStreet[street] = byStreet[street] || { name: street, km: 0, speed: {}, lane: {} });
    st.km += km;
    st.speed[sb] = (st.speed[sb] || 0) + km;
    const lb = laneBucket(t.lanes);
    st.lane[lb] = (st.lane[lb] || 0) + km;

    if (t.name && sb !== '未标注') {
      (speedRoads[sb] = speedRoads[sb] || []).push({ name: t.name, km });
    }
  }

  // collapse "其他/未标注" into 未标注 when nothing hit it (keeps the table honest
  // without inventing an empty row)
  const finish = (bag, keys) => keys
    .filter((k) => bag[k].km > 0)
    .map((k) => ({
      label: k,
      km: r1(bag[k].km),
      pct: pct(bag[k].km, total.km),
      ways: bag[k].ways,
      selKm: r1(bag[k].selKm),
      selPct: pct(bag[k].selKm, selTotal.km),
    }));

  const dim = (key, label, tag, note, bag, keys) => {
    const buckets = finish(bag, keys);
    const known = buckets.filter((b) => b.label !== '未标注' && b.label !== '其他/未标注');
    const knownKm = known.reduce((s, b) => s + b.km, 0);
    const selCovered = known.filter((b) => b.selKm > 0.5);
    return {
      key, label, tag, source: 'OSM way tag: ' + tag, note,
      totalKm: r1(total.km), knownKm: r1(knownKm), knownPct: pct(knownKm, total.km),
      unknownKm: r1(total.km - knownKm), unknownPct: pct(total.km - knownKm, total.km),
      buckets,
      bucketCount: known.length,
      selBucketCount: selCovered.length,
      selMissing: known.filter((b) => b.selKm <= 0.5).map((b) => b.label),
      status: (() => {
        const kp = pct(knownKm, total.km);
        return kp >= 50 ? 'ok' : kp >= 15 ? 'partial' : 'sparse';
      })(),
    };
  };
  const statusLabelOf = (st) => st === 'ok' ? '已覆盖' : st === 'partial' ? '部分覆盖' : '数据不足 · 仅定性';

  const dims = [
    dim('speed', '速度域（限速）', 'maxspeed', '按路段限速值分档 —— 决定「能不能跑到巡航上限 45km/h」，是 ODD 里最硬的约束之一。OSM 只对一部分道路标了限速（且以 40/60 为主），未标注的按分类参照车速参与排班。', speed, SPEED_KEYS),
    dim('lane', '车道域（车道数）', 'lanes', '按单向车道数分档 —— 决定变道/并线/窄路博弈工况的可得性。', lane, LANE_KEYS),
    dim('oneway', '单行域（单向/双向）', 'oneway', '单行线影响掉头、绕行与逆向博弈工况；未标注不等于双向，需现场确认。', oneway, ONEWAY_KEYS),
    dim('surface', '路面域（铺装类型）', 'surface', '按铺装类型分档 —— 决定颠簸/低附着工况。OSM 在惠城只标了极少部分道路，样本量最低。', surface, SURFACE_KEYS),
  ];

  // ---- domains OSM populates only on pedestrian infrastructure → not usable ----
  const probe = (n) => els(n);
  const hwOf = (list) => {
    const m = {};
    for (const e of list) { const h = (e.tags || {}).highway || '(node)'; m[h] = (m[h] || 0) + 1; }
    return m;
  };
  const inc = probe('probe_incline'), wid = probe('probe_width');
  const smo = probe('probe_smoothness'), cal = probe('traffic_calming');
  const insufficient = [
    { key: 'incline', label: '坡度域（incline）', tag: 'incline', n: inc.length, hw: hwOf(inc), source: 'OSM tag: incline' },
    { key: 'width', label: '宽度域（width）', tag: 'width', n: wid.length, hw: hwOf(wid), source: 'OSM tag: width' },
    { key: 'smoothness', label: '平整度域（smoothness）', tag: 'smoothness', n: smo.length, hw: hwOf(smo), source: 'OSM tag: smoothness' },
    { key: 'calming', label: '减速设施（traffic_calming）', tag: 'traffic_calming', n: cal.length, hw: hwOf(cal), source: 'OSM tag: traffic_calming' },
  ];

  // ---- speed: which roads carry each bucket (top-3 longest), for the report ----
  const speedRoadNames = {};
  for (const [k, arr] of Object.entries(speedRoads)) {
    const m = new Map();
    for (const x of arr) m.set(x.name, (m.get(x.name) || 0) + x.km);
    speedRoadNames[k] = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([name, km]) => ({ name, km: r1(km) }));
  }

  const streetRows = Object.values(byStreet)
    .map((s) => ({
      name: s.name,
      km: r1(s.km),
      unknownSpeedPct: pct(s.km - Object.entries(s.speed).filter(([k]) => k !== '未标注').reduce((x, [, v]) => x + v, 0), s.km),
      unknownLanePct: pct(s.km - Object.entries(s.lane).filter(([k]) => k !== '未标注').reduce((x, [, v]) => x + v, 0), s.km),
    }))
    .sort((a, b) => b.km - a.km);

  const out = {
    generated: new Date().toISOString(),
    basis: {
      source: 'data/roads.json (OSM ways with geometry + tags)',
      ways: total.ways,
      km: r1(total.km),
      note: '非高速中心线口径，与报告其余部分一致；street 归属用 way 中点（同 build_stats.js）',
      unassignedKm: r1(unassignedKm),
      unassignedNote: '未归属 = 落在惠城区 18 街道/镇多边形之外（bbox 拉到的相邻区县道路），不进任何分母',
      selectedWays: selTotal.ways,
      selectedKm: r1(selTotal.km),
      selectedNote: '选中道路按 odd_selection.json 的 byStreet 键「名称|等级」匹配',
    },
    dims,
    insufficient,
    allDims: [
      ...dims.map((d) => ({
        key: d.key, label: d.label, kind: 'tag', status: d.status, statusLabel: statusLabelOf(d.status),
        knownPct: d.knownPct, bucketCount: d.bucketCount, selBucketCount: d.selBucketCount,
        detail: `标注覆盖 ${d.knownPct}% · 选中 ${d.selBucketCount}/${d.bucketCount} 档`,
      })),
      ...insufficient.map((s) => ({
        key: s.key, label: s.label, kind: 'insufficient', status: 'sparse', statusLabel: '数据不足 · 仅定性',
        knownPct: 0, bucketCount: 0, selBucketCount: 0,
        detail: `全区仅 ${s.n} 处标注，全在 ${Object.keys(s.hw).join('/')} 上（非机动车道）`,
      })),
    ],
    summary: {
      dimsTotal: 8,
      dimsMapped: dims.length,
      dimsInsufficient: insufficient.length,
      mappedSelCover: dims.map((d) => `${d.label} ${d.selBucketCount}/${d.bucketCount}`).join(' · '),
      sparseLabel: '数据不足 · 仅定性',
    },
    byStreet: streetRows,
    speedRoads: speedRoadNames,
  };

  fs.writeFileSync(path.join(OUT, 'odd_dims.json'), JSON.stringify(out, null, 2));

  // ---------- console summary ----------
  console.log(`ODD dims basis: ${total.ways} 非高速 way · ${r1(total.km)} km（未归属 ${r1(unassignedKm)} km）`);
  console.log(`选中道路: ${selTotal.ways} way · ${r1(selTotal.km)} km\n`);
  for (const d of dims) {
    console.log(`【${d.label}】标注覆盖 ${d.knownKm}km / ${d.totalKm}km = ${d.knownPct}%  · 选中覆盖 ${d.selBucketCount}/${d.bucketCount} 档  · status=${d.status}`);
    for (const b of d.buckets) {
      console.log(`    ${b.label.padEnd(12)} ${String(b.km).padStart(8)}km ${String(b.pct).padStart(5)}%   ${b.ways} way   选中 ${b.selKm}km`);
    }
    if (d.selMissing.length) console.log(`    ⚠ 选中道路未覆盖档位: ${d.selMissing.join('、')}`);
  }
  console.log('\n【数据不足 · 仅定性】');
  for (const s of insufficient) {
    console.log(`    ${s.label.padEnd(22)} n=${s.n}  实例只落在: ${Object.entries(s.hw).map(([k, v]) => k + '×' + v).join(' ')}`);
  }
  console.log('\nwrote out/odd_dims.json');
}

main();
