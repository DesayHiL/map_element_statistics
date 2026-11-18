// 路线重规划 v2 —— 一趟串完「工况道路 + ODD 锚点」，取代 v1 的骨架/覆盖两趟。
// =============================================================================
// 为什么重规划：
//   v1 每个街道跑两趟 —— 骨架那趟扫锚点（隧道/学校/医院/市场/公交站），覆盖那趟
//   扫工况道路（odd_selection 标准档），两趟互不感知 → 回头路；
//   且 v1 锚点集只覆盖 7 类元素，ODD 元素补查后新增的立交桥/人行天桥/高速出入口
//   等没进规划。v2 把「选中工况道路 + 全部高价值锚点」合成一条目标序列，
//   贪心最近邻起序 + 2-opt 消交叉，再按 ≤12 途经点切成可导航路线。
//
// 目标集合（全部来自 out/*.json 与 data/*.json，无人工挑点）：
//   ① odd_selection 标准档选中工况道路（每街道 ~9 条，取路网中点）
//   ② ODD 元素锚点：按测试价值加权 + 最小间距打散；已落在工况道路 300m 内的
//      不再重复进点，避免为同一个元素绕两遍
//
// 输出沿用 out/routes.json 契约（street/status/routes[]/distKm/durMin/uri/scenarioRoutes），
// 仅 leg 的 kind 改为 'loop' 并新增：targets[]（这条线要覆盖什么）、chain[]、poly（GCJ 折线）。
// poly 供 build_odd_quota.js 重统计「这条路线实际途经多少元素」。
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const { nextKey } = require('./amap_key');
const read = (n) => JSON.parse(fs.readFileSync(path.join(DATA, n + '.json'), 'utf8'));
const readOut = (n) => JSON.parse(fs.readFileSync(path.join(OUT, n + '.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = read('base');
const CLASS_LABEL = {
  express: '快速路', arterial: '主干路', subArterial: '次干路', collector: '支路',
  local: '街巷', rural: '县乡/乡村', service: '内部道路',
};

// ---------- 坐标变换 ----------
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

// ---------- 街道多边形 ----------
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

// ---------- 锚点集：测试价值权重（与报告元素权重同源） ----------
// pr 越高越优先进路线；rail=true 表示需剔除铁路/高速命名（不可达 or 不在 ODD 内）
const RAIL_MOTORWAY_NAME = /高速|铁路|城际|高铁|京九/;
// OSM 侧（WGS-84）
// allowUnnamed 只对「路口类」开（环岛/调头圈本身就是道路节点，必然可驾车到达）；
// 隧道/桥梁/铁路道口/施工/天桥的无名条目在中国 OSM 里绝大多数是铁路与高速线的
// 附属设施（京港高速线、惠大铁路…），把它们当锚点会把路线拽到远郊且不可达
// —— 实测影响：三栋镇 +113km、水口街道 +103km 都来自无名隧道。
const OSM_SETS = [
  { key: 'tunnels', file: 'tunnels', label: '隧道', pr: 9, rail: true },
  { key: 'roundabout', file: 'roundabout', label: '环岛', pr: 8, allowUnnamed: true },
  { key: 'railCrossings', file: 'rail_crossings', label: '铁路道口', pr: 8 },
  { key: 'construction', file: 'construction', label: '施工路段', pr: 6 },
  { key: 'turning', file: 'probe_turning', label: '调头圈', pr: 5, allowUnnamed: true },
  { key: 'footbridges', file: 'footbridges', label: '人行天桥', pr: 5 },
  { key: 'bridges', file: 'bridges', label: '桥梁', pr: 4, rail: true },
  { key: 'busDepots', file: 'probe_busdepot', label: '公交场站', pr: 3 },
  { key: 'barriers', file: 'barriers', label: '道闸/石墩', pr: 2, allowUnnamed: true, deficit: true },
  { key: 'livingStreets', file: 'living_streets', label: '生活街道', pr: 2, allowUnnamed: true, deficit: true },
];
// 高德侧（GCJ-02；typecode 仅用于「一文件多类」）
const AMAP_SETS = [
  { key: 'schools', amap: 'amap_schools', label: '学校', pr: 7 },
  { key: 'hospitals', amap: 'amap_hospitals', label: '医院', pr: 7 },
  { key: 'interchanges', amap: 'amap_interchanges', label: '立交桥', pr: 6 },
  { key: 'markets', amap: 'amap_markets', label: '市场', pr: 4 },
  { key: 'fireStations', amap: 'amap_fire_stations', label: '消防站', pr: 3, deficit: true },
  { key: 'policeStations', amap: 'amap_police_stations', label: '派出所', pr: 3, deficit: true },
  { key: 'parking', amap: 'amap_parking', label: '停车场', pr: 2 },
  { key: 'ramps', amap: 'amap_ramps', label: '高速出入口', pr: 2 },
  { key: 'fuel', amap: 'amap_fuel', label: '加油站', pr: 2 },
  { key: 'charging', amap: 'amap_charging', label: '充电站', pr: 1 },
  { key: 'tolls', amap: 'amap_roadattach', typecode: '1802', label: '收费站', pr: 2, deficit: true },
];

// 目标点数量不是越多越好：无节制加锚点会把远郊零散点拉进来，单程里程失控
// （实测：26 点/街道 → 单程 3436km，是 v1 的 2.5 倍）。这里三条约束同时生效：
//   ① 锚点必须在工况路走廊内（否则绕远）——走廊不足时逐级放宽
//   ② 锚点数量按街道工况路规模配（路多的街道才配更多锚点）
//   ③ 切段按「直线里程预算」而非固定点数，保证单条路线不会过长
// 走廊半径是里程的主控旋钮：放到 10km 时锚点变成绕行（水口街道 84→199km），
// 收到 1.2km 后锚点基本贴着工况路，只带来顺路增量。
const MAX_ANCHORS_RICH = 10;  // 工况路 ≥6 条的街道（7→10：锚点预算饱和导致 deficit 类
                              // 轮间振荡在 25↔26/28，预算内无法同时容纳全部未达标类）
const MAX_ANCHORS_LEAN = 6;   // 工况路 <6 条（多为远郊，点位天然分散）
const CORRIDOR_M = [1200, 2500, 5000]; // 锚点到最近工况路的走廊半径（逐级放宽）
const ANCHOR_MIN_SEP = 600;   // 同类锚点打散间距
const ROAD_DEDUP_M = 250;     // 锚点距工况路中点 <250m = 顺路覆盖，不重复进点
const LEG_MAX_PTS = 9;        // 单条路线点数上限（AMap v3 途经点上限 16）
const LEG_KM_BUDGET = 16;     // 单条路线直线里程预算（km）——超了就切下一条
// 宽凳闸门（2026-10-16 用户明令前移进规划器）：锚点必须贴着宽凳路网，否则到它的
// 那一段只能走宽凳没采的路 —— 主图又会「宽凳没有、路线却有」。80m 与元素贴路口径一致。
const ANCHOR_KD_M = 80;
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

function collectOsm(areas, sets, dynDeficit) {
  const by = new Map(areas.map((a) => [a.name, []]));
  for (const s of sets) {
    const file = path.join(DATA, s.file + '.json');
    if (!fs.existsSync(file)) continue;
    let anon = 0;
    for (const el of read(s.file).elements) {
      const realName = el.tags && el.tags.name;
      if (s.rail && realName && RAIL_MOTORWAY_NAME.test(realName)) continue;
      const name = realName || (s.allowUnnamed ? `${s.label}${++anon}` : null);
      if (!name) continue;
      const c = coordOf(el);
      if (!c) continue;
      for (const a of areas) {
        if (pointInPolygon(c[0], c[1], a.polygons)) {
          by.get(a.name).push({ kind: s.key, label: s.label, pr: s.pr, deficit: dynDeficit ? dynDeficit.has(s.key) : !!s.deficit, name, key: realName || `${s.label}-${el.type}${el.id}`, wgs: c });
          break;
        }
      }
    }
  }
  return by;
}
function collectAmap(areas, sets, dynDeficit) {
  const by = new Map(areas.map((a) => [a.name, []]));
  for (const s of sets) {
    const file = path.join(DATA, s.amap + '.json');
    if (!fs.existsSync(file)) continue;
    const pois = (read(s.amap).pois || []).filter((p) => !s.typecode || String(p.typecode || '').startsWith(s.typecode));
    pois.forEach((p, i) => {
      const [lon, lat] = String(p.location || '').split(',').map(Number);
      if (!isFinite(lon) || !isFinite(lat)) return;
      for (const a of areas) {
        if (pointInPolygon(lon, lat, a.polygons)) {
          by.get(a.name).push({
            kind: s.key, label: s.label, pr: s.pr, deficit: dynDeficit ? dynDeficit.has(s.key) : !!s.deficit, name: p.name || s.label,
            key: p.name || `${s.label}-${i}`, wgs: gcj2wgs(lon, lat), gcjNative: [lon, lat],
          });
          break;
        }
      }
    });
  }
  return by;
}

// ---------- 排序：贪心最近邻 + 2-opt ----------
// ⚠ 2026-10-28 复核结论：这三个函数收到的是 target 对象（{kind,wgs,...}），
//   内部 distM(a,b) 按数组下标取值 → NaN → 排序/2-opt 实际不生效。
//   **这是刻意保留的行为，不要「修」**：站序 = 候选按 ODD 优先级 pr 排出的顺序，
//   折返是为了途经 ODD 元素点位（学校/红绿灯/隧道等锚点），里程不是目标函数。
//   曾经尝试改成「地理最优站序」→ 站间直线里程省 33%，但会打乱 ODD 覆盖顺序、
//   使交付图与平台路线全部失效（用户明确：不能与现有高德图偏差变大）。
//   若将来要真正优化顺序，必须把「ODD 元素覆盖达标」作为约束而不是里程。
function nnOrder(pts, startIdx) {
  const pool = pts.map((p, i) => ({ p, i }));
  const start = startIdx == null ? -1 : startIdx;
  const out = [];
  if (start >= 0) {
    const k = pool.findIndex((x) => x.i === start);
    if (k >= 0) out.push(pool.splice(k, 1)[0]);
  }
  // 起点：若未指定，从最北点起（配合 2-opt，初值影响很小）
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
function pathLen(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += distM(pts[i - 1], pts[i]);
  return s;
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
        // 反转 i..k 是否更短（端点固定的开放路径）
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
        // polyline: "lon,lat;lon,lat;..."（GCJ-02）
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

async function main() {
  // 每天 07:00 从基地发车 → 路线1 起点取离基地最近的目标点
  const BASE_WGS = BASE.wgs || gcj2wgs(BASE.gcj[0], BASE.gcj[1]);
  const areas = buildAreas();
  const streetRows = readOut('street_stats');
  const statsByName = new Map(streetRows.map((r) => [r.name, r]));
  const oddSel = readOut('odd_selection').tiers.std;

  // 动态 deficit：读上一轮 element_route_coverage.json，凡「路线途经未达配额」的类
  // （如 schools/hospitals/construction）本轮提权 pr+5 优先锚定——与静态 deficit 同机制。
  // 累积式：未达标类一旦进入集合就保留（记在 out/dyn_deficit.json），直到最终达标，
  // 避免轮间「按下葫芦浮起瓢」（A 轮提权挤掉 B，B 轮提权又挤回 A）。
  // 循环依赖说明：路线未规划时该文件不存在，退化为静态 OSM_SETS/AMAP_SETS 的 deficit 标记。
  let dynDeficit = null;
  try {
    const cov = readOut('element_route_coverage');
    const accFile = path.join(OUT, 'dyn_deficit.json');
    let acc = [];
    try { acc = JSON.parse(fs.readFileSync(accFile, 'utf8')); } catch { /* 首轮 */ }
    const miss = (cov.rows || []).filter((r) => !r.meetsQuota).map((r) => r.key);
    // 只增不减：曾未达标的类保留提权（它们达标正因被提权，移除即回退 → 轮间振荡）。
    // 需要收缩时手动删 out/dyn_deficit.json 重跑。
    acc = [...new Set([...acc, ...miss])];
    fs.writeFileSync(accFile, JSON.stringify(acc, null, 2));
    dynDeficit = new Set(acc);
    if (dynDeficit.size) console.log(`[dyn-deficit] 路线途经未达标类（提权锚点）: ${[...dynDeficit].join('、')}`);
  } catch { /* 首轮无此文件 */ }

  const osmBy = collectOsm(areas, OSM_SETS, dynDeficit);
  const amapBy = collectAmap(areas, AMAP_SETS, dynDeficit);

  const out = [];
  let apiCalls = 0;
  const kdGateDropped = [];   // 腿级宽凳覆盖闸门的剔除留痕（写入 routes.json 顶层 legKdGate）
  for (const a of areas) {
    const srow = statsByName.get(a.name);
    if (!srow) { out.push({ street: a.name, status: 'no-alloc' }); continue; }

    // ① 工况道路（odd_selection 标准档）
    const selKeys = new Set((oddSel.byStreet || {})[a.name] || []);
    const roadTargets = ((srow.roadList) || [])
      .filter((x) => x.mid && x.km >= 0.3 && selKeys.has(`${x.name}|${x.cls}`))
      .map((x) => ({ kind: 'road', label: CLASS_LABEL[x.cls] || '道路', name: x.name, cls: x.cls, pr: 100, wgs: x.mid, key: `road:${x.name}|${x.cls}` }));

    // ② 锚点：走廊约束 + 价值优先 + 同类打散 + 剔除顺路已覆盖的
    const anchorBudget = roadTargets.length >= 6 ? MAX_ANCHORS_RICH : MAX_ANCHORS_LEAN;
    const cands = [...(osmBy.get(a.name) || []), ...(amapBy.get(a.name) || [])]
      .filter((c) => !roadTargets.some((r) => distM(r.wgs, c.wgs) < ROAD_DEDUP_M)) // 顺路覆盖，不重复绕
      .filter((c) => KD.nearestDevWGS(c.wgs[0], c.wgs[1], ANCHOR_KD_M) <= ANCHOR_KD_M) // 宽凳闸门
      // 缺口补偿类（fireStations/policeStations/barriers/livingStreets/tolls）：路线途经实测
      // 未达配额（element_route_coverage.json），在走廊内时提权 pr+5 优先锚定，超走廊不提（不绕远）。
      .sort((x, y) => y.pr - x.pr); // 先按 pr 排，corridor 循环里对走廊内的 deficit 类优先插入
    const picked = [];
    for (const corridor of CORRIDOR_M) {
      picked.length = 0;
      const seen = new Set();
      // 走廊内有效优先级：deficit 类 +5（提权只在候选点已落在该走廊半径内时生效，不诱导绕远）
      const effPr = (c, corr) => c.deficit && corridor <= CORRIDOR_M[0] ? c.pr + 5 : c.pr;
      const ordered = cands.slice().sort((x, y) => effPr(y, corridor) - effPr(x, corridor));
      for (const c of ordered) {
        if (picked.length >= anchorBudget) break;
        if (seen.has(c.key)) continue;
        seen.add(c.key);
        const nearRoad = roadTargets.length
          ? Math.min(...roadTargets.map((r) => distM(r.wgs, c.wgs)))
          : 0;
        if (nearRoad > corridor) continue;
        if (picked.some((p) => p.kind === c.kind && distM(p.wgs, c.wgs) < ANCHOR_MIN_SEP)) continue;
        picked.push(c);
      }
      if (picked.length >= 2) break;
    }

    const targets = [...roadTargets, ...picked]
      .map((t) => ({ ...t, gcj: t.gcjNative || wgs2gcj(t.wgs[0], t.wgs[1]) }));
    if (targets.length < 2) { out.push({ street: a.name, status: 'no-anchors' }); continue; }

    // ③ 排序：路线1 从基地出发（fixFirst 用基地最近点），2-opt 消交叉
    // 路线1 从基地出发 → 起点取离基地最近的目标点（随后 2-opt 只优化后续顺序）
    let startIdx = 0, bd = Infinity;
    for (let i = 0; i < targets.length; i++) {
      const d = distM(BASE_WGS, targets[i].wgs);
      if (d < bd) { bd = d; startIdx = i; }
    }
    const ordered = twoOpt(nnOrder(targets, startIdx), true, false);
    console.log(`  [plan] ${a.name}: 工况路 ${roadTargets.length} + 锚点 ${picked.length} = ${ordered.length} 点 · NN+2opt 直线长 ${(pathLen(ordered.map((p) => p.wgs)) / 1000).toFixed(1)}km`);

    // ④ 切段：按直线里程预算（而非固定点数），末点承接为下段起点 → 路线可连续执行
    const legs = [];
    let rest = ordered.slice();
    while (rest.length >= 2) {
      let n = Math.min(LEG_MAX_PTS, rest.length);
      let acc = 0;
      for (let i = 1; i < n; i++) {
        acc += distM(rest[i - 1].wgs, rest[i].wgs) / 1000;
        if (acc > LEG_KM_BUDGET) { n = i + 1; break; }
      }
      legs.push(rest.slice(0, n));
      rest = rest.slice(n - 1); // 末点作下段起点
    }

    const routes = [];
    for (let li = 0; li < legs.length; li++) {
      const g = legs[li];
      const fromBase = li === 0 && BASE.gcj;
      const origin = fromBase ? BASE.gcj : g[0].gcj;
      const via = (fromBase ? g.slice(0, -1) : g.slice(1, -1)).map((p) => p.gcj);
      const r = await driveRoute(origin, via, g[g.length - 1].gcj);
      apiCalls++;
      if (!r || r.distKm < 1.5) { console.log(`    [skip] 段${li + 1} 失败/过短`); continue; }
      // ---- 腿级宽凳覆盖闸门（2026-10-19 用户指出：横沥 79% / 沥林 88% 里程落在宽凳盲区仍排班）----
      // 锚点闸门只查锚点本身（80m 内有宽凳路），不查锚点之间的路径。这里对高德折线
      // 逐 25m 采样评估宽凳覆盖率（与 select_odd 候选闸门同口径 band=30m）。
      // 2026-10-19 二次修正（用户：马安缺口 13km 也是问题）：覆盖 <70% 不再直接排班，
      // 先贪心摘途经点（远端/立交桥类优先）重算导航，找覆盖达标的走法；
      // 摘完仍 <70% 才整腿剔除。
      let cur = { via, origin, dest: g[g.length - 1], r, cover: KD.coverOfWay(r.poly.map(([lo, la]) => gcj2wgs(lo, la)), 30, 25).cover };
      let droppedAnchors = [];
      const MIN_COVER = 0.70;
      const hopIdx = (fromBase ? g.slice(0, -1) : g.slice(1, -1)); // 可摘候选（不含首末）
      while (cur.cover < MIN_COVER && hopIdx.length - droppedAnchors.length > 0) {
        // 尝试摘掉一个「未摘」途经点（优先立交桥/环岛类枢纽、距剩余点最远者），重算。
        // 非首腿（li>0，起点是上一腿终点接力）时，盲区常在腿起点（如马安路线3：
        // 起点惠州东互通=高速立交，去它必穿高速匝道盲区；该锚点上一腿已覆盖）→
        // 起点也纳入可摘候选（优先级最高）。
        let cand = null;
        const alive = hopIdx.filter((p) => !droppedAnchors.includes(p));
        const startPt = fromBase ? null : g[0];
        const canDropStart = li > 0 && startPt && !droppedAnchors.includes(startPt)
          && alive.length > 0; // 保底：起点摘掉后仍有途经点串
        for (const p of alive) {
          if (['interchanges', 'roundabout', 'ramps', 'service_areas', 'tolls'].includes(p.kind)) { cand = p; break; }
        }
        if (canDropStart && (!cand || startPt.kind === 'interchanges')) cand = startPt;
        if (!cand) {
          // 都非枢纽：摘距「其余存活点质心」最远的
          const cx = alive.reduce((s, p) => s + p.gcj[0], 0) / alive.length;
          const cy = alive.reduce((s, p) => s + p.gcj[1], 0) / alive.length;
          alive.sort((p, q) => ((q.gcj[0]-cx)**2 + (q.gcj[1]-cy)**2) - ((p.gcj[0]-cx)**2 + (p.gcj[1]-cy)**2));
          cand = alive[0];
        }
        const dropStart = cand === startPt;
        const newOrigin = dropStart ? (alive[0] ? alive[0].gcj : cur.origin) : cur.origin;
        const pool = (fromBase ? g.slice(0, -1) : g.slice(1, -1));
        const newVia = pool.filter((p) => !droppedAnchors.includes(p) && p !== cand).map((p) => p.gcj);
        const newDest = pool.filter((p) => !droppedAnchors.includes(p) && p !== cand).pop() || g[g.length - 1];
        const r2 = await driveRoute(newOrigin, newVia, (newDest || cur.dest).gcj);
        apiCalls++;
        if (r2 && r2.distKm >= 1.5) {
          const c2 = KD.coverOfWay(r2.poly.map(([lo, la]) => gcj2wgs(lo, la)), 30, 25).cover;
          if (c2 > cur.cover) {
            droppedAnchors.push(cand);
            cur = { via: newVia, origin: newOrigin, dest: newDest || cur.dest, r: r2, cover: c2 };
            console.log(`    [kd-fix] 段${li + 1} 摘「${cand.label}·${cand.name}${dropStart ? '(起点)' : ''}」重算 → 覆盖 ${(c2 * 100).toFixed(1)}%`);
            continue;
          }
        }
        break; // 摘了也没改善 → 放弃贪心
      }
      const rr = cur.r, legCover = { cover: cur.cover };
      if (legCover.cover < 0.5) {
        console.log(`    [kd-gate] 段${li + 1} 宽凳覆盖 ${(legCover.cover * 100).toFixed(1)}% < 50%（${r.distKm}km 盲区）→ 整段不排班`);
        kdGateDropped.push({ street: a.name, leg: li + 1, km: r.distKm, cover: +legCover.cover.toFixed(3) });
        continue;
      }
      // 途经点/起点被摘掉后：用存活锚点重建 g 链（targets/chain/anchors 同步）
      const gEff = droppedAnchors.length
        ? g.filter((p) => !droppedAnchors.includes(p) && !(fromBase && p === g[0]))
        : g;
      if (droppedAnchors.length) console.log(`    [kd-fix] 段${li + 1} 最终覆盖 ${(legCover.cover * 100).toFixed(1)}% · 摘除锚点: ${droppedAnchors.map((p) => p.name).join('、')}`);
      const anchors = fromBase
        ? [{ kind: 'base', label: '出发', name: BASE.name, gcj: BASE.gcj }, ...gEff]
        : gEff;
      routes.push({
        kind: 'loop',
        targets: gEff.map((p) => ({ kind: p.kind, label: p.label, name: p.name, cls: p.cls || null })),
        chain: gEff.map((p) => p.name),
        clsTags: [...new Set(gEff.filter((p) => p.cls).map((p) => p.cls))],
        anchors,
        distKm: r.distKm, durMin: r.durMin, roads: r.roads, poly: r.poly,
        kdCover: +legCover.cover.toFixed(3),
        kdDropped: droppedAnchors.map((p) => ({ kind: p.kind, name: p.name })),
        uri: amapUri(anchors),
      });
      console.log(`    路线${routes.length}: ${gEff.length} 点 · ${rr.distKm}km ≈${rr.durMin}min · kdCover=${(cur.cover * 100).toFixed(1)}%${droppedAnchors.length ? ` · 摘${droppedAnchors.length}点` : ''}`);
      await sleep(400);
    }
    if (!routes.length) {
      // 区分两种「无路线」：整段被腿级宽凳闸门剔光（盲区，非 API 问题）vs 真算路失败
      const droppedAll = kdGateDropped.some((d) => d.street === a.name);
      out.push({ street: a.name, status: droppedAll ? 'kd-gap' : 'api-failed' });
      continue;
    }
    out.push({
      street: a.name, status: 'ok', routes,
      targets: ordered.map((p) => ({ kind: p.kind, label: p.label, name: p.name })),
      distKm: +routes.reduce((s, x) => s + x.distKm, 0).toFixed(1),
      durMin: routes.reduce((s, x) => s + x.durMin, 0),
      uri: routes[0].uri,
    });
  }

  // ---------- 场景路线 ----------
  // v2 起场景路线由 plan_scenario_routes_v2.js 单独重规划（场景 top1 街道 + 核心
  // 要素点串联，实测导航）；这里的街道级重规划**不再复制 v1 旧点位**。
  // 优先读新场景路线；缺失时回退 v1 backup 并在日志里显式告警（不允许静默沿用旧值）。
  let scenRoutes;
  if (fs.existsSync(path.join(OUT, 'scenario_routes_v2.json'))) {
    scenRoutes = readOut('scenario_routes_v2').scenarioRoutes;
    console.log(`  场景路线：读入 scenario_routes_v2.json（${scenRoutes.length} 条）`);
  } else {
    const v1 = readOut('routes_v1_backup');
    scenRoutes = v1.scenarioRoutes;
    console.warn('  [warn] 未找到 scenario_routes_v2.json —— 场景路线回退 v1 旧值（里程可能已过期）');
  }
  fs.writeFileSync(path.join(OUT, 'routes.json'), JSON.stringify({
    generated: new Date().toISOString(),
    source: 'Amap v3/direction/driving (strategy=3, 不走高速) · 重规划 v2：工况路+锚点一趟串（NN+2opt）+ 腿级宽凳覆盖闸门（<50% 不排班）',
    routes: out,
    legKdGate: { band: 30, coverMin: 0.5, dropped: kdGateDropped },
    scenarioRoutes: scenRoutes,
  }, null, 1));
  if (kdGateDropped.length) {
    console.log(`\n[kd-gate] 腿级宽凳闸门剔除 ${kdGateDropped.length} 段 / ${kdGateDropped.reduce((s, d) => s + d.km, 0).toFixed(1)}km：`);
    for (const d of kdGateDropped) console.log(`    ${d.street} 段${d.leg} · ${d.km}km · 覆盖 ${(d.cover * 100).toFixed(1)}%`);
  }
  const okN = out.filter((r) => r.status === 'ok').length;
  const legN = out.reduce((s, r) => s + ((r.routes || []).length), 0);
  const km = out.filter((r) => r.status === 'ok').reduce((s, r) => s + r.distKm, 0);
  console.log(`\ndone: ${okN}/${out.length} 街道 · ${legN} 条路线 · 单程合计 ${km.toFixed(1)}km（双向 ${(2 * km).toFixed(1)}km）· API ${apiCalls} 次`);
}

main().catch((e) => { console.error(e); process.exit(1); });
