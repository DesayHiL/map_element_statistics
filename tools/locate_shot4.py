# -*- coding: utf-8 -*-
"""定位截图的最后一版：宽尺度范围 + 一次性输出候选联络表（3x3）供肉眼确认。

保留严格对称倒角 score = 正向均值 + 反向均值（单位原图像素，越小越像），
但把缩放范围放宽到 0.12~4.0、步长加密，并把前 9 个候选裁图拼成一张联络表，
避免"只看第一名"被假阳性带偏。
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("img")
    ap.add_argument("--kmin", type=float, default=0.12)
    ap.add_argument("--kmax", type=float, default=4.0)
    ap.add_argument("--nscale", type=int, default=60)
    ap.add_argument("--nshow", type=int, default=9)
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
    refd = ndimage.distance_transform_edt(~refm).astype(np.float32)
    refmf = refm.astype(np.float32)

    shot_im = Image.open(A.img).convert("RGB")
    shot = np.asarray(shot_im).astype(int)
    R, G, B = shot[:, :, 0], shot[:, :, 1], shot[:, :, 2]
    rm = (R > 175) & (G < 56) & (B < 52) & (R - G > 100) & (R - B > 110)
    h, w = rm.shape
    print(f"[shot] {w}x{h} 路线红 {int(rm.sum()):,}   [ref] 掩膜 {refm.shape[::-1]}")

    res = []
    for k in np.exp(np.linspace(math.log(A.kmin), math.log(A.kmax), A.nscale)):
        tw, th = int(round(w * k)), int(round(h * k))
        tw2, th2 = tw // F, th // F
        if th2 >= refm.shape[0] or tw2 >= refm.shape[1] or th2 < 8 or tw2 < 8:
            continue
        im = Image.fromarray((rm * 255).astype(np.uint8)).resize((tw, th), Image.BILINEAR)
        t = pool_any(np.array(im) > 25, F).astype(np.float32)
        T = float(t.sum())
        if T < 30:
            continue
        fwdS = fftconvolve(refd, t[::-1, ::-1], mode="valid")
        Dt = ndimage.distance_transform_edt(~(t > 0)).astype(np.float32)
        revS = fftconvolve(refmf, Dt[::-1, ::-1], mode="valid")
        Nref = fftconvolve(refmf, t[::-1, ::-1], mode="valid")
        fwd = fwdS / T
        rev = revS / np.maximum(Nref, 1.0)
        sc = np.nan_to_num(fwd + rev)
        i = np.unravel_index(np.argmin(sc), sc.shape)
        res.append((float(sc[i]), float(fwd[i]), float(rev[i]), k,
                    (int(i[0]) * F, int(i[1]) * F), (th, tw)))
    res.sort(key=lambda x: x[0])
    if not res:
        print("未匹配"); return

    def px2ll(col, row):
        X = x0 + col / W0 * span; Y = y1 - row / H * (y1 - y0)
        return LON0 + X / MLON, LAT0 + Y / MLAT

    print(f"\n候选（score = 正 + 反，单位原图像素）")
    for n, (sc, fw, rv, k, (rr, cc), (nh, nw)) in enumerate(res[:A.nshow]):
        lon, lat = px2ll(cc + nw // 2, rr + nh // 2)
        print(f"  #{n} {sc:6.2f}=正{fw:5.2f}+反{rv:5.2f}  k={k:.3f}  ({nh}x{nw}) 中心 {lon:.6f},{lat:.6f}")

    # 联络表：每格左=参照裁剪(放大到截图尺寸) 右=截图
    n = min(A.nshow, len(res)); cols = 3; rows = (n + cols - 1) // cols
    pad, lab = 8, 18
    cw, ch = w * 2 + pad, h + lab
    sheet = Image.new("RGB", (cols * cw + pad * (cols + 1), rows * ch + pad * (rows + 1)), (238, 240, 244))
    dd = ImageDraw.Draw(sheet)
    for idx in range(n):
        sc, fw, rv, k, (rr, cc), (nh, nw) = res[idx]
        r, c = divmod(idx, cols)
        ox = pad + c * (cw + pad); oy = pad + r * (ch + pad)
        crop = ref.crop((cc, rr, cc + nw, rr + nh)).resize((w, h), Image.LANCZOS)
        sheet.paste(crop, (ox, oy + lab))
        sheet.paste(shot_im, (ox + w + pad, oy + lab))
        lon, lat = px2ll(cc + nw // 2, rr + nh // 2)
        dd.text((ox + 2, oy + 3), f"#{idx} k={k:.2f} score={sc:.2f}  {lon:.4f},{lat:.4f}", fill=(30, 34, 44))
    sheet.save(OUT / "_cand_sheet.png")
    print(f"\n联络表 → out/_cand_sheet.png（每格：左=参照裁剪，右=截图）")


if __name__ == "__main__":
    main()
