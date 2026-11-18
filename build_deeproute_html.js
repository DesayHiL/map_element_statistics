// build_deeproute_html.js —— deeproute 专页生成器（读 out/deeproute_plan.json，唯一快照来源）
// 2026-11-17 按 odd_coverage.html 形态重做：section 体系 + banner 统计卡 + iframe srcdoc 内嵌单图页。
// 独立交付页：不进 audit_data.js 链，不动现有 4 份交付页。
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const OUT = path.join(ROOT, 'out');

const plan = JSON.parse(fs.readFileSync(path.join(OUT, 'deeproute_plan.json'), 'utf8'));
let routes = plan.routes;
const totalKm = +routes.reduce((s, r) => s + r.distKm, 0).toFixed(1);
const totalMin = routes.reduce((s, r) => s + r.durMin, 0);
const totalH = (totalMin / 60).toFixed(1);
const totalPr = routes.reduce((s, r) => s + r.anchors.reduce((x, a) => x + (a.pr || 0), 0), 0);
const nAnchors = routes.reduce((s, r) => s + r.anchors.length, 0);
// 校验：快照 totalKm 与逐条求和必须一致（铁律 3）
if (Math.abs(totalKm - plan.totalKm) > 0.5) throw new Error(`快照总里程 ${plan.totalKm} ≠ 逐条求和 ${totalKm}`);
// 执行序：贪心，起点=离基地最近的条，后续每步选离当前条终点最近的下一条
const BASE = [114.481764, 23.000014];
function distM(a, b) {
  const R = 6371008.8, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const remaining = routes.slice();
const seq = [];
let ref = BASE;
while (remaining.length) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < remaining.length; i++) {
    const d = distM(ref, remaining[i].stops[0].gcj);
    if (d < bd) { bd = d; bi = i; }
  }
  const r = remaining.splice(bi, 1)[0];
  seq.push(r);
  ref = r.stops[3].gcj;
}
routes = seq; // 重排为执行序
// 转场统计
let transferKm = 0;
const transfers = [];
for (let i = 1; i < routes.length; i++) {
  const t = distM(routes[i - 1].stops[3].gcj, routes[i].stops[0].gcj) / 1000;
  transferKm += t;
  transfers.push({ from: routes[i - 1].name, to: routes[i].name, km: t });
}
const days = [];
let cur = [], curKm = 0;
for (const r of routes) {
  if (curKm + r.distKm > 165 && cur.length) { days.push(cur); cur = []; curKm = 0; }
  cur.push(r); curKm += r.distKm;
}
if (cur.length) days.push(cur);

// ---------- E 区：宽凳路网主图（内嵌 deeproute_kd_routes.html）----------
// iframe srcdoc 内嵌（与 odd_coverage E 区同款）：独立文档上下文，样式不互相污染。
// srcdoc 是属性值：只需转义 & 与 "（浏览器会反解回原文，脚本照常执行）
const kdPath = path.join(OUT, 'deeproute_kd_routes.html');
const kdHtml = fs.existsSync(kdPath) ? fs.readFileSync(kdPath, 'utf8') : null;
const embedCss = `<style id="__embed__">
.wrap{grid-template-columns:1fr !important}
#mapbox{height:600px !important}
aside{height:auto !important;max-height:520px !important}
</style>
<script id="__fitb__">
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
 addEventListener('load',function(){setTimeout(fitRoutes,700);setTimeout(fitRoutes,1500);});
})();
</script>`;
const kdAttr = kdHtml
  ? kdHtml.replace(/<\/head>/, embedCss + '</head>').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  : '';
const kdKB = kdHtml ? (kdHtml.length / 1024).toFixed(0) : 0;

// ---------- 路线明细表（执行序） ----------
const PALETTE = ['#1f4e9c', '#8a5a00', '#0f6b6b', '#7a2f6b', '#6b3fa0', '#7a4a2b',
  '#a81f7a', '#4a5568', '#7a7a12', '#0e7c8c', '#2f3570', '#4a5c5f',
  '#6b5312', '#3b3b6b', '#5a2f5c', '#1d6fa5', '#14507a', '#3f3f46'];
const rows = routes.map((r, i) => {
  const col = PALETTE[i % PALETTE.length];
  const day = days.findIndex((d) => d.includes(r)) + 1;
  const stops = r.stops.map((s) =>
    `<span class="stop">${s.name}<i>(${s.gcj[0].toFixed(6)},${s.gcj[1].toFixed(6)})</i></span>`).join('<span class="arrow">→</span>');
  const kinds = {};
  for (const a of r.anchors) kinds[a.label] = (kinds[a.label] || 0) + 1;
  const kindsStr = Object.entries(kinds).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k}×${n}`).join(' · ');
  const uri = r.uri || '#';
  return `<tr>
<td class="num" style="white-space:nowrap"><span class="gid" style="background:${col}">${i + 1}</span> <b>${r.name}</b></td>
<td class="num">D${day}</td>
<td class="num">${r.distKm.toFixed(1)}</td>
<td class="num">${Math.round(r.durMin / 60 * 10) / 10}h</td>
<td>${stops}</td>
<td>${kindsStr}</td>
<td>${r.roads.slice(0, 6).join('、')}${r.roads.length > 6 ? '…' : ''}</td>
<td><a href="${uri}" target="_blank">导航 ↗</a></td>
</tr>`;
}).join('');

// ---------- 7 天排班表 ----------
const dayRows = days.map((d, i) => {
  const km = d.reduce((s, r) => s + r.distKm, 0).toFixed(1);
  const h = (d.reduce((s, r) => s + r.durMin, 0) / 60).toFixed(1);
  return `<tr><td>第 ${i + 1} 天</td><td>${d.map((r) => r.name).join(' + ')}</td><td class="num">${km}</td><td class="num">${h}h</td></tr>`;
}).join('');
// 转场表（>8km 高亮）
const bigTransfers = transfers.filter((t) => t.km > 8);
const transferRows = transfers.map((t) =>
  `<tr${t.km > 8 ? ' class="warn-t"' : ''}><td>${t.from} → ${t.to}</td><td class="num">${t.km.toFixed(1)}</td></tr>`).join('');

// ---------- banner 统计卡 ----------
const avgKm = Math.round((totalKm / routes.length) * 10) / 10;
const banner = `
<div class="banner">
  <div class="bn"><div class="v">${totalKm}</div><div class="l">总里程 km（快照声明）</div></div>
  <div class="bn"><div class="v">${routes.length}</div><div class="l">路线条数</div></div>
  <div class="bn"><div class="v">${totalH}</div><div class="l">纯行驶时长 h</div></div>
  <div class="bn"><div class="v">${avgKm}</div><div class="l">平均条长 km</div></div>
  <div class="bn"><div class="v">${nAnchors}</div><div class="l">覆盖锚点（学校/医院/桥梁/隧道…）</div></div>
  <div class="bn"><div class="v">${totalPr.toLocaleString()}</div><div class="l">pr 价值覆盖合计</div></div>
  <div class="bn ref"><div class="v">${transferKm.toFixed(0)}</div><div class="l">条间转场合计 km（不计测试里程）</div></div>
</div>`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>deeproute 惠城区专项测试路线（${totalKm}km / ${routes.length} 条）</title>
<style>
  :root{--acc:#0e7490;--mut:#64748b;--line:#e2e8f0;--bg:#f8fafc;--ok:#15803d;--warn:#b45309;--bad:#b91c1c;}
  *{box-sizing:border-box}
  body{margin:0;padding:22px 26px 60px;background:var(--bg);color:#0f172a;
    font:13px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;}
  h1{font-size:19px;margin:0 0 4px}
  .sub{color:var(--mut);font-size:12px;margin-bottom:14px}
  .banner{display:grid;grid-template-columns:repeat(7,1fr);gap:10px;margin:12px 0 10px}
  .bn{background:#fff;border:1px solid var(--line);border-radius:8px;padding:9px 12px}
  .bn.ref{background:#f8fafc;border-style:dashed;border-color:#cbd5e1}
  .bn.ref .v{color:#475569}
  .bn .v{font-size:19px;font-weight:700;color:var(--acc)}
  .bn .l{font-size:11px;color:var(--mut);margin-top:1px}
  section{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:16px}
  h2{font-size:15px;margin:0 0 10px;padding-bottom:7px;border-bottom:1px solid var(--line)}
  h2 .n{font-weight:400;font-size:11px;color:var(--mut);margin-left:8px}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{background:#f1f5f9;text-align:left;padding:6px 7px;border:1px solid var(--line);font-weight:600;white-space:nowrap}
  td{padding:5px 7px;border:1px solid var(--line);vertical-align:top}
  td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  tr.sumrow td{background:#ecfeff;font-weight:700}
  .warn-t td{background:#fff7ed}
  .stop{display:inline-block;background:#f0f4f8;border-radius:4px;padding:0 5px;margin:1px 2px 1px 0;font-size:11.5px}
  .stop i{font-style:normal;color:var(--mut);font-size:10.5px}
  .arrow{color:#94a3b8;margin:0 2px}
  .gid{display:inline-block;min-width:18px;padding:0 4px;border-radius:4px;color:#fff;font-size:10.5px;font-weight:700;text-align:center;line-height:15px}
  .explain{font-size:12px;color:var(--mut);margin:0 0 10px;line-height:1.8}
  .kd-frame{width:100%;height:88vh;min-height:620px;border:1px solid var(--line);border-radius:8px;background:#fff;display:block}
  footer{color:var(--mut);font-size:11px;line-height:1.8;margin-top:22px;border-top:1px solid var(--line);padding-top:12px}
  a{color:#1557db;text-decoration:none}a:hover{text-decoration:underline}
  #secnav{position:sticky;top:0;z-index:50;display:flex;gap:6px;background:rgba(248,250,252,.96);padding:8px 0;border-bottom:1px solid var(--line);margin-bottom:6px;flex-wrap:wrap}
  #secnav a{font-size:12px;padding:2px 10px;border:1px solid var(--line);border-radius:999px;background:#fff}
</style>
</head>
<body>
<h1>deeproute 惠城区专项测试路线</h1>
<div class="sub">场景价值优先 · 一周 ${totalKm} km · 每条 ≈60km、4 站点切 3 段连续执行 · 数据快照 out/deeproute_plan.json（${plan.generated}）· 生成 ${new Date().toLocaleString('zh-CN')}</div>
${banner}

<div id="secnav"><a href="#sec-0">口径</a><a href="#sec-e">主图</a><a href="#sec-s">排班</a><a href="#sec-t">转场</a><a href="#sec-r">路线明细</a></div>

<section id="sec-0">
  <h2>0 · 规划口径<span class="n">怎么读这份交付</span></h2>
  <p class="explain">
  规划目标：一周 1000km <b>高价值连续</b>测试路线。价值优先（pr 加权：隧道 9 / 环岛 8 / 学校·医院 7 / 立交·施工 6 / 工况路按排班 pr），全区 KMeans 分簇一簇一线，条内 3 段 4 站点、其余自由途经；相邻簇首尾衔接，无中途空驶。<br>
  数据源：OSM + 高德 POI + 排班锚点池（区内 + 宽凳路网 80m 闸门），导航策略不走高速（strategy=3）。<br>
  里程/时长来自高德驾车规划，与 ODD 排班四条里程口径<b>相互独立</b>；本页为 deeproute 专项交付，不替代 ODD 覆盖排班（out/odd_coverage.html）。医院/学校按「途经周边」口径非驻点。</p>
</section>

${kdHtml ? `
<section id="sec-e">
  <h2>E · 专项路线 × 宽凳路网（主图）<span class="n">${routes.length} 条专项路线 · ${kdKB}KB 原页内嵌 · 可缩放 / 拖动 / 逐层开关</span></h2>
  <p class="explain"><b>灰</b> = 宽凳路网（全部 ROAD_LINK）· <b>红</b> = ${routes.length} 条专项路线（高德 GCJ02 折线）· <b>绿/橙/深红点</b> = 起点/站点/终点，标号 = 路线号（1–${routes.length}）。滚轮缩放、拖动、图例逐层开关；点击明细行描出该路线站点并高亮折线。</p>
  <iframe class="kd-frame" srcdoc="${kdAttr}" loading="lazy" title="专项路线 × 宽凳路网"></iframe>
  <p class="explain" style="margin-top:8px">原页 <code>out/deeproute_kd_routes.html</code>（由 <code>tools/render_deeproute_v1.py</code> 生成）· 本页为其内嵌副本，数据同源（out/deeproute_plan.json）。</p>
</section>` : ''}

<section id="sec-s">
  <h2>S · 7 天排班<span class="n">${days.length} 天 · 转场 ${transferKm.toFixed(0)}km 不计测试里程</span></h2>
  <table>
  <tr><th>日期</th><th>路线</th><th>里程 km</th><th>纯行驶</th></tr>
  ${dayRows}
  <tr class="sumrow"><td>合计</td><td>${routes.length} 条</td><td class="num">${totalKm}</td><td class="num">${totalH}h</td></tr>
  </table>
</section>

<section id="sec-t">
  <h2>T · 条间转场<span class="n">${transfers.length} 段 · >8km 高亮</span></h2>
  <p class="explain">转场 = 上一条终点 → 下一条起点的直线距离（不计入测试里程）。&gt;8km 的段为远郊链尾大转场，日安排时可用工程车接驳或调整执行序。</p>
  <table>
  <tr><th>转场</th><th>km</th></tr>
  ${transferRows}
  <tr class="sumrow"><td>合计（${bigTransfers.length} 段 &gt;8km）</td><td class="num">${transferKm.toFixed(1)}</td></tr>
  </table>
</section>

<section id="sec-r">
  <h2>R · 路线明细（${routes.length} 条，执行序）<span class="n">起点 → 站点 → 终点 · 坐标可跨平台搜索</span></h2>
  <table>
  <tr><th>路线</th><th>日</th><th>km</th><th>时长</th><th>起点 → 站点 → 终点</th><th>覆盖锚点</th><th>主要途经路</th><th>导航</th></tr>
  ${rows}
  <tr class="sumrow"><td>合计</td><td>—</td><td class="num">${totalKm}</td><td class="num">${totalH}h</td><td colspan="4">${nAnchors} 覆盖锚点 · pr 合计 ${totalPr.toLocaleString()}</td></tr>
  </table>
</section>

<footer>生成器：build_deeproute_html.js（汇总页）+ tools/render_deeproute_v1.py（单图页）· 数据快照：out/deeproute_plan.json · 独立于 ODD 排班交付链（不动 odd_coverage.html / scenario_tests.html / report_alloc.json）。</footer>
</body>
</html>`;
fs.writeFileSync(path.join(OUT, 'deeproute_routes.html'), html);
console.log(`[out] out/deeproute_routes.html · ${routes.length} 条 · ${totalKm}km · ${days.length} 天 · 内嵌单图页 ${kdKB}KB`);