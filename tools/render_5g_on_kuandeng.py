# -*- coding: utf-8 -*-
"""惠城区 5G 基站分布图 —— 宽凳路网底图 + 联通/电信官方基站数据叠加。
底图：宽凳 ROAD_LINK 点云（灰）
叠加：联通 894 点（橙）、电信 513 点（紫）、密度网格热点
输出：out/kuandeng_5g_stations.png
"""
import json, math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

OUT = Path(r"D:/workspace/map_element_statistics/out")
WB = Path(r"C:/Users/uid06419/WorkBuddy/2026-11-04-11-22-52")
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0*math.cos(math.radians(LAT0)); MLAT = 110574.0
def ll2xy(lon, lat): return (np.asarray(lon,"f8")-LON0)*MLON, (np.asarray(lat,"f8")-LAT0)*MLAT
F  = lambda n: ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", n)
FB = lambda n: ImageFont.truetype("C:/Windows/Fonts/msyhbd.ttc", n)

# BD-09（百度）→ GCJ-02（宽凳/高德）：标准固定公式，一步
X_PI = math.pi * 3000.0 / 180.0
def bd2gcj(lon, lat):
    x, y = lon - 0.0065, lat - 0.006
    z = math.sqrt(x*x + y*y) - 0.00002*math.sin(y*X_PI)
    t = math.atan2(y, x) - 0.000003*math.cos(x*X_PI)
    return z*math.cos(t), z*math.sin(t)

CW, CH = 1920, 1480
HEAD, FOOT = 96, 40
MX, MY, MS = 18, HEAD+16, 1360
RX = MX+MS+36; RW = CW-RX-18

im = Image.new("RGB", (CW, CH), (255,255,255)); d = ImageDraw.Draw(im)

# ---- 数据（BD-09 → GCJ-02）----
cu = json.loads((WB/"huicheng_5g_stations.json").read_text(encoding="utf-8"))
cu_pts = [bd2gcj(float(s["epJingDu_bd"]), float(s["epWeiDu_bd"])) for s in cu]
ct = json.loads((WB/"huicheng_5g_stations_ct.json").read_text(encoding="utf-8"))
ct_pts = [bd2gcj(p[0], p[1]) for p in ct]
grid = json.loads((WB/"huicheng_5g_density_grid.json").read_text(encoding="utf-8"))
grid_pts = [(*bd2gcj(f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1]), f["properties"]["count"])
            for f in grid["features"] if f["properties"]["count"] >= 5]
# 移动无官方网页接口，不含；OpenCelliD 仅作对照不再画

# ---- 视窗：以基站 + 网格范围为准，含边距 ----
allpts = cu_pts + ct_pts + [(p[0], p[1]) for p in grid_pts]
xs=[];ys=[]
for lon,lat in allpts:
    X,Y = ll2xy([lon],[lat]); xs.append(X[0]); ys.append(Y[0])
PAD=4000.0
WX0,WX1 = min(xs)-PAD, max(xs)+PAD
WY0,WY1 = min(ys)-PAD, max(ys)+PAD
SC = MS/max(WX1-WX0, WY1-WY0)
ox = MX+(MS-(WX1-WX0)*SC)/2; oy = MY+(MS-(WY1-WY0)*SC)/2
def px(X,Y): return (ox+(X-WX0)*SC, oy+(WY1-Y)*SC)

# ---- 标题栏 ----
d.rectangle([0,0,CW,HEAD-8], fill=(24,32,46))
d.text((MX,18), "惠城区 5G 基站分布 · 宽凳路网底图", font=FB(30), fill=(255,255,255))
d.text((MX,62), "运营商官方数据（已做 BD-09→GCJ-02 校准）：中国联通 894 站（橙）· 中国电信 513 站（紫）· 密度≥5 热点（红圈）— 底图为宽凳高精路网", font=F(17), fill=(190,200,214))
d.rectangle([0,CH-FOOT,CW,CH], fill=(24,32,46))
d.text((MX,CH-FOOT+10), "数据源：联通 getbusinessHallDetail_new（2026-11-04）· 电信 fiveGBaseStation.do queryHeatMap（2026-11-04）· 移动无公开网页接口未含", font=F(15), fill=(170,180,196))

# ---- 宽凳路网底图 ----
fixed = np.load(CACHE/"ROAD_LINK.fixed.npy", mmap_mode="r")
geom = np.memmap(CACHE/"ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433,2))
goff = np.asarray(fixed["geom_off"],dtype="i8")//16; gn = np.asarray(fixed["geom_n"],dtype="i4")
d.rectangle([MX,MY,MX+MS,MY+MS], fill=(250,250,248))
n_draw = 0
for i in range(len(gn)):
    n = int(gn[i])
    if n < 2: continue
    o = int(goff[i]); X,Y = ll2xy(geom[o:o+n,0], geom[o:o+n,1])
    if X.max()<WX0 or X.min()>WX1 or Y.max()<WY0 or Y.min()>WY1: continue
    d.line([tuple(a) for a in zip(px(X,Y)[0], px(X,Y)[1])], fill=(204,208,214), width=1)
    n_draw += 1
print("road links drawn:", n_draw)

# ---- 密度热点（红圈，先画在下层） ----
for lon,lat,c in grid_pts:
    X,Y = ll2xy([lon],[lat]); x,y = px(float(X[0]), float(Y[0]))
    r = 3 + c*0.6
    d.ellipse([x-r,y-r,x+r,y+r], fill=(252,200,180))

# ---- 联通（橙点） ----
for lon,lat in cu_pts:
    X,Y = ll2xy([lon],[lat]); x,y = px(float(X[0]), float(Y[0]))
    d.ellipse([x-2.2,y-2.2,x+2.2,y+2.2], fill=(230,126,34))

# ---- 电信（紫点） ----
for lon,lat in ct_pts:
    X,Y = ll2xy([lon],[lat]); x,y = px(float(X[0]), float(Y[0]))
    d.ellipse([x-2.2,y-2.2,x+2.2,y+2.2], fill=(123,74,192))

# ---- 图例 ----
LY = MY+20
d.rectangle([RX,LY,RX+RW,LY+330], outline=(200,205,214), width=2)
d.text((RX+18,LY+14), "图例 / 口径", font=FB(20), fill=(30,38,52))
items = [
    ((230,126,34), "中国联通 5G 站点（官方覆盖地图接口，惠城区街道内 894）"),
    ((123,74,192), "中国电信 5G 站点（官方热力接口，惠城区范围 513）"),
    ((252,200,180), "站点密度热点（500m 格 ≥5 站）"),
    ((204,208,214), "宽凳高精路网（底图，仅作空间参照）"),
]
yy = LY+58
for col,txt in items:
    d.ellipse([RX+22,yy,RX+38,yy+16], fill=col, outline=(90,96,108))
    d.text((RX+50,yy-2), txt, font=F(16), fill=(40,46,60))
    yy += 34
d.text((RX+18,yy+6), "口径说明：基站位置 ≠ 信号覆盖，圆点表示运营商官方标注的", font=F(15), fill=(110,118,132))
d.text((RX+18,yy+30), "5G 站点位置；空白≠无信号。移动暂无公开网页接口。", font=F(15), fill=(110,118,132))

# ---- 统计面板 ----
SY = LY+360
d.rectangle([RX,SY,RX+RW,SY+300], outline=(200,205,214), width=2)
d.text((RX+18,SY+14), "统计", font=FB(20), fill=(30,38,52))
rows = [
    ("联通 5G 站点（惠城区街道内）", "894"),
    ("电信 5G 站点（惠城区范围）", "513"),
    ("500m 网格（有站点）", "556"),
    ("网格最高站点数", "13"),
    ("对照：OpenCelliD 众包（区内）", "2599（全制式，含 2G/4G）"),
]
yy = SY+58
for k,v in rows:
    d.text((RX+18,yy), k, font=F(16), fill=(40,46,60))
    d.text((RX+RW-18-d.textlength(v,font=FB(16)),yy), v, font=FB(16), fill=(24,32,46))
    yy += 40
    d.line([RX+18,yy-8,RX+RW-18,yy-8], fill=(232,236,242))

im.save(OUT/"kuandeng_5g_stations.png")
print("saved out/kuandeng_5g_stations.png", im.size)