# -*- coding: utf-8 -*-
"""非等比尺度匹配：允许 kx != ky（截图可能被纵向压缩过）。

对照实验已证明判据可靠，但等比尺度下无一条腿能覆盖真实截图。
若截图经过非等比缩放，等比搜索会系统性失配 —— 本脚本专门检验该假设。
"""
import re, json, base64, io
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.signal import fftconvolve

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
PREC = 10.0
SHOT = r"C:/Users/uid06419/.workbuddy/clipboard-images/clipboard-2026-10-15T11-10-21-069Z-25e3f377.png"


def dec_paths(b64):
    s = base64.b64decode(b64); L = len(s); p = 0
    def uv():
        nonlocal p
        r = 0; sh = 1
        while True:
            b = s[p]; p += 1; r += (b & 127)*sh; sh *= 128
            if not (b & 128):
                break
        return r
    def sv():
        u = uv(); return -((u+1)//2) if (u & 1) else (u//2)
    o = []
    while p < L:
        n = uv(); x = sv(); y = sv(); q = [(x/PREC, y/PREC)]
        for _ in range(n-1):
            x += sv(); y += sv(); q.append((x/PREC, y/PREC))
        o.append(np.array(q, "f8"))
    return o


h = (OUT/"route_kuandeng_routes.html").read_text(encoding="utf-8")
RT = dec_paths(re.search(r'RTB\s*=\s*"([A-Za-z0-9+/=]+)"', h).group(1))
rows = json.load(open(OUT/"_offgrey_by_leg.json", encoding="utf-8"))
names = [r["name"] for r in rows]
cand = [r["name"] for r in sorted(rows, key=lambda z: -z["off200"])[:8]]
idx = {n: i for i, n in enumerate(names)}

s = np.asarray(Image.open(SHOT).convert("RGB")).astype(int)
rm = (s[:, :, 0] > 175) & (s[:, :, 1] < 56) & (s[:, :, 2] < 52) & \
     (s[:, :, 0]-s[:, :, 1] > 100) & (s[:, :, 0]-s[:, :, 2] > 110)
th, tw = rm.shape
T = float(rm.sum())
F = 2
best = []
for kx in (0.8, 1.0, 1.25, 1.5, 1.8, 2.1):
    for ky in (0.7, 0.9, 1.1, 1.3, 1.6):
        twk, thk = max(4, int(round(tw*kx/F))), max(4, int(round(th*ky/F)))
        t = np.asarray(Image.fromarray((rm*255).astype(np.uint8)).resize(
            (twk*F, thk*F), Image.BILINEAR)) > 25
        t = t[:thk*F, :twk*F].reshape(thk, F, twk, F).any(axis=(1, 3))
        Tt = float(t.sum())
        if Tt < 15:
            continue
        R = max(1, int(np.ceil(2.0/F)))
        for n in cand:
            Q = RT[idx[n]]
            xs, ys = Q[:, 0], Q[:, 1]
            x0_, x1_ = int(xs.min())-4, int(xs.max())+4
            y0_, y1_ = int(ys.min())-4, int(ys.max())+4
            iw, ih = (x1_-x0_)//F+1, (y1_-y0_)//F+1
            if iw < twk or ih < thk:
                continue
            im = Image.new("L", (iw, ih), 0); d = ImageDraw.Draw(im)
            d.line(list(zip(((xs-x0_)/F).tolist(), ((ys-y0_)/F).tolist())),
                   fill=255, width=max(1, int(round(3.4*(kx+ky)/2/F))), joint="curve")
            m = np.asarray(im) > 0
            if m.sum() < 3:
                continue
            dil = ndimage.binary_dilation(m, iterations=R)
            B = fftconvolve(dil.astype(np.float32), t[::-1, ::-1], "valid")
            i = np.unravel_index(np.argmax(B), B.shape)
            best.append((float(B[i])/Tt, n, kx, ky, x0_+(i[0]+twk//2)*F, y0_+(i[1]+thk//2)*F))
best.sort(reverse=True)
print("非等比尺度搜索（kx,ky 独立）前 12：")
seen = {}
for cov, n, kx, ky, a, b in best:
    if n in seen and len(seen) > 5:
        continue
    seen[n] = 1
    print(f"  {n:<14} 覆盖 {cov*100:5.1f}%  kx={kx:.2f} ky={ky:.2f}  中心({a},{b})")
    if len(seen) >= 12:
        break
