#!/bin/bash
# UIC2 — the project '...'-menu, repeating-PROJECT ops, and the stop-then-select
# CRASH (2026-07-15). Full write-up: docs/lab/uic2-project-menu.md.
#
# VERDICT: the four repeating-PROJECT repeat ops (make/reschedule/pause/resume)
# are DB-verified feasible but HYBRID-only — a synthetic MOUSE click opens Things'
# custom '...' menu / repeat-bar popover (whose items are AX-READABLE but INERT to
# AXPress), then pure AX drives the Repeat dialog sheet (byte-identical to the
# to-do dialog, freq _NS:116 / OK _NS:164; backgroundable, no focus steal). The
# '...' button itself is NOT an AX node. CRASH1 reproduced 2/2 (stop-repeat a
# project, then select the demoted project -> EXC_BREAKPOINT/SIGTRAP; transient,
# no data loss). todo.stop-repeat gains no new surface -> DROP.
#
# This is the reproducible record of an ADAPTIVE campaign (much was hand-driven
# over SSH + VNC). It is NOT a turnkey assertion suite — coordinate constants are
# framebuffer pixels at the golden's 2048x1536 (AX points x2), and the '...' /
# repeat-bar / popover-item positions are title-length-dependent. Re-derive by
# screenshot if the layout drifts.
#
# VM discipline: ONE --vnc-experimental clone; one vncdo per step, ~2s settle
# (single-client server). AXEnhancedUserInterface MUST stay false (true collapses
# Things' AX tree to 0 children). `entire contents` aborts to 0 on Things' custom
# views -> walk `UI elements` breadth-first. window 1 is the hidden AXUnknown
# utility window -> address `first window whose subrole is "AXStandardWindow"`.
#
# Requires $VNCDO (vncdotool in a throwaway venv) for the AXVM1 grant (rung b) and
# every menu/popover click; everything else is SSH. sshpass + the L5 golden.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"

SEED_WEEKLY_PROJ="759yS6xe6d3a3h2dfVxoMZ"   # LAB-REPEAT-WEEKLY-PROJ (repeating project, from seed)
SEED_REPEAT_TODO="W3PZB9e7W6BEtKmEKP4deG"   # LAB-REPEAT-DAILY (repeating to-do, for UIC2-d)

VM="things-run-uic2-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/crash" "$OUT/screens"
REPORT="$OUT/report.txt"
note() { echo "[uic2] $*" | tee -a "$REPORT"; }
cleanup() { echo "[uic2] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

# read-only guest SQLite helper + recurrence decoder (fu/tp/ts/of/wd keys)
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
echo "$HX" | xxd -r -p | plutil -convert xml1 - -o - 2>/dev/null | tr -d '\n' | sed 's/></>\n</g' | grep -iA1 -E '<key>(fu|tp|ts|of|wd|dy)</key>' | tr '\n' ' '; echo
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# ---------- AXVM1 grant (rung b) ----------
note "############### grant Accessibility (AXVM1 rung b) ###############"
lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null # provoke toggle row
if [ -z "$VNCDO" ] || [ -z "$VNC_URL" ]; then note "VNCDO/VNC_URL missing — grant + clicks need VNC. Abort."; exit 1; fi
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
# one vncdo per step, timeout-wrapped, ~2s settle (single-client server)
V() { sleep 2; timeout 40 "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }
lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 6
# NB the sshd-keygen-wrapper toggle is on the URL-opened "Allow ... to control your
# computer" list; clicking the ROW selects it, clicking the SWITCH (~1611,326 disp)
# raises the auth sheet. This build's sheet says "Unlock" (pwd field pre-focused,
# username pre-filled "Managed via Tart"): type password, click Unlock (~1138,1000).
V move 1638 334 click 1; sleep 3; V capture "$OUT/screens/12-auth.png"
V type admin; V move 1138 1000 click 1; sleep 3
note "-- AX rows after grant (expect ...|2) --"
lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT client,auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null | tee -a "$REPORT"

# ---------- UIC2-a(i): open -g reveals WITHOUT activating ----------
note "############### UIC2-a: open -g (no activation) ###############"
lab_ssh "$IP" "open 'things:///add-project?title=UIC2-PROJ-A'; sleep 3" </dev/null
PROJ=$(gq "SELECT uuid FROM TMTask WHERE title='UIC2-PROJ-A'")
note "plain project = $PROJ"
lab_ssh "$IP" 'osascript -e '\''tell application "Finder" to activate'\''; sleep 2' </dev/null
FM_BEFORE=$(lab_ssh "$IP" 'lsappinfo info -only name $(lsappinfo front) 2>/dev/null' </dev/null)
lab_ssh "$IP" "open -g 'things:///show?id=$PROJ'; sleep 3" </dev/null
FM_AFTER=$(lab_ssh "$IP" 'lsappinfo info -only name $(lsappinfo front) 2>/dev/null' </dev/null)
SEL=$(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "Things3" to get name of selected to dos'\''' </dev/null)
note "open -g: frontmost before=$FM_BEFORE after=$FM_AFTER (expect both Finder); selected=$SEL (project revealed+selected, no activation)"

# ---------- UIC2-a(ii): the '...' button is NOT an AX node; the Items bar has no Repeat ----------
note "############### UIC2-a: '...' not AX-addressable ###############"
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; open 'things:///show?id=$PROJ'; sleep 2" </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\''' </dev/null # MUST be false
note "Items menu has Repeat (project shown)? $(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to return exists (menu item "Repeat" of menu "Items" of menu bar 1)'\''' </dev/null) (expect false)"

# ---------- UIC2-a(iii) + UIC2-b: make-repeating via synthetic-click '...' + AX dialog ----------
# The '...' button (framebuffer ~1080,216 for an 11-char title; title-length-dependent)
# opens the project menu as a SEPARATE AXUnknown window; its items are AX-readable by
# `description` but INERT to AXPress -> click "Repeat..." (~1039,533) by coordinate.
# The Repeat dialog is a sheet -> drive by pure AX (select-popup freq, OK).
note "############### UIC2-a/b: project make-repeating (weekly) ###############"
V move 1080 216 click 1; sleep 2      # open '...' menu (synthetic mouse)
V capture "$OUT/screens/24-ellipsis-menu.png"
V move 1039 533 click 1; sleep 2      # click "Repeat..." (inert to AXPress; coordinate only)
lab_ssh "$IP" '/usr/bin/osascript <<'\''EOS'\''
tell application "System Events" to tell process "Things3"
  set sh to (sheet 1 of (first window whose subrole is "AXStandardWindow"))
  set freq to (pop up button 1 of sh)
  perform action "AXPress" of freq
  delay 1
  click (menu item "weekly" of menu 1 of freq)
  delay 1
  click (button "OK" of sh)
end tell
EOS' </dev/null
sleep 2
note "make-repeating: original present=$(gq "SELECT count(*) FROM TMTask WHERE uuid='$PROJ'") (expect 0, identity replacement)"
gq "SELECT uuid FROM TMTask WHERE title='UIC2-PROJ-A' AND rt1_recurrenceRule IS NOT NULL" | while read -r u; do note "  new template rule ($u): $(lab_ssh "$IP" "/tmp/rrdump.sh $u" </dev/null)"; done
TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='UIC2-PROJ-A' AND rt1_recurrenceRule IS NOT NULL")

# ---------- UIC2-a(iv): reschedule / pause / resume via the always-visible repeat bar ----------
# A repeating project's view shows an always-visible repeat bar (AX text area 2 of the
# header cell, framebuffer ~850,290). Clicking it opens the [Change.../Pause<->Resume/
# Stop/Show Latest] popover (AX-readable, INERT to AXPress -> coordinate clicks):
#   Change... ~773,360   Pause/Resume ~748,425   Stop ~740,472
note "############### UIC2-a: reschedule (Change... weekly->monthly) ###############"
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; open 'things:///show?id=$TMPL'; sleep 2" </dev/null
V move 850 290 click 1; sleep 2   # repeat bar -> popover
V move 773 360 click 1; sleep 2   # Change... -> dialog
lab_ssh "$IP" '/usr/bin/osascript <<'\''EOS'\''
tell application "System Events" to tell process "Things3"
  set sh to (sheet 1 of (first window whose subrole is "AXStandardWindow"))
  set freq to (pop up button 1 of sh)
  perform action "AXPress" of freq
  delay 1
  click (menu item "monthly" of menu 1 of freq)
  delay 1
  click (button "OK" of sh)
end tell
EOS' </dev/null
sleep 2
note "reschedule: same uuid present=$(gq "SELECT count(*) FROM TMTask WHERE uuid='$TMPL'") rule=$(lab_ssh "$IP" "/tmp/rrdump.sh $TMPL" </dev/null) (expect fu 256->8, identity preserved)"

note "############### UIC2-a: pause + resume ###############"
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; open 'things:///show?id=$TMPL'; sleep 2" </dev/null
V move 850 290 click 1; sleep 2; V move 748 425 click 1; sleep 2   # repeat bar -> Pause
note "pause: $(gq "SELECT 'paused='||rt1_instanceCreationPaused||' next='||coalesce(rt1_nextInstanceStartDate,'NULL') FROM TMTask WHERE uuid='$TMPL'") (expect paused=1 next=NULL)"
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; open 'things:///show?id=$TMPL'; sleep 2" </dev/null
V move 850 290 click 1; sleep 2; V move 748 425 click 1; sleep 2   # repeat bar -> Resume (same slot)
note "resume: $(gq "SELECT 'paused='||rt1_instanceCreationPaused FROM TMTask WHERE uuid='$TMPL'") (expect paused=0, next restored)"

# ---------- UIC2-c / CRASH1 ----------
note "############### UIC2-c / CRASH1: stop-then-select ###############"
BASE_IPS=$(lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3*.ips 2>/dev/null | wc -l' </dev/null | tr -d ' ')
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; open 'things:///show?id=$TMPL'; sleep 2" </dev/null
V move 850 290 click 1; sleep 2; V move 740 472 click 1; sleep 2   # repeat bar -> Stop -> confirm sheet
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to click (button "Stop" of sheet 1 of (first window whose subrole is "AXStandardWindow"))'\''' </dev/null # action-button-1 IS AX-actuatable
sleep 2
note "after Stop: template present=$(gq "SELECT count(*) FROM TMTask WHERE uuid='$TMPL'") (expect 0); Things alive=$(lab_ssh "$IP" 'pgrep -x Things3' </dev/null) (crash is on SELECT, not Stop)"
DEMOTED=$(gq "SELECT uuid FROM TMTask WHERE title='UIC2-PROJ-A' AND rt1_recurrenceRule IS NULL ORDER BY rowid DESC LIMIT 1")
lab_ssh "$IP" "open 'things:///show?id=$DEMOTED'; sleep 4" </dev/null
note "PID after selecting demoted ($DEMOTED): '$(lab_ssh "$IP" 'pgrep -x Things3' </dev/null)' (expect EMPTY = crashed)"
sleep 4
for f in $(lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3*.ips 2>/dev/null' </dev/null); do
  sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "admin@$IP:$f" "$OUT/crash/" 2>/dev/null || true
done
note "crash .ips banked: $(ls "$OUT/crash/" | tr '\n' ' ')"
lab_ssh "$IP" 'open -a Things3; sleep 10' </dev/null
note "after relaunch: demoted survives=$(gq "SELECT 'trashed='||trashed||' status='||status||' rule='||(CASE WHEN rt1_recurrenceRule IS NULL THEN 'NULL' ELSE 'SET' END) FROM TMTask WHERE uuid='$DEMOTED'") (no data loss)"
lab_ssh "$IP" "open 'things:///show?id=$DEMOTED'; sleep 3" </dev/null
note "re-select demoted after relaunch: PID=$(lab_ssh "$IP" 'pgrep -x Things3' </dev/null) (expect ALIVE — crash is TRANSIENT)"

# ---------- UIC2-d: todo.stop-repeat re-check ----------
note "############### UIC2-d: to-do Stop reachability ###############"
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; open 'things:///show?id=$SEED_REPEAT_TODO'; sleep 2" </dev/null
note "to-do Items>Repeat submenu = $(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to return name of every menu item of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1'\''' </dev/null) (expect Reschedule/Pause/Show Latest — NO Stop). Verdict: DROP."

note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 --"
note "DONE. report: $REPORT ; artifacts in $OUT"
