// =============================================================================
// 宽凳 DIVIDER（车道边界线 / 交通标线）→ 路线级「线型覆盖」几何统计
// =============================================================================
// 为什么要单独做，而不是像其它元素那样塞进 ELEMENT_SETS：
//   车道边界线是**沿路密集线性要素**（区内 60 万+ 条），任何一条路线都会「途经」
//   几万条 —— 按「途经 x/配额 139」表达毫无区分度，且配额概念（抽样估计）对它
//   不成立（它不是可抽样的事件点，是连续介质）。
//   对它唯一有意义的覆盖问题是：**本次排班能覆盖到 18 种线型里的多少种**，
//   因为 ODD 关心的是「测试是否见到了 双实线 / 左实右虚 / 护栏+单实线 这类场景」。
//
// 口径：
//   · 判定半径 PASS_M = 60m，与其它元素一致；路线折线按 ≈40m 加密。
//   · 线型/颜色按 DIVIDER_ATTR 的 **位掩码并集**归属到每条 DIVIDER：
//     一条 DIVIDER 在空间上被切成多段属性，取并集而不是「取第一条」，避免丢型。
//   · 区内统计用与其它元素同一套 18 街道多边形（street_areas.assignStreetFactory）。
//
// 输入：out/routes.json（重规划后的 52 条路线）
// 输出：out/kuandeng_markings.json
// 只读内网 UNC。
const fs = require('fs');
const path = require('path');
const K = require('./lib_kuandeng');
const A = require('./street_areas');

const OUT = path.join(__dirname, 'out');
const PASS_M = 60;
const CELL = 0.001;

const readOut = (n) => JSON.parse(fs.readFileSync(path.join(OUT, n + '.json'), 'utf8'));

// 宽凳 dbf/shp 单个文件可达 600MB+，fs.readFileSync 会撞上托管文件系统的读取上限
// （errno -4094 UNKNOWN）。改成分块 readSync 拼装（2026-10-16 踩到）。
function readBig(p, chunk = 64 * 1024 * 1024) {
  const size = fs.statSync(p).size;
  const out = Buffer.allocUnsafe(size);
  const fd = fs.openSync(p, 'r');
  let off = 0;
  try {
    while (off < size) {
      const n = fs.readSync(fd, out, off, Math.min(chunk, size - off), off);
      if (n <= 0) break;
      off += n;
    }
  } finally { fs.closeSync(fd); }
  return out;
}

function main() {
  if (!fs.existsSync(K.KD)) { console.error('UNC 不可达'); process.exit(1); }
  const routes = readOut('routes');

  // ---------- 1) 路线点网格（WGS-84）----------
  const pts = [];           // {x, y, r} r = 路线下标
  const routeMeta = [];     // 与下标一一对应
  let ri = 0;
  for (const rt of routes.routes) {
    if (rt.status !== 'ok') continue;
    (rt.routes || []).forEach((leg, li) => {
      const idx = ri++;
      routeMeta.push({
        key: `${rt.street}#${li}`, street: rt.street, idx: li + 1,
        distKm: leg.distKm, durMin: leg.durMin,
      });
      if (!leg.poly || leg.poly.length < 2) return;
      const w = leg.poly.map(([lo, la]) => A.gcj2wgs([lo, la]));
      for (let i = 1; i < w.length; i++) {
        const [ax, ay] = w[i - 1], [bx, by] = w[i];
        const d = Math.hypot(bx - ax, by - ay);
        const n = Math.max(1, Math.ceil(d / 0.0004));
        for (let k = 0; k < n; k++) pts.push({ x: ax + ((bx - ax) * k) / n, y: ay + ((by - ay) * k) / n, r: idx });
      }
      pts.push({ x: w[w.length - 1][0], y: w[w.length - 1][1], r: idx });
    });
  }
  const grid = new Map();
  pts.forEach((p) => {
    const key = `${Math.floor(p.x / CELL)}|${Math.floor(p.y / CELL)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(p);
  });
  console.log(`路线点 ${pts.length} 个 / ${routeMeta.length} 条路线 → 网格 ${grid.size} 格`);

  const nearLine = (lon, lat) => {
    const cx = Math.floor(lon / CELL), cy = Math.floor(lat / CELL);
    const thr = (PASS_M / 111320 / Math.cos((lat * Math.PI) / 180)) ** 2;
    const hit = new Set();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const arr = grid.get(`${cx + dx}|${cy + dy}`);
      if (!arr) continue;
      for (const p of arr) {
        const d2 = (p.x - lon) ** 2 + (p.y - lat) ** 2;
        if (d2 <= thr) hit.add(p.r);
      }
    }
    return hit;
  };

  // ---------- 2) DIVIDER_ATTR → 每条 DIVIDER 的线型/颜色位掩码 ----------
  const attrBuf = readBig(path.join(K.KD, 'DIVIDER_ATTR.dbf'));
  let maxId = 0;
  const attrInfo = K.dbfHeader(attrBuf);
  // 先扫一遍求 ID 上界（避免用 Map 存 84 万条）
  K.dbfEach(attrBuf, (r) => { const v = +r.DIVIDER_ID; if (v > maxId) maxId = v; });
  const typeMask = new Int32Array(maxId + 2);
  const colorMask = new Uint8Array(maxId + 2);
  let attrUsed = 0;
  K.dbfEach(attrBuf, (r) => {
    const id = +r.DIVIDER_ID;
    if (!(id >= 0 && id <= maxId)) return;
    const t = +r.LINE_TYPE, c = +r.LINE_COLOR;
    if (t >= 0 && t <= 31) typeMask[id] |= (1 << t);
    if (c >= 0 && c <= 7) colorMask[id] |= (1 << c);
    attrUsed++;
  });
  console.log(`DIVIDER_ATTR ${attrInfo.nrec} 条属性段 → 归并到 ${maxId} 号以内 DIVIDER（${attrUsed} 条有效）`);
  console.log(`  字段: ${attrInfo.flds.map((f) => f.name).join(',')}`);

  // ---------- 3) DIVIDER.dbf → 记录顺序 → LINE_ID ----------
  const divBuf = readBig(path.join(K.KD, 'DIVIDER.dbf'));
  const divInfo = K.dbfHeader(divBuf);
  const lineIds = new Int32Array(divInfo.nrec);
  K.dbfEach(divBuf, (r, i) => { lineIds[i] = +r.LINE_ID; });
  let lmax = 0; for (let i = 0; i < lineIds.length; i++) if (lineIds[i] > lmax) lmax = lineIds[i];
  console.log(`DIVIDER.dbf ${divInfo.nrec} 条 · LINE_ID 上界 ${lmax} · 记录长 ${divInfo.rsz}B`);
  if (lmax > maxId + 1) {
    // ATTR 没覆盖到的 ID：扩一张更大的表（正常不该发生，发生时显式告警）
    console.log(`⚠ DIVIDER LINE_ID 上界 ${lmax} > ATTR 上界 ${maxId} —— 这部分 DIVIDER 无线型属性`);
  }
  // 释放两个大 buffer
  const shpPath = path.join(K.KD, 'DIVIDER.shp');

  // ---------- 4) 街道归属（区内口径）----------
  const areas = A.loadAreas();
  const assignStreet = A.assignStreetFactory(areas);

  // ---------- 5) 扫 DIVIDER.shp ----------
  const shpBuf = readBig(shpPath);
  const shpInfo = K.shpHeader(shpPath);
  console.log(`DIVIDER.shp ${(shpInfo.bytes / 1048576).toFixed(0)}MB · type=${shpInfo.shapeType}`);

  const district = { dividers: 0, painted: 0, physical: 0, byType: {}, byColor: {} };
  const routeTypes = routeMeta.map(() => ({ typeMask: 0, colorMask: 0, hits: 0 }));
  const allTypes = new Set();
  let processed = 0, missed = 0;

  K.shpEachLine(shpBuf, (g, i) => {
    if (!g) return;
    processed++;
    const lid = lineIds[i];
    const tm = lid <= maxId ? typeMask[lid] : 0;
    const cm = lid <= maxId ? colorMask[lid] : 0;
    // 区内
    const st = assignStreet(g.mid[0], g.mid[1]);
    if (st) {
      district.dividers++;
      let painted = false;
      for (let t = 0; t <= 31; t++) {
        if (!(tm & (1 << t))) continue;
        district.byType[t] = (district.byType[t] || 0) + 1;
        if (K.PAINTED.has(t)) painted = true;
        allTypes.add(t);
      }
      if (painted) district.painted++; else district.physical++;
      for (let c = 0; c <= 2; c++) if (cm & (1 << c)) district.byColor[c] = (district.byColor[c] || 0) + 1;
    }
    // 路线途经
    const hit = nearLine(g.mid[0], g.mid[1]);
    if (!hit.size) { missed++; return; }
    for (const r of hit) {
      routeTypes[r].typeMask |= tm;
      routeTypes[r].colorMask |= cm;
      routeTypes[r].hits++;
    }
  });

  const maskToArr = (m, dict, limit) => {
    const a = [];
    for (let b = 0; b <= limit; b++) if (m & (1 << b)) a.push({ code: b, label: dict[b] || String(b) });
    return a;
  };

  const out = {
    generatedAt: new Date().toISOString(),
    source: K.KD,
    passRadiusM: PASS_M,
    dict: { lineType: K.LINE_TYPE, lineColor: K.LINE_COLOR },
    totalDivider: divInfo.nrec,
    processed,
    district,
    routes: routeMeta.map((m, i) => ({
      key: m.key, street: m.street, idx: m.idx, distKm: m.distKm,
      hits: routeTypes[i].hits,
      types: maskToArr(routeTypes[i].typeMask, K.LINE_TYPE, 31),
      colors: maskToArr(routeTypes[i].colorMask, K.LINE_COLOR, 7),
    })),
  };
  fs.writeFileSync(path.join(OUT, 'kuandeng_markings.json'), JSON.stringify(out));

  // ---------- 6) 摘要 ----------
  const inDistTypes = Object.keys(district.byType).map(Number).sort((a, b) => a - b);
  const paintTypes = inDistTypes.filter((t) => K.PAINTED.has(t));
  console.log(`\nDIVIDER 处理 ${processed}/${divInfo.nrec} 条`);
  console.log(`区内 ${district.dividers} 条（面画标线 ${district.painted} · 物理边界/护栏墙 ${district.physical}）`);
  console.log(`  区内出现线型码 ${inDistTypes.length} 种（规格书定义 1–17 共 17 种）· 其中面画标线码 ${paintTypes.length} 种`);
  console.log(`  线型分布 ${JSON.stringify(Object.fromEntries(inDistTypes.map((t) => [K.LINE_TYPE[t] || t, district.byType[t]])))}`);  console.log(`  颜色分布 ${JSON.stringify(Object.fromEntries(Object.entries(district.byColor).map(([c, v]) => [K.LINE_COLOR[c] || c, v])))}`);
  const uTypes = new Set();
  for (const r of out.routes) for (const t of r.types) uTypes.add(t.code);
  console.log(`\n排班路线合计触达 ${uTypes.size} 种线型 / ${[...uTypes].sort((a, b) => a - b).map((t) => K.LINE_TYPE[t]).join('、')}`);
  const sample = out.routes.filter((r) => r.hits > 0).slice(0, 5);
  console.log('逐线样例：');
  for (const r of sample) console.log(`  ${r.key} · 途经标线 ${r.hits} 条 · ${r.types.length} 种线型 · ${r.colors.map((c) => c.label).join('/')}`);
  console.log(`\nout/kuandeng_markings.json 已写出`);
}

main();
