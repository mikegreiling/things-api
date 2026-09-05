#!/bin/bash
# LOCKSCR2 round 3 — WHICH key, and what happens when a password IS required.
#
# Round 2 settled the mechanism: synthetic input DOES reach the input path while
# a screen saver is up (a posted mouse-move teleports the pointer), a mouse move
# does NOT dismiss the saver, and a posted ESCAPE does — clearing
# `CGSSessionScreenIsLocked` and `kCGSSessionSecureInputPID` with it.
#
# Two questions remain before this can ship:
#   K1  Does a pure MODIFIER press (left Shift, key code 56) dismiss the saver?
#       A modifier is the safest possible synthetic key: if the saver is already
#       gone when it lands, it types nothing and cancels nothing.
#   K2  With "require password immediately" ON, does the same key leave the
#       session LOCKED? It must — and the drive must then refuse.
#
# Usage: lockscr2-probe3.sh <phase>      phase = shift-nopw | shift-pw
set -u
PHASE="$1"
UIDN=$(id -u)
ME=$(id -un)
gui() { sudo launchctl asuser "$UIDN" sudo -u "$ME" /usr/bin/env "HOME=$HOME" "PATH=$PATH" "$@"; }
say() { echo "     $*"; }

SESS_JXA='
ObjC.import("CoreGraphics"); ObjC.import("AppKit");
function d(){ try{ var x=$.CGSessionCopyCurrentDictionary(); return x? ObjC.deepUnwrap(ObjC.castRefToObject(x)) : {} }catch(e){ return {} } }
var k=d()||{};
JSON.stringify({locked:("CGSSessionScreenIsLocked" in k)?!!k["CGSSessionScreenIsLocked"]:null,
                secureInputPid:("kCGSSessionSecureInputPID" in k)?k["kCGSSessionSecureInputPID"]:null,
                lockedTime:("CGSSessionScreenLockedTime" in k)?1:null})'
sess() { gui /usr/bin/osascript -l JavaScript -e "$SESS_JXA" 2>&1; }

# tapkey <keycode> <label> — post one key down/up pair to the HID tap.
tapkey() {
  gui /usr/bin/osascript -l JavaScript -e "
ObjC.import('CoreGraphics');
var out = 'KEY-$2 ';
try {
  \$.CGEventPost(\$.kCGHIDEventTap, \$.CGEventCreateKeyboardEvent(\$(), $1, true));
  \$.NSThread.sleepForTimeInterval(0.05);
  \$.CGEventPost(\$.kCGHIDEventTap, \$.CGEventCreateKeyboardEvent(\$(), $1, false));
  out += 'posted';
} catch (e) { out += 'ERR ' + e.message }
out" 2>&1
}

saver_state() { pgrep -x ScreenSaverEngine >/dev/null 2>&1 && echo running || echo gone; }

echo "############ LOCKSCR2 probe3 — phase $PHASE — $(date) ############"

if [ "$PHASE" = "shift-nopw" ]; then
  sudo sysadminctl -screenLock off -password admin 2>&1 | sed 's/^/       /'
else
  sudo sysadminctl -screenLock immediate -password admin 2>&1 | sed 's/^/       /'
fi
say "before the saver: $(sess)"
open -a ScreenSaverEngine >/dev/null 2>&1
sleep 6
say "saver: $(saver_state)   session: $(sess)"

# K1 — the pure modifier.
say "$(tapkey 56 SHIFT)"
sleep 3
say "after SHIFT:  saver=$(saver_state)  session=$(sess)"

# If the modifier did nothing, escalate to Escape (round 2's proven key).
if [ "$(saver_state)" = "running" ]; then
  say "$(tapkey 53 ESCAPE)"
  sleep 3
  say "after ESCAPE: saver=$(saver_state)  session=$(sess)"
fi

# A second reading a beat later: the window server may clear the flag lazily.
sleep 4
say "settled:      saver=$(saver_state)  session=$(sess)"

# Can the desktop be driven again? A Things activate + AX window count is the
# same question the drive asks one hop later.
open -a Things3 >/dev/null 2>&1
sleep 8
say "AX standard windows for Things3: $(gui /usr/bin/osascript -e 'tell application "System Events" to tell process "Things3" to count (windows whose subrole is "AXStandardWindow")' 2>&1)"

echo "############ phase $PHASE done ############"
