#!/bin/bash
# DEFAULTS3 — THE OBSERVER-DOWN QUADRANT: a drive is certified when all four
# quadrants of its optional machinery are.
#
# THE FIELD DEFECT (#700). The first field-shaped release-gate run of the 0.20.8
# RC — routed through the deputy on the maintainer's own Mac, real display, Things
# 3.23.2 — refused a perfectly ordinary command:
#
#   things todo add-repeating "…" --when 2026-09-28 --frequency weekly --interval 1
#     -> verify-failed:silent-noop, 9,037 ms
#     -> "its first-occurrence row (\"Next:\") holds neither an occurrence pop-up
#         nor a date field … a Things update has redesigned it again"
#
# It had not. The trace's own first line says what happened:
#
#   {"phase":"ui-observer","event":"unavailable",
#    "why":"deputy-routed: brokered scripts cannot spawn the sidecar"}
#
# The Repeat dialog rebuilds its cadence group ASYNCHRONOUSLY after a frequency
# change (~0.2–0.5 s; NEXTPOP1/DEFAULTS1 "final by t+300 ms", VOPAT1-12 clocked
# the destroy burst at 535 ms). With a settle sidecar live, the frequency step
# WAITS to be told the rebuild finished (SETTLE_POPUP_APPLIED). With none — every
# deputy-routed host, and every host with no Command Line Tools — it waits for
# nothing, and DEFAULTS2 had removed the one thing that used to absorb the window:
# the shape probe moved AHEAD of the interval step, whose `cgSettle` was the
# accidental gate, and the interval step then became skippable altogether. So the
# probe read the group MID-REBUILD — one static text, no `Next:` row at all — and
# refused, blaming the app.
#
# THE CERTIFICATION GAP, stated once. VOPAT2 (#687) certified {sidecar, polling}.
# DEFAULTS2 (#691) certified {prefill on, off}. Neither ran the PRODUCT, and the
# product is the field's own shape: prefill ON with the observer DOWN. Optional
# machinery multiplies, so its certification must too — that is the law this
# campaign records (harness.md §Quadrants).
#
# WHAT SHIPPED
#   ui.ts  axProbeDialogShapeScript takes the settle injector. With a sidecar it
#          is the single-round read it always was; with none it takes the
#          certified POLLING settle — the SETTLE_READS/SETTLE_POLL_S budget
#          cgSettle uses for the same re-layout, and the same two-part rule: a
#          POSITIVE verdict, held across two reads a tick apart. A budget spent
#          with the shape still moving reports `unsettled` rather than blaming a
#          redesign.
#
# CELLS
#   repro  THE DEFECT, on the PRE-FIX bundle (DISTSRC=<a dist built at the RC's
#          commit>): the field's own command shape in all four quadrants. The two
#          observer-down quadrants must FAIL at the shape probe; the two
#          observer-up quadrants must PASS. This is what says the mechanism is the
#          observer and not the prefill, and not 3.23.2-vs-3.23.
#   census THE WINDOW/FOCUS CENSUS in every quadrant, with the Repeat dialog
#          open and closed (RDLAT2's census law), over a fixture no drive has
#          promoted.
#   quad   THE FOUR-QUADRANT CERTIFICATION, on the FIXED bundle: the 5-state
#          matrix plus the deadlined and reminder arms, run in all four quadrants,
#          with every landed rule blob compared BYTE FOR BYTE across them, the
#          dialog census printed in each, and beeps counted.
#   teardown  stop + delete the clone (the EXIT trap does this anyway unless KEEP=1)
#
# METHOD: ONE disposable clone `defaults3-lab` of things-lab-golden-v4 (the golden
# is NEVER booted). Airgapped (default route deleted), guest clock pinned to
# 2026-07-05 12:00 BEFORE Things launches (trial wall 2026-07-18, never rolled),
# synthetic DEF3-* fixtures only. Ground truth = read-only guest SQLite via the
# rsum.py blob decoder; `open` exit 0 and CLI exit 0 prove nothing. Beeps counted
# by the guest sentinel (research driver: report-only). Teardown on EXIT (KEEP=1
# to hold the clone, REUSE=1 to re-attach).
#
# REPRODUCIBILITY: a clone is ~200x cheaper per element realized than the field
# and CANNOT reproduce field wall times (RDLAT2 §E's corollary). What transfers is
# the ORDER of the hops, which of them refuse, and what the shape probe read.
#
# Usage:  bash lab/scripts/research-defaults3.sh [cell...]      # default: repro
#         DISTSRC=/path/to/dist   the bundle to ship (default: ./dist)
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="defaults3-lab"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
CELLS="${*:-repro}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/trace" "$OUT/drive"
REPORT="$OUT/report.txt"
REUSE="${REUSE:-0}"
KEEP="${KEEP:-0}"
DISTSRC="${DISTSRC:-dist}"
TAGSFX="${TAGSFX:-}"
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[defaults3] $*" | tee -a "$REPORT"; }
notef() { echo "[defaults3] $*" >>"$REPORT"; echo "[defaults3] $*" >&2; }

case "$VM" in things-lab-golden-*) echo "refusing to touch a golden" >&2; exit 1 ;; esac

# THE TRIAL WALL (harness.md): golden-v4's trial dies 2026-07-18. This driver
# pins 2026-07-05 and never moves it; the constant is here so a future edit that
# reaches for a later date trips over it. A `--when` in September is a SCHEDULED
# DATE, not a clock, and rolls nothing.
TRIAL_WALL="2026-07-18"
PINNED="2026-07-05"

note "cells: $CELLS · golden: $GOLDEN · dist: $DISTSRC · reuse=$REUSE · clock pinned $PINNED (trial wall $TRIAL_WALL)"
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

# The rule-blob decoder (rsum.py, as DEFAULTS1/DEFAULTS2/NEXTPOP1 use it).
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
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
alive() { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null; }
ips_count() { lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3*.ips 2>/dev/null | wc -l | tr -d " "' </dev/null; }
rsum() { lab_ssh "$IP" "python3 ~/labh/rsum.py '$1' 2>&1" </dev/null; }
tmplid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
anyid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
ruleblob() { gq "SELECT quote(rt1_recurrenceRule) FROM TMTask WHERE uuid='$1'"; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; pkill -x Things3 >/dev/null 2>&1; sleep 2; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }

warm
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
DBV=$(gq "SELECT value FROM Meta WHERE key='databaseVersion'" 2>/dev/null)
note "env: Things $TVER ($TBLD) · macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) · dbv ${DBV:-?} · clock $(lab_ssh "$IP" date </dev/null)"

# Dismiss any NON-Repeat modal sheet standing on a Things window (DEFAULTS1
# §11.1 — a window census cannot see a sheet, so this walks for them).
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
  case "$r" in "no stray sheet") ;; *) note "    !! $r" ;; esac
}

# mkseed <title> <when-or-empty> <deadline-or-empty> -> uuid  (DEFAULTS2 §rig:
# the assignments are SPLIT so a `local` word list can never expand the caller's
# own `title`).
mkseed() {
  local title="$1"
  local when="$2"
  local dl="$3"
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

SHELL_PATH='sheet 1 of (first window whose subrole is "AXStandardWindow")'

select_item() {
  local uuid="$1" want="$2" i sel
  [ -n "$uuid" ] || { notef "  select_item REFUSED: empty uuid for '$want'"; return 1; }
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

openrepeat() {
  dismiss_alerts
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  lab_ssh "$IP" 'sleep 3' </dev/null
  axq "tell application \"System Events\" to tell process \"Things3\"
  try
    if (exists $SHELL_PATH) then return \"alive\"
  end try
  return \"gone\"
end tell"
}
esc() { axq 'tell application "System Events" to key code 53' >/dev/null; lab_ssh "$IP" 'sleep 1' </dev/null; }

########################################################################
# the bundle under test
########################################################################
ship_cli() {
  if [ ! -f "$DISTSRC/cli/main.js" ]; then note "  FATAL: $DISTSRC/cli/main.js missing"; return 1; fi
  local NODE_BIN COMMANDER_DIR
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO() { local a c; for a in 1 2 3 4 5; do sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; c=$?; [ "$c" -eq 0 ] && return 0; sleep 3; done; return "$c"; }
  note "  shipping the CLI bundle from $DISTSRC (node + dist + commander)…"
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null || { note "  FATAL node scp"; return 1; }
  COMMANDER_DIR=$(node -e "const p=require.resolve('commander'); console.log(p.slice(0, p.indexOf('/node_modules/commander/')+'/node_modules/commander'.length))")
  scpO -r "$COMMANDER_DIR" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null || { note "  FATAL commander scp"; return 1; }
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r "$DISTSRC" "admin@$IP:/Users/admin/things-lab/things-api/dist" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  CLI="~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js"
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
  lab_ssh "$IP" "$CLI config set helpers-enabled false" </dev/null >/dev/null 2>&1
  note "  cli: $(lab_ssh "$IP" "$CLI --version" </dev/null 2>&1 | tail -1)"
  # THE BUNDLE'S OWN FINGERPRINT, so a report can never be read against the wrong
  # dist. `unsettled` is the DEFAULTS3 verdict word: absent pre-fix, present after.
  note "  bundle: probe-poll=$(lab_ssh "$IP" 'grep -c unsettled ~/things-lab/things-api/dist/write/vectors/ui.js' </dev/null | tr -d "\r\n") (0 = PRE-FIX, >0 = FIXED)"
  return 0
}

########################################################################
# THE FOUR QUADRANTS of the drive's optional machinery
########################################################################
# obs = the settle sidecar (VOPAT2); pf = reliance on the dialog's pre-fill
# (DEFAULTS2). Each is switchable precisely so both halves can be certified, and
# this campaign's whole point is that the SWITCHES MULTIPLY.
QUADS="obs-pf obs-nopf poll-pf poll-nopf"
quad_env() {
  case "$1" in
    obs-pf)    echo "" ;;
    obs-nopf)  echo "THINGS_API_PREFILL=0" ;;
    poll-pf)   echo "THINGS_API_AX_OBSERVER=0" ;;
    poll-nopf) echo "THINGS_API_AX_OBSERVER=0 THINGS_API_PREFILL=0" ;;
    *) echo "unknown quadrant $1" >&2; return 1 ;;
  esac
}

# drive <quadrant> <artifact-id> -- <cli args...>: one traced drive, with the
# quadrant PROVED out of its own trace rather than assumed from the env.
drive() {
  local Q="$1" AID="$2"; shift 2
  local ENVV rc TF
  ENVV=$(quad_env "$Q") || return
  lab_ssh "$IP" 'rm -rf ~/.local/state/things-api/trace' </dev/null
  lab_ssh "$IP" "THINGS_API_TRACE=true THINGS_API_AX_COUNT=1 $ENVV $LAB_DIRECT $CLI $* --dangerously-drive-gui --verify-timeout 90000 --json" \
    </dev/null >"$OUT/drive/$Q-$AID.log" 2>&1
  rc=$?
  note "    exit $rc · verdict: $(grep -o -e '"ok":[a-z]*' -e '"status":"[a-z-]*"' "$OUT/drive/$Q-$AID.log" | head -3 | tr '\n' ' ')"
  local WHY
  WHY=$(python3 -c '
import json,re,sys
raw=open(sys.argv[1],encoding="utf-8",errors="replace").read()
m=re.search(r"\"(?:message|detail|reason)\":\"([^\"]{0,240})\"",raw)
print(m.group(1) if m else "")' "$OUT/drive/$Q-$AID.log")
  [ -n "$WHY" ] && note "    why: $WHY"
  TF=$(lab_ssh "$IP" 'cd ~/.local/state/things-api/trace 2>/dev/null && ls -t | head -1' </dev/null | tr -d '\r\n')
  if [ -n "$TF" ]; then
    lab_ssh "$IP" "cat ~/.local/state/things-api/trace/$(printf '%q' "$TF")" </dev/null > "$OUT/trace/$Q-$AID.jsonl" 2>/dev/null
    python3 lab/scripts/defaults3-ledger.py "$OUT/trace/$Q-$AID.jsonl" | sed 's/^/      /' | tee -a "$REPORT"
  else
    note "    NO trace file"
  fi
  dismiss_alerts
}

########################################################################
# REPRO — the field's own command shape, in all four quadrants
########################################################################
cell_repro() {
  note ""
  note "############ REPRO — the field's command shape x 4 quadrants ############"
  note "  the field: add-repeating --when 2026-09-28 --frequency weekly --interval 1"
  note "  expect: poll-* REFUSE at the shape probe on the pre-fix bundle; obs-* pass"
  ship_cli || return
  local Q T
  for Q in $QUADS; do
    T="DEF3-RP-$Q$TAGSFX"
    note ""
    note "  ---- $Q ----"
    beep_reset; beep_mark "$Q repro"
    warm
    dismiss_alerts
    drive "$Q" rp todo add-repeating "'$T'" --when 2026-09-28 --frequency weekly --interval 1
    note "    landed: $(rsum "$(tmplid "$T")")"
    note "    blob:   $(ruleblob "$(tmplid "$T")")"
    beep_assert "$Q repro"
  done
  note ""
  note "  crash=$(alive) ips=$(ips_count)"
}

########################################################################
# QUAD — the 5-state matrix + deadlined + reminder, in all four quadrants
########################################################################
cell_quad() {
  note ""
  note "############ QUAD — the state matrix x 4 quadrants ############"
  ship_cli || return
  local Q P S1 S2 S3 S6 T1
  for Q in $QUADS; do
    P="DEF3-ST-$Q$TAGSFX"
    note ""
    note "  ==== quadrant $Q ===="
    beep_reset

    # S1 FIXED — the "Every" label row with a monthly cadence group.
    note "  -- S1 fixed (monthly, interval 2) --"
    beep_mark "$Q S1"; warm
    S1=$(mkseed "${P}-s1" 2026-07-09 "") || { note "    no seed"; continue; }
    drive "$Q" s1 todo make-repeating "$S1" --when 2026-07-09 --frequency monthly --interval 2
    note "    S1 $(rsum "$(tmplid "${P}-s1")")"
    note "    S1 blob=$(ruleblob "$(tmplid "${P}-s1")")"

    # S2 AFTER-COMPLETION — the one-field group, and the one shape with no
    # `Next:` control at all (so no shape probe is emitted).
    note "  -- S2 after-completion (weekly, interval 3) --"
    beep_mark "$Q S2"; warm
    S2=$(mkseed "${P}-s2" "" "") || { note "    no seed"; continue; }
    drive "$Q" s2 todo make-repeating "$S2" --frequency weekly --interval 3 --after-completion
    note "    S2 $(rsum "$(tmplid "${P}-s2")")"
    note "    S2 blob=$(ruleblob "$(tmplid "${P}-s2")")"

    # S3 DEADLINES — the checkbox mints a shell-level field (#646), and the shape
    # the seed shaping acts on.
    note "  -- S3 deadlined (weekly, start 2 days earlier) --"
    beep_mark "$Q S3"; warm
    S3=$(mkseed "${P}-s3" 2026-07-09 "") || { note "    no seed"; continue; }
    drive "$Q" s3 todo make-repeating "$S3" --when 2026-07-09 --frequency weekly --interval 1 --deadline --start-days-earlier 2
    note "    S3 $(rsum "$(tmplid "${P}-s3")")"
    note "    S3 blob=$(ruleblob "$(tmplid "${P}-s3")")"

    # S4 ENDS-COUNT (HXPC1) — a RESCHEDULE, whose dialog opens PRE-POPULATED from
    # the existing rule. It gets no pre-fill reliance at all (DEFAULTS1 §9.5) and
    # is the arm that proves a probe taken before the frequency selection would
    # have measured the OUTGOING dialog.
    note "  -- S4 ends-after reschedule (daily, interval 3, ends after 4) --"
    beep_mark "$Q S4"; warm
    T1=$(tmplid "${P}-s1")
    drive "$Q" s4 todo reschedule-repeat "$T1" --frequency daily --interval 3 --ends-after 4
    note "    S4 $(rsum "$T1")"
    note "    S4 blob=$(ruleblob "$T1")"

    # S5 PAUSED — the pause/resume pair through a different menu path (no dialog).
    note "  -- S5 pause + resume --"
    beep_mark "$Q S5"; warm
    drive "$Q" s5a todo pause-repeat "$T1"
    note "    S5 pause $(rsum "$T1")"
    drive "$Q" s5b todo resume-repeat "$T1"
    note "    S5 resume $(rsum "$T1")"

    # S6 REMINDER — add-repeating, so the seed is minted with the reminder on it
    # by the shipped composite rather than by this driver.
    note "  -- S6 reminder (add-repeating, weekly, 09:30) --"
    beep_mark "$Q S6"; warm
    drive "$Q" s6 todo add-repeating "'${P}-s6'" --when 2026-07-09 --reminder 09:30 --frequency weekly --interval 1
    note "    S6 $(rsum "$(tmplid "${P}-s6")")"
    note "    S6 blob=$(ruleblob "$(tmplid "${P}-s6")")"

    # The dialog census is its own cell (`census`), because it needs a PLAIN
    # fixture — one this cell's own drives have not already promoted, or
    # `Items ▸ Repeat…` opens over a template and the shape under census is not
    # the one a promote drives.

    beep_assert "$Q states"
  done

  note ""
  note "  ---- RULE BLOBS ACROSS THE QUADRANTS (expect byte-identical per arm) ----"
  local a ref cur bad=0
  for a in s1 s2 s3 s6; do
    ref=""
    for Q in $QUADS; do
      cur=$(ruleblob "$(tmplid "DEF3-ST-$Q$TAGSFX-$a")")
      note "    $a $Q = $cur"
      if [ -z "$ref" ]; then ref="$cur"; elif [ "$cur" != "$ref" ]; then bad=1; fi
    done
    if [ "$bad" = "1" ]; then note "    !! $a DIFFERS ACROSS QUADRANTS"; bad=0; else note "    ^ $a identical across all four"; fi
  done
  note "  crash=$(alive) ips=$(ips_count)"
}

########################################################################
# CENSUS — the window/focus census in every quadrant (RDLAT2's census law)
########################################################################
# A change to what the driver READS is certified by a cell that READS IT BACK,
# in every quadrant and with the dialog both open and closed — never by the
# drives that ride it (RDLAT2: an every-Repeat-dialog-censuses-as-"other" bug
# passed all five state drives, because the guard had latched the wrong kind
# too). This campaign changes what ONE read does, so the census must not move.
cell_census() {
  note ""
  note "############ CENSUS — doctor --ui-state x 4 quadrants ############"
  ship_cli || return
  local Q ENVV T U
  for Q in $QUADS; do
    ENVV=$(quad_env "$Q") || return
    T="DEF3-CEN-$Q$TAGSFX"
    note ""
    note "  ==== $Q ===="
    uistate() {
      lab_ssh "$IP" "$ENVV $LAB_DIRECT $CLI doctor --ui-state --json" </dev/null 2>/dev/null | tail -1 \
        | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]["uiState"]; s=d.get("state",{}); print(json.dumps({k:s[k] for k in sorted(s)}))' 2>/dev/null
    }
    beep_reset; beep_mark "$Q census"
    warm
    U=$(mkseed "$T" 2026-07-09 "") || { note "    no seed"; continue; }
    note "    no dialog  : $(uistate)"
    select_item "$U" "$T" >/dev/null || note "    !! selection did not land"
    note "    repeat dialog: $(openrepeat)"
    note "    dialog open: $(uistate)"
    esc; dismiss_alerts
    beep_assert "$Q census"
  done
  note "  crash=$(alive) ips=$(ips_count)"
}

########################################################################
for c in $CELLS; do
  case "$c" in
    repro) cell_repro ;;
    quad) cell_quad ;;
    census) cell_census ;;
    teardown) note "teardown requested — the EXIT trap destroys $VM"; KEEP=0 ;;
    *) note "unknown cell: $c" ;;
  esac
done
note ""
note "report: $REPORT · traces: $OUT/trace/ · drives: $OUT/drive/"
