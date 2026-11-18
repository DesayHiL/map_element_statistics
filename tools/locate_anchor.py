# -*- coding: utf-8 -*-
"""锚点法：用截图红线的"最北点"锚定 芦洲镇路线1，扫尺度，看灰网与红线是否同时对齐。

动机：倒角匹配的反项被同一条长腿的自相靠近污染（芦洲路线1 有 87km，南段回城）。
锚点法把平移自由度降为 1（只沿腿滑动），尺度自由度用"红线正项"打分，
再用灰网重投影（把主图灰网按同尺度降到截图尺寸）人工/数值复合验证。
"""
import argparse, json, math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0
W, PAD_M = 5200, 8000.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("img")
    ap.add_argument("--street", default="芦洲镇")
    ap.add_argument("--n", type=int, default=1)
    ap.add_argument("--kmin", type=float, default=2.0)
    ap.add_argument("--kmax", type=float, default=4.2)
    ap.add_argument("--nk", type=int, default=12)
    ap.add_argument("--slide", type=int, default=40)
    A = ap.parse_args()

    doc = json.loads((OUT / "routes.json").read_text(encoding="utf-8"))
    xs, ys = [], []
    for st in doc["routes"]:
        for r in st["routes"]:
            P = np.asarray(r["poly"], "f8")
            xs.append((P[:, 0]-LON0)*MLON); ys.append((P[:, 1]-LAT0)*MLAT)
    x0 = min(a.min() for a in xs)-PAD_M; x1 = max(a.max() for a in xs)+PAD_M
    y0 = min(a.min() for a in ys)-PAD_M; y1 = max(a.max() for a in ys)+PAD_M
    span = x1-x0; H = int(round(W*(y1-y0)/span))

    seg = next(s for s in doc["routes"] if s["street"] == A.street)["routes"][A.n-1]
    P = np.asarray(seg["poly"], "f8")
    px = (P[:, 0]-LON0)*MLON; py = (P[:, 1]-LAT0)*MLAT
    cx = (px-x0)/span*W; cy = (y1-py)/(y1-y0)*H
    print(f"[leg] {A.street} 路线{A.n}  {len(P)} 顶点  画布 bbox x{cx.min():.0f}~{cx.max():.0f} y{cy.min():.0f}~{cy.max():.0f}")

    shot = Image.open(A.img).convert("RGB")
    s = np.asarray(shot).astype(int)
    Rr, Gg, Bb = s[:, :, 0], s[:, :, 1], s[:, :, 2]
    rm = (Rr > 175) & (Gg < 56) & (Bb < 52) & (Rr-Gg > 100) & (Rr-Bb > 110)
    th, tw = rm.shape
    ys_, xs_ = np.nonzero(rm)
    tip_s = (int(xs_[ys_.argmin()]), int(ys_.min()))     # 截图红线最北点
    print(f"[shot] {tw}x{th}  路线红 {int(rm.sum()):,}  最北点 {tip_s}")

    tip_c = (float(cx[cy.argmin()]), float(cy.min()))     # 腿最北点
    print(f"[tip] 腿最北点 画布 ({tip_c[0]:.0f},{tip_c[1]:.0f})")

    base = Image.open(OUT / "_grey_clean.png").convert("RGB")
    res = []
    for k in np.linspace(A.kmin, A.kmax, A.nk):
        # 锚点：腿最北点 ↔ 截图最北点，得到截图(0,0)在画布上的位置
        ox = tip_c[0]-tip_s[0]*k; oy = tip_c[1]-tip_s[1]*k
        # 每尺度只算一次：把整条腿按 1/k 光栅化到"截图像素"坐标，再求距离变换
        MX, MY = 260, 260                      # 四周余量（截图像素）
        iw, ih = int(round(tw*k))+2*MX, int(round(th*k))+2*MY
        ref = Image.new("L", (iw, ih), 0); dr = ImageDraw.Draw(ref)
        dr.line(list(zip(((cx-(ox-MX*k))/k).tolist(), ((cy-(oy-MY*k))/k).tolist())),
                fill=255, width=max(1, int(round(3.4*k))), joint="curve")
        Dl = ndimage.distance_transform_edt(np.asarray(ref) < 96).astype(np.float32)
        best = None
        for dx in range(0, 2*MX+1, 4):
            for dy in range(0, 2*MY+1, 4):
                w_ = Dl[dy:dy+th, dx:dx+tw]
                if w_.shape[0] < th or w_.shape[1] < tw:
                    continue
                fwd = float(w_[rm].mean())
                if best is None or fwd < best[0]:
                    best = (fwd, ox+dx-MX*k, oy+dy-MY*k, k)
        if best:
            res.append(best)
    res.sort(key=lambda z: z[0])
    print("\n尺度扫描（正项=截图红px→该腿的平均距离）")
    for fwd, cx0, cy0, k in res:
        print(f"  k={k:4.2f}  正={fwd:6.2f}px  画布左上({cx0:.0f},{cy0:.0f})")

    n = min(6, len(res)); cols = 2; rows = (n+cols-1)//cols
    pad, lab = 8, 18
    cw, ch = tw*2+pad, th+lab
    sheet = Image.new("RGB", (cols*cw+pad*(cols+1), rows*ch+pad*(rows+1)), (238, 240, 244))
    dd = ImageDraw.Draw(sheet)
    for idx, (fwd, cx0, cy0, k) in enumerate(res[:n]):
        iw, ih = int(round(tw*k)), int(round(th*k))
        crop = base.crop((int(cx0), int(cy0), int(cx0)+iw, int(cy0)+ih))
        crop = Image.blend(Image.new("RGB", (iw, ih), (255, 255, 255)), crop, 0.45)
        dv = ImageDraw.Draw(crop)
        dv.line(list(zip(((cx-cx0)/k).tolist(), ((cy-cy0)/k).tolist())),
                fill=(222, 28, 8), width=max(1, int(round(3.4*k))), joint="curve")
        crop = crop.resize((tw, th), Image.LANCZOS)
        r_, c_ = divmod(idx, cols)
        ox2 = pad+c_*(cw+pad); oy2 = pad+r_*(ch+pad)
        sheet.paste(crop, (ox2, oy2+lab)); sheet.paste(shot, (ox2+tw+pad, oy2+lab))
        dd.text((ox2+2, oy2+3), f"#{idx} k={k:.2f} 正={fwd:.2f}px", fill=(30, 34, 44))
    sheet.save(OUT / "_cand_anchor.png")
    print(f"\n联络表 → out/_cand_anchor.png（左=主图同尺度裁剪+红线，右=截图）")


if __name__ == "__main__":
    main()
