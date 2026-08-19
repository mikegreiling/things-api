#!/bin/bash
# VMQ1 item 6 — template-direct clone certification (cells a + f; c is not live-
# reachable — an inexpressible rule cannot be minted through app surfaces, so its
# H-CLONE-SOURCE refusal stays CI-only). Folds in: a multi-weekday reschedule-dialog
# AX census (to design the item-2 blind-"+" closed-loop fix) + a clean item-1
# DEADLINED same-anchor lone-Next re-run (the diag flake). golden-v3 / Things 3.22.14.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VM="vmq1-clone"
GOLDEN="things-lab-golden-v3"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[cl] $*" | tee -a "$REPORT"; }
cleanup() { echo "[cl] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

tart delete "$VM" >/dev/null 2>&1 || true
note "clone $GOLDEN -> $VM"
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 360); note "ssh up at $IP"

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date' </dev/null)"

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
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationCount, deadline FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row or row[0] is None: print("NO-RULE"); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s of=[%s] OFCOUNT=%d next=%s icCount=%s deadline=%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),",".join(offs),len(d.get('of',[])),
    dpk(row[1]),row[2],row[3]))
EOF
lab_ssh "$IP" 'cat > ~/labh/axtree.jxa' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices')
function pidOf(n){return Application('System Events').processes.byName(n).unixId()}
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function sv(el,n){var v=attr(el,n);try{return v?String(v.js):''}catch(e){return ''}}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
function appEl(){return $.AXUIElementCreateApplication(pidOf('Things3'))}
function line(el,d,idx){
  var p=['#'+idx+' role='+sv(el,'AXRole')]
  var sub=sv(el,'AXSubrole'); if(sub)p.push('sub='+sub)
  var t=sv(el,'AXTitle'); if(t)p.push('ttl='+t)
  var de=sv(el,'AXDescription'); if(de)p.push('desc='+de)
  var v=sv(el,'AXValue'); if(v)p.push('val='+v)
  return Array(d+1).join('  ')+p.join(' | ')
}
function walk(el,d,acc){var ch=kids(el); for(var i=0;i<ch.length;i++){acc.push(line(ch[i],d,i)); if(d<16)walk(ch[i],d+1,acc);} return acc}
function run(){
  var app=appEl(); var ws=kids(app); var acc=['=== APP TREE ===']
  for(var i=0;i<ws.length;i++){acc.push('--- window '+i+' role='+sv(ws[i],'AXRole')+' sub='+sv(ws[i],'AXSubrole')+' ---'); walk(ws[i],0,acc)}
  return acc.join('\n')
}
EOF
note "helpers installed"

[ -f dist/cli/main.js ] || { note "FATAL: dist missing"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { local a c; for a in 1 2 3 4 5; do sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; c=$?; [ "$c" -eq 0 ] && return 0; sleep 3; done; return "$c"; }
lab_ssh "$IP" true </dev/null; sleep 2
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null || { note "FATAL node scp"; exit 1; }
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
COMMANDER_DIR=$(node -e "const p=require.resolve('commander'); console.log(p.slice(0, p.indexOf('/node_modules/commander/')+'/node_modules/commander'.length))")
scpO -r "$COMMANDER_DIR" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null || { note "FATAL commander scp"; exit 1; }
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
CLI="~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js"
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
note "bundle shipped; Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)"
lab_ssh "$IP" 'open -a Things3; sleep 12; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null
note "warm-up done"

tmplid() { lab_ssh "$IP" "~/labh/gsql.sh -q \"SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1\"" </dev/null; }
plainid() { lab_ssh "$IP" "~/labh/gsql.sh -q \"SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1\"" </dev/null; }
rsum() { lab_ssh "$IP" "python3 ~/labh/rsum.py '$1' 2>&1" </dev/null; }
countrows() { lab_ssh "$IP" "~/labh/gsql.sh -q \"SELECT count(*) FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0\"" </dev/null; }
countinst() { lab_ssh "$IP" "~/labh/gsql.sh -q \"SELECT count(*) FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0\"" </dev/null; }
mk() { local title="$1"; shift; lab_ssh "$IP" "$CLI todo add '$title'" </dev/null >/dev/null 2>&1; sleep 1; local uid; uid=$(plainid "$title"); note "  make $title ($uid): $*"; lab_ssh "$IP" "$CLI todo make-repeating '$uid' $* --dangerously-drive-gui --verify-timeout 90000" </dev/null >"$OUT/mk-$title.out" 2>&1; note "    make exit=$?"; sleep 2; }

# ==================== ITEM 2 fix census — multi-weekday reschedule dialog structure
note "==================== ITEM 2: multi-weekday dialog AX census (for the '+' fix) ===================="
mk C2 --frequency weekly --interval 1 --weekdays monday,wednesday,friday
T2=$(tmplid C2)
note "  C2 template=$T2 rule: $(rsum "$T2")"
lab_ssh "$IP" "open 'things:///show?id=$T2'; sleep 2; osascript -e 'tell application \"Things3\" to activate'; sleep 1" </dev/null
lab_ssh "$IP" "osascript -e 'tell application \"System Events\" to tell process \"Things3\" to click menu item \"Reschedule…\" of menu 1 of menu item \"Repeat\" of menu 1 of menu bar item \"Items\" of menu bar 1'" </dev/null >>"$OUT/ax/open.log" 2>&1
sleep 2
lab_ssh "$IP" 'osascript -l JavaScript ~/labh/axtree.jxa' </dev/null >"$OUT/ax/multiweekday.txt" 2>&1
note "  dialog group subtree (weekday pop-ups + any add/remove buttons):"
grep -nE "PopUpButton|Button|group|Sheet" "$OUT/ax/multiweekday.txt" | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" "osascript -e 'tell application \"System Events\" to key code 53'" </dev/null >/dev/null 2>&1
sleep 1

# ==================== ITEM 1 — DEADLINED same-anchor lone-Next (clean re-run)
note "==================== ITEM 1: DEADLINED same-anchor lone-Next (re-run) ===================="
mk C1DL --frequency yearly --interval 1 --when 2026-07-06 --deadline --start-days-earlier 14
T1=$(tmplid C1DL)
note "  pre : $(rsum "$T1")  (anchor Jul20 due, ts=-14)"
note "  reschedule --when 2030-07-06 same deadline (anchor Jul20 unchanged; only Next changes)"
lab_ssh "$IP" "$CLI todo reschedule-repeat '$T1' --frequency yearly --interval 1 --when 2030-07-06 --deadline --start-days-earlier 14 --dangerously-drive-gui --verify-timeout 45000 --json" </dev/null >"$OUT/c1dl.out" 2>&1
note "  cli-exit=$?"; grep -o '"ok":[a-z]*\|"code":"[^"]*"\|nextOccurrence":"[^"]*"' "$OUT/c1dl.out" | tr '\n' ' ' | sed 's/^/    observed: /' | tee -a "$REPORT"; echo ""
sleep 2
note "  post: $(rsum "$T1")  (COMMIT => next=2030-07-06 ; DISCARD => unchanged)"

# ==================== ITEM 6 — template-direct clone certification (cells a, f)
note "==================== ITEM 6: template-direct clone (a fixed weekly, f undo) ===================="
mk C6 --frequency weekly --interval 1 --weekdays tuesday
T6=$(tmplid C6)
note "  (a) source weekly template=$T6 rule: $(rsum "$T6")"
note "      template rows titled C6 (want 1): $(countrows C6); instances of source (want per-spawn): $(countinst "$T6")"
note "  clone the template…"
lab_ssh "$IP" "$CLI todo clone '$T6' --dangerously-drive-gui --verify-timeout 90000 --json" </dev/null >"$OUT/c6-clone.out" 2>&1
note "  clone cli-exit=$?"; grep -o '"ok":[a-z]*\|"code":"[^"]*"\|"templateUuid":"[^"]*"\|"instanceUuid":"[^"]*"\|new series[^"\\]*\|undoToken":"[^"]*"' "$OUT/c6-clone.out" | tr '\n' ' ' | sed 's/^/    /' | tee -a "$REPORT"; echo ""
grep -o '"warnings":\[[^]]*\]' "$OUT/c6-clone.out" | sed 's/^/    warnings: /' | tee -a "$REPORT"
sleep 3
NEWTMPL=$(lab_ssh "$IP" "~/labh/gsql.sh -q \"SELECT uuid FROM TMTask WHERE title='C6' AND rt1_recurrenceRule IS NOT NULL AND uuid!='$T6' AND trashed=0 ORDER BY creationDate DESC LIMIT 1\"" </dev/null)
note "  post-clone: template rows titled C6 (want 2): $(countrows C6)"
note "  source template UNTOUCHED? $(rsum "$T6")"
note "  new template=$NEWTMPL rule: $(rsum "$NEWTMPL")"
note "  new-series instances (want 1 spawned): $(countinst "$NEWTMPL")"
UNDOTOK=$(grep -o '"undoToken":"[^"]*"' "$OUT/c6-clone.out" | head -1 | sed 's/.*:"//;s/"//')
note "  (f) undo the clone (token=$UNDOTOK) — trash-both new series, source stays…"
lab_ssh "$IP" "$CLI undo --json" </dev/null >"$OUT/c6-undo.out" 2>&1
note "  undo cli-exit=$?"; grep -o '"ok":[a-z]*\|"code":"[^"]*"' "$OUT/c6-undo.out" | tr '\n' ' ' | sed 's/^/    /' | tee -a "$REPORT"; echo ""
sleep 3
note "  post-undo: template rows titled C6 (want 1, source only): $(countrows C6)"
note "  new-series instances after undo (want 0): $(countinst "$NEWTMPL")"
note "  source template still present + untouched? $(rsum "$T6")"

note "VMQ1 CLONE DONE."
