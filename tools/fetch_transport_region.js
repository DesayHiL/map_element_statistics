// 按区域抓取交通局公开公告索引，保存可核验的官方链接。
// 只收集施工/占挖/道路计划类公告；事故、封路、临时管制不进入场景数据，除非后续人工确认来源和有效期。
const fs = require('fs');
const path = require('path');
const { REGION, SOURCES } = require('../transport_sources');

const OUT = path.join(__dirname, '..', 'out');
const DATA = path.join(__dirname, '..', 'data');
const indexUrl = SOURCES.find(s => s.key === 'transport-bureau-notices').url;
const terms = ['施工', '占用', '挖掘', '道路计划', '道路养护', '道路改造'];
const hrefRe = /href=["']([^"']+)["'][^>]*>([\s\S]*?)<\//gi;
const strip = s => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const absolute = (u) => new URL(u, indexUrl).href;

(async () => {
  const result = { region: REGION, generated: new Date().toISOString(), source: indexUrl, rows: [], status: 'error' };
  try {
    const res = await fetch(indexUrl, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    let m;
    while ((m = hrefRe.exec(html))) {
      const title = strip(m[2]);
      if (!title || !terms.some(t => title.includes(t))) continue;
      const url = absolute(m[1]);
      if (result.rows.some(r => r.url === url)) continue;
      result.rows.push({ title, url, sourceType: '交通局公开公告', status: 'requires-manual-validation' });
    }
    result.status = 'ok';
  } catch (e) {
    result.error = String(e.message || e);
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'transport_region_info.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(DATA, 'transport_region_sources.json'), JSON.stringify({ region: REGION, source: indexUrl, fetchedAt: result.generated, rows: result.rows }, null, 2));
  console.log(`transport_region_info.json: ${result.status}, ${result.rows.length} official candidate notices`);
})().catch(e => { console.error(e); process.exit(1); });
