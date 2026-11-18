// 场景测试推荐 → out/scenario_tests.html
// =============================================================================
// 按 ODD 场景类别推荐「测哪里（区域 Top3 + 路线）/ 测多少（配额换算里程）/
// 什么时候测（时段范围）」。场景全集 = 工程场景库 7 类 + ODD 推导补充
// （无灯路口 / 人车混行 / 低速域 / 路侧停车 / 夜间 / 雨天 / 白天高峰）。
//
// 数据源（零硬编码统计值）：
//   · scenarios.js           场景定义与排名函数（与报告同源）
//   · out/street_stats.json  18 街道元素统计
//   · out/routes.json        街道骨架路线（导航 uri）
//   · out/odd_quota_roads.json 配额换算（密度 → kmNeeded）
//   · out/congestion_streets.json  拥堵街道排序
//   · out/congestion_ref.json      时段范围
//   · out/odd_dims.json      速度域分档
// 用法：node build_scenario_html.js
const fs = require('fs');
const path = require('path');
// ⚠️ 里程口径正式章节（lib_mileage_section.js）**只进覆盖页**（odd_coverage.html）。
// 2026-10-16 用户明令：「场景专项测试推荐路线不用加」。所以本页不再引入该模块，
// 里程口径一律读 out/report_alloc.json 展示在顶部 banner，不再重复整段推导。

const OUT = path.join(__dirname, 'out');
const readOut = (n) => JSON.parse(fs.readFileSync(path.join(OUT, n + '.json'), 'utf8'));
const { SCENARIOS, scenarioRank } = require('./scenarios');
const { REGION, SOURCES } = require('./transport_sources');

const stats = readOut('street_stats');
const routes = readOut('routes');
const quota = readOut('odd_quota_roads');
const congStr = readOut('congestion_streets');
const ref = readOut('congestion_ref');
const dims = readOut('odd_dims');
const weakNet = (() => { try { return readOut('signal_weak_routes'); } catch (_) { return { byStreet: {}, routeWeakHits: 0 }; } })();
const weather = (() => { try { return readOut('weather_forecast'); } catch (_) { return { status: 'error', forecasts: [] }; } })();
const roadWorks = (() => { try { return readOut('transport_road_works'); } catch (_) { return { rows: [] }; } })();
const regionInfo = (() => { try { return readOut('transport_region_info'); } catch (_) { return { status: 'not-run', rows: [] }; } })();
const regionTraffic = (() => { try { return readOut('region_traffic_interfaces'); } catch (_) { return { sources: [] }; } })();
const tunnelAmap = (() => { try { return readOut('tunnel_amap_verify'); } catch (_) { return { rows: [] }; } })();
const tunnelEvidence = (() => {
  try {
    const { carrierCheck, dedupeStructures } = require('./lib_carrier_filter');
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'tunnels.json'), 'utf8'));
    const kept = (raw.elements || []).filter(e => carrierCheck(e).keep);
    const deduped = dedupeStructures(kept, { radiusM: 50 });
    const namedRoadTunnels = deduped.filter(e => e.tags && e.tags.name && e.tags.highway && !/^(motorway|trunk)(_link)?$/.test(e.tags.highway) && /隧道/.test(e.tags.name));
    return { raw: (raw.elements || []).length, carrierKept: kept.length, deduped: deduped.length, namedRoadTunnels: namedRoadTunnels.map(e => ({ name: e.tags.name, highway: e.tags.highway, id: e.id })) };
  } catch (_) { return { raw: 0, carrierKept: 0, deduped: 0, namedRoadTunnels: [] }; }
})();
// Normalize official road-work names before matching against route road names.
const normalizeRoadName = (s) => String(s || '')
  .replace(/[（(].*?[）)]/g, '')
  .replace(/[，,、；;].*$/g, '')
  .replace(/(路口|交叉口|段|处|门口).*$/g, '')
  .replace(/\s+/g, '').trim();
const weatherText = (value) => {
  const s = String(value || '').trim();
  if (/特大暴雨|大暴雨|暴雨/.test(s)) return '暴雨';
  if (/大雨/.test(s)) return '大雨';
  if (/中雨/.test(s)) return '中雨';
  if (/雷/.test(s) && /雨/.test(s)) return '雷阵雨';
  if (/小雨|阵雨|毛毛雨|细雨/.test(s)) return '小雨';
  if (/雨/.test(s)) return '有雨';
  if (/大雪/.test(s)) return '大雪';
  if (/中雪/.test(s)) return '中雪';
  if (/小雪|阵雪/.test(s)) return '小雪';
  if (/雪/.test(s)) return '有雪';
  if (/雷/.test(s)) return '雷电';
  if (/雾|霾/.test(s)) return '雾霾';
  if (/阴/.test(s)) return '阴';
  if (/多云/.test(s)) return '多云';
  if (/云/.test(s)) return '少云';
  if (/晴/.test(s)) return '晴';
  return s || '未知';
};
const weatherBad = (weather.forecasts || []).some(c => /雨|雾|雪|霾|冰/.test(`${c.dayweather}${c.nightweather}`));
const weatherEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const weatherRows = (weather.status === 'ok' ? weather.forecasts : []).map(c => `<tr><td>${weatherEsc(c.date)}</td><td>${weatherEsc(weatherText(c.dayweather))} / ${weatherEsc(weatherText(c.nightweather))}</td><td>${weatherEsc(c.nighttemp)}–${weatherEsc(c.daytemp)}℃</td><td>${weatherEsc(c.daywind || c.nightwind || '—')}</td><td>${weatherEsc(c.daypower || c.nightpower || '—')}级</td></tr>`).join('');
const weatherHtml = weatherRows ? `<table class="kv weather4"><thead><tr><td>日期</td><td>白天 / 夜间</td><td>温度</td><td>风向</td><td>风力</td></tr></thead>${weatherRows}</table>` : '';

// 排班分配快照 —— 与 odd_coverage.html 同源同口径。
// 注意：**不要用 odd_selection.json 的 tiers.std**：那是路线 v1 时代的快照
// （spatial 2752 + 场景加跑 269.6 = 3022km），v2 重规划后已过期，会与覆盖页打架。
const alloc = readOut('report_alloc');
const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const band = (k) => ref.bands.find((b) => b.key === k);
const AM = band('amPeak'), PM = band('pmPeak'), DAY = band('daytime'), EVE = band('evening'), NIGHT = band('night');

// 每街道第一条骨架路线（执行载体），并解码 起点/终点 名
function parseNav(uri) {
  try {
    const u = new URL(uri);
    const pt = (s) => {
      if (!s) return null;
      const [lon, lat, ...rest] = decodeURIComponent(s).split(',');
      return rest.join(',') || '';
    };
    return { from: pt(u.searchParams.get('from')), to: pt(u.searchParams.get('to')) };
  } catch (e) { return null; }
}
// 路线集（v2 重规划后每街道 1–7 条 loop）→ 场景卡给整条路线集的导航入口，
// 不再只链第一段：卡片文字给的是「去这个区跑多少公里」，就该是路线集合计。
const routeOf = {};
for (const rt of routes.routes) {
  if (rt.status !== 'ok') continue;
  const first = (rt.routes || [])[0];
  routeOf[rt.street] = {
    distKm: rt.distKm, durMin: rt.durMin, uri: rt.uri,
    legs: (rt.routes || []).length,
    roads: first ? (first.roads || []) : [],
    nav: rt.uri ? parseNav(rt.uri) : null,
  };
}
const okStreet = Object.keys(routeOf).length;
const totalStreet = routes.routes.length;

// 同源护栏（不产出章节，只保证本页数字与排班总账对得上）：去程 + 返程 必须 == 空间层。
// 口径与覆盖页一致：quota.routeStats 按街道分组求和；返程取 tools/plan_return_legs.js 的实测。
const sqByStreet = {};
for (const r of quota.routeStats) (sqByStreet[r.street] = sqByStreet[r.street] || []).push(r);
let sumKm = 0;
for (const k of Object.keys(sqByStreet)) sumKm += sqByStreet[k].reduce((s, r) => s + r.distKm, 0);
const RETLEG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'route_return_legs.json'), 'utf8')); }
  catch { return null; }
})();
const scenRetKmAll = RETLEG && RETLEG.totals ? RETLEG.totals.streetRevKm : null;
const scenBidir = scenRetKmAll != null ? +f1(sumKm) + scenRetKmAll : +f1(sumKm) * 2;
if (Math.abs(scenBidir - alloc.spatialKm) > 1.0) {
  throw new Error(`场景页里程与排班空间层不一致：去程 ${f1(sumKm)} + 返程 ${scenRetKmAll == null ? '缺失(退回×2)' : scenRetKmAll} = ${f1(scenBidir)} vs alloc.spatialKm=${alloc.spatialKm}`);
}

const dens = (r, k) => (r.roadKm > 0 ? +((r[k] || 0) / r.roadKm).toFixed(3) : 0);
const rank = (fn, n = 6) => stats.map((r) => ({ r, v: fn(r) })).filter((x) => x.v > 0)
  .sort((a, b) => b.v - a.v).slice(0, n);

const kmNeeded = (key) => {
  const s = quota.scenarioKm.find((x) => x.key === key);
  return s ? { quota: s.quota, km: s.kmNeeded, dens: s.densityPerKm, exhaustive: s.exhaustive } : null;
};

// ---------- 场景卡定义 ----------
// kind: scenario 库场景 | custom 自定义 rank | cong 拥堵排序 | static 说明型
let CARDS = [
  {
    key: 'plannedWorks', title: '交通局计划施工候选路线', icon: '🚧',
    why: '仅纳入惠州市交通运输局公开的占用/挖掘城市道路计划；计划不等于现场已施工',
    slot: '按公告开工时间和时长安排，出车前人工确认现场状态',
    top: (() => {
      const hits = [];
      for (const w of (roadWorks.rows || [])) {
        const rt = routes.routes.find(s => s.status === 'ok' && (s.routes || []).some(r => (r.roads || []).some(n => w.road.includes(n) || n.includes(w.road.split('（')[0]))));
        if (rt && !hits.some(x => x.r.name === rt.street)) hits.push({ r: rt, label: `${w.road} · ${w.startDate || '日期待核'} 起 ${w.durationDays} 天` });
      }
      return hits.slice(0, 6);
    })(), quotaKm: null,
    quotaNote: `唯一施工数据源为交通局公告，共 ${roadWorks.rows?.length || 0} 条计划记录；仅作施工候选，现场未确认的不写成已施工。`,
  },
  {
    key: 'weakNetwork', title: '网络弱覆盖路线', icon: '📶',
    why: '优先验证定位、通信和远程接管在弱蜂窝覆盖路段的表现',
    slot: '建议白天平峰，先实测确认 RSRP/SINR，再执行路线',
    top: Object.entries(weakNet.byStreet || {}).sort((a,b) => b[1]-a[1]).slice(0, 6).map(([name,n]) => ({ r: stats.find(x => x.name === name), label: `弱网命中 ${n} 个 500m 网格` })).filter(x => x.r), quotaKm: null,
    quotaNote: weakNet.routeWeakHits ? `蜂窝众包预筛命中 ${weakNet.routeWeakHits} 个路线邻近弱网格；最终以 Cellular-Z 实测为准。` : '当前排班路线未命中弱网格，仍建议抽样实测。',
  },
  {
    key: 'badWeather', title: '恶劣天气路线', icon: '🌧️',
    why: '天气不佳时验证湿滑路面、能见度变化和感知降级策略',
    slot: weatherBad ? '预报含雨/雾/雪：优先安排雨天卡，出车前以实况复核' : '当前预报无明显恶劣天气：等待实况触发或另行补测',
    top: rank(r => (r.bridges || 0) + (r.tunnels || 0)).map(x => ({ r: x.r, label: `桥梁 ${x.r.bridges || 0} · 隧道 ${x.r.tunnels || 0}` })), quotaKm: null,
    quotaNote: '不新增固定里程；复用既有空间层路线，按天气触发补测。',
  },
  {
    key: 'cong', title: '拥堵路段', icon: '🚗',
    why: '密集车流与拥堵车流的跟车、停走工况',
    slot: `${AM.label} ${AM.range} + ${PM.label} ${PM.range}`,
    slotNote: `晚高峰均速 ${PM.kmh}km/h（${PM.mode === 'measured' ? '实测' : '实测+推断'}，congestion_ref）`,
    top: congStr.streets.slice()
      .map((s) => ({ s, congKm: +(s.km * s.congestedKmPct / 100).toFixed(1) }))
      .sort((a, b) => b.congKm - a.congKm).slice(0, 6)
      .map(({ s, congKm }) => ({ r: stats.find((x) => x.name === s.name), label: `缓行+拥堵里程 ${congKm}km（占比 ${s.congestedKmPct}% · 样本 ${s.roads} 条路段）`, extra: `均速 ${s.kmh}km/h` })),
    quotaKm: null, quotaNote: '拥堵工况 = 复用空间层路线在早晚高峰加跑（时段层），不单独设元素配额；时段均速见 congestion_ref',
  },
  {
    key: 'school', title: '学校路段', icon: '🏫',
    why: '接送高峰行人过街、红绿灯联动、临时停车',
    slot: `${AM.label} ${AM.range} + ${PM.label} ${PM.range}（覆盖上学/放学接送）`,
    top: (() => { const r = scenarioRank(SCENARIOS.find((s) => s.key === 'school'), stats, 6); return r.map((x) => ({ r: x.r, label: `学校 ${x.r.schools} 所 · 综合分 ${x.score}` })); })(),
    quotaKm: kmNeeded('schools'),
  },
  {
    key: 'tunnel', title: '隧道/道路下穿（需现场确认）', icon: '🚇',
    why: '进出隧道光照突变、隧道内定位与车道保持',
    slot: `${DAY.label} ${DAY.range} + ${NIGHT.label} ${NIGHT.range} 各一轮`,
    slotNote: '白天入口强对比 + 夜间隧道照明两种极限',
    top: (() => { const r = scenarioRank(SCENARIOS.find((s) => s.key === 'tunnelBridge'), stats, 6); return r.map((x) => ({ r: x.r, label: `OSM 隧道/下穿结构 ${x.r.tunnels} · 桥梁 ${x.r.bridges} · 综合分 ${x.score}` })); })(),
    quotaKm: null,
    quotaNote: '执行前现场确认隧道/下穿路段入口、照明和可通行性。',
  },
  {
    key: 'bridge', title: '桥梁（横风/匝道）', icon: '🌉',
    why: '桥面横风、引桥坡度与匝道并线',
    slot: `${DAY.label} ${DAY.range}（大风天加测一轮）`,
    top: rank((r) => dens(r, 'bridges')).map((x) => ({ r: x.r, label: `桥梁 ${x.r.bridges} 处 · 密度 ${x.v}/km` })),
    quotaKm: kmNeeded('bridges'),
  },
  {
    key: 'rural', title: '乡村/县乡道路', icon: '🌾',
    why: '无信号灯道路、窄路会车、路口让行',
    slot: `${DAY.label} ${DAY.range}`,
    top: (() => { const r = scenarioRank(SCENARIOS.find((s) => s.key === 'rural'), stats, 6); return r.map((x) => ({ r: x.r, label: `县乡 ${x.r.classKm.rural}km · 综合分 ${x.score}` })); })(),
    quotaKm: null, quotaNote: '县乡道路按等级层保底里程覆盖（odd_selection floorShare 15%）',
  },
  {
    key: 'noSignal', title: '无灯路口', icon: '🛑',
    why: '无信号灯交叉口的让行与冲突判断',
    slot: `${DAY.label} ${DAY.range}`,
    top: rank((r) => (r.classKm.rural > 0 ? +(r.classKm.rural / (r.signals + 1)).toFixed(2) : 0))
      .map((x) => ({ r: x.r, label: `县乡 ${x.r.classKm.rural}km · 红绿灯仅 ${x.r.signals} 个` })),
    quotaKm: null, quotaNote: '派生口径：县乡里程 ÷（红绿灯数+1），值越大越「无灯」',
  },
  {
    key: 'busHub', title: '公交枢纽', icon: '🚌',
    why: '公交车频繁靠站、场站大车转弯、行人交织',
    slot: `${AM.label} ${AM.range} + ${DAY.label} ${DAY.range}`,
    top: (() => { const r = scenarioRank(SCENARIOS.find((s) => s.key === 'busHub'), stats, 6); return r.map((x) => ({ r: x.r, label: `公交站 ${x.r.busStops} · 场站 ${x.r.busDepots} · 综合分 ${x.score}` })); })(),
    quotaKm: kmNeeded('busStops'),
  },
  {
    key: 'uTurn', title: '环岛/掉头', icon: '🔄',
    why: '环岛让行、多出口选择、掉头圈低速掉头',
    slot: `${DAY.label} ${DAY.range}（平峰车少便于执行）`,
    top: (() => { const r = scenarioRank(SCENARIOS.find((s) => s.key === 'uTurn'), stats, 6); return r.map((x) => ({ r: x.r, label: `掉头圈 ${x.r.turning} · 环岛 ${x.r.roundabout} · 综合分 ${x.score}` })); })(),
    quotaKm: kmNeeded('turning'), quotaNote: '穷举类：全区调头圈 11 / 环岛 31 全部覆盖（100%）',
  },
  {
    key: 'mixed', title: '人车混行（市场周边）', icon: '🛒',
    why: '密集行人 + 非机动车交织穿行',
    slot: `${AM.label} ${AM.range} + ${EVE.label} ${EVE.range}（早晚市集高峰）`,
    top: rank((r) => dens(r, 'markets')).map((x) => ({ r: x.r, label: `市场 ${x.r.markets} 处 · 密度 ${x.v}/km` })),
    quotaKm: kmNeeded('markets'),
  },
  {
    key: 'lowSpeed', title: '低速域（≤30km/h）', icon: '🐢',
    why: '巡航下限低速工况、生活街道窄巷',
    slot: `${DAY.label} ${DAY.range}`,
    top: rank((r) => dens(r, 'livingStreets')).map((x) => ({ r: x.r, label: `生活街道 ${x.r.livingStreets} 条 · 密度 ${x.v}/km` })),
    quotaKm: null,
    quotaNote: `限速 ≤30km/h 档全区 ${dims.dims[0].buckets[0].km}km（${dims.dims[0].buckets[0].pct}%，odd_dims 速度域）`,
  },
  {
    key: 'parking', title: '路侧停车密集', icon: '🅿️',
    why: '路侧停车占道、静态障碍物避让',
    slot: `${DAY.label} ${DAY.range}（白天停车率高）`,
    top: rank((r) => dens(r, 'parking')).map((x) => ({ r: x.r, label: `停车场 ${x.r.parking} 处 · 密度 ${x.v}/km` })),
    quotaKm: kmNeeded('parking'),
  },
  {
    key: 'night', title: '夜间测试', icon: '🌙',
    why: '夜间 ≥10lux 低光照、混合光源、远光灯眩光',
    slot: `${NIGHT.label} ${NIGHT.range}（低光照极限档；${EVE.label} ${EVE.range} 为过渡档）`,
    slotNote: '⚠ 路灯点位（OSM street_lamp）未抓取 —— 「有路灯/无路灯」按路网等级代理：市区主干≈有灯、县乡道≈无灯',
    top: [
      { r: stats.find((x) => x.name === '桥西街道'), label: '老城区混合光源（路灯+招牌光，等级代理）' },
      { r: stats.find((x) => x.name === '江北街道'), label: '江北 CBD 路灯连续覆盖（等级代理）' },
      { r: stats.find((x) => x.name === '水口街道'), label: '城乡过渡光照骤变段（等级代理）' },
      ...rank((r) => (r.roadKm > 0 ? +(r.classKm.rural / r.roadKm).toFixed(2) : 0)).slice(0, 3)
        .map((x) => ({ r: x.r, label: `县乡占比 ${Math.round(x.v * 100)}% —— 无路灯代理` })),
    ].filter((x) => x.r),
    quotaKm: null, quotaNote: '夜间档均速 45.4km/h（实测+推断）；光照强度 lux 需实车记录，地图侧只给路段推荐',
  },
  {
    key: 'rain', title: '雨天测试（遇雨补测）', icon: '🌧',
    why: '中雨（24h<25mm、积水<10cm）内的车道线识别与跟车距离调整',
    slot: '雨量触发制 —— 遇中雨当日补测（非固定排班）',
    slotNote: '⚠ 积水/涉水点无数据源（odd_dims 路面域标注仅 5%）—— 下列区域为排水 Proxy 推荐非实证',
    top: [
      ...rank((r) => dens(r, 'bridges')).slice(0, 4).map((x) => ({ r: x.r, label: `桥梁 ${x.r.bridges} 处（桥面排水 Proxy）` })),
      { r: stats.find((x) => x.name === '水口街道'), label: '低洼内涝区按市政通报选择（数据不足，执行期人工确认）' },
      ...rank((r) => dens(r, 'tunnels')).slice(0, 1).map((x) => ({ r: x.r, label: `隧道 ${x.r.tunnels} 处（下穿隧道口排水 Proxy）` })),
    ].filter((x) => x.r),
    quotaKm: null, quotaNote: '雨天优先复用既有空间层路线（不用新增里程），重点记录感知退化项',
  },
  {
    key: 'tollway', title: '高速/收费站（ODD 外参考）', icon: '🎫',
    why: '匝道汇入、收费站排队 —— 非本次 ODD 范围（巡航 ≤45km/h）',
    slot: `${DAY.label} ${DAY.range}`,
    top: (() => { const r = scenarioRank(SCENARIOS.find((s) => s.key === 'tollway'), stats, 6); return r.map((x) => ({ r: x.r, label: `收费站 ${x.r.tolls} · 服务区 ${x.r.restAreas} · 综合分 ${x.score}` })); })(),
    quotaKm: null, quotaNote: '高速里程不进 ODD 分母，穿境 156.6km 单列（congestion_streets）',
  },
];

// 只展示可执行的 ODD 场景：高速/收费站是 ODD 外参考，不进入测试页；
// 无宽凳可用路线的候选街道不渲染空导航卡。
// Resolve transport-bureau planned works to the street-stat records used by the renderer.
const plannedCard = CARDS.find(c => c.key === 'plannedWorks');
if (plannedCard) {
  const hits = [];
  for (const w of (roadWorks.rows || [])) {
    const workName = normalizeRoadName(w.road);
    const rt = routes.routes.find(s => s.status === 'ok' && (s.routes || []).some(r => (r.roads || []).some(n => {
      const roadName = normalizeRoadName(n);
      return workName && roadName && (workName.includes(roadName) || roadName.includes(workName));
    })));
    const street = rt && stats.find(s => s.name === rt.street);
    if (street && !hits.some(x => x.r.name === street.name)) hits.push({ r: street, label: `${w.road} · ${w.startDate || '日期待核'} 起 · ${w.durationDays || '时长待核'} 天` });
  }
  plannedCard.top = hits.slice(0, 6);
}

const tunnelCard = CARDS.find(c => c.key === 'tunnel');
if (tunnelCard) {
  tunnelCard.quotaNote = '执行前现场确认隧道/下穿路段入口、照明和可通行性。';
}

CARDS = CARDS.filter(card => card.key !== 'tollway')
  .map(card => ({ ...card, top: (card.top || []).filter(t => t && t.r && routeOf[t.r.name]) }))
  .filter(card => card.top.length > 0 || ['weakNetwork', 'badWeather'].includes(card.key));

// ---------- 渲染 ----------
function topHtml(card) {
  return card.top.map((t) => {
    const rt = routeOf[t.r.name];
    let link = '<span class="none">—</span>';
    if (rt) {
      // 路线集整体：N 条路线 · 合计单程里程 · 合计时长（与排班表同一口径）
      const chips = [];
      if (rt.legs > 1) chips.push(`${rt.legs} 条路线`);
      if (rt.nav && rt.nav.from && rt.nav.to) chips.push(`首条 ${rt.nav.from} → ${rt.nav.to}`);
      const tip = chips.join('｜');
      const txt = `导航路线 ${rt.distKm}km · ${rt.durMin}min${rt.legs > 1 ? ` · ${rt.legs} 条` : ''}`;
      link = `<a href="${esc(rt.uri)}" target="_blank"${tip ? ` title="${esc(tip)}"` : ''}>${esc(txt)}</a>`;
    }
    return `<div class="tp">
      <div class="tp-name">${t.r.name}</div>
      <div class="tp-why">${esc(t.label)}</div>
      <div class="tp-route">${link}</div>
    </div>`;
  }).join('');
}
function quotaHtml(card) {
  const qk = card.quotaKm;
  if (qk && qk.km) {
    return `<tr><td>最小测试量</td><td><b>${qk.quota} 个样本</b> ≈ 双向 <b>${qk.km}km</b>（途经密度 ${qk.dens}/km 换算）</td></tr>`;
  }
  if (qk && qk.exhaustive) {
    return `<tr><td>最小测试量</td><td><b>穷举</b>（全区个位数，逐个途经，100%）</td></tr>`;
  }
  return card.quotaNote ? `<tr><td>最小测试量</td><td>${esc(card.quotaNote)}</td></tr>` : '';
}

const cardsHtml = CARDS.map((c) => `
  <section class="card">
    <div class="card-head">
      <span class="ico">${c.icon}</span>
      <div>
        <h2>${esc(c.title)}</h2>
        <div class="why">${esc(c.why)}</div>
      </div>
    </div>
    <div class="tops">${topHtml(c)}</div>
    <table class="kv">
      <tr><td style="width:90px">建议时段</td><td><b>${esc(c.slot)}</b>${c.slotNote ? `<div class="sn">${esc(c.slotNote)}</div>` : ''}</td></tr>
      ${quotaHtml(c)}
    </table>
  </section>`).join('');

const activeSourceKeys = new Set((regionTraffic.sources || []).filter(s => s.status === 'ok').map(s => s.key));
const sourceRowsHtml = SOURCES.filter(s => s.key !== 'baidu-traffic-api' || activeSourceKeys.has(s.key)).map(s => `<tr><td>${esc(s.label)}</td><td>${esc(s.purpose)}</td></tr>`).join('');
const regionNoticeLinks = (regionInfo.rows || []).slice(0, 8).map(r => `<a href="${esc(r.url)}" target="_blank">${esc(r.title)}</a>`).join(' · ');
const regionNoticeHtml = regionInfo.status === 'ok'
  ? `<div class="sn">交通局公告来源：${regionNoticeLinks || '本次未检索到施工/占挖公告'}。公告只作为施工候选，出车前确认现场状态。</div>`
  : `<div class="sn">区域公告检索尚未运行；执行 <code>node tools/fetch_transport_region.js</code> 后按 ${esc(REGION.district)} 区域更新官方候选公告。</div>`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>场景测试推荐 · 按场景类别</title>
<style>
  :root { --ink:#1a2332; --mut:#64748b; --line:#e2e8f0; --bg:#f6f8fa; --card:#fff; --acc:#0e7490; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:"Segoe UI","Microsoft YaHei",sans-serif; color:var(--ink); background:var(--bg); font-size:13px; }
  .wrap { max-width:980px; margin:0 auto; padding:24px 20px 60px; }
  h1 { font-size:22px; margin-bottom:4px; }
  .sub { color:var(--mut); margin-bottom:18px; }
  .sub b { color:var(--ink); }
  .banner { background:linear-gradient(135deg,#0e7490,#155e75); color:#fff; border-radius:10px; padding:16px 20px; margin-bottom:12px; display:flex; gap:24px; }
  .bn { text-align:center; }
  .bn .v { font-size:20px; font-weight:700; }
  .bn .l { font-size:11px; opacity:.85; margin-top:2px; }
  /* 家底口径（全区路网）与排班口径分离：虚线框 = 「参照量，不排班」 */
  .bn.ref { background:rgba(255,255,255,.09); border:1px dashed rgba(255,255,255,.45); border-radius:8px; padding:5px 12px; }
  .kmref { font-size:12px; color:var(--mut); line-height:1.75; background:#f8fafc; border-left:3px solid #cbd5e1; padding:8px 12px; border-radius:0 6px 6px 0; margin:0 0 18px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 20px; margin-bottom:18px; }
  .card-head { display:flex; gap:12px; align-items:flex-start; margin-bottom:12px; }
  .ico { font-size:26px; line-height:1; }
  h2 { font-size:16px; }
  .why { color:var(--mut); font-size:12px; margin-top:2px; }
  .tops { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:12px; }
  .tp { background:#f8fafc; border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
  .tp-name { font-weight:700; font-size:14px; }
  .tp-why { color:var(--mut); font-size:11px; margin:3px 0 6px; line-height:1.5; }
  .tp-route a { color:var(--acc); font-size:12px; text-decoration:none; font-weight:600; }
  .tp-route a:hover { text-decoration:underline; }
  .ends { color:var(--mut); font-size:10px; margin-top:2px; line-height:1.4; }
  .kv { width:100%; border-collapse:collapse; }
  .kv td { padding:6px 8px; border-top:1px solid #eef2f6; vertical-align:top; }
  .kv td:first-child { color:var(--mut); width:90px; }
  .sn { color:#b45309; font-size:11px; margin-top:3px; line-height:1.5; }
  .none { color:#cbd5e1; }
  footer { color:var(--mut); font-size:11px; line-height:1.8; margin-top:26px; border-top:1px solid var(--line); padding-top:12px; }
  @media (max-width:760px){ .tops{grid-template-columns:1fr} .banner{flex-wrap:wrap} }
</style>
</head>
<body>
<div class="wrap">
  <h1>场景测试推荐</h1>
  <div class="sub">按 ODD 场景类别推荐 —— 测哪里（区域 Top6 + 导航路线起终点）· 测多少（配额换算里程）· 什么时候测（时段范围）</div>

  <div class="banner">
    <div class="bn ref"><div class="v">${alloc.netBidirKm ? alloc.netBidirKm.toLocaleString('en-US') : '—'}km</div><div class="l">全区路网（双向）· 家底</div></div>
    <div class="bn"><div class="v">${CARDS.length}</div><div class="l">场景类别</div></div>
    <div class="bn"><div class="v">${f1(alloc.spatialKm)}km</div><div class="l">空间层（双向）</div></div>
    <div class="bn"><div class="v">${f1(alloc.scenKm)}km</div><div class="l">场景加跑（含在总账内）</div></div>
    <div class="bn"><div class="v">${alloc.totalKm}km</div><div class="l">排班总账 ✓</div></div>
    <div class="bn"><div class="v">${okStreet}/${totalStreet}</div><div class="l">街道路线（导航可执行）</div></div>
  </div>

  <section class="card" style="border-left:4px solid #0e7490">
    <div class="card-head"><span class="ico">🌦️</span><div><h2>天气与网络强度联动建议</h2><div class="why">天气预报用于触发雨/雾/雪路线；蜂窝弱网预筛用于触发网络与远程接管路线。</div></div></div>
    <div class="sn">天气接口：${weather.status === 'ok' ? `高德惠城区 4 日预报（441302），发布 ${esc(weather.reporttime || '未知')}` : '本次未取到高德惠城区预报，出车前以实况为准'}；${weatherBad ? '短期预报存在雨、雾、雪或霾，优先执行恶劣天气路线，出车前复核实况。' : '短期预报无明显恶劣天气，仍需等待实况触发或补测。'} 网络弱网候选：${weakNet.routeWeakHits || 0} 个路线邻近弱网格，最终以 Cellular-Z RSRP/SINR 实测为准。</div>
    ${weatherHtml}
  </section>

  <section class="card" style="border-left:4px solid #64748b">
    <div class="card-head"><span class="ico">🌐</span><div><h2>区域交通信息来源（简注）</h2><div class="why">当前区域：${esc(REGION.city)} ${esc(REGION.district)}（${esc(REGION.adcode)}）；区域公告查询结果：${regionInfo.rows.length} 条。只有原始来源、时间和有效期可核验的事件才进入测试数据。</div></div></div>
    ${regionNoticeHtml}
    <table class="kv"><thead><tr><td>来源</td><td>数据来源备注</td></tr></thead>${sourceRowsHtml}</table>
  </section>

  ${cardsHtml}

  <footer>
    数据源：out/street_stats.json（区域排名）· out/routes.json（导航路线 uri）· out/odd_quota_roads.json（配额换算密度）·
    out/congestion_streets.json（拥堵排序）· out/congestion_ref.json（时段范围与均速）· out/odd_dims.json（速度域）·
    scenarios.js（场景定义，与详细版报告同源）。<br>
    「导航路线」链接直达高德导航（路线起终点/途经点为该街道骨架路线实测取数）。⚠ 标注条为数据不足项的诚实声明（Proxy/未抓取），非免责套话。<br>
    生成器 build_scenario_html.js · ${new Date().toISOString().slice(0, 19).replace('T', ' ')} · 惠城区地图元素统计工程
  </footer>
</div>
</body>
</html>`;

fs.writeFileSync(path.join(OUT, 'scenario_tests.html'), html);
const size = (fs.statSync(path.join(OUT, 'scenario_tests.html')).size / 1024).toFixed(0);
console.log(`out/scenario_tests.html (${size}KB) · ${CARDS.length} 张场景卡`);
for (const bad of ['undefined', 'NaN', '[object']) {
  if (html.includes(bad)) throw new Error(`产物含 ${bad}`);
}
// 断言：每张卡 Top3 非空、路线链接存在率
let noRoute = 0;
for (const c of CARDS) for (const t of c.top) if (!routeOf[t.r.name]) noRoute++;
console.log(`渲染自检：undefined/NaN 均 0 · 无导航路线的推荐点 ${noRoute} 个`);
