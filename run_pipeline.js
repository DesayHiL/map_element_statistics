// 统一入口：默认只重建本地报告链，不触发网络取数。
// 用法：node run_pipeline.js；需要重新取数时加 --with-fetch。
const { spawnSync } = require('child_process');
const path = require('path');

const fetchStages = [
  'fetch_osm.js', 'fetch_amap_elements.js', 'fetch_amap_pois.js',
  'fetch_amap_crosscheck.js', 'fetch_congestion.js', 'fetch_routes.js',
  'fetch_kuandeng_stoplines.js',
];
const buildStages = [
  'build_stats.js', 'plan_routes_v2.js', 'plan_scenario_routes_v2.js',
  'select_odd.js', 'build_report_alloc.js', 'build_odd_quota.js',
  'build_kuandeng_markings.js', 'check_stopline_signal.js',
  'build_congestion.js', 'build_congestion_ref.js', 'build_congestion_streets.js',
  'build_confidence.js', 'build_odd_dims.js', 'build_source_crosscheck.js',
  'calibrate_osm.js', 'audit_coord.js', 'build_odd_checklist.js',
  'build_odd_coverage_html.js', 'build_signal_heatmap.js', 'build_weather.js', 'tools/build_transport_road_works.js', 'tools/fetch_transport_region.js', 'tools/fetch_region_traffic.js', 'tools/verify_tunnels_amap.js', 'build_scenario_html.js', 'tools/audit_scenario_mileage.js',
  'audit_delivery.js',
];

const withFetch = process.argv.includes('--with-fetch');
const stages = withFetch ? [...fetchStages, ...buildStages] : buildStages;
for (const script of stages) {
  console.log(`\n>>> ${script}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, script)], {
    cwd: __dirname, stdio: 'inherit', windowsHide: true,
  });
  if (r.status !== 0) {
    console.error(`pipeline stopped at ${script} (exit ${r.status ?? 'signal'})`);
    process.exit(r.status || 1);
  }
}
console.log(`\nPipeline complete (${withFetch ? 'fetch + build' : 'build'}).`);
