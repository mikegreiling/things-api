#!/bin/bash
# DEFAULTS2 — BUILD the minimal recipe: the drive READS what the dialog already
# holds, and drives only the residual.
#
# DEFAULTS1 (#689, docs/lab/defaults1-repeat-dialog-defaults.md) measured the law
# and changed nothing in src/: the Repeat dialog derives its entire cadence row
# from ONE date on the row it opened over — `max(the row's scheduled date,
# today)` — and 11/11 commit cells landed a rule blob byte-equivalent to the one
# the full drive produces by clicking every control. Our own CLI MINTS that row,
# so every control whose pre-fill is already correct is an actuation that can
# become a read. This is the build, and this driver is its certification.
#
# WHAT SHIPPED
#   src/write/vectors/ui-prefill.ts   the law as arithmetic: which controls a
#                                     given seed PROVES, version-keyed like the
#                                     shape manifest, with an off switch
#                                     (THINGS_API_PREFILL=0)
#   ui-recipes.ts                     each provable setter TAGGED and a single
#                                     verify-by-read hop spliced in after the
#                                     shape probe; the audit still derives from
#                                     every setter, tagged or not
#   ui.ts                             the verify hop's two read legs (System
#                                     Events + the ObjC date-area bridge) and the
#                                     driver's skip / fallback ledger
#   promote-clone.ts                  SEED SHAPING: a deadlined rule's seed is
#                                     scheduled ON THE DUE DATE and stays
#                                     deadline-free (DEFAULTS1 §9.3 option B)
#
# CELLS
#   clamp     THE MAINTAINER'S CORRECTION, measured. Observed on 3.23.2: the
#             pre-filled "start N days earlier" is FREQUENCY-DEPENDENT — a fixed
#             cadence preserves a far-future offset while `after completion`
#             CLAMPS it. after-completion unit x interval x seed deadline offset,
#             read; then a value ABOVE the clamp is TYPED and committed, and the
#             landed rule decoded, to say whether the clamp is a pre-fill
#             heuristic or a hard rule. Fixed-cadence arms at 30 and 45 days
#             confirm there is no clamp there.
#   baseline  the shipped CLI with THINGS_API_PREFILL=0 — the drive as it stood
#             on the post-#687 bundle, traced (hops / round-trips / elements).
#             DEFAULTS1's own `baseline` cell, re-run as its §9.1 note asks.
#   after     the same arms with the reliance LIVE, traced. The two together are
#             the measured before/after.
#   states    the 5-state matrix + the deadlined and reminder arms, each run BOTH
#             ways, with the landed rule blobs compared byte for byte.
#   mismatch  a deliberately WRONG pre-fill (a seed the shaping refuses to move,
#             so the dialog anchors somewhere the rule did not ask for): the
#             verify hop must MISS and the certified setter must engage.
#   refuse    the pre-dispatch refusals: oddities §31 (a deadline preceding the
#             start) and a negative offset.
#   teardown  stop + delete the clone (the EXIT trap does this anyway unless KEEP=1)
#   cells     the guard cells the change must not have weakened (FGRD1 U/C2/S/T
#             + MODALX1 X) and the window/focus census 2x2 (RDLAT2 census law).
#
# METHOD: ONE disposable clone `defaults2-lab` of things-lab-golden-v4 (the
# golden is NEVER booted). Airgapped (default route deleted), guest clock pinned
# to 2026-07-05 12:00 BEFORE Things launches (trial wall 2026-07-18, never
# rolled), synthetic DEF2-* fixtures only. Ground truth = read-only guest SQLite
# via the rsum.py/rfull.py blob decoders; `open` exit 0 and CLI exit 0 prove
# nothing. Beeps counted by the guest sentinel (research driver: report-only).
# Teardown on EXIT (KEEP=1 to hold the clone, REUSE=1 to re-attach).
#
# REPRODUCIBILITY: a clone is ~200x cheaper per element realized than the field
# and CANNOT reproduce field wall times (RDLAT2 §E's corollary). What transfers
# is ROUND-TRIPS, ELEMENTS, hop counts and which controls were driven.
#
# Usage:  bash lab/scripts/research-defaults2.sh [cell...]   # default: clamp
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="defaults2-lab"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
CELLS="${*:-clamp}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax" "$OUT/trace" "$OUT/drive"
REPORT="$OUT/report.txt"
REUSE="${REUSE:-0}"
KEEP="${KEEP:-0}"
TAGSFX="${TAGSFX:-}"
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[defaults2] $*" | tee -a "$REPORT"; }
notef() { echo "[defaults2] $*" >>"$REPORT"; echo "[defaults2] $*" >&2; }

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
  RUNNING=$(tart list | awk 'NR>1 && $NF=="running" {print $2}' | tr '\n' ' ')
  [ -n "$RUNNING" ] && { note "FATAL: another VM is running ($RUNNING) — never a second concurrent clone"; exit 1; }
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 420) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"
fi
cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — $VM left running at $IP"; return; fi
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "teardown done · remaining VMs: $(tart list | tail -n +2 | awk '{print $2}' | tr '\n' ' ')"
}
trap cleanup EXIT

if [ "$REUSE" != "1" ]; then
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  note "airgap: $AG"; [ "$AG" = "AIRGAP-OK" ] || exit 1
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
  GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
  note "AX grant=$GRANT (want 2)"; [ "$GRANT" = "2" ] || { note "FATAL: AX grant"; exit 1; }
fi
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null

lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-noheader -list); if [ "$1" = "-t" ]; then FMT=(-header -column); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF

# The rule-blob decoder (rsum.py, as DEFAULTS1/NEXTPOP1/CNCAC1 use it).
lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationCount, deadline, rt1_instanceCreationStartDate, rt1_instanceCreationPaused, startDate, start, status, rt1_repeatingTemplate, reminderTime FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row: print("NO-ROW"); sys.exit(0)
tail=" | ROW startDate=%s start=%s status=%s tmpl=%s deadline=%s reminderTime=%r"%(dpk(row[6]),row[7],row[8],(row[9] or "-"),dpk(row[3]) if row[3] else row[3],row[10])
if row[0] is None: print("NO-RULE paused=%s%s"%(row[5],tail)); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s ed=%s of=[%s] next=%s icStart=%s icCount=%s paused=%s%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),d.get('ed'),",".join(offs),
    dpk(row[1]),dpk(row[4]),row[2],row[5],tail))
EOF

lab_scp lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/labh/beep-sentinel.sh" >/dev/null
lab_ssh "$IP" 'chmod +x ~/labh/beep-sentinel.sh' </dev/null
beep_reset() { lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null 2>&1; }
beep_mark()  { lab_ssh "$IP" "~/labh/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }
beep_assert() {
  lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/labh/beep-sentinel.sh assert --name $(printf '%q' "$1")" \
    </dev/null 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
}

gq() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; pkill -x Things3 >/dev/null 2>&1; sleep 2; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }
warm
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
DBV=$(gq "SELECT value FROM Meta WHERE key='databaseVersion'" 2>/dev/null)
note "env: Things $TVER ($TBLD) · macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) · dbv ${DBV:-?} · clock $(lab_ssh "$IP" date </dev/null)"

# ---- shared helpers (lifted from the DEFAULTS1 driver) ---------------------
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
settle() { lab_ssh "$IP" "sleep ${1:-2}" </dev/null; }
alive() { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null; }
ips_count() { lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3*.ips 2>/dev/null | wc -l | tr -d " "' </dev/null; }
rsum() { lab_ssh "$IP" "python3 ~/labh/rsum.py '$1' 2>&1" </dev/null; }
tmplid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
anyid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
ruleblob() { gq "SELECT quote(rt1_recurrenceRule) FROM TMTask WHERE uuid='$1'"; }
seedrow() {
  gq "SELECT 'startDate='||IFNULL(startDate,'NULL')||' start='||start||' startBucket='||startBucket||' deadline='||IFNULL(deadline,'NULL')||' reminderTime='||IFNULL(reminderTime,'NULL') FROM TMTask WHERE uuid='$1'"
}

SHELL_PATH='sheet 1 of (first window whose subrole is "AXStandardWindow")'

# mkseed <title> <when-or-empty> <deadline-or-empty> -> uuid
#
# THE ASSIGNMENTS ARE SPLIT, AND THAT IS THE WHOLE POINT (§rig). The inherited
# spelling — `local title="$1" … url="…title=$title…"` — expands `$title` while
# `title` is still the CALLER's, because bash expands a `local` command's word
# list before it performs any of the assignments and its scoping is dynamic. A
# caller that happens to have its own `local title` therefore silently seeds the
# WRONG TITLE, and a caller that has none dies with `title: unbound variable`
# under `set -u`.
#
# This is the root cause of DEFAULTS1 §11.2's "unexplained seeding anomaly", and
# the evidence there fits it exactly: `cell_timing` mints `DEF1-TIMING2` into a
# local named `title`, then calls `mkseed "$t2"` for `DEF1-TIMINGD2` — and the
# three rows it got carried the title `DEF1-TIMING2` WITH the requested deadline,
# which is precisely the url that spelling builds. The app was doing as it was
# told. (DEFAULTS1 is an immutable snapshot and is not edited; the correction is
# recorded in this campaign's own doc.)
mkseed() {
  local title="$1"
  local when="$2"
  local dl="$3"
  local u i
  local url="things:///add?title=$title&auth-token=$TOKEN"
  [ -n "$when" ] && url="$url&when=$when"
  [ -n "$dl" ] && url="$url&deadline=$dl"
  # An empty read-back is not merely a missing fixture: it poisons the whole
  # clone downstream, because `things:///show?id=` with an empty id raises a
  # modal sheet that then swallows every later menu press (DEFAULTS1 §11.1).
  for i in 1 2 3 4; do
    lab_ssh "$IP" "open -g '$url'; sleep 4" </dev/null
    u=$(anyid "$title")
    [ -n "$u" ] && { echo "$u"; return 0; }
    # SAY WHAT THE APP DID CREATE, not just that the row is missing. A dispatched
    # add that lands under a DIFFERENT title is the signature of the §rig bug
    # above, and "no row" hides it; the row census names it in one line.
    notef "  mkseed '$title' attempt $i read back no row; the last 3 rows created are:"
    notef "    $(gq "SELECT title||' sb='||startBucket||' cd='||CAST(creationDate AS INT) FROM TMTask WHERE trashed=0 ORDER BY rowid DESC LIMIT 3" | tr '\n' ' ')"
    lab_ssh "$IP" "sleep $((i * 3))" </dev/null
  done
  return 1
}

# Dismiss any NON-Repeat modal sheet standing on a Things window (DEFAULTS1
# §11.1 — a window census cannot see a sheet, so this walks for them and presses
# their own button rather than blind-escaping the dialog a cell is driving).
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
  case "$r" in "no stray sheet") ;; *) note "    !! $r" ;; esac
}

select_item() {
  local uuid="$1" want="$2" i sel
  if [ -z "$uuid" ]; then
    notef "  select_item REFUSED: empty uuid for '$want'"
    return 1
  fi
  dismiss_alerts
  for i in 1 2 3 4 5; do
    lab_ssh "$IP" "open -g 'things:///show?id=$uuid'; sleep 3" </dev/null
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
    sel=$(axq 'tell application "Things3" to get name of selected to dos' 2>/dev/null)
    [ "$sel" = "$want" ] && return 0
    notef "  selection attempt $i -> '$sel' (want '$want')"
  done
  return 1
}

dialog_alive() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  try
    if (exists $SHELL_PATH) then return \"alive\"
  end try
  return \"gone\"
end tell"
}
openrepeat() {
  dismiss_alerts
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  settle 3
  if [ "$(dialog_alive)" != "alive" ]; then
    note "    !! the Repeat dialog did not open — sheet census: $(axq "tell application \"System Events\" to tell process \"Things3\"
  set out to \"\"
  repeat with w in windows
    set out to out & \"win(\" & (name of w) & \" sheets=\" & (count of sheets of w) & \") \"
  end repeat
  return out
end tell" | tr -d '\n')"
    return 1
  fi
  return 0
}
esc() { axq 'tell application "System Events" to key code 53' >/dev/null; settle 1; }
pressok() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  click button \"OK\" of $SHELL_PATH
  delay 2
  return \"OK pressed\"
end tell"
}

# ---- the clamp cell's own readers ------------------------------------------
#
# THE DEADLINE ROW, read from the SHELL: `[and start] [ N ] [days earlier]` is a
# shell-level text field minted by the "Add deadlines" checkbox (CGRD1 §B: the
# shell carries 0 direct text fields with deadlines OFF and exactly 1 with them
# ON), so both halves are read together and neither is touched.
readdl() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set sh to $SHELL_PATH
  set cbv to \"?\"
  try
    set cbv to (value of checkbox \"Add deadlines\" of sh) as text
  end try
  set ofsv to \"(no field)\"
  try
    if (count of text fields of sh) > 0 then set ofsv to (value of text field 1 of sh) as text
  end try
  set freq to \"?\"
  try
    set freq to (value of pop up button 1 of sh) as text
  end try
  set unit to \"(none)\"
  set iv to \"(none)\"
  try
    set unit to (value of pop up button 1 of group 1 of sh) as text
  end try
  try
    set iv to (value of text field 1 of group 1 of sh) as text
  end try
  return \"freq=\" & freq & \" unit=\" & unit & \" interval=\" & iv & \" addDeadlines=\" & cbv & \" startEarlier=\" & ofsv
end tell"
}

# setpop <element-spec> <item> — open a pop-up (self-healing, never a second
# click into a menu that is opening — BEEP1) and click the named item.
setpop() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set p to $1
  repeat 20 times
    if (exists menu 1 of p) then exit repeat
    click p
    delay 0.3
  end repeat
  if not (exists menu item \"$2\" of menu 1 of p) then
    set nms to (name of every menu item of menu 1 of p) as text
    key code 53
    return \"NO-ITEM \\\"$2\\\": \" & nms
  end if
  click menu item \"$2\" of menu 1 of p
  delay 1.2
  return (value of p) as text
end tell"
}

# setpopany <element-spec> <item...> — click the FIRST candidate item that
# exists. The after-completion unit pop-up PLURALIZES by interval (`week` at 1,
# `weeks` above it — 0-and-a-half defect (c)), so a cell that walks intervals must
# offer both spellings or it stops reading exactly where the interval moves.
setpopany() {
  local spec="$1"; shift
  local cands="" c
  for c in "$@"; do cands="$cands, \"$c\""; done
  cands="{${cands#, }}"
  axq "tell application \"System Events\" to tell process \"Things3\"
  set p to $spec
  repeat 20 times
    if (exists menu 1 of p) then exit repeat
    click p
    delay 0.3
  end repeat
  repeat with nm in $cands
    if (exists menu item (nm as text) of menu 1 of p) then
      click menu item (nm as text) of menu 1 of p
      delay 1.2
      return (value of p) as text
    end if
  end repeat
  set nms to (name of every menu item of menu 1 of p) as text
  key code 53
  return \"NO-ITEM: wanted \" & (my aqJoin($cands, \"/\")) & \", menu offers \" & nms
end tell

on aqJoin(lst, sep)
  set out to \"\"
  repeat with x in lst
    if out is not \"\" then set out to out & sep
    set out to out & (x as text)
  end repeat
  return out
end aqJoin"
}

# settf <element-spec> <value> — type into a numeric field, read it back.
settf() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set f to $1
  set focused of f to true
  delay 0.4
  keystroke \"a\" using command down
  delay 0.2
  keystroke \"$2\"
  delay 0.3
  keystroke tab
  delay 1.2
  return (value of f) as text
end tell"
}

########################################################################
# CLAMP — the maintainer's correction, measured
########################################################################
# Observed on Things 3.23.2: the pre-filled "start N days earlier" is
# FREQUENCY-DEPENDENT. With a far-future deadline on the row, a fixed cadence
# preserves the full offset (~30 days) while `after completion` shows a much
# smaller number (~6-7), and switching back to weekly restores the 30. So
# DEFAULTS1 §4's "pre-fills the offset INCLUDING under after-completion" is true
# only up to a clamp. Two hypotheses to separate: the clamp is the
# after-completion interval expressed in DAYS (1 week -> 7), or a start cannot
# precede the item's own creation.
#
# Every read here is a READ: the dialog is escaped, never committed, except in
# the `typed` arm which exists precisely to ask whether the clamp survives a
# commit.
CLAMP_OFFSETS="${CLAMP_OFFSETS:-3 7 8 14 30 45}"
CLAMP_UNITS="${CLAMP_UNITS:-day|1 day|3 week|1 week|2 month|1 year|1}"

# The pinned clock is 2026-07-05; every seed starts 2026-07-09 (a Thursday).
CLAMP_START="2026-07-09"
plusdays() { python3 -c "import datetime,sys; print((datetime.date.fromisoformat(sys.argv[1])+datetime.timedelta(days=int(sys.argv[2]))).isoformat())" "$1" "$2"; }

cell_clamp() {
  note ""
  note "############ CLAMP — is the offset pre-fill frequency-dependent? ############"
  note "  seed start=$CLAMP_START · offsets: $CLAMP_OFFSETS · after-completion units: $CLAMP_UNITS"
  local off dl title U unit iv spec r
  for off in $CLAMP_OFFSETS; do
    dl=$(plusdays "$CLAMP_START" "$off")
    title="DEF2-CL$off$TAGSFX"
    note ""
    note "  ======== seed offset $off days (start $CLAMP_START, deadline $dl) ========"
    beep_reset; beep_mark "clamp $off"
    U=$(mkseed "$title" "$CLAMP_START" "$dl") || { note "    FATAL: no seed"; continue; }
    note "    seed uuid=$U · $(seedrow "$U")"
    select_item "$U" "$title" || { note "    FATAL: no selection"; continue; }

    # (a) THE OPENING STATE — after completion, every 1 week, untouched.
    openrepeat || continue
    note "    open (after completion default): $(readdl)"
    # (b) EVERY after-completion unit x interval, read in one dialog: the unit and
    #     the interval are the only things touched, and the offset is read after
    #     each — so a clamp that tracks the interval is visible as it moves.
    # UNIT FIRST, THEN THE INTERVAL — measured, not stylistic. With the interval
    # typed first, the pop-up click that followed was SWALLOWED every time (the
    # unit never moved and the beep count trebled): the field is still committing
    # its keystroke when the click arrives, which is VOPAT2 §5.2's swallowed-click
    # class arriving from a third direction. Unit first also means the pop-up may
    # be showing EITHER spelling when it is opened, which is what setpopany is for.
    for spec in $CLAMP_UNITS; do
      unit="${spec%%|*}"; iv="${spec#*|}"
      r=$(setpopany "pop up button 1 of group 1 of $SHELL_PATH" "$unit" "${unit}s")
      case "$r" in NO-ITEM*) note "      unit=$unit -> $r"; continue ;; esac
      settf "text field 1 of group 1 of $SHELL_PATH" "$iv" >/dev/null
      note "      after-completion every $iv $unit: $(readdl)"
    done
    # (c) BACK TO A FIXED CADENCE, in the same dialog — the maintainer's own
    #     observation was that switching back RESTORES the full offset.
    for unit in weekly monthly yearly; do
      r=$(setpop "pop up button 1 of $SHELL_PATH" "$unit")
      case "$r" in NO-ITEM*) note "      freq=$unit -> $r"; continue ;; esac
      note "      fixed $unit: $(readdl)"
    done
    # (d) …and back to after completion, to prove the clamp is a function of the
    #     STATE rather than of the order the dialog was driven in.
    r=$(setpop "pop up button 1 of $SHELL_PATH" "after completion")
    note "      back to after completion: $(readdl)"
    esc
    note "    seed after the escape: $(seedrow "$U") (expect unchanged, no rule)"
    note "    rule after the escape: $(rsum "$U")"
    beep_assert "clamp $off"
  done

  # (e) IS THE CLAMP A PRE-FILL HEURISTIC OR A HARD RULE? Type a value well above
  #     it and COMMIT. Three possible answers and the decoded rule tells them
  #     apart: the typed value lands (heuristic), the app clamps it on commit
  #     (silent change -> an oddity), or the commit refuses (a hard rule).
  note ""
  note "  ======== typed-above-the-clamp, committed ========"
  local TOFF="${CLAMP_TYPED:-30}"
  for spec in "week|1" "day|3"; do
    unit="${spec%%|*}"; iv="${spec#*|}"
    dl=$(plusdays "$CLAMP_START" "$TOFF")
    title="DEF2-CLT-$unit$iv$TAGSFX"
    beep_reset; beep_mark "clamp typed $unit$iv"
    U=$(mkseed "$title" "$CLAMP_START" "$dl") || { note "    FATAL: no seed"; continue; }
    select_item "$U" "$title" || { note "    FATAL: no selection"; continue; }
    openrepeat || continue
    setpopany "pop up button 1 of group 1 of $SHELL_PATH" "$unit" "${unit}s" >/dev/null
    settf "text field 1 of group 1 of $SHELL_PATH" "$iv" >/dev/null
    note "    after completion every $iv $unit, pre-filled: $(readdl)"
    note "    typed startEarlier=$TOFF -> $(settf "text field 1 of $SHELL_PATH" "$TOFF")"
    note "    before OK: $(readdl)"
    note "    $(pressok)"
    settle 3
    local T; T=$(tmplid "$title")
    note "    landed (template ${T:-none}): $(rsum "${T:-$U}")"
    note "    ^ ts is the landed offset; compare against the typed $TOFF"
    beep_assert "clamp typed $unit$iv"
  done

  # (f) AND THE FIXED CADENCES AT A FAR-FUTURE OFFSET — is there ANY clamp there?
  note ""
  note "  ======== fixed cadence at 30 and 45 days, committed ========"
  for off in 30 45; do
    dl=$(plusdays "$CLAMP_START" "$off")
    title="DEF2-CLF$off$TAGSFX"
    beep_reset; beep_mark "clamp fixed $off"
    U=$(mkseed "$title" "$CLAMP_START" "$dl") || { note "    FATAL: no seed"; continue; }
    select_item "$U" "$title" || { note "    FATAL: no selection"; continue; }
    openrepeat || continue
    setpop "pop up button 1 of $SHELL_PATH" "weekly" >/dev/null
    note "    weekly, pre-filled: $(readdl)"
    note "    $(pressok)"
    settle 3
    local T; T=$(tmplid "$title")
    note "    landed (template ${T:-none}): $(rsum "${T:-$U}")"
    note "    ^ expect ts = -$off if the fixed cadence preserves the full offset"
    beep_assert "clamp fixed $off"
  done
  note ""
  note "  crash=$(alive) ips=$(ips_count)"
}

########################################################################
# the shipped CLI, both ways
########################################################################
ship_cli() {
  if [ ! -f dist/cli/main.js ]; then note "  FATAL: dist missing — run npm run build"; return 1; fi
  local NODE_BIN COMMANDER_DIR
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO() { local a c; for a in 1 2 3 4 5; do sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; c=$?; [ "$c" -eq 0 ] && return 0; sleep 3; done; return "$c"; }
  if [ "${SHIP:-all}" != "0" ]; then
    note "  shipping the CLI bundle (node + dist + commander)…"
    scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null || { note "  FATAL node scp"; return 1; }
    COMMANDER_DIR=$(node -e "const p=require.resolve('commander'); console.log(p.slice(0, p.indexOf('/node_modules/commander/')+'/node_modules/commander'.length))")
    scpO -r "$COMMANDER_DIR" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null || { note "  FATAL commander scp"; return 1; }
    scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
    lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
    scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  fi
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  CLI="~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js"
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
  lab_ssh "$IP" "$CLI config set helpers-enabled false" </dev/null >/dev/null 2>&1
  note "  cli: $(lab_ssh "$IP" "$CLI --version" </dev/null 2>&1 | tail -1)"
  return 0
}

# TAG=off -> the drive as it stood before this campaign (THINGS_API_PREFILL=0);
# TAG=on  -> the reliance live. A fallback that cannot be selected cannot be
# certified, which is why every arm below runs both ways.
tag_env() {
  case "$1" in
    off) echo "THINGS_API_PREFILL=0" ;;
    on)  echo "" ;;
    *) echo "TAG must be on|off" >&2; return 1 ;;
  esac
}

# trace_arm <tag> <id> <seed-when> <seed-deadline> -- <cli args...>
trace_arm() {
  local TAG="$1" AID="$2" seedwhen="$3" seeddl="$4"; shift 4
  local title="DEF2-$TAG-$AID$TAGSFX" U rc TF ENVV
  ENVV=$(tag_env "$TAG") || return
  note ""
  note "  ---- $TAG/$AID: seed when='${seedwhen:-(none)}' dl='${seeddl:-(none)}' · make-repeating $* ----"
  beep_reset; beep_mark "$TAG-$AID"
  warm
  dismiss_alerts
  U=$(mkseed "$title" "$seedwhen" "$seeddl") || { note "    FATAL: no seed"; return; }
  note "    seed uuid=$U · $(seedrow "$U")"
  lab_ssh "$IP" 'rm -rf ~/.local/state/things-api/trace' </dev/null
  lab_ssh "$IP" "THINGS_API_TRACE=true THINGS_API_AX_COUNT=1 $ENVV $LAB_DIRECT $CLI todo make-repeating $U $* --dangerously-drive-gui --verify-timeout 90000 --json" \
    </dev/null >"$OUT/drive/$TAG-$AID.log" 2>&1
  rc=$?
  note "    exit $rc · verdict: $(grep -o -e '"ok":[a-z]*' -e '"status":"[a-z-]*"' "$OUT/drive/$TAG-$AID.log" | head -3 | tr '\n' ' ')"
  local T; T=$(tmplid "$title")
  note "    landed: $(rsum "${T:-none}")"
  note "    blob:   $(ruleblob "${T:-none}")"
  TF=$(lab_ssh "$IP" 'cd ~/.local/state/things-api/trace 2>/dev/null && ls -t | head -1' </dev/null | tr -d '\r\n')
  if [ -n "$TF" ]; then
    lab_ssh "$IP" "cat ~/.local/state/things-api/trace/$(printf '%q' "$TF")" </dev/null > "$OUT/trace/$TAG-$AID.jsonl" 2>/dev/null
    node lab/scripts/rdlat2-table.mjs "$OUT/trace/$TAG-$AID.jsonl" "$TAG-$AID" | tee -a "$REPORT"
    # THE PRE-FILL LEDGER, per drive: which keys the read confirmed, which it
    # missed, and every setter that was therefore skipped.
    note "    prefill ledger + hop/round-trip/element totals:"
    python3 lab/scripts/defaults2-ledger.py "$OUT/trace/$TAG-$AID.jsonl" | sed 's/^/      /' | tee -a "$REPORT"
  else
    note "    NO trace file"
  fi
  beep_assert "$TAG-$AID"
  dismiss_alerts
}

# The arm table — DEFAULTS1 §9.1's own baseline shapes, plus a reminder arm.
# The seed carries the same `when` the rule asks for, exactly as
# promote-via-clone mints it.
run_arms() {
  local TAG="$1"
  trace_arm "$TAG" 0 "" "" --frequency monthly --interval 1 --after-completion
  trace_arm "$TAG" W 2026-07-09 "" --when 2026-07-09 --frequency weekly --interval 1
  trace_arm "$TAG" M 2026-07-09 "" --when 2026-07-09 --frequency monthly --interval 1
  trace_arm "$TAG" Y 2026-07-09 "" --when 2026-07-09 --frequency yearly --interval 1
  trace_arm "$TAG" WD 2026-07-09 "" --when 2026-07-09 --deadline --start-days-earlier 3 --frequency weekly --interval 1
  trace_arm "$TAG" MD 2026-07-09 "" --when 2026-07-09 --deadline --start-days-earlier 3 --frequency monthly --interval 1
  trace_arm "$TAG" M3 2026-07-09 "" --when 2026-07-09 --frequency monthly --interval 3
  # The reminder arm: the seed is minted with the time on it, so DEFAULTS1-3's
  # "the reminder rides the row" is exercised end to end.
  trace_arm "$TAG" R "2026-07-09@09%3A30" "" --when 2026-07-09 --reminder 09:30 --frequency weekly --interval 1
}

cell_baseline() {
  note ""
  note "############ BASELINE — the shipped drive with the reliance OFF ############"
  ship_cli || return
  run_arms off
}
cell_after() {
  note ""
  note "############ AFTER — the same arms with verify-by-read LIVE ############"
  ship_cli || return
  run_arms on
}

########################################################################
# STATES — the 5-state matrix, both ways, rule blobs compared
########################################################################
cell_states() {
  note ""
  note "############ STATES — the manifest's dialog states, both paths ############"
  ship_cli || return
  local TAG ENVV P S1 S2 S3 S4 T1
  for TAG in on off; do
    ENVV=$(tag_env "$TAG")
    P="DEF2-ST-$TAG$TAGSFX"
    note ""
    note "  ==== states ($TAG) ===="
    beep_reset
    cli() { lab_ssh "$IP" "$ENVV $LAB_DIRECT $CLI $*" </dev/null; }

    # S1 FIXED — the "Every" label row with a monthly cadence group.
    beep_mark "$TAG S1"; warm
    S1=$(mkseed "${P}-s1" 2026-07-09 "") || { note "    no seed"; continue; }
    cli todo make-repeating "$S1" --when 2026-07-09 --frequency monthly --interval 2 --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/drive/st1-$TAG.json" 2>&1
    note "    S1 exit=$? · $(rsum "$(tmplid "${P}-s1")")"
    note "    S1 blob=$(ruleblob "$(tmplid "${P}-s1")")"
    dismiss_alerts

    # S2 AFTER-COMPLETION — the one-field group.
    beep_mark "$TAG S2"; warm
    S2=$(mkseed "${P}-s2" "" "") || { note "    no seed"; continue; }
    cli todo make-repeating "$S2" --frequency weekly --interval 3 --after-completion --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/drive/st2-$TAG.json" 2>&1
    note "    S2 exit=$? · $(rsum "$(tmplid "${P}-s2")")"
    note "    S2 blob=$(ruleblob "$(tmplid "${P}-s2")")"
    dismiss_alerts

    # S3 DEADLINES — the #646 shape (the checkbox mints a shell-level field), and
    # the shape the seed shaping acts on.
    beep_mark "$TAG S3"; warm
    S3=$(mkseed "${P}-s3" 2026-07-09 "") || { note "    no seed"; continue; }
    cli todo make-repeating "$S3" --when 2026-07-09 --frequency weekly --interval 1 --deadline --start-days-earlier 2 --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/drive/st3-$TAG.json" 2>&1
    note "    S3 exit=$? · $(rsum "$(tmplid "${P}-s3")")"
    note "    S3 blob=$(ruleblob "$(tmplid "${P}-s3")")"
    dismiss_alerts

    # S4 ENDS-COUNT (HXPC1) — a RESCHEDULE, which gets no reliance at all: its
    # dialog opens pre-populated from the existing rule, so none of the defaults
    # law applies (DEFAULTS1 §9.5). The cell proves the reschedule path is
    # untouched by this campaign.
    beep_mark "$TAG S4"; warm
    T1=$(tmplid "${P}-s1")
    cli todo reschedule-repeat "$T1" --frequency daily --interval 3 --ends-after 4 --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/drive/st4-$TAG.json" 2>&1
    note "    S4 exit=$? · $(rsum "$T1")"
    note "    S4 blob=$(ruleblob "$T1")"
    dismiss_alerts

    # S5 PAUSED — the pause/resume pair through a different menu path.
    beep_mark "$TAG S5"; warm
    cli todo pause-repeat "$T1" --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/drive/st5-$TAG.json" 2>&1
    note "    S5 pause exit=$? · $(rsum "$T1")"
    cli todo resume-repeat "$T1" --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/drive/st5b-$TAG.json" 2>&1
    note "    S5 resume exit=$? · $(rsum "$T1")"
    dismiss_alerts

    # S6 REMINDER — add-repeating, so the seed is minted with the reminder on it
    # by the shipped composite rather than by this driver.
    beep_mark "$TAG S6"; warm
    cli todo add-repeating "'${P}-s6'" --when 2026-07-09 --reminder 09:30 --frequency weekly --interval 1 --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/drive/st6-$TAG.json" 2>&1
    note "    S6 exit=$? · $(rsum "$(tmplid "${P}-s6")")"
    note "    S6 blob=$(ruleblob "$(tmplid "${P}-s6")")"
    dismiss_alerts

    beep_assert "states-$TAG"
  done
  note ""
  note "  ---- rule blobs, on vs off (expect byte-identical per arm) ----"
  local a
  for a in s1 s2 s3 s6; do
    note "    $a on =$(ruleblob "$(tmplid "DEF2-ST-on$TAGSFX-$a")")"
    note "    $a off=$(ruleblob "$(tmplid "DEF2-ST-off$TAGSFX-$a")")"
  done
  note "  crash=$(alive) ips=$(ips_count)"
}

########################################################################
# MISMATCH — a deliberately WRONG pre-fill must engage the setter
########################################################################
# The seed shaping refuses to move an EVENING-scheduled row (a `when=` leg would
# clear that byte), so an evening seed asked for a first occurrence on another
# date is a drive whose dialog pre-fills from TODAY while the rule asks for
# something else. Every anchor key must MISS and every anchor setter must run —
# and the landed rule must still be exactly right.
cell_mismatch() {
  note ""
  note "############ MISMATCH — the fallback path, forced ############"
  ship_cli || return
  local t1="DEF2-MM$TAGSFX" t2="DEF2-READMISS$TAGSFX" t3="DEF2-DLSRC$TAGSFX" U1 U2 U3 rc TF

  # Both seeds are minted before either drive — the shape the DEFAULTS1 matrix
  # already used, and the one that keeps a cell's fixtures independent of what
  # the cell's own drives leave behind.
  beep_reset; beep_mark "mismatch seeds"; warm
  U1=$(mkseed "$t1" "evening" "") || { note "  FATAL: no seed 1"; return; }
  U2=$(mkseed "$t2" "evening" "") || { note "  FATAL: no seed 2"; return; }
  U3=$(mkseed "$t3" "2026-07-09" "2026-07-12") || { note "  FATAL: no seed 3"; return; }
  note "  seed 1 uuid=$U1 · $(seedrow "$U1")"
  note "  seed 2 uuid=$U2 · $(seedrow "$U2")"
  note "  seed 3 uuid=$U3 · $(seedrow "$U3")  (carries a deadline)"

  # ARM 1 — THE ARITHMETIC'S fail-safe. The shaping declines an evening row, so
  # the dialog pre-fills from TODAY while the rule asks for another date: the
  # anchor keys are never even NOMINATED, and every anchor setter runs. The
  # landed rule must be the RULE, not the pre-fill.
  note ""
  note "  ---- arm 1: a seed the shaping declines, so nothing is nominated ----"
  beep_reset; beep_mark "mismatch"
  lab_ssh "$IP" 'rm -rf ~/.local/state/things-api/trace' </dev/null
  # 2026-07-16 is a Thursday; the pinned today (2026-07-05) is a Sunday, so the
  # weekday, the day-of-month and `Next:` all disagree with the pre-fill.
  lab_ssh "$IP" "THINGS_API_TRACE=true THINGS_API_AX_COUNT=1 $LAB_DIRECT $CLI todo make-repeating $U1 --when 2026-07-16 --frequency weekly --interval 1 --dangerously-drive-gui --verify-timeout 90000 --json" \
    </dev/null >"$OUT/drive/mismatch.log" 2>&1
  rc=$?
  note "  exit $rc · verdict: $(grep -o -e '"ok":[a-z]*' -e '"status":"[a-z-]*"' "$OUT/drive/mismatch.log" | head -3 | tr '\n' ' ')"
  note "  landed: $(rsum "$(tmplid "$t1")")"
  note "  ^ expect of=[{wd=4}] (Thursday) and next/icStart 2026-07-16 — the RULE, not the pre-fill"
  TF=$(lab_ssh "$IP" 'cd ~/.local/state/things-api/trace 2>/dev/null && ls -t | head -1' </dev/null | tr -d '\r\n')
  if [ -n "$TF" ]; then
    lab_ssh "$IP" "cat ~/.local/state/things-api/trace/$(printf '%q' "$TF")" </dev/null > "$OUT/trace/mismatch.jsonl" 2>/dev/null
    note "  prefill ledger (expect nothing nominated but the interval):"
    python3 lab/scripts/defaults2-ledger.py "$OUT/trace/mismatch.jsonl" | sed 's/^/    /' | tee -a "$REPORT"
  fi
  beep_assert "mismatch"
  dismiss_alerts

  # ARM 2 — A READ-LEVEL MISS, forced deterministically.
  #
  # Arm 1 shows the arithmetic declining to claim. What it cannot show is the
  # other half — a key that IS nominated and then reads WRONG — because on 3.23
  # the arithmetic is right, and the seed shaping keeps making it right.
  #
  # So the two clocks are DELIBERATELY split. `THINGS_TZ` moves the CLI's notion
  # of TODAY a day ahead of the app's (Kiritimati is UTC+14 against the guest's
  # UTC), and the evening seed makes the shaping decline, leaving the row on the
  # app's today. The CLI then computes the anchor as its own tomorrow, NOMINATES
  # `Next:` and the weekday for that date, and the dialog — anchored on the app's
  # today — holds neither. Both reads must MISS, both certified setters must
  # engage, and the landed rule must be exactly what was asked for.
  note ""
  note "  ---- arm 2: a nominated key that READS wrong (THINGS_TZ a day ahead) ----"
  beep_reset; beep_mark "mismatch-read"; warm
  lab_ssh "$IP" 'rm -rf ~/.local/state/things-api/trace' </dev/null
  lab_ssh "$IP" "THINGS_TZ=Pacific/Kiritimati THINGS_API_TRACE=true THINGS_API_AX_COUNT=1 $LAB_DIRECT $CLI todo make-repeating $U2 --when 2026-07-06 --frequency weekly --interval 1 --dangerously-drive-gui --verify-timeout 90000 --json" \
    </dev/null >"$OUT/drive/mismatch2.log" 2>&1
  rc=$?
  note "  exit $rc · verdict: $(grep -o -e '"ok":[a-z]*' -e '"status":"[a-z-]*"' "$OUT/drive/mismatch2.log" | head -3 | tr '\n' ' ')"
  note "  landed: $(rsum "$(tmplid "$t2")")"
  note "  ^ expect of=[{wd=1}] (Monday) and next/icStart 2026-07-06 — the RULE, not the pre-fill"
  TF=$(lab_ssh "$IP" 'cd ~/.local/state/things-api/trace 2>/dev/null && ls -t | head -1' </dev/null | tr -d '\r\n')
  if [ -n "$TF" ]; then
    lab_ssh "$IP" "cat ~/.local/state/things-api/trace/$(printf '%q' "$TF")" </dev/null > "$OUT/trace/mismatch2.jsonl" 2>/dev/null
    note "  prefill ledger (expect next + weekdays MISSED, and both setters dispatched):"
    python3 lab/scripts/defaults2-ledger.py "$OUT/trace/mismatch2.jsonl" | sed 's/^/    /' | tee -a "$REPORT"
  fi
  beep_assert "mismatch-read"
  dismiss_alerts

  # ARM 3 — A DEADLINED SOURCE: the pre-fill is real, and it is not what the rule
  # asked for.
  #
  # This is the ordinary user shape the arithmetic has to get right. Promoting a
  # to-do that already HAS a deadline clones the deadline along with it, and a
  # deadline on the row re-anchors the ENTIRE cadence row onto the DUE date
  # (DEFAULTS1 §4). The rule, meanwhile, asks for the START's geometry — its
  # weekday, its `Next:`. So the dialog will come up holding Sunday/Jul 12 while
  # the request is Thursday/Jul 9, and every anchor key must be DECLINED rather
  # than claimed. The landed rule is the proof: it must be the request's.
  note ""
  note "  ---- arm 3: a deadlined source, whose pre-fill anchors on the DUE date ----"
  beep_reset; beep_mark "mismatch-deadlined"; warm
  lab_ssh "$IP" 'rm -rf ~/.local/state/things-api/trace' </dev/null
  lab_ssh "$IP" "THINGS_API_TRACE=true THINGS_API_AX_COUNT=1 $LAB_DIRECT $CLI todo make-repeating $U3 --frequency weekly --interval 1 --dangerously-drive-gui --verify-timeout 90000 --json" \
    </dev/null >"$OUT/drive/mismatch3.log" 2>&1
  rc=$?
  note "  exit $rc · verdict: $(grep -o -e '"ok":[a-z]*' -e '"status":"[a-z-]*"' "$OUT/drive/mismatch3.log" | head -3 | tr '\n' ' ')"
  note "  landed: $(rsum "$(tmplid "$t3")")"
  note "  ^ expect of=[{wd=4}] (THURSDAY — the start's weekday, not the deadline's Sunday)"
  TF=$(lab_ssh "$IP" 'cd ~/.local/state/things-api/trace 2>/dev/null && ls -t | head -1' </dev/null | tr -d '\r\n')
  if [ -n "$TF" ]; then
    lab_ssh "$IP" "cat ~/.local/state/things-api/trace/$(printf '%q' "$TF")" </dev/null > "$OUT/trace/mismatch3.jsonl" 2>/dev/null
    note "  prefill ledger (expect the anchor keys DECLINED and their setters driven):"
    python3 lab/scripts/defaults2-ledger.py "$OUT/trace/mismatch3.jsonl" | sed 's/^/    /' | tee -a "$REPORT"
  fi
  beep_assert "mismatch-deadlined"
  dismiss_alerts
  note "  crash=$(alive) ips=$(ips_count)"
}

########################################################################
# REFUSE — the pre-dispatch refusals
########################################################################
# Oddities §31: a deadline PRECEDING the start is silently flattened by the app
# to "0 days earlier" with the box ticked and the deadline date DISCARDED. The
# CLI must never produce that request — and it does not, but the refusal is a
# claim this campaign relies on (ui-prefill.ts's offset arithmetic assumes the
# gap is non-negative), so it is certified rather than asserted.
cell_refuse() {
  note ""
  note "############ REFUSE — the shapes that never reach the dialog ############"
  ship_cli || return
  local rc
  refuse_arm() {
    local label="$1"; shift
    note ""
    note "  ---- $label ----"
    lab_ssh "$IP" "$LAB_DIRECT $CLI $* --dangerously-drive-gui --json" </dev/null >"$OUT/drive/refuse.log" 2>&1
    rc=$?
    note "    exit=$rc"
    note "    out: $(head -c 700 "$OUT/drive/refuse.log" | tr -d '\n')"
  }
  # (a) §31 — a deadline before the start.
  refuse_arm "deadline BEFORE the start (oddities §31)" \
    todo add-repeating "'DEF2-RF1$TAGSFX'" --when 2026-07-16 --deadline 2026-07-12 --frequency weekly --interval 1
  note "    rows created: $(gq "SELECT count(*) FROM TMTask WHERE title='DEF2-RF1$TAGSFX'") (expect 0)"
  # (b) a negative offset.
  refuse_arm "a negative --start-days-earlier" \
    todo add-repeating "'DEF2-RF2$TAGSFX'" --when 2026-07-16 --start-days-earlier -3 --frequency weekly --interval 1
  note "    rows created: $(gq "SELECT count(*) FROM TMTask WHERE title='DEF2-RF2$TAGSFX'") (expect 0)"
  # (c) a deadline with no concrete --when (the offset has nothing to measure from).
  refuse_arm "a deadline with no concrete --when" \
    todo add-repeating "'DEF2-RF3$TAGSFX'" --when someday --deadline 2026-07-12 --frequency weekly --interval 1
  note "    rows created: $(gq "SELECT count(*) FROM TMTask WHERE title='DEF2-RF3$TAGSFX'") (expect 0)"
  note "  crash=$(alive) ips=$(ips_count)"
}

########################################################################
# CELLS — the guard cells + the census 2x2
########################################################################
cell_cells() {
  note ""
  note "############ CELLS — the guards, and the census in every quadrant ############"
  ship_cli || return
  local TAG ENVV P ALPHA BRAVO CHARLIE DELTA
  for TAG in on off; do
    ENVV=$(tag_env "$TAG")
    P="DEF2-C-$TAG$TAGSFX"
    note ""
    note "  ==== cells ($TAG) ===="
    beep_reset
    cli() { lab_ssh "$IP" "$ENVV $LAB_DIRECT $CLI $*" </dev/null; }
    ui() {
      lab_ssh "$IP" "$ENVV $LAB_DIRECT $CLI doctor --ui-state --json" </dev/null 2>/dev/null | tail -1 \
        | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]["uiState"]; print(json.dumps({k:d[k] for k in sorted(d)}))' 2>/dev/null
    }

    warm
    ALPHA=$(mkseed "${P}-alpha" 2026-07-09 "")
    BRAVO=$(mkseed "${P}-bravo" 2026-07-09 "")
    CHARLIE=$(mkseed "${P}-charlie" 2026-07-09 "")
    DELTA=$(mkseed "${P}-delta" 2026-07-09 "")
    note "    fixtures: alpha=$ALPHA bravo=$BRAVO charlie=$CHARLIE delta=$DELTA"

    # U 2x2 — the census law: a change to what the driver READS needs a cell that
    # reads it back, in every quadrant AND in the shape a checkbox can mint.
    beep_mark "$TAG U census"
    note "    Q1 no dialog / Things front : $(ui)"
    lab_ssh "$IP" 'osascript -e '\''tell application "Finder" to activate'\''; sleep 1' </dev/null
    note "    Q2 no dialog / Finder front : $(ui)"
    select_item "$ALPHA" "${P}-alpha" >/dev/null
    openrepeat >/dev/null
    note "    Q3 dialog open / Things front: $(ui)"
    lab_ssh "$IP" 'osascript -e '\''tell application "Finder" to activate'\''; sleep 1' </dev/null
    note "    Q4 dialog open / Finder front: $(ui)"

    # C2 — a drive started with a STRANDED dialog refuses and commits nothing.
    beep_mark "$TAG C2"
    cli todo make-repeating "$BRAVO" --when 2026-07-09 --frequency weekly --interval 2 --dangerously-drive-gui --verify-timeout 60000 --json >"$OUT/drive/c2-$TAG.json" 2>&1
    note "    C2 exit=$? · $(head -c 400 "$OUT/drive/c2-$TAG.json" | tr -d '\n')"
    note "    C2 bravo repeating? $(gq "SELECT count(*) FROM TMTask WHERE title='${P}-bravo' AND rt1_recurrenceRule IS NOT NULL") (expect 0)"
    esc; dismiss_alerts

    # S — an already-set rule discloses the skip and types nothing.
    beep_mark "$TAG S skip"; warm
    cli todo make-repeating "$ALPHA" --frequency daily --interval 1 --after-completion --dangerously-drive-gui --verify-timeout 90000 --json >"$OUT/drive/s1-$TAG.json" 2>&1
    note "    S exit=$? · $(head -c 500 "$OUT/drive/s1-$TAG.json" | tr -d '\n')"
    note "    S template? $(gq "SELECT count(*) FROM TMTask WHERE title='${P}-alpha' AND rt1_recurrenceRule IS NOT NULL") (expect 1)"
    dismiss_alerts

    # T — focus theft mid-drive REFUSES with nothing typed, in the wording it
    # always had. This is the cell the verify hop could have broken: it inserts a
    # READ where a setter used to be, and the guard rides the setters.
    beep_mark "$TAG T theft"; warm
    lab_ssh "$IP" 'cat > ~/labh/theft.sh && chmod +x ~/labh/theft.sh' <<EOF
#!/bin/bash
CLI="\$HOME/things-lab/bin/node \$HOME/things-lab/things-api/dist/cli/main.js"
export THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1 ${ENVV:+$ENVV}
\$CLI todo make-repeating "\$1" --when 2026-07-09 --frequency monthly --interval 3 --dangerously-drive-gui \\
  --verify-timeout 60000 --json >"\$HOME/labh/theft-out.json" 2>"\$HOME/labh/theft-err.txt" &
DRIVE=\$!
SAW=no
for _ in \$(seq 1 400); do
  OPEN=\$(osascript -e 'tell application "System Events" to tell process "Things3" to return ((exists sheet 1 of (first window whose subrole is "AXStandardWindow")) or ((count of (windows whose subrole is "AXUnknown" and size is not {40, 40})) > 0))' 2>/dev/null)
  if [ "\$OPEN" = "true" ]; then SAW=yes; break; fi
  sleep 0.1
done
osascript -e 'tell application "Finder" to activate' >/dev/null 2>&1
echo "sheet-seen=\$SAW"
wait \$DRIVE
echo "drive-exit=\$?"
EOF
    note "    T $(lab_ssh "$IP" "~/labh/theft.sh $CHARLIE" </dev/null 2>&1 | tr '\n' ' ')"
    note "    T refusal: $(lab_ssh "$IP" 'head -c 1200 ~/labh/theft-out.json' </dev/null | tr -d '\n')"
    note "    T stderr: $(lab_ssh "$IP" 'grep -v ExperimentalWarning ~/labh/theft-err.txt | grep -v trace-warnings | head -c 900' </dev/null | tr -d '\n')"
    note "    T charlie repeating? $(gq "SELECT count(*) FROM TMTask WHERE title='${P}-charlie' AND rt1_recurrenceRule IS NOT NULL") (expect 0)"
    esc; dismiss_alerts

    # X — the MODALX1 open-dialog preflight refuses before anything is pressed.
    beep_mark "$TAG X preflight"; warm
    select_item "$DELTA" "${P}-delta" >/dev/null
    openrepeat >/dev/null
    cli todo make-repeating "$DELTA" --when 2026-07-09 --frequency weekly --interval 2 --dangerously-drive-gui --verify-timeout 60000 --json >"$OUT/drive/x1-$TAG.json" 2>&1
    note "    X exit=$? · $(head -c 400 "$OUT/drive/x1-$TAG.json" | tr -d '\n')"
    note "    X delta repeating? $(gq "SELECT count(*) FROM TMTask WHERE title='${P}-delta' AND rt1_recurrenceRule IS NOT NULL") (expect 0)"
    esc; dismiss_alerts

    beep_assert "cells-$TAG"
  done
  note "  crash=$(alive) ips=$(ips_count)"
}

########################################################################
for c in $CELLS; do
  case "$c" in
    clamp) cell_clamp ;;
    baseline) cell_baseline ;;
    after) cell_after ;;
    states) cell_states ;;
    mismatch) cell_mismatch ;;
    refuse) cell_refuse ;;
    cells) cell_cells ;;
    teardown) note "teardown requested — the EXIT trap destroys $VM"; KEEP=0 ;;
    *) note "unknown cell: $c" ;;
  esac
done
note ""
note "report: $REPORT · traces: $OUT/trace/ · drives: $OUT/drive/"
