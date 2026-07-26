#!/bin/bash
# UIC7 — certify the reschedule-repeat GUI-drive CLUSTER fixes (docs/up-next.md
# §0½ item 1, defects (a)–(f)). Full write-up: docs/lab/uic7-reschedule-cluster.md.
#
# ONE disposable clone `uic7-lab` of things-lab-golden-v1: grant Accessibility
# (AXVM1 rung b), ship the production e2e bundle, enable ui.enabled, then drive
# the CONVERSION shapes the earlier certifications (UIC5/UIC6) never exercised —
# fixed→after-completion, after-completion→fixed, interval 1 vs >1 across units —
# THROUGH THE PRODUCTION CLI (--dangerously-drive-gui) and DB-verify the decoded
# rt1_recurrenceRule. Captures raw --json stdout on every drive (defect (b)),
# exercises the pre-drive idempotency no-op + post-abort recovery (defect (a)),
# the live open-sheet preflight diagnosis (defect (e)), and the residual-rule-
# fields probe (defect (f)).
#
# VM discipline mirrors research-uic6.sh: --vnc-experimental single-client; grant
# via VNC (requires $VNCDO); drive Things WARM (~14s after relaunch); relaunch
# before each case (menu health).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"

VM="uic7-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/json"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "[uic7] $*" | tee -a "$REPORT"; }
cleanup() { echo "[uic7] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "cloning golden -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

# read-only guest SQLite + recurrence-rule dumper (python plistlib)
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
row=c.execute("SELECT rt1_recurrenceRule, deadline, rt1_nextInstanceStartDate FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row or row[0] is None: print("NO-RULE deadlineCol=%s"%(row[1] if row else '?')); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s ed=%s of=[%s] deadlineCol=%s next=%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),d.get('ed'),",".join(offs),row[1],row[2]))
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
lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 12
V move 1642 332 click 1
V move 1018 869 click 1 pause 0.6 type admin pause 0.6 move 1018 963 click 1
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
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
Gx() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*; echo EXIT=\$?" </dev/null; }
G config set ui-enabled true >/dev/null 2>&1
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }

uid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NULL LIMIT 1"; }
tmpl() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1"; }
# capture --json stdout to a file, echo the parse verdict + the ok/error flag
jcap() { # <name> <cli args...>
  local name="$1"; shift
  local f="$OUT/json/$name.json"
  # G runs the CLI in the guest via ssh and returns the guest's STDOUT here, so
  # this captures exactly the --json stdout of ONE real drive. stderr is dropped
  # (defect (b): stdout must be a clean JSON envelope with no plain-text banner).
  G "$@" --json >"$f" 2>/dev/null || true
  local verdict
  verdict=$(python3 -c 'import sys,json
raw=open(sys.argv[1]).read().strip()
if not raw: print("EMPTY-STDOUT"); sys.exit()
try:
 lines=[l for l in raw.splitlines() if l.strip()]
 objs=[json.loads(l) for l in lines]
 print("VALID-JSON lines=%d ok=%s"%(len(objs), objs[-1].get("ok")))
except Exception as e:
 print("NON-JSON-STDOUT: %r (first80=%r)"%(e, raw[:80]))' "$f")
  note "  [$name] --json stdout: $verdict"
}

# ================= seed subjects (plain to-dos) =================
note "############### seed subjects ###############"
for t in A C F G I; do lab_ssh "$IP" "open 'things:///add?title=UIC7-$t'; sleep 0.6" </dev/null; done

# ================= (c)+(a) THE INCIDENT: fixed biweekly -> after-completion biweekly =================
note "############### UIC7-a: seed FIXED biweekly (weekly/interval-2) via make-repeating ###############"
warm; jcap make-A todo make-repeating "$(uid UIC7-A)" --frequency weekly --interval 2 --dangerously-drive-gui
AT=$(tmpl UIC7-A); note "  rule A (expect tp=0 fu=256 fa=2): $(rsum "$AT")"

note "############### UIC7-b: THE REPRO — reschedule fixed biweekly -> AFTER-COMPLETION biweekly (defect (c) plural unit + (a) verify) ###############"
warm; jcap resched-incident todo reschedule-repeat "$AT" --after-completion --frequency weekly --interval 2 --dangerously-drive-gui
note "  rule B (expect tp=1 fu=256 fa=2 — the conversion the field report reported as FAILED): $(rsum "$AT")"

note "############### UIC7-c: pre-drive IDEMPOTENCY — reschedule to the SAME after-completion biweekly again (defect (a)) ###############"
warm; jcap resched-idempotent todo reschedule-repeat "$AT" --after-completion --frequency weekly --interval 2 --dangerously-drive-gui
note "  idempotency: expect ok + 'already in the requested state' warning, NO drive; rule unchanged: $(rsum "$AT")"

note "############### UIC7-d: after-completion -> FIXED round trip ###############"
warm; jcap resched-back todo reschedule-repeat "$AT" --frequency weekly --interval 2 --dangerously-drive-gui
note "  rule C (expect tp=0 fu=256 fa=2 again): $(rsum "$AT")"

# ================= interval 1 vs >1 across units (after-completion unit pluralization) =================
note "############### UIC7-e: after-completion DAILY interval 1 (SINGULAR 'day') ###############"
warm; jcap make-C todo make-repeating "$(uid UIC7-C)" --after-completion --frequency daily --interval 1 --dangerously-drive-gui
note "  UIC7-C (expect tp=1 fu=16 fa=1): $(rsum "$(tmpl UIC7-C)")"

note "############### UIC7-f: reschedule UIC7-C -> after-completion MONTHLY interval 3 (PLURAL 'months', interval>1) ###############"
CT=$(tmpl UIC7-C)
warm; jcap resched-monthly3 todo reschedule-repeat "$CT" --after-completion --frequency monthly --interval 3 --dangerously-drive-gui
note "  UIC7-C rule (expect tp=1 fu=8 fa=3): $(rsum "$CT")"

# ================= (f) residual-rule-fields probe =================
note "############### UIC7-g: RESIDUAL FIELDS (defect (f)) — fixed weekly/2 with deadline+start-3-earlier+weekday, then convert to after-completion ###############"
warm; jcap make-F todo make-repeating "$(uid UIC7-F)" --frequency weekly --interval 2 --weekdays monday --deadline --start-days-earlier 3 --dangerously-drive-gui
FT=$(tmpl UIC7-F); note "  UIC7-F rule A (expect tp=0 ts=-3 of=[{wd:1}] deadlineCol non-null): $(rsum "$FT")"
warm; jcap resched-F todo reschedule-repeat "$FT" --after-completion --frequency weekly --interval 2 --dangerously-drive-gui
note "  UIC7-F rule B (after-completion — do ts=-3 / of=[{wd:1}] SURVIVE?): $(rsum "$FT")"
# complete the spawned instance and observe the next spawn's date vs pure after-completion cadence
FI=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$FT' AND trashed=0 AND status=0 ORDER BY startDate LIMIT 1")
note "  spawned instance $FI startDate/deadline BEFORE completion: $(gq "SELECT startDate||' / '||IFNULL(deadline,'NULL') FROM TMTask WHERE uuid='$FI'")"
warm; jcap complete-F todo complete "$FI" --dangerously-drive-gui
sleep 2
note "  next spawn AFTER completion (pure after-completion cadence = +14d from completion 2026-07-05; residue would skew): $(gq "SELECT uuid||' start='||startDate||' deadline='||IFNULL(deadline,'NULL') FROM TMTask WHERE rt1_repeatingTemplate='$FT' AND trashed=0 AND status=0 ORDER BY startDate")"
note "  template next-instance pointer: $(rsum "$FT")"

# ================= (e) live open-sheet preflight diagnosis + (b) clean --json on refusal =================
note "############### UIC7-h: (e) OPEN-SHEET preflight diagnosis — open the Repeat dialog by hand, then drive a reschedule ###############"
warm
# select the template + open Items > Repeat > Reschedule... by hand, LEAVE it open
lab_ssh "$IP" "open 'things:///show?id=$AT'; sleep 3" </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\'' -e '\''delay 1'\'' -e '\''tell application "System Events" to tell process "Things3" to click menu item "Reschedule…" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1'\'' 2>/dev/null; sleep 2' </dev/null
note "  sheet open? $(lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to return (exists sheet 1 of (first window whose subrole is "AXStandardWindow"))'\'' 2>/dev/null' </dev/null)"
jcap resched-opensheet todo reschedule-repeat "$AT" --frequency daily --interval 1 --dangerously-drive-gui
note "  (e) refusal message (expect 'modal sheet ... Dismiss the open sheet'):"
python3 -c 'import sys,json
raw=open(sys.argv[1]).read().strip()
for l in raw.splitlines():
 try: d=json.loads(l)
 except: continue
 m=(d.get("error") or {}).get("message","")
 if m: print("   >>",m[:400])' "$OUT/json/resched-opensheet.json" | tee -a "$REPORT"
# clean up any leftover sheet
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' 2>/dev/null' </dev/null

# ================= gating sanity =================
note "############### gating ###############"
note "  no ack -> H-UI-DRIVE exit 4:"; Gx todo reschedule-repeat "$AT" --frequency daily --interval 1 --json 2>&1 | grep -E 'EXIT='
G config set ui-enabled false >/dev/null 2>&1
note "  ui disabled -> unsupported exit 6:"; Gx todo reschedule-repeat "$AT" --frequency daily --interval 1 --dangerously-drive-gui --json 2>&1 | grep -E 'EXIT='
G config set ui-enabled true >/dev/null 2>&1

note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 --"
note "DONE. report: $REPORT ; json: $OUT/json/"
