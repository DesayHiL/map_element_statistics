# -*- coding: utf-8 -*-
"""在 route_kuandeng_coverage.html 自己的画布坐标里定位截图。

该图的路线折线以 SVG path 内联在 ON(红,走在宽凳上) / OFF(蓝,盲区) 两个数组里，
画布 5200x3908。直接用它自己的坐标匹配，绕开投影差异。
判据：截图红像素中能落在「某条 path 膨胀 R 像素」内的比例。
"""
import argparse, re, math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.signal import fftconvolve

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"


def parse_arrays(h):
    out = {}
    for m in re.finditer(r'([A-Za-z_$][\w$]{0,20})\s*=\s*\[\s*"M', h):
        name = m.group(1); st = h.index('[', m.start())
        depth = 0; i = st
        while i < len(h):
            if h[i] == '[': depth += 1
            elif h[i] == ']':
                depth -= 1
                if depth == 0: break
            i += 1
        body = h[st:i+1]
        try:
            arr = json.loads(body)
        except Exception:
            continue
        out[name] = arr
    return out


def path_to_xy(d):
    nums = re.findall(r'(-?\d+\.?\d*)[, ]+(-?\d+\.?\d*)', d)
    if len(nums) < 2:
        return None
    return np.array([[float(a), float(b)] for a, b in nums], "f8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("img")
    ap.add_argument("--html", default="out/route_kuandeng_coverage.html")
    ap.add_argument("--layer", default="ON")
    ap.add_argument("--F", type=int, default=2)
    ap.add_argument("--kmin", type=float, default=0.6)
    ap.add_argument("--kmax", type=float, default=2.6)
    ap.add_argument("--nk", type=int, default=14)
    ap.add_argument("--top", type=int, default=12)
    A = ap.parse_args()
    F = A.F
    h = (ROOT / A.html).read_text(encoding="utf-8")
    arrs = parse_arrays(h)
    print(f"[html] {A.html}  数组: " + ", ".join(f"{k}({len(v)})" for k, v in arrs.items()))
    Wm = int(re.search(r'const W=(\d+),H=(\d+)', h).group(1))
    Hm = int(re.search(r'const W=(\d+),H=(\d+)', h).group(2))
    print(f"[canvas] {Wm}x{Hm}")

    polys = [path_to_xy(d) for d in arrs[A.layer]]
    polys = [p for p in polys if p is not None]
    pts = np.concatenate(polys)
    print(f"[{A.layer}] {len(polys)} 段  顶点 {len(pts):,}  "
          f"x {pts[:,0].min():.0f}~{pts[:,0].max():.0f}  y {pts[:,1].min():.0f}~{pts[:,1].max():.0f}")

    shot = Image.open(A.img).convert("RGB"); th, tw = shot.size[1], shot.size[0]
    s = np.asarray(shot).astype(int)
    rm = (s[:, :, 0] > 175) & (s[:, :, 1] < 56) & (s[:, :, 2] < 52) & \
         (s[:, :, 0]-s[:, :, 1] > 100) & (s[:, :, 0]-s[:, :, 2] > 110)
    T = float(rm.sum()); print(f"[shot] {tw}x{th}  路线红 {int(T):,}")

    W1, H1 = Wm//F, Hm//F
    res = []
    for k in np.linspace(A.kmin, A.kmax, A.nk):
        twk, thk = int(round(tw*k/F)), int(round(th*k/F))
        if thk >= H1 or twk >= W1 or thk < 5 or twk < 5:
            continue
        t = np.asarray(Image.fromarray((rm*255).astype(np.uint8)).resize(
            (twk*F, thk*F), Image.BILINEAR)) > 25
        t = t[:thk*F, :twk*F].reshape(thk, F, twk, F).any(axis=(1, 3))
        Tt = float(t.sum())
        if Tt < 15:
            continue
        R = max(1, int(np.ceil(2.5*k/F)))
        for pi, P in enumerate(polys):
            xs, ys = P[:, 0], P[:, 1]
            if xs.max() < 0 or ys.max() < 0 or xs.min() > Wm or ys.min() > Hm:
                continue
            pad = R*2+2
            x0_, x1_ = int(xs.min())-pad, int(xs.max())+pad
            y0_, y1_ = int(ys.min())-pad, int(ys.max())+pad
            iw, ih = (x1_-x0_)//F+1, (y1_-y0_)//F+1
            if iw < 6 or ih < 6:
                continue
            im = Image.new("L", (iw, ih), 0); d = ImageDraw.Draw(im)
            d.line(list(zip(((xs-x0_)/F).tolist(), ((ys-y0_)/F).tolist())),
                   fill=255, width=max(1, int(round(3.4*k/F))), joint="curve")
            m = np.asarray(im) > 0
            if m.sum() < 3:
                continue
            if thk > ih or twk > iw:
                continue
            dil = ndimage.binary_dilation(m, iterations=R)
            B = fftconvolve(dil.astype(np.float32), t[::-1, ::-1], "valid")
            i = np.unravel_index(np.argmax(B), B.shape)
            cov = float(B[i])/Tt
            res.append((cov, pi, k, x0_+(i[0]+twk//2)*F, y0_+(i[1]+thk//2)*F, (thk, twk)))
    res.sort(key=lambda z: -z[0])
    print(f"\n{ A.layer } 逐段覆盖率排名（截图红线的百分之几能被该段覆盖）")
    seen = set()
    for cov, pi, k, cx, cy, (thk, twk) in res:
        if pi in seen:
            continue
        seen.add(pi)
        print(f"  #{pi:<4d} 覆盖 {cov*100:5.1f}%  k={k:.2f}  中心画布 ({cx:.0f},{cy:.0f})")
        if len(seen) >= A.top:
            break


import json
if __name__ == "__main__":
    main()
