# -*- coding: utf-8 -*-
"""定位截图 v6：改用「灰路网」做归一化互相关。

为什么换灰线：红线掩膜在整幅图里只有 1,233 px 且形状简单，NCC 峰值仅 0.35（无判别力）。
灰路网结构复杂（这次截图左下有一团密集城镇路网 + 左侧一条纵向干道），是强特征。

灰度证据（据此定缩放区间）：
  * 截图红线核心 (222,40,23) = 主图路线红 #de1c08 混白 5.3% → 确认截图来自主图（非覆盖图）
  * 截图灰线均值 (194,198,207) = 宽凳灰 (108,118,136) 混白 58% → 栅格灰线在屏幕上不足 1px
  * 栅格灰线宽 3 画布px，故 3s≈0.58 → 主图缩放 s≈0.19，对应 k = 1/s ≈ 5.3
    （矢量红线线宽被 CSS 固定成 1.7 屏幕px，所以缩小后依然锐利 —— 与截图一致）

用法: python tools/locate_grey.py <截图.png> [--kmin 1.5 --kmax 11 --nscale 40] [--sheet 9]
"""
import argparse, json, math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy.signal import fftconvolve

OUT = Path(__file__).resolve().parent.parent / "out"
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0
W0, PAD_M = 5200, 8000.0
F = 2


def pool_any(b, f=2):
    h, w = b.shape; h2, w2 = h // f * f, w // f * f
    return b[:h2, :w2].reshape(h // f, f, w // f, f).any(axis=(1, 3))


def box_sum(A, kh, kw):
    return fftconvolve(A.astype(np.float32), np.ones((kh, kw), np.float32), mode="valid")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("img")
    ap.add_argument("--kmin", type=float, default=1.5)
    ap.add_argument("--kmax", type=float, default=11.0)
    ap.add_argument("--nscale", type=int, default=40)
    ap.add_argument("--sheet", type=int, default=9)
    ap.add_argument("--thr", type=float, default=8.0, help="灰度阈值（255-均值 的最小值）")
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

    g = np.asarray(Image.open(OUT / "_grey_clean.png").convert("RGB")).astype(int)
    refm = pool_any((np.abs(g[:, :, 0] - 108) < 22) & (np.abs(g[:, :, 1] - 118) < 22), F)
    Rf = refm.astype(np.float32)
    print(f"[ref] 灰掩膜 {refm.shape[::-1]}  像素 {int(refm.sum()):,}")

    shot_im = Image.open(A.img).convert("RGB")
    s = np.asarray(shot_im).astype(float)
    Rr, Gg, Bb = s[:, :, 0], s[:, :, 1], s[:, :, 2]
    redness = np.clip((Rr - Gg) / 90.0, 0, 1)
    greyness = (255.0 - (Rr + Gg + Bb) / 3.0) * (1.0 - redness)     # 灰=正，红/白≈0
    greyness = np.maximum(greyness - A.thr, 0)
    h, w = greyness.shape
    print(f"[shot] {w}x{h}  灰强度>0 的像素 {int((greyness>0).sum()):,}")

    res = []
    for k in np.exp(np.linspace(math.log(A.kmin), math.log(A.kmax), A.nscale)):
        tw, th = int(round(w * k)) // F, int(round(h * k)) // F
        if th < 10 or tw < 10 or th >= refm.shape[0] or tw >= refm.shape[1]:
            continue
        T = np.array(Image.fromarray(greyness.astype(np.float32)).resize((tw * F, th * F), Image.BILINEAR),
                     dtype=np.float32)
        t = T.reshape(th, F, tw, F).mean(axis=(1, 3))
        area = float(th * tw)
        Ts = float(t.sum()); T2 = float((t * t).sum())
        if T2 <= 0:
            continue
        S1 = fftconvolve(Rf, t[::-1, ::-1], mode="valid")
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

    print(f"\n候选（NCC 越大越像）")
    for n, (v, k, (rr, cc), (nh, nw)) in enumerate(res[:A.sheet]):
        lon, lat = px2ll(cc + nw // 2, rr + nh // 2)
        print(f"  #{n} NCC={v:.3f} k={k:5.2f}  ({nh}x{nw})  左上(r{rr},c{cc})  中心 {lon:.6f},{lat:.6f}")

    # 联络表：左 = 参照灰裁剪（放大到截图尺寸），右 = 截图
    ref_rgb = Image.open(OUT / "_grey_clean.png").convert("RGB")
    n = min(A.sheet, len(res)); cols = 3; rows = (n + cols - 1) // cols
    pad, lab = 8, 18
    cw, ch = w * 2 + pad, h + lab
    sheet = Image.new("RGB", (cols * cw + pad * (cols + 1), rows * ch + pad * (rows + 1)), (238, 240, 244))
    dd = ImageDraw.Draw(sheet)
    for idx in range(n):
        v, k, (rr, cc), (nh, nw) = res[idx]
        r, c = divmod(idx, cols)
        ox = pad + c * (cw + pad); oy = pad + r * (ch + pad)
        crop = ref_rgb.crop((cc, rr, cc + nw, rr + nh)).resize((w, h), Image.LANCZOS)
        sheet.paste(crop, (ox, oy + lab)); sheet.paste(shot_im, (ox + w + pad, oy + lab))
        lon, lat = px2ll(cc + nw // 2, rr + nh // 2)
        dd.text((ox + 2, oy + 3), f"#{idx} NCC={v:.3f} k={k:.2f} {lon:.4f},{lat:.4f}", fill=(30, 34, 44))
    sheet.save(OUT / "_cand_grey.png")
    print(f"\n联络表 → out/_cand_grey.png（每格：左=宽凳灰网裁剪，右=截图）")


if __name__ == "__main__":
    main()
