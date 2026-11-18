# -*- coding: utf-8 -*-
"""决定性复核：26 个「走廊内接不上」的段，在全图（不限走廊）上求最短路，
再量这条最短路与原高德子折线的贴合度。

   若最短路全程贴着原轨迹（平均偏离 ≤ 30 m）且里程比 ≈ 1
        -> 宽凳明明有这条路，是「走廊子图」把它切碎了（判据缺陷，段其实可用）
   若最短路绕远 / 偏离大
        -> 真的需要改道或本来就没路

输出 out/kd_free_check.json
"""
import json, math, sys
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix, csr_matrix
from scipy.sparse.csgraph import dijkstra

sys.stdout.reconfigure(encoding="utf-8")
OUT = Path(r"D:/workspace/map_element_statistics/out")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0


def to_m(lon, lat):
    return np.stack([(np.asarray(lon, "f8") - LON0) * MLON,
                     (np.asarray(lat, "f8") - LAT0) * MLAT], axis=-1)


def main():
    G = np.load(OUT / "_kd_graph.npz")
    nxy = G["node_xy"].astype("f8")
    eu, ev = G["eu"].astype("i8"), G["ev"].astype("i8")
    elen = G["elen"].astype("f8"); M = len(nxy)
    W = np.concatenate([elen, elen])
    GG = csr_matrix(coo_matrix((W, (np.concatenate([eu, ev]), np.concatenate([ev, eu]))),
                              shape=(M, M)))
    GG.sum_duplicates()
    ntree = cKDTree(nxy)
    print(f"[graph] {M:,} 节点 {GG.nnz:,} 有向边")

    RJSON = json.load(open(OUT / "routes.json", encoding="utf-8"))
    amap = {}
    for d in RJSON["routes"]:
        for i, lg in enumerate(d.get("routes", []), start=1):
            amap[(d["street"], i)] = lg
    rows = json.load(open(OUT / "kd_plan_attrib.json", encoding="utf-8"))["rows"]

    print(f"\n{'归因':<9}{'镇街':<7}{'腿':>3}{'段':>3} {'原km':>7} {'短路km':>7} {'比':>5} "
          f"{'平均偏离':>8} {'p90':>7} {'max':>8} {'结论'}")
    out = []
    for r in rows:
        A = amap[(r["street"], r["n"])]
        pm = to_m(np.asarray(A["poly"], "f8")[:, 0], np.asarray(A["poly"], "f8")[:, 1])
        am = to_m(np.asarray([a["gcj"] for a in A["anchors"]], "f8")[:, 0],
                  np.asarray([a["gcj"] for a in A["anchors"]], "f8")[:, 1])
        ptree = cKDTree(pm)
        cutl, lo = [], 0
        for k in range(len(am)):
            dd, ii = ptree.query(am[k], k=min(len(pm), 200))
            ii = np.atleast_1d(ii)[np.atleast_1d(ii) >= lo]
            cutl.append(int(ii[0]) if len(ii) else int(np.atleast_1d(ptree.query(am[k])[1])))
            lo = cutl[-1]
        cut = np.array(cutl)
        sub = pm[cut[r["k"]]:cut[r["k"] + 1] + 1]
        if len(sub) < 2:
            sub = np.stack([am[r["k"]], am[r["k"] + 1]])
        La = float(np.hypot(*np.diff(sub, axis=0).T).sum())

        da, ia = ntree.query(am[r["k"]]); db, ib = ntree.query(am[r["k"] + 1])
        dist, pred = dijkstra(GG, directed=False, indices=int(ia), return_predecessors=True)
        dd = float(dist[ib])
        if not np.isfinite(dd):
            print(f"{r['cls']:<9}{r['street']:<7}{r['n']:>3}{r['k']:>3} {La/1000:>7.2f} "
                  f"{'——':>7} {'':>5} {'':>8} {'':>7} {'':>8} 不可达")
            out.append(dict(**{k: v for k, v in r.items() if k != "ratio"},
                            km_free=None, free_ratio=None, dev=None, concl="不可达"))
            continue
        p = [int(ib)]
        while p[-1] != int(ia) and len(p) < M + 2:
            p.append(int(pred[p[-1]]))
        p = np.asarray(p[::-1], "i8")
        # 关键：路径节点 → 沿 link 折线细化（用节点坐标即可，节点是端点）
        path_xy = nxy[p]
        # 双向距离
        d1, _ = ptree.query(path_xy)          # 路径点在原轨迹上的最近距离
        # 原轨迹到路径的最近距离
        ptree2 = cKDTree(path_xy)
        d2, _ = ptree2.query(sub)
        dev_mean = float(np.mean(np.minimum(d1, 1e9)))
        # 沿路径按弧长采样，剔除"节点间长直线"的假象：用 link 几何插值
        devs = d1
        p90 = float(np.percentile(devs, 90)); mx = float(devs.max())
        ratio = dd / max(La, 1e-6)
        if dev_mean <= 30 and ratio <= 1.30:
            concl = "■ 段可用（判据误判）"
        elif dev_mean <= 60 and ratio <= 1.60:
            concl = "△ 可改道，略绕"
        else:
            concl = "× 需绕行/真无路"
        print(f"{r['cls']:<9}{r['street']:<7}{r['n']:>3}{r['k']:>3} {La/1000:>7.2f} "
              f"{dd/1000:>7.2f} {ratio:>5.2f} {dev_mean:>8.1f} {p90:>7.1f} {mx:>8.1f} {concl}")
        out.append(dict(**{k: v for k, v in r.items() if k != "ratio"},
                        km_free=round(dd / 1000, 3), free_ratio=round(ratio, 3),
                        dev=round(dev_mean, 1), p90=round(p90, 1), dmax=round(mx, 1),
                        concl=concl))

    ok = [x for x in out if x["concl"].startswith("■")]
    print(f"\n=== 复核 ===")
    print(f"  判据误判（宽凳其实有这条路）: {len(ok)} 段  {sum(x['km_amap'] for x in ok):.1f} km")
    for a, b in (("△", "可改道略绕"), ("×", "需绕行/真无路")):
        g = [x for x in out if x["concl"].startswith(a)]
        print(f"  {b}: {len(g)} 段  {sum(x['km_amap'] for x in g):.1f} km")
    json.dump(dict(rows=out), open(OUT / "kd_free_check.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("[out] out/kd_free_check.json")


if __name__ == "__main__":
    main()
