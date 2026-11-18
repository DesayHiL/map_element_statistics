# -*- coding: utf-8 -*-
"""诊断：为什么「沿途 30m 有大量宽凳路、且同属一个连通分量」的段，
        走廊法却报「不连通」？

对指定段逐层打印：
  子折线顶点数 / 350m 内顶点数 / 命中 link 数 / 走廊子图节点数 /
  snap 距离 / cand 内 ia→ib 是否可达 / cand 的连通块数
并把走廊子图最短路与原段一起画出来。

用法: python tools/diag_corridor.py 陈江街道 2 4
"""
import json, math, sys
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix, csr_matrix
from scipy.sparse.csgraph import connected_components, dijkstra

sys.stdout.reconfigure(encoding="utf-8")
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")
OUT = Path(r"D:/workspace/map_element_statistics/out")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0


def to_m(lon, lat):
    return np.stack([(np.asarray(lon, "f8") - LON0) * MLON,
                     (np.asarray(lat, "f8") - LAT0) * MLAT], axis=-1)


def main():
    st, no, kk = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    G = np.load(OUT / "_kd_graph.npz")
    nxy = G["node_xy"].astype("f8")
    eu, ev = G["eu"].astype("i8"), G["ev"].astype("i8")
    elen = G["elen"].astype("f8"); M = len(nxy)
    n = int((G["egap"] == 0).sum())
    print(f"节点 {M:,}  link 边 {n:,}  补边 {len(eu)-n:,}")

    fx = np.load(CACHE / "ROAD_LINK.fixed.npy", mmap_mode="r")
    gn = np.asarray(fx["geom_n"], "i4")
    geom = np.memmap(CACHE / "ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
    vlink = np.repeat(np.arange(len(gn), dtype="i8"), gn)
    vxy = to_m(np.asarray(geom[:, 0]), np.asarray(geom[:, 1]))
    vtree = cKDTree(vxy)
    print(f"顶点 {len(vlink):,}")

    RJSON = json.load(open(OUT / "routes.json", encoding="utf-8"))
    A = next(am for d in RJSON["routes"] if d["street"] == st for am in d["routes"]) if False else None
    for d in RJSON["routes"]:
        if d["street"] == st:
            A = d["routes"][no - 1]
    pm = to_m(np.asarray(A["poly"], "f8")[:, 0], np.asarray(A["poly"], "f8")[:, 1])
    am = to_m(np.asarray([a["gcj"] for a in A["anchors"]], "f8")[:, 0],
              np.asarray([a["gcj"] for a in A["anchors"]], "f8")[:, 1])
    ptree = cKDTree(pm)
    cutl, lo = [], 0
    for k in range(len(am)):
        dd, ii = ptree.query(am[k], k=min(len(pm), 200))
        ii = np.atleast_1d(ii)[np.atleast_1d(ii) >= lo]
        cutl.append(int(ii[0]) if len(ii) else int(np.atleast_1d(ptree.query(am[k])[1]))); lo = cutl[-1]
    cut = np.array(cutl)
    print(f"锚点 {len(am)} 个  cut={cutl}")
    print(f"锚点名: {[a.get('name') or a.get('label') for a in A['anchors']]}")

    sub = pm[cut[kk]:cut[kk + 1] + 1]
    if len(sub) < 2:
        sub = np.stack([am[kk], am[kk + 1]])
    L = float(np.hypot(*np.diff(sub, axis=0).T).sum())
    print(f"\n段{kk}: 子折线 {len(sub)} 顶点  {L/1000:.3f} km")
    seglen = np.hypot(*np.diff(sub, axis=0).T)
    print(f"  顶点间距: min {seglen.min():.1f} 中位 {np.median(seglen):.1f} max {seglen.max():.1f} m  "
          f"跨度 {L:.0f} m")

    # 顶点到宽凳顶点的最近距离
    dd, _ = vtree.query(sub)
    print(f"  各顶点到最近宽凳顶点距离: min {dd.min():.1f} 中位 {np.median(dd):.1f} max {dd.max():.1f} m")
    print(f"  30m 内: {int((dd<=30).sum())}/{len(dd)}   350m 内: {int((dd<=350).sum())}/{len(dd)}")

    for thr in (200.0, 350.0, 500.0, 800.0):
        nb = vtree.query_ball_point(sub, thr)
        vids = np.unique(np.concatenate([np.asarray(x, "i8") for x in nb if len(x)])) \
            if any(len(x) for x in nb) else np.array([], "i8")
        sel = np.unique(vlink[vids]); sel = sel[sel < n]
        cand = np.unique(np.concatenate([eu[sel], ev[sel]])) if len(sel) else np.array([], "i8")
        if not len(cand):
            print(f"  thr={thr:>5.0f}: 顶点 {len(vids):>5}  link {len(sel):>5}  —— 走廊空")
            continue
        lab = np.full(M, -1, "i8"); lab[cand] = np.arange(len(cand))
        s1, d1 = lab[eu[:n]], lab[ev[:n]]; m1 = (s1 >= 0) & (d1 >= 0)
        s2, d2 = lab[eu[n:]], lab[ev[n:]]; m2 = (s2 >= 0) & (d2 >= 0)
        S = np.concatenate([s1[m1], s2[m2]]); D = np.concatenate([d1[m1], d2[m2]])
        W = np.concatenate([elen[:n][m1], elen[n:][m2]])
        g = csr_matrix(coo_matrix((np.concatenate([W, W]),
                                   (np.concatenate([S, D]), np.concatenate([D, S]))),
                                  shape=(len(cand), len(cand))))
        g.sum_duplicates()
        nc, labc = connected_components(g, directed=False)
        ctree = cKDTree(nxy[cand])
        da, ia = ctree.query(am[kk]); db, ib = ctree.query(am[kk + 1])
        ok = (labc[ia] == labc[ib]) if ia != ib else True
        print(f"  thr={thr:>5.0f}: 顶点 {len(vids):>5}  link {len(sel):>5}  走廊节点 {len(cand):>6}  "
              f"走廊连通块 {nc:>5}  snap {da:>6.1f}/{db:>6.1f} m  ia={ia} ib={ib}  "
              f"{'通' if ok else '不通'}")
        if ok and ia != ib:
            dist, pred = dijkstra(g, directed=False, indices=int(ia), return_predecessors=True)
            print(f"          最短路 {float(dist[ib])/1000:.3f} km  (原段 {L/1000:.3f} km, "
                  f"比值 {float(dist[ib])/L:.2f})")


if __name__ == "__main__":
    main()
