// 分时段均速补全：实测锚点 + 公开参考曲线的「形状迁移」推断。
//
// 为什么需要：
//   高德交通态势 Web 服务（v3/traffic/status）只有实时快照 —— 无时间参数、无历史
//   查询，所以分时段态势只能靠自采累积。本工程现有 36 个有效样本，只落在 7 个小时
//   档（18:00 / 19:00–21:00 / 00:00–02:00），早高峰（07–09）、日间（09–17）、
//   22–23 时、凌晨（03–07）拿不到。本脚本把这 17 个小时补上，且每一步可复核。
//
// 补法（两步，不做黑箱）：
//   1) 参考形状：公开的「惠州逐小时拥堵延时指数」24h 曲线（见 sources）。它是全市
//      口径，只用它的**相对形状**（哪个小时更堵），不直接取它的绝对值。
//   2) 本地位准：用本工程 7 个实测小时档的里程加权均速，在 log 空间最小二乘拟合幂律
//          speed = a · index^(−b)
//      再回代到 24h 曲线上。→ 绝对水平来自本地实测，时间形状来自公开参考。
//
// 关键性质：拟合残差、每个小时是「实测」还是「推断」都写进输出，报告里逐格标注，
// 不把推断值当实测值用。随逐时采样累积，实测小时会逐个替换掉推断小时。
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const cong = JSON.parse(fs.readFileSync(path.join(OUT, 'congestion.json'), 'utf8'));

// ---------- 1. 公开参考：惠州逐小时拥堵延时指数（高德口径） ----------
// 来源见 sources；取「周一」列（工作日）。只用作相对形状。
const REF_DATE = '2026-09-28（周一）';
const REF_INDEX = {
  '00:00': 1.10, '01:00': 1.07, '02:00': 1.06, '03:00': 1.05, '04:00': 1.03,
  '05:00': 1.01, '06:00': 1.01, '07:00': 1.40, '08:00': 1.64, '09:00': 1.33,
  '10:00': 1.25, '11:00': 1.20, '12:00': 1.18, '13:00': 1.13, '14:00': 1.31,
  '15:00': 1.41, '16:00': 1.29, '17:00': 1.45, '18:00': 1.90, '19:00': 1.42,
  '20:00': 1.30, '21:00': 1.23, '22:00': 1.18, '23:00': 1.15,
};
const SOURCES = [
  {
    id: 'ref-curve',
    what: '惠州逐小时拥堵延时指数（周一 24 档）',
    publisher: '高德交通大数据（无敌电动网路口况页转载）',
    date: '2026-09-25 抓取',
    url: 'https://www.modiauto.com.cn/lukuang/ci_c441300.html',
    used: '本脚本的「参考形状」：只取各小时的相对高低',
    figures: '惠州 实时拥堵指数 1.12（畅通）· 实时平均速度 39km/h · 惠城区 1.01 / 58km/h',
  },
  {
    id: 'gov-2025',
    what: '全市工作日早晚高峰年平均拥堵延时指数 &lt; 1.5',
    publisher: '惠州市交通运输局 / 市公安局交管支队（行风热线面对面）',
    date: '2025-12-24',
    url: 'https://www.hznews.com/sz/202512/t20251225_1632678.shtml',
    used: '量级校验：全市高峰延时指数在 1.5 以内 = 畅通水平',
    figures: '40 个重点路口智慧化升级；核心试点路口高峰期平均延误指数下降 15%~20%',
  },
  {
    id: 'plan-huicheng',
    what: '惠城中心区高峰平均速度与延时指数（治理前后）',
    publisher: '惠州先锋网《做好一流交通规划，推动一流城市建设——以惠城中心区为例》',
    date: '规划期',
    url: 'https://www.hzzz.gov.cn/web/magazine/detail?id=2486',
    used: '量级校验：惠城中心区高峰均速 29.6 → 32.9km/h',
    figures: '高峰延时指数 1.56 → 1.35（降 13.5%）；主要通道高峰行程时间降 10%~12%',
  },
  {
    id: 'gaode-2020q3',
    what: '高德中国主要城市交通分析报告·惠州',
    publisher: '高德地图',
    date: '2020 Q3',
    url: 'https://www.toutiao.com/article/6905209199806906888/',
    used: '量级校验：惠州高峰延时指数 1.574 / 高峰均速 27.63km/h；惠城区 1.61 倍',
    figures: '全国 50 城第 38 位；惠城区为最拥堵区域',
  },
  {
    id: 'gaode-2017q3',
    what: '高德中国主要城市交通分析报告·惠州分时段车速',
    publisher: '高德地图 / 南方+',
    date: '2017 Q3',
    url: 'https://static.nfapp.southcn.com/content/201711/30/c819279.html',
    used: '形状校验：早高峰 25.10 > 晚高峰 21.31km/h，即晚高峰更堵',
    figures: '早高峰 25.10 · 晚高峰 21.31 · 平峰 28.05 · 全天 26.59 km/h',
  },
];

// ---------- 2. 用实测小时档拟合 speed = a · index^(−b) ----------
// **只在同一个路网构成上拟合**。2026-09-29 把空间覆盖从「核心区 6 瓦片」扩到「全区 18
// 街道」后，新档 10:00 实测 47.3km/h，比核心区同指数的拟合值高 5.7km/h —— 不是 10 点更
// 通畅，而是它的路网里多了大量 50~56km/h 的乡道/县道（沥林、汝湖、马安）。把不同足迹的
// 档混进一条曲线，等于用「路网构成差异」冒充「时间差异」。
// 做法：先按 footprintKey 投票选出**基准路网**（样本最多的那一类），只用基准档拟合；
// 其余实测档记进 calibration.excludedMeasured，仍然如实保留原值供报告单列。
const measured = {}; // hour -> {kmh, samples, roads, scope, fpKey}
const cand = [];
for (const b of cong.speedCalib.byBand || []) {
  if (REF_INDEX[b.band] === undefined) continue;
  const fpKey = (b.footprintKeys && b.footprintKeys.length === 1) ? b.footprintKeys[0] : 'mixed';
  cand.push({ hour: b.band, kmh: b.kmh, samples: b.samples, roads: b.roads, scope: b.scope, fpKey });
}
const fpVotes = {};
for (const c of cand) if (c.kmh > 0) fpVotes[c.fpKey] = (fpVotes[c.fpKey] || 0) + 1;
const baseFp = Object.entries(fpVotes).sort((a, b) => b[1] - a[1])[0];
const BASE_FP = baseFp ? baseFp[0] : null;
const excludedMeasured = [];
for (const c of cand) {
  if (c.kmh > 0 && c.fpKey === BASE_FP) measured[c.hour] = c;
  else excludedMeasured.push({ hour: c.hour, kmh: c.kmh, scope: c.scope, footprintKey: c.fpKey, reason: c.kmh > 0 ? '不同路网构成，不并入分时段曲线' : '无有效均速' });
}
if (excludedMeasured.length) {
  console.log(`基准路网 = ${BASE_FP}（${Object.keys(measured).length} 个实测档参与拟合）`);
  excludedMeasured.forEach((e) => console.log(`  排除 ${e.hour} 实测 ${e.kmh}km/h —— ${e.reason}（足迹 ${e.scope}）`));
}
const fitPts = Object.entries(measured).filter(([, v]) => v.kmh > 0);
if (fitPts.length < 3) {
  console.error('实测小时档不足 3 个，无法标定 —— 不生成推断值');
  process.exit(1);
}
let sx = 0, sy = 0, sxx = 0, sxy = 0;
for (const [h, v] of fitPts) {
  const x = Math.log(REF_INDEX[h]), y = Math.log(v.kmh);
  sx += x; sy += y; sxx += x * x; sxy += x * y;
}
const n = fitPts.length;
const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx); // = −b
const b = -slope;
const a = Math.exp((sy - slope * sx) / n);
const predict = (idx) => a * Math.pow(idx, -b);
const fitted = fitPts.map(([h, v]) => {
  const p = predict(REF_INDEX[h]);
  return { hour: h, index: REF_INDEX[h], measured: v.kmh, fit: +p.toFixed(1), err: +(p - v.kmh).toFixed(1) };
});
const errs = fitted.map((f) => f.err);
const rmse = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length);
const maxAbsErr = Math.max(...errs.map(Math.abs));

// ---------- 3. 24 小时：实测优先，其余按曲线推断 ----------
const hours = Object.keys(REF_INDEX).sort().map((h) => {
  const idx = REF_INDEX[h];
  if (measured[h]) {
    return { hour: h, mode: 'measured', index: idx, kmh: measured[h].kmh, samples: measured[h].samples, roads: measured[h].roads };
  }
  return { hour: h, mode: 'inferred', index: idx, kmh: +predict(idx).toFixed(1) };
});
const kmhOf = (h) => (hours.find((x) => x.hour === h) || {}).kmh;
const meanOf = (hs) => +(hs.reduce((s, h) => s + (kmhOf(h) || 0), 0) / hs.length).toFixed(1);

// 与报告第 6 节 BANDS 一一对应的 4 个时段 + 一个「凌晨」补充段
const BAND_DEFS = [
  { key: 'amPeak',  label: '早高峰',   range: '07:00–09:00', hours: ['07:00', '08:00'] },
  { key: 'daytime', label: '日间平峰', range: '09:00–17:00', hours: ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'] },
  { key: 'pmPeak',  label: '晚高峰',   range: '17:00–19:00', hours: ['17:00', '18:00'] },
  { key: 'evening', label: '晚间',     range: '19:00–23:00', hours: ['19:00', '20:00', '21:00', '22:00'] },
  { key: 'night',   label: '夜间',     range: '23:00–03:00', hours: ['23:00', '00:00', '01:00', '02:00'] },
  { key: 'dawn',    label: '凌晨',     range: '03:00–07:00', hours: ['03:00', '04:00', '05:00', '06:00'] },
];
const bands = BAND_DEFS.map((d) => {
  const modes = d.hours.map((h) => (measured[h] ? 'measured' : 'inferred'));
  const mode = modes.every((m) => m === 'measured') ? 'measured'
    : modes.every((m) => m === 'inferred') ? 'inferred' : 'mixed';
  const hit = modes.filter((m) => m === 'measured').length;
  return {
    ...d, mode, measuredHours: hit, kmh: meanOf(d.hours),
    detail: d.hours.map((h) => ({ hour: h, mode: measured[h] ? 'measured' : 'inferred', index: REF_INDEX[h], kmh: kmhOf(h) })),
  };
});
const bandOf = (k) => bands.find((x) => x.key === k);

// 模型假设校验：第 6 节把晚高峰均速折减到 0.8。实测推断比是 早/晚 = ?
const ratioAssumed = 0.8;
const ratioObserved = +(bandOf('amPeak').kmh / bandOf('pmPeak').kmh).toFixed(3);

const result = {
  generatedAt: new Date().toISOString(),
  method: '公开参考曲线的相对形状 + 本地实测标定的幂律 speed = a·index^(−b)',
  formula: `speed_kmh = ${a.toFixed(1)} × index^(−${b.toFixed(3)})`,
  calibration: {
    a: +a.toFixed(2), b: +b.toFixed(3),
    freeFlowNote: `index=1（无延误）时 speed ≈ ${a.toFixed(1)}km/h，即该路网的模型自由流速度`,
    fittedOn: fitPts.map(([h]) => h),
    n: fitPts.length, rmse: +rmse.toFixed(2), maxAbsErr: +maxAbsErr.toFixed(2),
    residuals: fitted,
    // 拟合只在同一个路网构成上进行；不同足迹的实测档单独列出，不并入曲线
    baselineFootprint: BASE_FP,
    excludedMeasured,
    excludedNote: excludedMeasured.length
      ? `实测档 ${excludedMeasured.map((e) => e.hour).join('、')} 的采样足迹与基准路网不同（${excludedMeasured.map((e) => e.scope).join('、')}），路网构成含大量乡道/县道，均速不可与 ${BASE_FP} 档横比，故不参与曲线拟合，原值仍如实保留`
      : '所有实测档足迹一致',
  },
  refCurve: { date: REF_DATE, unit: '拥堵延时指数', scope: '全市口径（含惠东/博罗/龙门），仅取相对形状', values: REF_INDEX },
  hours, bands,
  modelCheck: {
    bandRatioAssumed: ratioAssumed,
    bandRatioObserved: ratioObserved,
    bandRatioObservedFromAM: bandOf('amPeak').kmh,
    bandRatioObservedFromPM: bandOf('pmPeak').kmh,
    note: `第 6 节假设「晚高峰 = 早高峰 ×${ratioAssumed}」；实测推断比 = ${bandOf('amPeak').kmh} : ${bandOf('pmPeak').kmh} = 1 : ${ratioObserved}，模型略偏保守`,
  },
  crossCheck: SOURCES.map((s) => ({ id: s.id, what: s.what, figures: s.figures })),
  sources: SOURCES,
};
fs.writeFileSync(path.join(OUT, 'congestion_ref.json'), JSON.stringify(result, null, 1));

// ---------- console ----------
console.log(`拟合样本 ${n} 个实测小时档 → ${result.formula}`);
console.log(`残差: RMSE ${rmse.toFixed(2)}km/h · 最大 ${maxAbsErr.toFixed(2)}km/h`);
console.log('  ' + fitted.map((f) => `${f.hour} 实测${f.measured}/拟合${f.fit}`).join('  '));
console.log('');
console.log('分时段均速（实测优先 · 其余按参考曲线推断）:');
for (const b of bands) {
  const tag = b.mode === 'measured' ? '实测' : b.mode === 'mixed' ? `实测+推断(${b.measuredHours}/${b.hours.length})` : '推断';
  console.log(`  ${b.label.padEnd(5)} ${b.range.padEnd(13)} ${String(b.kmh).padStart(5)}km/h   [${tag}]`);
}
console.log('');
console.log(`模型校验: 早高峰 ${bandOf('amPeak').kmh} : 晚高峰 ${bandOf('pmPeak').kmh} = 1 : ${ratioObserved}  (假设 1 : ${ratioAssumed})`);
console.log('wrote out/congestion_ref.json');
