#!/bin/bash
# SBCHV1 — the disclosure step's budget, its internals, and a SPARSE sidebar read (#676)
#
# BACKGROUND. #676 is a field report from the maintainer's M1 (things-api 0.20.3
# / Things 3.23.2 / macOS 15.4.1) carrying a sanitized trace. It proves three
# things at once:
#   * `sidebar-snapshot` took 16–18s at 174 rows, depth 2, not escalated,
#     matched 12/12 — and SUCCEEDED only because 0.20.3's row-scaled budget gave
#     it 69600ms. The lab reads the same shape in ~0.8s (SBSCR1), so the field
#     host is roughly 20x slower per AX round-trip. That gap is now MEASURED.
#   * `sidebar-scroll` worked (0 → 0.635 in one dispatch) — SBSCR1's pointerless
#     scrollbar fix is confirmed on real hardware.
#   * `sidebar-chevron` ran 30028ms, ok:false, timedOut:true — it hit the FLAT
#     30s step timeout the snapshot had already outgrown.
#
# HYPOTHESES:
#   H1  BUDGET PARITY. Every sidebar-touching primitive contains at least one
#       `resolveSidebar` census, so a budget that does not scale with row count
#       fails on exactly the sidebars the rung exists to serve. The chevron
#       script is census + per-row harvest + chevron subtree + ~0.7s of click
#       settles. MEASURE the split; confirm the scaled budget covers it.
#   H2  THE CHEVRON'S ROW HARVEST WAS THE COST, not the click. The shipped
#       script matched rows with a hand-rolled depth-6 `AXValue`/`AXDescription`/
#       `AXTitle` walk (3 round-trips per node) instead of the batched,
#       depth-2-guarded `node()`/`textOf` the snapshot uses. MEASURE both.
#   H3  A SPARSE READ IS POSSIBLE. The database already knows the sidebar's
#       structure (area order, which projects render under each area) and the
#       collapsed set is in the group-container plist. Row heights are constant
#       per row KIND. So the whole row list can be PREDICTED arithmetically and
#       CONFIRMED with a handful of AX reads on the predicted area-row ordinals,
#       falling back to the full sweep on any mismatch. MEASURE call count and
#       wall time, sparse vs full, and prove the consumer output is identical.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is NEVER
# booted). Airgapped, clock pinned 2026-07-05 and NEVER rolled (trial wall
# 2026-07-18). Fixtures fully synthetic. Clone destroyed on teardown.
#
# NOTE ON REPRODUCIBILITY: the lab is ~20x FASTER per AX call than the field
# host, so the 30s FIELD TIMEOUT ITSELF is not lab-reproducible. What this
# campaign certifies is the LOGIC — that the budgets scale, that the
# instrumentation emits, that the collapse completes end to end at field scale,
# and that the sparse read agrees with the full sweep. The field probe
# (lab/scripts/field-probe-sidebar.jxa.js) is the instrument for the other half.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-sbchv1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/ax"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — inside the trial wall (2026-07-18)
note() { echo "[sbchv1] $*" | tee -a "$REPORT"; }

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

# The one guest entry point for every measurement verb.
M() { # M <verb> [args...]
  local verb="$1"; shift
  lab_ssh "$IP" "/usr/bin/osascript -l JavaScript ~/labh/sbchv1.jxa.js $(printf '%q' "$verb") $(printf '%q' "$TITLES") $(printf '%q ' "$@")" </dev/null 2>&1
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

# The shipped CHEVRON script, regenerated for one area title (resolve + click).
ship_chevron() { # <title> [ordinal]
  node -e "
    const t = process.argv[1].split('|').filter(Boolean);
    import('./dist/write/vectors/ui-drag.js').then(m =>
      process.stdout.write(m.jxaSidebarChevronClickScript(process.argv[2], Number(process.argv[3]), t)));
  " "$TITLES" "$1" "${2:--1}" > "$OUT/sidebar-chevron.jxa.js"
  lab_ssh "$IP" 'cat > ~/labh/sidebar-chevron.jxa.js' < "$OUT/sidebar-chevron.jxa.js"
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

to_top() { M setbar 0 >/dev/null 2>&1; sleep 1; }

# ============================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "=== SBCHV1 setup — $(date) ==="
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
  scpO lab/scripts/sbchv1-helper.jxa.js "admin@$IP:/Users/admin/labh/sbchv1.jxa.js" >/dev/null

  warm
  VER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString; defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null | tr '\n' '/')
  OSV=$(lab_ssh "$IP" 'sw_vers -productVersion; sw_vers -buildVersion' </dev/null | tr '\n' '/')
  note "things: $VER  macos: $OSV  db: $(gq 'SELECT value FROM Meta WHERE key="databaseVersion"' 2>/dev/null)"
  note "screen: $(lab_ssh "$IP" 'system_profiler SPDisplaysDataType 2>/dev/null | grep -i resolution | head -2' </dev/null | tr -s ' ')"

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
  if [ "${SKIP_BUILD:-0}" != "1" ]; then npm run build >/dev/null 2>&1 || { echo "build failed" >&2; exit 1; }; fi
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO lab/scripts/sbchv1-helper.jxa.js "admin@$IP:/Users/admin/labh/sbchv1.jxa.js" >/dev/null
  ship_snap
  note "reshipped dist + helpers ($(date))"
  exit 0
fi

# ============================================================== seed
# The #676 field shape: 12 areas and a TALL blocking section below the fold.
# Field: 174 sidebar rows, 12 areas, the wall rendering 64 rows (~1528pt) in a
# ~901pt viewport. Mirrored here with fully synthetic names.
if [ "$CMD" = "seed" ]; then
  load_session
  note "=== seed — the #676 sidebar shape (12 areas, one tall wall) ==="
  AREAS="Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu"
  for A in $AREAS; do
    lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"Things3\" to make new area with properties {name:\"$A\"}'" </dev/null >/dev/null 2>&1
    sleep 1
  done
  note "areas seeded: $(areacount)"
  seed_projects() { # <area> <count>
    local a="$1" n="$2" i
    for i in $(seq -w 1 "$n"); do
      lab_ssh "$IP" "open -g 'things:///add-project?title=$a-P$i&area=$a'" </dev/null >/dev/null 2>&1
      sleep 0.55
    done
  }
  seed_projects Beta 4
  seed_projects Delta 6
  seed_projects Eta 8
  seed_projects Theta "${WALL_PROJECTS:-63}"   # the WALL — taller than any viewport
  seed_projects Lambda 5
  seed_projects Mu 3
  sleep 3
  note "project census per area:"
  gt 'SELECT a.title AS area, COUNT(t.uuid) AS projects FROM TMArea a LEFT JOIN TMTask t ON t.area=a.uuid AND t.type=1 AND t.trashed=0 AND t.status=0 GROUP BY a.uuid ORDER BY a."index", a.uuid' | tee -a "$REPORT"
  note "area order: $(area_order)"
  ship_snap
  exit 0
fi

# ============================================================== topup
# Add projects to one area until the table reaches the FIELD's 174 rows.
if [ "$CMD" = "topup" ]; then
  load_session; ship_snap
  A="${TOPUP_AREA:-Eta}"; N="${TOPUP_N:-42}"
  note "=== topup — $N more projects under \"$A\" (field parity: 174 table rows) ==="
  for i in $(seq -w 1 "$N"); do
    lab_ssh "$IP" "open -g 'things:///add-project?title=$A-T$i&area=$A'" </dev/null >/dev/null 2>&1
    sleep 0.5
  done
  sleep 3
  ship_snap
  note "  sidebar rows now: $(snapjson | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("rows",[])))')"
  exit 0
fi

# ============================================================== shape
if [ "$CMD" = "shape" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  to_top
  note "=== shape — the fixture geometry at the top boundary ==="
  census "shape" >/dev/null
  sed 's/^/  /' "$OUT/census-shape.txt" | tee -a "$REPORT"
  note "  geom: $(M geom)"
  exit 0
fi

# ============================================================== latency (H1)
# The per-AX-call latency of THIS host — the number the field probe measures on
# the maintainer's Mac. Everything else in this campaign is denominated in it.
if [ "$CMD" = "latency" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  note "=== latency — per-AX-call cost on the lab host ==="
  M latency "${LAT_N:-400}" | tee -a "$REPORT"
  exit 0
fi

# ============================================================== chevcost (H1/H2)
# WHERE DOES THE CHEVRON STEP'S TIME GO? Split the shipped script's own stages,
# and compare the OLD depth-6 unbatched row matcher against the NEW batched one.
if [ "$CMD" = "chevcost" ]; then
  load_session; ship_snap
  WALL="${WALL:-Theta}"
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  note "=== chevcost — the disclosure step's internal split at field scale ==="
  note "  rows: $(snapjson | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("rows",[])))')"
  note "  --- the two row matchers, head to head (resolve only, NO click) ---"
  M matchcost "$WALL" | tee -a "$REPORT"
  note "  --- the SHIPPED chevron script's own stage split (this DOES click) ---"
  ship_chevron "$WALL"
  # scroll the wall into the band first — the script refuses an off-band chevron
  M seek "$WALL" 12 >/dev/null
  for i in 1 2; do
    note "    run $i: $(lab_ssh "$IP" '/usr/bin/osascript -l JavaScript ~/labh/sidebar-chevron.jxa.js' </dev/null 2>&1)"
    sleep 2
  done
  exit 0
fi

# ============================================================== rowkinds (H3)
# (a) WHICH rows does the sidebar render, and for which project states? (b) Are
# row heights constant per kind — expanded vs collapsed area, area with zero
# projects, spacer rows, the fixed rows above the area list?
if [ "$CMD" = "rowkinds" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-900}" >/dev/null; sleep 2; activate
  to_top
  note "=== rowkinds — what the sidebar renders, and at what heights ==="
  note "  --- DB project states per area (open/someday/completed/cancelled/trashed) ---"
  gt 'SELECT a.title AS area,
        SUM(CASE WHEN t.status=0 AND t.trashed=0 AND t.start=1 THEN 1 ELSE 0 END) AS open_anytime,
        SUM(CASE WHEN t.status=0 AND t.trashed=0 AND t.start=2 THEN 1 ELSE 0 END) AS someday,
        SUM(CASE WHEN t.status=0 AND t.trashed=0 AND t.start=0 THEN 1 ELSE 0 END) AS inbox_start,
        SUM(CASE WHEN t.status=3 AND t.trashed=0 THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN t.status=2 AND t.trashed=0 THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN t.trashed=1 THEN 1 ELSE 0 END) AS trashed
      FROM TMArea a LEFT JOIN TMTask t ON t.area=a.uuid AND t.type=1
      GROUP BY a.uuid ORDER BY a."index", a.uuid' | tee -a "$REPORT"
  note "  --- the AX row ledger (role / height / kind / chevron present) ---"
  M rowkinds > "$OUT/ax/rowkinds.json"
  python3 - "$OUT/ax/rowkinds.json" <<'PY' | tee -a "$REPORT"
import json, sys, collections
d = json.load(open(sys.argv[1]))
if not d.get('ok'):
    print("  FAILED: %s" % d.get('why')); raise SystemExit
print("  table rows: %d   viewport h=%s" % (len(d['rows']), (d.get('viewport') or {}).get('h')))
byh = collections.Counter()
for r in d['rows']:
    byh[(r['kind'], round(r['h'], 1))] += 1
for (kind, h), n in sorted(byh.items()):
    print("    kind=%-10s height=%-7s count=%d" % (kind, h, n))
print("  distinct heights per kind:")
per = collections.defaultdict(set)
for r in d['rows']:
    per[r['kind']].add(round(r['h'], 1))
for k in sorted(per):
    print("    %-10s %s  %s" % (k, sorted(per[k]), "CONSTANT" if len(per[k]) == 1 else "*** VARIES ***"))
print("  first 6 rows (top of the table — the fixed rows above the area list):")
for r in sorted(d['rows'], key=lambda r: r['y'])[:6]:
    print("    y=%-8.1f h=%-6.1f kind=%-10s chevron=%-5s text=%r" % (r['y'], r['h'], r['kind'], r['chevron'], r['text'][:40]))
PY
  exit 0
fi

# ============================================================== plist (H3)
# The collapsed set — where does it live, and does it move when an area folds?
if [ "$CMD" = "plist" ]; then
  load_session
  note "=== plist — the collapsed-area set in the group container ==="
  PL='~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist'
  note "  candidate plists:"
  lab_ssh "$IP" 'ls -1 ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/ 2>/dev/null; ls -1 ~/Library/Preferences/ 2>/dev/null | grep -i culturedcode' </dev/null 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
  note "  keys matching /collaps|expand|disclos|sidebar/i:"
  lab_ssh "$IP" "plutil -p $PL 2>/dev/null | grep -iE 'collaps|expand|disclos|sidebar'" </dev/null 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
  exit 0
fi

# ============================================================== sparse (H3)
# THE PROTOTYPE. Predict every row from the DB + measured constants, CONFIRM the
# prediction with a handful of AX reads, and compare against the full sweep.
if [ "$CMD" = "sparse" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  to_top
  note "=== sparse — the predicted read against the full sweep ==="
  M sparse > "$OUT/ax/sparse.json"
  python3 - "$OUT/ax/sparse.json" <<'PY' | tee -a "$REPORT"
import json, sys
d = json.load(open(sys.argv[1]))
if not d.get('ok'):
    print("  FAILED: %s" % d.get('why')); raise SystemExit
print("  full sweep : %7dms  calls=%-6d rows=%d" % (d['full']['ms'], d['full']['calls'], d['full']['rows']))
print("  sparse read: %7dms  calls=%-6d rows=%d  (area rows confirmed: %d)"
      % (d['sparse']['ms'], d['sparse']['calls'], d['sparse']['rows'], d['sparse']['confirmed']))
print("  speedup: %.1fx wall, %.1fx calls"
      % (d['full']['ms'] / max(1, d['sparse']['ms']), d['full']['calls'] / max(1, d['sparse']['calls'])))
print("  agreement: %s" % d['agree'])
for line in d.get('diff', [])[:20]:
    print("    %s" % line)
PY
  exit 0
fi

# ============================================================== visrows
# BOUNDED READS. Does the sidebar table expose an NSTableView-style visible-row
# window? If it does, every snapshot reads ~30 rows instead of 174 however tall
# the list is — the single biggest lever on the field host's 16s read.
if [ "$CMD" = "visrows" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  to_top
  note "=== visrows — AXVisibleRows / AXRows / AXVisibleChildren on the sidebar table ==="
  note "  --- the full sweep's own cost, and the same read bounded to visible rows ---"
  M sweepcost | tee -a "$REPORT"
  note "  --- which row kinds expose which AXImage descriptions ---"
  M imgdesc | tee -a "$REPORT"
  M visrows > "$OUT/ax/visrows.json"
  python3 - "$OUT/ax/visrows.json" <<'PY' | tee -a "$REPORT"
import json, sys
d = json.load(open(sys.argv[1]))
if not d.get('ok'):
    print("  FAILED: %s" % d.get('why')); raise SystemExit
print("  table rows=%d   rows with centre in viewport=%d   viewport=%s"
      % (d['tableRows'], d['rowsWithCentreInViewport'], d['viewport']))
print("  attribute names on the table:")
print("    %s" % ", ".join(d['attributeNames']))
for k in ('AXVisibleRows', 'AXRows', 'AXVisibleChildren'):
    v = d[k]
    if not v.get('present'):
        print("  %-18s ABSENT (%sms)" % (k, v.get('ms')))
    else:
        print("  %-18s count=%-5s %sms  frames=%s  y=[%s..%s]"
              % (k, v.get('count'), v.get('ms'), v.get('frames'), v.get('minY'), v.get('maxY')))
PY
  exit 0
fi

# ============================================================== collapseall
# THE STRATEGY CELL. (a) Does ⌥-click on a chevron collapse every sibling at
# once (the AppKit convention)? (b) Does the View menu carry a collapse-all
# item? (c) Failing both, what does the top-down click loop actually COST?
if [ "$CMD" = "collapseall" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  to_top
  note "=== collapseall — one gesture, a menu item, or a loop? ==="
  note "  --- (b) the menu bar, enumerated (looking for a collapse-all item) ---"
  M viewmenu > "$OUT/ax/viewmenu.json"
  python3 - "$OUT/ax/viewmenu.json" <<'PY' | tee -a "$REPORT"
import json, sys
d = json.load(open(sys.argv[1]))
if not d.get('ok'):
    print("  FAILED: %s" % d.get('why')); raise SystemExit
import re
pat = re.compile(r'collaps|expand|fold|disclos', re.I)
for m in d['menus']:
    hits = [i for i in m['items'] if i and pat.search(i)]
    print("  %-12s %d item(s)%s" % (m['menu'], len(m['items']), "   MATCHES: " + repr(hits) if hits else ""))
print("  View menu items: %s" % [m['items'] for m in d['menus'] if m['menu'] == 'View'])
PY
  note "  --- (a) plain click vs ⌥-click on the first area chevron ---"
  FIRST="${FIRST:-LAB-AREA-B}"
  note "    rows now: $(snapjson | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("rows",[])))')"
  note "    ⌥-click on \"$FIRST\": $(M chevclick "$FIRST" alt)"
  sleep 1
  note "    rows now: $(snapjson | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("rows",[])))')"
  note "    ⌥-click again (restore): $(M chevclick "$FIRST" alt)"
  sleep 1
  note "    rows now: $(snapjson | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("rows",[])))')"
  note "  --- (c) the top-down click loop: total AX calls and wall time ---"
  to_top
  M collapseall 30 > "$OUT/ax/collapseall.json"
  python3 - "$OUT/ax/collapseall.json" <<'PY' | tee -a "$REPORT"
import json, sys
d = json.load(open(sys.argv[1]))
if not d.get('ok'):
    print("  FAILED: %s" % d.get('why')); raise SystemExit
print("  total: %dms  %d AX calls  final rows=%d  iterations=%d"
      % (d['totalMs'], d['totalCalls'], d['finalRows'], len(d['iterations'])))
for it in d['iterations']:
    print("    %-3s %-14s %s -> %s  %s"
          % (it.get('iteration'), it.get('title', ''), it.get('rowsBefore', ''), it.get('rowsAfter', ''), it.get('why', it.get('done', ''))))
PY
  note "  --- restore: re-expand everything the loop folded ---"
  M collapseall 0 >/dev/null 2>&1 || true
  exit 0
fi

# ============================================================== expandall
# Put every area back. The disclosure state lives in the group-container prefs
# and survives a relaunch, so a campaign that collapses must expand again.
if [ "$CMD" = "expandall" ]; then
  load_session; ship_snap
  warm; setwin "${WIN_W:-935}" "${WIN_H:-980}" >/dev/null; sleep 2; activate
  note "=== expandall — re-expand every area section ==="
  for A in $(echo "$TITLES" | tr '|' ' '); do
    M seek "$A" 12 >/dev/null 2>&1
    R=$(M chevclick "$A" "")
    note "  $A -> $R"
    sleep 1
  done
  ship_snap
  note "  sidebar rows now: $(snapjson | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("rows",[])))')"
  exit 0
fi

# ============================================================== e2e
# THE ACCEPTANCE CELL. The #676 command shape verbatim, with tracing ON.
if [ "$CMD" = "e2e" ]; then
  load_session; ship_snap
  SUBJ="${SUBJ:-Alpha}"
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  to_top
  note "=== e2e — \"$SUBJ\" --end across the tall wall (#676 command shape) ==="
  # THE GATE PROOF (2026-09-02 ruling): the same command with the opt-in OFF
  # must refuse, name the reason, and drive nothing.
  G config set experimental-area-reorder false >/dev/null 2>&1
  note "  --- gate OFF: the command must refuse and drive nothing ---"
  GATE_BEFORE=$(area_order)
  G reorder "$SUBJ" --end --dangerously-drive-gui --json > "$OUT/e2e-gated.json" 2>&1
  head -c 1400 "$OUT/e2e-gated.json" | tee -a "$REPORT"; echo | tee -a "$REPORT"
  note "  order unchanged while gated? $([ "$GATE_BEFORE" = "$(area_order)" ] && echo PASS || echo FAIL)"
  G config set experimental-area-reorder true >/dev/null 2>&1
  note "  --- gate ON: the drive proceeds ---"
  census "e2e-pre" >/dev/null
  note "  --- PRE-DRIVE census ---"; sed 's/^/    /' "$OUT/census-e2e-pre.txt" | tee -a "$REPORT"
  BEFORE_ORDER=$(area_order); BEFORE_DIG=$(assign_digest); BEFORE_N=$(areacount)
  note "  before: $BEFORE_ORDER"
  lab_ssh "$IP" 'rm -rf ~/.local/state/things-api/trace' </dev/null 2>/dev/null
  T0=$(date +%s)
  G reorder "$SUBJ" --end --dangerously-drive-gui --verify-timeout 120000 --json > "$OUT/e2e.json" 2>&1
  T1=$(date +%s)
  note "  wall clock: $((T1-T0))s"
  head -c 6000 "$OUT/e2e.json" | tee -a "$REPORT"; echo | tee -a "$REPORT"
  note "  --- the trace's ui-dispatch + chevron records ---"
  lab_ssh "$IP" 'cat ~/.local/state/things-api/trace/*.jsonl 2>/dev/null' </dev/null > "$OUT/e2e-trace.jsonl" 2>/dev/null
  python3 - "$OUT/e2e-trace.jsonl" <<'PY' | tee -a "$REPORT"
import json, sys
try:
    lines = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
except Exception as e:
    print("  no trace: %s" % e); raise SystemExit
for r in lines:
    ph = r.get('phase')
    if ph == 'ui-dispatch' and r.get('event') == 'end':
        print("    %-18s %6sms ok=%-5s timedOut=%s" % (r.get('primitive'), r.get('durationMs'), r.get('ok'), r.get('timedOut')))
    elif ph == 'sidebar-snapshot':
        print("      snapshot rows=%s depth=%s matched=%s/%s scroll=%s budget=%sms"
              % (r.get('rows'), r.get('depth'), r.get('matched'), r.get('expected'), r.get('scroll'), r.get('budgetMs')))
    elif ph == 'sidebar-chevron-steps':
        print("      chevron want=%s reason=%s clicked=%s budget=%sms rows=%s"
              % (r.get('want'), r.get('reason'), r.get('clicked'), r.get('budgetMs'), r.get('rows')))
        for s in r.get('steps', []):
            print("         %-16s %6sms ok=%-5s %s %s"
                  % (s.get('step'), s.get('durationMs'), s.get('ok'), s.get('scriptStage', ''), s.get('ms', '')))
    elif ph == 'sidebar-sparse':
        print("      sparse %s calls=%s ms=%s why=%s" % (r.get('used'), r.get('calls'), r.get('ms'), r.get('why')))
PY
  AFTER_ORDER=$(area_order)
  note "  after:  $AFTER_ORDER"
  note "  area count invariant:  $([ "$BEFORE_N" = "$(areacount)" ] && echo PASS || echo FAIL)"
  note "  assignments invariant: $([ "$BEFORE_DIG" = "$(assign_digest)" ] && echo PASS || echo FAIL)"
  LAST=$(gq 'SELECT title FROM TMArea ORDER BY "index" DESC, uuid DESC LIMIT 1')
  note "  last area is now: [$LAST]  — placement reached? $([ "$LAST" = "$SUBJ" ] && echo YES || echo no)"
  sleep 2
  census "e2e-post" >/dev/null
  note "  --- POST-DRIVE census ---"; sed 's/^/    /' "$OUT/census-e2e-post.txt" | tee -a "$REPORT"
  note "  disclosure state restored (section ROW COUNTS match pre-drive)? $(
    diff <(awk 'NR>1{print $1, $4}' "$OUT/census-e2e-pre.txt" | sort) <(awk 'NR>1{print $1, $4}' "$OUT/census-e2e-post.txt" | sort) >/dev/null \
      && echo 'YES' || echo 'NO — see the two censuses')"
  exit 0
fi

# ============================================================== cert
# SBCOL1 / SBRES1 / SBSCR1 controls re-run under the new budgets.
if [ "$CMD" = "cert" ]; then
  load_session; ship_snap
  SUBJ="${SUBJ:-Gamma}"; ANCHOR="${ANCHOR:-Alpha}"
  warm; setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2; activate
  note "=== cert — SBRES1/SBSCR1/SBCOL1 controls under the new budgets ==="
  to_top
  note "  SBRES1 control (semantic resolution, wide window):"
  setwin 1200 420 >/dev/null; sleep 2
  note "    $(M state)"
  setwin "${WIN_W:-935}" "${WIN_H:-420}" >/dev/null; sleep 2
  note "  SBSCR1 control (pointerless scrollbar, pointer parked at 5,5):"
  note "    $(M park 5 5)"
  note "    $(M setbar 0.5)"
  to_top
  census "cert-pre" >/dev/null
  note "  --- PRE census ---"; sed 's/^/    /' "$OUT/census-cert-pre.txt" | tee -a "$REPORT"
  BEFORE_ORDER=$(area_order); BEFORE_DIG=$(assign_digest); BEFORE_N=$(areacount)
  note "  before: $BEFORE_ORDER"
  T0=$(date +%s)
  G area reorder "$SUBJ" --before "$ANCHOR" --dangerously-drive-gui --json > "$OUT/cert.json" 2>&1
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
usage: TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-sbchv1.sh <cmd>
  setup      clone golden-v4 + airgap + clock pin + helpers + shipped bundle
  seed       the #676 sidebar shape (12 areas, one 63-project wall)
  shape      confirm the fixture reproduces the field geometry
  latency    per-AX-call cost on this host (the field probe's lab twin)
  chevcost   H1/H2 — where the disclosure step's time goes; both row matchers
  rowkinds   H3 — which rows render, and whether heights are constant per kind
  plist      H3 — the collapsed-area set in the group container
  sparse     H3 — the predicted read against the full sweep
  e2e        the #676 command shape verbatim, with the trace read back
  cert       SBRES1/SBSCR1/SBCOL1 controls under the new budgets
  reship     rebuild + redeploy dist + helpers
  teardown   destroy the clone
USAGE
exit 2
