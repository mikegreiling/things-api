#!/bin/bash
# LOCKSCR2 round 2 — WHY nothing wakes a screen saver.
#
# Round 1 measured that an IOKit user-activity assertion, a zero-delta
# CGEventMouseMoved, a ±1px jiggle and killing ScreenSaverEngine all leave
# `CGSSessionScreenIsLocked` set. This round asks whether that is because the
# window server IGNORES the wake, or because SECURE INPUT — which the session
# dictionary reports as `kCGSSessionSecureInputPID` the instant the saver starts
# — swallows synthesized events before they reach anything at all.
#
# The discriminator is a POINTER TELEPORT: post a mouse-move to a coordinate the
# pointer is not at, then read the pointer back. Unlocked, the pointer must
# follow. Under the saver, if it does not, synthetic input is being dropped at
# the input path and no synthesized wake of any kind can ever work.
#
# Usage: lockscr2-probe2.sh <phase>       phase = base | saver-nopw
set -u
PHASE="$1"
UIDN=$(id -u)
ME=$(id -un)
gui() { sudo launchctl asuser "$UIDN" sudo -u "$ME" /usr/bin/env "HOME=$HOME" "PATH=$PATH" "$@"; }
say() { echo "     $*"; }

SESS_JXA='
ObjC.import("CoreGraphics"); ObjC.import("AppKit");
function lockDict(){ var d=null; try{ d=$.CGSessionCopyCurrentDictionary() }catch(e){ return null }
  if(!d) return null;
  try{ return ObjC.deepUnwrap(ObjC.castRefToObject(d)) }catch(e){ return null } }
var d=lockDict()||{};
var out={locked:("CGSSessionScreenIsLocked" in d)?!!d["CGSSessionScreenIsLocked"]:null,
         secureInputPid:("kCGSSessionSecureInputPID" in d)?d["kCGSSessionSecureInputPID"]:null};
JSON.stringify(out)'
sess() { gui /usr/bin/osascript -l JavaScript -e "$SESS_JXA" 2>&1; }

# teleport <x> <y> — post an absolute mouse-move and read the pointer back.
teleport() {
  gui /usr/bin/osascript -l JavaScript -e "
ObjC.import('CoreGraphics');
function here(){ var e=\$.CGEventCreate(\$()); var p=\$.CGEventGetLocation(e); return Math.round(p.x)+','+Math.round(p.y) }
var before = here();
var out = 'TELEPORT from ' + before + ' -> ($1,$2): ';
try {
  \$.CGEventPost(\$.kCGHIDEventTap, \$.CGEventCreateMouseEvent(\$(), 5, \$.CGPointMake($1,$2), 0));
  \$.NSThread.sleepForTimeInterval(0.4);
  out += 'pointer now ' + here();
} catch (e) { out += 'ERR ' + e.message }
out" 2>&1
}

# key_escape — post an Escape keystroke to the HID tap.
key_escape() {
  gui /usr/bin/osascript -l JavaScript -e '
ObjC.import("CoreGraphics");
var out = "KEY-ESC ";
try {
  var d = $.CGEventCreateKeyboardEvent($(), 53, true), u = $.CGEventCreateKeyboardEvent($(), 53, false);
  $.CGEventPost($.kCGHIDEventTap, d); $.NSThread.sleepForTimeInterval(0.05); $.CGEventPost($.kCGHIDEventTap, u);
  out += "posted";
} catch (e) { out += "ERR " + e.message }
out' 2>&1
}

# post_to_pid <pid> — the same mouse move, addressed to one process.
post_to_pid() {
  gui /usr/bin/osascript -l JavaScript -e "
ObjC.import('CoreGraphics');
var out = 'POST-TO-PID $1 ';
try {
  \$.CGEventPostToPid($1, \$.CGEventCreateMouseEvent(\$(), 5, \$.CGPointMake(400,400), 0));
  out += 'posted';
} catch (e) { out += 'ERR ' + e.message }
out" 2>&1
}

echo "############ LOCKSCR2 probe2 — phase $PHASE — $(date) ############"
say "caffeinate: $(command -v caffeinate || echo absent)"

if [ "$PHASE" = "base" ]; then
  say "session: $(sess)"
  say "$(teleport 200 200)"
  say "$(teleport 320 240)"
  say "$(key_escape)"
  say "session: $(sess)"
  exit 0
fi

say "sysadminctl -screenLock off (no password required)"
sudo sysadminctl -screenLock off -password admin 2>&1 | sed 's/^/       /'
say "$(teleport 200 200)   [control: the pointer must follow while unlocked]"
open -a ScreenSaverEngine >/dev/null 2>&1
sleep 6
SAVER_PID=$(pgrep -x ScreenSaverEngine | head -1)
say "ScreenSaverEngine pid: ${SAVER_PID:-none}"
say "session: $(sess)"

say "$(teleport 480 360)   [THE DISCRIMINATOR: does synthetic input reach the input path?]"
say "session: $(sess)"

say "$(key_escape)"
sleep 2
say "session: $(sess)  saver: $(pgrep -x ScreenSaverEngine >/dev/null && echo running || echo gone)"

if [ -n "${SAVER_PID:-}" ]; then
  say "$(post_to_pid "$SAVER_PID")"
  sleep 2
  say "session: $(sess)  saver: $(pgrep -x ScreenSaverEngine >/dev/null && echo running || echo gone)"
fi

say "caffeinate -u -t 2 (the official user-activity assertion)"
gui /usr/bin/caffeinate -u -t 2
sleep 3
say "session: $(sess)  saver: $(pgrep -x ScreenSaverEngine >/dev/null && echo running || echo gone)"

say "pmset displaysleepnow then caffeinate -u"
gui /usr/bin/caffeinate -u -t 2
sleep 2
say "session: $(sess)"

echo "############ phase $PHASE done ############"
