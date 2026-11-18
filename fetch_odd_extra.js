// 补抓「勾选表 not-fetched」中经探测确认高德/OSM 真有数据的 ODD 元素。
// 探测依据：out/typecode_family_probe.json（types 参数实测，非关键词猜测）
//   Amap 190306 立交桥 64 · 180200 收费站 139 · 180300 高速服务区 30 · 190304/190305 高速出入口 178
//   Amap 无路灯/交通标志/减速带/井盖 POI（关键词命中的全是灯具市场/摄影店/建材市场噪音）
//   OSM footway+bridge（人行天桥）158；OSM street_lamp / traffic_sign / manhole 均为 0
// 机制与 fetch_amap_pois.js 完全一致：polygon 泛搜 + count>220 四分 + 按 id 去重。
const fs = require('fs');
const path = require('path');
const { nextKey } = require('./amap_key');

const ROOT = { w: 114.10, e: 114.80, s: 22.90, n: 23.43 };
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// types 参数可传多个（|分隔）：高速出入口 = 出口 + 入口
const SWEEPS = {
  interchanges: [['types', '190306']],   // 立交桥 —— 补 ODD 1.1「立体交叉/立交桥」缺口
  tolls: [['types', '180200']],          // 收费站
  service_areas: [['types', '180300']],  // 高速服务区
  ramps: [['types', '190304|190305']],   // 高速路出口 + 入口
};

const OSM_QUERIES = {
  // 人行天桥：ODD 1.6「天桥」此前只能写「含于桥梁统计」，现在可独立计数
  footbridges: `[out:json][timeout:180];
    (way["highway"="footway"]["bridge"](${ROOT.s},${ROOT.w},${ROOT.n},${ROOT.e});
     way["highway"="steps"]["bridge"](${ROOT.s},${ROOT.w},${ROOT.n},${ROOT.e}););
    out tags center;`,
};
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const tilePolygon = (t) => `${t.w},${t.s}|${t.e},${t.s}|${t.e},${t.n}|${t.w},${t.n}`;
const subdivide = (t) => {
  const wm = (t.w + t.e) / 2, sm = (t.s + t.n) / 2;
  return [
    { w: t.w, e: wm, s: t.s, n: sm }, { w: wm, e: t.e, s: t.s, n: sm },
    { w: t.w, e: wm, s: sm, n: t.n }, { w: wm, e: t.e, s: sm, n: t.n },
  ];
};

async function fetchPage(params, tile, page) {
  const qs = new URLSearchParams({ key: nextKey(), polygon: tilePolygon(tile), offset: '25', page: String(page), output: 'json' });
  for (const [k, v] of params) qs.set(k, v);
  const url = `https://restapi.amap.com/v3/place/polygon?${qs.toString()}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const j = await res.json();
      if (j.infocode === '10000') return j;
      if (j.infocode === '10021' || /QPS/i.test(j.info || '')) throw new Error('QPS limit');
      throw new Error(`${j.infocode} ${j.info}`);
    } catch (e) {
      console.log(`  [retry ${attempt}] page ${page}: ${e.message}`);
      await sleep(2500 * attempt);
    }
  }
  throw new Error(`page ${page} failed after retries`);
}

async function sweepTile(params, tile, depth, byId) {
  let page = 1, count = 0;
  while (page <= 9) {
    const j = await fetchPage(params, tile, page);
    count = Number(j.count || 0);
    const pois = j.pois || [];
    for (const p of pois) byId.set(p.id || `${p.name}@${p.location}`, p);
    if (!pois.length || byId.size >= count || pois.length < 25) break;
    page++;
    await sleep(1300);
  }
  if (count > 220 && depth < 3) for (const st of subdivide(tile)) await sweepTile(params, st, depth + 1, byId);
  await sleep(1200);
}

async function sweep(label, params) {
  const out = path.join(DATA, `amap_${label}.json`);
  if (fs.existsSync(out)) {
    const j = JSON.parse(fs.readFileSync(out, 'utf8'));
    console.log(`  [cache] amap_${label}.json (${j.total})`);
    return j;
  }
  const byId = new Map();
  for (const t of subdivide(ROOT).flatMap(subdivide)) await sweepTile(params, t, 2, byId);
  const pois = [...byId.values()];
  const payload = { label, typecode: params.find(([k]) => k === 'types')[1], total: pois.length, sampledAt: new Date().toISOString(), pois };
  fs.writeFileSync(out, JSON.stringify(payload));
  console.log(`  [ok] amap_${label}.json: ${pois.length} 条  (typecode ${payload.typecode})`);
  return payload;
}

async function overpass(query, label) {
  const out = path.join(DATA, `${label}.json`);
  if (fs.existsSync(out) && fs.statSync(out).size > 500) {
    console.log(`  [cache] ${label}.json`);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(MIRRORS[attempt % MIRRORS.length], {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'map-element-survey/1.0 (Huicheng ADAS test-area analysis)',
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.timeout(180000),
      });
      const text = await res.text();
      if (text.trim().startsWith('<')) throw new Error('server returned HTML (throttled/busy)');
      const json = JSON.parse(text);
      const ts = json.osm3s && json.osm3s.timestamp_osm_base;
      if (!ts || !/^\d{4}-\d{2}-\d{2}T/.test(ts)) throw new Error(`stale mirror (${ts})`);
      fs.writeFileSync(out, JSON.stringify(json));
      console.log(`  [ok] ${label}.json: ${json.elements.length} 条 (${ts})`);
      return json;
    } catch (e) {
      console.log(`  [retry ${attempt + 1}] ${label}: ${e.message}`);
      await sleep(8000 * (attempt + 1));
    }
  }
  throw new Error(`FAILED: ${label}`);
}

(async () => {
  console.log('=== 高德补抓（勾选表缺口项）===');
  for (const [label, params] of Object.entries(SWEEPS)) {
    await sweep(label, params);
    await sleep(1500);
  }
  console.log('=== OSM 补抓 ===');
  for (const [label, q] of Object.entries(OSM_QUERIES)) {
    await overpass(q, label);
    await sleep(3000);
  }
  console.log('\nDone. 新增元素源已落 data/。');
})();
