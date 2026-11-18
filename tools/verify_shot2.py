# -*- coding: utf-8 -*-
"""最终复核：锚定 芦洲镇路线1，k∈[2.6,3.4] 细搜，输出叠加图与全部量化结论。

score = 对称截断倒角
       fwd = mean(截图红px → 该腿, 截断 8px)
       rev = mean(该腿窗内px → 截图红, 截断 8px)
两者都在"截图像素"坐标下算；非退化要求窗内腿像素 >= 0.12*T。
"""
import json, math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.signal import fftconvolve
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0*math.cos(math.radians(LAT0)); MLAT = 110574.0
W, PAD_M, CAP = 5200, 8000.0, 8.0
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
Dt = np.minimum(ndimage.distance_transform_edt(~rm), CAP).astype(np.float32)
r0 = np.nonzero(rm)[0]; c0 = np.nonzero(rm)[1]
tip_s = (int(c0[r0.argmin()]), int(r0.min()))

base = Image.open(OUT/"_grey_clean.png").convert("RGB")
seg = next(z for z in doc["routes"] if z["street"] == "芦洲镇")["routes"][0]
P = np.asarray(seg["poly"], "f8")
LX = (P[:, 0]-LON0)*MLON; LY = (P[:, 1]-LAT0)*MLAT
CX = (LX-x0)/span*W; CY = (y1-LY)/(y1-y0)*H
tip_c = (float(CX[CY.argmin()]), float(CY.min()))

MX = 420
results = []
for k in np.arange(2.6, 3.41, 0.2):
    ox, oy = tip_c[0]-tip_s[0]*k, tip_c[1]-tip_s[1]*k
    iw, ih = int(round(tw*k))+2*MX, int(round(th*k))+2*MX
    ref = Image.new("L", (iw, ih), 0); dr = ImageDraw.Draw(ref)
    dr.line(list(zip(((CX-(ox-MX*k))/k).tolist(), ((CY-(oy-MX*k))/k).tolist())),
            fill=255, width=max(1, int(round(3.4*k))), joint="curve")
    lm = np.asarray(ref) >= 96
    Dl = np.minimum(ndimage.distance_transform_edt(~lm), CAP).astype(np.float32)
    lmf = lm.astype(np.float32)
    fwd_map = fftconvolve(Dl, rm[::-1, ::-1], "valid")/T
    revS = fftconvolve(lmf, Dt[::-1, ::-1], "valid")
    Nref = fftconvolve(lmf, np.ones_like(rm, dtype=np.float32), "valid")
    good = Nref >= 0.12*T
    sc_map = np.where(good, fwd_map + revS/np.maximum(Nref, 1.0), 1e9)
    i = np.unravel_index(np.argmin(sc_map), sc_map.shape)
    if not good[i]:
        continue
    results.append((float(sc_map[i]), float(fwd_map[i]), float(revS[i]/max(Nref[i], 1)),
                    ox+int(i[0])*1-MX*k, oy+int(i[1])*1-MX*k, k, float(Nref[i])))
results.sort(key=lambda z: z[0])
print("尺度细扫（对称截断倒角，单位截图像素）")
for sc, fw, rv, cc, rr, k, N in results:
    print(f"  k={k:.2f}  score={sc:5.2f}=正{fw:5.2f}+反{rv:5.2f}  左上画布({cc:.0f},{rr:.0f})  腿px{N:.0f}")
sc, fw, rv, cc, rr, k, N = results[0]
print(f"\n>>> 最佳 k={k:.2f}  score={sc:.2f}px  正{fw:.2f} 反{rv:.2f}")

iw, ih = int(round(tw*k)), int(round(th*k))
lon_a = LON0+(x0+cc/W*span)/MLON; lat_a = LAT0+(y1-(rr/H)*(y1-y0))/MLAT
lon_b = LON0+(x0+(cc+iw)/W*span)/MLON; lat_b = LAT0+(y1-((rr+ih)/H)*(y1-y0))/MLAT
print(f"[窗口] lon {lon_a:.5f}~{lon_b:.5f}  lat {lat_b:.5f}~{lat_a:.5f}  "
      f"≈{iw*span/W/1000:.1f}x{ih*span/W/1000:.1f} km")

C = np.column_stack([CX, CY]); LL = np.column_stack([LX, LY])
m = (C[:, 0] >= cc) & (C[:, 0] <= cc+iw) & (C[:, 1] >= rr) & (C[:, 1] <= rr+ih)
Lw = LL[m]
print(f"[窗内] 顶点 {m.sum()}/{len(C)}  里程 {np.hypot(*np.diff(Lw, axis=0).T).sum()/1000:.1f} km")
geom = np.memmap(CACHE/"ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
tree = cKDTree(np.column_stack([(np.asarray(geom[:, 0], "f8")-LON0)*MLON,
                                (np.asarray(geom[:, 1], "f8")-LAT0)*MLAT]))
d, _ = tree.query(Lw, k=1)
print(f"[窗内] 到最近宽凳路段: 中位 {np.median(d):.0f} m  均值 {d.mean():.0f} m  最大 {d.max():.0f} m  "
      f">200m 占 {(d > 200).mean()*100:.0f}%  >1km 占 {(d > 1000).mean()*100:.0f}%")


def crop_white(im, cx0, cy0, w_, h_):
    out = Image.new("RGB", (w_, h_), (255, 255, 255)); cx0, cy0 = int(round(cx0)), int(round(cy0))
    sx0, sy0 = max(0, cx0), max(0, cy0)
    sx1, sy1 = min(im.size[0], cx0+w_), min(im.size[1], cy0+h_)
    if sx1 > sx0 and sy1 > sy0:
        out.paste(im.crop((sx0, sy0, sx1, sy1)), (sx0-cx0, sy0-cy0))
    return out


ref = crop_white(base, cc, rr, iw, ih)
ref = Image.blend(Image.new("RGB", (iw, ih), (255, 255, 255)), ref, 0.55)
dvr = ImageDraw.Draw(ref)
dvr.line(list(zip((CX-cc).tolist(), (CY-rr).tolist())),
         fill=(16, 130, 74), width=max(2, int(round(3.4*k))), joint="curve")
ref = ref.resize((tw, th), Image.LANCZOS)
gref = crop_white(base, cc, rr, iw, ih).resize((tw, th), Image.LANCZOS)
ov = np.asarray(ref).copy()
ov[rm] = np.array([222, 28, 8], dtype=np.uint8)
ovim = Image.fromarray(ov)

gap, lab = 12, 22
sheet = Image.new("RGB", (3*tw+4*gap, th+2*lab+2*gap), (238, 240, 244))
ds = ImageDraw.Draw(sheet); xx = gap
for name, im in [(f"主图 · 宽凳灰网 + 芦洲镇路线1（绿） k={k:.2f}", ref),
                 ("叠加你的截图红线（红）→ 形状重合、且全程无灰网", ovim),
                 ("你的截图", shot)]:
    ds.text((xx+2, gap+3), name, fill=(30, 34, 44))
    sheet.paste(im, (xx, gap+lab)); xx += tw+gap
sheet.save(OUT/"_verify_final.png")
print(f"\n[out] out/_verify_final.png {sheet.size}")
