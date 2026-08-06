#!/bin/bash
# REMREV — does rescheduling an item with a STALE reminder REVIVE it, per surface?
# Write-up: docs/lab/remrev-stale-reminder-reschedule.md.
#
# Feeds a maintainer policy ruling: "rescheduling something whose reminder already
# did its job should NOT revive the reminder; if a surface revives as a side-effect
# we correct it after-write unless the user explicitly opts in."
#
# CERTIFIED BASELINE (oddities §9n / SIT3 REMSTALE): a stale `reminderTime`
# (startDate < today) is GUI-hidden but the byte is NEVER cleared by the app.
# `things:///update?when=evening` CLEARS `reminderTime` (§9n manufacture note).
# Read model (src/read/stage.ts reminderIsLive): a reminder is "live" iff set AND
# startDate is today-or-future (null counts live). GUI ground truth: a
# future-scheduled reminder renders (bell + When-popover reminder row).
#
# Method mirrors research-tdrag.sh (golden-v2 / Things 3.22.12, --vnc-experimental
# + AXVM1 Accessibility grant) and research-sit3.sh (clock-roll to stale the byte).
# ONE disposable offline COW clone, airgapped, clock pinned 2026-07-05 BEFORE Things
# launches, rolled +1d -> 2026-07-06 (app CLOSED, RSIM-S) to STALE the seeds.
# Writes go ONLY through official surfaces (URL scheme / AppleScript / GUI When
# picker / Shortcuts). Ground truth = guest read-only SQLite (raw bytes + decoded)
# + VNC framebuffer screenshots (the reminder bell / When-popover reminder row are
# custom NSViews — invisible to the AX tree, BANNER1 oracle-limits). Fixtures fully
# synthetic (RR-*). Dates SEEDED via URL when= (the app packs the int) — NEVER
# hand-pack a date/reminder integer.
#
# Requires $VNCDO (vncdotool venv, gitignored, in the primary checkout) for the GUI
# leg + screenshots:  VNCDO=/Volumes/Workspace/Projects/things-api/lab/vncvenv/bin/vncdo
#
# Subcommands:
#   setup            clone golden-v2 + boot(--vnc-experimental) + airgap + pin
#                    07-05 + warm + capture VNC_URL/token + helpers
#   caps             VNC capture + AX + HID smoke (de-risk before the GUI leg)
#   seed             seed the stale + live reminder fixtures at 07-05, read bytes
#   roll             quit + set clock 07-06 + relaunch (STALE the seeds)
#   fix              RR-FIX control: read all fixtures + Today screenshot (bell gone)
#   url  '<url>'     open a URL (auth-token appended), settle
#   as   '<script>'  run a raw AppleScript, echo result
#   gui-when <uuid> '<typed>'   select item (show+activate) -> Cmd-S -> type ->
#                    Enter -> screenshot (the GUI's own reschedule)
#   one  <uuid>      full byte row for a uuid
#   rows '<glob>'    compact decoded per-row dump (default RR-%)
#   full '<glob>'    raw full column dump (default RR-%)
#   sql  '<select>'  arbitrary read-only SELECT
#   shot <name>      VNC framebuffer capture -> host PNG
#   dbdump <name>    guest-side .dump (before/after byte diffs)
#   pull <name>      copy the guest DB to the host
#   teardown         stop + delete the clone
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v2}"
PIN="${PIN:-070512002026}"           # 2026-07-05 12:00 (golden pinnedDate)
ROLL="${ROLL:-070612002026}"         # 2026-07-06 12:00 (the stale day)
VM="remrev-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[remrev] $*" | tee -a "$REPORT"; }

CMD="${1:-}"

# --------------------------------------------------------------- guest SQLite
GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

gq()   { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gas()  { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" </dev/null || true; }
gurl() { lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; sleep 2; }

# FULL byte row for a uuid — every column the campaign cares about, RAW ints.
# The decoded startDate / reminderTime are shown alongside for readability.
one() { gq "SELECT title||' type='||type||' start='||start||' sb='||COALESCE(startBucket,'-')||' sd='||COALESCE(startDate,'-')||CASE WHEN startDate IS NULL THEN '' ELSE ' ('||(startDate>>16)||'-'||printf('%02d',(startDate>>12)&15)||'-'||printf('%02d',(startDate>>7)&31)||')' END||' rem='||COALESCE(reminderTime,'-')||CASE WHEN reminderTime IS NULL THEN '' ELSE ' ('||printf('%02d',(reminderTime>>26)&63)||':'||printf('%02d',(reminderTime>>20)&63)||')' END||' tiRef='||COALESCE(todayIndexReferenceDate,'-')||' dl='||COALESCE(deadline,'-')||' ti='||todayIndex||' idx='||\"index\"||' umd='||CAST(COALESCE(userModificationDate,0) AS INT) FROM TMTask WHERE uuid='$1'"; }

uuid_of() { local t="$1" u i; for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE title='$t' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }

# --------------------------------------------------------------- VNC helpers
vnc_init() {
  [ -n "${VNC_URL:-}" ] || { note "VNC_URL missing — re-run setup"; return 1; }
  [ -n "${VNCDO:-}" ] || VNCDO="lab/vncvenv/bin/vncdo"
  [ -x "$VNCDO" ] || { note "VNCDO not executable ($VNCDO) — pass VNCDO=/abs/path/to/vncdo"; return 1; }
  local hp; hp="${VNC_URL#vnc://}"; hp="${hp##*@}"
  VSERVER="${hp%%:*}::${hp##*:}"
  VPASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
}
V() { sleep 1; timeout 60 "$VNCDO" -s "$VSERVER" ${VPASS:+-p "$VPASS"} "$@" 2>>"$OUT/vnc.log"; }

# ============================================================ verbs (post-setup)
case "$CMD" in
  one)    load_session; one "$2"; exit 0 ;;
  rows)   load_session; lab_ssh "$IP" "/tmp/rows.sh $(printf '%q' "${2:-RR-%}")" </dev/null; exit 0 ;;
  full)   load_session; lab_ssh "$IP" "/tmp/full.sh $(printf '%q' "${2:-RR-%}")" </dev/null; exit 0 ;;
  sql)    load_session; gq "$2"; exit 0 ;;
  url)    load_session; note "URL: $2"; gurl "$2&auth-token=$TOKEN"; exit 0 ;;
  rawurl) load_session; note "RAWURL: $2"; gurl "$2"; exit 0 ;;
  as)     load_session; note "AS: $2"; gas "$2" | sed 's/^/  /' | tee -a "$REPORT"; exit 0 ;;
  shot)   load_session; vnc_init || exit 1; V capture "$OUT/snaps/$2.png" && note "snap -> snaps/$2.png ($(ls -la "$OUT/snaps/$2.png" 2>/dev/null | awk '{print $5}') bytes)"; exit 0 ;;
  esc)    load_session; vnc_init || exit 1; V key esc pause 0.5 key esc; note "esc x2"; exit 0 ;;
  dbdump) load_session; lab_ssh "$IP" "/tmp/dbdump.sh $2" </dev/null; note "dbdump $2 done"; exit 0 ;;
  pull)   load_session; RP=$(lab_ssh "$IP" 'echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite' </dev/null); lab_scp "$IP:$RP" "$OUT/db-$2.sqlite"; note "pulled -> $OUT/db-$2.sqlite"; exit 0 ;;
  teardown) note "teardown: $VM"; pkill -f "tart run $VM" >/dev/null 2>&1 || true; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; exit 0 ;;
esac

# =============================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "cloning $GOLDEN -> $VM (pin $PIN, stale-roll -> $ROLL)"
  pkill -f "tart run $VM" >/dev/null 2>&1 || true
  tart stop "$VM" >/dev/null 2>&1 || true
  sleep 3
  tart delete "$VM" >/dev/null 2>&1 || true
  RUNNING=$(pgrep -fl 'tart run' | grep -c 'tart run' || true)
  [ "${RUNNING:-0}" -ge 2 ] && { note "FATAL: $RUNNING VMs running (2-VM limit)"; pgrep -fl 'tart run' >&2; exit 3; }
  tart clone "$GOLDEN" "$VM" || { note "clone FAILED"; exit 1; }
  (tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
  note "ssh up at $IP"
  sleep 3
  VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
  note "VNC_URL=${VNC_URL:-<none captured>}"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo route -n delete -inet6 default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  note "clock: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"

  # guest helpers
  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"
  lab_ssh "$IP" 'cat > /tmp/full.sh && chmod +x /tmp/full.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
sqlite3 -line "file:$DB?mode=ro" "SELECT title,uuid,type,start,startDate,startBucket,todayIndex,\"index\",reminderTime,deadline,todayIndexReferenceDate,userModificationDate AS umd FROM TMTask WHERE title LIKE '${1:-RR-%}' ORDER BY title;"
EOF
  lab_ssh "$IP" 'cat > /tmp/rows.sh && chmod +x /tmp/rows.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
sqlite3 -header -column "file:$DB?mode=ro" "
SELECT substr(title,1,16) AS title, type AS ty, start AS s, startBucket AS sb, status AS st,
  CASE WHEN startDate IS NULL THEN 'NULL' ELSE (startDate>>16)||'-'||printf('%02d',(startDate>>12)&15)||'-'||printf('%02d',(startDate>>7)&31) END AS startD,
  reminderTime AS remT,
  CASE WHEN reminderTime IS NULL THEN '-' ELSE printf('%02d',(reminderTime>>26)&63)||':'||printf('%02d',(reminderTime>>20)&63) END AS remHM,
  todayIndex AS ti, \"index\" AS ix
FROM TMTask WHERE title LIKE '${1:-RR-%}' ORDER BY title;"
EOF
  lab_ssh "$IP" 'cat > /tmp/dbdump.sh && chmod +x /tmp/dbdump.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
mkdir -p ~/dumps; cp "$DB" /tmp/snap.sqlite 2>/dev/null
sqlite3 /tmp/snap.sqlite ".dump" > ~/dumps/"$1".dump
EOF

  { echo "IP=$IP"; echo "VNC_URL=$VNC_URL"; } > "$SESSION"
  note "warm-up: launch/quit/relaunch Things on the pinned date"
  lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3' </dev/null
  lab_ssh "$IP" 'open -g -a Things3; sleep 8' </dev/null
  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  echo "TOKEN=$TOKEN" >> "$SESSION"
  note "auth token in hand (${#TOKEN} chars)"
  note "TMTask row count (seed sanity): $(gq "SELECT COUNT(*) FROM TMTask")"
  note "setup DONE — session in $SESSION — NEXT: seed"
  exit 0
fi

# =============================================================== caps
if [ "$CMD" = "caps" ]; then
  load_session; vnc_init || exit 1
  note "################## CAPS — de-risk VNC + AX + HID ##################"
  note "  AX menu read (expect menu names): [$(gas "tell application \"System Events\" to tell process \"Things3\" to get name of every menu of menu bar 1" | head -c 140)]"
  note "  AX count windows (expect >=1): [$(gas "tell application \"System Events\" to tell process \"Things3\" to count windows")]"
  lab_ssh "$IP" "open 'things:///show?id=today'; sleep 2; osascript -e 'tell application \"Things3\" to activate'; sleep 2" </dev/null
  V capture "$OUT/snaps/caps-today.png" && note "  VNC capture OK -> snaps/caps-today.png ($(ls -la "$OUT/snaps/caps-today.png" 2>/dev/null | awk '{print $5}') bytes)" || note "  VNC capture FAILED (see vnc.log)"
  exit 0
fi

# =============================================================== seed
# STALE fixtures: to-dos scheduled for 07-05 (today) WITH an 18:00 reminder via
# add?when=2026-07-05@18:00 (§9w: date@time -> dated that day + a reminder). After
# the roll to 07-06 their startDate (07-05) goes stale -> the §9n collapse.
#   RR-SF-URLD    URL update?when=<future date>        (byte kept/cleared?)
#   RR-SF-URLT    URL update?when=<future date>@09:00  (sets a NEW reminder — control)
#   RR-SF-TODAY   URL update?when=today
#   RR-SF-AS      AppleScript schedule for <future date>
#   RR-SF-GUI     GUI When picker (Cmd-S) reschedule -> canonicity verdict
# LIVE fixtures (RR-LIVE inverse hazard): to-dos scheduled FUTURE (07-10) WITH an
# 18:00 reminder — still live-future after the roll to 07-06.
#   RR-LF-URL / RR-LF-AS / RR-LF-GUI
if [ "$CMD" = "seed" ]; then
  load_session
  note "################## SEED (clock $(lab_ssh "$IP" 'date +%F' </dev/null)) ##################"
  note "  STALE fixtures: add?when=2026-07-05@18:00 (dated today + 18:00 reminder)"
  for t in RR-SF-URLD RR-SF-URLT RR-SF-TODAY RR-SF-AS RR-SF-GUI; do
    gurl "things:///add?title=$t&when=2026-07-05@18:00"; sleep 1
  done
  note "  LIVE fixtures: add?when=2026-07-10@18:00 (dated FUTURE + 18:00 reminder)"
  for t in RR-LF-URL RR-LF-AS RR-LF-GUI; do
    gurl "things:///add?title=$t&when=2026-07-10@18:00"; sleep 1
  done
  note "  --- seed bytes (expect STALE: sd=07-05 rem=(18:00); LIVE: sd=07-10 rem=(18:00)) ---"
  lab_ssh "$IP" "/tmp/rows.sh 'RR-%'" </dev/null | sed 's/^/  /' | tee -a "$REPORT"
  note "  uuids:"
  for t in RR-SF-URLD RR-SF-URLT RR-SF-TODAY RR-SF-AS RR-SF-GUI RR-LF-URL RR-LF-AS RR-LF-GUI; do
    u=$(uuid_of "$t"); echo "${t//-/_}=$u" >> "$SESSION"; note "    $t = $u"
  done
  note "seed DONE — NEXT: roll"
  exit 0
fi

# =============================================================== roll
if [ "$CMD" = "roll" ]; then
  load_session
  note "################## ROLL clock -> $ROLL (STALE the seeds; app CLOSED) ##################"
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 4' </dev/null
  lab_ssh "$IP" "sudo date $ROLL >/dev/null; date" </dev/null | sed 's/^/  /' | tee -a "$REPORT"
  lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null
  note "  clock now: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
  note "roll DONE — NEXT: fix (control)"
  exit 0
fi

# =============================================================== fix (RR-FIX control)
if [ "$CMD" = "fix" ]; then
  load_session
  note "################## RR-FIX — control: §9n stale collapse (bell gone) ##################"
  note "  clock: $(lab_ssh "$IP" 'date +%F' </dev/null) (stale day; STALE seeds startDate 07-05 < today)"
  note "  --- all fixture bytes (STALE reminderTime must be KEPT; LIVE still future) ---"
  lab_ssh "$IP" "/tmp/rows.sh 'RR-%'" </dev/null | sed 's/^/  /' | tee -a "$REPORT"
  note "  read-model check (reminderIsLive = startDate>=today): STALE sd=07-05<07-06 => DEAD; LIVE sd=07-10>=07-06 => LIVE"
  if [ -n "${VNCDO:-}" ]; then
    vnc_init || true
    lab_ssh "$IP" "open 'things:///show?id=today'; sleep 2; osascript -e 'tell application \"Things3\" to activate'; sleep 2" </dev/null
    V capture "$OUT/snaps/fix-today.png" && note "  Today screenshot -> snaps/fix-today.png (expect STALE rows plain, NO bell)"
  fi
  exit 0
fi

# =============================================================== gui-when (RR-GUI / RR-LIVE GUI)
# select item (show+activate) -> AX-click Items > When... (opens the When popover)
# -> type the date -> Enter. The AXVM1 grant makes the by-name menu click + the
# synthesized keystrokes land. Screenshot the popover before typing (verify it
# opened), then after. (Cmd-S via `V key super-s` proved unreliable — the modifier
# dropped and the bare "s" leaked into Quick Find — so we drive the menu item by
# NAME, the tdrag arm4-drive path.)
if [ "$CMD" = "gui-when" ]; then
  load_session; vnc_init || exit 1
  U="$2"; WHEN="$3"
  note "  --- GUI When-picker reschedule of $U to '$WHEN' (Items > When...) ---"
  note "  before: $(one "$U")"
  lab_ssh "$IP" "open 'things:///show?id=$U'; sleep 2; osascript -e 'tell application \"Things3\" to activate'; sleep 2" </dev/null
  V capture "$OUT/snaps/gui-$U-selected.png"
  note "  AX click Items > When...: [$(gas "tell application \"System Events\" to tell process \"Things3\" to click menu item \"When…\" of menu \"Items\" of menu bar item \"Items\" of menu bar 1")]"
  sleep 2
  V capture "$OUT/snaps/gui-$U-popover.png"
  V type "$WHEN" pause 1.0 capture "$OUT/snaps/gui-$U-typed.png" key "enter" pause 0.8 capture "$OUT/snaps/gui-$U-after.png"
  sleep 3
  note "  after:  $(one "$U")"
  note "  (inspect snaps/gui-$U-*.png for the popover reminder-row / bell state)"
  exit 0
fi

echo "usage: $0 setup|caps|seed|roll|fix|url '<u>'|rawurl '<u>'|as '<s>'|gui-when <uuid> '<when>'|one <uuid>|rows '<glob>'|full '<glob>'|sql '<sel>'|shot <n>|dbdump <n>|pull <n>|teardown" >&2
exit 1
