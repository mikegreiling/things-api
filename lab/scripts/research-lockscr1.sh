#!/bin/bash
# LOCKSCR1 (#732) — the locked-session arm, DIRECT execution on a golden-v4 clone.
#
# The field defect: a GUI `area reorder` on a LOCKED Mac refused with
# "Things is running but has no open window — only the placeholder it keeps in
# the background. Open the Things window (click its Dock icon) and re-run." The
# session was locked; the sentence described a window.
#
# This driver provisions ONE disposable clone and runs lab/guest/lockscr1-cells.sh
# in it: the session-dictionary key census in three screen states (unlocked,
# screen saver, locked), the unlocked baseline, the closed-window control, and
# the locked refusal itself. The ROUTED arm runs the SAME cell file through
# lab/scripts/stage5-rc-run.sh against golden-v4h.
#
#   TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-lockscr1.sh
#   KEEP=1 … (leave the clone up on failure)
#
# NOTE ON ORDER: the cells lock the guest's screen and never unlock it — there is
# no way to type a password into a headless clone — so the locked cell is LAST
# and the clone is destroyed straight after.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-lockscr1}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"
mkdir -p "$OUT"
REPORT="$OUT/report.txt"
: >"$REPORT"
note() { echo "[lockscr1] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"

FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB"
[ "${FREEGB:-0}" -lt 10 ] && { note "FATAL: <10GiB free on /Volumes/Workspace."; exit 1; }

node --version >/dev/null 2>&1 || { note "FATAL: no node on PATH"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
COMMANDER_DIR=$(lab_commander_dir)
[ -d "$COMMANDER_DIR" ] || { note "FATAL: commander not resolvable from $PWD"; exit 1; }
note "toolchain: node $(node --version); commander $COMMANDER_DIR"

note "building the branch bundle"
npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed (see $OUT/build.log)"; exit 1; }

note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM" || { note "FATAL: clone failed"; exit 1; }

cleanup() {
  if [ "$KEEP" = "1" ]; then
    note "KEEP=1 — leaving $VM up"
    return
  fi
  note "teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
# Armed BEFORE the first wait: a boot wait that times out with no trap leaves a
# 50 GB clone running (PROVREM1 §7.2).
trap cleanup EXIT

(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 600) || { note "FATAL: no SSH"; exit 1; }
note "ssh up at $IP"

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo FAIL || echo OK' </dev/null)
note "airgap: $AG"
[ "$AG" = "OK" ] || { note "FATAL: airgap"; exit 1; }
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) (trial wall 2026-07-18)"

note "shipping node + dist + commander + the cell script"
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
lab_scp "$NODE_BIN" "admin@$IP:things-lab/bin/node"
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
lab_scp -r dist "admin@$IP:things-lab/things-api/dist"
lab_scp -r "$COMMANDER_DIR" "admin@$IP:things-lab/things-api/node_modules/commander"
lab_scp package.json "admin@$IP:things-lab/things-api/package.json"
lab_scp lab/guest/lockscr1-cells.sh "admin@$IP:things-lab/lockscr1-cells.sh"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node ~/things-lab/lockscr1-cells.sh' </dev/null

CLI="~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js"
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBUILD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
OSVER=$(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)
note "guest: Things $TVER ($TBUILD) on macOS $OSVER; ui-enabled=true"

note "running the cells (direct arm — lab escapes exported)…"
set +e
lab_ssh "$IP" "LOCKSCR1_ARM=direct $LAB_DIRECT bash ~/things-lab/lockscr1-cells.sh ~/things-lab/bin/node ~/things-lab/things-api" \
  </dev/null 2>&1 | tee -a "$REPORT"
RESULT=${PIPESTATUS[0]}
set -e

lab_scp -r "admin@$IP:things-lab/out" "$OUT/out" 2>/dev/null || true

if [ "$RESULT" -eq 0 ]; then
  note "GREEN — artifacts in $OUT"
else
  note "RED ($RESULT cell failure(s)) — artifacts in $OUT"
fi
exit "$RESULT"
