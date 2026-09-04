#!/bin/bash
# DRPLC1 — `area reorder --last` lands SECOND-to-last on Things 3.23.3 (#729).
#
# THE QUESTION. `planDrop()` computes the to-last drop Y statically, from the
# PRE-drag census, and then subtracts the lifted source's group span on the
# AXDRAG1-a law that "lifting the source collapses its slot, so everything below
# shifts up by the span". If a later Things build keeps the source's slot OPEN
# during the drag (a placeholder / landing gap), rows below do NOT shift up, the
# subtraction over-corrects by exactly one span, and the aimed point falls in the
# TOP half of the last area row — which inserts ABOVE it. That is #729's symptom
# exactly, and it is invisible against the lab's 3.23 golden.
#
# So this campaign MEASURES the mid-drag layout on both builds, with the drag
# held open and the whole row table censused (AXDRAG2-a proved frames re-resolve
# mid-drag), and certifies the fix under both.
#
# METHOD. ONE disposable clone at a time; the goldens are NEVER booted. Airgapped
# guest, clock pinned 2026-07-05 and never rolled (trial wall 2026-07-18).
# Fixtures fully synthetic. The clone is destroyed by an EXIT trap.
#
#   research-drplc1.sh probe   [--upgrade]   law measurement, both builds
#   research-drplc1.sh cert    <direct|routed> [--upgrade]
#   research-drplc1.sh teardown              rescue an orphaned clone
#
# `--upgrade` swaps /Applications/Things3.app for the banked 3.23.3 build
# mid-sitting and repeats the cells, so one boot covers both versions.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
source lab/scripts/helpers-guest.sh

CMD="${1:-}"
ARM="${2:-direct}"
VM="${VM:-drplc1-lab}"
GOLDEN_DIRECT="${GOLDEN_DIRECT:-things-lab-golden-v4}"
GOLDEN_ROUTED="${GOLDEN_ROUTED:-things-lab-golden-v4h}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
PIN="070512002026"          # 2026-07-05 12:00 — inside the trial wall (2026-07-18)
ZIP323="${ZIP323:-/Volumes/Workspace/things-releases/Things3-3.23.3-32303001.zip}"
IP=""
KEEP="${KEEP:-0}"

note() { echo "[drplc1] $*" | tee -a "$REPORT"; }

cleanup() {
  local code=$?
  if [ "$KEEP" = "1" ]; then
    echo "[drplc1] KEEP=1 — leaving $VM up (IP=$IP); run '$0 teardown' when done" >&2
    return
  fi
  echo "[drplc1] cleanup: destroying $VM" >&2
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  return $code
}

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

gq()   { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
osa()  { lab_ssh "$IP" "/usr/bin/osascript -e $(printf '%q' "$1")" </dev/null 2>&1; }

CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
# The arm decides the ESCAPES, not the command: the routed arm must carry none
# (HELPGST1 routing-arm law), or a broker refusal would silently run direct.
PFX=""
G() { lab_ssh "$IP" "$PFX $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }

warm() {
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; true' </dev/null
}
activate() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null >/dev/null 2>&1; }
setwin() { lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to tell process \"Things3\" to set size of (first window whose subrole is \"AXStandardWindow\") to {$1, $2}'" </dev/null 2>&1; }

area_order()  { gq 'SELECT COALESCE(group_concat(t," < "),"(none)") FROM (SELECT title AS t FROM TMArea ORDER BY "index", uuid)'; }
titles_pipe() { gq 'SELECT group_concat(title, "|") FROM (SELECT title FROM TMArea ORDER BY "index", uuid)'; }
nth_area()    { gq "SELECT title FROM TMArea ORDER BY \"index\", uuid LIMIT 1 OFFSET $1"; }
nth_uuid()    { gq "SELECT uuid FROM TMArea ORDER BY \"index\", uuid LIMIT 1 OFFSET $1"; }
assign_digest() { gq "SELECT uuid||':'||COALESCE(area,'') FROM TMTask WHERE trashed=0 ORDER BY uuid" | shasum | cut -c1-12; }
appver() { lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString; defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null | tr '\n' '/'; }

# One guest entry point for the DRPLC1 helper verbs.
H() { # H <verb> [args...]
  local verb="$1"; shift
  lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/drplc1.jxa.js $(printf '%q' "$verb") $(printf '%q' "$(titles_pipe)") $(printf '%q ' "$@")" </dev/null 2>&1
}

# ---------------------------------------------------------------- boot
boot_clone() { # boot_clone <golden>
  local golden="$1"
  note "=== DRPLC1 $(date) — clone $golden -> $VM ==="
  df -g /Volumes/Workspace | tail -1 | tee -a "$REPORT"
  local free; free=$(df -g /Volumes/Workspace | tail -1 | awk '{print $4}')
  [ "$free" -ge 10 ] || { echo "disk floor: only ${free}GiB free" >&2; exit 1; }
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$golden" "$VM" || exit 1
  trap cleanup EXIT
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 600) || exit 1
  note "guest ip: $IP"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  local ag; ag=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  note "airgap: $ag"; [ "$ag" = "AIRGAP-OK" ] || exit 1
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  note "clock: $(lab_ssh "$IP" 'date' </dev/null)"
}

ship_kit() {
  lab_ssh "$IP" 'mkdir -p ~/labh ~/things-lab/run ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  printf '%s\n' "$GSQL" | lab_ssh "$IP" 'cat > ~/labh/gsql.sh; chmod +x ~/labh/gsql.sh'
  scpO lab/scripts/drplc1-helper.jxa.js "admin@$IP:/Users/admin/labh/drplc1.jxa.js" >/dev/null
  scpO lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/things-lab/run/beep-sentinel.sh" >/dev/null 2>&1
  lab_ssh "$IP" 'chmod +x ~/things-lab/run/beep-sentinel.sh' </dev/null
  local node_bin; node_bin=$(node -e 'console.log(process.execPath)')
  scpO "$node_bin" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO -r "$(lab_commander_dir)" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
}

# ---------------------------------------------------------------- fixture
# Mirrors #729's shape: 12 areas, the SOURCE first carrying an expanded group of
# projects, one tall blocking section mid-list, the target below the last area.
# Every name synthetic — nothing here derives from anyone's real library.
SRC=""; BLOCK=""; LAST=""; PENULT=""
seed_fixture() {
  note "-- clearing the golden's own areas (a clean 12-area list) --"
  local uuids; uuids=$(gq 'SELECT uuid FROM TMArea ORDER BY "index", uuid')
  for u in $uuids; do
    lab_ssh "$IP" "$LAB_WRITE_DIRECT $CLI area delete $u --dangerously-permanent --allow-non-empty --json" </dev/null >/dev/null 2>&1
  done
  note "areas after clear: $(gq 'SELECT COUNT(*) FROM TMArea')"
  note "-- seeding 12 synthetic areas + nested projects --"
  osa 'tell application "Things3"
  repeat with i from 1 to 12
    set nm to "DRPLC-A" & text -2 thru -1 of ("0" & i)
    make new area with properties {name:nm}
  end repeat
end tell' >/dev/null
  sleep 2
  # Positional designation: sidebar order is (index, uuid) ASC and freshly made
  # areas all carry index 0, so WHICH name lands first is a uuid tie-break, not
  # ours to choose. Read the order and name the roles from it.
  SRC=$(nth_area 0); BLOCK=$(nth_area 7); PENULT=$(nth_area 10); LAST=$(nth_area 11)
  note "roles: SRC=$SRC BLOCK=$BLOCK PENULT=$PENULT LAST=$LAST"
  osa "tell application \"Things3\"
  repeat with i from 1 to 3
    make new project with properties {name:\"DRPLC-PS\" & i, area:area \"$SRC\"}
  end repeat
  repeat with i from 1 to 26
    make new project with properties {name:\"DRPLC-PW\" & i, area:area \"$BLOCK\"}
  end repeat
end tell" >/dev/null
  sleep 3
  note "areas(12): $(area_order)"
  note "projects: $(gq 'SELECT COUNT(*) FROM TMTask WHERE type=1 AND trashed=0')"
  echo "SRC=$SRC BLOCK=$BLOCK PENULT=$PENULT LAST=$LAST" > "$OUT/roles.env"
}

# ---------------------------------------------------------------- 3.23.3 swap
upgrade_app() {
  note "############ in-place upgrade to Things 3.23.3 ############"
  [ -f "$ZIP323" ] || { echo "no banked installer at $ZIP323" >&2; exit 1; }
  note "before: $(appver)"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 4; pkill -x Things3 >/dev/null 2>&1; sleep 2; pgrep -x Things3 >/dev/null && echo STILL-RUNNING || echo QUIT' </dev/null | tee -a "$REPORT"
  scpO "$ZIP323" "admin@$IP:/tmp/Things3.zip" >/dev/null
  lab_ssh "$IP" 'set -e
    rm -rf /tmp/things-extract
    ditto -xk /tmp/Things3.zip /tmp/things-extract
    sudo rm -rf /Applications/Things3.app
    sudo mv /tmp/things-extract/Things3.app /Applications/Things3.app
    rm -rf /tmp/Things3.zip /tmp/things-extract
    defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString
    defaults read /Applications/Things3.app/Contents/Info CFBundleVersion
    codesign -dv /Applications/Things3.app 2>&1 | sed -n "1,3p"' </dev/null | tee -a "$REPORT"
  # The clock is NEVER rolled, so the trial margin is the golden's. Prove the
  # app still WRITES before believing anything measured after this point: the
  # trial wall is silent (REPX3) and looks exactly like an app-behavior change.
  warm
  note "after: $(appver)"
  local before after
  before=$(gq 'SELECT COUNT(*) FROM TMArea')
  osa 'tell application "Things3" to make new area with properties {name:"DRPLC-TRIALPROBE"}' >/dev/null
  sleep 3
  after=$(gq 'SELECT COUNT(*) FROM TMArea')
  note "trial-wall positive control: areas $before -> $after"
  if [ "$after" = "$before" ]; then
    note "STOP: the app accepted no write after the upgrade — trial wall or worse. Aborting."
    exit 9
  fi
  local u; u=$(gq "SELECT uuid FROM TMArea WHERE title='DRPLC-TRIALPROBE'")
  lab_ssh "$IP" "$LAB_WRITE_DIRECT $CLI area delete $u --dangerously-permanent --allow-non-empty --json" </dev/null >/dev/null 2>&1
  sleep 2
  note "areas after removing the probe: $(gq 'SELECT COUNT(*) FROM TMArea') — $(area_order)"
  note "doctor sees: $(lab_ssh "$IP" "$PFX $CLI doctor --json" </dev/null 2>&1 | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["data"].get("appVersion"))' 2>/dev/null || echo '(unread)')"
}

# ---------------------------------------------------------------- the law cell
law_cell() { # law_cell <tag>
  local tag="$1"
  # The source is whatever sits FIRST right now — a previous cell may have moved
  # the one the fixture named, and grabbing an off-viewport row measures nothing
  # (it posts a mouse-down on the desktop and every frame reads unchanged).
  SRC=$(nth_area 0)
  note "############ LIFT-LAYOUT LAW ($tag, Things $(appver), source=$SRC) ############"
  warm; activate; setwin 935 684 >/dev/null; sleep 2
  H census > "$OUT/census-$tag.json"
  python3 lab/scripts/drplc1-analyze.py census "$OUT/census-$tag.json" | tee -a "$REPORT"
  note "-- liftread: grab $SRC, hold, census the whole table mid-drag --"
  H liftread "$SRC" 3 > "$OUT/liftread-$tag.json"
  python3 lab/scripts/drplc1-analyze.py lift "$OUT/liftread-$tag.json" | tee -a "$REPORT"
  note "-- liftmove: same, with the pointer walked 200px down first --"
  H liftmove "$SRC" 200 2 > "$OUT/liftmove-$tag.json"
  python3 lab/scripts/drplc1-analyze.py lift "$OUT/liftmove-$tag.json" | tee -a "$REPORT"
  note "-- order unchanged by the aborted lifts? $(area_order)"
}

# The scroll-bar hypothesis: with the whole list inside the viewport there is no
# scroll bar at all, and the to-last boundary sits well above the viewport floor.
fits_cell() { # fits_cell <tag>
  local tag="$1"
  note "############ NO-SCROLLBAR SHAPE ($tag) ############"
  # Strip the wall's projects so the list fits, then re-measure and re-drive.
  local pw; pw=$(gq "SELECT uuid FROM TMTask WHERE type=1 AND trashed=0 AND title LIKE 'DRPLC-PW%'")
  for u in $pw; do
    lab_ssh "$IP" "$LAB_WRITE_DIRECT $CLI project delete $u --json" </dev/null >/dev/null 2>&1
  done
  sleep 2
  note "projects left: $(gq 'SELECT COUNT(*) FROM TMTask WHERE type=1 AND trashed=0')"
  SRC=$(nth_area 0)
  warm; activate; setwin 1200 900 >/dev/null; sleep 2
  H census > "$OUT/census-fits-$tag.json"
  python3 lab/scripts/drplc1-analyze.py census "$OUT/census-fits-$tag.json" | tee -a "$REPORT"
  H liftread "$SRC" 2 > "$OUT/liftread-fits-$tag.json"
  python3 lab/scripts/drplc1-analyze.py lift "$OUT/liftread-fits-$tag.json" | tee -a "$REPORT"
  note "-- to-last with no wall and no scroll bar --"
  local pre; pre=$(area_order)
  G area reorder "$(nth_uuid 0)" --last --dangerously-drive-gui --json 2>&1 | tee "$OUT/fits-last-$tag.json" | head -c 500; echo
  note "before: $pre"
  note "after:  $(area_order)"
}

# ---------------------------------------------------------------- cert cells
cert_cells() { # cert_cells <tag>
  local tag="$1" pre post code
  note "############ CERT ($tag, arm=$ARM, Things $(appver)) ############"
  warm; activate; setwin 935 684 >/dev/null; sleep 2
  local dig0; dig0=$(assign_digest)

  cell() { # cell <name> <cli args...>
    local name="$1"; shift
    pre=$(area_order)
    note "-- $name --"
    G "$@" > "$OUT/cell-$tag-$name.json" 2>&1
    tail -c 700 "$OUT/cell-$tag-$name.json" | tr -d '\n' | tee -a "$REPORT"; echo | tee -a "$REPORT"
    note "   before: $pre"
    note "   after:  $(area_order)"
    note "   assignments digest: $(assign_digest) (seed $dig0)"
  }

  cell last  area reorder "$(nth_uuid 0)"  --last  --dangerously-drive-gui --json
  cell first area reorder "$(nth_uuid 11)" --first --dangerously-drive-gui --json
  local anchor; anchor=$(nth_uuid 6)
  cell before area reorder "$(nth_uuid 2)" --before "$anchor" --dangerously-drive-gui --json
  anchor=$(nth_uuid 8)
  cell after  area reorder "$(nth_uuid 1)" --after "$anchor" --dangerously-drive-gui --json
  note "final order: $(area_order)"
  note "area count: $(gq 'SELECT COUNT(*) FROM TMArea')  digest: $(assign_digest) (seed $dig0)"
}

dup_cell() { # dup_cell <tag> — a duplicate-titled pair moved by uuid
  local tag="$1" dupname pre
  dupname=$(nth_area 3)
  note "############ DUPLICATE-TITLE PAIR ($tag) ############"
  osa "tell application \"Things3\" to make new area with properties {name:\"$dupname\"}" >/dev/null
  sleep 2
  note "areas: $(area_order)"
  warm; activate; setwin 935 684 >/dev/null; sleep 2
  local u; u=$(gq "SELECT uuid FROM TMArea WHERE title='$dupname' ORDER BY \"index\", uuid LIMIT 1")
  pre=$(area_order)
  G area reorder "$u" --last --dangerously-drive-gui --json > "$OUT/cell-$tag-dup.json" 2>&1
  tail -c 700 "$OUT/cell-$tag-dup.json" | tr -d '\n' | tee -a "$REPORT"; echo | tee -a "$REPORT"
  note "   before: $pre"
  note "   after:  $(area_order)"
  # remove the duplicate again so later cells see a unique-titled list
  local dupu; dupu=$(gq "SELECT uuid FROM TMArea WHERE title='$dupname' ORDER BY \"index\" DESC, uuid DESC LIMIT 1")
  lab_ssh "$IP" "$LAB_WRITE_DIRECT $CLI area delete $dupu --dangerously-permanent --json" </dev/null >/dev/null 2>&1
  sleep 2
  note "   after removing the duplicate: $(area_order)"
}

abort_cell() { # abort_cell <tag> — an aborted gesture leaves the order byte-identical
  local tag="$1" pre post
  note "############ RESTORE-ON-ABORT ($tag) ############"
  # NOT by backgrounding Things: the drive's FIRST step is "bring Things to the
  # foreground", so that is something it fixes, not a refusal. Two cells, each
  # deterministic:
  #   (a) a REAL held drag, Escape-aborted with the button still down — the
  #       AXDRAG1-d property the whole ladder's recovery rests on;
  #   (b) an anchor that does not exist — refused before a single event.
  warm; activate; setwin 935 684 >/dev/null; sleep 2
  SRC=$(nth_area 0)
  pre=$(gq 'SELECT title||"="||"index" FROM TMArea ORDER BY "index", uuid' | tr '\n' ' ')
  H liftread "$SRC" 1 > "$OUT/abort-lift-$tag.json"
  post=$(gq 'SELECT title||"="||"index" FROM TMArea ORDER BY "index", uuid' | tr '\n' ' ')
  if [ "$pre" = "$post" ]; then note "   (a) PASS Escape-abort left the index vector byte-identical"
  else note "   (a) FAIL index vector moved: $pre -> $post"; fi
  pre="$post"
  G area reorder "$(nth_uuid 0)" --before DRPLC-NO-SUCH-AREA --dangerously-drive-gui --json \
    > "$OUT/cell-$tag-abort.json" 2>&1
  tail -c 400 "$OUT/cell-$tag-abort.json" | tr -d '\n' | tee -a "$REPORT"; echo | tee -a "$REPORT"
  post=$(gq 'SELECT title||"="||"index" FROM TMArea ORDER BY "index", uuid' | tr '\n' ' ')
  if [ "$pre" = "$post" ]; then note "   (b) PASS an unresolvable anchor refused with nothing posted"
  else note "   (b) FAIL index vector moved: $pre -> $post"; fi
}

sparse_cell() { # sparse_cell <tag> — SPARSE=0 must land the same order
  local tag="$1" pre
  note "############ SPARSE=0 A/B ($tag) ############"
  warm; activate; setwin 935 684 >/dev/null; sleep 2
  pre=$(area_order)
  lab_ssh "$IP" "$PFX THINGS_API_SIDEBAR_SPARSE=0 $CLI area reorder $(nth_uuid 0) --last --dangerously-drive-gui --json; echo EXIT=\$?" </dev/null > "$OUT/cell-$tag-sparse0.json" 2>&1
  tail -c 600 "$OUT/cell-$tag-sparse0.json" | tr -d '\n' | tee -a "$REPORT"; echo | tee -a "$REPORT"
  note "   before: $pre"
  note "   after:  $(area_order)"
}

trace_cost() { # trace_cost <tag> — the drive's own cost + drop-target records
  local tag="$1"
  note "-- trace: sidebar-move-cost / drop-target ($tag) --"
  # THINGS_API_TRACE writes a JSONL file under the state dir, not to stdout, so
  # the records have to be fetched from the guest — the earlier cells' "trace"
  # output was the CLI envelope and nothing else.
  lab_ssh "$IP" 'rm -rf ~/.local/state/things-api/trace' </dev/null >/dev/null 2>&1
  lab_ssh "$IP" "$PFX THINGS_API_TRACE=1 $CLI area reorder $(nth_uuid 0) --last --dangerously-drive-gui --json 2>&1" </dev/null > "$OUT/trace-$tag.txt"
  lab_ssh "$IP" 'cat ~/.local/state/things-api/trace/*.jsonl 2>/dev/null' </dev/null > "$OUT/trace-$tag.jsonl"
  python3 - "$OUT/trace-$tag.jsonl" <<'PY' | tee -a "$REPORT"
import json, sys
for line in open(sys.argv[1]):
    try:
        e = json.loads(line)
    except ValueError:
        continue
    if e.get("phase") == "sidebar-drop-target":
        print("   drop-target: anchor=%s static=%s corrected=%s span=%s live=%s "
              "live-vs-static=%s stop=%s iters=%s"
              % (e.get("anchor"), e.get("staticY"), e.get("correctedY"), e.get("span"),
                 e.get("liveY"), e.get("liveVsStatic"), e.get("stop"),
                 len(e.get("iterations") or [])))
        for it in (e.get("iterations") or []):
            print("      %s" % it)
    if e.get("phase") == "sidebar-move-cost":
        print("   move-cost: %s" % json.dumps({k: v for k, v in e.items()
                                               if k not in ("phase", "ts", "elapsedMs")}))
PY
  note "   order after the traced move: $(area_order)"
}

configure_arm() {
  if [ "$ARM" = "routed" ]; then
    PFX=""
    note "-- provisioning the ROUTED arm (helpers 1.4.0, no escapes) --"
    guest_helpers_provision "$IP" "$CLI" || exit 1
    lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
    lab_ssh "$IP" "$CLI config set experimental-area-reorder true" </dev/null >/dev/null 2>&1
  else
    PFX="$LAB_DIRECT"
    lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
    lab_ssh "$IP" "$CLI config set experimental-area-reorder true" </dev/null >/dev/null 2>&1
  fi
  note "cli: $(lab_ssh "$IP" "$CLI --version" </dev/null 2>&1)"
}

# ================================================================= probe
if [ "$CMD" = "probe" ]; then
  : > "$REPORT"
  UPGRADE=0; [ "${2:-}" = "--upgrade" ] || [ "${3:-}" = "--upgrade" ] && UPGRADE=1
  ARM="direct"
  if [ "${SKIP_BUILD:-0}" != "1" ]; then npm run build >/dev/null 2>&1 || { echo "build failed" >&2; exit 1; }; fi
  boot_clone "$GOLDEN_DIRECT"
  ship_kit
  warm
  note "things: $(appver)  macos: $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)  db: $(gq 'SELECT value FROM Meta WHERE key="databaseVersion"')"
  note "screen: $(lab_ssh "$IP" 'system_profiler SPDisplaysDataType 2>/dev/null | grep -i resolution | head -1' </dev/null | tr -s ' ')"
  configure_arm
  seed_fixture
  law_cell 323
  note "-- BASELINE (unfixed dist) --last on 3.23: expected to LAND --"
  P0=$(area_order)
  G area reorder "$(nth_uuid 0)" --last --dangerously-drive-gui --json 2>&1 | tee "$OUT/baseline-323.json" | tail -c 600; echo
  note "   before: $P0"
  note "   after:  $(area_order)"
  if [ "$UPGRADE" = "1" ]; then
    upgrade_app
    law_cell 3233
    note "-- BASELINE (unfixed dist) --last on 3.23.3: #729 should REPRODUCE --"
    P1=$(area_order)
    G area reorder "$(nth_uuid 0)" --last --dangerously-drive-gui --json 2>&1 | tee "$OUT/baseline-3233.json" | tail -c 900; echo
    note "   before: $P1"
    note "   after:  $(area_order)"
    fits_cell 3233
  fi
  note "=== probe done — artifacts in $OUT ==="
  exit 0
fi

# ================================================================== cert
if [ "$CMD" = "cert" ]; then
  : > "$REPORT"
  UPGRADE=0; [ "${3:-}" = "--upgrade" ] && UPGRADE=1
  case "$ARM" in direct|routed) ;; *) echo "arm must be direct|routed" >&2; exit 1 ;; esac
  if [ "${SKIP_BUILD:-0}" != "1" ]; then npm run build >/dev/null 2>&1 || { echo "build failed" >&2; exit 1; }; fi
  if [ "$ARM" = "routed" ] && [ ! -x "deputy/build/Things API Helper.app/Contents/MacOS/things-deputy" ]; then
    note "building the helper bundle on the host"
    bash scripts/build-helpers.sh >"$OUT/build-helpers.log" 2>&1 || { echo "helper build failed — see $OUT/build-helpers.log" >&2; exit 1; }
  fi
  if [ "$ARM" = "routed" ]; then boot_clone "$GOLDEN_ROUTED"; else boot_clone "$GOLDEN_DIRECT"; fi
  ship_kit
  warm
  note "things: $(appver)  arm: $ARM"
  configure_arm
  seed_fixture
  cert_cells 323
  dup_cell 323
  abort_cell 323
  sparse_cell 323
  trace_cost 323
  if [ "$UPGRADE" = "1" ]; then
    upgrade_app
    if [ "$ARM" = "routed" ]; then
      note "-- do the helper grants survive the app upgrade? --"
      guest_helpers_assert_routed "$IP" "$CLI" | tee -a "$REPORT" || note "   ROUTED TIER LOST after the upgrade — falling back to DIRECT for the 3.23.3 cells"
    fi
    law_cell 3233
    cert_cells 3233
    trace_cost 3233
    fits_cell 3233
  else
    fits_cell 323
  fi
  note "=== cert done ($ARM) — artifacts in $OUT ==="
  exit 0
fi

# ============================================================== teardown
if [ "$CMD" = "teardown" ]; then
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  echo "[drplc1] $VM destroyed"
  exit 0
fi

echo "usage: $0 probe [--upgrade] | cert <direct|routed> [--upgrade] | teardown" >&2
exit 1
