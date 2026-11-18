// -*- coding: utf-8 -*-
// 返程实测 + 返程路线规划：把「空间层 = 2 × 单程」这个**假设**换成**真算一遍返程**。
//
// 起因（2026-10-16 用户）：
//   ①「正向 1244.9km，但你直接 ×2 是不对的，你也要把路线规划出来？去程和返程？」
//   ②「你的排班路线只把规定了去程，再把返程的路线也规划进去？」
//
// 实情：out/routes.json 每条腿是**单程**（from=基地 → via=… → to=终点锚点），
//   同街道内多腿**首尾相接**（leg0 终点 == leg1 起点），所以一个街道 = 一条
//   基地 → 最终锚点 的连续单向路径。返程必须**把整条锚点链倒序后重新算路** ——
//   路网有单行/匝道/禁左，返程里程 ≠ 去程里程（实测同一对点 24.5 vs 26.5km）。
//
// v2（本版）新增：不只算返程里程，还把**返程路线**（锚点链倒序 + 高德实算的
//   道路名/几何折线/导航链接）落成与 routes.json 同构的 out/routes_return.json，
//   供报告与地图消费 —— 即「返程的路线也规划进去」。
//   同时给出 overlap：返程折线落在去程走廊 25m 内的点占比，量化「返程是否只是原路折回」。
//
// 产出：
//   out/route_return_legs.json —— 里程汇总（去程/返程/空间层），供里程口径消费
//   out/routes_return.json     —— 返程路线集（与 routes.json 同构，dir='return'）
//
// 缓存：坐标哈希为键，重复跑不重复请求高德。cacheV 变更会全量重算（拿到几何）。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nextKey } = require('../amap_key');

const B = path.join(__dirname, '..');
const OUT = path.join(B, 'out');
const CACHE = path.join(OUT, 'route_return_legs.json');
const ROUTES_RETURN = path.join(OUT, 'routes_return.json');
const CACHE_V = 2; // v2：缓存条目含 roads/poly/uri（几何）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
const f1 = (v) => +Number(v).toFixed(1);

async function drive(origin, waypoints, dest) {
  const qs = new URLSearchParams({
    key: nextKey(), origin: fmt(origin), destination: fmt(dest),
    extensions: 'all', strategy: '3', output: 'json',
  });
  if (waypoints.length) qs.set('waypoints', waypoints.map(fmt).join(';'));
  const url = `https://restapi.amap.com/v3/direction/driving?${qs.toString()}`;
  for (let a = 0; a < 4; a++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const j = await res.json();
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
        return {
          distKm: +(Number(p.distance) / 1000).toFixed(1),
          durMin: Math.round(Number(p.duration) / 60),
          roads: roads.slice(0, 12), poly,
        };
      }
      if (j.infocode === '10001' || j.infocode === '10019') {
        console.error(`  [fatal] ${j.infocode} ${j.info}`); process.exit(1);
      }
    } catch (e) { /* 重试 */ }
    await sleep(700 * (a + 1));
  }
  return null;
}

// 一串锚点 → 去程/返程 的算路参数
function tripPoints(anchors) {
  const pts = anchors.filter((a) => Array.isArray(a.gcj) && a.gcj.length === 2).map((a) => a.gcj);
  if (pts.length < 2) return null;
  return {
    fwd: { origin: pts[0], dest: pts[pts.length - 1], via: pts.slice(1, -1) },
    rev: { origin: pts[pts.length - 1], dest: pts[0], via: pts.slice(1, -1).reverse() },
    hash: crypto.createHash('sha1').update(pts.map(fmt).join(';')).digest('hex').slice(0, 16),
  };
}

// 同街道多腿首尾相接 → 拼成整条链（去重接缝上的重复锚点）
function chainOf(legs) {
  const chain = [];
  for (const L of legs) {
    let a = (L.anchors || []).slice();
    if (chain.length && a.length) {
      const p = chain[chain.length - 1];
      const same = p && a[0] && Array.isArray(p.gcj) && Array.isArray(a[0].gcj)
        && p.gcj[0] === a[0].gcj[0] && p.gcj[1] === a[0].gcj[1];
      if (same) a = a.slice(1);
    }
    chain.push(...a);
  }
  return chain;
}

// 高德导航链接（与 routes.json 同构）
function amapUri(anchors) {
  const pts = anchors.filter((a) => Array.isArray(a.gcj) && a.gcj.length === 2);
  if (pts.length < 2) return '';
  const nm = (a) => encodeURIComponent(a.name || a.n || '途经点');
  const head = `https://uri.amap.com/navigation?from=${fmt(pts[0].gcj)},${nm(pts[0])}&to=${fmt(pts[pts.length - 1].gcj)},${nm(pts[pts.length - 1])}`;
  const via = pts.slice(1, -1).map((a) => `${fmt(a.gcj)},${nm(a)}`).join(';');
  return via ? `${head}&via=${via}&mode=car&policy=1&src=return` : `${head}&mode=car&policy=1&src=return`;
}

// ⚠️ 高德 v3 driving 的 waypoints **上限 16 个**。整链倒序会超限（桥东 29 / 水口 25 / 三栋 20），
// 超出的 waypoint 被丢 → 返程被算短（曾得桥东 58.5 vs 去程 98.4，-40%，是错的）。
// 正确做法：**逐腿倒序**（每条腿 ≤8 waypoints），与去程「逐腿独立算路再求和」完全对称。
const WAYPOINT_CAP = 16;

// ---- 几何重合度：返程折线落在去程走廊 25m 内的点占比 ----
const MX = 111320 * Math.cos((23.16 * Math.PI) / 180);
const MY = 110574;
const NEAR_M = 25;
const BUCKET_M = 60;
const cellOf = (p) => `${Math.floor((p[0] * MX) / BUCKET_M)},${Math.floor((p[1] * MY) / BUCKET_M)}`;
function makeIndex(polys) {
  const idx = new Map();
  for (const poly of polys) for (const p of poly) {
    const k = cellOf(p);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(p);
  }
  return idx;
}
function overlapRatio(idx, poly) {
  if (!poly.length) return null;
  let hit = 0;
  for (const p of poly) {
    const cx = Math.floor((p[0] * MX) / BUCKET_M), cy = Math.floor((p[1] * MY) / BUCKET_M);
    let best = Infinity;
    for (let dx = -1; dx <= 1 && best >= NEAR_M; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = idx.get(`${cx + dx},${cy + dy}`);
        if (!arr) continue;
        for (const q of arr) {
          const d2 = ((p[0] - q[0]) * MX) ** 2 + ((p[1] - q[1]) * MY) ** 2;
          if (d2 < best) best = d2;
        }
      }
    }
    if (best < NEAR_M * NEAR_M) hit++;
  }
  return hit / poly.length;
}

(async () => {
  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : { byHash: {} };
  cache.byHash = cache.byHash || {};
  if (cache.cacheV !== CACHE_V) { cache.byHash = {}; cache.cacheV = CACHE_V; }

  const routes = JSON.parse(fs.readFileSync(path.join(OUT, 'routes.json'), 'utf8'));
  const scen = JSON.parse(fs.readFileSync(path.join(OUT, 'scenario_routes_v2.json'), 'utf8'));

  let calls = 0, hit = 0;
  async function reverseOf(trip, label) {
    if (cache.byHash[trip.hash] && cache.byHash[trip.hash].revKm != null && cache.byHash[trip.hash].poly) { hit++; return cache.byHash[trip.hash]; }
    const r = await drive(trip.rev.origin, trip.rev.via, trip.rev.dest);
    calls++;
    if (!r) { console.error(`  [miss] ${label} 返程算路失败`); return { revKm: null, revDurMin: null, roads: [], poly: [] }; }
    cache.byHash[trip.hash] = { revKm: r.distKm, revDurMin: r.durMin, via: trip.rev.via.length, roads: r.roads, poly: r.poly };
    return cache.byHash[trip.hash];
  }

  // ---- 街道：逐腿倒序算返程（与去程同为逐腿独立算路，对称），并落成返程路线集 ----
  const streets = [];
  const outRoutes = [];
  let ovNum = 0, ovDen = 0; // 全局几何重合度
  for (const s of routes.routes) {
    const legs = (s.routes || []).filter((L) => L.kind && (L.anchors || []).length >= 2);
    if (!legs.length || s.status !== 'ok') {
      streets.push({ street: s.street, status: s.status, fwdKm: 0, revKm: null, bidirKm: null, nAnchors: 0, legs: [] });
      outRoutes.push({ street: s.street, status: s.status, routes: [], distKm: null, durMin: null, uri: '' });
      continue;
    }
    const fwdPolys = legs.map((L) => L.poly || []);
    const idx = makeIndex(fwdPolys);
    const fwdKm = f1(legs.reduce((a, L) => a + (L.distKm || 0), 0));
    const revLegs = [], retLegs = [];
    let revSum = 0, revDur = 0, bad = false;
    for (let i = 0; i < legs.length; i++) {
      const trip = tripPoints(legs[i].anchors);
      if (!trip) { bad = true; break; }
      if (trip.rev.via.length > WAYPOINT_CAP) { console.error(`  [cap!] ${s.street} leg${i} via=${trip.rev.via.length} 超限`); bad = true; break; }
      const rev = await reverseOf(trip, `${s.street} leg${i}`);
      if (rev.revKm == null) { bad = true; break; }
      revSum += rev.revKm; revDur += rev.revDurMin || 0;
      const revAnchors = (legs[i].anchors || []).slice().reverse();
      const ov = overlapRatio(idx, rev.poly || []);
      if (ov != null && (rev.poly || []).length) { ovNum += ov * rev.poly.length; ovDen += rev.poly.length; }
      revLegs.push({ i, fwdKm: f1(legs[i].distKm), revKm: rev.revKm, revDurMin: rev.revDurMin || null, via: trip.rev.via.length, roads: (rev.roads || []).slice(0, 8), overlap: ov == null ? null : +ov.toFixed(3) });
      retLegs.push({
        kind: 'return', targets: legs[i].targets || [], clsTags: legs[i].clsTags || [],
        chain: (legs[i].chain || []).slice().reverse(),
        anchors: revAnchors, distKm: f1(rev.revKm), durMin: rev.revDurMin || null,
        roads: rev.roads || [], poly: rev.poly || [], uri: amapUri(revAnchors),
      });
    }
    const revKm = bad ? null : f1(revSum);
    const bidir = revKm == null ? null : f1(fwdKm + revKm);
    const chain = chainOf(legs);
    const revChain = revLegs.length ? chainOf(retLegs) : [];
    streets.push({ street: s.street, status: 'ok', fwdKm, revKm, revDurMin: revDur || null, bidirKm: bidir, nAnchors: chain.length, legs: revLegs });
    outRoutes.push({
      street: s.street, status: revKm == null ? 'no-return' : 'ok', routes: retLegs,
      distKm: revKm, durMin: revDur || null, uri: revLegs.length ? amapUri(revChain) : '',
    });
    console.log(`  [street] ${s.street.padEnd(6)} 去程 ${fwdKm.toFixed(1)} + 返程 ${revKm == null ? '—' : revKm.toFixed(1)} = ${bidir == null ? '—' : bidir.toFixed(1)}km  (${legs.length} 腿 / ${chain.length} 锚点)`);
  }

  // ---- 场景：每条场景路线倒序算返程 ----
  const scenarios = [];
  const outScen = [];
  (scen.scenarioRoutes || []).forEach((L, i) => {
    const ok = L.status === 'ok' && (L.anchors || []).length >= 2;
    scenarios.push({ i, street: L.street, status: L.status, fwdKm: ok ? f1(L.distKm || 0) : 0, revKm: null, bidirKm: null });
  });
  for (const sc of scenarios) {
    const L = scen.scenarioRoutes[sc.i];
    if (sc.status !== 'ok') { outScen.push({ ...L, status: L.status }); continue; }
    const trip = tripPoints(L.anchors);
    if (!trip) { outScen.push({ ...L, status: 'no-return' }); continue; }
    const rev = await reverseOf(trip, `场景#${sc.i} ${sc.street}`);
    sc.revKm = rev.revKm; sc.revDurMin = rev.revDurMin || null;
    sc.bidirKm = rev.revKm == null ? null : f1(sc.fwdKm + rev.revKm);
    // 场景去程文件 scenario_routes_v2.json **不含 poly**，无法算走廊重合；宁缺勿假（不能拿空索引算出 0%）
    sc.overlap = (Array.isArray(L.poly) && L.poly.length && rev.poly && rev.poly.length)
      ? +overlapRatio(makeIndex([L.poly]), rev.poly).toFixed(3) : null;
    if (rev.revKm == null) { outScen.push({ ...L, status: 'no-return' }); continue; }
    const revAnchors = (L.anchors || []).slice().reverse();
    outScen.push({
      scenario: L.scenario, label: L.label, street: L.street, street2: L.street2, status: 'ok',
      anchors: revAnchors, distKm: f1(rev.revKm), durMin: rev.revDurMin || null,
      roads: rev.roads || [], uri: amapUri(revAnchors),
    });
    console.log(`  [scene ] #${sc.i} ${sc.street.padEnd(6)} 去程 ${sc.fwdKm.toFixed(1)} + 返程 ${rev.revKm.toFixed(1)} = ${sc.bidirKm == null ? '—' : sc.bidirKm.toFixed(1)}km  走廊重合 ${sc.overlap == null ? '—（去程无折线）' : (sc.overlap * 100).toFixed(0) + '%'}`);
  }

  const sum = (arr, k) => f1(arr.reduce((a, x) => a + (Number(x[k]) || 0), 0));
  const okStreets = streets.filter((s) => s.status === 'ok' && s.revKm != null);
  const okScen = scenarios.filter((s) => s.status === 'ok' && s.revKm != null);
  const totals = {
    streetFwdKm: sum(okStreets, 'fwdKm'), streetRevKm: sum(okStreets, 'revKm'), streetBidirKm: sum(okStreets, 'bidirKm'),
    scenFwdKm: sum(okScen, 'fwdKm'), scenRevKm: sum(okScen, 'revKm'), scenBidirKm: sum(okScen, 'bidirKm'),
  };
  totals.streetRevRatio = f1(100 * totals.streetRevKm / totals.streetFwdKm);
  const overlapAll = ovDen ? +(ovNum / ovDen).toFixed(3) : null;

  const out = {
    generated: new Date().toISOString().slice(0, 19).replace('T', ' '),
    source: 'Amap v3/direction/driving (strategy=3, 不走高速)',
    note: '返程 = 逐腿把锚点链倒序后重新算路（同 strategy=3）。与去程口径对称：去程也是逐腿独立算路再求和。',
    cities: '返程里程由路网单向约束决定，与去程不等（实测同一对点 24.5 vs 26.5km），故不得用 2×单程 近似。',
    cacheV: CACHE_V, apiCalls: calls, cacheHits: hit,
    byHash: cache.byHash,
    streetOverlap25m: overlapAll,
    streetOverlapNote: '仅街道：返程折线点落在去程折线 25m 内的占比（折线按 ~50m 采样，该值偏保守，只作诊断，不进报告正文）。',
    streets, scenarios, totals,
  };
  fs.writeFileSync(CACHE, JSON.stringify(out, null, 1));

  // 返程路线集：与 routes.json 同构（供报告/地图消费）
  const totalPoly = outRoutes.reduce((a, s) => a + (s.routes || []).reduce((b, L) => b + (L.poly || []).length, 0), 0);
  const routesReturnOut = {
    generated: out.generated,
    source: out.source,
    dir: 'return',
    note: '返程路线集：把每条去程腿的锚点链整体倒序后，用高德 v3/direction/driving（逐腿、strategy=3）重新规划得到；几何与道路名均为高德实算，非镜像复制。',
    streetOverlap25m: overlapAll,
    streets: outRoutes,
    scenarioRoutes: outScen,
  };
  fs.writeFileSync(ROUTES_RETURN, JSON.stringify(routesReturnOut, null, 1));

  console.log('\n=== 汇总 ===');
  console.log(`  街道：去程 ${totals.streetFwdKm} + 返程 ${totals.streetRevKm} = ${totals.streetBidirKm}km   (返程/去程 = ${totals.streetRevRatio}%)`);
  console.log(`  场景：去程 ${totals.scenFwdKm} + 返程 ${totals.scenRevKm} = ${totals.scenBidirKm}km`);
  console.log(`  返程几何落在去程走廊 25m 内的点占比：${overlapAll == null ? '—' : (overlapAll * 100).toFixed(1) + '%'}（越高越说明返程沿同一走廊折回，但里程仍按实算取值）`);
  console.log(`  旧口径（2×单程 假设）：街道 ${f1(2 * totals.streetFwdKm)}km · 场景加跑 ${f1(4 * totals.scenFwdKm)}km`);
  console.log(`  产出：${CACHE}`);
  console.log(`        ${ROUTES_RETURN}（${f1(totalPoly / 1000)}k 折线点 · ${outRoutes.reduce((a, s) => a + (s.routes || []).length, 0) + outScen.filter((x) => x.status === 'ok').length} 条返程腿）`);
  console.log(`  (API 调用 ${calls} · 缓存命中 ${hit})`);
})();
