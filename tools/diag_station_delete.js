// 诊断站点删不掉的原因：查 detail，试 supply 解绑后删
const { bj } = require('./bj_auth');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
(async () => {
  const box = { swLng: 114.0, swLat: 22.8, neLng: 115.0, neLat: 23.5 };
  const j2 = await bj('/route-plan/element/list', { ...box, elementTypes: ['STATION'] });
  const raw2 = j2.data;
  const sts = (Array.isArray(raw2) ? raw2 : (raw2 && (raw2.list || raw2.records)) || []).filter(x => (x.name || '').startsWith('PTV-区域测试-路线1'));
  for (const s of sts) {
    const d = await bj('/route-plan/station/detail?id=' + s.id, {});
    const det = d.data || {};
    console.log(s.name, 'strategyId=', det.strategyId, 'hdMapId=', det.hdMapId);
  }
})().catch(e => console.error('ERR', e.message));