#!/bin/bash
# SIT3 — probe sitting 3: arrival / evening / lists.
# Five arms in ONE disposable Tart clone (golden UNTOUCHED):
#   EVEPROJ   project This-Evening mechanics (update-project when=evening, bounce, O03 analog)
#   BANNERACK replicate the Today banner OK headlessly, byte-faithfully (vs BANNER1 L4 oracle)
#   REMSTALE  stale evening/reminder gating law (VM clock-roll +2d, arrival observation)
#   LATERLINK show?id=later-projects / show?id=tomorrow validity
#   SPECLIST  re-run `every list`; knock speculative list specifiers (reorder/get)
#
# Method mirrors research-banner1.sh / research-ordfin2.sh. ONE --vnc-experimental
# clone, airgapped, clock-pinned 2026-07-05. Writes go ONLY through official
# surfaces (URL scheme + AppleScript). Ground truth = guest read-only SQLite reads
# (raw + decoded) + the AppleScript list oracle + VNC screenshots (banner/pip/
# evening render, none of which are AX-reachable). Fixtures fully synthetic (S3-*).
# NO Accessibility grant needed: AppleEvents is an image default; the banner OK is
# not in the AX tree so it is clicked via VNC HID; screenshots come from the VNC
# framebuffer. Clock-rolls happen in the VM ONLY (REMSTALE), never the host.
#
# Usage:
#   VNCDO=<vncdo> bash lab/scripts/research-sit3.sh setup       # clone/boot/airgap/pin/helpers, leaves VM up
#   ... then drive verbs (url/as/aslist/full/rows/sql/clock/relaunch/shot/click/dbdump/pull/teardown)
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"
AUTH="9dFi9fY-QBuqFq59yAUxOg"   # golden uriSchemeAuthToken (metadata, not a secret)

VM="sit3-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps"
REPORT="$OUT/report.txt"
STATE="$OUT/state.env"
note() { echo "[sit3] $*" | tee -a "$REPORT"; }

# ---- verbs that read state (all post-setup commands) ----
if [ "${1:-}" != "setup" ] && [ "${1:-}" != "" ]; then
  [ -f "$STATE" ] || { echo "no $STATE — run setup first"; exit 2; }
  source "$STATE"
fi

V() { sleep 1; timeout 40 "$VNCDO" -s "$SERVER" -p "$PASS" "$@" 2>>"$OUT/vnc.log"; }
AS() { lab_ssh "$IP" "/usr/bin/osascript -e $(printf '%q' "$1") 2>&1" </dev/null; }

cmd="${1:-}"; shift || true
case "$cmd" in
  setup) : ;;  # falls through below
  env)
    echo "Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"; exit 0 ;;
  quit)   lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\''; sleep 4' </dev/null; exit 0 ;;
  launch) lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null; exit 0 ;;
  activate) lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 3' </dev/null; exit 0 ;;
  clock)  lab_ssh "$IP" "sudo date $1 >/dev/null; date" </dev/null; exit 0 ;;
  relaunch)
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\''; sleep 4' </dev/null
    lab_ssh "$IP" "sudo date $1 >/dev/null; date" </dev/null
    lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null; exit 0 ;;
  url)    lab_ssh "$IP" "open -g $(printf '%q' "$1&auth-token=$AUTH"); sleep 2" </dev/null; exit 0 ;;
  urlf)   lab_ssh "$IP" "open $(printf '%q' "$1&auth-token=$AUTH"); sleep 3" </dev/null; exit 0 ;;
  rawurl) lab_ssh "$IP" "open -g $(printf '%q' "$1"); sleep 2" </dev/null; exit 0 ;;
  rawurlf) lab_ssh "$IP" "open $(printf '%q' "$1"); sleep 3" </dev/null; exit 0 ;;
  as)     AS "$1"; exit 0 ;;
  aslist) AS "tell application \"Things3\" to get name of to dos of list \"$1\""; exit 0 ;;
  sql)    lab_ssh "$IP" "~/things-lab/helpers/gsql.sh $(printf '%q' "$1")" </dev/null; exit 0 ;;
  sqll)   lab_ssh "$IP" "~/things-lab/helpers/gsql.sh -l $(printf '%q' "$1")" </dev/null; exit 0 ;;
  full)   lab_ssh "$IP" "~/things-lab/helpers/full.sh $(printf '%q' "${1:-S3-%}")" </dev/null; exit 0 ;;
  rows)   lab_ssh "$IP" "~/things-lab/helpers/rows.sh $(printf '%q' "${1:-S3-%}")" </dev/null; exit 0 ;;
  shot)   V capture "$OUT/snaps/$1.png"; echo "snap: $OUT/snaps/$1.png"; exit 0 ;;
  click)  V move "$1" "$2" click 1; echo "clicked $1 $2"; exit 0 ;;
  key)    V key "$1"; echo "key $1"; exit 0 ;;
  dbdump) lab_ssh "$IP" "~/things-lab/helpers/dbdump.sh $1" </dev/null; echo "dbdump $1 done"; exit 0 ;;
  pull)
    for ext in dump full1 full2; do
      lab_scp "$LAB_SSH_USER@$IP:/Users/admin/things-lab/dumps/$1.$ext" "$OUT/" 2>/dev/null || true
    done; echo "pulled $1.* -> $OUT/"; exit 0 ;;
  teardown) tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; echo "torn down $VM"; exit 0 ;;
  *) echo "unknown verb: $cmd"; exit 2 ;;
esac

# ================= SETUP =================
: > "$REPORT"; : > "$STATE"
sav() { echo "$1=$2" >> "$STATE"; }
if [ -z "$VNCDO" ] || [ ! -x "$VNCDO" ]; then note "FATAL: \$VNCDO (vncdotool) not set/executable."; exit 1; fi
FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB, VNCDO=$VNCDO"
[ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free."; exit 1; }
RUNNING=$(pgrep -fl 'tart run' | grep -c 'tart run' || true)
[ "${RUNNING:-0}" -ge 2 ] && { note "FATAL: $RUNNING VMs running (2-VM limit); not reaping a sibling's slot."; pgrep -fl 'tart run' >&2; exit 3; }

note "cloning golden -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: boot failed"; cat "$OUT/tart-run.log"; exit 1; }
note "ssh up at $IP"; sav IP "$IP"; sav VNCDO "$VNCDO"; sav AUTH "$AUTH"
# extract VNC server/pass from tart-run.log (vnc://user:pass@host:port)
for i in $(seq 1 20); do VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true); [ -n "$VNC_URL" ] && break; sleep 1; done
[ -z "$VNC_URL" ] && { note "FATAL: no VNC url in tart-run.log"; exit 1; }
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
sav SERVER "$SERVER"; sav PASS "$PASS"; sav VNC_URL "$VNC_URL"
note "vnc: $SERVER"

note "airgap + pin clock 2026-07-05 12:00"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo route -n delete -inet6 default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null | sed 's/^/[sit3] /'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"

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

# full.sh — ALL brief-tracked columns, RAW bytes, for a title glob (exact before/after evidence)
lab_ssh "$IP" 'cat > ~/things-lab/helpers/full.sh && chmod +x ~/things-lab/helpers/full.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
GLOB="${1:-S3-%}"
sqlite3 -line "file:$DB?mode=ro" "
SELECT title, uuid, type, start, startDate, startBucket, todayIndex, \"index\",
       reminderTime, deadline, deadlineSuppressionDate, project, area, heading,
       userModificationDate AS umd
FROM TMTask WHERE title LIKE '$GLOB' ORDER BY title;"
EOF

# rows.sh — compact decoded per-row Today/evening dump for a title glob
lab_ssh "$IP" 'cat > ~/things-lab/helpers/rows.sh && chmod +x ~/things-lab/helpers/rows.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
GLOB="${1:-S3-%}"
sqlite3 -header -column "file:$DB?mode=ro" "
SELECT substr(title,1,18) AS title, type AS ty, start AS s, startBucket AS sb, status AS st,
       CASE WHEN startDate IS NULL THEN 'NULL' ELSE (startDate>>16)||'-'||printf('%02d',(startDate>>12)&15)||'-'||printf('%02d',(startDate>>7)&31) END AS startD,
       CASE WHEN deadline  IS NULL THEN 'NULL' ELSE (deadline>>16)||'-'||printf('%02d',(deadline>>12)&15)||'-'||printf('%02d',(deadline>>7)&31)  END AS deadl,
       reminderTime AS remT, todayIndex AS ti, \"index\" AS ix,
       CASE WHEN deadlineSuppressionDate IS NULL THEN '.' ELSE 'supp' END AS supp
FROM TMTask WHERE title LIKE '$GLOB' ORDER BY title;"
EOF

# dbdump.sh — full .dump (ro copy) for before/after byte diffs
lab_ssh "$IP" 'cat > ~/things-lab/helpers/dbdump.sh && chmod +x ~/things-lab/helpers/dbdump.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
cp "$DB" /tmp/snap.sqlite 2>/dev/null
sqlite3 /tmp/snap.sqlite ".dump" > ~/things-lab/dumps/"$1".dump
EOF

note "warm-up launch (recompute Today buckets), quit clean"
lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\''; sleep 4' </dev/null

# schema fingerprint sanity
SCHEMA=$(lab_ssh "$IP" '~/things-lab/helpers/gsql.sh -q "SELECT COUNT(*) FROM TMTask"' </dev/null)
note "TMTask row count (golden seed sanity): $SCHEMA"

note ""
note "############### SIT3 SETUP COMPLETE — VM LEFT RUNNING ###############"
note "  state: $STATE"; sed 's/^/    /' "$STATE"
note "  env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
note "NEXT: drive verbs (url/as/aslist/full/rows/sql/clock/relaunch/shot/click/dbdump/pull/teardown)."
