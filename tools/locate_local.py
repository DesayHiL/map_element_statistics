# -*- coding: utf-8 -*-
"""限定区域定位截图（芦洲/横沥 一带）。

前几轮全图匹配失败的原因：红线掩膜全图只有 ~1200px，太稀疏。
本脚本改用「灰网灰度图」并在芦洲包围盒内搜索，且**把参照按 k 降采样到截图尺度**再滑动，
这样灰线的"发虚"程度与截图一致（截图灰 ≈ 宽凳灰混白 58%，说明灰线在屏幕上不足 1px）。

参照 x：main view 5200x5201，PAD_M=8000；只取芦洲路线1 包围盒 + 600px 边距。
score: 归一化互相关 NCC（FFT）。
"""
import argparse, json, math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy.signal import fftconvolve

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0
W, PAD_M = 5200, 8000.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("img")
    ap.add_argument("--kmin", type=float, default=3.0)
    ap.add_argument("--kmax", type=float, default=9.0)
    ap.add_argument("--nk", type=int, default=25)
    ap.add_argument("--top", type=int, default=9)
    A = ap.parse_args()

    doc = json.loads((OUT / "routes.json").read_text(encoding="utf-8"))
    xs, ys = [], []
    for st in doc["routes"]:
        for r in st["routes"]:
            P = np.asarray(r["poly"], "f8")
            xs.append((P[:, 0] - LON0) * MLON); ys.append((P[:, 1] - LAT0) * MLAT)
    x0 = min(a.min() for a in xs) - PAD_M; x1 = max(a.max() for a in xs) + PAD_M
    y0 = min(a.min() for a in ys) - PAD_M; y1 = max(a.max() for a in ys) + PAD_M
    span = x1 - x0; H = int(round(W * (y1 - y0) / span))

    # 搜索区：芦洲镇全部路线包围盒 + 600px
    lz = []
    for st in doc["routes"]:
        if st["street"] not in ("芦洲镇", "横沥镇"):
            continue
        for r in st["routes"]:
            P = np.asarray(r["poly"], "f8")
            lz.append(np.column_stack([(P[:, 0]-LON0)*MLON, (P[:, 1]-LAT0)*MLAT]))
    L = np.concatenate(lz)
    f = lambda X, Y: ((X - x0) / span * W, (y1 - Y) / (y1 - y0) * H)
    px, py = f(L[:, 0], L[:, 1])
    m = 600
    sx0, sx1 = int(max(0, px.min()-m)), int(min(W, px.max()+m))
    sy0, sy1 = int(max(0, py.min()-m)), int(min(H, py.max()+m))
    print(f"[search] 画布 ({sx0},{sy0})-({sx1},{sy1})  {sx1-sx0}x{sy1-sy0}")

    base = Image.open(OUT / "_grey_clean.png").convert("RGB").crop((sx0, sy0, sx1, sy1))
    b = np.asarray(base).astype(float)
    red = (b[:, :, 0] > 175) & (b[:, :, 1] < 56) & (b[:, :, 2] < 52)
    greyn = (255.0 - b.mean(axis=2)) * (~red)          # 灰线强度
    greyn = np.where(greyn < 8, 0.0, greyn)
    BH, BW = greyn.shape
    print(f"[ref] 灰网灰度 {BW}x{BH}  灰像素 {int((greyn>0).sum()):,}")

    s = np.asarray(Image.open(A.img).convert("RGB")).astype(float)
    Rr, Gg, Bb = s[:, :, 0], s[:, :, 1], s[:, :, 2]
    red_m = (Rr > 175) & (Gg < 56) & (Bb < 52) & (Rr-Gg > 100) & (Rr-Bb > 110)
    tn = (255.0 - s.mean(axis=2)) * (~red_m)
    tn = np.where(tn < 8, 0.0, tn)
    th, tw = tn.shape
    print(f"[shot] {tw}x{th}  灰像素 {int((tn>0).sum()):,}  路线红 {int(red_m.sum()):,}")

    def ncc_map(ref, T):
        ones = np.ones_like(T)
        n = T.size
        Tsum = T.sum()
        Tss = float(((T - T.mean())**2).sum())
        S1 = fftconvolve(ref, T[::-1, ::-1], "valid")
        S2 = fftconvolve(ref, ones, "valid")
        S3 = fftconvolve(ref*ref, ones, "valid")
        num = S1 - Tsum * S2 / n
        var = np.maximum(S3 - S2*S2/n, 0.0)
        # 平坦窗口（无灰线）方差≈0，NCC 无定义 → 直接置 0，避免浮点噪声被放大
        good = var > 1e-6 * max(float(ref.var()) * n, 1.0)
        den = np.sqrt(var * Tss)
        out = np.zeros_like(num)
        np.divide(num, den, out=out, where=good & (den > 0))
        return out

    res = []
    for k in np.linspace(A.kmin, A.kmax, A.nk):
        iw, ih = int(round(BW / k)), int(round(BH / k))
        if iw < tw + 4 or ih < th + 4:
            continue
        ref = np.asarray(Image.fromarray(greyn.astype(np.uint8)).resize((iw, ih), Image.BOX)).astype(float)
        ncc = ncc_map(ref, tn)
        i = np.unravel_index(np.argmax(ncc), ncc.shape)
        res.append((float(ncc[i]), k, int(i[0]), int(i[1]), (iw, ih)))
    res.sort(key=lambda z: -z[0])
    if not res:
        print("无有效尺度"); return
    print(f"\n候选（局部灰网 NCC）")
    for sc, k, r, c, (iw, ih) in res[:A.top]:
        # 截图(0,0) ↔ 搜索区画布 (sx0 + c*k, sy0 + r*k)
        X = x0 + (sx0 + c*k) / W * span
        Y = y1 - (sy0 + r*k) / H * (y1 - y0)
        print(f"  NCC={sc:.4f}  k={k:4.2f}  左上画布({sx0+int(c*k)},{sy0+int(r*k)})  "
              f"中心 {LON0+X/MLON+tw*k/2/MLON:.6f},{LAT0+Y/MLAT-th*k/2/MLAT:.6f}")

    # 联络表
    n = min(A.top, len(res)); cols = 3; rows = (n+cols-1)//cols
    pad, lab = 8, 18
    cw, ch = tw*2 + pad, th + lab
    sheet = Image.new("RGB", (cols*cw + pad*(cols+1), rows*ch + pad*(rows+1)), (238,240,244))
    dd = ImageDraw.Draw(sheet); shot = Image.open(A.img).convert("RGB")
    for idx, (sc, k, r, c, (iw, ih)) in enumerate(res[:n]):
        ref = np.asarray(Image.fromarray(greyn.astype(np.uint8)).resize((iw, ih), Image.BOX)).astype(float)
        vis = np.clip(255.0 - ref*3.2, 0, 255).astype(np.uint8)
        vis = Image.fromarray(np.dstack([vis]*3))
        crop = vis.crop((c, r, c+tw, r+th))
        rr, cc = divmod(idx, cols)
        ox = pad + cc*(cw+pad); oy = pad + rr*(ch+pad)
        sheet.paste(crop, (ox, oy+lab)); sheet.paste(shot, (ox+tw+pad, oy+lab))
        dd.text((ox+2, oy+3), f"#{idx} NCC={sc:.3f} k={k:.2f}", fill=(30,34,44))
    sheet.save(OUT / "_cand_local.png")
    print(f"\n联络表 → out/_cand_local.png（左=参照裁剪x3.2 右=截图）")


if __name__ == "__main__":
    main()
