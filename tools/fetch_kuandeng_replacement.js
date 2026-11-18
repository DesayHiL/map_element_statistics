// OSM 替换数据源抽取：
//   signals_kd   ← 宽凳灯控停止线（is_light=1，每个灯控路口一处）—— 替换 OSM traffic_signals
//   roundabout_kd ← 宽凳 LINK_TYPE=4 环岛（取几何中点）—— 替换 OSM junction=roundabout
// 输出 data/kuandeng_signals.json / data/kuandeng_roundabouts.json（WGS-84，node 格式，
// 与 build_stats / build_odd_quota 的 file 分支兼容）
const fs = require('fs'); const path = require('path'); const K = require('../lib_kuandeng');
const KD = K.KD;

function main(){
  // 1) 灯控停止线 → signals_kd（直接从 data/kuandeng_stoplines.json 过滤）
  const sl = JSON.parse(fs.readFileSync('data/kuandeng_stoplines.json','utf8'));
  const light = sl.elements.filter(e=>e.tags && e.tags.is_light==='1');
  fs.writeFileSync('data/kuandeng_signals.json', JSON.stringify({
    version:0.1, generator:'fetch_kuandeng_replacement.js', crs:'WGS-84',
    source:'data/kuandeng_stoplines.json (宽凳 STOPLINE IS_LIGHT=1)',
    fetchedAt:new Date().toISOString(),
    note:'红绿灯路口真值：宽凳灯控停止线（每处灯控路口至少一条 is_light=1 停止线）。替换 OSM traffic_signals（1601 个众包点）。',
    elements: light.map((e,i)=>({type:'node', id:i+1, lat:e.lat, lon:e.lon,
      tags:{kuandeng:'signal_stopline', is_light:'1', mark_type:e.tags.mark_type}}))}));
  console.log('灯控信号（停止线代理）:', light.length);

  // 2) 环岛：ROAD_LINK.shp + dbf LINK_TYPE=4 → 几何中点
  function dbfMeta(p){
    const fd=fs.openSync(p,'r'); const hb=Buffer.alloc(2048); fs.readSync(fd,hb,0,2048,0); fs.closeSync(fd);
    const nrec=hb.readUInt32LE(4), hsz=hb.readUInt16LE(8), rsz=hb.readUInt16LE(10);
    const fl=[]; let off=32;
    while(off<hsz&&hb[off]!==0x0d){fl.push({name:hb.slice(off,off+11).toString('latin1').replace(/\0.*$/,''),len:hb[off+16]});off+=32;}
    const pos={}; let base=1; fl.forEach(x=>{pos[x.name]=base;base+=x.len;});
    return {nrec,hsz,rsz,fl,pos};
  }
  const rm = dbfMeta(path.join(KD,'ROAD_LINK.dbf'));
  const fd=fs.openSync(path.join(KD,'ROAD_LINK.dbf'),'r'); const CH=1<<22, buf=Buffer.alloc(CH);
  const rbRows=[]; let done=0, at=rm.hsz;
  const LT = rm.fl.find(f=>f.name==='LINK_TYPE');
  while(done<rm.nrec){
    const w=Math.min(CH,rm.rsz*Math.min(8192,rm.nrec-done));
    const got=fs.readSync(fd,buf,0,w,at); if(!got)break;
    const n=Math.floor(got/rm.rsz);
    for(let i=0;i<n;i++){
      const lt=buf.toString('latin1',i*rm.rsz+rm.pos.LINK_TYPE,i*rm.rsz+rm.pos.LINK_TYPE+LT.len).trim();
      if(lt==='4')rbRows.push(done+i);
    }
    at+=n*rm.rsz; done+=n;
  }
  fs.closeSync(fd);
  console.log('环岛 link 行数:', rbRows.length);

  const shpF=fs.openSync(path.join(KD,'ROAD_LINK.shp'),'r'), shxF=fs.openSync(path.join(KD,'ROAD_LINK.shx'),'r');
  const ix=Buffer.alloc(8); const els=[];
  let k=0;
  for(const row of rbRows){
    fs.readSync(shxF,ix,0,8,100+row*8);
    const off=ix.readUInt32BE(0)*2; if(off<100)continue;
    const rh=Buffer.alloc(108); if(fs.readSync(shpF,rh,0,108,off)<108)continue;
    if(rh.readInt32LE(8)!==3)continue;
    const nParts=rh.readInt32LE(8+36), nPts=rh.readInt32LE(8+40);
    if(nParts<1||nPts<2||nPts>20000)continue;
    const xyOff=off+8+44+4*nParts; const gb=Buffer.alloc(nPts*16);
    if(fs.readSync(shpF,gb,0,nPts*16,xyOff)<nPts*16)continue;
    let mx=0,my=0;
    for(let p=0;p<nPts;p++){mx+=gb.readDoubleLE(p*16);my+=gb.readDoubleLE(p*16+8);}
    mx/=nPts; my/=nPts;
    els.push({type:'node', id:++k, lat:+my.toFixed(7), lon:+mx.toFixed(7),
      tags:{kuandeng:'roundabout', link_type:'4'}});
  }
  fs.closeSync(shpF); fs.closeSync(shxF);
  fs.writeFileSync('data/kuandeng_roundabouts.json', JSON.stringify({
    version:0.1, generator:'fetch_kuandeng_replacement.js', crs:'WGS-84',
    source:KD+' ROAD_LINK LINK_TYPE=4',
    fetchedAt:new Date().toISOString(),
    note:'环岛真值：宽凳 ROAD_LINK.LINK_TYPE=4（几何中点）。替换 OSM junction=roundabout（仅 12 处）。',
    elements:els}));
  console.log('环岛落盘:', els.length);
}
main();
