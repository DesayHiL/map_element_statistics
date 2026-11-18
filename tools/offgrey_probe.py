# -*- coding: utf-8 -*-
"""把"离灰网最严重"的若干条腿的最长连续离网段渲染出来，与截图并排，人工确认出处。

窗口 = 417x369 画布px (k=1) 与 1.4 倍，居中于该腿最长连续无灰网段的中间点。
"""
import re, json, base64, math, io
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
SHOT = r"C:/Users/uid06419/.workbuddy/clipboard-images/clipboard-2026-10-15T11-10-21-069Z-25e3f377.png"

h = (OUT/"route_kuandeng_routes.html").read_text(encoding="utf-8")
emb = Image.open(io.BytesIO(base64.b64decode(
    re.search(r'data:image/png;base64,([A-Za-z0-9+/=]+)', h).group(1)))).convert("RGB")
G = np.asarray(emb).astype(int)
edt = ndimage.distance_transform_edt(~(G.sum(axis=2) < 700))*12.69     # 米

rows = json.load(open(OUT/"_offgrey_by_leg.json", encoding="utf-8"))
RT = np.load(OUT/"_rt_paths.npy", allow_pickle=True)

# 重新按 decode_rt 的配对建立 name->index
import importlib.util
doc = json.loads((OUT/"routes.json").read_text(encoding="utf-8"))
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0*math.cos(math.radians(LAT0)); MLAT = 110574.0
W, PAD_M = 5200, 8000.0
xs = []; ys = []
for st in doc["routes"]:
    for r in st["routes"]:
        P = np.asarray(r["poly"], "f8")
        xs.append((P[:, 0]-LON0)*MLON); ys.append((P[:, 1]-LAT0)*MLAT)
x0 = min(a.min() for a in xs)-PAD_M; x1 = max(a.max() for a in xs)+PAD_M
y0 = min(a.min() for a in ys)-PAD_M; y1 = max(a.max() for a in ys)+PAD_M
span = x1-x0; Hh = int(round(W*(y1-y0)/span))
cjson = []
for st in doc["routes"]:
    for i, r in enumerate(st["routes"], start=1):
        P = np.asarray(r["poly"], "f8")
        X = (P[:, 0]-LON0)*MLON; Y = (P[:, 1]-LAT0)*MLAT
        cjson.append((f"{st['street']}路线{i}",
                      np.column_stack([(X-x0)/span*W, (y1-Y)/(y1-y0)*Hh])))
used = set(); nm = []
for P in RT:
    best = None
    for j, (n, Q) in enumerate(cjson):
        if j in used:
            continue
        d = math.hypot(P[0, 0]-Q[0, 0], P[0, 1]-Q[0, 1]) + math.hypot(P[-1, 0]-Q[-1, 0], P[-1, 1]-Q[-1, 1])
        if best is None or d < best[0]:
            best = (d, j, n)
    used.add(best[1]); nm.append(best[2])
idx = {n: i for i, n in enumerate(nm)}

shot = Image.open(SHOT).convert("RGB"); th, tw = shot.size[1], shot.size[0]

# 每条腿的最长连续离网(>200m)段
def longest_off(P):
    s = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
    n = max(2, int(s[-1]))
    u = np.linspace(0, s[-1], n)
    xx = np.interp(u, s, P[:, 0]); yy = np.interp(u, s, P[:, 1])
    dd = edt[np.clip(np.round(yy).astype(int), 0, edt.shape[0]-1),
             np.clip(np.round(xx).astype(int), 0, edt.shape[1]-1)]
    off = dd > 200
    best = (0, 0)
    i = 0
    while i < n:
        if off[i]:
            j = i
            while j+1 < n and off[j+1]:
                j += 1
            if u[j]-u[i] > best[0]:
                best = (u[j]-u[i], (i+j)//2)
            i = j+1
        else:
            i += 1
    return best, np.column_stack([xx, yy])

cand = [r for r in sorted(rows, key=lambda z: -z["off200"])[:8]]
tiles = []
for r in cand:
    P = RT[idx[r["name"]]]
    (L, mid), S = longest_off(P)
    cx, cy = S[mid]
    for k in (1.0, 1.4):
        iw, ih = int(tw*k), int(th*k)
        out = Image.new("RGB", (iw, ih), (255, 255, 255))
        cc0, rr0 = int(cx-iw/2), int(cy-ih/2)
        sx0, sy0 = max(0, cc0), max(0, rr0)
        sx1, sy1 = min(emb.size[0], cc0+iw), min(emb.size[1], rr0+ih)
        if sx1 > sx0 and sy1 > sy0:
            out.paste(emb.crop((sx0, sy0, sx1, sy1)), (sx0-cc0, sy0-rr0))
        d = ImageDraw.Draw(out)
        d.line(list(zip((P[:, 0]-cc0).tolist(), (P[:, 1]-rr0).tolist())),
               fill=(222, 28, 8), width=max(2, int(round(1.7*k*2))), joint="curve")
        out = out.resize((tw, th), Image.LANCZOS)
        tiles.append((f"{r['name']}  最长离网段 {L*12.69/1000:.1f} km  k={k}", out))

gap, lab = 10, 20
n = len(tiles)+1; cols = 4; rr = (n+cols-1)//cols
sheet = Image.new("RGB", (cols*(tw+gap)+gap, rr*(th+lab+gap)+gap), (238, 240, 244))
ds = ImageDraw.Draw(sheet)
for i, (name, im) in enumerate(tiles+[("→ 你的截图", shot)]):
    a, b = divmod(i, cols)
    ox = gap+a*(tw+gap); oy = gap+b*(th+lab+gap)
    ds.text((ox+2, oy+3), name[:52], fill=(30, 34, 44))
    sheet.paste(im, (ox, oy+lab))
sheet.save(OUT/"_offgrey_probe.png")
print(f"[out] out/_offgrey_probe.png {sheet.size}")
for r in cand:
    P = RT[idx[r["name"]]]
    (L, mid), _ = longest_off(P)
    print(f"  {r['name']:<14} 最长连续离网段 {L*12.69/1000:6.1f} km  总离网>200m {r['off200']:6.1f} km")
