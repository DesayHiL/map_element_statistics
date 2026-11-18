// 直接抓惠州交警信息网严管路通告原文（WebFetch 404，用 node fetch + 简易去 HTML）。
const url = 'https://hzgajj.huizhou.gov.cn/zwgk/bmwj/tzgg/content/post_5886610.html';
(async () => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  console.log('HTTP', res.status);
  const html = await res.text();
  // 去脚本/样式/标签
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  // 只打印含"路/大道/通告/严管"的正文段
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const start = lines.findIndex(l => l.includes('通告') || l.includes('严管'));
  console.log(lines.slice(Math.max(0, start - 2), start + 120).join('\n'));
})();