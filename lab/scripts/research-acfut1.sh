#!/bin/bash
# ACFUT1 — the future-anchored after-completion series: when does its FIRST
# occurrence actually appear?
#
# VMRES1 §1 measured the AT-REST state of a future-anchored after-completion
# promote (next = the requested date verbatim, icStart = today+1, icCount = 0,
# ZERO instances) and then tore its clone down. So the promise the shipped
# surface is about to make to callers —
#
#     "no instance yet — the first occurrence appears <the cursor date>"
#
# is UNPINNED: nobody has rolled the guest clock TO that date and looked.
#
# THE TRIAL WALL (harness.md): golden-v4's firstAppLaunchDate is 2026-07-03
# 03:14 UTC with a 15-day window, so 2026-07-18 is the wall. The brief's dates
# (2026-07-20 / 07-21) are PAST it — a roll there raises "Your Trial Period Has
# Ended", the app runs read-only and STOPS SPAWNING, which is indistinguishable
# from the very finding this campaign is looking for (REPX3 shipped a fake
# "the series stops spawning" result exactly this way). The cells are therefore
# RE-ANCHORED inside the wall — 2026-07-10 / 07-11 instead of 07-20 / 07-21 —
# which changes nothing structural: the anchor is still strictly in the future
# relative to the pinned clock, which is the whole content of the question.
# Cell V keeps VMRES1's VERBATIM 07-20 date for the at-rest reproduction, since
# that cell never rolls.
#
# METHOD: ONE disposable clone `acfut1-lab` of things-lab-golden-v4 (the golden
# is NEVER booted). Airgapped (default route deleted, ping asserted to fail),
# guest clock pinned to 2026-07-05 12:00 BEFORE Things launches. Ground truth =
# read-only guest SQLite; CLI exit 0 and `open` exit 0 prove nothing on their
# own. Synthetic ACFUT1-* fixtures only. Teardown on EXIT (KEEP=1 holds it).
#
# Usage:  bash lab/scripts/research-acfut1.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="acfut1-lab"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "[acfut1] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"

# DIST — the fixture-building CLI. This worktree carries the maintainer's
# in-flight (non-compiling) src/write edits, so the build MUST come from a clean
# tree; DIST points at one built from the released HEAD.
DIST="${DIST:-dist}"

case "$VM" in things-lab-golden-*) echo "refusing to touch a golden" >&2; exit 1 ;; esac

# ---- the trial-wall guard (REPX3's rule: refuse the roll, never trust the operator)
TRIAL_WALL="20260718"

note "golden: $GOLDEN · dist: $DIST · trial wall: $TRIAL_WALL"

# ---- wait politely for a VM slot (2-VM ceiling; a sibling agent may hold one)
for attempt in $(seq 1 60); do
  RUNNING=$(tart list 2>/dev/null | awk '$NF=="running"' | grep -cv "^$" || true)
  [ "${RUNNING:-2}" -lt 2 ] && break
  note "  $RUNNING/2 VM slots busy — waiting (attempt $attempt/60)"
  sleep 30
done
RUNNING=$(tart list 2>/dev/null | awk '$NF=="running"' | grep -cv "^$" || true)
[ "${RUNNING:-2}" -lt 2 ] || { note "FATAL: no VM slot after 30min"; exit 1; }

tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 360) || { note "FATAL: no SSH"; exit 1; }
note "ssh up at $IP"

cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — $VM left running at $IP"; return; fi
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "teardown done"
}
trap cleanup EXIT

# ---- airgap + clock pin, BEFORE Things is ever launched -----------------------
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AIRGAP=$(lab_ssh "$IP" 'ping -c1 -t3 1.1.1.1 >/dev/null 2>&1 && echo REACHABLE || echo UNREACHABLE' </dev/null)
note "airgap: 1.1.1.1 is $AIRGAP"
[ "$AIRGAP" = "UNREACHABLE" ] || { note "FATAL: clone still reaches the internet"; exit 1; }
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
note "clock pinned: $(lab_ssh "$IP" date </dev/null)"

# ---- guest helpers ------------------------------------------------------------
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-noheader -list); if [ "$1" = "-t" ]; then FMT=(-header -column); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF

# rsum.py — the VMRES1 decoder, EXTENDED with rt1_afterCompletionReferenceDate
# (the after-completion anchor, REPX1 §2.5; not in the depended-column manifest,
# and never selected by VMRES1's helper — its at-rest value is what this
# campaign was asked to capture).
lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationCount, deadline, rt1_instanceCreationStartDate, rt1_instanceCreationPaused, rt1_afterCompletionReferenceDate FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row: print("NO-ROW"); sys.exit(0)
if row[0] is None: print("NO-RULE paused=%s"%row[5]); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s ed=%s of=[%s] next=%s icStart=%s icCount=%s acRef=%s paused=%s deadline=%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),d.get('ed'),",".join(offs),
    dpk(row[1]),dpk(row[4]),row[2],dpk(row[6]),row[5],row[3]))
EOF

# the beep sentinel (harness §The beep sentinel) — post-hoc, no live listener
lab_scp lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/labh/beep-sentinel.sh" >/dev/null
lab_ssh "$IP" 'chmod +x ~/labh/beep-sentinel.sh' </dev/null
beep_reset() { lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null 2>&1; }
beep_mark()  { lab_ssh "$IP" "~/labh/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }
beep_assert() {
  lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/labh/beep-sentinel.sh assert --name $(printf '%q' "$1")" \
    </dev/null 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
}
note "helpers installed"

# ---- ship the shipped CLI (node + dist + commander) --------------------------
[ -f "$DIST/cli/main.js" ] || { note "FATAL: $DIST/cli/main.js missing"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { local a c; for a in 1 2 3 4 5; do sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; c=$?; [ "$c" -eq 0 ] && return 0; sleep 3; done; return "$c"; }
lab_ssh "$IP" true </dev/null; sleep 2
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null || { note "FATAL node scp"; exit 1; }
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r "$DIST" "admin@$IP:/Users/admin/things-lab/things-api/dist" >/dev/null
COMMANDER_DIR=$(node -e "const p=require.resolve('commander'); console.log(p.slice(0, p.indexOf('/node_modules/commander/')+'/node_modules/commander'.length))")
scpO -r "$COMMANDER_DIR" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null || { note "FATAL commander scp"; exit 1; }
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
# THE LAB ESCAPES (harness §The lab escapes): a clone has no bundle id, so the
# AppleScript vector reads direct-unknown and every composite with an
# AppleScript leg (add-repeating / make-repeating) refuses blocked:environment.
CLI="$LAB_DIRECT ~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js"
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1

VER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
BLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
TRIAL=$(lab_ssh "$IP" 'defaults read com.culturedcode.ThingsMac firstAppLaunchDate 2>/dev/null || echo "?"' </dev/null)
lab_ssh "$IP" 'open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null
gq() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
note "env: Things $VER ($BLD) · dbv $(gq 'SELECT databaseVersion FROM Meta') · macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)"
note "trial firstAppLaunchDate: $TRIAL"

# ---- shared helpers -----------------------------------------------------------
rsum() { lab_ssh "$IP" "python3 ~/labh/rsum.py '$1' 2>&1" </dev/null; }
settle() { lab_ssh "$IP" "sleep ${1:-3}" </dev/null; }
alive() { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null; }
ips_count() { lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3*.ips 2>/dev/null | wc -l | tr -d " "' </dev/null; }

notef() { echo "[acfut1] $*" >>"$REPORT"; echo "[acfut1] $*" >&2; }
cli() {
  local tag="$1"; shift
  lab_ssh "$IP" "$CLI $*" </dev/null >"$OUT/cli-$tag.out" 2>&1
  local rc=$?
  notef "    \$ things $* -> exit $rc"
  echo "$rc"
}
clitail() { sed 's/^/      | /' "$OUT/cli-$1.out" | head -"${2:-24}" | tee -a "$REPORT"; }

tmplid() { lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1\"" </dev/null; }
plainid() { lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1\"" </dev/null; }
# NOTE: the nested-quoting shape VMRES1 used returns EMPTY here (the inner
# single quotes are eaten before sqlite sees them), which is why the live run's
# per-row detail was captured by the read-only side-car
# `lab/scripts/acfut1-rowwatch.sh` instead. Fixed to a heredoc-free double-quoted
# form so a re-run needs no side-car.
instrows() { lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid||' sd='||IFNULL(startDate,'-')||' status='||status||' trashed='||trashed||' created='||IFNULL(creationDate,'-') FROM TMTask WHERE rt1_repeatingTemplate='$1'\"" </dev/null | tr '\n' ' '; }
instcount() { lab_ssh "$IP" "~/labh/gsql.sh \"SELECT count(*) FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0\"" </dev/null; }
dpk() { python3 -c 'v=int('"$1"');print("%04d-%02d-%02d"%(v>>16,(v>>12)&0xF,(v>>7)&0x1F) if v else v)' 2>/dev/null; }

# THE TRIAL-WALL GUARD. Refuses the roll rather than trusting the caller.
setclock() {
  local ymd="$1" stamp="$2"
  if [ "$ymd" -ge "$TRIAL_WALL" ]; then
    note "  REFUSED clock roll to $ymd — golden-v4's trial wall is $TRIAL_WALL (harness.md THE TRIAL WALL)"
    return 1
  fi
  lab_ssh "$IP" "sudo date $stamp >/dev/null" </dev/null
  note "  clock -> $(lab_ssh "$IP" date </dev/null)"
}
# Roll order: kill Things FIRST, set the clock, THEN launch — a clone's clock
# must be pinned before Things is launched on EVERY boot (harness/SYNCX1), and a
# modal survives a graceful quit, so pkill (URLEN1) not `tell … to quit`.
kill_things() { lab_ssh "$IP" 'pkill -x Things3; sleep 4' </dev/null; }
launch_things() { lab_ssh "$IP" 'open -a Things3; sleep 16; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
# The trial dialog is a SHEET, and a window census cannot see one (URLEN1).
trial_check() {
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to get value of static text of every sheet of every window'\'' 2>&1' </dev/null | tr -d '\n' | cut -c1-300
}

# read <label> — the full state of every fixture, in one place
readall() {
  note "  ---- STATE @ $(lab_ssh "$IP" 'date "+%Y-%m-%d %H:%M"' </dev/null) — $1 ----"
  local name uid
  for name in V R R2 C A2B; do
    eval "uid=\${T_$name:-}"
    [ -n "$uid" ] || continue
    note "    ACFUT1-$name  $(rsum "$uid")"
    note "      instances(non-trashed)=$(instcount "$uid")  rows: $(instrows "$uid" | tr '\n' ' ')"
  done
  note "    app=$(alive) ips=$(ips_count) trial-sheet=$(trial_check)"
}

########################################################################
# BUILD — all five fixtures on the pinned 2026-07-05 clock
########################################################################
beep_reset; beep_mark "build"
note ""
note "################ BUILD (clock 2026-07-05, a Sunday) ################"

rc=$(cli b-V todo add-repeating "'ACFUT1-V'" --after-completion --frequency weekly --interval 1 \
      --when 2026-07-20 --dangerously-drive-gui --verify-timeout 90000)
clitail b-V 12
T_V=$(tmplid ACFUT1-V); note "  V (VMRES1-verbatim, 07-20) template=$T_V exit=$rc"

beep_mark "build R"
rc=$(cli b-R todo add-repeating "'ACFUT1-R'" --after-completion --frequency weekly --interval 1 \
      --when 2026-07-10 --dangerously-drive-gui --verify-timeout 90000)
clitail b-R 12
T_R=$(tmplid ACFUT1-R); note "  R (rollable, 07-10) template=$T_R exit=$rc"

beep_mark "build R2"
rc=$(cli b-R2a todo add "'ACFUT1-R2'" --when 2026-07-11)
S_R2=$(plainid ACFUT1-R2)
rc=$(cli b-R2b todo make-repeating "$S_R2" --after-completion --frequency weekly --interval 1 \
      --dangerously-drive-gui --verify-timeout 90000)
clitail b-R2b 12
T_R2=$(tmplid ACFUT1-R2); note "  R2 (make-repeating, 07-11) template=$T_R2 exit=$rc"

beep_mark "build C"
# THE POSITIVE CONTROL. A negative from an oracle never shown a positive is not
# evidence (CNCAC1/URLEN1). C is a FIXED-rule series anchored on the SAME future
# date as R, so if the roll spawns C and not R the discrimination is real; if it
# spawns neither, the roll itself is the thing that failed.
rc=$(cli b-C todo add-repeating "'ACFUT1-C'" --frequency weekly --interval 1 \
      --when 2026-07-10 --dangerously-drive-gui --verify-timeout 90000)
clitail b-C 12
T_C=$(tmplid ACFUT1-C); note "  C (FIXED-rule control, 07-10) template=$T_C exit=$rc"

beep_mark "build A2B"
# A2b — a PAST-dated source promoted on the 07-05 clock. Completely unpinned.
rc=$(cli b-A2Ba todo add "'ACFUT1-A2B'" --when 2026-07-01)
S_A2B=$(plainid ACFUT1-A2B)
note "  A2B seed=$S_A2B startDate=$(dpk "$(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT IFNULL(startDate,0) FROM TMTask WHERE uuid='$S_A2B'\"" </dev/null)")"
rc=$(cli b-A2Bb todo make-repeating "$S_A2B" --after-completion --frequency weekly --interval 1 \
      --dangerously-drive-gui --verify-timeout 90000)
clitail b-A2Bb 12
T_A2B=$(tmplid ACFUT1-A2B); note "  A2B (past-dated source, 07-01) template=$T_A2B exit=$rc"

settle 5
readall "AT REST, clock 2026-07-05"
beep_assert build

########################################################################
# ROLL 1 — to 2026-07-10, R's and C's cursor date
########################################################################
note ""
note "################ ROLL 1 -> 2026-07-10 (R's requested date) ################"
kill_things
setclock 20260710 071012002026 || { note "FATAL: roll refused"; exit 1; }
beep_reset; beep_mark "roll1 pre-launch"
# read BEFORE the relaunch: does the spawn need a launch, or only a date change?
readall "clock 2026-07-10, Things NOT running"
launch_things
settle 10
beep_mark "roll1 post-launch"
readall "clock 2026-07-10, after warm relaunch"
beep_assert roll1

########################################################################
# ROLL 2 — to 2026-07-11 (R is one day PAST its date; R2 is ON its date)
########################################################################
note ""
note "################ ROLL 2 -> 2026-07-11 (R+1; R2's requested date) ################"
kill_things
setclock 20260711 071112002026 || { note "FATAL: roll refused"; exit 1; }
beep_reset; beep_mark "roll2 pre-launch"
readall "clock 2026-07-11, Things NOT running"
launch_things
settle 10
beep_mark "roll2 post-launch"
readall "clock 2026-07-11, after warm relaunch"
beep_assert roll2

note ""
note "==== DONE — report: $REPORT ===="
