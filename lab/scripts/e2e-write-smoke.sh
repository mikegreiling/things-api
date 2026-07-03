#!/bin/bash
# Host orchestrator for the write-layer e2e smoke: clone golden -> boot ->
# airgap -> pin clock -> ship node + built dist into the guest -> run
# lab/guest/e2e-write-smoke.sh against the REAL app -> collect -> teardown.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-e2e-$(date +%Y%m%d-%H%M%S)"
ARTIFACTS="lab/artifacts/$VM"
mkdir -p "$ARTIFACTS"

echo "[e2e] building dist…"
npm run build >/dev/null

NODE_BIN=$(node -e 'console.log(process.execPath)')
echo "[e2e] node binary: $NODE_BIN"

cleanup() {
  echo "[e2e] teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[e2e] cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics >"$ARTIFACTS/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300)
echo "[e2e] ssh up at $IP"

echo "[e2e] airgap + clock pin"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true'
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && exit 1 || exit 0'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null'

echo "[e2e] shipping node + dist + commander"
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules'
lab_scp "$NODE_BIN" "admin@$IP:things-lab/bin/node"
lab_scp -r dist "admin@$IP:things-lab/things-api/dist"
lab_scp -r node_modules/commander "admin@$IP:things-lab/things-api/node_modules/commander"
lab_scp package.json "admin@$IP:things-lab/things-api/package.json"
lab_scp lab/guest/e2e-write-smoke.sh "admin@$IP:things-lab/e2e-write-smoke.sh"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node ~/things-lab/e2e-write-smoke.sh'

echo "[e2e] running guest smoke…"
set +e
lab_ssh "$IP" 'bash ~/things-lab/e2e-write-smoke.sh ~/things-lab/bin/node ~/things-lab/things-api' \
  | tee "$ARTIFACTS/e2e-transcript.log"
RESULT=${PIPESTATUS[0]}
set -e

echo "[e2e] collecting audit trail"
lab_scp -r "admin@$IP:.local/state/things-api/audit" "$ARTIFACTS/audit" || true

if [ "$RESULT" -eq 0 ]; then
  echo "[e2e] GREEN — artifacts in $ARTIFACTS"
else
  echo "[e2e] RED (exit $RESULT) — artifacts in $ARTIFACTS"
fi
exit "$RESULT"
