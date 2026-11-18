# -*- coding: utf-8 -*-
"""出《宽凳补测/改点需求清单》—— 汇总「宽凳约束排班」暴露出的所有数据缺口。

三类缺口（互为因果，分开列便于分派）：
  A. 真盲区段     —— 宽凳整片没采（走廊放宽到 2km 仍不连通 / 沿途有路率过低）
                     → 处置：**补测** 或 **改服务点**
  B. 拓扑断裂段   —— 沿途明明有宽凳路，但宽凳自己把路网断了（≥350m 内不连通）
                     → 处置：**修宽凳拓扑**（焊接断口，成本最低，优先做）
  C. 拓扑断口点   —— 宽凳连通分量离主网的缺口坐标（comp17 孤岛 5.1km 是大头）
                     → 处置：**补测/焊接**，一处修好能救多条腿

输出：out/kd_survey_needs.csv、out/kd_survey_needs.md
"""
import json, csv, sys, collections
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
OUT = Path(r"D:/workspace/map_element_statistics/out")

PLAN = json.load(open(OUT / "kd_route_plan.json", encoding="utf-8"))
AT = {(r["street"], r["n"], r["k"]): r for r in json.load(open(OUT / "kd_plan_attrib.json", encoding="utf-8"))["rows"]}
CHAIN = {(r["street"], r["n"], r["k"]): r for r in json.load(open(OUT / "kd_chain_check.json", encoding="utf-8"))["rows"]}
WELD = json.load(open(OUT / "kd_weld_gap.json", encoding="utf-8"))
RKD = json.load(open(OUT / "routes_kd.json", encoding="utf-8"))

# ---- A/B：逐段分类 ----
rows = []
for L in PLAN["legs"]:
    st, no = L["street"], L["n"]
    for s in L["segs"]:
        if s["tier"] != "offKd":
            continue
        k = s["k"]
        at = AT.get((st, no, k), {})
        ch = CHAIN.get((st, no, k), {})
        # 判据：沿途有路率 + 链式校验结论
        cover = s["cover"]
        verdict = ch.get("verdict", "")
        if "没有宽凳路" in verdict or cover < 0.35:
            kind = "A 真盲区"
            fix = "补测（整片没采）或改服务点"
        else:
            kind = "B 拓扑断裂"
            fix = "修宽凳拓扑（焊接断口）"
        rows.append(dict(
            kind=kind, street=st, route=no, seg=k,
            km_amap=s["km_amap"],
            cover_pct=round(cover * 100, 1),
            a_name=at.get("a_name", ""), b_name=at.get("b_name", ""),
            lon_a=at.get("lon_a"), lat_a=at.get("lat_a"),
            lon_b=at.get("lon_b"), lat_b=at.get("lat_b"),
            verdict=verdict, thr_first=at.get("thr_first"),
            fix=fix))
rows.sort(key=lambda r: (r["kind"], -r["km_amap"]))

# ---- C：拓扑断口 ----
gaps = [r for r in WELD["rows"] if r["gap_m"] > 0]
gaps.sort(key=lambda r: -r["gap_m"])

nA = sum(1 for r in rows if r["kind"].startswith("A"))
kA = sum(r["km_amap"] for r in rows if r["kind"].startswith("A"))
nB = sum(1 for r in rows if r["kind"].startswith("B"))
kB = sum(r["km_amap"] for r in rows if r["kind"].startswith("B"))
gBig = [g for g in gaps if g["gap_m"] > 200]

with open(OUT / "kd_survey_needs.csv", "w", newline="", encoding="utf-8-sig") as f:
    if rows:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)
    else:
        w = csv.DictWriter(f, fieldnames=["kind", "street", "route_n", "km_amap"])
        w.writeheader()
print(f"[A] {nA} 段 / {kA:.1f}km · [B] {nB} 段 / {kB:.1f}km · 拓扑断口 >200m: {len(gBig)}")

# ---- Markdown 报告 ----
md = []
md.append("# 宽凳补测 / 改点需求清单\n")
md.append(f"> 用途：把「排班路线必须以宽凳为约束」跑通后暴露出的**宽凳数据缺口**，"
          f"按「补测 / 修拓扑 / 改服务点」三类分派。数据源 `out/routes_kd.json`、"
          f"`out/kd_route_plan.json`（生成于 {RKD['generated']}）。\n")
md.append("## 总览\n")
md.append("| 项 | 值 |")
md.append("|---|---|")
md.append(f"| 排班腿 | {len(PLAN['legs'])} 条（54 个锚点段） |")
md.append(f"| 可落在宽凳上的段 | {RKD['seg_on'] + RKD['seg_near']} / {RKD['seg_on'] + RKD['seg_near'] + RKD['seg_off']} 段 "
          f"（{RKD['km_onKd'] + RKD['km_nearKd']:,.1f} km） |")
md.append(f"| **A 真盲区段** | **{nA} 段 · {kA:,.1f} km** —— 宽凳整片没采，需补测或改服务点 |")
md.append(f"| **B 拓扑断裂段** | **{nB} 段 · {kB:,.1f} km** —— 宽凳有路但自己断了，修拓扑即可 |")
md.append(f"| C 拓扑断口点 | {len(gaps)} 处（离主网 >200m 的 {len(gBig)} 处） |")
md.append("")
md.append("> 结论一句话：**排班路线落到宽凳上的 1,226.6 km 已经完全走宽凳路网**（顶点 0 偏差）；"
          f"剩下的 {nA + nB} 段 / {kA + kB:,.1f} km 是宽凳数据缺口 —— 其中 "
          f"{kB:,.1f} km（{nB} 段）只差修宽凳拓扑，成本最低、优先做；"
          f"{kA:,.1f} km（{nA} 段）是真盲区，要么补测要么把服务点挪到有路的片区。\n")

md.append("## A. 真盲区段（宽凳整片没采）—— 补测 或 改服务点\n")
md.append("| 镇街 | 路线 | 段 | 里程 km | 沿途有路率 | 起点 → 终点 | 断口坐标 |")
md.append("|---|---|---|---|---|---|---|")
for r in rows:
    if not r["kind"].startswith("A"):
        continue
    coords = f"({r['lon_a']:.5f},{r['lat_a']:.5f}) ~ ({r['lon_b']:.5f},{r['lat_b']:.5f})" \
        if r["lon_a"] is not None else "—"
    md.append(f"| {r['street']} | {r['route']} | {r['seg']} | {r['km_amap']:.2f} | "
              f"{r['cover_pct']:.1f}% | {r['a_name']} → {r['b_name']} | {coords} |")
md.append("")

md.append("## B. 拓扑断裂段（宽凳有路、自己断了）—— 修拓扑\n")
md.append("| 镇街 | 路线 | 段 | 里程 km | 沿途有路率 | 链路校验 | 起点 → 终点 |")
md.append("|---|---|---|---|---|---|---|")
for r in rows:
    if not r["kind"].startswith("B"):
        continue
    md.append(f"| {r['street']} | {r['route']} | {r['seg']} | {r['km_amap']:.2f} | "
              f"{r['cover_pct']:.1f}% | {r['verdict']} | {r['a_name']} → {r['b_name']} |")
md.append("")

md.append("## C. 宽凳拓扑断口点（离主网 >200m，按缺口排序）\n")
md.append("修好这些断口，B 类段与部分 A 类段即可自动连通。\n")
md.append("| 连通片 | 节点数 | 片内跨度 km | 离主网 m | 断口 A | 断口 B |")
md.append("|---|---|---|---|---|---|")
for g in gBig:
    md.append(f"| comp{g['comp']} | {g['nodes']} | {g['km_extent']:.2f} | {g['gap_m']:.1f} | "
              f"({g['lon_a']:.5f}, {g['lat_a']:.5f}) | ({g['lon_b']:.5f}, {g['lat_b']:.5f}) |")
md.append("")
md.append(f"> comp{gaps[0]['comp']} 是最大断口：{gaps[0]['nodes']} 个节点、跨 {gaps[0]['km_extent']:.1f} km、"
          f"离主网 {gaps[0]['gap_m']:.0f} m（横沥—芦洲东）。这一处修好，芦洲镇、横沥镇多条腿即可联通。\n")

md.append("## 处置建议（按性价比排序）\n")
md.append("1. **先修 C 类拓扑断口**（尤其 comp17 那处 5.1 km 缺口）：纯数据工程，不动业务点，"
          "修好一处能救一串 B 类段与部分 A 类段。\n")
md.append("2. **B 类段复测确认**：宽凳本来就有路，断裂多半是 digitizing 接缝 >50 m 或 PRE/NEXT 缺失，"
          "补上拓扑关系即可。\n")
md.append("3. **A 类段二选一**：芦洲镇（87.3 km）、横沥镇（42.2 km）、沥林镇（36.8 km）、潼湖镇（30.8 km）"
          "这几片宽凳覆盖率低 —— 要么安排补测，要么把服务点（学校/医院）挪到宽凳已覆盖的片区。\n")
md.append("4. **规划侧加约束**：`plan_routes_v2.js` 目前由高德算路、零宽凳约束。"
          "应改为「高德算路后，以宽凳路网复算几何」，本轮 `tools/build_routes_kd.py` 即这一层；"
          "源头根治需把宽凳约束前移到规划器。\n")

(OUT / "kd_survey_needs.md").write_text("\n".join(md), encoding="utf-8")
print(f"A 真盲区   {nA:>2} 段 {kA:>7.1f} km")
print(f"B 拓扑断裂 {nB:>2} 段 {kB:>7.1f} km")
print(f"C 断口点   {len(gaps)} 处（>200m 的 {len(gBig)} 处，最大 comp{gaps[0]['comp']} {gaps[0]['gap_m']:.0f} m）")
print(f"[out] out/kd_survey_needs.csv")
print(f"[out] out/kd_survey_needs.md")
