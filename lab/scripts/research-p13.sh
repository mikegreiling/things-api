#!/bin/bash
# P13 — Anytime loose-to-do reorder convention (the one unresolved scope).
# P7b: the Anytime scope MOVES loose to-dos; P8d: the two-call protocol
# result matched NEITHER the ascending (Someday to-do) nor descending
# (Someday project) model. This series isolates the convention with
# single-call trials whose predicted post-orders differ per model. ONE clone.
#
# Models (stored ASCENDING-index order after one call `with ids d1..dn`):
#   FORWARD (container/inbox):  d1,d2,…,dn
#   REVERSED (none seen yet):   dn,…,d2,d1
#   ANCHOR-ASC (someday todo):  original-top stays; others stack ABOVE it,
#                               later-sent higher -> sent order inverts above
#   ANCHOR-DESC (someday proj): original-top stays; others stack ABOVE it,
#                               earlier-sent higher
#   NO-OP:                      unchanged
# Discovery: no assertions.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-p13-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[p13] $*" | tee -a "$REPORT"; }
cleanup() { echo "[p13] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
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
uuid_of() { local t="$1" u i; for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND type=0 ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }
reorder_anytime() { gas "tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Anytime\" with ids \"$1\"" | tee -a "$REPORT"; sleep 2; }

note "warm-up"
lab_ssh "$IP" 'open -g -a Things3; sleep 12'
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3'
lab_ssh "$IP" 'open -g -a Things3; sleep 8'

# 4 loose anytime to-dos, created in order 1..4 (each front-inserts, so
# creation leaves stored order 4,3,2,1). Capture the real starting order.
for t in P13-A P13-B P13-C P13-D; do gurl "things:///add?title=$t"; done
A=$(uuid_of P13-A); B=$(uuid_of P13-B); C=$(uuid_of P13-C); D=$(uuid_of P13-D)
rows() { gsql "SELECT title, \"index\" FROM TMTask WHERE uuid IN ('$A','$B','$C','$D') ORDER BY \"index\"" | tee -a "$REPORT"; }
note "== labels: A=$A B=$B C=$C D=$D =="
note "-- pre (creation front-insert => expect stored D,C,B,A):"; rows

note "== [T1] single call, full list, request A,B,C,D =="
note "   FORWARD->A,B,C,D | REVERSED->D,C,B,A | ANCHOR-ASC(top=D stays last)->? | NO-OP->D,C,B,A"
reorder_anytime "$A,$B,$C,$D"
note "-- post:"; rows

note "== [T2] single call, full list, request C,A,D,B (shuffle) =="
note "   FORWARD->C,A,D,B | REVERSED->B,D,A,C"
reorder_anytime "$C,$A,$D,$B"
note "-- post:"; rows

note "== [T3] PARTIAL call, request just [B] (isolates anchor/move-to-top) =="
note "   FORWARD/top-insert->B first | anchor(B becomes/for-top) | NO-OP->unchanged"
reorder_anytime "$B"
note "-- post:"; rows

note "== [T4] PARTIAL call, request [D,A] after T3 =="
reorder_anytime "$D,$A"
note "-- post:"; rows

note "== [T5] repeat the exact same call twice (idempotent? or drifts?) =="
reorder_anytime "$A,$B,$C,$D"
note "-- post call-1:"; rows
reorder_anytime "$A,$B,$C,$D"
note "-- post call-2 (identical = stable/idempotent):"; rows

note "== copying DB out =="
lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/p13.sqlite"'
lab_scp "$LAB_SSH_USER@$IP:/tmp/p13.sqlite" "$OUT/final.sqlite" || true
note "GREEN — report: $REPORT"
trap - EXIT; cleanup
