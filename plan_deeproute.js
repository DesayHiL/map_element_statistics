// plan_deeproute.js —— deeproute 专项测试路线（1000km 高价值版）
// =============================================================================
// 目标：一周 1000km 高 ODD 价值连续路测。与全区排班（plan_routes_v2）不同：
//   · 打破街道边界，全区 260 个已验证锚点（工况路 + 学校/隧道/医院/施工…）进一个池
//   · 价值优先：按 pr 加权贪心串珠（场景价值主控，入点成本仅 tie-break 参考）
//   · 每条 deeproute ≈60km，4 个站点锚点（起/中1/中2/终），中2 个途经点锁方向，
//     其余路径自由行驶 —— 连续不碎
//   · 16 条路线首尾相接（上条终点 = 下条起点），无空驶
//   · 总里程目标 1000km±5%；锚点不够就按「离已选走廊最近 + pr 高」递补
//
// 输入：out/routes.json（现排班的腿级 anchors，含 gcj/pr/kind/name，已过宽凳闸门）
// 输出：out/deeproute_plan.json（数据快照）+ out/deeproute_routes.html（专页）
// 不动现有交付页与 audit 链（铁律：deeproute 产物命名独立，audit_data.js 不感知）。
const fs = require('fs');
const path = require('path');
const SA = require('./street_areas.js');
const KD = require('./lib_kd_cover.js');

const OUT = path.join(__dirname, 'out');
const DATA = path.join(__dirname, 'data');
const readData = (n) => JSON.parse(fs.readFileSync(path.join(DATA, n + '.json'), 'utf8'));
const { nextKey } = require('./amap_key');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 参数 ----------
const TARGET_TOTAL_KM = 1000;   // 一周目标总里程
const ROUTE_KM = 60;            // 单条 deeproute 目标里程
const MIN_ROUTE_KM = 45;        // 单条下限（过短=碎，用户痛点）
const MAX_ROUTE_KM = 75;        // 单条上限
const TARGET_ROUTE_N = Math.round(TARGET_TOTAL_KM / ROUTE_KM); // ≈17 条
const CORRIDOR_KM = 5;          // 串珠时贪心跳跃上限（防远郊孤岛拽飞）
const PR_MIN = 5;               // 场景价值门槛：pr≥5 才主动纳入（隧道/环岛/学校/医院/工况路/施工）
// pr 映射：road=100（工况道路本身）已在 anchors 里；其余按 ODD_SETS 的 pr

// ---------- 坐标工具（与 plan_routes_v2 同源） ----------
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
const fmt = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;

// ---------- 高德 driving（strategy=3 不走高速，与排班同口径） ----------
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
        for (const pair of String(st.polyline || '').split(';')) {
          const [lo, la] = pair.split(',').map(Number);
          if (isFinite(lo) && isFinite(la)) poly.push([+lo.toFixed(6), +la.toFixed(6)]);
        }
      }
      return { distKm: +(Number(p.distance) / 1000).toFixed(1), durMin: Math.round(Number(p.duration) / 60), roads: roads.slice(0, 12), poly };
    }
    if (j.infocode === '10001' || j.infocode === '10019') { console.error(`  [fatal] ${j.infocode} ${j.info}`); process.exit(1); }
    await sleep(700 * (attempt + 1));
  }
  return null;
}
function amapUri(pts) {
  const q = (p) => `${p.gcj[0].toFixed(6)},${p.gcj[1].toFixed(6)},${encodeURIComponent(p.name)}`;
  const qs = [`from=${q(pts[0])}`, `to=${q(pts[pts.length - 1])}`, 'mode=car', 'policy=3', 'coordinate=gaode', 'callnative=0', 'src=huicheng-deeproute'];
  if (pts.length > 2) qs.splice(2, 0, `via=${pts.slice(1, -1).map(q).join(';')}`);
  return `https://uri.amap.com/navigation?${qs.join('&')}`;
}

// ---------- 主流程 ----------
async function main() {
  const routesJ = JSON.parse(fs.readFileSync(path.join(OUT, 'routes.json'), 'utf8'));
  // ① 锚点池 A：现排班腿级 anchors 去重（工况路 pr=100 骨架 + 已验证高价值锚点）
  const pool = new Map();
  let apiCalls = 0;
  for (const r of routesJ.routes) for (const leg of (r.routes || [])) for (const a of (leg.anchors || [])) {
    if (a.kind === 'base' || !a.key || !a.gcj) continue;
    if (!pool.has(a.key)) pool.set(a.key, { ...a, streets: [r.street] });
    else if (!pool.get(a.key).streets.includes(r.street)) pool.get(a.key).streets.push(r.street);
  }
  const BASE = routesJ.routes.flatMap((r) => r.routes || []).flatMap((l) => l.anchors || []).find((a) => a.kind === 'base');
  console.log(`[pool-A] 排班锚点 ${pool.size} 个 · 基地: ${BASE.name} @ ${BASE.gcj}`);

  // ①b 锚点池 B：全区源数据直采（排班预算只挑了 260 个，容量不够 1000km）。
  //    与 plan_routes_v2 的 collectOsm/collectAmap 同口径：区内 + 有名 + 剔铁路/高速命名 + 宽凳 80m 闸门。
  //    OSM 侧 WGS-84 → 转 GCJ；高德侧原生 GCJ。
  const areas = SA.loadAreas();
  const inHC = (lon, lat) => { for (const a of areas) if (SA.pointInPolygon(lon, lat, a.polygons)) return a.name; return null; };
  const RAIL_MOTORWAY_NAME = /高速|铁路|城际|高铁|京九/;
  function coordOf(el) {
    if (el.type === 'node') return [el.lon, el.lat];
    if (el.center) return [el.center.lon, el.center.lat];
    if (el.geometry && el.geometry.length >= 2) { const p = el.geometry[Math.floor(el.geometry.length / 2)]; return [p.lon, p.lat]; }
    return null;
  }
  let added = 0;
  const OSM_SETS = [
    { file: 'tunnels', kind: 'tunnels', label: '隧道', pr: 9, rail: true },
    { file: 'roundabout', kind: 'roundabout', label: '环岛', pr: 8 },
    { file: 'construction', kind: 'construction', label: '施工路段', pr: 6 },
    { file: 'footbridges', kind: 'footbridges', label: '人行天桥', pr: 5 },
    { file: 'bridges', kind: 'bridges', label: '桥梁', pr: 4, rail: true },
    { file: 'probe_busdepot', kind: 'busDepots', label: '公交场站', pr: 3 },
  ];
  for (const s of OSM_SETS) {
    const d = readData(s.file);
    for (const el of d.elements) {
      const c = coordOf(el);
      if (!c) continue;
      const nm = (el.tags || {}).name || '';
      if (!nm) continue;
      if (s.rail && RAIL_MOTORWAY_NAME.test(nm)) continue;
      const street = inHC(c[0], c[1]);
      if (!street) continue;
      if (KD.nearestDevWGS(c[0], c[1], 80) > 80) continue;
      const key = `${s.kind}:${nm}`;
      if (pool.has(key)) continue;
      pool.set(key, { kind: s.kind, label: s.label, name: nm, pr: s.pr, wgs: c, gcj: SA.wgs2gcj(c), key });
      added++;
    }
  }
  const AMAP_SETS = [
    { file: 'amap_schools', kind: 'schools', label: '学校', pr: 7 },
    { file: 'amap_hospitals', kind: 'hospitals', label: '医院', pr: 7 },
    { file: 'amap_interchanges', kind: 'interchanges', label: '立交桥', pr: 6 },
    { file: 'amap_markets', kind: 'markets', label: '市场', pr: 4 },
    { file: 'amap_fire_stations', kind: 'fireStations', label: '消防站', pr: 3 },
  ];
  for (const s of AMAP_SETS) {
    let d;
    try { d = readData(s.file); } catch { continue; }
    for (const p of d.pois || []) {
      const [lo, la] = String(p.location).split(',').map(Number);
      if (!isFinite(lo)) continue;
      const street = inHC(lo, la);
      if (!street) continue;
      const w = SA.gcj2wgs([lo, la]);
      if (KD.nearestDevWGS(w[0], w[1], 80) > 80) continue;
      const key = `${s.kind}:${p.name}`;
      if (pool.has(key)) continue;
      pool.set(key, { kind: s.kind, label: s.label, name: p.name, pr: s.pr, wgs: w, gcj: [lo, la], key });
      added++;
    }
  }
  console.log(`[pool-B] 全区直采新增 ${added} · 池总 ${pool.size}`);

  // ② 价值锚点池就绪（筛选挪到 ③ 排序前：value 主控 + 递补填里程）

  // ③ 分簇排路：全区串珠的教训——NN+2opt 找的是最短链（直线仅 ~220km），切 9 条
  //    每条只装 ~25km 直线，实际总里程卡死在 650km 上不去。改架构：
  //    KMeans 地理聚类成 N 簇（N=ceil(1000/60)≈17），簇内 NN+2opt 串珠 → 一簇一条
  //    deeproute（簇内链长自然 ~40km 直线 ≈ 60km 实际），簇间按中心 NN 排执行序，
  //    相邻簇首尾衔接。总里程 = Σ簇内链长 ×1.4，点不够的簇吸收 pr≥3 递补点。
  function nn2opt(sel, fixedStart) {
    const pts = sel.map((c) => c.gcj);
    if (pts.length < 2) return sel.slice();
    let startIdx = fixedStart != null ? fixedStart : 0;
    if (fixedStart == null) {
      let bd = Infinity;
      for (let i = 0; i < pts.length; i++) { const d = distM(BASE.gcj, pts[i]); if (d < bd) { bd = d; startIdx = i; } }
    }
    const poolIdx = pts.map((_, i) => i).filter((i) => i !== startIdx);
    const orderIdx = [startIdx];
    while (poolIdx.length) {
      const cur = pts[orderIdx[orderIdx.length - 1]];
      let bi = 0, bdd = Infinity;
      for (let i = 0; i < poolIdx.length; i++) { const d = distM(cur, pts[poolIdx[i]]); if (d < bdd) { bdd = d; bi = i; } }
      orderIdx.push(poolIdx.splice(bi, 1)[0]);
    }
    const pathLen = (idx) => { let s = 0; for (let i = 1; i < idx.length; i++) s += distM(pts[idx[i - 1]], pts[idx[i]]); return s; };
    let improved = true, pass = 0;
    while (improved && pass++ < 60) {
      improved = false;
      for (let i = 1; i < orderIdx.length - 1; i++) {
        for (let k = i + 1; k < orderIdx.length; k++) {
          const rev = orderIdx.slice(0, i).concat(orderIdx.slice(i, k + 1).reverse(), orderIdx.slice(k + 1));
          if (pathLen(rev) < pathLen(orderIdx) - 1) { orderIdx.splice(0, orderIdx.length, ...rev); improved = true; }
        }
      }
    }
    return orderIdx.map((i) => sel[i]);
  }
  function kmeans(points, k, iters = 60) {
    // points: [{c:[lon,lat]}]；返回簇中心
    let cents = points.slice(0, k).map((p) => p.gcj.slice()); // 简单取前 k 个（后经 NN 排序不影响簇质量太多）
    // 改进：最远点采样初始化（k-means++ 简化版），簇更分散
    cents = [points.reduce((f, p) => (distM(BASE.gcj, p.gcj) > distM(BASE.gcj, f.gcj) ? p : f), points[0]).gcj.slice()];
    while (cents.length < k) {
      let best = null, bd = -1;
      for (const p of points) {
        const d = Math.min(...cents.map((c) => distM(c, p.gcj)));
        if (d > bd) { bd = d; best = p; }
      }
      cents.push(best.gcj.slice());
    }
    for (let it = 0; it < iters; it++) {
      const assign = points.map((p) => {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < cents.length; i++) { const d = distM(cents[i], p.gcj); if (d < bd) { bd = d; bi = i; } }
        return bi;
      });
      const next = cents.map(() => [0, 0, 0]);
      for (let i = 0; i < points.length; i++) { const a = next[assign[i]]; a[0] += points[i].gcj[0]; a[1] += points[i].gcj[1]; a[2]++; }
      let moved = 0;
      for (let i = 0; i < cents.length; i++) {
        if (!next[i][2]) continue;
        const nc = [next[i][0] / next[i][2], next[i][1] / next[i][2]];
        moved += distM(cents[i], nc); cents[i] = nc;
      }
      if (moved < 10) break;
    }
    return cents;
  }

  const valuable = [...pool.values()].filter((c) => (c.pr || 0) >= PR_MIN);
  const filler = [...pool.values()].filter((c) => (c.pr || 0) < PR_MIN)
    .sort((x, y) => distM(BASE.gcj, x.gcj) - distM(BASE.gcj, y.gcj));
  // 目标簇数：15 簇实测总 808km / 多簇叠城区。要 1000km：14 簇（每簇更大链更长）
  let K = 14;
  let cents = kmeans(valuable, K);
  let clusters = cents.map(() => []);
  for (const c of valuable) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < cents.length; i++) { const d = distM(cents[i], c.gcj); if (d < bd) { bd = d; bi = i; } }
    clusters[bi].push(c);
  }
  // 簇间执行序：中心 NN（起点 = 离基地最近的簇）
  const centOrder = nn2opt(cents.map((c, i) => ({ gcj: c, _i: i })), null).map((x) => x._i);
  clusters = centOrder.map((i) => clusters[i]);
  cents = centOrder.map((i) => cents[i]);
  console.log(`[cluster] K=${K} 簇规模 ${clusters.map((c) => c.length).join('/')} · 簇间序（中心 NN）已定`);

  // ④ 每簇一条 deeproute：簇内 NN+2opt 串珠（起点取离基地/上簇终点最近的点），
  //    3 段 4 站点，段内途经点 ≤7。簇链太短（<35km 直线）时吸收邻近 pr≥3 递补点。
  function planCluster(cl, prevEnd) {
    // 起点选择：离上簇终点（无则基地）最近的簇内点 → 条间衔接近、无长空驶
    let sIdx = 0, bd = Infinity;
    const ref = prevEnd || BASE.gcj;
    for (let i = 0; i < cl.length; i++) { const d = distM(ref, cl[i].gcj); if (d < bd) { bd = d; sIdx = i; } }
    return nn2opt(cl, sIdx);
  }
  function chainLenKm(chain) { let s = 0; for (let i = 1; i < chain.length; i++) s += distM(chain[i - 1].gcj, chain[i].gcj); return s / 1000; }
  const MIN_CHAIN_KM = 28; // 簇链直线下限（<28 → 实际 <40km，太短）
  const fillerUsed = new Set();
  const chains = [];
  let prevEnd = null;
  for (const cl of clusters) {
    if (cl.length < 4) { // 太小的簇并给上一条
      if (chains.length) chains[chains.length - 1].push(...cl);
      continue;
    }
    let chain = planCluster(cl, prevEnd);
    // 链太短：吸收离簇中心最近且未用的 pr≥3 递补点
    let guard = 0;
    while (chainLenKm(chain) < MIN_CHAIN_KM && guard++ < 30) {
      const centroid = [chain.reduce((s, p) => s + p.gcj[0], 0) / chain.length, chain.reduce((s, p) => s + p.gcj[1], 0) / chain.length];
      const cand = filler.filter((c) => (c.pr || 0) >= 3 && !fillerUsed.has(c.key))
        .map((c) => ({ c, d: distM(centroid, c.gcj) })).sort((x, y) => x.d - y.d)[0];
      if (!cand || cand.d > 6000) break; // 递补点离簇 >6km 不硬拽（会把链拉成大跨度折返）
      fillerUsed.add(cand.c.key);
      chain.push(cand.c);
      chain = nn2opt(chain, null);
      // 重新以衔接点开头
      let sIdx = 0, bd2 = Infinity;
      for (let i = 0; i < chain.length; i++) { const d = distM(prevEnd || BASE.gcj, chain[i].gcj); if (d < bd2) { bd2 = d; sIdx = i; } }
      chain = nn2opt(chain, sIdx);
    }
    chains.push(chain);
    prevEnd = chain[chain.length - 1].gcj;
    console.log(`  [chain] ${chains.length} 号链 ${chain.length} 点 · 直线 ${chainLenKm(chain).toFixed(1)}km`);
  }
  console.log(`[chains] ${chains.length} 条 · 直线合计 ${chains.reduce((s, c) => s + chainLenKm(c), 0).toFixed(0)}km（×~1.4 绕行 ≈ ${(chains.reduce((s, c) => s + chainLenKm(c), 0) * 1.4).toFixed(0)}km 实际目标）`);

  const groups = chains;

  // ⑤ 逐条逐段调高德：每条 3 段，站点在 1/3、2/3 处
  async function planRoute(g, gi) {
    const n3 = Math.max(1, Math.floor(g.length / 3));
    const cut1 = Math.min(n3, g.length - 2), cut2 = Math.min(2 * n3, g.length - 1);
    const stations = [g[0], g[cut1], g[cut2], g[g.length - 1]];
    const legs = [[0, cut1], [cut1, cut2], [cut2, g.length - 1]];
    let distKm = 0, durMin = 0, roads = [], poly = [];
    const legsOut = [];
    for (let li = 0; li < legs.length; li++) {
      const [a, b] = legs[li];
      const seg = g.slice(a, b + 1);
      // 段内途经点：站间锚点，>7 个时等距抽稀到 7
      let via = seg.slice(1, -1).map((p) => p.gcj);
      if (via.length > 7) {
        const keep = [];
        for (let k = 0; k < 7; k++) keep.push(via[Math.round((k * (via.length - 1)) / 6)]);
        via = keep;
      }
      const r = await driveRoute(seg[0].gcj, via, seg[seg.length - 1].gcj);
      apiCalls++;
      if (!r) { console.log(`  R${gi + 1} 段${li + 1} 规划失败`); return null; }
      distKm += r.distKm; durMin += r.durMin;
      roads.push(...r.roads); poly.push(...r.poly);
      legsOut.push({ from: seg[0].name, to: seg[seg.length - 1].name, via: via.length, distKm: r.distKm, durMin: r.durMin });
    }
    roads = [...new Set(roads)].slice(0, 15);
    return {
      idx: gi + 1, name: `DR-${String(gi + 1).padStart(2, '0')}`,
      stops: stations.map((p) => ({ kind: p.kind, label: p.label, name: p.name, gcj: p.gcj })),
      anchors: g.map((p) => ({ kind: p.kind, label: p.label, name: p.name, pr: p.pr || null })),
      legs: legsOut, distKm: +distKm.toFixed(1), durMin, roads, poly,
      uri: amapUri(stations.map((p) => ({ gcj: p.gcj, name: p.name }))),
    };
  }
  let results = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const r = await planRoute(groups[gi], gi);
    if (r) { results.push(r); console.log(`  R${gi + 1} ${r.distKm}km / ${r.durMin}min · ${r.stops.map((p) => p.name).join(' → ')}`); }
  }
  let totalKm = +results.reduce((s, r) => s + r.distKm, 0).toFixed(1);

  // ⑤b 里程不足 → 簇间补：从 filler(pr≥3) 里按离现有路线走廊最近成新簇（≥8 点成链），
  //    追加为新的 deeproute，直到达标或无可成簇的点（不再往已有链里塞点搅乱 2-opt）。
  //    新链 ≥25km 实际才收（fill-16~20 出过 0.7km 垃圾条：种子挑的是「离走廊最近」
  //    的点——全在路线上，规划出来 1km —— 改为挑「离走廊 2km 外」的点才成新区域）
  let round = 0;
  let fillPrMin = 3; // 前几轮 pr≥3；耗尽后降 2（停车场/加油站仍有进出匝/收费杆场景价值）
  while (totalKm < TARGET_TOTAL_KM * 0.95 && round++ < 10) {
    const allPts = [];
    for (const r of results) { const p = r.poly; for (let k = 0; k < p.length; k += Math.max(1, Math.floor(p.length / 400))) allPts.push(p[k]); }
    const remain = filler.filter((c) => (c.pr || 0) >= fillPrMin && !fillerUsed.has(c.key) && !chains.some((ch) => ch.includes(c)));
    if (remain.length < 8) break;
    // 种子：离走廊 2km 外（开新区域）的点里 pr 最高者；失败则逐步降距离阈值
    // 大簇上限：两簇中心 <8km 时合并会让两链叠在同一个城区（15 簇时 R1/R4 都扫江南-江北），
    // 减 K 拉大簇间距离，链变长（簇点多）→ 单条更接近 60km
    let seed = null, extra = null;
    for (const far of [2000, 1000, 0]) {
      const cands = remain.map((c) => { let d = Infinity; for (const p of allPts) { const t = distM(p, c.gcj); if (t < d) d = t; } return { c, d }; })
        .filter((x) => x.d > far).sort((x, y) => y.c.pr - x.c.pr || x.d - y.d);
      if (!cands.length) continue;
      seed = cands[0];
      extra = remain.filter((c) => c !== seed.c).sort((x, y) => distM(seed.c.gcj, x.gcj) - distM(seed.c.gcj, y.gcj)).slice(0, 17);
      break;
    }
    if (!seed) break;
    const newChain = nn2opt([seed.c, ...extra], null);
    const gi = groups.length;
    const r = await planRoute(newChain, gi);
    if (!r || r.distKm < 20) { console.log(`[fill-${round}] 候选簇仅 ${r ? r.distKm : 0}km，弃（pr≥${fillPrMin} 耗尽）`);
      if (fillPrMin > 2) { fillPrMin--; round--; continue; } // 降级再试一轮
      break; }
    // fill 新条的起点不要求衔接（开新区域天然有转场），记录转场距离
    const prevEnd = results.length ? results[results.length - 1].poly[results[results.length - 1].poly.length - 1] : null;
    if (prevEnd) console.log(`    （转场 ${ (distM(prevEnd, newChain[0].gcj) / 1000).toFixed(1)}km）`);
    for (const c of newChain) fillerUsed.add(c.key);
    groups.push(newChain);
    results.push(r);
    totalKm = +results.reduce((s, x) => s + x.distKm, 0).toFixed(1);
    console.log(`[fill-${round}] 新增 DR-${gi + 1} ${r.distKm}km（${newChain.length} 点）· 总 ${totalKm}km`);
  }

  const totalPr = results.reduce((s, r) => s + r.anchors.reduce((x, a) => x + (a.pr || 0), 0), 0);
  console.log(`\n[done] ${results.length} 条 · 总 ${totalKm}km · 目标 ${TARGET_TOTAL_KM}km · pr 覆盖 ${totalPr}/${[...pool.values()].reduce((s, c) => s + (c.pr || 0), 0)}`);

  // ⑤c 池外增补（fill 簇耗尽仍不足）：从源数据直采「未进池/未进链」的点
  //    （markets/fireStations/bridges/construction/busDepots 全量 kd 通过者，实测 556 个 pr 2201）
  //    补充到 filler，再走一轮簇生长。
  if (totalKm < TARGET_TOTAL_KM * 0.95) {
    const usedNames = new Set(results.flatMap((r) => r.anchors.map((a) => a.name)));
    const extraSets = [
      ['amap_markets', 'markets', '市场', 4], ['amap_fire_stations', 'fireStations', '消防站', 3],
      ['amap_schools', 'schools', '学校', 7], ['amap_hospitals', 'hospitals', '医院', 7],
      ['amap_interchanges', 'interchanges', '立交桥', 6],
    ];
    let extraN = 0;
    for (const [f, kind, label, pr] of extraSets) {
      let d; try { d = readData(f); } catch { continue; }
      for (const p of d.pois || []) {
        const [lo, la] = String(p.location).split(',').map(Number);
        if (!isFinite(lo) || usedNames.has(p.name) || inHC(lo, la) !== null && false) continue;
        if (!inHC(lo, la)) continue;
        const w = SA.gcj2wgs([lo, la]);
        if (KD.nearestDevWGS(w[0], w[1], 80) > 80) continue;
        const key = `${kind}:${p.name}`;
        if (pool.has(key) || usedNames.has(p.name)) continue;
        const c = { kind, label, name: p.name, pr, wgs: w, gcj: [lo, la], key };
        pool.set(key, c); filler.push(c); extraN++;
      }
    }
    const OSM_EXTRA = [
      ['bridges', 'bridges', '桥梁', 4, true], ['construction', 'construction', '施工路段', 6, false],
      ['probe_busdepot', 'busDepots', '公交场站', 3, false], ['footbridges', 'footbridges', '人行天桥', 5, false],
    ];
    for (const [f, kind, label, pr, rail] of OSM_EXTRA) {
      let d; try { d = readData(f); } catch { continue; }
      for (const el of d.elements) {
        const c = coordOf(el);
        const nm = (el.tags || {}).name || '';
        if (!c || !nm || (rail && RAIL_MOTORWAY_NAME.test(nm)) || usedNames.has(nm)) continue;
        if (!inHC(c[0], c[1])) continue;
        if (KD.nearestDevWGS(c[0], c[1], 80) > 80) continue;
        const key = `${kind}:${nm}`;
        if (pool.has(key)) continue;
        const cc = { kind, label, name: nm, pr, wgs: c, gcj: SA.wgs2gcj(c), key };
        pool.set(key, cc); filler.push(cc); extraN++;
      }
    }
    console.log(`[fill-x] 池外增补 ${extraN} 点（未进链的直采源）· filler 现 ${filler.length}`);
    // 补进已有的短链（<50km 实际的条）：按离该条链质心最近插入后局部 2opt
    for (let gi = 0; gi < groups.length && totalKm < TARGET_TOTAL_KM; gi++) {
      const g = groups[gi];
      const cur = results[gi];
      if (!cur || cur.distKm >= 55) continue;
      const centroid = [g.reduce((s, p) => s + p.gcj[0], 0) / g.length, g.reduce((s, p) => s + p.gcj[1], 0) / g.length];
      let guard = 0;
      while (results[gi].distKm < 58 && guard++ < 20) {
        const cand = filler.filter((c) => !fillerUsed.has(c.key) && !g.includes(c))
          .map((c) => ({ c, d: distM(centroid, c.gcj) })).sort((x, y) => x.d - y.d)[0];
        if (!cand || cand.d > 5000) break;
        fillerUsed.add(cand.c.key);
        g.push(cand.c);
        // 局部重排：保持首点（衔接锚点），其余 NN+2opt
        const head = g[0];
        const rest = nn2opt(g.slice(1), null);
        groups[gi] = [head, ...rest];
        const r2 = await planRoute(groups[gi], gi);
        apiCalls++;
        if (r2 && r2.distKm > results[gi].distKm) { results[gi] = r2; console.log(`  [boost] DR-${gi + 1} ${results[gi].distKm}km (+${(r2.distKm - cur.distKm >= 0 ? '' : '')}${(results[gi].distKm - (gi > 0 ? results[gi - 1].distKm : 0) > 0 ? '' : '')})`); }
        else if (r2) results[gi] = r2; else { g.pop(); break; }
        totalKm = +results.reduce((s, x) => s + x.distKm, 0).toFixed(1);
      }
    }
    console.log(`[fill-x] 短链增补后总 ${totalKm}km`);
  }

  // ⑥ 快照
  fs.writeFileSync(path.join(OUT, 'deeproute_plan.json'), JSON.stringify({
    generated: new Date().toISOString(),
    source: 'plan_deeproute.js · 池=排班260锚点+全区直采（区内+宽凳80m闸门）· KMeans 分簇一簇一线 · 簇内 NN+2opt 串珠 · 3段4站点/条 · Amap strategy=3',
    target: { totalKm: TARGET_TOTAL_KM, routeKm: ROUTE_KM, minKm: MIN_ROUTE_KM, maxKm: MAX_ROUTE_KM },
    apiCalls, poolSize: pool.size,
    totalKm, totalPr, routes: results,
  }, null, 1));
  console.log(`[out] out/deeproute_plan.json 已写`);
  return { results, totalKm, totalPr };
}

main().catch((e) => { console.error(e); process.exit(1); });