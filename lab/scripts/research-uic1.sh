#!/bin/bash
# UIC1 — in-VM certification of the ui vector + AX addressing catalog (2026-07-14).
#
# Certifies the shipped ui-vector ops by running each through the REAL pipeline
# (guest e2e bundle) inside ONE disposable clone with Accessibility granted via
# the AXVM1 user-path toggle, asserting the exact DB deltas. Full write-up +
# addressing catalog: docs/lab/uic1-certification.md.
#
# VERDICT: 5/7 lab-certified (pause, resume, make-repeating, reschedule,
# todo.convert-to-project); 2/7 FAILED (stop-repeat — card opens only via a
# mouse double-click; heading.convert-to-project — headings not selectable via
# things:///show). Both failures share one root cause: Things list rows expose
# no AX/URL selection handle (AXVM1). Things 3.22.11 / macOS 15.7.7 / DB v26.
#
# Recipe fixes this campaign made certification possible (the as-shipped recipes
# would have failed): window 1 -> the main AXStandardWindow (window 1 is a 40x40
# AXUnknown utility window); frequency pop-up `set value` -> select-popup (set
# value is a silent no-op); interval field is nested in the dialog group; confirm
# buttons upgraded to AXIdentifier action-button-1; driver reveal-before-canary.
#
# VM discipline (research-ui2i.sh notes): --vnc-experimental is single-client —
# one vncdo per step, timeout-wrapped, ~3s settle. Relaunch Things before each op
# (heavy AX poking degrades the Items menu until relaunch). For JSON output use
# `2>/dev/null` — the SQLite ExperimentalWarning on stderr breaks a merged parse.
#
# Requires $VNCDO (vncdotool in a throwaway venv) for the one-time grant (rung b);
# everything else is SSH. sshpass + a golden with the L5 proxies.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"

# Seeded subjects (docs/lab/seed-manifest.json)
REPEAT_DAILY="W3PZB9e7W6BEtKmEKP4deG"       # fixed daily template (pause/resume/reschedule)
WEEKLY_PROJ="759yS6xe6d3a3h2dfVxoMZ"        # repeating PROJECT (parity note)
ALPHA_HEADING="5saDdJcodvWARN9Ct2nQsT"      # heading in LAB-PROJ-HEADINGS (heading-convert)

VM="things-run-uic1-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[uic1] $*" | tee -a "$REPORT"; }
cleanup() { echo "[uic1] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

# read-only guest SQLite helper + recurrence-rule decoder
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
lab_ssh "$IP" 'cat > /tmp/rrdump.sh && chmod +x /tmp/rrdump.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
HX=$(sqlite3 "file:$DB?mode=ro" "SELECT hex(rt1_recurrenceRule) FROM TMTask WHERE uuid='$1'")
[ -z "$HX" ] && { echo "NO-RULE"; exit 0; }
echo "$HX" | xxd -r -p | plutil -convert xml1 - -o - 2>/dev/null | tr -d '\n' | sed 's/></>\n</g' | grep -iA1 -E '<key>(fu|tp|ts)</key>' | tr '\n' ' '; echo
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# ---------- AXVM1 grant (rung b) ----------
note "############### grant Accessibility (AXVM1 rung b) ###############"
lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null # provoke the toggle row
if [ -z "$VNCDO" ] || [ -z "$VNC_URL" ]; then note "VNCDO/VNC_URL missing — grant arm SKIPPED, cannot certify. Abort."; exit 1; fi
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
V() { sleep 1; timeout 40 "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }
lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 6
V capture "$OUT/11-ax-pane.png"
V move 1642 332 click 1; sleep 3; V capture "$OUT/12-auth-sheet.png"   # flip toggle -> auth sheet
V move 1017 870 click 1 pause 0.5 type admin pause 0.5 move 1017 963 click 1; sleep 3   # password + Modify Settings
V capture "$OUT/13-after-auth.png"
note "-- AX rows after grant (expect ...|1|2) --"
lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT service,client,auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null | tee -a "$REPORT"

# ---------- ship the guest e2e bundle + enable ui config ----------
note "############### ship bundle + enable ui.enabled ###############"
npm run build >/dev/null
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
# NOTE: modern scp defaults to SFTP and mangles the remote path here — force the
# legacy protocol with -O (UIC1 friction finding).
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/dist"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
G config set ui-enabled true >/dev/null 2>&1
relaunch() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1; sleep 3; open -a Things3; sleep 9' </dev/null; }

# ---------- UIC1-a: certification suite ----------
note "############### UIC1-a: certification suite ###############"

note "-- pause-repeat (expect paused 0->1, next cleared) --"
relaunch
G todo pause-repeat "$REPEAT_DAILY" --dangerously-drive-gui --json 2>/dev/null | tee -a "$REPORT" >/dev/null
note "paused|next = $(gq "SELECT rt1_instanceCreationPaused||'|'||coalesce(rt1_nextInstanceStartDate,'NULL') FROM TMTask WHERE uuid='$REPEAT_DAILY'")"

note "-- resume-repeat (expect paused 1->0) --"
G todo resume-repeat "$REPEAT_DAILY" --dangerously-drive-gui --json 2>/dev/null >/dev/null
note "paused = $(gq "SELECT rt1_instanceCreationPaused FROM TMTask WHERE uuid='$REPEAT_DAILY'")"

note "-- make-repeating weekly/1 on a fresh plain to-do (identity replacement, fu=256) --"
NEW=$(G todo add '"UIC1-MAKEREP"' --json 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['uuid'])")
relaunch
G todo make-repeating "$NEW" --frequency weekly --interval 1 --dangerously-drive-gui --json 2>/dev/null | tee -a "$REPORT" >/dev/null
note "original present=$(gq "SELECT count(*) FROM TMTask WHERE uuid='$NEW'") (expect 0); new template rule:"
gq "SELECT uuid FROM TMTask WHERE title='UIC1-MAKEREP' AND rt1_recurrenceRule IS NOT NULL" | while read -r u; do lab_ssh "$IP" "/tmp/rrdump.sh $u" </dev/null | tee -a "$REPORT"; done

note "-- reschedule-repeat monthly/1 on LAB-REPEAT-DAILY (identity preserved, fu 16->8) --"
relaunch
G todo reschedule-repeat "$REPEAT_DAILY" --frequency monthly --interval 1 --dangerously-drive-gui --json 2>/dev/null >/dev/null
note "same uuid present=$(gq "SELECT count(*) FROM TMTask WHERE uuid='$REPEAT_DAILY'") rule:"; lab_ssh "$IP" "/tmp/rrdump.sh $REPEAT_DAILY" </dev/null | tee -a "$REPORT"

note "-- todo.convert-to-project on a fresh plain to-do (identity replacement, notes kept) --"
CT=$(G todo add '"UIC1-CONVTODO"' --notes '"marker"' --json 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['uuid'])")
relaunch
G todo convert-to-project "$CT" --dangerously-drive-gui --json 2>/dev/null | tee -a "$REPORT" >/dev/null
note "original present=$(gq "SELECT count(*) FROM TMTask WHERE uuid='$CT'") (expect 0); new project:"; gq "SELECT uuid,type,notes FROM TMTask WHERE title='UIC1-CONVTODO'"

note "-- stop-repeat (EXPECT FAIL-CLOSED: card opens only via mouse double-click) --"
relaunch
G todo stop-repeat "$REPEAT_DAILY" --dangerously-drive-gui --json 2>/dev/null | tee -a "$REPORT" >/dev/null
note "uuid unchanged present=$(gq "SELECT count(*) FROM TMTask WHERE uuid='$REPEAT_DAILY'") (expect still 1)"

note "-- heading.convert-to-project (EXPECT FAIL: heading not selectable via things:///show) --"
relaunch
G heading convert-to-project "$ALPHA_HEADING" --dangerously-drive-gui --json 2>/dev/null | tee -a "$REPORT" >/dev/null
note "heading unchanged type=$(gq "SELECT type FROM TMTask WHERE uuid='$ALPHA_HEADING'") (expect still 2)"

# ---------- gating ----------
note "############### gating ###############"
lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js todo pause-repeat $REPEAT_DAILY 2>&1 >/dev/null | head -1; echo exit=\${PIPESTATUS[0]}" </dev/null | tee -a "$REPORT" # expect blocked (4)
G config set ui-enabled false >/dev/null 2>&1
lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js todo pause-repeat $REPEAT_DAILY --dangerously-drive-gui 2>&1 >/dev/null | head -1" </dev/null | tee -a "$REPORT" # expect unsupported (6)
G config set ui-enabled true >/dev/null 2>&1

# ---------- UIC1-c: locale hardening ----------
note "############### UIC1-c: locale hardening ###############"
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1; sleep 2; defaults write com.culturedcode.ThingsMac AppleLanguages -array de; sleep 1; open -a Things3; sleep 10' </dev/null
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; open 'things:///show?id=$REPEAT_DAILY'; sleep 3" </dev/null
note "German menu (menu 2): $(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to return name of every menu item of menu 2 of menu bar 1'\'' 2>&1' </dev/null | head -c 80)"
note "English anchor resolves under de? $(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to return exists (menu item "Repeat" of menu "Items" of menu bar 1)'\'' 2>&1' </dev/null) (expect false)"
G todo pause-repeat "$REPEAT_DAILY" --dangerously-drive-gui --json 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print('[uic1] de pause ok=',d['ok'],'(expect False, fail-closed)')" | tee -a "$REPORT"
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1; sleep 2; defaults write com.culturedcode.ThingsMac AppleLanguages -array en; sleep 1; open -a Things3; sleep 10' </dev/null
note "back to en, anchor resolves? $(lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; open 'things:///show?id=$REPEAT_DAILY'; sleep 3; /usr/bin/osascript -e 'tell application \"System Events\" to tell process \"Things3\" to return exists (menu item \"Repeat\" of menu \"Items\" of menu bar 1)'" </dev/null) (expect true)"

note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 --"
note "GREEN — 5/7 lab-certified. report: $REPORT ; artifacts in $OUT"
