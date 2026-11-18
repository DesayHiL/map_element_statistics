// 区域交通信息来源与接口目录。这里只登记可核验来源，不把未验证的动态事件写入报告。
const REGION = {
  city: '惠州市',
  district: '惠城区',
  adcode: '441302',
  bbox: '114.09,22.86,114.58,23.25',
};

const SOURCES = [
  {
    key: 'transport-bureau-notices', label: '惠州市交通运输局公告', kind: 'official',
    purpose: '来源备注：惠州市交通运输局公告索引；施工计划需出车前现场确认。',
    url: 'http://jtj.huizhou.gov.cn/zwgk/bmwj/tzgg/index.html',
    query: { region: '惠城区', index: true, keywords: ['施工', '占用', '挖掘', '道路计划', '道路养护', '道路改造'] },
    accepted: ['planned-road-works'],
  },
  {
    key: 'amap-traffic-status', label: '高德实时交通态势', kind: 'api',
    purpose: '来源备注：高德 Traffic API 实时快照；不提供历史施工时间。',
    url: 'https://restapi.amap.com/v3/traffic/status/rectangle',
    query: { adcode: REGION.adcode, rectangle: REGION.bbox, level: 5 },
    accepted: ['congestion-snapshot'],
  },
  {
    key: 'baidu-traffic-api', label: '百度实时路况 / 动态交通事件', kind: 'api',
    purpose: '来源备注：百度地图开放平台；需 BAIDU_AK、权限和原始响应核验。',
    url: 'https://lbsyun.baidu.com/faq/api?title=webapi/trafficaccident',
    query: { rectangle: REGION.bbox, requireAk: true, requirePermission: true },
    accepted: ['only-after-source-validation'],
  },
  {
    key: 'amap-weather', label: '高德天气预报', kind: 'api',
    purpose: '来源备注：高德天气 API；用于天气触发，不代表现场实况。',
    url: 'https://restapi.amap.com/v3/weather/weatherInfo',
    query: { city: REGION.adcode, extensions: 'all' },
    accepted: ['weather-trigger'],
  },
  {
    key: 'cellular-heatmap', label: '运营商/网络信号热力数据', kind: 'local-data',
    purpose: '来源备注：本地运营商/网络热力数据；最终以 Cellular-Z 现场 RSRP/SINR 为准。',
    url: null,
    query: { region: REGION.district, source: 'local-heatmap' },
    accepted: ['weak-network-candidate'],
  },
];

module.exports = { REGION, SOURCES };
