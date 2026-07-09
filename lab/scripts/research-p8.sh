#!/bin/bash
# P8 — validate the two-call reorder protocol for the aggregate list scopes
# (the "stack-push above the original top" model inferred from A6/P6h/P7e),
# plus a 3-project when= bounce for top-level sidebar order. ONE clone.
#
# Model under test: `reorder to dos in list "<L>" with ids s1..sn` moves each
# si ABOVE THE ORIGINAL TOP of the scope, stacking upward (later = higher);
# an si that IS the original top never moves. Protocol: to realize desired
# top-first order d1..dn — call 1: ids "dn" (push desired-bottom to top);
# call 2: ids "dn,dn-1,…,d1" (dn is now the anchor and stays put; the rest
# stack above it in desired order). Expected: exact d1..dn.
#   P8a  Inbox, 4 to-dos, desired = a shuffle.
#   P8b  Someday, 4 loose to-dos.
#   P8c  Someday, 3 area-less someday PROJECTS (sidebar rows).
#   P8d  Anytime, 4 loose active to-dos.
#   P8e  BOUNCE 3 top-level projects into a chosen order via
#        when=someday -> when=anytime round-trips in REVERSE desired order.
# Discovery: no assertions (the report shows exact final orders).
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-p8-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[p8] $*" | tee -a "$REPORT"; }
cleanup() { echo "[p8] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

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
uuid_of() { local t="$1" typ="${2:-}" w="title='$1' AND trashed=0" u i; [ -n "$typ" ] && w="$w AND type=$typ"; for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }
# two_call <list-name> <desired top-first csv d1..dn>
two_call() {
  local list="$1" csv="$2"
  local last="${csv##*,}"
  local rev; rev=$(echo "$csv" | tr ',' '\n' | tail -r | paste -sd, -)
  note "-- two-call protocol in list \"$list\": call1 ids=$last; call2 ids=$rev"
  gas "tell application \"Things3\"
  _private_experimental_ reorder to dos in list \"$list\" with ids \"$last\"
  _private_experimental_ reorder to dos in list \"$list\" with ids \"$rev\"
end tell" | tee -a "$REPORT"
  sleep 2
}

note "warm-up: launch Things, quit, relaunch"
lab_ssh "$IP" 'open -g -a Things3; sleep 12'
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3'
lab_ssh "$IP" 'open -g -a Things3; sleep 8'
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
gupd() { gurl "things:///update-project?id=$1&auth-token=$TOKEN&$2"; }

# ---------------------------------------------------------------- P8a inbox
note "== [P8a] INBOX: 4 to-dos, desired shuffle =="
for t in P8-IN-1 P8-IN-2 P8-IN-3 P8-IN-4; do gurl "things:///add?title=$t&list=inbox"; done
I1=$(uuid_of P8-IN-1 0); I2=$(uuid_of P8-IN-2 0); I3=$(uuid_of P8-IN-3 0); I4=$(uuid_of P8-IN-4 0)
in_rows() { gsql "SELECT title, \"index\" FROM TMTask WHERE uuid IN ('$I1','$I2','$I3','$I4') ORDER BY \"index\"" | tee -a "$REPORT"; }
note "-- pre:"; in_rows
note "-- desired: P8-IN-3, P8-IN-1, P8-IN-4, P8-IN-2"
two_call "Inbox" "$I3,$I1,$I4,$I2"
note "-- post (want 3,1,4,2):"; in_rows

# ---------------------------------------------------------------- P8b someday to-dos
note "== [P8b] SOMEDAY: 4 loose to-dos =="
for t in P8-SD-1 P8-SD-2 P8-SD-3 P8-SD-4; do gurl "things:///add?title=$t&when=someday"; done
S1=$(uuid_of P8-SD-1 0); S2=$(uuid_of P8-SD-2 0); S3=$(uuid_of P8-SD-3 0); S4=$(uuid_of P8-SD-4 0)
sd_rows() { gsql "SELECT title, \"index\" FROM TMTask WHERE uuid IN ('$S1','$S2','$S3','$S4') ORDER BY \"index\"" | tee -a "$REPORT"; }
note "-- pre:"; sd_rows
note "-- desired: P8-SD-2, P8-SD-4, P8-SD-1, P8-SD-3"
two_call "Someday" "$S2,$S4,$S1,$S3"
note "-- post (want 2,4,1,3):"; sd_rows

# ---------------------------------------------------------------- P8c someday projects
note "== [P8c] SOMEDAY: 3 area-less someday PROJECTS (sidebar rows) =="
for t in P8-SP-1 P8-SP-2 P8-SP-3; do gurl "things:///add-project?title=$t&when=someday"; done
Q1=$(uuid_of P8-SP-1 1); Q2=$(uuid_of P8-SP-2 1); Q3=$(uuid_of P8-SP-3 1)
sp_rows() { gsql "SELECT title, \"index\" FROM TMTask WHERE uuid IN ('$Q1','$Q2','$Q3') ORDER BY \"index\"" | tee -a "$REPORT"; }
note "-- pre:"; sp_rows
note "-- desired: P8-SP-3, P8-SP-2, P8-SP-1"
two_call "Someday" "$Q3,$Q2,$Q1"
note "-- post (want 3,2,1):"; sp_rows

# ---------------------------------------------------------------- P8d anytime loose to-dos
note "== [P8d] ANYTIME: 4 loose active to-dos =="
for t in P8-AN-1 P8-AN-2 P8-AN-3 P8-AN-4; do gurl "things:///add?title=$t"; done
A1=$(uuid_of P8-AN-1 0); A2=$(uuid_of P8-AN-2 0); A3=$(uuid_of P8-AN-3 0); A4=$(uuid_of P8-AN-4 0)
an_rows() { gsql "SELECT title, \"index\" FROM TMTask WHERE uuid IN ('$A1','$A2','$A3','$A4') ORDER BY \"index\"" | tee -a "$REPORT"; }
note "-- pre:"; an_rows
note "-- desired: P8-AN-4, P8-AN-2, P8-AN-3, P8-AN-1"
two_call "Anytime" "$A4,$A2,$A3,$A1"
note "-- post (want 4,2,3,1):"; an_rows

# ---------------------------------------------------------------- P8e project sidebar bounce
note "== [P8e] BOUNCE 3 top-level projects to a chosen order via when= round-trips =="
for t in P8-TP-1 P8-TP-2 P8-TP-3; do gurl "things:///add-project?title=$t"; done
T1=$(uuid_of P8-TP-1 1); T2=$(uuid_of P8-TP-2 1); T3=$(uuid_of P8-TP-3 1)
tp_rows() { gsql "SELECT title, start, startDate, \"index\" FROM TMTask WHERE uuid IN ('$T1','$T2','$T3') ORDER BY \"index\"" | tee -a "$REPORT"; }
note "-- pre:"; tp_rows
note "-- desired: P8-TP-2, P8-TP-3, P8-TP-1 -> bounce reverse order: TP-1, TP-3, TP-2"
for U in "$T1" "$T3" "$T2"; do
  gupd "$U" "when=someday"; sleep 1
  gupd "$U" "when=anytime"; sleep 1
done
note "-- post (want 2,3,1; start should be 1/anytime, startDate NULL for all):"; tp_rows

note "== copying DB out =="
lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/p8.sqlite"'
lab_scp "$LAB_SSH_USER@$IP:/tmp/p8.sqlite" "$OUT/final.sqlite" || true
note "GREEN — report: $REPORT"
trap - EXIT; cleanup
