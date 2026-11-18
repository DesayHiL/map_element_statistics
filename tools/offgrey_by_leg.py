# -*- coding: utf-8 -*-
"""独立核验：在主图自己的画布坐标系里，量测 52 条排班路线离开灰网(宽凳)的里程。

不依赖任何投影假设：灰底栅格与路线折线同在 5200x5201 画布坐标下。
输出：逐腿/逐街道的离开灰网里程、占比，并列出最严重的腿。
"""
import re, json, base64, math
from pathlib import Path
import numpy as np
from PIL import Image
import io

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
emb = Image.open(io.BytesIO(base64.b64decode(re.search(
    r'data:image/png;base64,([A-Za-z0-9+/=]+)', h).group(1)))).convert("RGB")
G = np.asarray(emb).astype(int)
gm = G.sum(axis=2) < 700
print(f"[raster] {emb.size}  灰像素 {int(gm.sum()):,}")
from scipy import ndimage
edt = ndimage.distance_transform_edt(~gm)

# 腿名（按 decode_rt 的配对顺序：RT 与 routes.json 一一对应）
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
M_PER_CANVAS_PX = span / W

names = []
cjson = []
for st in doc["routes"]:
    for i, r in enumerate(st["routes"], start=1):
        P = np.asarray(r["poly"], "f8")
        X = (P[:, 0]-LON0)*MLON; Y = (P[:, 1]-LAT0)*MLAT
        cjson.append((f"{st['street']}路线{i}",
                      np.column_stack([(X-x0)/span*W, (y1-Y)/(y1-y0)*Hh])))
used = set()
for P in RT:
    best = None
    for j, (n, Q) in enumerate(cjson):
        if j in used:
            continue
        d = math.hypot(P[0, 0]-Q[0, 0], P[0, 1]-Q[0, 1]) + math.hypot(P[-1, 0]-Q[-1, 0], P[-1, 1]-Q[-1, 1])
        if best is None or d < best[0]:
            best = (d, j, n)
    used.add(best[1]); names.append(best[2])

print(f"[RT] {len(RT)} 条;  1 画布px = {M_PER_CANVAS_PX:.2f} m")
rows = []
for name, P in zip(names, RT):
    seg = np.hypot(*np.diff(P, axis=0).T)
    L = seg.sum()*M_PER_CANVAS_PX
    n = max(2, int(seg.sum()))
    u = np.linspace(0, seg.sum(), n)
    s = np.concatenate([[0], np.cumsum(seg)])
    xx = np.interp(u, s, P[:, 0]); yy = np.interp(u, s, P[:, 1])
    dd = edt[np.clip(np.round(yy).astype(int), 0, edt.shape[0]-1),
             np.clip(np.round(xx).astype(int), 0, edt.shape[1]-1)]*M_PER_CANVAS_PX
    w = np.gradient(u)*M_PER_CANVAS_PX
    rows.append(dict(name=name, km=L/1000.0,
                     off50=float((w*(dd > 50)).sum()/1000),
                     off200=float((w*(dd > 200)).sum()/1000),
                     off1000=float((w*(dd > 1000)).sum()/1000),
                     dmed=float(np.median(dd))))
tot = sum(r["km"] for r in rows)
print(f"\n=== 52 条腿合计 高德里程 {tot:.1f} km ===")
print(f"  离灰网 >50m   {sum(r['off50'] for r in rows):6.1f} km  ({100*sum(r['off50'] for r in rows)/tot:.1f}%)")
print(f"  离灰网 >200m  {sum(r['off200'] for r in rows):6.1f} km  ({100*sum(r['off200'] for r in rows)/tot:.1f}%)")
print(f"  离灰网 >1km   {sum(r['off1000'] for r in rows):6.1f} km  ({100*sum(r['off1000'] for r in rows)/tot:.1f}%)")

print("\n=== 离开灰网(>200m) 里程最多的 15 条腿 ===")
for r in sorted(rows, key=lambda z: -z["off200"])[:15]:
    print(f"  {r['name']:<14} 总长{r['km']:6.1f}  离网>200m {r['off200']:6.1f} ({100*r['off200']/r['km']:5.1f}%)"
          f"  >1km {r['off1000']:6.1f}  中位距离 {r['dmed']:7.0f} m")

from collections import defaultdict
byst = defaultdict(lambda: [0.0, 0.0])
for r in rows:
    st = re.sub(r'路线\d+$', '', r["name"])
    byst[st][0] += r["km"]; byst[st][1] += r["off200"]
print("\n=== 按镇街 ===")
for st, (km, off) in sorted(byst.items(), key=lambda z: -z[1][1]):
    print(f"  {st:<8} 总长{km:7.1f}  离网>200m {off:7.1f} km ({100*off/km:5.1f}%)")

json.dump(rows, open(OUT/"_offgrey_by_leg.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"\n[out] out/_offgrey_by_leg.json")
