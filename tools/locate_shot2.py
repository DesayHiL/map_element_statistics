# -*- coding: utf-8 -*-
"""用「匹配像素数 - 惩罚」把用户截图定位回主图画布坐标（修正版）。

前一版的 bug：模板缩小后细红线被双线性插值冲淡到 <110，阈值一滤就只剩几十个像素，
导致 T 严重偏小、指标变成"小模板恰好压线"的退化匹配（实测给出的裁剪与截图完全不同构）。

修正：
  1) 缩小后阈值降到 25，并用 2x2 any-pooling（细线不会被丢掉）
  2) 打分改为  score = B - 0.70*(T-B)   （B=落在参照线 tol 内的模板像素数）
     完美重合 ≈ +T，随机落点 ≈ -0.7T，既奖励"贴得住"又奖励"贴得多"，杜绝退化
  3) 强制 T ≥ minpx
并把前后若干候选都裁出来，肉眼确认（不靠单一指标）。

用法: python tools/locate_shot2.py <截图.png> [--tol 3] [--top 8] [--show 0]
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
F = 2                                   # 参照降采样倍数


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


def pool_any(b, f=2):
    h, w = b.shape; h2, w2 = h // f * f, w // f * f
    return b[:h2, :w2].reshape(h // f, f, w // f, f).any(axis=(1, 3))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("img")
    ap.add_argument("--kmin", type=float, default=0.15)
    ap.add_argument("--kmax", type=float, default=22.0)
    ap.add_argument("--nscale", type=int, default=90)
    ap.add_argument("--tol", type=float, default=3.0)
    ap.add_argument("--minpx", type=int, default=40)
    ap.add_argument("--top", type=int, default=8)
    ap.add_argument("--show", type=int, default=0)
    A = ap.parse_args()

    polys, x0, x1, y0, y1, span, H = view()
    ref = red_ref(polys, x0, span, y0, y1, H).convert("RGB")
    a = np.asarray(ref).astype(int)
    refm = pool_any((a[:, :, 0] - a[:, :, 1] > 60) & (a[:, :, 0] > 150) & (a[:, :, 1] < 90), F)
    refd = ndimage.distance_transform_edt(~refm).astype(np.float32)
    nearmask = (refd <= A.tol / F).astype(np.float32)
    print(f"[ref] {ref.size} → 掩膜 {refm.shape[::-1]}  红线像素 {int(refm.sum()):,}")

    shot = np.asarray(Image.open(A.img).convert("RGB")).astype(int)
    R, G, B = shot[:, :, 0], shot[:, :, 1], shot[:, :, 2]
    # 精确分离：路线红 #de1c08 抗锯齿后实测 (222,40,23)（G=40, B=23）
    #           手画红框 #f54a45 实测 (245,74,69)（G=74, B=69）
    # 两轴一起卡：R 高 + G<56 排掉框；再要求 R-G>60 排掉浅灰与抗锯齿边缘
    rm = (R > 175) & (G < 56) & (B < 52) & (R - G > 100) & (R - B > 110)
    h, w = rm.shape
    print(f"[shot] {w}x{h}  路线红 {int(rm.sum()):,}（手画框已按 G 通道剔除）")
    Image.fromarray((rm * 255).astype(np.uint8)).save(OUT / "_shot_redmask.png")

    res = []
    for k in np.exp(np.linspace(math.log(A.kmin), math.log(A.kmax), A.nscale)):
        tw, th = int(round(w * k)), int(round(h * k))
        tw2, th2 = tw // F, th // F
        if th2 >= refm.shape[0] or tw2 >= refm.shape[1] or th2 < 6 or tw2 < 6:
            continue
        im = Image.fromarray((rm * 255).astype(np.uint8)).resize((tw, th), Image.BILINEAR)
        t = pool_any(np.array(im) > 25, F).astype(np.float32)
        T = float(t.sum())
        if T < A.minpx:
            continue
        Bm = fftconvolve(nearmask, t[::-1, ::-1], mode="valid")
        score = Bm - 0.70 * (T - Bm)
        i = np.unravel_index(np.argmax(score), score.shape)
        res.append((float(score[i]), float(Bm[i]), T, k,
                    (int(i[0]) * F, int(i[1]) * F), (th, tw)))
    res.sort(reverse=True, key=lambda x: x[0])
    if not res:
        print("未匹配"); return

    def px2ll(col, row):
        X = x0 + col / W0 * span; Y = y1 - row / H * (y1 - y0)
        return LON0 + X / MLON, LAT0 + Y / MLAT

    print(f"\n截图 {A.img}  候选（score = 命中 - 0.7×未命中，越接近 T 越好）")
    for n, (sc, b, T, k, (rr, cc), (nh, nw)) in enumerate(res[:A.top]):
        lon, lat = px2ll(cc + nw // 2, rr + nh // 2)
        print(f"  #{n} score={sc:7.1f}  命中 {b:5.0f}/{T:4.0f} = {b/T*100:5.1f}%  "
              f"k={k:.3f}(截图=原图 {1/k:.2f}x)  左上(r{rr},c{cc}) 尺寸({nh}x{nw})  "
              f"中心 {lon:.6f},{lat:.6f}")

    for n in ([A.show] if A.show is not None else []):
        sc, b, T, k, (rr, cc), (nh, nw) = res[n]
        crop = ref.crop((cc, rr, cc + nw, rr + nh)).resize((w, h), Image.LANCZOS)
        out = Image.new("RGB", (w * 3 + 40, h), (245, 246, 248))
        out.paste(crop, (0, 0))
        out.paste(Image.fromarray((rm * 255).astype(np.uint8)).convert("RGB"), (w + 20, 0))
        out.paste(Image.open(A.img).convert("RGB"), (w * 2 + 40, 0))
        out.save(OUT / f"_cand_{n}.png")
        lo = px2ll(cc, rr + nh); hi = px2ll(cc + nw, rr)
        print(f"\n  #{n} → out/_cand_{n}.png   原图 col {cc}..{cc+nw} row {rr}..{rr+nh}"
              f"   左下 {lo[0]:.6f},{lo[1]:.6f}  右上 {hi[0]:.6f},{hi[1]:.6f}")
        np.save(OUT / f"_cand_{n}_bbox.npy", np.array([cc, rr, cc + nw, rr + nh, k]))


if __name__ == "__main__":
    main()
