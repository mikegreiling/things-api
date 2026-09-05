#!/bin/bash
# LOCKSCR1 (#732) — the locked-session cells. Run ON THE GUEST.
#
# Both arms share this file: the DIRECT arm (a golden-v4 clone, lab escapes
# exported by the driver) and the ROUTED arm (a golden-v4h clone with the
# helpers installed and `helpers-enabled true`, driven by stage5-rc-run.sh).
# Nothing here invokes a driver directly — every operation is the NORMAL CLI
# syntax. The osascript uses are FIXTURE management only (relaunch the app,
# close its window, drive the screen saver), never an operation's path.
#
# THE TWO LAUNCH SHAPES. The field runs the CLI inside the Aqua session (a
# terminal the user is sitting at; under the helpers, a LaunchAgent). The lab
# runs it over ssh, which has no window-server session of its own — so this
# campaign was built expecting the ssh shape to read `unknown` and ran EVERY
# session-sensitive cell through `gui`, which re-enters the Aqua session with
# `launchctl asuser`. Cell P then records both readings side by side, and the
# measurement says they AGREE in every screen state: `CGSessionCopyCurrentDictionary`
# hands an ssh login the console session's dictionary. The wrapper is kept
# because it is the field shape, and cell P is kept because that equality is
# now a documented property rather than an assumption.
#
# Usage: lockscr1-cells.sh <node-binary> <app-dir>
set -u
NODE="$1"
APP="$2/dist/cli/main.js"
OUT="$HOME/things-lab/out"
mkdir -p "$OUT"
TRACE_DIR="$HOME/.local/state/things-api/trace"
FAILURES=0
STEP=0
TAG="LOCKSCR1"

UIDN=$(id -u)
ME=$(id -un)

fail() { echo "FAIL $*"; FAILURES=$((FAILURES + 1)); }
pass() { echo "ok   $*"; }
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

# The environment a re-entered process needs: HOME (the CLI's state dir and the
# Things container both hang off it) plus whichever lab escapes / routing switch
# this arm exported.
GUI_ENV=("HOME=$HOME" "PATH=$PATH")
for var in THINGS_API_UI_DIRECT THINGS_API_WRITE_DIRECT THINGS_API_HELPERS THINGS_API_TRACE; do
  eval "val=\${$var:-}"
  [ -n "$val" ] && GUI_ENV+=("$var=$val")
done

# gui <command...> — run inside the Aqua session, as this user.
gui() { sudo launchctl asuser "$UIDN" sudo -u "$ME" /usr/bin/env "${GUI_ENV[@]}" "$@"; }

# things_gui <args...> — the CLI, field-shaped (inside the session).
things_gui() { gui "$NODE" "$APP" "$@"; }
# things_ssh <args...> — the CLI as an ssh login sees it (no session).
things_ssh() { "$NODE" "$APP" "$@"; }

db() {
  python3 -c "
import glob, os, sqlite3, sys
db = glob.glob(os.path.expanduser('~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite'))[0]
c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
r = c.execute(sys.argv[1]).fetchone()
print('' if r is None else ('' if r[0] is None else r[0]))
" "$1"
}

jsonf() { python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for k in sys.argv[1:]:
    d = d.get(k) if isinstance(d,dict) else None
    if d is None: break
print('' if d is None else (d if isinstance(d,str) else json.dumps(d)))
" "$@"; }

newest_trace() { ls -t "$TRACE_DIR"/*.jsonl 2>/dev/null | head -1; }

launch_things() {
  open -a Things3
  sleep 14
  osascript -e 'tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false' >/dev/null 2>&1
}

area_order() {
  db "SELECT group_concat(title,'|') FROM (SELECT title FROM TMArea WHERE title LIKE '$TAG-%' ORDER BY \"index\")"
}

# The session row `doctor --ui-state` prints, read both ways.
doctor_session() { things_gui doctor --ui-state --json 2>/dev/null | jsonf data uiState session state; }

# The probe's own JSON, straight out of the shipped script text. `things doctor
# --ui-state --json` carries the whole verdict, which is exactly the evidence
# this campaign is for.
probe_gui() { things_gui doctor --ui-state --json 2>/dev/null | jsonf data uiState session; }
probe_ssh() { things_ssh doctor --ui-state --json 2>/dev/null | jsonf data uiState session; }

# reorder <label> <extra-args...> — one field-shaped area reorder, timed.
reorder() {
  local label="$1"; shift
  STEP=$((STEP + 1))
  local t0 t1
  t0=$(now_ms)
  R_OUT=$(env THINGS_API_TRACE=1 sudo launchctl asuser "$UIDN" sudo -u "$ME" /usr/bin/env \
    "${GUI_ENV[@]}" THINGS_API_TRACE=1 "$NODE" "$APP" area reorder "$@" \
    --dangerously-drive-gui --verify-timeout 120000 --json 2>/dev/null)
  R_CODE=$?
  t1=$(now_ms)
  R_WALL=$((t1 - t0))
  printf '%s\n' "$R_OUT" >"$OUT/$label.json"
  echo "     [$label] exit=$R_CODE wall=${R_WALL}ms"
  echo "     $(head -c 700 <<<"$R_OUT")"
}

echo "############################################################"
echo "# LOCKSCR1 (#732) — locked-session cells"
echo "# arm: ${LOCKSCR1_ARM:-unset}   clock: $(date)"
echo "############################################################"

# The wrapper has to work before anything below means anything.
GUI_UID=$(gui /usr/bin/id -u 2>/dev/null | tr -dc 0-9)
if [ "$GUI_UID" = "$UIDN" ]; then
  pass "0 — the Aqua-session wrapper re-enters as uid $GUI_UID"
else
  fail "0 — launchctl asuser did not re-enter the session (got '$GUI_UID', wanted $UIDN)"
fi

launch_things

# The two switches the sidebar drive needs. `area.reorder` is EXPERIMENTAL
# (#676: the drive is not yet inside the five-second bar on real hardware), so
# without this the command refuses at `blocked:capability` and never reaches the
# vector — which is a real gate, and not the one under test here.
things_ssh config set ui-enabled true >/dev/null 2>&1
things_ssh config set experimental-area-reorder true >/dev/null 2>&1
echo "     ui-enabled=$(things_ssh config get ui-enabled 2>/dev/null) experimental-area-reorder=$(things_ssh config get experimental-area-reorder 2>/dev/null)"

########################################################################
echo ""
echo "===== CELL P/1 — the session dictionary, UNLOCKED, both launch shapes ====="
########################################################################
P_UNLOCKED_GUI=$(probe_gui)
P_UNLOCKED_SSH=$(probe_ssh)
echo "     in-session: $P_UNLOCKED_GUI"
echo "     over ssh:   $P_UNLOCKED_SSH"
S=$(jsonf state <<<"$P_UNLOCKED_GUI")
[ "$S" = "unlocked" ] && pass "P/1 — in-session reads unlocked" || fail "P/1 — in-session read '$S'"

########################################################################
echo ""
echo "===== CELL A — unlocked baseline: a reorder LANDS, doctor says unlocked ====="
########################################################################
for n in 1 2 3; do
  things_gui area add "$TAG-A$n" >/dev/null 2>&1 || fail "A — could not add $TAG-A$n"
done
# Cell B2's fixture is minted HERE, while the screen is still unlocked: a URL
# the window server cannot present is not a fixture, it is a second variable.
things_gui todo add "$TAG-REP" --when 2026-07-10 >/dev/null 2>&1 || fail "A — could not add $TAG-REP"
REP_UUID=$(db "SELECT uuid FROM TMTask WHERE title='$TAG-REP' AND trashed=0 LIMIT 1")
[ -n "$REP_UUID" ] && pass "A — $TAG-REP minted ($REP_UUID)" || fail "A — $TAG-REP was not minted"
A_BEFORE=$(area_order)
echo "     order before: $A_BEFORE"
reorder "A-unlocked-first" "$TAG-A3" --first
A_AFTER=$(area_order)
echo "     order after:  $A_AFTER"
if [ "$R_CODE" -eq 0 ] && [ "${A_AFTER%%|*}" = "$TAG-A3" ]; then
  pass "A — the reorder landed on an unlocked screen (exit 0, $TAG-A3 first)"
else
  fail "A — exit $R_CODE, order '$A_AFTER'"
fi
DS=$(doctor_session)
[ "$DS" = "unlocked" ] && pass "A — doctor session row: unlocked" || fail "A — doctor session row '$DS'"

########################################################################
echo ""
echo "===== CELL D — window CLOSED, screen unlocked: the no-window path ====="
########################################################################
osascript -e 'tell application "Things3" to activate' >/dev/null 2>&1
sleep 2
osascript -e 'tell application "System Events" to keystroke "w" using command down' >/dev/null 2>&1
sleep 3
D_WINDOWS=$(osascript -e 'tell application "System Events" to tell process "Things3" to count (windows whose subrole is "AXStandardWindow")' 2>/dev/null)
echo "     standard windows after ⌘W: ${D_WINDOWS:-?}"
D_BEFORE=$(area_order)
reorder "D-window-closed" "$TAG-A1" --first
D_AFTER=$(area_order)
D_MSG=$(jsonf error message <<<"$R_OUT")
echo "     message: $(head -c 400 <<<"$D_MSG")"
if [ "$R_CODE" -ne 0 ] && [ "$D_BEFORE" = "$D_AFTER" ]; then
  pass "D — refused with the sidebar unchanged (exit $R_CODE)"
else
  fail "D — exit $R_CODE, order '$D_BEFORE' -> '$D_AFTER'"
fi
case "$D_MSG" in
  *"no open window"*) pass "D — the categorical sentence stands on a PROVEN-unlocked session" ;;
  *"could not be read"*) echo "     NOTE: the hedged sentence fired — record the session reading above" ;;
  *) echo "     NOTE: neither window sentence fired; the drive died elsewhere (see message)" ;;
esac
launch_things

########################################################################
echo ""
echo "===== CELL C — SCREEN SAVER only (no password gate) ====="
########################################################################
sudo sysadminctl -screenLock off -password admin >/dev/null 2>&1
open -a ScreenSaverEngine >/dev/null 2>&1
sleep 5
SAVER_PS=$(pgrep -x ScreenSaverEngine >/dev/null 2>&1 && echo running || echo absent)
echo "     ScreenSaverEngine: $SAVER_PS"
P_SAVER=$(probe_gui)
echo "     in-session: $P_SAVER"
C_BEFORE=$(area_order)
reorder "C-screensaver" "$TAG-A2" --first
C_AFTER=$(area_order)
C_STATE=$(jsonf state <<<"$P_SAVER")
C_MSG=$(jsonf error message <<<"$R_OUT")
echo "     session state: $C_STATE"
echo "     message: $(head -c 400 <<<"$C_MSG")"
if [ "$C_BEFORE" = "$C_AFTER" ]; then
  pass "C — the sidebar is unchanged under the saver"
else
  fail "C — the sidebar MOVED under the saver: '$C_BEFORE' -> '$C_AFTER'"
fi
# MEASURED (macOS 15.7.7): the window server sets `CGSSessionScreenIsLocked`
# for a bare screen saver too, password gate or none — so the saver reads
# `locked` and gets the lock refusal. The distinct `screensaver` verdict is the
# fallback for a session that reports NO lock while the saver process is up; it
# was not reachable on this build, and it is over-caution either way.
case "$C_STATE" in
  locked) pass "C — the saver reads LOCKED (the window server's own account)" ;;
  screensaver) pass "C — the saver reads SCREENSAVER (the fallback rung fired)" ;;
  *) fail "C — the saver read '$C_STATE'" ;;
esac
[ "$R_CODE" -eq 4 ] && pass "C — refused, exit 4" || fail "C — exit $R_CODE"
killall ScreenSaverEngine >/dev/null 2>&1
sleep 3
P_AFTER_SAVER=$(probe_gui)
echo "     after killing the saver: $P_AFTER_SAVER"

########################################################################
echo ""
echo "===== CELL B — LOCKED: refuse fast, name the lock, change nothing ====="
########################################################################
launch_things
B_BEFORE=$(area_order)
echo "     order before: $B_BEFORE"
sudo sysadminctl -screenLock immediate -password admin 2>&1 | sed 's/^/     /'
gui /usr/bin/python3 -c 'import ctypes; lf=ctypes.CDLL("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login"); print("SACLockScreenImmediate rc=", lf.SACLockScreenImmediate())' 2>&1 | sed 's/^/     /'
sleep 5

P_LOCKED_GUI=$(probe_gui)
P_LOCKED_SSH=$(probe_ssh)
echo "     in-session: $P_LOCKED_GUI"
echo "     over ssh:   $P_LOCKED_SSH"
B_STATE=$(jsonf state <<<"$P_LOCKED_GUI")
[ "$B_STATE" = "locked" ] && pass "B — the session reads LOCKED in-session" || fail "B — in-session read '$B_STATE'"

DS=$(doctor_session)
[ "$DS" = "locked" ] && pass "B — doctor session row: locked" || fail "B — doctor session row '$DS'"

reorder "B-locked-reorder" "$TAG-A1" --first
B_AFTER=$(area_order)
B_MSG=$(jsonf error message <<<"$R_OUT")
B_ERRCODE=$(jsonf error code <<<"$R_OUT")
echo "     error code: $B_ERRCODE"
echo "     message: $(head -c 500 <<<"$B_MSG")"
[ "$R_CODE" -eq 4 ] && pass "B — exit 4 (blocked)" || fail "B — exit $R_CODE (wanted 4)"
case "$B_ERRCODE" in
  blocked:H-UI-SESSION-UNREACHABLE) pass "B — blocked:H-UI-SESSION-UNREACHABLE" ;;
  *) fail "B — error code '$B_ERRCODE'" ;;
esac
case "$B_MSG" in
  *"the screen is locked"*) pass "B — the refusal names the lock" ;;
  *) fail "B — the refusal does not name the lock" ;;
esac
case "$B_MSG" in
  *"Dock icon"*) fail "B — the #732 sentence is still being emitted" ;;
  *) pass "B — no Dock-icon instruction anywhere in the refusal" ;;
esac
[ "$R_WALL" -le 4000 ] && pass "B — refused in ${R_WALL}ms" || fail "B — took ${R_WALL}ms"
[ "$B_BEFORE" = "$B_AFTER" ] && pass "B — the sidebar is unchanged" || fail "B — order '$B_BEFORE' -> '$B_AFTER'"

T=$(newest_trace)
if [ -n "$T" ]; then
  echo "     session-state trace: $(grep -o '"phase":"session-state"[^}]*' "$T" | tail -1)"
  GEST=$(grep -c '"phase":"sidebar-' "$T" 2>/dev/null | tr -d ' ')
  echo "     sidebar-* trace lines in the newest trace: ${GEST:-0}"
fi

echo ""
echo "----- B2 — make-repeating under the same lock -----"
STEP=$((STEP + 1))
t0=$(now_ms)
MR_OUT=$(gui "$NODE" "$APP" todo make-repeating "$REP_UUID" --frequency weekly --interval 1 \
  --dangerously-drive-gui --verify-timeout 120000 --json 2>/dev/null)
MR_CODE=$?
t1=$(now_ms)
printf '%s\n' "$MR_OUT" >"$OUT/B2-locked-make-repeating.json"
MR_MSG=$(jsonf error message <<<"$MR_OUT")
MR_ERRCODE=$(jsonf error code <<<"$MR_OUT")
echo "     exit=$MR_CODE wall=$((t1 - t0))ms code=$MR_ERRCODE"
echo "     message: $(head -c 400 <<<"$MR_MSG")"
[ "$MR_CODE" -eq 4 ] && pass "B2 — make-repeating exit 4" || fail "B2 — exit $MR_CODE"
case "$MR_MSG" in
  *"the screen is locked"*) pass "B2 — the same sentence, from the Repeat drive" ;;
  *) fail "B2 — the refusal does not name the lock" ;;
esac
MR_TPL=$(db "SELECT count(*) FROM TMTask WHERE title='$TAG-REP' AND rt1_recurrenceRule IS NOT NULL")
[ "$MR_TPL" = "0" ] && pass "B2 — no rule was written (zero mutation)" || fail "B2 — $MR_TPL template row(s)"

echo ""
echo "############################################################"
echo "# LOCKSCR1 cells finished — failures: $FAILURES"
echo "# THE KEY CENSUS"
echo "#   unlocked / in-session : $P_UNLOCKED_GUI"
echo "#   unlocked / over ssh   : $P_UNLOCKED_SSH"
echo "#   screensaver / session : $P_SAVER"
echo "#   locked / in-session   : $P_LOCKED_GUI"
echo "#   locked / over ssh     : $P_LOCKED_SSH"
echo "############################################################"
exit "$FAILURES"
