// ODD 覆盖勾选表 + 配额置信度 + 路线×配额×排班×时段（单页）
// =============================================================================
// 三区块：
//   A 勾选表  4.3.2 的 24 维度收敛展开，逐项判定覆盖（依据全部来自 out/*.json）
//   B 配额    全区总数量 → 该选多少个 → 为什么这么选 → 本排班实际覆盖 → 达成误差
//             + 折线图（横轴样本量 n，左轴置信水平%，右轴估计误差±pp）
//   C 路线    重规划后的路线集（每街道 1–N 条），每条线带「元素 x/配额」标签与建议时段
//
// 数字纪律：正文所有统计值来自 out/*.json，不硬编码；与报告排班同源（report_alloc.json），
// 不符即 throw。路线途经量按导航折线几何实测（odd_quota_roads.routeStats）。
const fs = require('fs');
const path = require('path');
const https = require('https');
// 里程口径正式章节（与 scenario_tests.html 共用同一实现 → 两页文字/数字必然同源）
const { mileageSection } = require('./lib_mileage_section');

const OUT = path.join(__dirname, 'out');
const readOut = (n) => JSON.parse(fs.readFileSync(path.join(OUT, n + '.json'), 'utf8'));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f1 = (x) => +Number(x).toFixed(1);

const ck = readOut('odd_checklist');
const q = readOut('odd_quota_roads');
const oddSel = readOut('odd_selection');
const routes = readOut('routes');
const alloc = readOut('report_alloc');
// 宽凳约束版几何（E 区主图的数据源，tools/build_routes_kd.py 产出）——
// 里程口径桥要用它的「可画里程 / 缺口里程」，缺失时降级为不显示该行
const KDR = fs.existsSync(path.join(OUT, 'routes_kd.json')) ? readOut('routes_kd') : null;
const chartJs = fs.readFileSync(path.join(__dirname, 'chartjs.min.js'), 'utf8');
const STD = oddSel.tiers.std;
// 宽凳高精地图真值（sim-map 工程 · 惠城区 441302）—— 2026-09-30 补入的第三数据源
// 宽凳几何接入产物（2026-09-30）：停止线↔信号灯距离核验、车道标线逐线线型覆盖
const KM = fs.existsSync(path.join(OUT, 'kuandeng_markings.json')) ? readOut('kuandeng_markings') : null;
const markOf = {};
if (KM) for (const r of KM.routes) markOf[r.key] = r;
// 道路类型里程（2026-10-27 用户要求：每条路线右侧标「三档里程占比」）——
// build_route_class_km.js 产出：routes_kd.polys 折线逐段吸附 OSM 道路 way，按三档口径累加。
// I型=高速/快速(motorway/trunk) II型=城市主/次/支(primary/secondary/tertiary) III型=其他(县乡乡村/街巷/内部道路等)
const RCK = fs.existsSync(path.join(OUT, 'route_class_km.json')) ? readOut('route_class_km') : null;
const classKmOf = new Map(RCK ? RCK.routes.map((r) => [`${r.street}#${r.n}`, r]) : []);
const markTypeRoutes = {};   // 线型码 → 触达该线型的路线条数
if (KM) {
  for (const r of KM.routes) for (const t of r.types) markTypeRoutes[t.code] = (markTypeRoutes[t.code] || 0) + 1;
}
const markUnionCodes = KM ? Object.keys(markTypeRoutes).map(Number).sort((a, b) => a - b) : [];
const markDistCodes = KM ? Object.keys(KM.district.byType).map(Number).sort((a, b) => a - b) : [];

// ---------- 元素区内真实存量（独立重算，用于交叉校验 B 表）----------
// 2026-10-16 用户要求：原 D 节「全元素真实情况校准」与 B 节配额表**逐列重复**，只保留 B。
// 随后用户又明确**只留区内真实、不要留源**（原话「肯定只留区内真实的，不要留源的」）→
// 本表不再展示源条数 / 剔载体 / 合并 / 数据源小字，只保留这一处「区内数交叉校验」的作用：
// 配额层 districtTotal 与 calib.inArea 不符 → 行内标 ⚠。
// 数据源 tools/audit_all_elements.js → out/element_calibration.json。
const calib = fs.existsSync(path.join(OUT, 'element_calibration.json'))
  ? readOut('element_calibration') : null;
const calibByKey = {};
if (calib) for (const r of calib.kinds) calibByKey[r.key] = r;
const CAL_N = calib ? calib.kinds.length : 0;
let calWarn = 0;
if (calib) for (const r of calib.kinds) {
  const Qt = q.quota.find((x) => x.key === r.key);
  if (Qt && Qt.districtTotal !== r.inArea) calWarn++;
}

// ---------- 统计函数 ----------
function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return s * y;
}
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
// 估计误差（95% 置信，p 为覆盖率；N 有限时做有限总体校正）
const errOf = (n, p = 0.9, N = null) => {
  if (!n || n <= 0) return null;
  const fpc = N && N > 1 ? Math.sqrt(Math.max(0, (N - n) / (N - 1))) : 1;
  return 1.96 * Math.sqrt((p * (1 - p)) / Math.min(n, N || n)) * fpc * 100;
};
// 置信水平（允许误差固定 e，反解 z → 2Φ(z)−1）
const confOf = (n, e = 0.05, p = 0.9) => {
  const z = (e * Math.sqrt(n)) / Math.sqrt(p * (1 - p));
  return (2 * normCdf(z) - 1) * 100;
};
// 反解：达到目标置信水平所需样本量
const nForConf = (target, e = 0.05, p = 0.9) => {
  let lo = 2, hi = 20000;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (confOf(mid, e, p) < target) lo = mid; else hi = mid;
  }
  return Math.ceil(hi);
};

const KIND_LABEL = Object.fromEntries(q.quota.map((x) => [x.key, x.label]));
const quotaOf = (k) => q.quota.find((x) => x.key === k);
const coveredOf = (k) => q.routeCovered[k] || 0;
const SKIP_KEYS = new Set(['tolls', 'restAreas', 'ramps']); // 高速域：只计不配额

// ---------- A 区：勾选表 ----------
const VERDICT = {
  ok: { mark: '✓', cls: 'v-ok', text: '已覆盖' },
  partial: { mark: '△', cls: 'v-pt', text: '部分覆盖' },
  'amap-miss': { mark: '✗', cls: 'v-am', text: '无数据源' },
  'osm-sparse': { mark: '✗', cls: 'v-os', text: '数据不足' },
  'not-fetched': { mark: '✗', cls: 'v-nf', text: '无数据源' },
  'no-source': { mark: '✗', cls: 'v-ns', text: '无数据源' },
  'out-of-scope': { mark: '○', cls: 'v-oo', text: '非地图项' },
};
const TAG_CLS = { src: 't-src', cov: 't-cov', gap: 't-gap', fix: 't-fix' };
// 2026-10-17 A 区新增「来源」列：OSM / 宽凳 / 高德 / 多源 / —（非地图域）。
// 规则（尽量填满）：
//   1) src 标签含"宽凳"→宽凳；含"高德"不含 OSM→高德；含"OSM"→OSM；
//   2) verdict=out-of-scope → '—'（非地图域，本就无数据源）；
//   3) gap 含"两源均无/无数据源"→'—'（已探测无源）；
//   4) 按 quotaKind / item 归源（路网·调头圈·铁路道口·人行横道·施工·living/access 等 OSM 抓取；
//      POI/学校医院·收费站·路况→高德；stoplines·signals·roundabout→宽凳）；
//   5) conf A → 宽凳；其余 evidence 字样兜底；仍无法归源的"原文/自车"类 → '—'。
const SRC_BY_KEY = {
  signals: '宽凳', roundabout: '宽凳', stoplines: '宽凳', barriers: '宽凳',
  crossings: 'OSM', tunnels: 'OSM', bridges: 'OSM', construction: 'OSM',
  turning: 'OSM', railCrossings: 'OSM', livingStreets: 'OSM', pedestrian: 'OSM',
  accessRoads: 'OSM', footbridges: 'OSM', busDepots: 'OSM',
  schools: '高德', hospitals: '高德', markets: '高德', parking: '高德', fuel: '高德',
  charging: '高德', tolls: '高德', restAreas: '高德', fireStations: '高德',
  policeStations: '高德', interchanges: '高德', ramps: '高德', busStops: '高德',
};
function sourceOf(r) {
  const srcs = (r.tags || []).filter(([k]) => k === 'src').map(([, t]) => String(t));
  const joined = srcs.join(' ');
  if (/宽凳/.test(joined)) return '宽凳';
  if (/高德/.test(joined) && !/OSM/.test(joined)) return '高德';
  if (/OSM/.test(joined)) return 'OSM';
  if (r.verdict === 'out-of-scope') return '—';
  const gaps = (r.tags || []).filter(([k]) => k === 'gap').map(([, t]) => String(t)).join(' ');
  if (/两源均无|无数据源|street_lamp/.test(gaps)) return '—';
  // quotaKind 直接归源
  if (r.quotaKind && SRC_BY_KEY[r.quotaKind]) return SRC_BY_KEY[r.quotaKind];
  // 路网类：street_stats 的路网底子是 OSM roads
  if (/路网|县乡|等级/.test(joined)) return 'OSM';
  if (/原文|自车|档位|时速/.test(joined)) return '—';
  if (/高德/.test(r.evidence || '')) return '高德';
  if (/宽凳/.test(r.evidence || '')) return '宽凳';
  if (/OSM/.test(r.evidence || '')) return 'OSM';
  if (r.conf === 'A') return '宽凳';
  return '—';
}
let aRows = '';
let lastLayer = '';
for (const r of ck.rows) {
  if (r.layer !== lastLayer) {
    lastLayer = r.layer;
    aRows += `<tr class="layer"><td colspan="5">${esc(r.layer)}</td></tr>`;
  }
  const v = VERDICT[r.verdict] || { mark: '?', cls: '', text: r.verdict };
  const tags = (r.tags || []).map(([k, t]) => `<span class="tg ${TAG_CLS[k] || 't-src'}">${esc(t)}</span>`).join('');
  const so = sourceOf(r);
  const soCls = so === '宽凳' ? 'so-kd' : so === '高德' ? 'so-am' : so === 'OSM' ? 'so-osm' : 'so-na';
  aRows += `<tr${r.verdict === 'ok' ? ' class="okrow"' : ''}>
    <td class="dim">${esc(r.dim)}</td>
    <td class="item">${esc(r.item)}</td>
    <td class="vd ${v.cls}"><b>${v.mark}</b> ${v.text}</td>
    <td class="src-col ${soCls}">${so}</td>
    <td class="tags">${tags}${r.conf ? `<span class="tg t-conf">源置信 ${r.conf}</span>` : ''}</td>
  </tr>`;
}
// ok 行默认折叠：加 class 已完成（okrow）。折叠态由内联脚本 + CSS 控制，见模板区 okfold。
const okN2 = ck.rows.filter(r => r.verdict === 'ok').length;
const tally = ck.tally;

// ---------- B 区：配额主表 ----------
// 2026-10-16 用户明令：本表**只留「区内真实」这一个数**，不再展示源条数（源 → 剔载体 → 合并）
// 与数据源标注 —— 原话「肯定只留区内真实的，不要留源的」。原 D 节并入 B 时加的
// `<span class="prov">` 溯源小字（口径链 / 数据源）因此全部撤掉；区内数仍由 `element_calibration.json`
// 独立重算把关（不一致时行内仍打 ⚠ 标记）。
const bRows = q.quota.map((s) => {
  const N = s.districtTotal;
  const n = s.quotaStd;
  const cov = coveredOf(s.key);
  const rate = N > 0 ? cov / N : 0;
  const eCov = errOf(cov, 0.9, N);
  const eQuota = errOf(Math.min(n, N), 0.9, N);
  const why = SKIP_KEYS.has(s.key)
    ? `<span class="why w-hw">高速域</span><span class="why-n">只计不配额（无人小车不上主线）</span>`
    : s.exhaustive
      ? `<span class="why w-ex">穷举全选</span><span class="why-n">存量 ${N} &lt; 50，全选无抽样误差</span>`
      : `<span class="why w-st">统计抽样</span><span class="why-n">n=${n} → ±${(errOf(Math.min(n, N), 0.9, N) || 5).toFixed(1)}%@95%CI</span>`;
  const cls = rate >= 0.8 ? 'r-hi' : rate >= 0.5 ? 'r-mid' : rate >= 0.2 ? 'r-low' : 'r-bad';
  const eCls = eCov == null ? '' : eCov <= 5 ? 'e-hi' : eCov <= 10 ? 'e-mid' : 'e-low';
  const cr = calibByKey[s.key];
  const qBad = cr && cr.inArea !== N;
  return `<tr${SKIP_KEYS.has(s.key) ? ' class="skip"' : ''}>
    <td class="item">${esc(s.label)}</td>
    <td class="num">${N}${qBad ? ' <span class="prov" style="color:var(--bad)">⚠ 与独立重算不符</span>' : ''}</td>
    <td class="num"><b>${SKIP_KEYS.has(s.key) ? '—' : n}</b></td>
    <td class="whyc">${why}</td>
    <td class="num">${cov}</td>
    <td class="num ${cls}">${(rate * 100).toFixed(1)}%</td>
    <td class="num ${eCls}">${eCov == null ? '—' : `±${eCov.toFixed(1)}%`}</td>
    <td class="num mut">${n >= N ? '全取' : eQuota == null ? '—' : `±${eQuota.toFixed(1)}%`}</td>
  </tr>`;
}).join('');

// ---------- B2 区：交通标线线型覆盖（宽凳真值；不走 x/139，见说明） ----------
const PAINTED_SET = new Set([1, 2, 3, 4, 5, 6, 7, 8, 14, 15, 16, 17]);
const PHYSICAL_SET = new Set([9, 10, 11, 12, 13]);
const markClass = (c) => (PAINTED_SET.has(c) ? '面画标线' : PHYSICAL_SET.has(c) ? '物理边界（路缘石/护栏/墙体）' : '规格书外码（含义未定义）');
let markRows = '';
if (KM) {
  for (const code of markDistCodes) {
    const cnt = KM.district.byType[code] || 0;
    const rn = markTypeRoutes[code] || 0;
    const pct = KM.routes.length ? (rn / KM.routes.length) * 100 : 0;
    const cls = pct >= 60 ? 'r-hi' : pct >= 30 ? 'r-mid' : pct > 0 ? 'r-low' : 'r-bad';
    markRows += `<tr>
      <td class="item">${esc(KM.dict.lineType[code] || code)}</td>
      <td class="mut">${markClass(code)}</td>
      <td class="num">${cnt}</td>
      <td class="num">${rn}</td>
      <td class="num ${cls}">${pct.toFixed(1)}%</td>
    </tr>`;
  }
}

// 公式代入（139 的来历）
const Z = 1.96, P = 0.9, E = 0.05;
const nRaw = (Z * Z * P * (1 - P)) / (E * E);
const e139 = errOf(139), e35 = errOf(35), e200 = errOf(200), e553 = errOf(553);
const n80 = nForConf(80), n99 = nForConf(99);

// 图表数据
const NS = [];
for (let n = 20; n <= 600; n += 10) NS.push(n);
const confLine = NS.map((n) => +confOf(n).toFixed(2));
const errLine = NS.map((n) => +errOf(n).toFixed(2));
const MARK = [35, n80, 139, 200, 553].map((n) => ({ n, c: +confOf(n).toFixed(1), e: +errOf(n).toFixed(1) }));
const markPts = NS.map((n) => (MARK.some((m) => m.n === n) ? +confOf(n).toFixed(2) : null));

// 公式有效性验证（用实测覆盖率反代）已于 2026-09-30 按用户要求从页面移除；
// 口径仍保留在此供后续脚本核对：p̂ 取 routeCovered÷districtTotal。

// ---------- C 区：排班 + 路线 ----------
const byStreet = {};
for (const r of q.routeStats) (byStreet[r.street] = byStreet[r.street] || []).push(r);
const streetRouteOf = {};
for (const rt of routes.routes) if (rt.status === 'ok') streetRouteOf[rt.street] = rt;
const streetOrder = [...new Set(q.routeStats.map((r) => r.street))];

// limit = Infinity：覆盖几类就标几类（2026-10-15 用户要求，原先硬截前 8）
function chipsOf(counts, limit = Infinity) {
  return Object.entries(counts || {})
    .filter(([k, v]) => v > 0 && KIND_LABEL[k] && !SKIP_KEYS.has(k))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, v]) => {
      const qq = quotaOf(k);
      const pct = qq && qq.quotaStd > 0 ? Math.round((v / qq.quotaStd) * 100) : 0;
      const cls = pct >= 100 ? 'c-hi' : pct >= 50 ? 'c-mid' : pct >= 15 ? 'c-low' : 'c-bad';
      return `<span class="qc ${cls}" title="${esc(KIND_LABEL[k])}：本线途经 ${v} 个 · 占标准档配额 ${qq ? qq.quotaStd : '—'} 的 ${pct}%（此处为单条路线几何实测值；B 区配额表的「实际覆盖」为全区所有路线去重后的合计，两者口径不同）">${esc(KIND_LABEL[k])} ${v}/${qq ? qq.quotaStd : '—'}</span>`;
    }).join('');
}
function streetChips(list) {
  const agg = {};
  for (const r of list) for (const [k, v] of Object.entries(r.counts || {})) agg[k] = (agg[k] || 0) + v;
  return chipsOf(agg);
}
function markChip(street, i) {
  const m = markOf[`${street}#${i}`];
  if (!m || !m.types.length) return '';
  const painted = m.types.filter((t) => PAINTED_SET.has(t.code)).length;
  const cls = m.types.length >= 8 ? 'c-hi' : m.types.length >= 5 ? 'c-mid' : 'c-low';
  return `<span class="qc mk ${cls}" title="宽凳 DIVIDER 几何实测：本线 ${KM ? KM.passRadiusM : 60}m 内触达 ${m.hits} 条车道线，覆盖 ${m.types.length} 种线型（面画标线 ${painted} 种）｜${m.types.map((t) => t.label).join('、')}">标线 ${m.types.length}/${markDistCodes.length} 类</span>`;
}
const slotText = (r) => (r.slot && r.slot.slots ? r.slot.slots.join(' · ') : '—');
// 道路类型里程标签：I型 高速/快速 · II型 城市主/次/支 · III型 其他（县乡乡村/街巷等）。
// 里程按导航折线逐段吸附 OSM 道路 way 累加（route_class_km.json），不足 0.05km 的档不显示。
function classKmChip(street, i, distKm) {
  const c = classKmOf.get(`${street}#${i + 1}`);
  if (!c) return '';
  const pct = (k) => distKm > 0 ? Math.round((k / distKm) * 100) : 0;
  // III 型细分展开（route_class_km.iiiDetail）：县乡乡村路/街巷/内部道路等各列一档，
  // 不再一锅烩成"其他 1.4km"。细分与 III 总额同源（OSM highway 值逐段归档）。
  const iiiParts = Object.entries(c.iiiDetail || {})
    .map(([lab, k]) => `${lab} ${k}km·${pct(k)}%`);
  const parts = [
    c.km.I > 0.05 ? `高速快速 ${c.km.I}km·${pct(c.km.I)}%` : '',
    c.km.II > 0.05 ? `城市道路 ${c.km.II}km·${pct(c.km.II)}%` : '',
    ...(iiiParts.length ? iiiParts : (c.km.III > 0.05 ? [`其他 ${c.km.III}km·${pct(c.km.III)}%`] : [])),
  ].filter(Boolean);
  if (!parts.length) return '';
  const iiiTip = Object.entries(c.iiiDetail || {}).map(([lab, k]) => `${lab} ${k}km（${pct(k)}%）`).join(' · ');
  const tip = `按导航折线逐段匹配 OSM 道路等级累加（${c.matchedPct}% 里程可匹配，未匹配 ${c.km.unmatched}km 不计入）：`
    + ` I型高速/快速路 ${c.km.I}km（${pct(c.km.I)}%）· II型城市主干/次干/支路 ${c.km.II}km（${pct(c.km.II)}%）`
    + ` · III型其他 ${c.km.III}km（${pct(c.km.III)}%）${iiiTip ? '：' + iiiTip : '（县乡乡村/街巷/内部道路等）'}`;
  return `<span class="qc rk" title="${esc(tip)}">${parts.join(' · ')}</span>`;
}

// 返程实测（tools/plan_return_legs.js）：双向 = 去程 + 返程，不再用 2×单程 近似。
// 2026-10-16 用户：「正向 1244.9km，但你直接 ×2 是不对的，你也要把路线规划出来？去程和返程？」
const RETLEG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'route_return_legs.json'), 'utf8')); }
  catch { return null; }
})();
const RTT = (RETLEG && RETLEG.totals) || null;
const retKm = RTT ? RTT.streetRevKm : null;
const retRatio = RTT && RTT.streetFwdKm ? RTT.streetRevKm / RTT.streetFwdKm : null;
const scenRetKm = RTT ? RTT.scenRevKm : null;
const retStreetKm = new Map(((RETLEG && RETLEG.streets) || []).map((s) => [s.street, s.revKm]));
// 返程**导航**（2026-10-16 用户：返程路线不要单独列表，「你加在排班导航这里，给个规划的导航路径就行了」）
// ⇒ 不单列「返程路线集」表，改为在 C 节排班导航处给出**规划的返程导航路径**：
//    逐路线一条（该腿锚点链倒序后高德实算）+ 逐街道一条（整街返程链）。源 out/routes_return.json。
const RETROUTES = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'routes_return.json'), 'utf8')); }
  catch { return null; }
})();
const RET_STREETS = (RETROUTES && RETROUTES.streets) || [];
const retLegNavOf = new Map(RET_STREETS.map((s) => [s.street, (s.routes || []).map((L) => ({ uri: L.uri, distKm: L.distKm, durMin: L.durMin }))]));
const retStreetNavOf = new Map(RET_STREETS.map((s) => [s.street, { uri: s.uri, distKm: s.distKm, durMin: s.durMin }]));
const retNavN = RET_STREETS.reduce((a, s) => a + (s.routes || []).filter((L) => L.uri).length, 0)
  + [...retStreetNavOf.values()].filter((x) => x.uri).length;

let cRows = '';
let sumKm = 0, sumDur = 0, routeN = 0;
for (const street of streetOrder) {
  const list = byStreet[street];
  const rt = streetRouteOf[street];
  const a = alloc.byStreet[street] || {};
  const spatial = +((a.allocKm || 0) - (a.scenKm || 0)).toFixed(1);
  const rsn = retStreetNavOf.get(street);
  const retLegNav = retLegNavOf.get(street) || [];
  const km = list.reduce((s, r) => s + r.distKm, 0);
  const dur = list.reduce((s, r) => s + r.durMin, 0);
  sumKm += km; sumDur += dur; routeN += list.length;
  cRows += `<tr class="street">
    <td colspan="6">
      <div class="st-row">
        <span class="st-name">${esc(street)}</span>
        <span class="lk">${list.length} 条路线 · 去程 ${f1(km)}km · 返程 ${retStreetKm.has(street) && retStreetKm.get(street) != null ? f1(retStreetKm.get(street)) + 'km' : '—'} · 空间层双向 ${spatial.toFixed(1)}km · 场景加跑 ${(a.scenKm || 0).toFixed(1)}km · 合计 ${(a.allocKm || 0).toFixed(1)}km · ${(a.hours || 0).toFixed(1)}h</span>
        ${rt && rt.uri ? `<span class="st-nav"><a href="${esc(rt.uri)}" target="_blank" title="打开该街道「去程」路线集导航">路线集导航 ${f1(rt.distKm)}km · ${rt.durMin}min ↗</a></span>` : ''}
        ${rsn && rsn.uri ? `<span class="st-nav st-rev"><a href="${esc(rsn.uri)}" target="_blank" title="打开该街道「返程」路线集导航（锚点链倒序后高德实算，非去程倒念）">返程导航 ${f1(rsn.distKm)}km · ${rsn.durMin}min ↗</a></span>` : ''}
      </div>
      <div class="st-quota"><span class="st-ql">本街道沿线累计</span>${streetChips(list)}</div>
    </td>
  </tr>`;
  list.forEach((r, i) => {
    // 2026-10-27 用户要求：途经点全量列出，不截断、不用省略号
    const tg = (r.targets || []).map((t) => `${t.name}（${t.label}）`).join(' → ');
    cRows += `<tr>
      <td class="rn">路线${i + 1}</td>
      <td class="tg2">${esc(tg)}</td>
      <td class="num">${r.distKm}<span class="u">km</span></td>
      <td class="num">≈${r.durMin}<span class="u">min</span></td>
      <td class="chips">${chipsOf(r.counts)}${markChip(r.street, i)}${classKmChip(r.street, i, r.distKm)}</td>
      <td class="slot">${r.uri ? `<a href="${esc(r.uri)}" target="_blank">去程 ${r.distKm}km · ${r.durMin}min ↗</a>` : '<span class="none">—</span>'}${retLegNav[i] && retLegNav[i].uri ? `<a class="rt-rev" href="${esc(retLegNav[i].uri)}" target="_blank" title="该腿返程导航（锚点链倒序后高德实算）">返程 ${f1(retLegNav[i].distKm)}km · ${retLegNav[i].durMin}min ↗</a>` : ''}<span class="slot-t">${esc(slotText(r))}</span></td>
    </tr>`;
  });
}
const spatialTotal = alloc.spatialKm, scenTotal = alloc.scenKm;
// 同源断言：去程 + 返程 必须等于排班空间层
if (retKm != null) {
  if (Math.abs(f1(sumKm) + retKm - spatialTotal) > 1.0) {
    throw new Error(`路线里程与排班空间层不一致：去程 ${f1(sumKm)} + 返程 ${retKm} = ${f1(sumKm + retKm)} vs alloc.spatialKm=${spatialTotal}`);
  }
} else if (Math.abs(f1(sumKm) * 2 - spatialTotal) > 1.0) {
  throw new Error(`路线里程与排班空间层不一致：Σ单程 ${f1(sumKm)}×2=${f1(sumKm * 2)} vs alloc.spatialKm=${spatialTotal}（且缺 out/route_return_legs.json）`);
}
if (Math.abs(spatialTotal + scenTotal - alloc.totalKm) > 1.0) {
  throw new Error(`排班总账不自洽：${spatialTotal}+${scenTotal} ≠ ${alloc.totalKm}`);
}

// ---------- 里程口径章节（原 .kmref 拼盘注释的替代）----------
// 2026-10-16 用户要求：不要在报告里堆拼盘注释，改成正式章节讲清「排班路线为什么是 2,489.8km」，
// 流程图放在原注释的位置。正文由 lib_mileage_section.js 生成（与场景页同一实现）。
const mileSection = mileageSection({
  alloc, kdGate: oddSel.kdGate, std: STD,
  routeN, streets: streetOrder.length, sumKm,
  retKm, retRatio, scenKm: RTT ? RTT.scenFwdKm : null, scenRetKm,
});

// ---------- 天气章节（2026-11-04 用户要求：排班前看 4 日预报）----------
// 高德天气 API v3 extensions=all，惠城区 adcode=441302；同步单次请求，失败降级为提示行。
const { KEYS } = require('./amap_key');
function fetchWeatherSync() {
  for (const key of KEYS.slice(0, 3)) {
    try {
      const url = `https://restapi.amap.com/v3/weather/weatherInfo?key=${key}&city=441302&extensions=all`;
      const stdout = require('child_process').execSync(
        `curl -s --ssl-no-revoke --max-time 15 "${url}"`, { encoding: 'utf8', timeout: 20000 });
      const j = JSON.parse(stdout);
      if (j.status === '1' && j.forecasts && j.forecasts.length) return j;
    } catch (e) { /* 换下一个 key */ }
  }
  return null;
}
const WX = fetchWeatherSync();
const WX_DAY = { '1': '周一', '2': '周二', '3': '周三', '4': '周四', '5': '周五', '6': '周六', '7': '周日' };
const WX_CAST = { '晴': '#f59e0b', '多云': '#94a3b8', '阴': '#64748b', '小雨': '#0ea5e9', '中雨': '#2563eb', '大雨': '#1d4ed8', '雷阵雨': '#7c3aed', '阵雨': '#0284c7' };
const wxSection = WX ? (() => {
  const f = WX.forecasts[0];
  const casts = f.casts || [];
  const hasRain = casts.some((c) => c.dayweather.includes('雨') || c.nightweather.includes('雨'));
  return `<section id="sec-wx">
  <h2>W · 惠城区 4 日天气预报<span class="n">高德天气 API · adcode 441302 · 发布 ${esc(f.reporttime)} · 排班建议参考</span></h2>
  <table>
    <tr><th style="width:90px">日期</th><th style="width:70px">星期</th><th>白天</th><th>夜间</th><th style="width:80px">日温</th><th style="width:80px">夜温</th><th style="width:90px">风向</th><th style="width:60px">风力</th></tr>
    ${casts.map((c) => `<tr><td>${esc(c.date)}</td><td>${WX_DAY[c.week] || ''}</td>
      <td><b style="color:${WX_CAST[c.dayweather] || '#334155'}">${esc(c.dayweather)}</b></td>
      <td><b style="color:${WX_CAST[c.nightweather] || '#334155'}">${esc(c.nightweather)}</b></td>
      <td class="num">${esc(c.daytemp)}°</td><td class="num">${esc(c.nighttemp)}°</td>
      <td>${esc(c.daywind)}风</td><td class="num">${esc(c.daypower)}</td></tr>`).join('')}
  </table>
  <div class="explain">排班提示：未来 4 日${hasRain ? '存在降水预报——雨湿路面是感知/制动测试的宝贵工况，优先安排雨敏路线并确认设备防护；无雨日优先学校/施工等对天气敏感的锚点。' : '无明显降水，适合安排全部锚点类型；雨湿工况可另行等待或洒水车定点补测。'} 天气为预报值，出车前以当日实况为准。</div>
</section>`;
})() : `<section id="sec-wx"><h2>W · 惠城区 4 日天气预报</h2><div class="explain">天气接口本次生成时拉取失败，排班请以出车当日实况为准。</div></section>`;

// ---------- D 节已删除（2026-10-16 用户要求）----------
// 原「D · 全元素真实情况校准」与 B 节配额表逐列重复，用户要求只留 B。
// 随后用户进一步要求「只留区内真实、不要留源」→ D 节唯一残留的溯源小字（数据源 / 源条数 / 剔除合并）
// 也已从 B 表撤掉；`element_calibration.json` 现在只用于 B 表的区内数交叉校验（不符标 ⚠）。


// ---------- E 区：宽凳路网主图（内嵌 route_kuandeng_routes.html）----------
// 用 iframe srcdoc 内嵌：该页自带上百条 CSS 规则与 600KB 底图，直接拼进本文档会
// 与本节样式互相污染；srcdoc 让它在独立文档上下文里原样渲染，且交付页仍是单文件。
const kdPath = path.join(OUT, 'route_kuandeng_routes.html');
const kdHtml = fs.existsSync(kdPath) ? fs.readFileSync(kdPath, 'utf8') : null;
// srcdoc 是属性值：只需转义 & 与 "（浏览器会反解回原文，脚本照常执行）
// 嵌入模式样式：iframe 内 .wrap 单列（地图独占整宽，明细表移到地图下方）、
// #mapbox/aside 高度改固定值（82vh 在 iframe 内语义失真会算成缩水值）
const embedCss = `<style id="__embed__">
.wrap{grid-template-columns:1fr !important}
#mapbox{height:600px !important}
aside{height:auto !important;max-height:520px !important}
</style>
<script id="__fitb__">
// 嵌入模式初始视角：不做全画布 fitView（5200x3918 画布把路线缩成一小角），
// 按锚点（页内全局 MK，含 x/y 的 SVG 用户坐标）包围盒 fitBounds，红线开局即占满视野。
// 注意 RT 是 path d 字符串数组（RT.join('') 拼 d），不能当坐标数组遍历。
(function(){
 function fitRoutes(){
  var b=document.getElementById('mapbox');if(!b||typeof MK==='undefined'||!MK.length)return;
  var x1=1e9,y1=1e9,x2=-1e9,y2=-1e9;
  MK.forEach(function(m){if(m.x<x1)x1=m.x;if(m.x>x2)x2=m.x;if(m.y<y1)y1=m.y;if(m.y>y2)y2=m.y;});
  if(x2<=x1||y2<=y1)return;
  var s2=Math.min(b.clientWidth/(x2-x1),b.clientHeight/(y2-y1))*0.94;
  s=s2;tx=(b.clientWidth-(x1+x2)*s)/2;ty=(b.clientHeight-(y1+y2)*s)/2;
  if(typeof apply==='function')apply();
 }
 // 页内 fitInit 挂在 load + setTimeout(120/600)；这里 load 后再等 700ms，确保落在它们全部之后
 addEventListener('load',function(){setTimeout(fitRoutes,700);setTimeout(fitRoutes,1500);});
})();
</script>`;
const kdAttr = kdHtml
  ? kdHtml.replace(/<\/head>/, embedCss + '</head>').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  : '';
const kdKB = kdHtml ? (kdHtml.length / 1024).toFixed(0) : 0;
const eSection = kdHtml ? `
<section id="sec-e">
  <h2>E · 排班路线 × 宽凳路网（主图）<span class="n">${routeN} 条排班路线 · ${kdKB}KB 原页内嵌 · 可缩放 / 拖动 / 逐层开关</span></h2>
  <p class="explain"><b>灰</b> = 宽凳路网（全部 ROAD_LINK）· <b>红</b> = ${routeN} 条排班路线（几何只用宽凳 link，顶点 0 偏差）· <b>灰虚线</b> = 宽凳缺口 · <b>绿/橙/深红点</b> = 起点/途经/终点，锚点号 = 全局路线号（1–${routeN}）。滚轮缩放、拖动、图例逐层开关。<b>为何没有单独的「返程」图层</b>：走廊按锚点段<b>无向最短路</b>生成，正反同一条 path；里程差（单行/匝道/禁左）只体现在里程与路线集，不另设图层。</p>
  <iframe class="kd-frame" srcdoc="${kdAttr}" loading="lazy" title="排班路线 × 宽凳路网"></iframe>
  <p class="mut" style="font-size:11px;margin-top:8px">原页 <code>out/route_kuandeng_routes.html</code>（由 <code>tools/render_routes_v3.py</code> 生成，几何源 <code>out/routes_kd.json</code>）· 缺口清单 <code>out/kd_survey_needs.md</code> · 本页为其内嵌副本，数据同源。</p>
</section>` : '';

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>ODD 覆盖勾选表 · 配额置信度 · 路线排班</title>
<style>
  :root{--acc:#0e7490;--mut:#64748b;--line:#e2e8f0;--bg:#f8fafc;--ok:#15803d;--warn:#b45309;--bad:#b91c1c;}
  *{box-sizing:border-box}
  body{margin:0;padding:22px 26px 60px;background:var(--bg);color:#0f172a;
    font:13px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;}
  h1{font-size:19px;margin:0 0 4px}
  .sub{color:var(--mut);font-size:12px;margin-bottom:14px}
  .banner{display:grid;grid-template-columns:repeat(7,1fr);gap:10px;margin:12px 0 10px}
  .bn{background:#fff;border:1px solid var(--line);border-radius:8px;padding:9px 12px}
  /* 家底口径（全区路网）与排班口径视觉分离：灰底 + 虚线边 = 「参照量，不排班」 */
  .bn.ref{background:#f8fafc;border-style:dashed;border-color:#cbd5e1}
  .bn.ref .v{color:#475569}
  .bn .v{font-size:19px;font-weight:700;color:var(--acc)}
  .bn .l{font-size:11px;color:var(--mut);margin-top:1px}
  .kmref{font-size:12px;color:var(--mut);line-height:1.75;background:#f8fafc;border-left:3px solid #cbd5e1;padding:8px 12px;border-radius:0 6px 6px 0;margin:0 0 20px}
  section{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:16px}
  h2{font-size:15px;margin:0 0 10px;padding-bottom:7px;border-bottom:1px solid var(--line)}
  h2 .n{font-weight:400;font-size:11px;color:var(--mut);margin-left:8px}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{background:#f1f5f9;text-align:left;padding:6px 7px;border:1px solid var(--line);font-weight:600;white-space:nowrap}
  td{padding:5px 7px;border:1px solid var(--line);vertical-align:top}
  td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  td.mut{color:var(--mut)}
  tr.layer td{background:#eef2f7;font-weight:700;font-size:12px}
  td.dim{width:118px;color:var(--mut)}
  td.src-col{text-align:center;font-weight:600;white-space:nowrap}
  .so-kd{color:#1557db;background:#e8effc;border-radius:4px}
  .so-am{color:#c2571c;background:#fdf0e7;border-radius:4px}
  .so-osm{color:#6c7688;background:#f0f1f3;border-radius:4px}
  .so-na{color:var(--mut)}
  .explain .so-kd,.explain .so-am,.explain .so-osm{padding:1px 6px}
  td.item{min-width:190px}
  td.tags{white-space:normal}
  .tg{display:inline-block;font-size:11px;padding:1px 7px;border-radius:10px;margin:1px 3px 1px 0;white-space:nowrap}
  .t-src{background:#e0f2fe;color:#075985}
  .t-cov{background:#dcfce7;color:#166534}
  .t-gap{background:#fee2e2;color:#991b1b}
  .t-fix{background:#ede9fe;color:#5b21b6}
  .t-conf{background:#f1f5f9;color:#475569}
  .v-ok{color:var(--ok)} .v-pt{color:var(--warn)} .v-am,.v-os,.v-nf,.v-ns{color:var(--bad);font-weight:700} .v-oo{color:var(--mut)}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
  .whyc{white-space:nowrap}
  .prov{font-size:10px;color:var(--mut);font-weight:400;line-height:1.35}
  .why{display:inline-block;font-size:11px;padding:1px 7px;border-radius:10px;margin-right:5px}
  .w-ex{background:#dcfce7;color:#166534}
  .w-st{background:#e0f2fe;color:#075985}
  .w-hw{background:#e2e8f0;color:#475569}
  .why-n{color:var(--mut);font-size:11px}
  .r-hi{color:var(--ok);font-weight:700} .r-mid{color:#166534} .r-low{color:var(--warn)} .r-bad{color:var(--bad)}
  .e-hi{color:var(--ok)} .e-mid{color:var(--warn)} .e-low{color:var(--bad)}
  tr.skip td{color:#94a3b8}
  tr.thsub td{color:var(--mut);font-size:10.5px;padding:2px 8px;text-align:left;background:var(--bg)}
  .formula{background:#f8fafc;border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0 10px;font-size:12px}
  .formula .v{color:var(--acc);font-weight:700}
  .fml{font-size:15px;font-weight:600;letter-spacing:.4px;margin:6px 0 2px}
  .subst{color:#475569;font-size:12px}
  .subst .v{color:var(--acc);font-weight:700}
  .blk-h{font-weight:600;font-size:12px;color:#334155;margin:9px 0 5px}
  table.ptab td{font-size:11.5px;line-height:1.5}
  td.pn{font-weight:700;color:var(--acc);text-align:center;font-size:13px;font-family:ui-monospace,Consolas,monospace}
  td.pv{text-align:center;font-weight:700;font-variant-numeric:tabular-nums;font-size:13px}
  .mut{color:var(--mut)}
  .badges{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
  .bdg{background:#f0f4f8;border:1px solid var(--line);border-radius:14px;padding:3px 11px;font-size:11px}
  .bdg b{color:var(--acc)}
  .explain{font-size:12px;color:#334155;background:#f8fafc;border-left:3px solid var(--acc);padding:8px 11px;margin:8px 0}
  .chartwrap{position:relative;height:300px;margin-top:8px}
  tr.street td{background:#f1f5f9}
  .st-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .st-name{font-weight:700;font-size:13px}
  .lk{color:var(--mut);font-size:11px}
  .st-nav a{color:var(--acc);font-weight:700;text-decoration:none;font-size:12px;white-space:nowrap}
  .st-nav a:hover{text-decoration:underline}
  .st-nav.st-rev a{color:var(--warn)}
  .st-quota{margin-top:4px}
  .st-ql{font-size:11px;color:var(--mut);margin-right:6px}
  .qc{display:inline-block;font-size:11px;padding:1px 7px;border-radius:10px;margin:1px 3px 1px 0;white-space:nowrap}
  .c-hi{background:#dcfce7;color:#166534;font-weight:700}
  .c-mid{background:#e0f2fe;color:#075985}
  .c-low{background:#fef3c7;color:#92400e}
  .c-bad{background:#f1f5f9;color:#64748b}
  .qc.mk{background:#f3e8ff;color:#6b21a8;border:1px dashed #c084fc}
  .qc.rk{background:#f0fdfa;color:#115e59;border:1px solid #99f6e4}
  .qc.mk.c-hi{background:#dcfce7;color:#166534;border-color:#86efac;font-weight:700}
  .qc.mk.c-mid{background:#e0f2fe;color:#075985;border-color:#7dd3fc}
  .qc.mk.c-low{background:#fef3c7;color:#92400e;border-color:#fcd34d}
  .mkblk{margin:14px 0 4px;border:1px solid #e2e8f0;border-left:3px solid #7c3aed;border-radius:6px;padding:10px 12px;background:#fdfdff}
  .mkblk .blk-h{margin-top:0}
  td.chips{max-width:430px}
  td.slot{white-space:nowrap}
  td.slot a{color:var(--acc);font-weight:700;text-decoration:none;font-size:12px}
  td.slot a:hover{text-decoration:underline}
  td.slot a.rt-rev{color:var(--warn);font-weight:600;margin-left:8px}
  .slot-t{display:block;color:var(--mut);font-size:11px;margin-top:2px}
  .u{color:var(--mut);font-size:10px;margin-left:1px}
  .none{color:#cbd5e1}
  tr.sumrow td{background:#ecfeff;font-weight:700}
  .ok-t{color:var(--ok)}
  .kd-frame{width:100%;height:88vh;min-height:620px;border:1px solid var(--line);border-radius:8px;background:#fff;display:block}
<footer{color:var(--mut);font-size:11px;line-height:1.8;margin-top:22px;border-top:1px solid var(--line);padding-top:12px}
  #secnav{position:sticky;top:0;z-index:50;display:flex;flex-wrap:wrap;gap:6px;background:rgba(248,250,252,.94);backdrop-filter:blur(4px);padding:8px 0;border-bottom:1px solid var(--line);margin-bottom:14px}
  #secnav a{font-size:12px;color:var(--mut);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:4px 12px;background:#fff;transition:all .15s}
  #secnav a:hover{border-color:var(--acc);color:var(--acc)}
  #secnav a.on{background:var(--acc);border-color:var(--acc);color:#fff}
  section{scroll-margin-top:64px}
  .okfold{font-size:12px;color:var(--mut);background:#fff;border:1px dashed var(--line);border-radius:6px;padding:5px 12px;cursor:pointer}
  .okfold:hover{color:var(--acc);border-color:var(--acc)}
  #atable.folded tr.okrow{display:none}
  #atable.folded tr.layer-okonly{display:none}
  .okfold-bar{font-size:12px;color:var(--mut)}
  details.minifold{border:1px dashed var(--line);border-radius:8px;padding:0 12px;margin:8px 0;background:#fff}
  details.minifold>summary{cursor:pointer;font-size:12px;font-weight:600;color:var(--mut);padding:8px 0;list-style:none}
  details.minifold>summary::before{content:'▸ ';}
  details.minifold[open]>summary::before{content:'▾ ';}
  details.minifold>summary:hover{color:var(--acc)}
  details.minifold>table,details.minifold>*:not(summary){margin:4px 0 10px}
  @media (max-width:1100px){ .two{grid-template-columns:1fr} .banner{grid-template-columns:repeat(4,1fr)} }
</style></head><body>

<h1>ODD 覆盖勾选表 · 配额置信度 · 路线排班</h1>
<div class="sub">依据飞书《F21 智驾需求文档》4.3.2 设计运行域；数字全部来自 out/*.json，与详细版报告同口径同源</div>

<nav id="secnav">
  <a href="#sec-mile">里程口径</a><a href="#sec-a">A · 勾选表</a><a href="#sec-b">B · 配额</a><a href="#sec-c">C · 排班</a><a href="#sec-wx">W · 天气</a><a href="#sec-e">E · 主图</a>
</nav>

<div class="banner">
  <div class="bn ref"><div class="v">${alloc.netBidirKm ? alloc.netBidirKm.toLocaleString('en-US') : '—'}<span style="font-size:12px">km</span></div><div class="l">全区路网（双向）· 家底</div></div>
  <div class="bn"><div class="v">${tally.ok || 0}/${ck.rows.length}</div><div class="l">勾选表已覆盖子项</div></div>
  <div class="bn"><div class="v">${routeN}</div><div class="l">路线条数（${streetOrder.length} 街道）</div></div>
  <div class="bn"><div class="v">${f1(spatialTotal)}<span style="font-size:12px">km</span></div><div class="l">空间层（双向）</div></div>
  <div class="bn"><div class="v">${f1(scenTotal)}<span style="font-size:12px">km</span></div><div class="l">场景加跑</div></div>
  <div class="bn"><div class="v">${alloc.totalKm}<span style="font-size:12px">km</span></div><div class="l">排班总账 ✓</div></div>
  <div class="bn"><div class="v">${alloc.dayCount}<span style="font-size:12px">天</span></div><div class="l">${f1(alloc.hours)}h · 每天 6h</div></div>
</div>

${mileSection}

<section id="sec-a">
  <h2>A · 4.3.2 逐项勾选<span class="n">24 维度收敛展开 ${ck.rows.length} 行 · 已覆盖 ${tally.ok || 0} · 部分覆盖 ${tally.partial || 0} · 无数据源 ${(+tally['amap-miss'] || 0) + (+tally['no-source'] || 0) + (+tally['not-fetched'] || 0)} · 数据不足 ${tally['osm-sparse'] || 0} · 非地图项 ${tally['out-of-scope'] || 0}</span></h2>
  <div class="okfold-bar" style="margin-bottom:8px"><button class="okfold" type="button">${okN2} 行「✓ 已覆盖」· 点击收起只看问题项</button></div>
  <table id="atable">
    <tr><th style="width:118px">维度</th><th style="width:230px">子项</th><th style="width:130px">判定</th><th style="width:56px">来源</th><th>依据（标签）</th></tr>
    ${aRows}
  </table>
  <div class="explain">判定：<b style="color:var(--ok)">✓ 已覆盖</b>＝数据齐备且进排班统计 ·
    <b style="color:var(--warn)">△ 部分覆盖</b>＝主体数据有，子类型不全或标注率不满 ·
    <b style="color:var(--bad)">✗ 无数据源</b>＝两源均无，需实车或人工 ·
    <b style="color:var(--bad)">✗ 数据不足</b>＝有源但量不够统计 ·
    <b style="color:var(--mut)">○ 非地图项</b>＝动态/感知/自车，静态地图不适用。
    来源：<span class="so-kd">宽凳</span>＝高精真值 · <span class="so-am">高德</span>＝POI/路况 · <span class="so-osm">OSM</span>＝众包（唯一可得源时使用） · <span class="so-na">—</span>＝非地图项或无数据源。
    标签：<span class="tg t-src">数据资产</span> <span class="tg t-cov">覆盖·配额</span> <span class="tg t-gap">缺口</span> <span class="tg t-fix">可补/已补动作</span>。</div>

</section>

<section id="sec-b">
  <h2>B · 配额：区内存量 · 最少需抽多少 · 为什么<span class="n">区内真实存量 + 选择逻辑 + 样本量↔置信度曲线 + 实测验证</span></h2>

  <table>
    <tr><th style="width:96px">元素类</th><th>区内存量</th><th>最少需抽 n</th><th>为什么这么选</th><th>实际覆盖（去重）</th><th>覆盖率</th><th>估计误差</th><th>只跑配额时</th></tr>
    <tr class="thsub"><td></td><td></td><td></td><td></td><td></td><td>途经÷存量</td><td>见下「误差两列」</td><td>见下「误差两列」</td></tr>
    ${bRows}
  </table>
  <div class="explain">
    <b>列口径</b>：「区内存量」由 <code>tools/audit_all_elements.js</code> 独立重算并逐类交叉校验（${CAL_N} 类，${calWarn} 处不符）；
    「最少需抽 n」= ±5%@95%CI 的统计门槛（存量&lt;50 穷举全选）；「实际覆盖」= 导航折线 ${q.passRadiusM}m 半径实测去重；「覆盖率」= 途经÷存量。<br>
    <b>误差两列</b>：都是<b>用抽到的样本估计「全区到底有多少个」时的误差</b>（95%CI）—— <b>估计误差</b>列 = 把本排班途经到的当样本，<b>只跑配额时</b>列 = 假设只去 n 个、样本更少。两列相减就是多跑里程买到的精度。覆盖率为 0 无样本可估，记「—」。<br>
    <b>覆盖远超 n 是正常的</b>：n 是门槛不是目标，高密度元素顺路即扫；配额的真正作用是揪出<b>顺路扫不够的低密度类</b>（学校 / 人行横道）。
    灰色行属高速域，只计不配额。隧道 / 桥梁已剔除非道路载体（铁路隧道 / 涵洞等）并按 50m 归并同址多段。
  </div>


  ${KM ? `<div class="mkblk">
    <div class="blk-h">B2 · 交通标线（车道线）线型覆盖 —— 这一类为什么不用「x/139 配额」</div>
    <div class="explain" style="margin:0 0 9px">
      标线是<b>连续线性要素</b>（区内 ${KM.district.dividers.toLocaleString('en-US')} 条 = 面画 ${KM.district.painted.toLocaleString('en-US')} + 物理边界 ${KM.district.physical.toLocaleString('en-US')}），
      每条路线都途经上万条，配额制不适用 —— ODD 要问的是<b>能不能见到这 18 种线型</b>。下表逐线型给出：区内条数、${KM.routes.length} 条路线的<b>几何实测</b>触达数（判定半径 ${KM.passRadiusM}m）。
    </div>
    <table>
      <tr><th style="width:150px">线型</th><th style="width:230px">类别</th><th>区内条数</th><th>触达路线数</th><th>路线覆盖率</th></tr>
      ${markRows}
      <tr class="sumrow">
        <td><b>合计</b></td>
        <td class="mut">${markDistCodes.length} 种线型码在区内有数据（规格书定义 1–17，实测另有码 18）</td>
        <td class="num"><b>${KM.district.dividers.toLocaleString('en-US')}</b></td>
        <td class="num mut">—</td>
        <td class="num"><b>${((markUnionCodes.length / (markDistCodes.length || 1)) * 100).toFixed(0)}%</b><span class="mut"> 线型覆盖（${markUnionCodes.length}/${markDistCodes.length} 种被触达）</span></td>
      </tr>
    </table>
  </div>` : ''}
  <div class="two">
    <div>
      <div class="formula">
        <b>样本量公式（比例估计）</b>
        <div class="fml">n = z² · p(1−p) ÷ e²</div>
        <div class="subst">代入：1.96² × 0.9 × 0.1 ÷ 0.05² = 3.8416 × 0.09 ÷ 0.0025 = <span class="v">${nRaw.toFixed(1)}</span> → 向上取整 <span class="v">139</span></div>
      </div>

      <details class="minifold"><summary>公式里每个参数是什么意思 · 为什么取这个值</summary>
      <table class="ptab">
        <tr><th style="width:40px">参数</th><th style="width:64px">取值</th><th style="width:196px">含义</th><th>为什么取这个值</th></tr>
        <tr>
          <td class="pn">n</td><td class="pv">139</td>
          <td><b>需要抽取的最低样本量</b><br><span class="mut">本例 = 至少要途经的元素个数（门槛，非目标值）</span></td>
          <td class="mut">公式的<b>输出</b>，不是置信度。算得 ${nRaw.toFixed(1)} → 向上取整 139（宁可多跑 1 个）。<b>置信度不是 n 决定的，是 z 决定的</b>。多抽只增不减置信度，但边际收益按 1/√n 收缩。</td>
        </tr>
        <tr>
          <td class="pn">z</td><td class="pv">1.96</td>
          <td><b>置信水平对应的标准正态分位数</b><br><span class="mut">双侧，决定"有多可信"</span></td>
          <td class="mut"><b>置信度由它决定</b>：1.645 → 90%，1.96 → 95%，2.576 → 99%。取 1.96 = 要求 95% 置信。</td>
        </tr>
        <tr>
          <td class="pn">p</td><td class="pv">0.9</td>
          <td><b>预期（设计）元素覆盖率</b><br><span class="mut">比例估计里的成功概率</span></td>
          <td class="mut">取 0.9 是<b>保守设计假设</b>（假设只覆盖 90%）。p 越靠近 0.5 方差越大、所需样本越多；p=0.5 时 139 个只能给 ±${errOf(139, 0.5).toFixed(1)}%。</td>
        </tr>
        <tr>
          <td class="pn">e</td><td class="pv">0.05</td>
          <td><b>可接受的估计误差</b><br><span class="mut">±5 个百分点</span></td>
          <td class="mut">业务精度要求。n 与 e² 成反比：<b>误差减半 → 样本 ×4</b>（要 ±2.5% 需 553 个）。</td>
        </tr>
      </table></details>

      <div class="explain"><b>曲线</b>：蓝线左轴 = ±5pp 误差下的置信水平，橙线右轴 = 95% 置信下的误差，同一公式两种看法。
        <b>139 ⇒ 95% 置信</b>（80% 只需 n≈${n80}，99% 需 ${n99}）；再往上样本 +44% 只换 ${(e139 - e200).toFixed(1)}pp，139 即精度 / 成本拐点。</div>
    </div>

    <div>
      <div class="chartwrap"><canvas id="confChart"></canvas></div>
      <div class="blk-h" style="margin-top:10px">样本量 ↔ 置信水平 ↔ 估计误差 对照</div>
      <table>
        <tr><th>样本量 n</th><th>置信水平（误差 ±5pp 时）</th><th>估计误差（95% 置信时）</th><th>说明</th></tr>
        ${MARK.map((m) => `<tr${m.n === 139 ? ' class="sumrow"' : ''}>
          <td class="num"><b>${m.n}</b></td>
          <td class="num">${m.c.toFixed(1)}%</td>
          <td class="num">±${m.e}%</td>
          <td class="mut">${m.n === 35 ? '基础档' : m.n === n80 ? '80% 置信落在这里' : m.n === 139 ? '<b>标准档 · 采用</b>' : m.n === 200 ? '边际收益明显下降' : '高精度专项'}</td>
        </tr>`).join('')}
      </table>
    </div>
  </div>



  <div class="badges">
    <span class="bdg">样本 ×4（35→139）误差 <b>±${e35.toFixed(1)}% → ±${e139.toFixed(1)}%</b></span>
    <span class="bdg">样本 +44%（139→200）误差仅再收窄 <b>${(e139 - e200).toFixed(1)}pp</b></span>
    <span class="bdg">边际收益按 <b>√n 递减</b></span>
    <span class="bdg">p=0.5 最坏情形 → 139 给 <b>±${errOf(139, 0.5).toFixed(1)}%</b></span>
    <span class="bdg">稀缺类（存量&lt;50）<b>穷举 100%</b></span>
    <span class="bdg">N 有限时另有校正 <b>√((N−n)/(N−1))</b></span>
  </div>
</section>

<section id="sec-c">
  <h2>C · 路线 × ODD 配额 × 排班 × 建议时段<span class="n">${routeN} 条路线 · 每街道 1–${Math.max(...streetOrder.map((s) => byStreet[s].length))} 条 · 一趟同时扫工况路与元素锚点</span></h2>
  <table>
    <tr><th style="width:56px">路线</th><th style="width:380px">途经点（工况路 / 元素锚点）</th><th style="width:62px">里程</th><th style="width:62px">时长</th><th>ODD 配额标签（本线途经 / 标准档配额）</th><th style="width:150px">导航 · 建议时段</th></tr>
    ${cRows}
    <tr class="sumrow">
      <td colspan="2"><b>合计 · ${streetOrder.length} 街道 / ${routeN} 条路线</b></td>
      <td class="num"><b>去程 ${f1(sumKm)}km</b></td>
      <td class="num"><b>${f1(sumDur / 60)}h</b></td>
      <td colspan="2"><b>空间层 ${f1(spatialTotal)}km（去程 ${f1(sumKm)} + 返程 ${retKm != null ? f1(retKm) : '—'}，${retKm != null ? '均为高德实测算路' : '缺返程实测'}） + 场景加跑 ${f1(scenTotal)}km = 排班总账 <span class="ok-t">${alloc.totalKm}km ✓</span></b></td>
    </tr>
  </table>
  <div class="explain">v1（81 条，每街道扫两趟）→ v2 合成目标序列 + 消交叉重排 → <b>${routeN} 条（平均 ${(routeN / streetOrder.length).toFixed(1)} 条/街道，单条 ${(sumKm / routeN).toFixed(1)}km ≈ ${Math.round(sumDur / routeN)}min）</b>。
    锚点须落在工况路走廊 ≤1.2km（放宽上限 5km），隧道/桥梁/铁路道口只取具名条目。<br>
    标签：<b>x/配额</b> = 导航折线实测途经 / 标准档 n（绿 ≥100% · 蓝 ≥50% · 黄 ≥15%）；<b>青色</b> = 道路类型里程（I型高速/快速 · II型城市主干次干支 · III型其他）；<b>建议时段</b>按途经元素定（隧道明暗 / 学校市场早高峰 / 县乡日间等）。</div>
</section>

${wxSection}

${eSection}

<footer>
  数据源：out/odd_checklist.json（勾选判定）· out/odd_quota_roads.json（配额与路线途经量）· out/routes.json（Amap v3 驾车路径实测·去程）· out/routes_return.json（Amap v3 逐腿倒序重算·返程导航路径）· out/report_alloc.json（排班快照，与详细版报告同源）。<br>
  补查记录：out/odd_missing_probe.json（缺口元素双源探测）· out/typecode_family_probe.json（高德 typecode 族穷举）· out/kuandeng_probe.json（宽凳高精地图惠城区真值探测）· out/routes_v1_backup.json（v1 路线备份）。<br>
  生成链：build_odd_checklist.js → build_odd_quota.js → plan_routes_v2.js → tools/plan_return_legs.js（返程）→ build_odd_coverage_html.js（可重放）；宽凳探测 probe_kuandeng.js（只读内网 UNC）。
</footer>

<script>${chartJs}</script>
<script>
(function(){
  var NS = ${JSON.stringify(NS)};
  var confLine = ${JSON.stringify(confLine)};
  var errLine = ${JSON.stringify(errLine)};
  var markPts = ${JSON.stringify(markPts)};
  new Chart(document.getElementById('confChart'), {
    data: {
      labels: NS,
      datasets: [
        { type:'line', label:'置信水平 %（允许误差 ±5pp）', data: confLine, yAxisID:'y',
          borderColor:'#0e7490', backgroundColor:'rgba(14,116,144,.08)', borderWidth:2, pointRadius:0, fill:true, tension:0.25 },
        { type:'line', label:'估计误差 ±pp（95% 置信）', data: errLine, yAxisID:'y1',
          borderColor:'#ea580c', backgroundColor:'transparent', borderWidth:2, borderDash:[5,4], pointRadius:0, tension:0.25 },
        { type:'line', label:'档位点 35/59/139/200/553', data: markPts, yAxisID:'y',
          borderColor:'#0e7490', backgroundColor:'#0e7490', showLine:false, pointRadius:5, pointStyle:'rectRot' }
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:false, interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{ position:'top', labels:{ boxWidth:12, font:{size:11} } },
        tooltip:{ callbacks:{ title:function(it){ return '样本量 n = ' + it[0].label; },
          label:function(c){ var v=c.parsed.y; if(v===null||v===undefined) return null; return c.dataset.label + '：' + v.toFixed(1); } } }
      },
      scales:{
        x:{ title:{ display:true, text:'样本量 n（个）', font:{size:11} }, ticks:{ font:{size:10}, maxTicksLimit:14 } },
        y:{ position:'left', min:0, max:100, title:{ display:true, text:'置信水平 %', font:{size:11} },
            ticks:{ font:{size:10}, callback:function(v){ return v + '%'; } } },
        y1:{ position:'right', min:0, max:20, title:{ display:true, text:'估计误差 ±pp', font:{size:11} },
            ticks:{ font:{size:10}, callback:function(v){ return '±' + v + 'pp'; } }, grid:{ drawOnChartArea:false } }
      }
    }
  });
})();
// ---- A 节 ok 行折叠：默认全部展开，按钮仅作手动收纳 ----
(function(){
  const t=document.getElementById('atable');if(!t)return;
  const btn=document.querySelector('.okfold');
  btn.addEventListener('click',()=>{t.classList.toggle('folded');
    btn.textContent=btn.textContent.replace(/收起|展开/,t.classList.contains('folded')?'展开':'收起');});
})();
// ---- 吸顶导航：滚动高亮当前节 ----
(function(){
  const links=[...document.querySelectorAll('#secnav a')];
  const secs=links.map(a=>document.querySelector(a.getAttribute('href'))).filter(Boolean);
  function upd(){
    let cur=secs[0];
    for(const s of secs){ if(s.getBoundingClientRect().top<=90) cur=s; }
    links.forEach(a=>a.classList.toggle('on',a.getAttribute('href')==='#'+cur.id));
  }
  addEventListener('scroll',upd,{passive:true});upd();
})();
</script>
</body></html>`;

fs.writeFileSync(path.join(OUT, 'odd_coverage.html'), html);
console.log(`out/odd_coverage.html ${(html.length / 1024).toFixed(0)}KB`);
console.log(`勾选表 ${ck.rows.length} 行 · ok ${tally.ok || 0} / partial ${tally.partial || 0} / no-source ${tally['no-source'] || 0} / out-of-scope ${tally['out-of-scope'] || 0}`);
console.log(`路线 ${routeN} 条 · 去程 ${f1(sumKm)} + 返程 ${retKm != null ? f1(retKm) : '—'} = 空间层 ${spatialTotal} + 场景 ${scenTotal} = ${alloc.totalKm}km ✓`);
console.log(`置信度：n=35→${confOf(35).toFixed(1)}% · n=59→${confOf(59).toFixed(1)}% · n=139→${confOf(139).toFixed(1)}% · n=200→${confOf(200).toFixed(1)}% · n=553→${confOf(553).toFixed(1)}%`);
console.log(`误差：n=35→±${e35.toFixed(1)}% · n=139→±${e139.toFixed(1)}% · n=200→±${e200.toFixed(1)}% · n=553→±${e553.toFixed(1)}% · 80%需 n=${n80} · 99%需 n=${n99}`);
