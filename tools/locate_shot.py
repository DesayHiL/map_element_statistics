# -*- coding: utf-8 -*-
"""把「截图」定位回 route_kuandeng_routes 的原图坐标 / 经纬度。

为什么不能直接拿 route_kuandeng_routes.png 做模板匹配：
  那张图上画了 271 个 87px 的路线号，市中心区被大字盖住，灰网出现大片假空洞，
  匹配会跑到标号最密的市中心去（假阳性）。

做法：用 out/_grey_clean.png（只有宽凳路网、无路线无标号）当参照，
  对截图做「倒角匹配」(chamfer)：模板灰线像素到参照最近灰线的平均距离最小处即为位置。
  该指标对截图被放大+高斯模糊、线宽差异都不敏感。

用法:
  python tools/locate_shot.py <截图.png> [--kmin 0.18] [--kmax 0.70] [--step 0.01] [--check]
    --check  额外输出 out/_loc_verify.png（左=参照裁剪放大，右=截图）供肉眼确认
"""
import argparse, math, json, subprocess, sys
from pathlib import Path
import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.signal import fftconvolve

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT/"out"
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0*math.cos(math.radians(LAT0)); MLAT = 110574.0
W0, PAD_M = 5200, 8000.0

def grey_mask(a, tol=32):
    R, G, B = a[:,:,0].astype(int), a[:,:,1].astype(int), a[:,:,2].astype(int)
    return (np.abs(R-108) < tol) & (np.abs(G-118) < tol) & (np.abs(B-136) < tol)

def pool_min(a, f=2):
    h, w = a.shape; h2, w2 = h//f*f, w//f*f
    return a[:h2,:w2].reshape(h//f,f,w//f,f).min(axis=(1,3))
def pool_max(b, f=2):
    h, w = b.shape; h2, w2 = h//f*f, w//f*f
    return b[:h2,:w2].reshape(h//f,f,w//f,f).any(axis=(1,3))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("img"); ap.add_argument("--kmin", type=float, default=0.18)
    ap.add_argument("--kmax", type=float, default=0.70); ap.add_argument("--step", type=float, default=0.01)
    ap.add_argument("--check", action="store_true")
    A = ap.parse_args()

    ref_p = OUT/"_grey_clean.png"
    if not ref_p.exists():
        print("[i] 生成参照底图 out/_grey_clean.png ...")
        subprocess.run([sys.executable, str(ROOT/"tools/_greybase.py")], check=True)
    ref = grey_mask(np.array(Image.open(ref_p).convert("RGB")), 20)
    DTh = pool_min(ndimage.distance_transform_edt(~ref).astype(np.float32), 2)

    tpl = grey_mask(np.array(Image.open(A.img).convert("RGB")), 32)
    h, w = tpl.shape
    res = []
    for k in np.arange(A.kmin, A.kmax+1e-9, A.step):
        im = Image.fromarray((tpl*255).astype(np.uint8)).resize(
                (max(8, int(round(w*k))), max(8, int(round(h*k)))), Image.BILINEAR)
        t = pool_max(np.array(im) > 127, 2).astype(np.float32)
        if min(t.shape) < 4 or t.shape[0] >= DTh.shape[0] or t.shape[1] >= DTh.shape[1]: continue
        C = fftconvolve(DTh, t[::-1,::-1], mode="valid")/float(t.sum())
        i = np.unravel_index(np.argmin(C), C.shape)
        res.append((float(C[i])*2, k, (int(i[0]), int(i[1])), t.shape))
    res.sort()
    if not res: print("未匹配"); return

    # 视窗 -> 经纬度
    doc = json.loads((OUT/"routes.json").read_text(encoding="utf-8"))
    a_ = []; b_ = []
    for st in doc["routes"]:
        for r in st["routes"]:
            P = np.asarray(r["poly"], "f8")
            a_.append((P[:,0]-LON0)*MLON); b_.append((P[:,1]-LAT0)*MLAT)
    x0, x1 = min(a.min() for a in a_)-PAD_M, max(a.max() for a in a_)+PAD_M
    y0, y1 = min(b.min() for b in b_)-PAD_M, max(b.max() for b in b_)+PAD_M
    span = x1-x0; H0 = int(round(W0*(y1-y0)/span))
    def px2ll(col, row):
        X = x0+col/W0*span; Y = y1-row/H0*(y1-y0)
        return LON0+X/MLON, LAT0+Y/MLAT

    print(f"截图 {A.img}  {w}x{h}")
    for dist, k, idx, sh in res[:4]:
        ctr_r = idx[0]*2+sh[0]; ctr_c = idx[1]*2+sh[1]
        tlr = idx[0]*2; tlc = idx[1]*2
        lon, lat = px2ll(ctr_c, ctr_r)
        print(f"  缩放 {k:.2f}（截图=原图 {1/k:.2f}×） 平均偏离 {dist:5.2f} 原图像素"
              f"  中心 原图(row {ctr_r},col {ctr_c}) → lon {lon:.6f}, lat {lat:.6f}"
              f"  左上(row {tlr},col {tlc}) 尺寸({sh[0]*2}x{sh[1]*2})")

    if A.check:
        dist, k, idx, sh = res[0]
        tlr, tlc = idx[0]*2, idx[1]*2
        nr, nc = sh[0]*2, sh[1]*2
        crop = Image.open(ref_p).convert("RGB").crop((tlc, tlr, tlc+nc, tlr+nr)).resize((w, h), Image.LANCZOS)
        shot = Image.open(A.img).convert("RGB")
        out = Image.new("RGB", (w*2+20, h), (245,246,248))
        out.paste(crop, (0, 0)); out.paste(shot, (w+20, 0))
        out.save(OUT/"_loc_verify.png")
        print("  验证图 → out/_loc_verify.png（左＝参照裁剪，右＝截图，应完全同构）")

if __name__ == "__main__":
    main()
