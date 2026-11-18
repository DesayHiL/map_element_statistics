// Aggregate Huicheng road elements to the subdistrict (街道/镇) level.
//
// Why density instead of raw counts: 江北街道 is large and dense with roads, so it
// wins every raw count without being the hardest place to test. Dividing by road-km
// surfaces actual element concentration, which is what matters for ADAS scenario picking.
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const {
  read, wgs2gcj, gcj2wgs, pointInRing, pointInPolygon, loadAreas, bboxOf,
} = require('./street_areas');
const { carrierCheck, dedupeStructures } = require('./lib_carrier_filter');
const CARRIER_FILTER_KINDS = new Set(['tunnels', 'bridges']);

// haversine, metres
function dist(a, b) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const la1 = toRad(a[1]), la2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function lineLength(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += dist(coords[i - 1], coords[i]);
  return m;
}

// Equirectangular projection around lat0 → metres (accurate enough at city scale).
function project(lon, lat, lat0) {
  return [lon * 111320 * Math.cos((lat0 * Math.PI) / 180), lat * 110540];
}

// Squared distance from p to segment ab, all projected in metres.
function segDist2(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx, y = a[1] + t * dy;
  return (p[0] - x) ** 2 + (p[1] - y) ** 2;
}

// ---------- element extraction ----------
function coordOf(el) {
  if (el.type === 'node') return [el.lon, el.lat];
  if (el.center) return [el.center.lon, el.center.lat];
  return null;
}

// Roads carry full geometry (out geom), so use midpoint + true length.
function roadCoords(el) {
  if (el.geometry && el.geometry.length >= 2) return el.geometry.map((p) => [p.lon, p.lat]);
  return null;
}

const ELEMENT_SETS = [
  // ---- 2026-10-17 数据源替换：OSM → 宽凳真值（signals / roundabout）----
  // 依据 fetch_kuandeng_replacement.js + 互查验证（灯控停止线 3,632 vs OSM 1,601；
  // 宽凳环岛 488 vs OSM 12）。桥梁/隧道/天桥/道口宽凳与高德均无，暂留 OSM。
  { key: 'signals',       file: 'kuandeng_signals', label: '红绿灯(灯控路口)' },
  // 原查询 node["crossing"~...] 只命中带子标签的节点；OSM 里大量人行横道只有
  // highway=crossing。改用完整写法（probe_gaps.js 实测 256 -> 285）。
  { key: 'crossings',     file: 'crossings_full', label: '人行横道' },
  { key: 'tunnels',       file: 'tunnels',       label: '隧道' },
  { key: 'bridges',       file: 'bridges',       label: '桥梁' },
  { key: 'schools',       amap: 'amap_schools',   hotspot: true, label: '学校' },
  { key: 'hospitals',     amap: 'amap_hospitals', hotspot: true, label: '医院' },
  { key: 'markets',       amap: 'amap_markets',   hotspot: true, label: '市场' },
  { key: 'roundabout',    file: 'kuandeng_roundabouts', label: '转盘/环岛' },
  { key: 'turning',       file: 'probe_turning', label: '调头圈' },
  { key: 'busStops',      file: 'bus_stops',     label: '公交站点' },
  { key: 'busDepots',     file: 'probe_busdepot', label: '公交场站' },
  // 铁路道口实测存在"同一处标多个节点"的问题（out/railway_audit.json：129 个点
  // 最近邻间距中位 5.2m、86% 相隔 <50m），按 50m 聚类合并后再计数，否则会把
  // 一处道口当成多处独立工况（原小金口一个街道被算出 116 个）。
  { key: 'railCrossings', file: 'rail_crossings', dedupeM: 50, label: '铁路道口' },
  // 设施类元素一律取高德 POI（data/amap_*.json，fetch_amap_pois.js 一次性扫描），
  // 不用 OSM。依据：build_source_crosscheck.js 同区域同口径实测，OSM/高德 =
  //   加油站 32% · 充电站 1% · 停车场 21% · 学校 70% · 医院 22%
  // —— OSM 众包在设施类上严重不全，街道间比较会被漏标带偏。
  // `amap` = 扫描文件名；amap_roadattach 按 typecode 前缀拆收费站(1802xx)/服务区(1803xx)。
  // hotspot:true = 额外做「最近命名道路」归属，供第 3 节场景卡片给出具体地点。
  { key: 'parking',       amap: 'amap_parking',   label: '停车场' },
  { key: 'fuel',          amap: 'amap_fuel',      label: '加油站' },
  { key: 'charging',      amap: 'amap_charging',  label: '充电站' },
  { key: 'tolls',         amap: 'amap_roadattach', typecode: '1802', label: '收费站' },
  { key: 'restAreas',     amap: 'amap_roadattach', typecode: '1803', label: '服务区' },
  { key: 'construction',  file: 'construction',  label: '施工路段' },
  { key: 'barriers',      file: 'barriers',      label: '道闸/石墩' },
  { key: 'livingStreets', file: 'living_streets', label: '生活街道' },
  { key: 'pedestrian',    file: 'probe_pedestrian', label: '步行街' },
  { key: 'accessRoads',   file: 'probe_access',  label: '管制道路' },
  // 消防/公安：OSM 侧即便补上 node 形式也仅 5 / 14 个（probe_gaps.js 实测），
  // 高德同口径 80 / 182 个（typecode 130504 消防机关 / 130501 公安警察，
  // 由 probe_amap_typecode.js 核对过实际响应）。OSM 在此两类上不可用。
  { key: 'fireStations',  amap: 'amap_fire_stations',  hotspot: true, label: '消防站' },
  { key: 'policeStations', amap: 'amap_police_stations', hotspot: true, label: '派出所' },
];

// Road classification (L4 城市仿真口径: motorway excluded from the density
// denominator and kept only as a reference column; every other class counts).
const ROAD_CLASSES = [
  { key: 'motorway',    label: '高速',          match: ['motorway'] },
  { key: 'express',     label: '快速路',        match: ['trunk'] },
  { key: 'arterial',    label: '主干路',        match: ['primary'] },
  { key: 'subArterial', label: '次干路',        match: ['secondary'] },
  { key: 'collector',   label: '支路',          match: ['tertiary'] },
  { key: 'local',       label: '街巷',          match: ['residential', 'living_street'] },
  { key: 'rural',       label: '县乡/乡村道路',  match: ['unclassified', 'track'] },
  { key: 'service',     label: '内部道路',      match: ['service'] },
];
const HW_CLASS = {};
for (const c of ROAD_CLASSES) for (const hw of c.match) HW_CLASS[hw] = c.key;
// Display order for the per-street 逐路清单 (schedule deep-coverage lists).
const CLS_ORDER = { express: 0, arterial: 1, subArterial: 2, collector: 3, rural: 4, local: 5, service: 6 };

// Element kinds whose hotspot road is found by spatial match to the nearest
// named road (they are points without a road name of their own). Ways that
// carry their own name (tunnels/bridges/roundabouts) use it directly instead.
// OSM 侧的「最近命名道路」归属集合。schools 已改由高德提供（见 ELEMENT_SETS），
// 其热点归属改由该表的 hotspot:true 驱动。
const HOTSPOT_BY_MATCH = new Set(['busStops', 'busDepots', 'turning', 'construction']);
const HOTSPOT_OWN_NAME = new Set(['tunnels', 'bridges', 'roundabout']);

function main() {
  const areas = loadAreas();
  console.log(`subdistricts with polygon: ${areas.length}`);

  const stats = {};
  for (const a of areas) {
    stats[a.name] = {
      name: a.name, roadKm: 0, roadKmBidir: 0, unnamedKmBidir: 0, motorwayKm: 0, lanes: 0, oneway: 0,
      classKm: { express: 0, arterial: 0, subArterial: 0, collector: 0, local: 0, rural: 0, service: 0 },
      classKmBidir: { express: 0, arterial: 0, subArterial: 0, collector: 0, local: 0, rural: 0, service: 0 },
      _hot: {}, // elementKey -> Map(roadName -> count)
      _ruralRoads: {}, // roadName -> km (县乡路热点，按街道)
      _roads: {}, // "name|cls" -> {name, cls, km} 逐路清单（排班深度覆盖用）
      _unnamedKm: 0, // unnamed non-motorway km (清单以"无名巷道"合计出现)
    };
    for (const s of ELEMENT_SETS) stats[a.name][s.key] = 0;
  }

  const assign = (lon, lat) => {
    for (const a of areas) if (pointInPolygon(lon, lat, a.polygons)) return a.name;
    return null;
  };

  const tally = (street, key, road, n = 1) => {
    const m = (stats[street]._hot[key] = stats[street]._hot[key] || new Map());
    m.set(road, (m.get(road) || 0) + n);
  };

  // road length (density denominator = non-motorway km; motorway kept as
  // reference only) — count each way once, accumulate per class.
  let unmatchedRoadKm = 0;
  const namedRoads = []; // for nearest-road hotspot matching
  const classRoadKm = {}; // classKey -> Map(roadName -> km) for 代表道路
  for (const el of read('roads').elements) {
    const coords = roadCoords(el);
    if (!coords) continue;
    const mid = coords[Math.floor(coords.length / 2)];
    const street = assign(mid[0], mid[1]);
    const km = lineLength(coords) / 1000;
    if (!street) { unmatchedRoadKm += km; continue; }
    const rn = el.tags && el.tags.name;
    const ck = HW_CLASS[(el.tags || {}).highway || ''];
    // 双向行驶口径: 单行道/环岛单向车道跑 1 遍即全覆盖；双向道路两个方向各跑
    // 1 遍（×2）。分离式双向车道的两条单向 way 各自计 1 遍，对向已含在数据里。
    const tg = el.tags || {};
    const dirKm = (['yes', '1', '-1'].includes(tg.oneway) || tg.junction === 'roundabout') ? km : km * 2;
    if (rn && coords.length >= 2) {
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
      for (const [lo, la] of coords) {
        if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
        if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
      }
      namedRoads.push({ name: rn, coords, minLon, maxLon, minLat, maxLat });
      if (ck) {
        const m = (classRoadKm[ck] = classRoadKm[ck] || new Map());
        m.set(rn, (m.get(rn) || 0) + km);
      }
      if (ck === 'rural') stats[street]._ruralRoads[rn] = (stats[street]._ruralRoads[rn] || 0) + km;
    }
    if (ck === 'motorway') { stats[street].motorwayKm += km; continue; }
    stats[street].roadKm += km;
    stats[street].roadKmBidir += dirKm;
    if (ck) { stats[street].classKm[ck] += km; stats[street].classKmBidir[ck] += dirKm; }
    if (rn && ck) {
      const rk = `${rn}|${ck}`;
      const cur = (stats[street]._roads[rk] = stats[street]._roads[rk] || { name: rn, cls: ck, km: 0 });
      if (km > cur.km) cur.mid = mid; // representative point = midpoint of the road's longest way (coverage-route waypoint)
      cur.km += km;
    } else if (!rn) {
      stats[street]._unnamedKm += km;
      stats[street].unnamedKmBidir += dirKm;
    }
  }

  // Nearest named road within 100 m (bounds-prefiltered); powers 热点道路 columns.
  // 100m 与 select_odd.js 的 MATCH_M 同源（学校/医院 POI 常标校园中心，100m ≈ 校门口/周边）。
  const MATCH_M = 100;
  const nearestRoad = (lon, lat) => {
    const p = project(lon, lat, lat);
    let best = null, bestD = Infinity;
    for (const rd of namedRoads) {
      if (lon < rd.minLon - 0.0013 || lon > rd.maxLon + 0.0013 ||
          lat < rd.minLat - 0.0013 || lat > rd.maxLat + 0.0013) continue;
      for (let i = 1; i < rd.coords.length; i++) {
        const a = project(rd.coords[i - 1][0], rd.coords[i - 1][1], lat);
        const b = project(rd.coords[i][0], rd.coords[i][1], lat);
        const d = segDist2(p, a, b);
        if (d < bestD) { bestD = d; best = rd; }
      }
    }
    return best && bestD <= MATCH_M * MATCH_M ? best.name : null;
  };

  // 同一处被重复标注的点先按半径聚类合并（依据见 ELEMENT_SETS.railCrossings 注释
  // 与 out/railway_audit.json）—— 一处道口标 4 个节点不能算 4 个独立工况。
  const dedupe = (els, radiusM, key) => {
    const pts = els.map((el) => ({ el, c: coordOf(el) })).filter((x) => x.c);
    const used = new Array(pts.length).fill(false);
    const reps = [];
    for (let i = 0; i < pts.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      reps.push(pts[i].el);
      const stack = [i];
      while (stack.length) {
        const k = stack.pop();
        for (let j = 0; j < pts.length; j++) {
          if (used[j]) continue;
          if (dist(pts[k].c, pts[j].c) <= radiusM) { used[j] = true; stack.push(j); }
        }
      }
    }
    console.log(`  [去重] ${key}: ${pts.length} -> ${reps.length}（合并半径 ${radiusM}m）`);
    return reps;
  };

  for (const s of ELEMENT_SETS) {
    if (s.amap) continue; // Amap-sourced, counted below
    let els = s.dedupeM ? dedupe(read(s.file).elements, s.dedupeM, s.key) : read(s.file).elements;
    // 载体过滤 + 结构去重（2026-10-15 修）：OSM 的 tunnel=yes / bridge=yes 是
    // 修饰符，会贴在铁路、水道涵洞、人行道、高速主线上。统计「隧道/桥梁」若
    // 不过滤，会把铁路隧道与溪流涵洞算成 ODD 要素（实测隧道 63% / 桥梁 59% 是
    // 非 ODD 载体）。与 build_odd_quota.js 共用 lib_carrier_filter.js 同一口径。
    if (CARRIER_FILTER_KINDS.has(s.key)) {
      els = dedupeStructures(els.filter((el) => carrierCheck(el).keep), { radiusM: 50 });
    }
    for (const el of els) {
      const c = coordOf(el);
      if (!c) continue;
      const name = assign(c[0], c[1]);
      if (!name) continue;
      stats[name][s.key]++;
      if (HOTSPOT_BY_MATCH.has(s.key)) {
        const rn = nearestRoad(c[0], c[1]);
        if (rn) tally(name, s.key, rn);
      } else if (HOTSPOT_OWN_NAME.has(s.key)) {
        const rn = el.tags && el.tags.name;
        if (rn) tally(name, s.key, rn);
      }
    }
  }

  // Amap POIs carry location as "lon,lat" strings in GCJ-02 — correct to WGS-84
  // before any comparison against OSM polygons / road geometry.
  const amapPois = (file) => read(file).pois || [];
  const countAt = (loc, key, hotspot = false) => {
    const [gLon, gLat] = String(loc || '').split(',').map(Number);
    if (!isFinite(gLon) || !isFinite(gLat)) return;
    const [lon, lat] = gcj2wgs([gLon, gLat]);
    const name = assign(lon, lat);
    if (!name) return;
    stats[name][key]++;
    if (hotspot) {
      const rn = nearestRoad(lon, lat);
      if (rn) tally(name, key, rn);
    }
  };
  for (const s of ELEMENT_SETS) {
    if (!s.amap) continue;
    const pois = s.amap === 'amap_roadattach'
      ? amapPois(s.amap).filter((p) => String(p.typecode || '').startsWith(s.typecode))
      : amapPois(s.amap);
    for (const p of pois) countAt(p.location, s.key, s.hotspot === true);
  }

  // lane / oneway detail from tagged ways (midpoint)
  for (const el of read('lanes').elements) {
    const coords = roadCoords(el) || (el.center ? [[el.center.lon, el.center.lat]] : null);
    if (!coords) continue;
    const name = assign(coords[0][0], coords[0][1]);
    if (name) stats[name].lanes++;
  }
  for (const el of read('oneway').elements) {
    const coords = roadCoords(el) || (el.center ? [[el.center.lon, el.center.lat]] : null);
    if (!coords) continue;
    const name = assign(coords[0][0], coords[0][1]);
    if (name) stats[name].oneway++;
  }

  const rows = Object.values(stats)
    .filter((r) => r.roadKm > 0.5) // drop subdistricts with essentially no mapped roads
    .map((r) => {
      const total = ELEMENT_SETS.reduce((s, e) => s + r[e.key], 0);
      // 元素种类数: how many distinct element kinds exist here — variety matters
      // for ADAS test coverage more than raw volume (a street with 12 kinds of
      // elements exercises more distinct scenarios than one with 12 bridges).
      const kinds = ELEMENT_SETS.filter((e) => r[e.key] > 0).length;
      // 热点道路: top-3 roads per element kind by matched count (own-name kinds
      // count each way once), plus 县乡路 by km.
      const hotspots = {};
      for (const [k, m] of Object.entries(r._hot)) {
        hotspots[k] = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([name, n]) => ({ name, count: n }));
      }
      hotspots.ruralRoads = Object.entries(r._ruralRoads)
        .sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([name, km]) => ({ name, km: +km.toFixed(1) }));
      // 逐路清单: every named non-motorway road merged by name+class, ordered
      // class-first then km — the schedule's deep-coverage list is built from it.
      const roadList = Object.values(r._roads)
        .sort((a, b) => (CLS_ORDER[a.cls] - CLS_ORDER[b.cls]) || (b.km - a.km))
        .map((x) => ({ name: x.name, cls: x.cls, km: +x.km.toFixed(1), ...(x.mid ? { mid: [+x.mid[0].toFixed(6), +x.mid[1].toFixed(6)] } : {}) }));
      return {
        name: r.name,
        roadKm: +r.roadKm.toFixed(1),
        roadKmBidir: +r.roadKmBidir.toFixed(1),
        motorwayKm: +r.motorwayKm.toFixed(1),
        classKm: Object.fromEntries(Object.entries(r.classKm).map(([k, v]) => [k, +v.toFixed(1)])),
        classKmBidir: Object.fromEntries(Object.entries(r.classKmBidir).map(([k, v]) => [k, +v.toFixed(1)])),
        lanes: r.lanes,
        oneway: r.oneway,
        ...Object.fromEntries(ELEMENT_SETS.map((e) => [e.key, r[e.key]])),
        totalElements: total,
        elementKinds: kinds,
        signalsPerKm: +(r.signals / r.roadKm).toFixed(2),
        tunnelsPerKm: +(r.tunnels / r.roadKm).toFixed(3),
        elementsPerKm: +(total / r.roadKm).toFixed(2),
        hotspots,
        roadList,
        unnamedKm: +r._unnamedKm.toFixed(1),
        unnamedKmBidir: +r.unnamedKmBidir.toFixed(1),
      };
    })
    .sort((a, b) => b.elementsPerKm - a.elementsPerKm);

  // Per-road-class reference (out/road_classes.json): densest streets per class
  // and the longest named roads per class — powers the 按道路级别推荐 table.
  const roadClasses = ROAD_CLASSES.map((c) => {
    const key = c.key === 'motorway' ? 'motorwayKm' : c.key;
    const topStreets = rows
      .map((r) => ({ name: r.name, km: c.key === 'motorway' ? r.motorwayKm : r.classKm[c.key] }))
      .filter((x) => x.km > 0.5)
      .sort((a, b) => b.km - a.km)
      .slice(0, 3);
    const topRoads = [...(classRoadKm[c.key] || new Map()).entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([name, km]) => ({ name, km: +km.toFixed(1) }));
    return { key: c.key, label: c.label, topStreets, topRoads };
  });
  fs.writeFileSync(path.join(OUT, 'road_classes.json'), JSON.stringify(roadClasses, null, 2));

  fs.writeFileSync(path.join(OUT, 'street_stats.json'), JSON.stringify(rows, null, 2));
  console.log(`\nmatched into subdistricts; roads outside any polygon: ${unmatchedRoadKm.toFixed(1)} km`);
  console.log(`\n${'街道/镇'.padEnd(12)} ${'路km'.padStart(6)} ${'高速km'.padStart(7)} ${'快速'.padStart(6)} ${'主干'.padStart(6)} ${'次干'.padStart(6)} ${'支路'.padStart(6)} ${'街巷'.padStart(6)} ${'县乡'.padStart(6)} ${'内部'.padStart(6)} ${'元素/km'.padStart(8)}`);
  for (const r of rows) {
    const c = r.classKm;
    console.log(
      `${r.name.padEnd(12)} ${String(r.roadKm).padStart(6)} ${String(r.motorwayKm).padStart(7)} ${String(c.express).padStart(6)} ${String(c.arterial).padStart(6)} ${String(c.subArterial).padStart(6)} ${String(c.collector).padStart(6)} ${String(c.local).padStart(6)} ${String(c.rural).padStart(6)} ${String(c.service).padStart(6)} ${String(r.elementsPerKm).padStart(8)}`
    );
  }
  const kmSum = rows.reduce((s, r) => s + r.roadKm + r.motorwayKm, 0);
  const clsSum = rows.reduce((s, r) => s + Object.values(r.classKm).reduce((x, v) => x + v, 0) + r.motorwayKm, 0);
  console.log(`\nsanity: classKm sum (${clsSum.toFixed(1)}) ≈ roadKm+motorwayKm (${kmSum.toFixed(1)})`);
  const bidirSum = rows.reduce((s, r) => s + r.roadKmBidir, 0);
  const clsBidirSum = rows.reduce((s, r) => s + Object.values(r.classKmBidir).reduce((x, v) => x + v, 0), 0);
  console.log(`sanity: classKmBidir sum (${clsBidirSum.toFixed(1)}) ≈ roadKmBidir (${bidirSum.toFixed(1)})`);
  console.log(`双向行驶口径: ${bidirSum.toFixed(1)} km（中心线 ${rows.reduce((s, r) => s + r.roadKm, 0).toFixed(1)} km，单行/分离段只计 1 遍）`);
  const hotTotal = rows.reduce((s, r) => s + Object.values(r.hotspots).reduce((x, a) => x + a.length, 0), 0);
  console.log(`wrote out/street_stats.json (${rows.length} subdistricts, ${hotTotal} hotspot lists) + out/road_classes.json`);
}

main();