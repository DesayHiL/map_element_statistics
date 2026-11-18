# -*- coding: utf-8 -*-
"""诊断：路线「途经隧道 N 个」到底命中了什么（复现 build_odd_quota.js 的口径）。

用法: python tools/diag_tunnels.py [街道名] [路线序号(1起)]
默认: 小金口街道 2
"""
import json, math, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PASS_M = 60

a = 6378245.0
ee = 0.00669342162296594323


def _out_of_china(lon, lat):
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
    if _out_of_china(lon, lat):
        return [lon, lat]
    d_lat = _tf_lat(lon - 105, lat - 35)
    d_lon = _tf_lon(lon - 105, lat - 35)
    rad = lat / 180 * math.pi
    magic = 1 - ee * math.sin(rad) ** 2
    sq = math.sqrt(magic)
    d_lat = (d_lat * 180) / ((a * (1 - ee)) / (magic * sq) * math.pi)
    d_lon = (d_lon * 180) / (a / sq * math.cos(rad) * math.pi)
    return [lon + d_lon, lat + d_lat]


def gcj2wgs(lon, lat):
    g = wgs2gcj(lon, lat)
    return [lon * 2 - g[0], lat * 2 - g[1]]


def densify(pts):
    out = []
    for i in range(1, len(pts)):
        ax, ay = pts[i - 1]
        bx, by = pts[i]
        d = math.hypot(bx - ax, by - ay)
        n = max(1, math.ceil(d / 0.0004))
        for k in range(n):
            out.append([ax + (bx - ax) * k / n, ay + (by - ay) * k / n])
    out.append(pts[-1])
    return out


def main():
    street = sys.argv[1] if len(sys.argv) > 1 else '小金口街道'
    idx = int(sys.argv[2]) - 1 if len(sys.argv) > 2 else 1

    routes = json.load(open(os.path.join(ROOT, 'out', 'routes.json'), encoding='utf-8'))
    tuns = json.load(open(os.path.join(ROOT, 'data', 'tunnels.json'), encoding='utf-8'))['elements']

    st = next(x for x in routes['routes'] if x['street'] == street)
    leg = st['routes'][idx]
    line = densify([gcj2wgs(p[0], p[1]) for p in leg['poly']])
    print(f'街道={street} 路线{idx+1} 里程={leg["distKm"]}km 折线点={len(line)}')

    # 网格索引，复现 JS 口径
    CELL = 0.001
    grid = {}
    for i, p in enumerate(line):
        grid.setdefault(f'{math.floor(p[0]/CELL)}|{math.floor(p[1]/CELL)}', []).append(i)

    def near(lon, lat):
        cx, cy = math.floor(lon / CELL), math.floor(lat / CELL)
        thr = (PASS_M / 111320 / math.cos(lat * math.pi / 180)) ** 2
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i in grid.get(f'{cx+dx}|{cy+dy}', []):
                    if (line[i][0] - lon) ** 2 + (line[i][1] - lat) ** 2 <= thr:
                        return True, min(
                            math.hypot((line[i][0]-lon)*111320*math.cos(lat*math.pi/180),
                                       (line[i][1]-lat)*110540)
                            for i in grid.get(f'{cx+dx}|{cy+dy}', []))
        return False, None

    hits = []
    for e in tuns:
        g = e.get('tags', {})
        if e.get('type') == 'node':
            c = (e.get('lon'), e.get('lat'))
        elif e.get('center'):
            c = (e['center']['lon'], e['center']['lat'])
        else:
            c = None
        if not c:
            continue
        ok, _ = near(c[0], c[1])
        if ok:
            hits.append({
                'id': e['id'], 'type': e['type'],
                'hw': g.get('highway', '(无)'), 'ref': g.get('ref', ''),
                'name': g.get('tunnel:name') or g.get('name') or '(无名)',
                'layer': g.get('layer', ''), 'tunnel': g.get('tunnel', ''),
            })

    print(f'\n命中 {len(hits)} 条：')
    grp = {}
    for h in hits:
        k = f'{h["name"]} | ref={h["ref"] or "无"} | highway={h["hw"]} | layer={h["layer"] or "-"}'
        grp.setdefault(k, []).append(h['id'])
    for k, ids in sorted(grp.items(), key=lambda x: -len(x[1])):
        print(f'  {len(ids):3d} × {k}')
        print(f'        ids: {ids}')

    # 判定真实「车辆可通行的隧道」
    rail = [h for h in hits if h['hw'] == '(无)' or 'link' in h['hw'] or h['hw'] in ('footway', 'steps', 'path', 'cycleway')]
    print(f'\n其中：无highway/步道/连接线类（多为铁路附属或非机动车道）= {len(rail)}')


if __name__ == '__main__':
    main()
