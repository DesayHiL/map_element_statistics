// 惠城区 5G 信号弱区分析 · 高德底图交互页
// 数据：惠州全量站点（联通 3931 / 电信 1757，官方接口，BD-09 已转 GCJ-02，存于工程根 data_5g_*.json）+ 51 条排班路线
// 产出：out/official_5g_coverage.html
// 口径：
//  - 站点用【惠州全量】（早期版本被矩形 114.30-114.50 裁掉潼湖/沥林西侧，已修正）
//  - 弱信号 = 路线上离最近官方 5G 站 >1km 的路段（站点距离代理指标，非实测）
//  - 站点位置 ≠ 信号覆盖；空白≠无信号；移动无公开网页接口未含
const fs = require('fs');
const path = require('path');
const { loadAreas, pointInPolygon } = require('./street_areas.js');

const OUT = path.join(__dirname, 'out', 'official_5g_coverage.html');
const { KEYS } = require('./amap_key.js');
const JS_KEY = KEYS[0];
const SEC_FILE = path.join(__dirname, 'amap_jscode.txt');
const SEC_CODE = fs.existsSync(SEC_FILE) ? fs.readFileSync(SEC_FILE, 'utf8').trim() : '';

// ---------- 数据加载（惠州全量，不裁街道/矩形） ----------
const areas = loadAreas();
const streetOf = (lon, lat) => {
  for (const a of Object.values(areas)) if (a.polygons && pointInPolygon(lon, lat, a.polygons)) return a.name;
  return null;
};

// 联通（官方覆盖地图接口，惠州全量 3931）
const cuPts = JSON.parse(fs.readFileSync(path.join(__dirname, 'data_5g_cu_huizhou_full.json'), 'utf8'))
  .map(([lon, lat]) => ({ lon, lat, street: streetOf(lon, lat) }));
console.log(`联通 5G 站（惠州全量）：${cuPts.length}`);

// 电信（官方热力接口，惠州全量 1757）
const ctPts = JSON.parse(fs.readFileSync(path.join(__dirname, 'data_5g_ct_huizhou_full.json'), 'utf8'))
  .map(([lon, lat]) => ({ lon, lat, street: streetOf(lon, lat) }));
console.log(`电信 5G 站（惠州全量）：${ctPts.length}`);

// 惠城区内站点（用于图层展示；距离计算仍用全量）
const cuHc = cuPts.filter(p => p.street);
const ctHc = ctPts.filter(p => p.street);
console.log(`惠城区内：联通 ${cuHc.length} · 电信 ${ctHc.length}`);

const allStations = [...cuPts, ...ctPts].map(p => [p.lon, p.lat]);

// ---------- 路线 ----------
const ROUTES = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'routes.json'), 'utf8'));
const polys = [];
for (const r of Object.values(ROUTES.routes || {})) for (const leg of r.routes || []) if (leg.poly && leg.poly.length) polys.push(leg.poly);

// ---------- 距离工具 + 网格加速 ----------
const distM = (a, b) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * 110540);
// 基站空间网格（500m）加速最近站查询
const SGRID = 0.0045;
const sgrid = new Map();
for (const s of allStations) {
  const k = `${Math.floor(s[0] / SGRID)}_${Math.floor(s[1] / SGRID)}`;
  if (!sgrid.has(k)) sgrid.set(k, []);
  sgrid.get(k).push(s);
}
function nearDist(pt) {
  const gx = Math.floor(pt[0] / SGRID), gy = Math.floor(pt[1] / SGRID);
  let best = Infinity;
  for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
    const arr = sgrid.get(`${gx + dx}_${gy + dy}`);
    if (!arr) continue;
    for (const s of arr) { const d = distM(pt, s); if (d < best) best = d; }
  }
  if (best === Infinity) { // 3 格(≈1.4km)内无站，全量兜底
    for (const s of allStations) { const d = distM(pt, s); if (d < best) best = d; }
  }
  return best;
}

// ---------- 路线分段着色：按离最近基站距离切弱段 ----------
// 阈值：>1000m 红(弱) / <1000m 灰(有站)；只统计惠城区 18 街道内的路段，区外不着色不计数
// 距离计算仍用惠州全量站点（含仲恺等邻区站），避免把区界旁误判成无站
const T1 = 1000;
const thin = (poly) => {
  const outp = [poly[0]];
  for (const p of poly) if (distM(outp[outp.length - 1], p) > 80) outp.push(p);
  return outp;
};
// 每条折线带逐点最近站距离；区外点标记 -1（不渲染不计数）
const routeSegs = polys.map(poly => {
  const pts = thin(poly).map(p => {
    const inHc = streetOf(p[0], p[1]) !== null;
    if (!inHc) return [p[0], p[1], -1];
    return [p[0], p[1], Math.round(nearDist(p))];
  });
  return { pts };
});
// 汇总弱段（>1km 连续段，供清单；区外点切断 run）
const weakRuns = [];
for (const seg of routeSegs) {
  let run = null;
  for (const p of seg.pts) {
    if (p[2] > T1) {
      if (!run) run = { start: [p[0], p[1]], end: [p[0], p[1]], n: 1, maxD: p[2] };
      else { run.end = [p[0], p[1]]; run.n++; run.maxD = Math.max(run.maxD, p[2]); }
    } else if (run) { weakRuns.push(run); run = null; }
  }
  if (run) weakRuns.push(run);
}
weakRuns.forEach(r => {
  r.street = streetOf(r.start[0], r.start[1]) || '';
  r.lenKm = +(distM(r.start, r.end) / 1000).toFixed(1);
});
const weakKmTotal = weakRuns.reduce((s, r) => s + r.lenKm, 0);
// 全部路线采样点统计（仅惠城区内）
let nWeak = 0, nOk = 0;
for (const s of routeSegs) for (const p of s.pts) { if (p[2] > T1) nWeak++; else if (p[2] >= 0) nOk++; }
console.log(`惠城区内路线采样点：弱(>1km) ${nWeak} · 有站(≤1km) ${nOk}；弱段 ${weakRuns.length} 段，合计约 ${weakKmTotal.toFixed(1)}km`);

// 弱段按 maxD 排序列表（取 top）
const weakList = [...weakRuns].sort((a, b) => b.maxD - a.maxD).slice(0, 20);

// ---------- HTML ----------
const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>惠城区 5G 弱信号路段分析（运营商官方）</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Microsoft YaHei",sans-serif;background:#f1f5f9;color:#1e293b}
.hd{background:#18202e;color:#fff;padding:14px 22px}
.hd h1{font-size:21px;font-weight:600}
.hd p{font-size:13px;color:#aab6c8;margin-top:4px}
.wrap{display:flex;gap:14px;padding:14px 22px;align-items:flex-start}
#map{width:1180px;height:820px;border-radius:8px;box-shadow:0 1px 6px rgba(0,0,0,.12);flex:none}
.side{flex:1;min-width:340px;display:flex;flex-direction:column;gap:12px;max-height:850px;overflow-y:auto}
.card{background:#fff;border-radius:8px;padding:14px 16px;box-shadow:0 1px 6px rgba(0,0,0,.08)}
.card h2{font-size:15px;margin-bottom:10px;color:#18202e}
.kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.kpi{background:#f8fafc;border-radius:6px;padding:8px 10px}
.kpi b{display:block;font-size:22px;color:#18202e}
.kpi span{font-size:12px;color:#64748b}
.kpi b.red{color:#dc2626}
.lgd{display:flex;flex-wrap:wrap;gap:10px;font-size:12.5px;margin-bottom:10px}
.lgd i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:4px;vertical-align:-1px}
label{display:flex;align-items:center;gap:6px;font-size:13px;padding:5px 8px;background:#f8fafc;border-radius:6px;margin-bottom:6px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{padding:5px 8px;text-align:right;border-bottom:1px solid #eef2f7}
th:first-child,td:first-child{text-align:left}
th{color:#64748b;font-weight:500}
.note{font-size:12.5px;color:#64748b;line-height:1.7;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:8px 10px;margin-top:10px}
</style></head><body>
<div class="hd"><h1>惠城区 5G 弱信号路段 · 运营商官方数据分析</h1>
<p>范围：惠城区 18 街道 · 联通 ${cuHc.length} 站 + 电信 ${ctHc.length} 站（区内）· ${polys.length} 条排班路线按离最近基站距离分段着色（距离计算含邻区站，避免区界误判）· 2026-11-04 拉取</p></div>
<div class="wrap">
<div id="map"></div>
<div class="side">
<div class="card"><h2>指标</h2>
<div class="kpis">
<div class="kpi"><b class="red">${weakRuns.length}</b><span>弱信号路段（离站&gt;1km）</span></div>
<div class="kpi"><b class="red">${weakKmTotal.toFixed(1)}km</b><span>弱段合计里程（直线）</span></div>
<div class="kpi"><b>${nWeak}</b><span>弱采样点（>1km）</span></div>
<div class="kpi"><b>${nOk}</b><span>有站采样点（≤1km）</span></div>
</div>
<div class="lgd" style="margin-top:12px">
<span><i style="background:#dc2626;height:3px;width:16px"></i>弱信号段（离站&gt;1km，重点实测）</span>
<span><i style="background:#94a3b8;height:3px;width:16px"></i>周边有站（≤1km）</span>
<span><i style="background:#e87c22;border-radius:50%"></i>联通站</span>
<span><i style="background:#7b4ac0;border-radius:50%"></i>电信站</span>
</div>
<label><input type="checkbox" id="lyRoute" checked> 路线分段着色（仅惠城区内）</label>
<label><input type="checkbox" id="lyCu"> 联通站点（区内 ${cuHc.length}）</label>
<label><input type="checkbox" id="lyCt"> 电信站点（区内 ${ctHc.length}）</label>
<label><input type="checkbox" id="lyHeat"> 站点密度热力图</label>
</div>
<div class="card"><h2>弱信号路段 TOP20（按离站最远排序）</h2>
<table><tr><th>#</th><th>街道</th><th>里程km</th><th>最远离站</th><th>位置</th></tr>
${weakList.map((r, i) => `<tr><td>${i + 1}</td><td>${r.street || '惠城区'}</td><td>${r.lenKm}</td><td><b style="color:#dc2626">${(r.maxD / 1000).toFixed(1)}km</b></td><td>${r.start[0].toFixed(4)},${r.start[1].toFixed(4)}</td></tr>`).join('')}
</table></div>
<div class="card"><h2>口径说明</h2>
<div class="note">
· 范围：<b>惠城区 18 街道</b>内。站点图层与弱段统计仅取区内；但「离最近基站距离」用<b>惠州全量站点</b>计算（联通 3931 + 电信 1757），邻区站（仲恺等）同样计入距离，避免区界旁被误判为无站<br>
· 数据源：联通 <b>getbusinessHallDetail_new</b>、电信 <b>fiveGBaseStation.do queryHeatMap</b> 官方接口，2026-11-04 拉取<br>
· <b>弱信号判定</b>：惠城区内路线上采样点离最近官方 5G 站 &gt;1km 标红，≤1km 灰色。是<b>站点距离代理指标</b>，非实测信号强度<br>
· 红色路段 = 两家运营商官方数据中周边均无 5G 站标注，<b>优先安排 Cellular-Z 实测</b>验证<br>
· 站点位置 ≠ 信号覆盖，覆盖受功率/遮挡/负载影响；红段 ≠ 必然无信号<br>
· 移动无公开网页接口，本图未含
</div></div>
</div></div>
${SEC_CODE ? `<script>window._AMapSecurityConfig={securityJsCode:'${SEC_CODE}'}</script>` : ''}
<script src="https://webapi.amap.com/maps?v=2.0&key=${JS_KEY}&plugin=AMap.HeatMap"></script>
<script>
const cuPts=${JSON.stringify(cuHc)};
const ctPts=${JSON.stringify(ctHc)};
const routeSegs=${JSON.stringify(routeSegs)};
const map=new AMap.Map('map',{viewMode:'2D',zoom:12.2,center:[114.42,23.10]});

// ① 路线分段着色：红=离站>1km 弱信号；灰=有站；d=-1 为区外段不渲染
const routeOverlays=[];
for(const seg of routeSegs){
  const pts=seg.pts;
  for(let i=0;i<pts.length-1;i++){
    const a=pts[i][2],b=pts[i+1][2];
    if(a<0&&b<0)continue; // 区外段
    const d=Math.max(a<0?0:a,b<0?0:b);
    const line=new AMap.Polyline({
      path:[new AMap.LngLat(pts[i][0],pts[i][1]),new AMap.LngLat(pts[i+1][0],pts[i+1][1])],
      strokeColor:d>1000?'#dc2626':'#94a3b8',strokeWeight:d>1000?5:3,strokeOpacity:d>1000?0.95:0.6,
      extData:{d:d,lon:pts[i][0],lat:pts[i][1]}});
    line.setMap(map);routeOverlays.push(line);
  }
}
routeOverlays.forEach(o=>o.on('click',function(e){const d=e.target.getExtData();
  new AMap.InfoWindow({content:'<div style="font-size:12px;line-height:1.7">该处离最近官方 5G 站：<b style="color:'+(d.d>1000?'#dc2626':'#334155')+'">'+(d.d/1000).toFixed(2)+' km</b>'+(d.d>1000?'<br>弱信号风险，建议 Cellular-Z 实测':'')+'</div>'}).open(map,[d.lon,d.lat]);}));

// ② 联通站（橙，默认隐藏）
const cuOverlays=cuPts.map(p=>new AMap.CircleMarker({center:[p.lon,p.lat],radius:3.5,strokeColor:'#fff',strokeWeight:0.6,fillColor:'#e87c22',fillOpacity:0.85}));
// ③ 电信站（紫，默认隐藏）
const ctOverlays=ctPts.map(p=>new AMap.CircleMarker({center:[p.lon,p.lat],radius:3.5,strokeColor:'#fff',strokeWeight:0.6,fillColor:'#7b4ac0',fillOpacity:0.85}));

// ④ 热力图（默认关，区内站点密度）
const heatLayer=new AMap.HeatMap(map,{radius:80,opacity:[0,0.5],gradient:{0:'#60a5fa',0.4:'#4ade80',0.7:'#f59e0b',1:'#dc2626'}});
heatLayer.setDataSet({data:[...cuPts.map(p=>({lng:p.lon,lat:p.lat,count:1})),...ctPts.map(p=>({lng:p.lon,lat:p.lat,count:1}))],max:4});
heatLayer.setMap(null);

// 图层开关
const bindArr=(id,arr)=>{document.getElementById(id).addEventListener('change',e=>{
  arr.forEach(o=>e.target.checked?o.setMap(map):o.setMap(null));});};
bindArr('lyCu',cuOverlays);bindArr('lyCt',ctOverlays);
document.getElementById('lyRoute').addEventListener('change',e=>routeOverlays.forEach(o=>e.target.checked?o.setMap(map):o.setMap(null)));
document.getElementById('lyHeat').addEventListener('change',e=>heatLayer.setMap(e.target.checked?map:null));
</script>
</body></html>`;
fs.writeFileSync(OUT, html);
console.log(`out/official_5g_coverage.html ${(html.length / 1024).toFixed(0)}KB`);