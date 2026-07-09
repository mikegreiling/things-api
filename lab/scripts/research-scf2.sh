#!/bin/bash
# S-campaign follow-ups, round 2 (docs/lab/probe-backlog.md §A round 2). ONE clone.
#   P4  Completion/Creation backdating — redo with a PROPERLY completed fixture
#       (AS status write, verified in DB) across THREE surfaces: Shortcuts
#       set-detail (several date-string shapes), AppleScript property writes,
#       URL update WITH the auth token; plus json at-creation attributes.
#   P3a set-detail Reminder Time format experiments on a scheduled to-do.
#   P2b set-detail Parent on a TO-DO (heading variant was a silent no-op).
#   P6  sidebar-order spelling sweep (Mike's Anytime↔sidebar mirror insight):
#       move-project location specifier, set index, private reorder with AREA
#       uuids in list "Anytime", list "Someday" to-dos, sdef private-command grep.
# Harness fixes from round 1: proxy() clears the stale --output-path file;
# completion never goes through a token-less update URL. Discovery: no assertions.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-scf2-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[scf2] $*" | tee -a "$REPORT"; }
cleanup() { echo "[scf2] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Seed uuids (docs/lab/seed-manifest.json).
PROJ_PLAIN="933TCvzMgM3MLvpKPcjheC"   # project in LAB-AREA-A
PROJ_MIXED="Mnwp9RvB4yAB8G5cmhkukZ"   # project in LAB-AREA-B
AREA_A="7Ck4hAXU36jyaBsy2Fkije"
AREA_B="2piYxp6UzasLDSvkwY747J"
SOMEDAY_1="U9Ho5HiBsXAfEVte9rrPm2"    # LAB-SOMEDAY-1

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
proxy() { # proxy <name> <json>  (deadline-wrapped; STALE OUTPUT CLEARED each run)
  note "-- shortcuts run $1  $2"
  lab_ssh "$IP" "printf '%s' $(printf '%q' "$2") > /tmp/scf-in.json; rm -f /tmp/scf-out.txt; perl -e 'alarm 60; exec @ARGV' shortcuts run $(printf '%q' "$1") --input-path /tmp/scf-in.json --output-path /tmp/scf-out.txt 2>&1; echo \"[exit \$?]\"; cat /tmp/scf-out.txt 2>/dev/null; echo" 2>&1 | tee -a "$REPORT" || true
  sleep 1
}
uuid_of() { local t="$1" typ="${2:-}" w="title='$1' AND trashed=0" u i; [ -n "$typ" ] && w="$w AND type=$typ"; for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }

note "warm-up: launch Things, quit, relaunch"
lab_ssh "$IP" 'open -g -a Things3; sleep 12'
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3'
lab_ssh "$IP" 'open -g -a Things3; sleep 8'

TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
note "auth token in hand (${#TOKEN} chars)"
gupd() { gurl "things:///update?id=$1&auth-token=$TOKEN&$2"; }

bd_row() { gsql "SELECT title, status, stopDate, datetime(stopDate,'unixepoch') AS stop_h, datetime(creationDate,'unixepoch') AS created_h FROM TMTask WHERE uuid='$1'" | tee -a "$REPORT"; }

# ============================== P4a — backdating via Shortcuts set-detail
note "== [P4a] backdating via set-detail (fixture completed via AppleScript, VERIFIED) =="
gurl "things:///add?title=SCF2-BD-SC"
BD1=$(uuid_of "SCF2-BD-SC" 0)
gas "tell application \"Things3\" to set status of to do id \"$BD1\" to completed" | tee -a "$REPORT"
sleep 1
note "-- pre (MUST show completed + a 2026 stopDate before the probes mean anything):"
bd_row "$BD1"
for v in "1/15/2025" "January 15, 2025" "2025-01-15"; do
  proxy things-proxy-set-detail "{\"id\":\"$BD1\",\"detail\":\"Completion Date\",\"value\":\"$v\"}"
  note "-- after Completion Date <- '$v':"; bd_row "$BD1"
done
for v in "6/1/2024" "June 1, 2024"; do
  proxy things-proxy-set-detail "{\"id\":\"$BD1\",\"detail\":\"Creation Date\",\"value\":\"$v\"}"
  note "-- after Creation Date <- '$v':"; bd_row "$BD1"
done

# ============================== P4b — backdating via AppleScript property writes
note "== [P4b] backdating via AppleScript 'completion date' / 'creation date' properties =="
gurl "things:///add?title=SCF2-BD-AS"
BD2=$(uuid_of "SCF2-BD-AS" 0)
gas "tell application \"Things3\" to set status of to do id \"$BD2\" to completed" | tee -a "$REPORT"
sleep 1
note "-- pre:"; bd_row "$BD2"
note "-- set completion date to (current date) - 200 days (~2025-12-17, locale-proof):"
gas "tell application \"Things3\" to set completion date of to do id \"$BD2\" to ((current date) - (200 * days))" | tee -a "$REPORT"
sleep 1; bd_row "$BD2"
note "-- set creation date to (current date) - 400 days (~2025-06-01):"
gas "tell application \"Things3\" to set creation date of to do id \"$BD2\" to ((current date) - (400 * days))" | tee -a "$REPORT"
sleep 1; bd_row "$BD2"

# ============================== P4c — backdating via URL update (WITH token)
note "== [P4c] backdating via URL update?completion-date= (auth token attached) =="
gurl "things:///add?title=SCF2-BD-URL"
BD3=$(uuid_of "SCF2-BD-URL" 0)
gupd "$BD3" "completed=true"
note "-- pre (completed via tokened update URL — also re-validates the P4 bug diagnosis):"
bd_row "$BD3"
gupd "$BD3" "completion-date=2025-01-15"
note "-- after update?completion-date=2025-01-15:"; bd_row "$BD3"
gupd "$BD3" "creation-date=2024-06-01"
note "-- after update?creation-date=2024-06-01:"; bd_row "$BD3"

# ============================== P4d — backdating AT CREATION via things:///json
note "== [P4d] at-creation backdating via things:///json attributes =="
JSON_URL=$(python3 - <<'PY'
import json, urllib.parse
data = [{"type":"to-do","attributes":{"title":"SCF2-BD-JSON","completed":True,
  "creation-date":"2024-06-01T08:00:00Z","completion-date":"2025-01-15T09:00:00Z"}}]
print("things:///json?data=" + urllib.parse.quote(json.dumps(data), safe=""))
PY
)
gurl "$JSON_URL"
BD4=$(uuid_of "SCF2-BD-JSON" 0 || true)
note "-- row (did creation/completion-date attrs stick?):"
[ -n "${BD4:-}" ] && bd_row "$BD4" || note "   (row never appeared — json add rejected?)"

# ============================== P3a — Reminder Time set, format experiments
note "== [P3a] set-detail Reminder Time formats on a SCHEDULED to-do (expect hour<<26|min<<20) =="
gurl "things:///add?title=SCF2-REM&when=today"
RM=$(uuid_of "SCF2-REM" 0)
rem_row() { gsql "SELECT title, start, startDate, reminderTime FROM TMTask WHERE uuid='$RM'" | tee -a "$REPORT"; }
note "-- pre:"; rem_row
for v in "2:30 PM" "14:30" "7/5/2026 2:30 PM"; do
  proxy things-proxy-set-detail "{\"id\":\"$RM\",\"detail\":\"Reminder Time\",\"value\":\"$v\"}"
  note "-- after Reminder Time <- '$v' (14:30 = 970981376):"; rem_row
done

# ============================== P2b — set-detail Parent on a TO-DO
note "== [P2b] set-detail Parent: re-parent a TO-DO between projects =="
gurl "things:///add?title=SCF2-RP&list-id=$PROJ_PLAIN"
RP=$(uuid_of "SCF2-RP" 0)
note "-- pre (project should be $PROJ_PLAIN):"
gsql "SELECT title, project, area FROM TMTask WHERE uuid='$RP'" | tee -a "$REPORT"
proxy things-proxy-set-detail "{\"id\":\"$RP\",\"detail\":\"Parent\",\"value\":\"$PROJ_MIXED\"}"
note "-- post (moved to $PROJ_MIXED?):"
gsql "SELECT title, project, area FROM TMTask WHERE uuid='$RP'" | tee -a "$REPORT"

# ============================== P6 — sidebar-order spelling sweep
note "== [P6] sidebar order: untried spellings (O13 move-area + P17 anytime-projects are dead) =="
note "-- sdef sweep: every _private_ command + any writable index property:"
lab_ssh "$IP" 'sdef /Applications/Things3.app 2>/dev/null | grep -o "command name=\"[^\"]*\"" | sort -u' | tee -a "$REPORT"
lab_ssh "$IP" 'sdef /Applications/Things3.app 2>/dev/null | grep -n "property name=\"index\"" | head -5' | tee -a "$REPORT"

gurl "things:///add-project?title=SCF2-TOP-A"
gurl "things:///add-project?title=SCF2-TOP-B"
TA=$(uuid_of "SCF2-TOP-A" 1); TB=$(uuid_of "SCF2-TOP-B" 1)
top_rows() { gsql "SELECT uuid, title, \"index\" FROM TMTask WHERE type=1 AND area IS NULL AND trashed=0 AND status=0 ORDER BY \"index\"" | tee -a "$REPORT"; }
area_rows() { gsql "SELECT uuid, title, \"index\" FROM TMArea ORDER BY \"index\"" | tee -a "$REPORT"; }
note "-- pre, top-level projects:"; top_rows

note "-- [P6a] AppleScript move project to BEFORE another project (location specifier):"
gas "tell application \"Things3\" to move project id \"$TA\" to before project id \"$TB\"" | tee -a "$REPORT"
sleep 1; top_rows
note "-- [P6b] AppleScript move project to BEGINNING of projects:"
gas "tell application \"Things3\" to move project id \"$TA\" to beginning of projects" | tee -a "$REPORT"
sleep 1; top_rows
note "-- [P6c] set index of project (probe the property write):"
gas "tell application \"Things3\" to set index of project id \"$TA\" to 1" | tee -a "$REPORT"
sleep 1; top_rows
note "-- [P6d] private reorder, top-level PROJECT uuids in list \"Anytime\" (P17 re-check with fresh fixtures):"
gas "tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Anytime\" with ids \"$TB,$TA\"" | tee -a "$REPORT"
sleep 1; top_rows

note "-- pre, areas:"; area_rows
note "-- [P6e] private reorder, AREA uuids in list \"Anytime\":"
gas "tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Anytime\" with ids \"$AREA_B,$AREA_A\"" | tee -a "$REPORT"
sleep 1; area_rows
note "-- [P6f] AppleScript move area spellings (O13 was 'to before area'; try beginning):"
gas "tell application \"Things3\" to move area id \"$AREA_B\" to beginning of areas" | tee -a "$REPORT"
sleep 1; area_rows
note "-- [P6g] set index of area:"
gas "tell application \"Things3\" to set index of area id \"$AREA_B\" to 1" | tee -a "$REPORT"
sleep 1; area_rows

note "-- [P6h] private reorder in list \"Someday\" (to-do uuids — does the Someday scope exist?):"
gurl "things:///add?title=SCF2-SOME&when=someday"
SM=$(uuid_of "SCF2-SOME" 0)
gsql "SELECT uuid, title, start, \"index\" FROM TMTask WHERE uuid IN ('$SM','$SOMEDAY_1')" | tee -a "$REPORT"
gas "tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Someday\" with ids \"$SM,$SOMEDAY_1\"" | tee -a "$REPORT"
sleep 1
gsql "SELECT uuid, title, start, \"index\" FROM TMTask WHERE uuid IN ('$SM','$SOMEDAY_1')" | tee -a "$REPORT"

note "== copying DB out =="
lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/scf2.sqlite"'
lab_scp "$LAB_SSH_USER@$IP:/tmp/scf2.sqlite" "$OUT/final.sqlite" || true
note "GREEN — report: $REPORT"
trap - EXIT; cleanup
