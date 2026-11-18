// 宽凳补充 ODD 元素 → data/kuandeng_extra.json
// 1) 内部道路：ROAD_LINK.dbf OWNER_SHIP=2（几何从缓存投影由渲染端做？——不行，几何在缓存里没有 rowid 对应）
// 方案：直接读 ROAD_LINK 的 dbf + shp/shx（记录数 198,459，量级与 barriers 的 DIVIDER 相当）
// 2) 双实线：DIVIDER_ATTR LINE_TYPE=4（8,488 段）→ 同 barriers 流程裁 DIVIDER 几何
const fs = require('fs'); const path = require('path'); const K = require('../lib_kuandeng');
const KD = K.KD;

function dbfMeta(p){
  const fd=fs.openSync(p,'r'); const hb=Buffer.alloc(2048); fs.readSync(fd,hb,0,2048,0); fs.closeSync(fd);
  const nrec=hb.readUInt32LE(4), hsz=hb.readUInt16LE(8), rsz=hb.readUInt16LE(10);
  const fl=[]; let off=32;
  while(off<hsz&&hb[off]!==0x0d){fl.push({name:hb.slice(off,off+11).toString('latin1').replace(/\0.*$/,''),len:hb[off+16]});off+=32;}
  const pos={}; let base=1; fl.forEach(x=>{pos[x.name]=base;base+=x.len;});
  return {nrec,hsz,rsz,fl,pos};
}
function shpLine(shpF, shxF, i){
  const ix=Buffer.alloc(8); fs.readSync(shxF,ix,0,8,100+i*8);
  const off=ix.readUInt32BE(0)*2; if(off<100)return null;
  const rh=Buffer.alloc(108); if(fs.readSync(shpF,rh,0,108,off)<108)return null;
  if(rh.readInt32LE(8)!==3)return null;
  const nParts=rh.readInt32LE(8+36), nPts=rh.readInt32LE(8+40);
  if(nParts<1||nPts<2||nPts>20000)return null;
  const xyOff=off+8+44+4*nParts; const gb=Buffer.alloc(nPts*16);
  if(fs.readSync(shpF,gb,0,nPts*16,xyOff)<nPts*16)return null;
  const P=new Array(nPts);
  for(let p=0;p<nPts;p++)P[p]=[+gb.readDoubleLE(p*16).toFixed(7),+gb.readDoubleLE(p*16+8).toFixed(7)];
  return P;
}

function main(){
  // ---------- 1) 内部道路 ----------
  const rm = dbfMeta(path.join(KD,'ROAD_LINK.dbf'));
  const wantCols = ['LINK_ID','OWNER_SHIP','LINK_TYPE'];
  const fd=fs.openSync(path.join(KD,'ROAD_LINK.dbf'),'r');
  const CH=1<<22, buf=Buffer.alloc(CH);
  const inner=[]; let done=0, at=rm.hsz, innerCnt=0, tot=0;
  const ownerTally={};
  while(done<rm.nrec){
    const w=Math.min(CH,rm.rsz*Math.min(8192,rm.nrec-done));
    const got=fs.readSync(fd,buf,0,w,at); if(!got)break;
    const n=Math.floor(got/rm.rsz);
    for(let i=0;i<n;i++){
      const o=i*rm.rsz; tot++;
      const own=buf.toString('latin1',o+rm.pos.OWNER_SHIP,o+rm.pos.OWNER_SHIP+rm.fl.find(f=>f.name==='OWNER_SHIP').len).trim();
      ownerTally[own]=(ownerTally[own]||0)+1;
      if(own!=='2')continue;
      const id=buf.toString('latin1',o+rm.pos.LINK_ID,o+rm.pos.LINK_ID+rm.fl.find(f=>f.name==='LINK_ID').len).trim();
      inner.push({row:done+i,id}); innerCnt++;
    }
    at+=n*rm.rsz; done+=n;
  }
  fs.closeSync(fd);
  console.log('ROAD_LINK OWNER_SHIP 分布:',JSON.stringify(ownerTally),'内部道路',innerCnt);
  const shpF=fs.openSync(path.join(KD,'ROAD_LINK.shp'),'r'), shxF=fs.openSync(path.join(KD,'ROAD_LINK.shx'),'r');
  const innerEls=[]; let miss=0;
  for(const it of inner){
    const P=shpLine(shpF,shxF,it.row);
    if(!P){miss++;continue;}
    innerEls.push({kind:'inner_road',link_id:it.id,pts:P});
  }
  fs.closeSync(shpF); fs.closeSync(shxF);
  console.log('内部道路几何', innerEls.length, '失败', miss);

  // ---------- 2) 双实线（DIVIDER_ATTR LINE_TYPE=4）----------
  const am = dbfMeta(path.join(KD,'DIVIDER_ATTR.dbf'));
  const fd2=fs.openSync(path.join(KD,'DIVIDER_ATTR.dbf'),'r'); const b2=Buffer.alloc(CH);
  const byDiv=new Map(); done=0; at=am.hsz; let dbl=0;
  while(done<am.nrec){
    const w=Math.min(CH,am.rsz*Math.min(8192,am.nrec-done));
    const got=fs.readSync(fd2,b2,0,w,at); if(!got)break;
    const n=Math.floor(got/am.rsz);
    for(let i=0;i<n;i++){
      const o=i*am.rsz;
      const lt=+b2.toString('latin1',o+am.pos.LINE_TYPE,o+am.pos.LINE_TYPE+am.fl.find(f=>f.name==='LINE_TYPE').len).trim();
      if(lt!==4)continue;
      const did=b2.toString('latin1',o+am.pos.DIVIDER_ID,o+am.pos.DIVIDER_ID+am.fl.find(f=>f.name==='DIVIDER_ID').len).trim();
      const se=b2.toString('latin1',o+am.pos.START_END,o+am.pos.START_END+am.fl.find(f=>f.name==='START_END').len).trim();
      const co=+b2.toString('latin1',o+am.pos.LINE_COLOR,o+am.pos.LINE_COLOR+am.fl.find(f=>f.name==='LINE_COLOR').len).trim();
      const p=se.split(',').map(s=>+s.trim()).filter(x=>!isNaN(x));
      if(!byDiv.has(did))byDiv.set(did,[]);
      byDiv.get(did).push({color:co,s:p[0],e:p[1]}); dbl++;
    }
    at+=n*am.rsz; done+=n;
  }
  fs.closeSync(fd2);
  console.log('双实线属性段',dbl,'涉及 divider',byDiv.size);

  // DIVIDER.dbf：行→LINE_ID
  const dm = dbfMeta(path.join(KD,'DIVIDER.dbf'));
  const fd3=fs.openSync(path.join(KD,'DIVIDER.dbf'),'r'); const b3=Buffer.alloc(Math.max(dm.rsz*8192,CH));
  const want2=new Set(byDiv.keys()); const idOf=new Map(); done=0; at=dm.hsz;
  while(done<dm.nrec){
    const w=Math.min(b3.length,dm.rsz*Math.min(8192,dm.nrec-done));
    const got=fs.readSync(fd3,b3,0,w,at); if(!got)break;
    const n=Math.floor(got/dm.rsz);
    for(let i=0;i<n;i++){
      const id=b3.toString('latin1',i*dm.rsz+dm.pos.LINE_ID,i*dm.rsz+dm.pos.LINE_ID+dm.fl.find(f=>f.name==='LINE_ID').len).trim();
      if(want2.has(id))idOf.set(id,done+i);
    }
    at+=n*dm.rsz; done+=n;
  }
  fs.closeSync(fd3);
  console.log('DIVIDER 命中',idOf.size,'/',byDiv.size);

  const shpF2=fs.openSync(path.join(KD,'DIVIDER.shp'),'r'), shxF2=fs.openSync(path.join(KD,'DIVIDER.shx'),'r');
  const dblEls=[]; let rf=0;
  for(const [did,segs] of byDiv){
    const i=idOf.get(did); if(i==null){rf++;continue;}
    const P=shpLine(shpF2,shxF2,i); if(!P){rf++;continue;}
    for(const sg of segs){
      const s=Math.max(0,(sg.s|0)||0), e=Math.min(P.length-1,(sg.e==null?P.length-1:(sg.e|0)));
      if(e-s<1)continue;
      dblEls.push({kind:'double_solid',divider_id:did,line_color:sg.color,pts:P.slice(s,e+1)});
    }
  }
  fs.closeSync(shpF2); fs.closeSync(shxF2);
  console.log('双实线落盘',dblEls.length,'读失败',rf);

  fs.writeFileSync('data/kuandeng_extra.json',JSON.stringify({
    version:0.1,generator:'tools/fetch_kuandeng_extra.js',source:KD,crs:'WGS-84',
    fetchedAt:new Date().toISOString(),
    note:'内部道路(ROAD_LINK.OWNER_SHIP=2) + 双实线(DIVIDER_ATTR.LINE_TYPE=4)。WGS84，渲染端需 wgs2gcj。',
    elements:[...innerEls,...dblEls]}));
  console.log('total elements', innerEls.length+dblEls.length);
}
main();
