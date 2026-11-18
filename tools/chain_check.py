# -*- coding: utf-8 -*-
"""把「宽凳跑不通」的段切成两类，并定位断点。

沿原段折线每 20 m 采样 → 每点 snap 到最近的宽凳图节点 → 从段起点做一次
Dijkstra，得到每个采样点在宽凳图上的"累积可行距离" seq。
沿轨迹前进时 seq 应近似线性增长。

   相邻采样点 seq 突增 > 200 m  ->  宽凳在这里「拓扑断开」（有路，接不上）
   累计 seq 远大于轨迹长度      ->  必须大幅绕行
   采样点到最近宽凳顶点的距离大 ->  这里「根本没有宽凳路」

输出 out/kd_chain_check.json
"""
import json, math, sys
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix, csr_matrix
from scipy.sparse.csgraph import dijkstra

sys.stdout.reconfigure(encoding="utf-8")
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")
OUT = Path(r"D:/workspace/map_element_statistics/out")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0
STEP = 20.0


def to_m(lon, lat):
    return np.stack([(np.asarray(lon, "f8") - LON0) * MLON,
                     (np.asarray(lat, "f8") - LAT0) * MLAT], axis=-1)


def resample(P, step):
    s = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
    if s[-1] <= 0:
        return P, np.zeros(len(P))
    u = np.arange(0, s[-1], step)
    return np.column_stack([np.interp(u, s, P[:, 0]), np.interp(u, s, P[:, 1])]), u


def main():
    G = np.load(OUT / "_kd_graph.npz")
    nxy = G["node_xy"].astype("f8")
    eu, ev = G["eu"].astype("i8"), G["ev"].astype("i8")
    elen = G["elen"].astype("f8"); M = len(nxy)
    GG = csr_matrix(coo_matrix((np.concatenate([elen, elen]),
                                (np.concatenate([eu, ev]), np.concatenate([ev, eu]))),
                               shape=(M, M)))
    GG.sum_duplicates()
    ntree = cKDTree(nxy)

    fx = np.load(CACHE / "ROAD_LINK.fixed.npy", mmap_mode="r")
    gn = np.asarray(fx["geom_n"], "i4")
    geom = np.memmap(CACHE / "ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
    vxy = to_m(np.asarray(geom[:, 0]), np.asarray(geom[:, 1]))
    vtree = cKDTree(vxy)

    RJSON = json.load(open(OUT / "routes.json", encoding="utf-8"))
    amap = {(d["street"], i): lg for d in RJSON["routes"]
            for i, lg in enumerate(d.get("routes", []), 1)}
    rows = [r for r in json.load(open(OUT / "kd_free_check.json", encoding="utf-8"))["rows"]
            if not (r.get("concl") or "").startswith(("■", "△"))]
    print(f"待检验 {len(rows)} 段（宽凳跑不通的）\n")

    print(f"{'镇街':<7}{'腿':>3}{'段':>3} {'原km':>7} {'采样':>5} {'snap中位':>8} "
          f"{'snap最大':>8} {'图距/轨迹':>9} {'断点数':>6} {'首断位置m':>9} {'判定'}")
    out = []
    for r in rows:
        A = amap[(r["street"], r["n"])]
        pm = to_m(np.asarray(A["poly"], "f8")[:, 0], np.asarray(A["poly"], "f8")[:, 1])
        am = to_m(np.asarray([a["gcj"] for a in A["anchors"]], "f8")[:, 0],
                  np.asarray([a["gcj"] for a in A["anchors"]], "f8")[:, 1])
        ptree = cKDTree(pm); cutl, lo = [], 0
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
        q, u = resample(sub, STEP)
        dsnap, _ = vtree.query(q)
        _, nid = ntree.query(q)
        dist = dijkstra(GG, directed=False, indices=int(nid[0]))
        seq = dist[nid]
        fin = np.isfinite(seq)
        jumps = np.diff(seq)
        big = np.nonzero((jumps > 200) & fin[1:] & fin[:-1])[0]
        med = float(np.median(dsnap)); mx = float(dsnap.max())
        r_ratio = float(seq[-1] / max(La, 1e-6)) if fin[-1] else float("inf")
        if med > 300:
            verd = "× 根本没有宽凳路"
        elif med <= 40 and len(big) > 0:
            verd = "◇ 有路但拓扑断开"
        elif r_ratio > 2.0 or not fin[-1]:
            verd = "× 需大幅绕行/不可达"
        else:
            verd = "△ 可绕行"
        first = round(float(u[big[0]+1]), 0) if len(big) else None
        print(f"{r['street']:<7}{r['n']:>3}{r['k']:>3} {La/1000:>7.2f} {len(q):>5} "
              f"{med:>8.1f} {mx:>8.1f} {r_ratio:>9.2f} {len(big):>6} "
              f"{str(first):>9} {verd}")
        out.append(dict(street=r["street"], n=r["n"], k=r["k"], km=round(La/1000, 2),
                        n_samp=len(q), snap_med=round(med, 1), snap_max=round(mx, 1),
                        graph_over_track=round(r_ratio, 2), n_break=int(len(big)),
                        first_break_m=first, verdict=verd))
    print()
    for v in ("◇ 有路但拓扑断开", "△ 可绕行", "× 需大幅绕行/不可达", "× 根本没有宽凳路"):
        g = [x for x in out if x["verdict"] == v]
        if g:
            print(f"  {v:<16} {len(g):>2} 段  {sum(x['km'] for x in g):>6.1f} km")
    json.dump(dict(rows=out), open(OUT / "kd_chain_check.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("[out] out/kd_chain_check.json")


if __name__ == "__main__":
    main()
