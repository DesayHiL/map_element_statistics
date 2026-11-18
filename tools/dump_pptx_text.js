const fs=require('fs');
const path=require('path');
// pptx = zip; use PowerShell Expand via cmd fallback not reliable -> do minimal unzip with pure node? No dep. Use tar (Windows bsdtar handles zip).
const {execSync}=require('child_process');
const out='d:/workspace/map_element_statistics/out/_pptx_xml';
fs.rmSync(out,{recursive:true,force:true});
fs.mkdirSync(out,{recursive:true});
fs.copyFileSync('d:/workspace/map_element_statistics/out/工程介绍_惠城区ODD覆盖流水线.pptx', out+'/deck.zip');
execSync('powershell -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath \'d:/workspace/map_element_statistics/out/_pptx_xml/deck.zip\' -DestinationPath \'d:/workspace/map_element_statistics/out/_pptx_xml/unz\' -Force"');
const d=path.join(out,'unz','ppt','slides');
const files=fs.readdirSync(d).filter(f=>/^slide\d+\.xml$/.test(f)).sort((a,b)=>parseInt(a.slice(5))-parseInt(b.slice(5)));
for(const f of files){
  const xml=fs.readFileSync(path.join(d,f),'utf8');
  const texts=[...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m=>m[1]);
  console.log('==',f,'==');
  console.log(texts.join(' | ').slice(0,300));
}