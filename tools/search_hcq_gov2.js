// 枚举 hcq.gov.cn 全部惠城站点，检索建议/提案答复+交通隐患文章，保存候选清单
const fs = require('fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0';

async function searchSite(sid, text, page, pagesize = 30) {
  const q = encodeURIComponent(text);
  const url = `https://search.gd.gov.cn/jsonp/site/${sid}?page=${page}&pagesize=${pagesize}&isgkml=1&text=${q}&order=0&including_url_doc=1&including_attach_doc=1&callback=cb`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'http://www.hcq.gov.cn/gkmlpt/index' } });
  const t = await r.text();
  try {
    const j = JSON.parse(t.replace(/^cb\(/, '').replace(/\)$/, ''));
    return { count: j.count || 0, results: j.results || [] };
  } catch (e) { return { count: 0, results: [], err: true }; }
}

(async () => {
  const raw = fs.readFileSync('C:/Users/uid06419/AppData/Local/Temp/allsite.txt', 'utf8');
  const sidMap = {};
  [...raw.matchAll(/[\s{,](?:"id"|id|site|"site")\s*:\s*"?(\d{4,8})"?[^{}]*?(hcq\.gov\.cn[^"\\,}]*)/g)].forEach(m => { if (!sidMap[m[1]]) sidMap[m[1]] = m[2].replace(/\\\//g, '/'); });
  console.log('惠城站点数:', Object.keys(sidMap).length);

  const KWS = ['答复 道路', '答复 交通', '隐患路口'];
  const hits = new Map();
  for (const [sid, domain] of Object.entries(sidMap)) {
    if (Number(sid) < Number(process.env.SKIP_BELOW||0)) continue;
    for (const kw of KWS) {
      const r = await searchSite(sid, kw, 1);
      r.results.forEach(x => {
        const u = x.url;
        if (!hits.has(u) && /content\/\d+\/\d+\/post_\d+\.html/.test(u)) hits.set(u, { title: x.title.replace(/<[^>]+>/g, ''), sid, kw, url: u });
      });
      if (r.count > 30) {
        const pages = Math.min(5, Math.ceil(r.count / 30));
        for (let p = 2; p <= pages; p++) {
          const r2 = await searchSite(sid, kw, p);
          r2.results.forEach(x => { const u = x.url; if (!hits.has(u) && /content\/\d+\/\d+\/post_\d+\.html/.test(u)) hits.set(u, { title: x.title.replace(/<[^>]+>/g, ''), sid, kw, url: u }); });
        }
      }
    }
    if (Object.keys(sidMap).indexOf(sid) % 5 === 0) console.log(`progress site ${sid}: total ${hits.size}`);
    // 中途也保存，防超时丢数据
    {const fp='d:/workspace/map_element_statistics/data/_hcq_candidate_posts.json';let old=[];try{old=JSON.parse(fs.readFileSync(fp,'utf8'))}catch(e){}const m=new Map(old.map(x=>[x.url,x]));[...hits.values()].forEach(x=>m.set(x.url,x));fs.writeFileSync(fp,JSON.stringify([...m.values()],null,2),'utf8');}
  }
  {const fp='d:/workspace/map_element_statistics/data/_hcq_candidate_posts.json';let old=[];try{old=JSON.parse(fs.readFileSync(fp,'utf8'))}catch(e){}const m=new Map(old.map(x=>[x.url,x]));[...hits.values()].forEach(x=>m.set(x.url,x));fs.writeFileSync(fp,JSON.stringify([...m.values()],null,2),'utf8');}
  console.log('candidates saved:', hits.size);
})();