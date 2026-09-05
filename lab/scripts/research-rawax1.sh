#!/bin/bash
# RAWAX1 — CAN THE REPEAT DRIVE BE SPOKEN IN RAW ACCESSIBILITY CALLS? (#695)
#
# THE COST THIS CAMPAIGN ATTACKS. RDLAT2 fitted the maintainer's M1 at
# **~47 ms per Apple event to System Events** and **~124 ms per osascript
# spawn**, and the shipped `make-repeating` is 13 hops / 88 events — so ~4.1 s of
# a ~6.9 s drive is transport and nothing else. The SAME Accessibility calls made
# IN-PROCESS through the JXA ObjC bridge cost **0.12 ms** apiece on that same
# machine (VOPAT1 §field law), which is the whole thesis: the drive is not slow
# because it asks too much, it is slow because of who it asks through.
#
# WHAT A CLONE CAN AND CANNOT ANSWER (harness.md §Cost law corollary). A clone is
# ~200x cheaper per realized element than a real display and its Apple events are
# ~8 ms rather than ~47 ms, so **no wall time here transfers**. What DOES transfer
# is: whether a raw call AGREES with the System Events call it would replace, how
# many calls each shape costs, and what the app announces. Every cell reports
# those three and leaves the multiplier to the maintainer's own trace.
#
# THE PROBE IS AN EQUIVALENCE MATRIX, not a benchmark — see the header of
# lab/scripts/rawax1-probe.jxa.js for the primitive list and the two answers the
# campaign expects to be NO.
#
# CELLS
#   shape     THE SHAPE TRACE the AX-drive scrutiny law requires: the FULL control
#             inventory (role, subrole, title, value, identifier, ACTIONS, frame)
#             of the shell and the cadence group, dumped after EVERY input, for
#             all five dialog states (daily/weekly/monthly/yearly/after-completion)
#             plus the deadlines-ticked and ends-after shapes.
#   prims     the primitive equivalence + per-call timing matrix, raw vs System
#             Events, against the same live control.
#   menu      the pop-up: does AXPress open it, where does the AXMenu live, does an
#             AXMenuItem press select, is the `More…` cascade reachable.
#   setvalue  THE DECISIVE CELL. AXValue on the interval field, then COMMIT, then
#             read the landed rule out of the guest's SQLite. A field that shows
#             the number and lands `fa=1` is a repaint, not an edit — which is
#             what UIC6 measured for the System Events spelling and what decides
#             whether the typing loop survives the port.
#   dates     localized occurrence titles parsed in JXA vs AppleScript's `date`.
#   menubar   AXEnabled of Items ▸ Repeat… with the menu closed.
#   rowselect AXSelected on a content-table row (the PROJECT arm's selection).
#   cost      the whole dialog entry driven raw-AX only, calls + timeline, against
#             the shipped drive's own axOps on the same shape.
#   teardown  stop + delete the clone (the EXIT trap does this anyway unless KEEP=1)
#
# METHOD: ONE disposable clone `rawax1-lab` of things-lab-golden-v4 (the golden is
# NEVER booted). Airgapped (default route deleted), guest muted, clock pinned to
# 2026-07-05 12:00 BEFORE Things launches (trial wall 2026-07-18, never rolled),
# synthetic RAWAX1-* fixtures only. Ground truth = read-only guest SQLite via the
# rsum.py blob decoder; an exit code proves nothing. Beeps counted by the guest
# sentinel (report-only). Teardown on EXIT (KEEP=1 to hold the clone, REUSE=1 to
# re-attach).
#
# Usage:  bash lab/scripts/research-rawax1.sh [cell...]      # default: shape prims
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="rawax1-lab"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
CELLS="${*:-shape prims}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/shape" "$OUT/json"
REPORT="$OUT/report.txt"
REUSE="${REUSE:-0}"
KEEP="${KEEP:-0}"
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[rawax1] $*" | tee -a "$REPORT"; }
notef() { echo "[rawax1] $*" >>"$REPORT"; echo "[rawax1] $*" >&2; }

case "$VM" in things-lab-golden-*) echo "refusing to touch a golden" >&2; exit 1 ;; esac

# THE TRIAL WALL (harness.md): golden-v4's trial dies 2026-07-18. This driver pins
# 2026-07-05 and never moves it; the constant is here so a future edit that reaches
# for a later date trips over it.
TRIAL_WALL="2026-07-18"
PINNED="2026-07-05"

note "cells: $CELLS · golden: $GOLDEN · reuse=$REUSE · clock pinned $PINNED (trial wall $TRIAL_WALL)"

if [ "$REUSE" = "1" ]; then
  IP=$(tart ip "$VM" 2>/dev/null) || { note "FATAL: $VM is not running"; exit 1; }
  [ -n "$IP" ] || { note "FATAL: no IP for $VM"; exit 1; }
  note "re-attached to $VM at $IP"
else
  # ONE VM AT A TIME. A second concurrent clone is 50 GB on a thin disk and two
  # guests contending for the same host CPU, which makes every timing cell a lie.
  RUNNING=$(tart list | awk 'NR>1 && $NF=="running" {print $2}' | tr '\n' ' ')
  [ -n "$RUNNING" ] && { note "FATAL: another VM is running ($RUNNING) — never a second concurrent clone"; exit 1; }
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 600) || { note "FATAL: no SSH"; exit 1; }
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

# The rule-blob decoder (rsum.py, as DEFAULTS1/2/3 and NEXTPOP1 use it).
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

# A GUEST-SIDE TIMEOUT (run 1's most expensive lesson). An `osascript` that
# talks to Things HANGS INDEFINITELY while a Repeat sheet is open — the app gates
# its own AppleScript port on the sheet — and an ssh with no deadline hangs the
# whole driver with it. macOS ships no `timeout(1)`, so this is the smallest
# thing that is one.
lab_ssh "$IP" 'cat > ~/labh/tmo.sh && chmod +x ~/labh/tmo.sh' <<'TMOEOF'
#!/bin/bash
# usage: tmo.sh <seconds> <command...>   -> exit 124 on timeout, like timeout(1)
secs="$1"; shift
"$@" &
child=$!
( sleep "$secs"; kill -9 "$child" 2>/dev/null ) &
killer=$!
wait "$child" 2>/dev/null; code=$?
kill -9 "$killer" 2>/dev/null
wait "$killer" 2>/dev/null
[ "$code" -ge 128 ] && code=124
exit "$code"
TMOEOF

lab_scp lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/labh/beep-sentinel.sh" >/dev/null
lab_ssh "$IP" 'chmod +x ~/labh/beep-sentinel.sh' </dev/null
lab_scp lab/scripts/rawax1-probe.jxa.js "admin@$IP:/Users/admin/labh/rawax1-probe.jxa.js" >/dev/null

beep_reset() { lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null 2>&1; }
beep_mark()  { lab_ssh "$IP" "~/labh/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }
beep_assert() {
  lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/labh/beep-sentinel.sh assert --name $(printf '%q' "$1")" \
    </dev/null 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
}
gq() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
axq() { lab_ssh "$IP" "~/labh/tmo.sh ${AXQ_TMO:-30} osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
rsum() { lab_ssh "$IP" "python3 ~/labh/rsum.py '$1' 2>&1" </dev/null; }
anyid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
tmplid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
alive() { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null; }
ips_count() { lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3*.ips 2>/dev/null | wc -l | tr -d " "' </dev/null; }

# THE PROBE, run in the guest. Every cell prints JSON; the driver tees it to an
# artifact and pulls the fields the report needs out of it with python3, never by
# eyeballing (a cell that is read by grep is a cell that can be misread).
probe() {
  lab_ssh "$IP" "~/labh/tmo.sh ${PROBE_TMO:-150} osascript -l JavaScript ~/labh/rawax1-probe.jxa.js $*" </dev/null 2>&1
}
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {"d":d}))' "$1" 2>/dev/null; }

warm() {
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; pkill -x Things3 >/dev/null 2>&1; sleep 2; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null
}

warm
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
DBV=$(gq "SELECT value FROM Meta WHERE key='databaseVersion'" 2>/dev/null)
note "env: Things $TVER ($TBLD) · macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) · dbv ${DBV:-?} · clock $(lab_ssh "$IP" date </dev/null)"

# mkseed <title> [when] [deadline] -> uuid  (the DEFAULTS2 rig shape: assignments
# SPLIT so a `local` word list can never expand the caller's own title).
mkseed() {
  local title="$1"
  local when="${2:-}"
  local dl="${3:-}"
  local u i
  local url="things:///add?title=$title&auth-token=$TOKEN"
  [ -n "$when" ] && url="$url&when=$when"
  [ -n "$dl" ] && url="$url&deadline=$dl"
  for i in 1 2 3 4; do
    lab_ssh "$IP" "open -g '$url'; sleep 4" </dev/null
    u=$(anyid "$title")
    [ -n "$u" ] && { echo "$u"; return 0; }
    notef "  mkseed '$title' attempt $i read back no row"
    lab_ssh "$IP" "sleep $((i * 3))" </dev/null
  done
  return 1
}

# Dismiss any NON-Repeat modal sheet standing on a Things window (DEFAULTS1 §11.1).
dismiss_alerts() {
  local r
  r=$(axq "tell application \"System Events\" to tell process \"Things3\"
  set n to 0
  repeat 6 times
    set found to false
    repeat with w in windows
      repeat with s in sheets of w
        set isRepeat to false
        try
          if (exists group 1 of s) and (exists pop up button 1 of s) then set isRepeat to true
        end try
        if not isRepeat then
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
  return \"DISMISSED \" & n & \" stray sheet(s)\"
end tell")
  case "$r" in "no stray sheet") ;; *) notef "    !! $r" ;; esac
}

select_item() {
  local uuid="$1" want="$2" i sel
  [ -n "$uuid" ] || { notef "  select_item REFUSED: empty uuid for '$want'"; return 1; }
  # NEVER ACTIVATE INTO AN OPEN DIALOG (run 1). `tell application "Things3" to
  # activate` is an Apple event to Things, and Things gates its AppleScript port
  # on an open sheet, so it hangs until the sheet goes. Clear it first.
  probe dismiss >/dev/null
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

# Open the Repeat dialog through the PROBE's own raw-AX menu path — the port's
# first hop, exercised by every cell that needs a dialog.
open_dialog_raw() {
  dismiss_alerts
  probe open
}
# TEAR DOWN THROUGH THE LADDER, AND VERIFY (run 1). An addressed Cancel press
# returned AXError 0 and left the sheet standing — through raw AX AND through
# System Events — after a cell had opened one of the dialog's pop-up menus; the
# next cell's `tell application "Things3" to activate` then hung forever on the
# sheet gate and the run was lost from there. So the rig dismisses through the
# shipped ladder (Cancel, then Escape), CHECKS, and re-warms the app if neither
# worked rather than carrying a wedged guest into the next cell.
dismiss_dialog() {
  local r
  r=$(probe dismiss)
  case "$r" in
    *'"ok": true'*) return 0 ;;
  esac
  notef "  !! the dialog would not dismiss — re-warming Things"
  notef "     $(echo "$r" | tr -d '\n' | cut -c1-300)"
  warm
  return 1
}
cancel_dialog_raw() { dismiss_dialog; }

# Select a frequency through the raw path (used by the shape trace between inputs).
select_freq_se() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set pu to pop up button 1 of sheet 1 of (first window whose subrole is \"AXStandardWindow\")
  repeat 20 times
    if (exists menu 1 of pu) then exit repeat
    click pu
    delay 0.2
  end repeat
  click menu item \"$1\" of menu 1 of pu
  delay 1
  return \"ok\"
end tell" >/dev/null
}

########################################################################
run_shape() {
  note "=== shape — the full control inventory after every input (AX-drive scrutiny law)"
  local u
  u=$(mkseed "RAWAX1-Shape" "$PINNED") || { note "  FATAL: no seed"; return 1; }
  note "  seed RAWAX1-Shape = $u"
  select_item "$u" "RAWAX1-Shape" || { note "  FATAL: selection"; return 1; }
  local state
  for state in "after completion" daily weekly monthly yearly; do
    beep_reset
    beep_mark "$state"
    open_dialog_raw >"$OUT/json/open-$(echo "$state" | tr ' ' '-').json" 2>&1
    note "  --- state: $state"
    note "      opened: $(jget 'd.get("ok")' <"$OUT/json/open-$(echo "$state" | tr ' ' '-').json") form=$(jget 'd.get("form")' <"$OUT/json/open-$(echo "$state" | tr ' ' '-').json")"
    # BEFORE the input — the dialog's opening state, which is what the pre-fill
    # law is about and what a shape diff has to start from.
    probe shape >"$OUT/shape/$(echo "$state" | tr ' ' '-')-0-open.json" 2>&1
    select_freq_se "$state"
    probe shape >"$OUT/shape/$(echo "$state" | tr ' ' '-')-1-freq.json" 2>&1
    # Then the two inputs that MINT controls (CGRD1 §B): the deadlines checkbox
    # (a shell text field) and the ends-after bound (a second group field).
    axq 'tell application "System Events" to tell process "Things3" to click checkbox "Add deadlines" of sheet 1 of (first window whose subrole is "AXStandardWindow")' >/dev/null
    lab_ssh "$IP" 'sleep 1' </dev/null
    probe shape >"$OUT/shape/$(echo "$state" | tr ' ' '-')-2-deadlines.json" 2>&1
    if [ "$state" != "after completion" ]; then
      axq 'tell application "System Events" to tell process "Things3"
  set g to group 1 of sheet 1 of (first window whose subrole is "AXStandardWindow")
  set pu to pop up button 1 of g
  repeat 20 times
    if (exists menu 1 of pu) then exit repeat
    click pu
    delay 0.2
  end repeat
  click menu item "after" of menu 1 of pu
  delay 1
end tell' >/dev/null
      probe shape >"$OUT/shape/$(echo "$state" | tr ' ' '-')-3-endsafter.json" 2>&1
    fi
    python3 - "$OUT/shape" "$(echo "$state" | tr ' ' '-')" <<'PY' | tee -a "$REPORT"
import json, sys, glob, os
d, state = sys.argv[1], sys.argv[2]
prev = None
for f in sorted(glob.glob(os.path.join(d, state + "-*.json"))):
    try:
        j = json.load(open(f))
    except Exception as e:
        print("      %-28s UNREADABLE (%s)" % (os.path.basename(f), e)); continue
    if not j.get("ok"):
        print("      %-28s %s" % (os.path.basename(f), j.get("why"))); continue
    shell = ",".join(j.get("shellRoles", []))
    grp = j.get("groupChildren", [])
    sig = "shell[%s] group[%s]" % (
        shell,
        ",".join("%s%s@%s" % (c.get("role","?").replace("AX",""),
                              ("=" + str(c["value"])) if c.get("value") else "",
                              c.get("y")) for c in grp))
    tag = "  (unchanged)" if sig == prev else ""
    print("      %-28s %s%s" % (os.path.basename(f)[len(state)+1:], sig, tag))
    prev = sig
PY
    beep_assert "shape/$state"
    cancel_dialog_raw
    lab_ssh "$IP" 'sleep 1' </dev/null
  done
  note "  app: $(alive) · ips=$(ips_count)"
}

run_prims() {
  note "=== prims — the primitive equivalence + per-call timing matrix"
  local u
  u=$(anyid "RAWAX1-Shape"); [ -n "$u" ] || u=$(mkseed "RAWAX1-Prims" "$PINNED")
  [ -n "$u" ] || { note "  FATAL: no seed"; return 1; }
  select_item "$u" "$(gq "SELECT title FROM TMTask WHERE uuid='$u'")" || { note "  FATAL: selection"; return 1; }
  local state
  for state in "after completion" weekly monthly; do
    open_dialog_raw >/dev/null
    select_freq_se "$state"
    probe prims "${REPS:-50}" >"$OUT/json/prims-$(echo "$state" | tr ' ' '-').json" 2>&1
    note "  --- state: $state"
    python3 - "$OUT/json/prims-$(echo "$state" | tr ' ' '-').json" <<'PY' | tee -a "$REPORT"
import json, sys
j = json.load(open(sys.argv[1]))
if not j.get("ok"):
    print("      FAILED: %s" % j.get("why")); raise SystemExit
print("      %-4s %-44s %-6s %9s %9s %8s" % ("id","what","agree","raw ms","SE ms","x"))
for r in j["rows"]:
    print("      %-4s %-44s %-6s %9s %9s %8s" % (
        r["id"], r["what"][:44], r["agree"], r["rawMs"], r["seMs"], r["speedup"]))
    if r["agree"] == "NO":
        print("           raw=%r  se=%r" % (r["raw"][:80], r["se"][:80]))
for s in j.get("settable", []):
    print("      settable  %-34s %-6s  actions=%s" % (s["what"], s.get("settable"), s.get("actions","")))
fs = j.get("focusSet") or {}
print("      AXFocused:=true  ok=%s via=%s readBack=%s  tried=%s"
      % (fs.get("ok"), fs.get("how"), fs.get("readBack"), " ".join(fs.get("tried", []))))
print("      raw floor: %s ms per attribute read (RDLAT2 fitted the field's Apple event at ~47 ms)"
      % j.get("rawFloorMsPerCall"))
print("      calls: ax=%s nodes=%s se=%s" % (j["axCalls"], j["axNodes"], j["seEvents"]))
PY
    cancel_dialog_raw
    lab_ssh "$IP" 'sleep 1' </dev/null
  done
}

run_menu() {
  note "=== menu — AXPress opens it, where the AXMenu lives, cascade reachability"
  local u; u=$(anyid "RAWAX1-Shape"); [ -n "$u" ] || u=$(mkseed "RAWAX1-Menu" "$PINNED")
  select_item "$u" "$(gq "SELECT title FROM TMTask WHERE uuid='$u'")" || return 1
  beep_reset
  beep_mark menu
  open_dialog_raw >/dev/null
  probe menu >"$OUT/json/menu.json" 2>&1
  python3 - "$OUT/json/menu.json" <<'PY' | tee -a "$REPORT"
import json, sys
j = json.load(open(sys.argv[1]))
print("      ok=%s pressErr=%s menuOpenMs=%s items=%s" % (j.get("ok"), j.get("pressErr"), j.get("menuOpenMs"), j.get("menuItemCount")))
print("      popup actions: %s" % j.get("popupActions"))
print("      child roles before open: %r" % j.get("childRolesBeforeOpen"))
print("      item titles: %s" % ", ".join(j.get("itemTitles", [])))
print("      item actions: %s" % j.get("itemActions"))
print("      cascade: %s" % j.get("cascade"))
print("      second press closed it: %s" % (not j.get("stillOpenAfterSecondPress")))
print("      calls: ax=%s" % j.get("axCalls"))
PY
  beep_assert "menu"
  cancel_dialog_raw
}

run_setvalue() {
  note "=== setvalue — does AXUIElementSetAttributeValue FIRE the field's binding?"
  note "    (UIC6 measured the System Events spelling as a repaint; the oracle is the landed rule)"
  local u want
  want="${WANT:-3}"
  u=$(mkseed "RAWAX1-SetValue" "$PINNED") || { note "  FATAL: no seed"; return 1; }
  note "  seed RAWAX1-SetValue = $u"
  note "  before: $(rsum "$u")"
  select_item "$u" "RAWAX1-SetValue" || return 1
  beep_reset
  beep_mark setvalue
  open_dialog_raw >/dev/null
  # A FIXED frequency, so the group holds exactly ONE numeric field and the
  # addressing question is not mixed into the answer.
  select_freq_se "weekly"
  probe setvalue "$want" >"$OUT/json/setvalue.json" 2>&1
  python3 - "$OUT/json/setvalue.json" <<'PY' | tee -a "$REPORT"
import json, sys
j = json.load(open(sys.argv[1]))
print("      settable=%s setErr=%s was=%r requested=%r shown=%r heldTheText=%s"
      % (j.get("settable"), j.get("setErr"), j.get("was"), j.get("requested"), j.get("shown"), j.get("heldTheText")))
print("      group statics after the write: %s" % j.get("groupStatics"))
PY
  # COMMIT — the only oracle that separates a repaint from an edit.
  axq 'tell application "System Events" to tell process "Things3" to click button "OK" of sheet 1 of (first window whose subrole is "AXStandardWindow")' >/dev/null
  lab_ssh "$IP" 'sleep 3' </dev/null
  local t; t=$(tmplid "RAWAX1-SetValue")
  note "  landed rule (template $t): $(rsum "${t:-$u}")"
  note "  VERDICT: fa=$want means the binding FIRED; fa=1 means the write was a repaint"
  beep_assert "setvalue"
  note "  app: $(alive) · ips=$(ips_count)"
}

run_dates() {
  note "=== dates — localized occurrence titles, JXA vs AppleScript's own parser"
  local u; u=$(anyid "RAWAX1-Shape"); [ -n "$u" ] || u=$(mkseed "RAWAX1-Dates" "$PINNED")
  select_item "$u" "$(gq "SELECT title FROM TMTask WHERE uuid='$u'")" || return 1
  open_dialog_raw >/dev/null
  select_freq_se "weekly"
  probe dates >"$OUT/json/dates.json" 2>&1
  python3 - "$OUT/json/dates.json" <<'PY' | tee -a "$REPORT"
import json, sys
j = json.load(open(sys.argv[1]))
if not j.get("ok"):
    print("      FAILED: %s" % j.get("why")); raise SystemExit
print("      live menu: %d item(s) — %s" % (j.get("liveMenuCount", 0), ", ".join(j.get("fromLiveMenu", [])[:8])))
print("      cascade:   %s" % j.get("cascade"))
print("      %-22s %-12s %-12s %-12s %-12s" % ("title", "applescript", "detectorA", "detectorB", "formatter"))
bad = {"A": 0, "B": 0, "C": 0}
for r in j.get("rows", []):
    marks = "".join(k for k in ("A", "B", "C") if not r["agree" + k])
    for k in ("A", "B", "C"):
        if not r["agree" + k]:
            bad[k] += 1
    print("      %-22s %-12s %-12s %-12s %-12s %s" % (
        r["title"][:22], r["applescript"], r["detectorA"], r["detectorB"], r["formatter"],
        ("  <-- " + marks + " disagree") if marks else ""))
print("      disagreements: detectorA=%(A)d detectorB=%(B)d formatter=%(C)d  (AppleScript is the reference)" % bad)
t = j.get("timing", {})
print("      per-call ms: detector=%s formatter=%s appleScript(NSAppleScript, in-process)=%s"
      % (t.get("detectorMs"), t.get("formatterMs"), t.get("appleScriptMs")))
PY
  cancel_dialog_raw
}

run_menubar() {
  note "=== menubar — AXEnabled of Items ▸ Repeat… with the menu CLOSED"
  local u; u=$(anyid "RAWAX1-Shape"); [ -n "$u" ] || u=$(mkseed "RAWAX1-Menubar" "$PINNED")
  select_item "$u" "$(gq "SELECT title FROM TMTask WHERE uuid='$u'")" || return 1
  probe menubar >"$OUT/json/menubar.json" 2>&1
  python3 - "$OUT/json/menubar.json" <<'PY' | tee -a "$REPORT"
import json, sys
j = json.load(open(sys.argv[1]))
for k in ("cold", "whileOpen", "coldAgain"):
    v = j.get(k) or {}
    print("      %-10s ok=%s items=%s repeatPresent=%s repeatEnabled=%s"
          % (k, v.get("ok"), v.get("itemCount"), v.get("repeatPresent"), v.get("repeatEnabled")))
print("      system events: %s" % j.get("systemEvents"))
print("      bar item actions: %s" % j.get("barItemActions"))
PY
}

run_rowselect() {
  note "=== rowselect — AXSelected on a content-table row (the PROJECT arm's selection)"
  probe rowselect >"$OUT/json/rowselect.json" 2>&1
  python3 - "$OUT/json/rowselect.json" <<'PY' | tee -a "$REPORT"
import json, sys
j = json.load(open(sys.argv[1]))
for k, v in j.items():
    if k in ("axCalls", "axNodes", "seEvents"):
        continue
    print("      %-30s %s" % (k, v))
PY
}

run_dismissprobe() {
  note "=== dismissprobe — which rung of the cleanup ladder actually dismisses"
  note "    (run 1: an addressed Cancel press returned AXError 0 and left the sheet standing)"
  local u; u=$(anyid "RAWAX1-Shape"); [ -n "$u" ] || u=$(mkseed "RAWAX1-Dismiss" "$PINNED")
  select_item "$u" "$(gq "SELECT title FROM TMTask WHERE uuid='$u'")" || return 1
  local i
  for i in 1 2 3; do
    beep_reset
    beep_mark "dismiss-$i"
    open_dialog_raw >/dev/null
    probe dismissprobe >"$OUT/json/dismissprobe-$i.json" 2>&1
    note "  --- round $i"
    python3 - "$OUT/json/dismissprobe-$i.json" <<'PY' | tee -a "$REPORT"
import json, sys
j = json.load(open(sys.argv[1]))
c = j.get("cancel") or {}
e = j.get("escape") or {}
print("      menu opened first: %s" % j.get("menuWasOpened"))
print("      cancel: ok=%s err=%s%s" % (c.get("ok"), c.get("err"), (" why=" + str(c.get("why"))) if c.get("why") else ""))
print("      escape: %s" % ("(not needed)" if e.get("skipped") else "ok=%s" % e.get("ok")))
print("      still open at the end: %s" % j.get("stillOpen"))
PY
    beep_assert "dismissprobe/$i"
    dismiss_dialog >/dev/null
  done
}

run_cost() {
  note "=== cost — the whole dialog entry, raw AX only, counted"
  local u; u=$(anyid "RAWAX1-Shape"); [ -n "$u" ] || u=$(mkseed "RAWAX1-Cost" "$PINNED")
  select_item "$u" "$(gq "SELECT title FROM TMTask WHERE uuid='$u'")" || return 1
  local f
  for f in weekly monthly; do
    beep_reset
    beep_mark "cost-$f"
    open_dialog_raw >/dev/null
    probe drive "$f" >"$OUT/json/cost-$f.json" 2>&1
    note "  --- $f"
    python3 - "$OUT/json/cost-$f.json" <<'PY' | tee -a "$REPORT"
import json, sys
j = json.load(open(sys.argv[1]))
if not j.get("ok"):
    print("      FAILED: %s %s" % (j.get("why"), j.get("offered"))); raise SystemExit
print("      totalMs=%s axCalls=%s nodes=%s settleRounds=%s cancelled=%s"
      % (j["totalMs"], j["axCalls"], j["axNodes"], j["settleRounds"], j["cancelled"]))
for t in j["timeline"]:
    print("        %-30s %8s ms   %4s calls" % (t["what"], t["atMs"], t["axCalls"]))
print("      settled signature: %s" % j["settledSignature"])
print("      audit inventory: %s" % " · ".join(j["auditInventory"]))
PY
    beep_assert "cost/$f"
    lab_ssh "$IP" 'sleep 1' </dev/null
  done
}

for cell in $CELLS; do
  case "$cell" in
    shape) run_shape ;;
    prims) run_prims ;;
    menu) run_menu ;;
    setvalue) run_setvalue ;;
    dates) run_dates ;;
    menubar) run_menubar ;;
    rowselect) run_rowselect ;;
    dismissprobe) run_dismissprobe ;;
    cost) run_cost ;;
    teardown) cleanup; trap - EXIT; exit 0 ;;
    *) note "unknown cell: $cell" ;;
  esac
done

note "report: $REPORT"
