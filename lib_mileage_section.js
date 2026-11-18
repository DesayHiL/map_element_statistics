// -*- coding: utf-8 -*-
// 里程口径「正式章节」——**只给覆盖页（odd_coverage.html）用**。
//
// 2026-10-16 用户明令（分两轮）：
//   ① 不要在报告里堆拼盘注释（原 .kmref 五段挤一起）→ 改成正式章节讲清「排班路线为什么是 2,489.8km」；
//   ② 流程图**改成横向**，注意排版；
//   ③「场景专项测试推荐路线」页**不要加**这一节。
//   ⇒ 场景页不再引入本模块（见 build_scenario_html.js 顶部注释）。
'use strict';

const d1 = (v) => {
  if (v == null || !isFinite(Number(v))) return '—';
  const [i, f] = Number(v).toFixed(1).split('.');
  return Number(i).toLocaleString('en-US') + '.' + f;   // 千分位，和 n0 口径一致
};
const n0 = (v) => (v == null || !isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-US'));
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- 横向流程图：6 个环节排成一行，箭头串起 ----------
// 版面：viewBox 1240 宽；6 个 170×90 圆角框，间距 28；左右各留 40。
// 每框 = 1 行标题(12.5px 700) + 最多 3 行小字(11px)，文本左对齐 x+14，行距 17。
function flowSvg(o) {
  const a = o.alloc || {};
  const g = o.kdGate || {};
  const std = o.std || {};
  const BX = [40, 238, 436, 634, 832, 1030];   // 框左边界（170 宽 + 28 间距）
  const W = 170, H = 90, Y = 45;
  const t = (x, dy, s, fill, weight) =>
    `<text x="${x + 14}" y="${Y + dy}" font-size="${weight ? 12.5 : 11}"${weight ? ' font-weight="700"' : ''} fill="${fill}">${s}</text>`;
  const box = (i, primary) =>
    `<rect x="${BX[i]}" y="${Y}" width="${W}" height="${H}" rx="8" fill="${primary ? '#ecfeff' : '#ffffff'}" stroke="${primary ? '#0e7490' : '#cbd5e1'}"${primary ? ' stroke-width="1.6"' : ''}/>`;
  const arrow = (i) =>
    `<line x1="${BX[i] + W + 5}" y1="${Y + H / 2}" x2="${BX[i + 1] - 5}" y2="${Y + H / 2}"` +
    ` stroke="#94a3b8" stroke-width="1.6" marker-end="url(#mfa)"/>`;
  const cT = '#0f172a', cS = '#64748b', pT = '#0e7490', pS = '#155e75';
  return `<svg class="mileflow" viewBox="0 0 1240 176" role="img"
  aria-label="排班里程推导流程（横向）：元素存量 → 配额 → 选路 → 串路线 → 高德实测去程 → 返程 → 空间层 → 排班总账">
 <defs><marker id="mfa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
  <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs>

 ${box(0)}${arrow(0)}
 ${box(1)}${arrow(1)}
 ${box(2)}${arrow(2)}
 ${box(3)}${arrow(3)}
 ${box(4)}${arrow(4)}
 ${box(5, true)}

 ${t(BX[0], 24, '① 元素存量 · 区内实测', cT, 1)}
 ${t(BX[0], 43, '全 28 类逐类统计', cS)}
 ${t(BX[0], 60, '取区内真实存量', cS)}
 ${t(BX[0], 77, '（完整清单见 B 节）', cS)}

 ${t(BX[1], 24, '② 配额 · 该选多少个', cT, 1)}
 ${t(BX[1], 43, '稀缺高危类 → 穷举全选', cS)}
 ${t(BX[1], 60, '常见类 → 抽样 n=139', cS)}
 ${t(BX[1], 77, '（±5% @ 95% 置信）', cS)}

 ${t(BX[2], 24, '③ 选路 · 候选工况道路', cT, 1)}
 ${t(BX[2], 43, `候选命名道路 ${n0(g.candAll)} 条`, cS)}
 ${t(BX[2], 60, `以宽凳为基准 → ${n0(g.kept)} 条`, cS)}
 ${t(BX[2], 77, `标准档选中 ${n0(std.roads)} 条`, cS)}

 ${t(BX[3], 24, '④ 串路线 · 逐镇街', cT, 1)}
 ${t(BX[3], 43, '各镇街一条路线集', cS)}
 ${t(BX[3], 60, '起点 → 途经点 → 终点', cS)}
 ${t(BX[3], 77, `（有可排班路线的 ${n0(o.streets)} 个）`, cS)}

 ${t(BX[4], 24, '⑤ 高德实测 · 去程', cT, 1)}
 ${t(BX[4], 43, `Σ ${n0(o.routeN)} 条路线导航里程`, cS)}
 ${t(BX[4], 60, `去程 = ${d1(o.sumKm)}km`, cS)}
 ${t(BX[4], 77, '（实测算路，非分摊）', cS)}

 ${t(BX[5], 24, '⑥ 空间层 = 去程 + 返程', pT, 1)}
 ${t(BX[5], 43, `去程 ${d1(o.sumKm)} · 返程 ${d1(o.retKm)}`, pS)}
 ${t(BX[5], 60, `= 空间层 ${n0(a.spatialKm)}km`, pS)}
 ${t(BX[5], 77, `＋ 场景加跑 ${n0(a.scenKm)}`, pS)}
</svg>`;
}

// 正式章节：说明「排班路线为什么是 2,489.8km」
function mileageSection(o) {
  const a = o.alloc || {};
  const g = o.kdGate || {};
  const std = o.std || {};
  const retPct = o.retRatio != null ? o.retRatio * 100 : null;   // 返程/去程 百分比
  return `<style>
.mile .mileflow{width:100%;max-width:1240px;height:auto;display:block;margin:2px 0 14px}
.mile .miletab{width:100%;border-collapse:collapse;font-size:12px;margin:0 0 12px}
.mile .miletab th{background:#f1f5f9;text-align:left;padding:6px 7px;border:1px solid #e2e8f0;font-weight:600;white-space:nowrap}
.mile .miletab td{padding:5px 7px;border:1px solid #e2e8f0;vertical-align:top}
.mile .miletab td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.mile .miletab tr.key td{background:#ecfeff;font-weight:600}
.mile .miletab tr.sum td{background:#eef2f7;font-weight:700}
.mile .miletab td.src{color:#64748b;font-size:11px}
</style>
<section class="mile" data-mileflow id="sec-mile">
  <h2>里程口径 · 排班路线为什么是 <b>${n0(a.spatialKm)}km</b><span class="n">元素 → 配额 → 选路 → 串路线 → 去程 → 返程 → 空间层</span></h2>

  <p class="explain">
    <b>结论：空间层 ${n0(a.spatialKm)}km = 去程 ${d1(o.sumKm)}km + 返程 ${d1(o.retKm)}km。</b>
    两侧都是<b>高德驾车实测算路</b>：去程 = 各腿 基地→终点锚点 的导航里程之和；返程 = 把同一条锚点链
    <b>倒序</b>后再<b>重新规划</b>一遍（同一策略）。<b>不是把去程 ×2 估出来的</b> —— 路网有单行/匝道/禁左，
    返程与去程并不相等（本例返程是去程的 ${d1(retPct)}%）。返程的<b>路线</b>也已逐条规划：
    在 C 节每条路线的「导航」列与每个镇街的排班行，除去程导航外各给一条<b>返程导航</b>
    （锚点链倒序后高德实算，源 <code>out/routes_return.json</code>）。
    元素与置信度只决定「<b>该测哪些路</b>」，路选定之后里程由真实路网决定。完整推演见下（① → ⑥）。
  </p>

  ${flowSvg(o)}

  <table class="miletab">
    <tr><th style="width:150px">环节</th><th style="width:230px">数字</th><th>口径 / 出处</th></tr>
    <tr><td>元素存量</td><td class="num">全 28 类</td><td class="src">ODD 元素分类共 28 类（其中 24 类进路线统计，完整清单见 B 节）；各类均取<b>区内真实存量</b>（<code>out/element_calibration.json</code> 的 <code>inArea</code>，由 <code>tools/audit_all_elements.js</code> 独立重算，非各页自报）</td></tr>
    <tr><td>配额 · 该测多少</td><td class="num">稀缺类全选 · 常见类 n=139</td><td class="src">稀缺高危类（区内 &lt;50）穷举全选；常见类按 <code>n = z²p(1−p)/e²</code> 取 139（±5% @ 95% 置信）· <code>select_odd.js</code></td></tr>
    <tr><td>候选工况道路</td><td class="num">${n0(g.candAll)} → ${n0(g.kept)} 条</td><td class="src">候选命名道路<b>以宽凳高精地图为基准</b> —— 只有宽凳有路的才跑（采样点距宽凳路 ≤ ${g.band || 30}m、覆盖率 ≥ ${g.coverMin || 0.5}）→ 剔除 ${n0(g.dropped)} 条 / ${d1(g.dropKm)}km</td></tr>
    <tr><td>标准档选中道路</td><td class="num">${n0(std.roads)} 条</td><td class="src">选中工况道路中心线 ${d1(std.selCenterKm)}km · 双向 ${d1(std.selBidirKm)}km（<code>odd_selection.tiers.std</code>）</td></tr>
    <tr><td>排班路线</td><td class="num">${n0(o.routeN)} 条 · ${n0(o.streets)} 个镇街</td><td class="src">每镇街一条路线集（起点 → 途经点 → 终点 锚点链，同镇街多腿首尾相接）· <code>out/routes.json</code></td></tr>
    <tr class="key"><td>去程</td><td class="num">${d1(o.sumKm)}km</td><td class="src">Σ ${n0(o.routeN)} 条路线的<b>高德实测算路</b>里程（基地 → 途经点 → 终点锚点 单向；不是按元素数分摊）</td></tr>
    <tr class="key"><td>返程</td><td class="num">${d1(o.retKm)}km</td><td class="src">把同一批锚点链<b>倒序</b>后<b>重新规划</b>（同 <code>strategy=3</code>、逐腿）· 里程 <code>out/route_return_legs.json</code> · 返程路线（几何/道路名）<code>out/routes_return.json</code> · 返程/去程 = ${d1(retPct)}%（逐条返程导航见 C 节）</td></tr>
    <tr class="key"><td>空间层（双向）</td><td class="num">${n0(a.spatialKm)}km</td><td class="src">= 去程 + 返程 = ${d1(o.sumKm)} + ${d1(o.retKm)}（工况道路正、反各跑一遍，<b>两侧分别实测</b>，不用去程翻倍估算）</td></tr>
    <tr><td>场景加跑</td><td class="num">${n0(a.scenKm)}km</td><td class="src">= 2 ×（场景去程 ${d1(o.scenKm)} + 场景返程 ${d1(o.scenRetKm)}）= 双向 × 3 时段 − 空间层已含 1 遍</td></tr>
    <tr class="sum"><td>排班总账</td><td class="num">${n0(a.totalKm)}km</td><td class="src">= 空间层 ${n0(a.spatialKm)} + 场景加跑 ${n0(a.scenKm)}</td></tr>
  </table>

  <div class="explain">
    <b>三个「里程」别混</b>：
    <b>全区路网 · 双向 ${n0(a.netBidirKm)}km</b>（家底，每条路只计一次，<b>不排班</b>）
    ⊃ <b>全量穷举 ${n0(a.exhaustKm)}km</b>（${n0(a.candRoads)} 条候选命名道路全跑双向）
    ⊃ <b>本排班 ${n0(a.totalKm)}km</b>（从中挑 ${n0(std.roads)} 条 + 场景加跑，省 ${n0(a.savePct)}%）。
    排班是<b>从家底里挑样本</b>，不是把整个惠城区跑完。
  </div>

  <div class="explain">
    <b>这套数字证明了什么 · 没证明什么</b>：<b>n=139 / ±5% @ 95% 置信</b> 是<b>抽样估计精度</b> ——
    它保证「元素覆盖比例」这个结论可以说到 ±5 个百分点，即<b>样本量够、覆盖结论可信</b>；
    它<b>不等于</b>单条路线达到验收标准。路线验收另有独立判据（单路线来回次数、各时段覆盖、
    有效试验时长、地图缺陷闭环等），见路线验收标准文档。里程是「跑这些路要花多远」的预算，不是合格证。
  </div>
</section>`;
}

module.exports = { mileageSection, flowSvg };
