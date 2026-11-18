// PoC：让腾讯驾车规划复刻高德路线 —— 从高德 poly 提取转弯/分岔点作为腾讯途经点，
// 调腾讯 direction/v1/driving 验证折线一致性，偏离处迭代补点。
// 用法: node tencent_route_poc.js [streetIdx] [routeIdxInStreet]
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const TKEY = 'XXYBZ-OEHLM-HGF6Y-66PHP-APSIT-SWBFQ';
const MAX_WP = 28;          // 腾讯 waypoints 上限 30，留余量给迭代补点
const TURN_DEG = 25;        // 转弯角阈值（度）：超过视为决策点
const SNAP_M = 20;          // 判定腾讯点贴上了高德线的容差（米）
const HAUSS_M = 60;         // 整线一致性：双侧平均 Hausdorff 距离阈值（米）

// ---------- 几何工具（GCJ-02，局部平面近似） ----------
const R = 111320;
function distM(a, b) { // [lon,lat] 米
  const dx = (a[0] - b[0]) * R * Math.cos(a[1] * Math.PI / 180);
  const dy = (a[1] - b[1]) * R;
  return Math.hypot(dx, dy);
}
function bearing(p1, p2) {
  const dx = (p2[0] - p1[0]) * R * Math.cos(p1[1] * Math.PI / 180);
  const dy = (p2[1] - p1[1]) * R;
  return Math.atan2(dy, dx);
}
function turnDeg(a, b, c) { // 在 b 点的转向角
  let d = Math.abs(bearing(b, c) - bearing(a, b)) * 180 / Math.PI;
  if (d > 180) d = 360 - d;
  return d;
}
function segDist(pt, a, b) { // 点到线段最近距离（米）+ 最近点
  const dx = (b[0] - a[0]) * R * Math.cos(pt[1] * Math.PI / 180);
  const dy = (b[1] - a[1]) * R;
  const px = (pt[0] - a[0]) * R * Math.cos(pt[1] * Math.PI / 180);
  const py = (pt[1] - a[1]) * R;
  const L2 = dx * dx + dy * dy;
  let t = L2 ? (px * dx + py * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = a[0] + t * (b[0] - a[0]), cy = a[1] + t * (b[1] - a[1]);
  return { d: Math.hypot(px - t * dx, py - t * dy), pt: [cx, cy], t };
}
function distToPoly(pt, poly) { // 点到折线最近距离
  let best = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const r = segDist(pt, poly[i], poly[i + 1]);
    if (r.d < best) best = r.d;
  }
  return best;
}
// 双侧平均 Hausdorff（对密集折线用采样近似即可）
function hausAvg(A, B, sample = 4) {
  let s = 0, n = 0;
  for (let i = 0; i < A.length; i += sample) { s += distToPoly(A[i], B); n++; }
  for (let i = 0; i < B.length; i += sample) { s += distToPoly(B[i], A); n++; }
  return s / n;
}

// ---------- 高德 poly → 决策点候选 ----------
// 思路：poly 先等距抽稀（高德 step 折点很密且含重合点），再按转向角取决策点。
function extractDecisionPoints(poly) {
  // 1. 抽稀：至少相隔 30m
  const thin = [poly[0]];
  for (let i = 1; i < poly.length - 1; i++) {
    if (distM(poly[i], thin[thin.length - 1]) >= 30) thin.push(poly[i]);
  }
  thin.push(poly[poly.length - 1]);
  // 2. 转向角 + 与上一个决策点间距（决策点至少隔 150m，避免匝道处连取一串）
  const pts = [{ pt: thin[0], why: 'start' }];
  let last = thin[0];
  for (let i = 1; i < thin.length - 1; i++) {
    const ang = turnDeg(thin[i - 1], thin[i], thin[i + 1]);
    if (ang >= TURN_DEG && distM(thin[i], last) >= 150) {
      pts.push({ pt: thin[i], why: 'turn ' + ang.toFixed(0) + '°' });
      last = thin[i];
    }
  }
  pts.push({ pt: thin[thin.length - 1], why: 'end' });
  return { thin, pts };
}

// 初始途经点 = 高德锚点中间点（POI 已在路网语义上）；迭代时只在偏离区段补钉高德线上的点
function initialWps(rr, decision) {
  const anc = rr.anchors.map(a => a.gcj);
  const base = anc.slice(1, -1); // 去掉起终点
  const wps = base.map(p => ({ pt: p, why: 'anchor' }));
  return wps; // 锚点打底即可；转弯点在路口易吸附错方向，只在迭代补钉偏离起点前的点
}

// ---------- 腾讯 API ----------
function decodePolyline(raw) {
  const pts = [[raw[1], raw[0]]]; // 腾讯数值对为 纬度,经度 → 转成 [lon,lat]
  for (let i = 2; i < raw.length; i += 2) {
    const p = pts[pts.length - 1];
    pts.push([+(p[0] + raw[i + 1] / 1e6).toFixed(6), +(p[1] + raw[i] / 1e6).toFixed(6)]);
  }
  return pts;
}
async function tencentDriving(from, to, wps) {
  let url = 'https://apis.map.qq.com/ws/direction/v1/driving/?from=' + from[1] + ',' + from[0] + '&to=' + to[1] + ',' + to[0];
  if (wps.length) url += '&waypoints=' + wps.map(w => w[1] + ',' + w[0]).join(';');
  url += '&key=' + TKEY;
  const r = await fetch(url);
  const j = await r.json();
  if (j.status !== 0) throw new Error('tencent ' + j.status + ' ' + j.message);
  const rt = j.result.routes[0];
  return { poly: decodePolyline(rt.polyline), distM: rt.distance, durS: rt.duration };
}

// ---------- 一致性检查：找腾讯线偏离高德线的连续区段 ----------
function findDeviations(amapPoly, tcPoly) {
  const dev = []; // {from,to} 腾讯折线下标区间（连续 dev>SNAP_M）
  let cur = null;
  for (let i = 0; i < tcPoly.length; i += 2) {
    const d = distToPoly(tcPoly[i], amapPoly);
    if (d > SNAP_M) { if (!cur) { cur = { from: i, to: i, maxD: d }; } else { cur.to = i; cur.maxD = Math.max(cur.maxD, d); } }
    else if (cur) { dev.push(cur); cur = null; }
  }
  if (cur) dev.push(cur);
  return dev;
}

(async () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/routes.json'), 'utf8'));
  const streetIdx = +(process.argv[2] !== undefined ? process.argv[2] : -1);
  const routeIdx = +(process.argv[3] || 0);
  const runAll = streetIdx < 0;
  const jobs = [];
  if (runAll) (data.routes || []).forEach((s, si) => (s.routes || []).forEach((_, ri) => jobs.push([si, ri])));
  else jobs.push([streetIdx, routeIdx]);

  const all = [];
  for (const [si, ri] of jobs) {
    const street = data.routes[si];
    const rr = street.routes[ri];
    const r = await pocOne(street, rr, si, ri);
    all.push(r);
    fs.writeFileSync(path.join(ROOT, 'out/tencent_poc_result.json'), JSON.stringify(all, null, 1));
  }
  const okN = all.filter(x => x.converged).length;
  console.log(`\nTOTAL ${all.length} routes, converged ${okN}, avgDev p50=${pct(all.map(x=>x.avgDevM),50)}m p90=${pct(all.map(x=>x.avgDevM),90)}m, wp avg=${(all.reduce((s,x)=>s+x.waypoints,0)/all.length).toFixed(1)}`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

function pct(arr, p) { const a = arr.slice().sort((x, y) => x - y); return a[Math.floor(a.length * p / 100)]; }

async function pocOne(street, _rr, streetIdx, routeIdx) {
  const rr = street.routes[routeIdx];
  console.log(`== ${street.street} #${routeIdx} ${rr.kind} anchors=${rr.anchors.length} amapDist=${rr.distKm}km poly=${rr.poly.length}pts`);

  const amap = rr.poly;
  const from = amap[0], to = amap[amap.length - 1];
  const { pts: decision } = extractDecisionPoints(amap);
  console.log(`decision points: ${decision.length}`);

  let extra = initialWps(rr, decision); // 锚点+稀疏转弯点打底，迭代时在偏离区段补钉
  let tPoly, result;
  for (let round = 1; round <= 6; round++) {
    const wps = extra;
    result = await tencentDriving(from, to, wps.map(w => w.pt));
    tPoly = result.poly;
    const h = hausAvg(amap, tPoly);
    const dev = findDeviations(amap, tPoly);
    const devKm = dev.reduce((s, d) => s + distM(tPoly[d.from], tPoly[d.to]), 0) / 1000;
    console.log(`round ${round}: wp=${wps.length} tcDist=${(result.distM / 1000).toFixed(1)}km amap=${rr.distKm}km avgDev=${h.toFixed(1)}m devSegs=${dev.length} devLen=${devKm.toFixed(2)}km`);
    if (h <= HAUSS_M) { console.log('CONVERGED ✓'); break; }
    // 补钉策略：不用偏离中点（往往在并行道路/路口易吸错），而是找偏离「起点」，
    // 沿高德线回溯到偏离前一个岔口，钉在岔口之后、高德线上的直路段中点。
    const add = [];
    for (const d of dev) {
      const devStart = tPoly[d.from];
      // 在高德线上找距偏离起点最近点
      let best = null, bi = 0;
      for (let i = 0; i < amap.length - 1; i++) {
        const r = segDist(devStart, amap[i], amap[i + 1]);
        if (!best || r.d < best.d) { best = r; bi = i; }
      }
      if (best.d > 400) continue; // 偏离起点离高德线太远（起点段问题），不钉
      // 回溯找最近岔口（转向角>45°），钉在其后 2~3 个点（已进入正确道路）
      let anchor = bi;
      for (let i = bi; i > Math.max(0, bi - 40); i--) {
        if (amap[i - 1] && amap[i + 1] && turnDeg(amap[i - 1], amap[i], amap[i + 1]) > 45) { anchor = i; break; }
        if (distM(amap[i], amap[bi]) > 300) break; // 最多回溯 300m
      }
      const target = Math.min(amap.length - 1, anchor + 3);
      const pt = amap[target];
      if (extra.some(w => distM(w.pt, pt) < 150)) continue;
      add.push({ pt, why: 'fix' });
      if (extra.length + add.length >= MAX_WP) break;
    }
    if (!add.length) { console.log('no more room / no progress'); break; }
    // 关键：途经点必须按路线顺序传给腾讯（腾讯按顺序依次经过），按高德线位置重排
    extra = extra.concat(add).slice(0, MAX_WP);
    const idxOf = new Map();
    amap.forEach((p, i) => idxOf.set(p, i));
    const withIdx = extra.map(w => {
      // 找该点在高德线上的最近下标
      let best = 0, bd = Infinity;
      for (let i = 0; i < amap.length; i++) { const d = distM(w.pt, amap[i]); if (d < bd) { bd = d; best = i; } }
      return { w, i: best };
    });
    withIdx.sort((a, b) => a.i - b.i);
    extra = withIdx.map(x => x.w);
  }

  const h = hausAvg(amap, tPoly);
  const out = {
    street: street.street, routeIdx, amapKm: rr.distKm,
    tencentKm: +(result.distM / 1000).toFixed(2), avgDevM: +h.toFixed(1),
    converged: h <= HAUSS_M,
    waypoints: extra.length,
    tcPolyCount: tPoly.length,
    tcWaypoints: extra.map(w => w.pt), // 最终钉点，供后续复用
  };
  return out;
}
