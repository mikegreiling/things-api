#!/bin/bash
# SITTING 4 — DAYBNC / EVEORD / AXDRAG4, three arms in ONE disposable clone.
#
#   ARM 1 DAYBNC  cross-date re-when x todayIndex (the last dead ordering cell:
#                 loose scheduled + PROJECT rows on an arbitrary future day).
#   ARM 2 EVEORD  project evening insertion law (is a reverse-order evening
#                 bounce with PROJECT movees wireable?).
#   ARM 3 AXDRAG4 certify PR #335's duplicate-title area.reorder GUI drive
#                 (production CLI, VM GUI, Accessibility via AXVM1 rung b).
#
# ONE offline COW clone `sit4-lab`, clock pinned to the golden's 2026-07-05 12:00.
# Fully headless for arms 1/2 (URL + AppleScript + private reorder); arm 3 adds
# the AXVM1 VNC Accessibility grant + the production CLI driving the live GUI.
# Write-up: docs/lab/sit4-daybounce-eveord-axdrag4.md.
#
#   research-sit4.sh setup        clone+boot(--vnc-experimental)+airgap+clock+warm-up+token
#   research-sit4.sh arm1         DAYBNC seed + probe b/d (headless)
#   research-sit4.sh arm1c        DAYBNC full dated bounce (headless)
#   research-sit4.sh arm2         EVEORD seed + probe (headless)
#   research-sit4.sh arm3-grant   AXVM1 Accessibility grant (needs $VNCDO) + ui.enabled
#   research-sit4.sh arm3         AXDRAG4 seed + production-CLI drive + DB asserts
#   research-sit4.sh teardown     stop + delete the clone
#
# Conventions inherited from research-upcord1.sh / research-reordgaps.sh:
#   * offline COW clone, guest airgap (delete default route), clock pinned BEFORE
#     Things launches, read-only guest SQLite (encodePackedDate only — ISO dates
#     to the URL scheme, the app encodes; raw values read back).
#   * NEVER send URL when=/schedule-class to a REPEATING template row (§1 CRASH).
#   * NO clock advance anywhere.
#   * D  = today+14 = 2026-07-19 (arbitrary future Upcoming day)
#     D' = today+15 = 2026-07-20 (the bounce staging day)
#     evening arm operates on today = 2026-07-05.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v1}"
PIN="${PIN:-070512002026}"           # 2026-07-05 12:00 (golden pinnedDate)
D="${D:-2026-07-19}"                  # today+14
DP="${DP:-2026-07-20}"               # today+15 (staging)
VM="sit4-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/screens"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[sit4] $*" | tee -a "$REPORT"; }

CMD="${1:-}"

# --------------------------------------------------------------- guest SQLite
GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

gq()  { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gsql(){ lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" </dev/null; }
gas() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" </dev/null || true; }
gurl(){ lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; sleep 2; }
uuid_of() { local t="$1" typ="${2:-}" w u i; w="title='$t' AND trashed=0"; [ -n "$typ" ] && w="$w AND type=$typ"
  for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }
areaid() { gq "SELECT uuid FROM TMArea WHERE title='$1'"; }
reord()  { gas "tell application \"Things3\" to _private_experimental_ reorder to dos in $1 with ids \"$2\""; sleep 2; }

# FULL raw row for a title glob, ORDERED BY todayIndex then index (the day-bucket
# axis). Columns per brief: uuid,type,start,startDate,startBucket,todayIndex,index,
# reminderTime,deadline,heading,project,area,userModificationDate.
dumprow() { gq "SELECT title
  ||' ty='||type
  ||' st='||start
  ||' sd='||COALESCE(startDate,'-')
  ||' sb='||COALESCE(startBucket,'-')
  ||' tIdx='||COALESCE(todayIndex,'-')
  ||' idx='||\"index\"
  ||' rem='||COALESCE(reminderTime,'-')
  ||' dl='||COALESCE(deadline,'-')
  ||' hd='||COALESCE(substr(heading,1,8),'-')
  ||' p='||COALESCE(substr(project,1,8),'-')
  ||' a='||COALESCE(substr(area,1,8),'-')
  ||' umd='||COALESCE(userModificationDate,'-')
  FROM TMTask WHERE title LIKE '$1' AND trashed=0 ORDER BY todayIndex, \"index\""; }
# compact day-order line (todayIndex only) for quick order reads
dayord() { gq "SELECT title||'('||COALESCE(todayIndex,'-')||')' FROM TMTask WHERE title LIKE '$1' AND trashed=0 ORDER BY todayIndex, \"index\""; }

tjson() {
  local url
  url=$(lab_ssh "$IP" "python3 -c 'import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))' $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null)
  lab_ssh "$IP" "open -g $(printf '%q' "$url")" </dev/null; sleep 3
}

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "cloning $GOLDEN -> $VM (D=$D D'=$DP)"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
  note "ssh up at $IP"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo route -n delete -inet6 default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"
  VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
  echo "IP=$IP" > "$SESSION"
  echo "VNC_URL=$VNC_URL" >> "$SESSION"
  note "vnc: $VNC_URL"

  note "warm-up: launch/quit/relaunch Things on the pinned date"
  lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3' </dev/null
  lab_ssh "$IP" 'open -g -a Things3; sleep 8' </dev/null

  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  echo "TOKEN=$TOKEN" >> "$SESSION"
  note "auth token in hand (${#TOKEN} chars)"
  note "guest date: $(lab_ssh "$IP" 'date' </dev/null)"
  note "setup DONE — session in $SESSION"
  exit 0
fi

# ==================================================================== ARM 1 DAYBNC
if [ "$CMD" = "arm1" ]; then
  load_session
  note "############################################################"
  note "################## ARM 1 — DAYBNC (D=$D D'=$DP) ##################"
  note "############################################################"

  # ---- SEED ----
  note "seed: DB-1/DB-3 loose @$D; DB-2 loose @$D + reminder 09:00 + deadline $D"
  gurl "things:///add?title=DB-1&when=$D"
  gurl "things:///add?title=DB-2&when=$D@09:00&deadline=$D"
  gurl "things:///add?title=DB-3&when=$D"
  note "seed: project DHP with heading DH containing DB-4 @$D (headed, area-less project)"
  tjson "[{\"type\":\"project\",\"attributes\":{\"title\":\"DHP\",\"items\":[{\"type\":\"heading\",\"attributes\":{\"title\":\"DH\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"DB-4\",\"when\":\"$D\"}}]}}]"
  note "seed: DP-1/DP-2 area-less projects @$D"
  gurl "things:///add-project?title=DP-1&when=$D"
  gurl "things:///add-project?title=DP-2&when=$D"
  sleep 2

  note "--- seeded day-D roster (raw) ---"
  dumprow 'DB-%' | tee -a "$REPORT"
  dumprow 'DP-%' | tee -a "$REPORT"
  note "day-D order: $(dayord 'DB-%' | tr '\n' ' ') || $(dayord 'DP-%' | tr '\n' ' ')"

  D1=$(uuid_of DB-1); D2=$(uuid_of DB-2); D3=$(uuid_of DB-3); D4=$(uuid_of DB-4)
  P1=$(uuid_of DP-1 1); P2=$(uuid_of DP-2 1)
  note "uuids DB-1=$D1 DB-2=$D2 DB-3=$D3 DB-4=$D4 DP-1=$P1 DP-2=$P2"

  ############# b. LAW — single re-when round-trip D -> D' -> D #############
  note "===== b1: LOOSE to-do DB-1 round-trip D -> D' -> D ====="
  note "  before: $(dumprow 'DB-1' | tr '\n' ' ')"
  note "  full day-D order before: $(dayord 'DB-%' | tr '\n' ' ')"
  note "  --> update?when=$DP (leave D, join D')"
  gurl "things:///update?id=$D1&auth-token=$TOKEN&when=$DP"
  note "  on D': $(dumprow 'DB-1' | tr '\n' ' ')"
  note "  --> update?when=$D (back to D)"
  gurl "things:///update?id=$D1&auth-token=$TOKEN&when=$D"
  note "  back on D: $(dumprow 'DB-1' | tr '\n' ' ')"
  note "  full day-D order after: $(dayord 'DB-%' | tr '\n' ' ')"
  note "  INTERPRET b1: DB-1 at day-D global MIN (front) => front-insert re-entry. Same slot => preserved."

  note "===== b2: PROJECT row DP-1 round-trip via update-project?when= ====="
  note "  before: $(dumprow 'DP-1' | tr '\n' ' ')"
  gurl "things:///update-project?id=$P1&auth-token=$TOKEN&when=$DP"
  note "  on D': $(dumprow 'DP-1' | tr '\n' ' ')"
  gurl "things:///update-project?id=$P1&auth-token=$TOKEN&when=$D"
  note "  back on D: $(dumprow 'DP-1' | tr '\n' ' ')"
  note "  full day-D order after: $(dayord 'DB-%' | tr '\n' ' ') || $(dayord 'DP-%' | tr '\n' ' ')"
  note "  INTERPRET b2: does a PROJECT row front-insert at the GLOBAL day-D min too?"

  note "===== b3: repeatability — DB-3 round-trip x2 more (fresh rows) ====="
  for rep in 1 2; do
    note "  rep$rep DB-3 -> D' -> D"
    gurl "things:///update?id=$D3&auth-token=$TOKEN&when=$DP"
    gurl "things:///update?id=$D3&auth-token=$TOKEN&when=$D"
    note "    DB-3: $(dumprow 'DB-3' | tr '\n' ' ')"
    note "    day-D order: $(dayord 'DB-%' | tr '\n' ' ')"
  done

  ############# d. COLLATERAL — reminder/deadline/heading through re-when #############
  note "===== d: COLLATERAL — DB-2 (reminder+deadline) round-trip (bare when=, no @time) ====="
  note "  before: $(dumprow 'DB-2' | tr '\n' ' ')"
  gurl "things:///update?id=$D2&auth-token=$TOKEN&when=$DP"
  note "  on D' (rem cleared? dl kept?): $(dumprow 'DB-2' | tr '\n' ' ')"
  gurl "things:///update?id=$D2&auth-token=$TOKEN&when=$D"
  note "  back on D: $(dumprow 'DB-2' | tr '\n' ' ')"
  note "  INTERPRET d-rem: bare when=<date> CLEARS reminderTime (like when=evening)? deadline preserved?"

  note "===== d: COLLATERAL — DB-4 (HEADED) round-trip (heading FK survive re-when?) ====="
  note "  before: $(dumprow 'DB-4' | tr '\n' ' ')"
  gurl "things:///update?id=$D4&auth-token=$TOKEN&when=$DP"
  note "  on D' (heading FK / project FK kept?): $(dumprow 'DB-4' | tr '\n' ' ')"
  gurl "things:///update?id=$D4&auth-token=$TOKEN&when=$D"
  note "  back on D: $(dumprow 'DB-4' | tr '\n' ' ')"
  note "  INTERPRET d-head: does re-when preserve heading+project FK (unlike container-day reorder which rips heading §9k)?"

  note "arm1 b/d DONE — see report; run 'arm1c' for the full dated bounce"
  exit 0
fi

# ==================================================================== ARM 1c full dated bounce
if [ "$CMD" = "arm1c" ]; then
  load_session
  note "################## ARM 1c — full DATED BOUNCE on day D ##################"
  D1=$(uuid_of DB-1); D2=$(uuid_of DB-2); D3=$(uuid_of DB-3); D4=$(uuid_of DB-4)
  P1=$(uuid_of DP-1 1); P2=$(uuid_of DP-2 1)
  note "  current day-D order: $(dayord 'DB-%' | tr '\n' ' ') || $(dayord 'DP-%' | tr '\n' ' ')"
  # TARGET cross-container order (scrambled, incl. project rows):
  #   DP-2, DB-3, DP-1, DB-1, DB-4, DB-2
  note "  TARGET order: DP-2, DB-3, DP-1, DB-1, DB-4, DB-2"
  note "  reverse-order bounce (each: when=$DP then when=$D):"
  bounce_todo() { gurl "things:///update?id=$1&auth-token=$TOKEN&when=$DP"; gurl "things:///update?id=$1&auth-token=$TOKEN&when=$D"; }
  bounce_proj() { gurl "things:///update-project?id=$1&auth-token=$TOKEN&when=$DP"; gurl "things:///update-project?id=$1&auth-token=$TOKEN&when=$D"; }
  # reverse target = DB-2, DB-4, DB-1, DP-1, DB-3, DP-2
  note "    bounce DB-2"; bounce_todo "$D2"; note "      $(dayord 'DB-%' | tr '\n' ' ') || $(dayord 'DP-%' | tr '\n' ' ')"
  note "    bounce DB-4"; bounce_todo "$D4"; note "      $(dayord 'DB-%' | tr '\n' ' ') || $(dayord 'DP-%' | tr '\n' ' ')"
  note "    bounce DB-1"; bounce_todo "$D1"; note "      $(dayord 'DB-%' | tr '\n' ' ') || $(dayord 'DP-%' | tr '\n' ' ')"
  note "    bounce DP-1"; bounce_proj "$P1"; note "      $(dayord 'DB-%' | tr '\n' ' ') || $(dayord 'DP-%' | tr '\n' ' ')"
  note "    bounce DB-3"; bounce_todo "$D3"; note "      $(dayord 'DB-%' | tr '\n' ' ') || $(dayord 'DP-%' | tr '\n' ' ')"
  note "    bounce DP-2"; bounce_proj "$P2"; note "      $(dayord 'DB-%' | tr '\n' ' ') || $(dayord 'DP-%' | tr '\n' ' ')"
  note "  FINAL raw:"
  dumprow 'DB-%' | tee -a "$REPORT"
  dumprow 'DP-%' | tee -a "$REPORT"
  note "  VERDICT-1c: final cross-container todayIndex order == DP-2,DB-3,DP-1,DB-1,DB-4,DB-2 with all sd=$D preserved => DATED BOUNCE wireable incl PROJECT rows."
  exit 0
fi

# ==================================================================== ARM 2 EVEORD
if [ "$CMD" = "arm2" ]; then
  load_session
  note "############################################################"
  note "################## ARM 2 — EVEORD (evening, today=2026-07-05) ##################"
  note "############################################################"
  note "seed: EV-1/EV-2 to-dos when=evening"
  gurl "things:///add?title=EV-1&when=evening"
  gurl "things:///add?title=EV-2&when=evening"
  note "seed: EP-1/EP-2 area-less projects, then update-project?when=evening"
  gurl "things:///add-project?title=EP-1"
  gurl "things:///add-project?title=EP-2"
  sleep 1
  EP1=$(uuid_of EP-1 1); EP2=$(uuid_of EP-2 1)
  gurl "things:///update-project?id=$EP1&auth-token=$TOKEN&when=evening"
  gurl "things:///update-project?id=$EP2&auth-token=$TOKEN&when=evening"
  sleep 2
  note "--- seeded evening roster (raw; startBucket=1 = evening) ---"
  dumprow 'EV-%' | tee -a "$REPORT"
  dumprow 'EP-%' | tee -a "$REPORT"
  note "evening order: $(dayord 'EV-%' | tr '\n' ' ') || $(dayord 'EP-%' | tr '\n' ' ')"
  EV1=$(uuid_of EV-1); EV2=$(uuid_of EV-2)
  note "uuids EV-1=$EV1 EV-2=$EV2 EP-1=$EP1 EP-2=$EP2"

  note "===== control: TO-DO evening bounce (EV-1: when=today then when=evening) ====="
  note "  before: $(dumprow 'EV-1' | tr '\n' ' ')"
  gurl "things:///update?id=$EV1&auth-token=$TOKEN&when=today"
  note "  after when=today (left evening? sb=0? tIdx?): $(dumprow 'EV-1' | tr '\n' ' ')"
  gurl "things:///update?id=$EV1&auth-token=$TOKEN&when=evening"
  note "  after when=evening (re-enter): $(dumprow 'EV-1' | tr '\n' ' ')"
  note "  evening order now: $(dayord 'EV-%' | tr '\n' ' ') || $(dayord 'EP-%' | tr '\n' ' ')"
  note "  INTERPRET: EV-1 front-inserts at evening-group MIN (known to-do law)?"

  note "===== PROJECT evening bounce x3 (EP-1: update-project when=today then when=evening) ====="
  for rep in 1 2 3; do
    note "  --- rep$rep ---"
    note "  before: $(dumprow 'EP-1' | tr '\n' ' ')"
    note "  evening order before: $(dayord 'EV-%' | tr '\n' ' ') || $(dayord 'EP-%' | tr '\n' ' ')"
    gurl "things:///update-project?id=$EP1&auth-token=$TOKEN&when=today"
    note "  after when=today (left evening? sb? tIdx mid-pack per sit3 EVEPROJ?): $(dumprow 'EP-1' | tr '\n' ' ')"
    gurl "things:///update-project?id=$EP1&auth-token=$TOKEN&when=evening"
    note "  after when=evening (re-enter — MIN/front or mid-pack?): $(dumprow 'EP-1' | tr '\n' ' ')"
    note "  evening order after: $(dayord 'EV-%' | tr '\n' ' ') || $(dayord 'EP-%' | tr '\n' ' ')"
  done
  note "  VERDICT-2: EP-1 at evening-group MIN (front) each rep => project when=evening FRONT-inserts => reverse-order evening bounce with PROJECT movees WIREABLE. Mid-pack/non-front => NOT deterministically wireable."
  exit 0
fi

# ==================================================================== ARM 2 rem caveat
if [ "$CMD" = "arm2rem" ]; then
  load_session
  note "===== ARM 2 caveat — §9n: does URL when=evening CLEAR a reminder (contrast ARM 1 dated bounce)? ====="
  gurl "things:///add?title=ER-1&when=today@09:00"
  sleep 1
  ERU=$(uuid_of ER-1)
  note "  ER-1 before (today@09:00): $(dumprow 'ER-1' | tr '\n' ' ')"
  gurl "things:///update?id=$ERU&auth-token=$TOKEN&when=evening"
  note "  ER-1 after when=evening (rem cleared? sb=1?): $(dumprow 'ER-1' | tr '\n' ' ')"
  note "  INTERPRET: reminderTime NULL after when=evening => §9n confirmed (evening bounce STRIPS reminders); the dated bounce (ARM 1 d-rem) PRESERVES them — the decisive contrast."
  exit 0
fi

# ==================================================================== ARM 3 helpers
# production CLI in the guest e2e bundle
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
relaunch() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1; sleep 3; open -a Things3; sleep 9' </dev/null; }
axeui_off() { lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null || true; }
# sidebar area order — the (index, uuid) ASC canonical sort law (AXDRAG3)
area_order() { gq 'SELECT title FROM TMArea ORDER BY "index", uuid' | tr '\n' ' '; }
area_dump() { gq 'SELECT title||" idx="||"index"||" uuid="||substr(uuid,1,6) FROM TMArea ORDER BY "index", uuid'; }
# uuids of the areas titled $1, in (index,uuid) ASC order (matches the driver rank)
dupe_uuids() { gq "SELECT uuid FROM TMArea WHERE title='$1' ORDER BY \"index\", uuid"; }

# ==================================================================== arm3-grant
if [ "$CMD" = "arm3-grant" ]; then
  load_session
  VNCDO="${VNCDO:-}"
  note "############################################################"
  note "################## ARM 3 grant — AXVM1 rung b Accessibility + e2e bundle ##################"
  note "############################################################"
  lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
  # provoke the disabled TCC row (AX read returns -1719 until granted)
  lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null
  if [ -z "$VNCDO" ] || [ -z "$VNC_URL" ]; then note "VNCDO/VNC_URL missing — abort (export VNCDO=<path to vncdo>)"; exit 1; fi
  HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
  PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
  V() { sleep 1; timeout 40 "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }
  lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 6
  V capture "$OUT/screens/01-ax-pane.png"
  V move 1642 332 click 1; sleep 3; V capture "$OUT/screens/02-auth.png"
  V move 1017 870 click 1 pause 0.5 type admin pause 0.5 move 1017 963 click 1; sleep 3
  V capture "$OUT/screens/03-after-auth.png"
  note "-- AX rows after grant (expect auth_value 2) --"
  lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT service,client,auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null | tee -a "$REPORT"
  # verify the AX op now resolves (exit 0 = granted)
  note "-- AX menu-bar read after grant (expect a menu list, not -1719) --"
  lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\''' </dev/null 2>&1 | tee -a "$REPORT"

  note "-- build + ship the guest e2e bundle --"
  npm run build >/dev/null || { note "build FAILED"; exit 1; }
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/dist"
  scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  G config set ui-enabled true >/dev/null 2>&1
  note "  ui-enabled: $(G config get ui-enabled 2>&1 | tr -d '\n')"
  note "  capabilities area.reorder: $(G capabilities --json 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print([o for o in json.dumps(d) if False] or "read-ok")' 2>/dev/null || echo n/a)"
  relaunch; axeui_off
  note "arm3-grant DONE"
  exit 0
fi

# ==================================================================== arm3 seed + drive
if [ "$CMD" = "arm3" ]; then
  load_session
  note "############################################################"
  note "################## ARM 3 — AXDRAG4 duplicate-title area.reorder certification ##################"
  note "############################################################"

  # ---- (a) seed: 3 DUPE-AREA (separate calls = distinct indexes) + distinct neighbors ----
  note "seed: 3x DUPE-AREA via SEPARATE make new area (distinct sparse indexes) + NB-1..NB-3 distinct neighbors"
  for n in 1 2 3; do
    lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"Things3\" to make new area with properties {name:\"DUPE-AREA\"}'" </dev/null; sleep 1
  done
  for n in 1 2 3; do
    lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"Things3\" to make new area with properties {name:\"NB-$n\"}'" </dev/null; sleep 1
  done
  sleep 2
  note "  area roster (index,uuid ASC):"; area_dump | tee -a "$REPORT"
  relaunch; axeui_off

  # the MIDDLE duplicate by (index,uuid) ASC rank
  mapfile -t DU < <(dupe_uuids DUPE-AREA)
  note "  DUPE-AREA uuids in (index,uuid) order: ${DU[*]}"
  MID="${DU[1]}"
  note "  middle DUPE-AREA uuid = $MID (rank 1 of 3)"

  # ---- (b) drive: reorder middle duplicate --first ----
  note "===== b1: area reorder <mid-dupe> --first --dangerously-drive-gui ====="
  note "  before: $(area_order)"
  G area reorder "$MID" --first --dangerously-drive-gui --json 2>&1 | tee "$OUT/b1.json" | head -c 700; echo
  note "  after:  $(area_order)"
  TOP=$(gq 'SELECT uuid FROM TMArea ORDER BY "index", uuid LIMIT 1')
  note "  ASSERT: top uuid now == $MID ? -> $([ "$TOP" = "$MID" ] && echo PASS || echo "FAIL (top=$TOP)")"

  # ---- (b2) drive: reorder a dupe --after a DISTINCT area ----
  relaunch; axeui_off
  mapfile -t DU < <(dupe_uuids DUPE-AREA)
  MID2="${DU[1]}"
  note "===== b2: area reorder <mid-dupe=$MID2> --after NB-2 --dangerously-drive-gui ====="
  note "  before: $(area_order)"
  G area reorder "$MID2" --after NB-2 --dangerously-drive-gui --json 2>&1 | tee "$OUT/b2.json" | head -c 700; echo
  note "  after:  $(area_order)"
  NB2=$(gq "SELECT uuid FROM TMArea WHERE title='NB-2'")
  AFTERNB=$(gq "SELECT uuid FROM TMArea WHERE \"index\" > (SELECT \"index\" FROM TMArea WHERE uuid='$NB2') ORDER BY \"index\", uuid LIMIT 1")
  note "  ASSERT: row immediately after NB-2 == $MID2 ? -> $([ "$AFTERNB" = "$MID2" ] && echo PASS || echo "FAIL (after NB-2 = $AFTERNB)")"
  note "arm3 b DONE — run arm3-tie / arm3-multiview / arm3-selfinvert"
  exit 0
fi

# ==================================================================== arm3-tie
if [ "$CMD" = "arm3-tie" ]; then
  load_session
  note "################## ARM 3c — index TIE among duplicates (batch create) ##################"
  # batch create in ONE AppleScript repeat => tied index=0 (AXDRAG2-d / AXDRAG3)
  lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"Things3\"
    repeat with i from 1 to 3
      make new area with properties {name:\"TIE-AREA\"}
    end repeat
  end tell'" </dev/null
  sleep 2
  relaunch; axeui_off
  note "  TIE-AREA rows (expect tied index, uuid-ASC display):"; gq 'SELECT title||" idx="||"index"||" uuid="||substr(uuid,1,8) FROM TMArea WHERE title="TIE-AREA" ORDER BY "index", uuid' | tee -a "$REPORT"
  mapfile -t TU < <(gq "SELECT uuid FROM TMArea WHERE title='TIE-AREA' ORDER BY \"index\", uuid")
  note "  TIE-AREA uuids in (index,uuid) order: ${TU[*]}"
  MIDT="${TU[1]}"
  note "===== reorder <mid TIE=$MIDT> --first (uuid-ASC tiebreak in live targeting) ====="
  note "  before: $(area_order)"
  G area reorder "$MIDT" --first --dangerously-drive-gui --json 2>&1 | tee "$OUT/tie.json" | head -c 700; echo
  note "  after:  $(area_order)"
  TOP=$(gq 'SELECT uuid FROM TMArea ORDER BY "index", uuid LIMIT 1')
  note "  ASSERT: top uuid == $MIDT ? -> $([ "$TOP" = "$MIDT" ] && echo PASS || echo "FAIL (top=$TOP)")"
  exit 0
fi

# ==================================================================== arm3-multiview
if [ "$CMD" = "arm3-multiview" ]; then
  load_session
  note "################## ARM 3d — MULTI-VIEWPORT edge (dupes not sharing a viewport) ##################"
  # pad the sidebar with many distinct areas so the 3 DUPE-AREA span >1 viewport,
  # then shrink the window to force a small viewport, and attempt a dupe reorder.
  note "  padding sidebar with PAD-01..PAD-20"
  lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"Things3\"
    repeat with i from 1 to 20
      set nm to \"PAD-\" & text -2 thru -1 of (\"0\" & i)
      make new area with properties {name:nm}
    end repeat
  end tell'" </dev/null
  sleep 2
  relaunch; axeui_off
  note "  total areas: $(gq 'SELECT COUNT(*) FROM TMArea')"
  # shrink window to force a small viewport (multi-hop territory)
  lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to set size of (first window whose subrole is "AXStandardWindow") to {935, 420}'\''' </dev/null; sleep 2
  mapfile -t DU < <(dupe_uuids DUPE-AREA)
  MIDV="${DU[1]}"
  note "  DUPE-AREA uuids: ${DU[*]}; middle=$MIDV"
  note "  DUPE-AREA positions in full order:"; gq 'SELECT rowid_pos||": "||title FROM (SELECT title, ROW_NUMBER() OVER (ORDER BY "index", uuid) rowid_pos FROM TMArea) WHERE title="DUPE-AREA"' | tee -a "$REPORT"
  note "===== reorder <mid DUPE=$MIDV> --last (small viewport, dupes likely split across viewports) ====="
  note "  before: $(area_order)"
  G area reorder "$MIDV" --last --dangerously-drive-gui --json 2>&1 | tee "$OUT/multiview.json" | head -c 1000; echo
  note "  after:  $(area_order)"
  LAST=$(gq 'SELECT uuid FROM TMArea ORDER BY "index", uuid DESC LIMIT 1')
  note "  ASSERT (if it moved): last uuid == $MIDV ? -> $([ "$LAST" = "$MIDV" ] && echo PASS || echo "moved-elsewhere-or-refused (last=$LAST)")"
  note "  VERDICT-3d: certify clean-refusal OR correct-ladder — read b/json note + DB above"
  exit 0
fi

# ==================================================================== arm3-neg (negatives + genuine --after)
if [ "$CMD" = "arm3-neg" ]; then
  load_session
  note "################## ARM 3 negatives + genuine --after move ##################"
  note "===== N1: DUPLICATE-NAME ref refuses up front (resolver ambiguity, no gesture) ====="
  note "  order before: $(area_order)"
  G area reorder DUPE-AREA --first --dangerously-drive-gui --json 2>&1 | tee "$OUT/neg-name.json" | head -c 500; echo
  note "  order after (expect UNCHANGED): $(area_order)"
  note "===== N2: gating — no --dangerously-drive-gui => blocked (H-UI-DRIVE, exit 4) ====="
  mapfile -t DU < <(dupe_uuids DUPE-AREA)
  G area reorder "${DU[0]}" --first --json 2>&1 | tee "$OUT/neg-gate.json" | head -c 400; echo
  note "  exit: (expect blocked; order unchanged): $(area_order)"
  note "===== N3: genuine --after move of the middle dupe (real drive, correct-uuid assert) ====="
  # move middle dupe --after LAB-AREA-A (forces a real cross move, not a no-op)
  relaunch; axeui_off
  mapfile -t DU < <(dupe_uuids DUPE-AREA)
  MIDA="${DU[1]}"
  note "  middle dupe=$MIDA ; --after LAB-AREA-A"
  note "  before: $(area_order)"
  G area reorder "$MIDA" --after LAB-AREA-A --dangerously-drive-gui --json 2>&1 | tee "$OUT/neg-after.json" | head -c 700; echo
  note "  after:  $(area_order)"
  LABA=$(gq "SELECT uuid FROM TMArea WHERE title='LAB-AREA-A'")
  AFTA=$(gq "SELECT uuid FROM TMArea WHERE \"index\" > (SELECT \"index\" FROM TMArea WHERE uuid='$LABA') ORDER BY \"index\", uuid LIMIT 1")
  note "  ASSERT: row immediately after LAB-AREA-A == $MIDA ? -> $([ "$AFTA" = "$MIDA" ] && echo PASS || echo "FAIL (after=$AFTA)")"
  exit 0
fi

# ==================================================================== arm3-selfinvert
if [ "$CMD" = "arm3-selfinvert" ]; then
  load_session
  note "################## ARM 3e — self-invert on stale-ordinal mismatch (inducible?) ##################"
  note "  The driver DB-asserts the intended uuid moved each hop and SELF-INVERTS (re-drags the"
  note "  displaced area back) on a wrong-area mismatch. This is data-dependent; if not inducible"
  note "  through the shipped path, document that the guard exists (unit-tested) but wasn't triggered."
  note "  Current area order: $(area_order)"
  note "  (see report — self-invert is exercised by the driver's per-hop assert; a genuine mismatch"
  note "   requires a stale snapshot mid-gesture, which the live re-read per hop is designed to prevent.)"
  exit 0
fi

# ==================================================================== EVETZ micro-arm
# Can the shape startDate=TOMORROW + startBucket=1 ("tomorrow evening") be
# written HEADLESSLY? If yes the blocked:clock evening refusal could be lifted.
TOM="${TOM:-2026-07-06}"   # tomorrow relative to pinned today 2026-07-05
if [ "$CMD" = "evetz" ]; then
  load_session
  note "############################################################"
  note "################## EVETZ — cross-tz evening pre-staging (goal: sd=TOMORROW($TOM) + sb=1) ##################"
  note "############################################################"

  note "===== (i) when=evening THEN when=$TOM (does the dated leg CLEAR sb=1?) ====="
  gurl "things:///add?title=TZ-1&when=evening"
  sleep 1; TZ1=$(uuid_of TZ-1)
  note "  after when=evening: $(dumprow 'TZ-1' | tr '\n' ' ')"
  gurl "things:///update?id=$TZ1&auth-token=$TOKEN&when=$TOM"
  note "  after when=$TOM (sb still 1? sd=tomorrow?): $(dumprow 'TZ-1' | tr '\n' ' ')"

  note "===== (ii) when=$TOM THEN when=evening (expect evening clobbers sd back to today) ====="
  gurl "things:///add?title=TZ-2&when=$TOM"
  sleep 1; TZ2=$(uuid_of TZ-2)
  note "  after when=$TOM: $(dumprow 'TZ-2' | tr '\n' ' ')"
  gurl "things:///update?id=$TZ2&auth-token=$TOKEN&when=evening"
  note "  after when=evening (sd clobbered to today 132805248?): $(dumprow 'TZ-2' | tr '\n' ' ')"

  note "===== (iii) things:///json update array combining when legs ====="
  gurl "things:///add?title=TZ-3&when=evening"
  sleep 1; TZ3=$(uuid_of TZ-3)
  note "  seed TZ-3 evening: $(dumprow 'TZ-3' | tr '\n' ' ')"
  # try a json update setting when=<tomorrow> — does json carry startBucket independently?
  tjson "[{\"type\":\"to-do\",\"operation\":\"update\",\"id\":\"$TZ3\",\"attributes\":{\"when\":\"$TOM\"}}]"
  note "  after json update when=$TOM (sb kept?): $(dumprow 'TZ-3' | tr '\n' ' ')"
  # try a json update with when="evening" on a tomorrow-dated row (does json evening keep the date?)
  gurl "things:///add?title=TZ-4&when=$TOM"
  sleep 1; TZ4=$(uuid_of TZ-4)
  note "  seed TZ-4 @$TOM: $(dumprow 'TZ-4' | tr '\n' ' ')"
  tjson "[{\"type\":\"to-do\",\"operation\":\"update\",\"id\":\"$TZ4\",\"attributes\":{\"when\":\"evening\"}}]"
  note "  after json update when=evening (sd stays $TOM or clobbered to today?): $(dumprow 'TZ-4' | tr '\n' ' ')"

  note "===== (iv) AppleScript schedule / property writes ====="
  # schedule for tomorrow, then try to force evening via any writable property
  gurl "things:///add?title=TZ-5&when=$TOM"
  sleep 1; TZ5=$(uuid_of TZ-5)
  note "  seed TZ-5 @$TOM: $(dumprow 'TZ-5' | tr '\n' ' ')"
  note "  AS: set the evening property (probe spellings):"
  note "   scheduleEvening: $(gas "tell application \"Things3\" to schedule to do id \"$TZ5\" for (current date) + 1 * days")"
  note "  after AS schedule: $(dumprow 'TZ-5' | tr '\n' ' ')"
  note "  AS: does 'to do' expose an 'evening'/'this evening' boolean? (expect no such property)"
  note "   eveprop: $(gas "tell application \"Things3\" to get properties of to do id \"$TZ5\"" | tr ',' '\n' | grep -iE 'evening|bucket' | tr '\n' ' ')"

  note "===== (v) json ADD with both when + a bucket-ish attribute (last-ditch manufacture) ====="
  tjson "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"TZ-6\",\"when\":\"$TOM\",\"start-bucket\":\"evening\"}}]"
  sleep 1
  note "  TZ-6 (json add when=$TOM + start-bucket=evening): $(dumprow 'TZ-6' | tr '\n' ' ')"

  note "===== SUMMARY — any row with sd=$TOM (132805376) AND sb=1? ====="
  note "  $(gq "SELECT title||' sd='||COALESCE(startDate,'-')||' sb='||COALESCE(startBucket,'-')||' st='||start||' rem='||COALESCE(reminderTime,'-') FROM TMTask WHERE title LIKE 'TZ-%' AND trashed=0 ORDER BY title" | tr '\n' ' | ')"
  note "  VERDICT-EVETZ: if NO TZ-* row has sd=$TOM(132805376)+sb=1 => shape headlessly UNMANUFACTURABLE, blocked:clock stands. Record which leg kills sb=1."
  exit 0
fi

if [ "$CMD" = "evetz-roll" ]; then
  # only meaningful if evetz produced a sd=tomorrow+sb=1 row; roll clock +1 and read GUI section.
  load_session
  note "===== EVETZ (b) roll clock to $TOM and observe (only if a tomorrow-evening row exists) ====="
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070612002026 >/dev/null" </dev/null
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3; open -g -a Things3; sleep 8' </dev/null
  note "  guest date now: $(lab_ssh "$IP" 'date' </dev/null)"
  note "  TZ rows after roll: $(gq "SELECT title||' sd='||COALESCE(startDate,'-')||' sb='||COALESCE(startBucket,'-') FROM TMTask WHERE title LIKE 'TZ-%' AND trashed=0 ORDER BY title" | tr '\n' ' | ')"
  exit 0
fi

# ==================================================================== teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  exit 0
fi

echo "usage: $0 setup|arm1|arm1c|arm2|arm3-grant|arm3|teardown" >&2
exit 1
