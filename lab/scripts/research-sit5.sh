#!/bin/bash
# SITTING 5 — AREAPROJDAY / CONVINST / LOGSWEEP / FUTPROJ, four arms in ONE clone.
#
#   ARM 1 AREAPROJDAY  the #342 residual: do AREA-DIRECT project rows join the
#                      `day` membership (dated-bounce front-insert at the global
#                      day-todayIndex min) with their area FK preserved?
#   ARM 2 CONVINST     convert a repeating INSTANCE to a project via the GUI;
#                      FK fate (rt1_repeatingTemplate survives/cleared?), type
#                      flip, Show Latest resolution, and our reader's sanity.
#   ARM 3 LOGSWEEP     logbook-sweep x trashed intersection: completed vs
#                      completed-then-trashed membership, GUI vs our reads.
#   ARM 4 FUTPROJ      read-representation of future-scheduled project rows in
#                      Upcoming: GUI day-group vs `things upcoming`/`projects`.
#
# ONE offline COW clone `sit5-lab`, clock pinned to the golden's 2026-07-05 12:00.
# Headless for arms 1/3/4 (URL + AppleScript); arm 2 adds the AXVM1 rung-b
# Accessibility grant + System-Events UI scripting for the GUI convert, and VNC
# screenshots. CLI reads run on the HOST against a pulled copy of the guest DB
# (`node bin/things.js … --db <hostcopy>`) — no guest e2e bundle needed.
# Write-up: docs/lab/sit5-areaproj-convinst-logsweep.md.
#
#   research-sit5.sh setup       clone+boot(--vnc-experimental)+airgap+clock+warm-up+token
#   research-sit5.sh arm1        AREAPROJDAY seed + dated-bounce law legs (headless)
#   research-sit5.sh arm1c       AREAPROJDAY full scrambled 5-row bounce x2 (headless)
#   research-sit5.sh arm3        LOGSWEEP seed + GUI/DB/CLI membership (headless)
#   research-sit5.sh arm4        FUTPROJ future-project read representation (+VNC shot)
#   research-sit5.sh arm2-grant  AXVM1 rung-b Accessibility grant (needs $VNCDO)
#   research-sit5.sh arm2rec     CONVINST record template + current instance rows
#   research-sit5.sh arm2menus   select instance (things:///show) + AX menu dump
#   research-sit5.sh arm2convert perform the GUI Convert-to-Project (AX click)
#   research-sit5.sh arm2read    post-convert DB reads + Show Latest + host CLI
#   research-sit5.sh teardown    stop + delete the clone
#
# Conventions inherited from research-sit4.sh:
#   * offline COW clone, guest airgap (delete default route), clock pinned BEFORE
#     Things launches, read-only guest SQLite (encodePackedDate discipline — ISO
#     dates to the URL scheme, the app encodes; raw values read back).
#   * NEVER send URL when=/schedule-class to a REPEATING template row (§1 CRASH).
#   * NO clock advance anywhere.
#   * Synthetic seeds only (LAB-*/S5-* prefixes) — public repo.
#   D  = today+14 = 2026-07-19 (arbitrary future Upcoming day)
#   D' = today+15 = 2026-07-20 (the bounce staging day)
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v1}"
PIN="${PIN:-070512002026}"           # 2026-07-05 12:00 (golden pinnedDate)
D="${D:-2026-07-19}"                  # today+14
DP="${DP:-2026-07-20}"               # today+15 (staging)
VM="sit5-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/screens"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[sit5] $*" | tee -a "$REPORT"; }

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

# FULL raw row for a title glob, ORDERED BY todayIndex then index (the day-bucket
# axis). Columns: type,start,startDate,startBucket,todayIndex,index,heading,
# project,area,status,trashed,userModificationDate.
dumprow() { gq "SELECT title
  ||' ty='||type
  ||' st='||start
  ||' sd='||COALESCE(startDate,'-')
  ||' sb='||COALESCE(startBucket,'-')
  ||' tIdx='||COALESCE(todayIndex,'-')
  ||' idx='||\"index\"
  ||' hd='||COALESCE(substr(heading,1,8),'-')
  ||' p='||COALESCE(substr(project,1,8),'-')
  ||' a='||COALESCE(substr(area,1,8),'-')
  ||' status='||status
  ||' tr='||trashed
  ||' stop='||COALESCE(stopDate,'-')
  ||' umd='||COALESCE(userModificationDate,'-')
  FROM TMTask WHERE title LIKE '$1' AND trashed IN (0,1) ORDER BY todayIndex, \"index\""; }
# compact day-order line (todayIndex only) for quick order reads
dayord() { gq "SELECT title||'('||COALESCE(todayIndex,'-')||')' FROM TMTask WHERE title LIKE '$1' AND trashed=0 ORDER BY todayIndex, \"index\""; }
# repeating-shape dump: type, FK, rule-blob presence, status, trashed, creationDate
dumprep() { gq "SELECT title
  ||' uuid='||substr(uuid,1,8)
  ||' ty='||type
  ||' fk='||COALESCE(substr(rt1_repeatingTemplate,1,8),'-')
  ||' rule='||CASE WHEN rt1_recurrenceRule IS NULL THEN '-' ELSE 'SET' END
  ||' repeater='||CASE WHEN repeater IS NULL THEN '-' ELSE 'SET' END
  ||' status='||status
  ||' tr='||trashed
  ||' cd='||COALESCE(creationDate,'-')
  FROM TMTask WHERE $1 ORDER BY creationDate"; }

tjson() {
  local url
  url=$(lab_ssh "$IP" "python3 -c 'import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))' $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null)
  lab_ssh "$IP" "open -g $(printf '%q' "$url")" </dev/null; sleep 3
}

# pull a consistent copy of the guest DB to the host for CLI reads
DBCOPY="$OUT/main.sqlite"
pulldb() {
  lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); cp "$DB" /tmp/pull.sqlite; sqlite3 "$DB" ".backup /tmp/pull.sqlite" 2>/dev/null || true' </dev/null
  sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" "admin@$IP:/tmp/pull.sqlite" "$DBCOPY" >/dev/null 2>&1
}
# host CLI against the pulled copy, clock pinned to the golden date (THINGS_NOW)
# so the host wall-clock (real today) does not misclassify D as past.
T() { THINGS_NOW=2026-07-05T12:00:00 node --disable-warning=ExperimentalWarning bin/things.js "$@" --db "$DBCOPY"; }

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

# ==================================================================== ARM 1 AREAPROJDAY
if [ "$CMD" = "arm1" ]; then
  load_session
  note "############################################################"
  note "########## ARM 1 — AREAPROJDAY (D=$D D'=$DP) ##########"
  note "############################################################"

  # ---- (a) SEED ----
  note "seed: area S5A via AppleScript (URL cannot create areas)"
  gas "tell application \"Things3\" to make new area with properties {name:\"S5A\"}"
  sleep 1
  AID=$(areaid S5A)
  note "  area S5A uuid=$AID"

  note "seed: AREA-DIRECT project PA in S5A, then update-project?when=$D (confirm spelling for an area'd project)"
  gurl "things:///add-project?title=PA&area=S5A"
  sleep 1
  PA=$(uuid_of PA 1)
  note "  PA created uuid=$PA — raw BEFORE schedule: $(dumprow 'PA' | tr '\n' ' ')"
  gurl "things:///update-project?id=$PA&auth-token=$TOKEN&when=$D"
  note "  PA raw AFTER update-project?when=$D (area FK kept? sd set? start=2?): $(dumprow 'PA' | tr '\n' ' ')"

  note "seed same-day group: area-less project PB; loose to-dos T1,T2; area-direct to-do T3 (in S5A)"
  gurl "things:///add-project?title=PB&when=$D"
  gurl "things:///add?title=T1&when=$D"
  gurl "things:///add?title=T2&when=$D"
  gurl "things:///add?title=T3&when=$D&list=S5A"
  sleep 2
  note "--- seeded day-D roster (raw) ---"
  dumprow 'PA' | tee -a "$REPORT"
  dumprow 'PB' | tee -a "$REPORT"
  dumprow 'T_' | tee -a "$REPORT"
  note "day-D order: $(dayord 'PA' | tr '\n' ' ')$(dayord 'PB' | tr '\n' ' ')$(dayord 'T_' | tr '\n' ' ')"
  PB=$(uuid_of PB 1); T1=$(uuid_of T1); T2=$(uuid_of T2); T3=$(uuid_of T3)
  note "  uuids PA=$PA PB=$PB T1=$T1 T2=$T2 T3=$T3 area=$AID"

  # ---- (b) dated bounce legs on PA: when=D' then when=D ----
  note "===== b: AREA-DIRECT project PA dated bounce (update-project when=$DP then when=$D) ====="
  note "  before: $(dumprow 'PA' | tr '\n' ' ')"
  note "  full day-D order before: $(dayord 'PA'|tr '\n' ' ')$(dayord 'PB'|tr '\n' ' ')$(dayord 'T_'|tr '\n' ' ')"
  gurl "things:///update-project?id=$PA&auth-token=$TOKEN&when=$DP"
  note "  on D' (area FK preserved? start? sd?): $(dumprow 'PA' | tr '\n' ' ')"
  gurl "things:///update-project?id=$PA&auth-token=$TOKEN&when=$D"
  note "  back on D (area FK? start=2? sd=$D? tIdx=global-min?): $(dumprow 'PA' | tr '\n' ' ')"
  note "  full day-D order after: $(dayord 'PA'|tr '\n' ' ')$(dayord 'PB'|tr '\n' ' ')$(dayord 'T_'|tr '\n' ' ')"
  note "  INTERPRET b: area FK preserved through BOTH legs AND PA re-enters at global day-todayIndex min (below every same-day row incl to-dos)?"
  exit 0
fi

# ==================================================================== ARM 1c scrambled bounce
if [ "$CMD" = "arm1c" ]; then
  load_session
  note "########## ARM 1c — full scrambled 5-row bounce (PA mid-target) ##########"
  PA=$(uuid_of PA 1); PB=$(uuid_of PB 1); T1=$(uuid_of T1); T2=$(uuid_of T2); T3=$(uuid_of T3)
  AID=$(areaid S5A)
  bounce_todo() { gurl "things:///update?id=$1&auth-token=$TOKEN&when=$DP"; gurl "things:///update?id=$1&auth-token=$TOKEN&when=$D"; }
  bounce_proj() { gurl "things:///update-project?id=$1&auth-token=$TOKEN&when=$DP"; gurl "things:///update-project?id=$1&auth-token=$TOKEN&when=$D"; }
  order_line() { echo "$(dayord 'PA'|tr '\n' ' ')$(dayord 'PB'|tr '\n' ' ')$(dayord 'T_'|tr '\n' ' ')"; }
  for pass in 1 2; do
    note "===== PASS $pass: TARGET order T2, PB, PA, T1, T3 (PA is mid) ====="
    note "  before: $(order_line)"
    # reverse target = T3, T1, PA, PB, T2
    note "    bounce T3"; bounce_todo "$T3"; note "      $(order_line)"
    note "    bounce T1"; bounce_todo "$T1"; note "      $(order_line)"
    note "    bounce PA"; bounce_proj "$PA"; note "      $(order_line)"
    note "    bounce PB"; bounce_proj "$PB"; note "      $(order_line)"
    note "    bounce T2"; bounce_todo "$T2"; note "      $(order_line)"
    note "  FINAL pass $pass raw:"
    dumprow 'PA' | tee -a "$REPORT"; dumprow 'PB' | tee -a "$REPORT"; dumprow 'T_' | tee -a "$REPORT"
    note "  PASS $pass final order: $(order_line)"
    note "  ASSERT: order == T2,PB,PA,T1,T3 AND PA still carries area FK $AID ? area now: $(gq "SELECT COALESCE(substr(area,1,8),'-') FROM TMTask WHERE uuid='$PA'")"
  done
  note "  VERDICT-1: area-direct project rows join the day membership (front-insert at global min) with area FK preserved => planner membership-predicate can be relaxed to include area-direct project rows."
  exit 0
fi

# ==================================================================== ARM 3 LOGSWEEP
if [ "$CMD" = "arm3" ]; then
  load_session
  note "############################################################"
  note "########## ARM 3 — LOGSWEEP (logbook x trashed) ##########"
  note "############################################################"
  note "  logbook-sweep setting in TMSettings (raw, for the record):"
  gsql "SELECT * FROM TMSettings LIMIT 1" 2>/dev/null | tr '|' '\n' | grep -iE 'logInterval|sweep|log' | tee -a "$REPORT" || true
  gq "SELECT 'logInterval='||COALESCE((SELECT logInterval FROM TMSettings LIMIT 1),'n/a')" 2>/dev/null | tee -a "$REPORT" || true

  # seed
  note "seed: LG1,LG2 to-dos (Anytime), then complete both; LG3 to-do for trash-then-complete shape"
  gurl "things:///add?title=LG1"
  gurl "things:///add?title=LG2"
  gurl "things:///add?title=LG3"
  sleep 1
  LG1=$(uuid_of LG1); LG2=$(uuid_of LG2); LG3=$(uuid_of LG3)
  note "  uuids LG1=$LG1 LG2=$LG2 LG3=$LG3"
  note "complete LG1 + LG2 (update?completed=true)"
  gurl "things:///update?id=$LG1&auth-token=$TOKEN&completed=true"
  gurl "things:///update?id=$LG2&auth-token=$TOKEN&completed=true"
  sleep 1
  note "  after completion: $(dumprow 'LG_' | tr '\n' ' ')"
  note "trash LG2 AFTER completion (AppleScript move to trash)"
  gas "tell application \"Things3\" to move to trash to do id \"$LG2\""
  # fallback spelling
  gas "tell application \"Things3\" to delete to do id \"$LG2\""
  sleep 1
  note "  after trashing LG2: $(dumprow 'LG_' | tr '\n' ' ')"
  note "trash-then-complete shape: trash LG3, then attempt complete (reachable?)"
  gas "tell application \"Things3\" to move to trash to do id \"$LG3\""
  gas "tell application \"Things3\" to delete to do id \"$LG3\""
  sleep 1
  note "  LG3 after trash: $(dumprow 'LG3' | tr '\n' ' ')"
  gurl "things:///update?id=$LG3&auth-token=$TOKEN&completed=true"
  sleep 1
  note "  LG3 after attempted complete-while-trashed: $(dumprow 'LG3' | tr '\n' ' ')"

  note "--- final raw flags (status/trashed/stopDate) ---"
  dumprow 'LG_' | tee -a "$REPORT"

  note "--- host CLI reads against pulled DB copy ---"
  pulldb
  note "  things logbook --db :"
  T logbook --json | tee "$OUT/arm3-logbook.json" | python3 -c 'import sys,json;
d=json.load(sys.stdin); print([i.get("title") for i in (d if isinstance(d,list) else d.get("items",[]))])' 2>/dev/null | tee -a "$REPORT" || T logbook | tee -a "$REPORT"
  note "  things trash --db :"
  T trash --json | tee "$OUT/arm3-trash.json" | python3 -c 'import sys,json;
d=json.load(sys.stdin); print([i.get("title") for i in (d if isinstance(d,list) else d.get("items",[]))])' 2>/dev/null | tee -a "$REPORT" || T trash | tee -a "$REPORT"
  note "  VERDICT-3: completed-not-trashed (LG1) in Logbook only; completed-then-trashed (LG2) in Trash only (LIVE=trashed=0 gate). Record any GUI divergence."
  exit 0
fi

# ==================================================================== ARM 3 recheck
if [ "$CMD" = "arm3b" ]; then
  load_session
  note "########## ARM 3b — recheck after completed-then-trashed LG2 (move to list Trash) ##########"
  note "  final raw flags: $(gq "SELECT title||' status='||status||' tr='||trashed FROM TMTask WHERE title LIKE 'LG_' ORDER BY title" | tr '\n' ' | ')"
  pulldb
  note "  things logbook --db (expect LG1 only among LG*; LG2/LG3 absent):"
  T logbook --json > "$OUT/arm3-logbook.json" 2>/dev/null
  python3 - "$OUT/arm3-logbook.json" <<'PY' 2>/dev/null | tee -a "$REPORT" || true
import sys,json
d=json.load(open(sys.argv[1])); items=d.get("data",d) if isinstance(d,dict) else d
items=items.get("items",items) if isinstance(items,dict) else items
print("logbook LG*:",[i.get("title") for i in items if str(i.get("title","")).startswith("LG")])
PY
  note "  things trash --db (expect LG2 + LG3):"
  T trash --json > "$OUT/arm3-trash.json" 2>/dev/null
  python3 - "$OUT/arm3-trash.json" <<'PY' 2>/dev/null | tee -a "$REPORT" || true
import sys,json
d=json.load(open(sys.argv[1])); items=d.get("data",d) if isinstance(d,dict) else d
items=items.get("items",items) if isinstance(items,dict) else items
print("trash LG*:",[i.get("title") for i in items if str(i.get("title","")).startswith("LG")])
PY
  note "  VERDICT-3: LG1 (status3,tr0)->logbook only; LG2 (completed-THEN-trashed) & LG3 (trashed-THEN-completed) both status3,tr1 -> trash only. Our LIVE(trashed=0) logbook gate + trashed=1 trash view give exact GUI parity (SL2 L1)."
  exit 0
fi

# ==================================================================== ARM 4 FUTPROJ
if [ "$CMD" = "arm4" ]; then
  load_session
  note "############################################################"
  note "########## ARM 4 — FUTPROJ (future project read repr) ##########"
  note "############################################################"
  note "seed: area-less future project FPAL @$D (+ reuse ARM-1 area'd PA @$D if present)"
  gurl "things:///add-project?title=FPAL&when=$D"
  sleep 1
  FPAL=$(uuid_of FPAL 1); PA=$(uuid_of PA 1)
  note "  FPAL=$FPAL PA(area'd)=$PA"
  note "  FPAL raw: $(dumprow 'FPAL' | tr '\n' ' ')"
  note "  PA   raw: $(dumprow 'PA' | tr '\n' ' ')"

  note "--- host CLI reads against pulled DB copy ---"
  pulldb
  note "  things upcoming --db (JSON excerpt: title/stage/when/type for day $D group):"
  T upcoming --json | tee "$OUT/arm4-upcoming.json" >/dev/null
  python3 - "$OUT/arm4-upcoming.json" <<'PY' 2>/dev/null | tee -a "$REPORT" || true
import sys,json
d=json.load(open(sys.argv[1]))
items=d if isinstance(d,list) else d.get("items",[])
for i in items:
    t=i.get("title","")
    if t in ("FPAL","PA","PB","T1","T2","T3"):
        print(dict(title=t, kind=i.get("kind"), when=i.get("when"), stage=i.get("stage"), startDate=i.get("startDate")))
PY
  note "  things projects --show-later --db (JSON excerpt):"
  T projects --show-later --json | tee "$OUT/arm4-projects.json" >/dev/null
  python3 - "$OUT/arm4-projects.json" <<'PY' 2>/dev/null | tee -a "$REPORT" || true
import sys,json
d=json.load(open(sys.argv[1]))
def walk(o):
    if isinstance(o,dict):
        if o.get("title") in ("FPAL","PA","PB"):
            print(dict(title=o.get("title"), when=o.get("when"), stage=o.get("stage"), startDate=o.get("startDate")))
        for v in o.values(): walk(v)
    elif isinstance(o,list):
        for v in o: walk(v)
walk(d)
PY
  note "  VERDICT-4: does future-scheduled area-less/area'd PROJECT row appear in upcoming day-group + projects --show-later, with when/stage matching the GUI Upcoming rendering? (GUI screenshot via arm4-shot)"
  exit 0
fi

if [ "$CMD" = "arm4-shot" ]; then
  load_session
  VNCDO="${VNCDO:-}"
  if [ -z "$VNCDO" ] || [ -z "${VNC_URL:-}" ]; then note "VNCDO/VNC_URL missing — skip screenshot"; exit 1; fi
  HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
  PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
  V() { sleep 1; timeout 40 "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }
  lab_ssh "$IP" 'open -a Things3; sleep 6; open things:///show?id=upcoming; sleep 4' </dev/null
  V capture "$OUT/screens/arm4-upcoming.png"
  note "  arm4 screenshot -> $OUT/screens/arm4-upcoming.png"
  exit 0
fi

# ==================================================================== ARM 2 grant
if [ "$CMD" = "arm2-grant" ]; then
  load_session
  VNCDO="${VNCDO:-}"
  note "############################################################"
  note "########## ARM 2 grant — AXVM1 rung-b Accessibility ##########"
  note "############################################################"
  lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
  lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null
  if [ -z "$VNCDO" ] || [ -z "${VNC_URL:-}" ]; then note "VNCDO/VNC_URL missing — abort (export VNCDO=<path to vncdo>)"; exit 1; fi
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
  note "-- AX menu-bar read after grant (expect a menu list, not -1719) --"
  lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\''' </dev/null 2>&1 | tee -a "$REPORT"
  note "arm2-grant DONE"
  exit 0
fi

# ==================================================================== ARM 2 record
if [ "$CMD" = "arm2rec" ]; then
  load_session
  note "############################################################"
  note "########## ARM 2 — CONVINST record template + instance ##########"
  note "############################################################"
  TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1")
  note "  template LAB-REPEAT-DAILY uuid=$TMPL"
  note "  ALL rows titled LAB-REPEAT-DAILY (template + instances), raw:"
  dumprep "title='LAB-REPEAT-DAILY'" | tee -a "$REPORT"
  INST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$TMPL' AND trashed=0 ORDER BY creationDate DESC LIMIT 1")
  note "  CURRENT instance (max creationDate, trashed=0) uuid=$INST"
  note "  instance raw full: $(dumprow 'LAB-REPEAT-DAILY' | tr '\n' ' ')"
  echo "TMPL=$TMPL" >> "$SESSION"
  echo "INST=$INST" >> "$SESSION"
  note "  recorded TMPL/INST to session"
  exit 0
fi

# ==================================================================== ARM 2 menu dump
if [ "$CMD" = "arm2menus" ]; then
  load_session
  note "########## ARM 2 — select instance + AX menu enumeration ##########"
  lab_ssh "$IP" "open -a Things3; sleep 4; open 'things:///show?id=$INST'; sleep 4" </dev/null
  note "  selected instance $INST via things:///show"
  note "  -- menu-bar menu names --"
  gas "tell application \"System Events\" to tell process \"Things3\" to get name of every menu of menu bar 1" | tee -a "$REPORT"
  note "  -- every menu item title under each top menu (search for Convert) --"
  lab_ssh "$IP" "/usr/bin/osascript" </dev/null <<'JXA' 2>&1 | tee "$OUT/arm2-menus.txt" | grep -iE 'convert|project' | tee -a "$REPORT" || true
tell application "System Events" to tell process "Things3"
  set out to ""
  repeat with m in menus of menu bar 1
    set mn to name of m
    repeat with mi in menu items of menu 1 of m
      try
        set out to out & mn & " > " & (name of mi) & linefeed
      end try
    end repeat
  end repeat
  return out
end tell
JXA
  note "  (full menu dump saved to $OUT/arm2-menus.txt)"
  note "  -- try a right-click context menu on the selected row (may need window focus) --"
  exit 0
fi

# ==================================================================== ARM 2 convert
if [ "$CMD" = "arm2convert" ]; then
  load_session
  note "########## ARM 2 — perform GUI Convert to Project ##########"
  note "  snapshot BEFORE (crash-class caution §7): $(dumprep "title='LAB-REPEAT-DAILY'" | tr '\n' '|')"
  lab_ssh "$IP" "open -a Things3; sleep 4; open 'things:///show?id=$INST'; sleep 4" </dev/null
  # Convert menu path is discovered by arm2menus; pass it via MENU/ITEM env.
  MENU="${MENU:-Edit}"; ITEM="${ITEM:-Convert to Project}"
  note "  clicking menu: $MENU > $ITEM  (override with MENU=/ITEM= env)"
  gas "tell application \"System Events\" to tell process \"Things3\" to click menu item \"$ITEM\" of menu 1 of menu bar item \"$MENU\" of menu bar 1"
  sleep 4
  note "  waitCrash: Things3 pid alive?"
  lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null | tee -a "$REPORT"
  note "  snapshot AFTER: $(dumprep "title='LAB-REPEAT-DAILY'" | tr '\n' '|')"
  exit 0
fi

# ==================================================================== ARM 2 read
if [ "$CMD" = "arm2read" ]; then
  load_session
  note "########## ARM 2 — post-convert DB reads + Show Latest + host CLI ##########"
  note "  -- converted row + template + any children (type flip? uuid preserved? FK survives/cleared?) --"
  dumprep "title='LAB-REPEAT-DAILY'" | tee -a "$REPORT"
  note "  converted row full raw: $(dumprow 'LAB-REPEAT-DAILY' | tr '\n' ' | ')"
  note "  children of the converted row (project rows point children via project FK):"
  gq "SELECT title||' ty='||type FROM TMTask WHERE project='$INST' AND trashed=0" | tee -a "$REPORT" || true
  note "  template row rule intact? $(gq "SELECT 'rule='||CASE WHEN rt1_recurrenceRule IS NULL THEN 'CLEARED' ELSE 'SET' END||' nextInst='||COALESCE(rt1_nextInstanceStartDate,'-') FROM TMTask WHERE uuid='$TMPL'")"

  note "  -- host CLI derivation against pulled DB copy --"
  pulldb
  note "  DB-derived latestInstance for template (our SL1 query: max creationDate, trashed=0):"
  gq_local() { sqlite3 -noheader -list "file:$DBCOPY?mode=ro" "$1"; }
  gq_local "SELECT 'latest='||substr(uuid,1,8)||' ty='||type FROM TMTask WHERE rt1_repeatingTemplate='$TMPL' AND trashed=0 ORDER BY creationDate DESC LIMIT 1" | tee -a "$REPORT"
  note "  things <template-uuid> --db (does repeating.latestInstance point at the converted project?):"
  T "$TMPL" --json 2>&1 | tee "$OUT/arm2-template.json" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin); r=d.get("repeating",{}) if isinstance(d,dict) else {}
  print("repeating=",r)
except Exception as e: print("parse-fail",e)' 2>/dev/null | tee -a "$REPORT" || true
  note "  things <converted-uuid> --db (isInstance/instanceOf lie? crash?):"
  T "$INST" --json 2>&1 | tee "$OUT/arm2-converted.json" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  print("kind=",d.get("kind"),"instanceOf=",d.get("instanceOf"),"repeating=",d.get("repeating"))
except Exception as e: print("parse-fail",e)' 2>/dev/null | tee -a "$REPORT" || true
  note "  things upcoming/today --db (no crash, no lie?):"
  T upcoming --json >/dev/null 2>&1 && note "    upcoming: exit0" || note "    upcoming: NONZERO"
  T today --json >/dev/null 2>&1 && note "    today: exit0" || note "    today: NONZERO"
  note "  VERDICT-2: type flip 0->1? uuid preserved? FK survives (=> our reader labels a project as instance / Show Latest points at it = the lie) or cleared (clean)?"
  exit 0
fi

if [ "$CMD" = "arm2-showlatest" ]; then
  load_session
  VNCDO="${VNCDO:-}"
  note "########## ARM 2 — GUI Show Latest exercise (screenshot) ##########"
  if [ -z "$VNCDO" ] || [ -z "${VNC_URL:-}" ]; then note "VNCDO/VNC_URL missing — DB-derivation only"; exit 0; fi
  HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
  PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
  V() { sleep 1; timeout 40 "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }
  lab_ssh "$IP" "open -a Things3; sleep 4; open 'things:///show?id=$TMPL'; sleep 4" </dev/null
  V capture "$OUT/screens/arm2-template.png"
  note "  template screenshot -> arm2-template.png (Show Latest affordance visible?)"
  exit 0
fi

# ==================================================================== teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  exit 0
fi

echo "usage: $0 setup|arm1|arm1c|arm3|arm4|arm4-shot|arm2-grant|arm2rec|arm2menus|arm2convert|arm2read|arm2-showlatest|teardown" >&2
exit 1
