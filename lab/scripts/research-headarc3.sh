#!/bin/bash
# HEADARC3 — the ORDERING law for logged children in the project view,
# discriminated with MULTI-DAY stopDates. HEADARC2's same-day capture
# ("most-recently-completed first") cannot tell stopDate DESC from
# date-DESC-then-index-ASC from index-ASC; a multi-day fixture + a same-day
# anti-tiebreak pair can.
#
# Fixture (LAB-AREA-A): project HA3-Foo-P, heading "Foo", children in INDEX
# order A,B,C,D,E. Completion schedule (guest clock advanced between days):
#   day1 2026-07-05 : complete B          (idx1)
#   day2 2026-07-06 : complete C          (idx2)
#   day3 2026-07-07 : complete A          (idx0)   <- maintainer's B,C,A across 3 days
#   day4 2026-07-08 : complete D then E   (idx3,idx4, INDEX-ORDER completion so
#                     stopDate(D)<stopDate(E) => a within-day stopDate-DESC law
#                     shows E,D (reverse index) while an index-ASC law shows D,E
#                     — the discriminating same-day pair)
#   day5 2026-07-09 : no completion; relaunch to force the final log-sweep, then
#                     the GUI-capture phase runs (separate, headarc3-gui.sh).
#
# This script builds the fixture + completes across days + records byte evidence
# (stopDate + index per row before/after every completion) and LEAVES THE VM UP
# for the GUI phase. Golden things-lab-golden-v1 · Things 3.22.11 · pinned start
# 2026-07-05. Discovery: DB row deltas are ground truth; no assertions.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

AREA_A="7Ck4hAXU36jyaBsy2Fkije"   # LAB-AREA-A (golden seed)
VM="headarc3-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[headarc3] $*" | tee -a "$REPORT"; }

: > "$REPORT"
note "cloning golden -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
note "ssh up at $IP"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
note "vnc url: ${VNC_URL:-<none>}"

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo route -n delete -inet6 default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo airgapped' </dev/null | tee -a "$REPORT"
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null; date' </dev/null | tee -a "$REPORT"

lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gsql() { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" </dev/null; }
gq()   { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gas()  { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" </dev/null || true; }
gurl() { lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; sleep 2; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
warm()   { lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null; }
setday() { settle; lab_ssh "$IP" "sudo date $1 >/dev/null" </dev/null; note "  clock -> $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"; warm; }
uuid_of() { local t="$1" u i; for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE title='$t' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }
# full byte row for every fixture task, ORDERED BY index (the created order)
snap() { gsql "SELECT title, type, status, stopDate, \"index\" idx, substr(heading,1,8) head FROM TMTask WHERE project=(SELECT uuid FROM TMTask WHERE title='HA3-Foo-P' AND type=1 AND trashed=0) OR uuid=(SELECT uuid FROM TMTask WHERE title='HA3-Foo-P' AND type=1 AND trashed=0) ORDER BY type DESC, \"index\"" | tee -a "$REPORT"; }

note "warm-up: launch/quit/relaunch Things on pinned day1"
warm; settle; warm
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
note "token ok (${#TOKEN})"

########################################################################
note ""; note "############### FIXTURE (things:///json, heading Foo + A..E index order) ###############"
JSON='[{"type":"project","attributes":{"title":"HA3-Foo-P","area-id":"'$AREA_A'","items":['
JSON+='{"type":"heading","attributes":{"title":"Foo"}},'
JSON+='{"type":"to-do","attributes":{"title":"A"}},'
JSON+='{"type":"to-do","attributes":{"title":"B"}},'
JSON+='{"type":"to-do","attributes":{"title":"C"}},'
JSON+='{"type":"to-do","attributes":{"title":"D"}},'
JSON+='{"type":"to-do","attributes":{"title":"E"}}]}}]'
ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$JSON")
lab_ssh "$IP" "open 'things:///json?data=$ENC&auth-token=$TOKEN'; sleep 4" </dev/null
P=$(gq "SELECT uuid FROM TMTask WHERE title='HA3-Foo-P' AND type=1 AND trashed=0")
FOO=$(gq "SELECT uuid FROM TMTask WHERE title='Foo' AND type=2 AND trashed=0")
A=$(uuid_of A); B=$(uuid_of B); C=$(uuid_of C); D=$(uuid_of D); E=$(uuid_of E)
note "P=$P FOO=$FOO"
note "A=$A B=$B C=$C D=$D E=$E"
{ echo "IP=$IP"; echo "VNC_URL=$VNC_URL"; echo "TOKEN=$TOKEN"; echo "P=$P"; echo "FOO=$FOO";
  echo "A=$A"; echo "B=$B"; echo "C=$C"; echo "D=$D"; echo "E=$E"; } > "$SESSION"
note "-- BEFORE any completion (index order A<B<C<D<E, all headed under Foo, all open):"; snap

complete() { # $1 uuid  $2 title
  gurl "things:///update?id=$1&completed=true&auth-token=$TOKEN"
  lab_ssh "$IP" "for i in \$(seq 1 10); do S=\$(/tmp/gsql.sh -q \"SELECT status FROM TMTask WHERE uuid='$1'\"); [ \"\$S\" = 3 ] && break; sleep 1; done" </dev/null
  note "   completed $2 -> $(gq "SELECT title||' status='||status||' stopDate='||COALESCE(stopDate,'NULL') FROM TMTask WHERE uuid='$1'")"
}

########################################################################
note ""; note "############### DAY1 2026-07-05 — complete B (idx1) ###############"
complete "$B" B; snap

note ""; note "############### DAY2 2026-07-06 — complete C (idx2) ###############"
setday 070612002026; complete "$C" C; snap

note ""; note "############### DAY3 2026-07-07 — complete A (idx0) ###############"
setday 070712002026; complete "$A" A; snap

note ""; note "############### DAY4 2026-07-08 — complete D then E (idx3,idx4 same day, index order) ###############"
setday 070812002026
complete "$D" D; sleep 3; complete "$E" E; snap

note ""; note "############### DAY5 2026-07-09 — force final sweep (relaunch, no completion) ###############"
setday 070912002026
lab_ssh "$IP" "open 'things:///show?id=today'; sleep 4; open 'things:///show?id=logbook'; sleep 4" </dev/null
note "-- FINAL byte state (stopDate DESC = A? then... ; check index vs stopDate):"; snap
note "-- stopDate-sorted view (what a pure stopDate-DESC law would render top->bottom):"
gsql "SELECT title, stopDate, \"index\" idx FROM TMTask WHERE heading='$FOO' AND status=3 ORDER BY stopDate DESC" | tee -a "$REPORT"

note ""; note "== crash check =="
lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo "Things3 ALIVE" || echo "Things3 DEAD"' </dev/null | tee -a "$REPORT"
lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | grep -i things || echo "no Things crash reports"' </dev/null | tee -a "$REPORT"
note "BUILD DONE — VM $VM left UP for the GUI phase. session: $SESSION"
note "next: lab/scripts/headarc3-gui.sh  (needs VNCDO=/path/to/vncdo for the toggle click)"
