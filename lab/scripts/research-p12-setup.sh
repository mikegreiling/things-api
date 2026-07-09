#!/bin/bash
# P12 interactive setup — the LAST interactivity-gated batch (Mike present to
# click Shortcuts delete-class consent dialogs). Boots a disposable clone
# WITH GRAPHICS so Mike sees the confirm dialogs, airgaps + pins, builds all
# fixtures, and stashes the VM name + uuids for the per-delete driver scripts.
# The golden stays frozen (this is a clone).
#
# Fixtures for the batch:
#   HEAD-NE   heading with 2 open children (heading delete child-fate — P5)
#   HEAD-NE2  second heading with 2 children (permanent-delete variant)
#   PROJ-CH   project with 2 children + 1 heading+child (project delete via
#             the SAME Shortcuts delete verb — are projects Trashed w/ kids?)
#   AREA-CH   area with a direct to-do + a project (area delete via Shortcuts)
# Emits: /tmp/p12/env  (VM, IP, uuids) — sourced by the driver scripts.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-p12-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[p12] $*" | tee -a "$REPORT"; }

PROJ_PLAIN="933TCvzMgM3MLvpKPcjheC"
AREA_A="7Ck4hAXU36jyaBsy2Fkije"

note "cloning golden -> $VM (GRAPHICS ON — a window will open)"
tart clone things-lab-golden-v1 "$VM"
# WITH graphics: no --no-graphics, so the VM window is visible for the clicks.
(tart run "$VM" >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300)
note "ssh up at $IP"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null'
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")"; }
gurl() { lab_ssh "$IP" "open -g $(printf '%q' "$1")"; sleep 2; }
proxy() {
  lab_ssh "$IP" "printf '%s' $(printf '%q' "$2") > /tmp/in.json; rm -f /tmp/out.txt; perl -e 'alarm 60; exec @ARGV' shortcuts run $(printf '%q' "$1") --input-path /tmp/in.json --output-path /tmp/out.txt 2>&1; echo \"[exit \$?]\"; cat /tmp/out.txt 2>/dev/null; echo" 2>&1 | tee -a "$REPORT" || true
  sleep 1
}
uuid_of() { local t="$1" typ="${2:-}" w="title='$1' AND trashed=0" u i; [ -n "$typ" ] && w="$w AND type=$typ"; for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }

note "warm-up (bring Things to the foreground so the window is populated)"
lab_ssh "$IP" 'open -a Things3; sleep 12'

note "building fixtures…"
proxy things-proxy-create-heading "{\"title\":\"P12-HEAD-NE\",\"project\":\"$PROJ_PLAIN\"}" >/dev/null
proxy things-proxy-create-heading "{\"title\":\"P12-HEAD-NE2\",\"project\":\"$PROJ_PLAIN\"}" >/dev/null
HNE=$(uuid_of P12-HEAD-NE 2); HNE2=$(uuid_of P12-HEAD-NE2 2)
gurl "things:///add?title=P12-HNE-C1&list-id=$PROJ_PLAIN&heading=P12-HEAD-NE" >/dev/null
gurl "things:///add?title=P12-HNE-C2&list-id=$PROJ_PLAIN&heading=P12-HEAD-NE" >/dev/null
gurl "things:///add?title=P12-HNE2-C1&list-id=$PROJ_PLAIN&heading=P12-HEAD-NE2" >/dev/null
gurl "things:///add?title=P12-HNE2-C2&list-id=$PROJ_PLAIN&heading=P12-HEAD-NE2" >/dev/null

gurl "things:///add-project?title=P12-PROJ-CH&area-id=$AREA_A" >/dev/null
PCH=$(uuid_of P12-PROJ-CH 1)
gurl "things:///add?title=P12-PCH-C1&list-id=$PCH" >/dev/null
gurl "things:///add?title=P12-PCH-C2&list-id=$PCH" >/dev/null
proxy things-proxy-create-heading "{\"title\":\"P12-PCH-HEAD\",\"project\":\"$PCH\"}" >/dev/null
gurl "things:///add?title=P12-PCH-HC1&list-id=$PCH&heading=P12-PCH-HEAD" >/dev/null

lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to make new area with properties {name:\"P12-AREA-CH\"}"' >/dev/null 2>&1 || true
sleep 1
ACH=$(gq "SELECT uuid FROM TMArea WHERE title='P12-AREA-CH'")
gurl "things:///add?title=P12-ACH-TODO&list-id=$ACH" >/dev/null 2>&1 || true
# (area uuids are not valid list-id for add; the direct to-do may land in Inbox — fine, we test the area row itself)

mkdir -p /tmp/p12
cat > /tmp/p12/env <<ENVEOF
VM="$VM"
IP="$IP"
OUT="$OUT"
HNE="$HNE"
HNE2="$HNE2"
PCH="$PCH"
ACH="$ACH"
ENVEOF

note "=================================================================="
note "FIXTURES READY. VM=$VM IP=$IP"
note "  HEAD-NE  (heading, 2 children):    $HNE"
note "  HEAD-NE2 (heading, 2 children):    $HNE2"
note "  PROJ-CH  (project, 2 kids+heading):$PCH"
note "  AREA-CH  (area):                   $ACH"
note "The Things window is open. Driver scripts run one delete at a time."
note "=================================================================="
gsql_dump() { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" | tee -a "$REPORT"; }
note "pre-state, heading NE + children:"
gsql_dump "SELECT title, type, status, trashed FROM TMTask WHERE uuid='$HNE' OR heading='$HNE'"
note "pre-state, project CH subtree:"
gsql_dump "SELECT title, type, status, trashed, project, heading FROM TMTask WHERE uuid='$PCH' OR project='$PCH' OR heading IN (SELECT uuid FROM TMTask WHERE project='$PCH' AND type=2)"
