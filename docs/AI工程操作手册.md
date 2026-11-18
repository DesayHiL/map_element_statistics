# 惠城区 ODD 路测排班工程：AI 操作手册

## 1. 这是什么工程

本工程为惠州市惠城区（行政区划代码 `441302`、18 个街道/镇）生成自动驾驶 ODD 覆盖和路测排班静态报告。

工程边界：

- Node.js 脚本 + 静态 HTML，无框架、无 npm 依赖。
- 主链关注地图要素覆盖、宽凳路网约束、ODD 场景路线、天气/弱网联动和交通局施工候选。
- 川行致远测试环境自动化不属于本工程。
- 当前交付页只有：`out/odd_coverage.html`、`out/scenario_tests.html`。
- `out/report_alloc.json` 是唯一排班总账快照，不是 HTML 报告。
- `report_draft.html`、`report_brief.html` 已停用，不得恢复生成。

开始任何修改前，先阅读根目录 `AGENTS.md` 和本手册；如果二者与用户当前明确要求冲突，以用户要求为准，并同步更新本手册。

## 2. 当前有效口径

排班总账必须读取 `out/report_alloc.json`，衍生页面不得自行重新计算总账。

当前快照（重新生成后可能变化，以 JSON 为准）：

| 字段 | 当前值 | 含义 |
|---|---:|---|
| `netCenterKm` | 3520.1 km | 全区非高速路网中心线 |
| `netBidirKm` | 5490.1 km | 全区双向行驶上限 |
| `exhaustKm` | 5612 km | 全量穷举参考 |
| `spatialKm` | 2731.3 km | 空间层，去程 + 返程实测 |
| `scenKm` | 652.4 km | 场景加跑，三时段折算 |
| `totalKm` | 3384 km | 本排班总账 |
| `dayCount` | 21 天 | 由总里程推导 |
| `hours` | 124.9 h | 由总里程推导 |

路线站序以 ODD 覆盖为目标。不得为了省直线距离或消除折返而重排站序；折返可能是覆盖学校、信号灯、隧道、消防站等锚点的必要条件。

## 3. 生成链

默认离线重建（使用现有 `data/` 快照和缓存）：

```powershell
$node = 'D:\installer\BDDZ\lightsandbox\node\node.exe'
& $node 'run_pipeline.js'
```

需要重新访问外部接口时才使用：

```powershell
& $node 'run_pipeline.js' --with-fetch
```

实际主链顺序：

```text
fetch_osm / fetch_amap_* / fetch_congestion / fetch_routes / fetch_kuandeng_stoplines
  → build_stats
  → plan_routes_v2 → plan_scenario_routes_v2 → select_odd
  → build_report_alloc
  → build_odd_quota → build_kuandeng_markings → check_stopline_signal
  → build_congestion → build_congestion_ref → build_congestion_streets
  → build_confidence → build_odd_dims → build_source_crosscheck
  → calibrate_osm → audit_coord → build_odd_checklist
  → build_odd_coverage_html → build_signal_heatmap → build_weather
  → tools/build_transport_road_works
  → tools/fetch_transport_region → tools/fetch_region_traffic
  → tools/verify_tunnels_amap
  → build_scenario_html
  → tools/audit_scenario_mileage → audit_delivery → audit_data
```

重规划后必须重新运行 `select_odd.js`，否则选路和覆盖快照可能不一致。返程路线由 `tools/plan_return_legs.js` 生成并写入 `out/route_return_legs.json`、`out/routes_return.json`；修改去程路线后要重新规划返程。

## 4. 数据来源和使用边界

### 4.1 地图与路线

- OSM：地图要素候选和道路标签。
- 高德：POI、拥堵/速度参考、天气、驾车算路和道路名核验。
- 宽凳：可执行路网约束；路线几何必须落在宽凳 ROAD_LINK 上。
- 腾讯链接：只用于导航链接呈现时的既定链接生成，不改变高德路线取数口径。

### 4.2 施工信息

施工信息只使用惠州市交通运输局公开的占用/挖掘城市道路计划：

- `tools/fetch_transport_region.js` 获取区域公告。
- `tools/build_transport_road_works.js` 形成 `out/transport_road_works.json`。
- 当前报告只展示“交通局计划施工候选路线”。
- 不使用 OSM `construction` 标签生成施工路线，也不把 OSM 施工标签写入场景报告。
- 公告计划不等于现场已施工；出车前必须人工确认。
- 没有权威来源的事故、封路、临时交通管制不得写入测试数据。

### 4.3 天气

天气只保留高德惠城区 4 日预报：

- `build_weather.js` 请求高德 `weatherInfo` 接口，城市代码 `441302`。
- 输出 `out/weather_forecast.json`，报告展示 4 天表格。
- 天气名称由报告统一规范为：晴、少云、多云、阴、小雨、中雨、大雨、暴雨、雷阵雨、小雪、中雪、大雪、雾霾等。
- 不再使用 14 日 Open-Meteo 数据，也不在报告中出现 14 日趋势。
- 天气仅用于短期场景触发参考；出车前仍需以实况和现场条件确认。

### 4.4 网络信号

弱网候选来自 `out/signal_weak_routes.json`，用于筛选路线附近弱网格。最终执行判定必须以 Cellular-Z 的现场 RSRP/SINR 实测为准，不能把预测网格当作实测。

## 5. 场景报告规则

`out/scenario_tests.html` 是执行导向页面，避免写内部推理过程，只保留结论、路线、时段和可复核来源。

当前规则：

- 高速/收费站属于 ODD 外参考，不生成测试场景卡。
- 施工只保留交通局计划施工候选路线。
- 隧道卡只保留执行提示：出车前确认入口、照明和可通行性；不要在场景页写 OSM 隧道核验过程、POI 命中名单或“结构 9”的内部解释。
- 天气和网络强度联动建议放在同一张顶部联动卡中。
- 场景卡无可执行路线时，不展示空卡；生成器自检必须报告无导航路线推荐点为 0。
- 场景加跑里程来自 `report_alloc.json`，当前为 652.4 km；不得在页面中手工硬编码另一套数字。

## 6. 修改后的最小验证

修改天气、施工、场景页面后至少运行：

```powershell
$node = 'D:\installer\BDDZ\lightsandbox\node\node.exe'
& $node 'build_weather.js'
& $node 'build_scenario_html.js'
& $node 'tools/audit_scenario_mileage.js'
& $node 'audit_delivery.js'
& $node 'audit_data.js'
```

验收要求：

- `audit_delivery.js` 为 `OK`。
- `tools/audit_scenario_mileage.js` 的 delta 为 `0km`。
- `audit_data.js` 失败数为 0；历史模板或非交付页提示可以是 warn，但不得新增失败。
- `out/scenario_tests.html` 不出现 `undefined`、`NaN`、旧天气源、OSM 施工路线、已停用报告名称。
- `out/odd_coverage.html` 与 `out/scenario_tests.html` 的总账必须和 `out/report_alloc.json` 同源。

## 7. 常见错误和禁止事项

1. 不要恢复 `report_draft.html`、`report_brief.html`。
2. 不要把 OSM 施工标签当成施工事实或施工路线来源。
3. 不要把高德 4 日预报写成实况，也不要把远期趋势写成确定天气。
4. 不要把没有来源的事故、封路、临时交通管制写入报告。
5. 不要为了减少里程修改 ODD 站序或删除折返。
6. 不要在衍生 HTML 中重新计算总账或复制第二份快照。
7. 不要删除 `data/` 原始快照、宽凳缓存或仍被审计/生成器消费的中间 JSON。
8. `amap_key.js` 含密钥；对外共享工程前必须检查是否需要脱敏。

## 8. 关键文件索引

| 文件 | 用途 |
|---|---|
| `AGENTS.md` | 当前工程硬性规则 |
| `run_pipeline.js` | 默认生成链入口 |
| `build_scenario_html.js` | 场景测试页生成器 |
| `build_odd_coverage_html.js` | ODD 覆盖页生成器 |
| `build_weather.js` | 高德 4 日天气快照 |
| `tools/fetch_transport_region.js` | 交通局区域公告检索 |
| `tools/build_transport_road_works.js` | 交通局施工候选整理 |
| `tools/fetch_region_traffic.js` | 区域交通接口探针 |
| `tools/audit_scenario_mileage.js` | 场景里程校核 |
| `audit_delivery.js` | 两份交付页快速审计 |
| `audit_data.js` | 全量数据终审 |
| `out/report_alloc.json` | 唯一排班总账快照 |
| `out/scenario_tests.html` | 场景测试交付页 |
| `out/odd_coverage.html` | ODD 覆盖交付页 |

## 9. 当前状态快照

最近一次确认状态：

- 高德天气：4 天，城市代码 `441302`。
- 交通局计划施工记录：35 条候选记录。
- 隧道明确命名项：高德核验结果仅作为内部交叉核验，不在场景报告展示名单。
- 场景报告：16 张场景卡；施工卡仅交通局来源。
- 场景里程：去程 163.2 km + 返程 163.0 km，三时段加跑 652.4 km。
- 交付总账：3384 km。

