# -*- coding: utf-8 -*-
"""把「宽凳无数据」的路段按「离最近宽凳道路多远」分档。

目的：区分两类性质完全不同的情况
  A 类 区域空白   : 最近宽凳道路 >2000m —— 这个片区宽凳根本没测（如芦洲镇）
  B 类 路网稀疏   : 200~2000m           —— 片区有主干路网，排班走的乡道/村道宽凳没测
  C 类 邻近错位   : 20~200m             —— 旁边就有宽凳路，但这条具体道路没测（或错位/上下层）
  D 类 在网内     : <=20m               —— 宽凳有这条路，可正常比对
输出 out/_offclass.json + 控制台表
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

OUT = Path(r"D:/workspace/map_element_statistics/out")
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")
R = 20.0
STEP = 4.0
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0))
MLAT = 110574.0


def to_xy(lo, la):
    return (np.asarray(lo, "f8") - LON0) * MLON, (np.asarray(la, "f8") - LAT0) * MLAT


def resample(P, step):
    seg = np.hypot(np.diff(P[:, 0]), np.diff(P[:, 1]))
    tot = float(seg.sum())
    if tot <= 0:
        return P[:1]
    n = int(math.ceil(tot / step)) + 1
    s = np.linspace(0, tot, n)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    return np.column_stack([np.interp(s, cum, P[:, 0]), np.interp(s, cum, P[:, 1])])


def main():
    fixed = np.load(CACHE / "ROAD_LINK.fixed.npy", mmap_mode="r")
    geom = np.memmap(CACHE / "ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
    goff = np.asarray(fixed["geom_off"], "i8") // 16
    gn = np.asarray(fixed["geom_n"], "i4")
    parts = []
    for i in range(len(gn)):
        n = int(gn[i])
        if n < 2:
            continue
        o = int(goff[i])
        x, y = to_xy(geom[o:o + n, 0], geom[o:o + n, 1])
        parts.append(resample(np.column_stack([x, y]), 6.0))
    net = np.vstack(parts)
    print("net samples", len(net))
    tree = cKDTree(net)

    doc = json.loads((OUT / "routes.json").read_text(encoding="utf-8"))
    step_km = STEP / 1000.0
    bands = {"D_在网内": 0.0, "C_20_200m": 0.0, "B_200_2000m": 0.0, "A_超2km": 0.0}
    total = 0.0
    per_leg, per_street = [], {}
    for st in doc["routes"]:
        for ri, r in enumerate(st["routes"]):
            P = np.asarray(r["poly"], "f8")
            x, y = to_xy(P[:, 0], P[:, 1])
            S = resample(np.column_stack([x, y]), STEP)
            d, _ = tree.query(S, k=1, distance_upper_bound=1e9)
            km = len(S) * step_km
            b = {
                "D_在网内": float((d <= R).sum() * step_km),
                "C_20_200m": float(((d > R) & (d <= 200)).sum() * step_km),
                "B_200_2000m": float(((d > 200) & (d <= 2000)).sum() * step_km),
                "A_超2km": float((d > 2000).sum() * step_km),
            }
            for k in bands:
                bands[k] += b[k]
            total += km
            per_leg.append({"street": st["street"], "n": ri + 1, "km": round(km, 1),
                            "med_m": round(float(np.median(d)), 0), **{k: round(v, 1) for k, v in b.items()}})
            s = per_street.setdefault(st["street"], {k: 0.0 for k in bands})
            for k in bands:
                s[k] += b[k]

    print(f"\n=== 52 条路线 {total:.1f} km 按「离最近宽凳道路距离」分档 ===")
    for k, v in bands.items():
        print(f"  {k:<12} {v:8.1f} km   {v/total*100:5.1f}%")
    print(f"  {'合计':<12} {sum(bands.values()):8.1f} km")

    print("\n=== A 类（>2km 真·区域空白）最多的 12 条腿 ===")
    a = sorted([p for p in per_leg if p["A_超2km"] > 0.5], key=lambda p: -p["A_超2km"])
    print(f"{'街道':<10}{'#':>3}{'总km':>8}{'中位距m':>9}{'A>2km':>9}{'B200-2k':>9}{'C20-200':>9}")
    for p in a[:12]:
        print(f"{p['street']:<10}{p['n']:>3}{p['km']:>8.1f}{p['med_m']:>9.0f}"
              f"{p['A_超2km']:>9.1f}{p['B_200_2000m']:>9.1f}{p['C_20_200m']:>9.1f}")

    print("\n=== 各街道分档 ===")
    print(f"{'街道':<10}{'总km':>8}{'在网内':>9}{'C 20-200':>10}{'B 200-2k':>10}{'A >2km':>9}")
    for k, v in sorted(per_street.items(), key=lambda kv: -kv[1]['A_超2km']):
        tot = sum(v.values())
        print(f"{k:<10}{tot:>8.1f}{v['D_在网内']:>9.1f}{v['C_20_200m']:>10.1f}"
              f"{v['B_200_2000m']:>10.1f}{v['A_超2km']:>9.1f}")

    (OUT / "_offclass.json").write_text(json.dumps(
        {"bands": {k: round(v, 1) for k, v in bands.items()}, "total_km": round(total, 1),
         "per_leg": per_leg,
         "per_street": {k: {kk: round(vv, 1) for kk, vv in v.items()} for k, v in per_street.items()}},
        ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n[saved] out/_offclass.json")


if __name__ == "__main__":
    main()
