#!/bin/bash
# LOCKSCR2 (#732 follow-ons) — the CERTIFICATION arm, DIRECT execution on a
# golden-v4 clone.
#
# Provisions ONE disposable clone and runs lab/guest/lockscr2-cells.sh in it,
# shipping TWO CLI bundles: the branch's (`dist`) and the merge-base's
# (`LOCKSCR2_BEFORE_DIST`), so cell (a) can count the hops the gate used to cost
# and the hops it costs now on the same guest, in the same sitting, against the
# same fixtures. The ROUTED arm runs the SAME cell file through
# lab/scripts/stage5-rc-run.sh against golden-v4h, with one bundle.
#
#   LOCKSCR2_BEFORE_DIST=/path/to/base/dist \
#     TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-lockscr2-cert.sh
#   KEEP=1 … (leave the clone up on failure)
#
# NOTE ON ORDER: the cells end with the screen locked and there is no way to type
# a password into a headless clone, so the locked cells are LAST and the clone is
# destroyed straight after.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-lockscr2cert}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
BEFORE_DIST="${LOCKSCR2_BEFORE_DIST:-}"
OUT="lab/artifacts/$VM"
mkdir -p "$OUT"
REPORT="$OUT/report.txt"
: >"$REPORT"
note() { echo "[lockscr2] $*" | tee -a "$REPORT"; }
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

REUSE="${REUSE:-0}"
if [ "$REUSE" = "1" ]; then
  note "REUSE=1 — using the running $VM as it stands"
else
  note "cloning $GOLDEN -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM" || { note "FATAL: clone failed"; exit 1; }
fi

cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — leaving $VM up"; return; fi
  note "teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
# Armed BEFORE the first wait: a boot wait that times out with no trap leaves a
# 50 GB clone running (PROVREM1 §7.2).
trap cleanup EXIT

# `tart run` on a just-cloned VM has been seen to die instantly with "The
# operation couldn't be completed. No such file or directory" — the clone is on
# disk and boots fine on the next attempt. So the launch is CHECKED a few seconds
# in and retried once, rather than being discovered ten minutes later by an SSH
# wait that was never going to be answered.
boot_vm() {
  local attempt
  for attempt in 1 2; do
    if [ "$REUSE" = "1" ] && [ -n "$(tart ip "$VM" 2>/dev/null)" ]; then
      IP=$(lab_wait_for_ssh "$VM" 600) && return 0
      return 1
    fi
    (tart run "$VM" --no-graphics >>"$OUT/tart-run.log" 2>&1 &)
    sleep 12
    if grep -q "^Error:" "$OUT/tart-run.log" 2>/dev/null; then
      note "boot attempt $attempt died at launch: $(tail -1 "$OUT/tart-run.log")"
      tart stop "$VM" >/dev/null 2>&1 || true
      : >"$OUT/tart-run.log"
      sleep 8
      continue
    fi
    IP=$(lab_wait_for_ssh "$VM" 600) && return 0
    note "boot attempt $attempt never answered SSH"
    tart stop "$VM" >/dev/null 2>&1 || true
    : >"$OUT/tart-run.log"
    sleep 8
  done
  return 1
}
: >"$OUT/tart-run.log"
boot_vm || { note "FATAL: no SSH"; exit 1; }
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
lab_scp lab/guest/lockscr2-cells.sh "admin@$IP:things-lab/lockscr2-cells.sh"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node ~/things-lab/lockscr2-cells.sh' </dev/null

BEFORE_ARG=""
if [ -n "$BEFORE_DIST" ] && [ -f "$BEFORE_DIST/cli/main.js" ]; then
  note "shipping the BEFORE bundle from $BEFORE_DIST"
  lab_ssh "$IP" 'rm -rf ~/things-lab/before && mkdir -p ~/things-lab/before/node_modules' </dev/null
  lab_scp -r "$BEFORE_DIST" "admin@$IP:things-lab/before/dist"
  lab_ssh "$IP" 'ln -sfn ~/things-lab/things-api/node_modules/commander ~/things-lab/before/node_modules/commander' </dev/null
  lab_scp package.json "admin@$IP:things-lab/before/package.json"
  BEFORE_ARG="LOCKSCR2_BEFORE=\$HOME/things-lab/before"
else
  note "no BEFORE bundle (set LOCKSCR2_BEFORE_DIST) — cell (a) runs the after half only"
fi

CLI="~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js"
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBUILD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
OSVER=$(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)
note "guest: Things $TVER ($TBUILD) on macOS $OSVER; ui-enabled=true"

note "running the cells (direct arm — lab escapes exported)…"
set +e
lab_ssh "$IP" "LOCKSCR2_ARM=direct $BEFORE_ARG $LAB_DIRECT bash ~/things-lab/lockscr2-cells.sh ~/things-lab/bin/node ~/things-lab/things-api" \
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
