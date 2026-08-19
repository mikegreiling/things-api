#!/bin/bash
# RSPA1 spawn confirmation (cell (a) tail): the main rspa1-pending.sh spawn leg
# advanced to 2028-10-02, but the d1-fixed cell-(a) reschedule back-shifts the START
# to --when 2028-10-16 (anchor Oct 30 due, ts=-14), so Oct 2 is BEFORE the occurrence
# and nothing spawned. This lean re-run reaches the actual start date to confirm the
# re-anchored cursor mints exactly ONE new occurrence and does NOT double-book the
# materialized 2026-07-06 instance (DBLSPAWN interplay). ONE series RS-A only.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="rspa1-spawn"
GOLDEN="things-lab-golden-v3"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[spawn] $*" | tee -a "$REPORT"; }
cleanup() { echo "[spawn] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

tart delete "$VM" >/dev/null 2>&1 || true
note "clone $GOLDEN -> $VM"
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date' </dev/null)"

lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib, datetime
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
def uxd(v):
    try: v=float(v)
    except: return v
    return datetime.datetime.utcfromtimestamp(v).strftime("%Y-%m-%d")
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationStartDate, rt1_instanceCreationCount, deadline FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row or row[0] is None: print("NO-RULE"); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
print("tp=%s fu=%s fa=%s ts=%s of=[%s] ia=%s sr=%s next=%s icStart=%s icCount=%s deadline=%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),",".join(offs),
    uxd(d.get('ia')),uxd(d.get('sr')),dpk(row[1]),dpk(row[2]),row[3],row[4]))
EOF
lab_ssh "$IP" 'cat > ~/labh/rows.py' <<'EOF'
import sys, sqlite3, glob
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return None
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
rows=c.execute("SELECT uuid,startDate,status,trashed,deadline,rt1_repeatingTemplate,(rt1_recurrenceRule IS NOT NULL) AS istmpl FROM TMTask WHERE title=? ORDER BY istmpl DESC, creationDate", (sys.argv[1],)).fetchall()
for r in rows:
    kind = "TEMPLATE" if r[6]==1 else ("INSTANCE" if r[5] else "plain")
    print("%-8s uuid=%s startDate=%s status=%s trashed=%s deadline=%s tmplLink=%s" % (
        kind, r[0][:8], dpk(r[1]), r[2], r[3], dpk(r[4]), (r[5][:8] if r[5] else None)))
EOF
lab_ssh "$IP" 'cat > ~/labh/instcount.sh && chmod +x ~/labh/instcount.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
sqlite3 -noheader -list "file:$DB?mode=ro" "SELECT count(*) FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0"
EOF

[ -f dist/cli/main.js ] || { note "FATAL: dist missing"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { local a c; for a in 1 2 3 4 5; do sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; c=$?; [ "$c" -eq 0 ] && return 0; sleep 3; done; return "$c"; }
lab_ssh "$IP" true </dev/null; sleep 2
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null || { note "FATAL node scp"; exit 1; }
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
COMMANDER_DIR=$(node -e "const p=require.resolve('commander'); console.log(p.slice(0, p.indexOf('/node_modules/commander/')+'/node_modules/commander'.length))")
scpO -r "$COMMANDER_DIR" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null || { note "FATAL commander scp"; exit 1; }
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
CLI="~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js"
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
note "bundle shipped; Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)"
lab_ssh "$IP" 'open -a Things3; sleep 12; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null

tmplid() { lab_ssh "$IP" "~/labh/gsql.sh -q \"SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1\"" </dev/null; }
rsum() { lab_ssh "$IP" "python3 ~/labh/rsum.py '$1'" </dev/null; }
rows() { lab_ssh "$IP" "python3 ~/labh/rows.py '$1'" </dev/null; }
instcount() { lab_ssh "$IP" "~/labh/instcount.sh '$1'" </dev/null; }
report_state() { local t; t=$(tmplid "$1"); note "  ROWS ($1):"; rows "$1" | sed 's/^/    /' | tee -a "$REPORT"; [ -n "$t" ] && { note "  TEMPLATE: $(rsum "$t")"; note "  instances (non-trashed): $(instcount "$t")"; }; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 4' </dev/null; lab_ssh "$IP" "open -a Things3; sleep ${1:-18}; osascript -e 'tell application \"System Events\" to tell process \"Things3\" to set value of attribute \"AXEnhancedUserInterface\" to false' 2>/dev/null" </dev/null; }

note "==== SETUP RS-A (deadlined yearly, first occ 2026-07-06) ===="
lab_ssh "$IP" "$CLI todo add-repeating 'RS-A' --when 2026-07-06 --deadline 2026-07-20 --frequency yearly --interval 1 --dangerously-drive-gui --verify-timeout 60000" </dev/null >"$OUT/setup.out" 2>&1
note "  cli-exit=$?"
note "==== MATERIALIZE (+1 day -> 2026-07-06) ===="
warm 4 >/dev/null 2>&1 || true
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 4' </dev/null
lab_ssh "$IP" 'sudo date 070612002026 >/dev/null; sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
warm 18; sleep 6
report_state RS-A
TA=$(tmplid RS-A); note "  RS-A template=$TA"

note "==== CELL (a) reschedule --when 2028-10-16 --deadline --start-days-earlier 14 ===="
lab_ssh "$IP" "$CLI todo reschedule-repeat '$TA' --frequency yearly --interval 1 --when 2028-10-16 --deadline --start-days-earlier 14 --dangerously-drive-gui --verify-timeout 120000 --json" </dev/null >"$OUT/cellA.out" 2>&1
note "  cli-exit=$?"; grep -o '"anchorKey":"[^"]*"\|"nextOccurrence":"[^"]*"\|"ok":[a-z]*' "$OUT/cellA.out" | tr '\n' ' ' | tee -a "$REPORT"; echo | tee -a "$REPORT"
sleep 3; report_state RS-A

note "==== SPAWN: advance to 2028-10-16 (the re-anchored START) — expect ONE new occurrence, NO double-book ===="
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 4' </dev/null
lab_ssh "$IP" 'sudo date 101612002028 >/dev/null; sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
note "  clock now: $(lab_ssh "$IP" 'date' </dev/null)"
warm 18; sleep 8
note "  post-spawn (expect the 2026-07-06 instance + ONE new 2028-10-16 occurrence = 2 total, NO duplicate at the same slot):"
report_state RS-A
sleep 8
note "  re-read after +8s settle:"
report_state RS-A
note "SPAWN CONFIRM DONE."
