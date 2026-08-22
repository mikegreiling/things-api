#!/bin/bash
# RDLG2a — the census the 3.23 RECIPE REWRITE needs: every open cell RDLG1 left.
#
#   1. the new `Next:` pop-up — full item list, and what `More…` opens (the
#      single blocker for every off-rule first-occurrence law);
#   2. the WEEKDAY machinery under the new dialog (rows, add/remove buttons,
#      renumbering) — the multi-weekday + RRD1 blind-"+" question;
#   3. `Ends = after` / `Ends = on date` — does the count field collide with
#      the interval field, is the ends bound still an AXDateTimeArea;
#   4. `Add reminders` / `Add deadlines` reveals under the new layout;
#   5. the occurrence-preview static text as a read-back oracle;
#   6. `Edit Rule…` — the pre-populated dialog's shape vs the create-time one;
#   7. a PRE-POPULATED multi-weekday rule (the RRD1 trap cell).
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (Things 3.23, DB v27;
# the golden is never booted). Airgap, clock pinned 2026-07-05, AX grant baked.
# Fixtures fully synthetic (RDLG2-*). Teardown on EXIT (KEEP=1 to leave it up).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-rdlg2a-lab}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[rdlg2a] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"

FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB"
[ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free"; exit 1; }

GOLDEN="${GOLDEN:-things-lab-golden-v4}"
note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: no SSH"; exit 1; }
note "ssh up at $IP"
cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — leaving $VM running at $IP"; return; fi
  note "teardown: stop+delete $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
[ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"

lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# sheet-only AX dumper (same shape as RDLG1b)
lab_ssh "$IP" 'cat > ~/labh/sheet.jxa' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices')
function pidOf(n){return Application('System Events').processes.byName(n).unixId()}
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function sv(el,n){var v=attr(el,n);try{return v?String(v.js):''}catch(e){return ''}}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
function frame(el){var p=attr(el,'AXPosition'),z=attr(el,'AXSize');function d(x){if(!x)return null;return ObjC.castRefToObject($.CFCopyDescription(x)).js}
  var pp=d(p),zz=d(z);var mp=pp&&pp.match(/x:([-0-9.]+) y:([-0-9.]+)/);var mz=zz&&zz.match(/w:([-0-9.]+) h:([-0-9.]+)/)
  return {x:mp?+mp[1]:null,y:mp?+mp[2]:null,w:mz?+mz[1]:null,h:mz?+mz[2]:null}}
function line(el,d,ix){
  var p=['['+ix+'] role='+sv(el,'AXRole')]
  var s=sv(el,'AXSubrole'); if(s)p.push('sub='+s)
  var t=sv(el,'AXTitle'); if(t)p.push('ttl='+t)
  var de=sv(el,'AXDescription'); if(de)p.push('desc='+de)
  var v=sv(el,'AXValue'); if(v)p.push('val='+String(v).slice(0,90))
  var id=sv(el,'AXIdentifier'); if(id)p.push('id='+id)
  var en=sv(el,'AXEnabled'); if(en==='false')p.push('DISABLED')
  var f=frame(el); if(f.x!==null)p.push('@['+f.x+','+f.y+' '+f.w+'x'+f.h+']')
  return Array(d+1).join('  ')+p.join(' | ')}
function walk(el,d,acc,ix){acc.push(line(el,d,ix)); if(d>14)return acc; var ch=kids(el); for(var i=0;i<ch.length;i++)walk(ch[i],d+1,acc,i+1); return acc}
function run(){
  var app=$.AXUIElementCreateApplication(pidOf('Things3')); var ws=kids(app); var acc=[]
  for(var i=0;i<ws.length;i++){
    var w=ws[i], f=frame(w)
    var sub=sv(w,'AXSubrole')
    if(sub==='AXUnknown' && !(f.w===40&&f.h===40)){acc.push('=== DETACHED WINDOW '+(i+1)+' sub='+sub+' id='+sv(w,'AXIdentifier')+' @['+f.x+','+f.y+' '+f.w+'x'+f.h+'] ==='); walk(w,0,acc,i+1)}
    var ch=kids(w)
    for(var j=0;j<ch.length;j++){
      var r=sv(ch[j],'AXRole')
      if(r==='AXSheet'||r==='AXPopover'){acc.push('=== '+r+' (child '+(j+1)+' of window '+(i+1)+' "'+sv(w,'AXTitle')+'") ==='); walk(ch[j],0,acc,j+1)}
    }
  }
  if(!acc.length) acc.push('(no sheet / popover / detached dialog present)')
  return acc.join('\n')}
EOF
sheetdump() { lab_ssh "$IP" 'osascript -l JavaScript ~/labh/sheet.jxa' </dev/null > "$OUT/ax/$1.txt" 2>&1; note "  [dump $1: $(wc -l <"$OUT/ax/$1.txt"|tr -d ' ') lines]"; }
showdump() { sed 's/^/      /' "$OUT/ax/$1.txt" | tee -a "$REPORT" >/dev/null; }

axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
esc() { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }

select_item() {
  local uuid="$1" want="$2" i sel
  for i in 1 2 3 4 5; do
    lab_ssh "$IP" "open -g 'things:///show?id=$uuid'; sleep 3" </dev/null
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
    sel=$(axq 'tell application "Things3" to get name of selected to dos' 2>/dev/null)
    if [ "$sel" = "$want" ]; then note "  selection OK on attempt $i: '$sel'"; return 0; fi
    note "  selection attempt $i -> '$sel' (want '$want')"
  done
  return 1
}

SHELL_PATH='sheet 1 of (first window whose subrole is "AXStandardWindow")'

# Compact per-state inventory of the cadence group + sheet level.
groupstate() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set sh to $SHELL_PATH
  set g to group 1 of sh
  set out to \"  group: popups=\" & (count of pop up buttons of g) & \" fields=\" & (count of text fields of g) & \" buttons=\" & (count of buttons of g) & \" checkboxes=\" & (count of checkboxes of g) & \" statictexts=\" & (count of static texts of g)
  repeat with i from 1 to (count of pop up buttons of g)
    set out to out & linefeed & \"    popup \" & i & \" = \" & (value of pop up button i of g)
  end repeat
  repeat with i from 1 to (count of text fields of g)
    set out to out & linefeed & \"    field \" & i & \" = \" & (value of text field i of g)
  end repeat
  repeat with i from 1 to (count of buttons of g)
    set d to \"(none)\"
    try
      set d to (description of button i of g) as text
    end try
    set out to out & linefeed & \"    button \" & i & \" desc=\" & d & \" pos=\" & ((position of button i of g) as text)
  end repeat
  repeat with i from 1 to (count of static texts of g)
    set sVal to \"(none)\"
    try
      set sVal to (value of static text i of g) as text
    end try
    set out to out & linefeed & \"    static \" & i & \" = \" & sVal
  end repeat
  set out to out & linefeed & \"  sheet: popups=\" & (count of pop up buttons of sh) & \" fields=\" & (count of text fields of sh) & \" checkboxes=\" & (count of checkboxes of sh) & \" buttons=\" & (count of buttons of sh) & \" groups=\" & (count of groups of sh)
  repeat with i from 1 to (count of text fields of sh)
    set out to out & linefeed & \"    sheet field \" & i & \" = \" & (value of text field i of sh)
  end repeat
  return out
end tell" | tee -a "$REPORT"
}

# Every AXDateTimeArea anywhere in the sheet, with y + value (the set-datetime oracle).
dateareas() {
  lab_ssh "$IP" 'cat > ~/labh/dta.jxa' </dev/null <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices')
function pidOf(n){return Application('System Events').processes.byName(n).unixId()}
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function role(el){var v=attr(el,'AXRole');return v?String(v.js):''}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
function collect(el,r,d,out){if(d<0)return;if(role(el)===r)out.push(el);var k=kids(el);for(var i=0;i<k.length;i++)collect(k[i],r,d-1,out)}
function posY(el){var p=attr(el,'AXPosition');if(!p)return 0;var d=ObjC.castRefToObject($.CFCopyDescription(p)).js;var m=String(d).match(/y:([-0-9.]+)/);return m?+m[1]:0}
function run(){
  var app=$.AXUIElementCreateApplication(pidOf('Things3'));var ws=kids(app);var areas=[]
  for(var i=0;i<ws.length;i++)collect(ws[i],'AXDateTimeArea',16,areas)
  if(!areas.length)return '  date areas: (none)'
  var cal=$.NSCalendar.currentCalendar,out=[]
  for(var i=0;i<areas.length;i++){
    var v=attr(areas[i],'AXValue')
    var s=v? (cal.componentFromDate($.NSCalendarUnitYear,v)+'-'+cal.componentFromDate($.NSCalendarUnitMonth,v)+'-'+cal.componentFromDate($.NSCalendarUnitDay,v)+' '+cal.componentFromDate($.NSCalendarUnitHour,v)+':'+cal.componentFromDate($.NSCalendarUnitMinute,v)) : '(no value)'
    out.push('  date area #'+i+' y='+Math.round(posY(areas[i]))+' value='+s)
  }
  return out.join('\n')}
EOF
  lab_ssh "$IP" 'osascript -l JavaScript ~/labh/dta.jxa' </dev/null 2>&1 | tee -a "$REPORT"
}

# The full item list of a group pop-up, by index.
popupitems() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set pb to pop up button $1 of group 1 of $SHELL_PATH
  repeat 20 times
    if (exists menu 1 of pb) then exit repeat
    click pb
    delay 0.3
  end repeat
  set nms to name of every menu item of menu 1 of pb
  key code 53
  delay 0.5
  return nms as text
end tell"
}

setfreq() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set p to pop up button 1 of $SHELL_PATH
  repeat 20 times
    if (exists menu 1 of p) then exit repeat
    click p
    delay 0.3
  end repeat
  click menu item \"$1\" of menu 1 of p
  delay 1.2
  return value of p
end tell"
}

setgrouppopup() {
  axq "tell application \"System Events\" to tell process \"Things3\"
  set pb to pop up button $1 of group 1 of $SHELL_PATH
  repeat 20 times
    if (exists menu 1 of pb) then exit repeat
    click pb
    delay 0.3
  end repeat
  if (exists menu item \"$2\" of menu 1 of pb) then
    click menu item \"$2\" of menu 1 of pb
    delay 1.2
    return \"selected: \" & (value of pb)
  end if
  key code 53
  return \"NO-SUCH-ITEM \\\"$2\\\" in popup $1; items = \" & ((name of every menu item of menu 1 of pb) as text)
end tell"
}

openrepeat() {
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  lab_ssh "$IP" 'sleep 3' </dev/null
}

TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
DBV=$(gq "SELECT value FROM Meta WHERE key='databaseVersion'" 2>/dev/null || gq "SELECT databaseVersion FROM Meta")
note "env: Things $TVER ($TBLD) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / dbv=$DBV / golden $GOLDEN"

warm

mktodo() {
  lab_ssh "$IP" "open -g 'things:///add?title=$1&auth-token=$TOKEN'; sleep 4" </dev/null
  gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 LIMIT 1"
}

# =====================================================================
note ""; note "###### CELL 1: the Next: pop-up + More… ######"
U1=$(mktodo RDLG2-NEXT)
note "  fresh to-do uuid=$U1"
select_item "$U1" "RDLG2-NEXT" || note "  WARN: selection never confirmed"
openrepeat
sheetdump "01-dialog-default"
note "  default mode state:"; groupstate

note "  --- frequency = weekly ---"
setfreq weekly | sed 's/^/    /' | tee -a "$REPORT"
groupstate
note "  Next: pop-up (group popup 2) full item list:"
popupitems 2 | tr ',' '\n' | sed 's/^ */    - /' | tee -a "$REPORT" > "$OUT/ax/next-items-weekly.txt"
note "  date areas BEFORE More…:"; dateareas

note "  --- clicking the LAST item of the Next: pop-up (More…) ---"
axq "tell application \"System Events\" to tell process \"Things3\"
  set pb to pop up button 2 of group 1 of $SHELL_PATH
  repeat 20 times
    if (exists menu 1 of pb) then exit repeat
    click pb
    delay 0.3
  end repeat
  set mi to last menu item of menu 1 of pb
  set nm to name of mi
  click mi
  delay 2
  return \"clicked last item: \" & nm
end tell" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 2' </dev/null
sheetdump "02-after-more"
note "  state AFTER More…:"; groupstate
note "  date areas AFTER More…:"; dateareas
note "  --- full sheet dump after More… ---"; showdump "02-after-more"
grep -iE "DateTimeArea|Calendar|AXTextField|DETACHED|Popover" "$OUT/ax/02-after-more.txt" | sed 's/^/    /' | tee -a "$REPORT"

# If a date area appeared, try to write an ARBITRARY (off-rule) date into it.
note "  --- attempt: write 2026-08-19 (a Wednesday — OFF-RULE for a Sunday weekly) into the revealed control ---"
lab_ssh "$IP" 'cat > ~/labh/setdt.jxa' </dev/null <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices')
function pidOf(n){return Application('System Events').processes.byName(n).unixId()}
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function role(el){var v=attr(el,'AXRole');return v?String(v.js):''}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
function collect(el,r,d,out){if(d<0)return;if(role(el)===r)out.push(el);var k=kids(el);for(var i=0;i<k.length;i++)collect(k[i],r,d-1,out)}
function posY(el){var p=attr(el,'AXPosition');if(!p)return 0;var d=ObjC.castRefToObject($.CFCopyDescription(p)).js;var m=String(d).match(/y:([-0-9.]+)/);return m?+m[1]:0}
function run(argv){
  var ymd=argv[0].split('-')
  var app=$.AXUIElementCreateApplication(pidOf('Things3'));var ws=kids(app);var areas=[]
  for(var i=0;i<ws.length;i++)collect(ws[i],'AXDateTimeArea',16,areas)
  if(!areas.length)return 'NO-DATE-AREA'
  areas.sort(function(a,b){return posY(a)-posY(b)})
  var cal=$.NSCalendar.currentCalendar
  var c=$.NSDateComponents.alloc.init;c.year=+ymd[0];c.month=+ymd[1];c.day=+ymd[2];c.hour=0;c.minute=0;c.second=0
  var d=cal.dateFromComponents(c)
  var err=$.AXUIElementSetAttributeValue(areas[0],$('AXValue'),d)
  $.NSThread.sleepForTimeInterval(0.4)
  var v=attr(areas[0],'AXValue')
  var got=v? (cal.componentFromDate($.NSCalendarUnitYear,v)+'-'+cal.componentFromDate($.NSCalendarUnitMonth,v)+'-'+cal.componentFromDate($.NSCalendarUnitDay,v)):'(none)'
  return 'setAttr err='+err+' readback='+got}
EOF
lab_ssh "$IP" 'osascript -l JavaScript ~/labh/setdt.jxa 2026-08-19' </dev/null 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
sheetdump "03-after-datewrite"
note "  occurrence preview after the date write:"
axq "tell application \"System Events\" to tell process \"Things3\" to return value of static text 1 of group 1 of $SHELL_PATH" | sed 's/^/    /' | tee -a "$REPORT"
note "  state after the date write:"; groupstate

# Commit and read the DB truth for the off-rule first occurrence.
note "  --- pressing OK and reading the DB ---"
axq "tell application \"System Events\" to tell process \"Things3\" to click button \"OK\" of $SHELL_PATH" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 5' </dev/null
note "  DB after OK (template + instances):"
lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid, title, type, status, trashed, startDate, rt1_recurrenceRule IS NOT NULL AS isTmpl, rt1_instanceCreationStartDate AS cursor, rt1_nextInstanceStartDate AS nextcache FROM TMTask WHERE title='RDLG2-NEXT'\"" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
note "  rule blob (hex) of the template:"
gq "SELECT hex(rt1_recurrenceRule) FROM TMTask WHERE title='RDLG2-NEXT' AND rt1_recurrenceRule IS NOT NULL" | sed 's/^/    /' | tee -a "$REPORT"
esc; esc

# =====================================================================
note ""; note "###### CELL 2: the WEEKDAY machinery (add / remove / renumber) ######"
warm
U2=$(mktodo RDLG2-WD)
note "  fresh to-do uuid=$U2"
select_item "$U2" "RDLG2-WD" || note "  WARN: selection never confirmed"
openrepeat
setfreq weekly | sed 's/^/    /' | tee -a "$REPORT"
note "  weekly, 1 weekday row:"; groupstate
sheetdump "10-weekly-1row"
note "  weekday popup (3) item list:"
popupitems 3 | tr ',' '\n' | sed 's/^ */    - /' | tee -a "$REPORT" >/dev/null
note "  set weekday row 1 = Monday:"; setgrouppopup 3 "Monday" | sed 's/^/    /' | tee -a "$REPORT"

note "  --- press group button 1 (the '+') ---"
axq "tell application \"System Events\" to tell process \"Things3\"
  set g to group 1 of $SHELL_PATH
  set b to button 1 of g
  set d to description of b
  click b
  delay 1.5
  return \"clicked button 1 (desc=\" & d & \")\"
end tell" | sed 's/^/    /' | tee -a "$REPORT"
note "  weekly, after 1st '+':"; groupstate
sheetdump "11-weekly-2rows"

note "  --- which popup holds which weekday? (setting popup 4 = Thursday) ---"
setgrouppopup 4 "Thursday" | sed 's/^/    /' | tee -a "$REPORT"
note "  after setting popup 4:"; groupstate

note "  --- press '+' again (button 1) ---"
axq "tell application \"System Events\" to tell process \"Things3\"
  set g to group 1 of $SHELL_PATH
  click button 1 of g
  delay 1.5
end tell" >/dev/null
note "  weekly, after 2nd '+':"; groupstate
sheetdump "12-weekly-3rows"
note "  ALL group buttons with descriptions + frames (the add/remove pair question):"
axq "tell application \"System Events\" to tell process \"Things3\"
  set g to group 1 of $SHELL_PATH
  set out to \"\"
  repeat with i from 1 to (count of buttons of g)
    set b to button i of g
    set d to \"(none)\"
    set t to \"(none)\"
    try
      set d to (description of b) as text
    end try
    try
      set t to (name of b) as text
    end try
    set out to out & \"  button \" & i & \" desc='\" & d & \"' ttl='\" & t & \"' pos=\" & ((position of b) as text) & \" size=\" & ((size of b) as text) & \" actions=\" & ((name of every action of b) as text) & linefeed
  end repeat
  return out
end tell" | tee -a "$REPORT"
note "  occurrence preview (should show the multi-weekday series):"
axq "tell application \"System Events\" to tell process \"Things3\" to return value of static text 1 of group 1 of $SHELL_PATH" | sed 's/^/    /' | tee -a "$REPORT"

note "  --- press the LAST group button (candidate 'remove' for the last row) ---"
axq "tell application \"System Events\" to tell process \"Things3\"
  set g to group 1 of $SHELL_PATH
  set n to (count of buttons of g)
  set b to button n of g
  click b
  delay 1.5
  return \"clicked button \" & n
end tell" | sed 's/^/    /' | tee -a "$REPORT"
note "  after pressing the last button:"; groupstate
sheetdump "13-weekly-after-lastbutton"
esc; esc

# =====================================================================
note ""; note "###### CELL 3: Ends = after / on date ######"
warm
U3=$(mktodo RDLG2-ENDS)
select_item "$U3" "RDLG2-ENDS" || note "  WARN: selection never confirmed"
openrepeat
setfreq daily | sed 's/^/    /' | tee -a "$REPORT"
note "  daily baseline:"; groupstate
note "  Ends pop-up (group popup 1) items:"
popupitems 1 | tr ',' '\n' | sed 's/^ */    - /' | tee -a "$REPORT"
note "  --- Ends = after ---"; setgrouppopup 1 "after" | sed 's/^/    /' | tee -a "$REPORT"
note "  state with Ends=after (WATCH the text-field count — interval/count collision):"; groupstate
sheetdump "20-ends-after"
note "  --- Ends = on date ---"; setgrouppopup 1 "on date" | sed 's/^/    /' | tee -a "$REPORT"
note "  state with Ends=on date:"; groupstate
note "  date areas with Ends=on date (is the ends bound still an AXDateTimeArea?):"; dateareas
sheetdump "21-ends-ondate"
esc; esc

# =====================================================================
note ""; note "###### CELL 4: Add reminders / Add deadlines reveals ######"
warm
U4=$(mktodo RDLG2-RD)
select_item "$U4" "RDLG2-RD" || note "  WARN: selection never confirmed"
openrepeat
setfreq daily >/dev/null
note "  baseline daily:"; groupstate
note "  --- check 'Add deadlines' ---"
axq "tell application \"System Events\" to tell process \"Things3\"
  set sh to $SHELL_PATH
  set cb to checkbox \"Add deadlines\" of sh
  if (value of cb as integer) is 0 then click cb
  delay 1.5
  return \"Add deadlines = \" & (value of cb)
end tell" | sed 's/^/    /' | tee -a "$REPORT"
note "  state with deadlines on (start-N-days-earlier field?):"; groupstate
sheetdump "30-deadlines-on"
note "  --- check 'Add reminders' ---"
axq "tell application \"System Events\" to tell process \"Things3\"
  set sh to $SHELL_PATH
  set cb to checkbox \"Add reminders\" of sh
  if (value of cb as integer) is 0 then click cb
  delay 1.5
  return \"Add reminders = \" & (value of cb)
end tell" | sed 's/^/    /' | tee -a "$REPORT"
note "  state with reminders on:"; groupstate
note "  date areas with reminders on:"; dateareas
sheetdump "31-reminders-on"
esc; esc

# =====================================================================
note ""; note "###### CELL 5: Edit Rule… on a seeded template (pre-populated shape) ######"
warm
TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
note "  template uuid=$TMPL"
if [ -n "$TMPL" ]; then
  select_item "$TMPL" "LAB-REPEAT-DAILY" || note "  WARN: template selection never confirmed"
  note "  Items ▸ Repeat submenu items:"
  axq 'tell application "System Events" to tell process "Things3" to return (name of every menu item of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1) as text' | sed 's/^/    /' | tee -a "$REPORT"
  note "  --- click Edit Rule… ---"
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Edit Rule…" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 4' </dev/null
  sheetdump "40-editrule"
  note "  pre-populated dialog state:"; groupstate
  note "  frequency pop-up value + sheet shape:"
  axq "tell application \"System Events\" to tell process \"Things3\"
    set sh to $SHELL_PATH
    return \"frequency=\" & (value of pop up button 1 of sh) & \" | title=\" & (name of sh) & \" | buttons=\" & ((name of every button of sh) as text)
  end tell" | sed 's/^/    /' | tee -a "$REPORT"
  note "  date areas in the Edit Rule dialog:"; dateareas
  note "  --- full Edit Rule dump ---"; showdump "40-editrule"
  esc; esc
fi

# =====================================================================
note ""; note "###### CELL 6: RRD1 — a PRE-POPULATED MULTI-WEEKDAY rule under Edit Rule… ######"
warm
U6=$(mktodo RDLG2-MW)
select_item "$U6" "RDLG2-MW" || note "  WARN: selection never confirmed"
openrepeat
setfreq weekly >/dev/null
note "  building {Monday, Wednesday} by hand:"
setgrouppopup 3 "Monday" | sed 's/^/    /' | tee -a "$REPORT"
axq "tell application \"System Events\" to tell process \"Things3\"
  click button 1 of group 1 of $SHELL_PATH
  delay 1.5
end tell" >/dev/null
setgrouppopup 4 "Wednesday" | sed 's/^/    /' | tee -a "$REPORT"
groupstate
axq "tell application \"System Events\" to tell process \"Things3\" to click button \"OK\" of $SHELL_PATH" >/dev/null
lab_ssh "$IP" 'sleep 5' </dev/null
note "  DB after OK:"
lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid, title, startDate, rt1_recurrenceRule IS NOT NULL AS isTmpl FROM TMTask WHERE title='RDLG2-MW'\"" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
MWT=$(gq "SELECT uuid FROM TMTask WHERE title='RDLG2-MW' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
note "  rule hex: $(gq "SELECT hex(rt1_recurrenceRule) FROM TMTask WHERE uuid='$MWT'")"

note "  --- reopen via Edit Rule… and census the PRE-POPULATED weekday rows ---"
warm
select_item "$MWT" "RDLG2-MW" || note "  WARN: template selection never confirmed"
axq 'tell application "System Events" to tell process "Things3" to click menu item "Edit Rule…" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 4' </dev/null
note "  pre-populated multi-weekday state (THE RRD1 CELL):"; groupstate
sheetdump "50-prepop-multiweekday"
showdump "50-prepop-multiweekday"
note "  --- can a row be REMOVED? press the last group button ---"
axq "tell application \"System Events\" to tell process \"Things3\"
  set g to group 1 of $SHELL_PATH
  set n to (count of buttons of g)
  click button n of g
  delay 1.5
  return \"clicked button \" & n & \" of \" & n
end tell" | sed 's/^/    /' | tee -a "$REPORT"
note "  after the remove attempt:"; groupstate
esc; esc

# =====================================================================
note ""; note "###### CELL 7: the SHAPE PROBE (what distinguishes 3.23 from <=3.22) ######"
warm
U7=$(mktodo RDLG2-PROBE)
select_item "$U7" "RDLG2-PROBE" || note "  WARN: selection never confirmed"
openrepeat
for mode in daily weekly monthly yearly "after completion"; do
  setfreq "$mode" >/dev/null
  note "  --- mode=$mode ---"
  axq "tell application \"System Events\" to tell process \"Things3\"
    set g to group 1 of $SHELL_PATH
    set hasNext to false
    repeat with st in static texts of g
      try
        if ((value of st) as text) is \"Next:\" then set hasNext to true
      end try
    end repeat
    set p2 to \"(none)\"
    try
      set p2 to (value of pop up button 2 of g) as text
    end try
    return \"  Next: static present=\" & hasNext & \" | group popups=\" & (count of pop up buttons of g) & \" | popup2=\" & p2
  end tell" | tee -a "$REPORT"
done
esc; esc

note ""; note "RDLG2a census complete — artifacts in $OUT"
