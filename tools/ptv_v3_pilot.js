// PTV v3 试点：切片策略建路线
// 策略：完整路线只建 起点站+终点站 2 个站点，原 ODD 途径点全部降为自由途径点（不停靠）；
//       按 ~10km 切片，切片边界站选「完整路径累计里程最接近 10k km」的原 ODD 途径点；
//       切片路线也只建边界站（起点站/切片点k/终点站 复用），切片内其余途径点为自由途径点。
//       每条路线同时建 正向 + 返程（站点复用，方向相反）。
// 用法: node ptv_v3_pilot.js [gid] [plan|build|bind|all]
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const TOKEN = () => fs.readFileSync(path.join(ROOT, 'token.txt'), 'utf8').trim();
const STOKEN = () => fs.readFileSync(path.join(ROOT, 'supply_token.txt'), 'utf8').trim();
const PLAN = JSON.parse(fs.readFileSync(path.join(ROOT, 'odd_plan.json'), 'utf8'));
const AREA_ID = '2097889591933722625';
const CUSTOMER_ID = '2064209631114588161';
const TKEY = 'XXYBZ-OEHLM-HGF6Y-66PHP-APSIT-SWBFQ';
const SLICE_KM = 10;
// 人工核验后的 snap 落点平移表：`${gid}:${k}` -> {lng,lat,note}（核验记录见脚本注释）
// 路线1 边界1 @10.3km 原 snap(114.439523,23.056443) 落在金山大道主路/三环立交匝道口 → 平移 28m 至「金山大道辅路南侧停车场」(高德卫星图+POI 核验 2026-11-12)
const SNAP_FIX = {
  '1:1': { lng: 114.439783, lat: 23.056361, note: '金山大道辅路南侧停车场' },
};

const BJ = 'https://test-bluejet.cxzyuan.com/basic-api/aid-cscm/web-api';
const SP = 'https://test-supply.cxzyuan.com/basic-api/admin-api';
const { bj: bjAuthPost } = require('./bj_auth'); // 401 自动重登
const BJH = () => ({ 'Authorization': 'Bearer ' + TOKEN(), 'X-User-Id': '2048', 'X-Customer-Host': 'test-bluejet.cxzyuan.com', 'Content-Type': 'application/json; charset=utf-8' });
const SPH = () => ({ 'Authorization': 'Bearer ' + STOKEN(), 'tenant-id': '1', 'Content-Type': 'application/json; charset=utf-8' });
async function bjPost(ep, body) { if (ep.startsWith('http')) { const r = await fetch(ep, { method: 'POST', headers: BJH(), body: JSON.stringify(body) }); return r.json(); } return bjAuthPost(ep, body); }
async function spPost(ep, body) { const r = await fetch(SP + ep, { method: 'POST', headers: SPH(), body: JSON.stringify(body) }); return r.json(); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 腾讯驾车规划：from/to 为 {lat,lng}，wps 为 [{lat,lng}]；返回解压后 routePath(lng,lat) + 累计里程数组
async function tencentRoute(from, to, wps) {
  const f = from.lat + ',' + from.lng, t = to.lat + ',' + to.lng;
  const w = (wps || []).map(x => x.lat + ',' + x.lng).join(';');
  const url = 'https://apis.map.qq.com/ws/direction/v1/driving/?from=' + f + '&to=' + t + (w ? '&waypoints=' + w : '') + '&key=' + TKEY;
  const r = await fetch(url); const j = await r.json();
  if (j.status !== 0) throw new Error('tencent ' + j.status + ' ' + j.message);
  const rt = j.result.routes[0]; const raw = rt.polyline;
  const pts = [[raw[0], raw[1]]];
  for (let i = 2; i < raw.length; i += 2) {
    pts.push([+(pts[pts.length - 1][0] + raw[i] / 1e6).toFixed(6), +(pts[pts.length - 1][1] + raw[i + 1] / 1e6).toFixed(6)]);
  }
  return { routePath: pts.map(x => [x[1], x[0]]), distance: rt.distance, duration: rt.duration, routeInfo: JSON.stringify(j), polyline: pts };
}
function havM(a, b) { // a,b = [lat,lng]
  const R = 6371000, d = x => x * Math.PI / 180;
  const dLat = d(b[0] - a[0]), dLng = d(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(d(a[0])) * Math.cos(d(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function cumKm(poly) { // poly: [[lat,lng]]
  const c = [0];
  for (let i = 1; i < poly.length; i++) c.push(c[i - 1] + havM(poly[i - 1], poly[i]) / 1000);
  return c;
}
// 求点在 polyline 上的投影里程（粗：最近顶点）
function projKm(poly, cum, p) {
  let best = 1e18, bi = 0;
  for (let i = 0; i < poly.length; i++) { const d = havM(poly[i], [p.lat, p.lng]); if (d < best) { best = d; bi = i; } }
  return { km: cum[bi], offM: best };
}

(async () => {
  const gid = +(process.argv[2] || 1);
  const phase = process.argv[3] || 'plan';
  const p = PLAN[gid - 1];
  // 命名规范（2026-11-12 用户定）：ptv-路线{gid}-{街道去"街道"后缀}；切片 -切片n/N；返程 -返程；返程切片 -返程n/N（不带"切片"二字）
  const streetShort = p.street.replace(/街道|镇$/, '');
  const baseName = `ptv-路线${gid}-${streetShort}`;
  const log = [];
  const LOGF = path.join(ROOT, 'out', `ptv_v3_pilot_route${gid}.json`);

  // ---- 全量完整路径（含全部途径点） ----
  console.log('拉取完整驾车路径（正向）...');
  const full = await tencentRoute(p.start, p.end, p.waypoints);
  const totalKm = full.distance / 1000;
  const cum = cumKm(full.polyline);
  console.log('总里程 ' + totalKm.toFixed(1) + ' km');

  // ---- 切片边界：固定 3 段（2026-11-12 用户定：无论里程都切 3 段，减少站点落在路口的不安全概率）----
  const N = 3;
  const wpProj = p.waypoints.map(w => projKm(full.polyline, cum, w));
  const boundaryPts = []; // {kind:'wp'|'snap', idx|km, lat,lng, km}
  const used = new Set();
  let lastKm = 0;
  for (let k = 1; k < N; k++) {
    const target = totalKm * k / N;
    let best = -1, bestCost = 1e18;
    wpProj.forEach((pr, i) => {
      if (used.has(i)) return;
      if (pr.km <= lastKm + 1 || pr.km >= totalKm - 1) return; // 保序 + 不贴起终点
      const cost = Math.abs(pr.km - target);
      if (cost <= 3000 / 1000 * 3 && cost < bestCost) { bestCost = cost; best = i; } // 容差 3km
    });
    if (best >= 0) {
      used.add(best); lastKm = wpProj[best].km;
      const w = p.waypoints[best];
      boundaryPts.push({ kind: 'wp', idx: best, lat: w.lat, lng: w.lng, km: wpProj[best].km });
    } else {
      // polyline 上精确打点
      let bi = 0; while (bi < cum.length && cum[bi] < target) bi++;
      const frac = (target - cum[bi - 1]) / (cum[bi] - cum[bi - 1] || 1);
      const lat = +(full.polyline[bi - 1][0] + (full.polyline[bi][0] - full.polyline[bi - 1][0]) * frac).toFixed(6);
      const lng = +(full.polyline[bi - 1][1] + (full.polyline[bi][1] - full.polyline[bi - 1][1]) * frac).toFixed(6);
      lastKm = target;
      const fix = SNAP_FIX[gid + ':' + k];
      boundaryPts.push({ kind: 'snap', km: target, lat: fix ? fix.lat : lat, lng: fix ? fix.lng : lng, fixed: !!fix, note: fix ? fix.note : '' });
    }
  }
  // 实际切片数 = boundaryPts.length + 1
  // 站点序列（完整路线 + 切片共用）：起点 + 各切片边界 + 终点
  const stationPts = [p.start, ...boundaryPts, p.end];
  const stationNames = stationPts.map((s, i) =>
    i === 0 ? `${baseName}-起点`
      : i === stationPts.length - 1 ? `${baseName}-终点`
        : `${baseName}-切片点${i}`);

  console.log(`切片方案: 总 ${totalKm.toFixed(1)}km → ${N} 段，${stationPts.length} 个站点`);
  boundaryPts.forEach((b, k) => console.log(`  边界${k + 1}: ${b.kind === 'wp' ? '途径点' + (b.idx + 1) : 'polyline打点'}@${b.km.toFixed(1)}km ${b.kind === 'snap' ? '(需卫星图核验) ' : ''}(${b.lng},${b.lat})`));
  // 各切片含内途径点：切片 i 含 picked 中位于其内的原途径点（snap 边界按 km 归属）
  const sliceWps = [];
  let prevKm = 0;
  for (let b = 0; b < boundaryPts.length + 1; b++) {
    const lo = b === 0 ? 0 : boundaryPts[b - 1].km;
    const hi = b === boundaryPts.length ? totalKm : boundaryPts[b].km;
    const w = p.waypoints.filter((w2, i) => !used.has(i) && wpProj[i].km > lo + 0.5 && wpProj[i].km < hi - 0.5);
    sliceWps.push(w);
  }
  sliceWps.forEach((w, i) => console.log(`  切片${i + 1}/${N}: 站点${i}→站点${i + 1}, 内部自由途径点 ${w.length} 个`));
  log.push({ gid, street: p.street, totalKm: +totalKm.toFixed(1), slices: N, stations: stationPts.length, boundaryPts, sliceWps: sliceWps.map(w => w.length) });
  if (phase === 'plan') { fs.writeFileSync(LOGF, JSON.stringify(log, null, 1)); return; }

  // ---- build：建站点 + 正/返完整路线 + 切片路线 ----
  if (phase === 'build' || phase === 'all') {
    const stCache = {};
    // 2026-11-12 确认：route/create 只认 route-plan elementId；直接调 /route-plan/station/create（{name,lng,lat} number）即返回雪花 elementId
    async function saveStation(sname, lng, lat) {
      if (stCache[sname]) return stCache[sname];
      const d = await bjPost('/route-plan/station/create', { name: sname, lng: +lng, lat: +lat });
      if (d.code === 200 && d.data) { stCache[sname] = d.data; return d.data; }
      // 重名兜底：element/list 已存在则复用
      const l = await bjPost('/route-plan/element/list', { swLng: lng - 0.01, swLat: lat - 0.01, neLng: lng + 0.01, neLat: lat + 0.01, elementTypes: ['STATION'] });
      const hit = ((l.data || {}).list || l.data || []).find(s => s.name === sname);
      if (hit) { stCache[sname] = hit.id; return hit.id; }
      throw new Error('save station fail: ' + sname + ' ' + JSON.stringify(d).slice(0, 150));
    }
    for (let i = 0; i < stationPts.length; i++) {
      await saveStation(stationNames[i], stationPts[i].lng, stationPts[i].lat);
      console.log('站点', stationNames[i], stCache[stationNames[i]]);
      await sleep(250);
    }
    async function createRoute(name, from, to, wps, sidA, sidB) {
      const tr = await tencentRoute(from, to, wps);
      const payload = { name, startStationId: sidA, endStationId: sidB, waypoints: wps, driveMode: 1, distance: tr.distance, duration: tr.duration, routePath: tr.routePath, routeInfo: tr.routeInfo };
      const d = await bjPost('/route-plan/route/create', payload);
      if (d.code !== 200) throw new Error('route create fail ' + name + ' ' + JSON.stringify(d).slice(0, 150));
      console.log(`路线 OK ${name} ${(tr.distance / 1000).toFixed(1)}km ${(tr.duration / 60).toFixed(0)}min id=${d.data}`);
      log.push({ name, id: d.data, km: +(tr.distance / 1000).toFixed(1) });
      await sleep(400);
    }
    // 正向完整
    await createRoute(baseName, p.start, p.end, p.waypoints, stCache[stationNames[0]], stCache[stationNames[N]]);
    // 正向切片
    for (let i = 0; i < N; i++) {
      await createRoute(`${baseName}-切片${i + 1}/${N}`, stationPts[i], stationPts[i + 1], sliceWps[i], stCache[stationNames[i]], stCache[stationNames[i + 1]]);
    }
    // 返程完整 + 返程切片（方向反转，切片顺序倒排；返程切片命名 -返程n/N 不带"切片"二字）
    const revWps = [...p.waypoints].reverse();
    await createRoute(`${baseName}-返程`, p.end, p.start, revWps, stCache[stationNames[N]], stCache[stationNames[0]]);
    for (let i = 0; i < N; i++) {
      const j = N - 1 - i; // 返程切片 i+1 = 正向切片 j+1 反向
      await createRoute(`${baseName}-返程${i + 1}/${N}`, stationPts[j + 1], stationPts[j], [...sliceWps[j]].reverse(), stCache[stationNames[j + 1]], stCache[stationNames[j]]);
    }
    fs.writeFileSync(path.join(ROOT, 'out', 'ptv_v3_station_cache.json'), JSON.stringify(stCache, null, 1));
    if (phase === 'build') { fs.writeFileSync(LOGF, JSON.stringify(log, null, 1)); return; }
  }

  // ---- bind：supply 绑客户 ----
  if (phase === 'bind' || phase === 'all') {
    await sleep(3000); // 等 bluejet→supply 同步
    const vp = await spPost('/vehicle/operation-area-manage/getStationsByViewport', { neLat: 23.30, neLng: 114.70, swLat: 22.90, swLng: 114.20 });
    const hits = ((vp.data) || []).filter(s => new RegExp('^' + baseName + '-').test(s.name || s.stationName || ''));
    console.log('supply 侧站点:', hits.length, '总:', (vp.data || []).length);
    let bound = 0; const miss = [];
    for (const s of hits) {
      const sid = s.id || s.stationId;
      const b = await spPost('/vehicle/operation-area-manage/updateStationCustomer', { stationId: sid, customerIds: [CUSTOMER_ID] });
      if (b.code === 0 || b.code === 200) bound++; else miss.push(s.name || s.stationName);
      await sleep(200);
    }
    console.log('绑定 bound=' + bound + ' miss=' + miss.length, miss.join(';'));
    log.push({ phase: 'bind', found: hits.length, bound, miss });
  }
  fs.writeFileSync(LOGF, JSON.stringify(log, null, 1));
  console.log('DONE');
})().catch(e => { console.error('FATAL', e); process.exit(1); });