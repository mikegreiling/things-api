#!/bin/bash
# SBRES1 — the field bug, isolated: drive a move with the sidebar dragged WELL
# past the old 400pt cutoff (the certify cell's +200 only reached 390, which is
# still inside it). Prints the OLD locator's verdict alongside, so the run shows
# both that the geometry is the failing one and that the new locator crosses it.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/${VM:-sbres1-lab}"
REPORT="$OUT/report.txt"
source "$OUT/session.env"
sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O lab/scripts/sbres1-probe.jxa.js "admin@$IP:/Users/admin/labh/sbres1.js" >/dev/null
P() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/sbres1.js $*" </dev/null 2>&1; }
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
G() { lab_ssh "$IP" "$LAB_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
order() { gq 'SELECT COALESCE(group_concat(t," < "),"(none)") FROM (SELECT title AS t FROM TMArea ORDER BY "index", uuid)'; }
note() { echo "[sbres1-wide] $*" | tee -a "$REPORT"; }

SUBJ="${SUBJ:-Gamma}"
note "=== the >400pt sidebar, isolated ==="
lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to tell process \"Things3\" to set size of (first window whose subrole is \"AXStandardWindow\") to {1024, 640}'" </dev/null >/dev/null 2>&1
sleep 2
note "widen (x2): $(P split 200)"
note "widen (x2): $(P split 220)"
note "OLD locator verdict at this width: $(P locate | python3 -c 'import json,sys
d=json.load(sys.stdin)
print("resolves=%s table=%s viewport=%s" % (d.get("resolves"), d.get("shippedTable"), d.get("shippedViewport")))')"
note "before: $(order)"
T0=$(date +%s)
G area reorder "$SUBJ" --first --dangerously-drive-gui --json > "$OUT/cert-wide400.json" 2>&1
T1=$(date +%s)
note "wall clock: $((T1-T0))s"
head -c 900 "$OUT/cert-wide400.json" | tee -a "$REPORT"; echo | tee -a "$REPORT"
note "after:  $(order)"
note "restore: $(P split -420)"
