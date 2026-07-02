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

# NOTE: AppleEvents (osascript → System Events/Things) require TCC Automation
# consent, which is granted manually during golden-image seeding (lab.md §3).
# The vanilla image has no grants, so the Aqua check must not use AppleEvents.
echo "==> Aqua session check (console owner + GUI launchd domain + WindowServer)"
lab_ssh "$IP" '
  set -e
  owner="$(stat -f%Su /dev/console)"
  echo "console owner: $owner"
  [ "$owner" = "admin" ]
  launchctl print "gui/$(id -u)" >/dev/null && echo "gui launchd domain: present"
  pgrep -xq WindowServer && pgrep -xq Dock && echo "WindowServer+Dock: running"
'

echo "==> shared-dir + airgap flags exist"
tart run --help | grep -qE -- '--no-graphics' && tart run --help | grep -qE -- '--net-host' && echo "flags ok"

echo "==> stopping and deleting"
tart stop "$VM"
wait "$RUN_PID" 2>/dev/null || true

echo "SMOKE OK"
