#!/bin/bash
# L5 §5.4 — freeze checklist (scripted assist).
#
# Runs AGAINST THE GOLDEN (things-lab-golden-v1) at the END of the L5 sitting,
# after l5-consent-absorb.sh. Quits Shortcuts + Things, verifies the four
# proxies are present, truncates the seeding-session monitor noise, prints the
# metadata edits to make by hand, and stops the VM. Golden is never booted
# again — the S-campaign clones it.
#
# It does NOT edit golden-v1-metadata.json itself (that file is the human-
# owned image ledger); it prints the exact diff to apply.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="things-lab-golden-v1"
IP=$(tart ip "$GOLDEN" 2>/dev/null) || { echo "golden not running" >&2; exit 1; }

echo "[l5-freeze] quitting Shortcuts + Things…"
lab_ssh "$IP" 'osascript -e "tell application \"Shortcuts\" to quit"' 2>&1 || true
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"' 2>&1 || true
sleep 3

echo "[l5-freeze] verifying the four proxies survive…"
LIST=$(lab_ssh "$IP" 'shortcuts list 2>/dev/null')
OK=1
for s in things-proxy-create-heading things-proxy-edit-title things-proxy-delete-items things-proxy-find-items; do
  if echo "$LIST" | grep -qx "$s"; then echo "  ok: $s"; else echo "  MISSING: $s"; OK=0; fi
done
[ "$OK" = 1 ] || { echo "[l5-freeze] refusing to freeze — a proxy is missing" >&2; exit 1; }

echo "[l5-freeze] truncating ~/things-lab/events.ndjson (seeding-session noise)…"
lab_ssh "$IP" ': > ~/things-lab/events.ndjson' 2>&1 || true

echo
echo "[l5-freeze] ===== APPLY THESE METADATA EDITS BY HAND (docs/lab/golden-v1-metadata.json) ====="
cat <<'META'
  - humanLayersDone: append "L5-shortcuts"
  - deferred: remove the "L5: Shortcuts first-run…" entry
  - l5Progress: set sittingCompleted: "<today>", clear "remaining", record
      whether Find Items offered an ID filter (Card 1/2 observation) and any
      Card 5 action-catalog findings (repeat params, tags/reminder fields,
      convert/move actions, hard-delete toggle wording)
  - add: consentResidue: "one trashed L5-CONSENT-PROJ (probe assertions tolerate)"
  - exported proxies: lab/shortcuts/*.shortcut (git add)
META
echo "[l5-freeze] ================================================================================"
echo
echo "[l5-freeze] stopping the golden VM…"
tart stop "$GOLDEN" >/dev/null 2>&1 || true
echo "[l5-freeze] DONE. Golden frozen. Next: enable s-suite in lab/scripts/regress.sh and run lab:regress in a clone."
