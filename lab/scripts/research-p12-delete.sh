#!/bin/bash
# P12 per-delete driver. Usage: research-p12-delete.sh <step>
#   step ∈ {heading-trash, heading-perm, project-trash, area-trash}
# Runs ONE delete-class Shortcuts action, which BLOCKS on the consent dialog
# until Mike clicks. Captures the DB subtree before + after. Sources
# /tmp/p12/env from the setup script.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
source /tmp/p12/env
REPORT="$OUT/report.txt"
note() { echo "[p12:$1] ${*:2}" | tee -a "$REPORT"; }
gsql() { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" | tee -a "$REPORT"; }
proxy() {
  lab_ssh "$IP" "printf '%s' $(printf '%q' "$2") > /tmp/in.json; rm -f /tmp/out.txt; perl -e 'alarm 180; exec @ARGV' shortcuts run $(printf '%q' "$1") --input-path /tmp/in.json --output-path /tmp/out.txt 2>&1; echo \"[exit \$?]\"; cat /tmp/out.txt 2>/dev/null; echo" 2>&1 | tee -a "$REPORT" || true
}

STEP="$1"
case "$STEP" in
  heading-trash)
    note h "== delete NON-EMPTY heading via things-proxy-delete-items (-> Trash) =="
    note h "-- pre:"; gsql "SELECT title, type, status, trashed, project, heading FROM TMTask WHERE uuid='$HNE' OR heading='$HNE'"
    note h "CLICK THE CONSENT DIALOG NOW (delete-class, no Always-Allow)…"
    proxy things-proxy-delete-items "{\"id\":\"$HNE\"}"
    sleep 2
    note h "-- post (heading gone/trashed? children: trashed / reparented to project root / orphaned?):"
    gsql "SELECT title, type, status, trashed, project, heading FROM TMTask WHERE title LIKE 'P12-HNE-%' OR uuid='$HNE'"
    ;;
  heading-perm)
    note hp "== PERMANENTLY delete NON-EMPTY heading via things-proxy-delete-items-permanently =="
    note hp "-- pre:"; gsql "SELECT title, type, status, trashed FROM TMTask WHERE uuid='$HNE2' OR heading='$HNE2'"
    note hp "CLICK THE CONSENT DIALOG NOW…"
    proxy things-proxy-delete-items-permanently "{\"id\":\"$HNE2\"}"
    sleep 2
    note hp "-- post (heading row gone? children hard-deleted / survived / reparented?):"
    gsql "SELECT title, type, status, trashed FROM TMTask WHERE title LIKE 'P12-HNE2-%' OR uuid='$HNE2'"
    ;;
  project-trash)
    note p "== delete a PROJECT WITH CHILDREN via the same delete-items proxy =="
    note p "-- pre:"; gsql "SELECT title, type, status, trashed, project, heading FROM TMTask WHERE uuid='$PCH' OR project='$PCH' OR heading IN (SELECT uuid FROM TMTask WHERE project='$PCH' AND type=2)"
    note p "CLICK THE CONSENT DIALOG NOW…"
    proxy things-proxy-delete-items "{\"id\":\"$PCH\"}"
    sleep 2
    note p "-- post (project trashed? children cascade-trashed or orphaned?):"
    gsql "SELECT title, type, status, trashed, project FROM TMTask WHERE uuid='$PCH' OR project='$PCH' OR title LIKE 'P12-PCH-%'"
    ;;
  area-trash)
    note a "== delete an AREA via the delete-items proxy (areas have no Trash — A25) =="
    note a "-- pre:"; gsql "SELECT uuid, title FROM TMArea WHERE uuid='$ACH'"
    note a "CLICK THE CONSENT DIALOG NOW (if one appears — Shortcuts may reject an area outright)…"
    proxy things-proxy-delete-items "{\"id\":\"$ACH\"}"
    sleep 2
    note a "-- post (area row gone? or rejected — no area support in Find Items?):"
    gsql "SELECT uuid, title FROM TMArea WHERE uuid='$ACH'"
    ;;
  finish)
    note f "== copying DB out + teardown =="
    lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/p12.sqlite"'
    lab_scp "$LAB_SSH_USER@$IP:/tmp/p12.sqlite" "$OUT/final.sqlite" || true
    tart stop "$VM" >/dev/null 2>&1 || true
    tart delete "$VM" >/dev/null 2>&1 || true
    note f "DONE — report: $REPORT"
    ;;
  *) echo "unknown step: $STEP" >&2; exit 2 ;;
esac
