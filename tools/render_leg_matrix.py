# -*- coding: utf-8 -*-
"""52 条排班线 × 逐段「能否落上宽凳」状态矩阵。
每格 = 一对相邻锚点（起点→途经1→途经2…→终点）之间那一段路。
A 严格贴合 / B 可用（要放宽走廊或锚点接驳）/ C 勉强 / D 宽凳不通。
输出：out/kd_leg_matrix.png
"""
import json, math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

OUT = Path("out")
F = lambda n: ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", n)
FB = lambda n: ImageFont.truetype("C:/Windows/Fonts/msyhbd.ttc", n)

S = json.load(open(OUT / "kd_corridor_summary.json", encoding="utf-8"))
C = json.load(open(OUT / "kd_corridor.json", encoding="utf-8"))
segs = {}
for s in S["segs"]:
    segs.setdefault((s["street"], s["n"]), []).append(s)
for k in segs:
    segs[k].sort(key=lambda s: s["k"])
legs = S["legs"]
COL = {"A": (74, 148, 106), "B": (150, 184, 74), "C": (230, 166, 18), "D": (214, 34, 34)}
TXT = {"A": (255, 255, 255), "B": (40, 52, 20), "C": (60, 44, 0), "D": (255, 255, 255)}
NAME = {"A": "严格贴合：走廊 ≤80 m、锚点 ≤100 m、里程不缩水",
        "B": "可用：走廊 ≤350 m 或锚点接驳 ≤500 m",
        "C": "勉强：抄近道或锚点离网 >500 m",
        "D": "不可：走廊内宽凳不连通 —— 宽凳真没有"}

CW = 1920
RH, HDR = 26, 150
FOOT = 150
CH = HDR + RH * len(legs) + FOOT
im = Image.new("RGB", (CW, CH), (255, 255, 255)); d = ImageDraw.Draw(im)

LX, LW = 18, 270          # 左：街道+腿
GX, GW = LX + LW + 8, 124  # 格
NCOL = 9
TX = GX + GW * NCOL + 16  # 右：里程
TW = CW - TX - 18

d.text((LX, 24), "52 条排班线：逐段能不能落上宽凳？", font=FB(32), fill=(26, 30, 40))
d.text((LX, 68), "每一格 = 相邻两个锚点之间那一段。绿可原样落；黄绿需放宽；橙需接驳/抄近道；"
                 "红 = 宽凳在那段不连通（要补测或改点）", font=F(18), fill=(96, 102, 114))
d.text((LX, 92), f"全腿可落 {sum(1 for L in legs if L['tier'] in 'AB')} / 52 条"
                 f"（其中 {sum(1 for L in legs if L['tier']=='A')} 条全段严格贴合）；"
                 f"存在红线段的 {sum(1 for L in legs if L['tier']=='D')} 条", font=F(18), fill=(150, 60, 40))

for j in range(NCOL):
    d.text((GX + GW * j + GW / 2, HDR - 22), f"段{j+1}", font=FB(16), fill=(90, 96, 108), anchor="mm")
d.text((TX + 6, HDR - 22), "高德 / 贴合 km", font=FB(15), fill=(90, 96, 108))
d.text((TX + 158, HDR - 22), "可落段", font=FB(15), fill=(90, 96, 108))
d.text((TX + 252, HDR - 22), "需补测/改点", font=FB(15), fill=(90, 96, 108))
d.text((GX - 8, HDR - 22), "镇街 · 腿号", font=FB(16), fill=(90, 96, 108), anchor="rm")

y = HDR
prev = None
for L in legs:
    st, n = L["street"], L["n"]
    S_ = segs[(st, n)]
    if prev is not None and st != prev:
        d.line([LX, y - 1, CW - 18, y - 1], fill=(210, 216, 226), width=2)
    d.rectangle([LX, y + 1, LX + LW - 8, y + RH - 1],
                fill=(245, 247, 250) if st != prev else (255, 255, 255))
    d.text((LX + 8, y + RH / 2), st, font=FB(17), fill=(34, 40, 52), anchor="lm")
    d.text((LX + 108, y + RH / 2), f"腿 {n}", font=F(17), fill=(90, 96, 108), anchor="lm")
    tot = L.get("km_corr")
    d.text((LX + 176, y + RH / 2), f"{L['km_amap']:.0f} km", font=F(16),
           fill=(90, 96, 108), anchor="lm")
    for k, s in enumerate(S_):
        t = s["tier"]
        x0 = GX + GW * k
        d.rectangle([x0 + 2, y + 3, x0 + GW - 4, y + RH - 3], fill=COL[t])
        lab = f"{s['km_amap']:.1f}" if s["km_amap"] >= 0.1 else "~0"
        d.text((x0 + GW / 2, y + RH / 2), lab, font=FB(15), fill=TXT[t], anchor="mm")
        if t == "D":
            d.text((x0 + GW / 2, y + RH / 2 + 9), "✕", font=FB(13), fill=(255, 220, 220), anchor="mm")
    if tot:
        d.text((TX + 6, y + RH / 2), f"{L['km_amap']:.1f} / {tot:.1f}", font=F(16),
               fill=(34, 40, 52), anchor="lm")
    else:
        d.text((TX + 6, y + RH / 2), f"{L['km_amap']:.1f} / —", font=F(16),
               fill=(190, 60, 50), anchor="lm")
    d.text((TX + 158, y + RH / 2), f"{L['ok_segs']}/{L['nseg']}", font=F(16),
           fill=(110, 118, 130), anchor="lm")
    if L["tier"] == "D":
        nbad = sum(1 for s in S_ if s["tier"] == "D")
        kb = sum(s["km_amap"] for s in S_ if s["tier"] == "D")
        d.text((TX + 252, y + RH / 2), f"{nbad} 段 / {kb:.1f} km", font=FB(15),
               fill=(200, 40, 40), anchor="lm")
    prev = st
    y += RH

# 页脚图例
fy = y + 22
d.line([LX, fy - 12, CW - 18, fy - 12], fill=(210, 216, 226), width=2)
for k, t in enumerate("ABCD"):
    xx = LX + k * 478
    d.rectangle([xx, fy + 10, xx + 34, fy + 34], fill=COL[t])
    d.text((xx + 44, fy + 12), NAME[t], font=F(16), fill=(60, 66, 78))
    d.text((xx + 44, fy + 32), "", font=F(14), fill=(140, 146, 156))
d.text((LX, fy + 72), "格内数字 = 该段高德里程(km)。最右「缺 N 段 / X km」= 该腿因宽凳不连通而必须补测或改点的里程。",
       font=F(16), fill=(120, 126, 138))
d.text((LX, fy + 96), "口径：高德 polyline 逐点判 30 m 贴合率 + 以该段走廊（半径 30→350 m 逐级放宽）内的宽凳子图求最短路；"
                      "锚点吸附距离、贴合后里程缩水比例用于分档。", font=F(15), fill=(150, 156, 166))

im.save(OUT / "kd_leg_matrix.png")
print(f"[out] out/kd_leg_matrix.png {im.size}")
