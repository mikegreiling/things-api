#!/bin/bash
# RDLG1 — AX census of the Things 3.23 REDESIGNED repeat surface.
#
# 3.23 shipped a redesigned repeating-to-do dialog plus four GUI-only additions
# (a Make Exception / Update Rule chooser when a fixed-schedule instance is
# moved, a "Create Next Copy" command under Items ▸ Repeat, early completion of
# instances by checkbox, bulk pause/resume/stop, and a "Repeating" list). The
# sdef is byte-identical to 3.22.11, so NONE of it is scriptable — every one of
# our AX repeat recipes (src/write/vectors/ui-recipes.ts) targets the OLD
# dialog and is suspect. This campaign CENSUSES the new surface; it changes no
# recipe and reconciles no expectation.
#
# METHOD: ONE disposable clone `rdlg1-lab` of things-lab-golden-v4 (Things 3.23,
# DB v27; golden untouched). Airgap (default route deleted), clock pinned
# 2026-07-05 12:00 (Sunday) before Things launches, AX grant asserted. Fixtures
# fully synthetic (RDLG1-* titles) plus the golden's own synthetic LAB-* seed.
# Ground truth for any DB claim = read-only guest SQLite. Teardown on EXIT.
#
#   bash lab/scripts/research-rdlg1.sh          # full census, VM destroyed after
#   KEEP=1 bash lab/scripts/research-rdlg1.sh   # leave the clone up
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="rdlg1-lab"
OUT="lab/artifacts/rdlg1-lab"; mkdir -p "$OUT/ax" "$OUT/drive"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[rdlg1] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"

FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB"
[ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free. Abort."; exit 1; }

# self-contained node (rem1/rsim lesson: avoid a homebrew-linked node)
MAIN_WT=$(dirname "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null || true)
NODE_VER=$(awk '/nodejs/{print $2}' "$MAIN_WT/.tool-versions" .tool-versions "$HOME/.tool-versions" 2>/dev/null | head -1 || true)
CANDS=("$HOME/.asdf/installs/nodejs/$NODE_VER/bin")
CANDS+=( $(ls -d "$HOME"/.asdf/installs/nodejs/*/bin 2>/dev/null | sort -t/ -k7 -V -r) )
CANDS+=(/opt/homebrew/bin)
for cand in "${CANDS[@]}"; do
  [ -x "$cand/node" ] || continue
  otool -L "$cand/node" 2>/dev/null | grep -q '/opt/homebrew/' && continue
  export PATH="$cand:$PATH"; break
done
node --version >/dev/null 2>&1 || { note "FATAL: no working node on PATH"; exit 1; }
note "toolchain: node $(node --version) @ $(command -v node)"

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
note "airgap: $AG"
[ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "AX grant=$GRANT (want 2)"
[ "$GRANT" = "2" ] || { note "FATAL: AX grant missing"; exit 1; }

# ---------------- guest helpers ----------------
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# full-app AX tree dumper (every window + sheet; role/subrole/title/desc/value/id/frame)
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

# menu-bar enumerator: every item of one menu (and one named submenu) with enabled state
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
          set sub to "  {sub: " & (subs as text) & "}"
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
menudump() { lab_ssh "$IP" "osascript ~/labh/menudump.scpt $(printf '%q' "$1")" </dev/null | tee -a "$REPORT"; }

ax() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }

note "guest helpers installed (~/labh: gsql.sh axtree.jxa menudump.scpt)"

# ---------------- ship the production bundle ----------------
note "build + ship production bundle"
npm run build >"$OUT/build.log" 2>&1 || { note "FATAL build (see build.log)"; exit 1; }
[ -f dist/cli/main.js ] || { note "FATAL: dist/cli/main.js missing"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
lab_ssh "$IP" '~/things-lab/bin/node --version' </dev/null >/dev/null 2>&1 || { note "FATAL: guest node broken"; exit 1; }
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
drive() {
  local label="$1"; shift
  lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $* ; echo EXIT=\$?" </dev/null > "$OUT/drive/$label.log" 2>&1
  sed "s/^/  [$label] /" "$OUT/drive/$label.log" | head -40 | tee -a "$REPORT"
}
G config set ui-enabled true >/dev/null 2>&1
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
MVER=$(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)
DBV=$(gq "SELECT hex(value) FROM Meta WHERE key='databaseVersion'" | head -1)
note "env: Things $TVER ($TBLD) / macOS $MVER / clock 2026-07-05 / golden $GOLDEN"

warm() {
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; true' </dev/null
}
esc() { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null; }
reveal() { lab_ssh "$IP" "open -g 'things:///show?id=$1'; sleep 3" </dev/null; }

note ""
note "############### RDLG1-0: menu census ###############"
warm
menudump "Items" > /dev/null
lab_ssh "$IP" "osascript ~/labh/menudump.scpt Items" </dev/null > "$OUT/ax/menu-items.txt" 2>&1
note "  Items menu dumped ($(wc -l <"$OUT/ax/menu-items.txt"|tr -d ' ') lines) -> ax/menu-items.txt"
grep -iE "repeat|copy" "$OUT/ax/menu-items.txt" | tee -a "$REPORT"
for m in File Edit View Window; do
  lab_ssh "$IP" "osascript ~/labh/menudump.scpt $m" </dev/null > "$OUT/ax/menu-$m.txt" 2>&1
done
note "  sidebar / list census"
axdump "00-launch-today"

note ""
note "############### RDLG1-a: Repeat dialog on a FRESH to-do (sheet form) ###############"
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
lab_ssh "$IP" "open -g 'things:///add?title=RDLG1-A-FRESH&auth-token=$TOKEN'; sleep 4" </dev/null
A_UUID=$(gq "SELECT uuid FROM TMTask WHERE title='RDLG1-A-FRESH' AND trashed=0 LIMIT 1")
note "  fresh to-do uuid=$A_UUID"
reveal "$A_UUID"
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
axq 'tell application "System Events" to tell process "Things3" to get enabled of menu item "Repeat…" of menu "Items" of menu bar 1' | sed 's/^/  Repeat… enabled=/' | tee -a "$REPORT"
axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
lab_ssh "$IP" 'sleep 4' </dev/null
axdump "a1-repeat-dialog-sheet"
axq 'tell application "System Events" to tell process "Things3" to get {name, subrole, size} of every window' | sed 's/^/  windows: /' | tee -a "$REPORT"
esc; esc

note ""
note "############### RDLG1-b: same dialog with Things BACKGROUNDED (detached form) ###############"
reveal "$A_UUID"
lab_ssh "$IP" 'osascript -e '\''tell application "Finder" to activate'\''; sleep 2' </dev/null
axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
lab_ssh "$IP" 'sleep 4' </dev/null
axdump "b1-repeat-dialog-detached"
esc; esc

note ""
note "############### RDLG1-c: Reschedule… on the seeded repeating template ###############"
TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-REPEAT-DAILY' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
note "  seeded daily template uuid=$TMPL"
warm
reveal "$TMPL"
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
lab_ssh "$IP" "osascript ~/labh/menudump.scpt Items" </dev/null > "$OUT/ax/menu-items-template-selected.txt" 2>&1
note "  Items menu with a TEMPLATE selected:"
grep -iE "repeat|copy" "$OUT/ax/menu-items-template-selected.txt" | tee -a "$REPORT"
axq 'tell application "System Events" to tell process "Things3" to click menu item "Reschedule…" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' >/dev/null
lab_ssh "$IP" 'sleep 4' </dev/null
axdump "c1-reschedule-dialog-prepopulated"
esc; esc

note ""
note "############### RDLG1-d: does the PRODUCTION recipe still drive? ###############"
lab_ssh "$IP" "open -g 'things:///add?title=RDLG1-D-DRIVE&auth-token=$TOKEN'; sleep 4" </dev/null
D_UUID=$(gq "SELECT uuid FROM TMTask WHERE title='RDLG1-D-DRIVE' AND trashed=0 LIMIT 1")
note "  drive target uuid=$D_UUID"
warm
drive make-repeating-daily todo make-repeating "$D_UUID" --every day --dangerously-drive-gui --json
RULE=$(gq "SELECT CASE WHEN rt1_recurrenceRule IS NULL THEN 'NO-RULE' ELSE 'RULE-PRESENT' END FROM TMTask WHERE uuid='$D_UUID'")
note "  DB truth after drive: $RULE"
axdump "d1-after-production-drive"
esc; esc

note ""
note "############### RDLG1-e: move a fixed-schedule INSTANCE -> the new chooser ###############"
INST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$TMPL' AND trashed=0 AND status=0 ORDER BY creationDate DESC LIMIT 1")
note "  instance uuid=$INST (of template $TMPL)"
if [ -n "$INST" ]; then
  warm
  reveal "$INST"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  lab_ssh "$IP" "osascript ~/labh/menudump.scpt Items" </dev/null > "$OUT/ax/menu-items-instance-selected.txt" 2>&1
  note "  Items menu with an INSTANCE selected:"
  grep -iE "repeat|copy|when|schedule" "$OUT/ax/menu-items-instance-selected.txt" | tee -a "$REPORT"
  axdump "e0-instance-selected"
  # Items ▸ When… opens the schedule popover; pick a future day, then look for the chooser.
  axq 'tell application "System Events" to tell process "Things3" to click menu item "When…" of menu "Items" of menu bar 1' >/dev/null
  lab_ssh "$IP" 'sleep 3' </dev/null
  axdump "e1-when-popover"
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to keystroke "7/20/2026"'\''; sleep 2; osascript -e '\''tell application "System Events" to key code 36'\''; sleep 4' </dev/null
  axdump "e2-after-date-entry-CHOOSER"
  axq 'tell application "System Events" to tell process "Things3" to get {name, subrole, size} of every window' | sed 's/^/  windows: /' | tee -a "$REPORT"
  axq 'tell application "System Events" to tell process "Things3" to get {name, description, value of attribute "AXIdentifier"} of every button of sheet 1 of (first window whose subrole is "AXStandardWindow")' | sed 's/^/  sheet buttons: /' | tee -a "$REPORT"
  esc; esc
else
  note "  NO open instance found for the template — chooser cell SKIPPED"
fi

note ""
note "############### RDLG1-f: the new \"Repeating\" list ###############"
warm
for route in repeating Repeating; do
  R=$(lab_ssh "$IP" "open -g 'things:///show?id=$route' 2>&1; echo rc=\$?" </dev/null)
  note "  things:///show?id=$route -> $R"
  lab_ssh "$IP" 'sleep 3' </dev/null
  axq 'tell application "System Events" to tell process "Things3" to get name of front window' | sed "s/^/  front window after $route: /" | tee -a "$REPORT"
done
axdump "f1-repeating-list"
lab_ssh "$IP" "osascript ~/labh/menudump.scpt View" </dev/null > "$OUT/ax/menu-view-after.txt" 2>&1
grep -iE "repeat" "$OUT/ax/menu-view-after.txt" | tee -a "$REPORT"
# sidebar rows (the Repeating list may be a sidebar entry)
axq 'tell application "System Events" to tell process "Things3" to get value of static text 1 of every row of outline 1 of scroll area 1 of splitter group 1 of (first window whose subrole is "AXStandardWindow")' 2>&1 | sed 's/^/  sidebar rows: /' | tee -a "$REPORT"

note ""
note "############### RDLG1-g: instance row AX (checkbox / repeat glyph) ###############"
warm
lab_ssh "$IP" "open -g 'things:///show?id=today'; sleep 4" </dev/null
axdump "g1-today-rows"
note ""
note "census complete — artifacts in $OUT"
