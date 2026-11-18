import subprocess, re, sys, os, json, statistics, tempfile
EDGE = r"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"

PROBE = """
<script>
(function(){
 function mark(n){try{performance.mark(n)}catch(e){}}
 addEventListener('DOMContentLoaded',function(){mark('dcl')},false);
 addEventListener('load',function(){
   mark('load');
   setTimeout(function(){
     var out=[];
     var nav=performance.getEntriesByType('navigation')[0]||{};
     out.push('dcl='+(nav.domContentLoadedEventEnd||0).toFixed(0));
     out.push('load='+(nav.loadEventEnd||0).toFixed(0));
     out.push('domInteractive='+(nav.domInteractive||0).toFixed(0));
     performance.getEntriesByType('paint').forEach(function(p){
       out.push(p.name+'='+p.startTime.toFixed(0));
     });
     var t=performance.getEntriesByType('longtask')||[];
     out.push('longtasks='+t.length);
     out.push('nodes='+document.getElementsByTagName('*').length);
     out.push('img='+(window.__imgDecMs!==undefined?window.__imgDecMs:'?'));
     out.push('svgBuild='+(window.__svgMs!==undefined?window.__svgMs:'?'));
     document.title='PERF::'+out.join(' | ');
   },400);
 },false);
})();
</script>
"""

def run(path, loops=3, win="1500,1300"):
    url = "file:///" + os.path.abspath(path).replace("\\","/")
    res=[]
    for _ in range(loops):
        r=subprocess.run([EDGE,"--headless=new","--disable-gpu","--hide-scrollbars",
                          f"--window-size={win}","--virtual-time-budget=12000","--dump-dom",url],
                         capture_output=True,text=True,timeout=240,encoding="utf-8",errors="replace")
        m=re.search(r"<title>PERF::(.*?)</title>", r.stdout, re.S)
        if not m: 
            res.append(None); continue
        d={}
        for kv in m.group(1).split("|"):
            kv=kv.strip()
            if "=" in kv:
                k,v=kv.split("=",1); d[k]=v
        res.append(d)
    return res

def with_probe(src, dst):
    h=open(src,encoding="utf-8").read()
    i=h.index("<head>")+len("<head>")
    h2=h[:i]+PROBE+h[i:]
    open(dst,"w",encoding="utf-8").write(h2)
    return dst

if __name__=="__main__":
    src=sys.argv[1]; 
    dst=os.path.join(tempfile.gettempdir(),"_perf_probe.html")
    with_probe(src,dst)
    rs=run(dst)
    for d in rs:
        print(json.dumps(d,ensure_ascii=False))
    ok=[d for d in rs if d and "fcp" in d]
    if ok:
        for k in ["dcl","load","domInteractive","fcp","nodes"]:
            vs=[float(d[k]) for d in ok if k in d]
            if vs: print(f'  {k:14s} median {statistics.median(vs):8.1f}')
