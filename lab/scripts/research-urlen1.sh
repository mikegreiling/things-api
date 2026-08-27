#!/bin/bash
# URLEN1 — Things' own "Enable Things URLs" setting: where it lives, whether it
# is PROMPT-FREE to read, and exactly what a disabled state does to each URL verb.
#
# THE PROBLEM (#611). On a freshly onboarded machine a URL-vector mutation
# reported `verify-failed:silent-noop` — Things persisted nothing. The suspected
# cause: Things' Settings ▸ General ▸ "Enable Things URLs" was still OFF, which
# is the default on a fresh install. The CLI dispatches URL mutations blind, so
# the whole vector no-ops and the failure carries no hypothesis. Worse, the app
# raises its OWN enable prompt at some point mid-session — a modal outside our
# two setup ceremonies, which is exactly what the permissions doctrine forbids.
#
# WHAT MUST BE MEASURED (in this order — the fix depends on each answer):
#   GOLD   The golden's DEFAULT state, and why the rig has never hit this.
#   PREF   Where the toggle durably lives. Flip it via AX and diff every
#          preferences surface the app owns: ~/Library/Preferences, the
#          -currentHost domain, the group container's Preferences dir, the
#          app-sandbox container, and the TMSettings row in the database.
#   FREE   Is reading that key PROMPT-FREE from a non-FDA, non-app process? The
#          doctrine forbids a probe that could raise a dialog, so the read path
#          the fix ships must be MEASURED free, not assumed free.
#   OFF-*  The disabled-state characterization, one cell per verb:
#            OFF-ADD   things:///add                (no auth token needed)
#            OFF-UPD   things:///update?auth-token= (token-gated verb)
#            OFF-JSON  things:///json?auth-token=   (batch)
#            OFF-SHOW  things:///show?id=           (a READ-ONLY navigation URL)
#          Each: row-level DB delta (expected ZERO), AX window census either side
#          (does the app's own enable prompt fire? on which trigger?), beeps.
#   OFF-2  Does the prompt fire on the FIRST url only, or on every one?
#   OFF-FG Does a FOREGROUND `open` (vs `open -g`) change the trigger?
#   OFF-CLI Does the SHIPPED CLI reproduce #611 — a `todo update` that reports
#          verify-failed:silent-noop with the toggle off?
#   REEN   Flip back ON; the same add lands. Proves the toggle is the variable.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (Things 3.23 / dbv27; the
# golden is NEVER booted). Airgapped, clock pinned 2026-07-05 — the TRIAL WALL is
# 2026-07-18 and this campaign NEVER rolls the clock. Fixtures fully synthetic
# (URLEN1-*). Beep sentinel on (report-only per driver convention; counts printed).
# AX-drive scrutiny law: the Settings pane's FULL control inventory is dumped
# before and after every input.
#
# Usage:  lab/scripts/research-urlen1.sh setup
#         lab/scripts/research-urlen1.sh run
#         lab/scripts/research-urlen1.sh teardown
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-urlen1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="${OUT:-lab/artifacts/$VM}"; mkdir -p "$OUT/ax" "$OUT/pref" "$OUT/log"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"
CMD="${1:-run}"

note() { echo "[urlen1] $*" | tee -a "$REPORT"; }
PASS=0; FAIL=0
cell() { note ""; note "========== $1 =========="; }
verdict_eq() { if [ "$(echo "$3" | tr -d '[:space:]')" = "$(echo "$2" | tr -d '[:space:]')" ]; then note "  PASS $1 (= $2)"; PASS=$((PASS+1));
  else note "  FAIL $1 — expected exactly '$2', got: '$3'"; FAIL=$((FAIL+1)); fi; }

scpO() { lab_scp "$@"; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

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
function label(el){return [sv(el,'AXTitle'),sv(el,'AXDescription'),sv(el,'AXValue'),sv(el,'AXIdentifier')].join(' ')}
function line(el,d,ix){
  var p=['['+ix+'] role='+sv(el,'AXRole')]
  var s=sv(el,'AXSubrole'); if(s)p.push('sub='+s)
  var t=sv(el,'AXTitle'); if(t)p.push('ttl='+t)
  var de=sv(el,'AXDescription'); if(de)p.push('desc='+de.slice(0,140))
  var v=sv(el,'AXValue'); if(v)p.push('val='+String(v).slice(0,140))
  var id=sv(el,'AXIdentifier'); if(id)p.push('id='+id)
  var en=sv(el,'AXEnabled'); if(en==='false')p.push('DISABLED')
  var f=frame(el); if(f.x!==null)p.push('@['+f.x+','+f.y+' '+f.w+'x'+f.h+']')
  return Array(d+1).join('  ')+p.join(' | ')}
function walk(el,d,acc,ix){acc.push(line(el,d,ix)); if(d>16)return acc; var ch=kids(el); for(var i=0;i<ch.length;i++)walk(ch[i],d+1,acc,i+1); return acc}
function clickPt(x,y){var pt=$.CGPointMake(x,y)
  function post(t){$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent($(),t,pt,$.kCGMouseButtonLeft))}
  post($.kCGEventMouseMoved); delay(0.3); post($.kCGEventLeftMouseDown); delay(0.12); post($.kCGEventLeftMouseUp)}
function run(argv){
  var cmd=argv[0]||'dump'
  var app=$.AXUIElementCreateApplication(pidOf('Things3'))
  if(cmd==='dump'){
    var ws=kids(app), acc=[]
    for(var i=0;i<ws.length;i++){var w=ws[i], f=frame(w)
      acc.push('=== WINDOW '+(i+1)+' sub='+sv(w,'AXSubrole')+' ttl='+sv(w,'AXTitle')+' id='+sv(w,'AXIdentifier')+' @['+f.x+','+f.y+' '+f.w+'x'+f.h+'] ===')
      walk(w,0,acc,i+1)}
    if(!acc.length)acc.push('(no windows)')
    return acc.join('\n')}
  if(cmd==='wins'){
    var ws2=kids(app), out2=[]
    for(var j=0;j<ws2.length;j++){var w2=ws2[j]
      out2.push('WINDOW '+(j+1)+' sub='+sv(w2,'AXSubrole')+' ttl='+JSON.stringify(sv(w2,'AXTitle'))+' modal='+sv(w2,'AXModal')+' id='+sv(w2,'AXIdentifier'))}
    return out2.length?out2.join('\n'):'(no windows)'}
  var all=[]; flat(app,all,0)
  if(cmd==='find'){
    var nd=argv[1], out=[]
    for(var i=0;i<all.length;i++){ if(label(all[i]).toLowerCase().indexOf(nd.toLowerCase())>=0){ out.push(line(all[i],0,i)) } }
    return out.length?out.join('\n'):'NO ELEMENT matching "'+nd+'"'}
  if(cmd==='checkboxes'){
    var cbs=all.filter(function(e){return sv(e,'AXRole')==='AXCheckBox'})
    return cbs.map(function(e,i){return (i+1)+': ttl='+JSON.stringify(sv(e,'AXTitle'))+' val='+sv(e,'AXValue')+' id='+sv(e,'AXIdentifier')+' desc='+JSON.stringify(sv(e,'AXDescription'))}).join('\n')||'NO CHECKBOX'}
  if(cmd==='press'){
    var want=argv[1]
    var btns=all.filter(function(e){var r=sv(e,'AXRole');return r==='AXButton'||r==='AXRadioButton'||r==='AXCheckBox'})
    var names=btns.map(function(e){return sv(e,'AXRole')+':'+(sv(e,'AXTitle')||sv(e,'AXDescription')||'?')+'#'+sv(e,'AXIdentifier')})
    for(var i=0;i<btns.length;i++){
      if(sv(btns[i],'AXTitle')===want||sv(btns[i],'AXIdentifier')===want||sv(btns[i],'AXDescription')===want){
        var before=sv(btns[i],'AXValue')
        var rc=$.AXUIElementPerformAction(btns[i],$('AXPress'))
        delay(0.8)
        return 'PRESSED "'+want+'" (AXError='+rc+') value '+before+' -> '+sv(btns[i],'AXValue')+'; present: '+names.join(' | ')}}
    return 'NO CONTROL "'+want+'" — present: '+names.join(' | ')}
  if(cmd==='sheets'){  // THE MODAL ORACLE. The app's "Things URL Scheme" alert is
    // an AXSheet on the main window, NOT a window — a window census is blind to
    // it, which is exactly how phase 1 mis-read the disabled arm as a silent drop.
    var sh=all.filter(function(e){return sv(e,'AXRole')==='AXSheet'})
    if(!sh.length) return 'SHEETS=0'
    var out3=['SHEETS='+sh.length]
    for(var k=0;k<sh.length;k++){
      var sub3=[]; flat(sh[k],sub3,0)
      var txt=sub3.filter(function(e){return sv(e,'AXRole')==='AXStaticText'}).map(function(e){return sv(e,'AXValue')})
      var bt=sub3.filter(function(e){return sv(e,'AXRole')==='AXButton'}).map(function(e){return sv(e,'AXTitle')+'#'+sv(e,'AXIdentifier')})
      out3.push('  SHEET '+(k+1)+' desc='+JSON.stringify(sv(sh[k],'AXDescription'))+' text='+JSON.stringify(txt.join(' | '))+' buttons='+bt.join(', '))}
    return out3.join('\n')}
  if(cmd==='readcb'){
    var t3=argv[1]
    var h3=all.filter(function(e){return sv(e,'AXRole')==='AXCheckBox' && sv(e,'AXTitle')===t3})
    return h3.length?('VALUE='+sv(h3[0],'AXValue')):'NO CHECKBOX titled "'+t3+'"'}
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
  scpO lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/things-lab/run/beep-sentinel.sh" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/run/beep-sentinel.sh' </dev/null

  # ---- the AX tool (SYNCX1 recipe + a checkbox/window census) --------------
  lab_ssh "$IP" 'cat > ~/labh/axtool.jxa' <<<"$AXTOOL"

  # ---- the preferences census: every surface the app could store it in -----
  lab_ssh "$IP" 'cat > ~/labh/prefdump.sh && chmod +x ~/labh/prefdump.sh' <<'EOF'
#!/bin/bash
# A stable, diffable dump of every preferences surface Things owns, plus the
# TMSettings row. Each section is prefixed so a diff names WHICH surface moved.
D=com.culturedcode.ThingsMac
echo "### defaults-read-$D"
defaults read "$D" 2>&1 | sed 's/^/  /'
echo "### defaults-read-currentHost-$D"
defaults -currentHost read "$D" 2>&1 | sed 's/^/  /'
echo "### file-list-Preferences"
ls -1 ~/Library/Preferences/ 2>/dev/null | grep -i culturedcode | sed 's/^/  /'
echo "### plist-user-Preferences"
plutil -p ~/Library/Preferences/$D.plist 2>&1 | sed 's/^/  /'
echo "### file-list-group-container-Preferences"
ls -1 ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/ 2>/dev/null | sed 's/^/  /'
echo "### plist-group-container"
for f in ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/*.plist; do
  [ -e "$f" ] || continue
  echo "  -- $(basename "$f")"
  plutil -p "$f" 2>&1 | sed 's/^/    /'
done
echo "### file-list-container"
ls -1 ~/Library/Containers/$D/Data/Library/Preferences/ 2>/dev/null | sed 's/^/  /'
echo "### plist-container"
for f in ~/Library/Containers/$D/Data/Library/Preferences/*.plist; do
  [ -e "$f" ] || continue
  echo "  -- $(basename "$f")"
  plutil -p "$f" 2>&1 | sed 's/^/    /'
done
echo "### TMSettings"
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
sqlite3 -noheader -line "file:$DB?mode=ro" "SELECT * FROM TMSettings" 2>&1 | sed 's/^/  /'
EOF

  note "warm-up launch/quit/relaunch (background only)"
  lab_ssh "$IP" 'open -g -a Things3; sleep 16; osascript -e "tell application \"Things3\" to quit"; sleep 4; open -g -a Things3; sleep 14' </dev/null

  TOKEN=$(lab_ssh "$IP" "~/labh/gsql.sh -q 'SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1'" </dev/null)
  echo "IP=$IP" > "$SESSION"; echo "TOKEN=$TOKEN" >> "$SESSION"
  note "auth token in hand (${#TOKEN} chars)"

  TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
  TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
  MOS=$(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)
  note "env: Things $TVER ($TBLD) / macOS $MOS / golden $GOLDEN"
  { echo "TVER=$TVER"; echo "TBLD=$TBLD"; echo "MOS=$MOS"; } >> "$SESSION"

  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  COMMANDER=$(node -e "console.log(require('node:path').dirname(require.resolve('commander')))")
  scpO -r "$COMMANDER" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
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

# Re-push the AX tool on every run, so a later phase always drives the CURRENT
# oracle rather than whatever shape setup happened to ship (the sheet census was
# added mid-campaign, after the window census was caught being blind to it).
lab_ssh "$IP" 'cat > ~/labh/axtool.jxa' <<<"$AXTOOL"

CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
gq()  { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt()  { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
G()   { lab_ssh "$IP" "$LAB_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
ax()  { lab_ssh "$IP" "osascript -l JavaScript ~/labh/axtool.jxa $(printf '%q' "${1:-dump}") $(printf '%q' "${2:-}") $(printf '%q' "${3:-}")" </dev/null 2>&1; }
axdump(){ ax dump > "$OUT/ax/$1.txt"; note "  [axdump $1: $(wc -l <"$OUT/ax/$1.txt"|tr -d ' ') lines, $(grep -c '^=== WINDOW' "$OUT/ax/$1.txt") windows]"; }
wins(){ ax wins; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
pref(){ lab_ssh "$IP" 'bash ~/labh/prefdump.sh' </dev/null > "$OUT/pref/$1.txt" 2>&1; note "  [prefdump $1: $(wc -l <"$OUT/pref/$1.txt"|tr -d ' ') lines]"; }
prefdiff(){ note "  ---- PREF DELTA $1 -> $2 ----"; diff -u "$OUT/pref/$1.txt" "$OUT/pref/$2.txt" | sed -n '3,240p' | sed 's/^/    /' | tee -a "$REPORT"; }
bs()    { lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/things-lab/run/beep-sentinel.sh $*" </dev/null 2>&1; }
bmark() { lab_ssh "$IP" "~/things-lab/run/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }
alive(){ lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null; }
crashes(){ lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | grep -c "^Things3-.*\.ips$" | tr -d " "' </dev/null; }
quitapp(){ lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 5; true' </dev/null; }
launch(){ lab_ssh "$IP" 'open -a Things3; sleep 20; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 3; true' </dev/null; }
relaunch(){ quitapp; launch; }
# RESID1: ⌘, only opens Settings reliably from a CLEAN window state.
settings(){ lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to keystroke "," using command down'\''; sleep 5; true' </dev/null; }
closewin(){ lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to keystroke "w" using command down'\''; sleep 2; true' </dev/null; }
rows(){ gq "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'URLEN1%'"; }
rowlist(){ gt "SELECT substr(uuid,1,8) AS uuid, title, trashed, status, COALESCE(notes,'') AS notes FROM TMTask WHERE title LIKE 'URLEN1%' ORDER BY creationDate"; }
openurl(){ lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null 2>&1; sleep 5; }

note ""
note "################ URLEN1 RUN $(date -u +%Y-%m-%dT%H:%M:%SZ) ################"
note "env: Things ${TVER:-?} (${TBLD:-?}) / macOS ${MOS:-?} / golden $GOLDEN / VM $VM @ $IP"
bs reset >/dev/null

CRASH0=$(crashes)
note "crash reports at start: $CRASH0"
CBTITLE="${CBTITLE:-Enable Things URLs}"

if [ "$CMD" = "run" ]; then
# ---------------------------------------------------------------- CELL GOLD
cell "GOLD — the golden's DEFAULT state, before anything is touched"
pref baseline
note "  every line of the baseline dump mentioning url/scheme/uri:"
grep -in "url\|scheme\|uri" "$OUT/pref/baseline.txt" | sed 's/^/    /' | tee -a "$REPORT"

bmark "GOLD-add"
B4=$(rows)
openurl "things:///add?title=URLEN1-gold-alpha"
A1=$(rows)
note "  rows URLEN1%: $B4 -> $A1"
verdict_eq "GOLD/url-add lands on the untouched golden" "1" "$A1"
note "  window census after:"; wins | sed 's/^/    /' | tee -a "$REPORT"

# ---------------------------------------------------------------- CELL PREF
cell "PREF — find the toggle's durable home (AX flip + preferences diff)"
relaunch
settings
axdump settings-general-before
note "  General-pane checkbox inventory (BEFORE any input):"
ax checkboxes | sed 's/^/    /' | tee -a "$REPORT"
note "  elements mentioning 'URL':"
ax find "URL" | sed 's/^/    /' | tee -a "$REPORT"
note "  reading the toggle by title '$CBTITLE': $(ax readcb "$CBTITLE")"

bmark "PREF-flip-off"
note "  pressing '$CBTITLE' (expect 1 -> 0):"
ax press "$CBTITLE" | sed 's/^/    /' | tee -a "$REPORT"
sleep 2
note "  AX inventory AFTER the input (AX-drive scrutiny law — full re-audit):"
axdump settings-general-after
ax checkboxes | sed 's/^/    /' | tee -a "$REPORT"
note "  window census after the flip:"; wins | sed 's/^/    /' | tee -a "$REPORT"

closewin
sleep 2
pref urls-off
prefdiff baseline urls-off

note "  --- durability: does the value survive an app quit? ---"
relaunch
pref urls-off-relaunched
prefdiff urls-off urls-off-relaunched
settings
note "  toggle value after relaunch: $(ax readcb "$CBTITLE")"
closewin

# ---------------------------------------------------------------- CELL FREE
cell "FREE — is the key readable PROMPT-FREE from a plain, non-app process?"
note "  plain \`defaults read\` of the user domain (sshd-descended shell, no FDA):"
lab_ssh "$IP" 'defaults read com.culturedcode.ThingsMac 2>&1' </dev/null | sed 's/^/    /' | tee -a "$REPORT"
note "  per-key reads of every candidate:"
for K in ${CANDIDATE_KEYS:-URLSchemeEnabled EnableURLScheme URLScheme ThingsURLsEnabled URLSchemeIsEnabled}; do
  note "    $K = $(lab_ssh "$IP" "defaults read com.culturedcode.ThingsMac $K 2>&1" </dev/null)"
done
note "  window census after the reads (a dialog here would be a doctrine breach):"
wins | sed 's/^/    /' | tee -a "$REPORT"

# ---------------------------------------------------------------- CELL OFF-*
cell "OFF-ADD — things:///add with the toggle OFF"
bmark "OFF-ADD"
W0=$(wins); B4=$(rows)
openurl "things:///add?title=URLEN1-off-add"
A1=$(rows); W1=$(wins)
note "  rows URLEN1%: $B4 -> $A1"
note "  windows before:"; echo "$W0" | sed 's/^/    /' | tee -a "$REPORT"
note "  windows after: "; echo "$W1" | sed 's/^/    /' | tee -a "$REPORT"
verdict_eq "OFF-ADD is a silent no-op (zero DB delta)" "$B4" "$A1"
axdump off-add-after

cell "OFF-UPD — things:///update?auth-token= with the toggle OFF"
TARGET=$(gq "SELECT uuid FROM TMTask WHERE title='URLEN1-gold-alpha' LIMIT 1")
note "  target uuid: ${TARGET:-<none>}"
NOTES0=$(gq "SELECT COALESCE(notes,'<null>') FROM TMTask WHERE uuid='$TARGET'")
bmark "OFF-UPD"
openurl "things:///update?auth-token=$TOKEN&id=$TARGET&notes=URLEN1-replacement-notes"
NOTES1=$(gq "SELECT COALESCE(notes,'<null>') FROM TMTask WHERE uuid='$TARGET'")
note "  notes: '$NOTES0' -> '$NOTES1'"
verdict_eq "OFF-UPD leaves notes untouched" "$NOTES0" "$NOTES1"
note "  windows after:"; wins | sed 's/^/    /' | tee -a "$REPORT"
axdump off-upd-after

cell "OFF-JSON — things:///json batch with the toggle OFF"
lab_ssh "$IP" 'cat > ~/labh/tjson.sh && chmod +x ~/labh/tjson.sh' <<'EOF'
#!/bin/bash
URL=$(python3 -c 'import sys,urllib.parse; print("things:///json?auth-token="+sys.argv[1]+"&data="+urllib.parse.quote(sys.argv[2],safe=""))' "$1" "$2")
open -g "$URL"
EOF
bmark "OFF-JSON"
B4=$(rows)
lab_ssh "$IP" "~/labh/tjson.sh $(printf '%q' "$TOKEN") $(printf '%q' '[{"type":"to-do","attributes":{"title":"URLEN1-off-json"}}]')" </dev/null
sleep 5
A1=$(rows)
note "  rows URLEN1%: $B4 -> $A1"
verdict_eq "OFF-JSON is a silent no-op" "$B4" "$A1"
note "  windows after:"; wins | sed 's/^/    /' | tee -a "$REPORT"
axdump off-json-after

cell "OFF-SHOW — things:///show (a READ-ONLY navigation URL) with the toggle OFF"
bmark "OFF-SHOW"
openurl "things:///show?id=today"
note "  windows after:"; wins | sed 's/^/    /' | tee -a "$REPORT"
note "  frontmost app: $(axq 'tell application "System Events" to get name of first process whose frontmost is true')"
axdump off-show-after

cell "OFF-2 — a SECOND add: does a prompt fire once, or every time?"
bmark "OFF-2"
B4=$(rows)
openurl "things:///add?title=URLEN1-off-add-2"
A1=$(rows)
note "  rows URLEN1%: $B4 -> $A1"
note "  windows after:"; wins | sed 's/^/    /' | tee -a "$REPORT"
axdump off-2-after

cell "OFF-FG — the same add in the FOREGROUND (plain \`open\`, not \`open -g\`)"
bmark "OFF-FG"
B4=$(rows)
lab_ssh "$IP" "open 'things:///add?title=URLEN1-off-add-fg'" </dev/null 2>&1
sleep 7
A1=$(rows)
note "  rows URLEN1%: $B4 -> $A1"
note "  windows after:"; wins | sed 's/^/    /' | tee -a "$REPORT"
axdump off-fg-after

cell "OFF-CLI — does the SHIPPED CLI reproduce #611 with the toggle OFF?"
note "  \`things doctor\` (vector table) with URLs disabled:"
G doctor | sed 's/^/    /' | tee -a "$REPORT"
bmark "OFF-CLI"
note "  \`things add\` (URL vector):"
G "add 'URLEN1-cli-add' --json" | sed 's/^/    /' | tee -a "$REPORT"
note "  rows now: $(rows)"
note "  \`things todo update\` on the GOLD row (the #611 shape):"
G "todo update $TARGET --notes 'URLEN1-cli-notes' --json" | sed 's/^/    /' | tee -a "$REPORT"
note "  notes now: $(gq "SELECT COALESCE(notes,'<null>') FROM TMTask WHERE uuid='$TARGET'")"

# ---------------------------------------------------------------- CELL FRESH
# The #611 state proper: a FRESH install has never toggled the setting, so the
# key is ABSENT rather than 0. The doctrine's vector table claims the app then
# "holds the first URL command behind its own enable dialog" — that claim has
# never been measured. Reproduce the absent-key state by deleting the key with
# the app quit (cfprefsd must be restarted or it rewrites the cached value).
cell "FRESH — the never-toggled state (key ABSENT, as on a fresh install)"
quitapp
GCPREFS='/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac'
lab_ssh "$IP" "defaults delete $(printf '%q' "$GCPREFS") uriSchemeEnabled 2>&1; defaults delete com.culturedcode.ThingsMac uriSchemeEnabled 2>&1; killall cfprefsd 2>/dev/null; sleep 2; true" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
pref fresh-keyless
prefdiff urls-off-relaunched fresh-keyless
note "  per-key read with the key deleted: $(lab_ssh "$IP" "defaults read $(printf '%q' "$GCPREFS") uriSchemeEnabled 2>&1" </dev/null)"
launch
note "  windows after a cold launch in the keyless state:"; wins | sed 's/^/    /' | tee -a "$REPORT"
settings
note "  toggle value with the key absent: $(ax readcb "$CBTITLE")"
closewin
sleep 2

bmark "FRESH-add"
B4=$(rows)
openurl "things:///add?title=URLEN1-fresh-add"
A1=$(rows)
note "  rows URLEN1%: $B4 -> $A1"
note "  windows after the FIRST url in a never-toggled install:"; wins | sed 's/^/    /' | tee -a "$REPORT"
axdump fresh-add-after
note "  frontmost app: $(axq 'tell application "System Events" to get name of first process whose frontmost is true')"
note "  \`things doctor\` availability line in the keyless state:"
G doctor | grep -i "url" | sed 's/^/    /' | tee -a "$REPORT"
note "  key value after the first url (did the app WRITE one?): $(lab_ssh "$IP" "defaults read $(printf '%q' "$GCPREFS") uriSchemeEnabled 2>&1" </dev/null)"

bmark "FRESH-add-2"
B4=$(rows)
openurl "things:///add?title=URLEN1-fresh-add-2"
A1=$(rows)
note "  SECOND url: rows $B4 -> $A1"
note "  windows after the second url:"; wins | sed 's/^/    /' | tee -a "$REPORT"
axdump fresh-add2-after
note "  dismissing anything modal (Esc), then re-censusing:"
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 2; true' </dev/null
wins | sed 's/^/    /' | tee -a "$REPORT"

# ---------------------------------------------------------------- CELL REEN
cell "REEN — flip the toggle back ON; the same add must land"
relaunch
settings
note "  toggle value before re-enable: $(ax readcb "$CBTITLE")"
bmark "REEN-flip-on"
ax press "$CBTITLE" | sed 's/^/    /' | tee -a "$REPORT"
sleep 2
note "  toggle value after re-enable: $(ax readcb "$CBTITLE")"
closewin
pref urls-on
prefdiff urls-off-relaunched urls-on

bmark "REEN-add"
B4=$(rows)
openurl "things:///add?title=URLEN1-reen-add"
A1=$(rows)
note "  rows URLEN1%: $B4 -> $A1"
verdict_eq "REEN/url-add lands again once the toggle is ON" "$((B4+1))" "$A1"

note "  final row list:"
rowlist | sed 's/^/    /' | tee -a "$REPORT"

fi  # ---- end phase 1 ----------------------------------------------------------

# ============================================================== PHASE 2 (run2)
# PHASE 1 measured the two states the golden can reach by flipping the Settings
# checkbox — ON and explicitly-OFF — and found the OFF state to be a TOTALLY
# SILENT DROP: no dialog, no park, zero delta. It could NOT reproduce the
# never-asked state (#611's field report: a first-use "Things URL Scheme"
# dialog with Cancel/Enable, behind which the dispatched request PARKS):
# deleting `uriSchemeEnabled` from the prefs plist left the app behaving exactly
# as explicitly-off, with no dialog. Phase 2 nukes the WHOLE group-container
# preferences plist — the closest a clone can get to a fresh install without a
# fresh user account — and, if the dialog appears, measures the PARK and whether
# a parked request APPLIES LATE once Enable is clicked.
if [ "$CMD" = "run2" ]; then
GCPREFS_FILE='/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist'
# A HARD reset of window state: RESID1's ⌘, flake is stale-window state, and
# phase 1 accumulated several Today windows driving the AX layer unreliable.
hardreset(){
  lab_ssh "$IP" 'pkill -x Things3 >/dev/null 2>&1; sleep 4; open -a Things3; sleep 22; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 3; true' </dev/null
}

cell "P2-RESET — hard window reset, then re-read the toggle with the key ABSENT"
hardreset
note "  windows after the hard reset:"; wins | sed 's/^/    /' | tee -a "$REPORT"
settings
note "  Settings windows:"; wins | sed 's/^/    /' | tee -a "$REPORT"
note "  checkbox inventory with uriSchemeEnabled ABSENT:"
ax checkboxes | sed 's/^/    /' | tee -a "$REPORT"
note "  toggle value: $(ax readcb "$CBTITLE")"
closewin

cell "P2-NUKE — delete the ENTIRE group-container prefs plist (fresh-install proxy)"
quitapp
lab_ssh "$IP" "ls -l $(printf '%q' "$GCPREFS_FILE"); mv $(printf '%q' "$GCPREFS_FILE") /Users/admin/labh/prefs-backup.plist && echo MOVED; killall cfprefsd 2>/dev/null; sleep 3; ls -l $(printf '%q' "$GCPREFS_FILE") 2>&1 | tail -1" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
bmark "P2-NUKE-launch"
hardreset
note "  windows after a cold launch with NO prefs plist:"; wins | sed 's/^/    /' | tee -a "$REPORT"
axdump p2-nuke-launch
pref p2-nuked
note "  every line of the post-nuke dump mentioning url/scheme/uri:"
grep -in "url\|scheme\|uri" "$OUT/pref/p2-nuked.txt" | sed 's/^/    /' | tee -a "$REPORT"

cell "P2-FIRST — the FIRST url after the nuke: dialog? park? drop?"
bmark "P2-FIRST"
B4=$(rows)
# Foreground `open`, so nothing about backgrounding can suppress a modal.
lab_ssh "$IP" "open 'things:///add?title=URLEN1-p2-first'" </dev/null 2>&1
sleep 8
A1=$(rows)
note "  rows URLEN1%: $B4 -> $A1"
note "  window census 8s after the url:"; wins | sed 's/^/    /' | tee -a "$REPORT"
axdump p2-first-after
note "  any element mentioning 'Enable':"; ax find "Enable" | sed 's/^/    /' | tee -a "$REPORT"
note "  any element mentioning 'URL':"; ax find "URL" | sed 's/^/    /' | tee -a "$REPORT"
note "  frontmost app: $(axq 'tell application "System Events" to get name of first process whose frontmost is true')"

cell "P2-PARK — does a dispatched request PARK behind the dialog, and APPLY LATE?"
# ONE ssh invocation carries the whole gesture, so no guest process is ever
# orphaned: fire the CLI write in the background, census while it runs, press
# Enable if a dialog is standing, then reap the CLI and print its verdict.
bmark "P2-PARK"
B4=$(rows)
lab_ssh "$IP" "cd ~; ($LAB_DIRECT $CLI add 'URLEN1-p2-park' --json > /tmp/park.json 2>&1; echo \"EXIT=\$?\" >> /tmp/park.json) & CLIPID=\$!; sleep 6; echo '--- census while the write is in flight ---'; osascript -l JavaScript ~/labh/axtool.jxa wins; echo '--- pressing Enable ---'; osascript -l JavaScript ~/labh/axtool.jxa press Enable; sleep 4; wait \$CLIPID; echo '--- the CLI verdict ---'; cat /tmp/park.json" </dev/null 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
sleep 6
A1=$(rows)
note "  rows URLEN1%: $B4 -> $A1"
note "  key value after the Enable press: $(lab_ssh "$IP" "defaults read $(printf '%q' "${GCPREFS_FILE%.plist}") uriSchemeEnabled 2>&1 | tail -1" </dev/null)"
note "  final row list:"; rowlist | sed 's/^/    /' | tee -a "$REPORT"
note "  windows after:"; wins | sed 's/^/    /' | tee -a "$REPORT"
axdump p2-park-after

cell "P2-AFTER — with the dialog answered, does a plain url land immediately?"
bmark "P2-AFTER"
B4=$(rows)
openurl "things:///add?title=URLEN1-p2-after"
A1=$(rows)
note "  rows URLEN1%: $B4 -> $A1"
verdict_eq "P2-AFTER/url-add lands once the first-use dialog is answered" "$((B4+1))" "$A1"
pref p2-answered
note "  every line of the answered-state dump mentioning url/scheme/uri:"
grep -in "url\|scheme\|uri" "$OUT/pref/p2-answered.txt" | sed 's/^/    /' | tee -a "$REPORT"
note "  final row list:"; rowlist | sed 's/^/    /' | tee -a "$REPORT"
fi  # ---- end phase 2 ----------------------------------------------------------

# ============================================================== PHASE 3 (run3)
# THE CORRECTION. Phase 1 read the explicitly-disabled arm as a TOTALLY SILENT
# DROP on the strength of a window census — and the census was BLIND: the app's
# "Things URL Scheme" alert is an AXSheet attached to the main window, not a
# window, so `AXChildren`-of-the-app never lists it. Re-reading phase 1's AX
# dumps shows the sheet present from the very first disabled `add` and one MORE
# sheet accumulating per URL (1,2,3,3,4,5 — `show` adds none), which also
# explains phase 1's later flakiness: stacked modal sheets swallow ⌘, and ⌘W
# (17 beeps) and block a graceful quit. Phase 3 re-measures that arm CLEANLY,
# from a force-killed relaunch with zero sheets standing, using a sheet-aware
# oracle, and asks the two questions the correction opens: what does CANCEL do,
# and does a request parked in the DISABLED arm also apply late on Enable?
if [ "$CMD" = "run3" ]; then
GCDOMAIN='/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac'
hardreset(){
  lab_ssh "$IP" 'pkill -x Things3 >/dev/null 2>&1; sleep 4; open -a Things3; sleep 22; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 3; true' </dev/null
}
sheets(){ ax sheets; }
setkey(){ lab_ssh "$IP" "defaults write $(printf '%q' "$GCDOMAIN") uriSchemeEnabled -bool $1; killall cfprefsd 2>/dev/null; sleep 2; true" </dev/null; }
readkey(){ lab_ssh "$IP" "defaults read $(printf '%q' "$GCDOMAIN") uriSchemeEnabled 2>&1 | tail -1" </dev/null; }

cell "P3-SETUP — force the DISABLED state and reach a clean, sheet-free app"
quitapp
setkey false
hardreset
note "  key: $(readkey)"
note "  sheets standing before anything is dispatched:"; sheets | sed 's/^/    /' | tee -a "$REPORT"

cell "P3-DIS1 — ONE url mutation in the explicitly-disabled state"
bmark "P3-DIS1"
B4=$(rows)
openurl "things:///add?title=URLEN1-p3-dis1"
A1=$(rows)
note "  rows URLEN1%: $B4 -> $A1"
verdict_eq "P3-DIS1 lands nothing at dispatch time" "$B4" "$A1"
note "  sheet census (the oracle a window census cannot see):"; sheets | sed 's/^/    /' | tee -a "$REPORT"
note "  window census, for the contrast:"; wins | sed 's/^/    /' | tee -a "$REPORT"
axdump p3-dis1

cell "P3-CANCEL — what does Cancel do to the parked request, and to the key?"
bmark "P3-CANCEL"
B4=$(rows)
ax press Cancel | sed 's/^/    /' | tee -a "$REPORT"
sleep 4
A1=$(rows)
note "  rows URLEN1%: $B4 -> $A1"
verdict_eq "Cancel DISCARDS the parked request" "$B4" "$A1"
note "  key after Cancel: $(readkey)"
note "  sheets after Cancel:"; sheets | sed 's/^/    /' | tee -a "$REPORT"

cell "P3-DIS2 — a second url, then ENABLE: does a request parked in the DISABLED arm apply late?"
bmark "P3-DIS2"
B4=$(rows)
openurl "things:///add?title=URLEN1-p3-dis2"
note "  rows immediately after dispatch: $(rows) (was $B4)"
note "  sheets:"; sheets | sed 's/^/    /' | tee -a "$REPORT"
ax press Enable | sed 's/^/    /' | tee -a "$REPORT"
sleep 6
A1=$(rows)
note "  rows after pressing Enable: $A1"
verdict_eq "the request parked in the DISABLED arm APPLIES LATE on Enable" "$((B4+1))" "$A1"
note "  key after Enable: $(readkey)"
note "  sheets after Enable:"; sheets | sed 's/^/    /' | tee -a "$REPORT"

cell "P3-NAV — is a NAVIGATION url (things:///show) gated at all?"
quitapp
setkey false
hardreset
note "  key: $(readkey); sheets: $(sheets | head -1)"
bmark "P3-NAV"
openurl "things:///show?id=today"
note "  sheets after a navigation url in the disabled arm:"; sheets | sed 's/^/    /' | tee -a "$REPORT"
note "  frontmost app: $(axq 'tell application "System Events" to get name of first process whose frontmost is true')"

cell "P3-STACK — do sheets STACK, one per dispatched url?"
bmark "P3-STACK"
openurl "things:///add?title=URLEN1-p3-stack-a"
openurl "things:///add?title=URLEN1-p3-stack-b"
openurl "things:///add?title=URLEN1-p3-stack-c"
note "  sheets after three urls:"; sheets | sed 's/^/    /' | tee -a "$REPORT"
axdump p3-stack

cell "P3-RESTORE — leave the clone enabled again"
lab_ssh "$IP" 'pkill -x Things3 >/dev/null 2>&1; sleep 4; true' </dev/null
setkey true
hardreset
note "  key: $(readkey); sheets: $(sheets | head -1)"
bmark "P3-RESTORE"
B4=$(rows)
openurl "things:///add?title=URLEN1-p3-restored"
A1=$(rows)
note "  rows URLEN1%: $B4 -> $A1"
verdict_eq "P3-RESTORE/url-add lands with the key back at 1" "$((B4+1))" "$A1"
note "  final row list:"; rowlist | sed 's/^/    /' | tee -a "$REPORT"
fi  # ---- end phase 3 ----------------------------------------------------------

# =========================================================== CERTIFICATION (cert)
# The BUILD certification for the #611 fix, against the app. The property: with
# the app not authorized, the shipped CLI refuses BEFORE dispatch — zero DB
# delta AND, the part only this campaign can check, ZERO SHEETS, because the
# whole point is that no URL is opened and so no alert is raised on an
# unattended screen. Then the toggle goes back on and writes proceed.
#
# Ship the current dist first:  lab/scripts/research-urlen1.sh deps
if [ "$CMD" = "deps" ]; then
  note "re-pushing dist to $IP"
  npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  note "dist re-pushed"
  exit 0
fi

if [ "$CMD" = "cert" ]; then
GCDOMAIN='/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac'
hardreset(){
  lab_ssh "$IP" 'pkill -x Things3 >/dev/null 2>&1; sleep 4; open -a Things3; sleep 22; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 3; true' </dev/null
}
sheets(){ ax sheets; }
setkey(){ lab_ssh "$IP" "defaults write $(printf '%q' "$GCDOMAIN") uriSchemeEnabled -bool $1; killall cfprefsd 2>/dev/null; sleep 2; true" </dev/null; }
delkey(){ lab_ssh "$IP" "defaults delete $(printf '%q' "$GCDOMAIN") uriSchemeEnabled 2>&1; killall cfprefsd 2>/dev/null; sleep 2; true" </dev/null >/dev/null; }
readkey(){ lab_ssh "$IP" "defaults read $(printf '%q' "$GCDOMAIN") uriSchemeEnabled 2>&1 | tail -1" </dev/null; }

# A refusal cell: run the CLI, then assert exit 4, an unchanged row count, and —
# the load-bearing one — that no alert sheet was raised.
refuses(){ # refuses <label> <cli-args...>
  local label="$1"; shift
  bmark "CERT-$label"
  local before after out
  before=$(rows)
  out=$(G "$@")
  after=$(rows)
  note "  $label CLI output:"; echo "$out" | sed 's/^/    /' | tee -a "$REPORT"
  verdict_eq "$label exits 4 (blocked)" "EXIT=4" "$(echo "$out" | grep -o 'EXIT=[0-9]*' | tail -1)"
  verdict_eq "$label changes nothing" "$before" "$after"
  verdict_eq "$label raises NO alert sheet — nothing was dispatched" "SHEETS=0" "$(sheets | head -1)"
}

cell "CERT-OFF — the app explicitly disabled"
quitapp; setkey false; hardreset
note "  key: $(readkey); sheets: $(sheets | head -1)"
note "  \`things doctor\` url-scheme row:"
G doctor | grep -i "url" | sed 's/^/    /' | tee -a "$REPORT"
verdict_eq "doctor reads the vector as disabled" "1" "$(G doctor | grep -c 'url-scheme *disabled' || true)"
note "  \`things setup --dry-run\` (raises nothing):"
G "setup --dry-run" | sed 's/^/    /' | tee -a "$REPORT"
refuses "off/todo-add" "todo add 'URLEN1-cert-off-add' --json"
TARGET=$(gq "SELECT uuid FROM TMTask WHERE title='URLEN1-gold-alpha' LIMIT 1")
refuses "off/todo-update" "todo update $TARGET --notes 'URLEN1-cert-off-notes' --json"
verdict_eq "off/todo-update left the notes alone" "" "$(gq "SELECT COALESCE(notes,'') FROM TMTask WHERE uuid='$TARGET'")"

cell "CERT-NEVER — the key absent (a fresh install's reading)"
quitapp; delkey; hardreset
note "  key: $(readkey); sheets: $(sheets | head -1)"
verdict_eq "doctor reads the vector as never-asked" "1" "$(G doctor | grep -c 'url-scheme *never-asked' || true)"
note "  \`things setup --dry-run\`:"
G "setup --dry-run" | sed 's/^/    /' | tee -a "$REPORT"
refuses "never/todo-add" "todo add 'URLEN1-cert-never-add' --json"

cell "CERT-ON — the toggle back on: writes proceed"
quitapp; setkey true; hardreset
note "  key: $(readkey); sheets: $(sheets | head -1)"
verdict_eq "doctor reads the vector as enabled" "1" "$(G doctor | grep -c 'url-scheme *enabled' || true)"
bmark "CERT-ON-add"
B4=$(rows)
ON_OUT=$(G "todo add 'URLEN1-cert-on-add' --json")
A1=$(rows)
note "  CLI output:"; echo "$ON_OUT" | sed 's/^/    /' | tee -a "$REPORT"
verdict_eq "on/todo-add exits 0" "EXIT=0" "$(echo "$ON_OUT" | grep -o 'EXIT=[0-9]*' | tail -1)"
verdict_eq "on/todo-add LANDS" "$((B4+1))" "$A1"
verdict_eq "on/todo-add raises no sheet either" "SHEETS=0" "$(sheets | head -1)"
note "  final row list:"; rowlist | sed 's/^/    /' | tee -a "$REPORT"
fi  # ---- end certification -----------------------------------------------------

# ---------------------------------------------------------------- wrap-up
cell "WRAP"
note "  app: $(alive); crash reports: $CRASH0 -> $(crashes)"
note "  BEEP SENTINEL:"
bs assert --name "urlen1-$CMD" --json "~/things-lab/run/beeps-urlen1-$CMD.json" | sed 's/^/    /' | tee -a "$REPORT"
note ""
note "URLEN1 ($CMD) verdicts: PASS=$PASS FAIL=$FAIL"
note "artifacts: $OUT"
