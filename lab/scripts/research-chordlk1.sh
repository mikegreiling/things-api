#!/bin/bash
# CHORDLK1 — does the ⌘-arrow reorder chord land while the session is LOCKED?
#
# THE QUESTION. CHORD2 (docs/lab/chord2-reorder-laws.md §1) measured the chord
# gesture as fully BACKGROUNDED: the shipped AX row/heading selector sets the
# selection, `CGEventPostToPid` delivers the chord, Finder stays frontmost and
# the disruption monitor sees nothing. LOCKSCR1 (docs/lab/lockscr1-locked-session.md)
# then gated every GUI drive on the session dictionary, and `chord-reorder` is
# one of the two primitives that makes a recipe gated
# (`recipeNeedsUnlockedSession`, src/write/vectors/ui.ts) — so the FIELD CLI
# refuses when the screen is locked, exit 4, before anything is posted.
#
# What nobody measured is whether the PRIMITIVE would have worked. That matters
# for the chord-reorder build (docs/up-next.md): if the gesture lands under a
# lock, refusing is a POLICY choice worth arguing; if it does not, the refusal
# is simply the truth and the vector table needs no locked-screen row at all.
#
# THE CELLS, per screen state (unlocked baseline / bare screen saver / hard lock):
#
#   A1  PRE-SELECTED — select the row while UNLOCKED, enter the state, then post
#       ONLY the chord. Isolates delivery from addressing.
#   A2  SELECT-IN-STATE — run the shipped selector while the state is up, then
#       (if it answered) the chord. This is the shape a drive would actually take.
#   A3  THE FIELD ATTEMPT — `project move-heading … --dangerously-drive-gui`
#       through the ROUTED CLI (helpers installed + enabled in the guest), for
#       the refusal text and exit code the gate is expected to produce.
#
# Every arm reports: the session dictionary before and after, the selection
# readback, the DB `index` oracle before and after, the beep count (sentinel,
# THINGS_LAB_BEEPS_OK=1 — accounting, never a mute), the frontmost process, and
# whether the saver/lock went away underneath us.
#
# METHOD: ONE disposable clone of things-lab-golden-v4h at a time (the goldens are
# NEVER booted). Airgapped, clock pinned 2026-07-05 12:00 and never rolled (the
# trial wall is 2026-07-18 — docs/lab/harness.md). Fixtures fully synthetic.
# PROBE ONLY — no operation is shipped from this campaign.
#
# LOCKSCR1 §1 law 2: a screen-saver sitting leaves `CGSSessionScreenIsLocked`
# set for the rest of the login unless it is DISMISSED (LOCKSCR2 measured the
# lone left-Shift that does it on a no-password saver). So the states run in the
# order unlocked -> saver -> (shift dismissal, verified) -> hard lock on ONE
# clone, and `state` refuses to run if the dictionary is not what that state
# needs — at which point re-run the remaining state on a fresh clone.
#
#   TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-chordlk1.sh setup
#                                                                     … unlocked
#                                                                     … saver
#                                                                     … locked
#                                                                     … teardown
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
source lab/scripts/helpers-guest.sh

CMD="${1:-}"
VM="${VM:-chordlk1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4h}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — inside the trial wall (2026-07-18)

note() { echo "[chordlk1] $*" | tee -a "$REPORT"; }
kill_vm() { tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
fatal() { note "FATAL: $*"; kill_vm; exit 1; }

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

# The session dictionary, read INSIDE the Aqua session (the field shape) and
# again over plain ssh — LOCKSCR1 §1 law 3 says the two agree; recorded so this
# campaign does not assume it.
LOCKSTATE='#!/bin/bash
# lockstate.sh <dict|dict-ssh|saver-on|saver-off-shift|lock-now|ps>
set -u
UIDN=$(id -u); ME=$(id -un)
gui() { sudo launchctl asuser "$UIDN" sudo -u "$ME" /usr/bin/env "HOME=$HOME" "PATH=$PATH" "$@"; }
SESS_JXA='"'"'
ObjC.import("CoreGraphics"); ObjC.import("AppKit");
function lockDict(){ var d=null; try { d=$.CGSessionCopyCurrentDictionary() } catch(e){ return null }
  if(!d) return null;
  var tries=[function(){return ObjC.deepUnwrap(ObjC.castRefToObject(d))},
             function(){return ObjC.deepUnwrap(d)}, function(){return d.js}];
  for(var i=0;i<tries.length;i++){ try{ var v=tries[i](); if(v&&typeof v==="object"&&!(v instanceof Array)) return v }catch(e){} }
  return null }
function saver(){ try{ var a=$.NSWorkspace.sharedWorkspace.runningApplications,n=Number(a.count);
  for(var i=0;i<n;i++){ var b=null; try{ b=ObjC.unwrap(a.objectAtIndex(i).bundleIdentifier) }catch(e){}
    if(typeof b==="string"&&b.toLowerCase().indexOf("screensaver")>=0) return true } return false }catch(e){ return null } }
var out={keys:[],locked:null,lockedTime:null,secureInputPid:null,onConsole:null,saver:saver(),source:"unavailable"};
var d=lockDict();
if(d!==null){ out.source="session-dictionary";
  for(var k in d) if(Object.prototype.hasOwnProperty.call(d,k)) out.keys.push(k);
  out.keys.sort();
  if(out.keys.indexOf("CGSSessionScreenIsLocked")>=0) out.locked=!!d["CGSSessionScreenIsLocked"];
  if(out.keys.indexOf("CGSSessionScreenLockedTime")>=0) out.lockedTime=d["CGSSessionScreenLockedTime"];
  if(out.keys.indexOf("kCGSSessionSecureInputPID")>=0) out.secureInputPid=d["kCGSSessionSecureInputPID"];
  if(out.keys.indexOf("kCGSSessionOnConsoleKey")>=0) out.onConsole=!!d["kCGSSessionOnConsoleKey"];
  else if(out.keys.indexOf("kCGSessionOnConsoleKey")>=0) out.onConsole=!!d["kCGSessionOnConsoleKey"]; }
JSON.stringify(out)'"'"'
# LOCKSCR2 §1.3: a lone left-Shift (key code 56) dismisses a NO-PASSWORD saver
# and clears the session keys with it. It types nothing and cancels nothing.
SHIFT_JXA='"'"'
ObjC.import("CoreGraphics");
var d=$.CGEventCreateKeyboardEvent($(),56,true), u=$.CGEventCreateKeyboardEvent($(),56,false);
$.CGEventSetFlags(d,0); $.CGEventSetFlags(u,0);
$.CGEventPost($.kCGHIDEventTap,d); delay(0.05);
$.CGEventPost($.kCGHIDEventTap,u); "SHIFT-POSTED"'"'"'
case "${1:-}" in
  dict)     gui /usr/bin/osascript -l JavaScript -e "$SESS_JXA" 2>&1 ;;
  dict-ssh) /usr/bin/osascript -l JavaScript -e "$SESS_JXA" 2>&1 ;;
  saver-on)
    sudo sysadminctl -screenLock off -password admin >/dev/null 2>&1
    echo "screenLock setting: $(sudo sysadminctl -screenLock status 2>&1 | tr "\n" " ")"
    open -a ScreenSaverEngine >/dev/null 2>&1; sleep 5
    echo "ScreenSaverEngine: $(pgrep -x ScreenSaverEngine >/dev/null 2>&1 && echo running || echo absent)" ;;
  saver-off-shift)
    gui /usr/bin/osascript -l JavaScript -e "$SHIFT_JXA" 2>&1; sleep 4
    echo "ScreenSaverEngine: $(pgrep -x ScreenSaverEngine >/dev/null 2>&1 && echo running || echo absent)" ;;
  lock-now)
    sudo sysadminctl -screenLock immediate -password admin 2>&1 | sed "s/^/  /"
    gui /usr/bin/python3 -c "import ctypes; lf=ctypes.CDLL(\"/System/Library/PrivateFrameworks/login.framework/Versions/Current/login\"); print(\"SACLockScreenImmediate rc=\", lf.SACLockScreenImmediate())" 2>&1 | sed "s/^/  /"
    sleep 5
    echo "ScreenSaverEngine: $(pgrep -x ScreenSaverEngine >/dev/null 2>&1 && echo running || echo absent)" ;;
  runjxa) shift; gui /usr/bin/osascript -l JavaScript "$1" 2>&1 ;;
  ps) echo "ScreenSaverEngine: $(pgrep -x ScreenSaverEngine >/dev/null 2>&1 && echo running || echo absent); Things3: $(pgrep -x Things3 >/dev/null 2>&1 && echo alive || echo dead)" ;;
  *) echo "usage: lockstate.sh <dict|dict-ssh|saver-on|saver-off-shift|lock-now|ps>" >&2; exit 2 ;;
esac'

TJSON='#!/bin/bash
URL=$(python3 -c "import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))" "$1" "$2")
open -g "$URL"'

gq()  { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt()  { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
lst() { lab_ssh "$IP" "~/labh/lockstate.sh $1" </dev/null 2>&1; }
show()     { lab_ssh "$IP" "open -g $(printf '%q' "$1"); sleep 3" </dev/null; }
front()    { axq 'tell application "System Events" to return name of first process whose frontmost is true'; }
tofinder() { lab_ssh "$IP" 'osascript -e '\''tell application "Finder" to activate'\''; sleep 3' </dev/null; }
scpO()     { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }

bs()    { lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/things-lab/run/beep-sentinel.sh $*" </dev/null 2>&1; }
bmark() { lab_ssh "$IP" "~/things-lab/run/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }

# The disruption monitor is baked into golden-v4 and NOT into v4h, so on this
# arm the slice is usually "(no monitor)". The frontmost readings either side of
# every chord carry the disruption question here.
mon_mark()  { MON_AT=$(lab_ssh "$IP" 'wc -l < ~/things-lab/events.ndjson 2>/dev/null || echo 0' </dev/null 2>/dev/null | tr -d ' '); }
mon_slice() { lab_ssh "$IP" "test -f ~/things-lab/events.ndjson && tail -n +$(( ${MON_AT:-0} + 1 )) ~/things-lab/events.ndjson || true" </dev/null 2>/dev/null; }
mon_note()  {
  local sl nl
  if ! lab_ssh "$IP" 'test -f ~/things-lab/events.ndjson' </dev/null 2>/dev/null; then
    note "      monitor slice for $1: (no monitor on this golden)"; return 0
  fi
  sl=$(mon_slice); nl=$(printf '%s' "$sl" | grep -c .)
  note "      monitor slice for $1: $nl event(s)"
  [ "$nl" -gt 0 ] && printf '%s\n' "$sl" | sed 's/^/        /' | tee -a "$REPORT"
  return 0
}

# ---- the DB oracles (the ONLY witness that a chord landed) -----------------
torder() { gq "SELECT COALESCE(group_concat(t,' < '),'(none)') FROM (SELECT title AS t FROM TMTask WHERE project='$1' AND type=0 AND heading IS NULL AND trashed=0 ORDER BY \"index\" ASC)"; }
horder() { gq "SELECT COALESCE(group_concat(t,' < '),'(none)') FROM (SELECT title AS t FROM TMTask WHERE project='$1' AND type=2 AND trashed=0 ORDER BY \"index\" ASC)"; }
tidx()   { gt "SELECT title, substr(uuid,1,8) AS uuid8, \"index\" AS idx FROM TMTask WHERE project='$1' AND type=0 AND heading IS NULL AND trashed=0 ORDER BY \"index\""; }
pid_of() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND trashed=0 LIMIT 1"; }

CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
TABLE='table 1 of scroll area 1 of (first window whose subrole is "AXStandardWindow")'

# The SHIPPED primitives, generated from dist and run over ssh under the guest's
# own AXVM1 Accessibility grant — this is the gate BYPASS: the scripts the ui
# vector would have run, invoked without the vector's session gate in front of
# them. `src/write/vectors/session-lock.ts` exposes no env override (checked),
# so bypassing means invoking the primitive, never a flag.
selrow() {
  node -e "import('./dist/write/vectors/ui.js').then(m=>process.stdout.write(m.axSelectRowScript(process.argv[1], process.argv[2])))" \
    "$TABLE" "$1" > "$OUT/sel-row.applescript" || return 1
  lab_ssh "$IP" 'cat > ~/labh/sel-row.applescript' < "$OUT/sel-row.applescript"
  lab_ssh "$IP" 'osascript ~/labh/sel-row.applescript' </dev/null 2>&1
}
chord() {
  node -e "import('./dist/write/vectors/ui-chord.js').then(m=>process.stdout.write(m.jxaChordScript(process.argv[1])))" \
    "$1" > "$OUT/chord-$1.js" || return 1
  lab_ssh "$IP" "cat > ~/labh/chord-$1.js" < "$OUT/chord-$1.js"
  lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/chord-$1.js" </dev/null 2>&1
}
selreadback() { axq 'tell application "Things3" to get name of selected to dos'; }
# The SHIPPED saver nudge (LOCKSCR2), run inside the Aqua session. Used here to
# return a saver sitting to `unlocked` so one clone can host more than one state.
wake() {
  node -e "import('./dist/write/vectors/session-lock.js').then(m=>process.stdout.write(m.jxaWakeScreenSaverScript()))" > "$OUT/wake.js" || return 1
  lab_ssh "$IP" 'cat > ~/labh/wake.js' < "$OUT/wake.js"
  lab_ssh "$IP" '~/labh/lockstate.sh runjxa ~/labh/wake.js' </dev/null 2>&1
}

# jparse <code|message|remediation> — read one field out of a CLI --json
# envelope on stdin. The guest's node prints an ExperimentalWarning to stderr,
# which this transcript merges, so the envelope is sliced out by brace rather
# than parsed from the whole stream.
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
print(str(v if v is not None else "(none)").replace(chr(10)," ")[:600])' "$1"
}

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
  note "preflight: free ${FREEGB}GB"
  [ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free"; exit 1; }
  note "preflight: VM table —"
  tart list 2>/dev/null | sed 's/^/    /' | tee -a "$REPORT"
  if tart list 2>/dev/null | awk '{print $NF}' | grep -q running; then
    note "FATAL: a VM is already running — ONE at a time"; exit 1
  fi

  if [ "${SKIP_BUILD:-0}" = "1" ]; then note "SKIP_BUILD=1 — reusing dist/"; else
    note "building dist"
    npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
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
  lab_ssh "$IP" 'cat > ~/labh/lockstate.sh && chmod +x ~/labh/lockstate.sh' <<<"$LOCKSTATE"
  lab_ssh "$IP" 'cat > ~/labh/tjson.sh && chmod +x ~/labh/tjson.sh' <<<"$TJSON"
  scpO lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/things-lab/run/beep-sentinel.sh" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/run/beep-sentinel.sh' </dev/null

  note "disruption monitor: $(lab_ssh "$IP" 'launchctl list 2>/dev/null | grep -i disrupt || echo "(not listed)"' </dev/null)"

  NODE_BIN=$(node -e 'console.log(process.execPath)')
  COMMANDER_DIR=$(lab_commander_dir)
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO -r "$COMMANDER_DIR" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  note "shipped node + dist + commander"

  note "warm-up launch/quit/relaunch"
  lab_ssh "$IP" 'open -g -a Things3; sleep 14; osascript -e "tell application \"Things3\" to quit"; sleep 4; open -g -a Things3; sleep 12' </dev/null

  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  [ -n "$TOKEN" ] || fatal "no auth token"
  TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
  TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
  MACOS=$(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)
  DBV=$(gq "SELECT value FROM Meta WHERE key='databaseVersion'" 2>/dev/null || echo "?")
  note "env: Things $TVER ($TBLD) / macOS $MACOS / golden $GOLDEN / DB $DBV"

  note "provisioning the helper pair in the guest (the ROUTED arm)"
  guest_helpers_provision "$IP" "$CLI" 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
  note "ui-enabled=true; helpers-enabled=$(lab_ssh "$IP" "$CLI config get helpers-enabled" </dev/null 2>&1 | tail -1)"

  # ---- fixtures (fully synthetic) -----------------------------------------
  STAMP=$(date +%H%M%S)
  ITEMS=""
  for i in 1 2 3 4 5; do ITEMS="$ITEMS{\"type\":\"to-do\",\"attributes\":{\"title\":\"CLK1-T$i-$STAMP\"}},"; done
  lab_ssh "$IP" "~/labh/tjson.sh $(printf '%q' "$TOKEN") $(printf '%q' "[{\"type\":\"project\",\"attributes\":{\"title\":\"CLK1-P-$STAMP\",\"items\":[${ITEMS%,}]}}]")" </dev/null; sleep 5
  HITEMS=""
  for i in 1 2 3; do HITEMS="$HITEMS{\"type\":\"heading\",\"attributes\":{\"title\":\"CLK1-H$i-$STAMP\"}},"; done
  lab_ssh "$IP" "~/labh/tjson.sh $(printf '%q' "$TOKEN") $(printf '%q' "[{\"type\":\"project\",\"attributes\":{\"title\":\"CLK1-HP-$STAMP\",\"items\":[${HITEMS%,}]}}]")" </dev/null; sleep 5

  PT=$(pid_of "CLK1-P-$STAMP"); PH=$(pid_of "CLK1-HP-$STAMP")
  [ -n "$PT" ] && [ -n "$PH" ] || fatal "fixtures did not land (PT='$PT' PH='$PH')"
  note "fixtures: to-do project $PT ($(torder "$PT"))"
  note "          heading project $PH ($(horder "$PH"))"

  { echo "IP=$IP"; echo "TOKEN=$TOKEN"; echo "STAMP=$STAMP"; echo "PT=$PT"; echo "PH=$PH"; } > "$SESSION"
  note "setup DONE — session in $SESSION"
  exit 0
fi

# ------------------------------------------------------- the per-state cell run
# state_cells <label> <enter-state-fn|-> <expect: unlocked|locked>
state_cells() {
  local label="$1" enter="$2" expect="$3"
  note ""
  note "################ STATE: $label ################"
  bs reset >/dev/null; bmark "$label setup"

  note "  session BEFORE anything: $(lst dict)"

  # ---------------- A1: PRE-SELECTED, then enter the state, then chord only
  note ""
  note "  --- A1 [$label]: select while UNLOCKED, enter the state, post ONLY the chord ---"
  show "things:///show?id=$PT"
  tofinder
  note "      frontmost before anything: [$(front)]"
  local SEL1 B1 A1 RB1
  SEL1=$(selrow "CLK1-T3-$STAMP")
  note "      shipped selector (unlocked) -> [$SEL1]"
  RB1=$(selreadback); note "      selection readback (unlocked): [$RB1]"
  if [ "$enter" != "-" ]; then
    note "      entering the state:"
    lst "$enter" | sed 's/^/        /' | tee -a "$REPORT"
  fi
  note "      session AFTER entering: $(lst dict)"
  note "      session over plain ssh:  $(lst dict-ssh)"
  B1=$(torder "$PT")
  bmark "$label A1 chord"; mon_mark
  note "      order BEFORE: $B1"
  note "      chord ⌘↑ (shipped primitive, posted to pid): $(chord up-one)"
  lab_ssh "$IP" 'sleep 3' </dev/null
  A1=$(torder "$PT")
  note "      order AFTER:  $A1"
  if [ "$A1" != "$B1" ]; then note "      *** A1 [$label]: THE CHORD LANDED — $B1  ==>  $A1 ***"
  else note "      *** A1 [$label]: NO DELTA — the chord did not land ***"; fi
  mon_note "A1"
  note "      state after the chord: $(lst ps)"
  note "      session after the chord: $(lst dict)"
  note "      selection readback after: [$(selreadback)]"
  note "      frontmost after: [$(front)]"
  tidx "$PT" | sed 's/^/        /' | tee -a "$REPORT"

  # ---------------- A2: run the shipped SELECTOR while the state is up
  note ""
  note "  --- A2 [$label]: run the shipped SELECTOR in-state, then the chord ---"
  local SEL2 B2 A2
  bmark "$label A2 select"
  SEL2=$(selrow "CLK1-T5-$STAMP")
  note "      shipped selector (in-state) -> [$SEL2]"
  note "      selection readback: [$(selreadback)]"
  B2=$(torder "$PT")
  bmark "$label A2 chord"; mon_mark
  note "      chord ⌘↑: $(chord up-one)"
  lab_ssh "$IP" 'sleep 3' </dev/null
  A2=$(torder "$PT")
  if [ "$A2" != "$B2" ]; then note "      *** A2 [$label]: THE CHORD LANDED — $B2  ==>  $A2 ***"
  else note "      *** A2 [$label]: NO DELTA — $A2 ***"; fi
  mon_note "A2"

  # ---------------- A2b: the same STALE selection, chorded the OTHER way
  # A1 moves the pre-selected row UP, so a second ⌘↑ can be DECLINED for having
  # nowhere to go — which looks exactly like a chord that never arrived. ⌘↓ on
  # the same row always has somewhere to go, so this arm separates "declined" from
  # "not delivered" on the delta, the way the beep separates them on the sentinel.
  note ""
  note "  --- A2b [$label]: the SAME (stale) selection, chorded ⌘↓ — delivery vs decline ---"
  local B3 A3D
  B3=$(torder "$PT")
  bmark "$label A2b chord"; mon_mark
  note "      selection readback: [$(selreadback)]"
  note "      chord ⌘↓: $(chord down-one)"
  lab_ssh "$IP" 'sleep 3' </dev/null
  A3D=$(torder "$PT")
  if [ "$A3D" != "$B3" ]; then note "      *** A2b [$label]: THE CHORD LANDED — $B3  ==>  $A3D ***"
  else note "      *** A2b [$label]: NO DELTA — $A3D ***"; fi
  mon_note "A2b"

  # ---------------- A3: the FIELD attempt through the routed CLI
  note ""
  note "  --- A3 [$label]: the ROUTED CLI — project move-heading … --dangerously-drive-gui ---"
  local HB HA T0 T1 RC RAW
  HB=$(horder "$PH")
  bmark "$label A3 cli"
  T0=$(python3 -c 'import time;print(int(time.time()*1000))')
  RAW=$(lab_ssh "$IP" "THINGS_API_TRACE=1 $CLI project move-heading $(printf '%q' "CLK1-HP-$STAMP") $(printf '%q' "CLK1-H3-$STAMP") --first --dangerously-drive-gui --json; echo EXIT=\$?" </dev/null 2>&1)
  T1=$(python3 -c 'import time;print(int(time.time()*1000))')
  RC=$(printf '%s' "$RAW" | grep -o 'EXIT=[0-9]*' | tail -1 | cut -d= -f2)
  HA=$(horder "$PH")
  printf '%s\n' "$RAW" > "$OUT/a3-$label.json"
  note "      exit=$RC wall=$((T1 - T0))ms"
  note "      error code:  $(printf '%s' "$RAW" | jparse code)"
  note "      message:     $(printf '%s' "$RAW" | jparse message)"
  note "      remediation: $(printf '%s' "$RAW" | jparse remediation)"
  note "      heading order: $HB  ==>  $HA"
  [ "$HB" = "$HA" ] && note "      the heading order is UNCHANGED" || note "      the heading order CHANGED"
  # the trace record the field would read the verdict off
  note "      session-state trace: $(lab_ssh "$IP" 'T=$(ls -t ~/.local/state/things-api/trace/* 2>/dev/null | head -1); [ -n "$T" ] && grep -o "\"phase\":\"session-state\"[^}]*" "$T" | tail -1 || echo "(no trace)"' </dev/null 2>/dev/null)"
  note "      chord/select hops in the trace: $(lab_ssh "$IP" 'T=$(ls -t ~/.local/state/things-api/trace/* 2>/dev/null | head -1); [ -n "$T" ] && grep -c "chord-post\|select-heading-row" "$T" || echo "?"' </dev/null 2>/dev/null | tr -d " ")"

  note ""
  note "  --- $label beeps ---"
  bs assert --allow 0 --name "chordlk1-$label" 2>&1 | sed 's/^/      /' | tee -a "$REPORT"
  note "  session at the end of $label: $(lst dict)"
  return 0
}

# ==================================================================== states
if [ "$CMD" = "unlocked" ]; then
  load_session
  state_cells "unlocked" "-" unlocked
  exit 0
fi

if [ "$CMD" = "saver" ]; then
  load_session
  state_cells "saver" "saver-on" locked
  note ""
  note "  --- dismissing the saver with the SHIPPED LOCKSCR2 nudge (so the sitting could host another state) ---"
  note "      shipped wake: $(wake)"
  note "      $(lst ps)"
  note "  session after the shipped wake: $(lst dict)"
  note ""
  note "  --- the same nudge hand-rolled with the modifier flags ZEROED (rig control) ---"
  lst saver-off-shift | sed 's/^/      /' | tee -a "$REPORT"
  note "  session after the flags-zeroed shift: $(lst dict)"
  exit 0
fi

# ==================================================================== A4
# A4 — CAN THE SELECTION BE SET WITHOUT THE AX TREE?
#
# A2 says the shipped AX selector cannot address a row while the session is
# locked (there is no enumerable window to path through). A1 says the chord is
# delivered anyway. So the whole question of a locked-screen chord op reduces to
# ONE thing: is there a selection-setting path that does not walk the window?
# `things:///show?id=<uuid>` is the obvious candidate — it is the URL scheme, not
# the AX tree, and the CHORD2 rig already used it to reveal a container.
#
# Run this while a state is up (it does not enter or leave one).
if [ "$CMD" = "a4" ]; then
  load_session
  note ""
  note "  --- A4: URL-scheme selection (things:///show?id=…) as the addressing path, then the chord ---"
  note "      session: $(lst dict)"
  U=$(gq "SELECT uuid FROM TMTask WHERE title='CLK1-T5-$STAMP' AND trashed=0 LIMIT 1")
  note "      target: CLK1-T5-$STAMP ($U)"
  note "      selection readback BEFORE the show: [$(selreadback)]"
  bs reset >/dev/null; bmark "a4 show"
  show "things:///show?id=$U"
  note "      selection readback AFTER the show:  [$(selreadback)]"
  B4=$(torder "$PT")
  bmark "a4 chord"
  note "      order BEFORE: $B4"
  note "      chord ⌘↑: $(chord up-one)"
  lab_ssh "$IP" 'sleep 3' </dev/null
  A4=$(torder "$PT")
  note "      order AFTER:  $A4"
  if [ "$A4" != "$B4" ]; then note "      *** A4: THE CHORD LANDED on a URL-addressed selection — $B4  ==>  $A4 ***"
  else note "      *** A4: NO DELTA ***"; fi
  note "      frontmost after: $(front)"
  note "      $(lst ps)"
  note "      session after: $(lst dict)"
  bs assert --allow 0 --name chordlk1-a4 2>&1 | sed 's/^/      /' | tee -a "$REPORT"

  # A4h — the same question for a HEADING, which is what the SHIPPED chord op
  # (`project move-heading`) actually moves. Its selector is positional over the
  # AX table, so it is the leg A2 just measured as unavailable; a heading `show`
  # URL would be the replacement, if the app honours one.
  note ""
  note "  --- A4h: the same, for a HEADING row ---"
  UH=$(gq "SELECT uuid FROM TMTask WHERE title='CLK1-H2-$STAMP' AND type=2 AND trashed=0 LIMIT 1")
  note "      target heading: CLK1-H2-$STAMP ($UH)"
  bmark "a4h show"
  show "things:///show?id=$UH"
  note "      to-do selection readback: [$(selreadback)]"
  HB4=$(horder "$PH")
  bmark "a4h chord"
  note "      heading order BEFORE: $HB4"
  note "      chord ⌘↑: $(chord up-one)"
  lab_ssh "$IP" 'sleep 3' </dev/null
  HA4=$(horder "$PH")
  note "      heading order AFTER:  $HA4"
  if [ "$HA4" != "$HB4" ]; then note "      *** A4h: THE CHORD LANDED on a URL-addressed HEADING ***"
  else note "      *** A4h: NO DELTA — a heading show URL does not select the row (or the chord was declined) ***"; fi
  note "      frontmost after: $(front)"
  bs assert --allow 0 --name chordlk1-a4h 2>&1 | sed 's/^/      /' | tee -a "$REPORT"
  exit 0
fi

# Re-ship the guest helper (the driver's own state machine evolves mid-campaign).
if [ "$CMD" = "reship" ]; then
  load_session
  lab_ssh "$IP" 'cat > ~/labh/lockstate.sh && chmod +x ~/labh/lockstate.sh' <<<"$LOCKSTATE"
  note "re-shipped lockstate.sh"
  exit 0
fi

# `wake` on its own — return a saver sitting to unlocked without re-running a cell.
if [ "$CMD" = "wake" ]; then
  load_session
  note "shipped wake: $(wake)"
  note "$(lst ps)"
  note "session: $(lst dict)"
  exit 0
fi

if [ "$CMD" = "locked" ]; then
  load_session
  state_cells "locked" "lock-now" locked
  exit 0
fi

# ==================================================================== teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: stopping and deleting $VM"
  kill_vm
  note "VM table now —"
  tart list 2>/dev/null | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

echo "usage: $0 <setup|unlocked|saver|locked|teardown>" >&2
exit 2
