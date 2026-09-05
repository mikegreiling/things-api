#!/bin/bash
# DLSEED1 — THE DEADLINED SOURCE: what the GUI does with it, and whether we do
# the same (maintainer ruling 2026-09-02, implemented 2026-09-05; DEFAULTS2 §6).
#
# THE DEFECT DEFAULTS2 FOUND AND DID NOT FIX. `things todo make-repeating <a
# to-do that already carries a deadline>`, with no --deadline in the request,
# landed a DEADLINED series with a back-shifted first occurrence and exited 3:
#
#   seed: startDate=2026-07-09 deadline=2026-07-12 · make-repeating weekly/1
#   landed: ts=-3 of=[{wd=…}] next=2026-07-06 icStart=2026-07-06, deadline sentinel
#   exit 3 · verify-failed:mismatch — "its first occurrence landed on 2026-07-06,
#            not the requested 2026-07-09"
#
# The write was the app's own default; the EXPECTATION was wrong. `make-repeating`
# CLONES its seed, so the dialog opens on a deadlined row: "Add deadlines" ticked,
# the offset pre-filled with (deadline − start), the whole cadence row anchored on
# the DUE date (DEFAULTS1 §4 S11). We asked for a rule that said nothing about a
# deadline, so the recipe left those controls alone — correctly, it is
# requested-fields-only — the pre-fill rode into the committed rule, and our own
# oracle called the result a mismatch.
#
# THE RULING: *"We should do whatever the GUI does by default. If promoting a todo
# to a recurring todo pre-fills the deadline value, that should act as our default
# as well, unless we override it with our own --deadline."*
#
# SO THE ORACLE HERE IS THE APP ITSELF. Cell `oracle` drives the dialog BY HAND —
# select the to-do, open Repeat…, choose `weekly`, touch nothing else, press OK —
# and records what Things committed. Cell `cli` runs the shipped verb over an
# IDENTICAL seed and the two landings are compared field by field. A pass is not
# "exit 0"; a pass is "exit 0 AND the same rule the app writes for a person".
#
# CELLS
#   oracle    the GUI's own answer (dialog pre-fill read, then OK, nothing else)
#   cli       the shipped verb on the same seed shape; compared to the oracle
#   override  --deadline --start-days-earlier 7: the CALLER's geometry wins
#   zero      --deadline --start-days-earlier 0: due on its start date (the
#             pre-filled 3 must be TYPED away, not inherited)
#   backwards a deadline BEFORE the start: the dialog discards it, so nothing is
#             inherited (S12 / oddities §31)
#   control   a deadline-FREE seed: unchanged behavior, the regression guard
#   closedwin THE REOPEN RUNG on the dialog-class side (the 2026-09-05 ruling
#             extending LOCKSCR2): ⌘W the Things window on an UNLOCKED guest,
#             then promote — the verb must reopen the window, land, and SAY the
#             window was left open
#   teardown  stop + delete the clone (the EXIT trap does this anyway unless KEEP=1)
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, guest clock pinned to 2026-07-05 12:00 BEFORE Things
# launches (trial wall 2026-07-18), synthetic DLS1-* fixtures only. Ground truth
# = read-only guest SQLite through the rsum.py blob decoder; `open` exit 0 and CLI
# exit 0 prove nothing.
#
# THE ROUTED ARM is the same shapes through the deputy:
#   RC_DIST=dist GUEST_CELLS=lab/guest/dlseed1-cells.sh bash lab/scripts/stage5-rc-run.sh
#
# Usage:  bash lab/scripts/research-dlseed1.sh [cell...]   # default: all
#         DISTSRC=/path/to/dist   the bundle to ship (default: ./dist)
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="dlseed1-lab"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
CELLS="${*:-oracle cli override zero backwards control closedwin}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/drive"
REPORT="$OUT/report.txt"
REUSE="${REUSE:-0}"
KEEP="${KEEP:-0}"
DISTSRC="${DISTSRC:-dist}"
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[dlseed1] $*" | tee -a "$REPORT"; }
notef() { echo "[dlseed1] $*" >>"$REPORT"; echo "[dlseed1] $*" >&2; }

case "$VM" in things-lab-golden-*) echo "refusing to touch a golden" >&2; exit 1 ;; esac

TRIAL_WALL="2026-07-18"
PINNED="2026-07-05"
# The fixture geometry, one place: a start three days before its deadline.
SEED_START="2026-07-09"
SEED_DEADLINE="2026-07-12"

note "cells: $CELLS · golden: $GOLDEN · dist: $DISTSRC · clock pinned $PINNED (trial wall $TRIAL_WALL)"

if [ "$REUSE" = "1" ]; then
  IP=$(tart ip "$VM" 2>/dev/null) || { note "FATAL: $VM is not running"; exit 1; }
  [ -n "$IP" ] || { note "FATAL: no IP for $VM"; exit 1; }
  note "re-attached to $VM at $IP"
else
  RUNNING=$(tart list | awk 'NR>1 && $NF=="running" {print $2}' | tr '\n' ' ')
  [ -n "$RUNNING" ] && { note "FATAL: another VM is running ($RUNNING) — never a second concurrent clone"; exit 1; }
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  cleanup() {
    if [ "$KEEP" = "1" ]; then note "KEEP=1 — $VM left running"; return; fi
    tart stop "$VM" >/dev/null 2>&1 || true
    tart delete "$VM" >/dev/null 2>&1 || true
    note "teardown done · remaining VMs: $(tart list | tail -n +2 | awk '{print $2}' | tr '\n' ' ')"
  }
  # ARMED BEFORE THE BOOT WAIT, never after: a wait that times out with the trap
  # uninstalled leaves a 50 GB clone running (PROVREM1 §7.2).
  trap cleanup EXIT
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 600) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"
fi

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

# THE RULE HALF ONLY — the fields two different rows can be compared on. The
# per-row tail (uuid-bearing dates, status, the row's own deadline byte) is
# printed but never compared: the oracle keeps its seed row and the CLI promotes
# a clone, so those differ by construction and would mask the comparison.
lab_ssh "$IP" 'cat > ~/labh/rulehalf.py' <<'EOF'
import sys
line = sys.stdin.read().strip()
print(line.split(" | ROW ")[0])
EOF

gq() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
rsum() { lab_ssh "$IP" "python3 ~/labh/rsum.py '$1' 2>&1" </dev/null; }
rulehalf() { rsum "$1" | sed 's/ | ROW .*//'; }
anyid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
tmplid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
ruleblob() { gq "SELECT quote(rt1_recurrenceRule) FROM TMTask WHERE uuid='$1'"; }
alive() { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; pkill -x Things3 >/dev/null 2>&1; sleep 2; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }

warm
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
DBV=$(gq "SELECT value FROM Meta WHERE key='databaseVersion'" 2>/dev/null)
note "env: Things $TVER ($TBLD) · macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) · dbv ${DBV:-?} · clock $(lab_ssh "$IP" date </dev/null)"

SHELL_PATH='sheet 1 of (first window whose subrole is "AXStandardWindow")'

mkseed() {
  local title="$1" when="$2" dl="$3" u i
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

select_item() {
  local uuid="$1" want="$2" i sel
  [ -n "$uuid" ] || { notef "  select_item REFUSED: empty uuid for '$want'"; return 1; }
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
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  lab_ssh "$IP" 'sleep 3' </dev/null
  axq "tell application \"System Events\" to tell process \"Things3\"
  try
    if (exists $SHELL_PATH) then return \"alive\"
  end try
  return \"gone\"
end tell"
}

# The deadline row + cadence, read from the SHELL without touching either
# (DEFAULTS2's readdl).
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
  set iv to \"(none)\"
  try
    set iv to (value of text field 1 of group 1 of sh) as text
  end try
  set nx to \"(none)\"
  try
    set nx to (value of pop up button 2 of group 1 of sh) as text
  end try
  return \"freq=\" & freq & \" interval=\" & iv & \" next=\" & nx & \" addDeadlines=\" & cbv & \" startEarlier=\" & ofsv
end tell"
}

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
  delay 1.5
  return (value of p) as text
end tell"
}

pressok() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  click button \"OK\" of $SHELL_PATH
  delay 3
  return \"OK pressed\"
end tell"
}

########################################################################
# the bundle under test
########################################################################
ship_cli() {
  if [ ! -f "$DISTSRC/cli/main.js" ]; then note "  FATAL: $DISTSRC/cli/main.js missing"; return 1; fi
  local NODE_BIN COMMANDER_DIR
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  COMMANDER_DIR=$(lab_commander_dir)
  [ -d "$COMMANDER_DIR" ] || { note "  FATAL: commander not resolvable"; return 1; }
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO() { local a c; for a in 1 2 3 4 5; do sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; c=$?; [ "$c" -eq 0 ] && return 0; sleep 3; done; return "$c"; }
  note "  shipping the CLI bundle from $DISTSRC (node + dist + commander)…"
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null || { note "  FATAL node scp"; return 1; }
  scpO -r "$COMMANDER_DIR" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null || { note "  FATAL commander scp"; return 1; }
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r "$DISTSRC" "admin@$IP:/Users/admin/things-lab/things-api/dist" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  CLI="~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js"
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
  lab_ssh "$IP" "$CLI config set helpers-enabled false" </dev/null >/dev/null 2>&1
  note "  cli: $(lab_ssh "$IP" "$CLI --version" </dev/null 2>&1 | tail -1)"
  return 0
}

# promote <artifact-id> <uuid> -- <extra cli args...>: the shipped verb, direct.
promote() {
  local AID="$1" UUID="$2"; shift 2
  lab_ssh "$IP" "$LAB_DIRECT $CLI todo make-repeating $UUID --frequency weekly --interval 1 $* --dangerously-drive-gui --verify-timeout 90000 --json" \
    </dev/null >"$OUT/drive/$AID.log" 2>&1
  local rc=$?
  # notef, never note: this function's STDOUT is its exit code, and a `note`
  # here would be captured by `rc=$(promote …)` along with it.
  notef "    exit $rc"
  head -c 700 "$OUT/drive/$AID.log" | sed 's/^/      /' >>"$REPORT"
  echo "$rc"
}

ORACLE_RULE_FILE="$OUT/oracle-rule.txt"

########################################################################
run_oracle() {
  note ""
  note "===== oracle — THE APP'S OWN ANSWER: dialog opened, weekly chosen, OK ====="
  local u
  u=$(mkseed "DLS1-ORACLE" "$SEED_START" "$SEED_DEADLINE") || { note "  FATAL: no seed"; return 1; }
  note "  seed $u (start $SEED_START, deadline $SEED_DEADLINE): $(rsum "$u")"
  select_item "$u" "DLS1-ORACLE" || { note "  FATAL: could not select the seed"; return 1; }
  local st
  st=$(openrepeat)
  [ "$st" = "alive" ] || { note "  FATAL: the Repeat dialog did not open ($st)"; return 1; }
  note "  dialog AS OPENED:   $(readdl)"
  note "  frequency pop-up -> $(setpop "pop up button 1 of $SHELL_PATH" "weekly")"
  note "  dialog BEFORE OK:   $(readdl)"
  note "  $(pressok)"
  lab_ssh "$IP" 'sleep 4' </dev/null
  note "  app: $(alive)"
  local t
  t=$(tmplid "DLS1-ORACLE")
  [ -n "$t" ] || { note "  FATAL: no template minted"; return 1; }
  rulehalf "$t" >"$ORACLE_RULE_FILE"
  note "  ORACLE rule:  $(cat "$ORACLE_RULE_FILE")"
  note "  ORACLE row:   $(rsum "$t")"
  note "  ORACLE blob:  $(ruleblob "$t")"
}

run_cli() {
  note ""
  note "===== cli — THE SHIPPED VERB on the same seed shape ====="
  ship_cli || return 1
  local u rc t
  u=$(mkseed "DLS1-CLI" "$SEED_START" "$SEED_DEADLINE") || { note "  FATAL: no seed"; return 1; }
  note "  seed $u: $(rsum "$u")"
  rc=$(promote "cli" "$u")
  t=$(tmplid "DLS1-CLI")
  [ -n "$t" ] || { note "  FAIL: no template minted"; return 1; }
  note "  CLI rule:     $(rulehalf "$t")"
  note "  CLI row:      $(rsum "$t")"
  note "  CLI blob:     $(ruleblob "$t")"
  local verdict="?"
  if [ "$rc" != "0" ]; then
    verdict="FAIL (exit $rc — the ruling says this shape must exit 0)"
  elif [ -f "$ORACLE_RULE_FILE" ] && [ "$(rulehalf "$t")" = "$(cat "$ORACLE_RULE_FILE")" ]; then
    verdict="PASS — exit 0 and the rule is byte-for-byte the GUI's own"
  elif [ -f "$ORACLE_RULE_FILE" ]; then
    verdict="DIFFERS from the GUI oracle"
    note "    oracle: $(cat "$ORACLE_RULE_FILE")"
    note "    cli:    $(rulehalf "$t")"
  else
    verdict="exit $rc (no oracle recorded in this run — run the oracle cell too)"
  fi
  note "  VERDICT: $verdict"
  note "  disclosure: $(python3 -c '
import json,sys
try:
    d=json.load(open(sys.argv[1]))
    print(" | ".join((d.get("data") or {}).get("notes") or []) or "(none)")
except Exception as e:
    print("(unreadable: %s)" % e)
' "$OUT/drive/cli.log")"
}

run_override() {
  note ""
  note "===== override — --deadline --start-days-earlier 7 beats the seed's own 3 ====="
  ship_cli >/dev/null || return 1
  local u rc t
  u=$(mkseed "DLS1-OVR" "$SEED_START" "$SEED_DEADLINE") || { note "  FATAL: no seed"; return 1; }
  rc=$(promote "override" "$u" --deadline --start-days-earlier 7)
  t=$(tmplid "DLS1-OVR")
  [ -n "$t" ] || { note "  FAIL: no template minted"; return 1; }
  note "  rule: $(rsum "$t")"
  note "  want: exit 0 · ts=-7 · icStart=$SEED_START"
}

run_zero() {
  note ""
  note "===== zero — --deadline --start-days-earlier 0: due ON its start date ====="
  ship_cli >/dev/null || return 1
  local u rc t
  u=$(mkseed "DLS1-ZERO" "$SEED_START" "$SEED_DEADLINE") || { note "  FATAL: no seed"; return 1; }
  rc=$(promote "zero" "$u" --deadline --start-days-earlier 0)
  t=$(tmplid "DLS1-ZERO")
  [ -n "$t" ] || { note "  FAIL: no template minted"; return 1; }
  note "  rule: $(rsum "$t")"
  note "  want: exit 0 · ts=0 (the pre-filled 3 TYPED away) · icStart=$SEED_START"
}

run_backwards() {
  note ""
  note "===== backwards — a deadline BEFORE the start is not inherited (S12) ====="
  ship_cli >/dev/null || return 1
  local u rc t
  u=$(mkseed "DLS1-BACK" "$SEED_DEADLINE" "$SEED_START") || { note "  FATAL: no seed"; return 1; }
  note "  seed: $(rsum "$u")"
  rc=$(promote "backwards" "$u")
  t=$(tmplid "DLS1-BACK")
  [ -n "$t" ] || { note "  FAIL: no template minted"; return 1; }
  note "  rule: $(rsum "$t")"
  note "  want: exit 0 · ts=0 · icStart=$SEED_DEADLINE (the start; the dialog discards the earlier deadline)"
}

run_control() {
  note ""
  note "===== control — a deadline-FREE seed is unchanged (the regression guard) ====="
  ship_cli >/dev/null || return 1
  local u rc t
  u=$(mkseed "DLS1-CTRL" "$SEED_START" "") || { note "  FATAL: no seed"; return 1; }
  rc=$(promote "control" "$u")
  t=$(tmplid "DLS1-CTRL")
  [ -n "$t" ] || { note "  FAIL: no template minted"; return 1; }
  note "  rule: $(rsum "$t")"
  note "  want: exit 0 · ts=0 · no deadline · icStart=$SEED_START"
}

run_closedwin() {
  note ""
  note "===== closedwin — a CLOSED window is reopened, not refused (LOCKSCR2 rung) ====="
  ship_cli >/dev/null || return 1
  local u rc t wins_before wins_after
  u=$(mkseed "DLS1-WIN" "$SEED_START" "") || { note "  FATAL: no seed"; return 1; }
  # ⌘W the window the way the operator did in #732 — the app stays running with
  # only the background placeholder, on a session that is plainly unlocked.
  axq 'tell application "Things3" to activate' >/dev/null
  lab_ssh "$IP" 'sleep 1' </dev/null
  axq 'tell application "System Events" to keystroke "w" using command down' >/dev/null
  lab_ssh "$IP" 'sleep 2' </dev/null
  wins_before=$(axq 'tell application "System Events" to tell process "Things3" to return (count of (windows whose subrole is "AXStandardWindow")) as text')
  note "  standard windows after ⌘W: $wins_before (want 0)"
  rc=$(promote "closedwin" "$u")
  wins_after=$(axq 'tell application "System Events" to tell process "Things3" to return (count of (windows whose subrole is "AXStandardWindow")) as text')
  t=$(tmplid "DLS1-WIN")
  note "  standard windows after the promote: $wins_after (want ≥1 — the window is LEFT OPEN)"
  [ -n "$t" ] && note "  rule: $(rsum "$t")" || note "  FAIL: no template minted"
  note "  disclosure: $(python3 -c '
import json,sys
try:
    d=json.load(open(sys.argv[1]))
    print(" | ".join((d.get("data") or {}).get("notes") or []) or "(none)")
except Exception as e:
    print("(unreadable: %s)" % e)
' "$OUT/drive/closedwin.log")"
  note "  want: window count 0 -> exit 0 -> window count 1, with the reopened-window note"
}

for cell in $CELLS; do
  case "$cell" in
    oracle) run_oracle ;;
    cli) run_cli ;;
    override) run_override ;;
    zero) run_zero ;;
    backwards) run_backwards ;;
    control) run_control ;;
    closedwin) run_closedwin ;;
    teardown) : ;;
    *) note "unknown cell: $cell" ;;
  esac
done

note ""
note "report: $REPORT"
