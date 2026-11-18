# -*- coding: utf-8 -*-
"""把用户截图定位回主图画布坐标 —— 严格对称倒角版。

前两版错在哪：
  * 版1（只做正向平均倒角）：截图红线才 1200 px，随便压在一条长线上平均距离就 1.4px，
    给出假高分；验证图里裁剪与截图完全不同构。
  * 版2（反向项除了 Dt.size）：分母用错，小模板仍然作弊（k=0.15 那种尺寸拿下第一）。
    掩膜阈值还设成 110，缩小后细红线被双线性冲淡到 <110，被整条滤掉。

本版：
  fwd = Σ_{模板像素} 到最近参照线的距离 / |模板像素|
  rev = Σ_{窗口内参照线像素} 到最近模板像素的距离 / |窗口内参照线像素|
  score = fwd + rev      （完美重合两者都 ≈0~1px；小模板因 rev 爆炸被罚）
分母逐位置动态算，不再用固定 size。

用法: python tools/locate_shot3.py <截图.png> [--kmin .3 --kmax 12 --nscale 34] [--show 0]
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
    ap.add_argument("--kmin", type=float, default=0.30)
    ap.add_argument("--kmax", type=float, default=12.0)
    ap.add_argument("--nscale", type=int, default=34)
    ap.add_argument("--show", type=int, default=0)
    A = ap.parse_args()

    polys, x0, x1, y0, y1, span, H = view()
    ref = red_ref(polys, x0, span, y0, y1, H).convert("RGB")
    a = np.asarray(ref).astype(int)
    refm = pool_any((a[:, :, 0] - a[:, :, 1] > 60) & (a[:, :, 0] > 150) & (a[:, :, 1] < 90), F)
    refd = ndimage.distance_transform_edt(~refm).astype(np.float32)
    refmf = refm.astype(np.float32)
    print(f"[ref] {ref.size} → 掩膜 {refm.shape[::-1]}  像素 {int(refm.sum()):,}")

    shot = np.asarray(Image.open(A.img).convert("RGB")).astype(int)
    R, G, B = shot[:, :, 0], shot[:, :, 1], shot[:, :, 2]
    rm = (R > 175) & (G < 56) & (B < 52) & (R - G > 100) & (R - B > 110)
    h, w = rm.shape
    print(f"[shot] {w}x{h}  路线红 {int(rm.sum()):,}")
    Image.fromarray((rm * 255).astype(np.uint8)).save(OUT / "_shot_redmask.png")

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
        fwdS = fftconvolve(refd, t[::-1, ::-1], mode="valid")          # Σ 模板px 到参照线距离
        Dt = ndimage.distance_transform_edt(~(t > 0)).astype(np.float32)
        revS = fftconvolve(refmf, Dt[::-1, ::-1], mode="valid")        # Σ 窗口内参照px 到模板px 距离
        Nref = fftconvolve(refmf, t[::-1, ::-1], mode="valid")         # 窗口内参照 px 数
        fwd = fwdS / T
        rev = revS / np.maximum(Nref, 1.0)
        sc = np.nan_to_num(fwd + rev)
        i = np.unravel_index(np.argmin(sc), sc.shape)
        res.append((float(sc[i]), float(fwd[i]), float(rev[i]), float(Nref[i]), k,
                    (int(i[0]) * F, int(i[1]) * F), (th, tw), T))
    res.sort(key=lambda x: x[0])
    if not res:
        print("未匹配"); return

    def px2ll(col, row):
        X = x0 + col / W0 * span; Y = y1 - row / H * (y1 - y0)
        return LON0 + X / MLON, LAT0 + Y / MLAT

    print(f"\n截图 {A.img}  候选（score = 正向 + 反向，单位原图像素）")
    for n, (sc, fwd, rev, nref, k, (rr, cc), (nh, nw), T) in enumerate(res[:10]):
        lon, lat = px2ll(cc + nw // 2, rr + nh // 2)
        print(f"  #{n} score={sc:7.2f} = 正 {fwd:5.2f} + 反 {rev:6.2f}  "
              f"k={k:.2f}  左上(r{rr},c{cc}) 尺寸({nh}x{nw})  中心 {lon:.6f},{lat:.6f}")

    if A.show >= 0 and A.show < len(res):
        sc, fwd, rev, nref, k, (rr, cc), (nh, nw), T = res[A.show]
        crop = ref.crop((cc, rr, cc + nw, rr + nh)).resize((w, h), Image.LANCZOS)
        out = Image.new("RGB", (w * 3 + 40, h), (245, 246, 248))
        out.paste(crop, (0, 0))
        out.paste(Image.fromarray((rm * 255).astype(np.uint8)).convert("RGB"), (w + 20, 0))
        out.paste(Image.open(A.img).convert("RGB"), (w * 2 + 40, 0))
        out.save(OUT / f"_c3_{A.show}.png")
        lo = px2ll(cc, rr + nh); hi = px2ll(cc + nw, rr)
        print(f"\n  #{A.show} → out/_c3_{A.show}.png  col {cc}..{cc+nw} row {rr}..{rr+nh}"
              f"   左下 {lo[0]:.6f},{lo[1]:.6f}  右上 {hi[0]:.6f},{hi[1]:.6f}")


if __name__ == "__main__":
    main()
