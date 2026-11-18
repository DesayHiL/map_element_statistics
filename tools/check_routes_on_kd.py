# -*- coding: utf-8 -*-
"""护栏断言：排班路线的每一个顶点都必须落在宽凳路网节点上。

用来固化用户 2026-10-16 的明令：
  「路线规划需要按照地图约束来做，不要再出现宽凳没有、然后排版路线有的情况了。」

做法：把 out/routes_kd.json 的每条折线（polys）顶点投影到米制，
与 out/_kd_graph.npz 的 node_xy 做最近邻；任何顶点距离 > TOL 即计为越界。

输出：out/kd_route_geom_check.json（供 audit_data.js 的 L 段读取）
退出码：越界数 > 0 → 1（CI/链式调用能直接拦住）
"""
import json, math, sys
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree

sys.stdout.reconfigure(encoding="utf-8")
OUT = Path(r"D:/workspace/map_element_statistics/out")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0
TOL = 1.0     # 米。宽凳 digitizing 接缝 ≤2m 已焊接合并成同一点，故正常应为 0。


def main():
    G = np.load(OUT / "_kd_graph.npz")
    node_xy = G["node_xy"].astype("f8")
    tree = cKDTree(node_xy)
    R = json.load(open(OUT / "routes_kd.json", encoding="utf-8"))

    n_pts = n_far = n_path = 0
    mx = 0.0
    worst = None
    for L in R["routes"]:
        for P in L["polys"]:
            P = np.asarray(P, "f8")
            if len(P) < 2:
                continue
            n_path += 1
            xy = np.column_stack([(P[:, 0] - LON0) * MLON, (P[:, 1] - LAT0) * MLAT])
            d, _ = tree.query(xy)
            n_pts += len(P)
            far = d > TOL
            n_far += int(far.sum())
            if d.max() > mx:
                mx = float(d.max())
                i = int(np.argmax(d))
                worst = dict(street=L["street"], n=L["n"], lon=float(P[i, 0]), lat=float(P[i, 1]))

    # 缺口段数一致性：routes_kd 与 kd_route_plan 必须一致
    PLAN = json.load(open(OUT / "kd_route_plan.json", encoding="utf-8"))
    plan_off = sum(1 for L in PLAN["legs"] for s in L["segs"] if s["tier"] == "offKd")

    out = dict(generated=__import__("time").strftime("%Y-%m-%d %H:%M:%S"),
               n_path=n_path, n_pts=n_pts, n_far=n_far,
               max_dev_m=round(mx, 4), tol_m=TOL, worst=worst,
               seg_on=R["seg_on"], seg_near=R["seg_near"], seg_off=R["seg_off"],
               plan_off=plan_off, km_total=round(sum(L["distKm"] for L in R["routes"]), 2),
               km_off=round(R["km_offKd"], 2))
    (OUT / "kd_route_geom_check.json").write_text(json.dumps(out, ensure_ascii=False, indent=1),
                                                  encoding="utf-8")
    print(f"折线 {n_path} 条 · 顶点 {n_pts:,} 个")
    print(f"落在宽凳节点上的容差 {TOL} m · 越界 {n_far} 个 · 最大偏差 {mx:.4f} m")
    print(f"段档位 onKd {R['seg_on']} + nearKd {R['seg_near']} + offKd {R['seg_off']} = "
          f"{R['seg_on'] + R['seg_near'] + R['seg_off']}")
    print(f"缺口段数 routes_kd {R['seg_off']} vs 状态表 {plan_off} —— {'一致' if R['seg_off'] == plan_off else '不一致！'}")
    if worst:
        print(f"最远顶点：{worst['street']} 路线{worst['n']} ({worst['lon']:.6f},{worst['lat']:.6f})")
    print(f"[out] out/kd_route_geom_check.json")
    if n_far > 0 or R["seg_off"] != plan_off:
        print("!! 存在「宽凳没有、路线却有」的顶点 —— 护栏 FAIL")
        sys.exit(1)
    print("✓ 全部顶点都落在宽凳路网上")


if __name__ == "__main__":
    main()
