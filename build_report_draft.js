// DRAFT PREVIEW（评审草稿）: 与 build_report.js 同源。所有版式改动已并入本文件，
// out/report_draft.html 由本脚本直出 —— 本文件即版式唯一事实来源，不要再手改 HTML。
// 批准后把改动并入 build_report.js 并删除本文件。
//
// Render street statistics + congestion into a self-contained HTML dashboard.
// Chart.js is INLINED from ./chartjs.min.js — the browser that views this report
// cannot reach cdn.jsdelivr.net, so a CDN <script src> renders blank charts.
//
// Report structure (8 blocks, reader-facing; tuning knobs stay in code):
//   1 道路等级构成  2 分时段拥堵态势(状态+车速·如实标注采样覆盖)  3 按测试场景推荐(图+地点+路线)
//   4 综合测试优先级(饼图)  5 里程需求(ODD覆盖推导·8+4 维度)  6 排班表(路线并入·当日出口判据)
//   7 各区域静态元素分布(24类·低样本灰柱)  8 风险与局限(口径边界)
//
// Data inputs (all in ./out, produced by the sibling build_*.js scripts):
//   street_stats.json · road_classes.json · routes.json · odd_selection.json
//   congestion.json (实时采样聚合) · odd_dims.json (ODD 维度域) · osm_calibration.json (里程校核样本)
const fs = require('fs');
const path = require('path');

const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'out/street_stats.json'), 'utf8'));
const chartJs = fs.readFileSync(path.join(__dirname, 'chartjs.min.js'), 'utf8');

// Congestion is optional: built by build_congestion.js from Amap samples.
let congestion = null;
try {
  congestion = JSON.parse(fs.readFileSync(path.join(__dirname, 'out/congestion.json'), 'utf8'));
} catch (_) { /* not generated yet */ }

// 街道级（全区 18 街道）拥堵聚合，由 build_congestion_streets.js 产出。
// 与上面的 congestion.json 是**两个口径**：congestion.json 是「同一路网的分时段曲线」，
// 本文件是「同一时刻（10:00）的 18 街道空间快照」。两者足迹不同，报告里分开表述。
let congStreets = null;
try {
  congStreets = JSON.parse(fs.readFileSync(path.join(__dirname, 'out/congestion_streets.json'), 'utf8'));
} catch (_) { /* not generated yet */ }

// 实测里程加权均速（按小时档）：用来给建模假设做标定，而不是拍脑袋。
// 数据来自 fetch_congestion.js —— 每条路段用 polyline 裁到采样矩形内算长度，再 Σkm/Σ(km/v)。
const BAND_KMH = (() => {
  const m = {};
  if (congestion && congestion.speedCalib) for (const b of congestion.speedCalib.byBand) m[b.band] = b.kmh;
  return m;
})();
const bandKmh = (hours) => {
  const v = hours.map((h) => BAND_KMH[h]).filter((x) => x != null);
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : null;
};
const CONG_COV = (congestion && congestion.coverage) || null;
const WD_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const dateCn = (ds) => {
  const [y, m, d] = ds.split('-').map(Number);
  return `${ds.slice(5)}（${WD_CN[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
};
const covDatesCn = CONG_COV ? CONG_COV.dates.map(dateCn).join(' / ') : '—';

// 分时段补全层（build_congestion_ref.js）：7 个实测小时档 + 17 个参考推断小时档。
// 推断 = 公开「惠州逐小时拥堵延时指数」的相对形状 × 本地实测标定的幂律 speed=a·index^(−b)。
// 每小时带 mode，报告里从不把 inferred 当 measured 用。
const CONG_REF = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'out/congestion_ref.json'), 'utf8')); }
  catch (_) { return null; }
})();
const refBand = (k) => (CONG_REF ? CONG_REF.bands.find((b) => b.key === k) : null) || null;
const refBandKmh = (k) => { const b = refBand(k); return b ? b.kmh : null; };

// Routes are optional: built by fetch_routes.js via the Amap driving API.
// Each street gets a multi-leg skeleton (①②③ independent 起点→终点 segments
// through its highest-value named elements); each scenario gets one route
// through its own element anchors in its top street.
let routesData = null;
try {
  routesData = JSON.parse(fs.readFileSync(path.join(__dirname, 'out/routes.json'), 'utf8'));
} catch (_) { /* not generated yet */ }
const routeByStreet = new Map(
  ((routesData && routesData.routes) || []).filter((r) => r.status === 'ok').map((r) => [r.street, r])
);
// 全部路线条目（含 status != ok）—— 用于识别「本镇明确无可用路线」而不是「缺数据」
const routeRawByStreet = new Map(
  ((routesData && routesData.routes) || []).map((r) => [r.street, r])
);
const scenarioRouteBy = new Map(
  ((routesData && routesData.scenarioRoutes) || []).map((r) => [r.scenario, r])
);

// Element types with ADAS weights + layer grouping (used by the composite score
// and the per-area element-share chart). fuel/charging/parking/tolls/restAreas
// counts come from Amap POI sweeps (OSM POI coverage is too sparse here).
const ALL_TYPES = [
  { key: 'tunnels',       label: '隧道',      color: '#dc2626', w: 8, layer: 1 },
  { key: 'bridges',       label: '桥梁',      color: '#0d9488', w: 2, layer: 1 },
  { key: 'roundabout',    label: '环岛',      color: '#f97316', w: 4, layer: 1 },
  { key: 'railCrossings', label: '铁路道口',  color: '#7c2d12', w: 5, layer: 1 },
  { key: 'livingStreets', label: '生活性街道', color: '#a16207', w: 1, layer: 1 },
  { key: 'turning',       label: '掉头圈',    color: '#b91c1c', w: 2, layer: 1 },
  { key: 'pedestrian',    label: '步行街',    color: '#78716c', w: 1, layer: 1 },
  { key: 'accessRoads',   label: '半封闭道路', color: '#57534e', w: 1, layer: 1 },
  { key: 'signals',       label: '红绿灯',    color: '#2563eb', w: 3, layer: 2 },
  { key: 'crossings',     label: '斑马线',    color: '#64748b', w: 1, layer: 2 },
  { key: 'busStops',      label: '公交站',    color: '#059669', w: 1, layer: 2 },
  { key: 'busDepots',     label: '公交场站',  color: '#047857', w: 2, layer: 2 },
  { key: 'parking',       label: '停车场',    color: '#475569', w: 1, layer: 2 },
  { key: 'fuel',          label: '加油站',    color: '#b45309', w: 1, layer: 2 },
  { key: 'charging',      label: '充电站',    color: '#0ea5e9', w: 1, layer: 2 },
  { key: 'tolls',         label: '收费站',    color: '#65a30d', w: 2, layer: 2, noComposite: true },
  { key: 'restAreas',     label: '服务区',    color: '#94a3b8', w: 1, layer: 2, noComposite: true },
  { key: 'barriers',      label: '道闸/石墩', color: '#9333ea', w: 1, layer: 2 },
  { key: 'construction',  label: '施工路段',  color: '#111827', w: 2, layer: 3 },
  { key: 'schools',       label: '学校',      color: '#f59e0b', w: 2, layer: 4 },
  { key: 'hospitals',     label: '医院',      color: '#ec4899', w: 2, layer: 4 },
  { key: 'markets',       label: '市场',      color: '#8b5cf6', w: 1, layer: 4 },
  { key: 'fireStations',  label: '消防站',    color: '#ef4444', w: 1, layer: 4 },
  { key: 'policeStations', label: '派出所',   color: '#1d4ed8', w: 1, layer: 4 },
];
// Composite test priority excludes motorway-related kinds (tolls/restAreas):
// they feed the 高速/收费站 scenario instead, so the city-ODD composite score
// is not diluted by highway-only elements.
const COMPOSITE_TYPES = ALL_TYPES.filter((t) => !t.noComposite);

// 元素来源分类（与 build_stats.js 的 ELEMENT_SETS 一一对应）：
// 设施类走高德 POI 扫街文件，路网/拓扑类只有 OSM 有。公交站是已知反例 ——
// OSM 计数是高德的 335%，故留在 OSM。§7 与 §8 的来源说明都由此常量驱动。
// 消防站/派出所本轮由 OSM 切到高德：OSM 侧即便补上 node 形式也仅 5 / 14 个，
// 高德同口径区内 33 / 82 个（全区 80 / 182），OSM 在此两类不可用。
const AMAP_ELEMENT_LABELS = ['停车场', '加油站', '充电站', '收费站', '服务区', '学校', '医院', '市场', '消防站', '派出所'];

const f1 = (n) => Math.round(n * 10) / 10;
const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);

const totals = { roadKm: f1(sum('roadKm')) };
ALL_TYPES.forEach((t) => (totals[t.key] = sum(t.key)));

// Weighted test-priority score: w reflects ADAS scenario value — tunnels and
// signals stress perception/planning most; rail crossings and roundabouts are
// rare high-value intersection scenarios.
const scored = rows
  .map((r) => ({
    ...r,
    score: f1(COMPOSITE_TYPES.reduce((s, t) => s + ((r[t.key] || 0) / r.roadKm) * t.w, 0)),
  }))
  .sort((a, b) => b.score - a.score);
const scoreSumAll = scored.reduce((s, r) => s + r.score, 0);

// ---------- block 1: road-class composition ----------
const roadClasses = JSON.parse(fs.readFileSync(path.join(__dirname, 'out/road_classes.json'), 'utf8'));
const CLASS_KEYS = [
  { key: 'express',     label: '快速路',       color: '#dc2626' },
  { key: 'arterial',    label: '主干路',       color: '#ea580c' },
  { key: 'subArterial', label: '次干路',       color: '#f59e0b' },
  { key: 'collector',   label: '支路',         color: '#65a30d' },
  { key: 'local',       label: '街巷',         color: '#2563eb' },
  { key: 'rural',       label: '县乡/乡村道路', color: '#7c3aed' },
  { key: 'service',     label: '内部道路',     color: '#94a3b8' },
];
const classStack = CLASS_KEYS.map((c) => ({ ...c, vals: rows.map((r) => r.classKm[c.key] || 0) }));
const motorwayVals = rows.map((r) => r.motorwayKm || 0);

// ---------- report version / changelog (rendered in the footer) ----------
const REPORT_VERSION = 'v0.20-draft';
const REPORT_CHANGELOG = [
  'v0.20-draft · 2026-09-30 · <b>全区路网家底（5490.1km）提到显眼位置并全链同源</b>（起因：用户「这个总里程之前不是五千多公里吗？整个惠城区的？」→「对，这个总里程你得加上来」）：① 首页卡片改为 <b>全区路网·双向行驶（上限）5490.1km</b> 打头、<b>全区路网·中心线 3520.1km</b> 次之，两者用「灰底＋虚线边」与排班卡片做视觉分离；② 卡片下方注解重写为「整个惠城区有多少路（路网家底，不排班）」，用 <b>①⊂②、④⊂③⊂②</b> 讲清四个口径的关系，并点明「本排班只跑 3880km 不是漏了 1610.1km」；③ 家底与穷举参考提升为脚本前部常量并写入 <code>out/report_alloc.json</code>（新增 <code>netCenterKm/netBidirKm/netUnnamedKm/netBidirUnnamedKm/motorwayKm/exhaustKm/exhaustRouteKm/candRoads/savePct</code>），供三份衍生页同源引用；④ <code>odd_coverage.html</code>（7 卡）与 <code>scenario_tests.html</code>（6 卡）指标条各加一枚「全区路网（双向）· 家底」虚线卡并附「量级对照」说明行；<code>report_brief.html</code> 两档对比区加第 4 张「参照：全区路网（双向）」，流程条最左端补「全区路网 ⊃」起点；⑤ <code>audit_data.js</code> 新增 <b>I. 全区路网家底</b> 段（家底须等于 street_stats 逐街道求和、穷举须等于 2×候选单程+场景加跑、4 个交付页都须写出该值）。audit_data.js 60/60',
  'v0.19-draft · 2026-09-30 · <b>「全量穷举」参考值改为动态口径</b>（起因：用户追问「总里程之前不是五千多公里吗？整个惠城区的？」）：原来把整值烘焙成 <code>EXHAUSTIVE_REF_KM = 5194</code>（= 2×2461.2 候选全跑 + <b>v1 的</b> 271.6 场景加跑），场景 v2 重规划后加跑 269.6 → 663.6 而此常量不动 → 「比穷举省 X%」停在旧值。现拆成 <code>EXHAUST_ROUTE_KM = 2461.2</code>（前版 <code>fetch_routes_full.log</code> 195 条实测，候选池未变故有效）× 2 <b>+ 动态 ODD_SCENARIO_KM</b> → 穷举参考 5194 → <b>5586km</b>、省比 25% → <b>31%</b>；<code>build_brief.js</code> 同口径同步。另核对三个易混里程并确认首页卡片口径标注无误：全区非高速路网中心线 <b>3520.1km</b> / 双向行驶（上限）<b>5490.1km</b>（=「整个惠城区」的量）/ 全量穷举 <b>5586km</b> / 本排班 <b>3880km</b>。audit_data.js 52/52',
  'v0.18-draft · 2026-09-30 · <b>场景路线按 v2 口径重规划 + 里程口径全链统一</b>：① 场景路线不再沿用 v1「点到点」旧点位 —— 新的 <code>plan_scenario_routes_v2.js</code> 按「场景 top1 街道 + 核心要素点串联」重规划并实测导航（NN+2opt），Σ场景单程 67.4 → 187.2km；② 场景加跑 269.6 → 663.6km，排班总账 3486 → <b>3880km</b>（128.8 → 143h、22 → 24 天）；③ 修 <code>select_odd.js</code> 不识别 v2「loop」腿的缺陷（旧实现重跑会把空间层清零），标准档 3022 → 3880km 与本表同口径，并在本脚本加一致性护栏（不等即报错）；④ <code>scenario_tests.html</code> 顶部改用 <code>report_alloc.json</code>（原来误用 v1 选路快照，显示 3022km）；⑤ <code>build_brief.js</code> 天数不再写死 19 天，改读 <code>report_alloc.json</code> 并加同源护栏；⑥ 清理过期副本（v0.17 报告冻结页、09-24 旧报告），<code>audit_data.js</code> 新增「交付页里程同源」段防复发。audit_data.js 52/52',
  'v0.17-draft · 2026-09-29 · <b>按用户逐图评审删繁</b>（图表一张未删）：① 删 §2「街道/镇 × 路况」空间覆盖表（18 行整表）——同节 4 条要点与 <code>out/congestion_streets.json</code> 已承担其汇总；② §2 四条「读表 / 口径 / 加权公式 / 残差指引」长注解（671 字）压成 1 行读表键；③ <b>§5④ 图注把三档里程口径写死</b>——三档均 = 空间层 + 场景加跑，与 §5③ 表「合计」同源，并点明表中「空间层」列不含场景加跑（原来只写两个档位的总预算数字，与表中空间层并列像互相矛盾）；④ 删 §5⑤「边界 · 执行 · 验收」整块（3 张表 3277 字符）：ODD 内已由 ①–④ 覆盖、执行两阶段与验收判据已由第 6 节总出口判据承担，仅留 1 行 ODD 外范围说明。散文 6114 → 5829 字、可见正文 32083 → 30511（−4.9%）· audit_data.js 47/47。完整历史见 <code>out/report_changelog.md</code>',
  'v0.16-draft · 2026-09-29 · <b>全篇文字精简</b>（图表、表格、单元格数字、结论一律未动，10 张图全保留）：§5 把 4 处重复的「口径 / 读法」注解（含一条写死的「红绿灯 186/139」）合并为 1 处，删 2 条独立读法块；§8 三条局限逐条压缩（最长单块 489 → 380 字）；§2 / §3 注解删同义句与冗余举例。散文合计 7366 → 6114 字（−17.0%）、最长单块 489 → 380（−22%）、§5 散文 2925 → 2147（−27%）、可见正文 33187 → 32083（−3.3%，因可见正文近半是排班表等表格数据，未动）。完整变更历史见 <code>out/report_changelog.md</code>',
];

// 里程校核样本（OSM 中心线 vs 高德同路实测）——第 8 节引用
let OSM_CAL = null;
try { OSM_CAL = JSON.parse(fs.readFileSync(path.join(__dirname, 'out/osm_calibration.json'), 'utf8')); } catch (_) { /* not generated yet */ }

// 元素置信度定级（build_confidence.js）：24 类逐类给出源 + 级别 + 判定依据。
// 级别由实测指标算出（高德 typecode 核对 / 坐标落路网校验 / 与独立源计数比），可复核。
let CONF = null;
try { CONF = JSON.parse(fs.readFileSync(path.join(__dirname, 'out/element_confidence.json'), 'utf8')); } catch (_) { /* not generated yet */ }

// Source completeness cross-check (build_source_crosscheck.js): same district,
// same category — OSM count vs Amap POI count. Turns "OSM 完备度未知" into a number.
let SOURCE_CK = null;
try { SOURCE_CK = JSON.parse(fs.readFileSync(path.join(__dirname, 'out/source_crosscheck.json'), 'utf8')); } catch (_) { /* not generated yet */ }
// 交叉比在报告里被引用多次（第 7 节折叠 + 第 8 节 A3）—— 一律由表驱动，
// 避免表格重算后正文里的「公交站 333%」这类写死数字与表不一致。
const CK_ROW = (kw) => (SOURCE_CK ? SOURCE_CK.rows.find((r) => r.label.includes(kw)) : null);
const CK_BUS = CK_ROW('公交') ? CK_ROW('公交').ratio : null;            // 反例：OSM > 高德
const CK_FACILITY = SOURCE_CK ? SOURCE_CK.rows.filter((r) => !r.label.includes('公交')) : [];
const CK_MISS_LO = CK_FACILITY.length ? Math.min(...CK_FACILITY.map((r) => 100 - r.ratio)) : null;
const CK_MISS_HI = CK_FACILITY.length ? Math.max(...CK_FACILITY.map((r) => 100 - r.ratio)) : null;

// ---------- block 3: scenario recommendation ----------
// Definitions live in ./scenarios.js so fetch_routes.js (scenario route
// planning) and this report agree on which street tops each scenario.
const { SCENARIOS, scenarioRank: scenarioRankOf } = require('./scenarios');
const scenarioRank = (sc) => scenarioRankOf(sc, rows);

// Congestion scenario: tiles are city quarters, not 街道 — map each tile to the
// streets it covers, then aggregate segment worst-status per street.
const TILE_STREETS = {
  '老城-桥东桥西': ['桥东街道', '桥西街道'],
  '江北': ['江北街道'],
  '河南岸': ['河南岸街道'],
  '惠环-仲恺': ['惠环街道'], // 仲恺辖区在惠城区外，忽略
  '龙丰-江南': ['龙丰街道', '江南街道'],
  '水口': ['水口街道'],
};
let congestionScenario = null;
let congAttr = null;   // 归属方式统计（用于脚注：多少路段走逐点采样、多少回退老表）
if (congestion && congestion.samples > 0 && (congestion.roadMatrix || []).length) {
  const byStreet = {};
  const addTo = (st, s, km) => {
    const x = (byStreet[st] = byStreet[st] || { score: 0, jam: 0, slow: 0, km: 0, segs: [] });
    const w = (s.worst || 0) >= 3 ? 2 : (s.worst || 0) >= 2 ? 1 : 0;
    if (w) {
      x.score += w;
      if ((s.worst || 0) >= 3) x.jam++; else x.slow++;
    }
    x.km += km;
    x.segs.push(s);
  };
  let viaStreetKm = 0, viaTileTable = 0;
  for (const s of congestion.roadMatrix) {
    // 优先用**逐点采样**得到的街道归属（roadMatrix[].streets = 该路在各街道内的里程）。
    // 跨街道长干道按里程拆分，不再靠人工的「片区瓦片 → 街道」对应表 —— 那张表一个瓦片
    // 覆盖多个街道，等于把整条路的拥堵状态同时算给好几个街道。
    const parts = Object.entries(s.streets || {}).filter(([, km]) => km > 0);
    if (parts.length) {
      viaStreetKm++;
      const tot = parts.reduce((a, [, km]) => a + km, 0);
      for (const [st, km] of parts) {
        if (km < 0.2 || km / tot < 0.15) continue; // 掐掉仅擦边经过的碎段
        addTo(st, s, km);
      }
    } else {
      // 老格式（6 瓦片核心区）路段没有 streetKm → 回退到人工对应表
      viaTileTable++;
      for (const st of TILE_STREETS[s.tile] || []) addTo(st, s, 0);
    }
  }
  congAttr = { viaStreetKm, viaTileTable, total: congestion.roadMatrix.length };
  congestionScenario = Object.entries(byStreet)
    .map(([name, x]) => ({
      name, score: x.score, jam: x.jam, slow: x.slow, km: +x.km.toFixed(1),
      topSegs: [...x.segs].sort((a, b) => (b.worst || 0) - (a.worst || 0)).slice(0, 3),
    }))
    .sort((a, b) => b.score - a.score || b.km - a.km);
}

// ---------- block 6: schedule + routes ----------
// ODD-derived budget (replaces the old hand-waved 3000 km). Coverage model =
// 选择性工况覆盖（select_odd.js 选路，fetch_routes.js 只取选中道路）:
//   穷举层  稀缺高价值元素（医院/环岛/铁路道口…关联候选路 <50 个）100% 命中
//   统计层  常见元素抽样到 n ≥ 139（±5% @95%CI，p=0.9）
//   等级层  7 个道路等级保底里程（≥15% 或 ≥15km）
//   空间层  承载以上工况的选中道路集，Amap 实测导航里程 **去程 + 返程**（2026-10-16 起）
//           —— 去程 = 逐腿 base→终点锚点 实测；返程 = 同腿锚点链倒序再算一遍（同 strategy=3）。
//           不再用 2×单程 近似：路网单向约束使返程 ≠ 去程（实测水口 164.6/164.5、马安 76.2/95.2）
//   场景层  场景路线 双向 × 3 时段 = 6 遍，其中双向 1 遍已含在空间层 → 加跑 4ΣS
//   参考    全量穷举 = 全部候选命名道路途经（前版实测，对照用）；车道上限 roadKmBidir
// 车辆参数不变: 无人小车 cap 45 km/h / cruise ~30 km/h, 窗口 07:00-23:00.
const TEST = {
  VEHICLES: 1,          // 车队规模
  HOURS_PER_DAY: 6,     // 每天有效测试时长（扣充电/休整）
  REPR_BASE_KM: 50,     // 无路线集街道的保底（正常不触发：18 街道都有路线集）
  SCEN_DIRS: 2, SCEN_TIMES: 3, // 场景路线：双向 × 3 时段
  CLASS_SPEED: { express: 40, arterial: 35, subArterial: 30, collector: 25, local: 25, rural: 30, service: 20 },
  PEAK_FACTOR: 0.8,     // 晚高峰均速折减
};
const BANDS = [
  { key: 'amPeak',  label: '早高峰',  range: '07:00–09:00', share: 0.25, note: `学校接送场景驱动；参考推断均速 ${refBandKmh('amPeak')}km/h（锚定 7 个实测小时档）` },
  { key: 'daytime', label: '日间平峰', range: '09:00–17:00', share: 0.25, note: `常规覆盖时段；参考推断均速 ${refBandKmh('daytime')}km/h（同上）` },
  { key: 'pmPeak',  label: '晚高峰',  range: '17:00–19:00', share: 0.30, note: `实测 18:00 档里程加权 ${bandKmh(['18:00']) ?? '—'}km/h（17:00 为参考推断）；模型折减后更保守` },
  { key: 'evening', label: '晚间',    range: '19:00–23:00', share: 0.20, note: `实测 19:00–21:00 里程加权 ${bandKmh(['19:00', '20:00', '21:00']) ?? '—'}km/h；22:00–23:00 为参考推断` },
];
// 拥堵走时段维度（BANDS）、高速剔除（无人小车不上主线）→ 场景保底池 = 其余 6 个场景
const ALLOC_SCENARIOS = SCENARIOS.filter((s) => s.key !== 'tollway');

// ODD 分层里程（去程全部实测自 out/routes.json；**返程另实测**，见 tools/plan_return_legs.js）
const routeKmAll = [...routeByStreet.values()].reduce((s, r) => s + r.distKm, 0);
const scenOkRoutes = ALLOC_SCENARIOS.map((s) => scenarioRouteBy.get(s.key)).filter((r) => r && r.status === 'ok');
const scenRouteKmAll = scenOkRoutes.reduce((s, r) => s + r.distKm, 0);
// ---- 返程实测（2026-10-16 用户：「正向 1244.9km，但你直接 ×2 是不对的，你也要把路线规划出来？去程和返程？」）----
// 双向不再用 2×单程 近似，改为**去程 + 返程**（返程 = 锚点链倒序后重新算路，逐腿、同 strategy=3）。
const RETURN_LEGS = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'route_return_legs.json'), 'utf8')); }
  catch { return null; }
})();
const RET = (RETURN_LEGS && RETURN_LEGS.totals) || null;
const routeReturnKmAll = RET ? RET.streetRevKm : null;          // Σ 街道路线返程
const scenReturnKmAll = RET ? RET.scenRevKm : null;             // Σ 场景路线返程
const revRatio = RET && RET.streetFwdKm ? RET.streetRevKm / RET.streetFwdKm : null;   // 返程/去程（实测 ≈1.018）
// 逐街道返程（用于 §5 逐镇街表的「空间层（双向）」列）
const retByStreet = new Map(((RETURN_LEGS && RETURN_LEGS.streets) || []).map((s) => [s.street, s]));
const bidirOf = (street, fwd) => {
  const q = retByStreet.get(street);
  return q && q.revKm != null ? +(fwd + q.revKm).toFixed(1) : +(2 * fwd).toFixed(1);
};
if (!RET) console.log('  ⚠ 未找到 out/route_return_legs.json → 双向退回 2×单程 估算（请跑 tools/plan_return_legs.js）');
const ODD_SPATIAL_KM = +(routeReturnKmAll != null
  ? routeKmAll + routeReturnKmAll                            // 空间层 = 去程 + 返程
  : 2 * routeKmAll).toFixed(1);
// 场景加跑 = 双向 × 3 时段 − 已含在空间层的 1 遍双向 = 2 × (去程 + 返程)
const ODD_SCENARIO_KM = +(scenReturnKmAll != null
  ? 2 * (scenRouteKmAll + scenReturnKmAll)
  : scenRouteKmAll * (TEST.SCEN_DIRS * TEST.SCEN_TIMES - 2)).toFixed(1);
const TOTAL_KM = Math.round(ODD_SPATIAL_KM + ODD_SCENARIO_KM);  // 全 ODD = 排班总预算
TEST.TOTAL_KM = TOTAL_KM;

// 全量穷举参考 = 候选命名道路（1108 条）全部途经的双向里程 + 当前场景加跑。
// · 路线部分：前版 fetch_routes_full.log 195 条实测**去程** Σ2461.2km（候选池未变故仍有效）。
//   2026-10-16 起不再 ×2 —— 改用**本次实测的 (去程+返程)/去程 比例**外推，与空间层同一口径。
// · 场景部分：⚠️ 必须动态取 ODD_SCENARIO_KM。曾把整值烘焙成 5194（= 4922.4 + v1 的 271.6），
//   场景 v2 重规划后 269.6→663.6 而这里不动，导致「省 X%」口径停在旧值。
// （提前到此处：report_alloc.json 快照在 §6 之前写出，必须同源引用，不能在后面再定义一遍）
const EXHAUST_ROUTE_KM = 2461.2;
const EXHAUSTIVE_REF_KM = Math.round(
  (revRatio != null ? EXHAUST_ROUTE_KM * (1 + revRatio) : 2 * EXHAUST_ROUTE_KM) + ODD_SCENARIO_KM);
// 全区路网家底（street_stats 逐街道汇总）—— 与「测试里程」是两码事，勿混：
// 家底 = 全区有多少路可跑；排班 = 从中挑多少跑。前者不排班，所以无需任何成本核算。
const NET_CENTER_KM = f1(sum('roadKm'));          // 非高速中心线：每条道路只计一次
const NET_BIDIR_KM = f1(sum('roadKmBidir'));      // 双向行驶（上限口径，含无名路段）
const NET_UNNAMED_KM = f1(sum('unnamedKm'));      // 其中无名路段（中心线）
const NET_BIDIR_UNNAMED_KM = f1(sum('unnamedKmBidir'));
const NET_MOTORWAY_KM = f1(sum('motorwayKm'));    // 高速（仅参考，不进任何密度分母）

// 每街道分配 = 路线集双向（正向跑路线 + 反向重跑）+ 场景加跑份额（按场景排名）
const baseKm = (r) => {
  const rt = routeByStreet.get(r.name);
  if (rt) return 2 * rt.distKm;
  // 有路线条目但 status != ok（2026-10-16 宽凳闸门后可能出现：本镇候选工况道路/锚点
  // 全落在宽凳未采区 → no-anchors）→ 本镇不排班，计 0。若仍回退「代表里程」，
  // 街道表合计会多出一块对不上总账（曾多 50km），且掩盖「宽凳没采到」这个事实。
  const raw = routeRawByStreet.get(r.name);
  if (raw && raw.status && raw.status !== 'ok') return 0;
  return Math.min(r.roadKmBidir || r.roadKm, TEST.REPR_BASE_KM);
};
const baseSum = rows.reduce((s, r) => s + baseKm(r), 0);
const scenPoolKm = ODD_SCENARIO_KM;   // 场景层加跑里程，按场景 Top 街道分配
const scenKmByStreet = {};
const scenDetailByStreet = {}; // street -> [{label, rank}] for the daily focus line
for (const sc of ALLOC_SCENARIOS) {
  const top = scenarioRank(sc);
  const per = top.length ? scenPoolKm / ALLOC_SCENARIOS.length / top.length : 0;
  top.forEach((t, i) => {
    scenKmByStreet[t.r.name] = (scenKmByStreet[t.r.name] || 0) + per;
    (scenDetailByStreet[t.r.name] = scenDetailByStreet[t.r.name] || []).push({
      label: sc.label, rank: i + 1,
      why: sc.metrics.map((m) => m.fmt(t.r)).join(' · '),
    });
  });
}
const scenUsed = Object.values(scenKmByStreet).reduce((a, b) => a + b, 0);
const compPoolKm = Math.max(0, TOTAL_KM - baseSum - scenUsed); // ≈ 0：全 ODD 需求即总预算
const allocKm = {};
for (const r of scored) {
  allocKm[r.name] = baseKm(r) + (scenKmByStreet[r.name] || 0) + compPoolKm * (r.score / scoreSumAll);
}

const streetSpeed = (r) => Object.entries(r.classKm)
  .reduce((s, [k, km]) => s + km * TEST.CLASS_SPEED[k], 0) / r.roadKm;
const streetHours = (r) => BANDS.reduce((h, b) => {
  const v = streetSpeed(r) * (b.key === 'pmPeak' ? TEST.PEAK_FACTOR : 1);
  return h + (allocKm[r.name] * b.share) / v;
}, 0);

const allocRows = rows.map((r) => ({ r, a: allocKm[r.name], h: streetHours(r) }))
  .sort((x, y) => y.a - x.a);
const totHours = allocRows.reduce((s, x) => s + x.h, 0);

// Day-by-day schedule: pack streets in allocation order into TEST.HOURS_PER_DAY
// windows. A street longer than one day splits at the boundary; a leftover
// fragment under 1h rolls to a fresh day, because a day reading "0.3h of 桥东
// 街道" tells the tester nothing.
const dayPlan = [];
let curDay = { items: [], hours: 0 };
for (const x of allocRows) {
  let remain = x.h;
  while (remain > 0.05) {
    const free = TEST.HOURS_PER_DAY - curDay.hours;
    if (free <= 0.05 || (remain > free && free < Math.min(1, remain))) {
      dayPlan.push(curDay); curDay = { items: [], hours: 0 }; continue;
    }
    const take = Math.min(free, remain);
    curDay.items.push({ x, hours: take, km: (take / x.h) * x.a });
    curDay.hours += take;
    remain -= take;
  }
}
if (curDay.items.length) dayPlan.push(curDay);
// 收尾日余量并回前一日：原排班会留下一个 0.6h 的收尾日（街道不可拆分产生的日尾
// 余量），单独出车不经济。并回后末次出车 = 6h 满排 + 顺路收尾，不再多一天。
let tailMerged = false;
if (dayPlan.length > 1 && dayPlan[dayPlan.length - 1].hours < 2) {
  const tail = dayPlan.pop();
  const prev = dayPlan[dayPlan.length - 1];
  for (const it of tail.items) {
    const same = prev.items.find((p) => p.x === it.x);
    if (same) { same.hours += it.hours; same.km += it.km; } else prev.items.push(it);
  }
  prev.hours += tail.hours;
  tailMerged = true;
}
const tailExtraH = tailMerged ? +(dayPlan[dayPlan.length - 1].hours - TEST.HOURS_PER_DAY).toFixed(1) : 0;
// 装载率：排班实际装进去的有效小时 ÷（天数 × 每天有效窗口）
const packPct = Math.round((totHours / (dayPlan.length * TEST.HOURS_PER_DAY)) * 1000) / 10;
const lastDayKm = f1(dayPlan[dayPlan.length - 1].items.reduce((s, i) => s + i.km, 0));
const lastDayHours = f1(dayPlan[dayPlan.length - 1].hours);
// 排班分配快照（纯输出，供 odd_coverage / scenario_tests / report_brief 等衍生页同源引用；
// 不影响报告正文）。除排班里程外，也带上「全区路网家底」与「全量穷举参考」——
// 这两类是**对照口径**，必须和测试里程从同一个文件读，否则又会出现「两个总里程」。
fs.writeFileSync(path.join(__dirname, 'out/report_alloc.json'), JSON.stringify({
  generated: new Date().toISOString().slice(0, 19).replace('T', ' '),
  totalKm: TOTAL_KM, spatialKm: ODD_SPATIAL_KM, scenKm: ODD_SCENARIO_KM,
  dayCount: dayPlan.length, hours: +totHours.toFixed(1),
  // —— 对照口径（非排班）——
  netCenterKm: NET_CENTER_KM,          // 全区非高速路网 · 中心线
  netBidirKm: NET_BIDIR_KM,            // 全区非高速路网 · 双向行驶（上限）
  netUnnamedKm: NET_UNNAMED_KM,        // 其中无名路段（中心线）
  netBidirUnnamedKm: NET_BIDIR_UNNAMED_KM,
  motorwayKm: NET_MOTORWAY_KM,         // 高速（仅参考）
  exhaustKm: EXHAUSTIVE_REF_KM,        // 全量穷举（候选命名道路全跑双向 + 场景加跑）
  exhaustRouteKm: EXHAUST_ROUTE_KM,    // 其中候选路线单程实测
  candRoads: (() => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'out/odd_selection.json'), 'utf8')).candRoads; }
    catch (_) { return null; }
  })(),
  savePct: Math.round((1 - TOTAL_KM / EXHAUSTIVE_REF_KM) * 100),
  byStreet: Object.fromEntries(rows.map((r) => [r.name, {
    allocKm: +allocKm[r.name].toFixed(1),
    scenKm: +(scenKmByStreet[r.name] || 0).toFixed(1),
    hours: +streetHours(r).toFixed(2),
  }])),
}, null, 2));

// Day-schedule focus: top score contributors + scenario roles + congestion duty.
// Ranking stays weighted (which element pulls the street's score up), but the
// display is concrete density (个/km, plain count when sparse) — readers are
// test/management staff, weighted-point arithmetic stays out of the report.
const scoreBits = (r) => COMPOSITE_TYPES
  .map((t) => ({ t, c: ((r[t.key] || 0) / r.roadKm) * t.w }))
  .filter((x) => x.c >= 0.05).sort((a, b) => b.c - a.c).slice(0, 3)
  .map((x) => {
    const d = (r[x.t.key] || 0) / r.roadKm;
    return d >= 0.1 ? `${x.t.label} ${f1(d)}个/km` : `${x.t.label} 共${r[x.t.key] || 0}个`;
  }).join(' · ') || '无显著贡献元素';
const congByStreet = {};
if (congestionScenario) for (const c of congestionScenario) congByStreet[c.name] = c;
const dayFocus = (r) => {
  const rank = scored.findIndex((x) => x.name === r.name) + 1;
  const bits = [`综合第${rank}`];
  const sb = scoreBits(r);
  if (sb !== '无显著贡献元素') bits.push(sb);
  const sd = scenDetailByStreet[r.name];
  if (sd && sd.length) bits.push(`场景保底：${sd.map((x) => `${x.label}第${x.rank}（${x.why}）`).join('、')}`);
  const c = congByStreet[r.name];
  if (c) bits.push(`晚高峰拥堵验证（${c.jam + c.slow} 个拥堵/缓行路段）`);
  return bits.join('；') || '常规路网覆盖';
};

// ---------- block 5: schedule = numbered daily routes ----------
// The schedule answers three questions per day: 跑哪些路线（每条 起点→…→终点，
// 独立高德导航链接）、做哪些测试、为什么做。路线集来自 out/routes.json：
// 路线1 从工业园出发串高价值元素锚点，路线2..K 骨架分段接力，路线K+1..N
// 覆盖主力路网；当日分配里程超出路线里程的部分按时段折成重跑，道路落到具体路名。
const CLS_LABEL = { express: '快速路', arterial: '主干路', subArterial: '次干路', collector: '支路', rural: '县乡/乡村道路', local: '街巷', service: '内部道路' };
// 锚点类型 → 沿线可测的 ADAS 项目（"为什么跑这条线"的答案）
const ELEM_TEST = {
  tunnels: '隧道出入（明暗交替）', bridges: '桥梁上下坡/接缝', schools: '学校区域低速·行人识别',
  hospitals: '医院周边行人让行', markets: '市场周边人流/三轮车', construction: '施工路段变道绕行',
  roundabout: '环岛绕行', busStops: '公交站台停靠识别', fuel: '加油站进出',
  charging: '充电站进出', parking: '停车场进出',
};

// 路线文本：起点 → 途经 → 终点。
// v2 重规划后路线统一为 loop：工况道路 + ODD 锚点一趟串完（targets 即这条线要覆盖的点）。
const routeChain = (route) => {
  if (route.kind === 'cover') return route.chain.join('→');
  if (route.kind === 'loop' && route.targets) {
    return route.targets.map((p) => `${p.name}（${p.label}）`).join('→');
  }
  return route.anchors.map((p) => `${p.kind === 'base' ? '<b>' : ''}${p.name}${p.kind === 'base' ? '</b>' : ''}（${p.label}）`).join('→');
};
// 该条路线测什么：loop = 沿途工况点与锚点元素，cover = 路网等级。
const routePurpose = (route) => {
  if (route.kind === 'cover') return `覆盖${route.clsTags.map((c) => CLS_LABEL[c] || c).join('/')}`;
  const src = route.kind === 'loop' && route.targets ? route.targets : (route.anchors || []).filter((a) => a.kind !== 'base');
  const labels = [...new Set(src.map((a) => a.label))].filter(Boolean);
  return labels.length ? `沿线${labels.join('、')}` : '骨架锚点';
};
const routeHtml = (route, i) =>
  `路线${i + 1}：${routeChain(route)} · ${route.distKm}km ≈${route.durMin}min <a href="${route.uri}" target="_blank" style="white-space:nowrap">导航↗</a> <span class="muted">（${routePurpose(route)}）</span>`;

// 当日"做什么测试"：当天路线的锚点元素 → 测试项目；覆盖路线 → 常规感知。
const dayTests = (routes) => {
  const tests = new Map();
  for (const rt of routes) {
    if (rt.kind === 'cover') { tests.set('常规元素感知（红绿灯/斑马线/公交站）', 1); continue; }
    for (const a of rt.anchors || []) {
      if (a.kind === 'base') continue;
      const t = ELEM_TEST[a.kind] || a.label;
      tests.set(t, (tests.get(t) || 0) + 1);
    }
  }
  return [...tests.entries()].map(([t, n]) => (n > 1 ? `${t}×${n}` : t)).join('；') || '常规路网覆盖';
};

// 时段重跑（当日分配里程超出路线里程的部分）：每段给公里数 + 具体道路 +
// 重跑哪几条既有路线（带导航链接）。
const routeRefs = (rt, pred) => ((rt && rt.routes) || [])
  .map((route, i) => ({ route, n: i + 1 }))
  .filter(({ route }) => pred(route))
  .map(({ n }) => `<a href="${rt.routes[n - 1].uri}" target="_blank" style="white-space:nowrap">路线${n}↗</a>`)
  .join(' ');
const rerunLines = (r, rt, km) => {
  const cong = congByStreet[r.name];
  const schoolRoads = ((r.hotspots && r.hotspots.schools) || []).map((h) => h.name).slice(0, 3).join('、');
  const congRoads = cong ? cong.topSegs.map((s) => s.name).slice(0, 3).join('、') : '';
  const schoolRef = routeRefs(rt, (x) => (x.anchors || []).some((a) => a.kind === 'schools'));
  // 重规划后路线统一为 loop（工况路 + 锚点一趟串完），不再有独立的骨架/覆盖段
  const skelRef = routeRefs(rt, (x) => x.kind === 'skeleton' || x.kind === 'loop');
  const coverRef = routeRefs(rt, (x) => x.kind === 'cover');
  return [
    `早高峰 ≈${f1(km * 0.25)}km 学校接送场景（行人/非机动车）${schoolRef ? `重跑 ${schoolRef}` : ''}${schoolRoads ? `，热点：${schoolRoads}` : ''}`,
    `日间 ≈${f1(km * 0.25)}km 主力路网补跑 ${coverRef || skelRef}`,
    `晚高峰 ≈${f1(km * 0.3)}km 拥堵跟车验证${congRoads ? `（${congRoads}）` : ''} ${skelRef}`,
    `晚间 ≈${f1(km * 0.2)}km 黑暗光照/低流量 ${skelRef}`,
  ];
};
// 重跑日的"测什么"：时段场景本身就是测试项。
const RERUN_TESTS = '早高峰学校接送（行人/非机动车识别）· 日间主力路网补测 · 晚高峰拥堵跟车（低速蠕行）· 晚间黑暗光照感知';

// ---------- block 3 helpers: scenario route line ----------
const anchorChain = (anchors) => anchors
  .map((p, i) => `${i === 0 || i === anchors.length - 1 ? '<b>' : ''}${p.name}（${p.label}）${i === 0 || i === anchors.length - 1 ? '</b>' : ''}`)
  .join(' → ');
const routeLine = (rt) => {
  if (!rt) return '<span class="muted">—（该场景无可用锚点路线）</span>';
  if (rt.status === 'ok') {
    return `${rt.street} · ${anchorChain(rt.anchors)} · ${rt.distKm}km ≈${rt.durMin}min · <a href="${rt.uri}" target="_blank">高德导航 ↗</a>`;
  }
  if (rt.status === 'street-route') {
    const g = routeByStreet.get(rt.street);
    if (g) return `${rt.street}（无专属点状元素，沿用该街道路线1 · ${g.distKm}km）· <a href="${g.uri}" target="_blank">高德导航 ↗</a>`;
    return '<span class="muted">—（该街道无可用路线）</span>';
  }
  return '<span class="muted">—（路线规划失败）</span>';
};

// ---------- block 4: per-area static element charts ----------
// One bar chart per street: the 24 static element types (红绿灯/加油站/学校…)
// in a fixed axis order so charts are comparable across streets.
//
// 可信度: element kinds whose CITY-WIDE total is below LOW_SAMPLE_MAX cannot be
// compared between streets (a street showing 1 vs another showing 0 says nothing).
// They are drawn grey and called out in §7 — the number is still shown, just not rankable.
const LOW_SAMPLE_MAX = 20;
const KIND_TOTAL = Object.fromEntries(ALL_TYPES.map((t) => [t.key, rows.reduce((s, r) => s + (r[t.key] || 0), 0)]));
const LOW_KEYS = new Set(ALL_TYPES.filter((t) => KIND_TOTAL[t.key] < LOW_SAMPLE_MAX).map((t) => t.key));
const LOW_LABELS = ALL_TYPES.filter((t) => LOW_KEYS.has(t.key)).map((t) => `${t.label} ${KIND_TOTAL[t.key]}`);
const streetCharts = [...rows]
  .sort((a, b) => (b.totalElements || 0) - (a.totalElements || 0))
  .map((r, i) => ({
    id: `cs${i}`, name: r.name, total: r.totalElements || 0,
    labels: ALL_TYPES.map((t) => t.label),
    counts: ALL_TYPES.map((t) => r[t.key] || 0),
    colors: ALL_TYPES.map((t) => t.color),
    scarce: ALL_TYPES.map((t) => LOW_KEYS.has(t.key)),
    lowCount: ALL_TYPES.filter((t) => LOW_KEYS.has(t.key) && (r[t.key] || 0) > 0).length,
  }));

// ---------- block 1 HTML ----------
const roadClassSection = `
<section id="s1">
  <h2>1 · 道路等级构成（每街道道路公里按等级分解 · 高速单列为参考）</h2>
  <p class="note">口径：密度分母 = 非高速道路里程（快速路/主干路/次干路/支路/街巷/县乡/内部道路全部计入）。堆叠柱 = 7 类非高速等级；灰色柱 = 高速里程（仅参考，不进任何密度分母）。想测某个等级，去下表对应最密集的街道；"代表道路" = 全区该等级里程最长的有名道路。</p>
  <div class="wrap tall" style="height:440px"><canvas id="c7"></canvas></div>
  <table>
    <thead><tr><th>等级</th><th>全区km</th><th style="text-align:left">最密集街道（km）</th><th style="text-align:left">代表道路</th></tr></thead>
    <tbody>
    ${roadClasses.map((c) => `<tr>
      <td>${c.label}${c.key === 'motorway' ? '（参考）' : ''}</td>
      <td>${f1(rows.reduce((s, r) => s + (c.key === 'motorway' ? r.motorwayKm : r.classKm[c.key] || 0), 0))}</td>
      <td style="text-align:left">${c.topStreets.map((s) => `${s.name} ${s.km}`).join(' · ') || '—'}</td>
      <td style="text-align:left">${c.topRoads.map((s) => `${s.name} ${s.km}km`).join(' · ') || '—'}</td>
    </tr>`).join('')}
    </tbody>
  </table>
</section>`;

// ---------- block 2 HTML ----------
// status 1..4 → color scale (green→yellow→orange→red) for heatmap cells
const cellStyle = (v) => {
  if (v === null || v === undefined || v === '') return '';
  if (v < 0.5)  return 'background:#f1f5f9;color:#64748b'; // 未知（高德 status=0）—— 中性地灰，别染成"畅通"的绿
  if (v >= 3)   return 'background:#fecaca;color:#991b1b;font-weight:600';
  if (v >= 2.5) return 'background:#fed7aa;color:#9a3412;font-weight:600';
  if (v >= 2)   return 'background:#fef3c7;color:#92400e';
  if (v >= 1.5) return 'background:#ecfccb;color:#3f6212';
  return 'background:#dcfce7;color:#166534';
};
// Ranges follow the hours that ACTUALLY have effective samples **on the core footprint**
// (see congestion.coverage + CONG_REF.calibration.excludedMeasured):
// 18:00 · 19:00–21:00 · 00:00–02:00. The 22:00–23:00 and 03:00–09:00 slots were dispatched
// but returned no roads; 11:00–17:00 were never dispatched.
// 10:00 有实测，但那是**全区 18 街道**档（路网里多了 50~56km/h 的乡道），不与核心区横比 ——
// 它单列在本节末的「空间覆盖」块。Nothing is smoothed over — the coverage bar under the
// table shows all 24 hours explicitly, holes included.
const CONG_RANGES = [
  { label: '晚高峰 18:00', hours: ['18:00'] },
  { label: '晚间 19:00–21:00', hours: ['19:00', '20:00', '21:00'] },
  { label: '夜间 00:00–02:00', hours: ['00:00', '01:00', '02:00'] },
];
// 足迹隔离：哪些实测档进了分时段曲线、哪些被排除（用于文案，不再写死数字）
const REF_EXCLUDED_HOURS = ((CONG_REF && CONG_REF.calibration && CONG_REF.calibration.excludedMeasured) || []).map((e) => e.hour);
const CORE_BANDS = congestion ? congestion.bandsCovered.filter((h) => !REF_EXCLUDED_HOURS.includes(h)) : [];
const INFERRED_HOURS_N = CONG_REF ? CONG_REF.hours.filter((x) => x.mode === 'inferred').length : 0;
// 被排除出曲线的实测档（足迹不同的那些），文案里如实点名
const EXCLUDED_BANDS = congestion ? congestion.speedCalib.byBand.filter((b) => REF_EXCLUDED_HOURS.includes(b.band)) : [];
const SAMPLE_LEVEL_CN = { ok: '充分', low: '偏少', insufficient: '不足' };
const NOCOV_CN = {
  'source-empty': '高德未覆盖（境内采样均返回 0 路段）',
  'no-inner-road': '无独立数据（返回的路段全落在邻街道）',
  'only-highway': '无城镇道路数据（只采到穿境高速）',
};
const rangeAvg = (r, hours, field) => {
  const src = r[field] || {};
  const vs = hours.map((h) => src[h]).filter((v) => v !== null && v !== undefined && v !== '');
  return vs.length ? +(vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(1) : null;
};
// status=0 在高德是「未知」，不是「畅通」。平均值 < 0.5 只可能出现在超过一半样本是未知时，
// 这时如实标「未知」而不是掉进「畅通」分支（低 1.5 的那一档）。
const rangeLabel = (v) => (v === null || v === undefined) ? '—'
  : v < 0.5 ? '未知'
  : v >= 3 ? '严重拥堵' : v >= 2.5 ? '拥堵' : v >= 2 ? '缓行' : v >= 1.5 ? '轻微缓行' : '畅通';

let congestionSection = '';
if (congestion && congestion.samples > 0 && congestion.bandSummary.length) {
  const rm = congestion.roadMatrix || [];
  // Top 30 by worst-ever status (already sorted desc); all roads in the CSV.
  // 只列出在核心区档里**真有状态**的路段：整档「未知」（高德 status=0）或只在全区 18 街道
  // 档出现的路段，列在这里只是占行 —— 明细仍在 CSV 与上方「空间覆盖」表里，信息不丢。
  const hasCoreData = (r) => CONG_RANGES.some((g) => {
    const v = rangeAvg(r, g.hours, 'byBand');
    return v !== null && v >= 0.5;
  });
  const shownAll = rm.filter(hasCoreData);
  const hiddenN = rm.length - shownAll.length;
  const shown = shownAll.slice(0, 30);

  const cov = congestion.coverage || null;
  // effective sample count that actually lands inside each displayed range
  const effOfRange = (g) => (cov
    ? (cov.hours || []).filter((h) => g.hours.includes(h.hour)).reduce((s, h) => s + h.effective, 0)
    : null);
  const maxEff = cov && (cov.hours || []).length ? Math.max(1, ...cov.hours.map((h) => h.effective)) : 1;
  // 24-hour coverage bar — one column per hour, height = effective sample count.
  // Dashed empty frame = no effective data (dispatched-but-empty OR never dispatched).
  const covBar = cov ? `
  <div class="cov">${cov.hours.map((h) => {
    const voidCls = h.effective ? '' : ' void';
    const px = h.effective ? Math.max(3, Math.round(40 * h.effective / maxEff)) : 0;
    const tip = h.dispatched
      ? `有效采样 ${h.effective} 次 · ${h.roads} 条路段 · ${h.km ?? 0}km`
      : '该小时尚未采样';
    return `<div class="h${voidCls}" title="${tip}"><div class="bar"><i style="height:${px}px"></i></div><div class="lb">${h.hour.slice(0, 2)}</div></div>`;
  }).join('')}</div>
  <p class="kv" style="text-align:center;margin:-6px 0 12px">柱高 = 该小时<b>有效</b>采样次数（满格 ${maxEff} 次）· 虚线空框 = 无实测（该小时均速由下方参考曲线推断，不当作实测）${REF_EXCLUDED_HOURS.length ? ` · <b>${REF_EXCLUDED_HOURS.join('、')} 实为全区 18 街道足迹</b>（路网构成不同），不并入曲线，见本节末「空间覆盖」` : ''}</p>` : '';

  congestionSection = `
<section id="s2">
  <h2>2 · 分时段拥堵态势与空间覆盖（实时采样 ${congestion.effectiveSamples} 次 · 覆盖 ${CONG_COV ? CONG_COV.dates.length : '—'} 天 · 核心区 ${CORE_BANDS.length} 档曲线 + 全区 ${congStreets ? congStreets.summary.officialSubdistricts : 18} 街道快照）</h2>
  <p class="note"><b>高德交通态势是实时快照接口、无历史查询</b>，分时段只能逐时采样累积：实测 <b>${congestion.bandsCovered.length} 档</b> · 有效 ${congestion.effectiveSamples} 次 · ${covDatesCn} · 晚高峰 18:00 <b>${bandKmh(['18:00']) ?? '—'}km/h</b>；其余 <b>${INFERRED_HOURS_N} 档</b>由参考曲线 + 本地实测标定补齐。<b>推断值不当实测用</b>，不参与第 3 节排名。</p>
  ${covBar}
  ${CONG_REF ? `
  <h3 style="margin:16px 0 6px;font-size:14px">分时段均速 —— 实测锚点 + 参考推断（24 小时全覆盖）</h3>
  <div class="wrap" style="height:220px"><canvas id="cS2speed"></canvas></div>
  <p class="kv" style="text-align:center;margin:-2px 0 10px">柱 = 该小时路网里程加权均速 · <b style="color:#0d9488">深青 = 本工程实测</b> · <span style="color:#94a3b8">浅灰 = 参考曲线推断（不当作实测用）</span></p>
  <div class="scrollx"><table>
    <thead><tr><th>时段</th><th>覆盖小时</th><th>里程加权均速</th><th>数据来源</th></tr></thead>
    <tbody>
    ${CONG_REF.bands.map((b) => `<tr>
      <td>${b.label}</td><td>${b.range}</td><td><b>${b.kmh}</b>km/h</td>
      <td>${b.mode === 'measured' ? '<span class="tag g">实测</span>' : b.mode === 'mixed' ? `<span class="tag">实测+推断 <i>${b.measuredHours}/${b.hours.length}</i></span>` : '<span class="tag m">参考推断</span>'}</td>
    </tr>`).join('')}
    </tbody>
  </table></div>
  ` : ''}
  <p class="note tight">按历史最差状态降序；单元格 = 状态 + 该时段均速，<b>—</b> = 无有效采样、留空不猜；全部 ${rm.length} 条见 <code>out/congestion_roads.csv</code>${hiddenN ? `（${hiddenN} 条核心区各档无有效状态，不占行）` : ''}。</p>
  ${congStreets && congStreets.streets && congStreets.streets.length ? `
  <h3 style="margin:20px 0 6px;font-size:14px">空间覆盖 · 全区 ${congStreets.summary.officialSubdistricts} 个街道/镇路况快照（${congStreets.source.band} · 圆形网格 ${congStreets.source.tilesRequested} 点）</h3>
  <p class="note tight">这里是<b>同一时刻（${congStreets.source.band}）铺满全区 ${congStreets.summary.officialSubdistricts} 个街道/镇的空间快照</b>，与上方分时段曲线足迹不同，<b>不要横向比数字</b>。采样用<b>圆形网格</b>（半径 4500m · 间距 6500m · 最大空隙 3753m &lt; 半径，自检无洞）共 ${congStreets.source.tilesRequested} 个几何，狭长 / 偏远街道另补境内代表点；每条路段按里程拆分到所属街道。</p>
  <ul class="tight">
    <li><b>采样体检</b>：${congStreets.source.tilesRequested} 个几何成功 <b>${congStreets.source.tilesOk}</b>，去重后 <b>${congStreets.source.uniqueRoads}</b> 条路段（高德按整条路返回、跨几何重复 ${congStreets.source.dedup ? congStreets.source.dedup.duplicateRecords : '—'} 条记录，不去重会虚增里程）。未采到 ${congStreets.source.tilesFailed} 个：<b>${congStreets.source.tilesEmpty} 个高德确无数据</b>（已重试，是事实）、<b>${congStreets.source.tilesError} 个取数失败</b>（日配额 <code>10044</code> 用尽，非路况结论，可次日补采）。</li>
    <li><b>结论</b>：<b>${congStreets.summary.withTrafficData}/${congStreets.summary.officialSubdistricts} 个街道/镇有城镇道路态势数据</b>，有效里程 ${congStreets.summary.totalKm}km；另有穿境高快速路 ${congStreets.summary.highwayKm}km 单列（路名含「高速」者剔除，否则 95~105km/h 过境车流会把城镇路况整体抬高）。</li>
    <li><b>${congStreets.noCoverage.length} 个镇没有数据，已按原因分类</b>（「0 条路段」≠「路况畅通」）：${(() => { const g = {}; for (const n of congStreets.noCoverage) { const k = NOCOV_CN[n.category] || n.category; (g[k] = g[k] || []).push(n.name); } return Object.entries(g).map(([k, v]) => `<b>${v.join(' / ')}</b> — ${k}`).join('；'); })()}。</li>
    <li><b>样本量分档</b>：充足（≥20km 且 ≥15 段）${congStreets.streets.filter((s) => s.sampleLevel === 'ok').length} 个 · 偏少（5–20km）${congStreets.streets.filter((s) => s.sampleLevel === 'low').length} 个 · 不足（&lt;5km，仅供参考）${congStreets.streets.filter((s) => s.sampleLevel === 'insufficient').length} 个。</li>
  </ul>
  ` : ''}
  <div class="scrollx">
  <table>
    <thead><tr>
      <th>#</th><th>路段</th><th>片区</th>
      ${CONG_RANGES.map((g) => `<th>${g.label}<br><span style="font-weight:400">状态 · 车速</span><br><span class="kv">有效 ${effOfRange(g) !== null ? effOfRange(g) : '—'} 次</span></th>`).join('')}
      <th>全程均速</th><th>样本数</th>
    </tr></thead>
    <tbody>
    ${shown.map((r, i) => `<tr>
      <td>${i + 1}</td>
      <td>${r.name}</td>
      <td>${r.tile || '-'}</td>
      ${CONG_RANGES.map((g) => {
        const v = rangeAvg(r, g.hours, 'byBand');
        const sp = rangeAvg(r, g.hours, 'byBandSpeed');
        return `<td style="${cellStyle(v)}">${rangeLabel(v)}${sp !== null ? ` <b>${sp}</b>km/h` : ''}</td>`;
      }).join('')}
      <td>${r.avgSpeed !== null && r.avgSpeed !== undefined ? r.avgSpeed + 'km/h' : '—'}</td>
      <td>${r.samples || 0}${r.unknownSamples ? `<span class="kv"> +${r.unknownSamples}未知</span>` : ''}</td>
    </tr>`).join('')}
    </tbody>
  </table>
  </div>
</section>`;
} else {
  congestionSection = `
<section id="s2">
  <h2>2 · 分时段拥堵态势 · 待采样</h2>
  <p class="note">
    <b>为什么这里还没有数据：</b>高德交通态势 Web 服务（<code>v3/traffic/status</code>）是<b>实时快照接口</b>——不带时间参数、不提供历史查询。
    要得到分时段态势，只能<b>定时采样累积</b>（或申请商务版历史接口）：
    申请高德 key 后运行 <code>AMAP_KEY=你的key node fetch_congestion.js</code>，在不同时段各采一次，再运行 <code>node build_congestion.js</code> 重新生成本报告。
    历史时段回补见 <code>fetch_congestion_history.js</code>（读取 <code>hist_spec.json</code>；缺配置时只打印待办、不伪造数据）。
  </p>
</section>`;
}

// ---------- block 3 HTML ----------
// Per scenario: score chart (top streets) + 地点优先级 + 点到点推荐路线.
const SCEN_COLORS = ['#dc2626', '#2563eb', '#0d9488', '#ea580c', '#7c3aed', '#059669', '#b45309', '#db2777'];
const scenarioCharts = [];
let scenCards = '';

if (congestionScenario) {
  // Streets with score 0 never had a real 缓行(≥2.0) sample — only their
  // worst-ever roads are listed, so they stay out of the priority ranking.
  const congested = congestionScenario.filter((s) => s.score > 0);
  const top5 = (congested.length ? congested : congestionScenario).slice(0, 5);
  scenarioCharts.push({ id: 'sc0', color: SCEN_COLORS[0], labels: top5.map((s) => s.name), data: top5.map((s) => s.score), unit: '拥堵分' });
  scenCards += `
  <div class="scen">
    <div class="chart" style="height:190px"><canvas id="sc0"></canvas></div>
    <div>
      <h3>场景 1 · 拥堵路段（晚高峰/夜间）</h3>
      <p class="note tight"><b>拥堵分 = Σ(拥堵路段×2 + 缓行路段×1)</b>；街道归属走<b>逐点采样</b>（沿 polyline 每 20m 打点判街道，跨街道长干道按里程拆分，${congAttr ? `${congAttr.viaStreetKm}/${congAttr.total} 条路段` : '—'}）。采样含 <b>${congestion.bandsCovered.length} 个时段档</b>（${congestion.bandsCovered.join(' / ')}），各档覆盖范围不同、见第 2 节。</p>
      <table>
        <thead><tr><th>优先级</th><th>街道</th><th>拥堵分</th><th style="text-align:left">Top 拥堵路段（状态 · 时段 · 车速）</th></tr></thead>
        <tbody>
        ${top5.map((s, i) => `<tr>
          <td>${i + 1}</td><td>${s.name}</td><td><b>${s.score}</b></td>
          <td style="text-align:left">${s.topSegs.map((g) => `${g.name}（${rangeLabel(g.worst)} · ${g.worstBand} · ${g.avgSpeed}km/h）`).join('；') || '—'}</td>
        </tr>`).join('')}
        </tbody>
      </table>
      <p class="route"><b>推荐路线（点到点）：</b>${routeLine(routeByStreet.get(top5[0].name) ? { status: 'street-route', street: top5[0].name } : null)}</p>
    </div>
  </div>`;
} else {
  scenCards += `
  <div class="scen">
    <div></div>
    <div>
      <h3>场景 1 · 拥堵路段 · 暂无采样</h3>
      <p class="note tight">拥堵场景需要 out/congestion.json（高德采样聚合），见上方「分时段拥堵态势」。</p>
    </div>
  </div>`;
}

SCENARIOS.forEach((sc, si) => {
  const ranked = scenarioRank(sc);
  const chart = {
    id: `sc${si + 1}`, color: SCEN_COLORS[(si + 1) % SCEN_COLORS.length],
    labels: ranked.map((x) => x.r.name), data: ranked.map((x) => x.score), unit: '得分',
  };
  scenarioCharts.push(chart);
  scenCards += `
  <div class="scen">
    <div class="chart" style="height:${Math.max(120, ranked.length * 44 + 40)}px"><canvas id="${chart.id}"></canvas></div>
    <div>
      <h3>场景 ${si + 2} · ${sc.label}</h3>
      <p class="note tight">${sc.note}</p>
      <table>
        <thead><tr><th>优先级</th><th>街道</th><th>得分</th><th style="text-align:left">优先地点（元素数）</th></tr></thead>
        <tbody>
        ${ranked.map((x, i) => `<tr>
          <td>${i + 1}</td><td>${x.r.name}</td><td><b>${x.score}</b></td>
          <td style="text-align:left">${sc.hotspot(x.r).join(' · ') || '—'}</td>
        </tr>`).join('') || '<tr><td colspan="4">该场景在全区无元素</td></tr>'}
        </tbody>
      </table>
      <p class="route"><b>推荐路线（点到点）：</b>${routeLine(scenarioRouteBy.get(sc.key))}</p>
    </div>
  </div>`;
});

const scenarioSection = `
<section id="s3">
  <h2>3 · 按测试场景推荐（8 个场景 · 图 + 地点优先级 + 路线）</h2>
  <p class="note">每场景独立打分（0–10，按全部街道最大值归一）：左图 = 该场景得分最高的街道；优先地点 = 该街道该场景元素最集中的道路/地点（括号内为元素个数，县乡道路为公里数）；推荐路线 = Top1 街道的点到点路线，途经该场景专属锚点，「高德导航」按不走高速策略打开同一路线。</p>
  ${scenCards}
</section>`;

// ---------- block 5 HTML: pie ----------
const PIE_COLORS = ['#dc2626', '#ea580c', '#f59e0b', '#eab308', '#65a30d', '#16a34a', '#0d9488', '#06b6d4', '#0ea5e9', '#2563eb', '#4f46e5', '#7c3aed', '#a855f7', '#d946ef', '#db2777', '#f43f5e', '#78716c', '#64748b'];
const pieData = {
  labels: scored.map((r) => r.name),
  data: scored.map((r) => r.score),
  shares: scored.map((r) => Math.round((r.score / scoreSumAll) * 1000) / 10),
  colors: scored.map((_, i) => PIE_COLORS[i % PIE_COLORS.length]),
};

const prioritySection = `
<section id="s4">
  <h2>4 · 综合测试优先级排序（饼图 · 加权分占比）</h2>
  <p class="note">加权分 = Σ(元素密度 × 场景权重)，密度分母 = 非高速道路里程。饼图扇区 = 各街道加权分占全区的比例（数字见下表）。「主要贡献元素」= 把该街道排名拉高的元素类型，按测试价值排序，显示为密度（个/km，稀疏时显示个数）。收费站/服务区属高速场景，不计入城市综合分；加油/充电/停车计数来自高德 POI。</p>
  <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px;align-items:start">
    <div class="wrap tall" style="height:460px"><canvas id="pie"></canvas></div>
    <table>
      <thead><tr><th>排名</th><th>街道/镇</th><th>加权分</th><th>占比</th><th style="text-align:left">主要贡献元素</th></tr></thead>
      <tbody>
      ${scored.map((r, i) => `<tr${i < 4 ? ' class="hi"' : ''}>
        <td>${i + 1}</td>
        <td><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${pieData.colors[i]};margin-right:5px;vertical-align:middle"></span>${r.name}</td>
        <td><b>${r.score}</b></td>
        <td>${pieData.shares[i]}%</td>
        <td style="text-align:left">${scoreBits(r)}</td>
      </tr>`).join('')}
      </tbody>
    </table>
  </div>
</section>`;

// ---------- block 5 HTML: ODD 测试里程需求（工况覆盖 · 选择性覆盖） ----------
// 不跑全部命名道路：select_odd.js 从候选（≥300m 命名·非高速）里选最小道路集
// 承载全部 22 类城区工况（收费站/服务区属高速口径不进选择），fetch_routes.js
// 只对选中道路生成覆盖路线 → 本表里程实测。
let oddSel = null;
try {
  oddSel = JSON.parse(fs.readFileSync(path.join(__dirname, 'out/odd_selection.json'), 'utf8'));
} catch (_) { /* not generated yet */ }
const oddStd = (oddSel && oddSel.tiers.std) || null;
const oddBasic = (oddSel && oddSel.tiers.basic) || null;
// 口径一致性护栏：odd_selection 的标准档总账必须与本报告的排班总账相等
// （两者都取 v2 实测 loop 路线集 + 只排除高速场景的加跑）。不等 = 有上游没重跑。
const oddKmDiff = oddStd ? Math.round((TOTAL_KM - oddStd.totalKm) * 10) / 10 : null;
if (oddKmDiff !== null && Math.abs(oddKmDiff) > 1) {
  throw new Error(`排班总账与 odd_selection 标准档不一致：${TOTAL_KM} vs ${oddStd.totalKm}（差 ${oddKmDiff}km，请先重跑 select_odd.js）`);
}
// 全量穷举参考 / 全区路网家底：已提前到 §5 之前定义（report_alloc 快照需同源引用），此处不再重复
// 路线集实测（v2 重规划后统一为 loop：工况道路 + ODD 锚点一趟串完，不再分骨架/覆盖两趟）
const legKm = (pred) => [...routeByStreet.values()]
  .reduce((s, r) => s + (r.routes || []).filter(pred).reduce((x, rt) => x + (rt.distKm || 0), 0), 0);
const skelKm = f1(legKm((x) => x.kind === 'skeleton' || x.kind === 'loop'));
const coverKm = f1(legKm((x) => x.kind === 'cover'));
// 途经点计数：loop 用 targets（工况点 + 锚点），老格式用 anchors
const anchorCount = [...routeByStreet.values()]
  .reduce((s, r) => s + (r.routes || []).reduce((x, rt) => x
    + (rt.kind === 'loop' && rt.targets ? rt.targets.length
      : (rt.anchors || []).filter((a) => a.kind !== 'base').length), 0), 0);
const loopLegCount = [...routeByStreet.values()].reduce((s, r) => s + ((r.routes || []).length), 0);
const maxLegsPerStreet = Math.max(...[...routeByStreet.values()].map((r) => (r.routes || []).length));
const kindRows = oddStd ? Object.values(oddStd.kindCoverage) : [];
// ---- 载体口径校正（隧道 / 桥梁）----------------------------------------------
// tunnel=yes / bridge=yes 是 OSM 修饰符，铁路隧道、水道涵洞、人行步道都会带上它。
// 统计侧（build_stats / build_odd_quota）已按载体过滤；但**选路侧刻意没过滤**，
// 因为过滤会改元素计数→改配额→改选中的工况道路集合（实测 165→164 条），而
// routes.json 的真实高德几何是按旧集合抓的，重取要全量重规划。所以这里做只读校正：
// 不改排班，只把报告里两行的 全区实例/配额/选中样本 换成过滤后真实数字。
// 明细见 tools/build_carrier_report.js → out/carrier_report.json。
let carrierReport = null;
try { carrierReport = JSON.parse(fs.readFileSync(path.join(__dirname, 'out/carrier_report.json'), 'utf8')); } catch (_) { /* 可选 */ }
if (carrierReport) {
  const LABEL2KEY = { '隧道': 'tunnels', '桥梁': 'bridges' };
  for (const k of kindRows) {
    const c = carrierReport.kinds[LABEL2KEY[k.label]];
    if (!c) continue;
    k.rawTotalBeforeCarrier = k.total;   // 过滤前条数，留痕备查
    k.total = c.inArea;                  // 区内家底（与 street_stats 同源）
    k.quota = c.quota;                   // 可排班工作面（候选道路 80m 内）
    k.got = c.covered;                   // 本次排班实际途经（60m 口径）
    k.carrierFixed = true;
  }
}
const exhaustKinds = kindRows.filter((k) => k.exhaust);
const sampleKinds = kindRows.filter((k) => !k.exhaust);
const classRows = oddStd ? Object.values(oddStd.classCoverage) : [];
const selSharePct = oddStd && oddSel ? Math.round((oddStd.selCenterKm / oddSel.candCenterKm) * 1000) / 10 : 0;
// 有效测试里程占比 = 选中道路双向里程 ÷ 空间层里程（差额 = 连接段/转场空驶）
const effSharePct = oddStd ? Math.round((oddStd.selCenterKm * 2 / ODD_SPATIAL_KM) * 1000) / 10 : 0;
const savePct = Math.round((1 - TOTAL_KM / EXHAUSTIVE_REF_KM) * 100);
// §5 图表数据：投入→覆盖比例 / 里程→覆盖曲线 / 等级覆盖（标签内嵌数值，离屏可读）
const kindCount = exhaustKinds.length + sampleKinds.length;
const oddRatioChart = oddSel && oddStd ? {
  labels: ['里程占比', '工况覆盖', '等级保底'],
  pct: [selSharePct, 100, 100],
  selKm: f1(oddStd.selCenterKm), candKm: f1(oddSel.candCenterKm),
} : null;
const oddCurveChart = oddStd && oddBasic ? {
  labels: [
    ['0 km', '起点'],
    ['基础档', `${oddBasic.totalKm} km`, `±10% · n≥${oddBasic.n}`],
    ['标准档', `${TOTAL_KM} km`, '±5% · 本排班'],
    ['全量穷举', `${EXHAUSTIVE_REF_KM} km`, '参考'],
  ],
  kinds: [0, kindCount, kindCount, kindCount],
  max: kindCount, nBasic: oddBasic.n, nStd: oddStd.n,
} : null;
// §5 区域计划：逐街道里程表（与第 6 节排班同口径 = 路线集双向 + 场景加跑分摊 + 微调池）
// 未上榜街道填「真实理由」而不是套模板——从数据挖该街道独有的贡献：
// ① 差位场景：ODD 场景密度榜第 4–6 名且得分 ≥3（差一点进加跑榜）→ 加跑由前三承载，本镇样本走空间层顺路
// ② 元素数量榜：全区前三（密度定加跑榜；数量看空间层顺路能带多少样本）
// ③ 等级里程榜：全区前三且 ≥5km（该等级保底的主要贡献街道）
// ④ 收费站榜：全区前三 —— 高速口径排除（无人小车不上主线），真实强项如实写明
// 全都挖不到（如芦洲镇）→ 空间层区域代表（18 街道/镇全跑保区域维度）
const normV = (vals) => { const mx = Math.max(...vals, 0); return vals.map((v) => (mx > 0 ? v / mx : 0)); };
const scenFullRank = ALLOC_SCENARIOS.map((sc) => {
  const norms = sc.metrics.map((m) => normV(rows.map(m.v)));
  return {
    sc,
    full: rows
      .map((r, i) => ({ r, score: +(sc.metrics.reduce((s, m, j) => s + m.w * norms[j][i], 0) * 10).toFixed(1) }))
      .sort((a, b) => b.score - a.score),
  };
});
const cntRank = (v, getV) => ({
  v,
  rank: rows.filter((x) => getV(x) > v).length + 1,
  tied: rows.filter((x) => getV(x) === v).length > 1,
});
const rankCn = (o) => (o.rank === 1 ? '全区最多' : o.tied ? `全区并列第${o.rank}` : `全区第${o.rank}`);
const shortName = (n) => n.replace(/街道|镇/g, '');
// 未上榜街道的「真实理由」拆成结构化位，好渲染成徽章而不是一坨文字。
// ① 差位场景（密度榜第 4–6 名、差一点进加跑榜）② 元素数量全区前三 ③ 等级里程全区前三 ④ 收费站前三
const realWhyBits = (r) => {
  const nm = scenFullRank.map(({ sc, full }) => {
    const i = full.findIndex((x) => x.r.name === r.name);
    return i >= 3 && i <= 5 && full[i].score >= 3
      ? {
        score: full[i].score, sc, rank: i + 1,
        kv: sc.metrics.map((m) => m.fmt(r)).join(' · '),
        note: `加跑由${full.slice(0, 3).map((x) => shortName(x.r.name)).join('/')}承载，本镇样本走空间层顺路`,
      } : null;
  }).filter(Boolean).sort((a, b) => b.score - a.score)[0] || null;
  const bits = [];
  const used = [];
  if (nm) used.push(nm.sc.label);
  COMPOSITE_TYPES.map((t) => {
    const o = cntRank(r[t.key] || 0, (x) => x[t.key] || 0);
    const lead = Math.max(...rows.map((x) => x[t.key] || 0));
    // 数量位要够分量：≥2 个、全区前三、且 ≥ 全区第一名的一半
    //（否则如「铁路道口 2 个并列第2」—— 第一名 116 个，2 个不构成测试理由）
    return o.v >= 2 && o.rank <= 3 && o.v * 2 >= lead && !used.some((u) => u.includes(t.label))
      ? { rank: o.rank, w: t.w, text: `${t.label} ${r[t.key]} 个 #${o.rank}` } : null;
  }).filter(Boolean).sort((a, b) => a.rank - b.rank || b.w - a.w).slice(0, 2).forEach((x) => bits.push(x));
  CLASS_KEYS.map((c) => {
    const o = cntRank(r.classKm[c.key] || 0, (x) => x.classKm[c.key] || 0);
    return o.v >= 5 && o.rank <= 3 && !used.some((u) => u.includes(c.label.split('/')[0]))
      ? { rank: o.rank, text: `${c.label} ${f1(o.v)}km #${o.rank}` } : null;
  }).filter(Boolean).sort((a, b) => a.rank - b.rank).slice(0, 2).forEach((x) => bits.push(x));
  const tw = cntRank(r.tolls || 0, (x) => x.tolls || 0);
  if (tw.v >= 2 && tw.rank <= 3) bits.push({ rank: tw.rank, text: `收费站 ${r.tolls} 个 #${tw.rank}`, kv: '高速口径排除 · 不上主线' });
  return { nm, bits };
};
// 场景角色徽章：蓝 = 场景 Top-3 · 绿 = 全区第 1–3 · 灰 = 差位/顺路
const SCEN_SHORT = { '乡村/县乡道路': '县乡/乡村', '施工路段': '施工', '学校路段': '学校' };
const tag = (cls, main, kv) => `<span class="tag${cls ? ' ' + cls : ''}">${main}${kv ? `<i>${kv}</i>` : ''}</span>`;
const roleHtmlOf = (r) => {
  const scen = scenDetailByStreet[r.name] || [];
  if (scen.length) return scen.map((x) => tag('', `${SCEN_SHORT[x.label] || x.label}#${x.rank}`, x.why)).join('');
  const { nm, bits } = realWhyBits(r);
  if (!nm && !bits.length) {
    const sel = (oddStd && oddStd.byStreet && oddStd.byStreet[r.name] || []).length;
    return tag('m', '无场景角色', `本镇无全区上榜强项${sel ? '' : '、无选中工况道路'} → 跑空间层保区域维度与等级保底`);
  }
  const head = nm
    ? tag('m', `差位 · ${SCEN_SHORT[nm.sc.label] || nm.sc.label}密度#${nm.rank}`, nm.kv)
      + `<span class="kv">${nm.note}</span><br>`
    : '';
  const body = bits.map((b) => tag('g', b.text, b.kv)).join('');
  const tail = nm ? '' : '<span class="kv">样本走空间层顺路覆盖</span>';
  return head + body + tail;
};
const streetPlanRows = allocRows.map(({ r, a, h }) => {
  const rt = routeByStreet.get(r.name);
  const selRoads = (oddStd && oddStd.byStreet && oddStd.byStreet[r.name] || []).length;
  return {
    name: r.name, selRoads,
    spatialKm: rt ? bidirOf(r.name, rt.distKm) : null,
    scenKm: +(scenKmByStreet[r.name] || 0).toFixed(1),
    totalKm: +a.toFixed(1), hours: +h.toFixed(1),
    roleHtml: roleHtmlOf(r),
    hasRole: (scenDetailByStreet[r.name] || []).length > 0,
  };
});
const streetPlanTot = {
  selRoads: oddStd ? Object.values(oddStd.byStreet || {}).reduce((s, l) => s + l.length, 0) : 0,
  spatialKm: +ODD_SPATIAL_KM.toFixed(1),
  scenKm: +Object.values(scenKmByStreet).reduce((x, y) => x + y, 0).toFixed(1),
  totalKm: +allocRows.reduce((s, x) => s + x.a, 0).toFixed(1),
  hours: +totHours.toFixed(1),
};
const oddClassChart = {
  labels: classRows.map((c) => c.label),
  cand: classRows.map((c) => c.totalKm),
  floor: classRows.map((c) => c.floorKm),
  sel: classRows.map((c) => c.selKm),
};
const topSamples = [...sampleKinds].sort((a, b) => b.got - a.got).slice(0, 3)
  .map((k) => `${k.label} ${k.got}/${k.quota}`).join('、');
const hospK = kindRows.find((k) => k.label === '医院') || {};
const kindPct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const exKindTable = (list, title) => `<div class="scrollx"><table>
  <thead><tr><th colspan="5" style="text-align:left">${title}</th></tr>
  <tr><th style="text-align:left">工况类</th><th>全区实例</th><th>ODD 范围内</th><th>选中命中</th><th>达标</th></tr></thead>
  <tbody>
  ${list.map((k) => {
    const d = k.got - k.quota;
    const mk = d >= 0 ? '<span style="color:#059669">✓ 全中</span>'
      : `<span style="color:#b45309">△ 差 ${-d}</span>`;
    return `<tr><td style="text-align:left">${k.label}</td><td>${k.total}</td><td><b>${k.quota}</b></td><td><b>${k.got}</b></td><td>${mk}</td></tr>`;
  }).join('')}
  </tbody>
</table></div>`;
const smKindTable = (list, title) => `<div class="scrollx"><table>
  <thead><tr><th colspan="6" style="text-align:left">${title}</th></tr>
  <tr><th style="text-align:left">工况类</th><th>全区实例</th><th>置信配额</th><th>选中样本</th><th>占全区</th><th>达标</th></tr></thead>
  <tbody>
  ${list.map((k) => {
    const d = k.got - k.quota;
    const mk = d >= 0 ? '<span style="color:#059669">✓</span>'
      : `<span style="color:#b45309">△ 差 ${-d}</span>`;
    return `<tr><td style="text-align:left">${k.label}</td><td>${k.total}</td><td>≥${k.quota}</td><td><b>${k.got}</b></td><td>${kindPct(k.got, k.total)}%</td><td>${mk}</td></tr>`;
  }).join('')}
  </tbody>
</table></div>`;
// ---------- §5 ① ODD 维度明细（out/odd_dims.json · build_odd_dims.js 产出） ----------
let oddDims = null;
try { oddDims = JSON.parse(fs.readFileSync(path.join(__dirname, 'out/odd_dims.json'), 'utf8')); } catch (_) { /* not generated yet */ }
const tagDims = (oddDims && oddDims.dims) || [];
const insuDims = (oddDims && oddDims.insufficient) || [];
const DIM_BADGE = (st) => `<span class="tag ${st === 'ok' ? 'g' : st === 'sparse' ? 'm' : ''}">${st === 'ok' ? '已覆盖' : st === 'partial' ? '部分覆盖' : '数据不足 · 仅定性'}</span>`;
const hwText = (hw) => Object.entries(hw).map(([k, v]) => `${k}×${v}`).join(' / ');
const dimRowsHtml = tagDims.map((d) => `<tr>
      <td style="text-align:left">${d.label}</td>
      <td>标注覆盖 <b>${d.knownPct}%</b></td>
      <td style="text-align:left">${d.note}</td>
      <td>${DIM_BADGE(d.status)} ${d.selBucketCount}/${d.bucketCount} 档</td>
    </tr>`).join('');
const bucketTablesHtml = tagDims.map((d) => `
  <div>
    <p class="note tight k" style="margin:0 0 6px"><b>${d.label}</b> · 全区标注覆盖 <b>${d.knownPct}%</b>（已知 ${d.knownKm}km / ${d.totalKm}km，未标注 ${d.unknownKm}km）· 选中覆盖 <b>${d.selBucketCount}/${d.bucketCount}</b> 档</p>
    <div class="scrollx"><table>
      <thead><tr><th style="text-align:left">档位</th><th>全区km</th><th>占比</th><th>选中km</th></tr></thead>
      <tbody>
      ${d.buckets.map((b) => `<tr${/未标注|其他/.test(b.label) ? ' style="color:#94a3b8"' : ''}>
        <td style="text-align:left">${b.label}</td><td>${b.km}</td><td>${b.pct}%</td><td>${b.selKm}km</td></tr>`).join('')}
      </tbody>
    </table></div>
    ${d.selMissing.length ? `<p class="note tight k" style="margin:6px 0 0;color:#b45309">选中道路未覆盖档位：<b>${d.selMissing.join('、')}</b>${
      /未铺装|其他铺装/.test(d.selMissing.join()) ? ' —— 未铺装路面全区仅 ' + (d.buckets.find((b) => b.label === '未铺装') || {}).km + 'km（3 条 way），且不在选中道路集内；如需覆盖须单点补路' : ''}</p>` : ''}
  </div>`).join('');

const oddSection = `
<section id="s5">
  <h2>5 · 测试里程需求（ODD 工况覆盖 · 选择性覆盖而非全路穷举）</h2>
  <p class="note tight">ODD = 惠城区 <b>18 街道/镇</b> × 非高速 <b>7 级道路</b> × <b>双向</b> × <b>${kindCount} 类城区场景元素</b> × <b>4 个时段</b> × <b>4 个标签维度</b>（速度 / 车道 / 单行 / 路面域，标注率与逐档见 ①）。收费站 / 服务区属高速口径，无人小车不上主线，不在选择内。</p>
  <p class="note tight">思路：<b>挑有价值的工况覆盖，不把 ${oddSel ? oddSel.candRoads : '—'} 条候选命名道路全跑一遍</b>——全量穷举要 ${EXHAUSTIVE_REF_KM}km；选出 <b>${oddStd ? oddStd.roads : '—'} 条</b>（${oddStd ? oddStd.selCenterKm : '—'}km · 占 ${selSharePct}%）即承载全部 ${kindCount} 类工况，<b>总预算 ${TOTAL_KM}km ≈ ${dayPlan.length} 天，省 ${savePct}%</b>。</p>
  <div class="steps"><span>① 覆盖了哪些 · 占比多少</span><span>② 要测多少公里 · 为什么</span><span>③ 哪些区域各测多少</span><span>④ 里程换覆盖的比例</span></div>
  <h3>① 覆盖了哪些 · 8 个可标定 ODD 维度</h3>
  <p class="note tight">8 个维度分两类：<b>前 4 个靠排班设计</b>保证（区域 / 等级 / 元素 / 时段）；<b>后 4 个靠 OSM 标签</b>标定（速度 / 车道 / 单行 / 路面）—— 只有被标注过的道路才计入，<b>标注率即可信度上限</b>。</p>
  <div class="scrollx"><table>
    <thead><tr><th style="text-align:left">ODD 维度</th><th>覆盖范围</th><th style="text-align:left">覆盖方式 / 说明</th><th>达标</th></tr></thead>
    <tbody>
    <tr><td style="text-align:left">区域</td><td>18 街道/镇全域</td><td style="text-align:left">空间层：每街道一条路线集 × 双向（逐街道里程见 ③）</td><td>${DIM_BADGE('ok')} 18/18</td></tr>
    <tr><td style="text-align:left">道路等级</td><td>非高速 7 级</td><td style="text-align:left">等级保底：每级选中 ≥${oddStd ? Math.round(oddStd.floorShare * 100) : '—'}% 或 ≥${oddStd ? oddStd.floorMin : '—'}km，候选不足取全部（见下方等级图）</td><td>${DIM_BADGE('ok')} 7/7</td></tr>
    <tr><td style="text-align:left">场景元素</td><td>${kindCount} 类城区工况</td><td style="text-align:left">穷举 ${exhaustKinds.length} 类 100% 命中 + 统计 ${sampleKinds.length} 类置信抽样达标（逐类见下两表）</td><td>${DIM_BADGE('ok')} ${kindCount}/${kindCount}</td></tr>
    <tr><td style="text-align:left">时段</td><td>早高峰 / 日间 / 晚高峰 / 晚间</td><td style="text-align:left">空间层日间顺路覆盖 + 场景路线双向 × ${TEST.SCEN_TIMES} 时段加跑（早高峰学校接送 / 晚高峰拥堵 / 晚间黑暗光照）；<b>排班窗口 07:00–23:00，实测覆盖见第 2 节</b></td><td>${DIM_BADGE('ok')} 4/4</td></tr>
    ${dimRowsHtml}
    </tbody>
  </table></div>
  <p class="note tight k">另 <b>4 个常见维度（坡度 / 宽度 / 平整度 / 减速设施）</b> OSM 全区仅标注 <b>${insuDims.map((s) => s.n).join(' / ')}</b> 处、且全在人行步道 / 台阶 / 小径上，对机动车无意义：<b>不列入、不外推</b>，留档 <code>out/odd_dims.json</code>。</p>
  <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:12px">
    ${bucketTablesHtml}
  </div>
  <p class="note tight k" style="margin-top:10px"><b>读法</b>：<b>标注覆盖</b>= 有 OSM 标签道路 km ÷ 非高速中心线 ${oddDims ? oddDims.basis.km : '—'}km（该维度<b>可判范围</b>）；<b>选中 km</b>= 选中道路（${oddDims ? oddDims.basis.selectedWays : '—'} way）各档分布。<b>未标注 ≠ 没有</b> —— 未标注道路仍按参照车速参与排班（见 ②），只是不进统计。</p>
  <p class="note tight" style="margin-top:14px"><b>${kindCount} 类工况逐类清单</b> —— <b>穷举类</b>（稀缺类，配额 = 关联实例数）<b>全部命中</b>；<b>统计类</b>（常见类）配额 = 置信度最小样本量 n≥${oddStd ? oddStd.n : '—'}（n = z²p(1−p)/e²，p=0.9、e=±5%、95%CI），<b>选中样本 ≥ 配额即达标</b>。</p>
  <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px;align-items:start">
    <div>
      ${exKindTable(exhaustKinds, `穷举类 · ${exhaustKinds.length} 类 · 100% 命中`)}

    </div>
    <div>
      ${smKindTable(sampleKinds, `统计类 · ${sampleKinds.length} 类 · 抽样达标`)}

    </div>
  </div>
  <p class="note tight k" style="margin-top:10px"><b>两表读法</b>：穷举类配额 = ODD 内实例数、<b>一个不漏</b>（如医院 ${hospK.total} → ${hospK.quota} → 选中 ${hospK.got}）；统计类配额 n = 「至少抽多少才够 ±5% 精度」、<b>不指定是哪几个</b>（如 ${topSamples}，超配额即达标，超出部分顺路带）。ODD 范围 = 候选道路（≥300m 命名 · 非高速）80m 内的实例，路外实例随连接段顺路穿越、不计配额。</p>${carrierReport ? `
  <p class="note tight" style="margin-top:8px;color:#b45309"><b>⚠ 隧道 / 桥梁已按载体校正</b>：OSM 的 <code>tunnel=yes</code>/<code>bridge=yes</code> 是<b>修饰符</b>，会同时贴在铁路隧道、水道涵洞、人行步道上 —— 未校正前把莞惠城际铁路隧道、溪流涵洞都算成了「途经隧道」。剔除非 ODD 载体 + 同构造物 50m 去重后：隧道 ${carrierReport.kinds.tunnels.raw} → <b>${carrierReport.kinds.tunnels.inArea}</b> 个（区内）、桥梁 ${carrierReport.kinds.bridges.raw} → <b>${carrierReport.kinds.bridges.inArea}</b> 座（剔除 ${carrierReport.kinds.tunnels.droppedPct}% / ${carrierReport.kinds.bridges.droppedPct}%）。区内隧道不足标准档 n=${oddStd ? oddStd.n : 139}，故配额取其<b>可排班工作面</b> ${carrierReport.kinds.tunnels.reachable} 个（候选道路 80m 内，其余 ${carrierReport.kinds.tunnels.inArea - carrierReport.kinds.tunnels.reachable} 个不在命名道路上、排班到不了），本次排班已覆盖 <b>${carrierReport.kinds.tunnels.covered}/${carrierReport.kinds.tunnels.reachable}</b>（差 ${carrierReport.kinds.tunnels.reachable - carrierReport.kinds.tunnels.covered} 个落在候选道路、但不在本次选中的 165 条里）。</p>` : ''}
  <div style="margin-top:14px">
    <p class="note tight"><b>道路等级覆盖</b>（灰 = 候选 km · 黄 = 保底 km · 绿 = 选中 km）</p>
    <div class="wrap" style="height:300px"><canvas id="cOddClass"></canvas></div>
    <p class="note tight">7 等级全部达标：选中 km ≥ 保底 km（每级 ≥${oddStd ? Math.round(oddStd.floorShare * 100) : '—'}% 或 ≥${oddStd ? oddStd.floorMin : '—'}km，候选不足取全部），靠「选哪些路」满足、不产生额外里程（见 ②）。</p>
  </div>
  <h3>② 覆盖模型 · ${TOTAL_KM}km 怎么算出来的</h3>
  <p class="note tight">六个 ODD 层里，<b>穷举 / 统计 / 等级 / 维度</b>四层靠「选哪些路」满足（里程 0），只有<b>空间层</b>（选中道路去程 + 返程各 1 遍）与<b>场景层</b>（场景路线加跑）产生里程。逐层见下表。</p>
  <div class="scrollx"><table>
    <thead><tr><th>ODD 工况层</th><th>覆盖目标</th><th>需跑里程</th><th style="text-align:left">达成情况</th></tr></thead>
    <tbody>
    <tr><td>穷举 · 稀缺高价值元素</td><td>${exhaustKinds.length} 类 100% 命中</td><td>0（已含在空间层）</td><td style="text-align:left">${exhaustKinds.length} 类全部命中（医院/环岛/铁路道口等稀缺类，逐类见 ① 穷举表）</td></tr>
    <tr><td>统计 · 常见元素置信度</td><td>每类 n ≥ ${oddStd ? oddStd.n : '—'}（${oddStd ? oddStd.ci : ''} @95%CI）</td><td>0（已含）</td><td style="text-align:left">${sampleKinds.length} 类全部达标（${topSamples} 等，逐类见 ① 统计表）</td></tr>
    <tr><td>等级 · 道路等级保底</td><td>每等级 ≥ ${oddStd ? Math.round(oddStd.floorShare * 100) : '—'}% 或 ≥ ${oddStd ? oddStd.floorMin : '—'}km</td><td>0（已含）</td><td style="text-align:left">7 个等级全部达标（见 ① 等级覆盖图）</td></tr>
    <tr><td>维度 · 速度/车道/单行/路面</td><td>${tagDims.length} 个标签维度 · 选中共覆盖 ${tagDims.reduce((s, d) => s + d.selBucketCount, 0)}/${tagDims.reduce((s, d) => s + d.bucketCount, 0)} 档</td><td>0（已含）</td><td style="text-align:left">${tagDims.map((d) => `${d.label.replace(/（.*）/, '')} ${d.selBucketCount}/${d.bucketCount}${d.selMissing.length ? `（缺 ${d.selMissing.join('/')}）` : ''}${d.status === 'sparse' ? ' · 标注不足' : ''}`).join(' · ')} —— 靠「选哪些路」取得档位覆盖，不产生额外里程</td></tr>
    <tr><td>空间 · 选中道路行驶</td><td>${oddStd ? oddStd.roads : '—'} 条 · 去程 + 返程各 1 遍</td><td><b>${f1(ODD_SPATIAL_KM)}km</b></td><td style="text-align:left">去程 ${f1(routeKmAll)}km + 返程 ${routeReturnKmAll != null ? f1(routeReturnKmAll) : '—'}km（各腿高德实测算路：${loopLegCount} 条路线串 ${anchorCount} 个工况点/锚点${coverKm > 0 ? ` + 覆盖链 ${coverKm}km` : ''}；每街道 1–${maxLegsPerStreet} 条，一趟同时扫工况路与元素锚点；正、反向分别规划，不用 2×单程 近似）</td></tr>
    <tr><td>时段 · 场景强化</td><td>${scenOkRoutes.length} 条独立场景路线 × 双向 × ${TEST.SCEN_TIMES} 时段</td><td><b>${f1(ODD_SCENARIO_KM)}km</b></td><td style="text-align:left">双向 ×3 时段 − 空间层已含 1 遍 = <b>2 ×（去程 ${f1(scenRouteKmAll)} + 返程 ${scenReturnKmAll != null ? f1(scenReturnKmAll) : '—'}）</b> 加跑（学校=早高峰接送 / 拥堵=晚高峰跟车 / 隧道=明暗交替 / 施工=绕行）。6 类场景中「乡村/县乡道路」复用街道路线、不单列里程，故独立路线计 ${scenOkRoutes.length} 条</td></tr>
    <tr class="hi"><td><b>合计（全 22 类城区工况）</b></td><td><b>100% 工况覆盖</b></td><td><b>${TOTAL_KM}km</b></td><td style="text-align:left">= 排班表总预算；比全量穷举 ${EXHAUSTIVE_REF_KM}km 省 ${savePct}%（见 ④ 里程 → 覆盖曲线）</td></tr>
    </tbody>
  </table></div>
  <p class="note tight k">${oddStd ? `<b>里程口径（口径已统一）</b>：本表 ${TOTAL_KM}km = <b>排班预算</b>（中心线串联实测 ${f1(ODD_SPATIAL_KM)}km + 场景加跑 ${f1(ODD_SCENARIO_KM)}km）；<code>odd_selection.json</code> 标准档 <b>${oddStd.totalKm}km</b> 与之一致 —— 空间层取 v2 实测 loop 路线集（不再用「中心线 × 途经系数」估算），场景层同样只排除高速场景。基础档 <b>${oddBasic ? oddBasic.totalKm : '—'}km</b> 无独立路线集，按「选中道路中心线」比例缩放（${oddBasic ? oddBasic.selCenterKm : '—'} ÷ ${oddStd.selCenterKm}）。` : ""}</p>
  <h3>③ 区域计划 · 挑哪些区域、各测多少公里（18 街道/镇全跑 · 与第 6 节排班同口径）</h3>
  <p class="note tight">空间层 <b>18 个街道/镇全跑</b>（每街道一条路线集 × 双向），其中 <b>${streetPlanTot.selRoads} 段</b>选中道路承载 ${kindCount} 类工况（同路跨等级计多段）。下表按合计里程降序 = 测试优先级 = 第 6 节排班总账。</p>
  <p class="note tight k"><b>${dayPlan.length} 天怎么来的</b>：${TOTAL_KM}km 按分时段均速折算纯行驶 <b>${f1(totHours)}h</b>，以<b>街道为最小单位</b>装箱进每天 ${TEST.HOURS_PER_DAY}h 窗口（不跨街道拼半天）→ <b>${dayPlan.length} 天 · 装载率 ${packPct}%</b>；理论下限 ${f1(totHours / TEST.HOURS_PER_DAY)} 天，差额为街道不可拆分的日尾余量。</p>
  <div class="scrollx"><table>
    <thead><tr><th>#</th><th style="text-align:left">街道/镇</th><th>选中工况道路</th><th>空间层（双向）</th><th>场景加跑</th><th>合计</th><th>时长</th><th style="text-align:left;min-width:230px">场景角色<br><span style="font-weight:400">蓝=场景 Top-3 · 绿=全区第 1–3 · 灰=差位/顺路</span></th></tr></thead>
    <tbody>
    ${streetPlanRows.map((s, i) => `<tr${i < 5 ? ' class="hi"' : ''}>
      <td>${i + 1}</td><td style="text-align:left">${s.name}</td>
      <td>${s.selRoads ? s.selRoads + ' 条' : '0 条'}</td>
      <td>${s.spatialKm !== null ? s.spatialKm + 'km' : '—'}</td>
      <td>${s.scenKm >= 0.05 ? s.scenKm + 'km' : '0'}</td>
      <td><b>${s.totalKm}km</b></td><td>${s.hours}h</td>
      <td style="text-align:left">${s.roleHtml}</td>
    </tr>`).join('')}
    <tr class="hi"><td></td><td style="text-align:left"><b>合计（18 街道/镇）</b></td><td><b>${streetPlanTot.selRoads} 条</b></td><td><b>${streetPlanTot.spatialKm}km</b></td><td><b>${streetPlanTot.scenKm}km</b></td><td><b>${streetPlanTot.totalKm}km</b></td><td><b>${streetPlanTot.hours}h</b></td><td style="text-align:left"><b>≈ ${dayPlan.length} 天 × ${TEST.HOURS_PER_DAY}h</b></td></tr>
    </tbody>
  </table></div>
  <ul class="tight">
    <li><b>空间层</b> = 该街道路线集 × 双向；<b>场景加跑</b> = 场景路线按排名分摊，徽章 = 该街道在该场景的 Top-3（灰字为该排名指标值，如 ${tag('', '学校路段#1', '学校 41 · 灯/km 0.48')}）。</li>
    <li><b>拥堵不单设角色</b>：晚高峰为全区强化时段（第 2 节实测），统一走 ② 时段层重跑（6 场景 × 3 席，${streetPlanRows.filter((s) => s.hasRole).length} 个街道上榜）。<b>未上榜街道一律给真实理由</b>：差的标差位（如 ${tag('m', '差位 · 施工密度#4', '施工 41')}），前几名的走空间层顺路覆盖（如 ${tag('g', '内部道路 38.5km #1', '')}）。</li>
    <li><b>合计</b> = 空间层 + 场景加跑；<b>时长</b> = 合计 ÷ 分时段均速（晚高峰折减）。芦洲镇无选中工况道路仍跑空间层，保区域与等级代表性。</li>
  </ul>
  <h3>④ 里程 → 覆盖 · 测多少公里，换来多少 ODD</h3>
  <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px;align-items:stretch">
    <div>
      <p class="note tight"><b>投入 → 覆盖比例</b>（跑 ${selSharePct}% 的路，覆盖 100% 的工况）</p>
      <div class="wrap" style="height:300px"><canvas id="cOddRatio"></canvas></div>
      <p class="note tight">三行 = <b>里程占比</b>（选中 ${oddStd ? f1(oddStd.selCenterKm) : '—'}km ÷ 候选 ${oddSel ? f1(oddSel.candCenterKm) : '—'}km = ${selSharePct}%）、<b>工况覆盖</b> ${kindCount}/${kindCount} 类、<b>等级保底</b> 7/7 级 —— <b>少跑路、全覆盖</b>。</p>
      <p class="note tight k"><b>有效测试里程占比 ${effSharePct}%</b>：选中道路双向 ${oddStd ? f1(oddStd.selCenterKm * 2) : '—'}km ÷ 空间层 ${f1(ODD_SPATIAL_KM)}km；其余 ${f1(100 - effSharePct)}% 为往返连接与转场空驶。</p>
    </div>
    <div>
      <p class="note tight"><b>里程 → 工况覆盖曲线</b>（纵轴 = 已覆盖工况类数，${kindCount} 封顶）</p>
      <div class="wrap" style="height:300px"><canvas id="cOddCurve"></canvas></div>
      <p class="note tight">三档<b>同口径</b>（= 空间层 + 场景加跑 ${oddBasic ? f1(oddBasic.scenAddKm) : '—'}km，与上表「合计」同源；上表「空间层」列<b>不含</b>场景加跑）：基础档 <b>${oddBasic ? oddBasic.totalKm : '—'}km</b>（空间层 ${oddBasic ? Math.round(oddBasic.spatialKm) : '—'}km · ${oddBasic ? oddBasic.roads : '—'} 条 · ${oddBasic ? oddBasic.ci : ''}）→ 标准档 <b>${TOTAL_KM}km</b>（空间层 ${Math.round(ODD_SPATIAL_KM)}km · ${oddStd ? oddStd.roads : '—'} 条 · ${oddStd ? oddStd.ci : ''}，<b>本排班采用</b>）→ 全量穷举 ${EXHAUSTIVE_REF_KM}km 仅参考。两档都是 ${kindCount} 类全覆盖，差别在<b>样本置信精度</b>，故排班取标准档。</p>
    </div>
  </div>
  <p class="note tight"><b>ODD 外（不排班，另行专项）</b>：雨/雾/冰雪等恶劣天气 · 高速主线及匝道 · 收费站/服务区 · 交通管制/事故等特殊事件 · 无名短路段（&lt;300m，仅作连接段顺穿）。<b>覆盖是否完成</b>按第 6 节排班的总出口判据判定（${kindCount} 类工况逐项销项 · 4 时段打卡 · 总里程 ${TOTAL_KM}km ±5%）。</p>
</section>`;

// ---------- block 5 HTML: schedule = one row per (day, street) ----------
// The route cell lists 路线1..N for that day — each with 起点→…→终点, km,
// duration and an independent 高德导航 link. A street spanning several days
// hands out its routes day by day (until the day's km budget is spent) and
// folds the leftover allocation into 时段重跑 with concrete road names.
const routeCursor = new Map(); // street -> next un-run route index
const lastRowByStreet = new Map(); // street -> previous row (for tiny-fragment merge)
const schedRows = [];
dayPlan.forEach((d, di) => {
  d.items.forEach((it) => {
    const r = it.x.r;
    const rt = routeByStreet.get(r.name) || null;
    const list = (rt && rt.routes) || [];
    let idx = routeCursor.get(r.name) || 0;
    let cum = 0;
    const take = [];
    while (idx < list.length) {
      const km = list[idx].distKm;
      if (cum > 0 && cum + km > it.km * 1.25) break; // day budget spent (first route always goes)
      take.push(idx); cum += km; idx++;
    }
    routeCursor.set(r.name, idx);
    const row = {
      day: di + 1, it, rt, r,
      take, runKm: cum, rerunKm: Math.max(it.km - cum, 0),
      remaining: list.length - idx,
    };
    // A tail fragment with no routes and no rerun budget (e.g. 5km/0.2h) says
    // nothing on its own — fold it into the street's previous day as rerun km.
    const prev = lastRowByStreet.get(r.name);
    if (prev && !take.length && row.rerunKm < 8) {
      prev.it.km += it.km; prev.it.hours += it.hours;
      prev.rerunKm += row.rerunKm;
      return;
    }
    lastRowByStreet.set(r.name, row);
    schedRows.push(row);
  });
});
// A street's route set is the plan — if the day budgets ran out before the
// routes did, the leftover routes join the street's last day (an orphaned
// "路线6 留到后续日程" with no后续 would be a broken promise).
for (const [name, row] of lastRowByStreet) {
  const list = (row.rt && row.rt.routes) || [];
  const idx = routeCursor.get(name) || 0;
  if (idx >= list.length) continue;
  for (let i = idx; i < list.length; i++) { row.take.push(i); row.runKm += list[i].distKm; }
  routeCursor.set(name, list.length);
  row.remaining = 0;
  row.rerunKm = Math.max(row.it.km - row.runKm, 0);
  if (row.runKm > row.it.km) row.it.km = row.runKm; // the day drives what the routes say
}

// ---------- §6 per-day exit criteria ----------
// Every day must clear three gates before the next day starts; ② lists only the
// time bands that day actually re-runs (rerunLines only fires when rerunKm ≥ 8).
const BAND_NAMES = ['早高峰', '日间', '晚高峰', '晚间'];
const acceptCell = (row) => {
  const lines = row.rerunKm >= 8 ? rerunLines(row.r, row.rt, row.rerunKm) : [];
  const hit = BAND_NAMES.filter((b) => lines.some((l) => l.includes(b)));
  const bands = ['日间', ...hit.filter((b) => b !== '日间')];
  return `<span class="kv">≥${f1(row.it.km * 0.95)}km</span> ` + bands.map((b) => `<span class="tag g">${b}</span>`).join('');
};

const scheduleSection = `
<section id="s6">
  <h2>6 · 排班表（每天 07:00–23:00 窗口 · 单车${TEST.VEHICLES > 1 ? `×${TEST.VEHICLES}` : ''} ${TEST.HOURS_PER_DAY}h 有效/天 · ${TEST.TOTAL_KM}km ≈ ${dayPlan.length} 天 · 装载率 ${packPct}%）</h2>
  <p class="note">每天 07:00 从<b>德赛西威惠南工业园</b>发车，按 <b>路线1 → 路线2 → …</b> 依次跑：每条路线显示 起点→途经→终点、公里数与预计用时，点「导航↗」在高德地图打开同一路线（不走高速）。路线集（正向）= 骨架锚点串联 + 途经该街道<b>选中的工况道路</b>（承载 22 类城区元素工况，见第 5 节）；跑完当日余量按时段重跑 —— <b>重跑 = 同路线反向再跑 + 场景时段加跑</b>（早高峰学校接送 / 晚高峰拥堵 / 晚间黑暗光照，道路具体到路名）。</p>
  <div class="scrollx">
  <table>
    <thead><tr><th>天</th><th>街道</th><th style="text-align:left">当天路线（每条独立导航）</th><th>当日km</th><th>当日h</th><th style="text-align:left">当天测什么 · 为什么</th><th style="text-align:left">当日出口判据<br><span class="kv" style="font-weight:400">里程 ≥ 计划 × 95% · 轨迹 + 异常事件落盘 · 时段 ↓</span></th></tr></thead>
    <tbody>
    ${schedRows.map((row) => {
      const { day, it, rt, r, take, runKm, rerunKm, remaining } = row;
      const list = (rt && rt.routes) || [];
      const routeCell = list.length
        ? [
          ...take.map((i) => routeHtml(list[i], i)),
          remaining > 0 ? `<span class="muted">（${remaining === 1 ? `路线${routeCursor.get(r.name) + 1}` : `路线${routeCursor.get(r.name) + 1}–${list.length}`} 留到后续日程）</span>` : '',
          rerunKm >= 8 ? `<b>时段重跑 ≈${f1(rerunKm)}km</b>：${rerunLines(r, rt, rerunKm).join('；')}` : '',
        ].filter(Boolean).join('<br>')
        : '按路网整体覆盖行驶（该街道无锚点路线，按道路等级清单顺路覆盖）';
      const tests = !list.length
        ? '常规路网覆盖'
        : take.length ? dayTests(take.map((i) => list[i])) : RERUN_TESTS;
      return `<tr>
        <td>${day}</td>
        <td>${r.name}</td>
        <td style="text-align:left">${routeCell}</td>
        <td>${f1(it.km)}km${runKm > 0 ? `<br><span class="muted">路线${f1(runKm)}km</span>` : ''}${rerunKm >= 8 ? `<br><span class="muted">重跑${f1(rerunKm)}km</span>` : ''}</td>
        <td>${f1(it.hours)}</td>
        <td style="text-align:left"><b>测什么</b>：${tests}<br><b>为什么</b>：${dayFocus(r)}</td>
        <td style="text-align:left">${acceptCell(row)}</td>
      </tr>`;
    }).join('')}
    </tbody>
    <tfoot><tr>
      <td></td><td><b>合计</b></td>
      <td style="text-align:left"><b>${dayPlan.length} 天 · 每天节奏：07:00–09:00 早高峰 / 日间平峰 / 17:00–19:00 晚高峰 / 19:00–23:00 晚间</b><br><span class="muted">装载率 ${packPct}% = ${f1(totHours)}h ÷ ${dayPlan.length} 天 × ${TEST.HOURS_PER_DAY}h；前 ${dayPlan.length - 1} 天跑满 ${TEST.HOURS_PER_DAY}h，末次出车 ${lastDayHours}h / ${lastDayKm}km${tailExtraH > 0 ? `（其中 ${tailExtraH}h 为顺路收尾，不需额外出车）` : ''}</span></td>
      <td><b>${TEST.TOTAL_KM}km</b></td><td><b>${f1(totHours)}h</b></td><td></td>
      <td style="text-align:left"><b>总出口判据</b>：里程 ±5% · 4 时段打卡齐全 · ${kindCount} 类工况逐项销项 · 轨迹 & 异常事件落盘</td>
    </tr></tfoot>
  </table>
  </div>
</section>`;

// ---------- block 7 HTML: per-area static element charts ----------
const elementShareSection = `
<section id="s7">
  <h2>7 · 各区域静态元素分布（每街道一张柱状图 · 24 类静态元素：红绿灯 / 加油站 / 学校 等）</h2>
  <p class="note">横轴 = 24 类静态元素，<b>顺序固定</b>（隧道/桥梁/环岛/铁路道口/…/红绿灯/斑马线/公交站/停车/加油/充电/…/施工/学校/医院/市场），<b>24 个标签每张图都全部显示</b>，便于跨街道对照；柱高 = 该街道此类元素数量，悬停显示数量与占该街道元素总量的比例。收费站/服务区属高速场景，不计入综合分。</p>
  <p class="note tight k"><b>数据来源（逐类标注）</b>：<b style="color:#92400e">高德 POI</b>（${AMAP_ELEMENT_LABELS.join(" / ")}）共 <b>${AMAP_ELEMENT_LABELS.length}</b> 类；<b style="color:#166534">OSM</b> 其余 <b>${ALL_TYPES.length - AMAP_ELEMENT_LABELS.length}</b> 类（路网 / 几何 / 交通标志类只有 OSM 有）。换源由<b>同区域同类别计数比</b>实测决定、<b>逐类判定</b>，不是一刀切。<b>用法</b>：本图只做<b>同类别跨街道</b>比较（如「学校在哪几个街道最密」），不受来源混合影响；<b>跨类别</b>密度对比（如「学校密度 vs 加油站密度」）不作结论。
    ${CONF ? `<details style="margin-top:8px"><summary style="cursor:pointer;color:#2563eb;font-size:12px">▸ <b>24 类元素置信度定级</b>（高 ${CONF.tally.A || 0} · 中 ${(CONF.tally.B || 0) + (CONF.tally.C || 0)} · 低 ${CONF.tally.D || 0}）· 逐类列出判定依据</summary>
      <p class="note tight k" style="margin:8px 0 6px">定级不是主观判断，每条依据都能单独重跑：<b>高</b> = 源为高德 POI 且 typecode 经接口实际响应核对；<b>中</b> = OSM 道路几何（里程已用高德校核，中位 ${OSM_CAL && OSM_CAL.summary ? OSM_CAL.summary.median : "—"}）或点要素坐标全量落在路网上；<b>低</b> = 与独立源同口径对比 &lt;50%，或无独立源可交叉验证 —— 这类计数<b>只能当下界</b>。</p>
      <div class="scrollx"><table>
        <thead><tr><th style="text-align:left">元素类</th><th style="text-align:left">数据源</th><th>全区计数</th><th>置信度</th><th style="text-align:left">判定依据</th></tr></thead>
        <tbody>
        ${CONF.rows.map((r) => `<tr>
          <td style="text-align:left">${r.label}</td>
          <td style="text-align:left"><span class="muted">${r.source}</span></td>
          <td>${r.count ?? "—"}</td>
          <td><span class="cf ${r.level.toLowerCase()}">${r.levelLabel}</span></td>
          <td style="text-align:left"><span class="muted">${r.basis}</span></td>
        </tr>`).join("")}
        </tbody>
      </table></div>
    </details>` : ""}
    <details style="margin-top:6px"><summary style="cursor:pointer;color:#2563eb;font-size:12px">▸ 逐类计数比（OSM ÷ 高德）· 换源结果 · 市场口径对齐</summary>
      <p class="note tight k" style="margin:8px 0 0">计数比 ${SOURCE_CK ? SOURCE_CK.rows.map((r) => `${r.label} <b>${r.ratio}%</b>`).join(' · ') : '—'} —— OSM 在设施类严重漏标（充电站仅 <b>1%</b>、市场 <b>2%</b>、停车场 <b>21%</b>），故改用高德；但 <b>公交站 OSM 是高德的 ${CK_BUS}%</b>，该类<b>保留 OSM</b>。「市场」口径已对齐为两侧都只算综合 / 农贸<b>实体市场</b>（OSM 原文件混入便利店 / 菜店，非同一实体，已按 <code>amenity=marketplace</code> 重取）。完整对照表见第 8 节「实测依据」。</p>
    </details>
  </p>
  <p class="note tight k"><b>可信度标注（灰柱 = 低样本类）</b>：全区总量 &lt; ${LOW_SAMPLE_MAX} 类的元素 —— <b>${LOW_LABELS.join(' · ')}</b> —— 单街道计数只有个位数，<b>街道间比较没有统计意义</b>，图中统一以<b style="color:#6b7280">灰柱</b>标出。灰色柱只表示「此数不可用于排名」，不代表该元素不重要（如消防站全区仅 3 个，却是穷举类必测项）。非灰柱类的街道间对比相对可靠。</p>
  <div class="charts-grid">
  ${streetCharts.map((s) => `
    <div class="mini">
      <h4>${s.name}<span class="muted"> · ${s.total} 个</span>${s.lowCount ? `<span class="kv"> · 灰柱 ${s.lowCount} 类低样本</span>` : ''}</h4>
      <div class="chart"><canvas id="${s.id}"></canvas></div>
    </div>`).join('')}
  </div>
</section>`;

// ---------- block 8 HTML: risks & limitations ----------
const calValid = OSM_CAL ? OSM_CAL.samples.filter((s) => s.valid) : [];
const calN = OSM_CAL ? OSM_CAL.samples.length : 0;
const calSum = OSM_CAL && OSM_CAL.summary ? OSM_CAL.summary : null;
const minDays = +(totHours / TEST.HOURS_PER_DAY).toFixed(1);
const riskSection = `
<section id="s8">
  <h2>8 · 口径边界与数据局限（使用前必读）</h2>
  <p class="note">以下 3 条由数据源与建模方式决定，<b>不可通过再加工消除</b>，读结论前须知；每条所依据的实测数据收在节末「实测依据」折叠区。</p>
  <ol class="risk">
        <li><span class="lv mid">中</span><b>拥堵只有实时快照，「分时段」是实测 + 参考推断拼合出来的</b>：高德 <code>v3/traffic/status</code> 无时间参数、无历史查询。当前 <b>${CORE_BANDS.length} 个核心区实测档</b>（${CORE_BANDS.join(' / ')}，共 ${congestion ? congestion.effectiveSamples : '—'} 次样本）＋ <b>${INFERRED_HOURS_N || 17} 个参考推断档</b>（公开逐小时曲线迁形 × 本地实测标定，残差 RMSE ${CONG_REF ? CONG_REF.calibration.rmse : '—'}km/h）拼成 24 小时。曲线与表<b>逐格标注来源，推断值不当实测用</b>，也不参与第 3 节排名。另有 <b>${EXCLUDED_BANDS.length} 个全区 18 街道档</b>实测有效、但路网构成不同（含大量乡道 / 县道），<b>不并入曲线</b>（否则「路网差异」会冒充「时间差异」，残差 0.73 → 2.24km/h），单列于第 2 节末。→ <b>残余风险在「形状」而非「量级」</b>：量级已由本地实测锁定；若惠城高峰偏移与全市口径不同则推断档会偏，彻底消除需高德<b>商务版历史接口</b>（通路保留在 <code>fetch_congestion_history.js</code>）。
      <details style="margin-top:6px"><summary style="cursor:pointer;color:#2563eb;font-size:12px">▸ 展开 ${CONG_REF ? CONG_REF.sources.length : 0} 条公开参考来源（用于「形状」迁移与量级互校）</summary>
      <div class="scrollx" style="margin-top:8px"><table>
        <thead><tr><th style="text-align:left">来源</th><th>时点</th><th style="text-align:left">关键数值 · 本报告用途</th></tr></thead>
        <tbody>
        ${CONG_REF ? CONG_REF.sources.map((s) => `<tr>
          <td style="text-align:left"><a href="${s.url}" target="_blank" rel="noopener">${s.what}</a><br><span class="kv">${s.publisher}</span></td>
          <td>${s.date}</td>
          <td style="text-align:left">${s.figures}<br><span class="kv">用途：${s.used}</span></td>
        </tr>`).join('') : ''}
        </tbody>
      </table></div>
      </details>
    </li>
    <li><span class="lv low">低</span><b>均速与折减是建模取值，已用实测做包络校验</b>：巡航 <b>30km/h</b>、上限 <b>45km/h</b> 用于把里程折算成工时与天数，非实测单车速度。实测里程加权均速：晚高峰 <b>${bandKmh(['18:00']) ?? '—'}km/h</b>、夜间 <b>${bandKmh(['00:00', '01:00', '02:00']) ?? '—'}km/h</b>（折减比 ${congestion && congestion.speedCalib ? congestion.speedCalib.observedRatio : '—'}）。高峰取值 30 × ${TEST.PEAK_FACTOR} = <b>${30 * TEST.PEAK_FACTOR}km/h</b> <b>低于</b>实测，45km/h 与实测夜间同量级 —— 落在实测包络内且<b>偏保守</b>。<b>残余</b>：早 / 日间档为推断；灵敏度（±10%）约 <b>${f1(minDays * 0.9)}–${f1(minDays * 1.1)} 天</b>。</li>
    <li><span class="lv low">低</span><b>元素是混源：路网 / 拓扑类只能来自 OSM，设施类来自高德</b>：<b>${ALL_TYPES.length - AMAP_ELEMENT_LABELS.length} 类</b>取自 OpenStreetMap 2026-09-22 快照（道路等级与几何、隧道 / 桥梁 / 环岛 / 铁路道口 / 红绿灯 / 斑马线 / 公交站 / 施工…），<b>${AMAP_ELEMENT_LABELS.length} 类设施</b>取自高德 POI（${AMAP_ELEMENT_LABELS.join(" / ")}）。依据是同区域同口径实测比值（见节末「实测依据」）：OSM 在设施类漏标 ${CK_MISS_LO}%~${CK_MISS_HI}% 故换源，而<b>公交站 OSM 是高德的 ${CK_BUS}%</b> 故保留 OSM —— <b>换源逐类判定</b>。第 7 节密度与第 5 节覆盖率<b>只做同类别跨街道比较</b>。
    <details style="margin-top:6px"><summary style="cursor:pointer;color:#2563eb;font-size:12px">▸ 本轮对 OSM 侧数据的三项实证修正（置信度审计发现）</summary>
      <div class="scrollx" style="margin-top:8px"><table>
        <thead><tr><th style="text-align:left">元素类</th><th style="text-align:left">问题</th><th style="text-align:left">实证</th><th>处置</th></tr></thead>
        <tbody>
        <tr><td style="text-align:left">铁路道口</td><td style="text-align:left">同一处被标成多个节点</td><td style="text-align:left"><span class="muted">129 个点最近邻间距中位 5.2m、86% 相隔 &lt;50m（out/railway_audit.json）；原小金口一街道即 116 个</span></td><td>按 50m 聚类合并，全区 125 → <b>31</b></td></tr>
        <tr><td style="text-align:left">人行横道</td><td style="text-align:left">查询写法漏标</td><td style="text-align:left"><span class="muted">原只查带 crossing 子标签的节点；改查 highway=crossing 后 256 → 285（probe_gaps.js，数据时间 2026-09-28）</span></td><td>改用完整写法，区内 227 → <b>254</b></td></tr>
        <tr><td style="text-align:left">消防站 / 派出所</td><td style="text-align:left">OSM 数据严重不全</td><td style="text-align:left"><span class="muted">OSM 即便补上 node 形式仍仅 5 / 14 个；高德同口径全区 80 / 182 个（区内 33 / 82）</span></td><td>整类切高德（130504 / 130501）</td></tr>
        </tbody>
      </table></div>
    </details>
    逐类置信度（高 ${CONF ? CONF.tally.A || 0 : "—"} · 中 ${CONF ? (CONF.tally.B || 0) + (CONF.tally.C || 0) : "—"} · 低 ${CONF ? CONF.tally.D || 0 : "—"}）与判定依据见第 7 节「24 类元素置信度定级」。
</li>
  </ol>

  <h3>实测依据</h3>
  ${SOURCE_CK ? `<details style="margin-top:10px"><summary style="cursor:pointer;color:#2563eb;font-size:12px">▸ OSM ÷ 高德 同口径计数比（设施类换源依据）</summary>
    <div class="scrollx" style="margin-top:8px"><table>
      <thead><tr><th style="text-align:left">元素类</th><th>OSM</th><th>高德 POI</th><th>OSM/高德</th><th style="text-align:left">口径</th></tr></thead>
      <tbody>
      ${SOURCE_CK.rows.map((r) => `<tr>
        <td style="text-align:left">${r.label}</td><td>${r.osmCount}</td><td>${r.amapCount ?? '—'}</td>
        <td><b>${r.ratio}%</b></td><td style="text-align:left"><span class="muted">${r.osmLabel} ↔ ${r.amapLabel} · ${r.caveat}</span></td>
      </tr>`).join('')}
      </tbody>
      <tfoot><tr><td colspan="5" style="text-align:left" class="muted">同一行政区（${SOURCE_CK.area}）内、同一类别口径的计数对比。OSM 偏低 = 众包标注不全（说明基准差异，不代表高德全对）；<b>公交站一行为反例</b>（OSM &gt; 高德），报告据此保留 OSM 源。</td></tr></tfoot>
    </table></div>
  </details>` : ''}
  <details style="margin-top:10px"><summary style="cursor:pointer;color:#2563eb;font-size:12px">▸ ${calN} 条里程校核抽样明细（<code>out/osm_calibration.json</code>）</summary>
    <div class="scrollx" style="margin-top:8px"><table>
      <thead><tr><th style="text-align:left">道路</th><th>等级</th><th>OSM km</th><th>高德同名 km</th><th>匹配结果</th></tr></thead>
      <tbody>
      ${OSM_CAL.samples.map((s) => `<tr>
        <td style="text-align:left">${s.name}</td><td>${s.cls}</td><td>${s.osmKm}</td><td>${s.amapKm ?? '—'}</td>
        <td>${s.valid ? `✓ 同名匹配 ${Math.min(100, Math.round(s.onFrac * 100))}%` : `<span style="color:#b45309">✗ ${s.onFrac === undefined ? 'API 失败' : '同名占比过低 / 高德绕路'}（${s.roads || '无对应道路'}）</span>`}</td>
      </tr>`).join('')}
      </tbody>
      <tfoot><tr><td colspan="4" style="text-align:right">同名匹配样本的里程比 中位 / 四分位</td><td><b>${calSum ? `${calSum.median} / ${calSum.p25}–${calSum.p75}` : '—'}</b></td></tr></tfoot>
    </table></div>
    <p class="note tight k" style="margin:8px 0 0">被弃用的样本分两类，都不是里程偏差：<b>命名口径差异</b>（高德把 OSM 的「仍泰路」并入 <code>199县道/仍泰公路</code>，或对应名为空）与 <b>高德绕路</b>（同名占比 &lt;45%，说明导航没走这条路）。匹配成功样本的比值集中在 1 附近。</p>
  </details>
</section>`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>惠城区智驾路测 · 元素分布与资源分配报告</title>
<script>${chartJs}</script>
<style>
  :root { --ink:#1a1d21; --muted:#6b7280; --line:#e5e7eb; }
  * { box-sizing:border-box; }
  body { font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif; margin:0;
         padding:32px 28px 60px; background:#f7f8fa; color:var(--ink); }
  h1 { font-size:22px; margin:0 0 4px; }
  .sub { color:var(--muted); font-size:13px; margin-bottom:24px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:28px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  /* 家底口径（全区路网）与排班口径视觉分离：灰底 + 虚线边 = 「参考量，不排班」 */
  .card.ref { background:#f8fafc; border-style:dashed; border-color:#cbd5e1; }
  .card.ref .v { color:#475569; }
  .card .k { font-size:12px; color:var(--muted); }
  .card .v { font-size:22px; font-weight:600; margin-top:4px; }
  .card .u { font-size:12px; color:var(--muted); font-weight:400; margin-left:3px; }
  section { background:#fff; border:1px solid var(--line); border-radius:10px; padding:18px 20px 8px; margin-bottom:22px; }
  h2 { font-size:15px; margin:0 0 2px; }
  h3 { font-size:13px; margin:14px 0 2px; }
  .note { font-size:12px; color:var(--muted); margin:0 0 14px; line-height:1.7; }
  .note.tight { margin:0 0 8px; }
  .muted { color:var(--muted); }
  .wrap { position:relative; height:340px; }
  .wrap.tall { height:420px; }
  table { width:100%; border-collapse:collapse; font-size:13px; margin-top:6px; }
  th,td { padding:7px 9px; text-align:right; border-bottom:1px solid #f0f1f3; }
  th:first-child,td:first-child { text-align:left; }
  th { background:#fafbfc; color:var(--muted); font-weight:500; font-size:12px; }
  .hi { background:#eff6ff; }
  .scrollx { overflow-x:auto; }
  a { color:#2563eb; }
  code { background:#f3f4f6; padding:1px 5px; border-radius:4px; font-size:12px; }
  /* 口径块 / 步骤条 / 徽章 / 覆盖条 / 风险条 */
  .note.k { background:#f8fafc; border-left:3px solid #cbd5e1; padding:7px 10px; border-radius:0 6px 6px 0; }
  .steps { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0 2px; font-size:12px; }
  .steps span { background:#eff6ff; color:#1d4ed8; border:1px solid #dbeafe; border-radius:999px; padding:3px 10px; }
  .tag { display:inline-block; background:#eff6ff; color:#1d4ed8; border:1px solid #dbeafe; border-radius:6px;
         padding:1px 7px; font-size:11px; white-space:nowrap; margin:1px 3px 1px 0; }
  .tag i { font-style:normal; color:#64748b; margin-left:5px; }
  .tag.g { background:#f0fdf4; color:#15803d; border-color:#dcfce7; }
  .tag.m { background:#f3f4f6; color:#6b7280; border-color:#e5e7eb; }
  .kv { font-size:11px; color:var(--muted); }
  ul.tight { margin:4px 0 10px; padding-left:18px; font-size:12px; color:var(--muted); line-height:1.8; }
  ul.tight b { color:var(--ink); }
  .cov { display:flex; gap:2px; margin:8px 0 12px; overflow-x:auto; padding-bottom:2px; }
  .cov .h { flex:1 0 20px; text-align:center; font-size:9px; color:var(--muted); }
  .cov .bar { height:44px; display:flex; flex-direction:column; justify-content:flex-end;
              border:1px solid var(--line); border-radius:2px; background:#fbfcfd; overflow:hidden; }
  .cov .bar i { display:block; background:#0d9488; }
  .cov .h.void .bar { border-style:dashed; background:#fff; }
  .cov .h .lb { color:#b91c1c; }
  .risk { font-size:12px; line-height:1.85; margin:0 0 10px; padding-left:18px; color:var(--ink); }
  .risk li { margin-bottom:7px; }
  .risk .lv { display:inline-block; font-size:11px; border-radius:4px; padding:0 6px; margin-right:6px;
              background:#fef2f2; color:#b91c1c; border:1px solid #fecaca; white-space:nowrap; }
  .risk .lv.mid { background:#fffbeb; color:#b45309; border-color:#fde68a; }
  .risk .lv.low { background:#f0fdf4; color:#15803d; border-color:#dcfce7; }
.cf { display:inline-block; font-size:11px; border-radius:4px; padding:0 6px; margin-right:6px; border:1px solid; }
.cf.a { background:#f0fdf4; color:#15803d; border-color:#dcfce7; }
.cf.b { background:#eff6ff; color:#1d4ed8; border-color:#bfdbfe; }
.cf.c { background:#fffbeb; color:#b45309; border-color:#fde68a; }
.cf.d { background:#fef2f2; color:#b91c1c; border-color:#fecaca; }
  .scen { display:grid; grid-template-columns:300px minmax(0,1fr); gap:16px; align-items:start;
          padding:14px 0; border-top:1px dashed var(--line); }
  .scen:first-of-type { border-top:0; padding-top:4px; }
  .scen h3 { margin:0 0 2px; }
  .scen .chart { position:relative; }
  .scen .route { font-size:12px; background:#f8fafc; border:1px solid var(--line); border-radius:8px;
                 padding:8px 10px; margin:8px 0 0; line-height:1.8; }
  @media (max-width:900px) { .scen { grid-template-columns:1fr; } }
  .charts-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(360px,1fr)); gap:14px; padding-bottom:14px; }
  .mini { border:1px solid var(--line); border-radius:8px; padding:10px 12px 0; background:#fbfcfd; }
  .mini h4 { margin:0 0 6px; font-size:13px; }
  .mini .chart { position:relative; height:230px; }
  nav.topnav { display:flex; flex-wrap:wrap; gap:4px 16px; position:sticky; top:0; z-index:9;
               background:rgba(255,255,255,.97); border:1px solid var(--line); border-radius:8px;
               padding:8px 14px; margin:0 0 22px; font-size:12px; }
  nav.topnav a { color:#2563eb; text-decoration:none; white-space:nowrap; }
  footer { margin-top:6px; padding:14px 2px 0; border-top:1px solid var(--line);
           color:var(--muted); font-size:11px; line-height:1.9; }
  @media print {
    body { background:#fff; padding:0; }
    nav.topnav { display:none; }
    .scen, .mini, .wrap, tr { break-inside:avoid; }
    .scrollx { overflow:visible; }
    section { border-color:#bbb; }
  }
</style>
</head>
<body>
<h1>惠城区智驾路测 · 元素分布与资源分配报告</h1>
<div class="sub">数据源 OpenStreetMap（2026-09-22 快照）+ 高德POI一次性抓取（2026-09-22 · 加油/充电/停车/收费站/服务区）+ 高德拥堵采样 · 路网里程为 OSM 中心线口径（分离式双向车道只计一条，全区双向行驶口径 ${NET_BIDIR_KM}km 见里程需求表），同名道路里程比中位 <b>${calSum ? calSum.median : '—'}</b>（高德同路实测校核）· 聚合单位：街道/镇 · 密度 = 元素数 / 非高速道路公里 · 报告结构：道路等级 → 拥堵态势 → 场景推荐 → 综合优先级 → 里程需求（ODD 推导）→ 排班（含具体路线）→ 静态元素分布 → 口径边界</div>

<nav class="topnav">
  <a href="#s1">1 道路等级</a><a href="#s2">2 拥堵态势</a><a href="#s3">3 场景推荐</a><a href="#s4">4 优先级</a><a href="#s5">5 里程需求/ODD</a><a href="#s6">6 排班表</a><a href="#s7">7 元素分布</a><a href="#s8">8 口径边界</a>
</nav>

<div class="cards">
  <div class="card ref"><div class="k">全区路网 · 双向行驶（上限）</div><div class="v">${NET_BIDIR_KM}<span class="u">km</span></div></div>
  <div class="card ref"><div class="k">全区路网 · 中心线</div><div class="v">${NET_CENTER_KM}<span class="u">km</span></div></div>
  <div class="card"><div class="k">全工况测试里程（双向）</div><div class="v">${TOTAL_KM}<span class="u">km ≈ ${dayPlan.length} 天</span></div></div>
  <div class="card"><div class="k">高速里程（参考）</div><div class="v">${NET_MOTORWAY_KM}<span class="u">km</span></div></div>
  <div class="card"><div class="k">街道/镇</div><div class="v">${rows.length}<span class="u">个</span></div></div>
  <div class="card"><div class="k">元素总量</div><div class="v">${ALL_TYPES.reduce((s, t) => s + totals[t.key], 0)}<span class="u">个 · ${ALL_TYPES.length} 类</span></div></div>
  ${oddStd ? `<div class="card"><div class="k">选中工况道路</div><div class="v">${oddStd.roads}<span class="u">条 · ${f1(oddStd.selCenterKm)}km</span></div></div>
  <div class="card"><div class="k">元素工况达标</div><div class="v">${kindRows.length}/${kindRows.length}<span class="u">类 · 穷举${exhaustKinds.length}+统计${sampleKinds.length}</span></div></div>` : ''}
</div>
<p class="note tight k"><b>整个惠城区有多少路（路网家底，不排班）</b>：非高速网中心线 <b>${NET_CENTER_KM}km</b>
  （每条道路只计一次）；按双向行驶折算的上限 <b>${NET_BIDIR_KM}km</b>
  （同一批道路的单向路段按两个方向算，含无名路段 ${NET_UNNAMED_KM}km／双向 ${NET_BIDIR_UNNAMED_KM}km）；高速 ${NET_MOTORWAY_KM}km 仅参考。
  <b>这四个数不缩水也互不矛盾 —— 它们是四个不同问题的答案：</b>
  <b>① ${NET_CENTER_KM}km</b> = 路网去重长度 · <b>② ${NET_BIDIR_KM}km</b> = 全部跑一遍（双向）的路网上限 ·
  <b>③ 全量穷举 ${EXHAUSTIVE_REF_KM}km</b> = 只跑 ${oddSel ? oddSel.candRoads : '—'} 条候选命名道路全跑（2×${EXHAUST_ROUTE_KM}km + 场景加跑 ${ODD_SCENARIO_KM}km）·
  <b>④ 本排班 ${TOTAL_KM}km</b> = 从候选里挑 ${oddStd ? oddStd.roads : '—'} 条即承载全部 ${kindRows.length} 类工况，省 ${savePct}%。
  即 <b>① ⊂ ②</b> 且 <b>④ ⊂ ③ ⊂ ②</b>：<b>①②</b> 是<b>路网家底</b>（描述全区有多少路可跑，不排班），<b>③</b> 是<b>全量穷举对照</b>，<b>④</b> 才是<b>本排班</b> —— 四个口径里唯一需要出车的。
  本排班只跑 ${TOTAL_KM}km 不是「漏了 ${f1(NET_BIDIR_KM - TOTAL_KM)}km」，而是 ODD 的设计选择 —— <b>挑有价值的工况覆盖，不是把全区每条路跑一遍</b>。</p>

${roadClassSection}

${congestionSection}

${scenarioSection}

${prioritySection}

${oddSection}

${scheduleSection}

${elementShareSection}

${riskSection}

<footer id="evid">
  报告版本 <b>${REPORT_VERSION}</b> · 生成 ${new Date().toLocaleString('zh-CN', { hour12: false })} · 生成器 <code>build_report_draft.js</code>（本页由脚本直出，版式为唯一事实来源）<br>
  ${REPORT_CHANGELOG.map((c) => '· ' + c).join('<br>')}<br>
  数据源：OpenStreetMap 2026-09-22 快照 · 高德 POI 2026-09-22（设施类 ${AMAP_ELEMENT_LABELS.length} 类：${AMAP_ELEMENT_LABELS.join(" / ")}）· 高德拥堵实时采样 ${congestion && congestion.samples > 0 ? congestion.samples + ' 次' : '待采样'}${CONG_REF ? ` + 公开逐小时拥堵延时指数曲线（补 ${CONG_REF.hours.filter((x) => x.mode === 'inferred').length} 个推断小时档）` : ''} · 工况选择 out/odd_selection.json（select_odd.js 四层模型）<br>
  里程校核：${calSum ? `同名道路里程比中位 ${calSum.median}（有效 ${calSum.n}/${calSum.tried} 条）` : '见 out/osm_calibration.json'} · 分时段均速：实测 ${congestion ? congestion.speedCalib.byBand.length : 0} 档 + 参考推断 ${CONG_REF ? CONG_REF.hours.filter((x) => x.mode === 'inferred').length : 0} 档（out/congestion_ref.json）
</footer>

<script>
const streetNames = ${JSON.stringify(rows.map((r) => r.name))};
const classStack = ${JSON.stringify(classStack)};
const motorwayVals = ${JSON.stringify(motorwayVals)};
const scenarioCharts = ${JSON.stringify(scenarioCharts)};
const pie = ${JSON.stringify(pieData)};
const streetCharts = ${JSON.stringify(streetCharts)};
const oddRatio = ${JSON.stringify(oddRatioChart)};
const oddCurve = ${JSON.stringify(oddCurveChart)};
const oddClass = ${JSON.stringify(oddClassChart)};
const congRef = ${JSON.stringify(CONG_REF ? {
  labels: CONG_REF.hours.map((x) => x.hour),
  kmh: CONG_REF.hours.map((x) => x.kmh),
  modes: CONG_REF.hours.map((x) => x.mode === 'measured' ? '实测' : '参考推断'),
  colors: CONG_REF.hours.map((x) => (x.mode === 'measured' ? '#0d9488' : '#cbd5e1')),
} : null)};
const FONT = { family: '"Microsoft YaHei","PingFang SC",sans-serif', size: 12 };
const GRID = { color: '#eef0f2' };
const BASE = { responsive:true, maintainAspectRatio:false, animation:false, plugins:{ legend:{ labels:{ font:FONT } } },
  scales:{ x:{ ticks:{ font:FONT }, grid:{ display:false } }, y:{ ticks:{ font:FONT }, grid:GRID, beginAtZero:true } } };

new Chart(document.getElementById('c7'), {
  type:'bar',
  data:{ labels: streetNames,
    datasets:[
      ...classStack.map(c=>({ label:c.label, data:c.vals, backgroundColor:c.color, borderRadius:2, stack:'s' })),
      { label:'高速（参考，不计分母）', data: motorwayVals, backgroundColor:'#d1d5db', borderRadius:2, stack:'m' }
    ] },
  options:{ ...BASE, plugins:{ legend:{ position:'bottom', labels:{ font:{ ...FONT, size:10 }, boxWidth:10, padding:6 } } },
    scales:{ ...BASE.scales,
      x:{ ...BASE.scales.x, stacked:true, ticks:{ ...BASE.scales.x.ticks, maxRotation:60, minRotation:45 } },
      y:{ ...BASE.scales.y, stacked:true, title:{ display:true, text:'公里', font:FONT } } } }
});

scenarioCharts.forEach((s) => {
  const el = document.getElementById(s.id);
  if (!el) return;
  new Chart(el, {
    type:'bar',
    data:{ labels:s.labels, datasets:[{ data:s.data, backgroundColor:s.color, borderRadius:3 }] },
    options:{ ...BASE, indexAxis:'y',
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:(c)=>' ' + c.parsed.x + ' ' + s.unit } } },
      scales:{ x:{ ...BASE.scales.y, title:{ display:true, text:s.unit, font:FONT } },
               y:{ ...BASE.scales.x } } }
  });
});

if (congRef && document.getElementById('cS2speed')) new Chart(document.getElementById('cS2speed'), {
  type:'bar',
  data:{ labels: congRef.labels, datasets:[{ data: congRef.kmh, backgroundColor: congRef.colors, borderRadius:3 }] },
  options:{ ...BASE, plugins:{ legend:{display:false},
    tooltip:{ callbacks:{ label:(c)=>' ' + c.parsed.y + ' km/h · ' + congRef.modes[c.dataIndex] } } },
    scales:{ x:{ ...BASE.scales.x, ticks:{ ...BASE.scales.x.ticks, font:{ ...FONT, size:9 } } },
      y:{ ...BASE.scales.y, title:{ display:true, text:'km/h', font:FONT } } } }
});
new Chart(document.getElementById('pie'), {
  type:'doughnut',
  data:{ labels: pie.labels, datasets:[{ data: pie.data, backgroundColor: pie.colors, borderWidth:1, borderColor:'#fff' }] },
  options:{ responsive:true, maintainAspectRatio:false,
    plugins:{ legend:{ position:'right', labels:{ font:{ ...FONT, size:11 }, boxWidth:12, padding:6 } },
      tooltip:{ callbacks:{ label:(c)=>' ' + c.parsed + ' 分（' + pie.shares[c.dataIndex] + '%）' } } } }
});

streetCharts.forEach((s) => {
  const el = document.getElementById(s.id);
  if (!el) return;
  new Chart(el, {
    type:'bar',
    data:{ labels:s.labels, datasets:[{ data:s.counts, backgroundColor:s.colors.map((c,i)=> (s.scarce && s.scarce[i]) ? '#d1d5db' : c), borderRadius:2 }] },
    options:{ ...BASE, plugins:{ legend:{display:false},
      tooltip:{ callbacks:{ label:(c)=>{ const t = s.total || 0;
        const pct = t ? (c.parsed.y / t * 100).toFixed(1) : 0;
        return ' ' + c.parsed.y + ' 个（' + pct + '%）'; } } } },
      scales:{ x:{ ...BASE.scales.x, ticks:{ ...BASE.scales.x.ticks, font:{ ...FONT, size:8 }, autoSkip:false, maxRotation:90, minRotation:60 } },
        y:{ ...BASE.scales.y, title:{ display:true, text:'元素数', font:FONT } } } }
  });
});

if (oddRatio && document.getElementById('cOddRatio')) new Chart(document.getElementById('cOddRatio'), {
  type:'bar',
  data:{ labels: oddRatio.labels, datasets:[{ data: oddRatio.pct,
    backgroundColor:['#f59e0b','#059669','#2563eb'], borderRadius:3, barPercentage:0.55 }] },
  options:{ ...BASE, indexAxis:'y',
    plugins:{ legend:{display:false},
      tooltip:{ callbacks:{ label:(c)=>' ' + c.parsed.x + '%（' + (c.dataIndex === 0
        ? '选中 ' + oddRatio.selKm + ' / 候选 ' + oddRatio.candKm + ' km' : '22/22 类 · 7/7 级') + '）' } } },
    scales:{ x:{ ...BASE.scales.y, max:100, title:{ display:true, text:'百分比 %', font:FONT } }, y:{ ...BASE.scales.x } } }
});

if (oddCurve && document.getElementById('cOddCurve')) new Chart(document.getElementById('cOddCurve'), {
  type:'line',
  data:{ labels: oddCurve.labels, datasets:[{ data: oddCurve.kinds,
    borderColor:'#dc2626', backgroundColor:'#dc2626',
    pointRadius:5, pointHoverRadius:7, borderDash:[6,4], tension:0, spanGaps:true }] },
  options:{ ...BASE,
    plugins:{ legend:{display:false},
      tooltip:{ callbacks:{ label:(c)=>' 已覆盖 ' + c.parsed.y + ' / ' + oddCurve.max + ' 类'
        + (c.dataIndex === 1 ? '（±10% · n≥' + oddCurve.nBasic + '）' : (c.dataIndex === 2 ? '（±5% · n≥' + oddCurve.nStd + ' · 本排班）' : (c.dataIndex === 3 ? '（参考，覆盖不再增加）' : ''))) } } },
    scales:{ x:{ ...BASE.scales.x }, y:{ ...BASE.scales.y, max:24,
      title:{ display:true, text:'已覆盖工况类数（22 封顶）', font:FONT } } } }
});

if (oddClass && document.getElementById('cOddClass')) new Chart(document.getElementById('cOddClass'), {
  type:'bar',
  data:{ labels: oddClass.labels, datasets:[
    { label:'候选 km', data: oddClass.cand, backgroundColor:'#d1d5db', borderRadius:2 },
    { label:'保底 km', data: oddClass.floor, backgroundColor:'#fbbf24', borderRadius:2 },
    { label:'选中 km', data: oddClass.sel, backgroundColor:'#059669', borderRadius:2 } ] },
  options:{ ...BASE, indexAxis:'y',
    plugins:{ legend:{ position:'bottom', labels:{ font:{ ...FONT, size:10 }, boxWidth:10, padding:6 } } },
    scales:{ x:{ ...BASE.scales.y, title:{ display:true, text:'公里', font:FONT } }, y:{ ...BASE.scales.x } } }
});
</script>
</body>
</html>`;

if (process.env.ODD_ALLOC_ONLY === '1') {
  console.log('report_alloc.json updated; report_draft.html generation skipped (ODD_ALLOC_ONLY=1)');
  process.exit(0);
}
fs.writeFileSync(path.join(__dirname, 'out/report_draft.html'), html);
console.log('wrote out/report_draft.html (' + Math.round(html.length / 1024) + ' KB, Chart.js inlined)');

console.log('\nTop 6 by test priority:');
scored.slice(0, 6).forEach((r, i) =>
  console.log(`  ${i + 1}. ${r.name.padEnd(8)} 分=${String(r.score).padStart(5)}  灯/km=${r.signalsPerKm}  隧/km=${r.tunnelsPerKm}`));
console.log('\nCongestion:', congestion && congestion.samples > 0 ? `${congestion.samples} samples, bands: ${congestion.bandsCovered.join(', ')}` : 'no samples yet');
console.log(`\nSchedule: ${TEST.TOTAL_KM} km / ${f1(totHours)} h / ${dayPlan.length} days · ${routeByStreet.size} streets with route sets + ${scenarioRouteBy.size} scenario routes`);
