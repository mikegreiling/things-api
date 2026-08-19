#!/bin/bash
# VMQ1 validation boot — item 1 deadlined lone-Next cell (the closest reproduction
# of the live 2026-08-19 failure), item 2 raw-`of` decode to settle the blind-"+"
# duplicate question, item 4 (RSPA1-D) disclosure confirmation. ONE disposable clone
# of golden-v3 (Things 3.22.14). Self-contained; teardown on EXIT. Fixtures synthetic.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="vmq1-validate"
GOLDEN="things-lab-golden-v3"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[vmq1v] $*" | tee -a "$REPORT"; }
cleanup() { echo "[vmq1v] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
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

lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
# rsum.py — FIXED (the diag boot selected a non-existent rt1_reminderTime column;
# reminder is not needed here, so it is dropped — parity with rspa1-pending.sh).
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
row=c.execute("SELECT rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationStartDate, rt1_instanceCreationCount, deadline FROM TMTask WHERE uuid=?", (sys.argv[1],)).fetchone()
if not row or row[0] is None: print("NO-RULE"); sys.exit(0)
d=plistlib.loads(row[0]); offs=[]
for o in d.get('of',[]):
    offs.append("{"+",".join("%s=%s"%(k,o[k]) for k in ('dy','mo','wd','wdo') if k in o)+"}")
print("tp=%s fu=%s fa=%s ts=%s rc=%s ed=%s of=[%s] OFCOUNT=%d ia=%s sr=%s next=%s icStart=%s icCount=%s deadline=%s"%(
    d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),d.get('ed'),",".join(offs),len(d.get('of',[])),
    uxd(d.get('ia')),uxd(d.get('sr')),dpk(row[1]),dpk(row[2]),row[3],row[4]))
EOF
note "helpers installed"

[ -f dist/cli/main.js ] || { note "FATAL: dist/cli/main.js missing"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { local a c; for a in 1 2 3 4 5; do sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; c=$?; [ "$c" -eq 0 ] && return 0; sleep 3; done; return "$c"; }
lab_ssh "$IP" true </dev/null; sleep 2
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null || { note "FATAL: node scp"; exit 1; }
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
COMMANDER_DIR=$(node -e "const p=require.resolve('commander'); console.log(p.slice(0, p.indexOf('/node_modules/commander/')+'/node_modules/commander'.length))")
scpO -r "$COMMANDER_DIR" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null || { note "FATAL: commander scp"; exit 1; }
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
mk() { local title="$1"; shift; lab_ssh "$IP" "$CLI todo add '$title'" </dev/null >/dev/null 2>&1; sleep 1; local uid; uid=$(plainid "$title"); note "  make $title ($uid): $*"; lab_ssh "$IP" "$CLI todo make-repeating '$uid' $* --dangerously-drive-gui --verify-timeout 90000" </dev/null >"$OUT/mk-$title.out" 2>&1; note "    make exit=$?"; sleep 2; }
resched() { local label="$1" title="$2"; shift 2; local t; t=$(tmplid "$title"); note "  [$label] pre : $(rsum "$t")"; note "  [$label] cmd : reschedule-repeat $*"; lab_ssh "$IP" "$CLI todo reschedule-repeat '$t' $* --dangerously-drive-gui --verify-timeout 40000 --json" </dev/null >"$OUT/$label.out" 2>&1; note "  [$label] cli-exit=$?"; grep -o '"ok":[a-z]*\|"code":"[^"]*"\|"anchorKey":"[^"]*"\|nextOccurrence":"[^"]*"' "$OUT/$label.out" | tr '\n' ' ' | sed 's/^/      observed: /' | tee -a "$REPORT"; echo "" ; grep -o 'off-rule[^"\\]*' "$OUT/$label.out" | head -1 | sed 's/^/      DISCLOSURE: /' | tee -a "$REPORT"; sleep 2; note "  [$label] post: $(rsum "$t")"; }

# ==================== ITEM 1 — deadlined same-anchor lone-Next (live-failure shape)
note "==================== ITEM 1: DEADLINED same-anchor lone-Next ===================="
mk I1DL --frequency yearly --interval 1 --when 2026-07-20 --deadline --start-days-earlier 14
note "  (make drives Next=Aug 3 = due; anchor Aug 3; ts=-14)"
note "-- deadlined yearly, reschedule --when 2030-07-20 same deadline: only Next(=2030-08-03 due) changes --"
note "   COMMIT => next=2030-07-20 / anchor Aug3 unchanged ; DISCARD => cursor unchanged + verify-fail"
resched cell1DL I1DL --frequency yearly --interval 1 --when 2030-07-20 --deadline --start-days-earlier 14

# ==================== ITEM 2 — raw `of` to settle the blind-"+" duplicate question
note "==================== ITEM 2: raw of-array (blind-'+' duplicate?) ===================="
mk I2Wb --frequency weekly --interval 1 --weekdays monday
note "-- 2Wb: {mon} -> {tue,thu} (1->2 rows: one '+' press). CLEAN => OFCOUNT=2, of=[tue,thu] --"
resched cell2Wb I2Wb --frequency weekly --interval 1 --weekdays tuesday,thursday
mk I2Mb --frequency weekly --interval 1 --weekdays monday,wednesday
note "-- 2Mb: pre-populated {mon,wed}, reschedule interval 1->2 keeping {mon,wed}. CLEAN => OFCOUNT=2 --"
note "   BUG (blind '+') => OFCOUNT=3 (an extra/duplicate weekday row atop the pre-existing set)"
resched cell2Mb I2Mb --frequency weekly --interval 2 --weekdays monday,wednesday
mk I2Tb --frequency weekly --interval 1 --weekdays monday,wednesday
note "-- 2Tb: pre-populated {mon,wed} -> {tue,thu,sat} (2->3 rows: two '+' presses). CLEAN => OFCOUNT=3 --"
resched cell2Tb I2Tb --frequency weekly --interval 1 --weekdays tuesday,thursday,saturday

# ==================== ITEM 4 — RSPA1-D disclosure confirmation
note "==================== ITEM 4: RSPA1-D preserved-deadline disclosure ===================="
mk I4 --frequency yearly --interval 1 --when 2026-07-06 --deadline --start-days-earlier 14
note "  I4 template: $(rsum "$(tmplid I4)")  (deadlined yearly, ts=-14)"
note "-- reschedule --yearly-month 10 --on-day 16 --when 2028-11-05 (NO --deadline; off-rule, deadline PRESERVED) --"
note "   EXPECT disclosure: 'appears 2028-10-22, due 2028-11-05' (was 'appears 2028-11-05')"
resched cell4 I4 --frequency yearly --interval 1 --yearly-month 10 --on-day 16 --when 2028-11-05

note "VMQ1 VALIDATE DONE."
