#!/bin/bash
# TIMEZ — the evening substrate, cross-date/cross-zone evening writes, and
# zone-shifted derivations. Write-up: docs/lab/timez-evening-and-zones.md.
#
# The maintainer wants the two-devices-two-timezones model certified and every
# mitigation for a REMOTE-ZONE caller (their "today" = the app's tomorrow) probed
# exhaustively. Certified baseline (schema-v26 atlas): evening = startBucket=1
# sub-placement within Today; renders in the Evening section only while
# startBucket=1 AND startDate == <app-today> EXACTLY; overdue evening rolls back
# into Today proper; the app derives lists from the GUEST wall-clock.
#
# ONE disposable offline Tart clone `timez-lab`, golden things-lab-golden-v2
# (Things 3.22.12, DB v26). Airgapped (default route deleted). Base clock pinned
# 2026-07-05 12:00 in a KNOWN base TZ (America/New_York, UTC-4 DST). Writes go
# ONLY through official surfaces (URL scheme, AppleScript, Shortcuts proxies).
# Timezone changes use `systemsetup -settimezone` (an official OS surface);
# day-boundary rolls use `sudo date` (RSIM-S small-increment recipe). Clock/TZ
# changes happen in the VM ONLY, never the host. Ground truth = guest read-only
# SQLite (raw bytes + decoded) + the AppleScript list oracle + VNC screenshots
# (This-Evening / Upcoming / Logbook groupings are custom NSViews — BANNER1
# oracle-limits; observed via the VNC framebuffer). Fixtures fully synthetic (TZ-*).
#
# TRUE two-device sync legs are BLOCKED (no cloud account — SYNC2); cross-device
# claims are modeled from the single-app zone-shift evidence + no-row-mutation proofs.
#
# Subcommands (composite arms, all self-seeding, run at base clock 07-05):
#   setup       clone+boot(--vnc-experimental)+airgap+pin+base-TZ+helpers+token
#   zsub        Z-SUB    substrate control (when=evening -> sb=1/today; when=today -> sb=0)
#   zxdate      Z-XDATE(a) URL when= string vocabulary sweep for DATED EVENING
#   zxas        Z-XDATE(b) AppleScript schedule/for + activation-date read-only
#   zxlist      Z-XDATE(c) move/reorder to list "This Evening" | "Evening"
#   zxsc        Z-XDATE(d) Shortcuts set-detail Start = evening / dated-evening
#   zxcompose   Z-XDATE(e) two-step compositions (schedule tomorrow <-> evening-mark)
#   ztoday      Z-TODAY  cross-zone when=today calendar-day stamping
# Interactive verbs (for Z-ROLL + Z-LOGVIEW GUI/TZ legs):
#   tz <Zone>          settimezone (e.g. Pacific/Kiritimati); prints new local time
#   clock <MMDDhhmmYYYY>   sudo date; prints new local time
#   relaunch [MMDDhhmmYYYY]  quit Things, optional clock set, relaunch (recompute buckets)
#   url <things-url> | rawurl <url> | as <applescript> | aslist <list>
#   full [glob] | rows [glob] | sql <q> | dbdump <label> | shot <name> | click x y | key k
#   pull <label> | teardown
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v2}"
BASETZ="${BASETZ:-America/New_York}"    # UTC-4 (DST) base
PIN="${PIN:-070512002026}"              # 2026-07-05 12:00 local (golden pinnedDate)
TODAY="${TODAY:-2026-07-05}"
TMRW="${TMRW:-2026-07-06}"
AUTH="9dFi9fY-QBuqFq59yAUxOg"           # golden uriSchemeAuthToken (metadata, not a secret)

VM="timez-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps"
REPORT="$OUT/report.txt"
STATE="$OUT/state.env"
note() { echo "[timez] $*" | tee -a "$REPORT"; }

# ---- load state for every post-setup command ----
if [ "${1:-}" != "setup" ] && [ "${1:-}" != "" ]; then
  [ -f "$STATE" ] || { echo "no $STATE — run setup first" >&2; exit 2; }
  source "$STATE"
fi

gq()   { lab_ssh "$IP" "~/things-lab/helpers/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gas()  { lab_ssh "$IP" "/usr/bin/osascript -e $(printf '%q' "$1") 2>&1" </dev/null || true; }
gurl() { lab_ssh "$IP" "open -g $(printf '%q' "$1&auth-token=$AUTH")" </dev/null; sleep 2; }
grawurl() { lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; sleep 2; }
V()    { sleep 1; timeout 40 "$VNCDO" -s "$SERVER" -p "$PASS" "$@" 2>>"$OUT/vnc.log"; }
# ONE compact byte row for a uuid — every column TIMEZ cares about.
one() { gq "SELECT title||' ty='||type||' start='||start||' sb='||COALESCE(startBucket,'-')||' sd='||COALESCE(startDate,'-')||' sdD='||(CASE WHEN startDate IS NULL THEN '-' ELSE (startDate>>16)||'-'||printf('%02d',(startDate>>12)&15)||'-'||printf('%02d',(startDate>>7)&31) END)||' tiRef='||COALESCE(todayIndexReferenceDate,'-')||' ti='||todayIndex||' rem='||COALESCE(reminderTime,'-')||' dl='||COALESCE(deadline,'-')||' status='||status||' umd='||CAST(COALESCE(userModificationDate,0) AS INT) FROM TMTask WHERE uuid='$1'"; }
uuid_of() { local t="$1" u i; for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE title='$t' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }
# make a fresh anytime to-do, return its uuid
mk() { grawurl "things:///add?title=$1"; sleep 1; uuid_of "$1"; }
proxy() { # proxy <name> <json>  (STALE OUTPUT CLEARED each run; DB delta is the only truth)
  note "-- shortcuts run $1  $2"
  lab_ssh "$IP" "printf '%s' $(printf '%q' "$2") > /tmp/tz-in.json; rm -f /tmp/tz-out.txt; perl -e 'alarm 60; exec @ARGV' shortcuts run $(printf '%q' "$1") --input-path /tmp/tz-in.json --output-path /tmp/tz-out.txt 2>&1; echo \"[exit \$?]\"; cat /tmp/tz-out.txt 2>/dev/null; echo" </dev/null 2>&1 | tee -a "$REPORT" || true
}
sav() { echo "$1=$2" >> "$STATE"; }

CMD="${1:-}"; shift || true

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"; : > "$STATE"
  FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
  note "preflight: free ${FREEGB}GB"; [ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free"; exit 1; }
  if [ -z "${VNCDO:-}" ] || [ ! -x "${VNCDO:-/nonexistent}" ]; then note "FATAL: \$VNCDO not set/executable (needed for Z-ROLL/Z-LOGVIEW)"; exit 1; fi
  RUNNING=$(pgrep -fl 'tart run' | grep -c 'tart run' || true)
  [ "${RUNNING:-0}" -ge 2 ] && { note "FATAL: $RUNNING VMs running (2-VM ceiling)"; exit 3; }

  note "cloning $GOLDEN -> $VM"
  pkill -f "tart run $VM" >/dev/null 2>&1 || true
  tart stop "$VM" >/dev/null 2>&1 || true; sleep 2
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM" || { note "clone FAILED"; exit 1; }
  (tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: boot failed"; cat "$OUT/tart-run.log"; exit 1; }
  note "ssh up at $IP"; sav IP "$IP"; sav VNCDO "$VNCDO"; sav AUTH "$AUTH"
  # VNC server/pass from tart-run.log
  for i in $(seq 1 20); do VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true); [ -n "$VNC_URL" ] && break; sleep 1; done
  [ -z "${VNC_URL:-}" ] && { note "FATAL: no VNC url in tart-run.log"; exit 1; }
  HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
  PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
  sav SERVER "$SERVER"; sav PASS "$PASS"; sav VNC_URL "$VNC_URL"
  note "vnc: $SERVER"

  note "airgap + base TZ $BASETZ + pin clock (2026-07-05 12:00 local)"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo route -n delete -inet6 default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null | sed 's/^/[timez] /'
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo systemsetup -settimezone $BASETZ >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  note "base TZ: $(lab_ssh "$IP" 'sudo systemsetup -gettimezone 2>/dev/null' </dev/null | tr -d '\n')  clock: $(lab_ssh "$IP" 'date "+%Y-%m-%dT%H:%M %Z (UTC%z)"' </dev/null)"

  # ---------------- guest helpers ----------------
  lab_ssh "$IP" 'mkdir -p ~/things-lab/helpers ~/things-lab/dumps' </dev/null
  lab_ssh "$IP" 'cat > ~/things-lab/helpers/gsql.sh && chmod +x ~/things-lab/helpers/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column)
[ "$1" = "-q" ] && { FMT=(-noheader -list); shift; }
[ "$1" = "-l" ] && { FMT=(-line); shift; }
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
  lab_ssh "$IP" 'cat > ~/things-lab/helpers/full.sh && chmod +x ~/things-lab/helpers/full.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
GLOB="${1:-TZ-%}"
sqlite3 -line "file:$DB?mode=ro" "
SELECT title, uuid, type, start, startDate, startBucket, todayIndex, \"index\",
       reminderTime, deadline, todayIndexReferenceDate AS tiRef, status, stopDate,
       userModificationDate AS umd
FROM TMTask WHERE title LIKE '$GLOB' AND trashed=0 ORDER BY title;"
EOF
  lab_ssh "$IP" 'cat > ~/things-lab/helpers/rows.sh && chmod +x ~/things-lab/helpers/rows.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
GLOB="${1:-TZ-%}"
sqlite3 -header -column "file:$DB?mode=ro" "
SELECT substr(title,1,20) AS title, type AS ty, start AS s, startBucket AS sb, status AS st,
       CASE WHEN startDate IS NULL THEN 'NULL' ELSE (startDate>>16)||'-'||printf('%02d',(startDate>>12)&15)||'-'||printf('%02d',(startDate>>7)&31) END AS startD,
       CASE WHEN deadline  IS NULL THEN 'NULL' ELSE (deadline>>16)||'-'||printf('%02d',(deadline>>12)&15)||'-'||printf('%02d',(deadline>>7)&31)  END AS deadl,
       reminderTime AS remT, todayIndex AS ti,
       CASE WHEN stopDate IS NULL THEN 'NULL' ELSE datetime(stopDate,'unixepoch') END AS stopUTC
FROM TMTask WHERE title LIKE '$GLOB' AND trashed=0 ORDER BY title;"
EOF
  lab_ssh "$IP" 'cat > ~/things-lab/helpers/dbdump.sh && chmod +x ~/things-lab/helpers/dbdump.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
cp "$DB" /tmp/snap.sqlite 2>/dev/null
sqlite3 /tmp/snap.sqlite ".dump" > ~/things-lab/dumps/"$1".dump
EOF

  note "warm-up launch (recompute Today buckets for pinned date), quit clean"
  lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\''; sleep 4' </dev/null
  SCHEMA=$(lab_ssh "$IP" '~/things-lab/helpers/gsql.sh -q "SELECT COUNT(*) FROM TMTask"' </dev/null)
  note "TMTask row count (golden seed sanity): $SCHEMA"
  note "env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26"
  note "############### TIMEZ SETUP COMPLETE — VM LEFT RUNNING ###############"
  exit 0
fi

# ==================================================================== Z-SUB
if [ "$CMD" = "zsub" ]; then
  note "################## Z-SUB — substrate control (golden-v2 re-confirm) ##################"
  E=$(mk TZ-SUB-EVE); T=$(mk TZ-SUB-TOD)
  note "  seed resting: $(one "$E") | $(one "$T")"
  gurl "things:///update?id=$E&when=evening"
  note "  TZ-SUB-EVE after when=evening: $(one "$E")"
  gurl "things:///update?id=$T&when=today"
  note "  TZ-SUB-TOD after when=today:   $(one "$T")"
  note "  VERDICT Z-SUB: evening => startBucket=1 + startDate=$TODAY? today => startBucket=0 + startDate=$TODAY?"
  exit 0
fi

# ============================================================ Z-XDATE(a) URL when= sweep
if [ "$CMD" = "zxdate" ]; then
  note "################## Z-XDATE(a) — URL when= DATED-EVENING vocabulary sweep ##################"
  note "  each: fresh anytime to-do, single things:///update?when=<STR>; record exact resulting row + any error"
  # candidate when= strings (the remote-zone caller wants evening on a NON-today date)
  i=0
  for S in "tomorrow@evening" "evening@tomorrow" "$TMRW@evening" "evening $TMRW" "tomorrow evening" "$TMRW evening" "${TMRW}T20:00" "$TMRW@20:00" "someday@evening" "anytime@evening" "evening"; do
    i=$((i+1)); T="TZ-XD-$i"
    U=$(mk "$T")
    ENC=$(lab_ssh "$IP" "python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1],safe=\"\"))' $(printf '%q' "$S")" </dev/null)
    note "  --- [$i] when=\"$S\" (enc=$ENC) ---"
    note "    before: $(one "$U")"
    gurl "things:///update?id=$U&when=$ENC"
    note "    AFTER:  $(one "$U")"
  done
  note "  VERDICT Z-XDATE(a): does ANY when= string yield startBucket=1 with startDate != $TODAY? (record accepted-shape / plain-date / reminder-side-effect / error per row)"
  exit 0
fi

# ============================================================ Z-XDATE(b) AppleScript
if [ "$CMD" = "zxas" ]; then
  note "################## Z-XDATE(b) — AppleScript schedule + activation-date write ##################"
  note "  sdef facts (host-read): 'activation date' is access=r (READ-ONLY); the only date-writing verb is 'schedule <todo> for <date>' -> cocoa key activationDate (== startDate). No bucket property is writable."
  U=$(mk TZ-AS-1)
  note "  before: $(one "$U")"
  note "  (b1) schedule for tomorrow ($TMRW noon):"
  note "    result: [$(gas "tell application \"Things3\" to schedule to do id \"$U\" for (date \"$TMRW 12:00:00\")")]"
  note "    AFTER:  $(one "$U")"
  note "  (b2) attempt to SET activation date directly (expect read-only error):"
  note "    result: [$(gas "tell application \"Things3\" to set activation date of to do id \"$U\" to (current date)")]"
  note "    AFTER:  $(one "$U")"
  note "  (b3) is there ANY evening/bucket-ish settable property? probe a few speculative setters:"
  for P in "start bucket" "today section" "evening" "scheduled bucket"; do
    note "    set \"$P\" -> [$(gas "tell application \"Things3\" to set $P of to do id \"$U\" to 1")]"
  done
  note "  VERDICT Z-XDATE(b): can any AS write produce startBucket=1 with startDate != $TODAY? (expect NO — schedule writes only startDate/start=1, sb stays 0; activation date read-only; no bucket setter)"
  exit 0
fi

# ============================================================ Z-XDATE(c) hidden-list targets
if [ "$CMD" = "zxlist" ]; then
  note "################## Z-XDATE(c) — move/reorder to an Evening list target ##################"
  U=$(mk TZ-LIST-1)
  note "  before: $(one "$U")"
  for L in "This Evening" "Evening"; do
    note "  --- move to list \"$L\" ---"
    note "    result: [$(gas "tell application \"Things3\" to move to do id \"$U\" to list \"$L\"")]"
    note "    AFTER:  $(one "$U")"
    note "  --- reorder to dos in list \"$L\" (does the specifier resolve?) ---"
    note "    result: [$(gas "tell application \"Things3\" to _private_experimental_ reorder to dos in list \"$L\" with ids \"$U\"")]"
  done
  note "  control — get name of every list (is there ANY Evening list?):"
  note "    [$(gas 'tell application "Things3" to get name of every list')]"
  note "  VERDICT Z-XDATE(c): does an Evening list target exist / accept a move? (expect -1728 no-such-list on both, per SIT3 SPECLIST — re-confirm for the move verb + golden-v2)"
  exit 0
fi

# ============================================================ Z-XDATE(d) Shortcuts set-detail
if [ "$CMD" = "zxsc" ]; then
  note "################## Z-XDATE(d) — Shortcuts set-detail Start = evening / dated-evening ##################"
  note "  the set-detail proxy Detail selector accepts 'Start' (the When). Sweep evening/dated values."
  for VAL in "This Evening" "Evening" "Tomorrow" "$TMRW" "Tomorrow Evening"; do
    T="TZ-SC-$(echo "$VAL" | tr ' ' '_')"
    U=$(mk "$T")
    note "  --- set-detail Start = \"$VAL\" on $T ---"
    note "    before: $(one "$U")"
    proxy things-proxy-set-detail "{\"id\":\"$U\",\"detail\":\"Start\",\"value\":\"$VAL\"}"
    sleep 2
    note "    AFTER:  $(one "$U")"
  done
  note "  VERDICT Z-XDATE(d): does a set-detail Start value produce evening (sb=1)? a DATED evening? or plain date / no-op?"
  exit 0
fi

# ============================================================ Z-XDATE(e) two-step compositions
if [ "$CMD" = "zxcompose" ]; then
  note "################## Z-XDATE(e) — two-step compositions (schedule tomorrow <-> evening-mark) ##################"
  note "  --- (e1) schedule tomorrow (URL) THEN when=evening: does evening keep tomorrow or re-stamp to today? ---"
  A=$(mk TZ-CMP-A)
  gurl "things:///update?id=$A&when=$TMRW"; note "    after when=$TMRW: $(one "$A")"
  gurl "things:///update?id=$A&when=evening"; note "    after when=evening: $(one "$A")"
  note "  --- (e2) reverse: when=evening THEN when=tomorrow: does the date win + bucket reset? ---"
  B=$(mk TZ-CMP-B)
  gurl "things:///update?id=$B&when=evening"; note "    after when=evening: $(one "$B")"
  gurl "things:///update?id=$B&when=$TMRW"; note "    after when=$TMRW: $(one "$B")"
  note "  --- (e3) AppleScript schedule tomorrow THEN URL when=evening ---"
  C=$(mk TZ-CMP-C)
  gas "tell application \"Things3\" to schedule to do id \"$C\" for (date \"$TMRW 12:00:00\")" >/dev/null
  note "    after AS schedule $TMRW: $(one "$C")"
  gurl "things:///update?id=$C&when=evening"; note "    after when=evening: $(one "$C")"
  note "  --- (e4) schedule tomorrow (URL) THEN reorder into list \"Tomorrow\" (does tomorrow list carry a bucket?) ---"
  D=$(mk TZ-CMP-D)
  gurl "things:///update?id=$D&when=$TMRW"; note "    after when=$TMRW: $(one "$D")"
  note "    reorder list \"Tomorrow\": [$(gas "tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Tomorrow\" with ids \"$D\"")]"
  note "    AFTER:  $(one "$D")"
  note "  VERDICT Z-XDATE(e): does ANY composition land startBucket=1 with startDate=$TMRW (dated evening)? or does evening always re-stamp startDate:=today?"
  exit 0
fi

# ============================================================ Z-TODAY cross-zone stamping
if [ "$CMD" = "ztoday" ]; then
  ZONE="${1:-Pacific/Kiritimati}"   # UTC+14 — far east
  note "################## Z-TODAY — cross-zone when=today calendar-day stamping ##################"
  note "  base clock/TZ before: $(lab_ssh "$IP" 'date "+%Y-%m-%dT%H:%M %Z (UTC%z)"' </dev/null)"
  note "  shifting TZ -> $ZONE (viewer local date may cross a day boundary)"
  lab_ssh "$IP" "sudo systemsetup -settimezone $ZONE >/dev/null 2>&1" </dev/null
  note "  clock/TZ now: $(lab_ssh "$IP" 'date "+%Y-%m-%dT%H:%M %Z (UTC%z)"' </dev/null)"
  # relaunch so the app recomputes 'today' under the new local date
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\''; sleep 4; open -g -a Things3; sleep 12' </dev/null
  U=$(mk TZ-TODAY-$(echo "$ZONE" | tr '/' '_'))
  note "  before: $(one "$U")"
  gurl "things:///update?id=$U&when=today"
  note "  AFTER when=today under $ZONE: $(one "$U")"
  LOCALDATE=$(lab_ssh "$IP" 'date +%Y-%m-%d' </dev/null)
  note "  guest LOCAL date = $LOCALDATE"
  note "  VERDICT Z-TODAY: which calendar day did startDate get stamped — the GUEST local date ($LOCALDATE)? (certifies the app-host-clock law)"
  note "  restoring base TZ $BASETZ + clock $PIN"
  lab_ssh "$IP" "sudo systemsetup -settimezone $BASETZ >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\''; sleep 4' </dev/null
  note "  restored: $(lab_ssh "$IP" 'date "+%Y-%m-%dT%H:%M %Z"' </dev/null)"
  exit 0
fi

# ==================================================================== interactive verbs
case "$CMD" in
  tz)     lab_ssh "$IP" "sudo systemsetup -settimezone $1 >/dev/null 2>&1; date '+%Y-%m-%dT%H:%M %Z (UTC%z)'" </dev/null; exit 0 ;;
  clock)  lab_ssh "$IP" "sudo date $1 >/dev/null; date '+%Y-%m-%dT%H:%M %Z (UTC%z)'" </dev/null; exit 0 ;;
  relaunch)
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\''; sleep 4' </dev/null
    [ -n "${1:-}" ] && lab_ssh "$IP" "sudo date $1 >/dev/null" </dev/null
    lab_ssh "$IP" "date '+clock %Y-%m-%dT%H:%M %Z'; open -g -a Things3; sleep 14" </dev/null; exit 0 ;;
  quit)   lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\''; sleep 4' </dev/null; exit 0 ;;
  url)    gurl "$1"; echo done; exit 0 ;;
  rawurl) grawurl "$1"; echo done; exit 0 ;;
  as)     gas "$1"; exit 0 ;;
  aslist) gas "tell application \"Things3\" to get name of to dos of list \"$1\""; exit 0 ;;
  one)    one "$1"; exit 0 ;;
  full)   lab_ssh "$IP" "~/things-lab/helpers/full.sh $(printf '%q' "${1:-TZ-%}")" </dev/null; exit 0 ;;
  rows)   lab_ssh "$IP" "~/things-lab/helpers/rows.sh $(printf '%q' "${1:-TZ-%}")" </dev/null; exit 0 ;;
  sql)    lab_ssh "$IP" "~/things-lab/helpers/gsql.sh $(printf '%q' "$1")" </dev/null; exit 0 ;;
  mk)     mk "$1"; exit 0 ;;
  dbdump) lab_ssh "$IP" "~/things-lab/helpers/dbdump.sh $1" </dev/null; echo "dbdump $1"; exit 0 ;;
  shot)   V capture "$OUT/snaps/$1.png"; echo "snap: $OUT/snaps/$1.png"; exit 0 ;;
  click)  V move "$1" "$2" click 1; echo "clicked $1 $2"; exit 0 ;;
  key)    V key "$1"; echo "key $1"; exit 0 ;;
  pull)   for e in dump; do lab_ssh "$IP" "test -f ~/things-lab/dumps/$1.$e" </dev/null && lab_scp "$LAB_SSH_USER@$IP:/Users/admin/things-lab/dumps/$1.$e" "$OUT/" 2>/dev/null; done; echo "pulled $1"; exit 0 ;;
  teardown) tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; echo "torn down $VM"; exit 0 ;;
  *) echo "usage: $0 setup|zsub|zxdate|zxas|zxlist|zxsc|zxcompose|ztoday [zone] | tz|clock|relaunch|url|rawurl|as|aslist|one|full|rows|sql|mk|dbdump|shot|click|key|pull|teardown" >&2; exit 1 ;;
esac
