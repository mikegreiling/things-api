#!/bin/bash
# S-campaign follow-ups, round 3 (docs/lab/probe-backlog.md §A round-2 leftovers +
# §C parked items). ONE clone, autonomous. Reconfirms the scf2 verdicts on a
# fresh clone (regression check) and banks the genuinely-open residuals that do
# NOT need the GUI. The GUI-only arms of this campaign (logInterval enum flip,
# deadline-less-repeat toggle, oddity-6½ screenshots) are VNC-driven and their
# evidence is documented in the results docs (they reuse the research-sx6.sh VNC
# mechanics); the headless-reproducible slices of those findings are folded in
# here so the whole campaign re-runs from one script.
#
#   P4  Completion/Creation backdating (reconfirm): Shortcuts set-detail DEAD,
#       AppleScript property write WORKS, URL update NO-OP, json at-creation WORKS.
#   P3a set-detail Reminder Time SET (reconfirm DEAD on a scheduled to-do).
#   P2b set-detail Parent on a TO-DO (reconfirm DESTRUCTIVE DETACH footgun).
#   P6  sidebar order: sdef private-command inventory (read the bundle's
#       Things.sdef directly — the `sdef` binary needs Xcode, absent in the lab),
#       dead move/set-index spellings, and the SOMEDAY 3-item convention LOCK
#       (reversed wire-list, matching the Inbox A6 convention).
#   LOGNOW  `log completed now` (AS) updates TMSettings.manualLogDate (the mid-
#           interval "log now" the boundary max()es in). logInterval enum itself
#           needs the GUI dropdown (0=Immediately, 1=Daily, 4=Manually — no 2/3);
#           see docs/lab/s-campaign-results.md round 3.
#   DLREPEAT  deadline-less FIXED repeat: the seeded LAB-REPEAT-DAILY is a fixed
#             (tp=0) daily rule created with "Add deadlines" OFF; its instances
#             carry a startDate but NO deadline — falsifies the fixed=>deadlined
#             law (src/model/recurrence.ts). Read-only verification here.
#   RCLEAR  repeating-template dated-reminder clear: Shortcuts set-detail clear
#           and AppleScript move-to-Inbox on LAB-REPEAT-DAILY — safety + effect.
#
# Harness fixes from earlier rounds: proxy() clears the stale --output-path file;
# completion never goes through a token-less update URL. Discovery: no assertions.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-scf3-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[scf3] $*" | tee -a "$REPORT"; }
cleanup() { echo "[scf3] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Seed uuids (docs/lab/seed-manifest.json).
PROJ_PLAIN="933TCvzMgM3MLvpKPcjheC"   # project in LAB-AREA-A
PROJ_MIXED="Mnwp9RvB4yAB8G5cmhkukZ"   # project in LAB-AREA-B
SOMEDAY_1="U9Ho5HiBsXAfEVte9rrPm2"    # LAB-SOMEDAY-1
REPEAT_DAILY="W3PZB9e7W6BEtKmEKP4deG" # LAB-REPEAT-DAILY (fixed daily template)

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300)
note "ssh up at $IP"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && exit 1 || exit 0' </dev/null
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gsql() { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" </dev/null; }
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gas() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" </dev/null || true; }
gurl() { lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; sleep 2; }
proxy() { # proxy <name> <json>  (deadline-wrapped; STALE OUTPUT CLEARED each run)
  note "-- shortcuts run $1  $2"
  lab_ssh "$IP" "printf '%s' $(printf '%q' "$2") > /tmp/scf-in.json; rm -f /tmp/scf-out.txt; perl -e 'alarm 60; exec @ARGV' shortcuts run $(printf '%q' "$1") --input-path /tmp/scf-in.json --output-path /tmp/scf-out.txt 2>&1; echo \"[exit \$?]\"; cat /tmp/scf-out.txt 2>/dev/null; echo" </dev/null 2>&1 | tee -a "$REPORT" || true
  sleep 1
}
uuid_of() { local w="title='$1' AND trashed=0" u i; [ -n "${2:-}" ] && w="$w AND type=$2"; for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }
pid_now() { lab_ssh "$IP" 'pgrep -x Things3 || echo DEAD' </dev/null; }

note "warm-up: launch Things, quit, relaunch"
lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3' </dev/null
lab_ssh "$IP" 'open -g -a Things3; sleep 8' </dev/null

TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
note "auth token in hand (${#TOKEN} chars)"
gupd() { gurl "things:///update?id=$1&auth-token=$TOKEN&$2"; }
bd_row() { gsql "SELECT title, status, datetime(stopDate,'unixepoch') stop_h, datetime(creationDate,'unixepoch') created_h FROM TMTask WHERE uuid='$1'" | tee -a "$REPORT"; }

# ============================== P4 — backdating (reconfirm scf2)
note "== [P4a] Shortcuts set-detail Completion Date (expect DEAD) =="
gurl "things:///add?title=SCF3-BD-SC"; BD1=$(uuid_of "SCF3-BD-SC" 0)
gas "tell application \"Things3\" to set status of to do id \"$BD1\" to completed"; sleep 1
note "-- pre:"; bd_row "$BD1"
proxy things-proxy-set-detail "{\"id\":\"$BD1\",\"detail\":\"Completion Date\",\"value\":\"2025-01-15\"}"
note "-- after Completion Date <- 2025-01-15:"; bd_row "$BD1"

note "== [P4b] AppleScript completion/creation date property writes (expect WORKS) =="
gurl "things:///add?title=SCF3-BD-AS"; BD2=$(uuid_of "SCF3-BD-AS" 0)
gas "tell application \"Things3\" to set status of to do id \"$BD2\" to completed"; sleep 1
note "-- pre:"; bd_row "$BD2"
gas "tell application \"Things3\" to set completion date of to do id \"$BD2\" to ((current date) - (200 * days))"; sleep 1
gas "tell application \"Things3\" to set creation date of to do id \"$BD2\" to ((current date) - (400 * days))"; sleep 1
note "-- after AS completion(-200d) ~2025-12-17 / creation(-400d) ~2025-05-31:"; bd_row "$BD2"

note "== [P4c] URL update completion-date WITH token (expect NO-OP) =="
gurl "things:///add?title=SCF3-BD-URL"; BD3=$(uuid_of "SCF3-BD-URL" 0)
gupd "$BD3" "completed=true"; sleep 1
note "-- pre (completed via tokened URL):"; bd_row "$BD3"
gupd "$BD3" "completion-date=2025-01-15"
note "-- after update?completion-date=2025-01-15:"; bd_row "$BD3"

note "== [P4d] at-creation backdating via things:///json (expect WORKS) =="
JSON_URL=$(python3 - <<'PY'
import json, urllib.parse
data=[{"type":"to-do","attributes":{"title":"SCF3-BD-JSON","completed":True,"creation-date":"2024-06-01T08:00:00Z","completion-date":"2025-01-15T09:00:00Z"}}]
print("things:///json?data="+urllib.parse.quote(json.dumps(data),safe=""))
PY
)
gurl "$JSON_URL"; BD4=$(uuid_of "SCF3-BD-JSON" 0 || true)
note "-- row (creation 2024-06-01, completion 2025-01-15?):"; [ -n "${BD4:-}" ] && bd_row "$BD4" || note "   (row never appeared)"

# ============================== P3a — Reminder Time SET (reconfirm DEAD)
note "== [P3a] set-detail Reminder Time on a scheduled to-do (expect DEAD) =="
gurl "things:///add?title=SCF3-REM&when=today"; RM=$(uuid_of "SCF3-REM" 0)
rem_row() { gsql "SELECT title, start, startDate, reminderTime FROM TMTask WHERE uuid='$RM'" | tee -a "$REPORT"; }
note "-- pre:"; rem_row
for v in "2:30 PM" "14:30"; do
  proxy things-proxy-set-detail "{\"id\":\"$RM\",\"detail\":\"Reminder Time\",\"value\":\"$v\"}"
  note "-- after Reminder Time <- '$v':"; rem_row
done

# ============================== P2b — set-detail Parent on a TO-DO (DETACH footgun)
note "== [P2b] set-detail Parent (text uuid) on a TO-DO (expect DETACH -> project NULL) =="
gurl "things:///add?title=SCF3-RP&list-id=$PROJ_PLAIN"; RP=$(uuid_of "SCF3-RP" 0)
note "-- pre (project should be $PROJ_PLAIN):"; gsql "SELECT title, project, area FROM TMTask WHERE uuid='$RP'" | tee -a "$REPORT"
proxy things-proxy-set-detail "{\"id\":\"$RP\",\"detail\":\"Parent\",\"value\":\"$PROJ_MIXED\"}"
note "-- post (moved to $PROJ_MIXED, or detached to NULL?):"; gsql "SELECT title, project, area FROM TMTask WHERE uuid='$RP'" | tee -a "$REPORT"

# ============================== P6 — sidebar order
note "== [P6] sdef private-command inventory (read the bundle file; sdef binary needs Xcode) =="
lab_ssh "$IP" 'F=$(ls /Applications/Things3.app/Contents/Resources/*.sdef 2>/dev/null | head -1); grep -oE "command name=\"[^\"]*\"" "$F" | sort -u' </dev/null | tee -a "$REPORT"

note "== [P6a/c] move-project location + set index (expect DEAD) =="
gurl "things:///add-project?title=SCF3-TOP-A"; gurl "things:///add-project?title=SCF3-TOP-B"
TA=$(uuid_of "SCF3-TOP-A" 1); TB=$(uuid_of "SCF3-TOP-B" 1)
top_rows() { gsql "SELECT title, \"index\" FROM TMTask WHERE type=1 AND area IS NULL AND trashed=0 AND status=0 AND title LIKE 'SCF3-TOP%' ORDER BY \"index\"" | tee -a "$REPORT"; }
note "-- pre:"; top_rows
note "-- [P6a] move project TA to before TB:"; gas "tell application \"Things3\" to move project id \"$TA\" to before project id \"$TB\"" | tee -a "$REPORT"
note "-- [P6c] set index of project TA to 1:"; gas "tell application \"Things3\" to set index of project id \"$TA\" to 1" | tee -a "$REPORT"
note "-- post (unchanged?):"; top_rows

note "== [P6h] SOMEDAY reorder — 3-item convention lock (expect reversed wire-list) =="
for n in 1 2 3; do gurl "things:///add?title=SCF3-SOME-$n&when=someday"; done
S1=$(uuid_of "SCF3-SOME-1" 0); S2=$(uuid_of "SCF3-SOME-2" 0); S3=$(uuid_of "SCF3-SOME-3" 0)
some_rows() { gsql "SELECT substr(uuid,1,6) uid, title, \"index\" FROM TMTask WHERE uuid IN ('$S1','$S2','$S3') ORDER BY \"index\"" | tee -a "$REPORT"; }
note "-- pre (creation order 1,2,3):"; some_rows
note "-- reorder with wire-list ids = S3,S1,S2  (result should be REVERSED: S2,S1,S3 top->bottom):"
gas "tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Someday\" with ids \"$S3,$S1,$S2\"" | tee -a "$REPORT"
sleep 1; note "-- post:"; some_rows

# ============================== LOGNOW — manualLogDate update
note "== [LOGNOW] log completed now (AS) updates TMSettings.manualLogDate =="
note "-- baseline:"; gsql "SELECT logInterval, datetime(manualLogDate,'unixepoch') mld FROM TMSettings" | tee -a "$REPORT"
gurl "things:///add?title=SCF3-LOGNOW"; LN=$(uuid_of "SCF3-LOGNOW" 0)
gas "tell application \"Things3\" to set status of to do id \"$LN\" to completed"; sleep 1
gas "tell application \"Things3\" to log completed now"; sleep 2
note "-- after log-now (mld should advance to ~current guest clock):"; gsql "SELECT logInterval, datetime(manualLogDate,'unixepoch') mld FROM TMSettings" | tee -a "$REPORT"
note "   NOTE: the logInterval ENUM (0=Immediately, 1=Daily, 4=Manually — NO 2/3)"
note "   is only settable via the GUI dropdown; see s-campaign-results.md round 3."

# ============================== DLREPEAT — deadline-less fixed repeat
note "== [DLREPEAT] seeded LAB-REPEAT-DAILY is a DEADLINE-LESS fixed daily repeat =="
note "-- rule (tp=0 fixed, fu=16 daily, ts=0, of=[{dy:0}]):"
gq "SELECT rt1_recurrenceRule FROM TMTask WHERE uuid='$REPEAT_DAILY'" | tee -a "$REPORT"
note "-- template + instances: instances have a startDate but deadline is NULL"
note "   => falsifies the fixed=>deadlined (even ts=0) law in src/model/recurrence.ts:"
gsql "SELECT substr(uuid,1,6) uid, start, startDate, deadline, t2_deadlineOffset, (rt1_recurrenceRule IS NOT NULL) tmpl FROM TMTask WHERE title='LAB-REPEAT-DAILY' ORDER BY tmpl DESC, startDate" | tee -a "$REPORT"

# ============================== RCLEAR — repeating-template dated-reminder clear
note "== [RCLEAR] clear ops on a REPEATING TEMPLATE (safety + effect) =="
note "-- (a) Shortcuts set-detail Reminder Time='' — expect SAFE no-op, NO crash, rule intact:"
note "   PID before: $(pid_now)"
proxy things-proxy-set-detail "{\"id\":\"$REPEAT_DAILY\",\"detail\":\"Reminder Time\",\"value\":\"\"}"
note "   PID after:  $(pid_now)"
gsql "SELECT substr(uuid,1,6) uid, start, startDate, reminderTime, (rt1_recurrenceRule IS NOT NULL) tmpl, rt1_instanceCreationPaused paused FROM TMTask WHERE uuid='$REPEAT_DAILY'" | tee -a "$REPORT"
note "-- (b) AppleScript move-to-Inbox — expect CLEAN REFUSAL (error 301), NO crash:"
note "   PID before: $(pid_now)"
gas "tell application \"Things3\" to move to do id \"$REPEAT_DAILY\" to list \"Inbox\"" | tee -a "$REPORT"
note "   PID after:  $(pid_now)"
gsql "SELECT substr(uuid,1,6) uid, start, startDate, (rt1_recurrenceRule IS NOT NULL) tmpl FROM TMTask WHERE uuid='$REPEAT_DAILY'" | tee -a "$REPORT"
lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3*.ips 2>/dev/null || echo "no new .ips (no crash)"' </dev/null | tee -a "$REPORT"

note "== copying DB out =="
lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/scf3.sqlite"' </dev/null
lab_scp "$LAB_SSH_USER@$IP:/tmp/scf3.sqlite" "$OUT/final.sqlite" </dev/null || true
note "GREEN — report: $REPORT"
trap - EXIT; cleanup
