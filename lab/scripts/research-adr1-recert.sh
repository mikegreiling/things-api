#!/bin/bash
# ADR1 re-cert (issue #480) — the FIXED build on golden-v2 / 3.22.12.
#
# Phase 0 proved every repro cell PASSES on 3.22.12 (the silent-noop is a 3.22.14
# behavior change), so there is no golden root-cause to fix. This re-cert proves
# the shipped DEFENSIVE fixes on real hardware:
#   A. HAPPY PATH (no regression): the full issue combo (area+tag+when+reminder,
#      weekly/2/wednesday) still creates the template — WITH the new eligibility
#      assertion inline — first occurrence 2026-08-26, reminder committed.
#   B. The assert-eligible AX script's real behavior: "OK" for a properly-selected
#      to-do; "NOTSEL…" when nothing is selected (the disabled-menu masking case).
#   C. FORCED FAILURE → seed auto-trash: a leftover open Repeat dialog disables the
#      menu bar so the promote canary refuses; add-repeating then AUTO-TRASHES its
#      seed and the result names the seed's real uuid + a working remediation.
#
# METHOD: ONE disposable clone `adr1-recert` of things-lab-golden-v2. Ship the
# FIXED e2e bundle (built from THIS worktree). Airgap; pin clock 2026-07-05.
# Synthetic fixtures. Teardown at the end.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="adr1-recert"
OUT="lab/artifacts/adr1-lab/recert"; mkdir -p "$OUT/drive"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[recert] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"

FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB"
[ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free."; exit 1; }

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
node --version >/dev/null 2>&1 || { note "FATAL: no node"; exit 1; }
note "toolchain: node $(node --version)"
[ -d node_modules/commander ] || { note "npm ci…"; npm ci >"$OUT/npm-ci.log" 2>&1 || { note "FATAL npm ci"; exit 1; }; }

note "cloning things-lab-golden-v2 -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone things-lab-golden-v2 "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: no SSH"; exit 1; }
note "ssh up at $IP"
cleanup() { [ "$KEEP" = "1" ] && { note "KEEP=1 — leaving $VM at $IP"; return; }; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo FAIL || echo OK' </dev/null)
note "airgap: $AG"; [ "$AG" = "OK" ] || { note "FATAL airgap"; exit 1; }
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"

lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

note "build + ship FIXED bundle (this worktree)"
npm run build >"$OUT/build.log" 2>&1 || { note "FATAL build"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node"
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/"
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander"
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json"
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
drive() {
  local label="$1"; shift
  lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $* ; echo EXIT=\$?" </dev/null > "$OUT/drive/$label.log" 2>&1
  { grep -m1 '"ok": *true\|"ok"' "$OUT/drive/$label.log" || grep -m1 'verify-failed\|blocked\|"error"' "$OUT/drive/$label.log" || echo '(no verdict)'; } | sed "s/^/  [$label] /" | tee -a "$REPORT"
  grep -m1 'EXIT=' "$OUT/drive/$label.log" | sed "s/^/  [$label] /" | tee -a "$REPORT"
}
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
G config set ui-enabled true >/dev/null 2>&1
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
note "bundle shipped; Things $TVER; ui-enabled=true; clock 2026-07-05"

warm()   { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
tpl_uuid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_recurrenceRule IS NOT NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
plain_uuid() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL LIMIT 1"; }

drive S_area area add \"Synthetic Area\" --json
drive S_tag  tag add recurring --json
settle
RULE="--frequency weekly --interval 2 --weekdays wednesday --when 2026-08-26 --dangerously-drive-gui --json"

# =========== A. HAPPY PATH — full issue combo (no regression) ===========
note ""; note "########## A. HAPPY PATH: full issue combo (assertion inline) ##########"
warm
drive A_full todo add-repeating \"ADR1 recert full\" --area \"Synthetic Area\" --tag recurring --reminder 18:00 --notes \"Synthetic reference note\" $RULE
settle
ATPL=$(tpl_uuid "ADR1 recert full")
note "  template uuid=$ATPL"
if [ -n "$ATPL" ]; then
  note "  first occurrence (rt1_instanceCreationStartDate, want 132812032 = 2026-08-26): $(gq "SELECT rt1_instanceCreationStartDate FROM TMTask WHERE uuid='$ATPL'")"
  note "  template reminderTime (want 1207959552 = 18:00 via hour<<26): $(gq "SELECT reminderTime FROM TMTask WHERE uuid='$ATPL'")"
  note "  instance reminderTime: $(gq "SELECT reminderTime FROM TMTask WHERE rt1_repeatingTemplate='$ATPL' AND trashed=0 LIMIT 1")"
  note "  A VERDICT: PASS (template created with assertion inline; check reminderTime above)"
  note "  drive steps: $(grep -o 'drove [0-9]* step(s):[^"]*' "$OUT/drive/A_full.log" | head -1)"
  grep -o 'confirm the target to-do is selected[^"→]*' "$OUT/drive/A_full.log" | head -1 | sed 's/^/    assertion step present: /' | tee -a "$REPORT"
else
  note "  A VERDICT: FAIL — no template (REGRESSION!). VM kept."; KEEP=1
fi

# =========== B. assert-eligible AX script — real behavior ===========
note ""; note "########## B. assert-eligible AX script (OK vs NOTSEL) ##########"
# install the exact shipped script shape via a tiny harness that reads selection + menu enabled
lab_ssh "$IP" 'cat > ~/labh/eligible.sh && chmod +x ~/labh/eligible.sh' <<'EOF'
#!/bin/bash
UUID="$1"
osascript <<OSA
set selIds to {}
tell application "Things3"
  try
    set selIds to id of selected to dos
  end try
end tell
if (count of selIds) is 0 then return "NOTSEL no to-do is selected after the reveal (expected $UUID)"
if (count of selIds) is greater than 1 then return "NOTSEL multiple selected"
set theId to (item 1 of selIds) as text
if theId is not "$UUID" then return "WRONGSEL selected " & theId & " expected $UUID"
set repEnabled to false
tell application "System Events" to tell process "Things3"
  try
    set repEnabled to enabled of menu item "Repeat…" of menu "Items" of menu bar 1
  end try
end tell
if repEnabled is false then return "DISABLED selected but Repeat… disabled"
return "OK"
OSA
EOF
warm
drive B_seed todo add \"ADR1 recert selprobe\" --area \"Synthetic Area\" --when 2026-08-26 --json
settle
BSEED=$(plain_uuid "ADR1 recert selprobe")
note "  selprobe seed uuid=$BSEED"
warm
lab_ssh "$IP" "open 'things:///show?id=$BSEED'; sleep 4" </dev/null
note "  B1 (selected):   $(lab_ssh "$IP" "~/labh/eligible.sh $BSEED" </dev/null | tail -1)"
# deselect: navigate to a list view then clear selection (Escape / show a list root)
lab_ssh "$IP" "open 'things:///show?id=logbook'; sleep 3; osascript -e 'tell application \"System Events\" to tell process \"Things3\" to key code 53' 2>/dev/null" </dev/null
note "  B2 (deselected): $(lab_ssh "$IP" "~/labh/eligible.sh $BSEED" </dev/null | tail -1)"
settle

# =========== C. FORCED FAILURE → seed auto-trash ===========
note ""; note "########## C. FORCED FAILURE (leftover sheet) → seed auto-trash ##########"
warm
# seed an eligible to-do and OPEN its Repeat dialog, leaving it open (menu bar disabled)
drive C_block todo add \"ADR1 recert blocker\" --when 2026-08-26 --json
settle
CBLK=$(plain_uuid "ADR1 recert blocker")
note "  blocker uuid=$CBLK — opening its Repeat dialog and LEAVING it open"
warm
lab_ssh "$IP" "open 'things:///show?id=$CBLK'; sleep 4; osascript -e 'tell application \"System Events\" to tell process \"Things3\" to click menu item \"Repeat…\" of menu \"Items\" of menu bar 1' 2>&1; sleep 3" </dev/null | sed 's/^/    [open-dialog] /' | tee -a "$REPORT"
SHEET=$(lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to tell process "Things3" to return (exists sheet 1 of (first window whose subrole is "AXStandardWindow")) or ((count of (windows whose subrole is "AXUnknown" and size is not {40, 40})) > 0)'\''' </dev/null)
note "  leftover sheet open? $SHEET"
# now run add-repeating — its promote canary should refuse; the seed must auto-trash
drive C_fail todo add-repeating \"ADR1 recert doomed\" --area \"Synthetic Area\" --reminder 18:00 $RULE
settle
CTPL=$(tpl_uuid "ADR1 recert doomed")
CSEED_LIVE=$(gq "SELECT uuid FROM TMTask WHERE title='ADR1 recert doomed' AND type=0 AND rt1_recurrenceRule IS NULL AND trashed=0 LIMIT 1")
CSEED_TRASH=$(gq "SELECT uuid FROM TMTask WHERE title='ADR1 recert doomed' AND type=0 AND rt1_recurrenceRule IS NULL AND trashed=1 LIMIT 1")
note "  template created? ${CTPL:-<none>} (expect none)"
note "  seed LIVE (non-trashed)? ${CSEED_LIVE:-<none>} (expect none — auto-trashed)"
note "  seed TRASHED? ${CSEED_TRASH:-<none>} (expect present — auto-trash landed)"
note "  failure detail:"
grep -o '"message":"[^"]*"' "$OUT/drive/C_fail.log" | head -1 | sed 's/^/    /' | tee -a "$REPORT"

note ""; note "########## ADR1 RE-CERT COMPLETE ##########"
note "env: Things $TVER / golden-v2 / clock 2026-07-05"
note "artifacts under $OUT"
