// Plan a numbered route set (路线1..N) per street via the Amap Directions API.
//
// Not a poller: runs once, caches to out/routes.json, then stops.
// 路线1..K = skeleton segments: 路线1 departs the team base (德赛西威惠南工业园,
// data/base.json) and sweeps the street's highest-value named elements
// (tunnels, schools, construction, ...), picked by test value with a
// spatial-spread rule; further segments are independent 起点→终点 legs.
// 路线K+1..N = coverage routes: the street's ODD-selected roads only (out/
// odd_selection.json 标准档 — 工况选择: 稀缺高危元素穷举 + 统计元素配额 + 等级
// 代表, NOT every named road) chained nearest-neighbour into navigable 路→路
// segments; the schedule reads "从哪到哪多少公里" per route instead of a bare
// road checklist. 全路网穷举（1108 条）已改按工况选择性覆盖 — 见 §5.
// OSM coordinates are WGS-84; Amap APIs need GCJ-02, so anchors are
// converted with the standard public transform before each call.
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const { nextKey } = require('./amap_key');
const read = (n) => JSON.parse(fs.readFileSync(path.join(DATA, n + '.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Daily origin (GCJ-02, geocoded via Amap POI search 2026-09-23): the test
// team departs from 德赛西威惠南工业园 every morning — 路线1 starts there.
const BASE = read('base');

// ---------- WGS-84 -> GCJ-02 (standard public transform) ----------
const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;

function tLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  r += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
  return r;
}
function tLon(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  r += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
  return r;
}
function wgs2gcj(lon, lat) {
  let dLat = tLat(lon - 105, lat - 35);
  let dLon = tLon(lon - 105, lat - 35);
  const radLat = (lat / 180) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sq = Math.sqrt(magic);
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sq)) * PI);
  dLon = (dLon * 180) / ((A / sq) * Math.cos(radLat) * PI);
  return [lon + dLon, lat + dLat];
}
// One-step inverse (≈1 m accurate) — used for Amap POIs whose coords are
// already GCJ-02 and need a WGS-84 stand-in for spatial spread ordering.
function gcj2wgs(lon, lat) {
  const [gl, gt] = wgs2gcj(lon, lat);
  return [lon - (gl - lon), lat - (gt - lat)];
}

// ---------- subdistrict polygons (same logic as build_stats.js) ----------
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
const HC_SUBDISTRICTS = new Set(
  read('hc_subnames').elements.map((e) => e.tags.name).filter(Boolean)
);
function buildAreas() {
  const bnd = read('boundaries_geom');
  const extra = read('lilin');
  const areas = [];
  for (const el of [...bnd.elements, ...extra.elements]) {
    const t = el.tags || {};
    if (t.admin_level !== '8' || !t.name || !HC_SUBDISTRICTS.has(t.name)) continue;
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

// ---------- anchors ----------
// Anchor priority = test value, mirrors the report's element weighting.
// busStops are lowest: ubiquitous, used only as filler for sparse streets.
const ANCHOR_SETS = [
  { key: 'tunnels',      file: 'tunnels',      label: '隧道',     pr: 8, rail: true },
  { key: 'roundabout',   file: 'roundabout',   label: '环岛',     pr: 7 },
  { key: 'construction', file: 'construction', label: '施工路段', pr: 5 },
  { key: 'bridges',      file: 'bridges',      label: '桥梁',     pr: 3, rail: true },
  { key: 'busStops',     file: 'bus_stops',    label: '公交站',   pr: 1 },
];
// 学校/医院/市场与统计同源走高德：OSM 侧 297/37/11 个（markets 还混了便利店/菜店），
// 高德同口径 424/171/565 个。锚点用错源会让路线绕去 OSM 独有的旧点位。
const AMAP_ANCHOR_SETS = [
  { key: 'schools',   amap: 'amap_schools',   label: '学校', pr: 6 },
  { key: 'hospitals', amap: 'amap_hospitals', label: '医院', pr: 6 },
  { key: 'markets',   amap: 'amap_markets',   label: '市场', pr: 4 },
];
const MAX_ANCHORS = 9;  // street skeleton: up to 9 anchors → up to 3 legs
const SCEN_MAX = 4;     // scenario demo routes stay a single small leg
const MIN_SEP_M = 700; // spatial spread between anchors
// Tunnels/bridges in OSM China are mostly named for the rail line / motorway
// they carry (京港高速线, 惠大铁路, 广惠城际线...) — not drivable elements and
// not something a 45 km/h test car should route to. Road-named ones
// (西坑东隧道, 站前大道) are real ADAS anchors and stay.
const RAIL_MOTORWAY_NAME = /高速|铁路|城际|高铁|京九/;

function coordOf(el) {
  if (el.type === 'node') return [el.lon, el.lat];
  if (el.center) return [el.center.lon, el.center.lat];
  if (el.geometry && el.geometry.length >= 2) {
    const p = el.geometry[Math.floor(el.geometry.length / 2)];
    return [p.lon, p.lat];
  }
  return null;
}
function distM(a, b) {
  const R = 6371008.8, rad = (d) => (d * PI) / 180;
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function collectAnchors(areas, sets = ANCHOR_SETS, opts = {}) {
  const byStreet = new Map(areas.map((a) => [a.name, []]));
  for (const s of sets) {
    let anon = 0; // unnamed anchors get numbered display names (环岛1, 环岛2, ...)
    for (const el of read(s.file).elements) {
      const realName = el.tags && el.tags.name;
      const name = realName || (opts.allowUnnamed ? `${s.label}${++anon}` : null);
      if (!name) continue;
      if (s.rail && realName && RAIL_MOTORWAY_NAME.test(realName)) continue;
      const c = coordOf(el);
      if (!c) continue;
      for (const a of areas) {
        if (pointInPolygon(c[0], c[1], a.polygons)) {
          byStreet.get(a.name).push({
            kind: s.key, label: s.label, pr: s.pr, name,
            key: realName || `${s.label}-${el.type}${el.id}`, // dedupe id: unnamed anchors share a display name
            wgs: c,
          });
          break;
        }
      }
    }
  }
  return byStreet;
}

// Amap POI anchors (tollway scenario): pois carry GCJ-02 "lon,lat" strings,
// so they match the WGS polygons as-is (≈500 m offset, fine for street-level
// assignment) and skip the WGS→GCJ conversion when routed.
function collectAmapAnchors(areas, s) {
  const byStreet = new Map(areas.map((a) => [a.name, []]));
  // typecode 过滤仅用于"一个文件含多类"的场景（amap_roadattach 收费站/服务区）；
  // 单类文件（学校等）返回的是子类码 141202/141203...，按父码前缀过滤会只剩零头。
  const allPois = read(s.amap).pois || [];
  (s.typecode ? allPois.filter((p) => String(p.typecode || '').startsWith(s.typecode)) : allPois)
    .forEach((p, i) => {
      const [lon, lat] = String(p.location || '').split(',').map(Number);
      if (!isFinite(lon) || !isFinite(lat)) return;
      for (const a of areas) {
        if (pointInPolygon(lon, lat, a.polygons)) {
          byStreet.get(a.name).push({
            kind: s.key, label: s.label, pr: s.pr,
            name: p.name || s.label, key: p.name || `${s.label}-${i}`,
            wgs: gcj2wgs(lon, lat), gcjNative: [lon, lat],
          });
          break;
        }
      }
    });
  return byStreet;
}

// 多个高德集合合并为一张 street -> anchors 表
function collectAmapAnchorsAll(areas, sets) {
  const merged = new Map(areas.map((a) => [a.name, []]));
  for (const s of sets) {
    for (const [name, list] of collectAmapAnchors(areas, s)) {
      const cur = merged.get(name);
      if (cur) cur.push(...list); else merged.set(name, list);
    }
  }
  return merged;
}

// Greedy pick: highest test-value first, drop same-named repeats (one road
// split into many OSM ways would otherwise anchor a route 4 times), skip
// anything within MIN_SEP_M of an already-picked anchor; if the street stays
// under 2 anchors, retry with relaxed separation so sparse rural streets
// still get a route.
function pickAnchors(cands, max = MAX_ANCHORS) {
  const sorted = [...cands].sort((a, b) => b.pr - a.pr);
  const deduped = [];
  const seen = new Set();
  for (const c of sorted) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    deduped.push(c);
  }
  for (const sep of [MIN_SEP_M, 400, 200, 0]) {
    const picked = [];
    for (const c of deduped) {
      if (picked.length >= max) break;
      if (picked.some((p) => p.key === c.key || distM(p.wgs, c.wgs) < sep)) continue;
      picked.push(c);
    }
    if (picked.length >= 2) return picked;
  }
  return null;
}

// Angular order around the anchor centroid -> the route sweeps the street
// once instead of zig-zagging; first = origin, last = destination.
function orderAnchors(picked) {
  const cx = picked.reduce((s, p) => s + p.wgs[0], 0) / picked.length;
  const cy = picked.reduce((s, p) => s + p.wgs[1], 0) / picked.length;
  return [...picked].sort((a, b) =>
    Math.atan2(a.wgs[1] - cy, a.wgs[0] - cx) - Math.atan2(b.wgs[1] - cy, b.wgs[0] - cx));
}

// Split the angular sweep into consecutive legs of ~3 anchors (each an
// independent navigable 起点→终点 segment); a lone 4th anchor folds back into
// the previous leg, and ≤4 anchors stay one single leg as before.
function chunkLegs(ordered) {
  if (ordered.length <= 4) return [ordered];
  const legs = [];
  for (let i = 0; i < ordered.length; i += 3) legs.push(ordered.slice(i, i + 3));
  if (legs.length > 1 && legs[legs.length - 1].length === 1) {
    const last = legs.pop();
    legs[legs.length - 1] = legs[legs.length - 1].concat(last);
  }
  return legs;
}

// ---------- Amap driving API ----------
const fmt = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;

async function driveRoute(origin, waypoints, dest) {
  const qs = new URLSearchParams({
    key: nextKey(),
    origin: fmt(origin),
    destination: fmt(dest),
    extensions: 'all',
    strategy: '3', // 不走高速——无人小车限速 45km/h，不上主线
    output: 'json',
  });
  if (waypoints.length) qs.set('waypoints', waypoints.map(fmt).join(';'));
  const url = `https://restapi.amap.com/v3/direction/driving?${qs.toString()}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url);
    const j = await res.json();
    if (j.status === '1' && j.route && j.route.paths && j.route.paths.length) {
      const p = j.route.paths[0];
      const roads = [];
      for (const st of p.steps || []) {
        const rn = (st.road || '').trim();
        if (rn && !roads.includes(rn)) roads.push(rn);
      }
      return {
        distKm: +(Number(p.distance) / 1000).toFixed(1),
        durMin: Math.round(Number(p.duration) / 60),
        roads: roads.slice(0, 8),
      };
    }
    console.error(`  [warn] ${j.info} (infocode ${j.infocode}) — retry ${attempt + 1}`);
    if (j.infocode === '10001' || j.infocode === '10019') process.exit(1); // key/quota fatal
    await sleep(600);
  }
  return null;
}

// Human-clickable deep link that opens this exact route in Amap navigation.
// Broken-link fixes, all required by the URI API docs:
//   - src= is mandatory (without it uri.amap.com rejects the request),
//   - commas inside from/to/via stay literal (URLSearchParams %-encodes
//     them to %2C, which breaks coordinate parsing in some clients),
//   - policy=3 = 不走高速, matching the ≤45 km/h unmanned-car constraint.
function amapUri(anchors) {
  const q = (p) => `${p.gcj[0].toFixed(6)},${p.gcj[1].toFixed(6)},${encodeURIComponent(p.name)}`;
  const qs = [
    `from=${q(anchors[0])}`,
    `to=${q(anchors[anchors.length - 1])}`,
    'mode=car',
    'policy=3',
    'coordinate=gaode',
    'callnative=0',
    'src=huicheng-odd',
  ];
  if (anchors.length > 2) qs.splice(2, 0, `via=${anchors.slice(1, -1).map(q).join(';')}`);
  return `https://uri.amap.com/navigation?${qs.join('&')}`;
}

async function main() {
  const areas = buildAreas();
  console.log(`subdistricts with polygon: ${areas.length}`);
  // Street stats: which streets carry an allocation + their roadList (with
  // per-road representative midpoints, added by build_stats.js for coverage routes).
  const streetRows = JSON.parse(fs.readFileSync(path.join(OUT, 'street_stats.json'), 'utf8'));
  const allocated = new Set(streetRows.map((r) => r.name));
  const statsByName = new Map(streetRows.map((r) => [r.name, r]));
  // ODD 工况选择（select_odd.js 标准档）: 覆盖目标只取选中的 name|cls 道路。
  const oddSel = JSON.parse(fs.readFileSync(path.join(OUT, 'odd_selection.json'), 'utf8')).tiers.std;
  const byStreet = collectAnchors(areas);
  for (const [name, list] of collectAmapAnchorsAll(areas, AMAP_ANCHOR_SETS)) {
    const cur = byStreet.get(name);
    if (cur) cur.push(...list);
  }

  const out = [];
  for (const a of areas) {
    if (!allocated.has(a.name)) continue;
    const cands = byStreet.get(a.name) || [];
    let picked = pickAnchors(cands);
    if (!picked) {
      // Sparse rural streets (芦洲镇: OSM has only rail-named bridges there)
      // fall back to Amap 补能 POIs so they still get a route.
      const POI_FALLBACK = [
        { amap: 'amap_fuel', typecode: '010100', key: 'fuel', label: '加油站', pr: 3 },
        { amap: 'amap_charging', typecode: '011100', key: 'charging', label: '充电站', pr: 2 },
        { amap: 'amap_parking', typecode: '150904', key: 'parking', label: '停车场', pr: 2 },
      ];
      picked = pickAnchors(POI_FALLBACK.flatMap((s) => collectAmapAnchors(areas, s).get(a.name) || []));
      if (picked) console.log(`  [fallback] ${a.name}: Amap POI anchors`);
    }
    if (!picked) {
      console.log(`  [skip] ${a.name}: <2 named anchors`);
      out.push({ street: a.name, status: 'no-anchors' });
      continue;
    }
    const ordered = orderAnchors(picked).map((p) => ({
      kind: p.kind, label: p.label, name: p.name, wgs: p.wgs, gcj: p.gcjNative || wgs2gcj(p.wgs[0], p.wgs[1]),
    }));
    const groups = chunkLegs(ordered);
    console.log(`  [route] ${a.name}: 骨架${groups.length} 段 · ${ordered.map((p) => `${p.label}·${p.name}`).join(' -> ')}`);

    // 路线集: 路线1 从基地出发串骨架段①（每天 07:00 从德赛西威惠南工业园发车），
    // 其余骨架段依次为路线2..K，然后覆盖路线把该街道主力路网（roadList 按等级
    // 排序）串成可导航的 路→路 链——排班表因此读作"路线1..N，从哪到哪多少公里"。
    const routes = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const fromBase = gi === 0 && BASE.gcj;
      const origin = fromBase ? BASE.gcj : g[0].gcj;
      const via = (fromBase ? g.slice(0, -1) : g.slice(1, -1)).map((p) => p.gcj);
      const r = await driveRoute(origin, via, g[g.length - 1].gcj);
      if (!r || r.distKm < 2) {
        console.log(`    [skip] 骨架段${gi + 1}（${g[0].name}→${g[g.length - 1].name}）失败/过短`);
        continue;
      }
      const anchors = fromBase
        ? [{ kind: 'base', label: '出发', name: BASE.name, gcj: BASE.gcj }, ...g]
        : g;
      routes.push({ kind: 'skeleton', anchors, distKm: r.distKm, durMin: r.durMin, roads: r.roads, uri: amapUri(anchors) });
      console.log(`    路线${routes.length}: ${fromBase ? `${BASE.name} → ` : ''}${g[0].name} → ${g[g.length - 1].name} · ${r.distKm}km ≈${r.durMin}min via ${r.roads.slice(0, 3).join('/')}`);
      await sleep(350);
    }

    // 覆盖路线: ODD 选中道路（odd_selection 标准档，name|cls 精确匹配 roadList）
    // 逐路串链（贪心最近邻，从骨架终点续起），每 ≤8 条路一段独立导航——
    // 工况选择性覆盖，非全路网穷举。
    const srow = statsByName.get(a.name);
    const selKeys = new Set((oddSel.byStreet || {})[a.name] || []);
    const roadCands = ((srow && srow.roadList) || [])
      .filter((x) => x.mid && x.km >= 0.3 && selKeys.has(`${x.name}|${x.cls}`));
    let cur = null;
    const lastR = routes[routes.length - 1];
    if (lastR) cur = lastR.anchors[lastR.anchors.length - 1].wgs;
    const pool = roadCands.slice();
    const nn = [];
    while (pool.length) {
      let bi = 0;
      if (cur) {
        let bd = Infinity;
        for (let i = 0; i < pool.length; i++) {
          const d = distM(cur, pool[i].mid);
          if (d < bd) { bd = d; bi = i; }
        }
      }
      const nx = pool.splice(bi, 1)[0];
      nn.push(nx);
      cur = nx.mid;
    }
    const nb = Math.ceil(nn.length / 8);
    const bsize = nb ? Math.ceil(nn.length / nb) : 0;
    for (let b = 0; b < nb; b++) {
      const batch = nn.slice(b * bsize, (b + 1) * bsize);
      if (batch.length < 2) continue;
      const pts = batch.map((x) => wgs2gcj(x.mid[0], x.mid[1]));
      const r = await driveRoute(pts[0], pts.slice(1, -1), pts[pts.length - 1]);
      if (!r || r.distKm < 2) {
        console.log(`    [skip] 覆盖路线${b + 1} 失败/过短`);
        continue;
      }
      routes.push({
        kind: 'cover',
        chain: batch.map((x) => x.name),
        clsTags: [...new Set(batch.map((x) => x.cls))],
        distKm: r.distKm, durMin: r.durMin, roads: r.roads,
        uri: amapUri(batch.map((x, i) => ({ name: x.name, gcj: pts[i] }))),
      });
      console.log(`    路线${routes.length}（覆盖）: ${batch.map((x) => x.name).slice(0, 4).join('→')}… · ${r.distKm}km ≈${r.durMin}min`);
      await sleep(350);
    }

    if (!routes.length) {
      out.push({ street: a.name, status: 'api-failed', anchors: ordered });
      continue;
    }
    out.push({
      street: a.name,
      status: 'ok',
      routes,
      anchors: ordered,           // flattened anchor chain (display fallback)
      distKm: +routes.reduce((s, x) => s + x.distKm, 0).toFixed(1),
      durMin: routes.reduce((s, x) => s + x.durMin, 0),
      uri: routes[0].uri,
    });
  }

  // ---------- scenario routes: one point-to-point route per scenario ----------
  // Top street per scenario comes from the shared ranking (scenarios.js) the
  // report renders, so the scenario route always matches the #1 recommendation.
  // Rural roads are a linear network, not point elements -> fall back to the
  // street's general high-value route.
  const { SCENARIOS, scenarioRank } = require('./scenarios');
  const okByStreet = new Map(out.filter((r) => r.status === 'ok').map((r) => [r.street, r]));
  const SCENARIO_ANCHORS = {
    rural: null,
    school: [{ amap: 'amap_schools', key: 'schools', label: '学校', pr: 8 }],
    tunnelBridge: [
      { file: 'tunnels', key: 'tunnels', label: '隧道', pr: 8, rail: true },
      { file: 'bridges', key: 'bridges', label: '桥梁', pr: 5, rail: true },
    ],
    tollway: [{ amap: 'amap_roadattach', typecode: '1802', key: 'tolls', label: '收费站', pr: 8 }],
    busHub: [
      { file: 'probe_busdepot', key: 'busDepots', label: '公交场站', pr: 8 },
      { file: 'bus_stops', key: 'busStops', label: '公交站', pr: 4 },
    ],
    uTurn: [
      { file: 'roundabout', key: 'roundabout', label: '环岛', pr: 7 },
      { file: 'probe_turning', key: 'turning', label: '掉头圈', pr: 7 },
    ],
    construction: [{ file: 'construction', key: 'construction', label: '施工路段', pr: 8 }],
  };

  const scenarioRoutes = [];
  for (const sc of SCENARIOS) {
    const top = scenarioRank(sc, streetRows)[0];
    if (!top) {
      scenarioRoutes.push({ scenario: sc.key, label: sc.label, status: 'no-street' });
      continue;
    }
    const street = top.r.name;
    const sets = SCENARIO_ANCHORS[sc.key];
    let ordered = null;
    if (sets) {
      const src = sets[0].amap
        ? collectAmapAnchors(areas, sets[0])
        : collectAnchors(areas, sets, { allowUnnamed: true });
      ordered = pickAnchors(src.get(street) || [], SCEN_MAX);
      if (ordered) ordered = orderAnchors(ordered);
    }
    if (!ordered) {
      const gen = okByStreet.get(street);
      scenarioRoutes.push(gen
        ? { scenario: sc.key, label: sc.label, street, status: 'street-route' }
        : { scenario: sc.key, label: sc.label, street, status: 'no-anchors' });
      console.log(`  [sc:${sc.key}] ${street} -> 沿用街道通用路线`);
      continue;
    }
    const points = ordered.map((p) => ({
      kind: p.kind, label: p.label, name: p.name,
      wgs: p.wgs, gcj: p.gcjNative || wgs2gcj(p.wgs[0], p.wgs[1]),
    }));
    console.log(`  [sc:${sc.key}] ${street}: ${points.map((p) => `${p.label}·${p.name}`).join(' -> ')}`);
    const r = await driveRoute(
      points[0].gcj,
      points.slice(1, -1).map((p) => p.gcj),
      points[points.length - 1].gcj
    );
    if (!r || r.distKm < 2) {
      scenarioRoutes.push({ scenario: sc.key, label: sc.label, street, status: 'api-failed', anchors: points });
      continue;
    }
    scenarioRoutes.push({
      scenario: sc.key, label: sc.label, street, status: 'ok',
      anchors: points, distKm: r.distKm, durMin: r.durMin, roads: r.roads, uri: amapUri(points),
    });
    console.log(`    ${r.distKm} km, ${r.durMin} min via ${r.roads.slice(0, 3).join('/')}`);
    await sleep(350);
  }

  fs.writeFileSync(path.join(OUT, 'routes.json'), JSON.stringify({
    generated: new Date().toISOString(),
    source: 'Amap v3/direction/driving (strategy=3, 不走高速)',
    routes: out,
    scenarioRoutes,
  }, null, 1));
  const ok = out.filter((r) => r.status === 'ok').length;
  const scOk = scenarioRoutes.filter((r) => r.status === 'ok').length;
  console.log(`\ndone: ${ok}/${out.length} street routes + ${scOk}/${scenarioRoutes.length} scenario routes -> out/routes.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
