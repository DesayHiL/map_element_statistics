# -*- coding: utf-8 -*-
"""以宽凳为限定：把高德规划路线「贴」到宽凳路网（走廊约束最短路 / map-matching）。

为什么不能只做全图最短路：
  全图最短路会在 175k 节点的宽凳网上自由抄近道（无转向代价、全表双向），
  算出来比高德实际路线短 15%~19%，那个"省里程"是假的。
  用户要的是「高德那条路，但只能用宽凳有的路走」。

做法（逐锚点段）：
  1. 用高德 polyline 把一条腿按锚点切成若干段（锚点→polyline 最近点，强制单调）。
  2. 每段取子 polyline，以 THR 为半径做「走廊」：凡有顶点落在走廊内的宽凳 link 才可选。
  3. 在走廊子图上跑最短路，锚点吸附到走廊内最近节点。
  4. THR 从 30 m 逐级放宽到 350 m；仍不通 → 该段真的必须离开宽凳（=宽凳查不到段）。
  这样得到的里程是"沿高德同一条走廊、只用宽凳 link"的里程，与高德里程可比。

另输出每段的「贴合率」(子 polyline 顶点 30 m 内有宽凳顶点的比例)，
用于回答"这段高德路宽凳有没有对应路"。

输出：out/kd_corridor.json、out/kd_corridor_paths.npz
"""
import json, math, sys, time
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
THRS = [30.0, 50.0, 80.0, 120.0, 200.0, 350.0]
MAX_SNAP = 1e9            # 不在匹配阶段拒绝：锚点离走廊远近单独记录，由汇总分档


def to_m(lon, lat):
    return np.stack([(np.asarray(lon, dtype="f8") - LON0) * MLON,
                     (np.asarray(lat, dtype="f8") - LAT0) * MLAT], axis=-1)


def plen(P):
    if len(P) < 2:
        return 0.0
    return float(np.hypot(*np.diff(P, axis=0).T).sum())


def main():
    t0 = time.time()
    G = np.load(OUT / "_kd_graph.npz")
    node_xy = G["node_xy"].astype("f8")
    eu, ev = G["eu"].astype("i8"), G["ev"].astype("i8")
    elen = G["elen"].astype("f8")
    M = len(node_xy)
    nlink = int((G["egap"] == 0).sum())
    print(f"[graph] 节点 {M:,}  边 {len(eu):,}（link 边 {nlink:,}） ({time.time()-t0:.1f}s)")

    # 宽凳顶点 → link
    fx = np.load(CACHE / "ROAD_LINK.fixed.npy", mmap_mode="r")
    gn = np.asarray(fx["geom_n"], dtype="i4")
    goff = np.asarray(fx["geom_off"], dtype="i8") // 16
    geom = np.memmap(CACHE / "ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
    n = len(gn)
    assert n == nlink, f"link 数不一致 {n} vs {nlink}"
    vlink = np.repeat(np.arange(n, dtype="i8"), gn)
    NV = len(vlink)
    vlon = np.asarray(geom[:, 0]); vlat = np.asarray(geom[:, 1])
    vxy = np.empty((NV, 2), "f8")
    vxy[:, 0] = (vlon - LON0) * MLON
    vxy[:, 1] = (vlat - LAT0) * MLAT
    vtree = cKDTree(vxy)
    print(f"[宽凳顶点] {NV:,} 个，挂到 {n:,} 条 link ({time.time()-t0:.1f}s)")

    # 高德路线
    RJSON = json.load(open(OUT / "routes.json", encoding="utf-8"))
    amap = {}
    for d in RJSON["routes"]:
        st = d["street"]
        for i, lg in enumerate(d.get("routes", []), start=1):
            amap[(st, i)] = lg

    RR = json.load(open(OUT / "kd_reroute.json", encoding="utf-8"))["legs"]

    legs_out = []
    path_nodes = []      # 每段节点路径打平
    path_off = [0]
    nseg_tot = nok = 0
    km_amap_tot = km_corr_tot = 0.0

    for L in RR:
        st, no = L["street"], L["n"]
        A = amap.get((st, no))
        if A is None:
            print(f"  !! 找不到高德腿 {st} {no}")
            continue
        poly = np.asarray(A["poly"], dtype="f8")
        pm = to_m(poly[:, 0], poly[:, 1])
        anc = np.asarray([a["gcj"] for a in A["anchors"]], dtype="f8")
        am = to_m(anc[:, 0], anc[:, 1])
        ptree = cKDTree(pm)

        # 锚点 → polyline 最近点（强制单调，兼容 loop）
        cut = []
        lo = 0
        for k in range(len(am)):
            dd, ii = ptree.query(am[k], k=min(len(pm), 200))
            ii = np.atleast_1d(ii)[np.atleast_1d(ii) >= lo]
            idx = int(ii[0]) if len(ii) else int(np.atleast_1d(ptree.query(am[k])[1])[0])
            cut.append(idx); lo = idx
        cut = np.array(cut)

        leg = dict(street=st, n=no, km_amap=round(float(A["distKm"]), 3),
                   nseg=len(am) - 1, segs=[], km_corr=None, ok_segs=0)
        tot_km = 0.0; allok = True
        for k in range(len(am) - 1):
            nseg_tot += 1
            sub = pm[cut[k]:cut[k + 1] + 1]
            if len(sub) < 2:
                sub = np.stack([am[k], am[k + 1]])
            km_sub = plen(sub) / 1000.0

            # 贴合率（30 m 内有没有宽凳顶点）
            nb = vtree.query_ball_point(sub, 30.0)
            cover = float(np.mean([1.0 if len(x) else 0.0 for x in nb]))

            seg = dict(k=k, km_amap=round(km_sub, 3), cover=round(cover, 3),
                       ok=False, km=None, thr=None, snap_a=None, snap_b=None, nodes=0)
            for thr in THRS:
                nb = vtree.query_ball_point(sub, thr)
                vids = np.unique(np.concatenate([np.asarray(x, dtype="i8") for x in nb if len(x)])) \
                    if any(len(x) for x in nb) else np.array([], "i8")
                if not len(vids):
                    continue
                sel = np.unique(vlink[vids])
                sel = sel[sel < n]                      # link 边（e<n）
                if not len(sel):
                    continue
                cand = np.unique(np.concatenate([eu[sel], ev[sel]]))
                lab = np.full(M, -1, dtype="i8"); lab[cand] = np.arange(len(cand))
                # 走廊内 link 边 + 两端都在走廊内的拓扑补边
                s1 = lab[eu[:n]]; d1 = lab[ev[:n]]
                m1 = (s1 >= 0) & (d1 >= 0)
                s2 = lab[eu[n:]]; d2 = lab[ev[n:]]
                m2 = (s2 >= 0) & (d2 >= 0)
                S = np.concatenate([s1[m1], s2[m2]]); D = np.concatenate([d1[m1], d2[m2]])
                Wl = np.concatenate([elen[:n][m1], elen[n:][m2]])
                if not len(S):
                    continue
                Sp = np.concatenate([S, D]); Dp = np.concatenate([D, S]); Wp = np.concatenate([Wl, Wl])
                g = csr_matrix(coo_matrix((Wp, (Sp, Dp)), shape=(len(cand), len(cand))))
                g.sum_duplicates()
                ctree = cKDTree(node_xy[cand])
                da, ia = ctree.query(am[k]); db, ib = ctree.query(am[k + 1])
                if ia == ib:
                    seg.update(thr=thr, snap_a=round(da, 1), snap_b=round(db, 1), nodes=len(cand))
                    continue
                dist, pred = dijkstra(g, directed=False, indices=int(ia),
                                      return_predecessors=True)
                if not np.isfinite(dist[ib]):
                    seg.update(thr=thr, snap_a=round(da, 1), snap_b=round(db, 1), nodes=len(cand))
                    continue
                # 回溯路径
                p = [int(ib)]
                while p[-1] != int(ia) and len(p) < len(cand) + 2:
                    p.append(int(pred[p[-1]]))
                p = p[::-1]
                seg.update(ok=True, km=round(float(dist[ib]) / 1000.0, 3), thr=thr,
                           snap_a=round(da, 1), snap_b=round(db, 1), nodes=len(cand))
                path_nodes.append(cand[np.asarray(p, dtype="i8")])
                path_off.append(path_off[-1] + len(p))
                tot_km += float(dist[ib]) / 1000.0
                break
            if not seg["ok"]:
                allok = False
            leg["segs"].append(seg)
        leg["km_corr"] = round(tot_km, 3) if tot_km else None
        leg["ok_segs"] = sum(1 for s in leg["segs"] if s["ok"])
        if allok:
            nok += 1
        km_amap_tot += float(A["distKm"]); km_corr_tot += tot_km
        legs_out.append(leg)

    print(f"\n=== 结果 ({time.time()-t0:.1f}s) ===")
    print(f"段数 {nseg_tot}，走廊内连通 {sum(1 for L in legs_out for s in L['segs'] if s['ok'])}")
    print(f"整条腿全部段连通 {nok} / {len(legs_out)}")
    print(f"高德里程合计 {km_amap_tot:.1f} km")
    print(f"宽凳走廊贴合里程合计 {km_corr_tot:.1f} km")
    print(f"比值 {km_corr_tot/km_amap_tot:.3f}")

    print("\n=== 需要放宽 THR 的段（宽凳贴合差的）===")
    bad = [(L["street"], L["n"], s) for L in legs_out for s in L["segs"]
           if (not s["ok"]) or (s["thr"] or 0) > 30]
    for st, no, s in sorted(bad, key=lambda x: (-(x[2]["thr"] or 999), x[2]["cover"]))[:25]:
        tag = "不通" if not s["ok"] else f"THR={s['thr']:.0f}m"
        print(f"  {st:<8}{no:>2} 段{s['k']:<2} 高德{s['km_amap']:>6.2f}km 贴合率{s['cover']*100:>5.1f}%  {tag}")

    json.dump(dict(legs=legs_out, km_amap_tot=round(km_amap_tot, 2),
                   km_corr_tot=round(km_corr_tot, 2), nseg=nseg_tot,
                   ok_legs=nok, ok_segs=sum(1 for L in legs_out for s in L["segs"] if s["ok"])),
              open(OUT / "kd_corridor.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    cat = np.concatenate(path_nodes) if path_nodes else np.zeros(0, "i8")
    np.savez_compressed(OUT / "kd_corridor_paths.npz", nodes=cat.astype("i4"),
                        off=np.asarray(path_off, dtype="i8"))
    print(f"\n[out] out/kd_corridor.json  路径 {len(cat):,} 节点 / {len(path_off)-1} 段")
    print(f"[out] out/kd_corridor_paths.npz")


if __name__ == "__main__":
    main()
