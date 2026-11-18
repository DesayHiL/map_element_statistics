// Sample Amap realtime traffic status for Huicheng's major roads.
//
// 高德开放平台 Web 服务（restapi.amap.com/v3/traffic/status/*）**只返回实时快照**，
// 没有时间参数、没有历史查询（官方文档确认）。所以「每个时段的路段拥堵态势」有两条路：
//   1) 定时采样累积（本脚本）—— 免费但慢，必须跨时段多次运行；
//   2) 商务版历史路况接口回补（fetch_congestion_history.js）—— 一次补齐工作日各时段。
// 两条路产出的文件格式完全一致，build_congestion.js 会一起聚合。
//
// 采集质量约定（2026-09-29 二次修订，源于两次真实事故）：
//   · **整轮 0 个瓦片成功时不落盘** —— 空的 tiles:[] 文件会让报告的「采样次数」虚高。
//     历史上有 64 个这样的文件，已隔离到 data/_invalid/。
//   · **逐瓦片落盘检查点**（data/_partial/tile_<hash>.json）。2026-09-29 实测：73 点的
//     全量一轮会被限流 / 网络中断打断（有一次跑到第 14 个点进程直接被杀），非检查点式
//     写法把前面 13 个已完成的结果一起丢掉，重跑又撞同一堵墙。现在每个瓦片一拿到结果
//     就落盘，重跑自动跳过已终结（ok/empty）的瓦片，只补没采到的。
//     `AMAP_FRESH=1` 可忽略检查点强制重采。
//   · 瓦片级重试 3 次（退避 1.5s×n）：空返回多因限流/超时，重试比落一个空文件诚实。
//     重试仍为空 → 记为 `empty`（终态，不再重试）；抛错 → 记为 `error`（下轮还会再试）。
//   · 每次同时记录 response 的 evaluation（聚合拥堵指数）：expedite/congested/blocked
//     百分比 + 整体 status。路段条数受道路切分粗细影响，聚合百分比更稳健。
//   · **路段必须按 polyline 指纹去重**。高德返回的是**整条路的完整 polyline**（长深高速
//     94.5km 在十几个瓦片里长度一模一样），不按瓦片切分 → 同一路段会被多个瓦片重复返回。
//     实测事故：786 条记录实际只有 322 条不同路段，虚增里程 738.6km。
//   · **街道归属必须沿 polyline 逐点采样**，不能用「整条路的中点」。长穿境路的里程中点
//     会落到区外/邻街道 → 实测三栋镇 4/4 瓦片有数据却被整体判成「无数据」
//     （惠南大道 26.5km，中点 22.9356°N 已在三栋镇 bbox 之外）。
//   · 里程一律用**几何长度**（km），供"里程加权均速"使用 —— 数条数会让长干道与短支路等权。
//
// 用法：node fetch_congestion.js                       （circle 圆形网格，默认）
//       AMAP_TILE_MODE=rect node fetch_congestion.js   （矩形二分，需矩形配额）
//       AMAP_KEY=你的key node fetch_congestion.js      （单 key 覆盖）
//       AMAP_FRESH=1 node fetch_congestion.js          （忽略检查点，强制全量重采）
//       AMAP_BAND=18:00 node fetch_congestion.js       （显式指定时段桶，检查点随之换桶）
//
// 被打断也不怕：每个瓦片一采到就落盘到 data/_partial/，重跑自动补没采到的（见下）。
// 建议用「同一个 band 反复跑直到 tilesError 归零」的方式补齐一个时段：
//   node fetch_congestion.js && node fetch_congestion.js   # 第二轮只补上一轮 error 的瓦片
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// key 走统一密钥池（多 key 轮转 + 限流自动切换），见 amap_key.js
const { fetchJSON } = require('./amap_key');
const { loadAreas, bboxOf, pointInPolygon, gcj2wgs, wgs2gcj, assignStreetFactory } = require('./street_areas');

const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

// ---------- 逐瓦片检查点 ----------
// 每个瓦片的最终结果立刻写进 data/_partial/tile_<band>_<sha1(name)>.json，重跑时按
// （band, name）复用。**检查点必须带 band**：否则换一个时段再跑会把上一时段的数据
// 原样复用，报告里就凭空多出一份"夜间采样"——这是最危险的一类静默错误。
// 同一 (band, name) 只复用**终态**（ok / empty）；error 状态下一轮会重新请求。
// 有了 band 维度，多时段累积就是"不同 band 各跑一轮"，天然累加、互不覆盖。
const PARTIAL = path.join(DATA, '_partial');
fs.mkdirSync(PARTIAL, { recursive: true });
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const ckFile = (band, name) => path.join(PARTIAL, `tile_${String(band).replace(':', '-')}_${sha1(name).slice(0, 12)}.json`);

function loadPartials(band) {
  const m = new Map();
  for (const f of fs.readdirSync(PARTIAL)) {
    if (!f.endsWith('.json')) continue;
    if (!f.startsWith(`tile_${String(band).replace(':', '-')}_`)) continue; // 只认本时段的
    try {
      const j = JSON.parse(fs.readFileSync(path.join(PARTIAL, f), 'utf8'));
      if (j && j.name) m.set(j.name, j);
    } catch (e) { /* 半截文件（进程被杀时正在写）→ 忽略，下轮重采 */ }
  }
  return m;
}
function savePartial(rec) {
  const p = ckFile(rec.band, rec.name);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, p); // 原子替换：避免半截 JSON 被下一轮当成有效检查点
}

// ---------- 采样瓦片：全区 18 个街道 ----------
// 两种模式（AMAP_TILE_MODE=circle|rect，默认 circle）：
//   · circle —— 六边形网格铺圆，r=4500m。**当前默认**。
//     为什么换：rectangle 端点的免费日配额 2026-09-29 上午已用尽
//     （10044 USER_DAILY_QUERY_OVER_LIMIT，两把 key 都一样），而 circle 端点仍有额度；
//     且圆没有「对角线 ≤10km」的硬约束，布点更自由、用更少的请求覆盖全区。
//     半径实测（2026-09-29 桥东中心）：1000→36 段、2000→104、3000→169、4000→214、
//     4500→223，**5000 反而只回 36 段** —— 5000 是退化档（等同不传半径），上限用 4500。
//   · rect —— 每街道外接框递归二分到对角线 ≤9km，需矩形配额。保留作对照。
//     实测矩形上限约 10km：0.075°×0.050°（9.5km）OK、0.100°×0.020°（10.4km）INVALID_PARAMS。
//     角点必须用**分号**分隔，用逗号会 INVALID_PARAMS。
const MODE = process.env.AMAP_TILE_MODE === 'rect' ? 'rect' : 'circle';

const MAX_DIAG_KM = 9.0;              // 实测安全阈值（上限约 10km）
const CIRCLE_R_M = 4500;              // 实测最大有效半径（5000 会掉档）
const CIRCLE_SPACING_M = 6500;        // 六边形网格间距；最大空隙 = spacing/√3 ≈ 3.75km < 4.5km → 无洞
const KM_PER_LON = 102, KM_PER_LAT = 111; // 惠州纬度下的粗略换算
const R6 = (v) => Number(v.toFixed(6));
const M_PER_DEG_LAT = 111000;

const diagKm = (dLon, dLat) => Math.hypot(dLon * KM_PER_LON, dLat * KM_PER_LAT);

// 子瓦片与多边形是否相交：中心点落在多边形内，或有任一多边形顶点落在瓦片内
function tileIntersects(box, polygons) {
  const [x0, y0, x1, y1] = box;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  if (pointInPolygon(cx, cy, polygons)) return true;
  for (const poly of polygons) for (const ring of poly) for (const [x, y] of ring) {
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true;
  }
  return false;
}

// 沿较长边递归二分，直到对角线达标
function splitBox(box, out) {
  const [x0, y0, x1, y1] = box;
  const dLon = x1 - x0, dLat = y1 - y0;
  if (diagKm(dLon, dLat) <= MAX_DIAG_KM) { out.push(box); return; }
  if (dLon * KM_PER_LON >= dLat * KM_PER_LAT) {
    const xm = (x0 + x1) / 2;
    splitBox([x0, y0, xm, y1], out);
    splitBox([xm, y0, x1, y1], out);
  } else {
    const ym = (y0 + y1) / 2;
    splitBox([x0, y0, x1, ym], out);
    splitBox([x0, ym, x1, y1], out);
  }
}

function buildRectTiles() {
  const tiles = [];
  for (const area of loadAreas()) {
    const bb = bboxOf(area.polygons);
    if (!bb) continue;
    const boxes = [];
    splitBox(bb, boxes);
    boxes.forEach((b, i) => {
      if (!tileIntersects(b, area.polygons)) return; // 与街道不相交，跳过
      tiles.push({
        mode: 'rect',
        street: area.name,
        name: area.name + (boxes.length > 1 ? `-${String(i + 1).padStart(2, '0')}` : ''),
        rect: `${R6(b[0])},${R6(b[1])};${R6(b[2])},${R6(b[3])}`,
      });
    });
  }
  return tiles;
}

// 点到线段的近似距离（米）—— 用于判断圆是否够到街道多边形
function distToSegmentM(lon, lat, a, b) {
  const kx = Math.cos((lat * Math.PI) / 180) * M_PER_DEG_LAT;
  const px = (lon - a[0]) * kx, py = (lat - a[1]) * M_PER_DEG_LAT;
  const bx = (b[0] - a[0]) * kx, by = (b[1] - a[1]) * M_PER_DEG_LAT;
  const L2 = bx * bx + by * by;
  let t = L2 > 0 ? (px * bx + py * by) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - bx * t, py - by * t);
}
function minDistToPolygonsM(lon, lat, polygons) {
  let best = Infinity;
  for (const poly of polygons) for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const d = distToSegmentM(lon, lat, ring[j], ring[i]);
      if (d < best) best = d;
    }
  }
  return best;
}

// 六边形网格铺圆：行距 spacing·√3/2，行内间隔 spacing、隔行错半个身位。
// 只保留「与 18 个街道多边形有交集」的圆，避免把配额浪费在邻区/空地上。
// 圆心所在街道作为该圆的标签（只在覆盖统计里用；路段归属一律走逐点采样）。
function buildCircleTiles() {
  const areas = loadAreas();
  const boxes = areas.map((a) => bboxOf(a.polygons));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) if (b) { x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }

  const dy = (CIRCLE_SPACING_M * Math.sqrt(3)) / 2;
  const lat0 = (y0 + y1) / 2;
  const dLat = dy / M_PER_DEG_LAT;
  const dLon = CIRCLE_SPACING_M / (Math.cos((lat0 * Math.PI) / 180) * M_PER_DEG_LAT);

  const tiles = [];
  let row = 0;
  for (let lat = y0; lat <= y1 + dLat; lat += dLat, row++) {
    const off = row % 2 ? dLon / 2 : 0;
    for (let lon = x0 + off; lon <= x1 + dLon; lon += dLon) {
      let inside = null;
      const hits = [];            // 该圆够到的所有街道（多标签）
      for (let i = 0; i < areas.length; i++) {
        if (pointInPolygon(lon, lat, areas[i].polygons)) { inside = areas[i].name; hits.push(areas[i].name); continue; }
        if (minDistToPolygonsM(lon, lat, areas[i].polygons) <= CIRCLE_R_M) hits.push(areas[i].name);
      }
      if (!hits.length) continue; // 够不到任何街道，跳过
      const street = inside || hits[0]; // 圆心所在街道优先；圆心在区外时取第一个够到的
      tiles.push({
        mode: 'circle',
        street,
        streets: hits,     // 覆盖统计用：一个圆可同时覆盖多个街道（中心区小街道没有落在自己境内的圆心）
        name: `${street}@${lon.toFixed(3)},${lat.toFixed(3)}`,
        lon: R6(lon),
        lat: R6(lat),
        radius: CIRCLE_R_M,
      });
    }
  }

  // 补一个「街道内部代表点」的圆：六边形网格是全区统一铺的，窄/小的街道（桥东、河南岸、
  // 沥林、潼侨）可能一个圆心都落不进去。这时**无法区分**「高德在该街道无覆盖」与
  // 「我们的采样没采到它」—— 两者在结论里是完全不同的两件事。
  // 做法：在街道 bbox 上按 500m 取样，取**离边界最远**的内点（内切圆心，近似 pole of
  // inaccessibility），作为该街道的保底采样点。已有圆心落在境内的街道不重复加。
  const REPRESENT_STEP_M = 500;
  let seeded = 0;
  for (const a of areas) {
    if (tiles.some((t) => pointInPolygon(t.lon, t.lat, a.polygons))) continue;
    const bb = bboxOf(a.polygons);
    const dLat = REPRESENT_STEP_M / M_PER_DEG_LAT;
    const dLon = REPRESENT_STEP_M / (Math.cos((((bb[1] + bb[3]) / 2) * Math.PI) / 180) * M_PER_DEG_LAT);
    let best = null, bestD = -1;
    for (let lat = bb[1]; lat <= bb[3]; lat += dLat) {
      for (let lon = bb[0]; lon <= bb[2]; lon += dLon) {
        if (!pointInPolygon(lon, lat, a.polygons)) continue;
        const d = minDistToPolygonsM(lon, lat, a.polygons);
        if (d > bestD) { bestD = d; best = [lon, lat]; }
      }
    }
    if (!best) continue;
    seeded++;
    tiles.push({
      mode: 'circle',
      street: a.name,
      streets: [a.name],
      name: `${a.name}@${best[0].toFixed(3)},${best[1].toFixed(3)}`,
      lon: R6(best[0]),
      lat: R6(best[1]),
      radius: CIRCLE_R_M,
      seed: 'representative',
    });
  }
  if (seeded) console.log(`[tiles] 为 ${seeded} 个境内无圆心的街道补了保底采样点`);
  return tiles;
}

const TILES = MODE === 'rect' ? buildRectTiles() : buildCircleTiles();

// 高德 congestion codes, per their docs.
const STATUS_LABEL = { 0: '未知', 1: '畅通', 2: '缓行', 3: '拥堵', 4: '严重拥堵' };
const assignStreet = assignStreetFactory(loadAreas());

const hav = (a, b) => {
  const R = 6371000, d = Math.PI / 180;
  const dl = (b[0] - a[0]) * d, dt = (b[1] - a[1]) * d;
  const x = Math.sin(dl / 2) ** 2 + Math.cos(a[1] * d) * Math.cos(b[1] * d) * Math.sin(dt / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
// polyline 形如 "lon,lat;lon,lat;…"（GCJ-02）。
function parsePolyline(s) {
  if (!s) return [];
  return s.split(';').map((p) => p.split(',').map(Number)).filter((p) => p.length === 2 && isFinite(p[0]) && isFinite(p[1]));
}
// 采样几何的「在内」判定统一为**质点谓词**，与街道归属共用同一个遍历循环：
//   · circle 模式 → 点到圆心距离 ≤ 半径（两边都在 GCJ-02 下比较）
//   · rect   模式 → 点落在矩形经纬度范围内
// 坐标提醒：高德的 location / rectangle 参数都要 **GCJ-02**。而网格中心、街道外接框
// 都来自 OSM 的 WGS-84 多边形 —— 必须 wgs2gcj 之后再发给高德、再与 GCJ 的 polyline
// 比较，否则整个采样几何会偏约 500m（老版本 rect 模式就是这个 bug）。

// 沿 polyline 每 SAMPLE_STEP_M 打一点，逐点做 GCJ→WGS 纠偏 + 街道判定，按点数累加长度。
// 为什么用质点采样而不是严格的多边形裁剪：18 个街道多边形共约 7000 个顶点，线段-多边形
// 裁剪要处理凹多边形、多环、边界退化，复杂且易错；20m 间隔远小于街道尺度（街道量级
// 数 km），里程误差 < 0.1%，工程上明显更稳。
const SAMPLE_STEP_M = 20;
function analyzePolyline(polyline, inQuery) {
  const pts = parsePolyline(polyline);
  const perStreet = {};   // 街道 -> 米
  const repPoint = {};    // 街道 -> 该路在此街道内的第一个采样点（代表点）
  let full = 0, inQueryM = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = hav(a, b);
    if (!(seg > 0)) continue;
    full += seg;
    const n = Math.max(1, Math.ceil(seg / SAMPLE_STEP_M));
    const step = seg / n;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const g = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (inQuery(g)) inQueryM += step;
      const w = gcj2wgs(g);
      const s = assignStreet(w[0], w[1]);
      if (!s) continue;
      perStreet[s] = (perStreet[s] || 0) + step;
      if (!repPoint[s]) repPoint[s] = [+w[0].toFixed(6), +w[1].toFixed(6)];
    }
  }
  return { perStreet, repPoint, full, inQueryM };
}

// FNV-1a 32 位 —— 给 polyline 算稳定指纹，做**跨瓦片去重**。
// 不去重的后果是实测过的：786 条路段记录实际只有 322 条不同路段，虚增里程 738.6km。
function polyHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// 返回 { inside, full }，单位米。inside = 落在采样几何内的中心线长度。
function polylineM(s, inQuery) {
  if (!s) return { inside: 0, full: 0 };
  return analyzePolyline(s, inQuery);
}

async function sampleTile(tile) {
  const isCircle = tile.mode === 'circle';
  const url = new URL(`https://restapi.amap.com/v3/traffic/status/${isCircle ? 'circle' : 'rectangle'}`);
  let inQuery;
  let query;
  if (isCircle) {
    const c = wgs2gcj([tile.lon, tile.lat]);      // 网格中心是 WGS-84 → 必须转 GCJ-02
    url.searchParams.set('location', `${c[0].toFixed(6)},${c[1].toFixed(6)}`);
    url.searchParams.set('radius', String(tile.radius));
    inQuery = (g) => hav(g, c) <= tile.radius;
    query = { center: [+c[0].toFixed(6), +c[1].toFixed(6)], radius: tile.radius };
  } else {
    const [c1, c2] = tile.rect.split(';').map((p) => p.split(',').map(Number));
    const g1 = wgs2gcj(c1), g2 = wgs2gcj(c2);
    const x0 = Math.min(g1[0], g2[0]), x1 = Math.max(g1[0], g2[0]);
    const y0 = Math.min(g1[1], g2[1]), y1 = Math.max(g1[1], g2[1]);
    url.searchParams.set('rectangle', `${x0.toFixed(6)},${y0.toFixed(6)};${x1.toFixed(6)},${y1.toFixed(6)}`);
    inQuery = (g) => g[0] >= x0 && g[0] <= x1 && g[1] >= y0 && g[1] <= y1;
    query = { rect: [+x0.toFixed(6), +y0.toFixed(6), +x1.toFixed(6), +y1.toFixed(6)] };
  }
  url.searchParams.set('level', '6'); // road-level granularity
  url.searchParams.set('extensions', 'all');

  // 取数统一走密钥池的 fetchJSON：它对限流码（10021/10023/10025/30001…）自动「换 key +
  // 退避」重试，重试次数至少覆盖一遍所有 key。这里传 builder 而不是拼好的 URL，
  // 就是为了让每次重试都能换到下一把 key。
  const base = url.toString();
  const json = await fetchJSON((k) => `${base}&key=${k}`, { tries: 4, tag: tile.name, timeout: 30000 });
  if (json.status !== '1') throw new Error(`${tile.name}: ${json.info} (${json.infocode})`);

  const info = json.trafficinfo || {};
  const evaln = info.evaluation || {};
  const roads = (info.roads || []).map((r) => {
    const { perStreet, repPoint, full, inQueryM } = analyzePolyline(r.polyline, inQuery);
    // 归属用逐点采样（见 analyzePolyline 头注）——不再用整条路的中点
    let dom = null;
    for (const s of Object.keys(perStreet)) if (dom === null || perStreet[s] > perStreet[dom]) dom = s;
    const kmIn = Object.values(perStreet).reduce((s, x) => s + x, 0);
    return {
      name: r.name,
      status: r.status,
      label: STATUS_LABEL[r.status] || r.status,
      speed: r.speed,
      direction: r.direction,
      // polyline 指纹 → 跨瓦片去重（同一条路在多个瓦片里 polyline 完全相同）
      poly: polyHash(r.polyline),
      // km = 落在**惠城区内**的中心线长度（km）。跨瓦片一致，是里程加权的正确权重，
      // 也是街道级里程的唯一来源（streetKm 按街道拆分，天然不重复计数）。
      km: +(kmIn / 1000).toFixed(3),
      // kmQuery = 落在采样几何（圆 / 矩形）内的长度，每瓦片自己的覆盖足迹，仅供核对
      kmQuery: +(inQueryM / 1000).toFixed(3),
      // 完整 polyline 长度（km，远超采样几何，核对「高德返回整条路」这一事实）
      kmFull: +(full / 1000).toFixed(3),
      // 该路在各街道内的长度（km）
      streetKm: Object.fromEntries(Object.keys(perStreet).map((s) => [s, +(perStreet[s] / 1000).toFixed(3)])),
      // 主体街道 + 代表点
      street: dom,
      lon: dom ? repPoint[dom][0] : null,
      lat: dom ? repPoint[dom][1] : null,
    };
  });
  return {
    tile: tile.name,
    mode: tile.mode,
    query,
    // overall 来自 evaluation.status（老版本错读 trafficinfo.status，恒为 undefined）
    overall: evaln.status != null ? Number(evaln.status) : null,
    overallLabel: evaln.description || null,
    evaluation: {
      expeditePct: evaln.expedite != null ? parseFloat(evaln.expedite) : null,
      congestedPct: evaln.congested != null ? parseFloat(evaln.congested) : null,
      blockedPct: evaln.blocked != null ? parseFloat(evaln.blocked) : null,
      unknownPct: evaln.unknown != null ? parseFloat(evaln.unknown) : null,
    },
    // 里程加权均速（km/h）：Σ(路段km) / Σ(路段km / 路段速度)。km 用区内存量。
    kmh: (() => {
      let km = 0, h = 0;
      for (const r of roads) { const v = Number(r.speed); if (r.km > 0 && v > 0) { km += r.km; h += r.km / v; } }
      return km > 0 ? +(km / h).toFixed(1) : null;
    })(),
    // 本瓦片采样几何内的中心线里程（覆盖足迹）
    kmTotal: +roads.reduce((s, r) => s + r.kmQuery, 0).toFixed(2),
    // 本瓦片返回路段的**区内**里程合计（含跨瓦片重复，仅看量级）
    kmDistrict: +roads.reduce((s, r) => s + r.km, 0).toFixed(2),
    roads,
  };
}

// 每瓦片重试：空返回分两类 —— 限流/超时（下轮就正常）与**真·无覆盖**（农村镇，重试也
// 不会变）。统一重试，终态交给持久化层区分：
//   status 'ok'    有路段
//   status 'empty' 重试后仍 0 条路段 → 终态（高德确实没覆盖这里，不再浪费配额）
//   status 'error' 抛错（网络/非限流错）→ 非终态，下一轮会再试
async function sampleTileWithRetry(tile, tries = 3) {
  let lastErr = null;
  let sawEmpty = false;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await sampleTile(tile);
      if (r.roads.length) return { status: 'ok', result: r };
      sawEmpty = true;
      lastErr = new Error('返回 0 条路段');
    } catch (e) {
      lastErr = e;
      sawEmpty = false; // 抛错说明是失败而不是"真的没路"
    }
    if (i < tries) await new Promise((res) => setTimeout(res, 1500 * i));
  }
  return { status: sawEmpty ? 'empty' : 'error', error: lastErr ? lastErr.message : '未知错误' };
}

(async () => {
  const ts = new Date();
  // band 只由墙钟决定；AMAP_BAND=HH:00 可显式覆盖（补采某时段时用，检查点也随之换桶）
  const band = process.env.AMAP_BAND || `${String(ts.getHours()).padStart(2, '0')}:00`;
  const out = { sampledAt: ts.toISOString(), band, tiles: [], failedTiles: [] };

  console.log(`本轮 ${TILES.length} 个采样几何（${MODE}），覆盖 ${new Set(TILES.flatMap((t) => t.streets || [t.street])).size} 个街道/镇`);
  if (MODE === 'circle') console.log(`圆形网格：r=${CIRCLE_R_M}m、间距 ${CIRCLE_SPACING_M}m（最大空隙 ${(CIRCLE_SPACING_M / Math.sqrt(3)).toFixed(0)}m < r，无洞）`);
  else console.log(`矩形二分：每片对角线 ≤ ${MAX_DIAG_KM}km（实测 API 上限约 10km，超限返回 INVALID_PARAMS）`);

  // 复用检查点：只认本 band 的终态 ok / empty
  const prior = process.env.AMAP_FRESH === '1' ? new Map() : loadPartials(band);
  let resumed = 0;
  if (process.env.AMAP_FRESH === '1') console.log('[ckpt] AMAP_FRESH=1 → 忽略已有检查点，强制全量重采');
  else if (prior.size) console.log(`[ckpt] 时段 ${band} 已有 ${prior.size} 个检查点，跳过其中已终结的瓦片`);
  console.log('');

  let done = 0;
  for (const t of TILES) {
    done++;
    const prev = prior.get(t.name);
    if (prev && (prev.status === 'ok' || prev.status === 'empty')) {
      resumed++;
      if (prev.status === 'ok') {
        out.tiles.push({ ...prev.result, street: t.street, streets: t.streets || [t.street] });
      } else {
        out.failedTiles.push({
          tile: t.name, street: t.street, streets: t.streets || [t.street],
          query: prev.query, error: prev.error || '返回 0 条路段', category: 'empty', resumed: true,
        });
      }
      continue;
    }

    const query = t.mode === 'circle'
      ? { center: wgs2gcj([t.lon, t.lat]).map((v) => +v.toFixed(6)), radius: t.radius }
      : { rect: t.rect };
    try {
      const { status, result, error } = await sampleTileWithRetry(t);
      if (status === 'ok') {
        result.street = t.street;
        result.streets = t.streets || [t.street];
        out.tiles.push(result);
        savePartial({ name: t.name, band, street: t.street, streets: t.streets || [t.street], query, status: 'ok', sampledAt: new Date().toISOString(), result });
        console.log(`[${String(done).padStart(2)}/${TILES.length}] ${t.name.padEnd(22)} 路段 ${String(result.roads.length).padStart(4)} · 足迹 ${String(result.kmTotal).padStart(6)}km · ${String(result.kmh ?? '-').padStart(4)}km/h · ${result.overallLabel || result.overall || '-'}`);
      } else {
        out.failedTiles.push({ tile: t.name, street: t.street, streets: t.streets || [t.street], query, error, category: status });
        savePartial({ name: t.name, band, street: t.street, streets: t.streets || [t.street], query, status, sampledAt: new Date().toISOString(), error });
        console.log(`[${String(done).padStart(2)}/${TILES.length}] ${t.name.padEnd(22)} ${status === 'empty' ? 'EMPTY  ' : 'FAILED '} ${error}`);
      }
    } catch (e) {
      // 兜底：sampleTileWithRetry 已捕获，这里防未知异常把整轮打断
      out.failedTiles.push({ tile: t.name, street: t.street, streets: t.streets || [t.street], query, error: e.message, category: 'error' });
      console.log(`[${String(done).padStart(2)}/${TILES.length}] ${t.name.padEnd(22)} THROWN  ${e.message}`);
    }
    await new Promise((res) => setTimeout(res, 600));
  }
  if (resumed) console.log(`\n[ckpt] 复用 ${resumed} 个已终结瓦片，新采 ${TILES.length - resumed} 个`);

  // 街道级覆盖统计：按 polyline 指纹先去重，再按 streetKm 把里程拆到各街道。
  // 不去重会把同一路段在每个瓦片里重复计一次（实测虚增 738.6km）。
  const seen = new Set();
  const byStreet = {};
  let dupRecords = 0, uniqueRoads = 0;
  for (const t of out.tiles) {
    for (const r of t.roads) {
      if (seen.has(r.poly)) { dupRecords++; continue; }
      seen.add(r.poly);
      uniqueRoads++;
      for (const [s, km] of Object.entries(r.streetKm || {})) {
        byStreet[s] = byStreet[s] || { roads: 0, km: 0 };
        byStreet[s].roads++;
        byStreet[s].km += km;
      }
    }
  }
  for (const k of Object.keys(byStreet)) byStreet[k].km = +byStreet[k].km.toFixed(2);
  out.streetCoverage = byStreet;
  out.dedup = { rawRecords: out.tiles.reduce((s, t) => s + t.roads.length, 0), uniqueRoads, duplicateRecords: dupRecords };

  // 采样窗口：检查点复用会让同一个文件里的瓦片跨越若干分钟 —— 如实记录首尾时间戳，
  // 避免报告把它当成"某一瞬间的快照"。band 只精确到小时，这里补上分钟级实况。
  const stamps = [];
  for (const f of fs.readdirSync(PARTIAL)) {
    if (!f.startsWith(`tile_${String(band).replace(':', '-')}_`)) continue;
    try { const j = JSON.parse(fs.readFileSync(path.join(PARTIAL, f), 'utf8')); if (j.sampledAt) stamps.push(j.sampledAt); } catch (e) { /* ignore */ }
  }
  stamps.sort();
  out.sampledWindow = stamps.length ? { first: stamps[0], last: stamps[stamps.length - 1], checkpoints: stamps.length } : null;
  out.resumedTiles = resumed;

  const covered = Object.keys(byStreet).length;
  const emptyTiles = out.failedTiles.filter((f) => f.category === 'empty' || /返回 0 条路段/.test(f.error || '')).length;
  out.coverageSummary = {
    // 被采样几何够到的街道数（圆是多标签：一个圆可能同时覆盖多个街道）
    requestedStreetTiles: new Set(TILES.flatMap((t) => t.streets || [t.street])).size,
    tilesRequested: TILES.length,
    mode: MODE,
    tilesOk: out.tiles.length,
    tilesFailed: out.failedTiles.length,
    // 关键区分：empty = 高德在该处确实没有态势数据（重试过，是事实）；
    //          error  = 网络/限流导致没采到（是失败，不是"没数据"）
    tilesEmpty: emptyTiles,
    tilesError: out.failedTiles.length - emptyTiles,
    streetsWithRoads: covered,
    uniqueRoads,
  };

  const total = out.tiles.reduce((s, t) => s + t.roads.length, 0);
  if (!total) {
    console.log('\n本轮 0 条路段，**不落盘** —— 空文件会让报告的「采样次数」虚高。');
    console.log('可能原因：AMAP_KEY 额度用尽 / 被限流 / 网络不通。请稍后重试，或改用');
    console.log('商务版历史路况接口一次补齐：node fetch_congestion_history.js');
    process.exit(1);
  }

  const file = path.join(DATA, `congestion_${ts.toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  const kmQuery = out.tiles.reduce((s, t) => s + t.kmTotal, 0);
  const kmUniq = Object.values(byStreet).reduce((s, v) => s + v.km, 0);
  console.log(`\nsaved ${path.basename(file)}`);
  console.log(`原始 ${total} 条路段记录 → 去重后 ${out.dedup.uniqueRoads} 条（重复 ${out.dedup.duplicateRecords} 条，按 polyline 指纹）`);
  console.log(`区内里程（去重后）${kmUniq.toFixed(1)}km · 采样几何足迹 ${kmQuery.toFixed(1)}km @ ${band}`);
  console.log(`街道覆盖 ${out.coverageSummary.streetsWithRoads}/${out.coverageSummary.requestedStreetTiles} · 瓦片成功 ${out.coverageSummary.tilesOk}/${out.coverageSummary.tilesRequested}`);
  if (out.failedTiles.length) console.log(`未采到 ${out.failedTiles.length} 个瓦片：其中 ${out.coverageSummary.tilesEmpty} 个是高德确无数据（empty，重试过）、${out.coverageSummary.tilesError} 个是取数失败（error，可再跑一轮补）`);
  if (out.sampledWindow) console.log(`采样窗口 ${out.sampledWindow.first} → ${out.sampledWindow.last}（${out.sampledWindow.checkpoints} 个检查点${resumed ? `，本轮复用 ${resumed}` : ''}）`);
  console.log('\n各街道实测路段（已去重，仅计落在本街道内的里程）：');
  Object.entries(out.streetCoverage).sort((a, b) => b[1].km - a[1].km).forEach(([k, v]) => {
    console.log(`  ${k.padEnd(12)} ${String(v.roads).padStart(4)} 段 · ${String(v.km).padStart(7)}km`);
  });
  console.log('\n要形成"每个时段"的分布，需要定时采样。建议时段：');
  console.log('  07:00 早高峰前   08:30 早高峰   12:00 平峰   17:30 晚高峰   21:00 夜间');
})();
