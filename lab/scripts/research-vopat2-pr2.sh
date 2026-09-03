#!/bin/bash
# VOPAT2 PR 2 — the SPARSE sidebar census and the observer settles, certified (#676)
#
# BACKGROUND. One census of the maintainer's 174-row sidebar REALIZES every row:
# 862 AX round-trips, 16-18 s on his M1 against 0.73 ms/call in a clone (SBCHV1
# §4). VOPAT1 §7 attributed that to REALIZING a custom row view onto a real
# display — ~115 ms per row realized — which is why a headless clone has never
# reproduced it and never will. The ladder censused before every scroll
# iteration, after every fold and before every hop, so a one-wall move to the
# end measured 436.5 s in the field on 0.20.8 with ~5 s of it gestures.
#
# WHAT SHIPPED (the thing this campaign certifies):
#   * a SPARSE census — `AXRows` + one batched position/size fetch per row
#     (realizes nothing) + content ONLY on the rows a prediction says are area
#     rows, confirmed by reading them; any disagreement escalates to the full
#     depth-2 sweep, which is retained byte for byte as the oracle;
#   * three ORDINAL-ADDRESSED primitives (pointerless scroll, wheel fallback,
#     disclosure click) that resolve the sidebar by the pane index a census
#     established and re-confirm it by realizing ONE area row;
#   * OBSERVER settles: the fold's 600 ms becomes `AXRowCountChanged`, the
#     scroll bar's `AXValueChanged` is recorded, the drop's observable measured.
#
# WHAT THIS CAMPAIGN MUST PRODUCE, beyond pass/fail:
#   ROUND-TRIPS and ROWS REALIZED per census, sparse against sweep ON THE SAME
#   STATE, plus censuses/gestures/settles per MOVE — because the next decision
#   (fold-all-then-one-drag, up-next 2026-09-03) has to be priced by MODEL at
#   the field's constants. The lab is ~25x optimistic on exactly the term being
#   compared, so a live A/B here would answer the wrong question.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, clock pinned 2026-07-05 and NEVER rolled (trial wall
# 2026-07-18). Fixtures 100% synthetic. Clone destroyed on teardown.
#
# NOTE ON REPRODUCIBILITY: lab wall times DO NOT TRANSFER. What transfers is AX
# round-trips, ROWS REALIZED and which notifications fire — all three
# host-independent — and the campaign doc prices them at the field's measured
# 18.6 ms/round-trip and 115 ms/row-realized.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-vopat2pr2-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — inside the trial wall (2026-07-18)
note() { echo "[vopat2pr2] $*" | tee -a "$REPORT"; }

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; true' </dev/null; }
setwin() { lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to tell process \"Things3\" to set size of (first window whose subrole is \"AXStandardWindow\") to {$1, $2}'" </dev/null 2>&1; }
activate() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\''; sleep 2' </dev/null >/dev/null 2>&1; }

CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
G() { lab_ssh "$IP" "$LAB_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }

area_order()    { gq 'SELECT COALESCE(group_concat(t," < "),"(none)") FROM (SELECT title AS t FROM TMArea ORDER BY "index", uuid)'; }
areacount()     { gq 'SELECT COUNT(*) FROM TMArea'; }
assign_digest() { gq "SELECT uuid||':'||COALESCE(area,'') FROM TMTask WHERE trashed=0 ORDER BY uuid" | shasum | cut -c1-12; }
titles_pipe()   { gq 'SELECT group_concat(title, "|") FROM (SELECT title FROM TMArea ORDER BY "index", uuid)'; }

# The SBCHV1 measurement rig, reused verbatim: this campaign needs its row
# census, its scroll-bar write, its pointer park and its chevron click, and a
# second copy of them would be a second thing to keep true.
M() { # M <verb> [args...]
  local verb="$1"; shift
  lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/sbchv1.jxa.js $(printf '%q' "$verb") $(printf '%q' "$TITLES") $(printf '%q ' "$@")" </dev/null 2>&1
}
# This campaign's own rig: the ordinal-space check and the geometry-cost split.
P() { # P <verb> [args...]
  local verb="$1"; shift
  lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/vopat2pr2.jxa.js $(printf '%q' "$verb") $(printf '%q' "$TITLES") $(printf '%q ' "$@")" </dev/null 2>&1
}

# ---- the SHIPPED scripts, regenerated from the built bundle ---------------
ship_snap() {
  TITLES="$(titles_pipe)"
  node -e "
    const t = process.argv[1].split('|').filter(Boolean);
    import('./dist/write/vectors/ui-drag.js').then(m => process.stdout.write(m.jxaSidebarSnapshotScript(t)));
  " "$TITLES" > "$OUT/sweep.jxa.js"
  lab_ssh "$IP" 'cat > ~/labh/sweep.jxa.js' < "$OUT/sweep.jxa.js"
}
# `ordinals` empty = the script picks its own section starts (no prediction yet).
ship_sparse() { # [comma-separated ordinals] [paneIndex|-]
  TITLES="$(titles_pipe)"
  node -e "
    const t = process.argv[1].split('|').filter(Boolean);
    const ords = process.argv[2] ? process.argv[2].split(',').map(Number) : [];
    const pane = process.argv[3] === '-' ? null : Number(process.argv[3]);
    import('./dist/write/vectors/ui-drag.js').then(m => process.stdout.write(
      m.jxaSidebarSparseSnapshotScript(t, { paneIndex: pane, ordinals: ords, maxCandidates: 28 })));
  " "$TITLES" "${1:-}" "${2:--}" > "$OUT/sparse.jxa.js"
  lab_ssh "$IP" 'cat > ~/labh/sparse.jxa.js' < "$OUT/sparse.jxa.js"
}
runjs() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/$1" </dev/null 2>/dev/null; }

# The two censuses' CONSUMER OUTPUT, compared through the shipped functions —
# RDLAT2's law ("a census change needs a cell that reads the census") in the
# form VOPAT1 §8 asked for.
consumers() { # <sweep.json> <sparse.json> <label>
  node lab/scripts/vopat2pr2-consumers.mjs "$1" "$2" "$TITLES" "$3"
}

# ---- the settle sidecar, driven directly by the cells ---------------------
PY='/usr/bin/python3 ~/labh/ax-observer.py'
SOCK='/Users/admin/labh/probe.sock'
TOK='vopat2pr2tokenvopat2pr2token00'
obs() { lab_ssh "$IP" "/usr/bin/printf '%s\\n' $(printf '%q' "$TOK $*") | /usr/bin/nc -U -w 20 $SOCK" </dev/null 2>&1; }
things_pid() { lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to return unix id of first application process whose name is \"Things3\"'" </dev/null 2>/dev/null | tr -d '\r'; }
arm() {
  local pid; pid=$(things_pid)
  lab_ssh "$IP" "rm -f $SOCK; $PY --socket $SOCK --token $TOK --pid $pid --ttl-ms 180000 --idle-ms 120000 >>~/labh/observer.log 2>&1 </dev/null & sleep 0.3; true" </dev/null >/dev/null 2>&1
  local i
  for i in $(seq 1 60); do
    case "$(obs hello)" in ok*) return 0 ;; esac
    sleep 0.2
  done
  return 1
}
disarm() { obs stop >/dev/null 2>&1; sleep 1; }
sidecar_pids() { lab_ssh "$IP" "pgrep -f ax-observer.py | tr '\\n' ' '" </dev/null 2>/dev/null; }

rows_now() { runjs sweep.jxa.js | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("rows",[])))'; }
to_top() { M setbar 0 >/dev/null 2>&1; sleep 1; }

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "=== VOPAT2 PR 2 setup — $(date) ==="
  FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
  note "preflight: free ${FREEGB}GB"
  [ "${FREEGB:-0}" -lt 10 ] && { note "FATAL: <10GB free on /Volumes/Workspace"; exit 1; }
  RUNNING=$(tart list | awk 'NR>1 && $NF=="running" {print $2}' | tr '\n' ' ')
  [ -n "$RUNNING" ] && { note "FATAL: another VM is running ($RUNNING) — never a second concurrent clone"; exit 1; }

  if [ "${SKIP_BUILD:-0}" != "1" ]; then npm run build >/dev/null 2>&1 || { echo "build failed" >&2; exit 1; }; fi
  [ -f dist/cli/main.js ] || { echo "no dist/cli/main.js" >&2; exit 1; }

  # The clone is destroyed if ANYTHING below fails — armed BEFORE the first
  # boot, because an orphaned 50 GB VM on a thin disk is the worst outcome here.
  BOOTED=0
  cleanup() {
    [ "$BOOTED" = "1" ] && return 0
    tart stop "$VM" >/dev/null 2>&1 || true; sleep 2
    tart delete "$VM" >/dev/null 2>&1 || true
    echo "[vopat2pr2] setup failed — clone destroyed" >&2
  }
  trap cleanup EXIT

  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM" || exit 1
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 600) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"

  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  note "airgap: $AG"; [ "$AG" = "AIRGAP-OK" ] || exit 1
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  note "clock: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) (trial wall 2026-07-18 — never rolled)"

  lab_ssh "$IP" 'mkdir -p ~/labh ~/things-lab/run ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  printf '%s\n' "$GSQL" | lab_ssh "$IP" 'cat > ~/labh/gsql.sh; chmod +x ~/labh/gsql.sh'
  scpO lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/things-lab/run/beep-sentinel.sh" >/dev/null 2>&1
  lab_ssh "$IP" 'chmod +x ~/things-lab/run/beep-sentinel.sh; ln -sf ~/things-lab/run/beep-sentinel.sh ~/labh/beep-sentinel.sh' </dev/null
  scpO lab/scripts/sbchv1-helper.jxa.js "admin@$IP:/Users/admin/labh/sbchv1.jxa.js" >/dev/null
  scpO lab/scripts/vopat2pr2-helper.jxa.js "admin@$IP:/Users/admin/labh/vopat2pr2.jxa.js" >/dev/null

  # The sidecar, extracted from the BUILT bundle and compiled on the GUEST
  # interpreter (3.9.6) — a dev Mac's python cannot see a 3.10-only spelling.
  node -e "import('./dist/write/vectors/ui-observer.js').then(m => process.stdout.write(m.OBSERVER_PY))" > "$OUT/ax-observer.py"
  python3 -m py_compile "$OUT/ax-observer.py" || { note "FATAL: extracted sidecar does not compile"; exit 1; }
  scpO "$OUT/ax-observer.py" "admin@$IP:/Users/admin/labh/ax-observer.py" >/dev/null
  GC=$(lab_ssh "$IP" '/usr/bin/python3 -m py_compile ~/labh/ax-observer.py && /usr/bin/python3 -V' </dev/null 2>&1)
  case "$GC" in Python*) note "guest python: $GC (sidecar compiles)" ;; *) note "FATAL: sidecar does not compile on the guest: $GC"; exit 1 ;; esac

  NODE_BIN=$(node -e 'console.log(process.execPath)')
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
  lab_ssh "$IP" "$CLI config set experimental-area-reorder true" </dev/null >/dev/null 2>&1
  note "cli: $(lab_ssh "$IP" "$CLI --version" </dev/null 2>&1 | tail -1)"

  warm
  VER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString; defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null | tr '\n' '/')
  OSV=$(lab_ssh "$IP" 'sw_vers -productVersion; sw_vers -buildVersion' </dev/null | tr '\n' '/')
  note "things: $VER  macos: $OSV  db: $(gq 'SELECT value FROM Meta WHERE key="databaseVersion"' 2>/dev/null)"

  echo "IP=$IP" > "$SESSION"
  BOOTED=1
  note "=== setup done ==="
  exit 0
fi

# =================================================================== reship
if [ "$CMD" = "reship" ]; then
  load_session
  if [ "${SKIP_BUILD:-0}" != "1" ]; then npm run build >/dev/null 2>&1 || { echo "build failed" >&2; exit 1; }; fi
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO lab/scripts/sbchv1-helper.jxa.js "admin@$IP:/Users/admin/labh/sbchv1.jxa.js" >/dev/null
  scpO lab/scripts/vopat2pr2-helper.jxa.js "admin@$IP:/Users/admin/labh/vopat2pr2.jxa.js" >/dev/null
  node -e "import('./dist/write/vectors/ui-observer.js').then(m => process.stdout.write(m.OBSERVER_PY))" > "$OUT/ax-observer.py"
  scpO "$OUT/ax-observer.py" "admin@$IP:/Users/admin/labh/ax-observer.py" >/dev/null
  ship_snap
  note "reshipped dist + rigs + sidecar ($(date))"
  exit 0
fi

# ===================================================================== seed
# The #676 field shape, fully synthetic: 14 areas, TWO oversized sections, and
# enough rows that the sidebar exposes a SCROLL BAR — the thing the unseeded
# golden lacks, which is why VOPAT2 §2 could not confirm VOPAT1-7.
if [ "$CMD" = "seed" ]; then
  load_session
  note "=== seed — 14 areas, two walls, 174 rows (the #676 shape) ==="
  AREAS="Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu"
  for A in $AREAS; do
    lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"Things3\" to make new area with properties {name:\"$A\"}'" </dev/null >/dev/null 2>&1
    sleep 1
  done
  # The DUPLICATE-title pair (AXDRAG3): two areas sharing one name, so the
  # positional disambiguation is exercised by a certification move.
  lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"Things3\" to make new area with properties {name:\"Twin\"}'" </dev/null >/dev/null 2>&1
  sleep 1
  lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"Things3\" to make new area with properties {name:\"Twin\"}'" </dev/null >/dev/null 2>&1
  sleep 1
  note "areas seeded: $(areacount)"
  seed_projects() {
    local a="$1" n="$2" i
    for i in $(seq -w 1 "$n"); do
      lab_ssh "$IP" "open -g 'things:///add-project?title=$a-P$i&area=$a'" </dev/null >/dev/null 2>&1
      sleep 0.55
    done
  }
  seed_projects Beta 4
  seed_projects Delta 6
  seed_projects Theta "${WALL_PROJECTS:-63}"   # WALL 1 — taller than any viewport
  seed_projects Eta "${WALL2_PROJECTS:-50}"    # WALL 2 — the two-wall path
  seed_projects Lambda 5
  seed_projects Mu 3
  sleep 3
  gt 'SELECT a.title AS area, COUNT(t.uuid) AS projects FROM TMArea a LEFT JOIN TMTask t ON t.area=a.uuid AND t.type=1 AND t.trashed=0 AND t.status=0 GROUP BY a.uuid ORDER BY a."index", a.uuid' | tee -a "$REPORT"
  note "area order: $(area_order)"
  ship_snap
  note "sidebar rows: $(rows_now)"
  exit 0
fi

# ==================================================================== topup
if [ "$CMD" = "topup" ]; then
  load_session; ship_snap
  A="${TOPUP_AREA:-Delta}"; N="${TOPUP_N:-20}"
  note "=== topup — $N more projects under \"$A\" (toward 174 rows) ==="
  for i in $(seq -w 1 "$N"); do
    lab_ssh "$IP" "open -g 'things:///add-project?title=$A-T$i&area=$A'" </dev/null >/dev/null 2>&1
    sleep 0.5
  done
  sleep 3
  ship_snap
  note "  sidebar rows now: $(rows_now)"
  exit 0
fi

# ==================================================================== shape
# The fixture's geometry, and the two facts the predictors rest on: row heights
# constant per kind, and a SCROLL BAR present.
if [ "$CMD" = "shape" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  to_top
  note "=== shape — the fixture at the top boundary ==="
  note "  rows: $(rows_now)"
  note "  geom: $(M geom)"
  note "  scroll bar present? $(runjs sweep.jxa.js | python3 -c 'import json,sys; d=json.load(sys.stdin); print("YES scroll="+str(d.get("scroll")) if d.get("scroll") is not None else "NO — the fixture did not seed one")')"
  M rowkinds > "$OUT/ax/rowkinds.json"
  python3 lab/scripts/vopat2pr2-rowkinds.py "$OUT/ax/rowkinds.json" "$TITLES" | tee -a "$REPORT"
  note "  --- the built-in rows' locale-independent image descriptions (SBCHV1 §7) ---"
  M imgdesc | head -c 2000 | tee -a "$REPORT"; echo | tee -a "$REPORT"
  exit 0
fi

# =================================================================== axrows
# The ordinal space itself: `AXRows` and the table's `AXChildren` must be the
# same list in the same order (VOPAT1-5, re-checked at 174 rows), and the
# geometry pass's cost measured against the alternatives.
if [ "$CMD" = "axrows" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  to_top
  note "=== axrows — the ordinal space, and what geometry costs ==="
  P ordinals | tee -a "$REPORT"
  note "  --- geometry per row: AXFrame vs one batched AXPosition+AXSize ---"
  P geomcost "${GEOM_N:-3}" | tee -a "$REPORT"
  exit 0
fi

# ==================================================================== reads
# THE HEAD-TO-HEAD. The SHIPPED sweep and the SHIPPED sparse census, on the SAME
# state, in every sidebar state the ladder meets — with the consumer output
# compared through the shipped consumer functions (RDLAT2's census law).
if [ "$CMD" = "reads" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  note "=== reads — sparse vs sweep, same state, consumer output compared ==="
  one_state() { # <label>
    local label="$1"
    runjs sweep.jxa.js > "$OUT/ax/sweep-$label.json"
    # (a) NO prediction: the script picks its own section starts.
    ship_sparse "" "-"
    runjs sparse.jxa.js > "$OUT/ax/sparse-starts-$label.json"
    # (b) the CARRIED prediction: the ordinals the sweep just established.
    local ORDS PANE
    ORDS=$(python3 lab/scripts/vopat2pr2-rowkinds.py --ordinals "$OUT/ax/sweep-$label.json" "$TITLES")
    PANE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("paneIndex","-"))' "$OUT/ax/sweep-$label.json")
    ship_sparse "$ORDS" "$PANE"
    runjs sparse.jxa.js > "$OUT/ax/sparse-carried-$label.json"
    note "  --- state: $label (predicted ordinals: $ORDS, pane $PANE) ---"
    consumers "$OUT/ax/sweep-$label.json" "$OUT/ax/sparse-starts-$label.json" "$label/section-starts" | tee -a "$REPORT"
    consumers "$OUT/ax/sweep-$label.json" "$OUT/ax/sparse-carried-$label.json" "$label/carried" | tee -a "$REPORT"
  }
  to_top;                    one_state "top"
  M setbar 0.5 >/dev/null;   sleep 1; one_state "mid"
  M setbar 1 >/dev/null;     sleep 1; one_state "bottom"
  # One wall folded — the state the collapse rung leaves behind.
  to_top
  M seek "${WALL:-Theta}" 12 >/dev/null; M chevclick "${WALL:-Theta}" "" >/dev/null; sleep 2
  one_state "folded"
  M seek "${WALL:-Theta}" 12 >/dev/null; M chevclick "${WALL:-Theta}" "" >/dev/null; sleep 2
  note "  rows restored: $(rows_now)"
  exit 0
fi

# ================================================================ dbpredict
# The DATABASE's arithmetic prediction (VOPAT1 §8 R1) against the sweep's own
# ordinals — including whether `collapsedAreaUUIDs` reflects LIVE state, which
# is the one thing that would make the whole predictor unusable.
if [ "$CMD" = "dbpredict" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  to_top
  note "=== dbpredict — the DB row model vs the sweep's ordinals ==="
  PLIST='~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist'
  collapsed_uuids() { lab_ssh "$IP" "plutil -extract collapsedAreaUUIDs raw -o - $PLIST 2>/dev/null || echo '(absent)'" </dev/null | tr -d '\r'; }
  note "  collapsedAreaUUIDs (all expanded): [$(collapsed_uuids | tr '\n' ' ')]"
  gq 'SELECT a.uuid||":"||a.title||":"||(SELECT COUNT(*) FROM TMTask t WHERE t.area=a.uuid AND t.type=1 AND t.trashed=0 AND t.status=0) FROM TMArea a ORDER BY a."index", a.uuid' > "$OUT/ax/db-areas.txt"
  runjs sweep.jxa.js > "$OUT/ax/sweep-dbpredict.json"
  python3 lab/scripts/vopat2pr2-dbmodel.py "$OUT/ax/sweep-dbpredict.json" "$OUT/ax/db-areas.txt" "$TITLES" "" | tee -a "$REPORT"
  note "  --- now with one section FOLDED: does the preference follow? ---"
  M seek "${WALL:-Theta}" 12 >/dev/null; M chevclick "${WALL:-Theta}" "" >/dev/null; sleep 3
  C=$(collapsed_uuids | tr '\n' ' ')
  note "  collapsedAreaUUIDs after the fold: [$C]"
  runjs sweep.jxa.js > "$OUT/ax/sweep-dbpredict-folded.json"
  python3 lab/scripts/vopat2pr2-dbmodel.py "$OUT/ax/sweep-dbpredict-folded.json" "$OUT/ax/db-areas.txt" "$TITLES" "$C" | tee -a "$REPORT"
  M seek "${WALL:-Theta}" 12 >/dev/null; M chevclick "${WALL:-Theta}" "" >/dev/null; sleep 2
  note "  rows restored: $(rows_now)"
  exit 0
fi

# =================================================================== notify
# THE THREE OBSERVABLES. The scroll bar's `AXValueChanged` is VOPAT1-7, which
# VOPAT2 §2 could NOT confirm (the unseeded golden has no scroll bar — AXError
# -1719). The fold's `AXRowCountChanged` is VOPAT1-8. The DROP's observable has
# never been measured at all.
if [ "$CMD" = "notify" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  to_top
  note "=== notify — what the sidebar announces ==="
  note "  stray sidecars before: [$(sidecar_pids)] (expect empty)"
  arm || { note "FATAL: sidecar never answered"; exit 1; }
  note "  handshake: $(obs hello)"

  cell() { # <label> <want> <timeout-ms> <actuation-shell>
    local label="$1" want="$2" tmo="$3" act="$4"
    local seq; seq=$(obs mark | sed 's/^ok seq=//')
    eval "$act" >/dev/null 2>&1
    note "  $label: $(obs await since=$seq want=$want timeout=$tmo quiet=120)"
  }
  note "  --- idle control: nothing is happening, so nothing may fire ---"
  cell "idle" "AXRowCountChanged,AXValueChanged" 2000 "true"
  note "  --- (a) a scroll-bar write (VOPAT1-7, UNCONFIRMED until now) ---"
  cell "scroll" "AXValueChanged:AXScrollBar" 3000 "M setbar 0.4"
  cell "scroll-back" "AXValueChanged:AXScrollBar" 3000 "M setbar 0"
  note "  --- (b) a disclosure fold and its re-expansion (VOPAT1-8) ---"
  M seek "${WALL:-Theta}" 12 >/dev/null
  cell "fold" "AXRowCountChanged:AXTable,AXRowCountChanged" 5000 "M chevclick ${WALL:-Theta} ''"
  sleep 2
  M seek "${WALL:-Theta}" 12 >/dev/null
  cell "expand" "AXRowCountChanged:AXTable,AXRowCountChanged" 5000 "M chevclick ${WALL:-Theta} ''"
  sleep 2
  note "  rows after fold+expand: $(rows_now)"
  note "  --- (c) what a DROP announces (never measured) ---"
  BEFORE=$(area_order)
  SEQ=$(obs mark | sed 's/^ok seq=//')
  G area reorder "${DROP_SUBJ:-Gamma}" --first --dangerously-drive-gui --json > "$OUT/notify-drop.json" 2>&1
  for W in "AXRowCountChanged" "AXSelectedRowsChanged" "AXValueChanged" "AXCreated" "AXUIElementDestroyed" "AXLayoutChanged"; do
    note "  drop announced $W? $(obs await since=$SEQ want=$W timeout=200)"
  done
  note "  order before: $BEFORE"
  note "  order after:  $(area_order)"
  disarm
  note "  stray sidecars after: [$(sidecar_pids)] (expect empty)"
  exit 0
fi

# ====================================================================== e2e
# THE CERTIFICATION MOVES, through the production CLI, with the trace's
# `sidebar-move-cost` record read back for each one. SPARSE=0 re-runs one move
# on the sweep for the same-state A/B.
if [ "$CMD" = "e2e" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  note "=== e2e — the certification moves (sparse=${SPARSE:-1}) ==="
  # ADVERSARIAL POINTER (SBSCR1): parked OFF the sidebar for the first half of
  # the cells and ON it for the second, because a synthesized wheel event goes
  # to the view under the pointer and a drag must not care where it was.
  move() { # <label> <cli args...>
    local label="$1"; shift
    to_top
    note "  --- $label: things $* ---"
    local B_ORDER B_DIG B_N T0 T1
    B_ORDER=$(area_order); B_DIG=$(assign_digest); B_N=$(areacount)
    runjs sweep.jxa.js > "$OUT/ax/e2e-$label-pre.json"
    lab_ssh "$IP" 'rm -rf ~/.local/state/things-api/trace' </dev/null 2>/dev/null
    lab_ssh "$IP" '~/labh/beep-sentinel.sh reset; ~/labh/beep-sentinel.sh mark "'"$label"'"' </dev/null >/dev/null 2>&1
    T0=$(date +%s)
    lab_ssh "$IP" "$LAB_DIRECT THINGS_API_TRACE=1 THINGS_API_SIDEBAR_SPARSE=${SPARSE:-1} $CLI $* --dangerously-drive-gui --verify-timeout 180000 --json; echo EXIT=\$?" </dev/null > "$OUT/e2e-$label.json" 2>&1
    T1=$(date +%s)
    note "    wall clock: $((T1-T0))s"
    head -c 2500 "$OUT/e2e-$label.json" | tee -a "$REPORT"; echo | tee -a "$REPORT"
    lab_ssh "$IP" 'cat ~/.local/state/things-api/trace/*.jsonl 2>/dev/null' </dev/null > "$OUT/e2e-$label-trace.jsonl" 2>/dev/null
    python3 lab/scripts/vopat2pr2-trace.py "$OUT/e2e-$label-trace.jsonl" | tee -a "$REPORT"
    note "    order after: $(area_order)"
    note "    area count invariant:  $([ "$B_N" = "$(areacount)" ] && echo PASS || echo FAIL)"
    note "    assignments invariant: $([ "$B_DIG" = "$(assign_digest)" ] && echo PASS || echo FAIL)"
    sleep 2
    runjs sweep.jxa.js > "$OUT/ax/e2e-$label-post.json"
    note "    disclosure restored? $(python3 lab/scripts/vopat2pr2-rowkinds.py --sections-equal "$OUT/ax/e2e-$label-pre.json" "$OUT/ax/e2e-$label-post.json" "$TITLES")"
    lab_ssh "$IP" 'THINGS_LAB_BEEPS_OK=1 ~/labh/beep-sentinel.sh assert --json ~/labh/beeps.json --name vopat2pr2' </dev/null 2>&1 | tail -3 | sed 's/^/    beeps: /' | tee -a "$REPORT"
  }
  note "  pointer parked OFF the sidebar: $(M park 5 5)"
  move "to-last-two-walls" reorder Alpha --end
  move "to-first"          reorder Mu --start
  move "mid-before"        area reorder Beta --before Iota
  note "  pointer parked ON the sidebar: $(M park 120 200)"
  move "mid-after"         area reorder Kappa --after Zeta
  move "dupe-pair"         area reorder Twin --start
  exit 0
fi

# ==================================================================== abort
# RESTORE-ON-ABORT: kill the drive mid-ladder (after the fold has landed) and
# prove the sidebar and the window chrome come back — SBCOL1 §6's cell, re-run
# against the sparse census and the observer settles.
if [ "$CMD" = "abort" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  to_top
  note "=== abort — the drive dies after the fold; is the sidebar put back? ==="
  PLIST='~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist'
  collapsed_n() { lab_ssh "$IP" "plutil -extract collapsedAreaUUIDs raw -o - $PLIST 2>/dev/null | grep -c . || echo 0" </dev/null | tr -d ' \r\n'; }
  note "  collapsed before: $(collapsed_n)"
  note "  rows before: $(rows_now)"
  lab_ssh "$IP" "$LAB_DIRECT THINGS_API_TRACE=1 $CLI reorder Alpha --end --dangerously-drive-gui --json >/tmp/abort.json 2>&1 & echo started" </dev/null
  for i in $(seq 1 90); do
    C=$(collapsed_n)
    if [ "${C:-0}" != "0" ]; then note "  fold landed after ${i}s (collapsed=$C) — killing the drive"; break; fi
    sleep 1
  done
  lab_ssh "$IP" 'pkill -f "dist/cli/main.js" ; true' </dev/null >/dev/null 2>&1
  sleep 3
  note "  collapsed after the kill: $(collapsed_n)  (a durable change if non-zero)"
  note "  rows after the kill: $(rows_now)"
  note "  --- the NEXT drive must restore what the killed one left folded ---"
  G reorder Alpha --start --dangerously-drive-gui --json > "$OUT/abort-recover.json" 2>&1
  head -c 1200 "$OUT/abort-recover.json" | tee -a "$REPORT"; echo | tee -a "$REPORT"
  note "  collapsed after the recovery drive: $(collapsed_n)"
  note "  rows after the recovery drive: $(rows_now)"
  exit 0
fi

# =================================================================== hidden
# SBRES1's normalization rung under the sparse census: a HIDDEN sidebar is shown
# through Things' own View menu, driven, and hidden again.
if [ "$CMD" = "hidden" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  to_top
  note "=== hidden — SBRES1 normalization with a sparse census ==="
  lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to tell process \"Things3\" to click menu item \"Hide Sidebar\" of menu 1 of menu bar item \"View\" of menu bar 1'" </dev/null >/dev/null 2>&1
  sleep 2
  note "  sweep now says: $(runjs sweep.jxa.js | head -c 200)"
  B=$(area_order)
  G area reorder Gamma --after Delta --dangerously-drive-gui --json > "$OUT/hidden.json" 2>&1
  head -c 2000 "$OUT/hidden.json" | tee -a "$REPORT"; echo | tee -a "$REPORT"
  note "  order before: $B"
  note "  order after:  $(area_order)"
  note "  sidebar hidden again? $(runjs sweep.jxa.js | python3 -c 'import json,sys; d=json.load(sys.stdin); print("YES (why=%s)" % d.get("why") if not d.get("ok") else "NO — still visible")')"
  lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"System Events\" to tell process \"Things3\" to click menu item \"Show Sidebar\" of menu 1 of menu bar item \"View\" of menu bar 1'" </dev/null >/dev/null 2>&1
  sleep 2
  note "  restored: rows $(rows_now)"
  exit 0
fi

# ================================================================= teardown
if [ "$CMD" = "teardown" ]; then
  tart stop "$VM" >/dev/null 2>&1 || true; sleep 3
  tart delete "$VM" >/dev/null 2>&1 || true
  note "=== teardown: $VM destroyed ==="
  exit 0
fi

cat >&2 <<USAGE
usage: TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-vopat2-pr2.sh <cmd>
  setup      clone golden-v4 + airgap + clock pin + rigs + sidecar + bundle
  seed       14 areas (incl. a duplicate-title pair), two walls, a scroll bar
  topup      more projects, toward the field's 174 rows
  shape      the fixture's geometry; row kinds; the built-ins' image descriptions
  axrows     AXRows == AXChildren at 174 rows; what geometry costs per row
  reads      SPARSE vs SWEEP on the same state, consumer output compared
  dbpredict  the DB row model vs the sweep's ordinals; collapsedAreaUUIDs live?
  notify     the scroll / fold / drop observables (VOPAT1-7, -8, and unmeasured)
  e2e        the certification moves, with the move-cost trace read back
  abort      restore-on-abort: kill the drive after the fold
  hidden     SBRES1 normalization under a sparse census
  reship     rebuild + redeploy dist + rigs + sidecar
  teardown   destroy the clone
USAGE
exit 2
