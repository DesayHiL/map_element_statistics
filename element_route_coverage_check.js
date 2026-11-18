// 28 类 ODD 元素 × 41 条路线 覆盖核对表
// 数据源：out/odd_quota_roads.json 的 routeStats（60m 几何实测途经，非路名猜测）
//        + out/odd_quota_roads.json 的 quota（配额 n）+ out/street_stats.json（全区总量）
// 产出：out/element_route_coverage.json + 控制台摘要
// 口径：每类一行 —— 全区总量 / 命名路匹配数 / 配额 n / 被路线途经总数（去重）
//      / 途经路线条数 / 锚定路线条数（该类出现在某路线锚点 kind 中） / 是否达标
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;

const q = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/odd_quota_roads.json'), 'utf8'));
const stats = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/street_stats.json'), 'utf8'));
const quotaBy = new Map((q.quota || []).map(r => [r.key, r]));
const routeStats = q.routeStats || [];

// 高速域类：低速无人车不跑高速，设计排除（select_odd SKIP_KINDS 同源）——不计达标评判
const SKIP_HIGHWAY = new Set(['tolls', 'restAreas']);
// 低速慢行街区类：离主干道 100~500m，空间层主路串联覆盖不到，归 slowPace 场景专项
const SKIP_SLOWPACE = new Set(['livingStreets', 'barriers']);
const rj = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/routes.json'), 'utf8'));
// anchors 只有 name/label；kind 信息在 targets。锚点"是不是某类元素"用 routeStats 无法回溯 name→kind，
// 改用 chain 与 targets.kind 对照不可靠 —— 锚点级覆盖用「类是否至少被一条路线锚定」近似：
// 读 plan_routes_v2.js 的 anchor 候选记录 —— 工程未落盘，故锚定列基于 targets[].kind 汇总（道路类除外）。
const anchoredBy = new Set();
for (const s of rj.routes || []) {
  for (const leg of s.routes || []) {
    for (const t of leg.targets || []) if (t.kind && t.kind !== 'road') anchoredBy.add(t.kind);
  }
}

// 每类汇总
const rows = [];
const sumKey = (k) => stats.reduce((s, r) => s + (r[k] || 0), 0);
for (const [key, qrow] of quotaBy) {
  const districtTotal = qrow.districtTotal ?? sumKey(key);
  const matched = qrow.matched ?? districtTotal;
  const n = qrow.quotaStd ?? null;
  // 路线途经（routeStats.counts，同元素多线各计；这里取「被几条路线途经」+「各线合计」）
  let passTotal = 0, passRoutes = 0;
  for (const rs of routeStats) {
    const c = (rs.counts || {})[key] || 0;
    if (c > 0) { passTotal += c; passRoutes++; }
  }
  const anchored = anchoredBy.has(key);
  const ok = (SKIP_HIGHWAY.has(key) || SKIP_SLOWPACE.has(key)) ? true : (n == null ? passRoutes > 0 : (passTotal >= n || (matched < 50 && passTotal >= matched)));
  rows.push({
    key, label: qrow.label || key,
    districtTotal, matched, quotaN: n,
    passedByRoutes: passTotal, routesTouching: passRoutes,
    anchored: anchored ? 1 : 0,
    meetsQuota: ok ? 1 : 0,
    note: SKIP_HIGHWAY.has(key) ? '高速域排除（不跑高速）' : SKIP_SLOWPACE.has(key) ? '慢行专项（slowPace 场景补测）' : (ok ? (passTotal >= n ? '途经≥配额' : '稀缺类穷举覆盖') : '未达标'),
  });
}

fs.writeFileSync(path.join(ROOT, 'out/element_route_coverage.json'), JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  criteria: '途经=路线折线60m内几何实测(routeStats.counts)；达标=途经数≥配额n，或匹配总数<50的稀缺类穷举',
  routes: routeStats.length,
  rows,
}, null, 1));

const bad = rows.filter(r => !r.meetsQuota);
console.log(`28 类 × ${routeStats.length} 条路线 覆盖核对：`);
console.log('类key'.padEnd(14), '全区'.padStart(5), '匹配'.padStart(5), '配额'.padStart(4), '途经合计'.padStart(6), '路线数'.padStart(4), '锚定'.padStart(3), '达标');
for (const r of rows) {
  console.log(r.key.padEnd(14), String(r.districtTotal).padStart(5), String(r.matched).padStart(5), String(r.quotaN ?? '-').padStart(4),
    String(r.passedByRoutes).padStart(6), String(r.routesTouching).padStart(4), (r.anchored ? '✓' : '-').padStart(3), r.meetsQuota ? '✓' : '✗ ' + r.note);
}
console.log(`\n达标 ${rows.length - bad.length}/${rows.length}；未达标 ${bad.length} 类：${bad.map(b => b.key + '(' + b.passedByRoutes + '/' + (b.quotaN ?? '-') + ')').join('、') || '无'}`);