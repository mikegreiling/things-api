#!/bin/bash
# RAWAX1 — the DIRECT arm of the phase 2 certification.
#
# The same cells as the routed arm (lab/guest/rawax1-cells.sh), on a golden-v4
# clone with no helpers, so every script runs under the guest's own terminal
# identity. That difference is the whole point of running it twice: the
# routing-arm law makes WHICH IDENTITY EXECUTES A SCRIPT a certification
# dimension, and the raw-AX transport changes what every script IS.
#
# The routed arm has an orchestrator already (lab/scripts/stage5-rc-run.sh, which
# also installs and grants the helper pair); this is its unrouted twin, and it is
# deliberately the same provisioning law minus that step: same golden family,
# same airgap, same clock pin, same synthetic fixtures, same cells.
#
#   bash lab/scripts/rawax1-direct-arm.sh
#   RC_DIST=/path/to/dist bash lab/scripts/rawax1-direct-arm.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

RC_DIST="${RC_DIST:-dist}"
[ -f "$RC_DIST/cli/main.js" ] || { echo "no $RC_DIST/cli/main.js" >&2; exit 2; }
GUEST_CELLS="${GUEST_CELLS:-lab/guest/rawax1-cells.sh}"
[ -f "$GUEST_CELLS" ] || { echo "no cell script at $GUEST_CELLS" >&2; exit 2; }
CELLS_BASE=$(basename "$GUEST_CELLS")

GOLDEN="${GOLDEN:-things-lab-golden-v4}"
VM="rawax1-direct-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"
mkdir -p "$OUT"
TRIAL_WALL="2026-07-18"

NODE_BIN=$(node -e 'console.log(process.execPath)')
COMMANDER_DIR=$(lab_commander_dir)
[ -d "$COMMANDER_DIR" ] || { echo "[direct] commander not resolvable from $PWD" >&2; exit 2; }

note() { echo "[direct] $*"; }
note "golden:    $GOLDEN"
note "dist:      $RC_DIST"
note "cells:     $GUEST_CELLS"

# ONE VM AT A TIME, checked IMMEDIATELY before the clone rather than earlier —
# the rule is to hold the slot from clone to destroy, and a check that is minutes
# old is a check of a slot somebody else has since taken.
RUNNING=$(tart list | awk 'NR>1 && $NF=="running" {print $2}' | tr '\n' ' ')
[ -n "$RUNNING" ] && { note "FATAL: another VM is running ($RUNNING)"; exit 1; }

# A stale detached `tart run` of our OWN name holds the name while `tart list`
# reports the clone stopped, and the next clone then never opens sshd.
pkill -f "tart run $VM --no-graphics" >/dev/null 2>&1 || true
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)

# THE TRAP IS ARMED BEFORE THE SSH WAIT: the no-SSH path is the one that most
# needs a teardown, and arming afterwards is what leaves an orphan holding 50 GB.
cleanup() {
  note "teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  pkill -f "tart run $VM --no-graphics" >/dev/null 2>&1 || true
  note "remaining: $(tart list | tail -n +2 | awk '{print $2}' | tr '\n' ' ')"
}
trap cleanup EXIT

IP=$(lab_wait_for_ssh "$VM" 600) || { note "FATAL: no SSH"; exit 1; }
note "ssh up at $IP"

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
note "airgap: $AG"; [ "$AG" = "AIRGAP-OK" ] || exit 1
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock pinned 2026-07-05 (trial wall $TRIAL_WALL)"

note "shipping node + dist + commander"
scpO() { local a c; for a in 1 2 3 4 5; do sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; c=$?; [ "$c" -eq 0 ] && return 0; sleep 3; done; return "$c"; }
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules ~/things-lab/out' </dev/null
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null || { note "FATAL node scp"; exit 1; }
scpO -r "$COMMANDER_DIR" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null || { note "FATAL commander scp"; exit 1; }
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r "$RC_DIST" "admin@$IP:/Users/admin/things-lab/things-api/dist" >/dev/null || { note "FATAL dist scp"; exit 1; }
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
scpO "$GUEST_CELLS" "admin@$IP:/Users/admin/things-lab/$CELLS_BASE" >/dev/null
lab_ssh "$IP" "chmod +x ~/things-lab/$CELLS_BASE" </dev/null

# Warm Things the way every driver here does: dismiss anything standing, restart
# clean, drop AXEnhancedUserInterface, foreground it.
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; pkill -x Things3 >/dev/null 2>&1; sleep 2; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null
note "Things warm: $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)"

# THE LAB ESCAPES. A golden clone has no helper bundle and no bundle id for macOS
# to have recorded an Automation grant against, so the shipped capability checks
# refuse every AppleScript-vector leg without these. They are what makes this the
# DIRECT arm rather than a broken one.
# THE DIRECT ARM IS IN-SESSION BY CONSTRUCTION (RAWAX1 §5c.8, ruled 2026-09-06).
#
# An `ssh` login is not the console session. That never mattered while every UI
# read went through System Events — an agent that already lives in the user's
# Aqua session, which executes the request there however the caller got in — and
# it matters absolutely for a client that reads the Accessibility tree from its
# OWN process, because that process is then outside the session and the app's
# controls are not readable from it.
#
# A terminal on the maintainer's Mac IS in the console session, so an ssh-shaped
# direct arm was measuring a configuration no user is in. `launchctl asuser`
# moves the whole cell run into the console session's bootstrap namespace, which
# is what makes this arm represent a terminal on a real host — which is what it
# is for.
GUEST_UID=$(lab_ssh "$IP" 'id -u' </dev/null | tr -d '\r\n ')
IN_SESSION="sudo launchctl asuser $GUEST_UID sudo -u admin"
note "in-session shim: $IN_SESSION (console uid $GUEST_UID)"

note "running the cells (DIRECT: no helpers, lab escapes on, IN-SESSION)"
set +e
lab_ssh "$IP" "cd ~/things-lab && $IN_SESSION env THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1 HOME=/Users/admin bash ~/things-lab/$CELLS_BASE ~/things-lab/bin/node ~/things-lab/things-api" </dev/null 2>&1 | tee "$OUT/cells.log"
CODE=${PIPESTATUS[0]}
set -e
note "cells exit: $CODE"
lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3*.ips 2>/dev/null | wc -l | tr -d " "' </dev/null | \
  { read -r n; note "Things crash reports: ${n:-0}"; }
exit "$CODE"
