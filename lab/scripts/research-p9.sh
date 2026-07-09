#!/bin/bash
# P9 — native (non-bounce) ordering pursuit + doctrine inputs (Mike, 2026-07-09).
# ONE clone, autonomous.
#
# Sdef facts feeding this design (host inspection): the private command's
# direct parameter is a bare `specifier`; `responds-to` is declared on class
# `list` (inherited by `area` and `contact`) and class `project`. TMArea
# ."index" on PROD carries real distinct sidebar values, so area order IS
# that column — the question is purely what writes it.
#
#   P9a  Discovery: enumerate `every list` (names + ids) — any hidden root/
#        sidebar list whose members could be areas or top-level projects?
#   P9b  Area creation position: does `make new area` front-insert on
#        TMArea."index"?
#   P9c  Area reorder spellings: application specifier (`it`), named lists
#        with area uuids (Anytime single + two-call, Someday), area-in-area.
#   P9d  Top-level ANYTIME projects, native retries: application specifier,
#        two-call in list "Anytime".
#   P9e  SOMEDAY PROJECTS characterization — the lockable native scope.
#        Inverted-stack hypothesis from P7a/P8c: anchor = original top,
#        never moves; other sent ids land above the original top with each
#        SUBSEQUENT one placed BELOW the previous (descending stack; to-dos
#        stack ASCENDING). Protocol under test: call1 [d_n]; call2
#        [d_n, d1, d2, …, d_{n-1}] (anchor first, then FORWARD desired).
#        Two full trials + one partial-list trial.
#   P9f  Doctrine input — heading emptying: does moving a headed child to the
#        project root (update?list-id=<project>) clear its heading FK? Can
#        the emptied heading be renamed to "" headlessly (Shortcuts
#        edit-title, output-class consent)? A benign-empty heading would be
#        the headless "soft delete" story.
# Discovery: no assertions.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-p9-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[p9] $*" | tee -a "$REPORT"; }
cleanup() { echo "[p9] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

AREA_A="7Ck4hAXU36jyaBsy2Fkije"    # LAB-AREA-A
AREA_B="2piYxp6UzasLDSvkwY747J"    # LAB-AREA-B
PROJ_HEADINGS="Dwr1MiANqMFvAWddgGgzVX"
ALPHA="5saDdJcodvWARN9Ct2nQsT"     # heading with children
H_A1="A4iVBLBVuybv9GLYnFaCos"      # child under Alpha

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
proxy() { # proxy <name> <json>
  note "-- shortcuts run $1  $2"
  lab_ssh "$IP" "printf '%s' $(printf '%q' "$2") > /tmp/p9-in.json; rm -f /tmp/p9-out.txt; perl -e 'alarm 60; exec @ARGV' shortcuts run $(printf '%q' "$1") --input-path /tmp/p9-in.json --output-path /tmp/p9-out.txt 2>&1; echo \"[exit \$?]\"; cat /tmp/p9-out.txt 2>/dev/null; echo" 2>&1 | tee -a "$REPORT" || true
  sleep 1
}
uuid_of() { local t="$1" typ="${2:-}" w="title='$1' AND trashed=0" u i; [ -n "$typ" ] && w="$w AND type=$typ"; for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }
reorder_in() { # reorder_in <specifier-AS-source> <csv>
  gas "tell application \"Things3\" to _private_experimental_ reorder to dos in $1 with ids \"$2\"" | tee -a "$REPORT"
  sleep 2
}

note "warm-up: launch Things, quit, relaunch"
lab_ssh "$IP" 'open -g -a Things3; sleep 12'
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3'
lab_ssh "$IP" 'open -g -a Things3; sleep 8'
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
note "auth token in hand (${#TOKEN} chars)"

areas() { gsql "SELECT uuid, title, \"index\" FROM TMArea ORDER BY \"index\", uuid" | tee -a "$REPORT"; }

# ---------------------------------------------------------------- P9a lists
note "== [P9a] discovery: every list (names, ids) =="
gas 'tell application "Things3" to get name of every list' | tee -a "$REPORT"
gas 'tell application "Things3" to get id of every list' | tee -a "$REPORT"
note "-- count of lists:"
gas 'tell application "Things3" to count of lists' | tee -a "$REPORT"

# ---------------------------------------------------------------- P9b area creation position
note "== [P9b] area creation position on TMArea.index =="
note "-- pre:"; areas
gas 'tell application "Things3" to make new area with properties {name:"P9-AREA-C"}' | tee -a "$REPORT"
sleep 1
gas 'tell application "Things3" to make new area with properties {name:"P9-AREA-D"}' | tee -a "$REPORT"
sleep 1
note "-- post (front-insert? end-append? untouched 0s?):"; areas
AREA_C=$(gq "SELECT uuid FROM TMArea WHERE title='P9-AREA-C'")
AREA_D=$(gq "SELECT uuid FROM TMArea WHERE title='P9-AREA-D'")
note "-- C=$AREA_C D=$AREA_D"

# ---------------------------------------------------------------- P9c area reorder spellings
note "== [P9c] area reorder spellings (sdef: direct param is a bare specifier) =="
note "-- [c1] application specifier ('it'):"
reorder_in "it" "$AREA_D,$AREA_B,$AREA_C,$AREA_A"
areas
note "-- [c2] list \"Anytime\", single call:"
reorder_in "list \"Anytime\"" "$AREA_D,$AREA_B,$AREA_C,$AREA_A"
areas
note "-- [c2b] list \"Anytime\", two-call (anchor protocol):"
gas "tell application \"Things3\"
  _private_experimental_ reorder to dos in list \"Anytime\" with ids \"$AREA_A\"
  _private_experimental_ reorder to dos in list \"Anytime\" with ids \"$AREA_A,$AREA_C,$AREA_B,$AREA_D\"
end tell" | tee -a "$REPORT"
sleep 2; areas
note "-- [c3] list \"Someday\" with area uuids:"
reorder_in "list \"Someday\"" "$AREA_D,$AREA_A"
areas
note "-- [c4] area-in-area (nonsense control):"
reorder_in "area id \"$AREA_A\"" "$AREA_B,$AREA_C"
areas

# ---------------------------------------------------------------- P9d anytime top-level projects
note "== [P9d] top-level ANYTIME projects, native retries =="
for t in P9-TP-1 P9-TP-2 P9-TP-3; do gurl "things:///add-project?title=$t"; done
T1=$(uuid_of P9-TP-1 1); T2=$(uuid_of P9-TP-2 1); T3=$(uuid_of P9-TP-3 1)
tops() { gsql "SELECT title, \"index\" FROM TMTask WHERE uuid IN ('$T1','$T2','$T3') ORDER BY \"index\"" | tee -a "$REPORT"; }
note "-- pre:"; tops
note "-- [d1] application specifier with project uuids:"
reorder_in "it" "$T2,$T1,$T3"
tops
note "-- [d2] list \"Anytime\" two-call with project uuids:"
gas "tell application \"Things3\"
  _private_experimental_ reorder to dos in list \"Anytime\" with ids \"$T3\"
  _private_experimental_ reorder to dos in list \"Anytime\" with ids \"$T3,$T2,$T1\"
end tell" | tee -a "$REPORT"
sleep 2; tops

# ---------------------------------------------------------------- P9e someday projects
note "== [P9e] SOMEDAY PROJECTS — inverted-stack characterization =="
for t in P9-SP-1 P9-SP-2 P9-SP-3 P9-SP-4; do gurl "things:///add-project?title=$t&when=someday"; done
Q1=$(uuid_of P9-SP-1 1); Q2=$(uuid_of P9-SP-2 1); Q3=$(uuid_of P9-SP-3 1); Q4=$(uuid_of P9-SP-4 1)
sps() { gsql "SELECT title, \"index\" FROM TMTask WHERE uuid IN ('$Q1','$Q2','$Q3','$Q4') ORDER BY \"index\"" | tee -a "$REPORT"; }
note "-- pre (creation order suggests 4 top):"; sps
note "-- [e1] partial single call [Q2,Q3] (observe anchor + stack direction):"
reorder_in "list \"Someday\"" "$Q2,$Q3"
sps
note "-- [e2] FULL two-call, inverted protocol — desired 3,1,4,2 -> call1 [Q2]; call2 [Q2,Q3,Q1,Q4]:"
gas "tell application \"Things3\"
  _private_experimental_ reorder to dos in list \"Someday\" with ids \"$Q2\"
  _private_experimental_ reorder to dos in list \"Someday\" with ids \"$Q2,$Q3,$Q1,$Q4\"
end tell" | tee -a "$REPORT"
sleep 2
note "-- post (want 3,1,4,2):"; sps
note "-- [e3] second trial — desired 1,2,3,4 -> call1 [Q4]; call2 [Q4,Q1,Q2,Q3]:"
gas "tell application \"Things3\"
  _private_experimental_ reorder to dos in list \"Someday\" with ids \"$Q4\"
  _private_experimental_ reorder to dos in list \"Someday\" with ids \"$Q4,$Q1,$Q2,$Q3\"
end tell" | tee -a "$REPORT"
sleep 2
note "-- post (want 1,2,3,4):"; sps
note "-- [e4] to-do-style ASCENDING protocol control — desired 4,3,2,1 -> call1 [Q1]; call2 [Q1,Q2,Q3,Q4] (reversed desired):"
gas "tell application \"Things3\"
  _private_experimental_ reorder to dos in list \"Someday\" with ids \"$Q1\"
  _private_experimental_ reorder to dos in list \"Someday\" with ids \"$Q1,$Q2,$Q3,$Q4\"
end tell" | tee -a "$REPORT"
sleep 2
note "-- post (ascending model predicts 4,3,2,1; descending predicts 2,3,4,1):"; sps

# ---------------------------------------------------------------- P9f heading emptying
note "== [P9f] doctrine: empty a heading headlessly, then rename it to \"\" =="
note "-- pre (Alpha's children):"
gsql "SELECT title, heading, project FROM TMTask WHERE heading='$ALPHA' OR uuid='$H_A1'" | tee -a "$REPORT"
note "-- move LAB-H-A1 to the project root via update?list-id=<project>:"
gurl "things:///update?id=$H_A1&auth-token=$TOKEN&list-id=$PROJ_HEADINGS"
sleep 1
note "-- post (heading FK cleared? project set?):"
gsql "SELECT title, heading, project FROM TMTask WHERE uuid='$H_A1'" | tee -a "$REPORT"
gsql "SELECT title, heading FROM TMTask WHERE heading='$ALPHA'" | tee -a "$REPORT"
note "-- rename heading Alpha to empty string via Shortcuts edit-title:"
proxy things-proxy-edit-title "{\"id\":\"$ALPHA\",\"title\":\"\"}"
gsql "SELECT uuid, title, type, project FROM TMTask WHERE uuid='$ALPHA'" | tee -a "$REPORT"
note "-- rename to a single space as fallback:"
proxy things-proxy-edit-title "{\"id\":\"$ALPHA\",\"title\":\" \"}"
gsql "SELECT uuid, title, type, project FROM TMTask WHERE uuid='$ALPHA'" | tee -a "$REPORT"

note "== copying DB out =="
lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/p9.sqlite"'
lab_scp "$LAB_SSH_USER@$IP:/tmp/p9.sqlite" "$OUT/final.sqlite" || true
note "GREEN — report: $REPORT"
trap - EXIT; cleanup
