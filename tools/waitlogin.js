// 打开登录页等人工登录（飞书扫码/验证码），监听任意带Bearer的请求即捕获token
const pw=require('d:/workspace/map_element_statistics/.pwtmp/node_modules/playwright-core').chromium;
const fs=require('fs');
(async()=>{
 const ctx=await pw.launchPersistentContext('D:/workspace/map_element_statistics/.pwtmp/profile',{
  headless:false,
  executablePath:'C:/Users/uid06419/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
  viewport:{width:1280,height:900}});
 const page=ctx.pages()[0]||await ctx.newPage();
 let token=null;
 page.on('request',r=>{const h=r.headers()['authorization']||'';if(!token&&h.startsWith('Bearer eyJ'))token=h;});
 await page.goto('https://test-bluejet.cxzyuan.com',{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
 console.log('WAITING_FOR_LOGIN...');
 const t0=Date.now();
 while(!token&&Date.now()-t0<600000){
  await page.waitForTimeout(2000);
  const lt=await page.evaluate(()=>localStorage.getItem('ACCESS-Token')).catch(()=>null);
  if(lt&&lt.startsWith('Bearer')&&!token)token=lt;
 }
 if(token){
  fs.writeFileSync('d:/workspace/map_element_statistics/token.txt',token.replace(/^Bearer /,''));
  console.log('TOKEN_SAVED len',token.length);
 }else console.log('TIMEOUT_10min');
 await ctx.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});