# ODD 按需专项路线规划 — 完整运行包

> 自包含说明文档。任何 AI / 工程师读完本文即可在 `D:\workspace\map_element_statistics` 工程上，按用户需求（测学校/测隧道/测施工等 28 类 ODD 元素之一）规划一条驾车专项测试路线，产出高德导航 URI 与途经命中报告。

---

## 0. 一句话目标

用户给出要测的元素类型（如"测学校"），从工程真实元素数据中取点，按「最少里程覆盖最多目标元素」规划驾车路线，输出：
- 高德导航 URI（手机可直接点开）
- 路线里程 / 耗时 / 途经元素命中数报告
- （可选）腾讯端最小途经点方案

---

## 1. 环境安装

### 1.1 Node.js（必须）

工程无 node_modules 依赖，任何 Node ≥ 14 即可。本机指定解释器：

```
D:/installer/BDDZ/lightsandbox/node/node.exe
```

验证：

```
D:/installer/BDDZ/lightsandbox/node/node.exe -v
```

若在别的机器上：装任意 Node LTS，把下文所有命令中的解释器路径替换为 `node` 即可。脚本只用内置模块（fs/path/https/zlib），**无需 npm install**。

### 1.2 网络与密钥

- 高德开放平台 Web 服务 key 池：工程内 `amap_key.js`（导出 `nextKey()` / `fetchJSON()`）。无 key 无法调 driving API。
- 高德 driving v3 API：`https://restapi.amap.com/v3/direction/driving`
- 若需腾讯端一致性：跑 `tools/tencent_route_minwp.js`（脚本内含腾讯 key 逻辑）。

### 1.3 坐标系约定（最重要，混算必错）

| 数据 | 坐标系 |
|---|---|
| 高德 POI（data/amap_*.json）、高德/腾讯 API | GCJ-02 |
| OSM 元素（data/tunnels.json 等）、宽凳真值 | WGS-84 |

转换函数：`require('./street_areas.js')` 的 `gcj2wgs` / `wgs2gcj`。规划前**统一转 WGS-84**，调高德 API 时再转回 GCJ-02。

---

## 2. 数据与工具清单（全部在 D:\workspace\map_element_statistics）

### 2.1 元素点位数据（data/ 目录，134 个 json）

| 类别 | 文件 | 说明 |
|---|---|---|
| 高德 POI（GCJ-02，location 为 "lng,lat" 字符串） | `data/amap_schools.json`（700 条）、`amap_hospitals.json`、`amap_fire_stations.json`、`amap_police_stations.json`、`amap_bus_stops.json`、`amap_charging.json`、`amap_fuel.json`、`amap_parking.json`、`amap_markets.json`、`amap_tolls.json`、`amap_ramps.json`、`amap_interchanges.json`、`amap_service_areas.json`、`amap_roadattach.json` | 结构 `{pois:[{location:"lng,lat", name, type, ...}]}` |
| OSM 元素（WGS-84） | `data/tunnels.json`、`bridges.json`、`footbridges.json`、`signals.json`、`crossings.json`、`rail_crossings.json`、`roundabout.json`、`traffic_calming.json`、`construction.json`、`hospitals.json`、`schools.json`、`rest_areas.json`、`barriers.json`、`bus_stops.json`、`charging.json`、`tolls.json`、`fuel.json`、`parking.json`、`markets.json`、`living_streets.json`、`oneway.json`、`maxspeed.json`、`lanes.json`、`surface_geom.json` 等 | 元素带几何/坐标点 |
| 街道几何 | `data/boundaries_geom.json`、`data/huicheng_geom.json`、`data/hc_subnames.json` | 惠城区 18 街道 |

### 2.2 统计口径

- `out/odd_quota_roads.json` — **28 类元素的配额总账**：`quota` 数组每项 `{key, label, districtTotal, matched, quotaStd(139), quotaBasic(35), selectedGot, ci}`；`selected` 数组是街道×道路明细。**选点数量先查这里，别拍脑袋。**

### 2.3 工具脚本（工程根目录）

| 脚本 | 用途 | 关键导出/参考点 |
|---|---|---|
| `street_areas.js` | 18 街道多边形 + 坐标转换 | `loadAreas()`、`pointInPolygon`、`gcj2wgs`、`wgs2gcj` |
| `amap_key.js` | 高德 key 池轮询 | `nextKey()`、`fetchJSON()` |
| `plan_routes_v2.js` | 排序与 URI 模板 | `nnOrder`（贪心最近邻）、`twoOpt`、`amapUri` |
| `build_odd_quota.js` | 途经命中判定口径 | densify（折线 40m 加密）+ nearLine（元素距折线 ≤60m 计途经；学校/医院放宽 100m，因 POI 标的是校园中心） |
| `lib_kd_cover.js` | 宽凳走廊闸门 | `KD.nearestDevWGS` ≤80m（目标点离真值路网太远会被规划出无路可走的线） |
| `tools/tencent_route_minwp.js` | 腾讯端最小途经点收敛 | 锚点 locked；avgDev≤60m + 里程差≤5% 判与高德一致 |

---

## 3. 规划流程（七步）

1. **取目标点**
   读对应 `data/*.json` → 坐标统一转 WGS-84 → 用户限定了街道/区域则用 `street_areas.js` 的 pointInPolygon 过滤；没限定则全区。

2. **选点**
   数量 n：用户说了用用户的；没说按置信度配额 n=139 或类内 matched 总数取小（查 `out/odd_quota_roads.json`）。空间打散——贪心最近邻顺序即可，无需聚类。

3. **排序**
   贪心 NN + 2-opt（参考 plan_routes_v2.js 的 nnOrder/twoOpt），起点选离基地最近的点。

4. **分组**
   高德单线途经点上限 16 → 点多时按 LEG_MAX_PTS=9 切多条腿；单线直线里程预算 16km，超了切下一条。

5. **规划**
   高德 v3 driving API（key 池 nextKey/fetchJSON）。waypoints 用**分号 `;` 分隔**，格式 "纬度,经度"（v3 是 lat,lng 顺序）。产出 distKm / durMin / poly。

6. **产出**
   - 高德导航 URI（plan_routes_v2.js 的 amapUri，uri_amp 直接可点）
   - 腾讯端一致（可选）：跑 tools/tencent_route_minwp.js

7. **报告**
   点数、里程、耗时、途经元素命中数（build_odd_quota.js 的 densify+nearLine 口径：折线 40m 加密、元素距折线 ≤60m 计途经；学校/医院放宽 100m）。

---

## 4. 校验闸门与口径

- **走廊闸门**：目标点须离真值路网近（KD.nearestDevWGS ≤80m），否则规划出无路可走的线。
- **学校/医院覆盖口径**：路过校门/周边 100m 即命中，**不是全量走访**。用户只要置信度达标，路过即可。
- **腾讯 polyline 解码**：数值对纬度在前，前向差分压缩 ÷1e6。

---

## 5. Common Mistakes（高频踩坑）

1. 高德 waypoints 用 `|` 分隔 → 规划成直达（**必须 `;`**）
2. 高德坐标序搞反（v3 driving 是 纬,经）
3. GCJ/WGS 忘转直接混算（高德/腾讯 GCJ-02，OSM/宽凳 WGS-84）
4. 给学校全量覆盖路线（用户只要置信度达标，路过即可）
5. 元素总量/配额不查 out/odd_quota_roads.json 拍脑袋定 n
6. 目标点不做走廊闸门检查，规划出无路可走的线

---

## 6. 使用边界

- 适用于：单类/少量类元素的**专项**测试路线
- 不适用于：全区排班重规划（走 odd-coverage-report-pipeline 流水线）、场景专项批量生成（plan_scenario_routes_v2.js）

## 7. 快速启动示例（伪代码骨架）

```js
// D:/installer/BDDZ/lightsandbox/node/node.exe plan_demand_route.js
const { loadAreas, pointInPolygon, gcj2wgs, wgs2gcj } = require('./street_areas.js');
const { nextKey, fetchJSON } = require('./amap_key.js');
const pois = require('./data/amap_schools.json').pois;
// 1. GCJ→WGS，pointInPolygon 过滤街道
// 2. 贪心 NN + twoOpt 排序（参考 plan_routes_v2.js）
// 3. 按 LEG_MAX_PTS=9 / 16km 切腿
// 4. fetchJSON(`https://restapi.amap.com/v3/direction/driving?...&origin=lat,lng&destination=lat,lng&waypoints=lat,lng;lat,lng&key=${nextKey()}`)
// 5. 产出 amapUri + densify/nearLine 命中报告（≤60m，学校/医院 100m）
```