#!/bin/bash
# CHORDMH1 — build + certify `project.move-heading` on the ⌘-arrow chord vector.
#
# BACKGROUND. HEADORD1 (docs/lab/headord1-heading-order.md) measured the law:
# with a heading row selected, ⌘↑/⌘↓ move it ±1 slot and ⌘⌥↑/⌘⌥↓ move it to the
# top/bottom of the project's heading list. The write is a SINGLE-ROW `index`
# rewrite — no sibling is renumbered, children follow through their intact
# heading FK — and a chord with nowhere to go is declined with zero delta and
# one alert beep. The maintainer endorsed shipping heading order on this vector
# (2026-08-25). This campaign is the BUILD's certification, not a probe.
#
# CELLS:
#   gate   THE DELIVERY GATE, run FIRST and alone. Measures the FULL backgrounded
#          gesture — `open -g` reveal (Things never activated), the shipped
#          `select-heading-row` primitive, and a CGEventPostToPid chord — with
#          the frontmost app asserted to stay Finder throughout. Its verdict
#          decides whether the shipped op delivers backgrounded or foregrounded.
#   cert   the shipped op through the production CLI: 3-heading permutations
#          (±1 up, ±1 down, multi-hop, to-top, to-bottom), children integrity on
#          every arm, the already-in-position no-op, the untouched-siblings law,
#          and the boundary refusal with zero mutation.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, clock pinned 2026-07-05 and NEVER rolled (the trial wall is
# 2026-07-18 — docs/lab/harness.md). Fixtures fully synthetic. Destroyed on
# teardown. Beep sentinel per cell with THINGS_LAB_BEEPS_OK=1 (accounting, never
# a mute); every cell reports its count.
#
# Phases (the clone survives between them; SESSION carries the IP):
#   setup     clone + boot + airgap + clock pin + ship the CLI + AX kit
#   gate      the delivery gate (run before anything is built on its verdict)
#   ship      re-push dist/ after a rebuild (cert runs the SHIPPED code)
#   cert      the certification cells
#   teardown  stop + delete the clone
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-chordmh1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — well inside the trial wall (2026-07-18)
note() { echo "[chordmh1] $*" | tee -a "$REPORT"; }

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" "$@"; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
axq() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -g -a Things3; sleep 14; true' </dev/null; }
show() { lab_ssh "$IP" "open -g $(printf '%q' "$1"); sleep 3" </dev/null; }
front() { axq 'tell application "System Events" to return name of first process whose frontmost is true'; }
finder() { lab_ssh "$IP" 'osascript -e '\''tell application "Finder" to activate'\''; sleep 2' </dev/null; }

bs()    { lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/things-lab/run/beep-sentinel.sh $*" </dev/null 2>&1; }
bmark() { lab_ssh "$IP" "~/things-lab/run/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }

horder() { gq "SELECT COALESCE(group_concat(t,' < '),'(none)') FROM (SELECT title AS t FROM TMTask WHERE project='$1' AND type=2 AND trashed=0 ORDER BY \"index\" ASC)"; }
hidx()   { gt "SELECT title, substr(uuid,1,8) AS uuid8, \"index\" AS idx FROM TMTask WHERE project='$1' AND type=2 AND trashed=0 ORDER BY \"index\" ASC"; }
# every child of every heading of the project: heading FK + index — the integrity oracle
kidmap() { gq "SELECT COALESCE(group_concat(r,' | '),'(none)') FROM (SELECT (c.title||'->'||substr(c.heading,1,8)||'@'||c.\"index\") AS r FROM TMTask c JOIN TMTask h ON c.heading=h.uuid WHERE h.project='$1' AND c.trashed=0 ORDER BY c.title)"; }
# every heading's index, as a stable string — the untouched-siblings oracle
idxmap() { gq "SELECT COALESCE(group_concat(r,' | '),'(none)') FROM (SELECT (title||'='||\"index\") AS r FROM TMTask WHERE project='$1' AND type=2 AND trashed=0 ORDER BY title)"; }

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
  IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: no SSH"; exit 1; }
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

  note "warm-up launch/quit/relaunch (background only — the app is never activated)"
  lab_ssh "$IP" 'open -g -a Things3; sleep 14; osascript -e "tell application \"Things3\" to quit"; sleep 4; open -g -a Things3; sleep 12' </dev/null

  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  echo "IP=$IP" > "$SESSION"; echo "TOKEN=$TOKEN" >> "$SESSION"
  note "auth token in hand (${#TOKEN} chars)"

  TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
  TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
  note "env: Things $TVER ($TBLD) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / golden $GOLDEN"

  lab_ssh "$IP" 'cat > ~/labh/tjson.sh && chmod +x ~/labh/tjson.sh' <<'EOF'
#!/bin/bash
URL=$(python3 -c 'import sys,urllib.parse; print("things:///json?auth-token="+sys.argv[1]+"&data="+urllib.parse.quote(sys.argv[2],safe=""))' "$1" "$2")
open -g "$URL"
EOF

  # the pid-targeted modifier-key poster (HEADORD1 cell 1h2a), for the gate cell
  lab_ssh "$IP" 'cat > ~/labh/keypid.js' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId() }
function sleepMs(ms){ $.NSThread.sleepForTimeInterval(ms/1000) }
function run(argv){
  var pid=pidOf('Things3'), code=+argv[0], flags=+argv[1];
  var d=$.CGEventCreateKeyboardEvent($(),code,true), u=$.CGEventCreateKeyboardEvent($(),code,false);
  $.CGEventSetFlags(d,flags); $.CGEventSetFlags(u,flags);
  $.CGEventPostToPid(pid,d); sleepMs(70); $.CGEventPostToPid(pid,u); sleepMs(70);
  return 'POSTED-TO-PID '+pid+' code='+code+' flags='+flags }
EOF

  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
  note "shipped dist; ui-enabled=true"

  note "setup DONE — session in $SESSION"
  exit 0
fi

CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
G()   { lab_ssh "$IP" "$LAB_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
# UI escape ONLY — for the arms that must see the ui vector's own gating.
GU()  { lab_ssh "$IP" "$LAB_UI_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
tj()  { lab_ssh "$IP" "~/labh/tjson.sh $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null; sleep 4; }

# seed_project <title> <headingTitle…> — each heading gets 2 synthetic children
seed_project() {
  local title="$1"; shift
  local items="" h c
  for h in "$@"; do
    items="$items{\"type\":\"heading\",\"attributes\":{\"title\":\"$h\"}},"
    for c in 1 2; do items="$items{\"type\":\"to-do\",\"attributes\":{\"title\":\"$h-c$c\"}},"; done
  done
  items="${items%,}"
  tj "[{\"type\":\"project\",\"attributes\":{\"title\":\"$title\",\"items\":[$items]}}]"
}
pid_()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND trashed=0 LIMIT 1"; }
hid_()  { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=2 AND trashed=0 LIMIT 1"; }

# ================================================================= cell: gate
# THE DELIVERY GATE. Measures the complete backgrounded gesture end to end and
# asserts no focus steal at every stage. Its verdict decides the shipped shape.
if [ "$CMD" = "gate" ]; then
  load_session
  bs reset >/dev/null; bmark "gate setup"
  note ""
  note "############### DELIVERY GATE — is the whole gesture backgroundable? ###############"
  note "HEADORD1 1h2a landed a CGEventPostToPid chord with Finder frontmost, but it had"
  note "ACTIVATED Things first and only then backgrounded it. This cell never activates"
  note "Things at all: open -g reveal, AX row select, pid-posted chord, Finder frontmost"
  note "the whole way, with the frontmost app read back at every stage."
  STAMP=$(date +%H%M%S)
  TABLE='table 1 of scroll area 1 of (first window whose subrole is "AXStandardWindow")'

  seed_project "CMH-GATE-$STAMP" "G1-$STAMP" "G2-$STAMP" "G3-$STAMP" "G4-$STAMP" "G5-$STAMP"
  PG=$(pid_ "CMH-GATE-$STAMP")
  note "  project=$PG"
  note "  START: $(horder "$PG")"

  for o in 0 1 2 3 4; do
    node -e "import('./dist/write/vectors/ui.js').then(m=>process.stdout.write(m.axSelectHeadingRowScript(process.argv[1], $o)))" "$TABLE" > "$OUT/sel-h$o.applescript"
    lab_ssh "$IP" "cat > ~/labh/sel-h$o.applescript" < "$OUT/sel-h$o.applescript"
  done
  selh() { lab_ssh "$IP" "osascript ~/labh/sel-h$1.applescript" </dev/null 2>&1; }

  warm
  finder
  note ""
  note "  --- stage 0: baseline frontmost (Things launched with open -g, never activated) ---"
  note "      frontmost = [$(front)]"

  note ""
  note "  --- stage 1: reveal the project with open -g ---"
  bmark "gate reveal"
  show "things:///show?id=$PG"
  F1=$(front); note "      frontmost after reveal = [$F1]"

  note ""
  note "  --- stage 2: select the 3rd heading with the SHIPPED select-heading-row ---"
  bmark "gate select"
  S=$(selh 2); note "      select-heading-row said: [$S]"
  F2=$(front); note "      frontmost after select   = [$F2]"

  note ""
  note "  --- stage 3: ONE CGEventPostToPid ⌘↑ chord (flags 1048576 = command) ---"
  bmark "gate chord postToPid"
  B=$(horder "$PG")
  R=$(lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/keypid.js 126 1048576" </dev/null 2>&1)
  note "      poster said: [$R]"
  lab_ssh "$IP" 'sleep 2' </dev/null
  A=$(horder "$PG")
  F3=$(front); note "      frontmost after chord    = [$F3]"
  note "      before: $B"
  note "      after : $A"

  note ""
  note "  --- stage 4: a SECOND chord on the same selection (does selection persist?) ---"
  bmark "gate chord 2"
  B2="$A"
  lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/keypid.js 126 1048576" </dev/null >/dev/null 2>&1
  lab_ssh "$IP" 'sleep 2' </dev/null
  A2=$(horder "$PG")
  note "      before: $B2"
  note "      after : $A2"

  note ""
  note "  --- stage 5: ⌘⌥↓ to-bottom (flags 1572864 = command+option) ---"
  bmark "gate chord optdown"
  B3="$A2"
  lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/keypid.js 125 1572864" </dev/null >/dev/null 2>&1
  lab_ssh "$IP" 'sleep 2' </dev/null
  A3=$(horder "$PG")
  note "      before: $B3"
  note "      after : $A3"
  note "      frontmost at end = [$(front)]"

  note ""
  note "  --- verdict ---"
  if [ "$A" != "$B" ] && [ "$F1" = "Finder" ] && [ "$F2" = "Finder" ] && [ "$F3" = "Finder" ]; then
    note "  *** BACKGROUND DELIVERY CONFIRMED — the whole gesture ran with Finder frontmost ***"
  else
    note "  *** BACKGROUND DELIVERY NOT CONFIRMED — delta=[$B -> $A] frontmost=[$F1/$F2/$F3] ***"
  fi
  note ""
  bs assert --allow 99 | sed 's/^/  /' | tee -a "$REPORT"
  exit 0
fi

# ================================================================= cell: ship
if [ "$CMD" = "ship" ]; then
  load_session
  note "rebuilding + re-pushing dist"
  npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  note "dist re-shipped"
  exit 0
fi

# ================================================================= cell: cert
# The SHIPPED op, through the production CLI, on fresh 3-heading fixtures.
if [ "$CMD" = "cert" ]; then
  load_session
  bs reset >/dev/null; bmark "cert setup"
  note ""
  note "############### CERTIFICATION — the shipped op through the production CLI ###############"
  STAMP=$(date +%H%M%S)
  : > "$OUT/drives.log"

  # arm <n> <label> <cliargs…>  — seed a fresh A/B/C project, drive, assert
  arm() {
    local n="$1" label="$2"; shift 2
    local P B KB IB A KA IA t0 t1 outp
    seed_project "CMH-$n-$STAMP" "A$n-$STAMP" "B$n-$STAMP" "C$n-$STAMP"
    P=$(pid_ "CMH-$n-$STAMP")
    B=$(horder "$P"); KB=$(kidmap "$P"); IB=$(idxmap "$P")
    note ""
    note "  --- arm $n: $label ---"
    note "      project=$P"
    note "      before order   : $B"
    bmark "cert arm$n"
    t0=$(date +%s)
    outp=$(G "$@")
    t1=$(date +%s)
    { echo "### arm $n — $label"; echo "$outp"; } >> "$OUT/drives.log"
    A=$(horder "$P"); KA=$(kidmap "$P"); IA=$(idxmap "$P")
    note "      after order    : $A"
    note "      exit           : $(echo "$outp" | grep -o 'EXIT=[0-9]*')"
    if [ "$KA" = "$KB" ]; then note "      children       : INTACT (FK + index byte-identical, 6 rows)"
    else note "      children       : *** CHANGED ***"; note "        before: $KB"; note "        after : $KA"; fi
    echo "$IB" > "$OUT/arm$n-idx-before.txt"; echo "$IA" > "$OUT/arm$n-idx-after.txt"
    note "      heading idx    : before[$IB]"
    note "                       after [$IA]"
    ARM_PROJECT="$P"; ARM_BEFORE="$B"; ARM_AFTER="$A"; ARM_OUT="$outp"
  }

  # ---- arm 1: ±1 up — move C before B (C is last, target = middle)
  arm 1 "±1 up: move C before B" project move-heading "CMH-1-$STAMP" "C1-$STAMP" --before-heading "B1-$STAMP" --dangerously-drive-gui --json
  # ---- arm 2: ±1 down — move A after B
  arm 2 "±1 down: move A after B" project move-heading "CMH-2-$STAMP" "A2-$STAMP" --after-heading "B2-$STAMP" --dangerously-drive-gui --json
  # ---- arm 3: to-top in one dispatch — move C first (2 slots)
  arm 3 "to-top: move C first" project move-heading "CMH-3-$STAMP" "C3-$STAMP" --first --dangerously-drive-gui --json
  # ---- arm 4: to-bottom in one dispatch — move A last (2 slots)
  arm 4 "to-bottom: move A last" project move-heading "CMH-4-$STAMP" "A4-$STAMP" --last --dangerously-drive-gui --json
  # ---- arm 5: already in position — a pure no-op, zero chords, zero beeps
  arm 5 "already in position: move A first (already first)" project move-heading "CMH-5-$STAMP" "A5-$STAMP" --first --dangerously-drive-gui --json
  # ---- arm 6: a BLOCK move — C and A as an ordered pair, before B
  arm 6 "block: move C,A before B" project move-heading "CMH-6-$STAMP" "C6-$STAMP" "A6-$STAMP" --before-heading "B6-$STAMP" --dangerously-drive-gui --json

  # ---- arm 7: the DRY RUN — nothing may move
  seed_project "CMH-7-$STAMP" "A7-$STAMP" "B7-$STAMP" "C7-$STAMP"
  P7=$(pid_ "CMH-7-$STAMP"); B7=$(horder "$P7")
  note ""
  note "  --- arm 7: dry run must not move anything ---"
  bmark "cert arm7 dryrun"
  O7=$(G project move-heading "CMH-7-$STAMP" "C7-$STAMP" --first --dangerously-drive-gui --dry-run --json)
  { echo "### arm 7 — dry run"; echo "$O7"; } >> "$OUT/drives.log"
  A7=$(horder "$P7")
  note "      before: $B7"
  note "      after : $A7"
  [ "$A7" = "$B7" ] && note "      ZERO MUTATION — correct" || note "      *** THE DRY RUN MOVED SOMETHING ***"

  # ---- arm 8: the GATE — no --dangerously-drive-gui must refuse with zero mutation
  seed_project "CMH-8-$STAMP" "A8-$STAMP" "B8-$STAMP" "C8-$STAMP"
  P8=$(pid_ "CMH-8-$STAMP"); B8=$(horder "$P8")
  note ""
  note "  --- arm 8: the two-key gate — no --dangerously-drive-gui ---"
  bmark "cert arm8 gate"
  O8=$(G project move-heading "CMH-8-$STAMP" "C8-$STAMP" --first --json)
  { echo "### arm 8 — ungated"; echo "$O8"; } >> "$OUT/drives.log"
  A8=$(horder "$P8")
  note "      exit  : $(echo "$O8" | grep -o 'EXIT=[0-9]*')"
  note "      after : $A8"
  [ "$A8" = "$B8" ] && note "      ZERO MUTATION — correct" || note "      *** THE UNGATED CALL MOVED SOMETHING ***"

  # ---- arm 9: an ARCHIVED heading anywhere in the project must refuse
  seed_project "CMH-9-$STAMP" "A9-$STAMP" "B9-$STAMP" "C9-$STAMP"
  P9=$(pid_ "CMH-9-$STAMP")
  note ""
  note "  --- arm 9: an archived heading fences the whole project ---"
  H9B=$(hid_ "B9-$STAMP")
  O9A=$(G project archive-heading "CMH-9-$STAMP" "B9-$STAMP" --children complete --json)
  { echo "### arm 9 — archive leg"; echo "$O9A"; } >> "$OUT/drives.log"
  note "      archive B9: $(echo "$O9A" | grep -o 'EXIT=[0-9]*') (heading=$H9B)"
  B9=$(horder "$P9")
  bmark "cert arm9 archived"
  O9=$(G project move-heading "CMH-9-$STAMP" "C9-$STAMP" --first --dangerously-drive-gui --json)
  { echo "### arm 9 — move with an archived sibling"; echo "$O9" | head -40; } >> "$OUT/drives.log"
  A9=$(horder "$P9")
  note "      exit  : $(echo "$O9" | grep -o 'EXIT=[0-9]*')"
  note "      says  : $(echo "$O9" | tr '\n' ' ' | grep -o 'completed/canceled heading[^\"]*' | cut -c1-160)"
  note "      before: $B9"
  note "      after : $A9"
  [ "$A9" = "$B9" ] && note "      ZERO MUTATION — correct" || note "      *** THE REFUSED CALL MOVED SOMETHING ***"

  note ""
  note "  --- beep sentinel (every normal-path arm should be silent) ---"
  bs assert --allow 99 | sed 's/^/  /' | tee -a "$REPORT"
  note ""
  note "cert DONE — full CLI output in $OUT/drives.log"
  exit 0
fi

# ============================================================= cell: boundary
# The DELIBERATE boundary probe: a raw chord with nowhere to go. The shipped op
# must never provoke this (it computes its hop count from the DB), so this cell
# fires the chord by hand to confirm the decline is still zero-delta + one beep,
# and that the driver's progress guard would see it.
if [ "$CMD" = "boundary" ]; then
  load_session
  bs reset >/dev/null; bmark "boundary setup"
  note ""
  note "############### BOUNDARY — the declined chord (deliberate, expect beeps) ###############"
  STAMP=$(date +%H%M%S)
  TABLE='table 1 of scroll area 1 of (first window whose subrole is "AXStandardWindow")'
  seed_project "CMH-BND-$STAMP" "N1-$STAMP" "N2-$STAMP" "N3-$STAMP"
  PB=$(pid_ "CMH-BND-$STAMP")
  node -e "import('./dist/write/vectors/ui.js').then(m=>process.stdout.write(m.axSelectHeadingRowScript(process.argv[1], 0)))" "$TABLE" > "$OUT/sel-b0.applescript"
  lab_ssh "$IP" "cat > ~/labh/sel-b0.applescript" < "$OUT/sel-b0.applescript"
  warm; finder
  show "things:///show?id=$PB"
  note "  project=$PB"
  note "  START: $(horder "$PB")"
  note "  select the FIRST heading: $(lab_ssh "$IP" 'osascript ~/labh/sel-b0.applescript' </dev/null 2>&1)"
  bmark "boundary cmd-up at top"
  B=$(horder "$PB"); KB=$(kidmap "$PB"); IB=$(idxmap "$PB")
  lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/keypid.js 126 1048576" </dev/null >/dev/null 2>&1
  lab_ssh "$IP" 'sleep 2' </dev/null
  A=$(horder "$PB"); KA=$(kidmap "$PB"); IA=$(idxmap "$PB")
  note "  after ⌘↑ on the TOP heading:"
  note "    order   : $B  ==>  $A"
  note "    indexes : $([ "$IA" = "$IB" ] && echo "UNCHANGED" || echo "*** CHANGED *** $IB -> $IA")"
  note "    children: $([ "$KA" = "$KB" ] && echo "UNCHANGED" || echo "*** CHANGED ***")"
  note ""
  bs assert --allow 99 | sed 's/^/  /' | tee -a "$REPORT"
  exit 0
fi

# ==================================================================== teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: stop + delete $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  rm -f "$SESSION"
  note "teardown DONE"
  exit 0
fi

echo "usage: $0 setup|gate|ship|cert|boundary|teardown" >&2
exit 1
