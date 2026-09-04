#!/bin/bash
# Full regression sweep: every probe suite + the write-layer e2e smoke, each
# against a fresh clone of the golden. One command, zero interaction, exit 0
# only when everything is green (Lab-7 exit criterion).
#
#   npm run lab:regress
#
# Any verdict/tier delta means a Things/macOS update moved the automation
# surface — see docs/lab/drift-runbook.md for the reconciliation workflow.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

# --- preflight: the golden's pinned date must sit inside its trial window.
python3 - <<'EOF'
import json, sys
from datetime import datetime, timedelta
meta = json.load(open("docs/lab/golden-v4-metadata.json"))
first = datetime.strptime(meta["trialFirstLaunchIso"], "%Y-%m-%dT%H:%M:%SZ")
pinned = datetime.strptime(meta["pinnedDate"], "%Y-%m-%d")
expiry = first + timedelta(days=15)
margin = (expiry - pinned).days
if margin < 2:
    sys.exit(f"PREFLIGHT FAIL: pinnedDate {meta['pinnedDate']} is within {margin} day(s) of "
             f"trial expiry {expiry:%Y-%m-%d} — rebuild the golden (docs/lab/golden-runbook.md)")
print(f"[regress] trial window ok: pinned {meta['pinnedDate']}, expiry {expiry:%Y-%m-%d} ({margin} days margin)")
EOF

# s-suite drives the Apple Shortcuts proxies; its output-class probes run
# headless on the golden's inherited Always-Allow, and its delete-class probes
# are group:interactive (auto-skipped by lab:run).
for suite in u a x o r e p s; do
  echo "[regress] === suite: $suite ==="
  npm run lab:run -- --suite "lab/suites/$suite-suite.json"
done

# THE WRITE LAYER RUNS TWICE, ONCE PER IDENTITY (HELPGST1). Which process
# executes a script is a certification dimension, not an implementation detail:
# a golden clone with no helpers runs everything under its own sshd-descended
# identity, while every field host brokers the same primitives through the
# deputy — and two releases shipped green-in-lab and broken-in-field on exactly
# that difference (0.19.2's census, 0.20.7's `do shell script` sidecar). So both
# arms run, and each is reported by name; the routed arm additionally drives one
# real Repeat dialog through the broker.
#
# The routed arm needs `things-lab-golden-v4h` — the helpers-granted layer over
# v4 (docs/lab/helpgst1-helpers-in-guest.md) — and the host-built helper bundle.
# Both are preconditions, not optional extras: a regress that silently skipped
# the routed arm would certify the wrong half of the surface.
if [ ! -x "deputy/build/Things API Helper.app/Contents/MacOS/things-deputy" ]; then
  echo "[regress] building the helper bundle for the routed arm"
  bash scripts/build-helpers.sh >/dev/null
fi

for arm in direct routed; do
  echo "[regress] === write-layer e2e smoke: $arm arm ==="
  bash lab/scripts/e2e-write-smoke.sh --arm "$arm"
done

echo "[regress] ALL GREEN — automation surface unchanged, both arms (direct + routed)"
