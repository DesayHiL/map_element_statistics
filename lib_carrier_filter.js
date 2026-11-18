// 元素载体过滤与去重（共享口径）
//
// 背景：OSM 的 tunnel=yes / bridge=yes 是「修饰符」，会贴在任意载体上——
//   铁路（莞惠城际）、水道涵洞（tunnel=culvert）、人行道（footway）、高速主线。
//   而「无人小车 ODD」只关心自己会驶入的车辆路。不加过滤会让
//   「途经隧道 N 个」这类标签把铁路隧道、溪流涵洞全算进来。
//
// 口径：
//   1) 载体必须是小车可行驶的 ODD 路面（排除铁路/水道/人行/高速域）
//   2) 同一隧道/桥梁被 OSM 拆成多段时，按 50m 邻域合并计为 1 个
//
// 用法: const { filterCarrier, dedupeCollinear } = require('./lib_carrier_filter');
const EARTH = 6371008.8;
const _rad = (d) => (d * Math.PI) / 180;

function havM(a, b) {
  const dLat = _rad(b[1] - a[1]), dLon = _rad(b[0] - a[0]);
  const la1 = _rad(a[1]), la2 = _rad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.sqrt(h));
}

// 小车可行驶的 ODD 路面（不含高速域 —— 无人小车不上高速主线）
const ODD_ROAD = /^(primary|secondary|tertiary|unclassified|residential|living_street|service|road|track)(_link)?$/;
// 高速域（只计不配额）
const HWDOM = /^(motorway|trunk)(_link)?$/;
// 非机动车/人行载体
const NONVEH = /^(footway|steps|path|cycleway|pedestrian|bridleway|corridor|platform)$/;

// 返回 { keep, reason }
function carrierCheck(el, opts = {}) {
  const g = el.tags || {};
  const hw = g.highway;
  if (g.railway) return { keep: false, reason: '铁路 ' + g.railway };
  if (g.waterway) return { keep: false, reason: '水道/涵洞 ' + g.waterway };
  if (!hw) return { keep: false, reason: '无路网标签' };
  if (NONVEH.test(hw)) return { keep: false, reason: '非车行 ' + hw };
  if (HWDOM.test(hw)) {
    // 高速域可配置保留（tolls/restAreas/ramps 走 SKIP_KINDS，仍要计数）
    return { keep: !!opts.allowHighwayDomain, reason: '高速域 ' + hw };
  }
  if (ODD_ROAD.test(hw)) return { keep: true, reason: 'ODD 车辆路 ' + hw };
  return { keep: false, reason: '其他 ' + hw };
}

// 按名称优先、否则 50m 邻域合并 —— 同一隧道被 OSM 拆多段时计为 1 个
//   els: OSM elements（含 tags/center 或 lon/lat）
//   opts.radiusM 合并半径（默认 50）
//   opts.byName  是否优先按 tunnel:name/name 归并（默认 true）
function dedupeStructures(els, opts = {}) {
  const radiusM = opts.radiusM == null ? 50 : opts.radiusM;
  const byName = opts.byName !== false;
  const named = new Map();   // name -> representative
  const anon = [];
  for (const el of els) {
    const g = el.tags || {};
    const c = el.type === 'node' ? [el.lon, el.lat]
      : el.center ? [el.center.lon, el.center.lat]
        : el.geometry && el.geometry.length ? [el.geometry[Math.floor(el.geometry.length / 2)].lon,
                                              el.geometry[Math.floor(el.geometry.length / 2)].lat] : null;
    if (!c) continue;
    const nm = g['tunnel:name'] || g.name || g['bridge:name'];
    if (byName && nm && named.has(nm)) {
      const rep = named.get(nm);
      // 同名但相距很远（>2km）视为不同构造物，另立一条
      if (havM(rep.c, c) > 2000) anon.push({ el, c });
      continue;
    }
    if (byName && nm) named.set(nm, { el, c });
    else anon.push({ el, c });
  }
  // 无名条目按邻域聚类
  const reps = [];
  const used = new Array(anon.length).fill(false);
  for (let i = 0; i < anon.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    reps.push(anon[i].el);
    const stack = [i];
    while (stack.length) {
      const k = stack.pop();
      for (let j = 0; j < anon.length; j++) {
        if (used[j]) continue;
        if (havM(anon[k].c, anon[j].c) <= radiusM) { used[j] = true; stack.push(j); }
      }
    }
  }
  const out = [...[...named.values()].map((x) => x.el), ...reps];
  return out;
}

module.exports = { carrierCheck, dedupeStructures, havM, ODD_ROAD, HWDOM, NONVEH };
