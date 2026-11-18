# AGENTS.md — 惠城区 ODD 覆盖 + 路测排班报告流水线（AI 必读）

> 本工程职责（2026-10-27 整理后收敛为单一职责）：为「惠城区（441302，18 街道/镇）」生成自动驾驶 ODD 地图要素覆盖与路测排班报告。纯 Node 脚本 + 静态 HTML 产物，无框架、无 npm 依赖。
> 川行致远测试环境自动化已移出本工程，手册见 skill：`cx-test-route-automation`。

## 1. 交付物（out/ 下仅此 4 个 HTML 为交付页）

| 文件 | 生成器 |
|---|---|
| `out/odd_coverage.html` | `build_odd_coverage_html.js` |
| `out/scenario_tests.html` | `build_scenario_html.js` |
| `out/report_alloc.json` | `build_report_alloc.js`（仅产出排班总账快照，不生成 HTML 报告） |

⛔ 不要在 out/ 留手动另存的报告副本（没有生成器、永不更新）。审计脚本 `audit_data.js` 的 H 段会 FAIL 这种文件。
历史交付快照只在 `交付_2026-10-17_v6/`（唯一保留的最新交付目录）。

## 2. 生成链（改完必须按序重跑）

```
fetch_osm.js / fetch_amap_*.js / fetch_congestion.js / fetch_routes.js / fetch_kuandeng_stoplines.js   ← ①取数（→ data/*.json，快照落地不删）
build_stats.js                                                                                          ← ②归属（18 街道 × 元素计数 → out/street_stats.json）
plan_routes_v2.js → plan_scenario_routes_v2.js → select_odd.js   ← ③规划（循环依赖：重规划后 select_odd 必须重跑，收敛已实测）
build_report_draft.js                    ← ④主报告 + 唯一快照 out/report_alloc.json
build_odd_quota.js → build_kuandeng_markings.js → check_stopline_signal.js
build_congestion.js → build_congestion_ref.js → build_congestion_streets.js
build_confidence.js → build_odd_dims.js → build_source_crosscheck.js → calibrate_osm.js → audit_coord.js
build_odd_checklist.js                   ← 读上游全部产物
build_odd_coverage_html.js → build_signal_heatmap.js → build_weather.js → build_scenario_html.js
audit_data.js                            ← ⑤终审，必须 0 失败
```

**三个非直觉点：**
1. `build_congestion*.js` / `build_confidence.js` / `build_odd_dims.js` / `build_source_crosscheck.js` / `calibrate_osm.js` / `audit_coord.js` 虽然文件日期较老，但其产物 JSON 仍被主链 / `audit_delivery.js` / `build_odd_checklist.js` 消费 —— 属于现行链，不可删。`report_draft.html` / `report_brief.html` 已停用。
2. 腿型是 `kind='loop'`（v2 起）：遍历 `routes[].routes[]` 统计里程必须认 `loop`，否则静默算 0km。
3. `select_odd.js` 与 `plan_routes_v2.js` 双向依赖，重规划后 `select_odd.js` 必须重跑（`build_report_draft.js` 有 >1km 即 throw 的护栏）。

## 3. 四条里程口径（唯一快照 `out/report_alloc.json`，衍生页禁止复算）

| 字段 | 值 | 含义 |
|---|---|---|
| `netCenterKm` | 3520.1 | 全区非高速路网中心线 |
| `netBidirKm` | 5490.1 | 双向行驶上限（「整个惠城区」口径） |
| `exhaustKm` | 5557 | 全量穷举 |
| `totalKm` | 2950 | 本排班 = 空间层 2357.4 + 场景加跑 592.2；≈19 天 / 108.7h，dayCount/hours 由它推出，禁止硬编码 |

## 4. 共享库（根目录 lib_*.js + 基础模块）

- `street_areas.js` — WGS84↔GCJ02 转换 + 18 街道点在多边形判定（唯一定义处）
- `scenarios.js` — 场景定义
- `amap_key.js` — 高德 key 管理（⚠️ 含密钥，对外共享前评估是否保留）
- `lib_kd_cover.js` / `lib_kuandeng.js` — 宽凳覆盖判定 / 宽凳 DBF/SHP 读取
- `lib_carrier_filter.js` / `lib_mileage_section.js` — 载体过滤 / 里程口径
- `chartjs.min.js` — 内嵌图表库（build 脚本读入后内联进 HTML）
- `tencent_route_link.js` — 腾讯驾车路径链接生成

## 5. 目录结构

```
data/    原始快照（OSM/高德/宽凳，落地不删，可离线重跑）
out/     中间产物 JSON + 4 份交付页 + _newestmap.sqlite（871MB 宽凳内网缓存库，离线复跑依赖，保留但不要进 git）
tools/   辅助脚本：audit_all_elements / build_carrier_report / plan_return_legs（被 audit_data.js 消费）
         + 宽凳诊断 Python（kd_*.py 等，需 python 环境 .venv-html-to-docx/）
docs/    宽凳交付元素清单、元素准确性标准
交付_2026-10-17_v6/   最新（唯一）历史交付快照
```

## 6. 铁律（违反过）

1. 判定口径先查表：凡需行人/车流感知、气象、自车状态的项一律 `out-of-scope`，绝不写 `not-fetched`（verdict 语义见 `odd-coverage-report-pipeline` skill 的 conventions）。
2. HTML 里不写思考过程，只留结论与可复核标签。
3. 合计行必须脚本 throw 校验，不靠人眼。
4. 同一事实只渲染一次、只有一个快照来源。
5. 汇总页内嵌单图页，改单图页后必须重跑 build_odd_coverage_html.js；交付页须含置信度章节。
6. **站序按 ODD 优先级排，折返是覆盖必需 —— 绝不用「省里程 / 消除折返」当优化判据。**
   背景：`select_odd.js` 的目标函数是「工况覆盖」（道路等级 × 元素类型 × 高危点位），
   不是里程。路线上那些看起来「东→西→东」的折返，是为了途经 ODD 元素锚点
   （学校/红绿灯/隧道/消防站…），135 条工况道路 / 407.8km 方向里程就是覆盖目标。
   `plan_routes_v2.js` 的 `nnOrder`/`twoOpt` 收到的是 target 对象而非 `[lon,lat]` 数组，
   `distM` 因此返回 NaN、排序与 2-opt 实际不生效 —— **这是既有行为，不是待修 bug**
   （2026-10-28 曾误"修"成地理最优站序：站间直线省 33%，但 ODD 覆盖顺序被打乱、
   交付图与平台路线全部失效）。真要优化顺序，必须把「ODD 元素覆盖达标」作为约束。


## 7. 运行环境（本机）

- node：`D:\installer\BDDZ\lightsandbox\node\node.exe`（bash 里 `export PATH="/d/installer/BDDZ/lightsandbox/node:$PATH"`）
- python：`.venv-html-to-docx/`
- bash 的 `ls/head/grep/find` 不可用 → 一律 node 一行脚本 + Read/Glob/Grep 工具；含反引号的 node -e 内容改走 Write 落成 .js
- 收尾：`audit_data.js` 必须 0 失败（当前 101 通过 / 0 失败 / 3 提示，提示为桌面旧副本与留档页，不算失败）
