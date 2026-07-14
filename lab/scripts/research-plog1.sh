#!/bin/bash
# PLOG1 — completed project with a RESTORED (open) trashed child: the log-sweep
# verdict (docs/lab/plog1-research.md). ONE clone, --vnc-experimental. Reuses the
# research-ui1.sh / research-upc1.sh VNC synthetic-input mechanics (tart
# --vnc-experimental + vncdotool → hardware-level HID, no TCC; Accessibility is
# NOT granted in the golden, so ALL GUI driving is VNC clicks + VNC keyboard).
#
# Motivation (Mike's live-GUI observation, which he explicitly refused to re-run
# on prod): a project with a TRASHED to-do child can be marked COMPLETED without
# the "mark remaining items?" modal ever appearing — because the modal counts
# only NON-trashed open children. Restore that child from the Trash (GUI Put
# Back) and you get a COMPLETED project containing an OPEN to-do. This maps what
# happens to that open child when the project is swept to the Logbook. Sibling of
# oddities §6/§6½ (the trashed-child black-hole family).
#
#   PLOG1-a  reproduce the modal-skip. Project P with children T1 (open) + T2
#            (completed, realism). Trash T1. Complete P via the GUI circle →
#            NO modal (screenshot). Control project C (open NON-trashed child) →
#            completing it DOES show the modal (screenshot) — the contrast that
#            proves the modal ignores trashed children.
#   PLOG1-b  restore BEFORE sweep. logInterval set to Manually (via Settings) so
#            a completed project stays checked-in-place until an explicit sweep.
#            GUI Put Back T1 from Trash → verify P STILL completed (Put Back does
#            NOT reopen it, unlike §5b move/add) and T1 open with project ref
#            intact. Screenshot the completed project rendering its open child.
#   PLOG1-c  the sweep. AppleScript `log completed now` advances manualLogDate.
#            Dump T1 before/after: is it force-completed / orphaned / trashed, or
#            left open? Then Logbook + open-P-from-Logbook + Anytime screenshots.
#   PLOG1-d  restore AFTER sweep. Fresh project Q + trashed child U1; complete Q
#            (URL, trashed child excluded from cascade); sweep FIRST (Q logged);
#            THEN Put Back U1. Where does it land — inside the logged project,
#            Inbox, or invisible?
#
# KEY MODEL (confirmed this campaign): "logged" is a DERIVED time-boundary, not a
# per-row bit. Logbook membership = status IN (2,3) AND stopDate ≤ boundary; with
# logInterval=Manually the boundary is manualLogDate. `log completed now` only
# advances manualLogDate — it mutates NO task rows (A28/LOGNOW). So the sweep
# NEVER touches the open child: it rides into the Logbook inside its logged
# parent, still status=0, and vanishes from every actionable list (Anytime/Today)
# — reachable only by drilling into the logged project. Same end-state whether
# the restore happens before OR after the sweep.
#
# COORDINATES are in the golden's VNC framebuffer space (2048x1536). Menu/dialog
# layout is deterministic per resolution; TRASH-ROW coordinates are content-
# dependent (the row index of the custom item shifts with what else is in Trash)
# — re-read them off a fresh `vncdo capture` if the golden's Trash contents drift.
# NB (research-ui1.sh lessons): native MENUS close between separate vncdo sessions
# — chain click+capture in ONE `V ... capture` invocation to screenshot an open
# menu; and drive popup dropdowns with keyboard arrows (click-to-select races).
# Discovery: no assertions. Requires $VNCDO (a vncdotool CLI) for the GUI arms.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}" # path to a vncdotool CLI (REQUIRED for the GUI arms)

VM="things-run-plog1-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[plog1] $*" | tee -a "$REPORT"; }
cleanup() { echo "[plog1] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300)
note "ssh up at $IP"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
note "vnc url: ${VNC_URL:-<none>}"

note "airgap (both families) + pin clock to 2026-07-05 12:00 (golden pin)"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo route -n delete -inet6 default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo airgapped' </dev/null | tee -a "$REPORT"
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null; date' </dev/null | tee -a "$REPORT"

lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gsql() { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" </dev/null; }
gq()   { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
uuidof() { gq "SELECT uuid FROM TMTask WHERE title='$1' LIMIT 1" | tr -d '[:space:]'; }
url()  { lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; sleep 2; }
as()   { lab_ssh "$IP" "osascript -e $(printf '%q' "$1")" </dev/null; }
aslist() { lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to get name of to dos of list \"$1\"' 2>&1" </dev/null | tr ',' '\n' | grep -i plog1 || echo "  (no PLOG1 rows)"; }

note "warm-up: launch Things (recomputes Today for the pinned date)"
lab_ssh "$IP" 'open -a Things3; sleep 14' </dev/null
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1"); note "auth token in hand (${#TOKEN} chars)"
note "golden default logInterval / manualLogDate:"; gsql "SELECT logInterval, manualLogDate FROM TMSettings LIMIT 1" | tee -a "$REPORT"

if [ -z "$VNCDO" ] || [ -z "$VNC_URL" ]; then
  note "VNCDO/VNC_URL unavailable — the modal-skip (a), Put Back (b/d) and Settings"
  note "dropdown all require synthetic GUI input. Install vncdotool into a throwaway"
  note "venv and pass VNCDO=/path/to/vncdo. Aborting GUI arms (DB-only is insufficient"
  note "for this campaign — the modal and Put Back have no automation surface)."
  exit 0
fi
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
V() { "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }
shot() { V capture "$OUT/$1"; note "   [shot] $1"; }

# Coordinates (VNC framebuffer 2048x1536):
THINGS_MENU="150 23"; SETTINGS_ITEM="205 259"; SETTINGS_CLOSE="523 191"
LOG_DROPDOWN="1239 381"        # "Move completed items to Logbook:" popup button
PROJ_CIRCLE="720 216"          # completion circle in a project's own (show) view
MODAL_CANCEL="1021 957"        # Cancel in the mark-remaining sheet
TRASH_ROW1="844 484"           # first CUSTOM trash row (content-dependent!)
PUTBACK_ITEM="921 514"         # "Put Back" (top of the right-click context menu)

note ""; note "== set logInterval=Manually (Settings → General dropdown; keyboard-driven) =="
# Open Settings: menu stays open only within a single vncdo session → chain it.
V move $THINGS_MENU click 1 pause 1.5 move $SETTINGS_ITEM pause 0.5 click 1 pause 2
shot "04-settings.png"
# Open the popup and pick Manually with arrows (Immediately→Daily→Manually = 2×down).
V move $LOG_DROPDOWN pause 0.5 click 1 pause 1.5 key down pause 0.4 key down pause 0.4 key enter pause 1.2
V move $SETTINGS_CLOSE pause 0.3 click 1 pause 1
note "logInterval after (expect 4=Manually; manualLogDate stamped ~now):"
gsql "SELECT logInterval, manualLogDate FROM TMSettings LIMIT 1" | tee -a "$REPORT"

##############################################################################
note ""; note "############ PLOG1-a — reproduce the modal-skip ############"
url "things:///add-project?title=PLOG1-P&auth-token=$TOKEN"
url "things:///add-project?title=PLOG1-C-CONTROL&auth-token=$TOKEN"; sleep 1
PUUID=$(uuidof PLOG1-P); CUUID=$(uuidof PLOG1-C-CONTROL)
url "things:///add?title=PLOG1-T1-OPEN&list-id=$PUUID&auth-token=$TOKEN"
url "things:///add?title=PLOG1-T2-DONE&list-id=$PUUID&auth-token=$TOKEN"
url "things:///add?title=PLOG1-C-CHILD-OPEN&list-id=$CUUID&auth-token=$TOKEN"; sleep 1
T1=$(uuidof PLOG1-T1-OPEN); T2=$(uuidof PLOG1-T2-DONE)
url "things:///update?id=$T2&completed=true&auth-token=$TOKEN"; sleep 1
note "-- trash T1 (AppleScript move to Trash) --"
as "tell application \"Things3\" to move to do id \"$T1\" to list \"Trash\""; sleep 2
note "-- DB: P has open-but-trashed T1 + completed T2 (type 1=proj; status 3=done) --"
gsql "SELECT substr(title,1,18) title, type, status, trashed, substr(project,1,8) proj FROM TMTask WHERE title LIKE 'PLOG1-%' ORDER BY type DESC, title" | tee -a "$REPORT"

note "-- open P's view; the trashed T1 is filtered from the project view (§6½) --"
url "things:///show?id=$PUUID"; sleep 2; shot "08-project-P-view.png"
note "-- click P's completion circle → EXPECT NO modal (only open child is trashed) --"
V move $PROJ_CIRCLE pause 0.5 click 1 pause 2; shot "09-P-completed-nomodal.png"
gsql "SELECT substr(title,1,18) title, status, trashed FROM TMTask WHERE title IN ('PLOG1-P','PLOG1-T1-OPEN','PLOG1-T2-DONE')" | tee -a "$REPORT"
note "-- CONTROL: complete C (open NON-trashed child) → EXPECT the modal to appear --"
url "things:///show?id=$CUUID"; sleep 2
V move $PROJ_CIRCLE pause 0.5 click 1 pause 2; shot "10-C-control-modal.png"
V move $MODAL_CANCEL pause 0.3 click 1 pause 1   # Cancel — leave C uncompleted
note "   C should still be open (modal cancelled):"
gsql "SELECT substr(title,1,18) title, status FROM TMTask WHERE title LIKE 'PLOG1-C%'" | tee -a "$REPORT"

##############################################################################
note ""; note "############ PLOG1-b — restore BEFORE sweep (GUI Put Back) ############"
url "things:///show?id=trash"; sleep 2; shot "11-trash-view.png"
note "   (T1 appears individually in Trash with parent 'PLOG1-P' in muted text)"
note "-- right-click T1 → Put Back (chained in one session) --"
V move $TRASH_ROW1 pause 0.4 click 1 pause 0.5 click 3 pause 1 move $PUTBACK_ITEM pause 0.5 click 1 pause 1.5
sleep 1
note "-- DB: T1 restored (trashed→0, open) INTO P; P STILL completed (Put Back does"
note "   NOT reopen it — contrast §5b move/add-open-child) --"
gsql "SELECT substr(title,1,18) title, type, status, trashed, substr(project,1,8) proj FROM TMTask WHERE title LIKE 'PLOG1-%' ORDER BY type DESC, title" | tee -a "$REPORT"
url "things:///show?id=$PUUID"; sleep 2; shot "13-P-completed-with-open-child.png"
note "   >>> the money shot: a checked (completed) project rendering an UNCHECKED child"

##############################################################################
note ""; note "############ PLOG1-c — the sweep (log completed now) ############"
note "-- BEFORE sweep rows --"
gsql "SELECT substr(title,1,18) title, status, trashed, substr(project,1,8) proj, stopDate FROM TMTask WHERE title IN ('PLOG1-P','PLOG1-T1-OPEN','PLOG1-T2-DONE') ORDER BY status" | tee -a "$REPORT"
as "tell application \"Things3\" to log completed now"; sleep 3
note "-- AFTER sweep rows (EXPECT T1 UNCHANGED: still status=0/trashed=0/project=P;"
note "   the sweep only advances manualLogDate, it mutates NO task rows) --"
gsql "SELECT substr(title,1,18) title, status, trashed, substr(project,1,8) proj, stopDate FROM TMTask WHERE title IN ('PLOG1-P','PLOG1-T1-OPEN','PLOG1-T2-DONE') ORDER BY status" | tee -a "$REPORT"
gsql "SELECT logInterval, manualLogDate FROM TMSettings LIMIT 1" | tee -a "$REPORT"
note "-- membership: P → Logbook; open T1 leaves Anytime WITH its parent (invisible now) --"
note "Logbook:"; aslist Logbook | tee -a "$REPORT"
note "Anytime:"; aslist Anytime | tee -a "$REPORT"
note "Today:";   aslist Today   | tee -a "$REPORT"
url "things:///show?id=logbook"; sleep 2; shot "14-logbook.png"
note "-- open P FROM the Logbook: the open child is visible ONLY by drilling in --"
url "things:///show?id=$PUUID"; sleep 2; shot "15-P-from-logbook-open.png"

##############################################################################
note ""; note "############ PLOG1-d — restore AFTER sweep (separate items) ############"
url "things:///add-project?title=PLOG1-Q&auth-token=$TOKEN"; sleep 1
QUUID=$(uuidof PLOG1-Q)
url "things:///add?title=PLOG1-U1-OPEN&list-id=$QUUID&auth-token=$TOKEN"; sleep 1
U1=$(uuidof PLOG1-U1-OPEN)
as "tell application \"Things3\" to move to do id \"$U1\" to list \"Trash\""; sleep 2
note "-- complete Q via URL (the trashed child is excluded from the cascade, same"
note "   as the GUI modal ignores it) --"
url "things:///update-project?id=$QUUID&completed=true&auth-token=$TOKEN"; sleep 2
gsql "SELECT substr(title,1,18) title, status, trashed, substr(project,1,8) proj FROM TMTask WHERE title LIKE 'PLOG1-Q%' OR title='PLOG1-U1-OPEN'" | tee -a "$REPORT"
note "-- sweep FIRST (Q → Logbook) --"
as "tell application \"Things3\" to log completed now"; sleep 3
note "-- NOW Put Back U1 --"
url "things:///show?id=trash"; sleep 2; shot "16-trash-before-U1-putback.png"
V move $TRASH_ROW1 pause 0.4 click 1 pause 0.5 click 3 pause 1 move $PUTBACK_ITEM pause 0.5 click 1 pause 1.5
sleep 1
note "-- DB: U1 restored back INTO the LOGGED Q; Q still completed (not pulled from"
note "   Logbook, not reopened) — same invisible-open-child end-state as (c) --"
gsql "SELECT substr(title,1,18) title, status, trashed, substr(project,1,8) proj, stopDate FROM TMTask WHERE title LIKE 'PLOG1-Q%' OR title='PLOG1-U1-OPEN'" | tee -a "$REPORT"
note "Logbook:"; aslist Logbook | tee -a "$REPORT"
note "Anytime:"; aslist Anytime | tee -a "$REPORT"
note "Inbox:";   aslist Inbox   | tee -a "$REPORT"
url "things:///show?id=$QUUID"; sleep 2; shot "17-Q-logged-with-open-U1.png"

##############################################################################
note ""; note "== crash / DiagnosticReport check =="
lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo "Things3 ALIVE (no crash)" || echo "Things3 DEAD"' </dev/null | tee -a "$REPORT"
lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | grep -i things || echo "no Things crash reports"' </dev/null | tee -a "$REPORT"

note ""; note "== copying DB out =="
lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/plog1.sqlite"' </dev/null
lab_scp "$LAB_SSH_USER@$IP:/tmp/plog1.sqlite" "$OUT/final.sqlite" </dev/null 2>/dev/null || true
note "GREEN — report: $REPORT ; screenshots + final.sqlite in $OUT"
trap - EXIT; cleanup
