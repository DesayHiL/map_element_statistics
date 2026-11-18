// 全量重建 PTV：① 删旧路线+旧站点（所有 PTV-区域测试*）② 按 odd_plan.json 新命名建站点+路线 ③ supply 绑客户
// 新命名: 站点 PTV-区域测试-路线{gid}-{街道}-{起点|途径点k|终点}-POI ; 路线 PTV-区域测试-路线{gid}-{街道}
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const TOKEN = () => fs.readFileSync(path.join(ROOT, 'token.txt'), 'utf8').trim();
const STOKEN = () => fs.readFileSync(path.join(ROOT, 'supply_token.txt'), 'utf8').trim();
const PLAN = JSON.parse(fs.readFileSync(path.join(ROOT, 'odd_plan.json'), 'utf8'));
const AREA_ID = '2097889591933722625';
const CUSTOMER_ID = '2064209631114588161'; // 算法测试客户企业（2026-10-29 最终确认；2115632236650123266 重庆天天鲜面店已弃用）
const TKEY = 'XXYBZ-OEHLM-HGF6Y-66PHP-APSIT-SWBFQ';

const BJ = 'https://test-bluejet.cxzyuan.com/basic-api/aid-cscm/web-api';
const SP = 'https://test-supply.cxzyuan.com/basic-api/admin-api';
const BJH = () => ({ 'Authorization': 'Bearer ' + TOKEN(), 'X-User-Id': '2048', 'X-Customer-Host': 'test-bluejet.cxzyuan.com', 'Content-Type': 'application/json; charset=utf-8' });
const SPH = () => ({ 'Authorization': 'Bearer ' + STOKEN(), 'tenant-id': '1', 'Content-Type': 'application/json; charset=utf-8' });

async function bjPost(ep, body) {
  const r = await fetch(BJ + ep, { method: 'POST', headers: BJH(), body: JSON.stringify(body) });
  return r.json();
}
async function spPost(ep, body) {
  const r = await fetch(SP + ep, { method: 'POST', headers: SPH(), body: JSON.stringify(body) });
  return r.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 站点角色名: odd_plan sname 形如 PTV-区域测试-标号N-路线M-起点-POI
// 新名 = PTV-区域测试-路线{gid}-{街道}-{role}-POI
function newStationName(p, gid, sname) {
  const m = sname.match(/^PTV-区域测试-标号\d+-路线\d+-(.+)$/);
  const tail = m ? m[1] : sname; // 起点-POI / 途径点k-POI / 终点-POI
  return `PTV-区域测试-路线${gid}-${p.street}-${tail}`;
}

(async () => {
  const phase = process.argv[2] || 'all'; // clean | build | bind | all
  const log = [];
  const LOGF = path.join(ROOT, 'out', 'rebuild_ptv_v2_log.json');

  // ---- ① 清理 ----
  if (phase === 'clean' || phase === 'all') {
    let all = [], page = 1;
    while (true) {
      const d = await bjPost('/route-plan/route/list', { pageNum: page, pageSize: 100 });
      if (d.code !== 200 || !d.data || !d.data.list || !d.data.list.length) break;
      all = all.concat(d.data.list);
      if (all.length >= d.data.total) break;
      page++;
    }
    const ptvRoutes = all.filter(r => /PTV-区域测试/.test(r.name || ''));
    console.log('旧 PTV 路线待删:', ptvRoutes.length);
    for (const r of ptvRoutes) {
      const d = await bjPost('/route-plan/route/delete?id=' + r.id, {});
      if (d.code !== 200) console.log('  FAIL route', r.id, r.name, d.msg);
      await sleep(250);
    }
    console.log('路线删除完成');

    let sall = [], sPage = 1;
    while (true) {
      const d = await bjPost('/strategy/station/list', { pageNum: sPage, pageSize: 200 });
      if (d.code !== 200 || !d.data || !d.data.length) break;
      sall = sall.concat(d.data);
      if (sall.length >= (d.total || sall.length)) break;
      sPage++;
      if (sPage > 40) break;
    }
    const ptvStations = sall.filter(s => /PTV-区域测试/.test(s.stationName || ''));
    console.log('旧 PTV 站点待删:', ptvStations.length, '(平台总站点', sall.length, ')');
    let sfail = 0;
    for (const s of ptvStations) {
      const d = await bjPost('/strategy/station/delete', { id: s.stationId });
      if (d.code !== 200) { sfail++; if (sfail <= 10) console.log('  FAIL station', s.stationId, s.stationName, d.msg); }
      await sleep(120);
    }
    console.log('站点删除完成 fail=' + sfail);
    log.push({ phase: 'clean', routes: ptvRoutes.length, stations: ptvStations.length, fail: sfail });
    if (phase === 'clean') { fs.writeFileSync(LOGF, JSON.stringify(log, null, 1)); return; }
  }

  // ---- ② 建站点 + 建路线 ----
  if (phase === 'build' || phase === 'all') {
    const stCache = {}; // sname -> stationId
    async function saveStation(sname, lng, lat) {
      if (stCache[sname]) return stCache[sname];
      const payload = { name: sname, stationName: sname, line: [[lng, lat], [lng, lat]], areaId: AREA_ID, type: 101, bizType: null, stationId: null, heading: null, parkingPolygon: [] };
      const d = await bjPost('/strategy/station/save', payload);
      if (d.code === 200 && d.data && d.data.stationId) { stCache[sname] = d.data.stationId; return d.data.stationId; }
      await sleep(800);
      const l = await bjPost('/strategy/station/list', { pageNum: 1, pageSize: 200 });
      const hit = (l.data || []).find(s => s.stationName === sname);
      if (hit) { stCache[sname] = hit.stationId; return hit.stationId; }
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

    for (let i = 0; i < PLAN.length; i++) {
      const p = PLAN[i], gid = i + 1;
      const routeName = `PTV-区域测试-路线${gid}-${p.street}`;
      try {
        // 站点：新名（按新命名重建）
        const newStations = p.stations.map(st => ({ sname: newStationName(p, gid, st.sname), lng: st.lng, lat: st.lat }));
        for (const st of newStations) {
          await saveStation(st.sname, st.lng, st.lat);
          await sleep(250);
        }
        // 路线
        const tr = await tencentRoute({ start: p.start, end: p.end, waypoints: p.waypoints });
        const payload = {
          name: routeName,
          startStationId: stCache[newStations[0].sname], endStationId: stCache[newStations[newStations.length - 1].sname],
          waypoints: p.waypoints, driveMode: 1, distance: tr.distance, duration: tr.duration,
          routePath: tr.routePath, routeInfo: tr.routeInfo,
        };
        const d = await bjPost('/route-plan/route/create', payload);
        if (d.code !== 200) throw new Error('route create fail ' + JSON.stringify(d).slice(0, 150));
        console.log(`[路线${gid}] OK ${p.street} stations=${newStations.length} route=${d.data}`);
        log.push({ gid, street: p.street, ok: true, routeId: d.data, stations: newStations.length });
      } catch (e) {
        console.log(`[路线${gid}] FAIL ${p.street} ${e.message}`);
        log.push({ gid, street: p.street, ok: false, err: e.message });
      }
      fs.writeFileSync(LOGF, JSON.stringify(log, null, 1));
      await sleep(500);
    }
    fs.writeFileSync(path.join(ROOT, 'out', 'ptv_station_cache.json'), JSON.stringify(stCache, null, 1));
    if (phase === 'build') return;
  }

  // ---- ③ supply 绑客户 ----
  if (phase === 'bind' || phase === 'all') {
    const vp = await spPost('/vehicle/operation-area-manage/getStationsByViewport', { neLat: 23.20, neLng: 114.60, swLat: 23.00, swLng: 114.30 });
    const hits = ((vp.data) || []).filter(s => /PTV-区域测试-路线\d+-/.test(s.name || ''));
    console.log('supply 侧新命名站点:', hits.length);
    let bound = 0; const miss = [];
    for (const s of hits) {
      const b = await spPost('/vehicle/operation-area-manage/updateStationCustomer', { stationId: s.id, customerIds: [CUSTOMER_ID] });
      if (b.code === 0) bound++; else miss.push(s.name);
      await sleep(200);
    }
    console.log('绑定完成 bound=' + bound + ' miss=' + miss.length);
    if (miss.length) console.log(miss.slice(0, 10).join('\n'));
    log.push({ phase: 'bind', found: hits.length, bound, miss: miss.length });
  }
  fs.writeFileSync(LOGF, JSON.stringify(log, null, 1));
  console.log('DONE');
})().catch(e => { console.error('FATAL', e); process.exit(1); });