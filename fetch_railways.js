// 拉取惠城区铁路线几何，用于核验 railway=level_crossing 是否真的落在铁路上。
// 单独一个脚本是因为：铁路道口数据是本次审计的最大疑点（129 个、最近邻中位 5.2m），
// 必须拿到铁路本体才能判断"有没有道口、该有几个"。
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const BBOX = '22.90,114.10,23.43,114.80';
const MIRRORS = [
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const out = path.join(DATA, 'railways.json');
  if (fs.existsSync(out) && fs.statSync(out).size > 500) {
    const j = JSON.parse(fs.readFileSync(out, 'utf8'));
    console.log(`[cache] railways.json -> ${j.elements.length} way`);
    return;
  }
  const query = `[out:json][timeout:180];
    (way["railway"~"^(rail|light_rail|narrow_gauge|preserved|construction|disused)$"](${BBOX}););
    out tags geom;`;
  for (let a = 0; a < 4; a++) {
    const mirror = MIRRORS[a % MIRRORS.length];
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'map-element-survey/1.0 (railway verification)',
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.timeout(180000),
      });
      const text = await res.text();
      if (text.trim().startsWith('<')) throw new Error('HTML (throttled)');
      const json = JSON.parse(text);
      const ts = json.osm3s && json.osm3s.timestamp_osm_base;
      if (!ts || !/^\d{4}-\d{2}-\d{2}T/.test(ts)) throw new Error('stale mirror');
      fs.writeFileSync(out, JSON.stringify(json));
      console.log(`[ok] railways.json -> ${json.elements.length} way (${ts})`);
      return;
    } catch (e) {
      console.log(`[retry ${a + 1}] ${e.message}`);
      await sleep(8000 * (a + 1));
    }
  }
  throw new Error('railways fetch failed');
})();
