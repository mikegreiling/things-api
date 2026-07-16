#!/bin/bash
# REM1-b (focused re-run) — HID absolute digit entry into the repeat-dialog reminder
# AXDateTimeArea's HOUR segment. The first pass (research-rem1.sh) had a script bug
# that threw before any digit was typed, so only the segment CLICK landed and OK
# committed the picker DEFAULT (12:00). This run fixes the driver: click the hour
# segment, type an absolute time (07:00 — distinct from any wall-clock default so a
# commit of 07:00 is unambiguous evidence the keystrokes stuck), read the control's
# AXValue back after each keystroke phase, OK, and DB-verify the committed reminderTime.
#
# Absolute digit entry is the ONLY doctrine-clean primitive here: arrow-key-from-default
# depends on the picker's initial value (current wall clock), which is non-deterministic,
# so it is out of scope regardless of whether it would work.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"

VM="rem1-lab"
WANT="07:00"; WANT_PACKED=$(( (7*64+0) << 20 ))   # 469762048
DEFAULT_PACKED=805306368                          # 12:00 (the picker default at the pinned clock)
OUT="lab/artifacts/${VM}b"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[rem1b] $*" | tee -a "$REPORT"; }
cleanup() { echo "[rem1b] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "want=$WANT packed=$WANT_PACKED (default 12:00 packed=$DEFAULT_PACKED)"
note "cloning golden -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# ---------- AXVM1 grant (rung b) ----------
note "############### grant Accessibility (AXVM1 rung b) ###############"
lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null
if [ -z "$VNCDO" ] || [ -z "$VNC_URL" ]; then note "VNCDO/VNC_URL missing. Abort."; exit 1; fi
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
V() { sleep 2; timeout 40 "$VNCDO" -s "$SERVER" -p "$PASS" "$@" 2>>"$OUT/vnc.log"; }
lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 12
V move 1642 332 click 1
V move 1018 869 click 1 pause 0.6 type admin pause 0.6 move 1018 963 click 1
sleep 3
note "grant: $(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)"
lab_ssh "$IP" 'osascript -e '\''tell application "System Settings" to quit'\'' 2>/dev/null' </dev/null

warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
uid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL LIMIT 1"; }
tmpl() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1"; }

# The FIXED HID driver: reads AXValue at each phase so we can see whether the
# hour/minute keystrokes register in the control before commit.
lab_ssh "$IP" 'cat > /tmp/remb.js' <<'EOF'
ObjC.import('Foundation'); ObjC.import('AppKit'); ObjC.import('CoreGraphics'); ObjC.import('ApplicationServices');
function sleep(ms){ $.NSThread.sleepForTimeInterval(ms/1000); }
function attr(el,name){ var out=Ref(); if($.AXUIElementCopyAttributeValue(el,$(name),out)!==0) return null; return ObjC.castRefToObject(out[0]); }
function rolestr(el){ var v=attr(el,'AXRole'); return v? v.js : ''; }
function kids(el){ var c=attr(el,'AXChildren'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a; }
function find(el,role,depth){ if(depth<0) return null; if(rolestr(el)===role) return el; var ks=kids(el); for(var i=0;i<ks.length;i++){ var r=find(ks[i],role,depth-1); if(r) return r;} return null; }
function frame(el){ var p=attr(el,'AXPosition'), z=attr(el,'AXSize'); if(!p||!z) return null;
  var pd=ObjC.castRefToObject($.CFCopyDescription(p)).js, zd=ObjC.castRefToObject($.CFCopyDescription(z)).js;
  var pm=pd.match(/x:([-0-9.]+) y:([-0-9.]+)/), zm=zd.match(/w:([-0-9.]+) h:([-0-9.]+)/);
  return (pm&&zm)?{x:+pm[1],y:+pm[2],w:+zm[1],h:+zm[2]}:null; }
function valdesc(el){ var v=attr(el,'AXValue'); return v? ObjC.castRefToObject($.CFCopyDescription(v)).js : 'nil'; }
function mev(t,x,y,cs){ var e=$.CGEventCreateMouseEvent($(),t,$.CGPointMake(x,y),0); if(cs)$.CGEventSetIntegerValueField(e,1,cs); return e; }
function click(x,y){ $.CGEventPost($.kCGHIDEventTap,mev(5,x,y,0)); sleep(20);
  $.CGEventPost($.kCGHIDEventTap,mev(1,x,y,1)); sleep(15); $.CGEventPost($.kCGHIDEventTap,mev(2,x,y,1)); sleep(120); }
function key(code){ var d=$.CGEventCreateKeyboardEvent($(),code,true), u=$.CGEventCreateKeyboardEvent($(),code,false);
  $.CGEventPost($.kCGHIDEventTap,d); sleep(30); $.CGEventPost($.kCGHIDEventTap,u); sleep(80); }
var DIG={ '0':29,'1':18,'2':19,'3':20,'4':21,'5':23,'6':22,'7':26,'8':28,'9':25 }, TAB=48;
function typeStr(s){ for(var i=0;i<s.length;i++) key(DIG[s[i]]); }
(function(){
  var apps=$.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.culturedcode.ThingsMac');
  if(!apps||apps.count===0){ console.log('ERR no things'); return; }
  var app=$.AXUIElementCreateApplication(apps.objectAtIndex(0).processIdentifier);
  var dt=null; for(var t=0;t<30&&!dt;t++){ dt=find(app,'AXDateTimeArea',18); if(!dt) sleep(150); }
  if(!dt){ console.log('ERR no AXDateTimeArea'); return; }
  var f=frame(dt); console.log('FRAME '+JSON.stringify(f)+' INIT '+valdesc(dt));
  if(!f){ console.log('ERR no frame'); return; }
  var hx=f.x+f.w*0.12, cy=f.y+f.h/2;
  click(hx,cy); sleep(150); console.log('AFTER-CLICK '+valdesc(dt));
  typeStr('07'); sleep(150); console.log('AFTER-HOUR '+valdesc(dt));
  key(TAB); sleep(120);
  typeStr('00'); sleep(150); console.log('AFTER-MIN '+valdesc(dt));
  console.log('OK');
})();
EOF

run_b() { # <title>
  local title="$1" u; u=$(uid "$title")
  note "  seed $title ($u)"
  warm
  lab_ssh "$IP" "open 'things:///show?id=$u'; sleep 2; osascript -e 'tell application \"Things3\" to activate'; sleep 1" </dev/null
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1'\''; sleep 2' </dev/null
  lab_ssh "$IP" 'osascript <<AS 2>&1
tell application "System Events" to tell process "Things3"
  set theSheet to sheet 1 of (first window whose subrole is "AXStandardWindow")
  set pu to pop up button 1 of theSheet
  repeat 20 times
    if (exists menu 1 of pu) then exit repeat
    click pu
    delay 0.3
  end repeat
  click menu item "daily" of menu 1 of pu
  delay 0.5
  click checkbox "Add reminders" of theSheet
  delay 0.6
end tell
AS' </dev/null | sed 's/^/  ['"$title"' setup] /' | tee -a "$REPORT"
  local bout; bout=$(lab_ssh "$IP" 'osascript -l JavaScript /tmp/remb.js 2>&1' </dev/null || true)
  echo "$bout" | sed 's/^/  ['"$title"' hid] /' | tee -a "$REPORT"
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to click button "OK" of sheet 1 of (first window whose subrole is "AXStandardWindow")'\''; sleep 2' </dev/null 2>/dev/null || true
  local tb rem; tb=$(tmpl "$title")
  rem=$(gq "SELECT coalesce(reminderTime,'NULL') FROM TMTask WHERE uuid='$tb'")
  note "  >>> $title committed template.reminderTime=$rem (want $WANT=$WANT_PACKED; default 12:00=$DEFAULT_PACKED)"
}

note "############### REM1-b: HID absolute digit entry (hour segment) ###############"
lab_ssh "$IP" "open 'things:///add?title=REM1-B1'; sleep 1" </dev/null
lab_ssh "$IP" "open 'things:///add?title=REM1-B2'; sleep 1" </dev/null
lab_ssh "$IP" "open 'things:///add?title=REM1-B3'; sleep 1" </dev/null
run_b REM1-B1
run_b REM1-B2
run_b REM1-B3

note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 --"
note "DONE. report: $REPORT"
