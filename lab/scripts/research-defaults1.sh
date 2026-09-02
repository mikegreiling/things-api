#!/bin/bash
# DEFAULTS1 — what does the Repeat dialog PRE-FILL from the to-do's own state?
#
# The maintainer's insight (observed on Things 3.23.2): the dialog seeds itself
# from the row it was opened on. A to-do scheduled for date D, asked to repeat
# weekly, appears to come up already saying "every 1 week on <D's weekday>" with
# `Next:` = D. If that is a LAW rather than a coincidence, the make-repeating
# drive can replace several actuations — each ~1s of settles and recompute waits
# — with cheap VERIFY-BY-READ, because our own CLI mints the seed (promote-via-
# clone) and therefore controls the state the dialog seeds itself from.
#
# This driver measures the law and nothing else. It modifies no shipped code.
#
#   matrix    the defaults matrix: SEED STATE x FREQUENCY. For each seed state a
#             fixture is minted ONCE; the dialog is then opened fresh per
#             frequency, the frequency is selected, the `Next:` recompute is
#             WAITED OUT (with its own per-cell timeline, so a stale read is
#             visible in the record), and every control is READ without touching
#             anything else. Full dialog-shape census at open and after the
#             selection (harness §AX-drive scrutiny). ESCAPED, never committed.
#   fresh     the independence control: does re-opening the dialog on an
#             untouched seed come back on its after-completion default, or does
#             an escaped selection persist? (`matrix` reuses one seed per state,
#             so the whole matrix rests on this cell.)
#   timing    the recompute timeline at 100ms resolution for 3s, per frequency —
#             what a minimal recipe's verify-by-read must wait for, and what it
#             would have read had it not waited.
#   commit    the proof that the defaults LAND: one representative per frequency
#             committed with the pre-filled values ACCEPTED UNTOUCHED (open ->
#             select frequency -> settle -> OK), plus the deadlined arms; the
#             landed rule blob, cursors and the seed row are read out of SQLite.
#   menus     the CONVERSION VOCABULARY: every cadence pop-up's full item list at
#             the settled default state, per frequency. A residual-actuation
#             count is only meaningful against the menu the actuation must walk.
#   remind    does a seed's REMINDER time reach the rule? Seeds minted as
#             `when=<date>@<HH:MM>`, read per frequency, then committed untouched
#             and decoded (rule blob + the row's own reminder columns).
#   partial   the PARTIAL pre-fill matrix: for a rule shape a seed date cannot
#             fully express, what is the closest seedable default and what is the
#             RESIDUAL actuation set? Seeds on a month's 31st / 30th / first
#             Monday / last Friday / fifth Saturday, read per frequency.
#
# METHOD: ONE disposable clone `defaults1-lab` of things-lab-golden-v4 (the
# golden is NEVER booted). Airgapped (default route deleted), guest clock pinned
# to 2026-07-05 12:00 BEFORE Things launches (the trial wall is 2026-07-18 and
# this driver never rolls the clock), guest muted, synthetic DEF1-* fixtures
# only. Ground truth = read-only guest SQLite; `open` exit 0 proves nothing.
# Beeps counted by the guest sentinel (research driver: report-only).
# Teardown on EXIT (KEEP=1 to hold the clone, REUSE=1 to re-attach).
#
# No shipped CLI is needed: seeds ride the URL scheme and the dialog is driven
# directly with System Events under the AXVM1 grant, so nothing is shipped to
# the guest but two small helper scripts.
#
# Usage:  bash lab/scripts/research-defaults1.sh [cell...]    # default: matrix
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="defaults1-lab"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
CELLS="${*:-matrix}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax"
REPORT="$OUT/report.txt"
REUSE="${REUSE:-0}"
KEEP="${KEEP:-0}"
# Suffix appended to every fixture title, so a re-attached sitting never
# collides with rows a previous attempt left behind (TAGSFX=2, 3, ...).
TAGSFX="${TAGSFX:-}"
# Which seed states / frequencies the matrix walks (override to re-run one cell).
STATES="${STATES:-}"
FREQS="${FREQS:-}"
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[defaults1] $*" | tee -a "$REPORT"; }
notef() { echo "[defaults1] $*" >>"$REPORT"; echo "[defaults1] $*" >&2; }

case "$VM" in things-lab-golden-*) echo "refusing to touch a golden" >&2; exit 1 ;; esac

# THE TRIAL WALL (harness.md): golden-v4's trial dies 2026-07-18. This driver
# pins 2026-07-05 and never moves it; the constant is here so a future edit that
# reaches for a later date trips over it.
TRIAL_WALL="2026-07-18"
PINNED="2026-07-05"

note "cells: $CELLS · golden: $GOLDEN · reuse=$REUSE · clock pinned $PINNED (trial wall $TRIAL_WALL)"
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
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null

lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-noheader -list); if [ "$1" = "-t" ]; then FMT=(-header -column); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF

# The rule-blob decoder (rsum.py, as used by NEXTPOP1/CNCAC1) plus the seed row's
# own scheduling fields — a commit cell must prove BOTH what the rule says and
# what happened to the row the dialog was opened on.
lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationCount, deadline, rt1_instanceCreationStartDate, rt1_instanceCreationPaused, startDate, start, status, rt1_repeatingTemplate FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row: print("NO-ROW"); sys.exit(0)
tail=" | ROW startDate=%s start=%s status=%s tmpl=%s deadline=%s"%(dpk(row[6]),row[7],row[8],(row[9] or "-"),dpk(row[3]) if row[3] else row[3])
if row[0] is None: print("NO-RULE paused=%s%s"%(row[5],tail)); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s ed=%s of=[%s] next=%s icStart=%s icCount=%s paused=%s%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),d.get('ed'),",".join(offs),
    dpk(row[1]),dpk(row[4]),row[2],row[5],tail))
EOF

# The WHOLE decoded rule blob plus every reminder-bearing column — the reminder
# arms need keys rsum.py does not name, so nothing is filtered out here.
lab_ssh "$IP" 'cat > ~/labh/rfull.py' <<'EOF'
import sys, sqlite3, glob, plistlib, pprint
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
row=c.execute("SELECT rt1_recurrenceRule, reminderTime, rt1_nextInstanceStartDate, startDate, deadline, rt1_repeatingTemplate, title FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row: print("NO-ROW"); sys.exit(0)
print("title=%r reminderTime=%r startDate=%s deadline=%s next=%s tmpl=%s"%(
    row[6], row[1], dpk(row[3]), dpk(row[4]) if row[4] else row[4], dpk(row[2]), row[5] or "-"))
if row[0] is None:
    print("  rule: NONE"); sys.exit(0)
d=plistlib.loads(row[0])
print("  rule: %s"%pprint.pformat(d, width=200, compact=True))
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
rfull() { lab_ssh "$IP" "python3 ~/labh/rfull.py '$1' 2>&1" </dev/null; }
tmplid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
anyid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
instrows() { gq "SELECT uuid||' sd='||IFNULL(startDate,'-')||' dl='||IFNULL(deadline,'-')||' trashed='||trashed FROM TMTask WHERE rt1_repeatingTemplate='$1'"; }

SHELL_PATH='sheet 1 of (first window whose subrole is "AXStandardWindow")'

# mkseed <title> <when-or-empty> <deadline-or-empty> -> uuid
# The seed is minted through the URL scheme exactly as promote-via-clone mints
# its own (src/write/promote-clone.ts): one `things:///add` carrying the
# requested when/deadline.
mkseed() {
  local title="$1" when="$2" dl="$3" url="things:///add?title=$title&auth-token=$TOKEN" u i
  [ -n "$when" ] && url="$url&when=$when"
  [ -n "$dl" ] && url="$url&deadline=$dl"
  # RETRY on an empty read-back. A dispatched-but-not-yet-committed add reads as
  # absent, and an empty uuid is not merely a missing fixture: it poisons the
  # WHOLE clone downstream, because `things:///show?id=` with an empty id raises
  # a modal "Cannot show the list with ID" sheet that then swallows every later
  # menu press (measured — it cost this campaign a commit pass; see §7).
  for i in 1 2 3; do
    lab_ssh "$IP" "open -g '$url'; sleep 4" </dev/null
    u=$(anyid "$title")
    [ -n "$u" ] && { echo "$u"; return 0; }
    notef "  mkseed '$title' attempt $i read back no row — retrying"
  done
  return 1
}

# Dismiss any NON-Repeat modal sheet standing on a Things window, and say so.
# A WINDOW census cannot see a sheet (harness §URLEN1), so this walks for them
# explicitly and presses their button rather than blind-escaping — a blind
# escape on the Repeat dialog would tear down the very thing a cell is driving.
dismiss_alerts() {
  local r
  r=$(axq "tell application \"System Events\" to tell process \"Things3\"
  set n to 0
  set seen to \"\"
  repeat 6 times
    set found to false
    repeat with w in windows
      repeat with s in sheets of w
        set txt to \"\"
        try
          set txt to (value of every static text of s) as text
        end try
        set isRepeat to false
        try
          if (exists group 1 of s) and (exists pop up button 1 of s) then set isRepeat to true
        end try
        if not isRepeat then
          set seen to seen & \"[\" & txt & \"] \"
          set n to n + 1
          set found to true
          try
            click button \"OK\" of s
          on error
            try
              click button 1 of s
            end try
          end try
          delay 0.6
          exit repeat
        end if
      end repeat
      if found then exit repeat
    end repeat
    if not found then exit repeat
  end repeat
  if n is 0 then return \"no stray sheet\"
  return \"DISMISSED \" & n & \" stray sheet(s): \" & seen
end tell")
  case "$r" in
    "no stray sheet") ;;
    *) note "    !! $r" ;;
  esac
}

# The seed row as the app stored it — the input side of every default below.
seedrow() {
  gq "SELECT 'startDate='||IFNULL(startDate,'NULL')||' start='||start||' startBucket='||startBucket||' deadline='||IFNULL(deadline,'NULL')||' status='||status FROM TMTask WHERE uuid='$1'"
}

select_item() {
  local uuid="$1" want="$2" i sel
  # NEVER dispatch a reveal with an empty id (see mkseed) — refuse instead.
  if [ -z "$uuid" ]; then
    notef "  select_item REFUSED: empty uuid for '$want' (an empty things:///show?id= raises a modal)"
    return 1
  fi
  dismiss_alerts
  for i in 1 2 3 4 5; do
    lab_ssh "$IP" "open -g 'things:///show?id=$uuid'; sleep 3" </dev/null
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
    sel=$(axq 'tell application "Things3" to get name of selected to dos' 2>/dev/null)
    if [ "$sel" = "$want" ]; then notef "  selection OK on attempt $i: '$sel'"; return 0; fi
    notef "  selection attempt $i -> '$sel' (want '$want')"
  done
  return 1
}

openrepeat() {
  dismiss_alerts
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  settle 3
  # A dialog that did not open is a FINDING, not a silent skip: report what stood
  # in the way (a stray sheet is the measured cause) instead of "no dialog".
  if [ "$(dialog_alive)" != "alive" ]; then
    note "    !! the Repeat dialog did not open — sheet census: $(axq "tell application \"System Events\" to tell process \"Things3\"
  set out to \"\"
  repeat with w in windows
    set out to out & \"win(\" & (name of w) & \" sheets=\" & (count of sheets of w) & \") \"
  end repeat
  return out
end tell" | tr -d '\n')"
  fi
}
esc() { axq 'tell application "System Events" to key code 53' >/dev/null; settle 1; }
dialog_alive() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  try
    if (exists $SHELL_PATH) then return \"alive\"
  end try
  return \"gone\"
end tell"
}

# FULL dialog shape + VALUE inventory — the AX-drive-scrutiny dump taken at every
# state. Every control the dialog can present is enumerated with its row (y) and
# its value, so a pre-filled control is visible without knowing in advance which
# control it is.
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
    set sp to position of static text i of sh
    set out to out & linefeed & \"  SHELL static \" & i & \" y=\" & (item 2 of sp) & \" = \" & sVal
  end repeat
  set sdas to (every UI element of sh whose role is \"AXDateTimeArea\")
  set out to out & linefeed & \"SHELL dateareas=\" & (count of sdas)
  repeat with i from 1 to (count of sdas)
    set dv to \"\"
    try
      set dv to (value of item i of sdas) as text
    end try
    set dp to position of item i of sdas
    set out to out & linefeed & \"  SHELL datearea \" & i & \" y=\" & (item 2 of dp) & \" = \" & dv
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
  set das to (every UI element of g whose role is \"AXDateTimeArea\")
  set out to out & linefeed & \"GROUP dateareas=\" & (count of das)
  repeat with i from 1 to (count of das)
    set dv to \"\"
    try
      set dv to (value of item i of das) as text
    end try
    set dp to position of item i of das
    set out to out & linefeed & \"  GROUP datearea \" & i & \" y=\" & (item 2 of dp) & \" = \" & dv
  end repeat
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
  note "  [shape: $tag]"
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
# The report keeps every shape dump; the console gets the pre-filled controls only.
shapequiet() {
  local tag="$1"
  local f="$OUT/ax/shape-$tag.txt"
  shape > "$f" 2>&1
  { echo "  [shape: $tag]"; sed 's/^/      /' "$f"; } >> "$REPORT"
  echo "$f"
}

# setfreq_timed <item> — click a frequency item and SAMPLE the recompute in the
# same hop: the `Next:` pop-up's value (group pop-up 2 under the 3.23 shape) is
# read at eight instants over ~1.9s, so every matrix cell carries the evidence of
# whether its later read was taken before or after the recompute (NEXTPOP1: the
# pop-up recomputes ~0.4s after the calendar anchor moves, and an INPUT inside
# that window cancels it permanently — these are reads, never inputs).
setfreq_timed() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set sh to $SHELL_PATH
  set p to pop up button 1 of sh
  repeat 20 times
    if (exists menu 1 of p) then exit repeat
    click p
    delay 0.3
  end repeat
  if not (exists menu item \"$1\" of menu 1 of p) then
    set nms to (name of every menu item of menu 1 of p) as text
    key code 53
    return \"NO-SUCH-FREQUENCY \\\"$1\\\"; items = \" & nms
  end if
  click menu item \"$1\" of menu 1 of p
  set out to \"frequency = \" & (value of p)
  set g to group 1 of sh
  set waits to {0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.4, 0.4}
  set t to 0
  repeat with w in waits
    delay (w as real)
    set t to t + (w as real)
    set nv to \"(absent)\"
    try
      set nv to (value of pop up button 2 of g) as text
    end try
    set out to out & linefeed & \"    t+\" & (t as text) & \"s Next: \" & nv
  end repeat
  return out
end tell"
}

# The first N items of the `Next:` pop-up. This is an INPUT (a click), so it runs
# only AFTER every pure read of the cell is banked.
nextitems() {
  local idx="${1:-2}" n="${2:-8}"
  axq "tell application \"System Events\" to tell process \"Things3\"
  set g to group 1 of $SHELL_PATH
  if not (exists pop up button $idx of g) then return \"(no pop up button $idx in the cadence group)\"
  set pb to pop up button $idx of g
  repeat 20 times
    if (exists menu 1 of pb) then exit repeat
    click pb
    delay 0.3
  end repeat
  set nms to name of every menu item of menu 1 of pb
  set out to \"(\" & (count of nms) & \" items) \"
  repeat with i from 1 to (count of nms)
    if i <= $n then
      set nm to item i of nms
      if nm is missing value then set nm to \"(separator)\"
      set out to out & \"[\" & i & \"] \" & nm & \"  \"
    end if
  end repeat
  key code 53
  delay 0.5
  return out
end tell"
}

pressok() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  click button \"OK\" of $SHELL_PATH
  delay 2
  return \"OK pressed\"
end tell"
}

########################################################################
# the seed-state table
########################################################################
# id | when (URL) | deadline (URL) | what it is
# The clock is pinned to Sunday 2026-07-05, so: 07-05 = today, 07-06 = tomorrow
# (Mon), 07-09 = Thursday, 11-19 = Thursday months out, 08-31 = a 31st,
# 06-20 = a past Saturday (overdue).
seed_spec() {
  case "$1" in
    S1) echo "today||today (2026-07-05, a Sunday)" ;;
    S2) echo "tomorrow||tomorrow (2026-07-06, a Monday)" ;;
    S3) echo "2026-07-09||a specific future date (Thursday 2026-07-09)" ;;
    S4) echo "2026-11-19||a date months out (Thursday 2026-11-19)" ;;
    S5) echo "||no when at all (Inbox)" ;;
    S6) echo "someday||someday" ;;
    S7) echo "evening||this evening (2026-07-05, evening bucket)" ;;
    S8) echo "2026-06-20||a PAST date, overdue (Saturday 2026-06-20)" ;;
    S9) echo "2026-08-31||the 31st of a month (Monday 2026-08-31)" ;;
    S10) echo "2026-07-09|2026-07-09|deadline = when (2026-07-09)" ;;
    S11) echo "2026-07-09|2026-07-12|deadline = when + 3 (2026-07-12)" ;;
    S12) echo "2026-07-09|2026-07-06|deadline BEFORE when (2026-07-06)" ;;
    S13) echo "|2026-07-16|a deadline with NO when" ;;
    S14) echo "anytime||anytime (no date, not Inbox)" ;;
    *) echo "" ;;
  esac
}
ALL_STATES="S1 S2 S3 S4 S5 S6 S7 S8 S9 S10 S11 S12 S13 S14"
ALL_FREQS="after-completion daily weekly monthly yearly"

########################################################################
# MATRIX — seed state x frequency, read-only
########################################################################
# One fixture per seed state; the dialog is opened FRESH per frequency and always
# escaped, so no cell can contaminate the next (proven by the `fresh` cell).
matrix_state() {
  local SID="$1" spec when dl desc title U
  spec=$(seed_spec "$SID")
  [ -n "$spec" ] || { note "unknown seed state $SID"; return; }
  when="${spec%%|*}"; spec="${spec#*|}"; dl="${spec%%|*}"; desc="${spec#*|}"
  title="DEF1-$SID$TAGSFX"
  note ""
  note "======== SEED $SID — $desc ========"
  beep_reset
  beep_mark "$SID seed"
  U=$(mkseed "$title" "$when" "$dl")
  if [ -z "$U" ]; then note "  FATAL: seed $title was not created (when='$when' deadline='$dl')"; return; fi
  note "  fixture $title uuid=$U · URL when='${when:-(none)}' deadline='${dl:-(none)}'"
  note "  seed row: $(seedrow "$U")"
  if ! select_item "$U" "$title"; then
    note "  SKIP $SID: the row never became the selection, so Items ▸ Repeat… is not addressable"
    beep_assert "$SID"; return
  fi
  local FRQ
  for FRQ in ${FREQS:-$ALL_FREQS}; do
    note ""
    note "  ---- $SID x $FRQ ----"
    PREV_SHAPE=""
    beep_mark "$SID $FRQ open"
    openrepeat
    if [ "$(dialog_alive)" != "alive" ]; then
      note "    FAIL: no Repeat dialog opened"
      continue
    fi
    local f0; f0=$(shapequiet "$SID-$FRQ-0-open")
    note "    at open (the dialog's own default state):"
    grep -E 'SHELL popup|SHELL checkbox|SHELL field|SHELL datearea|GROUP popup|GROUP field|GROUP datearea' "$f0" | sed 's/^/      /' | tee -a "$REPORT"
    if [ "$FRQ" = "after-completion" ]; then
      # `after completion` IS the opening default; selecting it explicitly is what
      # the shipped recipe does, so the cell drives it the same way and the
      # timeline then shows whether anything recomputes at all.
      note "    --- select frequency = after completion (already the default) ---"
      setfreq_timed "after completion" | sed 's/^/      /' | tee -a "$REPORT"
    else
      note "    --- select frequency = $FRQ ---"
      setfreq_timed "$FRQ" | sed 's/^/      /' | tee -a "$REPORT"
    fi
    beep_mark "$SID $FRQ read"
    local f1; f1=$(shapequiet "$SID-$FRQ-1-selected")
    note "    PRE-FILLED after the selection (pure reads, nothing touched):"
    grep -E 'SHELL popup|SHELL checkbox|SHELL field|SHELL datearea|GROUP popup|GROUP field|GROUP datearea|GROUP static' "$f1" | sed 's/^/      /' | tee -a "$REPORT"
    local d; d=$(diff "$f0" "$f1" | sed 's/^/      /')
    if [ -n "$d" ]; then note "    SHAPE DELTA open -> $FRQ:"; echo "$d" | tee -a "$REPORT"
    else note "    (shape unchanged by the selection)"; fi
    if [ "$FRQ" != "after-completion" ]; then
      note "    Next: menu head (an INPUT — taken last, after every read above):"
      nextitems 2 12 | sed 's/^/      /' | tee -a "$REPORT"
      local f2; f2=$(shapequiet "$SID-$FRQ-2-after-menu")
      d=$(diff "$f1" "$f2" | sed 's/^/      /')
      [ -n "$d" ] && { note "    SHAPE DELTA after opening the menu:"; echo "$d" | tee -a "$REPORT"; }
    fi
    esc
    settle 1
    if [ "$(dialog_alive)" = "alive" ]; then esc; settle 1; fi
    note "    dialog after escape: $(dialog_alive) · app $(alive)"
  done
  note "  seed row AFTER the whole frequency walk (must be unchanged — nothing committed):"
  note "    $(seedrow "$U")"
  note "  rule on the seed: $(rsum "$U")"
  beep_assert "$SID"
}

cell_matrix() {
  note ""
  note "############ MATRIX — seed state x frequency (read-only) ############"
  local s
  for s in ${STATES:-$ALL_STATES}; do matrix_state "$s"; done
}

########################################################################
# FRESH — the independence control the matrix rests on
########################################################################
cell_fresh() {
  note ""
  note "############ FRESH — does an ESCAPED selection persist? ############"
  note "The matrix reuses ONE seed per state across five dialog openings. That is"
  note "only sound if an escaped dialog leaves the row untouched, so the next"
  note "opening seeds itself from the row again rather than from the last session."
  local title="DEF1-FRESH$TAGSFX" U
  beep_reset; beep_mark "fresh seed"
  U=$(mkseed "$title" "2026-07-09" "")
  note "  fixture $title uuid=$U (when=2026-07-09, a Thursday)"
  note "  seed row: $(seedrow "$U")"
  select_item "$U" "$title" || { note "  SKIP: no selection"; return; }
  PREV_SHAPE=""
  beep_mark "fresh open1"
  openrepeat; shapeat "fresh-1-open"
  note "  --- select frequency = monthly, then ESCAPE ---"
  setfreq_timed "monthly" | sed 's/^/      /' | tee -a "$REPORT"
  shapeat "fresh-2-monthly"
  esc; settle 2
  note "  dialog after escape: $(dialog_alive)"
  note "  seed row after the escape: $(seedrow "$U")"
  note "  rule on the seed after the escape: $(rsum "$U")"
  beep_mark "fresh open2"
  PREV_SHAPE=""
  openrepeat; shapeat "fresh-3-reopen"
  note "  ^^ the frequency pop-up above IS the answer: 'after completion' means the"
  note "     escape was clean and every matrix cell is independent; 'monthly' means"
  note "     the dialog remembers and the matrix must mint a seed per frequency."
  esc; settle 1
  [ "$(dialog_alive)" = "alive" ] && esc
  beep_assert "fresh"
}

########################################################################
# TIMING — the recompute, at 100ms resolution
########################################################################
# A minimal recipe replaces actuations with verify-by-read, so its correctness is
# a function of WHEN the pre-fill is complete. This cell measures that directly:
# one frequency click, then the `Next:` pop-up AND the cadence group's own shape
# sampled every 100ms for 3s.
timing_arm() {
  local U="$1" title="$2" FRQ="$3"
  note ""
  note "  ---- timing: $FRQ ----"
  beep_mark "timing $FRQ"
  openrepeat
  [ "$(dialog_alive)" = "alive" ] || { note "    FAIL: no dialog"; return; }
  axq "tell application \"System Events\" to tell process \"Things3\"
  set sh to $SHELL_PATH
  set g to group 1 of sh
  set p to pop up button 1 of sh
  repeat 20 times
    if (exists menu 1 of p) then exit repeat
    click p
    delay 0.3
  end repeat
  set out to \"\"
  click menu item \"$FRQ\" of menu 1 of p
  repeat with i from 1 to 30
    delay 0.1
    set nv to \"(absent)\"
    try
      set nv to (value of pop up button 2 of g) as text
    end try
    set np to (count of pop up buttons of g)
    set nf to (count of text fields of g)
    set ns to (count of static texts of g)
    set out to out & \"t+\" & ((i * 100) as text) & \"ms popups=\" & np & \" fields=\" & nf & \" statics=\" & ns & \" Next=\" & nv & linefeed
  end repeat
  return out
end tell" | sed 's/^/      /' | tee -a "$REPORT"
  esc; settle 1
  [ "$(dialog_alive)" = "alive" ] && { esc; settle 1; }
}

cell_timing() {
  note ""
  note "############ TIMING — when is the pre-fill complete? ############"
  local title="DEF1-TIMING$TAGSFX" U
  beep_reset; beep_mark "timing seed"
  U=$(mkseed "$title" "2026-07-09" "")
  note "  fixture $title uuid=$U (when=2026-07-09, a Thursday) · $(seedrow "$U")"
  select_item "$U" "$title" || { note "  SKIP: no selection"; return; }
  local f
  for f in weekly monthly yearly daily; do timing_arm "$U" "$title" "$f"; done
  beep_assert "timing"

  note ""
  note "  ---- the same, on a DEADLINED seed (deadline = when + 3) ----"
  local t2="DEF1-TIMINGD$TAGSFX" U2
  beep_reset; beep_mark "timingd seed"
  U2=$(mkseed "$t2" "2026-07-09" "2026-07-12")
  note "  fixture $t2 uuid=$U2 · $(seedrow "$U2")"
  select_item "$U2" "$t2" || { note "  SKIP: no selection"; return; }
  for f in weekly monthly; do timing_arm "$U2" "$t2" "$f"; done
  beep_assert "timingd"
}

########################################################################
# COMMIT — the defaults must LAND, not merely display
########################################################################
# open -> select the frequency -> wait out the recompute -> press OK. Nothing
# else is touched: no Next selection, no weekday click, no day-of-month click, no
# interval keystroke, no deadline tick. Whatever lands is what the pre-fill is
# worth to a minimal recipe.
commit_arm() {
  local CID="$1" when="$2" dl="$3" FRQ="$4"
  local title="DEF1-C$CID$TAGSFX" U
  note ""
  note "  ======== COMMIT $CID — when='${when:-(none)}' deadline='${dl:-(none)}' · $FRQ, defaults ACCEPTED ========"
  beep_reset; beep_mark "C$CID seed"
  U=$(mkseed "$title" "$when" "$dl")
  [ -n "$U" ] || { note "    FATAL: no seed"; return; }
  note "    seed uuid=$U · $(seedrow "$U")"
  select_item "$U" "$title" || { note "    SKIP: no selection"; return; }
  PREV_SHAPE=""
  beep_mark "C$CID open"
  openrepeat
  [ "$(dialog_alive)" = "alive" ] || { note "    FAIL: no dialog"; return; }
  shapeat "C$CID-0-open"
  if [ "$FRQ" = "after completion" ]; then
    note "    --- select frequency = after completion (the opening default) ---"
  else
    note "    --- select frequency = $FRQ ---"
  fi
  setfreq_timed "$FRQ" | sed 's/^/      /' | tee -a "$REPORT"
  shapeat "C$CID-1-selected"
  note "    committing WITHOUT touching another control:"
  beep_mark "C$CID commit"
  pressok | sed 's/^/      /' | tee -a "$REPORT"
  settle 8
  local T; T=$(tmplid "$title")
  if [ -z "$T" ]; then
    note "    LANDED: no template row — the commit did not produce a rule"
    note "    row now: $(rsum "$U")"
  else
    note "    LANDED template=$T"
    note "      rule:  $(rsum "$T")"
    note "      insts: $(instrows "$T" | tr '\n' ' ')"
  fi
  note "    app $(alive) · ips=$(ips_count)"
  beep_assert "C$CID"
}

cell_commit() {
  note ""
  note "############ COMMIT — do the pre-filled defaults LAND? ############"
  # One representative per frequency on the canonical seed shape a promote mints
  # (a concrete future `when`), then the deadlined arms.
  commit_arm "AC" "2026-07-09" "" "after completion"
  commit_arm "D"  "2026-07-09" "" "daily"
  commit_arm "W"  "2026-07-09" "" "weekly"
  commit_arm "M"  "2026-07-09" "" "monthly"
  commit_arm "Y"  "2026-07-09" "" "yearly"
  # The 31st: does a monthly rule seeded on the 31st land on "the 31st", "the
  # last day", or something else?
  commit_arm "M31" "2026-08-31" "" "monthly"
  # Deadlined: the offset the maintainer saw pre-filled ("start N days earlier").
  commit_arm "WD" "2026-07-09" "2026-07-12" "weekly"
  commit_arm "MD" "2026-07-09" "2026-07-12" "monthly"
  commit_arm "ACD" "2026-07-09" "2026-07-12" "after completion"
  # Today, and no-when: the two seed shapes whose default cannot be a future date.
  commit_arm "WT" "today" "" "weekly"
  commit_arm "WN" "" "" "weekly"
}

########################################################################
# MENUS — the conversion vocabulary
########################################################################
# A residual-actuation COUNT is only meaningful against the menu the actuation
# has to walk: "switch the ordinal pop-up to `last`" is one gesture iff `last`
# is an item of that pop-up's own menu. This cell dumps every cadence pop-up's
# item list at the settled default state, one pop-up at a time, re-auditing the
# dialog shape after each menu open and close (opening a menu IS an input).
menus_arm() {
  local FRQ="$1"
  note ""
  note "  ---- menus: $FRQ ----"
  beep_mark "menus $FRQ"
  openrepeat
  [ "$(dialog_alive)" = "alive" ] || { note "    FAIL: no dialog"; return; }
  if [ "$FRQ" != "at-open" ]; then
    setfreq_timed "$FRQ" | sed 's/^/      /' | tee -a "$REPORT"
  fi
  local f0; f0=$(shapequiet "menus-$FRQ-0")
  grep -E 'SHELL popup|GROUP popup|GROUP field' "$f0" | sed 's/^/      /' | tee -a "$REPORT"
  # The shell frequency pop-up, then every cadence-group pop-up in turn.
  note "    SHELL popup 1 (frequency) items:"
  axq "tell application \"System Events\" to tell process \"Things3\"
  set pb to pop up button 1 of $SHELL_PATH
  repeat 20 times
    if (exists menu 1 of pb) then exit repeat
    click pb
    delay 0.3
  end repeat
  set nms to name of every menu item of menu 1 of pb
  set out to \"(\" & (count of nms) & \") \"
  repeat with i from 1 to (count of nms)
    set nm to item i of nms
    if nm is missing value then set nm to \"(sep)\"
    set out to out & \"[\" & i & \"] \" & nm & \"  \"
  end repeat
  key code 53
  delay 0.4
  return out
end tell" | sed 's/^/        /' | tee -a "$REPORT"
  local n i
  n=$(axq "tell application \"System Events\" to tell process \"Things3\" to return (count of pop up buttons of group 1 of $SHELL_PATH)")
  note "    cadence group has $n pop-up(s)"
  for i in $(seq 1 "${n:-0}"); do
    note "    GROUP popup $i items:"
    axq "tell application \"System Events\" to tell process \"Things3\"
  set pb to pop up button $i of group 1 of $SHELL_PATH
  set was to (value of pb) as text
  repeat 20 times
    if (exists menu 1 of pb) then exit repeat
    click pb
    delay 0.3
  end repeat
  set nms to name of every menu item of menu 1 of pb
  set out to \"value=\\\"\" & was & \"\\\" (\" & (count of nms) & \" items) \"
  repeat with j from 1 to (count of nms)
    set nm to item j of nms
    if nm is missing value then set nm to \"(sep)\"
    if j <= 40 then set out to out & \"[\" & j & \"] \" & nm & \"  \"
  end repeat
  key code 53
  delay 0.4
  return out
end tell" | sed 's/^/        /' | tee -a "$REPORT"
  done
  local f1; f1=$(shapequiet "menus-$FRQ-1-after")
  local d; d=$(diff "$f0" "$f1" | sed 's/^/      /')
  if [ -n "$d" ]; then note "    SHAPE DELTA after walking every menu (should be none — reads only):"; echo "$d" | tee -a "$REPORT"
  else note "    (shape unchanged by the menu walk — every menu was closed cleanly)"; fi
  esc; settle 1
  [ "$(dialog_alive)" = "alive" ] && { esc; settle 1; }
}

cell_menus() {
  note ""
  note "############ MENUS — the conversion vocabulary ############"
  local title="DEF1-MENUS$TAGSFX" U
  beep_reset; beep_mark "menus seed"
  U=$(mkseed "$title" "2026-07-09" "")
  note "  fixture $title uuid=$U (when=2026-07-09, a Thursday) · $(seedrow "$U")"
  select_item "$U" "$title" || { note "  SKIP: no selection"; return; }
  local f
  for f in at-open daily weekly monthly yearly; do menus_arm "$f"; done
  beep_assert "menus"
  note "  seed row after the whole menu walk (nothing committed): $(seedrow "$U")"
}

########################################################################
# REMIND — does the seed's reminder time reach the rule?
########################################################################
remind_state() {
  local RID="$1" when="$2" desc="$3"
  local title="DEF1-$RID$TAGSFX" U
  note ""
  note "  ======== $RID — $desc ========"
  beep_reset; beep_mark "$RID seed"
  U=$(mkseed "$title" "$when" "")
  [ -n "$U" ] || { note "    FATAL: no seed"; return; }
  note "    seed uuid=$U · $(seedrow "$U")"
  note "    seed row, reminder columns: $(rfull "$U")"
  select_item "$U" "$title" || { note "    SKIP: no selection"; return; }
  local FRQ
  for FRQ in ${FREQS:-after-completion weekly monthly}; do
    note "    ---- $RID x $FRQ (read only) ----"
    beep_mark "$RID $FRQ"
    openrepeat
    [ "$(dialog_alive)" = "alive" ] || { note "      FAIL: no dialog"; continue; }
    local sel="$FRQ"; [ "$FRQ" = "after-completion" ] && sel="after completion"
    setfreq_timed "$sel" | sed 's/^/        /' | tee -a "$REPORT"
    local f; f=$(shapequiet "$RID-$FRQ-selected")
    grep -E 'SHELL popup|SHELL checkbox|SHELL field|SHELL datearea|GROUP popup|GROUP field|GROUP datearea' "$f" | sed 's/^/        /' | tee -a "$REPORT"
    esc; settle 1
    [ "$(dialog_alive)" = "alive" ] && { esc; settle 1; }
  done
  beep_assert "$RID"
}

cell_remind() {
  note ""
  note "############ REMIND — a seed with a reminder time ############"
  note 'The seed is minted as things:///add?when=<date>@<HH:MM> — the same'
  note 'spelling promote-via-clone uses for a one-off reminder on its seed.'
  remind_state "RM1" "2026-07-09@09:30" "a future Thursday at 09:30"
  remind_state "RM2" "today@18:00" "today at 18:00"
  # ...and the commit proof: accept the defaults and see whether a reminder is on
  # the landed rule, on the template row, or nowhere.
  note ""
  note "  ---- COMMIT the reminder arms untouched ----"
  commit_arm "RM3" "2026-07-09@09:30" "" "weekly"
  commit_arm "RM4" "2026-07-09@09:30" "" "after completion"
  note "  full decode of the two reminder commits:"
  local T
  for T in RM3 RM4; do
    local U; U=$(tmplid "DEF1-C$T$TAGSFX")
    [ -n "$U" ] || U=$(anyid "DEF1-C$T$TAGSFX")
    note "    C$T template/row $U:"
    rfull "$U" | sed 's/^/      /' | tee -a "$REPORT"
    local I; I=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$U' AND trashed=0 LIMIT 1")
    if [ -n "$I" ]; then
      note "    C$T first instance $I:"
      rfull "$I" | sed 's/^/      /' | tee -a "$REPORT"
    fi
  done
}

########################################################################
# PARTIAL — the residual-actuation matrix
########################################################################
# A seed date cannot express every rule shape the CLI supports. What it CAN do is
# get close, and the value of the pre-fill is then the actuations it removes from
# the remainder. Each seed below is chosen so that the shape it ALMOST expresses
# is one the CLI has a flag for.
partial_state() {
  local PID="$1" when="$2" desc="$3" freqs="$4"
  local title="DEF1-$PID$TAGSFX" U
  note ""
  note "  ======== $PID — $desc ========"
  beep_reset; beep_mark "$PID seed"
  U=$(mkseed "$title" "$when" "")
  [ -n "$U" ] || { note "    FATAL: no seed"; return; }
  note "    seed uuid=$U · $(seedrow "$U")"
  select_item "$U" "$title" || { note "    SKIP: no selection"; return; }
  local FRQ
  for FRQ in $freqs; do
    note "    ---- $PID x $FRQ ----"
    beep_mark "$PID $FRQ"
    openrepeat
    [ "$(dialog_alive)" = "alive" ] || { note "      FAIL: no dialog"; continue; }
    setfreq_timed "$FRQ" | sed 's/^/        /' | tee -a "$REPORT"
    local f; f=$(shapequiet "$PID-$FRQ-selected")
    grep -E 'SHELL popup|SHELL checkbox|SHELL field|SHELL datearea|GROUP popup|GROUP field|GROUP static' "$f" | sed 's/^/        /' | tee -a "$REPORT"
    esc; settle 1
    [ "$(dialog_alive)" = "alive" ] && { esc; settle 1; }
  done
  beep_assert "$PID"
}

cell_partial() {
  note ""
  note "############ PARTIAL — what a seed ALMOST expresses ############"
  # 2026-08-31 is a Monday, the 31st, AND the last day of August — it is also the
  # 5th Monday of the month, so it probes three shapes at once.
  partial_state "P31" "2026-08-31" "the 31st = the last day of August (a Monday, its 5th)" "monthly yearly"
  # 2026-09-30 is a Wednesday and the last day of September, but not a 31st.
  partial_state "P30" "2026-09-30" "the 30th = the last day of September (a Wednesday)" "monthly"
  # 2026-08-03 is the FIRST Monday of August 2026 (Aug 1 is a Saturday).
  partial_state "PFM" "2026-08-03" "the first Monday of August 2026" "monthly"
  # 2026-08-28 is the LAST Friday of August 2026.
  partial_state "PLF" "2026-08-28" "the last Friday of August 2026" "monthly"
  # 2026-02-28 is the last day of a NON-leap February (a Saturday).
  partial_state "PFEB" "2026-02-28" "the last day of a non-leap February (a Saturday)" "monthly yearly"
  note ""
  note "  The residual actuation for each shape is derived in the campaign doc"
  note "  §Recommendation against the pop-up menus dumped by the `menus` cell."
}

########################################################################
# BASELINE — the BEFORE numbers, measured rather than assumed
########################################################################
# RDLAT2 §5 counted the field's own `--after-completion` shape (13 hops / 88
# round-trips / 34 elements). The shapes this campaign's recommendation acts on
# are the ANCHOR-BEARING ones, which RDLAT2 never traced — so the before-counts
# for them are measured here, through the SHIPPED CLI, with the trace on.
#
# Needs the CLI bundle on the guest: run with SHIP=all (the default) at least
# once. `helpers-enabled` must be false for the AX round-trip counter (RDLAT2
# §1), and the element counter needs only THINGS_API_TRACE.
cell_baseline() {
  note ""
  note "############ BASELINE — the shipped drive, traced ############"
  if [ ! -f dist/cli/main.js ]; then note "  FATAL: dist missing — run npm run build"; return; fi
  local NODE_BIN COMMANDER_DIR
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO() { local a c; for a in 1 2 3 4 5; do sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; c=$?; [ "$c" -eq 0 ] && return 0; sleep 3; done; return "$c"; }
  if [ "${SHIP:-all}" != "0" ]; then
    note "  shipping the CLI bundle (node + dist + commander)…"
    scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null || { note "  FATAL node scp"; return; }
    COMMANDER_DIR=$(node -e "const p=require.resolve('commander'); console.log(p.slice(0, p.indexOf('/node_modules/commander/')+'/node_modules/commander'.length))")
    scpO -r "$COMMANDER_DIR" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null || { note "  FATAL commander scp"; return; }
    scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
    lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
    scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  fi
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  local CLI="~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js"
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
  lab_ssh "$IP" "$CLI config set helpers-enabled false" </dev/null >/dev/null 2>&1
  mkdir -p "$OUT/trace" "$OUT/drive"

  # The drive leg is traced through `make-repeating` on a seed this driver minted
  # itself — the same two legs a promote composite runs (URL seed, then the
  # dialog), but with the seed OUTSIDE the traced invocation, so the numbers are
  # directly comparable to RDLAT2 §5's `make-repeating` reference.
  baseline_arm() {
    local BID="$1" seedwhen="$2" seeddl="$3"; shift 3
    local title="DEF1-B$BID$TAGSFX" U
    note ""
    note "  ---- baseline $BID: seed when='${seedwhen:-(none)}' deadline='${seeddl:-(none)}' · things todo make-repeating $* ----"
    beep_reset; beep_mark "B$BID"
    dismiss_alerts
    U=$(mkseed "$title" "$seedwhen" "$seeddl") || { note "    FATAL: no seed"; return; }
    note "    seed uuid=$U · $(seedrow "$U")"
    lab_ssh "$IP" 'rm -rf ~/.local/state/things-api/trace' </dev/null
    lab_ssh "$IP" "THINGS_API_TRACE=true THINGS_API_AX_COUNT=1 $LAB_DIRECT $CLI todo make-repeating $U $* --dangerously-drive-gui --json" \
      </dev/null >"$OUT/drive/B$BID.log" 2>&1
    local rc=$?
    note "    exit $rc · verdict: $(grep -o -e '"ok":[a-z]*' -e '"status":"[a-z-]*"' "$OUT/drive/B$BID.log" | head -3 | tr '\n' ' ')"
    local T; T=$(tmplid "$title")
    note "    landed: $(rsum "${T:-none}")"
    local TF; TF=$(lab_ssh "$IP" 'cd ~/.local/state/things-api/trace 2>/dev/null && ls -t | head -1' </dev/null | tr -d '\r\n')
    if [ -n "$TF" ]; then
      lab_ssh "$IP" "cat ~/.local/state/things-api/trace/$(printf '%q' "$TF")" </dev/null > "$OUT/trace/B$BID.jsonl" 2>/dev/null
      node lab/scripts/rdlat2-table.mjs "$OUT/trace/B$BID.jsonl" "B$BID" | tee -a "$REPORT"
    else
      note "    NO trace file"
    fi
    beep_assert "B$BID"
  }

  # B0 reproduces the RDLAT2 §5 reference shape, so the two campaigns' numbers
  # can be read against each other on the same golden.
  baseline_arm 0 "" "" --frequency monthly --interval 1 --after-completion
  # The anchor-bearing shapes the recommendation acts on. The seed carries the
  # same `when` the rule asks for, exactly as promote-via-clone mints it.
  baseline_arm W 2026-07-09 "" --when 2026-07-09 --frequency weekly --interval 1
  baseline_arm M 2026-07-09 "" --when 2026-07-09 --frequency monthly --interval 1
  baseline_arm Y 2026-07-09 "" --when 2026-07-09 --frequency yearly --interval 1
  # Deadlined: the seed stays deadline-FREE, which is what the shipped composite
  # does (mapDeadlineOntoRule keeps the deadline on the RULE — DBLSPAWN1).
  baseline_arm WD 2026-07-09 "" --when 2026-07-09 --deadline --start-days-earlier 3 --frequency weekly --interval 1
  baseline_arm MD 2026-07-09 "" --when 2026-07-09 --deadline --start-days-earlier 3 --frequency monthly --interval 1
  # interval > 1 is the one cadence field a seed can never pre-fill — traced so
  # the typing hop's own cost is on the record beside the interval=1 case.
  baseline_arm M3 2026-07-09 "" --when 2026-07-09 --frequency monthly --interval 3
}

########################################################################
for c in $CELLS; do
  case "$c" in
    matrix) cell_matrix ;;
    baseline) cell_baseline ;;
    fresh) cell_fresh ;;
    timing) cell_timing ;;
    commit) cell_commit ;;
    menus) cell_menus ;;
    remind) cell_remind ;;
    partial) cell_partial ;;
    *) note "unknown cell: $c" ;;
  esac
done
note ""
note "report: $REPORT · shapes: $OUT/ax/"
