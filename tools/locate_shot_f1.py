# -*- coding: utf-8 -*-
"""用红线掩膜的「双向覆盖率 F1」把用户截图定位回主图画布坐标。

为什么不用倒角平均分：截图红线很细很稀，随便落在一条长线上平均距离就很小，
会给出"偏离 1.4px"的假高分（已实测：提示的裁剪与截图完全不同构）。

改法（离散、可解释）：
  对每个候选缩放 k 与位置，把截图红线掩膜 t（半分辨率）盖到参照红线掩膜 ref 上：
    B = 落在 t 的足迹内、且距离 ref 红线 ≤3px 的 t 像素数   → precision = B / |t|
    A = 落在 t 的足迹内的 ref 红线像素数                    → recall    = B / A
    F1 = 2B / (|t| + A)
  F1 高 = 形状真的重合。再对前若干候选逐个裁图肉眼看。

用法: python tools/locate_shot_f1.py <截图.png> [--kmin .2 --kmax 20] [--top 8] [--check I]
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
    return polys, x0, x1, y0, y1, (x1 - x0), int(round(W0 * (y1 - y0) / (x1 - x0)))


def red_ref(polys, x0, span, y0, y1, H):
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


def redness(a, dg=45, db=60):
    R, G, B = a[:, :, 0].astype(int), a[:, :, 1].astype(int), a[:, :, 2].astype(int)
    return (R - G > dg) & (R > 140) & (R - B > db)


def boxmask(a):
    R, G, B = a[:, :, 0].astype(int), a[:, :, 1].astype(int), a[:, :, 2].astype(int)
    return (R > 232) & (G > 50) & (G < 130) & (B > 45) & (B < 130) & (np.abs(G - B) < 32)


def pool_any(b, f=2):
    h, w = b.shape; h2, w2 = h // f * f, w // f * f
    return b[:h2, :w2].reshape(h // f, f, w // f, f).any(axis=(1, 3))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("img")
    ap.add_argument("--kmin", type=float, default=0.20)
    ap.add_argument("--kmax", type=float, default=20.0)
    ap.add_argument("--nscale", type=int, default=70)
    ap.add_argument("--tol", type=float, default=3.0)
    ap.add_argument("--top", type=int, default=8)
    ap.add_argument("--check", type=int, default=-1, help="对第 i 个候选出对比图")
    A = ap.parse_args()

    polys, x0, x1, y0, y1, span, H = view()
    ref = red_ref(polys, x0, span, y0, y1, H).convert("RGB")
    refm = pool_any(redness(np.asarray(ref)), 2)          # 半分辨率参照红线
    refd = ndimage.distance_transform_edt(~refm).astype(np.float32)
    refnear = (refd <= A.tol / 2).astype(np.float32)      # 参照线 ±3px（半分辨率下 1.5）
    print(f"[ref] {ref.size}  红线像素 {int(refm.sum()):,}（半分辨率）")

    shot = np.asarray(Image.open(A.img).convert("RGB"))
    bm = boxmask(shot)
    rm = redness(shot) & ~ndimage.binary_dilation(bm, iterations=3)
    print(f"[shot] {shot.shape[1]}x{shot.shape[0]}  手画红框 {int(bm.sum()):,}  路线红 {int(rm.sum()):,}")
    Image.fromarray((rm * 255).astype(np.uint8)).save(OUT / "_shot_redmask.png")
    h, w = rm.shape

    res = []
    for k in np.exp(np.linspace(math.log(A.kmin), math.log(A.kmax), A.nscale)):
        tw, th = int(round(w * k)), int(round(h * k))
        tw2, th2 = tw // 2, th // 2
        if th2 >= refm.shape[0] or tw2 >= refm.shape[1] or th2 < 5 or tw2 < 5:
            continue
        im = Image.fromarray((rm * 255).astype(np.uint8)).resize((tw, th), Image.BILINEAR)
        t = pool_any(np.array(im) > 110, 2).astype(np.float32)
        T = float(t.sum())
        if T < 20:
            continue
        B = fftconvolve(refnear, t[::-1, ::-1], mode="valid")     # t 像素中贴近参照线的数量
        Aa = fftconvolve(refm.astype(np.float32), t[::-1, ::-1], mode="valid")  # 足迹内的参照线像素
        with np.errstate(invalid="ignore", divide="ignore"):
            F1 = 2 * B / (T + Aa)
        F1 = np.nan_to_num(F1)
        i = np.unravel_index(np.argmax(F1), F1.shape)
        res.append((float(F1[i]), k, (int(i[0]) * 2, int(i[1]) * 2), (th2 * 2, tw2 * 2),
                    float(B[i]), T, float(Aa[i])))
    res.sort(reverse=True, key=lambda x: x[0])
    if not res:
        print("未匹配"); return

    def px2ll(col, row):
        X = x0 + col / W0 * span; Y = y1 - row / H * (y1 - y0)
        return LON0 + X / MLON, LAT0 + Y / MLAT

    print(f"\n截图 {A.img}  候选（F1 越高越像）")
    for n, (f1, k, (rr, cc), (nh, nw), b, T, aa) in enumerate(res[:A.top]):
        lon, lat = px2ll(cc + nw // 2, rr + nh // 2)
        print(f"  #{n} F1={f1:.3f}  k={k:.3f}(截图=原图 {1/k:.2f}x)  "
              f"左上(r{rr},c{cc}) 尺寸({nh}x{nw}) 中心 {lon:.6f},{lat:.6f}  "
              f"[命中 {b:.0f}/{T:.0f} 覆盖 {b/max(aa,1):.2f}]")

    if A.check >= 0:
        f1, k, (rr, cc), (nh, nw), b, T, aa = res[A.check]
        crop = ref.crop((cc, rr, cc + nw, rr + nh)).resize((w, h), Image.LANCZOS)
        out = Image.new("RGB", (w * 3 + 40, h), (245, 246, 248))
        out.paste(crop, (0, 0))
        out.paste(Image.fromarray((rm * 255).astype(np.uint8)).convert("RGB"), (w + 20, 0))
        out.paste(Image.open(A.img).convert("RGB"), (w * 2 + 40, 0))
        out.save(OUT / f"_f1_verify_{A.check}.png")
        lo = px2ll(cc, rr + nh); hi = px2ll(cc + nw, rr)
        print(f"\n  # {A.check} 对比图 → out/_f1_verify_{A.check}.png（左=参照红裁剪放大 / 中=截图红掩膜 / 右=截图）")
        print(f"  原图 col {cc}..{cc+nw}  row {rr}..{rr+nh}   左下 {lo[0]:.6f},{lo[1]:.6f}  右上 {hi[0]:.6f},{hi[1]:.6f}")
        np.save(OUT / "_f1_bbox.npy", np.array([cc, rr, cc + nw, rr + nh, k]))


if __name__ == "__main__":
    main()
