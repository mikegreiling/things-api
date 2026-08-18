#!/bin/bash
# RRD1 — checkbox-converge certification (reschedule on a PRE-POPULATED Repeat
# dialog). Drives the FIXED production CLI against a disposable golden-v3 clone
# (rrd1-lab, Things 3.22.14), airgapped, clock pinned Sun 2026-07-05 12:00.
# Subcommand driver (like yanch1-ax.sh) so cells can be re-run individually.
#
#   bash lab/scripts/rrd1-checkbox.sh setup      # airgap+pin+helpers+ship dist
#   bash lab/scripts/rrd1-checkbox.sh <cell...>  # run a cert cell
#
# The VM must already be running (tart run rrd1-lab). Golden untouched; every
# write happens inside the clone. Fixtures fully synthetic (RRD-* titles).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="rrd1-lab"; OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax" "$OUT/json" "$OUT/snaps"
REPORT="$OUT/report.txt"
note() { echo "[rrd1] $*" | tee -a "$REPORT"; }
IP=$(tart ip "$VM" 2>/dev/null || true); [ -n "$IP" ] || { echo "no IP for $VM (running?)"; exit 1; }
S(){ lab_ssh "$IP" "$@" </dev/null; }
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
G(){ S "$CLI $*"; }
gq(){ S "~/labh/gsql.sh -q $(printf '%q' "$1")"; }
rsum(){ S "python3 ~/labh/rsum.py $1"; }
warm(){ S 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3; open -a Things3; sleep 15; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; echo warm-done'; }
settle(){ S 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3; echo settled'; }
# drive: run a CLI mutation, capture full JSON + exit; echo a one-line verdict.
drive(){ local label="$1"; shift; S "$CLI $* ; echo EXIT=\$?" > "$OUT/json/$label.log" 2>&1
  { grep -m1 '"ok"\|"kind": *"ok"' "$OUT/json/$label.log" || grep -m1 'error\|blocked\|refus\|verify-failed\|"kind"' "$OUT/json/$label.log" || echo '(no verdict line)'; } | sed "s/^/  [$label] /" | tee -a "$REPORT"
  grep -m1 'EXIT=' "$OUT/json/$label.log" | sed "s/^/  [$label] /" | tee -a "$REPORT"; }
# uuid resolvers
uidt(){ gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_repeatingTemplate IS NULL AND rt1_recurrenceRule IS NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
tmplt(){ gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
instt(){ gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_repeatingTemplate IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
allrows(){ gq "SELECT uuid||' type='||type||' tmpl='||COALESCE(rt1_repeatingTemplate,'-')||' hasRule='||(rt1_recurrenceRule IS NOT NULL)||' trashed='||trashed||' start='||COALESCE(start,'-')||' next='||COALESCE(rt1_nextInstanceStartDate,'-') FROM TMTask WHERE title='$1' ORDER BY creationDate"; }

cmd="${1:-}"; shift || true
case "$cmd" in
ip) echo "$IP" ;;

setup)
  note "=== SETUP $(date) ==="
  S 'sudo route -n delete default >/dev/null 2>&1 || true'
  note "airgap: $(S 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo FAIL || echo OK')"
  S 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null'
  note "clock: $(S date)"
  GRANT=$(S 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"')
  note "AX grant=$GRANT (want 2)"; [ "$GRANT" = "2" ] || { note "FATAL: AX grant missing"; exit 1; }
  S 'mkdir -p ~/labh'
  lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(ls -1d ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite | head -1)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
  lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationStartDate, rt1_instanceCreationCount, deadline, rt1_repeatingTemplate FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row: print("NO-ROW"); sys.exit(0)
if row[0] is None: print("NO-RULE tmpl=%s deadline=%s"%(row[5],dpk(row[4]))); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s of=[%s] next=%s icStart=%s icCount=%s deadline=%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),",".join(offs),
    dpk(row[1]),dpk(row[2]),row[3],dpk(row[4])))
EOF
  note "guest helpers installed"
  [ -f dist/cli/main.js ] || { note "FATAL: dist/cli/main.js missing (npm run build)"; exit 1; }
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  S 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules'
  scpO(){ sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
  S 'rm -rf ~/things-lab/things-api/dist'
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/"
  scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
  S 'chmod +x ~/things-lab/bin/node'
  S '~/things-lab/bin/node --version' >/dev/null 2>&1 || { note "FATAL: guest node not runnable"; exit 1; }
  G config set ui-enabled true >/dev/null 2>&1
  note "bundle shipped; ui-enabled=true; Things $(S 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString')"
  note "SETUP DONE."
  ;;

# ---- seed a deadlined monthly last-day template (make-repeating) ----
seedA)
  T="RRD-A"
  drive A-add todo add \""$T"\" --when 2026-07-31 --json
  U=$(uidt "$T"); note "seed to-do $T uuid=$U"
  warm >/dev/null
  drive A-mkrep todo make-repeating "$U" --frequency monthly --interval 1 --on-day last --deadline --start-days-earlier 14 --dangerously-drive-gui --json
  settle >/dev/null
  note "rows for $T:"; allrows "$T" | sed 's/^/    /' | tee -a "$REPORT"
  TPL=$(tmplt "$T"); INST=$(instt "$T")
  note "template=$TPL  instance=$INST"
  note "template rule: $(rsum "$TPL")"
  [ -n "$INST" ] && note "instance rule: $(rsum "$INST")"
  ;;

# ---- CELL A: reschedule the deadlined series (maintainer's exact shape) ----
cellA)
  T="RRD-A"; TPL=$(tmplt "$T"); INST=$(instt "$T")
  REF="${1:-$INST}"; [ -n "$REF" ] || REF="$TPL"
  note "=== CELL A: reschedule deadlined series (ref=$REF) ==="
  note "PRE: $(rsum "$TPL")"
  warm >/dev/null
  # monthly/1, 4th-Tuesday, --when 2026-09-01 (first Tuesday of Sept is 09-01), --deadline --start-days-earlier 21
  drive A-resched todo reschedule-repeat "$REF" --frequency monthly --interval 1 --on-weekday tuesday --on-ordinal 4 --when 2026-09-01 --deadline --start-days-earlier 21 --dangerously-drive-gui --json
  settle >/dev/null
  TPL=$(tmplt "$T")
  note "POST: $(rsum "$TPL")"
  note "  EXPECT: of=[{wd=2,wdo=4}] ts=-21 next=2026-09-01 deadline set (4001-01-01)"
  ;;

# ---- CELL B: reschedule SAME template, NO --deadline (rule-only) → preserve ----
cellB)
  T="RRD-A"; TPL=$(tmplt "$T"); INST=$(instt "$T")
  REF="${1:-$INST}"; [ -n "$REF" ] || REF="$TPL"
  note "=== CELL B: reschedule NO --deadline (interval 2), expect deadline PRESERVED (ref=$REF) ==="
  note "PRE: $(rsum "$TPL")"
  warm >/dev/null
  drive B-resched todo reschedule-repeat "$REF" --frequency monthly --interval 2 --on-weekday tuesday --on-ordinal 4 --when 2026-09-01 --dangerously-drive-gui --json
  settle >/dev/null
  TPL=$(tmplt "$T")
  note "POST: $(rsum "$TPL")"
  note "  EXPECT: fa=2, deadline STILL set (4001-01-01), ts still -21 (preserved)"
  ;;

# ---- CELL C: reminder-carrying template rescheduled without --reminder → preserve ----
seedC)
  T="RRD-C"
  drive C-add todo add \""$T"\" --when 2026-07-31 --json
  U=$(uidt "$T"); note "seed to-do $T uuid=$U"
  warm >/dev/null
  drive C-mkrep todo make-repeating "$U" --frequency monthly --interval 1 --on-day last --reminder 09:00 --dangerously-drive-gui --json
  settle >/dev/null
  note "rows for $T:"; allrows "$T" | sed 's/^/    /' | tee -a "$REPORT"
  TPL=$(tmplt "$T"); INST=$(instt "$T")
  note "template=$TPL instance=$INST"
  note "instance reminderTime: $(gq "SELECT COALESCE(reminderTime,'NULL') FROM TMTask WHERE uuid='$INST'")"
  ;;
cellC)
  T="RRD-C"; TPL=$(tmplt "$T"); INST=$(instt "$T")
  REF="${1:-$INST}"; [ -n "$REF" ] || REF="$TPL"
  note "=== CELL C: reschedule NO --reminder (interval 2), expect reminderTime PRESERVED (ref=$REF) ==="
  note "PRE template reminderTime: $(gq "SELECT COALESCE(reminderTime,'NULL') FROM TMTask WHERE uuid='$TPL'") (603979776 = 9<<26 = 09:00)"
  warm >/dev/null
  drive C-resched todo reschedule-repeat "$REF" --frequency monthly --interval 2 --on-day last --dangerously-drive-gui --json
  settle >/dev/null
  TPL=$(tmplt "$T")
  note "POST: $(rsum "$TPL")"
  note "POST template reminderTime: $(gq "SELECT COALESCE(reminderTime,'NULL') FROM TMTask WHERE uuid='$TPL'") (EXPECT 603979776, preserved — box untouched)"
  ;;

# ---- CELL D: genuine idempotent re-run of cell A's command ----
cellD)
  T="RRD-A"; TPL=$(tmplt "$T"); INST=$(instt "$T")
  REF="${1:-$INST}"; [ -n "$REF" ] || REF="$TPL"
  note "=== CELL D: re-run CELL A command → expect idempotent no-op, ZERO drive (ref=$REF) ==="
  note "PRE: $(rsum "$TPL")"
  warm >/dev/null
  drive D-resched todo reschedule-repeat "$REF" --frequency monthly --interval 1 --on-weekday tuesday --on-ordinal 4 --when 2026-09-01 --deadline --start-days-earlier 21 --dangerously-drive-gui --json
  settle >/dev/null
  note "  EXPECT: ok + 'already in the requested state' warning, NO dialog driven"
  ;;

dbpath) S 'ls -1d ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite' ;;
env) note "Things $(S 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString') / macOS $(S 'sw_vers -productVersion') / clock $(S 'date +%Y-%m-%dT%H:%M')" ;;
raw) S "$1" ;;
gq) gq "$1" ;;
rsum) rsum "$1" ;;
allrows) allrows "$1" ;;
*) echo "unknown cmd: $cmd"; exit 2 ;;
esac
