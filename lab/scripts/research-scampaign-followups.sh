#!/bin/bash
# S-campaign autonomous follow-ups (docs/lab/probe-backlog.md §A). ONE clone.
# P1 heading reorder via the private command; P2 set-detail Parent (heading
# move); P3 set-detail Reminder on a scheduled item + dated-reminder clear;
# P4 Completion/Creation date backdating. All autonomous — Shortcuts
# output-class consent is inherited from the golden (deadline-wrapped so a
# consent-didn't-transfer surprise can't wedge). Discovery: no assertions.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-scf-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[scf] $*" | tee -a "$REPORT"; }
cleanup() { echo "[scf] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Seed uuids (from seed-manifest.json).
PROJ_HEADINGS="Dwr1MiANqMFvAWddgGgzVX"
ALPHA="5saDdJcodvWARN9Ct2nQsT"
BETA="M7QEqPbk6v9jZZ6CBiyaP3"
PROJ_PLAIN="933TCvzMgM3MLvpKPcjheC"

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300)
note "ssh up at $IP"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true'
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && exit 1 || exit 0'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null'
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gsql() { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")"; }
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")"; }
gas() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" || true; }
gurl() { lab_ssh "$IP" "open -g $(printf '%q' "$1")"; sleep 2; }
proxy() { # proxy <name> <json>  (deadline-wrapped; headless if consent inherited)
  note "-- shortcuts run $1  $2"
  lab_ssh "$IP" "printf '%s' $(printf '%q' "$2") > /tmp/scf-in.json; rm -f /tmp/scf-out.txt; perl -e 'alarm 60; exec @ARGV' shortcuts run $(printf '%q' "$1") --input-path /tmp/scf-in.json --output-path /tmp/scf-out.txt 2>&1; echo \"[exit \$?]\"; cat /tmp/scf-out.txt 2>/dev/null; echo" 2>&1 | tee -a "$REPORT" || true
  sleep 1
}
uuid_of() { local t="$1" typ="${2:-}" w="title='$1' AND trashed=0" u i; [ -n "$typ" ] && w="$w AND type=$typ"; for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }

note "warm-up: launch Things, quit, relaunch"
lab_ssh "$IP" 'open -g -a Things3; sleep 12'
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3'
lab_ssh "$IP" 'open -g -a Things3; sleep 8'

note "sanity: is Shortcuts output-class consent inherited by the clone? (find-items should be headless)"
proxy things-proxy-find-items '{"search":"LAB-PROJ-PLAIN"}'

# ------------------------------------------------- P1 heading reorder (native)
note "== [P1] heading reorder via the private command (heading uuids as project children) =="
note "-- pre: heading index order in LAB-PROJ-HEADINGS:"
gsql "SELECT uuid, title, type, \"index\" FROM TMTask WHERE project='$PROJ_HEADINGS' AND type=2 ORDER BY \"index\"" | tee -a "$REPORT"
note "-- attempt: reorder to dos in project id with ids Beta,Alpha:"
gas "tell application \"Things3\" to _private_experimental_ reorder to dos in project id \"$PROJ_HEADINGS\" with ids \"$BETA,$ALPHA\"" | tee -a "$REPORT"
sleep 2
note "-- post: heading index order (did Beta move above Alpha?):"
gsql "SELECT uuid, title, type, \"index\" FROM TMTask WHERE project='$PROJ_HEADINGS' AND type=2 ORDER BY \"index\"" | tee -a "$REPORT"
note "-- also confirm the headings' CHILDREN weren't ripped out (heading FK intact):"
gsql "SELECT title, heading FROM TMTask WHERE project IS NULL AND heading IN ('$ALPHA','$BETA') ORDER BY heading" | tee -a "$REPORT"

# --------------------------------------------- P2 set-detail Parent (heading move)
note "== [P2] set-detail Parent: move a heading to another project =="
proxy things-proxy-create-heading "{\"title\":\"SCF-HEAD-MV\",\"project\":\"$PROJ_HEADINGS\"}"
HMV=$(uuid_of "SCF-HEAD-MV" 2 || true)
note "-- created heading: ${HMV:-<none>} (pre project should be $PROJ_HEADINGS)"
gsql "SELECT uuid, title, type, project FROM TMTask WHERE title='SCF-HEAD-MV'" | tee -a "$REPORT"
if [ -n "${HMV:-}" ]; then
  proxy things-proxy-set-detail "{\"id\":\"$HMV\",\"detail\":\"Parent\",\"value\":\"$PROJ_PLAIN\"}"
  note "-- post: heading project (moved to $PROJ_PLAIN?):"
  gsql "SELECT uuid, title, type, project FROM TMTask WHERE uuid='$HMV'" | tee -a "$REPORT"
fi

# ---------------------------------- P3 set-detail Reminder (scheduled + dated clear)
note "== [P3] set-detail Reminder Time on a SCHEDULED to-do =="
gurl "things:///add?title=SCF-REM-SCHED&when=today"
RS=$(uuid_of "SCF-REM-SCHED" 0 || true)
note "-- pre: $RS"; gsql "SELECT title, start, startDate, reminderTime FROM TMTask WHERE uuid='$RS'" | tee -a "$REPORT"
[ -n "${RS:-}" ] && proxy things-proxy-set-detail "{\"id\":\"$RS\",\"detail\":\"Reminder Time\",\"value\":\"14:30\"}"
note "-- post (hope reminderTime=970981376):"; gsql "SELECT title, start, startDate, reminderTime FROM TMTask WHERE uuid='$RS'" | tee -a "$REPORT"

note "== [P3b] clear a DATED reminder via set-detail (the sticky gap, oddity 2e) =="
gurl "things:///add?title=SCF-REM-DATED&when=2026-07-10@09:00"
RD=$(uuid_of "SCF-REM-DATED" 0 || true)
note "-- pre (reminderTime set on a future date):"; gsql "SELECT title, startDate, reminderTime FROM TMTask WHERE uuid='$RD'" | tee -a "$REPORT"
if [ -n "${RD:-}" ]; then
  note "-- attempt clear via empty value:"
  proxy things-proxy-set-detail "{\"id\":\"$RD\",\"detail\":\"Reminder Time\",\"value\":\"\"}"
  note "-- post (reminderTime NULL = dated-clear UNLOCKED):"; gsql "SELECT title, startDate, reminderTime FROM TMTask WHERE uuid='$RD'" | tee -a "$REPORT"
fi

# ----------------------------------- P4 Completion/Creation date backdating
note "== [P4] Completion Date + Creation Date backdating via set-detail =="
gurl "things:///add?title=SCF-BACKDATE"
BD=$(uuid_of "SCF-BACKDATE" 0 || true)
if [ -n "${BD:-}" ]; then
  note "-- complete it, then backdate Completion Date to 2025-01-15:"
  gurl "things:///update?id=$BD&completed=true"
  sleep 1
  gsql "SELECT title, status, stopDate, creationDate FROM TMTask WHERE uuid='$BD'" | tee -a "$REPORT"
  proxy things-proxy-set-detail "{\"id\":\"$BD\",\"detail\":\"Completion Date\",\"value\":\"2025-01-15\"}"
  note "-- post Completion Date (stopDate changed to a 2025 epoch?):"
  gsql "SELECT title, status, stopDate, datetime(stopDate,'unixepoch') AS stop_h FROM TMTask WHERE uuid='$BD'" | tee -a "$REPORT"
  note "-- backdate Creation Date to 2024-06-01:"
  proxy things-proxy-set-detail "{\"id\":\"$BD\",\"detail\":\"Creation Date\",\"value\":\"2024-06-01\"}"
  gsql "SELECT title, creationDate, datetime(creationDate,'unixepoch') AS created_h FROM TMTask WHERE uuid='$BD'" | tee -a "$REPORT"
fi

note "== copying DB out =="
lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/scf.sqlite"'
lab_scp "$LAB_SSH_USER@$IP:/tmp/scf.sqlite" "$OUT/final.sqlite" || true
note "GREEN — report: $REPORT"
trap - EXIT; cleanup
