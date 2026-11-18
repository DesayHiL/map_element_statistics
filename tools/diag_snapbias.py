# -*- coding: utf-8 -*-
"""追问：宽凳里程为何会短于锚点直线和（物理上不可能）？
假设：锚点被吸附到最近的宽凳节点，锚点本身到路网的那段"接驳长度"没被计入。
做法：对每条腿取 宽凳图里程 + 各锚点吸附距离之和 作为"补回接驳后"的估计，
并统计 ratio_kd<1 的腿里有多少个锚点是远吸附（>100 m）。
"""
import json, math, sys

sys.stdout.reconfigure(encoding="utf-8")
MLON = 111320.0 * math.cos(math.radians(23.16))
MLAT = 110574.0

RR = json.load(open("out/kd_reroute.json", encoding="utf-8"))["legs"]

print(f"{'街道':<10}{'#':>2} {'宽凳图':>8}{'吸附和':>8}{'补回后':>8}{'直线和':>8} {'>100m锚点':>9}")
tot = dict(kd=0.0, snap=0.0, straight=0.0, fixed=0.0)
bad = []
for lg in RR:
    if not lg["km_kd"]:
        continue
    A = lg["anchors"]
    snap = sum(a["snap"] for a in A) / 1000.0
    ss = 0.0
    for a, b in zip(A, A[1:]):
        ss += math.hypot((a["lon"] - b["lon"]) * MLON, (a["lat"] - b["lat"]) * MLAT) / 1000.0
    kd = lg["km_kd"]
    far = sum(1 for a in A if a["snap"] > 100)
    fixed = kd + snap
    tot["kd"] += kd; tot["snap"] += snap; tot["straight"] += ss; tot["fixed"] += fixed
    if kd < ss * 0.999:
        bad.append((lg["street"], lg["n"], kd, snap, fixed, ss, far, len(A), far / len(A)))

print(f"\n[合计] 宽凳图里程 {tot['kd']:.1f} km | 锚点吸附距离合计 {tot['snap']:.1f} km | "
      f"补回后 {tot['fixed']:.1f} km | 锚点直线和(物理下界) {tot['straight']:.1f} km")

print(f"\n=== 宽凳里程 < 锚点直线和 的腿（数学上不可能，共 {len(bad)} 条）===")
print(f"{'街道':<10}{'#':>2} {'宽凳图':>8}{'吸附和':>8}{'补回后':>8}{'直线和':>8} {'远锚点':>8}")
for st, n, kd, snap, fixed, ss, far, na, fr in sorted(bad, key=lambda x: x[2] / x[5]):
    print(f"{st:<10}{n:>2} {kd:>8.2f}{snap:>8.2f}{fixed:>8.2f}{ss:>8.2f} {far:>4}/{na:<3} {fr*100:>3.0f}%")

# 全量锚点吸附分布
allA = [a for lg in RR for a in lg["anchors"]]
allA = [a for a in allA if a.get("snap") is not None]
print(f"\n=== 锚点吸附距离（{len(allA)} 个）===")
for th in (20, 50, 100, 200, 500, 1000, 2000):
    c = sum(1 for a in allA if a["snap"] > th)
    print(f"  > {th:>5} m : {c:>3}  ({c/len(allA)*100:.1f}%)")
s = sorted(a["snap"] for a in allA)
print(f"  中位 {s[len(s)//2]:.1f} m | p90 {s[int(len(s)*0.9)]:.1f} m | 合计 {sum(s)/1000:.1f} km")
