// 批量上传 ODD 推荐路线：建站点 → 腾讯驾车路径 → 建路线（自驾模式）→ supply 绑客户
// 用法: node batch_upload_routes.js [startIdx] [endIdxExclusive]   （odd_plan.json 的索引，默认 0..41）
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const TOKEN = fs.readFileSync(path.join(ROOT, 'token.txt'), 'utf8').trim();
const STOKEN = fs.readFileSync(path.join(ROOT, 'supply_token.txt'), 'utf8').trim();
const PLAN = JSON.parse(fs.readFileSync(path.join(ROOT, 'odd_plan.json'), 'utf8'));
const AREA_ID = '2097889591933722625';
const CUSTOMER_ID = '2064209631114588161';
const TKEY = 'XXYBZ-OEHLM-HGF6Y-66PHP-APSIT-SWBFQ';

const BJ = 'https://test-bluejet.cxzyuan.com/basic-api/aid-cscm/web-api';
const SP = 'https://test-supply.cxzyuan.com/basic-api/admin-api';
const BJH = { 'Authorization': 'Bearer ' + TOKEN, 'X-User-Id': '2048', 'X-Customer-Host': 'test-bluejet.cxzyuan.com', 'Content-Type': 'application/json; charset=utf-8' };
const SPH = { 'Authorization': 'Bearer ' + STOKEN, 'tenant-id': '1', 'Content-Type': 'application/json; charset=utf-8' };

async function bjPost(ep, body) {
  const r = await fetch(BJ + ep, { method: 'POST', headers: BJH, body: JSON.stringify(body) });
  return r.json();
}
async function spPost(ep, body) {
  const r = await fetch(SP + ep, { method: 'POST', headers: SPH, body: JSON.stringify(body) });
  return r.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 已存在站点缓存（name→stationId），防重复
const existCache = {};

async function listExisting() {
  let page = 1, all = [];
  while (true) {
    const d = await bjPost('/strategy/station/list', { pageNum: page, pageSize: 100 });
    if (d.code !== 200 || !d.data || !d.data.length) break;
    all = all.concat(d.data);
    if (all.length >= (d.total || d.data.length)) break;
    page++;
  }
  all.forEach(s => { if (s.stationName) existCache[s.stationName] = s.stationId; });
  console.log('existing stations:', all.length);
}

async function saveStation(sname, lng, lat) {
  if (existCache[sname]) return existCache[sname];
  const payload = { name: sname, stationName: sname, line: [[lng, lat], [lng, lat]], areaId: AREA_ID, type: 101, bizType: null, stationId: null, heading: null, parkingPolygon: [] };
  const d = await bjPost('/strategy/station/save', payload);
  if (d.code === 200 && d.data && d.data.stationId) { existCache[sname] = d.data.stationId; return d.data.stationId; }
  // 假500：反查
  await sleep(800);
  const l = await bjPost('/strategy/station/list', { pageNum: 1, pageSize: 200 });
  const hit = (l.data || []).find(s => s.stationName === sname);
  if (hit) { existCache[sname] = hit.stationId; return hit.stationId; }
  throw new Error('save station fail: ' + sname + ' ' + JSON.stringify(d).slice(0, 120));
}

async function tencentRoute(p) {
  const from = p.start.lat + ',' + p.start.lng;
  const to = p.end.lat + ',' + p.end.lng;
  const wps = p.waypoints.map(w => w.lat + ',' + w.lng).join(';');
  const url = 'https://apis.map.qq.com/ws/direction/v1/driving/?from=' + from + '&to=' + to + (wps ? '&waypoints=' + wps : '') + '&key=' + TKEY;
  const r = await fetch(url);
  const j = await r.json();
  if (j.status !== 0) throw new Error('tencent ' + j.status + ' ' + j.message);
  const rt = j.result.routes[0];
  const raw = rt.polyline;
  const pts = [[raw[0], raw[1]]];
  for (let i = 2; i < raw.length; i += 2) {
    pts.push([+(pts[pts.length - 1][0] + raw[i] / 1e6).toFixed(6), +(pts[pts.length - 1][1] + raw[i + 1] / 1e6).toFixed(6)]);
  }
  return { routePath: pts.map(x => [x[1], x[0]]), distance: rt.distance, duration: rt.duration, routeInfo: JSON.stringify(j) };
}

async function createRoute(p) {
  const tr = await tencentRoute(p);
  const payload = {
    name: p.name, startStationId: existCache[p.stations[0].sname], endStationId: existCache[p.stations[p.stations.length - 1].sname],
    waypoints: p.waypoints, driveMode: 1, distance: tr.distance, duration: tr.duration,
    routePath: tr.routePath, routeInfo: tr.routeInfo,
  };
  const d = await bjPost('/route-plan/route/create', payload);
  if (d.code !== 200) throw new Error('route create fail ' + p.name + ' ' + JSON.stringify(d).slice(0, 150));
  return d.data;
}

async function bindAll(routeIdx, routeName) {
  // supply 侧查这批站点（按名字前缀 PTV-区域测试-标号N-）
  const p = PLAN[routeIdx];
  const prefix = 'PTV-区域测试-标号' + p.mark + '-';
  const vp = await spPost('/vehicle/operation-area-manage/getStationsByViewport', { neLat: 23.20, neLng: 114.60, swLat: 23.00, swLng: 114.30 });
  const hits = ((vp.data) || []).filter(s => s.name && s.name.startsWith(prefix));
  let bound = 0, miss = [];
  for (const s of hits) {
    const b = await spPost('/vehicle/operation-area-manage/updateStationCustomer', { stationId: s.id, customerIds: [CUSTOMER_ID] });
    if (b.code === 0) bound++; else miss.push(s.name);
    await sleep(200);
  }
  return { found: hits.length, bound, miss };
}

(async () => {
  const start = +(process.argv[2] || 0), end = +(process.argv[3] || PLAN.length);
  await listExisting();
  const log = [];
  for (let i = start; i < end; i++) {
    const p = PLAN[i];
    try {
      const ids = [];
      for (const st of p.stations) {
        const id = await saveStation(st.sname, st.lng, st.lat);
        ids.push(id);
        await sleep(300);
      }
      const rid = await createRoute(p);
      console.log('[' + p.mark + '] OK stations=' + ids.length + ' route=' + rid + ' ' + p.street + ' ' + p.rn);
      log.push({ mark: p.mark, ok: true, routeId: rid, stations: ids.length });
    } catch (e) {
      console.log('[' + p.mark + '] FAIL ' + e.message);
      log.push({ mark: p.mark, ok: false, err: e.message });
    }
    fs.writeFileSync(path.join(ROOT, 'batch_upload_log.json'), JSON.stringify(log, null, 1));
    await sleep(500);
  }
  console.log('DONE. ok=' + log.filter(x => x.ok).length + ' fail=' + log.filter(x => !x.ok).length);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
