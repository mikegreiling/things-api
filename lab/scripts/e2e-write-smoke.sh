#!/bin/bash
# Host orchestrator for the write-layer e2e smoke: clone golden -> boot ->
# airgap -> pin clock -> ship node + built dist into the guest -> run
# lab/guest/e2e-write-smoke.sh against the REAL app -> collect -> teardown.
#
#   bash lab/scripts/e2e-write-smoke.sh [--arm direct|routed]
#
# THE TWO ARMS (HELPGST1). Identity is a certification dimension, so the smoke
# is run twice and each result is reported by name:
#
#   direct  the historic arm. A bare golden-v4 clone has no helper bundle, so
#           the guest exports the two lab escapes and executes every script
#           under its own sshd-descended identity.
#   routed  the FIELD shape. A golden-v4h clone carries the helper pair with
#           its grants already baked; the host-built bundle is shipped over the
#           installed one, `helpers-enabled` is set to true, and every
#           AppleScript/GUI hop is brokered by the deputy. No escapes.
#
# The routed arm is what the release gate certifies: two releases shipped
# green-in-lab and broken-in-field on precisely the difference between these
# two identities (0.19.2, 0.20.7).
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
source lab/scripts/helpers-guest.sh

ARM="${THINGS_LAB_ARM:-direct}"
# --dist ships an ALREADY-BUILT dist instead of building this checkout's. It is
# how a past release is put back under the routed arm: this arm's own acceptance
# test is the v0.20.7 dist going red on the broker refusal it shipped with.
DIST="${THINGS_LAB_DIST:-}"
GUI_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --arm)
      ARM="${2:-}"
      shift 2
      ;;
    --dist)
      DIST="${2:-}"
      shift 2
      ;;
    --gui-only)
      GUI_ONLY=1
      shift
      ;;
    *)
      echo "usage: $0 [--arm direct|routed] [--dist <dir>] [--gui-only]" >&2
      exit 2
      ;;
  esac
done
if [ "$GUI_ONLY" = "1" ] && [ "$ARM" != "routed" ]; then
  echo "--gui-only is a routed-arm leg (a direct clone has no deputy to broker anything)" >&2
  exit 2
fi
case "$ARM" in
  direct) ARM_GOLDEN="${GOLDEN:-things-lab-golden-v4}" ;;
  routed) ARM_GOLDEN="${GOLDEN:-things-lab-golden-v4h}" ;;
  *)
    echo "unknown arm '$ARM' — expected direct or routed" >&2
    exit 2
    ;;
esac

VM="things-run-e2e-$ARM-$(date +%Y%m%d-%H%M%S)"
ARTIFACTS="lab/artifacts/$VM"
mkdir -p "$ARTIFACTS"

if [ -z "$DIST" ]; then
  echo "[e2e] building dist…"
  npm run build >/dev/null
  DIST=dist
else
  echo "[e2e] shipping the supplied dist: $DIST"
  [ -f "$DIST/cli/main.js" ] || {
    echo "[e2e] $DIST/cli/main.js not found" >&2
    exit 2
  }
fi

NODE_BIN=$(node -e 'console.log(process.execPath)')
echo "[e2e] node binary: $NODE_BIN"

cleanup() {
  echo "[e2e] teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[e2e] arm: $ARM (golden $ARM_GOLDEN)"
echo "[e2e] cloning golden -> $VM"
tart clone "$ARM_GOLDEN" "$VM"
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
lab_scp -r "$DIST" "admin@$IP:things-lab/things-api/dist"
lab_scp -r node_modules/commander "admin@$IP:things-lab/things-api/node_modules/commander"
lab_scp package.json "admin@$IP:things-lab/things-api/package.json"
lab_scp lab/guest/e2e-write-smoke.sh "admin@$IP:things-lab/e2e-write-smoke.sh"
# The beep sentinel ships beside the smoke (the smoke resolves it by $0's dir):
# an alert beep during the write layer is a failure, not a curiosity.
lab_scp lab/guest/beep-sentinel.sh "admin@$IP:things-lab/beep-sentinel.sh"
lab_scp lab/guest/routed-gui-smoke.sh "admin@$IP:things-lab/routed-gui-smoke.sh"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node ~/things-lab/e2e-write-smoke.sh ~/things-lab/beep-sentinel.sh ~/things-lab/routed-gui-smoke.sh'

CLI="~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js"
if [ "$ARM" = "routed" ]; then
  echo "[e2e] provisioning the helper pair in the guest"
  guest_helpers_provision "$IP" "$CLI"
fi

RESULT=0
if [ "$GUI_ONLY" = "0" ]; then
  echo "[e2e] running guest smoke…"
  set +e
  # THINGS_LAB_BEEPS_OK=1 (if exported on the host) downgrades the beep gate to
  # accounting-only; the smoke still prints the count.
  lab_ssh "$IP" "THINGS_LAB_BEEPS_OK='${THINGS_LAB_BEEPS_OK:-}' THINGS_LAB_ARM='$ARM' bash ~/things-lab/e2e-write-smoke.sh ~/things-lab/bin/node ~/things-lab/things-api" \
    | tee "$ARTIFACTS/e2e-transcript.log"
  RESULT=${PIPESTATUS[0]}
  set -e
fi

# The GUI leg runs LAST and only on the routed arm: it switches `ui-enabled` on,
# which the write-layer smoke's two heading gates assert is OFF. Ordering it
# after keeps both arms of that smoke byte-comparable.
if [ "$ARM" = "routed" ]; then
  echo "[e2e] running routed GUI smoke…"
  set +e
  lab_ssh "$IP" "THINGS_LAB_BEEPS_OK='${THINGS_LAB_BEEPS_OK:-}' bash ~/things-lab/routed-gui-smoke.sh ~/things-lab/bin/node ~/things-lab/things-api" \
    | tee "$ARTIFACTS/routed-gui-transcript.log"
  GUI_RESULT=${PIPESTATUS[0]}
  set -e
  [ "$RESULT" -eq 0 ] && RESULT="$GUI_RESULT"
  echo "[e2e] routed GUI smoke exit: $GUI_RESULT"
fi

echo "[e2e] collecting audit trail"
lab_scp -r "admin@$IP:.local/state/things-api/audit" "$ARTIFACTS/audit" || true
lab_scp "admin@$IP:things-lab/beeps.json" "$ARTIFACTS/beeps.json" 2>/dev/null || true
if [ "$ARM" = "routed" ]; then
  # The deputy's own log is the routed arm's second witness: it records the
  # broker's refusals (script-denied, rejected-token) that a client-side
  # transcript can only report second-hand.
  lab_scp "admin@$IP:.local/state/things-api/deputy/deputy.log" "$ARTIFACTS/deputy.log" 2>/dev/null || true
fi

if [ "$RESULT" -eq 0 ]; then
  echo "[e2e] $ARM arm GREEN — artifacts in $ARTIFACTS"
else
  echo "[e2e] $ARM arm RED (exit $RESULT) — artifacts in $ARTIFACTS"
fi
exit "$RESULT"
