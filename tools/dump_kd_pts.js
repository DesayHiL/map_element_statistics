// Node 版 dump_kd_pts —— 重建 out/_kd_pts.bin（原 Python 脚本因本机无 Python 不可用）
// 逻辑与 tools/dump_kd_pts.py 逐字对齐：
//   ROAD_LINK.fixed.npy (structured) + ROAD_LINK.geom.bin (Float64 x,y 对)
//   → 投影米制 (LAT0=23.16, LON0=114.40) → 两块布局 [x0..xn-1][y0..yn-1] Float32
// 产物：out/_kd_pts.bin / out/_kd_pts.json（lib_kd_cover.js 读取，投影常量同源）
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const CACHE = 'D:/workspace/sim-simcore-sim_map_factory/.kd_cache/c2d68d5383a710ab';
const LAT0 = 23.16, LON0 = 114.40;
const MLON = 111320.0 * Math.cos(LAT0 * Math.PI / 180), MLAT = 110574.0;

// ---- 解析 .npy（structured dtype, little endian, C order）----
function loadNpy(file) {
  const buf = fs.readFileSync(file);
  const hlen = buf.readUInt16LE(8);
  const header = buf.slice(10, 10 + hlen).toString('ascii');
  const mShape = /'shape': \(([^)]*)\)/.exec(header);
  const shape = mShape[1].split(',').filter(x => x.trim()).map(Number);
  const mDescr = /'descr': (\[.*\])/.exec(header);
  // 字段布局: [name, '<f8', (4,)] / [name, '<i8'] / [name, '<i4']
  const fields = [];
  const re = /\('([^']+)', '([^']+)'(?:, \((\d+)\))?/g;
  let m;
  while ((m = re.exec(mDescr[1]))) {
    const size = m[2] === '<f8' || m[2] === '<i8' ? 8 : 4;
    const count = m[3] ? +m[3] : 1;
    fields.push({ name: m[1], size, count });
  }
  const dataOff = 10 + hlen;
  return { buf, shape, fields, dataOff };
}

// 字段字节偏移（numpy structured 对齐布局，实测 data bytes 17464392 / 198459 = 88）
const itemSize = 88;

const npy = loadNpy(path.join(CACHE, 'ROAD_LINK.fixed.npy'));
console.log('npy shape:', npy.shape, 'itemSize:', npy.itemSize, 'fields:', npy.fields.map(f => f.name + '@' + f.offset).join(' '));

const nRows = npy.shape[0];
// 字段字节偏移（对齐布局，见 itemSize 注释）
const GOFF = 32, GN = 40;
const geomOff = new Float64Array(nRows);
const geomN = new Int32Array(nRows);
for (let i = 0; i < nRows; i++) {
  const base = npy.dataOff + i * itemSize;
  geomOff[i] = Number(npy.buf.readBigInt64LE(base + GOFF) / 16n); // geom_off 为字节偏移 → ÷16 转 f8 元素下标（Python: f['geom_off']//16 同款）
  geomN[i] = npy.buf.readInt32LE(base + GN);
}

// geom.bin: Float64 对 (x=lon, y=lat)，GCJ-02
const geomBuf = fs.readFileSync(path.join(CACHE, 'ROAD_LINK.geom.bin'));
const N = geomN.reduce((s, g) => s + g, 0);
console.log('total geom points:', N);

// 两块布局 Float32
const xs = new Float32Array(N), ys = new Float32Array(N);
let k = 0;
for (let r = 0; r < nRows; r++) {
  const off = Number(geomOff[r]);
  for (let j = 0; j < geomN[r]; j++) {
    const lon = geomBuf.readDoubleLE(off * 16);
    const lat = geomBuf.readDoubleLE(off * 16 + 8);
    xs[k] = (lon - LON0) * MLON;
    ys[k] = (lat - LAT0) * MLAT;
    k++;
  }
}
console.log('projected:', k, 'expected:', N, k === N ? '✓' : '✗');

fs.writeFileSync(path.join(OUT, '_kd_pts.bin'), Buffer.concat([Buffer.from(xs.buffer), Buffer.from(ys.buffer)]));
fs.writeFileSync(path.join(OUT, '_kd_pts.json'), JSON.stringify({ n: N, lon0: LON0, lat0: LAT0, mlon: MLON, mlat: MLAT }));
console.log(`[out] _kd_pts.bin ${(2 * N * 4 / 1024 / 1024).toFixed(1)} MB · ${N.toLocaleString()} 点`);