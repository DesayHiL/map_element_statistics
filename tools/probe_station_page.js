// 用 car/station/page 拿站点管理页的行结构，找到可更新字段
const fs = require('fs');
const TOKEN = fs.readFileSync('token.txt', 'utf8').trim();
const H = { 'Authorization': 'Bearer ' + TOKEN, 'X-User-Id': '2048', 'X-Customer-Host': 'test-bluejet.cxzyuan.com', 'Content-Type': 'application/json' };
(async () => {
  // GET page（siteMana.js: i=t=>a.get({url:s+"/car/station/page",params:t})）
  const r = await fetch('https://test-bluejet.cxzyuan.com/basic-api/aid-cscm/web-api/car/station/page?pageNum=1&pageSize=5&name=' + encodeURIComponent('PTV-区域测试-路线2'), { headers: H });
  const j = await r.json();
  console.log('code:', j.code);
  if (j.code === 200 || j.code === 0) {
    const rows = (j.data && (j.data.records || j.data.list || (Array.isArray(j.data) ? j.data : null))) || [];
    console.log('rows:', rows.length);
    if (rows.length) console.log('字段:', Object.keys(rows[0]).join(', '));
    if (rows.length) console.log('样例:', JSON.stringify(rows[0]).slice(0, 600));
  } else console.log(JSON.stringify(j).slice(0, 300));
})();