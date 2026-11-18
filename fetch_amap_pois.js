// 通用高德 POI 扫描（一次性）：为「设施类」元素提供比 OSM 完整的计数源。
//
// 为什么换源：build_source_crosscheck.js 实测（同区域、同口径）——
//   加油站 OSM/高德 = 32% · 充电站 1% · 停车场 21% · 学校 70% · 医院 22%
// 停车场/加油站/充电站/收费站/服务区早已走 amap_* 扫街文件（见 build_stats.js 的
// ELEMENT_SETS）；学校/医院/市场仍是 OSM，本脚本把它们也补齐。
//
// 机制复用 fetch_amap_elements.js：polygon 泛搜 + count>220 自动四分 + 去重。
// 已存在的 data/amap_<label>.json 直接复用；data/amap_<label>_ck.json 视为等价扫描，
// 直接改名落地，不重复请求。
const fs = require('fs');
const path = require('path');

const { nextKey } = require('./amap_key');

const ROOT = { w: 114.10, e: 114.80, s: 22.90, n: 23.43 };
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// typecode 均用实际响应核对过（见 out/amap_typecode_probe.json，由 probe_amap_typecode.js 生成）：
//   141200 科教文化服务;学校（父级，实测含 141202 中学 /141203 小学 /141204 幼儿园 子类）
//   090100 医疗保健服务;综合医院（实测含 090101 三甲 /090102 卫生院 子类）
//   060700 购物服务;综合市场（实测含 060703 农副产品 /060704 果品 /060705 蔬菜 子类）
//   150700 交通设施服务;公交车站
//   130504 政府机构及社会团体;公检法机构;消防机关（消防站/消防救援队）
//   130501 政府机构及社会团体;公检法机构;公安警察（派出所）
const SWEEPS = {
  schools: [['types', '141200']],
  hospitals: [['types', '090100']],
  markets: [['types', '060700']],
  bus_stops: [['types', '150700']],
  fire_stations: [['types', '130504']],
  police_stations: [['types', '130501']],
};

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
  const MAXPAGE = 9;
  while (page <= MAXPAGE) {
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
    console.log(`  [cache] amap_${label}.json  (${j.total})`);
    return j;
  }
  const ck = path.join(DATA, `amap_${label}_ck.json`);
  if (fs.existsSync(ck)) {
    const j = JSON.parse(fs.readFileSync(ck, 'utf8'));
    fs.writeFileSync(out, JSON.stringify(j));
    console.log(`  [promote] amap_${label}_ck.json -> amap_${label}.json  (${j.total})`);
    return j;
  }
  const byId = new Map();
  for (const t of subdivide(ROOT).flatMap(subdivide)) await sweepTile(params, t, 2, byId);
  const pois = [...byId.values()];
  const payload = { label, total: pois.length, sampledAt: new Date().toISOString(), pois };
  fs.writeFileSync(out, JSON.stringify(payload));
  console.log(`  [ok] amap_${label}.json: ${pois.length} unique POIs`);
  return payload;
}

(async () => {
  for (const [label, params] of Object.entries(SWEEPS)) {
    await sweep(label, params);
    await sleep(1500);
  }
  console.log('\nDone. 设施类元素源已就绪（build_stats.js 的 ELEMENT_SETS 按 amap 键读取）。');
})();
