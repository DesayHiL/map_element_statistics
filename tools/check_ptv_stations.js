const fs = require('fs');
const T = fs.readFileSync('token.txt', 'utf8').trim();
(async () => {
  let all = [], p = 1;
  while (p <= 30) {
    const j = await (await fetch('https://test-bluejet.cxzyuan.com/basic-api/aid-cscm/web-api/strategy/station/list', { method: 'POST', headers: { Authorization: 'Bearer ' + T, 'X-User-Id': '2048', 'Content-Type': 'application/json' }, body: JSON.stringify({ pageNum: p, pageSize: 200 }) })).json();
    if (j.code !== 200 || !j.data || !j.data.length) break;
    all = all.concat(j.data); p++;
  }
  const ptv = all.filter((s) => /PTV-区域测试/.test(s.stationName || ''));
  const uniq = {}; for (const s of ptv) uniq[s.stationId] = s;
  const u = Object.values(uniq);
  console.log('唯一 PTV:', u.length, '| 旧批(211544)残留:', u.filter((s) => String(s.stationId).startsWith('211544')).length, '| 新批(211562):', u.filter((s) => String(s.stationId).startsWith('211562')).length);
  const names = {}; for (const s of u) names[s.stationName] = (names[s.stationName] || 0) + 1;
  console.log('重名:', Object.values(names).filter((v) => v > 1).length);
})();