#!/bin/bash
# ANCH1 — fixed-recurrence ANCHOR law + phase-correction viability (issue #476).
#
# The bug: creating/promoting a to-do into a fixed "every 2 weeks on Wednesday"
# recurrence does NOT preserve the supplied first-occurrence date — the app
# anchors the first occurrence from TODAY (next matching weekday), ignoring the
# promoted row's scheduled `when`. Reported on Things 3.22.13; this campaign
# reproduces + characterizes it under golden-v2 / Things 3.22.12.
#
# Phases (ONE disposable clone of things-lab-golden-v2, AX baked, airgapped,
# clock pinned 2026-07-05 12:00 = a SUNDAY, advanced only in +1-day steps):
#   P0   reproduce the issue repro (make-repeating + add-repeating) under 3.22.12
#   A2   anchor-derivation matrix: source when in {today, aligned-future-Wed,
#        misaligned-future-Thu, someday} x weekly/2/wed, + a weekly/1 control
#   A3   weekday default: weekly/2 with NO --weekdays, at pinned Sunday + a
#        +1-day Monday probe (disambiguates constant-Sunday vs today's/tomorrow's wd)
#   A1   dialog census: dump the Repeat sheet AX tree in fixed-weekly mode —
#        does ANY control expose a first-occurrence/anchor date?
#   A4   after-completion Ends census: dump the Ends popup menu items in AC mode
#   A5   phase-correction: a daily/2 template (cursor on the 2-day grid) — try to
#        move the cursor OFF-grid via AS `schedule` on the template + on the
#        instance; read cursor+ia/sr before/after + after warm; then advance past
#        it and read whether the spawn carries the moved phase or snaps back to
#        the ia/sr grid.  NEVER the URL vector (known crash).
#
# Method mirrors research-uic8.sh (golden-v2, System Events over SSH, no VNC).
# Ground truth = read-only guest SQLite (decoded rt1_recurrenceRule + cursor).
# Fixtures fully synthetic (AN* titles). Branch mg/476-repeat-anchor.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="anch1-lab"
GOLDEN="things-lab-golden-v2"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/snaps" "$OUT/json" "$OUT/ax"
REPORT="$OUT/report.txt"
: > "$REPORT"
note() { echo "[anch1] $*" | tee -a "$REPORT"; }
cleanup() { echo "[anch1] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# ---------------- preflight ----------------
FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB (golden=$GOLDEN)"
[ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free. Abort."; exit 1; }

# ---------------- host toolchain (self-contained node) ----------------
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

# ---------------- clone + boot (golden-v2 has AX baked) ----------------
note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300); note "ssh up at $IP"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null | sed 's/^/[anch1] /'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "Accessibility auth_value=$GRANT (2=granted, baked in golden-v2)"
if [ "$GRANT" != "2" ]; then note "FATAL: Accessibility grant missing on clone (auth_value=$GRANT). Abort."; exit 1; fi

# ---------------- guest helpers ----------------
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# decoded-rule dumper — prints fu/fa/tp/of + cursor + ia/sr(as dates) + icStart.
# next/icStart are PACKED dates (y<<16|m<<12|d<<7); ia/sr are UNIX-epoch seconds.
lab_ssh "$IP" 'cat > /tmp/rsum.py' <<'EOF'
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
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationStartDate, rt1_instanceCreationCount, deadline FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row or row[0] is None: print("NO-RULE"); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s ed=%s of=[%s] ia=%s sr=%s next=%s icStart=%s icCount=%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),d.get('ed'),",".join(offs),
    uxd(d.get('ia')),uxd(d.get('sr')),dpk(row[1]),dpk(row[2]),row[3]))
EOF
rsum() { lab_ssh "$IP" "python3 /tmp/rsum.py $1" </dev/null; }
# live (non-trashed) instances of a template + their startDates (packed decoded)
liveinst(){ gq "SELECT COUNT(*) FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0"; }
lab_ssh "$IP" 'cat > /tmp/inst.py' <<'EOF'
import sys, sqlite3, glob
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
for u,sd,st,tr in c.execute("SELECT uuid,startDate,status,trashed FROM TMTask WHERE rt1_repeatingTemplate=? ORDER BY startDate",(sys.argv[1],)):
    print("  inst %s startDate=%s status=%s trashed=%s"%(u[:8],dpk(sd),st,tr))
EOF
insts() { lab_ssh "$IP" "python3 /tmp/inst.py $1" </dev/null | tee -a "$REPORT"; }

# AX dumper for the Repeat dialog census (JXA over the ObjC bridge; AX baked)
lab_ssh "$IP" 'cat > /tmp/axdump.jxa' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices')
function pidOf(n){return Application('System Events').processes.byName(n).unixId()}
function attr(el,n){var o=Ref();if($.AXUIElementCopyAttributeValue(el,$(n),o)!==0)return null;return ObjC.castRefToObject(o[0])}
function sv(el,n){var v=attr(el,n);try{return v?String(v.js):''}catch(e){return ''}}
function kids(el){var c=attr(el,'AXChildren');if(!c)return[];var a=[];for(var i=0;i<c.count;i++)a.push(c.objectAtIndex(i));return a}
function appEl(){return $.AXUIElementCreateApplication(pidOf('Things3'))}
function line(el,d){
  var parts=['role='+sv(el,'AXRole'),'sub='+sv(el,'AXSubrole')]
  var t=sv(el,'AXTitle'); if(t)parts.push('ttl='+t)
  var de=sv(el,'AXDescription'); if(de)parts.push('desc='+de)
  var rd=sv(el,'AXRoleDescription'); if(rd)parts.push('rdesc='+rd)
  var v=sv(el,'AXValue'); if(v)parts.push('val='+v)
  var id=sv(el,'AXIdentifier'); if(id)parts.push('id='+id)
  return Array(d+1).join('  ')+parts.join(' | ')
}
function walk(el,d,acc){acc.push(line(el,d)); if(d>12)return acc; var ch=kids(el); for(var i=0;i<ch.length;i++)walk(ch[i],d+1,acc); return acc}
function findSheet(){
  var ws=kids(appEl())
  for(var i=0;i<ws.length;i++){var s=kids(ws[i]); for(var j=0;j<s.length;j++){if(sv(s[j],'AXRole')==='AXSheet')return s[j]}}
  return null
}
function run(argv){
  var sh=findSheet()
  if(!sh)return 'NO-SHEET'
  return walk(sh,0,[]).join('\n')
}
EOF
axdump() { lab_ssh "$IP" 'osascript -l JavaScript /tmp/axdump.jxa' </dev/null; }

# ---------------- ship the production e2e bundle + enable ui ----------------
note "############### build + ship bundle + ui-enabled ###############"
npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: npm run build failed (see $OUT/build.log)."; exit 1; }
[ -f dist/cli/main.js ] || { note "FATAL: dist/cli/main.js missing after build. Abort."; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
if ! lab_ssh "$IP" '~/things-lab/bin/node --version' </dev/null >/dev/null 2>&1; then
  note "FATAL: guest node not runnable after ship — bundle ship failed. Abort."; exit 1
fi
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
G() { lab_ssh "$IP" "$CLI $*" </dev/null; }
G config set ui-enabled true >/dev/null 2>&1

# jd/jval — drive the CLI, capture json+err+exit, print a compact verdict
jd() {
  local name="$1"; shift
  lab_ssh "$IP" "$CLI $* --json" </dev/null > "$OUT/json/$name.json" 2> "$OUT/json/$name.err"
  echo "$?" > "$OUT/json/$name.exit"
  local ex; ex=$(cat "$OUT/json/$name.exit")
  local verdict
  verdict=$(python3 - "$OUT/json/$name.json" <<'PY'
import sys,json
objs=[]
for line in open(sys.argv[1]):
    line=line.strip()
    if not line: continue
    try: objs.append(json.loads(line))
    except Exception: pass
if not objs: print("NON-JSON/empty"); sys.exit()
d=objs[-1]
if d.get("ok"):
    da=d.get("data",{}); rp=da.get("repeating") or {}
    print("ok uuid=%s tmpl=%s inst=%s repl=%s"%(str(da.get("uuid"))[:8], str(rp.get("templateUuid"))[:8], str(rp.get("instanceUuid"))[:8], str(rp.get("replacedUuid"))[:8]))
else:
    er=d.get("error",{}); print("ERR code=%s msg=%s"%(er.get("code"), str(er.get("message"))[:80]))
PY
)
  note "  [$name] exit=$ex $verdict"
}
jval() {
  python3 - "$OUT/json/$1.json" "$2" <<'PY'
import json,sys
try:
  objs=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
except Exception: print(""); sys.exit()
d=objs[-1] if objs else {}
cur=d.get("data",{})
for k in sys.argv[2].split('.'):
    cur=cur.get(k) if isinstance(cur,dict) else None
print(cur if cur is not None else "")
PY
}

uidt() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_repeatingTemplate IS NULL AND rt1_recurrenceRule IS NULL AND trashed=0 LIMIT 1"; }
warm()   { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 15; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
env_line() { note "-- env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / DB v26 / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) --"; }
clock_to() { settle; lab_ssh "$IP" "sudo date $1 >/dev/null" </dev/null; note "  clock -> $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"; warm; }

env_line
note "pinned clock 2026-07-05 (Sunday). today-anchor prediction for weekly/wednesday: next Wed = 2026-07-08."

# anchor_probe <label> <title> <addWhenArgs...> ; rule from env RULEARGS
anchor_probe() {
  local label="$1" title="$2"; shift 2
  local ADD=("$@")
  G todo add \"$title\" "${ADD[@]}" >/dev/null 2>&1; sleep 1
  local X; X=$(uidt "$title")
  note "  seed X=$X when-args='${ADD[*]}' startDate=$(gq "SELECT startDate FROM TMTask WHERE uuid='$X'")"
  warm
  jd "$label" todo make-repeating "$X" $RULEARGS --dangerously-drive-gui
  settle
  local T; T=$(jval "$label" repeating.templateUuid)
  note "  [$label] template=$T  rule: $(rsum "$T")"
  note "  [$label] live instances ($(liveinst "$T")):"; insts "$T"
}

# =====================================================================
note ""; note "################################################################"
note "# P0 — reproduce the issue repro under 3.22.12 (make-repeating + add-repeating)"
note "################################################################"
RULEARGS="--frequency weekly --interval 2 --weekdays wednesday --ends-on 2026-12-30"
anchor_probe p0-make "AN-P0" --when 2026-07-15

note ""; note "### P0b — add-repeating (no-clone path, issue item 6: shared behavior?) ###"
warm
jd p0-add todo add-repeating \"AN-P0b\" --when 2026-07-15 --frequency weekly --interval 2 --weekdays wednesday --ends-on 2026-12-30 --dangerously-drive-gui
settle
T0B=$(jval p0-add repeating.templateUuid)
note "  [p0-add] template=$T0B  rule: $(rsum "$T0B")"
note "  [p0-add] live instances ($(liveinst "$T0B")):"; insts "$T0B"

# =====================================================================
note ""; note "################################################################"
note "# A2 — anchor-derivation matrix (weekly/2/wednesday unless noted)"
note "################################################################"
RULEARGS="--frequency weekly --interval 2 --weekdays wednesday"
anchor_probe a2-today   "AN-A2-today"  --when today
anchor_probe a2-aligned "AN-A2-align"  --when 2026-07-15
anchor_probe a2-misalig "AN-A2-mis"    --when 2026-07-16
anchor_probe a2-someday "AN-A2-someday" --when someday
note ""; note "### A2 control — weekly/1/wednesday, aligned Wed when (interval independence) ###"
RULEARGS="--frequency weekly --interval 1 --weekdays wednesday"
anchor_probe a2-int1    "AN-A2-int1"   --when 2026-07-15

# =====================================================================
note ""; note "################################################################"
note "# A3 — weekday default (NO --weekdays): what wd does the dialog default to?"
note "################################################################"
RULEARGS="--frequency weekly --interval 2"
anchor_probe a3-today-nowd "AN-A3-today" --when today
anchor_probe a3-align-nowd "AN-A3-align" --when 2026-07-15

note ""; note "### A3 Monday probe — advance clock +1 day to 2026-07-06 (Monday), no --weekdays ###"
clock_to 070612002026
note "  disambiguation: constant-Sunday=>wd0(next Sun 07-12); today-wd=>wd1(Mon); tomorrow-wd=>wd2(Tue 07-07)"
RULEARGS="--frequency weekly --interval 2"
anchor_probe a3-mon-nowd "AN-A3-mon" --when today
clock_to 070512002026

# =====================================================================
note ""; note "################################################################"
note "# A1 — dialog census: is there ANY first-occurrence/anchor control?"
note "################################################################"
G todo add \"AN-A1\" --when 2026-07-15 >/dev/null 2>&1; sleep 1
XA1=$(uidt "AN-A1"); note "  census subject X=$XA1 (plain, when=2026-07-15 Wed)"
warm
lab_ssh "$IP" "open 'things:///show?id=$XA1'; sleep 2" </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\'' 2>/dev/null; sleep 1' </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu 1 of menu bar item "Items" of menu bar 1'\'' 2>>'"$OUT"'/ax/a1-open.err' </dev/null; sleep 2
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to tell sheet 1 of window 1 to tell pop up button 1 to click (first menu item of menu 1 whose title contains "week")'\'' 2>>'"$OUT"'/ax/a1-open.err' </dev/null; sleep 1
note "  --- A1 Repeat-sheet AX census (fixed weekly) ---"
axdump | tee "$OUT/ax/a1-census.txt" | sed 's/^/  /' | tee -a "$REPORT"
DTAREAS=$(grep -c 'AXDateTimeArea' "$OUT/ax/a1-census.txt" 2>/dev/null || echo 0)
note "  A1 verdict: AXDateTimeArea controls in fixed-weekly sheet = $DTAREAS (reminder-off/ends-never => expect 0; any date control here would be a first-occ anchor)"
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' 2>/dev/null' </dev/null; sleep 1
settle

# =====================================================================
note ""; note "################################################################"
note "# A4 — after-completion Ends census: is 'on date' absent from the Ends popup?"
note "################################################################"
G todo add \"AN-A4\" >/dev/null 2>&1; sleep 1
XA4=$(uidt "AN-A4"); note "  census subject X=$XA4"
warm
lab_ssh "$IP" "open 'things:///show?id=$XA4'; sleep 2" </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\'' 2>/dev/null; sleep 1' </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu 1 of menu bar item "Items" of menu bar 1'\'' 2>>'"$OUT"'/ax/a4-open.err' </dev/null; sleep 2
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to tell sheet 1 of window 1 to tell pop up button 1 to click (first menu item of menu 1 whose title contains "completion")'\'' 2>>'"$OUT"'/ax/a4-open.err' </dev/null; sleep 1
note "  --- A4 after-completion Ends popup menu items ---"
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to tell sheet 1 of window 1 to tell pop up button 1 of group 1'\'' -e '\''click'\'' -e '\''delay 0.4'\'' -e '\''set t to (get title of every menu item of menu 1)'\'' -e '\''key code 53'\'' -e '\''return t'\'' -e '\''end tell'\'' 2>>'"$OUT"'/ax/a4-open.err' </dev/null | tee "$OUT/ax/a4-ends.txt" | sed 's/^/  Ends items: /' | tee -a "$REPORT"
note "  --- A4 full after-completion sheet census ---"
axdump | tee "$OUT/ax/a4-census.txt" | sed 's/^/  /' | tee -a "$REPORT"
if grep -qi 'on date' "$OUT/ax/a4-ends.txt" 2>/dev/null; then note "  A4 verdict: 'on date' IS present in AC-mode Ends (expressible)"; else note "  A4 verdict: 'on date' ABSENT in AC-mode Ends (=> afterCompletion+ends:on-date inexpressible; refuse)"; fi
lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' 2>/dev/null' </dev/null; sleep 1
settle

# =====================================================================
note ""; note "################################################################"
note "# A5 — phase-correction viability (daily/2 template; move cursor OFF the ia/sr grid)"
note "################################################################"
G todo add \"AN-A5\" --when today >/dev/null 2>&1; sleep 1
XA5=$(uidt "AN-A5"); note "  seed X=$XA5"
warm
jd a5-make todo make-repeating "$XA5" --frequency daily --interval 2 --dangerously-drive-gui
settle
T5=$(jval a5-make repeating.templateUuid); I5=$(jval a5-make repeating.instanceUuid)
note "  daily/2 template=$T5 instance=$I5"
note "  A5 baseline rule: $(rsum "$T5")"; note "  A5 baseline instances:"; insts "$T5"

note ""; note "### A5(a) — AS schedule the TEMPLATE to 2026-07-08 (off the 2-day grid) ###"
warm
A5A=$(lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to schedule (first to do whose id = "'"$T5"'") for (date "July 8, 2026")'\'' 2>&1' </dev/null || true)
note "  A5(a) schedule-template result: ${A5A:-<ok/empty>}"
settle
note "  A5(a) template rule after (cursor/ia/sr moved?): $(rsum "$T5")"
warm; note "  A5(a) after warm relaunch: $(rsum "$T5")"; settle

note ""; note "### A5(b) — AS schedule the current INSTANCE to 2026-07-08 ###"
warm
A5B=$(lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to schedule (first to do whose id = "'"$I5"'") for (date "July 8, 2026")'\'' 2>&1' </dev/null || true)
note "  A5(b) schedule-instance result: ${A5B:-<ok/empty>}"
settle
note "  A5(b) instance startDate after: $(gq "SELECT startDate FROM TMTask WHERE uuid='$I5'")"
note "  A5(b) template rule after (cursor moved?): $(rsum "$T5")"

note ""; note "### A5(c) control — reschedule-repeat daily/2 -> daily/3 (does ia/sr/cursor move?) ###"
warm
jd a5-resched todo reschedule-repeat "$T5" --frequency daily --interval 3 --dangerously-drive-gui
settle
note "  A5(c) template rule after reschedule: $(rsum "$T5")"

note ""; note "### A5 spawn observation — advance 07-06 -> 07-07 -> 07-08 and read cursor phase ###"
clock_to 070612002026; note "  @07-06 rule: $(rsum "$T5")"; insts "$T5"
clock_to 070712002026; note "  @07-07 rule: $(rsum "$T5")"; insts "$T5"
clock_to 070812002026; note "  @07-08 rule: $(rsum "$T5")"; insts "$T5"

# =====================================================================
note ""; note "################################################################"
note "# SUMMARY"
note "################################################################"
env_line
note "DONE. report: $REPORT   snapshots: $OUT/snaps/   json: $OUT/json/   ax: $OUT/ax/"
