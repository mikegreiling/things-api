#!/bin/bash
# Phase 21b — script B: consent-destroying environment probes (PHASED).
#
# Complements research-phase21b-a.sh (autonomous half). This clone's consent
# state gets deliberately destroyed, so it runs LAST and in its own VM. The
# script is phased because three moments need a human click in Screen
# Sharing (vnc://<ip>, admin/admin); the VM stays alive between phases.
#
#   start        clone+boot; B0 permanent-delete respellings (AppleScript
#                still granted); B1 URL baseline (defaults dump, token stash,
#                URL-write smoke). Prints VM name + IP, leaves VM running.
#   url-off <vm> AFTER Mike unchecks Things Settings > General >
#                "Enable Things URLs": token state, defaults diff, and the
#                URL-write-while-disabled signature (pre-captured token).
#   url-on <vm>  AFTER Mike re-checks the toggle: token rotation check,
#                old-token write, new-token write.
#   tcc <vm>     sudo tccutil reset AppleEvents -> capture the PENDING
#                signature (deadline-killed osascript; prompt renders on the
#                VM display), then poll until Mike clicks "Don't Allow" ->
#                capture the DENIED signature (-1743).
#   finish <vm>  pull final DB + events.ndjson, tear down.
#
# Discovery research: no assertions — evidence lands in lab/artifacts/<vm>/.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

PHASE="${1:?usage: research-phase21b-b.sh start|url-off|url-on|tcc|finish [vm-name]}"

note() { echo "[p21b-b:$PHASE] $*" | tee -a "$REPORT"; }

vm_ip() {
  local ip
  ip=$(tart ip "$VM" 2>/dev/null) || { echo "no IP for $VM — is it running?" >&2; exit 1; }
  echo "$ip"
}

push_gsql() {
  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column)
if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
}

gsql() { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")"; }
gq()   { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")"; }
gas()  { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" || true; }
gurl() { lab_ssh "$IP" "open -g $(printf '%q' "$1")"; sleep 2; }

dump_defaults() { # dump_defaults <label>
  lab_ssh "$IP" 'defaults read com.culturedcode.ThingsMac 2>&1' > "$OUT/defaults-$1.txt" || true
  note "defaults snapshot -> defaults-$1.txt"
}

dump_settings() {
  note "-- TMSettings now:"
  gsql "SELECT uuid, uriSchemeAuthenticationToken FROM TMSettings" | tee -a "$REPORT"
}

url_write_check() { # url_write_check <title> <url> — did the row appear within 12s?
  local title="$1" url="$2" i found=no
  note "-- URL write: $url"
  lab_ssh "$IP" "open -g $(printf '%q' "$url")" 2>&1 | tee -a "$REPORT" || true
  for i in 1 2 3 4 5 6; do
    sleep 2
    [ -n "$(gq "SELECT uuid FROM TMTask WHERE title='$title' LIMIT 1")" ] && { found=yes; break; }
  done
  note "-- row '$title' present: $found"
}

recent_windows() {
  note "-- last window/dialog events:"
  lab_ssh "$IP" 'tail -8 ~/things-lab/events.ndjson 2>/dev/null' | tee -a "$REPORT" || true
}

case "$PHASE" in
# =============================================================== start
start)
  VM="things-run-p21bb-$(date +%Y%m%d-%H%M%S)"
  OUT="lab/artifacts/$VM"
  mkdir -p "$OUT"
  REPORT="$OUT/report.txt"

  note "cloning golden -> $VM"
  tart clone things-lab-golden-v1 "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300)
  note "ssh up at $IP"

  note "airgap + pin clock to 2026-07-05"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true'
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && exit 1 || exit 0'
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null'
  push_gsql

  note "warm-up: launch Things, quit, relaunch"
  lab_ssh "$IP" 'open -g -a Things3; sleep 12'
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3'
  lab_ssh "$IP" 'open -g -a Things3; sleep 8'

  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  [ -n "$TOKEN" ] || { note "FATAL: no auth token"; exit 1; }
  printf '%s' "$TOKEN" > "$OUT/token.txt"
  note "baseline token stashed (${#TOKEN} chars)"

  note "== [B0] permanent-delete respellings (A5 follow-up: bare delete-to-do-id errored -1728) =="
  gurl "things:///add?title=R21B-DEL-2"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    DEL=$(gq "SELECT uuid FROM TMTask WHERE title='R21B-DEL-2' AND trashed=0 LIMIT 1")
    [ -n "$DEL" ] && break; sleep 1
  done
  [ -n "${DEL:-}" ] || { note "FATAL: R21B-DEL-2 never appeared"; exit 1; }
  note "-- to Trash:"
  gas "tell application \"Things3\" to delete to do id \"$DEL\"" | tee -a "$REPORT"
  for i in 1 2 3 4 5; do
    [ "$(gq "SELECT trashed FROM TMTask WHERE uuid='$DEL'")" = "1" ] && break; sleep 1
  done
  gsql "SELECT title, trashed FROM TMTask WHERE uuid='$DEL'" | tee -a "$REPORT"
  note "-- spelling 1: delete to do id (replicate A5, settled):"
  gas "tell application \"Things3\" to delete to do id \"$DEL\"" | tee -a "$REPORT"
  sleep 1
  note "-- spelling 2: delete via list \"Trash\" whose-clause:"
  gas "tell application \"Things3\" to delete (first to do of list \"Trash\" whose id is \"$DEL\")" | tee -a "$REPORT"
  sleep 1
  note "-- spelling 3: delete to do id of list \"Trash\":"
  gas "tell application \"Things3\" to delete to do id \"$DEL\" of list \"Trash\"" | tee -a "$REPORT"
  sleep 1
  note "-- row state after all spellings (0 rows = some spelling permanently deleted):"
  gsql "SELECT count(*) AS rows_left FROM TMTask WHERE uuid='$DEL'" | tee -a "$REPORT"
  gsql "SELECT count(*) AS tombstones FROM TMTombstone WHERE deletedObjectUUID='$DEL'" | tee -a "$REPORT"

  note "== [B1] URL baseline =="
  dump_defaults "baseline"
  dump_settings
  url_write_check "R21B-URLON-1" "things:///add?title=R21B-URLON-1&auth-token=$TOKEN"

  note ""
  note "READY FOR CLICK 1 — VM: $VM  IP: $IP"
  note "Mike: open Screen Sharing -> vnc://$IP (admin/admin) -> Things -> Settings… -> General -> UNCHECK 'Enable Things URLs'. Leave Settings open."
  note "Then run: lab/scripts/research-phase21b-b.sh url-off $VM"
  ;;

# ============================================================== url-off
url-off)
  VM="${2:?usage: research-phase21b-b.sh url-off <vm-name>}"
  OUT="lab/artifacts/$VM"
  REPORT="$OUT/report.txt"
  IP=$(vm_ip)
  TOKEN=$(cat "$OUT/token.txt")

  note "== [B2] Enable-Things-URLs OFF: state + disabled-write signature =="
  dump_defaults "url-off"
  note "-- defaults diff vs baseline:"
  diff "$OUT/defaults-baseline.txt" "$OUT/defaults-url-off.txt" | tee -a "$REPORT" || true
  dump_settings
  url_write_check "R21B-URLOFF-1" "things:///add?title=R21B-URLOFF-1&auth-token=$TOKEN"
  url_write_check "R21B-URLOFF-2" "things:///add?title=R21B-URLOFF-2"
  recent_windows

  note ""
  note "READY FOR CLICK 2 — Mike: RE-CHECK 'Enable Things URLs' in the same Settings pane."
  note "Then run: lab/scripts/research-phase21b-b.sh url-on $VM"
  ;;

# =============================================================== url-on
url-on)
  VM="${2:?usage: research-phase21b-b.sh url-on <vm-name>}"
  OUT="lab/artifacts/$VM"
  REPORT="$OUT/report.txt"
  IP=$(vm_ip)
  OLD_TOKEN=$(cat "$OUT/token.txt")

  note "== [B3] Enable-Things-URLs back ON: rotation + old/new token writes =="
  dump_defaults "url-on"
  note "-- defaults diff url-off -> url-on:"
  diff "$OUT/defaults-url-off.txt" "$OUT/defaults-url-on.txt" | tee -a "$REPORT" || true
  dump_settings
  NEW_TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  if [ "$NEW_TOKEN" = "$OLD_TOKEN" ]; then
    note "-- token UNCHANGED across off/on cycle"
  else
    note "-- token ROTATED: old=${OLD_TOKEN} new=${NEW_TOKEN}"
  fi
  url_write_check "R21B-OLDTOK-1" "things:///add?title=R21B-OLDTOK-1&auth-token=$OLD_TOKEN"
  [ "$NEW_TOKEN" != "$OLD_TOKEN" ] && [ -n "$NEW_TOKEN" ] && \
    url_write_check "R21B-NEWTOK-1" "things:///add?title=R21B-NEWTOK-1&auth-token=$NEW_TOKEN"
  recent_windows

  note ""
  note "URL lifecycle done. Next (destroys AppleScript consent for this clone):"
  note "  lab/scripts/research-phase21b-b.sh tcc $VM"
  ;;

# ================================================================== tcc
tcc)
  VM="${2:?usage: research-phase21b-b.sh tcc <vm-name>}"
  OUT="lab/artifacts/$VM"
  REPORT="$OUT/report.txt"
  IP=$(vm_ip)

  note "== [B4] TCC signatures: pending, then denied =="
  note "-- sanity: osascript currently granted?"
  lab_ssh "$IP" "perl -e 'alarm shift; exec @ARGV' 15 osascript -e 'tell application \"Things3\" to count of areas' 2>&1" | tee -a "$REPORT" || true
  note "-- sudo tccutil reset AppleEvents:"
  lab_ssh "$IP" 'sudo tccutil reset AppleEvents 2>&1' | tee -a "$REPORT"
  sleep 2
  note "-- PENDING probe (12s deadline kill; prompt should render on the VM display):"
  START=$(date +%s)
  set +e
  PENDING_OUT=$(lab_ssh "$IP" "perl -e 'alarm shift; exec @ARGV' 12 osascript -e 'tell application \"Things3\" to count of areas' 2>&1")
  PENDING_CODE=$?
  set -e
  note "-- pending probe: exit=$PENDING_CODE elapsed=$(( $(date +%s) - START ))s output='$PENDING_OUT'"

  note ""
  note "CLICK 3 — Mike: the consent prompt is on the VM display (vnc://$IP). Click **Don't Allow**."
  note "Polling every 5s for the denied signature (up to 10 min)…"
  DENIED=no
  for i in $(seq 1 120); do
    sleep 5
    set +e
    POLL_OUT=$(lab_ssh "$IP" "perl -e 'alarm shift; exec @ARGV' 10 osascript -e 'tell application \"Things3\" to count of areas' 2>&1")
    POLL_CODE=$?
    set -e
    if [ "$POLL_CODE" -eq 0 ]; then
      note "-- osascript SUCCEEDED (exit 0, out='$POLL_OUT') — was that an 'Allow' click? Denied signature NOT captured."
      break
    fi
    if echo "$POLL_OUT" | grep -q '1743'; then
      note "-- DENIED signature captured: exit=$POLL_CODE output='$POLL_OUT'"
      DENIED=yes
      break
    fi
    # still pending (deadline kill) — keep waiting for the click
  done
  [ "$DENIED" = yes ] || note "-- WARNING: denied signature not captured (timeout or Allow)."
  note "-- immediate retry (denied should now be instant, not a hang):"
  START=$(date +%s)
  set +e
  RETRY_OUT=$(lab_ssh "$IP" "perl -e 'alarm shift; exec @ARGV' 10 osascript -e 'tell application \"Things3\" to count of areas' 2>&1")
  RETRY_CODE=$?
  set -e
  note "-- retry: exit=$RETRY_CODE elapsed=$(( $(date +%s) - START ))s output='$RETRY_OUT'"

  note ""
  note "Done. Run: lab/scripts/research-phase21b-b.sh finish $VM"
  ;;

# =============================================================== finish
finish)
  VM="${2:?usage: research-phase21b-b.sh finish <vm-name>}"
  OUT="lab/artifacts/$VM"
  REPORT="$OUT/report.txt"
  IP=$(vm_ip)

  note "== pulling artifacts + teardown =="
  lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/p21bb.sqlite"' || true
  lab_scp "$LAB_SSH_USER@$IP:/tmp/p21bb.sqlite" "$OUT/final.sqlite" || true
  lab_scp "$LAB_SSH_USER@$IP:~/things-lab/events.ndjson" "$OUT/events.ndjson" || true
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "GREEN — evidence in $OUT"
  ;;

*)
  echo "unknown phase: $PHASE" >&2
  exit 1
  ;;
esac
