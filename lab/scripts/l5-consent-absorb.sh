#!/bin/bash
# L5 §5.3 — consent absorption + signed export (scripted assist for the sitting).
#
# Runs AGAINST THE GOLDEN (things-lab-golden-v1) during the L5 sitting, AFTER
# Mike has restructured the four proxies (l5-build-cards.md Cards 1–4). Runs
# each proxy once so macOS's per-shortcut consent prompts fire — Mike clicks
# **Allow** on each in Screen Sharing — then exports signed copies to
# lab/shortcuts/ for the repo audit trail.
#
# Sacrificial fixtures: creates L5-CONSENT-PROJ, exercises every proxy against
# it, trashes it afterwards (residue: one trashed project — recorded in
# metadata; probe assertions tolerate it).
#
# NOTE: this touches the GOLDEN, so it is a sanctioned-sitting operation only.
# Never run it outside an L5 sitting. It does NOT freeze the image — run
# l5-freeze.sh after.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="things-lab-golden-v1"
IP=$(tart ip "$GOLDEN" 2>/dev/null) || { echo "golden not running — boot it first (l5-build-cards.md Card 0)" >&2; exit 1; }
mkdir -p lab/shortcuts

echo "[l5-consent] golden at $IP"
echo "[l5-consent] verifying the four proxies exist…"
LIST=$(lab_ssh "$IP" 'shortcuts list 2>/dev/null')
echo "$LIST"
for s in things-proxy-create-heading things-proxy-edit-title things-proxy-delete-items things-proxy-find-items; do
  echo "$LIST" | grep -qx "$s" || { echo "[l5-consent] MISSING proxy: $s — finish Cards 1–4 first" >&2; exit 1; }
done

echo "[l5-consent] creating sacrificial L5-CONSENT-PROJ…"
lab_ssh "$IP" "open -g 'things:///add-project?title=L5-CONSENT-PROJ'"
sleep 3

run_proxy() { # run_proxy <name> <json-input>
  echo "[l5-consent] >>> running $1  (CLICK: Allow the consent prompt in Screen Sharing)"
  lab_ssh "$IP" "shortcuts run $(printf '%q' "$1") -i $(printf '%q' "$2")" 2>&1 || true
  sleep 3
}

# One run per proxy absorbs its consent. Inputs are harmless against the
# sacrificial project (heading created, titled, then the project trashed).
run_proxy things-proxy-find-items    '{"search":"L5-CONSENT-PROJ"}'
run_proxy things-proxy-create-heading '{"title":"L5-CONSENT-HEAD","project":"L5-CONSENT-PROJ"}'
run_proxy things-proxy-edit-title     '{"find":"L5-CONSENT-HEAD","title":"L5-CONSENT-HEAD-RN"}'
run_proxy things-proxy-delete-items   '{"find":"L5-CONSENT-HEAD-RN"}'

echo "[l5-consent] trashing the sacrificial project…"
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to delete project \"L5-CONSENT-PROJ\""' 2>&1 || true
sleep 2

echo "[l5-consent] exporting signed proxy copies -> lab/shortcuts/"
for s in things-proxy-create-heading things-proxy-edit-title things-proxy-delete-items things-proxy-find-items; do
  # `shortcuts export` requires GUI context; run it and pull the file. If the
  # CLI export is unavailable on this macOS, fall back to a manual File >
  # Export note (recorded, not fatal).
  if lab_ssh "$IP" "shortcuts export $(printf '%q' "$s") -o /tmp/$s.shortcut" 2>/dev/null; then
    lab_scp "$LAB_SSH_USER@$IP:/tmp/$s.shortcut" "lab/shortcuts/$s.shortcut" && echo "  exported $s.shortcut"
  else
    echo "  [warn] CLI export unavailable for $s — export manually via Shortcuts File > Export and drop into lab/shortcuts/"
  fi
done

echo "[l5-consent] DONE. Verify consent stuck by re-running one proxy WITHOUT a prompt, then run l5-freeze.sh."
