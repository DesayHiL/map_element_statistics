const fs = require('fs');
const path = require('path');
const { KEYS } = require('./amap_key.js');

(async () => {
  const result = { status: 'error', generated: new Date().toISOString(), city: '441302', forecasts: [] };
  try {
    const url = `https://restapi.amap.com/v3/weather/weatherInfo?key=${KEYS[0]}&city=441302&extensions=all`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const json = await response.json();
    if (json.status === '1' && json.forecasts) {
      result.status = 'ok';
      result.reporttime = json.forecasts[0]?.reporttime;
      result.forecasts = json.forecasts[0]?.casts || [];
    } else {
      result.error = json.info || '高德天气接口未返回预报';
    }
  } catch (error) {
    result.error = String(error.message || error);
  }
  fs.writeFileSync(path.join(__dirname, 'out', 'weather_forecast.json'), JSON.stringify(result, null, 2));
  console.log(`weather_forecast.json: amap=${result.status}, days=${result.forecasts.length}`);
})().catch(() => process.exit(1));
