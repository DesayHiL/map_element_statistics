// 街道级拥堵聚合 —— 从「全区 18 街道」的采样里产出每个街道/镇的路况
//
// 三条必须做的过滤/校正（不做的话结论是错的）：
//   1) **按 polyline 指纹跨采样几何去重**。高德返回的是整条路的完整 polyline（长深高速
//      94.5km 在十几个采样点里长度一模一样），同一路段会被多个圆/矩形重复返回。
//      实测事故：786 条记录实际只有 322 条不同路段，虚增里程 738.6km。
//   2) **剔除高快速路**。穿境高快速路 95~105km/h，会把城镇道路的加权均速整体抬上去；
//      三栋镇、沥林镇采样到的路段几乎全是高速 —— 不剔除的话这些镇的「路况」完全是假的。
//   3) **里程按街区拆分**（road.streetKm），不是「这条路的里程全算给一个街道」。长干道
//      跨多个街道，只有逐点采样才能分对（惠南大道 26.5km：三栋镇 7.97km + 河南岸 1.55km）。
//
// 另一件必须说清的事：「0 条路段」与「畅通」不是一回事。产物里 noCoverage 按**原因**分成
// 三类，不能混为一谈 —— 见 classifyNoCoverage()。
const fs = require('fs');
const path = require('path');
const { loadAreas, gcj2wgs } = require('./street_areas');

const DATA = path.join(__dirname, 'data');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

// 高快速路识别：**只判显式的「高速」命名**。
// 曾经用 /高速|G\d{2,3}|S\d{2,3}/，结果把 ２０５国道 / ３２４国道 / ３２５国道 / ２５４省道
// 一起剔掉了 —— 这些是老城区与仲恺、马安、三栋的**主力城市道路**，实测车速 35~57km/h，
// 完全不是高快速路（无人小车上得了）。误剔的直接后果：惠环/陈江/马安/三栋 的城镇路况
// 被整体判成「只有穿境高速」。
// 判据锚在「高快速路 = 车速量级 80km/h 以上」这一物理事实上，命名只是索引。
const HW_RE = /高速/;
const isHw = (name) => HW_RE.test(String(name || ''));

// 只消费新格式（带 poly 指纹与 streetKm）的采样文件；老格式（6 瓦片核心区）不参与本表。
function isNewFormat(j) {
  return Array.isArray(j.tiles) && j.tiles.some((t) => (t.roads || []).some((r) => r.poly && r.streetKm));
}

function main() {
  const files = fs.readdirSync(DATA).filter((f) => /^congestion_.*\.json$/.test(f)).sort();
  const usable = [], skipped = [];
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
    (isNewFormat(j) ? usable : skipped).push({ file: f, j });
  }
  if (!usable.length) {
    console.error('没有新格式（18 街道）采样文件。先跑：node fetch_congestion.js');
    process.exit(1);
  }
  console.log(`候选采样文件 ${files.length} 个：新格式 ${usable.length} 个参与聚合，老格式 ${skipped.length} 个跳过`);
  skipped.forEach((s) => console.log(`  跳过 ${s.file}（无 poly/streetKm，6 瓦片核心区老格式）`));

  // ---- 全局去重：按 polyline 指纹，同一条物理路段只留一份 ----
  const byPoly = new Map();
  let raw = 0;
  for (const { j } of usable) {
    for (const t of j.tiles) for (const r of t.roads || []) {
      raw++;
      const prev = byPoly.get(r.poly);
      if (!prev || (r.km || 0) > (prev.km || 0)) byPoly.set(r.poly, { ...r, _band: j.band });
    }
  }
  const unique = [...byPoly.values()];
  console.log(`\n路段记录 ${raw} 条 → polyline 去重后 ${unique.length} 条（重复 ${raw - unique.length} 条）`);

  // ---- 过滤 + 街道维度汇总 ----
  let kept = 0, droppedHw = 0, droppedNoSpeed = 0, droppedOutside = 0, hwKm = 0;
  const agg = new Map(); // street -> {roads, km, kmhNum, kmhDen, congestedKm, statuses}
  const add = (m, s, r, km) => {
    const a = m.get(s) || { roads: 0, km: 0, kmhNum: 0, kmhDen: 0, congestedKm: 0, statuses: {} };
    a.roads++; a.km += km;
    const v = Number(r.speed);
    a.kmhNum += km; a.kmhDen += km / v;
    if (Number(r.status) >= 2) a.congestedKm += km;
    const lbl = r.label || String(r.status);
    a.statuses[lbl] = (a.statuses[lbl] || 0) + 1;
    m.set(s, a);
  };
  // 高快速路也单独汇总一份，报告里如实标出「穿境高速」的量级
  const hwAgg = new Map();

  for (const r of unique) {
    const parts = Object.entries(r.streetKm || {}).filter(([, km]) => km > 0);
    if (!parts.length) { droppedOutside++; continue; }
    const v = Number(r.speed);
    if (isHw(r.name)) {
      droppedHw++;
      for (const [s, km] of parts) { hwKm += km; add(hwAgg, s, r, km); }
      continue;
    }
    if (!isFinite(v) || v <= 0) { droppedNoSpeed++; continue; }
    kept++;
    for (const [s, km] of parts) add(agg, s, r, km);
  }
  console.log(`去重后路段：保留 ${kept} 条 · 高快速路 ${droppedHw} 条（${hwKm.toFixed(1)}km，单独统计）· 速度缺失 ${droppedNoSpeed} 条 · 不属任何街道 ${droppedOutside} 条`);

  const official = loadAreas().map((a) => a.name).sort((a, b) => a.localeCompare(b, 'zh'));
  const streets = [...agg.entries()].map(([name, a]) => ({
    name,
    roads: a.roads,
    km: +a.km.toFixed(2),
    kmh: a.kmhDen > 0 ? +(a.kmhNum / a.kmhDen).toFixed(1) : null,
    congestedKmPct: a.km > 0 ? +((a.congestedKm / a.km) * 100).toFixed(1) : null,
    sampleLevel: a.km >= 20 && a.roads >= 15 ? 'ok' : a.km >= 5 && a.roads >= 3 ? 'low' : 'insufficient',
    highwayKm: +((hwAgg.get(name) || { km: 0 }).km).toFixed(2),
    statuses: a.statuses,
  })).sort((x, y) => y.km - x.km);

  // ---- 无数据街道：按原因分类，不能一律说成「高德无覆盖」 ----
  // 关键区分：圆的中心是否落在该街道境内。中心在境内的圆返回 0 段 → 确实没覆盖；
  // 中心在境外的圆返回了路段但一条都没落在本街道 → 是「本街道无独立数据」，不是没采。
  const areas = loadAreas();
  const boxOf = (a) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of a.polygons) for (const r of p) for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return [x0, y0, x1, y1];
  };
  const insideStreet = (lon, lat, a) => {
    const b = boxOf(a);
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) return false;
    for (const poly of a.polygons) for (const ring of poly) {
      let in_ = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) in_ = !in_;
      }
      if (in_) return true;
    }
    return false;
  };
  const areasByName = new Map(areas.map((a) => [a.name, a]));

  // 采样几何的中心（WGS-84）：
  //   · 成功的几何有 query.center，但那是 **GCJ-02**（发给高德的就是它）→ 需 gcj2wgs
  //   · 失败的几何只有 tile 名 `街道@lon,lat`，而那是 **WGS-84** 原值 → 不能再纠偏
  // 老版本漏了这条，导致「圆心在境内的圆全部失败」的镇（横沥/芦洲/潼湖/潼侨）被错判成
  // 「境内没有落得下圆心」—— 直接抹掉了「高德确实没覆盖这些镇」这个结论。
  const centerWgs = (rec) => {
    const m = /@(-?\d+\.\d+),(-?\d+\.\d+)$/.exec(rec.tile || '');
    if (m) return [+m[1], +m[2]];
    const c = (rec.query || {}).center;
    return c ? gcj2wgs(c) : null;
  };

  const tilesOf = new Map(); // street -> {tiles, withRoads, centerTiles, centerWithRoads, rawKm}
  const bump = (s, fn) => { const o = tilesOf.get(s) || { tiles: 0, withRoads: 0, centerTiles: 0, centerWithRoads: 0, rawKm: 0 }; fn(o); tilesOf.set(s, o); };

  for (const { j } of usable) {
    for (const t of j.tiles) {
      const w = centerWgs(t);
      for (const s of t.streets || [t.street]) {
        const isCenter = w ? insideStreet(w[0], w[1], areasByName.get(s) || { polygons: [] }) : false;
        bump(s, (o) => {
          o.tiles++;
          if ((t.roads || []).length) o.withRoads++;
          if (isCenter) { o.centerTiles++; if ((t.roads || []).length) o.centerWithRoads++; }
          for (const r of t.roads || []) o.rawKm += (r.streetKm || {})[s] || 0;
        });
      }
    }
    for (const ft of j.failedTiles || []) {
      const w = centerWgs(ft);
      for (const s of ft.streets || [ft.street]) {
        const isCenter = w ? insideStreet(w[0], w[1], areasByName.get(s) || { polygons: [] }) : false;
        bump(s, (o) => { o.tiles++; if (isCenter) o.centerTiles++; });
      }
    }
  }

  const noCoverage = official.filter((n) => !agg.has(n)).map((n) => {
    const o = tilesOf.get(n) || { tiles: 0, withRoads: 0, centerTiles: 0, centerWithRoads: 0, rawKm: 0 };
    let category, reason;
    if (o.centerTiles && !o.centerWithRoads) {
      category = 'source-empty';
      reason = `圆心落在本街道境内的 ${o.centerTiles} 个采样几何**全部返回 0 条路段**（OSM 显示当地有路）—— 高德交通态势未覆盖此处，不是路况畅通`;
    } else if (o.rawKm > 0) {
      category = 'only-highway';
      reason = `采样到 ${o.rawKm.toFixed(1)}km 路段，但全部是显式命名的「高速」（已剔除）—— 本街道无城镇道路态势数据`;
    } else if (o.centerTiles) {
      category = 'no-inner-road';
      reason = `圆心在境内的 ${o.centerTiles} 个采样几何有 ${o.centerWithRoads} 个返回路段，但**一条都没落在本街道**（都落在邻街道）—— 本街道无独立态势数据`;
    } else {
      category = 'no-inner-road';
      reason = `本街道境内没有落得下圆心的采样点（街道狭长/偏远），境外 ${o.withRoads}/${o.tiles} 个采样几何有返回但路段都落在邻街道`;
    }
    return { name: n, tilesRequested: o.tiles, tilesWithRoads: o.withRoads, centerTiles: o.centerTiles, centerWithRoads: o.centerWithRoads, rawKm: +o.rawKm.toFixed(2), category, reason };
  });

  const src = usable[usable.length - 1];
  // 采样体检：把「瓦片没采到」拆成 empty（高德确无数据）与 error（取数失败，可重跑补），
  // 报告里必须分开说 —— 「没采到」和「没有数据」是两件事。
  const failedTiles = src.j.failedTiles || [];
  const empties = failedTiles.filter((f) => f.category === 'empty' || /返回 0 条路段/.test(f.error || '')).length;
  const out = {
    generatedAt: new Date().toISOString(),
    source: {
      file: src.file,
      band: src.j.band,
      sampledAt: src.j.sampledAt,
      sampledWindow: src.j.sampledWindow || null,
      mode: (src.j.coverageSummary || {}).mode || 'unknown',
      tilesRequested: (src.j.coverageSummary || {}).tilesRequested,
      tilesOk: (src.j.coverageSummary || {}).tilesOk,
      tilesFailed: (src.j.coverageSummary || {}).tilesFailed,
      tilesEmpty: (src.j.coverageSummary || {}).tilesEmpty != null ? src.j.coverageSummary.tilesEmpty : empties,
      tilesError: (src.j.coverageSummary || {}).tilesError != null ? src.j.coverageSummary.tilesError : failedTiles.length - empties,
      uniqueRoads: (src.j.dedup || {}).uniqueRoads,
      dedup: src.j.dedup || null,
    },
    filters: {
      dedup: '按 polyline 指纹跨采样几何去重（高德返回整条路的完整 polyline，不去重会虚增里程）',
      dropHighway: `路名匹配 ${HW_RE.source} —— 穿境高快速路单独统计在 highwayKm / highway 字段`,
      attribution: '里程按 road.streetKm 拆到各街道（沿 polyline 每 20m 打点判定），不是整条路归一个街道',
      note: '「0 条路段」≠「畅通」：产物严格区分 streets 与 noCoverage，且 noCoverage 按原因分类',
    },
    summary: {
      officialSubdistricts: official.length,
      withTrafficData: streets.length,
      withoutTrafficData: noCoverage.length,
      keptRoads: kept,
      droppedHighway: droppedHw,
      droppedNoSpeed,
      droppedOutside,
      totalKm: +streets.reduce((s, x) => s + x.km, 0).toFixed(1),
      highwayKm: +hwKm.toFixed(1),
    },
    streets,
    noCoverage,
  };

  fs.writeFileSync(path.join(OUT, 'congestion_streets.json'), JSON.stringify(out, null, 2));

  console.log(`\n采样来源 ${src.file} @${src.j.band}（${out.source.mode}，瓦片成功 ${out.source.tilesOk}/${out.source.tilesRequested}，其中未采到 ${out.source.tilesFailed} 个 = 高德无数据 ${out.source.tilesEmpty} + 取数失败 ${out.source.tilesError}）`);
  console.log(`\n=== 有城镇道路态势数据的街道 ${streets.length} / ${official.length} ===`);
  console.log('街道'.padEnd(14) + '路段  里程km  加权均速  缓行+拥堵%  样本  穿境高速km');
  streets.forEach((s) => console.log(
    s.name.padEnd(16) + String(s.roads).padStart(4) + String(s.km).padStart(9) + '  ' +
    String(s.kmh ?? '-').padStart(6) + 'km/h  ' + String(s.congestedKmPct ?? '-').padStart(7) + '%   ' +
    s.sampleLevel.padEnd(13) + String(s.highwayKm).padStart(6)));
  console.log(`\n=== 无城镇道路态势数据的街道/镇 ${noCoverage.length} 个（按原因分类）===`);
  noCoverage.forEach((n) => console.log(`  ${n.name.padEnd(12)} [${n.category.padEnd(14)}] 境外 ${n.tilesWithRoads}/${n.tilesRequested} 有返回 · 境内圆心 ${n.centerWithRoads}/${n.centerTiles} 有返回 · 区内里程 ${n.rawKm}km`));
  console.log(`\n合计有效里程 ${out.summary.totalKm}km（另有穿境高快速路 ${out.summary.highwayKm}km 单独统计）`);
  console.log('wrote out/congestion_streets.json');
}

main();
