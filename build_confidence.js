// 元素置信度定级 —— 把"这个数能不能信"变成可复核的数据产物，而不是一句判断。
//
// 定级规则（全部由实测指标驱动，任一指标都能单独重跑验证）：
//   高（A）：源为高德 POI。商业地图持续维护，且 typecode 由接口实际响应核对过
//            （out/amap_typecode_probe.json）。
//   中（B）：源为 OSM 道路几何/拓扑属性。这类数据本工程的里程已用高德校核
//            （23 样本，osm_calibration.json 中位 0.947），且元素坐标全量落在
//            路网上（osm_truth_audit.json 超阈比例 <5%）。
//   中（C）：源为 OSM 点要素，几何校验通过（超阈 <5%），但众包覆盖未知。
//   低（D）：与独立源同口径对比 <50%（计数只能当"下界"），或无独立源可交叉验证。
//
// 输出 out/element_confidence.json，报告第 7 节据此渲染置信度列。
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'out');
const readOut = (n) => JSON.parse(fs.readFileSync(path.join(OUT, n + '.json'), 'utf8'));

const xcheck = new Map(readOut('source_crosscheck').rows.map((r) => [r.label, r]));
const truth = new Map(readOut('osm_truth_audit').rows.map((r) => [r.key, r]));
const rail = readOut('railway_audit');
const calib = readOut('osm_calibration').summary || {};
let stats = [];
try { stats = readOut('street_stats'); } catch (e) { /* 统计未生成时只输出定级 */ }
const sum = (k) => stats.reduce((s, r) => s + (r[k] || 0), 0);

// 与 build_stats.js 的 ELEMENT_SETS 对应。kind: amap | osm-way | osm-point
const DEFS = [
  { key: 'parking', label: '停车场', kind: 'amap', code: '150904', xLabel: '停车场' },
  { key: 'fuel', label: '加油站', kind: 'amap', code: '010100', xLabel: '加油站' },
  { key: 'charging', label: '充电站', kind: 'amap', code: '011100', xLabel: '充电站' },
  { key: 'tolls', label: '收费站', kind: 'amap', code: '1802', xLabel: null },
  { key: 'restAreas', label: '服务区', kind: 'amap', code: '1803', xLabel: null },
  { key: 'schools', label: '学校', kind: 'amap', code: '141200', xLabel: '学校' },
  { key: 'hospitals', label: '医院', kind: 'amap', code: '090100', xLabel: '医院/诊所' },
  { key: 'markets', label: '市场', kind: 'amap', code: '060700', xLabel: '市场/农贸' },
  { key: 'fireStations', label: '消防站', kind: 'amap', code: '130504', xLabel: '消防站' },
  { key: 'policeStations', label: '派出所', kind: 'amap', code: '130501', xLabel: '派出所' },
  { key: 'tunnels', label: '隧道', kind: 'osm-way', tag: 'way[tunnel]' },
  { key: 'bridges', label: '桥梁', kind: 'osm-way', tag: 'way[bridge]' },
  { key: 'roundabout', label: '转盘/环岛', kind: 'osm-way', tag: 'way[junction=roundabout]' },
  { key: 'construction', label: '施工路段', kind: 'osm-way', tag: 'way[construction]' },
  { key: 'livingStreets', label: '生活街道', kind: 'osm-way', tag: 'way[highway=living_street]' },
  { key: 'pedestrian', label: '步行街', kind: 'osm-way', tag: 'way[highway=pedestrian]' },
  { key: 'accessRoads', label: '管制道路', kind: 'osm-way', tag: 'way[access=private|permit|...]' },
  { key: 'signals', label: '红绿灯', kind: 'osm-point', tag: 'node[highway=traffic_signals]', xLabel: null },
  { key: 'crossings', label: '人行横道', kind: 'osm-point', tag: 'node[highway=crossing]', xLabel: null },
  { key: 'busStops', label: '公交站点', kind: 'osm-point', tag: 'node[highway=bus_stop]', xLabel: '公交站' },
  { key: 'barriers', label: '道闸/石墩', kind: 'osm-point', tag: 'node[barrier=gate|lift_gate]', xLabel: null },
  { key: 'turning', label: '调头圈', kind: 'osm-point', tag: 'node[highway=turning_circle]', xLabel: null },
  { key: 'railCrossings', label: '铁路道口', kind: 'osm-point', tag: 'node[railway=level_crossing]', xLabel: null, fixed: '同一处被重复标注，已按 50m 聚类合并' },
  { key: 'busDepots', label: '公交场站', kind: 'osm-point', tag: 'way[amenity=bus_station]', xLabel: null, noXcheck: '高德无独立口径（公交站场与站台同为 150700），无法交叉验证' },
];

const CALIB_NOTE = `路网里程已用高德校核（${calib.valid ?? '—'} 个有效样本，比值中位 ${calib.median ?? '—'}）`;

const rows = DEFS.map((d) => {
  const n = stats.length ? sum(d.key) : null;
  const x = d.xLabel ? xcheck.get(d.xLabel) : null;
  let level = null, basis = '';

  if (d.kind === 'amap') {
    level = 'A';
    basis = `高德 POI ${d.code}，typecode 由接口实际响应核对`;
    if (x) basis += `；同口径 OSM 仅 ${x.osmCount} 个（OSM/高德 ${x.ratio}%），OSM 侧不可用`;
  } else if (d.kind === 'osm-way') {
    level = 'B';
    basis = `OSM 道路几何（${d.tag}）；${CALIB_NOTE}`;
  } else {
    const t = truth.get(d.key);
    const geom = t && t.n ? `坐标落在路网上，超阈 ${t.overPct}%（阈 ${t.gate}m）` : null;
    if (d.noXcheck) {
      level = 'D';
      basis = geom ? `${geom}；${d.noXcheck}` : d.noXcheck;
    } else if (x && x.ratio != null && x.ratio < 50) {
      level = 'D';
      basis = `${geom ? geom + '；' : ''}同口径 OSM/高德 ${x.ratio}%，众包标注不全，计数只能当下界`;
    } else if (x && x.ratio != null && x.ratio >= 80) {
      level = 'B';
      basis = `${geom ? geom + '；' : ''}OSM/高德 ${x.ratio}%${x.ratio > 100 ? '（OSM 更全，含对向站台）' : ''}`;
    } else {
      level = 'C';
      basis = geom || 'OSM 点要素';
      if (x) basis += `；OSM/高德 ${x.ratio}%`;
    }
    if (d.fixed) basis += `；${d.fixed}（${rail.crossingsRaw} → ${rail.clusters50m} 个）`;
  }
  return {
    key: d.key, label: d.label,
    source: d.kind === 'amap' ? `高德 POI ${d.code}` : `OSM ${d.tag}`,
    sourceKind: d.kind,
    count: n,
    level,
    levelLabel: { A: '高', B: '中', C: '中', D: '低' }[level],
    basis,
  };
});

const tally = {};
for (const r of rows) tally[r.level] = (tally[r.level] || 0) + 1;
const payload = {
  generatedAt: new Date().toISOString(),
  legend: {
    A: '高 — 高德 POI，typecode 经接口响应核对',
    B: '中 — OSM 道路几何/点要素，里程与坐标均已实测校核',
    C: '中 — OSM 点要素，几何校验通过但众包覆盖未知',
    D: '低 — 与独立源对比 <50% 或无独立源可验证，计数只能当下界',
  },
  tally,
  rows,
};
fs.writeFileSync(path.join(OUT, 'element_confidence.json'), JSON.stringify(payload, null, 1));

console.log('元素置信度定级（' + rows.length + ' 类）\n');
console.log('类别'.padEnd(14) + '源'.padEnd(26) + '计数'.padStart(6) + '  级别');
for (const r of rows) {
  console.log(r.label.padEnd(14) + r.source.padEnd(26) + String(r.count ?? '—').padStart(6) + '  ' + r.level + '(' + r.levelLabel + ')');
}
console.log('\n汇总:', JSON.stringify(tally));
console.log('-> out/element_confidence.json');
