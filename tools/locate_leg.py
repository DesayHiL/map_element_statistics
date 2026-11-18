# -*- coding: utf-8 -*-
"""定位截图 v7：逐条腿单独匹配。

为什么换这个思路：把 52 条路线全画进一张参照图后，无论用倒角还是 NCC，
红线掩膜都太稀疏、判别力不够（实测 NCC 峰值 0.35 / 0.22）。
改成「每次只拿一条腿当参照」——截图里只有一条红线，逐腿比对能直接答出"这是哪条路线"。

尺度依据（两路证据互相印证）：
  * 截图红线核心 (222,40,23) = 主图路线红 #de1c08 混白 5% → 截图来自主图（不是覆盖图 #d81e1e）
  * 栅格灰线宽 3 画布px，屏幕上实测覆盖率 0.41~0.48 → 3/k≈0.45 → k≈6~7
  * 但 k 受浏览器 DPR 影响，故搜索区间放宽到 2.5~10

每腿参照在 F 倍降采样下渲染（canvas 坐标，线宽随 k 放大），
score = 正向均值（模板px→该腿） + 反向均值（该腿像素→模板px），单位原图像素。

用法: python tools/locate_leg.py <截图.png> [--kmin 2.5 --kmax 10 --nk 8] [--top 9]
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
F = 4                       # 参照降采样倍数
W1, H1 = W0 // F, None      # H1 运行时定


def box_any(b, f):
    h, w = b.shape; h2, w2 = h // f * f, w // f * f
    return b[:h2, :w2].reshape(h // f, f, w // f, f).any(axis=(1, 3))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("img")
    ap.add_argument("--kmin", type=float, default=2.5)
    ap.add_argument("--kmax", type=float, default=10.0)
    ap.add_argument("--nk", type=int, default=8)
    ap.add_argument("--top", type=int, default=9)
    A = ap.parse_args()

    doc = json.loads((OUT / "routes.json").read_text(encoding="utf-8"))
    legs = []
    for st in doc["routes"]:
        for i, r in enumerate(st.get("routes", []), start=1):
            P = np.asarray(r["poly"], "f8")
            x, y = (P[:, 0] - LON0) * MLON, (P[:, 1] - LAT0) * MLAT
            legs.append(dict(street=st["street"], n=i, xy=np.column_stack([x, y])))
    xs = np.concatenate([L["xy"][:, 0] for L in legs]); ys = np.concatenate([L["xy"][:, 1] for L in legs])
    x0, x1 = xs.min() - PAD_M, xs.max() + PAD_M
    y0, y1 = ys.min() - PAD_M, ys.max() + PAD_M
    span = x1 - x0; H = int(round(W0 * (y1 - y0) / span)); H1 = H // F
    print(f"[view] {W0}x{H}  腿 {len(legs)}  参照降采样 {F}x → {W1}x{H1}")

    # 每腿的参照掩膜 + 距离变换（一次算好，复用于所有 k）
    legmask, legdt = [], []
    for L in legs:
        im = Image.new("L", (W1, H1), 0); d = ImageDraw.Draw(im)
        px = (L["xy"][:, 0] - x0) / span * W0; py = (y1 - L["xy"][:, 1]) / (y1 - y0) * H
        d.line(list(zip((px / F).tolist(), (py / F).tolist())), fill=255, width=1, joint="curve")
        m = np.asarray(im) > 0
        legmask.append(m.astype(np.float32))
        legdt.append(ndimage.distance_transform_edt(~m).astype(np.float32))
    print(f"[ref] {len(legs)} 条腿掩膜就绪")

    shot_im = Image.open(A.img).convert("RGB")
    s = np.asarray(shot_im).astype(int)
    Rr, Gg, Bb = s[:, :, 0], s[:, :, 1], s[:, :, 2]
    rm = (Rr > 175) & (Gg < 56) & (Bb < 52) & (Rr - Gg > 100) & (Rr - Bb > 110)
    h, w = rm.shape
    print(f"[shot] {w}x{h}  路线红 {int(rm.sum()):,}")

    res = []
    for k in np.linspace(A.kmin, A.kmax, A.nk):
        tw, th = max(6, int(round(w * k / F))), max(6, int(round(h * k / F)))
        if th >= H1 or tw >= W1:
            continue
        t = box_any(np.asarray(Image.fromarray((rm * 255).astype(np.uint8)).resize(
            (tw * F, th * F), Image.BILINEAR)) > 25, F).astype(np.float32)
        T = float(t.sum())
        if T < 15:
            continue
        Dt = ndimage.distance_transform_edt(~(t > 0)).astype(np.float32)
        for li, L in enumerate(legs):
            fwdS = fftconvolve(legdt[li], t[::-1, ::-1], mode="valid")
            revS = fftconvolve(legmask[li], Dt[::-1, ::-1], mode="valid")
            Nref = fftconvolve(legmask[li], t[::-1, ::-1], mode="valid")
            fwd = fwdS / T; rev = revS / np.maximum(Nref, 1.0)
            sc = np.nan_to_num(fwd + rev)
            i = np.unravel_index(np.argmin(sc), sc.shape)
            res.append((float(sc[i]), float(fwd[i]), float(rev[i]), k, li,
                        (int(i[0]) * F, int(i[1]) * F), (th * F, tw * F)))
    res.sort(key=lambda x: x[0])
    if not res:
        print("未匹配"); return

    def px2ll(col, row):
        X = x0 + col / W0 * span; Y = y1 - row / H * (y1 - y0)
        return LON0 + X / MLON, LAT0 + Y / MLAT

    print(f"\n候选（逐腿，score = 正 + 反，单位原图像素）")
    seen = set()
    shown = 0
    for sc, fw, rv, k, li, (rr, cc), (nh, nw) in res:
        if li in seen:
            continue
        seen.add(li); shown += 1
        L = legs[li]
        lon, lat = px2ll(cc + nw // 2, rr + nh // 2)
        print(f"  {L['street']} 路线{L['n']:<2}  score={sc:7.2f}=正{fw:5.2f}+反{rv:5.2f}  "
              f"k={k:4.2f}  ({nh}x{nw}) 左上(r{rr},c{cc})  中心 {lon:.6f},{lat:.6f}")
        if shown >= A.top:
            break

    # 联络表：每格 左=该腿渲染(放大到截图尺寸) 右=截图
    n = min(A.top, len(seen)); cols = 3; rows = (n + cols - 1) // cols
    pad, lab = 8, 18
    cw, ch = w * 2 + pad, h + lab
    sheet = Image.new("RGB", (cols * cw + pad * (cols + 1), rows * ch + pad * (rows + 1)), (238, 240, 244))
    dd = ImageDraw.Draw(sheet)
    seen2, idx = set(), 0
    for sc, fw, rv, k, li, (rr, cc), (nh, nw) in res:
        if li in seen2 or idx >= n:
            continue
        seen2.add(li)
        # 从「该腿自身画布」里裁同一位置
        big = Image.new("RGB", (W0, H), (255, 255, 255)); db = ImageDraw.Draw(big)
        L = legs[li]
        px = (L["xy"][:, 0] - x0) / span * W0; py = (y1 - L["xy"][:, 1]) / (y1 - y0) * H
        db.line(list(zip(px.tolist(), py.tolist())), fill=C_ROUTE, width=3, joint="curve")
        crop = big.crop((cc, rr, cc + nw, rr + nh)).resize((w, h), Image.LANCZOS)
        r, c = divmod(idx, cols)
        ox = pad + c * (cw + pad); oy = pad + r * (ch + pad)
        sheet.paste(crop, (ox, oy + lab)); sheet.paste(shot_im, (ox + w + pad, oy + lab))
        dd.text((ox + 2, oy + 3), f"#{idx} {L['street']}腿{L['n']} k={k:.2f} s={sc:.2f}",
                fill=(30, 34, 44))
        idx += 1
    sheet.save(OUT / "_cand_leg.png")
    print(f"\n联络表 → out/_cand_leg.png（每格：左=该腿单独渲染的裁剪，右=截图）")


if __name__ == "__main__":
    main()
