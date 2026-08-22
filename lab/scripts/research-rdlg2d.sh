#!/bin/bash
# RDLG2d — the ≤3.22 REGRESSION arm of the 3.23 recipe rewrite: the same
# production binary, driven against golden-v3 (Things 3.22.14), must still drive
# the OLD dialog. The recipes carry both index sets and pick by MEASURED
# structure, so this is the arm that proves the fork self-selects rather than
# quietly assuming the newest shape.
#
#   D1  the shape probe reads `legacy` on 3.22 (and the tree backs it: an Ends:
#       label, a first-occurrence AXDateTimeArea, NO Next: label);
#   D2  weekly multi-weekday lands the right rule bytes at the legacy indices;
#   D3  reschedule drives through the OLD `Reschedule…` menu spelling;
#   D4  the RRD1 converge fixes the stale-row trap on 3.22 as well as 3.23;
#   D5  an OFF-RULE first occurrence — impossible on 3.23 — still lands here.
#
# METHOD: ONE disposable clone of things-lab-golden-v3 (the golden is never
# booted). Airgap, clock pinned 2026-07-05 (a SUNDAY). Fixtures synthetic
# (RDLG2D-*). Teardown on EXIT (KEEP=1 to leave it up).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-rdlg2d-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v3}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[rdlg2d] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"

if [ "${SKIP_BUILD:-0}" = "1" ]; then note "SKIP_BUILD=1 — reusing dist/"; else
note "building dist"
npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
fi

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
[ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"

lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }

lab_ssh "$IP" 'cat > ~/labh/rsum.py' <<'EOF'
import sys, sqlite3, glob, plistlib
db=glob.glob('/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite')[0]
c=sqlite3.connect('file:%s?mode=ro'%db, uri=True)
WD=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]
def dpk(v):
    if not isinstance(v,int) or v==0: return v
    y=v>>16; m=(v>>12)&0xF; d=(v>>7)&0x1F
    return "%04d-%02d-%02d"%(y,m,d) if 1<y<5000 else v
rows=c.execute("SELECT uuid, rt1_recurrenceRule, rt1_nextInstanceStartDate, rt1_instanceCreationStartDate, rt1_instanceCreationCount, deadline FROM TMTask WHERE title=? AND rt1_recurrenceRule IS NOT NULL", (sys.argv[1],)).fetchall()
if not rows: print("NO-TEMPLATE"); sys.exit(0)
for row in rows:
    d=plistlib.loads(row[1]); offs=[]
    for o in d.get('of',[]):
        bits=[]
        if 'wd' in o: bits.append("wd=%s(%s)"%(o['wd'], WD[o['wd']] if 0<=o['wd']<7 else "?"))
        for k in ('dy','mo','wdo'):
            if k in o: bits.append("%s=%s"%(k,o[k]))
        offs.append("{"+",".join(bits)+"}")
    print("tp=%s fu=%s fa=%s ts=%s rc=%s of=[%s] next=%s icStart=%s icCount=%s"%(
        d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),",".join(offs),
        dpk(row[2]),dpk(row[3]),row[4]))
EOF
rsum() { lab_ssh "$IP" "python3 ~/labh/rsum.py $(printf '%q' "$1")" </dev/null 2>&1; }

axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
esc() { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }

TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
note "env: Things $TVER ($TBLD) / golden $GOLDEN"

NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
G() { lab_ssh "$IP" "$CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
note "shipped dist; ui-enabled=true"

mktodo() {
  lab_ssh "$IP" "open -g 'things:///add?title=$1&auth-token=$TOKEN'; sleep 4" </dev/null
  gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NULL LIMIT 1"
}
PASS=0; FAIL=0
cell() { note ""; note "=== $1 ==="; }
verdict() { if echo "$3" | grep -qF "$2"; then note "  PASS $1"; PASS=$((PASS+1)); else note "  FAIL $1 — expected '$2', got: $3"; FAIL=$((FAIL+1)); fi; }

warm

# =====================================================================
cell "D1 the shape probe reads LEGACY on 3.22 (and the tree backs it)"
U=$(mktodo RDLG2D-PROBE)
lab_ssh "$IP" "open -g 'things:///show?id=$U'; sleep 3" </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
lab_ssh "$IP" 'sleep 3' </dev/null
axq 'tell application "System Events" to tell process "Things3"
  set sh to sheet 1 of (first window whose subrole is "AXStandardWindow")
  set p to pop up button 1 of sh
  repeat 20 times
    if (exists menu 1 of p) then exit repeat
    click p
    delay 0.3
  end repeat
  click menu item "weekly" of menu 1 of p
  delay 1.5
end tell' >/dev/null
# the exact production probe script, run by hand against the open 3.22 dialog
PROBE=$(axq 'tell application "System Events" to tell process "Things3"
  set g to (group 1 of sheet 1 of (first window whose subrole is "AXStandardWindow"))
  set nextY to missing value
  set nStatic to (count of static texts of g)
  repeat with i from 1 to nStatic
    set v to ""
    try
      set v to (value of static text i of g) as text
    end try
    if v is "Next:" then
      set p to position of static text i of g
      set nextY to item 2 of p
    end if
  end repeat
  if nextY is missing value then return "unknown"
  set nPop to (count of pop up buttons of g)
  repeat with i from 1 to nPop
    set p to position of pop up button i of g
    set dy to (item 2 of p) - nextY
    if dy < 0 then set dy to -dy
    if dy <= 8 then return "next-popup"
  end repeat
  try
    set areas to (every UI element of g whose role is "AXDateTimeArea")
    repeat with i from 1 to (count of areas)
      set p to position of (item i of areas)
      set dy to (item 2 of p) - nextY
      if dy < 0 then set dy to -dy
      if dy <= 8 then return "legacy"
    end repeat
  end try
  return "unknown"
end tell')
note "  probe verdict: $PROBE"
verdict "D1 probe = legacy" "legacy" "$PROBE"
note "  3.22 weekly group inventory (for the record):"
axq 'tell application "System Events" to tell process "Things3"
  set g to group 1 of sheet 1 of (first window whose subrole is "AXStandardWindow")
  set out to "  popups=" & (count of pop up buttons of g) & " fields=" & (count of text fields of g) & " buttons=" & (count of buttons of g) & " statics=" & (count of static texts of g) & " dateAreas=" & (count of (every UI element of g whose role is "AXDateTimeArea"))
  repeat with i from 1 to (count of pop up buttons of g)
    set out to out & linefeed & "    popup " & i & " = " & (value of pop up button i of g)
  end repeat
  repeat with i from 1 to (count of static texts of g)
    set sv to "(none)"
    try
      set sv to (value of static text i of g) as text
    end try
    set out to out & linefeed & "    static " & i & " = " & sv
  end repeat
  return out
end tell' | tee -a "$REPORT"
esc; esc

# =====================================================================
cell "D2 weekly --weekdays monday,thursday at the LEGACY indices"
warm
U=$(mktodo RDLG2D-MW); note "  uuid=$U"
OUTP=$(G todo make-repeating "$U" --frequency weekly --interval 1 --weekdays monday,thursday --dangerously-drive-gui --json)
echo "$OUTP" > "$OUT/d2.log"; note "  $(echo "$OUTP" | tail -3)"
R=$(rsum RDLG2D-MW); note "  rule: $R"
verdict "D2 monday" "wd=1(Mon)" "$R"
verdict "D2 thursday" "wd=4(Thu)" "$R"

# =====================================================================
cell "D3 reschedule through the OLD Reschedule… menu spelling"
warm
T=$(gq "SELECT uuid FROM TMTask WHERE title='RDLG2D-MW' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
OUTP=$(G todo reschedule-repeat "$T" --frequency weekly --interval 2 --weekdays friday --dangerously-drive-gui --json)
echo "$OUTP" > "$OUT/d3.log"; note "  $(echo "$OUTP" | tail -3)"
R=$(rsum RDLG2D-MW); note "  rule after: $R"
verdict "D3 friday only (RRD1 converge on 3.22 too)" "of=[{wd=5(Fri)}]" "$R"

# =====================================================================
cell "D4 RRD1 GROW on 3.22 — {mon,wed} -> {tue,thu,sat}"
warm
U=$(mktodo RDLG2D-RRD1); note "  uuid=$U"
G todo make-repeating "$U" --frequency weekly --interval 1 --weekdays monday,wednesday --dangerously-drive-gui --json > "$OUT/d4-make.log" 2>&1
note "  rule before: $(rsum RDLG2D-RRD1)"
T=$(gq "SELECT uuid FROM TMTask WHERE title='RDLG2D-RRD1' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
warm
OUTP=$(G todo reschedule-repeat "$T" --frequency weekly --interval 1 --weekdays tuesday,thursday,saturday --dangerously-drive-gui --json)
echo "$OUTP" > "$OUT/d4.log"; note "  $(echo "$OUTP" | tail -3)"
R=$(rsum RDLG2D-RRD1); note "  rule after: $R"
if echo "$R" | grep -qE "wd=1\(Mon\)|wd=3\(Wed\)"; then
  note "  FAIL D4 stale weekday survived on 3.22"; FAIL=$((FAIL+1))
else
  note "  PASS D4 no stale weekday survived on 3.22"; PASS=$((PASS+1))
fi
verdict "D4 tuesday" "wd=2(Tue)" "$R"
verdict "D4 saturday" "wd=6(Sat)" "$R"

# =====================================================================
cell "D5 an OFF-RULE first occurrence still lands on 3.22 (the free date field)"
warm
U=$(mktodo RDLG2D-OFF); note "  uuid=$U"
OUTP=$(G todo make-repeating "$U" --frequency weekly --interval 1 --weekdays sunday --when 2026-07-22 --dangerously-drive-gui --json)
echo "$OUTP" > "$OUT/d5.log"; note "  $(echo "$OUTP" | tail -4)"
R=$(rsum RDLG2D-OFF); note "  rule: $R"
verdict "D5 off-rule first occurrence honored" "icStart=2026-07-22" "$R"

# =====================================================================
cell "D6 monthly + yearly anchors at the LEGACY indices"
warm
U=$(mktodo RDLG2D-MON)
OUTP=$(G todo make-repeating "$U" --frequency monthly --interval 1 --on-day 15 --dangerously-drive-gui --json)
echo "$OUTP" > "$OUT/d6a.log"
R=$(rsum RDLG2D-MON); note "  monthly rule: $R"
verdict "D6 monthly day 15" "dy=14" "$R"   # dy is 0-based in the blob
warm
U=$(mktodo RDLG2D-YR)
OUTP=$(G todo make-repeating "$U" --frequency yearly --interval 1 --yearly-month 10 --on-day 8 --dangerously-drive-gui --json)
echo "$OUTP" > "$OUT/d6b.log"
R=$(rsum RDLG2D-YR); note "  yearly rule: $R"
verdict "D6 yearly october" "mo=9" "$R"   # mo is 0-based in the blob
verdict "D6 yearly day 8" "dy=7" "$R"

note ""; note "###### RDLG2d (3.22 regression) SUMMARY: PASS=$PASS FAIL=$FAIL ######"
note "artifacts in $OUT"
