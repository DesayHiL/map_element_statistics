# -*- coding: utf-8 -*-
"""以宽凳为限定的排班线核查：锚点级 + 腿级清单。
输出：out/kd_anchor_issues.csv, out/kd_legs.csv, out/kd_report.json
"""
import json, csv, math
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree

OUT = Path(r"D:/workspace/map_element_statistics/out")
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0*math.cos(math.radians(LAT0)); MLAT = 110574.0
def ll2xy(lon, lat): return (np.asarray(lon,"f8")-LON0)*MLON, (np.asarray(lat,"f8")-LAT0)*MLAT

f = np.load(CACHE/"ROAD_LINK.fixed.npy", mmap_mode="r")
geom = np.memmap(CACHE/"ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433,2))
gx, gy = ll2xy(geom[:,0], geom[:,1])
kd = cKDTree(np.column_stack([gx, gy]))

z = np.load(OUT/"_kd_graph.npz")
comp = z["comp"]; comp_size = z["comp_size"]
RR = json.loads((OUT/"kd_reroute.json").read_text(encoding="utf-8"))

rows = []; legs_out = []
for L in RR["legs"]:
    feas = L["km_kd"] is not None
    legs_out.append(dict(street=L["street"], n=L["n"], km_amap=L["km_amap"],
                         km_kd=L["km_kd"], seg_ok=L["seg_ok"], seg_n=L["seg_n"],
                         snap_max=L["snap_max"], ncomp=L["ncomp"],
                         verdict="可行" if feas else "不可行"))
    for a in L["anchors"]:
        X, Y = ll2xy(a["lon"], a["lat"])
        d, _ = kd.query([float(X), float(Y)])
        rows.append(dict(street=L["street"], n=L["n"], name=a["name"], label=a["label"],
                         kind=a["kind"], lon=round(a["lon"],6), lat=round(a["lat"],6),
                         off_m=round(float(d),1), comp=a["comp"],
                         comp_size=int(comp_size[a["comp"]]) if a["comp"] < len(comp_size) else -1,
                         in_main=int(a["comp"] == 0), leg_feasible=int(feas)))

off = np.array([r["off_m"] for r in rows])
print(f"锚点 {len(rows)} 个（52 条腿）")
for t in [20, 50, 100, 200, 500, 1000, 2000]:
    print(f"  离最近宽凳道路 > {t:>4} m : {int((off>t).sum()):>3} 个 ({100*(off>t).mean():.1f}%)")
print(f"  中位 {np.median(off):.1f} m  90分位 {np.percentile(off,90):.1f} m  最大 {off.max():.0f} m")

print("\n=== 离宽凳路最远的 15 个锚点（补测/改点候选）===")
for r in sorted(rows, key=lambda r: -r["off_m"])[:15]:
    tag = "主片" if r["in_main"] else f"孤片{r['comp']}({r['comp_size']})"
    print(f"  {r['off_m']:>8.0f} m  {r['street']} 路线{r['n']:<2} { (r['name'] or r['label'])[:20]:22s} {tag}")

print("\n=== 不可行的 2 条腿 ===")
for L in RR["legs"]:
    if L["km_kd"] is None:
        print(f"  {L['street']} 路线{L['n']}（高德 {L['km_amap']} km）")
        for a in L["anchors"]:
            tag = "主片" if a["comp"] == 0 else f"孤片{a['comp']}"
            print(f"     锚点 {a['name'] or a['label']:24s} {tag:10s} 离网 {a['snap']:.0f} m  {a['lon']:.6f},{a['lat']:.6f}")

print("\n=== 按街道汇总 ===")
from collections import defaultdict
g = defaultdict(lambda: [0,0,0.0,0.0])
for L in legs_out:
    v = g[L["street"]]; v[0] += 1; v[1] += 1 if L["verdict"]=="可行" else 0
    v[2] += L["km_amap"]; v[3] += (L["km_kd"] or 0)
for s,(n,ok,ka,kk) in sorted(g.items(), key=lambda kv: kv[1][1]/kv[1][0]):
    print(f"  {s:<8} {ok}/{n} 可行   高德 {ka:6.1f} km → 宽凳 {kk:6.1f} km")

with open(OUT/"kd_anchor_issues.csv","w",newline="",encoding="utf-8-sig") as fp:
    w=csv.DictWriter(fp, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
with open(OUT/"kd_legs.csv","w",newline="",encoding="utf-8-sig") as fp:
    w=csv.DictWriter(fp, fieldnames=list(legs_out[0].keys())); w.writeheader(); w.writerows(legs_out)
json.dump(dict(anchors=rows, legs=legs_out), open(OUT/"kd_report.json","w",encoding="utf-8"), ensure_ascii=False, indent=1)
print("\n[out] out/kd_anchor_issues.csv / out/kd_legs.csv / out/kd_report.json")
