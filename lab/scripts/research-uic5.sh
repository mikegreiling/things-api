#!/bin/bash
# UIC5 — certify project.make-repeating + the create-repeating composite (pure-AX,
# UIC4). Full write-up: docs/lab/uic5-build-certification.md.
#
# ONE disposable clone of things-lab-golden-v1: grant Accessibility (AXVM1 rung b),
# ship the production e2e bundle, enable ui.enabled, seed the taxonomy, then run
# the 7 cases + gating THROUGH THE PRODUCTION CLI (--dangerously-drive-gui),
# asserting guest DB deltas. Case e drives the corrected recipe's element paths
# backgrounded (Finder frontmost, open -g, no activate) to exercise the detached
# AXUnknown editor form.
#
# Corrections this sitting made to the shipped recipe (both driven by live AX):
#  (1) select-row: the row `select` action, NOT the silent-no-op table
#      AXSelectedRows attribute-set (ui.ts axSelectRowScript).
#  (2) detached interval field: `text field 1 of group 1 of <detached>`, not a
#      direct child (ui-recipes.ts DIALOG_INTERVAL).
#
# VM discipline: --vnc-experimental single-client — ONE vncdo per grant step.
# Requires $VNCDO (vncdotool venv): python3 -m venv <dir>/vncenv &&
#   <dir>/vncenv/bin/pip install vncdotool ; export VNCDO=<dir>/vncenv/bin/vncdo.
# AXEnhancedUserInterface stays false. Drive Things WARM (~14s after relaunch):
# a drive within ~9s of a cold launch can race the Items ▸ Repeat… materialization
# (fail-closed, no mutation).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"

AREA_A="7Ck4hAXU36jyaBsy2Fkije"        # LAB-AREA-A (golden seed)
WEEKLY_PROJ="759yS6xe6d3a3h2dfVxoMZ"    # LAB-REPEAT-WEEKLY-PROJ (already-repeating)

VM="things-run-uic5-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/screens"
REPORT="$OUT/report.txt"
note() { echo "[uic5] $*" | tee -a "$REPORT"; }
cleanup() { echo "[uic5] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

# read-only guest SQLite + recurrence decoder
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
echo "$HX" | xxd -r -p | plutil -convert xml1 - -o - 2>/dev/null | tr -d '\n' | sed 's/></>\n</g' | grep -iA1 -E '<key>(fu|of|tp)</key>' | tr '\n' ' '; echo
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
rr() { lab_ssh "$IP" "/tmp/rrdump.sh $1" </dev/null; }
noenh() { lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null || true; }
relaunch_warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14' </dev/null; }
frontapp() { lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to get name of first application process whose frontmost is true'\''' </dev/null; }

# ---------- AXVM1 grant (rung b) ----------
note "############### grant Accessibility (AXVM1 rung b) ###############"
lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null
if [ -z "$VNCDO" ] || [ -z "$VNC_URL" ]; then note "VNCDO/VNC_URL missing — grant needs VNC. Abort."; exit 1; fi
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
V() { sleep 1; timeout 40 "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }
lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 6
V move 1642 332 click 1; sleep 3
V move 1017 870 click 1 pause 0.5 type admin pause 0.5 move 1017 963 click 1; sleep 3
lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT service,client,auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null | tee -a "$REPORT"
noenh

# ---------- ship the guest e2e bundle + enable ui config ----------
note "############### build + ship bundle + enable ui.enabled ###############"
npm run build >/dev/null
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/dist"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
G config set ui-enabled true >/dev/null 2>&1

# ---------- seed the taxonomy ----------
note "############### seed taxonomy ###############"
lab_ssh "$IP" "open 'things:///add-project?title=UIC5-A&area-id=$AREA_A&to-dos=A1%0aA2'; sleep 2" </dev/null
lab_ssh "$IP" "open 'things:///add-project?title=UIC5-B&when=someday&to-dos=B1%0aB2'; sleep 2" </dev/null
lab_ssh "$IP" "open 'things:///add-project?title=UIC5-C&to-dos=C1%0aC2'; sleep 2" </dev/null
lab_ssh "$IP" "open 'things:///add-project?title=UIC5-E&when=someday&to-dos=E1'; sleep 2" </dev/null
lab_ssh "$IP" "open 'things:///add-project?title=UIC5-Dup&area-id=$AREA_A'; sleep 2" </dev/null
lab_ssh "$IP" "open 'things:///add-project?title=UIC5-Dup&area-id=$AREA_A'; sleep 2" </dev/null
gq "SELECT title||' '||uuid||' area='||coalesce(area,'-')||' start='||start FROM TMTask WHERE type=1 AND title LIKE 'UIC5-%' ORDER BY title" | tee -a "$REPORT"
A=$(gq "SELECT uuid FROM TMTask WHERE title='UIC5-A' AND type=1")
B=$(gq "SELECT uuid FROM TMTask WHERE title='UIC5-B' AND type=1")
C=$(gq "SELECT uuid FROM TMTask WHERE title='UIC5-C' AND type=1")
E=$(gq "SELECT uuid FROM TMTask WHERE title='UIC5-E' AND type=1")
DUP=$(gq "SELECT uuid FROM TMTask WHERE title='UIC5-Dup' AND type=1 LIMIT 1")
rows() { gq "SELECT group_concat(uuid||'/area='||coalesce(area,'-')||'/start'||start||'/'||(CASE WHEN rt1_recurrenceRule IS NULL THEN 'inst' ELSE 'TMPL' END)) FROM TMTask WHERE title='$1' AND trashed=0"; }
tmpl() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NOT NULL AND trashed=0"; }

# ================= UIC5-a: area project =================
note "############### UIC5-a: area project ###############"; relaunch_warm
G project make-repeating "$A" --frequency weekly --interval 1 --dangerously-drive-gui --json 2>/dev/null | tee -a "$REPORT" >/dev/null
note "orig present(0): $(gq "SELECT count(*) FROM TMTask WHERE uuid='$A' AND trashed=0")  rows: $(rows UIC5-A)  rule: $(rr "$(tmpl UIC5-A)")"

# ================= UIC5-b: area-less someday =================
note "############### UIC5-b: area-less someday ###############"; relaunch_warm
G project make-repeating "$B" --frequency weekly --interval 1 --dangerously-drive-gui --json 2>/dev/null >/dev/null
note "orig present(0): $(gq "SELECT count(*) FROM TMTask WHERE uuid='$B' AND trashed=0")  rows: $(rows UIC5-B)  rule: $(rr "$(tmpl UIC5-B)")"

# ================= UIC5-c: area-less anytime (coercion) =================
note "############### UIC5-c: area-less anytime -> Someday coercion ###############"; relaunch_warm
note "c start before(1): $(gq "SELECT start FROM TMTask WHERE uuid='$C'")"
G project make-repeating "$C" --frequency weekly --interval 1 --dangerously-drive-gui --json 2>/dev/null >/dev/null
note "orig present(0): $(gq "SELECT count(*) FROM TMTask WHERE uuid='$C' AND trashed=0")  rows(area-less,start2 == UIC5-b): $(rows UIC5-C)"

# ================= UIC5-d: composite =================
note "############### UIC5-d: create-repeating composite (monthly) ###############"; relaunch_warm
G project create-repeating '"CR Test"' --frequency monthly --interval 1 --dangerously-drive-gui --json 2>/dev/null | tee -a "$REPORT" >/dev/null
note "rows: $(rows 'CR Test')  rule(fu=8): $(rr "$(tmpl 'CR Test')")"

# ================= UIC5-e: backgrounded / detached editor =================
note "############### UIC5-e: backgrounded detached-editor drive (Finder frontmost) ###############"; relaunch_warm
DET='(first window whose subrole is "AXUnknown" and size is not {40, 40})'
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "Finder" to activate'\''' </dev/null; sleep 1
lab_ssh "$IP" "open -g 'things:///show?id=someday'; sleep 3" </dev/null; noenh
note "frontmost after -g reveal (Finder): $(frontapp)"
lab_ssh "$IP" "/usr/bin/osascript" </dev/null <<OSA >/dev/null
tell application "System Events" to tell process "Things3"
  set t to (table 1 of scroll area 1 of (first window whose subrole is "AXStandardWindow"))
  repeat with i from 1 to (count rows of t)
    try
      select (row i of t)
      tell application "Things3" to set sn to (name of selected to dos)
      if (count of sn) is 1 and ((item 1 of sn) as text) is "UIC5-E" then exit repeat
    end try
  end repeat
end tell
OSA
note "frontmost after select (Finder): $(frontapp)"
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1'\''' </dev/null; sleep 2
note "frontmost after Repeat press (Finder): $(frontapp)"
lab_ssh "$IP" "/usr/bin/osascript" </dev/null <<OSA >/dev/null
tell application "System Events" to tell process "Things3"
  set pu to (pop up button 1 of $DET)
  click pu
  delay 0.6
  click menu item "weekly" of menu 1 of pu
end tell
OSA
sleep 1
lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to tell process \"Things3\" to set value of (text field 1 of group 1 of $DET) to \"1\"'" </dev/null
sleep 1
lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to tell process \"Things3\" to click (button \"OK\" of $DET)'" </dev/null; sleep 3
note "frontmost after OK (Finder throughout = no focus steal): $(frontapp)"
note "orig present(0): $(gq "SELECT count(*) FROM TMTask WHERE uuid='$E' AND trashed=0")  rows: $(rows UIC5-E)  rule: $(rr "$(tmpl UIC5-E)")"

# ================= UIC5-f: negative already-repeating =================
note "############### UIC5-f: negative already-repeating ###############"; relaunch_warm
G project make-repeating "$WEEKLY_PROJ" --frequency monthly --interval 1 --dangerously-drive-gui --json 2>/dev/null; echo "exit=$?" | tee -a "$REPORT"
note "rule UNCHANGED(fu=256): $(rr "$WEEKLY_PROJ")  uuid present(1): $(gq "SELECT count(*) FROM TMTask WHERE uuid='$WEEKLY_PROJ'")"

# ================= UIC5-g: negative duplicate-title =================
note "############### UIC5-g: negative duplicate-title ambiguity ###############"; relaunch_warm
G project make-repeating "$DUP" --frequency weekly --interval 1 --dangerously-drive-gui --json 2>/dev/null; echo "exit=$?" | tee -a "$REPORT"
note "any Dup repeating(0): $(gq "SELECT count(*) FROM TMTask WHERE title='UIC5-Dup' AND rt1_recurrenceRule IS NOT NULL")  count(2): $(gq "SELECT count(*) FROM TMTask WHERE title='UIC5-Dup' AND type=1 AND trashed=0")"

# ================= gating =================
note "############### gating ###############"
lab_ssh "$IP" "open 'things:///add-project?title=UIC5-GATE&when=someday'; sleep 2" </dev/null
GATE=$(gq "SELECT uuid FROM TMTask WHERE title='UIC5-GATE' AND type=1"); relaunch_warm
note "no ack -> H-UI-DRIVE exit 4:"; G project make-repeating "$GATE" --frequency weekly --interval 1 --json 2>/dev/null; echo "exit=$?" | tee -a "$REPORT"
G config set ui-enabled false >/dev/null 2>&1
note "ui disabled -> unsupported exit 6:"; G project make-repeating "$GATE" --frequency weekly --interval 1 --dangerously-drive-gui --json 2>/dev/null; echo "exit=$?" | tee -a "$REPORT"
G config set ui-enabled true >/dev/null 2>&1

note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 --"
note "DONE. report: $REPORT"
