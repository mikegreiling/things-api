#!/bin/bash
# Stage 9 — the CONSUMER DRILL, IN THE GUEST (release-checklist.md).
#
#   TGZ=/path/to/things-api-<version>.tgz DEPS=/path/to/deps \
#     bash lab/scripts/consumer-drill.sh
#
# The host may DOWNLOAD the published tarball and read it; it may not install or
# run it against anything of the maintainer's. So the artifact a consumer
# actually gets is verified inside a disposable clone: the CLI answers, and the
# helper bundle inside the PUBLISHED package is signed, stapled, and accepted by
# Gatekeeper with no network at all — which is the whole point of notarizing.
#
# DEPS is a directory of the package's runtime dependencies (commander, zod,
# @modelcontextprotocol), copied in beside the extracted tarball. A real
# consumer gets them from `npm install -g`; an airgapped guest has no registry
# and no npm, so they cross the airgap the way node does. The PACKAGE under test
# is still the published artifact, byte for byte.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

TGZ="${TGZ:?set TGZ to the published tarball}"
GOLD="${GOLDEN_NAME:-things-lab-golden-v4}"
VM="things-consumer-$(date +%H%M%S)"
ART="lab/artifacts/$VM"; mkdir -p "$ART"
NODE_BIN=$(node -e 'console.log(process.execPath)')

cleanup() { echo "[drill] teardown $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
echo "[drill] golden=$GOLD tarball=$TGZ"
tart clone "$GOLD" "$VM"
trap cleanup EXIT
(tart run "$VM" --no-graphics >"$ART/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 600)
echo "[drill] ssh $IP"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true'
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "STILL ONLINE" || echo "airgapped: no route to the internet"'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null'
lab_ssh "$IP" 'mkdir -p ~/consumer/bin'
lab_scp "$NODE_BIN" "admin@$IP:consumer/bin/node"
lab_scp "$TGZ" "admin@$IP:consumer/published.tgz"
lab_scp -r "$DEPS" "admin@$IP:consumer/deps"
lab_ssh "$IP" 'chmod +x ~/consumer/bin/node'
lab_scp "${CELLS:-lab/guest/consumer-cells.sh}" "admin@$IP:consumer/cells.sh"
lab_ssh "$IP" 'chmod +x ~/consumer/cells.sh'
set +e
lab_ssh "$IP" 'bash ~/consumer/cells.sh' | tee "$ART/consumer-transcript.log"
RESULT=${PIPESTATUS[0]}
set -e
echo "[drill] exit=$RESULT — artifacts in $ART"
exit "$RESULT"
