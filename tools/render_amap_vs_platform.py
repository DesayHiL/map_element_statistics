# -*- coding: utf-8 -*-
"""逐条对比图：高德规划(灰) vs 平台规划(绿)——一次只显示一条路线，避免叠加混淆。
数据: out/routes.json(amap poly) + out/platform_routes_now.json(platform routePath)
      + odd_plan.json(站点) + out/minwp_audit.json / resolve_152.json(精简后点数)
输出: out/amap_vs_platform.html
"""
import json, math
from pathlib import Path

ROOT = Path(r"D:/workspace/map_element_statistics")
OUT = ROOT / "out"
LAT0, LON0 = 23.16, 114.40
MLON = 111320.0 * math.cos(math.radians(LAT0)); MLAT = 110574.0

def to_xy(lon, lat):
    return (lon - LON0) * MLON, (lat - LAT0) * MLAT

amap = json.loads((OUT / "routes.json").read_text(encoding="utf-8"))
plat = json.loads((OUT / "platform_routes_now.json").read_text(encoding="utf-8"))
plan = json.loads((ROOT / "odd_plan.json").read_text(encoding="utf-8"))

amap_leg = {}
for st in amap["routes"]:
    for ri, r in enumerate(st.get("routes", [])):
        amap_leg[st["street"] + "|路线" + str(ri + 1)] = r
name2leg = {p["name"]: (p["street"], p["rn"]) for p in plan}
name2plan = {p["name"]: p for p in plan}
name2gid = {p["name"]: i + 1 for i, p in enumerate(plan)}
wpnow = {}
for fn in ["minwp_audit.json", "resolve_152.json"]:
    f = OUT / fn
    if not f.exists():
        continue
    d = json.loads(f.read_text(encoding="utf-8"))
    for x in (d if isinstance(d, list) else [d]):
        if x.get("name") and x.get("minWp") is not None:
            wpnow[x["name"]] = x["minWp"]

def d2poly(pt, poly):
    best = 1e18
    px, py = to_xy(pt[0], pt[1])
    for i in range(len(poly) - 1):
        ax, ay = to_xy(poly[i][0], poly[i][1])
        bx, by = to_xy(poly[i + 1][0], poly[i + 1][1])
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
        best = min(best, math.hypot(px - (ax + t * dx), py - (ay + t * dy)))
    return best

def haus(A, B):
    s = n = 0
    for i in range(0, len(A), 3):
        s += d2poly(A[i], B); n += 1
    for i in range(0, len(B), 3):
        s += d2poly(B[i], A); n += 1
    return s / max(n, 1)

routes = []
for pr in plat:
    leg = name2leg.get(pr["name"])
    if not leg:
        continue
    ar = amap_leg.get(leg[0] + "|" + leg[1])
    if not ar or not ar.get("poly"):
        continue
    A = ar["poly"]; B = pr.get("routePath") or []
    if not B:
        continue
    pl = name2plan.get(pr["name"], {})
    stations = [[p["lng"], p["lat"]] for p in pl.get("stations", [])]
    routes.append({
        "name": pr["name"], "street": leg[0], "rn": leg[1], "gid": name2gid.get(pr["name"]),
        "amapKm": round(ar.get("distKm") or 0, 2),
        "platKm": round((pr.get("distance") or 0) / 1000, 2),
        "devM": round(haus(A, B), 1),
        "nSt": len(stations),
        "wpOrig": len(pl.get("waypoints", [])),
        "wpNow": wpnow.get(pr["name"], len(pr.get("waypoints") or [])),
        "amap": [to_xy(*pt) for pt in A],
        "plat": [to_xy(*pt) for pt in B],
        "stations": [to_xy(*s) for s in stations],
    })
routes.sort(key=lambda r: -r["devM"])

W, H = 1000, 760
pad = 34

def render_svg(r):
    pts = r["amap"] + r["plat"] + r["stations"]
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    dx = max(maxx - minx, 1); dy = max(maxy - miny, 1)
    s = min((W - 2 * pad) / dx, (H - 2 * pad) / dy)
    ox = pad + ((W - 2 * pad) - dx * s) / 2
    oy = pad + ((H - 2 * pad) - dy * s) / 2
    def pj(pt):
        return (ox + (pt[0] - minx) * s, H - oy - (pt[1] - miny) * s)
    def path(pts):
        if not pts:
            return ""
        return "M" + " L".join(f"{pj(p)[0]:.1f},{pj(p)[1]:.1f}" for p in pts)
    st_m = "".join(
        f'<circle cx="{pj(p)[0]:.1f}" cy="{pj(p)[1]:.1f}" r="6" fill="#111" stroke="#fff" stroke-width="2"/>'
        f'<text x="{pj(p)[0]+10:.1f}" y="{pj(p)[1]+4:.1f}" fill="#fff" font-size="12">{i+1}</text>'
        for i, p in enumerate(r["stations"]))
    return f'''<svg viewBox="0 0 {W} {H}">
  <rect width="{W}" height="{H}" fill="#161616"/>
  <path d="{path(r['amap'])}" fill="none" stroke="#8a8a8a" stroke-width="4.5" stroke-linejoin="round" opacity=".95"/>
  <path d="{path(r['plat'])}" fill="none" stroke="#2ecc71" stroke-width="2.6" stroke-linejoin="round" opacity=".95"/>
  {st_m}
</svg>'''

def row(r, i):
    chg = r["wpNow"] - r["wpOrig"]
    cls = "bad" if r["devM"] > 60 else ("warn" if r["devM"] > 30 else "ok")
    return (f'<tr data-i="{i}" class="{cls}"><td>路线{r["gid"]}-{r["street"]}</td>'
            f'<td>{r["amapKm"]}</td><td>{r["platKm"]}</td><td>{r["devM"]}</td>'
            f'<td>{r["nSt"]}</td><td>{r["wpOrig"]}</td><td>{r["wpNow"]}</td>'
            f'<td class="chg">{chg:+d}</td></tr>')

# ---- ODD 元素覆盖对比（高德 vs 平台）----
cover = {}
cf = OUT / "odd_cover_amap_vs_platform.json"
if cf.exists():
    cover = json.loads(cf.read_text(encoding="utf-8"))
cover_rows = ""
if cover.get("sets"):
    LABEL = {"schools": "学校", "hospitals": "医院", "fireStations": "消防站",
             "policeStations": "警务点", "markets": "市场", "parking": "停车场",
             "busStops": "公交站", "charging": "充电站", "fuel": "加油站",
             "interchanges": "立交", "ramps": "匝道"}
    for s in cover["sets"]:
        ok = "✔" if s["same"] else "✘"
        cc = "#4caf50" if s["same"] else "#e05a5a"
        cover_rows += (f'<tr><td>{LABEL.get(s["key"], s["key"])}</td><td>{s["total"]}</td>'
                       f'<td>{s["amapCovered"]}</td><td>{s["platCovered"]}</td>'
                       f'<td style="color:{cc}">{ok} {s["radius"]}m</td></tr>')
    cover_rows += (f'<tr class="tot"><td>合计</td><td>—</td><td>{cover["base"]["total"]}</td>'
                   f'<td>{cover["platform"]["total"]}</td>'
                   f'<td style="color:{"#4caf50" if cover["base"]["total"]==cover["platform"]["total"] else "#e05a5a"}">'
                   f'{"✔ 完全一致" if cover["base"]["total"]==cover["platform"]["total"] else "✘ 不一致"}</td></tr>')

svgs = "\n".join(f'<div class="panel" id="p{i}">{render_svg(r)}</div>' for i, r in enumerate(routes))
opts = "\n".join(
    f'<option value="{i}">路线{r["gid"]}-{r["street"]} · 偏{r["devM"]}m</option>'
    for i, r in enumerate(routes))
nbad = sum(1 for r in routes if r["devM"] > 60)

html = f"""<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<title>高德(灰) vs 平台(绿) — 逐条对比</title>
<style>
*{{box-sizing:border-box}}
body{{margin:0;background:#0f0f0f;color:#ddd;font-family:system-ui,'Microsoft YaHei'}}
header{{padding:14px 20px;background:#181818;border-bottom:1px solid #2a2a2a}}
h1{{font-size:17px;margin:0 0 8px}}
.lg span{{margin-right:22px;font-size:13px;color:#aaa}}
.sw{{display:inline-block;width:26px;height:5px;border-radius:3px;vertical-align:middle;margin-right:6px}}
.a{{background:#8a8a8a}}.p{{background:#2ecc71}}
.pick{{padding:10px 20px;background:#131313;border-bottom:1px solid #2a2a2a;display:flex;gap:14px;align-items:center;flex-wrap:wrap}}
select{{background:#1e1e1e;color:#ddd;border:1px solid #3a3a3a;border-radius:5px;padding:8px 12px;font-size:14px;min-width:280px}}
.meta{{font-size:13px;color:#999}}
.meta b{{color:#ddd}}
.panel{{display:none;padding:14px 20px}}
.panel.on{{display:block}}
svg{{width:100%;max-width:1040px;border:1px solid #2a2a2a;border-radius:6px;display:block}}
table{{border-collapse:collapse;margin:16px 20px 40px;font-size:13px}}
th,td{{border:1px solid #2a2a2a;padding:5px 11px;text-align:right}}
th:first-child,td:first-child{{text-align:left}}
th{{background:#1c1c1c}}
tr[data-i]:hover{{background:#1a2a1a;cursor:pointer}}
tr.bad td:nth-child(4){{color:#e05a5a;font-weight:600}}
tr.warn td:nth-child(4){{color:#e0a83a}}
tr.ok td:nth-child(4){{color:#4caf50}}
.chg{{color:#e0a83a}}
tr.sel{{outline:1px solid #2ecc71}}
h2{{font-size:15px;margin:20px 20px 6px;color:#bbb}}
.note{{margin:0 20px 8px;font-size:12.5px;color:#888;line-height:1.6}}
tr.tot td{{font-weight:600;background:#1a1a1a}}
</style></head><body>
<header>
  <h1>高德规划路径(灰) vs 平台规划路线(绿) — 惠城区 {len(routes)} 条 PTV 路线</h1>
  <div class="lg"><span><i class="sw a"></i>高德规划</span><span><i class="sw p"></i>平台规划(腾讯)</span>
  <span>白点+序号 = 站点（必须经过）</span><span style="color:#e05a5a">偏差&gt;60m: {nbad} 条</span></div>
</header>
<div class="pick">
  <select id="sel">{opts}</select>
  <div class="meta" id="meta">← 下拉选择一条路线（一次只画一条）</div>
</div>
{svgs}
<h2>全部路线（点行切换上图）· 按平均偏差降序</h2>
<table><thead><tr><th>路线</th><th>高德km</th><th>平台km</th><th>平均偏差m</th><th>站点</th><th>原途经点</th><th>现途经点</th><th>变化</th></tr></thead>
<tbody id="tb">
{chr(10).join(row(r, i) for i, r in enumerate(routes))}
</tbody></table>
<h2>ODD 元素覆盖对比（高德路线 vs 平台路线）</h2>
<div class="note">口径：元素到路线折线距离 ≤ 半径即计为覆盖（学校/医院等 POI 是校园中心，用 100m；道路类用 60m）。
相同路线跑出相同覆盖 = 平台路线确实经过了同样的 ODD 元素。</div>
<table><thead><tr><th>元素类型</th><th>全区总数</th><th>高德覆盖</th><th>平台覆盖</th><th>判定/半径</th></tr></thead>
<tbody>{cover_rows}</tbody></table>
<script>
const R = {json.dumps([{k: r[k] for k in ("gid","street","devM","amapKm","platKm","nSt","wpOrig","wpNow")} for r in routes], ensure_ascii=False)};
const sel = document.getElementById('sel');
const panels = [...document.querySelectorAll('.panel')];
const rows = [...document.querySelectorAll('#tb tr')];
function show(i) {{
  panels.forEach(p => p.classList.remove('on'));
  rows.forEach(t => t.classList.remove('sel'));
  if (i < 0) return;
  document.getElementById('p' + i).classList.add('on');
  rows[i].classList.add('sel');
  sel.value = i;
  const r = R[i];
  const chg = r.wpNow - r.wpOrig;
  document.getElementById('meta').innerHTML =
    `<b>路线${{r.gid}}-${{r.street}}</b> · 高德 <b>${{r.amapKm}}</b>km · 平台 <b>${{r.platKm}}</b>km` +
    ` · 平均偏差 <b style="color:${{r.devM>60?'#e05a5a':'#4caf50'}}">${{r.devM}}</b>m` +
    ` · 站点 <b>${{r.nSt}}</b> · 途经点 <b>${{r.wpOrig}}</b>→<b>${{r.wpNow}}</b> (${{chg>=0?'+':''}}${{chg}})`;
}}
sel.addEventListener('change', () => show(+sel.value));
rows.forEach((tr, i) => tr.addEventListener('click', () => {{ show(i); window.scrollTo({{top:0, behavior:'smooth'}}); }}));
show(0);
</script></body></html>"""

(OUT / "amap_vs_platform.html").write_text(html, encoding="utf-8")
print(f"routes {len(routes)} | dev>60: {nbad} | saved out/amap_vs_platform.html ({(OUT/'amap_vs_platform.html').stat().st_size/1e6:.2f}MB)")