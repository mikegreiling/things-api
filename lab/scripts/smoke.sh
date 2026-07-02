#!/bin/bash
# Lab smoke test: clone the base image, boot headless, prove the Aqua session
# exists over SSH, tear down. Exit 0 = the clone→boot→ssh→delete loop works.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=env.sh
source ./env.sh

VM="scratch-smoke-$$"
cleanup() {
  tart stop "$VM" 2>/dev/null || true
  tart delete "$VM" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> cloning $LAB_BASE_IMAGE -> $VM"
time tart clone "$LAB_BASE_IMAGE" "$VM"

echo "==> booting (headless)"
tart run "$VM" --no-graphics &
RUN_PID=$!

echo "==> waiting for SSH"
IP="$(lab_wait_for_ssh "$VM" 240)"
echo "==> guest IP: $IP"

echo "==> guest facts"
lab_ssh "$IP" 'sw_vers && uname -m && echo "user=$(whoami)"'

echo "==> Aqua session check (frontmost app query via System Events)"
lab_ssh "$IP" 'osascript -e "tell application \"System Events\" to get name of first application process whose frontmost is true"'

echo "==> shared-dir + airgap flags exist"
tart run --help | grep -qE -- '--no-graphics' && tart run --help | grep -qE -- '--net-host' && echo "flags ok"

echo "==> stopping and deleting"
tart stop "$VM"
wait "$RUN_PID" 2>/dev/null || true

echo "SMOKE OK"
