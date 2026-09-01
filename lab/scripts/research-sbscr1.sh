#!/bin/bash
# SBSCR1 — why does the sidebar not scroll on the field host? (#672)
#
# BACKGROUND. #672 is a field report from a second Mac (things-api 0.20.2 /
# Things 3.23.2 / macOS 15.4.1): `area reorder --end` correctly detects the
# tall-section wall and selects the SBCOL1 collapse fallback, but `scrollUntil()`
# produces NO visible sidebar movement — the sidebar stays pinned at the top —
# and the run dies with the flattened reason "row could not be scrolled into
# view". Every distinct cause (snapshot failure, rejected dispatch, dispatch with
# no effect, boundary pin, iteration limit) collapses into that one sentence, so
# the report cannot say which happened.
#
# HYPOTHESES:
#   H1  scroll-under-pointer routing — macOS delivers wheel events to the view
#       under the POINTER. The shipped scroll script DOES move the pointer to the
#       sidebar centre first (ui-drag.ts jxaSidebarScrollScript), so this cell
#       exists to measure the law and to prove the shipped script is immune.
#   H2  a deterministic POINTERLESS route exists — a settable AXScrollBar
#       AXValue, or an AXScrollToVisible action on the row. Either beats wheel
#       events outright: closed-loop, pointer-independent, geometry-free.
#   H3  natural-scrolling inversion (com.apple.swipescrolldirection) flips
#       synthesized wheel deltas, so the driver scrolls AWAY from the target —
#       and at a scroll boundary that produces ZERO movement, which the loop's
#       self-calibration can never learn a sign from (it only flips direction
#       when it MEASURES travel the wrong way).
#   H4  hidden-until-scroll scrollbars (AppleShowScrollBars=WhenScrolling, the
#       laptop/trackpad default) — does the AXScrollBar element exist for our
#       reads under that setting?
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, clock pinned 2026-07-05 and NEVER rolled (trial wall
# 2026-07-18). Fixtures fully synthetic. Clone destroyed on teardown.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-sbscr1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — inside the trial wall (2026-07-18)
note() { echo "[sbscr1] $*" | tee -a "$REPORT"; }

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

area_order()  { gq 'SELECT COALESCE(group_concat(t," < "),"(none)") FROM (SELECT title AS t FROM TMArea ORDER BY "index", uuid)'; }
areacount()   { gq 'SELECT COUNT(*) FROM TMArea'; }
assign_digest() { gq "SELECT uuid||':'||COALESCE(area,'') FROM TMTask WHERE trashed=0 ORDER BY uuid" | shasum | cut -c1-12; }
titles_pipe() { gq 'SELECT group_concat(title, "|") FROM (SELECT title FROM TMArea ORDER BY "index", uuid)'; }

# The one guest entry point for every hypothesis verb.
H() { # H <verb> [args...]
  local verb="$1"; shift
  lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/sbscr1.jxa.js $(printf '%q' "$verb") $(printf '%q' "$TITLES") $(printf '%q ' "$@")" </dev/null 2>&1
}

# The shipped snapshot script, regenerated with the CURRENT area titles.
ship_snap() {
  TITLES="$(titles_pipe)"
  node -e "
    const t = process.argv[1].split('|').filter(Boolean);
    import('./dist/write/vectors/ui-drag.js').then(m => process.stdout.write(m.jxaSidebarSnapshotScript(t)));
  " "$TITLES" > "$OUT/sidebar-snap.jxa.js"
  lab_ssh "$IP" 'cat > ~/labh/sidebar-snap.jxa.js' < "$OUT/sidebar-snap.jxa.js"
}
snapjson() { lab_ssh "$IP" '/usr/bin/osascript -l JavaScript ~/labh/sidebar-snap.jxa.js' </dev/null 2>/dev/null; }

census() { # <label>
  local label="$1" f="$OUT/census-$1.txt"
  snapjson > "$OUT/snap-$label.json"
  python3 - "$OUT/snap-$label.json" "$TITLES" > "$f" <<'PY'
import json, sys
snap = json.load(open(sys.argv[1]))
titles = [t for t in sys.argv[2].split('|') if t]
if not snap.get('ok'):
    print("snapshot FAILED: %s" % snap.get('why')); raise SystemExit
vp = snap.get('viewport') or {}
rows = [r for r in snap['rows'] if r.get('y') is not None]
rows.sort(key=lambda r: r['y'])
def is_area(r):
    segs = (r.get('text') or '').split('|')
    for t in titles:
        if t in segs or (t + '.') in segs:
            return t
    return None
areas = [(t, r) for (t, r) in ((is_area(r), r) for r in rows) if t]
bottom = max((r['y'] + r['h']) for r in rows) if rows else 0
usable = (vp.get('h') or 0) - 24
print("viewport y=%s h=%s usable=%s  scroll=%s  table-rows=%d  area-rows=%d/%d"
      % (vp.get('y'), vp.get('h'), usable, snap.get('scroll'), len(rows), len(areas), len(titles)))
for i, (t, r) in enumerate(areas):
    nxt = areas[i+1][1]['y'] if i + 1 < len(areas) else bottom
    h = nxt - r['y']
    n = len([x for x in rows if r['y'] <= x['y'] < nxt])
    vis = "visible" if (vp and vp.get('y') is not None and vp['y'] <= r['y'] + r['h']/2 <= vp['y'] + vp['h']) else "OFF-SCREEN"
    print("%-12s top=%-8.0f height=%-6.0f rows=%-3d %-9s %s"
          % (t, r['y'], h, n, "WALL" if h > usable else "fits", vis))
PY
  cat "$f"
}

# Scroll the sidebar back to its TOP boundary (the #672 starting state).
to_top() { H wheel 30 1 >/dev/null; sleep 1; }

# ============================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "=== SBSCR1 setup — $(date) ==="
  df -g /Volumes/Workspace | tail -1 | tee -a "$REPORT"
  if [ "${SKIP_BUILD:-0}" != "1" ]; then npm run build >/dev/null 2>&1 || { echo "build failed" >&2; exit 1; }; fi
  [ -f dist/cli/main.js ] || { echo "no dist/cli/main.js" >&2; exit 1; }

  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM" || exit 1
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
  note "guest ip: $IP"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  note "airgap: $AG"; [ "$AG" = "AIRGAP-OK" ] || exit 1
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  note "clock: $(lab_ssh "$IP" 'date' </dev/null)"

  lab_ssh "$IP" 'mkdir -p ~/labh ~/things-lab/run ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  printf '%s\n' "$GSQL" | lab_ssh "$IP" 'cat > ~/labh/gsql.sh; chmod +x ~/labh/gsql.sh'
  scpO lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/things-lab/run/beep-sentinel.sh" >/dev/null 2>&1
  lab_ssh "$IP" 'chmod +x ~/things-lab/run/beep-sentinel.sh' </dev/null
  scpO lab/scripts/sbscr1-helper.jxa.js "admin@$IP:/Users/admin/labh/sbscr1.jxa.js" >/dev/null

  warm
  VER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString; defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null | tr '\n' '/')
  OSV=$(lab_ssh "$IP" 'sw_vers -productVersion; sw_vers -buildVersion' </dev/null | tr '\n' '/')
  note "things: $VER  macos: $OSV  db: $(gq 'SELECT value FROM Meta WHERE key="databaseVersion"' 2>/dev/null)"
  note "screen: $(lab_ssh "$IP" 'system_profiler SPDisplaysDataType 2>/dev/null | grep -i resolution | head -2' </dev/null | tr -s ' ')"
  note "swipescrolldirection: $(lab_ssh "$IP" 'defaults read -g com.apple.swipescrolldirection 2>&1' </dev/null)"
  note "AppleShowScrollBars:  $(lab_ssh "$IP" 'defaults read -g AppleShowScrollBars 2>&1' </dev/null)"

  NODE_BIN=$(node -e 'console.log(process.execPath)')
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
  note "cli: $(lab_ssh "$IP" "$CLI --version" </dev/null 2>&1)"

  echo "IP=$IP" > "$SESSION"
  note "=== setup done ==="
  exit 0
fi

# ============================================================== reship
if [ "$CMD" = "reship" ]; then
  load_session
  npm run build >/dev/null 2>&1 || { echo "build failed" >&2; exit 1; }
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO lab/scripts/sbscr1-helper.jxa.js "admin@$IP:/Users/admin/labh/sbscr1.jxa.js" >/dev/null
  ship_snap
  note "reshipped dist + helpers ($(date))"
  exit 0
fi

# ============================================================== seed
# The #672 field shape: a TALL sidebar whose blocking area sits BELOW the fold.
# Field: "Hobbies" + 63 child rows ≈ 1528pt in a ~901pt viewport, with the
# source area visible at the top. Mirrored here with synthetic names.
if [ "$CMD" = "seed" ]; then
  load_session
  note "=== seed — tall sidebar with an off-screen wall ==="
  AREAS="Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi"
  for A in $AREAS; do
    lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"Things3\" to make new area with properties {name:\"$A\"}'" </dev/null >/dev/null 2>&1
    sleep 1
  done
  note "areas seeded: $(areacount)"
  seed_projects() { # <area> <count>
    local a="$1" n="$2" i
    for i in $(seq -w 1 "$n"); do
      lab_ssh "$IP" "open -g 'things:///add-project?title=$a-P$i&area=$a'" </dev/null >/dev/null 2>&1
      sleep 0.6
    done
  }
  seed_projects Beta 2
  seed_projects Delta 3
  seed_projects Eta 2
  # the WALL, deliberately far down the list and taller than any viewport
  seed_projects Mu "${MU_PROJECTS:-60}"
  seed_projects Xi 3
  sleep 3
  note "project census per area:"
  gt 'SELECT a.title AS area, COUNT(t.uuid) AS projects FROM TMArea a LEFT JOIN TMTask t ON t.area=a.uuid AND t.type=1 AND t.trashed=0 AND t.status=0 GROUP BY a.uuid ORDER BY a."index", a.uuid' | tee -a "$REPORT"
  note "area order: $(area_order)"
  ship_snap
  exit 0
fi

# ============================================================== shape
# Confirm the fixture reproduces the field geometry before any hypothesis runs.
if [ "$CMD" = "shape" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  to_top
  note "=== shape — the fixture geometry at the top boundary ==="
  census "shape" | sed 's/^/  /' >/dev/null
  sed 's/^/  /' "$OUT/census-shape.txt" | tee -a "$REPORT"
  note "  geom: $(H geom)"
  exit 0
fi

# ============================================================== ptr  (H1)
# THE POINTER-ROUTING CELL. Park the pointer adversarially, then dispatch the
# wheel BOTH ways: raw (no pointer move — what a positionless-scroll assumption
# would do) and shipped (move to the sidebar centre first).
if [ "$CMD" = "ptr" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  note "=== ptr (H1) — scroll-under-pointer routing ==="
  GEOM=$(H geom); note "  geom: $GEOM"
  read -r VPX VPY VPW VPH CPX CPY CPW CPH <<<"$(python3 -c "
import json,sys
g=json.loads(sys.argv[1]); v=g['viewport']; c=g['content'] or {'x':0,'y':0,'w':0,'h':0}
print(v['x'],v['y'],v['w'],v['h'],c['x'],c['y'],c['w'],c['h'])" "$GEOM")"
  SB_CX=$(python3 -c "print(int($VPX+$VPW/2))"); SB_CY=$(python3 -c "print(int($VPY+$VPH/2))")
  CT_CX=$(python3 -c "print(int($CPX+$CPW/2))"); CT_CY=$(python3 -c "print(int($CPY+$CPH/2))")
  note "  sidebar centre=($SB_CX,$SB_CY)  content centre=($CT_CX,$CT_CY)"

  for PARK in "5 5 screen-corner" "$CT_CX $CT_CY content-pane" "$SB_CX $SB_CY sidebar"; do
    set -- $PARK; PX="$1"; PY="$2"; LBL="$3"
    for MODE in 0 1; do
      to_top
      note "  --- park=$LBL ($PX,$PY)  moveFirst=$MODE ---"
      note "    $(H park "$PX" "$PY")"
      R=$(H wheel -6 "$MODE"); note "    $R"
      python3 -c "
import json,sys
d=json.loads(sys.argv[1])
m=d.get('moved')
print('    VERDICT: moved %s px  (pointer at dispatch: %s)  %s' % (
  m, d.get('pointerAtDispatch'),
  'NO MOVEMENT' if (m is None or abs(m) < 2) else 'SCROLLED'))" "$R" | tee -a "$REPORT"
    done
  done
  exit 0
fi

# ============================================================== axscroll (H2)
# THE POINTERLESS CELL. Is there a deterministic route that needs no pointer at
# all — a settable scrollbar AXValue, or AXScrollToVisible on the row?
if [ "$CMD" = "axscroll" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  note "=== axscroll (H2) — a deterministic pointerless route ==="
  H sbinfo > "$OUT/ax/sbinfo.json"
  python3 - "$OUT/ax/sbinfo.json" <<'PY' | tee -a "$REPORT"
import json, sys
d = json.load(open(sys.argv[1]))
if not d.get('ok'):
    print("  sbinfo FAILED: %s" % d.get('why')); raise SystemExit
def show(name, blk):
    if blk is None: print("  %-12s (absent)" % name); return
    print("  %-12s role=%s actions=%s" % (name, blk.get('role'), blk.get('actions')))
    for k in sorted(blk.get('attrs', {})):
        flag = blk['attrs'][k]
        print("      %-34s settable=%s%s" % (k, flag, "  <<< SETTABLE" if flag == 'YES' else ""))
show('scrollArea', d.get('scrollArea'))
sb = d.get('scrollBar')
show('scrollBar', sb)
if sb: print("  scrollBar value=%s orient=%s" % (sb.get('value'), sb.get('orient')))
show('table', d.get('table'))
show('row0', d.get('row0'))
PY

  # ARM A — set the scroll bar's AXValue, pointer parked adversarially.
  note "  --- arm A: set AXScrollBar AXValue (pointer parked at 5,5) ---"
  to_top
  note "    $(H park 5 5)"
  for F in 0.5 1.0 0.0; do
    R=$(H setbar "$F")
    note "    setbar $F -> $R"
  done

  # ARM B — AXScrollToVisible / AXShowMenu on an off-screen row.
  note "  --- arm B: row actions on the off-screen wall row (\"${WALL:-Mu}\") ---"
  to_top
  note "    $(H park 5 5)"
  for A in AXScrollToVisible AXScrollAreaToVisible AXShowMenu; do
    note "    $A -> $(H rowaction "${WALL:-Mu}" "$A")"
  done
  exit 0
fi

# ============================================================== natural (H3)
# Does com.apple.swipescrolldirection invert a SYNTHESIZED line-unit wheel?
if [ "$CMD" = "natural" ]; then
  load_session; ship_snap
  note "=== natural (H3) — synthesized wheel vs natural-scrolling direction ==="
  for NAT in false true; do
    lab_ssh "$IP" "defaults write -g com.apple.swipescrolldirection -bool $NAT" </dev/null
    warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
    note "  --- swipescrolldirection=$NAT (read back: $(lab_ssh "$IP" 'defaults read -g com.apple.swipescrolldirection' </dev/null)) ---"
    to_top
    R=$(H wheel -6 1)
    note "    wheel -6 -> $R"
    python3 -c "
import json,sys
d=json.loads(sys.argv[1]); m=d.get('moved')
if m is None or abs(m) < 2: v='NO MOVEMENT'
elif m < 0: v='content moved UP (lower rows revealed) — the SHIPPED convention'
else: v='content moved DOWN — INVERTED'
print('    VERDICT: moved %s px — %s' % (m, v))" "$R" | tee -a "$REPORT"
  done
  lab_ssh "$IP" 'defaults write -g com.apple.swipescrolldirection -bool true' </dev/null
  note "  (restored to the macOS default: true)"
  exit 0
fi

# ============================================================== bars (H4)
# Under AppleShowScrollBars=WhenScrolling (the laptop/trackpad default), does the
# AXScrollBar element exist for our reads at all?
if [ "$CMD" = "bars" ]; then
  load_session; ship_snap
  note "=== bars (H4) — AXScrollBar presence per AppleShowScrollBars setting ==="
  for MODE in Automatic WhenScrolling Always; do
    lab_ssh "$IP" "defaults write -g AppleShowScrollBars -string $MODE" </dev/null
    warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
    to_top
    S=$(H state)
    note "  --- AppleShowScrollBars=$MODE ---"
    note "    state: $S"
    R=$(H setbar 0.5); note "    setbar 0.5 -> $R"
    to_top
  done
  lab_ssh "$IP" 'defaults delete -g AppleShowScrollBars' </dev/null 2>/dev/null
  note "  (restored to the macOS default: Automatic)"
  exit 0
fi

# ============================================================== grow
# Scale the fixture to the FIELD's 174 sidebar rows, and (separately) give the
# selected content list a real load — the shipped resolver harvests EVERY
# candidate list pane, not just the sidebar.
if [ "$CMD" = "grow" ]; then
  load_session
  WANT="${WANT:-174}"
  note "=== grow — scale the sidebar toward $WANT rows ==="
  ship_snap
  HAVE=$(snapjson | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("rows",[])))')
  note "  sidebar rows now: $HAVE"
  N=$(( (WANT - HAVE) / 2 + 1 ))
  [ "$N" -lt 1 ] && { note "  already at scale"; exit 0; }
  note "  adding $N projects to spread across areas"
  i=0
  for A in Theta Kappa Zeta Lambda Gamma Nu Epsilon Iota; do
    for j in $(seq 1 $(( N / 8 + 1 ))); do
      i=$((i+1)); [ "$i" -gt "$N" ] && break 2
      lab_ssh "$IP" "open -g 'things:///add-project?title=$A-Q$j&area=$A'" </dev/null >/dev/null 2>&1
      sleep 0.5
    done
  done
  sleep 3
  ship_snap
  note "  sidebar rows now: $(snapjson | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("rows",[])))')"
  exit 0
fi

# ============================================================== load
# Load the CONTENT pane: N to-dos in the currently-selected list.
if [ "$CMD" = "load" ]; then
  load_session
  N="${N:-300}"
  note "=== load — $N to-dos into the content list ==="
  for j in $(seq 1 "$N"); do
    lab_ssh "$IP" "open -g 'things:///add?title=Load-$j&when=today'" </dev/null >/dev/null 2>&1
    sleep 0.35
  done
  sleep 3
  note "  today count: $(gq 'SELECT COUNT(*) FROM TMTask WHERE trashed=0 AND status=0 AND start=1')"
  exit 0
fi

# ============================================================== snapcost
# THE FIELD BUG'S CELL (#672 comment): where does the snapshot's time go at
# field scale, and does the depth-2 harvest match every area title?
if [ "$CMD" = "snapcost" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  scpO lab/scripts/sbscr1-cost.jxa.js "admin@$IP:/Users/admin/labh/sbscr1-cost.jxa.js" >/dev/null
  note "=== snapcost — the shipped snapshot at this fixture's scale ==="
  note "  areas=$(areacount)  today-todos=$(gq 'SELECT COUNT(*) FROM TMTask WHERE trashed=0 AND status=0 AND start=1')"
  note "  --- the SHIPPED script, wall clock (${SNAP_N:-3} runs) ---"
  for i in $(seq 1 "${SNAP_N:-3}"); do
    note "    $(lab_ssh "$IP" 'S=$( { /usr/bin/time -p /usr/bin/osascript -l JavaScript ~/labh/sidebar-snap.jxa.js >/tmp/snap.json ; } 2>&1 ); echo "$S" | tr "\n" " "; echo "bytes=$(wc -c < /tmp/snap.json)"' </dev/null 2>&1)"
  done
  note "  rows returned: $(lab_ssh "$IP" 'python3 -c "import json;d=json.load(open(\"/tmp/snap.json\"));print(len(d.get(\"rows\",[])), d.get(\"matched\"), d.get(\"expected\"), d.get(\"deep\"))"' </dev/null 2>&1)"
  note "  --- per-depth, per-pane attribution ---"
  lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/sbscr1-cost.jxa.js $(printf '%q' "$TITLES") ${DEPTHS:-1,2,3,4,6}" </dev/null 2>&1 > "$OUT/cost.json"
  python3 - "$OUT/cost.json" <<'PY' | tee -a "$REPORT"
import json, sys
d = json.load(open(sys.argv[1]))
if not d.get('ok'):
    print("  FAILED: %s" % d.get('why')); raise SystemExit
print("  window walk: %d panes, %dms, %d AX calls   (%d area titles)"
      % (d['paneCount'], d['paneWalkMs'], d['paneWalkCalls'], d['titles']))
for r in d['depths']:
    print("  depth=%-2d %7dms  calls=%-7d rows=%-5d bestHits=%d/%d %s"
          % (r['depth'], r['ms'], r['calls'], r['rows'], r['bestHits'], r['of'],
             "*** ESCALATES ***" if r['escalates'] else ""))
    for p in r['perPane']:
        print("        pane%-2d rows=%-5d hits=%-3d %7dms calls=%-7d %sx%s  %r"
              % (p['pane'], p['rows'], p['hits'], p['ms'], p['calls'], p['w'], p['h'], p['sample']))
PY
  exit 0
fi

# ============================================================== seek
# THE FIX PROTOTYPE. Drive the off-screen wall row into the band using ONLY the
# scrollbar AXValue, pointer parked adversarially, and print the per-iteration
# telemetry record #672 asks for.
if [ "$CMD" = "seek" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  note "=== seek — pointerless closed loop onto \"${WALL:-Mu}\" (pointer at 5,5) ==="
  to_top
  note "  $(H park 5 5)"
  H seek "${WALL:-Mu}" 12 > "$OUT/seek.json"
  python3 - "$OUT/seek.json" <<'PY' | tee -a "$REPORT"
import json, sys
d = json.load(open(sys.argv[1]))
print("  terminal reason: %s   pointer at end: %s" % (d['reason'], d.get('pointer')))
for r in d['iterations']:
    print("  it=%-2d rowY=%-8.0f vpY=%-5.0f vpH=%-5.0f err=%-9.1f scroll=%-8.5f "
          "reqDelta=%-9.5f target=%-8.5f axErr=%s moved=%s afterRowY=%s afterScroll=%s px/frac=%s"
          % (r['iter'], r['rowFrame']['y'], r['viewport']['y'], r['viewport']['h'], r['err'],
             r['scrollBefore'], r.get('requestedDelta', 0), r.get('targetValue', 0),
             r.get('axError'), r.get('measuredMovement'),
             (r.get('rowFrameAfter') or {}).get('y'), r.get('scrollAfter'), r.get('pxPerFraction')))
PY
  note "  final: $(H rowy "${WALL:-Mu}")"
  exit 0
fi

# ============================================================== e2e
# THE ACCEPTANCE CELL. The #672 command shape with the pointer DELIBERATELY
# parked away from the sidebar. Must REPRODUCE the field failure pre-fix and
# PASS post-fix.
if [ "$CMD" = "e2e" ]; then
  load_session; ship_snap
  SUBJ="${SUBJ:-Alpha}"
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  to_top
  note "=== e2e — \"$SUBJ\" --end with the pointer parked OFF the sidebar ==="
  census "e2e-pre" >/dev/null
  note "  --- PRE-DRIVE census ---"; sed 's/^/    /' "$OUT/census-e2e-pre.txt" | tee -a "$REPORT"
  note "  park: $(H park "${PARK_X:-5}" "${PARK_Y:-5}")"
  BEFORE_ORDER=$(area_order); BEFORE_DIG=$(assign_digest); BEFORE_N=$(areacount)
  note "  before: $BEFORE_ORDER"
  T0=$(date +%s)
  # The #672 command shape VERBATIM: the universal reorder verb with --end.
  G reorder "$SUBJ" --end --dangerously-drive-gui --verify-timeout 120000 --json --verbose > "$OUT/e2e.json" 2>&1
  T1=$(date +%s)
  note "  wall clock: $((T1-T0))s"
  head -c 6000 "$OUT/e2e.json" | tee -a "$REPORT"; echo | tee -a "$REPORT"
  AFTER_ORDER=$(area_order); AFTER_DIG=$(assign_digest); AFTER_N=$(areacount)
  note "  after:  $AFTER_ORDER"
  note "  area count invariant:  $([ "$BEFORE_N" = "$AFTER_N" ] && echo PASS || echo "FAIL ($BEFORE_N -> $AFTER_N)")"
  note "  assignments invariant: $([ "$BEFORE_DIG" = "$AFTER_DIG" ] && echo PASS || echo FAIL)"
  LAST=$(gq 'SELECT title FROM TMArea ORDER BY "index" DESC, uuid DESC LIMIT 1')
  note "  last area is now: [$LAST]  — placement reached? $([ "$LAST" = "$SUBJ" ] && echo YES || echo no)"
  note "  pointer after the drive: $(H geom)"
  sleep 2
  census "e2e-post" >/dev/null
  note "  --- POST-DRIVE census ---"; sed 's/^/    /' "$OUT/census-e2e-post.txt" | tee -a "$REPORT"
  note "  disclosure state restored (section ROW COUNTS match pre-drive)? $(
    diff <(awk 'NR>1{print $1, $4}' "$OUT/census-e2e-pre.txt" | sort) <(awk 'NR>1{print $1, $4}' "$OUT/census-e2e-post.txt" | sort) >/dev/null \
      && echo 'YES' || echo 'NO — see the two censuses')"
  exit 0
fi

# ============================================================== cert
# SBCOL1 / SBRES1 controls re-run against the NEW scroll mechanism: the sidebar
# still resolves semantically, a short in-viewport move still works, and the
# collapse fallback still folds and restores.
if [ "$CMD" = "cert" ]; then
  load_session; ship_snap
  SUBJ="${SUBJ:-Beta}"; ANCHOR="${ANCHOR:-Alpha}"
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  note "=== cert — SBRES1/SBCOL1 controls on the new scroll mechanism ==="
  to_top
  note "  SBRES1 control (semantic resolution, wide window):"
  setwin 1200 420 >/dev/null; sleep 2
  note "    $(H state)"
  setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2
  census "cert-pre" >/dev/null
  note "  --- PRE census ---"; sed 's/^/    /' "$OUT/census-cert-pre.txt" | tee -a "$REPORT"
  BEFORE_ORDER=$(area_order); BEFORE_DIG=$(assign_digest); BEFORE_N=$(areacount)
  note "  before: $BEFORE_ORDER"
  T0=$(date +%s)
  G area reorder "$SUBJ" --before "$ANCHOR" --dangerously-drive-gui --json --verbose > "$OUT/cert.json" 2>&1
  T1=$(date +%s)
  note "  wall clock: $((T1-T0))s"
  head -c 4000 "$OUT/cert.json" | tee -a "$REPORT"; echo | tee -a "$REPORT"
  note "  after:  $(area_order)"
  note "  area count invariant:  $([ "$BEFORE_N" = "$(areacount)" ] && echo PASS || echo FAIL)"
  note "  assignments invariant: $([ "$BEFORE_DIG" = "$(assign_digest)" ] && echo PASS || echo FAIL)"
  sleep 2
  census "cert-post" >/dev/null
  note "  disclosure state restored? $(
    diff <(awk 'NR>1{print $1, $4}' "$OUT/census-cert-pre.txt" | sort) <(awk 'NR>1{print $1, $4}' "$OUT/census-cert-post.txt" | sort) >/dev/null \
      && echo 'YES' || echo 'NO — see the two censuses')"
  exit 0
fi

# ============================================================== teardown
if [ "$CMD" = "teardown" ]; then
  tart stop "$VM" >/dev/null 2>&1 || true; sleep 3
  tart delete "$VM" >/dev/null 2>&1 || true
  note "=== teardown: $VM destroyed ==="
  exit 0
fi

cat >&2 <<USAGE
usage: TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-sbscr1.sh <cmd>
  setup     clone golden-v4 + airgap + clock pin + helpers + shipped bundle
  seed      the tall sidebar (14 areas; Mu oversized and below the fold)
  shape     confirm the fixture reproduces the #672 geometry
  ptr       H1 — scroll-under-pointer routing, pointer parked adversarially
  axscroll  H2 — settable AXScrollBar AXValue / AXScrollToVisible on a row
  natural   H3 — does natural scrolling invert a synthesized wheel?
  bars      H4 — AXScrollBar presence per AppleShowScrollBars setting
  e2e       the #672 command shape with the pointer parked off the sidebar
  cert      SBRES1/SBCOL1 controls against the new scroll mechanism
  reship    rebuild + redeploy dist + helpers
  teardown  destroy the clone
USAGE
exit 2
