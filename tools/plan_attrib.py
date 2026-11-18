# -*- coding: utf-8 -*-
"""上游规划归因：26 个「走廊内接不上宽凳」的段，到底是
     (Ⅰ) 宽凳自己把路网断了      —— 数据质量问题，改数据即可
     (Ⅱ) 规划器偏离了宽凳路网    —— 上游规划缺陷，改规划即可
     (Ⅲ) 宽凳整片没采            —— 真覆盖盲区，需补测或改锚点

判据（两个正交维度）：
  · 覆盖维 cover  = 段子折线顶点 30 m 内有宽凳顶点的比例（沿途有没有宽凳路）
  · 拓扑维 thr*   = 走廊半径从 350 m 逐级放宽到 6000 m，首次连通的半径
  · 端点维 snap   = 段两端点到最近宽凳顶点的距离

  Ⅰ 路网断裂 : cover >= 0.55 且 min(snap) < 60 m        -> 贴着宽凳路却走不通
  Ⅲ 真盲区   : cover <  0.35 或 min(snap) > 500 m        -> 那片区宽凳根本没有
  Ⅱ 规划偏离 : 其余（中高覆盖、放宽走廊后能连通）

输出 out/kd_plan_attrib.json / .csv
"""
import json, math, csv, sys, time
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
THRS = [350.0, 500.0, 800.0, 1200.0, 2000.0, 3500.0, 6000.0]


def to_m(lon, lat):
    return np.stack([(np.asarray(lon, "f8") - LON0) * MLON,
                     (np.asarray(lat, "f8") - LAT0) * MLAT], axis=-1)


def plen(P):
    return 0.0 if len(P) < 2 else float(np.hypot(*np.diff(P, axis=0).T).sum())


def main():
    t0 = time.time()
    G = np.load(OUT / "_kd_graph.npz")
    node_xy = G["node_xy"].astype("f8")
    eu, ev = G["eu"].astype("i8"), G["ev"].astype("i8")
    elen = G["elen"].astype("f8")
    M = len(node_xy)
    n = int((G["egap"] == 0).sum())
    print(f"[graph] 节点 {M:,}  link 边 {n:,}")

    fx = np.load(CACHE / "ROAD_LINK.fixed.npy", mmap_mode="r")
    gn = np.asarray(fx["geom_n"], dtype="i4")
    goff = np.asarray(fx["geom_off"], dtype="i8") // 16
    geom = np.memmap(CACHE / "ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
    vlink = np.repeat(np.arange(len(gn), dtype="i8"), gn)
    vxy = to_m(np.asarray(geom[:, 0]), np.asarray(geom[:, 1]))
    vtree = cKDTree(vxy)
    print(f"[顶点] {len(vlink):,}  ({time.time()-t0:.1f}s)")

    RJSON = json.load(open(OUT / "routes.json", encoding="utf-8"))
    amap = {}
    for d in RJSON["routes"]:
        for i, lg in enumerate(d.get("routes", []), start=1):
            amap[(d["street"], i)] = lg
    SUM = json.load(open(OUT / "kd_corridor_summary.json", encoding="utf-8"))
    FAIL = {}
    for s in SUM["segs"]:
        if not s["ok"]:
            FAIL.setdefault((s["street"], s["n"]), {})[s["k"]] = s
    print(f"[失败段] {sum(len(v) for v in FAIL.values())} 段 / {len(FAIL)} 条腿")

    rows, paths = [], []
    for (st, no), segmap in sorted(FAIL.items()):
        A = amap[(st, no)]
        pm = to_m(np.asarray(A["poly"], "f8")[:, 0], np.asarray(A["poly"], "f8")[:, 1])
        am = to_m(np.asarray([a["gcj"] for a in A["anchors"]], "f8")[:, 0],
                  np.asarray([a["gcj"] for a in A["anchors"]], "f8")[:, 1])
        ptree = cKDTree(pm)
        cut, lo = [], 0
        for k in range(len(am)):
            dd, ii = ptree.query(am[k], k=min(len(pm), 200))
            ii = np.atleast_1d(ii)[np.atleast_1d(ii) >= lo]
            idx = int(ii[0]) if len(ii) else int(np.atleast_1d(ptree.query(am[k])[1]))
            cut.append(idx); lo = idx
        cut = np.array(cut)
        for k, s in sorted(segmap.items()):
            sub = pm[cut[k]:cut[k + 1] + 1]
            if len(sub) < 2:
                sub = np.stack([am[k], am[k + 1]])
            km_a = plen(sub) / 1000.0
            nm = np.array([a.get("name") or a.get("label") or "" for a in A["anchors"]])
            r = dict(street=st, n=no, k=k, km_amap=round(km_a, 3),
                     cover=s["cover"], snap_a=s["snap_a"], snap_b=s["snap_b"],
                     a_name=nm[k], b_name=nm[k + 1],
                     lon_a=float(A["anchors"][k]["gcj"][0]), lat_a=float(A["anchors"][k]["gcj"][1]),
                     lon_b=float(A["anchors"][k + 1]["gcj"][0]), lat_b=float(A["anchors"][k + 1]["gcj"][1]),
                     thr_first=None, km_kd=None, ratio=None, cls=None)
            for thr in THRS:
                nb = vtree.query_ball_point(sub, thr)
                vids = np.unique(np.concatenate([np.asarray(x, "i8") for x in nb if len(x)])) \
                    if any(len(x) for x in nb) else np.array([], "i8")
                if not len(vids):
                    continue
                sel = np.unique(vlink[vids]); sel = sel[sel < n]
                if not len(sel):
                    continue
                cand = np.unique(np.concatenate([eu[sel], ev[sel]]))
                lab = np.full(M, -1, "i8"); lab[cand] = np.arange(len(cand))
                s1, d1 = lab[eu[:n]], lab[ev[:n]]; m1 = (s1 >= 0) & (d1 >= 0)
                s2, d2 = lab[eu[n:]], lab[ev[n:]]; m2 = (s2 >= 0) & (d2 >= 0)
                S = np.concatenate([s1[m1], s2[m2]]); D = np.concatenate([d1[m1], d2[m2]])
                Wl = np.concatenate([elen[:n][m1], elen[n:][m2]])
                if not len(S):
                    continue
                g = csr_matrix(coo_matrix((np.concatenate([Wl, Wl]),
                                           (np.concatenate([S, D]), np.concatenate([D, S]))),
                                          shape=(len(cand), len(cand))))
                g.sum_duplicates()
                ctree = cKDTree(node_xy[cand])
                da, ia = ctree.query(am[k]); db, ib = ctree.query(am[k + 1])
                if ia == ib:
                    continue
                dist, pred = dijkstra(g, directed=False, indices=int(ia), return_predecessors=True)
                if not np.isfinite(dist[ib]):
                    continue
                km = float(dist[ib]) / 1000.0
                p = [int(ib)]
                while p[-1] != int(ia) and len(p) < len(cand) + 2:
                    p.append(int(pred[p[-1]]))
                p = p[::-1]
                r.update(thr_first=thr, km_kd=round(km, 3), ratio=round(km / max(km_a, 1e-6), 3))
                paths.append(dict(street=st, n=no, k=k, nodes=cand[np.asarray(p, "i8")],
                                  sub=sub, thr=thr))
                break
            # ---- 归类 ----
            mn = min([x for x in (r["snap_a"], r["snap_b"]) if x is not None] or [9e9])
            if r["cover"] < 0.35 or mn > 500:
                r["cls"] = "Ⅲ真盲区"
            elif r["cover"] >= 0.55 and mn < 60:
                r["cls"] = "Ⅰ路网断裂"
            else:
                r["cls"] = "Ⅱ规划偏离"
            rows.append(r)
            tag = f"thr*={r['thr_first']:.0f}m" if r["thr_first"] else "不通(≤6000m)"
            print(f"  {st:<7}{no:>2} 段{k:<2} {km_a:6.2f}km cover{r['cover']*100:5.1f}% "
                  f"snap{str(r['snap_a']):>7}/{str(r['snap_b']):>7}  {tag:<12} {r['cls']}")

    # 汇总
    agg = {}
    for r in rows:
        a = agg.setdefault(r["cls"], [0, 0.0])
        a[0] += 1; a[1] += r["km_amap"]
    print("\n=== 归因汇总 ===")
    for c in ("Ⅰ路网断裂", "Ⅱ规划偏离", "Ⅲ真盲区"):
        if c in agg:
            print(f"  {c}  {agg[c][0]:>2} 段  {agg[c][1]:>6.1f} km")
    print(f"  合计     {len(rows):>2} 段  {sum(r['km_amap'] for r in rows):>6.1f} km")
    bys = {}
    for r in rows:
        bys.setdefault(r["street"], {}).setdefault(r["cls"], 0.0)
        bys[r["street"]][r["cls"]] += r["km_amap"]
    print("\n=== 按镇街 ===")
    for st, d in sorted(bys.items(), key=lambda z: -sum(z[1].values())):
        seg = "  ".join(f"{c} {v:.1f}" for c, v in sorted(d.items()))
        print(f"  {st:<9} {seg}")

    json.dump(dict(rows=rows), open(OUT / "kd_plan_attrib.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    with open(OUT / "kd_plan_attrib.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)
    np.savez_compressed(OUT / "kd_plan_attrib_paths.npz",
                        **{f"p{i}": p["nodes"].astype("i4") for i, p in enumerate(paths)})
    print(f"\n[out] out/kd_plan_attrib.json / .csv / _paths.npz   ({time.time()-t0:.1f}s)")


if __name__ == "__main__":
    main()
