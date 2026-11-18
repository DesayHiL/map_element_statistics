# -*- coding: utf-8 -*-
"""限定区域红线定位（芦洲/横沥 一带，全分辨率）。

之前 locate_leg.py 全图搜索退化，因为 (a) 全图红线稀疏、52 条腿互相干扰；
(b) k 搜索区间 2.5~10 方向偏大，真值 ≤3。
本脚本：只搜「芦洲镇+横沥镇」包围盒，只比 3 条候选腿，k∈[1.2,4.5]，
参照在**全分辨率**下按 w=round(3.4k) 渲染再降到截图尺度，保留细线。

score = 正向(截图红px→该腿, 截断 4px 均值) + 反向(该腿px→截图红, 均值)，单位截图像素。
"""
import argparse, json, math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.signal import fftconvolve

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0
W, PAD_M, CAP = 5200, 8000.0, 4.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("img")
    ap.add_argument("--kmin", type=float, default=1.2)
    ap.add_argument("--kmax", type=float, default=4.5)
    ap.add_argument("--nk", type=int, default=34)
    ap.add_argument("--top", type=int, default=9)
    ap.add_argument("--pad", type=int, default=600)
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

    def to_px(X, Y):
        return (X-x0)/span*W, (y1-Y)/(y1-y0)*H

    # 候选腿 + 搜索区
    legs = []
    for st in doc["routes"]:
        if st["street"] not in ("芦洲镇", "横沥镇"):
            continue
        for i, r in enumerate(st["routes"], start=1):
            P = np.asarray(r["poly"], "f8")
            px, py = to_px((P[:, 0]-LON0)*MLON, (P[:, 1]-LAT0)*MLAT)
            legs.append((f"{st['street']}路线{i}", np.column_stack([px, py])))
    allpx = np.concatenate([L[1] for L in legs])
    sx0, sx1 = int(max(0, allpx[:, 0].min()-A.pad)), int(min(W, allpx[:, 0].max()+A.pad))
    sy0, sy1 = int(max(0, allpx[:, 1].min()-A.pad)), int(min(H, allpx[:, 1].max()+A.pad))
    RW, RH = sx1-sx0, sy1-sy0
    print(f"[search] 画布 ({sx0},{sy0})-({sx1},{sy1})  {RW}x{RH}  候选腿 {len(legs)}: "
          + ", ".join(l[0] for l in legs))

    shot = Image.open(A.img).convert("RGB")
    s = np.asarray(shot).astype(int)
    Rr, Gg, Bb = s[:, :, 0], s[:, :, 1], s[:, :, 2]
    rm = (Rr > 175) & (Gg < 56) & (Bb < 52) & (Rr-Gg > 100) & (Rr-Bb > 110)
    th, tw = rm.shape
    T = float(rm.sum())
    Dt = ndimage.distance_transform_edt(~rm).astype(np.float32)
    print(f"[shot] {tw}x{th}  路线红 {int(T):,}")

    res = []
    for k in np.linspace(A.kmin, A.kmax, A.nk):
        w_need = max(1, int(round(3.4*k)))
        for name, P in legs:
            big = Image.new("L", (RW, RH), 0); d = ImageDraw.Draw(big)
            d.line(list(zip((P[:, 0]-sx0).tolist(), (P[:, 1]-sy0).tolist())),
                   fill=255, width=w_need, joint="curve")
            iw, ih = int(round(RW/k)), int(round(RH/k))
            small = big.resize((iw, ih), Image.BOX)
            m = np.asarray(small) >= 96
            if m.sum() < 10:
                continue
            mf = m.astype(np.float32)
            Dl = np.minimum(ndimage.distance_transform_edt(~m), CAP).astype(np.float32)
            fwdS = fftconvolve(Dl, rm[::-1, ::-1], "valid")
            revS = fftconvolve(mf, Dt[::-1, ::-1], "valid")
            Nref = fftconvolve(mf, rm[::-1, ::-1], "valid")
            fwd = fwdS/T
            rev = revS/np.maximum(Nref, 1.0)
            # 非退化约束：窗口内该腿像素太少 → 反项=0 会伪造最优点，直接判废
            ok = Nref >= 0.15*T
            sc = np.where(ok, np.nan_to_num(fwd+rev), 1e9)
            i = np.unravel_index(np.argmin(sc), sc.shape)
            if not ok[i]:
                continue
            res.append((float(sc[i]), float(fwd[i]), float(rev[i]), k, name,
                        (sx0+int(i[0]*k), sy0+int(i[1]*k)), (int(th*k), int(tw*k))))
    res.sort(key=lambda z: z[0])
    if not res:
        print("无候选"); return
    print("\n候选（限定区域红线倒角）")
    for sc, fw, rv, k, name, (rr, cc), (nh, nw) in res[:A.top]:
        X = x0+(cc+nw/2)/W*span; Y = y1-(rr+nh/2)/H*(y1-y0)
        print(f"  {name:<12} score={sc:6.2f}=正{fw:5.2f}+反{rv:5.2f}  k={k:4.2f}  "
              f"左上({cc},{rr})  中心 {LON0+X/MLON:.6f},{LAT0+Y/MLAT:.6f}")

    n = min(A.top, len(res)); cols = 3; rows = (n+cols-1)//cols
    pad, lab = 8, 18
    cw, ch = tw*2+pad, th+lab
    sheet = Image.new("RGB", (cols*cw+pad*(cols+1), rows*ch+pad*(rows+1)), (238, 240, 244))
    dd = ImageDraw.Draw(sheet)
    for idx, (sc, fw, rv, k, name, (rr, cc), (nh, nw)) in enumerate(res[:n]):
        P = dict(legs)[name]
        vis = Image.new("RGB", (nw, nh), (255, 255, 255)); dv = ImageDraw.Draw(vis)
        dv.line(list(zip((P[:, 0]-cc).tolist(), (P[:, 1]-rr).tolist())),
                fill=(222, 28, 8), width=max(1, int(round(3.4*k))), joint="curve")
        # 淡灰底（宽凳）叠上去
        gb = Image.open(OUT / "_grey_clean.png").convert("RGB").crop((cc, rr, cc+nw, rr+nh))
        gb = Image.blend(Image.new("RGB", (nw, nh), (255, 255, 255)), gb, 0.55)
        dv2 = ImageDraw.Draw(gb)
        dv2.line(list(zip((P[:, 0]-cc).tolist(), (P[:, 1]-rr).tolist())),
                 fill=(222, 28, 8), width=max(1, int(round(3.4*k))), joint="curve")
        r_, c_ = divmod(idx, cols)
        ox = pad+c_*(cw+pad); oy = pad+r_*(ch+pad)
        sheet.paste(gb, (ox, oy+lab)); sheet.paste(shot, (ox+tw+pad, oy+lab))
        dd.text((ox+2, oy+3), f"#{idx} {name} k={k:.2f} s={sc:.2f} 正{fw:.2f}/反{rv:.2f}",
                fill=(30, 34, 44))
    sheet.save(OUT / "_cand_red_local.png")
    print("\n联络表 → out/_cand_red_local.png（左=该腿+淡灰底，右=截图）")


if __name__ == "__main__":
    main()
