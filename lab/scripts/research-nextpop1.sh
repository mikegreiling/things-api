#!/bin/bash
# NEXTPOP1 — the 3.23 `Next:` occurrence POP-UP under a REAL deadline offset:
# does its menu enumerate the rule's START dates or its DUE dates?
#
#   census   the AX census VMRES1 §4.3 could not separate. A yearly and a monthly
#            rule are built one input at a time with a FULL dialog-shape re-audit
#            after EVERY input (harness §AX-drive scrutiny), the Next: menu is
#            dumped at each state, and the deadlined state is resolved by a CLOSED
#            LOOP: click the candidate item, press OK, read the landed rule out of
#            SQLite. `More…` is descended and dumped too.
#   pre      the VMRES1 §4.3 regression, reproduced through the shipped CLI
#            (the control this campaign fixes)
#   cert     the post-fix certification cells: deadlined yearly / monthly /
#            project / make-repeating / reschedule arms, the weekly+daily
#            deadlined regression arms, and the non-deadlined control
#
# METHOD: ONE disposable clone `nextpop1-lab` of things-lab-golden-v4 (the golden
# is NEVER booted). Airgapped (default route deleted), guest clock pinned before
# Things launches, synthetic NEXTPOP1-* fixtures only. Ground truth = read-only
# guest SQLite; `open` exit 0 and CLI exit 0 both prove nothing on their own.
# Beeps are counted by the guest sentinel (research driver: report-only).
# Teardown on EXIT (KEEP=1 to hold the clone, REUSE=1 to re-attach).
#
# Usage:  bash lab/scripts/research-nextpop1.sh [cell...]     # default: census
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="nextpop1-lab"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
CELLS="${*:-census}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax"
REPORT="$OUT/report.txt"
REUSE="${REUSE:-0}"
KEEP="${KEEP:-0}"
# Suffix appended to every fixture title, so a re-attached sitting never collides
# with rows a previous attempt left behind (TAGSFX=2, 3, …).
TAGSFX="${TAGSFX:-}"
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[nextpop1] $*" | tee -a "$REPORT"; }
notef() { echo "[nextpop1] $*" >>"$REPORT"; echo "[nextpop1] $*" >&2; }

case "$VM" in things-lab-golden-*) echo "refusing to touch a golden" >&2; exit 1 ;; esac

note "cells: $CELLS · golden: $GOLDEN · reuse=$REUSE"
if [ "$REUSE" = "1" ]; then
  IP=$(tart ip "$VM" 2>/dev/null) || { note "FATAL: $VM is not running"; exit 1; }
  [ -n "$IP" ] || { note "FATAL: no IP for $VM"; exit 1; }
  note "re-attached to $VM at $IP"
else
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 360) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"
fi
cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — $VM left running at $IP"; return; fi
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "teardown done"
}
trap cleanup EXIT

if [ "$REUSE" != "1" ]; then
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
fi
lab_ssh "$IP" 'mkdir -p ~/labh ~/things-lab/run' </dev/null

lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-noheader -list); if [ "$1" = "-t" ]; then FMT=(-header -column); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF

lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationCount, deadline, rt1_instanceCreationStartDate, rt1_instanceCreationPaused FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row: print("NO-ROW"); sys.exit(0)
if row[0] is None: print("NO-RULE paused=%s"%row[5]); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s ed=%s of=[%s] next=%s icStart=%s icCount=%s paused=%s deadline=%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),d.get('ed'),",".join(offs),
    dpk(row[1]),dpk(row[4]),row[2],row[5],dpk(row[3]) if row[3] else row[3]))
EOF

# The beep sentinel (harness §The beep sentinel) — post-hoc, no live listener.
lab_scp lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/labh/beep-sentinel.sh" >/dev/null
lab_ssh "$IP" 'chmod +x ~/labh/beep-sentinel.sh' </dev/null
beep_reset() { lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null 2>&1; }
beep_mark()  { lab_ssh "$IP" "~/labh/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }
beep_assert() {
  lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/labh/beep-sentinel.sh assert --name $(printf '%q' "$1")" \
    </dev/null 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
}

# ---- the shipped CLI (node + dist + commander) -----------------------------
# SHIP=0 re-attaches to a clone that already carries the bundle and skips the
# ~110MB node copy (a re-run that changed nothing in dist); SHIP=dist copies only
# the rebuilt dist. Any other value ships the whole bundle.
SHIP="${SHIP:-all}"
[ -f dist/cli/main.js ] || { note "FATAL: dist missing — run npm run build"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { local a c; for a in 1 2 3 4 5; do sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; c=$?; [ "$c" -eq 0 ] && return 0; sleep 3; done; return "$c"; }
lab_ssh "$IP" true </dev/null; sleep 2
if [ "$SHIP" != "0" ]; then
  if [ "$SHIP" = "all" ]; then
    scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null || { note "FATAL node scp"; exit 1; }
    COMMANDER_DIR=$(node -e "const p=require.resolve('commander'); console.log(p.slice(0, p.indexOf('/node_modules/commander/')+'/node_modules/commander'.length))")
    scpO -r "$COMMANDER_DIR" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null || { note "FATAL commander scp"; exit 1; }
    scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  fi
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
fi
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
CLI="~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js"
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1

gq() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
## A modal Repeat sheet swallows `quit`, so the warm-up escapes first and pkills
## anything still alive — a re-attached (REUSE=1) sitting must never inherit a
## half-driven dialog from the previous one.
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; pkill -x Things3 >/dev/null 2>&1; sleep 2; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }
warm
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
DBV=$(gq "SELECT value FROM Meta WHERE key='databaseVersion'" 2>/dev/null)
note "env: Things $TVER ($TBLD) · macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) · dbv ${DBV:-?} · clock $(lab_ssh "$IP" date </dev/null)"

# ---- shared helpers --------------------------------------------------------
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
settle() { lab_ssh "$IP" "sleep ${1:-2}" </dev/null; }
alive() { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null; }
ips_count() { lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3*.ips 2>/dev/null | wc -l | tr -d " "' </dev/null; }
rsum() { lab_ssh "$IP" "python3 ~/labh/rsum.py '$1' 2>&1" </dev/null; }
tmplid() { lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1\"" </dev/null; }
plainid() { lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1\"" </dev/null; }
instrows() { lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid||' sd='||IFNULL(startDate,'-')||' dl='||IFNULL(deadline,'-')||' trashed='||trashed FROM TMTask WHERE rt1_repeatingTemplate='$1'\"" </dev/null; }
dpk() { python3 -c 'v=int('"${1:-0}"');print("%04d-%02d-%02d"%(v>>16,(v>>12)&0xF,(v>>7)&0x1F) if v else v)' 2>/dev/null; }
instfirst() {
  local s; s=$(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT IFNULL(startDate,0) FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0 ORDER BY startDate LIMIT 1\"" </dev/null)
  if [ -n "$s" ]; then dpk "$s"; else echo "(no instance)"; fi
}

# BOTH escapes (#597). The promote compounds are multi-vector: the seed leg rides
# the URL scheme, the Repeat-dialog leg rides `ui` ($LAB_UI_DIRECT), and the
# DBLSPAWN1 clean-up leg — the one that clears the double-booked deadline off the
# spawned instance — rides AppleScript, which an sshd-descended shell could not
# reach until $LAB_WRITE_DIRECT existed.
cli() {
  local tag="$1"; shift
  lab_ssh "$IP" "$LAB_DIRECT $CLI $*" </dev/null >"$OUT/cli-$tag.out" 2>&1
  local rc=$?
  notef "    \$ things $* -> exit $rc"
  echo "$rc"
}
clitail() { sed 's/^/      | /' "$OUT/cli-$1.out" | head -"${2:-24}" | tee -a "$REPORT"; }

mktodo() {
  lab_ssh "$IP" "open -g 'things:///add?title=$1&when=$2&auth-token=$TOKEN'; sleep 4" </dev/null
  gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"
}

select_item() {
  local uuid="$1" want="$2" i sel
  for i in 1 2 3 4 5; do
    lab_ssh "$IP" "open -g 'things:///show?id=$uuid'; sleep 3" </dev/null
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
    sel=$(axq 'tell application "Things3" to get name of selected to dos' 2>/dev/null)
    if [ "$sel" = "$want" ]; then notef "  selection OK on attempt $i: '$sel'"; return 0; fi
    notef "  selection attempt $i -> '$sel' (want '$want')"
  done
  return 1
}

SHELL_PATH='sheet 1 of (first window whose subrole is "AXStandardWindow")'

openrepeat() {
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  settle 3
}
esc() { axq 'tell application "System Events" to key code 53' >/dev/null; settle 1; }

# FULL dialog shape inventory — the AX-drive-scrutiny dump taken after EVERY input.
shape() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set sh to $SHELL_PATH
  set g to group 1 of sh
  set out to \"SHELL popups=\" & (count of pop up buttons of sh) & \" fields=\" & (count of text fields of sh) & \" checkboxes=\" & (count of checkboxes of sh) & \" buttons=\" & (count of buttons of sh) & \" groups=\" & (count of groups of sh) & \" statics=\" & (count of static texts of sh)
  repeat with i from 1 to (count of pop up buttons of sh)
    set out to out & linefeed & \"  SHELL popup \" & i & \" = \" & (value of pop up button i of sh)
  end repeat
  repeat with i from 1 to (count of checkboxes of sh)
    set out to out & linefeed & \"  SHELL checkbox \" & i & \" \\\"\" & (title of checkbox i of sh) & \"\\\" = \" & (value of checkbox i of sh)
  end repeat
  repeat with i from 1 to (count of text fields of sh)
    set fp to position of text field i of sh
    set out to out & linefeed & \"  SHELL field \" & i & \" y=\" & (item 2 of fp) & \" = \" & (value of text field i of sh)
  end repeat
  repeat with i from 1 to (count of static texts of sh)
    set sVal to \"\"
    try
      set sVal to (value of static text i of sh) as text
    end try
    set out to out & linefeed & \"  SHELL static \" & i & \" = \" & sVal
  end repeat
  set out to out & linefeed & \"GROUP popups=\" & (count of pop up buttons of g) & \" fields=\" & (count of text fields of g) & \" buttons=\" & (count of buttons of g) & \" checkboxes=\" & (count of checkboxes of g) & \" statics=\" & (count of static texts of g)
  repeat with i from 1 to (count of pop up buttons of g)
    set pp to position of pop up button i of g
    set out to out & linefeed & \"  GROUP popup \" & i & \" y=\" & (item 2 of pp) & \" = \" & (value of pop up button i of g)
  end repeat
  repeat with i from 1 to (count of text fields of g)
    set fp to position of text field i of g
    set out to out & linefeed & \"  GROUP field \" & i & \" y=\" & (item 2 of fp) & \" = \" & (value of text field i of g)
  end repeat
  repeat with i from 1 to (count of static texts of g)
    set sVal to \"\"
    try
      set sVal to (value of static text i of g) as text
    end try
    set sp to position of static text i of g
    set out to out & linefeed & \"  GROUP static \" & i & \" y=\" & (item 2 of sp) & \" = \" & sVal
  end repeat
  set out to out & linefeed & \"GROUP dateareas=\" & (count of (every UI element of g whose role is \"AXDateTimeArea\"))
  return out
end tell"
}

# shapeat <tag> — dump the full shape, store it, and report the DIFF against the
# previous state (the AX-drive-scrutiny law: a shape change is a FINDING).
PREV_SHAPE=""
shapeat() {
  local tag="$1"
  local f="$OUT/ax/shape-$tag.txt"
  shape > "$f" 2>&1
  note "  [shape after: $tag]"
  sed 's/^/      /' "$f" >> "$REPORT"
  if [ -n "$PREV_SHAPE" ]; then
    local d; d=$(diff "$PREV_SHAPE" "$f" | sed 's/^/      /')
    if [ -n "$d" ]; then
      note "    SHAPE DELTA vs $(basename "$PREV_SHAPE" .txt | sed 's/^shape-//'):"
      echo "$d" | tee -a "$REPORT"
    else
      note "    (shape unchanged)"
    fi
  fi
  PREV_SHAPE="$f"
}

# The full item list of the Next: pop-up (group pop-up index $1), one per line.
nextitems() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set pb to pop up button ${1:-2} of group 1 of $SHELL_PATH
  repeat 20 times
    if (exists menu 1 of pb) then exit repeat
    click pb
    delay 0.3
  end repeat
  set nms to name of every menu item of menu 1 of pb
  set out to \"\"
  repeat with i from 1 to (count of nms)
    set nm to item i of nms
    if nm is missing value then set nm to \"(separator)\"
    set out to out & \"[\" & i & \"] \" & nm & linefeed
  end repeat
  key code 53
  delay 0.5
  return out
end tell"
}

# The item list of the Next: pop-up's trailing `More…` submenu (level 2).
moreitems() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set pb to pop up button ${1:-2} of group 1 of $SHELL_PATH
  repeat 20 times
    if (exists menu 1 of pb) then exit repeat
    click pb
    delay 0.3
  end repeat
  set m1 to menu 1 of pb
  set lastI to (count of menu items of m1)
  set lastNm to name of menu item lastI of m1
  set deeper to missing value
  try
    set deeper to menu 1 of menu item lastI of m1
  end try
  if deeper is missing value then
    try
      click menu item lastI of m1
      delay 1
      set deeper to menu 1 of menu item lastI of m1
    end try
  end if
  if deeper is missing value then
    key code 53
    return \"NO-SUBMENU under last item \\\"\" & lastNm & \"\\\"\"
  end if
  set nms to name of every menu item of deeper
  set n to (count of nms)
  set out to \"last item = \\\"\" & lastNm & \"\\\" · submenu has \" & n & \" item(s)\" & linefeed
  repeat with i from 1 to n
    if i <= 6 or i > (n - 3) then
      set nm to item i of nms
      if nm is missing value then set nm to \"(separator)\"
      set out to out & \"  [\" & i & \"] \" & nm & linefeed
    end if
  end repeat
  -- ONE escape per still-open menu, re-checked each time: a blind second escape
  -- dismisses the SHEET itself (measured — it tore the dialog down mid-census).
  key code 53
  delay 0.6
  try
    if (exists menu 1 of pb) then
      key code 53
      delay 0.6
    end if
  end try
  set sheetAlive to \"gone\"
  try
    if (exists $SHELL_PATH) then set sheetAlive to \"alive\"
  end try
  return out & \"  (dialog after the menu reads: \" & sheetAlive & \")\"
end tell"
}

# Click the Next: pop-up item whose title parses to $2 (ISO). Read the value back.
picknext() {
  local idx="$1" iso="$2"
  local y m d; y=${iso:0:4}; m=$((10#${iso:5:2})); d=$((10#${iso:8:2}))
  axq "on parsedYMD(t)
  set s to t as text
  try
    set theDate to date s
    return {year of theDate, (month of theDate) as integer, day of theDate}
  end try
  try
    set ofs to offset of \", \" in s
    if ofs > 0 then
      set theDate to date (text (ofs + 2) thru -1 of s)
      return {year of theDate, (month of theDate) as integer, day of theDate}
    end if
  end try
  return missing value
end parsedYMD
tell application \"System Events\" to tell process \"Things3\"
  set pb to pop up button $idx of group 1 of $SHELL_PATH
  repeat 20 times
    if (exists menu 1 of pb) then exit repeat
    click pb
    delay 0.3
  end repeat
  set m1 to menu 1 of pb
  set nms to name of every menu item of m1
  repeat with i from 1 to (count of nms)
    set nm to item i of nms
    if nm is not missing value then
      set ymd to my parsedYMD(nm)
      if ymd is not missing value then
        if (item 1 of ymd) is $y and (item 2 of ymd) is $m and (item 3 of ymd) is $d then
          click menu item i of m1
          delay 0.8
          return \"CLICKED \\\"\" & nm & \"\\\" -> popup now shows \\\"\" & ((value of pb) as text) & \"\\\"\"
        end if
      end if
    end if
  end repeat
  key code 53
  return \"NO-SUCH-DATE $iso in level 1\"
end tell"
}

setfreq() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set p to pop up button 1 of $SHELL_PATH
  repeat 20 times
    if (exists menu 1 of p) then exit repeat
    click p
    delay 0.3
  end repeat
  click menu item \"$1\" of menu 1 of p
  delay 1.5
  return \"frequency = \" & (value of p)
end tell"
}

setgrouppopup() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set pb to pop up button $1 of group 1 of $SHELL_PATH
  repeat 20 times
    if (exists menu 1 of pb) then exit repeat
    click pb
    delay 0.3
  end repeat
  if (exists menu item \"$2\" of menu 1 of pb) then
    click menu item \"$2\" of menu 1 of pb
    delay 1.2
    return \"popup $1 = \" & (value of pb)
  end if
  key code 53
  return \"NO-SUCH-ITEM \\\"$2\\\" in popup $1; items = \" & ((name of every menu item of menu 1 of pb) as text)
end tell"
}

setdeadlinebox() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set cb to checkbox \"Add deadlines\" of $SHELL_PATH
  if ((value of cb) as integer) is not $1 then
    click cb
    delay 1.5
  end if
  return \"Add deadlines = \" & (value of cb)
end tell"
}

# Set the "and start [n] days earlier" field, found by its label ROW (never by index).
setearlier() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set sh to $SHELL_PATH
  set labelY to missing value
  repeat with i from 1 to (count of static texts of sh)
    set sv to \"\"
    try
      set sv to (value of static text i of sh) as text
    end try
    if sv contains \"days earlier\" then
      set lp to position of static text i of sh
      set labelY to item 2 of lp
    end if
  end repeat
  if labelY is missing value then return \"NO days-earlier LABEL\"
  set hits to {}
  repeat with i from 1 to (count of text fields of sh)
    set fp to position of text field i of sh
    set dy to (item 2 of fp) - labelY
    if dy < 0 then set dy to -dy
    if dy <= 8 then set end of hits to text field i of sh
  end repeat
  if (count of hits) is not 1 then return \"AMBIGUOUS: \" & (count of hits) & \" field(s) on the days-earlier row\"
  set tf to item 1 of hits
  repeat 3 times
    set focused of tf to true
    delay 0.2
    keystroke \"$1\"
    delay 0.1
    key code 48
    delay 0.4
    if ((value of tf) as text) is \"$1\" then return \"start days earlier = \" & (value of tf)
  end repeat
  return \"FIELD DID NOT HOLD: shows \" & (value of tf)
end tell"
}

pressok() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  click button \"OK\" of $SHELL_PATH
  delay 2
  return \"OK pressed\"
end tell"
}

# "Aug 6, 2026" — the fragment of the app's localized item title that pins the date.
date_word() {
  python3 -c "
import datetime
d=datetime.date.fromisoformat('$1')
print(d.strftime('%b ')+str(d.day)+d.strftime(', %Y'))"
}

########################################################################
# CENSUS — START vs DUE, one input at a time, closed-loop resolved
########################################################################
# census_arm <tag> <freq> <start-iso> <due-iso> <offset-days>
# reads the anchor drive list from $ANCHOR_STEPS ("<group-popup-index>:<item>" …)
census_arm() {
  local TAG="$1" FREQ="$2" WHEN="$3" DUE="$4" OFFS="$5"
  note ""
  note "======== CENSUS ARM $TAG — $FREQ · start $WHEN · due $DUE · start-$OFFS-days-earlier ========"
  note "  DISCRIMINATOR: a menu of the rule's DUE dates offers $DUE; a menu of the occurrence"
  note "  START dates offers $WHEN. They are $OFFS days apart and both are in the future."
  PREV_SHAPE=""
  beep_reset
  beep_mark "$TAG setup"
  local U; U=$(mktodo "NEXTPOP1-$TAG$TAGSFX" "$WHEN")
  note "  fixture NEXTPOP1-$TAG$TAGSFX uuid=$U (when=$WHEN, no item deadline)"
  select_item "$U" "NEXTPOP1-$TAG$TAGSFX" || note "  WARN: selection never confirmed"
  beep_mark "$TAG open-dialog"
  openrepeat
  shapeat "$TAG-00-open"
  note "  Next: menu at open:"; nextitems 2 | sed 's/^/      /' | tee -a "$REPORT"

  beep_mark "$TAG frequency"
  note "  --- input: frequency = $FREQ ---"; setfreq "$FREQ" | sed 's/^/      /' | tee -a "$REPORT"
  shapeat "$TAG-01-freq"
  note "  Next: menu:"; nextitems 2 | sed 's/^/      /' | tee -a "$REPORT"

  local step=2 spec idx val
  for spec in $ANCHOR_STEPS; do
    idx="${spec%%:*}"; val="${spec#*:}"
    beep_mark "$TAG anchor $idx=$val"
    note "  --- input: group popup $idx = $val ---"; setgrouppopup "$idx" "$val" | sed 's/^/      /' | tee -a "$REPORT"
    shapeat "$TAG-0$step-popup$idx"
    note "  Next: menu:"; nextitems 2 | sed 's/^/      /' | tee -a "$REPORT"
    step=$((step + 1))
  done

  beep_mark "$TAG add-deadlines"
  note "  --- input: Add deadlines = checked ---"; setdeadlinebox 1 | sed 's/^/      /' | tee -a "$REPORT"
  shapeat "$TAG-0$step-deadlines"; step=$((step + 1))
  note "  Next: menu (deadline ON, offset still at its default):"
  nextitems 2 | sed 's/^/      /' | tee -a "$REPORT"

  beep_mark "$TAG start-earlier"
  note "  --- input: start $OFFS days earlier ---"; setearlier "$OFFS" | sed 's/^/      /' | tee -a "$REPORT"
  shapeat "$TAG-0$step-earlier"; step=$((step + 1))
  note "  *** Next: menu WITH A REAL OFFSET — the census question ***"
  nextitems 2 | tee "$OUT/ax/next-items-$TAG-deadlined.txt" | sed 's/^/      /' | tee -a "$REPORT"
  note "  Next: ▸ More… submenu (the second candidate route):"
  moreitems 2 | sed 's/^/      /' | tee -a "$REPORT"
  shapeat "$TAG-0$step-after-menu-reads"; step=$((step + 1))

  local ITEMS HAS_START=no HAS_DUE=no
  ITEMS=$(cat "$OUT/ax/next-items-$TAG-deadlined.txt")
  echo "$ITEMS" | grep -qF "$(date_word "$WHEN")" && HAS_START=yes
  echo "$ITEMS" | grep -qF "$(date_word "$DUE")" && HAS_DUE=yes
  note "  MENU LISTS the START date $WHEN ($(date_word "$WHEN")): $HAS_START"
  note "  MENU LISTS the DUE   date $DUE ($(date_word "$DUE")): $HAS_DUE"

  # CLOSED LOOP: click whichever candidate the menu offers, commit, read the DB.
  local PICK=""
  [ "$HAS_DUE" = yes ] && PICK="$DUE"
  [ "$HAS_START" = yes ] && PICK="$WHEN"
  if [ -z "$PICK" ]; then
    note "  NEITHER candidate is in the menu — escaping, nothing committed"
    esc; esc
    beep_assert "$TAG"; return
  fi
  beep_mark "$TAG pick-next"
  note "  --- input: Next: = $PICK (the candidate the menu offers) ---"
  picknext 2 "$PICK" | sed 's/^/      /' | tee -a "$REPORT"
  shapeat "$TAG-0$step-picked"
  beep_mark "$TAG commit"
  pressok | sed 's/^/      /' | tee -a "$REPORT"
  settle 6
  local T; T=$(tmplid "NEXTPOP1-$TAG$TAGSFX")
  note "  LANDED template=$T"
  note "    rule: $(rsum "$T")"
  note "    instances: $(instrows "$T")"
  note "    first instance start: $(instfirst "$T")"
  note "  crash=$(alive) ips=$(ips_count)"
  beep_assert "$TAG"
}

cell_census() {
note ""
note "################ CENSUS — does the 3.23 Next: pop-up list START or DUE dates? ################"
note "  VMRES1 §4.3 could not separate them (at ts=0 they coincide). Every input below is followed"
note "  by a FULL dialog-shape dump + diff (harness §AX-drive scrutiny) and a Next:-menu dump."

# yearly: anchor Aug 20 (the DUE date the shipped drive derives), start 14 earlier
ANCHOR_STEPS="3:August 4:day 5:20th"
census_arm Y yearly 2026-08-06 2026-08-20 14

# monthly: anchor day 20, start 14 earlier
ANCHOR_STEPS="3:day 4:20th"
census_arm M monthly 2026-08-06 2026-08-20 14
}

########################################################################
# DIAG — WHY the drive's Next: menu is the SEED's series, not the anchor's
########################################################################
# The shipped select-popup clicks its menu item and EXITS immediately (no delay,
# no read-back). The census, driving the same controls with a settle after each
# click, saw the Next: pop-up follow the anchor. This cell drives the anchor the
# FAST way and then polls, so the propagation law is measured rather than guessed.
cell_diag() {
note ""
note "################ DIAG — anchor → Next: propagation, driven the FAST (shipped) way ################"
beep_reset; beep_mark "diag setup"
local U; U=$(mktodo "NEXTPOP1-DIAG$TAGSFX" 2026-08-06)
note "  fixture NEXTPOP1-DIAG$TAGSFX uuid=$U (when=2026-08-06)"
select_item "$U" "NEXTPOP1-DIAG$TAGSFX" || note "  WARN: selection never confirmed"
openrepeat

# fastpopup <sheet|group> <index> <item> — the SHIPPED script shape: open, click,
# return. No delay, no read-back.
fastpopup() {
  local scope="$1" idx="$2" item="$3" path
  if [ "$scope" = sheet ]; then path="pop up button $idx of $SHELL_PATH"; else path="pop up button $idx of group 1 of $SHELL_PATH"; fi
  axq "tell application \"System Events\" to tell process \"Things3\"
  set pu to ($path)
  repeat 20 times
    if (exists menu 1 of pu) then exit repeat
    click pu
    delay 0.3
  end repeat
  if (exists menu item \"$item\" of menu 1 of pu) then
    click menu item \"$item\" of menu 1 of pu
    return \"clicked $item\"
  end if
  error \"no menu item $item\"
end tell"
}
pollnext() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set out to \"\"
  repeat with i from 1 to ${1:-10}
    set out to out & \"    t+\" & ((i - 1) * 0.5) & \"s  popup2 = \" & ((value of pop up button 2 of group 1 of $SHELL_PATH) as text) & linefeed
    delay 0.5
  end repeat
  return out
end tell"
}
peek3() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set pb to pop up button 2 of group 1 of $SHELL_PATH
  repeat 20 times
    if (exists menu 1 of pb) then exit repeat
    click pb
    delay 0.3
  end repeat
  set nms to name of every menu item of menu 1 of pb
  set out to \"\"
  repeat with i from 1 to 3
    if i <= (count of nms) then
      set nm to item i of nms
      if nm is missing value then set nm to \"(separator)\"
      set out to out & \"[\" & i & \"] \" & nm & \"  \"
    end if
  end repeat
  key code 53
  delay 0.4
  return out
end tell"
}

beep_mark "diag fast drive"
note "  fast: frequency = yearly";      fastpopup sheet 1 yearly  | sed 's/^/      /' | tee -a "$REPORT"
note "  fast: yearly month = August";   fastpopup group 3 August  | sed 's/^/      /' | tee -a "$REPORT"
note "  fast: monthly mode = day";      fastpopup group 4 day     | sed 's/^/      /' | tee -a "$REPORT"
note "  fast: monthly day = 20th";      fastpopup group 5 20th    | sed 's/^/      /' | tee -a "$REPORT"
note "  IMMEDIATELY after the ordinal click — does popup 2 follow the anchor, and how fast?"
pollnext 10 | tee -a "$REPORT"
note "  menu head after the poll: $(peek3)"
note "  popup 2 after ONE menu open+escape:"
pollnext 2 | tee -a "$REPORT"
note "  menu head again:          $(peek3)"
note "  -- now the two remaining shipped steps --"
setdeadlinebox 1 | sed 's/^/      /' | tee -a "$REPORT"
note "  popup 2 after the deadline checkbox:"; pollnext 2 | tee -a "$REPORT"
setearlier 14 | sed 's/^/      /' | tee -a "$REPORT"
note "  popup 2 after the offset field:"; pollnext 2 | tee -a "$REPORT"
note "  menu head at the state the drive fails in: $(peek3)"
esc
note "  crash=$(alive) ips=$(ips_count)"
beep_assert diag
}

########################################################################
# DIAG2 — the bisect: the ONE step the census/DIAG walks never drove
########################################################################
# DIAG established that the anchor reaches the Next: pop-up in under 0.5s and
# STAYS there, so the drive's stale menu is not a race with the anchor click.
# The shipped recipe drives exactly one control neither walk did: the INTERVAL
# field (`Every [n] years`), typed + Tab-committed before the anchor pop-ups.
# This arm adds it and changes nothing else.
cell_diag2() {
note ""
note "################ DIAG2 — same walk, plus the shipped INTERVAL field drive ################"
beep_reset; beep_mark "diag2 setup"
local U; U=$(mktodo "NEXTPOP1-DIAG2$TAGSFX" 2026-08-06)
note "  fixture NEXTPOP1-DIAG2$TAGSFX uuid=$U (when=2026-08-06)"
select_item "$U" "NEXTPOP1-DIAG2$TAGSFX" || note "  WARN: selection never confirmed"
openrepeat

fastpopup2() {
  local scope="$1" idx="$2" item="$3" path
  if [ "$scope" = sheet ]; then path="pop up button $idx of $SHELL_PATH"; else path="pop up button $idx of group 1 of $SHELL_PATH"; fi
  axq "tell application \"System Events\" to tell process \"Things3\"
  set pu to ($path)
  repeat 40 times
    if (exists menu 1 of pu) then exit repeat
    try
      click pu
    end try
    delay 0.3
  end repeat
  if (exists menu item \"$item\" of menu 1 of pu) then
    click menu item \"$item\" of menu 1 of pu
    return \"clicked $item\"
  end if
  key code 53
  error \"no menu item $item\"
end tell"
}
# The shipped set-group-number shape: find the field on the "Every" row, focus,
# keystroke, Tab, read back.
setinterval() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set g to group 1 of $SHELL_PATH
  set everyY to missing value
  repeat with i from 1 to (count of static texts of g)
    set sv to \"\"
    try
      set sv to (value of static text i of g) as text
    end try
    if sv is \"Every\" then
      set lp to position of static text i of g
      set everyY to item 2 of lp
    end if
  end repeat
  if everyY is missing value then return \"NO Every LABEL\"
  set hits to {}
  repeat with i from 1 to (count of text fields of g)
    set fp to position of text field i of g
    set dy to (item 2 of fp) - everyY
    if dy < 0 then set dy to -dy
    if dy <= 8 then set end of hits to text field i of g
  end repeat
  if (count of hits) is not 1 then return \"AMBIGUOUS interval row: \" & (count of hits)
  set tf to item 1 of hits
  repeat 3 times
    set focused of tf to true
    delay 0.15
    keystroke \"$1\"
    delay 0.1
    key code 48
    delay 0.2
    if ((value of tf) as text) is \"$1\" then return \"interval = \" & (value of tf)
    delay 0.3
  end repeat
  return \"FIELD DID NOT HOLD: \" & (value of tf)
end tell"
}
pollnext2() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set out to \"\"
  repeat with i from 1 to ${1:-6}
    set out to out & \"    t+\" & ((i - 1) * 0.5) & \"s  popup2 = \" & ((value of pop up button 2 of group 1 of $SHELL_PATH) as text) & linefeed
    delay 0.5
  end repeat
  return out
end tell"
}
peek3b() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set pb to pop up button 2 of group 1 of $SHELL_PATH
  repeat 20 times
    if (exists menu 1 of pb) then exit repeat
    click pb
    delay 0.3
  end repeat
  set nms to name of every menu item of menu 1 of pb
  set out to \"\"
  repeat with i from 1 to 3
    if i <= (count of nms) then
      set nm to item i of nms
      if nm is missing value then set nm to \"(separator)\"
      set out to out & \"[\" & i & \"] \" & nm & \"  \"
    end if
  end repeat
  key code 53
  delay 0.4
  return out
end tell"
}

beep_mark "diag2 drive"
note "  frequency = yearly";     fastpopup2 sheet 1 yearly | sed 's/^/      /' | tee -a "$REPORT"
note "  interval = 1 (THE ADDED STEP)"; setinterval 1 | sed 's/^/      /' | tee -a "$REPORT"
note "  yearly month = August";  fastpopup2 group 3 August | sed 's/^/      /' | tee -a "$REPORT"
note "  monthly mode = day";     fastpopup2 group 4 day    | sed 's/^/      /' | tee -a "$REPORT"
note "  monthly day = 20th";     fastpopup2 group 5 20th   | sed 's/^/      /' | tee -a "$REPORT"
note "  popup 2 after the ordinal:"; pollnext2 6 | tee -a "$REPORT"
note "  menu head: $(peek3b)"
setdeadlinebox 1 | sed 's/^/      /' | tee -a "$REPORT"
setearlier 14 | sed 's/^/      /' | tee -a "$REPORT"
note "  popup 2 at the drive's failure state:"; pollnext2 3 | tee -a "$REPORT"
note "  menu head at the drive's failure state: $(peek3b)"
note "  full shape at the failure state:"; PREV_SHAPE=""; shapeat "diag2-final"
esc
note "  crash=$(alive) ips=$(ips_count)"
beep_assert diag2
}

########################################################################
# DIAG3 — the hypothesis: a NEXT INPUT inside the propagation window
########################################################################
# DIAG/DIAG2: the anchor reaches the Next: pop-up ~0.5s after the ordinal click.
# The shipped drive presses "Add deadlines" ~0.3s after that click — INSIDE the
# window. This arm drives the ordinal and then the checkbox with NO pause, then
# polls: if the Next value never catches up, the sheet rebuild the checkbox
# triggers is swallowing the pending recompute, and that is the whole bug.
cell_diag3() {
note ""
note "################ DIAG3 — checkbox pressed INSIDE the anchor's propagation window ################"
beep_reset; beep_mark "diag3 setup"
local U; U=$(mktodo "NEXTPOP1-DIAG3$TAGSFX" 2026-08-06)
note "  fixture NEXTPOP1-DIAG3$TAGSFX uuid=$U"
select_item "$U" "NEXTPOP1-DIAG3$TAGSFX" || note "  WARN: selection never confirmed"
openrepeat
# One script: ordinal click → checkbox → offset, back to back, then a 12 × 0.5s
# poll of the Next pop-up. No pause anywhere the shipped drive does not have one.
axq "tell application \"System Events\" to tell process \"Things3\"
  set sh to $SHELL_PATH
  set g to group 1 of sh
  set out to \"\"
  -- frequency (sheet pop-up 1), then WAIT for the group to carry an Every row
  set pu to pop up button 1 of sh
  repeat 20 times
    if (exists menu 1 of pu) then exit repeat
    click pu
    delay 0.3
  end repeat
  click menu item \"yearly\" of menu 1 of pu
  repeat 40 times
    if (count of pop up buttons of g) is 5 then exit repeat
    delay 0.2
  end repeat
  set out to out & \"group popups after frequency: \" & (count of pop up buttons of g) & linefeed
  -- the three anchor pop-ups, each clicked and left immediately
  repeat with spec in {{3, \"August\"}, {4, \"day\"}, {5, \"20th\"}}
    set idx to item 1 of spec
    set nm to item 2 of spec
    set pb to pop up button idx of g
    repeat 20 times
      if (exists menu 1 of pb) then exit repeat
      click pb
      delay 0.3
    end repeat
    click menu item nm of menu 1 of pb
    set out to out & \"clicked \" & nm & \" · popup2 now = \" & ((value of pop up button 2 of g) as text) & linefeed
  end repeat
  -- the checkbox, pressed with NO pause (the shipped cadence)
  set cb to checkbox \"Add deadlines\" of sh
  if ((value of cb) as integer) is not 1 then click cb
  set out to out & \"checkbox pressed · popup2 = \" & ((value of pop up button 2 of g) as text) & linefeed
  repeat with i from 1 to 12
    delay 0.5
    set out to out & \"  t+\" & (i * 0.5) & \"s popup2 = \" & ((value of pop up button 2 of g) as text) & linefeed
  end repeat
  return out
end tell" | sed 's/^/      /' | tee -a "$REPORT"
note "  menu head after the poll:"
nextitems 2 | head -4 | sed 's/^/      /' | tee -a "$REPORT"
esc
note "  crash=$(alive) ips=$(ips_count)"
beep_assert diag3
}

########################################################################
# DIAG4 — the settle law: how long is the window, and does waiting it out fix it?
########################################################################
# DIAG3: the anchor's Next: recompute is LOST when the next input lands inside
# its window. This arm measures the window at 0.1s resolution and then re-runs
# DIAG3's sequence with a QUIESCENCE WAIT in front of the checkbox: if the value
# survives, "leave the dialog quiescent before the next input" is the whole fix.
cell_diag4() {
note ""
note "################ DIAG4 — the recompute window, and the settle that survives it ################"
beep_reset; beep_mark "diag4 setup"
local U; U=$(mktodo "NEXTPOP1-DIAG4$TAGSFX" 2026-08-06)
note "  fixture NEXTPOP1-DIAG4$TAGSFX uuid=$U"
select_item "$U" "NEXTPOP1-DIAG4$TAGSFX" || note "  WARN: selection never confirmed"
openrepeat
axq "tell application \"System Events\" to tell process \"Things3\"
  set sh to $SHELL_PATH
  set g to group 1 of sh
  set out to \"\"
  set pu to pop up button 1 of sh
  repeat 20 times
    if (exists menu 1 of pu) then exit repeat
    click pu
    delay 0.3
  end repeat
  click menu item \"yearly\" of menu 1 of pu
  repeat 40 times
    if (count of pop up buttons of g) is 5 then exit repeat
    delay 0.2
  end repeat
  repeat with spec in {{3, \"August\"}, {4, \"day\"}, {5, \"20th\"}}
    set idx to item 1 of spec
    set nm to item 2 of spec
    set pb to pop up button idx of g
    repeat 20 times
      if (exists menu 1 of pb) then exit repeat
      click pb
      delay 0.3
    end repeat
    click menu item nm of menu 1 of pb
  end repeat
  -- (1) measure the window at 0.1s resolution, WITHOUT any further input
  set startVal to (value of pop up button 2 of g) as text
  set out to out & \"after the ordinal click, popup2 = \" & startVal & linefeed
  set flipped to -1
  repeat with i from 1 to 40
    delay 0.1
    set v to (value of pop up button 2 of g) as text
    if v is not startVal and flipped is -1 then
      set flipped to i
      set out to out & \"  FLIPPED at t+\" & (i * 0.1) & \"s -> \" & v & linefeed
    end if
  end repeat
  if flipped is -1 then set out to out & \"  NEVER flipped in 4.0s (still \" & startVal & \")\" & linefeed
  -- (2) NOW press the checkbox, outside the window, and see whether it holds
  set cb to checkbox \"Add deadlines\" of sh
  if ((value of cb) as integer) is not 1 then click cb
  delay 1
  set out to out & \"after the checkbox (pressed OUTSIDE the window): popup2 = \" & ((value of pop up button 2 of g) as text) & linefeed
  return out
end tell" | sed 's/^/      /' | tee -a "$REPORT"
note "  menu head:"; nextitems 2 | head -4 | sed 's/^/      /' | tee -a "$REPORT"
esc
note "  crash=$(alive) ips=$(ips_count)"
beep_assert diag4
}

########################################################################
# PRE — reproduce the VMRES1 §4.3 regression through the shipped CLI
########################################################################
cell_pre() {
note ""
note "################ PRE — the VMRES1 §4.3 regression, through the shipped CLI ################"
beep_reset
local rc T
# (a) the VERBATIM VMRES1 §4.3 command — same dates, same clock as the original
beep_mark "pre vmres1-verbatim"
note "  -- (a) the verbatim VMRES1 §4.3 command (July dates) --"
rc=$(cli pre-v todo add-repeating "'NEXTPOP1-PRE-V'" --when 2026-07-06 --deadline 2026-07-20 \
      --frequency yearly --interval 1 --dangerously-drive-gui --verify-timeout 120000)
clitail pre-v 34
T=$(tmplid NEXTPOP1-PRE-V); note "  template=${T:-<none>}"; [ -n "$T" ] && note "  rule: $(rsum "$T")"
note "  PRE (a) verbatim exit=$rc"
# (b) the census dates, driven by the shipped CLI (the state the census walked by hand)
beep_mark "pre yearly-august"
note "  -- (b) the census dates (August), yearly --"
rc=$(cli pre-y todo add-repeating "'NEXTPOP1-PRE-Y'" --when 2026-08-06 --deadline 2026-08-20 \
      --frequency yearly --interval 1 --dangerously-drive-gui --verify-timeout 120000)
clitail pre-y 34
T=$(tmplid NEXTPOP1-PRE-Y); note "  template=${T:-<none>}"; [ -n "$T" ] && note "  rule: $(rsum "$T")"
note "  PRE (b) yearly exit=$rc"
beep_mark "pre monthly-august"
note "  -- (c) the census dates (August), monthly --"
rc=$(cli pre-m todo add-repeating "'NEXTPOP1-PRE-M'" --when 2026-08-06 --deadline 2026-08-20 \
      --frequency monthly --interval 1 --dangerously-drive-gui --verify-timeout 120000)
clitail pre-m 34
T=$(tmplid NEXTPOP1-PRE-M); note "  template=${T:-<none>}"; [ -n "$T" ] && note "  rule: $(rsum "$T")"
note "  PRE (c) monthly exit=$rc"
note "  crash=$(alive) ips=$(ips_count)"
beep_assert pre
}

########################################################################
# CERT — the post-fix certification cells
########################################################################
# certcell <tag> <title> <expect-next(start)> <expect-ts> <argv...>
certcell() {
  local tag="$1" title="$2" xstart="$3" xts="$4"; shift 4
  note ""
  note "  ---- CELL $tag ----"
  beep_mark "cert $tag"
  local rc; rc=$(cli "$tag" "$@")
  clitail "$tag" 26
  local T R GOTSTART GOTTS verdict="PASS"
  T=$(tmplid "$title")
  R=$(rsum "$T" 2>/dev/null)
  note "    template=${T:-<none>}"
  note "    rule: $R"
  note "    instances: $(instrows "$T" 2>/dev/null)"
  GOTSTART=$(echo "$R" | grep -o 'next=[^ ]*' | cut -d= -f2)
  GOTTS=$(echo "$R" | grep -o 'ts=[^ ]*' | cut -d= -f2)
  [ "$rc" = "0" ] || verdict="FAIL(exit=$rc)"
  { [ "$xstart" = "-" ] || [ "$GOTSTART" = "$xstart" ]; } || verdict="$verdict FAIL(next=$GOTSTART want $xstart)"
  { [ "$xts" = "-" ] || [ "$GOTTS" = "$xts" ]; } || verdict="$verdict FAIL(ts=$GOTTS want $xts)"
  note "    CELL $tag: $verdict   [exit=$rc next=$GOTSTART ts=$GOTTS]"
  note "    crash=$(alive) ips=$(ips_count)"
}

cell_cert() {
note ""
note "################ CERT — deadlined promote cells on Things $TVER ################"
beep_reset

# the two FAILING cells of VMRES1 §4.3
certcell c1-yearly NEXTPOP1-C1 2026-08-06 -14 todo add-repeating "'NEXTPOP1-C1'" --when 2026-08-06 \
  --deadline 2026-08-20 --frequency yearly --interval 1 --dangerously-drive-gui --verify-timeout 120000
certcell c2-monthly NEXTPOP1-C2 2026-08-06 -14 todo add-repeating "'NEXTPOP1-C2'" --when 2026-08-06 \
  --deadline 2026-08-20 --frequency monthly --interval 1 --dangerously-drive-gui --verify-timeout 120000
# The project-side arm, placed in an AREA. It has to be: project.make-repeating
# addresses its target as a selectable ROW, and an AREA-LESS project with a future
# start date is a Someday row (start=2) that the app renders under UPCOMING, so the
# `someday` reveal the taxonomy picks lands on a view the row is not in ("no
# content-table row selected to the target project's title"). That gap is real and
# PRE-EXISTS this campaign — it is a row-addressing question, not a Next:-pop-up
# one — so the deadlined-promote arm is certified on the area route, which is the
# certified row shape.
certcell c3-project NEXTPOP1-C3 2026-08-07 -14 project add-repeating "'NEXTPOP1-C3'" --area LAB-AREA-A \
  --when 2026-08-07 --deadline 2026-08-21 --frequency monthly --interval 1 --dangerously-drive-gui \
  --verify-timeout 120000
# the previously-WORKING deadlined cells (regression)
certcell c4-weekly NEXTPOP1-C4 2026-08-06 -14 todo add-repeating "'NEXTPOP1-C4'" --when 2026-08-06 \
  --deadline 2026-08-20 --frequency weekly --interval 1 --dangerously-drive-gui --verify-timeout 120000
certcell c5-daily NEXTPOP1-C5 2026-08-06 -3 todo add-repeating "'NEXTPOP1-C5'" --when 2026-08-06 \
  --deadline 2026-08-09 --frequency daily --interval 1 --dangerously-drive-gui --verify-timeout 120000
# the NON-deadlined control (must stay green)
certcell c6-plain NEXTPOP1-C6 2026-08-06 0 todo add-repeating "'NEXTPOP1-C6'" --when 2026-08-06 \
  --frequency yearly --interval 1 --dangerously-drive-gui --verify-timeout 120000
# make-repeating (the pure-ui op) with the rule-level deadline vocabulary
lab_ssh "$IP" "open -g 'things:///add?title=NEXTPOP1-C7&when=2026-08-06&auth-token=$TOKEN'; sleep 4" </dev/null
local C7; C7=$(plainid NEXTPOP1-C7)
note "  (c7 seed uuid=$C7)"
certcell c7-make NEXTPOP1-C7 2026-08-06 -14 todo make-repeating "$C7" --when 2026-08-06 --deadline \
  --start-days-earlier 14 --frequency yearly --interval 1 --dangerously-drive-gui --verify-timeout 120000
# reschedule onto a deadlined monthly rule (the other deadlineDriveNext caller)
local C2; C2=$(tmplid NEXTPOP1-C2)
certcell c8-resched NEXTPOP1-C2 2026-09-10 -14 todo reschedule-repeat "$C2" --frequency monthly \
  --interval 1 --when 2026-09-10 --deadline --start-days-earlier 14 --dangerously-drive-gui --verify-timeout 120000

beep_assert cert
}

for c in $CELLS; do
  case "$c" in
    census) cell_census ;;
    diag) cell_diag ;;
    diag2) cell_diag2 ;;
    diag3) cell_diag3 ;;
    diag4) cell_diag4 ;;
    pre) cell_pre ;;
    cert) cell_cert ;;
    *) note "unknown cell '$c'" ;;
  esac
done

note ""
note "==== DONE — report: $REPORT ===="
