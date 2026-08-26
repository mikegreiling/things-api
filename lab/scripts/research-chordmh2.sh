#!/bin/bash
# CHORDMH2 — certify `project.move-heading` with an ARCHIVED heading in the project.
#
# BACKGROUND. CHORDMH1 shipped the op with a whole-project fence: any
# completed/canceled heading refused the move, because the row addressing is
# POSITIONAL and whether Things renders an archived heading in the project view
# was unmeasured. CHORD2 cell 7a′ (docs/lab/chord2-reorder-laws.md §7) measured
# it: an archived heading does NOT render as a content row, takes NO ordinal in
# the `select-heading-row` walk, and a live heading's ±1 SKIPS its slot in one
# chord with no beep — the rendered order is the DB order filtered to
# `status = 0`. The fence is lifted, with the planner's ordinals computed over
# the live headings only. This cell certifies the lifted op against the app.
#
# CELL: one project with live G1 < G2 < G3 and an ARCHIVED heading between G1
# and G2 in the index axis. Drive `project move-heading … --first` on G3 through
# the production CLI and assert: the final LIVE order is G3 < G1 < G2, the
# archived heading's row is byte-untouched (index / status / stopDate / umd),
# children intact, and ZERO beeps. Plus the two refusals that survive the lift —
# an archived heading named as a movee, and as an anchor.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, clock pinned 2026-07-05 and NEVER rolled (the trial wall is
# 2026-07-18 — docs/lab/harness.md). Fixtures fully synthetic. Destroyed on
# teardown. Beep sentinel with THINGS_LAB_BEEPS_OK=1 (accounting, never a mute).
#
# Phases (the clone survives between them; SESSION carries the IP):
#   setup     clone + boot + airgap + clock pin + ship the CLI
#   cert      the certification cell
#   teardown  stop + delete the clone
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-chordmh2-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — well inside the trial wall (2026-07-18)
note() { echo "[chordmh2] $*" | tee -a "$REPORT"; }

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" "$@"; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }

bs()    { lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/things-lab/run/beep-sentinel.sh $*" </dev/null 2>&1; }
bmark() { lab_ssh "$IP" "~/things-lab/run/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }

# the RENDERED heading order — status = 0 only, which is what the app draws
horder() { gq "SELECT COALESCE(group_concat(t,' < '),'(none)') FROM (SELECT title AS t FROM TMTask WHERE project='$1' AND type=2 AND trashed=0 AND status=0 ORDER BY \"index\" ASC)"; }
# EVERY heading row, archived included, with its status — the raw index axis
hall()   { gt "SELECT title, status, \"index\" AS idx FROM TMTask WHERE project='$1' AND type=2 AND trashed=0 ORDER BY \"index\" ASC"; }
# the archived row's full byte signature — the untouched oracle
hbytes() { gq "SELECT COALESCE(group_concat(r,' '),'(missing)') FROM (SELECT ('status='||status||' idx='||\"index\"||' stop='||COALESCE(stopDate,'null')||' umd='||COALESCE(userModificationDate,'null')) AS r FROM TMTask WHERE uuid='$1')"; }
# every child of every heading of the project: heading FK + index
kidmap() { gq "SELECT COALESCE(group_concat(r,' | '),'(none)') FROM (SELECT (c.title||'->'||substr(c.heading,1,8)||'@'||c.\"index\") AS r FROM TMTask c JOIN TMTask h ON c.heading=h.uuid WHERE h.project='$1' AND c.trashed=0 ORDER BY c.title)"; }

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

  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  # Resolve commander rather than assuming ./node_modules — in a git WORKTREE the
  # install lives in the primary checkout and hoisting resolves through it.
  COMMANDER=$(node -e "console.log(require('node:path').dirname(require.resolve('commander')))")
  scpO -r "$COMMANDER" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
  note "shipped dist; ui-enabled=true"

  note "setup DONE — session in $SESSION"
  exit 0
fi

CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
G()  { lab_ssh "$IP" "$LAB_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
tj() { lab_ssh "$IP" "~/labh/tjson.sh $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null; sleep 4; }

# ================================================================= cell: deps
# Re-push the guest CLI's one runtime dependency (idempotent; setup does it too).
if [ "$CMD" = "deps" ]; then
  load_session
  COMMANDER=$(node -e "console.log(require('node:path').dirname(require.resolve('commander')))")
  note "pushing commander from $COMMANDER"
  lab_ssh "$IP" 'mkdir -p ~/things-lab/things-api/node_modules; rm -rf ~/things-lab/things-api/node_modules/commander' </dev/null
  scpO -r "$COMMANDER" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
  note "guest CLI version: $(lab_ssh "$IP" "$CLI --version" </dev/null 2>&1 | tail -1)"
  note "ui-enabled: $(lab_ssh "$IP" "$CLI config get ui-enabled" </dev/null 2>&1 | tail -1)"
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
if [ "$CMD" = "cert" ]; then
  load_session
  bs reset >/dev/null; bmark "cert setup"
  note ""
  note "########## CHORDMH2 — the lifted archived-heading fence, through the production CLI ##########"
  STAMP=$(date +%H%M%S)
  : > "$OUT/drives.log"
  P_TITLE="CMH2-$STAMP"
  G1="G1-$STAMP"; GA="GA-$STAMP"; G2="G2-$STAMP"; G3="G3-$STAMP"

  # Seed G1 < GA < G2 < G3, two synthetic children each; GA is archived below, so
  # the ARCHIVED row ends up sitting between G1 and G2 in the one index axis.
  ITEMS=""
  for h in "$G1" "$GA" "$G2" "$G3"; do
    ITEMS="$ITEMS{\"type\":\"heading\",\"attributes\":{\"title\":\"$h\"}},"
    ITEMS="$ITEMS{\"type\":\"to-do\",\"attributes\":{\"title\":\"$h-c1\"}},"
    ITEMS="$ITEMS{\"type\":\"to-do\",\"attributes\":{\"title\":\"$h-c2\"}},"
  done
  ITEMS="${ITEMS%,}"
  tj "[{\"type\":\"project\",\"attributes\":{\"title\":\"$P_TITLE\",\"items\":[$ITEMS]}}]"
  P=$(gq "SELECT uuid FROM TMTask WHERE title='$P_TITLE' AND type=1 AND trashed=0 LIMIT 1")
  HA=$(gq "SELECT uuid FROM TMTask WHERE title='$GA' AND type=2 AND trashed=0 LIMIT 1")
  note "  project=$P   archived-to-be heading=$HA"

  note ""
  note "  --- seed: archive GA (its children complete with it) ---"
  bmark "cert archive leg"
  OA=$(G project archive-heading "$P_TITLE" "$GA" --children complete --json)
  { echo "### archive leg"; echo "$OA"; } >> "$OUT/drives.log"
  note "      exit: $(echo "$OA" | grep -o 'EXIT=[0-9]*')"
  note "      raw index axis (every heading row):"
  hall "$P" | sed 's/^/        /' | tee -a "$REPORT"
  BEFORE=$(horder "$P"); ABYTES=$(hbytes "$HA"); KB=$(kidmap "$P")
  note "      RENDERED order before : $BEFORE"
  note "      archived row bytes    : $ABYTES"

  note ""
  note "  --- drive: move G3 to the top (the archived row sits between G1 and G2) ---"
  bmark "cert move-heading drive"
  OM=$(G project move-heading "$P_TITLE" "$G3" --first --dangerously-drive-gui --json)
  { echo "### move-heading drive"; echo "$OM"; } >> "$OUT/drives.log"
  AFTER=$(horder "$P"); ABYTES2=$(hbytes "$HA"); KA=$(kidmap "$P")
  note "      exit: $(echo "$OM" | grep -o 'EXIT=[0-9]*')"
  note "      RENDERED order after  : $AFTER"
  note "      raw index axis after:"
  hall "$P" | sed 's/^/        /' | tee -a "$REPORT"
  note "      archived row bytes    : $ABYTES2"
  WANT="$G3 < $G1 < $G2"
  [ "$AFTER" = "$WANT" ] && note "      ORDER      : CORRECT ($WANT)" || note "      ORDER      : *** WRONG — wanted [$WANT] ***"
  [ "$ABYTES2" = "$ABYTES" ] && note "      ARCHIVED   : BYTE-UNTOUCHED" || note "      ARCHIVED   : *** REWRITTEN *** $ABYTES -> $ABYTES2"
  [ "$KA" = "$KB" ] && note "      CHILDREN   : INTACT (FK + index byte-identical)" || { note "      CHILDREN   : *** CHANGED ***"; note "        before: $KB"; note "        after : $KA"; }

  note ""
  note "  --- the refusals that SURVIVE the lift: the archived heading as movee / as anchor ---"
  B2=$(horder "$P")
  bmark "cert archived movee"
  OR1=$(G project move-heading "$P_TITLE" "$GA" --first --dangerously-drive-gui --json)
  { echo "### archived as movee"; echo "$OR1" | head -40; } >> "$OUT/drives.log"
  note "      movee  exit: $(echo "$OR1" | grep -o 'EXIT=[0-9]*')"
  bmark "cert archived anchor"
  OR2=$(G project move-heading "$P_TITLE" "$G1" --before-heading "$GA" --dangerously-drive-gui --json)
  { echo "### archived as anchor"; echo "$OR2" | head -40; } >> "$OUT/drives.log"
  note "      anchor exit: $(echo "$OR2" | grep -o 'EXIT=[0-9]*')"
  A2=$(horder "$P")
  [ "$A2" = "$B2" ] && note "      ZERO MUTATION on both refusals — correct" || note "      *** A REFUSED CALL MOVED SOMETHING *** $B2 -> $A2"

  note ""
  note "  --- beep sentinel (the whole cell should be silent) ---"
  bs assert --allow 99 | sed 's/^/  /' | tee -a "$REPORT"
  note ""
  note "cert DONE — full CLI output in $OUT/drives.log"
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

echo "usage: $0 setup|ship|cert|teardown" >&2
exit 1
