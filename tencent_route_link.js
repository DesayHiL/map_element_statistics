const r = {
  "route": "PTV-区域测试-路线28-陈江街道",
  "from": { "name": "德赛西威惠南工业园", "coord": "23.000014,114.481764" },
  "passes": [
    { "name": "湖溪大道", "coord": "23.088387,114.451682" },
    { "name": "惠泽大道", "coord": "23.103806,114.485055" },
    { "name": "东新大道", "coord": "23.116904,114.570669" },
    { "name": "东锦南路", "coord": "23.117258,114.552747" }
  ],
  "to": { "name": "湖滨路", "coord": "23.105665,114.468859" },
};

// H5/PC 网页版链接：途经点用 via 参数（lat,lng 分号分隔）
const via = r.passes.map(p => p.coord).join(';');
const h5 = `https://apis.map.qq.com/uri/v1/routeplan?type=drive`
  + `&from=${encodeURIComponent(r.from.name)}&fromcoord=${r.from.coord}`
  + `&to=${encodeURIComponent(r.to.name)}&tocoord=${r.to.coord}`
  + `&via=${via}`
  + `&policy=1&referer=OB4BZ-D4W3U-B7VVO-4PJWW-6TKDJ-WPB77`;

// 手机 APP scheme：途经点用 passes 参数（name:xx;coord:lat,lng 竖线分隔，末尾也带 |）
const passes = r.passes.map(p => `name:${p.name};coord:${p.coord}`).join('|') + '|';
const app = `qqmap://map/routeplan?type=drive`
  + `&from=${encodeURIComponent(r.from.name)}&fromcoord=${r.from.coord}`
  + `&to=${encodeURIComponent(r.to.name)}&tocoord=${r.to.coord}`
  + `&passes=${encodeURIComponent(passes)}`
  + `&policy=1&referer=OB4BZ-D4W3U-B7VVO-4PJWW-6TKDJ-WPB77`;

console.log('H5 网页版（浏览器打开）:\n' + h5 + '\n');
console.log('APP 调起（手机打开）:\n' + app + '\n');
