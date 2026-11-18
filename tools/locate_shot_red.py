# -*- coding: utf-8 -*-
"""用「路线红」把用户截图定位回主图画布坐标 / 经纬度。

为什么不用灰线：缩小到 ~0.19 倍后 3px 灰线被抗锯齿冲淡成 (194,198,207)，
离宽凳灰 (108,118,136) 很远，倒角匹配会失配。路线红 (#de1c08) 在缩放后仍饱和。
另外必须剔除用户手画的红框 (#f54a45)。

用法: python tools/locate_shot_red.py <截图.png> [--kmin .10 --kmax .70 --step .01] [--check]
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


def view():
    doc = json.loads((OUT / "routes.json").read_text(encoding="utf-8"))
    polys = []
    for st in doc["routes"]:
        for r in st["routes"]:
            P = np.asarray(r["poly"], "f8")
            polys.append(np.column_stack([(P[:, 0] - LON0) * MLON, (P[:, 1] - LAT0) * MLAT]))
    x0 = min(P[:, 0].min() for P in polys) - PAD_M; x1 = max(P[:, 0].max() for P in polys) + PAD_M
    y0 = min(P[:, 1].min() for P in polys) - PAD_M; y1 = max(P[:, 1].max() for P in polys) + PAD_M
    span = x1 - x0; H = int(round(W0 * (y1 - y0) / span))
    return polys, x0, x1, y0, y1, span, H


def red_ref(polys, x0, x1, y0, y1, span, H):
    p = OUT / "_red_clean.png"
    if p.exists():
        im = Image.open(p)
        if im.size == (W0, H):
            return im.convert("RGB")
    im = Image.new("RGB", (W0, H), (255, 255, 255)); d = ImageDraw.Draw(im)
    for P in polys:
        px = (P[:, 0] - x0) / span * W0; py = (y1 - P[:, 1]) / (y1 - y0) * H
        d.line(list(zip(px.tolist(), py.tolist())), fill=C_ROUTE, width=3, joint="curve")
    im.save(p); return im


def redness(a):
    R, G, B = a[:, :, 0].astype(int), a[:, :, 1].astype(int), a[:, :, 2].astype(int)
    return (R - G > 45) & (R > 140) & (R - B > 60)


def boxmask(a):
    R, G, B = a[:, :, 0].astype(int), a[:, :, 1].astype(int), a[:, :, 2].astype(int)
    return (R > 232) & (G > 50) & (G < 130) & (B > 45) & (B < 130) & (np.abs(G - B) < 32)


def pool_min(a, f=2):
    h, w = a.shape; h2, w2 = h // f * f, w // f * f
    return a[:h2, :w2].reshape(h // f, f, w // f, f).min(axis=(1, 3))


def pool_max(b, f=2):
    h, w = b.shape; h2, w2 = h // f * f, w // f * f
    return b[:h2, :w2].reshape(h // f, f, w // f, f).any(axis=(1, 3))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("img")
    ap.add_argument("--kmin", type=float, default=0.30)
    ap.add_argument("--kmax", type=float, default=14.0)
    ap.add_argument("--step", type=float, default=0.02)
    ap.add_argument("--minpx", type=int, default=60)
    ap.add_argument("--check", action="store_true")
    A = ap.parse_args()

    polys, x0, x1, y0, y1, span, H = view()
    ref = red_ref(polys, x0, x1, y0, y1, span, H).convert("RGB")
    refm = redness(np.asarray(ref))
    print(f"[ref] {ref.size}  参考红线像素 {int(refm.sum()):,}")
    DTh = pool_min(ndimage.distance_transform_edt(~refm).astype(np.float32), 2)
    refm2 = pool_max(refm, 2)

    shot = np.asarray(Image.open(A.img).convert("RGB"))
    bm = boxmask(shot)
    rm = redness(shot) & ~ndimage.binary_dilation(bm, iterations=3)
    print(f"[shot] {shot.shape[1]}x{shot.shape[0]}  红框 {int(bm.sum()):,}  路线红 {int(rm.sum()):,}")
    Image.fromarray((rm * 255).astype(np.uint8)).save(OUT / "_shot_redmask.png")

    h, w = rm.shape
    res = []
    for k in np.exp(np.linspace(math.log(A.kmin), math.log(A.kmax), 90)):
        tw, th = max(8, int(round(w * k))), max(8, int(round(h * k)))
        if th >= DTh.shape[0] or tw >= DTh.shape[1] or th < 12 or tw < 12:
            continue
        im = Image.fromarray((rm * 255).astype(np.uint8)).resize((tw, th), Image.BILINEAR)
        t = pool_max(np.array(im) > 110, 2).astype(np.float32)
        if t.sum() < A.minpx or min(t.shape) < 4:
            continue
        # 对称倒角：正向 = 截图红线到最近参照线的距离；反向 = 窗口内参照线到最近截图线的距离。
        # 只做正向时，模板越小红线越少、越容易"恰好压线"得 0 分（退化匹配），反向项专门罚这个。
        fwd = fftconvolve(DTh, t[::-1, ::-1], mode="valid") / float(t.sum())
        Dt = ndimage.distance_transform_edt(~(t > 0)).astype(np.float32)
        rev = fftconvolve(refm2.astype(np.float32), Dt[::-1, ::-1], mode="valid") / float(Dt.size)
        C = fwd + rev
        i = np.unravel_index(np.argmin(C), C.shape)
        res.append((float(C[i]), float(fwd[i]), float(rev[i]), k, (int(i[0]), int(i[1])), t.shape))
    res.sort()
    if not res:
        print("未匹配"); return

    def px2ll(col, row):
        X = x0 + col / W0 * span; Y = y1 - row / H * (y1 - y0)
        return LON0 + X / MLON, LAT0 + Y / MLAT

    print(f"\n截图 {A.img}  （得分越低越像：正向+反向，单位原图像素）")
    for tot, f, rv, k, idx, sh in res[:6]:
        ctr_r = idx[0] * 2 + sh[0]; ctr_c = idx[1] * 2 + sh[1]
        lon, lat = px2ll(ctr_c, ctr_r)
        print(f"  k={k:.3f}（截图=原图 {1/k:.2f}x）总分 {tot:6.2f} = 正 {f:5.2f} + 反 {rv:6.2f}"
              f"  中心 原图(r{ctr_r},c{ctr_c}) → {lon:.6f},{lat:.6f}"
              f"  左上(r{idx[0]*2},c{idx[1]*2}) 尺寸({sh[0]*2}x{sh[1]*2})")

    if A.check:
        tot, f, rv, k, idx, sh = res[0]
        tlr, tlc = idx[0] * 2, idx[1] * 2; nr, nc = sh[0] * 2, sh[1] * 2
        crop = ref.crop((tlc, tlr, tlc + nc, tlr + nr)).resize((w, h), Image.LANCZOS)
        out = Image.new("RGB", (w * 3 + 40, h), (245, 246, 248))
        out.paste(crop, (0, 0))
        out.paste(Image.fromarray((rm * 255).astype(np.uint8)).convert("RGB"), (w + 20, 0))
        out.paste(Image.open(A.img).convert("RGB"), (w * 2 + 40, 0))
        out.save(OUT / "_loc_red_verify.png")
        print("  验证图 → out/_loc_red_verify.png（左=参照红裁剪放大 / 中=截图红掩膜 / 右=截图）")
        print(f"  原图裁剪 col {tlc}..{tlc+nc}  row {tlr}..{tlr+nr}")
        lo = px2ll(tlc, tlr + nr); hi = px2ll(tlc + nc, tlr)
        print(f"  左下 {lo[0]:.6f},{lo[1]:.6f}   右上 {hi[0]:.6f},{hi[1]:.6f}")
        np.save(OUT / "_loc_red_bbox.npy",
                np.array([tlc, tlr, tlc + nc, tlr + nr, k, span, x0, y0, y1, H, W0]))


if __name__ == "__main__":
    main()
