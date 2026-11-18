# -*- coding: utf-8 -*-
"""生成路线「途经隧道」诊断图：
  - 画路线折线
  - 把 60m 内命中的隧道路段点按真实性质着色标注（铁路/涵洞/步道/高速域/真车行）
用法: python tools/render_tunnel_diag.py [街道] [路线序号1起]
"""
import json, math, os, sys, re
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PASS_M = 60
a, ee = 6378245.0, 0.00669342162296594323


def _ooc(lon, lat):
    return not (72.004 <= lon <= 137.8347 and 0.8293 <= lat <= 55.8271)


def _tf_lat(x, y):
    r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    r += (20 * math.sin(6 * x * math.pi) + 20 * math.sin(2 * x * math.pi)) * 2 / 3
    r += (20 * math.sin(y * math.pi) + 40 * math.sin(y / 3 * math.pi)) * 2 / 3
    r += (160 * math.sin(y / 12 * math.pi) + 320 * math.sin(y * math.pi / 30)) * 2 / 3
    return r


def _tf_lon(x, y):
    r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    r += (20 * math.sin(6 * x * math.pi) + 20 * math.sin(2 * x * math.pi)) * 2 / 3
    r += (20 * math.sin(x * math.pi) + 40 * math.sin(x / 3 * math.pi)) * 2 / 3
    r += (150 * math.sin(x / 12 * math.pi) + 300 * math.sin(x / 30 * math.pi)) * 2 / 3
    return r


def wgs2gcj(lon, lat):
    if _ooc(lon, lat):
        return [lon, lat]
    dlat, dlon = _tf_lat(lon - 105, lat - 35), _tf_lon(lon - 105, lat - 35)
    rad = lat / 180 * math.pi
    m = 1 - ee * math.sin(rad) ** 2
    s = math.sqrt(m)
    dlat = (dlat * 180) / ((a * (1 - ee)) / (m * s) * math.pi)
    dlon = (dlon * 180) / (a / s * math.cos(rad) * math.pi)
    return [lon + dlon, lat + dlat]


def gcj2wgs(lon, lat):
    g = wgs2gcj(lon, lat)
    return [lon * 2 - g[0], lat * 2 - g[1]]


def densify(pts):
    out = []
    for i in range(1, len(pts)):
        ax, ay = pts[i - 1]; bx, by = pts[i]
        n = max(1, math.ceil(math.hypot(bx - ax, by - ay) / 0.0004))
        for k in range(n):
            out.append([ax + (bx - ax) * k / n, ay + (by - ay) * k / n])
    out.append(pts[-1])
    return out


FONT_PATHS = [r'C:/Windows/Fonts/msyh.ttc', r'C:/Windows/Fonts/simhei.ttf', r'C:/Windows/Fonts/simsun.ttc']


def font(sz):
    for p in FONT_PATHS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, sz)
            except Exception:
                pass
    return ImageFont.load_default()


# 真实性质判定 —— 与 lib_carrier_filter.js 严格同口径
ODD_ROAD = re.compile(r'^(primary|secondary|tertiary|unclassified|residential|living_street|service|road|track)(_link)?$')
HWDOM = re.compile(r'^(motorway|trunk)(_link)?$')
NONVEH = re.compile(r'^(footway|steps|path|cycleway|pedestrian|bridleway|corridor|platform)$')


def real_kind(g):
    if g.get('railway'):
        return 'rail', '铁路隧道（railway=rail）'
    if g.get('waterway'):
        return 'culvert', '溪流涵洞（tunnel=culvert）'
    hw = g.get('highway')
    if not hw:
        return 'nolabel', '无路网标签'
    if NONVEH.match(hw):
        return 'foot', '人行/非机动车道（%s）' % hw
    if HWDOM.match(hw):
        return 'highwaydom', '高速域（%s）' % hw
    if ODD_ROAD.match(hw):
        return 'vehicle', '车辆路·ODD 内（%s）' % hw
    return 'other', '其他（%s）' % hw


COLOR = {
    'rail': (220, 38, 38),
    'culvert': (37, 99, 235),
    'foot': (217, 119, 6),
    'nolabel': (107, 33, 168),
    'highwaydom': (100, 116, 139),
    'vehicle': (22, 163, 74),
}


def main():
    street = sys.argv[1] if len(sys.argv) > 1 else '小金口街道'
    idx = int(sys.argv[2]) - 1 if len(sys.argv) > 2 else 1
    routes = json.load(open(os.path.join(ROOT, 'out', 'routes.json'), encoding='utf-8'))
    tuns = json.load(open(os.path.join(ROOT, 'data', 'tunnels.json'), encoding='utf-8'))['elements']
    st = next(x for x in routes['routes'] if x['street'] == street)
    leg = st['routes'][idx]
    line = densify([gcj2wgs(p[0], p[1]) for p in leg['poly']])

    hits = []
    for e in tuns:
        g = e.get('tags', {})
        c = (e.get('lon'), e.get('lat')) if e.get('type') == 'node' else (
            (e['center']['lon'], e['center']['lat']) if e.get('center') else None)
        if not c:
            continue
        lat = c[1]
        cosl = math.cos(lat * math.pi / 180)
        best = None
        for p in line:
            dx = (p[0] - c[0]) * 111320 * cosl
            dy = (p[1] - c[1]) * 110540
            d = math.hypot(dx, dy)
            if best is None or d < best:
                best = d
        if best <= PASS_M:
            k, desc = real_kind(g)
            hits.append({'lon': c[0], 'lat': c[1], 'dist': best, 'kind': k, 'desc': desc,
                         'name': g.get('tunnel:name') or g.get('name') or '(无名)', 'id': e['id']})

    from collections import Counter
    cnt = Counter(h['kind'] for h in hits)

    # 真车行去重（同一隧道被 OSM 拆成多段：中心点 <50m 视为同一处）
    def _cluster(veh):
        cl = []
        for h in veh:
            for c in cl:
                if math.hypot((h['lon'] - c[0][0]) * 111320 * math.cos(h['lat'] * math.pi / 180),
                              (h['lat'] - c[0][1]) * 110540) < 50:
                    c.append((h['lon'], h['lat'])); break
            else:
                cl.append([(h['lon'], h['lat'])])
        return cl
    clusters_early = _cluster([h for h in hits if h['kind'] == 'vehicle'])
    print(f'命中 {len(hits)} 条：', dict(cnt), '· 实际可驶入隧道', len(clusters_early), '个')

    # ---- 渲染 ----
    W, H = 1500, 1080
    img = Image.new('RGB', (W, H), (248, 250, 252))
    dr = ImageDraw.Draw(img)
    f_t, f_b, f_s = font(22), font(15), font(13)

    dr.text((24, 18), f'「{street} · 路线{idx+1}」途经隧道诊断 —— 标注 {len(hits)} 条，实际可驶入隧道 {len(clusters_early)} 个', font=f_t, fill=(15, 23, 42))
    dr.text((24, 50), f'判定：元素点到导航折线 ≤{PASS_M}m 即计途经（build_odd_quota.js PASS_M）· 数据源 data/tunnels.json（OSM）', font=f_s, fill=(100, 116, 139))

    # 地图区
    mx0, my0, mx1, my1 = 24, 84, 940, 1000
    dr.rectangle([mx0, my0, mx1, my1], fill=(255, 255, 255), outline=(226, 232, 240))
    lons = [p[0] for p in line] + [h['lon'] for h in hits]
    lats = [p[1] for p in line] + [h['lat'] for h in hits]
    lo0, lo1, la0, la1 = min(lons), max(lons), min(lats), max(lats)
    pad = 0.008
    lo0, lo1, la0, la1 = lo0 - pad, lo1 + pad, la0 - pad, la1 + pad
    sc = min((mx1 - mx0 - 40) / (lo1 - lo0) if (lo1 - lo0) else 1,
             (my1 - my0 - 40) / (la1 - la0) if (la1 - la0) else 1)
    # 居中
    cx = (mx0 + mx1) / 2
    cyy = (my0 + my1) / 2
    ox = cx - ((lo0 + lo1) / 2) * sc
    oy = cyy + ((la0 + la1) / 2) * sc

    def XY(lon, lat):
        return ox + lon * sc, oy - lat * sc

    # 路线
    dr.line([XY(p[0], p[1]) for p in line], fill=(14, 116, 144), width=3, joint='curve')
    # 命中点
    for h in hits:
        x, y = XY(h['lon'], h['lat'])
        col = COLOR[h['kind']]
        r = 7
        dr.ellipse([x - r, y - r, x + r, y + r], fill=col, outline=(255, 255, 255), width=2)

    # ---- 图例 ----
    lx, ly = 966, 100
    dr.text((lx, ly - 30), '命中条目的真实性质', font=f_b, fill=(15, 23, 42))
    order = ['rail', 'culvert', 'foot', 'nolabel', 'highwaydom', 'vehicle']
    for k in order:
        if cnt.get(k, 0) == 0:
            continue
        col = COLOR[k]
        dr.ellipse([lx, ly + 4, lx + 14, ly + 18], fill=col)
        dr.text((lx + 24, ly), f'{cnt[k]} 条 · {[d for kk, d in [(x, real_kind({"railway":1} if x=="rail" else {"waterway":1} if x=="culvert" else {"highway":d2}))[1] for x in []]]}' if False else '', font=f_s, fill=(51, 65, 85))
        label = {'rail': '铁路隧道 railway=rail', 'culvert': '溪流涵洞 tunnel=culvert',
                 'foot': '人行/非机动车道', 'nolabel': '无路网标签', 'highwaydom': '高速域 motorway/trunk/link',
                 'vehicle': '车辆路 · ODD 内（真隧道）'}[k]
        dr.text((lx + 24, ly), f'{cnt[k]} 条 · {label}', font=f_s, fill=(51, 65, 85))
        ly += 30

    # ---- 明细表 ----
    ty = ly + 24
    dr.text((lx, ty - 24), '命中明细（按性质归组）', font=f_b, fill=(15, 23, 42))
    grp = {}
    for h in hits:
        grp.setdefault(h['kind'], []).append(h)
    for k in order:
        if k not in grp:
            continue
        col = COLOR[k]
        n = len(grp[k])
        names = {}
        for h in grp[k]:
            nm = h['name']
            names[nm] = names.get(nm, 0) + 1
        nmtxt = '、'.join(f'{v}×{kk}' for kk, v in sorted(names.items(), key=lambda x: -x[1])[:3])
        dr.rectangle([lx, ty, lx + 12, ty + 12], fill=col)
        dr.text((lx + 20, ty - 2), f'{n} 条', font=f_s, fill=(15, 23, 42))
        dr.text((lx + 20, ty + 16), nmtxt[:34], font=f_s, fill=(100, 116, 139))
        ty += 42

    # 真车行的去重（同一隧道被 OSM 拆成多段：中心点 <50m 视为同一处）
    veh = [h for h in hits if h['kind'] == 'vehicle']
    clusters = []
    for h in veh:
        for c in clusters:
            if math.hypot((h['lon'] - c[0][0]) * 111320 * math.cos(h['lat'] * math.pi / 180),
                          (h['lat'] - c[0][1]) * 110540) < 50:
                c.append((h['lon'], h['lat'])); break
        else:
            clusters.append([(h['lon'], h['lat'])])

    # ---- 结论 ----
    cy = ty + 16
    dr.line([lx, cy, lx + 500, cy], fill=(226, 232, 240), width=1)
    cy += 14
    dr.text((lx, cy), '结论', font=f_b, fill=(15, 23, 42)); cy += 26
    lines = [
        f'标注「隧道 {len(hits)}/139」中：',
        f'  · 车辆路隧道 {cnt.get("vehicle",0)} 条 ← 真正可驶入',
        f'    （金石二路下穿 + 一条无名 primary_link 地下段）',
        f'  · 铁路隧道 {cnt.get("rail",0)} 条 ← 莞惠/广惠城际等，车开不进去',
        f'  · 溪流涵洞 {cnt.get("culvert",0)} 条 ← tunnel=culvert，非隧道',
        f'  · 人行道 {cnt.get("foot",0)} 条 ← footway，车不可通行',
        f'  · 高速域 {cnt.get("highwaydom",0)} 条 ← 无人小车不上主线',
        '',
        '根因：数据未按载体过滤 —— OSM 的 tunnel=yes 同时',
        '用于铁路、水道涵洞、人行道；选路脚本 plan_routes_v2.js',
        '有 rail:true 过滤，但统计脚本 build_odd_quota.js 未过滤。',
        '',
        f'全区影响：区内 315 条隧道中，非 ODD 载体 205 条（65%）。',
    ]
    for t in lines:
        dr.text((lx, cy), t, font=f_s, fill=(51, 65, 85)); cy += 20

    out = os.path.join(ROOT, 'out', 'tunnel_diag.png')
    img.save(out)
    print('saved', out)


if __name__ == '__main__':
    main()
