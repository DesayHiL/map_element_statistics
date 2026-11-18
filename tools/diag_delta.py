# -*- coding: utf-8 -*-
"""诊断：宽凳约束后里程为何比高德短？
逐腿比较：高德 km / 宽凳 km / 锚点间直线距离之和 / 锚点数 / 宽凳段数与直连段数。
输出 out/_diag_delta.csv 与控制台摘要。
"""
import json, math, csv, sys

sys.stdout.reconfigure(encoding="utf-8")

MLON = 111320.0 * math.cos(math.radians(23.16))
MLAT = 110574.0

RR = json.load(open("out/kd_reroute.json", encoding="utf-8"))["legs"]
RT = json.load(open("out/route_kuandeng_routes.json", encoding="utf-8"))["by_street"]

# 高德侧：street -> {n: leg}
amap = {}
for st, d in RT.items():
    for lg in d["legs"]:
        amap[(st, lg["n"])] = lg


def straight_sum(anchors):
    s = 0.0
    for a, b in zip(anchors, anchors[1:]):
        dx = (a["lon"] - b["lon"]) * MLON
        dy = (a["lat"] - b["lat"]) * MLAT
        s += math.hypot(dx, dy)
    return s / 1000.0


rows = []
tot = dict(amap=0.0, kd=0.0, straight=0.0, n=0)
for lg in RR:
    st, n = lg["street"], lg["n"]
    km_amap = lg["km_amap"] or 0.0
    km_kd = lg["km_kd"] or 0.0
    A = lg["anchors"]
    ss = straight_sum(A)
    # 高德侧锚点数
    al = amap.get((st, n), {})
    na_amap = len(al.get("anchors", []))
    rows.append(dict(
        street=st, n=n, seg_ok=lg["seg_ok"], seg_n=lg["seg_n"],
        na=len(A), na_amap=na_amap,
        km_amap=round(km_amap, 3), km_kd=round(km_kd, 3),
        straight=round(ss, 3),
        ratio_amap=round(km_amap / ss, 2) if ss > 0.01 else "",
        ratio_kd=round(km_kd / ss, 2) if (ss > 0.01 and km_kd) else "",
        d_amap_kd=round(km_amap - km_kd, 3) if km_kd else "",
    ))
    tot["amap"] += km_amap
    tot["kd"] += km_kd
    tot["straight"] += ss
    tot["n"] += 1

with open("out/_diag_delta.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)

print(f"腿数 {tot['n']}")
print(f"高德总里程   {tot['amap']:.1f} km")
print(f"宽凳总里程   {tot['kd']:.1f} km")
print(f"锚点直线和   {tot['straight']:.1f} km   ← 理论下限（纯直线连锚点）")
print(f"高德/直线和  {tot['amap']/tot['straight']:.2f}")
print(f"宽凳/直线和  {tot['kd']/tot['straight']:.2f}")
print()
print("=== 差异最大的 12 条腿 ===")
rows2 = sorted([r for r in rows if r["d_amap_kd"] != ""], key=lambda r: -r["d_amap_kd"])
print(f"{'街道':<10}{'#':>2} {'高德':>8}{'宽凳':>8}{'直线和':>8}{'高德/直':>8}{'宽凳/直':>8}{'差':>8}")
for r in rows2[:12]:
    print(f"{r['street']:<10}{r['n']:>2} {r['km_amap']:>8.2f}{r['km_kd']:>8.2f}{r['straight']:>8.2f}"
          f"{r['ratio_amap']:>8.2f}{r['ratio_kd']:>8.2f}{r['d_amap_kd']:>8.2f}")
