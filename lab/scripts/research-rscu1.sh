#!/bin/bash
# RSCU1 — certify the `things rescue` verb family (issue #640): the headless
# emergency surface for a Things that is up, answering, and unusable.
#
# What is under test, cell by cell:
#   status     the read-only census + lock table, against no sheet / one sheet /
#              a stacked pair, and with the mutation lock held LIVE and STALE
#   dismiss    one LIFO level off a real Repeat sheet — closure confirmed, and
#              the clone-delete that MODALX1 §2.1 measured FAILING behind a sheet
#              now succeeding (the sheet-empties-collections release is the payoff)
#   wedge      dismiss REFUSING on an unidentifiable screen (System Events under
#              SIGSTOP — FGRD2's rig law), with nothing pressed
#   relaunch   end-to-end from a stranded-sheet state: death → relaunch → zero
#              sheets → a write lands
#   detached   THE §26 CELL: reproduce the backgrounded detached editor
#              (DRVLAT1's bgpress path), prove `dismiss` fails HONESTLY against
#              it, prove `relaunch` cures it
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, clock pinned 2026-07-05 and NEVER rolled (trial wall
# 2026-07-18). Fixtures fully synthetic (RSCU1-*). Beep sentinel default-on.
# Both lab escapes exported.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-rscu1}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — well inside the trial wall (2026-07-18)
GCDOMAIN='/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac'

note() { echo "[rscu1/$VM] $*" | tee -a "$REPORT"; }
load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'

gq()  { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
cli() { lab_ssh "$IP" "$LAB_DIRECT $CLI $*" </dev/null 2>&1; }

# Run a CLI verb and report BOTH its output and its EXIT CODE. Never `$?` after a
# pipe — that reads the LAST STAGE's status, not the command's, which is how the
# first pass of this campaign recorded a refusal as `exit 0` (repo law: verify by
# exit code, never by grepping piped output). `lab_ssh` propagates the remote
# command's own code, so capturing before the pipe is enough.
clirc() {
  local out rc
  out=$(lab_ssh "$IP" "$LAB_DIRECT $CLI $*" </dev/null 2>&1); rc=$?
  echo "$out" | grep -v 'ExperimentalWarning\|trace-warnings' | sed 's/^/    /' | tee -a "$REPORT"
  note "  exit=$rc"
}
front() { lab_ssh "$IP" "osascript -e 'tell application \"$1\" to activate'; sleep 1" </dev/null; }
add() { lab_ssh "$IP" "open -g $(printf '%q' "things:///add?title=$1"); sleep 2" </dev/null; }
mark() { lab_ssh "$IP" "~/labh/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null; }

# How many dialogs are standing, counted the way the census does (attached sheet
# walked to the top of its stack, plus the detached editor form).
sheets() {
  axq 'tell application "System Events" to tell process "Things3"
	set n to 0
	try
		set s to sheet 1 of (first window whose subrole is "AXStandardWindow")
		set n to 1
		repeat 6 times
			try
				if (exists sheet 1 of s) then
					set s to sheet 1 of s
					set n to n + 1
				else
					exit repeat
				end if
			on error
				exit repeat
			end try
		end repeat
	end try
	if n is 0 then
		try
			set n to (count of (windows whose subrole is "AXUnknown" and size is not {40, 40}))
		end try
	end if
	return n as text
end tell'
}

# Raise a STACKED pair. MODALX1 §6 measured that nothing inside the app can open
# a second sheet — the menu bar's items stop being enumerable — and that the URL
# scheme is the one path in from outside, but only with `uriSchemeEnabled` OFF,
# so the app raises its own consent alert as a nested `AXSheet` CHILD. The flip
# is read at LAUNCH, so the app must be restarted onto it (M7d's `resetapp`); a
# flip written under a running app with a sheet already up does nothing, which is
# how this cell first read a stack of one.
stack_open() {
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; pkill -x Things3 >/dev/null 2>&1; sleep 4' </dev/null
  lab_ssh "$IP" "defaults write $(printf '%q' "$GCDOMAIN") uriSchemeEnabled -bool false; killall cfprefsd 2>/dev/null; sleep 2; true" </dev/null
  lab_ssh "$IP" 'open -g -a Things3; sleep 16' </dev/null
  note "  uriSchemeEnabled now: $(lab_ssh "$IP" "defaults read $(printf '%q' "$GCDOMAIN") uriSchemeEnabled 2>&1 | tail -1" </dev/null)"
  open_repeat_attached "$1"
  note "  sheets after the Repeat sheet: $(sheets)"
  lab_ssh "$IP" "open -g 'things:///add?title=RSCU1-stack&auth-token=$TOKEN'; sleep 4" </dev/null
}

# Clear whatever is stacked (Escape is LIFO and needs Things frontmost), then put
# the URL scheme back so later cells' writes land.
stack_clear() {
  for _ in 1 2 3 4; do
    lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate' >/dev/null 2>&1; sleep 1; osascript -e 'tell application \"System Events\" to key code 53' >/dev/null 2>&1; sleep 1; true" </dev/null
  done
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; pkill -x Things3 >/dev/null 2>&1; sleep 4' </dev/null
  lab_ssh "$IP" "defaults write $(printf '%q' "$GCDOMAIN") uriSchemeEnabled -bool true; killall cfprefsd 2>/dev/null; sleep 2; true" </dev/null
  lab_ssh "$IP" 'open -g -a Things3; sleep 16' </dev/null
}

# Open the Repeat sheet the shipped way: reveal the seed, ACTIVATE, press the
# menu item. This yields the ATTACHED sheet (the dismissable form).
open_repeat_attached() {
  lab_ssh "$IP" "open -g 'things:///show?id=$1'; sleep 2" </dev/null
  front Things3
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
}

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
  note "preflight: free ${FREEGB}GB"
  [ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free"; exit 1; }

  note "cloning $GOLDEN -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 420) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"

  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  [ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) (trial wall 2026-07-18 — never rolled)"

  GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
  note "AX grant=$GRANT (want 2)"; [ "$GRANT" = "2" ] || { note "FATAL: AX grant"; exit 1; }

  lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
  lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<<"$GSQL"
  lab_scp lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/labh/beep-sentinel.sh" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/labh/beep-sentinel.sh' </dev/null

  note "warm-up launch/quit/relaunch"
  lab_ssh "$IP" 'open -g -a Things3; sleep 25; osascript -e "tell application \"Things3\" to quit"; sleep 5; open -g -a Things3; sleep 20' </dev/null

  # The URL scheme's auth token — a MUTATING url needs it, and the stacking cell
  # dispatches one to raise the app's own consent alert (MODALX1 M7d).
  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  { echo "IP=$IP"; echo "TOKEN=$TOKEN"; } > "$SESSION"
  TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
  TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
  DBV=$(gq "SELECT value FROM Meta WHERE key='databaseVersion'")
  note "env: Things $TVER ($TBLD) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / dbv $DBV / golden $GOLDEN"
  note "setup complete"
  exit 0
fi

# ===================================================================== ship
if [ "$CMD" = "ship" ]; then
  load_session
  if [ "${SKIP_BUILD:-0}" = "1" ]; then note "SKIP_BUILD=1 — reusing dist/"; else
    note "building dist"
    npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
  fi
  [ -f dist/cli/main.js ] || { note "FATAL: no dist/cli/main.js"; exit 1; }
  MAIN_WT=$(dirname "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null || true)
  NM="$(pwd)/node_modules"; [ -d "$NM/commander" ] || NM="$MAIN_WT/node_modules"
  [ -d "$NM/commander" ] || { note "FATAL: commander not found"; exit 1; }

  NODE_BIN=$(node -e 'console.log(process.execPath)')
  scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO -r "$NM/commander" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null

  CLIV=$(lab_ssh "$IP" "$CLI --version 2>&1 | tail -1" </dev/null)
  case "$CLIV" in
    [0-9]*) note "guest CLI OK: things $CLIV" ;;
    *) note "FATAL: the guest CLI does not run — $CLIV"; exit 1 ;;
  esac
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null
  # A clone is not a workstation: nobody is sitting at this screen, and the
  # second relaunch key is exercised in its own cell rather than in every one.
  lab_ssh "$IP" "$CLI config set profile dedicated-server" </dev/null >/dev/null 2>&1 || true
  note "ui-enabled true; profile $(lab_ssh "$IP" "$CLI config get profile 2>&1 | tail -1" </dev/null)"
  exit 0
fi

# =================================================================== status
# The read-only third of the family, against every screen it has to describe —
# plus the two lock states. NOTHING here may change anything, and the cell
# asserts that by counting sheets either side of every invocation.
if [ "$CMD" = "status" ]; then
  load_session
  note "=============================================================="
  note "STATUS cell start $(date +%H:%M:%S)"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null
  mark "status"

  add "RSCU1%20status%20seed"
  U=$(gq "SELECT uuid FROM TMTask WHERE title='RSCU1 status seed' AND type=0 AND trashed=0 LIMIT 1")
  note "  seed=$U"

  mark "S1-no-dialog"
  note "--- S1: no dialog open (sheets=$(sheets))"
  clirc rescue status

  mark "S2-one-sheet"
  note "--- S2: one Repeat sheet standing"
  open_repeat_attached "$U"
  note "  sheets before=$(sheets)"
  clirc rescue status
  note "  sheets after=$(sheets)  (status must not have touched it)"

  note "--- S3: a STACKED pair (MODALX1 §6/M7d: only the URL scheme can raise a second,"
  note "        and only with the scheme DISABLED — so the app must be restarted onto the flip)"
  mark "S3-stack-open"
  stack_open "$U"
  mark "S3-status-on-stack"
  note "  sheets=$(sheets) (want 2)"
  clirc rescue status
  mark "S3-stack-clear"
  stack_clear
  note "  sheets=$(sheets) (want 0)"

  note "--- S4/S5: the mutation lock, held LIVE then STALE."
  note "        Both halves run inside ONE ssh invocation that waits on the holder it"
  note "        starts, so nothing is ever orphaned (harness law) — a holder backgrounded"
  note "        across separate invocations is reaped, and reads as dead in both halves."
  mark "S4-S5-lock"
  lab_ssh "$IP" 'cat > ~/labh/lockcell.sh && chmod +x ~/labh/lockcell.sh' <<'EOF'
#!/bin/bash
# Hold the mutation lock with a REAL live process, ask `rescue status` about it,
# then kill the holder and ask again. One invocation, waits on everything.
CLI="$HOME/things-lab/bin/node $HOME/things-lab/things-api/dist/cli/main.js"
export THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1
mkdir -p ~/.local/state/things-api
sleep 900 &
HPID=$!
# Backdate the hold past the five-minute suspect threshold, so the sentence only
# a genuinely old holder earns is the one under test.
OLD=$(python3 -c 'import datetime;print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=20)).strftime("%Y-%m-%dT%H:%M:%S.000Z"))')
printf '{"pid":%s,"ts":"%s"}' "$HPID" "$OLD" > ~/.local/state/things-api/mutation.lock
echo "--- S4: holder pid=$HPID since=$OLD, ALIVE (ps: $(ps -p "$HPID" -o comm= 2>/dev/null || echo GONE))"
$CLI rescue status 2>&1 | grep -A1 'Change lock'
echo "--- S5: the same lockfile, holder killed"
kill "$HPID" 2>/dev/null
wait "$HPID" 2>/dev/null
echo "    (ps: $(ps -p "$HPID" -o comm= 2>/dev/null || echo GONE))"
$CLI rescue status 2>&1 | grep -A1 'Change lock'
rm -f ~/.local/state/things-api/mutation.lock
EOF
  lab_ssh "$IP" '~/labh/lockcell.sh' </dev/null 2>&1 | grep -v 'ExperimentalWarning\|trace-warnings' | sed 's/^/    /' | tee -a "$REPORT"

  lab_ssh "$IP" "~/labh/beep-sentinel.sh assert --json ~/labh/beeps-status.json --name rscu1-status" </dev/null >"$OUT/beeps-status.txt" 2>&1
  note "BEEPS(status): $(tail -6 "$OUT/beeps-status.txt" | tr '\n' ' ')"
  note "STATUS cell done $(date +%H:%M:%S)"
  exit 0
fi

# ================================================================== dismiss
# One LIFO level off a real Repeat sheet, closure PROVEN — and the payoff that
# makes it matter: with the sheet standing, `delete` on a plainly-present row
# fails -1728 (MODALX1 §2.1 / oddities §25); after the dismissal, the identical
# delete lands. That is the sheet-empties-collections release, measured through
# the shipped CLI.
if [ "$CMD" = "dismiss" ]; then
  load_session
  note "=============================================================="
  note "DISMISS cell start $(date +%H:%M:%S)"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null
  mark "dismiss"

  add "RSCU1%20dismiss%20seed"
  U=$(gq "SELECT uuid FROM TMTask WHERE title='RSCU1 dismiss seed' AND type=0 AND trashed=0 LIMIT 1")
  add "RSCU1%20deletee"
  DEL=$(gq "SELECT uuid FROM TMTask WHERE title='RSCU1 deletee' AND type=0 AND trashed=0 LIMIT 1")
  note "  seed=$U deletee=$DEL"

  open_repeat_attached "$U"
  note "  sheets before=$(sheets) (want 1)"

  # THE PAYOFF ORACLE. MODALX1 §2.1 pinned the failure to the AppleScript
  # `delete` command specifically — it re-resolves its argument through the app's
  # TOP-LEVEL element list, which a standing sheet empties, so it answers -1728
  # on a uuid `exists` and `get name` both resolve. `move … to list "Trash"` was
  # measured to SUCCEED in the same state, so a Trash-move verb would prove
  # nothing here. This runs the exact failing call, either side of the dismissal.
  DELSCRIPT="tell application \"Things3\" to delete (to do id \"$DEL\")"
  note "--- the sheet-blocked delete (MODALX1 §2.1: must FAIL with the row present)"
  note "  db says present: $(gq "SELECT count(*) FROM TMTask WHERE uuid='$DEL' AND trashed=0") (want 1)"
  note "  exists to do id:  $(axq "tell application \"Things3\" to return (exists to do id \"$DEL\")") (want true)"
  note "  count to dos:     $(axq 'tell application "Things3" to return (count to dos) as text') (want 0 — the emptied collection)"
  note "  delete ->         $(axq "$DELSCRIPT" | tail -1)"
  note "  row still there:  $(gq "SELECT count(*) FROM TMTask WHERE uuid='$DEL' AND trashed=0") (want 1 — the delete did nothing)"

  note "--- rescue dismiss (one level)"
  clirc rescue dismiss --dangerously-dismiss-dialog
  note "  sheets after=$(sheets) (want 0)"

  note "--- the IDENTICAL delete, sheet gone (must LAND — the release)"
  note "  count to dos:     $(axq 'tell application "Things3" to return (count to dos) as text') (want >0 — collection restored)"
  note "  delete ->         $(axq "$DELSCRIPT" | tail -1) (want empty/no error)"
  # Things' scripting `delete` TRASHES rather than hard-deletes, so the row
  # survives with trashed=1 — the assertion is that it MOVED, which is exactly
  # what the -1728 above prevented.
  note "  row now trashed:  $(gq "SELECT trashed FROM TMTask WHERE uuid='$DEL'") (want 1)"
  note "  seed untouched (no rule): $(gq "SELECT count(*) FROM TMTask WHERE uuid='$U' AND rt1_recurrenceRule IS NULL") (want 1)"

  note "--- a second dismiss with nothing open (must be a clean no-op, exit 0)"
  clirc rescue dismiss --dangerously-dismiss-dialog

  note "--- dismiss WITHOUT the flag (must refuse, exit 4, press nothing)"
  open_repeat_attached "$U"
  clirc rescue dismiss
  note "  sheets still=$(sheets) (want 1 — the refusal pressed nothing)"
  for _ in 1 2; do
    lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate' >/dev/null 2>&1; sleep 1; osascript -e 'tell application \"System Events\" to key code 53' >/dev/null 2>&1; sleep 1; true" </dev/null
  done

  note "--- the STACKED case: dismiss closes exactly ONE level"
  stack_open "$U"
  note "  sheets before=$(sheets) (want 2)"
  note "  the TOP is the consent alert, which the census cannot identify — so dismiss"
  note "  must REFUSE it rather than press an unknown button (the conservative law)"
  clirc rescue dismiss --dangerously-dismiss-dialog
  note "  sheets after=$(sheets) (want 2 — nothing pressed)"
  note "--- and relaunch is what clears a real stack"
  clirc rescue relaunch --yes
  sleep 5
  note "  sheets after relaunch=$(sheets) (want 0)"
  # Put the URL scheme back so the later cells' writes land.
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; pkill -x Things3 >/dev/null 2>&1; sleep 4' </dev/null
  lab_ssh "$IP" "defaults write $(printf '%q' "$GCDOMAIN") uriSchemeEnabled -bool true; killall cfprefsd 2>/dev/null; sleep 2; true" </dev/null
  lab_ssh "$IP" 'open -g -a Things3; sleep 16' </dev/null

  note "--- the change history recorded the actions"
  cli op-result --help >/dev/null 2>&1
  lab_ssh "$IP" 'grep -o "\"op\":\"rescue\.[a-z]*\"" ~/.local/state/things-api/audit/*.jsonl 2>/dev/null | sort | uniq -c' </dev/null | sed 's/^/    /' | tee -a "$REPORT"

  lab_ssh "$IP" "~/labh/beep-sentinel.sh assert --json ~/labh/beeps-dismiss.json --name rscu1-dismiss" </dev/null >"$OUT/beeps-dismiss.txt" 2>&1
  note "BEEPS(dismiss): $(tail -6 "$OUT/beeps-dismiss.txt" | tr '\n' ' ')"
  note "DISMISS cell done $(date +%H:%M:%S)"
  exit 0
fi

# ==================================================================== wedge
# THE UNIDENTIFIABLE SCREEN, staged deterministically: SIGSTOP System Events so
# every Accessibility read the census makes blocks until its own budget expires
# (FGRD2's rig law). `dismiss` must REFUSE — an unverifiable screen is not a
# screen to click on — and must press nothing. System Events is resumed at the
# end of the cell, inside the same ssh invocation that froze it.
if [ "$CMD" = "wedge" ]; then
  load_session
  note "=============================================================="
  note "WEDGE cell start $(date +%H:%M:%S)"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null
  mark "wedge"

  add "RSCU1%20wedge%20seed"
  U=$(gq "SELECT uuid FROM TMTask WHERE title='RSCU1 wedge seed' AND type=0 AND trashed=0 LIMIT 1")
  open_repeat_attached "$U"
  note "  sheets before=$(sheets) (want 1)"

  lab_ssh "$IP" 'cat > ~/labh/wedge.sh && chmod +x ~/labh/wedge.sh' <<'EOF'
#!/bin/bash
# Freeze System Events, run rescue status then rescue dismiss, time each, thaw.
# ONE ssh invocation that waits on everything it starts — nothing is orphaned.
CLI="$HOME/things-lab/bin/node $HOME/things-lab/things-api/dist/cli/main.js"
export THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1
SEPID=$(pgrep -x 'System Events' | head -1)
[ -n "$SEPID" ] || { echo "no System Events process"; exit 1; }
kill -STOP "$SEPID"
T0=$(python3 -c 'import time;print(time.time())')
echo "--- rescue status (frozen)"
$CLI rescue status 2>&1 | tail -12
echo "--- rescue dismiss (frozen) — must REFUSE"
OUT=$($CLI rescue dismiss --dangerously-dismiss-dialog 2>&1); RC=$?
echo "$OUT" | tail -8
echo "dismiss_exit=$RC  (want 4 — refused)"
T1=$(python3 -c 'import time;print(time.time())')
kill -CONT "$SEPID"
python3 -c "print('elapsed_ms=%.0f' % (($T1-$T0)*1000))"
EOF
  lab_ssh "$IP" '~/labh/wedge.sh' </dev/null 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
  sleep 3
  note "  sheets after=$(sheets) (want 1 — the refusal pressed nothing)"
  note "--- thawed: dismiss now works on the same sheet"
  clirc rescue dismiss --dangerously-dismiss-dialog
  note "  sheets=$(sheets) (want 0)"

  lab_ssh "$IP" "~/labh/beep-sentinel.sh assert --json ~/labh/beeps-wedge.json --name rscu1-wedge" </dev/null >"$OUT/beeps-wedge.txt" 2>&1
  note "BEEPS(wedge): $(tail -6 "$OUT/beeps-wedge.txt" | tr '\n' ' ')"
  note "WEDGE cell done $(date +%H:%M:%S)"
  exit 0
fi

# ================================================================= relaunch
# End to end from a stranded-sheet state: a sheet standing, the app wedged for
# scripted callers, then relaunch → death → restart → ZERO sheets → a write
# lands. Also exercises both gates (no --yes; and the workstation second key).
if [ "$CMD" = "relaunch" ]; then
  load_session
  note "=============================================================="
  note "RELAUNCH cell start $(date +%H:%M:%S)"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null
  mark "relaunch"

  add "RSCU1%20relaunch%20seed"
  U=$(gq "SELECT uuid FROM TMTask WHERE title='RSCU1 relaunch seed' AND type=0 AND trashed=0 LIMIT 1")
  open_repeat_attached "$U"
  PID0=$(lab_ssh "$IP" 'pgrep -x Things3 | head -1' </dev/null)
  note "  sheets=$(sheets) (want 1); Things pid=$PID0"

  note "--- relaunch WITHOUT --yes (must refuse, exit 4, kill nothing)"
  clirc rescue relaunch
  note "  pid still $(lab_ssh "$IP" 'pgrep -x Things3 | head -1' </dev/null) (want $PID0)"

  note "--- the WORKSTATION second key"
  lab_ssh "$IP" "$LAB_DIRECT $CLI config set profile workstation" </dev/null >/dev/null
  clirc rescue relaunch --yes
  note "  pid still $(lab_ssh "$IP" 'pgrep -x Things3 | head -1' </dev/null) (want $PID0 — refused)"
  lab_ssh "$IP" "$LAB_DIRECT $CLI config set profile dedicated-server" </dev/null >/dev/null

  note "--- relaunch for real"
  clirc rescue relaunch --yes
  sleep 5
  PID1=$(lab_ssh "$IP" 'pgrep -x Things3 | head -1' </dev/null)
  note "  new pid=$PID1 (was $PID0); sheets=$(sheets) (want 0)"
  note "--- and a write lands afterwards"
  cli todo add RSCU1-post-relaunch 2>&1 | tail -3 | sed 's/^/    /' | tee -a "$REPORT"
  note "  row present: $(gq "SELECT count(*) FROM TMTask WHERE title='RSCU1-post-relaunch' AND trashed=0") (want 1)"
  note "  seed untouched (no rule): $(gq "SELECT count(*) FROM TMTask WHERE uuid='$U' AND rt1_recurrenceRule IS NULL") (want 1)"

  lab_ssh "$IP" "~/labh/beep-sentinel.sh assert --json ~/labh/beeps-relaunch.json --name rscu1-relaunch" </dev/null >"$OUT/beeps-relaunch.txt" 2>&1
  note "BEEPS(relaunch): $(tail -6 "$OUT/beeps-relaunch.txt" | tr '\n' ' ')"
  note "RELAUNCH cell done $(date +%H:%M:%S)"
  exit 0
fi

# ================================================================= detached
# THE §26 CELL. Reproduce the backgrounded detached editor exactly as DRVLAT1's
# bgpress path does — reveal WITHOUT foregrounding, hand the screen to Finder,
# then AXPress `Items ▸ Repeat…` — and put both action verbs against it:
#   `rescue dismiss`  must try both rungs and report STILL-OPEN honestly,
#                     naming relaunch (never claim a dismissal it cannot see);
#   `rescue relaunch` must clear it, which is the only thing measured to.
if [ "$CMD" = "detached" ]; then
  load_session
  note "=============================================================="
  note "DETACHED (§26) cell start $(date +%H:%M:%S)"
  lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null
  mark "detached"

  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -g -a Things3; sleep 14' </dev/null
  add "RSCU1%20detached%20seed"
  U=$(gq "SELECT uuid FROM TMTask WHERE title='RSCU1 detached seed' AND type=0 AND trashed=0 LIMIT 1")
  note "  seed=$U"

  # Reveal WITHOUT foregrounding, then hand the screen to Finder.
  lab_ssh "$IP" "open -g 'things:///show?id=$U'; sleep 2; osascript -e 'tell application \"Finder\" to activate'; sleep 2" </dev/null
  note "  frontmost = $(axq 'tell application "System Events" to return name of first application process whose frontmost is true') (want Finder)"
  note "  menu enabled = $(axq 'tell application "System Events" to tell process "Things3" to return enabled of menu item "Repeat…" of menu "Items" of menu bar 1')"
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  sleep 2
  ATTACHED=$(axq 'tell application "System Events" to tell process "Things3" to return (exists sheet 1 of (first window whose subrole is "AXStandardWindow")) as text')
  DETACHED=$(axq 'tell application "System Events" to tell process "Things3" to return (count of (windows whose subrole is "AXUnknown" and size is not {40, 40})) as text')
  note "  attached sheet=$ATTACHED (want false); detached window=$DETACHED (want 1)"
  [ "$DETACHED" = "1" ] || { note "NOTE: the §26 editor did not materialise — cell is inconclusive, not a pass"; }

  note "--- rescue status against it (must name the detached form and point at relaunch)"
  clirc rescue status

  note "--- rescue dismiss against it (must try both rungs and report STILL-OPEN)"
  clirc rescue dismiss --dangerously-dismiss-dialog
  note "  detached window still=$(axq 'tell application "System Events" to tell process "Things3" to return (count of (windows whose subrole is "AXUnknown" and size is not {40, 40})) as text') (want 1 — it survives, as §26 says)"

  note "--- and every historical rung, for the record (all inert per DRVLAT1 §5)"
  note "  Escape          -> $(axq 'tell application "System Events" to key code 53' >/dev/null; axq 'tell application "System Events" to tell process "Things3" to return (count of (windows whose subrole is "AXUnknown" and size is not {40, 40})) as text')"
  note "  activate+Cancel -> $(front Things3 >/dev/null; axq 'tell application "System Events" to tell process "Things3" to click button "Cancel" of (first window whose subrole is "AXUnknown" and size is not {40, 40})' >/dev/null; sleep 1; axq 'tell application "System Events" to tell process "Things3" to return (count of (windows whose subrole is "AXUnknown" and size is not {40, 40})) as text')"

  note "--- rescue relaunch: THE CURE"
  PID0=$(lab_ssh "$IP" 'pgrep -x Things3 | head -1' </dev/null)
  clirc rescue relaunch --yes
  sleep 5
  PID1=$(lab_ssh "$IP" 'pgrep -x Things3 | head -1' </dev/null)
  note "  pid $PID0 -> $PID1"
  note "  detached window=$(axq 'tell application "System Events" to tell process "Things3" to return (count of (windows whose subrole is "AXUnknown" and size is not {40, 40})) as text') (want 0)"
  note "  sheets=$(sheets) (want 0)"
  note "--- and a write lands"
  cli todo add RSCU1-post-26 2>&1 | tail -3 | sed 's/^/    /' | tee -a "$REPORT"
  note "  row present: $(gq "SELECT count(*) FROM TMTask WHERE title='RSCU1-post-26' AND trashed=0") (want 1)"

  lab_ssh "$IP" "~/labh/beep-sentinel.sh assert --json ~/labh/beeps-detached.json --name rscu1-detached" </dev/null >"$OUT/beeps-detached.txt" 2>&1
  note "BEEPS(detached): $(tail -6 "$OUT/beeps-detached.txt" | tr '\n' ' ')"
  note "DETACHED cell done $(date +%H:%M:%S)"
  exit 0
fi

# ================================================================== teardown
if [ "$CMD" = "teardown" ]; then
  tart stop "$VM" >/dev/null 2>&1 || true
  sleep 3
  tart delete "$VM" >/dev/null 2>&1 || true
  note "teardown: $VM stopped and deleted"
  tart list | tee -a "$REPORT"
  exit 0
fi

echo "usage: [VM=… SKIP_BUILD=1] bash lab/scripts/research-rscu1.sh <setup|ship|status|dismiss|wedge|relaunch|detached|teardown>" >&2
exit 2
