# -*- coding: utf-8 -*-
"""回答「排班路线哪里不在宽凳地图上」：把 52 条路线按"离灰网>200m / 在灰网上"两色画出。

- 数据全部来自主图自己的画布坐标（RTB 折线 + 内嵌灰底栅格），无投影假设。
- 上图：全区；下图：东北角（芦洲/横沥）放大。
输出 out/offgrey_routes.png
"""
import re, json, math, io
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

FONT = None
for fp in [r"C:/Windows/Fonts/msyh.ttc", r"C:/Windows/Fonts/msyhbd.ttc", r"C:/Windows/Fonts/simhei.ttf"]:
    try:
        FONT = ImageFont.truetype(fp, 30); FONT_S = ImageFont.truetype(fp, 24); break
    except Exception:
        continue
if FONT is None:
    FONT = FONT_S = ImageFont.load_default()

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
PREC = 10.0
C_ON, C_OFF, C_GRID = (16, 130, 74), (222, 28, 8), (150, 158, 172)
M_PER_PX = 12.69


def dec_paths(b64):
    s = base64.b64decode(b64); L = len(s); p = 0
    def uv():
        nonlocal p
        r = 0; sh = 1
        while True:
            b = s[p]; p += 1; r += (b & 127)*sh; sh *= 128
            if not (b & 128):
                break
        return r
    def sv():
        u = uv(); return -((u+1)//2) if (u & 1) else (u//2)
    out = []
    while p < L:
        n = uv(); x = sv(); y = sv(); pts = [(x/PREC, y/PREC)]
        for _ in range(n-1):
            x += sv(); y += sv(); pts.append((x/PREC, y/PREC))
        out.append(np.array(pts, "f8"))
    return out


import base64
h = (OUT/"route_kuandeng_routes.html").read_text(encoding="utf-8")
RT = dec_paths(re.search(r'RTB\s*=\s*"([A-Za-z0-9+/=]+)"', h).group(1))
emb = Image.open(io.BytesIO(base64.b64decode(
    re.search(r'data:image/png;base64,([A-Za-z0-9+/=]+)', h).group(1)))).convert("RGB")
G = np.asarray(emb).astype(int)
edt = ndimage.distance_transform_edt(~(G.sum(axis=2) < 700))*M_PER_PX

rows = json.load(open(OUT/"_offgrey_by_leg.json", encoding="utf-8"))
name_by_bbox = {}
# 用 offgrey 的顺序（= decode_rt 的配对顺序）直接一一对应
for r, P in zip(rows, RT):
    name_by_bbox[r["name"]] = P

W0, H0 = 5200, 5201
S = 0.5
Wn, Hn = int(W0*S), int(H0*S)
base = emb.resize((Wn, Hn), Image.BOX)
base = Image.blend(Image.new("RGB", (Wn, Hn), (255, 255, 255)), base, 0.75)
canv = base.copy()
d = ImageDraw.Draw(canv)

tot_on = tot_off = 0.0
for name, P in name_by_bbox.items():
    n = max(2, int(np.hypot(*np.diff(P, axis=0).T).sum()))
    s = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
    u = np.linspace(0, s[-1], n)
    xx = np.interp(u, s, P[:, 0]); yy = np.interp(u, s, P[:, 1])
    dd = edt[np.clip(np.round(yy).astype(int), 0, edt.shape[0]-1),
             np.clip(np.round(xx).astype(int), 0, edt.shape[1]-1)]
    off = dd > 200
    w = np.gradient(u)*M_PER_PX
    tot_off += w[off].sum()/1000; tot_on += w[~off].sum()/1000
    # 分段画：按 off 的连续块
    i = 0
    while i < n-1:
        j = i
        while j+1 < n and off[j+1] == off[i]:
            j += 1
        seg = np.column_stack([xx[i:j+2]*S, yy[i:j+2]*S])
        if len(seg) >= 2:
            d.line(list(zip(seg[:, 0].tolist(), seg[:, 1].tolist())),
                   fill=(C_OFF if off[i] else C_ON), width=3, joint="curve")
        i = j+1

# 图例
lg = Image.new("RGB", (900, 250), (255, 255, 255))
dl = ImageDraw.Draw(lg)
dl.rectangle([0, 0, 899, 249], outline=(220, 224, 230), width=2)
dl.line([28, 45, 118, 45], fill=C_ON, width=8)
dl.text((140, 28), "走在宽凳路网上（灰底有路）    %.0f km" % tot_on, fill=(30, 34, 44), font=FONT)
dl.line([28, 105, 118, 105], fill=C_OFF, width=8)
dl.text((140, 88), "离开宽凳路网 >200 m         %.0f km" % tot_off, fill=(200, 30, 12), font=FONT)
dl.line([28, 165, 118, 165], fill=C_GRID, width=5)
dl.text((140, 148), "宽凳 ROAD_LINK（惠城区全部 161,334 条）", fill=(30, 34, 44), font=FONT_S)
dl.text((140, 200), "52 条排班路线共 %.1f km · 离网占 %.1f%%"
        % (tot_on+tot_off, 100*tot_off/(tot_on+tot_off)), fill=(120, 126, 138), font=FONT_S)
canv.paste(lg, (30, 30))

# 主要盲区标注
for txt, xx, yy in [("芦洲镇 · 宽凳无数据", 3550, 300), ("沥林镇", 1250, 4050),
                    ("潼湖镇", 1900, 4250), ("横沥镇", 3520, 2250)]:
    d = ImageDraw.Draw(canv)
    d.text((xx*S, yy*S), txt, fill=(200, 30, 12), font=FONT_S)

canv.save(OUT/"offgrey_routes.png")

# 东北角放大（芦洲/横沥）
zoom = (3200, 450, 4850, 2150)
z = canv.crop((int(zoom[0]*S), int(zoom[1]*S), int(zoom[2]*S), int(zoom[3]*S)))
z = z.resize((int(z.size[0]*1.5), int(z.size[1]*1.5)), Image.LANCZOS)
z.save(OUT/"offgrey_routes_ne.png")
print(f"[out] out/offgrey_routes.png {canv.size}   out/offgrey_routes_ne.png {z.size}")
print(f"在网 {tot_on:.1f} km / 离网>200m {tot_off:.1f} km  (离网 {100*tot_off/(tot_on+tot_off):.1f}%)")
