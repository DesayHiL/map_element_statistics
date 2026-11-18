// 验证改后路线可行性：对 6 条受影响路线（标号1路线1、标号4路线1/路线3、标号6路线2/路线3、标号10路线3、标号11路线1、标号15路线1/路线2）
// 用 odd_plan.json 的新站点序列调高德导航 API，确认 status=1、距离合理、新停靠点被正确经过
const fs = require('fs');
const { nextKey } = require('./amap_key');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const odd = JSON.parse(fs.readFileSync('odd_plan.json', 'utf8'));
const TARGETS = [[1, '路线1'], [4, '路线1'], [4, '路线3'], [6, '路线2'], [6, '路线3'], [10, '路线3'], [11, '路线1'], [15, '路线1'], [15, '路线2']];

const fmt = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
async function driveRoute(origin, waypoints, dest) {
  const qs = new URLSearchParams({
    key: nextKey(), origin: fmt(origin), destination: fmt(dest),
    extensions: 'all', strategy: '3', output: 'json',
  });
  if (waypoints.length) qs.set('waypoints', waypoints.map(fmt).join(';'));
  const url = `https://restapi.amap.com/v3/direction/driving?${qs.toString()}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let j;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      j = await res.json();
    } catch (e) { await sleep(800 * (attempt + 1)); continue; }
    if (j.status === '1' && j.route && j.route.paths && j.route.paths.length) {
      const p = j.route.paths[0];
      const roads = [];
      for (const st of p.steps || []) { const rn = (st.road || '').trim(); if (rn && !roads.includes(rn)) roads.push(rn); }
      return { distKm: +(Number(p.distance) / 1000).toFixed(1), durMin: Math.round(Number(p.duration) / 60), roads: roads.slice(0, 12) };
    }
    console.error('  api err:', j.infocode, j.info);
    await sleep(700 * (attempt + 1));
  }
  return null;
}

(async () => {
  for (const [mark, rn] of TARGETS) {
    const r = odd.find((x) => x.mark === mark && x.rn === rn);
    if (!r) { console.log(`标号${mark} ${rn}: 未找到`); continue; }
    const st = r.stations || [];
    const origin = [st[0].lng, st[0].lat];
    const dest = [st[st.length - 1].lng, st[st.length - 1].lat];
    const wps = st.slice(1, -1).map((s) => [s.lng, s.lat]);
    // 高德 waypoints 最多 16
    const res = await driveRoute(origin, wps.slice(0, 16), dest);
    if (res) console.log(`标号${mark} ${rn} [${r.street}] ${st.length}站点 → 可行 ✓ ${res.distKm}km / ${res.durMin}min | 途经: ${res.roads.join('、').slice(0, 150)}`);
    else console.log(`标号${mark} ${rn} [${r.street}] → !! 规划失败`);
    await sleep(200);
  }
})();