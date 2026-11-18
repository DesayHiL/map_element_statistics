// 停靠点落点终查：① 距高德匝道/高速出入口 POI <60m；② 距信号灯/环岛中心 <25m（=落在路口上）
const fs = require('fs');
const plan = JSON.parse(fs.readFileSync('out/routes.json', 'utf8'));
const ramps = JSON.parse(fs.readFileSync('data/amap_ramps.json', 'utf8')).pois
  .filter((p) => (p.cityname || '').includes('惠州'))
  .map((p) => { const [lo, la] = p.location.split(',').map(Number); return [lo, la, p.name]; });

function flat(el) { const out = []; const arr = el.elements || el; for (const e of arr) { if (e.lat && e.lon) out.push([e.lon, e.lat]); if (e.geometry) for (const g of e.geometry) out.push([g.lon, g.lat]); } return out; }
const sigPts = flat(JSON.parse(fs.readFileSync('data/signals.json', 'utf8')));
const rbPts = flat(JSON.parse(fs.readFileSync('data/roundabout.json', 'utf8')));

const PI = Math.PI;
const dM = (a, b) => Math.hypot((a[0] - b[0]) * Math.cos(b[1] * PI / 180) * 111320, (a[1] - b[1]) * 111320);

console.log('==== A. 停靠点距匝道/高速出入口 POI <60m ====');
let a = 0;
for (const st of plan.routes) {
  if (!st.routes) continue;
  for (const r of st.routes) {
    const hits = [];
    for (const an of r.anchors || []) {
      if (!an.gcj) continue;
      for (const [lo, la, nm] of ramps) {
        const d = dM(an.gcj, [lo, la]);
        if (d < 60) hits.push(`${an.name} → ${nm} ${d.toFixed(0)}m`);
      }
    }
    if (hits.length) { a++; console.log(`[${st.street}] ${r.kind} ${r.distKm}km | ${hits.join(' ; ')}`); }
  }
}
if (!a) console.log('(无)');

console.log('\n==== B. 停靠点距信号灯/环岛中心 <25m ====');
let b = 0;
for (const st of plan.routes) {
  if (!st.routes) continue;
  for (const r of st.routes) {
    const hits = [];
    for (const an of r.anchors || []) {
      if (!an.gcj) continue;
      let ds = 1e9, db = 1e9;
      for (const p of sigPts) ds = Math.min(ds, dM(an.gcj, p));
      for (const p of rbPts) db = Math.min(db, dM(an.gcj, p));
      const d = Math.min(ds, db);
      if (d < 25) hits.push(`${an.name} → ${db < ds ? '环岛' : '信号灯'}中心 ${d.toFixed(0)}m`);
    }
    if (hits.length) { b++; console.log(`[${st.street}] ${r.kind} ${r.distKm}km\n  ${hits.join('\n  ')}`); }
  }
}
if (!b) console.log('(无)');
console.log('\nramp POIs:', ramps.length, 'signals:', sigPts.length, 'roundabouts:', rbPts.length);