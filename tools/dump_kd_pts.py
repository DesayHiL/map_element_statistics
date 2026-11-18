# -*- coding: utf-8 -*-
"""导出宽凳 ROAD_LINK 几何点云为紧凑二进制，供 JS 侧做「道路 ∈ 宽凳」覆盖判定。

产物：
  out/_kd_pts.bin    Float32 小端，[x0,y0,x1,y1,...]（米制投影，不含原点）
  out/_kd_pts.json   {n, lon0, lat0, mlon, mlat}   —— JS 侧用同一投影

投影与 tools/kd_graph.py 完全一致（LAT0=23.16, LON0=114.40），
这样 JS 侧把 WGS84 道路坐标 wgs2gcj 后可直接比对。
"""
import json, math
from pathlib import Path
import numpy as np

ROOT = Path(r"D:/workspace/map_element_statistics")
OUT = ROOT / "out"
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0

def main():
    f = np.load(CACHE/"ROAD_LINK.fixed.npy", mmap_mode="r")
    geom = np.memmap(CACHE/"ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
    goff = np.asarray(f["geom_off"], dtype="i8")//16
    gn = np.asarray(f["geom_n"], dtype="i4")
    idx = np.repeat(goff, gn) + np.concatenate([np.arange(g) for g in gn])
    P = np.asarray(geom[idx])
    x = ((P[:, 0]-LON0)*MLON).astype("f4")
    y = ((P[:, 1]-LAT0)*MLAT).astype("f4")
    # 两块布局：[x0..xn-1][y0..yn-1]，与 lib_kd_cover.js 的视图一致
    # （曾写成交错 x,y,x,y… 导致 JS 侧读出的坐标全错位 —— 覆盖判定把整片路都判成「不在宽凳」）
    flat = np.concatenate([x, y])
    (OUT/"_kd_pts.bin").write_bytes(flat.tobytes())
    json.dump({"n": int(len(x)), "lon0": LON0, "lat0": LAT0, "mlon": MLON, "mlat": MLAT},
              open(OUT/"_kd_pts.json", "w"))
    print(f"[out] _kd_pts.bin {len(flat)*4/1024/1024:.1f} MB · {len(x):,} 点")

if __name__ == "__main__":
    main()
