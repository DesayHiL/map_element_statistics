// 元素数据体检查（载体感知版）
//   隧道/桥梁：由「载体」决定性质 → 看 highway / railway / waterway
//   红绿灯/人行横道/公交站等：标签本身就是要素类型 → 只查载体是否铁路
// 用法: node tools/audit_element_purity.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const D = (n) => path.join(ROOT, 'data', n + '.json');
const read = (n) => JSON.parse(fs.readFileSync(D(n), 'utf8'));
const RAIL_MOTORWAY_NAME = /高速|铁路|城际|高铁|京九/;
// 无人小车可通行的 ODD 路面
const DRIVABLE = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|track)(_link)?$/;
const VEHICLE_ROAD = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|track)(_link)?$/;

// 载体由道路/铁路决定的类别
const CARRIER_KEYS = [
  ['tunnels', '隧道'], ['bridges', '桥梁'],
];
// 标签即要素类型的类别（只关心「挂在铁路上的」）
const NODE_KEYS = [
  ['signals', '红绿灯'], ['crossings_full', '人行横道'], ['bus_stops', '公交站点'],
  ['roundabout', '转盘/环岛'], ['construction', '施工路段'], ['footbridges', '人行天桥'],
  ['living_streets', '生活街道'], ['barriers', '道闸/石墩'],
];

function carrierOf(e) {
  const g = e.tags || {};
  if (g.railway) return { kind: 'railway', hw: '' };
  if (g.waterway) return { kind: 'waterway', hw: '' };
  if (g.highway) return { kind: 'highway', hw: g.highway };
  if (g.building) return { kind: 'building', hw: '' };
  return { kind: 'other', hw: '' };
}

console.log('=== A. 载体决定性类别（隧道/桥梁）===');
console.log('类别      条目  车辆可通行  铁路  水道  步道/非车行  高速/铁路命名');
for (const [file, label] of CARRIER_KEYS) {
  const els = read(file).elements || [];
  let veh = 0, rail = 0, water = 0, nonveh = 0, nameFilt = 0;
  for (const e of els) {
    const c = carrierOf(e);
    const nm = (e.tags && e.tags.name) || '';
    if (RAIL_MOTORWAY_NAME.test(nm)) nameFilt++;
    if (c.kind === 'railway') rail++;
    else if (c.kind === 'waterway') water++;
    else if (c.kind === 'highway' && VEHICLE_ROAD.test(c.hw)) {
      if (c.hw === 'motorway' || c.hw === 'trunk' || c.hw.endsWith('_link')) veh += 0; // 高速域另计
      veh++;
    } else nonveh++;
  }
  console.log(label.padEnd(8), String(els.length).padEnd(5), String(veh).padEnd(10), String(rail).padEnd(5), String(water).padEnd(5), String(nonveh).padEnd(11), nameFilt);
}

console.log('\n=== B. 节点类（标签即类型）——仅统计铁路载体 ===');
for (const [file, label] of NODE_KEYS) {
  if (!fs.existsSync(D(file))) { console.log(label.padEnd(8), 'FILE MISSING (' + file + ')'); continue; }
  const els = read(file).elements || [];
  const onRail = els.filter((e) => e.tags && e.tags.railway).length;
  const named = els.filter((e) => e.tags && e.tags.name).length;
  const nameFilt = els.filter((e) => e.tags && RAIL_MOTORWAY_NAME.test(e.tags.name || '')).length;
  console.log(label.padEnd(8), 'n=' + String(els.length).padEnd(6), '挂在铁路=', String(onRail).padEnd(5), '有名=', String(named).padEnd(5), '名含铁路/高速=', nameFilt);
}

console.log('\n=== C. 隧道明细：真实车行隧道 vs 混入 ===');
{
  const els = read('tunnels').elements || [];
  const groups = {};
  for (const e of els) {
    const g = e.tags || {};
    let k;
    if (g.railway) k = '【铁路隧道】' + (g.railway || '');
    else if (g.waterway) k = '【涵洞/水道】tunnel=culvert';
    else if (!g.highway) k = '【无路网标签】';
    else if (/^(footway|steps|path|cycleway|pedestrian)$/.test(g.highway)) k = '【人行/非机动车道】' + g.highway;
    else if (g.highway === 'motorway' || g.highway === 'trunk' || /_link$/.test(g.highway)) k = '【高速域】' + g.highway;
    else k = '【车辆路·ODD内】' + g.highway;
    groups[k] = (groups[k] || 0) + 1;
  }
  Object.entries(groups).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ', String(v).padStart(4), k));
}
