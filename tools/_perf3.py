import subprocess, re, sys, os, json

EDGE = r"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"

MARKS = "window.__P={};function _m(k){window.__P[k]=Math.round(performance.now());}\n_m('s');\n"
ANCHOR = "<script>\nconst W="

PROBE = """(function(){requestAnimationFrame(function(){
 document.title='P3::'+JSON.stringify(window.__P);});})();
sync();fitInit();"""

INJ = [
    ("const RT=decPaths(RTB,PREC),CH=decPaths(CHB,PREC);",
     "_m('a');const RT=decPaths(RTB,PREC),CH=decPaths(CHB,PREC);_m('b');"),
    ("const marksHtml=MK.map(m=>{", "_m('c');const marksHtml=MK.map(m=>{"),
    ("stage.insertAdjacentHTML('beforeend','<svg id=\"svg\"", "_m('e');stage.insertAdjacentHTML('beforeend','<svg id=\"svg\""),
    ("const NS='http://www.w3.org/2000/svg';", "_m('f');const NS='http://www.w3.org/2000/svg';"),
    ("const MK_EL=[...document.querySelectorAll('#gmk circle')];",
     "_m('g');const MK_EL=[...document.querySelectorAll('#gmk circle')];_m('h');"),
    ("const RTC=RT.join(''),CHC=CH.join('');", "const RTC=RT.join(''),CHC=CH.join('');_m('i');"),
    ("sync();fitInit();\nif(location.hash", PROBE + "\n_m('j');_m('k');\nif(location.hash"),
]


def make(src, dst):
    h = open(src, encoding="utf-8").read()
    assert ANCHOR in h
    h = h.replace(ANCHOR, "<script>\n" + MARKS + "const W=", 1)
    for a, b in INJ:
        assert a in h, a[:60]
        h = h.replace(a, b, 1)
    open(dst, "w", encoding="utf-8").write(h)
    return dst


def run(path, loops=3):
    url = "file:///" + os.path.abspath(path).replace("\\", "/")
    for _ in range(loops):
        r = subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                            "--window-size=1500,1300", "--virtual-time-budget=12000", "--dump-dom", url],
                           capture_output=True, text=True, timeout=240, encoding="utf-8", errors="replace")
        m = re.search(r"<title>P3::(.*?)</title>", r.stdout, re.S)
        yield json.loads(m.group(1)) if m else None


if __name__ == "__main__":
    dst = os.path.join(os.path.dirname(os.path.abspath(sys.argv[1])), "_p3probe.html")
    make(sys.argv[1], dst)
    for d in run(dst):
        if not d:
            print("NONE")
            continue
        g = lambda k: d.get(k, 0)
        print(f"  解析到脚本起 {g('s'):6.0f} | decPaths {g('b')-g('a'):5.0f} | "
              f"标号HTML {g('d')-g('c'):5.0f} | innerHTML {g('f')-g('e'):5.0f} | "
              f"271个text {g('g')-g('f'):5.0f} | querySelector {g('h')-g('g'):5.0f} | "
              f"join {g('i')-g('h'):4.0f} | path构建 {g('j')-g('i'):5.0f} | "
              f"fitInit {g('k')-g('j'):4.0f}")
