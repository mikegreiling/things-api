#!/bin/bash
# BANNER2 — can a fired reminder BANNER break the Repeat-dialog SHAPE PROBE?
#
# THE SIGHTING. During the v0.20.9 release gate (2026-09-03, routed guest,
# golden-v4h) a 12:00 reminder fired while `make-repeating` was driving, and the
# drive's `probe-dialog-shape` step failed with AppleScript `-1700` on that
# attempt — roughly one attempt in two. PTRGD1 §8 settled what a banner does to
# a POINTER gesture (it is small and opaque, so it is never display-sized, and
# the guard refuses and names it). The other half was never measured: whether a
# banner can break a dialog-shape READ, which is an AppleScript ADDRESS rather
# than a screen coordinate. docs/up-next.md §small code carries the cell.
#
# THE CELL. Seed a to-do with a reminder a couple of minutes out and drive
# `make-repeating --dangerously-drive-gui` through the ROUTED CLI, against OTHER
# synthetic to-dos, across the banner's whole lifetime:
#
#   L        the banner's LIFETIME — fire one reminder and poll the on-screen
#            window census at 1 Hz, so the later phases aim at measured windows
#            rather than at an assumption about how long a banner stands.
#   p0       BEFORE — a drive that finishes well before any reminder fires.
#   arrive   ARRIVING — the drive starts a few seconds BEFORE the fire time, so
#            the banner lands in the middle of it (the gate's own shape).
#   standing STANDING — the drive starts the moment the census first sees the
#            banner window.
#   after    DISMISSED — the drive starts after the banner has gone (auto-dismiss,
#            or an Escape posted at it).
#
# Each attempt records the exit code, the error code and message, and the
# `probe-dialog-shape` records out of that attempt's THINGS_API_TRACE=1 trace,
# plus the on-screen census taken at the moment the drive was launched. The
# standing phase runs at least three times, because the sighting was ~1 in 2.
#
# METHOD: ONE disposable clone of things-lab-golden-v4h (the goldens are NEVER
# booted), helpers installed + enabled IN the guest so every drive is the
# field-shaped routed path. Airgapped; the clock is pinned inside the trial wall
# (2026-07-18) and reminder times are computed from the GUEST's own clock.
# Fixtures fully synthetic. PROBE ONLY — nothing is shipped from this campaign.
#
#   TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-banner2.sh setup
#                                                                    … L
#                                                                    … p0
#                                                                    … arrive [n]
#                                                                    … standing [n]
#                                                                    … after [n]
#                                                                    … teardown
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
source lab/scripts/helpers-guest.sh

CMD="${1:-}"
VM="${VM:-banner2-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4h}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/trace"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — inside the trial wall (2026-07-18)

note() { echo "[banner2] $*" | tee -a "$REPORT"; }
kill_vm() { tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
fatal() { note "FATAL: $*"; kill_vm; exit 1; }
load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

# The ON-SCREEN WINDOW CENSUS, in PTRGD1 §8's shape (owner by pid + name, layer,
# bounds), front to back. This is the instrument that says whether a banner is
# standing: a Notification Center BANNER is a small window, distinct from the
# display-sized surface Notification Center always owns.
CENSUS_JXA='ObjC.import("CoreGraphics"); ObjC.import("AppKit");
function run(){
  // The RETURN MUST BE CAST BEFORE IT IS UNWRAPPED. `CGWindowListCopyWindowInfo`
  // hands back a CFArrayRef, and `ObjC.deepUnwrap` on the raw ref answers an
  // EMPTY list rather than throwing — a silent zero that reads exactly like "no
  // windows on screen" (this rig lost a pass to it). The shipped pointer guard
  // does the same two-step: `ObjC.castRefToObject` first.
  var opts = $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;
  var ref = $.CGWindowListCopyWindowInfo(opts, 0);
  if (!ref) return JSON.stringify([]);
  var cast = ObjC.castRefToObject(ref);
  var arr = (cast ? ObjC.deepUnwrap(cast) : null) || [];
  var out = [];
  for (var i=0;i<arr.length;i++){
    var w = arr[i]; var b = w.kCGWindowBounds || {};
    out.push({ pid: w.kCGWindowOwnerPID, owner: String(w.kCGWindowOwnerName||""),
               layer: w.kCGWindowLayer, name: String(w.kCGWindowName||""),
               x: b.X, y: b.Y, w: b.Width, h: b.Height });
  }
  return JSON.stringify(out);
}'

# banner? — the census, reduced to the one question. MEASURED (cell L): while a
# reminder banner stands, Notification Center owns a window; at rest it owns
# none. So the question is whether that owner appears at all.
BANNERQ='#!/bin/bash
# bannerq.sh [json|all] — "BANNER <n>: owner @[x,y wxh] | …", or "no banner"
#
# The census runs INSIDE the Aqua session (`launchctl asuser`). An ssh login has
# no window-server connection of its own, and `CGWindowListCopyWindowInfo` there
# answers an EMPTY list rather than an error — a silent zero that reads exactly
# like "no banner is up" (measured on the first pass of this campaign).
UIDN=$(id -u); ME=$(id -un)
gui() { sudo launchctl asuser "$UIDN" sudo -u "$ME" /usr/bin/env "HOME=$HOME" "PATH=$PATH" "$@"; }
J=$(gui /usr/bin/osascript -l JavaScript ~/labh/census.js 2>&1)
case "${1:-}" in
  json)  printf "%s" "$J"; exit 0 ;;
  all)   printf "%s" "$J" | python3 ~/labh/bannerq.py all; exit 0 ;;
  brief) printf "%s" "$J" | python3 ~/labh/bannerq.py brief; exit 0 ;;
esac
printf "%s" "$J" | python3 ~/labh/bannerq.py'

BANNERPY='import json, sys
raw = sys.stdin.read()
try:
    ws = json.loads(raw)
except Exception:
    print("census unreadable: " + raw[:200]); raise SystemExit
def line(w):
    return "%s(pid %s) L%s @[%s,%s %sx%s] %s" % (
        w.get("owner"), w.get("pid"), w.get("layer"), w.get("x"), w.get("y"),
        w.get("w"), w.get("h"), (w.get("name") or "")[:40])
if len(sys.argv) > 1 and sys.argv[1] == "all":
    for w in ws: print("    " + line(w))
    raise SystemExit
if len(sys.argv) > 1 and sys.argv[1] == "brief":
    # one line, every on-screen window — so a poll can see ANY new surface, not
    # only one whose owner name matches a guess about who owns a banner
    print("%d: " % len(ws) + ", ".join(
        "%s L%s[%sx%s]%s" % (w.get("owner"), w.get("layer"), w.get("w"), w.get("h"),
                             ("/" + (w.get("name") or "")[:24]) if w.get("name") else "")
        for w in ws))
    raise SystemExit
# MEASURED (cell L): a fired reminder banner is presented in a DISPLAY-SIZED
# Notification Center window at layer 23 that exists only while the banner
# stands — the process owns no window at rest. So the presence of ANY
# Notification Center window IS the banner, and the size is reported rather than
# filtered on (PTRGD1 §8 assumed a small window; this guest has none).
hits = [w for w in ws if "notification" in (w.get("owner") or "").lower()]
if not hits:
    print("no banner (%d on-screen windows)" % len(ws))
else:
    print("BANNER %d: " % len(hits) + " | ".join(line(h) for h in hits))'

WATCH='#!/bin/bash
# watch.sh <until-epoch> [interval] — sample the banner question in ONE ssh hop.
# The loop must run IN the guest: an ssh round trip per sample costs seconds and
# a banner stands for a handful of them.
set -u
UNTIL="$1"; IV="${2:-0.5}"; MODE="${3:-brief}"
while :; do
  N=$(python3 -c "import time;print(int(time.time()))")
  echo "$N $(~/labh/bannerq.sh "$MODE")"
  [ "$N" -ge "$UNTIL" ] && break
  sleep "$IV"
done'

gq()  { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt()  { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
bq()  { lab_ssh "$IP" "~/labh/bannerq.sh ${1:-}" </dev/null 2>&1; }
gnow(){ lab_ssh "$IP" "python3 -c 'import time;print(int(time.time()))'" </dev/null 2>/dev/null | tr -d ' '; }
scpO(){ sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'

# THE RULE EVERY DRIVE ASKS FOR, and why it is not `daily`.
#
# `probe-dialog-shape` is emitted ONLY when the requested rule needs a control
# whose index moves with the dialog's version fork — weekdays, monthly, yearly,
# or an explicit next occurrence (`needsShape`, src/write/vectors/ui-recipes.ts).
# A `--frequency daily --interval 1` drive skips the step entirely (measured on
# this clone: 45 trace records, no shape op), so it cannot answer this cell's
# question. A weekly rule WITH weekdays does emit it. The guest clock is pinned
# to Sunday 2026-07-05, and the anchor weekday is included so the request is not
# fenced before it dispatches.
RULE="${RULE:---frequency weekly --interval 1 --weekdays sunday,wednesday}"

# THE OPTIONAL MACHINERY, as an env prefix on the guest command (DEFAULTS3's
# quadrants). The v0.20.9 sighting belongs to the shape probe's POLLING form —
# the one it takes with NO settle sidecar — so an honest negative has to include
# `THINGS_API_AX_OBSERVER=0` attempts, not only the routed observer's
# single-round form. `THINGS_API_PREFILL=0` is the other axis.
DRIVE_ENV="${DRIVE_ENV:-}"

bs()    { lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/things-lab/run/beep-sentinel.sh $*" </dev/null 2>&1; }
bmark() { lab_ssh "$IP" "~/things-lab/run/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }

jparse() {
  python3 -c 'import json,sys
raw=sys.stdin.read()
i,j=raw.find("{"),raw.rfind("}")
if i<0 or j<0: print("(no envelope)"); raise SystemExit
try: d=json.loads(raw[i:j+1])
except Exception as ex: print("(unparsed: %s)"%ex); raise SystemExit
err=(d.get("error") or {})
v=err.get(sys.argv[1])
if v is None and d.get("ok") is True: v="(ok — no error)"
print(str(v if v is not None else "(none)").replace(chr(10)," ")[:700])' "$1"
}

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
  note "preflight: free ${FREEGB}GB"
  [ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free"; exit 1; }
  tart list 2>/dev/null | sed 's/^/    /' | tee -a "$REPORT"
  if tart list 2>/dev/null | awk '{print $NF}' | grep -q running; then
    note "FATAL: a VM is already running — ONE at a time"; exit 1
  fi

  if [ "${SKIP_BUILD:-0}" = "1" ]; then note "SKIP_BUILD=1 — reusing dist/"; else
    note "building dist"; npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
  fi
  [ -f dist/cli/main.js ] || { note "FATAL: no dist/cli/main.js"; exit 1; }
  [ -x "deputy/build/Things API Helper.app/Contents/MacOS/things-deputy" ] || \
    { note "FATAL: no helper bundle — run: bash scripts/build-helpers.sh"; exit 1; }

  note "cloning $GOLDEN -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM" || { note "FATAL: clone failed"; exit 1; }
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 600) || fatal "no SSH"
  note "ssh up at $IP"

  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  [ "$AG" = "AIRGAP-OK" ] || fatal "airgap failed"
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) (trial wall 2026-07-18 — never rolled)"

  lab_ssh "$IP" 'mkdir -p ~/labh ~/things-lab/run ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<<"$GSQL"
  lab_ssh "$IP" 'cat > ~/labh/census.js' <<<"$CENSUS_JXA"
  lab_ssh "$IP" 'cat > ~/labh/bannerq.sh && chmod +x ~/labh/bannerq.sh' <<<"$BANNERQ"
  lab_ssh "$IP" 'cat > ~/labh/bannerq.py' <<<"$BANNERPY"
  lab_ssh "$IP" 'cat > ~/labh/watch.sh && chmod +x ~/labh/watch.sh' <<<"$WATCH"
  scpO lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/things-lab/run/beep-sentinel.sh" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/run/beep-sentinel.sh' </dev/null

  NODE_BIN=$(node -e 'console.log(process.execPath)')
  COMMANDER_DIR=$(lab_commander_dir)
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO -r "$COMMANDER_DIR" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  note "shipped node + dist + commander"

  note "warm-up launch/quit/relaunch"
  lab_ssh "$IP" 'open -g -a Things3; sleep 14; osascript -e "tell application \"Things3\" to quit"; sleep 4; open -a Things3; sleep 14' </dev/null

  TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
  TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
  MACOS=$(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)
  note "env: Things $TVER ($TBLD) / macOS $MACOS / golden $GOLDEN"

  note "provisioning the helper pair in the guest (the ROUTED arm)"
  guest_helpers_provision "$IP" "$CLI" 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1

  STAMP=$(date +%H%M%S)
  { echo "IP=$IP"; echo "STAMP=$STAMP"; } > "$SESSION"

  # ---- the drive TARGETS: plain synthetic to-dos, one per attempt -----------
  note "seeding 12 synthetic drive targets"
  for i in $(seq 1 12); do
    lab_ssh "$IP" "$CLI todo add $(printf '%q' "BAN2-T$i-$STAMP") --json" </dev/null >/dev/null 2>&1
  done
  note "targets: $(gq "SELECT count(*) FROM TMTask WHERE title LIKE 'BAN2-T%-$STAMP' AND trashed=0")"
  note "notification centre on-screen census at rest:"
  bq | sed 's/^/    /' | tee -a "$REPORT"
  note "setup DONE — session in $SESSION"
  exit 0
fi

# --------------------------------------------------------- the shared machinery
# arm_reminder <label> <seconds-from-now> -> echoes the guest epoch it will fire
arm_reminder() {
  local label="$1" secs="$2" now fire hhmm
  now=$(gnow)
  fire=$((now + secs))
  hhmm=$(lab_ssh "$IP" "python3 -c 'import time;print(time.strftime(\"%H:%M\", time.localtime($fire)))'" </dev/null 2>/dev/null | tr -d ' ')
  lab_ssh "$IP" "$CLI todo add $(printf '%q' "$label") --when today --reminder $hhmm --json" </dev/null >/dev/null 2>&1
  # the app fires on the MINUTE, so the real fire moment is the top of $hhmm
  local top
  top=$(lab_ssh "$IP" "python3 -c '
import time
t=time.strptime(\"$hhmm\", \"%H:%M\")
n=time.localtime($fire)
print(int(time.mktime((n.tm_year,n.tm_mon,n.tm_mday,t.tm_hour,t.tm_min,0,0,0,-1))))'" </dev/null 2>/dev/null | tr -d ' ')
  note "    armed $label for $hhmm (guest epoch $top, in $((top - now))s)"
  echo "$top"
}

# drive <target-title> <label> [launch-at-guest-epoch]
# Runs the ROUTED make-repeating with the trace on, sleeping IN THE GUEST until
# the launch moment so the banner and the drive meet where they are supposed to.
# next_target — the oldest seeded to-do that is not a repeater yet. A promote is
# clone-and-replace, so a consumed fixture keeps its title under a NEW uuid with
# a rule attached; "unconsumed" is therefore a property of the row, not of a
# name the caller tracks.
next_target() {
  gq "SELECT uuid || ' ' || title FROM TMTask
      WHERE title LIKE 'BAN2-T%-$STAMP' AND trashed=0 AND type=0
        AND rt1_recurrenceRule IS NULL AND status=0
      ORDER BY creationDate LIMIT 1"
}

drive() {
  local label="$1" at="${2:-0}" target title pair raw rc t0 t1 census
  pair=$(next_target)
  target="${pair%% *}"; title="${pair#* }"
  [ -n "$target" ] || { note "    [$label] NO UNCONSUMED FIXTURE LEFT — run: $0 seed <n>"; return 1; }
  census=$(bq)
  note "    census at launch: $census"
  bmark "$label"
  t0=$(gnow)
  # THE CENSUS RUNS ALONGSIDE THE DRIVE, IN THE GUEST. A banner stands for about
  # six seconds and a drive runs for four, so a census taken before and after the
  # drive can miss the banner entirely and report a phase that never happened.
  # The watcher is a CHILD OF THIS SSH COMMAND with a fixed deadline, `wait`ed on
  # before the command returns — nothing is left running behind us.
  raw=$(lab_ssh "$IP" "
python3 -c 'import time;t=$at-6
d=t-time.time()
time.sleep(d if d>0 else 0)'
~/labh/watch.sh \$(python3 -c 'import time;print(int(max(time.time()+45, $at+45)))') 0.5 brief > ~/labh/w.log 2>&1 &
W=\$!
python3 -c 'import time;t=$at
d=t-time.time()
time.sleep(d if d>0 else 0)'
echo DRIVE-START=\$(python3 -c 'import time;print(int(time.time()))')
THINGS_API_TRACE=1 $DRIVE_ENV $CLI todo make-repeating $(printf '%q' "$target") $RULE --dangerously-drive-gui --json
echo EXIT=\$?
echo DRIVE-END=\$(python3 -c 'import time;print(int(time.time()))')
wait \$W" </dev/null 2>&1)
  t1=$(gnow)
  rc=$(printf '%s' "$raw" | grep -o 'EXIT=[0-9]*' | tail -1 | cut -d= -f2)
  printf '%s\n' "$raw" > "$OUT/$label.json"
  note "    [$label] exit=$rc wall≈$((t1 - t0))s target=$title ($target)"
  note "    [$label] code:    $(printf '%s' "$raw" | jparse code)"
  note "    [$label] message: $(printf '%s' "$raw" | jparse message)"
  note "    [$label] census after: $(bq)"
  # the concurrent census, reduced to its CHANGES, against the drive's own clock
  local ds
  ds=$(printf '%s' "$raw" | grep -o 'DRIVE-START=[0-9]*' | cut -d= -f2)
  lab_ssh "$IP" 'cat ~/labh/w.log' </dev/null 2>/dev/null > "$OUT/watch-$label.log"
  note "    [$label] on-screen census DURING the drive (changes only, s from the drive's start):"
  python3 -c "
import sys
start=int('${ds:-0}' or 0)
prev=None
for line in open(sys.argv[1]):
    p=line.rstrip().split(' ',1)
    if len(p)<2: continue
    try: t=int(p[0])
    except ValueError: continue
    if p[1]!=prev:
        print('      %+ds  %s'%(t-start, p[1][:200])); prev=p[1]
" "$OUT/watch-$label.log" 2>/dev/null | tee -a "$REPORT"
  # the trace: the shape probe's own records, and any AppleScript error number
  lab_ssh "$IP" 'T=$(ls -t ~/.local/state/things-api/trace/* 2>/dev/null | head -1); [ -n "$T" ] && cat "$T"' </dev/null 2>/dev/null > "$OUT/trace/$label.ndjson"
  note "    [$label] trace: $(wc -l < "$OUT/trace/$label.ndjson" | tr -d ' ') record(s) -> $OUT/trace/$label.ndjson"
  local shape errs
  shape=$(grep -o '"primitive":"probe-dialog-shape"[^}]*' "$OUT/trace/$label.ndjson" | tail -2)
  [ -n "$shape" ] && printf '%s\n' "$shape" | sed 's/^/      shape: /' | tee -a "$REPORT"
  errs=$(grep -o '\-1[0-9][0-9][0-9]' "$OUT/trace/$label.ndjson" | sort -u | tr '\n' ' ')
  note "    [$label] AppleScript error numbers in the trace: ${errs:-(none)}"
  note "    [$label] repeat rule in the DB: $(gq "SELECT CASE WHEN rt1_recurrenceRule IS NULL THEN 'none' ELSE 'set' END FROM TMTask WHERE title='$title' AND trashed=0 ORDER BY creationDate DESC LIMIT 1")"
  # WHERE IN THE DRIVE EACH STEP SITS. The banner stands for about six seconds
  # (cell L) and the shape probe is one step of a drive several seconds long, so
  # aiming a phase at the probe needs the probe's own offset, per attempt.
  note "    [$label] step timeline (elapsedMs from the invocation):"
  python3 -c "
import json,sys
for line in open(sys.argv[1]):
    line=line.strip()
    if not line: continue
    try: r=json.loads(line)
    except Exception: continue
    ph=r.get('phase') or ''
    el=r.get('elapsedMs')
    if ph=='ui-dispatch' and r.get('event')=='start':
        print('      +%sms  %s'%(el, r.get('primitive')))
    elif ph=='ui-rawax' and r.get('event')=='op':
        print('      +%sms  rawax %s [%s] %s'%(el, r.get('op'), r.get('verdict'), (r.get('detail') or '')))
    elif ph in ('dialog-shape','session-state'):
        print('      +%sms  %s %s'%(el, ph, json.dumps({k:r[k] for k in ('match','shell','state','verdict') if k in r})))
" "$OUT/trace/$label.ndjson" 2>/dev/null | tee -a "$REPORT"
}

# ==================================================================== L
if [ "$CMD" = "L" ]; then
  load_session
  note ""
  note "############ CELL L — the banner's LIFETIME (1 Hz on-screen census) ############"
  bs reset >/dev/null; bmark "L arm"
  FIRE=$(arm_reminder "BAN2-R0-$STAMP" 150 | tail -1)
  note "  sampling the census from fire-10s to fire+70s, at 2 Hz, in ONE guest-side loop"
  lab_ssh "$IP" "python3 -c 'import time;t=$((FIRE - 10));
d=t-time.time()
time.sleep(d if d>0 else 0)'; ~/labh/watch.sh $((FIRE + 70)) 0.5" </dev/null 2>&1 \
    | python3 -c "import sys
fire=$FIRE
prev=None
for line in sys.stdin:
    parts=line.rstrip().split(' ',1)
    if len(parts)<2: continue
    try: t=int(parts[0])
    except ValueError: continue
    v=parts[1]
    if v!=prev:
        print('    t%+ds: %s'%(t-fire,v)); prev=v" | tee -a "$REPORT"
  bmark "L end"
  note "  the reminder row, as the DB has it:"
  gt "SELECT title, start, startDate, reminderTime, status FROM TMTask WHERE title LIKE 'BAN2-R%-$STAMP' AND trashed=0" | sed 's/^/    /' | tee -a "$REPORT"
  note "  beeps in the lifetime window:"
  bs assert --allow 0 --name banner2-L 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ==================================================================== p0
if [ "$CMD" = "p0" ]; then
  load_session
  note ""
  note "############ PHASE p0 — BEFORE any reminder fires (the control) ############"
  bs reset >/dev/null
  drive "p0-1"
  drive "p0-2"
  bs assert --allow 0 --name banner2-p0 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ==================================================================== arrive
# arrive <attempt-number> — the drive starts LEAD seconds before the fire moment
if [ "$CMD" = "arrive" ]; then
  load_session
  # MEASURED on this clone (p0): the shape probe runs from about +1.6 s to +3.3 s
  # of a drive. A 2 s lead therefore lands the banner (cell L: it appears on the
  # minute and stands ~6 s) inside the probe's own window.
  N="${2:-1}"; LEAD="${LEAD:-2}"
  note ""
  note "############ PHASE arrive#$N — the banner lands MID-DRIVE (lead ${LEAD}s) ############"
  bs reset >/dev/null
  FIRE=$(arm_reminder "BAN2-RA$N-$STAMP" 120 | tail -1)
  drive "arrive-$N" "$((FIRE - LEAD))"
  bs assert --allow 0 --name "banner2-arrive-$N" 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ==================================================================== standing
# standing <attempt-number> — wait for the census to SEE the banner, then drive
if [ "$CMD" = "standing" ]; then
  load_session
  N="${2:-1}"
  note ""
  note "############ PHASE standing#$N — drive the moment the census sees the banner ############"
  bs reset >/dev/null
  FIRE=$(arm_reminder "BAN2-RS$N-$STAMP" 120 | tail -1)
  lab_ssh "$IP" "python3 -c 'import time;t=$FIRE-3;
d=t-time.time()
time.sleep(d if d>0 else 0)'" </dev/null
  SEEN=""
  for i in $(seq 1 40); do
    B=$(bq)
    case "$B" in BANNER*) SEEN="$B"; break ;; esac
    lab_ssh "$IP" 'sleep 1' </dev/null
  done
  if [ -z "$SEEN" ]; then note "  the census never saw a banner — driving anyway, at fire+$(( $(gnow) - FIRE ))s"
  else note "  banner seen: $SEEN"; fi
  drive "standing-$N"
  bs assert --allow 0 --name "banner2-standing-$N" 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ==================================================================== after
# after <attempt-number> — drive once the banner has gone (auto-dismiss or Escape)
if [ "$CMD" = "after" ]; then
  load_session
  N="${2:-1}"
  note ""
  note "############ PHASE after#$N — the banner has been dismissed ############"
  bs reset >/dev/null
  FIRE=$(arm_reminder "BAN2-RD$N-$STAMP" 120 | tail -1)
  lab_ssh "$IP" "python3 -c 'import time;t=$FIRE+2;
d=t-time.time()
time.sleep(d if d>0 else 0)'" </dev/null
  note "  census right after the fire: $(bq)"
  if [ "${ESCAPE:-0}" = "1" ]; then
    note "  posting Escape at the banner: $(lab_ssh "$IP" "/usr/bin/osascript -l JavaScript -e 'ObjC.import(\"CoreGraphics\"); \$.CGEventPost(\$.kCGHIDEventTap, \$.CGEventCreateKeyboardEvent(\$(), 53, true)); \$.CGEventPost(\$.kCGHIDEventTap, \$.CGEventCreateKeyboardEvent(\$(), 53, false)); \"ESC-POSTED\"'" </dev/null 2>&1)"
  else
    note "  waiting ${DISMISS_WAIT:-25}s for the auto-dismiss"
    lab_ssh "$IP" "sleep ${DISMISS_WAIT:-25}" </dev/null
  fi
  note "  census before the drive: $(bq)"
  drive "after-$N"
  bs assert --allow 0 --name "banner2-after-$N" 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ==================================================================== uistate
# The AX / window census the shipped diagnostic renders — asked at a moment the
# caller believes a banner is up, so a reproduction can be described in the same
# vocabulary the field reads (`doctor --ui-state`).
if [ "$CMD" = "uistate" ]; then
  load_session
  note ""
  note "  doctor --ui-state at $(gnow):"
  lab_ssh "$IP" "$CLI doctor --ui-state" </dev/null 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
  note "  census: $(bq)"
  exit 0
fi

# reminders — every reminder carrier this campaign has armed, as the DB has it.
if [ "$CMD" = "reminders" ]; then
  load_session
  note "guest now: $(lab_ssh "$IP" 'date +%H:%M:%S' </dev/null)"
  gt "SELECT title, start, startDate, reminderTime, status,
             (reminderTime >> 7) / 60 AS rt_hh, ((reminderTime >> 7) % 60) AS rt_mm
      FROM TMTask WHERE title LIKE 'BAN2-R%-$STAMP' AND trashed=0 ORDER BY creationDate" \
    | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# seed <n> — more unconsumed drive targets (each promote consumes one).
if [ "$CMD" = "seed" ]; then
  load_session
  N="${2:-6}"
  BASE=$(gq "SELECT count(*) FROM TMTask WHERE title LIKE 'BAN2-T%-$STAMP'")
  for i in $(seq $((BASE + 1)) $((BASE + N))); do
    lab_ssh "$IP" "$CLI todo add $(printf '%q' "BAN2-T$i-$STAMP") --json" </dev/null >/dev/null 2>&1
  done
  note "seeded $N more targets; unconsumed now: $(gq "SELECT count(*) FROM TMTask WHERE title LIKE 'BAN2-T%-$STAMP' AND trashed=0 AND type=0 AND rt1_recurrenceRule IS NULL AND status=0")"
  exit 0
fi

# The whole on-screen window list, front to back (the census, unreduced).
if [ "$CMD" = "census" ]; then
  load_session
  note "on-screen windows at $(gnow):"
  bq all | tee -a "$REPORT"
  note "banner question: $(bq)"
  exit 0
fi

# Re-ship the guest helpers (the rig evolves while the clone stays up).
if [ "$CMD" = "reship" ]; then
  load_session
  lab_ssh "$IP" 'cat > ~/labh/census.js' <<<"$CENSUS_JXA"
  lab_ssh "$IP" 'cat > ~/labh/bannerq.sh && chmod +x ~/labh/bannerq.sh' <<<"$BANNERQ"
  lab_ssh "$IP" 'cat > ~/labh/bannerq.py' <<<"$BANNERPY"
  lab_ssh "$IP" 'cat > ~/labh/watch.sh && chmod +x ~/labh/watch.sh' <<<"$WATCH"
  note "re-shipped census.js / bannerq.sh / bannerq.py / watch.sh"
  exit 0
fi

# ==================================================================== teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: stopping and deleting $VM"
  kill_vm
  tart list 2>/dev/null | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

echo "usage: $0 <setup|L|p0|arrive N|standing N|after N|uistate|teardown>" >&2
exit 2
