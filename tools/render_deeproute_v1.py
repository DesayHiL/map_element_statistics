# -*- coding: utf-8 -*-
"""deeproute 专项路线 × 宽凳路网 单图页（仿 render_routes_v3.py）。

与 render_routes_v3 的差异：
  * 数据源是 out/deeproute_plan.json（18 条 DR-XX，poly 为高德 GCJ02 折线，直接投影）
  * 锚点 = 每条路线的 stops[4]（起点/2 站点/终点），anchors 仅统计用（无坐标）
  * 无 routes_kd/kd_route_plan（不做宽凳吸附）；无缺口层；ODD POI 层保留（与排班页同款）
输出: out/deeproute_kd_routes.html（单图页，供 deeproute_routes.html 汇总页 iframe 内嵌）
"""
from __future__ import annotations

import base64
import io
import json
import math
import time
from pathlib import Path
from urllib.parse import quote

import numpy as np
from PIL import Image, ImageDraw
from scipy.spatial import cKDTree

ROOT = Path(r"D:/workspace/map_element_statistics")
OUT = ROOT / "out"
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")

W = 5200
PAD_M = 8000.0

C_GRID = (108, 118, 136)
C_CASE = (255, 255, 255)
C_ROUTE = (222, 28, 8)
C_BASE = (16, 130, 74)
C_VIA = (232, 148, 12)
C_END = (120, 20, 20)
C_LINK = (60, 66, 80)
W_GRID, W_CASE, W_ROUTE = 3, 7, 3

PALETTE = ["#1f4e9c", "#8a5a00", "#0f6b6b", "#7a2f6b", "#6b3fa0", "#7a4a2b",
           "#a81f7a", "#4a5568", "#7a7a12", "#0e7c8c", "#2f3570", "#4a5c5f",
           "#6b5312", "#3b3b6b", "#5a2f5c", "#1d6fa5", "#14507a", "#3f3f46"]

LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0))
MLAT = 110574.0


def to_xy(lon, lat):
    return (np.asarray(lon, dtype="f8") - LON0) * MLON, (np.asarray(lat, dtype="f8") - LAT0) * MLAT


_KA, _KE = 6378245.0, 0.00669342162296594323
_PI = math.pi


def _tr(x, y):
    r = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*math.sqrt(abs(x))
    r += (20*math.sin(6*x) + 20*math.sin(2*x))*2/3
    r += (20*math.sin(y*_PI) + 40*math.sin(y/3*_PI))*2/3
    r += (160*math.sin(y/12*_PI) + 320*math.sin(y*_PI/30))*2/3
    return r


def _tl(x, y):
    r = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*math.sqrt(abs(x))
    r += (20*math.sin(6*x) + 20*math.sin(2*x))*2/3
    r += (20*math.sin(x*_PI) + 40*math.sin(x/3*_PI))*2/3
    r += (150*math.sin(x/12*_PI) + 300*math.sin(x/30*_PI))*2/3
    return r


def wgs2gcj(lon, lat):
    lon, lat = np.asarray(lon, "f8"), np.asarray(lat, "f8")
    dlat = np.vectorize(_tr)(lon - 105, lat - 35)
    dlon = np.vectorize(_tl)(lon - 105, lat - 35)
    rad = lat / 180 * _PI
    m = 1 - _KE * np.sin(rad) ** 2
    sq = np.sqrt(m)
    dlat = (dlat * 180) / ((_KA * (1 - _KE)) / (m * sq) * _PI)
    dlon = (dlon * 180) / ((_KA / sq) * np.cos(rad) * _PI)
    return lon + dlon, lat + dlat


def main():
    t0 = time.time()
    plan = json.loads((OUT / "deeproute_plan.json").read_text(encoding="utf-8"))

    fixed = np.load(CACHE / "ROAD_LINK.fixed.npy", mmap_mode="r")
    geom = np.memmap(CACHE / "ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
    goff = np.asarray(fixed["geom_off"], dtype="i8") // 16
    gn = np.asarray(fixed["geom_n"], dtype="i4")

    # ---- 宽凳路网（灰底） ---------------------------------------------
    net_xy = []
    for i in range(len(gn)):
        n = int(gn[i])
        if n < 2:
            continue
        o = int(goff[i])
        x, y = to_xy(geom[o:o + n, 0], geom[o:o + n, 1])
        net_xy.append(np.column_stack([x, y]))
    all_pts = np.vstack(net_xy)
    print(f"[net] {len(net_xy)} links, {len(all_pts)} pts ({time.time()-t0:.1f}s)")

    # ---- deeproute 18 条：poly（GCJ02）+ stops[4] 锚点 -----------------
    legs = []
    for ri, r in enumerate(plan["routes"]):
        P = np.asarray(r["poly"], dtype="f8")     # GCJ02 [lon,lat]
        x, y = to_xy(P[:, 0], P[:, 1])
        polys = [np.column_stack([x, y])]
        A = []
        for si, s in enumerate(r["stops"]):
            ax, ay = to_xy(s["gcj"][0], s["gcj"][1])
            role = "起点" if si == 0 else ("终点" if si == len(r["stops"]) - 1 else "站点")
            A.append({"name": s.get("name") or s.get("label") or "", "label": s.get("label") or "",
                      "kind": s.get("kind") or "", "role": role, "x": float(ax), "y": float(ay),
                      "gcj": [float(s["gcj"][0]), float(s["gcj"][1])]})
        legs.append({"name": r["name"], "gid": ri + 1, "km": r["distKm"], "min": r.get("durMin", 0),
                     "polys": polys, "anchors": A, "n_anchor": len(r.get("anchors", [])),
                     "roads": r.get("roads", []), "uri": r.get("uri", "")})
    n_legs = len(legs)
    print(f"[routes] {n_legs} 条, 总 {sum(l['km'] for l in legs):.1f} km, "
          f"{sum(l['n_anchor'] for l in legs)} 覆盖锚点, {sum(len(l['anchors']) for l in legs)} 站点")

    # 视图：全部折线包围盒 + 8km 背景
    allr = np.vstack([P for L in legs for P in L["polys"]])
    rx0, rx1 = allr[:, 0].min(), allr[:, 0].max()
    ry0, ry1 = allr[:, 1].min(), allr[:, 1].max()
    x0, x1 = rx0 - PAD_M, rx1 + PAD_M
    y0, y1 = ry0 - PAD_M, ry1 + PAD_M
    span = x1 - x0
    H = int(round(W * (y1 - y0) / span))
    print(f"[view] W={W} H={H}  {(x1-x0)/1000:.1f} x {(y1-y0)/1000:.1f} km")

    def to_px(arr):
        return ((arr[:, 0] - x0) / span * W, (y1 - arr[:, 1]) / (y1 - y0) * H)

    # 站点标记（去重；标号 = 路线号 DR-gid）
    marks = {}
    for L in legs:
        for k, a in enumerate(L["anchors"]):
            key = (round(a["x"], 1), round(a["y"], 1), a["name"])
            m = marks.setdefault(key, {"x": a["x"], "y": a["y"], "name": a["name"],
                                       "label": a["label"], "kind": a["kind"],
                                       "n_leg": 0, "terminal": False, "nos": set(), "refs": []})
            m["n_leg"] += 1
            m["nos"].add(L["gid"])
            m["refs"].append(L["name"])
            if k == len(L["anchors"]) - 1:
                m["terminal"] = True
    mark_list = []
    for m in marks.values():
        px, py = to_px(np.array([[m["x"], m["y"]]]))
        nos = sorted(m["nos"])
        txt = "/".join(str(n) for n in nos[:3]) + ("…" if len(nos) > 3 else "")
        mark_list.append({"x": round(float(px[0]), 1), "y": round(float(py[0]), 1),
                          "name": m["name"], "label": m["label"], "kind": m["kind"],
                          "n_leg": m["n_leg"], "terminal": m["terminal"],
                          "sc": nos[0] - 1 if len(nos) == 1 else -1,
                          "txt": txt, "refs": "、".join(m["refs"])})
    print(f"[marks] 站点去重后 {len(mark_list)} 个")

    legs_px = []
    for L in legs:
        pts = [{"x": round(float(to_px(np.array([[a["x"], a["y"]]]))[0][0]), 1),
                "y": round(float(to_px(np.array([[a["x"], a["y"]]]))[1][0]), 1),
                "role": a["role"], "kind": a["kind"], "name": a["name"]}
               for a in L["anchors"]]
        legs_px.append({"gid": L["gid"], "name": L["name"], "pts": pts})

    # ---- 栅格灰底 ------------------------------------------------------
    A_img = Image.new("RGBA", (W, H), (255, 255, 255, 255))
    dA = ImageDraw.Draw(A_img)
    draw_net = 0
    for P in net_xy:
        px, py = to_px(P)
        if px.max() < 0 or px.min() > W or py.max() < 0 or py.min() > H:
            continue
        dA.line(list(zip(px.tolist(), py.tolist())), fill=C_GRID + (255,), width=W_GRID, joint="curve")
        draw_net += 1
    print(f"[raster] 画入视窗宽凳 link {draw_net} ({time.time()-t0:.1f}s)")

    # 红线栅格版（HTML 里仍走矢量，PNG 仅留档）
    R_img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dR = ImageDraw.Draw(R_img)
    for L in legs:
        for P in L["polys"]:
            px, py = to_px(P)
            xy = list(zip(px.tolist(), py.tolist()))
            dR.line(xy, fill=C_CASE + (255,), width=W_CASE, joint="curve")
            dR.line(xy, fill=C_ROUTE + (250,), width=W_ROUTE, joint="curve")
    comp = Image.alpha_composite(A_img, R_img)
    dC = ImageDraw.Draw(comp)
    try:
        from PIL import ImageFont
        FNO = ImageFont.truetype("C:/Windows/Fonts/msyhbd.ttc", 42)
    except Exception:
        FNO = None
    for L in legs:
        for k, a in enumerate(L["anchors"]):
            ax_, ay_ = to_px(np.array([[a["x"], a["y"]]]))
            ax_, ay_ = float(ax_[0]), float(ay_[0])
            if k == len(L["anchors"]) - 1:
                dC.ellipse([ax_ - 12, ay_ - 12, ax_ + 12, ay_ + 12], outline=C_END + (255,), width=4)
            if k == 0:
                dC.ellipse([ax_ - 8, ay_ - 8, ax_ + 8, ay_ + 8], fill=C_BASE + (255,), outline=(255, 255, 255, 255), width=3)
            else:
                dC.ellipse([ax_ - 6, ay_ - 6, ax_ + 6, ay_ + 6], fill=C_VIA + (255,), outline=(255, 255, 255, 255), width=2)
    for m in mark_list:
        if not m["txt"] or not (0 <= m["x"] <= W and 0 <= m["y"] <= H):
            continue
        col = tuple(int(PALETTE[m["sc"]][i:i + 2], 16) for i in (1, 3, 5)) if m["sc"] >= 0 else (20, 24, 31)
        dC.text((m["x"] + 14, m["y"] - 46), m["txt"], font=FNO, fill=col,
                stroke_width=6, stroke_fill=(255, 255, 255))
    comp.convert("RGB").save(OUT / "deeproute_kd_routes.png", optimize=True)
    print(f"[png] saved ({time.time()-t0:.1f}s)")

    # 灰底 base64（调色板量化，与 v3 同款）
    rgbA = A_img.convert("RGB")
    ncol = len(rgbA.getcolors(1 << 20) or []) or 256
    Ap = rgbA.quantize(colors=min(256, max(4, ncol)),
                       method=Image.FASTOCTREE, dither=Image.Dither.NONE)
    buf = io.BytesIO()
    Ap.save(buf, "PNG", optimize=True)
    a64 = base64.b64encode(buf.getvalue()).decode("ascii")
    print(f"[embed] 灰底 → {buf.tell()/1e6:.3f}MB")

    # ---- Δ+varint+base64 编码 ------------------------------------------
    PPREC = 10.0

    def enc_paths(xy_list, prec=PPREC):
        out = []
        def uv(n):
            while True:
                b = n & 0x7F
                n >>= 7
                if n:
                    out.append(b | 0x80)
                else:
                    out.append(b)
                    return
        def sv(v):
            uv((v << 1) if v >= 0 else ((-v << 1) - 1))
        for P in xy_list:
            px, py = to_px(P)
            qx = np.rint(px * prec).astype("int64")
            qy = np.rint(py * prec).astype("int64")
            uv(len(qx)); sv(int(qx[0])); sv(int(qy[0]))
            for a, b in zip(np.diff(qx).tolist(), np.diff(qy).tolist()):
                sv(int(a)); sv(int(b))
        return base64.b64encode(bytes(out)).decode("ascii")

    route_b64 = enc_paths([P for L in legs for P in L["polys"]])
    leg_route_b64 = [enc_paths(L["polys"]) if L["polys"] else "" for L in legs]
    leg_route_idx = {L["gid"]: i for i, L in enumerate(legs)}
    chain_b64 = enc_paths([np.asarray([(a["x"], a["y"]) for a in L["anchors"]], "f8") for L in legs])
    print(f"[enc] {sum(len(P) for L in legs for P in L['polys']):,} 点 → RT {len(route_b64)/1024:.0f} KB / CH {len(chain_b64)/1024:.0f} KB")

    # ---- 高德 POI 打点层（与排班页同款，只保留核心 ODD 类） --------------
    _vk = []
    for _i in range(len(gn)):
        _n = int(gn[_i])
        if _n < 2:
            continue
        _vk.append(np.full(_n, _i, dtype="i8"))
    _vlink = np.concatenate(_vk)
    _vtree = cKDTree(all_pts)

    def _link_dist(q):
        _, idx = _vtree.query(q, k=8)
        out_d = np.full(len(q), np.inf)
        for i in range(len(q)):
            seen = []
            for j in np.atleast_1d(idx[i]):
                li = int(_vlink[j])
                if li not in seen:
                    seen.append(li)
            for li in seen:
                o, n = int(goff[li]), int(gn[li])
                if n < 2:
                    continue
                S = np.asarray(geom[o:o + n])
                sx, sy = to_xy(S[:, 0], S[:, 1])
                A_, B_ = np.column_stack([sx[:-1], sy[:-1]]), np.column_stack([sx[1:], sy[1:]])
                AB = B_ - A_
                L2 = (AB ** 2).sum(1)
                L2[L2 == 0] = 1e-9
                AP = q[i] - A_
                t = np.clip((AP * AB).sum(1) / L2, 0, 1)
                C_ = A_ + t[:, None] * AB
                d = np.hypot(q[i, 0] - C_[:, 0], q[i, 1] - C_[:, 1]).min()
                if d < out_d[i]:
                    out_d[i] = d
        return out_d

    def enc_dots(lon_lat_arr, prec=PPREC):
        if len(lon_lat_arr) == 0:
            return ""
        x, y = to_xy(lon_lat_arr[:, 0], lon_lat_arr[:, 1])
        px, py = to_px(np.column_stack([x, y]))
        q = np.rint(np.column_stack([px, py]) * prec).astype("int64")
        q = q[(q[:, 0] >= 0) & (q[:, 0] <= W * prec) & (q[:, 1] >= 0) & (q[:, 1] <= H * prec)]
        q = q[np.lexsort((q[:, 1], q[:, 0]))]
        out = []
        def uv(n):
            while True:
                b = n & 0x7F
                n >>= 7
                if n:
                    out.append(b | 0x80)
                else:
                    out.append(b)
                    return
        def sv(v):
            uv((v << 1) if v >= 0 else ((-v << 1) - 1))
        uv(len(q)); sv(int(q[0, 0])); sv(int(q[0, 1]))
        for a, b in zip(np.diff(q[:, 0]).tolist(), np.diff(q[:, 1]).tolist()):
            sv(int(a)); sv(int(b))
        return base64.b64encode(bytes(out)).decode("ascii")

    AMAP_LAYERS = [
        ("sch",  "amap_schools",       "学校",     "#1e6fd9", 1.8),
        ("hosp", "amap_hospitals",     "医院",     "#d92b2b", 1.8),
        ("fire", "amap_fire_stations", "消防站",   "#e03030", 1.6),
        ("ic",   "amap_interchanges",  "立交桥",   "#9a4a9e", 1.8),
        ("toll", "amap_tolls",         "收费站",   "#8a6d1f", 1.6),
    ]
    amap_dots, amap_cnt = {}, {}
    for key, fn, _lab, _col, _r in AMAP_LAYERS:
        fp = ROOT / "data" / (fn + ".json")
        if not fp.exists():
            amap_dots[key], amap_cnt[key] = "", (0, 0)
            continue
        d = json.loads(fp.read_text(encoding="utf-8"))
        pts = []
        for p in d.get("pois", []):
            loc = p.get("location")
            if isinstance(loc, str) and "," in loc:
                a, b = loc.split(",", 1)
                try:
                    pts.append([float(a), float(b)])
                except ValueError:
                    pass
            elif isinstance(loc, list) and len(loc) == 2:
                pts.append([float(loc[0]), float(loc[1])])
        raw_n = len(pts)
        if pts:
            g = np.asarray(pts, "f8")
            gx, gy = to_xy(g[:, 0], g[:, 1])
            keep = _link_dist(np.column_stack([gx, gy])) <= 200.0
            amap_dots[key] = enc_dots(g[keep])
            amap_cnt[key] = (int(keep.sum()), raw_n)
        else:
            amap_dots[key], amap_cnt[key] = "", (0, raw_n)
    print("[amap] " + " · ".join(f"{k} {amap_cnt[k][0]}/{amap_cnt[k][1]}" for k, *_ in AMAP_LAYERS))

    # ---- 导航 URI：高德 ditu.amap.com/dir（方括号必须 %5B%5D）----------
    def _qq_uri(pts):
        def nm(p):
            return quote(p["name"] or p["label"] or "")
        def co(p):
            return f"{p['gcj'][0]:.6f},{p['gcj'][1]:.6f}"
        ts = "1793006744000"
        qs = ["type=car", "policy=1",
              f"from%5Blnglat%5D={co(pts[0])}", f"from%5Bname%5D={nm(pts[0])}",
              f"from%5Bid%5D={ts}-from",
              f"to%5Blnglat%5D={co(pts[-1])}", f"to%5Bname%5D={nm(pts[-1])}",
              f"to%5Bid%5D={ts}-to"]
        for i, p in enumerate(pts[1:-1]):
            qs.append(f"via%5B{i}%5D%5Blnglat%5D={co(p)}")
            qs.append(f"via%5B{i}%5D%5Bname%5D={nm(p)}")
            qs.append(f"via%5B{i}%5D%5Bmodxy%5D={co(p)}")
            qs.append(f"via%5B{i}%5D%5Badcode%5D=441302")
        qs += ["src=huicheng-deeproute", "callnative=0", "innersrc=uriapi"]
        return "https://ditu.amap.com/dir?" + "&".join(qs)

    for L in legs:
        L["uri_fwd"] = _qq_uri(L["anchors"])
        L["uri_rev"] = _qq_uri(list(reversed(L["anchors"])))

    stats = {
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "legs": n_legs,
        "route_km": round(sum(L["km"] for L in legs), 1),
        "km_declared": round(float(plan["totalKm"]), 1),
        "anchors_covered": int(sum(L["n_anchor"] for L in legs)),
        "stations": int(sum(len(L["anchors"]) for L in legs)),
    }
    data = {"stats": stats, "by_route": None, "W": W, "H": H,
            "route_b64": route_b64, "chain_b64": chain_b64,
            "prec": PPREC, "marks": mark_list, "legs_px": legs_px,
            "leg_route_b64": leg_route_b64, "leg_route_idx": leg_route_idx,
            "pal": PALETTE,
            "amap_layers": [{"key": k, "label": lab, "color": col, "r": r,
                             "b64": amap_dots[k], "n": amap_cnt[k][0], "raw": amap_cnt[k][1]}
                            for k, _f, lab, col, r in AMAP_LAYERS]}
    _write_html(OUT / "deeproute_kd_routes.html", data, a64, legs)
    print(f"[done] html {(OUT/'deeproute_kd_routes.html').stat().st_size/1e6:.2f}MB  ({time.time()-t0:.1f}s)")


def _write_html(path: Path, data, a64, legs):
    st = data["stats"]
    cards = [
        (f'{st["legs"]} 条专项路线', f'{st["route_km"]:,.1f}', "km",
         f'deeproute 一周计划 · 快照声明 {st["km_declared"]:,.1f} km'),
        ("覆盖锚点", f'{st["anchors_covered"]:,}', "个",
         '学校/医院/桥梁/隧道/立交/工况路/施工… 高价值 ODD 点'),
        ("站点", f'{st["stations"]}', "个",
         '每条 4 站点（起点+2 站点+终点），可切 3 段连续执行'),
        ("宽凳路网（全市）", "—", "", "灰底 · 交付的全部 ROAD_LINK"),
    ]
    card_html = "".join(
        f'<div class="card"><div class="k">{k}</div><div class="v">{v}<span class="u">{u}</span></div><div class="s">{s}</div></div>'
        for k, v, u, s in cards)

    trs = ""
    for L in legs:
        names = " → ".join(
            f'<span class="an {a["kind"]}"><b>{a["name"] or a["label"]}</b>({a["gcj"][0]:.6f},{a["gcj"][1]:.6f})</span>'
            for a in L["anchors"])
        col = data["pal"][(L["gid"] - 1) % len(data["pal"])]
        trs += (f'<tr class="lrow" data-gid="{L["gid"]}" title="点击在地图上描出本路线 起点/站点/终点">'
                f'<td class="rn"><span class="gid" style="background:{col}">{L["gid"]}</span>'
                f'<span class="ln" style="color:{col}">{L["name"]}</span></td>'
                f'<td class="an-list">{names}</td>'
                f'<td class="num">{L["km"]:.1f}km</td><td class="num">≈{L["min"]}min</td>'
                f'<td class="num">{L["n_anchor"]}</td>'
                f'<td class="slot"><a href="{L["uri_fwd"]}" target="_blank" onclick="event.stopPropagation()">去程 ↗</a>'
                f' <a href="{L["uri_rev"]}" target="_blank" onclick="event.stopPropagation()">返程 ↗</a></td></tr>')

    tpl = r"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>惠城区 · __NLEGS__ 条 deeproute 专项路线 × 宽凳路网</title>
<style>
:root{--bg:#f5f6f8;--fg:#1f2329;--mut:#6b7280;--line:#e3e6eb;--card:#fff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif}
header{padding:18px 26px 12px}h1{margin:0;font-size:20px}
.sub{font-size:12.5px;margin-top:6px;line-height:2}
.sub2{color:var(--mut);font-size:11.5px;margin-top:7px;max-width:1180px;line-height:1.9}
.pill{display:inline-flex;align-items:center;margin:2px 6px 2px 0;padding:1px 8px;border:1px solid;border-radius:999px;font-size:11.5px;background:#fff;white-space:nowrap}
.pill i{display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:5px}
.pill.dot i{width:10px;height:10px;border-radius:50%}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:0 26px 14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card .k{font-size:12px;color:var(--mut)}.card .v{font-size:23px;font-weight:700;margin-top:2px}
.card .v .u{font-size:12px;font-weight:400;color:var(--mut);margin-left:3px}.card .s{font-size:11.5px;color:var(--mut);margin-top:2px}
.wrap{display:grid;grid-template-columns:minmax(430px,62%) 6px minmax(420px,1fr);gap:0;padding:0 26px 26px}
#splitter{cursor:col-resize;background:var(--line);border-radius:3px;margin:0 4px;position:relative}
#splitter:hover,#splitter.drag{background:#1a66b3}
#mapbox{position:relative;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden;height:88vh}
#stage{position:absolute;left:0;top:0;transform-origin:0 0}
#stage img,#stage svg{position:absolute;left:0;top:0;width:100%;height:100%}
#stage svg{pointer-events:none}
#stage{--sw:11;--swc:24.5;--sda:45;--sdb:32;--smk:5.8;--sf:87;--sh:17.4;--sg:20;--sg2:14;--slk:3.0;--olk:2.2}
#grt path{stroke-width:calc(var(--sw) * 1px)}
#grt path.cs{stroke-width:calc(var(--swc) * 1px)}
#gch path{stroke-width:calc(var(--sw) * 1px);stroke-dasharray:calc(var(--sda) * 1px) calc(var(--sdb) * 1px)}
#gmk circle{stroke-width:calc(var(--smk) * 1px)}
#stage.dim #grt path{stroke-opacity:.16}
#stage.dim #grt path.cs{stroke-opacity:.10}
#stage.dim #gch path{stroke-opacity:.25}
#ghl path.hlw{stroke-width:calc(var(--shl) * 1px)}
#ghl path.hlc{stroke-width:calc(var(--shlc) * 1px)}
#gno text{font-size:calc(var(--sf) * 1px);font-weight:700;fill:#14181f;
 font-family:"Microsoft YaHei",system-ui,sans-serif;
 stroke:#fff;stroke-width:calc(var(--sh) * 1px);paint-order:stroke}
.legend{position:absolute;left:12px;bottom:12px;background:rgba(255,255,255,.95);border:1px solid var(--line);border-radius:8px;padding:8px 11px;font-size:12px;z-index:5}
.legend i{display:inline-block;width:13px;height:3px;border-radius:2px;margin-right:6px;vertical-align:middle}
.legend i.d{width:10px;height:10px;border-radius:50%}
.legend b.nbdemo{display:inline-block;min-width:14px;padding:0 3px;margin-right:6px;border-radius:4px;
 background:#14181f;color:#fff;font-size:11px;font-weight:700;text-align:center;line-height:15px}
.ctrls{position:absolute;right:12px;top:12px;background:rgba(255,255,255,.95);border:1px solid var(--line);border-radius:8px;padding:8px 11px;font-size:12.5px;z-index:5}
.ctrls label{display:block;cursor:pointer;user-select:none;white-space:nowrap}
.ctrls button{margin-top:6px;width:100%;font:12px inherit;padding:3px 0;border:1px solid var(--line);background:#fff;border-radius:6px;cursor:pointer}
aside{background:#fff;border:1px solid var(--line);border-radius:10px;overflow:auto;height:82vh;padding:12px 14px}
aside h2{font-size:15px;margin:2px 0 4px}aside .hint{font-size:11.5px;color:var(--mut);margin-bottom:10px}
table.rt{width:100%;border-collapse:collapse;margin-top:8px;font-size:11.5px;table-layout:fixed}
table.rt th{background:#f0f2f5;font-weight:600;text-align:left;padding:4px 5px;white-space:nowrap}
table.rt td{border-top:1px solid var(--line);padding:5px;vertical-align:top}
td.rn{white-space:nowrap}
td.rn .gid{display:inline-block;min-width:17px;padding:0 4px;border-radius:4px;color:#fff;
 font-size:10.5px;font-weight:700;line-height:15px;text-align:center;margin-right:5px}
td.rn .ln{font-size:11px;font-weight:600}
td.num{text-align:right;white-space:nowrap}
td.an-list{line-height:1.9;overflow-wrap:anywhere}td.slot{white-space:normal;min-width:104px}td.slot a{white-space:nowrap}
span.an{display:inline-block;padding:0 5px;margin:1px 2px 1px 0;border-radius:4px;background:#f3f4f6;border:1px solid #e5e7eb;font-size:11px;white-space:normal;overflow-wrap:anywhere;line-height:1.55}
span.an b{white-space:nowrap}
a{color:#1557db;text-decoration:none}a:hover{text-decoration:underline}
tr.lrow{cursor:pointer}tr.lrow:hover{background:#fff8e6}
tr.lrow.sel{background:#fdeeea;outline:1px solid #f0b9a6;outline-offset:-1px}
aside .hint .tip{display:block;margin-top:6px;color:#9a4a06}
</style></head><body>
<header><h1>惠城区 · __NLEGS__ 条 deeproute 专项路线 × 宽凳路网</h1>
 <div class="sub"><b>怎么读这张图：</b>
 <span class="pill" style="border-color:#7a8494"><i style="background:#7a8494"></i>灰 = 宽凳路网</span>
 <span class="pill" style="border-color:#de1c08"><i style="background:#de1c08"></i>红 = __NLEGS__ 条专项路线（高德 GCJ02 折线）</span>
 <span class="pill dot" style="border-color:#10824a"><i style="background:#10824a"></i>绿点 = 起点</span>
 <span class="pill dot" style="border-color:#e8940c"><i style="background:#e8940c"></i>橙点 = 站点</span>
 <span class="pill dot" style="border-color:#781414"><i style="background:#fff;border:2px solid #781414;width:6px;height:6px"></i>深红圈 = 终点</span></div>
<div class="sub2">口径：__NLEGS__ 条 deeproute 专项路线（一周 __ROUTEKM__ km），每条 4 站点 / 3 段连续执行。
路线折线为高德驾车路径（GCJ02），叠在宽凳灰底路网上。点击明细行可在地图上描出该路线的起点/站点/终点并高亮折线。生成 __GEN__</div></header>
<div class="cards">__CARDS__</div>
<div class="wrap">
 <div id="mapbox">
  <div class="ctrls">
   <label><input type="checkbox" id="l0" checked> 宽凳路网（灰底）</label>
   <label><input type="checkbox" id="l1" checked> __NLEGS__ 条专项路线（红）</label>
__AMAP_CTRLS__
   <button id="fit">复位</button>
  </div>
  <div class="legend">
   <div><i style="background:#7a8494"></i>宽凳路网（全部）</div>
   <div><i style="background:#de1c08"></i>__NLEGS__ 条专项路线</div>
   <div><i class="d" style="background:#10824a"></i>起点 <i class="d" style="background:#e8940c;margin-left:8px"></i>站点 <i class="d" style="background:#fff;border:2px solid #781414;width:6px;height:6px"></i>终点</div>
   <div><b class="nbdemo">1</b> 站点标号（= 路线号 1–__NLEGS__）</div>
   <div><i style="background:#3c4250"></i>站点直连（开关）</div>
  </div>
  <div id="stage"><img id="img0" src="data:image/png;base64,__A64__" alt="" draggable="false"></div>
  <div id="gselbox" style="position:absolute;left:12px;top:12px;background:rgba(255,255,255,.97);border:1px solid #f0b9a6;border-radius:8px;padding:6px 11px;font-size:12.5px;z-index:6;display:none"></div>
 </div>
 <div id="splitter" title="拖动调整 地图 / 明细 宽度（双击复位）"></div>
 <aside><h2>__NLEGS__ 条路线明细（起点 → 站点 → 终点）</h2>
  <div class="hint"><b>deeproute 专项路线</b>：一周 1000km 高价值测试计划，每条 ≈60km、4 站点切 3 段连续执行。
   <br><span class="tip">💡 点击任意路线行：在地图上描出该路线的起点/站点/终点并高亮折线、其余调暗、缩放定位；再点一次取消。</span></div>
  <table class="rt"><colgroup><col style="width:58px"><col><col style="width:52px"><col style="width:54px"><col style="width:56px"><col class="c-nav"></colgroup>
  <tr><th>路线</th><th>起点 → 站点 → 终点</th><th>里程</th><th>时长</th><th>覆盖锚点</th><th>导航</th></tr>__ROWS__</table></aside>
</div>
<script>
const W=__W__,H=__H__,MK=__MK__,PAL=__PAL__,PREC=__PREC__;
const RTB="__RTB__",CHB="__CHB__";
const stage=document.getElementById('stage');
stage.style.width=W+'px';stage.style.height=H+'px';
function decPaths(b64,prec){
 const s=atob(b64),L=s.length;let p=0;
 function uv(){let r=0,sh=1,b;do{b=s.charCodeAt(p++);r+=(b&127)*sh;sh*=128;}while(b&128);return r;}
 function sv(){const u=uv();return (u&1)?-((u+1)/2):(u/2);}
 const out=[];
 while(p<L){
  const n=uv();let x=sv(),y=sv();
  const a=['M',(x/prec).toFixed(1),',',(y/prec).toFixed(1)];
  for(let i=1;i<n;i++){x+=sv();y+=sv();a.push('L',(x/prec).toFixed(1),',',(y/prec).toFixed(1));}
  out.push(a.join(''));
 }
 return out;
}
const RT=decPaths(RTB,PREC),CH=decPaths(CHB,PREC);
const marksHtml=MK.map(m=>{
 const c=m.kind==='base'?'#10824a':'#e8940c';
 const r=m.kind==='base'?3.6:2.5;
 const ring=m.terminal?'<circle cx="'+m.x+'" cy="'+m.y+'" data-r0="'+(r+2)+'" fill="none" stroke="#781414"/>':'';
 return ring+'<circle cx="'+m.x+'" cy="'+m.y+'" data-r0="'+r+'" fill="'+c+'" stroke="#fff"><title>'+
   m.label+' · '+m.name+'（'+m.n_leg+' 条路线经过）</title></circle>';
}).join('');
stage.insertAdjacentHTML('beforeend','<svg id="svg" viewBox="0 0 '+W+' '+H+'">'
 +'<g id="gch" style="display:none"></g><g id="grt"></g>'
 +'<g id="gmk" style="display:none">'+marksHtml+'</g><g id="gno" style="display:none"></g>'
 +'<g id="ghl" style="display:none"></g><g id="gsel"></g>'
 +'__POI_GROUPS__'+'</svg>');
function decDots(b64,prec){
 if(!b64)return [];
 const s=atob(b64),L=s.length;let p=0;
 function uv(){let r=0,sh=1,b;do{b=s.charCodeAt(p++);r+=(b&127)*sh;sh*=128;}while(b&128);return r;}
 function sv(){const u=uv();return (u&1)?-((u+1)/2):(u/2);}
 const n=uv(),a=new Float64Array(n*2);let x=sv(),y=sv();
 a[0]=x/prec;a[1]=y/prec;
 for(let i=1;i<n;i++){x+=sv();y+=sv();a[i*2]=x/prec;a[i*2+1]=y/prec;}
 return a;
}
function dotPath(P,r){
 const rf=r.toFixed(2), df=(2*r).toFixed(2), a=[];
 for(let i=0;i<P.length;i+=2){
  a.push('M ',P[i].toFixed(1),' ',P[i+1].toFixed(1),
         ' m -',rf,' 0 a ',rf,' ',rf,' 0 1 0 ',df,' 0 a ',rf,' ',rf,' 0 1 0 -',df,' 0');
 }
 return a.join('');
}
const AMAPL=__AMAPL__;
const POI_EL=[],POI_DOTS={};
function addPoiLayer(){
 for(const L of AMAPL){
  if(!L.b64)continue;
  const g=document.getElementById('ga_'+L.key);if(!g)continue;
  const P=decDots(L.b64,PREC);POI_DOTS[L.key]=P;
  const p=mk(dotPath(P,L.r),'','x',1);
  p.setAttribute('fill',L.color);
  p.setAttribute('stroke','#fff');p.setAttribute('stroke-width','.35');
  g.appendChild(p);
  const cb=document.getElementById('a_'+L.key);
  g.style.display=(cb&&cb.checked)?'block':'none';
  POI_EL.push({el:p,key:L.key,r0:L.r});
 }
}
function poiRescale(){
 const rr=1/s;
 for(const o of POI_EL){
  o.el.setAttribute('d',dotPath(POI_DOTS[o.key],o.r0*rr));
 }
}
requestAnimationFrame(function(){requestAnimationFrame(function(){addPoiLayer();poiRescale();});});
const NS='http://www.w3.org/2000/svg';
const NO_EL=[];
let _i=0;
for(const m of MK){
 if(!m.txt) continue;
 const t=document.createElementNS(NS,'text');
 t.setAttribute('class','nb');t.setAttribute('dominant-baseline','central');
 t.setAttribute('text-anchor','middle');
 t.setAttribute('fill', m.sc>=0 && PAL[m.sc] ? PAL[m.sc] : '#14181f');
 t.textContent=m.txt;
 const ti=document.createElementNS(NS,'title');
 ti.textContent=m.refs+' —— '+m.name;
 t.appendChild(ti);
 document.getElementById('gno').appendChild(t);
 const a=_i*2.399963229728653;_i++;
 NO_EL.push({el:t,x:m.x,y:m.y,c:Math.cos(a),sn:Math.sin(a)});
}
function mk(d,cls,c,op,cap){
 const p=document.createElementNS('http://www.w3.org/2000/svg','path');
 p.setAttribute('d',d);p.setAttribute('fill','none');p.setAttribute('stroke',c);
 p.setAttribute('stroke-opacity',op);
 if(cls)p.setAttribute('class',cls);
 p.setAttribute('stroke-linejoin',cap||'round');p.setAttribute('stroke-linecap',cap||'round');
 return p;
}
const grt=document.getElementById('grt'),gch=document.getElementById('gch');
const RTC=RT.join(''),CHC=CH.join('');
function addRoutePaths(){
 grt.appendChild(mk(RTC,'cs','#ffffff',1));
 grt.appendChild(mk(RTC,'',"#de1c08",0.95));
 gch.appendChild(mk(CHC,'ch','#3c4250',0.8,'butt'));
}
requestAnimationFrame(function(){requestAnimationFrame(addRoutePaths);});
const MK_EL=[...document.querySelectorAll('#gmk circle')];
const box=document.getElementById('mapbox');
let s=1,tx=0,ty=0,fit=1;
const SW_PX=1.7,SC_PX=3.8,SD1_PX=7,SD2_PX=5,SMK_PX=0.9,SF_PX=13.5,SH_PX=2.7;
function rescale(){
 const k=1/s;
 stage.style.setProperty('--sw', (SW_PX*k).toFixed(2));
 stage.style.setProperty('--swc',(SC_PX*k).toFixed(2));
 stage.style.setProperty('--sda',(SD1_PX*k).toFixed(2));
 stage.style.setProperty('--sdb',(SD2_PX*k).toFixed(2));
 stage.style.setProperty('--smk',(SMK_PX*k).toFixed(2));
 stage.style.setProperty('--sf', (SF_PX*k).toFixed(2));
 stage.style.setProperty('--sh', (SH_PX*k).toFixed(2));
 stage.style.setProperty('--shl',(4.5*k).toFixed(2));
 stage.style.setProperty('--shlc',(7.5*k).toFixed(2));
 for(const c of MK_EL){c.setAttribute('r',(parseFloat(c.dataset.r0)*k).toFixed(2));}
 const R=14.5*k;
 for(const n of NO_EL){const dx=(n.c*R).toFixed(1), dy=(n.sn*R).toFixed(1);
                       n.el.setAttribute('x',(n.x+parseFloat(dx)).toFixed(1));
                       n.el.setAttribute('y',(n.y+parseFloat(dy)).toFixed(1));}
 if(typeof poiRescale==='function')poiRescale();
}
function apply(){stage.style.transform='translate('+tx+'px,'+ty+'px) scale('+s+')';rescale();}
function fitView(){fit=Math.min(box.clientWidth/W,box.clientHeight/H);s=fit*0.98;
 tx=(box.clientWidth-W*s)/2;ty=(box.clientHeight-H*s)/2;apply();}
(function(){
 const sp=document.getElementById('splitter'),wrap=document.querySelector('.wrap');
 const KEY='hc_dr_map_ratio',DEF=0.62;
 function setRatio(r){
  r=Math.max(0.30,Math.min(0.85,r));
  const rect=wrap.getBoundingClientRect();
  const mapPx=Math.round(rect.width*r-3);
  wrap.style.gridTemplateColumns=mapPx+'px 6px minmax(400px,1fr)';
  try{localStorage.setItem(KEY,r);}catch(e){}
  fitView();
 }
 sp.addEventListener('pointerdown',e=>{
  e.preventDefault();
  sp.classList.add('drag');sp.setPointerCapture(e.pointerId);
  document.body.style.userSelect='none';
  const rect=wrap.getBoundingClientRect();
  const move=ev=>{setRatio((ev.clientX-rect.left)/rect.width);};
  const up=ev=>{sp.classList.remove('drag');document.body.style.userSelect='';
   window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);};
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);
 });
 sp.addEventListener('dblclick',()=>{try{localStorage.removeItem(KEY);}catch(e){};setRatio(DEF);});
 try{const saved=parseFloat(localStorage.getItem(KEY));if(isFinite(saved)&&saved>0)setRatio(saved);}catch(e){}
 window.addEventListener('resize',()=>{try{const saved=parseFloat(localStorage.getItem(KEY));if(isFinite(saved)&&saved>0)setRatio(saved);else fitView();}catch(e){fitView();}});
})();
let zFix=1;
(function(){const m=location.hash.match(/[#&]z=([\d.]+)/);
 if(m){const z=parseFloat(m[1]);if(isFinite(z)&&z>0)zFix=z;}})();
function fitInit(){fitView();
 if(zFix!==1){s=fit*zFix;tx=(box.clientWidth-W*s)/2;ty=(box.clientHeight-H*s)/2;apply();}}
function setVis(id,v){document.getElementById(id).style.display=v?'block':'none';}
const L0=document.getElementById('l0'),L1=document.getElementById('l1');
const A_CTRLS=[];
for(const L of AMAPL){const c=document.getElementById('a_'+L.key);if(c)A_CTRLS.push(c);}
function sync(){
 setVis('img0',L0.checked);
 setVis('grt',L1.checked);
 for(const c of A_CTRLS)setVis('ga_'+c.id.slice(2),c.checked);
}
L0.onchange=sync;L1.onchange=sync;
for(const c of A_CTRLS)c.onchange=sync;
if(location.hash.indexOf('poin')>=0){for(const c of A_CTRLS)c.checked=true;sync();}
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
// ---- 点击明细行 → 描站点 + 高亮折线 ----
const LEGSP=__LEGSP__;
const LEGB64=__LEGB64__,LEGIDX=__LEGIDX__;
let selGid=null;
function selLeg(gid,fromUser){
 if(fromUser&&selGid===gid){selGid=null;}else{selGid=gid;}
 document.querySelectorAll('tr.lrow').forEach(r=>r.classList.toggle('sel',+r.dataset.gid===selGid));
 const gsel=document.getElementById('gsel');
 gsel.innerHTML='';
 if(selGid==null){
  document.getElementById('gselbox').style.display='none';
  document.getElementById('ghl').style.display='none';stage.classList.remove('dim');
  return;
 }
 const L=LEGSP.find(l=>l.gid===selGid);
 if(!L)return;
 const ghl=document.getElementById('ghl');
 ghl.innerHTML='';ghl.style.display='block';stage.classList.add('dim');
 const li=LEGIDX[String(selGid)];
 if(li!=null&&LEGB64[li]){
  const ds=decPaths(LEGB64[li],PREC);
  if(ds.length){
   ghl.appendChild(mk(ds.join(''),'hlc','#ffffff',1));
   ghl.appendChild(mk(ds.join(''),'hlw','#1263ff',0.98));
  }
 }
 const k=1/s;
 const mkText=(x,y,txt,col,fs)=>{
  const t=document.createElementNS(NS,'text');
  t.setAttribute('x',x);t.setAttribute('y',y);
  t.setAttribute('fill',col);t.setAttribute('font-size',(fs*k).toFixed(1));
  t.setAttribute('font-weight','700');t.setAttribute('text-anchor','middle');
  t.setAttribute('stroke','#fff');t.setAttribute('stroke-width',(2.6*k).toFixed(2));
  t.setAttribute('paint-order','stroke');t.setAttribute('dominant-baseline','central');
  t.textContent=txt;
  gsel.appendChild(t);
  return t;
 };
 const RAD={起点:11,站点:9,终点:11};
 let viaNo=0;
 for(const p of L.pts){
  const col=p.role==='起点'?'#0b5c35':(p.role==='终点'?'#781414':'#8a4a00');
  const r=(RAD[p.role]*k).toFixed(2);
  if(p.role==='终点'){
   const ring=document.createElementNS(NS,'circle');
   ring.setAttribute('cx',p.x);ring.setAttribute('cy',p.y);ring.setAttribute('r',(r*1.35).toFixed(2));
   ring.setAttribute('fill','none');ring.setAttribute('stroke',col);ring.setAttribute('stroke-width',(3.2*k).toFixed(2));
   gsel.appendChild(ring);
  }
  const c=document.createElementNS(NS,'circle');
  c.setAttribute('cx',p.x);c.setAttribute('cy',p.y);c.setAttribute('r',r);
  c.setAttribute('fill',col);c.setAttribute('stroke','#fff');c.setAttribute('stroke-width',(2.2*k).toFixed(2));
  if(p.role==='站点')viaNo++;
  const label=p.role==='站点'?(L.name+'（站点'+viaNo+'）'):(L.name+'（'+p.role+'）');
  const ti=document.createElementNS(NS,'title');
  ti.textContent=L.name+' · '+p.role+' · '+p.name;
  c.appendChild(ti);gsel.appendChild(c);
  const side=(p.role==='站点')?(viaNo%2?1:-1):0;
  mkText(p.x+side*40*k,p.y-16*k,label,col,13);
 }
 const xs=L.pts.map(p=>p.x),ys=L.pts.map(p=>p.y);
 const x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
 const bw=(x1-x0)*0.14||40,bh=(y1-y0)*0.14||40;
 if(fromUser){
  s=Math.min(box.clientWidth/(x1-x0+2*bw),box.clientHeight/(y1-y0+2*bh),fit*60);
  tx=box.clientWidth/2-(x0-bw+(x1-x0)/2)*s;
  ty=box.clientHeight/2-(y0-bh+(y1-y0)/2)*s;
  apply();
 }
 const nb=document.getElementById('gselbox');
 nb.style.display='block';
 nb.innerHTML='<b>'+L.name+'</b>：已描出 '+L.pts.length+' 个站点 · <a href="javascript:void(0)" id="unsel">取消</a>';
 document.getElementById('unsel').onclick=()=>{selGid=null;
  document.querySelectorAll('tr.lrow').forEach(r=>r.classList.remove('sel'));
  gsel.innerHTML='';nb.style.display='none';
  document.getElementById('ghl').style.display='none';stage.classList.remove('dim');
  fitView();};
}
document.querySelectorAll('tr.lrow').forEach(r=>{
 r.addEventListener('click',()=>selLeg(+r.dataset.gid,true));
});
const _rescale0=rescale;
rescale=function(){_rescale0();if(selGid!=null){selLeg(selGid,false);}};
addEventListener('resize',fitView);
if(window.ResizeObserver){new ResizeObserver(fitView).observe(box);}
requestAnimationFrame(fitInit);setTimeout(fitInit,120);setTimeout(fitInit,600);
addEventListener('load',fitInit);
sync();fitInit();
</script></body></html>"""
    amap_l = data.get("amap_layers", [])
    amap_ctrls = "".join(
        f'<label style="border-top:1px solid var(--line);margin-top:4px;padding-top:4px"><input type="checkbox" id="a_{l["key"]}"> '
        f'ODD·{l["label"]} <span style="color:#6b7280">({l["n"]:,})</span></label>' for l in amap_l)
    poi_groups = "".join(f'<g id="ga_{l["key"]}" style="display:none"></g>' for l in amap_l)

    html = (tpl.replace("__CARDS__", card_html).replace("__ROWS__", trs)
            .replace("__AMAP_CTRLS__", amap_ctrls)
            .replace("__POI_GROUPS__", poi_groups)
            .replace("__AMAPL__", json.dumps(amap_l, ensure_ascii=False))
            .replace("__NLEGS__", str(st["legs"]))
            .replace("__W__", str(data["W"])).replace("__H__", str(data["H"]))
            .replace("__RTB__", data["route_b64"])
            .replace("__LEGB64__", json.dumps(data["leg_route_b64"]))
            .replace("__LEGIDX__", json.dumps(data["leg_route_idx"]))
            .replace("__CHB__", data["chain_b64"])
            .replace("__PREC__", str(data["prec"]))
            .replace("__MK__", json.dumps(data["marks"], ensure_ascii=False))
            .replace("__LEGSP__", json.dumps(data["legs_px"], ensure_ascii=False))
            .replace("__PAL__", json.dumps(data["pal"]))
            .replace("__A64__", a64)
            .replace("__GEN__", st["generated"])
            .replace("__ROUTEKM__", f'{st["route_km"]:,.1f}'))
    path.write_text(html, encoding="utf-8")


if __name__ == "__main__":
    main()