#!/bin/bash
# SIMFID clone drive — the VM leg of the simulator-fidelity replay suite.
#
# Clones the golden, boots headless, airgaps, pins the clock, ships the guest
# things-api CLI bundle + the guest driver + the headless manifest, drives each
# case's op through the REAL app, collects per-case before/after DB snapshots,
# then on the host: ingests them into normalized app deltas and runs the SIMFID
# comparator against them (a case's FRESH app delta overrides its banked-evidence
# golden — see docs/lab/simfid-results.md). Everything judgmental (diff,
# normalize, compare, verdict) happens host-side and is unit-tested
# (test/unit/simfid-normalize.test.ts).
#
# Usage: bash lab/scripts/simfid.sh [--keep-vm]
#
# VM ETIQUETTE (macOS 2-VM limit; a sibling campaign may hold one slot):
#   - Boots exactly ONE clone (things-run-simfid-<stamp>); NEVER the golden.
#   - Never blind-kills VMs: on "number of VMs exceeds the system limit" it
#     reports live `tart run` processes and ABORTS (inspect + retry), rather
#     than reaping a slot the sibling legitimately holds.
#   - Aborts up front unless there is disk + memory headroom.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

KEEP_VM=0
[ "${1:-}" = "--keep-vm" ] && KEEP_VM=1

STAMP=$(date +%Y%m%d-%H%M%S)
VM="things-run-simfid-$STAMP"
ARTIFACTS="lab/artifacts/simfid-clone-$STAMP"
APP_DELTAS="$ARTIFACTS/app-deltas"
mkdir -p "$ARTIFACTS"

# ---- preflight: headroom + no stray simfid VM (leave the sibling's alone) ----
FREE_GB=$(df -g "$TART_HOME" | tail -1 | awk '{print $4}')
if [ "${FREE_GB:-0}" -lt 12 ]; then
  echo "[simfid] ABORT: only ${FREE_GB}GB free on $TART_HOME (need >= 12); a clone would exhaust the volume." >&2
  exit 3
fi
RUNNING=$(pgrep -fl 'tart run' | grep -c 'tart run' || true)
if [ "${RUNNING:-0}" -ge 2 ]; then
  echo "[simfid] ABORT: $RUNNING VMs already running (2-VM limit). Live tart processes:" >&2
  pgrep -fl 'tart run' >&2
  echo "[simfid] The sibling campaign may hold a slot — waiting/retry is correct, not killing. Aborting." >&2
  exit 3
fi

cleanup() {
  if [ "$KEEP_VM" -eq 1 ]; then
    echo "[simfid] --keep-vm: leaving $VM running"
  else
    echo "[simfid] teardown: $VM"
    tart stop "$VM" >/dev/null 2>&1 || true
    tart delete "$VM" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "[simfid] building dist…"
npm run build >/dev/null

# The guest needs a SELF-CONTAINED node. A homebrew node dynamically links ~20
# dylibs under /opt/homebrew/opt/* (icu4c, openssl, libuv, ada-url, …) that do
# NOT exist on the vanilla guest, so it aborts with SIGABRT (exit -6) the instant
# it is invoked — every seed/op fails and the drive captures nothing. (The old
# "a homebrew node is self-contained enough" assumption was never exercised until
# the first real clone drive, 2026-07-22, which is exactly where it broke.)
# Prefer the on-PATH node IF it happens to be self-contained (only /usr/lib +
# /System deps); otherwise fetch a pinned OFFICIAL build, whose binaries link
# only against system libraries. This runs on the HOST (network up) before the
# guest is airgapped, so it never touches the airgap.
GUEST_NODE_VERSION="v24.18.0"  # LTS Krypton; satisfies package.json engines >=24
node_self_contained() {
  # self-contained ⇔ every linked lib resolves under /usr/lib or /System
  # (no /opt/* homebrew libs, no @rpath/@loader_path/@executable_path indirection)
  ! otool -L "$1" 2>/dev/null | tail -n +2 | grep -Eq '/opt/|@rpath|@loader_path|@executable_path'
}
NODE_BIN=$(node -e 'console.log(process.execPath)')
if node_self_contained "$NODE_BIN"; then
  echo "[simfid] guest node: on-PATH node is self-contained ($NODE_BIN)"
else
  ARCH="darwin-$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')"
  PKG="node-$GUEST_NODE_VERSION-$ARCH"
  NODE_BIN="$PWD/lab/cache/$PKG/bin/node"
  if [ ! -x "$NODE_BIN" ]; then
    echo "[simfid] guest node: on-PATH node links non-system dylibs; fetching self-contained $PKG"
    mkdir -p lab/cache
    curl -sSL -o "lab/cache/$PKG.tar.gz" "https://nodejs.org/dist/$GUEST_NODE_VERSION/$PKG.tar.gz" \
      || { echo "[simfid] ABORT: could not download $PKG" >&2; exit 1; }
    tar xzf "lab/cache/$PKG.tar.gz" -C lab/cache
  fi
  node_self_contained "$NODE_BIN" \
    || { echo "[simfid] ABORT: fetched guest node is not self-contained" >&2; exit 1; }
  echo "[simfid] guest node: $NODE_BIN ($GUEST_NODE_VERSION, self-contained)"
fi

echo "[simfid] cloning golden -> $VM"
if ! tart clone things-lab-golden-v1 "$VM" 2>"$ARTIFACTS/clone.err"; then
  if grep -qi "exceeds the system limit" "$ARTIFACTS/clone.err"; then
    echo "[simfid] ABORT: VM limit hit on clone. Live tart processes (do NOT blind-kill):" >&2
    pgrep -fl 'com.apple.Virtualization.VirtualMachine' >&2 || true
    exit 3
  fi
  cat "$ARTIFACTS/clone.err" >&2
  exit 1
fi

(tart run "$VM" --no-graphics >"$ARTIFACTS/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300) || { echo "[simfid] boot failed"; cat "$ARTIFACTS/tart-run.log"; exit 1; }
echo "[simfid] ssh up at $IP"

echo "[simfid] airgap + clock pin (2026-07-05 12:00 — the RSIM clock)"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true'
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && exit 1 || exit 0'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null'

echo "[simfid] warm-up (recompute Today buckets, then quit clean)"
lab_ssh "$IP" 'open -g -a Things3'; sleep 12
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\''' >/dev/null 2>&1 || true
sleep 3

echo "[simfid] shipping bundle + guest driver"
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules ~/things-lab/simfid'
lab_scp "$NODE_BIN" "admin@$IP:things-lab/bin/node"
lab_scp -r dist "admin@$IP:things-lab/things-api/dist"
lab_scp -r node_modules/commander "admin@$IP:things-lab/things-api/node_modules/commander"
lab_scp package.json "admin@$IP:things-lab/things-api/package.json"
lab_scp lab/simfid/guest-driver.py "admin@$IP:things-lab/simfid/guest-driver.py"
lab_scp lab/simfid/clone-manifest.json "admin@$IP:things-lab/simfid/manifest.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node'

echo "[simfid] driving cases on the real app…"
lab_ssh "$IP" 'open -g -a Things3'; sleep 8
lab_ssh "$IP" 'python3 ~/things-lab/simfid/guest-driver.py \
  --node ~/things-lab/bin/node --app ~/things-lab/things-api \
  --manifest ~/things-lab/simfid/manifest.json --out ~/things-lab/simfid/run' \
  | tee "$ARTIFACTS/guest.log"

echo "[simfid] collecting guest snapshots"
lab_scp -r "admin@$IP:things-lab/simfid/run" "$ARTIFACTS/guest-run"

echo "[simfid] ingesting → normalized app deltas"
node lab/simfid/ingest-clone.ts "$ARTIFACTS/guest-run" "$APP_DELTAS"

echo "[simfid] comparing sim replay vs fresh clone app deltas"
node lab/simfid/main.ts --app-deltas "$APP_DELTAS" | tee "$ARTIFACTS/verdicts.txt"

echo "[simfid] DONE — artifacts in $ARTIFACTS"
