# -*- coding: utf-8 -*-
"""上游规划问题总图 + 问题清单。

三色 = 宽凳可跑性（不是"离网距离"）：
   绿 沿宽凳走得通   （走廊内已连通，244 段）
   黄 小幅改道即可   （全图最短路仍贴原轨迹，偏离 ≤60 m）
   红 宽凳跑不通     （需绕行 / 本无路 / 两端不连通）
叠加：橙 = comp17 孤岛（宽凳采了但与主网未焊）；虚线 = 焊接缺口位置。

输出 out/plan_issue_overview.png、out/plan_issue_ne.png、out/plan_issue_list.csv
"""
import json, math, csv, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(encoding="utf-8")
OUT = Path(r"D:/workspace/map_element_statistics/out")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0
W, PAD_M = 5200, 8000.0
C_OK, C_FIX, C_TOP, C_BAD = (16, 130, 74), (232, 148, 12), (0, 150, 200), (222, 28, 8)
C_ISO, C_GRID = (250, 140, 0), (150, 158, 172)


def to_m(lon, lat):
    return np.stack([(np.asarray(lon, "f8") - LON0) * MLON,
                     (np.asarray(lat, "f8") - LAT0) * MLAT], axis=-1)


def main():
    G = np.load(OUT / "_kd_graph.npz")
    nxy = G["node_xy"].astype("f8"); eu, ev = G["eu"].astype("i8"), G["ev"].astype("i8")
    comp = G["comp"]
    RJSON = json.load(open(OUT / "routes.json", encoding="utf-8"))
    COR = json.load(open(OUT / "kd_corridor.json", encoding="utf-8"))["legs"]
    FREE = {(r["street"], r["n"], r["k"]): r
            for r in json.load(open(OUT / "kd_free_check.json", encoding="utf-8"))["rows"]}
    CHAIN = {(r["street"], r["n"], r["k"]): r
             for r in json.load(open(OUT / "kd_chain_check.json", encoding="utf-8"))["rows"]}

    # 主图同款投影
    xs, ys = [], []
    for d in RJSON["routes"]:
        for r in d.get("routes", []):
            P = np.asarray(r["poly"], "f8")
            m = to_m(P[:, 0], P[:, 1]); xs.append(m[:, 0]); ys.append(m[:, 1])
    x0 = min(a.min() for a in xs) - PAD_M; x1 = max(a.max() for a in xs) + PAD_M
    y0 = min(a.min() for a in ys) - PAD_M; y1 = max(a.max() for a in ys) + PAD_M
    span = x1 - x0; H = int(round(W*(y1-y0)/span))
    S = 0.26
    OW, OH = int(W*S), int(H*S)

    def px(m):
        return np.column_stack([(m[:, 0]-x0)/span*W*S, (y1-m[:, 1])/(y1-y0)*H*S])

    base = Image.open(OUT / "_grey_clean.png").convert("RGB").resize((OW, OH), Image.LANCZOS)
    canv = Image.new("RGB", (OW, OH), (255, 255, 255))
    canv.paste(base, (0, 0))
    dr = ImageDraw.Draw(canv)

    # comp17 孤岛
    c17 = 17
    sel = ((comp[eu] == c17) | (comp[ev] == c17))
    for u, v in zip(eu[sel], ev[sel]):
        a = px(nxy[[u]])[0]; b = px(nxy[[v]])[0]
        dr.line([a[0], a[1], b[0], b[1]], fill=C_ISO, width=3)

    # 路线分段上色
    K = {"ok": 0, "fix": 0, "topo": 0, "bad": 0}
    KM = {"ok": 0.0, "fix": 0.0, "topo": 0.0, "bad": 0.0}
    lst = []
    for leg in COR:
        st, no = leg["street"], leg["n"]
        A = None
        for d in RJSON["routes"]:
            if d["street"] == st:
                A = d["routes"][no - 1]
                break
        if A is None:
            continue
        pm = to_m(np.asarray(A["poly"], "f8")[:, 0], np.asarray(A["poly"], "f8")[:, 1])
        am = to_m(np.asarray([a["gcj"] for a in A["anchors"]], "f8")[:, 0],
                  np.asarray([a["gcj"] for a in A["anchors"]], "f8")[:, 1])
        from scipy.spatial import cKDTree
        ptree = cKDTree(pm); cutl, lo = [], 0
        for k in range(len(am)):
            dd, ii = ptree.query(am[k], k=min(len(pm), 200))
            ii = np.atleast_1d(ii)[np.atleast_1d(ii) >= lo]
            cutl.append(int(ii[0]) if len(ii) else int(np.atleast_1d(ptree.query(am[k])[1])))
            lo = cutl[-1]
        cut = np.array(cutl)
        nm = [a.get("name") or a.get("label") or "" for a in A["anchors"]]
        for s in leg["segs"]:
            k = s["k"]
            sub = pm[cut[k]:cut[k+1]+1]
            if len(sub) < 2:
                sub = np.stack([am[k], am[k+1]])
            km = float(np.hypot(*np.diff(sub, axis=0).T).sum())/1000.0
            if s["ok"]:
                col, key, cd = C_OK, "ok", "宽凳可跑"
            else:
                fr = FREE.get((st, no, k), {})
                cl = fr.get("concl") or ""
                v = (CHAIN.get((st, no, k), {}) or {}).get("verdict") or ""
                if cl.startswith(("■", "△")) or v.startswith("△"):
                    col, key, cd = C_FIX, "fix", "可改道"
                elif v.startswith("◇"):
                    col, key, cd = C_TOP, "topo", "宽凳有路·拓扑断开"
                else:
                    col, key, cd = C_BAD, "bad", "宽凳无路"
            p = px(sub)
            dr.line([tuple(q) for q in p], fill=col, width=(3 if key == "topo" else 2),
                    joint="curve")
            K[key] += 1; KM[key] += km
            if not s["ok"]:
                fr = FREE.get((st, no, k), {})
                ch = CHAIN.get((st, no, k), {}) or {}
                lst.append(dict(street=st, leg=no, seg=k, km=round(km, 2),
                                锚点A=nm[k], 锚点B=nm[k+1], 归因=cd,
                                沿途离宽凳中位m=ch.get("snap_med"),
                                图距比=ch.get("graph_over_track"),
                                断点数=ch.get("n_break"),
                                首断位置m=ch.get("first_break_m"),
                                全图最短路km=fr.get("km_free"),
                                平均偏离m=fr.get("dev"), 最大偏离m=fr.get("dmax"),
                                判定=ch.get("verdict") or fr.get("concl") or "不可达"))

    # 焊接缺口
    wp = json.load(open(OUT / "kd_weld_gap.json", encoding="utf-8"))
    r17 = next(r for r in wp["rows"] if r["comp"] == 17)
    pa = px(np.array([[r17["lon_a"], r17["lat_a"]]]))[0]
    pb = px(np.array([[r17["lon_b"], r17["lat_b"]]]))[0]
    dr.line([pa[0], pa[1], pb[0], pb[1]], fill=(30, 30, 30), width=3)
    for q, c in ((pa, C_ISO), (pb, (90, 100, 120))):
        dr.ellipse([q[0]-6, q[1]-6, q[0]+6, q[1]+6], outline=c, width=3)

    try:
        F1 = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 26)
        F2 = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 20)
        F3 = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 17)
    except Exception:
        F1 = F2 = F3 = None

    # 图例
    lg = Image.new("RGB", (760, 290), (255, 255, 255))
    dl = ImageDraw.Draw(lg); dl.rectangle([0, 0, 759, 289], outline=(214, 219, 226))
    if F1: dl.text((18, 12), "排班路线 × 宽凳路网 · 可跑性", fill=(20, 24, 32), font=F1)
    rows = [(C_OK, f"宽凳可跑          {K['ok']} 段 / {KM['ok']:.0f} km"),
            (C_FIX, f"改道即可          {K['fix']} 段 / {KM['fix']:.0f} km"),
            (C_TOP, f"宽凳有路·拓扑断开  {K['topo']} 段 / {KM['topo']:.0f} km"),
            (C_BAD, f"宽凳无路          {K['bad']} 段 / {KM['bad']:.0f} km"),
            (C_ISO, "comp17 孤岛（宽凳采了但未与主网焊接）"),
            ((30, 30, 30), "焊接缺口 5,122 m（芦洲—横沥东）")]
    for i, (c, t) in enumerate(rows):
        yy = 56 + i*36
        dl.line([20, yy+9, 70, yy+9], fill=c, width=6)
        if F2: dl.text((86, yy), t, fill=(30, 34, 44), font=F2)
    canv.paste(lg, (16, 16))
    canv.save(OUT / "plan_issue_overview.png")
    print(f"[out] out/plan_issue_overview.png {canv.size}")

    # 东北角放大
    z = (3250, 300, 4750, 4700)
    zc = canv.crop((int(z[0]*S), int(z[1]*S), int(z[2]*S), int(z[3]*S)))
    zc = zc.resize((int(zc.size[0]*1.7), int(zc.size[1]*1.7)), Image.LANCZOS)
    zd = ImageDraw.Draw(zc)
    if F2: zd.text((18, 14), "芦洲—横沥东：宽凳采集了 1,389 节点的路网（橙），但与主网最近相距 5.1 km（紫线）",
                   fill=(120, 20, 12), font=F2)
    zc.save(OUT / "plan_issue_ne.png")
    print(f"[out] out/plan_issue_ne.png {zc.size}")

    with open(OUT / "plan_issue_list.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=["street", "leg", "seg", "km", "锚点A", "锚点B", "归因",
                                          "沿途离宽凳中位m", "图距比", "断点数", "首断位置m",
                                          "全图最短路km", "平均偏离m", "最大偏离m", "判定"])
        w.writeheader(); w.writerows(sorted(lst, key=lambda r: -r["km"]))
    print(f"[out] out/plan_issue_list.csv  {len(lst)} 行")
    print(f"\n绿 宽凳可跑 {K['ok']} 段 {KM['ok']:.0f} km | 黄 改道即可 {K['fix']} 段 {KM['fix']:.0f} km | "
          f"橙 拓扑断开 {K['topo']} 段 {KM['topo']:.0f} km | 红 宽凳无路 {K['bad']} 段 {KM['bad']:.0f} km")
    tot = sum(KM.values())
    print(f"合计 {tot:.0f} km，跑不通 {(KM['fix']+KM['topo']+KM['bad']):.0f} km "
          f"（{100*(KM['fix']+KM['topo']+KM['bad'])/tot:.1f}%）；其中宽凳数据侧可修 "
          f"{(KM['fix']+KM['topo']):.0f} km")


if __name__ == "__main__":
    main()
