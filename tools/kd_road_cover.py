# -*- coding: utf-8 -*-
"""候选工况道路 × 宽凳路网覆盖度实测（把宽凳约束前移进规划器的前置量测）。

为什么需要：用户明令「路线规划必须按宽凳地图约束」——但根因在上游选路器
（select_odd.js 的候选池只按 km≥0.3 命名非高速，零宽凳约束）。要在规划器前移约束，
先得知道候选池里到底有多少条落在宽凳上。

本工具只做量测，不改任何产物：
  1. 读宽凳 ROAD_LINK.geom.bin（GCJ-02）→ 投影 XY → KD 树
  2. 复刻 select_odd.js 的候选实体口径（street|name|cls，km≥0.3，非高速）
  3. OSM 道路为 WGS-84 → 转 GCJ-02 后贴宽凳，逐条算「沿路采样点落在宽凳 30m 内的占比」
  4. 输出 out/kd_road_cover.json + 控制台分布，并单独标注已选中道路的覆盖情况

用法：python tools/kd_road_cover.py [--band 30]
"""
import json, math, sys, time
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree

ROOT = Path(r"D:/workspace/map_element_statistics")
OUT = ROOT / "out"
DATA = ROOT / "data"
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0
BAND = 30.0          # 采样点距宽凳路 ≤ 此值算「在宽凳上」（m）
STEP = 25.0          # 沿路重采样步长（m）
KM_MIN = 0.3         # 与 select_odd.js 同口径

# ---------- WGS84 → GCJ02 ----------
PI = math.pi; A = 6378245.0; EE = 0.00669342162296594323
def _tlat(x, y):
    r = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*math.sqrt(abs(x))
    r += ((20*math.sin(6*x*PI) + 20*math.sin(2*x*PI))*2)/3
    r += ((20*math.sin(y*PI) + 40*math.sin((y/3)*PI))*2)/3
    r += ((160*math.sin(y/12*PI) + 320*math.sin((y*PI)/30))*2)/3
    return r
def _tlon(x, y):
    r = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*math.sqrt(abs(x))
    r += ((20*math.sin(x*PI) + 40*math.sin((x/3)*PI))*2)/3
    r += ((150*math.sin(x/12*PI) + 300*math.sin((x/30)*PI))*2)/3
    return r
def wgs2gcj(lon, lat):
    dlat = _tlat(lon-105, lat-35); dlon = _tlon(lon-105, lat-35)
    rad = lat/180*PI
    m = math.sin(rad); m = 1 - EE*m*m; sq = math.sqrt(m)
    dlat = (dlat*180)/(((A*(1-EE))/(m*sq))*PI)
    dlon = (dlon*180)/((A/sq)*math.cos(rad)*PI)
    return lon+dlon, lat+dlat

def ll_to_xy(lon, lat):
    return np.column_stack([(np.asarray(lon, "f8")-LON0)*MLON, (np.asarray(lat, "f8")-LAT0)*MLAT])

def haversine(a, b):
    R = 6371008.8; r = math.pi/180
    dlat = r*(b[1]-a[1]); dlon = r*(b[0]-a[0])
    h = math.sin(dlat/2)**2 + math.cos(r*a[1])*math.cos(r*b[1])*math.sin(dlon/2)**2
    return 2*R*math.asin(math.sqrt(h))

def densify(coords, step=STEP):
    """沿折线按 ≤step 米重采样（用于覆盖度统计）"""
    pts = []
    for i in range(1, len(coords)):
        a, b = coords[i-1], coords[i]
        d = haversine(a, b)
        n = max(2, int(d // step) + 1)
        for k in range(n):
            t = k/(n-1)
            pts.append((a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t))
    return pts

def load_kd_tree():
    t0 = time.time()
    f = np.load(CACHE/"ROAD_LINK.fixed.npy", mmap_mode="r")
    geom = np.memmap(CACHE/"ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
    goff = np.asarray(f["geom_off"], dtype="i8")//16
    gn = np.asarray(f["geom_n"], dtype="i4")
    n = len(gn)
    # 取每条 link 的全部几何点
    tot = int(gn.sum())
    idx = np.repeat(goff, gn) + np.concatenate([np.arange(g) for g in gn])
    P = np.asarray(geom[idx])          # (tot,2) lon/lat GCJ-02
    xy = ll_to_xy(P[:, 0], P[:, 1])
    tree = cKDTree(xy)
    print(f"[kd] ROAD_LINK 几何点 {tot:,} 条 · 建 KD 树 {time.time()-t0:.1f}s")
    return tree

# OSM highway → 等级（与 select_odd.js 的 HW_CLASS 对齐：只保留命名非高速）
HW_CLASS = {
    'motorway': None, 'motorway_link': None, 'trunk': None, 'trunk_link': None,
    'primary': 'arterial', 'primary_link': 'arterial',
    'secondary': 'subArterial', 'secondary_link': 'subArterial',
    'tertiary': 'collector', 'tertiary_link': 'collector',
    'unclassified': 'local', 'residential': 'local', 'living_street': 'local',
    'service': 'service', 'road': 'rural',
}

def main():
    band = BAND
    if "--band" in sys.argv:
        band = float(sys.argv[sys.argv.index("--band")+1])
    tree = load_kd_tree()

    roads = json.load(open(DATA/"roads.json", encoding="utf-8"))
    subnames = {e["tags"]["name"] for e in json.load(open(DATA/"hc_subnames.json", encoding="utf-8"))["elements"] if e.get("tags", {}).get("name")}
    bnd = json.load(open(DATA/"boundaries_geom.json", encoding="utf-8"))
    extra = json.load(open(DATA/"lilin.json", encoding="utf-8"))
    # 简化：用 bbox 粗筛 + 中心点判定（与 select_odd 的 pointInPolygon 同源，这里复用）
    def point_in_ring(lon, lat, ring):
        ins = False
        for i in range(len(ring)):
            j = (i-1) % len(ring)
            xi, yi = ring[i]; xj, yj = ring[j]
            if (yi > lat) != (yj > lat) and lon < (xj-xi)*(lat-yi)/(yj-yi)+xi:
                ins = not ins
        return ins
    def stitch(segments):
        pool = [s[:] for s in segments]; rings = []
        def same(a, b): return abs(a[0]-b[0]) < 1e-9 and abs(a[1]-b[1]) < 1e-9
        while pool:
            cur = pool.pop(0); ext = True
            while ext and not same(cur[0], cur[-1]):
                ext = False
                for i, s in enumerate(pool):
                    if same(cur[-1], s[0]): cur = cur + s[1:]; pool.pop(i); ext = True; break
                    if same(cur[-1], s[-1]): cur = cur + s[:-1][::-1]; pool.pop(i); ext = True; break
                    if same(cur[0], s[-1]): cur = s[:-1] + cur; pool.pop(i); ext = True; break
                    if same(cur[0], s[0]): cur = s[1:][::-1] + cur; pool.pop(i); ext = True; break
            if len(cur) >= 4: rings.append(cur)
        return rings
    areas = []
    for el in (bnd["elements"] + extra["elements"]):
        tg = el.get("tags", {})
        if tg.get("admin_level") != "8" or tg.get("name") not in subnames:
            continue
        segs = []
        for m in el.get("members", []):
            if m.get("type") != "way" or not m.get("geometry") or len(m["geometry"]) < 2 or m.get("role") == "inner":
                continue
            segs.append([[p["lon"], p["lat"]] for p in m["geometry"]])
        rings = stitch(segs)
        if rings: areas.append(rings)
    def inside(lon, lat):
        for rings in areas:
            for r in rings:
                if point_in_ring(lon, lat, r): return True
        return False

    ents = {}
    for el in roads["elements"]:
        g = el.get("geometry")
        if not g or len(g) < 2:
            continue
        coords = [[p["lon"], p["lat"]] for p in g]
        mid = coords[len(coords)//2]
        if not inside(mid[0], mid[1]):
            continue
        tg = el.get("tags", {})
        name = tg.get("name"); cls = HW_CLASS.get(tg.get("highway", ""), "MISS")
        if not cls or cls == "MISS" or not name:
            continue
        km = sum(haversine(coords[i-1], coords[i]) for i in range(1, len(coords)))/1000
        key = f"{name}|{cls}"          # 与 select_odd 的 street|name|cls 等价（街道已由 inside 保证）
        e = ents.setdefault(key, {"name": name, "cls": cls, "km": 0.0, "coords": []})
        e["km"] += km
        e["coords"].extend(coords)

    cand = [e for e in ents.values() if round(e["km"], 1) >= KM_MIN]
    print(f"[cand] 候选道路（命名·非高速·≥{KM_MIN}km·区内）{len(cand)} 条")

    rows = []
    for e in cand:
        coords = e["coords"]
        S = densify(coords, STEP)
        g = np.array([wgs2gcj(p[0], p[1]) for p in S])
        xy = ll_to_xy(g[:, 0], g[:, 1])
        d, _ = tree.query(xy, k=1, distance_upper_bound=1e9)
        on = d <= band
        rows.append({
            "name": e["name"], "cls": e["cls"], "km": round(e["km"], 2),
            "cover": round(float(on.mean()), 4),
            "p50_dev": round(float(np.percentile(d, 50)), 1),
            "p90_dev": round(float(np.percentile(d, 90)), 1),
        })
    rows.sort(key=lambda r: -r["km"])

    # 分布
    cov = np.array([r["cover"] for r in rows])
    print(f"\n=== 候选道路 ∈ 宽凳覆盖（采样点 ≤{band:.0f}m 占比）===")
    for lo in [0, 0.01, 0.2, 0.5, 0.8, 0.95, 1.001]:
        pass
    bins = [(0, 0.0001, "完全不在宽凳"), (0.0001, 0.2, "零星触达 <20%"),
            (0.2, 0.5, "部分 20-50%"), (0.5, 0.8, "大半 50-80%"),
            (0.8, 0.95, "基本覆盖 80-95%"), (0.95, 1.0001, "全覆盖 ≥95%")]
    for lo, hi, lab in bins:
        m = (cov >= lo) & (cov < hi)
        print(f"  {lab:<18} {int(m.sum()):>5} 条  {rows and sum(r['km'] for r in rows if lo <= r['cover'] < hi):>8.1f} km")
    print(f"  {'合计':<18} {len(rows):>5} 条  {sum(r['km'] for r in rows):>8.1f} km")
    print(f"  加权平均覆盖 {float((cov*np.array([r['km'] for r in rows])).sum()/sum(r['km'] for r in rows)):.3f}")

    json.dump({"band": band, "step": STEP, "n": len(rows), "rows": rows},
              open(OUT/"kd_road_cover.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"\n[out] out/kd_road_cover.json")

if __name__ == "__main__":
    main()
