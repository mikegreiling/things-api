#!/bin/bash
# UIC6 — certify the FULL repeat-rule vocabulary (to-do + project make/reschedule).
# Full write-up + verdicts: docs/lab/uic6-rule-vocabulary.md.
#
# ONE disposable clone `uic6-lab` of things-lab-golden-v1: grant Accessibility
# (AXVM1 rung b), ship the production e2e bundle, enable ui.enabled, seed plain
# to-dos + projects, then drive each rule dimension THROUGH THE PRODUCTION CLI
# (--dangerously-drive-gui) and DB-verify the decoded rt1_recurrenceRule.
#
# The sitting corrected the provisional control paths wholesale (the field-map
# best-guess was structurally wrong) and three driver mechanisms (candidate-poll
# for revealed controls; self-healing pop-up open-click; keystroke-commit for
# numeric fields — `set value` updates the display but never fires the edit).
# TWO findings, recorded loudly: (1) the reminder-time AXDateTimeArea IGNORES AX
# writes on commit (an app accessibility bug — the "ends on date" picker, same
# role, honors them) → `--reminder` is refused fail-closed, NOT driven here;
# (2) after-completion rules carry a nominal offset, so ruleToInverseParams'
# after-completion null-branch was too strict (fixed — after-completion
# reschedule-undo now round-trips).
#
# VM discipline: --vnc-experimental single-client — space VNC calls (the RFB
# server drops back-to-back connections) and issue `capture` as a SOLE command.
# Requires $VNCDO (throwaway vncdotool venv): python3 -m venv <dir>/vncenv &&
#   <dir>/vncenv/bin/pip install vncdotool ; export VNCDO=<dir>/vncenv/bin/vncdo.
# Drive Things WARM (~14s after relaunch); relaunch before each case (menu health).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"

AREA_A="7Ck4hAXU36jyaBsy2Fkije"   # LAB-AREA-A (golden seed) — for the project-in-area case
VM="uic6-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/screens"
REPORT="$OUT/report.txt"
note() { echo "[uic6] $*" | tee -a "$REPORT"; }
cleanup() { echo "[uic6] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "cloning golden -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

# read-only guest SQLite + a compact recurrence-rule dumper (python plistlib)
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
lab_ssh "$IP" 'cat > /tmp/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
row=c.execute("SELECT rt1_recurrenceRule, deadline FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row or row[0] is None: print("NO-RULE deadlineCol=%s"%(row[1] if row else '?')); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s ed=%s of=[%s] deadlineCol=%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),d.get('ed'),",".join(offs),row[1]))
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
rsum() { lab_ssh "$IP" "python3 /tmp/rsum.py $1" </dev/null; }

# ---------- AXVM1 grant (rung b) ----------
note "############### grant Accessibility (AXVM1 rung b) ###############"
lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null
[ -z "$VNCDO" ] || [ -z "$VNC_URL" ] && { note "VNCDO/VNC_URL missing — grant needs VNC. Abort."; exit 1; }
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
V() { sleep 2; timeout 40 "$VNCDO" -s "$SERVER" -p "$PASS" "$@" 2>>"$OUT/vnc.log"; }
# System Settings is cold — open the Accessibility anchor, let it navigate, then toggle.
lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 12
V move 1642 332 click 1                                  # the lone sshd-keygen-wrapper toggle
V move 1018 869 click 1 pause 0.6 type admin pause 0.6 move 1018 963 click 1  # auth sheet
sleep 3
note "grant: $(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)"
lab_ssh "$IP" 'osascript -e '\''tell application "System Settings" to quit'\'' 2>/dev/null' </dev/null

# ---------- ship the guest e2e bundle + enable ui config ----------
note "############### build + ship bundle + enable ui.enabled ###############"
npm run build >/dev/null
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
# scp -r into the PARENT dir (a pre-existing target nests as dist/dist).
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
Gx() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*; echo EXIT=\$?" </dev/null; }
G config set ui-enabled true >/dev/null 2>&1
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }

# ---------- seed subjects ----------
note "############### seed subjects ###############"
for t in A B C D E F H K L M; do lab_ssh "$IP" "open 'things:///add?title=UIC6-$t'; sleep 0.6" </dev/null; done
lab_ssh "$IP" "open 'things:///add-project?title=UIC6-I&area-id=$AREA_A'; sleep 1" </dev/null
lab_ssh "$IP" "open 'things:///add-project?title=UIC6-J&when=someday'; sleep 1" </dev/null
uid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NULL LIMIT 1"; }
tmpl() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1"; }
gone() { [ "$(gq "SELECT count(*) FROM TMTask WHERE uuid='$1' AND trashed=0")" = 0 ] && echo Y || echo N; }

make_case() { # <title> <cli args...>
  local title="$1"; shift; local u; u=$(uid "$title"); warm
  G todo make-repeating "$u" "$@" --dangerously-drive-gui --json 2>/dev/null | tr ',' '\n' | grep -m1 '"ok"' | sed "s/^/  [$title] /" | tee -a "$REPORT"
  note "  [$title] origGone=$(gone "$u")  rule: $(rsum "$(tmpl "$title")")"
}

# ================= to-do make-repeating vocabulary =================
note "############### UIC6-a..h: to-do make-repeating vocabulary ###############"
make_case UIC6-A --frequency weekly  --interval 1 --weekdays monday,wednesday,friday   # of=[{wd:1},{wd:3},{wd:5}]
make_case UIC6-B --frequency monthly --interval 1 --on-weekday friday --on-ordinal last # fu=8 of=[{wd:5,wdo:-1}]
make_case UIC6-C --frequency monthly --interval 1 --on-day last                          # fu=8 of=[{dy:-1}]
make_case UIC6-D --frequency yearly  --interval 1 --yearly-month 10 --on-day 8           # fu=4 of=[{mo:9,dy:7}]
make_case UIC6-E --frequency weekly  --interval 2 --after-completion                     # tp=1 fu=256 fa=2 (nominal of=[{wd:0}])
make_case UIC6-F --frequency daily   --interval 1 --ends-after 5                         # rc=5
make_case UIC6-H --frequency weekly  --interval 1 --deadline --start-days-earlier 3      # ts=-3, deadlineCol non-null
make_case UIC6-M --frequency daily   --interval 1 --ends-on 2020-01-01                   # ed=1577836800 (past bound honored)

# ================= project make-repeating =================
note "############### UIC6-i,j: PROJECT make-repeating ###############"
warm; G project make-repeating "$(gq "SELECT uuid FROM TMTask WHERE title='UIC6-I' AND type=1 AND rt1_recurrenceRule IS NULL LIMIT 1")" --frequency weekly --interval 1 --weekdays monday,thursday --dangerously-drive-gui --json 2>/dev/null | tr ',' '\n' | grep -m1 '"ok"'
note "  [UIC6-I] of=[{wd:1},{wd:4}] expected: $(rsum "$(tmpl UIC6-I)")"
warm; G project make-repeating "$(gq "SELECT uuid FROM TMTask WHERE title='UIC6-J' AND type=1 AND rt1_recurrenceRule IS NULL LIMIT 1")" --frequency monthly --interval 1 --on-day last --dangerously-drive-gui --json 2>/dev/null | tr ',' '\n' | grep -m1 '"ok"'
note "  [UIC6-J] of=[{dy:-1}] expected: $(rsum "$(tmpl UIC6-J)")"

# ================= UIC6-k: reschedule round-trip undo =================
note "############### UIC6-k: reschedule round-trip undo (captured-rule inverse) ###############"
warm; G todo make-repeating "$(uid UIC6-K)" --frequency weekly --interval 1 --weekdays monday --dangerously-drive-gui --json >/dev/null 2>&1
KT=$(tmpl UIC6-K); note "  rule A: $(rsum "$KT")"
warm; RJ=$(G todo reschedule-repeat "$KT" --frequency monthly --interval 1 --on-weekday friday --on-ordinal last --dangerously-drive-gui --json 2>/dev/null)
note "  rule B: $(rsum "$KT")"
TOKEN=$(echo "$RJ" | python3 -c 'import sys,json
for l in sys.stdin:
 l=l.strip()
 if not l: continue
 try: d=json.loads(l)
 except: continue
 t=d.get("undoToken")
 if t: print(t); break')
warm; G undo --txn "$TOKEN" --json 2>/dev/null | tr ',' '\n' | grep -m1 '"outcome"'
note "  after undo (== rule A, identity preserved): $(rsum "$KT")"

# ================= UIC6-g,l: gated / negative =================
note "############### UIC6-g: reminder is REFUSED fail-closed (undrivable AXDateTimeArea) ###############"
Gx todo make-repeating "$(uid UIC6-L)" --frequency daily --interval 1 --reminder 09:00 --dangerously-drive-gui --json 2>&1 | grep -iE 'reminder time cannot|EXIT=' | tee -a "$REPORT"
note "############### UIC6-l: mapped contradiction refused, zero mutation ###############"
Gx todo make-repeating "$(uid UIC6-L)" --frequency monthly --interval 1 --weekdays monday --dangerously-drive-gui --json 2>&1 | grep -iE 'weekly rule|EXIT=' | tee -a "$REPORT"
note "  UIC6-L still plain: $(gq "SELECT CASE WHEN rt1_recurrenceRule IS NULL THEN 'PLAIN' ELSE 'RULE' END FROM TMTask WHERE title='UIC6-L' AND trashed=0")"

# ================= gating =================
note "############### gating ###############"
note "  no ack -> H-UI-DRIVE exit 4:"; Gx todo make-repeating "$(uid UIC6-L)" --frequency daily --interval 1 --json 2>&1 | grep -E 'EXIT='
G config set ui-enabled false >/dev/null 2>&1
note "  ui disabled -> unsupported exit 6:"; Gx todo make-repeating "$(uid UIC6-L)" --frequency daily --interval 1 --dangerously-drive-gui --json 2>&1 | grep -E 'EXIT='
G config set ui-enabled true >/dev/null 2>&1

note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 --"
note "DONE. report: $REPORT"
