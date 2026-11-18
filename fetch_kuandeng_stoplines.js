// =============================================================================
// 宽凳 STOPLINE → data/kuandeng_stoplines.json
// =============================================================================
// 背景：ODD 勾选表里「有灯路口停止线-信号灯距离 ≤60m」「停止线/鱼骨线/减速标线」
//      两项原先判为 not-fetched（没去找）。高德开放平台无此图层，OSM 也无标注；
//      第三数据源「宽凳高精地图真值」的 STOPLINE 图层直接提供，且有 IS_LIGHT
//      标志（是否受红绿灯控制）—— 正是配对信号灯算距离所需。
//
// 口径：
//   · 输出**不裁剪**，全区 11954 条全量落盘；街道归属交给 build_odd_quota.js 的
//     assign()（与其它 OSM 元素同一套 18 街道多边形），保证「区内」口径一致。
//   · 几何取折线**弧长中点**作为代表点（停止线短，1~6m，中点即路口处）。
//   · MARK_TYPE 只在 tags 里带标签，不做去重、不改任何数量。
//
// 只读内网 UNC；输出 data/kuandeng_stoplines.json。
const fs = require('fs');
const path = require('path');
const K = require('./lib_kuandeng');

function main() {
  if (!fs.existsSync(K.KD)) { console.error('UNC 不可达:', K.KD); process.exit(1); }

  const dbfBuf = fs.readFileSync(path.join(K.KD, 'STOPLINE.dbf'));
  const attrs = [];
  const meta = K.dbfEach(dbfBuf, (r) => attrs.push(r));
  console.log(`STOPLINE.dbf ${meta.nrec} 条 · 字段 ${meta.flds.map((f) => f.name).join(',')}`);

  const shpBuf = fs.readFileSync(path.join(K.KD, 'STOPLINE.shp'));
  const hdr = K.shpHeader(path.join(K.KD, 'STOPLINE.shp'));
  console.log(`STOPLINE.shp type=${hdr.shapeType} bbox lon[${hdr.xmin.toFixed(4)},${hdr.xmax.toFixed(4)}] lat[${hdr.ymin.toFixed(4)},${hdr.ymax.toFixed(4)}]`);

  const elements = [];
  let noGeom = 0;
  const n = K.shpEachLine(shpBuf, (g, i) => {
    const a = attrs[i];
    if (!a) return;
    if (!g) { noGeom++; return; }
    elements.push({
      type: 'node',
      id: Number(a.LINE_ID),
      lat: +g.mid[1].toFixed(7),
      lon: +g.mid[0].toFixed(7),
      tags: {
        kuandeng: 'stopline',
        mark_type: a.MARK_TYPE,
        mark_type_label: K.MARK_TYPE[a.MARK_TYPE] || a.MARK_TYPE,
        is_light: a.IS_LIGHT,
        light_label: a.IS_LIGHT === '1' ? '受红绿灯控制' : '不受红绿灯控制',
        len_m: +g.lenM.toFixed(2),
        has_lane: a.LANE_ID ? 'yes' : 'no',
      },
    });
  });
  if (n !== meta.nrec) console.log(`⚠ shp 记录 ${n} ≠ dbf 记录 ${meta.nrec}`);

  const tally = (rs, k) => rs.reduce((m, r) => (m[r[k]] = (m[r[k]] || 0) + 1, m), {});
  const byMark = tally(attrs, 'MARK_TYPE');
  const byLight = tally(attrs, 'IS_LIGHT');
  const lightStop = attrs.filter((r) => r.MARK_TYPE === '1' && r.IS_LIGHT === '1').length;

  const out = {
    version: 0.6,
    generator: 'fetch_kuandeng_stoplines.js',
    source: K.KD,
    fetchedAt: new Date().toISOString(),
    crs: 'WGS-84',
    note: '宽凳高精地图 441302(惠城区) 交付 STOPLINE 图层；几何取折线弧长中点；未按街道裁剪。',
    summary: {
      total: meta.nrec,
      withGeometry: elements.length,
      noGeometry: noGeom,
      byMarkType: byMark,
      byMarkTypeLabel: Object.fromEntries(Object.entries(byMark).map(([k, v]) => [K.MARK_TYPE[k] || k, v])),
      byIsLight: byLight,
      lightControlledStopLine: lightStop,
    },
    elements,
  };
  fs.writeFileSync(path.join(__dirname, 'data', 'kuandeng_stoplines.json'), JSON.stringify(out));
  console.log(`\n落盘 data/kuandeng_stoplines.json · ${elements.length} 个点`);
  console.log(`  MARK_TYPE ${JSON.stringify(byMark)} → ${JSON.stringify(out.summary.byMarkTypeLabel)}`);
  console.log(`  IS_LIGHT  ${JSON.stringify(byLight)}（1=受红绿灯控制）→ 灯控停止线 ${lightStop} 条`);
}

main();
