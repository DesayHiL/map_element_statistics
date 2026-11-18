# -*- coding: utf-8 -*-
"""以宽凳为标准：算出高德路线在宽凳上"查不到"的每一段（补测需求清单）。

逐点计算高德 polyline 每个顶点到最近宽凳顶点的距离；把 d > THR 的连续顶点并成"缺失段"，
记录起止经纬度、长度、所属街道/腿。按长度降序聚类输出。

输出：out/kd_gap_list.csv（缺失段清单）、控制台汇总
"""
import json, math, sys
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree

sys.stdout.reconfigure(encoding="utf-8")
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")
OUT = Path("out")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0
THR = 30.0
MIN_RUN = 100.0     # 只登记 > 100 m 的缺失段


def to_m(lon, lat):
    return np.stack([(lon - LON0) * MLON, (lat - LAT0) * MLAT], axis=-1)


fx = np.load(CACHE / "ROAD_LINK.fixed.npy", mmap_mode="r")
gn = np.asarray(fx["geom_n"], dtype="i4")
geom = np.memmap(CACHE / "ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
vxy = to_m(np.asarray(geom[:, 0]), np.asarray(geom[:, 1]))
vtree = cKDTree(vxy)
print(f"[宽凳顶点] {len(vxy):,}")

RJSON = json.load(open(OUT / "routes.json", encoding="utf-8"))
legs = {}
for d in RJSON["routes"]:
    for i, lg in enumerate(d.get("routes", []), start=1):
        legs[(d["street"], i)] = lg

rows = []
tot_pts = tot_len = tot_off = 0.0
for (st, no), lg in sorted(legs.items()):
    poly = np.asarray(lg["poly"], dtype="f8")
    P = to_m(poly[:, 0], poly[:, 1])
    seg = np.hypot(*np.diff(P, axis=0).T)              # 每小段长度
    d, _ = vtree.query(P)                              # 每点到最近宽凳顶点
    s = seg.sum(); tot_len += s / 1000.0
    tot_pts += len(P)
    tot_off += float(seg[d[:-1] > THR].sum()) / 1000.0
    # 连续 d>THR 的段
    bad = d > THR
    i = 0
    while i < len(bad):
        if not bad[i]:
            i += 1; continue
        j = i
        while j + 1 < len(bad) and bad[j + 1]:
            j += 1
        L = float(seg[i:j].sum())
        if L >= MIN_RUN:
            mid = (i + j) // 2
            rows.append(dict(street=st, leg=no, km=round(L / 1000.0, 3),
                             n_pts=j - i + 1, max_off=round(float(d[i:j + 1].max()), 1),
                             lon_s=round(poly[i, 0], 6), lat_s=round(poly[i, 1], 6),
                             lon_e=round(poly[j, 0], 6), lat_e=round(poly[j, 1], 6),
                             lon_mid=round(poly[mid, 0], 6), lat_mid=round(poly[mid, 1], 6)))
        i = j + 1

import csv
with open(OUT / "kd_gap_list.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)

print(f"\n高德路线总长 {tot_len:.1f} km / {int(tot_pts):,} 顶点")
print(f"距离最近宽凳顶点 > {THR:.0f} m 的里程 {tot_off:.1f} km（占 {100*tot_off/tot_len:.1f}%）")
print(f"> {MIN_RUN:.0f} m 的连续缺失段 {len(rows)} 处，合计 {sum(r['km'] for r in rows):.1f} km")

print("\n=== 缺失段最长的 20 处 ===")
print(f"{'街道':<8}{'腿':>3} {'长度':>8}{'最大偏离':>9}  中点经纬度")
for r in sorted(rows, key=lambda r: -r["km"])[:20]:
    print(f"{r['street']:<8}{r['leg']:>3} {r['km']*1000:>7.0f}m{r['max_off']:>8.0f}m  "
          f"{r['lon_mid']:.6f},{r['lat_mid']:.6f}")

print("\n=== 按街道汇总 ===")
agg = {}
for r in rows:
    a = agg.setdefault(r["street"], [0, 0.0])
    a[0] += 1; a[1] += r["km"]
for st, (c, k) in sorted(agg.items(), key=lambda x: -x[1][1]):
    print(f"  {st:<8} {c:>3} 处  {k:>7.1f} km")
