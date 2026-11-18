# -*- coding: utf-8 -*-
"""把走廊贴合得到的路线导出成 GeoJSON（可直接进仿真/地图）。
几何 = 逐段宽凳图节点串（相邻节点即一条宽凳 ROAD_LINK，中位 14.7 m），
因此折线就是"只由宽凳 link 组成"的路线。
属性含街道/腿号/段号/分档/宽凳里程/走廊半径/锚点接驳距离。

输出：out/kd_routes_matched.geojson
"""
import json, sys
import numpy as np
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
OUT = Path("out")
LAT0, LON0 = 23.16, 114.40
MLAT = 110574.0
MLON = 111320.0 * np.cos(np.radians(LAT0))

G = np.load(OUT / "_kd_graph.npz")
nxy = G["node_xy"].astype("f8")
P = np.load(OUT / "kd_corridor_paths.npz")
nodes, off = P["nodes"], P["off"]
S = json.load(open(OUT / "kd_corridor_summary.json", encoding="utf-8"))
segs_by_leg = {}
for s in S["segs"]:
    segs_by_leg.setdefault((s["street"], s["n"]), []).append(s)
for k in segs_by_leg:
    segs_by_leg[k].sort(key=lambda s: s["k"])

# 按匹配脚本的迭代顺序取回 ok 段
order = []
for L in S["legs"]:
    key = (L["street"], L["n"])
    for s in segs_by_leg.get(key, []):
        if s["ok"]:
            order.append((L["street"], L["n"], s))
assert len(order) == len(off) - 1, f"段数不匹配 {len(order)} vs {len(off)-1}"

feats = []
tot = 0.0
for j, (st, no, s) in enumerate(order):
    idx = nodes[off[j]:off[j + 1]]
    XY = nxy[idx]
    lon = XY[:, 0] / MLON + LON0
    lat = XY[:, 1] / MLAT + LAT0
    feats.append(dict(
        type="Feature",
        properties=dict(street=st, leg=no, seg=s["k"] + 1, tier=s["tier"],
                        km_kd=s["km"], km_amap=s["km_amap"], corridor_m=s["thr"],
                        snap_a_m=s["snap_a"], snap_b_m=s["snap_b"],
                        cover=s["cover"], n_nodes=int(len(idx))),
        geometry=dict(type="LineString", coordinates=[[round(a, 7), round(b, 7)]
                                                      for a, b in zip(lon, lat)])))
    tot += s["km"]

geo = dict(type="FeatureCollection",
           name="huicheng_52legs_on_kuandeng",
           crs=dict(type="name", properties=dict(name="urn:ogc:def:crs:OGC:1.3:CRS84")),
           note="几何只由宽凳 ROAD_LINK 组成（逐段走廊约束最短路）。"
                "A/B/C 为可落档，D 档未导出。坐标为 GCJ02。",
           properties=dict(segments=len(feats), km=round(tot, 2)),
           features=feats)
(OUT / "kd_routes_matched.geojson").write_text(json.dumps(geo, ensure_ascii=False), encoding="utf-8")
print(f"[out] out/kd_routes_matched.geojson  {len(feats)} 段 / {tot:.1f} km / "
      f"{(OUT/'kd_routes_matched.geojson').stat().st_size/1024:.0f} KB")
import collections
print("  档分布:", dict(collections.Counter(f["properties"]["tier"] for f in feats)))
missing = [L for L in S["legs"] if (L["street"], L["n"]) not in
           {k for k in segs_by_leg}]
print(f"  覆盖腿数: {len({(f['properties']['street'], f['properties']['leg']) for f in feats})} / {len(S['legs'])}")
