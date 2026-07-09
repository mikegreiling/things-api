#!/bin/bash
# L5 §5.3 — consent absorption + first live S-probes + signed export.
#
# Runs AGAINST THE GOLDEN (things-lab-golden-v1) during the L5 sitting, AFTER
# Mike has built the six proxies (l5-build-cards.md). Fires each proxy once so
# macOS's per-shortcut consent prompts render on the VM display — Mike clicks
# **Allow** in Screen Sharing — and captures each run's DB delta as the first
# real Shortcuts-vector evidence. Then exports signed copies to lab/shortcuts/.
#
# Proxy contracts (uuid-addressed after the ID-filter upgrade):
#   things-proxy-find-items            {"search": <name>}
#   things-proxy-create-heading        {"title": <str>, "project": <uuid>}
#   things-proxy-edit-title            {"id": <uuid>, "title": <str>}
#   things-proxy-set-detail            {"id": <uuid>, "detail": <Detail>, "value": <str>}
#   things-proxy-delete-items          {"id": <uuid>}          (-> Trash)
#   things-proxy-delete-items-permanently {"id": <uuid>}       (Delete Immediately)
#
# Input is delivered on stdin (`--input-path -`) so "Get Dictionary from
# Shortcut Input" parses the JSON text. Each run is deadline-wrapped so an
# unclicked consent prompt can't wedge the script.
#
# GOLDEN-ONLY, sanctioned-sitting operation. Sacrificial fixtures are cleaned
# up; residue is one trashed project (tolerated, recorded). Does NOT freeze —
# run l5-freeze.sh after.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="things-lab-golden-v1"
IP=$(tart ip "$GOLDEN" 2>/dev/null) || {
  echo "golden not running — boot it first (l5-build-cards.md Card 0)" >&2
  exit 1
}
mkdir -p lab/shortcuts
OUT="lab/artifacts/l5-sitting-$(date +%Y%m%d)"
mkdir -p "$OUT"
REPORT="$OUT/consent-probes.txt"

PROXIES=(
  things-proxy-find-items
  things-proxy-create-heading
  things-proxy-edit-title
  things-proxy-set-detail
  things-proxy-delete-items
  things-proxy-delete-items-permanently
)

note() { echo "[l5-consent] $*" | tee -a "$REPORT"; }

# Guest SQL helper (read-only).
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column)
if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gsql() { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")"; }
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")"; }

uuid_of() { # uuid_of <title> [type] — poll for a fresh row's uuid
  local t="$1" typ="${2:-}" where="title='$1' AND trashed=0" u="" i
  [ -n "$typ" ] && where="$where AND type=$typ"
  for i in $(seq 1 12); do
    u=$(gq "SELECT uuid FROM TMTask WHERE $where ORDER BY creationDate DESC LIMIT 1")
    [ -n "$u" ] && { echo "$u"; return 0; }
    sleep 1
  done
  return 1
}

run_proxy() { # run_proxy <name> <json>
  local name="$1" json="$2"
  note ">>> $name  — a consent prompt may appear on the VM; CLICK **Allow**"
  note "    input: $json"
  lab_ssh "$IP" "printf '%s' $(printf '%q' "$json") > /tmp/proxy-in.json; \
    perl -e 'alarm 150; exec @ARGV' shortcuts run $(printf '%q' "$name") \
    --input-path /tmp/proxy-in.json --output-path /tmp/proxy-out.txt 2>&1; \
    echo \"[exit \$?]\"; echo '--- proxy output ---'; cat /tmp/proxy-out.txt 2>/dev/null; echo" \
    2>&1 | tee -a "$REPORT" || true
  sleep 2
}

echo "[l5-consent] golden at $IP" | tee "$REPORT"
note "verifying the six proxies exist…"
LIST=$(lab_ssh "$IP" 'shortcuts list 2>/dev/null')
echo "$LIST"
MISSING=0
for s in "${PROXIES[@]}"; do
  echo "$LIST" | grep -qx "$s" || { note "MISSING proxy: $s"; MISSING=1; }
done
[ "$MISSING" = 0 ] || {
  note "finish building the proxies before consent absorption"
  exit 1
}

# --- sacrificial fixtures ---------------------------------------------------
note "creating sacrificial fixtures (L5-CONSENT-PROJ + a throwaway to-do)…"
lab_ssh "$IP" "open -g 'things:///add-project?title=L5-CONSENT-PROJ'"
lab_ssh "$IP" "open -g 'things:///add?title=L5-CONSENT-DELPERM'"
sleep 3
P_UUID=$(uuid_of "L5-CONSENT-PROJ" 1) || { note "FATAL: consent project never appeared"; exit 1; }
DELPERM_UUID=$(uuid_of "L5-CONSENT-DELPERM" 0) || { note "FATAL: delperm to-do never appeared"; exit 1; }
note "project=$P_UUID  delperm-todo=$DELPERM_UUID"

# --- [S01] find-items: what identifiers does it return? ---------------------
note "== [S01] find-items (read probe — inspect the returned identifiers) =="
run_proxy things-proxy-find-items "{\"search\":\"L5-CONSENT-PROJ\"}"

# --- [S02] create-heading in an existing project ----------------------------
note "== [S02] create-heading in an EXISTING project (the primary target) =="
run_proxy things-proxy-create-heading "{\"title\":\"L5-CONSENT-HEAD\",\"project\":\"$P_UUID\"}"
H_UUID=$(uuid_of "L5-CONSENT-HEAD" 2 || true)
note "-- heading row (type=2 = heading): ${H_UUID:-<none found>}"
gsql "SELECT uuid, title, type, project FROM TMTask WHERE title LIKE 'L5-CONSENT-HEAD%'" | tee -a "$REPORT"

# --- [S03] edit-title (rename the heading) ----------------------------------
if [ -n "${H_UUID:-}" ]; then
  note "== [S03] edit-title (rename the heading) =="
  run_proxy things-proxy-edit-title "{\"id\":\"$H_UUID\",\"title\":\"L5-CONSENT-HEAD-RN\"}"
  gsql "SELECT uuid, title, type FROM TMTask WHERE uuid='$H_UUID'" | tee -a "$REPORT"
else
  note "== [S03] SKIPPED — no heading uuid (create-heading did not produce a type=2 row) =="
fi

# --- [S-detail] set-detail: probe Reminder Time on the sacrificial to-do ----
note "== [S-detail] set-detail: set Reminder Time on the throwaway to-do =="
run_proxy things-proxy-set-detail "{\"id\":\"$DELPERM_UUID\",\"detail\":\"Reminder Time\",\"value\":\"14:30\"}"
gsql "SELECT title, start, startDate, reminderTime FROM TMTask WHERE uuid='$DELPERM_UUID'" | tee -a "$REPORT"

# --- [S04] delete-items (heading -> Trash) ----------------------------------
if [ -n "${H_UUID:-}" ]; then
  note "== [S04] delete-items (heading -> Trash) =="
  run_proxy things-proxy-delete-items "{\"id\":\"$H_UUID\"}"
  gsql "SELECT uuid, title, trashed FROM TMTask WHERE uuid='$H_UUID'" | tee -a "$REPORT"
fi

# --- [S-delperm] delete-items-permanently: watch the row vanish -------------
note "== [S-delperm] delete-items-permanently (Delete Immediately) =="
note "-- pre: row present?"
gsql "SELECT count(*) AS rows_before FROM TMTask WHERE uuid='$DELPERM_UUID'" | tee -a "$REPORT"
run_proxy things-proxy-delete-items-permanently "{\"id\":\"$DELPERM_UUID\"}"
note "-- post: row gone (0) = permanent single-item delete WORKS; tombstone?"
gsql "SELECT count(*) AS rows_after FROM TMTask WHERE uuid='$DELPERM_UUID'" | tee -a "$REPORT"
gsql "SELECT count(*) AS tombstones FROM TMTombstone WHERE deletedObjectUUID='$DELPERM_UUID'" | tee -a "$REPORT"

# --- cleanup ----------------------------------------------------------------
note "cleanup: trashing L5-CONSENT-PROJ (takes any remaining heading with it)…"
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to delete project id \"$P_UUID\"'" 2>&1 | tee -a "$REPORT" || true
sleep 2

# --- signed export ----------------------------------------------------------
note "exporting signed proxy copies -> lab/shortcuts/"
for s in "${PROXIES[@]}"; do
  if lab_ssh "$IP" "shortcuts export $(printf '%q' "$s") -o /tmp/$s.shortcut" 2>/dev/null; then
    lab_scp "$LAB_SSH_USER@$IP:/tmp/$s.shortcut" "lab/shortcuts/$s.shortcut" && note "  exported $s.shortcut"
  else
    note "  [warn] CLI export unavailable for $s — export manually (File > Export) into lab/shortcuts/"
  fi
done

note "DONE. Evidence: $REPORT. Re-run one proxy to confirm consent stuck, then l5-freeze.sh."
