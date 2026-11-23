#!/bin/bash
# REORD3242 — is `_private_experimental_ reorder to dos in …` still
# accepted-and-inert on Things 3.24.2, or did Cultured Code restore it?
#
# A TARGETED PROBE, not a certification. One throwaway clone of golden-v5
# (3.24 / 32400006), upgraded mid-sitting to the banked 3.24.2 direct-download
# build on the DRPLC1 recipe (quit, swap the bundle, warm-launch, POSITIVE
# CONTROL). The clock is pinned to the golden's date and NEVER rolled. The
# golden is never booted. Fixtures are fully synthetic. The clone is destroyed
# by an EXIT trap.
#
#   bash lab/scripts/research-reord3242.sh run
#   bash lab/scripts/research-reord3242.sh teardown   # rescue an orphaned clone
#
# Per scope (Inbox, project id, area by name, area by id, Today) the cell seeds
# three synthetic to-dos, records the ordering column, asks the private command
# for the REVERSE of the current order, and records exit code + stderr and the
# ordering column again, plus a full-row digest of the fixture rows and of the
# whole TMTask table. RESTORED = the DB order became the requested order;
# INERT = exit 0 and byte-identical rows.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-reord3242-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v5}"
ZIP="${ZIP:-/Volumes/Workspace/things-releases/Things3-3.24.2-32402008.zip}"
PIN="070512002026" # 2026-07-05 12:00 — golden-v5 pinnedDate; trial wall 2026-07-18
OUT="lab/artifacts/$VM"
REPORT="$OUT/report.txt"
IP=""

note() { echo "[reord3242] $*" | tee -a "$REPORT"; }

cleanup() {
  local code=$?
  echo "[reord3242] cleanup: destroying $VM" >&2
  tart stop "$VM" >/dev/null 2>&1 || true
  sleep 2
  tart delete "$VM" >/dev/null 2>&1 || true
  return $code
}

if [ "$CMD" = "teardown" ]; then
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  tart list
  exit 0
fi
[ "$CMD" = "run" ] || {
  echo "usage: $0 run|teardown" >&2
  exit 2
}

mkdir -p "$OUT"
: >"$REPORT"

GSQL='#!/bin/bash
FMT=(-noheader -list)
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
if [ "$1" = "--backup" ]; then exec sqlite3 "file:$DB?mode=ro" ".backup $2"; fi
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

gq() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
osa() { # osa <script> -> prints "RC=<n>" then stdout/stderr
  lab_ssh "$IP" "/usr/bin/osascript -e $(printf '%q' "$1") 2>/tmp/osa.err; echo RC=\$?; cat /tmp/osa.err" </dev/null 2>&1
}
openurl() { lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; }
waitsql() { # waitsql <sql> [tries] — poll until the query returns a non-empty row
  local i r
  for i in $(seq 1 "${2:-30}"); do
    r=$(gq "$1")
    [ -n "$r" ] && {
      echo "$r"
      return 0
    }
    sleep 1
  done
  return 1
}
appver() { lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString; defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null | tr '\n' '/'; }
dbver() { gq "SELECT value FROM Meta WHERE key='databaseVersion'" | tr -d '\n' | sed -E 's/.*<integer>([0-9]+)<\/integer>.*/\1/'; }
warm() {
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -g -a Things3; sleep 14; pgrep -x Things3 >/dev/null && echo RUNNING || echo NOT-RUNNING' </dev/null
}
pulldb() { # pulldb <tag> -> host path of a consistent copy of the guest DB
  lab_ssh "$IP" "rm -f /tmp/db-$1.sqlite; ~/labh/gsql.sh --backup /tmp/db-$1.sqlite" </dev/null
  sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "admin@$IP:/tmp/db-$1.sqlite" "$OUT/db-$1.sqlite" >/dev/null
  echo "$OUT/db-$1.sqlite"
}
fingerprint() { # fingerprint <host db path> -> "databaseVersion fingerprint"
  node -e '
    import("./src/db/fingerprint.ts").then(({ observeSchema }) => {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      const o = observeSchema(db);
      console.log(o.databaseVersion + " " + o.fingerprint);
    });' "$1" 2>/dev/null
}

# ---------------------------------------------------------------- boot
note "=== REORD3242 $(date) — clone $GOLDEN -> $VM ==="
[ -f "$ZIP" ] || {
  echo "no banked installer at $ZIP" >&2
  exit 1
}
note "zip: $ZIP sha256 $(shasum -a 256 "$ZIP" | cut -d' ' -f1)"
free=$(df -g /Volumes/Workspace | tail -1 | awk '{print $4}')
note "disk free: ${free}GiB"
[ "$free" -ge 10 ] || {
  echo "disk floor: only ${free}GiB free" >&2
  exit 1
}
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM" || exit 1
trap cleanup EXIT
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 600) || exit 1
note "guest ip: $IP"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
ag=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
note "airgap: $ag"
[ "$ag" = "AIRGAP-OK" ] || exit 1
# Pin BEFORE anything launches Things (SYNCX1): one launch past the wall burns the clone.
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to quit' >/dev/null 2>&1; sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
note "clock: $(lab_ssh "$IP" 'date' </dev/null)"
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
printf '%s\n' "$GSQL" | lab_ssh "$IP" 'cat > ~/labh/gsql.sh; chmod +x ~/labh/gsql.sh'

note "-- pre-upgrade (golden-v5 as cloned) --"
note "app: $(appver)  databaseVersion: $(dbver)"
note "schema (pre): $(fingerprint "$(pulldb pre)")"

# ---------------------------------------------------------------- upgrade (DRPLC1)
note "############ in-place upgrade to the banked build ############"
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 4; pkill -x Things3 >/dev/null 2>&1; sleep 2; pgrep -x Things3 >/dev/null && echo STILL-RUNNING || echo QUIT' </dev/null | tee -a "$REPORT"
sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$ZIP" "admin@$IP:/tmp/Things3.zip" >/dev/null
lab_ssh "$IP" 'set -e
  rm -rf /tmp/things-extract
  ditto -xk /tmp/Things3.zip /tmp/things-extract
  sudo rm -rf /Applications/Things3.app
  sudo mv /tmp/things-extract/Things3.app /Applications/Things3.app
  rm -rf /tmp/Things3.zip /tmp/things-extract
  codesign -dv /Applications/Things3.app 2>&1 | sed -n "1,3p"
  shasum -a 256 /Applications/Things3.app/Contents/Resources/Things.sdef' </dev/null | tee -a "$REPORT"
note "warm launch: $(warm)"
note "after: app $(appver)  databaseVersion: $(dbver)"
note "schema (post): $(fingerprint "$(pulldb post)")"
note "trial clock (container plist): $(lab_ssh "$IP" 'defaults read ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist firstAppLaunchDate 2>/dev/null || echo "(unset)"' </dev/null)"

# POSITIVE CONTROL — the trial wall is silent (REPX3): prove the app WRITES.
before=$(gq 'SELECT COUNT(*) FROM TMArea')
note "poscontrol create: $(osa 'tell application "Things3" to make new area with properties {name:"REORD3242-TRIALPROBE"}' | tr '\n' ' ')"
probe=$(waitsql "SELECT uuid FROM TMArea WHERE title='REORD3242-TRIALPROBE'" 15)
after=$(gq 'SELECT COUNT(*) FROM TMArea')
note "poscontrol: areas $before -> $after  probe uuid: ${probe:-(none)}"
if [ -z "$probe" ] || [ "$after" = "$before" ]; then
  note "STOP: the app accepted no write after the upgrade — trial wall or worse. Aborting."
  exit 9
fi
note "poscontrol delete: $(osa 'tell application "Things3" to delete area "REORD3242-TRIALPROBE"' | tr '\n' ' ')"
sleep 3
final=$(gq 'SELECT COUNT(*) FROM TMArea')
note "poscontrol: areas final $final (expected $before)"
[ "$final" = "$before" ] || {
  note "STOP: the positive-control delete did not land. Aborting."
  exit 9
}
note "POSITIVE CONTROL OK"

# ---------------------------------------------------------------- fixtures
note "-- seeding synthetic fixtures --"
note "area: $(osa 'tell application "Things3" to make new area with properties {name:"R3-AREA"}' | tr '\n' ' ')"
AREA=$(waitsql "SELECT uuid FROM TMArea WHERE title='R3-AREA'")
openurl "things:///add-project?title=R3-PROJ"
PROJ=$(waitsql "SELECT uuid FROM TMTask WHERE title='R3-PROJ' AND type=1")
note "area=$AREA proj=$PROJ"
for i in 1 2 3; do
  openurl "things:///add?title=R3-I$i"
  waitsql "SELECT uuid FROM TMTask WHERE title='R3-I$i'" >/dev/null
  openurl "things:///add?title=R3-P$i&list-id=$PROJ"
  waitsql "SELECT uuid FROM TMTask WHERE title='R3-P$i' AND project='$PROJ'" >/dev/null
  openurl "things:///add?title=R3-A$i&when=anytime&list-id=$AREA"
  waitsql "SELECT uuid FROM TMTask WHERE title='R3-A$i' AND area='$AREA'" >/dev/null
  openurl "things:///add?title=R3-T$i&when=today"
  waitsql "SELECT uuid FROM TMTask WHERE title='R3-T$i' AND todayIndex IS NOT NULL" >/dev/null
  sleep 1
done
sleep 3
note "fixture rows:"
gq "SELECT title, uuid, start, startBucket, \"index\", todayIndex, COALESCE(area,''), COALESCE(project,''), COALESCE(heading,'') FROM TMTask WHERE title LIKE 'R3-%' ORDER BY title" | tee -a "$REPORT"

# ---------------------------------------------------------------- cells
SUMMARY=()
cell() { # cell <name> <prefix> <ordercol> <specifier>
  local name="$1" pfx="$2" col="$3" spec="$4"
  note "==== cell $name — reorder to dos in $spec ($col) ===="
  local where="title LIKE '$pfx%' AND type=0 AND trashed=0"
  local order_sql="SELECT group_concat(title, ' < ') FROM (SELECT title FROM TMTask WHERE $where ORDER BY \"$col\", uuid)"
  local before_order before_rows before_all
  before_order=$(gq "$order_sql")
  before_rows=$(gq "SELECT * FROM TMTask WHERE $where ORDER BY uuid")
  before_all=$(gq "SELECT * FROM TMTask ORDER BY uuid" | shasum | cut -c1-16)
  note "before: $before_order"
  note "before $col: $(gq "SELECT group_concat(title || '=' || COALESCE(\"$col\",'NULL'), ' ') FROM (SELECT title, \"$col\" FROM TMTask WHERE $where ORDER BY title)")"
  # requested order = the REVERSE of the current order
  local ids want
  ids=$(gq "SELECT group_concat(uuid, ',') FROM (SELECT uuid FROM TMTask WHERE $where ORDER BY \"$col\" DESC, uuid DESC)")
  want=$(gq "SELECT group_concat(title, ' < ') FROM (SELECT title FROM TMTask WHERE $where ORDER BY \"$col\" DESC, uuid DESC)")
  note "requested: $want"
  local res
  res=$(osa "tell application \"Things3\" to _private_experimental_ reorder to dos in $spec with ids \"$ids\"")
  note "osascript: $(echo "$res" | tr '\n' ' ')"
  sleep 4
  local after_order after_rows after_all
  after_order=$(gq "$order_sql")
  after_rows=$(gq "SELECT * FROM TMTask WHERE $where ORDER BY uuid")
  after_all=$(gq "SELECT * FROM TMTask ORDER BY uuid" | shasum | cut -c1-16)
  note "after:  $after_order"
  note "after $col: $(gq "SELECT group_concat(title || '=' || COALESCE(\"$col\",'NULL'), ' ') FROM (SELECT title, \"$col\" FROM TMTask WHERE $where ORDER BY title)")"
  printf '%s\n' "$before_rows" >"$OUT/cell-$name-before.txt"
  printf '%s\n' "$after_rows" >"$OUT/cell-$name-after.txt"
  local rows_same="no"
  [ "$before_rows" = "$after_rows" ] && rows_same="yes"
  note "fixture rows byte-identical: $rows_same   whole-TMTask digest $before_all -> $after_all"
  local verdict
  if [ "$after_order" = "$want" ] && [ "$before_order" != "$want" ]; then
    verdict="RESTORED"
  elif [ "$rows_same" = "yes" ] && [ "$before_all" = "$after_all" ] && echo "$res" | grep -q '^RC=0'; then
    verdict="INERT"
  else
    verdict="OTHER"
  fi
  if [ "$rows_same" = "no" ]; then
    diff "$OUT/cell-$name-before.txt" "$OUT/cell-$name-after.txt" | tee -a "$REPORT"
  fi
  note "VERDICT $name: $verdict"
  SUMMARY+=("$name: $verdict")
}

cell inbox "R3-I" index 'list "Inbox"'
cell project-id "R3-P" index "project id \"$PROJ\""
cell area-name "R3-A" index 'area "R3-AREA"'
cell area-id "R3-A" index "area id \"$AREA\""
cell today "R3-T" todayIndex 'list "Today"'

note "-- app still running: $(lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo yes || echo no' </dev/null)"
note "-- crash reports since boot: $(lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports 2>/dev/null | grep -i things | tr "\n" " "' </dev/null)"
note "==== SUMMARY ===="
for s in "${SUMMARY[@]}"; do note "$s"; done
note "=== done — artifacts in $OUT ==="
exit 0
