import subprocess, re, sys, os, json, statistics, tempfile
EDGE = r"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"

PATCH_FROM = "sync();fitInit();"
PATCH_TO = """window.__T={t0:performance.now()};
(function(){
 var _g=window.__T;
 requestAnimationFrame(function(){
   _g.raf=performance.now();
   // 量一帧 rescale：连续 60 次 apply()（模拟拖动/缩放）
   var a=performance.now();
   for(var i=0;i<60;i++){apply();}
   _g.rescale60=performance.now()-a;
   // 量一次强制样式重算 + 布局
   var b=performance.now();
   void document.body.offsetHeight;
   _g.reflow=performance.now()-b;
   var img=document.getElementById('img0');
   var fin=function(){
     _g.imgDone=performance.now();
     _g.imgSize=img?img.naturalWidth+'x'+img.naturalHeight:'-';
     document.title='PERF2::'+JSON.stringify(_g);
   };
   if(img){ if(img.complete) fin(); else img.addEventListener('load',fin); }
   else fin();
 });
 setTimeout(function(){ if(document.title.indexOf('PERF2')<0)
   document.title='PERF2::'+JSON.stringify(_g)+' tOut';},3000);
})();
sync();fitInit();"""

def make(src,dst):
    h=open(src,encoding="utf-8").read()
    assert PATCH_FROM in h, "anchor not found"
    h=h.replace(PATCH_FROM,PATCH_TO,1)
    open(dst,"w",encoding="utf-8").write(h)
    return dst

def run(path,loops=3):
    url="file:///"+os.path.abspath(path).replace("\\","/")
    out=[]
    for _ in range(loops):
        r=subprocess.run([EDGE,"--headless=new","--disable-gpu","--hide-scrollbars",
            "--window-size=1500,1300","--virtual-time-budget=15000","--dump-dom",url],
            capture_output=True,text=True,timeout=240,encoding="utf-8",errors="replace")
        m=re.search(r"<title>PERF2::(.*?)</title>",r.stdout,re.S)
        out.append(m.group(1) if m else None)
    return out

if __name__=="__main__":
    dst=os.path.join(tempfile.gettempdir(),"_perf2.html")
    make(sys.argv[1],dst)
    for s in run(dst):
        if not s: print("NONE"); continue
        s=s.split(" tOut")[0]
        d=json.loads(s)
        print(f"  t0={d['t0']:.0f}  raf={d.get('raf',0):.0f}  到首帧 {d.get('raf',0)-d['t0']:.0f}ms"
              f" | rescale×60={d.get('rescale60',0):.1f}ms (每帧 {d.get('rescale60',0)/60:.2f}ms)"
              f" | reflow={d.get('reflow',0):.1f}ms | imgDone={d.get('imgDone',0):.0f} size={d.get('imgSize')}")
