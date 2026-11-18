const fs = require('fs');
const https = require('https');
const token = fs.readFileSync('token.txt', 'utf8').trim();

function post(host, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: host, path: '/basic-api/aid-cscm/web-api/strategy/station/list',
      method: 'POST', headers: {
        'Authorization': 'Bearer ' + token,
        'X-User-Id': '2048',
        'X-Customer-Host': host,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error(host + ' HTTP' + res.statusCode + ' ' + buf.slice(0, 200))); } });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

(async () => {
  const t = await post('test-bluejet.cxzyuan.com', { pageNum: 1, pageSize: 500 });
  const p = await post('bluejet.cxzyuan.com', { pageNum: 1, pageSize: 500 });
  const g = j => (j.data && (j.data.records || j.data.list)) || [];
  const gt = g(t), gp = g(p);
  console.log('test code:', t.code, t.code === 0 ? 'OK' : JSON.stringify(t.msg || t.message));
  console.log('prod code:', p.code, p.code === 0 ? 'OK' : JSON.stringify(p.msg || p.message));
  console.log('test total:', gt.length, 'prod total:', gp.length);
  const pt = new Set(gt.map(r => r.name));
  const pp = new Set(gp.map(r => r.name));
  const onlyProd = [...pp].filter(n => !pt.has(n));
  const onlyTest = [...pt].filter(n => !pp.has(n));
  console.log('\n--- 仅生产环境有（需同步到测试）: ' + onlyProd.length + ' 个');
  onlyProd.forEach(n => console.log(' ', n));
  console.log('\n--- 仅测试环境有: ' + onlyTest.length + ' 个');
  onlyTest.forEach(n => console.log(' ', n));
  // 两边都有但坐标/地址可能不同的
  const byName = a => Object.fromEntries(a.map(r => [r.name, r]));
  const bt = byName(gt), bp = byName(gp);
  let diff = 0;
  for (const n of pp) if (pt.has(n)) {
    const a = bt[n], b = bp[n];
    if (Math.abs((a.lng||0)-(b.lng||0)) > 1e-6 || Math.abs((a.lat||0)-(b.lat||0)) > 1e-6 || (a.address||'') !== (b.address||'')) {
      diff++; console.log('差异:', n, 'test:', a.lng, a.lat, a.address, '| prod:', b.lng, b.lat, b.address);
    }
  }
  console.log('\n共名站点中内容差异:', diff, '个');
  fs.writeFileSync('out/site_diff.json', JSON.stringify({ prod: gp, test: gt }, null, 2));
  console.log('完整数据已存 out/site_diff.json');
})();