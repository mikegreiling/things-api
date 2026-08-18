#!/bin/bash
# DACON1 — off-rule-first matrix (issue: deadline-aware anchor/when + cursor skip).
# ONE disposable clone of golden-v3 (Things 3.22.14). Drives the PRODUCTION CLI's
# make-repeating (--dangerously-drive-gui) for CREATE cells that combine an EXPLICIT
# calendar anchor with an off-rule --when (± deadline/start-earlier), and DB-verifies
# the landed rule + first-occurrence start + cursor via ~/labh/rsum.py. Self-contained:
# clone → boot → airgap → pin clock (Sun 2026-07-05 12:00) → ship dist → drive → verify
# → teardown (trap EXIT). Fixtures fully synthetic (DC-* titles). No golden mutation.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="dacon1-lab"
GOLDEN="things-lab-golden-v3"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[dacon1] $*" | tee -a "$REPORT"; }
cleanup() { echo "[dacon1] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
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
note "helpers installed"

# ship FIXED (no-refusal) production dist bundle
[ -f dist/cli/main.js ] || { note "FATAL: dist/cli/main.js missing"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() {
  # retry the fresh-clone password-auth flap (exit 255 / "lost connection"), like lab_ssh.
  local attempt code
  for attempt in 1 2 3 4 5; do
    sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; code=$?
    [ "$code" -eq 0 ] && return 0
    sleep 3
  done
  return "$code"
}
# ensure SSH is warm/stable before the large binary copy
lab_ssh "$IP" true </dev/null; sleep 2
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null || { note "FATAL: node scp failed"; exit 1; }
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
COMMANDER_DIR=$(node -e "const p=require.resolve('commander'); console.log(p.slice(0, p.indexOf('/node_modules/commander/')+'/node_modules/commander'.length))")
note "commander from: $COMMANDER_DIR"
scpO -r "$COMMANDER_DIR" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null || { note "FATAL: commander scp failed"; exit 1; }
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
CLI="~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js"
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
note "bundle shipped; Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)"

# warm-up launch (recompute Today for the pinned date) + disable AXEnhancedUI
lab_ssh "$IP" 'open -a Things3; sleep 12; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null
note "warm-up done"

# CLI health check
note "CLI version: $(lab_ssh "$IP" "$CLI --version" </dev/null 2>&1)"
note "add smoke:"; lab_ssh "$IP" "$CLI todo add 'SMOKE-DC' --when 2026-07-16" </dev/null 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
sleep 3
note "smoke rows: $(lab_ssh "$IP" "~/labh/gsql.sh -q \"SELECT count(*) FROM TMTask WHERE title='SMOKE-DC'\"" </dev/null 2>&1)"

# ---- helpers ----
tid() { lab_ssh "$IP" "~/labh/gsql.sh -q \"SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1\"" </dev/null; }
tmplid() { lab_ssh "$IP" "~/labh/gsql.sh -q \"SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1\"" </dev/null; }
rsum() { lab_ssh "$IP" "python3 ~/labh/rsum.py '$1'" </dev/null; }

# cell: <title> <when-for-add> <make-repeating args...>
cell() {
  local title="$1" whenAdd="$2"; shift 2
  note "---- CELL $title ----  args: $*"
  lab_ssh "$IP" "$CLI todo add '$title' --when $whenAdd" </dev/null >"$OUT/$title.add" 2>&1
  note "  add: $(tail -1 "$OUT/$title.add")"
  sleep 3
  local u; u=$(tid "$title")
  note "  seed uuid=$u"
  [ -n "$u" ] || { note "  SEED-FAIL"; return; }
  lab_ssh "$IP" "$CLI todo make-repeating $u $* --dangerously-drive-gui --verify-timeout 60000" </dev/null >"$OUT/$title.out" 2>&1
  note "  cli-exit=$? (full output: $OUT/$title.out)"
  sleep 2
  local t; t=$(tmplid "$title")
  note "  template uuid=$t"
  [ -n "$t" ] || { note "  NO-TEMPLATE (drive may have failed — see $title.out)"; tail -3 "$OUT/$title.out" | sed 's/^/    /' | tee -a "$REPORT"; return; }
  note "  RULE: $(rsum "$t")"
}

# ---- CREATE off-rule matrix (clock pinned Sun 2026-07-05) ----
# C1 weekly/no-deadline, explicit Wed anchor + off-rule Thursday --when (the maintainer's example shape).
cell DC1 2026-07-16 --frequency weekly --interval 1 --weekdays wednesday --when 2026-07-16
# C2 monthly/no-deadline, explicit day-20 anchor + off-rule day-10 --when.
cell DC2 2026-08-10 --frequency monthly --interval 1 --on-day 20 --when 2026-08-10
# C3 yearly/no-deadline, explicit Oct-16 anchor + off-rule Nov-05 --when.
cell DC3 2028-11-05 --frequency yearly --interval 1 --yearly-month 10 --on-day 16 --when 2028-11-05
# C4 yearly/DEADLINE — the live-host CREATE shape: explicit Oct-16 anchor, --when 2026-10-16, start-14.
cell DC4 2028-10-16 --frequency yearly --interval 1 --yearly-month 10 --on-day 16 --when 2028-10-16 --deadline --start-days-earlier 14
# C5 weekly/DEADLINE — explicit Wed anchor, off-rule Thu --when, start-2.
cell DC5 2026-07-16 --frequency weekly --interval 1 --weekdays wednesday --when 2026-07-16 --deadline --start-days-earlier 2

note "MATRIX DONE."
