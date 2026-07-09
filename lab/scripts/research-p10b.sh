#!/bin/bash
# P10b — follow-up to P10d's discovery that AppleScript `to do id <uuid>`
# fully addresses HEADING rows (type=2). Completes the heading-verb story:
#   b1  Archive a NON-EMPTY heading (set status completed): children touched?
#   b2  Un-archive (set status to open): clean round-trip?
#   b3  AS `delete to do id <heading>` — headless delete?! Children fate
#       (re-parent to project root / orphan / cascade)? Trashed or removed?
#   b4  AS `set project of to do id <heading>` to another project — MOVE?
#       (dead on every other surface; children follow?)
#   b5  AS `schedule to do id <heading>` / set due date — reject or nonsense?
#   b6  second rename observation (P10d had one) + rename of an ARCHIVED heading.
# ONE clone, autonomous. Discovery: no assertions.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-p10b-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[p10b] $*" | tee -a "$REPORT"; }
cleanup() { echo "[p10b] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

PROJ_PLAIN="933TCvzMgM3MLvpKPcjheC"
PROJ_HEADINGS="Dwr1MiANqMFvAWddgGgzVX"

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
gsql() { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")"; }
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")"; }
gas() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" || true; }
gurl() { lab_ssh "$IP" "open -g $(printf '%q' "$1")"; sleep 2; }
proxy() {
  note "-- shortcuts run $1  $2"
  lab_ssh "$IP" "printf '%s' $(printf '%q' "$2") > /tmp/in.json; rm -f /tmp/out.txt; perl -e 'alarm 60; exec @ARGV' shortcuts run $(printf '%q' "$1") --input-path /tmp/in.json --output-path /tmp/out.txt 2>&1; echo \"[exit \$?]\"; cat /tmp/out.txt 2>/dev/null; echo" 2>&1 | tee -a "$REPORT" || true
  sleep 1
}
uuid_of() { local t="$1" typ="${2:-}" w="title='$1' AND trashed=0" u i; [ -n "$typ" ] && w="$w AND type=$typ"; for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }

note "warm-up: launch Things, quit, relaunch"
lab_ssh "$IP" 'open -g -a Things3; sleep 12'
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3'
lab_ssh "$IP" 'open -g -a Things3; sleep 8'
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
note "token ok (${#TOKEN})"

note "== fixtures: heading X (2 children) + heading Y (1 child) in LAB-PROJ-PLAIN =="
proxy things-proxy-create-heading "{\"title\":\"P10B-X\",\"project\":\"$PROJ_PLAIN\"}"
proxy things-proxy-create-heading "{\"title\":\"P10B-Y\",\"project\":\"$PROJ_PLAIN\"}"
HX=$(uuid_of "P10B-X" 2); HY=$(uuid_of "P10B-Y" 2)
gurl "things:///add?title=P10B-X1&list-id=$PROJ_PLAIN&heading=P10B-X"
gurl "things:///add?title=P10B-X2&list-id=$PROJ_PLAIN&heading=P10B-X"
gurl "things:///add?title=P10B-Y1&list-id=$PROJ_PLAIN&heading=P10B-Y"
X1=$(uuid_of "P10B-X1" 0); Y1=$(uuid_of "P10B-Y1" 0)
state() { gsql "SELECT title, type, status, trashed, project, heading FROM TMTask WHERE uuid IN ('$HX','$HY') OR heading IN ('$HX','$HY') OR title LIKE 'P10B-%' ORDER BY type DESC, title" | tee -a "$REPORT"; }
note "-- pre:"; state

note "== [b1] ARCHIVE non-empty heading X: set status of to do id -> completed =="
gas "tell application \"Things3\" to set status of to do id \"$HX\" to completed" | tee -a "$REPORT"
sleep 1
note "-- post (children status? still headed?):"; state

note "== [b2] UN-ARCHIVE heading X: set status -> open =="
gas "tell application \"Things3\" to set status of to do id \"$HX\" to open" | tee -a "$REPORT"
sleep 1
note "-- post (clean round-trip?):"; state

note "== [b4] MOVE heading X: set project of to do id -> LAB-PROJ-HEADINGS =="
gas "tell application \"Things3\" to set project of to do id \"$HX\" to project id \"$PROJ_HEADINGS\"" | tee -a "$REPORT"
sleep 1
note "-- post (heading project changed? children follow?):"
gsql "SELECT title, type, status, project, heading FROM TMTask WHERE uuid='$HX' OR heading='$HX'" | tee -a "$REPORT"

note "== [b5] schedule / due date on heading Y (nonsense controls) =="
gas "tell application \"Things3\" to schedule to do id \"$HY\" for (current date) + 1 * days" | tee -a "$REPORT"
gas "tell application \"Things3\" to set due date of to do id \"$HY\" to (current date) + 2 * days" | tee -a "$REPORT"
sleep 1
gsql "SELECT title, status, startDate, deadline FROM TMTask WHERE uuid='$HY'" | tee -a "$REPORT"

note "== [b6] rename #2 + rename an ARCHIVED heading =="
gas "tell application \"Things3\" to set name of to do id \"$HY\" to \"P10B-Y-RENAMED\"" | tee -a "$REPORT"
gas "tell application \"Things3\" to set status of to do id \"$HY\" to completed" | tee -a "$REPORT"
sleep 1
gas "tell application \"Things3\" to set name of to do id \"$HY\" to \"P10B-Y-RENAMED-ARCHIVED\"" | tee -a "$REPORT"
sleep 1
gsql "SELECT title, status FROM TMTask WHERE uuid='$HY'" | tee -a "$REPORT"

note "== [b3] DELETE heading X via AS delete to do id (children fate!) =="
note "-- pre:"; state
gas "tell application \"Things3\" to delete to do id \"$HX\"" | tee -a "$REPORT"
sleep 2
note "-- post (heading trashed/removed? children re-parented/orphaned/trashed?):"
gsql "SELECT title, type, status, trashed, project, heading FROM TMTask WHERE uuid IN ('$HX','$X1') OR heading='$HX' OR title LIKE 'P10B-X%'" | tee -a "$REPORT"
note "-- and delete an EMPTY heading: create fresh, delete:"
proxy things-proxy-create-heading "{\"title\":\"P10B-Z\",\"project\":\"$PROJ_PLAIN\"}"
HZ=$(uuid_of "P10B-Z" 2)
gas "tell application \"Things3\" to delete to do id \"$HZ\"" | tee -a "$REPORT"
sleep 2
gsql "SELECT uuid, title, type, trashed FROM TMTask WHERE uuid='$HZ'" | tee -a "$REPORT"
note "-- (no row above = removed outright; trashed=1 = went to Trash)"

note "== copying DB out =="
lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/p10b.sqlite"'
lab_scp "$LAB_SSH_USER@$IP:/tmp/p10b.sqlite" "$OUT/final.sqlite" || true
note "GREEN — report: $REPORT"
trap - EXIT; cleanup
