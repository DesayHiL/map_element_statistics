const fs=require('fs');
const K=require('../lib_kuandeng');
const p=K.KD+'/DIVIDER.shx';
const fd=fs.openSync(p,'r');
for(const i of [0,1,841161]){
  const b=Buffer.alloc(8);fs.readSync(fd,b,0,8,100+i*8);
  console.log(`shx[${i}]: offWord=${b.readInt32BE(0)} lenWord=${b.readInt32BE(4)} → byteOff=${b.readInt32BE(0)*2} len=${b.readInt32BE(4)*2}`);
}
fs.closeSync(fd);
const sf=fs.openSync(K.KD+'/DIVIDER.shp','r');
const b2=Buffer.alloc(12);fs.readSync(sf,b2,0,12,100);
console.log('shp rec0: num=',b2.readInt32BE(0),'len=',b2.readInt32BE(4),'type=',b2.readInt32BE(8));
