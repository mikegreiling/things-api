#!/bin/bash
# P10 — heading ARCHIVE surfaces + area tag clear (Mike, 2026-07-09). ONE clone.
#
# The Things UI offers Archive / Move / Convert / Delete on headings. Move and
# Convert are dead (scf P2, catalog sweep), Delete is consent-gated. ARCHIVE
# is unprobed as an automation surface — and Shortcuts `Edit Items` has a
# Status detail (output-class = headless). If Status=Completed on a heading
# row implements Archive, that's the true headless soft-delete.
#   P10a  Shortcuts set-detail Status=Completed on a heading WITH children:
#         heading status/stopDate? children touched? Then Status=Open (does
#         un-archive restore it?), then Status=Canceled on a second heading.
#   P10b  URL update?completed=true on a heading uuid (never probed).
#   P10c  URL update?title= on a heading uuid (a URL rename vector?).
#   P10d  AppleScript `set status of to do id <heading>` (A31 says no heading
#         class, but 5e showed by-id fetches can bypass list reads).
#   P10e  Area tag CLEAR via AppleScript empty set (E01 validated replace;
#         clear is the unprobed matrix cell).
# Discovery: no assertions.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-p10-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[p10] $*" | tee -a "$REPORT"; }
cleanup() { echo "[p10] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

PROJ_PLAIN="933TCvzMgM3MLvpKPcjheC"   # LAB-PROJ-PLAIN
AREA_A="7Ck4hAXU36jyaBsy2Fkije"       # LAB-AREA-A (has tags? check live)

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
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
gsql() { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")"; }
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")"; }
gas() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" || true; }
gurl() { lab_ssh "$IP" "open -g $(printf '%q' "$1")"; sleep 2; }
proxy() {
  note "-- shortcuts run $1  $2"
  lab_ssh "$IP" "printf '%s' $(printf '%q' "$2") > /tmp/p10-in.json; rm -f /tmp/p10-out.txt; perl -e 'alarm 60; exec @ARGV' shortcuts run $(printf '%q' "$1") --input-path /tmp/p10-in.json --output-path /tmp/p10-out.txt 2>&1; echo \"[exit \$?]\"; cat /tmp/p10-out.txt 2>/dev/null; echo" 2>&1 | tee -a "$REPORT" || true
  sleep 1
}
uuid_of() { local t="$1" typ="${2:-}" w="title='$1' AND trashed=0" u i; [ -n "$typ" ] && w="$w AND type=$typ"; for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }

note "warm-up: launch Things, quit, relaunch"
lab_ssh "$IP" 'open -g -a Things3; sleep 12'
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3'
lab_ssh "$IP" 'open -g -a Things3; sleep 8'
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
note "auth token in hand (${#TOKEN} chars)"

# Fixtures: two headings with children in LAB-PROJ-PLAIN.
note "== fixtures: headings P10-HEAD-A / P10-HEAD-B with children =="
proxy things-proxy-create-heading "{\"title\":\"P10-HEAD-A\",\"project\":\"$PROJ_PLAIN\"}"
proxy things-proxy-create-heading "{\"title\":\"P10-HEAD-B\",\"project\":\"$PROJ_PLAIN\"}"
HA=$(uuid_of "P10-HEAD-A" 2); HB=$(uuid_of "P10-HEAD-B" 2)
gurl "things:///add?title=P10-CHILD-A1&list-id=$PROJ_PLAIN&heading=P10-HEAD-A"
gurl "things:///add?title=P10-CHILD-A2&list-id=$PROJ_PLAIN&heading=P10-HEAD-A"
gurl "things:///add?title=P10-CHILD-B1&list-id=$PROJ_PLAIN&heading=P10-HEAD-B"
head_state() { gsql "SELECT title, type, status, stopDate, trashed, project, heading FROM TMTask WHERE uuid IN ('$HA','$HB') OR heading IN ('$HA','$HB') OR title LIKE 'P10-CHILD%' ORDER BY type DESC, title" | tee -a "$REPORT"; }
note "-- pre:"; head_state

# ---------------------------------------------------------------- P10a Shortcuts Status
note "== [P10a] set-detail Status=Completed on heading A (the UI's Archive?) =="
proxy things-proxy-set-detail "{\"id\":\"$HA\",\"detail\":\"Status\",\"value\":\"Completed\"}"
note "-- post (heading status/stopDate? children?):"; head_state
note "-- [P10a2] set-detail Status=Open on heading A (un-archive?):"
proxy things-proxy-set-detail "{\"id\":\"$HA\",\"detail\":\"Status\",\"value\":\"Open\"}"
head_state
note "-- [P10a3] set-detail Status=Canceled on heading B:"
proxy things-proxy-set-detail "{\"id\":\"$HB\",\"detail\":\"Status\",\"value\":\"Canceled\"}"
head_state

# ---------------------------------------------------------------- P10b/c URL update on heading
note "== [P10b] URL update?completed=true on heading A (tokened) =="
gurl "things:///update?id=$HA&auth-token=$TOKEN&completed=true"
sleep 1; head_state
note "== [P10c] URL update?title= on heading A (rename vector?) =="
gurl "things:///update?id=$HA&auth-token=$TOKEN&title=P10-HEAD-A-RENAMED"
sleep 1
gsql "SELECT uuid, title, type, status FROM TMTask WHERE uuid='$HA'" | tee -a "$REPORT"

# ---------------------------------------------------------------- P10d AppleScript by-id
note "== [P10d] AppleScript on the heading row via 'to do id' =="
gas "tell application \"Things3\" to get properties of to do id \"$HA\"" | tee -a "$REPORT"
gas "tell application \"Things3\" to set status of to do id \"$HA\" to completed" | tee -a "$REPORT"
sleep 1
gsql "SELECT uuid, title, type, status, stopDate FROM TMTask WHERE uuid='$HA'" | tee -a "$REPORT"
note "-- and AS rename attempt:"
gas "tell application \"Things3\" to set name of to do id \"$HA\" to \"P10-AS-RENAME\"" | tee -a "$REPORT"
sleep 1
gsql "SELECT uuid, title, type, status FROM TMTask WHERE uuid='$HA'" | tee -a "$REPORT"

# ---------------------------------------------------------------- P10e area tag clear
note "== [P10e] area tag CLEAR via AppleScript empty set =="
note "-- give LAB-AREA-A a tag first (E01 replace), then clear:"
gas "tell application \"Things3\" to set tag names of area id \"$AREA_A\" to \"lab-tag-1\"" | tee -a "$REPORT"
sleep 1
gsql "SELECT a.title, t.title AS tag FROM TMArea a LEFT JOIN TMAreaTag at ON at.areas = a.uuid LEFT JOIN TMTag t ON t.uuid = at.tags WHERE a.uuid='$AREA_A'" | tee -a "$REPORT"
gas "tell application \"Things3\" to set tag names of area id \"$AREA_A\" to \"\"" | tee -a "$REPORT"
sleep 1
note "-- post (tag rows gone = clear works):"
gsql "SELECT a.title, t.title AS tag FROM TMArea a LEFT JOIN TMAreaTag at ON at.areas = a.uuid LEFT JOIN TMTag t ON t.uuid = at.tags WHERE a.uuid='$AREA_A'" | tee -a "$REPORT"

note "== copying DB out =="
lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/p10.sqlite"'
lab_scp "$LAB_SSH_USER@$IP:/tmp/p10.sqlite" "$OUT/final.sqlite" || true
note "GREEN — report: $REPORT"
trap - EXIT; cleanup
