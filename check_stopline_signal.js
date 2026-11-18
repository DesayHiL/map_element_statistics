// =============================================================================
// 「有灯路口停止线 → 信号灯」距离核验（ODD 1.3 路口长度 ≤60m）
// =============================================================================
// 需求原文：有灯路口「停止线-信号灯距离 ≤60m」。
// 现在两侧数据都齐了：
//   · 停止线位置 + 是否受灯控 = 宽凳 STOPLINE（IS_LIGHT=1，第三数据源）
//   · 信号灯位置             = OSM highway=traffic_signals（高德开放平台无信号灯图层）
// 于是这个 ODD 项从「需采图/实测」变成**可算**：逐条灯控停止线找最近信号灯，看是否落在 60m 内。
//
// 口径：
//   · 两侧都先做街道归属（18 街道多边形），只统计区内；
//   · 最近距离按 WGS-84 平面近似（同纬度 23°N，误差 <0.3%）；
//   · 未匹配到信号灯的停止线不丢弃，单独计为「无灯源可配对」——
//     这本身是数据完备性指标（OSM 信号灯是否漏标）。
//
// 输出：out/stopline_signal_check.json
const fs = require('fs');
const path = require('path');
const A = require('./street_areas');

const OUT = path.join(__dirname, 'out');
const DATA = path.join(__dirname, 'data');
const read = (n) => JSON.parse(fs.readFileSync(path.join(DATA, n + '.json'), 'utf8'));

const CELL = 0.001;

function main() {
  const areas = A.loadAreas();
  const assign = A.assignStreetFactory(areas);

  const slAll = read('kuandeng_stoplines').elements;
  const signals = read('signals').elements;

  // 信号灯（WGS）→ 网格
  const grid = new Map();
  let sigIn = 0;
  for (const s of signals) {
    if (s.type !== 'node' || !isFinite(s.lon) || !isFinite(s.lat)) continue;
    if (!assign(s.lon, s.lat)) continue;
    sigIn++;
    const k = `${Math.floor(s.lon / CELL)}|${Math.floor(s.lat / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push([s.lon, s.lat]);
  }

  const nearestSignalM = (lon, lat) => {
    const cx = Math.floor(lon / CELL), cy = Math.floor(lat / CELL);
    const cosLat = Math.cos((lat * Math.PI) / 180);
    let best = Infinity;
    for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) {
      const arr = grid.get(`${cx + dx}|${cy + dy}`);
      if (!arr) continue;
      for (const [x, y] of arr) {
        const d = Math.hypot((x - lon) * 111320 * cosLat, (y - lat) * 110540);
        if (d < best) best = d;
      }
    }
    return best;
  };

  const R = { total: 0, inDistrict: 0, lightControlled: 0, byBand: {}, matched: 0 };
  const dists = [];
  const samples = [];
  for (const e of slAll) {
    R.total++;
    if (!assign(e.lon, e.lat)) continue;
    R.inDistrict++;
    if (e.tags.is_light !== '1') continue;
    R.lightControlled++;
    const d = nearestSignalM(e.lon, e.lat);
    if (!isFinite(d)) { R.byBand.none = (R.byBand.none || 0) + 1; continue; }
    R.matched++;
    dists.push(d);
    const band = d <= 20 ? '≤20m' : d <= 40 ? '20–40m' : d <= 60 ? '40–60m' : d <= 100 ? '60–100m' : '>100m';
    R.byBand[band] = (R.byBand[band] || 0) + 1;
    if (samples.length < 8 && d <= 60) samples.push({ id: e.id, lat: e.lat, lon: e.lon, distM: +d.toFixed(1) });
  }
  dists.sort((a, b) => a - b);
  const q = (p) => (dists.length ? +dists[Math.min(dists.length - 1, Math.floor(dists.length * p))].toFixed(1) : null);
  const within60 = (R.byBand['≤20m'] || 0) + (R.byBand['20–40m'] || 0) + (R.byBand['40–60m'] || 0);

  const out = {
    generatedAt: new Date().toISOString(),
    requirement: '有灯路口：停止线 ↔ 信号灯距离 ≤60m',
    sources: { stopline: '宽凳 STOPLINE（IS_LIGHT=1）', signal: 'OSM highway=traffic_signals' },
    signalInDistrict: sigIn,
    stoplines: R,
    within60,
    within60Pct: R.lightControlled ? +((within60 / R.lightControlled) * 100).toFixed(1) : null,
    medianDistM: q(0.5), p90DistM: q(0.9), maxDistM: dists.length ? +dists[dists.length - 1].toFixed(1) : null,
    samples,
  };
  fs.writeFileSync(path.join(OUT, 'stopline_signal_check.json'), JSON.stringify(out, null, 1));

  console.log(`信号灯（区内，OSM）${sigIn} 个 · 宽凳停止线 ${R.total} 条（区内 ${R.inDistrict}）`);
  console.log(`其中受灯控 ${R.lightControlled} 条 → 能配到信号灯 ${R.matched} 条（无灯源可配 ${R.byBand.none || 0} 条，OSM 漏标）`);
  console.log(`距离分档 ${JSON.stringify(R.byBand)}`);
  console.log(`≤60m 占受灯控 ${out.within60Pct}%（中位 ${out.medianDistM}m · P90 ${out.p90DistM}m · 最大 ${out.maxDistM}m）`);
}

main();
