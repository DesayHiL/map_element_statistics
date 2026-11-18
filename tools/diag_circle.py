# -*- coding: utf-8 -*-
"""红圈区域（用户 2026-10-15 截图）宽凳覆盖核查。
红圈中心已由倒角匹配定位到原图 (row 3170, col 2946)。
本脚本：把该窗口内每条路线顶点到「最近宽凳 link」的距离算出来，判定是真空白还是被白描边盖住。
"""
import json, math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy.spatial import cKDTree

ROOT = Path(r"D:/workspace/map_element_statistics"); OUT = ROOT / "out"
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0
W, PAD_M = 5200, 8000.0

doc = json.loads((OUT / "routes.json").read_text(encoding="utf-8"))
xs = []; ys = []
for st in doc["routes"]:
    for r in st["routes"]:
        P = np.asarray(r["poly"], "f8"); a, b = (P[:,0]-LON0)*MLON, (P[:,1]-LAT0)*MLAT
        xs.append(a); ys.append(b)
rx0,rx1 = min(a.min() for a in xs), max(a.max() for a in xs)
ry0,ry1 = min(a.min() for a in ys), max(a.max() for a in ys)
x0,x1 = rx0-PAD_M, rx1+PAD_M; y0,y1 = ry0-PAD_M, ry1+PAD_M
span = x1-x0; H = int(round(W*(y1-y0)/span))
def px2xy(col,row): return x0+col/W*span, y1-row/H*(y1-y0)
def xy2ll(X,Y): return LON0+X/MLON, LAT0+Y/MLAT
def ll2xy(lon,lat): return (np.asarray(lon,"f8")-LON0)*MLON, (np.asarray(lat,"f8")-LAT0)*MLAT

# ---- 红圈窗口（原图像素）----
R0,R1,C0,C1 = 3120, 3220, 2890, 3010
Xa,Ya = px2xy(C0,R1); Xb,Yb = px2xy(C1,R0)          # 左下 / 右上
print(f"[window] 原图 rows[{R0},{R1}] cols[{C0},{C1}]  =  {(Xb-Xa):.0f} x {(Yb-Ya):.0f} m")
print(f"[window] 经纬度 lon[{Xa/MLON+LON0:.6f},{Xb/MLON+LON0:.6f}] lat[{Ya/MLAT+LAT0:.6f},{Yb/MLAT+LAT0:.6f}]")

# ---- 载入宽凳 link，先取窗口附近的 ----
fixed = np.load(CACHE/"ROAD_LINK.fixed.npy", mmap_mode="r")
geom = np.memmap(CACHE/"ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433,2))
goff = np.asarray(fixed["geom_off"], dtype="i8")//16
gn = np.asarray(fixed["geom_n"], dtype="i4")
LEN = np.asarray(fixed["LENGTH"], dtype="f8")
first = np.asarray(geom[goff])                       # (N,2) 每条 link 首点
fx,fy = ll2xy(first[:,0], first[:,1])
Mg = 2000.0
cand = np.where((fx>Xa-Mg)&(fx<Xb+Mg)&(fy>Ya-Mg)&(fy<Yb+Mg))[0]
print(f"[kd] 候选 link {len(cand)} / {len(gn)}")
pl=[]; pid=[]
for i in cand:
    n=int(gn[i])
    if n<2: continue
    o=int(goff[i]); X,Y = ll2xy(geom[o:o+n,0], geom[o:o+n,1])
    pl.append(np.column_stack([X,Y])); pid.append(np.full(n, i))
pts = np.vstack(pl); pid = np.concatenate(pid)
kd = cKDTree(pts)
print(f"[kd] {len(pts)} 点")

# ---- 窗口内每条路线的顶点距离 ----
def R_(lon,lat): return (np.asarray(lon,"f8")-LON0)*MLON, (np.asarray(lat,"f8")-LAT0)*MLAT
def to_px(X,Y): return (X-x0)/span*W, (y1-Y)/(y1-y0)*H
rows=[]
for si,st in enumerate(doc["routes"]):
    for ri,r in enumerate(st["routes"]):
        P=np.asarray(r["poly"],"f8"); X,Y = R_(P[:,0],P[:,1])
        px,py = to_px(X,Y)
        m=(px>=C0-4)&(px<=C1+4)&(py>=R0-4)&(py<=R1+4)
        if m.sum()<2: continue
        Xs,Ys = X[m],Y[m]
        d,_ = kd.query(np.column_stack([Xs,Ys]), k=1)
        rows.append(dict(street=st["street"], n=ri+1, idx=np.where(m)[0], d=d, X=Xs, Y=Ys))
print(f"[routes] 窗口内 {len(rows)} 条腿")
tot=0.0
for r in rows:
    d=r["d"]; step=np.hypot(np.diff(r["X"]),np.diff(r["Y"]))
    seg=np.concatenate([[0],(step[:-1]+step[1:])/2])
    km=(d<=20).sum()*0  # placeholder
    print(f"   {r['street']} 路线{r['n']:>2}  顶点 {len(d):>4}  距最近宽凳路 中位 {np.median(d):7.1f} m  "
          f"最大 {d.max():8.1f} m   >20m 顶点 {int((d>20).sum()):>4}   >200m {int((d>200).sum()):>4}   >2000m {int((d>2000).sum()):>3}")
np.save(OUT/"_circle_pts.npy", pts)
print("[save] out/_circle_pts.npy")
