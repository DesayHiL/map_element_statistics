// 把落在路口中心（信号灯/环岛 <15m）的 road 类停靠点，沿同名道路沿线偏移 40m（远离最近路口），写回 odd_plan.json + out/routes.json
const fs = require('fs');
const roads = JSON.parse(fs.readFileSync('data/roads.json', 'utf8')).elements;
const sig = JSON.parse(fs.readFileSync('data/signals.json', 'utf8'));
const sigArr = sig.elements || sig;
const rb = JSON.parse(fs.readFileSync('data/roundabout.json', 'utf8'));
const rbArr = rb.elements || rb;

const PI = Math.PI, A = 6378245.0, EE = 0.00669342162296594323;
function tLat(x, y) { let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x)); r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3; r += ((20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2) / 3; r += ((160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2) / 3; return r; }
function tLon(x, y) { let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x)); r += ((20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2) / 3; r += ((150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2) / 3; return r; }
function wgs2gcj(lon, lat) { const dL = tLat(lon - 105, lat - 35), dO = tLon(lon - 105, lat - 35); const rl = lat / 180 * PI; let mg = 1 - EE * Math.sin(rl) ** 2; mg = Math.sqrt(mg); return [lon + (dO * 180) / ((A / mg) * Math.cos(rl) * PI), lat + (dL * 180) / ((A * (1 - EE)) / (mg * mg) * PI)]; }
function gcj2wgs(lon, lat) { let wl = lon, wt = lat; for (let i = 0; i < 3; i++) { const dL = tLat(wl - 105, wt - 35), dO = tLon(wl - 105, wt - 35); const rl = wt / 180 * PI; let mg = 1 - EE * Math.sin(rl) ** 2; mg = Math.sqrt(mg); wl = lon - (dO * 180) / ((A / mg) * Math.cos(rl) * PI); wt = lat - (dL * 180) / ((A * (1 - EE)) / (mg * mg) * PI); } return [wl, wt]; }

const dM = (p, q) => Math.hypot((p[0] - q.lon) * Math.cos(q.lat * PI / 180) * 111320, (p[1] - q.lat) * 111320);
function distToJunction(wgs) {
  let best = 1e9;
  for (const e of sigArr) { const pts = e.lat ? [e] : (e.geometry || []); for (const q of pts) best = Math.min(best, dM(wgs, q)); }
  for (const e of rbArr) { const pts = e.lat ? [e] : (e.geometry || []); for (const q of pts) best = Math.min(best, dM(wgs, q)); }
  return best;
}
const distP = (a, b) => Math.hypot((a.lon - b.lon) * Math.cos(b.lat * PI / 180) * 111320, (a.lat - b.lat) * 111320);

const TODO = [ // [street, name, wgs]
  ['小金口街道', '金府路', [114.414172, 23.173666]],
  ['桥东街道', '东坡路', [114.419985, 23.093587]],
  ['桥东街道', '东平二街', [114.427607, 23.096352]],
  ['桥东街道', '小塘下', [114.414991, 23.089582]],
  ['桥西街道', '环城西路', [114.39812, 23.095185]],
  ['江北街道', '文华一路', [114.404969, 23.117625]],
  ['江北街道', '水北七路', [114.401989, 23.106976]],
  ['马安镇', '育贤路', [114.47143, 23.075419]],
  ['江南街道', '惠新大道', [114.38143, 23.117763]],
  ['龙丰街道', '金恺大道', [114.379343, 23.061865]],
  ['惠环街道', '惠风七路', [114.351511, 23.045797]],
  ['水口街道', '东和南路', [114.545161, 23.130963]],
];

const changes = [];
for (const [street, name, wgs] of TODO) {
  // 在同名道路 ways 上：找离 wgs 最近的点，然后往两端各试 40m，取距路口更远的一侧
  const ways = roads.filter((w) => ((w.tags || {}).name || '') === name);
  let best = null; // {pt, jd}
  for (const w of ways) {
    const g = w.geometry;
    let bi = 0, bd = 1e9;
    g.forEach((p, i) => { const d = distP(p, { lon: wgs[0], lat: wgs[1] }); if (d < bd) { bd = d; bi = i; } });
    if (bd <= 30) {
    for (const dir of [1, -1]) {
      let acc = 0;
      for (let i = bi; i + dir >= 0 && i + dir < g.length; i += dir) {
        acc += distP(g[i], g[i + dir]);
        if (acc >= 40) { const jd = distToJunction([g[i + dir].lon, g[i + dir].lat]); if (!best || jd > best.jd) best = { pt: g[i + dir], jd }; break; }
      }
    }
    }
  }
  if (!best) { console.log('!! 未找到可偏移点:', street, name); continue; }
  // 密集信号路段：若 40m 点距路口仍 <100m，沿线 400m 内找距路口>100m 的最近点
  if (best.jd < 100) {
    let cands = [];
    for (const w of ways) for (const p of w.geometry) {
      const d0 = Math.hypot((p.lon - wgs[0]) * Math.cos(wgs[1] * PI / 180) * 111320, (p.lat - wgs[1]) * 111320);
      if (d0 < 800) cands.push({ p, d0, jd: distToJunction([p.lon, p.lat]) });
    }
    cands.sort((a, b) => a.d0 - b.d0);
    const safe = cands.find((c) => c.jd > 100);
    if (safe) best = { pt: safe.p, jd: safe.jd };
  }
  const ngcj = wgs2gcj(best.pt.lon, best.pt.lat);
  changes.push({ street, name, wgs, newWgs: [best.pt.lon, best.pt.lat], newGcj: [Number(ngcj[0].toFixed(6)), Number(ngcj[1].toFixed(6))], jd: Math.round(best.jd) });
}
console.log('==== 偏移方案（沿线 40m，取远离路口侧）====');
for (const c of changes) console.log(`[${c.street}] ${c.name}: wgs(${c.wgs}) -> (${c.newWgs.map(x => x.toFixed(6))}) 距最近路口 ${c.jd}m`);

if (process.argv[2] === 'apply') {
  const odd = JSON.parse(fs.readFileSync('odd_plan.json', 'utf8'));
  let n = 0;
  for (const r of odd) {
    for (const st of r.stations || []) {
      const m = changes.find((c) => r.street === c.street && st.sname && st.sname.includes('-' + c.name + '') && Math.abs(st.lng - wgs2gcj(c.wgs[0], c.wgs[1])[0]) < 1e-3);
      // odd_plan 用 gcj；按名称+街道+旧gcj(由wgs转)匹配，容差 1e-3 (~100m) 可能误伤，收紧：再比 lat
      if (m) { const og = wgs2gcj(m.wgs[0], m.wgs[1]); if (Math.abs(st.lat - og[1]) < 1e-3) { st.lng = m.newGcj[0]; st.lat = m.newGcj[1]; n++; } }
    }
    for (const wp of r.waypoints || []) {
      const m = changes.find((c) => r.street === c.street && Math.abs(wp.lng - wgs2gcj(c.wgs[0], c.wgs[1])[0]) < 1e-3 && Math.abs(wp.lat - wgs2gcj(c.wgs[0], c.wgs[1])[1]) < 1e-3);
      if (m) { wp.lng = m.newGcj[0]; wp.lat = m.newGcj[1]; n++; }
    }
  }
  const plan = JSON.parse(fs.readFileSync('out/routes.json', 'utf8'));
  let m2 = 0;
  for (const st of plan.routes) {
    if (!st.routes) continue;
    for (const r of st.routes) {
      for (const an of r.anchors || []) {
        const m = changes.find((c) => st.street === c.street && an.name === c.name && an.wgs && Math.abs(an.wgs[0] - c.wgs[0]) < 1e-4 && Math.abs(an.wgs[1] - c.wgs[1]) < 1e-4);
        if (m) { an.gcj = m.newGcj; an.wgs = [Number(m.newWgs[0].toFixed(7)), Number(m.newWgs[1].toFixed(7))]; m2++; }
      }
    }
  }
  console.log('odd_plan 更新站点:', n, '| routes.json anchors 更新:', m2, '(期望 12/若跨线共用则站点多于12)');
  if (m2 !== 12) console.log('!! anchors 命中数异常，检查后再说');
  fs.writeFileSync('odd_plan.json', JSON.stringify(odd, null, 2));
  fs.writeFileSync('out/routes.json', JSON.stringify(plan, null, 2));
  console.log('saved.');
}