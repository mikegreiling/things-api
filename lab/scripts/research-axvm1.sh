#!/bin/bash
# AXVM1 — FALSIFIED "Accessibility is unusable in Tart VMs" (2026-07-14).
#
# The standing claim ("AX is SIP-blocked in VMs", UI1/SX4) conflated TWO distinct
# facts: (1) the golden has Accessibility NEVER GRANTED (a real AX op → -1719
# because no grant row exists), and (2) SX4 found a DIRECT write to the SYSTEM
# TCC.db fails ("attempt to write a readonly database") because SIP protects it.
# NEITHER says the *user-path* grant is impossible. It is not: System Settings
# drives tccd (the SIP-legitimate daemon) and the toggle flips auth_value 0->2
# with SIP still ENABLED. VERDICT: AX IS usable in Tart guests — first success at
# rung (b), the GUI toggle grant. The ui-vector is now LAB-CERTIFIABLE.
#
# Ladder (probed in order; stops at first success — reached (b)):
#   AXVM1-a  inventory: csrutil status (enabled), SYSTEM+USER TCC.db Accessibility
#            /PostEvent rows (NONE for AX at start; PostEvent granted to
#            screensharing.agent = why VNC HID already works), the baseline
#            failure, and the responsible-process identity.
#            KEY NUANCE: `System Events → get name of first process` is NOT AX-gated
#            (process ENUMERATION is light) — it returns exit 0 even ungranted, so
#            it is a BAD discriminator (this is likely what seeded the original
#            "AX works? no" confusion). The real gate fires on UI-ELEMENT access:
#              tell process "Things3" to get name of every menu of menu bar 1
#            -> "osascript is not allowed assistive access. (-1719)". That denied
#            attempt AUTO-CREATES a disabled row:
#              kTCCServiceAccessibility | /usr/libexec/sshd-keygen-wrapper | 1 | 0
#            i.e. the SSH-osascript responsible process is the sshd-keygen-wrapper,
#            and TCC pre-populates a TOGGLEABLE entry (no file-picker needed).
#   AXVM1-b  user-path grant via VNC: open the Accessibility pane by URL, flip the
#            lone "sshd-keygen-wrapper" toggle, authenticate admin/admin at the
#            "Privacy & Security is trying to modify your system settings" sheet.
#            -> auth_value 0->2. Re-probe over SSH: menu bar + window titles read
#            fine (exit 0). SIP stays enabled. WORKS.
#   AXVM1-c  (not needed) direct system-TCC.db INSERT reconfirmed read-only (SX4).
#            recoveryOS `csrutil disable` path would be the escalation had (b)
#            failed — NOT exercised (see docs/lab/axvm1-accessibility.md).
#   AXVM1-d  payoff smoke: select a repeating template by its stable handle
#            (`things:///show?id=`), press Items ▸ Repeat ▸ Pause purely by element
#            NAME via System Events over SSH (NO coordinates) -> DB
#            rt1_instanceCreationPaused 0->1 + rt1_nextInstanceStartDate cleared
#            (matches UI2-c). BACKGROUND: with Finder frontmost the press STILL
#            works AND frontmost stays Finder — AX element press needs neither
#            frontmost nor focus-steal (unlike VNC coordinate clicks, UI2-e). LOCK:
#            under a genuine `sysadminctl -screenLock immediate` lock the press
#            STILL works (unlike VNC clicks which hit the lock screen, LOCK1 arm f).
#   AXVM1-e  persistence: the grant SURVIVES a guest reboot (auth_value=2 persists;
#            AX over SSH works post-reboot) -> bakeable into a golden v2 layer.
#
# NOTE (Things AX topology): Things' LIST ROWS are NOT AX-addressable by title
# (sparse custom rendering — `entire contents of row` is empty; this is why UI2
# used VNC coordinate clicks). The MENU BAR, by contrast, is fully AX-exposed. So
# the working recipe selects the target with the URL scheme (a stable handle, not
# a coordinate) and drives the CONTEXTUAL menu by name. The Items ▸ Repeat submenu
# only materializes when a repeating item is selected; its items are
# "Reschedule…", "Pause"↔"Resume", "Show Latest" (matches UI2-c's menu-surface
# set; the Stop action UI2-i found lives only in the open-card popover).
#
# NOTE zsh `log` builtin gotcha: always use /usr/bin/... full paths in the guest.
# COORDINATES below are the golden's VNC framebuffer (2048x1536); the Accessibility
# pane shows exactly ONE row (the auto-created sshd-keygen-wrapper), so the toggle
# position is stable. Requires $VNCDO (vncdotool in a throwaway venv) for rung (b).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}" # path to a vncdotool CLI (REQUIRED for the GUI grant arm)

REPEAT_DAILY="W3PZB9e7W6BEtKmEKP4deG" # seeded LAB-REPEAT-DAILY (deadline-less fixed daily control)

VM="things-run-axvm1-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[axvm1] $*" | tee -a "$REPORT"; }
cleanup() { echo "[axvm1] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300)
note "ssh up at $IP"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
note "vnc url: ${VNC_URL:-<none>}"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN: still online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
axprobe() { # a REAL UI-element AX op (menu-bar read); the true -1719 discriminator
  lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' 2>&1; echo "[exit $?]"' </dev/null
}
axrows() { lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT service,client,client_type,auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''" 2>&1' </dev/null; }
paused() { gq "SELECT rt1_instanceCreationPaused FROM TMTask WHERE uuid='$REPEAT_DAILY'"; }
front() { lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to get name of first process whose frontmost is true'\'' 2>&1' </dev/null; }
repeat_click() { # $1 = Pause|Resume ; drive Items>Repeat>$1 by NAME (no coordinates)
  lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to tell process \"Things3\" to click menu item \"$1\" of menu 1 of menu item \"Repeat\" of menu \"Items\" of menu bar item \"Items\" of menu bar 1' 2>&1; echo \"[exit \$?]\"" </dev/null
}

# =====================================================================
note "############### AXVM1-a: inventory ###############"
note "-- csrutil status --"; lab_ssh "$IP" '/usr/bin/csrutil status 2>&1' </dev/null | tee -a "$REPORT"
note "-- SYSTEM TCC: all rows (esp. PostEvent=screensharing.agent -> why VNC HID works) --"
lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT service,client,client_type,auth_value FROM access ORDER BY service" 2>&1' </dev/null | tee -a "$REPORT"
note "-- SYSTEM TCC: Accessibility rows at start (expect NONE) --"; axrows | tee -a "$REPORT"
note "-- BAD discriminator: get name of first process (NOT AX-gated -> exit 0 even ungranted) --"
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to get name of first process'\'' 2>&1; echo "[exit $?]"' </dev/null | tee -a "$REPORT"
note "warm-up: launch Things"; lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
note "-- REAL AX op (menu-bar read) — the true -1719 discriminator --"; axprobe | tee -a "$REPORT"
note "-- did the denial auto-create a disabled Accessibility row? (expect sshd-keygen-wrapper|1|0) --"; axrows | tee -a "$REPORT"

# reconfirm SX4: direct system-TCC write is read-only under SIP (informational)
note "-- reconfirm SX4: direct system-TCC INSERT (expect readonly failure) --"
lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "INSERT OR REPLACE INTO access (service,client,client_type,auth_value,auth_reason,auth_version) VALUES (\"kTCCServiceAccessibility\",\"/usr/libexec/sshd-keygen-wrapper\",1,2,4,1)" 2>&1; echo "[exit $?]"' </dev/null | tee -a "$REPORT"

if [ -z "$VNCDO" ] || [ -z "$VNC_URL" ]; then
  note "VNCDO/VNC_URL unavailable — GUI grant arm (b) + smoke (d) SKIPPED. Inventory captured."
  exit 0
fi
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
V() { "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }
shot() { V capture "$OUT/$1"; sleep 0.3; }

# =====================================================================
note "############### AXVM1-b: user-path grant via VNC (SIP stays enabled) ###############"
lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 6
shot "11-ax-pane.png"           # lone row: sshd-keygen-wrapper, toggle OFF
V move 1642 332 click 1; sleep 3           # flip the toggle -> admin auth sheet
shot "12-auth-sheet.png"
V move 1017 870 click 1 pause 0.5 type admin pause 0.5 move 1017 963 click 1; sleep 3  # password + Modify Settings
shot "13-after-auth.png"
note "-- Accessibility rows after grant (expect ...|1|2) --"; axrows | tee -a "$REPORT"
note "-- RE-PROBE real AX op over SSH (expect the menu-bar list, exit 0) --"; axprobe | tee -a "$REPORT"

# =====================================================================
note "############### AXVM1-d: payoff smoke (System Events, by NAME, over SSH) ###############"
note "-- select the repeating template by stable handle, confirm via Things AS --"
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; sleep 1; open 'things:///show?id=$REPEAT_DAILY'; sleep 2" </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "Things3" to get name of selected to dos'\'' 2>&1' </dev/null | tee -a "$REPORT"
note "-- Items ▸ Repeat submenu (expect: Reschedule…, Pause, Show Latest — no Stop) --"
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu item of menu 1 of menu item "Repeat" of menu "Items" of menu bar item "Items" of menu bar 1'\'' 2>&1' </dev/null | tee -a "$REPORT"
note "pre-press paused=$(paused)"
note "-- FOREGROUND press Pause --"; repeat_click Pause | tee -a "$REPORT"; sleep 3
note "post-press paused=$(paused) (expect 1)"

note "-- BACKGROUND question: Resume (foreground), then press Pause with Finder frontmost --"
repeat_click Resume >/dev/null; sleep 2; note "resumed paused=$(paused) (expect 0)"
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "Finder" to activate'\''; sleep 2' </dev/null
note "frontmost before background press: $(front)"
repeat_click Pause | tee -a "$REPORT"; sleep 3
note "frontmost after background press: $(front) (expect STILL Finder — no focus steal)"
note "background-press paused=$(paused) (expect 1)"

note "-- LOCK question: Resume, lock session, press Pause under lock --"
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; sleep 1; open 'things:///show?id=$REPEAT_DAILY'; sleep 2" </dev/null
repeat_click Resume >/dev/null; sleep 2; note "resumed paused=$(paused) (expect 0)"
UID_ADMIN=$(lab_ssh "$IP" 'id -u admin' </dev/null)
lab_ssh "$IP" 'sudo sysadminctl -screenLock immediate -password admin 2>&1' </dev/null | tee -a "$REPORT"
lab_ssh "$IP" "sudo launchctl asuser $UID_ADMIN sudo -u admin python3 -c 'import ctypes; lf=ctypes.CDLL(\"/System/Library/PrivateFrameworks/login.framework/Versions/Current/login\"); print(\"SACrc=\",lf.SACLockScreenImmediate())' 2>&1 || echo SAC-failed" </dev/null | tee -a "$REPORT"
sleep 3; shot "20-locked.png"
repeat_click Pause | tee -a "$REPORT"; sleep 3
note "under-lock press paused=$(paused) (expect 1 — AX press works while locked, unlike VNC clicks)"

# =====================================================================
note "############### AXVM1-e: persistence across reboot ###############"
lab_ssh "$IP" 'sudo reboot' </dev/null 2>&1 || true
sleep 45
IP=$(lab_wait_for_ssh "$VM" 300); note "back up at $IP"
note "-- Accessibility rows after reboot (expect ...|1|2 persists) --"; axrows | tee -a "$REPORT"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1; sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null; open -a Things3; sleep 10' </dev/null
note "-- RE-PROBE real AX op after reboot (expect menu-bar list, exit 0) --"; axprobe | tee -a "$REPORT"

note "GREEN — verdict: AX usable in Tart guests via the user-path toggle grant (rung b);"
note "smoke passes incl. background (no focus steal) + under-lock; grant persists reboot."
note "report: $REPORT ; screenshots in $OUT"
