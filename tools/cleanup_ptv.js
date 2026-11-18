// 清理平台旧版 PTV 路线与站点：route/delete?id= (POST query) + station/delete body {id}
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const TOKEN = fs.readFileSync(path.join(ROOT, 'token.txt'), 'utf8').trim();
const BJ = 'https://test-bluejet.cxzyuan.com/basic-api/aid-cscm/web-api';
const BJH = { 'Authorization': 'Bearer ' + TOKEN, 'X-User-Id': '2048', 'X-Customer-Host': 'test-bluejet.cxzyuan.com', 'Content-Type': 'application/json; charset=utf-8' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function bjPost(ep, body) {
  const r = await fetch(BJ + ep, { method: 'POST', headers: BJH, body: JSON.stringify(body) });
  return r.json();
}

(async () => {
  // 1. 删 PTV 路线
  let all = [], page = 1;
  while (true) {
    const d = await bjPost('/route-plan/route/list', { pageNum: page, pageSize: 100 });
    if (d.code !== 200 || !d.data || !d.data.list || !d.data.list.length) break;
    all = all.concat(d.data.list);
    if (all.length >= d.data.total) break;
    page++;
  }
  const ptvRoutes = all.filter(r => /PTV-区域测试/.test(r.name || ''));
  console.log('PTV routes to delete:', ptvRoutes.length);
  let rfail = 0;
  for (const r of ptvRoutes) {
    const d = await bjPost('/route-plan/route/delete?id=' + r.id, {});
    if (d.code !== 200) { rfail++; console.log('  FAIL route', r.id, r.name, d.msg); }
    await sleep(250);
  }
  console.log('routes deleted, fail=' + rfail);

  // 2. 删 PTV 站点
  let sall = [];
  page = 1;
  while (true) {
    const d = await bjPost('/strategy/station/list', { pageNum: page, pageSize: 200 });
    if (d.code !== 200 || !d.data || !d.data.length) break;
    sall = sall.concat(d.data);
    if (sall.length >= 600) break;
    page++;
  }
  const ptvStations = sall.filter(s => /PTV-区域测试/.test(s.stationName || ''));
  console.log('PTV stations to delete:', ptvStations.length);
  let sfail = 0;
  for (const s of ptvStations) {
    const d = await bjPost('/strategy/station/delete', { id: s.stationId });
    if (d.code !== 200) { sfail++; console.log('  FAIL station', s.stationId, s.stationName, d.msg); }
    await sleep(120);
  }
  console.log('stations deleted, fail=' + sfail);
  console.log('DONE');
})().catch(e => { console.error('FATAL', e); process.exit(1); });