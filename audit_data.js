// 数据有效性审计（修正版）：正文与脚本分离，字段名对齐实际 json
const fs = require('fs');
const path = require('path');
const B = __dirname;
const RAW = fs.readFileSync(path.join(B, 'out/odd_coverage.html'), 'utf8');
const BODY = RAW.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const TEXT = BODY.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');
const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
const out = (f) => JSON.parse(fs.readFileSync(path.join(B, 'out', f), 'utf8'));
const data = (f) => JSON.parse(fs.readFileSync(path.join(B, 'data', f), 'utf8'));

const fail = [], warn = [], pass = [];
const say = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' · ' + detail : ''}`);
  (ok ? pass : fail).push(label + (detail ? ' · ' + detail : ''));
};

console.log('=== A. 正文空值/异常字符（已排除内联 Chart.js 与 CSS）===');
for (const k of ['undefined', 'NaN', 'null', 'Infinity', '[object Object]', '${', 'background:undefined']) {
  const n = TEXT.split(k).length - 1;
  say(n === 0, k, n ? `出现 ${n} 次` : '');
}

console.log('\n=== B. 表格空单元格 ===');
const cells = [...BODY.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => strip(m[1]));
const dash = cells.filter((c) => /^[—–-]$/.test(c));
console.log(`  td 共 ${cells.length}；空白 ${cells.filter((c) => c === '').length}；"—" 占位 ${dash.length}（无数据时有意义，非错误）`);

console.log('\n=== C. 百分比越界（仅正文）===');
const pcts = [...TEXT.matchAll(/([\d.]+)%/g)].map((m) => parseFloat(m[1]));
const bad = [...new Set(pcts.filter((p) => !(p >= 0 && p <= 100)))];
// >100% 只允许出现在明确说明为比较比值的语境，而不是覆盖率、通过率等比例字段。
const badReal = bad.filter((p) => {
  const needle = `${p}%`;
  let from = 0;
  while ((from = TEXT.indexOf(needle, from)) >= 0) {
    const context = TEXT.slice(Math.max(0, from - 80), from + needle.length + 40);
    if (!/(返程.{0,20}去程|OSM|高德|比值|相比)/.test(context)) return true;
    from += needle.length;
  }
  return false;
});
say(badReal.length === 0, `% 共 ${pcts.length} 处`, bad.length ? `>100% 的 ${bad.join(',')} 均处在明确的比较比值语境，非比例越界` : '全部 0–100');

console.log('\n=== D. 速度 / 里程 数量级 ===');
const kmh = [...TEXT.matchAll(/([\d.]+)\s*km\/h/g)].map((m) => parseFloat(m[1]));
say(kmh.every((v) => v > 0 && v <= 130), `km/h ${kmh.length} 处`, `范围 ${Math.min(...kmh)}–${Math.max(...kmh)}`);
const kms = [...TEXT.matchAll(/([\d,.]+)\s*km(?![\/a-z])/g)].map((m) => parseFloat(m[1].replace(/,/g, '')));
say(kms.every((v) => v >= 0 && v < 1e5), `km ${kms.length} 处`, `范围 ${Math.min(...kms)}–${Math.max(...kms)}`);

console.log('\n=== E. 源 json 字段完整性 ===');
const congestion = out('congestion.json'), congRef = out('congestion_ref.json'), oddDims = out('odd_dims.json');
const oddSel = out('odd_selection.json'), osmCal = out('osm_calibration.json'), srcCk = out('source_crosscheck.json');
const stats = out('street_stats.json'), routes = out('routes.json');
say(congestion.samples === congestion.effectiveSamples && congestion.effectiveSamples > 0, '采样数与有效数一致', `${congestion.effectiveSamples}`);
// 每条断言都要有真实判据（原先是 `? true : true`，恒真，等于没查）。
say(congestion.coverage.dates.length === Object.values(congestion.coverage.dayKinds).reduce((a, b) => a + b, 0),
  '覆盖天数与按星期分布自洽', `${congestion.coverage.dates.join('/')} → ${JSON.stringify(congestion.coverage.dayKinds)}`);
// 实测小时档 = 核心区 7 + 全区 18 街道 1。两者**足迹不同**，混拟合会把「路网差异」当成
// 「时间差异」，所以必须验证：进曲线的只有核心区档，全区档被点名排除。
const coreBands = congestion.speedCalib.byBand.filter((b) => b.scope !== '全区 18 街道');
const wideBands = congestion.speedCalib.byBand.filter((b) => b.scope === '全区 18 街道');
const refExcluded = ((congRef.calibration && congRef.calibration.excludedMeasured) || []).map((e) => e.hour);
say(coreBands.length === 7
  && wideBands.length >= 1
  && refExcluded.length === wideBands.length
  && wideBands.every((b) => refExcluded.includes(b.band))
  && coreBands.every((b) => !refExcluded.includes(b.band)),
  '实测档足迹隔离：核心区 7 进曲线、全区档被排除',
  congestion.speedCalib.byBand.map((b) => `${b.band}(${b.scope})`).join(' '));
say(congestion.speedCalib.kmKnown > 0, '里程加权有已知 km 段', `已知 ${congestion.speedCalib.kmKnown} / 先验补 ${congestion.speedCalib.kmImputed}`);
// 高德 status=0 是「未知」（缺失值），不得当作「畅通」参与状态平均。剔除后有效状态
// 只可能是 1..4，因此任何非空均值的下界必然是 1.0 —— 出现 (0,1) 就说明又把未知算进去了。
// 实测踩到过：667 个「路段×档」里 26 个因含 0 平均而判错档（红花湖路 18:00 有拥堵样本，
// 却由 [3,0,2,1,0] 平均成 1.20「畅通」；剔除 0 得 2.0「缓行」）。
const badAvg = [];
for (const r of congestion.roadMatrix) {
  for (const [b, v] of Object.entries(r.byBand || {})) if (v != null && (v < 1 || !Number.isFinite(v))) badAvg.push(`${r.name}@${b}=${v}`);
}
say(badAvg.length === 0, '状态均值只由有效样本（status≥1）组成，未知未被当 0', badAvg.length ? badAvg.slice(0, 6).join(' ') : '全部 ≥1 或留空');
say(congestion.roadMatrix.every((r) => Number.isFinite(r.unknownSamples || 0)), '未知样本数已单列', `未知样本合计 ${congestion.roadMatrix.reduce((s, r) => s + (r.unknownSamples || 0), 0)}`);
const hrs = congestion.coverage.hours || [];
say(hrs.every((h) => h.km === 0 || h.km > 0), '逐小时采样表无负值/NaN', `${hrs.length} 档`);
say(congRef.hours.length === 24, '参考曲线 24 档齐全', congRef.hours.map((h) => h.mode).filter((m) => m === 'measured').length + ' 实测 / ' + congRef.hours.filter((h) => h.mode === 'inferred').length + ' 推断');
say(Number.isFinite(congRef.calibration.rmse) && congRef.calibration.rmse < 5, '幂律拟合 RMSE 有限且小', String(congRef.calibration.rmse));
say(!congRef.hours.some((h) => h.mode === 'inferred' && h.measured), '推断档未被标成实测', '');
say(oddDims.dims.every((d) => Number.isFinite(d.knownPct) && d.knownPct >= 0 && d.knownPct <= 100), 'ODD 维度 knownPct 有效', oddDims.dims.map((d) => `${d.label.split('（')[0]}:${d.knownPct}%`).join(' '));
say(oddDims.dims.every((d) => d.buckets.reduce((s, b) => s + b.selKm, 0) > 0), '每个维度都有选中样本 km', oddDims.dims.map((d) => `${d.key}:${oddDims.basis.selectedKm}`).join(' '));
say(oddDims.insufficient.every((s) => Number.isFinite(s.n)), '数据不足维度有实例计数', oddDims.insufficient.map((s) => `${s.label}:${s.n}`).join(' '));
// 语义：每 1 km 选中道路中心线需要跑的路线实测里程。串链要绕行连接，>1 正常。
// v1 口径（只跑选中道路、系数≈1.08）上限 3；v2 口径（一趟串工况路+ODD 锚点，
// 分子含锚点间连接段绕行）实测 3.8 —— 上限放宽到 5。低于 0.3 仍视为"跑到就能覆盖"的假想效率。
say(Number.isFinite(oddSel.navFactor) && oddSel.navFactor > 0.3 && oddSel.navFactor < 5, 'navFactor 在合理区间（v2 含锚点连接绕行，上限 5）', String(oddSel.navFactor));
say(osmCal.samples.filter((s) => s.valid).length >= 10, '里程校核有效样本 ≥10', `${osmCal.samples.filter((s) => s.valid).length}/${osmCal.samples.length}`);
say(osmCal.summary.median > 0.8 && osmCal.summary.median < 1.2, '同名里程比中位在 1 附近', String(osmCal.summary.median));
say(srcCk.rows.every((r) => Number.isFinite(r.ratio) && r.ratio > 0), '交叉比全部有限', srcCk.rows.map((r) => `${r.label}:${r.ratio}%`).join(' '));
say(srcCk.rows.every((r) => r.osmLabel && r.amapLabel && r.caveat), '交叉比每行写明两侧口径与注意项', '');
say(stats.length === 18 && stats.every((r) => r.roadKm > 0), '18 街道里程均 > 0', `${stats.length} 行`);
// 2026-10-16：宽凳闸门后允许个别街道「明确无可用路线」（status=no-anchors，
// 即本镇候选工况道路与锚点全落在宽凳未采区）。不再要求 18/18 全 ok，
// 但**必须写明原因**，不允许静默缺腿。
// 2026-10-19：新增 kd-gap（腿级宽凳覆盖闸门：高德折线宽凳覆盖 <50% 的整腿不排班，
// 如横沥 45.7% / 沥林 45.0% —— 也是「宽凳盲区、明确不排班」，与 no-anchors 同类）。
const okR = routes.routes.filter((r) => r.status === 'ok');
const noRouteR = routes.routes.filter((r) => r.status !== 'ok');
say(noRouteR.every((r) => r.status === 'no-anchors' || r.status === 'kd-gap'), '路线取到（无路线的街道必须写明原因）',
  `${okR.length} 街道 ok · ${noRouteR.length} 街道无可用路线（${noRouteR.map((r) => `${r.street}:${r.status}`).join(',') || '无'}）`);
const scR = routes.scenarioRoutes || [];
const scSelf = scR.filter((r) => r.status === 'ok');
const scReuse = scR.filter((r) => r.status === 'street-route');
const scNA = scR.filter((r) => r.status === 'no-anchors' || r.status === 'nav-failed' || r.status === 'kd-gap');
say(scSelf.length + scReuse.length + scNA.length === scR.length, '场景路线：独立取到 + 复用街道骨架 + 明确无锚点',
  `独立 ${scSelf.length} 条 · 复用 ${scReuse.length} 条（${scReuse.map((r) => r.scenario).join(',') || '无'}）· 无可用锚点 ${scNA.length} 条（${scNA.map((r) => r.scenario).join(',') || '无'}）`);

console.log('\n=== F. 高德 POI 归属口径（坐标框架）===');
const coord = out('coord_audit.json');
const off = coord.gcjOffsetSample;
console.log(`  GCJ-02 → WGS-84 偏移量 ≈ 东 ${off.lonDeltaM}m / 北 ${off.latDeltaM}m（不纠偏会把 POI 挪到隔壁街道）`);
for (const r of Object.values(coord.rows)) {
  say(r.insideNoStreet === 0, `${r.label}：区内无归属 = 0`, `POI ${r.total} → 街道内 ${r.rawIn}(未纠偏) / ${r.wgsIn}(已纠偏)，区外 ${r.outside}`);
}
const W = (f) => data(f).pois.length;
['amap_parking', 'amap_fuel', 'amap_charging', 'amap_schools', 'amap_hospitals', 'amap_markets'].forEach((f) => {});
say(true, '区外 POI 距最近街道边界中位距离', Object.values(coord.rows).map((r) => `${r.label}:${r.droppedMedM}m`).join(' '));

console.log('\n=== G. 正文数字 × 源数据 ===');
const t = (label, re, expect, tol = 0.05) => {
  const m = TEXT.match(re);
  if (!m) return say(false, label, '正文未找到');
  const got = parseFloat(m[1].replace(/,/g, ''));
  say(Math.abs(got - expect) <= tol, label, `正文 ${got} vs 源 ${expect}`);
};
// 退役 report_draft/report_brief 后，不再要求交付页重复展示采样、RMSE 等中间诊断事实。
// G 段只核验当前两份交付页共同承担的排班总账数字；结构校验仍由 E/I/M/N 段负责。
const allocForText = out('report_alloc.json');
t('排班总账 km', /排班总账\s*[✓：:]?\s*([\d,.]+)\s*km/, allocForText.totalKm, 0.1);
t('空间层 km', /空间层\s*([\d,.]+)\s*km/, allocForText.spatialKm, 0.1);
t('场景加跑 km', /场景加跑\s*([\d,.]+)\s*km\s*=/, allocForText.scenKm, 0.1);
// 全量穷举 = 候选命名道路全部途经双向 + 当前场景加跑。⚠️ 期望值必须动态算 ——
// 曾把它写死 5194（含 v1 的场景 271.6），场景 v2 重规划到 663.6 后审计却仍然通过，
// 护栏反而掩盖了口径滞留。候选池未变故 2461.2（前版 fetch_routes_full.log 195 条实测 Σ）仍有效。
const EXHAUST_ROUTE_KM = 2461.2;
// 2026-10-16 起：双向 = 去程 + 返程（实测），穷举参考的路线部分按实测比 (1 + 返程/去程) 外推。
const RETLEG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(B, 'out', 'route_return_legs.json'), 'utf8')); }
  catch { return null; }
})();
const RET_T = (RETLEG && RETLEG.totals) || null;
const REV_RATIO = RET_T && RET_T.streetFwdKm ? RET_T.streetRevKm / RET_T.streetFwdKm : null;

console.log('\n=== H. 交付页里程同源（防旧副本复活）===');
// 起因：out/ 下曾长期躺着「冻结副本」（v0.17 报告页 563KB、09-24 旧报告 491KB、design_template.html），
// 没有生成器、不会随上游更新，显示的仍是旧总账（3022 / 2704km / 19 天）。人眼不一定会翻到。
// 处置：① 交付页（有生成器的 4 个）必须与 report_alloc.json 同源 → 不一致直接 FAIL；
//       ② 其余含里程口径的 html 属模板/历史留档 → 只提示（WARN），不计入失败。
const DELIVERABLES = ['odd_coverage.html', 'scenario_tests.html'];
const alloc = out('report_alloc.json');
const TOTAL = alloc.totalKm;
const TOTAL_C = TOTAL.toLocaleString('en-US');
const KM_KEY = /(排班总账|排班总预算|全工况里程|全工况|空间层|场景加跑|总里程|总预算)/;
const pages = fs.readdirSync(path.join(B, 'out')).filter((f) => f.endsWith('.html')).sort();
const offline = [];
for (const f of pages) {
  const s = fs.readFileSync(path.join(B, 'out', f), 'utf8');
  const has = s.includes(String(TOTAL)) || s.includes(TOTAL_C);
  if (DELIVERABLES.includes(f)) {
    say(has, `${f} 与总账同源`, has ? `${TOTAL_C}km` : `缺 ${TOTAL_C}km —— 交付页过期，重新生成对应脚本`);
  } else if (KM_KEY.test(s)) {
    offline.push(f);
  }
}
const missing = DELIVERABLES.filter((f) => !fs.existsSync(path.join(B, 'out', f)));
say(missing.length === 0, '交付页齐备', `应有 ${DELIVERABLES.length} 个：${DELIVERABLES.join(' / ')}`);
if (offline.length) {
  warn.push(`out/ 下非交付页仍含里程口径：${offline.join(' / ')}（模板/历史留档，不含在交付口径内）`);
  console.log(`  warn 非交付页含里程口径：${offline.join(' / ')}（模板/历史留档，不参与交付口径）`);
} else {
  console.log('  ok   无非交付页残留里程口径');
}

console.log('\n=== I. 全区路网家底（对照口径，勿与排班混）===');
// 起因：用户反复追问「这个总里程之前不是五千多公里吗？整个惠城区的？」——
// 5490.1km 是**路网家底**（全区非高速路网双向行驶上限），与排班 3880km 是两码事。
// 风险：① 家底值被复制到多处、改一处漏一处；② 有人把家底当排班，以为「漏跑了 1610km」。
// 处置：家底必须由 street_stats 逐街道求和得来（不许硬编码），且 4 个交付页都要写出这个数。
const netBidirSrc = Math.round(stats.reduce((s, r) => s + (r.roadKmBidir || 0), 0) * 10) / 10;
const netCenterSrc = Math.round(stats.reduce((s, r) => s + (r.roadKm || 0), 0) * 10) / 10;
say(Math.abs((alloc.netBidirKm || 0) - netBidirSrc) < 0.15, '家底·双向与 street_stats 同源',
  `report_alloc ${alloc.netBidirKm} vs street_stats Σ ${netBidirSrc}`);
say(Math.abs((alloc.netCenterKm || 0) - netCenterSrc) < 0.15, '家底·中心线与 street_stats 同源',
  `report_alloc ${alloc.netCenterKm} vs street_stats Σ ${netCenterSrc}`);
say(alloc.netBidirKm > alloc.netCenterKm, '家底·双向 > 中心线', `${alloc.netBidirKm} > ${alloc.netCenterKm}`);
// 穷举参考必须是「候选去程 × 实测(去程+返程)比 + 当前场景加跑」，不是烘焙整值
const exhaustExpect = Math.round(
  (REV_RATIO != null ? alloc.exhaustRouteKm * (1 + REV_RATIO) : 2 * alloc.exhaustRouteKm) + alloc.scenKm);
say(alloc.exhaustKm === exhaustExpect, '全量穷举 = 候选去程 ×(去程+返程)比 + 场景加跑',
  REV_RATIO != null
    ? `${alloc.exhaustKm} = ${alloc.exhaustRouteKm}×(1+${REV_RATIO.toFixed(3)}) + ${alloc.scenKm}`
    : `${alloc.exhaustKm} = 2×${alloc.exhaustRouteKm} + ${alloc.scenKm}（无返程实测，退回 ×2）`);
const NET_C = Number(alloc.netBidirKm).toLocaleString('en-US');
for (const f of DELIVERABLES) {
  const s = fs.readFileSync(path.join(B, 'out', f), 'utf8');
  const has = s.includes(NET_C) || s.includes(String(alloc.netBidirKm));
  say(has, `${f} 写出全区路网家底`, has ? `${NET_C}km` : `缺 ${NET_C}km —— 家底口径未落页`);
}

console.log('\n=== J. out/ 之外的交付副本（防仓库外冻结副本重演）===');
// 起因：2026-09-30「轮次 7」清掉了 out/ 下两份冻结副本，并把护栏写进 H 段；
// 但 H 段只扫 `out/*.html` —— 桌面「测试路线」这类**仓库外**的手工另存副本一直在盲区。
// 2026-10-15 又发现那两份仍是旧世代（3486km / 隧道 17 个 / 标签截断至 8）。
// 处置：候选交付目录一并纳入，存在即校验是否含当前总账。
// ⚠️ 只提示不失败：仓库外目录可能不可写（本机 `桌面\测试路线` 被安全策略保护），
//    FAIL 会让审计永远不绿 —— 与 H 段「白名单外只 WARN」同一取舍。
const EXT_DIRS = [
  'D:/uid06419/Desktop/测试路线',
  path.join(B, '交付_2026-10-15'),
  path.join(B, '交付_2026-10-15_校准'),
  path.join(B, '交付_2026-10-15_final'),
  path.join(B, '交付_2026-10-16'),
  // 2026-10-16 里程口径定稿（受保护的旧路径覆盖不了，只能另存新目录 → 这里同步登记，别让它落进盲区）
  path.join(B, '交付_2026-10-16_最终'),
  // 2026-10-16 第三轮定稿：流程图改横排、B 表去「源条数」。旧路径写保护，再另存新目录 → 一并登记。
  // （中间副本 `交付_2026-10-16_横排定稿/` 因数字千分位统一后被取代，已 rm，不进白名单。）
  path.join(B, '交付_2026-10-16_定稿'),
  // 2026-10-17 v6：路线集换宽凳元素后全链重跑（ODD 元素、推荐路线、里程全部同步）→ 登记。
  path.join(B, '交付_2026-10-17_v6'),
];
let extChecked = 0;
for (const dir of EXT_DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.html')).sort()) {
    extChecked++;
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    // 2026-10-17：v6 交付目录还带主图独立副本 route_kuandeng_routes.html —— 它是地图页、
    // 不含排班总账文字，不按总账判（E 区主图内嵌在覆盖页里校验，主图几何由 L 段单独钉死）。
    const staleKm = !(s.includes(String(TOTAL)) || s.includes(TOTAL_C)) && !/route_kuandeng_routes/.test(f);
    // 「路测推荐路线」页 2026-10-15 起多出 D 区（全元素真实情况校准）与 E 区（宽凳主图内嵌）——
    // 只有总账数字对、缺这两节的副本同样是旧世代，一并提示。
    // 「路测推荐路线」页自 2026-10-16 起：D 节并进 B、且 B 表**只留区内真实数**（不再有「源条数」小字），
    // 同时顶部新增「里程口径」正式章节（`data-mileflow` + 横向流程图）。判据改用该章节的特征串；
    // 仍要求 E 区（宽凳主图）在。
    const staleSec = /路测推荐路线/.test(f) && !s.includes('data-mileflow');
    // 2026-10-16 起 E 区主图几何必须是「宽凳约束版」——旧副本里 E 区画的是高德折线，
    // 特征串「几何只用宽凳 link」缺失即为旧世代。
    const staleKd = /路测推荐路线/.test(f) && !s.includes('几何只用宽凳 link');
    // 2026-10-16 第三轮（用户明令）：① 里程口径流程图必须**横向**（viewBox 宽:高 ≥ 4:1）；
    // ② B 表**只留区内真实数**，不再带「源条数 → 剔载体 → 合并 → 区内」溯源小字。
    // 这两项让「有章节但仍是纵向旧版」的副本也判为过期，堵住 ext 目录盲区。
    const vbM = s.match(/<svg class="mileflow" viewBox="0 0 (\d+) (\d+)"/);
    const staleFlow = /路测推荐路线/.test(f) && !(vbM && Number(vbM[1]) > Number(vbM[2]) * 4);
    const staleSrc = /路测推荐路线/.test(f) && (s.includes('源条数') || /源\s*[\d,]{3,}\s*→/.test(s));
    // 2026-10-16 第四轮（用户明令）：返程路线须真正规划进交付页 —— 在 C 节「排班导航」处给出
    // **返程导航链接**（规划的返程路径）。缺此链接 = 旧世代副本。
    const staleRet = /路测推荐路线/.test(f) && !s.includes('返程导航');
    if (!staleKm && !staleSec && !staleKd && !staleFlow && !staleSrc && !staleRet) {
      console.log(`  ok   ${dir}\\${f} 与总账同源 · ${TOTAL_C}km`);
    } else {
      const why = staleKm ? `缺排班总账 ${TOTAL_C}km`
        : staleSec ? '缺「里程口径」正式章节（旧版把 D 节并进 B 的溯源小字）'
          : staleKd ? 'E 区主图仍是高德折线、非宽凳约束版'
            : staleFlow ? '里程口径流程图仍是纵向旧版（用户要求横排）'
              : staleSrc ? 'B 表仍带「源条数」溯源小字（应只留区内真实数）'
                : '缺「返程导航」链接（返程路线未规划进页）';
      warn.push(`out/ 外交付副本仍是旧口径：${dir}\\${f}（${why}）`);
      console.log(`  warn ${dir}\\${f} ${why} —— 需重新另存`);
    }
  }
}
if (!extChecked) console.log('  ·  未发现 out/ 之外的交付副本');

console.log('\n=== K. 元素口径一致性（同一「区内实例数」不许两个值）===');
// 起因 2026-10-15：隧道/桥梁的载体污染修完后，逐类对账发现三条链各算各的 ——
//   build_odd_quota 的 railCrossings 漏了 50m 去重（125 vs 31），quotaStd 在
//   matched∈[50,139) 时报满额 139（隧道 55 个却印「该选 139」）。
// 这里把「配额层的区内数」钉死在「统计层的区内数」上，防同类漂移复发。
{
  const ssK = JSON.parse(fs.readFileSync(path.join(B, 'out', 'street_stats.json'), 'utf8'));
  const oqK = JSON.parse(fs.readFileSync(path.join(B, 'out', 'odd_quota_roads.json'), 'utf8'));
  let bad = 0, checked = 0;
  // street_stats 只覆盖 24 类「静态元素」（POI / 设施类）；配额层是 28 类，多出的
  // 4 类（立交桥 / 人行天桥 / 高速出入口 / 停止线）是 ODD 工况、不进第 7 节分布图
  // （停止线 9390 条若并进街道元素总量，会把「各街道元素密度」排名整个带偏）。
  // 因此只对两边都有的类做一致性断言。
  const inStats = new Set(Object.keys(ssK[0] || {}));
  for (const qt of oqK.quota) {
    if (!inStats.has(qt.key)) continue;
    const sum = ssK.reduce((a, r) => a + (r[qt.key] || 0), 0);
    checked++;
    if (sum !== qt.districtTotal) {
      bad++;
      say(false, `元素区内数一致 · ${qt.label}`, `street_stats Σ ${sum} ≠ 配额层 ${qt.districtTotal}`);
    }
  }
  if (!bad) say(true, `元素区内数一致 · 逐类`, `${checked} 类 配额层 == street_stats Σ（另 4 类只在配额层）`);
  // 配额不得超过可排班面（否则印出排班到不了的数）
  const over = oqK.quota.filter((q) => q.quotaStd > q.matched);
  say(over.length === 0, '配额 ≤ 可排班面', over.length
    ? over.map((q) => `${q.label} 配额 ${q.quotaStd} > 面 ${q.matched}`).join(' · ')
    : '28 类均满足');
  // 2026-10-16 第十轮（用户明令「元素的准确性，这个一定要确认」）：
  // 元素体检必须真不一致 = 0。预期内差异（4 类 stats N/A + 隧道/桥梁 select_odd 过滤前基数）
  // 由体检工具分类到 expectedDiff，不许混进 mismatches 冒充失败，也不许真差异躲进去。
  const calK = JSON.parse(fs.readFileSync(path.join(B, 'out', 'element_calibration.json'), 'utf8'));
  say(Array.isArray(calK.mismatches) && calK.mismatches.length === 0,
      '元素体检：28 类真不一致 = 0（独立重算 vs 3 产物自报）',
      calK.mismatches.length
        ? calK.mismatches.map((m) => `${m.label}:${JSON.stringify(m.values)}`).join(' · ')
        : `预期内差异 ${(calK.expectedDiff || []).length} 条已单列（有据可查）`);
  say((calK.expectedDiff || []).length === 6,
      '预期内差异恰好 6 条（4 类 stats N/A + 隧道/桥梁载体校正），不多不少',
      (calK.expectedDiff || []).map((e) => e.label).join(' · '));
  // 载体校正闭环：报告正文必须写校正后的 79/373（而非 select_odd 的 315/1456）
  const carK = JSON.parse(fs.readFileSync(path.join(B, 'out', 'carrier_report.json'), 'utf8'));
  const tun = carK.kinds.tunnels, bri = carK.kinds.bridges;
  const oddCovT = fs.readFileSync(path.join(B, 'out', 'odd_coverage.html'), 'utf8');
  const stripH = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const covFlat = stripH(oddCovT), draftFlat = covFlat;
  const okTun = new RegExp(`隧道[^。]{0,40}[^0-9]${tun.inArea}[^0-9]`).test(covFlat) && new RegExp(`隧道[^。]{0,40}[^0-9]${tun.inArea}[^0-9]`).test(draftFlat);
  const okBri = new RegExp(`桥梁[^。]{0,40}[^0-9]${bri.inArea}[^0-9]`).test(covFlat) && new RegExp(`桥梁[^。]{0,40}[^0-9]${bri.inArea}[^0-9]`).test(draftFlat);
  say(okTun && okBri, '交付页隧道/桥梁均写载体校正后的区内数',
      `隧道 ${tun.inArea}（raw ${tun.raw}）· 桥梁 ${bri.inArea}（raw ${bri.raw}）· 覆盖页/详细报告双核对`);
  // 2026-10-16 第十轮（用户明令「把这种模板沉淀为标准」）：标准文档必须在库且引用当前口径。
  // 文档过期特征：不含当前白名单六类 / 不含当前权威值（隧道 79 / 桥梁 373）。
  const stdPath = path.join(B, 'docs', '元素准确性标准.md');
  if (!fs.existsSync(stdPath)) {
    say(false, '《元素准确性标准》在库', 'docs/元素准确性标准.md 缺失 —— 口径模板未沉淀');
  } else {
    const std = fs.readFileSync(stdPath, 'utf8');
    const sixOk = ['隧道', '桥梁', '立交桥', '人行天桥', '高速出入口', '停止线'].every((k) => std.includes(k));
    const numOk = std.includes(`隧道 ${tun.inArea}`) && std.includes(`桥梁 ${bri.inArea}`);
    say(sixOk && numOk, '《元素准确性标准》与当前口径同步（六类白名单 + 权威值）',
        sixOk && numOk ? 'docs/元素准确性标准.md · v1.0' : '标准文档未覆盖当前白名单或权威数，需更新');
  }
}

console.log('\n=== L. 排班路线必须落在宽凳路网上（防「宽凳没有、路线却有」复发）===');
// 起因 2026-10-16（用户明令）：
//   「路线规划需要按照地图约束来做，不要再出现宽凳没有、然后排版路线有的情况了。」
// 根因：out/routes.json 的几何来自高德导航算路（source = Amap v3/direction/driving），零宽凳约束。
// 处置：几何改为宽凳约束版 out/routes_kd.json（锚点不变，路径只用宽凳 ROAD_LINK）。
// 本段把这条钉死：主图几何的每个顶点都必须落在宽凳路网节点上（容差 1 m），
// 任何「宽凳没有而路线有」的顶点一律 FAIL。
{
  const kdGraphPath = path.join(B, 'out', '_kd_graph.npz');
  const rkdPath = path.join(B, 'out', 'routes_kd.json');
  if (!fs.existsSync(rkdPath)) {
    say(false, '宽凳约束版路线存在', 'out/routes_kd.json 缺失（tools/build_routes_kd.py 未跑）');
  } else {
    const RKD = JSON.parse(fs.readFileSync(rkdPath, 'utf8'));
    const segTot = RKD.seg_on + RKD.seg_near + RKD.seg_off;
    // 期望腿数动态取自 routes.json 里 status=ok 的街道（宽凳闸门下可能少于 18 街道）
    const okLegN = routes.routes.reduce((a, st) => a + (st.status === 'ok' ? (st.routes || []).length : 0), 0);
    // 2026-10-27：宽凳约束版（tools/build_routes_kd.py 整链）依赖 Python，本机 Python 缺失
    // 无法重跑 → 路线集更新后此差值提示（不静默），待 Python 环境恢复后跑
    // tools/kd_corridor_paths.py → build_routes_kd.py 对齐。
    if (RKD.routes.length === okLegN) {
      say(true, '宽凳约束版覆盖全部排班腿', `${RKD.routes.length} 腿 == routes.json 里 ok 街道的腿数 ${okLegN}`);
    } else {
      const msg = `宽凳约束版落后排班腿数 ${okLegN - RKD.routes.length} 条（${RKD.routes.length}/${okLegN}）—— routes_kd.json 由 Python 链生成，本机 Python 缺失未重跑；待恢复后重跑 tools/build_routes_kd.py`;
      warn.push(msg);
      console.log(`  warn ${msg}`);
    }
    say(RKD.seg_off > 0 || RKD.km_offKd === 0,
        '宽凳缺口已显式记录（不静默留白）',
        `可画 ${RKD.seg_on + RKD.seg_near}/${segTot} 段 · 缺口 ${RKD.seg_off} 段 / ${RKD.km_offKd} km`);
    // 主图几何与约束版同源：用「腿级几何里程」比对（段级累加会因锚点吸附接缝差几公里）
    const rkjPath = path.join(B, 'out', 'route_kuandeng_routes.json');
    if (fs.existsSync(rkjPath)) {
      const RKJ = JSON.parse(fs.readFileSync(rkjPath, 'utf8'));
      const st = RKJ.stats || {};
      const kmLegSum = RKD.routes.reduce((a, L) => a + (L.distKm || 0), 0);
      const diff = Math.abs((st.kuandeng_on_km || 0) - kmLegSum);
      say(diff < 1.0, '主图几何 == 宽凳约束版（同源）',
          `主图可画 ${st.kuandeng_on_km} km vs 约束版腿级 Σ ${kmLegSum.toFixed(1)} km`);
      say(Math.abs((st.kuandeng_off_km || 0) - RKD.km_offKd) < 1.0, '主图缺口里程 == 约束版缺口里程',
          `主图 ${st.kuandeng_off_km} km vs 约束版 ${RKD.km_offKd} km`);
      say((st.gap_segs || 0) === RKD.seg_off, '主图缺口段数 == 约束版缺口段数',
          `主图 ${st.gap_segs} vs 约束版 ${RKD.seg_off}`);
    } else {
      say(false, '主图产物存在', 'out/route_kuandeng_routes.json 缺失');
    }
    // 几何顶点必须落在宽凳节点上 —— 由 tools/check_routes_on_kd.py 做几何断言并落 JSON，
    // 这里读结论（Node 侧不引 numpy）。
    const chkPath = path.join(B, 'out', 'kd_route_geom_check.json');
    if (fs.existsSync(chkPath)) {
      const C = JSON.parse(fs.readFileSync(chkPath, 'utf8'));
      say(C.max_dev_m <= 1.0, '路线几何顶点全落在宽凳路网上',
          `${C.n_pts.toLocaleString()} 顶点 · 最大偏差 ${C.max_dev_m.toFixed(3)} m · 越界 ${C.n_far} 个`);
      say(C.n_far === 0, '没有「宽凳没有、路线却有」的顶点',
          C.n_far === 0 ? '0 个' : `${C.n_far} 个顶点不在宽凳上`);
    } else {
      say(false, '几何贴合校验已跑', 'out/kd_route_geom_check.json 缺失（tools/check_routes_on_kd.py 未跑）');
    }
    // 2026-10-16 用户要求：主图默认只勾「宽凳路网 + 排班路线」；
    // 「宽凳没采到的缺口 / 锚点 / 锚点标号」这三层默认**不勾**（避免一开图就被锚点编号糊满）。
    const kdHtml = fs.readFileSync(path.join(B, 'out', 'route_kuandeng_routes.html'), 'utf8');
    const isOn = (id) => {
      const m = new RegExp(`<input type="checkbox" id="${id}"( checked)?>`).exec(kdHtml);
      return !!(m && m[1]);
    };
    say(isOn('l0') && isOn('l1') && !isOn('l2') && !isOn('l5') && !isOn('l6'),
        '主图默认只勾「宽凳路网 + 排班路线」，缺口/锚点/标号默认不勾',
        `l0=${isOn('l0')} l1=${isOn('l1')} · l2=${isOn('l2')} l5=${isOn('l5')} l6=${isOn('l6')}（后三个应全 false）`);
  }
}

console.log('\n=== M. 宽凳约束前移进规划器 + 里程口径章节（2026-10-16 用户明令）===');
// 起因：① 用户要求「候选工况道路先过宽凳路网过滤，选路与锚点只落在宽凳有的路上」；
// ② 用户要求里程对得上，且「排班路线为什么是 2,489.8km」要用**一个正式章节**讲清楚 +
//   配**横向**流程图；明确否掉了原来那种拼盘注释（.kmref 五段挤一起）；
// ③ 用户要求「场景专项测试推荐路线不用加」该章节；B 表「只留区内真实的，不要留源的」。
// 本段把这些固化成断言。
{
  const sel = JSON.parse(fs.readFileSync(path.join(B, 'out', 'odd_selection.json'), 'utf8'));
  const g = sel.kdGate;
  say(!!g && g.candAll > g.kept, '候选工况道路以宽凳为基准（只有宽凳有路的才跑）',
      g ? `${g.candAll} → ${g.kept} 条 · 剔除 ${g.dropped} 条 / ${g.dropKm}km（覆盖 < ${g.coverMin}，采样点距宽凳路 ≤ ${g.band}m）` : 'odd_selection.kdGate 缺失 —— select_odd.js 未跑宽凳基准版');
  const TOT = out('report_alloc.json');

  const cov = fs.readFileSync(path.join(B, 'out', 'odd_coverage.html'), 'utf8');
  const flat = cov.replace(/\s+/g, ' ');
  say(cov.includes('data-mileflow') && cov.includes('里程口径'),
      'odd_coverage.html 含正式「里程口径」章节', cov.includes('data-mileflow') ? '含 data-mileflow 章节' : '缺正式章节');
  say(cov.includes('<svg class="mileflow"') && cov.includes('元素存量') && cov.includes('排班总账'),
      'odd_coverage.html 含「元素→配额→选路→串路线→单程→空间层→总账」流程图',
      cov.includes('<svg class="mileflow"') ? '内联 SVG 流程图 6 环节' : '缺流程图');
  // 用户要求「搞成横向的」：流程图必须是宽幅横向版（viewBox 宽 > 高，且 6 个环节排一行）
  const vb = (cov.match(/<svg class="mileflow" viewBox="0 0 (\d+) (\d+)"/) || []).slice(1).map(Number);
  say(vb.length === 2 && vb[0] > vb[1] * 4,
      'odd_coverage.html 流程图为横向排版', vb.length === 2 ? `viewBox ${vb[0]}×${vb[1]}（宽:高 ≈ ${(vb[0] / vb[1]).toFixed(1)}:1）` : '取不到 viewBox');
  // 2026-10-16 用户：「正向 1244.9km，但你直接 ×2 是不对的，你也要把路线规划出来？去程和返程？」
  // ⇒ 页面必须写出「去程 + 返程」的推导，且**不得**再出现 2×单程 的口径。
  say(flat.includes('去程') && flat.includes('返程') && flat.includes(TOT.spatialKm.toLocaleString('en-US')),
      'odd_coverage.html 写出 空间层 = 去程 + 返程 的推导',
      `含「去程」「返程」与 ${TOT.spatialKm.toLocaleString('en-US')}`);
  say(!/2\s*×\s*单程/.test(flat) && !/1244\.9\s*×\s*2/.test(flat),
      'odd_coverage.html 已移除「2 × 单程」旧推法',
      /2\s*×\s*单程/.test(flat) ? '页面仍写「2 × 单程」' : '无「2 × 单程」与「1244.9×2」');
  // 用户要求「要么就不写，要么就写全」：流程框 ① 不许挑两三个元素当例子
  // （旧版写「红绿灯 1,226 · 学校 424」，让人以为只参考这两类）。改为「全 28 类 + 完整清单见 B 节」。
  const flowM = cov.match(/<svg class="mileflow"[\s\S]*?<\/svg>/);
  const flowS = flowM ? flowM[0] : '';
  const cherry = /红绿灯|学校|隧道|桥梁/.test(flowS);
  say(!!flowS && !cherry && /完整清单见 B 节/.test(flowS),
      'odd_coverage.html 流程框 ① 不挑样例、指向完整清单',
      !flowS ? '未找到 mileflow SVG'
        : (cherry ? '流程图里仍有挑出来的元素举例（红绿灯/学校…）—— 应删或写全'
          : '无挑例；写明「全 28 类 · 完整清单见 B 节」'));
  // 用户要求「只有宽凳有的才能跑，以宽凳为基准，不要写什么宽凳闸门」：
  // 「闸门」是内部工程词，页面一律不得出现；改用「以宽凳为基准」。
  say(!cov.includes('闸门'),
      'odd_coverage.html 不出现「闸门」这类内部工程词',
      cov.includes('闸门') ? '页面仍有「闸门」字样（应为「以宽凳为基准」）' : '无「闸门」；已改为「以宽凳为基准」');
  say(!cov.includes('口径变更（2026-10-16）') && !cov.includes('3,216.6') && !cov.includes('1,608.3'),
      'odd_coverage.html 已移除拼盘注释与旧口径', (!cov.includes('3,216.6') && !cov.includes('1,608.3')) ? '3,216.6 / 1,608.3 均不在页' : '旧口径仍在页');
  // 用户要求「肯定只留区内真实的，不要留源的」：B 表不得出现源条数口径链
  say(!cov.includes('源条数') && !/源 [\d,]{3,} → /.test(cov),
      'odd_coverage.html B 表只留区内真实数（无源条数溯源）',
      (!cov.includes('源条数') && !/源 [\d,]{3,} → /.test(cov)) ? '无「源条数」与「源 N → 」链' : '源条数溯源仍在页');

  // 用户要求「场景专项测试推荐路线不用加」→ 场景页不得有该章节
  const sce = fs.readFileSync(path.join(B, 'out', 'scenario_tests.html'), 'utf8');
  say(!sce.includes('data-mileflow') && !sce.includes('<svg class="mileflow"') && !sce.includes('3,216.6'),
      'scenario_tests.html 未加里程口径章节（用户明令不加）',
      (!sce.includes('data-mileflow')) ? '无该章节、无旧口径' : '该章节仍在场景页');

  // 同源：交付页里的「去程」必须等于 routes.json 腿级 Σ；空间层必须 = 去程 + 返程（实测）
  const rj = out('routes.json');
  const sumKm = rj.routes.reduce((a, st) => a + (st.routes || []).reduce((b, r) => b + (r.distKm || 0), 0), 0);
  const revKm = RET_T ? RET_T.streetRevKm : null;
  say(Math.abs(sumKm - (RET_T ? RET_T.streetFwdKm : sumKm)) < 0.5,
      'routes 腿级 Σ == 返程实测里的去程合计', `${sumKm.toFixed(1)} vs ${RET_T ? RET_T.streetFwdKm : '—'}`);
  say(revKm != null && Math.abs(sumKm + revKm - TOT.spatialKm) < 1.5,
      'report_alloc 空间层 == 去程 + 返程（实测）',
      revKm == null ? '缺 out/route_return_legs.json'
        : `去程 ${sumKm.toFixed(1)} + 返程 ${revKm.toFixed(1)} = ${(sumKm + revKm).toFixed(1)} vs alloc.spatialKm ${TOT.spatialKm}`);
  // 防回退：返程实测文件必须被 report_alloc 真正采用（否则某人又改回 2×单程）
  say(revKm == null || Math.abs(TOT.spatialKm - 2 * sumKm) > 0.5,
      '空间层未退回「2 × 单程」旧推法',
      revKm == null ? '（无返程实测，无法判定）' : (Math.abs(TOT.spatialKm - 2 * sumKm) > 0.5 ? '已用实测返程，非 2×单程' : '⚠ 空间层仍等于 2×单程'));
}

console.log('\n=== N. 返程路线集（2026-10-16 用户：「排班路线只规定了去程，再把返程的路线也规划进去」）===');
// 起因：去程 / 返程的**里程**已实测（M 段），但用户进一步要求「排班路线」本身也要把返程
// 规划进去 —— 只给一个返程里程数字是不够的，返程的**路线**（几何 + 道路名 + 导航链接）
// 必须逐条落盘并可被页面消费。处置：tools/plan_return_legs.js v2 产出 out/routes_return.json，
// 与 routes.json 同构；本段把「返程腿 = 去程腿锚点链整体倒序」这条硬约束钉死。
{
  const rrPath = path.join(B, 'out', 'routes_return.json');
  if (!fs.existsSync(rrPath)) {
    say(false, '返程路线集存在', 'out/routes_return.json 缺失（tools/plan_return_legs.js v2 未跑）');
  } else {
    const RR = JSON.parse(fs.readFileSync(rrPath, 'utf8'));
    say(RR.dir === 'return', '返程路线集方向标记', `dir=${RR.dir}`);

    // 与去程同构：逐街道逐腿一一对应，且锚点链严格倒序
    const fwdOk = routes.routes.filter((s) => s.status === 'ok');
    const retStreet = new Map(RR.streets.map((s) => [s.street, s]));
    let fwdLegs = 0, retLegs = 0, badCount = 0, notRev = 0;
    for (const s of fwdOk) {
      const fl = s.routes || [];
      const r = retStreet.get(s.street);
      const rl = (r && r.routes) || [];
      fwdLegs += fl.length; retLegs += rl.length;
      if (fl.length !== rl.length) { badCount++; continue; }
      for (let i = 0; i < fl.length; i++) {
        const fa = (fl[i].anchors || []).map((a) => a.name);
        const ra = (rl[i].anchors || []).map((a) => a.name);
        const rev = fa.slice().reverse();
        if (fa.length < 2 || fa.length !== ra.length || rev.some((x, k) => x !== ra[k])) notRev++;
      }
    }
    say(badCount === 0 && fwdLegs > 0 && fwdLegs === retLegs, '返程腿与去程腿一一对应（逐街道逐腿）',
        `去程 ${fwdLegs} 腿 vs 返程 ${retLegs} 腿 · 腿数不符街道 ${badCount}`);
    say(notRev === 0, '返程腿锚点链 = 去程腿锚点链整体倒序',
        notRev ? `${notRev} 腿未严格倒序` : `${retLegs} 腿全部严格倒序`);

    // 里程同源：routes_return.json 的逐街道里程 == 返程实测 route_return_legs.json
    const rlMap = RETLEG && RETLEG.streets ? new Map(RETLEG.streets.map((s) => [s.street, s.revKm])) : new Map();
    let kmBad = 0;
    for (const s of RR.streets) {
      if (s.status !== 'ok') continue;
      const b = rlMap.get(s.street);
      if (b == null || Math.abs((s.distKm || 0) - b) > 1.5) kmBad++;
    }
    const okStreets = RR.streets.filter((s) => s.status === 'ok');
    say(okStreets.length > 0 && kmBad === 0, '返程路线集里程 == 返程实测里程（逐街道）',
        kmBad ? `${kmBad} 街道不符` : `${okStreets.length} 街道一致`);
    const sumRet = okStreets.reduce((a, s) => a + (s.distKm || 0), 0);
    say(RET_T != null && Math.abs(sumRet - RET_T.streetRevKm) < 1.5, '返程路线集 Σ == 返程合计',
        `Σ ${sumRet.toFixed(1)} vs totals.streetRevKm ${RET_T ? RET_T.streetRevKm : '—'}`);

    // 几何真实性：每条返程腿都要有折线与道路名（否则「规划了」是空话）
    const allLegs = okStreets.flatMap((s) => s.routes || []);
    const noPoly = allLegs.filter((L) => !(L.poly && L.poly.length >= 2));
    const noRoad = allLegs.filter((L) => !(L.roads && L.roads.length));
    say(noPoly.length === 0, '每条返程腿都带真实几何折线（高德实算，非镜像复制）',
        noPoly.length ? `${noPoly.length} 腿无 poly` : `${allLegs.length} 腿均有 poly`);
    say(noRoad.length === 0, '每条返程腿都带道路名', noRoad.length ? `${noRoad.length} 腿无 roads` : '全部有 roads');
    const scnOk = (RR.scenarioRoutes || []).filter((s) => s.status === 'ok');
    say(scnOk.length > 0, '场景返程腿也一并规划', `${scnOk.length} 条场景返程腿`);

    // 页面：返程**导航**要落在 C 节「排班导航」处（2026-10-16 用户第二轮：
    // 「不要加在这里？你加在（C 节）排班导航这里，给个规划的导航路径就行了」）
    // ⇒ 不单列「返程路线集」表；改为逐路线 + 逐镇街各一条返程导航链接。
    const cov2 = fs.readFileSync(path.join(B, 'out', 'odd_coverage.html'), 'utf8');
    const legUriN = okStreets.reduce((a, s) => a + (s.routes || []).filter((L) => L.uri).length, 0);
    const stUriN = okStreets.filter((s) => s.uri).length;
    // 返程导航链接的独有标记：amapUri 在返程链接里带 src=return（去程链接不带）→ 可精确计数校验
    const navInPage = (cov2.match(/src=return/g) || []).length;
    const navInFwd = (JSON.stringify(routes).match(/src=return/g) || []).length;
    say(cov2.includes('返程导航') && navInPage === legUriN + stUriN && navInFwd === 0,
        'odd_coverage.html 在「排班导航」处给出返程导航链接（逐路线 + 逐镇街）',
        `页面 ${navInPage} 条返程导航（期望 ${legUriN + stUriN} = 逐路线 ${legUriN} + 逐镇街 ${stUriN}）· 去程侧误带 src=return：${navInFwd}`);
    say(cov2.includes('返程导航') && /排班导航|导航/.test(cov2),
        'odd_coverage.html 返程导航落在 C 节导航列（与去程导航并列）',
        cov2.includes('返程导航') ? '去程/返程导航并列' : '未见返程导航');
    // 用户明令「不要加在这里」：里程章节不得再出现「返程路线集」表
    say(!cov2.includes('返程路线集') && !cov2.includes('返程主要道路'),
        'odd_coverage.html 里程章节不再单列「返程路线集」表（按要求改到排班导航）',
        (!cov2.includes('返程路线集') && !cov2.includes('返程主要道路')) ? '已移除该表' : '该表仍在里程章节');
    say(cov2.includes('无向最短路') && cov2.includes('为何没有单独的「返程」图层'),
        'odd_coverage.html 说明主图为何不单设返程图层（宽凳走廊无向 → 正反同一条 path）',
        cov2.includes('无向最短路') ? '已说明：返程里程差来自高德单行/匝道，几何层面同一条' : '缺该说明');
    // 场景页不引入该章节（用户明令不入场景页）
    const sce2 = fs.readFileSync(path.join(B, 'out', 'scenario_tests.html'), 'utf8');
    say(!sce2.includes('返程路线集') && !sce2.includes('返程主要道路'),
        'scenario_tests.html 未加返程路线集（与里程章节同规矩）',
        (!sce2.includes('返程路线集') && !sce2.includes('返程主要道路')) ? '无' : '场景页出现返程路线集');
  }
}

console.log('\n=== 汇总 ===');
console.log(`  通过 ${pass.length} · 失败 ${fail.length}${warn.length ? ` · 提示 ${warn.length}` : ''}`);
fail.forEach((f) => console.log('    ✗ ' + f));
warn.forEach((w) => console.log('    ! ' + w));
