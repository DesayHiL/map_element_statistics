// 腾讯复刻高德路线：最小途经点搜索
// 策略：锚点打底迭代补钉收敛 → 贪心删点（删了仍 avgDev<=60 且里程差<=5% 就删）→ 得最小途经点集
// 用法: node tencent_route_minwp.js            全量
//       node tencent_route_minwp.js 0 0        指定
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const TKEY = 'XXYBZ-OEHLM-HGF6Y-66PHP-APSIT-SWBFQ';
const MAX_WP = 30;
const H_OK = 60;          // avgDev 阈值
const KM_TOL = 0.05;      // 里程差容忍 5%

const R = 111320;
function distM(a, b) { const dx = (a[0] - b[0]) * R * Math.cos(a[1] * Math.PI / 180), dy = (a[1] - b[1]) * R; return Math.hypot(dx, dy); }
function d2p(pt, poly) {
  let best = 1e9, bi = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1];
    const k = R * Math.cos(pt[1] * Math.PI / 180);
    const dx = (b[0] - a[0]) * k, dy = (b[1] - a[1]) * R;
    const px = (pt[0] - a[0]) * k, py = (pt[1] - a[1]) * R;
    const L2 = dx * dx + dy * dy;
    let t = L2 ? (px * dx + py * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - t * dx, py - t * dy);
    if (d < best) { best = d; bi = i; }
  }
  return { d: best, bi };
}
function hausAvg(A, B) {
  let s = 0, n = 0;
  for (let i = 0; i < A.length; i += 3) { s += d2p(A[i], B).d; n++; }
  for (let i = 0; i < B.length; i += 3) { s += d2p(B[i], A).d; n++; }
  return s / n;
}
function decode(raw) {
  const pts = [[raw[1], raw[0]]];
  for (let i = 2; i < raw.length; i += 2) { const p = pts[pts.length - 1]; pts.push([+(p[0] + raw[i + 1] / 1e6).toFixed(6), +(p[1] + raw[i] / 1e6).toFixed(6)]); }
  return pts;
}
async function tcRoute(from, to, wps) {
  let u = 'https://apis.map.qq.com/ws/direction/v1/driving/?from=' + from[1] + ',' + from[0] + '&to=' + to[1] + ',' + to[0];
  if (wps.length) u += '&waypoints=' + wps.map(w => w[1] + ',' + w[0]).join(';');
  u += '&key=' + TKEY;
  const j = await (await fetch(u)).json();
  if (j.status !== 0) throw new Error('tencent ' + j.status + ' ' + j.message);
  const rt = j.result.routes[0];
  return { poly: decode(rt.polyline), km: rt.distance / 1000 };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function convergeMinWp(amap, from, to, anchorWps) {
  // anchorWps: 必须保留的中途锚点（工况 POI 测试点），标记 locked，绝不删
  let wps = anchorWps.map(p => ({ pt: p, locked: true }));
  // Phase1: 收敛（偏离段首/中/尾补钉）
  let ok = null;
  for (let round = 1; round <= 8; round++) {
    const r = await tcRoute(from, to, wps.map(w => w.pt));
    const h = hausAvg(amap, r.poly);
    if (h <= H_OK) { ok = { h, km: r.km, wps: wps.slice() }; break; }
    if (wps.length >= MAX_WP) { ok = { h, km: r.km, wps: wps.slice() }; break; }
    const segs = []; let cur = null;
    for (let i = 0; i < r.poly.length; i += 2) {
      const d = d2p(r.poly[i], amap).d;
      if (d > 20) { if (!cur) cur = { from: i, to: i }; else cur.to = i; } else if (cur) { segs.push(cur); cur = null; }
    }
    if (cur) segs.push(cur);
    let added = 0;
    for (const s of segs) {
      if (distM(r.poly[s.from], r.poly[s.to]) < 150) continue;
      for (const idx of [s.from, Math.floor((s.from + s.to) / 2), s.to]) {
        if (wps.length >= MAX_WP) break;
        const near = d2p(r.poly[idx], amap);
        const pt = amap[Math.min(amap.length - 1, Math.max(0, near.bi + (idx === s.from ? 2 : 0)))];
        if (wps.every(w => distM(w.pt, pt) > 60)) { wps.push({ pt, locked: false }); added++; }
      }
    }
    if (!added) { ok = { h, km: r.km, wps: wps.slice() }; break; }
    wps.sort((a, b) => d2p(a.pt, amap).bi - d2p(b.pt, amap).bi);
  }
  if (!ok) ok = { h: 1e9, km: 0, wps };
  // Phase2: 贪心删点 —— 只删补钉点(locked=false)，锚点绝不删
  let cur = ok.wps;
  let last = ok;
  let i = 0;
  while (i < cur.length) {
    if (cur[i].locked) { i++; continue; }
    const trial = cur.slice(); trial.splice(i, 1);
    const r = await tcRoute(from, to, trial.map(w => w.pt));
    const h = hausAvg(amap, r.poly);
    if (h <= H_OK && Math.abs(r.km / kmOf(amap) - 1) <= KM_TOL) { cur = trial; last = { h, km: r.km }; }
    else i++;
  }
  return { h: last.h, km: last.km, wps: cur.map(w => w.pt), converged: last.h <= H_OK };
}
function kmOf(poly) {
  let s = 0; for (let i = 1; i < poly.length; i++) s += distM(poly[i - 1], poly[i]);
  return s / 1000;
}

(async () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/routes.json'), 'utf8'));
  const si = process.argv[2] !== undefined ? +process.argv[2] : -1;
  const jobs = [];
  if (si < 0) (data.routes || []).forEach((s, i) => (s.routes || []).forEach((_, ri) => jobs.push([i, ri])));
  else jobs.push([si, +(process.argv[3] || 0)]);

  const all = [];
  for (const [i, ri] of jobs) {
    const st = data.routes[i], rr = st.routes[ri];
    const amap = rr.poly, from = amap[0], to = amap[amap.length - 1];
    const base = rr.anchors.map(a => a.gcj).slice(1, -1);
    try {
      const res = await convergeMinWp(amap, from, to, base);
      const rec = {
        street: st.street, routeIdx: ri, amapKm: rr.distKm, tcKm: +res.km.toFixed(2),
        avgDevM: +res.h.toFixed(1), kmDiff: +(res.km / rr.distKm - 1).toFixed(3),
        minWaypoints: res.wps.length, anchorCount: rr.anchors.length,
        converged: res.converged, waypoints: res.wps,
      };
      all.push(rec);
      console.log(`${st.street} #${ri} amap=${rr.distKm}km tc=${rec.tcKm}km dev=${rec.avgDevM}m wp=${rec.minWaypoints} ${rec.converged ? '✓' : '✗'}`);
    } catch (e) { all.push({ street: st.street, routeIdx: ri, err: e.message }); console.log(st.street + ' #' + ri + ' ERR ' + e.message); }
    fs.writeFileSync(path.join(ROOT, 'out/tencent_minwp_result.json'), JSON.stringify(all, null, 1));
    await sleep(300);
  }
  const ok = all.filter(r => r.converged);
  console.log(`\nTOTAL ${all.length} 收敛 ${ok.length}  wp: min=${Math.min(...ok.map(r=>r.minWaypoints))} max=${Math.max(...ok.map(r=>r.minWaypoints))} avg=${(ok.reduce((s,r)=>s+r.minWaypoints,0)/ok.length).toFixed(1)}`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });