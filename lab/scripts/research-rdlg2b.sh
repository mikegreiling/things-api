#!/bin/bash
# RDLG2b — the 3.23 repeat SURFACES that are not the dialog (RDLG1 §6/§5 open cells)
# plus two register-walk cells:
#
#   B1  the Make Exception / Update Rule chooser — provoke it from every reachable
#       vector on a fixed-schedule INSTANCE; honest negatives per vector;
#   B2  `File ▸ New Repeating To-Do` — census the flow end to end and read the DB
#       shape it lands (does it obsolete the clone→trash→promote composite?);
#   B3  `Items ▸ Repeat ▸ Create Next Copy` — DB delta (cursor, new instance);
#   B4  early-complete of an instance (the 3.23 checkbox) — DB delta;
#   B5  oddities §9ff DOUBLE-SPAWN re-probe under 3.23 (clock advance);
#   B6  A01B — the at-locus create regression vs our vector's two-step shape.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (Things 3.23, DB v27; the
# golden is never booted). Airgap, clock pinned 2026-07-05 (B5 advances it at the
# END). Fixtures fully synthetic (RDLG2B-*). Teardown on EXIT (KEEP=1 keeps it).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-rdlg2b-lab}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[rdlg2b] $*" | tee -a "$REPORT"; }
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
gt() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }

# rule summary (decodes the rt1_recurrenceRule plist) — same helper DBLSPAWN1 used
lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationStartDate, rt1_instanceCreationCount, deadline, startDate FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row: print("NO-ROW"); sys.exit(0)
if row[0] is None: print("NO-RULE next=%s icStart=%s icCount=%s deadline=%s startDate=%s"%(dpk(row[1]),dpk(row[2]),row[3],dpk(row[4]),dpk(row[5]))); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s of=[%s] next=%s icStart=%s icCount=%s deadline=%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),",".join(offs),
    dpk(row[1]),dpk(row[2]),row[3],dpk(row[4])))
EOF
rsum() { lab_ssh "$IP" "python3 ~/labh/rsum.py $1" </dev/null 2>&1; }

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
alive() { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null; }
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

TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
note "env: Things $TVER ($TBLD) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / golden $GOLDEN"

SERIES_SQL="SELECT uuid, title, type, status, trashed, start, startDate, deadline, rt1_recurrenceRule IS NOT NULL AS tmpl, rt1_repeatingTemplate AS ftmpl, rt1_instanceCreationStartDate AS icStart, rt1_instanceCreationCount AS icCount, rt1_nextInstanceStartDate AS nextCache FROM TMTask WHERE title LIKE '%s' ORDER BY creationDate"

warm

# =====================================================================
note ""; note "###### B1: the Make Exception / Update Rule chooser hunt ######"
TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
INST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$TMPL' AND trashed=0 AND status=0 ORDER BY creationDate DESC LIMIT 1")
ITITLE=$(gq "SELECT title FROM TMTask WHERE uuid='$INST'")
note "  template=$TMPL  instance=$INST title='$ITITLE'"
note "  template rule: $(rsum "$TMPL")"
note "  instance before: $(rsum "$INST")"

if [ -z "$INST" ]; then
  note "  NO instance — B1 SKIPPED"
else
  # -- vector 1: the When picker, committing by PRESSING the filtered row -------
  note ""; note "  --- vector 1: Items ▸ When… → type 'tomorrow' → AXPress the filtered row ---"
  select_item "$INST" "$ITITLE" || note "  WARN: selection never confirmed"
  axq 'tell application "System Events" to tell process "Things3" to click menu item "When…" of menu "Items" of menu bar 1' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 3' </dev/null
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to keystroke "tomorrow"'\''; sleep 2' </dev/null
  sheetdump "b1-when-typed"
  note "    rows offered after the filter:"
  axq 'tell application "System Events" to tell process "Things3"
    set w to (first window whose value of attribute "AXIdentifier" starts with "WhenPopUpDialog-")
    set out to ""
    repeat with e in (entire contents of w)
      try
        set d to (description of e) as text
        if d is not "" then set out to out & "      " & (role of e) & " desc=" & d & linefeed
      end try
    end repeat
    return out
  end tell' | tee -a "$REPORT"
  note "    pressing the filtered row (AXPress on the first non-empty-desc AXUnknown that is not When/Clear):"
  axq 'tell application "System Events" to tell process "Things3"
    set w to (first window whose value of attribute "AXIdentifier" starts with "WhenPopUpDialog-")
    repeat with e in (entire contents of w)
      try
        set d to (description of e) as text
        if d is "Tomorrow" then
          perform action "AXPress" of e
          delay 3
          return "pressed Tomorrow row"
        end if
      end try
    end repeat
    return "no Tomorrow row found to press"
  end tell' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 3' </dev/null
  sheetdump "b1-after-press"
  note "    CHOOSER present? (any sheet / new detached window):"
  grep -cE "^=== " "$OUT/ax/b1-after-press.txt" | sed 's/^/      containers: /' | tee -a "$REPORT"
  showdump "b1-after-press"
  note "    instance DB after: $(rsum "$INST")"
  esc; esc

  # -- vector 2: AppleScript `schedule` on the instance ------------------------
  note ""; note "  --- vector 2: AppleScript schedule on the instance ---"
  axq "tell application \"Things3\" to schedule to do id \"$INST\" for (date \"July 9, 2026\")" | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 3' </dev/null
  sheetdump "b1-after-as-schedule"
  note "    instance DB after: $(rsum "$INST")"
  note "    app alive: $(alive)"
  grep -cE "^=== " "$OUT/ax/b1-after-as-schedule.txt" | sed 's/^/      AX containers: /' | tee -a "$REPORT"

  # -- vector 3: URL-scheme update on the instance -----------------------------
  # oddities §1: a URL `when=` update on a REPEATING to-do crashed 3.22.11. This
  # is an INSTANCE (not the template) — run it LAST in the cell and re-warm.
  note ""; note "  --- vector 3: URL-scheme update?when= on the instance (crash-risk, §1) ---"
  lab_ssh "$IP" "open -g 'things:///update?id=$INST&when=2026-07-10&auth-token=$TOKEN'; sleep 5" </dev/null
  note "    app alive after the URL update: $(alive)"
  sheetdump "b1-after-url-when"
  note "    instance DB after: $(rsum "$INST")"
  grep -cE "^=== " "$OUT/ax/b1-after-url-when.txt" | sed 's/^/      AX containers: /' | tee -a "$REPORT"
  esc; esc
fi

# -- vector 4 (drag) is NOT attemptable in this rig: a synthetic HID drag needs a
#    real framebuffer, and the headless clone's frame resolution has failed every
#    prior attempt (SRCFATE umd cells). Recorded as an honest not-attempted.
note "  --- vector 4 (in-GUI drag onto a calendar date): NOT ATTEMPTED — needs a framebuffer/HID rig ---"

# =====================================================================
note ""; note "###### B2: File ▸ New Repeating To-Do ######"
warm
note "  File menu items:"
axq 'tell application "System Events" to tell process "Things3" to return (name of every menu item of menu "File" of menu bar 1) as text' | sed 's/^/    /' | tee -a "$REPORT"
BEFORE_ROWS=$(gq "SELECT COUNT(*) FROM TMTask")
note "  TMTask rows before: $BEFORE_ROWS"
note "  --- clicking File ▸ New Repeating To-Do ---"
axq 'tell application "System Events" to tell process "Things3" to click menu item "New Repeating To-Do" of menu "File" of menu bar 1' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 4' </dev/null
sheetdump "b2-new-repeating-open"
showdump "b2-new-repeating-open"
note "  TMTask rows immediately after the menu click: $(gq "SELECT COUNT(*) FROM TMTask")"
note "  new/changed rows in the last minute:"
gt "SELECT uuid, title, type, status, trashed, start, startDate, rt1_recurrenceRule IS NOT NULL AS tmpl, rt1_repeatingTemplate IS NOT NULL AS isinst FROM TMTask ORDER BY creationDate DESC LIMIT 5" | sed 's/^/    /' | tee -a "$REPORT"
note "  --- typing a title, then driving the dialog if one is open ---"
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to keystroke "RDLG2B-NEWREP"'\''; sleep 2' </dev/null
sheetdump "b2-after-typing"
# If a Repeat dialog (sheet with a frequency pop-up) is present, set daily + OK.
axq 'tell application "System Events" to tell process "Things3"
  set sh to missing value
  try
    set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
  end try
  if sh is missing value then return "no sheet present"
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
lab_ssh "$IP" 'sleep 4' </dev/null
# The row may need a Return to commit if it was an inline new-row edit.
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 36'\''; sleep 4' </dev/null
sheetdump "b2-after-commit"
note "  DB shape after the New Repeating To-Do flow (the UIC8 comparison):"
gt "$(printf "$SERIES_SQL" 'RDLG2B-NEWREP%')" | sed 's/^/    /' | tee -a "$REPORT"
NEWREPT=$(gq "SELECT uuid FROM TMTask WHERE title LIKE 'RDLG2B-NEWREP%' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
note "  template rule: $(rsum "$NEWREPT")"
note "  TMTask rows after: $(gq "SELECT COUNT(*) FROM TMTask") (before: $BEFORE_ROWS)"
esc; esc

# =====================================================================
note ""; note "###### B3: Items ▸ Repeat ▸ Create Next Copy ######"
warm
CN_TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
note "  template=$CN_TMPL"
note "  BEFORE: $(rsum "$CN_TMPL")"
note "  series rows BEFORE:"
gt "SELECT uuid, title, status, trashed, startDate, rt1_repeatingTemplate IS NOT NULL AS isinst FROM TMTask WHERE uuid='$CN_TMPL' OR rt1_repeatingTemplate='$CN_TMPL' ORDER BY creationDate" | sed 's/^/    /' | tee -a "$REPORT"
select_item "$CN_TMPL" "LAB-REPEAT-DAILY" || note "  WARN: selection never confirmed"
axq 'tell application "System Events" to tell process "Things3" to click menu item "Create Next Copy" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 5' </dev/null
note "  AFTER: $(rsum "$CN_TMPL")"
note "  series rows AFTER:"
gt "SELECT uuid, title, status, trashed, startDate, rt1_repeatingTemplate IS NOT NULL AS isinst FROM TMTask WHERE uuid='$CN_TMPL' OR rt1_repeatingTemplate='$CN_TMPL' ORDER BY creationDate" | sed 's/^/    /' | tee -a "$REPORT"
note "  app alive: $(alive)"
esc; esc

# =====================================================================
note ""; note "###### B4: early-complete of an instance (the 3.23 checkbox semantics) ######"
warm
EC_TMPL="$CN_TMPL"
EC_INST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$EC_TMPL' AND trashed=0 AND status=0 ORDER BY creationDate DESC LIMIT 1")
EC_TITLE=$(gq "SELECT title FROM TMTask WHERE uuid='$EC_INST'")
note "  instance=$EC_INST title='$EC_TITLE'"
note "  BEFORE template: $(rsum "$EC_TMPL")"
gt "SELECT uuid, title, status, trashed, startDate FROM TMTask WHERE uuid='$EC_TMPL' OR rt1_repeatingTemplate='$EC_TMPL' ORDER BY creationDate" | sed 's/^/    /' | tee -a "$REPORT"
if [ -n "$EC_INST" ]; then
  axq "tell application \"Things3\" to set status of to do id \"$EC_INST\" to completed" | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 6' </dev/null
  note "  AFTER template: $(rsum "$EC_TMPL")"
  gt "SELECT uuid, title, status, trashed, startDate, stopDate IS NOT NULL AS stopped FROM TMTask WHERE uuid='$EC_TMPL' OR rt1_repeatingTemplate='$EC_TMPL' ORDER BY creationDate" | sed 's/^/    /' | tee -a "$REPORT"
fi

# =====================================================================
note ""; note "###### B6: A01B — at-locus create vs the two-step create+schedule ######"
warm
note "  --- one-step: make new to do at beginning of list \"Today\" (the a-suite A01B shape) ---"
axq 'tell application "Things3" to make new to do at beginning of list "Today" with properties {name:"RDLG2B-A01B-ONE"}' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 3' </dev/null
gt "SELECT title, start, startDate, startBucket FROM TMTask WHERE title='RDLG2B-A01B-ONE'" | sed 's/^/    /' | tee -a "$REPORT"
note "  --- two-step: create, then schedule (our applescript vector's shape) ---"
axq 'tell application "Things3"
  set t to make new to do with properties {name:"RDLG2B-A01B-TWO"}
  schedule t for (current date)
end tell' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 3' </dev/null
gt "SELECT title, start, startDate, startBucket FROM TMTask WHERE title='RDLG2B-A01B-TWO'" | sed 's/^/    /' | tee -a "$REPORT"
note "  (today packed = $(gq "SELECT startDate FROM TMTask WHERE title='RDLG2B-A01B-TWO'"))"

# =====================================================================
note ""; note "###### B5: oddities §9ff double-spawn re-probe under 3.23 (ADVANCES THE CLOCK) ######"
warm
lab_ssh "$IP" "open -g 'things:///add?title=RDLG2B-DBL&when=2026-07-06&deadline=2026-07-20&auth-token=$TOKEN'; sleep 5" </dev/null
DBLU=$(gq "SELECT uuid FROM TMTask WHERE title='RDLG2B-DBL' AND trashed=0 LIMIT 1")
note "  seed uuid=$DBLU: $(rsum "$DBLU")"
select_item "$DBLU" "RDLG2B-DBL" || note "  WARN: selection never confirmed"
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
  click menu item "yearly" of menu 1 of p
  delay 1.5
  click button "OK" of sh
  delay 2
  return "drove yearly + OK"
end tell' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 6' </dev/null
note "  series right after the promote (pinned clock 2026-07-05):"
gt "$(printf "$SERIES_SQL" 'RDLG2B-DBL%')" | sed 's/^/    /' | tee -a "$REPORT"
DBLT=$(gq "SELECT uuid FROM TMTask WHERE title='RDLG2B-DBL' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
note "  template: $(rsum "$DBLT")"
note "  --- advancing the guest clock to 2026-07-06 ---"
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 4; sudo date 070612002026 >/dev/null; date' </dev/null | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'open -a Things3; sleep 25; true' </dev/null
note "  series after the date arrives (DOUBLE-SPAWN check — 2 rows dated 2026-07-06 = still broken):"
gt "$(printf "$SERIES_SQL" 'RDLG2B-DBL%')" | sed 's/^/    /' | tee -a "$REPORT"
note "  re-settle +15s:"
lab_ssh "$IP" 'sleep 15' </dev/null
gt "$(printf "$SERIES_SQL" 'RDLG2B-DBL%')" | sed 's/^/    /' | tee -a "$REPORT"
note "  template after: $(rsum "$DBLT")"
INSTCOUNT=$(gq "SELECT COUNT(*) FROM TMTask WHERE rt1_repeatingTemplate='$DBLT' AND trashed=0")
note "  VERDICT INPUT: untrashed instances of the series = $INSTCOUNT (2 = §9ff still reproduces; 1 = FIXED)"

note ""; note "RDLG2b surfaces census complete — artifacts in $OUT"
