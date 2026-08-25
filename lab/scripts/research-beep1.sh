#!/bin/bash
# BEEP1 — does the AX numeric-field drive still fire the macOS alert beep on
# Things 3.23?
#
# REPRODUCE-FIRST. The observation (Mike, live host, 2026-08-20) was almost
# certainly made against the PRE-3.23 Repeat dialog; 3.23 redesigned it (the
# `Next:` control became a pop-up, every group index shifted). Whether the beep
# survives the redesign is unknown, so this campaign establishes EXISTENCE
# before any bisecting.
#
# Cells:
#   O1  oracle discovery + POSITIVE validation — a deliberate `beep` must be
#       visible to the oracle before any drive result means anything.
#   O2  the fs_usage / named-alert-sound oracle, validated the same way.
#   R0  fixture: a synthetic to-do promoted to a repeating series by the
#       REPX2/REPX3 AX drive (the AppleScript vector is blocked in clones).
#   R1  interval field         — the shipped `axSetValueScript`, verbatim.
#   R2  ends-after count field — ditto, after the Ends pop-up reveals it.
#   R3  start-days-earlier     — ditto, after Add deadlines reveals it.
#   R4  the whole shipped recipe through the production CLI
#       (`todo reschedule-repeat --interval --ends-after`).
#   Every measured window is paired with a QUIET control of the same length.
#
# METHOD: one disposable clone of things-lab-golden-v4 (Things 3.23, DB v27; the
# golden is never booted). Airgap, clock pinned 2026-07-05 (inside the trial
# wall — this campaign never rolls the clock). Fixtures fully synthetic
# (BEEP1-*). Teardown on EXIT (KEEP=1 keeps it, REUSE=1 attaches).
#
# Usage:  CELLS="O1 O2" VM=beep1-lab KEEP=1 lab/scripts/research-beep1.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-beep1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="${OUT:-lab/artifacts/$VM}"; mkdir -p "$OUT/ax" "$OUT/cap"
REPORT="$OUT/report.txt"
CELLS="${CELLS:-O1 O2 R0 R1 R2 R3 R4}"
KEEP="${KEEP:-0}"
REUSE="${REUSE:-0}"
UNMUTE="${UNMUTE:-0}"   # O1 sets this itself if the muted oracle sees nothing
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[beep1] $*" | tee -a "$REPORT"; }
has_cell() { case " $CELLS " in *" $1 "*) return 0;; *) return 1;; esac; }

IP=""
if [ "$REUSE" = "1" ]; then
  IP="$(tart ip "$VM" 2>/dev/null || true)"
  if [ -n "$IP" ] && lab_ssh "$IP" true 2>/dev/null; then
    note "REUSE=1 — attached to running $VM at $IP"; BOOTSTRAP=0
  else IP=""; fi
fi

if [ -z "$IP" ]; then
  FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
  note "preflight: free ${FREEGB}GB"
  [ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free"; exit 1; }
  if [ "${SKIP_BUILD:-0}" = "1" ]; then note "SKIP_BUILD=1 — reusing dist/"; else
    note "building dist"
    npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
  fi
  [ -f dist/cli/main.js ] || { note "FATAL: no dist/cli/main.js"; exit 1; }
  note "cloning $GOLDEN -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 420) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  [ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
  note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
  BOOTSTRAP=1
fi

cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — leaving $VM running at $IP"; return; fi
  note "teardown: stop+delete $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ------------------------------------------------------------ guest helpers
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# THE ORACLE HARNESS -------------------------------------------------------
# One capture window per measurement, both oracles running in parallel:
#   (a) unified log, a DELIBERATELY BROAD audio predicate — the signature that
#       tracks beeps 1:1 is picked at analysis time, not guessed here;
#   (b) fs_usage, watching for the guest's alert sound file being opened
#       (the alert sound is set to a distinctive name below).
# Everything lives inside ONE ssh invocation so nothing is ever orphaned.
lab_ssh "$IP" 'cat > ~/labh/measure.sh && chmod +x ~/labh/measure.sh' <<'EOF'
#!/bin/bash
# measure.sh <label> <gesture-script-or-EMPTY>  — EMPTY = the quiet control.
LBL="$1"; GES="${2:-}"
PRED='process == "coreaudiod" OR subsystem CONTAINS[c] "audio" OR subsystem CONTAINS[c] "coreaudio" OR eventMessage CONTAINS[c] "beep" OR eventMessage CONTAINS[c] "alert sound" OR eventMessage CONTAINS[c] "systemsound"'
LOGF=/tmp/beep-$LBL.ndjson; FSF=/tmp/fs-$LBL.txt
rm -f "$LOGF" "$FSF" /tmp/gesture-$LBL.out
log stream --style ndjson --predicate "$PRED" > "$LOGF" 2>/dev/null &
LP=$!
# fs_usage is filtered IN THE GUEST — unfiltered it is megabytes a second.
sudo fs_usage -w -f filesys 2>/dev/null | grep -i --line-buffered -e Submarine -e '\.aiff' > "$FSF" &
sleep 3
date +%s > /tmp/t0-$LBL
if [ -n "$GES" ]; then bash "$GES" > /tmp/gesture-$LBL.out 2>&1; echo "GESTURE-EXIT=$?"; else sleep 6; echo "GESTURE-EXIT=quiet"; fi
date +%s > /tmp/t1-$LBL
sleep 3
kill $LP 2>/dev/null; sudo pkill -f 'fs_usage -w -f filesys' 2>/dev/null
wait 2>/dev/null
echo "WINDOW=$(cat /tmp/t0-$LBL)..$(cat /tmp/t1-$LBL)"
EOF

lab_ssh "$IP" 'cat > ~/labh/count.py' <<'PYEOF'
import sys, json, os, re
lbl = sys.argv[1]
t0 = int(open('/tmp/t0-%s' % lbl).read().strip())
t1 = int(open('/tmp/t1-%s' % lbl).read().strip())
sig = {}
n = 0
try:
    for line in open('/tmp/beep-%s.ndjson' % lbl, errors='replace'):
        line = line.strip().rstrip(',')
        if not line.startswith('{'):
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        ts = d.get('timestamp', '')
        m = re.match(r'(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)', ts)
        if not m:
            continue
        import time, calendar
        st = time.mktime((int(m.group(1)), int(m.group(2)), int(m.group(3)),
                          int(m.group(4)), int(m.group(5)), int(m.group(6)), 0, 0, -1))
        if not (t0 - 1 <= st <= t1 + 2):
            continue
        n += 1
        proc = os.path.basename(d.get('processImagePath', '') or '?')
        sub = d.get('subsystem', '') or '-'
        cat = d.get('category', '') or '-'
        msg = (d.get('eventMessage', '') or '')[:70]
        sig.setdefault((proc, sub, cat, msg), 0)
        sig[(proc, sub, cat, msg)] += 1
except FileNotFoundError:
    print('NO-LOG-FILE')
print('LOGLINES-IN-WINDOW=%d' % n)
# THE ORACLE (validated in O1, muted AND unmuted): systemsoundserverd logs one
# `SSServerImp.cpp:733  -> Incoming Request : actionID 4096` per system-sound
# play request. Three deliberate beeps -> exactly 3; a quiet window -> 0.
beeps = sum(v for k, v in sig.items()
            if k[0] == 'systemsoundserverd' and 'SSServerImp.cpp:733' in k[3])
print('BEEPS-LOG=%d' % beeps)
if os.environ.get('BEEP1_VERBOSE'):
    for k in sorted(sig, key=lambda k: -sig[k]):
        print('  %3d | %s | %s | %s | %s' % (sig[k], k[0], k[1], k[2], k[3]))
# fs_usage side: the alert sound file, by name
snd = sys.argv[2] if len(sys.argv) > 2 else 'Submarine'
opens = []
try:
    for line in open('/tmp/fs-%s.txt' % lbl, errors='replace'):
        if snd in line and ' open ' in line:
            opens.append(line.rstrip()[:120])
except FileNotFoundError:
    print('NO-FSUSAGE-FILE')
print('BEEPS-FS=%d' % len(opens))
for h in opens[:12]:
    print('  ' + h)
PYEOF

measure() { # measure <label> <gesture-script-path|""> ; echoes the analysis
  local lbl="$1" ges="${2:-}"
  lab_ssh "$IP" "~/labh/measure.sh $(printf '%q' "$lbl") $(printf '%q' "$ges")" </dev/null 2>&1
  lab_ssh "$IP" "BEEP1_VERBOSE=${BEEP1_VERBOSE:-} python3 ~/labh/count.py $(printf '%q' "$lbl") Submarine" </dev/null 2>&1
  lab_ssh "$IP" "cat /tmp/gesture-$lbl.out 2>/dev/null | tail -20" </dev/null 2>&1 | sed 's/^/      gesture| /'
  lab_scp "admin@$IP:/tmp/beep-$lbl.ndjson" "$OUT/cap/beep-$lbl.ndjson" >/dev/null 2>&1 || true
}

putges() { # putges <name> <<'EOF' ... EOF  — write a gesture script into the guest
  lab_ssh "$IP" "cat > /tmp/ges-$1.sh"
}

axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }
esc() { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null; }

lab_ssh "$IP" 'cat > ~/labh/sheet.jxa' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices')
function pidOf(n){return Application('System Events').processes.byName(n).unixId()}
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function sv(el,n){var v=attr(el,n);try{return v?String(v.js):''}catch(e){return ''}}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
function line(el,d,ix){
  var p=['['+ix+'] role='+sv(el,'AXRole')]
  var s=sv(el,'AXSubrole'); if(s)p.push('sub='+s)
  var t=sv(el,'AXTitle'); if(t)p.push('ttl='+t)
  var de=sv(el,'AXDescription'); if(de)p.push('desc='+de)
  var v=sv(el,'AXValue'); if(v)p.push('val='+String(v).slice(0,90))
  var id=sv(el,'AXIdentifier'); if(id)p.push('id='+id)
  var f=sv(el,'AXFocused'); if(f)p.push('focused='+f)
  return Array(d+1).join('  ')+p.join(' | ')}
function walk(el,d,acc,ix){acc.push(line(el,d,ix)); if(d>14)return acc; var ch=kids(el); for(var i=0;i<ch.length;i++)walk(ch[i],d+1,acc,i+1); return acc}
function run(){
  var app=$.AXUIElementCreateApplication(pidOf('Things3')); var ws=kids(app); var acc=[]
  for(var i=0;i<ws.length;i++){
    var w=ws[i]
    var ch=kids(w)
    for(var j=0;j<ch.length;j++){var r=sv(ch[j],'AXRole'); if(r==='AXSheet'||r==='AXPopover'){acc.push('=== '+r+' ==='); walk(ch[j],0,acc,j+1)}}
  }
  if(!acc.length) acc.push('(no sheet / popover present)')
  return acc.join('\n')}
EOF
sheetdump() { lab_ssh "$IP" 'osascript -l JavaScript ~/labh/sheet.jxa' </dev/null > "$OUT/ax/$1.txt" 2>&1; }

TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
note "env: Things $TVER ($TBLD) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / golden $GOLDEN"

if [ "${SKIP_SHIP:-0}" != "1" ]; then
  # ---- ship the production bundle ----------------------------------------
  if [ ! -f dist/cli/main.js ]; then
    note "building dist"
    npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
  fi
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
fi
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
G() { lab_ssh "$IP" "$LAB_UI_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
note "shipped dist; ui-enabled=true"

# A DISTINCTIVE alert sound, so oracle (b) has something to grep for. Set
# before Things is (re)launched — the pref is read per process.
lab_ssh "$IP" 'defaults write -g com.apple.sound.beep.sound /System/Library/Sounds/Submarine.aiff; defaults read -g com.apple.sound.beep.sound' </dev/null | sed 's/^/  alert sound = /' | tee -a "$REPORT"

PASS=0; FAIL=0
cell() { note ""; note "=== $1 ==="; }

mktodo() {  # mktodo <title>
  lab_ssh "$IP" "open -g 'things:///add?title=$1&auth-token=$TOKEN'; sleep 4" </dev/null
  gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NULL LIMIT 1"
}

# ============================================================ O1 / O2 oracle
if has_cell O1; then
  cell "O1 oracle validation — can either oracle SEE a deliberate beep?"
  warm
  note "  guest audio muted = $(lab_ssh "$IP" "osascript -e 'output muted of (get volume settings)'" </dev/null)"

  putges beep3 <<'EOF'
for i in 1 2 3; do osascript -e 'beep' ; sleep 1.5; done
EOF
  note "  -- QUIET control (no gesture) --"
  measure quiet-muted "" | sed 's/^/    /' | tee -a "$REPORT"
  note "  -- 3 deliberate beeps, guest MUTED --"
  measure beep3-muted /tmp/ges-beep3.sh | sed 's/^/    /' | tee -a "$REPORT"

  note "  -- 3 deliberate beeps, guest UNMUTED (host speakers; 3 short beeps) --"
  lab_ssh "$IP" "osascript -e 'set volume output muted false' -e 'set volume output volume 12'" </dev/null >/dev/null 2>&1
  measure beep3-unmuted /tmp/ges-beep3.sh | sed 's/^/    /' | tee -a "$REPORT"
  note "  -- QUIET control, UNMUTED --"
  measure quiet-unmuted "" | sed 's/^/    /' | tee -a "$REPORT"
  if [ "$UNMUTE" != "1" ]; then
    lab_ssh "$IP" "osascript -e 'set volume output muted true'" </dev/null >/dev/null 2>&1
    note "  re-muted the guest"
  else
    note "  UNMUTE=1 — leaving the guest unmuted for the drive cells"
  fi
fi

if has_cell O2; then
  cell "O2 audio-device census (does a headless Tart guest have an output device at all?)"
  lab_ssh "$IP" "system_profiler SPAudioDataType 2>/dev/null | head -40" </dev/null 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" "osascript -e 'get volume settings'" </dev/null 2>&1 | sed 's/^/    volume: /' | tee -a "$REPORT"
fi

# ============================================================ R0 fixture
TMPL=""
if has_cell R0 || has_cell R1 || has_cell R2 || has_cell R3 || has_cell R4; then
  cell "R0 fixture — a synthetic to-do promoted to a WEEKLY series by the AX drive"
  warm
  U=$(mktodo BEEP1-SERIES); note "  seed uuid=$U"
  lab_ssh "$IP" "open -g 'things:///show?id=$U'; sleep 3" </dev/null
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  lab_ssh "$IP" 'sleep 3' </dev/null
  sheetdump "r0-repeat-dialog"
  axq 'tell application "System Events" to tell process "Things3"
    set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
    set p to pop up button 1 of sh
    repeat 20 times
      if (exists menu 1 of p) then exit repeat
      click p
      delay 0.3
    end repeat
    set nms to name of every menu item of menu 1 of p
    set hit to ""
    repeat with n in nms
      if hit is "" and ((n as text) contains "eek") then set hit to (n as text)
    end repeat
    if hit is "" then
      key code 53
      return "FREQ-NOT-FOUND; offered: " & (nms as text)
    end if
    click menu item hit of menu 1 of p
    delay 1.5
    click button "OK" of sh
    delay 2
    return "frequency = " & hit
  end tell' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 3' </dev/null
  TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='BEEP1-SERIES' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
  if [ -z "$TMPL" ]; then note "  FATAL: no template minted — cannot run R1-R4"; else note "  template uuid=$TMPL"; fi
fi

# The shipped primitives, verbatim, straight out of dist/ — never a paraphrase.
# Post-#589 (HXPC1) the two CADENCE-GROUP numeric fields no longer go through
# set-value: interval and ends-count are row-discriminated by
# `axSetGroupNumberScript`. start-days-earlier (a direct sheet child) and the
# Move… picker's filter field still use `axSetValueScript`.
shipped_groupnumber() { # shipped_groupnumber <group-path> <interval|ends-count> <value>
  node -e '
    const g = process.argv[1], t = process.argv[2], v = process.argv[3];
    import("./dist/write/vectors/ui.js").then((m) => {
      process.stdout.write(m.axSetGroupNumberScript(g, t, v));
    });
  ' "$1" "$2" "$3"
}
shipped_setvalue() { # shipped_setvalue <ax-path> <value>
  node -e '
    const p = process.argv[1], v = process.argv[2];
    import("./dist/write/vectors/ui.js").then((m) => {
      process.stdout.write(m.axSetValueScript(p, v));
    });
  ' "$1" "$2"
}
MAINW='(first window whose subrole is "AXStandardWindow")'

# open_dialog: a FRESH to-do, selected, with the Repeat dialog open on a
# standard (weekly) cadence — the shape whose group carries the interval field.
# The repeating TEMPLATE row is deliberately not used as the target: it has no
# selectable row of its own (`things:///show?id=<template>` selects nothing, and
# Items ▸ Edit Rule… then stays disabled), which is what collapsed the first
# attempt at these cells.
open_dialog() { # open_dialog <fixture-title>
  local u
  u=$(mktodo "$1"); note "  fixture uuid=$u"
  lab_ssh "$IP" "open -g 'things:///show?id=$u'; sleep 3" </dev/null
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' | sed 's/^/    menu| /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 3' </dev/null
  axq 'tell application "System Events" to tell process "Things3"
    set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
    set p to pop up button 1 of sh
    repeat 20 times
      if (exists menu 1 of p) then exit repeat
      click p
      delay 0.3
    end repeat
    set nms to name of every menu item of menu 1 of p
    set hit to ""
    repeat with n in nms
      if hit is "" and ((n as text) is "weekly") then set hit to (n as text)
    end repeat
    if hit is "" then
      key code 53
      return "FREQ-NOT-FOUND; offered: " & (nms as text)
    end if
    click menu item hit of menu 1 of p
    delay 1.5
    return "frequency = " & hit
  end tell' | sed 's/^/    /' | tee -a "$REPORT"
}

drive_group() { # drive_group <label> <interval|ends-count> <value>
  local lbl="$1"
  shipped_groupnumber "group 1 of sheet 1 of $MAINW" "$2" "$3" > "$OUT/script-$lbl.applescript"
  drive_prepared "$lbl"
}

drive_field() { # drive_field <label> <ax-path> <value>
  local lbl="$1" path="$2" val="$3"
  shipped_setvalue "$path" "$val" > "$OUT/script-$lbl.applescript"
  drive_prepared "$lbl"
}

drive_prepared() { # drive_prepared <label>  — measure the script already written
  local lbl="$1"
  lab_scp "$OUT/script-$lbl.applescript" "admin@$IP:/tmp/sv-$lbl.applescript" >/dev/null
  lab_ssh "$IP" "cat > /tmp/ges-$lbl.sh" <<EOF
osascript /tmp/sv-$lbl.applescript
EOF
  note "  -- QUIET control --"
  measure "q-$lbl" "" | sed 's/^/    /' | tee -a "$REPORT"
  note "  -- DRIVE: $lbl --"
  measure "$lbl" "/tmp/ges-$lbl.sh" | sed 's/^/    /' | tee -a "$REPORT"
}

if has_cell R1 && [ -n "$TMPL" ]; then
  cell "R1 INTERVAL field — the shipped axSetValueScript, verbatim"
  warm
  open_dialog BEEP1-IV
  sheetdump "r1-before"
  drive_group "interval" interval "3"
  sheetdump "r1-after"
  esc
fi

if has_cell R2 && [ -n "$TMPL" ]; then
  cell "R2 ENDS-AFTER count field — revealed by the Ends pop-up, then driven"
  warm
  open_dialog BEEP1-ENDS
  axq 'tell application "System Events" to tell process "Things3"
    set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
    set p to pop up button 1 of group 1 of sh
    repeat 20 times
      if (exists menu 1 of p) then exit repeat
      click p
      delay 0.3
    end repeat
    set nms to name of every menu item of menu 1 of p
    set hit to ""
    repeat with n in nms
      if hit is "" and ((n as text) contains "after") then set hit to (n as text)
    end repeat
    if hit is "" then
      return "ENDS-AFTER-NOT-FOUND; offered: " & (nms as text)
    end if
    click menu item hit of menu 1 of p
    delay 1.5
    return "ends = " & hit
  end tell' | sed 's/^/    /' | tee -a "$REPORT"
  sheetdump "r2-before"
  drive_group "endscount" ends-count "7"
  sheetdump "r2-after"
  esc
fi

if has_cell R3 && [ -n "$TMPL" ]; then
  cell "R3 START-DAYS-EARLIER field — revealed by the Add deadlines checkbox"
  warm
  open_dialog BEEP1-DL
  axq 'tell application "System Events" to tell process "Things3"
    set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
    set cb to checkbox "Add deadlines" of sh
    if ((value of cb) as integer) is 0 then click cb
    delay 1.5
    return "add-deadlines = " & ((value of cb) as text)
  end tell' | sed 's/^/    /' | tee -a "$REPORT"
  sheetdump "r3-before"
  drive_field "startearlier" "text field 1 of sheet 1 of $MAINW" "4"
  sheetdump "r3-after"
  esc
fi

if has_cell R4 && [ -n "$TMPL" ]; then
  cell "R4 the WHOLE shipped recipe through the production CLI"
  warm
  lab_ssh "$IP" "cat > /tmp/ges-cli.sh" <<EOF
$LAB_UI_DIRECT $CLI todo reschedule-repeat $TMPL --frequency daily --interval 5 --ends-after 9 --dangerously-drive-gui --json
EOF
  note "  -- QUIET control --"
  measure q-cli "" | sed 's/^/    /' | tee -a "$REPORT"
  note "  -- DRIVE: reschedule-repeat --interval 5 --ends-after 9 --"
  measure cli /tmp/ges-cli.sh | sed 's/^/    /' | tee -a "$REPORT"
  note "  rule now: $(gq "SELECT hex(rt1_recurrenceRule) IS NOT NULL FROM TMTask WHERE uuid='$TMPL'")"
fi


# ============================================================ B bisect
# One keystroke removed at a time, each variant against a FRESH weekly Repeat
# dialog (so no variant inherits another's state), each paired with a quiet
# control. The interval field is the target throughout.
TF="text field 1 of group 1 of sheet 1 of $MAINW"
SEP='tell application "System Events" to tell process "Things3"'

bisect() { # bisect <label> <applescript body, already inside the SE tell block>
  local lbl="$1" body="$2"
  printf '%s\n%s\nend tell\n' "$SEP" "$body" > "$OUT/bisect-$lbl.applescript"
  lab_scp "$OUT/bisect-$lbl.applescript" "admin@$IP:/tmp/bis-$lbl.applescript" >/dev/null
  lab_ssh "$IP" "cat > /tmp/ges-b-$lbl.sh" <<EOF
osascript /tmp/bis-$lbl.applescript
EOF
  warm
  open_dialog "BEEP1-B-$lbl"
  note "  -- QUIET control ($lbl) --"
  measure "qb-$lbl" "" | grep -E 'BEEPS-|GESTURE-EXIT' | sed 's/^/    /' | tee -a "$REPORT"
  note "  -- VARIANT $lbl --"
  measure "b-$lbl" "/tmp/ges-b-$lbl.sh" | grep -E 'BEEPS-|GESTURE-EXIT|Submarine' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" "cat /tmp/gesture-b-$lbl.out 2>/dev/null | tail -4" </dev/null 2>&1 | sed 's/^/      out| /' | tee -a "$REPORT"
  esc
}

if has_cell B1; then
  cell "B1 focus ONLY - no keystrokes at all"
  bisect focusonly "  set tf to ($TF)
  set focused of tf to true
  delay 0.5
  return \"focused=\" & ((focused of tf) as text) & \" value=\" & ((value of tf) as text)"
fi

if has_cell B2; then
  cell "B2 focus + Command-A (Select All) ONLY"
  bisect cmda "  set tf to ($TF)
  set focused of tf to true
  delay 0.15
  keystroke \"a\" using command down
  delay 0.5
  return \"focused=\" & ((focused of tf) as text) & \" value=\" & ((value of tf) as text)"
fi

if has_cell B3; then
  cell "B3 focus + Command-A + type (NO Tab)"
  bisect notab "  set tf to ($TF)
  set focused of tf to true
  delay 0.15
  keystroke \"a\" using command down
  delay 0.1
  keystroke \"3\"
  delay 0.5
  return \"value=\" & ((value of tf) as text)"
fi

if has_cell B4; then
  cell "B4 focus + Tab ONLY (no select-all, no typing)"
  bisect tabonly "  set tf to ($TF)
  set focused of tf to true
  delay 0.15
  key code 48
  delay 0.5
  return \"value=\" & ((value of tf) as text)"
fi

if has_cell B5; then
  cell "B5 focus + type ONLY (no select-all, no Tab)"
  bisect typeonly "  set tf to ($TF)
  set focused of tf to true
  delay 0.15
  keystroke \"3\"
  delay 0.5
  return \"value=\" & ((value of tf) as text)"
fi

if has_cell B6; then
  cell "B6 candidate fix - set value to empty instead of Command-A, then type + Tab"
  bisect clearfirst "  set tf to ($TF)
  set focused of tf to true
  delay 0.15
  set value of tf to \"\"
  delay 0.1
  keystroke \"3\"
  delay 0.1
  key code 48
  delay 0.5
  return \"value=\" & ((value of tf) as text)"
fi

if has_cell B7; then
  cell "B7 first-responder check before Command-A (is focus racing the keystroke?)"
  bisect frcheck "  set tf to ($TF)
  set fr to \"never\"
  repeat 20 times
    set focused of tf to true
    if (focused of tf) then
      set fr to \"yes\"
      exit repeat
    end if
    delay 0.1
  end repeat
  delay 0.15
  keystroke \"a\" using command down
  delay 0.1
  keystroke \"3\"
  delay 0.1
  key code 48
  delay 0.5
  return \"fr=\" & fr & \" value=\" & ((value of tf) as text)"
fi

if has_cell B8; then
  cell "B8 Command-A with a LONG settle after focus (1.5s)"
  bisect slowcmda "  set tf to ($TF)
  set focused of tf to true
  delay 1.5
  keystroke \"a\" using command down
  delay 0.5
  return \"value=\" & ((value of tf) as text)"
fi


if has_cell B9; then
  cell "B9 NO select-all, MULTI-DIGIT type into a single-digit field, + Tab"
  bisect multitype "  set tf to ($TF)
  set focused of tf to true
  delay 0.15
  keystroke \"12\"
  delay 0.1
  key code 48
  delay 0.5
  return \"value=\" & ((value of tf) as text)"
fi

if has_cell B10; then
  cell "B10 NO select-all, SHRINKING a two-digit value to one digit (the case a stale selection would corrupt)"
  bisect shrink "  set tf to ($TF)
  set focused of tf to true
  delay 0.15
  keystroke \"12\"
  delay 0.1
  key code 48
  delay 0.6
  set intermediate to ((value of tf) as text)
  set focused of tf to true
  delay 0.15
  keystroke \"3\"
  delay 0.1
  key code 48
  delay 0.5
  return \"first=\" & intermediate & \" then=\" & ((value of tf) as text)"
fi

if has_cell B11; then
  cell "B11 census - is Command-A claimed by a MENU while the sheet is up?"
  warm
  open_dialog BEEP1-B-menu
  axq 'tell application "System Events" to tell process "Things3"
    set out to ""
    repeat with m in menu bar items of menu bar 1
      try
        repeat with mi in menu items of menu 1 of m
          try
            if ((name of mi) contains "Select All") then
              set out to out & (name of m) & " > " & (name of mi) & " enabled=" & ((enabled of mi) as text) & " ; "
            end if
          end try
        end repeat
      end try
    end repeat
    if out is "" then set out to "(no Select All menu item anywhere in the menu bar)"
    return out
  end tell' | sed 's/^/    /' | tee -a "$REPORT"
  esc
fi

if has_cell B12; then
  cell "B12 candidate fix - AXSelectedTextRange select-all instead of Command-A, then type + Tab"
  bisect axrange "  set tf to ($TF)
  set focused of tf to true
  delay 0.15
  set cur to ((value of tf) as text)
  try
    set value of attribute \"AXSelectedTextRange\" of tf to {0, (length of cur)}
  on error e
    return \"AXSelectedTextRange REFUSED: \" & e
  end try
  delay 0.1
  keystroke \"3\"
  delay 0.1
  key code 48
  delay 0.5
  return \"value=\" & ((value of tf) as text)"
fi


if has_cell B13; then
  cell "B13 selection census - WHAT is selected right after 'set focused of tf to true'?"
  bisect selcensus "  set tf to ($TF)
  script H
    on fmt(r)
      try
        return \"loc\" & (item 1 of r as text) & \"/len\" & (item 2 of r as text)
      on error
        return \"?\"
      end try
    end fmt
  end script
  set sel0 to \"unreadable\"
  try
    set sel0 to H's fmt(value of attribute \"AXSelectedTextRange\" of tf)
  end try
  set focused of tf to true
  delay 0.3
  set sel1 to \"unreadable\"
  try
    set sel1 to H's fmt(value of attribute \"AXSelectedTextRange\" of tf)
  end try
  set cur to ((value of tf) as text)
  set wrote to \"n/a\"
  try
    set value of attribute \"AXSelectedTextRange\" of tf to {0, (count cur)}
    delay 0.2
    set wrote to H's fmt(value of attribute \"AXSelectedTextRange\" of tf)
  on error e
    set wrote to \"REFUSED: \" & e
  end try
  return \"len=\" & (count cur) & \" preFocus=\" & sel0 & \" postFocus=\" & sel1 & \" postExplicitWrite=\" & wrote"
fi

if has_cell B14; then
  cell "B14 drop-Command-A on the ENDS-AFTER count field"
  warm
  open_dialog BEEP1-B-ends2
  axq 'tell application "System Events" to tell process "Things3"
    set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
    set p to pop up button 1 of group 1 of sh
    repeat 20 times
      if (exists menu 1 of p) then exit repeat
      click p
      delay 0.3
    end repeat
    click (first menu item of menu 1 of p whose name contains "after")
    delay 1.5
    return "ends = after"
  end tell' | sed 's/^/    /' | tee -a "$REPORT"
  printf '%s\n  set tf to (%s)\n  set focused of tf to true\n  delay 0.15\n  keystroke "7"\n  delay 0.1\n  key code 48\n  delay 0.5\n  return "value=" & ((value of tf) as text)\nend tell\n' "$SEP" "$TF" > "$OUT/bisect-ends2.applescript"
  lab_scp "$OUT/bisect-ends2.applescript" "admin@$IP:/tmp/bis-ends2.applescript" >/dev/null
  lab_ssh "$IP" "printf 'osascript /tmp/bis-ends2.applescript\\n' > /tmp/ges-b-ends2.sh" </dev/null
  note "  -- QUIET control (ends2) --"
  measure "qb-ends2" "" | grep -E 'BEEPS-|GESTURE-EXIT' | sed 's/^/    /' | tee -a "$REPORT"
  note "  -- VARIANT ends2 --"
  measure "b-ends2" "/tmp/ges-b-ends2.sh" | grep -E 'BEEPS-|GESTURE-EXIT' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" "cat /tmp/gesture-b-ends2.out 2>/dev/null | tail -3" </dev/null 2>&1 | sed 's/^/      out| /' | tee -a "$REPORT"
  esc
fi

if has_cell B15; then
  cell "B15 drop-Command-A on the START-DAYS-EARLIER field"
  warm
  open_dialog BEEP1-B-dl2
  axq 'tell application "System Events" to tell process "Things3"
    set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
    set cb to checkbox "Add deadlines" of sh
    if ((value of cb) as integer) is 0 then click cb
    delay 1.5
    return "add-deadlines = " & ((value of cb) as text)
  end tell' | sed 's/^/    /' | tee -a "$REPORT"
  printf '%s\n  set tf to (text field 1 of sheet 1 of %s)\n  set focused of tf to true\n  delay 0.15\n  keystroke "4"\n  delay 0.1\n  key code 48\n  delay 0.5\n  return "value=" & ((value of tf) as text)\nend tell\n' "$SEP" "$MAINW" > "$OUT/bisect-dl2.applescript"
  lab_scp "$OUT/bisect-dl2.applescript" "admin@$IP:/tmp/bis-dl2.applescript" >/dev/null
  lab_ssh "$IP" "printf 'osascript /tmp/bis-dl2.applescript\\n' > /tmp/ges-b-dl2.sh" </dev/null
  note "  -- QUIET control (dl2) --"
  measure "qb-dl2" "" | grep -E 'BEEPS-|GESTURE-EXIT' | sed 's/^/    /' | tee -a "$REPORT"
  note "  -- VARIANT dl2 --"
  measure "b-dl2" "/tmp/ges-b-dl2.sh" | grep -E 'BEEPS-|GESTURE-EXIT' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" "cat /tmp/gesture-b-dl2.out 2>/dev/null | tail -3" </dev/null 2>&1 | sed 's/^/      out| /' | tee -a "$REPORT"
  esc
fi


if has_cell B16; then
  cell "B16 selection census on a MULTI-CHARACTER value (does focus select ALL of it?)"
  bisect selcensus2 "  set tf to ($TF)
  script H
    on fmt(r)
      try
        return \"loc\" & (item 1 of r as text) & \"/len\" & (item 2 of r as text)
      on error
        return \"?\"
      end try
    end fmt
  end script
  set focused of tf to true
  delay 0.15
  keystroke \"12\"
  delay 0.1
  key code 48
  delay 0.6
  set v1 to ((value of tf) as text)
  set focused of tf to true
  delay 0.3
  set sel1 to \"unreadable\"
  try
    set sel1 to H's fmt(value of attribute \"AXSelectedTextRange\" of tf)
  end try
  return \"value=\" & v1 & \" len=\" & (count v1) & \" postFocusSelection=\" & sel1"
fi


# ============================================================ E clearDialog Escape
# Suspect (6): clearDialog's failure-path Escape is app-wide (`axAbortScript`
# sends `key code 53` with no process target). Does it beep when nothing modal
# is open? Measured in three states.
escmeasure() { # escmeasure <label>
  lab_ssh "$IP" "printf 'osascript -e %s\\n' \"'tell application \\\"System Events\\\" to key code 53'\" > /tmp/ges-esc-$1.sh" </dev/null
  note "  -- QUIET control ($1) --"
  measure "qe-$1" "" | grep -E 'BEEPS-|GESTURE-EXIT' | sed 's/^/    /' | tee -a "$REPORT"
  note "  -- ESCAPE ($1) --"
  measure "e-$1" "/tmp/ges-esc-$1.sh" | grep -E 'BEEPS-|GESTURE-EXIT' | sed 's/^/    /' | tee -a "$REPORT"
}

if has_cell E1; then
  cell "E1 Escape WITH the Repeat sheet open (the intended case)"
  warm
  open_dialog BEEP1-E-open
  escmeasure sheetopen
  lab_ssh "$IP" "osascript -l JavaScript ~/labh/sheet.jxa | head -2" </dev/null 2>&1 | sed 's/^/    after| /' | tee -a "$REPORT"
fi

if has_cell E2; then
  cell "E2 Escape with NOTHING modal open, Things frontmost"
  warm
  escmeasure nomodal
fi

if has_cell E3; then
  cell "E3 Escape with NOTHING modal open, FINDER frontmost (Things backgrounded)"
  lab_ssh "$IP" 'osascript -e '\''tell application "Finder" to activate'\''; sleep 3' </dev/null
  escmeasure finder
fi


# ============================================================ R5 recipe bisect
# R4 left ONE beep in the full CLI drive after set-field-value went silent, so a
# SECOND source lives elsewhere in the recipe. Narrow it by shrinking the verb.
climeasure() { # climeasure <label> <cli args...>
  local lbl="$1"; shift
  lab_ssh "$IP" "cat > /tmp/ges-cli-$lbl.sh" <<EOF
$LAB_UI_DIRECT $CLI $*
EOF
  warm
  note "  -- QUIET control ($lbl) --"
  measure "qc-$lbl" "" | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  note "  -- CLI $lbl: $* --"
  measure "c-$lbl" "/tmp/ges-cli-$lbl.sh" | grep -E 'BEEPS-|Submarine' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" "grep -o '\"ok\":[a-z]*' /tmp/gesture-c-$lbl.out 2>/dev/null | head -1; grep -o 'drove [0-9]* step' /tmp/gesture-c-$lbl.out 2>/dev/null | head -1; grep -o '\"code\":\"[a-z:-]*\"' /tmp/gesture-c-$lbl.out 2>/dev/null | head -2" </dev/null 2>&1 | sed 's/^/      cli| /' | tee -a "$REPORT"
}

if has_cell R5 && [ -n "$TMPL" ]; then
  cell "R5a reschedule-repeat with NO ends bound (fewest dialog steps)"
  climeasure resmin todo reschedule-repeat "$TMPL" --frequency daily --interval 2 --dangerously-drive-gui --json

  cell "R5b pause-repeat — the preamble ONLY (reveal + activate + menu, no dialog)"
  climeasure pause todo pause-repeat "$TMPL" --dangerously-drive-gui --json

  cell "R5c resume-repeat — the same preamble, the other menu item"
  climeasure resume todo resume-repeat "$TMPL" --dangerously-drive-gui --json

  cell "R5d reschedule-repeat with the ends bound back (the R4 shape, repeated)"
  climeasure resfull todo reschedule-repeat "$TMPL" --frequency daily --interval 5 --ends-after 9 --dangerously-drive-gui --json
fi


if has_cell R6 && [ -n "$TMPL" ]; then
  cell "R6 the FREQUENCY-SWITCH shape (R4's real difference from R5d) x3"
  # R4 drove weekly -> daily; R5d drove daily -> daily and was silent. A
  # frequency switch re-lays out the cadence group under the drive (the UIC7
  # race), so run the switching pair repeatedly and see whether the stray beep
  # tracks the switch.
  for round in 1 2 3; do
    note "  --- round $round: daily -> weekly ---"
    climeasure "sw$round-w" todo reschedule-repeat "$TMPL" --frequency weekly --interval 2 --weekdays tuesday --dangerously-drive-gui --json
    note "  --- round $round: weekly -> daily + ends-after ---"
    climeasure "sw$round-d" todo reschedule-repeat "$TMPL" --frequency daily --interval 5 --ends-after 9 --dangerously-drive-gui --json
  done
fi


# ============================================================ F frequency pop-up
# The residual beep tracks a FREQUENCY SWITCH. open_dialog performs that switch
# OUTSIDE the R1-R3 measurement windows, which is why those cells read clean.
# Measure the switch itself.
openbare() { # openbare <title> — the Repeat dialog, NO frequency selection
  local u
  u=$(mktodo "$1"); note "  fixture uuid=$u"
  lab_ssh "$IP" "open -g 'things:///show?id=$u'; sleep 3" </dev/null
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  lab_ssh "$IP" 'sleep 3' </dev/null
}

if has_cell F1; then
  cell "F1 the shipped select-popup, driving the FREQUENCY pop-up (after completion -> weekly)"
  warm
  openbare BEEP1-F-freq
  node -e '
    import("./dist/write/vectors/ui.js").then((m) => {
      process.stdout.write(m.axSelectPopupScript(process.argv[1], process.argv[2]));
    });
  ' "pop up button 1 of sheet 1 of $MAINW" "weekly" > "$OUT/f1.applescript"
  lab_scp "$OUT/f1.applescript" "admin@$IP:/tmp/f1.applescript" >/dev/null
  lab_ssh "$IP" "printf 'osascript /tmp/f1.applescript\\n' > /tmp/ges-f1.sh" </dev/null
  note "  -- QUIET control --"
  measure qf1 "" | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  note "  -- select-popup frequency = weekly --"
  measure f1 /tmp/ges-f1.sh | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" "cat /tmp/gesture-f1.out 2>/dev/null | tail -3" </dev/null 2>&1 | sed 's/^/      out| /' | tee -a "$REPORT"
  sheetdump "f1-after"
  esc
fi

if has_cell F2; then
  cell "F2 the same pop-up drive on a pop-up whose value ALREADY matches (no switch)"
  warm
  openbare BEEP1-F-noop
  node -e '
    import("./dist/write/vectors/ui.js").then((m) => {
      process.stdout.write(m.axSelectPopupScript(process.argv[1], process.argv[2]));
    });
  ' "pop up button 1 of sheet 1 of $MAINW" "after completion" > "$OUT/f2.applescript"
  lab_scp "$OUT/f2.applescript" "admin@$IP:/tmp/f2.applescript" >/dev/null
  lab_ssh "$IP" "printf 'osascript /tmp/f2.applescript\\n' > /tmp/ges-f2.sh" </dev/null
  note "  -- QUIET control --"
  measure qf2 "" | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  note "  -- select-popup frequency = after completion (already selected) --"
  measure f2 /tmp/ges-f2.sh | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" "cat /tmp/gesture-f2.out 2>/dev/null | tail -3" </dev/null 2>&1 | sed 's/^/      out| /' | tee -a "$REPORT"
  esc
fi

if has_cell F3; then
  cell "F3 interval drive IMMEDIATELY after a frequency switch (both inside one window)"
  warm
  openbare BEEP1-F-both
  node -e '
    import("./dist/write/vectors/ui.js").then(async (m) => {
      const pop = m.axSelectPopupScript(process.argv[1], "weekly");
      process.stdout.write(pop);
    });
  ' "pop up button 1 of sheet 1 of $MAINW" > "$OUT/f3a.applescript"
  node -e '
    import("./dist/write/vectors/ui.js").then((m) => {
      process.stdout.write(m.axSetValueScript(process.argv[1], "3"));
    });
  ' "text field 1 of group 1 of sheet 1 of $MAINW" > "$OUT/f3b.applescript"
  lab_scp "$OUT/f3a.applescript" "admin@$IP:/tmp/f3a.applescript" >/dev/null
  lab_scp "$OUT/f3b.applescript" "admin@$IP:/tmp/f3b.applescript" >/dev/null
  lab_ssh "$IP" "printf 'osascript /tmp/f3a.applescript\\nsleep 1\\nosascript /tmp/f3b.applescript\\n' > /tmp/ges-f3.sh" </dev/null
  note "  -- QUIET control --"
  measure qf3 "" | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  note "  -- frequency switch THEN interval --"
  measure f3 /tmp/ges-f3.sh | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" "cat /tmp/gesture-f3.out 2>/dev/null | tail -3" </dev/null 2>&1 | sed 's/^/      out| /' | tee -a "$REPORT"
  esc
fi


if has_cell R7 && [ -n "$TMPL" ]; then
  cell "R7 WHICH step is the residual beep? (THINGS_API_TRACE step timeline vs. the beep clock)"
  lab_ssh "$IP" 'rm -rf ~/.local/state/things-api/trace ~/Library/Application\ Support/things-api/trace 2>/dev/null; true' </dev/null
  lab_ssh "$IP" "cat > /tmp/ges-trace.sh" <<EOF
THINGS_API_TRACE=1 $LAB_UI_DIRECT $CLI todo reschedule-repeat $TMPL --frequency daily --interval 5 --ends-after 9 --dangerously-drive-gui --json
EOF
  warm
  note "  -- traced drive --"
  measure trace /tmp/ges-trace.sh | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  # the beep's wall clock, from the same capture the counter reads
  lab_ssh "$IP" "python3 - <<'PY'
import json, re
for line in open('/tmp/beep-trace.ndjson', errors='replace'):
    line = line.strip().rstrip(',')
    if not line.startswith('{'):
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    if 'systemsoundserverd' in (d.get('processImagePath') or '') and 'SSServerImp.cpp:733' in (d.get('eventMessage') or ''):
        print('BEEP AT', d.get('timestamp'))
PY" </dev/null 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
  # the step timeline
  lab_ssh "$IP" "TF=\$(ls -t ~/.local/state/things-api/trace/*.jsonl 2>/dev/null | head -1); echo \"tracefile=\$TF\"; python3 - \"\$TF\" <<'PY'
import json, sys, datetime
path = sys.argv[1]
if not path:
    print('NO TRACE FILE'); raise SystemExit
for line in open(path, errors='replace'):
    try:
        d = json.loads(line)
    except Exception:
        continue
    if d.get('phase') in ('ui-dispatch', 'stage', 'result'):
        ts = d.get('ts')
        when = ts
        try:
            when = datetime.datetime.fromtimestamp(ts / 1000.0).strftime('%H:%M:%S.%f')[:-3]
        except Exception:
            pass
        print('%s  %-12s %-28s %sms %s' % (when, d.get('phase'), (d.get('label') or d.get('stage') or d.get('primitive') or '')[:28], d.get('durationMs', ''), d.get('outcome', '')))
PY" </dev/null 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
fi


# ============================================================ G step-by-step
# After the ⌘A removal ONE beep survives a full reschedule — but only when the
# drive CHANGES the dialog's shape (a frequency switch); a same-shape reschedule
# is silent. Open a PRE-POPULATED Edit Rule… dialog and measure each recipe step
# on its own, so the survivor is attributed rather than guessed.
runstep() { # runstep <label> <applescript-file-in-OUT>
  local lbl="$1"
  lab_scp "$OUT/$lbl.applescript" "admin@$IP:/tmp/g-$lbl.applescript" >/dev/null
  lab_ssh "$IP" "printf 'osascript /tmp/g-%s.applescript\n' $(printf '%q' "$lbl") > /tmp/ges-g-$lbl.sh" </dev/null
  note "  -- step: $lbl --"
  measure "g-$lbl" "/tmp/ges-g-$lbl.sh" | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" "cat /tmp/gesture-g-$lbl.out 2>/dev/null | tail -2" </dev/null 2>&1 | sed 's/^/      out| /' | tee -a "$REPORT"
}

openrule() { # openrule — Edit Rule… on $TMPL (a pre-populated dialog)
  lab_ssh "$IP" "open -g 'things:///show?id=$TMPL'; sleep 3" </dev/null
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  # Edit Rule… lives in the Repeat SUBMENU (ui-recipes.ts), and the parent item
  # must be opened before its menu 1 exists.
  axq 'tell application "System Events" to tell process "Things3"
    click menu bar item "Items" of menu bar 1
    delay 0.4
    click menu item "Repeat" of menu "Items" of menu bar 1
    delay 0.6
    set nms to name of every menu item of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1
    set hit to ""
    repeat with n in nms
      try
        if hit is "" and ((n as text) starts with "Edit Rule") then set hit to (n as text)
      end try
    end repeat
    if hit is "" then
      key code 53
      return "EDIT-RULE-NOT-FOUND: " & (nms as text)
    end if
    click menu item hit of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1
    return "clicked " & hit
  end tell' | sed 's/^/    openrule| /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 3' </dev/null
}

if has_cell G1 && [ -n "$TMPL" ]; then
  cell "G1 per-step beep attribution on a PRE-POPULATED Edit Rule… dialog"
  # put the series in a known WEEKLY state first, so the traced steps below are a
  # genuine weekly -> daily switch (the shape that beeps)
  warm
  lab_ssh "$IP" "$LAB_UI_DIRECT $CLI todo reschedule-repeat $TMPL --frequency weekly --interval 2 --weekdays tuesday --dangerously-drive-gui --json > /tmp/g-setup.out 2>&1; echo setup-exit=\$?" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
  warm
  openrule
  sheetdump "g1-open"

  node -e 'import("./dist/write/vectors/ui.js").then((m)=>process.stdout.write(m.axProbeDialogShapeScript(process.argv[1])))' \
    "group 1 of sheet 1 of $MAINW" > "$OUT/shape.applescript"
  node -e 'import("./dist/write/vectors/ui.js").then((m)=>process.stdout.write(m.axSelectPopupScript(process.argv[1], "daily")))' \
    "pop up button 1 of sheet 1 of $MAINW" > "$OUT/freq.applescript"
  node -e 'import("./dist/write/vectors/ui.js").then((m)=>process.stdout.write(m.axSetGroupNumberScript(process.argv[1], "interval", "5")))' \
    "group 1 of sheet 1 of $MAINW" > "$OUT/ivl.applescript"
  node -e 'import("./dist/write/vectors/ui.js").then((m)=>process.stdout.write(m.axSelectPopupScript(process.argv[1], "after")))' \
    "pop up button 1 of group 1 of sheet 1 of $MAINW" > "$OUT/endsel.applescript"
  node -e 'import("./dist/write/vectors/ui.js").then((m)=>process.stdout.write(m.axSetGroupNumberScript(process.argv[1], "ends-count", "9")))' \
    "group 1 of sheet 1 of $MAINW" > "$OUT/endcnt.applescript"
  node -e 'import("./dist/write/vectors/ui.js").then((m)=>process.stdout.write(m.axEnsureCheckboxScript(process.argv[1], false)))' \
    "checkbox \"Add deadlines\" of sheet 1 of $MAINW" > "$OUT/dlbox.applescript"
  node -e 'import("./dist/write/vectors/ui.js").then((m)=>process.stdout.write(m.axPressScript(process.argv[1])))' \
    "button \"OK\" of sheet 1 of $MAINW" > "$OUT/okpress.applescript"

  note "  -- QUIET control --"
  measure g-quiet "" | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  runstep shape
  runstep dlbox
  runstep freq
  runstep ivl
  runstep endsel
  runstep endcnt
  runstep okpress
fi


if has_cell G2 && [ -n "$TMPL" ]; then
  cell "G2 the PREAMBLE — reveal + activate + Items > Repeat > Edit Rule... (the last unmeasured chunk)"
  warm
  # exactly the shipped press pair, no dialog work afterwards
  lab_ssh "$IP" "cat > /tmp/ges-g2.sh" <<EOF
open -g 'things:///show?id=$TMPL'
sleep 3
osascript -e 'tell application "Things3" to activate'
sleep 2
osascript -e 'tell application "System Events" to tell process "Things3" to click menu item "Repeat" of menu "Items" of menu bar 1'
sleep 1
osascript -e 'tell application "System Events" to tell process "Things3" to click menu item "Edit Rule…" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1'
sleep 3
EOF
  note "  -- QUIET control --"
  measure g2q "" | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  note "  -- preamble (reveal + activate + menu pair) --"
  measure g2 /tmp/ges-g2.sh | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" "cat /tmp/gesture-g2.out 2>/dev/null | tail -4" </dev/null 2>&1 | sed 's/^/      out| /' | tee -a "$REPORT"
  lab_ssh "$IP" 'osascript -l JavaScript ~/labh/sheet.jxa | head -2' </dev/null 2>&1 | sed 's/^/      sheet| /' | tee -a "$REPORT"
  esc
fi

if has_cell G3 && [ -n "$TMPL" ]; then
  cell "G3 the SUBMENU-PARENT press alone (Items > Repeat, nothing after it)"
  warm
  lab_ssh "$IP" "cat > /tmp/ges-g3.sh" <<EOF
open -g 'things:///show?id=$TMPL'
sleep 3
osascript -e 'tell application "Things3" to activate'
sleep 2
osascript -e 'tell application "System Events" to tell process "Things3" to click menu item "Repeat" of menu "Items" of menu bar 1'
sleep 2
EOF
  note "  -- QUIET control --"
  measure g3q "" | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  note "  -- Items > Repeat press only --"
  measure g3 /tmp/ges-g3.sh | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  esc
fi

if has_cell G4 && [ -n "$TMPL" ]; then
  cell "G4 reveal + activate ONLY (no menu at all)"
  warm
  lab_ssh "$IP" "cat > /tmp/ges-g4.sh" <<EOF
open -g 'things:///show?id=$TMPL'
sleep 3
osascript -e 'tell application "Things3" to activate'
sleep 2
EOF
  note "  -- QUIET control --"
  measure g4q "" | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  note "  -- reveal + activate only --"
  measure g4 /tmp/ges-g4.sh | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
fi


if has_cell G5 && [ -n "$TMPL" ]; then
  cell "G5 the steps BACK-TO-BACK on a pre-populated dialog (the shipped cadence, no measurement gaps)"
  warm
  lab_ssh "$IP" "$LAB_UI_DIRECT $CLI todo reschedule-repeat $TMPL --frequency weekly --interval 2 --weekdays tuesday --dangerously-drive-gui --json > /tmp/g5-setup.out 2>&1; echo setup-exit=\$?" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
  warm
  openrule
  # one shell script running the four dialog steps with NO pause between them
  lab_ssh "$IP" "cat > /tmp/ges-g5.sh" <<'EOF'
osascript /tmp/g-shape.applescript
osascript /tmp/g-freq.applescript
osascript /tmp/g-ivl.applescript
osascript /tmp/g-endsel.applescript
osascript /tmp/g-endcnt.applescript
osascript /tmp/g-okpress.applescript
EOF
  note "  -- QUIET control --"
  measure g5q "" | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  note "  -- shape+freq+interval+ends+count+OK, back to back --"
  measure g5 /tmp/ges-g5.sh | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" "cat /tmp/gesture-g5.out 2>/dev/null | tail -8" </dev/null 2>&1 | sed 's/^/      out| /' | tee -a "$REPORT"
fi

if has_cell G6 && [ -n "$TMPL" ]; then
  cell "G6 same, but WITHOUT the frequency switch (shape+interval+ends+count+OK)"
  warm
  lab_ssh "$IP" "$LAB_UI_DIRECT $CLI todo reschedule-repeat $TMPL --frequency daily --interval 3 --dangerously-drive-gui --json > /tmp/g6-setup.out 2>&1; echo setup-exit=\$?" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
  warm
  openrule
  lab_ssh "$IP" "cat > /tmp/ges-g6.sh" <<'EOF'
osascript /tmp/g-shape.applescript
osascript /tmp/g-ivl.applescript
osascript /tmp/g-endsel.applescript
osascript /tmp/g-endcnt.applescript
osascript /tmp/g-okpress.applescript
EOF
  note "  -- QUIET control --"
  measure g6q "" | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  note "  -- no frequency switch, back to back --"
  measure g6 /tmp/ges-g6.sh | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" "cat /tmp/gesture-g6.out 2>/dev/null | tail -8" </dev/null 2>&1 | sed 's/^/      out| /' | tee -a "$REPORT"
fi


if has_cell G7 && [ -n "$TMPL" ]; then
  cell "G7 the SAME back-to-back run with a 1.5s pause after the frequency switch"
  warm
  lab_ssh "$IP" "$LAB_UI_DIRECT $CLI todo reschedule-repeat $TMPL --frequency weekly --interval 2 --weekdays tuesday --dangerously-drive-gui --json > /tmp/g7-setup.out 2>&1; echo setup-exit=\$?" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
  warm
  openrule
  lab_ssh "$IP" "cat > /tmp/ges-g7.sh" <<'XEOF'
osascript /tmp/g-shape.applescript
osascript /tmp/g-freq.applescript
sleep 1.5
osascript /tmp/g-ivl.applescript
osascript /tmp/g-endsel.applescript
osascript /tmp/g-endcnt.applescript
osascript /tmp/g-okpress.applescript
XEOF
  note "  -- QUIET control --"
  measure g7q "" | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  note "  -- freq switch, 1.5s settle, then the rest --"
  measure g7 /tmp/ges-g7.sh | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" "cat /tmp/gesture-g7.out 2>/dev/null | tail -8" </dev/null 2>&1 | sed 's/^/      out| /' | tee -a "$REPORT"
fi


if has_cell R8; then
  cell "R8 the CREATE path — todo make-repeating, full vocabulary, through the CLI"
  warm
  U=$(mktodo BEEP1-MAKE$RANDOM); note "  seed uuid=$U"
  lab_ssh "$IP" "cat > /tmp/ges-mk.sh" <<EOF
$LAB_UI_DIRECT $CLI todo make-repeating $U --frequency weekly --interval 3 --weekdays tuesday --ends-after 6 --dangerously-drive-gui --json
EOF
  note "  -- QUIET control --"
  measure qmk "" | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  note "  -- make-repeating weekly/3/tuesday/ends-after 6 --"
  measure mk /tmp/ges-mk.sh | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" "grep -o '\"ok\":[a-z]*' /tmp/gesture-mk.out | head -1; grep -o '\"repeating.rule.[a-zA-Z]*\":[^,}]*' /tmp/gesture-mk.out | head -6" </dev/null 2>&1 | sed 's/^/      cli| /' | tee -a "$REPORT"
fi

if has_cell R9; then
  cell "R9 the DEADLINED create path — start-days-earlier (the axSetValueScript field)"
  warm
  U=$(mktodo BEEP1-DLMK$RANDOM); note "  seed uuid=$U"
  lab_ssh "$IP" "cat > /tmp/ges-dlmk.sh" <<EOF
$LAB_UI_DIRECT $CLI todo make-repeating $U --frequency weekly --interval 1 --weekdays wednesday --deadline --start-days-earlier 3 --dangerously-drive-gui --json
EOF
  note "  -- QUIET control --"
  measure qdlmk "" | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  note "  -- make-repeating --deadline --start-days-earlier 3 --"
  measure dlmk /tmp/ges-dlmk.sh | grep -E 'BEEPS-' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" "grep -o '\"ok\":[a-z]*' /tmp/gesture-dlmk.out | head -1" </dev/null 2>&1 | sed 's/^/      cli| /' | tee -a "$REPORT"
fi

note ""
note "=== done: PASS=$PASS FAIL=$FAIL — artifacts in $OUT ==="
