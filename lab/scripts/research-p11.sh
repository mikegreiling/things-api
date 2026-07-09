#!/bin/bash
# P11 — heading-ops design inputs + resolution-state recovery (Mike, 2026-07-09).
# ONE clone, autonomous.
#   a  SOMEDAY-status recovery: complete a someday to-do, reopen it — does
#      start=2 survive the round-trip (URL and AS)? Same for cancel. Feeds
#      heading.unarchive AND the existing project.reopen restore (suspected
#      gap: restored children may lose someday).
#   b  Heading TRASH via `move to do id <heading> to list "Trash"` — the
#      delete verb fails (-1728) but this spelling is unprobed. Children fate?
#   c  Heading CANCEL: `set status ... to canceled` — works? cascades?
#   d  Archive cascade vs already-resolved children: heading with one OPEN,
#      one CANCELED child -> archive: is the canceled child overwritten to
#      completed or left alone (P01 analog)?
#   e  CRASH VERIFICATION for oddities §6: PID watch + DiagnosticReports scan
#      around `schedule to do id <heading>`.
# Discovery: no assertions.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-p11-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[p11] $*" | tee -a "$REPORT"; }
cleanup() { echo "[p11] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

PROJ_PLAIN="933TCvzMgM3MLvpKPcjheC"

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
gupd() { gurl "things:///update?id=$1&auth-token=$TOKEN&$2"; }

# ---------------------------------------------------------------- a) someday recovery
note "== [P11a] someday-status recovery through complete/cancel round-trips =="
gurl "things:///add?title=P11-SD-URL&when=someday"
gurl "things:///add?title=P11-SD-AS&when=someday"
gurl "things:///add?title=P11-SD-CANCEL&when=someday"
SU=$(uuid_of P11-SD-URL 0); SA=$(uuid_of P11-SD-AS 0); SCN=$(uuid_of P11-SD-CANCEL 0)
sd_state() { gsql "SELECT title, status, start, startDate FROM TMTask WHERE uuid IN ('$SU','$SA','$SCN') ORDER BY title" | tee -a "$REPORT"; }
note "-- pre (all start=2):"; sd_state
note "-- complete via URL, complete via AS, cancel via URL:"
gupd "$SU" "completed=true"
gas "tell application \"Things3\" to set status of to do id \"$SA\" to completed" | tee -a "$REPORT"
gupd "$SCN" "canceled=true"
sleep 1
note "-- post-resolve (does start stay 2 while logged?):"; sd_state
note "-- reopen all three (URL completed=false / AS open / URL canceled=false):"
gupd "$SU" "completed=false"
gas "tell application \"Things3\" to set status of to do id \"$SA\" to open" | tee -a "$REPORT"
gupd "$SCN" "canceled=false"
sleep 1
note "-- post-reopen (SOMEDAY preserved? start=2 startDate NULL = yes):"; sd_state

# ---------------------------------------------------------------- b) heading trash via move
note "== [P11b] heading TRASH via move to list \"Trash\" (delete verb fails -1728; this spelling unprobed) =="
proxy things-proxy-create-heading "{\"title\":\"P11-HT\",\"project\":\"$PROJ_PLAIN\"}"
HT=$(uuid_of P11-HT 2)
gurl "things:///add?title=P11-HT-C1&list-id=$PROJ_PLAIN&heading=P11-HT"
ht_state() { gsql "SELECT title, type, status, trashed, project, heading FROM TMTask WHERE uuid='$HT' OR heading='$HT' OR title LIKE 'P11-HT%'" | tee -a "$REPORT"; }
note "-- pre:"; ht_state
gas "tell application \"Things3\" to move to do id \"$HT\" to list \"Trash\"" | tee -a "$REPORT"
sleep 2
note "-- post (heading trashed? children fate?):"; ht_state

# ---------------------------------------------------------------- c) heading cancel
note "== [P11c] heading CANCEL: set status to canceled — works? cascades? =="
proxy things-proxy-create-heading "{\"title\":\"P11-HC\",\"project\":\"$PROJ_PLAIN\"}"
HC=$(uuid_of P11-HC 2)
gurl "things:///add?title=P11-HC-C1&list-id=$PROJ_PLAIN&heading=P11-HC"
hc_state() { gsql "SELECT title, type, status, trashed FROM TMTask WHERE uuid='$HC' OR heading='$HC'" | tee -a "$REPORT"; }
note "-- pre:"; hc_state
gas "tell application \"Things3\" to set status of to do id \"$HC\" to canceled" | tee -a "$REPORT"
sleep 1
note "-- post (heading canceled? child cascaded — to canceled or completed?):"; hc_state
gas "tell application \"Things3\" to set status of to do id \"$HC\" to open" | tee -a "$REPORT"
sleep 1
note "-- post un-cancel:"; hc_state

# ---------------------------------------------------------------- d) archive vs pre-canceled child
note "== [P11d] archive cascade vs already-CANCELED child (P01 analog) =="
proxy things-proxy-create-heading "{\"title\":\"P11-HD\",\"project\":\"$PROJ_PLAIN\"}"
HD=$(uuid_of P11-HD 2)
gurl "things:///add?title=P11-HD-OPEN&list-id=$PROJ_PLAIN&heading=P11-HD"
gurl "things:///add?title=P11-HD-CANC&list-id=$PROJ_PLAIN&heading=P11-HD"
DC=$(uuid_of P11-HD-CANC 0)
gupd "$DC" "canceled=true"
sleep 1
hd_state() { gsql "SELECT title, type, status, stopDate FROM TMTask WHERE uuid='$HD' OR heading='$HD'" | tee -a "$REPORT"; }
note "-- pre (one open, one canceled):"; hd_state
gas "tell application \"Things3\" to set status of to do id \"$HD\" to completed" | tee -a "$REPORT"
sleep 1
note "-- post archive (canceled child overwritten to completed, or left canceled?):"; hd_state

# ---------------------------------------------------------------- e) crash verification
note "== [P11e] CRASH VERIFICATION: schedule on a heading row (oddities §6) =="
proxy things-proxy-create-heading "{\"title\":\"P11-HX\",\"project\":\"$PROJ_PLAIN\"}"
HX=$(uuid_of P11-HX 2)
PID_BEFORE=$(lab_ssh "$IP" 'pgrep -x Things3 | head -1' || true)
note "-- Things PID before: $PID_BEFORE"
lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | wc -l' | tee -a "$REPORT"
gas "tell application \"Things3\" to schedule to do id \"$HX\" for (current date) + 1 * days" | tee -a "$REPORT"
sleep 4
PID_AFTER=$(lab_ssh "$IP" 'pgrep -x Things3 | head -1' || true)
note "-- Things PID after: ${PID_AFTER:-<none — process dead>} (before: $PID_BEFORE)"
note "-- new DiagnosticReports:"
lab_ssh "$IP" 'ls -t ~/Library/Logs/DiagnosticReports/ 2>/dev/null | head -3' | tee -a "$REPORT"
note "-- heading row unchanged?"
gsql "SELECT title, status, startDate FROM TMTask WHERE uuid='$HX'" | tee -a "$REPORT"
if [ -n "$PID_BEFORE" ] && [ "$PID_BEFORE" != "${PID_AFTER:-}" ]; then
  note "-- CRASH CONFIRMED: process died/relaunched; copying newest .ips"
  lab_scp "$LAB_SSH_USER@$IP:Library/Logs/DiagnosticReports/$(lab_ssh "$IP" 'ls -t ~/Library/Logs/DiagnosticReports/ | head -1')" "$OUT/" 2>/dev/null || true
fi

note "== copying DB out =="
lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/p11.sqlite"'
lab_scp "$LAB_SSH_USER@$IP:/tmp/p11.sqlite" "$OUT/final.sqlite" || true
note "GREEN — report: $REPORT"
trap - EXIT; cleanup
