#!/bin/bash
# HXPC1 — the Move… project picker's blind Return, and the repeat dialog's two
# numeric fields — measured, then CERTIFIED against a golden-v4 clone
# (Things 3.23 / build 32300036 / dbv 27).
#
# Two independent surfaces, one clone:
#
#   (a) DIALOG NUMERIC FIELDS. `DIALOG_INTERVAL` and `DIALOG_ENDS_COUNT`
#       (src/write/vectors/ui-recipes.ts) both resolved to
#       `text field 1 of group 1`. Dump the Repeat dialog's cadence group with
#       BOTH numeric fields visible (an "Ends: after N" bound alongside the
#       interval), find the real distinguishing address for each, and prove the
#       two paths hit DIFFERENT controls by writing different values and reading
#       both back.
#
#   (b) MOVE… PICKER. The `project move-heading-to-project` recipe typed the
#       destination title into the picker's filter field and pressed Return
#       BLIND. The picker also offers a `New Project "<typed>"` row, so an
#       exact-prefix collision could CREATE a stray project. Dump the picker's
#       AX tree (rows + whatever marks the highlight), then certify the shipped
#       CLI end to end: a clean match must land, and a prefix collision must
#       either land exactly right or fail closed with ZERO mutations.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, clock pinned 2026-07-05 and NEVER rolled (the trial wall
# is 2026-07-18 — docs/lab/harness.md). Fixtures fully synthetic. The clone is
# destroyed on teardown.
#
# Phases (the clone survives between them; SESSION carries the IP):
#   setup     clone + boot + airgap + clock pin + seed + ship the CLI
#   census    the AX dumps of the dialog and of the Move… picker
#   dialog-census  the cadence group in all four numeric-field modes (§A)
#   prefix-hazard  the PRE-FIX blind Return, both arms (§B3/§B4)
#   cert      cells (b)/(c)/(d) against the shipped CLI
#   cert-a    cell (a): the shipped dialog script text, driven live
#   teardown  stop + delete the clone
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-hxpc1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — a Sunday, well inside the trial wall
note() { echo "[hxpc1] $*" | tee -a "$REPORT"; }

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
esc() { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }
show() { lab_ssh "$IP" "open -g $(printf '%q' "$1"); sleep 3" </dev/null; }

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
  note "preflight: free ${FREEGB}GB"
  [ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free"; exit 1; }

  if [ "${SKIP_BUILD:-0}" = "1" ]; then note "SKIP_BUILD=1 — reusing dist/"; else
    note "building dist"
    npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
  fi
  [ -f dist/cli/main.js ] || { note "FATAL: no dist/cli/main.js"; exit 1; }

  note "cloning $GOLDEN -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"

  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  [ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) (trial wall 2026-07-18 — never rolled)"

  lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
  lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<<"$GSQL"

  note "warm-up launch/quit/relaunch"
  lab_ssh "$IP" 'open -g -a Things3; sleep 14; osascript -e "tell application \"Things3\" to quit"; sleep 4; open -g -a Things3; sleep 12' </dev/null

  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  echo "IP=$IP" > "$SESSION"; echo "TOKEN=$TOKEN" >> "$SESSION"
  note "auth token in hand (${#TOKEN} chars)"

  TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
  TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
  note "env: Things $TVER ($TBLD) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / golden $GOLDEN"

  # ---- helpers on the guest ----------------------------------------------
  lab_ssh "$IP" 'cat > ~/labh/tjson.sh && chmod +x ~/labh/tjson.sh' <<'EOF'
#!/bin/bash
URL=$(python3 -c 'import sys,urllib.parse; print("things:///json?auth-token="+sys.argv[1]+"&data="+urllib.parse.quote(sys.argv[2],safe=""))' "$1" "$2")
open -g "$URL"
EOF
  tjson() { lab_ssh "$IP" "~/labh/tjson.sh $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null; sleep 3; }

  # ---- rule summariser (the DB oracle for cell (a)) -----------------------
  lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
WD=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
rows=c.execute("SELECT uuid, rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationStartDate, rt1_instanceCreationCount FROM TMTask WHERE title=? AND rt1_recurrenceRule IS NOT NULL", (sys.argv[1],)).fetchall()
if not rows: print("NO-TEMPLATE"); sys.exit(0)
for row in rows:
    d=plistlib.loads(row[1]); offs=[]
    for o in d.get('of',[]):
        bits=[]
        if 'wd' in o: bits.append("wd=%s(%s)"%(o['wd'], WD[o['wd']] if 0<=o['wd']<7 else "?"))
        for k in ('dy','mo','wdo'):
            if k in o: bits.append("%s=%s"%(k,o[k]))
        offs.append("{"+",".join(bits)+"}")
    print("tp=%s fu=%s fa=%s ts=%s rc=%s of=[%s] next=%s icStart=%s icCount=%s"%(
        d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),",".join(offs),
        dpk(row[2]),dpk(row[3]),row[4]))
EOF

  # ---- AX kit: full-tree dumper + HID click/type/key ----------------------
  lab_ssh "$IP" 'cat > ~/labh/hxax.js' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId() }
function sleepMs(ms){ $.NSThread.sleepForTimeInterval(ms/1000) }
function attr(el,name){ var out=Ref(); if($.AXUIElementCopyAttributeValue(el,$(name),out)!==0) return null; return ObjC.castRefToObject(out[0]) }
function sv(el,name){ var v=attr(el,name); try { return v? (''+v.js) : '' } catch(e){ return '' } }
function kids(el){ var c=attr(el,'AXChildren'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a }
function frame(el){ var p=attr(el,'AXPosition'), z=attr(el,'AXSize'); if(!p||!z) return null;
  var pd=ObjC.castRefToObject($.CFCopyDescription(p)).js, zd=ObjC.castRefToObject($.CFCopyDescription(z)).js;
  var pm=String(pd).match(/x:([-0-9.]+) y:([-0-9.]+)/), zm=String(zd).match(/w:([-0-9.]+) h:([-0-9.]+)/);
  return (pm&&zm)?{x:+pm[1],y:+pm[2],w:+zm[1],h:+zm[2]}:null }
function appEl(){ return $.AXUIElementCreateApplication(pidOf('Things3')) }
var MOVED=5, DOWN=1, UP=2;
function mev(t,x,y){ return $.CGEventCreateMouseEvent($(),t,$.CGPointMake(x,y),0) }
function postHID(ev){ $.CGEventPost($.kCGHIDEventTap, ev) }
function click(x,y){ postHID(mev(MOVED,x,y)); sleepMs(60); postHID(mev(DOWN,x,y)); sleepMs(90); postHID(mev(UP,x,y)); sleepMs(60) }
function key(code){ var d=$.CGEventCreateKeyboardEvent($(),code,true), u=$.CGEventCreateKeyboardEvent($(),code,false); postHID(d); sleepMs(40); postHID(u); sleepMs(40) }
function findByDesc(sub){ var hit=null;
  (function w(e){ if(hit) return; var d=sv(e,'AXDescription'); if(d && d.indexOf(sub)>=0){ hit=e; return; } var ch=kids(e); for(var i=0;i<ch.length;i++) w(ch[i]); })(appEl());
  return hit; }
function line(el,d,ix){
  var p=['['+ix+'] role='+sv(el,'AXRole')];
  var s=sv(el,'AXSubrole'); if(s) p.push('sub='+s);
  var t=sv(el,'AXTitle'); if(t) p.push('ttl='+t);
  var de=sv(el,'AXDescription'); if(de) p.push('desc='+de);
  var v=sv(el,'AXValue'); if(v) p.push('val='+String(v).slice(0,120));
  var id=sv(el,'AXIdentifier'); if(id) p.push('id='+id);
  var sel=attr(el,'AXSelected'); if(sel!==null) p.push('SELECTED='+(''+sel.js));
  var foc=attr(el,'AXFocused'); if(foc!==null) p.push('FOCUSED='+(''+foc.js));
  var hl=attr(el,'AXHighlighted'); if(hl!==null) p.push('HIGHLIGHTED='+(''+hl.js));
  var f=frame(el); if(f) p.push('@['+f.x+','+f.y+' '+f.w+'x'+f.h+']');
  return Array(d+1).join('  ')+p.join(' | ') }
function walk(el,d,acc,ix){ acc.push(line(el,d,ix)); if(d>16) return acc; var ch=kids(el); for(var i=0;i<ch.length;i++) walk(ch[i],d+1,acc,i+1); return acc }
function dumpAll(){
  var app=appEl(); var ws=kids(app); var acc=[];
  for(var i=0;i<ws.length;i++){
    var w=ws[i], f=frame(w), sub=sv(w,'AXSubrole');
    acc.push('=== WINDOW '+(i+1)+' sub='+sub+' ttl='+sv(w,'AXTitle')+' id='+sv(w,'AXIdentifier')+(f?(' @['+f.x+','+f.y+' '+f.w+'x'+f.h+']'):'')+' ===');
    if(sub==='AXStandardWindow'){
      var ch=kids(w);
      for(var j=0;j<ch.length;j++){ var r=sv(ch[j],'AXRole');
        if(r==='AXSheet'||r==='AXPopover'){ acc.push('--- '+r+' of standard window ---'); walk(ch[j],0,acc,j+1) } }
    } else if(!(f && f.w===40 && f.h===40)) {
      walk(w,0,acc,i+1);
    }
  }
  if(!acc.length) acc.push('(nothing)');
  return acc.join('\n') }
function run(argv){
  var cmd=argv[0];
  if(cmd==='dump') return dumpAll();
  if(cmd==='more-frame'){ var el=findByDesc('More. '+argv.slice(1).join(' ')); if(!el) return 'MORE_NOT_FOUND';
    var f=frame(el); if(!f) return 'NO_FRAME'; return JSON.stringify({cx:Math.round(f.x+f.w/2), cy:Math.round(f.y+f.h/2), f:f}); }
  if(cmd==='desc-frame'){ var el2=findByDesc(argv.slice(1).join(' ')); if(!el2) return 'DESC_NOT_FOUND';
    var f2=frame(el2); if(!f2) return 'NO_FRAME'; return JSON.stringify({cx:Math.round(f2.x+f2.w/2), cy:Math.round(f2.y+f2.h/2), f:f2}); }
  if(cmd==='click'){ click(+argv[1],+argv[2]); return 'CLICKED '+argv[1]+','+argv[2]; }
  if(cmd==='key'){ key(+argv[1]); return 'KEY '+argv[1]; }
  if(cmd==='type'){ Application('System Events').keystroke(argv.slice(1).join(' ')); return 'TYPED'; }
  return 'UNKNOWN_CMD' }
EOF

  # ---- ship the production bundle ----------------------------------------
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
  note "shipped dist; ui-enabled=true"

  # ---- SEED (fully synthetic) --------------------------------------------
  note "seed: HXPC1-SRC (heading HXPC1-HEAD + 2 children) -> HXPC1-DEST (clean-match arm)"
  tjson '[{"type":"project","attributes":{"title":"HXPC1-SRC","items":[{"type":"heading","attributes":{"title":"HXPC1-HEAD"}},{"type":"to-do","attributes":{"title":"HXPC1-C1"}},{"type":"to-do","attributes":{"title":"HXPC1-C2"}}]}}]'
  tjson '[{"type":"project","attributes":{"title":"HXPC1-DEST","items":[]}}]'

  note "seed: the PREFIX-COLLISION arm — 'Synthetic Work' is an exact prefix of 'Synthetic Work Stuff'"
  tjson '[{"type":"project","attributes":{"title":"HXPC1-SRC2","items":[{"type":"heading","attributes":{"title":"HXPC1-HEAD2"}},{"type":"to-do","attributes":{"title":"HXPC1-D1"}}]}}]'
  tjson '[{"type":"project","attributes":{"title":"Synthetic Work Stuff","items":[]}}]'
  tjson '[{"type":"project","attributes":{"title":"Synthetic Work","items":[]}}]'
  sleep 2

  note "--- seed verification ---"
  gt "SELECT title, substr(uuid,1,8) AS uuid8, type, COALESCE(substr(project,1,8),'-') AS proj, COALESCE(substr(heading,1,8),'-') AS head FROM TMTask WHERE title LIKE 'HXPC1-%' OR title LIKE 'Synthetic Work%' ORDER BY type DESC, title" | tee -a "$REPORT"
  note "setup DONE — session in $SESSION"
  exit 0
fi

# ==================================================================== census
if [ "$CMD" = "census" ]; then
  load_session
  CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
  G() { lab_ssh "$IP" "THINGS_API_UI_DIRECT=1 $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
  AXM() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/hxax.js $*" </dev/null; }
  dumpax() { AXM dump > "$OUT/ax/$1.txt" 2>&1; note "  AX dump -> $OUT/ax/$1.txt ($(wc -l < "$OUT/ax/$1.txt" | tr -d ' ') lines)"; }

  note ""
  note "############### CENSUS (a) — the Repeat dialog's TWO numeric fields ###############"
  warm
  lab_ssh "$IP" "open -g 'things:///add?title=HXPC1-RPT&auth-token=$TOKEN'; sleep 4" </dev/null
  U=$(gq "SELECT uuid FROM TMTask WHERE title='HXPC1-RPT' AND trashed=0 LIMIT 1")
  note "  to-do HXPC1-RPT=$U"
  show "things:///show?id=$U"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  lab_ssh "$IP" 'sleep 3' </dev/null

  note "  -- A1: the dialog as opened (frequency default, NO ends bound) --"
  dumpax "a1-dialog-fresh"
  note "$(axq 'tell application "System Events" to tell process "Things3"
  set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
  set g to group 1 of sh
  return "group text fields=" & (count of text fields of g) & "  sheet text fields=" & (count of text fields of sh) & "  group pop ups=" & (count of pop up buttons of g)
end tell')"

  note "  -- A2: pick frequency=daily, drive interval=7, then Ends=after --"
  axq 'tell application "System Events" to tell process "Things3"
  set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
  set p to pop up button 1 of sh
  repeat 20 times
    if (exists menu 1 of p) then exit repeat
    click p
    delay 0.3
  end repeat
  click menu item "daily" of menu 1 of p
  delay 1.5
  set g to group 1 of sh
  set tf to text field 1 of g
  set focused of tf to true
  delay 0.15
  keystroke "a" using command down
  delay 0.1
  keystroke "7"
  delay 0.1
  key code 48
  delay 0.4
  return "interval field now = " & ((value of tf) as text)
end tell' | sed 's/^/    /' | tee -a "$REPORT"

  axq 'tell application "System Events" to tell process "Things3"
  set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
  set g to group 1 of sh
  set p to pop up button 1 of g
  repeat 20 times
    if (exists menu 1 of p) then exit repeat
    click p
    delay 0.3
  end repeat
  click menu item "after" of menu 1 of p
  delay 1.5
  return "ends=after selected"
end tell' | sed 's/^/    /' | tee -a "$REPORT"

  note "  -- A3: BOTH numeric fields visible — the census --"
  dumpax "a3-dialog-both-fields"
  axq 'tell application "System Events" to tell process "Things3"
  set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
  set g to group 1 of sh
  set out to "GROUP text fields=" & (count of text fields of g) & linefeed
  repeat with i from 1 to (count of text fields of g)
    set tf to text field i of g
    set p to position of tf
    set z to size of tf
    set v to ""
    try
      set v to (value of tf) as text
    end try
    set d to ""
    try
      set d to (description of tf) as text
    end try
    set idv to ""
    try
      set idv to (value of attribute "AXIdentifier" of tf) as text
    end try
    set out to out & "  group.textfield " & i & ": val=[" & v & "] @[" & (item 1 of p) & "," & (item 2 of p) & " " & (item 1 of z) & "x" & (item 2 of z) & "] desc=[" & d & "] id=[" & idv & "]" & linefeed
  end repeat
  set out to out & "SHEET text fields=" & (count of text fields of sh) & linefeed
  repeat with i from 1 to (count of text fields of sh)
    set tf to text field i of sh
    set p to position of tf
    set v to ""
    try
      set v to (value of tf) as text
    end try
    set out to out & "  sheet.textfield " & i & ": val=[" & v & "] @[" & (item 1 of p) & "," & (item 2 of p) & "]" & linefeed
  end repeat
  set out to out & "GROUP static texts:" & linefeed
  repeat with i from 1 to (count of static texts of g)
    set st to static text i of g
    set p to position of st
    set v to ""
    try
      set v to (value of st) as text
    end try
    set out to out & "  group.static " & i & ": [" & v & "] @[" & (item 1 of p) & "," & (item 2 of p) & "]" & linefeed
  end repeat
  set out to out & "GROUP pop up buttons:" & linefeed
  repeat with i from 1 to (count of pop up buttons of g)
    set pu to pop up button i of g
    set p to position of pu
    set v to ""
    try
      set v to (value of pu) as text
    end try
    set out to out & "  group.popup " & i & ": [" & v & "] @[" & (item 1 of p) & "," & (item 2 of p) & "]" & linefeed
  end repeat
  return out
end tell' | tee -a "$REPORT" > "$OUT/ax/a3-fields.txt"

  note "  -- A4: DISTINCTNESS — write different values through the two candidate paths, read both back --"
  axq 'tell application "System Events" to tell process "Things3"
  set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
  set g to group 1 of sh
  set n to (count of text fields of g)
  if n < 2 then return "ONLY " & n & " group text field(s) — the two controls do NOT both live in group 1"
  -- write 4 into field 1 and 9 into field 2 via the shipped mechanic
  repeat with i from 1 to 2
    set tf to text field i of g
    set want to "4"
    if i is 2 then set want to "9"
    set focused of tf to true
    delay 0.15
    keystroke "a" using command down
    delay 0.1
    keystroke want
    delay 0.1
    key code 48
    delay 0.35
  end repeat
  set r to ""
  repeat with i from 1 to (count of text fields of g)
    set tf to text field i of g
    set p to position of tf
    set r to r & "tf" & i & "=[" & ((value of tf) as text) & "]@x" & (item 1 of p) & "y" & (item 2 of p) & "  "
  end repeat
  return "READBACK: " & r
end tell' | sed 's/^/    /' | tee -a "$REPORT"
  dumpax "a4-after-distinct-writes"
  esc; esc

  note ""
  note "############### CENSUS (b) — the Move… project picker ###############"
  warm
  PA=$(gq "SELECT uuid FROM TMTask WHERE title='HXPC1-SRC' AND type=1 AND trashed=0 LIMIT 1")
  note "  source project HXPC1-SRC=$PA"
  show "things:///show?id=$PA"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null

  note "  -- B0: the heading row's More button + its title node (the U+200E question) --"
  axq 'tell application "System Events" to tell process "Things3"
  set t to table 1 of scroll area 1 of (first window whose subrole is "AXStandardWindow")
  set out to "content rows=" & (count of rows of t) & linefeed
  repeat with e in (entire contents of t)
    try
      set d to (description of e) as text
      if d is not "" then
        set out to out & "  desc=[" & d & "] len=" & (length of d) & " role=" & (role of e) & linefeed
      end if
    end try
  end repeat
  return out
end tell' | tee -a "$REPORT" > "$OUT/ax/b0-content-descs.txt"
  head -30 "$OUT/ax/b0-content-descs.txt" | sed 's/^/    /'
  note "  exact-match probe for the shipped selector:"
  axq 'tell application "System Events" to tell process "Things3"
  set t to table 1 of scroll area 1 of (first window whose subrole is "AXStandardWindow")
  return (exists (first UI element of t whose description is "More. HXPC1-HEAD"))
end tell' | sed 's/^/    exact "More. HXPC1-HEAD" resolves: /' | tee -a "$REPORT"

  MF=$(AXM more-frame HXPC1-HEAD); note "  More-button frame: $MF"
  CX=$(echo "$MF" | python3 -c "import sys,json;print(json.load(sys.stdin)['cx'])" 2>/dev/null || echo "")
  CY=$(echo "$MF" | python3 -c "import sys,json;print(json.load(sys.stdin)['cy'])" 2>/dev/null || echo "")
  if [ -z "$CX" ]; then note "  FATAL: no More button"; exit 1; fi
  note "  HID-click More ($CX,$CY): $(AXM click "$CX" "$CY")"
  lab_ssh "$IP" 'sleep 2' </dev/null
  dumpax "b1-ellipsis-popover"

  MV=$(AXM desc-frame "Move…"); note "  Move… item frame: $MV"
  MVX=$(echo "$MV" | python3 -c "import sys,json;print(json.load(sys.stdin)['cx'])" 2>/dev/null || echo "")
  MVY=$(echo "$MV" | python3 -c "import sys,json;print(json.load(sys.stdin)['cy'])" 2>/dev/null || echo "")
  if [ -z "$MVX" ]; then note "  FATAL: no Move… item"; exit 1; fi
  note "  HID-click Move… ($MVX,$MVY): $(AXM click "$MVX" "$MVY")"
  lab_ssh "$IP" 'sleep 2' </dev/null

  note "  -- B2: the picker, UNFILTERED --"
  dumpax "b2-picker-unfiltered"
  grep -nE 'SELECTED=true|FOCUSED=true|HIGHLIGHTED=true' "$OUT/ax/b2-picker-unfiltered.txt" | head -20 | sed 's/^/    /' | tee -a "$REPORT"

  note "  -- B3: type 'HXPC1-DEST' (a clean, unique match) --"
  lab_ssh "$IP" "osascript -e 'tell application \"System Events\" to keystroke \"HXPC1-DEST\"'; sleep 2" </dev/null
  dumpax "b3-picker-filtered-clean"
  grep -nE 'SELECTED=true|FOCUSED=true|HIGHLIGHTED=true' "$OUT/ax/b3-picker-filtered-clean.txt" | head -20 | sed 's/^/    /' | tee -a "$REPORT"
  esc; esc; esc

  note "  -- B4: the PREFIX COLLISION — type 'Synthetic Work' with 'Synthetic Work Stuff' also present --"
  warm
  PA2=$(gq "SELECT uuid FROM TMTask WHERE title='HXPC1-SRC2' AND type=1 AND trashed=0")
  show "things:///show?id=$PA2"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  MF2=$(AXM more-frame HXPC1-HEAD2)
  CX2=$(echo "$MF2" | python3 -c "import sys,json;print(json.load(sys.stdin)['cx'])" 2>/dev/null || echo "")
  CY2=$(echo "$MF2" | python3 -c "import sys,json;print(json.load(sys.stdin)['cy'])" 2>/dev/null || echo "")
  [ -n "$CX2" ] || { note "  FATAL: no More button on HXPC1-HEAD2"; exit 1; }
  AXM click "$CX2" "$CY2" >/dev/null; lab_ssh "$IP" 'sleep 2' </dev/null
  MV2=$(AXM desc-frame "Move…")
  MVX2=$(echo "$MV2" | python3 -c "import sys,json;print(json.load(sys.stdin)['cx'])" 2>/dev/null || echo "")
  MVY2=$(echo "$MV2" | python3 -c "import sys,json;print(json.load(sys.stdin)['cy'])" 2>/dev/null || echo "")
  [ -n "$MVX2" ] || { note "  FATAL: no Move… item (collision arm)"; exit 1; }
  AXM click "$MVX2" "$MVY2" >/dev/null; lab_ssh "$IP" 'sleep 2' </dev/null
  lab_ssh "$IP" "osascript -e 'tell application \"System Events\" to keystroke \"Synthetic Work\"'; sleep 2" </dev/null
  dumpax "b4-picker-prefix-collision"
  grep -nE 'SELECTED=true|FOCUSED=true|HIGHLIGHTED=true|New Project' "$OUT/ax/b4-picker-prefix-collision.txt" | head -25 | sed 's/^/    /' | tee -a "$REPORT"
  esc; esc; esc

  note "census DONE — dumps in $OUT/ax"
  exit 0
fi

# ==================================================================== cert
if [ "$CMD" = "cert" ]; then
  load_session
  CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
  G() { lab_ssh "$IP" "THINGS_API_UI_DIRECT=1 $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
  PASS=0; FAIL=0
  verdict() { if echo "$3" | grep -qF "$2"; then note "  PASS $1"; PASS=$((PASS+1)); else note "  FAIL $1 — expected to contain '$2', got: $3"; FAIL=$((FAIL+1)); fi; }

  # re-ship dist (the implementation changed since setup)
  if [ "${SKIP_SHIP:-0}" != "1" ]; then
    note "re-building + re-shipping dist"
    npm run build >"$OUT/build-cert.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
    scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
    lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
    scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
    note "shipped"
  fi
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
  note "ui-enabled = $(lab_ssh "$IP" "$CLI config get ui-enabled" </dev/null 2>/dev/null | tail -1)"

  note ""
  note "############### CELL (a) — runs in the cert-a phase, not here ###############"
  note "  todo make-repeating / reschedule-repeat are unreachable from a clone: their"
  note "  composites carry an AppleScript leg and the write gate returns direct-unknown for"
  note "  every sshd-descended shell (harness.md / CNC1 section 9). The dialog primitive is"
  note "  therefore certified in cert-a against the SHIPPED script text, in a real dialog."

  note ""
  note "############### CELL (b) — move-heading-to-project, CLEAN match ###############"
  warm
  # Per-run fixtures: a landed move is not repeatable, so a re-run must never read
  # the previous run's end state as this run's result.
  STAMP=$(date +%H%M%S)
  seed_src() { # seed_src <projectTitle> <headingTitle> [childTitle]
    local kids=""
    [ -n "${3:-}" ] && kids=",{\"type\":\"to-do\",\"attributes\":{\"title\":\"$3\"}}"
    lab_ssh "$IP" "~/labh/tjson.sh $(printf '%q' "$TOKEN") $(printf '%q' "[{\"type\":\"project\",\"attributes\":{\"title\":\"$1\",\"items\":[{\"type\":\"heading\",\"attributes\":{\"title\":\"$2\"}}$kids]}}]")" </dev/null
    sleep 4
  }
  seed_src "HXPC1-SRCB-$STAMP" "HXPC1-HEADB-$STAMP" "HXPC1-CB-$STAMP"
  PA=$(gq "SELECT uuid FROM TMTask WHERE title='HXPC1-SRCB-$STAMP' AND type=1 AND trashed=0 LIMIT 1")
  PB=$(gq "SELECT uuid FROM TMTask WHERE title='HXPC1-DEST' AND type=1 AND trashed=0 LIMIT 1")
  H=$(gq "SELECT uuid FROM TMTask WHERE title='HXPC1-HEADB-$STAMP' AND type=2 AND trashed=0 LIMIT 1")
  note "  src=$PA dest=$PB heading=$H"
  note "  before: $(gq "SELECT 'project='||COALESCE(substr(project,1,8),'-') FROM TMTask WHERE uuid='$H'")"
  PROJBEFORE=$(gq "SELECT COUNT(*) FROM TMTask WHERE type=1 AND trashed=0")
  OUTP=$(G project move-heading-to-project "$PA" "$H" --to "$PB" --dangerously-drive-gui --json)
  echo "$OUTP" > "$OUT/cell-b.log"; note "  $(echo "$OUTP" | tail -3)"
  AFTER=$(gq "SELECT CASE WHEN project='$PB' THEN 'MOVED-TO-DEST' ELSE 'still '||COALESCE(substr(project,1,8),'-') END FROM TMTask WHERE uuid='$H'")
  note "  after: $AFTER"
  note "  child follows via heading FK: $(gq "SELECT COUNT(*)||'/1' FROM TMTask WHERE heading='$H' AND project IS NULL")"
  note "  project count: before=$PROJBEFORE after=$(gq "SELECT COUNT(*) FROM TMTask WHERE type=1 AND trashed=0")"
  verdict "b: heading landed in HXPC1-DEST" "MOVED-TO-DEST" "$AFTER"
  verdict "b: no stray project minted" "$PROJBEFORE" "$(gq "SELECT COUNT(*) FROM TMTask WHERE type=1 AND trashed=0")"

  note ""
  note "############### CELL (c) — the PREFIX COLLISION (target the SHORTER title) ###############"
  warm
  seed_src "HXPC1-SRCC-$STAMP" "HXPC1-HEADC-$STAMP" "HXPC1-CC-$STAMP"
  PC=$(gq "SELECT uuid FROM TMTask WHERE title='HXPC1-SRCC-$STAMP' AND type=1 AND trashed=0 LIMIT 1")
  PSW=$(gq "SELECT uuid FROM TMTask WHERE title='Synthetic Work' AND type=1 AND trashed=0 LIMIT 1")
  PSWS=$(gq "SELECT uuid FROM TMTask WHERE title='Synthetic Work Stuff' AND type=1 AND trashed=0 LIMIT 1")
  H2=$(gq "SELECT uuid FROM TMTask WHERE title='HXPC1-HEADC-$STAMP' AND type=2 AND trashed=0 LIMIT 1")
  note "  src=$PC heading=$H2 'Synthetic Work'=$PSW 'Synthetic Work Stuff'=$PSWS"
  PROJBEFORE=$(gq "SELECT COUNT(*) FROM TMTask WHERE type=1 AND trashed=0")
  ROWSBEFORE=$(gq "SELECT COUNT(*) FROM TMTask")
  note "  before: heading project=$(gq "SELECT COALESCE(substr(project,1,8),'-') FROM TMTask WHERE uuid='$H2'") projects=$PROJBEFORE rows=$ROWSBEFORE"
  OUTP=$(G project move-heading-to-project "$PC" "$H2" --to "$PSW" --dangerously-drive-gui --json)
  echo "$OUTP" > "$OUT/cell-c.log"; note "  OUTPUT:"; echo "$OUTP" | sed 's/^/    /' | tee -a "$REPORT" >/dev/null
  note "$(echo "$OUTP" | tail -6 | sed 's/^/    /')"
  LANDED=$(gq "SELECT CASE WHEN project='$PSW' THEN 'CORRECT-Synthetic-Work' WHEN project='$PSWS' THEN 'WRONG-Synthetic-Work-Stuff' WHEN project='$PC' THEN 'UNMOVED' ELSE 'OTHER:'||COALESCE(substr(project,1,8),'-') END FROM TMTask WHERE uuid='$H2'")
  PROJAFTER=$(gq "SELECT COUNT(*) FROM TMTask WHERE type=1 AND trashed=0")
  ROWSAFTER=$(gq "SELECT COUNT(*) FROM TMTask")
  note "  after: heading=$LANDED projects=$PROJAFTER rows=$ROWSAFTER"
  note "  any project whose title contains 'Synthetic':"
  gt "SELECT title, substr(uuid,1,8) AS uuid8, trashed FROM TMTask WHERE type=1 AND title LIKE '%Synthetic%'" | sed 's/^/    /' | tee -a "$REPORT"
  if [ "$LANDED" = "CORRECT-Synthetic-Work" ] || [ "$LANDED" = "UNMOVED" ]; then
    note "  PASS c: landed correctly or failed closed ($LANDED)"; PASS=$((PASS+1))
  else
    note "  FAIL c: $LANDED"; FAIL=$((FAIL+1))
  fi
  verdict "c: NO stray project minted" "$PROJBEFORE" "$PROJAFTER"

  note ""
  note "############### CELL (d) — the STRAY-PROJECT hazard: a COMPLETED destination ###############"
  # The pre-fix drive minted a second project of the destination's name here
  # (§B4). The pre-state now refuses up front; the picker-row resolver is the
  # runtime backstop if it ever gets past.
  warm
  seed_src "HXPC1-SRCD-$STAMP" "HXPC1-HEADD-$STAMP"
  DTITLE="HXPC1-DONE-$STAMP"
  lab_ssh "$IP" "~/labh/tjson.sh $(printf '%q' "$TOKEN") $(printf '%q' "[{\"type\":\"project\",\"attributes\":{\"title\":\"$DTITLE\",\"items\":[]}}]")" </dev/null
  sleep 3
  PD=$(gq "SELECT uuid FROM TMTask WHERE title='HXPC1-SRCD-$STAMP' AND type=1 AND trashed=0 LIMIT 1")
  HD=$(gq "SELECT uuid FROM TMTask WHERE title='HXPC1-HEADD-$STAMP' AND type=2 AND trashed=0 LIMIT 1")
  DONE=$(gq "SELECT uuid FROM TMTask WHERE title='$DTITLE' AND type=1 AND trashed=0 LIMIT 1")
  lab_ssh "$IP" "open -g 'things:///update-project?id=$DONE&auth-token=$TOKEN&completed=true'; sleep 4" </dev/null
  note "  dest $DTITLE=$DONE status=$(gq "SELECT status FROM TMTask WHERE uuid='$DONE'")"
  PROJBEFORE=$(gq "SELECT COUNT(*) FROM TMTask WHERE type=1 AND trashed=0")
  ROWSBEFORE=$(gq "SELECT COUNT(*) FROM TMTask")
  OUTP=$(G project move-heading-to-project "$PD" "$HD" --to "$DONE" --dangerously-drive-gui --json)
  echo "$OUTP" > "$OUT/cell-d.log"; note "$(echo "$OUTP" | tail -6 | sed 's/^/    /')"
  PROJAFTER=$(gq "SELECT COUNT(*) FROM TMTask WHERE type=1 AND trashed=0")
  note "  heading project after: $(gq "SELECT COALESCE(substr(project,1,8),'-') FROM TMTask WHERE uuid='$HD'") (source=$(echo "$PD" | cut -c1-8))"
  note "  projects: before=$PROJBEFORE after=$PROJAFTER  rows: before=$ROWSBEFORE after=$(gq "SELECT COUNT(*) FROM TMTask")"
  gt "SELECT title, substr(uuid,1,8) AS uuid8, status FROM TMTask WHERE type=1 AND title LIKE '$DTITLE%'" | sed 's/^/    /' | tee -a "$REPORT"
  verdict "d: refused, naming the completed destination" "completed" "$OUTP"
  verdict "d: NO stray project minted" "$PROJBEFORE" "$PROJAFTER"
  verdict "d: heading still in its source project" "$(echo "$PD" | cut -c1-8)" "$(gq "SELECT COALESCE(substr(project,1,8),'-') FROM TMTask WHERE uuid='$HD'")"

  note ""; note "###### HXPC1 SUMMARY: PASS=$PASS FAIL=$FAIL ######"
  note "artifacts in $OUT"
  exit 0
fi

# ================================================================== cert-a
#
# CELL (a) proper. The `todo make-repeating` / `reschedule-repeat` CLI legs are
# unreachable from a clone — their composites carry an AppleScript leg and the
# Wave A write gate returns `direct-unknown` for every sshd-descended shell
# (docs/lab/harness.md, CNC1 §9) — so the dialog primitive is certified the
# REPX2/REPX3 way instead: a URL-scheme add, a direct AX Repeat-dialog drive, and
# the EXACT script text the shipped driver emits, read out of dist/ so the thing
# under test is the thing that ships.
if [ "$CMD" = "cert-a" ]; then
  load_session
  PASS=0; FAIL=0
  verdict() { if echo "$3" | grep -qF "$2"; then note "  PASS $1"; PASS=$((PASS+1)); else note "  FAIL $1 — expected to contain '$2', got: $3"; FAIL=$((FAIL+1)); fi; }
  SHEETGROUP='group 1 of sheet 1 of (first window whose subrole is "AXStandardWindow")'

  # Emit a shipped script into a guest file and run it there.
  emit() { # emit <outfile> <js-expression using process.argv[1]> <argv1>
    node -e "import('./dist/write/vectors/ui.js').then(m=>process.stdout.write($2))" "$3" > "$OUT/$1"
    lab_ssh "$IP" "cat > ~/labh/$1" < "$OUT/$1"
  }
  runscript() { lab_ssh "$IP" "osascript ~/labh/$1" </dev/null 2>&1; }

  emit s-interval-3.applescript "m.axSetGroupNumberScript(process.argv[1],'interval','3')" "$SHEETGROUP"
  emit s-ends-5.applescript "m.axSetGroupNumberScript(process.argv[1],'ends-count','5')" "$SHEETGROUP"
  emit s-interval-6.applescript "m.axSetGroupNumberScript(process.argv[1],'interval','6')" "$SHEETGROUP"
  emit s-old-textfield1.applescript "m.axSetValueScript(process.argv[1],'8')" "text field 1 of $SHEETGROUP"
  note "shipped script text emitted from dist/ into $OUT (and onto the guest)"

  note ""
  note "############### CELL (a) — the two numeric fields, driven by the SHIPPED scripts ###############"
  warm
  # A per-run title: a committed dialog turns the row into a template, so a
  # re-run must not inherit the previous one's state.
  ATITLE="HXPC1-CELLA-$(date +%H%M%S)"
  lab_ssh "$IP" "open -g 'things:///add?title=$ATITLE&auth-token=$TOKEN'; sleep 4" </dev/null
  UA=$(gq "SELECT uuid FROM TMTask WHERE title='$ATITLE' AND trashed=0 AND rt1_recurrenceRule IS NULL LIMIT 1")
  note "  to-do=$UA"
  show "things:///show?id=$UA"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  lab_ssh "$IP" 'sleep 3' </dev/null
  axq 'tell application "System Events" to tell process "Things3"
  set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
  set p to pop up button 1 of sh
  repeat 20 times
    if (exists menu 1 of p) then exit repeat
    click p
    delay 0.3
  end repeat
  click menu item "daily" of menu 1 of p
  delay 1.5
  return "frequency=daily"
end tell' | sed 's/^/    /' | tee -a "$REPORT"

  R=$(runscript s-interval-3.applescript); note "  shipped interval=3 (sole field): $R"
  verdict "a1: interval drove with only one field present" "OK" "$R"

  axq 'tell application "System Events" to tell process "Things3"
  set g to group 1 of sheet 1 of (first window whose subrole is "AXStandardWindow")
  set p to pop up button 1 of g
  repeat 20 times
    if (exists menu 1 of p) then exit repeat
    click p
    delay 0.3
  end repeat
  click menu item "after" of menu 1 of p
  delay 1.5
  return "ends=after"
end tell' | sed 's/^/    /' | tee -a "$REPORT"

  R=$(runscript s-ends-5.applescript); note "  shipped ends-count=5: $R"
  verdict "a2: ends-count drove with BOTH fields present" "OK" "$R"

  note "  -- a3: the PRE-POPULATED case — re-drive the INTERVAL while both fields exist --"
  R=$(runscript s-interval-6.applescript); note "  shipped interval=6: $R"
  verdict "a3: interval drove on a two-field dialog" "OK" "$R"

  FIELDS=$(axq 'tell application "System Events" to tell process "Things3"
  set g to group 1 of sheet 1 of (first window whose subrole is "AXStandardWindow")
  set out to ""
  repeat with i from 1 to (count of text fields of g)
    set tf to text field i of g
    set p to position of tf
    set out to out & "tf" & i & "=[" & ((value of tf) as text) & "]@y" & (item 2 of p) & " "
  end repeat
  return out
end tell')
  note "  field readback: $FIELDS"
  verdict "a3: the ends count still holds 5 (the interval drive did NOT overwrite it)" "tf1=[5]" "$FIELDS"
  verdict "a3: the interval holds 6" "tf2=[6]" "$FIELDS"

  note "  -- a4: FALSIFY the old shape — the shipped set-value on \`text field 1 of group 1\` --"
  R=$(runscript s-old-textfield1.applescript); note "  old spelling, value 8: $R"
  FIELDS2=$(axq 'tell application "System Events" to tell process "Things3"
  set g to group 1 of sheet 1 of (first window whose subrole is "AXStandardWindow")
  set out to ""
  repeat with i from 1 to (count of text fields of g)
    set tf to text field i of g
    set out to out & "tf" & i & "=[" & ((value of tf) as text) & "] "
  end repeat
  return out
end tell')
  note "  field readback after the old spelling: $FIELDS2"
  verdict "a4: text-field-1-of-group-1 is the ENDS COUNT, not the interval" "tf1=[8]" "$FIELDS2"
  verdict "a4: the interval was left untouched by it" "tf2=[6]" "$FIELDS2"

  note "  -- a5: commit and read the rule out of the database --"
  # put the count back to 5 through the shipped path, then OK
  runscript s-ends-5.applescript >/dev/null
  axq 'tell application "System Events" to tell process "Things3" to click button "OK" of sheet 1 of (first window whose subrole is "AXStandardWindow")' >/dev/null
  lab_ssh "$IP" 'sleep 4' </dev/null
  RULE=$(lab_ssh "$IP" "python3 ~/labh/rsum.py $ATITLE" </dev/null 2>&1)
  note "  rule: $RULE"
  verdict "a5: interval 6 landed in the rule" "fa=6" "$RULE"
  verdict "a5: ends-after 5 landed in the rule" "rc=5" "$RULE"

  note ""; note "###### HXPC1 CELL (a) SUMMARY: PASS=$PASS FAIL=$FAIL ######"
  exit 0
fi

# ============================================================== dialog-census
#
# §A. The Repeat dialog's cadence group in every mode that shows a numeric
# field, so the interval / ends-count anchors are chosen against measurement
# rather than the fixed-frequency case alone.
if [ "$CMD" = "dialog-census" ]; then
  load_session
  DUMP='tell application "System Events" to tell process "Things3"
  set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
  set g to group 1 of sh
  set out to "  text fields=" & (count of text fields of g) & linefeed
  repeat with i from 1 to (count of text fields of g)
    set tf to text field i of g
    set p to position of tf
    set out to out & "    tf" & i & " val=[" & ((value of tf) as text) & "] @[" & (item 1 of p) & "," & (item 2 of p) & "]" & linefeed
  end repeat
  set out to out & "  static texts:" & linefeed
  repeat with i from 1 to (count of static texts of g)
    set s2 to static text i of g
    set p to position of s2
    set v to ""
    try
      set v to (value of s2) as text
    end try
    set out to out & "    st" & i & " [" & v & "] @[" & (item 1 of p) & "," & (item 2 of p) & "]" & linefeed
  end repeat
  set out to out & "  pop ups:" & linefeed
  repeat with i from 1 to (count of pop up buttons of g)
    set pu to pop up button i of g
    set p to position of pu
    set out to out & "    pu" & i & " [" & ((value of pu) as text) & "] @[" & (item 1 of p) & "," & (item 2 of p) & "]" & linefeed
  end repeat
  return out
end tell'
  open_dialog() {
    warm
    lab_ssh "$IP" "open -g 'things:///show?id=$1'; sleep 3; osascript -e 'tell application \"Things3\" to activate'; sleep 2" </dev/null
    axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
    lab_ssh "$IP" 'sleep 3' </dev/null
  }
  pick_freq() {
    axq "tell application \"System Events\" to tell process \"Things3\"
  set sh to sheet 1 of (first window whose subrole is \"AXStandardWindow\")
  set p to pop up button 1 of sh
  repeat 20 times
    if (exists menu 1 of p) then exit repeat
    click p
    delay 0.3
  end repeat
  click menu item \"$1\" of menu 1 of p
  delay 1.5
  return \"freq=$1\"
end tell" >/dev/null
  }
  pick_ends_after() {
    axq 'tell application "System Events" to tell process "Things3"
  set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
  set g to group 1 of sh
  set p to pop up button 1 of g
  repeat 20 times
    if (exists menu 1 of p) then exit repeat
    click p
    delay 0.3
  end repeat
  if (exists menu item "after" of menu 1 of p) then
    click menu item "after" of menu 1 of p
    delay 1.5
    return "ends=after"
  end if
  set nms to name of every menu item of menu 1 of p
  key code 53
  return "NO after ITEM; the group pop-up is the unit menu = " & nms
end tell'
  }
  DTITLE="HXPC1-DLGCENSUS-$(date +%H%M%S)"
  lab_ssh "$IP" "open -g 'things:///add?title=$DTITLE&auth-token=$TOKEN'; sleep 4" </dev/null
  U=$(gq "SELECT uuid FROM TMTask WHERE title='$DTITLE' AND trashed=0 LIMIT 1")
  note "dialog census on $DTITLE=$U"
  note "== M1 fixed daily, no ends bound =="
  open_dialog "$U"; pick_freq daily; axq "$DUMP" | tee -a "$REPORT"; esc
  note "== M2 fixed daily + Ends: after =="
  open_dialog "$U"; pick_freq daily; pick_ends_after | sed 's/^/  /' | tee -a "$REPORT"; axq "$DUMP" | tee -a "$REPORT"; esc
  note "== M3 after completion, no ends bound =="
  open_dialog "$U"; pick_freq "after completion"; axq "$DUMP" | tee -a "$REPORT"; esc
  note "== M4 after completion + Ends: after (if offered at all) =="
  open_dialog "$U"; pick_freq "after completion"; pick_ends_after | sed 's/^/  /' | tee -a "$REPORT"; axq "$DUMP" | tee -a "$REPORT"; esc
  exit 0
fi

# ============================================================== prefix-hazard
#
# §B3/§B4. The PRE-FIX commit shape, driven by hand: type the destination into
# the Move… picker and press Return with nothing asserted. Two arms —
#   (1) a prefix collision ("Synthetic Work" beside "Synthetic Work Stuff");
#   (2) a COMPLETED destination, which the picker does not list at all.
# This is the falsification/hazard evidence and does not touch shipped code, so
# it stays reproducible after the fix.
if [ "$CMD" = "prefix-hazard" ]; then
  load_session
  AXM() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/hxax.js $*" </dev/null; }
  offer_rows() {
    axq 'tell application "System Events" to tell process "Things3"
  set W to (first window whose subrole is "AXUnknown" and size is not {40, 40})
  set sa to scroll area 1 of W
  set out to ""
  repeat with i from 1 to (count of UI elements of sa)
    set e to UI element i of sa
    set d to ""
    try
      set d to (description of e) as text
    end try
    if d is not "" and (role of e) is "AXUnknown" then set out to out & "  [" & i & "] [" & d & "]" & linefeed
  end repeat
  if out is "" then set out to "  (no rows)"
  return out
end tell'
  }
  blind_return() { # blind_return <sourceProjectTitle> <headingTitle> <typedText>
    warm
    local pu
    pu=$(gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND trashed=0 LIMIT 1")
    lab_ssh "$IP" "open -g 'things:///show?id=$pu'; sleep 3; osascript -e 'tell application \"Things3\" to activate'; sleep 2" </dev/null
    local mf cx cy mv mvx mvy
    mf=$(AXM more-frame "$2")
    cx=$(echo "$mf" | python3 -c "import sys,json;print(json.load(sys.stdin)['cx'])" 2>/dev/null || echo "")
    cy=$(echo "$mf" | python3 -c "import sys,json;print(json.load(sys.stdin)['cy'])" 2>/dev/null || echo "")
    [ -n "$cx" ] || { note "  FATAL: no More button for $2"; return 1; }
    AXM click "$cx" "$cy" >/dev/null; lab_ssh "$IP" 'sleep 2' </dev/null
    mv=$(AXM desc-frame "Move…")
    mvx=$(echo "$mv" | python3 -c "import sys,json;print(json.load(sys.stdin)['cx'])" 2>/dev/null || echo "")
    mvy=$(echo "$mv" | python3 -c "import sys,json;print(json.load(sys.stdin)['cy'])" 2>/dev/null || echo "")
    [ -n "$mvx" ] || { note "  FATAL: no Move… item"; return 1; }
    AXM click "$mvx" "$mvy" >/dev/null; lab_ssh "$IP" 'sleep 2' </dev/null
    axq "tell application \"System Events\" to keystroke \"$3\"" >/dev/null
    lab_ssh "$IP" 'sleep 2' </dev/null
    note "  rows on offer at the moment of the Return:"
    offer_rows | tee -a "$REPORT"
    AXM key 36 >/dev/null
    lab_ssh "$IP" 'sleep 3' </dev/null
  }
  STAMP=$(date +%H%M%S)
  seed() { lab_ssh "$IP" "~/labh/tjson.sh $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null; sleep 4; }

  note ""
  note "###### ARM 1 — the PREFIX COLLISION under a blind Return ######"
  seed "[{\"type\":\"project\",\"attributes\":{\"title\":\"HXPC1-PFX-$STAMP\",\"items\":[{\"type\":\"heading\",\"attributes\":{\"title\":\"HXPC1-PFXH-$STAMP\"}}]}}]"
  for t in "Synthetic Work Stuff" "Synthetic Work"; do
    [ -z "$(gq "SELECT uuid FROM TMTask WHERE title='$t' AND type=1 AND trashed=0 LIMIT 1")" ] &&
      seed "[{\"type\":\"project\",\"attributes\":{\"title\":\"$t\",\"items\":[]}}]"
  done
  PB=$(gq "SELECT COUNT(*) FROM TMTask WHERE type=1 AND trashed=0")
  note "  projects before=$PB"
  blind_return "HXPC1-PFX-$STAMP" "HXPC1-PFXH-$STAMP" "Synthetic Work"
  note "  landed in: $(gq "SELECT p.title FROM TMTask h JOIN TMTask p ON p.uuid = h.project WHERE h.title='HXPC1-PFXH-$STAMP'")"
  note "  projects after=$(gq "SELECT COUNT(*) FROM TMTask WHERE type=1 AND trashed=0") (before=$PB)"

  note ""
  note "###### ARM 2 — a COMPLETED destination under a blind Return (the stray-project hazard) ######"
  seed "[{\"type\":\"project\",\"attributes\":{\"title\":\"HXPC1-ARC-$STAMP\",\"items\":[{\"type\":\"heading\",\"attributes\":{\"title\":\"HXPC1-ARCH-$STAMP\"}}]}}]"
  ADEST="Synthetic Archive $STAMP"
  seed "[{\"type\":\"project\",\"attributes\":{\"title\":\"$ADEST\",\"items\":[]}}]"
  DU=$(gq "SELECT uuid FROM TMTask WHERE title='$ADEST' AND type=1 AND trashed=0 LIMIT 1")
  lab_ssh "$IP" "open -g 'things:///update-project?id=$DU&auth-token=$TOKEN&completed=true'; sleep 4" </dev/null
  note "  dest '$ADEST'=$DU status=$(gq "SELECT status FROM TMTask WHERE uuid='$DU'")"
  PB=$(gq "SELECT COUNT(*) FROM TMTask WHERE type=1 AND trashed=0")
  note "  projects before=$PB"
  blind_return "HXPC1-ARC-$STAMP" "HXPC1-ARCH-$STAMP" "$ADEST"
  note "  landed in: $(gq "SELECT p.title||' (status='||p.status||')' FROM TMTask h JOIN TMTask p ON p.uuid = h.project WHERE h.title='HXPC1-ARCH-$STAMP'")"
  note "  projects after=$(gq "SELECT COUNT(*) FROM TMTask WHERE type=1 AND trashed=0") (before=$PB)"
  gt "SELECT title, substr(uuid,1,8) AS uuid8, status, creationDate FROM TMTask WHERE type=1 AND title='$ADEST' ORDER BY creationDate" | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ==================================================================== teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: stop + delete $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  rm -f "$SESSION"
  note "teardown DONE"
  exit 0
fi

echo "usage: $0 setup|census|dialog-census|prefix-hazard|cert|cert-a|teardown" >&2
exit 1
