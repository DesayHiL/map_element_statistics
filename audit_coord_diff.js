// 坐标纠偏对街道级分布的影响（只读）：决定是否值得把 GCJ→WGS 并入 build_stats.js
const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, 'data');
const read = (n) => JSON.parse(fs.readFileSync(path.join(DATA, n + '.json'), 'utf8'));
const A = 6378245.0, EE = 0.00669342162296594323;
const tLat = (x, y) => { let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x)); r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3; r += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3; r += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3; return r; };
const tLon = (x, y) => { let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x)); r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3; r += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3; r += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3; return r; };
function wgs2gcj(lon, lat) { let dLat = tLat(lon - 105, lat - 35), dLon = tLon(lon - 105, lat - 35); const rl = (lat / 180) * Math.PI; let m = Math.sin(rl); m = 1 - EE * m * m; const sq = Math.sqrt(m); dLat = (dLat * 180) / (((A * (1 - EE)) / (m * sq)) * Math.PI); dLon = (dLon * 180) / ((A / sq) * Math.cos(rl) * Math.PI); return [lon + dLon, lat + dLat]; }
function gcj2wgs(lon, lat) { let wl = lon, wa = lat; for (let i = 0; i < 40; i++) { const [g1, g2] = wgs2gcj(wl, wa); const d1 = g1 - lon, d2 = g2 - lat; if (Math.abs(d1) < 1e-11 && Math.abs(d2) < 1e-11) break; wl -= d1; wa -= d2; } return [wl, wa]; }
const pip = (x, y, r) => { let ins = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins; } return ins; };
function stitch(segs) { const pool = segs.map((s) => s.slice()); const rings = []; const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9; while (pool.length) { let cur = pool.shift(); let ext = true; while (ext && !same(cur[0], cur[cur.length - 1])) { ext = false; for (let i = 0; i < pool.length; i++) { const s = pool[i]; if (same(cur[cur.length - 1], s[0])) { cur = cur.concat(s.slice(1)); pool.splice(i, 1); ext = true; break; } if (same(cur[cur.length - 1], s[s.length - 1])) { cur = cur.concat(s.slice(0, -1).reverse()); pool.splice(i, 1); ext = true; break; } if (same(cur[0], s[s.length - 1])) { cur = s.slice(0, -1).concat(cur); pool.splice(i, 1); ext = true; break; } if (same(cur[0], s[0])) { cur = s.slice(1).reverse().concat(cur); pool.splice(i, 1); ext = true; break; } } } if (cur.length >= 4) rings.push(cur); } return rings; }
const HCS = new Set(read('hc_subnames').elements.map((e) => e.tags.name).filter(Boolean));
const areas = [];
for (const el of [...read('boundaries_geom').elements, ...read('lilin').elements]) {
  const t = el.tags || {};
  if (t.admin_level !== '8' || !t.name || !HCS.has(t.name)) continue;
  const segs = [];
  for (const m of el.members || []) if (m.type === 'way' && m.geometry && m.geometry.length >= 2 && m.role !== 'inner') segs.push(m.geometry.map((p) => [p.lon, p.lat]));
  const rings = stitch(segs); if (rings.length) areas.push({ name: t.name, rings });
}
const assign = (lon, lat) => { for (const a of areas) if (a.rings.some((r) => pip(lon, lat, r))) return a.name; return null; };

const SETS = [['parking', 'amap_parking', '停车场'], ['fuel', 'amap_fuel', '加油站'], ['charging', 'amap_charging', '充电站'], ['schools', 'amap_schools', '学校'], ['hospitals', 'amap_hospitals', '医院'], ['markets', 'amap_markets', '市场']];
const raw = {}; const cor = {};
areas.forEach((a) => { raw[a.name] = {}; cor[a.name] = {}; });
for (const [key, file] of SETS) {
  for (const p of read(file).pois || []) {
    const [lon, lat] = String(p.location || '').split(',').map(Number);
    if (!isFinite(lon) || !isFinite(lat)) continue;
    const a1 = assign(lon, lat);
    const [wl, wa] = gcj2wgs(lon, lat);
    const a2 = assign(wl, wa);
    if (a1) raw[a1][key] = (raw[a1][key] || 0) + 1;
    if (a2) cor[a2][key] = (cor[a2][key] || 0) + 1;
  }
}
console.log('街道'.padEnd(12) + SETS.map((s) => s[2].padStart(7)).join('') + '   合计变化');
let tot = 0, maxRel = 0;
const diffs = [];
for (const a of areas) {
  const cells = SETS.map(([k, , lbl]) => {
    const r = raw[a.name][k] || 0, c = cor[a.name][k] || 0;
    return (c === r ? String(r) : `${r}→${c}`);
  });
  const rs = SETS.reduce((s, [k]) => s + (raw[a.name][k] || 0), 0);
  const cs = SETS.reduce((s, [k]) => s + (cor[a.name][k] || 0), 0);
  const d = cs - rs; tot += d;
  const rel = rs ? (Math.abs(d) / rs) * 100 : 0; maxRel = Math.max(maxRel, rel);
  if (d) diffs.push([a.name, d, rel]);
  console.log(a.name.padEnd(12) + cells.map((x) => x.padStart(7)).join('') + `   ${rs}→${cs} (${d > 0 ? '+' : ''}${d})`);
}
console.log(`\n合计净变化 ${tot > 0 ? '+' : ''}${tot}；有变化的街道 ${diffs.length}/${areas.length}；最大相对变化 ${maxRel.toFixed(1)}%`);
diffs.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 8).forEach(([n, d, r]) => console.log(`  ${n.padEnd(12)} ${d > 0 ? '+' : ''}${d} 户 (${r.toFixed(1)}%)`));
