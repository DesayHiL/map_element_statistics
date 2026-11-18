# -*- coding: utf-8 -*-
"""截图 = 芦洲镇路线1 北段？干净复核图（越界填白，不混灰）。

输出 out/_verify_shot.png：
  每行 = 一个尺度 k；左=主图灰网(crop,白底)+该腿红线，右=用户截图。
同时打印窗口经纬度、窗内里程、窗内顶点到最近宽凳路段的距离。
"""
import json, math, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0
W, PAD_M = 5200, 8000.0
SHOT = r"C:/Users/uid06419/.workbuddy/clipboard-images/clipboard-2026-10-15T11-10-21-069Z-25e3f377.png"

doc = json.loads((OUT / "routes.json").read_text(encoding="utf-8"))
xs, ys = [], []
for st in doc["routes"]:
    for r in st["routes"]:
        P = np.asarray(r["poly"], "f8")
        xs.append((P[:, 0]-LON0)*MLON); ys.append((P[:, 1]-LAT0)*MLAT)
x0 = min(a.min() for a in xs)-PAD_M; x1 = max(a.max() for a in xs)+PAD_M
y0 = min(a.min() for a in ys)-PAD_M; y1 = max(a.max() for a in ys)+PAD_M
span = x1-x0; H = int(round(W*(y1-y0)/span))

shot = Image.open(SHOT).convert("RGB"); th, tw = shot.size[1], shot.size[0]
s = np.asarray(shot).astype(int)
rm = (s[:, :, 0] > 175) & (s[:, :, 1] < 56) & (s[:, :, 2] < 52) & \
     (s[:, :, 0]-s[:, :, 1] > 100) & (s[:, :, 0]-s[:, :, 2] > 110)
ys_, xs_ = np.nonzero(rm); tip_s = (int(xs_[ys_.argmin()]), int(ys_.min()))

base = Image.open(OUT / "_grey_clean.png").convert("RGB")


def window_of(street, n, k):
    seg = next(s for s in doc["routes"] if s["street"] == street)["routes"][n-1]
    P = np.asarray(seg["poly"], "f8")
    lx = (P[:, 0]-LON0)*MLON; ly = (P[:, 1]-LAT0)*MLAT
    cx = (lx-x0)/span*W; cy = (y1-ly)/(y1-y0)*H
    return np.column_stack([cx, cy]), np.column_stack([lx, ly])


def crop_white(im, cx0, cy0, iw, ih):
    """带越界填白的裁剪；返回与请求同尺寸的图像。"""
    cx0, cy0 = int(round(cx0)), int(round(cy0))
    out = Image.new("RGB", (iw, ih), (255, 255, 255))
    sx0, sy0 = max(0, cx0), max(0, cy0)
    sx1, sy1 = min(im.size[0], cx0+iw), min(im.size[1], cy0+ih)
    if sx1 > sx0 and sy1 > sy0:
        out.paste(im.crop((sx0, sy0, sx1, sy1)), (sx0-cx0, sy0-cy0))
    return out


rows = []
for street, n, k, cc, rr in [("芦洲镇", 1, 2.60, 3163, 6), ("芦洲镇", 1, 2.80, 3082, -89),
                             ("芦洲镇", 1, 3.00, 2992, -181), ("横沥镇", 1, 2.40, 3514, 2058)]:
    C, _ = window_of(street, n, k)
    iw, ih = int(round(tw*k)), int(round(th*k))
    crop = crop_white(base, cc, rr, iw, ih)
    dv = ImageDraw.Draw(crop)
    dv.line(list(zip((C[:, 0]-cc).tolist(), (C[:, 1]-rr).tolist())),
            fill=(222, 28, 8), width=max(1, int(round(3.4*k))), joint="curve")
    crop = crop.resize((tw, th), Image.LANCZOS)
    rows.append((f"{street}路线{n} k={k:.2f}", crop))
    # 经纬度范围
    lon_a = LON0 + (x0+cc/W*span)/MLON; lat_a = LAT0 + (y1-(rr/H)*(y1-y0))/MLAT
    lon_b = LON0 + (x0+(cc+iw)/W*span)/MLON; lat_b = LAT0 + (y1-((rr+ih)/H)*(y1-y0))/MLAT
    print(f"\n=== {street}路线{n}  k={k:.2f}  窗口画布({cc},{rr})+{iw}x{ih} ===")
    print(f"    lon {lon_a:.5f}~{lon_b:.5f}   lat {lat_b:.5f}~{lat_a:.5f}")

# 窗内里程 + 到最近宽凳路段距离（k=2.80 那个窗口）
C, LL = window_of("芦洲镇", 1, 2.80); cc, rr, k = 3082, -89, 2.80
iw, ih = tw*k, th*k
m = (C[:, 0] >= cc) & (C[:, 0] <= cc+iw) & (C[:, 1] >= rr) & (C[:, 1] <= rr+ih)
print(f"\n[k=2.80 窗内] 顶点 {m.sum()}/{len(C)}  里程 "
      f"{np.hypot(*np.diff(LL[m], axis=0).T).sum()/1000:.1f} km")

fixed = np.load(CACHE / "ROAD_LINK.fixed.npy", mmap_mode="r")
geom = np.memmap(CACHE / "ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
from scipy.spatial import cKDTree
GX = (np.asarray(geom[:, 0], "f8")-LON0)*MLON; GY = (np.asarray(geom[:, 1], "f8")-LAT0)*MLAT
tree = cKDTree(np.column_stack([GX, GY]))
d, _ = tree.query(LL[m], k=1)
print(f"[k=2.80 窗内] 到最近宽凳路段: 中位 {np.median(d):.0f} m  均值 {d.mean():.0f} m  "
      f"最大 {d.max():.0f} m  全部 >200m 的比例 {(d > 200).mean()*100:.0f}%")

gap, lab = 10, 20
cw, ch = tw*2+gap, th+lab
sheet = Image.new("RGB", (2*cw+3*gap, 2*ch+3*gap), (238, 240, 244))
dd = ImageDraw.Draw(sheet)
for idx, (name, im) in enumerate(rows):
    r_, c_ = divmod(idx, 2)
    ox = gap+c_*(cw+gap); oy = gap+r_*(ch+gap)
    sheet.paste(im, (ox, oy+lab)); sheet.paste(shot, (ox+tw+gap, oy+lab))
    dd.text((ox+2, oy+3), f"{name}  (左=主图灰网+该腿红线 | 右=你的截图)", fill=(30, 34, 44))
sheet.save(OUT / "_verify_shot.png")
print(f"\n[out] out/_verify_shot.png {sheet.size}")
