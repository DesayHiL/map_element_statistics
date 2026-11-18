# -*- coding: utf-8 -*-
"""生成「宽凳约束版」排班路线几何 —— 让交付路线只由宽凳 ROAD_LINK 组成。

背景（用户明令，2026-10-16）：
  「路线规划需要按照地图约束来做，不要再出现宽凳没有、然后排版路线有的情况了。」
  out/routes.json 的 poly 来自高德导航算路（source = Amap v3/direction/driving），
  零宽凳约束 —— 所以主图上必然出现「路线跑到宽凳没路的地方」。

做法：锚点一个不改（业务必须服务的点不能动），只把「相邻锚点之间的几何」
     换成宽凳路网上的路径，三档：

  onKd   走廊 ≤350m 内连通（kd_corridor_paths.npz）→ 直接用宽凳几何
  nearKd 350m 不通、但放宽走廊（≤2000m）能连，且「贴轨度」合格 → 用放宽走廊几何
  offKd  宽凳确实无路（走廊 >2000m 仍不通，或放宽后路径严重偏离原走廊）
         → **不画任何几何**，留缺口，记入补测/改点清单

「贴轨度」判据（防放宽走廊后最短路抄近道抄到别的路上）：
  · ratio  = 宽凳路径长 / 高德同段长，须 ∈ [0.6, 2.5]
  · p90dev = 宽凳路径各顶点到「高德该段子折线」距离的 90 分位，须 ≤ 800 m

输出：
  out/routes_kd.json     与 routes.json 同契约；每腿多给 polys(连续折线数组) /
                         gaps(缺口) / status / distKm(宽凳里程) / distKmAmap
  out/kd_route_plan.json 逐腿逐段状态表（含档位、贴轨度、缺口端点）
"""
import json, math, sys, time
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix, csr_matrix
from scipy.sparse.csgraph import dijkstra

sys.stdout.reconfigure(encoding="utf-8")
OUT = Path(r"D:/workspace/map_element_statistics/out")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0

RATIO_MIN, RATIO_MAX = 0.60, 2.50     # 长度比窗口（宽凳路径 / 高德同段）
P90_MAX = 1200.0                      # 贴轨度兜底上限（m）——超此值视为跑到别的路上
COVER_MIN = 0.35                      # 沿途有宽凳路的比例下限——低于此即真盲区
BAND_OK = 350.0                       # 走廊档：≤350m 直接算 onKd
BAND_RESCUE = 2000.0                  # 放宽走廊档：首次连通半径 ≤ 此值才考虑救援
CONNECT_MAX = 500.0                   # 相邻两段路径端点距离 ≤ 此值才拼进同一条折线
GLOBAL_RATIO_MAX = 1.02               # p90 超限豁免：救援路径 ≈ 全图最短路（绕行真实而非抄错道）


def ll_to_xy(lon, lat):
    return np.column_stack([(np.asarray(lon, "f8") - LON0) * MLON,
                            (np.asarray(lat, "f8") - LAT0) * MLAT])


def xy_to_ll(xy):
    return np.column_stack([LON0 + xy[:, 0] / MLON, LAT0 + xy[:, 1] / MLAT])


def plen(P):
    return 0.0 if len(P) < 2 else float(np.hypot(*np.diff(P, axis=0).T).sum())


def main():
    t0 = time.time()
    G = np.load(OUT / "_kd_graph.npz")
    node_xy = G["node_xy"].astype("f8")
    PC = np.load(OUT / "kd_corridor_paths.npz")
    cn, coff = PC["nodes"].astype("i8"), PC["off"].astype("i8")
    C = json.load(open(OUT / "kd_corridor.json", encoding="utf-8"))
    AT = json.load(open(OUT / "kd_plan_attrib.json", encoding="utf-8"))["rows"]
    RR = json.load(open(OUT / "kd_reroute.json", encoding="utf-8"))["legs"]
    # 全图最短路参照（按 street/n 索引）：p90 超限时的豁免判据
    rr_km = {}
    for L in RR:
        rr_km[(L["street"], L["n"])] = [s["km"] for s in L["segs"]]
    PZ = np.load(OUT / "kd_plan_attrib_paths.npz")
    rescue_keys = sorted(PZ.files, key=lambda s: int(s[1:]))
    print(f"[in] 图 {len(node_xy):,} 节点 · 走廊路径 {len(coff)-1} 段 · 救援路径 {len(rescue_keys)} 条 · "
          f"归因 {len(AT)} 段 ({time.time()-t0:.1f}s)")

    # 救援路径按 attrib 行序映射（只有 thr_first 有值的行才产出路径）
    rescue = {}
    ri = 0
    for r in AT:
        if r["thr_first"]:
            rescue[(r["street"], r["n"], r["k"])] = PZ[rescue_keys[ri]]
            ri += 1
    assert ri == len(rescue_keys), f"救援路径数对不上 {ri} vs {len(rescue_keys)}"

    RJSON = json.load(open(OUT / "routes.json", encoding="utf-8"))
    amap = {}
    for d in RJSON["routes"]:
        for i, lg in enumerate(d.get("routes", []), start=1):
            amap[(d["street"], i)] = lg

    # 走廊路径索引：按 kd_corridor.json 顺序消费
    pi = 0
    legs_out, plan_legs = [], []
    stat = {"onKd": 0, "nearKd": 0, "offKd": 0}
    km = {"onKd": 0.0, "nearKd": 0.0, "offKd": 0.0}
    km_amap_tot = 0.0

    for L in C["legs"]:
        st, no = L["street"], L["n"]
        A = amap[(st, no)]
        poly = np.asarray(A["poly"], "f8")
        pm = ll_to_xy(poly[:, 0], poly[:, 1])
        ancs = A["anchors"]
        am = ll_to_xy(np.asarray([a["gcj"] for a in ancs], "f8")[:, 0],
                      np.asarray([a["gcj"] for a in ancs], "f8")[:, 1])
        ptree = cKDTree(pm)
        cut, lo = [], 0
        for k in range(len(am)):
            dd, ii = ptree.query(am[k], k=min(len(pm), 200))
            ii = np.atleast_1d(ii)[np.atleast_1d(ii) >= lo]
            idx = int(ii[0]) if len(ii) else int(np.atleast_1d(ptree.query(am[k])[1])[0])
            cut.append(idx); lo = idx
        cut = np.array(cut)

        polys, gaps, seg_recs = [], [], []
        cur = []
        km_leg = 0.0
        for s in L["segs"]:
            k = s["k"]
            sub = pm[cut[k]:cut[k + 1] + 1]
            if len(sub) < 2:
                sub = np.stack([am[k], am[k + 1]])
            km_a = plen(sub) / 1000.0
            km_amap_tot += km_a

            # --- 取几何 ---
            path_xy, tier, ratio, p90, why = None, None, None, None, None
            if s["ok"]:
                path_xy = node_xy[cn[coff[pi]:coff[pi + 1]]]; pi += 1
                tier = "onKd"
            else:
                rp = rescue.get((st, no, k))
                if rp is not None:
                    cand_xy = node_xy[rp.astype("i8")]
                    ratio = plen(cand_xy) / 1000.0 / max(km_a, 1e-6)
                    # 贴轨度：路径顶点到 高德子折线（10m 重采样）的最近距离
                    dense = []
                    for a_, b_ in zip(sub, sub[1:]):
                        d = float(np.hypot(*(b_ - a_)))
                        n = max(2, int(d // 10) + 1)
                        dense.append(np.linspace(a_, b_, n))
                    dt = np.vstack(dense) if dense else sub
                    p90 = float(np.percentile(cKDTree(dt).query(cand_xy)[0], 90))
                    thr = next(r["thr_first"] for r in AT
                               if r["street"] == st and r["n"] == no and r["k"] == k)
                    ok4 = (RATIO_MIN <= ratio <= RATIO_MAX) and thr <= BAND_RESCUE \
                        and s["cover"] >= COVER_MIN
                    # p90 贴轨超限 → 豁免判据：救援路径长度 ≈ 全图最短路（绕行是路网真断裂
                    # 的必然结果，几何仍全在宽凳上），不是走廊抄到别的路上
                    gkm = rr_km.get((st, no), [None] * 99)[k] if k < len(rr_km.get((st, no), [])) else None
                    p90_ok = p90 <= P90_MAX or (gkm is not None and gkm > 0
                                                 and plen(cand_xy) / 1000.0 <= gkm * GLOBAL_RATIO_MAX)
                    if ok4 and p90_ok:
                        path_xy, tier = cand_xy, "nearKd"
                    else:
                        rs = []
                        if not (RATIO_MIN <= ratio <= RATIO_MAX): rs.append(f"长度比{ratio:.2f}越界")
                        if p90 > P90_MAX and not p90_ok: rs.append(f"贴轨{p90:.0f}m超限")
                        if thr > BAND_RESCUE: rs.append(f"走廊首次连通需{thr:.0f}m")
                        if s["cover"] < COVER_MIN: rs.append(f"沿途有路率{s['cover']*100:.0f}%过低")
                        why = "；".join(rs) or "宽凳无可用路"
            if path_xy is None:
                tier = "offKd"
                why = why or ("走廊≤350m 内不连通，宽凳无可用路" if rescue.get((st, no, k)) is None
                              else "宽凳无可用路")

            if tier == "offKd":
                if cur and len(cur) >= 2:
                    polys.append(xy_to_ll(np.asarray(cur)))
                cur = []
                gaps.append(dict(k=k, km_amap=round(km_a, 3),
                                 a_name=ancs[k].get("name") or ancs[k].get("label") or "",
                                 b_name=ancs[k + 1].get("name") or ancs[k + 1].get("label") or "",
                                 lon_a=float(ancs[k]["gcj"][0]), lat_a=float(ancs[k]["gcj"][1]),
                                 lon_b=float(ancs[k + 1]["gcj"][0]), lat_b=float(ancs[k + 1]["gcj"][1]),
                                 cover=s["cover"], why="宽凳无可用路"))
                stat["offKd"] += 1; km["offKd"] += km_a
            else:
                km_leg += plen(path_xy) / 1000.0
                # 只在「上段尾节点 == 本段首节点」时无损拼接（同一锚点吸附到同一节点）；
                # 吸附点不同则断开成两条折线 —— 绝不用直线连，否则那条直线不落在宽凳路上。
                if cur and len(cur) >= 2 and np.hypot(*(np.asarray(cur[-1]) - path_xy[0])) < 0.01:
                    cur.extend(path_xy[1:].tolist())
                else:
                    if cur and len(cur) >= 2:
                        polys.append(xy_to_ll(np.asarray(cur)))
                    cur = path_xy.tolist()
                stat[tier] += 1; km[tier] += plen(path_xy) / 1000.0
            seg_recs.append(dict(k=k, km_amap=round(km_a, 3), tier=tier, cover=s["cover"],
                                 thr=s.get("thr"),
                                 ratio=(round(ratio, 3) if ratio is not None else None),
                                 p90dev=(round(p90, 1) if p90 is not None else None),
                                 km_kd=(round(plen(path_xy) / 1000.0, 3) if path_xy is not None else None)))
        if cur and len(cur) >= 2:
            polys.append(xy_to_ll(np.asarray(cur)))

        km_leg = sum(plen(ll_to_xy(P[:, 0], P[:, 1])) for P in polys) / 1000.0
        status = "offKd" if gaps else ("nearKd" if any(r["tier"] == "nearKd" for r in seg_recs) else "onKd")
        legs_out.append(dict(street=st, n=no, kind=A.get("kind"), targets=A.get("targets"),
                             chain=A.get("chain"), clsTags=A.get("clsTags"), anchors=ancs,
                             distKm=round(km_leg, 3), distKmAmap=float(A["distKm"]),
                             durMin=A.get("durMin"), roads=A.get("roads"), uri=A.get("uri"),
                             status=status, polys=[P.tolist() for P in polys], gaps=gaps,
                             n_gap=len(gaps), n_gap_km=round(sum(g["km_amap"] for g in gaps), 3)))
        plan_legs.append(dict(street=st, n=no, status=status, km_amap=float(A["distKm"]),
                              km_kd=round(km_leg, 3), nseg=len(seg_recs),
                              n_on=sum(1 for r in seg_recs if r["tier"] == "onKd"),
                              n_near=sum(1 for r in seg_recs if r["tier"] == "nearKd"),
                              n_off=sum(1 for r in seg_recs if r["tier"] == "offKd"),
                              segs=seg_recs, gaps=gaps))

    n_on = sum(1 for L in plan_legs for r in L["segs"] if r["tier"] == "onKd")
    n_near = sum(1 for L in plan_legs for r in L["segs"] if r["tier"] == "nearKd")
    n_off = sum(1 for L in plan_legs for r in L["segs"] if r["tier"] == "offKd")
    nseg = n_on + n_near + n_off
    ok_legs = sum(1 for L in plan_legs if L["status"] != "offKd")
    print(f"\n=== 段档位 ===  共 {nseg} 段")
    print(f"  onKd   走廊≤{BAND_OK:.0f}m 贴合   {n_on:>3} 段  {km['onKd']:>8.1f} km")
    print(f"  nearKd 放宽走廊≤{BAND_RESCUE:.0f}m   {n_near:>3} 段  {km['nearKd']:>8.1f} km")
    print(f"  offKd  宽凳无可用路         {n_off:>3} 段  {km['offKd']:>8.1f} km")
    print(f"  合计划到宽凳上 {nseg - n_off}/{nseg} 段  {(km['onKd']+km['nearKd']):.1f} km / 高德 {km_amap_tot:.1f} km")
    print(f"\n=== 腿 ===  无缺口 {ok_legs}/{len(plan_legs)} 条")
    assert pi == len(coff) - 1, f"走廊路径消费不齐 {pi} vs {len(coff)-1}"

    out = dict(generated=time.strftime("%Y-%m-%d %H:%M"),
               source="宽凳 ROAD_LINK 约束重规划（锚点不变，几何只用宽凳 link）",
               km_amap_tot=round(km_amap_tot, 2),
               km_onKd=round(km["onKd"], 2), km_nearKd=round(km["nearKd"], 2),
               km_offKd=round(km["offKd"], 2), seg_on=n_on, seg_near=n_near, seg_off=n_off,
               ok_legs=ok_legs, routes=legs_out)
    (OUT / "routes_kd.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    (OUT / "kd_route_plan.json").write_text(
        json.dumps(dict(generated=out["generated"], legs=plan_legs), ensure_ascii=False, indent=1),
        encoding="utf-8")
    print(f"\n[out] out/routes_kd.json     兼容 routes.json 契约，{len(legs_out)} 腿")
    print(f"[out] out/kd_route_plan.json 逐段状态表  ({time.time()-t0:.1f}s)")

    print("\n=== 有缺口的腿（宽凳确实没有的路）===")
    for L in plan_legs:
        if L["status"] != "offKd":
            continue
        g = L["gaps"][0]
        gkm = sum(x["km_amap"] for x in L["gaps"])
        print(f"  {L['street']:<7}路线{L['n']:<2} 缺 {L['n_off']} 段 / {gkm:>6.1f} km "
              f"（高德 {L['km_amap']:.1f} → 宽凳可画 {L['km_kd']:.1f}）  例：{g['a_name']}→{g['b_name']}")


if __name__ == "__main__":
    main()
