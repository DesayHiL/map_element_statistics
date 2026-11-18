# -*- coding: utf-8 -*-
"""F1 精细对齐 + 叠加验证：把用户截图的红线与「芦洲镇路线1」在同尺度下叠加。

score = F1(截图红线掩膜, 该腿在截图像素坐标下的光栅掩膜)，在 k 与平移上取最大。
输出 out/_verify_overlay.png：左=叠加（主图灰网淡底+该腿绿+截图红），右=主图灰网同尺度；
并打印最佳参数与窗口经纬度、到最近宽凳路段距离。
"""
import json, math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.signal import fftconvolve

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0*math.cos(math.radians(LAT0)); MLAT = 110574.0
W, PAD_M = 5200, 8000.0
SHOT = r"C:/Users/uid06419/.workbuddy/clipboard-images/clipboard-2026-10-15T11-10-21-069Z-25e3f377.png"

doc = json.loads((OUT/"routes.json").read_text(encoding="utf-8"))
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
T = float(rm.sum())
tip_s = (int(np.nonzero(rm)[1][np.nonzero(rm)[0].argmin()]), int(np.nonzero(rm)[0].min()))

base = Image.open(OUT/"_grey_clean.png").convert("RGB")
seg = next(z for z in doc["routes"] if z["street"] == "芦洲镇")["routes"][0]
P = np.asarray(seg["poly"], "f8")
LX = (P[:, 0]-LON0)*MLON; LY = (P[:, 1]-LAT0)*MLAT
CX = (LX-x0)/span*W; CY = (y1-LY)/(y1-y0)*H
tip_c = (float(CX[CY.argmin()]), float(CY.min()))

# 区域：腿 bbox + 余量，在"截图像素坐标"下建参照
M = 300
RX0 = int(CX.min())-M*4; RY0 = int(CY.min())-M*4
RW = int(CX.max()-CX.min())+2*M*4; RH = int(CY.max()-CY.min())+2*M*4
best = None
for k in np.arange(2.10, 3.61, 0.05):
    iw, ih = int(round(RW/k)), int(round(RH/k))
    im = Image.new("L", (iw, ih), 0); d = ImageDraw.Draw(im)
    d.line(list(zip(((CX-RX0)/k).tolist(), ((CY-RY0)/k).tolist())),
           fill=255, width=max(1, int(round(3.4*k))), joint="curve")
    lm = (np.asarray(im) >= 96).astype(np.float32)
    if lm.sum() < 20:
        continue
    B = fftconvolve(lm, rm[::-1, ::-1], "valid")
    A = fftconvolve(lm, np.ones_like(rm, dtype=np.float32), "valid")
    F1 = 2*B/np.maximum(T+A, 1.0)
    i = np.unravel_index(np.argmax(F1), F1.shape)
    if best is None or F1[i] > best[0]:
        best = (float(F1[i]), float(B[i]/T), float(B[i]/max(A[i], 1)), k,
                RX0+int(i[0]*k), RY0+int(i[1]*k))
f1, rec, prec, k, cc, rr = best
print(f"[best] k={k:.2f}  F1={f1:.3f}  查全(截图被覆盖)={rec:.3f}  查准={prec:.3f}  "
      f"左上画布({cc},{rr})  (k 从 {(tip_c[0]-tip_s[0]*k):.0f},{(tip_c[1]-tip_s[1]*k):.0f} 锚点微调)")

iw, ih = int(round(tw*k)), int(round(th*k))
lon_a = LON0+(x0+cc/W*span)/MLON; lat_a = LAT0+(y1-(rr/H)*(y1-y0))/MLAT
lon_b = LON0+(x0+(cc+iw)/W*span)/MLON; lat_b = LAT0+(y1-((rr+ih)/H)*(y1-y0))/MLAT
print(f"[窗口] lon {lon_a:.5f}~{lon_b:.5f}   lat {lat_b:.5f}~{lat_a:.5f}   "
      f"({iw}x{ih} 画布px ≈ {iw*span/W/1000:.1f}x{ih*span/W/1000:.1f} km)")

C = np.column_stack([CX, CY])
m = (C[:, 0] >= cc) & (C[:, 0] <= cc+iw) & (C[:, 1] >= rr) & (C[:, 1] <= rr+ih)
LL = np.column_stack([LX, LY])[m]
print(f"[窗内] 顶点 {m.sum()}/{len(C)}  里程 {np.hypot(*np.diff(LL, axis=0).T).sum()/1000:.1f} km")
fixed = np.load(CACHE/"ROAD_LINK.fixed.npy", mmap_mode="r")
geom = np.memmap(CACHE/"ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
from scipy.spatial import cKDTree
tree = cKDTree(np.column_stack([(np.asarray(geom[:, 0], "f8")-LON0)*MLON,
                                (np.asarray(geom[:, 1], "f8")-LAT0)*MLAT]))
dd_, _ = tree.query(LL, k=1)
print(f"[窗内] 到最近宽凳路段: 中位 {np.median(dd_):.0f} m  均值 {dd_.mean():.0f} m  "
      f"最大 {dd_.max():.0f} m  >200m 占 {(dd_ > 200).mean()*100:.0f}%")


def crop_white(im, cx0, cy0, w_, h_):
    out = Image.new("RGB", (w_, h_), (255, 255, 255))
    cx0, cy0 = int(round(cx0)), int(round(cy0))
    sx0, sy0 = max(0, cx0), max(0, cy0)
    sx1, sy1 = min(im.size[0], cx0+w_), min(im.size[1], cy0+h_)
    if sx1 > sx0 and sy1 > sy0:
        out.paste(im.crop((sx0, sy0, sx1, sy1)), (sx0-cx0, sy0-cy0))
    return out


ref = crop_white(base, cc, rr, iw, ih).resize((tw, th), Image.LANCZOS)
ref = Image.blend(Image.new("RGB", (tw, th), (255, 255, 255)), ref, 0.60)
dv = ImageDraw.Draw(ref)
dv.line(list(zip(((CX-cc)/k).tolist(), ((CY-rr)/k).tolist())),
        fill=(16, 130, 74), width=max(2, int(round(3.4*k/k))), joint="curve")
# 叠加截图红线（半透明品红）
ov = np.asarray(ref).copy()
ov[rm] = (0.35*ov[rm] + 0.65*np.array([222, 28, 8])).astype(np.uint8)
ovim = Image.fromarray(ov)

gap, lab = 12, 22
sheet = Image.new("RGB", (4*tw+5*gap, th+2*lab+2*gap), (238, 240, 244))
ds = ImageDraw.Draw(sheet)
xs_ = gap
for name, im in [("主图灰网 + 芦洲镇路线1（绿）", ref), ("↑ 再叠你的截图红线（红）", ovim),
                 ("主图灰网（同尺度）", crop_white(base, cc, rr, iw, ih).resize((tw, th), Image.LANCZOS)),
                 ("你的截图", shot)]:
    ds.text((xs_+2, gap+3), name, fill=(30, 34, 44))
    sheet.paste(im, (xs_, gap+lab)); xs_ += tw+gap
sheet.save(OUT/"_verify_overlay.png")
print(f"\n[out] out/_verify_overlay.png {sheet.size}")
