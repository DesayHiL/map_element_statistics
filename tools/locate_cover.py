# -*- coding: utf-8 -*-
"""全图逐腿"覆盖率"定位：哪条排班路线能覆盖截图中那条红线？

判据（非退化、直观）：
  cover(leg, k, pos) = 截图红像素中，落在「该腿膨胀 R 像素」范围内的比例
                     = fftconvolve(dilate(legmask,R), rm_flipped) / T
  取该腿在所有 k 与所有位置上的最大值。
正确的腿应能覆盖 ≈100%；无关的腿很低。R 随 k 缩放（R = 2.5*k/F 画布像素）。

参照在 canvas/F 尺度光栅化，线宽 max(1, round(3.4k/F))。
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
MLON = 111320.0*math.cos(math.radians(LAT0)); MLAT = 110574.0
W, PAD_M = 5200, 8000.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("img")
    ap.add_argument("--F", type=int, default=4)
    ap.add_argument("--kmin", type=float, default=1.2)
    ap.add_argument("--kmax", type=float, default=5.0)
    ap.add_argument("--nk", type=int, default=10)
    ap.add_argument("--top", type=int, default=15)
    ap.add_argument("--dlegs", type=int, default=0, help="1=只搜含 D 段(接不上宽凳)的 15 条腿")
    A = ap.parse_args()
    F = A.F

    doc = json.loads((OUT/"routes.json").read_text(encoding="utf-8"))
    keep = None
    if A.dlegs:
        summ = json.loads((OUT/"kd_corridor_summary.json").read_text(encoding="utf-8"))
        keep = {(s["street"], s["n"]) for s in summ["segs"] if not s["ok"]}
        print(f"[filter] 只搜含 D 段的 {len(keep)} 条腿: "
              + ", ".join(f"{a}{b}" for a, b in sorted(keep)))
    legs = []
    for st in doc["routes"]:
        for i, r in enumerate(st.get("routes", []), start=1):
            if keep is not None and (st["street"], i) not in keep:
                continue
            P = np.asarray(r["poly"], "f8")
            legs.append((f"{st['street']}路线{i}",
                         np.column_stack([(P[:, 0]-LON0)*MLON, (P[:, 1]-LAT0)*MLAT])))
    allxy = np.concatenate([L[1] for L in legs])
    x0 = allxy[:, 0].min()-PAD_M; x1 = allxy[:, 0].max()+PAD_M
    y0 = allxy[:, 1].min()-PAD_M; y1 = allxy[:, 1].max()+PAD_M
    span = x1-x0; H = int(round(W*(y1-y0)/span))
    W1, H1 = W//F, H//F
    print(f"[view] {W}x{H}  腿 {len(legs)}  参照 {F}x → {W1}x{H1}")

    shot = Image.open(A.img).convert("RGB")
    s = np.asarray(shot).astype(int)
    rm = (s[:, :, 0] > 175) & (s[:, :, 1] < 56) & (s[:, :, 2] < 52) & \
         (s[:, :, 0]-s[:, :, 1] > 100) & (s[:, :, 0]-s[:, :, 2] > 110)
    th, tw = rm.shape; T = float(rm.sum())
    print(f"[shot] {tw}x{th}  路线红 {int(T):,}")

    # 每条腿在每 k 下的掩膜（canvas/F 尺度）
    masks = {}
    for li, (name, xy) in enumerate(legs):
        for k in np.linspace(A.kmin, A.kmax, A.nk):
            im = Image.new("L", (W1, H1), 0); d = ImageDraw.Draw(im)
            px = (xy[:, 0]-x0)/span*W; py = (y1-xy[:, 1])/(y1-y0)*H
            d.line(list(zip((px/F).tolist(), (py/F).tolist())),
                   fill=255, width=max(1, int(round(3.4*k/F))), joint="curve")
            m = np.asarray(im) > 0
            if m.sum() < 8:
                continue
            masks[(li, round(k, 3))] = m

    res = []
    ks = sorted({k for (_, k) in masks})
    for li, (name, _) in enumerate(legs):
        best = None
        for k in ks:
            m = masks.get((li, round(k, 3)))
            if m is None:
                continue
            twk = int(round(tw*k/F)); thk = int(round(th*k/F))
            if thk >= H1 or twk >= W1 or thk < 4 or twk < 4:
                continue
            t = np.asarray(Image.fromarray((rm*255).astype(np.uint8)).resize(
                (twk*F, thk*F), Image.BILINEAR)) > 25
            t = t[:thk*F//F*F, :twk*F//F*F]
            t = t.reshape(thk, F, twk, F).any(axis=(1, 3))
            Tt = float(t.sum())
            if Tt < 15:
                continue
            R = 2.5*k/F
            dil = ndimage.binary_dilation(m, iterations=int(np.ceil(R)))
            B = fftconvolve(dil.astype(np.float32), t[::-1, ::-1], "valid")/Tt
            i = np.unravel_index(np.argmax(B), B.shape)
            if best is None or B[i] > best[0]:
                best = (float(B[i]), k, int(i[0]), int(i[1]), (thk, twk))
        if best:
            res.append((best[0], name, best[1], best[2], best[3], best[4]))
    res.sort(key=lambda z: -z[0])
    print("\n逐腿覆盖率排名（截图红线的百分之几能被该腿覆盖）")
    for cov, name, k, r, c, (thk, twk) in res[:A.top]:
        X = x0+(c*F+twk*F/2)/W*span; Y = y1-(r*F+thk*F/2)/H*(y1-y0)
        print(f"  {name:<14} 覆盖 {cov*100:5.1f}%  k={k:.2f}  中心 {LON0+X/MLON:.5f},{LAT0+Y/MLAT:.5f}")


if __name__ == "__main__":
    main()
