#!/bin/bash
# APDP1 — is the macOS app-data grant ("access data from other apps",
# kTCCServiceSystemPolicyAppData) keyed to the RESPONSIBLE APP or to the
# ACCESSING PID?
#
# The tcc-appdata measurement on record ("allow-once-per-process, pid-pinned")
# never separated a child pid from its responsible parent, and the answer
# decides whether `things setup`'s read leg may provoke the modal from a
# BOUNDED CHILD process (src/direct-setup.ts `openContainer`) instead of an
# unbounded in-process open(2).
#
# Rig: ONE disposable golden-v4 clone. Every measured process is attributed to
# **Terminal.app** — an ssh-descended process inherits sshd-keygen-wrapper's
# FDA (SANDBOX1 probe-fidelity note), which would mask the very semantics under
# test, so the cells run inside a Terminal window launched with `open -a`.
# The modal is answered by AX (AXVM1 grant, baked into the golden).
#
# Cells (all against the same container DB path, one open(2) each):
#   c1  child #1 of the Terminal shell     — expect the modal; Allow it
#   c2  SIBLING child #2 (new pid)         — modal again, or clean?
#   c3  the PARENT SHELL itself            — does the child's grant reach it?
#   c4  a GRANDCHILD (bash -c → python)    — depth-independence
#   c5  a shell in a SECOND Terminal WINDOW (same Terminal instance, fresh
#       process lineage)
#   c6  a shell in a RELAUNCHED Terminal   — instance-pinned or identity-durable?
#
# Usage: bash lab/scripts/research-apdp1.sh [--keep]
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="apdp1"
GOLDEN="things-lab-golden-v4"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/dlg" "$OUT/tcc"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[apdp1] $*" | tee -a "$REPORT"; }
cleanup() {
  if [ "$KEEP" = "1" ]; then echo "[apdp1] --keep: leaving $VM running"; return; fi
  echo "[apdp1] teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ── clone + boot ─────────────────────────────────────────────────────────────
tart delete "$VM" >/dev/null 2>&1 || true
note "clone $GOLDEN -> $VM"
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 360) || { note "FATAL: no ssh"; exit 1; }
note "ssh up at $IP"

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
note "airgap: $(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo FAIL || echo OK' </dev/null)"
# Clock pin BEFORE anything launches (harness.md: golden-v4's trial wall is
# 2026-07-18; the pinned date is 2026-07-05). Things is never launched by this
# campaign — only its container file is read — but the pin is unconditional.
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date' </dev/null)"
note "macOS: $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)  Things: $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)"

# ── guest helpers ────────────────────────────────────────────────────────────
D=/Users/admin/labh/apdp1
lab_ssh "$IP" "rm -rf $D; mkdir -p $D" </dev/null
# Terminal must not restore its previous windows when C6 relaunches it — a
# restored session would blur "a new instance of the app" with "the same shells
# back again".
lab_ssh "$IP" 'defaults write com.apple.Terminal NSQuitAlwaysKeepsWindows -bool false' </dev/null

lab_ssh "$IP" "cat > $D/tryopen.py" <<'EOF'
# One open(2) against the Things container DB, timed, from THIS process.
# Writes <label>.start before the syscall (so a blocked pid is identifiable
# while the modal is up) and <label>.json after it returns.
import json, os, sys, time
label, path = sys.argv[1], sys.argv[2]
D = os.path.dirname(os.path.abspath(__file__))
rec = {"label": label, "pid": os.getpid(), "ppid": os.getppid()}
with open(os.path.join(D, label + ".start"), "w") as f:
    f.write(json.dumps(rec) + "\n")
t0 = time.time()
try:
    fd = os.open(path, os.O_RDONLY)
    head = os.read(fd, 16)
    os.close(fd)
    rec.update(ok=True, head=head.decode("latin-1").rstrip("\x00"))
except OSError as e:
    rec.update(ok=False, errno=e.errno, msg=str(e))
rec["elapsedSec"] = round(time.time() - t0, 3)
with open(os.path.join(D, label + ".json"), "w") as f:
    f.write(json.dumps(rec) + "\n")
print(json.dumps(rec))
EOF

# A system-wide AX tool: the TCC modal does not belong to Terminal, so every
# process with windows is enumerated (axtool.jxa's Things3-only variant cannot
# see it).
lab_ssh "$IP" "cat > $D/axsys.jxa" <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics')
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function sv(el,n){var v=attr(el,n);try{return v?String(v.js):''}catch(e){return ''}}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
function flat(el,acc,d){acc.push(el); if(d>18)return acc; var ch=kids(el); for(var i=0;i<ch.length;i++)flat(ch[i],acc,d+1); return acc}
function frame(el){var p=attr(el,'AXPosition'),z=attr(el,'AXSize');function d(x){if(!x)return null;return ObjC.castRefToObject($.CFCopyDescription(x)).js}
  var pp=d(p),zz=d(z);var mp=pp&&pp.match(/x:([-0-9.]+) y:([-0-9.]+)/);var mz=zz&&zz.match(/w:([-0-9.]+) h:([-0-9.]+)/)
  return {x:mp?+mp[1]:null,y:mp?+mp[2]:null,w:mz?+mz[1]:null,h:mz?+mz[2]:null}}
function line(el,d){
  var p=['role='+sv(el,'AXRole')]
  var s=sv(el,'AXSubrole'); if(s)p.push('sub='+s)
  var t=sv(el,'AXTitle'); if(t)p.push('ttl='+t)
  var de=sv(el,'AXDescription'); if(de)p.push('desc='+de.slice(0,160))
  var v=sv(el,'AXValue'); if(v)p.push('val='+String(v).slice(0,240))
  var f=frame(el); if(f.x!==null)p.push('@['+f.x+','+f.y+' '+f.w+'x'+f.h+']')
  return Array(d+1).join('  ')+p.join(' | ')}
function procs(){
  var out=[], ws=$.NSWorkspace.sharedWorkspace.runningApplications
  for(var i=0;i<ws.count;i++){var a=ws.objectAtIndex(i)
    out.push({name:String(a.localizedName.js), bid:a.bundleIdentifier?String(a.bundleIdentifier.js):'', pid:a.processIdentifier})}
  return out}
function clickPt(x,y){var pt=$.CGPointMake(x,y)
  function post(t){$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateMouseEvent($(),t,pt,$.kCGMouseButtonLeft))}
  post($.kCGEventMouseMoved); delay(0.3); post($.kCGEventLeftMouseDown); delay(0.12); post($.kCGEventLeftMouseUp)}
function run(argv){
  var cmd=argv[0]||'dump', want=argv[1]||''
  var ps=procs(), acc=[]
  for(var i=0;i<ps.length;i++){
    var app=$.AXUIElementCreateApplication(ps[i].pid)
    var wins=kids(app)
    if(!wins.length) continue
    if(cmd==='dump'){
      acc.push('=== PROC '+ps[i].name+' ('+ps[i].bid+') pid='+ps[i].pid+' windows='+wins.length+' ===')
      for(var w=0;w<wins.length;w++){
        var all=[]; flat(wins[w],all,0)
        acc.push('  --- window '+(w+1)+' '+line(wins[w],0).trim()+' ---')
        for(var k=1;k<all.length && k<200;k++) acc.push('  '+line(all[k],1))
      }
      continue
    }
    if(cmd==='press'){
      var all2=[]; for(var w2=0;w2<wins.length;w2++) flat(wins[w2],all2,0)
      var btns=all2.filter(function(e){return sv(e,'AXRole')==='AXButton'})
      for(var b=0;b<btns.length;b++){
        if(sv(btns[b],'AXTitle')===want){
          var rc=$.AXUIElementPerformAction(btns[b],$('AXPress'))
          if(rc!==0){var f=frame(btns[b]); clickPt(f.x+f.w/2,f.y+f.h/2); return 'AXPress rc='+rc+' -> CGEvent-clicked "'+want+'" in '+ps[i].name}
          return 'PRESSED "'+want+'" in '+ps[i].name+' ('+ps[i].bid+' pid='+ps[i].pid+')'
        }
      }
    }
  }
  return cmd==='dump' ? (acc.length?acc.join('\n'):'(no process has any window)') : 'NO BUTTON "'+want+'" in any process'
}
EOF

# TCC row dump (the user DB holds AppData rows; ssh has FDA, so this is readable).
lab_ssh "$IP" "cat > $D/tccdump.sh && chmod +x $D/tccdump.sh" <<'EOF'
#!/bin/bash
UDB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
SDB="/Library/Application Support/com.apple.TCC/TCC.db"
echo "--- USER TCC.db: every AppData row (all columns) ---"
sqlite3 -line "file:$UDB?mode=ro" "SELECT * FROM access WHERE service='kTCCServiceSystemPolicyAppData';" 2>&1
echo "--- USER TCC.db: row census ---"
sqlite3 -noheader -list "file:$UDB?mode=ro" "SELECT service||' | '||client||' | type='||client_type||' | auth='||auth_value||' | reason='||auth_reason FROM access ORDER BY service;" 2>&1
echo "--- SYSTEM TCC.db: row census ---"
sudo sqlite3 -noheader -list "file:$SDB?mode=ro" "SELECT service||' | '||client||' | type='||client_type||' | auth='||auth_value FROM access ORDER BY service;" 2>&1
EOF

DBPATH=$(lab_ssh "$IP" 'ls "$HOME/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/"ThingsData-*/"Things Database.thingsdatabase/main.sqlite"' </dev/null)
note "container db: $DBPATH"
lab_ssh "$IP" "printf '%s' '$DBPATH' > $D/dbpath.txt" </dev/null

# ── parent scripts (run INSIDE Terminal.app) ─────────────────────────────────
mkparent() { # mkparent <file> <banner> <cell...>
  local file="$1" banner="$2"; shift 2
  {
    echo '#!/bin/bash'
    echo "D=$D"
    echo 'DB="$(cat $D/dbpath.txt)"'
    echo 'exec >>"$D/parent.log" 2>&1'
    echo "echo \"=== $banner pid=\$\$ ppid=\$PPID ts=\$(date +%s) ===\""
    echo 'P=$$; for i in 1 2 3 4 5 6; do ps -o pid=,ppid=,comm= -p $P 2>/dev/null; N=$(ps -o ppid= -p $P 2>/dev/null | tr -d " "); [ -z "$N" ] && break; [ "$N" = "0" ] && break; P=$N; done'
    for c in "$@"; do
      echo "while [ ! -f \"\$D/go-$c\" ]; do sleep 1; done"
      echo "echo \"MARK $c begin ts=\$(date +%s) shellpid=\$\$\""
      case "$c" in
        c3)
          # The PARENT SHELL performs the open itself: `read` is a builtin, so
          # bash does the open(2) in this process, not a fork.
          echo "echo \"{\\\"label\\\":\\\"c3\\\",\\\"pid\\\":\$\$}\" > \"\$D/c3.start\""
          echo 'T0=$(python3 -c "import time;print(time.time())")'
          echo 'if read -r -n 16 CHUNK < "$DB"; then RC=ok; else RC="fail-$?"; fi'
          echo 'T1=$(python3 -c "import time;print(time.time())")'
          echo 'python3 -c "import json,sys;print(json.dumps({\"label\":\"c3\",\"pid\":int(sys.argv[1]),\"ok\":sys.argv[2]==\"ok\",\"detail\":sys.argv[2],\"elapsedSec\":round(float(sys.argv[4])-float(sys.argv[3]),3)}))" "$$" "$RC" "$T0" "$T1" > "$D/c3.json"'
          ;;
        c4)
          echo "/bin/bash -c \"/usr/bin/python3 \$D/tryopen.py $c '\$DB'\""
          ;;
        *)
          echo "/usr/bin/python3 \"\$D/tryopen.py\" $c \"\$DB\""
          ;;
      esac
      echo "echo \"MARK $c end rc=\$? ts=\$(date +%s)\""
    done
    echo "echo \"$banner-DONE ts=\$(date +%s)\""
  } | lab_ssh "$IP" "cat > $D/$file && chmod +x $D/$file"
}
mkparent parent1.command PARENT1 c1 c2 c3 c4
mkparent parent2.command PARENT2 c5
mkparent parent3.command PARENT3 c6
note "guest helpers installed"

# ── host-side primitives ─────────────────────────────────────────────────────
dlgdump() { lab_ssh "$IP" "osascript -l JavaScript $D/axsys.jxa dump" </dev/null > "$OUT/dlg/$1.txt" 2>&1; }
press()   { lab_ssh "$IP" "osascript -l JavaScript $D/axsys.jxa press $(printf '%q' "$1")" </dev/null 2>&1; }
tccdump() { lab_ssh "$IP" "bash $D/tccdump.sh" </dev/null > "$OUT/tcc/$1.txt" 2>&1; note "  [tcc dump: $1] AppData rows: $(grep -c 'service = kTCCServiceSystemPolicyAppData' "$OUT/tcc/$1.txt")"; }
procinfo() { # procinfo <label> <startfile>
  local pid
  pid=$(lab_ssh "$IP" "python3 -c \"import json;print(json.load(open('$D/$2'))['pid'])\" 2>/dev/null" </dev/null)
  [ -z "$pid" ] && { note "  [$1] no pid recorded yet"; return; }
  lab_ssh "$IP" "sudo launchctl procinfo $pid 2>&1 | head -40" </dev/null > "$OUT/dlg/$1-procinfo.txt" 2>&1
  note "  [$1] blocked pid=$pid  $(grep -iE 'responsible|program path' "$OUT/dlg/$1-procinfo.txt" | tr '\n' ' ' | tr -s ' ')"
  lab_ssh "$IP" "ps -o pid,ppid,state,command -p $pid" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
}

runcell() { # runcell <label> <startfile> [maxwait]
  local L="$1" SF="$2" MAX="${3:-75}" t=0 handled=0 modal=NO
  note "---- cell $L ----"
  lab_ssh "$IP" "rm -f $D/$L.json $D/$L.start; touch $D/go-$L" </dev/null
  while [ "$t" -lt "$MAX" ]; do
    if lab_ssh "$IP" "grep -q '^MARK $L end' $D/parent.log" </dev/null; then break; fi
    sleep 2; t=$((t + 2))
    if [ "$t" -ge 8 ] && [ "$handled" -eq 0 ]; then
      handled=1
      note "  [$L] still blocked after ~${t}s — capturing the screen's dialog census"
      dlgdump "$L"
      if grep -qE 'ttl=Allow|desc=Allow' "$OUT/dlg/$L.txt"; then modal=YES; fi
      note "  [$L] census: $(grep -c '^=== PROC' "$OUT/dlg/$L.txt") processes with windows; Allow button present: $modal"
      grep -E '^=== PROC|val=.*(access|Things|data from other apps)|ttl=(Allow|Don)' "$OUT/dlg/$L.txt" | head -20 | sed 's/^/    /' | tee -a "$REPORT"
      procinfo "$L" "$SF"
      note "  [$L] press Allow -> $(press Allow)"
    fi
  done
  if [ "$t" -ge "$MAX" ]; then
    note "  [$L] TIMEOUT after ${MAX}s — killing the blocked process so the parent can continue"
    lab_ssh "$IP" "python3 -c \"import json,os;os.kill(json.load(open('$D/$SF'))['pid'],9)\" 2>&1" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
    sleep 3
  fi
  note "  [$L] modal-appeared=$modal  result: $(lab_ssh "$IP" "cat $D/$L.json 2>/dev/null || echo NO-RESULT" </dev/null)"
  # A cell that finished clean must ALSO have left no dialog on screen.
  if [ "$handled" -eq 0 ]; then
    dlgdump "$L-after"
    note "  [$L] post-cell dialog census: $(grep -c '^=== PROC' "$OUT/dlg/$L-after.txt") processes with windows; Allow present: $(grep -qE 'ttl=Allow' "$OUT/dlg/$L-after.txt" && echo YES || echo NO)"
  fi
}

# ── baseline ─────────────────────────────────────────────────────────────────
note "==== C0 baseline ===="
tccdump 00-baseline
note "  ssh-descended read of the same path (expect OK — sshd holds FDA):"
lab_ssh "$IP" "python3 $D/tryopen.py c0-ssh '$DBPATH'" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
note "  Terminal.app running before we start: $(lab_ssh "$IP" 'pgrep -x Terminal >/dev/null && echo YES || echo NO' </dev/null)"

# ── the Terminal-attributed cells ────────────────────────────────────────────
note "==== launching Terminal.app with parent1.command (c1..c4) ===="
lab_ssh "$IP" "open -a Terminal $D/parent1.command" </dev/null
sleep 8
note "  Terminal pid(s): $(lab_ssh "$IP" 'pgrep -x Terminal | tr "\n" " "' </dev/null)"
lab_ssh "$IP" "cat $D/parent.log" </dev/null | sed 's/^/    /' | tee -a "$REPORT"

runcell c1 c1.start 120
tccdump 01-after-c1
runcell c2 c2.start
runcell c3 c3.start
runcell c4 c4.start
tccdump 02-after-c4

note "==== C5: a second Terminal WINDOW in the SAME Terminal instance ===="
TERMPID_BEFORE=$(lab_ssh "$IP" 'pgrep -x Terminal | head -1' </dev/null)
lab_ssh "$IP" "open -a Terminal $D/parent2.command" </dev/null
sleep 6
runcell c5 c5.start
note "  Terminal pid unchanged? before=$TERMPID_BEFORE now=$(lab_ssh "$IP" 'pgrep -x Terminal | head -1' </dev/null)"
tccdump 03-after-c5

note "==== C6: Terminal QUIT + relaunched (a NEW instance of the same app) ===="
lab_ssh "$IP" 'killall -9 Terminal; sleep 4; pgrep -x Terminal >/dev/null && echo STILL-RUNNING || echo QUIT' </dev/null | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" "open -a Terminal $D/parent3.command" </dev/null
sleep 8
note "  new Terminal pid: $(lab_ssh "$IP" 'pgrep -x Terminal | head -1' </dev/null)"
runcell c6 c6.start
tccdump 04-after-c6

note "==== raw parent.log ===="
lab_ssh "$IP" "cat $D/parent.log" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
note "==== all cell results ===="
lab_ssh "$IP" "cat $D/c*.json 2>/dev/null" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
note "APDP1 DONE."
