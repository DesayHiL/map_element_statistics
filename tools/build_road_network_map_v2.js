#!/usr/bin/env node
// 生成惠城区路网图 · 按道路类型分色（SVG/HTML）
// 数据源：data/roads.json（OSM）、data/boundaries_geom.json（惠城区边界）
const fs = require('fs');
const path = require('path');

const roads = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'roads.json'), 'utf8')).elements;
const brels = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'boundaries_geom.json'), 'utf8')).elements;
const hc = brels.find(r => r.type === 'relation' && r.id === 3209659); // 惠城区

// ---- 分类与配色（主干道 → 巷道，从粗到细）----
const CATS = [
  { key: 'motorway', label: '高速公路', color: '#e8192c', w: 2.8, tags: ['motorway', 'motorway_link'] },
  { key: 'trunk',    label: '快速路', color: '#f68b1f', w: 2.4, tags: ['trunk', 'trunk_link'] },
  { key: 'primary',  label: '主干道', color: '#ffd400', w: 2.0, tags: ['primary', 'primary_link'] },
  { key: 'secondary',label: '次干道', color: '#7fbf3f', w: 1.5, tags: ['secondary', 'secondary_link'] },
  { key: 'tertiary', label: '支路', color: '#38a8e0', w: 1.1, tags: ['tertiary', 'tertiary_link'] },
  { key: 'alley',    label: '巷道/内部道路', color: '#c0c8d4', w: 0.55, tags: ['service', 'living_street', 'unclassified', 'residential'], dim: true },
];
const TAG2CAT = {};
CATS.forEach(c => c.tags.forEach(t => TAG2CAT[t] = c.key));

// ---- 惠城区边界：拼 outer 环 ----
const rings = [];
{
  const segs = hc.members.filter(m => m.geometry && m.geometry.length >= 2).map(m => m.geometry.map(p => [p.lon, p.lat]));
  const used = new Array(segs.length).fill(false);
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let ring = segs[i].slice();
    let grew = true;
    while (grew) {
      grew = false;
      const head = ring[0], tail = ring[ring.length - 1];
      for (let j = 0; j < segs.length; j++) {
        if (used[j]) continue;
        const s = segs[j], a = s[0], b = s[s.length - 1];
        const eq = (p, q) => Math.abs(p[0] - q[0]) < 1e-7 && Math.abs(p[1] - q[1]) < 1e-7;
        if (eq(tail, a)) { ring = ring.concat(s.slice(1)); used[j] = true; grew = true; break; }
        if (eq(tail, b)) { ring = ring.concat(s.slice().reverse().slice(1)); used[j] = true; grew = true; break; }
        if (eq(head, b)) { ring = s.slice(0, -1).concat(ring); used[j] = true; grew = true; break; }
        if (eq(head, a)) { ring = s.slice().reverse().slice(0, -1).concat(ring); used[j] = true; grew = true; break; }
      }
    }
    rings.push(ring);
  }
}
console.log('boundary rings:', rings.length, 'points:', rings.reduce((a, r) => a + r.length, 0));

// ---- bbox：以边界为准 ----
let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
rings.flat().forEach(([lon, lat]) => {
  minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
  minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
});

// ---- 投影（单次，等距圆柱 + 纬度校正，画幅贴合边界）----
const W = 1400, PAD = 50, TITLE_H = 80;
const lonSpan = (maxLon - minLon) * Math.cos(minLat * Math.PI / 180);
const latSpan = maxLat - minLat;
const SC = Math.min((W - 2 * PAD) / lonSpan, (W - 2 * PAD) / latSpan * 0.92);
const H = Math.round(TITLE_H + latSpan * SC + 2 * PAD);
const X = lon => (lon - minLon) * Math.cos(minLat * Math.PI / 180) * SC + PAD;
const Y = lat => H - ((lat - minLat) * SC + PAD);

// ---- 点在多边形内（射线法，用于裁掉邻区道路）----
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function insideHC(lon, lat) {
  return rings.some(r => r.length > 10 && inRing([lon, lat], r));
}

// ---- 道路裁剪：整条无一点在界内 → 跳过 ----
const byCat = {};
let totalWays = 0;
for (const w of roads) {
  const hw = w.tags && w.tags.highway;
  const key = hw && TAG2CAT[hw];
  if (!key || !w.geometry || w.geometry.length < 2) continue;
  const anyIn = w.geometry.some(p => insideHC(p.lon, p.lat));
  if (!anyIn) continue;
  (byCat[key] = byCat[key] || []).push(w.geometry);
  totalWays++;
}

// ---- 渲染 ----
let svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
svg += `\n<rect width="${W}" height="${H}" fill="#14181f"/>`;
svg += `\n<text x="${W / 2}" y="42" font-size="28" fill="#fff" text-anchor="middle" font-family="sans-serif" font-weight="bold">惠城区路网图 · 按道路类型着色</text>`;
svg += `\n<text x="${W / 2}" y="66" font-size="13" fill="#8a94a3" text-anchor="middle" font-family="sans-serif">数据源：OSM · 裁剪至惠城区行政边界 · ${totalWays} 条道路 · 生成 ${new Date().toISOString().slice(0, 10)}</text>`;

// 边界
svg += `\n<g stroke="#4dd2ff" stroke-width="1.6" fill="none" opacity="0.75">`;
for (const ring of rings) {
  svg += `<path d="M${ring.map(([lon, lat]) => `${X(lon).toFixed(1)},${Y(lat).toFixed(1)}`).join('L')}Z"/>`;
}
svg += '</g>';

// 细的先画，粗的压在上面
const counts = {};
for (const cat of [...CATS].reverse()) {
  const geoms = byCat[cat.key] || [];
  counts[cat.key] = geoms.length;
  if (!geoms.length) continue;
  const op = cat.dim ? 0.45 : 0.95;
  let g = `\n<g stroke="${cat.color}" stroke-width="${cat.w}" fill="none" stroke-linecap="round" opacity="${op}">`;
  for (const pts of geoms) {
    g += `<path d="M${pts.map(p => `${X(p.lon).toFixed(1)},${Y(p.lat).toFixed(1)}`).join('L')}"/>`;
  }
  svg += g + '</g>';
}

// 图例（右上）
const lx = W - 320, ly0 = TITLE_H + 14;
svg += `\n<rect x="${lx - 14}" y="${ly0}" width="300" height="${CATS.length * 26 + 56}" rx="8" fill="#000" opacity="0.6"/>`;
svg += `\n<text x="${lx}" y="${ly0 + 24}" font-size="14" fill="#fff" font-family="sans-serif" font-weight="bold">道路类型</text>`;
CATS.forEach((c, i) => {
  const y = ly0 + 48 + i * 26;
  svg += `\n<line x1="${lx}" y1="${y}" x2="${lx + 28}" y2="${y}" stroke="${c.color}" stroke-width="${Math.max(c.w, 3)}" opacity="${c.dim ? 0.75 : 1}"/>`;
  svg += `\n<text x="${lx + 38}" y="${y + 4}" font-size="13" fill="#dfe6ee" font-family="sans-serif">${c.label}（${counts[c.key] || 0}）</text>`;
});
{
  const y = ly0 + 48 + CATS.length * 26;
  svg += `\n<line x1="${lx}" y1="${y}" x2="${lx + 28}" y2="${y}" stroke="#4dd2ff" stroke-width="2"/>`;
  svg += `\n<text x="${lx + 38}" y="${y + 4}" font-size="13" fill="#dfe6ee" font-family="sans-serif">惠城区行政边界</text>`;
}
svg += '\n</svg>';

fs.writeFileSync(path.join(__dirname, '..', 'out', 'road_network_map.svg'), svg);
fs.writeFileSync(path.join(__dirname, '..', 'out', 'road_network_map.html'),
  `<!DOCTYPE html><html><head><meta charset="utf-8"><title>惠城区路网图</title><style>body{margin:0;background:#14181f;display:flex;justify-content:center}svg{max-width:100%;height:auto}</style></head><body>${svg}</body></html>`);
console.log('OK', W, 'x', H, 'counts=', counts);