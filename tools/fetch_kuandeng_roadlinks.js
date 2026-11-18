// OSM 路网来源替换：宽凳 ROAD_LINK 全表里程统计
//   - 从内网 UNC 直读 ROAD_LINK.dbf（198,459 条），按 LINK_TYPE / OWNER_SHIP / LANE_NUM
//     汇总里程与条数，并给每条 link 的几何中点（node 格式，WGS-84，与 file 分支兼容）
//   - 产出 data/kuandeng_roadlinks.json：
//       summary: { totalKm, byLinkType, byOwnerShip, byLaneNum, records }
//       elements: 内部道路（OWNER_SHIP=2）中点打点用；普通 link 量大不落 elements
//   - 用途：odd_checklist 1.1「城市路网」「县乡/乡村道路」两行的宽凳来源证据。
//     宽凳无 road_class 等级字段 → 分级仍由 OSM 提供，本快照给总里程与构成。
const fs = require('fs'); const path = require('path');
const K = require('../lib_kuandeng');
const KD = K.KD;

function dbfMeta(p){
  const fd=fs.openSync(p,'r'); const hb=Buffer.alloc(2048); fs.readSync(fd,hb,0,2048,0); fs.closeSync(fd);
  const nrec=hb.readUInt32LE(4), hsz=hb.readUInt16LE(8), rsz=hb.readUInt16LE(10);
  const fl=[]; let off=32;
  while(off<hsz&&hb[off]!==0x0d){fl.push({name:hb.slice(off,off+11).toString('latin1').replace(/\0.*$/,''),len:hb[off+16]});off+=32;}
  const pos={}; let base=1; fl.forEach(x=>{pos[x.name]=base;base+=x.len;});
  return {nrec,hsz,rsz,fl,pos};
}

// SHX/SHP 读单条折线中点（type=3 polyline）
const shpF=fs.openSync(path.join(KD,'ROAD_LINK.shp'),'r'), shxF=fs.openSync(path.join(KD,'ROAD_LINK.shx'),'r');
function midpointOf(row){
  const ix=Buffer.alloc(8); fs.readSync(shxF,ix,0,8,100+row*8);
  const off=ix.readUInt32BE(0)*2; if(off<100)return null;
  const rh=Buffer.alloc(108); if(fs.readSync(shpF,rh,0,108,off)<108)return null;
  if(rh.readInt32LE(8)!==3)return null;
  const nParts=rh.readInt32LE(8+36), nPts=rh.readInt32LE(8+40);
  if(nParts<1||nPts<2||nPts>20000)return null;
  const xyOff=off+8+44+4*nParts; const gb=Buffer.alloc(nPts*16);
  if(fs.readSync(shpF,gb,0,nPts*16,xyOff)<nPts*16)return null;
  // 弧长中点
  let total=0; const cum=[0];
  for(let i=1;i<nPts;i++){
    const x0=gb.readDoubleLE((i-1)*16),y0=gb.readDoubleLE((i-1)*16+8),x1=gb.readDoubleLE(i*16),y1=gb.readDoubleLE(i*16+8);
    total+=Math.hypot(x1-x0,y1-y0); cum.push(total);
  }
  const half=total/2; let j=1; while(j<nPts&&cum[j]<half)j++;
  const t=(half-cum[j-1])/((cum[j]-cum[j-1])||1);
  const x0=gb.readDoubleLE((j-1)*16),y0=gb.readDoubleLE((j-1)*16+8),x1=gb.readDoubleLE(j*16),y1=gb.readDoubleLE(j*16+8);
  return [x0+(x1-x0)*t, y0+(y1-y0)*t];
}

function main(){
  const p=path.join(KD,'ROAD_LINK.dbf');
  const m=dbfMeta(p);
  const LT=m.fl.find(f=>f.name==='LINK_TYPE'), OS=m.fl.find(f=>f.name==='OWNER_SHIP'),
        LN=m.fl.find(f=>f.name==='LENGTH'), LB=m.fl.find(f=>f.name==='IS_BIDIR');
  const fd=fs.openSync(p,'r'); const CH=1<<22, buf=Buffer.alloc(CH);
  let done=0, at=m.hsz;
  const byLinkType={}, byOwnerShip={}, byLaneNum={}; let totalKm=0;
  const innerRoads=[]; // OWNER_SHIP=2 中点（打点/聚类可复用，数量小 3k 级）
  const linkTypeLabel={ '1':'普通','2':'路口内','3':'右转专用','4':'环岛' };
  while(done<m.nrec){
    const w=Math.min(CH,m.rsz*Math.min(8192,m.nrec-done));
    const got=fs.readSync(fd,buf,0,w,at); if(!got)break;
    const n=Math.floor(got/m.rsz);
    for(let i=0;i<n;i++){
      const b=i*m.rsz, row=done+i;
      const lt=buf.toString('latin1',b+m.pos.LINK_TYPE,b+m.pos.LINK_TYPE+LT.len).trim();
      const os=buf.toString('latin1',b+m.pos.OWNER_SHIP,b+m.pos.OWNER_SHIP+OS.len).trim();
      const ln=buf.toString('latin1',b+m.pos.LENGTH,b+m.pos.LENGTH+LN.len).trim();
      const bidir=buf.toString('latin1',b+m.pos.IS_BIDIR,b+m.pos.IS_BIDIR+LB.len).trim();
      const lenM=parseFloat(ln)||0; totalKm+=lenM;
      byLinkType[lt]=byLinkType[lt]||{n:0,km:0,bidirKm:0}; byLinkType[lt].n++; byLinkType[lt].km+=lenM; if(bidir!=='0')byLinkType[lt].bidirKm+=lenM;
      byOwnerShip[os]=byOwnerShip[os]||{n:0,km:0}; byOwnerShip[os].n++; byOwnerShip[os].km+=lenM;
      const lanes=buf.toString('latin1',b+m.pos.LANE_NUM,b+m.pos.LANE_NUM+m.fl.find(f=>f.name==='LANE_NUM').len).trim()||'?';
      byLaneNum[lanes]=byLaneNum[lanes]||{n:0,km:0}; byLaneNum[lanes].n++; byLaneNum[lanes].km+=lenM;
      if(os==='2'&&innerRoads.length<20000){
        const mp=midpointOf(row);
        if(mp)innerRoads.push({type:'node',id:innerRoads.length+1,lon:mp[0],lat:mp[1],
          tags:{kuandeng:'inner_road',owner_ship:'2',link_type:lt}});
      }
    }
    at+=n*m.rsz; done+=n;
  }
  fs.closeSync(fd); fs.closeSync(shpF); fs.closeSync(shxF);

  const r1=(x)=>Math.round(x/100)/10; // m → km 1位小数
  const pack=(o)=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,{n:v.n,km:r1(v.km),...(v.bidirKm!==undefined?{bidirKm:r1(v.bidirKm)}:{})}]));
  const out={
    version:0.1, generator:'tools/fetch_kuandeng_roadlinks.js', crs:'WGS-84',
    source:KD+' ROAD_LINK.dbf (宽凳 441302 惠城区 2026-09-11 批)',
    fetchedAt:new Date().toISOString(),
    note:'宽凳 ROAD_LINK 全表里程统计。宽凳无道路等级(road_class)字段：LINK_TYPE 仅 普通/路口内/右转专用/环岛，分级仍由 OSM 提供；本快照供 odd_checklist 1.1 路网行作宽凳来源证据（总里程/构成/内部道路）。内部道路中点打点见 elements。',
    summary:{
      records:m.nrec, totalKm:r1(totalKm),
      byLinkType:pack(byLinkType), byOwnerShip:pack(byOwnerShip), byLaneNum:pack(byLaneNum),
      linkTypeLabel,
    },
    elements:innerRoads,
  };
  fs.writeFileSync('data/kuandeng_roadlinks.json', JSON.stringify(out));
  console.log('records',m.nrec,'totalKm',r1(totalKm));
  console.log('byLinkType',out.summary.byLinkType);
  console.log('byOwnerShip',out.summary.byOwnerShip);
  console.log('inner_road pts',innerRoads.length);
}
main();