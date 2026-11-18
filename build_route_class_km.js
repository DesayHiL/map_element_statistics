// 逐路线「道路类型里程占比」—— 三档口径（2026-10-27 用户要求，档位定义来自需求方图示）：
//   I  型 = 高速公路 / 快速路        ← OSM motorway / trunk
//   II 型 = 城市主干路 / 次干路 / 支路 ← OSM primary / secondary / tertiary
//   III型 = 其他（县乡乡村、街巷、内部道路等特殊场景） ← residential / unclassified / track / living_street / service
// 方法：routes_kd.polys（GCJ02 折线）逐小段吸附「最近 OSM 道路 way」（网格索引，阈值 60m），
//       按 way 的 highway 等级归档累加该小段长度；吸附不到的记 unmatched 单列。
// 输出 out/route_class_km.json，供 build_odd_coverage_html.js C 表渲染。
const fs = require('fs');
const path = require('path');
const { gcj2wgs } = require('./street_areas');

const ROOT = __dirname;
const readJ = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const kd = readJ('out/routes_kd.json');
const osm = readJ('data/roads.json');

const TIER_OF = {
  motorway: 'I', trunk: 'I',
  primary: 'II', secondary: 'II', tertiary: 'II',
  residential: 'III', unclassified: 'III', track: 'III', living_street: 'III', service: 'III',
};
// III 型细分标签（渲染"其他"时展开，避免一锅烩看不出跑了什么路）
const III_LABEL = {
  unclassified: '县乡乡村路', track: '乡村土路', residential: '街巷/小区路',
  living_street: '生活街道', service: '内部/服务道路',
};
const THRESH_M = 60;          // 折线点到 way 折线的最大吸附距离
const CELL = 0.002;           // 网格边长（度，≈200m）

function hav(a, b) {           // [lon,lat] 米
  const R = 6371000, dLat = (b[1] - a[1]) * Math.PI / 180, dLng = (b[0] - a[0]) * Math.PI / 180;
  const la = a[1] * Math.PI / 180, lb = b[1] * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// 点到折线最短距离（米）
function distToPoly(p, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1e-12)));
    best = Math.min(best, hav(p, [a[0] + t * dx, a[1] + t * dy]));
    if (best < 5) break;
  }
  return best;
}

// ---- 建 OSM way 网格索引（way 几何 WGS84 → 保留原坐标；折线点 gcj2wgs 后同为 WGS84）----
const grid = new Map();
const ways = [];
for (const el of osm.elements) {
  const hw = el.tags && el.tags.highway;
  if (!hw || !TIER_OF[hw] || !el.geometry || el.geometry.length < 2) continue;
  const pts = el.geometry.map((g) => [g.lon, g.lat]);
  const id = ways.length;
  ways.push({ tier: TIER_OF[hw], hw, pts, name: el.tags.name || '' });
  let lo = Infinity, la = Infinity, hi = -Infinity, ha = -Infinity;
  for (const p of pts) {
    if (p[0] < lo) lo = p[0]; if (p[0] > hi) hi = p[0];
    if (p[1] < la) la = p[1]; if (p[1] > ha) ha = p[1];
  }
  for (let x = Math.floor(lo / CELL); x <= Math.floor(hi / CELL); x++)
    for (let y = Math.floor(la / CELL); y <= Math.floor(ha / CELL); y++) {
      const k = x + ',' + y;
      (grid.get(k) || grid.set(k, []).get(k)).push(id);
    }
}
console.log(`[in] 索引 ${ways.length} 条 OSM 道路 way`);

function nearestTier(p) {     // p: WGS84 [lon,lat] → { tier, hw } | null
  const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
  for (let r = 0; r <= 2; r++) {              // 半径 2 格（≈400m）内找
    let cands = [];
    for (let x = cx - r; x <= cx + r; x++)
      for (let y = cy - r; y <= cy + r; y++) {
        if (r > 0 && Math.abs(x - cx) !== r && Math.abs(y - cy) !== r) continue; // 只扫外环
        cands = cands.concat(grid.get(x + ',' + y) || []);
      }
    if (!cands.length) continue;
    let bestD = Infinity, best = null;
    for (const w of cands) {
      const d = distToPoly(p, ways[w].pts);
      if (d < bestD) { bestD = d; best = ways[w]; if (d < 5) break; }
    }
    if (best && bestD <= THRESH_M) return { tier: best.tier, hw: best.hw };
    return null;                              // 本环已有候选但都不够近 → 无匹配
  }
  return null;
}

// ---- 逐腿计算 ----
const routes = [];
for (const leg of kd.routes) {
  const agg = { I: 0, II: 0, III: 0, unmatched: 0 };
  const iiiByHw = {};   // III 型细分：highway 值 → 米
  for (const seg of leg.polys || []) {
    for (let i = 1; i < seg.length; i++) {
      const mid = gcj2wgs([(seg[i - 1][0] + seg[i][0]) / 2, (seg[i - 1][1] + seg[i][1]) / 2]);
      const hit = nearestTier(mid);
      const m = hav(seg[i - 1], seg[i]);
      if (hit) { agg[hit.tier] += m; if (hit.tier === 'III') iiiByHw[hit.hw] = (iiiByHw[hit.hw] || 0) + m; }
      else agg.unmatched += m;
    }
  }
  const total = agg.I + agg.II + agg.III + agg.unmatched;
  const iiiDetail = Object.fromEntries(Object.entries(iiiByHw)
    .map(([hw, m]) => [III_LABEL[hw] || hw, +(m / 1000).toFixed(1)])
    .filter(([, km]) => km >= 0.05));
  routes.push({
    street: leg.street, n: leg.n, distKm: leg.distKm,
    geoKm: +(total / 1000).toFixed(2),
    km: { I: +(agg.I / 1000).toFixed(1), II: +(agg.II / 1000).toFixed(1), III: +(agg.III / 1000).toFixed(1), unmatched: +(agg.unmatched / 1000).toFixed(1) },
    iiiDetail,
    matchedPct: +(100 * (1 - agg.unmatched / (total || 1))).toFixed(1),
  });
}

// 自检：几何总里程与 distKm 偏差 >5% 报警（polys 几何已实测偏差 0.4%）
let worst = 0, worstLeg = '';
for (const r of routes) {
  const d = Math.abs(r.geoKm - r.distKm) / r.distKm;
  if (d > worst) { worst = d; worstLeg = r.street + '#' + r.n; }
}
console.log(`[chk] 几何 vs distKm 最大偏差 ${(worst * 100).toFixed(1)}%（${worstLeg}）；匹配率最低 ${(Math.min(...routes.map(r => r.matchedPct)))}%`);

const out = {
  generated: new Date().toISOString().slice(0, 16).replace('T', ' '),
  source: 'out/routes_kd.json polys（GCJ02 折线，宽凳约束几何）× data/roads.json（OSM highway 等级）',
  tierDef: { I: '高速公路/快速路（motorway/trunk）', II: '城市主干路/次干路/支路（primary/secondary/tertiary）', III: '其他：县乡乡村/街巷/内部道路等（residential/unclassified/track/living_street/service）' },
  snapThresholdM: THRESH_M,
  routes,
};
fs.writeFileSync(path.join(ROOT, 'out', 'route_class_km.json'), JSON.stringify(out, null, 1));
console.log(`[out] out/route_class_km.json  ${routes.length} 条路线`);
for (const r of routes.slice(0, 5))
  console.log(`  ${r.street}#${r.n}  I ${r.km.I} / II ${r.km.II} / III ${r.km.III} / 未匹配 ${r.km.unmatched} km（匹配率 ${r.matchedPct}%）`);