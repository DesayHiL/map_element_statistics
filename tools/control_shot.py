# -*- coding: utf-8 -*-
"""对照实验：合成一张"已知是哪条腿、什么尺度"的截图，检验覆盖率匹配器是否可靠。

若匹配器连合成图都找不回 → 判据/实现有 bug（则之前"没有一条腿能覆盖"的结论不成立）。
"""
import re, json, base64, io, math, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.signal import fftconvolve

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
PREC = 10.0


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
    out = []
    while p < L:
        n = uv(); x = sv(); y = sv(); pts = [(x/PREC, y/PREC)]
        for _ in range(n-1):
            x += sv(); y += sv(); pts.append((x/PREC, y/PREC))
        out.append(np.array(pts, "f8"))
    return out


h = (OUT/"route_kuandeng_routes.html").read_text(encoding="utf-8")
RT = dec_paths(re.search(r'RTB\s*=\s*"([A-Za-z0-9+/=]+)"', h).group(1))
emb = Image.open(io.BytesIO(base64.b64decode(
    re.search(r'data:image/png;base64,([A-Za-z0-9+/=]+)', h).group(1)))).convert("RGB")
rows = json.load(open(OUT/"_offgrey_by_leg.json", encoding="utf-8"))
names = [r["name"] for r in rows]

TARGET = sys.argv[1] if len(sys.argv) > 1 else "芦洲镇路线1"
KS = float(sys.argv[2]) if len(sys.argv) > 2 else 1.5
ti = names.index(TARGET)
P = RT[ti]
tw, th = 417, 369
# 取该腿一段有形状的部分做窗口中心
mid = P[len(P)//4]
cx, cy = mid
cc0, rr0 = int(cx-tw*KS/2), int(cy-th*KS/2)
print(f"[合成] 目标 {TARGET}  k={KS}  窗口画布({cc0},{rr0})+{int(tw*KS)}x{int(th*KS)}")

big = Image.new("RGB", (int(tw*KS), int(th*KS)), (255, 255, 255))
sx0, sy0 = max(0, cc0), max(0, rr0)
sx1, sy1 = min(5200, cc0+int(tw*KS)), min(5201, rr0+int(th*KS))
if sx1 > sx0 and sy1 > sy0:
    big.paste(emb.crop((sx0, sy0, sx1, sy1)), (sx0-cc0, sy0-rr0))
d = ImageDraw.Draw(big)
d.line(list(zip((P[:, 0]-cc0).tolist(), (P[:, 1]-rr0).tolist())),
       fill=(222, 28, 8), width=max(2, int(round(3.4*KS))), joint="curve")
syn = big.resize((tw, th), Image.LANCZOS)
syn.save(OUT/"_syn_shot.png")
print(f"[合成] 存 out/_syn_shot.png  高德段长 ≈ "
      f"{np.hypot(*np.diff(P, axis=0).T).sum()*12.69/1000:.1f} km")

s = np.asarray(syn).astype(int)
rm = (s[:, :, 0] > 175) & (s[:, :, 1] < 56) & (s[:, :, 2] < 52) & \
     (s[:, :, 0]-s[:, :, 1] > 100) & (s[:, :, 0]-s[:, :, 2] > 110)
T = float(rm.sum()); print(f"[合成] 红线像素 {int(T):,}")

F = 2
res = []
for k in np.linspace(0.7, 2.6, 14):
    twk, thk = int(round(tw*k/F)), int(round(th*k/F))
    t = np.asarray(Image.fromarray((rm*255).astype(np.uint8)).resize((twk*F, thk*F), Image.BILINEAR)) > 25
    t = t[:thk*F, :twk*F].reshape(thk, F, twk, F).any(axis=(1, 3))
    Tt = float(t.sum())
    if Tt < 15:
        continue
    R = max(1, int(np.ceil(2.5*k/F)))
    for li, Q in enumerate(RT):
        xs, ys = Q[:, 0], Q[:, 1]
        pad = R+2
        x0_, x1_ = int(xs.min())-pad, int(xs.max())+pad
        y0_, y1_ = int(ys.min())-pad, int(ys.max())+pad
        iw, ih = (x1_-x0_)//F+1, (y1_-y0_)//F+1
        if iw < twk or ih < thk:
            continue
        im = Image.new("L", (iw, ih), 0); dd = ImageDraw.Draw(im)
        dd.line(list(zip(((xs-x0_)/F).tolist(), ((ys-y0_)/F).tolist())),
                fill=255, width=max(1, int(round(3.4*k/F))), joint="curve")
        m = np.asarray(im) > 0
        if m.sum() < 3:
            continue
        dil = ndimage.binary_dilation(m, iterations=R)
        B = fftconvolve(dil.astype(np.float32), t[::-1, ::-1], "valid")
        i = np.unravel_index(np.argmax(B), B.shape)
        cov = float(B[i])/Tt
        res.append((cov, li, k, x0_+(i[0]+twk//2)*F, y0_+(i[1]+thk//2)*F))
res.sort(key=lambda z: -z[0])
print("\n对照结果（前 8）：")
for cov, li, k, c1, c2 in res[:8]:
    mark = "  <<< 正确" if names[li] == TARGET else ""
    print(f"  {names[li]:<14} 覆盖 {cov*100:5.1f}%  k={k:.2f}  中心({c1},{c2}){mark}")
print(f"\n真答案 {TARGET} 的最高覆盖：" +
      f"{max(c for c,li,_,_,_ in [(c,l,k,a,b) for c,l,k,a,b in res if names[l]==TARGET]):.3f}")
