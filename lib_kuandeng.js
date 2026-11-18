// =============================================================================
// 宽凳（KuangDeng）高精地图真值 · 读取工具 —— 只读内网 UNC，不写源数据
// =============================================================================
// 数据位置来自 sim-simcore-sim_map_factory 的 compare 工具默认路径：
//   \\10.216.2.11\Common2\...\01_惠州市\...\AuditSpec\kxf\441302
//   441302 = 惠城区行政区划码。
//
// 交付图层（spec 见 sim-map 工程 .codex/feishu_spec.md）：
//   ROAD_LINK      路网 link：LANE_NUM 车道数 / LINK_TYPE 道路类型 / IS_BIDIR 双向
//   LANE           车道：LANE_TYPE 车道类型 / MAX_SPEED 限速 / TURN_TYPE 转向
//   DIVIDER(+)    车道边界线：DIVIDER_ATTR 给 LINE_TYPE(18 类) / LINE_COLOR(白黄)
//   STOPLINE       停止线：MARK_TYPE(停止/停车让行/减速让行/虚拟) / IS_LIGHT(灯控)
//
// 坐标系：宽凳 SHP = 真 WGS-84（度），与本工程 OSM 侧同框架，无需 GCJ 纠偏。
const fs = require('fs');

const KD = '//10.216.2.11/Common2/Data/24_小车数据/90_宽凳交付数据/01_宽凳矢量/01_城市数据/01_惠州市/01_input/惠州市错误问题修改-20260911/WGS84/AuditSpec/kxf/441302';

// ---------- DBF ----------
function dbfHeader(buf) {
  const nrec = buf.readUInt32LE(4), hsz = buf.readUInt16LE(8), rsz = buf.readUInt16LE(10);
  const flds = [];
  let off = 32;
  while (off < hsz) {
    if (buf[off] === 0x0d) break;
    flds.push({
      name: buf.slice(off, off + 11).toString('latin1').replace(/\0.*$/, ''),
      type: String.fromCharCode(buf[off + 11]),
      len: buf[off + 16],
      dec: buf[off + 17],
    });
    off += 32;
  }
  return { nrec, hsz, rsz, flds };
}
// 逐记录回调（不整表建对象数组，避免大表堆爆）
function dbfEach(buf, fn) {
  const { nrec, hsz, rsz, flds } = dbfHeader(buf);
  for (let i = 0; i < nrec; i++) {
    let q = hsz + i * rsz + 1;
    const r = {};
    for (const f of flds) { r[f.name] = buf.slice(q, q + f.len).toString('utf8').trim(); q += f.len; }
    fn(r, i);
  }
  return { nrec, hsz, rsz, flds };
}
function dbfAll(p) {
  const buf = fs.readFileSync(p);
  const recs = [];
  const meta = dbfEach(buf, (r) => recs.push(r));
  return { meta, recs };
}

// ---------- SHP ----------
const SHP_DBF = (p) => p.replace(/\.shp$/i, '.dbf');

function shpHeader(p) {
  const b = Buffer.alloc(100);
  const fd = fs.openSync(p, 'r'); fs.readSync(fd, b, 0, 100, 0); fs.closeSync(fd);
  return {
    shapeType: b.readInt32LE(32),
    xmin: b.readDoubleLE(36), ymin: b.readDoubleLE(44),
    xmax: b.readDoubleLE(52), ymax: b.readDoubleLE(60),
    bytes: fs.statSync(p).size,
  };
}

// 遍历记录：对 PolyLine(3)/PolyLineZ(13) 回调 {mid, lenM, np}；返回条数
// mid 取「按累计弧长折半」的点，比取中间顶点更贴近线中点。
function shpEachLine(buf, fn) {
  let off = 100, n = 0;
  const R = 6371008.8;
  while (off + 8 <= buf.length) {
    const len = buf.readInt32BE(off + 4) * 2;
    if (off + 8 + len > buf.length) break;
    const st = buf.readInt32LE(off + 8);
    if (st === 0) { off += 8 + len; continue; }
    const numParts = buf.readInt32LE(off + 44);
    const np = buf.readInt32LE(off + 48);
    const ptsOff = off + 52 + 4 * numParts;
    if ((st === 3 || st === 13 || st === 5) && np >= 1) {
      // 累计弧长 → 中点
      let total = 0;
      const d = new Array(np - 1);
      for (let i = 1; i < np; i++) {
        const x1 = buf.readDoubleLE(ptsOff + (i - 1) * 16), y1 = buf.readDoubleLE(ptsOff + (i - 1) * 16 + 8);
        const x2 = buf.readDoubleLE(ptsOff + i * 16), y2 = buf.readDoubleLE(ptsOff + i * 16 + 8);
        const dx = (x2 - x1) * Math.cos((((y1 + y2) / 2) * Math.PI) / 180) * 111320;
        const dy = (y2 - y1) * 110540;
        d[i - 1] = Math.hypot(dx, dy);
        total += d[i - 1];
      }
      let acc = 0, mi = 0;
      for (; mi < d.length; mi++) { if (acc + d[mi] >= total / 2) break; acc += d[mi]; }
      const mid = [
        buf.readDoubleLE(ptsOff + mi * 16),
        buf.readDoubleLE(ptsOff + mi * 16 + 8),
      ];
      fn({ mid, lenM: total, np }, n);
    } else if (st === 1 || st === 11) {
      fn({ mid: [buf.readDoubleLE(off + 12), buf.readDoubleLE(off + 20)], lenM: 0, np: 1 }, n);
    } else {
      fn(null, n);
    }
    off += 8 + len; n++;
  }
  return n;
}

// ---------- 枚举字典（与 .codex/feishu_spec.md 逐字对齐）----------
const LINE_TYPE = {
  0: '未调查', 1: '单虚线', 2: '双虚线', 3: '单实线', 4: '双实线',
  5: '左实右虚', 6: '左虚右实', 7: '虚拟边界', 8: '路面铺设',
  9: '路缘石', 10: '护栏', 11: '墙体', 12: '护栏+路面铺设', 13: '护栏+墙体',
  14: '护栏+单实线', 15: '护栏+单虚线', 16: '护栏+双实线', 17: '护栏+双虚线',
  // 规格书只列到 17，但实测全量 974,878 条属性段里存在 18（636 条）——不臆造含义，原样标注。
  18: '未定义(18)',
};
const LINE_COLOR = { 0: '未调查', 1: '白色', 2: '黄色' };
const MARK_TYPE = { 0: '未调查', 1: '停止线', 2: '停车让行线', 3: '减速让行线', 4: '虚拟停止线' };
const LANE_TYPE = {
  0: '未调查', 1: '机动车道', 4: '虚拟车道', 5: '左转待行区', 6: '直行待行区',
  7: '右转待行区', 9: '公交车道', 12: '非机动车道', 13: '右转专用道',
};
// 面画标线（真正「涂在路面上的线」）vs 物理边界（路缘石/护栏/墙体）
const PAINTED = new Set([1, 2, 3, 4, 5, 6, 7, 8, 14, 15, 16, 17]);
const PHYSICAL = new Set([9, 10, 11, 12, 13]);

module.exports = {
  KD, SHP_DBF, dbfHeader, dbfAll, dbfEach, shpHeader, shpEachLine,
  LINE_TYPE, LINE_COLOR, MARK_TYPE, LANE_TYPE, PAINTED, PHYSICAL,
};
