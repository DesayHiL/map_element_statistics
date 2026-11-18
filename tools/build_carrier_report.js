// =============================================================================
// 载体口径校正报告 → out/carrier_report.json
// =============================================================================
// 为什么需要这个：
//   隧道 / 桥梁的 OSM 标签（tunnel=yes / bridge=yes）是**修饰符**，可以贴在铁路、
//   水道涵洞、人行步道上。统计侧（build_stats / build_odd_quota）已按载体过滤，
//   但**选路侧（select_odd.js）刻意没有过滤** —— 因为过滤会改变元素计数→改变配额
//   →改变选中的工况道路集合（实测 165→164 条，7 增 8 删），而 routes.json
//   （真实高德导航几何）是按旧集合抓的，重取要全量重规划，属于另一个量级的工作。
//   于是这里做**只读的展示层校正**：不改排班，只把报告里 隧道/桥梁 两行的
//   「全区实例 / 配额 / 选中样本」换成载体过滤后的真实数字。
//
// 口径（逐项与既有链路对齐）：
//   · raw        —— data/*.json 原始条数（514 / 2370）
//   · filtered   —— 剔除非 ODD 车辆路载体 + 50m 同构造物去重（lib_carrier_filter）
//   · inArea     —— 落在 18 街道多边形内（直接取 street_stats.json 的 Σ，与家底同源）
//   · reachable  —— 距某条「候选道路」（有名字 · 非高速 · 中心线 ≥300m）≤80m，
//                   即 select_odd.js 认定的「可排班工作面」= 配额分母
//   · covered    —— 距 routes.json（本次真实排班）折线 ≤60m（PASS_M，与
//                   build_odd_quota.js / C 区标签同口径）= 报告里的「选中样本」
//
// 只读本地 out/ 与 data/，不写任何上游产物。
const fs = require('fs');
const path = require('path');
const { carrierCheck, dedupeStructures } = require('../lib_carrier_filter');
// routes.json 的 poly 是 GCJ-02，data/*.json 元素与 road 几何是 WGS-84 —— 必须转换，
// 否则整条排班折线整体偏移约 500m，覆盖统计会从 55 掉到 5（踩过）。
const { gcj2wgs } = require('../street_areas');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const DATA = path.join(ROOT, 'data');
const PASS_M = 60;      // 途经判定半径（与 build_odd_quota.js 一致）
const REACH_M = 80;     // select_odd.js 的 near-way 半径
const MIN_KM = 0.3;     // select_odd.js 候选道路里程门槛

const readJ = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const ODD_HW = new Set(['primary', 'secondary', 'tertiary', 'unclassified',
  'residential', 'living_street', 'service', 'road', 'track']);

// ---------- 局部平面投影（米） ----------
const LAT0 = 23.11, M_LAT = 110540, M_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const px = (lon) => lon * M_LON;
const py = (lat) => lat * M_LAT;
function segD2(ax, ay, bx, by, cx, cy) {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L > 0 ? ((cx - ax) * dx + (cy - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return (cx - qx) ** 2 + (cy - qy) ** 2;
}

// ---------- 空间格 ----------
function makeGrid(cell) {
  const g = new Map();
  const key = (x, y) => `${Math.floor(x / cell)}|${Math.floor(y / cell)}`;
  return {
    add(x, y, v) { const k = key(x, y); if (!g.has(k)) g.set(k, []); g.get(k).push(v); },
    near(x, y, r, cb) {                       // cb(seg) 返回 true 表示命中，可提前结束
      const R = Math.ceil(r / cell);
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) {
        const arr = g.get(`${cx + dx}|${cy + dy}`);
        if (!arr) continue;
        for (const s of arr) if (cb(s)) return true;
      }
      return false;
    },
  };
}

function main() {
  // ---------- 1) 排班折线 → 采样点格（WGS-84） ----------
  const routes = readJ(path.join(OUT, 'routes.json'));
  const routeGrid = makeGrid(60);
  const routePts = [];
  for (const st of routes.routes || []) {
    if (st.status && st.status !== 'ok') continue;
    for (const leg of st.routes || []) {
      const poly = leg.poly;
      if (!poly || poly.length < 2) continue;
      const w = poly.map(([lo, la]) => gcj2wgs([lo, la]));
      for (let i = 1; i < w.length; i++) {
        const [ax, ay] = w[i - 1], [bx, by] = w[i];
        const d = Math.hypot(px(bx) - px(ax), py(by) - py(ay));
        const n = Math.max(1, Math.ceil(d / 40));   // ≈40m 加密，与其它统计脚本一致
        for (let k = 0; k < n; k++) {
          const lo = ax + ((bx - ax) * k) / n, la = ay + ((by - ay) * k) / n;
          routePts.push([lo, la]);
        }
      }
      routePts.push(w[w.length - 1]);
    }
  }
  routePts.forEach(([lo, la]) => routeGrid.add(px(lo), py(la), [lo, la]));
  const nearRoute = (lo, la) => {
    const x = px(lo), y = py(la), r2 = PASS_M * PASS_M;
    return routeGrid.near(x, y, PASS_M, (p) => (px(p[0]) - x) ** 2 + (py(p[1]) - y) ** 2 <= r2);
  };

  // ---------- 2) 候选道路段（有名字 · ODD 等级 · 中心线 ≥300m） ----------
  const roads = readJ(path.join(DATA, 'roads.json')).elements;
  const roadGrid = makeGrid(100);
  let candWays = 0, candSegs = 0;
  for (const el of roads) {
    const tg = el.tags || {};
    if (!tg.name || !ODD_HW.has(tg.highway || '')) continue;
    const geo = el.geometry; if (!geo || geo.length < 2) continue;
    let len = 0;
    for (let i = 1; i < geo.length; i++) len += Math.hypot(px(geo[i].lon) - px(geo[i - 1].lon), py(geo[i].lat) - py(geo[i - 1].lat));
    if (len / 1000 < MIN_KM) continue;
    candWays++;
    for (let i = 1; i < geo.length; i++) {
      const a = [px(geo[i - 1].lon), py(geo[i - 1].lat)];
      const b = [px(geo[i].lon), py(geo[i].lat)];
      roadGrid.add((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, [a, b]);
      candSegs++;
    }
  }
  const nearRoad = (lo, la) => {
    const x = px(lo), y = py(la), r2 = REACH_M * REACH_M;
    return roadGrid.near(x, y, REACH_M, (s) => segD2(s[0][0], s[0][1], s[1][0], s[1][1], x, y) <= r2);
  };

  // ---------- 3) 区内家底（与 street_stats 同源） ----------
  const stats = readJ(path.join(OUT, 'street_stats.json'));

  // ---------- 3b) 主链路口径（build_odd_quota.js）----------
  // 2026-10-15 校准：本工具原先自带一套「60m 途经」实现，与 build_odd_quota 的
  // routeCovered 差 1（隧道）/ 7（桥梁）—— 同一份报告里两页印不同的覆盖数。
  // 改为优先读主链路产物，保证「选中样本 / 本排班覆盖」全站同源。
  const oqPath = path.join(OUT, 'odd_quota_roads.json');
  const oq = fs.existsSync(oqPath) ? readJ(oqPath) : null;
  const oqOf = (key) => (oq ? (oq.quota || []).find((x) => x.key === key) : null);

  const KINDS = [
    { key: 'tunnels', file: 'tunnels', label: '隧道', statsKey: 'tunnels' },
    { key: 'bridges', file: 'bridges', label: '桥梁', statsKey: 'bridges' },
  ];

  const out = {
    generatedAt: new Date().toISOString(),
    note: '载体口径校正：隧道/桥梁剔除铁路·水道涵洞·人行步道等非 ODD 载体 + 50m 同构造物去重。'
      + 'inArea 取 street_stats Σ（与家底同源）；reachable / covered 优先取 out/odd_quota_roads.json'
      + '（quota.matched / routeCovered，主链路口径，全站同源），缺产物时退回本工具自算值。',
    passM: PASS_M, reachM: REACH_M,
    candWays, candSegs,
    kinds: {},
  };

  for (const k of KINDS) {
    const raw = readJ(path.join(DATA, k.file + '.json')).elements;
    const filtered = dedupeStructures(raw.filter((e) => carrierCheck(e).keep), { radiusM: 50 });
    const inArea = stats.reduce((s, r) => s + (r[k.statsKey] || 0), 0);
    let reachable = 0, covered = 0;
    for (const el of filtered) {
      const c = el.type === 'node' ? [el.lon, el.lat]
        : el.center ? [el.center.lon, el.center.lat] : null;
      if (!c) continue;
      if (nearRoad(c[0], c[1])) reachable++;
      if (nearRoute(c[0], c[1])) covered++;
    }
    const Q = oqOf(k.key);
    // 主链路优先；缺产物时退回本工具自算（两者差 ≤7，口径相同只是实现不同）
    const coveredMain = oq && oq.routeCovered && oq.routeCovered[k.key] != null
      ? oq.routeCovered[k.key] : covered;
    const reachMain = Q ? Q.matched : reachable;
    out.kinds[k.key] = {
      label: k.label,
      raw: raw.length,
      filtered: filtered.length,
      droppedPct: +(((raw.length - filtered.length) / raw.length) * 100).toFixed(1),
      inArea,
      reachable: reachMain,
      reachableSelf: reachable,          // 本工具自算值，留痕供对账
      covered: coveredMain,
      coveredSelf: covered,
      quota: Math.min(139, reachMain),   // 与 build_odd_quota / select_odd 同构
    };
    const o = out.kinds[k.key];
    console.log(`[${k.label}] 原始 ${o.raw} → 过滤 ${o.filtered}（剔除 ${o.droppedPct}%）· 区内 ${o.inArea}`
      + ` · 可排班面 ${o.reachable} · 本次排班覆盖 ${o.covered} · 配额 ${o.quota}`);
  }

  fs.writeFileSync(path.join(OUT, 'carrier_report.json'), JSON.stringify(out, null, 1));
  console.log('→ out/carrier_report.json');
}

main();
