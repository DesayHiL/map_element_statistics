# -*- coding: utf-8 -*-
"""「以宽凳为标准」：高德规划路线在宽凳上查不到的那一段 —— 补测需求图。
左：全域图。宽凳路网淡灰底；高德 52 条路线按 30 m 门限分色 ——
    贴合段（绿）/ 缺失段（红，宽凳没有对应路）。
右：结论卡 / 缺失里程按镇排行 / 最长缺失段位置说明。
输出：out/kd_route_gap.png
"""
import json, math
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree
from PIL import Image, ImageDraw, ImageFont

OUT = Path(r"D:/workspace/map_element_statistics/out")
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0
def ll2xy(lon, lat): return (np.asarray(lon, "f8") - LON0) * MLON, (np.asarray(lat, "f8") - LAT0) * MLAT
F = lambda n: ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", n)
FB = lambda n: ImageFont.truetype("C:/Windows/Fonts/msyhbd.ttc", n)

THR = 30.0
CW, CH = 1920, 1680
HEAD, FOOT = 104, 44
MX, MY, MS = 16, HEAD + 16, 1330
RX, RW = MX + MS + 34, CW - (MX + MS + 34) - 16
C_NET, C_HIT, C_MISS = (198, 206, 218), (52, 148, 96), (216, 30, 30)

im = Image.new("RGB", (CW, CH), (255, 255, 255)); d = ImageDraw.Draw(im)

# ---------- 宽凳顶点树 ----------
fixed = np.load(CACHE / "ROAD_LINK.fixed.npy", mmap_mode="r")
gn = np.asarray(fixed["geom_n"], dtype="i4")
goff = np.asarray(fixed["geom_off"], dtype="i8") // 16
geom = np.memmap(CACHE / "ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
gX, gY = ll2xy(geom[:, 0], geom[:, 1])
vtree = cKDTree(np.stack([gX, gY], axis=1))
nlink = len(gn)

# ---------- 高德路线 + 逐点贴合判定 ----------
doc = json.load(open(OUT / "routes.json", encoding="utf-8"))
legs = []
for st in doc["routes"]:
    for i, lg in enumerate(st.get("routes", []), start=1):
        P = lg["poly"]
        X, Y = ll2xy([p[0] for p in P], [p[1] for p in P])
        XY = np.stack([X, Y], axis=1)
        dist, _ = vtree.query(XY)
        legs.append(dict(street=st["street"], n=i, XY=XY, hit=dist <= THR, d=dist))

xs = np.concatenate([L["XY"][:, 0] for L in legs]); ys = np.concatenate([L["XY"][:, 1] for L in legs])
PAD = 8000.0
WX0, WX1 = xs.min() - PAD, xs.max() + PAD
WY0, WY1 = ys.min() - PAD, ys.max() + PAD
SC = MS / max(WX1 - WX0, WY1 - WY0)
ox = MX + (MS - (WX1 - WX0) * SC) / 2; oy = MY + (MS - (WY1 - WY0) * SC) / 2
def px(X, Y): return (ox + (X - WX0) * SC, oy + (WY1 - Y) * SC)
def seg_pts(XY):
    return list(zip(*px(XY[:, 0], XY[:, 1])))

# ---------- 左：宽凳路网 ----------
for i in range(nlink):
    n = int(gn[i])
    if n < 2: continue
    o = int(goff[i])
    X, Y = gX[o:o + n], gY[o:o + n]
    if X.max() < WX0 or X.min() > WX1 or Y.max() < WY0 or Y.min() > WY1: continue
    d.line(seg_pts(np.stack([X, Y], axis=1)), fill=C_NET, width=1, joint="curve")

# ---------- 左：路线分色（先绿后红，红压在上面） ----------
miss_poly = []
tot_km = 0.0
for L in legs:
    XY, hit = L["XY"], L["hit"]
    seg = np.hypot(*np.diff(XY, axis=0).T) / 1000.0
    tot_km += float(seg.sum())
    k = 0
    while k < len(hit):
        j = k
        while j + 1 < len(hit) and hit[j + 1] == hit[k]: j += 1
        pts = seg_pts(XY[k:j + 2])
        if hit[k]:
            if len(pts) > 1: d.line(pts, fill=C_HIT, width=2, joint="curve")
        else:
            if len(pts) > 1:
                d.line(pts, fill=C_MISS, width=4, joint="curve")
                miss_poly.append(XY[k:j + 2])
        k = j + 1

# 缺失里程（统一口径：小段任一端点离宽凳 >30 m 即计入）
tot_miss = 0.0
agg0 = {}
for L in legs:
    XY, hit = L["XY"], L["hit"]
    seg = np.hypot(*np.diff(XY, axis=0).T) / 1000.0
    bad = (~hit[:-1]) | (~hit[1:])
    tot_miss += float(seg[bad].sum())
    agg0[L["street"]] = agg0.get(L["street"], 0.0) + float(seg[bad].sum())

# 四个重点镇：在缺失段质心打点标注（不用大框，避免互相压盖）
KEY = ["芦洲镇", "沥林镇", "横沥镇", "潼湖镇"]
for town in KEY:
    pts = np.concatenate([L["XY"][~L["hit"]] for L in legs if L["street"] == town])
    if not len(pts): continue
    cx, cy = np.median(pts[:, 0]), np.median(pts[:, 1])
    X, Y = px(cx, cy)
    d.ellipse([X - 7, Y - 7, X + 7, Y + 7], fill=C_MISS, outline=(255, 255, 255), width=2)
    d.text((X + 12, Y), f"{town} {agg0[town]:.0f} km", font=FB(19), fill=C_MISS,
           anchor="lm", stroke_width=5, stroke_fill=(255, 255, 255))

# 比例尺
sx, sy = MX + 26, MY + MS - 34
d.line([sx, sy, sx + 10000 * SC, sy], fill=(40, 44, 54), width=5)
d.line([sx, sy - 7, sx, sy + 7], fill=(40, 44, 54), width=3)
d.line([sx + 10000 * SC, sy - 7, sx + 10000 * SC, sy + 7], fill=(40, 44, 54), width=3)
d.text((sx + 5000 * SC, sy - 13), "10 km", font=FB(19), fill=(40, 44, 54), anchor="mb",
       stroke_width=4, stroke_fill=(255, 255, 255))

# 图例
lx, ly = MX + 22, MY + 18
items = [("宽凳路网（5,780 km）", C_NET, 3),
         ("高德路线 · 宽凳有对应路（贴合）", C_HIT, 4),
         ("高德路线 · 宽凳查不到（>30 m）", C_MISS, 4)]
d.rectangle([lx - 10, ly - 10, lx + 470, ly + 26 * len(items) + 6], fill=(255, 255, 255),
            outline=(214, 220, 230))
for k, (txt, col, w) in enumerate(items):
    yy = ly + 12 + 26 * k
    d.line([lx, yy, lx + 40, yy], fill=col, width=w)
    d.text((lx + 52, yy), txt, font=F(18), fill=(44, 48, 58), anchor="lm")

# ---------- 表头 / 页脚 ----------
d.text((MX + 2, 22), "以宽凳为标准：高德规划路线哪一段宽凳没有？", font=FB(33), fill=(26, 30, 40))
d.text((MX + 2, 66), f"逐点比对 52 条排班线（{len(legs)} 腿 / {tot_km:.0f} km）到最近宽凳 ROAD_LINK 的距离；"
                     f"超过 {THR:.0f} m 即判为「宽凳查不到」", font=F(19), fill=(96, 102, 114))
d.text((MX + 2, CH - 32), "数据：宽凳 ROAD_LINK 交付 SHP（198,459 link / 5,780.2 km，GCJ02）· "
                          "高德路线取自已归档的 out/routes.json polyline", font=F(17), fill=(130, 136, 148))

# ---------- 右栏 ----------
y = MY
def card(x, y, w, h, fill, edge=(224, 230, 238)):
    d.rounded_rectangle([x, y, x + w, y + h], radius=10, fill=fill, outline=edge, width=2)

# 结论卡
card(RX, y, RW, 176, (250, 251, 253))
d.text((RX + 18, y + 14), "核查结论", font=FB(21), fill=(38, 44, 56))
d.text((RX + 18, y + 50), f"{tot_miss:.0f} km", font=FB(46), fill=C_MISS)
d.text((RX + 22 + d.textlength(f"{tot_miss:.0f} km", font=FB(46)), y + 68),
       f"/ {tot_km:.0f} km", font=F(23), fill=(120, 126, 138))
d.text((RX + 18, y + 112), f"高德路线的 {100*tot_miss/tot_km:.1f}% 在宽凳上找不到对应道路",
       font=F(18), fill=(52, 58, 70))
d.text((RX + 18, y + 140), "全部 18 个镇街都有，但集中在 4 个镇", font=F(18), fill=(52, 58, 70))
y += 196

# 按镇排行（与 tot_miss 同一口径：小段任一端口落在宽凳 30 m 外即计入）
rank = sorted(agg0.items(), key=lambda x: -x[1])
card(RX, y, RW, 42 + 27 * len(rank), (255, 255, 255))
d.text((RX + 18, y + 12), "宽凳查不到的里程 · 按镇街", font=FB(20), fill=(38, 44, 56))
mx = rank[0][1]
for k, (st, km) in enumerate(rank):
    yy = y + 48 + 27 * k
    d.text((RX + 18, yy), st, font=F(17), fill=(52, 58, 70), anchor="lm")
    bar = 300 * km / mx
    col = C_MISS if km > 20 else ((228, 140, 10) if km > 5 else (190, 198, 210))
    d.rectangle([RX + 118, yy - 7, RX + 118 + max(bar, 2), yy + 7], fill=col)
    d.text((RX + RW - 18, yy), f"{km:.1f}", font=F(17), fill=(60, 66, 78), anchor="rm")
y += 42 + 27 * len(rank) + 20

# 说明
card(RX, y, RW, CH - FOOT - y - 8, (252, 248, 244), (238, 226, 212))
d.text((RX + 18, y + 14), "怎么用这张图", font=FB(20), fill=(120, 66, 16))
top4 = rank[:4]
k4 = sum(v for _, v in top4)
rest = len(rank) - 4
lines = [
    "红线段 = 高德规划里走了、但宽凳没采的路。",
    "绿线段 = 宽凳有对应道路，排班线可以直接落上去。",
    "",
    f"这 4 个镇占缺口的 {100*k4/tot_miss:.0f}%：",
    "  " + "、".join(f"{s} {v:.1f}" for s, v in top4) + " km",
    "这四片要么请宽凳补测，要么把服务点挪到宽凳有的路网上。",
    "",
    f"其余 {rest} 个镇街合计 {tot_miss-k4:.1f} km 缺口，且多为",
    "几十米~几百米的零碎缝（宽凳 digitizing 接缝），",
    "通常人工接一下即可，不必等补测。",
]
for k, t in enumerate(lines):
    d.text((RX + 18, y + 48 + 25 * k), t, font=F(16), fill=(90, 62, 30))

im.save(OUT / "kd_route_gap.png")
print(f"[out] out/kd_route_gap.png {im.size}")
print(f"总里程 {tot_km:.1f} km  缺失 {tot_miss:.1f} km ({100*tot_miss/tot_km:.1f}%)")
print("按镇街:", "  ".join(f"{s} {k:.1f}" for s, k in rank[:6]))
