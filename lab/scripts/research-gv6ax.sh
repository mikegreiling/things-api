#!/bin/bash
# GV6AX — AX census of the surfaces our ui-vector recipes address, taken
# IDENTICALLY on two goldens so the trees can be diffed (GV6, Things 3.25).
#
# 3.25 is the touch-input release: "roomier menus and dialogs when opened via
# touch", sidebar resizing, larger tap targets. None of it is in the sdef. This
# driver records what the recipes depend on — every menu's item titles (and
# submenus), the main window at launch, the Repeat dialog in both its sheet and
# its detached form, the Reschedule… dialog on a template, and a project view
# carrying headings (the heading row's "More." ellipsis button is what
# move-heading-to-project and dissolve-heading click) — so a 3.24 → 3.25 diff
# names any renamed item, new element or moved control even where every drive
# still passes. It changes nothing and drives no shipped operation.
#
# METHOD: ONE disposable clone of $GOLDEN (direct arm; the AXVM1 grant lets the
# ssh shell read AX). Airgap, clock pinned 2026-07-05 12:00 BEFORE Things
# launches. Fixtures fully synthetic (GV6AX-* titles) plus the golden's own
# synthetic LAB-* seed. Teardown on EXIT.
#
#   GOLDEN=things-lab-golden-v5 bash lab/scripts/research-gv6ax.sh
#   GOLDEN=things-lab-golden-v6 bash lab/scripts/research-gv6ax.sh
#
# Output: lab/artifacts/gv6ax-<golden>/ (ax/*.txt, report.txt). Compare two runs
# with `diff -r` after stripping the `@[x,y wxh]` frames, then diff the frames.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:?set GOLDEN to the golden to census}"
VM="gv6ax-${GOLDEN#things-lab-golden-}-$(date +%H%M%S)"
OUT="lab/artifacts/gv6ax-${GOLDEN#things-lab-golden-}"; rm -rf "$OUT"; mkdir -p "$OUT/ax"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[gv6ax] $*" | tee -a "$REPORT"; }

FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB"
[ "${FREEGB:-0}" -lt 10 ] && { note "FATAL: <10GB free. Abort."; exit 1; }

note "cloning $GOLDEN -> $VM"
tart clone "$GOLDEN" "$VM"
cleanup() {
  note "teardown: stop+delete $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: no SSH"; exit 1; }
note "ssh up at $IP"

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
note "airgap: $AG"
[ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"

lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 -noheader -list "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }

# The RDLG1 full-app AX tree dumper (every window + sheet; role / subrole /
# title / desc / value / identifier / frame), unchanged.
lab_ssh "$IP" 'cat > ~/labh/axtree.jxa' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices')
function pidOf(n){return Application('System Events').processes.byName(n).unixId()}
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function sv(el,n){var v=attr(el,n);try{return v?String(v.js):''}catch(e){return ''}}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
function frame(el){var p=attr(el,'AXPosition'),z=attr(el,'AXSize');function d(x){if(!x)return null;return ObjC.castRefToObject($.CFCopyDescription(x)).js}
  var pp=d(p),zz=d(z);var mp=pp&&pp.match(/x:([-0-9.]+) y:([-0-9.]+)/);var mz=zz&&zz.match(/w:([-0-9.]+) h:([-0-9.]+)/)
  return {x:mp?+mp[1]:null,y:mp?+mp[2]:null,w:mz?+mz[1]:null,h:mz?+mz[2]:null}}
function appEl(){return $.AXUIElementCreateApplication(pidOf('Things3'))}
function line(el,d,ix){
  var p=['['+ix+'] role='+sv(el,'AXRole')]
  var sub=sv(el,'AXSubrole'); if(sub)p.push('sub='+sub)
  var t=sv(el,'AXTitle'); if(t)p.push('ttl='+t)
  var de=sv(el,'AXDescription'); if(de)p.push('desc='+de)
  var rd=sv(el,'AXRoleDescription'); if(rd)p.push('rdesc='+rd)
  var v=sv(el,'AXValue'); if(v)p.push('val='+String(v).slice(0,80))
  var ph=sv(el,'AXPlaceholderValue'); if(ph)p.push('ph='+ph)
  var hp=sv(el,'AXHelp'); if(hp)p.push('help='+hp)
  var id=sv(el,'AXIdentifier'); if(id)p.push('id='+id)
  var en=sv(el,'AXEnabled'); if(en==='false')p.push('DISABLED')
  var f=frame(el); if(f.x!==null)p.push('@['+f.x+','+f.y+' '+f.w+'x'+f.h+']')
  return Array(d+1).join('  ')+p.join(' | ')
}
function walk(el,d,acc,ix){acc.push(line(el,d,ix)); if(d>20)return acc; var ch=kids(el); for(var i=0;i<ch.length;i++)walk(ch[i],d+1,acc,i+1); return acc}
function run(){
  var app=appEl(); var ws=kids(app); var acc=['=== APP TREE (windows='+ws.length+') ===']
  for(var i=0;i<ws.length;i++){acc.push('--- window '+(i+1)+' role='+sv(ws[i],'AXRole')+' sub='+sv(ws[i],'AXSubrole')+' ttl='+sv(ws[i],'AXTitle')+' ---'); walk(ws[i],0,acc,i+1)}
  return acc.join('\n')
}
EOF
axdump() { lab_ssh "$IP" 'osascript -l JavaScript ~/labh/axtree.jxa' </dev/null > "$OUT/ax/$1.txt" 2>&1; note "  ax dump $1 ($(wc -l <"$OUT/ax/$1.txt"|tr -d ' ') lines)"; }

# Every item of one menu, with enabled state and any submenu's item titles.
lab_ssh "$IP" 'cat > ~/labh/menudump.scpt' <<'EOF'
on run argv
  set m to item 1 of argv
  tell application "System Events" to tell process "Things3"
    set out to "== menu " & m & " =="
    try
      repeat with mi in menu items of menu m of menu bar 1
        set nm to name of mi
        if nm is missing value then set nm to "(separator)"
        set en to enabled of mi
        set sub to ""
        try
          set subs to name of every menu item of menu 1 of mi
          set AppleScript's text item delimiters to " / "
          set sub to "  {sub: " & (subs as text) & "}"
          set AppleScript's text item delimiters to ""
        end try
        set out to out & linefeed & "  - " & nm & " enabled=" & en & sub
      end repeat
    on error e
      set out to out & linefeed & "  ERROR " & e
    end try
    return out
  end tell
end run
EOF
menus() {
  local tag="$1" names m
  names=$(lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to get name of every menu of menu bar 1'\''' </dev/null)
  echo "menu bar: $names" > "$OUT/ax/menus-$tag.txt"
  IFS=',' read -r -a arr <<<"$names"
  for m in "${arr[@]}"; do
    m="${m# }"
    lab_ssh "$IP" "osascript ~/labh/menudump.scpt $(printf '%q' "$m")" </dev/null >> "$OUT/ax/menus-$tag.txt" 2>&1
  done
  note "  menus ($tag): $names"
}
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
warm() {
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; true' </dev/null
}
esc() { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null; }
reveal() { lab_ssh "$IP" "open -g 'things:///show?id=$1'; sleep 3" </dev/null; }
front_things() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null; }

TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
MVER=$(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)
note "env: Things $TVER ($TBLD) / macOS $MVER / clock 2026-07-05 / golden $GOLDEN"

note "### 0: launch — main window + every menu (nothing selected)"
warm
front_things
axdump "00-launch"
menus "00-launch"

note "### 1: a plain to-do selected — Items menu + Repeat dialog (sheet form)"
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
lab_ssh "$IP" "open -g 'things:///add?title=GV6AX-FRESH&auth-token=$TOKEN'; sleep 4" </dev/null
A=$(gq "SELECT uuid FROM TMTask WHERE title='GV6AX-FRESH' AND trashed=0 LIMIT 1")
note "  fresh to-do uuid=$A"
reveal "$A"
front_things
menus "01-todo-selected"
axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
lab_ssh "$IP" 'sleep 4' </dev/null
axdump "01-repeat-sheet"
axq 'tell application "System Events" to tell process "Things3" to get {name, subrole, size} of every window' | sed 's/^/  windows: /' | tee -a "$REPORT"
esc; esc

note "### 2: the same dialog with Things BACKGROUNDED (detached form)"
reveal "$A"
lab_ssh "$IP" 'osascript -e '\''tell application "Finder" to activate'\''; sleep 2' </dev/null
axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
lab_ssh "$IP" 'sleep 4' </dev/null
axdump "02-repeat-detached"
esc; esc

note "### 3: the seeded daily template selected — Reschedule… dialog"
TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
note "  template uuid=$TMPL"
warm
reveal "$TMPL"
front_things
menus "03-template-selected"
axq 'tell application "System Events" to tell process "Things3" to click menu item "Reschedule…" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' >/dev/null
lab_ssh "$IP" 'sleep 4' </dev/null
axdump "03-reschedule-dialog"
esc; esc

note "### 4: a project view carrying headings (the heading-row ellipsis)"
HPROJ=$(gq "SELECT p.uuid FROM TMTask h JOIN TMTask p ON h.project=p.uuid WHERE h.type=2 AND h.trashed=0 AND p.trashed=0 LIMIT 1")
note "  project with headings uuid=$HPROJ"
if [ -n "$HPROJ" ]; then
  warm
  reveal "$HPROJ"
  front_things
  axdump "04-project-with-headings"
fi

note "### 5: settled launch state again (sidebar after the session)"
axdump "05-final"
note "DONE"
