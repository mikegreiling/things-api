#!/bin/bash
# VMQ1 diagnosis boot — items 1 (lone-Next inertness), 2 (RRF1 breadth + RRD1 "+"),
# 3 (after-completion Ends census). ONE disposable clone of golden-v3 (Things
# 3.22.14). Self-contained: clone -> boot -> airgap -> pin clock -> ship dist ->
# install helpers -> drive cells -> read-only DB oracle -> teardown (trap EXIT).
# Fixtures fully synthetic (I1-*/I2-*/I3-*). Clock pinned 2026-07-05 (a Sunday);
# templates are reveal-selectable directly (RRD1 note), so no materialization.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="vmq1-diag"
GOLDEN="things-lab-golden-v3"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[vmq1] $*" | tee -a "$REPORT"; }
cleanup() { echo "[vmq1] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

tart delete "$VM" >/dev/null 2>&1 || true
note "clone $GOLDEN -> $VM"
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo FAIL || echo OK' </dev/null)
note "airgap: $AG"
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date' </dev/null)"
GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "AX grant=$GRANT (want 2)"

# guest helpers
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib, datetime
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
def uxd(v):
    try: v=float(v)
    except: return v
    return datetime.datetime.utcfromtimestamp(v).strftime("%Y-%m-%d")
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationStartDate, rt1_instanceCreationCount, deadline, rt1_reminderTime FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row or row[0] is None: print("NO-RULE"); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s ed=%s of=[%s] ia=%s sr=%s next=%s icStart=%s icCount=%s deadline=%s rem=%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),d.get('ed'),",".join(offs),
    uxd(d.get('ia')),uxd(d.get('sr')),dpk(row[1]),dpk(row[2]),row[3],row[4],row[5]))
EOF
# axtree.jxa (full AX dump + AXDateTimeArea inventory) — from anch2-helpers
lab_ssh "$IP" 'cat > ~/labh/axtree.jxa' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices')
function pidOf(n){return Application('System Events').processes.byName(n).unixId()}
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function sv(el,n){var v=attr(el,n);try{return v?String(v.js):''}catch(e){return ''}}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
function appEl(){return $.AXUIElementCreateApplication(pidOf('Things3'))}
function line(el,d){
  var p=['role='+sv(el,'AXRole')]
  var sub=sv(el,'AXSubrole'); if(sub)p.push('sub='+sub)
  var t=sv(el,'AXTitle'); if(t)p.push('ttl='+t)
  var de=sv(el,'AXDescription'); if(de)p.push('desc='+de)
  var rd=sv(el,'AXRoleDescription'); if(rd)p.push('rdesc='+rd)
  var v=sv(el,'AXValue'); if(v)p.push('val='+v)
  return Array(d+1).join('  ')+p.join(' | ')
}
function walk(el,d,acc){acc.push(line(el,d)); if(d>16)return acc; var ch=kids(el); for(var i=0;i<ch.length;i++)walk(ch[i],d+1,acc); return acc}
function run(){
  var app=appEl(); var ws=kids(app); var acc=['=== APP TREE (windows='+ws.length+') ===']
  for(var i=0;i<ws.length;i++){acc.push('--- window '+i+' role='+sv(ws[i],'AXRole')+' sub='+sv(ws[i],'AXSubrole')+' ttl='+sv(ws[i],'AXTitle')+' ---'); walk(ws[i],0,acc)}
  return acc.join('\n')
}
EOF
note "helpers installed"

# ship production dist bundle
[ -f dist/cli/main.js ] || { note "FATAL: dist/cli/main.js missing"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() {
  local attempt code
  for attempt in 1 2 3 4 5; do
    sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; code=$?
    [ "$code" -eq 0 ] && return 0
    sleep 3
  done
  return "$code"
}
lab_ssh "$IP" true </dev/null; sleep 2
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null || { note "FATAL: node scp failed"; exit 1; }
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
COMMANDER_DIR=$(node -e "const p=require.resolve('commander'); console.log(p.slice(0, p.indexOf('/node_modules/commander/')+'/node_modules/commander'.length))")
scpO -r "$COMMANDER_DIR" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null || { note "FATAL: commander scp failed"; exit 1; }
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
CLI="~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js"
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
note "bundle shipped; Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)"

lab_ssh "$IP" 'open -a Things3; sleep 12; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null
note "warm-up done; CLI version: $(lab_ssh "$IP" "$CLI --version" </dev/null 2>&1)"

# ---- helpers ----
tmplid() { lab_ssh "$IP" "~/labh/gsql.sh -q \"SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1\"" </dev/null; }
plainid() { lab_ssh "$IP" "~/labh/gsql.sh -q \"SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1\"" </dev/null; }
rsum() { lab_ssh "$IP" "python3 ~/labh/rsum.py '$1'" </dev/null; }
mk() { # mk <title> <flags...>
  local title="$1"; shift
  lab_ssh "$IP" "$CLI todo add '$title'" </dev/null >/dev/null 2>&1
  sleep 1
  local uid; uid=$(plainid "$title")
  note "  create $title -> $uid; make-repeating $*"
  lab_ssh "$IP" "$CLI todo make-repeating '$uid' $* --dangerously-drive-gui --verify-timeout 90000 --json" </dev/null >"$OUT/mk-$title.out" 2>&1
  note "    make exit=$?"; tail -3 "$OUT/mk-$title.out" | sed 's/^/      /' | tee -a "$REPORT"
  sleep 2
}
resched() { # resched <label> <title> <flags...>
  local label="$1" title="$2"; shift 2
  local t; t=$(tmplid "$title")
  note "  [$label] pre : $(rsum "$t")"
  note "  [$label] cmd : reschedule-repeat $* (timeout 35s)"
  lab_ssh "$IP" "$CLI todo reschedule-repeat '$t' $* --dangerously-drive-gui --verify-timeout 35000 --json" </dev/null >"$OUT/$label.out" 2>&1
  note "  [$label] cli-exit=$?"; tail -5 "$OUT/$label.out" | sed 's/^/      /' | tee -a "$REPORT"
  sleep 2
  note "  [$label] post: $(rsum "$t")"
}

# ============================ ITEM 1 — lone-Next-write commit inertness
note "==================== ITEM 1: lone-Next-write inertness ===================="
mk I1Y --frequency yearly --interval 1 --when 2026-07-20
mk I1D --frequency daily --interval 1
note ""
note "-- Cell 1A: SAME-anchor yearly lone-Next (--when 2030-07-20, anchor stays Jul 20) --"
note "   COMMIT => next becomes 2030-07-20 ; DISCARD => cursor unchanged + verify-fail"
resched cell1A I1Y --frequency yearly --interval 1 --when 2030-07-20
note ""
note "-- Cell 1B: DAILY lone-Next (--when 2030-03-15, no anchor pop-ups at all) --"
note "   COMMIT => next becomes 2030-03-15 ; DISCARD => cursor unchanged + verify-fail"
resched cell1B I1D --frequency daily --interval 1 --when 2030-03-15
note ""
note "-- Cell 1C: DIFFERENT-anchor control (--when 2031-09-15, anchor Jul20->Sep15 real change) --"
note "   expect COMMIT (of=[{dy=14,mo=8}], next 2031-09-15) — discriminator"
resched cell1C I1Y --frequency yearly --interval 1 --when 2031-09-15

# ============================ ITEM 2 — RRF1 breadth + RRD1 "+" idempotence
note "==================== ITEM 2: RRF1 breadth + RRD1 '+' ===================="
mk I2W --frequency weekly --interval 1 --weekdays monday
mk I2M --frequency weekly --interval 1 --weekdays monday,wednesday
mk I2E --frequency daily --interval 1 --ends-after 5
note ""
note "-- Cell 2W: weekly weekday-SET change {mon} -> {tue,thu} (also exercises '+' from 1->2 rows) --"
note "   predict of=[{wd=2},{wd=4}] (anchorKey tue,thu). Extra/wrong wd rows = '+' bug"
resched cell2W I2W --frequency weekly --interval 1 --weekdays tuesday,thursday
note ""
note "-- Cell 2M: pre-populated MULTI-weekday {mon,wed}, reschedule interval 1->2 keeping {mon,wed} --"
note "   predict of has EXACTLY {wd=1},{wd=3}. 3+ rows / dupes = blind-'+' duplicate bug"
resched cell2M I2M --frequency weekly --interval 2 --weekdays monday,wednesday
note ""
note "-- Cell 2E: ends-bound change ends:after 5 -> ends:on 2027-12-31 --"
note "   predict ed=2027-12-31 set, rc cleared"
resched cell2E I2E --frequency daily --interval 1 --ends-on 2027-12-31

# ============================ ITEM 3 — after-completion Ends census
note "==================== ITEM 3: after-completion Ends census ===================="
mk I3 --frequency weekly --interval 1 --after-completion
T3=$(tmplid I3)
note "  I3 template=$T3 rule: $(rsum "$T3")"
note "  opening reschedule dialog on the AC template + dumping AX tree..."
lab_ssh "$IP" "open 'things:///show?id=$T3'; sleep 2; osascript -e 'tell application \"Things3\" to activate'; sleep 1" </dev/null
lab_ssh "$IP" "osascript -e 'tell application \"System Events\" to tell process \"Things3\" to click menu item \"Reschedule…\" of menu 1 of menu item \"Repeat\" of menu 1 of menu bar item \"Items\" of menu bar 1'" </dev/null >>"$OUT/ax/open.log" 2>&1
sleep 2
lab_ssh "$IP" 'osascript -l JavaScript ~/labh/axtree.jxa' </dev/null >"$OUT/ax/ac-dialog.txt" 2>&1
note "  AC-dialog AX dump ($(wc -l <"$OUT/ax/ac-dialog.txt") lines):"
# surface pop-up buttons + checkboxes + their group context
grep -nE "role=AXPopUpButton|role=AXCheckBox|role=AXButton|AXUnknown|sheet|group" "$OUT/ax/ac-dialog.txt" | sed 's/^/    /' | tee -a "$REPORT"
note "  enumerating menu items of every pop-up button in the AC dialog..."
lab_ssh "$IP" "osascript -e 'tell application \"System Events\" to tell process \"Things3\"' -e 'set out to \"\"' -e 'try' -e 'set shl to (first window whose subrole is \"AXStandardWindow\")' -e 'set dlg to sheet 1 of shl' -e 'repeat with pu in (pop up buttons of dlg)' -e 'set out to out & \"SHEET-POPUP: \" & (description of pu) & \" val=\" & (value of pu as text) & linefeed' -e 'end repeat' -e 'repeat with g in (groups of dlg)' -e 'repeat with pu in (pop up buttons of g)' -e 'click pu' -e 'delay 0.3' -e 'set out to out & \"GROUP-POPUP val=\" & (value of pu as text) & \" items=\" & (title of every menu item of menu 1 of pu as text) & linefeed' -e 'key code 53' -e 'delay 0.2' -e 'end repeat' -e 'end repeat' -e 'on error e' -e 'set out to out & \"ERR: \" & e' -e 'end try' -e 'return out'" </dev/null >"$OUT/ax/ac-popups.txt" 2>&1
note "  AC dialog pop-up enumeration:"
cat "$OUT/ax/ac-popups.txt" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" "osascript -e 'tell application \"System Events\" to key code 53'" </dev/null >/dev/null 2>&1

note "VMQ1 DIAG DONE."
