const fs = require('fs');
const path = require('path');
const rows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'huizhou_transport_road_works_2026Q4.json'), 'utf8').replace(/^\uFEFF/, ''));
const excelEpoch = Date.UTC(1899, 11, 30);
const items = rows.map(r => {
  const n = Number(r.startSerial);
  const startDate = Number.isFinite(n) ? new Date(excelEpoch + n * 86400000).toISOString().slice(0, 10) : null;
  return { ...r, startDate, sourceType: '交通局公开占挖计划', status: 'planned-not-field-confirmed' };
});
fs.writeFileSync(path.join(__dirname, '..', 'out', 'transport_road_works.json'), JSON.stringify({ source: '惠州市交通运输局', notice: '惠州市惠城中心区2026年第四季度占用、挖掘城市道路计划公示', noticeUrl: 'http://jtj.huizhou.gov.cn/zwgk/bmwj/tzgg/content/post_5865244.html', attachmentUrl: 'http://jtj.huizhou.gov.cn/attachment/0/365/365916/5865244.xlsx', rows: items }, null, 2));
console.log(`out/transport_road_works.json (${items.length} planned rows)`);
