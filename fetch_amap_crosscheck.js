// 一次性高德 POI 扫描：为「OSM 只源类」提供交叉验证基准。
// 目的不是换源，而是量化 —— 同一区域、同一类别下，OSM 计数 / 高德计数 = 多少。
// 这样报告第 8 节可以把「OSM 完备度未知」变成「已抽样量化」。
//
// 复用 fetch_amap_elements.js 的扫描机制（polygon 泛搜 + 超 225 自动四分）。
// 已在 data/ 的 sweep（amap_fuel / amap_charging / amap_parking / amap_roadattach）
// 直接复用，不重复请求。
const fs = require('fs');
const path = require('path');

const { nextKey } = require('./amap_key');

const ROOT = { w: 114.10, e: 114.80, s: 22.90, n: 23.43 };
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// typecode 已用实际响应核对：141200 = 科教文化服务;学校（含 中学/小学/幼儿园/成人教育）
const SWEEPS = {
  schools_ck: [['types', '141200']],
  hospitals_ck: [['types', '090100']], // 医疗保健服务;综合医院（含 三级甲等/卫生院）
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

async function sweepTile(params, tile, depth, byId, label) {
  let page = 1, count = 0, fetched = 0;
  const MAXPAGE = 9;
  while (page <= MAXPAGE) {
    const j = await fetchPage(params, tile, page);
    count = Number(j.count || 0);
    const pois = j.pois || [];
    for (const p of pois) byId.set(p.id || `${p.name}@${p.location}`, p);
    fetched += pois.length;
    if (!pois.length || byId.size >= count || pois.length < 25) break;
    page++;
    await sleep(1300);
  }
  console.log(`  ${label} [${tile.w.toFixed(3)},${tile.e.toFixed(3)}]x[${tile.s.toFixed(3)},${tile.n.toFixed(3)}]: count=${count} uniq=${byId.size}`);
  if (count > 220 && depth < 3) for (const st of subdivide(tile)) await sweepTile(params, st, depth + 1, byId, label);
  await sleep(1200);
}

async function sweep(label, params) {
  const out = path.join(DATA, `amap_${label}.json`);
  if (fs.existsSync(out)) {
    const j = JSON.parse(fs.readFileSync(out, 'utf8'));
    console.log(`  [cache] ${label} (${j.total})`);
    return j;
  }
  const byId = new Map();
  for (const t of subdivide(ROOT).flatMap(subdivide)) await sweepTile(params, t, 2, byId, label);
  const pois = [...byId.values()];
  const payload = { label, total: pois.length, sampledAt: new Date().toISOString(), pois };
  fs.writeFileSync(out, JSON.stringify(payload));
  console.log(`  [ok] ${label}: ${pois.length} unique POIs -> data/amap_${label}.json`);
  return payload;
}

(async () => {
  for (const [label, params] of Object.entries(SWEEPS)) {
    await sweep(label, params);
    await sleep(1500);
  }
  console.log('\nDone. One-shot cross-check sweeps only.');
})();
