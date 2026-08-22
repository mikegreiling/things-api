#!/bin/bash
# RDLG1b — DEEP census of the Things 3.23 repeat dialog: the per-frequency
# control layout (the input the recipe rewrite actually needs), the frequency
# and Ends vocabularies, and the new Make Exception / Update Rule chooser.
#
# Phase-1 (research-rdlg1.sh) established that the dialog is STILL an AXSheet on
# the standard window and that its default mode is now "after completion".
# This pass drives the frequency pop-up through every mode and dumps the sheet
# subtree per mode, so `DIALOG_*` indices in src/write/vectors/ui-recipes.ts can
# be re-derived rather than guessed.
#
# METHOD: ONE disposable clone `rdlg1b-lab` of things-lab-golden-v4 (Things 3.23,
# DB v27; golden untouched). Airgap, clock pinned 2026-07-05, AX grant asserted.
# Fixtures fully synthetic. Teardown on EXIT (KEEP=1 to leave the clone up).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="rdlg1b-lab"
OUT="lab/artifacts/rdlg1b-lab"; mkdir -p "$OUT/ax"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[rdlg1b] $*" | tee -a "$REPORT"; }
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

# sheet-only AX dumper (fast): dumps every AXSheet of every window, plus any
# detached AXUnknown window bigger than the 40x40 utility stub, plus popovers.
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
  var v=sv(el,'AXValue'); if(v)p.push('val='+String(v).slice(0,80))
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
    if(sub==='AXUnknown' && !(f.w===40&&f.h===40)){acc.push('=== DETACHED WINDOW '+(i+1)+' sub='+sub+' @['+f.x+','+f.y+' '+f.w+'x'+f.h+'] ==='); walk(w,0,acc,i+1)}
    var sh=attr(w,'AXChildren'); if(!sh) continue
    var ch=kids(w)
    for(var j=0;j<ch.length;j++){
      var r=sv(ch[j],'AXRole')
      if(r==='AXSheet'||r==='AXPopover'){acc.push('=== '+r+' (child '+(j+1)+' of window '+(i+1)+' "'+sv(w,'AXTitle')+'") ==='); walk(ch[j],0,acc,j+1)}
    }
  }
  if(!acc.length) acc.push('(no sheet / popover / detached dialog present)')
  return acc.join('\n')}
EOF
sheetdump() { lab_ssh "$IP" 'osascript -l JavaScript ~/labh/sheet.jxa' </dev/null > "$OUT/ax/$1.txt" 2>&1; note "  sheet dump $1 ($(wc -l <"$OUT/ax/$1.txt"|tr -d ' ') lines)"; }

axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
esc() { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }

# reveal + ASSERT the selection actually landed (the phase-1 template cell failed
# silently: the reveal did not select, so every Items item stayed disabled)
select_item() {
  local uuid="$1" want="$2" i sel
  for i in 1 2 3 4 5; do
    lab_ssh "$IP" "open -g 'things:///show?id=$uuid'; sleep 3" </dev/null
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
    # `selected to do` is an element of the APPLICATION, not of a window
    # (Things.sdef: <element type="selected to do"> on the application class).
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

warm

# =====================================================================
note ""; note "###### RDLG1b-1: frequency vocabulary + per-mode sheet layout ######"
lab_ssh "$IP" "open -g 'things:///add?title=RDLGB-FRESH&auth-token=$TOKEN'; sleep 4" </dev/null
U=$(gq "SELECT uuid FROM TMTask WHERE title='RDLGB-FRESH' AND trashed=0 LIMIT 1")
note "  fresh to-do uuid=$U"
select_item "$U" "RDLGB-FRESH" || note "  WARN: selection never confirmed"

axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
lab_ssh "$IP" 'sleep 3' </dev/null
sheetdump "10-dialog-default"

note "  frequency pop-up vocabulary:"
axq 'tell application "System Events" to tell process "Things3"
  set p to pop up button 1 of sheet 1 of (first window whose subrole is "AXStandardWindow")
  click p
  delay 1
  set nms to name of every menu item of menu 1 of p
  key code 53
  return nms as text
end tell' | tee -a "$REPORT" | tee "$OUT/ax/freq-vocabulary.txt" >/dev/null
cat "$OUT/ax/freq-vocabulary.txt" | sed 's/^/    /' | tee -a "$REPORT"

for mode in "after completion" daily weekly monthly yearly; do
  note "  --- selecting frequency = $mode ---"
  axq "tell application \"System Events\" to tell process \"Things3\"
    set p to pop up button 1 of sheet 1 of (first window whose subrole is \"AXStandardWindow\")
    click p
    delay 1
    try
      click menu item \"$mode\" of menu 1 of p
    on error e
      key code 53
      return \"NO-SUCH-ITEM: \" & e
    end try
    delay 1
    return value of p
  end tell" | sed 's/^/    -> /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 2' </dev/null
  sheetdump "11-mode-$(echo "$mode" | tr ' ' '-')"
  # the group's pop-up vocabularies in this mode
  axq 'tell application "System Events" to tell process "Things3"
    set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
    set g to group 1 of sh
    set out to "group pop-ups: " & (count of pop up buttons of g) & " | fields: " & (count of text fields of g) & " | buttons: " & (count of buttons of g) & " | checkboxes: " & (count of checkboxes of g)
    repeat with i from 1 to (count of pop up buttons of g)
      set out to out & linefeed & "    popup " & i & " value=" & (value of pop up button i of g)
    end repeat
    set out to out & linefeed & "  sheet-level: popups=" & (count of pop up buttons of sh) & " fields=" & (count of text fields of sh) & " checkboxes=" & (count of checkboxes of sh) & " buttons=" & (count of buttons of sh)
    return out
  end tell' | sed 's/^/    /' | tee -a "$REPORT"
done

note "  --- Ends pop-up vocabulary (in weekly mode) ---"
axq 'tell application "System Events" to tell process "Things3"
  set p to pop up button 1 of sheet 1 of (first window whose subrole is "AXStandardWindow")
  click p
  delay 1
  click menu item "weekly" of menu 1 of p
  delay 1
end tell' >/dev/null
axq 'tell application "System Events" to tell process "Things3"
  set g to group 1 of sheet 1 of (first window whose subrole is "AXStandardWindow")
  set out to ""
  repeat with i from 1 to (count of pop up buttons of g)
    set pb to pop up button i of g
    click pb
    delay 1
    try
      set out to out & "popup " & i & " (" & (value of pb) & "): " & ((name of every menu item of menu 1 of pb) as text) & linefeed
    end try
    key code 53
    delay 1
  end repeat
  return out
end tell' | tee -a "$REPORT" > "$OUT/ax/group-popup-vocabularies.txt"
sheetdump "12-weekly-expanded"
esc; esc

# =====================================================================
note ""; note "###### RDLG1b-2: template selection + the Repeat SUBMENU ######"
warm
TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
note "  template uuid=$TMPL"
select_item "$TMPL" "LAB-REPEAT-DAILY" || note "  WARN: template selection never confirmed"
axq 'tell application "System Events" to tell process "Things3"
  set out to ""
  repeat with mi in menu items of menu "Items" of menu bar 1
    set nm to name of mi
    if nm is missing value then set nm to "(separator)"
    set out to out & "  - " & nm & " enabled=" & (enabled of mi)
    try
      set out to out & "  {sub: " & ((name of every menu item of menu 1 of mi) as text) & "}"
    end try
    set out to out & linefeed
  end repeat
  return out
end tell' | tee -a "$REPORT" > "$OUT/ax/menu-items-template.txt"
cat "$OUT/ax/menu-items-template.txt" | sed 's/^/    /' | tee -a "$REPORT" >/dev/null
grep -iE "repeat|copy|pause|resume|stop|next" "$OUT/ax/menu-items-template.txt" | sed 's/^/    /' | tee -a "$REPORT"

note "  --- Reschedule… (pre-populated dialog) ---"
axq 'tell application "System Events" to tell process "Things3" to click menu item "Reschedule…" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 4' </dev/null
sheetdump "20-reschedule-prepopulated"
esc; esc

# =====================================================================
note ""; note "###### RDLG1b-3: the Make Exception / Update Rule chooser ######"
warm
INST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$TMPL' AND trashed=0 AND status=0 ORDER BY creationDate DESC LIMIT 1")
ITITLE=$(gq "SELECT title FROM TMTask WHERE uuid='$INST'")
note "  instance uuid=$INST title='$ITITLE'"
if [ -n "$INST" ]; then
  select_item "$INST" "$ITITLE" || note "  WARN: instance selection never confirmed"
  lab_ssh "$IP" 'sleep 1' </dev/null
  axq 'tell application "System Events" to tell process "Things3" to click menu item "When…" of menu "Items" of menu bar 1' | sed 's/^/    /' | tee -a "$REPORT"
  lab_ssh "$IP" 'sleep 3' </dev/null
  sheetdump "30-when-popover"
  # The picker is a DETACHED AXUnknown window with AXIdentifier "WhenPopUpDialog-<uuid>"
  # (RDLG1 phase 1); its search field takes natural language. "7/20/2026" did NOT
  # parse in phase 1, so use a word form.
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to keystroke "tomorrow"'\''; sleep 2' </dev/null
  sheetdump "31-when-typed"
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 36'\''; sleep 5' </dev/null
  sheetdump "32-CHOOSER"
  note "  DB startDate right after the When commit:"
  gq "SELECT startDate, start FROM TMTask WHERE uuid='$INST'" | sed 's/^/    /' | tee -a "$REPORT"
  # Fallback gesture if the When path produced no chooser: Items ▸ Shortcuts ▸ Someday
  if ! grep -qiE "exception|update rule|AXSheet" "$OUT/ax/32-CHOOSER.txt"; then
    note "  no chooser from the When picker — trying Items ▸ Shortcuts ▸ Someday"
    esc
    select_item "$INST" "$ITITLE" || true
    axq 'tell application "System Events" to tell process "Things3" to click menu item "Someday" of menu 1 of menu item "Shortcuts" of menu "Items" of menu bar 1' | sed 's/^/    /' | tee -a "$REPORT"
    lab_ssh "$IP" 'sleep 5' </dev/null
    sheetdump "33-CHOOSER-someday"
  fi
  axq 'tell application "System Events" to tell process "Things3"
    set out to "windows: " & ((name of every window) as text)
    try
      set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
      set out to out & linefeed & "sheet static texts: " & ((value of every static text of sh) as text)
      repeat with b in buttons of sh
        set out to out & linefeed & "  button ttl=" & (name of b) & " id=" & (value of attribute "AXIdentifier" of b)
      end repeat
    on error e
      set out to out & linefeed & "no sheet: " & e
    end try
    return out
  end tell' | tee -a "$REPORT"
  note "  DB truth (instance startDate before Escape):"
  gq "SELECT uuid, startDate, start, rt1_repeatingTemplate IS NOT NULL FROM TMTask WHERE uuid='$INST'" | sed 's/^/    /' | tee -a "$REPORT"
  esc; esc
else
  note "  NO instance found — chooser cell SKIPPED"
fi

# =====================================================================
note ""; note "###### RDLG1b-4: the \"Repeating\" list ######"
warm
axq 'tell application "System Events" to tell process "Things3"
  set out to "sidebar rows:" & linefeed
  try
    set sg to splitter group 1 of (first window whose subrole is "AXStandardWindow")
    repeat with r in rows of outline 1 of scroll area 1 of sg
      try
        set out to out & "  - " & ((value of every static text of r) as text) & linefeed
      end try
    end repeat
  on error e
    set out to out & "  ERR " & e
  end try
  return out
end tell' | tee -a "$REPORT"
for route in repeating logbook; do
  note "  things:///show?id=$route:"
  lab_ssh "$IP" "open -g 'things:///show?id=$route'; sleep 4" </dev/null
  axq 'tell application "System Events" to tell process "Things3" to get name of front window' | sed 's/^/    front window: /' | tee -a "$REPORT"
done
note "  View ▸ Go To ▸ Repeating (the menu route phase 1 found):"
axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeating" of menu 1 of menu item "Go To" of menu "View" of menu bar 1' | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" 'sleep 4' </dev/null
axq 'tell application "System Events" to tell process "Things3" to get name of front window' | sed 's/^/    front window after Go To ▸ Repeating: /' | tee -a "$REPORT"
axq 'tell application "Things3" to get name of front window' | sed 's/^/    Things AppleScript front window: /' | tee -a "$REPORT"
axq 'tell application "System Events" to tell process "Things3"
  set out to ""
  repeat with mi in menu items of menu 1 of menu item "Go To" of menu "View" of menu bar 1
    set nm to name of mi
    if nm is missing value then set nm to "(separator)"
    set out to out & "  - " & nm & "  key=" & (value of attribute "AXMenuItemCmdChar" of mi) & linefeed
  end repeat
  return out
end tell' | tee -a "$REPORT"
lab_ssh "$IP" 'osascript -l JavaScript ~/labh/sheet.jxa' </dev/null > "$OUT/ax/40-repeating-list.txt" 2>&1 || true
axq 'tell application "System Events" to tell process "Things3"
  set t to table 1 of scroll area 1 of (first window whose subrole is "AXStandardWindow")
  return "rows in the Repeating list: " & (count of rows of t)
end tell' | sed 's/^/    /' | tee -a "$REPORT"

note ""; note "###### RDLG1b-5: does the PRODUCTION make-repeating recipe still drive? ######"
npm run build >"$OUT/build.log" 2>&1 || note "  build failed (see build.log)"
if [ -f dist/cli/main.js ]; then
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
  G config set ui-enabled true >/dev/null 2>&1
  warm
  lab_ssh "$IP" "open -g 'things:///add?title=RDLGB-DRIVE&auth-token=$TOKEN'; sleep 4" </dev/null
  DU=$(gq "SELECT uuid FROM TMTask WHERE title='RDLGB-DRIVE' AND trashed=0 LIMIT 1")
  note "  drive target uuid=$DU"
  lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js todo make-repeating $DU --frequency daily --interval 1 --dangerously-drive-gui --json; echo EXIT=\$?" </dev/null > "$OUT/drive-make-repeating.log" 2>&1
  head -60 "$OUT/drive-make-repeating.log" | sed 's/^/    /' | tee -a "$REPORT"
  note "  DB truth: templates titled RDLGB-DRIVE = $(gq "SELECT COUNT(*) FROM TMTask WHERE title='RDLGB-DRIVE' AND rt1_recurrenceRule IS NOT NULL")"
  sheetdump "50-after-production-drive"
  esc; esc
fi
axq 'tell application "System Events" to tell process "Things3"
  set out to ""
  repeat with mn in {"View", "Window", "File"}
    set out to out & "== " & mn & " ==" & linefeed
    repeat with mi in menu items of menu mn of menu bar 1
      set nm to name of mi
      if nm is missing value then set nm to "(separator)"
      set out to out & "  - " & nm & linefeed
    end repeat
  end repeat
  return out
end tell' > "$OUT/ax/menus-view-window-file.txt" 2>&1
grep -iE "repeat" "$OUT/ax/menus-view-window-file.txt" | sed 's/^/    /' | tee -a "$REPORT"

note ""; note "deep census complete — artifacts in $OUT"
