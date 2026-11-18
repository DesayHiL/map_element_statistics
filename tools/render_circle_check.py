# -*- coding: utf-8 -*-
"""红圈核查证据图 v2：惠州市政府 / 市民乐园一带（江北街道）。
图层（自下而上）：宽凳路网(粗淡) → 排班路线(白描边+红) → 查不到段(紫)
              → 宽凳路网(细，画在最上层，任何被路线压住的路都能看见) → 标注
输出：out/circle_check.png
"""
import json, math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.spatial import cKDTree

ROOT = Path(r"D:/workspace/map_element_statistics"); OUT = ROOT/"out"
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0*math.cos(math.radians(LAT0)); MLAT = 110574.0
W0, PAD_M, BUFFER = 5200, 8000.0, 20.0

CW, CH = 1640, 1330
HEAD, FOOT = 92, 100
MAPY0, MAPY1 = HEAD, CH-FOOT
K = 2.0
XC, YC = (114.41570-LON0)*MLON, (23.11150-LAT0)*MLAT
VW, VH = CW/K, (MAPY1-MAPY0)/K

C_NET_B, C_NET_T = (176, 184, 198), (100, 110, 130)
C_ROUTE, C_OFF = (222, 28, 8), (122, 40, 190)
C_TXT, C_MUT = (24, 28, 36), (110, 118, 132)

def ll2xy(lon, lat):
    return (np.asarray(lon, "f8")-LON0)*MLON, (np.asarray(lat, "f8")-LAT0)*MLAT
def P(lon, lat):
    X, Y = ll2xy(lon, lat); return (CW/2+(X-XC)*K, (MAPY0+MAPY1)/2-(Y-YC)*K)
def PX(X, Y): return (CW/2+(X-XC)*K, (MAPY0+MAPY1)/2-(Y-YC)*K)
F  = lambda n: ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", n)
FB = lambda n: ImageFont.truetype("C:/Windows/Fonts/msyhbd.ttc", n)

im = Image.new("RGB", (CW, CH), (255, 255, 255)); d = ImageDraw.Draw(im)

# ---- 视窗 / 红圈定位 -------------------------------------------------
doc = json.loads((OUT/"routes.json").read_text(encoding="utf-8"))
xs=[];ys=[]
for st in doc["routes"]:
    for r in st["routes"]:
        a,b = ll2xy([p[0] for p in r["poly"]], [p[1] for p in r["poly"]]); xs.append(a); ys.append(b)
x0,x1 = min(a.min() for a in xs)-PAD_M, max(a.max() for a in xs)+PAD_M
y0,y1 = min(a.min() for a in ys)-PAD_M, max(a.max() for a in ys)+PAD_M
span = x1-x0; H0 = int(round(W0*(y1-y0)/span))
CR, CC = 3170.0, 2946.5                                   # 用户红圈中心（原图像素，倒角匹配所得）
Xcr, Ycr = x0+CC/W0*span, y1-CR/H0*(y1-y0)
CRX, CRY = 532/2, 355/2

fixed = np.load(CACHE/"ROAD_LINK.fixed.npy", mmap_mode="r")
geom  = np.memmap(CACHE/"ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
goff  = np.asarray(fixed["geom_off"], dtype="i8")//16
gn    = np.asarray(fixed["geom_n"], dtype="i4")

# ---- 1) 底图：窗口附近宽凳路网（粗淡） --------------------------------
b = 2500.0
first = np.asarray(geom[goff]); fx, fy = ll2xy(first[:,0], first[:,1])
cand = np.where((np.abs(fx-XC) < VW/2+b) & (np.abs(fy-YC) < VH/2+b))[0]
pl=[]
for i in cand:
    n = int(gn[i])
    if n < 2: continue
    o = int(goff[i]); X, Y = ll2xy(geom[o:o+n,0], geom[o:o+n,1])
    pl.append(np.column_stack([X, Y]))
allpts = np.vstack(pl); kd = cKDTree(allpts)
IN = lambda a: (np.abs(a[:,0]-XC) < VW/2+14) & (np.abs(a[:,1]-YC) < VH/2+14)
for a in pl:
    m = IN(a)
    if m.sum() < 2: continue
    d.line([PX(x_, y_) for x_, y_ in a[m]], fill=C_NET_B, width=5, joint="curve")

# ---- 2) 路线 + 查不到段 ----------------------------------------------
runs = []; dist_in = []
for st in doc["routes"]:
    for ri, r in enumerate(st["routes"]):
        Pll = np.asarray(r["poly"], "f8"); X, Y = ll2xy(Pll[:,0], Pll[:,1])
        near = (np.abs(X-XC) < VW/2+300) & (np.abs(Y-YC) < VH/2+300)
        if near.sum() < 2: continue
        dd, _ = kd.query(np.column_stack([X, Y]), k=1)
        m = IN(np.column_stack([X, Y])) if False else (np.abs(X-XC) < VW/2) & (np.abs(Y-YC) < VH/2)
        dist_in.append(dd[m])
        q = np.column_stack([X, Y])[near]
        d.line([PX(x_, y_) for x_, y_ in q], fill=(255,255,255), width=7, joint="curve")
        d.line([PX(x_, y_) for x_, y_ in q], fill=C_ROUTE, width=3, joint="curve")
        off = dd > BUFFER; k = 0
        while k < len(off):
            if not off[k]: k += 1; continue
            j = k
            while j+1 < len(off) and off[j+1]: j += 1
            ii = np.arange(k, j+1)
            seg = np.column_stack([X[ii], Y[ii]])
            L = float(np.hypot(np.diff(seg[:,0]), np.diff(seg[:,1])).sum())
            inm = (np.abs(seg[:,0]-XC) < VW/2) & (np.abs(seg[:,1]-YC) < VH/2)
            if L >= 40 and inm.any():
                runs.append(dict(street=st["street"], n=ri+1, seg=seg, L=L,
                                 dmax=float(dd[ii].max()), imax=int(ii[int(np.argmax(dd[ii]))]),
                                 a_ll=Pll[ii[0]], b_ll=Pll[ii[-1]]))
            k = j+1
S = np.concatenate(dist_in)

for R in runs:
    seg = R["seg"]
    d.line([PX(x_, y_) for x_, y_ in seg], fill=(255,255,255), width=10, joint="curve")
    d.line([PX(x_, y_) for x_, y_ in seg], fill=C_OFF, width=5, joint="curve")
    for pt in (seg[0], seg[-1]):
        px, py = PX(*pt); d.ellipse([px-7, py-7, px+7, py+7], fill=(255,255,255), outline=C_OFF, width=3)

# ---- 3) 宽凳路网再画一层（细，压在最上，证明没被盖住） ----------------
for a in pl:
    m = IN(a)
    if m.sum() < 2: continue
    d.line([PX(x_, y_) for x_, y_ in a[m]], fill=C_NET_T, width=2, joint="curve")

# ---- 4) 标注 ---------------------------------------------------------
R = max(runs, key=lambda r: r["dmax"])
Xk, Yk = ll2xy([R["a_ll"][0]], [R["a_ll"][1]])
kk = R["imax"]
Pll = None
for st in doc["routes"]:
    if st["street"] == R["street"]: Pll = np.asarray(st["routes"][R["n"]-1]["poly"], "f8")
Xk, Yk = ll2xy(Pll[:,0], Pll[:,1])
bb = 4000.0
f2 = np.asarray(geom[goff]); f2x, f2y = ll2xy(f2[:,0], f2[:,1])
c2 = np.where((np.abs(f2x-Xk[kk]) < bb) & (np.abs(f2y-Yk[kk]) < bb))[0]
pl2 = []
for i in c2:
    n = int(gn[i])
    if n < 2: continue
    o = int(goff[i]); X, Y = ll2xy(geom[o:o+n,0], geom[o:o+n,1]); pl2.append(np.column_stack([X, Y]))
kd2 = cKDTree(np.vstack(pl2))
dv, iv = kd2.query(np.array([[Xk[kk], Yk[kk]]]))
q = np.vstack(pl2)[iv[0]]
px1, py1 = PX(Xk[kk], Yk[kk]); px2, py2 = PX(*q)
for t in range(0, 26, 2):
    a1, a2 = t/26, (t+0.62)/26
    d.line([px1+(px2-px1)*a1, py1+(py2-py1)*a1, px1+(px2-px1)*a2, py1+(py2-py1)*a2], fill=C_OFF, width=2)
d.ellipse([px1-6, py1-6, px1+6, py1+6], fill=C_OFF, outline=(255,255,255), width=2)
d.ellipse([px2-5, py2-5, px2+5, py2+5], fill=C_NET_T, outline=(255,255,255), width=2)
d.text((px1+18, py1-38), f"最远 {R['dmax']:.0f} m", font=FB(24), fill=C_OFF, stroke_width=5, stroke_fill=(255,255,255))
d.text((px2-14, py2+16), "最近的宽凳道路", font=F(19), fill=C_NET_T, stroke_width=5, stroke_fill=(255,255,255), anchor="rt")

mx, my = float(np.mean(seg[:,0])), float(np.mean(seg[:,1]))
smx, smy = PX(mx, my)
d.text((smx+62, smy+58), f"宽凳查不到 {R['L']:.0f} m", font=FB(24), fill=C_OFF,
       stroke_width=5, stroke_fill=(255,255,255))

ycx, ycy = PX(Xcr, Ycr)
for t in range(0, 200, 2):
    a1 = t/200*2*math.pi; a2 = (t+0.72)/200*2*math.pi
    d.line([ycx+CRX*K*math.cos(a1), ycy-CRY*K*math.sin(a1),
            ycx+CRX*K*math.cos(a2), ycy-CRY*K*math.sin(a2)], fill=(46, 50, 60), width=3)
d.text((ycx-CRX*K+18, ycy-CRY*K-26), "你圈的位置", font=F(20), fill=(46,50,60),
       stroke_width=5, stroke_fill=(255,255,255))

def lab(t, lon, lat, dy=0, anchor="mt", f=None, col=C_TXT):
    px, py = P(lon, lat); d.text((px, py+dy), t, font=f or FB(22), fill=col,
                                 stroke_width=5, stroke_fill=(255,255,255), anchor=anchor)
lab("惠州市人民政府（云山西路6号）", 114.415587, 23.112368, -16, "mb")
lab("惠州市民乐园", 114.418373, 23.109290, 14, "mt")
lab("文华一路 × 云山西路", 114.415476, 23.110043, 16, "mt", F(20), C_MUT)

# ---- 图例 -----------------------------------------------------------
LX, LY = 22, MAPY0+18
items = [("宽凳路网", C_NET_T, 3), ("排班路线（本图 4 条腿）", C_ROUTE, 3),
         ("宽凳查不到段（距最近宽凳道路 > 20 m）", C_OFF, 5)]
bw, bh = 452, 30+len(items)*32
d.rounded_rectangle([LX, LY, LX+bw, LY+bh], 10, fill=(255,255,255), outline=(214,220,230), width=2)
for i,(t,c,w) in enumerate(items):
    yy = LY+22+i*32
    d.line([LX+12, yy, LX+42, yy], fill=c, width=w)
    d.text((LX+54, yy), t, font=F(20), fill=C_TXT, anchor="lm")

# ---- 区位小图 --------------------------------------------------------
IW, IH = 320, 300; IX, IY = CW-IW-22, MAPY0+18
d.rectangle([IX-2, IY-2, IX+IW+2, IY+IH+2], fill=(255,255,255), outline=(214,220,230), width=2)
xc0, xc1, yc0, yc1 = -35787.4, 30196.8, -31174.4, 34825.3
ks = min((IW-16)/(xc1-xc0), (IH-34)/(yc1-yc0))
ox = IX+IW/2-(xc0+xc1)/2*ks; oy = IY+IH-10+(yc0+yc1)/2*ks
gx = lambda X: ox+X*ks; gy = lambda Y: oy-Y*ks
for i in range(len(gn)):
    n = int(gn[i])
    if n < 2: continue
    o = int(goff[i]); X, Y = ll2xy(geom[o:o+n,0], geom[o:o+n,1])
    d.line(list(zip(gx(X).tolist(), gy(Y).tolist())), fill=(206,212,222), width=1)
for st in doc["routes"]:
    for r in st["routes"]:
        X, Y = ll2xy([p[0] for p in r["poly"]], [p[1] for p in r["poly"]])
        d.line(list(zip(gx(X).tolist(), gy(Y).tolist())), fill=(240,150,130), width=1)
d.rectangle([gx(Xcr-CRX), gy(Ycr+CRY), gx(Xcr+CRX), gy(Ycr-CRY)], outline=(210, 20, 20), width=3)
d.text((IX+IW/2, IY+14), "红框 = 本图范围（整个交付范围 5,779 km）", font=F(17), fill=C_MUT, anchor="mt")

# ---- 比例尺 ---------------------------------------------------------
sx, sy = 40, MAPY1-44
d.line([sx, sy, sx+100*K, sy], fill=(40,44,54), width=4)
for e in (sx, sx+100*K): d.line([e, sy-9, e, sy+9], fill=(40,44,54), width=4)
d.text((sx+50*K, sy-18), "100 m", font=FB(20), fill=C_TXT, anchor="mb", stroke_width=5, stroke_fill=(255,255,255))

# ---- 头脚 -----------------------------------------------------------
d.rectangle([0,0,CW,HEAD], fill=(17,24,39))
d.text((26,10), "红圈核查：宽凳在江北街道·市政府一带有没有图？", font=FB(30), fill=(255,255,255))
d.text((26,52), "结论：周围路网宽凳全都有（本范围内路线顶点距最近宽凳道路 中位 1.8 m）；只有紫线那段 325 m 进了"
                "市政府 / 市民乐园内部，宽凳没采", font=F(18), fill=(160,203,255))
d.rectangle([0,CH-FOOT,CW,CH], fill=(246,248,251)); d.line([0,CH-FOOT,CW,CH-FOOT], fill=(219,225,234), width=2)
foot = [f"本图范围 800 × 565 m：{len(S)} 个路线顶点，距最近宽凳道路 中位 {np.median(S):.1f} m / 90分位 {np.percentile(S,90):.1f} m / 最大 {S.max():.0f} m",
        f"唯一的「查不到」段：{R['street']} 路线{R['n']} 共 {R['L']:.0f} m（>20 m），最远 {R['dmax']:.0f} m；位于市政府/市民乐园一带的内部道路，高德有可通行道路，宽凳无对应 link",
        "底图：宽凳交付 GCJ02/AuditSpec/kxf/441302 · ROAD_LINK（画了两层：粗淡在下、细深在上，故被路线压住的路也看得见）｜ 路线：高德驾车折线 out/routes.json"]
for i,t in enumerate(foot):
    d.text((26, CH-FOOT+14+i*26), t, font=F(19), fill=(52,60,74) if i<2 else C_MUT)

im.save(OUT/"circle_check.png"); print("[out]", im.size, "runs", len(runs), f"L={R['L']:.0f} dmax={R['dmax']:.0f}")
