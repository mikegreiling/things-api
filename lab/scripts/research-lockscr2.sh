#!/bin/bash
# LOCKSCR2 — the EXPLORATORY arm (see lab/guest/lockscr2-probe.sh for the three
# unknowns). One disposable golden-v4 clone, three phases, one reboot between
# the two saver phases: a screen-saver sitting leaves `CGSSessionScreenIsLocked`
# set for the rest of that login (LOCKSCR1 §1 law 2), so the second saver state
# is only meaningful on a fresh window server.
#
#   TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-lockscr2.sh
#   KEEP=1 … (leave the clone up on failure)
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-lockscr2probe}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"
mkdir -p "$OUT"
REPORT="$OUT/report.txt"
: >"$REPORT"
note() { echo "[lockscr2] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"

FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB"
[ "${FREEGB:-0}" -lt 10 ] && { note "FATAL: <10GiB free on /Volumes/Workspace."; exit 1; }

note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM" || { note "FATAL: clone failed"; exit 1; }

cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — leaving $VM up"; return; fi
  note "teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

boot() {
  (tart run "$VM" --no-graphics >>"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 600) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo FAIL || echo OK' </dev/null)
  note "airgap: $AG"
  [ "$AG" = "OK" ] || { note "FATAL: airgap"; exit 1; }
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
  note "clock: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) (trial wall 2026-07-18)"
  lab_ssh "$IP" 'mkdir -p ~/things-lab' </dev/null
  lab_scp lab/guest/lockscr2-probe.sh "admin@$IP:things-lab/lockscr2-probe.sh"
  lab_scp lab/guest/lockscr2-probe2.sh "admin@$IP:things-lab/lockscr2-probe2.sh"
  lab_scp lab/guest/lockscr2-probe3.sh "admin@$IP:things-lab/lockscr2-probe3.sh"
  lab_ssh "$IP" 'chmod +x ~/things-lab/lockscr2-probe*.sh' </dev/null
}

boot
note "guest: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) on macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)"

run_phase() {
  note "=== phase $1 ==="
  lab_ssh "$IP" "bash ~/things-lab/lockscr2-${ROUND:-probe}.sh $1" </dev/null 2>&1 | tee -a "$REPORT"
}

run_phase "${PHASE1:-base}"
run_phase "${PHASE2:-saver-nopw}"

[ "${SKIP_PHASE3:-0}" = "1" ] && { note "SKIP_PHASE3=1 — done"; exit 0; }

note "power-cycling the guest to clear the window server's locked flag"
tart stop "$VM" >/dev/null 2>&1 || true
sleep 10
boot

run_phase "${PHASE3:-saver-pw}"

note "done — transcript in $REPORT"
