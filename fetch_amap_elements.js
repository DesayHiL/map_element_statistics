// ONE-SHOT Amap POI sweeps for traffic elements in Huicheng District.
// NOT a poller: each sweep runs once, caches to data/, then stops.
// (Congestion status polling was explicitly cancelled — do not re-add it.)
//
// Key learnings baked in:
//  - keywords+types combined: API ignores keywords (charge sweep returned all
//    汽车服务). keywords alone: fuzzy match noise (停车场→600). => types ONLY,
//    using typecodes confirmed from live responses.
//  - polygon search caps deep paging at 9 pages * 25 = 225 POIs per query;
//    tiles whose count exceeds that are auto-subdivided.
//  - v3 POIs have no `uid`; dedupe by `id` (fallback name@location).
const fs = require('fs');
const path = require('path');

const { nextKey } = require('./amap_key');

// Full 惠城区 envelope (union of all 18 subdistrict polygons + margin) — the old
// root (114.25–114.70 / 23.00–23.35) clipped 芦洲镇 north and 沥林镇 west.
const ROOT = { w: 114.10, e: 114.80, s: 22.90, n: 23.43 };
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// typecodes verified against live responses:
//   010100 加油站 / 011100 充电站 / 150904 公共停车场 / 180000 道路附属设施(收费站/服务区)
const SWEEPS = {
  fuel:       [['types', '010100']],
  charging:   [['types', '011100']],
  parking:    [['types', '150904']],
  roadattach: [['types', '180000']],
};

const tilePolygon = (t) =>
  `${t.w},${t.s}|${t.e},${t.s}|${t.e},${t.n}|${t.w},${t.n}`;

const subdivide = (t) => {
  const wm = (t.w + t.e) / 2, sm = (t.s + t.n) / 2;
  return [
    { w: t.w, e: wm, s: t.s, n: sm }, { w: wm, e: t.e, s: t.s, n: sm },
    { w: t.w, e: wm, s: sm, n: t.n }, { w: wm, e: t.e, s: sm, n: t.n },
  ];
};

async function fetchPage(params, tile, page) {
  const qs = new URLSearchParams({
    key: nextKey(), polygon: tilePolygon(tile), offset: '25', page: String(page), output: 'json',
  });
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
  let page = 1;
  let count = 0;
  const MAXPAGE = 9; // API refuses deeper pages
  let fetched = 0;
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
  console.log(`  ${label} [${tile.w.toFixed(3)},${tile.e.toFixed(3)}]x[${tile.s.toFixed(3)},${tile.n.toFixed(3)}]: count=${count} fetched=${fetched} uniq=${byId.size}`);
  // tile overflowed the 225-per-query cap -> subdivide and sweep each quadrant
  if (count > 220 && depth < 3) {
    for (const st of subdivide(tile)) {
      await sweepTile(params, st, depth + 1, byId, label);
    }
  }
  await sleep(1200);
}

async function sweep(label, params) {
  const out = path.join(DATA, `amap_${label}.json`);
  if (fs.existsSync(out)) {
    console.log(`  [cache] ${label}`);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  }
  const byId = new Map();
  for (const t of subdivide(ROOT).flatMap(subdivide)) { // start at 4x4 (~18x15 km tiles)
    await sweepTile(params, t, 2, byId, label);
  }
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
  console.log('\nDone. One-shot sweeps only — no polling.');
})();
