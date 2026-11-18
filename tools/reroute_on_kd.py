# -*- coding: utf-8 -*-
"""以宽凳为限定，重算 52 条排班线。

条件：**起点 / 途经点 / 终点 一个不改**（业务上必须服务的点不能动），
      路径只能在宽凳 ROAD_LINK 图上走（端点为节点、LENGTH 为权，最短路）。
输出：out/kd_reroute.json + out/kd_reroute.txt
"""
import json, math, time
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix, csr_matrix
from scipy.sparse.csgraph import dijkstra

OUT = Path(r"D:/workspace/map_element_statistics/out")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0*math.cos(math.radians(LAT0)); MLAT = 110574.0
SNAP_WARN = 100.0

def ll2xy(lon, lat):
    return (np.asarray(lon, "f8")-LON0)*MLON, (np.asarray(lat, "f8")-LAT0)*MLAT

def main():
    t0 = time.time()
    z = np.load(OUT/"_kd_graph.npz")
    nxy = z["node_xy"].astype("f8"); eu = z["eu"]; ev = z["ev"]
    elen = z["elen"].astype("f8"); comp = z["comp"]; M = len(nxy)
    # 无向图（IS_BIDIR 全表=2）
    W = np.concatenate([elen, elen])
    U = np.concatenate([eu, ev]); V = np.concatenate([ev, eu])
    G = csr_matrix(coo_matrix((W, (U, V)), shape=(M, M)))
    G.sum_duplicates()
    kd = cKDTree(nxy)
    print(f"[graph] {M:,} 节点 {G.nnz:,} 有向边 ({time.time()-t0:.1f}s)")

    doc = json.loads((OUT/"routes.json").read_text(encoding="utf-8"))
    legs = []
    for st in doc["routes"]:
        # 2026-10-16：宽凳闸门进规划器后，个别街道（芦洲镇）可能整条无路（status=no-anchors）
        # —— 此时没有 routes 键，跳过而不是崩。
        for ri, r in enumerate(st.get("routes", [])):
            A = []
            for k, a in enumerate(r["anchors"]):
                g = a.get("gcj") or a.get("gcjNative") or a.get("wgs")
                X, Y = ll2xy(g[0], g[1])
                dist, ni = kd.query([float(X), float(Y)])
                A.append(dict(i=k, name=a.get("name") or "", label=a.get("label") or "",
                              kind=a.get("kind") or "", lon=g[0], lat=g[1],
                              node=int(ni), snap=float(dist), comp=int(comp[ni])))
            legs.append(dict(street=st["street"], n=ri+1, km_amap=float(r["distKm"]),
                             min_amap=r["durMin"], anchors=A, uri=r["uri"]))

    # ---- 逐段最短路 ----
    for L in legs:
        A = L["anchors"]; segs = []
        for a, b in zip(A, A[1:]):
            if a["comp"] != b["comp"]:
                segs.append(dict(ok=False, km=None,
                                 why=f"锚点不互通：{a['name'] or a['label']} 在连通片{a['comp']}，"
                                     f"{b['name'] or b['label']} 在连通片{b['comp']}"))
                continue
            d, pr = dijkstra(G, directed=False, indices=a["node"], return_predecessors=True)
            dd = float(d[b["node"]])
            if not np.isfinite(dd):
                segs.append(dict(ok=False, km=None, why="宽凳图上不可达"))
                continue
            # 回溯
            path = []; cur = b["node"]
            while cur != a["node"] and cur >= 0 and len(path) < M:
                path.append(cur); cur = int(pr[cur])
            path.append(a["node"]); path.reverse()
            segs.append(dict(ok=True, km=dd/1000.0, nodes=path,
                             why=f"{len(path)} 个节点"))
        L["segs"] = segs
        ok = [s for s in segs if s["ok"]]
        L["km_kd"] = round(sum(s["km"] for s in ok), 3) if len(ok) == len(segs) else None
        L["seg_ok"] = sum(1 for s in segs if s["ok"]); L["seg_n"] = len(segs)
        L["snap_max"] = max(a["snap"] for a in A)
        L["snap_bad"] = [a for a in A if a["snap"] > SNAP_WARN]
        L["ncomp"] = len({a["comp"] for a in A})
        print(f"  {L['street']} 路线{L['n']:>2} 高德 {L['km_amap']:6.1f} km → 宽凳 "
              f"{(f'{L["km_kd"]:.1f}' if L['km_kd'] else '不可行'):>8}  "
              f"段 {L['seg_ok']}/{L['seg_n']}  锚点离网最大 {L['snap_max']:.0f} m ({time.time()-t0:.0f}s)")

    ok = [L for L in legs if L["km_kd"]]
    print(f"\n=== 汇总 ===")
    print(f"完全可行 {len(ok)}/{len(legs)} 条腿")
    if ok:
        a_ = sum(L["km_amap"] for L in ok); k_ = sum(L["km_kd"] for L in ok)
        print(f"  这 {len(ok)} 条：高德 {a_:.1f} km → 宽凳约束 {k_:.1f} km  增量 {k_-a_:+.1f} km ({(k_/a_-1)*100:+.1f}%)")
    print(f"高德总里程 {sum(L['km_amap'] for L in legs):.1f} km")
    bad = [L for L in legs if not L["km_kd"]]
    for L in bad:
        bs = [s for s in L["segs"] if not s["ok"]]
        print(f"  不可行：{L['street']} 路线{L['n']}  —— {bs[0]['why'][:70]}")

    out = dict(generated=time.strftime("%Y-%m-%d %H:%M"), legs=[
        dict(street=L["street"], n=L["n"], km_amap=L["km_amap"], km_kd=L["km_kd"],
             seg_ok=L["seg_ok"], seg_n=L["seg_n"], snap_max=round(L["snap_max"],1),
             ncomp=L["ncomp"],
             anchors=[dict(name=a["name"], label=a["label"], kind=a["kind"],
                           lon=a["lon"], lat=a["lat"], snap=round(a["snap"],1), comp=a["comp"])
                      for a in L["anchors"]],
             segs=[dict(ok=s["ok"], km=(round(s["km"],3) if s["ok"] else None), why=s["why"])
                   for s in L["segs"]])
        for L in legs])
    (OUT/"kd_reroute.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[out] out/kd_reroute.json ({time.time()-t0:.0f}s)")

if __name__ == "__main__":
    main()
