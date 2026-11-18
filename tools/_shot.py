import subprocess, sys, os, glob, time, json
EDGE = None
for p in [r"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
          r"C:/Program Files/Microsoft/Edge/Application/msedge.exe"]:
    if os.path.exists(p): EDGE = p; break
print("EDGE:", EDGE)
url = sys.argv[1]; out = os.path.abspath(sys.argv[2]); W = sys.argv[3] if len(sys.argv)>3 else "1400"; H = sys.argv[4] if len(sys.argv)>4 else "1300"
wait = sys.argv[5] if len(sys.argv)>5 else "4000"
args = [EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
        f"--window-size={W},{H}", f"--screenshot={out}",
        f"--virtual-time-budget={wait}", url]
r = subprocess.run(args, capture_output=True, timeout=180)
print("rc", r.returncode, "size", os.path.getsize(out) if os.path.exists(out) else None)
