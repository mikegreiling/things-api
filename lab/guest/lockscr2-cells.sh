#!/bin/bash
# LOCKSCR2 (#732 follow-ons) — the certification cells. Run ON THE GUEST.
#
# Both arms share this file: the DIRECT arm (a golden-v4 clone, lab escapes
# exported by lab/scripts/research-lockscr2-cert.sh) and the ROUTED arm (a
# golden-v4h clone with the helpers installed and enabled, driven by
# lab/scripts/stage5-rc-run.sh). Nothing here invokes a driver directly — every
# operation is the NORMAL CLI syntax. The osascript uses are FIXTURE management
# only (relaunch the app, close its window, start the saver), never an
# operation's path.
#
# THE CELLS
#   a  hop count + per-hop ms on the HAPPY path, before and after, for
#      `area reorder --first` and `todo make-repeating`. The direct arm ships
#      BOTH bundles ($LOCKSCR2_BEFORE); the routed arm ships one and runs the
#      "after" half only.
#   e  window CLOSED (⌘W), screen unlocked -> the reopen rung fires, the drive
#      lands, and the result says a window was reopened and left open.
#   c  SCREEN SAVER, no password required -> the nudge clears it, the drive
#      lands, and the result says the saver was dismissed.
#   d  screen saver, password required -> the nudge is attempted and honestly
#      fails; the drive refuses and nothing moves.
#   f  window closed AND the session locked -> the LOCK refusal, not the
#      no-window sentence: the session question outranks the inventory.
#   b  LOCKED -> the refusal LOCKSCR1 shipped, unchanged in substance, for both
#      `area reorder` and `todo make-repeating`.
#
# ORDER IS LOAD-BEARING. A screen-saver sitting that is NOT dismissed leaves
# `CGSSessionScreenIsLocked` set for the rest of that login (LOCKSCR1 §1 law 2),
# and a headless clone has no way to type a password — so every cell that leaves
# the session locked runs last, and the clone is destroyed straight after.
#
# Usage: lockscr2-cells.sh <node-binary> <app-dir>
set -u
NODE="$1"
APP_DIR="$2"
APP="$APP_DIR/dist/cli/main.js"
BEFORE="${LOCKSCR2_BEFORE:-}"
OUT="$HOME/things-lab/out"
mkdir -p "$OUT"
TRACE_DIR="$HOME/.local/state/things-api/trace"
FAILURES=0
TAG="LOCKSCR2"

UIDN=$(id -u)
ME=$(id -un)

fail() { echo "FAIL $*"; FAILURES=$((FAILURES + 1)); }
pass() { echo "ok   $*"; }
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

GUI_ENV=("HOME=$HOME" "PATH=$PATH")
for var in THINGS_API_UI_DIRECT THINGS_API_WRITE_DIRECT THINGS_API_HELPERS; do
  eval "val=\${$var:-}"
  [ -n "$val" ] && GUI_ENV+=("$var=$val")
done

# gui <command...> — run inside the Aqua session, as this user (the field shape).
gui() { sudo launchctl asuser "$UIDN" sudo -u "$ME" /usr/bin/env "${GUI_ENV[@]}" "$@"; }
things_gui() { gui "$NODE" "$APP" "$@"; }
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

# hop_summary <trace-file> — "<hops> <total-ms> <lock-hop-ms> <session-state-hop>"
#
# One line per `ui-dispatch` end record: that is a hop, and `durationMs` is what
# this host paid for it. The lock column is the hop LOCKSCR1 added and LOCKSCR2
# removed — a "session-lock probe" of its own.
hop_summary() {
  python3 - "$1" <<'PY'
import json, sys
hops = 0
total = 0
lock_ms = 0
sess = []
try:
    for line in open(sys.argv[1]):
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("phase") == "ui-dispatch" and r.get("event") == "end":
            hops += 1
            total += int(r.get("durationMs") or 0)
            if "session-lock probe" in (r.get("label") or ""):
                lock_ms += int(r.get("durationMs") or 0)
        if r.get("phase") == "session-state":
            sess.append("%s/%s" % (r.get("hop") or "?", r.get("state") or "?"))
except FileNotFoundError:
    pass
print("%d %d %d %s" % (hops, total, lock_ms, ",".join(sess) or "-"))
PY
}

launch_things() {
  open -a Things3
  sleep 14
  osascript -e 'tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false' >/dev/null 2>&1
}

area_order() {
  db "SELECT group_concat(title,'|') FROM (SELECT title FROM TMArea WHERE title LIKE '$TAG-%' ORDER BY \"index\")"
}

std_windows() {
  osascript -e 'tell application "System Events" to tell process "Things3" to count (windows whose subrole is "AXStandardWindow")' 2>/dev/null
}

session_state() { things_gui doctor --ui-state --json 2>/dev/null | jsonf data uiState session state; }
session_keys() { things_gui doctor --ui-state --json 2>/dev/null | jsonf data uiState session keys; }

# reorder <label> <app-js> <args...> — one field-shaped area reorder, timed and traced.
reorder() {
  local label="$1" app="$2"; shift 2
  rm -f "$TRACE_DIR"/*.jsonl 2>/dev/null
  local t0 t1
  t0=$(now_ms)
  R_OUT=$(sudo launchctl asuser "$UIDN" sudo -u "$ME" /usr/bin/env \
    "${GUI_ENV[@]}" THINGS_API_TRACE=1 "$NODE" "$app" area reorder "$@" \
    --dangerously-drive-gui --verify-timeout 120000 --json 2>/dev/null)
  R_CODE=$?
  t1=$(now_ms)
  R_WALL=$((t1 - t0))
  printf '%s\n' "$R_OUT" >"$OUT/$label.json"
  R_HOPS=$(hop_summary "$(newest_trace)")
  echo "     [$label] exit=$R_CODE wall=${R_WALL}ms  hops/ms/lock-ms/session: $R_HOPS"
  echo "     $(head -c 600 <<<"$R_OUT")"
}

# repeating <label> <app-js> <uuid> — one field-shaped make-repeating, timed and traced.
#
# MEASURED (LOCKSCR2 cell a, first pass): a make-repeating started on the heels
# of a sidebar drag refuses `blocked:environment — a dialog is already open`.
# The drag leaves something in the AX tree that the open-dialog preflight reads
# as a sheet for a few seconds. It is a LAB sequencing artifact, not an operation
# under test, so the cells settle between the two.
repeating() {
  local label="$1" app="$2" uuid="$3"
  sleep 6
  rm -f "$TRACE_DIR"/*.jsonl 2>/dev/null
  local t0 t1
  t0=$(now_ms)
  M_OUT=$(sudo launchctl asuser "$UIDN" sudo -u "$ME" /usr/bin/env \
    "${GUI_ENV[@]}" THINGS_API_TRACE=1 "$NODE" "$app" todo make-repeating "$uuid" \
    --frequency weekly --interval 1 --dangerously-drive-gui --verify-timeout 120000 --json 2>/dev/null)
  M_CODE=$?
  t1=$(now_ms)
  M_WALL=$((t1 - t0))
  printf '%s\n' "$M_OUT" >"$OUT/$label.json"
  M_HOPS=$(hop_summary "$(newest_trace)")
  echo "     [$label] exit=$M_CODE wall=${M_WALL}ms  hops/ms/lock-ms/session: $M_HOPS"
  echo "     $(head -c 600 <<<"$M_OUT")"
}

echo "############################################################"
echo "# LOCKSCR2 (#732 follow-ons) — certification cells"
echo "# arm: ${LOCKSCR2_ARM:-unset}   before-bundle: ${BEFORE:-none}   clock: $(date)"
echo "############################################################"

GUI_UID=$(gui /usr/bin/id -u 2>/dev/null | tr -dc 0-9)
[ "$GUI_UID" = "$UIDN" ] && pass "0 — the Aqua-session wrapper re-enters as uid $GUI_UID" \
  || fail "0 — launchctl asuser did not re-enter the session (got '$GUI_UID')"

launch_things
things_ssh config set ui-enabled true >/dev/null 2>&1
things_ssh config set experimental-area-reorder true >/dev/null 2>&1
echo "     ui-enabled=$(things_ssh config get ui-enabled 2>/dev/null) experimental-area-reorder=$(things_ssh config get experimental-area-reorder 2>/dev/null)"

for n in 1 2 3; do
  things_gui area add "$TAG-A$n" >/dev/null 2>&1 || fail "setup — could not add $TAG-A$n"
done
for n in 1 2 3 4; do
  things_gui todo add "$TAG-REP$n" --when 2026-07-10 >/dev/null 2>&1 || fail "setup — could not add $TAG-REP$n"
done
REP1=$(db "SELECT uuid FROM TMTask WHERE title='$TAG-REP1' AND trashed=0 LIMIT 1")
REP2=$(db "SELECT uuid FROM TMTask WHERE title='$TAG-REP2' AND trashed=0 LIMIT 1")
REP3=$(db "SELECT uuid FROM TMTask WHERE title='$TAG-REP3' AND trashed=0 LIMIT 1")
echo "     fixtures: areas $(area_order); REP1=$REP1 REP2=$REP2 REP3=$REP3"
echo "     session keys, unlocked: $(session_keys)"

########################################################################
echo ""
echo "===== CELL a — the HAPPY path, hop for hop, before and after ====="
########################################################################
if [ -n "$BEFORE" ] && [ -f "$BEFORE/dist/cli/main.js" ]; then
  reorder "a-reorder-before" "$BEFORE/dist/cli/main.js" "$TAG-A3" --first
  A_HOPS_BEFORE=${R_HOPS%% *}
  [ "$R_CODE" -eq 0 ] && pass "a — the BEFORE build's reorder landed" || fail "a — BEFORE reorder exit $R_CODE"
  repeating "a-repeat-before" "$BEFORE/dist/cli/main.js" "$REP1"
  M_HOPS_BEFORE=${M_HOPS%% *}
  [ "$M_CODE" -eq 0 ] && pass "a — the BEFORE build's make-repeating landed" || fail "a — BEFORE make-repeating exit $M_CODE"
else
  A_HOPS_BEFORE=""
  M_HOPS_BEFORE=""
  echo "     (no before-bundle on this arm — the after half stands alone)"
fi

reorder "a-reorder-after" "$APP" "$TAG-A2" --first
A_HOPS_AFTER=${R_HOPS%% *}
A_LOCK_MS_AFTER=$(awk '{print $3}' <<<"$R_HOPS")
[ "$R_CODE" -eq 0 ] && pass "a — the AFTER build's reorder landed" || fail "a — AFTER reorder exit $R_CODE"
[ "$A_LOCK_MS_AFTER" = "0" ] && pass "a — reorder spent NO hop of its own on the lock question" \
  || fail "a — reorder still spent ${A_LOCK_MS_AFTER}ms on a lock probe hop"

repeating "a-repeat-after" "$APP" "$REP2"
M_HOPS_AFTER=${M_HOPS%% *}
M_LOCK_MS_AFTER=$(awk '{print $3}' <<<"$M_HOPS")
[ "$M_CODE" -eq 0 ] && pass "a — the AFTER build's make-repeating landed" || fail "a — AFTER make-repeating exit $M_CODE"
[ "$M_LOCK_MS_AFTER" = "0" ] && pass "a — make-repeating spent NO hop of its own on the lock question" \
  || fail "a — make-repeating still spent ${M_LOCK_MS_AFTER}ms on a lock probe hop"

if [ -n "$A_HOPS_BEFORE" ]; then
  echo "     HOPS  area reorder:   before=$A_HOPS_BEFORE  after=$A_HOPS_AFTER"
  echo "     HOPS  make-repeating: before=$M_HOPS_BEFORE  after=$M_HOPS_AFTER"
  [ "$A_HOPS_AFTER" -lt "$A_HOPS_BEFORE" ] && pass "a — area reorder is one hop lighter" \
    || fail "a — area reorder hops $A_HOPS_BEFORE -> $A_HOPS_AFTER"
  [ "$M_HOPS_AFTER" -lt "$M_HOPS_BEFORE" ] && pass "a — make-repeating is one hop lighter" \
    || fail "a — make-repeating hops $M_HOPS_BEFORE -> $M_HOPS_AFTER"
fi

########################################################################
echo ""
echo "===== CELL e — window CLOSED, screen unlocked: the reopen rung ====="
########################################################################
launch_things
osascript -e 'tell application "Things3" to activate' >/dev/null 2>&1
sleep 2
osascript -e 'tell application "System Events" to keystroke "w" using command down' >/dev/null 2>&1
sleep 3
echo "     standard windows after ⌘W: $(std_windows)"
E_BEFORE=$(area_order)
reorder "e-window-closed" "$APP" "$TAG-A1" --first
E_AFTER=$(area_order)
E_NOTES=$(jsonf data notes <<<"$R_OUT")
echo "     notes: $(head -c 400 <<<"$E_NOTES")"
echo "     standard windows after the drive: $(std_windows)"
if [ "$R_CODE" -eq 0 ] && [ "${E_AFTER%%|*}" = "$TAG-A1" ]; then
  pass "e — the reorder LANDED through a closed window (exit 0, $TAG-A1 first)"
else
  fail "e — exit $R_CODE, order '$E_BEFORE' -> '$E_AFTER'"
fi
case "$E_NOTES" in
  *"reopened"*) pass "e — the result says a window was reopened" ;;
  *) fail "e — no reopen note on the result" ;;
esac
case "$E_NOTES" in
  *"left open"*) pass "e — the result says it was left open" ;;
  *) fail "e — the result does not say the window was left open" ;;
esac
[ "$(std_windows)" = "1" ] && pass "e — the window is still open afterwards" || fail "e — windows now $(std_windows)"
case "$R_OUT" in
  *"Dock icon"*) fail "e — the #732 sentence is still being emitted" ;;
  *) pass "e — no Dock-icon instruction anywhere" ;;
esac

########################################################################
echo ""
echo "===== CELL c — SCREEN SAVER, no password required: the nudge ====="
########################################################################
sudo sysadminctl -screenLock off -password admin >/dev/null 2>&1
echo "     screenLock: $(sudo sysadminctl -screenLock status 2>&1 | tr '\n' ' ')"
open -a ScreenSaverEngine >/dev/null 2>&1
sleep 6
echo "     ScreenSaverEngine: $(pgrep -x ScreenSaverEngine >/dev/null 2>&1 && echo running || echo absent)"
echo "     session keys, saver up: $(session_keys)"
C_STATE=$(session_state)
echo "     session state under the saver: $C_STATE"
[ "$C_STATE" = "screensaver" ] && pass "c — the saver reads SCREENSAVER, not LOCKED" || fail "c — read '$C_STATE'"
# `doctor --ui-state` itself does not nudge; the DRIVE does.
open -a ScreenSaverEngine >/dev/null 2>&1
sleep 5
C_BEFORE=$(area_order)
reorder "c-screensaver-nopw" "$APP" "$TAG-A3" --first
C_AFTER=$(area_order)
C_NOTES=$(jsonf data notes <<<"$R_OUT")
echo "     notes: $(head -c 400 <<<"$C_NOTES")"
echo "     ScreenSaverEngine after the drive: $(pgrep -x ScreenSaverEngine >/dev/null 2>&1 && echo running || echo gone)"
echo "     session state after the drive: $(session_state)"
if [ "$R_CODE" -eq 0 ] && [ "${C_AFTER%%|*}" = "$TAG-A3" ]; then
  pass "c — the reorder LANDED through a screen saver (exit 0, $TAG-A3 first)"
else
  fail "c — exit $R_CODE, order '$C_BEFORE' -> '$C_AFTER'"
fi
case "$C_NOTES" in
  *"screen saver was up and was dismissed"*) pass "c — the result says the saver was dismissed" ;;
  *) fail "c — no saver-dismissed note on the result" ;;
esac
[ "$(pgrep -x ScreenSaverEngine >/dev/null 2>&1 && echo running || echo gone)" = "gone" ] \
  && pass "c — the saver is actually gone" || fail "c — the saver is still running"
[ "$(session_state)" = "unlocked" ] && pass "c — the session reads unlocked again" \
  || fail "c — the session reads $(session_state)"

########################################################################
echo ""
echo "===== CELL f prep — close the window while the screen is still unlocked ====="
########################################################################
launch_things
osascript -e 'tell application "Things3" to activate' >/dev/null 2>&1
sleep 2
osascript -e 'tell application "System Events" to keystroke "w" using command down' >/dev/null 2>&1
sleep 3
echo "     standard windows: $(std_windows)"

########################################################################
echo ""
echo "===== CELL d — SCREEN SAVER, password REQUIRED: the nudge fails honestly ====="
########################################################################
sudo sysadminctl -screenLock immediate -password admin >/dev/null 2>&1
echo "     screenLock: $(sudo sysadminctl -screenLock status 2>&1 | tr '\n' ' ')"
open -a ScreenSaverEngine >/dev/null 2>&1
sleep 6
echo "     ScreenSaverEngine: $(pgrep -x ScreenSaverEngine >/dev/null 2>&1 && echo running || echo absent)"
echo "     session keys, saver up (password required): $(session_keys)"
D_STATE=$(session_state)
echo "     session state: $D_STATE"
D_BEFORE=$(area_order)
reorder "d-screensaver-pw" "$APP" "$TAG-A2" --first
D_AFTER=$(area_order)
D_MSG=$(jsonf error message <<<"$R_OUT")
D_CODE=$(jsonf error code <<<"$R_OUT")
echo "     error code: $D_CODE"
echo "     message: $(head -c 500 <<<"$D_MSG")"
echo "     ScreenSaverEngine after the drive: $(pgrep -x ScreenSaverEngine >/dev/null 2>&1 && echo running || echo gone)"
[ "$R_CODE" -eq 4 ] && pass "d — refused, exit 4" || fail "d — exit $R_CODE (wanted 4)"
[ "$D_BEFORE" = "$D_AFTER" ] && pass "d — the sidebar is unchanged" || fail "d — order '$D_BEFORE' -> '$D_AFTER'"
case "$D_MSG" in
  *"did not clear when the Mac was nudged"*) pass "d — the refusal says the nudge was tried and failed" ;;
  *"the screen saver is up"*) echo "     NOTE: the un-nudged saver sentence fired instead" ;;
  *"the screen is locked"*) echo "     NOTE: the hard-lock sentence fired instead" ;;
  *) fail "d — the refusal names neither the saver nor the lock" ;;
esac
case "$D_MSG" in
  *"Dock icon"*) fail "d — the #732 sentence is still being emitted" ;;
  *) pass "d — no Dock-icon instruction anywhere" ;;
esac

########################################################################
echo ""
echo "===== CELL f — window CLOSED and the screen HARD-LOCKED: the session wins ====="
########################################################################
killall ScreenSaverEngine >/dev/null 2>&1
sleep 3
gui /usr/bin/python3 -c 'import ctypes; lf=ctypes.CDLL("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login"); print("SACLockScreenImmediate rc=", lf.SACLockScreenImmediate())' 2>&1 | sed 's/^/     /'
sleep 5
echo "     standard windows: $(std_windows)   session: $(session_state)"
F_BEFORE=$(area_order)
reorder "f-closed-and-locked" "$APP" "$TAG-A1" --first
F_AFTER=$(area_order)
F_MSG=$(jsonf error message <<<"$R_OUT")
echo "     message: $(head -c 400 <<<"$F_MSG")"
[ "$R_CODE" -eq 4 ] && pass "f — refused, exit 4" || fail "f — exit $R_CODE (wanted 4)"
[ "$F_BEFORE" = "$F_AFTER" ] && pass "f — the sidebar is unchanged" || fail "f — order changed"
case "$F_MSG" in
  *"no open window"*) fail "f — the WINDOW sentence won over the session evidence" ;;
  *) pass "f — the session refusal outranks the window inventory" ;;
esac
case "$F_MSG" in
  *"the screen is locked"*) pass "f — and it is the LOCK sentence, on a closed-window Mac" ;;
  *) fail "f — the lock sentence did not fire: $(head -c 200 <<<"$F_MSG")" ;;
esac

########################################################################
echo ""
echo "===== CELL b — LOCKED: the LOCKSCR1 refusal, unchanged in substance ====="
########################################################################
B_STATE=$(session_state)
echo "     session state: $B_STATE"
echo "     session keys, locked: $(session_keys)"
[ "$B_STATE" = "locked" ] && pass "b — the session reads LOCKED" || fail "b — read '$B_STATE'"
B_BEFORE=$(area_order)
reorder "b-locked-reorder" "$APP" "$TAG-A1" --first
B_AFTER=$(area_order)
B_MSG=$(jsonf error message <<<"$R_OUT")
B_ERRCODE=$(jsonf error code <<<"$R_OUT")
echo "     error code: $B_ERRCODE"
echo "     message: $(head -c 500 <<<"$B_MSG")"
[ "$R_CODE" -eq 4 ] && pass "b — exit 4 (blocked)" || fail "b — exit $R_CODE"
[ "$B_ERRCODE" = "blocked:H-UI-SESSION-UNREACHABLE" ] && pass "b — blocked:H-UI-SESSION-UNREACHABLE" \
  || fail "b — error code '$B_ERRCODE'"
case "$B_MSG" in
  *"the screen is locked"*) pass "b — the refusal names the lock" ;;
  *) fail "b — the refusal does not name the lock" ;;
esac
case "$B_MSG" in
  *"Dock icon"*) fail "b — the #732 sentence is still being emitted" ;;
  *) pass "b — no Dock-icon instruction anywhere" ;;
esac
[ "$R_WALL" -le 5000 ] && pass "b — refused in ${R_WALL}ms" || fail "b — took ${R_WALL}ms"
[ "$B_BEFORE" = "$B_AFTER" ] && pass "b — the sidebar is unchanged" || fail "b — order changed"

echo ""
echo "----- b2 — make-repeating under the same lock -----"
repeating "b2-locked-make-repeating" "$APP" "$REP3"
MR_MSG=$(jsonf error message <<<"$M_OUT")
[ "$M_CODE" -eq 4 ] && pass "b2 — make-repeating exit 4" || fail "b2 — exit $M_CODE"
case "$MR_MSG" in
  *"the screen is locked"*) pass "b2 — the same sentence from the composite's pre-seed gate" ;;
  *) fail "b2 — the refusal does not name the lock: $(head -c 200 <<<"$MR_MSG")" ;;
esac
MR_TPL=$(db "SELECT count(*) FROM TMTask WHERE title='$TAG-REP3' AND rt1_recurrenceRule IS NOT NULL")
[ "$MR_TPL" = "0" ] && pass "b2 — no rule was written (zero mutation)" || fail "b2 — $MR_TPL template row(s)"

echo ""
echo "############################################################"
echo "# LOCKSCR2 cells finished — failures: $FAILURES"
echo "############################################################"
exit "$FAILURES"
