#!/bin/bash
# TIMEZ2 — the app-relaunch-with-pinned-timezone workaround for the dated-evening
# gap, and its full side-effect inventory. Write-up: docs/lab/timez2-pinned-zone-workaround.md.
#
# Context (TIMEZ, #407, docs/lab/timez-evening-and-zones.md): there is NO vector
# that writes This-Evening (startBucket=1) on any calendar day but the app's
# CURRENT local day (TIMEZ-NODATE); "This Evening" is definitionally this-device
# this-day's evening. And the zone-shift derivations are PURE — a settimezone
# change with the app closed mutates ZERO rows; a rollover relaunch mutates only
# one opaque TMMetaItem day-cursor BLOB (TIMEZ-ROLL-c).
#
# The maintainer's proposed workaround for a dated-evening write: quit Things ->
# relaunch under a DIFFERENT effective timezone (so the app's "today" is the day
# the caller actually wants) -> perform the evening write (which stamps the
# shifted "today") -> quit -> relaunch normally. TIMEZ2 determines FEASIBILITY and
# the full SIDE-EFFECT BILL.
#
# ONE disposable offline Tart clone `timez2-lab`, golden things-lab-golden-v2
# (Things 3.22.12, DB v26). Airgapped (default route deleted). Base clock pinned
# 2026-07-05 12:00 in America/New_York (UTC-4 DST -> pinned instant = 2026-07-05
# 12:00Z, a clean UTC-noon anchor). Writes ONLY through official surfaces (URL
# scheme, AppleScript, Shortcuts proxies). Zone changes: per-process TZ env
# (T2-ENV: TZ=<zone> open / launchctl setenv TZ / direct-exec) is what the
# workflow WANTS; `systemsetup -settimezone` (the TIMEZ recipe) is the guaranteed
# fallback. Day-boundary rolls use `sudo date` (RSIM-S small-increment recipe).
# Clock/TZ/launchctl changes happen in the VM ONLY, never the host. Ground truth =
# guest read-only SQLite (raw bytes + decoded) + full .dump byte-diffs + the
# AppleScript list oracle. Fixtures fully synthetic (TZ2-*).
#
# TRUE two-device sync legs are BLOCKED (no cloud account — SYNC2); cross-device
# claims are modeled from the single-app zone-shift evidence + no-row-mutation
# proofs, bridged by the derivation-purity results.
#
# Subcommands:
#   setup       clone+boot(--vnc-experimental,VNC optional)+airgap+pin+base-TZ+helpers
#   inspect     survey the golden: repeating templates, dated rows near 07-05..07, meta items
#   env         T2-ENV   can effective zone be pinned per-LAUNCH w/o changing system zone?
#   eve         T2-EVE   dated-evening write via a zone pinned AHEAD (host tomorrow)
#   sidefx      T2-SIDEFX full-DB byte-diff of a shifted-forward launch (side-effect bill)
#   dedupe      T2-DEDUPE reset zone -> advance real clock to the shifted day: duplicate or dedupe?
#   reverse     T2-REVERSE zone pinned BEHIND (host yesterday): what stamps + distinct effects?
# Interactive verbs:
#   tz <Zone> | envtz <Zone>|off | clock <MMDDhhmmYYYY> | relaunch [MMDDhhmmYYYY]
#   applaunch <open|launchctl|directexec> <Zone>   (launch Things under a pinned TZ)
#   quit | url <u> | rawurl <u> | as <script> | aslist <list> | one <uuid>
#   full [glob] | rows [glob] | sql <q> | mk <title> | dbdump <label> | pull <label>
#   diffdump <labelA> <labelB> | shot <name> | teardown
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v2}"
BASETZ="${BASETZ:-America/New_York}"    # UTC-4 (DST) base
PIN="${PIN:-070512002026}"              # 2026-07-05 12:00 local (golden pinnedDate)
TODAY="${TODAY:-2026-07-05}"
TMRW="${TMRW:-2026-07-06}"
AHEADTZ="${AHEADTZ:-Pacific/Kiritimati}"   # UTC+14 -> at base instant local date is 07-06 (host tomorrow)
BEHINDTZ="${BEHINDTZ:-Pacific/Midway}"     # UTC-11 -> at base instant local date is 07-04 (host yesterday)
AUTH="9dFi9fY-QBuqFq59yAUxOg"           # golden uriSchemeAuthToken (metadata, not a secret)

VM="timez2-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps"
REPORT="$OUT/report.txt"
STATE="$OUT/state.env"
note() { echo "[timez2] $*" | tee -a "$REPORT"; }

if [ "${1:-}" != "setup" ] && [ "${1:-}" != "" ]; then
  [ -f "$STATE" ] || { echo "no $STATE — run setup first" >&2; exit 2; }
  source "$STATE"
fi

gq()   { lab_ssh "$IP" "~/things-lab/helpers/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gas()  { lab_ssh "$IP" "/usr/bin/osascript -e $(printf '%q' "$1") 2>&1" </dev/null || true; }
gurl() { lab_ssh "$IP" "open -g $(printf '%q' "$1&auth-token=$AUTH")" </dev/null; sleep 2; }
grawurl() { lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; sleep 2; }
V()    { sleep 1; timeout 40 "${VNCDO:-/nonexistent}" -s "$SERVER" -p "$PASS" "$@" 2>>"$OUT/vnc.log"; }
one() { gq "SELECT title||' ty='||type||' start='||start||' sb='||COALESCE(startBucket,'-')||' sd='||COALESCE(startDate,'-')||' sdD='||(CASE WHEN startDate IS NULL THEN '-' ELSE (startDate>>16)||'-'||printf('%02d',(startDate>>12)&15)||'-'||printf('%02d',(startDate>>7)&31) END)||' tiRef='||COALESCE(todayIndexReferenceDate,'-')||' ti='||todayIndex||' rem='||COALESCE(reminderTime,'-')||' dl='||COALESCE(deadline,'-')||' status='||status||' umd='||CAST(COALESCE(userModificationDate,0) AS INT) FROM TMTask WHERE uuid='$1'"; }
uuid_of() { local t="$1" u i; for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE title='$t' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }
mk() { grawurl "things:///add?title=$1"; sleep 1; uuid_of "$1"; }
sav() { echo "$1=$2" >> "$STATE"; }

# --- app-launch under a pinned effective TZ (T2-ENV mechanisms) ---
quit_app() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 4' </dev/null; }
applaunch() { # applaunch <open|launchctl|directexec> <Zone>
  local mech="$1" zone="$2"
  quit_app
  case "$mech" in
    open)       lab_ssh "$IP" "TZ=$zone open -a Things3; sleep 14" </dev/null ;;
    launchctl)  lab_ssh "$IP" "launchctl setenv TZ $zone; open -a Things3; sleep 14" </dev/null ;;
    directexec) lab_ssh "$IP" "TZ=$zone /Applications/Things3.app/Contents/MacOS/Things3 >/tmp/tz2-direct.log 2>&1 & sleep 14" </dev/null ;;
    *) echo "bad mech $mech" >&2; return 2 ;;
  esac
}
envtz_off() { lab_ssh "$IP" 'launchctl unsetenv TZ 2>/dev/null || true' </dev/null; }
sysz() { lab_ssh "$IP" 'sudo systemsetup -gettimezone 2>/dev/null' </dev/null | tr -d '\n'; }
gdate() { lab_ssh "$IP" 'date "+%Y-%m-%d %H:%M %Z (UTC%z)"' </dev/null; }
gldate() { lab_ssh "$IP" 'date +%Y-%m-%d' </dev/null; }
# repeating-machinery snapshot: daily template next-cursor (decoded) + instance count + all-07-06-instance count
rptstate() {
  gq "SELECT 'DAILY-tmpl next=' || COALESCE((SELECT (rt1_nextInstanceStartDate>>16)||'-'||printf('%02d',(rt1_nextInstanceStartDate>>12)&15)||'-'||printf('%02d',(rt1_nextInstanceStartDate>>7)&31) FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NOT NULL AND trashed=0),'?') || '  daily-instances=' || (SELECT COUNT(*) FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NULL AND trashed=0) || '  daily-inst-0706=' || (SELECT COUNT(*) FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NULL AND startDate=132805376 AND trashed=0)"
}

CMD="${1:-}"; shift || true

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  # preflight BEFORE truncating state (a failed preflight must not wipe a live VM's state.env)
  FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
  echo "[timez2] preflight: free ${FREEGB}GB"; [ "${FREEGB:-0}" -lt 5 ] && { echo "[timez2] FATAL: <5GB free"; exit 1; }
  RUNNING=$(pgrep -fl 'tart run' | grep -c 'tart run' || true)
  [ "${RUNNING:-0}" -ge 2 ] && { echo "[timez2] FATAL: $RUNNING VMs running (2-VM ceiling)"; exit 3; }
  : > "$REPORT"; : > "$STATE"
  note "preflight OK: free ${FREEGB}GB"
  if [ -n "${VNCDO:-}" ] && [ -x "${VNCDO:-/nonexistent}" ]; then note "VNC client present ($VNCDO) — GUI shots enabled"; else note "NOTE: no \$VNCDO — headless byte-only (GUI render legs lean on TIMEZ-certified pure derivations)"; fi

  note "cloning $GOLDEN -> $VM"
  pkill -f "tart run $VM" >/dev/null 2>&1 || true
  tart stop "$VM" >/dev/null 2>&1 || true; sleep 2
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM" || { note "clone FAILED"; exit 1; }
  (tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: boot failed"; cat "$OUT/tart-run.log"; exit 1; }
  note "ssh up at $IP"; sav IP "$IP"; sav AUTH "$AUTH"
  [ -n "${VNCDO:-}" ] && sav VNCDO "$VNCDO"
  for i in $(seq 1 20); do VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true); [ -n "$VNC_URL" ] && break; sleep 1; done
  if [ -n "${VNC_URL:-}" ]; then
    HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
    PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
    sav SERVER "$SERVER"; sav PASS "$PASS"; sav VNC_URL "$VNC_URL"; note "vnc: $SERVER"
  fi

  note "airgap + base TZ $BASETZ + pin clock (2026-07-05 12:00 local)"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo route -n delete -inet6 default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null | sed 's/^/[timez2] /'
  lab_ssh "$IP" 'launchctl unsetenv TZ 2>/dev/null || true' </dev/null
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo systemsetup -settimezone $BASETZ >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  note "base TZ: $(sysz)  clock: $(gdate)"

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
GLOB="${1:-TZ2-%}"
sqlite3 -line "file:$DB?mode=ro" "
SELECT title, uuid, type, start, startDate, startBucket, todayIndex, \"index\",
       reminderTime, deadline, todayIndexReferenceDate AS tiRef, status, stopDate,
       userModificationDate AS umd
FROM TMTask WHERE title LIKE '$GLOB' AND trashed=0 ORDER BY title;"
EOF
  lab_ssh "$IP" 'cat > ~/things-lab/helpers/rows.sh && chmod +x ~/things-lab/helpers/rows.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
GLOB="${1:-TZ2-%}"
sqlite3 -header -column "file:$DB?mode=ro" "
SELECT substr(title,1,22) AS title, type AS ty, start AS s, startBucket AS sb, status AS st,
       CASE WHEN startDate IS NULL THEN 'NULL' ELSE (startDate>>16)||'-'||printf('%02d',(startDate>>12)&15)||'-'||printf('%02d',(startDate>>7)&31) END AS startD,
       reminderTime AS remT, todayIndex AS ti,
       CASE WHEN stopDate IS NULL THEN 'NULL' ELSE datetime(stopDate,'unixepoch') END AS stopUTC
FROM TMTask WHERE title LIKE '$GLOB' AND trashed=0 ORDER BY title;"
EOF
  # full-DB .dump for byte-diff, plus a decoded meta-item summary (the day cursor
  # lives in TMMetaItem BLOBs).
  lab_ssh "$IP" 'cat > ~/things-lab/helpers/dbdump.sh && chmod +x ~/things-lab/helpers/dbdump.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
cp "$DB" /tmp/snap.sqlite 2>/dev/null
sqlite3 /tmp/snap.sqlite ".dump" > ~/things-lab/dumps/"$1".dump
sqlite3 "file:$DB?mode=ro" "SELECT uuid, length(value), quote(value) FROM TMMetaItem ORDER BY uuid;" > ~/things-lab/dumps/"$1".meta 2>/dev/null || true
EOF

  note "warm-up launch (recompute Today buckets for pinned date), quit clean"
  lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null
  quit_app
  SCHEMA=$(gq "SELECT COUNT(*) FROM TMTask")
  note "TMTask row count (golden seed sanity): $SCHEMA"
  note "env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26"
  note "############### TIMEZ2 SETUP COMPLETE — VM LEFT RUNNING ###############"
  exit 0
fi

# ==================================================================== inspect
if [ "$CMD" = "inspect" ]; then
  note "################## INSPECT — golden repeating templates + dated landscape ##################"
  note "  repeating templates (rt1_recurrenceRule NOT NULL):"
  lab_ssh "$IP" '~/things-lab/helpers/gsql.sh "SELECT uuid, substr(title,1,28) AS title, type, start, startBucket, CASE WHEN startDate IS NULL THEN NULL ELSE (startDate>>16)||\"-\"||((startDate>>12)&15)||\"-\"||((startDate>>7)&31) END AS sd, rt1_nextInstanceStartDate AS nextRaw FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY title;"' </dev/null | tee -a "$REPORT"
  note "  count of repeating templates: $(gq "SELECT COUNT(*) FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL AND trashed=0")"
  note "  dated rows with startDate in {07-04,07-05,07-06,07-07}:"
  lab_ssh "$IP" '~/things-lab/helpers/gsql.sh "SELECT substr(title,1,26) AS title, start, startBucket AS sb, (startDate>>16)||\"-\"||printf(\"%02d\",(startDate>>12)&15)||\"-\"||printf(\"%02d\",(startDate>>7)&31) AS sd FROM TMTask WHERE startDate IN (132805120,132805248,132805376,132805504) AND trashed=0 ORDER BY startDate, start;"' </dev/null | tee -a "$REPORT"
  note "  TMMetaItem key inventory (day cursor blob candidates):"
  lab_ssh "$IP" '~/things-lab/helpers/gsql.sh "SELECT key, COUNT(*) AS n, SUM(length(value)) AS bytes FROM TMMetaItem GROUP BY key ORDER BY key;"' </dev/null | tee -a "$REPORT"
  exit 0
fi

# ==================================================================== T2-ENV
if [ "$CMD" = "env" ]; then
  note "################## T2-ENV — per-launch effective-zone pin WITHOUT changing system zone ##################"
  note "  base clock/TZ: $(gdate)  system-zone=$(sysz)  guest-local-date=$(gldate)"
  note "  goal: launch Things under an AHEAD zone ($AHEADTZ, local date $TMRW = host tomorrow),"
  note "        write when=today, and see startDate stamp $TMRW (proves the app adopted the pinned zone)."
  note "        SYSTEM zone must stay $BASETZ throughout (the 'without changing system zone' requirement)."
  for MECH in open launchctl directexec; do
    note "  ================= mechanism: $MECH ================="
    envtz_off
    lab_ssh "$IP" "sudo systemsetup -settimezone $BASETZ >/dev/null 2>&1" </dev/null
    applaunch "$MECH" "$AHEADTZ"
    note "    system-zone during test: $(sysz)  (MUST still be $BASETZ)"
    note "    guest shell local date: $(gldate)"
    T="TZ2-ENV-$MECH"
    grawurl "things:///add?title=$T&when=today"; sleep 2
    U=$(uuid_of "$T" || echo "")
    if [ -z "$U" ]; then note "    !! no row created — app did not accept the URL under $MECH (launch likely failed)"; else note "    ROW: $(one "$U")"; fi
    note "    --> startDate=$TMRW means $MECH PINS the app zone; $TODAY means it does NOT."
    envtz_off
  done
  note "  ================= control/fallback: systemsetup -settimezone ================="
  lab_ssh "$IP" "sudo systemsetup -settimezone $AHEADTZ >/dev/null 2>&1" </dev/null
  quit_app; lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null
  note "    system-zone now: $(sysz)  guest-local-date: $(gldate)"
  T="TZ2-ENV-systemsetup"; grawurl "things:///add?title=$T&when=today"; sleep 2
  U=$(uuid_of "$T" || echo ""); [ -n "$U" ] && note "    ROW: $(one "$U")"
  note "  restoring base TZ $BASETZ + clock $PIN + launchctl TZ off"
  envtz_off
  lab_ssh "$IP" "sudo systemsetup -settimezone $BASETZ >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  quit_app
  note "    restored: $(gdate)  system-zone=$(sysz)"
  note "  VERDICT T2-ENV: which mechanism (if any) pins the app's effective zone per-launch without touching the system zone?"
  exit 0
fi

# ==================================================================== T2-EVE
if [ "$CMD" = "eve" ]; then
  MECH="${1:-systemsetup}"
  note "################## T2-EVE — dated-evening write via a zone pinned AHEAD ($MECH) ##################"
  note "  base: $(gdate)  system-zone=$(sysz)"
  note "  --- pin AHEAD ($AHEADTZ, local date $TMRW) and launch Things ---"
  if [ "$MECH" = "systemsetup" ]; then
    lab_ssh "$IP" "sudo systemsetup -settimezone $AHEADTZ >/dev/null 2>&1" </dev/null
    quit_app; lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null
  else
    applaunch "$MECH" "$AHEADTZ"
  fi
  note "    now: $(gdate)  system-zone=$(sysz)  guest-local-date=$(gldate)"
  note "  --- the write TIMEZ proved impossible any other way: when=evening under the shifted today ---"
  T="TZ2-EVE"; U=$(mk "$T")
  note "    before: $(one "$U")"
  gurl "things:///update?id=$U&when=evening"
  note "    AFTER when=evening (expect start=1, sb=1, startDate=$TMRW = shifted today): $(one "$U")"
  note "  --- reset zone to base ($BASETZ, $TODAY) and relaunch normally ---"
  envtz_off
  lab_ssh "$IP" "sudo systemsetup -settimezone $BASETZ >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  quit_app; lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null
  note "    now: $(gdate)  system-zone=$(sysz)"
  note "    row after reset (expect BYTE-IDENTICAL sb=1 startDate=$TMRW — purity): $(one "$U")"
  note "  --- render-law confirmation via AS list oracle (un-shifted viewer, local $TODAY) ---"
  note "    in list Today?    [$(gas "tell application \"Things3\" to (id of to dos of list \"Today\") contains \"$U\"")]"
  note "    in list Anytime?  [$(gas "tell application \"Things3\" to (id of to dos of list \"Anytime\") contains \"$U\"")]"
  note "    in list Upcoming? [$(gas "tell application \"Things3\" to (id of to dos of list \"Upcoming\") contains \"$U\"")]"
  note "  VERDICT T2-EVE: dated-evening (sb=1, startDate=$TMRW) achieved? survives reset byte-identical? pins into flat Today/Anytime a day early for the un-shifted viewer (Z-ROLL-b), NOT Upcoming?"
  exit 0
fi

# ==================================================================== T2-SIDEFX
if [ "$CMD" = "sidefx" ]; then
  MECH="${1:-systemsetup}"
  note "################## T2-SIDEFX — full-DB byte-diff of a shifted-forward launch ($MECH) ##################"
  note "  baseline: app quit, base zone $BASETZ, clock $TODAY. Snapshot BEFORE the shifted launch."
  envtz_off
  lab_ssh "$IP" "sudo systemsetup -settimezone $BASETZ >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  quit_app
  lab_ssh "$IP" '~/things-lab/helpers/dbdump.sh sidefx-base' </dev/null; note "    dbdump sidefx-base"
  note "    repeat-machinery BEFORE: $(rptstate)"
  note "  --- SHIFTED-FORWARD LAUNCH: pin AHEAD ($AHEADTZ, local $TMRW) and launch (recompute for the shifted day) ---"
  if [ "$MECH" = "systemsetup" ]; then
    lab_ssh "$IP" "sudo systemsetup -settimezone $AHEADTZ >/dev/null 2>&1" </dev/null
    quit_app; lab_ssh "$IP" 'open -g -a Things3; sleep 16' </dev/null
  else
    applaunch "$MECH" "$AHEADTZ"; sleep 2
  fi
  note "    now: $(gdate)  system-zone=$(sysz)"
  note "    repeat-machinery AFTER shifted launch (materialized early?): $(rptstate)"
  quit_app
  lab_ssh "$IP" '~/things-lab/helpers/dbdump.sh sidefx-shifted' </dev/null; note "    dbdump sidefx-shifted"
  note "  --- reset to base and relaunch normally; snapshot AFTER reset ---"
  envtz_off
  lab_ssh "$IP" "sudo systemsetup -settimezone $BASETZ >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  quit_app; lab_ssh "$IP" 'open -g -a Things3; sleep 16' </dev/null
  quit_app
  lab_ssh "$IP" '~/things-lab/helpers/dbdump.sh sidefx-reset' </dev/null; note "    dbdump sidefx-reset"
  note "    repeat-machinery AFTER reset: $(rptstate)"
  note "  pull dumps to host for diffing"
  for L in sidefx-base sidefx-shifted sidefx-reset; do
    lab_scp "$LAB_SSH_USER@$IP:/Users/admin/things-lab/dumps/$L.dump" "$OUT/" 2>/dev/null
    lab_scp "$LAB_SSH_USER@$IP:/Users/admin/things-lab/dumps/$L.meta" "$OUT/" 2>/dev/null
  done
  note "  ===== DIFF base -> shifted (the side-effect bill) ====="
  diff "$OUT/sidefx-base.dump" "$OUT/sidefx-shifted.dump" > "$OUT/diff-base-shifted.txt" || true
  note "    changed/added/removed lines: $(wc -l < "$OUT/diff-base-shifted.txt" | tr -d ' ')"
  note "    TMTask lines in diff: $(grep -c 'INSERT INTO TMTask' "$OUT/diff-base-shifted.txt" || true)"
  note "    TMMetaItem lines in diff: $(grep -c 'INSERT INTO TMMetaItem' "$OUT/diff-base-shifted.txt" || true)"
  note "    tables touched:"
  grep '^[<>] INSERT INTO' "$OUT/diff-base-shifted.txt" | sed -E 's/^[<>] INSERT INTO ([A-Za-z0-9_]+).*/\1/' | sort | uniq -c | sed 's/^/      /' | tee -a "$REPORT" || true
  note "  ===== DIFF shifted -> reset (does the backward reset compensate?) ====="
  diff "$OUT/sidefx-shifted.dump" "$OUT/sidefx-reset.dump" > "$OUT/diff-shifted-reset.txt" || true
  note "    changed/added/removed lines: $(wc -l < "$OUT/diff-shifted-reset.txt" | tr -d ' ')"
  grep '^[<>] INSERT INTO' "$OUT/diff-shifted-reset.txt" | sed -E 's/^[<>] INSERT INTO ([A-Za-z0-9_]+).*/\1/' | sort | uniq -c | sed 's/^/      /' | tee -a "$REPORT" || true
  note "  ===== META blob diffs (day cursor) ====="
  note "    base->shifted:"; diff "$OUT/sidefx-base.meta" "$OUT/sidefx-shifted.meta" | sed 's/^/      /' | tee -a "$REPORT" || true
  note "  VERDICT T2-SIDEFX: full inventory — (a) repeating-instance materialization? (b) start 2->1 promotions? (c) day-cursor blob? (d) stale-reminder? (e) umd-silent re-ranks? See $OUT/diff-*.txt for the row-level bill."
  exit 0
fi

# ==================================================================== T2-DEDUPE
if [ "$CMD" = "dedupe" ]; then
  note "################## T2-DEDUPE — early-materialized instance vs real-clock catch-up ##################"
  note "  models two synced devices across zones: device A (ahead) materialized the shifted-day instance early;"
  note "  device B (base) later reaches that day on its real clock. Does the app dedupe or duplicate?"
  note "  --- snapshot BEFORE (base zone/clock $TODAY, app quit) ---"
  envtz_off
  lab_ssh "$IP" "sudo systemsetup -settimezone $BASETZ >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  quit_app; lab_ssh "$IP" '~/things-lab/helpers/dbdump.sh dedupe-0base' </dev/null
  note "    non-template instance rows dated $TMRW BEFORE: $(gq "SELECT COUNT(*) FROM TMTask WHERE startDate=132805376 AND rt1_recurrenceRule IS NULL AND trashed=0")"
  note "    repeat-machinery BEFORE: $(rptstate)"
  note "  --- STEP 1: shifted-forward launch (pin AHEAD -> local $TMRW) to materialize early ---"
  lab_ssh "$IP" "sudo systemsetup -settimezone $AHEADTZ >/dev/null 2>&1" </dev/null
  quit_app; lab_ssh "$IP" 'open -g -a Things3; sleep 16' </dev/null; quit_app
  lab_ssh "$IP" '~/things-lab/helpers/dbdump.sh dedupe-1shifted' </dev/null
  note "    non-template instance rows dated $TMRW AFTER shifted launch: $(gq "SELECT COUNT(*) FROM TMTask WHERE startDate=132805376 AND rt1_recurrenceRule IS NULL AND trashed=0")"
  note "    repeat-machinery AFTER STEP 1 (early materialization): $(rptstate)"
  note "  --- STEP 2: reset zone to base ($BASETZ) BUT keep clock $TODAY; relaunch (backward day step) ---"
  lab_ssh "$IP" "sudo systemsetup -settimezone $BASETZ >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  quit_app; lab_ssh "$IP" 'open -g -a Things3; sleep 16' </dev/null; quit_app
  lab_ssh "$IP" '~/things-lab/helpers/dbdump.sh dedupe-2backreset' </dev/null
  note "    instance rows dated $TMRW after backward reset: $(gq "SELECT COUNT(*) FROM TMTask WHERE startDate=132805376 AND rt1_recurrenceRule IS NULL AND trashed=0")"
  note "    repeat-machinery AFTER STEP 2 (backward step): $(rptstate)"
  note "  --- STEP 3: advance the REAL clock forward to $TMRW (base zone) and relaunch — catch-up ---"
  lab_ssh "$IP" "sudo date 070612002026 >/dev/null" </dev/null
  quit_app; lab_ssh "$IP" 'open -g -a Things3; sleep 16' </dev/null; quit_app
  lab_ssh "$IP" '~/things-lab/helpers/dbdump.sh dedupe-3catchup' </dev/null
  note "    instance rows dated $TMRW AFTER real-clock catch-up: $(gq "SELECT COUNT(*) FROM TMTask WHERE startDate=132805376 AND rt1_recurrenceRule IS NULL AND trashed=0")"
  note "    repeat-machinery AFTER STEP 3 (real-clock catch-up): $(rptstate)"
  note "    --> no increase vs STEP 1 => cursor-keyed DEDUPE; doubled => DUPLICATE."
  note "  pull + diff"
  for L in dedupe-0base dedupe-1shifted dedupe-2backreset dedupe-3catchup; do
    lab_scp "$LAB_SSH_USER@$IP:/Users/admin/things-lab/dumps/$L.dump" "$OUT/" 2>/dev/null
    lab_scp "$LAB_SSH_USER@$IP:/Users/admin/things-lab/dumps/$L.meta" "$OUT/" 2>/dev/null
  done
  note "    meta cursor step 1shifted->2backreset (backward tolerance):"; diff "$OUT/dedupe-1shifted.meta" "$OUT/dedupe-2backreset.meta" | sed 's/^/      /' | tee -a "$REPORT" || true
  diff "$OUT/dedupe-1shifted.dump" "$OUT/dedupe-2backreset.dump" > "$OUT/diff-dedupe-back.txt" || true
  note "    backward-reset dump diff lines: $(wc -l < "$OUT/diff-dedupe-back.txt" | tr -d ' ')  TMTask: $(grep -c 'INSERT INTO TMTask' "$OUT/diff-dedupe-back.txt" || true)"
  diff "$OUT/dedupe-1shifted.dump" "$OUT/dedupe-3catchup.dump" > "$OUT/diff-dedupe-catchup.txt" || true
  note "    catch-up dump diff lines: $(wc -l < "$OUT/diff-dedupe-catchup.txt" | tr -d ' ')  TMTask: $(grep -c 'INSERT INTO TMTask' "$OUT/diff-dedupe-catchup.txt" || true)"
  note "  restore base clock $PIN"
  lab_ssh "$IP" "sudo date $PIN >/dev/null" </dev/null; quit_app
  note "  VERDICT T2-DEDUPE: duplicate or dedupe on catch-up? backward cursor step tolerated (error/compensation/data effect)?"
  exit 0
fi

# ==================================================================== T2-REVERSE
if [ "$CMD" = "reverse" ]; then
  # At 12:00Z (the campaign base) NO real zone is "yesterday" (min real offset
  # UTC-12 lands on 07-05 00:00). So the reverse base pins the clock to 06:00Z
  # (still 07-05 in NY, the base viewer) so a UTC-11 behind zone lands on 07-04.
  # `sudo date` on this guest sets UTC (passing 1200 yielded 08:00 EDT), so 0600 -> 06:00Z.
  REVCLOCK="${REVCLOCK:-070506002026}"   # -> 06:00Z / 02:00 EDT, NY date still 07-05
  note "################## T2-REVERSE — zone pinned BEHIND (host yesterday) ##################"
  note "  base: $(gdate)  system-zone=$(sysz)"
  envtz_off
  lab_ssh "$IP" "sudo systemsetup -settimezone $BASETZ >/dev/null 2>&1; sudo date $REVCLOCK >/dev/null" </dev/null
  note "  reverse base clock (06:00Z, NY date still $TODAY): $(gdate)  guest-local-date=$(gldate)"
  quit_app; lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null; quit_app
  lab_ssh "$IP" '~/things-lab/helpers/dbdump.sh reverse-base' </dev/null
  note "  --- pin BEHIND ($BEHINDTZ, local date should be 07-04) and launch ---"
  lab_ssh "$IP" "sudo systemsetup -settimezone $BEHINDTZ >/dev/null 2>&1" </dev/null
  quit_app; lab_ssh "$IP" 'open -g -a Things3; sleep 16' </dev/null
  note "    now: $(gdate)  system-zone=$(sysz)  guest-local-date=$(gldate)"
  T="TZ2-REV"; grawurl "things:///add?title=$T&when=today"; sleep 2
  U=$(uuid_of "$T" || echo ""); [ -n "$U" ] && note "    when=today ROW (expect startDate=07-04, the behind local day): $(one "$U")"
  quit_app; lab_ssh "$IP" '~/things-lab/helpers/dbdump.sh reverse-behind' </dev/null
  note "  --- reset to base and snapshot (backward launch: distinct side effects vs forward?) ---"
  lab_ssh "$IP" "sudo systemsetup -settimezone $BASETZ >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  quit_app; lab_ssh "$IP" 'open -g -a Things3; sleep 16' </dev/null; quit_app
  lab_ssh "$IP" '~/things-lab/helpers/dbdump.sh reverse-reset' </dev/null
  for L in reverse-base reverse-behind reverse-reset; do
    lab_scp "$LAB_SSH_USER@$IP:/Users/admin/things-lab/dumps/$L.dump" "$OUT/" 2>/dev/null
    lab_scp "$LAB_SSH_USER@$IP:/Users/admin/things-lab/dumps/$L.meta" "$OUT/" 2>/dev/null
  done
  note "  ===== DIFF base -> behind (backward launch side-effect bill) ====="
  diff "$OUT/reverse-base.dump" "$OUT/reverse-behind.dump" > "$OUT/diff-reverse-behind.txt" || true
  note "    diff lines: $(wc -l < "$OUT/diff-reverse-behind.txt" | tr -d ' ')  TMTask: $(grep -c 'INSERT INTO TMTask' "$OUT/diff-reverse-behind.txt" || true)  TMMetaItem: $(grep -c 'INSERT INTO TMMetaItem' "$OUT/diff-reverse-behind.txt" || true)"
  grep '^[<>] INSERT INTO' "$OUT/diff-reverse-behind.txt" | sed -E 's/^[<>] INSERT INTO ([A-Za-z0-9_]+).*/\1/' | sort | uniq -c | sed 's/^/      /' | tee -a "$REPORT" || true
  note "    meta base->behind:"; diff "$OUT/reverse-base.meta" "$OUT/reverse-behind.meta" | sed 's/^/      /' | tee -a "$REPORT" || true
  note "  VERDICT T2-REVERSE: which day does when=today stamp under the behind zone? side effects DISTINCT from forward?"
  exit 0
fi

# ==================================================================== interactive verbs
case "$CMD" in
  tz)     lab_ssh "$IP" "sudo systemsetup -settimezone $1 >/dev/null 2>&1; date '+%Y-%m-%dT%H:%M %Z (UTC%z)'" </dev/null; exit 0 ;;
  envtz)  if [ "$1" = off ]; then envtz_off; echo "launchctl TZ unset"; else lab_ssh "$IP" "launchctl setenv TZ $1" </dev/null; echo "launchctl TZ=$1"; fi; exit 0 ;;
  clock)  lab_ssh "$IP" "sudo date $1 >/dev/null; date '+%Y-%m-%dT%H:%M %Z (UTC%z)'" </dev/null; exit 0 ;;
  relaunch) quit_app; [ -n "${1:-}" ] && lab_ssh "$IP" "sudo date $1 >/dev/null" </dev/null; lab_ssh "$IP" "date '+clock %Y-%m-%dT%H:%M %Z'; open -g -a Things3; sleep 14" </dev/null; exit 0 ;;
  applaunch) applaunch "$1" "$2"; echo "launched $1 $2 ; sysz=$(sysz) ldate=$(gldate)"; exit 0 ;;
  quit)   quit_app; exit 0 ;;
  url)    gurl "$1"; echo done; exit 0 ;;
  rawurl) grawurl "$1"; echo done; exit 0 ;;
  as)     gas "$1"; exit 0 ;;
  aslist) gas "tell application \"Things3\" to get name of to dos of list \"$1\""; exit 0 ;;
  one)    one "$1"; exit 0 ;;
  full)   lab_ssh "$IP" "~/things-lab/helpers/full.sh $(printf '%q' "${1:-TZ2-%}")" </dev/null; exit 0 ;;
  rows)   lab_ssh "$IP" "~/things-lab/helpers/rows.sh $(printf '%q' "${1:-TZ2-%}")" </dev/null; exit 0 ;;
  sql)    lab_ssh "$IP" "~/things-lab/helpers/gsql.sh $(printf '%q' "$1")" </dev/null; exit 0 ;;
  mk)     mk "$1"; exit 0 ;;
  dbdump) lab_ssh "$IP" "~/things-lab/helpers/dbdump.sh $1" </dev/null; echo "dbdump $1"; exit 0 ;;
  pull)   for e in dump meta; do lab_ssh "$IP" "test -f ~/things-lab/dumps/$1.$e" </dev/null && lab_scp "$LAB_SSH_USER@$IP:/Users/admin/things-lab/dumps/$1.$e" "$OUT/" 2>/dev/null; done; echo "pulled $1"; exit 0 ;;
  diffdump) lab_scp "$LAB_SSH_USER@$IP:/Users/admin/things-lab/dumps/$1.dump" "$OUT/" 2>/dev/null; lab_scp "$LAB_SSH_USER@$IP:/Users/admin/things-lab/dumps/$2.dump" "$OUT/" 2>/dev/null; diff "$OUT/$1.dump" "$OUT/$2.dump"; exit 0 ;;
  shot)   V capture "$OUT/snaps/$1.png"; echo "snap: $OUT/snaps/$1.png"; exit 0 ;;
  teardown) tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; echo "torn down $VM"; exit 0 ;;
  *) echo "usage: $0 setup|inspect|env|eve|sidefx|dedupe|reverse | tz|envtz|clock|relaunch|applaunch|quit|url|rawurl|as|aslist|one|full|rows|sql|mk|dbdump|pull|diffdump|shot|teardown" >&2; exit 1 ;;
esac
