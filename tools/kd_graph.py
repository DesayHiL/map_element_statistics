# -*- coding: utf-8 -*-
"""把宽凳 ROAD_LINK 建成「可路由图」（v2：拓扑+几何双重焊接）。

宽凳自带权威拓扑：PRE_ID / NEXT_ID（196k 条有值，45 万对，互反校验 0 不一致）。
只靠几何端点焊接（2 m）会留下 2506 个伪连通片 —— 宽凳 digitizing 有 2~30 m 的接缝误差，
落在缝上的锚点会掉进只有几个节点的碎片，误判成「不可达」。

焊接规则（并查集）：
  A. 几何：两个 link 端点距离 ≤ 2 m → 合并
  B. 拓扑：对每个 PRE/NEXT 对 (i,j)，把 i、j 最近的一对端点（4 种组合取最小）合并，需 ≤ 50 m
边权 = LENGTH（IS_BIDIR 全表=2，按双向建无向图）。
  B 类接缝「不合并成同一点」，而是**加一条权 = 接缝距离的补边** —— 否则 5~50 m 的几何缺口
  会变成免费里程，最短路会沿接缝抄近道，里程被系统性低估。

输出：out/_kd_graph.npz
"""
import json, math, time
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")
OUT = Path(r"D:/workspace/map_element_statistics/out")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0*math.cos(math.radians(LAT0)); MLAT = 110574.0
WELD, TOPO_MAX = 2.0, 50.0

def read_str_cols(n):
    f = np.load(CACHE/"ROAD_LINK.fixed.npy", mmap_mode="r")
    so = np.asarray(f["str_off"], dtype="i8"); sl = np.asarray(f["str_len"], dtype="i4")
    blob = (CACHE/"ROAD_LINK.str.blob.bin").read_bytes()
    out = [[] for _ in range(4)]
    for i in range(n):
        p = int(so[i]); end = p+int(sl[i]); k = 0
        while p < end and k < 4:
            p += 1
            ln = 0; sh = 0
            while True:
                b = blob[p]; p += 1
                ln |= (b & 0x7F) << sh; sh += 7
                if not (b & 0x80): break
            p += 1
            out[k].append(blob[p:p+ln].decode("utf-8", "replace")); p += ln; k += 1
    return out

def main():
    t0 = time.time()
    f = np.load(CACHE/"ROAD_LINK.fixed.npy", mmap_mode="r")
    geom = np.memmap(CACHE/"ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
    goff = np.asarray(f["geom_off"], dtype="i8")//16
    gn   = np.asarray(f["geom_n"], dtype="i4")
    LEN  = np.asarray(f["LENGTH"], dtype="f8"); n = len(gn)

    a = np.asarray(geom[goff]); b = np.asarray(geom[goff+np.maximum(gn-1, 0)])
    ex = np.empty((n, 2, 2), dtype="f8")
    ex[:,0,0] = (a[:,0]-LON0)*MLON; ex[:,0,1] = (a[:,1]-LAT0)*MLAT
    ex[:,1,0] = (b[:,0]-LON0)*MLON; ex[:,1,1] = (b[:,1]-LAT0)*MLAT
    pts = ex.reshape(-1, 2)

    par = np.arange(len(pts), dtype="i8")
    def find(x):
        while par[x] != x:
            par[x] = par[par[x]]; x = par[x]
        return x
    def union(u, v):
        ru, rv = find(u), find(v)
        if ru != rv: par[ru] = rv
    def union_pt(u, v):
        du = np.hypot(*(pts[u]-pts[v])); return du

    # A. 几何焊接
    kd = cKDTree(pts)
    gp = kd.query_pairs(WELD, output_type="ndarray")
    for u, v in gp: union(int(u), int(v))
    print(f"[weld A 几何 ≤{WELD}m] {len(gp):,} 对 ({time.time()-t0:.1f}s)")

    # B. 拓扑焊接
    LID, _, PR, NE = read_str_cols(n)
    ids = np.array([int(x) for x in LID], dtype="i8")
    imap = np.full(ids.max()+1, -1, dtype="i4"); imap[ids] = np.arange(n)
    I = []; J = []
    for i in range(n):
        for s in NE[i].split(","):
            if s:
                j = imap[int(s)]
                if j >= 0: I.append(i); J.append(int(j))
    I = np.array(I); J = np.array(J)
    ei = ex[I]; ej = ex[J]
    d = np.stack([np.hypot(*(ei[:,0]-ej[:,0]).T), np.hypot(*(ei[:,0]-ej[:,1]).T),
                  np.hypot(*(ei[:,1]-ej[:,0]).T), np.hypot(*(ei[:,1]-ej[:,1]).T)])
    k = np.argmin(d, axis=0); near = d[k, np.arange(len(I))]
    m = near <= TOPO_MAX
    eu_ = 2*I[m]+(k[m]//2); ev_ = 2*J[m]+(k[m]%2)
    gap_u, gap_v, gap_w = eu_, ev_, near[m]
    print(f"[weld B 拓扑] {len(I):,} 对, 采用 {int(m.sum()):,} 对 (中位接缝 {np.median(near[m]):.2f} m) ({time.time()-t0:.1f}s)")

    nu = np.array([find(2*i) for i in range(n)], dtype="i4")
    nv = np.array([find(2*i+1) for i in range(n)], dtype="i4")
    gu = np.array([find(int(x)) for x in gap_u], dtype="i4")
    gv = np.array([find(int(x)) for x in gap_v], dtype="i4")
    uniq, nid = np.unique(np.concatenate([nu, nv, gu, gv]), return_inverse=True)
    nu = nid[:n]; nv = nid[n:2*n]
    gu = nid[2*n:2*n+len(gap_u)]; gv = nid[2*n+len(gap_u):]
    node_xy = pts[uniq]; M = len(uniq)

    EU = np.concatenate([nu, gu]); EV = np.concatenate([nv, gv])
    EL = np.concatenate([LEN, gap_w])
    EG = np.concatenate([np.zeros(n, dtype="i1"), np.ones(len(gap_u), dtype="i1")])
    print(f"[graph] 节点 {M:,}  真实 link 边 {n:,} + 拓扑补边 {len(gap_u):,} = {len(EU):,} ({time.time()-t0:.1f}s)")
    A = coo_matrix((np.ones(len(EU)), (EU, EV)), shape=(M, M))
    nc, lab = connected_components(A, directed=False)
    size = np.bincount(lab, minlength=nc)
    print(f"[comp] 连通分量 {nc:,}  最大 {size.max():,} 节点   ≥1000 节点的 {int((size>=1000).sum())}  ≥100 的 {int((size>=100).sum())}")
    for kk in np.argsort(-size)[:6]:
        xy = node_xy[lab == kk]
        print(f"   comp{int(kk):<5} {int(size[kk]):>8,} 节点  bbox {(xy[:,0].max()-xy[:,0].min())/1000:.1f} x {(xy[:,1].max()-xy[:,1].min())/1000:.1f} km")

    np.savez_compressed(OUT/"_kd_graph.npz", node_xy=node_xy.astype("f4"), eu=EU, ev=EV,
                        elen=EL.astype("f4"), egap=EG, comp=lab.astype("i4"),
                        ncomp=np.int32(nc), comp_size=size.astype("i8"))
    print(f"[out] out/_kd_graph.npz ({time.time()-t0:.1f}s)")

if __name__ == "__main__":
    main()
