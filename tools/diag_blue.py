# -*- coding: utf-8 -*-
"""诊断：排班路线里被判「宽凳盲区(蓝)」的那 276km，到底是真的没测绘，还是被 441302 裁剪误伤。

判据三条：
  A) 蓝点是否落在惠城区 441302 边界内  -> 若大量在界外，说明是「裁剪误伤」
  B) 蓝点到「全国/全市未裁剪」宽凳路网的最近距离 -> 若普遍 <20m，说明其实是宽凳有路的
  C) 蓝点落在区界外侧的最近宽凳 link 属于哪个 adcode 范围(用经纬粗判)
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

ROOT = Path(r"D:/workspace/map_element_statistics")
OUT = ROOT / "out"
CACHE = Path(r"D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab")

R_BUFFER_M = 20.0
SAMPLE_STEP_M = 4.0

LAT0, LON0 = 23.16, 114.40
M_PER_DEG_LAT = 110574.0
M_PER_DEG_LON = 111320.0 * math.cos(math.radians(LAT0))


def to_xy(lon, lat):
    return ((np.asarray(lon, "f8") - LON0) * M_PER_DEG_LON,
            (np.asarray(lat, "f8") - LAT0) * M_PER_DEG_LAT)


def resample(P, step):
    if len(P) < 2:
        return P
    seg = np.hypot(np.diff(P[:, 0]), np.diff(P[:, 1]))
    total = float(seg.sum())
    if total <= 0:
        return P[:1]
    n = int(math.ceil(total / step)) + 1
    s = np.linspace(0.0, total, n)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    return np.column_stack([np.interp(s, cum, P[:, 0]), np.interp(s, cum, P[:, 1])])


def point_in_rings(x, y, rings_xy, chunk=20000):
    inside = np.zeros(len(x), dtype=bool)
    for ring in rings_xy:
        rx, ry = ring[:, 0], ring[:, 1]
        n = len(rx)
        j = (np.arange(n) - 1) % n
        dyr = ry[j] - ry
        for a in range(0, len(x), chunk):
            b = min(a + chunk, len(x))
            yy = y[a:b, None]
            cond = (ry > yy) != (ry[j] > yy)
            with np.errstate(divide="ignore", invalid="ignore"):
                xint = (rx[j] - rx) * (yy - ry) / dyr + rx
            hit = cond & (x[a:b, None] < xint)
            inside[a:b] ^= (hit.sum(axis=1) % 2 == 1)
    return inside


def main():
    # ---- boundary
    bnd = json.loads((OUT / "_huicheng_boundary.json").read_text(encoding="utf-8"))
    rings_xy = [np.column_stack(to_xy(np.asarray(r, "f8")[:, 0], np.asarray(r, "f8")[:, 1]))
                for r in bnd["rings"]]

    # ---- 完整(未裁剪)宽凳路网采样
    fixed = np.load(CACHE / "ROAD_LINK.fixed.npy", mmap_mode="r")
    geom = np.memmap(CACHE / "ROAD_LINK.geom.bin", dtype="<f8", mode="r", shape=(2049433, 2))
    goff = np.asarray(fixed["geom_off"], dtype="i8") // 16
    gn = np.asarray(fixed["geom_n"], dtype="i4")
    print(f"[kd] full network links = {len(gn)}")

    parts, offs = [], [0]
    for i in range(len(gn)):
        n = int(gn[i])
        if n < 2:
            continue
        o = int(goff[i])
        P = np.asarray(geom[o:o + n], "f8")
        x, y = to_xy(P[:, 0], P[:, 1])
        S = resample(np.column_stack([x, y]), SAMPLE_STEP_M)
        parts.append(S)
        offs.append(offs[-1] + len(S))
    full_samp = np.vstack(parts)
    print(f"[kd] full samples = {len(full_samp)}")

    # ---- 路线
    doc = json.loads((OUT / "routes.json").read_text(encoding="utf-8"))
    legs = []
    for st in doc["routes"]:
        for ri, r in enumerate(st["routes"]):
            poly = np.asarray(r["poly"], "f8")
            x, y = to_xy(poly[:, 0], poly[:, 1])
            S = resample(np.column_stack([x, y]), SAMPLE_STEP_M)
            legs.append({"street": st["street"], "idx": ri + 1,
                         "distKm": r["distKm"], "S": S, "poly": poly})

    # 全量路线点，用于「20m 内有路线」判据
    allr = np.vstack([l["S"] for l in legs])
    rt = cKDTree(allr)

    # ---- 完整路网 link 是否被路线覆盖(起点/终点)
    d_net2rt, _ = rt.query(full_samp, k=1, distance_upper_bound=R_BUFFER_M)
    net_cov = d_net2rt <= R_BUFFER_M
    print(f"[full-net] 全市宽凳采样点被路线 20m 覆盖比例 = {net_cov.mean()*100:.2f}%")

    # ---- 用完整网络给路线点分类
    dn, _ = cKDTree(full_samp).query(allr, k=1, distance_upper_bound=1e9)

    # ---- 逐点：是否在惠城区内
    p0 = allr
    inside = point_in_rings(p0[:, 0], p0[:, 1], rings_xy)

    # 按 leg 汇总
    print("\n=== 用「完整(未裁剪)宽凳」重新判定路线 ===")
    k = 0
    tot = on_full = on_clip_only = real_blind = 0.0
    per_leg = []
    for l in legs:
        S = l["S"]
        n = len(S)
        dn_l = dn[k:k + n]
        in_l = inside[k:k + n]
        k += n
        step_km = SAMPLE_STEP_M / 1000.0
        # 完整网络判定
        on_full_l = dn_l <= R_BUFFER_M
        # 裁剪网络判定(旧口径) = 在界内 且 完整网络 20m 内 —— 近似旧结果
        real_blind_l = ~on_full_l
        outside_l = ~in_l
        per_leg.append({
            "street": l["street"], "idx": l["idx"], "distKm": l["distKm"],
            "km": n * step_km,
            "on_full_km": float(on_full_l.sum() * step_km),
            "blind_km": float(real_blind_l.sum() * step_km),
            "outside_km": float(outside_l.sum() * step_km),
            "blind_med_m": float(np.median(dn_l[real_blind_l])) if real_blind_l.any() else 0.0,
        })
        tot += n * step_km
        on_full += on_full_l.sum() * step_km
        real_blind += real_blind_l.sum() * step_km

    print(f"路线总长(4m采样) {tot:.1f} km")
    print(f"  完整宽凳 20m 内(应为红) {on_full:.1f} km  ({on_full/tot*100:.1f}%)")
    print(f"  真正远离完整宽凳(<=真盲区) {real_blind:.1f} km  ({real_blind/tot*100:.1f}%)")

    bad = sorted([p for p in per_leg if p["blind_km"] > 0.5], key=lambda x: -x["blind_km"])
    print(f"\n=== 真正盲区 >0.5km 的路线 {len(bad)} 条 ===")
    print(f"{'街道':<10}{'#':>3}{'总km':>8}{'在网km':>9}{'盲区km':>9}{'盲区中位距m':>12}{'区界外km':>10}")
    for p in bad[:30]:
        print(f"{p['street']:<10}{p['idx']:>3}{p['km']:>8.1f}{p['on_full_km']:>9.1f}"
              f"{p['blind_km']:>9.1f}{p['blind_med_m']:>12.0f}{p['outside_km']:>10.1f}")

    summary = {
        "route_total_km": round(tot, 1),
        "on_full_net_km": round(on_full, 1),
        "real_blind_km": round(real_blind, 1),
        "real_blind_pct": round(real_blind / tot * 100, 2),
        "legs_with_blind": len(bad),
        "per_leg": per_leg,
    }
    (OUT / "_diag_blue.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n[saved] out/_diag_blue.json")


if __name__ == "__main__":
    main()
