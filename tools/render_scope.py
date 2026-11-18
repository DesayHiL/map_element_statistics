# -*- coding: utf-8 -*-
"""证据图：52 条排班路线 vs 宽凳实际测绘范围。

主图  = 全区（宽凳路网 + 52 条排班路线 + 惠城区边界）
插图  = 芦洲镇局部放大（证明「排班路线跑到宽凳没测的地方」不是渲染问题）
输出  out/kuandeng_scope.png
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

OUT = Path(r"D:/workspace/map_element_statistics/out")
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")

LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0))
MLAT = 110574.0

PAD_M = 6000.0
W = 2600
C_NET = (86, 96, 114)
C_ROUTE = (222, 28, 8)
C_BND = (52, 58, 70)


def to_xy(lo, la):
    return (np.asarray(lo, "f8") - LON0) * MLON, (np.asarray(la, "f8") - LAT0) * MLAT


def font(sz):
    try:
        return ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", sz)
    except Exception:
        return ImageFont.load_default()


class View:
    def __init__(self, x0, x1, y0, y1, w):
        self.x0, self.x1, self.y0, self.y1 = x0, x1, y0, y1
        self.w = w
        self.h = int(round(w * (y1 - y0) / (x1 - x0)))
        self.sx = w / (x1 - x0)
        self.sy = self.h / (y1 - y0)

    def px(self, a):
        return (a[:, 0] - self.x0) * self.sx, (self.y1 - a[:, 1]) * self.sy


def dashed(d, pts, fill, w, on=3, off=2):
    for k in range(0, len(pts) - 1):
        if k % (on + off) < on:
            d.line([pts[k], pts[k + 1]], fill=fill, width=w)


def draw_panel(V, net, legs, rings, net_w=2, route_w=3, route_case=6, bnd_w=3, base_bg=True):
    img = Image.new("RGB", (V.w, V.h), (255, 255, 255) if base_bg else (250, 251, 253))
    d = ImageDraw.Draw(img)
    for L in rings:
        X, Y = V.px(L)
        dashed(d, list(zip(X.tolist(), Y.tolist())), C_BND, bnd_w)
    for L in net:
        X, Y = V.px(L)
        if X.max() < -20 or X.min() > V.w + 20 or Y.max() < -20 or Y.min() > V.h + 20:
            continue
        d.line(list(zip(X.tolist(), Y.tolist())), fill=C_NET, width=int(round(net_w)), joint="curve")
    for L in legs:
        X, Y = V.px(L)
        xy = list(zip(X.tolist(), Y.tolist()))
        d.line(xy, fill=(255, 255, 255), width=int(round(route_case)), joint="curve")
        d.line(xy, fill=C_ROUTE, width=int(round(route_w)), joint="curve")
    return img


def scalebar(d, V, metres, x_frac=0.06, y_frac=0.06, f=None):
    x = V.x0 + (V.x1 - V.x0) * x_frac
    y = V.y0 + (V.y1 - V.y0) * y_frac
    px, py = V.px(np.array([[x, y]]))
    px, py = float(px[0]), float(py[0])
    L = metres * V.sx
    for k in range(4):
        d.rectangle([px + k * L / 4, py - 10, px + (k + 1) * L / 4, py + 10],
                    fill=(20, 20, 20) if k % 2 == 0 else (255, 255, 255), outline=(20, 20, 20))
    d.text((px, py - 46), f"{metres/1000:.0f} km", fill=(20, 20, 20), font=f or font(26))


def main():
    fixed = np.load(CACHE / "ROAD_LINK.fixed.npy", mmap_mode="r")
    geom = np.memmap(CACHE / "ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
    goff = np.asarray(fixed["geom_off"], "i8") // 16
    gn = np.asarray(fixed["geom_n"], "i4")

    net = []
    for i in range(len(gn)):
        n = int(gn[i])
        if n < 2:
            continue
        o = int(goff[i])
        x, y = to_xy(geom[o:o + n, 0], geom[o:o + n, 1])
        net.append(np.column_stack([x, y]))
    print("net lines", len(net))

    doc = json.loads((OUT / "routes.json").read_text(encoding="utf-8"))
    legs, schools = [], []
    for st in doc["routes"]:
        for r in st["routes"]:
            P = np.asarray(r["poly"], "f8")
            x, y = to_xy(P[:, 0], P[:, 1])
            legs.append(np.column_stack([x, y]))
            for a in r["anchors"]:
                if a.get("kind") == "schools":
                    ax, ay = to_xy(a["gcj"][0], a["gcj"][1])
                    schools.append((float(ax), float(ay), a.get("name") or ""))

    rx0 = min(L[:, 0].min() for L in legs); rx1 = max(L[:, 0].max() for L in legs)
    ry0 = min(L[:, 1].min() for L in legs); ry1 = max(L[:, 1].max() for L in legs)
    V = View(rx0 - PAD_M, rx1 + PAD_M, ry0 - PAD_M, ry1 + PAD_M, W)
    print(f"main view {W}x{V.h} {(V.x1-V.x0)/1000:.1f}x{(V.y1-V.y0)/1000:.1f} km")

    bnd = json.loads((OUT / "_huicheng_boundary.json").read_text(encoding="utf-8"))
    rings = [np.column_stack(to_xy(np.asarray(r, "f8")[:, 0], np.asarray(r, "f8")[:, 1])) for r in bnd["rings"]]

    big = draw_panel(V, net, legs, rings)
    K = 2
    big = big.resize((V.w * K, V.h * K), Image.LANCZOS)
    d = ImageDraw.Draw(big)

    def pt(lon, lat):
        X, Y = V.px(np.array([[(lon - LON0) * MLON, (lat - LAT0) * MLAT]]))
        return float(X[0]) * K, float(Y[0]) * K

    F = font(30)
    Fs = font(27)

    # ---- 芦洲镇放大插图（左上空白区）----------------------------------
    ix0, ix1 = to_xy(114.402, 0)[0], to_xy(114.702, 0)[0]
    iy0, iy1 = to_xy(0, 23.192)[1], to_xy(0, 23.462)[1]
    IV = View(ix0, ix1, iy0, iy1, 990)
    ins = draw_panel(IV, net, legs, rings, net_w=2, route_w=3.5, route_case=7, bnd_w=3, base_bg=False)
    ins = ins.resize((IV.w * K, IV.h * K), Image.LANCZOS)
    di = ImageDraw.Draw(ins)
    for sx, sy, nm in schools:
        if ix0 < sx < ix1 and iy0 < sy < iy1:
            X, Y = IV.px(np.array([[sx, sy]]))
            X, Y = float(X[0]) * K, float(Y[0]) * K
            di.ellipse([X - 10, Y - 10, X + 10, Y + 10], fill=(16, 130, 74), outline=(255, 255, 255), width=3)
            di.text((X + 16, Y - 38), nm, fill=(12, 60, 34), font=font(27),
                    stroke_width=4, stroke_fill=(255, 255, 255))
    di.rectangle([0, 0, IV.w * K - 1, 58], fill=(20, 20, 20))
    di.text((14, 13), "放大：芦洲镇 —— 红色排班路线整段都跑在没有灰色路网的地方", fill=(255, 255, 255), font=font(27))
    di.rectangle([0, 0, IV.w * K - 1, IV.h * K - 1], outline=(20, 20, 20), width=4)
    scalebar(di, View(IV.x0, IV.x1, IV.y0, IV.y1, IV.w * K), 5000, 0.06, 0.10, font(26))

    INS_W, INS_H = IV.w * K, IV.h * K
    px_ins, py_ins = 34, 34
    big.paste(ins, (px_ins, py_ins))
    # 指示框（芦洲镇在主图的位置）
    bx0, by0 = pt(114.402, 23.462); bx1, by1 = pt(114.702, 23.192)
    d.rectangle([bx0, by0, bx1, by1], outline=(20, 20, 20), width=4)
    d.line([(bx0, by1), (px_ins + INS_W * 0.5, py_ins + INS_H)], fill=(20, 20, 20), width=3)

    # ---- 图例（插图下方，左侧空白带）----------------------------------
    ly = py_ins + INS_H + 46
    d.rectangle([34, ly, 34 + 980, ly + 168], fill=(255, 255, 255), outline=(20, 20, 20), width=2)
    d.line([(58, ly + 36), (148, ly + 36)], fill=C_NET, width=6)
    d.text((168, ly + 18), "宽凳路网 ROAD_LINK（交付的全部 5,780 km）", fill=(20, 20, 20), font=Fs)
    d.line([(58, ly + 86), (148, ly + 86)], fill=C_ROUTE, width=7)
    d.text((168, ly + 68), "52 条排班路线 1,620 km（高德驾车折线）", fill=(20, 20, 20), font=Fs)
    dashed(d, [(58 + i * 16, ly + 136) for i in range(6)], C_BND, 5)
    d.text((168, ly + 118), "惠城区 441302 行政边界（高德）", fill=(20, 20, 20), font=Fs)

    # ---- 标注 ---------------------------------------------------------
    calls = [
        ("芦洲镇：排班 91 km，宽凳只测到 7.4 km", (114.545, 23.395), (114.596, 23.446), "right"),
        ("横沥镇：排班 42 km，宽凳只测到 7.3 km", (114.585, 23.125), (114.618, 23.046), "right"),
        ("沥林镇：排班 124 km，宽凳测到 52 km", (114.155, 22.978), (114.108, 22.906), "left"),
        ("潼湖镇：排班 109 km，宽凳测到 75 km", (114.218, 23.052), (114.126, 23.126), "left"),
    ]
    for txt, anchor, labelpos, side in calls:
        ax, ay = pt(*anchor)
        tx, ty = pt(*labelpos)
        d.line([(ax, ay), (tx, ty)], fill=(20, 20, 20), width=3)
        d.ellipse([ax - 9, ay - 9, ax + 9, ay + 9], fill=(20, 20, 20))
        w = d.textlength(txt, font=F)
        bx = tx if side == "left" else tx - w
        bx = max(40, min(bx, V.w * K - w - 60))
        ty = max(py_ins + INS_H + 240, min(ty, V.h * K - 140))
        d.rectangle([bx - 9, ty - 9, bx + w + 14, ty + 42], fill=(255, 255, 255), outline=(20, 20, 20), width=2)
        d.text((bx, ty), txt, fill=(20, 20, 20), font=F)

    # ---- 主图比例尺 + 页脚 --------------------------------------------
    scalebar(d, View(V.x0, V.x1, V.y0, V.y1, V.w * K), 10000, 0.36, 0.055, font(28))

    foot = ("口径：路线点到最近宽凳 ROAD_LINK 中心线的距离 ≤20 m 记「宽凳有」。距离分布 50% 分位 3 m、75% 分位 5 m（高德与宽凳同为 GCJ02，对齐良好），"
            "90% 分位跳到 306 m、99% 分位 11.5 km —— 不是坐标系或投影误差，是这些道路宽凳确实没采。")
    d.rectangle([24, V.h * K - 104, V.w * K - 24, V.h * K - 20], fill=(255, 255, 255), outline=(20, 20, 20), width=2)
    d.text((42, V.h * K - 92), foot, fill=(20, 20, 20), font=font(28))

    big.save(OUT / "kuandeng_scope.png", optimize=True)
    print(f"[saved] out/kuandeng_scope.png {big.size}")


if __name__ == "__main__":
    main()
