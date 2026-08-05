#!/bin/bash
# HEADSORT — can heading `index` be reordered across the full heading lifecycle
# (open / archived-UNSWEPT / archived-SWEPT) mutating ONLY `index`?
# Write-up: docs/lab/headsort-heading-lifecycle-reorder.md.
#
# Maintainer GUI ground truth (2026-08-05, to CONFIRM under the harness):
#   * archived-UNSWEPT headings ARE drag-sortable in the GUI body;
#   * swept (logbook) headings retain their `index`; restoring re-enters the body
#     at the retained position (no index re-derivation);
#   * OPEN: can the private reorder verb reposition SWEPT-archived headings (not
#     GUI-exposed), and can a MIXED set (open + unswept + swept) reorder in one wire?
#
# The private reorder verb (undocumented sdef command, gated in the engine behind
# allow-experimental + the sdef canary; probed here RAW):
#   tell application "Things3" to _private_experimental_ reorder to dos in \
#       project id "<PROJ>" with ids "h1,h2,h3"
# WIRE LAW: ids are ONE comma-joined STRING. A multi-item AppleScript LIST literal
# ({"a","b"}) throws -1700 at the AppleEvent boundary and the app never runs the
# command. This script NEVER uses list literals and NEVER swallows the osascript
# exit code — every reorder captures EXIT=<code> so a -1700 (wire-never-ran) is
# distinguishable from an app silent no-op (wire ran, refused the class).
#
# Sweep boundary (src/read/log-boundary.ts): there is NO per-row swept bit. An
# item is SWEPT iff status closed AND stopDate <= logBoundary. golden default
# logInterval=0 (Immediately) => boundary=now => every completion is swept at
# once. To manufacture an UNSWEPT completed heading we set logInterval=4
# (Manually) via the Settings popup (System Events AX — golden-v2 has the L3
# grant baked), which pins boundary=manualLogDate; a completion after that sits
# UNSWEPT, and an AppleScript `log completed now` advances manualLogDate to sweep
# whichever completions precede it (PLOG1 / LOGNOW).
#
# ONE disposable clone of things-lab-golden-v2 (Things 3.22.12), pinned clock
# 2026-07-05 12:00. VM lifecycle is owned by the CALLER (tart clone + a tracked
# background `tart run`); this script only drives an already-booted guest.
# Subcommands (run in order; session.env carries IP+TOKEN across calls):
#   setup       airgap + clock-pin + warm-up + token + gsql + seed both projects
#   base        H-BASE   reorder 4 OPEN headings (control)
#   loginterval set logInterval=4 (Manually) via System Events AX; verify
#   archive     build the P-LIFE lifecycle: sweep Ls*, keep Lu* unswept, Lo* open
#   unswept     H-UNSWEPT mixed wire open+unswept
#   swept       H-SWEPT(a) swept-only wire
#   mixed       H-SWEPT(b)/MIXED full permutation moving every class
#   restore     H-RESTORE unarchive a moved swept heading; index retained?
#   dump        final full dump + crash/version + copy DB out
#   teardown    (no-op here; caller owns the VM)
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-headsort-lab}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[headsort] $*" | tee -a "$REPORT"; }
CMD="${1:-}"

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }
gq()  { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gsql(){ lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" </dev/null; }
gas() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" </dev/null || true; }
gurl(){ lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; sleep 2; }
uuid_of() { local t="$1" typ="${2:-}" w u i; w="title='$t' AND trashed=0"; [ -n "$typ" ] && w="$w AND type=$typ"
  for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }
pid_of() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND trashed=0"; }

# The private reorder verb, ids = ONE comma-joined string. Captures EXIT=<code>
# (guest-side osascript exit) so -1700 (wire never ran) is distinguished from a
# silent no-op. NO `|| true`, NO list literals.
reord() { # $1 project-uuid  $2 comma-ids
  local script="tell application \"Things3\" to _private_experimental_ reorder to dos in project id \"$1\" with ids \"$2\""
  lab_ssh "$IP" "osascript -e $(printf '%q' "$script") >/tmp/reord.out 2>&1; echo \"EXIT=\$?\"; cat /tmp/reord.out" </dev/null
  sleep 2
}

# Full per-row snapshot of a project's headings + their children, ordered by
# (type DESC, index). Captures status/index/stopDate/trashed/heading-FK/project-FK/umd.
dump() { # $1 project title
  local p; p=$(pid_of "$1")
  gq "SELECT type||'|'||title||'|st='||status||'|idx='||\"index\"||'|stop='||COALESCE(printf('%.3f',stopDate),'-')||'|tr='||trashed||'|h='||COALESCE(substr(heading,1,8),'-')||'|p='||COALESCE(substr(project,1,8),'-')||'|umd='||printf('%.4f',userModificationDate) FROM TMTask WHERE (project='$p' OR heading IN (SELECT uuid FROM TMTask WHERE project='$p' AND type=2)) AND trashed=0 ORDER BY type DESC, \"index\""
}
# headings only, index order, terse (title idx=.. st=.. stop=..)
heads() { # $1 project title
  local p; p=$(pid_of "$1")
  gq "SELECT title||' idx='||\"index\"||' st='||status||' stop='||COALESCE(printf('%.2f',stopDate),'-')||' umd='||printf('%.3f',userModificationDate) FROM TMTask WHERE project='$p' AND type=2 AND trashed=0 ORDER BY \"index\""
}
boundary() { gq "SELECT 'logInterval='||logInterval||' manualLogDate='||COALESCE(printf('%.2f',manualLogDate),'NULL')||' now='||strftime('%s','now') FROM TMSettings LIMIT 1"; }

tjson() {
  local url
  url=$(lab_ssh "$IP" "python3 -c 'import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))' $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null)
  lab_ssh "$IP" "open -g $(printf '%q' "$url")" </dev/null; sleep 3
}

# ============================================================ setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
  note "ssh up at $IP (VM $VM)"
  echo "IP=$IP" > "$SESSION"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo route -n delete -inet6 default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null; date' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"

  note "warm-up: launch/quit/relaunch Things on the pinned date"
  lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3' </dev/null
  lab_ssh "$IP" 'open -g -a Things3; sleep 8' </dev/null
  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  echo "TOKEN=$TOKEN" >> "$SESSION"
  note "token in hand (${#TOKEN} chars)"
  AREA_A=$(gq "SELECT uuid FROM TMArea WHERE title='LAB-AREA-A'")
  note "LAB-AREA-A=$AREA_A"

  # P-BASE: 4 OPEN headings, each 2 children (control for H-BASE).
  note "seed HSORT-BASE: 4 open headings HB1..HB4, each 2 children"
  tjson '[{"type":"project","attributes":{"title":"HSORT-BASE","area-id":"'"$AREA_A"'","items":[
    {"type":"heading","attributes":{"title":"HB1"}},{"type":"to-do","attributes":{"title":"HB1-c1"}},{"type":"to-do","attributes":{"title":"HB1-c2"}},
    {"type":"heading","attributes":{"title":"HB2"}},{"type":"to-do","attributes":{"title":"HB2-c1"}},{"type":"to-do","attributes":{"title":"HB2-c2"}},
    {"type":"heading","attributes":{"title":"HB3"}},{"type":"to-do","attributes":{"title":"HB3-c1"}},{"type":"to-do","attributes":{"title":"HB3-c2"}},
    {"type":"heading","attributes":{"title":"HB4"}},{"type":"to-do","attributes":{"title":"HB4-c1"}},{"type":"to-do","attributes":{"title":"HB4-c2"}}]}}]'

  # P-LIFE: 6 headings (2 open Lo, 2 to-be-unswept Lu, 2 to-be-swept Ls), each 2
  # children. Seeded interleaved so initial index mixes the classes.
  note "seed HSORT-LIFE: Lo1,Lu1,Ls1,Lo2,Lu2,Ls2 (interleaved), each 2 children"
  tjson '[{"type":"project","attributes":{"title":"HSORT-LIFE","area-id":"'"$AREA_A"'","items":[
    {"type":"heading","attributes":{"title":"Lo1"}},{"type":"to-do","attributes":{"title":"Lo1-c1"}},{"type":"to-do","attributes":{"title":"Lo1-c2"}},
    {"type":"heading","attributes":{"title":"Lu1"}},{"type":"to-do","attributes":{"title":"Lu1-c1"}},{"type":"to-do","attributes":{"title":"Lu1-c2"}},
    {"type":"heading","attributes":{"title":"Ls1"}},{"type":"to-do","attributes":{"title":"Ls1-c1"}},{"type":"to-do","attributes":{"title":"Ls1-c2"}},
    {"type":"heading","attributes":{"title":"Lo2"}},{"type":"to-do","attributes":{"title":"Lo2-c1"}},{"type":"to-do","attributes":{"title":"Lo2-c2"}},
    {"type":"heading","attributes":{"title":"Lu2"}},{"type":"to-do","attributes":{"title":"Lu2-c1"}},{"type":"to-do","attributes":{"title":"Lu2-c2"}},
    {"type":"heading","attributes":{"title":"Ls2"}},{"type":"to-do","attributes":{"title":"Ls2-c1"}},{"type":"to-do","attributes":{"title":"Ls2-c2"}}]}}]'
  sleep 2
  note "--- seed verification ---"
  note "BASE headings: $(heads HSORT-BASE | tr '\n' ' ')"
  note "LIFE headings: $(heads HSORT-LIFE | tr '\n' ' ')"
  note "BASE full:"; dump HSORT-BASE | tee -a "$REPORT"
  note "LIFE full:"; dump HSORT-LIFE | tee -a "$REPORT"
  note "sweep state: $(boundary)"
  note "setup DONE"
  exit 0
fi

# ============================================================ base (H-BASE control)
if [ "$CMD" = "base" ]; then
  load_session
  note "################## H-BASE — reorder 4 OPEN headings (control) ##################"
  BP=$(pid_of HSORT-BASE)
  H1=$(gq "SELECT uuid FROM TMTask WHERE title='HB1' AND type=2 AND trashed=0")
  H2=$(gq "SELECT uuid FROM TMTask WHERE title='HB2' AND type=2 AND trashed=0")
  H3=$(gq "SELECT uuid FROM TMTask WHERE title='HB3' AND type=2 AND trashed=0")
  H4=$(gq "SELECT uuid FROM TMTask WHERE title='HB4' AND type=2 AND trashed=0")
  note "  HSORT-BASE=$BP  HB1=$H1 HB2=$H2 HB3=$H3 HB4=$H4"
  note "  BEFORE:"; dump HSORT-BASE | tee -a "$REPORT"
  note "  ---- reorder wire (full, target HB3,HB1,HB4,HB2) ----"
  note "  $(reord "$BP" "$H3,$H1,$H4,$H2")"
  note "  AFTER (expect index order HB3<HB1<HB4<HB2, index-only, children FK+idx intact):"; dump HSORT-BASE | tee -a "$REPORT"
  exit 0
fi

# ============================================================ loginterval (AX)
if [ "$CMD" = "loginterval" ]; then
  load_session
  note "################## set logInterval=4 (Manually) via System Events AX ##################"
  note "  before: $(boundary)"
  lab_ssh "$IP" 'open -a Things3; sleep 3' </dev/null
  lab_ssh "$IP" "cat > /tmp/setlog.scpt" <<'AS'
tell application "Things3" to activate
delay 1.5
tell application "System Events"
  tell process "Things3"
    set frontmost to true
    delay 0.5
    keystroke "," using command down
    delay 2.5
    -- the Settings window is named after the selected tab ("General"); ensure it
    try
      click button "General" of toolbar 1 of window "General"
    end try
    delay 0.8
    set report to ""
    -- the "Move completed items to Logbook" popup is the one whose value is a log
    -- interval option; golden default = "Immediately". Options are ONLY
    -- Immediately / Daily / When-I-choose (2x down from Immediately = Manually=4).
    set w to window "General"
    repeat with pb in (UI elements of w)
      if (role of pb) is "AXPopUpButton" then
        set v to ""
        try
          set v to (value of pb) as string
        end try
        if v is "Immediately" then
          set report to "found-log-popup value=[" & v & "]"
          click pb
          delay 0.9
          key code 125
          delay 0.3
          key code 125
          delay 0.3
          key code 36
          delay 0.8
          set report to report & "<2down+return>"
          exit repeat
        end if
      end if
    end repeat
    delay 0.5
    try
      keystroke "w" using command down
    end try
    return report
  end tell
end tell
AS
  note "  AX result: $(lab_ssh "$IP" 'osascript /tmp/setlog.scpt 2>&1' </dev/null)"
  sleep 2
  note "  after: $(boundary)"
  note "  (verify logInterval=4; if still 0 the AX flip failed — unswept/mixed classes blocked)"
  exit 0
fi

# ============================================================ archive (build lifecycle)
if [ "$CMD" = "archive" ]; then
  load_session
  note "################## build P-LIFE lifecycle (sweep Ls*, keep Lu* unswept, Lo* open) ##################"
  archive_h() { gas "tell application \"Things3\" to set status of to do id \"$1\" to completed"; sleep 1; }
  LS1=$(gq "SELECT uuid FROM TMTask WHERE title='Ls1' AND type=2 AND trashed=0")
  LS2=$(gq "SELECT uuid FROM TMTask WHERE title='Ls2' AND type=2 AND trashed=0")
  LU1=$(gq "SELECT uuid FROM TMTask WHERE title='Lu1' AND type=2 AND trashed=0")
  LU2=$(gq "SELECT uuid FROM TMTask WHERE title='Lu2' AND type=2 AND trashed=0")
  note "  Ls1=$LS1 Ls2=$LS2 Lu1=$LU1 Lu2=$LU2"
  note "  -- complete Ls1,Ls2 (to be SWEPT) --"; archive_h "$LS1"; archive_h "$LS2"
  note "  state after completing Ls*: $(heads HSORT-LIFE | tr '\n' ' ')"
  note "  -- log completed now (advance manualLogDate past Ls* stopDate => Ls* SWEPT) --"
  gas "tell application \"Things3\" to log completed now"; sleep 2
  note "  boundary after log-now: $(boundary)"
  note "  -- complete Lu1,Lu2 AFTER the sweep (stopDate > boundary => UNSWEPT) --"; archive_h "$LU1"; archive_h "$LU2"
  note "  boundary final: $(boundary)"
  note "  LIFE headings (idx/st/stop):"; heads HSORT-LIFE | tee -a "$REPORT"
  note "  LIFE full:"; dump HSORT-LIFE | tee -a "$REPORT"
  note "  classification: Ls* SWEPT iff stop<=manualLogDate; Lu* UNSWEPT iff stop>manualLogDate; Lo* open"
  exit 0
fi

# ============================================================ unswept (H-UNSWEPT)
if [ "$CMD" = "unswept" ]; then
  load_session
  note "################## H-UNSWEPT — mixed wire OPEN + UNSWEPT-archived ##################"
  LP=$(pid_of HSORT-LIFE)
  LO1=$(gq "SELECT uuid FROM TMTask WHERE title='Lo1' AND type=2 AND trashed=0")
  LO2=$(gq "SELECT uuid FROM TMTask WHERE title='Lo2' AND type=2 AND trashed=0")
  LU1=$(gq "SELECT uuid FROM TMTask WHERE title='Lu1' AND type=2 AND trashed=0")
  LU2=$(gq "SELECT uuid FROM TMTask WHERE title='Lu2' AND type=2 AND trashed=0")
  note "  BEFORE:"; dump HSORT-LIFE | tee -a "$REPORT"
  note "  ---- reorder wire (open+unswept, target Lu1,Lo1,Lu2,Lo2) ----"
  note "  $(reord "$LP" "$LU1,$LO1,$LU2,$LO2")"
  note "  AFTER (accepted? order honored? index-only? status/stop of Lu* untouched?):"; dump HSORT-LIFE | tee -a "$REPORT"
  exit 0
fi

# ============================================================ swept (H-SWEPT a)
if [ "$CMD" = "swept" ]; then
  load_session
  note "################## H-SWEPT(a) — swept-ONLY wire ##################"
  LP=$(pid_of HSORT-LIFE)
  LS1=$(gq "SELECT uuid FROM TMTask WHERE title='Ls1' AND type=2 AND trashed=0")
  LS2=$(gq "SELECT uuid FROM TMTask WHERE title='Ls2' AND type=2 AND trashed=0")
  note "  Ls1=$LS1 Ls2=$LS2"
  note "  BEFORE:"; dump HSORT-LIFE | tee -a "$REPORT"
  note "  ---- reorder wire (swept-only, target Ls2,Ls1 — swap the two swept headings) ----"
  note "  $(reord "$LP" "$LS2,$LS1")"
  note "  AFTER (swept ids accepted? their index swapped? others untouched? index-only?):"; dump HSORT-LIFE | tee -a "$REPORT"
  exit 0
fi

# ============================================================ mixed (H-SWEPT b / MIXED)
if [ "$CMD" = "mixed" ]; then
  load_session
  note "################## H-SWEPT(b)/MIXED — full permutation moving every class ##################"
  LP=$(pid_of HSORT-LIFE)
  LO1=$(gq "SELECT uuid FROM TMTask WHERE title='Lo1' AND type=2 AND trashed=0")
  LO2=$(gq "SELECT uuid FROM TMTask WHERE title='Lo2' AND type=2 AND trashed=0")
  LU1=$(gq "SELECT uuid FROM TMTask WHERE title='Lu1' AND type=2 AND trashed=0")
  LU2=$(gq "SELECT uuid FROM TMTask WHERE title='Lu2' AND type=2 AND trashed=0")
  LS1=$(gq "SELECT uuid FROM TMTask WHERE title='Ls1' AND type=2 AND trashed=0")
  LS2=$(gq "SELECT uuid FROM TMTask WHERE title='Ls2' AND type=2 AND trashed=0")
  note "  BEFORE:"; dump HSORT-LIFE | tee -a "$REPORT"
  note "  ---- full 6-id wire, target Ls1,Lo2,Lu1,Ls2,Lo1,Lu2 (every class moves) ----"
  note "  $(reord "$LP" "$LS1,$LO2,$LU1,$LS2,$LO1,$LU2")"
  note "  AFTER (exact order? each class repositioned? index-only? children intact?):"; dump HSORT-LIFE | tee -a "$REPORT"
  exit 0
fi

# ============================================================ restore (H-RESTORE)
if [ "$CMD" = "restore" ]; then
  load_session
  note "################## H-RESTORE — a freshly-SWEPT heading unarchived retains its index ##################"
  note "  (the reorder verb itself reopens archived headings at their MOVED index — H-UNSWEPT/"
  note "   SWEPT/MIXED — so a swept heading MOVED by the verb already re-enters the body at the"
  note "   new position. This probe isolates the PURE unarchive: re-archive+sweep one heading, then"
  note "   set-status-open, confirming unarchive is index-SILENT — re-enters at the retained index.)"
  T=$(gq "SELECT uuid FROM TMTask WHERE title='Lu2' AND type=2 AND trashed=0")
  note "  target Lu2=$T (currently open at its post-MIXED index)"
  note "  Lu2 row (pre-archive): $(gq "SELECT 'idx='||\"index\"||' st='||status||' stop='||COALESCE(printf('%.3f',stopDate),'-')||' umd='||printf('%.4f',userModificationDate) FROM TMTask WHERE uuid='$T'")"
  note "  -- archive Lu2 (complete) then log completed now (SWEEP it) --"
  gas "tell application \"Things3\" to set status of to do id \"$T\" to completed"; sleep 1
  gas "tell application \"Things3\" to log completed now"; sleep 2
  note "  boundary: $(boundary)"
  note "  Lu2 row (swept, index should be UNCHANGED by archive+sweep): $(gq "SELECT 'idx='||\"index\"||' st='||status||' stop='||COALESCE(printf('%.3f',stopDate),'-')||' umd='||printf('%.4f',userModificationDate) FROM TMTask WHERE uuid='$T'")"
  note "  -- unarchive Lu2 (set status to open) — the RESTORE --"
  gas "tell application \"Things3\" to set status of to do id \"$T\" to open"; sleep 2
  note "  Lu2 row (restored — index retained? status 3->0, stop->NULL only?): $(gq "SELECT 'idx='||\"index\"||' st='||status||' stop='||COALESCE(printf('%.3f',stopDate),'-')||' umd='||printf('%.4f',userModificationDate) FROM TMTask WHERE uuid='$T'")"
  note "  FINAL LIFE headings: $(heads HSORT-LIFE | tr '\n' ' ')"
  exit 0
fi

# ============================================================ dump / teardown
if [ "$CMD" = "dump" ]; then
  load_session
  note "== crash / version =="
  lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo "Things3 ALIVE" || echo "Things3 DEAD"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | grep -i things || echo "no Things crash reports"' </dev/null | tee -a "$REPORT"
  note "Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)"
  note "FINAL BASE:"; dump HSORT-BASE | tee -a "$REPORT"
  note "FINAL LIFE:"; dump HSORT-LIFE | tee -a "$REPORT"
  lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/headsort.sqlite"' </dev/null
  lab_scp "$LAB_SSH_USER@$IP:/tmp/headsort.sqlite" "$OUT/final.sqlite" </dev/null 2>/dev/null || true
  note "DONE — report: $REPORT"
  exit 0
fi

echo "usage: $0 setup|base|loginterval|archive|unswept|swept|mixed|restore|dump|teardown" >&2
exit 1
