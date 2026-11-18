# -*- coding: utf-8 -*-
"""宽凳路网「焊接断口」清单。

宽凳路网共 54 个连通分量，主片 173,296 节点（99.0%）。
其余小片即使采集了路，也因为与主片没焊上而在仿真里"无路可达"。
本脚本对每个小片，找它与主片（以及其他片）的最近节点对 —— 那多半就是
digitizing 时漏掉的一个接缝。

输出 out/kd_weld_gap.json / .csv
"""
import json, csv, math, sys
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree

sys.stdout.reconfigure(encoding="utf-8")
OUT = Path(r"D:/workspace/map_element_statistics/out")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0


def main():
    z = np.load(OUT / "_kd_graph.npz")
    xy = z["node_xy"].astype("f8")
    comp = z["comp"]; size = z["comp_size"]
    main = int(np.argmax(size))
    print(f"分量 {len(size)} 个，主片 comp{main} {int(size[main]):,} 节点 "
          f"（{100*size[main]/size.sum():.1f}%）")

    order = np.argsort(-size)
    rows = []
    for c in order:
        c = int(c)
        if c == main:
            continue
        A = xy[comp == c]
        if not len(A):
            continue
        B = xy[comp == main]
        t = cKDTree(B)
        d, i = t.query(A)
        k = int(np.argmin(d))
        ax, ay = A[k]; bx, by = B[i[k]]
        # 也找与"任意其他片"的最近距离（可能小片之间该互焊）
        rows.append(dict(comp=c, nodes=int(size[c]),
                         km_extent=round(max((A[:, 0].max()-A[:, 0].min()),
                                             (A[:, 1].max()-A[:, 1].min()))/1000, 2),
                         gap_m=round(float(d[k]), 1),
                         lon_a=LON0 + ax/MLON, lat_a=LAT0 + ay/MLAT,
                         lon_b=LON0 + bx/MLON, lat_b=LAT0 + by/MLAT,
                         cx_mid=(ax+bx)/2, cy_mid=(ay+by)/2))
    rows.sort(key=lambda r: -r["nodes"])
    print(f"\n{'comp':>5} {'节点':>6} {'片内跨度km':>10} {'离主片最近m':>11}  "
          f"{'断口坐标(lon,lat)':>26}")
    for r in rows[:16]:
        print(f"{r['comp']:>5} {r['nodes']:>6} {r['km_extent']:>10.2f} {r['gap_m']:>11.1f}  "
              f"{r['lon_a']:.6f},{r['lat_a']:.6f}")
    big = [r for r in rows if r["nodes"] >= 100]
    print(f"\n≥100 节点的孤立片 {len(big)} 个，合计 {sum(r['nodes'] for r in big):,} 节点")
    print(f"其中离主片 > 200 m 的 {sum(1 for r in big if r['gap_m'] > 200)} 个")
    print(f"离主片 ≤ 50 m 的（只差一个接缝就能焊上）"
          f" {sum(1 for r in rows if r['gap_m'] <= 50)} 个")

    json.dump(dict(main_comp=main, main_nodes=int(size[main]), rows=rows),
              open(OUT / "kd_weld_gap.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    with open(OUT / "kd_weld_gap.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)
    print("[out] out/kd_weld_gap.json / .csv")


if __name__ == "__main__":
    main()
