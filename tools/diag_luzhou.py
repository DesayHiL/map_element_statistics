# -*- coding: utf-8 -*-
"""核验「排班路线不在宽凳地图上」：直接对原始宽凳 SHP 量测，不看渲染图。

对 芦洲镇/横沥镇 两条 D 腿：
  1. 逐顶点量到最近宽凳 ROAD_LINK 的距离（KD 树，原始 SHP 中心线）
  2. 给出 >200/>500/>1000/>2000 m 的里程占比
  3. 从 _grey_clean.png 裁出该腿包围盒，肉眼看灰网到底有没有
"""
import json, math, time
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0
W, PAD_M = 5200, 8000.0

doc = json.loads((OUT / "routes.json").read_text(encoding="utf-8"))

# 视图范围（与主图/_greybase 完全一致）
xs, ys = [], []
for st in doc["routes"]:
    for r in st["routes"]:
        P = np.asarray(r["poly"], "f8")
        xs.append((P[:, 0] - LON0) * MLON); ys.append((P[:, 1] - LAT0) * MLAT)
x0, x1 = min(a.min() for a in xs) - PAD_M, max(a.max() for a in xs) + PAD_M
y0, y1 = min(a.min() for a in ys) - PAD_M, max(a.max() for a in ys) + PAD_M
span = x1 - x0; H = int(round(W * (y1 - y0) / span))
print(f"[view] {W}x{H} span={span/1000:.1f}km")
print(f"[view] lon {LON0+x0/MLON:.5f}~{LON0+x1/MLON:.5f}  lat {LAT0+y0/MLAT:.5f}~{LAT0+y1/MLAT:.5f}")

# 宽凳原始中心线顶点（全量）
t0 = time.time()
fixed = np.load(CACHE / "ROAD_LINK.fixed.npy", mmap_mode="r")
geom = np.memmap(CACHE / "ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
goff = np.asarray(fixed["geom_off"], dtype="i8") // 16
gn = np.asarray(fixed["geom_n"], dtype="i4")
GX = (np.asarray(geom[:, 0], "f8") - LON0) * MLON
GY = (np.asarray(geom[:, 1], "f8") - LAT0) * MLAT
tree = cKDTree(np.column_stack([GX, GY]))
print(f"[kd] {len(GX):,} 顶点 KD 树就绪 {time.time()-t0:.1f}s")

base = Image.open(OUT / "_grey_clean.png").convert("RGB")
tiles = []
for st in doc["routes"]:
    if st["street"] not in ("芦洲镇", "横沥镇"):
        continue
    for i, r in enumerate(st["routes"], start=1):
        P = np.asarray(r["poly"], "f8")
        X = (P[:, 0] - LON0) * MLON; Y = (P[:, 1] - LAT0) * MLAT
        d, _ = tree.query(np.column_stack([X, Y]), k=1)
        seg = np.hypot(np.diff(X), np.diff(Y))
        mid = 0.5 * (d[:-1] + d[1:])
        tot = seg.sum()
        km = tot / 1000.0
        print(f"\n=== {st['street']} 路线{i}  {km:.1f} km  {len(P)} 顶点 ===")
        print(f"  到最近宽凳路段距离: 中位 {np.median(d):8.1f} m  均值 {d.mean():8.1f} m  最大 {d.max():9.1f} m")
        for thr in (200, 500, 1000, 2000, 5000):
            frac = (mid > thr).sum() / len(mid)
            print(f"  > {thr:5d} m 的里程   {seg[mid>thr].sum()/1000:7.1f} km  ({frac*100:5.1f}%)")
        # 裁图
        px = (X - x0) / span * W; py = (y1 - Y) / (y1 - y0) * H
        pad = 260
        cx0, cy0 = int(max(0, px.min() - pad)), int(max(0, py.min() - pad))
        cx1, cy1 = int(min(W, px.max() + pad)), int(min(H, py.max() + pad))
        crop = base.crop((cx0, cy0, cx1, cy1)).copy()
        dc = ImageDraw.Draw(crop)
        dc.line(list(zip((px - cx0).tolist(), (py - cy0).tolist())), fill=(222, 28, 8), width=4, joint="curve")
        for a in (0, len(P) - 1):
            dc.ellipse([px[a]-cx0-9, py[a]-cy0-9, px[a]-cx0+9, py[a]-cy0+9], fill=(16, 130, 74))
        tiles.append((f"{st['street']}路线{i}", crop))
        print(f"  画布裁剪 ({cx0},{cy0})-({cx1},{cy1})  {crop.size[0]}x{crop.size[1]}")

# 拼图
if tiles:
    gap, lab = 10, 20
    tw = max(t[1].size[0] for t in tiles); th = sum(t[1].size[1] + lab for t in tiles) + gap*(len(tiles)+1)
    sheet = Image.new("RGB", (tw + 2*gap, th), (238, 240, 244)); ds = ImageDraw.Draw(sheet)
    oy = gap
    for name, im in tiles:
        ds.text((gap+2, oy+3), name, fill=(30, 34, 44))
        sheet.paste(im, (gap, oy + lab)); oy += lab + im.size[1] + gap
    sheet.save(OUT / "_diag_luzhou.png")
    print(f"\n[out] out/_diag_luzhou.png  {sheet.size}")
