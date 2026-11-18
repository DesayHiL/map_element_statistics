// 全类别载体纯度体检（语义修正版）
//
// 核心区分：
//   [MODIFIER] 标签是「修饰符」，可贴在任意载体上 → 存在载体污染
//              例：tunnel=yes 同时出现在铁路/水道/人行道/高速上
//   [SELF]     标签「本身就是目标要素」→ 无载体污染
//              例：railway=level_crossing 就是铁路道口；highway=pedestrian 就是步行街；
//                  highway=footway+bridge=yes 就是人行天桥（本就该建在人行载体上）
//
// 用法: node tools/audit_all_kinds.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const D = (n) => path.join(ROOT, 'data', n + '.json');
const read = (n) => JSON.parse(fs.readFileSync(D(n), 'utf8'));

// 无人小车可驶入的 ODD 路面（含城市道路，不含高速域）
const ODD_ROAD = /^(primary|secondary|tertiary|unclassified|residential|living_street|service|road|track)(_link)?$/;
// 高速域（无人小车不上主线，与 SKIP_KINDS 口径一致）
const HWDOM = /^(motorway|trunk)(_link)?$/;
// 非机动车/人行
const NONVEH = /^(footway|steps|path|cycleway|pedestrian|bridleway|corridor|platform)$/;

const SETS = [
  { key: 'signals', file: 'signals', label: '红绿灯', mode: 'SELF' },
  { key: 'crossings', file: 'crossings_full', label: '人行横道', mode: 'SELF' },
  { key: 'tunnels', file: 'tunnels', label: '隧道', mode: 'MODIFIER' },
  { key: 'bridges', file: 'bridges', label: '桥梁', mode: 'MODIFIER' },
  { key: 'roundabout', file: 'roundabout', label: '转盘/环岛', mode: 'SELF' },
  { key: 'turning', file: 'probe_turning', label: '调头圈', mode: 'SELF' },
  { key: 'busStops', file: 'bus_stops', label: '公交站点', mode: 'SELF' },
  { key: 'busDepots', file: 'probe_busdepot', label: '公交场站', mode: 'SELF' },
  { key: 'railCrossings', file: 'rail_crossings', label: '铁路道口', mode: 'SELF' },
  { key: 'construction', file: 'construction', label: '施工路段', mode: 'SELF' },
  { key: 'barriers', file: 'barriers', label: '道闸/石墩', mode: 'SELF' },
  { key: 'livingStreets', file: 'living_streets', label: '生活街道', mode: 'SELF' },
  { key: 'pedestrian', file: 'probe_pedestrian', label: '步行街', mode: 'SELF' },
  { key: 'accessRoads', file: 'probe_access', label: '管制道路', mode: 'SELF' },
  { key: 'footbridges', file: 'footbridges', label: '人行天桥', mode: 'SELF' },
];

// 对 MODIFIER 类别判定该条目是否为「ODD 内车辆路载体」
function carrierVerdict(e) {
  const g = e.tags || {};
  if (g.railway) return { bad: true, desc: '铁路 ' + (g.railway || '') };
  if (g.waterway) return { bad: true, desc: '水道/涵洞 ' + (g.waterway || '') };
  if (!g.highway) return { bad: true, desc: '无路网标签' };
  const hw = g.highway;
  if (NONVEH.test(hw)) return { bad: true, desc: '非车行 ' + hw };
  if (HWDOM.test(hw)) return { bad: true, desc: '高速域 ' + hw };
  if (ODD_ROAD.test(hw)) return { bad: false, desc: 'ODD 车辆路 ' + hw };
  return { bad: true, desc: '其他 ' + hw };
}

console.log('全类别载体纯度体检（原始 data/*.json，全区范围）\n');
console.log('类别        模式      条目    污染   占比    说明');
const dirty = [];
for (const s of SETS) {
  if (!fs.existsSync(D(s.file))) { console.log(s.label.padEnd(10), 'FILE MISSING:', s.file); continue; }
  const els = read(s.file).elements || [];
  let bad = 0, note = '';
  if (s.mode === 'MODIFIER') {
    for (const e of els) if (carrierVerdict(e).bad) bad++;
    note = bad ? '← 有载体污染，需过滤' : '';
  } else {
    // SELF 类：只提示「是否有非 ODD 载体搭车」（如高速域 link）
    let hwdom = 0, rail = 0;
    for (const e of els) {
      const hw = (e.tags || {}).highway || '';
      if (HWDOM.test(hw)) hwdom++;
      if ((e.tags || {}).railway && s.key !== 'railCrossings') rail++;
    }
    bad = hwdom;
    if (hwdom) note = `其中高速域 ${hwdom} 条`;
  }
  const pct = els.length ? (bad / els.length * 100).toFixed(1) + '%' : '—';
  console.log(
    s.label.padEnd(10), s.mode.padEnd(9),
    String(els.length).padEnd(7), String(bad).padEnd(6), pct.padEnd(7), note
  );
  if (s.mode === 'MODIFIER' && bad > 0) dirty.push({ ...s, n: els.length, bad });
}

console.log('\n=== 结论 ===');
console.log('真正存在「载体污染」的类别（MODIFIER 型）：');
for (const d of dirty) {
  console.log(`  · ${d.label}：${d.bad}/${d.n} 条不是 ODD 车辆路载体（${(d.bad / d.n * 100).toFixed(1)}%）`);
}
console.log('\n其余类别（SELF 型）标签即要素本身，无载体污染问题。');

console.log('\n=== MODIFIER 类别污染明细 ===');
for (const d of dirty) {
  const det = {};
  for (const e of read(d.file).elements) {
    const v = carrierVerdict(e);
    if (v.bad) det[v.desc] = (det[v.desc] || 0) + 1;
  }
  console.log(`\n【${d.label}】`);
  Object.entries(det).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('   ', String(v).padStart(5), k));
}
