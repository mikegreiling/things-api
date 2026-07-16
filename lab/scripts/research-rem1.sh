#!/bin/bash
# REM1 — hunt a doctrine-clean workaround for the repeat-reminder gate (oddities §8l).
# Full write-up + verdicts: docs/lab/rem1-reminder-workaround.md.
#
# ONE disposable clone `rem1-lab` of things-lab-golden-v1: grant Accessibility
# (AXVM1 rung b), ship the production e2e bundle, enable ui.enabled, then run
# three probes:
#   REM1-a  INHERITANCE SEEDING — seed a plain to-do with a reminder already set
#           via the quiet URL vector (add?when=<date>@09:00 — dated, so 09:00 is
#           exact per R19, zero-padded so no am/pm heuristic), DB-verify the
#           reminderTime landed, THEN drive make-repeating (no reminder flag). Does
#           the new template / spawned instance INHERIT the 09:00 reminder?
#   REM1-b  HID SUB-FIELD ENTRY — open the Repeat dialog, tick "Add reminders",
#           resolve the reminder AXDateTimeArea frame, HID-click the HOUR segment
#           (left of the resolved frame), type digits, OK. A different path than the
#           failed whole-control AXValue set (§8l). Commits 09:00?
#   REM1-c  NEGATIVE — re-confirm a repeating TEMPLATE resists quiet reminder edits
#           (a keyword when= is a silent no-op, §8k; the TIMED when=@time path is the
#           §1 crash and is NOT re-fired here — cited, not re-triggered).
#
# VM discipline: --vnc-experimental single-client — space VNC calls and issue
# `capture` as a SOLE command. Requires $VNCDO (throwaway vncdotool venv).
# Drive Things WARM (~14s after relaunch); relaunch before each drive (menu health).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"

VM="rem1-lab"
REM_09_00=603979776   # (9*64+0)<<20 — packed reminderTime for 09:00
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/screens"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "[rem1] $*" | tee -a "$REPORT"; }
cleanup() { echo "[rem1] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "cloning golden -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

# read-only guest SQLite + a FULL recurrence-rule dumper (every plist key, so a
# reminder time key hiding in the blob would surface) + reminderTime helpers.
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
lab_ssh "$IP" 'cat > /tmp/rfull.py' <<'EOF'
import sys, sqlite3, glob, plistlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
row=c.execute("SELECT rt1_recurrenceRule, reminderTime, startDate, deadline FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row: print("NO-ROW"); sys.exit(0)
rt=row[0]
if rt is None:
    print("NO-RULE reminderTime=%s startDate=%s deadline=%s"%(row[1],row[2],row[3])); sys.exit(0)
d=plistlib.loads(rt)
# dump ALL keys of the decoded rule, so any time/reminder key is visible
allkeys=", ".join("%s=%r"%(k,d[k]) for k in sorted(d.keys()))
print("RULEKEYS{ %s } reminderTime=%s startDate=%s deadline=%s"%(allkeys,row[1],row[2],row[3]))
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
rfull() { lab_ssh "$IP" "python3 /tmp/rfull.py $1" </dev/null; }

# ---------- AXVM1 grant (rung b) ----------
note "############### grant Accessibility (AXVM1 rung b) ###############"
lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\'' >/dev/null 2>&1' </dev/null
if [ -z "$VNCDO" ] || [ -z "$VNC_URL" ]; then note "VNCDO/VNC_URL missing — grant needs VNC. Abort."; exit 1; fi
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
V() { sleep 2; timeout 40 "$VNCDO" -s "$SERVER" -p "$PASS" "$@" 2>>"$OUT/vnc.log"; }
lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 12
V move 1642 332 click 1                                  # the lone sshd-keygen-wrapper toggle
V move 1018 869 click 1 pause 0.6 type admin pause 0.6 move 1018 963 click 1  # auth sheet
sleep 3
note "grant: $(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)"
lab_ssh "$IP" 'osascript -e '\''tell application "System Settings" to quit'\'' 2>/dev/null' </dev/null

# ---------- ship the guest e2e bundle + enable ui config ----------
note "############### build + ship bundle + enable ui.enabled ###############"
npm run build >/dev/null
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
Gx() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*; echo EXIT=\$?" </dev/null; }
G config set ui-enabled true >/dev/null 2>&1
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }

uid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL LIMIT 1"; }
tmpl() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1"; }
inst() { gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0 LIMIT 1"; }
gone() { [ "$(gq "SELECT count(*) FROM TMTask WHERE uuid='$1' AND trashed=0")" = 0 ] && echo Y || echo N; }

# ================= REM1-a: inheritance seeding =================
note ""
note "############### REM1-a: inheritance seeding ###############"
# Seed WITH a reminder (dated => 09:00 exact, zero-padded => no am/pm heuristic).
lab_ssh "$IP" "open 'things:///add?title=REM1-A&when=2026-07-20@09:00'; sleep 1" </dev/null
# Control: seed WITHOUT a reminder but same date (isolates inheritance vs a default).
lab_ssh "$IP" "open 'things:///add?title=REM1-A0&when=2026-07-20'; sleep 1" </dev/null
UA=$(uid REM1-A); UA0=$(uid REM1-A0)
note "  seed REM1-A  ($UA): $(rfull "$UA")   [expect reminderTime=$REM_09_00]"
note "  seed REM1-A0 ($UA0): $(rfull "$UA0")  [control: no reminder]"

warm
G todo make-repeating "$UA" --frequency daily --interval 1 --dangerously-drive-gui --json 2>/dev/null | tr ',' '\n' | grep -m1 '"ok"' | sed 's/^/  [REM1-A drive] /' | tee -a "$REPORT"
TA=$(tmpl REM1-A); IA=$(inst "$TA")
note "  REM1-A origGone=$(gone "$UA")"
note "  REM1-A template ($TA): $(rfull "$TA")"
note "  REM1-A instance ($IA): $(rfull "$IA")"
note "  REM1-A all same-title rows: $(gq "SELECT uuid||' rule='||(rt1_recurrenceRule IS NOT NULL)||' rem='||coalesce(reminderTime,'NULL') FROM TMTask WHERE title='REM1-A' AND trashed=0")"

warm
G todo make-repeating "$UA0" --frequency daily --interval 1 --dangerously-drive-gui --json 2>/dev/null | tr ',' '\n' | grep -m1 '"ok"' | sed 's/^/  [REM1-A0 drive] /' | tee -a "$REPORT"
TA0=$(tmpl REM1-A0); IA0=$(inst "$TA0")
note "  REM1-A0 template ($TA0): $(rfull "$TA0")"
note "  REM1-A0 instance ($IA0): $(rfull "$IA0")   [control expect: no reminder]"

REMA_T=$(gq "SELECT coalesce(reminderTime,'NULL') FROM TMTask WHERE uuid='$TA'")
REMA_I=$(gq "SELECT coalesce(reminderTime,'NULL') FROM TMTask WHERE uuid='$IA'")
note "  >>> REM1-a VERDICT: template.reminderTime=$REMA_T instance.reminderTime=$REMA_I (09:00==$REM_09_00)"

# ================= REM1-b: HID sub-field entry =================
note ""
note "############### REM1-b: HID sub-field entry into the reminder AXDateTimeArea ###############"
lab_ssh "$IP" "open 'things:///add?title=REM1-B'; sleep 1" </dev/null
UB=$(uid REM1-B)
note "  seed REM1-B ($UB): $(rfull "$UB")"

# Ship the b-driver into the guest: resolve the reminder AXDateTimeArea frame, HID-click
# the HOUR segment (left ~12% of the frame), type digits (tab between HH and MM), read back.
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
function mev(t,x,y,cs){ var e=$.CGEventCreateMouseEvent($(),t,$.CGPointMake(x,y),0); if(cs)$.CGEventSetIntegerValueField(e,1,cs); return e; }
function click(x,y){ $.CGEventPost($.kCGHIDEventTap,mev(5,x,y,0)); sleep(20);
  $.CGEventPost($.kCGHIDEventTap,mev(1,x,y,1)); sleep(15); $.CGEventPost($.kCGHIDEventTap,mev(2,x,y,1)); sleep(120); }
function key(code){ var d=$.CGEventCreateKeyboardEvent($(),code,true), u=$.CGEventCreateKeyboardEvent($(),code,false);
  $.CGEventPost($.kCGHIDEventTap,d); sleep(30); $.CGEventPost($.kCGHIDEventTap,u); sleep(60); }
var DIG={ '0':29,'1':18,'2':19,'3':20,'4':21,'5':23,'6':22,'7':26,'8':28,'9':25 };
function typeDigits(s){ for(var i=0;i<s.length;i++) key(DIG[s[i]]); }
var TAB=48;
function run(argv){
  var apps=$.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.culturedcode.ThingsMac');
  if(!apps||apps.count===0){ console.log('ERR no things'); return; }
  var pid=apps.objectAtIndex(0).processIdentifier;
  var app=$.AXUIElementCreateApplication(pid);
  var dt=null;
  for(var t=0;t<30&&!dt;t++){ dt=find(app,'AXDateTimeArea',18); if(!dt) sleep(150); }
  if(!dt){ console.log('ERR no AXDateTimeArea'); return; }
  var f=frame(dt);
  console.log('FRAME '+JSON.stringify(f));
  if(!f){ console.log('ERR no frame'); return; }
  // Click the HOUR segment: left of the resolved frame (segments left->right: h : m : am/pm).
  var hx=f.x+f.w*0.12, cy=f.y+f.h/2;
  click(hx,cy); sleep(150);
  var parts=(argv||'09 00').split(' ');
  typeDigits(parts[0]); sleep(120);
  key(TAB); sleep(120);
  typeDigits(parts[1]); sleep(150);
  var cur=attr(dt,'AXValue');
  var desc = cur? ObjC.castRefToObject($.CFCopyDescription(cur)).js : 'nil';
  console.log('READBACK '+desc);
  console.log('OK');
}
run($.NSProcessInfo.processInfo.arguments.count>4 ? ObjC.unwrap($.NSProcessInfo.processInfo.arguments.objectAtIndex(4)) : '09 00');
EOF

# Drive: reveal + activate + open Repeat… + wait + pick daily + tick Add reminders.
warm
lab_ssh "$IP" "open 'things:///show?id=$UB'; sleep 2; osascript -e 'tell application \"Things3\" to activate'; sleep 1" </dev/null
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
AS' </dev/null | sed 's/^/  [REM1-B setup] /' | tee -a "$REPORT"
# HID-type into the reminder picker's hour segment (repeat up to 3× if it commits 09:00).
BOUT=$(lab_ssh "$IP" 'osascript -l JavaScript /tmp/remb.js "09 00" 2>&1' </dev/null || true)
note "  [REM1-B hid] $BOUT"
# Commit: press OK.
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to click button "OK" of sheet 1 of (first window whose subrole is "AXStandardWindow")'\''; sleep 2' </dev/null 2>/dev/null || true
TB=$(tmpl REM1-B); IB=$(inst "$TB")
note "  REM1-B origGone=$(gone "$UB")  template ($TB): $(rfull "$TB")"
note "  REM1-B instance ($IB): $(rfull "$IB")"
REMB=$(gq "SELECT coalesce(reminderTime,'NULL') FROM TMTask WHERE uuid='$IB'")
note "  >>> REM1-b VERDICT: instance.reminderTime=$REMB (09:00==$REM_09_00; DEFAULT wall-clock 12:xx would be a different int)"

# ================= REM1-c: template resists quiet reminder edits =================
note ""
note "############### REM1-c: repeating template resists quiet edits ###############"
# Safe keyword when= => documented silent no-op (§8k). We do NOT fire when=@time
# (the §1/§7-C1 crash) — the timed path is the ONLY URL reminder spelling and it
# crashes on a repeating template, which is itself the closure of the quiet path.
if [ -n "$TA" ]; then
  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  BEFORE=$(gq "SELECT start||'/'||coalesce(startDate,'NULL')||'/'||coalesce(reminderTime,'NULL') FROM TMTask WHERE uuid='$TA'")
  lab_ssh "$IP" "open 'things:///update?id=$TA&when=someday&auth-token=$TOKEN'; sleep 2" </dev/null
  AFTER=$(gq "SELECT start||'/'||coalesce(startDate,'NULL')||'/'||coalesce(reminderTime,'NULL') FROM TMTask WHERE uuid='$TA'")
  note "  template quiet 'when=someday' (keyword): before=$BEFORE after=$AFTER  [expect unchanged => silent no-op]"
  note "  (timed 'when=<date>@time' on a repeating template is the §1 crash — NOT re-fired; the quiet reminder path is closed either way)"
fi

note ""
note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 --"
note "DONE. report: $REPORT"
