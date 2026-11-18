// 抓取全部候选答复正文，筛交通/道路/隐患相关，提取路段信息
const fs = require('fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0';
const d = JSON.parse(fs.readFileSync('d:/workspace/map_element_statistics/data/_hcq_candidate_posts.json', 'utf8'));
const targets = d.filter(x => /答复/.test(x.title) || /隐患|事故|堵点|严管/.test(x.title + (x.kw || '')));

function extract(html) {
  const t = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&ldquo;|&rdquo;/g, '"').replace(/&mdash;/g, '—').replace(/&hellip;/g, '…')
    .replace(/<[^>]+>/g, '\n').replace(/\n{2,}/g, '\n');
  // 正文在 ArticleTitle 后：从"："或代表/委员称呼开始截
  const i = t.indexOf('发布日期');
  const body = t.slice(i, i + 5000);
  const title = (html.match(/<meta name="ArticleTitle" content="([^"]+)"/) || [])[1] || '';
  const pub = (html.match(/<meta name="PubDate"\s*content="([^"]+)"/) || [])[1] || '';
  return { title, pub, body };
}

(async () => {
  const out = [];
  let done = 0;
  for (const x of targets) {
    try {
      const r = await fetch(x.url, { headers: { 'User-Agent': UA } });
      const h = await r.text();
      const e = extract(h);
      if (e.body) out.push({ ...x, ...e });
    } catch (err) { out.push({ ...x, error: String(err).slice(0, 80) }); }
    done++;
    if (done % 20 === 0) {
      fs.writeFileSync('d:/workspace/map_element_statistics/data/_hcq_reply_bodies.json', JSON.stringify(out, null, 2), 'utf8');
      console.log('progress', done, '/', targets.length);
    }
  }
  fs.writeFileSync('d:/workspace/map_element_statistics/data/_hcq_reply_bodies.json', JSON.stringify(out, null, 2), 'utf8');
  console.log('done', out.length);
})();