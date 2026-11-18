# -*- coding: utf-8 -*-
"""定位截图 v5：归一化互相关（等价 cv2.matchTemplate TM_CCOEFF_NORMED）。

为什么放弃倒角距离：只要模板一缩小，正向均值（模板px→参照线）与反向均值
（窗口内参照px→模板px）都会同步变小，小模板天然低分（实测 k=0.12 那种 47x53
的退化解反复拿第一）。NCC 用局部均值/能量归一化，小模板得不到便宜。

R = 参照红线掩膜（降采样 F 倍），T = 截图红线掩膜（resize 到 k 倍）
  S1 = Σ R·T       （卷积）
  S2 = Σ R         （盒和）
  S3 = Σ R²        （盒和）
  num = S1 - |T|·S2/A
  den = sqrt( (ΣT² - |T|²/A)·(S3 - S2²/A) )
  NCC = num/den ；全局最大处即位置

用法: python tools/locate_shot5.py <截图.png> [--kmin .6 --kmax 12 --nscale 40] [--sheet 9]
"""
import argparse, json, math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.signal import fftconvolve

OUT = Path(__file__).resolve().parent.parent / "out"
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0
W0, PAD_M = 5200, 8000.0
C_ROUTE = (222, 28, 8)
F = 2


def pool_any(b, f=2):
    h, w = b.shape; h2, w2 = h // f * f, w // f * f
    return b[:h2, :w2].reshape(h // f, f, w // f, f).any(axis=(1, 3))


def box_sum(A, kh, kw):
    """与 N x N 模板配套的盒和：Σ 窗口内 A。用卷积核 all-ones 实现。"""
    k = np.ones((kh, kw), np.float32)
    return fftconvolve(A.astype(np.float32), k[::-1, ::-1], mode="valid")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("img")
    ap.add_argument("--kmin", type=float, default=0.6)
    ap.add_argument("--kmax", type=float, default=12.0)
    ap.add_argument("--nscale", type=int, default=44)
    ap.add_argument("--sheet", type=int, default=9)
    A = ap.parse_args()

    doc = json.loads((OUT / "routes.json").read_text(encoding="utf-8"))
    polys = []
    for st in doc["routes"]:
        for r in st["routes"]:
            P = np.asarray(r["poly"], "f8")
            polys.append(np.column_stack([(P[:, 0] - LON0) * MLON, (P[:, 1] - LAT0) * MLAT]))
    x0 = min(P[:, 0].min() for P in polys) - PAD_M; x1 = max(P[:, 0].max() for P in polys) + PAD_M
    y0 = min(P[:, 1].min() for P in polys) - PAD_M; y1 = max(P[:, 1].max() for P in polys) + PAD_M
    span = x1 - x0; H = int(round(W0 * (y1 - y0) / span))

    ref = Image.new("RGB", (W0, H), (255, 255, 255)); d = ImageDraw.Draw(ref)
    for P in polys:
        px = (P[:, 0] - x0) / span * W0; py = (y1 - P[:, 1]) / (y1 - y0) * H
        d.line(list(zip(px.tolist(), py.tolist())), fill=C_ROUTE, width=3, joint="curve")
    a = np.asarray(ref).astype(int)
    refm = pool_any((a[:, :, 0] - a[:, :, 1] > 60) & (a[:, :, 0] > 150) & (a[:, :, 1] < 90), F)
    Rf = refm.astype(np.float32)
    print(f"[ref] 掩膜 {refm.shape[::-1]}  像素 {int(refm.sum()):,}")

    shot_im = Image.open(A.img).convert("RGB")
    shot = np.asarray(shot_im).astype(int)
    Rr, Gg, Bb = shot[:, :, 0], shot[:, :, 1], shot[:, :, 2]
    rm = (Rr > 175) & (Gg < 56) & (Bb < 52) & (Rr - Gg > 100) & (Rr - Bb > 110)
    h, w = rm.shape
    print(f"[shot] {w}x{h}  路线红 {int(rm.sum()):,}")

    res = []
    for k in np.exp(np.linspace(math.log(A.kmin), math.log(A.kmax), A.nscale)):
        tw, th = int(round(w * k)) // F, int(round(h * k)) // F
        if th < 8 or tw < 8 or th >= refm.shape[0] or tw >= refm.shape[1]:
            continue
        im = Image.fromarray((rm * 255).astype(np.uint8)).resize((tw * F, th * F), Image.BILINEAR)
        T = pool_any(np.array(im) > 25, F).astype(np.float32)
        area = float(th * tw)
        Ts = float(T.sum()); T2 = float((T * T).sum())
        if Ts < 20:
            continue
        S1 = fftconvolve(Rf, T[::-1, ::-1], mode="valid")
        S2 = box_sum(Rf, th, tw); S3 = box_sum(Rf * Rf, th, tw)
        num = S1 - Ts * S2 / area
        den = np.sqrt(np.maximum(T2 - Ts * Ts / area, 1e-6) * np.maximum(S3 - S2 * S2 / area, 1e-6))
        ncc = num / den
        i = np.unravel_index(np.argmax(ncc), ncc.shape)
        res.append((float(ncc[i]), k, (int(i[0]) * F, int(i[1]) * F), (th * F, tw * F)))
    res.sort(reverse=True, key=lambda x: x[0])
    if not res:
        print("未匹配"); return

    def px2ll(col, row):
        X = x0 + col / W0 * span; Y = y1 - row / H * (y1 - y0)
        return LON0 + X / MLON, LAT0 + Y / MLAT

    print(f"\n候选（NCC 越大越像，1.0 = 完美）")
    for n, (v, k, (rr, cc), (nh, nw)) in enumerate(res[:A.sheet]):
        lon, lat = px2ll(cc + nw // 2, rr + nh // 2)
        print(f"  #{n} NCC={v:.3f}  k={k:5.2f}(截图≈原图 {1/k:.2f}x)  ({nh}x{nw})  "
              f"左上(r{rr},c{cc})  中心 {lon:.6f},{lat:.6f}")

    n = min(A.sheet, len(res)); cols = 3; rows = (n + cols - 1) // cols
    pad, lab = 8, 18
    cw, ch = w * 2 + pad, h + lab
    sheet = Image.new("RGB", (cols * cw + pad * (cols + 1), rows * ch + pad * (rows + 1)), (238, 240, 244))
    dd = ImageDraw.Draw(sheet)
    for idx in range(n):
        v, k, (rr, cc), (nh, nw) = res[idx]
        r, c = divmod(idx, cols)
        ox = pad + c * (cw + pad); oy = pad + r * (ch + pad)
        crop = ref.crop((cc, rr, cc + nw, rr + nh)).resize((w, h), Image.LANCZOS)
        sheet.paste(crop, (ox, oy + lab)); sheet.paste(shot_im, (ox + w + pad, oy + lab))
        lon, lat = px2ll(cc + nw // 2, rr + nh // 2)
        dd.text((ox + 2, oy + 3), f"#{idx} NCC={v:.3f} k={k:.2f} {lon:.4f},{lat:.4f}", fill=(30, 34, 44))
    sheet.save(OUT / "_cand_sheet.png")
    print(f"\n联络表 → out/_cand_sheet.png（每格：左=参照裁剪，右=截图）")


if __name__ == "__main__":
    main()
