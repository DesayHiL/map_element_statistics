// supply 侧批量绑定客户：查 viewport 内全部 PTV 站点 → 逐个绑「重庆天天鲜面店」→ 抽查核实
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const STOKEN = fs.readFileSync(path.join(ROOT, 'supply_token.txt'), 'utf8').trim();
const SP = 'https://test-supply.cxzyuan.com/basic-api/admin-api';
const H = { 'Authorization': 'Bearer ' + STOKEN, 'tenant-id': '1', 'Content-Type': 'application/json; charset=utf-8' };
const CID = '2064209631114588161';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(ep, body) { const r = await fetch(SP + ep, { method: 'POST', headers: H, body: JSON.stringify(body) }); return r.json(); }

(async () => {
  // 惠城区全域视口（覆盖 15 街道，含潼湖/潼侨的仲恺片区西侧可能超出——用大视口）
  const vp = { neLat: 23.35, neLng: 114.70, swLat: 22.90, swLng: 114.20 };
  const d = await post('/vehicle/operation-area-manage/getStationsByViewport', vp);
  const all = (d.data || []).filter(s => s.name && s.name.startsWith('PTV-区域测试-标号'));
  console.log('PTV stations found:', all.length);
  const already = all.filter(s => s.customerName && s.customerName.includes('重庆天天鲜面店'));
  const todo = all.filter(s => !s.customerName || !s.customerName.includes('重庆天天鲜面店'));
  console.log('already bound:', already.length, 'todo:', todo.length);
  let ok = 0, fail = 0;
  for (const s of todo) {
    const b = await post('/vehicle/operation-area-manage/updateStationCustomer', { stationId: s.id, customerIds: [CID] });
    if (b.code === 0) ok++; else { fail++; console.log('FAIL', s.name, JSON.stringify(b).slice(0, 80)); }
    await sleep(150);
  }
  console.log('bind done. ok=' + ok + ' fail=' + fail);
  // 抽查核实 5 个
  const re = await post('/vehicle/operation-area-manage/getStationsByViewport', vp);
  const check = (re.data || []).filter(s => s.name && s.name.startsWith('PTV-区域测试-标号'));
  const bound = check.filter(s => s.customerName && s.customerName.includes('重庆天天鲜面店'));
  console.log('verify: total=' + check.length + ' bound=' + bound.length);
  for (const m of [1, 10, 20, 30, 41]) {
    const s = check.find(x => x.name.includes('标号' + m + '-'));
    if (s) console.log(' sample', s.name.slice(0, 40), '→', s.customerName);
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
