// 核对：严管路条数与通告原文逐段重数（fetch_strict_roads.js 抓到的正文）：
//   第1段 17 / 第2段 29 / 第3段 22 / 第4段(仲恺) 30 / 机场 4
//   = 惠城区主体 68 + 仲恺跨界 30 + 机场 4，合计 102。与 JSON 一致即 PASS。
const fs = require('fs');
const j = JSON.parse(fs.readFileSync('data/huizhou_accident_risk_zones.json', 'utf8'));
const counts = j.strictRoads.groups.map((g) => g.roads.length);
const expect = [17, 29, 22, 30];
const ok = counts.every((c, i) => c === expect[i]) && j.strictRoads.airport.length === 4;
console.log('各组条数:', counts.join('/'), '（期望 ' + expect.join('/') + '）');
console.log('机场条数:', j.strictRoads.airport.length, '（期望 4）');
console.log('惠城区主体:', counts[0] + counts[1] + counts[2], '条；仲恺跨界:', counts[3], '条');
const all = j.strictRoads.groups.flatMap((g) => g.roads);
const dup = all.filter((r, i) => all.indexOf(r) !== i);
console.log('组间重复:', dup.length ? dup.join(',') : '无');
console.log(ok && !dup.length ? 'PASS：数据层与通告原文一致' : 'FAIL');
process.exit(ok && !dup.length ? 0 : 1);
