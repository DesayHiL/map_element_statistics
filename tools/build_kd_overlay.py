# -*- coding: utf-8 -*-
"""为「惠城区推荐路线」主图生成「以宽凳为限定」的 HTML 覆盖图层数据。

产出 out/_kd_overlay.json：
  ovmatch  —— 244 段走廊约束贴合后的路线几何（只用宽凳 link），绿色
  ovmiss   —— 26 段宽凳不连通段的「高德原折线」子段，红色
  stats / by_street —— 覆盖图右侧要用的口径数字

坐标系与主图完全一致（render_routes_v3.py 的 to_px），因此可以直接复用主图的
灰底 <img> 与 RT（高德折线）变量，零额外体积。
"""
import base64, json, math, sys
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree

sys.stdout.reconfigure(encoding="utf-8")
OUT = Path(r"D:/workspace/map_element_statistics/out")
W, PAD_M = 5200, 8000.0
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0
PPREC = 10.0


def to_xy(lon, lat):
    return (np.asarray(lon, "f8") - LON0) * MLON, (np.asarray(lat, "f8") - LAT0) * MLAT


# ---------- 1. 与主图逐字一致的画布范围 ----------
doc = json.load(open(OUT / "routes.json", encoding="utf-8"))
legs_all = []
for st in doc["routes"]:
    for i, r in enumerate(st.get("routes", []), start=1):
        p = np.asarray(r["poly"], "f8")
        x, y = to_xy(p[:, 0], p[:, 1])
        legs_all.append(dict(street=st["street"], n=i, A=r, xy=np.column_stack([x, y])))
rx0 = min(L["xy"][:, 0].min() for L in legs_all); rx1 = max(L["xy"][:, 0].max() for L in legs_all)
ry0 = min(L["xy"][:, 1].min() for L in legs_all); ry1 = max(L["xy"][:, 1].max() for L in legs_all)
x0, x1 = rx0 - PAD_M, rx1 + PAD_M
y0, y1 = ry0 - PAD_M, ry1 + PAD_M
span = x1 - x0
H = int(round(W * (y1 - y0) / span))
print(f"[view] W={W} H={H}")


def to_px(arr):
    return ((arr[:, 0] - x0) / span * W, (y1 - arr[:, 1]) / (y1 - y0) * H)


def enc_paths(xy_list, prec=PPREC):
    out = []

    def uv(n):
        while True:
            b = n & 0x7F; n >>= 7
            if n: out.append(b | 0x80)
            else: out.append(b); return

    def sv(v):
        uv((v << 1) if v >= 0 else ((-v << 1) - 1))

    for P in xy_list:
        if len(P) < 2: continue
        px, py = to_px(P)
        qx = np.rint(px * prec).astype("int64"); qy = np.rint(py * prec).astype("int64")
        uv(len(qx)); sv(int(qx[0])); sv(int(qy[0]))
        for a, b in zip(np.diff(qx).tolist(), np.diff(qy).tolist()):
            sv(int(a)); sv(int(b))
    return base64.b64encode(bytes(out)).decode("ascii")


# ---------- 2. 贴合路径（只用宽凳 link） ----------
G = np.load(OUT / "_kd_graph.npz")
node_xy = G["node_xy"].astype("f8")
P = np.load(OUT / "kd_corridor_paths.npz")
pn, poff = P["nodes"].astype("i8"), P["off"].astype("i8")
S = json.load(open(OUT / "kd_corridor_summary.json", encoding="utf-8"))
C = json.load(open(OUT / "kd_corridor.json", encoding="utf-8"))
tier = {(s["street"], s["n"], s["k"]): s["tier"] for s in S["segs"]}

amap = {(L["street"], L["n"]): L for L in legs_all}
mat, miss, pi = [], [], 0
km_miss = 0.0
by_street = {}
for L in C["legs"]:
    key = (L["street"], L["n"])
    rec = amap.get(key)
    if rec is None: continue
    pm_xy = to_xy(np.asarray(rec["A"]["poly"], "f8")[:, 0], np.asarray(rec["A"]["poly"], "f8")[:, 1])
    pm = np.column_stack(pm_xy)
    ancs = np.asarray([a["gcj"] for a in rec["A"]["anchors"]], "f8")
    ax, ay = to_xy(ancs[:, 0], ancs[:, 1]); am = np.column_stack([ax, ay])
    ptree = cKDTree(pm)
    cut, lo = [], 0
    for k in range(len(am)):
        dd, ii = ptree.query(am[k], k=min(len(pm), 200))
        ii = np.atleast_1d(ii)[np.atleast_1d(ii) >= lo]
        idx = int(ii[0]) if len(ii) else int(np.atleast_1d(ptree.query(am[k])[1]))
        cut.append(idx); lo = idx
    cut = np.array(cut)
    for s in L["segs"]:
        k = s["k"]
        if s["ok"]:
            path = node_xy[pn[poff[pi]:poff[pi + 1]]]
            pi += 1
            if len(path) >= 2: mat.append(path)
        else:
            sub = pm[cut[k]:cut[k + 1] + 1]
            if len(sub) < 2: sub = np.stack([am[k], am[k + 1]])
            mile = float(np.hypot(*np.diff(sub, axis=0).T).sum()) / 1000.0
            km_miss += mile
            by_street[L["street"]] = by_street.get(L["street"], 0.0) + mile
            if len(sub) >= 2: miss.append(sub)
print(f"[match] {len(mat)} 段贴合路径   [miss] {len(miss)} 段宽凳不连通 {km_miss:.1f} km  (path idx {pi}/{len(poff)-1})")
assert pi == len(poff) - 1, f"路径段数对不上 {pi} vs {len(poff)-1}"

ovmatch, ovmiss = enc_paths(mat), enc_paths(miss)
st = json.load(open(OUT / "route_kuandeng_routes.json", encoding="utf-8"))["stats"]
rank = sorted(by_street.items(), key=lambda x: -x[1])
data = dict(
    ovmatch=ovmatch, ovmiss=ovmiss, prec=PPREC,
    ok_legs=C["ok_legs"], n_legs=len(C["legs"]),
    ok_segs=C["ok_segs"], n_segs=C["nseg"],
    km_amap=C["km_amap_tot"], km_corr=C["km_corr_tot"],
    km_miss=round(km_miss, 1), n_miss_seg=len(miss),
    tiers={k: S["seg_tier"][k] for k in S["seg_tier"]},
    km_amap_ok=S["km_amap_ok"], km_corr_ok=S["km_corr_ok"],
    by_street=[dict(street=a, km=round(b, 1)) for a, b in rank],
    route_km=st["route_km"],
)
json.dump(data, open(OUT / "_kd_overlay.json", "w", encoding="utf-8"), ensure_ascii=False)
print(f"[enc] 贴合 {len(ovmatch)/1024:.0f} KB / 缺失 {len(ovmiss)/1024:.0f} KB")
print(f"[stat] 腿 {C['ok_legs']}/{len(C['legs'])}  段 {C['ok_segs']}/{C['nseg']}  "
      f"高德 {C['km_amap_tot']:.1f} → 贴合 {C['km_corr_tot']:.1f} km")
print("按镇缺失:", "  ".join(f"{a} {b}" for a, b in rank[:6]))
print("[out] out/_kd_overlay.json")
