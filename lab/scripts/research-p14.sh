#!/bin/bash
# P14 — INCOHERENT MUTATION SWEEP (for the Cultured Code bug report). Sends
# type-mismatched / nonsensical commands across URL + AppleScript and records,
# per probe: crash (process death) / scriptable error / silent no-op /
# unexpected mutation. Each probe is bracketed by a PID watch + a
# DiagnosticReports count so crashes are caught even when the app relaunches.
# ONE clone. Two motives: find NOVEL working paths, and catalog every crash/
# erratic behavior so Cultured Code can add graceful guards.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-p14-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[p14] $*" | tee -a "$REPORT"; }
salvage() {
  lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/p14.sqlite"' 2>/dev/null || true
  lab_scp "$LAB_SSH_USER@$IP:/tmp/p14.sqlite" "$OUT/final.sqlite" 2>/dev/null || true
  for f in $(lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | grep -i things' 2>/dev/null || true); do
    lab_scp "$LAB_SSH_USER@$IP:Library/Logs/DiagnosticReports/$f" "$OUT/" 2>/dev/null || true
  done
}
cleanup() { echo "[p14] teardown: $VM"; [ -n "${IP:-}" ] && salvage || true; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

PROJ_PLAIN="933TCvzMgM3MLvpKPcjheC"
PROJ_HEADINGS="Dwr1MiANqMFvAWddgGgzVX"
ALPHA="5saDdJcodvWARN9Ct2nQsT"      # heading with children
AREA_A="7Ck4hAXU36jyaBsy2Fkije"
REPEAT_PROJ=""                       # discovered below

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300)
note "ssh up at $IP"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null'
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")"; }
gcol() { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" | tee -a "$REPORT"; }
relaunch() { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null || (open -g -a Things3; sleep 8)'; }

note "warm-up"
lab_ssh "$IP" 'open -g -a Things3; sleep 12'
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
note "token ok (${#TOKEN})"
REPEAT_PROJ=$(gq "SELECT uuid FROM TMTask WHERE type=1 AND (rt1_recurrenceRule IS NOT NULL OR repeater IS NOT NULL) AND trashed=0 LIMIT 1")
REPEAT_TODO=$(gq "SELECT uuid FROM TMTask WHERE type=0 AND (rt1_recurrenceRule IS NOT NULL OR repeater IS NOT NULL) AND trashed=0 LIMIT 1")
note "repeat fixtures: proj=$REPEAT_PROJ todo=$REPEAT_TODO"

# probe <id> <kind:url|as> <payload> [target-uuid-to-check]
probe() {
  local id="$1" kind="$2" payload="$3" tgt="${4:-}"
  local pid_before dr_before pid_after
  pid_before=$(lab_ssh "$IP" 'pgrep -x Things3 | head -1' 2>/dev/null || true)
  dr_before=$(lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | wc -l | tr -d " "' || echo 0)
  note "── [$id] ($kind) $payload"
  if [ "$kind" = "url" ]; then
    lab_ssh "$IP" "open -g $(printf '%q' "$payload")" 2>&1 | tee -a "$REPORT" || true
  else
    lab_ssh "$IP" "perl -e 'alarm 20; exec @ARGV' osascript -e $(printf '%q' "$payload") 2>&1" | tee -a "$REPORT" || true
  fi
  sleep 3
  pid_after=$(lab_ssh "$IP" 'pgrep -x Things3 | head -1' 2>/dev/null || true)
  local dr_after; dr_after=$(lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | wc -l | tr -d " "' || echo 0)
  if [ -z "$pid_after" ] || { [ -n "$pid_before" ] && [ "$pid_before" != "$pid_after" ]; }; then
    note "   *** CRASH: pid $pid_before -> ${pid_after:-DEAD} (DiagnosticReports $dr_before -> $dr_after) ***"
    relaunch
  elif [ "$dr_after" != "$dr_before" ]; then
    note "   *** NEW DIAGNOSTIC REPORT (possible non-fatal fault) $dr_before -> $dr_after ***"
  fi
  if [ -n "$tgt" ]; then gcol "SELECT title, type, status, trashed, startDate, deadline FROM TMTask WHERE uuid='$tgt'"; fi
}

note "############ A. SCHEDULE-CLASS on wrong / edge types ############"
# The known crash (re-confirm) + its untested siblings.
probe A1 as "tell application \"Things3\" to schedule to do id \"$ALPHA\" for (current date) + 1 * days" "$ALPHA"
probe A2 url "things:///update?id=$ALPHA&auth-token=$TOKEN&when=today" "$ALPHA"
probe A3 as "tell application \"Things3\" to schedule to do id \"$PROJ_PLAIN\" for (current date) + 1 * days" "$PROJ_PLAIN"
[ -n "$REPEAT_PROJ" ] && probe A4 url "things:///update-project?id=$REPEAT_PROJ&auth-token=$TOKEN&when=today" "$REPEAT_PROJ"
[ -n "$REPEAT_TODO" ] && probe A5 as "tell application \"Things3\" to schedule to do id \"$REPEAT_TODO\" for (current date) + 1 * days" "$REPEAT_TODO"

note "############ B. WRONG-SPECIFIER type mismatch (the guarded gap — what does the app DO?) ############"
TODO1=$(gq "SELECT uuid FROM TMTask WHERE type=0 AND trashed=0 AND status=0 AND project IS NULL AND area IS NULL AND heading IS NULL LIMIT 1")
note "plain todo target: $TODO1"
probe B1 url "things:///update-project?id=$TODO1&auth-token=$TOKEN&completed=true" "$TODO1"
probe B2 url "things:///update?id=$PROJ_PLAIN&auth-token=$TOKEN&title=P14-WRONG" "$PROJ_PLAIN"
probe B3 as "tell application \"Things3\" to set status of project id \"$TODO1\" to completed" "$TODO1"
probe B4 as "tell application \"Things3\" to delete project id \"$TODO1\"" "$TODO1"
probe B5 as "tell application \"Things3\" to delete to do id \"$PROJ_PLAIN\"" "$PROJ_PLAIN"
probe B6 as "tell application \"Things3\" to set status of to do id \"$AREA_A\" to completed"

note "############ C. NONSENSE containers / moves ############"
probe C1 as "tell application \"Things3\" to move to do id \"$TODO1\" to area id \"$TODO1\"" "$TODO1"
probe C2 as "tell application \"Things3\" to set project of to do id \"$TODO1\" to project id \"$TODO1\"" "$TODO1"
probe C3 url "things:///update?id=$TODO1&auth-token=$TOKEN&list-id=$TODO1" "$TODO1"
probe C4 as "tell application \"Things3\" to move project id \"$PROJ_PLAIN\" to area id \"$TODO1\"" "$PROJ_PLAIN"

note "############ D. REORDER cross-type / non-member ids ############"
probe D1 as "tell application \"Things3\" to _private_experimental_ reorder to dos in project id \"$PROJ_PLAIN\" with ids \"$AREA_A\""
probe D2 as "tell application \"Things3\" to _private_experimental_ reorder to dos in project id \"$TODO1\" with ids \"$TODO1\""
probe D3 as "tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Today\" with ids \"$AREA_A,$PROJ_HEADINGS\""

note "############ E. malformed / out-of-range values ############"
probe E1 url "things:///update?id=$TODO1&auth-token=$TOKEN&when=99999-99-99" "$TODO1"
probe E2 url "things:///update?id=$TODO1&auth-token=$TOKEN&deadline=not-a-date" "$TODO1"
probe E3 as "tell application \"Things3\" to set status of to do id \"$TODO1\" to 47" "$TODO1"
probe E4 url "things:///json?auth-token=$TOKEN&data=%7Bmalformed"
probe E5 as "tell application \"Things3\" to schedule to do id \"nonexistent-uuid-xyz\" for (current date)"

note "############ crash-report inventory ############"
gcol "SELECT 1"
lab_ssh "$IP" 'ls -t ~/Library/Logs/DiagnosticReports/ 2>/dev/null | grep -i things | head -10' | tee -a "$REPORT" || note "(no Things crash reports on disk)"

note "== copying DB + any Things .ips out =="
lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/p14.sqlite"'
lab_scp "$LAB_SSH_USER@$IP:/tmp/p14.sqlite" "$OUT/final.sqlite" || true
for f in $(lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | grep -i things' || true); do
  lab_scp "$LAB_SSH_USER@$IP:Library/Logs/DiagnosticReports/$f" "$OUT/" 2>/dev/null || true
done
note "GREEN — report: $REPORT"
trap - EXIT; cleanup
