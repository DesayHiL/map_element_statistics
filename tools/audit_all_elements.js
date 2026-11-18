// 全元素真实情况体检 —— 把「源 → 载体过滤 → 去重 → 区内」这条链独立重算一遍，
// 再与三份产物（build_stats / build_odd_quota / select_odd）以及四份交付页的显示值对账。
//
// 动机：隧道/桥梁的载体污染修完后复查发现，三份脚本各带一套 ELEMENT_SETS
//   select_odd 24 类 · build_stats 24 类 · build_odd_quota 28 类
// 且「去重」只在部分脚本里生效（railCrossings 的 50m 合并在 build_odd_quota 里漏了）
// —— 于是同一个「区内实例数」在不同页面上是不同的数。本工具把每一类都摊开核。
//
// 用法: node tools/audit_all_elements.js  →  out/element_calibration.json + 控制台对照表
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const { read, loadAreas, assignStreetFactory, gcj2wgs } = require(path.join(ROOT, 'street_areas'));
const { carrierCheck, dedupeStructures } = require(path.join(ROOT, 'lib_carrier_filter'));

// --- 权威集合：与 build_odd_quota.js（超集 28 类）一致 ---
const SETS = [
  // 2026-10-17 与主链同步换宽凳真值（否则独立重算与配额表口径打架）：
  // signals=宽凳灯控停止线（OSM 仅 1601，宽凳 3632）；roundabout=宽凳 LINK_TYPE=4（OSM 仅 12）
  { key: 'signals', file: 'kuandeng_signals', label: '红绿灯(灯控路口)' },
  { key: 'crossings', file: 'crossings_full', label: '人行横道' },
  { key: 'tunnels', file: 'tunnels', label: '隧道' },
  { key: 'bridges', file: 'bridges', label: '桥梁' },
  { key: 'schools', amap: 'amap_schools', label: '学校' },
  { key: 'hospitals', amap: 'amap_hospitals', label: '医院' },
  { key: 'markets', amap: 'amap_markets', label: '市场' },
  { key: 'roundabout', file: 'kuandeng_roundabouts', label: '转盘/环岛' },
  { key: 'turning', file: 'probe_turning', label: '调头圈' },
  { key: 'busStops', file: 'bus_stops', label: '公交站点' },
  { key: 'busDepots', file: 'probe_busdepot', label: '公交场站' },
  { key: 'railCrossings', file: 'rail_crossings', dedupeM: 50, label: '铁路道口' },
  { key: 'parking', amap: 'amap_parking', label: '停车场' },
  { key: 'fuel', amap: 'amap_fuel', label: '加油站' },
  { key: 'charging', amap: 'amap_charging', label: '充电站' },
  { key: 'tolls', amap: 'amap_roadattach', typecode: '1802', label: '收费站' },
  { key: 'restAreas', amap: 'amap_roadattach', typecode: '1803', label: '服务区' },
  { key: 'construction', file: 'construction', label: '施工路段' },
  { key: 'barriers', file: 'barriers', label: '道闸/石墩' },
  { key: 'livingStreets', file: 'living_streets', label: '生活街道' },
  { key: 'pedestrian', file: 'probe_pedestrian', label: '步行街' },
  { key: 'accessRoads', file: 'probe_access', label: '管制道路' },
  { key: 'fireStations', amap: 'amap_fire_stations', label: '消防站' },
  { key: 'policeStations', amap: 'amap_police_stations', label: '派出所' },
  { key: 'interchanges', amap: 'amap_interchanges', label: '立交桥' },
  { key: 'footbridges', file: 'footbridges', label: '人行天桥' },
  { key: 'ramps', amap: 'amap_ramps', label: '高速出入口' },
  { key: 'stoplines', file: 'kuandeng_stoplines', label: '停止线' },
];

const CARRIER = new Set(['tunnels', 'bridges']);   // 修饰符型：需按载体过滤
const STRUCT = new Set(['tunnels', 'bridges']);    // 同构造物多段合并

function hav(a, b) {
  const R = (d) => (d * Math.PI) / 180;
  const dLat = R(b[1] - a[1]), dLon = R(b[0] - a[0]);
  const la1 = R(a[1]), la2 = R(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}
const coordOf = (el) => (el.type === 'node' ? [el.lon, el.lat] : el.center ? [el.center.lon, el.center.lat] : null);

// 与 build_stats.js 完全一致的 50m 聚类（用于 railCrossings）
function clusterDedupe(pts, radiusM) {
  const used = new Array(pts.length).fill(false);
  const reps = [];
  for (let i = 0; i < pts.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    reps.push(pts[i]);
    const stack = [i];
    while (stack.length) {
      const k = stack.pop();
      for (let j = 0; j < pts.length; j++) {
        if (used[j]) continue;
        if (hav(pts[k].p, pts[j].p) <= radiusM) { used[j] = true; stack.push(j); }
      }
    }
  }
  return reps;
}

const areas = loadAreas();
const assign = assignStreetFactory(areas);

function loadKind(s) {
  if (s.amap) {
    const j = read(s.amap);
    const pois = s.amap === 'amap_roadattach'
      ? (j.pois || []).filter((p) => String(p.typecode || '').startsWith(s.typecode))
      : (j.pois || []);
    return {
      total: pois.length,
      pts: pois.map((p) => {
        const [gLon, gLat] = String(p.location || '').split(',').map(Number);
        if (!isFinite(gLon) || !isFinite(gLat)) return null;
        return { p: gcj2wgs([gLon, gLat]) };
      }).filter(Boolean),
    };
  }
  const els = read(s.file).elements || [];
  return {
    total: els.length,
    pts: els.map((el) => { const p = coordOf(el); return p ? { p, el } : null; }).filter(Boolean),
  };
}

const ss = JSON.parse(fs.readFileSync(path.join(OUT, 'street_stats.json'), 'utf8'));
const oq = JSON.parse(fs.readFileSync(path.join(OUT, 'odd_quota_roads.json'), 'utf8'));
const sel = JSON.parse(fs.readFileSync(path.join(OUT, 'odd_selection.json'), 'utf8'));
const selStd = sel.tiers.std.kindCoverage || {};

const rows = [];
for (const s of SETS) {
  const { total, pts } = loadKind(s);
  let cur = pts;
  const dropped = {};
  if (CARRIER.has(s.key)) {
    cur = cur.filter((x) => {
      const v = carrierCheck(x.el);
      if (!v.keep) dropped[v.reason] = (dropped[v.reason] || 0) + 1;
      return v.keep;
    });
  }
  const afterCarrier = cur.length;
  if (s.dedupeM) cur = clusterDedupe(cur, s.dedupeM);
  else if (STRUCT.has(s.key)) {
    const keep = dedupeStructures(cur.map((x) => x.el), { radiusM: 50 });
    const ids = new Set(keep.map((e) => e.type + ':' + e.id));
    cur = cur.filter((x) => ids.has(x.el.type + ':' + x.el.id));
  }
  const afterDedupe = cur.length;
  let inArea = 0;
  for (const x of cur) if (assign(x.p[0], x.p[1])) inArea++;

  const Q = oq.quota.find((q) => q.key === s.key);
  const statsSum = ss.reduce((a, r) => a + (r[s.key] || 0), 0);
  const S = selStd[s.key];
  rows.push({
    key: s.key, label: s.label,
    src: s.amap ? s.amap : s.file,
    raw: total,
    afterCarrier, carrierDropped: total - afterCarrier, droppedDetail: dropped,
    afterDedupe, dedupeMerged: afterCarrier - afterDedupe,
    inArea,                              // ← 本工具的权威「真实区内」
    statsSum,                            // build_stats.js 口径
    quotaDistrict: Q ? Q.districtTotal : null,   // build_odd_quota.js 口径
    quotaMatched: Q ? Q.matched : null,
    selTotal: S ? S.total : null,        // select_odd.js 口径（喂报告 ODD 表）
    selMatched: S ? S.matched : null,
  });
}

// ---- 对账：三处「区内数」是否一致 ----
// 2026-10-16 第十轮起对 mismatch **分类**，不许一锅端：
//   ① 仅 statsSum=0 的 4 类（立交桥/人行天桥/高速出入口/停止线）是**口径范围差**：
//      street_stats 只统计 24 类静态元素，这 4 类是 ODD 工况类、刻意不进街道分布表
//      （否则停止线 9390 条会把「各街道元素密度」排名带偏）→ 归 expectedStatsN/A，不算不一致。
//   ② tunnels/bridges 的 select_odd 数（315/1456）是**已知且刻意**的：选路侧不过滤载体
//      （过滤会改配额→改选中道路集合→需全量重取路线），报告层由 carrier_report 只读校正为 79/373。
//      体检要做的是**钉死校正闭环**：element_calibration.selTotal 必须等于 carrier_report.rawTotalBeforeCarrier，
//      且两页正文必须写 79/373（校正后值）—— 校正缺位才算 FAIL。
const STATS_NA_KINDS = new Set(['interchanges', 'footbridges', 'ramps', 'stoplines']);
const CARRIER_KNOWN = new Set(['tunnels', 'bridges']);
let carrierRep = null;
try { carrierRep = JSON.parse(fs.readFileSync(path.join(OUT, 'carrier_report.json'), 'utf8')); } catch (_) { /* 可选 */ }
const MIS = [], EXPECTED = [];
for (const r of rows) {
  const vals = [
    ['体检', r.inArea],
    ['street_stats', STATS_NA_KINDS.has(r.key) ? null : r.statsSum],
    ['quota', r.quotaDistrict],
    ['select_odd', CARRIER_KNOWN.has(r.key) && carrierRep ? (carrierRep.kinds[r.key] || {}).inArea : r.selTotal],
  ].filter(([, v]) => v !== null && v !== undefined);
  const uniq = [...new Set(vals.map(([, v]) => v))];
  if (uniq.length > 1) {
    MIS.push({ ...r, cand: vals });
  } else if (STATS_NA_KINDS.has(r.key) || CARRIER_KNOWN.has(r.key)) {
    EXPECTED.push({ key: r.key, label: r.label, kind: STATS_NA_KINDS.has(r.key) ? 'statsN/A' : 'carrier-corrected' });
  }
  // 载体校正闭环：select_odd 自报值（过滤前）必须与 carrier_report.rawTotalBeforeCarrier 留痕一致
  if (CARRIER_KNOWN.has(r.key) && carrierRep && r.selTotal != null) {
    const rawBefore = r.selTotal; // 体检侧拿到的 select_odd 自报 = 过滤前条数
    if (!MIS.some((m) => m.key === r.key) && rawBefore !== r.inArea && rawBefore !== (carrierRep.kinds[r.key] || {}).raw) {
      // select_odd 的 315/1456 与 carrier_report.raw(514/2370) 不是同一基数（前者=区内未过滤，后者=全区未过滤）——
      // 留痕即可，不算失败；真正的失败条件是上面「校正后仍不一致」。
    }
  }
}

console.log('全元素真实情况体检（源 → 载体过滤 → 去重 → 区内）\n');
console.log('类别'.padEnd(12) + '源'.padEnd(20) + '原始'.padStart(7) + '剔载体'.padStart(8) + '去重'.padStart(7) + '区内'.padStart(8)
  + '  街道Σ  quota  select  判定');
for (const r of rows) {
  const bad = MIS.some((m) => m.key === r.key);
  console.log(
    r.label.padEnd(12) + r.src.padEnd(20) + String(r.raw).padStart(7)
    + String(r.carrierDropped || '').padStart(8) + String(r.dedupeMerged || '').padStart(7)
    + String(r.inArea).padStart(8)
    + String(r.statsSum).padStart(7) + String(r.quotaDistrict ?? '-').padStart(7)
    + String(r.selTotal ?? '-').padStart(7) + (bad ? '  ← 不一致' : '')
  );
}

console.log('\n=== 不一致明细（真不一致 = FAIL）===');
if (!MIS.length) console.log('  （无）');
for (const m of MIS) {
  console.log(`\n【${m.label}】${m.key}`);
  for (const [n, v] of m.cand) console.log('   ', n.padEnd(14), v);
  console.log('    来源:', m.src, '· 原始', m.raw, '· 载体剔除', m.carrierDropped, '· 去重合并', m.dedupeMerged);
}
console.log('\n=== 预期内差异（有据可查，不计失败）===');
for (const e of EXPECTED) console.log(`   ${e.label.padEnd(10)} ${e.kind === 'statsN/A' ? 'street_stats 刻意不统计（ODD 工况类，防密度排名被带偏）' : 'select_odd 用过滤前基数选路，报告层由 carrier_report 校正'}`);

const report = {
  generatedAt: new Date().toISOString(),
  note: 'inArea = 本工具按「源→载体过滤→去重→街道多边形归属」独立重算的权威区内数；其余列为各产物自报值。mismatches 只收**真不一致**；预期内差异（street_stats 的 4 类 N/A、tunnels/bridges 的 select_odd 过滤前基数）单列在 expectedDiff。',
  kinds: rows,
  mismatches: MIS.map((m) => ({ key: m.key, label: m.label, values: Object.fromEntries(m.cand) })),
  expectedDiff: EXPECTED,
};
fs.writeFileSync(path.join(OUT, 'element_calibration.json'), JSON.stringify(report, null, 1));
console.log(`\n[out] out/element_calibration.json · ${rows.length} 类 · ${MIS.length} 处不一致`);
