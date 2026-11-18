const fs = require('fs');
const data = JSON.parse(fs.readFileSync('d:/workspace/map_element_statistics/out/routes.json', 'utf8'));
const routes = data;
console.log(`总数：${routes.length}`);
const dists = routes.map(r => r.distKm).sort((a,b) => a-b);
console.log(`最短10条：${dists.slice(0,10).join(',')}`);
console.log(`最长10条：${dists.slice(-10).join(',')}`);
console.log(`总里程：${dists.reduce((a,b)=>a+b, 0)}`);
console.log(`每条的主要字段示例：id=${routes[0].id}, name=${routes[0].name}, kind=${routes[0].kind}, stops=${routes[0].stops ? routes[0].stops.length : 0}, legs=${routes[0].legs ? routes[0].legs.length :0}, distKm=${routes[0].distKm}`);