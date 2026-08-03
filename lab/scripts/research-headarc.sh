#!/bin/bash
# HEADARC — archived-heading MOVE semantics micro-campaign.
#
# Maintainer GUI observation: moving an OPEN to-do into an ARCHIVED
# (status=completed) heading RE-OPENS the heading. Question: do the headless
# write surfaces share that semantic, and — because our resolveHeadingRef has NO
# status filter (type=2 AND trashed=0 AND project=?) — could a headless move
# strand an OPEN to-do under a section invisible in normal use (the PLOG1
# stranding hazard's heading cousin)?
#
#   ARM 1 (URL):  1a  update?id=<open todo>&list-id=<P>&heading=<archived name>
#                 1b  add?...&heading=<archived name>   (+ control: bad name)
#   ARM 2 (AS):   the AS primitives that could target a heading (there is no
#                 heading-placement verb — establish the negative), and re-verify
#                 un-archive-reopens-heading-only (children stay resolved) as the
#                 baseline the move-triggered reopen is compared against.
#   ARM 3 (CLI):  things todo move <x> --to-project P --to-heading <archived>
#                 BY NAME and BY UUID, --dry-run (compiled plan) then for-real.
#   ARM 4 (byte): headless byte-equivalence of the reopen across surfaces
#                 (URL-move reopen  vs  AS `set status to open` unarchive), and
#                 manufacture the odd state (archived heading + OPEN child) by
#                 reopening a child without touching the heading — for the GUI
#                 rendering oracle (VNC screenshots if $VNCDO is set).
#
# ONE disposable clone, autonomous. Discovery: no assertions; DB row deltas are
# ground truth. Golden things-lab-golden-v1 · Things 3.22.11 · pinned 2026-07-05.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"

AREA_A="7Ck4hAXU36jyaBsy2Fkije"   # LAB-AREA-A (golden seed)

VM="things-run-headarc-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[headarc] $*" | tee -a "$REPORT"; }
cleanup() { echo "[headarc] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"
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
uuid_of() { local t="$1" typ="${2:-}" w="title='$1' AND trashed=0" u i; [ -n "$typ" ] && w="$w AND type=$typ"; for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }

note "warm-up: launch Things, quit, relaunch (recompute Today for pinned date)"
lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3' </dev/null
lab_ssh "$IP" 'open -g -a Things3; sleep 8' </dev/null
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
note "token ok (${#TOKEN})"

########################################################################
note ""; note "############### FIXTURES via things:///json (HX0 pattern) ###############"
# Five projects, each: a heading with 2 children (to be archived -> cascade
# completes children) + a separate open unheaded movee added afterwards.
JSON='['
mkproj() { # $1=proj title  $2=heading title  (+2 children auto)
  echo -n '{"type":"project","attributes":{"title":"'"$1"'","area-id":"'$AREA_A'","items":['
  echo -n '{"type":"heading","attributes":{"title":"'"$2"'"}},'
  echo -n '{"type":"to-do","attributes":{"title":"'"$2"'-c1"}},'
  echo -n '{"type":"to-do","attributes":{"title":"'"$2"'-c2"}}]}}'
}
JSON+="$(mkproj HEADARC-PA HA),"
JSON+="$(mkproj HEADARC-PB HB),"
JSON+="$(mkproj HEADARC-P2 H2),"
JSON+="$(mkproj HEADARC-P3 H3),"
JSON+="$(mkproj HEADARC-P4 H4)"
JSON+=']'
ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$JSON")
lab_ssh "$IP" "open 'things:///json?data=$ENC&auth-token=$TOKEN'; sleep 4" </dev/null
PA=$(gq "SELECT uuid FROM TMTask WHERE title='HEADARC-PA' AND type=1 AND trashed=0")
PB=$(gq "SELECT uuid FROM TMTask WHERE title='HEADARC-PB' AND type=1 AND trashed=0")
P2=$(gq "SELECT uuid FROM TMTask WHERE title='HEADARC-P2' AND type=1 AND trashed=0")
P3=$(gq "SELECT uuid FROM TMTask WHERE title='HEADARC-P3' AND type=1 AND trashed=0")
P4=$(gq "SELECT uuid FROM TMTask WHERE title='HEADARC-P4' AND type=1 AND trashed=0")
HA=$(gq "SELECT uuid FROM TMTask WHERE title='HA' AND type=2 AND trashed=0")
HB=$(gq "SELECT uuid FROM TMTask WHERE title='HB' AND type=2 AND trashed=0")
H2=$(gq "SELECT uuid FROM TMTask WHERE title='H2' AND type=2 AND trashed=0")
H3=$(gq "SELECT uuid FROM TMTask WHERE title='H3' AND type=2 AND trashed=0")
H4=$(gq "SELECT uuid FROM TMTask WHERE title='H4' AND type=2 AND trashed=0")
note "PA=$PA HA=$HA | PB=$PB HB=$HB | P2=$P2 H2=$H2 | P3=$P3 H3=$H3 | P4=$P4 H4=$H4"
# movees (open, unheaded, project root) added AFTER project exists
gurl "things:///add?title=MA&list-id=$PA&auth-token=$TOKEN"
gurl "things:///add?title=M2&list-id=$P2&auth-token=$TOKEN"
gurl "things:///add?title=M3a&list-id=$P3&auth-token=$TOKEN"
gurl "things:///add?title=M3b&list-id=$P3&auth-token=$TOKEN"
gurl "things:///add?title=M4&list-id=$P4&auth-token=$TOKEN"
MA=$(uuid_of MA 0); M2=$(uuid_of M2 0); M3a=$(uuid_of M3a 0); M3b=$(uuid_of M3b 0); M4=$(uuid_of M4 0)
note "MA=$MA M2=$M2 M3a=$M3a M3b=$M3b M4=$M4"

# archive helper: set heading status to completed (the certified Archive recipe)
archive() { gas "tell application \"Things3\" to set status of to do id \"$1\" to completed"; sleep 1; }
# byte snapshot of a heading + its children + a movee
snap() { # $1 heading-uuid
  gsql "SELECT title, type, status, stopDate, trashed, substr(project,1,8) proj, substr(heading,1,8) head, \"index\" idx FROM TMTask WHERE uuid='$1' OR heading='$1' OR title IN ('MA','M2','M3a','M3b','M4','B-NEW','B-CTRL') ORDER BY type DESC, title" | tee -a "$REPORT"
}
note "-- archiving HA,HB,H2,H3,H4 (children cascade to completed) --"
archive "$HA"; archive "$HB"; archive "$H2"; archive "$H3"; archive "$H4"

########################################################################
note ""; note "############### ARM 1a (HEADARC-1a) — URL update: move OPEN MA into ARCHIVED HA by NAME ###############"
note "-- BEFORE (HA completed, children completed, MA open at PA root):"; snap "$HA"
gurl "things:///update?id=$MA&list-id=$PA&heading=HA&auth-token=$TOKEN"
note "-- AFTER (heading FK on MA? HA status 3->0 + stopDate NULL? children stay completed?):"; snap "$HA"

########################################################################
note ""; note "############### ARM 1b (HEADARC-1b) — URL add into ARCHIVED HB by NAME (+bad-name control) ###############"
note "-- BEFORE (HB completed):"; snap "$HB"
gurl "things:///add?title=B-NEW&list-id=$PB&heading=HB&auth-token=$TOKEN"
gurl "things:///add?title=B-CTRL&list-id=$PB&heading=HB-NONEXISTENT&auth-token=$TOKEN"
note "-- AFTER (B-NEW headed under HB? HB reopened? B-CTRL un-headed at root per oddity 2c?):"; snap "$HB"

########################################################################
note ""; note "############### ARM 2 (HEADARC-2) — AppleScript surface ###############"
note "-- 2i: does AS expose a heading-PLACEMENT verb? (all expected to FAIL) --"
note "  get heading of to do id M2:"; gas "tell application \"Things3\" to get heading of to do id \"$M2\"" | tee -a "$REPORT"
note "  set heading of to do id M2 to \"H2\":"; gas "tell application \"Things3\" to set heading of to do id \"$M2\" to \"H2\"" | tee -a "$REPORT"
note "  move to do id M2 to to do id H2 (heading as container):"; gas "tell application \"Things3\" to move to do id \"$M2\" to to do id \"$H2\"" | tee -a "$REPORT"
note "  set project of to do id M2 to project id (no heading param exists):"; gas "tell application \"Things3\" to set project of to do id \"$M2\" to project id \"$P2\"" | tee -a "$REPORT"
note "-- 2i post (did M2 land under H2 by any AS path? expect NO heading FK):"; snap "$H2"
note ""; note "-- 2ii: un-archive-reopens-heading-only baseline via AS (children stay resolved?) --"
note "  BEFORE (H2 completed, children completed):"; gsql "SELECT title,status,stopDate FROM TMTask WHERE uuid='$H2' OR heading='$H2' ORDER BY type DESC,title" | tee -a "$REPORT"
gas "tell application \"Things3\" to set status of to do id \"$H2\" to open"; sleep 1
note "  AFTER AS unarchive (H2 status 3->0 + stopDate NULL; children UNTOUCHED completed?):"; gsql "SELECT title,status,stopDate FROM TMTask WHERE uuid='$H2' OR heading='$H2' ORDER BY type DESC,title" | tee -a "$REPORT"

########################################################################
note ""; note "############### ARM 3 (HEADARC-3) — our CLI (guest production bundle) ###############"
note "build + ship node+dist+commander"
npm run build >/dev/null 2>&1
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules; rm -rf ~/things-lab/things-api/dist' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/dist"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
note "-- 3-dry-name: dry-run move M3a --to-project P3 --to-heading H3 (BY NAME):"
G todo move "$M3a" --to-project "$P3" --to-heading H3 --dry-run --json 2>&1 | tee -a "$REPORT"
note "-- 3-dry-uuid: dry-run move M3b --to-project P3 --to-heading $H3 (BY UUID):"
G todo move "$M3b" --to-project "$P3" --to-heading "$H3" --dry-run --json 2>&1 | tee -a "$REPORT"
note "-- 3-real-name: EXECUTE move M3a --to-heading H3 (by name):"; snap "$H3"
G todo move "$M3a" --to-project "$P3" --to-heading H3 --json 2>&1 | tee -a "$REPORT"
note "  AFTER (M3a headed under H3? H3 reopened? children?):"; snap "$H3"
note "-- 3-real-uuid: EXECUTE move M3b --to-heading $H3 (by uuid) [H3 now open again]:"
# re-archive H3 so the uuid arm also targets an ARCHIVED heading
archive "$H3"; note "  re-archived H3 for the uuid arm:"; gsql "SELECT title,status,stopDate FROM TMTask WHERE uuid='$H3'" | tee -a "$REPORT"
G todo move "$M3b" --to-project "$P3" --to-heading "$H3" --json 2>&1 | tee -a "$REPORT"
note "  AFTER (M3b headed under H3 by uuid? H3 reopened?):"; snap "$H3"

########################################################################
note ""; note "############### ARM 4 (HEADARC-4) — reopen byte-equivalence + odd-state manufacture ###############"
note "-- 4-eq: does the URL-move-triggered reopen write the SAME bytes as the AS unarchive?"
note "   (both should be status 3->0 AND stopDate->NULL on the heading row) --"
note "   HA (reopened by ARM-1a URL move) status/stopDate:"; gsql "SELECT status,stopDate FROM TMTask WHERE uuid='$HA'" | tee -a "$REPORT"
note "   H2 (reopened by ARM-2 AS set status open) status/stopDate:"; gsql "SELECT status,stopDate FROM TMTask WHERE uuid='$H2'" | tee -a "$REPORT"
note "-- 4-odd: manufacture (archived heading + OPEN child) by reopening a child WITHOUT touching the heading --"
H4C1=$(gq "SELECT uuid FROM TMTask WHERE title='H4-c1' AND trashed=0")
note "   BEFORE (H4 completed, H4-c1 completed):"; gsql "SELECT title,status,stopDate,substr(heading,1,8) head FROM TMTask WHERE uuid='$H4' OR uuid='$H4C1' ORDER BY type DESC" | tee -a "$REPORT"
gurl "things:///update?id=$H4C1&completed=false&auth-token=$TOKEN"
note "   AFTER (does reopening a CHILD reopen its heading? expect H4 STAYS completed, child open+still headed):"; gsql "SELECT title,status,stopDate,substr(heading,1,8) head FROM TMTask WHERE uuid='$H4' OR uuid='$H4C1' ORDER BY type DESC" | tee -a "$REPORT"

########################################################################
note ""; note "############### ARM 4 GUI RENDERING (VNC screenshots) ###############"
if [ -z "$VNCDO" ] || [ -z "$VNC_URL" ]; then
  note "VNCDO/VNC_URL unavailable — skipping GUI rendering captures (DB truth above stands)."
else
  HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
  PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
  V() { "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }
  shot() { V capture "$OUT/$1"; note "   [shot] $1"; }
  lab_ssh "$IP" 'open -a Things3; sleep 6' </dev/null
  note "-- P4: archived heading H4 with an OPEN child H4-c1 (the odd state) --"
  lab_ssh "$IP" "open 'things:///show?id=$P4'; sleep 3" </dev/null; shot "40-P4-archived-heading-open-child.png"
  note "-- PA: heading HA reopened by the move, MA now headed under it --"
  lab_ssh "$IP" "open 'things:///show?id=$PA'; sleep 3" </dev/null; shot "41-PA-reopened-heading.png"
  note "-- P2: heading H2 with swept (completed) children in the logged section --"
  lab_ssh "$IP" "open 'things:///show?id=$P2'; sleep 3" </dev/null; shot "42-P2-logged-section.png"
  note "-- Logbook: confirm it labels the parent PROJECT, never the heading --"
  lab_ssh "$IP" "open 'things:///show?id=logbook'; sleep 3" </dev/null; shot "43-logbook.png"
fi

########################################################################
note ""; note "== crash / DiagnosticReport check =="
lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo "Things3 ALIVE (no crash)" || echo "Things3 DEAD"' </dev/null | tee -a "$REPORT"
lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | grep -i things || echo "no Things crash reports"' </dev/null | tee -a "$REPORT"
note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 --"

note ""; note "== copying DB out =="
lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/headarc.sqlite"' </dev/null
lab_scp "$LAB_SSH_USER@$IP:/tmp/headarc.sqlite" "$OUT/final.sqlite" </dev/null 2>/dev/null || true
note "GREEN — report: $REPORT ; artifacts in $OUT"
trap - EXIT; cleanup
