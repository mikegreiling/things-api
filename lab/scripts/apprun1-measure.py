#!/usr/bin/env python3
# APPRUN1 launch-readiness measurement (runs ON the guest).
#
# Quits Things, background-launches it, and — on ONE guest clock — fires a
# staggered bank of raw complete-URLs at distinct synthetic to-dos while
# concurrently sampling candidate readiness signals. Emits a JSON timeline so
# the host can derive: the URL-drop window (offset at which a dispatched write
# first LANDS) and which signal coincides with it.
#
# Usage: apprun1-measure.py <uuids-file> <out-json>
#   <uuids-file>: one to-do uuid per line (synthetic, open, app-created)
import json, os, subprocess, sys, time, glob

UUIDS = [l.strip() for l in open(sys.argv[1]) if l.strip()]
OUT = sys.argv[2]

def db_path():
    g = glob.glob(os.path.expanduser(
        "~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/"
        "ThingsData-*/Things Database.thingsdatabase/main.sqlite"))
    return g[0] if g else None

DB = db_path()
WAL = DB + "-wal" if DB else None

def sqlite(q):
    return subprocess.run(["sqlite3", "file:%s?mode=ro" % DB, q],
                          capture_output=True, text=True).stdout.strip()

TOKEN = sqlite("SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")

def pgrep():
    return subprocess.run(["pgrep", "-x", "Things3"],
                          capture_output=True).returncode == 0

def lsappinfo_status():
    try:
        out = subprocess.run(
            ["lsappinfo", "info", "-only", "StatusLabel",
             "-app", "com.culturedcode.ThingsMac"],
            capture_output=True, text=True, timeout=3).stdout.strip()
        return out
    except Exception as e:
        return "ERR:%s" % e

def frontmost():
    try:
        return subprocess.run(
            ["osascript", "-e",
             'tell application "System Events" to name of first process whose frontmost is true'],
            capture_output=True, text=True, timeout=4).stdout.strip()
    except Exception as e:
        return "ERR"

def as_count_ok():
    # AppleScript liveness read (measured for correlation only; NOT the shipped
    # signal — it needs Automation consent). True when Things answers.
    try:
        r = subprocess.run(
            ["osascript", "-e", 'tell application "Things3" to count of areas'],
            capture_output=True, text=True, timeout=3)
        return r.returncode == 0 and r.stdout.strip().isdigit()
    except Exception:
        return False

def wal_mtime():
    try:
        return os.path.getmtime(WAL)
    except Exception:
        return None

def fire_complete(uuid):
    url = "things:///update?id=%s&completed=true&auth-token=%s" % (uuid, TOKEN)
    subprocess.run(["open", "-g", url])

# --- quit + confirm down ---
subprocess.run(["osascript", "-e", 'tell application "Things3" to quit'],
               capture_output=True)
for _ in range(30):
    if not pgrep():
        break
    time.sleep(0.5)

wal0 = wal_mtime()
INTERVAL = 0.2
DURATION = 22.0
FIRE_START = 0.0            # begin firing immediately after launch
FIRE_STEP = 0.5            # one target every 0.5s

timeline = []
fired = []                 # (index, uuid, offset)
signal_first = {}          # signal name -> first-true offset

t0 = time.time()
subprocess.run(["open", "-g", "-a", "Things3"])
next_fire = FIRE_START
fire_i = 0

while True:
    now = time.time() - t0
    if now > DURATION:
        break
    proc = pgrep()
    ls = lsappinfo_status()
    fm = frontmost()
    asok = as_count_ok()
    wal = wal_mtime()
    wal_adv = (wal is not None and wal0 is not None and wal > wal0 + 0.01)
    row = {"t": round(now, 3), "pgrep": proc, "lsappinfo": ls,
           "frontmost": fm, "as_count_ok": asok, "wal_advanced": wal_adv}
    timeline.append(row)
    # record first-trip of each boolean-ish signal
    def first(name, val):
        if val and name not in signal_first:
            signal_first[name] = round(now, 3)
    first("pgrep", proc)
    first("as_count_ok", asok)
    first("wal_advanced", wal_adv)
    if ls and "Not Finished Launching" not in ls and "ERR" not in ls:
        first("lsappinfo_ready", True)
    # staggered fire
    if fire_i < len(UUIDS) and now >= next_fire:
        fire_complete(UUIDS[fire_i])
        fired.append({"i": fire_i, "uuid": UUIDS[fire_i], "offset": round(now, 3)})
        fire_i += 1
        next_fire += FIRE_STEP
    time.sleep(INTERVAL)

# settle, then read completion status of each fired target
time.sleep(6)
results = []
first_landing_offset = None
for f in fired:
    st = sqlite("SELECT status FROM TMTask WHERE uuid='%s'" % f["uuid"])
    completed = (st == "3")
    results.append({**f, "status": st, "completed": completed})
    if completed and first_landing_offset is None:
        first_landing_offset = f["offset"]

frontmost_after_launch = [r["frontmost"] for r in timeline[:15]]

json.dump({
    "token_present": bool(TOKEN),
    "n_targets": len(UUIDS),
    "signal_first_trip": signal_first,
    "first_landing_offset": first_landing_offset,
    "fired": results,
    "frontmost_early": frontmost_after_launch,
    "timeline": timeline,
}, open(OUT, "w"), indent=1)
print("first_landing_offset=%s" % first_landing_offset)
print("signal_first_trip=%s" % json.dumps(signal_first))
