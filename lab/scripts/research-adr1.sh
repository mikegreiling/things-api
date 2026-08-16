#!/bin/bash
# ADR1 — add-repeating silently fails because the Repeat dialog never appears (issue #480).
#
# The report (from Things 3.22.14): `todo add-repeating "<t>" --area … --tag …
# --when … --reminder … --frequency weekly --interval 2 --weekdays wednesday
# --dangerously-drive-gui` completes "reveal → foreground → Items ▸ Repeat…" then
# times out waiting for the Repeat dialog; exit verify-failed:silent-noop; the
# seeded to-do remains as residue; and the reported source uuid was "not reachable
# through todo delete".
#
# LEADING HYPOTHESIS 1: a DISABLED-menu press masking a selection failure. An AX
# press on a disabled `Items ▸ Repeat…` "succeeds" while doing nothing; the item
# is disabled when no eligible row is selected. The repro combines seed variables
# our certs never combined (area + tag + when + reminder). If `things:///show?id=`
# lands on a surface where the row is not actually selected, the press no-ops and
# the dialog never appears → silent-noop.
#
# PHASE 0 (this script) — repro MATRIX under golden-v2 / 3.22.12. Cells, each
# adding one variable to the known-good `--when`-only control:
#   bare(when-only) · +area · +tag · +area+tag · +reminder · full(issue combo)
# For EACH cell we capture, via a MANUAL selection probe on a plain seed with the
# same add-vocabulary (isolating reveal/selection from the repeating drive):
#   - id/name of `selected to dos` after `things:///show?id=<uuid>` (is the row
#     ACTUALLY selected, and is it OUR row?)
#   - `Items ▸ Repeat…` AXEnabled state (menu opened so NSMenuValidation runs)
#   - the surface the reveal landed on (main-window title)
# Then we run the PRODUCTION add-repeating for the cell and record its verdict +
# whether a repeating template row appeared in the DB.
# STOP RULE: if ALL cells PASS under 3.22.12, this is a 3.22.14 behavior change —
# record the matrix and STOP (maintainer owns the golden decision).
#
# METHOD: ONE disposable clone `adr1-lab` of things-lab-golden-v2 (golden
# untouched). golden-v2 carries the baked L3-accessibility grant, so the ui vector
# and the AX probes drive over SSH via System Events — NO VNC. Airgap (default
# route deleted, ping fails); pin clock 2026-07-05 12:00 (Sunday) before Things
# launches (so --when 2026-08-26 lands in Upcoming, matching the report). Ship the
# PRODUCTION e2e bundle. Fixtures fully synthetic (ADR1-* titles). Ground truth =
# read-only guest SQLite. Teardown at the end (single-VM courtesy).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="adr1-lab"
OUT="lab/artifacts/adr1-lab"; mkdir -p "$OUT/snaps" "$OUT/ax" "$OUT/drive" "$OUT/sel"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[adr1] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"

# ---------------- preflight ----------------
FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB"
[ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free. Abort."; exit 1; }

# self-contained node (avoid a homebrew-linked node)
MAIN_WT=$(dirname "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null || true)
NODE_VER=$(awk '/nodejs/{print $2}' "$MAIN_WT/.tool-versions" .tool-versions "$HOME/.tool-versions" 2>/dev/null | head -1 || true)
CANDS=("$HOME/.asdf/installs/nodejs/$NODE_VER/bin")
CANDS+=( $(ls -d "$HOME"/.asdf/installs/nodejs/*/bin 2>/dev/null | sort -t/ -k7 -V -r) )
CANDS+=(/opt/homebrew/bin)
for cand in "${CANDS[@]}"; do
  [ -x "$cand/node" ] || continue
  otool -L "$cand/node" 2>/dev/null | grep -q '/opt/homebrew/' && continue
  export PATH="$cand:$PATH"; break
done
node --version >/dev/null 2>&1 || { note "FATAL: no working node on PATH"; exit 1; }
note "toolchain: node $(node --version) @ $(command -v node)"
if [ ! -d node_modules/commander ]; then
  note "npm ci (worktree has no node_modules)…"
  npm ci >"$OUT/npm-ci.log" 2>&1 || { note "FATAL: npm ci failed (see npm-ci.log)."; exit 1; }
fi

# ---------------- clone + boot (no VNC — golden-v2 AX baked) ----------------
note "cloning things-lab-golden-v2 -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone things-lab-golden-v2 "$VM"
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
note "airgap: $AG"
[ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "AX grant=$GRANT (want 2)"
[ "$GRANT" = "2" ] || { note "FATAL: AX grant missing"; exit 1; }

# ---------------- guest helpers ----------------
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# selection + menu-enabled probe: reveal a uuid, read selected-to-dos id/name,
# open Items menu so NSMenuValidation runs, read Repeat… enabled, then Escape.
lab_ssh "$IP" 'cat > ~/labh/selprobe.sh && chmod +x ~/labh/selprobe.sh' <<'EOF'
#!/bin/bash
UUID="$1"
open "things:///show?id=$UUID"
sleep 4
osascript <<OSA
set selIds to "-"
set selNames to "-"
tell application "Things3"
  try
    set selIds to (id of selected to dos) as text
  end try
  try
    set selNames to (name of selected to dos) as text
  end try
end tell
set winTitle to "-"
set repExists to "-"
set repEnabledClosed to "-"
set repEnabledOpen to "-"
tell application "System Events" to tell process "Things3"
  try
    set winTitle to (title of (first window whose subrole is "AXStandardWindow"))
  end try
  try
    set repExists to (exists menu item "Repeat…" of menu "Items" of menu bar 1) as text
  end try
  try
    set repEnabledClosed to (enabled of menu item "Repeat…" of menu "Items" of menu bar 1) as text
  end try
  try
    click menu bar item "Items" of menu bar 1
    delay 0.4
    set repEnabledOpen to (enabled of menu item "Repeat…" of menu "Items" of menu bar 1) as text
    key code 53
  end try
end tell
return "selIds=[" & selIds & "] selNames=[" & selNames & "] win=[" & winTitle & "] Repeat…{exists=" & repExists & " enabledClosed=" & repEnabledClosed & " enabledOpen=" & repEnabledOpen & "}"
OSA
EOF
selprobe() { lab_ssh "$IP" "~/labh/selprobe.sh $1" </dev/null | tee "$OUT/sel/$2.txt" | sed "s/^/    [sel:$2] /" | tee -a "$REPORT"; }

note "guest helpers installed (~/labh: gsql.sh selprobe.sh)"

# ---------------- build + ship bundle ----------------
note "build + ship production bundle (main HEAD — pre-fix, for Phase 0)"
npm run build >"$OUT/build.log" 2>&1 || { note "FATAL build (see build.log)"; exit 1; }
[ -f dist/cli/main.js ] || { note "FATAL: dist/cli/main.js missing"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
lab_ssh "$IP" '~/things-lab/bin/node --version' </dev/null >/dev/null 2>&1 || { note "FATAL: guest node broken"; exit 1; }
drive() {
  local label="$1"; shift
  lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $* ; echo EXIT=\$?" </dev/null > "$OUT/drive/$label.log" 2>&1
  { grep -m1 '"status": *"ok"\|"ok"' "$OUT/drive/$label.log" || grep -m1 'verify-failed\|unsupported\|blocked\|"error"\|error:' "$OUT/drive/$label.log" || echo '(no verdict line — see drive log)'; } | sed "s/^/  [$label] /" | tee -a "$REPORT"
  grep -m1 'EXIT=' "$OUT/drive/$label.log" | sed "s/^/  [$label] /" | tee -a "$REPORT"
}
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
G config set ui-enabled true >/dev/null 2>&1
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
MVER=$(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)
note "bundle shipped; ui-enabled=true; Things $TVER / macOS $MVER / DB v26 / clock 2026-07-05"

warm()   { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }

# a repeating-template existence check by title (type=0, has rule, not trashed, not an instance)
tpl_uuid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_recurrenceRule IS NOT NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
# a plain (non-template) row by title
plain_uuid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
# residue check: any non-trashed non-template row with the title after a failed drive
residue_uuid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_recurrenceRule IS NULL AND trashed=0 LIMIT 1"; }

RULE="--frequency weekly --interval 2 --weekdays wednesday --when 2026-08-26 --dangerously-drive-gui --json"

# =====================================================================
# PHASE 0-pre — behavior when the area/tag DON'T exist yet (filer env unknown)
# =====================================================================
note ""; note "############### PHASE 0-pre: area/tag MISSING ###############"
warm
note "-- add-repeating referencing a NON-existent area + tag (before creating them) --"
drive PRE_missing todo add-repeating \"ADR1 pre missing\" --area \"Synthetic Area\" --tag recurring $RULE
settle
note "  DB template for 'ADR1 pre missing': $(tpl_uuid 'ADR1 pre missing' | tr -d '\n') (empty = none)"
note "  DB residue   for 'ADR1 pre missing': $(residue_uuid 'ADR1 pre missing' | tr -d '\n') (empty = none)"

# =====================================================================
# SETUP — create the synthetic area + tag the matrix needs
# =====================================================================
note ""; note "############### SETUP: create Synthetic Area + recurring tag ###############"
drive S_area  area add \"Synthetic Area\" --json
drive S_tag   tag add recurring --json
settle
AREA=$(gq "SELECT uuid FROM TMArea WHERE title='Synthetic Area' LIMIT 1")
TAG=$(gq "SELECT uuid FROM TMTag WHERE title='recurring' LIMIT 1")
note "  area uuid=$AREA  tag uuid=$TAG"
[ -n "$AREA" ] || note "  WARNING: area not created — +area cells will block at create leg"
[ -n "$TAG" ]  || note "  WARNING: tag not created — +tag cells will block at create leg"

# =====================================================================
# The matrix runner: for a cell, (1) manual selection/menu probe on a plain seed
# with the same add-vocabulary, (2) production add-repeating, (3) DB verdict.
# =====================================================================
# cell <name> <add-vocabulary flags...>
cell() {
  local name="$1"; shift
  local addflags="$*"
  local probeTitle="ADR1 probe $name"
  local repTitle="ADR1 $name"
  note ""; note "===== CELL: $name  (add-vocabulary: ${addflags:-<none>}) ====="

  # (1) manual selection probe: seed a PLAIN to-do with the same add-vocabulary,
  #     reveal it, read selection + Repeat… enabled.
  warm
  drive "probe_${name}_seed" todo add \"$probeTitle\" $addflags --json
  settle
  local puid; puid=$(plain_uuid "$probeTitle")
  note "  probe seed uuid=$puid"
  if [ -n "$puid" ]; then
    warm
    selprobe "$puid" "$name"
    settle
  else
    note "    [sel:$name] (seed not created — create leg blocked; see drive/probe_${name}_seed.log)"
  fi

  # (2) production add-repeating for the cell.
  warm
  drive "cell_${name}" todo add-repeating \"$repTitle\" $addflags $RULE
  settle

  # (3) DB verdict.
  local tuid ruid
  tuid=$(tpl_uuid "$repTitle")
  ruid=$(residue_uuid "$repTitle")
  if [ -n "$tuid" ]; then
    note "  VERDICT $name: PASS — repeating template created (uuid=$tuid)"
    note "    first-occurrence rt1_instanceCreationStartDate: $(gq "SELECT rt1_instanceCreationStartDate FROM TMTask WHERE uuid='$tuid'" | tr -d '\n')"
  else
    note "  VERDICT $name: FAIL — no repeating template. residue(plain,non-trashed)=${ruid:-<none>}"
    # residue reachability: can `todo delete <residue>` reach it? (the #480 2nd bug)
    if [ -n "$ruid" ]; then
      drive "cell_${name}_delresidue" todo delete "$ruid" --json
    fi
  fi
}

# =====================================================================
# PHASE 0 — the matrix
# =====================================================================
note ""; note "############### PHASE 0: repro matrix ###############"
cell bare
cell area      --area \"Synthetic Area\"
cell tag       --tag recurring
cell areatag   --area \"Synthetic Area\" --tag recurring
cell reminder  --reminder 18:00
cell full      --area \"Synthetic Area\" --tag recurring --reminder 18:00 --notes \"Synthetic reference note\"

# =====================================================================
note ""; note "############### ADR1 PHASE 0 COMPLETE ###############"
note "env: Things $TVER / macOS $MVER / DB v26 / golden-v2 / clock 2026-07-05"
note "area=$AREA tag=$TAG"
note "artifacts under $OUT (report.txt, drive/*.log, sel/*.txt)"
note "MATRIX SUMMARY (grep VERDICT):"
grep 'VERDICT' "$REPORT" | sed 's/^/  /'
