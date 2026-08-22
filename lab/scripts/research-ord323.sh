#!/bin/bash
# ORD323 — is `_private_experimental_ reorder to dos in …` still functional
# under Things 3.23? The golden-v4 o-suite sweep showed 14 reorder probes
# failing with a ZERO row delta while the command exits 0, which reads as a
# silent no-op — but several o-suite probes pass, so this pass measures the
# command in isolation with an order the fixture does NOT already have.
#
# METHOD: ONE disposable clone `ord323-lab` of things-lab-golden-v4. Airgap,
# clock pinned 2026-07-05, synthetic ORD323-* fixtures only, read-only guest
# SQLite as ground truth. Teardown on EXIT.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="ord323-lab"
OUT="lab/artifacts/ord323-lab"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[ord323] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"

GOLDEN="${GOLDEN:-things-lab-golden-v4}"
note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: no SSH"; exit 1; }
note "ssh up at $IP"
cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — $VM left running at $IP"; return; fi
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "teardown done"
}
trap cleanup EXIT

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-noheader -list)
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
note "env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / dbv $(gq "SELECT 1")"

lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null

note "seeding three synthetic Today to-dos"
for n in 1 2 3; do
  lab_ssh "$IP" "open -g 'things:///add?title=ORD323-$n&when=today&auth-token=$TOKEN'; sleep 3" </dev/null
done
lab_ssh "$IP" 'sleep 4' </dev/null
IDS=""
for n in 1 2 3; do
  u=$(gq "SELECT uuid FROM TMTask WHERE title='ORD323-$n' AND trashed=0 LIMIT 1")
  note "  ORD323-$n = $u"
  IDS="$IDS${IDS:+,}$u"
done
note "before: $(gq "SELECT group_concat(title||':'||todayIndex, ' ') FROM (SELECT title, todayIndex FROM TMTask WHERE title LIKE 'ORD323-%' ORDER BY todayIndex)")"

# reverse the ids -> an order the fixture provably does not already have
REV=$(python3 -c "import sys;print(','.join(reversed(sys.argv[1].split(','))))" "$IDS")
note "driving: reorder to dos in list \"Today\" with ids \"$REV\""
R=$(lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Today\" with ids \"$REV\"' 2>&1; echo EXIT=\$?" </dev/null)
note "  osascript: $R"
lab_ssh "$IP" 'sleep 5' </dev/null
note "after : $(gq "SELECT group_concat(title||':'||todayIndex, ' ') FROM (SELECT title, todayIndex FROM TMTask WHERE title LIKE 'ORD323-%' ORDER BY todayIndex)")"

note "sdef canary: does the command still exist?"
lab_ssh "$IP" 'grep -c "_private_experimental_" /Applications/Things3.app/Contents/Resources/Things.sdef' </dev/null | sed 's/^/  sdef hits: /' | tee -a "$REPORT"
note "same drive against a PROJECT scope (control):"
PID=$(gq "SELECT uuid FROM TMTask WHERE title='LAB-PROJ-PLAIN' AND type=1 LIMIT 1")
CH=$(gq "SELECT group_concat(uuid) FROM (SELECT uuid FROM TMTask WHERE project='$PID' AND trashed=0 ORDER BY \"index\")")
note "  project $PID children: $CH"
note "  before: $(gq "SELECT group_concat(title||':'||\"index\", ' ') FROM (SELECT title, \"index\" FROM TMTask WHERE project='$PID' AND trashed=0 ORDER BY \"index\")")"
RCH=$(python3 -c "import sys;print(','.join(reversed(sys.argv[1].split(','))))" "$CH")
R2=$(lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to _private_experimental_ reorder to dos in project id \"$PID\" with ids \"$RCH\"' 2>&1; echo EXIT=\$?" </dev/null)
note "  osascript: $R2"
lab_ssh "$IP" 'sleep 5' </dev/null
note "  after : $(gq "SELECT group_concat(title||':'||\"index\", ' ') FROM (SELECT title, \"index\" FROM TMTask WHERE project='$PID' AND trashed=0 ORDER BY \"index\")")"
note "done"
