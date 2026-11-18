// 宽凳物理隔离族 → data/kuandeng_barriers.json
// 流式版：DIVIDER_ATTR.dbf 只读属性列（60MB），DIVIDER.shp 按 shx 索引随机读所需记录。
const fs = require('fs'); const path = require('path'); const K = require('../lib_kuandeng');
const PHYS = new Set([9,10,11,12,13,16,17]);
const KD = K.KD;

function main(){
  // 1) DIVIDER_ATTR：流式读，只留物理隔离段
  const ap = path.join(KD,'DIVIDER_ATTR.dbf');
  const fd = fs.openSync(ap,'r'); const hb = Buffer.alloc(2048); fs.readSync(fd,hb,0,2048,0);
  const nrec=hb.readUInt32LE(4), hsz=hb.readUInt16LE(8), rsz=hb.readUInt16LE(10);
  const fl=[]; let off=32;
  while(off<hsz&&hb[off]!==0x0d){fl.push({name:hb.slice(off,off+11).toString('latin1').replace(/\0.*$/,''),len:hb[off+16]});off+=32;}
  const pos={}; let base=1; fl.forEach(x=>{pos[x.name]=base;base+=x.len;});
  const need=['DIVIDER_ID','LINE_TYPE','LINE_COLOR','START_END'];
  const CHUNK=1<<22, buf=Buffer.alloc(CHUNK);
  const byDivider=new Map(); let kept=0, done=0, at=hsz;
  while(done<nrec){
    const want=Math.min(CHUNK,rsz*Math.min(4096,nrec-done));
    const got=fs.readSync(fd,buf,0,want,at); if(!got)break;
    const n=Math.floor(got/rsz);
    for(let i=0;i<n;i++){
      const o=i*rsz;
      const lt=+buf.toString('latin1',o+pos.LINE_TYPE,o+pos.LINE_TYPE+fl.find(f=>f.name==='LINE_TYPE').len).trim();
      if(!PHYS.has(lt))continue;
      const did=buf.toString('latin1',o+pos.DIVIDER_ID,o+pos.DIVIDER_ID+fl.find(f=>f.name==='DIVIDER_ID').len).trim();
      const se=buf.toString('latin1',o+pos.START_END,o+pos.START_END+fl.find(f=>f.name==='START_END').len).trim();
      const co=+buf.toString('latin1',o+pos.LINE_COLOR,o+pos.LINE_COLOR+fl.find(f=>f.name==='LINE_COLOR').len).trim();
      const p=se.split(',').map(s=>+s.trim()).filter(x=>!isNaN(x));
      if(!byDivider.has(did))byDivider.set(did,[]);
      byDivider.get(did).push({lt,color:co,s:p[0],e:p[1]}); kept++;
    }
    at+=n*rsz; done+=n;
  }
  fs.closeSync(fd);
  console.log('物理隔离属性段',kept,'· 涉及 divider',byDivider.size);

  // 2) DIVIDER.dbf：行→LINE_ID（流式，只读 LINE_ID 列）
  const dp=path.join(KD,'DIVIDER.dbf'); const fd2=fs.openSync(dp,'r');
  const hb2=Buffer.alloc(2048); fs.readSync(fd2,hb2,0,2048,0);
  const n2=hb2.readUInt32LE(4), h2=hb2.readUInt16LE(8), r2=hb2.readUInt16LE(10);
  const f2=[]; let o2=32; let idLen=18, idPos=1;
  while(o2<h2&&hb2[o2]!==0x0d){const nm=hb2.slice(o2,o2+11).toString('latin1').replace(/\0.*$/,'');
    if(nm==='LINE_ID'){idPos=o2===32?1:0;idLen=hb2[o2+16];}
    f2.push({nm,len:hb2[o2+16],base:0}); o2+=32;}
  // 计算字段偏移
  let base2=1; f2.forEach(f=>{f.base=base2;base2+=f.len;});
  const LINE_ID=f2.find(f=>f.nm==='LINE_ID');
  const want2=new Set(byDivider.keys());
  const idOf=new Map(); let done2=0, at2=h2;
  const CH2=Math.max(r2*8192,1<<22), b2=Buffer.alloc(CH2);
  while(done2<n2){
    const w=Math.min(CH2,r2*Math.min(8192,n2-done2));
    const g=fs.readSync(fd2,b2,0,w,at2); if(!g)break;
    const n=Math.floor(g/r2);
    for(let i=0;i<n;i++){
      const id=b2.toString('latin1',i*r2+LINE_ID.base,i*r2+LINE_ID.base+LINE_ID.len).trim();
      if(want2.has(id)) idOf.set(id,done2+i);
    }
    at2+=n*r2; done2+=n;
  }
  fs.closeSync(fd2);
  console.log('DIVIDER 中命中', idOf.size, '/', byDivider.size);

  // 3) DIVIDER.shp/shx：按 shx 随机读几何
  const shpF=fs.openSync(path.join(KD,'DIVIDER.shp'),'r');
  const shxF=fs.openSync(path.join(KD,'DIVIDER.shx'),'r');
  const ix=Buffer.alloc(8);
  const elements=[]; let miss=0, readFail=0;
  for(const [did,segs] of byDivider){
    const i=idOf.get(did); if(i==null){miss++;continue;}
    fs.readSync(shxF,ix,0,8,100+i*8);
    const off=ix.readUInt32BE(0)*2;          // 记录头 8B(编号+长度) 在此
    if(off<100){readFail++;continue;}
    const rh=Buffer.alloc(108);
    let g=0; try{ g=fs.readSync(shpF,rh,0,108,off); }catch(e){ readFail++; continue; }
    if(g<108){readFail++;continue;}
    const st=rh.readInt32LE(8);              // shapeType（跳过 8B 记录头）
    if(st!==3){readFail++;continue;}
    const nParts=rh.readInt32LE(8+36), nPts=rh.readInt32LE(8+40);
    if(nParts<1||nPts<2||nPts>20000){readFail++;continue;}
    const xyOff=off+8+44+4*nParts;           // 记录头8B + content(4type+32box+4nParts+4nPts+parts)
    const gb=Buffer.alloc(nPts*16);
    try{ g=fs.readSync(shpF,gb,0,nPts*16,xyOff); }catch(e){ readFail++; continue; }
    if(g<nPts*16){readFail++;continue;}
    const P=new Array(nPts);
    for(let p=0;p<nPts;p++) P[p]=[+gb.readDoubleLE(p*16).toFixed(7),+gb.readDoubleLE(p*16+8).toFixed(7)];
    for(const sg of segs){
      const s=Math.max(0,(sg.s|0)||0), e=Math.min(P.length-1,(sg.e==null?P.length-1:(sg.e|0)));
      if(e-s<1)continue;
      elements.push({divider_id:did,line_type:sg.lt,line_color:sg.color,pts:P.slice(s,e+1)});
    }
  }
  fs.closeSync(shpF); fs.closeSync(shxF);
  const tally={}; elements.forEach(e=>tally[e.line_type]=(tally[e.line_type]||0)+1);
  console.log('落盘',elements.length,'段 · 未命中属性',miss,'· 读失败',readFail);
  console.log('按线型:',JSON.stringify(tally));
  fs.writeFileSync('data/kuandeng_barriers.json',JSON.stringify({
    version:0.1,generator:'fetch_kuandeng_barriers.js',source:KD,crs:'WGS-84',
    fetchedAt:new Date().toISOString(),
    note:'宽凳 DIVIDER_ATTR 物理隔离族(9路缘石/10护栏/11墙体/12护栏+路面铺设/13护栏+墙体/16/17护栏组合)按 START_END 裁几何；WGS84，渲染端需 wgs2gcj。',
    elements}));
}
main();
