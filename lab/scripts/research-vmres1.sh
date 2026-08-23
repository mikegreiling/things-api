#!/bin/bash
# VMRES1 — four residual cells, one golden-v4 clone, sequential.
#
#   1  #508 after-completion VM certification (the shipped fix, #540)
#   2  template-direct clone residual cells (d) PROJECT-template clone keeping
#      the source's title+area, and (e) a PAUSED source clones UNPAUSED
#   3  MEASUREMENT: what `update-project?when=<today>` does to a project row's
#      todayIndex / todayIndexReferenceDate, and whether any park+re-enter
#      protocol reaches the Today axis for a project
#   4  the deadlined off-rule Next-SNAP — icCount=0 vs icCount=1 discrimination
#
# METHOD: ONE disposable clone `vmres1-lab` of things-lab-golden-v4 (the golden
# is NEVER booted). Airgapped (default route deleted), guest clock pinned before
# Things launches, synthetic VMRES1-* fixtures only. Ground truth = read-only
# guest SQLite; `open` exit 0 and CLI exit 0 both prove nothing on their own.
# Teardown on EXIT (KEEP=1 to hold the clone).
#
# Usage:  bash lab/scripts/research-vmres1.sh [cell...]     # default: 1 2 3 4
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="vmres1-lab"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
CELLS="${*:-1 2 3 4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
# REUSE=1 attaches to the clone a previous `KEEP=1` invocation left running and
# APPENDS to its report — the campaign is one clone across several sittings.
REUSE="${REUSE:-0}"
[ "$REUSE" = "1" ] || : > "$REPORT"
note() { echo "[vmres1] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"

case "$VM" in things-lab-golden-*) echo "refusing to touch a golden" >&2; exit 1 ;; esac

note "cells: $CELLS · golden: $GOLDEN · reuse=$REUSE"
if [ "$REUSE" = "1" ]; then
  IP=$(tart ip "$VM" 2>/dev/null) || { note "FATAL: $VM is not running"; exit 1; }
  [ -n "$IP" ] || { note "FATAL: no IP for $VM"; exit 1; }
  note "re-attached to $VM at $IP"
else
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 360) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"
fi
cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — $VM left running at $IP"; return; fi
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "teardown done"
}
trap cleanup EXIT

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null

lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-noheader -list); if [ "$1" = "-t" ]; then FMT=(-header -column); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF

# Rule/cursor decoder (rsum.py, the VMQ1/RSPA1 shape) — the single ground-truth
# read for every repeat cell.
lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationCount, deadline, rt1_instanceCreationStartDate, rt1_instanceCreationPaused FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row: print("NO-ROW"); sys.exit(0)
if row[0] is None: print("NO-RULE paused=%s"%row[5]); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s ed=%s of=[%s] OFCOUNT=%d next=%s icStart=%s icCount=%s paused=%s deadline=%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),d.get('ed'),",".join(offs),len(d.get('of',[])),
    dpk(row[1]),dpk(row[4]),row[2],row[5],row[3]))
EOF

# Today-axis dump (cell 3): membership + the comparator triple
# (todayIndexReferenceDate DESC, todayIndex ASC, uuid) — src/read/views.ts.
lab_ssh "$IP" 'cat > ~/labh/today.py' <<'EOF'
import sys, sqlite3, glob
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
def dpk(v):
    if not isinstance(v,int) or v==0 or v is None: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
pat = sys.argv[1] if len(sys.argv)>1 else '%'
rows=c.execute("""SELECT uuid,title,type,start,startBucket,startDate,todayIndex,todayIndexReferenceDate,"index",area,project
  FROM TMTask WHERE trashed=0 AND status=0 AND startDate IS NOT NULL AND start IN (1,2)
  AND title LIKE ? ORDER BY todayIndexReferenceDate DESC, todayIndex ASC, uuid ASC""",(pat,)).fetchall()
for r in rows:
    print("%-9s %-16s kind=%s bkt=%s sd=%-10s tIdx=%-7s tRef=%-10s idx=%-7s" % (
        r[0][:8], (r[1] or '')[:16], 'P' if r[2]==1 else 'T', r[4], dpk(r[5]), r[6], dpk(r[7]), r[8]))
EOF
note "helpers installed"

# ---- ship the shipped CLI (node + dist + commander) ------------------------
[ -f dist/cli/main.js ] || { note "FATAL: dist missing — run npm run build"; exit 1; }
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

VER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
BLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
lab_ssh "$IP" 'open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null
gq() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
note "env: Things $VER ($BLD) · dbv $(gq 'SELECT databaseVersion FROM Meta') · clock $(lab_ssh "$IP" date </dev/null)"

# ---- shared helpers --------------------------------------------------------
b64() { printf %s "$1" | base64; }
lab_ssh "$IP" 'cat > ~/labh/ourl.sh && chmod +x ~/labh/ourl.sh' <<'EOF'
#!/bin/bash
u=$(printf %s "$1" | base64 --decode)
open -g "$u"; echo "EXIT=$?"
EOF
lab_ssh "$IP" 'cat > ~/labh/oas.sh && chmod +x ~/labh/oas.sh' <<'EOF'
#!/bin/bash
printf %s "$1" | base64 --decode > /tmp/vmres1.scpt
osascript /tmp/vmres1.scpt 2>&1; echo "EXIT=$?"
EOF
ourl() { lab_ssh "$IP" "~/labh/ourl.sh $(b64 "$1")" </dev/null; }
oas()  { lab_ssh "$IP" "~/labh/oas.sh $(b64 "$1")" </dev/null; }
rsum() { lab_ssh "$IP" "python3 ~/labh/rsum.py '$1' 2>&1" </dev/null; }
todaydump() { lab_ssh "$IP" "python3 ~/labh/today.py '${1:-%}' 2>&1" </dev/null; }
settle() { lab_ssh "$IP" "sleep ${1:-3}" </dev/null; }
alive() { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null; }
ips_count() { lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/Things3*.ips 2>/dev/null | wc -l | tr -d " "' </dev/null; }
relaunch() { lab_ssh "$IP" 'pkill -x Things3; sleep 4; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
setclock() { lab_ssh "$IP" "sudo date $1 >/dev/null" </dev/null; note "  clock -> $(lab_ssh "$IP" date </dev/null)"; }

# cli <tag> <argv...> — run the shipped CLI, capture to $OUT/cli-<tag>.out, echo
# the exit code on STDOUT (so `rc=$(cli …)` works); progress goes to stderr+report.
notef() { echo "[vmres1] $*" >>"$REPORT"; echo "[vmres1] $*" >&2; }
cli() {
  local tag="$1"; shift
  lab_ssh "$IP" "$CLI $*" </dev/null >"$OUT/cli-$tag.out" 2>&1
  local rc=$?
  notef "    \$ things $* -> exit $rc"
  echo "$rc"
}
clitail() { sed 's/^/      | /' "$OUT/cli-$1.out" | head -${2:-24} | tee -a "$REPORT"; }

tmplid() { lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1\"" </dev/null; }
plainid() { lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 ORDER BY creationDate DESC LIMIT 1\"" </dev/null; }
tmplcount() { lab_ssh "$IP" "~/labh/gsql.sh \"SELECT count(*) FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL AND trashed=0\"" </dev/null; }
instrows() { lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid||' sd='||IFNULL(startDate,'-')||' dl='||IFNULL(deadline,'-')||' trashed='||trashed FROM TMTask WHERE rt1_repeatingTemplate='$1'\"" </dev/null; }
instcount() { lab_ssh "$IP" "~/labh/gsql.sh \"SELECT count(*) FROM TMTask WHERE rt1_repeatingTemplate='$1' AND trashed=0\"" </dev/null; }
dpk() { python3 -c 'v=int('"$1"');print("%04d-%02d-%02d"%(v>>16,(v>>12)&0xF,(v>>7)&0x1F) if v else v)' 2>/dev/null; }

has_cell() { case " $CELLS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

########################################################################
# CELL 1 — #508 after-completion first-occurrence certification
########################################################################
cell1() {
note ""
note "################ CELL 1 — #508 after-completion verify oracle (shipped #540) ################"
note "  add-repeating --after-completion with a FUTURE --when; pre-fix this exited 3 (false verify-failed:mismatch)"
local rc T I ISTART
rc=$(cli 1-ac todo add-repeating "'VMRES1-AC'" --after-completion --frequency weekly --interval 1 \
      --when 2026-07-20 --dangerously-drive-gui --verify-timeout 90000)
clitail 1-ac 30
T=$(tmplid VMRES1-AC)
note "  template=$T"
note "  rule: $(rsum "$T")"
note "  instances: $(instrows "$T")"
I=$(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$T' AND trashed=0 LIMIT 1\"" </dev/null)
if [ -n "$I" ]; then
  ISTART=$(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT IFNULL(startDate,0) FROM TMTask WHERE uuid='$I'\"" </dev/null)
  note "  instance $I startDate = $(dpk "$ISTART") (packed $ISTART)  [expected 2026-07-20]"
else
  note "  NO instance materialized"
fi
note "  exit=$rc  crash=$(alive) ips=$(ips_count)"
local CURSOR; CURSOR=$(rsum "$T" | grep -o 'icStart=[^ ]*')
if [ "$rc" = "0" ]; then
  note "  CELL 1 VERDICT: CERTIFIED — exit 0. The template cursor is $CURSOR while --when was"
  note "    2026-07-20, so the PRE-FIX oracle (firstOccurrenceOf = that cursor) would have raised"
  note "    exactly the #508 false verify-failed:mismatch. Instance oracle: $(if [ -n "$I" ]; then echo "instance $I startDate $(dpk "${ISTART:-0}")"; else echo "no instance (the skip branch)"; fi)."
else
  note "  CELL 1 VERDICT: NOT CERTIFIED (exit=$rc)"
fi

note ""
note "  -- control: the same shape with make-repeating (the other #508 entry point) --"
rc=$(cli 1-mk todo add "'VMRES1-ACM'" --when 2026-07-21)
local M; M=$(plainid VMRES1-ACM)
rc=$(cli 1-mk2 todo make-repeating "$M" --after-completion --frequency weekly --interval 1 \
      --dangerously-drive-gui --verify-timeout 90000)
clitail 1-mk2 24
local T2; T2=$(tmplid VMRES1-ACM)
note "  template=$T2 rule: $(rsum "$T2")"
note "  instances: $(instrows "$T2")"
note "  make-repeating exit=$rc"

note ""
note "  -- the INSTANCE-oracle branch: a SRCFATE-PRESERVED source (deadline trigger) --"
note "  (a deadlined source is preserved as the series' instance, so landedFirstStart has a real row to read)"
rc=$(cli 1-dl todo add "'VMRES1-ACD'" --when 2026-07-20 --deadline 2026-07-25)
local D; D=$(plainid VMRES1-ACD)
note "  seed=$D startDate=$(dpk "$(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT IFNULL(startDate,0) FROM TMTask WHERE uuid='$D'\"" </dev/null)")"
rc=$(cli 1-dl2 todo make-repeating "$D" --after-completion --frequency weekly --interval 1 \
      --dangerously-drive-gui --verify-timeout 90000)
clitail 1-dl2 24
local T3; T3=$(tmplid VMRES1-ACD)
note "  template=$T3 rule: $(rsum "$T3")"
note "  instances: $(instrows "$T3")"
local I3; I3=$(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$T3' AND trashed=0 LIMIT 1\"" </dev/null)
if [ -n "$I3" ]; then
  local S3; S3=$(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT IFNULL(startDate,0) FROM TMTask WHERE uuid='$I3'\"" </dev/null)
  note "  instance $I3 startDate=$(dpk "$S3")  [expected 2026-07-20 = the source's scheduled date]"
  note "  template cursor icStart=$(rsum "$T3" | grep -o 'icStart=[^ ]*')  <- the PRE-FIX oracle"
fi
note "  preserved-source exit=$rc"
}

########################################################################
# CELL 2 — template-direct clone residuals (d) + (e)
########################################################################
cell2() {
note ""
note "################ CELL 2 — template-direct clone residual cells (d) + (e) ################"

note ""
note "  ---- (d) PROJECT-template clone keeping the source's title + area ----"
note "  (exercises sameTitleRowCount's template-exclusion row-select disambiguation, pre-state.ts)"
local rc
rc=$(cli 2d-area area add "'VMRES1-AREA'")
local AREA; AREA=$(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMArea WHERE title='VMRES1-AREA' LIMIT 1\"" </dev/null)
note "  area=$AREA"
rc=$(cli 2d-add project add-repeating "'VMRES1-PT'" --area "'VMRES1-AREA'" --when 2026-07-07 \
      --frequency weekly --interval 1 --weekdays tuesday --dangerously-drive-gui --verify-timeout 90000)
clitail 2d-add 24
local PT; PT=$(tmplid VMRES1-PT)
note "  source project template=$PT rule: $(rsum "$PT")"
note "  pre-clone rows titled VMRES1-PT (templates): $(tmplcount VMRES1-PT)"
note "  pre-clone visible (non-template) projects titled VMRES1-PT: $(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT count(*) FROM TMTask WHERE type=1 AND trashed=0 AND title='VMRES1-PT' AND rt1_recurrenceRule IS NULL AND repeater IS NULL\"" </dev/null)"
rc=$(cli 2d-clone project clone "$PT" --dangerously-drive-gui --verify-timeout 90000)
clitail 2d-clone 30
note "  post-clone template rows titled VMRES1-PT: $(tmplcount VMRES1-PT)"
note "  all VMRES1-PT rows:"
lab_ssh "$IP" "~/labh/gsql.sh -t \"SELECT substr(uuid,1,8) u, type, trashed, IFNULL(area,'-') area, (rt1_recurrenceRule IS NOT NULL) tmpl, IFNULL(rt1_repeatingTemplate,'-') parent FROM TMTask WHERE title='VMRES1-PT'\"" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
note "  source rule after clone: $(rsum "$PT")"
local NEWPT; NEWPT=$(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMTask WHERE title='VMRES1-PT' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 AND uuid!='$PT' LIMIT 1\"" </dev/null)
note "  clone template=$NEWPT rule: $(rsum "${NEWPT:-none}")"
note "  clone area = $(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT IFNULL(area,'NULL') FROM TMTask WHERE uuid='$NEWPT'\"" </dev/null) (source area=$AREA)"
note "  (d) exit=$rc crash=$(alive) ips=$(ips_count)"

note ""
note "  ---- (d2) REGRESSION: back-to-back project-repeat drives in ONE Things session ----"
note "  (the select-row readback race — pre-fix this failed 3/3 on every drive after the first)"
local k
for k in 2 3 4; do
  # trash the previous clone so the row-select target is unambiguous again
  for u in $(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMTask WHERE title='VMRES1-PT' AND trashed=0 AND uuid!='$PT'\"" </dev/null); do
    lab_ssh "$IP" "$CLI project delete $u" </dev/null >/dev/null 2>&1
  done
  settle 3
  rc=$(cli "2d-b$k" project clone "$PT" --dangerously-drive-gui --verify-timeout 90000)
  note "    drive $k (no relaunch) -> exit $rc · $(grep -Eo '^(ok|VERIFY FAILED[^.]*|BLOCKED[^—]*)' "$OUT/cli-2d-b$k.out" | head -1)"
  note "      post-drive selection: $(lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to get id of selected to dos' 2>&1" </dev/null)"
done

note ""
note "  ---- (e) a PAUSED source clones UNPAUSED (disclosed) ----"
rc=$(cli 2e-add todo add "'VMRES1-PAUSE'" --when 2026-07-07)
local PS; PS=$(plainid VMRES1-PAUSE)
rc=$(cli 2e-mk todo make-repeating "$PS" --frequency weekly --interval 1 --weekdays tuesday \
      --dangerously-drive-gui --verify-timeout 90000)
clitail 2e-mk 20
local PSt; PSt=$(tmplid VMRES1-PAUSE)
note "  template=$PSt rule: $(rsum "$PSt")"
rc=$(cli 2e-pause todo pause-repeat "$PSt" --dangerously-drive-gui --verify-timeout 90000)
clitail 2e-pause 20
note "  after pause: $(rsum "$PSt")"
local PAUSED; PAUSED=$(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT IFNULL(rt1_instanceCreationPaused,'-') FROM TMTask WHERE uuid='$PSt'\"" </dev/null)
note "  rt1_instanceCreationPaused = $PAUSED (expect 1)"
rc=$(cli 2e-clone todo clone "$PSt" --dangerously-drive-gui --verify-timeout 90000)
clitail 2e-clone 30
local NEWPS; NEWPS=$(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMTask WHERE title='VMRES1-PAUSE' AND rt1_recurrenceRule IS NOT NULL AND trashed=0 AND uuid!='$PSt' LIMIT 1\"" </dev/null)
note "  clone template=$NEWPS"
note "  clone rule : $(rsum "${NEWPS:-none}")"
note "  source rule: $(rsum "$PSt")"
note "  clone paused = $(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT IFNULL(rt1_instanceCreationPaused,'-') FROM TMTask WHERE uuid='$NEWPS'\"" </dev/null) (expect 0)"
note "  disclosure grep:"
grep -i "paused\|PAUSED" "$OUT/cli-2e-clone.out" | sed 's/^/      /' | tee -a "$REPORT"
note "  (e) exit=$rc crash=$(alive) ips=$(ips_count)"
}

########################################################################
# CELL 3 — MEASUREMENT: the project row on the Today todayIndex axis
########################################################################
cell3() {
note ""
note "################ CELL 3 — a PROJECT row on the Today todayIndex axis (MEASUREMENT) ################"
note "  Today comparator = todayIndexReferenceDate DESC, todayIndex ASC, uuid (src/read/views.ts)"

# fixtures: four to-dos + two projects, all scheduled today (2026-07-05)
local i
for i in 1 2 3 4; do ourl "things:///add?title=VMRES1-T$i&when=today&auth-token=$TOKEN" >/dev/null; done
ourl "things:///add-project?title=VMRES1-P1&when=today&auth-token=$TOKEN" >/dev/null
ourl "things:///add-project?title=VMRES1-P2&when=today&auth-token=$TOKEN" >/dev/null
settle 6
note "  -- baseline Today axis (VMRES1-* only) --"
todaydump 'VMRES1-%' | sed 's/^/    /' | tee -a "$REPORT"
note "  -- full Today cohort (all rows) --"
todaydump '%' | sed 's/^/    /' | tee -a "$REPORT"

local P1 P2 T1
P1=$(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMTask WHERE title='VMRES1-P1' AND trashed=0 LIMIT 1\"" </dev/null)
P2=$(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMTask WHERE title='VMRES1-P2' AND trashed=0 LIMIT 1\"" </dev/null)
T1=$(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMTask WHERE title='VMRES1-T1' AND trashed=0 LIMIT 1\"" </dev/null)
note "  P1=$P1 P2=$P2 T1=$T1"

axis() { lab_ssh "$IP" "~/labh/gsql.sh \"SELECT title||' tIdx='||IFNULL(todayIndex,'NULL')||' tRef='||IFNULL(todayIndexReferenceDate,'NULL')||' idx='||IFNULL(\\\"index\\\",'NULL')||' bkt='||IFNULL(startBucket,'NULL')||' sd='||IFNULL(startDate,'NULL')||' start='||IFNULL(start,'NULL') FROM TMTask WHERE uuid='$1'\"" </dev/null; }
mins() { lab_ssh "$IP" "~/labh/gsql.sh \"SELECT 'min='||MIN(todayIndex)||' max='||MAX(todayIndex)||' n='||COUNT(*) FROM TMTask WHERE trashed=0 AND status=0 AND startDate IS NOT NULL AND start IN (1,2) AND todayIndexReferenceDate=(SELECT todayIndexReferenceDate FROM TMTask WHERE uuid='$1')\"" </dev/null; }

note ""
note "  ---- 3.1 idempotent re-issue: update-project?when=today on a row ALREADY in Today ----"
note "    pre : $(axis "$P1")   cohort $(mins "$P1")"
ourl "things:///update-project?id=$P1&when=today&auth-token=$TOKEN" >/dev/null; settle 5
note "    post: $(axis "$P1")   cohort $(mins "$P1")"

note ""
note "  ---- 3.2 park (when=anytime) + re-enter (when=today): the bounce ----"
ourl "things:///update-project?id=$P1&when=anytime&auth-token=$TOKEN" >/dev/null; settle 5
note "    parked : $(axis "$P1")"
ourl "things:///update-project?id=$P1&when=today&auth-token=$TOKEN" >/dev/null; settle 5
note "    re-entered: $(axis "$P1")   cohort $(mins "$P1")"
note "    Today axis now:"; todaydump 'VMRES1-%' | sed 's/^/      /' | tee -a "$REPORT"

note ""
note "  ---- 3.3 repeatability: three more bounce round-trips (is the landing deterministic?) ----"
for i in 1 2 3; do
  ourl "things:///update-project?id=$P1&when=anytime&auth-token=$TOKEN" >/dev/null; settle 4
  ourl "things:///update-project?id=$P1&when=today&auth-token=$TOKEN" >/dev/null; settle 4
  note "    round $i: $(axis "$P1")   cohort $(mins "$P1")"
done

note ""
note "  ---- 3.4 control: the SAME bounce on a TO-DO (expect front-insert to the global min) ----"
note "    pre : $(axis "$T1")   cohort $(mins "$T1")"
ourl "things:///update?id=$T1&when=anytime&auth-token=$TOKEN" >/dev/null; settle 4
ourl "things:///update?id=$T1&when=today&auth-token=$TOKEN" >/dev/null; settle 4
note "    post: $(axis "$T1")   cohort $(mins "$T1")"

note ""
note "  ---- 3.5 the DATED spelling: update-project?when=<ISO today> vs the keyword ----"
note "    pre : $(axis "$P2")   cohort $(mins "$P2")"
ourl "things:///update-project?id=$P2&when=anytime&auth-token=$TOKEN" >/dev/null; settle 4
ourl "things:///update-project?id=$P2&when=2026-07-05&auth-token=$TOKEN" >/dev/null; settle 4
note "    post: $(axis "$P2")   cohort $(mins "$P2")"

note ""
note "  ---- 3.6 the evening detour: when=evening (EVEORD front-insert) then back to when=today ----"
ourl "things:///update-project?id=$P1&when=evening&auth-token=$TOKEN" >/dev/null; settle 4
note "    evening : $(axis "$P1")   cohort $(mins "$P1")"
ourl "things:///update-project?id=$P1&when=today&auth-token=$TOKEN" >/dev/null; settle 4
note "    back-to-today: $(axis "$P1")   cohort $(mins "$P1")"

note ""
note "  ---- 3.7 park+re-enter MOVE (the AREABACK/PROJROOT shape): does a MOVE touch todayIndex? ----"
local rc
rc=$(cli 3-areaA area add "'VMRES1-HOME'")
rc=$(cli 3-areaB area add "'VMRES1-SCRATCH'")
local HA SA
HA=$(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMArea WHERE title='VMRES1-HOME' LIMIT 1\"" </dev/null)
SA=$(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMArea WHERE title='VMRES1-SCRATCH' LIMIT 1\"" </dev/null)
note "    home area=$HA  scratch area=$SA"
ourl "things:///add-project?title=VMRES1-P3&when=today&area-id=$HA&auth-token=$TOKEN" >/dev/null; settle 5
local P3; P3=$(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMTask WHERE title='VMRES1-P3' AND trashed=0 LIMIT 1\"" </dev/null)
note "    P3=$P3"
note "    pre : $(axis "$P3")   cohort $(mins "$P3")  area=$(lab_ssh "$IP" "~/labh/gsql.sh \"SELECT IFNULL(area,'NULL') FROM TMTask WHERE uuid='$P3'\"" </dev/null)"
ourl "things:///update-project?id=$P3&area-id=$SA&auth-token=$TOKEN" >/dev/null; settle 5
note "    parked to scratch: $(axis "$P3")"
ourl "things:///update-project?id=$P3&area-id=$HA&auth-token=$TOKEN" >/dev/null; settle 5
note "    re-homed to home : $(axis "$P3")   cohort $(mins "$P3")"
note '    (AREABACK front-inserts on the AREA index axis; the question is whether todayIndex moved at all)'

note ""
note "  ---- 3.8 the DLBNC deadline-cycle leg on a PROJECT row (ORD-17's per-KIND analogue) ----"
ourl "things:///update-project?id=$P2&deadline=2026-07-05&auth-token=$TOKEN" >/dev/null; settle 4
note "    deadline set : $(axis "$P2")   cohort $(mins "$P2")"
ourl "things:///update-project?id=$P2&deadline=&auth-token=$TOKEN" >/dev/null; settle 4
note "    deadline clear: $(axis "$P2")   cohort $(mins "$P2")"
ourl "things:///update-project?id=$P2&deadline=2026-07-05&auth-token=$TOKEN" >/dev/null; settle 4
note "    deadline re-set: $(axis "$P2")   cohort $(mins "$P2")"

note ""
note "  -- FINAL Today axis --"
todaydump 'VMRES1-%' | sed 's/^/    /' | tee -a "$REPORT"
note "  crash=$(alive) ips=$(ips_count)"
}

########################################################################
# CELL 3b — does a MIXED reverse-order bounce land the target Today order?
########################################################################
cell3b() {
note ""
note "################ CELL 3b — MIXED (to-do + project) reverse-order today bounce ################"
note "  Cell 3 measured a project's when=today placement leg as a FRONT-insert at the cohort min."
note "  If that holds for an interleaved set, the today bounce needs only a per-KIND leg op."
local i
for i in 1 2 3; do ourl "things:///add?title=VMRES1-M-T$i&when=today&auth-token=$TOKEN" >/dev/null; done
ourl "things:///add-project?title=VMRES1-M-P1&when=today&auth-token=$TOKEN" >/dev/null
ourl "things:///add-project?title=VMRES1-M-P2&when=today&auth-token=$TOKEN" >/dev/null
settle 6

uidof() { lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 LIMIT 1\"" </dev/null; }
kindof() { lab_ssh "$IP" "~/labh/gsql.sh \"SELECT type FROM TMTask WHERE uuid='$1'\"" </dev/null; }
# one bounce leg, PER KIND — a project rides update-project, a to-do rides update
bounce() {
  local u="$1" verb="update"
  [ "$(kindof "$u")" = "1" ] && verb="update-project"
  ourl "things:///$verb?id=$u&when=anytime&auth-token=$TOKEN" >/dev/null; settle 3
  ourl "things:///$verb?id=$u&when=today&auth-token=$TOKEN" >/dev/null; settle 3
}
order() { todaydump 'VMRES1-M-%' | awk '{print $2}' | tr '\n' ' '; }

# target order: P1, T2, P2, T3, T1 (projects deliberately interleaved)
local TARGET="VMRES1-M-P1 VMRES1-M-T2 VMRES1-M-P2 VMRES1-M-T3 VMRES1-M-T1"
note "  target order: $TARGET"
note "  before      : $(order)"
local pass=0 round
for round in 1 2; do
  # dispatch in REVERSE target order — each re-entry front-inserts
  local rev="" t
  for t in $TARGET; do rev="$t $rev"; done
  for t in $rev; do bounce "$(uidof "$t")"; done
  local got; got=$(order)
  note "  round $round -> $got"
  [ "$(echo "$got" | xargs)" = "$(echo "$TARGET" | xargs)" ] && pass=$((pass + 1))
done
note "  full axis:"; todaydump 'VMRES1-M-%' | sed 's/^/    /' | tee -a "$REPORT"
if [ "$pass" = "2" ]; then
  note "  CELL 3b VERDICT: the mixed reverse-order bounce lands the target order 2/2 — DETERMINISTIC"
else
  note "  CELL 3b VERDICT: NOT deterministic ($pass/2) — stop at evidence, do not ship the leg"
fi
note "  crash=$(alive) ips=$(ips_count)"
}

########################################################################
# CELL 3c — CERTIFICATION of the shipped `reorder --in today` with a PROJECT
########################################################################
cell3c() {
note ""
note '################ CELL 3c — shipped `things reorder --in today` carrying a PROJECT row ################'
note "  Pre-fix this exited 4 (blocked:H-REORDER-SCOPE, '<uuid> is a project'). The today spec now"
note "  rides the per-type leg, so the drive must land the requested order through update-project."
# RTAG scopes the fixture titles so a re-run never collides with a prior attempt's rows.
local TAG="${RTAG:-R}" i
for i in 1 2 3; do ourl "things:///add?title=VMRES1-$TAG-T$i&when=today&auth-token=$TOKEN" >/dev/null; done
ourl "things:///add-project?title=VMRES1-$TAG-P1&when=today&auth-token=$TOKEN" >/dev/null
ourl "things:///add-project?title=VMRES1-$TAG-P2&when=today&auth-token=$TOKEN" >/dev/null
settle 6
uidof() { lab_ssh "$IP" "~/labh/gsql.sh \"SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 LIMIT 1\"" </dev/null; }
order() { todaydump "VMRES1-$TAG-%" | awk '{print $2}' | tr '\n' ' '; }
note "  before: $(order)"
local U1 U2 U3 U4 U5
U1=$(uidof "VMRES1-$TAG-P1"); U2=$(uidof "VMRES1-$TAG-T2"); U3=$(uidof "VMRES1-$TAG-P2")
U4=$(uidof "VMRES1-$TAG-T3"); U5=$(uidof "VMRES1-$TAG-T1")
local rc
rc=$(cli 3c reorder "$U1" "$U2" "$U3" "$U4" "$U5" --in today)
clitail 3c 20
note "  after : $(order)"
local WANT="VMRES1-$TAG-P1 VMRES1-$TAG-T2 VMRES1-$TAG-P2 VMRES1-$TAG-T3 VMRES1-$TAG-T1"
note "  target: $WANT"
note "  full axis:"; todaydump "VMRES1-$TAG-%" | sed 's/^/    /' | tee -a "$REPORT"
if [ "$rc" = "0" ] && [ "$(order | xargs)" = "$(echo "$WANT" | xargs)" ]; then
  note "  CELL 3c VERDICT: CERTIFIED — exit 0 and the Today order matches the request"
else
  note "  CELL 3c VERDICT: NOT CERTIFIED (exit=$rc)"
fi
note "  crash=$(alive) ips=$(ips_count)"
}

########################################################################
# CELL 4 — the deadlined off-rule Next-SNAP: icCount=0 vs icCount=1
########################################################################
cell4() {
note ""
note "################ CELL 4 — deadlined off-rule Next-SNAP, icCount discrimination ################"
note "  Setup at clock 2026-07-05; N1 is MATERIALIZED by a +1 day roll, then all three arms"
note "  run the SAME off-rule command at clock 2026-07-06 so only icCount / deadline differ."

local rc
# N1 — will be materialized (icCount=1)
rc=$(cli 4-n1 todo add-repeating "'VMRES1-N1'" --when 2026-07-06 --deadline 2026-07-20 \
      --frequency yearly --interval 1 --dangerously-drive-gui --verify-timeout 90000)
local N1; N1=$(tmplid VMRES1-N1); note "  N1=$N1 $(rsum "$N1")"

note "  -- advance clock to 2026-07-06 and relaunch to MATERIALIZE N1 --"
setclock 070612002026
relaunch
settle 8
note "  N1 after materialize: $(rsum "$N1")  instances=$(instcount "$N1")"
note "    $(instrows "$N1")"

# N0 — deadlined, stays icCount=0 (first occurrence tomorrow)
rc=$(cli 4-n0 todo add-repeating "'VMRES1-N0'" --when 2026-07-07 --deadline 2026-07-21 \
      --frequency yearly --interval 1 --dangerously-drive-gui --verify-timeout 90000)
local N0; N0=$(tmplid VMRES1-N0); note "  N0=$N0 $(rsum "$N0")  instances=$(instcount "$N0")"

# NX — NON-deadlined, icCount=0 (deadline-dependence discriminator)
rc=$(cli 4-nx todo add-repeating "'VMRES1-NX'" --when 2026-07-07 \
      --frequency yearly --interval 1 --dangerously-drive-gui --verify-timeout 90000)
local NX; NX=$(tmplid VMRES1-NX); note "  NX=$NX $(rsum "$NX")  instances=$(instcount "$NX")"

note ""
note "  ---- ARM 4A: deadlined, icCount=0, OFF-RULE (--yearly-month 10 --on-day 16 --when 2028-11-05) ----"
note "    pre : $(rsum "$N0")"
rc=$(cli 4a todo reschedule-repeat "$N0" --frequency yearly --interval 1 --yearly-month 10 \
      --on-day 16 --when 2028-11-05 --dangerously-drive-gui --verify-timeout 90000)
clitail 4a 30
note "    post: $(rsum "$N0")   instances=$(instcount "$N0")"
note "    ARM 4A exit=$rc"

note ""
note "  ---- ARM 4B: deadlined, icCount=1, the SAME off-rule command ----"
note "    pre : $(rsum "$N1")"
rc=$(cli 4b todo reschedule-repeat "$N1" --frequency yearly --interval 1 --yearly-month 10 \
      --on-day 16 --when 2028-11-05 --dangerously-drive-gui --verify-timeout 90000)
clitail 4b 30
note "    post: $(rsum "$N1")   instances=$(instcount "$N1")"
note "    $(instrows "$N1")"
note "    ARM 4B exit=$rc"

note ""
note "  ---- ARM 4C: NON-deadlined, icCount=0, the SAME off-rule command (deadline discriminator) ----"
note "    pre : $(rsum "$NX")"
rc=$(cli 4c todo reschedule-repeat "$NX" --frequency yearly --interval 1 --yearly-month 10 \
      --on-day 16 --when 2028-11-05 --dangerously-drive-gui --verify-timeout 90000)
clitail 4c 30
note "    post: $(rsum "$NX")   instances=$(instcount "$NX")"
note "    ARM 4C exit=$rc"

note "  crash=$(alive) ips=$(ips_count)"
}

for c in $CELLS; do
  case "$c" in
    1) cell1 ;;
    2) cell2 ;;
    3) cell3 ;;
    3b) cell3b ;;
    3c) cell3c ;;
    4) cell4 ;;
    *) note "unknown cell '$c'" ;;
  esac
done

note ""
note "==== DONE — report: $REPORT ===="
