// 检索 search.gd.gov.cn/jsonp 上的惠城区系列站点，收集"交通隐患/事故多发/建议提案答复"文章
const fs = require('fs');
const SID = { hcq_main: '752034', hcq_gaj: '752072', hcq_jtysj: '752386' };
const KW = ['人大代表建议 答复 交通', '提案 答复 道路', '建议 答复 路段', '堵点 治理', '事故隐患 路段 答复', '公路 改造 建议', '校门口 交通安全 答复'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0';

async function search(sid, text, page) {
  const q = encodeURIComponent(text);
  const url = `https://search.gd.gov.cn/jsonp/site/${sid}?page=${page}&pagesize=20&isgkml=1&text=${q}&order=0&including_url_doc=1&including_attach_doc=1&callback=cb`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'http://www.hcq.gov.cn/gkmlpt/index' } });
  const t = await r.text();
  try {
    const j = JSON.parse(t.replace(/^cb\(/, '').replace(/\)$/, ''));
    return { total: j.total, results: (j.results || []).map(x => ({ title: (x.title || '').replace(/<[^>]+>/g, ''), url: x.url, content: (x.content || '').replace(/<[^>]+>/g, '').slice(0, 120), date: x.date || x.pub_date || '' })) };
  } catch (e) { return { total: 0, results: [], err: t.slice(0, 100) }; }
}

(async () => {
  const out = [];
  for (const [name, sid] of Object.entries(SID)) {
    for (const kw of KW) {
      const r = await search(sid, kw, 1);
      console.log(`[${name}] "${kw}" total=${r.total}`);
      if (r.err) console.log('  ERR:', r.err);
      r.results.forEach(x => { console.log(`   - ${x.title} | ${x.url}`); out.push({ site: name, kw, ...x }); });
      // 翻页取前3页
      if (false) {
        for (let p = 2; p <= Math.min(3, Math.ceil(r.total / 20)); p++) {
          const r2 = await search(sid, kw, p);
          r2.results.forEach(x => { console.log(`   (p${p}) - ${x.title} | ${x.url}`); out.push({ site: name, kw, ...x }); });
        }
      }
    }
  }
  fs.writeFileSync('d:/workspace/map_element_statistics/data/_hcq_search_results.json', JSON.stringify(out, null, 2), 'utf8');
  console.log('saved', out.length, 'items');
})();