#!/bin/bash
# Stage 5 (release-gate b/c) — the FIELD-SHAPED RC run, inside a ROUTED guest.
#
# Clone golden-v4h -> boot -> airgap -> pin the clock -> ship the RC's dist and
# the host-built helper bundle -> install + route through the deputy -> run the
# batch's changed operations with the NORMAL CLI syntax -> collect -> destroy.
#
#   RC_DIST=/path/to/package/dist bash lab/scripts/stage5-rc-run.sh
#   RC_DIST=… GUEST_CELLS=lab/guest/stage5-arprobe.sh bash lab/scripts/stage5-rc-run.sh
#
# WHY THIS EXISTS SEPARATELY FROM e2e-write-smoke.sh. That orchestrator runs the
# lab's own fixed suite; this one runs the cells a PARTICULAR release batch needs
# (release-checklist.md Stage 5 (iii): "every operation whose driver / vector /
# recipe / deputy-facing code changed"). The provisioning either side of the
# cells is the same law — same golden, same airgap, same clock pin, same routed
# assertion — so it lives here once and the cell script is the variable.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
source lab/scripts/helpers-guest.sh

RC_DIST="${RC_DIST:?set RC_DIST to the unpacked RC dist directory}"
[ -f "$RC_DIST/cli/main.js" ] || { echo "no $RC_DIST/cli/main.js" >&2; exit 2; }
GUEST_CELLS="${GUEST_CELLS:-lab/guest/stage5-cells.sh}"
[ -f "$GUEST_CELLS" ] || { echo "no cell script at $GUEST_CELLS" >&2; exit 2; }
CELLS_BASE=$(basename "$GUEST_CELLS")

GOLDEN_V4H="${GOLDEN:-things-lab-golden-v4h}"
VM="things-rc-stage5-$(date +%Y%m%d-%H%M%S)"
ARTIFACTS="lab/artifacts/$VM"
mkdir -p "$ARTIFACTS"

NODE_BIN=$(node -e 'console.log(process.execPath)')

# commander by RESOLVED path, never `node_modules/commander`. An agent worktree
# under .claude/worktrees/ has no node_modules of its own — node resolves the
# primary checkout's by walking UP — so the relative path is simply absent there
# and the guest CLI dies on `Cannot find package 'commander'`.
COMMANDER_DIR=$(node -e "
  const { dirname, join } = require('node:path'); const { existsSync } = require('node:fs');
  let d = process.cwd();
  for (;;) { const c = join(d, 'node_modules', 'commander');
    if (existsSync(join(c, 'package.json'))) { console.log(c); break }
    const up = dirname(d); if (up === d) break; d = up }
")
[ -d "$COMMANDER_DIR" ] || { echo "[stage5] commander not resolvable from $PWD" >&2; exit 2; }

# The signed helper bundle. `deputy/build/` is GITIGNORED, so a fresh checkout
# (or a worktree) has none and `guest_helpers_ship` would fail at the routed
# arm's first step. Build it here the way lab/scripts/regress.sh does — same
# Developer ID identity, which is what makes golden-v4h's baked TCC rows apply.
if [ ! -x "deputy/build/Things API Helper.app/Contents/MacOS/things-deputy" ]; then
  echo "[stage5] no helper bundle in deputy/build — building it"
  bash scripts/build-helpers.sh >/dev/null
fi

echo "[stage5] node:        $NODE_BIN"
echo "[stage5] RC dist:     $RC_DIST"
echo "[stage5] commander:   $COMMANDER_DIR"
echo "[stage5] cells:       $GUEST_CELLS"

cleanup() {
  echo "[stage5] teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}

echo "[stage5] cloning $GOLDEN_V4H -> $VM"
tart clone "$GOLDEN_V4H" "$VM"
# The trap is armed BEFORE the boot wait, never after: a wait that times out on
# the FATAL path with the trap uninstalled leaves a 50 GB clone running (PROVREM1 §7.2).
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
lab_scp -r "$COMMANDER_DIR" "admin@$IP:things-lab/things-api/node_modules/commander"
lab_scp package.json "admin@$IP:things-lab/things-api/package.json"
lab_scp lab/guest/beep-sentinel.sh "admin@$IP:things-lab/beep-sentinel.sh"
lab_scp "$GUEST_CELLS" "admin@$IP:things-lab/$CELLS_BASE"
lab_ssh "$IP" "chmod +x ~/things-lab/bin/node ~/things-lab/beep-sentinel.sh ~/things-lab/$CELLS_BASE"

CLI="~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js"
echo "[stage5] provisioning the helper pair in the guest"
guest_helpers_provision "$IP" "$CLI"

echo "[stage5] running the Stage 5 cells…"
set +e
lab_ssh "$IP" "THINGS_LAB_BEEPS_OK='${THINGS_LAB_BEEPS_OK:-1}' bash ~/things-lab/$CELLS_BASE ~/things-lab/bin/node ~/things-lab/things-api" \
  | tee "$ARTIFACTS/stage5-transcript.log"
RESULT=${PIPESTATUS[0]}
set -e

echo "[stage5] collecting"
# The deputy's own log is the routed arm's second witness: a broker refusal
# (`rejected-script`) is only ever legible here — the client sees "the drive failed".
lab_scp "admin@$IP:.local/state/things-api/deputy/deputy.log" "$ARTIFACTS/deputy.log" 2>/dev/null || true
lab_scp -r "admin@$IP:things-lab/out" "$ARTIFACTS/out" 2>/dev/null || true

if [ "$RESULT" -eq 0 ]; then
  echo "[stage5] GREEN — artifacts in $ARTIFACTS"
else
  echo "[stage5] RED (exit $RESULT) — artifacts in $ARTIFACTS"
fi
exit "$RESULT"
