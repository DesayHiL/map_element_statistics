// 惠城区蜂窝信号热力图：OpenCelliD 基站密度 → 500m 网格聚合 → 叠加排班路线 + 弱区标注
// 数据: data/cellid_huicheng_raw.json (OpenCelliD, 2880 cells)
// 产出: out/signal_coverage.html
// 判定口径: 基站位置 ≠ 信号覆盖，密度热力图只用于「哪里可能弱」的预筛；
//           NR(5G) 单独分层；弱区 = 500m 网格内基站数 ≤1 的格子（重点标注）
const fs = require('fs');
const path = require('path');
const { loadAreas, pointInPolygon } = require('./street_areas.js');

const RAW = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'cellid_huicheng_raw.json'), 'utf8'));
const ROUTES = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'routes.json'), 'utf8'));
const OUT = path.join(__dirname, 'out', 'signal_coverage.html');

const MNC_NAME = { 0: '移动', 1: '联通', 11: '电信', 2: '移动', 8: '联通', 15: '宽带', 20: '铁通' };
const RADIO_NAME = { NR: '5G NR', LTE: '4G', UMTS: '3G', GSM: '2G' };

// ---------- 街道过滤（只保留惠城区 18 街道内基站）----------
const areas = loadAreas();
const inHuicheng = (lon, lat) => Object.values(areas).some(a => a.polygons && pointInPolygon(lon, lat, a.polygons));
const cells = RAW.cells.filter(c => isFinite(c.lat) && isFinite(c.lon) && inHuicheng(c.lon, c.lat));
console.log(`OpenCelliD 基站：总 ${RAW.cells.length} → 惠城区街道内 ${cells.length}`);

// ---------- 500m 网格聚合 ----------
const GRID = 0.0045; // ≈500m
const gkey = (lon, lat) => `${Math.floor(lon / GRID)}_${Math.floor(lat / GRID)}`;
const grid = new Map();
for (const c of cells) {
  const k = gkey(c.lon, c.lat);
  if (!grid.has(k)) grid.set(k, { lon: 0, lat: 0, n: 0, nr: 0, mnc: {} });
  const g = grid.get(k);
  g.lon += c.lon; g.lat += c.lat; g.n++;
  if (c.radio === 'NR') g.nr++;
  const op = MNC_NAME[c.mnc] || ('MNC' + c.mnc);
  g.mnc[op] = (g.mnc[op] || 0) + 1;
}
const grids = [...grid.values()].map(g => ({ lon: g.lon / g.n, lat: g.lat / g.n, n: g.n, nr: g.nr, mnc: g.mnc }));

// ---------- 弱区判定 ----------
// 口径：网格内基站 ≤1（500m 半径内几乎无记录基站）→ 弱区候选
// 注意 OpenCelliD 采样稀疏（中位 samples=1），「弱区」实为「众包盲区」，
// 城区大概率信号正常但无人上报；郊野山地的弱区可信度更高
const weak = grids.filter(g => g.n <= 1);
const ok = grids.filter(g => g.n > 1);
console.log(`网格：总 ${grids.length}，弱区(≤1 基站) ${weak.length}，正常 ${ok.length}`);

// ---------- 排班路线折线（提取全部 leg poly）----------
const polys = [];
for (const r of Object.values(ROUTES.routes || {})) {
  for (const leg of r.routes || []) {
    if (leg.poly && leg.poly.length) polys.push(leg.poly);
  }
}
console.log(`排班路线折线：${polys.length} 条`);

// ---------- 路线穿越弱区检测 ----------
const distM = (a, b) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * 110540);
// 折线抽稀到 ~100m 间隔再测距（poly 点很密）
const thin = (poly) => {
  const out = [poly[0]];
  for (const p of poly) if (distM(out[out.length - 1], p) > 100) out.push(p);
  return out;
};
const routeWeakHits = [];
for (const g of weak) {
  for (let i = 0; i < polys.length; i++) {
    const t = thin(polys[i]);
    if (t.some(p => distM(p, [g.lon, g.lat]) < 500)) {
      routeWeakHits.push({ grid: g, polyIdx: i });
      break;
    }
  }
}
console.log(`路线 500m 内穿过的弱区格：${routeWeakHits.length}`);

// 给场景页消费的结构化结果：按街道汇总弱网命中格，避免从 HTML 反解析。
// ---------- 归属街道 ----------
const streetOf = (lon, lat) => {
  for (const a of Object.values(areas)) if (a.polygons && pointInPolygon(lon, lat, a.polygons)) return a.name;
  return '区外/边界';
};
const weakStreets = {};
for (const h of routeWeakHits) {
  const s = streetOf(h.grid.lon, h.grid.lat);
  weakStreets[s] = (weakStreets[s] || 0) + 1;
}
console.log('弱区街道分布:', JSON.stringify(weakStreets));

// ---------- 统计 ----------
const routeWeakByStreet = weakStreets;
fs.writeFileSync(path.join(__dirname, 'out', 'signal_weak_routes.json'), JSON.stringify({
  generated: new Date().toISOString(), source: 'data/cellid_huicheng_raw.json',
  rule: '500m grid <= 1 cell record and within 500m of a scheduled route',
  weakGridCount: weak.length, routeWeakHits: routeWeakHits.length, byStreet: routeWeakByStreet,
}, null, 2));
const byOp = {}; for (const c of cells) { const o = MNC_NAME[c.mnc] || '其他'; byOp[o] = (byOp[o] || 0) + 1; }
const byRadio = {}; for (const c of cells) byRadio[c.radio] = (byRadio[c.radio] || 0) + 1;
const gridsNR = grids.filter(g => g.nr > 0);

// ---------- HTML ----------
const { KEYS } = require('./amap_key.js');
const JS_KEY = KEYS[0];
// 高德 v2.0 JSAPI：key 必须；配套安全密钥（jscode）放同目录 amap_jscode.txt（可选，无则不设）
const SEC_FILE = path.join(__dirname, 'amap_jscode.txt');
const SEC_CODE = fs.existsSync(SEC_FILE) ? fs.readFileSync(SEC_FILE, 'utf8').trim() : '';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// 热力权重：n 越大越热
// 分档口径（500m 格内基站小区数，众包口径）：
//   ≤1 弱（红）· 2-3 中（黄）· 4-6 良（绿）· ≥7 强（蓝）
const TIER = (n) => n <= 1 ? 'weak' : n <= 3 ? 'mid' : n <= 6 ? 'good' : 'strong';
const TIER_META = {
  strong: { label: '强（≥7 小区/格）', color: '#1d4ed8' },
  good: { label: '良（4-6）', color: '#16a34a' },
  mid: { label: '中（2-3）', color: '#f59e0b' },
  weak: { label: '弱（≤1）', color: '#dc2626' },
};
const tierCells = grids.map(g => ({ lng: +g.lon.toFixed(6), lat: +g.lat.toFixed(6), n: g.n, nr: g.nr, tier: TIER(g.n) }));
const tierCount = {};
for (const g of grids) { const t = TIER(g.n); tierCount[t] = (tierCount[t] || 0) + 1; }
// 基站原始点（制式着色），抽稀至 5000 点以内防卡顿
const cellPts = cells.length > 5000
  ? cells.filter((_, i) => i % Math.ceil(cells.length / 5000) === 0)
  : cells;
const cellMark = cellPts.map(c => ({ lng: +c.lon.toFixed(6), lat: +c.lat.toFixed(6), radio: c.radio }));
const weakPts = weak.map(g => ({ lng: +g.lon.toFixed(6), lat: +g.lat.toFixed(6), n: g.n, street: streetOf(g.lon, g.lat) }));
const routePts = polys.map(p => p.map(c => [+c[0].toFixed(6), +c[1].toFixed(6)]));
// 路线穿越弱区格（带街道，用于图上标注）
const routeWeakMark = routeWeakHits.map(h => ({ lng: +h.grid.lon.toFixed(6), lat: +h.grid.lat.toFixed(6), street: streetOf(h.grid.lon, h.grid.lat) }));

const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>惠城区蜂窝信号分布 · ODD 路线预筛</title>
<style>
body{font-family:"Microsoft YaHei",sans-serif;margin:0;padding:20px;background:#f6f8fa;color:#1a2433}
h1{font-size:20px} h2{font-size:15px;color:#2563eb;margin-top:20px}
.kpis{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}
.kpi{flex:1;min-width:130px;background:#fff;border-radius:8px;padding:12px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.kpi .v{font-size:22px;font-weight:700;color:#2563eb}.kpi .l{font-size:12px;color:#64748b}
table{border-collapse:collapse;font-size:13px;background:#fff;width:100%}
th,td{border:1px solid #e2e8f0;padding:5px 10px;text-align:left}th{background:#f1f5f9}
#map{height:640px;border-radius:8px;background:#fff}
.note{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;font-size:13px;margin:10px 0}
.tag{display:inline-block;border-radius:10px;padding:1px 8px;font-size:12px;margin:1px}
.lgd{display:flex;flex-wrap:wrap;gap:10px 16px;font-size:12px;color:#334155;margin:8px 0}
.lgd .lg{display:inline-flex;align-items:center;gap:5px}
.lgd i{width:14px;height:14px;display:inline-block;border-radius:3px}
.ctl{display:flex;gap:18px;font-size:13px;margin:8px 0;flex-wrap:wrap}
.ctl label{cursor:pointer;user-select:none}
</style></head><body>
<h1>惠城区蜂窝信号分布热力图 · ODD 路线预筛</h1>
<p style="color:#64748b;font-size:13px">数据源：OpenCelliD（众包基站库，${new Date(RAW.fetchedAt).toLocaleString('zh-CN')} 拉取）· ${cells.length} 个小区记录（惠城区街道内）· 500m 网格聚合 · 叠加 ${polys.length} 条排班路线折线</p>

<div class="kpis">
<div class="kpi"><div class="v">${cells.length}</div><div class="l">基站小区记录（区内）</div></div>
<div class="kpi"><div class="v">${byRadio.NR || 0}</div><div class="l">5G NR 小区</div></div>
<div class="kpi"><div class="v">${grids.length}</div><div class="l">500m 网格（有基站）</div></div>
<div class="kpi"><div class="v">${weak.length}</div><div class="l">弱区候选格（≤1 基站）</div></div>
<div class="kpi"><div class="v">${routeWeakHits.length}</div><div class="l">路线穿越弱区格</div></div>
</div>

<div class="note"><b>口径说明（必读）</b>：基站位置 ≠ 信号覆盖。OpenCelliD 是众包数据（样本中位数 1 次），热力图密度反映「有人上报过基站的区域」，<b>城区空白 ≠ 无信号</b>（更可能是无人上报）；<b>郊野山地空白 + 基站稀疏可信度较高</b>。5G 遥操作选路的最终依据应是 Cellular-Z 实测 RSRP/SINR，本图仅做预筛排序。</div>

<h2>信号分档地图 × 基站点 × 排班路线</h2>
<div class="lgd">
  <span class="lg"><i style="background:#dc2626"></i>弱 ≤1 小区/500m 格</span>
  <span class="lg"><i style="background:#f59e0b"></i>中 2-3</span>
  <span class="lg"><i style="background:#16a34a"></i>良 4-6</span>
  <span class="lg"><i style="background:#1d4ed8"></i>强 ≥7</span>
  <span class="lg"><i style="background:#7c3aed;border-radius:50%"></i>5G NR 基站点</span>
  <span class="lg"><i style="background:#94a3b8;border-radius:50%"></i>4G 基站点</span>
  <span class="lg"><i style="background:none;border:2px dashed #dc2626"></i>路线穿越弱区（放大看标注）</span>
  <span class="lg"><i style="background:#475569;height:3px;border-radius:0"></i>排班路线</span>
</div>
<div id="map"></div>
<div class="ctl">
  <label><input type="checkbox" id="lyTier" checked> 分档色块</label>
  <label><input type="checkbox" id="lyCell" checked> 基站点（${cellMark.length}）</label>
  <label><input type="checkbox" id="lyWeak" checked> 路线弱区标注（${routeWeakMark.length}）</label>
  <label><input type="checkbox" id="lyRoute" checked> 排班路线</label>
</div>

<h2>运营商分布（区内小区记录）</h2>
<table><tr><th>运营商</th><th>小区数</th><th>占比</th></tr>
${Object.entries(byOp).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td><td>${(v / cells.length * 100).toFixed(1)}%</td></tr>`).join('')}
</table>

<h2>制式分布</h2>
<table><tr><th>制式</th><th>小区数</th></tr>
${Object.entries(byRadio).map(([k, v]) => `<tr><td>${RADIO_NAME[k] || k}</td><td>${v}</td></tr>`).join('')}
</table>

<h2>分档统计（500m 网格，众包口径）</h2>
<table><tr><th>档位</th><th>颜色</th><th>格内小区数</th><th>格数</th><th>占比</th></tr>
${['strong','good','mid','weak'].map(t => `<tr><td>${TIER_META[t].label}</td><td><i style="display:inline-block;width:12px;height:12px;background:${TIER_META[t].color};border-radius:3px"></i></td><td>${t === 'strong' ? '≥7' : t === 'good' ? '4-6' : t === 'mid' ? '2-3' : '≤1'}</td><td>${tierCount[t] || 0}</td><td>${((tierCount[t] || 0) / grids.length * 100).toFixed(1)}%</td></tr>`).join('')}
</table>
<p style="font-size:12px;color:#64748b">档位 = 500m 网格内 OpenCelliD 小区记录数（众包），是「信号可能强弱」的预筛指标，非实测信号强度。</p>

<h2>路线穿越弱区（重点标注，遥操作前需实测确认）</h2>
${routeWeakHits.length ? `<table><tr><th>#</th><th>弱区格坐标</th><th>街道</th><th>格内基站</th></tr>
${routeWeakHits.map((h, i) => `<tr><td>${i + 1}</td><td>${h.grid.lon.toFixed(4)}, ${h.grid.lat.toFixed(4)}</td><td>${esc(streetOf(h.grid.lon, h.grid.lat))}</td><td>${h.grid.n}</td></tr>`).join('')}
</table>
<p style="font-size:12px;color:#64748b">上表按街道汇总：${Object.entries(weakStreets).map(([k, v]) => `${esc(k)} ${v} 格`).join(' · ')}</p>`
: '<p style="color:#059669">排班路线 500m 走廊内未发现基站空白格。</p>'}

<h2>后续建议</h2>
<ul style="font-size:13px;line-height:1.8">
<li><b>实测确认</b>：对上表弱区格，用 Cellular-Z（安卓）沿路线跑一遍采集 RSRP/SINR/GPS 轨迹，替换众包推断</li>
<li><b>运营商地图交叉</b>：移动 app.10086.cn / 联通 189.cn / 电信 10010.com 的官方 5G 覆盖图人工核对弱区</li>
<li><b>数据局限</b>：OpenCelliD 区内 ${cells.length} 小区 vs 工信部口径基站总量差距大（众包覆盖率低），弱区判定的召回不可靠、误报为主</li>
</ul>

${SEC_CODE ? `<script>window._AMapSecurityConfig={securityJsCode:'${SEC_CODE}'}</script>` : ''}
<script src="https://webapi.amap.com/maps?v=2.0&key=${JS_KEY}"></script>
<script>
const tierCells=${JSON.stringify(tierCells)};
const cellMark=${JSON.stringify(cellMark)};
const weakPts=${JSON.stringify(routeWeakMark)};
const routePts=${JSON.stringify(routePts)};
const tierColor={strong:'#1d4ed8',good:'#16a34a',mid:'#f59e0b',weak:'#dc2626'};
const radioColor={NR:'#7c3aed',LTE:'#94a3b8',UMTS:'#cbd5e1',GSM:'#e2e8f0'};
const map=new AMap.Map('map',{viewMode:'2D',zoom:12.4,center:[114.42,23.10]});

// ① 分档色块（500m 方块，离散四色，一眼可辨）
const tierOverlays=tierCells.map(g=>new AMap.Rectangle({
  bounds:new AMap.Bounds([g.lng-0.00225,g.lat-0.00225],[g.lng+0.00225,g.lat+0.00225]),
  fillColor:tierColor[g.tier],fillOpacity:0.45,strokeColor:tierColor[g.tier],strokeWeight:0.5,strokeOpacity:0.6,
  extData:g}));
tierOverlays.forEach(o=>o.setMap(map));
tierOverlays.forEach(o=>o.on('click',function(e){const g=e.target.getExtData();
  new AMap.InfoWindow({content:'<div style="font-size:12px;line-height:1.7">该 500m 格：<b>'+g.n+'</b> 个小区记录 · '+g.nr+' 个 5G<br>坐标 '+g.lng.toFixed(4)+', '+g.lat.toFixed(4)+'</div>'}).open(map,[g.lng,g.lat]);}));

// ② 基站原始点（5G 紫色醒目，4G 灰点）
const cellOverlays=cellMark.map(c=>new AMap.CircleMarker({
  center:[c.lng,c.lat],radius:c.radio==='NR'?4:2.5,strokeColor:'#fff',strokeWeight:0.5,
  fillColor:radioColor[c.radio]||'#94a3b8',fillOpacity:c.radio==='NR'?1:0.8}));
cellOverlays.forEach(o=>o.setMap(map));

// ③ 路线穿越弱区：大红虚线圈 + 文字标注（街道名）
const weakOverlays=weakPts.map(w=>new AMap.Circle({
  center:[w.lng,w.lat],radius:400,strokeColor:'#dc2626',strokeWeight:3,strokeOpacity:0.95,strokeStyle:'dashed',fillColor:'#dc2626',fillOpacity:0.10,
  extData:w}));
weakOverlays.forEach(o=>o.setMap(map));
weakOverlays.forEach(o=>o.on('click',function(e){const w=e.target.getExtData();
  new AMap.InfoWindow({content:'<div style="font-size:12px"><b style="color:#dc2626">弱区</b> · '+w.street+'<br>路线 500m 走廊内基站≤1<br>'+w.lng.toFixed(4)+', '+w.lat.toFixed(4)+'</div>'}).open(map,[w.lng,w.lat]);}));
const weakLabelOverlays=weakPts.map(w=>new AMap.Text({
  text:'⚠ '+w.street,position:[w.lng,w.lat],offset:new AMap.Pixel(0,-8),
  style:{'font-size':'11px','color':'#b91c1c','background':'rgba(255,255,255,.85)','border':'1px solid #fca5a5','border-radius':'4px','padding':'0 4px'}}));
weakLabelOverlays.forEach(o=>o.setMap(map));

// ④ 排班路线（灰色粗线）
const routeOverlays=routePts.map(p=>new AMap.Polyline({path:p.map(c=>new AMap.LngLat(c[0],c[1])),strokeColor:'#475569',strokeWeight:3,strokeOpacity:0.65}));
routeOverlays.forEach(o=>o.setMap(map));

// 图层开关（原生覆盖物数组）
const bindArr=(id,arr)=>{document.getElementById(id).addEventListener('change',e=>{arr.forEach(o=>e.target.checked?o.show():o.hide());});};
bindArr('lyTier',tierOverlays);bindArr('lyCell',cellOverlays);bindArr('lyWeak',weakOverlays);bindArr('lyRoute',routeOverlays);
document.getElementById('lyWeak').addEventListener('change',function(e){e.target.checked?weakLabelOverlays.forEach(o=>o.show()):weakLabelOverlays.forEach(o=>o.hide());});
</script>
</body></html>`;
fs.writeFileSync(OUT, html);
console.log(`out/signal_coverage.html ${(html.length / 1024).toFixed(0)}KB`);
