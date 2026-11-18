# -*- coding: utf-8 -*-
"""「以宽凳为限定」的排班线可行性核查图。
左：全域图（宽凳主片/孤片 + 52 条路线 + 322 个锚点按离网距离着色）
右：核查结论 / 最远锚点榜 / 北部孤片放大
输出：out/kd_feasibility.png
"""
import json, math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

OUT = Path(r"D:/workspace/map_element_statistics/out")
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0*math.cos(math.radians(LAT0)); MLAT = 110574.0
def ll2xy(lon, lat): return (np.asarray(lon,"f8")-LON0)*MLON, (np.asarray(lat,"f8")-LAT0)*MLAT
F  = lambda n: ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", n)
FB = lambda n: ImageFont.truetype("C:/Windows/Fonts/msyhbd.ttc", n)

CW, CH = 1920, 1680
HEAD, FOOT = 100, 42
MX, MY, MS = 16, HEAD+14, 1330
RX, RW = MX+MS+34, CW-(MX+MS+34)-16
C_MAIN, C_ISO, C_ROUTE, C_BAD = (176,184,198), (236,120,16), (240,166,146), (190,20,20)
BINS = [(0,20,(16,130,74),"≤20 m"), (20,50,(14,124,140),"20–50 m"),
        (50,200,(198,150,10),"50–200 m"), (200,500,(228,110,10),"200–500 m"),
        (500,2000,(214,40,10),"0.5–2 km"), (2000,1e9,(140,0,0),">2 km")]
def bin_of(v):
    for a,b,c,_ in BINS:
        if a <= v < b: return c
    return BINS[-1][2]

im = Image.new("RGB", (CW, CH), (255,255,255)); d = ImageDraw.Draw(im)

doc = json.loads((OUT/"routes.json").read_text(encoding="utf-8"))
xs=[];ys=[]
NLEGS = 0
for st in doc["routes"]:
    for r in st.get("routes") or []:
        X,Y = ll2xy([p[0] for p in r["poly"]],[p[1] for p in r["poly"]]); xs.append(X); ys.append(Y)
        NLEGS += 1
PAD=8000.0
WX0,WX1 = min(a.min() for a in xs)-PAD, max(a.max() for a in xs)+PAD
WY0,WY1 = min(a.min() for a in ys)-PAD, max(a.max() for a in ys)+PAD
SC = MS/max(WX1-WX0, WY1-WY0)
ox = MX+(MS-(WX1-WX0)*SC)/2; oy = MY+(MS-(WY1-WY0)*SC)/2
def px(X,Y): return (ox+(X-WX0)*SC, oy+(WY1-Y)*SC)

z=np.load(OUT/"_kd_graph.npz"); eu=z["eu"]; comp=z["comp"]; nlink=198459
lcomp = comp[eu[:nlink]]
fixed=np.load(CACHE/"ROAD_LINK.fixed.npy",mmap_mode="r")
geom=np.memmap(CACHE/"ROAD_LINK.geom.bin",dtype="<f8",mode="r",shape=(2049433,2))
goff=np.asarray(fixed["geom_off"],dtype="i8")//16; gn=np.asarray(fixed["geom_n"],dtype="i4")

# ---- 全域图：宽凳路网 ----
for i in range(nlink):
    n=int(gn[i])
    if n<2: continue
    o=int(goff[i]); X,Y=ll2xy(geom[o:o+n,0],geom[o:o+n,1])
    if X.max()<WX0 or X.min()>WX1 or Y.max()<WY0 or Y.min()>WY1: continue
    d.line(list(zip(*px(X,Y))), fill=(C_MAIN if lcomp[i]==0 else C_ISO), width=1, joint="curve")

# ---- 52 条路线（不可行 2 条加粗深红）----
RR = json.loads((OUT/"kd_report.json").read_text(encoding="utf-8"))
bad = {(L["street"], L["n"]) for L in RR["legs"] if L["km_kd"] is None}
for st in doc["routes"]:
    for ri,r in enumerate(st.get("routes") or []):
        X,Y=ll2xy([p[0] for p in r["poly"]],[p[1] for p in r["poly"]])
        isbad = (st["street"], ri+1) in bad
        d.line(list(zip(*px(X,Y))), fill=C_BAD if isbad else C_ROUTE, width=4 if isbad else 2)

# ---- 322 个锚点 ----
anch = RR["anchors"]
for a in anch:
    X,Y=px(*ll2xy(a["lon"],a["lat"])); off=a["off_m"]
    r=min(2.6+2.4*math.log10(1+off/40.0), 10)
    if off>500: d.ellipse([X-r-2.4,Y-r-2.4,X+r+2.4,Y+r+2.4], fill=(255,255,255))
    d.ellipse([X-r,Y-r,X+r,Y+r], fill=bin_of(off), outline=(255,255,255), width=1)

# 标注：北部孤片范围
sub=np.where(lcomp==17)[0]
if len(sub):
    Xa=[];Ya=[]
    for i in sub[:600]:
        n=int(gn[i]); o=int(goff[i]); X,Y=ll2xy(geom[o:o+n,0],geom[o:o+n,1]); Xa.append(X); Ya.append(Y)
    X0=min(a.min() for a in Xa); X1=max(a.max() for a in Xa); Y0=min(a.min() for a in Ya); Y1=max(a.max() for a in Ya)
    p1=px(X0,Y1); p2=px(X1,Y0)
    for t in range(0,240,2):
        a1=t/240*2*math.pi; a2=(t+0.8)/240*2*math.pi
        pass
    d.rectangle([p1[0],p1[1],p2[0],p2[1]], outline=(236,120,16), width=3)
    d.text(((p1[0]+p2[0])/2, p1[1]-10), "北部孤片 comp17", font=FB(19), fill=(180,70,0),
           anchor="mb", stroke_width=4, stroke_fill=(255,255,255))
else:
    X0=X1=Y0=Y1=0

# 比例尺
sx, sy = MX+40, MY+MS-24
d.line([sx,sy,sx+10000*SC,sy], fill=(40,44,54), width=3)
for e in (sx, sx+10000*SC): d.line([e,sy-7,e,sy+7], fill=(40,44,54), width=3)
d.text((sx+5000*SC, sy-13), "10 km", font=FB(19), fill=(40,44,54), anchor="mb", stroke_width=4, stroke_fill=(255,255,255))

# 图例（叠在地图左上空白处）
LX, LY = MX+34, MY+26
d.rounded_rectangle([LX, LY, LX+352, LY+296], 10, fill=(255,255,255), outline=(214,220,230), width=2)
yy = LY+22
for t,c,w in [("宽凳路网（主连通片 99.0%）", C_MAIN,3), ("宽凳孤片（其余 53 片）", C_ISO,3),
              ("{NLEGS} 条排班路线（高德）".replace("{NLEGS}", str(NLEGS)), C_ROUTE,3), ("{NBAD} 条无法落宽凳的腿".replace("{NBAD}", str(len(bad))), C_BAD,4)]:
    d.line([LX+14, yy, LX+46, yy], fill=c, width=w); d.text((LX+58, yy), t, font=F(17), fill=(40,46,58), anchor="lm")
    yy += 30
yy += 8
d.text((LX+14, yy), "锚点 = 离最近宽凳道路的距离", font=FB(17), fill=(24,28,36)); yy += 26
for a,b,c,t in BINS:
    d.ellipse([LX+20, yy-5, LX+32, yy+5], fill=c, outline=(255,255,255))
    d.text((LX+44, yy), t, font=F(16), fill=(40,46,58), anchor="lm"); yy += 26

# ---------------- 右栏 ----------------
yy = MY
# A 结论
d.rounded_rectangle([RX, yy, RX+RW, yy+300], 12, fill=(247,249,252), outline=(214,220,230), width=2)
d.text((RX+18, yy+16), "核查结论", font=FB(24), fill=(24,28,36)); y2 = yy+62
n_ok = sum(1 for L in RR["legs"] if L["km_kd"] is not None)
n_gt100 = sum(1 for a in anch if a["off_m"] > 100)
n_gt500 = sum(1 for a in anch if a["off_m"] > 500)
bad_list = sorted(bad)
bad_desc = "、".join(f"{s}路线{n}" for s, n in bad_list) if bad_list else "全部腿均可在宽凳上连通"
for big, sub, col in [(f"{n_ok} / {len(RR['legs'])}", "条腿的「起点+全部途经点+终点」\n都能在宽凳路网上连通", (16,130,74)),
                      (f"{n_gt100}", f"个锚点离最近宽凳路 > 100 m\n（{n_gt500} 个 > 500 m）", (200,110,0)),
                      (f"{len(bad_list)}", f"条腿无法在宽凳上连通\n→ {bad_desc}" if bad_list else "条腿无法在宽凳上连通（无）", (200,40,10))]:
    d.text((RX+18, y2-6), big, font=FB(32), fill=col)
    d.multiline_text((RX+150, y2), sub, font=F(17), fill=(70,78,92), spacing=5)
    y2 += 78
d.text((RX+18, y2-4), "宽凳图：175,134 节点 / 198,459 link / 54 连通片", font=F(16), fill=(110,118,132))
yy += 316

# B 最远锚点榜
d.rounded_rectangle([RX, yy, RX+RW, yy+446], 12, fill=(247,249,252), outline=(214,220,230), width=2)
d.text((RX+18, yy+16), "离宽凳路最远的锚点（补测 / 改点候选）", font=FB(21), fill=(24,28,36)); y2 = yy+56
for a in sorted(anch, key=lambda x:-x["off_m"])[:10]:
    nm=(a["name"] or a["label"])[:12]
    tag = "主片" if a["in_main"] else f"孤片{a['comp']}"
    d.text((RX+18, y2), f"{a['off_m']:>7.0f} m", font=FB(17), fill=bin_of(a["off_m"]))
    d.text((RX+128, y2), f"{a['street'][:4]}·{nm}", font=F(17), fill=(40,46,58))
    d.text((RX+RW-16, y2), tag, font=F(15), fill=(120,128,142), anchor="rt")
    y2 += 36
d.text((RX+18, y2+4), "全量 322 行：out/kd_anchor_issues.csv", font=F(16), fill=(110,118,132))
yy += 462

# C 孤片放大
d.rounded_rectangle([RX, yy, RX+RW, CH-FOOT-14], 12, fill=(255,253,250), outline=(240,214,170), width=2)
d.text((RX+18, yy+14), "为什么这 2 条不行：北部孤片", font=FB(21), fill=(170,70,0))
ISW = RW-36; ISH = 420; ISX = RX+18; ISY = yy+52
ki = min(ISW/(X1-X0), ISH/(Y1-Y0))
io = lambda X,Y: (ISX+ISW/2-((X0+X1)/2)*ki+X*ki, ISY+ISH/2+((Y0+Y1)/2)*ki-Y*ki)
for i in range(nlink):
    n=int(gn[i]); o=int(goff[i]); X,Y=ll2xy(geom[o:o+n,0],geom[o:o+n,1])
    if X.max()<X0-500 or X.min()>X1+500 or Y.max()<Y0-500 or Y.min()>Y1+500: continue
    d.line(list(zip(*io(X,Y))), fill=(C_ISO if lcomp[i]==17 else C_MAIN), width=2 if lcomp[i]==17 else 1, joint="curve")
for st in doc["routes"]:
    for ri,r in enumerate(st.get("routes") or []):
        X,Y=ll2xy([p[0] for p in r["poly"]],[p[1] for p in r["poly"]])
        if X.max()<X0-500 or X.min()>X1+500 or Y.max()<Y0-500 or Y.min()>Y1+500: continue
        isbad=(st["street"],ri+1) in bad
        d.line(list(zip(*io(X,Y))), fill=C_BAD if isbad else C_ROUTE, width=3 if isbad else 2)
for a in anch:
    X,Y=ll2xy(a["lon"],a["lat"])
    if not (X0<X<X1 and Y0<Y<Y1): continue
    q=io(X,Y); r=5.5 if a["off_m"]>1000 else 4
    d.ellipse([q[0]-r-2,q[1]-r-2,q[0]+r+2,q[1]+r+2], fill=(255,255,255))
    d.ellipse([q[0]-r,q[1]-r,q[0]+r,q[1]+r], fill=bin_of(a["off_m"]))
for nm,lo,la in [("芦岚中学","114.6101","23.4021"),("横沥镇","114.6130","23.1560"),("芦洲镇","114.5300","23.3684")]:
    q=io(*ll2xy(float(lo),float(la)))
    if ISX<q[0]<ISX+ISW and ISY<q[1]<ISY+ISH:
        d.text(q, nm, font=FB(17), fill=(60,66,80), anchor="mt", stroke_width=4, stroke_fill=(255,255,255))
d.rectangle([ISX, ISY, ISX+ISW, ISY+ISH], outline=(226,214,196), width=1)
y3 = ISY+ISH+12
d.multiline_text((RX+18, y3),
 ("橙色 = 孤片17：横沥→芦洲沿高速的 6.2 × 19.9 km 线性走廊，与主网不连通。\n"
  "2026-10-19 腿级宽凳闸门 + 盲区锚点贪心摘除后：落此走廊的服务点已被\n"
  "剔除（横沥/沥林 kd-gap）或摘锚（马安路线3），全部 41 条腿均可落在\n"
  "宽凳主网上。若未来要恢复横沥/沥林排班，须先请宽凳补测该走廊。"
  if not bad_list else
  "橙色 = 孤片17：横沥→芦洲沿高速的一条 6.2 × 19.9 km 线性走廊，\n"
  "与主网（灰）不连通，共 1,389 个节点。两条腿的服务点全落在这条\n"
  "走廊上，车无论如何规划都要离开宽凳 —— 只能请宽凳补测该走廊，\n"
  "或把这些服务点挪到主网上。"), font=F(16), fill=(120,90,60), spacing=5)

d.rectangle([0,0,CW,HEAD], fill=(17,24,39))
d.text((26,12), "以宽凳为限定的排班线可行性核查", font=FB(32), fill=(255,255,255))
d.text((26,56), "条件：起点 / 途经点 / 终点一个不改，路径只能在宽凳 ROAD_LINK 拓扑网上走（175k 节点最短路，含权重缺缝补边）",
       font=F(18), fill=(150,163,184))
d.rectangle([0,CH-FOOT,CW,CH], fill=(246,248,251))
d.text((26,CH-30), "底图：宽凳交付 GCJ02/AuditSpec/kxf/441302 · ROAD_LINK（含 PRE_ID/NEXT_ID 拓扑）｜ 路线：高德驾车折线 out/routes.json",
       font=F(16), fill=(120,128,142))
im.save(OUT/"kd_feasibility.png"); print("[out]", im.size)
