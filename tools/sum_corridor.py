# -*- coding: utf-8 -*-
"""汇总走廊贴合结果并分档。
段档：连通是硬门槛；再按「锚点离走廊多远」「贴合后里程是否明显缩水」分严格/可用。
输出 out/kd_corridor_summary.json 与控制台报告。
"""
import json, sys
import numpy as np

sys.stdout.reconfigure(encoding="utf-8")
C = json.load(open("out/kd_corridor.json", encoding="utf-8"))
legs = C["legs"]


def tier(s):
    if not s["ok"]:
        return "D"                                     # 不可：走廊内宽凳不连通
    snap = max(s.get("snap_a") or 0, s.get("snap_b") or 0)
    r = (s["km"] / s["km_amap"]) if s["km_amap"] > 0.05 else 1.0
    if snap <= 100 and r >= 0.75 and (s["thr"] or 0) <= 80:
        return "A"                                     # 严格：走廊窄、锚点贴网、里程不缩水
    if snap <= 500 and r >= 0.60:
        return "B"                                     # 可用：需放宽走廊或锚点接驳
    return "C"                                         # 勉强：明显抄近道或锚点离网很远


seg = []
for L in legs:
    for s in L["segs"]:
        s["street"] = L["street"]; s["n"] = L["n"]; s["tier"] = tier(s)
        seg.append(s)
for L in legs:
    ts = [tier(s) for s in L["segs"]]
    L["tier"] = ("A" if all(t == "A" for t in ts) else
                 "B" if all(t in "AB" for t in ts) else
                 "C" if all(t in "ABC" for t in ts) else "D")

import collections
ct = collections.Counter(s["tier"] for s in seg)
print("=== 段级分档（共 %d 段）===" % len(seg))
NAME = {"A": "A 严格贴合（走廊≤80 m、锚点≤100 m、里程不缩水）",
        "B": "B 可用（走廊≤350 m 或锚点接驳≤500 m）",
        "C": "C 勉强（抄近道 <60% 或锚点接驳 >500 m）",
        "D": "D 不可（走廊内宽凳不连通 → 宽凳真没有）"}
for k in "ABCD":
    ss = [s for s in seg if s["tier"] == k]
    print(f"  {NAME[k]:<46} {ct[k]:>3} 段  高德里程 {sum(s['km_amap'] for s in ss):>7.1f} km")

lt = collections.Counter(L["tier"] for L in legs)
print("\n=== 腿级分档（共 %d 腿）===" % len(legs))
LN = {"A": "全部段严格贴合，可原样落上宽凳",
      "B": "全部段可落（部分段需放宽走廊/锚点接驳）",
      "C": "全部段勉强可落（有抄近道或远锚点）",
      "D": "存在「宽凳不连通」的段"}
for k in "ABCD":
    print(f"  {LN[k]:<34} {lt[k]:>3} 腿")

# 同段可比里程（A+B+C 已连通段）
ok = [s for s in seg if s["ok"]]
ka = sum(s["km_amap"] for s in ok); kk = sum(s["km"] for s in ok)
print(f"\n=== 连通段上的同段里程对比（{len(ok)} 段）===")
print(f"  高德里程 {ka:.1f} km  →  宽凳贴合里程 {kk:.1f} km   比值 {kk/ka:.3f} ({100*(kk/ka-1):+.1f}%)")
okA = [s for s in seg if s["tier"] == "A"]
kaA = sum(s["km_amap"] for s in okA); kkA = sum(s["km"] for s in okA)
print(f"  A 档段单独：{kaA:.1f} → {kkA:.1f} km  比值 {kkA/kaA:.3f}")
rs = np.array([s["km"] / s["km_amap"] for s in ok if s["km_amap"] > 0.05])
print(f"  逐段比值 中位 {np.median(rs):.3f}  p10 {np.percentile(rs,10):.3f}  p90 {np.percentile(rs,90):.3f}")

print("\n=== D 档段（宽凳真没有）按街道 ===")
dd = collections.defaultdict(lambda: [0, 0.0, 0.0])
for s in seg:
    if s["tier"] != "D": continue
    a = dd[s["street"]]; a[0] += 1; a[1] += s["km_amap"]; a[2] += s["cover"]
for st, (c, km, cv) in sorted(dd.items(), key=lambda x: -x[1][1]):
    print(f"  {st:<8} {c:>2} 段  {km:>7.1f} km  平均贴合率 {cv/c*100:>5.1f}%")

print("\n=== 腿级 D（有问题）的腿 ===")
for L in legs:
    if L["tier"] == "D":
        bad = [s for s in L["segs"] if s["tier"] == "D"]
        print(f"  {L['street']:<8} 腿{L['n']:<2} 高德{L['km_amap']:>6.1f} km  "
              f"不可段 {len(bad)}/{L['nseg']}（{sum(s['km_amap'] for s in bad):.1f} km）"
              f"  断点 {L['street']} 第 {[s['k'] for s in bad]} 段")

json.dump(dict(seg_tier=ct, leg_tier=lt, km_amap_ok=round(ka, 1), km_corr_ok=round(kk, 1),
               segs=seg,
               legs=[{k: v for k, v in L.items() if k != "segs"} | {"tier": L["tier"]} for L in legs]),
          open("out/kd_corridor_summary.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("\n[out] out/kd_corridor_summary.json")
