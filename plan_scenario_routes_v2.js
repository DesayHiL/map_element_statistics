// 场景路线重规划 v2
// =============================================================================
// 为什么要重做：
//   v1 的场景路线是「每场景 1 条点到点」，由已废弃的 hotspot 口径挑点位；
//   plan_routes_v2.js 重规划街道级路线时，把 v1 的 scenarioRoutes **原样复制**
//   过来（见该脚本第 434-439 行），于是「场景加跑里程 = Σ场景单程 × 4」这根链条
//   一直挂着 v1 的旧点位与旧里程（Σ=67.4km → 269.6km），而空间层已经从 v1 的
//   1376km 变成 v2 的 1608.3km —— 两页排班总账因此对不上（3022 vs 3486）。
//
// 本脚本把场景路线按 v2 口径重做：
//   ① 场景 → 排名 top1 街道（复用 scenarios.js 的打分，与报告/场景页同源）
//   ② 在该街道内取该场景的**核心要素点**（不是 hotspot 名称，而是真实坐标）
//   ③ 同类点最小间距打散，限量 3~5 个，保证一条线能一趟串完
//   ④ 从基地出发，贪心最近邻 + 2-opt 消交叉
//   ⑤ Amap v3/direction/driving 实测里程（strategy=3 不走高速）
// 输出 out/scenario_routes_v2.json（与 v1 字段同构，供 plan_routes_v2 / report 引用）
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const OUT = path.join(__dirname, 'out');
const { nextKey } = require('./amap_key');
const { SCENARIOS, scenarioRank } = require('./scenarios');
const read = (n) => JSON.parse(fs.readFileSync(path.join(DATA, n + '.json'), 'utf8'));
const readOut = (n) => JSON.parse(fs.readFileSync(path.join(OUT, n + '.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = read('base');

// ---------- 坐标变换 ----------
const PI = Math.PI, A = 6378245.0, EE = 0.00669342162296594323;
function tLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  r += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
  return r;
}
function tLon(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
  return r;
}
function wgs2gcj(lon, lat) {
  let dLat = tLat(lon - 105, lat - 35), dLon = tLon(lon - 105, lat - 35);
  const radLat = (lat / 180) * PI;
  let magic = Math.sin(radLat); magic = 1 - EE * magic * magic;
  const sq = Math.sqrt(magic);
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sq)) * PI);
  dLon = (dLon * 180) / ((A / sq) * Math.cos(radLat) * PI);
  return [lon + dLon, lat + dLat];
}
function gcj2wgs(lon, lat) {
  const [gl, gt] = wgs2gcj(lon, lat);
  return [lon - (gl - lon), lat - (gt - lat)];
}
function distM(a, b) {
  const R = 6371008.8, rad = (d) => (d * PI) / 180;
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- 街道多边形（与 plan_routes_v2.js 同实现） ----------
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInPolygon(lon, lat, polygons) {
  for (const poly of polygons) {
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

// ---------- 场景 → 要素点 ----------
const RAIL_MOTORWAY_NAME = /高速|铁路|城际|高铁|京九/;
const ANCHOR_MIN_SEP = 600;   // 同类点打散间距
const MAX_PTS = 5;            // 单条场景路线点数上限（基地 + 4 站）
const ANCHOR_KD_M = 80;       // 宽凳闸门：锚点到最近宽凳路 ≤ 此值（m），与 plan_routes_v2 同口径
const KD = require('./lib_kd_cover');

function coordOf(el) {
  if (el.type === 'node') return [el.lon, el.lat];
  if (el.center) return [el.center.lon, el.center.lat];
  if (el.geometry && el.geometry.length >= 2) {
    const p = el.geometry[Math.floor(el.geometry.length / 2)];
    return [p.lon, p.lat];
  }
  return null;
}
// OSM 点（WGS-84）—— label 供报告/页面渲染「元素名（类型）」，不能省
function fromOsm(file, area, opts = {}) {
  const f = path.join(DATA, file + '.json');
  if (!fs.existsSync(f)) return [];
  const out = [];
  let anon = 0;
  for (const el of read(file).elements) {
    const realName = el.tags && el.tags.name;
    if (opts.rail && realName && RAIL_MOTORWAY_NAME.test(realName)) continue;
    const name = realName || (opts.allowUnnamed ? `${opts.label || file}${++anon}` : null);
    if (!name) continue;
    const c = coordOf(el);
    if (!c || !pointInPolygon(c[0], c[1], area.polygons)) continue;
    out.push({ name, label: opts.label || file, wgs: c });
  }
  return out;
}
// 高德点（GCJ-02 → WGS-84 存，另留 gcjNative）
function fromAmap(file, area, label) {  const f = path.join(DATA, file + '.json');
  if (!fs.existsSync(f)) return [];
  const out = [];
  for (const p of read(file).pois || []) {
    const [lon, lat] = String(p.location || '').split(',').map(Number);
    if (!isFinite(lon) || !isFinite(lat)) continue;
    if (!pointInPolygon(lon, lat, area.polygons)) continue;
    out.push({ name: p.name || file, label: label || file, wgs: gcj2wgs(lon, lat), gcjNative: [lon, lat] });
  }
  return out;
}
// 宽凳内部道路锚点（OWNER_SHIP=2 真值，WGS84）：区域内按 500m 聚类，每簇取
// 代表点（簇内最长一条路的中点），簇名 = 周边高德 POI 最近名（无则 "内部道路N"）。
const _kdInnerCache = (function () {
  const f = path.join(DATA, 'kuandeng_extra.json');
  if (!fs.existsSync(f)) return { els: [], pois: [] };
  const kd = JSON.parse(fs.readFileSync(f, 'utf8'));
  const els = (kd.elements || []).filter((e) => e.kind === 'inner_road');
  const pois = [];
  for (const file of ['amap_schools', 'amap_markets', 'amap_parking', 'amap_hospitals']) {
    const pf = path.join(DATA, file + '.json');
    if (!fs.existsSync(pf)) continue;
    for (const p of JSON.parse(fs.readFileSync(pf, 'utf8')).pois || []) {
      const [lon, lat] = String(p.location || '').split(',').map(Number);
      if (isFinite(lon) && isFinite(lat)) pois.push({ wgs: gcj2wgs(lon, lat), name: p.name || '' });
    }
  }
  return { els, pois };
})();
function fromKuandengInner(area) {
  const { els, pois } = _kdInnerCache;
  if (!els.length) return [];
  // 候选：区域内的内部道路（最长一条作簇代表）
  const cand = els.filter((e) => {
    const m = [e.pts[Math.floor(e.pts.length / 2)][0], e.pts[Math.floor(e.pts.length / 2)][1]];
    return pointInPolygon(m[0], m[1], area.polygons);
  });
  if (!cand.length) return [];
  const lenM = (P) => { let s = 0; for (let i = 1; i < P.length; i++) { const dx = (P[i][0]-P[i-1][0])*102300, dy=(P[i][1]-P[i-1][1])*111320; s += Math.hypot(dx,dy); } return s; };
  const mid = (P) => P[Math.floor(P.length / 2)];
  // 500m 聚类（并查集）
  const mids = cand.map((e) => mid(e.pts));
  const parent = mids.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let i = 0; i < mids.length; i++) for (let j = i + 1; j < mids.length; j++) {
    const dx = (mids[i][0] - mids[j][0]) * 102300, dy = (mids[i][1] - mids[j][1]) * 111320;
    if (dx * dx + dy * dy < 500 * 500) parent[find(i)] = find(j);
  }
  const clusters = new Map();
  cand.forEach((e, i) => {
    const r = find(i);
    const cl = clusters.get(r) || { best: null, bestLen: -1 };
    const L = lenM(e.pts);
    if (L > cl.bestLen) { cl.bestLen = L; cl.best = e; }
    clusters.set(r, cl);
  });
  const out = [];
  let n = 0;
  for (const cl of clusters.values()) {
    if (cl.bestLen < 60) continue;                  // 忽略碎路簇
    const m = mid(cl.best.pts);
    // 命名：最近高德 POI（≤400m）
    let name = null, bd = 400 * 400;
    for (const p of pois) {
      const dx = (p.wgs[0] - m[0]) * 102300, dy = (p.wgs[1] - m[1]) * 111320;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; name = p.name; }
    }
    out.push({ name: name || `内部道路${++n}`, label: '园区/内部道路', wgs: [m[0], m[1]] });
  }
  return out.sort((a, b) => 0);
}
// 县乡道路中点（取自 street_stats 的 roadList，已是 WGS 中点）
function ruralMids(row) {
  return (row.roadList || [])
    .filter((x) => x.cls === 'rural' && x.mid && x.km >= 0.3)
    .sort((a, b) => b.km - a.km)
    .map((x) => ({ name: x.name, label: '县乡/乡村', wgs: x.mid }));
}

// 每个场景的锚点装配（顺序即优先级；label 用于看板标签）
const SCEN_ANCHORS = {
  rural: (row, area) => [
    ...ruralMids(row).slice(0, 3),
    ...fromOsm('living_streets', area, { label: '生活街区' }).slice(0, 1),
  ],
  school: (row, area) => [
    ...fromAmap('amap_schools', area, '学校').slice(0, 3),
    ...fromOsm('crossings', area, { label: '人行横道' }).slice(0, 1),
  ],
  tunnelBridge: (row, area) => [
    ...fromOsm('tunnels', area, { rail: true, label: '隧道' }).slice(0, 2),
    ...fromOsm('bridges', area, { rail: true, label: '桥梁' }).slice(0, 2),
  ],
  tollway: (row, area) => [
    ...fromAmap('amap_tolls', area, '收费站').slice(0, 2),
    ...fromAmap('amap_service_areas', area, '服务区').slice(0, 2),
  ],
  busHub: (row, area) => [
    ...fromOsm('probe_busdepot', area, { label: '公交场站' }).slice(0, 2),
    ...fromAmap('amap_bus_stops', area, '公交站').slice(0, 2),
  ],
  uTurn: (row, area) => [
    // 2026-10-17 数据源替换：OSM roundabout（12 处）→ 宽凳 LINK_TYPE=4（真值）
    ...fromOsm('kuandeng_roundabouts', area, { label: '环岛', allowUnnamed: true }).slice(0, 2),
    ...fromOsm('probe_turning', area, { label: '调头圈', allowUnnamed: true }).slice(0, 2),
  ],
  construction: (row, area) => fromOsm('construction', area, { label: '施工路段' }).slice(0, 3),
  // 2026-10-17 新增：园区/小区内部道路场景 —— 锚点用宽凳 OWNER_SHIP=2 内部道路
  // 真值（data/kuandeng_extra.json，WGS84）。取区域内内部道路中点，按 500m 聚类
  // 区域的代表点（避免把同一个小区的几十条支路都当锚点）。
  campus: (row, area) => fromKuandengInner(area).slice(0, 3),
  // 2026-10-27 新增：低速慢行街区 —— 生活街道 + 道闸/石墩（村巷、小区出入口）
  slowPace: (row, area) => [
    ...fromOsm('living_streets', area, { label: '生活街区', allowUnnamed: true }).slice(0, 3),
    ...fromOsm('barriers', area, { label: '道闸/石墩', allowUnnamed: true }).slice(0, 2),
  ],
};

// ---------- 排序：贪心最近邻 + 2-opt（与主规划器同实现） ----------
function nnOrder(pts, startIdx) {
  const pool = pts.map((p, i) => ({ p, i }));
  const out = [];
  if (startIdx != null) {
    const k = pool.findIndex((x) => x.i === startIdx);
    if (k >= 0) out.push(pool.splice(k, 1)[0]);
  }
  if (!out.length) out.push(pool.splice(0, 1)[0]);
  while (pool.length) {
    const cur = out[out.length - 1].p;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const d = distM(cur, pool[i].p);
      if (d < bd) { bd = d; bi = i; }
    }
    out.push(pool.splice(bi, 1)[0]);
  }
  return out.map((x) => x.p);
}
function twoOpt(pts, fixFirst, fixLast, maxPass = 40) {
  const p = pts.slice();
  let improved = true, pass = 0;
  const lo = fixFirst ? 1 : 0;
  const hi = fixLast ? p.length - 1 : p.length;
  while (improved && pass++ < maxPass) {
    improved = false;
    for (let i = lo; i < hi - 1; i++) {
      for (let k = i + 1; k < hi; k++) {
        const d0 = distM(p[i - 1] ?? p[0], p[i]) + (k + 1 < p.length ? distM(p[k], p[k + 1]) : 0);
        const d1 = distM(p[i - 1] ?? p[0], p[k]) + (k + 1 < p.length ? distM(p[i], p[k + 1]) : 0);
        if (d1 < d0 - 1e-9) {
          let a = i, b = k;
          while (a < b) { const t = p[a]; p[a] = p[b]; p[b] = t; a++; b--; }
          improved = true;
        }
      }
    }
  }
  return p;
}

// ---------- Amap driving ----------
const fmt = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
async function driveRoute(origin, waypoints, dest) {
  const qs = new URLSearchParams({
    key: nextKey(), origin: fmt(origin), destination: fmt(dest),
    extensions: 'all', strategy: '3', output: 'json',
  });
  if (waypoints.length) qs.set('waypoints', waypoints.map(fmt).join(';'));
  const url = `https://restapi.amap.com/v3/direction/driving?${qs.toString()}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let j;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      j = await res.json();
    } catch (e) { await sleep(800 * (attempt + 1)); continue; }
    if (j.status === '1' && j.route && j.route.paths && j.route.paths.length) {
      const p = j.route.paths[0];
      const roads = [], poly = [];
      for (const st of p.steps || []) {
        const rn = (st.road || '').trim();
        if (rn && !roads.includes(rn)) roads.push(rn);
        // polyline: "lon,lat;..."（GCJ-02）—— 供腿级宽凳覆盖闸门评估
        for (const pair of String(st.polyline || '').split(';')) {
          const [lo, la] = pair.split(',').map(Number);
          if (isFinite(lo) && isFinite(la)) poly.push([+lo.toFixed(6), +la.toFixed(6)]);
        }
      }
      return { distKm: +(Number(p.distance) / 1000).toFixed(1), durMin: Math.round(Number(p.duration) / 60), roads: roads.slice(0, 10), poly };
    }
    if (j.infocode === '10001' || j.infocode === '10019') { console.error(`  [fatal] ${j.infocode} ${j.info}`); process.exit(1); }
    await sleep(700 * (attempt + 1));
  }
  return null;
}
function amapUri(pts) {
  const q = (p) => `${p.gcj[0].toFixed(6)},${p.gcj[1].toFixed(6)},${encodeURIComponent(p.name)}`;
  const qs = [`from=${q(pts[0])}`, `to=${q(pts[pts.length - 1])}`, 'mode=car', 'policy=3', 'coordinate=gaode', 'callnative=0', 'src=huicheng-odd'];
  if (pts.length > 2) qs.splice(2, 0, `via=${pts.slice(1, -1).map(q).join(';')}`);
  return `https://uri.amap.com/navigation?${qs.join('&')}`;
}

// ---------- main ----------
async function main() {
  const BASE_WGS = BASE.wgs || gcj2wgs(BASE.gcj[0], BASE.gcj[1]);
  const areas = buildAreas();
  const rows = readOut('street_stats');
  const areaByName = new Map(areas.map((a) => [a.name, a]));
  const rowByName = new Map(rows.map((r) => [r.name, r]));

  const out = [];
  let calls = 0;
  for (const sc of SCENARIOS) {
    const top = scenarioRank(sc, rows, 1)[0];
    if (!top) { out.push({ scenario: sc.key, label: sc.label, status: 'no-rank' }); continue; }
    const area = areaByName.get(top.r.name);
    const cands = (SCEN_ANCHORS[sc.key] ? SCEN_ANCHORS[sc.key](top.r, area) : [])
      // 宽凳闸门（2026-10-16 前移进规划器，与 plan_routes_v2 同口径）：锚点必须贴着
      // 宽凳路网，否则到它的那一段只能走宽凳没采的路。
      .filter((c) => KD.nearestDevWGS(c.wgs[0], c.wgs[1], ANCHOR_KD_M) <= ANCHOR_KD_M);
    // 打散 + 限量（基地占 1 点，锚点最多 MAX_PTS-1 个）
    const picked = [];
    for (const c of cands) {
      if (picked.length >= MAX_PTS - 1) break;
      if (picked.some((p) => distM(p.wgs, c.wgs) < ANCHOR_MIN_SEP)) continue;
      if (distM(BASE_WGS, c.wgs) < 300) continue;   // 基地自身附近不设站
      picked.push(c);
    }
    if (picked.length < 1) {
      console.log(`  [${sc.key}] ${top.r.name}: 无可用锚点`);
      out.push({ scenario: sc.key, label: sc.label, street: top.r.name, status: 'no-anchors' });
      continue;
    }
    // 基地 → 最近锚点起
    const pts = picked.map((p) => ({ ...p, gcj: p.gcjNative || wgs2gcj(p.wgs[0], p.wgs[1]) }));
    let si = 0, bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = distM(BASE_WGS, pts[i].wgs);
      if (d < bd) { bd = d; si = i; }
    }
    const ordered = twoOpt(nnOrder(pts, si), false, false);
    const anchors = [{ kind: 'base', label: '出发', name: BASE.name, gcj: BASE.gcj }, ...ordered];
    const via = ordered.slice(0, -1).map((p) => p.gcj);
    const r = await driveRoute(BASE.gcj, via, ordered[ordered.length - 1].gcj);
    calls++;
    if (!r || r.distKm < 1.5) {
      console.log(`  [${sc.key}] ${top.r.name}: 导航失败/过短`);
      out.push({ scenario: sc.key, label: sc.label, street: top.r.name, status: 'nav-failed' });
      continue;
    }
    // 腿级宽凳覆盖闸门（2026-10-19，与 plan_routes_v2 同口径 30m/25m/<50%）：
    // 场景路线全程必须贴宽凳路网（如 campus 沥林 31.3km 沿途大部分盲区 → 不排班）。
    {
      const { gcj2wgs } = require('./street_areas');
      const cov = KD.coverOfWay(r.poly.map(([lo, la]) => gcj2wgs([lo, la])), 30, 25);
      if (cov.cover < 0.5) {
        console.log(`  [${sc.key}] ${top.r.name}: 宽凳覆盖 ${(cov.cover * 100).toFixed(1)}% < 50%（${r.distKm}km 盲区）→ 场景路线不排班`);
        out.push({ scenario: sc.key, label: sc.label, street: top.r.name, status: 'kd-gap', kdCover: +cov.cover.toFixed(3) });
        continue;
      }
    }
    out.push({
      scenario: sc.key, label: sc.label, street: top.r.name, status: 'ok',
      anchors, distKm: r.distKm, durMin: r.durMin, roads: r.roads,
      uri: amapUri(anchors),
      // 兼容 v1 字段名（report_draft 用 r.street / r.distKm / r.status / r.anchors）
      street2: top.r.name,
    });
    console.log(`  [${sc.key}] ${top.r.name}: ${ordered.length} 站 · ${r.distKm}km ≈${r.durMin}min · ` +
      ordered.map((p) => p.name).join(' / '));
    await sleep(400);
  }

  const okKm = out.filter((x) => x.status === 'ok').reduce((s, x) => s + x.distKm, 0);
  fs.writeFileSync(path.join(OUT, 'scenario_routes_v2.json'), JSON.stringify({
    generated: new Date().toISOString(),
    source: 'Amap v3/direction/driving (strategy=3, 不走高速) · 场景路线重规划 v2：场景 top1 街道 + 核心要素点串联（NN+2opt）',
    scenarioRoutes: out,
  }, null, 1));

  // 同步进 routes.json（街道级重规划只产出 routes 字段，场景字段由本脚本负责）
  const rp = path.join(OUT, 'routes.json');
  if (fs.existsSync(rp)) {
    const routes = JSON.parse(fs.readFileSync(rp, 'utf8'));
    const before = (routes.scenarioRoutes || []).filter((r) => r.status === 'ok')
      .reduce((s, r) => s + (r.distKm || 0), 0);
    routes.scenarioRoutes = out;
    routes.scenarioRoutesUpdated = new Date().toISOString();
    fs.writeFileSync(rp, JSON.stringify(routes, null, 1));
    const after = out.filter((r) => r.status === 'ok').reduce((s, r) => s + r.distKm, 0);
    console.log(`  已同步 routes.json：场景路线 Σ单程 ${before.toFixed(1)}km → ${after.toFixed(1)}km`);
  } else {
    console.warn('  [warn] out/routes.json 不存在 —— 跳过同步（请先跑 plan_routes_v2.js）');
  }

  console.log(`\ndone: ${out.filter((x) => x.status === 'ok').length}/${out.length} 场景 · Σ场景单程 ${okKm.toFixed(1)}km · API ${calls} 次`);
}
main().catch((e) => { console.error(e); process.exit(1); });
