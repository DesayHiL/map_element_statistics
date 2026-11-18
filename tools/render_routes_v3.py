# -*- coding: utf-8 -*-
"""Stage 2 v3 — 排班路线 × 宽凳路网（条数随规划器输出动态变化）。

按用户要求改动:
  * 取消「蓝线=盲区」图层，全部路线以红色画出（白描边确保从灰网里跳出）。
  * 按「起点 / 途经点 / 终点」锚点体系呈现：锚点圆点 + 可选「锚点直连」虚线。
  * 底图改为**完整宽凳路网**（不再裁剪 441302），这样「哪里宽凳没测」由图直接可见。

输入: out/routes.json, out/_rkc_stats.json
输出: out/route_kuandeng_routes.png / .html / .json
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
R_BUFFER_M = 20.0
SAMPLE_STEP_M = 4.0

C_GRID = (108, 118, 136)
C_CASE = (255, 255, 255)
C_ROUTE = (222, 28, 8)
C_BASE = (16, 130, 74)        # 出发
C_VIA = (232, 148, 12)        # 途经点
C_END = (120, 20, 20)         # 终点外环
C_LINK = (60, 66, 80)         # 锚点直连虚线
C_GAP = (108, 118, 136)       # 缺口虚线（宽凳无路处）
W_GRID, W_CASE, W_ROUTE, W_GAP = 3, 7, 3, 3

# 18 个镇街的编号色：刻意避开路线红 #de1c08 与出发绿 #10824a，配白描边在浅底/红线上都读得清
PALETTE = ["#1f4e9c", "#8a5a00", "#0f6b6b", "#7a2f6b", "#6b3fa0", "#7a4a2b",
           "#a81f7a", "#4a5568", "#7a7a12", "#0e7c8c", "#2f3570", "#4a5c1f",
           "#6b5312", "#3b3b6b", "#5a2f5c", "#1d6fa5", "#14507a", "#3f3f46"]

LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0))
MLAT = 110574.0


def to_xy(lon, lat):
    return (np.asarray(lon, dtype="f8") - LON0) * MLON, (np.asarray(lat, dtype="f8") - LAT0) * MLAT


# ---- WGS84 → GCJ02（火星坐标）--------------------------------------------------
# 图里的路网/路线/锚点均为 GCJ02（kd_road_cover.wgs2gcj 同源公式）；宽凳停止线是
# WGS-84，不转整体偏 ~500m。numpy 向量版。
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


def main():
    t0 = time.time()
    doc = json.loads((OUT / "routes.json").read_text(encoding="utf-8"))

    fixed = np.load(CACHE / "ROAD_LINK.fixed.npy", mmap_mode="r")
    geom = np.memmap(CACHE / "ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
    goff = np.asarray(fixed["geom_off"], dtype="i8") // 16
    gn = np.asarray(fixed["geom_n"], dtype="i4")
    LEN = np.asarray(fixed["LENGTH"], dtype="f8")
    LINK_TYPE = np.asarray(fixed["LINK_TYPE"], dtype="i4")   # 0未调查/1普通/2路口内/3右转专用/4环岛

    # 宽凳 LANE 属性（公交专用道/非机动车道/右转专用道…；几何从 LANE.geom.bin）
    lane_fixed = np.load(CACHE / "LANE.fixed.npy", mmap_mode="r")
    lane_geom = np.memmap(CACHE / "LANE.geom.bin", dtype="<f8", mode="r", shape=(4926086, 2))
    lane_goff = np.asarray(lane_fixed["geom_off"], dtype="i8") // 16
    lane_gn = np.asarray(lane_fixed["geom_n"], dtype="i4")
    LANE_TYPE = np.asarray(lane_fixed["LANE_TYPE"], dtype="i4")

    # ---- 完整宽凳路网 -------------------------------------------------
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

    # ---- 宽凳约束版几何（本轮核心：路线只用宽凳 link）-----------------
    KD = json.loads((OUT / "routes_kd.json").read_text(encoding="utf-8"))
    kdmap = {(L["street"], L["n"]): L for L in KD["routes"]}
    PLAN = json.loads((OUT / "kd_route_plan.json").read_text(encoding="utf-8"))
    planmap = {(L["street"], L["n"]): L for L in PLAN["legs"]}
    print(f"[kd] 约束版几何 {len(kdmap)} 腿 · 可画 {KD['seg_on']+KD['seg_near']}/"
          f"{KD['seg_on']+KD['seg_near']+KD['seg_off']} 段 · 缺口 {KD['km_offKd']:.1f} km")

    # ---- 全部排班路线 + 锚点（几何取宽凳约束版）----------------------
    legs = []
    gid = 0
    for st in doc["routes"]:
        # 2026-10-16 宽凳闸门进规划器后，个别街道可能整条无路（status=no-anchors）→ 无 routes 键
        for ri, r in enumerate(st.get("routes", [])):
            gid += 1
            K = kdmap[(st["street"], ri + 1)]
            PL = planmap[(st["street"], ri + 1)]
            polys = []
            for P in K["polys"]:
                P = np.asarray(P, dtype="f8")
                x, y = to_xy(P[:, 0], P[:, 1])
                polys.append(np.column_stack([x, y]))
            gaps = []
            for g in K["gaps"]:
                gx, gy = to_xy(np.array([g["lon_a"], g["lon_b"]]), np.array([g["lat_a"], g["lat_b"]]))
                gaps.append(np.column_stack([gx, gy]))
            A = []
            for a in r["anchors"]:
                g = a.get("gcj") or a.get("gcjNative") or a.get("wgs")
                ax, ay = to_xy(g[0], g[1])
                A.append({"name": a.get("name") or "", "label": a.get("label") or "",
                          "kind": a.get("kind") or "", "x": float(ax), "y": float(ay),
                          "gcj": [float(g[0]), float(g[1])],
                          # 跨平台可搜索格式：名称(经度,纬度)
                          "name_geo": f'{a.get("name") or a.get("label") or ""}({float(g[0]):.6f},{float(g[1]):.6f})'})
            # 导航 URI —— 2026-10-26 用户指定：导航一律用高德网页版（ditu.amap.com/dir）。
            # 坐标为 GCJ02「经度,纬度」。按用户实测可用的 URL 格式对齐：
            #   from[lnglat]/from[name]/from[id]（id 用「时间戳-from」占位串）
            #   to 同上；via[i] 逐个递增索引，带 lnglat/name/modxy/adcode。
            # ⚠ 方括号必须 URL 编码（%5B%5D），未编码时高德页面会丢弃 via 途经点。
            def _qq_uri(pts):
                def nm(p):
                    return quote(p["name"] or p["label"] or "")
                def co(p):  # 高德序：经,纬
                    return f"{p['gcj'][0]:.6f},{p['gcj'][1]:.6f}"
                ts = "1793006744000"
                qs = [f"type=car", "policy=1",
                      f"from%5Blnglat%5D={co(pts[0])}", f"from%5Bname%5D={nm(pts[0])}",
                      f"from%5Bid%5D={ts}-from",
                      f"to%5Blnglat%5D={co(pts[-1])}", f"to%5Bname%5D={nm(pts[-1])}",
                      f"to%5Bid%5D={ts}-to"]
                for i, p in enumerate(pts[1:-1]):
                    qs.append(f"via%5B{i}%5D%5Blnglat%5D={co(p)}")
                    qs.append(f"via%5B{i}%5D%5Bname%5D={nm(p)}")
                    qs.append(f"via%5B{i}%5D%5Bmodxy%5D={co(p)}")
                    qs.append("via%5B{i}%5D%5Badcode%5D=441302".replace("{i}", str(i)))
                qs += ["src=huicheng-odd", "callnative=0", "innersrc=uriapi"]
                return "https://ditu.amap.com/dir?" + "&".join(qs)
            uri_fwd = _qq_uri(A)
            uri_rev = _qq_uri(list(reversed(A)))
            legs.append({"street": st["street"], "n": ri + 1, "gid": gid,
                         "km": K["distKm"], "km_amap": K["distKmAmap"], "min": r["durMin"],
                         "polys": polys, "gaps": gaps,
                         "status": K["status"], "n_gap": K["n_gap"], "n_gap_km": K["n_gap_km"],
                         "anchors": A, "uri": uri_fwd, "uri_fwd": uri_fwd, "uri_rev": uri_rev,
                         "chain": r.get("chain") or [], "pl": PL})
    print(f"[routes] {len(legs)} legs, {sum(len(l['anchors']) for l in legs)} anchors")

    # ---- 逐腿的「宽凳可画 / 缺口」里程 + 缺口性质分档 -----------------
    kd = cKDTree(all_pts)
    for L in legs:
        L["on_km"] = float(L["km"])
        L["off_km"] = float(L["n_gap_km"])
        # 缺口按「沿途有路率」分三种性质（与侧栏 chip 口径一致）
        segs = L["pl"]["segs"]
        ca = sum(s["km_amap"] for s in segs if s["tier"] == "offKd" and s["cover"] < 0.35)
        cb = sum(s["km_amap"] for s in segs if s["tier"] == "offKd" and 0.35 <= s["cover"] < 0.70)
        cc = sum(s["km_amap"] for s in segs if s["tier"] == "offKd" and s["cover"] >= 0.70)
        L["band_a"], L["band_b"], L["band_c"] = ca, cb, cc
        # 锚点距线偏差（证明几何仍在服务同名锚点链）
        pts = np.vstack(L["polys"]) if L["polys"] else np.zeros((0, 2))
        if len(pts):
            L["anchor_dev"] = [float(np.hypot(pts[:, 0] - a["x"], pts[:, 1] - a["y"]).min())
                               for a in L["anchors"]]
        else:
            L["anchor_dev"] = [float("nan")] * len(L["anchors"])
    on_km = sum(L["on_km"] for L in legs)
    off_km = sum(L["off_km"] for L in legs)
    band_a = sum(L["band_a"] for L in legs)
    band_b = sum(L["band_b"] for L in legs)
    band_c = sum(L["band_c"] for L in legs)
    route_km = sum(float(np.hypot(np.diff(P[:, 0]), np.diff(P[:, 1])).sum())
                   for L in legs for P in L["polys"]) / 1000.0
    devs = np.array([d for L in legs for d in L["anchor_dev"] if np.isfinite(d)])
    print(f"[route] 宽凳约束几何 {route_km:.1f} km, 可画 {on_km:.1f} / 缺口 {off_km:.1f}")
    print(f"[off-detail] 区域空白(<35%) {band_a:.1f} / 路网稀疏(35-70%) {band_b:.1f} / 邻近小路(≥70%) {band_c:.1f}")
    print(f"[anchor] {len(devs)} 锚点距几何 中位 {np.median(devs):.0f} m, 90分位 {np.percentile(devs,90):.0f} m")

    # ---- 视图：以全部路线的包围盒为准（外边 8km 背景）-----------------
    _all = [P for L in legs for P in L["polys"]] + [G for L in legs for G in L["gaps"]]
    allr = np.vstack(_all) if _all else np.zeros((0, 2))
    rx0, rx1 = allr[:, 0].min(), allr[:, 0].max()
    ry0, ry1 = allr[:, 1].min(), allr[:, 1].max()
    x0, x1 = rx0 - PAD_M, rx1 + PAD_M
    y0, y1 = ry0 - PAD_M, ry1 + PAD_M
    span = x1 - x0
    H = int(round(W * (y1 - y0) / span))
    print(f"[view] W={W} H={H}  {(x1-x0)/1000:.1f} x {(y1-y0)/1000:.1f} km  "
          f"lon[{LON0+x0/MLON:.3f},{LON0+x1/MLON:.3f}] lat[{LAT0+y0/MLAT:.3f},{LAT0+y1/MLAT:.3f}]")

    def to_px(arr):
        return ((arr[:, 0] - x0) / span * W, (y1 - arr[:, 1]) / (y1 - y0) * H)

    # ---- 锚点标记（按 名称+坐标 去重；记录角色 + 经过它的路线编号）-----
    # 标号 = 该路线的全局序号 1..N（N = 实际路线条数）；同一条路线的每个锚点都显示同一个号（路线1 → 1 1 1 1）
    # 颜色 = 该路线所属街道（18 个街道各一色），便于在图上按街道区分同号路线
    STREETS = sorted({L["street"] for L in legs})
    SCIDX = {s: i for i, s in enumerate(STREETS)}
    LEG_SC = {L["gid"]: SCIDX[L["street"]] for L in legs}
    marks: dict[tuple, dict] = {}
    for L in legs:
        for k, a in enumerate(L["anchors"]):
            key = (round(a["x"], 1), round(a["y"], 1), a["name"])
            m = marks.setdefault(key, {"x": a["x"], "y": a["y"], "name": a["name"],
                                       "label": a["label"], "kind": a["kind"],
                                       "n_leg": 0, "terminal": False, "streets": set(),
                                       "nos": set(), "refs": []})
            m["n_leg"] += 1
            m["streets"].add(L["street"])
            m["nos"].add(L["gid"])
            m["refs"].append((L["street"], L["n"], L["gid"]))
            if k == len(L["anchors"]) - 1:
                m["terminal"] = True
            if a["kind"] == "base":
                m["kind"] = "base"
    mark_list = []
    for m in marks.values():
        px, py = to_px(np.array([[m["x"], m["y"]]]))
        nos = sorted(m["nos"])
        refs = sorted(set(m["refs"]), key=lambda t: t[2])
        txt = "/".join(str(n) for n in nos[:3]) + ("…" if len(nos) > 3 else "")
        title = "、".join(f"路线{g}-{s}" for s, n, g in refs[:12]) + ("…" if len(refs) > 12 else "")
        mark_list.append({"x": round(float(px[0]), 1), "y": round(float(py[0]), 1),
                          "name": m["name"], "label": m["label"], "kind": m["kind"],
                          "n_leg": m["n_leg"], "terminal": m["terminal"],
                          "sc": LEG_SC[nos[0]] if len({LEG_SC[g] for g in nos}) == 1 else -1,
                          "nos": nos, "txt": txt, "refs": title,
                          "streets": sorted(m["streets"])})
    print(f"[anchors] 去重后 {len(mark_list)} 个标记点，"
          f"{sum(1 for m in mark_list if len(m['streets']) > 1)} 个被多街道共用，"
          f"标号种类 {len({m['txt'] for m in mark_list})}")

    # ---- 每条腿的锚点（像素坐标 + 角色），供明细表点击后在地图上描点 ----
    # 2026-10-19 用户要求：点击右下角明细表的某条路线 → 把该路线的 起点/途经点/终点
    # 描到地图上，标注形如「41（起点）41（途经点）41（终点）」（号 = 路线全局序号 gid）。
    legs_px = []
    for L in legs:
        pts = []
        for k, a in enumerate(L["anchors"]):
            role = "起点" if k == 0 else ("终点" if k == len(L["anchors"]) - 1 else "途经点")
            px, py = to_px(np.array([[a["x"], a["y"]]]))
            pts.append({"x": round(float(px[0]), 1), "y": round(float(py[0]), 1),
                        "role": role, "kind": a["kind"], "name": a["name"]})
        legs_px.append({"gid": L["gid"], "street": L["street"], "n": L["n"], "pts": pts})

    # ---- 栅格底图（宽凳路网）------------------------------------------
    A = Image.new("RGBA", (W, H), (255, 255, 255, 255))
    dA = ImageDraw.Draw(A)
    draw_net = 0
    for P in net_xy:
        px, py = to_px(P)
        if px.max() < 0 or px.min() > W or py.max() < 0 or py.min() > H:
            continue
        dA.line(list(zip(px.tolist(), py.tolist())), fill=C_GRID + (255,), width=W_GRID, joint="curve")
        draw_net += 1
    print(f"[raster] 画入视窗宽凳 link {draw_net} ({time.time()-t0:.1f}s)")

    R = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dR = ImageDraw.Draw(R)
    for L in legs:
        for P in L["polys"]:
            px, py = to_px(P)
            xy = list(zip(px.tolist(), py.tolist()))
            dR.line(xy, fill=C_CASE + (255,), width=W_CASE, joint="curve")
            dR.line(xy, fill=C_ROUTE + (250,), width=W_ROUTE, joint="curve")
    # 缺口（宽凳无路处）：深灰虚线 —— 只连锚点，明确标注「这里宽凳没路」
    for L in legs:
        for G in L["gaps"]:
            px, py = to_px(G)
            dR.line(list(zip(px.tolist(), py.tolist())), fill=C_GAP + (235,), width=W_GAP,
                    joint="curve")
    comp = Image.alpha_composite(A, R)
    # 锚点圆点 + 路线编号（编号贴在圆点右上方，白描边保证在红线上可读）
    dC = ImageDraw.Draw(comp)
    try:
        from PIL import ImageFont
        FNO = ImageFont.truetype("C:/Windows/Fonts/msyhbd.ttc", 42)
    except Exception:
        FNO = None
    for L in legs:
        for k, a in enumerate(L["anchors"]):
            ax, ay = to_px(np.array([[a["x"], a["y"]]]))
            ax, ay = float(ax[0]), float(ay[0])
            if k == len(L["anchors"]) - 1:
                dC.ellipse([ax - 12, ay - 12, ax + 12, ay + 12], outline=C_END + (255,), width=4)
            if a["kind"] == "base":
                dC.ellipse([ax - 8, ay - 8, ax + 8, ay + 8], fill=C_BASE + (255,), outline=(255, 255, 255, 255), width=3)
            else:
                dC.ellipse([ax - 6, ay - 6, ax + 6, ay + 6], fill=C_VIA + (255,), outline=(255, 255, 255, 255), width=2)
    for m in mark_list:
        if not m["txt"]:
            continue
        if not (0 <= m["x"] <= W and 0 <= m["y"] <= H):
            continue
        col = tuple(int(PALETTE[m["sc"]][i:i + 2], 16) for i in (1, 3, 5)) if m["sc"] >= 0 else (20, 24, 31)
        dC.text((m["x"] + 14, m["y"] - 46), m["txt"], font=FNO, fill=col,
                stroke_width=6, stroke_fill=(255, 255, 255))
    comp.convert("RGB").save(OUT / "route_kuandeng_routes.png", optimize=True)
    print(f"[png] saved ({time.time()-t0:.1f}s)")

    # ---- base64（灰底不含路线，路线走矢量）-----------------------------
    # 灰底是纯线稿（白底 + 灰线），量化成调色板 PNG：
    # 体积更小，而且解码后是 1 字节/像素（27MB）而不是 RGB 的 3 字节（81MB），首屏解码更快。
    # 【坑】不要用 method=Image.MEDIANCUT：在这个尺寸上它会把整张图压成 1 种颜色（已实测，
    # 27M 像素全被判成非白）。FASTOCTREE 在「调色板色数 ≥ 实际色数」时是逐像素无损的。
    rgbA = A.convert("RGB")
    ncol = len(rgbA.getcolors(1 << 20) or []) or 256
    Ap = rgbA.quantize(colors=min(256, max(4, ncol)),
                       method=Image.FASTOCTREE, dither=Image.Dither.NONE)
    _qa = np.asarray(Ap.convert("RGB"), dtype="int16")
    _qb = np.asarray(rgbA, dtype="int16")
    _bad = int((np.abs(_qa - _qb).sum(2) > 0).sum())
    buf = io.BytesIO()
    Ap.save(buf, "PNG", optimize=True)
    a64 = base64.b64encode(buf.getvalue()).decode("ascii")
    print(f"[embed] 灰底 调色板{ncol}色 → {buf.tell()/1e6:.3f}MB, 量化误差像素 {_bad:,} (原 RGB 版 0.31MB)")

    # ---- SVG 路径：Δ + varint + base64 ---------------------------------
    # 注意：**不要**按固定步长重采样。原始折线本来就有 32,111 个点（中位间距 35 m），
    # 按 10 m 重采样会把点数吹到 162,020（5 倍），而重采样点都落在原线段上 ——
    # 画出来的形状一模一样，纯粹是白涨 2.4 MB。所以直接用原始点。
    # 再对坐标做「量化 + 相邻差分 + zigzag varint + base64」，2.4 MB → 约 90 KB。
    PPREC = 10.0           # 量化精度 0.1 画布单位 = 1.27 m；正好落在 toFixed(1) 上，故编解码零误差

    def enc_paths(xy_list, prec=PPREC):
        out: list[int] = []

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
            n = len(qx)
            uv(n)
            sv(int(qx[0])); sv(int(qy[0]))
            for a, b in zip(np.diff(qx).tolist(), np.diff(qy).tolist()):
                sv(int(a)); sv(int(b))
        return base64.b64encode(bytes(out)).decode("ascii")

    # 主路线图层：宽凳约束几何（每条腿可能由多条折线组成，缺口断开）
    route_b64 = enc_paths([P for L in legs for P in L["polys"]])

    # 2026-10-19 用户要求：点击明细行除了描锚点，还要**高亮该路线折线**（否则 43 条
    # 全红的线里认不出是哪条）。按腿分开编码（每条腿一条独立折线），选中时叠加
    # 亮蓝粗线 + 白底，其余路线整体调暗（半透明遮罩由前端 CSS 过渡实现）。
    leg_route_b64 = [enc_paths(L["polys"]) if L["polys"] else "" for L in legs]
    leg_route_idx = {L["gid"]: i for i, L in enumerate(legs)}

    # 缺口图层：宽凳无路处用锚点直连虚线段表示
    gap_b64 = enc_paths([G for L in legs for G in L["gaps"]])

    # 锚点直连虚线：每条腿 起点→途经点→终点
    chain_b64 = enc_paths([np.asarray([(a["x"], a["y"]) for a in L["anchors"]], "f8") for L in legs])
    print(f"[enc] 折线 {sum(len(P) for L in legs for P in L['polys']):,} 点 → RT {len(route_b64)/1024:.0f} KB / "
          f"GAP {len(gap_b64)/1024:.0f} KB / CH {len(chain_b64)/1024:.0f} KB")

    # ---- 宽凳 STOPLINE 真值（ODD 覆盖打点，默认不渲染，勾选才出现）----
    # 数据: data/kuandeng_stoplines.json（真 WGS-84）。图内底图路网与路线为 GCJ02
    # （火星座标，缓存构建时已纠偏），故停止线必须做 WGS84→GCJ02，否则整体偏 ~500m。
    # 分两层：受灯控（信号灯路口，IS_LIGHT=1）/ 不受灯控（含让行线、虚拟停止线）
    def enc_dots(lon_lat_arr, prec=PPREC):
        """独立点集：按 (y,x) 排序后 Δ+zigzag varint+base64，只存量化整数。"""
        if len(lon_lat_arr) == 0:
            return ""
        x, y = to_xy(lon_lat_arr[:, 0], lon_lat_arr[:, 1])
        px, py = to_px(np.column_stack([x, y]))
        q = np.rint(np.column_stack([px, py]) * prec).astype("int64")
        q = q[(q[:, 0] >= 0) & (q[:, 0] <= W * prec) & (q[:, 1] >= 0) & (q[:, 1] <= H * prec)]
        q = q[np.lexsort((q[:, 1], q[:, 0]))]

        out: list[int] = []
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

    sl = json.loads((ROOT / "data" / "kuandeng_stoplines.json").read_text(encoding="utf-8"))
    sl_pts = {"light": [], "dark": []}
    sl_lab = {"light": 0, "dark": 0}
    for e in sl["elements"]:
        t = e.get("tags", {})
        k = "light" if t.get("is_light") == "1" else "dark"
        sl_pts[k].append([e["lon"], e["lat"]])
        sl_lab[k] += 1
    # WGS84 → GCJ02（与图内底图路网/路线同框架）
    for k in ("light", "dark"):
        if sl_pts[k]:
            g = np.asarray(sl_pts[k], "f8")
            glon, glat = wgs2gcj(g[:, 0], g[:, 1])
            sl_pts[k] = np.column_stack([glon, glat])
    # 只加载「宽凳有的」点：必须落在宽凳 ROAD_LINK 路网上（点到路段几何 ≤20 m），
    # 交付覆盖之外/无路处的点一律不加载。
    # 注意不能用「到最近顶点」的距离——长直路段的中间点会离顶点很远而被误剔；
    # 这里先用顶点 KD 树取近邻 link 候选，再算点到这些 link 折线段的精确距离。
    # 顶点→link 映射必须与 all_pts 的构建顺序一致（构建 all_pts 时跳过了顶点数<2 的 link）
    _vk = []
    for _i in range(len(gn)):
        _n = int(gn[_i])
        if _n < 2:
            continue
        _vk.append(np.full(_n, _i, dtype="i8"))
    _vlink = np.concatenate(_vk)
    assert len(_vlink) == len(all_pts), (len(_vlink), len(all_pts))
    _vtree = cKDTree(all_pts)

    def _link_dist(q):
        """q: (N,2) 米坐标 → 到宽凳路网最近路段的距离 (N,)"""
        _, idx = _vtree.query(q, k=8)
        out = np.full(len(q), np.inf)
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
                S = np.asarray(geom[o:o + n])                      # (n,2) 原始 lon/lat
                sx, sy = to_xy(S[:, 0], S[:, 1])
                A = np.column_stack([sx[:-1], sy[:-1]])
                B = np.column_stack([sx[1:], sy[1:]])
                AB = B - A
                L2 = (AB ** 2).sum(1)
                L2[L2 == 0] = 1e-9
                AP = q[i] - A
                t = np.clip((AP * AB).sum(1) / L2, 0, 1)
                C = A + t[:, None] * AB
                d = np.hypot(q[i, 0] - C[:, 0], q[i, 1] - C[:, 1]).min()
                if d < out[i]:
                    out[i] = d
        return out

    sl_off = {"light": 0, "dark": 0}
    for k in ("light", "dark"):
        if len(sl_pts[k]) == 0:
            continue
        g = np.asarray(sl_pts[k], "f8")
        gx, gy = to_xy(g[:, 0], g[:, 1])
        keep = _link_dist(np.column_stack([gx, gy])) <= 30.0
        sl_off[k] = int((~keep).sum())
        sl_pts[k] = g[keep]
    dots_light_b64 = enc_dots(np.asarray(sl_pts["light"], "f8"))
    dots_dark_b64 = enc_dots(np.asarray(sl_pts["dark"], "f8"))
    print(f"[odd] 宽凳停止线 受灯控 {len(sl_pts['light']):,}（剔除 {sl_off['light']} 非宽凳路网）/ "
          f"不受灯控 {len(sl_pts['dark']):,}（剔除 {sl_off['dark']}）→ "
          f"{len(dots_light_b64)/1024:.0f}+{len(dots_dark_b64)/1024:.0f} KB")

    # ---- 宽凳 ODD 沿线图层：环岛 / 公交·非机动车·右转专用道 / 物理隔离 -----
    # 数据源全部是宽凳真值。缓存（GCJ02 框架，与底图一致）直接投影；barriers
    # json 是 WGS84，需 wgs2gcj。全部默认不渲染、勾选才出现。
    def _polys_gcj(idx, off_arr, n_arr, garr):
        """按行号取折线（缓存已是 GCJ02）→ [(px,py)...]"""
        out = []
        for i in idx:
            o, n = int(off_arr[i]), int(n_arr[i])
            if n < 2:
                continue
            S = np.asarray(garr[o:o + n])
            x, y = to_xy(S[:, 0], S[:, 1])
            out.append(np.column_stack([x, y]))
        return out

    # 环岛：ROAD_LINK.LINK_TYPE==4
    rb_idx = np.where(LINK_TYPE == 4)[0]
    rb_polys = _polys_gcj(rb_idx, goff, gn, geom)

    # 特殊车道：LANE.LANE_TYPE ∈ {9 公交专用, 12 非机动车, 13 右转专用}
    lane_sets = {}
    for lt_code, lt_name in ((9, "bus"), (12, "bike"), (13, "right")):
        idx = np.where(LANE_TYPE == lt_code)[0]
        lane_sets[lt_name] = _polys_gcj(idx, lane_goff, lane_gn, lane_geom)

    # 视窗过滤：只保留与视窗（外扩 2km）相交的折线，避免把全惠州市域
    # （护栏/路缘石 24 万段）全部编码进 HTML。
    def _clip_view(polys, pad=2000.0):
        vx0, vx1, vy0, vy1 = x0 - pad, x1 + pad, y0 - pad, y1 + pad
        out = []
        for P in polys:
            if P[:, 0].max() < vx0 or P[:, 0].min() > vx1 or \
               P[:, 1].max() < vy0 or P[:, 1].min() > vy1:
                continue
            out.append(P)
        return out

    # RDP 抽稀：折线在 0.6px 容差内视觉无差，但能大幅压缩点数（护栏层 24 万段）。
    def _rdp(P, tol_px=0.6):
        if len(P) < 3:
            return P
        # 米制容差：视窗 span 米 ↔ W 像素
        tol_m = tol_px * span / W
        keep = np.zeros(len(P), bool)
        keep[0] = keep[-1] = True
        stack = [(0, len(P) - 1)]
        while stack:
            i, j = stack.pop()
            if j - i < 2:
                continue
            A_, B_ = P[i], P[j]
            AB = B_ - A_
            L2 = (AB * AB).sum()
            seg = P[i + 1:j]
            if L2 == 0:
                d = np.hypot(*(seg - A_).T)
            else:
                t = np.clip((seg - A_) @ AB / L2, 0, 1)
                proj = A_[None, :] + t[:, None] * AB[None, :]
                d = np.hypot(*(seg - proj).T)
            k = int(np.argmax(d))
            if d[k] > tol_m:
                keep[i + 1 + k] = True
                stack.append((i, i + 1 + k))
                stack.append((i + 1 + k, j))
        return P[keep]

    rb_polys = [_rdp(P) for P in _clip_view(rb_polys)]
    lane_sets = {k: [_rdp(P) for P in _clip_view(v)] for k, v in lane_sets.items()}

    # 物理隔离：data/kuandeng_barriers.json（WGS84 → GCJ02），线型分两档：
    #   guard = 护栏族(10/12/13/16/17)  curb = 路缘石/墙体(9/11)
    bar_groups = {"guard": [], "curb": []}
    bar_cnt = {"guard": 0, "curb": 0}
    if (ROOT / "data" / "kuandeng_barriers.json").exists():
        bar = json.loads((ROOT / "data" / "kuandeng_barriers.json").read_text(encoding="utf-8"))
        _pts_guard, _pts_curb = [], []
        for e in bar["elements"]:
            P = np.asarray(e["pts"], "f8")
            glon, glat = wgs2gcj(P[:, 0], P[:, 1])
            bar_cnt["curb" if e["line_type"] in (9, 11) else "guard"] += 1
            ( _pts_curb if e["line_type"] in (9, 11) else _pts_guard).append(
                np.column_stack(to_xy(glon, glat)))
        bar_groups = {"guard": [_rdp(P) for P in _clip_view(_pts_guard)],
                      "curb": [_rdp(P) for P in _clip_view(_pts_curb)]}
        bar_cnt = {"guard": len(bar_groups["guard"]), "curb": len(bar_groups["curb"])}

    # 补充 ODD 元素：data/kuandeng_extra.json（WGS84 → GCJ02）
    #   inner_road = 内部道路（ROAD_LINK.OWNER_SHIP=2，园区/小区）
    #   double_solid = 双实线（DIVIDER_ATTR.LINE_TYPE=4，禁变道）
    extra_groups = {"inner": [], "dbl": []}
    if (ROOT / "data" / "kuandeng_extra.json").exists():
        ex = json.loads((ROOT / "data" / "kuandeng_extra.json").read_text(encoding="utf-8"))
        _pts_in, _pts_db = [], []
        for e in ex["elements"]:
            P = np.asarray(e["pts"], "f8")
            glon, glat = wgs2gcj(P[:, 0], P[:, 1])
            (_pts_in if e["kind"] == "inner_road" else _pts_db).append(
                np.column_stack(to_xy(glon, glat)))
        extra_groups = {"inner": [_rdp(P) for P in _clip_view(_pts_in)],
                        "dbl": [_rdp(P) for P in _clip_view(_pts_db)]}
    ex_b64 = {k: enc_paths(v) for k, v in extra_groups.items()}
    print(f"[odd3] 内部道路 {len(extra_groups['inner'])} · 双实线 {len(extra_groups['dbl'])} → "
          f"EX {sum(len(v) for v in ex_b64.values())/1024:.0f} KB")

    # ---- 高德 POI 补充层（13 类，GCJ02 直投——与图内底图同框架）------------
    # 只显示「宽凳路网 200m 内」的点（与 ODD 清单「沿线元素」口径一致：POI
    # 采的是全市域，画布只有 60×44km，且排班作业关心的是路网沿线设施）。
    AMAP_LAYERS = [
        # (key, 文件, 中文名, 色hex, 半径=屏幕像素基准，rescale 按 1/s 恒定)
        ("sch",  "amap_schools",        "学校",      "#1e6fd9", 1.8),
        ("hosp", "amap_hospitals",      "医院",      "#d92b2b", 1.8),
        ("park", "amap_parking",        "停车场",    "#0d9488", 1.6),
        ("chg",  "amap_charging",       "充电站",    "#15950f", 1.6),
        ("fuel", "amap_fuel",           "加油站",    "#c96a10", 1.6),
        ("mkt",  "amap_markets",        "商圈",      "#b029b0", 1.6),
        ("bus",  "amap_bus_stops",      "公交站",    "#5b6b7f", 1.4),
        ("fire", "amap_fire_stations",  "消防站",    "#e03030", 1.6),
        ("pol",  "amap_police_stations","警务点",    "#3b8a55", 1.6),
        ("toll", "amap_tolls",          "收费站",    "#8a6d1f", 1.6),
        ("ic",   "amap_interchanges",   "立交桥",    "#9a4a9e", 1.8),
        ("ramp", "amap_ramps",          "高速出入口","#4a4ab8", 1.6),
        ("svca", "amap_service_areas",  "服务区",    "#8a5a2b", 1.6),
    ]
    amap_dots = {}   # key -> b64
    amap_cnt = {}    # key -> (显示数, 原始数)
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
    print(f"[amap] " + " · ".join(
        f"{k} {amap_cnt[k][0]}/{amap_cnt[k][1]}" for k, *_ in AMAP_LAYERS) +
        f" → {sum(len(v) for v in amap_dots.values())/1024:.0f} KB")

    # ---- OSM 补充元素层（无宽凳/高德替代的 gap 类，WGS84 → GCJ02）----------
    # 信号灯/环岛/消防/警务已换宽凳/高德真值源，不再用 OSM 版重复上图。
    # 桥梁/隧道/公交场站是 way（取 center）；人行横道/铁路道口是 node。
    OSM_LAYERS = [
        # (key, 文件, 中文名, 色hex, 半径=屏幕像素基准)
        ("bridge", "gap_bridges__full",     "桥梁",     "#7a4a9e", 1.6),
        ("tunnel", "gap_tunnels__full",     "隧道",     "#333f50", 1.8),
        ("cross",  "gap_crossings__full",   "人行横道", "#c2571c", 1.4),
        ("railx",  "gap_railCrossings__full","铁路道口","#a11212", 1.8),
        ("depot",  "gap_busDepots__full",   "公交场站", "#0e7c8c", 1.8),
    ]
    osm_dots, osm_cnt = {}, {}
    for key, fn, _lab, _col, _r in OSM_LAYERS:
        fp = ROOT / "data" / (fn + ".json")
        if not fp.exists():
            osm_dots[key], osm_cnt[key] = "", (0, 0)
            continue
        d = json.loads(fp.read_text(encoding="utf-8"))
        pts = []
        for e in d.get("elements", []):
            if e.get("type") == "node":
                pts.append([float(e["lon"]), float(e["lat"])])
            elif "center" in e:
                pts.append([float(e["center"]["lon"]), float(e["center"]["lat"])])
        raw_n = len(pts)
        if pts:
            g = np.asarray(pts, "f8")
            glon, glat = wgs2gcj(g[:, 0], g[:, 1])
            g_gcj = np.column_stack([glon, glat])
            gx, gy = to_xy(glon, glat)
            keep = _link_dist(np.column_stack([gx, gy])) <= 100.0
            osm_dots[key] = enc_dots(g_gcj[keep])
            osm_cnt[key] = (int(keep.sum()), raw_n)
        else:
            osm_dots[key], osm_cnt[key] = "", (0, raw_n)
    print(f"[osm] " + " · ".join(
        f"{k} {osm_cnt[k][0]}/{osm_cnt[k][1]}" for k, *_ in OSM_LAYERS) +
        f" → {sum(len(v) for v in osm_dots.values())/1024:.0f} KB")
    AMAP_LAYERS_JS = [{"key": k, "label": lab, "color": col, "r": r,
                       "b64": amap_dots[k], "n": amap_cnt[k][0], "raw": amap_cnt[k][1]}
                      for k, _f, lab, col, r in AMAP_LAYERS]
    OSM_LAYERS_JS = [{"key": k, "label": lab, "color": col, "r": r,
                      "b64": osm_dots[k], "n": osm_cnt[k][0], "raw": osm_cnt[k][1]}
                     for k, _f, lab, col, r in OSM_LAYERS]
    rb_b64 = enc_paths(rb_polys)
    ln_b64 = {k: enc_paths(v) for k, v in lane_sets.items()}
    bar_b64 = {k: enc_paths(v) for k, v in bar_groups.items()}
    print(f"[odd2] 环岛 {len(rb_polys)} · 公交道 {len(lane_sets['bus'])} · 非机动车道 {len(lane_sets['bike'])} · "
          f"右转专用道 {len(lane_sets['right'])} · 护栏族 {bar_cnt['guard']} · 路缘石/墙体 {bar_cnt['curb']} → "
          f"RB {len(rb_b64)/1024:.0f} / LN {sum(len(v) for v in ln_b64.values())/1024:.0f} / "
          f"BAR {sum(len(v) for v in bar_b64.values())/1024:.0f} KB")


    # ---- 途经点防合并：分段导航链接（P_i → P_i+1，端点不会被高德顺路合并）----
    # 2026-10-26 用户要求：高德阶段途经点必须逐一经过，不能删减/合并（少过一站就漏测该点元素）。
    # uri_fwd/via 交给高德后，App 端可能顺路合并展示，无法保证逐点停靠 →
    # 每条腿补 hop_uris：相邻锚点逐段导航链接，逐段执行即保证每个途经点都被经过。
    def _hop_uris(anchors):
        # 高德分段导航（端点不会被合并，逐段执行保证每个途经点停靠）
        out = []
        ts = "1793006744000"
        for i in range(len(anchors) - 1):
            a, b = anchors[i], anchors[i + 1]
            qs = ["type=car", "policy=1",
                  f"from%5Blnglat%5D={a['gcj'][0]:.6f},{a['gcj'][1]:.6f}",
                  f"from%5Bname%5D={quote(a['name'] or a['label'] or '')}",
                  f"from%5Bid%5D={ts}-from",
                  f"to%5Blnglat%5D={b['gcj'][0]:.6f},{b['gcj'][1]:.6f}",
                  f"to%5Bname%5D={quote(b['name'] or b['label'] or '')}",
                  f"to%5Bid%5D={ts}-to",
                  "src=huicheng-odd", "callnative=0", "innersrc=uriapi"]
            out.append("https://ditu.amap.com/dir?" + "&".join(qs))
        return out

    for L in legs:
        L["hop_uris"] = _hop_uris(L["anchors"])
    n_hops = sum(len(L["hop_uris"]) for L in legs)
    # 护栏：每条腿的 hop 段数 = 锚点数-1（同一锚点链，无删减）
    for L in legs:
        assert len(L["hop_uris"]) == len(L["anchors"]) - 1, \
            f"hop段数与锚点链不符 {L['street']} 路线{L['n']}"
    print(f"[hops] 逐途经点分段导航（腾讯）{n_hops} 段（{len(legs)} 腿）")

    # ---- 侧栏：按街道汇总 ---------------------------------------------
    by_street = {}
    for L in legs:
        s = by_street.setdefault(L["street"], {"km": 0.0, "on": 0.0, "off": 0.0,
                                               "a": 0.0, "b": 0.0, "c": 0.0, "legs": []})
        s["km"] += L["km"]; s["on"] += L["on_km"]; s["off"] += L["off_km"]
        s["a"] += L["band_a"]; s["b"] += L["band_b"]; s["c"] += L["band_c"]
        s["legs"].append({"n": L["n"], "gid": L["gid"], "km": L["km"], "min": L["min"],
                          "anchors": L["anchors"], "chain": L["chain"],
                          "on": round(L["on_km"], 1), "off": round(L["off_km"], 1),
                          "a": round(L["band_a"], 1), "b": round(L["band_b"], 1),
                          "c": round(L["band_c"], 1),
                          "dev": [round(d) if np.isfinite(d) else None for d in L["anchor_dev"]],
                          "uri": L["uri"], "uri_fwd": L["uri_fwd"], "uri_rev": L["uri_rev"],
                          "hop_uris": L["hop_uris"]})

    stats = {
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "legs": len(legs), "streets": len(by_street),
        "route_km": round(route_km, 1),
        "route_km_declared": round(sum(L["km"] for L in legs), 1),
        "route_km_amap": round(sum(L["km_amap"] for L in legs), 1),
        "anchors": int(len(devs)),
        "anchor_marks": len(mark_list),
        "anchor_dev_median_m": round(float(np.median(devs)), 1),
        "anchor_dev_p90_m": round(float(np.percentile(devs, 90)), 1),
        "anchor_dev_max_m": round(float(devs.max()), 1),
        "kuandeng_on_km": round(on_km, 1),
        "kuandeng_off_km": round(off_km, 1),
        "off_band_a": round(band_a, 1),
        "off_band_b": round(band_b, 1),
        "off_band_c": round(band_c, 1),
        "kuandeng_km": round(float(LEN.sum() / 1000.0), 1),
        "seg_on": KD["seg_on"], "seg_near": KD["seg_near"], "seg_off": KD["seg_off"],
        "ok_legs": KD["ok_legs"], "n_legs": len(legs),
        "km_onKd": KD["km_onKd"], "km_nearKd": KD["km_nearKd"],
        "gap_segs": sum(L["n_gap"] for L in legs),
    }
    data = {"stats": stats, "by_street": by_street, "W": W, "H": H,
            "route_b64": route_b64, "gap_b64": gap_b64, "chain_b64": chain_b64,
            "prec": PPREC, "marks": mark_list, "legs_px": legs_px,
            "leg_route_b64": leg_route_b64, "leg_route_idx": leg_route_idx,
            "dots_light_b64": dots_light_b64, "dots_dark_b64": dots_dark_b64,
            "rb_b64": rb_b64, "ln_bus_b64": ln_b64["bus"], "ln_bike_b64": ln_b64["bike"],
            "ln_right_b64": ln_b64["right"],
            "bar_guard_b64": bar_b64["guard"], "bar_curb_b64": bar_b64["curb"],
            "ex_inner_b64": ex_b64["inner"], "ex_dbl_b64": ex_b64["dbl"],
            "n_light": len(sl_pts["light"]), "n_dark": len(sl_pts["dark"]),
            "pal": PALETTE, "streets_order": STREETS, "scidx": SCIDX,
            "amap_layers": AMAP_LAYERS_JS, "osm_layers": OSM_LAYERS_JS}
    (OUT / "route_kuandeng_routes.json").write_text(
        json.dumps({"stats": stats, "by_street": by_street}, ensure_ascii=False, indent=2), encoding="utf-8")
    _write_html(OUT / "route_kuandeng_routes.html", data, a64)
    print(f"[done] html {(OUT/'route_kuandeng_routes.html').stat().st_size/1e6:.2f}MB  ({time.time()-t0:.1f}s)")


def _write_html(path: Path, data, a64):
    st = data["stats"]
    cards = [
        (f'{st["legs"]} 条排班路线',
         f'{st["route_km_amap"]:,.1f}', "km",
         f'去程（导航里程，单向）· 其中 {st["route_km"]:,.1f} km 可画在宽凳上 · {st["streets"]} 个镇街'),
        ("路线锚点", f'{st["anchors"]:,}', "个", f'去重后 {st["anchor_marks"]} 个点位 · 起点/途经点/终点'),
        ("锚点距路线偏差", f'{st["anchor_dev_median_m"]:.0f}', "m", f'中位 · 90分位 {st["anchor_dev_p90_m"]:.0f} m · 最大 {st["anchor_dev_max_m"]:.0f} m'),
        ("宽凳路网（全市）", f'{st["kuandeng_km"]:,.1f}', "km", "灰底 · 交付的全部 ROAD_LINK"),
        ("落在宽凳上", f'{st["seg_on"] + st["seg_near"]}<span class="u">/ {st["seg_on"] + st["seg_near"] + st["seg_off"]} 段</span>',
         "", f'{st["km_onKd"] + st["km_nearKd"]:,.1f} km · 顶点 0 偏差贴在宽凳上'),
        ("宽凳缺的路段", f'{st["kuandeng_off_km"]:,.1f}', "km",
         f'{st["gap_segs"]} 段 · 区域空白 {st["off_band_a"]:.0f} · 路网稀疏 {st["off_band_b"]:.0f} · 邻近小路 {st["off_band_c"]:.0f}'),
        ("ODD·宽凳停止线", f'{data["n_light"] + data["n_dark"]:,}', "条",
         f'红绿灯路口 {data["n_light"]:,} · 让行/停止线 {data["n_dark"]:,} · 仅宽凳路网上的点 · 勾选才显示'),
    ]
    card_html = "".join(
        f'<div class="card"><div class="k">{k}</div><div class="v">{v}<span class="u">{u}</span></div><div class="s">{s}</div></div>'
        for k, v, u, s in cards)

    order = sorted(data["by_street"].items(), key=lambda kv: -kv[1]["km"])
    rows_html = []
    for name, s in order:
        trs = ""
        for L in s["legs"]:
            # 2026-10-26 用户要求：途经点可跨平台搜索 —— 名称补「(经度,纬度)」
            names = " → ".join(
                f'<span class="an {a["kind"]}"><b>{a["name"] or a["label"]}</b>({a["gcj"][0]:.6f},{a["gcj"][1]:.6f})</span>'
                for a in L["anchors"])
            if L["off"] <= 1.0:
                chip = '<span class="chip ok">宽凳全覆盖</span>'
            elif L["a"] >= L["b"] and L["a"] >= L["c"]:
                chip = f'<span class="chip bad">区域空白 {L["a"]:.0f}</span>'
            elif L["b"] >= L["c"]:
                chip = f'<span class="chip mid">路网稀疏 {L["b"]:.0f}</span>'
            else:
                chip = f'<span class="chip low">邻近小路 {L["c"]:.0f}</span>'
            col = data["pal"][data["scidx"][name]]
            trs += (f'<tr class="lrow" data-gid="{L["gid"]}" title="点击在地图上描出本路线 起点/途经点/终点">'
                    f'<td class="rn"><span class="gid" style="background:{col}">{L["gid"]}</span>'
                    f'<span class="ln" style="color:{col}">路线{L["gid"]}-{name}</span></td>'
                    f'<td class="an-list">{names}</td>'
                    f'<td class="num">{L["km"]}km</td><td class="num">≈{L["min"]}min</td>'
                    f'<td class="num ok">{L["on"]:.0f}</td>'
                    f'<td class="slot"><a href="{L["uri_fwd"]}" target="_blank" onclick="event.stopPropagation()" title="去程：起点→途经点→终点">去程 ↗</a>'
                    f' <a href="{L["uri_rev"]}" target="_blank" onclick="event.stopPropagation()" title="返程：终点→途经点倒序→起点">返程 ↗</a>'
                    f' <span class="hop-toggle" data-gid="{L["gid"]}" onclick="event.stopPropagation();this.nextElementSibling.classList.toggle(\'open\')"'
                    f' title="逐途经点分段导航（{len(L["anchors"]) - 1} 段，每段起/终点都是锚点，不会被合并 —— 测试执行用这个）">逐段▾</span></td>'
                    f'<tr class="hoprow" data-gid="{L["gid"]}"><td></td><td colspan="5" class="hoplist">'
                    + " · ".join(
                        f'<a href="{u}" target="_blank" onclick="event.stopPropagation()" '
                        f'title="{L["anchors"][i]["name"] or L["anchors"][i]["label"]} → {L["anchors"][i + 1]["name"] or L["anchors"][i + 1]["label"]}">'
                        f'{i + 1}.{L["anchors"][i]["name"] or L["anchors"][i]["label"]}→{L["anchors"][i + 1]["name"] or L["anchors"][i + 1]["label"]} ↗</a>'
                        for i, u in enumerate(L["hop_uris"]))
                    + '</td></tr>')
        # 点击导航链接不要触发行选中
        warn = " warn" if s["off"] > 10 else ""
        col = data["pal"][data["scidx"][name]]
        rows_html.append(
            f'<details><summary><i class="sc" style="background:{col}"></i><b>{name}</b>'
            f'<span class="lk">{len(s["legs"])} 条 · {s["km"]:.1f} km</span>'
            f'<span class="cov">宽凳可画 {s["on"]:.0f} km</span>'
            f'<span class="off{warn}">宽凳缺口 {s["off"]:.0f} km</span></summary>'
            f'<table class="rt"><colgroup><col style="width:58px"><col><col style="width:52px">'
            f'<col style="width:54px"><col style="width:56px"><col class="c-nav"></colgroup>'
            f'<tr><th>路线</th><th>起点 → 途经点 → 终点</th><th>里程</th><th>时长</th>'
            f'<th title="该路线几何只用宽凳 link 的里程">宽凳可画</th><th>导航</th></tr>{trs}</table></details>')
    streets_html = "".join(rows_html)

    tpl = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>惠城区 · __NLEGS__ 条排班路线 × 宽凳路网</title>
<style>
:root{--bg:#f5f6f8;--fg:#1f2329;--mut:#6b7280;--line:#e3e6eb;--card:#fff;--red:#de1c08;--grey:#7a8494;--green:#10824a;--amber:#e8940c;--dark:#781414}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif}
header{padding:18px 26px 12px}h1{margin:0;font-size:20px}
.sub{font-size:12.5px;margin-top:6px;line-height:2}
.sub2{color:var(--mut);font-size:11.5px;margin-top:7px;max-width:1180px;line-height:1.9}
.pill{display:inline-flex;align-items:center;margin:2px 6px 2px 0;padding:1px 8px;border:1px solid;border-radius:999px;font-size:11.5px;background:#fff;white-space:nowrap}
.pill i{display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:5px}
.pill.dot i{width:10px;height:10px;border-radius:50%}
.cards{display:grid;grid-template-columns:repeat(7,1fr);gap:10px;padding:0 26px 14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card .k{font-size:12px;color:var(--mut)}.card .v{font-size:23px;font-weight:700;margin-top:2px}
.card .v .u{font-size:12px;font-weight:400;color:var(--mut);margin-left:3px}.card .s{font-size:11.5px;color:var(--mut);margin-top:2px}
.wrap{display:grid;grid-template-columns:minmax(430px,62%) 6px minmax(420px,1fr);gap:0;padding:0 26px 26px}
/* 2026-10-26 可拖拽分栏：拖动中间分隔条调地图/明细占比，宽度存 localStorage */
#splitter{cursor:col-resize;background:var(--line);border-radius:3px;margin:0 4px;position:relative}
#splitter:hover,#splitter.drag{background:#1a66b3}
#splitter::after{content:'⇔';position:absolute;left:50%;top:12%;transform:translateX(-50%);color:#9aa3af;font-size:11px}
#mapbox{position:relative;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden;height:88vh}
#stage{position:absolute;left:0;top:0;transform-origin:0 0}
#stage img,#stage svg{position:absolute;left:0;top:0;width:100%;height:100%}
#stage svg{pointer-events:none}
#stage{--sw:11;--swc:24.5;--sda:45;--sdb:32;--smk:5.8;--sf:87;--sh:17.4;--sg:20;--sg2:14;--slk:3.0;--slk2:1.7;--olk:2.2;--olk2:1.5;--shl:7.5;--shlc:13}
#grt path{stroke-width:calc(var(--sw) * 1px)}
#gsl1 path{stroke-width:calc(var(--slk) * 1px)}
#gsl2 path{stroke-width:calc(var(--slk2) * 1px)}
#grb path,#gln2 path,#gln3 path{stroke-width:calc(var(--olk) * 1px)}
#gbn4 path,#gbn5 path,#gex6 path,#gex7 path{stroke-width:calc(var(--olk2) * 1px)}
#grt path.cs{stroke-width:calc(var(--swc) * 1px)}
#gap path{stroke-width:calc(var(--sg) * 1px);stroke-dasharray:calc(var(--sg2) * 1px) calc(var(--sg2) * 1.2px)}
#gch path{stroke-width:calc(var(--sw) * 1px);stroke-dasharray:calc(var(--sda) * 1px) calc(var(--sdb) * 1px)}
#gmk circle{stroke-width:calc(var(--smk) * 1px)}
/* 选中某条路线时：其余红线路线整体调暗（半透明），高亮线(#ghl)保持鲜亮 */
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
.pill b.nb{display:inline-block;min-width:13px;padding:0 3px;margin-right:4px;border-radius:4px;
 background:#14181f;color:#fff;font-size:10.5px;font-weight:700;line-height:14px;text-align:center}
.ctrls{position:absolute;right:12px;top:12px;background:rgba(255,255,255,.95);border:1px solid var(--line);border-radius:8px;padding:8px 11px;font-size:12.5px;z-index:5}
.ctrls label{display:block;cursor:pointer;user-select:none;white-space:nowrap}
.ctrls button{margin-top:6px;width:100%;font:12px inherit;padding:3px 0;border:1px solid var(--line);background:#fff;border-radius:6px;cursor:pointer}
aside{background:#fff;border:1px solid var(--line);border-radius:10px;overflow:auto;height:82vh;padding:12px 14px}
aside h2{font-size:15px;margin:2px 0 4px}aside .hint{font-size:11.5px;color:var(--mut);margin-bottom:10px}
details{border-bottom:1px solid var(--line);padding:8px 0}details summary{cursor:pointer;list-style:none}
details summary::-webkit-details-marker{display:none}
details summary b{font-size:13.5px}.lk{color:var(--mut);font-size:11.5px;margin-left:8px}
span.cov{font-size:11.5px;color:#10824a;font-weight:600;margin-left:8px}
span.off{font-size:11.5px;color:var(--mut);font-weight:600;margin-left:8px}
span.off.warn{color:#c2410c}
table.rt{width:100%;border-collapse:collapse;margin-top:8px;font-size:11.5px;table-layout:fixed}
col.c-nav{width:112px}
table.rt th{background:#f0f2f5;font-weight:600;text-align:left;padding:4px 5px;white-space:nowrap}
table.rt td{border-top:1px solid var(--line);padding:5px;vertical-align:top}
td.rn{white-space:nowrap}
td.rn .gid{display:inline-block;min-width:17px;padding:0 4px;border-radius:4px;color:#fff;
 font-size:10.5px;font-weight:700;line-height:15px;text-align:center;margin-right:5px}
td.rn .ln{font-size:11px;font-weight:600}
td.num{text-align:right;white-space:nowrap}
td.num.ok{color:#10824a}td.num.warn{color:#c2410c;font-weight:600}
td.an-list{line-height:1.9;overflow-wrap:anywhere}td.slot{white-space:normal;min-width:104px}td.slot a{white-space:nowrap}
.hop-toggle{display:inline-block;color:#1a66b3;cursor:pointer;margin:1px 0 1px 4px;white-space:nowrap}
tr.hoprow{display:none}tr.hoprow.open{display:table-row}
tr.hoprow td.hoplist{background:#f8f9fb;padding:4px 10px;line-height:2}
tr.hoprow td.hoplist a{display:inline-block;margin:1px 6px 1px 0;font-size:12px;color:#1a66b3}
span.an{display:inline-block;padding:0 5px;margin:1px 2px 1px 0;border-radius:4px;background:#f3f4f6;border:1px solid #e5e7eb;font-size:11px;white-space:normal;overflow-wrap:anywhere;line-height:1.55}
span.an b{white-space:nowrap}
span.an.base{background:#e6f4ec;border-color:#b6dfc6;color:#0b5c35;font-weight:600}
span.chip{display:inline-block;padding:1px 6px;border-radius:999px;font-size:10.5px;font-weight:600;white-space:nowrap;border:1px solid}
span.chip.ok{background:#e9f6ef;border-color:#b9dfc9;color:#0b5c35}
span.chip.low{background:#fff8e6;border-color:#f0dfae;color:#8a6100}
span.chip.mid{background:#fdefe3;border-color:#f3d2b1;color:#9a4a06}
span.chip.bad{background:#fdeaea;border-color:#f5c2c2;color:#a11212}
i.sc{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:7px;vertical-align:-1px}
a{color:#1557db;text-decoration:none}a:hover{text-decoration:underline}
tr.lrow{cursor:pointer}tr.lrow:hover{background:#fff8e6}
tr.lrow.sel{background:#fdeeea;outline:1px solid #f0b9a6;outline-offset:-1px}
aside .hint .tip{display:block;margin-top:6px;color:#9a4a06}
</style></head><body>
<header><h1>惠城区 · __NLEGS__ 条排班路线 × 宽凳路网</h1>
 <div class="sub"><b>怎么读这张图：</b>
 <span class="pill" style="border-color:#7a8494"><i style="background:#7a8494"></i>灰 = 宽凳路网（交付的全部 ROAD_LINK）</span>
 <span class="pill" style="border-color:#de1c08"><i style="background:#de1c08"></i>红 = __NLEGS__ 条排班路线（几何只用宽凳 link）</span>
 <span class="pill" style="border-color:#6c7688"><i style="background:#6c7688"></i>灰虚线 = 宽凳没采到的缺口</span>
 <span class="pill dot" style="border-color:#10824a"><i style="background:#10824a"></i>绿点 = 出发</span>
 <span class="pill dot" style="border-color:#e8940c"><i style="background:#e8940c"></i>橙点 = 途经点</span>
 <span class="pill dot" style="border-color:#781414"><i style="background:#fff;border:2px solid #781414;width:6px;height:6px"></i>深红圈 = 终点</span>
 <span class="pill" style="border-color:#14181f"><b class="nb">1</b>锚点号 = 该路线的全局路线号（1–__NLEGS__）；路线1 的每个锚点都标 1</span>
 <span class="pill" style="border-color:#3c4250"><i style="background:#3c4250"></i>虚线 = 锚点直连</span></div>
<div class="sub2">口径：__NLEGS__ 条街道路线（__NSTREETS__ 镇街）按「起点 → 途经点 → 终点」锚点链生成。<b>几何已按宽凳路网约束重算</b> ——
每条腿仍走原来的锚点，但相邻锚点之间的路径只能在宽凳 ROAD_LINK 上走，因此红色折线<b>每一个顶点都落在宽凳路网上（0 偏差）</b>，
与灰色路网完全重合。<b>去程 __ROUTEKMAMAP__ km</b>（= __NLEGS__ 条路线的<b>单向</b>导航里程之和，初算用高德 API；今日起导航链接已全部换腾讯地图）——
其中 <b>__ROUTEKM__ km 能画在宽凳路网上</b>（图中红色折线，顶点 0 偏差），锚点 __NANCH__ 个。<br>
　　（排班总账的「空间层」= <b>去程 + 返程</b>：返程由锚点链倒序后<b>另行算路</b>（同策略），不按去程 ×2 估算；
　　「红折线长度」按宽凳路网节点实测，与导航 API 返回的「去程里程」量法不同、天然有小差。）<br>
实测每个锚点到红色折线的距离中位仅 <b>__DEVMED__ m</b>（90 分位 __DEVP90__ m），说明红色折线仍是这条锚点链在路网上的真实走向。<br>
<b>关于灰色虚线段：</b>这是<b>宽凳确实没有采集道路</b>的地方 —— 走廊放宽到 2 km 仍无法在宽凳上连通，因此不画任何几何，只连锚点示意。
共 __OFFKM__ km / __GAPSEG__ 段，其中 __A__ km 落在宽凳完全空白的片区（沿途有路率 &lt;35%）、__B__ km 落在路网稀疏区（35–70%）、
__C__ km 是旁边有宽凳路但这条乡道没采（≥70%）。这些段需要<span style="color:#c2410c;font-weight:600">补测或改服务点</span>，
清单见 <code>out/kd_survey_needs.md</code>。<br>
生成 __GEN__</div></header>
<div class="cards">__CARDS__</div>
<div class="wrap">
 <div id="mapbox">
  <div class="ctrls">
   <label><input type="checkbox" id="l0" checked> 宽凳路网（灰底）</label>
   <label><input type="checkbox" id="l1" checked> __NLEGS__ 条排班路线（红）</label>
   <!-- 2026-10-17 按用户要求移除：锚点 / 锚点标号 / 锚点直连 / 只看排班路线 / 宽凳缺口 5 个勾选 -->
   <label style="border-top:1px solid var(--line);margin-top:4px;padding-top:4px"><input type="checkbox" id="sl1"> ODD·红绿灯路口（宽凳灯控停止线真值）</label>
   <label><input type="checkbox" id="sl2"> ODD·停止/让行线（宽凳真值）</label>
   <label style="border-top:1px solid var(--line);margin-top:4px;padding-top:4px"><input type="checkbox" id="o1"> ODD·环岛（宽凳 LINK_TYPE=4）</label>
   <label><input type="checkbox" id="o2"> ODD·公交专用道（宽凳 LANE）</label>
   <label><input type="checkbox" id="o3"> ODD·非机动车道（宽凳 LANE）</label>
   <label><input type="checkbox" id="o4"> ODD·护栏/隔离（宽凳 DIVIDER）</label>
   <label><input type="checkbox" id="o5"> ODD·路缘石/墙体（宽凳 DIVIDER）</label>
   <label><input type="checkbox" id="o6"> ODD·内部道路（宽凳 OWNER_SHIP=2）</label>
   <label><input type="checkbox" id="o7"> ODD·双实线/禁变道（宽凳 LINE_TYPE=4）</label>
   <label style="border-top:1px solid var(--line);margin-top:4px;padding-top:4px"><input type="checkbox" id="ax"> 高德POI·全部</label>
__AMAP_CTRLS__
   <label style="border-top:1px solid var(--line);margin-top:4px;padding-top:4px"><input type="checkbox" id="ox"> OSM·补充元素全部（桥梁/隧道/道口…）</label>
__OSM_CTRLS__
   <button id="fit">复位</button>
  </div>
  <div class="legend">
   <div><i style="background:#7a8494"></i>宽凳路网（全部）</div>
   <div><i style="background:#de1c08"></i>__NLEGS__ 条排班路线（只用宽凳 link）</div>
   <div><i style="background:#6c7688"></i>宽凳没采到的缺口</div>
   <div><i class="d" style="background:#10824a"></i>出发 <i class="d" style="background:#e8940c;margin-left:8px"></i>途经点 <i class="d" style="background:#fff;border:2px solid #781414;width:6px;height:6px"></i> 终点</div>
   <div><b class="nbdemo">1</b> 锚点号（= 全局路线号 1–__NLEGS__，同一路线同号）</div>
   <div><i style="background:#3c4250"></i>锚点直连（开关）</div>
   <div><i class="d" style="background:#1557db"></i>ODD·红绿灯路口 <i class="d" style="background:#9a6b00;margin-left:8px"></i> 停止/让行线（宽凳 STOPLINE 真值，勾选才显示）</div>
   <div style="margin-top:4px"><i style="background:#b8329e"></i>环岛 <i style="background:#0e7c8c;margin-left:6px"></i>公交专用道 <i style="background:#4a7d1f;margin-left:6px"></i>非机动车道 <i style="background:#c2571c;margin-left:6px"></i>护栏 <i style="background:#7a4a9e;margin-left:6px"></i>路缘石/墙体 <i style="background:#8a5a2b;margin-left:6px"></i>内部道路 <i style="background:#c81e1e;margin-left:6px"></i>双实线（宽凳真值，勾选才显示）</div>
   <div style="margin-top:4px"><i class="d" style="background:#1e6fd9"></i>高德POI（学校/医院/停车/充电/加油/商圈/公交站/消防/警务/收费站/立交/高速口/服务区，路网200m内，勾选才显示）</div>
   <div><i class="d" style="background:#333f50"></i>OSM补充（桥梁/隧道/人行横道/铁路道口/公交场站，路网100m内，勾选才显示）</div></div>
  <div id="stage"><img id="img0" src="data:image/png;base64,__A64__" alt="" draggable="false"></div>
  <div id="gselbox" style="position:absolute;left:12px;top:12px;background:rgba(255,255,255,.97);border:1px solid #f0b9a6;border-radius:8px;padding:6px 11px;font-size:12.5px;z-index:6;display:none"></div>
 </div>
 <div id="splitter" title="拖动调整 地图 / 明细 宽度（双击复位）"></div>
 <aside><h2>__NLEGS__ 条路线明细（起点 → 途经点 → 终点）</h2>
  <div class="hint"><b>规划以宽凳为准</b>：路线几何<b>只用宽凳 link</b>（顶点 0 偏差）。<br>
   <b>宽凳可画 km</b> = 能落在宽凳路网上的里程；<b>宽凳缺口 km</b> = 宽凳未采集、无法画几何的里程
   —— 这一段<b>不画线、只留缺口虚线</b>（绝不拿高德折线补画），须补测或调整服务点，见补测清单。<br>
   缺口按「沿途有宽凳路的比例」分三种性质：<br>
   <span class="chip bad">区域空白</span> &lt;35%，该片区宽凳整片没测 ·
   <span class="chip mid">路网稀疏</span> 35–70%，片区有主干路、这条乡道没测 ·
   <span class="chip low">邻近小路</span> ≥70%，旁边就有宽凳路、这条没测<br>
   <span class="tip">💡 点击任意路线行：在地图上描出该路线的 <b>起点 / 途经点 / 终点</b>（按路线全局序号标注，如「41（起点）41（途经点1）41（终点）」），路线折线高亮为蓝色、其余调暗，并缩放定位到该路线；再点一次取消。</span></div>
  __STREETS__</aside>
</div>
<script>
const W=__W__,H=__H__,MK=__MK__,PAL=__PAL__,PREC=__PREC__;
const RTB="__RTB__",GBB="__GBB__",CHB="__CHB__";
const SL1B="__SL1B__",SL2B="__SL2B__",SLN1=__SLN1__,SLN2=__SLN2__;
const RBB="__RBB__",BUSB="__BUSB__",BIKEB="__BIKEB__",RIGHTB="__RIGHTB__",GUARDB="__GUARDB__",CURBB="__CURBB__",INNB="__INNB__",DBLB="__DBLB__";
const stage=document.getElementById('stage');
stage.style.width=W+'px';stage.style.height=H+'px';
// Δ+varint+base64 → path d 字符串。32k 点只要 ~90KB，比直接塞 2.4MB 的 d 字面量快得多。
function decPaths(b64,prec){
 const s=atob(b64),L=s.length;let p=0;
 // 注意：续接位必须在「未掩码的原始字节」上判断。写成 b=charCodeAt(p++)&127 再 while(b&128)
 // 会把续接位一起抹掉，循环永远只读 1 字节、整条字节流错位（实测会解出 1154 条子路径的垃圾）。
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
const RT=decPaths(RTB,PREC),GB=decPaths(GBB,PREC),CH=decPaths(CHB,PREC);
const marksHtml=MK.map(m=>{
 const c=m.kind==='base'?'#10824a':'#e8940c';
 const r=m.kind==='base'?3.6:2.5;
 const ring=m.terminal?'<circle cx="'+m.x+'" cy="'+m.y+'" data-r0="'+(r+2)+'" fill="none" stroke="#781414"/>':'';
 return ring+'<circle cx="'+m.x+'" cy="'+m.y+'" data-r0="'+r+'" fill="'+c+'" stroke="#fff"><title>'+
   m.label+' · '+m.name+'（'+m.n_leg+' 条路线经过）</title></circle>';
}).join('');
// 灰底 <img> 写在标记里（浏览器能在解析阶段就并行解码），所以这里只能追加 SVG，
// 不能用 stage.innerHTML=... —— 那会把 <img id="img0"> 一起替换掉，灰底就没了。
stage.insertAdjacentHTML('beforeend','<svg id="svg" viewBox="0 0 '+W+' '+H+'">'
 +'<g id="gap" style="display:none"></g><g id="gch" style="display:none"></g><g id="grt"></g><g id="gsl2"></g><g id="gsl1"></g>'
 +'<g id="gbn4"></g><g id="gbn5"></g><g id="gex6"></g><g id="gex7"></g><g id="gln2"></g><g id="gln3"></g><g id="grb"></g>'
 +'<g id="gapo" style="display:none"></g><g id="goso" style="display:none"></g>'
 +'__POI_GROUPS__'
 +'<g id="gmk" style="display:none">'+marksHtml+'</g><g id="gno" style="display:none"></g>'
 +'<g id="ghl" style="display:none"></g><g id="gsel"></g></svg>');
// 宽凳停止线（ODD 真值打点）：独立点集 Δ+varint 解码 → 一次性 path（零次 DOM 圆点，卡顿零增长）
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
// 实心圆点：半径 r 用户单位 + 同色描边（屏幕像素恒定）→ 任何缩放下都是一个圆点，不是空心框
// 注意 SVG 圆弧参数必须用空格分隔，否则数字会粘连成非法路径（rx=1,ry=10 这种）而不渲染
function dotPath(P,r){
 const rf=r.toFixed(2), df=(2*r).toFixed(2), a=[];
 for(let i=0;i<P.length;i+=2){
  a.push('M ',P[i].toFixed(1),' ',P[i+1].toFixed(1),
         ' m -',rf,' 0 a ',rf,' ',rf,' 0 1 0 ',df,' 0 a ',rf,' ',rf,' 0 1 0 -',df,' 0');
 }
 return a.join('');
}
const SL1_EL=[],SL2_EL=[];
function addStoplines(){
 const g1=document.getElementById('gsl1'),g2=document.getElementById('gsl2');
 const p1=mk(dotPath(decDots(SL1B,PREC),1.6),'sl','#1557db',1);p1.setAttribute('fill','#1557db');
 const p2=mk(dotPath(decDots(SL2B,PREC),1.1),'sl','#9a6b00',0.45);p2.setAttribute('fill','#9a6b00');
 g1.appendChild(p1);g2.appendChild(p2);
 g1.style.display='none';g2.style.display='none';
 for(const p of g1.querySelectorAll('path'))SL1_EL.push(p);
 for(const p of g2.querySelectorAll('path'))SL2_EL.push(p);
}
requestAnimationFrame(function(){requestAnimationFrame(addStoplines);});
// ---- ODD 沿线图层（环岛/公交道/非机动车道/护栏/路缘石墙体）：enc_paths 同款折线解码 ----
// enc_paths 编码：n=点数(uv) → 首点(zigzag uv) → 逐段 Δx,Δy(zigzag uv)；点坐标 = 整数/prec
function decLines(b64,prec){
 if(!b64)return [];
 const s=atob(b64);let p=0;
 function uv(){let r=0,sh=1,b;do{b=s.charCodeAt(p++);r+=(b&127)*sh;sh*=128;}while(b&128);return r;}
 function sv(){const u=uv();return (u&1)?-((u+1)/2):(u/2);}
 const polys=[];
 while(p<s.length){
  const n=uv();if(n<2){continue;}
  let x=sv(),y=sv();const P=[[x/prec,y/prec]];
  for(let i=1;i<n;i++){x+=sv();y+=sv();P.push([x/prec,y/prec]);}
  polys.push(P);
 }
 return polys;
}
function linesToD(polys){
 return polys.map(P=>P.map((q,i)=>(i?'L':'M')+q[0].toFixed(1)+','+q[1].toFixed(1)).join('')).join('');
}
function addOddLines(){
 const mk1=(id,b64,color,op,extra)=>{
  const g=document.getElementById(id);if(!g||!b64)return;
  const path=mk(linesToD(decLines(b64,PREC)),'',color,op);
  if(extra)for(const k in extra)path.setAttribute(k,extra[k]);
  g.appendChild(path);g.style.display='none';
 };
 mk1('grb', RBB, '#b8329e',0.85);                      // 环岛 紫
 mk1('gln2',BUSB,'#0e7c8c',0.85);                      // 公交专用道 青
 mk1('gln3',BIKEB,'#4a7d1f',0.75);                     // 非机动车道 绿
 mk1('gbn4',GUARDB,'#c2571c',0.75);                    // 护栏族 橙
 mk1('gbn5',CURBB,'#7a4a9e',0.55,{'stroke-dasharray':'6 4'});  // 路缘石/墙体 虚
 mk1('gex6',INNB,'#8a5a2b',0.8,{'stroke-dasharray':'8 5'});   // 内部道路 棕 虚
 mk1('gex7',DBLB,'#c81e1e',0.7,{'stroke-dasharray':'2 3'});   // 双实线(禁变道) 红 点虚
}
requestAnimationFrame(function(){requestAnimationFrame(addOddLines);});
// ---- 高德 POI / OSM 补充元素：打点图层（enc_dots 同款解码 + dotPath 圆点）----
const AMAPL=__AMAPL__,OSML=__OSML__;
const POI_EL=[];   // {el, r0} 屏幕恒定半径：rescale() 时按 k/s 重建 d
const POI_DOTS={}; // key -> Float64Array
function addPoiLayer(prefix,L){
 for(const L2 of L){
  if(!L2.b64)continue;
  const g=document.getElementById(prefix+'_'+L2.key);if(!g)continue;
  const P=decDots(L2.b64,PREC);POI_DOTS[L2.key]=P;
  const p=mk(dotPath(P,L2.r),'','x',1);
  p.setAttribute('fill',L2.color);
  p.setAttribute('stroke','#fff');p.setAttribute('stroke-width','.35');
  g.appendChild(p);
  // 初始显隐跟随 checkbox（#poin 深链在同步段已勾上，不能在这里强制 none 覆盖）
  const cb=document.getElementById((prefix==='ga'?'a_':'o_')+L2.key);
  g.style.display=(cb&&cb.checked)?'block':'none';
  POI_EL.push({el:p,key:L2.key,r0:L2.r});
 }
}
function poiRescale(){
 // 屏幕恒定：用户半径 = r0 * (1/s) / s? 不——stage scale(s) 把用户单位缩成 s 倍屏幕像素，
 // 所以屏幕半径 = r_user * s。要屏幕半径 = r0 像素 → r_user = r0/s。
 const rr=1/s;
 for(const o of POI_EL){
  o.el.setAttribute('d',dotPath(POI_DOTS[o.key],o.r0*rr));
 }
}
requestAnimationFrame(function(){requestAnimationFrame(function(){addPoiLayer('ga',AMAPL);addPoiLayer('go',OSML);poiRescale();});});
// 路线编号：同一条路线的所有锚点标同一个号（路线1 → 1 1 1 1）
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
 // 黄金角环形错位：密集区里把标号散开，避免全挤在右上角叠成一坨
 const a=_i*2.399963229728653;_i++;
 NO_EL.push({el:t,x:m.x,y:m.y,c:Math.cos(a),sn:Math.sin(a)});
}
// 线宽按「屏幕像素」恒定：CSS 变量里存 目标像素/当前缩放，随缩放实时改，首屏不糊、放大不变粗
function mk(d,cls,c,op,cap){
 const p=document.createElementNS('http://www.w3.org/2000/svg','path');
 p.setAttribute('d',d);p.setAttribute('fill','none');p.setAttribute('stroke',c);
 p.setAttribute('stroke-opacity',op);
 if(cls)p.setAttribute('class',cls);
 p.setAttribute('stroke-linejoin',cap||'round');p.setAttribute('stroke-linecap',cap||'round');
 return p;
}
const grt=document.getElementById('grt'),gch=document.getElementById('gch'),
      ggap=document.getElementById('gap');
// __NLEGS__ 条合并成 1 条 path（白描边 + 红线各 1 个元素），少 __NLEGSx2__ 次绘制/样式解析
const RTC=RT.join(''),GBC=GB.join(''),CHC=CH.join('');
// 把 366KB 的 d 挂进 DOM 是整段脚本里最贵的一步（实测 ~55ms）。推到「首帧之后再下一帧」执行，
// 让灰底和标号先画出来、用户立刻看到东西，红线随后补上（人眼基本感觉不到）。
function addRoutePaths(){
 ggap.appendChild(mk(GBC,'gap','#6c7688',0.9,'butt'));
 grt.appendChild(mk(RTC,'cs','#ffffff',1));
 grt.appendChild(mk(RTC,'',"#de1c08",0.95));
 gch.appendChild(mk(CHC,'ch','#3c4250',0.8,'butt'));
}
requestAnimationFrame(function(){requestAnimationFrame(addRoutePaths);});
const MK_EL=[...document.querySelectorAll('#gmk circle')];
const box=document.getElementById('mapbox');
let s=1,tx=0,ty=0,fit=1;
const SW_PX=1.7,SC_PX=3.8,SD1_PX=7,SD2_PX=5,SMK_PX=0.9,SF_PX=13.5,SH_PX=2.7,SG_PX=3.0,SG2_PX=2.1,SLK_PX=2.6,SLK2_PX=1.7,OLK_PX=2.2,OLK2_PX=1.5;
function rescale(){
 // 目标屏幕像素 / 当前缩放 = SVG 用户单位，保证任何缩放下线宽/字号一致
 const k=1/s;
 stage.style.setProperty('--sw', (SW_PX*k).toFixed(2));
 stage.style.setProperty('--swc',(SC_PX*k).toFixed(2));
 stage.style.setProperty('--sda',(SD1_PX*k).toFixed(2));
 stage.style.setProperty('--sdb',(SD2_PX*k).toFixed(2));
 stage.style.setProperty('--smk',(SMK_PX*k).toFixed(2));
 stage.style.setProperty('--sf', (SF_PX*k).toFixed(2));
 stage.style.setProperty('--sh', (SH_PX*k).toFixed(2));
 stage.style.setProperty('--sg', (SG_PX*k).toFixed(2));
 stage.style.setProperty('--sg2',(SG2_PX*k).toFixed(2));
 stage.style.setProperty('--slk',(SLK_PX*k).toFixed(2));
 stage.style.setProperty('--slk2',(SLK2_PX*k).toFixed(2));
 stage.style.setProperty('--olk',(OLK_PX*k).toFixed(2));
 stage.style.setProperty('--olk2',(OLK2_PX*k).toFixed(2));
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
// ---- 2026-10-26 可拖拽分栏：地图 ⇔ 明细表，宽度记忆 + 地图自适应 ----
(function(){
 const sp=document.getElementById('splitter'),wrap=document.querySelector('.wrap');
 const KEY='hc_odd_map_ratio',DEF=0.62;   // 地图列占比（含 splitter 6px）
 function setRatio(r){
  r=Math.max(0.30,Math.min(0.85,r));
  const rect=wrap.getBoundingClientRect();
  const mapPx=Math.round(rect.width*r-3);
  wrap.style.gridTemplateColumns=mapPx+'px 6px minmax(400px,1fr)';
  try{localStorage.setItem(KEY,r);}catch(e){}
  fitView();   // 地图容器变宽后重算适配
 }
 sp.addEventListener('pointerdown',e=>{
  e.preventDefault();
  sp.classList.add('drag');sp.setPointerCapture(e.pointerId);
  document.body.style.userSelect='none';
  const rect=wrap.getBoundingClientRect();
  const move=ev=>{           // 按 wrap 自身几何算比例，不受视口 padding 影响
   setRatio((ev.clientX-rect.left)/rect.width);
  };
  const up=ev=>{sp.classList.remove('drag');document.body.style.userSelect='';
   window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);};
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);
 });
 sp.addEventListener('dblclick',()=>{try{localStorage.removeItem(KEY);}catch(e){};setRatio(DEF);});
 try{const saved=parseFloat(localStorage.getItem(KEY));if(isFinite(saved)&&saved>0)setRatio(saved);}catch(e){}
 window.addEventListener('resize',()=>{try{const saved=parseFloat(localStorage.getItem(KEY));if(isFinite(saved)&&saved>0)setRatio(saved);else fitView();}catch(e){fitView();}});
})();
let zFix=1;   // 支持 #z=2 深链到某个缩放倍数
(function(){const m=location.hash.match(/[#&]z=([\d.]+)/);
 if(m){const z=parseFloat(m[1]);if(isFinite(z)&&z>0)zFix=z;}})();
function fitInit(){fitView();
 if(zFix!==1){s=fit*zFix;tx=(box.clientWidth-W*s)/2;ty=(box.clientHeight-H*s)/2;apply();}}
function setVis(id,v){document.getElementById(id).style.display=v?'block':'none';}
const L0=document.getElementById('l0'),L1=document.getElementById('l1'),
      SL1=document.getElementById('sl1'),SL2=document.getElementById('sl2'),
      O1=document.getElementById('o1'),O2=document.getElementById('o2'),
      O3=document.getElementById('o3'),O4=document.getElementById('o4'),O5=document.getElementById('o5'),
      O6=document.getElementById('o6'),O7=document.getElementById('o7'),
      AX=document.getElementById('ax'),OX=document.getElementById('ox');
const A_CTRLS=[],O_CTRLS=[];
for(const L of AMAPL){const c=document.getElementById('a_'+L.key);if(c)A_CTRLS.push(c);}
for(const L of OSML){const c=document.getElementById('o_'+L.key);if(c)O_CTRLS.push(c);}
function sync(){
 setVis('img0',L0.checked);
 setVis('grt',L1.checked);
 setVis('gsl1',SL1.checked);
 setVis('gsl2',SL2.checked);
 setVis('grb',O1.checked);
 setVis('gln2',O2.checked);
 setVis('gln3',O3.checked);
 setVis('gbn4',O4.checked);
 setVis('gbn5',O5.checked);
 setVis('gex6',O6.checked);
 setVis('gex7',O7.checked);
 for(const c of A_CTRLS)setVis('ga_'+c.id.slice(2),c.checked);
 for(const c of O_CTRLS)setVis('go_'+c.id.slice(2),c.checked);
}
L0.onchange=sync;L1.onchange=sync;SL1.onchange=sync;SL2.onchange=sync;
O1.onchange=sync;O2.onchange=sync;O3.onchange=sync;O4.onchange=sync;O5.onchange=sync;O6.onchange=sync;O7.onchange=sync;
for(const c of A_CTRLS.concat(O_CTRLS))c.onchange=sync;
// 「全部」开关：批量勾/清该源的所有子项
AX.onchange=()=>{for(const c of A_CTRLS)c.checked=AX.checked;sync();};
OX.onchange=()=>{for(const c of O_CTRLS)c.checked=OX.checked;sync();};
// #slon 直接把 ODD 图层全勾上（用于截图/自动化验证）
if(location.hash.indexOf('slon')>=0){SL1.checked=true;SL2.checked=true;O1.checked=true;O2.checked=true;O3.checked=true;O4.checked=true;O5.checked=true;O6.checked=true;O7.checked=true;sync();}
if(location.hash.indexOf('poin')>=0){AX.checked=true;for(const c of A_CTRLS)c.checked=true;OX.checked=true;for(const c of O_CTRLS)c.checked=true;sync();}
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
// ---- 2026-10-19 用户要求：点击明细表路线行 → 地图描点（起点/途经点/终点）----
const LEGSP=__LEGSP__;
const LEGB64=__LEGB64__,LEGIDX=__LEGIDX__;
let selGid=null;
function selLeg(gid,fromUser){
 // 用户点击同一条 = 取消；内部重画（rescale 包装器调用）不触发取消逻辑
 if(fromUser&&selGid===gid){selGid=null;}else{selGid=gid;}
 document.querySelectorAll('tr.lrow').forEach(r=>r.classList.toggle('sel',+r.dataset.gid===selGid));
 const gsel=document.getElementById('gsel');
 gsel.innerHTML='';
 document.querySelectorAll('tr.lrow').forEach(r=>{if(+r.dataset.gid!==selGid)r.classList.remove('sel');});
 if(selGid==null){
  document.getElementById('gselbox').style.display='none';
  document.getElementById('ghl').style.display='none';stage.classList.remove('dim');
  return;
 }
 const L=LEGSP.find(l=>l.gid===selGid);
 if(!L)return;
 // ---- 高亮该路线折线（2026-10-19 用户：只描锚点看不出是哪条线）----
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
 const k=1/s;   // 与 rescale() 同口径：屏幕像素恒定 → 用户单位 = px/s
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
 const RAD={起点:11,途经点:9,终点:11};
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
  // 途经点按顺序编号：途经点1、途经点2 …（用户 2026-10-19 要求）
  // 2026-10-26 防遮挡：标签沿锚点链交替左/右偏移（用户反馈地图上只能看到 3 个标签，其余被压住）
  if(p.role==='途经点')viaNo++;
  const label=p.role==='途经点'?(L.gid+'（途经点'+viaNo+'）'):(L.gid+'（'+p.role+'）');
  const ti=document.createElementNS(NS,'title');
  ti.textContent='路线'+L.gid+'-'+L.street+(p.role==='途经点'?(' 途经点'+viaNo+' · '):' · ')+p.name;
  c.appendChild(ti);gsel.appendChild(c);
  // 标注：交替偏移（起点/终点居中上方，途经点按奇偶左右错开），避免相邻锚点标签互相压住
  const side=(p.role==='途经点')?(viaNo%2?1:-1):0;
  mkText(p.x+side*40*k,p.y-16*k,label,col,13);
 }
 // 视角定位：该路线锚点包围盒 + 12% 边距（仅用户点击时定位；rescale 重画不动视角）
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
 nb.innerHTML='<b>路线'+L.gid+'-'+L.street+'</b>：已描出 '
  +L.pts.length+' 个锚点（起点/途经点/终点）· <a href="javascript:void(0)" id="unsel">取消</a>';
 document.getElementById('unsel').onclick=()=>{selGid=null;
  document.querySelectorAll('tr.lrow').forEach(r=>r.classList.remove('sel'));
  gsel.innerHTML='';nb.style.display='none';
  document.getElementById('ghl').style.display='none';stage.classList.remove('dim');
  fitView();};
}
document.querySelectorAll('tr.lrow').forEach(r=>{
 r.addEventListener('click',()=>selLeg(+r.dataset.gid,true));
});
// rescale 时同步重画选中描点（线宽/字号按屏幕像素恒定）；fromUser=false 不再定位视角
const _rescale0=rescale;
rescale=function(){_rescale0();if(selGid!=null){selLeg(selGid,false);}};
addEventListener('resize',fitView);
if(window.ResizeObserver){new ResizeObserver(fitView).observe(box);}
requestAnimationFrame(fitInit);setTimeout(fitInit,120);setTimeout(fitInit,600);
addEventListener('load',fitInit);
sync();fitInit();
__SELFTEST__
</script></body></html>"""
    amap_l = data.get("amap_layers", [])
    osm_l = data.get("osm_layers", [])
    amap_ctrls = "".join(
        f'<label style="padding-left:14px"><input type="checkbox" id="a_{l["key"]}"> '
        f'{l["label"]} <span style="color:#6b7280">({l["n"]:,})</span></label>' for l in amap_l)
    osm_ctrls = "".join(
        f'<label style="padding-left:14px"><input type="checkbox" id="o_{l["key"]}"> '
        f'{l["label"]} <span style="color:#6b7280">({l["n"]:,})</span></label>' for l in osm_l)
    poi_groups = "".join(
        f'<g id="ga_{l["key"]}" style="display:none"></g>' for l in amap_l) + \
        "".join(f'<g id="go_{l["key"]}" style="display:none"></g>' for l in osm_l)

    html = (tpl.replace("__CARDS__", card_html).replace("__STREETS__", streets_html)
            .replace("__AMAP_CTRLS__", amap_ctrls).replace("__OSM_CTRLS__", osm_ctrls)
            .replace("__POI_GROUPS__", poi_groups)
            .replace("__AMAPL__", json.dumps(amap_l, ensure_ascii=False))
            .replace("__OSML__", json.dumps(osm_l, ensure_ascii=False))
            .replace("__NLEGS__", str(st["legs"]))
            .replace("__NLEGSx2__", str(st["legs"] * 2))
            .replace("__NSTREETS__", str(st["streets"]))
            .replace("__W__", str(data["W"])).replace("__H__", str(data["H"]))
            .replace("__RTB__", data["route_b64"])
            .replace("__LEGB64__", json.dumps(data["leg_route_b64"]))
            .replace("__LEGIDX__", json.dumps(data["leg_route_idx"]))
            .replace("__GBB__", data["gap_b64"])
            .replace("__CHB__", data["chain_b64"])
            .replace("__SL1B__", data["dots_light_b64"])
            .replace("__SL2B__", data["dots_dark_b64"])
            .replace("__RBB__", data["rb_b64"])
            .replace("__BUSB__", data["ln_bus_b64"])
            .replace("__BIKEB__", data["ln_bike_b64"])
            .replace("__RIGHTB__", data["ln_right_b64"])
            .replace("__GUARDB__", data["bar_guard_b64"])
            .replace("__CURBB__", data["bar_curb_b64"])
            .replace("__INNB__", data["ex_inner_b64"])
            .replace("__DBLB__", data["ex_dbl_b64"])
            .replace("__SLN1__", str(data["n_light"]))
            .replace("__SLN2__", str(data["n_dark"]))
            .replace("__PREC__", str(data["prec"]))
            .replace("__MK__", json.dumps(data["marks"], ensure_ascii=False))
            .replace("__LEGSP__", json.dumps(data["legs_px"], ensure_ascii=False))
            .replace("__PAL__", json.dumps(data["pal"]))
            .replace("__A64__", a64)
            .replace("__GEN__", st["generated"])
            .replace("__ROUTEKM__", f'{st["route_km"]:,.1f}')
            .replace("__ROUTEKMAMAP__", f'{st["route_km_amap"]:,.1f}')
            .replace("__GAPSEG__", str(st["gap_segs"]))
            .replace("__NANCH__", f'{st["anchors"]:,}')
            .replace("__DEVMED__", f'{st["anchor_dev_median_m"]:.0f}')
            .replace("__DEVP90__", f'{st["anchor_dev_p90_m"]:.0f}')
            .replace("__OFFKM__", f'{st["kuandeng_off_km"]:,.1f}')
            .replace("__A__", f'{st["off_band_a"]:,.1f}')
            .replace("__B__", f'{st["off_band_b"]:,.1f}')
            .replace("__C__", f'{st["off_band_c"]:,.1f}')
            .replace("__SELFTEST__", _SELFTEST))
    path.write_text(html, encoding="utf-8")


_SELFTEST = """if(location.hash.indexOf('selftest')>=0){
 const g=id=>document.getElementById(id).style.display;
 const out=[];
 const set=(id,v)=>{document.getElementById(id).checked=v;document.getElementById(id).dispatchEvent(new Event('change'));};
 set('l0',true);set('l1',true);
 set('l0',false); out.push('l0off:'+g('img0'));
 set('l1',false); out.push('l1off:'+g('grt'));
 set('l0',true);set('l1',true);
 out.push('initFrom='+g('img0')+',imgN='+(document.getElementById('img0').naturalWidth||0));
 out.push('marks='+MK.length+',rt='+RT.length+',ch='+CH.length+',no='+NO_EL.length);
 out.push('slInit g1='+g('gsl1')+',g2='+g('gsl2'));
 set('sl1',true); out.push('sl1on g1='+g('gsl1'));
 set('sl2',true); out.push('sl2on g2='+g('gsl2'));
 set('sl1',false);set('sl2',false); out.push('slOff g1='+g('gsl1')+',g2='+g('gsl2'));
 out.push('odd2Init gb4='+g('gbn4')+',gb5='+g('gbn5'));
 set('o4',true); out.push('o4on gb4='+g('gbn4'));
 set('o5',true); out.push('o5on gb5='+g('gbn5'));
 set('o4',false);set('o5',false); out.push('odd2Off gb4='+g('gbn4')+',gb5='+g('gbn5'));
 out.push('odd3Init e6='+g('gex6')+',e7='+g('gex7'));
 set('o6',true); out.push('o6on e6='+g('gex6'));
 set('o7',true); out.push('o7on e7='+g('gex7'));
 set('o6',false);set('o7',false); out.push('odd3Off e6='+g('gex6')+',e7='+g('gex7'));
 out.push('poiInit ga_sch='+g('ga_sch')+',go_bridge='+g('go_bridge'));
 set('a_sch',true); out.push('aSchOn ga_sch='+g('ga_sch'));
 set('ax',true); out.push('axAll ga_sch2='+g('ga_sch')+',ga_hosp='+g('ga_hosp'));
 set('o_bridge',true); out.push('oBriOn go_bridge='+g('go_bridge'));
 set('ox',true); out.push('oxAll go_bri2='+g('go_bridge')+',go_tunnel='+g('go_tunnel'));
 for(const c of A_CTRLS)set(c.id,false); set('ax',false);set('ox',false);
 out.push('poiOff ga_sch3='+g('ga_sch')+',go_bri3='+g('go_bridge'));
 out.push('dLen='+Math.round((RT.join('').length+CH.join('').length)/1024)+'KB');
 out.push('box='+box.clientWidth+'x'+box.clientHeight+',fit='+fit.toFixed(4)+',s='+s.toFixed(4)+',tf='+stage.style.transform);
 document.title='ST::'+out.join(' | ');
 // 红线路径是「首帧之后再下一帧」挂上去的，等一下再校验它真的挂上了
 setTimeout(function(){
  var d=document.querySelectorAll('#grt path');
  var b1=document.querySelector('#gsl1 path'),b2=document.querySelector('#gsl2 path');
  function bb(p){if(!p)return '-';var b=p.getBBox();return Math.round(b.width)+'x'+Math.round(b.height);}
  document.title='ST::'+out.join(' | ')+' ||deferred rtPath='+d.length
    +',casing='+(d.length?d[0].getAttribute('class'):'-')
    +',dLen='+(d.length?Math.round(d[0].getAttribute('d').length/1024):0)+'KB'
    +',chPath='+document.querySelectorAll('#gch path').length
    +',slPath1='+document.querySelectorAll('#gsl1 path').length
    +',slPath2='+document.querySelectorAll('#gsl2 path').length
    +',gbn4Path='+document.querySelectorAll('#gbn4 path').length
    +',gbn5Path='+document.querySelectorAll('#gbn5 path').length
    +',gex6Path='+document.querySelectorAll('#gex6 path').length
    +',gex7Path='+document.querySelectorAll('#gex7 path').length
    +',gbn4BB='+bb(document.querySelector('#gbn4 path'))
    +',gbn5BB='+bb(document.querySelector('#gbn5 path'))
    +',slBB1='+bb(b1)+',slBB2='+bb(b2)
    +',slFill1='+(b1?b1.getAttribute('fill'):'-')+',slSW1='+(b1?getComputedStyle(b1).strokeWidth:'-')
    +',poiInit gp='+document.querySelectorAll('[id^="ga_"] path').length
    +',op='+document.querySelectorAll('[id^="go_"] path').length
    +',gpBB='+bb(document.querySelector('#ga_sch path'))
    +',opBB='+bb(document.querySelector('#go_bridge path'))
    +',gpVis='+document.getElementById('ga_sch').style.display
      +',schR='+(function(){var p=document.querySelector('#ga_sch path');if(!p)return '-';
      var m=p.getAttribute('d').match(/m -([0-9.]+)/);return m?m[1]:'?';})()
    +',poiN='+POI_EL.length;
  // 2026-10-26 用户反馈「途经点在地图上压根没看到」→ 实测：点击 gid36 后数 gsel 里实际画的圆/标签
  setTimeout(function(){
    var row=document.querySelector('tr.lrow[data-gid="36"]');
    if(row)row.click();
    setTimeout(function(){
      var circles=document.querySelectorAll('#gsel circle');
      var texts=[].map.call(document.querySelectorAll('#gsel text'),function(t){return t.textContent;});
      var ghlN=document.querySelectorAll('#ghl path').length;
      document.title+=' ||sel36 circles='+circles.length+' labels='+JSON.stringify(texts)+' ghlPaths='+ghlN;
    },400);
  },1200);
 },600);
}"""


if __name__ == "__main__":
    main()
