// lib_kd_cover.js —— 宽凳路网覆盖判定（把「道路 ∈ 宽凳」前移进规划器的公共库）
// =============================================================================
// 数据：out/_kd_pts.bin（tools/dump_kd_pts.py 导出，Float32 米制投影点云）
//       out/_kd_pts.json（n / lon0 / lat0 / mlon / mlat）
// 投影与 tools/kd_graph.py 完全一致；宽凳为 GCJ-02，故 OSM(WGS-84) 道路需先 wgs2gcj。
//
// 用法：
//   const KD = require('./lib_kd_cover');
//   KD.nearestDevWGS(lonWGS, latWGS)          // 该 WGS 点到最近宽凳路的距离（m）
//   KD.coverOfWay(coordsWGS, band=30, step=25) // 折线在 band 内的采样点占比 + p50/p90
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const META = JSON.parse(fs.readFileSync(path.join(OUT, '_kd_pts.json'), 'utf8'));
const BIN = fs.readFileSync(path.join(OUT, '_kd_pts.bin'));
const N = META.n;
const XS = new Float32Array(BIN.buffer, BIN.byteOffset, N);
const YS = new Float32Array(BIN.buffer, BIN.byteOffset + N * 4, N);
const { lon0: LON0, lat0: LAT0, mlon: MLON, mlat: MLAT } = META;

// ---------- WGS84 → GCJ-02 ----------
const PI = Math.PI, A = 6378245.0, EE = 0.00669342162296594323;
function _tlat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  r += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
  return r;
}
function _tlon(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
  return r;
}
function wgs2gcj(lon, lat) {
  let dLat = _tlat(lon - 105, lat - 35), dLon = _tlon(lon - 105, lat - 35);
  const rad = (lat / 180) * PI;
  let m = Math.sin(rad); m = 1 - EE * m * m;
  const sq = Math.sqrt(m);
  dLat = (dLat * 180) / (((A * (1 - EE)) / (m * sq)) * PI);
  dLon = (dLon * 180) / ((A / sq) * Math.cos(rad) * PI);
  return [lon + dLon, lat + dLat];
}
const llToXY = (lon, lat) => [(lon - LON0) * MLON, (lat - LAT0) * MLAT];

// ---------- 均匀网格索引（CSR） ----------
const CELL = 50;
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (let i = 0; i < N; i++) {
  const x = XS[i], y = YS[i];
  if (x < minX) minX = x; if (x > maxX) maxX = x;
  if (y < minY) minY = y; if (y > maxY) maxY = y;
}
const W = Math.floor((maxX - minX) / CELL) + 2;
const H = Math.floor((maxY - minY) / CELL) + 2;
const cellOf = (x, y) => {
  const cx = Math.floor((x - minX) / CELL), cy = Math.floor((y - minY) / CELL);
  return (cx < 0 || cy < 0 || cx >= W || cy >= H) ? -1 : cy * W + cx;
};
const counts = new Int32Array(W * H + 1);
const cellIdx = new Int32Array(N);
for (let i = 0; i < N; i++) { const c = cellOf(XS[i], YS[i]); cellIdx[i] = c; if (c >= 0) counts[c + 1]++; }
for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
const order = new Int32Array(N);
{
  const cur = counts.slice();
  for (let i = 0; i < N; i++) { const c = cellIdx[i]; if (c >= 0) order[cur[c]++] = i; }
}

// 点到最近宽凳几何点的距离（m）；band 外返回 > band 的值（用于快速判定）
function nearestDevXY(px, py, band) {
  const cx = Math.floor((px - minX) / CELL), cy = Math.floor((py - minY) / CELL);
  const R = Math.ceil(band / CELL);
  let best = band * band * 4 + 1;
  for (let gy = cy - R; gy <= cy + R; gy++) {
    if (gy < 0 || gy >= H) continue;
    for (let gx = cx - R; gx <= cx + R; gx++) {
      if (gx < 0 || gx >= W) continue;
      const c = gy * W + gx;
      for (let k = counts[c]; k < counts[c + 1]; k++) {
        const j = order[k];
        const dx = px - XS[j], dy = py - YS[j];
        const d2 = dx * dx + dy * dy;
        if (d2 < best) best = d2;
      }
    }
  }
  return Math.sqrt(best);
}

const nearestDevWGS = (lon, lat, band = 30) => {
  const [g, t] = wgs2gcj(lon, lat);
  const [x, y] = llToXY(g, t);
  return nearestDevXY(x, y, band);
};

// 折线（WGS-84）在 band 内的采样点占比；step 为沿路重采样步长（m）
function coverOfWay(coordsWGS, band = 30, step = 25) {
  const devs = [];
  const hav = (a, b) => {
    const r = PI / 180, R = 6371008.8;
    const dLat = r * (b[1] - a[1]), dLon = r * (b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r * a[1]) * Math.cos(r * b[1]) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  for (let i = 1; i < coordsWGS.length; i++) {
    const a = coordsWGS[i - 1], b = coordsWGS[i];
    const d = hav(a, b);
    const n = Math.max(2, Math.floor(d / step) + 1);
    for (let k = 0; k < n; k++) {
      const t = k / (n - 1);
      devs.push(nearestDevWGS(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, band));
    }
  }
  if (!devs.length) return { cover: 0, p50: null, p90: null, n: 0 };
  devs.sort((x, y) => x - y);
  const on = devs.filter((d) => d <= band).length;
  return {
    cover: on / devs.length,
    p50: +devs[Math.floor(devs.length * 0.5)].toFixed(1),
    p90: +devs[Math.floor(devs.length * 0.9)].toFixed(1),
    n: devs.length,
  };
}

module.exports = { wgs2gcj, llToXY, nearestDevWGS, nearestDevXY, coverOfWay, N, META };
