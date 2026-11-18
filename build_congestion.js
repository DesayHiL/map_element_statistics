// Aggregate congestion samples (one file per run) into:
//   1. out/congestion.json     — band summary + road x band matrix + 采样覆盖 + 实测均速标定（for the report）
//   2. out/congestion_roads.csv — 路段 × 时间 × 拥堵情况 明细表（Excel 可直接打开）
//
// 两个数据来源，格式一致，本脚本一起聚合：
//   · data/congestion_<ts>.json          实时采样（fetch_congestion.js，定时多轮）
//   · data/congestion_hist_<d>_<h>.json  历史回补（fetch_congestion_history.js，商务版接口）
// 高德开放平台只有实时接口，历史时段必须走上面两条路之一 —— 报告里要如实标注。
//
// 2026-09-28 修订：整轮失败（tiles:[]，一个瓦片都没成功）的文件不再计入样本，
// 已隔离到 data/_invalid/；聚合改用「里程加权」而非「数路段条数」。
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const files = fs.readdirSync(DATA).filter((f) => f.startsWith('congestion_') && f.endsWith('.json'));

if (!files.length) {
  fs.writeFileSync(path.join(OUT, 'congestion.json'), JSON.stringify({ samples: 0, bands: {} }, null, 2));
  console.log('没有拥堵采样数据 (data/congestion_*.json)。');
  console.log('下一步：node fetch_congestion.js（在不同时段各跑一次，累积成时段分布）');
  process.exit(0);
}

const STATUS_LABEL = { 0: '未知', 1: '畅通', 2: '缓行', 3: '拥堵', 4: '严重拥堵' };

// roadName -> { byBand: { band -> {status:[], speed:[], km:[]} }, tile, directions:Set }
const roadIndex = {};
const bands = {};

// 采样覆盖统计：报告里必须区分「调度了多少次」和「真正拿到数据多少次」。
// 历史教训：99 个采样文件里 64 个是整轮失败的空文件 —— 那些不是样本，已隔离。
let dispatched = 0, effective = 0;
const hourStat = {}; // 'HH:00' -> {dispatched, effective, roads, km}
let firstLocal = null, lastLocal = null;
const localDates = new Set();
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
// 采样时间统一按东八区墙钟解读：高德返回的是本地时刻，文件名/ISO 里是 UTC。
const toLocal = (d) => new Date(d.getTime() + 8 * 3600 * 1000);
// 每个时段的 evaluation 聚合（百分比拥堵指数，比数条数稳健）
const bandEval = {};

// 里程加权：Σkm / Σ(km / v)。数条数会让长干道与短支路等权，里程加权才是对的。
function wSpeed(pairs) {
  let km = 0, h = 0;
  for (const { km: k, speed: v } of pairs) if (k > 0 && v > 0) { km += k; h += k / v; }
  return km > 0 ? km / h : null;
}

// 里程先验：2026-09-28 之前的样本没存 polyline/km，用有 km 的样本按同名路段取中位长度
// 补齐，使历史时段也能参与里程加权（否则老时段加权均速恒为 null）。
const kmSamples = {};
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  for (const t of d.tiles || []) for (const r of t.roads || []) {
    const k = Number(r.km);
    if (r.name && k > 0) (kmSamples[r.name] = kmSamples[r.name] || []).push(k);
  }
}
const kmPrior = {};
for (const [n, a] of Object.entries(kmSamples)) { a.sort((x, y) => x - y); kmPrior[n] = a[Math.floor(a.length / 2)]; }
let kmImputed = 0, kmKnown = 0;

for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  const raw = d.sampledAt ? new Date(d.sampledAt) : null;
  const ok = raw && !isNaN(raw.getTime());
  const L = ok ? toLocal(raw) : null;
  const band = d.band || (L ? `${String(L.getUTCHours()).padStart(2, '0')}:00` : '未知');
  const tiles = d.tiles || [];
  const roadsInFile = tiles.reduce((s, t) => s + (t.roads || []).length, 0);
  const isEffective = roadsInFile > 0;

  // 采样足迹：不同覆盖范围的样本不能混在同一时段里比较 —— 城区 6 瓦片与全区 18 街道的
  // 路网构成不同（后者含大量 55km/h 乡道），混在一起会让「分时段均速」变成苹果比橘子。
  // 这里如实标注每个样本的足迹，报告据此分开表述。
  // fpKey 是**机器可读**的足迹标识，供 build_congestion_ref.js 判断「哪些实测档能进
  // 分时段曲线」（只有同一路网构成的档才能一起拟合）。
  const streetsReq = (d.coverageSummary || {}).requestedStreetTiles
    || new Set(tiles.map((t) => t.street).filter(Boolean)).size;
  const fpKey = streetsReq >= 18 ? 'district-18' : streetsReq >= 2 ? `streets-${streetsReq}` : `core-${tiles.length}`;
  const footprint = streetsReq >= 18 ? `全区 ${streetsReq} 街道`
    : streetsReq >= 2 ? `${streetsReq} 个街道`
    : `核心区 ${tiles.length} 瓦片`;

  dispatched++;
  const hs = (hourStat[band] = hourStat[band] || { band, dispatched: 0, effective: 0, roads: 0, km: 0 });
  hs.dispatched++;
  if (isEffective) { effective++; hs.effective++; hs.roads += roadsInFile; hs.km += tiles.reduce((s, t) => s + (t.kmTotal || 0), 0); }
  if (ok) {
    const label = `${L.getUTCFullYear()}-${String(L.getUTCMonth() + 1).padStart(2, '0')}-${String(L.getUTCDate()).padStart(2, '0')} ${String(L.getUTCHours()).padStart(2, '0')}:${String(L.getUTCMinutes()).padStart(2, '0')}`;
    if (!firstLocal || label < firstLocal) firstLocal = label;
    if (!lastLocal || label > lastLocal) lastLocal = label;
    localDates.add(`${L.getUTCFullYear()}-${String(L.getUTCMonth() + 1).padStart(2, '0')}-${String(L.getUTCDate()).padStart(2, '0')}`);
  }

  bands[band] = bands[band] || { samples: 0, effective: 0, roads: {}, footprints: new Set(), fpKeys: new Set() };
  bands[band].samples++;
  bands[band].footprints.add(footprint);
  bands[band].fpKeys.add(fpKey);
  if (isEffective) bands[band].effective++;

  // evaluation 聚合：同一轮多个瓦片取里程加权平均（近似为算术平均亦可，此处用 km 权）
  const ev = (bandEval[band] = bandEval[band] || { n: 0, expedite: 0, congested: 0, blocked: 0, unknown: 0, wsum: 0, status: [] });
  for (const t of tiles) {
    if (!t.evaluation) continue;
    const w = t.kmTotal || 1;
    const p = (x) => (x == null || isNaN(x) ? null : x);
    const item = { expedite: p(t.evaluation.expeditePct), congested: p(t.evaluation.congestedPct), blocked: p(t.evaluation.blockedPct), unknown: p(t.evaluation.unknownPct) };
    if ([item.expedite, item.congested, item.blocked].every((x) => x === null)) continue;
    for (const k of ['expedite', 'congested', 'blocked', 'unknown']) if (item[k] != null) ev[k] += item[k] * w;
    ev.wsum += w; ev.n++;
    if (t.overall != null) ev.status.push(t.overall);
  }

  // 按 polyline 指纹在同一轮内去重：高德返回的是整条路的完整 polyline，同一路段会被
  // 多个采样几何重复返回（实测 786 条记录实为 322 条，虚增里程 738.6km）。
  const seenPoly = new Set();
  for (const tile of tiles) {
    for (const r of tile.roads || []) {
      if (!r.name) continue;
      if (r.poly) { if (seenPoly.has(r.poly)) continue; seenPoly.add(r.poly); }
      const rd = (roadIndex[r.name] = roadIndex[r.name] || { name: r.name, byBand: {}, tile: tile.tile, directions: new Set(), streetKm: {}, unknown: 0 });
      if (r.direction) rd.directions.add(r.direction);
      // 街道归属：新格式每条路段带 streetKm（沿 polyline 每 20m 打点判定，跨街道拆分）。
      // 老格式没有 → 报告侧回退到人工的瓦片→街道映射表。取各时段最大值，避免累加放大。
      if (r.streetKm) for (const [st, km] of Object.entries(r.streetKm)) rd.streetKm[st] = Math.max(rd.streetKm[st] || 0, km);
      const b = (rd.byBand[band] = rd.byBand[band] || { status: [], speed: [], km: [], unknown: 0 });
      // **status=0（高德「未知」）是缺失值，不是「畅通」**，绝不能当 0 参与状态平均 ——
      // 那等于把拥堵样本平均掉。实测踩到过：红花湖路 18:00 = [3,0,2,1,0]，含 0 得 1.20
      // （判成「畅通」），剔除 0 得 2.0（「缓行」）—— 一条当天有拥堵样本的路被显示成畅通。
      // 全量扫描：667 个「路段×时段档」里有 26 个因此被判错档（含长深高速惠州支线、
      // 三环南路、环镇路）。故状态均值只用 status ≥ 1 的样本，未知单独计数。
      const st = Number(r.status);
      if (st === 0) { b.unknown++; rd.unknown++; }
      else b.status.push(st);
      if (r.speed) {
        b.speed.push(Number(r.speed));
        const k = Number(r.km);
        if (k > 0) { b.km.push(k); kmKnown++; }
        else { b.km.push(kmPrior[r.name] || 0); if (kmPrior[r.name]) kmImputed++; }
      }

      const bs = (bands[band].roads[r.name] = bands[band].roads[r.name] || { statuses: [] });
      if (st !== 0) bs.statuses.push(st);
    }
  }
}

const avg = (a) => (a && a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// ---------- per-band summary ----------
const bandSummary = Object.entries(bands)
  .map(([band, v]) => {
    // 状态均值只用有效样本（status ≥ 1）；全是「未知」的路段 avgStatus 为 null，
    // 不能当成 0 混进 congestionIndex 的分母（会把整体拥堵指数稀释）。
    const roads = Object.entries(v.roads).map(([name, r]) => ({ name, avgStatus: avg(r.statuses) }))
      .filter((r) => r.avgStatus != null);
    const congested = roads.filter((r) => r.avgStatus >= 2.5).length;
    const idx = avg(roads.map((r) => r.avgStatus));
    // 该时段所有路段（跨瓦片）的里程加权均速
    const pairs = [];
    for (const rd of Object.values(roadIndex)) {
      const b = rd.byBand[band];
      if (!b) continue;
      for (let i = 0; i < b.speed.length; i++) pairs.push({ km: b.km[i] || 0, speed: b.speed[i] });
    }
    const kmh = wSpeed(pairs);
    const e = bandEval[band];
    return {
      band,
      samples: v.samples,
      effective: v.effective,
      footprints: [...v.footprints],
      footprintKeys: [...v.fpKeys],
      scope: v.footprints.size === 1 ? [...v.footprints][0] : '混合覆盖',
      roadCount: roads.length,
      kmh: kmh ? +kmh.toFixed(1) : null,
      congestionIndex: idx ? +idx.toFixed(2) : null,
      congestedRoads: congested,
      congestionRatio: roads.length ? +((congested / roads.length) * 100).toFixed(1) : 0,
      evaluation: e && e.wsum ? {
        expedite: +(e.expedite / e.wsum).toFixed(1),
        congested: +(e.congested / e.wsum).toFixed(1),
        blocked: +(e.blocked / e.wsum).toFixed(1),
        status: avg(e.status) ? +avg(e.status).toFixed(2) : null,
        description: avg(e.status) ? STATUS_LABEL[Math.round(avg(e.status))] : null,
      } : null,
      topCongested: roads
        .filter((r) => r.avgStatus >= 2)
        .sort((a, b) => b.avgStatus - a.avgStatus)
        .slice(0, 10)
        .map((r) => ({ ...r, label: STATUS_LABEL[Math.round(r.avgStatus)] || '未知' })),
    };
  })
  .sort((a, b) => a.band.localeCompare(b.band));

// ---------- road x band matrix ----------
const roadMatrix = Object.values(roadIndex)
  .map((r) => {
    const byBand = {};
    const byBandSpeed = {};
    let worst = 0, worstBand = null, totalSamples = 0;
    const allPairs = [];
    for (const [band, b] of Object.entries(r.byBand)) {
      const a = avg(b.status);
      // 注意不能写 `a ? … : null`：高德 status=0 表示「未知」，某条路整档全是未知时
      // avg 恰好为 0，用真值判断会把它存成 null —— 报告里渲染成「—」（=该时段无采样），
      // 与「采了但都是未知」混为一谈。实测踩到过：惠新中街 74 个样本全是未知，
      // 表格里却显示成没有数据。这里只对真正没有样本（null/NaN）留空。
      byBand[band] = a == null || isNaN(a) ? null : +a.toFixed(2);
      const pairs = b.speed.map((s, i) => ({ km: b.km[i] || 0, speed: s }));
      allPairs.push(...pairs);
      const sp = wSpeed(pairs);
      byBandSpeed[band] = sp == null || !isFinite(sp) ? null : +sp.toFixed(1);
      totalSamples += b.status.length;
      if (a != null && a > worst) { worst = a; worstBand = band; }
    }
    const ws = wSpeed(allPairs);
    const streetKmTotal = Object.values(r.streetKm || {}).reduce((s, x) => s + x, 0);
    return {
      name: r.name,
      tile: r.tile,
      byBand,
      byBandSpeed,
      // samples = **有效状态样本数**（status ≥ 1）；status=0（高德「未知」）单列
      // unknownSamples，不参与状态均值。不这么分，一条有拥堵样本的路会被未知样本
      // 平均成「畅通」（实测 667 个组合里 26 个中招）。
      samples: totalSamples,
      unknownSamples: r.unknown || 0,
      // 逐点采样得到的街道归属（街道 → 该路在本街道内的里程 km）。
      // 报告的场景-街道映射优先用它；为空说明该路只出现在老格式采样里。
      streets: r.streetKm || {},
      streetKmTotal: streetKmTotal ? +streetKmTotal.toFixed(2) : 0,
      mainStreet: streetKmTotal ? Object.entries(r.streetKm).sort((a, b) => b[1] - a[1])[0][0] : null,
      avgSpeed: ws ? +ws.toFixed(1) : null,      // 里程加权
      avgSpeedSimple: avg(allPairs.map((p) => p.speed)) ? +avg(allPairs.map((p) => p.speed)).toFixed(1) : null,
      worst: +worst.toFixed(2),
      worstBand,
      worstLabel: STATUS_LABEL[Math.round(worst)] || '未知',
    };
  })
  .sort((a, b) => b.worst - a.worst);

// ---------- 采样覆盖（调度 vs 有效 × 24 小时）----------
// 报告第 2 节要如实说明：哪些小时真有数据、哪些只是调度了、哪些根本没采。
const ALL_HOURS = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
const hours = ALL_HOURS.map((h) => {
  const s = hourStat[h] || { dispatched: 0, effective: 0, roads: 0, km: 0 };
  return { hour: h, dispatched: s.dispatched, effective: s.effective, roads: s.roads, km: +s.km.toFixed(1) };
});
const dateOf = (label) => (label ? label.split(' ')[0] : null);
const weekdayOf = (label) => {
  const ds = dateOf(label);
  if (!ds) return null;
  const [y, m, d] = ds.split('-').map(Number);
  return WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};
const dateList = [...localDates].sort();
const coverage = {
  dispatched,
  effective,
  failed: dispatched - effective,
  successRate: dispatched ? Math.round((effective / dispatched) * 1000) / 10 : 0,
  firstSample: firstLocal,
  lastSample: lastLocal,
  firstWeekday: weekdayOf(firstLocal),
  dates: dateList,
  dayKinds: (() => {
    const m = {};
    for (const ds of dateList) {
      const [y, mo, da] = ds.split('-').map(Number);
      const w = WD[new Date(Date.UTC(y, mo - 1, da)).getUTCDay()];
      m[w] = (m[w] || 0) + 1;
    }
    return m;
  })(),
  hours,
  hoursWithData: hours.filter((h) => h.effective > 0).map((h) => h.hour),
  hoursDispatchedEmpty: hours.filter((h) => h.dispatched > 0 && h.effective === 0).map((h) => h.hour),
  hoursNotDispatched: hours.filter((h) => h.dispatched === 0).map((h) => h.hour),
};

// ---------- 实测均速标定（供报告替换「纯假设的巡航 30km/h」）----------
// 口径：各时段所有路段按几何里程加权。报告用它来校验建模用的巡航/折减假设。
const withKmh = bandSummary.filter((b) => b.kmh != null);
const speedCalib = {
  byBand: withKmh.map((b) => ({ band: b.band, kmh: b.kmh, samples: b.effective, roads: b.roadCount, scope: b.scope, footprintKeys: b.footprintKeys })),
  worstBand: withKmh.length ? withKmh.reduce((a, b) => (b.kmh < a.kmh ? b : a)).band : null,
  worstKmh: withKmh.length ? Math.min(...withKmh.map((b) => b.kmh)) : null,
  bestKmh: withKmh.length ? Math.max(...withKmh.map((b) => b.kmh)) : null,
  // 最差时段相对最好时段的折减比（实测；模型里用的 0.8 折减系数可据此校核）
  observedRatio: (() => {
    const w = withKmh.length ? Math.min(...withKmh.map((b) => b.kmh)) : null;
    const b = withKmh.length ? Math.max(...withKmh.map((b) => b.kmh)) : null;
    return w && b ? +(w / b).toFixed(3) : null;
  })(),
  note: '网络里程加权（跨瓦片、跨路段），非单车巡航速度；用于校验建模假设而非直接替换',
  kmKnown,
  kmImputed,
};

const footprintCount = {};
for (const b of bandSummary) for (const f of b.footprints) footprintCount[f] = (footprintCount[f] || 0) + 1;
const result = {
  samples: dispatched,
  effectiveSamples: effective,
  coverage,
  bandsCovered: bandSummary.map((b) => b.band),
  bandSummary,
  speedCalib,
  roadMatrix,
  footprintNote: {
    counts: footprintCount,
    text: '各时段的采样覆盖范围不同（核心区 6 瓦片 vs 全区 18 街道）。路网构成不同 → 跨时段的加权均速不可直接横比，报告已按 scope 字段分开标注。',
  },
};
fs.writeFileSync(path.join(OUT, 'congestion.json'), JSON.stringify(result, null, 2));

// ---------- CSV: 路段 × 时间 × 拥堵情况 ----------
const bandCols = bandSummary.map((b) => b.band);
const csvLines = ['路段,主体街道,采样几何,有效样本数,未知样本数(不计入状态均值),加权均速km/h,' + bandCols.join(',') + ',最差状态,最差时段'];
for (const r of roadMatrix) {
  csvLines.push([
    `"${r.name.replace(/"/g, '""')}"`,
    `"${r.mainStreet || '—'}"`,
    `"${r.tile}"`,
    r.samples,
    r.unknownSamples || 0,
    r.avgSpeed ?? '',
    ...bandCols.map((b) => (r.byBand[b] ?? '')),
    r.worstLabel,
    r.worstBand || '',
  ].join(','));
}
// UTF-8 BOM so Excel opens CJK correctly; CRLF line endings for Windows.
fs.writeFileSync(path.join(OUT, 'congestion_roads.csv'), '\uFEFF' + csvLines.join('\r\n'), 'utf8');

console.log(`有效采样 ${effective} 次 · 覆盖 ${dateList.length} 天（${Object.entries(coverage.dayKinds).map(([k, v]) => k + '×' + v).join(' ')}）`);
if (coverage.firstSample) console.log(`采样窗口（东八区）: ${coverage.firstSample} → ${coverage.lastSample}`);
console.log();
console.log(`${'时段'.padEnd(7)} ${'采样'.padStart(4)} ${'路段数'.padStart(7)} ${'加权均速'.padStart(9)} ${'拥堵指数'.padStart(9)} ${'缓行+拥堵%'.padStart(11)}  覆盖足迹`);
for (const b of bandSummary) {
  const ev = b.evaluation || {};
  const jam = ev.congested != null ? `${(ev.congested + (ev.blocked || 0)).toFixed(0)}%` : '-';
  console.log(`${b.band.padEnd(7)} ${String(b.effective).padStart(4)} ${String(b.roadCount).padStart(7)} ${String(b.kmh ?? '-').padStart(9)} ${String(b.congestionIndex ?? '-').padStart(9)} ${jam.padStart(11)}  ${b.scope}`);
}
if (speedCalib.byBand.length) {
  console.log(`\n实测均速标定：最差 ${speedCalib.worstBand} ${speedCalib.worstKmh}km/h · 最好 ${speedCalib.bestKmh}km/h · 实测折减比 ${speedCalib.observedRatio}`);
}
console.log(`\n路段总数: ${roadMatrix.length}，明细已写入 out/congestion_roads.csv（Excel 可直接打开）`);
console.log('\n最拥堵路段 Top10:');
roadMatrix.slice(0, 10).forEach((r, i) =>
  console.log(`  ${String(i + 1).padStart(2)}. ${r.name.padEnd(16)} 最差=${r.worstLabel} @ ${r.worstBand || '-'}  加权均速=${r.avgSpeed ?? '-'}km/h`));
