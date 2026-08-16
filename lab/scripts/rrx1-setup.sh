#!/bin/bash
# RRX1 setup — clone golden-v2, airgap, pin clock (Sun 2026-07-05 12:00), verify AX,
# install guest helpers, ship the PRODUCTION e2e bundle. Leaves the VM RUNNING.
# Two campaigns run on this clone: Q1 (--ends-after count exhaustion / rc semantics)
# and Q2 (repeat-rule reminder storage). Idempotent-ish: clones fresh each run.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="rrx1-lab"
GOLDEN="things-lab-golden-v2"
OUT="lab/artifacts/rrx1-lab"; mkdir -p "$OUT/snaps" "$OUT/json"
REPORT="$OUT/setup.txt"; : > "$REPORT"
note() { echo "[rrx1-setup] $*" | tee -a "$REPORT"; }

# ---------------- preflight ----------------
FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB (golden=$GOLDEN)"
[ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free. Abort."; exit 1; }

# ---------------- host toolchain (self-contained node; rem1/rsim lesson) ----------------
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
if ! node --version >/dev/null 2>&1 || ! npm --version >/dev/null 2>&1; then
  note "FATAL: no working self-contained node/npm on PATH. Abort."; exit 1
fi
note "toolchain: node $(node --version) / npm $(npm --version) @ $(command -v node)"
if [ ! -d node_modules/commander ]; then
  note "npm ci (worktree has no node_modules)…"
  npm ci >"$OUT/npm-ci.log" 2>&1 || { note "FATAL: npm ci failed (see $OUT/npm-ci.log)."; exit 1; }
fi

# ---------------- clone + boot ----------------
note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"; echo "$IP" > "$OUT/ip.txt"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
note "airgap: $AG"
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date' </dev/null)"
GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "Accessibility auth_value=$GRANT (want 2)"
[ "$GRANT" = "2" ] || { note "FATAL: AX grant missing"; exit 1; }
note "installed shortcuts: $(lab_ssh "$IP" 'shortcuts list 2>/dev/null | tr "\n" ","' </dev/null)"

# ---------------- guest helpers (survive a reboot: live in ~/labh, not /tmp) ----------------
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF

# rsum.py — decoded-rule dumper. Prints EVERY blob key (so a reminder/time key would
# show), plus cursor / ia / sr / icStart / icCount / template reminderTime + deadline.
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
def rt(v):
    if v is None: return None
    return "%d(%02d:%02d)"%(v,(v>>26)&0x3F,(v>>20)&0x3F)
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationStartDate, rt1_instanceCreationCount, deadline, reminderTime, rt1_instanceCreationPaused, trashed, status, start, startDate FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row: print("NO-ROW"); sys.exit(0)
if row[0] is None:
    print("NO-RULE reminderTime=%s trashed=%s status=%s start=%s startDate=%s"%(rt(row[5]),row[7],row[8],row[9],dpk(row[10]))); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
allkeys=",".join("%s=%s"%(k,(d[k] if not isinstance(d[k],(bytes,bytearray,list,dict)) else '<%s>'%type(d[k]).__name__)) for k in sorted(d))
print("tp=%s fu=%s fa=%s ts=%s rc=%s ed=%s of=[%s] ia=%s sr=%s | next=%s icStart=%s icCount=%s paused=%s trashed=%s status=%s reminderTime=%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),d.get('ed'),",".join(offs),
    uxd(d.get('ia')),uxd(d.get('sr')),dpk(row[1]),dpk(row[2]),row[3],row[6],row[7],row[8],rt(row[5])))
print("  ALLKEYS: "+allkeys)
EOF

# inst.py — live+trashed instances of a template, with reminderTime + status
lab_ssh "$IP" 'cat > ~/labh/inst.py' <<'EOF'
import sys, sqlite3, glob
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
def rt(v):
    if v is None: return None
    return "%d(%02d:%02d)"%(v,(v>>26)&0x3F,(v>>20)&0x3F)
n=0
for u,sd,st,tr,rmt,start in c.execute("SELECT uuid,startDate,status,trashed,reminderTime,start FROM TMTask WHERE rt1_repeatingTemplate=? ORDER BY startDate",(sys.argv[1],)):
    print("  inst %s startDate=%s start=%s status=%s trashed=%s reminderTime=%s"%(u[:8],dpk(sd),start,st,tr,rt(rmt)))
    n+=1
if n==0: print("  (no instances)")
EOF

note "guest helpers installed in ~/labh (gsql.sh rsum.py inst.py)"

# ---------------- build + ship the production e2e bundle ----------------
note "build + ship bundle"
npm run build >"$OUT/build.log" 2>&1 || { note "FATAL build (see $OUT/build.log)"; exit 1; }
[ -f dist/cli/main.js ] || { note "FATAL: dist/cli/main.js missing"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
lab_ssh "$IP" '~/things-lab/bin/node --version' </dev/null >/dev/null 2>&1 || { note "FATAL: guest node not runnable"; exit 1; }
lab_ssh "$IP" '~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js config set ui-enabled true' </dev/null >/dev/null 2>&1
note "bundle shipped; ui-enabled=true. Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
note "SETUP DONE. VM $VM left RUNNING at $IP."
