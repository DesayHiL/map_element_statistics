// 验证本轮 12 个路口偏移涉及的路线（高德导航可行性）
const fs = require('fs');
const { nextKey } = require('./amap_key');
const odd = JSON.parse(fs.readFileSync('odd_plan.json', 'utf8'));
// 涉及街道：小金口1条、桥东3条(34.8/26.7/26.4)、桥西36.4、江北30.8/21.5、马安42.9、江南46/27.5、龙丰50.3、惠环50.1、水口29.1
const TARGETS = [[1, '路线1'], [4, '路线1'], [4, '路线2'], [4, '路线3'], [5, '路线1'], [6, '路线1'], [6, '路线2'], [10, '路线1'], [12, '路线1'], [12, '路线2'], [13, '路线1'], [14, '路线1'], [16, '路线2']];
const fmt = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function driveRoute(origin, waypoints, dest) {
  const qs = new URLSearchParams({ key: nextKey(), origin: fmt(origin), destination: fmt(dest), extensions: 'all', strategy: '3', output: 'json' });
  if (waypoints.length) qs.set('waypoints', waypoints.map(fmt).join(';'));
  for (let a = 0; a < 3; a++) {
    let j;
    try { const res = await fetch(`https://restapi.amap.com/v3/direction/driving?${qs}`, { signal: AbortSignal.timeout(30000) }); j = await res.json(); }
    catch (e) { await sleep(800); continue; }
    if (j.status === '1' && j.route && j.route.paths && j.route.paths.length) {
      const p = j.route.paths[0];
      return { distKm: +(Number(p.distance) / 1000).toFixed(1), durMin: Math.round(Number(p.duration) / 60) };
    }
    await sleep(700);
  }
  return null;
}
(async () => {
  for (const [mark, rn] of TARGETS) {
    const r = odd.find((x) => x.mark === mark && x.rn === rn);
    if (!r) { console.log(`标号${mark} ${rn}: 未找到`); continue; }
    const st = r.stations || [];
    const res = await driveRoute([st[0].lng, st[0].lat], st.slice(1, -1).map((s) => [s.lng, s.lat]).slice(0, 16), [st[st.length - 1].lng, st[st.length - 1].lat]);
    console.log(`标号${mark} ${rn} [${r.street}] ${st.length}站 → ${res ? '可行 ✓ ' + res.distKm + 'km/' + res.durMin + 'min' : '!! 规划失败'}`);
    await sleep(200);
  }
})();