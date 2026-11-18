// 清理 PTV 历史残留站点：保留今日重建的（新坐标），删 stationId 以 211544 开头的旧批（用行 id 删）
const fs = require('fs');
const T = () => fs.readFileSync('token.txt', 'utf8').trim();
const H = () => ({ Authorization: 'Bearer ' + T(), 'X-User-Id': '2048', 'X-Customer-Host': 'test-bluejet.cxzyuan.com', 'Content-Type': 'application/json; charset=utf-8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BJ = 'https://test-bluejet.cxzyuan.com/basic-api/aid-cscm/web-api';

(async () => {
  let all = [], p = 1;
  while (true) {
    const j = await (await fetch(BJ + '/strategy/station/list', { method: 'POST', headers: H(), body: JSON.stringify({ pageNum: p, pageSize: 200 }) })).json();
    if (j.code !== 200 || !j.data || !j.data.length) break;
    all = all.concat(j.data);
    if (all.length >= 5000) break;
    p++;
  }
  const ptv = all.filter((s) => /PTV-区域测试/.test(s.stationName || ''));
  const stale = ptv.filter((s) => String(s.stationId).startsWith('211544')); // 旧批前缀
  console.log('PTV 总数:', ptv.length, '旧批待删:', stale.length, '保留(今日):', ptv.length - stale.length);
  let ok = 0, fail = 0;
  for (const s of stale) {
    const d = await (await fetch(BJ + '/strategy/station/delete', { method: 'POST', headers: H(), body: JSON.stringify({ id: s.id }) })).json();
    if (d.code === 200) ok++; else { fail++; if (fail <= 5) console.log('  FAIL', s.id, s.stationName, d.msg); }
    await sleep(120);
  }
  console.log('删除完成 ok=' + ok + ' fail=' + fail);
  // 复查
  let chk = [], p2 = 1;
  while (true) {
    const j = await (await fetch(BJ + '/strategy/station/list', { method: 'POST', headers: H(), body: JSON.stringify({ pageNum: p2, pageSize: 200 }) })).json();
    if (j.code !== 200 || !j.data || !j.data.length) break;
    chk = chk.concat(j.data);
    if (chk.length >= 5000) break;
    p2++;
  }
  const rest = chk.filter((s) => /PTV-区域测试/.test(s.stationName || ''));
  const names = {};
  for (const s of rest) names[s.stationName] = (names[s.stationName] || 0) + 1;
  const dup = Object.values(names).filter((v) => v > 1).length;
  console.log('复查: PTV 站点', rest.length, '重名:', dup);
})();