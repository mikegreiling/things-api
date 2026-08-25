#!/bin/bash
# CGRD1 — the Repeat dialog's PRE-COMMIT full-dialog audit, certified against a
# golden-v4 clone (Things 3.23 / build 32300036 / dbv 27).
#
# What is under test: the drive no longer presses OK on the strength of each
# step's own read-back. Before the commit it re-reads EVERY control it set in
# this session — through the control's own discriminated address — and compares
# against the intended values; any mismatch aborts fail-closed BEFORE the OK,
# naming each mismatched control (intended vs observed), and runs the existing
# clean-abort path. Two cells:
#
#   (a) CLEAN — a real reschedule drive through the production CLI passes the
#       audit and lands, asserted against the guest database.
#   (b) POISONED — the SHIPPED audit script text, emitted out of dist/ with one
#       intended value deliberately wrong, run against the same live dialog:
#       it must refuse, naming the control, and the database must not move.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, clock pinned 2026-07-05 and NEVER rolled (the trial wall
# is 2026-07-18). Fixtures fully synthetic. The clone is destroyed on teardown.
#
# Fixtures are built the REPX2/REPX3 way — a URL-scheme add plus a direct AX
# Repeat-dialog drive — because `make-repeating` carries an AppleScript leg and
# the Wave A write gate returns `direct-unknown` for every sshd-descended shell
# (CNC1 §9). `reschedule-repeat` itself is pure-ui, so it IS reachable with the
# THINGS_API_UI_DIRECT escape.
#
# Phases (the clone survives between them; SESSION carries the IP):
#   setup     clone + boot + airgap + clock pin + warm-up + guest helpers
#   ship      build dist + push node/dist/commander + ui-enabled
#   cert      cells (a) and (b)
#   teardown  stop + delete the clone
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-cgrd1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — a Sunday, well inside the trial wall
note() { echo "[cgrd1] $*" | tee -a "$REPORT"; }

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
esc() { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\'' >/dev/null 2>&1; sleep 1; true' </dev/null; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }
show() { lab_ssh "$IP" "open -g $(printf '%q' "$1"); sleep 3" </dev/null; }

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
  note "preflight: free ${FREEGB}GB"
  [ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free"; exit 1; }

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

  lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
  lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<<"$GSQL"

  note "warm-up launch/quit/relaunch"
  lab_ssh "$IP" 'open -g -a Things3; sleep 14; osascript -e "tell application \"Things3\" to quit"; sleep 4; open -g -a Things3; sleep 12' </dev/null

  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  echo "IP=$IP" > "$SESSION"; echo "TOKEN=$TOKEN" >> "$SESSION"
  note "auth token in hand (${#TOKEN} chars)"

  TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
  TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
  note "env: Things $TVER ($TBLD) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / golden $GOLDEN"

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
    print("tp=%s fu=%s fa=%s ts=%s rc=%s ed=%s of=[%s] next=%s icStart=%s icCount=%s dl=%s"%(
        d.get('tp'),d.get('fu'),d.get('fa'),d.get('ts'),d.get('rc'),d.get('ed'),",".join(offs),
        dpk(row[2]),dpk(row[3]),row[4],dpk(row[5])))
EOF

  lab_ssh "$IP" 'cat > ~/labh/tjson.sh && chmod +x ~/labh/tjson.sh' <<'EOF'
#!/bin/bash
URL=$(python3 -c 'import sys,urllib.parse; print("things:///json?auth-token="+sys.argv[1]+"&data="+urllib.parse.quote(sys.argv[2],safe=""))' "$1" "$2")
open -g "$URL"
EOF
  note "setup complete — run: bash lab/scripts/research-cgrd1.sh ship"
  exit 0
fi

# ===================================================================== ship
if [ "$CMD" = "ship" ]; then
  load_session
  if [ "${SKIP_BUILD:-0}" = "1" ]; then note "SKIP_BUILD=1 — reusing dist/"; else
    note "building dist"
    npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
  fi
  [ -f dist/cli/main.js ] || { note "FATAL: no dist/cli/main.js"; exit 1; }
  [ -d node_modules/commander ] || { note "FATAL: node_modules/commander missing — run npm ci"; exit 1; }

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
  CLIV=$(lab_ssh "$IP" "$CLI --version 2>&1 | tail -1" </dev/null)
  case "$CLIV" in
    [0-9]*) note "guest CLI OK: things $CLIV" ;;
    *) note "FATAL: the guest CLI does not run — $CLIV"; exit 1 ;;
  esac
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
  note "shipped dist; ui-enabled=true"
  exit 0
fi

# =================================================================== census
#
# §A. The cadence group's LABEL inventory in every mode the interval field is
# reachable in. The hardened interval discriminator prefers a POSITIVE match on
# the "Every" label's row (over HXPC1's negative "not on the Ends: row" rule),
# so whether the after-completion group carries that label — and whether its
# interval field shares its row — decides whether the positive rule is safe.
if [ "$CMD" = "census" ]; then
  load_session
  SHEET='sheet 1 of (first window whose subrole is "AXStandardWindow")'
  DUMP="tell application \"System Events\" to tell process \"Things3\"
  set g to group 1 of $SHEET
  set out to \"statics:\"
  repeat with i from 1 to (count of static texts of g)
    set sv to \"\"
    try
      set sv to (value of static text i of g) as text
    end try
    set p to position of static text i of g
    set out to out & \" [\" & sv & \"]@y\" & (item 2 of p)
  end repeat
  set out to out & \" | fields:\"
  repeat with i from 1 to (count of text fields of g)
    set p to position of text field i of g
    set out to out & \" #\" & i & \"=[\" & ((value of text field i of g) as text) & \"]@y\" & (item 2 of p)
  end repeat
  set out to out & \" | popups=\" & (count of pop up buttons of g)
  return out
end tell"
  pick_freq() { axq "tell application \"System Events\" to tell process \"Things3\"
  set p to pop up button 1 of $SHEET
  repeat 20 times
    if (exists menu 1 of p) then exit repeat
    click p
    delay 0.3
  end repeat
  click menu item \"$1\" of menu 1 of p
  delay 1.5
  return \"freq=$1\"
end tell" >/dev/null; }

  warm
  CTITLE="CGRD1-CENSUS-$(date +%H%M%S)"
  lab_ssh "$IP" "open -g 'things:///add?title=$CTITLE&auth-token=$TOKEN'; sleep 4" </dev/null
  UC=$(gq "SELECT uuid FROM TMTask WHERE title='$CTITLE' AND trashed=0 LIMIT 1")
  show "things:///show?id=$UC"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
  lab_ssh "$IP" 'sleep 3' </dev/null

  for MODE in daily weekly monthly yearly "after completion"; do
    pick_freq "$MODE"
    note "  [$MODE] $(axq "$DUMP")"
  done

  note "  -- with an Ends: after bound (fixed daily) --"
  pick_freq daily
  axq "tell application \"System Events\" to tell process \"Things3\"
  set p to pop up button 1 of group 1 of $SHEET
  repeat 20 times
    if (exists menu 1 of p) then exit repeat
    click p
    delay 0.3
  end repeat
  click menu item \"after\" of menu 1 of p
  delay 1.5
end tell" >/dev/null
  note "  [daily + ends-after] $(axq "$DUMP")"
  esc
  exit 0
fi

# ===================================================================== cert
if [ "$CMD" = "cert" ]; then
  load_session
  PASS=0; FAIL=0
  CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
  GU() { lab_ssh "$IP" "$LAB_UI_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
  verdict() { if echo "$3" | grep -qF "$2"; then note "  PASS $1"; PASS=$((PASS+1)); else note "  FAIL $1 — expected to contain '$2', got: $3"; FAIL=$((FAIL+1)); fi; }
  refute() { if echo "$3" | grep -qF "$2"; then note "  FAIL $1 — must NOT contain '$2', got: $3"; FAIL=$((FAIL+1)); else note "  PASS $1"; PASS=$((PASS+1)); fi; }
  SHEET='sheet 1 of (first window whose subrole is "AXStandardWindow")'

  # A repeating fixture, REPX2-style: URL add, then a direct AX Repeat-dialog
  # drive (make-repeating is AppleScript-gated in a clone). The TEMPLATE uuid is
  # looked up by title AFTERWARDS (the CNC1 `tmpl` rule): committing the dialog
  # mints a template and an instance, and the seed row is not necessarily the one
  # carrying the rule — assuming it was is a rig failure that reads like a finding.
  seed_template() { # seed_template <title> <frequency-menu-item> <interval>
    lab_ssh "$IP" "open -g 'things:///add?title=$1&auth-token=$TOKEN'; sleep 4" </dev/null
    local u; u=$(gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NULL LIMIT 1")
    show "things:///show?id=$u"
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
    axq 'tell application "System Events" to tell process "Things3" to click menu item "Repeat…" of menu "Items" of menu bar 1' >/dev/null
    lab_ssh "$IP" 'sleep 3' </dev/null
    axq "tell application \"System Events\" to tell process \"Things3\"
  set sh to $SHEET
  set p to pop up button 1 of sh
  repeat 20 times
    if (exists menu 1 of p) then exit repeat
    click p
    delay 0.3
  end repeat
  click menu item \"$2\" of menu 1 of p
  delay 1.5
  set g to group 1 of sh
  set tf to text field 1 of g
  set focused of tf to true
  delay 0.2
  keystroke \"$3\"
  delay 0.1
  key code 48
  delay 0.4
  click button \"OK\" of sh
  delay 2
  return \"seeded\"
end tell" >/dev/null
    lab_ssh "$IP" 'sleep 7' </dev/null
    gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NOT NULL LIMIT 1"
  }

  note ""
  note "############### CELL (a) — a clean reschedule passes the audit and lands ###############"
  warm
  ATITLE="CGRD1-CLEAN-$(date +%H%M%S)"
  UA=$(seed_template "$ATITLE" weekly 1)
  [ -n "$UA" ] || { note "FATAL: the cell (a) template did not mint — rig failure, not a finding"; exit 1; }
  note "  template=$UA  seeded rule: $(lab_ssh "$IP" "python3 ~/labh/rsum.py $ATITLE" </dev/null 2>&1)"

  R=$(GU "todo reschedule-repeat $UA --frequency daily --interval 3 --ends-after 4 --dangerously-drive-gui --json")
  echo "$R" | sed 's/^/    /' | tee -a "$REPORT" >/dev/null
  note "  reschedule result: $(echo "$R" | tail -3 | tr '\n' ' ')"
  verdict "a1: the drive exited 0" "EXIT=0" "$R"
  verdict "a2: the pre-commit audit step ran" "audit the Repeat dialog" "$R"
  RULE=$(lab_ssh "$IP" "python3 ~/labh/rsum.py $ATITLE" </dev/null 2>&1)
  note "  rule after: $RULE"
  verdict "a3: interval 3 landed" "fa=3" "$RULE"
  verdict "a4: daily landed" "fu=16" "$RULE"
  verdict "a5: ends-after 4 landed" "rc=4" "$RULE"

  note ""
  note "############### CELL (b) — a poisoned intended value aborts pre-commit ###############"
  warm
  BTITLE="CGRD1-POISON-$(date +%H%M%S)"
  UB=$(seed_template "$BTITLE" weekly 1)
  [ -n "$UB" ] || { note "FATAL: the cell (b) template did not mint — rig failure, not a finding"; exit 1; }
  BEFORE=$(lab_ssh "$IP" "python3 ~/labh/rsum.py $BTITLE" </dev/null 2>&1)
  note "  template=$UB  rule before: $BEFORE"

  # Open the SAME dialog the drive would, drive it to a known state, then run
  # the SHIPPED audit script text with one intended value deliberately wrong.
  show "things:///show?id=$UB"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null
  axq 'tell application "System Events" to tell process "Things3" to click menu item "Edit Rule…" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1' >/dev/null
  lab_ssh "$IP" 'sleep 3' </dev/null
  axq "tell application \"System Events\" to tell process \"Things3\"
  set sh to $SHEET
  set p to pop up button 1 of sh
  repeat 20 times
    if (exists menu 1 of p) then exit repeat
    click p
    delay 0.3
  end repeat
  click menu item \"daily\" of menu 1 of p
  delay 1.5
  set g to group 1 of sh
  set tf to text field 1 of g
  set focused of tf to true
  delay 0.2
  keystroke \"3\"
  delay 0.1
  key code 48
  delay 0.4
  return \"dialog at daily/3\"
end tell" | sed 's/^/    /' | tee -a "$REPORT"

  # The HONEST audit (intended daily/3) must PASS against that dialog …
  node -e "import('./dist/write/vectors/ui.js').then(m=>process.stdout.write(m.axAuditDialogScript(JSON.parse(process.argv[1]))))" \
    '{"shell":"sheet 1 of (first window whose subrole is \"AXStandardWindow\")","group":"group 1 of sheet 1 of (first window whose subrole is \"AXStandardWindow\")","controls":[{"label":"frequency","kind":"popup","path":"pop up button 1 of sheet 1 of (first window whose subrole is \"AXStandardWindow\")","expected":["daily"]},{"label":"interval","kind":"group-number","numberTarget":"interval","expected":["3"]}]}' \
    > "$OUT/audit-honest.applescript"
  lab_ssh "$IP" 'cat > ~/labh/audit-honest.applescript' < "$OUT/audit-honest.applescript"
  RH=$(lab_ssh "$IP" 'osascript ~/labh/audit-honest.applescript' </dev/null 2>&1)
  note "  honest audit: $RH"
  verdict "b1: the honest audit passes on the driven dialog" "OK" "$RH"

  # … and the POISONED audit (intended interval 9, which was never typed) must
  # refuse, naming the control and both values.
  node -e "import('./dist/write/vectors/ui.js').then(m=>process.stdout.write(m.axAuditDialogScript(JSON.parse(process.argv[1]))))" \
    '{"shell":"sheet 1 of (first window whose subrole is \"AXStandardWindow\")","group":"group 1 of sheet 1 of (first window whose subrole is \"AXStandardWindow\")","controls":[{"label":"frequency","kind":"popup","path":"pop up button 1 of sheet 1 of (first window whose subrole is \"AXStandardWindow\")","expected":["daily"]},{"label":"interval","kind":"group-number","numberTarget":"interval","expected":["9"]}]}' \
    > "$OUT/audit-poisoned.applescript"
  lab_ssh "$IP" 'cat > ~/labh/audit-poisoned.applescript' < "$OUT/audit-poisoned.applescript"
  RP=$(lab_ssh "$IP" 'osascript ~/labh/audit-poisoned.applescript' </dev/null 2>&1)
  note "  poisoned audit: $RP"
  # The assertions name the audit's OWN sentence, not loose substrings: an
  # osascript stack trace contains bare digits, and a cell that passes on those
  # would report green for a dialog that never opened.
  verdict "b2: the poisoned audit refuses with the audit's own sentence" \
    "does not hold what this drive entered" "$RP"
  verdict "b3: it names the mismatched control and both values" \
    'interval (intended "9", dialog shows "3")' "$RP"
  refute "b4: the frequency, which DID hold, is not reported" "frequency (intended" "$RP"
  refute "b5: it did not report OK" "OK" "$RP"

  esc
  lab_ssh "$IP" 'sleep 3' </dev/null
  AFTER=$(lab_ssh "$IP" "python3 ~/labh/rsum.py $BTITLE" </dev/null 2>&1)
  note "  rule after the aborted drive: $AFTER"
  if [ "$BEFORE" = "$AFTER" ]; then note "  PASS b6: ZERO database delta"; PASS=$((PASS+1));
  else note "  FAIL b6: the rule moved — before[$BEFORE] after[$AFTER]"; FAIL=$((FAIL+1)); fi

  note ""
  note "############### CELL (c) — the converted start-offset address drives ###############"
  # The one address guard 1 CONVERTED rather than justified: the start-days-earlier
  # field moved from `text field 1` of the dialog shell to the field sharing the
  # "days earlier" label's row. It only exists once "Add deadlines" is ticked, so a
  # deadlined reschedule is the cell that proves the new address reaches it.
  warm
  CTITLE="CGRD1-OFFSET-$(date +%H%M%S)"
  UC=$(seed_template "$CTITLE" weekly 1)
  [ -n "$UC" ] || { note "FATAL: the cell (c) template did not mint — rig failure, not a finding"; exit 1; }
  note "  template=$UC  rule before: $(lab_ssh "$IP" "python3 ~/labh/rsum.py $CTITLE" </dev/null 2>&1)"

  R=$(GU "todo reschedule-repeat $UC --frequency weekly --interval 1 --deadline --start-days-earlier 2 --dangerously-drive-gui --json")
  echo "$R" | sed 's/^/    /' | tee -a "$REPORT" >/dev/null
  note "  reschedule result: $(echo "$R" | tail -3 | tr '\n' ' ')"
  verdict "c1: the deadlined drive exited 0" "EXIT=0" "$R"
  verdict "c2: the offset field was driven through its label row" "start 2 days earlier" "$R"
  verdict "c3: the pre-commit audit step ran" "audit the Repeat dialog" "$R"
  RULEC=$(lab_ssh "$IP" "python3 ~/labh/rsum.py $CTITLE" </dev/null 2>&1)
  note "  rule after: $RULEC"
  verdict "c4: the start offset landed in the rule (ts = -2)" "ts=-2" "$RULEC"
  refute "c5: the template is deadlined (its deadline column is set)" "dl=None" "$RULEC"

  note ""; note "###### CGRD1 SUMMARY: PASS=$PASS FAIL=$FAIL ######"
  [ "$FAIL" -eq 0 ] || exit 1
  exit 0
fi

# ================================================================= teardown
if [ "$CMD" = "teardown" ]; then
  tart stop "$VM" >/dev/null 2>&1 || true
  sleep 2
  tart delete "$VM" >/dev/null 2>&1 || true
  rm -f "$SESSION"
  note "clone $VM stopped and deleted"
  exit 0
fi

echo "usage: $0 {setup|ship|cert|teardown}" >&2
exit 2
