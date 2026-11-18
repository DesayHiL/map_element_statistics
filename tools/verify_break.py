# -*- coding: utf-8 -*-
"""实证核查：Ⅰ类「路网断裂」段是不是宽凳自己的路网断了。

做法：对每段，取它 30 m 内的宽凳 link 顶点，找每个顶点最近的图节点，
      看这些节点的「连通分量号 comp」是否唯一。
        唯一   -> 该片宽凳路是连通的，问题在别处
        不唯一 -> 宽凳路网在这里断开（同一条路被切成互不相连的片）
      并定位断裂点（相邻顶点 comp 发生变化的弧长位置）。

另对 Ⅲ类「真盲区」段做同样统计作为对照——它们沿途应该几乎没有宽凳顶点。

输出 out/kd_break_verify.json + out/_break_probe.png
"""
import json, math, sys
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree
from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(encoding="utf-8")
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")
OUT = Path(r"D:/workspace/map_element_statistics/out")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0


def to_m(lon, lat):
    return np.stack([(np.asarray(lon, "f8") - LON0) * MLON,
                     (np.asarray(lat, "f8") - LAT0) * MLAT], axis=-1)


def plen(P):
    return 0.0 if len(P) < 2 else float(np.hypot(*np.diff(P, axis=0).T).sum())


def resample(P, step=5.0):
    if len(P) < 2:
        return P, np.zeros(len(P))
    s = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
    if s[-1] <= 0:
        return P, np.zeros(len(P))
    n = max(2, int(s[-1] / step))
    u = np.linspace(0, s[-1], n)
    return np.column_stack([np.interp(u, s, P[:, 0]), np.interp(u, s, P[:, 1])]), u


def main():
    z = np.load(OUT / "_kd_graph.npz")
    nxy = z["node_xy"].astype("f8"); comp = z["comp"]
    ntree = cKDTree(nxy)

    fx = np.load(CACHE / "ROAD_LINK.fixed.npy", mmap_mode="r")
    gn = np.asarray(fx["geom_n"], "i4")
    geom = np.memmap(CACHE / "ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
    vlink = np.repeat(np.arange(len(gn), dtype="i8"), gn)
    vxy = to_m(np.asarray(geom[:, 0]), np.asarray(geom[:, 1]))
    vtree = cKDTree(vxy)

    RJSON = json.load(open(OUT / "routes.json", encoding="utf-8"))
    amap = {}
    for d in RJSON["routes"]:
        for i, lg in enumerate(d.get("routes", []), start=1):
            amap[(d["street"], i)] = lg
    rows = json.load(open(OUT / "kd_plan_attrib.json", encoding="utf-8"))["rows"]

    out = []
    for r in rows:
        A = amap[(r["street"], r["n"])]
        pm = to_m(np.asarray(A["poly"], "f8")[:, 0], np.asarray(A["poly"], "f8")[:, 1])
        am = to_m(np.asarray([a["gcj"] for a in A["anchors"]], "f8")[:, 0],
                  np.asarray([a["gcj"] for a in A["anchors"]], "f8")[:, 1])
        ptree = cKDTree(pm)
        cut, lo = [], 0
        for k in range(len(am)):
            dd, ii = ptree.query(am[k], k=min(len(pm), 200))
            ii = np.atleast_1d(ii)[np.atleast_1d(ii) >= lo]
            cut.append(int(ii[0]) if len(ii) else int(np.atleast_1d(ptree.query(am[k])[1])))
            lo = cut[-1]
        sub = pm[cut[r["k"]]:cut[r["k"] + 1] + 1]
        if len(sub) < 2:
            sub = np.stack([am[r["k"]], am[r["k"] + 1]])

        q, u = resample(sub, 5.0)
        nb = vtree.query_ball_point(q, 30.0)
        cs = []
        for qi, ix in zip(q, nb):
            if not len(ix):
                cs.append(-1); continue
            d, ni = ntree.query(qi)
            cs.append(int(comp[ni]))
        cs = np.asarray(cs)
        have = cs >= 0
        uc = sorted(set(cs[have].tolist()))
        # 断裂点：非空且 comp 发生变化
        breaks = []
        for i in range(1, len(cs)):
            if cs[i] >= 0 and cs[i - 1] >= 0 and cs[i] != cs[i - 1]:
                breaks.append(round(float(u[i]), 1))
        sizes = {c: int((cs == c).sum()) for c in uc}
        rec = dict(street=r["street"], n=r["n"], k=r["k"], cls=r["cls"],
                   km=round(plen(sub) / 1000.0, 2), cover=r["cover"],
                   n_have=int(have.sum()), n_samp=len(cs),
                   ncomp_along=len(uc), comps=uc[:8], comp_sizes=sizes,
                   n_breaks=len(breaks), break_at_m=breaks[:6])
        out.append(rec)
        print(f"  {r['cls']:<8}{r['street']:<7}{r['n']:>2} 段{r['k']:<2} {rec['km']:6.2f}km  "
              f"沿途宽凳点 {rec['n_have']:>3}/{rec['n_samp']:<3}  "
              f"分量数 {rec['ncomp_along']}  断裂 {rec['n_breaks']} 处 {breaks[:3]}")

    # 汇总
    print("\n=== Ⅰ类实证 ===")
    brk = [x for x in out if x["cls"] == "Ⅰ路网断裂"]
    nb_ = sum(1 for x in brk if x["ncomp_along"] >= 2)
    print(f"  Ⅰ类 {len(brk)} 段，其中 {nb_} 段沿途存在 ≥2 个不连通分量 → 确认宽凳自断")
    print(f"  Ⅰ类断裂里程 {sum(x['km'] for x in brk):.1f} km")
    print("\n=== Ⅲ类对照 ===")
    zh = [x for x in out if x["cls"] == "Ⅲ真盲区"]
    print(f"  Ⅲ类 {len(zh)} 段，沿途平均宽凳点数 {np.mean([x['n_have'] for x in zh]):.1f} / {zh[0]['n_samp']} 采样点")

    json.dump(dict(rows=out), open(OUT / "kd_break_verify.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    # ---- 探针图：Ⅰ类里 cover 最高的 6 段 ----
    try:
        F = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 22)
    except Exception:
        F = None
    pick = sorted(brk, key=lambda x: -x["cover"])[:6]
    cw, chh = 620, 460
    sheet = Image.new("RGB", (cw * 3 + 40, chh * 2 + 90), (250, 251, 253))
    dr = ImageDraw.Draw(sheet)
    if F: dr.text((16, 14), "宽凳路网自断核查 · 红=高德段  灰=该段30m内宽凳路  彩点=连通分量", fill=(20, 24, 32), font=F)
    for i, rec in enumerate(pick):
        r = next(x for x in rows if (x["street"], x["n"], x["k"]) == (rec["street"], rec["n"], rec["k"]))
        A = amap[(r["street"], r["n"])]
        pm = to_m(np.asarray(A["poly"], "f8")[:, 0], np.asarray(A["poly"], "f8")[:, 1])
        am = to_m(np.asarray([a["gcj"] for a in A["anchors"]], "f8")[:, 0],
                  np.asarray([a["gcj"] for a in A["anchors"]], "f8")[:, 1])
        ptree = cKDTree(pm)
        cut, lo = [], 0
        for k in range(len(am)):
            dd, ii = ptree.query(am[k], k=min(len(pm), 200))
            ii = np.atleast_1d(ii)[np.atleast_1d(ii) >= lo]
            cut.append(int(ii[0]) if len(ii) else int(np.atleast_1d(ptree.query(am[k])[1]))); lo = cut[-1]
        sub = pm[cut[r["k"]]:cut[r["k"] + 1] + 1]
        if len(sub) < 2: sub = np.stack([am[r["k"]], am[r["k"] + 1]])
        c = sub.mean(axis=0)
        half = 700.0
        k = 2.0 * cw / (2 * half)
        ix, iy = i % 3, i // 3
        ox, oy = 16 + ix * (cw + 4), 48 + iy * (chh + 4)
        box = Image.new("RGB", (cw, chh), (255, 255, 255))
        bd = ImageDraw.Draw(box)
        bd.rectangle([0, 0, cw - 1, chh - 1], outline=(214, 219, 226))

        def px(P2):
            return [((p[0] - c[0]) * k + cw / 2, chh / 2 - (p[1] - c[1]) * k) for p in P2]
        sel = vtree.query_ball_point(sub, 30.0)
        vids = np.unique(np.concatenate([np.asarray(x, "i8") for x in sel if len(x)])) if any(len(x) for x in sel) else np.array([], "i8")
        for vid in vids:                       # 宽凳顶点
            nn = ntree.query(vxy[vid])[1]
            cc = int(comp[nn])
            col = [(60, 70, 90), (232, 148, 12), (16, 130, 74), (30, 90, 200),
                   (150, 40, 160), (200, 60, 120)][cc % 6]
            x, y = px([vxy[vid]])[0]
            if 0 <= x < cw and 0 <= y < chh:
                bd.rectangle([x - 1.5, y - 1.5, x + 1.5, y + 1.5], fill=col)
        bd.line(px(sub), fill=(222, 28, 8), width=3, joint="curve")
        bd.ellipse(px([sub[0]])[0:1] + [px([sub[0]])[0][0] + 8, px([sub[0]])[0][1] + 8], outline=(16, 130, 74), width=3)
        lab = f"{rec['street']}{rec['n']}段{rec['k']}  {rec['km']:.1f}km  cover{rec['cover']*100:.0f}%  分量{rec['ncomp_along']}  断裂{rec['n_breaks']}处"
        if F: bd.text((10, 8), lab, fill=(20, 24, 32), font=F)
        sheet.paste(box, (ox, oy))
    sheet.save(OUT / "_break_probe.png")
    print(f"[out] out/kd_break_verify.json  out/_break_probe.png {sheet.size}")


if __name__ == "__main__":
    main()
