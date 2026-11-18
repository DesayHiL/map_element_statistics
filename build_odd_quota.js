// ODD 配额达成数据 —— 逐路元素计数 + 配额对账 + 场景里程换算
// =============================================================================
// 目的：为「ODD 覆盖勾选表 + 路线×配额矩阵」和「场景测试推荐」两份 HTML 提供
//       数据层。select_odd.js 的逐路元素计数只存在于内存（odd_selection.json 只
//       存路名清单），这里重放同一套匹配逻辑（80m nearestWay + 同口径实体聚合 +
//       同一套 ELEMENT_SETS / 去重），不改变任何现有产物。
//
// 输入：data/*.json（同 select_odd.js）+ out/odd_selection.json（选中清单）
// 输出：out/odd_quota_roads.json
//   · selected[]      165 条选中道路 → {street,name,cls,km,dirKm,counts{kind:n}}
//   · streetRoutes[] 18 条街道骨架路线 → 途经道路的 counts 汇总 + 建议时段
//   · quota[]         每元素类：全区匹配数 / 选中途经数 / 配额 n / 达成率 / 置信档
//   · scenarioKm[]    每场景：配额÷密度 → 专项最小里程（换算依据）
//
// 建议时段规则（数据驱动，见 SLOTS）：
//   rural/service 路 → 日间；隧道途经路 → 日间+夜间各一轮（明暗切换）；
//   主干/次干 → 晚高峰（拥堵工况）+ 平峰各一轮；其余 → 平峰。
//   时段范围字符串取自 out/congestion_ref.json 的 bands（07:00–09:00 等），
//   晚高峰均速附实测/推断标记。
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const OUT = path.join(__dirname, 'out');
const read = (n) => JSON.parse(fs.readFileSync(path.join(DATA, n + '.json'), 'utf8'));
const readOut = (n) => JSON.parse(fs.readFileSync(path.join(OUT, n + '.json'), 'utf8'));

// 载体过滤 + 结构去重（2026-10-15 修：OSM 的 tunnel/bridge 是修饰符，会贴在
// 铁路、水道涵洞、人行道、高速上；不滤会把「途经隧道 17 个」里的铁路隧道、
// 溪流涵洞全算作测试对象。见 lib_carrier_filter.js）
const { carrierCheck, dedupeStructures } = require('./lib_carrier_filter');
// 哪些类别需要「载体过滤」：标签是修饰符、可贴任意载体
const CARRIER_FILTER_KINDS = new Set(['tunnels', 'bridges']);
// 哪些类别在载体过滤后还需「结构去重」：同一构造物被 OSM 拆成多段
const STRUCT_DEDUPE_KINDS = new Set(['tunnels', 'bridges']);
const CARRIER_AUDIT = {};

// ---------- geometry helpers (verbatim from select_odd.js) ----------
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
function transformLat(x, y) {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  ret += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return ret;
}
function transformLon(x, y) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
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

// ---------- shared definitions (verbatim from select_odd.js) ----------
const ELEMENT_SETS = [
  // ---- 2026-10-17 数据源替换：OSM 众包不可信，交通设施类全部换宽凳真值 ----
  // signals：OSM traffic_signals 1,601 个众包点 → 宽凳灯控停止线 IS_LIGHT=1（3,632 处，
  //   已验证与 NewestMap landmark.traffic_light 完全重合、覆盖更全）。
  // roundabout：OSM junction=roundabout 12 处 → 宽凳 ROAD_LINK.LINK_TYPE=4。
  // bridges/tunnels/footbridges/railCrossings：宽凳无字段、高德无图层 —— 暂保留 OSM
  //   （隧道选中路线途经 0；桥梁经载体过滤+结构去重后口径可控），待人工勘测替换。
  { key: 'signals',       file: 'kuandeng_signals', label: '红绿灯(灯控路口)' },
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
  { key: 'fireStations',  amap: 'amap_fire_stations',  label: '消防站' },
  { key: 'policeStations', amap: 'amap_police_stations', label: '派出所' },
  // 补查新增（probe_typecode_family.js 实测 typecode / OSM 标签存在性）：
  //   190306 立交桥 64 · 190310 隧道 22 · 190304/190305 高速出入口 178
  //   OSM footway+bridge 人行天桥 95
  // 立交桥/天桥属 ODD 本体（1.1 立体交叉 / 1.6 天桥），进配额；
  // 高速出入口为高速域（无人小车不上主线），只计不配额。
  { key: 'interchanges',  amap: 'amap_interchanges',  label: '立交桥' },
  { key: 'footbridges',   file: 'footbridges',        label: '人行天桥' },
  { key: 'ramps',         amap: 'amap_ramps',         label: '高速出入口' },
  // 第三数据源（宽凳高精地图真值 · 441302 惠城区）：高德开放平台无此图层、
  // OSM 无标注，但 STOPLINE 图层直接提供，且带 IS_LIGHT（是否受红绿灯控制）——
  // 正是「有灯路口停止线-信号灯距离 ≤60m」这一 ODD 项所需。见 fetch_kuandeng_stoplines.js。
  { key: 'stoplines',     file: 'kuandeng_stoplines', label: '停止线' },
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
const CLASS_LABEL = Object.fromEntries(ROAD_CLASSES.map((c) => [c.key, c.label]));
const EXHAUST_MAX = 50;
// 高速域（不跑高速）+ 低速慢行街区（主路串联覆盖不到，归 slowPace 场景专项）——只计不配额
const SKIP_KINDS = new Set(['tolls', 'restAreas', 'ramps', 'livingStreets', 'barriers']);
const TIERS = [
  { key: 'basic', label: '基础档', ci: '±10%', n: 35 },
  { key: 'std', label: '标准档', ci: '±5%', n: 139 },
];

// ---------- 建议时段（范围取自 congestion_ref.bands，不再自造） ----------
const refBands = readOut('congestion_ref').bands || [];
const bandOf = (k) => refBands.find((b) => b.key === k) || null;
function slotLabel(keys) {
  const parts = keys.map((k) => {
    const b = bandOf(k);
    return b ? `${b.label} ${b.range}` : k;
  });
  const pm = bandOf('pmPeak');
  return { slots: parts, pmKmh: pm ? pm.kmh : null, pmMode: pm ? pm.mode : null };
}

function main() {
  const oddSel = readOut('odd_selection');
  const routes = readOut('routes');
  const areas = buildAreas();
  const assign = (lon, lat) => {
    for (const a of areas) if (pointInPolygon(lon, lat, a.polygons)) return a.name;
    return null;
  };

  // ---- road entities（与 select_odd 完全同口径） ----
  const wayRecords = [];
  const ents = new Map();
  const entSegs = new Map();
  for (const el of read('roads').elements) {
    const coords = el.geometry && el.geometry.length >= 2 ? el.geometry.map((p) => [p.lon, p.lat]) : null;
    if (!coords) continue;
    const mid = coords[Math.floor(coords.length / 2)];
    const street = assign(mid[0], mid[1]);
    if (!street) continue;
    const tg = el.tags || {};
    const name = tg.name;
    const cls = HW_CLASS[tg.highway || ''];
    if (!cls || !name) continue;
    const km = lineLength(coords) / 1000;
    const dirKm = (['yes', '1', '-1'].includes(tg.oneway) || tg.junction === 'roundabout') ? km : km * 2;
    const key = `${street}|${name}|${cls}`;
    const e = (ents.get(key) || { street, name, cls, key, km: 0, dirKm: 0, mid: null, bestMidKm: 0, counts: {} });
    e.km += km;
    e.dirKm += dirKm;
    if (km > e.bestMidKm) { e.bestMidKm = km; e.mid = mid; }
    ents.set(key, e);
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lo, la] of coords) {
      if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
      if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
    }
    if (!entSegs.has(key)) entSegs.set(key, []);
    entSegs.get(key).push(coords);
    wayRecords.push({ ent: key, street, name, cls, coords, minLon, maxLon, minLat, maxLat });
  }
  const cand = [...ents.values()].filter((e) => +e.km.toFixed(1) >= 0.3 && e.mid);
  const candKeys = new Set(cand.map((e) => e.key));
  const namedWays = wayRecords.filter((w) => candKeys.has(w.ent));

  // ---- element → nearest candidate road way within 80 m ----
  const nearestWay = (lon, lat) => {
    const p = project(lon, lat);
    let best = null, bestD = 80 * 80;
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

  const matchedTotal = {};
  const grandTotal = {};
  const elPts = {};                     // 元素点（WGS）—— 供路线折线「实际途经」判定
  for (const s of ELEMENT_SETS) {
    matchedTotal[s.key] = 0;
    grandTotal[s.key] = 0;
    elPts[s.key] = [];
    // 注：SKIP_KINDS（高速域）不再跳过计数 —— 它们照常统计存量与路线途经量，
    // 只是不进配额/里程换算（scenarioKm 与 quota 展示按 SKIP 处理）。
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
        elPts[s.key].push([lon, lat]);
        const w = nearestWay(lon, lat);
        if (!w) continue;
        matchedTotal[s.key]++;
        const e = ents.get(w.ent);
        if (e) e.counts[s.key] = (e.counts[s.key] || 0) + 1;
      }
    } else {
      const raw = read(s.file).elements;
      // ---- 半径聚类去重（与 build_stats.js / select_odd.js 同口径）----
      // 2026-10-15 校准：本脚本原本定义了 dedupeEls 却从未调用，导致 railCrossings
      // 的 50m 合并在本层失效 —— 同一处铁路道口被标多个节点时，本层算 125 个，
      // 而 build_stats / select_odd 都算出 31 个（同一页面上两个「区内实例数」打架）。
      let els = s.dedupeM ? dedupeEls(raw, s.dedupeM, s.key) : raw;
      // ---- 载体过滤 + 结构去重（仅 tunnels/bridges）----
      if (CARRIER_FILTER_KINDS.has(s.key)) {
        const dropped = {};
        els = raw.filter((el) => {
          const v = carrierCheck(el);
          if (!v.keep) dropped[v.reason] = (dropped[v.reason] || 0) + 1;
          return v.keep;
        });
        const beforeDedupe = els.length;
        if (STRUCT_DEDUPE_KINDS.has(s.key)) els = dedupeStructures(els, { radiusM: 50 });
        CARRIER_AUDIT[s.key] = {
          raw: raw.length, kept: beforeDedupe, dropped, final: els.length,
          mergedByDedupe: beforeDedupe - els.length,
        };
        console.log(`  [载体过滤] ${s.label}: ${raw.length} → ${els.length}（剔除 ${raw.length - beforeDedupe} 条非 ODD 载体，`
          + `${beforeDedupe - els.length} 条同构造物合并）`);
      }
      for (const el of els) {
        const c = el.type === 'node' ? [el.lon, el.lat] : el.center ? [el.center.lon, el.center.lat] : null;
        if (!c) continue;
        if (!assign(c[0], c[1])) continue;
        grandTotal[s.key]++;
        elPts[s.key].push([c[0], c[1]]);
        const w = nearestWay(c[0], c[1]);
        if (!w) continue;
        matchedTotal[s.key]++;
        const e = ents.get(w.ent);
        if (e) e.counts[s.key] = (e.counts[s.key] || 0) + 1;
      }
    }
  }

  // ---- 选中道路（标准档 byStreet 展开）→ 逐路行 ----
  // nav：该路名全部 OSM 几何段拼接后取最长链的首尾点（wgs2gcj，供高德导航 uri）
  const navEnds = (key) => {
    const segs = entSegs.get(key) || [];
    if (!segs.length) return null;
    const chains = stitchRings(segs.map((s) => s.slice()));
    let best = null, bestLen = -1;
    for (const c of chains) { const L = lineLength(c); if (L > bestLen) { bestLen = L; best = c; } }
    if (!best) { // 拼接无链时退回最长单段
      for (const s of segs) { const L = lineLength(s); if (L > bestLen) { bestLen = L; best = s; } }
    }
    if (!best || best.length < 2) return null;
    const r6 = (x) => +x.toFixed(6);
    const f = wgs2gcj(best[0]), t = wgs2gcj(best[best.length - 1]);
    return { from: [r6(f[0]), r6(f[1])], to: [r6(t[0]), r6(t[1])] };
  };
  const byStreet = oddSel.tiers.std.byStreet;
  const selected = [];
  for (const [street, names] of Object.entries(byStreet)) {
    for (const nc of names) {
      const [name, cls] = String(nc).split('|');
      const e = ents.get(`${street}|${name}|${cls}`);
      if (!e) continue; // 不应发生；断言用
      selected.push({
        street, name, cls, clsLabel: CLASS_LABEL[cls] || cls,
        km: +e.km.toFixed(1), dirKm: +e.dirKm.toFixed(1),
        counts: Object.fromEntries(Object.entries(e.counts).map(([k, v]) => [k, v])),
        nav: navEnds(`${street}|${name}|${cls}`),
      });
    }
  }
  // 选中集的配额达成（与 select_odd 的贪心结果一致性核对口径：累计途经数）
  const selGot = {};
  for (const s of ELEMENT_SETS) selGot[s.key] = 0;
  for (const r of selected) for (const [k, v] of Object.entries(r.counts)) selGot[k] += v;

  // ---- 每类配额对账 ----
  const quota = ELEMENT_SETS.map((s) => {
    // 配额不得超过「可排班面」matched：区内实例再多，只要不在候选命名道路
    // （≥300m · 非高速）80m 内，排班就到不了。2026-10-15 校准：原写法在
    // matched 落在 [EXHAUST_MAX, 139) 区间时会把配额报成 139 —— 例如载体过滤后
    // 隧道 matched=55，B 区却印「该选 139」，与报告 ODD 表的「配额 ≥55」打架。
    // 改为 min(档位 n, matched)，与 select_odd.js 的 quota 口径完全一致。
    const nStd = Math.min(TIERS[1].n, matchedTotal[s.key]);
    const nBasic = Math.min(TIERS[0].n, matchedTotal[s.key]);
    const got = selGot[s.key];
    const exhaustive = matchedTotal[s.key] < EXHAUST_MAX;
    const need = Math.min(nStd, matchedTotal[s.key]);
    const ci = got >= need ? (exhaustive ? '穷举（100%）' : TIERS[1].ci)
      : got >= Math.min(nBasic, matchedTotal[s.key]) ? TIERS[0].ci : '不足';
    return {
      key: s.key, label: s.label,
      districtTotal: grandTotal[s.key], matched: matchedTotal[s.key],
      quotaStd: nStd, quotaBasic: nBasic, selectedGot: got,
      exhaustive,
      ci, ratio: matchedTotal[s.key] > 0 ? +(got / matchedTotal[s.key]).toFixed(2) : 0,
    };
  });

  // ---- 18 街道骨架路线 → 途经 counts 汇总 + 建议时段 ----
  const streetRoutes = [];
  for (const rt of routes.routes) {
    if (rt.status !== 'ok') continue;
    for (const leg of rt.routes || []) {
      const agg = {};
      const usedRoads = [];
      for (const rn of leg.roads || []) {
        // 口径：按导航道路名匹配实体（同名跨等级合并；路线本身跨街道，
        // 不限定 street —— 导航 step 的路名即实际途经道路的全称）
        const hits = [...ents.values()].filter((e) => e.name === rn);
        if (!hits.length) continue;
        usedRoads.push(rn);
        for (const h of hits) for (const [k, v] of Object.entries(h.counts)) agg[k] = (agg[k] || 0) + v;
      }
      // 建议时段：按途经元素与街道路网构成判定
      const ruralLike = usedRoads.some((rn) => [...ents.values()].some((e) => e.name === rn && (e.cls === 'rural' || e.cls === 'service')));
      const hasTunnel = (agg.tunnels || 0) > 0;
      const isCore = ['桥东街道', '桥西街道', '江北街道', '河南岸街道', '龙丰街道', '江南街道', '惠环街道'].includes(rt.street);
      let slotKeys;
      if (hasTunnel) slotKeys = ['daytime', 'night'];
      else if (ruralLike) slotKeys = ['daytime'];
      else if (isCore) slotKeys = ['pmPeak', 'daytime'];
      else slotKeys = ['daytime'];
      streetRoutes.push({
        street: rt.street, kind: leg.kind, distKm: leg.distKm, durMin: leg.durMin,
        roadsN: usedRoads.length, counts: agg,
        uri: leg.uri || null,
        slot: slotLabel(slotKeys),
        slotKeys,
      });
    }
  }

  // ---- 路线级「实际途经」统计：按 Amap 导航折线几何判定，而非按路名猜测 ----
  // 口径：route poly 为 GCJ-02 → 转 WGS；折线先按 ≤40m 加密（AMap step 端点可能
  // 相隔很远，直接点距会漏判），元素点到折线 ≤PASS_M 即计为该路线途经。
  // 这样「路线旁 红绿灯 24/139」这类标签是几何实测值，不是路名匹配值。
  // 学校/医院按「路过大门/周边」口径 100m（与 select_odd MATCH_M=100 同源：
  // POI 标校园中心，p50 距路 66m/33m，60m 只能挂 43% 学校）；其余类维持 60m
  // 严格几何途经（红绿灯/停止线等贴路元素，60m 已是宽松上界）。
  const PASS_M = 60;
  const PASS_M_KIND = { schools: 100, hospitals: 100 };
  const passMOf = (kind) => PASS_M_KIND[kind] || PASS_M;
  const gcj2wgsArr = (poly) => poly.map(([lo, la]) => gcj2wgs([lo, la]));
  const densify = (pts) => {
    const out = [];
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const d = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.ceil(d / 0.0004)); // ≈40m
      for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
    }
    out.push(pts[pts.length - 1]);
    return out;
  };
  const routeStats = [];
  const routeTotals = {};            // 逐路线求和（同一元素被两条线经过会各计一次）
  const coveredIdx = {};             // 去重口径：全区被任一路线覆盖到的元素下标
  for (const s of ELEMENT_SETS) { routeTotals[s.key] = 0; coveredIdx[s.key] = new Set(); }
  for (const rt of routes.routes) {
    if (rt.status !== 'ok') continue;
    for (const leg of rt.routes || []) {
      if (!leg.poly || leg.poly.length < 2) {
        routeStats.push({ street: rt.street, distKm: leg.distKm, durMin: leg.durMin, counts: {}, passKm: 0, targets: leg.targets || null, uri: leg.uri || null, slot: slotLabel(['daytime']) });
        continue;
      }
      const line = densify(gcj2wgsArr(leg.poly));
      // 网格索引：元素点按 0.001° 分格，避免 O(元素数 × 折线点数)
      const CELL = 0.001;
      const grid = new Map();
      line.forEach((p, idx) => {
        const key = `${Math.floor(p[0] / CELL)}|${Math.floor(p[1] / CELL)}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(idx);
      });
      const nearLine = (lon, lat, m) => {
        const cx = Math.floor(lon / CELL), cy = Math.floor(lat / CELL);
        const thr = (m / 111320 / Math.cos((lat * Math.PI) / 180)) ** 2;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const arr = grid.get(`${cx + dx}|${cy + dy}`);
          if (!arr) continue;
          for (const idx of arr) {
            const d2 = (line[idx][0] - lon) ** 2 + (line[idx][1] - lat) ** 2;
            if (d2 <= thr) return true;
          }
        }
        return false;
      };
      const counts = {};
      for (const s of ELEMENT_SETS) {
        let n = 0;
        const pts = elPts[s.key];
        for (let i = 0; i < pts.length; i++) {
          if (nearLine(pts[i][0], pts[i][1], passMOf(s.key))) { n++; coveredIdx[s.key].add(i); }
        }
        if (n > 0) counts[s.key] = n;
      }
      for (const [k, v] of Object.entries(counts)) routeTotals[k] += v;

      // 建议时段：按这条线实际途经的元素与道路等级判定（同一条线可多时段）
      const kinds = new Set(Object.keys(counts));
      const clsOn = new Set((leg.clsTags || []));
      const roadCls = new Set();
      for (const t of leg.targets || []) if (t.cls) roadCls.add(t.cls);
      for (const c of clsOn) roadCls.add(c);
      let slotKeys;
      if (kinds.has('tunnels')) slotKeys = ['daytime', 'night'];            // 明暗切换
      else if (kinds.has('schools') || kinds.has('markets')) slotKeys = ['amPeak', 'daytime']; // 接送/集市
      else if (roadCls.has('rural') || roadCls.has('service')) slotKeys = ['daytime'];
      else if (roadCls.has('express') || roadCls.has('arterial') || roadCls.has('subArterial')) slotKeys = ['pmPeak', 'daytime'];
      else slotKeys = ['daytime'];
      routeStats.push({
        street: rt.street, kind: leg.kind || 'loop',
        distKm: leg.distKm, durMin: leg.durMin,
        counts, targets: leg.targets || null, chain: leg.chain || null,
        uri: leg.uri || null, slot: slotLabel(slotKeys), slotKeys,
      });
    }
  }

  // ---- 场景专项里程换算：配额 n ÷ 选中道路元素密度 ----
  // 密度 = 选中集该类途经总数 / 选中集双向总里程；所需里程 = 配额 ÷ 密度。
  // 这是「为什么 139 对应这么多 km」的换算依据，报告不再凭空给里程数。
  const selDirKm = selected.reduce((s, r) => s + r.dirKm, 0);
  const scenarioKm = ELEMENT_SETS.filter((s) => !SKIP_KINDS.has(s.key)).map((s) => {
    const got = selGot[s.key];
    const dens = selDirKm > 0 && got > 0 ? got / selDirKm : 0; // 个/km（双向）
    const need = Math.min(TIERS[1].n, matchedTotal[s.key]);
    const kmNeeded = dens > 0 ? +(need / dens).toFixed(0) : null;
    return {
      key: s.key, label: s.label,
      densityPerKm: dens > 0 ? +(dens).toFixed(3) : 0, // 个/双向km
      quota: need, kmNeeded,
      exhaustive: matchedTotal[s.key] < EXHAUST_MAX,
    };
  });

  const out = {
    generatedAt: new Date().toISOString(),
    selectedN: selected.length,
    selDirKm: +selDirKm.toFixed(1),
    selected, quota, streetRoutes, scenarioKm,
    // 重规划后按导航折线几何实测的「路线级途经量」
    routeStats,
    routeTotals,
    routeTotalsN: Object.values(routeTotals).reduce((s, v) => s + v, 0),
    // 去重口径：本排班实际覆盖到的元素个数（用于「覆盖了多少 / 还差多少」）
    routeCovered: Object.fromEntries(ELEMENT_SETS.map((s) => [s.key, coveredIdx[s.key].size])),
    passRadiusM: PASS_M,
    passRadiusKindM: PASS_M_KIND,
    // 载体过滤审计（2026-10-15）：记录每个 MODIFIER 类别剔除了哪些非 ODD 载体
    carrierAudit: CARRIER_AUDIT,
  };
  fs.writeFileSync(path.join(OUT, 'odd_quota_roads.json'), JSON.stringify(out, null, 2));
  console.log(`选中道路 ${selected.length} 条（双向 ${out.selDirKm}km）`);
  console.log(`路线级途经统计：${routeStats.length} 条路线 · 元素命中合计 ${out.routeTotalsN}（判定半径 ${PASS_M}m）`);
  for (const s of ELEMENT_SETS) {
    if (routeTotals[s.key] > 0) {
      console.log(`  ${s.label.padEnd(6)} 全区存量 ${String(grandTotal[s.key]).padStart(5)} · 路线去重覆盖 ${String(coveredIdx[s.key].size).padStart(4)} · 逐线累计 ${String(routeTotals[s.key]).padStart(4)}`);
    }
  }
  console.log('配额对账（类别 | 全区 | 关联命名路 | 选中途经 | 配额 | 置信档）:');
  for (const q of quota) {
    console.log(`  ${q.label.padEnd(6)} ${String(q.districtTotal).padStart(5)} | ${String(q.matched).padStart(5)} | ${String(q.selectedGot).padStart(5)} | ${String(q.quotaStd).padStart(4)} | ${q.ci}`);
  }
  console.log(`街道路线 ${streetRoutes.length} 条已带建议时段`);
}

main();
