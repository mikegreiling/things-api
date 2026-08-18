#!/bin/bash
# DBLSPAWN1 — double-booked preserved-instance repro (campaign docs/lab/dblspawn1-preserved-instance.md).
# ONE disposable clone of golden-v3 (Things 3.22.14). Reproduces the live-discovered
# state: an add-repeating seed carrying a CONCRETE item-level deadline is PRESERVED on
# promote (SRCFATE deadline trigger) as a FUTURE-dated instance, while the template cursor
# points at the SAME occurrence with icCount=0 — a double-booking the app displays twice and
# (the decisive spawn cell) may duplicate when the date arrives.
# Cells: A (composite add-repeating, unfixed) reproduce; C (advance clock +1 day) the spawn
# verdict. E (fixed re-cert) runs in a SEPARATE clone once the fix lands (dblspawn1-recert.sh).
# Self-contained: clone -> boot -> airgap -> pin clock (Sun 2026-07-05 12:00) -> ship dist ->
# drive -> verify -> ADVANCE +1 -> teardown (trap EXIT). Fixtures fully synthetic (DBS-*).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="dblspawn1-lab"
GOLDEN="things-lab-golden-v3"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[dbs] $*" | tee -a "$REPORT"; }
cleanup() { echo "[dbs] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

tart delete "$VM" >/dev/null 2>&1 || true
note "clone $GOLDEN -> $VM"
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"

# airgap + pin clock BEFORE Things launches
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo FAIL || echo OK' </dev/null)
note "airgap: $AG"
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date' </dev/null)"
GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "AX grant=$GRANT (want 2)"

# guest helpers
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
print("tp=%s fu=%s fa=%s ts=%s rc=%s ed=%s of=[%s] ia=%s sr=%s next=%s icStart=%s icCount=%s deadline=%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),d.get('ed'),",".join(offs),
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
rows=c.execute("SELECT uuid,start,startDate,status,trashed,deadline,rt1_repeatingTemplate,(rt1_recurrenceRule IS NOT NULL) AS istmpl FROM TMTask WHERE title=? ORDER BY istmpl DESC, creationDate", (sys.argv[1],)).fetchall()
for r in rows:
    kind = "TEMPLATE" if r[7]==1 else ("INSTANCE" if r[6] else "plain")
    print("%-8s uuid=%s start=%s startDate=%s status=%s trashed=%s deadline=%s tmplLink=%s" % (
        kind, r[0][:8], r[1], dpk(r[2]), r[3], r[4], dpk(r[5]), (r[6][:8] if r[6] else None)))
EOF
lab_ssh "$IP" 'cat > ~/labh/instcount.sh && chmod +x ~/labh/instcount.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
sqlite3 -noheader -list "file:$DB?mode=ro" "SELECT count(*) FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0"
EOF
note "helpers installed"

# ship production dist bundle
[ -f dist/cli/main.js ] || { note "FATAL: dist/cli/main.js missing"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() {
  local attempt code
  for attempt in 1 2 3 4 5; do
    sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; code=$?
    [ "$code" -eq 0 ] && return 0
    sleep 3
  done
  return "$code"
}
lab_ssh "$IP" true </dev/null; sleep 2
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null || { note "FATAL: node scp failed"; exit 1; }
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
COMMANDER_DIR=$(node -e "const p=require.resolve('commander'); console.log(p.slice(0, p.indexOf('/node_modules/commander/')+'/node_modules/commander'.length))")
scpO -r "$COMMANDER_DIR" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null || { note "FATAL: commander scp failed"; exit 1; }
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
CLI="~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js"
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
note "bundle shipped; Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)"

lab_ssh "$IP" 'open -a Things3; sleep 12; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null
note "warm-up done; CLI version: $(lab_ssh "$IP" "$CLI --version" </dev/null 2>&1)"

# ---- helpers ----
tmplid() { lab_ssh "$IP" "~/labh/gsql.sh -q \"SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1\"" </dev/null; }
rsum() { lab_ssh "$IP" "python3 ~/labh/rsum.py '$1'" </dev/null; }
rows() { lab_ssh "$IP" "python3 ~/labh/rows.py '$1'" </dev/null; }
instcount() { lab_ssh "$IP" "~/labh/instcount.sh '$1'" </dev/null; }

report_state() {
  local title="$1"
  local t; t=$(tmplid "$title")
  note "  ROWS ($title):"; rows "$title" | sed 's/^/    /' | tee -a "$REPORT"
  if [ -n "$t" ]; then
    note "  TEMPLATE rule: $(rsum "$t")"
    note "  instances linked (non-trashed): $(instcount "$t")"
  else
    note "  NO TEMPLATE for $title"
  fi
}

# ============================ CELL A — composite add-repeating (unfixed), item deadline
note "==== CELL A: todo add-repeating with concrete --deadline (composite, unfixed) ===="
note "  cmd: add-repeating DBS-A --when 2026-07-06 --deadline 2026-07-20 --frequency yearly --yearly-month 7 --on-day 6"
lab_ssh "$IP" "$CLI todo add-repeating 'DBS-A' --when 2026-07-06 --deadline 2026-07-20 --frequency yearly --interval 1 --yearly-month 7 --on-day 6 --dangerously-drive-gui --verify-timeout 60000" </dev/null >"$OUT/A.out" 2>&1
note "  cli-exit=$?"; tail -6 "$OUT/A.out" | sed 's/^/    /' | tee -a "$REPORT"
sleep 3
report_state DBS-A

# ============================ CELL C — DECISIVE spawn cell: advance clock +1 day to the occurrence
note "==== CELL C: advance clock +1 day (2026-07-05 -> 2026-07-06 = the occurrence) ===="
note "  pre-advance A state:"; report_state DBS-A
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 4' </dev/null
lab_ssh "$IP" 'sudo date 070612002026 >/dev/null; sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
note "  clock now: $(lab_ssh "$IP" 'date' </dev/null)"
lab_ssh "$IP" 'open -a Things3; sleep 18; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null
note "  warm relaunch at occurrence date done"
sleep 6
note "  POST-advance A state (did a SECOND instance spawn? reconcile? cursor/icCount?):"; report_state DBS-A

# second settle read (in case spawn is lazy)
sleep 8
note "  POST-advance A state (re-read after +8s settle):"; report_state DBS-A

note "REPRO DONE."
