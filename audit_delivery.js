const fs = require('fs');
const path = require('path');

const root = __dirname;
const readOut = name => JSON.parse(fs.readFileSync(path.join(root, 'out', name), 'utf8'));
const files = ['odd_coverage.html', 'scenario_tests.html'];
const alloc = readOut('report_alloc.json');
const fail = [];

for (const file of files) {
  const filePath = path.join(root, 'out', file);
  if (!fs.existsSync(filePath)) {
    fail.push(`${file} missing`);
    continue;
  }
  const html = fs.readFileSync(filePath, 'utf8');
  const totalKmPlain = String(alloc.totalKm);
  const totalKmGrouped = Number(alloc.totalKm).toLocaleString('en-US');
  if (!html.includes(totalKmPlain) && !html.includes(totalKmGrouped)) {
    fail.push(`${file} missing totalKm ${alloc.totalKm}`);
  }
}

for (const file of ['report_draft.html', 'report_brief.html']) {
  if (fs.existsSync(path.join(root, 'out', file))) fail.push(`${file} should be retired`);
}

const weak = readOut('signal_weak_routes.json');
const weather = readOut('weather_forecast.json');
const scenarioHtml = fs.readFileSync(path.join(root, 'out', 'scenario_tests.html'), 'utf8');
if (!scenarioHtml.includes('网络弱覆盖路线')) fail.push('scenario page missing weak-network card');
if (!scenarioHtml.includes('恶劣天气路线')) fail.push('scenario page missing bad-weather card');
if (!Number.isFinite(weak.routeWeakHits)) fail.push('signal weak result invalid');
if (!['ok', 'error'].includes(weather.status)) fail.push('weather result invalid');

console.log(`delivery audit: ${fail.length ? 'FAIL' : 'OK'}`);
if (fail.length) {
  for (const item of fail) console.log(`  - ${item}`);
  process.exit(1);
}
console.log(`  two delivery pages, total ${alloc.totalKm}km, weak-net hits ${weak.routeWeakHits}, weather ${weather.status}`);
