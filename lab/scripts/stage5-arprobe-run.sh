#!/bin/bash
# Stage 5 (release-gate b/c) — the FIELD-SHAPED RC run, inside a routed guest.
# Clone golden-v4h -> boot -> airgap -> pin clock -> ship the RC's dist + the
# host-built helper bundle -> install + route through the deputy -> run the
# batch's changed operations with the NORMAL CLI syntax -> collect -> destroy.
#
#   RC_DIST=/path/to/package/dist bash lab/scripts/stage5-rc-run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
source lab/scripts/helpers-guest.sh

RC_DIST="${RC_DIST:?set RC_DIST to the unpacked RC dist directory}"
[ -f "$RC_DIST/cli/main.js" ] || { echo "no $RC_DIST/cli/main.js" >&2; exit 2; }

GOLDEN_V4H="things-lab-golden-v4h"
VM="things-rc-stage5-$(date +%Y%m%d-%H%M%S)"
ARTIFACTS="lab/artifacts/$VM"
mkdir -p "$ARTIFACTS"

NODE_BIN=$(node -e 'console.log(process.execPath)')
echo "[stage5] node: $NODE_BIN"
echo "[stage5] RC dist: $RC_DIST"

cleanup() {
  echo "[stage5] teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}

echo "[stage5] cloning $GOLDEN_V4H -> $VM"
tart clone "$GOLDEN_V4H" "$VM"
trap cleanup EXIT
(tart run "$VM" --no-graphics >"$ARTIFACTS/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 600)
echo "[stage5] ssh up at $IP"

echo "[stage5] airgap + clock pin (2026-07-05 12:00; trial wall 2026-07-18)"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true'
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && exit 1 || exit 0'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null'

echo "[stage5] shipping node + the RC dist + commander"
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules'
lab_scp "$NODE_BIN" "admin@$IP:things-lab/bin/node"
lab_scp -r "$RC_DIST" "admin@$IP:things-lab/things-api/dist"
# commander by RESOLVED path: an agent worktree under .claude/worktrees/ has no
# node_modules of its own and resolves the primary checkout's by walking up, so
# the relative path is simply absent (PTRGD1).
COMMANDER_DIR=$(node -e "
  const { dirname, join } = require('node:path'); const { existsSync } = require('node:fs');
  let d = process.cwd();
  for (;;) { const c = join(d, 'node_modules', 'commander');
    if (existsSync(join(c, 'package.json'))) { console.log(c); break }
    const up = dirname(d); if (up === d) break; d = up }
")
[ -d "$COMMANDER_DIR" ] || { echo "commander not resolvable" >&2; exit 2; }
lab_scp -r "$COMMANDER_DIR" "admin@$IP:things-lab/things-api/node_modules/commander"
lab_scp package.json "admin@$IP:things-lab/things-api/package.json"
lab_scp lab/guest/beep-sentinel.sh "admin@$IP:things-lab/beep-sentinel.sh"
lab_scp lab/guest/stage5-arprobe.sh "admin@$IP:things-lab/stage5-arprobe.sh"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node ~/things-lab/beep-sentinel.sh ~/things-lab/stage5-arprobe.sh'

CLI="~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js"
echo "[stage5] provisioning the helper pair (1.4.0) in the guest"
guest_helpers_provision "$IP" "$CLI"

echo "[stage5] running the Stage 5 cells…"
set +e
lab_ssh "$IP" "THINGS_LAB_BEEPS_OK='${THINGS_LAB_BEEPS_OK:-1}' bash ~/things-lab/stage5-arprobe.sh ~/things-lab/bin/node ~/things-lab/things-api" \
  | tee "$ARTIFACTS/stage5-transcript.log"
RESULT=${PIPESTATUS[0]}
set -e

echo "[stage5] collecting"
lab_scp "admin@$IP:.local/state/things-api/deputy/deputy.log" "$ARTIFACTS/deputy.log" 2>/dev/null || true
lab_scp -r "admin@$IP:things-lab/out" "$ARTIFACTS/out" 2>/dev/null || true

if [ "$RESULT" -eq 0 ]; then
  echo "[stage5] GREEN — artifacts in $ARTIFACTS"
else
  echo "[stage5] RED (exit $RESULT) — artifacts in $ARTIFACTS"
fi
exit "$RESULT"
