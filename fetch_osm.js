// Fetch Huicheng District road elements + street boundaries from OSM Overpass.
// Writes raw JSON into ./data so analysis can be re-run without refetching.
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

// overpass-api.de was fastest+healthiest and is the only mirror verified fresh.
// NOTE: overpass.osm.ch serves a frozen 2026-05 snapshot and silently returns
// 0 elements for valid queries (its timestamp_osm_base is not ISO), so it must
// never be trusted. A stale mirror returning empty is worse than an error.
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Full 惠城区 envelope (union of all 18 subdistrict polygons + margin):
// lat 22.917–23.416, lon 114.119–114.789. The old core bbox
// (23.00,114.25,23.35,114.70) clipped 芦洲镇's northern half and 沥林镇 entirely.
const BBOX = '22.90,114.10,23.43,114.80';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query, label, { retries = 4 } = {}) {
  const out = path.join(DATA, `${label}.json`);
  if (fs.existsSync(out) && fs.statSync(out).size > 500) {
    console.log(`  [cache] ${label}`);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  }
  for (let attempt = 0; attempt < retries; attempt++) {
    const mirror = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'map-element-survey/1.0 (Huicheng ADAS test-area analysis)',
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.timeout(180000),
      });
      const text = await res.text();
      if (text.trim().startsWith('<')) {
        throw new Error('server returned HTML (throttled/busy)');
      }
      const json = JSON.parse(text);
      if (json.remark && /error|timeout/i.test(json.remark)) throw new Error(json.remark);
      if (!json.elements) throw new Error('no elements field');
      // Reject stale mirrors: they serve an old snapshot and return 0 elements
      // for queries that legitimately match data. Their timestamp is not ISO.
      const ts = json.osm3s && json.osm3s.timestamp_osm_base;
      if (!ts || !/^\d{4}-\d{2}-\d{2}T/.test(ts)) {
        throw new Error(`stale mirror (timestamp_osm_base=${ts})`);
      }
      fs.writeFileSync(out, JSON.stringify(json));
      console.log(`  [ok] ${label} -> ${json.elements.length} elements (${mirror.split('/')[2]}, ${ts})`);
      return json;
    } catch (e) {
      console.log(`  [retry ${attempt + 1}/${retries}] ${label}: ${e.message}`);
      await sleep(8000 * (attempt + 1));
    }
  }
  throw new Error(`FAILED: ${label} after ${retries} attempts`);
}

// Split the element sweep into separate queries so one heavy query can't fail everything.
const QUERIES = {
  // --- Road elements that 高德 does NOT expose publicly ---
  signals: `[out:json][timeout:180];
    node["highway"="traffic_signals"](${BBOX});
    out center;`,

  crossings: `[out:json][timeout:180];
    node["crossing"~"^(traffic_signals|marked|uncontrolled|zebra)$"](${BBOX});
    out center;`,

  tunnels: `[out:json][timeout:180];
    way["tunnel"](${BBOX});
    out tags center;`,

  bridges: `[out:json][timeout:180];
    way["bridge"](${BBOX});
    out tags center;`,

  // lane-level info: the closest OSM equivalent to "车道类型"
  lanes: `[out:json][timeout:180];
    way["highway"]["lanes"](${BBOX});
    out tags center;`,

  oneway: `[out:json][timeout:180];
    way["highway"]["oneway"](${BBOX});
    out tags center;`,

  maxspeed: `[out:json][timeout:180];
    way["highway"]["maxspeed"](${BBOX});
    out tags center;`,

  // --- Road network: needed as the density denominator ---
  roads: `[out:json][timeout:240];
    way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service)$"](${BBOX});
    out tags geom;`,

  // --- POI that 高德 also has, but OSM lets us aggregate offline for free ---
  schools: `[out:json][timeout:180];
    (node["amenity"~"^(school|kindergarten|college|university)$"](${BBOX});
     way["amenity"~"^(school|kindergarten|college|university)$"](${BBOX}););
    out center;`,

  hospitals: `[out:json][timeout:180];
    (node["amenity"~"^(hospital|clinic|doctors)$"](${BBOX});
     way["amenity"~"^(hospital|clinic|doctors)$"](${BBOX}););
    out center;`,

  markets: `[out:json][timeout:180];
    (node["amenity"="marketplace"](${BBOX});
     way["amenity"="marketplace"](${BBOX});
     node["shop"~"^(supermarket|convenience|greengrocer|butcher|seafood)$"](${BBOX});
     way["shop"~"^(supermarket|convenience|greengrocer|butcher|seafood)$"](${BBOX}););
    out center;`,

  // --- Street boundaries: the aggregation unit ---
  boundaries: `[out:json][timeout:180];
    (relation["boundary"="administrative"]["admin_level"~"^(6|7|8)$"](${BBOX}););
    out tags geom;`,
};

(async () => {
  console.log('Fetching OSM data for Huicheng District...');
  for (const [label, query] of Object.entries(QUERIES)) {
    await overpass(query, label);
    await sleep(3000); // be polite; avoid the throttling that silently returned empty results
  }
  console.log('\nDone. Raw data in ./data');
})();