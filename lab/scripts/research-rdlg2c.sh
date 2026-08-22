#!/bin/bash
# RDLG2c — CERTIFY the re-pointed 3.23 repeat-dialog recipes with the PRODUCTION
# CLI (`--dangerously-drive-gui`) against a golden-v4 clone (Things 3.23 / dbv 27).
#
# Full-vocabulary make-repeating (daily · weekly-multi-weekday · monthly · yearly ·
# deadlined · ends-bound), add-repeating, reschedule-repeat through the RENAMED
# `Edit Rule…` menu item, the RRD1 pre-populated multi-weekday converge (grow AND
# shrink), and the new `Next:` occurrence pop-up (on-rule honored, off-rule refused
# fail-closed). Plus three residual census cells the recipe work depends on: the
# weekday row REMOVE button, `File ▸ New Repeating To-Do` end to end, and a second
# attempt at the Make Exception chooser through the When picker.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is never
# booted). Airgap, clock pinned 2026-07-05 (a SUNDAY). Fixtures fully synthetic
# (RDLG2C-*). Teardown on EXIT (KEEP=1 to leave it up).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-rdlg2c-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[rdlg2c] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"

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
note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) (a Sunday)"

lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }

lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
WD=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
rows=c.execute("SELECT uuid, rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationStartDate, rt1_instanceCreationCount, deadline, startDate FROM TMTask WHERE title=? AND rt1_recurrenceRule IS NOT NULL", (sys.argv[1],)).fetchall()
if not rows: print("NO-TEMPLATE"); sys.exit(0)
for row in rows:
    d=plistlib.loads(row[1]); offs=[]
    for o in d.get('of',[]):
        bits=[]
        if 'wd' in o: bits.append("wd=%s(%s)"%(o['wd'], WD[o['wd']] if 0<=o['wd']<7 else "?"))
        for k in ('dy','mo','wdo'):
            if k in o: bits.append("%s=%s"%(k,o[k]))
        offs.append("{"+",".join(bits)+"}")
    print("tp=%s fu=%s fa=%s ts=%s rc=%s of=[%s] next=%s icStart=%s icCount=%s tmplDeadline=%s"%(
        d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),",".join(offs),
        dpk(row[2]),dpk(row[3]),row[4],dpk(row[5])))
EOF
rsum() { lab_ssh "$IP" "python3 ~/labh/rsum.py $(printf '%q' "$1")" </dev/null 2>&1; }

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
  var f=frame(el); if(f.x!==null)p.push('@['+f.x+','+f.y+' '+f.w+'x'+f.h+']')
  return Array(d+1).join('  ')+p.join(' | ')}
function walk(el,d,acc,ix){acc.push(line(el,d,ix)); if(d>14)return acc; var ch=kids(el); for(var i=0;i<ch.length;i++)walk(ch[i],d+1,acc,i+1); return acc}
function run(){
  var app=$.AXUIElementCreateApplication(pidOf('Things3')); var ws=kids(app); var acc=[]
  for(var i=0;i<ws.length;i++){
    var w=ws[i], f=frame(w), sub=sv(w,'AXSubrole')
    if(sub==='AXUnknown' && !(f.w===40&&f.h===40)){acc.push('=== DETACHED '+(i+1)+' id='+sv(w,'AXIdentifier')+' @['+f.x+','+f.y+' '+f.w+'x'+f.h+'] ==='); walk(w,0,acc,i+1)}
    var ch=kids(w)
    for(var j=0;j<ch.length;j++){var r=sv(ch[j],'AXRole'); if(r==='AXSheet'||r==='AXPopover'){acc.push('=== '+r+' ==='); walk(ch[j],0,acc,j+1)}}
  }
  if(!acc.length) acc.push('(no sheet / popover / detached dialog present)')
  return acc.join('\n')}
EOF
sheetdump() { lab_ssh "$IP" 'osascript -l JavaScript ~/labh/sheet.jxa' </dev/null > "$OUT/ax/$1.txt" 2>&1; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
esc() { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }

TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
note "env: Things $TVER ($TBLD) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / golden $GOLDEN"

# ---- ship the production bundle ------------------------------------------
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
G() { lab_ssh "$IP" "$CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
note "shipped dist; ui-enabled=true"

mktodo() {  # mktodo <title> [extra query]
  lab_ssh "$IP" "open -g 'things:///add?title=$1${2:-}&auth-token=$TOKEN'; sleep 4" </dev/null
  gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NULL LIMIT 1"
}

PASS=0; FAIL=0
cell() { note ""; note "=== $1 ==="; }
verdict() { # verdict <name> <expected-substring> <actual>
  if echo "$3" | grep -qF "$2"; then note "  PASS $1"; PASS=$((PASS+1));
  else note "  FAIL $1 — expected to contain '$2', got: $3"; FAIL=$((FAIL+1)); fi
}

warm

# =====================================================================
cell "C1 make-repeating daily interval 3 (the certified two-control path — no shape probe)"
U=$(mktodo RDLG2C-DAILY); note "  uuid=$U"
OUTP=$(G todo make-repeating "$U" --frequency daily --interval 3 --dangerously-drive-gui --json)
echo "$OUTP" > "$OUT/c1.log"; note "  $(echo "$OUTP" | tail -2)"
R=$(rsum RDLG2C-DAILY); note "  rule: $R"
verdict "C1 daily unit" "fu=16" "$R"   # fu = unit code (16 day / 8 month / 4 year), fa = interval
verdict "C1 interval 3" "fa=3" "$R"

# =====================================================================
cell "C2 make-repeating weekly --weekdays monday,thursday (the maintainer's example)"
U=$(mktodo RDLG2C-MW); note "  uuid=$U"
OUTP=$(G todo make-repeating "$U" --frequency weekly --interval 1 --weekdays monday,thursday --dangerously-drive-gui --json)
echo "$OUTP" > "$OUT/c2.log"; note "  $(echo "$OUTP" | tail -3)"
R=$(rsum RDLG2C-MW); note "  rule: $R"
verdict "C2 monday present" "wd=1(Mon)" "$R"
verdict "C2 thursday present" "wd=4(Thu)" "$R"
verdict "C2 no stray sunday" "of=[{wd=1(Mon)},{wd=4(Thu)}]" "$R"

# =====================================================================
cell "C3 make-repeating monthly --on-day 15"
U=$(mktodo RDLG2C-MON); note "  uuid=$U"
OUTP=$(G todo make-repeating "$U" --frequency monthly --interval 1 --on-day 15 --dangerously-drive-gui --json)
echo "$OUTP" > "$OUT/c3.log"; note "  $(echo "$OUTP" | tail -2)"
R=$(rsum RDLG2C-MON); note "  rule: $R"
verdict "C3 day-of-month 15" "dy=14" "$R"   # dy is 0-based in the blob

# =====================================================================
cell "C4 make-repeating yearly --yearly-month 10 --on-day 8"
U=$(mktodo RDLG2C-YR); note "  uuid=$U"
OUTP=$(G todo make-repeating "$U" --frequency yearly --interval 1 --yearly-month 10 --on-day 8 --dangerously-drive-gui --json)
echo "$OUTP" > "$OUT/c4.log"; note "  $(echo "$OUTP" | tail -2)"
R=$(rsum RDLG2C-YR); note "  rule: $R"
verdict "C4 october" "mo=9" "$R"   # mo is 0-based in the blob
verdict "C4 day 8" "dy=7" "$R"

# =====================================================================
cell "C5 make-repeating monthly nth-weekday (--on-weekday friday --on-ordinal last)"
U=$(mktodo RDLG2C-NTH); note "  uuid=$U"
OUTP=$(G todo make-repeating "$U" --frequency monthly --interval 1 --on-weekday friday --on-ordinal last --dangerously-drive-gui --json)
echo "$OUTP" > "$OUT/c5.log"; note "  $(echo "$OUTP" | tail -2)"
R=$(rsum RDLG2C-NTH); note "  rule: $R"
verdict "C5 friday anchor" "wd=5(Fri)" "$R"

# =====================================================================
cell "C6 ends-bound shapes: --ends-after 5 and --ends-on 2027-01-01"
U=$(mktodo RDLG2C-ENDA); note "  uuid=$U"
OUTP=$(G todo make-repeating "$U" --frequency daily --interval 2 --ends-after 5 --dangerously-drive-gui --json)
echo "$OUTP" > "$OUT/c6a.log"; note "  ends-after: $(echo "$OUTP" | tail -2)"
note "  rule: $(rsum RDLG2C-ENDA)"
U=$(mktodo RDLG2C-ENDD); note "  uuid=$U"
OUTP=$(G todo make-repeating "$U" --frequency daily --interval 1 --ends-on 2027-01-01 --dangerously-drive-gui --json)
echo "$OUTP" > "$OUT/c6b.log"; note "  ends-on: $(echo "$OUTP" | tail -2)"
note "  rule: $(rsum RDLG2C-ENDD)"
verdict "C6 ends-on drove" "ok" "$(echo "$OUTP" | tr -d ' \n')"

# =====================================================================
cell "C7 deadlined shape: --deadline --start-days-earlier 3"
U=$(mktodo RDLG2C-DL); note "  uuid=$U"
OUTP=$(G todo make-repeating "$U" --frequency weekly --interval 1 --weekdays wednesday --deadline --start-days-earlier 3 --dangerously-drive-gui --json)
echo "$OUTP" > "$OUT/c7.log"; note "  $(echo "$OUTP" | tail -3)"
R=$(rsum RDLG2C-DL); note "  rule: $R"
verdict "C7 wednesday" "wd=3(Wed)" "$R"
verdict "C7 start-offset" "ts=-3" "$R"

# =====================================================================
cell "C8 Next: pop-up — an ON-RULE first occurrence is honored"
# clock is Sunday 2026-07-05; a weekly-Sunday rule offers Jul 12, 19, 26 …
U=$(mktodo RDLG2C-NEXTOK); note "  uuid=$U"
OUTP=$(G todo make-repeating "$U" --frequency weekly --interval 1 --weekdays sunday --when 2026-07-19 --dangerously-drive-gui --json)
echo "$OUTP" > "$OUT/c8.log"; note "  $(echo "$OUTP" | tail -4)"
R=$(rsum RDLG2C-NEXTOK); note "  rule: $R"
verdict "C8 first occurrence honored" "icStart=2026-07-19" "$R"

# =====================================================================
cell "C9 Next: pop-up — an OFF-RULE first occurrence FAILS CLOSED (3.23 removed the free date field)"
U=$(mktodo RDLG2C-NEXTOFF); note "  uuid=$U"
OUTP=$(G todo make-repeating "$U" --frequency weekly --interval 1 --weekdays sunday --when 2026-07-22 --dangerously-drive-gui --json)
echo "$OUTP" > "$OUT/c9.log"; note "  $(echo "$OUTP" | tail -6)"
note "  templates minted: $(gq "SELECT COUNT(*) FROM TMTask WHERE title='RDLG2C-NEXTOFF' AND rt1_recurrenceRule IS NOT NULL")"
verdict "C9 refused with the named reason" "not one of them" "$OUTP"

# =====================================================================
cell "C10 reschedule-repeat through the RENAMED Edit Rule… menu item"
U=$(mktodo RDLG2C-RES); note "  uuid=$U"
G todo make-repeating "$U" --frequency daily --interval 1 --dangerously-drive-gui --json > "$OUT/c10-make.log" 2>&1
T=$(gq "SELECT uuid FROM TMTask WHERE title='RDLG2C-RES' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
note "  template=$T rule before: $(rsum RDLG2C-RES)"
warm
OUTP=$(G todo reschedule-repeat "$T" --frequency daily --interval 4 --dangerously-drive-gui --json)
echo "$OUTP" > "$OUT/c10.log"; note "  $(echo "$OUTP" | tail -3)"
R=$(rsum RDLG2C-RES); note "  rule after: $R"
verdict "C10 Edit Rule… drove the reschedule" "fu=" "$R"

# =====================================================================
cell "C11 RRD1 GROW — reschedule a PRE-POPULATED {mon,wed} onto {tue,thu,sat}"
U=$(mktodo RDLG2C-RRD1); note "  uuid=$U"
G todo make-repeating "$U" --frequency weekly --interval 1 --weekdays monday,wednesday --dangerously-drive-gui --json > "$OUT/c11-make.log" 2>&1
T=$(gq "SELECT uuid FROM TMTask WHERE title='RDLG2C-RRD1' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
note "  rule before: $(rsum RDLG2C-RRD1)"
warm
OUTP=$(G todo reschedule-repeat "$T" --frequency weekly --interval 1 --weekdays tuesday,thursday,saturday --dangerously-drive-gui --json)
echo "$OUTP" > "$OUT/c11.log"; note "  $(echo "$OUTP" | tail -3)"
R=$(rsum RDLG2C-RRD1); note "  rule after: $R"
verdict "C11 tuesday" "wd=2(Tue)" "$R"
verdict "C11 thursday" "wd=4(Thu)" "$R"
verdict "C11 saturday" "wd=6(Sat)" "$R"
if echo "$R" | grep -qE "wd=1\(Mon\)|wd=3\(Wed\)"; then
  note "  FAIL C11 STALE ROW SURVIVED (the RRD1 trap still open)"; FAIL=$((FAIL+1))
else
  note "  PASS C11 no stale weekday survived"; PASS=$((PASS+1))
fi

# =====================================================================
cell "C12 RRD1 SHRINK — reschedule {tue,thu,sat} down to {friday}"
warm
OUTP=$(G todo reschedule-repeat "$T" --frequency weekly --interval 1 --weekdays friday --dangerously-drive-gui --json)
echo "$OUTP" > "$OUT/c12.log"; note "  $(echo "$OUTP" | tail -3)"
R=$(rsum RDLG2C-RRD1); note "  rule after: $R"
verdict "C12 friday only" "of=[{wd=5(Fri)}]" "$R"

# =====================================================================
cell "C13 add-repeating (the clone -> trash -> promote composite)"
warm
OUTP=$(G todo add-repeating "'RDLG2C-ADD'" --frequency weekly --interval 1 --weekdays tuesday --when 2026-07-07 --dangerously-drive-gui --json)
echo "$OUTP" > "$OUT/c13.log"; note "  $(echo "$OUTP" | tail -4)"
R=$(rsum RDLG2C-ADD); note "  rule: $R"
gt "SELECT uuid, title, status, trashed, startDate, rt1_recurrenceRule IS NOT NULL AS tmpl FROM TMTask WHERE title='RDLG2C-ADD'" | sed 's/^/    /' | tee -a "$REPORT"
verdict "C13 tuesday rule" "wd=2(Tue)" "$R"

# =====================================================================
cell "C14 CENSUS — does the larger-x weekday row button REMOVE a row?"
warm
U=$(mktodo RDLG2C-MINUS)
lab_ssh "$IP" "open -g 'things:///show?id=$U'; sleep 3" </dev/null
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
  click menu item "weekly" of menu 1 of p
  delay 1.5
  set g to group 1 of sh
  -- grow to 3 rows by pressing the SMALLER-x button twice
  repeat 2 times
    set nb to (count of buttons of g)
    set bestI to 0
    set bestX to 1000000
    repeat with i from 1 to nb
      set p to position of button i of g
      set px to item 1 of p
      if px < bestX then
        set bestX to px
        set bestI to i
      end if
    end repeat
    click button bestI of g
    delay 0.6
  end repeat
  set rowsBefore to (count of pop up buttons of g)
  -- now press the LARGER-x button of the first row
  set nb to (count of buttons of g)
  set worstI to 0
  set worstX to -1
  repeat with i from 1 to nb
    set p to position of button i of g
    set px to item 1 of p
    if px > worstX then
      set worstX to px
      set worstI to i
    end if
  end repeat
  click button worstI of g
  delay 1
  set rowsAfter to (count of pop up buttons of g)
  return "group pop-ups before=" & rowsBefore & " after=" & rowsAfter & " (fewer = the larger-x button REMOVES a row)"
end tell' | sed 's/^/    /' | tee -a "$REPORT"
esc; esc

# =====================================================================
cell "C15 CENSUS — File ▸ New Repeating To-Do, end to end with a typed title"
warm
BEFORE=$(gq "SELECT COUNT(*) FROM TMTask")
axq 'tell application "System Events" to tell process "Things3" to click menu item "New Repeating To-Do" of menu "File" of menu bar 1' >/dev/null
lab_ssh "$IP" 'sleep 4' </dev/null
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
  click button "OK" of sh
  delay 2
  return "drove daily + OK"
end tell' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 4; osascript -e '\''tell application "System Events" to keystroke "RDLG2C-NEWREP"'\''; sleep 2; osascript -e '\''tell application "System Events" to key code 36'\''; sleep 4' </dev/null
note "  TMTask rows: before=$BEFORE after=$(gq "SELECT COUNT(*) FROM TMTask")"
note "  rows created by the flow:"
gt "SELECT uuid, title, type, status, trashed, start, startDate, rt1_recurrenceRule IS NOT NULL AS tmpl, rt1_repeatingTemplate IS NOT NULL AS isinst FROM TMTask ORDER BY creationDate DESC LIMIT 4" | sed 's/^/    /' | tee -a "$REPORT"
note "  rule of the new template: $(rsum RDLG2C-NEWREP)"
esc; esc

# =====================================================================
cell "C16 CENSUS — Make Exception chooser, second attempt (press the When picker's filtered row)"
warm
TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
INST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$TMPL' AND trashed=0 AND status=0 ORDER BY creationDate DESC LIMIT 1")
note "  instance=$INST startDate before=$(gq "SELECT startDate FROM TMTask WHERE uuid='$INST'")"
lab_ssh "$IP" "open -g 'things:///show?id=$INST'; sleep 3" </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
axq 'tell application "System Events" to tell process "Things3" to click menu item "When…" of menu "Items" of menu bar 1' >/dev/null
lab_ssh "$IP" 'sleep 3; osascript -e '\''tell application "System Events" to keystroke "tomorrow"'\''; sleep 2' </dev/null
axq 'tell application "System Events" to tell process "Things3"
  set theWin to missing value
  repeat with w in windows
    try
      if ((value of attribute "AXIdentifier" of w) as text) starts with "WhenPopUpDialog-" then set theWin to w
    end try
  end repeat
  if theWin is missing value then return "no When picker window"
  repeat with e in (entire contents of theWin)
    try
      if ((description of e) as text) is "Tomorrow" then
        perform action "AXPress" of e
        delay 2
        return "pressed the Tomorrow row"
      end if
    end try
  end repeat
  return "no Tomorrow row found"
end tell' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 3' </dev/null
sheetdump "c16-after-press"
note "  AX containers after the press: $(grep -cE '^=== ' "$OUT/ax/c16-after-press.txt")"
grep -E "^=== |AXSheet|Exception|Update Rule|ttl=" "$OUT/ax/c16-after-press.txt" | head -25 | sed 's/^/    /' | tee -a "$REPORT"
note "  instance startDate after=$(gq "SELECT startDate FROM TMTask WHERE uuid='$INST'")"
esc; esc

note ""; note "###### RDLG2c CERTIFICATION SUMMARY: PASS=$PASS FAIL=$FAIL ######"
note "artifacts in $OUT"
