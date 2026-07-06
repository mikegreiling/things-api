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
meta = json.load(open("docs/lab/golden-v1-metadata.json"))
first = datetime.strptime(meta["trialFirstLaunchIso"], "%Y-%m-%dT%H:%M:%SZ")
pinned = datetime.strptime(meta["pinnedDate"], "%Y-%m-%d")
expiry = first + timedelta(days=15)
margin = (expiry - pinned).days
if margin < 2:
    sys.exit(f"PREFLIGHT FAIL: pinnedDate {meta['pinnedDate']} is within {margin} day(s) of "
             f"trial expiry {expiry:%Y-%m-%d} — rebuild the golden (docs/lab/golden-runbook.md)")
print(f"[regress] trial window ok: pinned {meta['pinnedDate']}, expiry {expiry:%Y-%m-%d} ({margin} days margin)")
EOF

for suite in u a x o r e p; do
  echo "[regress] === suite: $suite ==="
  npm run lab:run -- --suite "lab/suites/$suite-suite.json"
done

echo "[regress] === write-layer e2e smoke ==="
bash lab/scripts/e2e-write-smoke.sh

echo "[regress] ALL GREEN — automation surface unchanged"
