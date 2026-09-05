#!/bin/bash
# LOCKSCR2 (#732 follow-ons) — the EXPLORATORY probe. Runs ON THE GUEST.
#
# Three unknowns this file settles before any code is written:
#
#   R1  Can AppleScriptObjC (`use framework "CoreGraphics"`) resolve
#       CGSessionCopyCurrentDictionary? If it can, the session read folds into
#       the SESSGATE reachability hop (AppleScript) with no extra spawn.
#   R2  Does the JXA ObjC bridge expose IOKit's IOPMAssertionDeclareUserActivity?
#   R3  Which assertion of user activity — an IOKit power assertion, a zero-delta
#       CGEventMouseMoved, a ±1px round trip, or killing the saver process —
#       actually clears `CGSSessionScreenIsLocked` for a bare screen saver, and
#       which of them does nothing when a password IS required?
#
# Usage: lockscr2-probe.sh <phase>       phase = base | saver-nopw | saver-pw
set -u
PHASE="$1"
UIDN=$(id -u)
ME=$(id -un)
gui() { sudo launchctl asuser "$UIDN" sudo -u "$ME" /usr/bin/env "HOME=$HOME" "PATH=$PATH" "$@"; }

# ---------------------------------------------------------------- the readings
SESS_JXA='
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
function lockDict(){
  var d=null; try { d=$.CGSessionCopyCurrentDictionary() } catch(e){ return null }
  if(!d) return null;
  var tries=[function(){return ObjC.deepUnwrap(ObjC.castRefToObject(d))},
             function(){return ObjC.deepUnwrap(d)},
             function(){return d.js}];
  for(var i=0;i<tries.length;i++){ try{ var v=tries[i](); if(v&&typeof v==="object"&&!(v instanceof Array)) return v }catch(e){} }
  return null }
function saver(){ try{ var a=$.NSWorkspace.sharedWorkspace.runningApplications,n=Number(a.count);
  for(var i=0;i<n;i++){ var b=null; try{ b=ObjC.unwrap(a.objectAtIndex(i).bundleIdentifier) }catch(e){}
    if(typeof b==="string"&&b.toLowerCase().indexOf("screensaver")>=0) return true } return false }catch(e){ return null } }
var out={keys:[],locked:null,secureInputPid:null,onConsole:null,saver:saver(),source:"unavailable"};
var d=lockDict();
if(d!==null){ out.source="session-dictionary";
  for(var k in d) if(Object.prototype.hasOwnProperty.call(d,k)) out.keys.push(k);
  out.keys.sort();
  if(out.keys.indexOf("CGSSessionScreenIsLocked")>=0) out.locked=!!d["CGSSessionScreenIsLocked"];
  if(out.keys.indexOf("kCGSSessionSecureInputPID")>=0) out.secureInputPid=d["kCGSSessionSecureInputPID"];
  if(out.keys.indexOf("kCGSessionOnConsoleKey")>=0) out.onConsole=!!d["kCGSessionOnConsoleKey"]; }
JSON.stringify(out)'

sess() { gui /usr/bin/osascript -l JavaScript -e "$SESS_JXA" 2>&1; }
say() { echo "     $*"; }
read_state() { echo "  [$1] $(sess)"; }

# ---------------------------------------------------------------- R1  ASObjC
asobjc_probe() {
  gui /usr/bin/osascript <<'AS' 2>&1
use framework "Foundation"
use framework "CoreGraphics"
use scripting additions
set out to "ASOBJC "
try
	set d to current application's CGSessionCopyCurrentDictionary()
	if d is missing value then
		set out to out & "MISSING-VALUE"
	else
		set ks to (d's allKeys()) as list
		set locked to "absent"
		try
			set v to (d's objectForKey:"CGSSessionScreenIsLocked")
			if v is not missing value then set locked to (v as boolean) as text
		end try
		set out to out & "OK keys=" & ((count of ks) as text) & " locked=" & locked
	end if
on error errMsg number errNum
	set out to out & "ERR " & (errNum as text) & " " & errMsg
end try
return out
AS
}

# ---------------------------------------------------------------- R2/R3 wakes
wake_iokit() {
  gui /usr/bin/osascript -l JavaScript -e '
ObjC.import("IOKit");
var out = "IOKIT ";
try {
  var id = Ref();
  var rc = $.IOPMAssertionDeclareUserActivity($("lockscr2 wake"), 0, id);
  out += "rc=" + rc;
} catch (e) { out += "ERR " + e.message }
out' 2>&1
}

wake_move_zero() {
  gui /usr/bin/osascript -l JavaScript -e '
ObjC.import("CoreGraphics");
var out = "MOVE0 ";
try {
  var cur = $.CGEventCreate($());
  var loc = $.CGEventGetLocation(cur);
  var ev = $.CGEventCreateMouseEvent($(), 5, loc, 0);
  $.CGEventPost($.kCGHIDEventTap, ev);
  out += "posted at " + Math.round(loc.x) + "," + Math.round(loc.y);
} catch (e) { out += "ERR " + e.message }
out' 2>&1
}

wake_move_jiggle() {
  gui /usr/bin/osascript -l JavaScript -e '
ObjC.import("CoreGraphics");
function sleep(ms){ $.NSThread.sleepForTimeInterval(ms/1000) }
var out = "JIGGLE ";
try {
  var cur = $.CGEventCreate($());
  var loc = $.CGEventGetLocation(cur);
  function mv(x,y){ $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent($(), 5, $.CGPointMake(x,y), 0)) }
  mv(loc.x + 1, loc.y); sleep(60);
  mv(loc.x, loc.y);
  out += "jiggled around " + Math.round(loc.x) + "," + Math.round(loc.y);
} catch (e) { out += "ERR " + e.message }
out' 2>&1
}

echo "############ LOCKSCR2 probe — phase $PHASE — $(date) ############"

case "$PHASE" in
base)
  read_state "unlocked baseline"
  say "$(asobjc_probe)"
  say "$(wake_iokit)      (bridge availability, unlocked)"
  say "$(wake_move_zero)  (post availability, unlocked)"
  read_state "after the two no-op wakes"
  ;;

saver-nopw | saver-pw)
  if [ "$PHASE" = "saver-nopw" ]; then
    say "sysadminctl -screenLock off (no password required after the saver)"
    sudo sysadminctl -screenLock off -password admin 2>&1 | sed 's/^/       /'
  else
    say "sysadminctl -screenLock immediate (password required the moment the saver starts)"
    sudo sysadminctl -screenLock immediate -password admin 2>&1 | sed 's/^/       /'
  fi
  say "screenLock setting now: $(sudo sysadminctl -screenLock status 2>&1 | tr '\n' ' ')"
  read_state "before the saver"
  open -a ScreenSaverEngine >/dev/null 2>&1
  sleep 6
  say "ScreenSaverEngine: $(pgrep -x ScreenSaverEngine >/dev/null 2>&1 && echo running || echo absent)"
  read_state "saver up"

  say "$(wake_iokit)"
  sleep 3
  read_state "after the IOKit user-activity assertion"
  say "ScreenSaverEngine: $(pgrep -x ScreenSaverEngine >/dev/null 2>&1 && echo running || echo absent)"

  say "$(wake_move_zero)"
  sleep 3
  read_state "after the zero-delta mouse move"
  say "ScreenSaverEngine: $(pgrep -x ScreenSaverEngine >/dev/null 2>&1 && echo running || echo absent)"

  say "$(wake_move_jiggle)"
  sleep 3
  read_state "after the 1px jiggle"
  say "ScreenSaverEngine: $(pgrep -x ScreenSaverEngine >/dev/null 2>&1 && echo running || echo absent)"

  killall ScreenSaverEngine >/dev/null 2>&1
  sleep 3
  read_state "after killall ScreenSaverEngine"
  ;;
*)
  echo "unknown phase '$PHASE'"
  exit 2
  ;;
esac
echo "############ phase $PHASE done ############"
