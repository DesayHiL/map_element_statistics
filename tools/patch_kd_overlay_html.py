# -*- coding: utf-8 -*-
"""把「以宽凳为限定」的覆盖图追加到 out/route_kuandeng_routes.html 最下方。

改动两处：
  1. 控制面板：锚点( l2 ) / 锚点标号( l5 ) 默认不勾选 —— 用户要求
  2. </div><script> 之间插入覆盖图 section；</script> 前追加覆盖图 JS
覆盖图复用主图那张已是 data-URI 的灰底 PNG（img.src 直接拷过来），
以及主脚本里的 decPaths / RT 变量，因此额外体积只有贴合+缺失两条路径的 base64。
"""
import json, sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
OUT = Path(r"D:/workspace/map_element_statistics/out")
HTML = OUT / "route_kuandeng_routes.html"
D = json.load(open(OUT / "_kd_overlay.json", encoding="utf-8"))

tiers = D["tiers"]
tk = tiers["A"] + tiers["B"] + tiers["C"]
rank = D["by_street"]
mx = max(r["km"] for r in rank)
rows = "\n".join(
    f'<div class="row"><span class="nm">{r["street"]}</span>'
    f'<span class="bw"><i style="width:{max(2, 100 * r["km"] / mx):.1f}%;'
    f'background:{"#d81e1e" if r["km"] > 30 else ("#e88c0a" if r["km"] > 10 else "#c6cdd8")}"></i></span>'
    f'<span class="vv">{r["km"]:.1f}</span></div>'
    for r in rank[:12])
more = len(rank) - 12
top4 = rank[:4]; k4 = sum(r["km"] for r in top4)
pct_ok = 100.0 * D["km_corr_ok"] / D["km_amap_ok"]

SECTION = f"""<div class="wraplow">
 <div class="lowhead">
  <h1>以宽凳为限定 · 排班路线覆盖图</h1>
  <div class="sub"><b>怎么读这张图：</b>
   <span class="pill" style="border-color:#7a8494"><i style="background:#7a8494"></i>灰 = 宽凳路网（交付的全部 ROAD_LINK）</span>
   <span class="pill" style="border-color:#10824a"><i style="background:#10824a"></i>绿 = 贴合路线（只用宽凳 link 走出来的，{D["km_corr_ok"]:,.0f} km）</span>
   <span class="pill" style="border-color:#d81e1e"><i style="background:#d81e1e"></i>红 = 宽凳查不到段（{D["km_miss"]:,.0f} km / {D["n_miss_seg"]} 段）</span>
   <span class="pill" style="border-color:#c9cfda;color:#6b7280"><i style="background:#c9cfda"></i>浅灰虚线 = 高德原规划（参照）</span></div>
  <div class="sub2">做法：按锚点把每条腿切成若干段 → 以该段【高德实际驾车折线】为轴开走廊（半径 30 m 起逐级放宽到 350 m）→
   <b>只允许走廊内的宽凳 link</b>参与最短路 → 锚点吸附到走廊内最近节点。这样得到的绿线就是「高德走的那条路，但只能用宽凳有的路走」，
   与高德里程同口径可比。绿线和灰底宽凳路网完全重合 —— <b>这就是「路线落在宽凳上」的可视化证明</b>。<br>
   红线 = 走廊放宽到 350 m 后仍不连通的段：该段确实必须离开宽凳（这一片宽凳没采）。<br>
   口径：{D["n_segs"]} 段 / {D["n_legs"]} 腿；走廊内连通 <b>{D["ok_segs"]} / {D["n_segs"]} 段</b>，
   整腿全通 <b>{D["ok_legs"]} / {D["n_legs"]} 条</b>；连通段高德 {D["km_amap_ok"]:,.1f} km → 贴合 {D["km_corr_ok"]:,.1f} km（{pct_ok:.1f}%，中位逐段比值 0.96，不缩水）。</div>
 </div>
 <div class="lowcards">
  <div class="card"><div class="k">整腿可在宽凳上走通</div><div class="v">{D["ok_legs"]}<span class="u">/ {D["n_legs"]} 条</span></div><div class="s">锚点全部不变 · 只换路网</div></div>
  <div class="card"><div class="k">逐段落上宽凳</div><div class="v">{D["ok_segs"]}<span class="u">/ {D["n_segs"]} 段</span></div><div class="s">相邻锚点之间为一段</div></div>
  <div class="card"><div class="k">贴合里程</div><div class="v">{D["km_corr_ok"]:,.0f}<span class="u">km</span></div><div class="s">等于高德同段的 {pct_ok:.0f}%</div></div>
  <div class="card"><div class="k">宽凳查不到</div><div class="v">{D["km_miss"]:,.0f}<span class="u">km</span></div><div class="s">{D["n_miss_seg"]} 段 · 走廊内不连通</div></div>
  <div class="card"><div class="k">严格贴合段</div><div class="v">{tiers["A"]}<span class="u">段</span></div><div class="s">走廊≤80 m · 锚点≤100 m</div></div>
  <div class="card"><div class="k">可用段</div><div class="v">{tiers["B"]}<span class="u">段</span></div><div class="s">放宽走廊或锚点接驳</div></div>
 </div>
 <div class="lowgrid">
  <div id="mapbox2">
   <div class="ctrls">
    <label><input type="checkbox" id="m0" checked> 宽凳路网（灰底）</label>
    <label><input type="checkbox" id="m1" checked> 贴合路线（绿）</label>
    <label><input type="checkbox" id="m2" checked> 宽凳查不到段（红）</label>
    <label><input type="checkbox" id="m3"> 高德原规划（灰虚线）</label>
    <label><input type="checkbox" id="m4"> 只看贴合路线</label>
    <button id="fit2">复位</button>
   </div>
   <div class="legend">
    <div><i style="background:#7a8494"></i>宽凳路网（全部）</div>
    <div><i style="background:#10824a"></i>贴合路线（只用宽凳 link）</div>
    <div><i style="background:#d81e1e"></i>宽凳查不到段</div>
    <div><i style="background:#c9cfda"></i>高德原规划（开关）</div></div>
   <div id="stage2"></div>
  </div>
  <div class="lowside">
   <h2>宽凳查不到的里程 · 按镇街</h2>
   <div class="hint">这 4 个镇占缺口的 {100 * k4 / D["km_miss"]:.0f}%：
    {"、".join(f'{r["street"]} {r["km"]:.1f}' for r in top4)} km。<br>
    贴合率低于 20% 的（芦洲、沥林、横沥）宽凳整片没采，<b>要补测或把服务点挪走</b>；
    贴合率高于 60% 的（陈江、小金口、三栋等）宽凳有路、只是走廊中间有个洞，<b>人工接一下即可</b>。</div>
   <div class="rank">{rows}{f'<div class="more">其余 {more} 个镇街合计 {D["km_miss"] - sum(r["km"] for r in rank[:12]):.1f} km</div>' if more > 0 else ""}</div>
  </div>
 </div>
</div>"""

LOWCSS = """<style>
.wraplow{border-top:2px solid var(--line);margin-top:6px;padding:20px 26px 26px}
.lowhead h1{margin:0;font-size:20px}
.lowhead .sub{font-size:12.5px;margin-top:6px;line-height:2}
.lowhead .sub2{color:var(--mut);font-size:11.5px;margin-top:7px;max-width:1320px;line-height:1.9}
.lowcards{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;padding:14px 0}
.lowgrid{display:grid;grid-template-columns:1fr 380px;gap:14px}
#mapbox2{position:relative;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden;height:76vh}
#stage2{position:absolute;left:0;top:0;transform-origin:0 0}
#stage2 img,#stage2 svg{position:absolute;left:0;top:0;width:100%;height:100%}
#stage2 svg{pointer-events:none}
#stage2{--sw2:11;--swc2:24.5;--svg2:3.8}
#gom path{stroke-width:calc(var(--sw2) * 1px)}
#gom path.cs{stroke-width:calc(var(--swc2) * 1px)}
#gms path{stroke-width:calc(var(--sw2) * 1px)}
#gms path.cs{stroke-width:calc(var(--swc2) * 1px)}
#gma path{stroke-width:calc(var(--sw2) * 1px);stroke-dasharray:calc(var(--sw2) * 3px) calc(var(--sw2) * 2.4px)}
.lowside{background:#fff;border:1px solid var(--line);border-radius:10px;height:76vh;overflow:auto;padding:12px 14px}
.lowside h2{font-size:15px;margin:2px 0 6px}
.lowside .hint{font-size:11.5px;color:var(--mut);line-height:1.85;margin-bottom:10px}
.rank .row{display:flex;align-items:center;gap:8px;padding:2.5px 0;font-size:12px}
.rank .nm{width:88px;flex:none;color:#33415c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rank .bw{flex:1;height:11px;background:#f1f3f7;border-radius:3px;overflow:hidden}
.rank .bw i{display:block;height:100%;border-radius:3px}
.rank .vv{width:42px;flex:none;text-align:right;color:#4a5568;font-weight:600}
.rank .more{font-size:11px;color:var(--mut);margin-top:8px;padding-top:8px;border-top:1px dashed var(--line)}
</style>"""

LOWJS = """<script>
(function(){
 // 覆盖图与主图共用同一画布尺寸与灰底 PNG，只是多画两条 SVG 路径
 var D=__OVJ__, img=document.getElementById('img0'), st2=document.getElementById('stage2');
 st2.style.width=W+'px';st2.style.height=H+'px';
 var im=document.createElement('img');im.id='img2';im.alt='';im.draggable=false;im.src=img.src;
 st2.appendChild(im);
 var OV=decPaths(D.ovmatch,PREC), MS=decPaths(D.ovmiss,PREC);
 st2.insertAdjacentHTML('beforeend','<svg id="svg2" viewBox="0 0 '+W+' '+H+'">'
  +'<g id="gma"></g><g id="gms"></g><g id="gom"></g></svg>');
 // 三个独立图层：gma 高德参照 / gms 宽凳查不到 / gom 贴合路线
 function mk2(d,cls,c,op,cap){
  var p=document.createElementNS('http://www.w3.org/2000/svg','path');
  p.setAttribute('d',d);p.setAttribute('fill','none');p.setAttribute('stroke',c);
  p.setAttribute('stroke-opacity',op);
  if(cls)p.setAttribute('class',cls);
  p.setAttribute('stroke-linejoin',cap||'round');p.setAttribute('stroke-linecap',cap||'round');
  return p;
 }
 // 顺序（z 轴自下而上）：高德原线 → 宽凳查不到段（红）→ 贴合路线（绿）
 var gma=document.getElementById('gma'),gms=document.getElementById('gms'),gom=document.getElementById('gom');
 gma.appendChild(mk2(RT.join(''),'','#c9cfda',1));
 gms.appendChild(mk2(MS.join(''),'cs','#ffffff',1));
 gms.appendChild(mk2(MS.join(''),'','#d81e1e',1));
 gom.appendChild(mk2(OV.join(''),'cs','#ffffff',1));
 gom.appendChild(mk2(OV.join(''),'','#10824a',1));
 var b2=document.getElementById('mapbox2');
 var s2=1,tx2=0,ty2=0,fit2=1;
 function resc2(){var k=1/s2;
  st2.style.setProperty('--sw2',(1.7*k).toFixed(2));
  st2.style.setProperty('--swc2',(3.8*k).toFixed(2));}
 function ap2(){st2.style.transform='translate('+tx2+'px,'+ty2+'px) scale('+s2+')';resc2();}
 function fv2(){fit2=Math.min(b2.clientWidth/W,b2.clientHeight/H);s2=fit2*0.98;
  tx2=(b2.clientWidth-W*s2)/2;ty2=(b2.clientHeight-H*s2)/2;ap2();}
 function sv2(id,v){document.getElementById(id).style.display=v?'block':'none';}
 var M0=document.getElementById('m0'),M1=document.getElementById('m1'),M2=document.getElementById('m2'),
     M3=document.getElementById('m3'),M4=document.getElementById('m4');
 function sync2(){
  sv2('img2',M0.checked&&!M4.checked);
  sv2('gom',M1.checked&&!M4.checked);
  sv2('gms',M2.checked&&!M4.checked);
  sv2('gma',M3.checked&&!M4.checked);
 }
 M0.onchange=sync2;M1.onchange=sync2;M2.onchange=sync2;M3.onchange=sync2;M4.onchange=sync2;
 b2.addEventListener('wheel',function(e){e.preventDefault();var r=b2.getBoundingClientRect();
  var mx=e.clientX-r.left,my=e.clientY-r.top,k=e.deltaY<0?1.18:1/1.18;
  var ns=Math.max(fit2*0.5,Math.min(s2*k,60));tx2=mx-(mx-tx2)*(ns/s2);ty2=my-(my-ty2)*(ns/s2);s2=ns;ap2();},{passive:false});
 var dr=null;
 b2.addEventListener('pointerdown',function(e){
  if(e.target.closest('.ctrls')||e.target.closest('.legend'))return;
  dr={x:e.clientX,y:e.clientY,tx:tx2,ty:ty2};b2.style.cursor='grabbing';
  try{b2.setPointerCapture(e.pointerId);}catch(_){}});
 b2.addEventListener('pointermove',function(e){if(!dr)return;
  tx2=dr.tx+(e.clientX-dr.x);ty2=dr.ty+(e.clientY-dr.y);ap2();});
 b2.addEventListener('pointerup',function(){dr=null;b2.style.cursor='';});
 b2.addEventListener('pointercancel',function(){dr=null;b2.style.cursor='';});
 document.getElementById('fit2').onclick=fv2;
 addEventListener('resize',fv2);
 if(window.ResizeObserver){new ResizeObserver(fv2).observe(b2);}
 requestAnimationFrame(fv2);setTimeout(fv2,120);setTimeout(fv2,600);
 sync2();fv2();
})();
</script>"""

html = HTML.read_text(encoding="utf-8")
assert "wraplow" not in html, "页面里已有覆盖图区块"

# 1) 控制面板：锚点 / 锚点标号 默认不勾选
a = '<label><input type="checkbox" id="l2" checked> 锚点：起点/途经点/终点</label>'
b = '<label><input type="checkbox" id="l2"> 锚点：起点/途经点/终点</label>'
c = '<label><input type="checkbox" id="l5" checked> 锚点标号（1–52）</label>'
e = '<label><input type="checkbox" id="l5"> 锚点标号（1–52）</label>'
assert html.count(a) == 1 and html.count(c) == 1, "控制面板锚点项未匹配"
html = html.replace(a, b).replace(c, e)

# 自检脚本里的 set('l2',true) / set('l5',true) 保持原样（自检会显式打开再校验）

# 2) 样式 + 覆盖图 section 插到 wrap 之后、主脚本之前
anchor = "</div>\n<script>\nconst W="
assert html.count(anchor) == 1, "wrap 结束锚点未匹配"
html = html.replace(anchor, "</div>\n" + LOWCSS + SECTION + "\n<script>\nconst W=")

# 3) 覆盖图 JS 追加到主脚本之后
tail = "</script></body></html>"
assert html.count(tail) == 1, "脚本结束锚点未匹配"
html = html.replace(tail, "</script>\n" + LOWJS.replace("__OVJ__", json.dumps(D, ensure_ascii=False)) + "</body></html>")

HTML.write_text(html, encoding="utf-8")
print(f"[out] {HTML}  {HTML.stat().st_size/1024:.0f} KB")
print(f"  控制面板 l2/l5 已改为默认不勾选")
print(f"  覆盖图：贴合 {D['ok_segs']}/{D['n_segs']} 段 · 缺失 {D['km_miss']} km · 整腿 {D['ok_legs']}/{D['n_legs']}")
