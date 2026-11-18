// 区域交通接口探测器：只保存各来源原始响应/状态，不改写既有拥堵聚合结果。
// 用法：node tools/fetch_region_traffic.js
// 百度接口只有设置 BAIDU_AK 且权限开通后才会请求；否则记录 not-configured。
const fs = require('fs');
const path = require('path');
const { KEYS } = require('../amap_key');
const { REGION } = require('../transport_sources');

const OUT = path.join(__dirname, '..', 'out');
const result = { region: REGION, generated: new Date().toISOString(), sources: [] };
const save = (key, status, detail, raw) => result.sources.push({ key, status, detail, raw: raw || undefined });

(async () => {
  try {
    // 高德矩形接口单次范围有限，不能直接传整个惠城区；这里做代表性小矩形探针。
    // 全区覆盖继续由 fetch_congestion.js 的分块采样负责。
    const probeRect = '114.390,23.070;114.430,23.100';
    const url = `https://restapi.amap.com/v3/traffic/status/rectangle?level=5&rectangle=${probeRect}&key=${KEYS[0]}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    save('amap-traffic-status', j.status === '1' ? 'ok' : 'error', j.info || j.infocode, { status: j.status, infocode: j.infocode, probeRect, scope: '代表性小矩形；全区由 fetch_congestion.js 分块覆盖', evaluation: j.evaluation });
  } catch (e) { save('amap-traffic-status', 'error', String(e.message || e)); }

  const ak = process.env.BAIDU_AK;
  if (!ak) {
    save('baidu-traffic-api', 'not-configured', '未设置 BAIDU_AK；不写入场景路线');
  } else {
    try {
      const url = `https://api.map.baidu.com/traffic/v1/bound?bounds=114.09,22.86,114.58,23.25&ak=${encodeURIComponent(ak)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      save('baidu-traffic-api', j.status === 0 ? 'ok' : 'error', j.message || j.description || String(j.status), { status: j.status, roads: Array.isArray(j.road_traffic) ? j.road_traffic.length : 0 });
    } catch (e) { save('baidu-traffic-api', 'error', String(e.message || e)); }
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'region_traffic_interfaces.json'), JSON.stringify(result, null, 2));
  console.log(`region_traffic_interfaces.json: ${result.sources.map(s => `${s.key}=${s.status}`).join(', ')}`);
})().catch(e => { console.error(e); process.exit(1); });
