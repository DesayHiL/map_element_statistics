// 校核场景加跑里程：场景去程/返程快照 -> report_alloc.json。
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'out');
const read = n => JSON.parse(fs.readFileSync(path.join(OUT, n + '.json'), 'utf8'));
const routes = read('routes');
const ret = read('route_return_legs');
const alloc = read('report_alloc');
const ok = (routes.scenarioRoutes || []).filter(x => x.status === 'ok');
const fwdKm = ok.reduce((s, x) => s + Number(x.distKm || 0), 0);
const revKm = Number(ret.totals && ret.totals.scenRevKm || 0);
const expected = +(2 * (fwdKm + revKm)).toFixed(1);
const actual = Number(alloc.scenKm);
const delta = +(actual - expected).toFixed(1);
const result = { generated: new Date().toISOString(), scenarioCount: ok.length, fwdKm: +fwdKm.toFixed(1), revKm, expectedScenKm: expected, reportAllocScenKm: actual, deltaKm: delta, status: Math.abs(delta) <= 1 ? 'ok' : 'mismatch', scenarios: ok.map(x => ({ scenario: x.scenario, distKm: x.distKm })) };
fs.writeFileSync(path.join(OUT, 'scenario_mileage_audit.json'), JSON.stringify(result, null, 2));
console.log(`scenario mileage: ${result.status} · fwd ${result.fwdKm} + rev ${result.revKm} · expected ${expected} vs report_alloc ${actual} · delta ${delta}km`);
if (result.status !== 'ok') process.exit(2);
