#!/bin/bash
# RSPA1 — reschedule a deadlined yearly template that has a PENDING materialized
# instance (campaign docs/lab/rspa1-reschedule-pending.md). The decisive live shape
# that YANCH1/DACON1/DBLSPAWN1 all queued as a residual: a repeating template with
# NO current materialized instance is not reveal-selectable, so this cell needs one
# materialized first. ONE disposable clone of golden-v3 (Things 3.22.14).
#
# Setup: create THREE deadlined yearly series whose first occurrence is TOMORROW
# (2026-07-06) with the FIXED add-repeating (concrete --deadline maps to the rule,
# seed deadline-free, NO preserved future instance); advance the clock +1 day so
# each materializes its current-occurrence instance. Then reschedule:
#   (a) RS-A — on-rule --when-ONLY (no explicit anchor) + deadline: does the d1 fix
#       (derive+drive the anchor) COMMIT, cursor sane, existing instance untouched,
#       and NO duplicate on the next spawn (DBLSPAWN interplay)?
#   (c) RS-C — rule-only reschedule (no --when): RRD1 preserve-unspecified baseline
#       with a materialized instance present.
#   (b) RS-B — off-rule Next (explicit anchor != --when) with the pending instance:
#       HONORED / SNAPPED / DISCARDED-entirely (the live zero-movement hypothesis)?
# Ground truth = read-only guest SQLite (rule bytes, cursor/ia/sr, icCount, the
# instance row). Fixtures fully synthetic (RS-*). Self-contained: clone -> boot ->
# airgap -> pin clock -> ship dist -> drive -> verify -> teardown (trap EXIT).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="rspa1-lab"
GOLDEN="things-lab-golden-v3"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[rspa1] $*" | tee -a "$REPORT"; }
cleanup() { echo "[rspa1] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
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

# guest helpers (identical to dblspawn1)
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

warm_relaunch() {
  local secs="${1:-18}"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 4' </dev/null
  lab_ssh "$IP" "open -a Things3; sleep $secs; osascript -e 'tell application \"System Events\" to tell process \"Things3\" to set value of attribute \"AXEnhancedUserInterface\" to false' 2>/dev/null" </dev/null
}

# ============================ SETUP — three deadlined yearly series, first occ TOMORROW
note "==== SETUP: three deadlined yearly series (fixed add-repeating), first occ 2026-07-06 ===="
for T in RS-A RS-B RS-C; do
  note "  add-repeating $T --when 2026-07-06 --deadline 2026-07-20 --frequency yearly --interval 1"
  lab_ssh "$IP" "$CLI todo add-repeating '$T' --when 2026-07-06 --deadline 2026-07-20 --frequency yearly --interval 1 --dangerously-drive-gui --verify-timeout 60000" </dev/null >"$OUT/setup-$T.out" 2>&1
  note "    cli-exit=$?"; tail -3 "$OUT/setup-$T.out" | sed 's/^/      /' | tee -a "$REPORT"
  sleep 2
done
note "  at-rest state (clock 2026-07-05; expect NO materialized instance, icCount=0, cursor=2026-07-06):"
for T in RS-A RS-B RS-C; do report_state "$T"; done

# ============================ MATERIALIZE — advance +1 day so each instance spawns
note "==== MATERIALIZE: advance clock +1 day (2026-07-05 -> 2026-07-06 = the occurrence) ===="
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 4' </dev/null
lab_ssh "$IP" 'sudo date 070612002026 >/dev/null; sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
note "  clock now: $(lab_ssh "$IP" 'date' </dev/null)"
warm_relaunch 18
sleep 6
note "  post-materialize state (expect ONE instance dated 2026-07-06 per series, icCount=1):"
for T in RS-A RS-B RS-C; do report_state "$T"; done

TA=$(tmplid RS-A); TB=$(tmplid RS-B); TC=$(tmplid RS-C)
note "  template uuids: RS-A=$TA RS-B=$TB RS-C=$TC"

# ============================ CELL (c) — rule-only reschedule (RRD1 preserve baseline)
note "==== CELL (c): RS-C rule-only reschedule (no --when) — interval 1 -> 2 ===="
note "  pre: $(rsum "$TC")"
lab_ssh "$IP" "$CLI todo reschedule-repeat '$TC' --frequency yearly --interval 2 --dangerously-drive-gui --verify-timeout 60000 --json" </dev/null >"$OUT/cellC.out" 2>&1
note "  cli-exit=$?"; tail -4 "$OUT/cellC.out" | sed 's/^/    /' | tee -a "$REPORT"
sleep 3
note "  post-(c): (expect fu=4 interval 2, anchor+deadline+cursor PRESERVED, instance untouched)"
report_state RS-C

# ============================ CELL (b) — off-rule Next with a pending instance
note "==== CELL (b): RS-B off-rule Next — explicit anchor Oct-16, --when 2028-11-05 (off-rule first) ===="
note "  pre: $(rsum "$TB")"
lab_ssh "$IP" "$CLI todo reschedule-repeat '$TB' --frequency yearly --interval 1 --yearly-month 10 --on-day 16 --when 2028-11-05 --dangerously-drive-gui --verify-timeout 45000 --json" </dev/null >"$OUT/cellB.out" 2>&1
note "  cli-exit=$?"; tail -6 "$OUT/cellB.out" | sed 's/^/    /' | tee -a "$REPORT"
sleep 3
note "  post-(b): HONORED (anchor Oct-16, first Nov-5) / SNAPPED / DISCARDED (rule bytes unchanged = zero movement)?"
report_state RS-B

# ============================ CELL (a) — on-rule --when-only reschedule WITH the d1 fix
note "==== CELL (a): RS-A on-rule --when-ONLY reschedule + deadline (the live shape, fixed) ===="
note "  pre: $(rsum "$TA")"
note "  cmd: reschedule-repeat --frequency yearly --interval 1 --when 2028-10-16 --deadline --start-days-earlier 14 (derived anchor = Oct 30)"
lab_ssh "$IP" "$CLI todo reschedule-repeat '$TA' --frequency yearly --interval 1 --when 2028-10-16 --deadline --start-days-earlier 14 --dangerously-drive-gui --verify-timeout 120000 --json" </dev/null >"$OUT/cellA.out" 2>&1
note "  cli-exit=$?"; tail -6 "$OUT/cellA.out" | sed 's/^/    /' | tee -a "$REPORT"
sleep 3
note "  post-(a): COMMITTED (fu=4 anchor Oct-30 ts-14, cursor sane)? existing 2026-07-06 instance untouched?"
report_state RS-A

# ============================ CELL (a) spawn check — advance to the next start, expect NO duplicate
note "==== CELL (a) SPAWN: advance clock to 2028-10-02 (the next start) — duplicate on spawn? ===="
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 4' </dev/null
lab_ssh "$IP" 'sudo date 100212002028 >/dev/null; sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
note "  clock now: $(lab_ssh "$IP" 'date' </dev/null)"
warm_relaunch 18
sleep 8
note "  post-spawn RS-A (expect the 2026-07-06 instance + at most ONE new 2028 occurrence, NO double-book):"
report_state RS-A
sleep 8
note "  re-read after +8s settle:"
report_state RS-A

note "RSPA1 DONE."
