#!/bin/bash
# MODALX1 — the interaction matrix for "a Things modal SHEET is open while other
# operations run". What is the blast radius of one stranded sheet?
#
# THE FIELD REPORT (maintainer's M1, 2026-08-27, things-api 0.19.1 / Things
# 3.23.1 / macOS 15.4.1; issue #620). A `todo make-repeating` drive died mid-way
# and left its Repeat sheet standing. While it stood:
#   - Things Cloud sync was GATED ENTIRELY — background writes made without the
#     sheet synced fine; dismissing the sheet released the queued sync at once;
#   - the sheet survived an aborted drive (Escape did not take it down).
# VMQ1 §5 had already measured ONE consequence in-lab: an AppleScript `delete`
# is BLOCKED while a sheet stands (lock-independent). Nobody has measured the
# BREADTH. This campaign does.
#
# WHAT IS MEASURED (one clone, cells in order; the sheet is re-opened per cell):
#   M0   POSITIVE CONTROLS, sheet CLOSED. Every vector this campaign judges is
#        first shown to LAND. CNCAC1/URLEN1 doctrine: a negative result from an
#        oracle that has never been shown a positive is not evidence.
#   M1   WRITE VECTORS with the sheet open (M1B maps exactly what the sheet takes
#        away from the scripting surface; M1C runs the SHIPPED CLI into it) — url add/update/json, AppleScript
#        add/update/complete/delete (VMQ1 breadth recheck) plus AppleScript
#        READS (the discriminator: is the gate on the mutation path only?), and
#        the Shortcuts vector. Per vector the taxonomy is LANDS / ERRORS /
#        PARKS / TIMES OUT, so every cell measures the delta TWICE: with the
#        sheet standing, and again AFTER dismissal (URLEN1 proved a refused
#        command can PARK behind a sheet and fire on release).
#   M2   A SECOND GUI DRIVE with the sheet already open — `todo make-repeating`
#        on a DIFFERENT synthetic to-do (does the preflight refuse cleanly, does
#        it collide, does it HIJACK the standing sheet?), zero-mutation assert
#        on refusal; and `todo reschedule-repeat` against the SAME series whose
#        sheet is open.
#   M3   CHORD REORDER (#606 `project move-heading`, the arrow-chord ui vector)
#        with the sheet open — refused / blocked / works?
#   M4   READS — today / show / doctor — confirmed unaffected, and what doctor
#        can see of the sheet (#620's read-only `ui-state` is NOT merged, so the
#        oracle here is raw AX).
#   M5   USER COLLISIONS (this is what #620's guards will be written against):
#        (a) a bare Escape injected at three different phases of a live drive,
#        (b) a stray character typed into the sheet's focused field mid-drive.
#        Does the closed-loop read-back catch it, and what is left behind?
#   M6   SYNC-GATING LOCAL SIGNATURE. There is no Things Cloud account in the
#        clone, so only the LOCAL observable can be certified. Honest either way.
#   M7   SHEET STACKING (URLEN1 saw its consent sheets stack): can TWO Things
#        sheets stand at once, and what does dismissal ORDER do? Run LAST,
#        because its second modal is raised by turning `uriSchemeEnabled` OFF.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (Things 3.23 / dbv27; the
# golden is NEVER booted). Airgapped, clock pinned 2026-07-05 and NEVER rolled
# (the TRIAL WALL is 2026-07-18). Fixtures fully synthetic (MODALX1-*). Beep
# sentinel ON, report-only per driver convention; counts printed per cell.
# AX-drive scrutiny law: the standing sheet's FULL control inventory is dumped
# when it opens and re-dumped after every input aimed at it.
# NO DETACHED PROCESSES: the collision cells background a drive and inject a
# keystroke into it, but both live inside ONE ssh invocation that `wait`s.
#
# Usage:  lab/scripts/research-modalx1.sh setup
#         lab/scripts/research-modalx1.sh run          # all cells
#         CELLS="M5 M7" lab/scripts/research-modalx1.sh run
#         lab/scripts/research-modalx1.sh teardown
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-modalx1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="${OUT:-lab/artifacts/$VM}"; mkdir -p "$OUT/ax" "$OUT/log"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"
CMD="${1:-run}"
CELLS="${CELLS:-M0 M1 M1B M1C M2 M3 M4 M5 M6 M7}"

note() { echo "[modalx1] $*" | tee -a "$REPORT"; }
PASS=0; FAIL=0
cell() { note ""; note "========== $1 =========="; }
verdict_eq() { if [ "$(echo "$3" | tr -d '[:space:]')" = "$(echo "$2" | tr -d '[:space:]')" ]; then note "  PASS $1 (= $2)"; PASS=$((PASS+1));
  else note "  FAIL $1 — expected exactly '$2', got: '$3'"; FAIL=$((FAIL+1)); fi; }
verdict_ne() { if [ "$(echo "$3" | tr -d '[:space:]')" != "$(echo "$2" | tr -d '[:space:]')" ]; then note "  PASS $1 (≠ $2, got '$3')"; PASS=$((PASS+1));
  else note "  FAIL $1 — expected anything but '$2'"; FAIL=$((FAIL+1)); fi; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

# ------------------------------------------------------------------ AX oracle
# The sheet census is the load-bearing verb (URLEN1: a WINDOW census is blind to
# an AXSheet, which is exactly how a whole campaign phase mis-read itself).
AXTOOL=$(cat <<'AXEOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics')
function pidOf(n){return Application('System Events').processes.byName(n).unixId()}
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function sv(el,n){var v=attr(el,n);try{return v?String(v.js):''}catch(e){return ''}}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
function flat(el,acc,d){acc.push(el); if(d>20)return acc; var ch=kids(el); for(var i=0;i<ch.length;i++)flat(ch[i],acc,d+1); return acc}
function frame(el){var p=attr(el,'AXPosition'),z=attr(el,'AXSize');function d(x){if(!x)return null;return ObjC.castRefToObject($.CFCopyDescription(x)).js}
  var pp=d(p),zz=d(z);var mp=pp&&pp.match(/x:([-0-9.]+) y:([-0-9.]+)/);var mz=zz&&zz.match(/w:([-0-9.]+) h:([-0-9.]+)/)
  return {x:mp?+mp[1]:null,y:mp?+mp[2]:null,w:mz?+mz[1]:null,h:mz?+mz[2]:null}}
function line(el,d,ix){
  var p=['['+ix+'] role='+sv(el,'AXRole')]
  var s=sv(el,'AXSubrole'); if(s)p.push('sub='+s)
  var t=sv(el,'AXTitle'); if(t)p.push('ttl='+t)
  var de=sv(el,'AXDescription'); if(de)p.push('desc='+de.slice(0,140))
  var v=sv(el,'AXValue'); if(v)p.push('val='+String(v).slice(0,140))
  var id=sv(el,'AXIdentifier'); if(id)p.push('id='+id)
  var en=sv(el,'AXEnabled'); if(en==='false')p.push('DISABLED')
  var fo=sv(el,'AXFocused'); if(fo==='true')p.push('FOCUSED')
  var f=frame(el); if(f.x!==null)p.push('@['+f.x+','+f.y+' '+f.w+'x'+f.h+']')
  return Array(d+1).join('  ')+p.join(' | ')}
function walk(el,d,acc,ix){acc.push(line(el,d,ix)); if(d>16)return acc; var ch=kids(el); for(var i=0;i<ch.length;i++)walk(ch[i],d+1,acc,i+1); return acc}
function run(argv){
  var cmd=argv[0]||'dump'
  var app=$.AXUIElementCreateApplication(pidOf('Things3'))
  if(cmd==='dump'){
    var ws=kids(app), acc=[]
    for(var i=0;i<ws.length;i++){var w=ws[i], f=frame(w)
      acc.push('=== WINDOW '+(i+1)+' sub='+sv(w,'AXSubrole')+' ttl='+sv(w,'AXTitle')+' @['+f.x+','+f.y+' '+f.w+'x'+f.h+'] ===')
      walk(w,0,acc,i+1)}
    if(!acc.length)acc.push('(no windows)')
    return acc.join('\n')}
  if(cmd==='wins'){
    var ws2=kids(app), out2=[]
    for(var j=0;j<ws2.length;j++){var w2=ws2[j]
      out2.push('WINDOW '+(j+1)+' sub='+sv(w2,'AXSubrole')+' ttl='+JSON.stringify(sv(w2,'AXTitle'))+' modal='+sv(w2,'AXModal'))}
    return out2.length?out2.join('\n'):'(no windows)'}
  var all=[]; flat(app,all,0)
  if(cmd==='sheets'){   // THE MODAL ORACLE (URLEN1). Sheets hang off WINDOWS.
    var sh=all.filter(function(e){return sv(e,'AXRole')==='AXSheet'})
    if(!sh.length) return 'SHEETS=0'
    var out3=['SHEETS='+sh.length]
    for(var k=0;k<sh.length;k++){
      var sub3=[]; flat(sh[k],sub3,0)
      var txt=sub3.filter(function(e){return sv(e,'AXRole')==='AXStaticText'}).map(function(e){return sv(e,'AXValue')})
      var bt=sub3.filter(function(e){return sv(e,'AXRole')==='AXButton'}).map(function(e){return sv(e,'AXTitle')})
      var pu=sub3.filter(function(e){return sv(e,'AXRole')==='AXPopUpButton'}).map(function(e){return JSON.stringify(sv(e,'AXValue'))})
      out3.push('  SHEET '+(k+1)+' desc='+JSON.stringify(sv(sh[k],'AXDescription'))
        +' text='+JSON.stringify(txt.join(' | ').slice(0,220))
        +' buttons=['+bt.join(', ')+'] popups=['+pu.join(', ')+']')}
    return out3.join('\n')}
  if(cmd==='sheetdump'){  // FULL control inventory of every standing sheet.
    var sh2=all.filter(function(e){return sv(e,'AXRole')==='AXSheet'})
    if(!sh2.length) return '(no sheet)'
    var acc2=[]
    for(var m=0;m<sh2.length;m++){acc2.push('=== SHEET '+(m+1)+' ==='); walk(sh2[m],0,acc2,m+1)}
    return acc2.join('\n')}
  if(cmd==='focus'){    // who owns focus, and which control inside Things
    var se=Application('System Events')
    var fa=''; try{fa=se.processes.whose({frontmost:true})[0].name()}catch(e){fa='?'}
    var fe='(none)'
    for(var q=0;q<all.length;q++){ if(sv(all[q],'AXFocused')==='true'){ fe=line(all[q],0,q).trim(); break } }
    return 'FRONTMOST='+fa+'\n  FOCUSED='+fe}
  if(cmd==='menuenabled'){ // is the menu bar live? (a sheet disables it)
    var se2=Application('System Events')
    try{
      var mi=se2.processes.byName('Things3').menuBars[0].menuBarItems.byName('Items').menus[0].menuItems.byName('Repeat…')
      return 'Items>Repeat… enabled='+mi.enabled()
    }catch(e){return 'Items>Repeat… UNREADABLE: '+e}}
  if(cmd==='find'){
    var nd=argv[1], out=[]
    for(var i2=0;i2<all.length;i2++){ var lb=[sv(all[i2],'AXTitle'),sv(all[i2],'AXDescription'),sv(all[i2],'AXValue')].join(' ')
      if(lb.toLowerCase().indexOf(nd.toLowerCase())>=0) out.push(line(all[i2],0,i2)) }
    return out.length?out.join('\n'):'NO ELEMENT matching "'+nd+'"'}
  return 'unknown cmd '+cmd}
AXEOF
)

# ==================================================================== teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: stop+delete $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "teardown done: $(tart list 2>/dev/null | grep -c "$VM" || true) row(s) named $VM remain"
  exit 0
fi

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
  note "preflight: free ${FREEGB}GB"
  [ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free"; exit 1; }
  note "preflight: VM table —"
  tart list 2>/dev/null | sed 's/^/    /' | tee -a "$REPORT"
  RUNNING=$(tart list 2>/dev/null | awk '$5=="running"{n++} END{print n+0}')
  if [ "${RUNNING:-0}" -ge 2 ]; then note "FATAL: $RUNNING VMs already running (2-VM ceiling)"; exit 1; fi

  if [ "${SKIP_BUILD:-0}" = "1" ]; then note "SKIP_BUILD=1 — reusing dist/"; else
    note "building dist"
    npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
  fi
  [ -f dist/cli/main.js ] || { note "FATAL: no dist/cli/main.js"; exit 1; }

  note "cloning $GOLDEN -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 420) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"

  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  [ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) (trial wall 2026-07-18 — never rolled)"

  lab_ssh "$IP" 'mkdir -p ~/labh ~/things-lab/run' </dev/null
  lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<<"$GSQL"
  lab_scp lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/things-lab/run/beep-sentinel.sh" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/run/beep-sentinel.sh' </dev/null
  lab_ssh "$IP" 'cat > ~/labh/axtool.jxa' <<<"$AXTOOL"

  note "warm-up launch/quit/relaunch (background only)"
  lab_ssh "$IP" 'open -g -a Things3; sleep 16; osascript -e "tell application \"Things3\" to quit"; sleep 4; open -g -a Things3; sleep 14' </dev/null

  TOKEN=$(lab_ssh "$IP" "~/labh/gsql.sh -q 'SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1'" </dev/null)
  TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
  TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
  MOS=$(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)
  { echo "IP=$IP"; echo "TOKEN=$TOKEN"; echo "TVER=$TVER"; echo "TBLD=$TBLD"; echo "MOS=$MOS"; } > "$SESSION"
  note "env: Things $TVER ($TBLD) / macOS $MOS / golden $GOLDEN (token ${#TOKEN} chars)"

  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  lab_scp "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  lab_scp -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  COMMANDER=$(node -e "console.log(require('node:path').dirname(require.resolve('commander')))")
  lab_scp -r "$COMMANDER" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  lab_scp package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
  note "shipped dist; ui-enabled=true"
  note "setup DONE — session in $SESSION"
  exit 0
fi

# ==================================================================== run
[ -f "$SESSION" ] || { note "FATAL: no session ($SESSION) — run setup first"; exit 1; }
# shellcheck disable=SC1090
source "$SESSION"
lab_ssh "$IP" true 2>/dev/null || { note "FATAL: no SSH to $IP"; exit 1; }
lab_ssh "$IP" 'cat > ~/labh/axtool.jxa' <<<"$AXTOOL"

CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
gq()  { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt()  { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
G()   { lab_ssh "$IP" "$LAB_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
ax()  { lab_ssh "$IP" "osascript -l JavaScript ~/labh/axtool.jxa $(printf '%q' "${1:-dump}") $(printf '%q' "${2:-}")" </dev/null 2>&1; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" </dev/null; }
bs()    { lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/things-lab/run/beep-sentinel.sh $*" </dev/null 2>&1; }
bmark() { lab_ssh "$IP" "~/things-lab/run/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }
sheets()   { ax sheets | head -1; }
sheetsfull(){ ax sheets; }
sheetdump(){ ax sheetdump > "$OUT/ax/$1.txt"; note "  [sheetdump $1: $(wc -l <"$OUT/ax/$1.txt"|tr -d ' ') lines]"; }
axdump()   { ax dump > "$OUT/ax/$1.txt"; note "  [axdump $1: $(wc -l <"$OUT/ax/$1.txt"|tr -d ' ') lines, $(grep -c '^=== WINDOW' "$OUT/ax/$1.txt") windows]"; }
alive()    { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null; }
crashes()  { lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | grep -c "^Things3-.*\.ips$" | tr -d " "' </dev/null; }
# URLEN1 rule 2: a modal survives a graceful quit — the reset primitive is pkill.
resetapp() { lab_ssh "$IP" 'pkill -x Things3 >/dev/null 2>&1; sleep 4; open -g -a Things3; sleep 16; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; true' </dev/null; }
openurl()  { lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null 2>&1; sleep 4; }

# select_item <uuid> — REPX3's verified reveal (shell `open`, then verify by uuid).
select_item() {
  local uuid="$1" i sel
  for i in 1 2 3 4 5; do
    lab_ssh "$IP" "open -g 'things:///show?id=$uuid'; sleep 3" </dev/null >/dev/null 2>&1
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null >/dev/null 2>&1
    sel=$(axq 'tell application "Things3" to get id of selected to dos' | tr -d '\r')
    [ "$sel" = "$uuid" ] && return 0
  done
  note "    WARN: selection never confirmed for $uuid (last='$sel')"
  return 1
}

# opensheet <uuid> <dumpname> — REPX2/REPX3 reveal: select, Items ▸ Repeat….
opensheet() {
  local uuid="$1" name="$2"
  select_item "$uuid" || true
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  lab_ssh "$IP" 'sleep 3' </dev/null
  local s; s=$(sheets)
  note "  sheet after Items▸Repeat… : $s"
  sheetsfull | sed -n '2,6p' | sed 's/^/    /' | tee -a "$REPORT"
  sheetdump "$name"
  [ "$s" = "SHEETS=1" ]
}

# dismiss — Escape, then VERIFY (never claim a dismissal we did not see).
dismiss() {
  axq 'tell application "Things3" to activate' >/dev/null
  axq 'tell application "System Events" to key code 53' >/dev/null
  lab_ssh "$IP" 'sleep 2' </dev/null
  local s; s=$(sheets)
  note "  after Escape: $s"
  echo "$s"
}

rowsof() { gt "SELECT substr(uuid,1,8) AS uuid8, title, type, status, trashed, start, startDate, rt1_recurrenceRule IS NOT NULL AS hasrule, COALESCE(notes,'') AS notes FROM TMTask WHERE title LIKE 'MODALX1%' ORDER BY creationDate"; }
nrows()  { gq "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'MODALX1%' AND trashed=0"; }
uuidof() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
sig()    { gq "SELECT title||'|'||status||'|'||trashed||'|'||COALESCE(notes,'')||'|'||(rt1_recurrenceRule IS NOT NULL)||'|'||COALESCE(userModificationDate,'') FROM TMTask WHERE uuid='$1'"; }

note ""
note "################ MODALX1 RUN $(date -u +%Y-%m-%dT%H:%M:%SZ) ################"
note "env: Things ${TVER:-?} (${TBLD:-?}) / macOS ${MOS:-?} / golden $GOLDEN / VM $VM @ $IP"
note "cells: $CELLS"
bs reset >/dev/null
CRASH0=$(crashes); note "crash reports at start: $CRASH0"

has() { case " $CELLS " in *" $1 "*) return 0;; *) return 1;; esac; }

# ------------------------------------------------------------------ fixtures
mkurl() { # mkurl <title> [when] -> uuid
  local t="$1" w="${2:-}"
  lab_ssh "$IP" "open -g 'things:///add?title=$t${w:+&when=$w}&auth-token=$TOKEN'; sleep 4" </dev/null >/dev/null 2>&1
  uuidof "$t"
}

if has M0 || has FIXTURES; then
resetapp
cell "FIXTURES — synthetic MODALX1-* seeds (all titles invented for this campaign)"
U_HOST=$(mkurl "MODALX1-sheet-host" "2026-07-08")
U_OTHER=$(mkurl "MODALX1-other" "2026-07-08")
U_AS=$(mkurl "MODALX1-as-target")
U_SC=$(mkurl "MODALX1-sc-target")
U_DEL=$(mkurl "MODALX1-as-deletee")
U_CMP=$(mkurl "MODALX1-as-completee")
note "  sheet-host=$U_HOST other=$U_OTHER as-target=$U_AS sc-target=$U_SC deletee=$U_DEL completee=$U_CMP"
{ echo "U_HOST=$U_HOST"; echo "U_OTHER=$U_OTHER"; echo "U_AS=$U_AS"; echo "U_SC=$U_SC"; echo "U_DEL=$U_DEL"; echo "U_CMP=$U_CMP"; } >> "$SESSION"
fi
# shellcheck disable=SC1090
source "$SESSION"

# ==================================================================== M0
if has M0; then
cell "M0 — POSITIVE CONTROLS with NO sheet open (every vector must LAND first)"
bmark "M0"
resetapp
note "  sheet census before controls: $(sheets)"

note "  [M0-URL-ADD] things:///add"
B=$(nrows); openurl "things:///add?title=MODALX1-ctl-url&auth-token=$TOKEN"; A=$(nrows)
verdict_eq "M0-URL-ADD lands" "$((B+1))" "$A"

note "  [M0-URL-UPD] things:///update notes"
openurl "things:///update?auth-token=$TOKEN&id=$U_AS&notes=ctl-url-upd"
verdict_eq "M0-URL-UPD lands" "ctl-url-upd" "$(gq "SELECT COALESCE(notes,'') FROM TMTask WHERE uuid='$U_AS'")"

note "  [M0-JSON] things:///json batch add"
lab_ssh "$IP" 'cat > ~/labh/tjson.sh && chmod +x ~/labh/tjson.sh' <<'EOF'
#!/bin/bash
URL=$(python3 -c 'import sys,urllib.parse; print("things:///json?auth-token="+sys.argv[1]+"&data="+urllib.parse.quote(sys.argv[2],safe=""))' "$1" "$2")
open -g "$URL"
EOF
B=$(nrows)
lab_ssh "$IP" "~/labh/tjson.sh $(printf '%q' "$TOKEN") $(printf '%q' '[{"type":"to-do","attributes":{"title":"MODALX1-ctl-json"}}]')" </dev/null >/dev/null 2>&1
sleep 5; A=$(nrows)
verdict_eq "M0-JSON lands" "$((B+1))" "$A"

note "  [M0-AS-ADD] AppleScript make new to do"
B=$(nrows); axq 'tell application "Things3" to make new to do with properties {name:"MODALX1-ctl-as"}' >/dev/null; sleep 3; A=$(nrows)
verdict_eq "M0-AS-ADD lands" "$((B+1))" "$A"

note "  [M0-AS-UPD] AppleScript set notes"
axq "tell application \"Things3\" to set notes of to do id \"$U_AS\" to \"ctl-as-upd\"" >/dev/null; sleep 2
verdict_eq "M0-AS-UPD lands" "ctl-as-upd" "$(gq "SELECT COALESCE(notes,'') FROM TMTask WHERE uuid='$U_AS'")"

note "  [M0-AS-CMP] AppleScript complete"
axq "tell application \"Things3\" to set status of to do id \"$U_CMP\" to completed" >/dev/null; sleep 3
verdict_eq "M0-AS-CMP lands" "3" "$(gq "SELECT status FROM TMTask WHERE uuid='$U_CMP'")"

note "  [M0-AS-DEL] AppleScript delete (VMQ1's vector)"
axq "tell application \"Things3\" to delete (to do id \"$U_DEL\")" >/dev/null; sleep 3
verdict_eq "M0-AS-DEL lands" "1" "$(gq "SELECT trashed FROM TMTask WHERE uuid='$U_DEL'")"

note "  [M0-AS-READ] AppleScript read (count to dos)"
R=$(axq 'tell application "Things3" to count to dos')
note "    count to dos = '$R'"
verdict_ne "M0-AS-READ answers" "" "$R"

note "  [M0-SC] Shortcuts vector — things-proxy-edit-title"
lab_ssh "$IP" "cat > ~/labh/scin.json" <<<"{\"id\":\"$U_SC\",\"title\":\"MODALX1-sc-renamed\"}"
SCOUT=$(lab_ssh "$IP" 'cd ~/labh && rm -f scout.txt && shortcuts run things-proxy-edit-title --input-path scin.json --output-path scout.txt 2>&1; echo "EXIT=$?"; cat scout.txt 2>/dev/null' </dev/null)
note "    shortcut result: $(echo "$SCOUT" | tr '\n' ' ')"
sleep 3
verdict_eq "M0-SC lands" "MODALX1-sc-renamed" "$(gq "SELECT title FROM TMTask WHERE uuid='$U_SC'")"

note "  [M0-CHORD] fixture: a project with three headings (Shortcuts create-heading)"
lab_ssh "$IP" "open -g 'things:///add-project?title=MODALX1-proj&auth-token=$TOKEN'; sleep 4" </dev/null >/dev/null 2>&1
U_PROJ=$(gq "SELECT uuid FROM TMTask WHERE title='MODALX1-proj' AND type=1 AND trashed=0 LIMIT 1")
for H in A B C; do
  G "project add-heading $U_PROJ MODALX1-HD-$H" | tail -2 | sed 's/^/      /' | tee -a "$REPORT"
  sleep 2
done
note "    heading order:"; gt "SELECT substr(uuid,1,8) AS uuid8,title,\"index\" FROM TMTask WHERE project='$U_PROJ' AND type=2 ORDER BY \"index\"" | sed 's/^/      /' | tee -a "$REPORT"
echo "U_PROJ=$U_PROJ" >> "$SESSION"

note "  [M0-CHORD-CTL] move-heading C --first with NO sheet (positive control)"
G "project move-heading $U_PROJ MODALX1-HD-C --first --dangerously-drive-gui" | tail -4 | sed 's/^/      /' | tee -a "$REPORT"
sleep 3
ORD=$(gq "SELECT group_concat(title,',') FROM (SELECT title FROM TMTask WHERE project='$U_PROJ' AND type=2 ORDER BY \"index\")")
note "    heading order after: $ORD"
verdict_eq "M0-CHORD-CTL reorders" "MODALX1-HD-C,MODALX1-HD-A,MODALX1-HD-B" "$ORD"

note "  [M0-MKREP-CTL] make-repeating on a throwaway to-do (positive control for M2)"
U_CTLREP=$(mkurl "MODALX1-ctl-mkrep" "2026-07-08")
G "todo make-repeating $U_CTLREP --frequency daily --interval 1 --dangerously-drive-gui" | tail -4 | sed 's/^/      /' | tee -a "$REPORT"
sleep 5
verdict_eq "M0-MKREP-CTL promotes" "1" "$(gq "SELECT COUNT(*) FROM TMTask WHERE title='MODALX1-ctl-mkrep' AND rt1_recurrenceRule IS NOT NULL")"
note "  sheet census after the control drive: $(sheets)"
note "  beeps so far:"; bs assert --name M0 2>&1 | tail -6 | sed 's/^/    /' | tee -a "$REPORT"
fi
# shellcheck disable=SC1090
source "$SESSION"

# ==================================================================== M1
if has M1; then
cell "M1 — WRITE VECTORS while a Repeat sheet STANDS (lands / errors / parks / times out)"
bmark "M1"
resetapp
opensheet "$U_HOST" "m1-sheet-open" || note "  WARN: sheet did not open — M1 is void"
note "  menu-bar liveness with the sheet up: $(ax menuenabled)"
note "  focus: "; ax focus | sed 's/^/    /' | tee -a "$REPORT"

# Each vector: measure with the sheet standing, then DISMISS and re-measure.
# A delta that appears only after dismissal is a PARK, not a drop (URLEN1).
note ""
note "  [M1-URL-ADD] things:///add with the sheet open"
B=$(nrows); T0=$(date +%s)
openurl "things:///add?title=MODALX1-m1-url&auth-token=$TOKEN"
D=$(nrows); T1=$(date +%s)
note "    rows $B -> $D in $((T1-T0))s; sheet still: $(sheets)"
verdict_eq "M1-URL-ADD lands WITH the sheet standing" "$((B+1))" "$D"

note "  [M1-URL-UPD] things:///update notes with the sheet open"
openurl "things:///update?auth-token=$TOKEN&id=$U_AS&notes=m1-url-upd"
N1=$(gq "SELECT COALESCE(notes,'') FROM TMTask WHERE uuid='$U_AS'")
note "    notes now: '$N1'"

note "  [M1-JSON] things:///json batch with the sheet open"
B=$(nrows)
lab_ssh "$IP" "~/labh/tjson.sh $(printf '%q' "$TOKEN") $(printf '%q' '[{"type":"to-do","attributes":{"title":"MODALX1-m1-json"}}]')" </dev/null >/dev/null 2>&1
sleep 5; D=$(nrows)
note "    rows $B -> $D; sheet still: $(sheets)"

note "  [M1-AS-ADD] AppleScript make new to do with the sheet open"
B=$(nrows); T0=$(date +%s)
R=$(lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to make new to do with properties {name:\"MODALX1-m1-as\"}' 2>&1; echo EXIT=\$?" </dev/null)
T1=$(date +%s); sleep 3; D=$(nrows)
note "    result: $(echo "$R" | tr '\n' ' ') ($((T1-T0))s)"
note "    rows $B -> $D"

note "  [M1-AS-UPD] AppleScript set notes with the sheet open"
S0=$(gq "SELECT COALESCE(notes,'') FROM TMTask WHERE uuid='$U_AS'")
T0=$(date +%s)
R=$(lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to set notes of to do id \"$U_AS\" to \"m1-as-upd\"' 2>&1; echo EXIT=\$?" </dev/null)
T1=$(date +%s); sleep 2
S1=$(gq "SELECT COALESCE(notes,'') FROM TMTask WHERE uuid='$U_AS'")
note "    result: $(echo "$R" | tr '\n' ' ') ($((T1-T0))s)"
note "    notes '$S0' -> '$S1'"

note "  [M1-AS-CMP] AppleScript complete with the sheet open"
U_CMP2=$(mkurl "MODALX1-m1-completee")
T0=$(date +%s)
R=$(lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to set status of to do id \"$U_CMP2\" to completed' 2>&1; echo EXIT=\$?" </dev/null)
T1=$(date +%s); sleep 3
note "    result: $(echo "$R" | tr '\n' ' ') ($((T1-T0))s); status=$(gq "SELECT status FROM TMTask WHERE uuid='$U_CMP2'")"

note "  [M1-AS-DEL] AppleScript delete with the sheet open (VMQ1 recheck)"
U_DEL2=$(mkurl "MODALX1-m1-deletee")
T0=$(date +%s)
R=$(lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to delete (to do id \"$U_DEL2\")' 2>&1; echo EXIT=\$?" </dev/null)
T1=$(date +%s); sleep 3
note "    result: $(echo "$R" | tr '\n' ' ') ($((T1-T0))s); trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$U_DEL2'")"

note "  [M1-AS-READ] AppleScript READS with the sheet open (the discriminator)"
T0=$(date +%s)
R1=$(lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to count to dos' 2>&1; echo EXIT=\$?" </dev/null)
R2=$(lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to get name of to do id \"$U_AS\"' 2>&1; echo EXIT=\$?" </dev/null)
R3=$(lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to count windows' 2>&1; echo EXIT=\$?" </dev/null)
T1=$(date +%s)
note "    count to dos: $(echo "$R1" | tr '\n' ' ')"
note "    get name:     $(echo "$R2" | tr '\n' ' ')"
note "    count windows:$(echo "$R3" | tr '\n' ' ')  (all three in $((T1-T0))s)"

note "  [M1-SC] Shortcuts vector with the sheet open"
U_SC2=$(mkurl "MODALX1-m1-sc")
lab_ssh "$IP" "cat > ~/labh/scin.json" <<<"{\"id\":\"$U_SC2\",\"title\":\"MODALX1-m1-sc-renamed\"}"
T0=$(date +%s)
SCOUT=$(lab_ssh "$IP" 'cd ~/labh && rm -f scout.txt && shortcuts run things-proxy-edit-title --input-path scin.json --output-path scout.txt 2>&1; echo "EXIT=$?"; cat scout.txt 2>/dev/null' </dev/null)
T1=$(date +%s); sleep 3
note "    result: $(echo "$SCOUT" | tr '\n' ' ') ($((T1-T0))s)"
note "    title now: '$(gq "SELECT title FROM TMTask WHERE uuid='$U_SC2'")'"

note ""
note "  --- state snapshot WITH THE SHEET STILL STANDING ---"
note "    sheets: $(sheets)"
rowsof | sed 's/^/    /' | tee -a "$REPORT"
NROWS_DURING=$(nrows)

note ""
note "  --- DISMISS the sheet, settle 10s, and RE-MEASURE (parks fire here) ---"
dismiss >/dev/null
lab_ssh "$IP" 'sleep 10' </dev/null
note "    sheets after: $(sheets)"
rowsof | sed 's/^/    /' | tee -a "$REPORT"
note "    row count during-sheet=$NROWS_DURING  after-dismiss=$(nrows)"
note "    MODALX1-m1-completee status: $(gq "SELECT status FROM TMTask WHERE uuid='$U_CMP2'")"
note "    MODALX1-m1-deletee trashed: $(gq "SELECT trashed FROM TMTask WHERE uuid='$U_DEL2'")"
note "    MODALX1-as-target notes:    '$(gq "SELECT COALESCE(notes,'') FROM TMTask WHERE uuid='$U_AS'")'"
note "    MODALX1-m1-sc title:        '$(gq "SELECT title FROM TMTask WHERE uuid='$U_SC2'")'"
note "  beeps:"; bs assert --name M1 2>&1 | tail -8 | sed 's/^/    /' | tee -a "$REPORT"
fi

# ==================================================================== M2
if has M2; then
cell "M2 — A SECOND GUI DRIVE while a sheet stands"
bmark "M2"
resetapp
note "  [M2a] make-repeating on a DIFFERENT to-do with MODALX1-sheet-host's sheet open"
opensheet "$U_HOST" "m2a-sheet-open" || note "  WARN: sheet did not open"
SIG0=$(sig "$U_OTHER"); HOSTSIG0=$(sig "$U_HOST")
note "    zero-mutation baseline: other='$SIG0'"
note "                            host ='$HOSTSIG0'"
NR0=$(nrows)
T0=$(date +%s)
OUT2=$(G "todo make-repeating $U_OTHER --frequency daily --interval 1 --dangerously-drive-gui")
T1=$(date +%s)
note "    drive output ($((T1-T0))s):"
echo "$OUT2" | sed 's/^/      /' | tee -a "$REPORT"
sleep 3
note "    sheet census after the drive: $(sheets)"
sheetsfull | sed -n '2,6p' | sed 's/^/      /' | tee -a "$REPORT"
sheetdump "m2a-after-drive"
verdict_eq "M2a zero-mutation on the TARGET" "$SIG0" "$(sig "$U_OTHER")"
verdict_eq "M2a zero-mutation on the SHEET HOST" "$HOSTSIG0" "$(sig "$U_HOST")"
verdict_eq "M2a created no rows" "$NR0" "$(nrows)"
note "    did the drive HIJACK/dismiss our sheet? sheets=$(sheets) (SHEETS=1 => our sheet survived)"
dismiss >/dev/null

note ""
note "  [M2b] reschedule-repeat against the SAME series whose sheet is open."
note "  A SERIES' sheet is behind Items ▸ Repeat ▸ Edit Rule…, NOT Items ▸ Repeat… —"
note "  the first pass used the plain path, opened nothing, and read as a false ok."
resetapp
U_SER=$(mkurl "MODALX1-series" "2026-07-08")
G "todo make-repeating $U_SER --frequency daily --interval 1 --dangerously-drive-gui" | tail -3 | sed 's/^/      /' | tee -a "$REPORT"
sleep 5
U_TMPL=$(gq "SELECT uuid FROM TMTask WHERE title='MODALX1-series' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1")
note "    series template uuid: ${U_TMPL:-<none>}"
if [ -n "$U_TMPL" ]; then
  resetapp
  select_item "$U_TMPL" || true
  note "    Items ▸ Repeat submenu inventory (full shape before the input):"
  axq 'tell application "System Events" to tell process "Things3"
    click menu bar item "Items" of menu bar 1
    delay 1
    set out to ""
    try
      repeat with mi in (menu items of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1)
        set out to out & "      " & (name of mi) & " enabled=" & (enabled of mi) & linefeed
      end repeat
    end try
    key code 53
    return out
  end tell' | sed 's/^/    /' | tee -a "$REPORT"
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Edit Rule…" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' >/dev/null
  lab_ssh "$IP" 'sleep 3' </dev/null
  note "    sheet after Items ▸ Repeat ▸ Edit Rule… : $(sheets)"
  sheetsfull | sed -n '2,4p' | sed 's/^/      /' | tee -a "$REPORT"
  sheetdump "m2b-sheet-open"
  RSIG0=$(sig "$U_TMPL")
  RULE0=$(gq "SELECT hex(rt1_recurrenceRule) FROM TMTask WHERE uuid='$U_TMPL'")
  NR0=$(nrows)
  T0=$(date +%s)
  OUT2=$(G "todo reschedule-repeat $U_TMPL --frequency monthly --interval 2 --dangerously-drive-gui")
  T1=$(date +%s)
  note "    drive output ($((T1-T0))s):"
  echo "$OUT2" | sed 's/^/      /' | tee -a "$REPORT"
  sleep 3
  RULE1=$(gq "SELECT hex(rt1_recurrenceRule) FROM TMTask WHERE uuid='$U_TMPL'")
  note "    sheets after: $(sheets)"
  sheetdump "m2b-after-drive"
  verdict_eq "M2b left the rule byte-identical" "$RULE0" "$RULE1"
  verdict_eq "M2b zero-mutation on the template row" "$RSIG0" "$(sig "$U_TMPL")"
  verdict_eq "M2b created no rows" "$NR0" "$(nrows)"
  dismiss >/dev/null; dismiss >/dev/null
fi
note "  beeps:"; bs assert --name M2 2>&1 | tail -8 | sed 's/^/    /' | tee -a "$REPORT"
fi

# ==================================================================== M1B/M1C
# The M1 follow-ups: WHAT exactly a standing sheet takes away from Things'
# scripting surface, and what the SHIPPED CLI does when it hits that.
if has M1B; then
cell "M1B — the scripting surface a standing sheet removes (matched controls either side)"
bmark "M1B"
U_PB=$(mkurl "MODALX1-b-target")
U_PD=$(mkurl "MODALX1-b-deletee")
asprobe() { # asprobe <phase-label>
  note "  --- $1 (sheets: $(sheets)) ---"
  note "    count to dos ................ $(axq 'tell application "Things3" to count to dos' | tr '\n' ' ')"
  note "    count projects .............. $(axq 'tell application "Things3" to count projects' | tr '\n' ' ')"
  note "    count areas ................. $(axq 'tell application "Things3" to count areas' | tr '\n' ' ')"
  note "    count to dos of list Inbox .. $(axq 'tell application "Things3" to count to dos of list "Inbox"' | tr '\n' ' ')"
  note "    count to dos of list Today .. $(axq 'tell application "Things3" to count to dos of list "Today"' | tr '\n' ' ')"
  note "    count (every to do) ......... $(axq 'tell application "Things3" to count (every to do)' | tr '\n' ' ')"
  note "    name of first to do ......... $(axq 'tell application "Things3" to get name of first to do' | tr '\n' ' ')"
  note "    exists to do id <b-target> .. $(axq "tell application \"Things3\" to exists to do id \"$U_PB\"" | tr '\n' ' ')"
  note "    get name of to do id ........ $(axq "tell application \"Things3\" to get name of to do id \"$U_PB\"" | tr '\n' ' ')"
  note "    get status of to do id ...... $(axq "tell application \"Things3\" to get status of to do id \"$U_PB\"" | tr '\n' ' ')"
  note "    count windows ............... $(axq 'tell application "Things3" to count windows' | tr '\n' ' ')"
  note "    version ..................... $(axq 'tell application "Things3" to get version' | tr '\n' ' ')"
}
resetapp
asprobe "CONTROL — no sheet"
opensheet "$U_HOST" "m1b-sheet-open" || note "  WARN: sheet did not open"
asprobe "SHEET STANDING"
note "  the three mutation FORMS side by side, sheet standing:"
note "    delete (to do id …) ................ $(axq "tell application \"Things3\" to delete (to do id \"$U_PD\")" | tr '\n' ' ')"
note "      -> trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$U_PD'")"
note "    move to do id … to list \"Trash\" .... $(axq "tell application \"Things3\" to move to do id \"$U_PD\" to list \"Trash\"" | tr '\n' ' ')"
note "      -> trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$U_PD'")"
note "    set status of to do id … to canceled  $(axq "tell application \"Things3\" to set status of to do id \"$U_PD\" to canceled" | tr '\n' ' ')"
note "      -> status=$(gq "SELECT status FROM TMTask WHERE uuid='$U_PD'")"
dismiss >/dev/null
asprobe "AFTER DISMISSAL"
note "  beeps:"; bs assert --name M1B 2>&1 | tail -6 | sed 's/^/    /' | tee -a "$REPORT"
fi

if has M1C; then
cell "M1C — the SHIPPED CLI against the emptied collection, and the release"
bmark "M1C"
resetapp
U_CD=$(mkurl "MODALX1-c-cli-del")
U_AD=$(mkurl "MODALX1-c-as-del")
lab_ssh "$IP" "open -g 'things:///add-project?title=MODALX1-c-proj&auth-token=$TOKEN'; sleep 4" </dev/null >/dev/null 2>&1
U_CP=$(gq "SELECT uuid FROM TMTask WHERE title='MODALX1-c-proj' AND type=1 AND trashed=0 ORDER BY creationDate DESC LIMIT 1")
opensheet "$U_HOST" "m1c-sheet-open" || note "  WARN: sheet did not open"
note "  [C1] SHIPPED \`todo delete\` with the sheet standing:"
G "todo delete $U_CD" | sed 's/^/      /' | tee -a "$REPORT"
note "      DB trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$U_CD'")"
note "  [C2] raw AS \`delete (project id …)\`: $(axq "tell application \"Things3\" to delete (project id \"$U_CP\")" | tr '\n' ' ')"
note "      DB trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$U_CP'")"
U_CC=$(mkurl "MODALX1-c-cli-cmp")
note "  [C3] SHIPPED \`todo complete\` (an op whose leg is NOT AppleScript delete):"
G "todo complete $U_CC" | sed 's/^/      /' | tee -a "$REPORT"
note "      DB status=$(gq "SELECT status FROM TMTask WHERE uuid='$U_CC'")"
dismiss >/dev/null
note "  --- dismissed; the SAME two deletes on the SAME untrashed rows ---"
note "  [C4] raw AS delete on c-cli-del: $(axq "tell application \"Things3\" to delete (to do id \"$U_CD\")" | tr '\n' ' ')"
note "      DB trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$U_CD'")"
note "  [C5] SHIPPED \`todo delete\` on c-as-del:"
G "todo delete $U_AD" | sed 's/^/      /' | tee -a "$REPORT"
note "      DB trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$U_AD'")"
note "  [C6] count to dos after dismissal: $(axq 'tell application "Things3" to count to dos' | tr '\n' ' ')"
note "  beeps:"; bs assert --name M1C 2>&1 | tail -6 | sed 's/^/    /' | tee -a "$REPORT"
fi
# shellcheck disable=SC1090
source "$SESSION"

# ==================================================================== M3
if has M3; then
cell "M3 — CHORD REORDER (#606 project move-heading) while a sheet stands"
bmark "M3"
resetapp
ORD0=$(gq "SELECT group_concat(title,',') FROM (SELECT title FROM TMTask WHERE project='$U_PROJ' AND type=2 ORDER BY \"index\")")
IDX0=$(gq "SELECT group_concat(title||':'||\"index\",',') FROM (SELECT title,\"index\" FROM TMTask WHERE project='$U_PROJ' AND type=2 ORDER BY \"index\")")
note "  heading order before: $ORD0"
opensheet "$U_HOST" "m3-sheet-open" || note "  WARN: sheet did not open"
T0=$(date +%s)
OUT3=$(G "project move-heading $U_PROJ MODALX1-HD-B --first --dangerously-drive-gui")
T1=$(date +%s)
note "  drive output ($((T1-T0))s):"
echo "$OUT3" | sed 's/^/    /' | tee -a "$REPORT"
sleep 3
ORD1=$(gq "SELECT group_concat(title,',') FROM (SELECT title FROM TMTask WHERE project='$U_PROJ' AND type=2 ORDER BY \"index\")")
IDX1=$(gq "SELECT group_concat(title||':'||\"index\",',') FROM (SELECT title,\"index\" FROM TMTask WHERE project='$U_PROJ' AND type=2 ORDER BY \"index\")")
note "  heading order after:  $ORD1"
note "  index map before: $IDX0"
note "  index map after:  $IDX1"
note "  sheets after: $(sheets)"
sheetdump "m3-after-drive"
dismiss >/dev/null
note "  beeps:"; bs assert --name M3 2>&1 | tail -8 | sed 's/^/    /' | tee -a "$REPORT"
fi

# ==================================================================== M4
if has M4; then
cell "M4 — READS while a sheet stands (today / show / doctor)"
bmark "M4"
resetapp
opensheet "$U_HOST" "m4-sheet-open" || note "  WARN: sheet did not open"
for R in "today" "show $U_AS" "doctor"; do
  T0=$(date +%s)
  O=$(lab_ssh "$IP" "$LAB_DIRECT $CLI $R 2>&1; echo EXIT=\$?" </dev/null)
  T1=$(date +%s)
  note "  [$R] ($((T1-T0))s) exit=$(echo "$O" | grep -o 'EXIT=[0-9]*' | tail -1)"
  echo "$O" | head -30 | sed 's/^/    /' | tee -a "$REPORT"
done
note "  --- what a raw-AX oracle can see of the sheet (no #620 ui-state yet) ---"
sheetsfull | sed 's/^/    /' | tee -a "$REPORT"
ax focus | sed 's/^/    /' | tee -a "$REPORT"
note "  does doctor mention a sheet/modal at all?"
lab_ssh "$IP" "$LAB_DIRECT $CLI doctor 2>&1" </dev/null | grep -in "sheet\|modal\|dialog" | sed 's/^/    /' | tee -a "$REPORT" || note "    (no mention)"
dismiss >/dev/null
note "  beeps:"; bs assert --name M4 2>&1 | tail -8 | sed 's/^/    /' | tee -a "$REPORT"
fi

# ==================================================================== M5
if has M5; then
cell "M5 — USER COLLISIONS with a LIVE drive (the #620 guard evidence)"
bmark "M5"
# The rig: one ssh invocation backgrounds the CLI drive, sleeps to the wanted
# phase, injects ONE keystroke as a user would, then WAITS for the drive. No
# process ever outlives the invocation (no-orphans rule).
lab_ssh "$IP" 'cat > ~/labh/collide.sh && chmod +x ~/labh/collide.sh' <<'EOF'
#!/bin/bash
# collide.sh <delaySeconds> <osascript-keystroke-body> <uuid> — run a
# make-repeating drive and inject one keystroke `delay` seconds in.
DELAY="$1"; KEY="$2"; UUID="$3"
CLI="$HOME/things-lab/bin/node $HOME/things-lab/things-api/dist/cli/main.js"
export THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1
( $CLI todo make-repeating "$UUID" --frequency daily --interval 3 --dangerously-drive-gui \
    >"$HOME/labh/drive.out" 2>&1; echo "$?" >"$HOME/labh/drive.rc" ) &
DRIVE=$!
sleep "$DELAY"
echo "--- injecting at t=${DELAY}s ---"
osascript -e "tell application \"System Events\" to $KEY" 2>&1
echo "--- injected; waiting for the drive ---"
wait $DRIVE
echo "DRIVE-RC=$(cat "$HOME/labh/drive.rc" 2>/dev/null)"
EOF

collide() { # collide <label> <delay> <keystroke-body> <fixture-title>
  local label="$1" delay="$2" key="$3" title="$4" u
  note ""
  note "  [$label] inject '$key' at t=${delay}s into a live make-repeating drive"
  resetapp
  u=$(mkurl "$title" "2026-07-08")
  note "    fixture $title = $u"
  local o
  o=$(lab_ssh "$IP" "~/labh/collide.sh $(printf '%q' "$delay") $(printf '%q' "$key") $(printf '%q' "$u")" </dev/null 2>&1)
  echo "$o" | sed 's/^/      /' | tee -a "$REPORT"
  note "    --- what the drive REPORTED ---"
  lab_ssh "$IP" 'cat ~/labh/drive.out 2>/dev/null' </dev/null | sed 's/^/      /' | tee -a "$REPORT"
  sleep 3
  note "    --- ground truth ---"
  note "      sheets left standing: $(sheets)"
  sheetsfull | sed -n '2,6p' | sed 's/^/        /' | tee -a "$REPORT"
  gt "SELECT substr(uuid,1,8) AS uuid8,title,status,trashed,rt1_recurrenceRule IS NOT NULL AS hasrule FROM TMTask WHERE title='$title'" | sed 's/^/      /' | tee -a "$REPORT"
  local rule
  rule=$(gq "SELECT quote(rt1_recurrenceRule) FROM TMTask WHERE title='$title' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
  note "      rule blob: ${rule:0:120}"
  sheetdump "m5-$label"
}

# (a) BARE ESCAPE at three phases. The drive's own phases (measured on this rig):
#     ~0-4s reveal+select, ~4-8s menu press + sheet present, ~8-16s field entry
#     and commit. One cell per phase.
collide "M5a-esc-early"  3  'key code 53' "MODALX1-esc-early"
collide "M5a-esc-sheet"  7  'key code 53' "MODALX1-esc-sheet"
collide "M5a-esc-late"   12 'key code 53' "MODALX1-esc-late"

# (b) A STRAY CHARACTER into the sheet's focused field, mid-drive. If the
#     closed-loop read-back is doing its job it either catches the corrupted
#     value and retypes, or refuses. Two phases.
collide "M5b-char-sheet" 7  'keystroke "7"' "MODALX1-char-sheet"
collide "M5b-char-late"  12 'keystroke "7"' "MODALX1-char-late"

note ""
note "  beeps:"; bs assert --name M5 2>&1 | tail -14 | sed 's/^/    /' | tee -a "$REPORT"
fi

# ==================================================================== M6
if has M6; then
cell "M6 — SYNC-GATING LOCAL SIGNATURE (no Things Cloud account in the clone)"
bmark "M6"
resetapp
note "  the field observable is BSSyncronyMetadata's last-attempt NSDate. Is it here?"
NSYNC=$(gq "SELECT COUNT(*) FROM BSSyncronyMetadata")
note "    BSSyncronyMetadata rows: $NSYNC"
gt "SELECT uuid, length(value) AS bytes FROM BSSyncronyMetadata" | sed 's/^/    /' | tee -a "$REPORT"
note "    thingsCloudDeclined / thingsCloudEverUsed in the group-container plist:"
lab_ssh "$IP" 'plutil -p ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/*.plist 2>/dev/null | grep -i "cloud"' </dev/null | sed 's/^/      /' | tee -a "$REPORT"

note ""
note "  SUBSTITUTE MEASUREMENT — the app has no com.culturedcode os_log subsystem"
note "  (headless-research SYNC2), so the available local proxy for 'is the app's"
note "  post-commit work gated?' is: does the LOCAL commit itself still happen, and"
note "  is the gate on the mutation path or on everything? Both halves measured here."
opensheet "$U_HOST" "m6-sheet-open" || note "  WARN: sheet did not open"
note "    a) local commit latency of a URL write WITH the sheet standing:"
B=$(nrows); T0=$(date +%s%3N 2>/dev/null || date +%s)
lab_ssh "$IP" "open -g 'things:///add?title=MODALX1-m6-during&auth-token=$TOKEN'" </dev/null >/dev/null 2>&1
for i in $(seq 1 40); do
  [ "$(nrows)" -gt "$B" ] && break
  sleep 1
done
note "       row appeared after ~${i}s (sheet standing); sheets=$(sheets)"
note "    b) does ANY row in the DB move while the sheet stands? (Meta/TMSettings census)"
gt "SELECT key, substr(value,1,40) AS value FROM Meta" | sed 's/^/       /' | tee -a "$REPORT"
note "    c) the AppleScript mutation-vs-read split measured in M1 is the mechanistic"
note "       proxy: a gate that blocks the app's scripting MUTATION path but not its"
note "       reads is the same shape a gated sync-out queue would have."
dismiss >/dev/null
lab_ssh "$IP" 'sleep 8' </dev/null
note "    d) after dismissal — rows: $(nrows); sheets: $(sheets)"
note "  beeps:"; bs assert --name M6 2>&1 | tail -6 | sed 's/^/    /' | tee -a "$REPORT"
fi

# ==================================================================== M7
if has M7; then
cell "M7 — SHEET STACKING (run LAST: it turns uriSchemeEnabled OFF)"
bmark "M7"
resetapp
note "  [M7a] a SECOND Items▸Repeat… with a sheet already standing"
opensheet "$U_HOST" "m7a-first-sheet" || note "  WARN: first sheet did not open"
R=$(axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1')
sleep 2
note "    second Repeat… attempt: $(echo "$R" | tr '\n' ' ')"
note "    sheets now: $(sheets)"
sheetsfull | sed 's/^/      /' | tee -a "$REPORT"

note ""
note "  [M7b] ⌘⌫ (trash) on the standing sheet's window"
axq 'tell application "System Events" to key code 51 using command down' >/dev/null
sleep 2
note "    sheets now: $(sheets)"

note ""
note "  [M7c] Empty Trash (⌘⇧⌫) with a sheet standing — does its confirm sheet stack?"
axq 'tell application "System Events" to key code 51 using {command down, shift down}' >/dev/null
sleep 3
note "    sheets now: $(sheets)"
sheetsfull | sed 's/^/      /' | tee -a "$REPORT"
sheetdump "m7c-after-emptytrash"
dismiss >/dev/null; dismiss >/dev/null

note ""
note "  [M7d] the PROVEN stacker: URL scheme DISABLED -> the app's own consent sheet"
note "        (URLEN1: uriSchemeEnabled lives in the group-container prefs plist)"
resetapp
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; pkill -x Things3 >/dev/null 2>&1; sleep 4' </dev/null
PL=$(lab_ssh "$IP" 'ls ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/*.plist 2>/dev/null | head -1' </dev/null)
note "        prefs plist: $PL"
lab_ssh "$IP" "defaults write \"${PL%.plist}\" uriSchemeEnabled -bool false" </dev/null 2>&1 | sed 's/^/        /' | tee -a "$REPORT"
resetapp
note "        uriSchemeEnabled now: $(lab_ssh "$IP" "defaults read \"${PL%.plist}\" uriSchemeEnabled 2>&1" </dev/null)"
opensheet "$U_HOST" "m7d-repeat-sheet" || note "        WARN: Repeat sheet did not open"
note "        now dispatch TWO mutating URLs behind the standing Repeat sheet:"
lab_ssh "$IP" "open -g 'things:///add?title=MODALX1-m7-stack-1&auth-token=$TOKEN'; sleep 4" </dev/null >/dev/null 2>&1
note "        sheets after URL #1: $(sheets)"
lab_ssh "$IP" "open -g 'things:///add?title=MODALX1-m7-stack-2&auth-token=$TOKEN'; sleep 4" </dev/null >/dev/null 2>&1
note "        sheets after URL #2: $(sheets)"
sheetsfull | sed 's/^/          /' | tee -a "$REPORT"
sheetdump "m7d-stacked"
axdump "m7d-stacked-windows"
note "        focus / frontmost with the stack up:"; ax focus | sed 's/^/          /' | tee -a "$REPORT"
note "        menu-bar liveness with the stack up: $(ax menuenabled)"

note ""
note "  [M7e] DISMISSAL ORDER — Escape once at a time, censusing between"
for k in 1 2 3 4; do
  axq 'tell application "Things3" to activate' >/dev/null
  axq 'tell application "System Events" to key code 53' >/dev/null
  sleep 2
  note "        Escape #$k -> $(sheets)"
  sheetsfull | sed -n '2,5p' | sed 's/^/          /' | tee -a "$REPORT"
done
note "        rows after the stack was cleared:"
rowsof | sed 's/^/          /' | tee -a "$REPORT"
note "        (did the parked URL adds land? MODALX1-m7-stack-* rows above)"
note "  restoring uriSchemeEnabled=true"
lab_ssh "$IP" "defaults write \"${PL%.plist}\" uriSchemeEnabled -bool true" </dev/null >/dev/null 2>&1
resetapp
note "  beeps:"; bs assert --name M7 2>&1 | tail -12 | sed 's/^/    /' | tee -a "$REPORT"
fi

# ==================================================================== closeout
cell "CLOSEOUT"
note "  app alive: $(alive)"
note "  crash reports: $CRASH0 -> $(crashes)"
note "  final sheet census: $(sheets)"
note "  final MODALX1 rows:"
rowsof | sed 's/^/    /' | tee -a "$REPORT"
note ""
note "  TOTAL BEEPS FOR THE RUN:"
bs assert --name modalx1-run --json /Users/admin/labh/beeps.json 2>&1 | tail -20 | sed 's/^/    /' | tee -a "$REPORT"
note ""
note "  asserts: PASS=$PASS FAIL=$FAIL"
note "  report: $REPORT"
