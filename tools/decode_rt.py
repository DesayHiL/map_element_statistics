# -*- coding: utf-8 -*-
"""解析主图内嵌 RTB（Δ+varint+base64）→ 画布折线，并与 routes.json 比对。

然后直接用 RT（主图真实几何）做截图覆盖率匹配，排除"json 与 html 不一致"的干扰。
"""
import re, json, base64, math
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0*math.cos(math.radians(LAT0)); MLAT = 110574.0
W, PAD_M = 5200, 8000.0
PREC = 10.0


def dec_paths(b64):
    s = base64.b64decode(b64)
    L = len(s); p = 0
    def uv():
        nonlocal p
        r = 0; sh = 1
        while True:
            b = s[p]; p += 1
            r += (b & 127)*sh; sh *= 128
            if not (b & 128):
                break
        return r
    def sv():
        u = uv()
        return -((u+1)//2) if (u & 1) else (u//2)
    out = []
    while p < L:
        n = uv(); x = sv(); y = sv()
        pts = [(x/PREC, y/PREC)]
        for _ in range(1, n):
            x += sv(); y += sv()
            pts.append((x/PREC, y/PREC))
        out.append(np.array(pts, "f8"))
    return out


h = (OUT/"route_kuandeng_routes.html").read_text(encoding="utf-8")
m = re.search(r'RTB\s*=\s*"([A-Za-z0-9+/=]+)"', h)
RT = dec_paths(m.group(1))
print(f"[RT] 主图内嵌 {len(RT)} 条折线  顶点合计 {sum(len(p) for p in RT):,}")
allp = np.concatenate(RT)
print(f"[RT] x {allp[:,0].min():.0f}~{allp[:,0].max():.0f}  y {allp[:,1].min():.0f}~{allp[:,1].max():.0f}")

doc = json.loads((OUT/"routes.json").read_text(encoding="utf-8"))
legs = []
for st in doc["routes"]:
    for i, r in enumerate(st.get("routes", []), start=1):
        P = np.asarray(r["poly"], "f8")
        legs.append((f"{st['street']}路线{i}", P))
print(f"[json] {len(legs)} 条腿")

xs = []; ys = []
for _, P in legs:
    xs.append((P[:, 0]-LON0)*MLON); ys.append((P[:, 1]-LAT0)*MLAT)
x0 = min(a.min() for a in xs)-PAD_M; x1 = max(a.max() for a in xs)+PAD_M
y0 = min(a.min() for a in ys)-PAD_M; y1 = max(a.max() for a in ys)+PAD_M
span = x1-x0; H = int(round(W*(y1-y0)/span))


def to_canvas(P):
    X = (P[:, 0]-LON0)*MLON; Y = (P[:, 1]-LAT0)*MLAT
    return np.column_stack([(X-x0)/span*W, (y1-Y)/(y1-y0)*H])


# 逐条比对（用包围盒+长度找对应）
print("\n=== 主图 RT 与 routes.json 的逐条比对（按起点+长度配对） ===")
cjson = [(n, to_canvas(P)) for n, P in legs]
used = set()
worst = []
for i, P in enumerate(RT):
    bbox = (P[:, 0].min(), P[:, 0].max(), P[:, 1].min(), P[:, 1].max())
    best = None
    for j, (n, Q) in enumerate(cjson):
        if j in used:
            continue
        d = math.hypot(P[0, 0]-Q[0, 0], P[0, 1]-Q[0, 1]) + math.hypot(P[-1, 0]-Q[-1, 0], P[-1, 1]-Q[-1, 1])
        if best is None or d < best[0]:
            best = (d, j, n)
    if best and best[0] < 60:
        used.add(best[1])
        worst.append((best[0], i, best[2]))
    else:
        print(f"  RT#{i:3d} 无对应  端点距离 {best[0] if best else -1:.0f}px  顶点{len(P)}  "
              f"起点({P[0,0]:.0f},{P[0,1]:.0f})")
worst.sort(reverse=True)
print(f"  匹配上 {len(used)}/{len(RT)} 条；端点距离最大 5 例:")
for d, i, n in worst[:5]:
    print(f"    RT#{i} ↔ {n}  端点差 {d:.1f}px")

np.save(OUT/"_rt_paths.npy", np.array([p for p in RT], dtype=object), allow_pickle=True)
print(f"\n[out] out/_rt_paths.npy  共 {len(RT)} 条")
