// Shared scenario definitions + ranking, used by build_report.js (rendering)
// and fetch_routes.js (scenario route planning) so both agree on which street
// is "top" for each scenario.
//
// Each scenario is scored independently: metric values normalised to the max
// across streets, score = Σ(weight × norm) × 10.
const dens = (r, k) => (r[k] || 0) / r.roadKm;
const norm = (vals) => {
  const max = Math.max(...vals, 0);
  return vals.map((v) => (max > 0 ? v / max : 0));
};
const hotList = (r, ...keys) => keys
  .flatMap((k) => r.hotspots[k] || [])
  .slice(0, 3)
  .map((h) => `${h.name}(${h.count})`);

const SCENARIOS = [
  {
    key: 'rural', label: '乡村/县乡道路',
    note: '想测无信号灯的乡村道路、窄路会车与路口让行。指标按县乡道路里程占比打分。',
    metrics: [
      { label: '县乡道路km占比', w: 0.7, v: (r) => r.classKm.rural / r.roadKm, fmt: (r) => `县乡 ${r.classKm.rural}km` },
      { label: '半封闭道路密度', w: 0.3, v: (r) => dens(r, 'accessRoads'), fmt: (r) => `半封闭 ${r.accessRoads}` },
    ],
    hotspot: (r) => (r.hotspots.ruralRoads || []).map((h) => `${h.name} ${h.km}km`),
  },
  {
    key: 'school', label: '学校路段',
    note: '想测学校周边接送高峰、行人过街与红绿灯联动。',
    metrics: [
      { label: '学校密度', w: 0.7, v: (r) => dens(r, 'schools'), fmt: (r) => `学校 ${r.schools}` },
      { label: '红绿灯密度', w: 0.15, v: (r) => dens(r, 'signals'), fmt: (r) => `灯/km ${r.signalsPerKm}` },
      { label: '斑马线密度', w: 0.15, v: (r) => dens(r, 'crossings'), fmt: (r) => `斑马线 ${r.crossings}` },
    ],
    hotspot: (r) => hotList(r, 'schools'),
  },
  {
    key: 'tunnelBridge', label: '隧道/桥梁',
    note: '想测进出隧道的明暗切换、桥面横风与匝道并线。',
    metrics: [
      { label: '隧道密度', w: 0.6, v: (r) => dens(r, 'tunnels'), fmt: (r) => `隧道 ${r.tunnels}` },
      { label: '桥梁密度', w: 0.4, v: (r) => dens(r, 'bridges'), fmt: (r) => `桥梁 ${r.bridges}` },
    ],
    hotspot: (r) => hotList(r, 'tunnels', 'bridges'),
  },
  {
    key: 'tollway', label: '高速/收费站',
    note: '想测匝道汇入、收费站排队与ETC门架。按收费站/服务区数量打分（高速里程不进分母，仅参考）。',
    metrics: [
      { label: '收费站数量', w: 0.7, v: (r) => r.tolls, fmt: (r) => `收费站 ${r.tolls}` },
      { label: '服务区数量', w: 0.3, v: (r) => r.restAreas, fmt: (r) => `服务区 ${r.restAreas}` },
    ],
    hotspot: (r) => hotList(r, 'tolls'),
  },
  {
    key: 'busHub', label: '公交枢纽',
    note: '想测公交车频繁靠站、场站大车转弯与行人交织。',
    metrics: [
      { label: '公交站密度', w: 0.6, v: (r) => dens(r, 'busStops'), fmt: (r) => `公交站 ${r.busStops}` },
      { label: '公交场站数量', w: 0.4, v: (r) => r.busDepots, fmt: (r) => `场站 ${r.busDepots}` },
    ],
    hotspot: (r) => hotList(r, 'busDepots', 'busStops'),
  },
  {
    key: 'uTurn', label: '环岛/掉头',
    note: '想测环岛让行、多出口选择与掉头圈低速掉头。',
    metrics: [
      { label: '掉头圈密度', w: 0.6, v: (r) => dens(r, 'turning'), fmt: (r) => `掉头圈 ${r.turning}` },
      { label: '环岛密度', w: 0.4, v: (r) => dens(r, 'roundabout'), fmt: (r) => `环岛 ${r.roundabout}` },
    ],
    hotspot: (r) => hotList(r, 'turning', 'roundabout'),
  },
  {
    key: 'construction', label: '施工路段',
    note: '想测施工围挡、锥桶借道与临时车道线。',
    metrics: [
      { label: '施工密度', w: 1.0, v: (r) => dens(r, 'construction'), fmt: (r) => `施工 ${r.construction}` },
    ],
    hotspot: (r) => hotList(r, 'construction'),
  },
  {
    // 2026-10-17 新增：内部道路（园区/小区）场景。宽凳 OWNER_SHIP=2 共 3,086 条
    // （画布内 2,849），此前规划完全没覆盖——OSM service 类 1,736 条里只有 39 条
    // 有名字，能进"命名道路候选池"的内部道路几乎为零（选中仅 1 条）。
    // 指标用 classKm.service（OSM 命名内部路里程）+ 停车场/学校密度作园区代理。
    key: 'campus', label: '园区/小区内部道路',
    note: '想测园区/小区内部道路：窄路、减速让行、无信号灯路口、行人混行。数据底子用宽凳 OWNER_SHIP=2 内部道路真值。',
    metrics: [
      { label: '内部道路km占比', w: 0.4, v: (r) => r.classKm.service / r.roadKm, fmt: (r) => `内部 ${r.classKm.service}km` },
      { label: '停车场密度', w: 0.35, v: (r) => dens(r, 'parking'), fmt: (r) => `停车场 ${r.parking}` },
      { label: '学校密度', w: 0.25, v: (r) => dens(r, 'schools'), fmt: (r) => `学校 ${r.schools}` },
    ],
    hotspot: (r) => hotList(r, 'parking', 'schools'),
  },
  {
    // 2026-10-27 新增：低速慢行街区场景。生活街道（OSM highway=living_street，
    // 区内 297 条）与道闸/石墩（158 处）多在村巷、小区出入口——离主干道 100~500m，
    // 空间层主路串联天然覆盖不到（实测水口 110 处生活街道仅 4 处在路线 60m 内）。
    // 这两类本就是低速慢行工况（窄巷、门口起停），归场景专项兜底，不占空间层配额。
    key: 'slowPace', label: '低速慢行街区（生活街道/道闸）',
    note: '想测村巷窄路会车、小区门口道闸起停、人车混行。这类要素离主干道较远，空间层主路串联覆盖不到，用专项场景补测。',
    metrics: [
      { label: '生活街道密度', w: 0.6, v: (r) => dens(r, 'livingStreets'), fmt: (r) => `生活街道 ${r.livingStreets}` },
      { label: '道闸/石墩密度', w: 0.4, v: (r) => dens(r, 'barriers'), fmt: (r) => `道闸 ${r.barriers}` },
    ],
    hotspot: (r) => hotList(r, 'livingStreets', 'barriers'),
  },
];

function scenarioRank(sc, rows, n = 3) {
  const norms = sc.metrics.map((m) => norm(rows.map(m.v)));
  return rows
    .map((r, i) => ({
      r,
      score: +(sc.metrics.reduce((s, m, j) => s + m.w * norms[j][i], 0) * 10).toFixed(1),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

module.exports = { SCENARIOS, scenarioRank };
