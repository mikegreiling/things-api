#!/bin/bash
# UPC1 — Upcoming membership & deadline forecasting (docs/lab/upcoming-research.md).
# ONE clone, --vnc-experimental. Reuses the research-ui1.sh / research-lock1.sh VNC
# synthetic-input mechanics (tart --vnc-experimental + vncdotool → hardware-level
# HID, no TCC; Accessibility is NOT granted in the golden — but IS grantable via
# the user-path toggle with SIP on, AXVM1, docs/lab/axvm1-accessibility.md).
# Membership is read via
# the GUI's own AppleScript list oracle (`to dos of list "…"` — a pure read against
# the running app, the today-order-research.md technique) AND corroborated by the
# GUI screenshots; DB dumps give the ground-truth field values.
#
# Motivation: the CLI's `upcoming` (src/read/views.ts) forecasts only scheduled rows
# (start=2 AND startDate>today) and MISSES the deadline-driven forecast the GUI shows.
# This campaign maps the full Upcoming membership matrix before the fix lands.
#
#   UPC1-A  bucket matrix — 4 items, deadline=pin+3d, NO when-date:
#           anytime / someday to-do / someday project / inbox. Which forecast into
#           GUI Upcoming, grouped under which date, with what row anatomy?
#   UPC1-B  both-dates — when+deadline on one row: does Upcoming group by the WHEN
#           date or the DEADLINE date? Then time-travel past a deadline-before-start
#           item's deadline (before its start): F-DL-FUTURE-START suppression check.
#   UPC1-C  the blue-circle discriminator — someday proj + someday to-do, deadline
#           +1d; advance past it. (i) do they pull into Today? (ii) Someday circle/box
#           colour? Then reach the SUPPRESSED state (deadlineSuppressionDate==deadline)
#           and re-observe the Someday circle colour. Separates "blue = past-due" from
#           "blue = suppressed" from "blue = in Today".
#   UPC1-D  re-arm — edit a suppressed project's deadline to a NEW future date
#           (supp < deadline). Reappears in Upcoming? Re-enters Today at the new date?
#
# KEY MECHANISM (discovered this campaign): there is NO dedicated "dismiss deadline"
# GUI command in Things 3.22.11 (the Items/context "Deadline…" popover only SETs a
# date or Clears=deletes it). deadlineSuppressionDate is stamped as a SIDE EFFECT of
# rescheduling an OVERDUE item to a no-startDate bucket (Someday OR Anytime) — the app
# records supp=deadline so the past deadline stops pulling it into Today. Rescheduling
# to a future DATE instead relies on the future startDate (no stamp; see UPC1-B). This
# script reproduces suppression via the URL scheme (`update`/`update-project` when=…),
# the same scheduling code path as the GUI "When…" gesture.
#
# COORDINATES are in the golden's VNC framebuffer space (2048x1536). Discovery: no
# assertions. Requires $VNCDO (a vncdotool CLI) for screenshots; without it the run
# still produces the full membership matrix from the AS oracle + DB dumps.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}" # path to a vncdotool CLI (screenshots only; membership works without)

VM="things-run-upc1-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[upc1] $*" | tee -a "$REPORT"; }
cleanup() { echo "[upc1] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
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
aslist() { lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to get name of to dos of list \"$1\"' 2>&1" </dev/null; }
relaunch() { # relaunch <ddhhmm2026 date arg> — quit, set clock, relaunch Things
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"' </dev/null; sleep 4
  lab_ssh "$IP" "sudo date ${1} >/dev/null; date" </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null
}

# ---- VNC helpers (screenshots only) ----
if [ -n "$VNCDO" ] && [ -n "$VNC_URL" ]; then
  HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
  PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
  V() { "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }
  shot() { url "things:///show?id=$1"; sleep 1; V capture "$OUT/$2"; note "   [shot] $2 (list=$1)"; }
else
  note "WARN: VNCDO/VNC_URL unavailable — screenshots SKIPPED (membership matrix still produced)."
  shot() { url "things:///show?id=$1"; }
fi

note "warm-up: launch Things (recomputes Today for the pinned date)"
lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1"); note "auth token in hand (${#TOKEN} chars)"

##############################################################################
note ""; note "############ UPC1-A — bucket matrix (deadline=07-08, no when) ############"
url 'things:///add?title=UPC-A1-ANYTIME&when=anytime&deadline=2026-07-08'
url 'things:///add?title=UPC-A2-SOMEDAY&when=someday&deadline=2026-07-08'
url 'things:///add-project?title=UPC-A3-SDPROJ&when=someday&deadline=2026-07-08'
url 'things:///add?title=UPC-A4-INBOX&deadline=2026-07-08'; sleep 2
note "-- DB (type 0=todo 1=proj; start 0=inbox 1=anytime 2=someday; deadline 07-08=132805632) --"
gsql "SELECT substr(title,1,16) title, type, start, startDate, deadline FROM TMTask WHERE title LIKE 'UPC-A%' ORDER BY title" | tee -a "$REPORT"
shot upcoming upc1a-upcoming.png
note "-- GUI Upcoming membership (AS oracle) --"; aslist Upcoming | tee -a "$REPORT"
note "   EXPECT present: A1-ANYTIME, A2-SOMEDAY, A3-SDPROJ (grouped under 07-08 w/ red flag); ABSENT: A4-INBOX"

##############################################################################
note ""; note "############ UPC1-B — both dates (grouping + future-start suppression) ############"
url 'things:///add?title=UPC-B-EARLYDL&when=2026-07-10&deadline=2026-07-07'  # deadline BEFORE start
url 'things:///add?title=UPC-B-LATEDL&when=2026-07-07&deadline=2026-07-10'   # control
sleep 2
gsql "SELECT substr(title,1,14) title, start, startDate, deadline FROM TMTask WHERE title LIKE 'UPC-B%' ORDER BY title" | tee -a "$REPORT"
shot upcoming upc1b-upcoming.png
note "-- GUI Upcoming (AS): LATEDL groups under WHEN 07-07; EARLYDL under WHEN 07-10 (NOT deadline 07-07) --"
aslist Upcoming | tee -a "$REPORT"
note ""; note "-- advance to 07-08 (past EARLYDL's deadline 07-07, before its when 07-10) --"
relaunch 070812002026
shot today upc1b-today-at0708.png
note "-- GUI Today (AS): EARLYDL should be ABSENT (future startDate 07-10 suppresses the past deadline; F-DL-FUTURE-START) --"
aslist Today | tee -a "$REPORT"
note "-- EARLYDL fields: deadlineSuppressionDate stays NULL (suppression is from future startDate, not a dismissed nag) --"
gsql "SELECT substr(title,1,14) title, start, startDate, deadline, deadlineSuppressionDate FROM TMTask WHERE title='UPC-B-EARLYDL'" | tee -a "$REPORT"
note "-- Upcoming @07-08: EARLYDL persists (future when 07-10); the due 07-08 items dropped to Today --"
aslist Upcoming | tee -a "$REPORT"

##############################################################################
note ""; note "############ UPC1-C — the blue-circle discriminator ############"
note "-- create someday proj + someday to-do, deadline 07-09 (clock+1d @07-08) --"
url 'things:///add-project?title=UPC-C-SDPROJ&when=someday&deadline=2026-07-09'
url 'things:///add?title=UPC-C-SDTODO&when=someday&deadline=2026-07-09'; sleep 2
shot someday upc1c-someday-baseline-0708.png
note "   baseline (future deadline): project circle + to-do checkbox both GRAY (dashed)"
note ""; note "-- advance to 07-10 (deadline 07-09 now PAST, unsuppressed) --"
relaunch 071012002026
note "-- (i) GUI Today: C items PULLED IN (F-DL). NB: before the 'new to-dos' banner is"
note "   acknowledged they are COMPUTED overlays (start=2, startDate NULL); clicking the"
note "   banner OK MATERIALIZES them (start->1, startDate:=deadline, todayIndexReferenceDate:=deadline). --"
gsql "SELECT substr(title,1,14) title, start, startDate, deadline, deadlineSuppressionDate, todayIndexReferenceDate FROM TMTask WHERE title LIKE 'UPC-C%'" | tee -a "$REPORT"
shot today upc1c-today-s1-0710.png
aslist Today | tee -a "$REPORT"
note "   Someday list is now EMPTY of the C items — an UNSUPPRESSED past-due someday item"
note "   leaves the Someday list for Today (so a past-due item only appears in Someday if suppressed)."
aslist Someday | tee -a "$REPORT"
note ""
note "-- reach the SUPPRESSED state: reschedule the overdue items to a no-startDate bucket."
note "   to-do -> when=someday (update); project -> when=someday (update-PROJECT). Both stamp"
note "   deadlineSuppressionDate := deadline as a side effect (the 'dismissed nag'). --"
CTODO=$(uuidof UPC-C-SDTODO); CPROJ=$(uuidof UPC-C-SDPROJ)
url "things:///update?id=$CTODO&when=someday&auth-token=$TOKEN"
url "things:///update-project?id=$CPROJ&when=someday&auth-token=$TOKEN"; sleep 2
gsql "SELECT substr(title,1,14) title, type, start, startDate, deadline, deadlineSuppressionDate FROM TMTask WHERE title LIKE 'UPC-C%' ORDER BY title" | tee -a "$REPORT"
note "-- membership after suppression: OUT of Today, back IN Someday --"
note "Today:";   aslist Today   | tee -a "$REPORT"
note "Someday:"; aslist Someday | tee -a "$REPORT"
shot someday upc1c-someday-SUPPRESSED.png
note "   >>> VERDICT: suppressed past-due PROJECT renders a BLUE dashed circle; suppressed"
note "       past-due TO-DO stays GRAY. Both carry the red overdue flag. Blue == a PROJECT"
note "       with an OVERDUE deadline (accent-coloured progress ring) — NOT 'in Today'"
note "       (these are suppressed) and NOT 'suppressed per se' (the equally-suppressed"
note "       to-do is gray). Coherent indicator, not a bug."

##############################################################################
note ""; note "############ UPC1-D — re-arm (supp < deadline re-arms the pull) ############"
note "-- edit the suppressed project's deadline to a NEW future date 07-14 (supp < 07-14) --"
url "things:///update-project?id=$CPROJ&deadline=2026-07-14&auth-token=$TOKEN"; sleep 2
gsql "SELECT substr(title,1,14) title, start, startDate, deadline, deadlineSuppressionDate, (deadlineSuppressionDate IS NULL OR deadlineSuppressionDate<deadline) AS rearmed FROM TMTask WHERE title='UPC-C-SDPROJ'" | tee -a "$REPORT"
note "-- reappears in Upcoming (future deadline forecast), NOT in Today --"
aslist Upcoming | tee -a "$REPORT"
note ""; note "-- advance to 07-14 (new deadline arrives) --"
relaunch 071412002026
shot today upc1d-today-reentry-0714.png
note "-- re-enters Today at the new deadline --"; aslist Today | tee -a "$REPORT"
gsql "SELECT substr(title,1,14) title, start, startDate, deadline, deadlineSuppressionDate FROM TMTask WHERE title='UPC-C-SDPROJ'" | tee -a "$REPORT"

##############################################################################
note ""; note "== copying DB out =="
lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/upc1.sqlite"' </dev/null
lab_scp "$LAB_SSH_USER@$IP:/tmp/upc1.sqlite" "$OUT/final.sqlite" </dev/null 2>/dev/null || true
note "GREEN — report: $REPORT ; screenshots + final.sqlite in $OUT"
trap - EXIT; cleanup
