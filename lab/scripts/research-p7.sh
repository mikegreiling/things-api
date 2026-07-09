#!/bin/bash
# P7 — sidebar-reorder lateral thinking (Mike, 2026-07-09) + someday-scope
# convention lock. ONE clone, autonomous. Questions:
#   P7a  Does the Someday scope accept PROJECT uuids (class inheritance, like
#        headings in project scope / projects in area scope)? Someday projects
#        are sidebar rows — a hit here IS a sidebar write.
#   P7b  Does the Anytime scope reorder loose TO-DO uuids? (P17/P6d only
#        probed projects there; Someday works for to-dos — same "index"
#        column, so the difference must be the list handler.)
#   P7c  BOUNCE primitive: does clearing a project's area (update-project?
#        area-id= empty, P24) FRONT-INSERT it among top-level projects (P19
#        proved creation front-inserts)? And does attaching (P23) front-insert
#        within the area? If yes, an area round-trip = sidebar reorder.
#   P7d  Does a when=someday -> when=anytime round-trip front-insert a
#        project's "index"?
#   P7e  Someday-scope wire convention lock: 3 to-dos, one reorder call,
#        requested order vs stored "index" (Inbox needed the REVERSED list).
# Discovery: no assertions.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-p7-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[p7] $*" | tee -a "$REPORT"; }
cleanup() { echo "[p7] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

AREA_A="7Ck4hAXU36jyaBsy2Fkije"   # LAB-AREA-A
SOMEDAY_1="U9Ho5HiBsXAfEVte9rrPm2" # LAB-SOMEDAY-1

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
uuid_of() { local t="$1" typ="${2:-}" w="title='$1' AND trashed=0" u i; [ -n "$typ" ] && w="$w AND type=$typ"; for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }

note "warm-up: launch Things, quit, relaunch"
lab_ssh "$IP" 'open -g -a Things3; sleep 12'
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3'
lab_ssh "$IP" 'open -g -a Things3; sleep 8'

TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
note "auth token in hand (${#TOKEN} chars)"
gupd() { gurl "things:///update-project?id=$1&auth-token=$TOKEN&$2"; }

# ============================ P7a — Someday scope + PROJECT uuids
note "== [P7a] private reorder: PROJECT uuids in list \"Someday\" (someday projects = sidebar rows) =="
gurl "things:///add-project?title=P7-SDPROJ-A&when=someday"
gurl "things:///add-project?title=P7-SDPROJ-B&when=someday"
SPA=$(uuid_of "P7-SDPROJ-A" 1); SPB=$(uuid_of "P7-SDPROJ-B" 1)
sd_projs() { gsql "SELECT uuid, title, start, startDate, \"index\" FROM TMTask WHERE type=1 AND uuid IN ('$SPA','$SPB') ORDER BY \"index\"" | tee -a "$REPORT"; }
note "-- pre:"; sd_projs
gas "tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Someday\" with ids \"$SPA,$SPB\"" | tee -a "$REPORT"
sleep 2
note "-- post (did either index change?):"; sd_projs

# ============================ P7b — Anytime scope + loose TO-DO uuids
note "== [P7b] private reorder: loose TO-DO uuids in list \"Anytime\" =="
gurl "things:///add?title=P7-ANY-A"
gurl "things:///add?title=P7-ANY-B"
AA=$(uuid_of "P7-ANY-A" 0); AB=$(uuid_of "P7-ANY-B" 0)
any_todos() { gsql "SELECT uuid, title, \"index\" FROM TMTask WHERE uuid IN ('$AA','$AB') ORDER BY \"index\"" | tee -a "$REPORT"; }
note "-- pre:"; any_todos
gas "tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Anytime\" with ids \"$AA,$AB\"" | tee -a "$REPORT"
sleep 2
note "-- post:"; any_todos
note "-- control: same two uuids in list \"Someday\" scope should REJECT or no-op (they are anytime):"
gas "tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Someday\" with ids \"$AA,$AB\"" | tee -a "$REPORT"
sleep 1; any_todos

# ============================ P7c — area detach/attach bounce primitive
note "== [P7c] BOUNCE: does area DETACH front-insert among top-level projects? =="
gurl "things:///add-project?title=P7-TOP-1"
gurl "things:///add-project?title=P7-TOP-2"
T1=$(uuid_of "P7-TOP-1" 1); T2=$(uuid_of "P7-TOP-2" 1)
top_projs() { gsql "SELECT uuid, title, area, \"index\" FROM TMTask WHERE type=1 AND trashed=0 AND status=0 AND (uuid IN ('$T1','$T2') OR area IS NULL) ORDER BY \"index\"" | tee -a "$REPORT"; }
note "-- pre (P7-TOP-2 was created last, so it should sit ABOVE P7-TOP-1 per P19 front-insert):"
top_projs
note "-- bounce P7-TOP-1: attach to LAB-AREA-A (P23), then detach (P24):"
gupd "$T1" "area-id=$AREA_A"
note "-- mid (inside the area — note its within-area index):"
gsql "SELECT uuid, title, area, \"index\" FROM TMTask WHERE uuid='$T1'" | tee -a "$REPORT"
gsql "SELECT uuid, title, \"index\" FROM TMTask WHERE type=1 AND area='$AREA_A' ORDER BY \"index\"" | tee -a "$REPORT"
gupd "$T1" "area-id="
note "-- post (did P7-TOP-1 FRONT-INSERT above P7-TOP-2?):"
top_projs

note "== [P7c2] does area ATTACH front-insert within the area? =="
note "-- pre, LAB-AREA-A projects:"
gsql "SELECT uuid, title, \"index\" FROM TMTask WHERE type=1 AND area='$AREA_A' AND trashed=0 ORDER BY \"index\"" | tee -a "$REPORT"
gupd "$T2" "area-id=$AREA_A"
note "-- post-attach (is P7-TOP-2 at the top of the area block?):"
gsql "SELECT uuid, title, \"index\" FROM TMTask WHERE type=1 AND area='$AREA_A' AND trashed=0 ORDER BY \"index\"" | tee -a "$REPORT"
gupd "$T2" "area-id="

# ============================ P7d — when=someday/anytime round-trip
note "== [P7d] project when=someday -> when=anytime round-trip: does re-activation front-insert? =="
note "-- pre:"; top_projs
gupd "$T1" "when=someday"
sleep 1
gsql "SELECT uuid, title, start, startDate, \"index\" FROM TMTask WHERE uuid='$T1'" | tee -a "$REPORT"
gupd "$T1" "when=anytime"
sleep 1
note "-- post round-trip (index changed? front-inserted?):"
top_projs

# ============================ P7e — someday-scope convention lock (3 items)
note "== [P7e] someday-scope wire convention: 3 to-dos, request C,A,B =="
gurl "things:///add?title=P7-SOME-A&when=someday"
gurl "things:///add?title=P7-SOME-B&when=someday"
gurl "things:///add?title=P7-SOME-C&when=someday"
SA=$(uuid_of "P7-SOME-A" 0); SB=$(uuid_of "P7-SOME-B" 0); SC=$(uuid_of "P7-SOME-C" 0)
some_todos() { gsql "SELECT title, \"index\" FROM TMTask WHERE uuid IN ('$SA','$SB','$SC','$SOMEDAY_1') ORDER BY \"index\"" | tee -a "$REPORT"; }
note "-- pre:"; some_todos
note "-- request order C,A,B (forward wire):"
gas "tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Someday\" with ids \"$SC,$SA,$SB\"" | tee -a "$REPORT"
sleep 2
note "-- post (stored ascending-index order = ? — if it reads B,A,C the wire is REVERSED like Inbox A6):"
some_todos
note "-- second call, FULL list incl. LAB-SOMEDAY-1, request A,B,C,LAB (forward):"
gas "tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Someday\" with ids \"$SA,$SB,$SC,$SOMEDAY_1\"" | tee -a "$REPORT"
sleep 2
note "-- post:"; some_todos

note "== copying DB out =="
lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/p7.sqlite"'
lab_scp "$LAB_SSH_USER@$IP:/tmp/p7.sqlite" "$OUT/final.sqlite" || true
note "GREEN — report: $REPORT"
trap - EXIT; cleanup
