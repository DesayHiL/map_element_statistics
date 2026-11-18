# -*- coding: utf-8 -*-
"""诊断图：宽凳交付范围 vs 排班路线盲区段。

输出 out/_diag_scope.png
  灰点 = 宽凳 ROAD_LINK 顶点（交付范围）
  红线 = 被判定为「盲区」的路线段
  蓝框 = 惠城区 441302 边界
  标注  = 芦洲/横沥/沥林/潼湖 的盲区位置
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.spatial import cKDTree

OUT = Path(r"D:/workspace/map_element_statistics/out")
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")

LAT0, LON0 = 23.16, 114.40
MLAT = 110574.0
MLON = 111320.0 * math.cos(math.radians(LAT0))

# 视野：覆盖整个宽凳交付 + 惠城区
LONMIN, LONMAX = 114.00, 114.78
LATMIN, LATMAX = 22.70, 23.80
W, H = 1600, 2260


def px(lon, lat):
    x = (lon - LONMIN) / (LONMAX - LONMIN) * W
    y = (LATMAX - lat) / (LATMAX - LATMIN) * H
    return x, y


def to_xy(lo, la):
    return (np.asarray(lo, "f8") - LON0) * MLON, (np.asarray(la, "f8") - LAT0) * MLAT


def resample(P, step):
    seg = np.hypot(np.diff(P[:, 0]), np.diff(P[:, 1]))
    tot = float(seg.sum())
    if tot <= 0:
        return P[:1]
    n = int(math.ceil(tot / step)) + 1
    s = np.linspace(0, tot, n)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    return np.column_stack([np.interp(s, cum, P[:, 0]), np.interp(s, cum, P[:, 1])])


def main():
    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)

    # --- 宽凳路网顶点
    fixed = np.load(CACHE / "ROAD_LINK.fixed.npy", mmap_mode="r")
    geom = np.memmap(CACHE / "ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
    goff = np.asarray(fixed["geom_off"], "i8") // 16
    gn = np.asarray(fixed["geom_n"], "i4")
    G = np.asarray(geom[:], "f8")
    print("net verts", len(G))
    xs, ys = px(G[:, 0], G[:, 1])
    ok = (xs >= 0) & (xs < W) & (ys >= 0) & (ys < H)
    for x, y in zip(xs[ok], ys[ok]):
        d.point((x, y), fill=(150, 160, 175))

    # --- 惠城区边界
    bnd = json.loads((OUT / "_huicheng_boundary.json").read_text(encoding="utf-8"))
    for ring in bnd["rings"]:
        a = np.asarray(ring, "f8")
        pts = [px(lo, la) for lo, la in a]
        d.line(pts, fill=(21, 87, 214), width=3)

    # --- 全网络采样 + 路线盲区
    parts = []
    for i in range(len(gn)):
        n = int(gn[i])
        if n < 2:
            continue
        o = int(goff[i])
        P = np.asarray(geom[o:o + n], "f8")
        x, y = to_xy(P[:, 0], P[:, 1])
        parts.append(resample(np.column_stack([x, y]), 6.0))
    net = np.vstack(parts)
    tree = cKDTree(net)

    doc = json.loads((OUT / "routes.json").read_text(encoding="utf-8"))
    nblind = 0
    for st in doc["routes"]:
        for r in st["routes"]:
            poly = np.asarray(r["poly"], "f8")
            x, y = to_xy(poly[:, 0], poly[:, 1])
            S = resample(np.column_stack([x, y]), 4.0)
            dd, _ = tree.query(S, k=1, distance_upper_bound=1e9)
            off = dd > 20.0
            idx = np.nonzero(np.diff(np.concatenate([[0], off.view("i1"), [0]])))[0]
            for a, b in zip(idx[::2], idx[1::2]):
                if b - a < 6:
                    continue
                lo = S[a:b, 0] / MLON + LON0
                la = S[a:b, 1] / MLAT + LAT0
                pts = [px(u, v) for u, v in zip(lo, la)]
                d.line(pts, fill=(222, 28, 8), width=3)
                nblind += 1
    print("blind segs drawn", nblind)

    # --- 标注
    labels = [
        ("芦洲镇", 114.545, 23.395),
        ("横沥镇", 114.595, 23.130),
        ("沥林镇", 114.160, 22.985),
        ("潼湖镇", 114.215, 23.050),
        ("惠城区政府", 114.383, 23.084),
    ]
    for name, lo, la in labels:
        x, y = px(lo, la)
        d.ellipse([x - 5, y - 5, x + 5, y + 5], fill=(0, 0, 0))
        d.text((x + 9, y - 6), name, fill=(0, 0, 0))

    img.save(OUT / "_diag_scope.png")
    print("[saved] out/_diag_scope.png")

    # --- 数值：关键点 5km 内宽凳长度
    print("\n关键点 5km 内宽凳路网长度:")
    for name, lo, la in labels:
        x, y = px(lo, la)
        X, Y = to_xy(lo, la)
        m = np.hypot(net[:, 0] - X, net[:, 1] - Y) < 5000
        print(f"  {name:<10} {m.sum()*6.0/1000:8.1f} km")


if __name__ == "__main__":
    main()
