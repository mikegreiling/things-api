#!/bin/bash
# Phase 21b — script A: autonomous discovery + piggyback wish-list probes.
#
# Runs the CONSENT-PRESERVING half of the Phase 21b campaign in one
# disposable clone (AppleScript grants stay intact throughout):
#
#   [D] discovery: csrutil status (SIP), Things defaults dump (hunting an
#       Enable-Things-URLs key), TMSettings token baseline
#   [A1] tags on a project via URL update-project?tags=
#   [A2] tags on a project via AppleScript `set tag names of project id`
#   [A3] project reminder via update-project?when=today@14:30
#   [A4] tag keyboard-shortcut CLEAR via the property-delete form (P29 analog)
#   [A5] single-item permanent delete: AppleScript `delete` on an
#        already-trashed to-do
#   [A6] inbox reorder via the private reorder command
#
# The consent-DESTROYING probes (Enable-Things-URLs lifecycle, tccutil
# reset signatures) live in research-phase21b-b.sh — separate clone, so a
# failure there can never invalidate these verdicts.
#
# Discovery script: no assertions — captures pre/post state into
# lab/artifacts/<vm>/ for host-side verdict analysis.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-p21ba-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"
mkdir -p "$OUT"
REPORT="$OUT/report.txt"

note() { echo "[p21b-a] $*" | tee -a "$REPORT"; }

cleanup() {
  echo "[p21b-a] teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300)
note "ssh up at $IP"

note "airgap + pin clock to golden pin 2026-07-05"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true'
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && exit 1 || exit 0'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null'

# Guest-side SQL helpers (avoids ssh quoting hell around SQL string literals).
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
# gsql.sh [-q] "<SQL>" — read-only query against the live Things DB.
FMT=(-header -column)
if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF

gsql() { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")"; }        # pretty
gq()   { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")"; }     # bare value
# AppleScript probe: stderr folded in, non-zero exit swallowed — an
# osascript error IS a verdict here, not a script failure.
gas()  { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" || true; }
gurl() { lab_ssh "$IP" "open -g $(printf '%q' "$1")"; sleep 2; }    # URL write

uuid_of() { # uuid_of <title> — poll (fresh-clone URL writes can lag)
  local t="$1" u="" i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    u=$(gq "SELECT uuid FROM TMTask WHERE title='$t' AND trashed=0 LIMIT 1")
    [ -n "$u" ] && { echo "$u"; return 0; }
    sleep 1
  done
  echo "[p21b-a] FATAL: '$t' never appeared in the DB" >&2
  return 1
}

# Warm-up launch-quit-relaunch (mirrors the runner: fresh clones drop URL
# writes in their first seconds).
note "warm-up: launch Things, quit, relaunch"
lab_ssh "$IP" 'open -g -a Things3; sleep 12'
lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3'
lab_ssh "$IP" 'open -g -a Things3; sleep 8'

# ---------------------------------------------------------------- [D] discovery
note "== [D] discovery =="
note "-- csrutil status:"
lab_ssh "$IP" 'csrutil status' 2>&1 | tee -a "$REPORT"
note "-- sw_vers / Things version:"
lab_ssh "$IP" 'sw_vers -productVersion; defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' 2>&1 | tee -a "$REPORT"
note "-- full defaults dump -> defaults-dump.txt; URI/URL/scheme/token hits:"
lab_ssh "$IP" 'defaults read com.culturedcode.ThingsMac 2>&1' > "$OUT/defaults-dump.txt" || true
grep -inE 'uri|url|scheme|token|link' "$OUT/defaults-dump.txt" | tee -a "$REPORT" || note "(no URI/URL-ish keys in defaults)"
note "-- TMSettings token baseline:"
gsql "SELECT uuid, uriSchemeAuthenticationToken FROM TMSettings" | tee -a "$REPORT"

TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
[ -n "$TOKEN" ] || { note "FATAL: no auth token in TMSettings"; exit 1; }
note "token captured (${#TOKEN} chars)"

# ------------------------------------------------------------- setup entities
note "== setup: fresh probe entities (seeds stay pristine) =="
gurl "things:///add-project?title=R21B-PROJ-URLTAG"
gurl "things:///add-project?title=R21B-PROJ-ASTAG"
gurl "things:///add-project?title=R21B-PROJ-REM"
gurl "things:///add?title=R21B-DEL-1"
gurl "things:///add?title=R21B-INB-1"
gurl "things:///add?title=R21B-INB-2"
gurl "things:///add?title=R21B-INB-3"
gas 'tell application "Things3" to make new tag with properties {name:"R21B-TAG-SC"}' | tee -a "$REPORT"
gas 'tell application "Things3" to set keyboard shortcut of tag "R21B-TAG-SC" to "7"' | tee -a "$REPORT"
sleep 2

P_URLTAG=$(uuid_of "R21B-PROJ-URLTAG")
P_ASTAG=$(uuid_of "R21B-PROJ-ASTAG")
P_REM=$(uuid_of "R21B-PROJ-REM")
T_DEL=$(uuid_of "R21B-DEL-1")
T_I1=$(uuid_of "R21B-INB-1")
T_I2=$(uuid_of "R21B-INB-2")
T_I3=$(uuid_of "R21B-INB-3")
note "uuids: urltag=$P_URLTAG astag=$P_ASTAG rem=$P_REM del=$T_DEL inb=$T_I1,$T_I2,$T_I3"

proj_tags() { # proj_tags <uuid> — DB view of a project's tag links
  gsql "SELECT tt.tasks, tg.title AS tag FROM TMTaskTag tt JOIN TMTag tg ON tg.uuid=tt.tags WHERE tt.tasks='$1'"
}

# ---------------------------------------------------- [A1] project tags via URL
note "== [A1] project tags via URL update-project?tags= =="
note "-- pre (expect no rows):"
proj_tags "$P_URLTAG" | tee -a "$REPORT"
gurl "things:///update-project?id=$P_URLTAG&auth-token=$TOKEN&tags=lab-tag-1"
sleep 2
note "-- post TMTaskTag:"
proj_tags "$P_URLTAG" | tee -a "$REPORT"
note "-- post AppleScript read-back:"
gas "tell application \"Things3\" to tag names of project id \"$P_URLTAG\"" | tee -a "$REPORT"

# -------------------------------------------- [A2] project tags via AppleScript
note "== [A2] project tags via AppleScript set tag names =="
note "-- pre (expect no rows):"
proj_tags "$P_ASTAG" | tee -a "$REPORT"
gas "tell application \"Things3\" to set tag names of project id \"$P_ASTAG\" to \"lab-tag-2\"" | tee -a "$REPORT"
sleep 2
note "-- post TMTaskTag:"
proj_tags "$P_ASTAG" | tee -a "$REPORT"

# ------------------------------------------------- [A3] project reminder via URL
note "== [A3] project reminder via update-project?when=today@14:30 =="
note "-- pre:"
gsql "SELECT title, start, startDate, startBucket, reminderTime FROM TMTask WHERE uuid='$P_REM'" | tee -a "$REPORT"
gurl "things:///update-project?id=$P_REM&auth-token=$TOKEN&when=today@14:30"
sleep 2
note "-- post (expect startDate=today-pin, reminderTime=970981376 = 14<<26|30<<20):"
gsql "SELECT title, start, startDate, startBucket, reminderTime FROM TMTask WHERE uuid='$P_REM'" | tee -a "$REPORT"

# --------------------------------------------------- [A4] tag shortcut CLEAR
note "== [A4] tag keyboard-shortcut clear via property-delete =="
note "-- pre (expect shortcut=7):"
gsql "SELECT title, shortcut, parent FROM TMTag WHERE title='R21B-TAG-SC'" | tee -a "$REPORT"
gas 'tell application "Things3" to delete keyboard shortcut of tag "R21B-TAG-SC"' | tee -a "$REPORT"
sleep 1
note "-- post (hope: shortcut NULL):"
gsql "SELECT title, shortcut, parent FROM TMTag WHERE title='R21B-TAG-SC'" | tee -a "$REPORT"

# --------------------------------------------- [A5] single-item permanent delete
note "== [A5] permanent delete: AppleScript delete on an already-trashed row =="
gas "tell application \"Things3\" to delete to do id \"$T_DEL\"" | tee -a "$REPORT"
sleep 1
note "-- after first delete (expect trashed=1):"
gsql "SELECT title, trashed, status FROM TMTask WHERE uuid='$T_DEL'" | tee -a "$REPORT"
note "-- second delete on the trashed row:"
gas "tell application \"Things3\" to delete to do id \"$T_DEL\"" | tee -a "$REPORT"
sleep 1
note "-- post: row present? (0 rows = permanently deleted)"
gsql "SELECT count(*) AS rows_left FROM TMTask WHERE uuid='$T_DEL'" | tee -a "$REPORT"
note "-- post: tombstone?"
gsql "SELECT count(*) AS tombstones FROM TMTombstone WHERE deletedObjectUUID='$T_DEL'" | tee -a "$REPORT"

# ------------------------------------------------------- [A6] inbox reorder
note "== [A6] inbox reorder via the private command =="
note "-- pre inbox order:"
gsql "SELECT uuid, title, \"index\" FROM TMTask WHERE trashed=0 AND status=0 AND start=0 AND type=0 ORDER BY \"index\"" | tee -a "$REPORT"
WIRE=$(gq "SELECT uuid FROM TMTask WHERE trashed=0 AND status=0 AND start=0 AND type=0 ORDER BY \"index\" DESC" | paste -sd, -)
note "-- full reversed wire list: $WIRE"
gas "tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Inbox\" with ids \"$WIRE\"" | tee -a "$REPORT"
sleep 2
note "-- post inbox order (hope: reversed):"
gsql "SELECT uuid, title, \"index\" FROM TMTask WHERE trashed=0 AND status=0 AND start=0 AND type=0 ORDER BY \"index\"" | tee -a "$REPORT"

# ----------------------------------------------------------------- artifacts
note "== copying artifacts out =="
lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/p21ba.sqlite"'
lab_scp "$LAB_SSH_USER@$IP:/tmp/p21ba.sqlite" "$OUT/final.sqlite"
lab_scp "$LAB_SSH_USER@$IP:~/things-lab/events.ndjson" "$OUT/events.ndjson" || true

note "GREEN — report: $REPORT"
trap - EXIT
cleanup
