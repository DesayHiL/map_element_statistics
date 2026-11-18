// Select the minimal valuable ODD road set — condition coverage, not road exhaustion.
//
// 工况覆盖口径: ODD 工况 = 道路等级 × 元素类型 × 时段 × 高危点位。里程预算不再
// "把每条命名路跑一遍"，而是:
//   穷举层  稀缺高危元素（隧道/铁路道口/环岛/医院/消防/施工…全区 <50 个）→ 所在
//          道路必选，逐个点位途经;
//   统计层  常见元素（红绿灯/斑马线/公交站/学校/停车场…）→ 抽样到识别率置信度
//          n = z²p(1−p)/e²（95%CI），贪心挑"元素密度最高"的道路直到配额达标;
//   等级层  每道路等级保底代表里程（占比下限），保证各等级视觉/速度域工况都有暴露;
//   时段层  场景路线 × 时段加跑（沿用 fetch_routes 场景集）。
//
// 里程 = 选中道路双向车道 km × 导航连接系数（实测 1.26，来自全量路线集校准）。
// 输出 out/odd_selection.json: 三档（基础 ±10% / 标准 ±5% / 穷举参考）的
// 里程 ↔ 工况覆盖映射; 标准档的街道→道路清单供 fetch_routes 过滤覆盖目标。
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const OUT = path.join(__dirname, 'out');
const read = (n) => JSON.parse(fs.readFileSync(path.join(DATA, n + '.json'), 'utf8'));

// ---------- geometry helpers (same math as build_stats.js) ----------
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
function lineLength(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += dist(coords[i - 1], coords[i]);
  return m;
}
const project = (lon, lat) => [lon * 111320 * Math.cos((lat * Math.PI) / 180), lat * 110540];
function segDist2(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return (p[0] - (a[0] + t * dx)) ** 2 + (p[1] - (a[1] + t * dy)) ** 2;
}
function stitchRings(segments) {
  const pool = segments.map((s) => s.slice());
  const rings = [];
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  while (pool.length) {
    let cur = pool.shift();
    let extended = true;
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
function buildAreas() {
  const bnd = read('boundaries_geom');
  const extra = read('lilin');
  const subs = new Set(read('hc_subnames').elements.map((e) => e.tags.name).filter(Boolean));
  const areas = [];
  for (const el of [...bnd.elements, ...extra.elements]) {
    const t = el.tags || {};
    if (t.admin_level !== '8' || !t.name || !subs.has(t.name)) continue;
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

// GCJ-02 → WGS-84 approximate inverse (accurate to ~1-2 m; plenty for 80 m matching).
// forward GCJ-02 transform (standard algorithm)
function transformLat(x, y) {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  ret += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return ret;
}
function transformLon(x, y) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  ret += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return ret;
}
function wgs2gcj(wgs) {
  const a = 6378245, ee = 0.00669342162296594323;
  let [lon, lat] = wgs;
  if (lat < 0.8293 || lat > 55.8293) return [lon, lat];
  let dLat = transformLat(lon - 105, lat - 35);
  let dLon = transformLon(lon - 105, lat - 35);
  const radLat = (lat / 180) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLon = (dLon * 180) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return [lon + dLon, lat + dLat];
}
function gcj2wgs(gcj) {
  const wgs = wgs2gcj(gcj);
  return [gcj[0] * 2 - wgs[0], gcj[1] * 2 - wgs[1]];
}

// ---------- shared definitions (mirror build_stats.js) ----------
// 与 build_stats.js 的 ELEMENT_SETS 逐项一致（两份定义曾不同步：本文件长期
// 用 OSM 的学校/医院/市场，统计侧已切高德，导致选路依据与报告数字对不上）。
const ELEMENT_SETS = [
  // 2026-10-17 数据源替换：OSM → 宽凳真值（见 fetch_kuandeng_replacement.js）
  { key: 'signals',       file: 'kuandeng_signals', label: '红绿灯(灯控路口)' },
  // 原查询只命中带 crossing 子标签的节点；OSM 里大量人行横道只有 highway=crossing
  // （probe_gaps.js 实测 256 -> 285）。
  { key: 'crossings',     file: 'crossings_full', label: '人行横道' },
  { key: 'tunnels',       file: 'tunnels',       label: '隧道' },
  { key: 'bridges',       file: 'bridges',       label: '桥梁' },
  { key: 'schools',       amap: 'amap_schools',   label: '学校' },
  { key: 'hospitals',     amap: 'amap_hospitals', label: '医院' },
  { key: 'markets',       amap: 'amap_markets',   label: '市场' },
  { key: 'roundabout',    file: 'kuandeng_roundabouts', label: '转盘/环岛' },
  { key: 'turning',       file: 'probe_turning', label: '调头圈' },
  { key: 'busStops',      file: 'bus_stops',     label: '公交站点' },
  { key: 'busDepots',     file: 'probe_busdepot', label: '公交场站' },
  // 同一处道口被标成多个节点（out/railway_audit.json：最近邻间距中位 5.2m），
  // 按 50m 聚类合并，否则一处道口被当成多处独立工况。
  { key: 'railCrossings', file: 'rail_crossings', dedupeM: 50, label: '铁路道口' },
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
  // OSM 侧即便补上 node 形式也只有 5 / 14 个（probe_gaps.js 实测），高德同口径
  // 80 / 182 个（130504 消防机关 / 130501 公安警察）—— OSM 在此两类不可用。
  { key: 'fireStations',  amap: 'amap_fire_stations',  label: '消防站' },
  { key: 'policeStations', amap: 'amap_police_stations', label: '派出所' },
];
const ROAD_CLASSES = [
  { key: 'express',     label: '快速路',       match: ['trunk'] },
  { key: 'arterial',    label: '主干路',       match: ['primary'] },
  { key: 'subArterial', label: '次干路',       match: ['secondary'] },
  { key: 'collector',   label: '支路',         match: ['tertiary'] },
  { key: 'local',       label: '街巷',         match: ['residential', 'living_street'] },
  { key: 'rural',       label: '县乡/乡村道路', match: ['unclassified', 'track'] },
  { key: 'service',     label: '内部道路',     match: ['service'] },
];
const HW_CLASS = {};
for (const c of ROAD_CLASSES) for (const hw of c.match) HW_CLASS[hw] = c.key;

// 工况权重: 施工/学校/医院=高价值（行人交互+动态变化），隧道/桥梁/道口=结构高危，
// 常规统计类=1.0，纯 POI 类略低（途经即可见）。
const KIND_W = {
  construction: 2.0, schools: 1.5, hospitals: 1.5,
  tunnels: 2.0, bridges: 1.2, railCrossings: 2.0, roundabout: 1.5, turning: 1.2,
  signals: 1.0, crossings: 1.0, busStops: 1.0, busDepots: 1.2,
  parking: 0.7, fuel: 0.7, charging: 0.7, barriers: 0.8,
  livingStreets: 1.2, pedestrian: 1.2, accessRoads: 1.0,
  fireStations: 1.0, policeStations: 1.0, markets: 1.2, restAreas: 0.6, tolls: 0,
};
// 稀缺穷举线: 全区关联到命名道路的个数 < EXHAUST_MAX 的类型逐个穷举（每个都是
// 独一无二的工况样本）；收费站/服务区挂在高速口径，不参与非高速 ODD。
const EXHAUST_MAX = 50;
// 高速域（低速无人车不跑高速）+ 低速慢行街区（离主干道 100~500m，主路串联天然覆盖不到，
// 归 slowPace 场景专项补测，见 scenarios.js）——这些类只计不占空间层配额。
const SKIP_KINDS = new Set(['tolls', 'restAreas', 'livingStreets', 'barriers']);

// ---------- 宽凳约束（2026-10-16 用户明令前移进规划器）----------
// 背景：「路线规划必须按地图约束，不要再出现宽凳没有、路线却有」。根因在候选池
// ——原候选只按「命名·非高速·≥300m」，零宽凳约束，于是选中了宽凳未采的路，
// 路线几何只能画到没有路的地方。处置：候选工况道路先过一遍宽凳路网覆盖判定，
// 沿路采样点落在宽凳 30m 内的占比 < KD_COVER_MIN 者不进候选池。
// 判据放「占比」而非「单点」：宽凳会漏采一小段（路口接缝），不该因此整条路出局。
const KD = require('./lib_kd_cover');
const KD_BAND = 30;        // 采样点到最近宽凳路的距离阈值（m）
const KD_STEP = 25;        // 沿路重采样步长（m）
const KD_COVER_MIN = 0.5;  // 覆盖占比下限，低于此不进候选

// 档位: n=35 → 识别率 ±10% @95%CI（基础）; n=139 → ±5%（标准）。
// 等级保底 = max(floorMin km, floorShare × 该等级全区中心线 km)。
const TIERS = [
  { key: 'basic', label: '基础档', ci: '±10%', n: 35, floorShare: 0.10, floorMin: 10 },
  { key: 'std', label: '标准档', ci: '±5%', n: 139, floorShare: 0.15, floorMin: 15 },
];

const f1 = (x) => +x.toFixed(1);

function main() {
  const areas = buildAreas();
  const assign = (lon, lat) => {
    for (const a of areas) if (pointInPolygon(lon, lat, a.polygons)) return a.name;
    return null;
  };

  // ---- road entities: street|name|cls, km centerline + bidirectional (oneway-aware)
  // 两遍: 先聚实体（km 阈值与 roadList 同口径 —— toFixed(1) 后 ≥0.3），再把元素只
  // 关联到候选路 —— 否则穷举类元素挂在 <300m 小路上，永远差一两个无法穷举。
  const wayRecords = []; // named non-motorway ways (element-join targets)
  const ents = new Map(); // key -> entity
  for (const el of read('roads').elements) {
    const coords = el.geometry && el.geometry.length >= 2 ? el.geometry.map((p) => [p.lon, p.lat]) : null;
    if (!coords) continue;
    const mid = coords[Math.floor(coords.length / 2)];
    const street = assign(mid[0], mid[1]);
    if (!street) continue;
    const tg = el.tags || {};
    const name = tg.name;
    const cls = HW_CLASS[tg.highway || ''];
    if (!cls || !name) continue; // 高速参考口径; 无名道路不可作导航目标 → 不进候选
    const km = lineLength(coords) / 1000;
    const dirKm = (['yes', '1', '-1'].includes(tg.oneway) || tg.junction === 'roundabout') ? km : km * 2;
    const key = `${street}|${name}|${cls}`;
    const e = (ents.get(key) || { street, name, cls, key, km: 0, dirKm: 0, kdKm: 0, mid: null, bestMidKm: 0, counts: {} });
    const kdCover = KD.coverOfWay(coords, KD_BAND, KD_STEP).cover;
    e.km += km;
    e.dirKm += dirKm;
    e.kdKm += kdCover * km;
    if (km > e.bestMidKm) { e.bestMidKm = km; e.mid = mid; }
    ents.set(key, e);
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lo, la] of coords) {
      if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
      if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
    }
    wayRecords.push({ ent: key, street, name, cls, coords, minLon, maxLon, minLat, maxLat });
  }
  // 候选: km 与 roadList/fetch_routes 同口径（四舍五入到 0.1 后 ≥0.3）且有代表点
  // 2026-10-16 起再过一道宽凳覆盖闸门（见文件头 KD_* 说明）
  for (const e of ents.values()) e.kdCover = e.km > 0 ? e.kdKm / e.km : 0;
  const candAll = [...ents.values()].filter((e) => +e.km.toFixed(1) >= 0.3 && e.mid);
  const cand = candAll.filter((e) => e.kdCover >= KD_COVER_MIN);
  const kdDropped = candAll.filter((e) => e.kdCover < KD_COVER_MIN);
  const kdStat = {
    band: KD_BAND, coverMin: KD_COVER_MIN,
    candAll: candAll.length, kept: cand.length, dropped: kdDropped.length,
    dropKm: f1(kdDropped.reduce((s, e) => s + e.km, 0)),
    droppedList: kdDropped.map((e) => ({ key: e.key, km: f1(e.km), cover: +e.kdCover.toFixed(3) }))
      .sort((a, b) => b.km - a.km),
  };
  console.log(`宽凳覆盖闸门：候选 ${candAll.length} 条 → 保留 ${cand.length} · 剔除 ${kdDropped.length} 条 / ${kdStat.dropKm}km（覆盖 <${KD_COVER_MIN}）`);
  const candKeys = new Set(cand.map((e) => e.key));
  const namedWays = wayRecords.filter((w) => candKeys.has(w.ent));

  // ---- element → nearest candidate road way within 100 m (Amap POIs: GCJ-02 → WGS-84)
  // 100m 依据（2026-10-27 实测）：学校/医院 POI 标的通常是校园中心而非校门，
  // 到最近道路 p50=66m/33m、p90=171m/97m；80m 只能挂到 43% 学校，100m 达 74%。
  // 口径语义 = 「路线经过校门口/周边」即算覆盖。
  const MATCH_M = 100;
  const nearestWay = (lon, lat) => {
    const p = project(lon, lat);
    let best = null, bestD = MATCH_M * MATCH_M;
    for (const w of namedWays) {
      if (lon < w.minLon - 0.0013 || lon > w.maxLon + 0.0013 ||
          lat < w.minLat - 0.0013 || lat > w.maxLat + 0.0013) continue;
      for (let i = 1; i < w.coords.length; i++) {
        const a = project(w.coords[i - 1][0], w.coords[i - 1][1]);
        const b = project(w.coords[i][0], w.coords[i][1]);
        const d = segDist2(p, a, b);
        if (d < bestD) { bestD = d; best = w; }
      }
    }
    return best;
  };
  // 同一处被重复标注的点按半径聚类合并（依据见 ELEMENT_SETS.railCrossings 注释）
  const dedupeEls = (els, radiusM, key) => {
    const hav = (a, b) => {
      const R = (d) => (d * Math.PI) / 180;
      const dLat = R(b[1] - a[1]), dLon = R(b[0] - a[0]);
      const la1 = R(a[1]), la2 = R(b[1]);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
      return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
    };
    const pts = els
      .map((el) => ({ el, c: el.type === 'node' ? [el.lon, el.lat] : el.center ? [el.center.lon, el.center.lat] : null }))
      .filter((x) => x.c);
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
          if (hav(pts[k].c, pts[j].c) <= radiusM) { used[j] = true; stack.push(j); }
        }
      }
    }
    console.log(`  [去重] ${key}: ${pts.length} -> ${reps.length}（合并半径 ${radiusM}m）`);
    return reps;
  };
  const matchedTotal = {}; // kind -> count matched to a named road entity
  const grandTotal = {};   // kind -> count inside the 18 subdistricts (join-agnostic)
  for (const s of ELEMENT_SETS) {
    matchedTotal[s.key] = 0;
    grandTotal[s.key] = 0;
    if (SKIP_KINDS.has(s.key)) continue;
    if (s.amap) {
      const pois = s.amap === 'amap_roadattach'
        ? (read(s.amap).pois || []).filter((p) => String(p.typecode || '').startsWith(s.typecode))
        : (read(s.amap).pois || []);
      for (const p of pois) {
        const [gLon, gLat] = String(p.location || '').split(',').map(Number);
        if (!isFinite(gLon) || !isFinite(gLat)) continue;
        const [lon, lat] = gcj2wgs([gLon, gLat]);
        if (!assign(lon, lat)) continue;
        grandTotal[s.key]++;
        const w = nearestWay(lon, lat);
        if (!w) continue;
        matchedTotal[s.key]++;
        const e = ents.get(w.ent);
        if (e) e.counts[s.key] = (e.counts[s.key] || 0) + 1;
      }
    } else {
      const els = s.dedupeM ? dedupeEls(read(s.file).elements, s.dedupeM, s.key) : read(s.file).elements;
      for (const el of els) {
        const c = el.type === 'node' ? [el.lon, el.lat] : el.center ? [el.center.lon, el.center.lat] : null;
        if (!c) continue;
        if (!assign(c[0], c[1])) continue;
        grandTotal[s.key]++;
        const w = nearestWay(c[0], c[1]);
        if (!w) continue;
        matchedTotal[s.key]++;
        const e = ents.get(w.ent);
        if (e) e.counts[s.key] = (e.counts[s.key] || 0) + 1;
      }
    }
  }

  // 穷举类/统计类划分 + 配额
  const kindQuota = (n) => {
    const q = {};
    for (const s of ELEMENT_SETS) {
      if (SKIP_KINDS.has(s.key)) { q[s.key] = 0; continue; }
      q[s.key] = matchedTotal[s.key] < EXHAUST_MAX ? matchedTotal[s.key] : Math.min(n, matchedTotal[s.key]);
    }
    return q;
  };

  const classTotalKm = {};
  for (const e of cand) classTotalKm[e.cls] = (classTotalKm[e.cls] || 0) + e.km;
  const allCandKm = cand.reduce((s, e) => s + e.km, 0);
  const allCandDirKm = cand.reduce((s, e) => s + e.dirKm, 0);

  // ---- greedy selection per tier
  function select(tier) {
    const quota = kindQuota(tier.n);
    const exhaustKinds = Object.keys(quota).filter((k) => quota[k] > 0 && matchedTotal[k] < EXHAUST_MAX);
    const sampleKinds = Object.keys(quota).filter((k) => quota[k] > 0 && matchedTotal[k] >= EXHAUST_MAX);
    const sel = new Set();
    const got = {}; // kind -> selected count
    // phase 1: 穷举类所在道路必选
    for (const e of cand) {
      let need = false;
      for (const k of exhaustKinds) if ((e.counts[k] || 0) > 0) { need = true; break; }
      if (need) { sel.add(e); for (const k of exhaustKinds) got[k] = (got[k] || 0) + (e.counts[k] || 0); }
    }
    // phase 2: 统计类配额 — 按"边际配额产出 × 权重 / 双向 km"贪心
    const val = (e) => {
      let v = 0;
      for (const k of sampleKinds) {
        const rem = quota[k] - (got[k] || 0);
        if (rem > 0) v += Math.min(e.counts[k] || 0, rem) * (KIND_W[k] || 1);
      }
      return v;
    };
    let pool = cand.filter((e) => !sel.has(e) && val(e) > 0);
    while (true) {
      const shortfall = sampleKinds.some((k) => (got[k] || 0) < quota[k]);
      if (!shortfall || !pool.length) break;
      let best = null, bestScore = 0;
      for (const e of pool) {
        const s = val(e) / Math.max(e.dirKm, 0.3);
        if (s > bestScore) { bestScore = s; best = e; }
      }
      if (!best) break;
      sel.add(best);
      for (const k of sampleKinds) {
        const rem = quota[k] - (got[k] || 0);
        got[k] = (got[k] || 0) + Math.min(best.counts[k] || 0, Math.max(rem, 0));
      }
      pool = pool.filter((e) => val(e) > 0);
    }
    // phase 3: 等级保底 — 该等级未达标则按总元素价值密度补最优道路
    const classSelKm = {};
    for (const e of sel) classSelKm[e.cls] = (classSelKm[e.cls] || 0) + e.km;
    const floors = {};
    for (const c of ROAD_CLASSES) {
      // 保底不超过该等级候选总量（内部道路等命名候选本身就少）
      floors[c.key] = Math.min(classTotalKm[c.key] || 0,
        Math.max(tier.floorMin, tier.floorShare * (classTotalKm[c.key] || 0)));
      if ((classSelKm[c.key] || 0) >= floors[c.key]) continue;
      const poolC = cand
        .filter((e) => !sel.has(e) && e.cls === c.key)
        .map((e) => ({ e, s: Object.values(e.counts).reduce((a, b) => a + b, 0) / Math.max(e.km, 0.3) }))
        .sort((a, b) => b.s - a.s);
      for (const { e } of poolC) {
        if ((classSelKm[c.key] || 0) >= floors[c.key]) break;
        sel.add(e);
        classSelKm[c.key] = (classSelKm[c.key] || 0) + e.km;
        for (const k of Object.keys(quota)) got[k] = (got[k] || 0) + (e.counts[k] || 0);
      }
    }
    const selArr = [...sel];
    const kmC = selArr.reduce((s, e) => s + e.km, 0);
    const kmDir = selArr.reduce((s, e) => s + e.dirKm, 0);
    const kindCov = {};
    for (const s of ELEMENT_SETS) {
      if (SKIP_KINDS.has(s.key)) continue;
      kindCov[s.key] = {
        label: s.label, total: grandTotal[s.key], matched: matchedTotal[s.key],
        quota: quota[s.key], got: got[s.key] || 0,
        exhaust: matchedTotal[s.key] < EXHAUST_MAX,
      };
    }
    const classCov = {};
    for (const c of ROAD_CLASSES) {
      classCov[c.key] = {
        label: c.label, totalKm: f1(classTotalKm[c.key] || 0),
        floorKm: f1(floors[c.key]), selKm: f1(classSelKm[c.key] || 0),
      };
    }
    return { sel: selArr, kmC, kmDir, kindCov, classCov };
  }

  const results = {};
  for (const t of TIERS) results[t.key] = select(t);

  // ---- navigation factor + scenario layer (from current full route set)
  let skeletonKm = 0, coverKm = 0, loopKm = 0, named30Km = 0;
  try {
    const rs = JSON.parse(fs.readFileSync(path.join(OUT, 'routes.json'), 'utf8'));
    for (const st of rs.routes || []) for (const r of st.routes || []) {
      // v2 重规划后腿型统一为 loop（工况道路 + ODD 锚点一趟串完）。必须认 loop，
      // 否则 v2 路由集会被算成 0km（旧实现在此踩过：重跑一次就把预算清零）。
      // 保留 v1 的 skeleton/cover 分支以兼容旧路由集。
      if (r.kind === 'loop') loopKm += r.distKm || 0;
      else if (r.kind === 'skeleton') skeletonKm += r.distKm || 0;
      else coverKm += r.distKm || 0;
    }
    const stats = JSON.parse(fs.readFileSync(path.join(OUT, 'street_stats.json'), 'utf8'));
    named30Km = stats.reduce((s, r) => s + (r.roadList || []).filter((x) => x.mid && x.km >= 0.3).reduce((a, x) => a + x.km, 0), 0);
  } catch { /* routes.json optional */ }
  // 途经系数 = 覆盖路线实测里程 / 这些覆盖路线实际串起的道路中心线。
  // 分母必须用「覆盖路线真正串起来的那一批道路」，即标准档选中道路的中心线：
  // 已核对 routes.json 里 cover 路线的 chain，162/163 条 100% 来自标准档选中集。
  // 原实现误用「全部候选道路中心线」(named30Km ≈ 1960km) 作分母，得到的系数
  // 只有真实值的 ~1/5.7（0.19 vs 1.08），选中档的覆盖里程与总预算随之少算 ——
  // 那等于按"跑到就能覆盖"的假想效率排班。系数 >1 是合理的：串链要绕行连接。
  const selCenterKmStd = results.std ? results.std.kmC : 0;
  // v2 路由集腿型统一为 loop → 途经系数分子用 loopKm（coverKm 仅 v1 存在，
  // v2 下恒为 0 导致系数退化成 fallback 0.79 —— 2026-10-27 修正）
  const navNumKm = loopKm > 0 ? loopKm : coverKm;
  const navFactor = navNumKm > 0 && selCenterKmStd > 0 ? navNumKm / selCenterKmStd : 0.79;
  console.log(`  途经系数口径: 路线实测 ${f1(navNumKm)}km ÷ 标准档选中中心线 ${f1(selCenterKmStd)}km`
    + `（对照：全部候选中心线 ${f1(named30Km)}km → 旧口径 ${(navNumKm / (named30Km || 1)).toFixed(3)}）`);
  let scenKm = 0;
  try {
    const rs = JSON.parse(fs.readFileSync(path.join(OUT, 'routes.json'), 'utf8'));
    for (const s of rs.scenarioRoutes || []) {
      // 只排除高速场景（无人小车不上主线），与 build_report_draft.js 的
      // ALLOC_SCENARIOS 保持一致。v1 时代「乡村/县乡道路」复用街道路线、不单列，
      // v2 起它有自己的独立场景路线，因此不再排除 —— 否则两处总账会差 4×28.5km。
      if (s.scenario === 'tollway') continue;
      if (s.status && s.status !== 'ok') continue;
      scenKm += s.distKm || 0;
    }
  } catch { /* optional */ }
  // ---- 返程实测（tools/plan_return_legs.js）----
  // 2026-10-16 用户： 「正向 1244.9km，但你直接 ×2 是不对的，你也要把路线规划出来？去程和返程？」
  // ⇒ 双向不再用 2×单程 近似，改为**去程 + 返程**（返程 = 锚点链倒序后重新算路，逐腿，同 strategy=3）。
  // 需要 routes.json + scenario_routes_v2.json 先就位（跑完 plan_routes_v2 / plan_scenario_routes_v2 再跑）。
  let revStreetKm = null, scenRevKm = null, revRatio = null;
  try {
    const rr = JSON.parse(fs.readFileSync(path.join(OUT, 'route_return_legs.json'), 'utf8'));
    const T = rr.totals || {};
    if (T.streetRevKm != null && T.streetFwdKm) {
      revStreetKm = T.streetRevKm; scenRevKm = T.scenRevKm || 0;
      revRatio = revStreetKm / T.streetFwdKm;              // 返程/去程（本次实测 ≈1.018）
    }
  } catch { /* 未跑返程实测 → 退回旧口径并在下方提示 */ }
  if (revRatio == null) console.log('  ⚠ 未找到 out/route_return_legs.json → 双向仍按 2×单程 估算（请跑 tools/plan_return_legs.js）');

  const SCEN_DIRS = 2, SCEN_TIMES = 3;
  // 场景加跑 = 双向 × 3 时段 − 已含在空间层的 1 遍双向 = 2 × (去程 + 返程)
  const scenAddKm = scenRevKm != null
    ? 2 * (scenKm + scenRevKm)
    : scenKm * (SCEN_DIRS * SCEN_TIMES - 2);
  // 穷举档参考值: 全量路线集（1108 条全途经）实测**去程**里程 × 本次实测的（去程+返程）比例 + 场景层。
  // 在路线集被选择性重取后此值取不到 → 先烘焙进 odd_selection.json。
  const exhaustRouteBidir = revRatio != null ? (skeletonKm + coverKm) * (1 + revRatio) : 2 * (skeletonKm + coverKm);
  const exhaustiveRef = coverKm > 0
    ? { routeKmAll: f1(skeletonKm + coverKm), spatialKm: f1(exhaustRouteBidir),
        totalKm: Math.round(exhaustRouteBidir + scenAddKm) }
    : null;

  const tierOut = {};
  const stdKmC = results.std ? results.std.kmC : 0;
  for (const t of TIERS) {
    const r = results[t.key];
    const coverNavKm = r.kmC * navFactor;
    // 里程口径二选一：
    //   v2（loopKm>0）— 标准档路线集是实测导航里程（一趟串完工况路 + 锚点），直接采用；
    //     其余档在同一路网下按「选中道路中心线」比例缩放（跑多少路 ∝ 选中多少中心线）
    //   v1（旧格式）— 骨架里程（各档共享）+ 覆盖选中道路 × 途经系数
    const routeEst = loopKm > 0
      ? loopKm * (stdKmC > 0 ? r.kmC / stdKmC : 1)
      : skeletonKm + coverNavKm;
    // 标准档有逐腿实测返程 → 直接用 去程+实测返程（与 build_report_draft.js 同口径，
    // 消除「估算(×全局比例) vs 逐街实测」的 ±1km 漂移导致的 brief 同源护栏误报）。
    // 其余档无独立返程实测，退回比例估算。
    let spatialKm;
    if (t.key === 'std' && loopKm > 0 && revStreetKm != null) {
      spatialKm = loopKm + revStreetKm;
    } else {
      spatialKm = revRatio != null ? routeEst * (1 + revRatio) : 2 * routeEst;
    }
    tierOut[t.key] = {
      label: t.label, ci: t.ci, n: t.n, floorShare: t.floorShare, floorMin: t.floorMin,
      roads: r.sel.length,
      selCenterKm: f1(r.kmC), selBidirKm: f1(r.kmDir),
      coverNavKm: f1(coverNavKm), skeletonKm: f1(skeletonKm),
      routeEstKm: f1(routeEst),
      routeEstBasis: loopKm > 0 ? 'v2 实测 loop 路线集（非标准档按中心线比例缩放）' : 'v1 骨架 + 覆盖估算',
      spatialKm: f1(spatialKm), scenAddKm: f1(scenAddKm),
      totalKm: Math.round(spatialKm + scenAddKm),
      kindCoverage: r.kindCov, classCoverage: r.classCov,
      // routing filter for fetch_routes (street -> "name|cls" keys, exact match
      // against roadList entries so same-name different-class roads stay distinct)
      byStreet: Object.fromEntries(
        [...new Set(r.sel.map((e) => e.street))].map((s) => [s,
          r.sel.filter((e) => e.street === s).map((e) => `${e.name}|${e.cls}`)])
      ),
    };
  }

  fs.writeFileSync(path.join(OUT, 'odd_selection.json'), JSON.stringify({
    generated: new Date().toISOString(),
    method: '工况覆盖（穷举层+统计层+等级层+时段层），非空间穷举 · 候选池已过宽凳路网闸门',
    exhaustMax: EXHAUST_MAX,
    navFactor: +navFactor.toFixed(4),
    candRoads: cand.length, candCenterKm: f1(allCandKm), candBidirKm: f1(allCandDirKm),
    kdGate: kdStat,
    scenarioKm: f1(scenKm), scenDirs: SCEN_DIRS, scenTimes: SCEN_TIMES,
    exhaustiveRef, // 穷举档（全量路线集实测）参考值
    tiers: tierOut,
  }, null, 1));

  // ---- console summary
  console.log(`候选道路（≥300m 命名·非高速）: ${cand.length} 条 · 中心线 ${f1(allCandKm)}km · 双向 ${f1(allCandDirKm)}km`);
  console.log(`途经系数: ${navFactor.toFixed(3)}（路线实测 ${f1(navNumKm)}km / 其串起的选中道路中心线 ${f1(selCenterKmStd)}km）`);
  console.log(`场景层: ${f1(scenKm)}km × ${SCEN_DIRS * SCEN_TIMES - 2} = ${f1(scenAddKm)}km\n`);
  for (const t of TIERS) {
    const o = tierOut[t.key];
    console.log(`== ${o.label}（配额 n=${o.n} @${o.ci} · 等级保底 ${Math.round(t.floorShare * 100)}%/≥${t.floorMin}km）`);
    console.log(`   选中 ${o.roads} 条 · 中心线 ${o.selCenterKm}km · 双向 ${o.selBidirKm}km · 总预算 ${o.totalKm}km（空间 ${o.spatialKm} + 场景 ${o.scenAddKm}）`);
    const miss = Object.entries(o.kindCoverage).filter(([k, v]) => v.quota > 0 && v.got < v.quota);
    console.log(`   元素配额未达标: ${miss.length ? miss.map(([k, v]) => `${v.label} ${v.got}/${v.quota}`).join(', ') : '无（24/24 达标）'}`);
    const cl = Object.entries(o.classCoverage).map(([k, v]) => `${v.label} ${v.selKm}/${v.totalKm}km（保底 ${v.floorKm}）`);
    console.log(`   等级: ${cl.join(' · ')}`);
  }
}

main();
