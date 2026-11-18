# -*- coding: utf-8 -*-
"""Stage 2 — 渲染「宽凳路网 × 排班路线」覆盖图 (PNG + 交互 HTML).

图层语义（三条线各自是独立对象，不再互相叠加打架）:
  灰 = 宽凳路网（全部）                    —— 背景
  红 = 排班路线 · 走在宽凳测绘到的路上      （= 被覆盖的那部分宽凳路）
  蓝 = 排班路线 · 宽凳没测绘的那段         （盲区，无真值可比）

输入: out/_rkc_links.npz, out/_rkc_stats.json, out/routes.json, out/odd_coverage.html
输出: out/route_kuandeng_coverage.png / .html / .json
"""
from __future__ import annotations

import base64
import io
import json
import math
import re
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.spatial import cKDTree

ROOT = Path(r"D:/workspace/map_element_statistics")
OUT = ROOT / "out"
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")

W = 5200
PAD_M = 900.0
R_BUFFER_M = 20.0
SAMPLE_STEP_M = 4.0

C_GRID = (122, 132, 148)      # 宽凳路网
C_CASE = (255, 255, 255)      # 路线白描边
C_ON = (222, 28, 8)           # 路线 · 走在宽凳上
C_OFF = (21, 87, 214)         # 路线 · 宽凳盲区
W_GRID, W_CASE, W_ROUTE = 3, 8, 5

LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0))
MLAT = 110574.0


def to_xy(lon, lat):
    return (np.asarray(lon, dtype="f8") - LON0) * MLON, (np.asarray(lat, dtype="f8") - LAT0) * MLAT


def resample(P: np.ndarray, step: float) -> np.ndarray:
    if len(P) < 2:
        return P
    seg = np.hypot(np.diff(P[:, 0]), np.diff(P[:, 1]))
    total = float(seg.sum())
    if total <= 0:
        return P[:1]
    n = int(math.ceil(total / step)) + 1
    s = np.linspace(0.0, total, n)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    return np.column_stack([np.interp(s, cum, P[:, 0]), np.interp(s, cum, P[:, 1])])


def split_runs(S: np.ndarray, mask: np.ndarray, min_pts: int = 4):
    """把连续为 True 的区段切出来。"""
    if not mask.any():
        return []
    idx = np.nonzero(mask)[0]
    brk = np.nonzero(np.diff(idx) > 1)[0]
    starts = np.concatenate([[0], brk + 1])
    ends = np.concatenate([brk, [len(idx) - 1]])
    out = []
    for a, b in zip(starts, ends):
        seg = S[idx[a]:idx[b] + 1]
        if len(seg) >= min_pts:
            out.append(seg)
    return out


def poly_len_km(segs) -> float:
    return sum(float(np.hypot(np.diff(s[:, 0]), np.diff(s[:, 1])).sum()) for s in segs) / 1000.0


def main():
    t0 = time.time()
    doc = json.loads((OUT / "routes.json").read_text(encoding="utf-8"))
    stats = json.loads((OUT / "_rkc_stats.json").read_text(encoding="utf-8"))
    link_idx = np.load(OUT / "_rkc_links.npz")["link_idx"]

    fixed = np.load(CACHE / "ROAD_LINK.fixed.npy", mmap_mode="r")
    geom = np.memmap(CACHE / "ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
    goff = np.asarray(fixed["geom_off"], dtype="i8") // 16
    gn = np.asarray(fixed["geom_n"], dtype="i4")

    # ---- 宽凳路网（惠城区）几何 ----------------------------------------
    net_xy, net_pts = [], []
    for i in link_idx.tolist():
        o, n = int(goff[i]), int(gn[i])
        if n < 2:
            continue
        x, y = to_xy(geom[o:o + n, 0], geom[o:o + n, 1])
        P = np.column_stack([x, y])
        net_xy.append(P)
        net_pts.append(P)
    all_pts = np.vstack(net_pts)
    print(f"[net] {len(net_xy)} links, {len(all_pts)} pts ({time.time()-t0:.1f}s)")

    # ---- 排班路线折线（高德实际驾车 poly, GCJ02）------------------------
    route_xy = []
    for st in doc["routes"]:
        for r in st["routes"]:
            poly = np.asarray(r["poly"], dtype="f8")
            x, y = to_xy(poly[:, 0], poly[:, 1])
            route_xy.append(np.column_stack([x, y]))

    kd = cKDTree(all_pts)
    on_segs, off_segs = [], []
    for P in route_xy:
        S = resample(P, SAMPLE_STEP_M)
        d, _ = kd.query(S, k=1, distance_upper_bound=R_BUFFER_M)
        on = d <= R_BUFFER_M
        on_segs += split_runs(S, on)
        off_segs += split_runs(S, ~on)
    on_km, off_km = poly_len_km(on_segs), poly_len_km(off_segs)
    print(f"[route] on-宽凳 {on_km:.1f} km / 盲区 {off_km:.1f} km  ({time.time()-t0:.1f}s)")

    # ---- 视图 ----------------------------------------------------------
    x0, x1 = float(all_pts[:, 0].min()), float(all_pts[:, 0].max())
    y0, y1 = float(all_pts[:, 1].min()), float(all_pts[:, 1].max())
    x0 -= PAD_M; x1 += PAD_M; y0 -= PAD_M; y1 += PAD_M
    span = x1 - x0
    H = int(round(W * (y1 - y0) / span))
    print(f"[view] W={W} H={H} span={span/1000:.1f}km")

    def to_px(arr):
        return (arr[:, 0] - x0) / span * W, (y1 - arr[:, 1]) / (y1 - y0) * H

    # ---- 栅格 ----------------------------------------------------------
    A = Image.new("RGBA", (W, H), (255, 255, 255, 255))
    dA = ImageDraw.Draw(A)
    for P in net_xy:
        px, py = to_px(P)
        dA.line(list(zip(px.tolist(), py.tolist())), fill=C_GRID + (255,), width=W_GRID, joint="curve")
    print(f"[raster] 宽凳路网 {len(net_xy)} 条 ({time.time()-t0:.1f}s)")

    R = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dR = ImageDraw.Draw(R)
    for segs, color in ((on_segs, C_ON), (off_segs, C_OFF)):
        for S in segs:
            px, py = to_px(S)
            xy = list(zip(px.tolist(), py.tolist()))
            dR.line(xy, fill=C_CASE + (255,), width=W_CASE, joint="curve")
            dR.line(xy, fill=color + (255,), width=W_ROUTE, joint="curve")

    comp = Image.alpha_composite(A, R).convert("RGB")
    comp.save(OUT / "route_kuandeng_coverage.png", optimize=True)
    print(f"[png] saved ({time.time()-t0:.1f}s)")

    def b64(img, fmt="PNG"):
        buf = io.BytesIO(); img.save(buf, fmt, optimize=True)
        return base64.b64encode(buf.getvalue()).decode("ascii"), buf.tell()

    a64, asz = b64(A)
    print(f"[embed] 宽凳底图 {asz/1e6:.2f}MB")

    def paths_of(segs, out_step=10.0):
        out = []
        for S in segs:
            Q = resample(S, out_step)
            px, py = to_px(Q)
            out.append("M" + " L".join(f"{a:.1f},{b:.1f}" for a, b in zip(px.tolist(), py.tolist())))
        return out

    # ---- 高德 C 表索引 --------------------------------------------------
    html = (OUT / "odd_coverage.html").read_text(encoding="utf-8")
    ci = html.find("C · 路线")
    seg = html[ci:ci + 400000]
    streets = []
    for m in re.finditer(r'<span class="st-name">([^<]+)</span>\s*<span class="lk">([^<]+)</span>\s*<span class="st-nav"><a href="([^"]+)"[^>]*>([^<]+)</a>', seg):
        streets.append({"name": m.group(1), "meta": m.group(2),
                        "uri": m.group(3).replace("&amp;", "&"), "nav": m.group(4), "routes": []})
    for m in re.finditer(r'<td class="rn">路线(\d+)</td>\s*<td class="tg2">([^<]+)</td>\s*<td class="num">([\d.]+)<span class="u">km</span></td>\s*<td class="num">≈(\d+)<span class="u">min</span></td>.*?<td class="slot"><a href="([^"]+)"[^>]*>([^<]+)</a><span class="slot-t">([^<]*)</span></td>', seg, re.S):
        if streets:
            streets[-1]["routes"].append({
                "n": int(m.group(1)), "via": m.group(2).strip(), "km": m.group(3),
                "min": m.group(4), "uri": m.group(5).replace("&amp;", "&"),
                "nav": m.group(6), "slot": m.group(7)})
    print(f"[index] {len(streets)} streets, {sum(len(s['routes']) for s in streets)} routes")

    stats["route_on_km"] = round(on_km, 1)
    stats["route_off_km"] = round(off_km, 1)
    stats["blind_km"] = round(off_km, 1)
    stats["blind_segments"] = len(off_segs)

    data = {"stats": stats, "streets": streets, "W": W, "H": H,
            "on_paths": paths_of(on_segs), "off_paths": paths_of(off_segs)}
    (OUT / "route_kuandeng_coverage.json").write_text(
        json.dumps({"stats": stats, "index": streets}, ensure_ascii=False, indent=2), encoding="utf-8")
    _write_html(OUT / "route_kuandeng_coverage.html", data, a64)
    print(f"[done] html {(OUT/'route_kuandeng_coverage.html').stat().st_size/1e6:.2f}MB ({time.time()-t0:.1f}s)")


def _write_html(path: Path, data, a64):
    st = data["stats"]
    cards = [
        ("宽凳路网（惠城区）", f'{st["network_km"]:,.1f}', "km", "灰底 · 宽凳 HD 地图的全部道路"),
        ("排班路线总长", f'{st["routes"]["single_km"]:,.1f}', "km", f'{st["routes"]["streets"]} 个镇街 · 52 条 · 单程'),
        ("红线：走在宽凳上", f'{st["route_on_km"]:,.1f}', "km", "排班路线中宽凳有测绘的部分"),
        ("蓝线：宽凳没测", f'{st["route_off_km"]:,.1f}', "km", "排班走过、宽凳无真值 · 无法校验"),
        ("宽凳路网被覆盖", f'{st["covered_km"]:,.1f}', "km", f'占路网 {st["coverage_pct"]}% · 严格 {st["strict_km"]:,.0f}'),
        ("排班没走到的宽凳路", f'{st["uncovered_km"]:,.1f}', "km", f'{st["uncovered_links"]:,} 段 · 图上只剩灰'),
    ]
    card_html = "".join(
        f'<div class="card"><div class="k">{k}</div><div class="v">{v}<span class="u">{u}</span></div><div class="s">{s}</div></div>'
        for k, v, u, s in cards)

    bsk = st.get("by_street_km", {})
    st_html = []
    for s in data["streets"]:
        cov_km = bsk.get(s["name"])
        rows = "".join(
            f'<tr><td class="rn">路线{r["n"]}</td><td class="via">{r["via"]}</td>'
            f'<td class="num">{r["km"]}km</td><td class="num">≈{r["min"]}min</td>'
            f'<td class="slot"><a href="{r["uri"]}" target="_blank">{r["nav"]} ↗</a>'
            f'<div class="sl">{r["slot"]}</div></td></tr>'
            for r in s["routes"])
        st_html.append(
            f'<details><summary><b>{s["name"]}</b>'
            f'<span class="cov">宽凳覆盖 {cov_km if cov_km is not None else "—"} km</span>'
            f'<span class="lk">{s["meta"]}</span>'
            f'<a class="nav" href="{s["uri"]}" target="_blank">路线集导航 ↗</a></summary>'
            f'<table class="rt"><tr><th>路线</th><th>途经点</th><th>里程</th><th>时长</th><th>导航 · 建议时段</th></tr>{rows}</table></details>')
    streets_html = "".join(st_html)

    on_js = json.dumps(data["on_paths"], ensure_ascii=False)
    off_js = json.dumps(data["off_paths"], ensure_ascii=False)

    tpl = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>惠城区 · 排班路线 × 宽凳路网 覆盖图</title>
<style>
:root{--bg:#f5f6f8;--fg:#1f2329;--mut:#6b7280;--line:#e3e6eb;--card:#fff;--red:#de1c08;--blue:#1557db;--grey:#7a8494}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif}
header{padding:18px 26px 12px}h1{margin:0;font-size:20px}
header .sub{color:var(--fg);font-size:12.5px;margin-top:6px;line-height:2}
header .sub2{color:var(--mut);font-size:11.5px;margin-top:7px;max-width:1120px}
.pill{display:inline-flex;align-items:center;margin:2px 6px 2px 0;padding:1px 8px;border:1px solid;border-radius:999px;font-size:11.5px;background:#fff;white-space:nowrap}
.pill i{display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:5px}
.cards{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;padding:0 26px 14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card .k{font-size:12px;color:var(--mut)}.card .v{font-size:24px;font-weight:700;margin-top:2px}
.card .v .u{font-size:12px;font-weight:400;color:var(--mut);margin-left:3px}.card .s{font-size:11.5px;color:var(--mut);margin-top:2px}
.wrap{display:grid;grid-template-columns:1fr 430px;gap:14px;padding:0 26px 26px}
#mapbox{position:relative;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden;height:74vh}
#stage{position:absolute;left:0;top:0;transform-origin:0 0}
#stage img,#stage svg{position:absolute;left:0;top:0;width:100%;height:100%}
#stage svg{pointer-events:none}
.legend{position:absolute;left:12px;bottom:12px;background:rgba(255,255,255,.94);border:1px solid var(--line);border-radius:8px;padding:8px 11px;font-size:12px;z-index:5}
.legend i{display:inline-block;width:13px;height:3px;border-radius:2px;margin-right:6px;vertical-align:middle}
.ctrls{position:absolute;right:12px;top:12px;background:rgba(255,255,255,.94);border:1px solid var(--line);border-radius:8px;padding:8px 11px;font-size:12.5px;z-index:5}
.ctrls label{display:block;cursor:pointer;user-select:none;white-space:nowrap}
.ctrls button{margin-top:6px;width:100%;font:12px inherit;padding:3px 0;border:1px solid var(--line);background:#fff;border-radius:6px;cursor:pointer}
aside{background:#fff;border:1px solid var(--line);border-radius:10px;overflow:auto;height:74vh;padding:12px 14px}
aside h2{font-size:15px;margin:2px 0 10px}
details{border-bottom:1px solid var(--line);padding:8px 0}details summary{cursor:pointer;list-style:none}
details summary::-webkit-details-marker{display:none}
details summary b{font-size:13.5px}.lk{color:var(--mut);font-size:11.5px;margin-left:8px}
span.cov{font-size:11.5px;color:#de1c08;font-weight:600;margin-left:8px}
a.nav{float:right;font-size:12px}table.rt{width:100%;border-collapse:collapse;margin-top:8px;font-size:12px}
table.rt th{background:#f0f2f5;color:#1f2329;font-weight:600;text-align:left;padding:4px 6px}
table.rt td{border-top:1px solid var(--line);padding:5px 6px;vertical-align:top}
td.rn{white-space:nowrap;color:var(--mut)}td.num{text-align:right;white-space:nowrap}
td.via{max-width:150px}td.slot a{font-weight:600}div.sl{color:var(--mut);font-size:11.5px}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
</style></head><body>
<header><h1>惠城区 · 排班路线 × 宽凳路网 覆盖图</h1>
 <div class="sub"><b>怎么读这张图：</b>一共三种线 ——
 <span class="pill" style="border-color:#7a8494"><i style="background:#7a8494"></i>灰 = 宽凳路网（全部道路）</span>
 <span class="pill" style="border-color:#de1c08"><i style="background:#de1c08"></i>红 = 排班路线 · 走在宽凳测绘到的路上</span>
 <span class="pill" style="border-color:#1557db"><i style="background:#1557db"></i>蓝 = 排班路线 · 宽凳没测绘的那段（盲区）</span></div>
<div class="sub2">红线同时就是「被覆盖的宽凳道路」—— 排班车开过哪条宽凳的路，那条路就变红。蓝线是排班车开过去、但宽凳地图里根本没有这条路，拿不到真值、验不了。
口径：52 条街道路线（高德驾车折线, GCJ02）× 宽凳 ROAD_LINK 中心线（GCJ02 交付, 裁剪惠城区 441302）。
判「覆盖」= 该段宽凳道路的采样点里，落在排班路线 20 m 内的占比 ≥50%；≥90% 另记「严格覆盖」。生成 __GEN__</div></header>
<div class="cards">__CARDS__</div>
<div class="wrap">
 <div id="mapbox">
  <div class="ctrls">
   <label><input type="checkbox" id="l0" checked> 宽凳路网（灰底）</label>
   <label><input type="checkbox" id="l1" checked> 排班路线 · 走在宽凳上（红）</label>
   <label><input type="checkbox" id="l2" checked> 排班路线 · 宽凳盲区（蓝）</label>
   <label><input type="checkbox" id="l3"> 只看排班路线</label>
   <button id="fit">复位</button>
  </div>
  <div class="legend">
   <div><i style="background:#7a8494"></i>宽凳路网（全部）</div>
   <div><i style="background:#de1c08"></i>排班路线 · 走在宽凳上</div>
   <div><i style="background:#1557db"></i>排班路线 · 宽凳盲区</div></div>
  <div id="stage"></div>
 </div>
 <aside><h2>高德路线集 / 途径点导航（C 表同源）</h2>__STREETS__</aside>
</div>
<script>
const W=__W__,H=__H__,ON=__ON__,OFF=__OFF__;
const base="data:image/png;base64,__A64__";
const stage=document.getElementById('stage');
stage.style.width=W+'px';stage.style.height=H+'px';
stage.innerHTML='<img id="img0" src="'+base+'"><svg id="svg" viewBox="0 0 '+W+' '+H+'"><g id="gon"></g><g id="goff"></g></svg>';
const SW=(5*(W/2600)).toFixed(2),SC=(8*(W/2600)).toFixed(2);
function mk(d,w,c,op){
 const p=document.createElementNS('http://www.w3.org/2000/svg','path');
 p.setAttribute('d',d);p.setAttribute('fill','none');p.setAttribute('stroke',c);
 p.setAttribute('stroke-width',w);p.setAttribute('stroke-opacity',op);
 p.setAttribute('stroke-linejoin','round');p.setAttribute('stroke-linecap','round');
 return p;
}
function draw(id,list,color){
 const g=document.getElementById(id);
 for(const d of list){g.appendChild(mk(d,SC,'#ffffff',1));g.appendChild(mk(d,SW,color,0.92));}
}
draw('gon',ON,'#de1c08');draw('goff',OFF,'#1557db');
const box=document.getElementById('mapbox');
let s=1,tx=0,ty=0,fit=1;
function apply(){stage.style.transform='translate('+tx+'px,'+ty+'px) scale('+s+')';}
function fitView(){fit=Math.min(box.clientWidth/W,box.clientHeight/H);s=fit*0.98;
 tx=(box.clientWidth-W*s)/2;ty=(box.clientHeight-H*s)/2;apply();}
function setVis(id,v){document.getElementById(id).style.display=v?'block':'none';}
const L0=document.getElementById('l0'),L1=document.getElementById('l1'),
      L2=document.getElementById('l2'),L3=document.getElementById('l3');
function sync(){
 setVis('img0',L0.checked&&!L3.checked);
 setVis('gon',L1.checked);
 setVis('goff',L2.checked);
}
L0.onchange=sync;L1.onchange=sync;L2.onchange=sync;L3.onchange=sync;
box.addEventListener('wheel',e=>{e.preventDefault();const r=box.getBoundingClientRect();
 const mx=e.clientX-r.left,my=e.clientY-r.top,k=e.deltaY<0?1.18:1/1.18;
 const ns=Math.max(fit*0.5,Math.min(s*k,60));tx=mx-(mx-tx)*(ns/s);ty=my-(my-ty)*(ns/s);s=ns;apply();},{passive:false});
let drag=null;
box.addEventListener('pointerdown',e=>{
  if(e.target.closest('.ctrls')||e.target.closest('.legend'))return;
  drag={x:e.clientX,y:e.clientY,tx,ty};box.style.cursor='grabbing';
  try{box.setPointerCapture(e.pointerId);}catch(_){}});
box.addEventListener('pointermove',e=>{if(!drag)return;tx=drag.tx+(e.clientX-drag.x);ty=drag.ty+(e.clientY-drag.y);apply();});
box.addEventListener('pointerup',()=>{drag=null;box.style.cursor='';});
box.addEventListener('pointercancel',()=>{drag=null;box.style.cursor='';});
document.getElementById('fit').onclick=fitView;
addEventListener('resize',fitView);
sync();fitView();
</script></body></html>"""
    html = (tpl.replace("__GEN__", st["generated"])
            .replace("__CARDS__", card_html).replace("__STREETS__", streets_html)
            .replace("__W__", str(data["W"])).replace("__H__", str(data["H"]))
            .replace("__ON__", on_js).replace("__OFF__", off_js)
            .replace("__A64__", a64))
    path.write_text(html, encoding="utf-8")


if __name__ == "__main__":
    main()
