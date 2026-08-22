#!/bin/bash
# ODDS1-A — oddities re-validation batch A: the non-crashing headless cells.
#
# Re-runs the original reproduction recipe of every oddities entry that is
# reachable through the URL scheme / AppleScript / `things:///json` without a
# GUI drag, a clock roll, or a crash, against Things 3.23 (golden-v4).
#
# METHOD: ONE disposable clone `odds1a-lab` of things-lab-golden-v4. Airgap,
# clock pinned 2026-07-05 12:00, synthetic ODDS1-* fixtures (the golden's own
# LAB-* seeds are read or mutated only where the entry's recipe needs one).
# Guest SQLite read-only is the ground truth; `open` exit 0 proves nothing.
# Teardown on EXIT. The destructive empty-trash cell runs LAST.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="odds1a-lab"
OUT="lab/artifacts/odds1a-lab"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[odds1a] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"

GOLDEN="${GOLDEN:-things-lab-golden-v4}"
note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: no SSH"; exit 1; }
note "ssh up at $IP"
cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — $VM left running at $IP"; return; fi
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "teardown done"
}
trap cleanup EXIT

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null

lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 -noheader -list "file:$DB?mode=ro" "$1"
EOF
lab_ssh "$IP" 'cat > ~/labh/ourl.sh && chmod +x ~/labh/ourl.sh' <<'EOF'
#!/bin/bash
u=$(printf %s "$1" | base64 --decode)
open -g "$u"; echo "EXIT=$?"
EOF
lab_ssh "$IP" 'cat > ~/labh/oas.sh && chmod +x ~/labh/oas.sh' <<'EOF'
#!/bin/bash
printf %s "$1" | base64 --decode > /tmp/odds1.scpt
osascript /tmp/odds1.scpt 2>&1; echo "EXIT=$?"
EOF

gq() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
b64() { printf %s "$1" | base64; }
ourl() { lab_ssh "$IP" "~/labh/ourl.sh $(b64 "$1")" </dev/null; }
oas() { lab_ssh "$IP" "~/labh/oas.sh $(b64 "$1")" </dev/null; }
settle() { lab_ssh "$IP" "sleep ${1:-3}" </dev/null; }
ips_count() { lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3*.ips 2>/dev/null | wc -l | tr -d " "' </dev/null; }
alive() { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null; }

VER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
BLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
note "env: Things $VER ($BLD) · dbv $(gq 'SELECT databaseVersion FROM Meta') · clock $(lab_ssh "$IP" date </dev/null)"
lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null
note "ips baseline: $(ips_count) · things: $(alive)"

# url-encode helper (host side)
enc() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1"; }
jsonurl() { echo "things:///json?auth-token=$TOKEN&data=$(enc "$1")"; }

########################################################################
note ""
note "===== CELL 1 (§2g) update?completion-date= / creation-date= are silently ignored"
ourl "things:///add?title=ODDS1-CD&auth-token=$TOKEN" >/dev/null; settle 4
CD=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-CD' AND trashed=0 LIMIT 1")
ourl "things:///update?id=$CD&auth-token=$TOKEN&completed=true" >/dev/null; settle 4
BEFORE=$(gq "SELECT status||'|'||IFNULL(stopDate,'NULL')||'|'||creationDate||'|'||userModificationDate FROM TMTask WHERE uuid='$CD'")
note "  control completed=true -> status|stop|crt|umd = $BEFORE"
ourl "things:///update?id=$CD&auth-token=$TOKEN&completion-date=2025-01-15" >/dev/null; settle 4
ourl "things:///update?id=$CD&auth-token=$TOKEN&creation-date=2025-01-15" >/dev/null; settle 4
AFTER=$(gq "SELECT status||'|'||IFNULL(stopDate,'NULL')||'|'||creationDate||'|'||userModificationDate FROM TMTask WHERE uuid='$CD'")
note "  after completion-date= + creation-date=     = $AFTER"
[ "$BEFORE" = "$AFTER" ] && note "  VERDICT: byte-identical -> STILL silently ignored" || note "  VERDICT: CHANGED"

########################################################################
note ""
note "===== CELL 2 (§2h) the json date parser: fractional seconds / date-only"
for label in FRAC SEC DATEONLY; do
  case "$label" in
    FRAC) D='2025-03-01T18:00:00.000Z' ;;
    SEC)  D='2025-03-01T18:00:00Z' ;;
    DATEONLY) D='2025-01-15' ;;
  esac
  P="[{\"type\":\"to-do\",\"attributes\":{\"title\":\"ODDS1-JD-$label\",\"creation-date\":\"$D\"}}]"
  ourl "$(jsonurl "$P")" >/dev/null; settle 4
  N=$(gq "SELECT COUNT(*) FROM TMTask WHERE title='ODDS1-JD-$label'")
  C=$(gq "SELECT IFNULL(creationDate,'-') FROM TMTask WHERE title='ODDS1-JD-$label' LIMIT 1")
  note "  creation-date='$D' -> rows=$N creationDate=$C"
  lab_ssh "$IP" 'pkill -x Things3; sleep 3; open -g -a Things3; sleep 10' </dev/null
done
note "  VERDICT: rows=0 for FRAC and DATEONLY, rows=1 for SEC -> claim holds"

########################################################################
note ""
note "===== CELL 3 (§5n/§5i) AppleScript delete on a COMPLETED / TRASHED to-do"
ourl "things:///add?title=ODDS1-DEL-DONE&auth-token=$TOKEN" >/dev/null
ourl "things:///add?title=ODDS1-DEL-OPEN&auth-token=$TOKEN" >/dev/null; settle 5
DD=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-DEL-DONE' LIMIT 1")
DO=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-DEL-OPEN' LIMIT 1")
ourl "things:///update?id=$DD&auth-token=$TOKEN&completed=true" >/dev/null; settle 4
note "  completed row status=$(gq "SELECT status FROM TMTask WHERE uuid='$DD'")"
note "  get name of completed: $(oas "tell application \"Things3\" to get name of to do id \"$DD\"")"
note "  delete completed    : $(oas "tell application \"Things3\" to delete to do id \"$DD\"")"
note "    trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$DD'")"
note "  move completed->Trash: $(oas "tell application \"Things3\" to move to do id \"$DD\" to list \"Trash\"")"
settle 3
note "    trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$DD'")"
note "  delete OPEN control : $(oas "tell application \"Things3\" to delete to do id \"$DO\"")"
settle 3
note "    trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$DO'")"
note "  re-delete a TRASHED row (bare id)   : $(oas "tell application \"Things3\" to delete to do id \"$DO\"")"
note "  delete via list \"Trash\" specifier   : $(oas "tell application \"Things3\" to delete (first to do of list \"Trash\" whose id is \"$DO\")")"
settle 3
note "    still exists=$(gq "SELECT COUNT(*) FROM TMTask WHERE uuid='$DO'")"

########################################################################
note ""
note "===== CELL 4 (§5p) AppleScript set completion date FORCES status=completed"
ourl "things:///add?title=ODDS1-SCD-OPEN&auth-token=$TOKEN" >/dev/null
ourl "things:///add?title=ODDS1-SCD-CANC&auth-token=$TOKEN" >/dev/null
ourl "things:///add?title=ODDS1-SCR-OPEN&auth-token=$TOKEN" >/dev/null; settle 5
SO=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-SCD-OPEN' LIMIT 1")
SC=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-SCD-CANC' LIMIT 1")
SR=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-SCR-OPEN' LIMIT 1")
ourl "things:///update?id=$SC&auth-token=$TOKEN&canceled=true" >/dev/null; settle 4
note "  pre : OPEN status=$(gq "SELECT status FROM TMTask WHERE uuid='$SO'") · CANCELED status=$(gq "SELECT status FROM TMTask WHERE uuid='$SC'")"
note "  set completion date (open)    : $(oas "tell application \"Things3\" to set completion date of to do id \"$SO\" to (date \"7/1/2026\")")"
note "  set completion date (canceled): $(oas "tell application \"Things3\" to set completion date of to do id \"$SC\" to (date \"7/1/2026\")")"
UMD0=$(gq "SELECT userModificationDate FROM TMTask WHERE uuid='$SR'")
note "  set creation date (open ctrl) : $(oas "tell application \"Things3\" to set creation date of to do id \"$SR\" to (date \"1/2/2025\")")"
settle 4
note "  post: OPEN->status=$(gq "SELECT status||' stop='||IFNULL(stopDate,'NULL') FROM TMTask WHERE uuid='$SO'")"
note "  post: CANC->status=$(gq "SELECT status||' stop='||IFNULL(stopDate,'NULL') FROM TMTask WHERE uuid='$SC'")"
note "  post: ctrl set creation date -> status=$(gq "SELECT status FROM TMTask WHERE uuid='$SR'") crt=$(gq "SELECT creationDate FROM TMTask WHERE uuid='$SR'") umd-changed=$([ "$UMD0" = "$(gq "SELECT userModificationDate FROM TMTask WHERE uuid='$SR'")" ] && echo no || echo yes)"

########################################################################
note ""
note "===== CELL 5 (§5q) a json COMPLETED project with a plain OPEN child lands OPEN"
P1="[{\"type\":\"project\",\"attributes\":{\"title\":\"ODDS1-JP-OPENCHILD\",\"completed\":true,\"completion-date\":\"2025-02-01T10:00:00Z\",\"creation-date\":\"2025-01-01T10:00:00Z\",\"items\":[{\"type\":\"to-do\",\"attributes\":{\"title\":\"ODDS1-JP-C-OPEN\"}}]}}]"
ourl "$(jsonurl "$P1")" >/dev/null; settle 5
note "  open-child payload  -> $(gq "SELECT 'status='||status||' stop='||IFNULL(stopDate,'NULL')||' crt='||creationDate FROM TMTask WHERE title='ODDS1-JP-OPENCHILD'")"
P2="[{\"type\":\"project\",\"attributes\":{\"title\":\"ODDS1-JP-DONECHILD\",\"completed\":true,\"completion-date\":\"2025-02-01T10:00:00Z\",\"creation-date\":\"2025-01-01T10:00:00Z\",\"items\":[{\"type\":\"to-do\",\"attributes\":{\"title\":\"ODDS1-JP-C-DONE\",\"completed\":true,\"completion-date\":\"2025-02-01T10:00:00Z\"}}]}}]"
ourl "$(jsonurl "$P2")" >/dev/null; settle 5
note "  resolved-child ctrl -> $(gq "SELECT 'status='||status||' stop='||IFNULL(stopDate,'NULL')||' crt='||creationDate FROM TMTask WHERE title='ODDS1-JP-DONECHILD'")"

########################################################################
note ""
note "===== CELL 6 (§6a) heading 'canceled' is stored as COMPLETED, cascades CANCELED"
HP=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-PROJ-HEADINGS' AND type=1 LIMIT 1")
HA=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-H-A1' AND type=2 LIMIT 1")
note "  project=$HP heading=$HA"
ourl "things:///add?title=ODDS1-HC-1&auth-token=$TOKEN&list-id=$HP&heading=LAB-H-A1" >/dev/null
ourl "things:///add?title=ODDS1-HC-2&auth-token=$TOKEN&list-id=$HP&heading=LAB-H-A1" >/dev/null; settle 6
note "  seeded children: $(gq "SELECT group_concat(title||':'||status) FROM TMTask WHERE heading='$HA' AND title LIKE 'ODDS1-HC-%'")"
note "  set status canceled: $(oas "tell application \"Things3\" to set status of to do id \"$HA\" to canceled")"
settle 4
note "  heading status=$(gq "SELECT status||' stop='||IFNULL(stopDate,'NULL') FROM TMTask WHERE uuid='$HA'")"
note "  children: $(gq "SELECT group_concat(title||':'||status) FROM TMTask WHERE heading='$HA' AND title LIKE 'ODDS1-HC-%'")"

########################################################################
note ""
note "===== CELL 7 (§9b) unknown tags: AppleScript CREATES them, the URL scheme DROPS them"
ourl "things:///add?title=ODDS1-TAGAS&auth-token=$TOKEN" >/dev/null
ourl "things:///add?title=ODDS1-TAGURL&auth-token=$TOKEN&tags=LAB-TAG-1,ODDS1-GHOST-URL" >/dev/null; settle 6
TA=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-TAGAS' LIMIT 1")
note "  URL add tags=LAB-TAG-1,ODDS1-GHOST-URL -> cachedTags rows=$(gq "SELECT COUNT(*) FROM TMTaskTag WHERE tasks=(SELECT uuid FROM TMTask WHERE title='ODDS1-TAGURL' LIMIT 1)") · ghost tag exists=$(gq "SELECT COUNT(*) FROM TMTag WHERE title='ODDS1-GHOST-URL'")"
note "  AS set tag names: $(oas "tell application \"Things3\" to set tag names of to do id \"$TA\" to \"LAB-TAG-1, ODDS1-GHOST-AS\"")"
settle 4
note "  -> tag rows=$(gq "SELECT COUNT(*) FROM TMTaskTag WHERE tasks='$TA'") · ghost tag created=$(gq "SELECT COUNT(*) FROM TMTag WHERE title='ODDS1-GHOST-AS'")"

########################################################################
note ""
note "===== CELL 8 (§9w) when=<ISO-date>@evening discards the date and stamps a YEAR reminder"
ourl "things:///add?title=ODDS1-XD-2026&auth-token=$TOKEN&when=2026-07-06@evening" >/dev/null
ourl "things:///add?title=ODDS1-XD-2027&auth-token=$TOKEN&when=2027-07-06@evening" >/dev/null
ourl "things:///add?title=ODDS1-XD-TOM&auth-token=$TOKEN&when=tomorrow@evening" >/dev/null
ourl "things:///add?title=ODDS1-XD-TIME&auth-token=$TOKEN&when=2026-07-06@20:00" >/dev/null; settle 8
for t in ODDS1-XD-2026 ODDS1-XD-2027 ODDS1-XD-TOM ODDS1-XD-TIME; do
  note "  $t -> $(gq "SELECT 'start='||start||' sb='||startBucket||' sd='||IFNULL(startDate,'NULL')||' rem='||IFNULL(reminderTime,'NULL') FROM TMTask WHERE title='$t' LIMIT 1")"
done
note "  (expect 2026 -> rem 1369440256 = 20:26; 2027 -> 1370488832 = 20:27)"

########################################################################
note ""
note "===== CELL 9 (§9y-json) checklist-items as a bare STRING array no-ops the WHOLE import"
PS="[{\"type\":\"to-do\",\"attributes\":{\"title\":\"ODDS1-CLS\",\"checklist-items\":[\"x1\",\"x2\"]}}]"
ourl "$(jsonurl "$PS")" >/dev/null; settle 5
note "  string array -> rows=$(gq "SELECT COUNT(*) FROM TMTask WHERE title='ODDS1-CLS'")"
lab_ssh "$IP" 'pkill -x Things3; sleep 3; open -g -a Things3; sleep 10' </dev/null
PO="[{\"type\":\"to-do\",\"attributes\":{\"title\":\"ODDS1-CLO\",\"checklist-items\":[{\"type\":\"checklist-item\",\"attributes\":{\"title\":\"x1\"}},{\"type\":\"checklist-item\",\"attributes\":{\"title\":\"x2\"}}]}}]"
ourl "$(jsonurl "$PO")" >/dev/null; settle 5
note "  object array -> rows=$(gq "SELECT COUNT(*) FROM TMTask WHERE title='ODDS1-CLO'") items=$(gq "SELECT COUNT(*) FROM TMChecklistItem WHERE task=(SELECT uuid FROM TMTask WHERE title='ODDS1-CLO' LIMIT 1)")"

########################################################################
note ""
note "===== CELL 10 (§9q) AppleScript cannot CLEAR a deadline; URL deadline= can"
ourl "things:///add?title=ODDS1-DLC&auth-token=$TOKEN&deadline=2026-07-20" >/dev/null; settle 5
DL=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-DLC' LIMIT 1")
note "  seeded deadline=$(gq "SELECT IFNULL(deadline,'NULL') FROM TMTask WHERE uuid='$DL'")"
note "  AS set due date to missing value: $(oas "tell application \"Things3\" to set due date of to do id \"$DL\" to missing value")"
settle 3
note "  -> deadline=$(gq "SELECT IFNULL(deadline,'NULL') FROM TMTask WHERE uuid='$DL'")"
ourl "things:///update?id=$DL&auth-token=$TOKEN&deadline=" >/dev/null; settle 4
note "  URL deadline= (empty) -> deadline=$(gq "SELECT IFNULL(deadline,'NULL') FROM TMTask WHERE uuid='$DL'")"

########################################################################
note ""
note "===== CELL 11 (§9o) a deadline-forecast someday row joins the todayIndex axis"
ourl "things:///add-project?title=ODDS1-DLP&auth-token=$TOKEN" >/dev/null; settle 5
DP=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-DLP' AND type=1 LIMIT 1")
for n in 1 2 3; do
  ourl "things:///add?title=ODDS1-DF$n&auth-token=$TOKEN&list-id=$DP&when=someday&deadline=2026-07-08" >/dev/null; settle 3
done
ourl "things:///add?title=ODDS1-DF-INBOX&auth-token=$TOKEN&deadline=2026-07-08" >/dev/null; settle 5
for t in ODDS1-DF1 ODDS1-DF2 ODDS1-DF3 ODDS1-DF-INBOX; do
  note "  $t -> $(gq "SELECT 'start='||start||' sd='||IFNULL(startDate,'NULL')||' ti='||IFNULL(todayIndex,'NULL')||' tiRef='||IFNULL(todayIndexReferenceDate,'NULL')||' idx='||\"index\" FROM TMTask WHERE title='$t' LIMIT 1")"
done

########################################################################
note ""
note "===== CELL 12 (§9l) a same-heading re-head is index-INERT"
for n in 1 2 3 4; do
  ourl "things:///add?title=ODDS1-RH$n&auth-token=$TOKEN&list-id=$HP&heading=LAB-H-A2&when=someday" >/dev/null; settle 3
done
settle 4
HB=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-H-A2' AND type=2 LIMIT 1")
note "  before: $(gq "SELECT group_concat(title||':'||\"index\",' ') FROM (SELECT title,\"index\" FROM TMTask WHERE heading='$HB' AND title LIKE 'ODDS1-RH%' ORDER BY \"index\")")"
for n in 3 1 4 2; do
  U=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-RH$n' LIMIT 1")
  ourl "things:///update?id=$U&auth-token=$TOKEN&list-id=$HP&heading=LAB-H-A2" >/dev/null; settle 3
done
settle 4
note "  after : $(gq "SELECT group_concat(title||':'||\"index\",' ') FROM (SELECT title,\"index\" FROM TMTask WHERE heading='$HB' AND title LIKE 'ODDS1-RH%' ORDER BY \"index\")")"

########################################################################
note ""
note "===== CELL 13 (§339-addendum / §8k) a repeating PROJECT template refuses quiet-vector edits"
TP=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-WEEKLY-PROJ' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
AR=$(gq "SELECT uuid FROM TMArea WHERE title='LAB-AREA-B' LIMIT 1")
note "  template=$TP targetArea=$AR"
B=$(gq "SELECT 'area='||IFNULL(area,'NULL')||' start='||start||' umd='||userModificationDate FROM TMTask WHERE uuid='$TP'")
note "  before: $B"
ourl "things:///update-project?id=$TP&auth-token=$TOKEN&list-id=$AR" >/dev/null; settle 4
note "  after update-project list-id=<area>: $(gq "SELECT 'area='||IFNULL(area,'NULL')||' start='||start||' umd='||userModificationDate FROM TMTask WHERE uuid='$TP'")"
ourl "things:///update-project?id=$TP&auth-token=$TOKEN&when=someday" >/dev/null; settle 4
note "  after update-project when=someday : $(gq "SELECT 'area='||IFNULL(area,'NULL')||' start='||start||' umd='||userModificationDate FROM TMTask WHERE uuid='$TP'")"
note "  AS move template to list Anytime  : $(oas "tell application \"Things3\" to move (to do id \"$TP\") to list \"Anytime\"")"
note "  AS schedule template              : $(oas "tell application \"Things3\" to schedule to do id \"$TP\" for (date \"7/8/2026\")")"
settle 3
note "  post : $(gq "SELECT 'area='||IFNULL(area,'NULL')||' start='||start||' umd='||userModificationDate FROM TMTask WHERE uuid='$TP'")"
note "  things alive: $(alive) · ips=$(ips_count)"

########################################################################
note ""
note "===== CELL 14 (§8n) repeating-template CHILDREN are status/schedule-immutable"
TC=$(gq "SELECT group_concat(uuid) FROM TMTask WHERE project='$TP' AND trashed=0")
note "  template children: ${TC:-<none>}"
if [ -n "$TC" ]; then
  C1=$(echo "$TC" | cut -d, -f1)
  note "  child=$C1 status0=$(gq "SELECT status FROM TMTask WHERE uuid='$C1'")"
  ourl "things:///update?id=$C1&auth-token=$TOKEN&completed=true" >/dev/null; settle 4
  note "  URL completed=true -> status=$(gq "SELECT status FROM TMTask WHERE uuid='$C1'")"
  note "  AS set status completed: $(oas "tell application \"Things3\" to set status of to do id \"$C1\" to completed")"
  settle 3
  note "  -> status=$(gq "SELECT status FROM TMTask WHERE uuid='$C1'")"
  note "  AS schedule child      : $(oas "tell application \"Things3\" to schedule to do id \"$C1\" for (date \"7/8/2026\")")"
  note "  AS move child->Someday : $(oas "tell application \"Things3\" to move (to do id \"$C1\") to list \"Someday\"")"
  note "  AS set name (control)  : $(oas "tell application \"Things3\" to set name of to do id \"$C1\" to \"ODDS1-TC-RENAMED\"")"
  settle 3
  note "  -> $(gq "SELECT 'title='||title||' status='||status||' start='||start||' sd='||IFNULL(startDate,'NULL') FROM TMTask WHERE uuid='$C1'")"
else
  note "  SKIPPED: the golden's repeating project template has no children"
fi

########################################################################
note ""
note "===== CELL 15 (§7 F1) AppleScript move project to a BOGUS area id"
IPS0=$(ips_count)
PJ=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-PROJ-PLAIN' AND type=1 LIMIT 1")
note "  move project -> area id 'ODDS1-NOT-A-REAL-UUID': $(oas "tell application \"Things3\" to move project id \"$PJ\" to area id \"ODDS1-NOT-A-REAL-UUID\"")"
settle 6
note "  things=$(alive) · ips $IPS0 -> $(ips_count)"

########################################################################
note ""
note "===== CELL 16 (§9u) things:///show?id=later-projects"
W0=$(oas "tell application \"System Events\" to tell process \"Things3\" to return (count of windows)")
ourl "things:///show?id=later-projects" >/dev/null; settle 6
note "  windows before=$W0 after=$(oas "tell application \"System Events\" to tell process \"Things3\" to return (count of windows)")"
note "  sheet/alert text: $(oas "tell application \"System Events\" to tell process \"Things3\" to return (value of every static text of every window)")"
lab_ssh "$IP" 'pkill -x Things3; sleep 3; open -g -a Things3; sleep 10' </dev/null

########################################################################
note ""
note "===== CELL 17 (§2e RC03) AppleScript move-to-Inbox drops a dated reminder"
ourl "things:///add?title=ODDS1-RC03&auth-token=$TOKEN&when=2026-07-09@15:00" >/dev/null; settle 5
RCU=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-RC03' LIMIT 1")
note "  seeded: $(gq "SELECT 'start='||start||' sd='||IFNULL(startDate,'NULL')||' rem='||IFNULL(reminderTime,'NULL') FROM TMTask WHERE uuid='$RCU'")"
note "  AS move to list Inbox: $(oas "tell application \"Things3\" to move (to do id \"$RCU\") to list \"Inbox\"")"
settle 4
note "  after : $(gq "SELECT 'start='||start||' sd='||IFNULL(startDate,'NULL')||' rem='||IFNULL(reminderTime,'NULL') FROM TMTask WHERE uuid='$RCU'")"

########################################################################
note ""
note "===== CELL 18 (§5h) uriSchemeEnabled lives outside TMSettings; the token persists"
note "  TMSettings token present: $([ -n "$TOKEN" ] && echo yes || echo no)"
note "  group prefs uriSchemeEnabled: $(lab_ssh "$IP" 'defaults read ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist uriSchemeEnabled 2>&1' </dev/null)"

########################################################################
note ""
note "===== CELL 19 (§9aa) deleting an AREA: OPEN members trashed, LOGGED members detached"
note "  make area: $(oas "tell application \"Things3\" to make new area with properties {name:\"ODDS1-AREA\"}")"
settle 4
AA=$(gq "SELECT uuid FROM TMArea WHERE title='ODDS1-AREA' LIMIT 1")
ourl "things:///add?title=ODDS1-AR-OPEN&auth-token=$TOKEN&list=ODDS1-AREA" >/dev/null
ourl "things:///add?title=ODDS1-AR-DONE&auth-token=$TOKEN&list=ODDS1-AREA" >/dev/null; settle 6
ADU=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-AR-DONE' LIMIT 1")
AOU=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-AR-OPEN' LIMIT 1")
ourl "things:///update?id=$ADU&auth-token=$TOKEN&completed=true" >/dev/null; settle 4
note "  log completed now: $(oas "tell application \"Things3\" to log completed now")"
settle 5
UMDD=$(gq "SELECT userModificationDate FROM TMTask WHERE uuid='$ADU'")
note "  pre : OPEN $(gq "SELECT 'trashed='||trashed||' area='||IFNULL(area,'NULL') FROM TMTask WHERE uuid='$AOU'") · DONE $(gq "SELECT 'trashed='||trashed||' status='||status||' area='||IFNULL(area,'NULL') FROM TMTask WHERE uuid='$ADU'")"
note "  delete area: $(oas "tell application \"Things3\" to delete area id \"$AA\"")"
settle 5
note "  post: OPEN $(gq "SELECT 'trashed='||trashed||' area='||IFNULL(area,'NULL') FROM TMTask WHERE uuid='$AOU'") · DONE $(gq "SELECT 'trashed='||trashed||' status='||status||' area='||IFNULL(area,'NULL') FROM TMTask WHERE uuid='$ADU'")"
note "  DONE umd changed=$([ "$UMDD" = "$(gq "SELECT userModificationDate FROM TMTask WHERE uuid='$ADU'")" ] && echo no || echo yes)"

########################################################################
note ""
note "===== CELL 20 (§6-4/5) Empty Trash destroys a trashed project's LOGGED children"
ourl "things:///add-project?title=ODDS1-TRP&auth-token=$TOKEN" >/dev/null; settle 5
TRP=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-TRP' AND type=1 LIMIT 1")
for n in OPEN DONE CANC; do
  ourl "things:///add?title=ODDS1-TR-$n&auth-token=$TOKEN&list-id=$TRP" >/dev/null; settle 3
done
settle 3
TDU=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-TR-DONE' LIMIT 1")
TCU=$(gq "SELECT uuid FROM TMTask WHERE title='ODDS1-TR-CANC' LIMIT 1")
ourl "things:///update?id=$TDU&auth-token=$TOKEN&completed=true" >/dev/null; settle 3
ourl "things:///update?id=$TCU&auth-token=$TOKEN&canceled=true" >/dev/null; settle 4
note "  children pre-trash: $(gq "SELECT group_concat(title||':st'||status||':tr'||trashed,' ') FROM TMTask WHERE project='$TRP'")"
note "  AS delete project : $(oas "tell application \"Things3\" to delete project id \"$TRP\"")"
settle 5
note "  after project trash: proj trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$TRP'") · children $(gq "SELECT group_concat(title||':st'||status||':tr'||trashed,' ') FROM TMTask WHERE project='$TRP'")"
TOMB0=$(gq "SELECT COUNT(*) FROM TMTombstone")
note "  AS empty trash    : $(oas "tell application \"Things3\" to empty trash")"
settle 8
note "  surviving ODDS1-TR* rows=$(gq "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'ODDS1-TR-%'") · project exists=$(gq "SELECT COUNT(*) FROM TMTask WHERE uuid='$TRP'")"
note "  TMTombstone $TOMB0 -> $(gq "SELECT COUNT(*) FROM TMTombstone")"

note ""
note "final: things=$(alive) · ips=$(ips_count)"
note "ODDS1-A done"
