// 共享地理与行政边界工具 —— 坐标系转换 + 18 个街道/镇多边形判定
//
// 抽取动机：这些函数原先在 build_stats.js / select_odd.js 里各存一份副本，
// 副本会静默分叉（2026-09-28 就出过：两处对 POI 的 GCJ→WGS 纠偏不一致，
// 导致街道级元素计数最大偏差 18.6%）。现在统一从这里导出，只此一份。
//
// 坐标系要点：
//   · OSM 数据（街道多边形、道路几何）是 **WGS-84**
//   · 高德数据（POI location、态势 polyline）是 **GCJ-02**
//   两者相差约 500m（东北方向），跨街道边界判定前必须转换。
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const read = (n) => JSON.parse(fs.readFileSync(path.join(DATA, n + '.json'), 'utf8'));

// ---------- 坐标系转换 WGS-84 <-> GCJ-02 ----------
function transformLat(x, y) {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  ret += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return ret;
}
function transformLon(x, y) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  ret += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return ret;
}
function wgs2gcj(wgs) {
  const a = 6378245, ee = 0.00669342162296594323;
  let [lon, lat] = wgs;
  if (lat < 0.8293 || lat > 55.8293) return [lon, lat];
  let dLat = transformLat(lon - 105, lat - 35);
  let dLon = transformLon(lon - 105, lat - 35);
  const radLat = (lat / 180) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLon = (dLon * 180) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return [lon + dLon, lat + dLat];
}
function gcj2wgs(gcj) {
  const wgs = wgs2gcj(gcj);
  return [gcj[0] * 2 - wgs[0], gcj[1] * 2 - wgs[1]];
}

// ---------- 点与多边形 ----------
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// polygons: [[outerRing, holeRing?, ...], ...]
function pointInPolygon(lon, lat, polygons) {
  for (const poly of polygons) {
    if (!poly.length) continue;
    if (pointInRing(lon, lat, poly[0])) {
      let inHole = false;
      for (let h = 1; h < poly.length; h++) {
        if (pointInRing(lon, lat, poly[h])) { inHole = true; break; }
      }
      if (!inHole) return true;
    }
  }
  return false;
}

// ---------- 行政边界（18 个惠城区街道/镇）----------
// 只取惠城区relation的正式成员；bbox 拉取会把邻区的镇一起带回来，
// 纳入会让道路/元素被错划到区外。
const HC_SUBDISTRICTS = new Set(
  read('hc_subnames').elements.map((e) => e.tags.name).filter(Boolean)
);

// ways 在 members 里无序，按共享端点接成闭合环
function stitchRings(segments) {
  const pool = segments.map((s) => s.slice());
  const rings = [];
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  while (pool.length) {
    let cur = pool.shift();
    let extended = true;
    while (extended && !same(cur[0], cur[cur.length - 1])) {
      extended = false;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i];
        if (same(cur[cur.length - 1], s[0])) { cur = cur.concat(s.slice(1)); pool.splice(i, 1); extended = true; break; }
        if (same(cur[cur.length - 1], s[s.length - 1])) { cur = cur.concat(s.slice(0, -1).reverse()); pool.splice(i, 1); extended = true; break; }
        if (same(cur[0], s[s.length - 1])) { cur = s.slice(0, -1).concat(cur); pool.splice(i, 1); extended = true; break; }
        if (same(cur[0], s[0])) { cur = s.slice(1).reverse().concat(cur); pool.splice(i, 1); extended = true; break; }
      }
    }
    if (cur.length >= 4) rings.push(cur);
  }
  return rings;
}

function loadAreas() {
  const bnd = read('boundaries_geom');
  const extra = read('lilin'); // 沥林镇在 bbox 之外，单独补
  const areas = [];
  for (const el of [...bnd.elements, ...extra.elements]) {
    const t = el.tags || {};
    if (t.admin_level !== '8' || !t.name) continue;
    if (!HC_SUBDISTRICTS.has(t.name)) continue;
    const segments = [];
    for (const m of el.members || []) {
      if (m.type !== 'way' || !m.geometry || m.geometry.length < 2) continue;
      if (m.role === 'inner') continue;
      segments.push(m.geometry.map((p) => [p.lon, p.lat]));
    }
    const rings = stitchRings(segments);
    if (!rings.length) continue;
    areas.push({ name: t.name, polygons: rings.map((r) => [r]) });
  }
  return areas;
}

/** 多边形集合的外接框 [minLon, minLat, maxLon, maxLat] */
function bboxOf(polygons) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of polygons) {
    for (const ring of poly) {
      for (const [x, y] of ring) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return isFinite(x0) ? [x0, y0, x1, y1] : null;
}

/**
 * 街道归属：输入 **WGS-84** 坐标，返回街道名或 null。
 * 若手上只有 GCJ-02 坐标（高德原始数据），请先 gcj2wgs(p) 再传入。
 */
function assignStreetFactory(areas) {
  // 预计算外接框：全区 18 个街道共约 7000 个顶点，逐点跑射线法是 O(全量顶点)。
  // 加外接框预筛后单点只对 1~2 个候选街道算射线法 —— 纯优化，判定结果完全一致。
  // 动机：态势路段的归属改为**沿 polyline 每 20m 打点**，单轮要判几十万个点，
  // 不做预筛会拖到分钟级。
  const boxes = areas.map((a) => bboxOf(a.polygons));
  return (lon, lat) => {
    for (let i = 0; i < areas.length; i++) {
      const b = boxes[i];
      if (!b) continue;
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      if (pointInPolygon(lon, lat, areas[i].polygons)) return areas[i].name;
    }
    return null;
  };
}

module.exports = {
  DATA, read,
  wgs2gcj, gcj2wgs,
  pointInRing, pointInPolygon,
  stitchRings, loadAreas, bboxOf,
  assignStreetFactory, HC_SUBDISTRICTS,
};
