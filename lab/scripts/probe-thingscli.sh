#!/bin/bash
# Dynamic probe of Things3.app/Contents/MacOS/thingscli in a disposable VM.
# Early "wheel-reinvention gate": enumerate the hidden CLI's real command
# surface (static analysis can't see Swift's inlined short strings).
#
# Flow: clone base image -> boot -> push vendored Things trial -> install ->
# first-launch Things (creates the data container) -> quit -> run a command
# wordlist against thingscli -> capture per-command stdout/stderr/exit ->
# pull raw evidence back to lab/artifacts/thingscli/ -> destroy VM.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=env.sh
source ./env.sh

REPO_ROOT="$(cd ../.. && pwd)"
ZIP="$REPO_ROOT/vendor/Things3.zip"
ARTIFACTS="$REPO_ROOT/lab/artifacts/thingscli"
[ -f "$ZIP" ] || { echo "missing $ZIP (see vendor/manifest.json)" >&2; exit 1; }
mkdir -p "$ARTIFACTS"

VM="scratch-thingscli-$$"
cleanup() {
  tart stop "$VM" 2>/dev/null || true
  tart delete "$VM" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> cloning $LAB_BASE_IMAGE -> $VM"
tart clone "$LAB_BASE_IMAGE" "$VM"
tart run "$VM" --no-graphics &
RUN_PID=$!
IP="$(lab_wait_for_ssh "$VM" 240)"
echo "==> guest IP: $IP"

echo "==> pushing Things trial"
lab_scp "$ZIP" "$LAB_SSH_USER@$IP:/tmp/Things3.zip"

echo "==> installing + first launch (creates group container/database)"
lab_ssh "$IP" '
  set -e
  ditto -xk /tmp/Things3.zip /tmp/things-extract
  sudo mv /tmp/things-extract/Things3.app /Applications/Things3.app
  open -a /Applications/Things3.app
  sleep 20
  osascript -e "tell application \"Things3\" to quit" || pkill -x Things3 || true
  sleep 3
  ls "$HOME/Library/Group Containers/" | grep -i culturedcode || echo "NO CONTAINER YET"
'

echo "==> probing thingscli command surface"
lab_ssh "$IP" 'bash -s' <<'GUEST' | tee "$ARTIFACTS/probe-raw.txt"
CLI=/Applications/Things3.app/Contents/MacOS/thingscli
echo "### bare invocation"
"$CLI" 2>&1; echo "exit=$?"
WORDS="help --help -h version --version defaults settings read write list
show export import backup restore repair rebuild reindex migrate library
database db sync token url urls scheme diagnostics doctor debug log logs
reset check verify info status config get set delete open quicksilver json"
for w in $WORDS; do
  echo "### thingscli $w"
  timeout 10 "$CLI" "$w" 2>&1; echo "exit=$?"
done
echo "### thingscli defaults subcommands"
for s in read write list delete help dump keys domains; do
  echo "### thingscli defaults $s"
  timeout 10 "$CLI" defaults "$s" 2>&1; echo "exit=$?"
done
echo "### thingscli defaults read (known keys from static analysis)"
for k in calendarEventsEnabled remindersInboxEnabled uriSchemeAuthenticationToken; do
  echo "### thingscli defaults read $k"
  timeout 10 "$CLI" defaults read "$k" 2>&1; echo "exit=$?"
done
GUEST

echo "==> done; evidence at $ARTIFACTS/probe-raw.txt"
tart stop "$VM"
wait "$RUN_PID" 2>/dev/null || true
echo "PROBE OK"
