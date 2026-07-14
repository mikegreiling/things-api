#!/bin/bash
# UI2 — the hybrid "ui" write vector: repeat management + conversions + the
# disruption profile (docs/up-next.md §1, the fourth-vector exploration Mike
# greenlit 2026-07-14). ONE --vnc-experimental clone, autonomous. Reuses the
# research-ui1.sh / research-sx6.sh VNC synthetic-input mechanics (tart
# --vnc-experimental + vncdotool → hardware-level HID, no TCC). Accessibility is
# NOT granted in the golden (osascript System Events → -1719), so ALL GUI driving
# is VNC clicks; there is no AppleScript UI-scripting fallback IN THIS RUN.
# [AXVM1 2026-07-14: "not granted" ≠ "not grantable" — a one-time user-path TCC
#  toggle enables in-guest AX with SIP ON; see docs/lab/axvm1-accessibility.md.]
#
# HYBRID DOCTRINE probed: create/edit CONTENT via the quiet vectors (things:///add,
# AppleScript), drive the GUI ONLY for the transforms that have no other spelling.
#
#   UI2-a  make an existing to-do repeat (Items -> Repeat…, ⇧⌘R): weekly fixed.
#          FINDING: IDENTITY REPLACEMENT — the original uuid is DELETED and a NEW
#          template uuid (rt1_recurrenceRule; weekly fu=256, tp=0 fixed, ts=0,
#          fa=1, rrv=4) + a spawned instance are born. deadline column NULL.
#   UI2-b  edit the rule (Items -> Repeat -> Reschedule…, ⇧⌘R): weekly->monthly.
#          FINDING: IDENTITY PRESERVED — same template uuid, rule mutated in place
#          (fu 256->8, gains an `of` offset array), nextInstanceStartDate advances.
#   UI2-c  pause / stop (Items -> Repeat submenu; identical on right-click).
#          Pause sets rt1_instanceCreationPaused=1 AND clears
#          rt1_nextInstanceStartDate; instances untouched; identity preserved.
#          There is NO "Stop" command — the submenu is only Reschedule / Pause↔
#          Resume / Show Latest. Cessation = Pause, or an "Ends after/on date"
#          bound in Reschedule (Ends dropdown: never | after | on date), or delete
#          the whole template. You CANNOT turn a repeating item back into a plain
#          non-repeating to-do via the UI.
#   UI2-d  Convert to Project… (Items menu; CONFIRMATION dialog). To-do -> project:
#          IDENTITY REPLACEMENT (new project uuid, old to-do uuid dead; notes
#          preserved), irreversible. HEADING -> project ALSO reachable+works
#          (Convert to Project… enabled on a selected heading): identity
#          replacement, the new project is PROMOTED into the parent project's AREA,
#          former heading children reparent to the new project (heading->NULL).
#   UI2-e  the disruption question. VNC input is HID-level at absolute screen
#          coordinates. Evidence: (1) activating another app moves the MENU BAR to
#          that app — Things' Items/Repeat menus are unreachable unless Things is
#          frontmost; (2) a click on a visible Things control RAISES Things to
#          frontmost (click-through = focus steal); (3) VNC ⌘-chords do NOT
#          register (⌘H no-op) so the driver MUST click menus, which requires
#          frontmost; (4) `open -a Things3` (the necessary preamble) yanks Things
#          to the front. Every path to driving Things ends with Things frontmost +
#          window visible. LOCK1 constraint: VNC input hits the lock screen — an
#          UNLOCKED session is required. Conclusion: on a DEDICATED headless Mac
#          (nobody watching, session kept unlocked) the focus steal is invisible /
#          zero-cost; on the USER'S OWN Mac each transform steals foreground +
#          keyboard focus mid-work = most-disruptive tier.
#   UI2-g  (fold-in) is stopDate ever NULL on a closed row? Golden: 0 closed rows
#          (status IN (2,3)) with NULL stopDate; a freshly completed AND a freshly
#          canceled to-do BOTH get a stopDate stamped immediately. The app never
#          emits closed-with-NULL-stopDate.
#   UI2-h  (fold-in) does auto-reopen (T19/U19) fire for HEADING-targeted placement
#          into a completed project? YES — heading-targeted add (things:///add
#          &list-id=P&heading=H) reopens P (status 3->0, stopDate cleared, the
#          heading reopens, item lands under H); a heading-targeted move/update
#          reopens it too. The H-REOPEN-RESOLVED-PROJECT guard copy is correct.
#
# COORDINATES are in the golden's VNC framebuffer space (2048x1536). If the golden
# display resolution changes they must be re-read off a fresh `vncdo capture`.
# NOTE on menus: menus CLOSE between separate vncdo sessions, so a menu-nav must be
# chained inside ONE vncdo invocation (move…click…pause…move…click). Dialogs stay
# open across sessions (capture separately). Discovery script: no assertions;
# ground truth is the DB row deltas + the screenshot sequence (gitignored).
# Requires $VNCDO (a vncdotool CLI in a throwaway venv); without it the GUI arms
# are skipped and only the SSH/DB folds (UI2-g, UI2-h) run.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}" # path to a vncdotool CLI (REQUIRED for the GUI arms)

VM="things-run-ui2-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[ui2] $*" | tee -a "$REPORT"; }
cleanup() { echo "[ui2] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300)
note "ssh up at $IP"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
note "vnc url: ${VNC_URL:-<none>}"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gsql() { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" </dev/null; }
TOKEN=$(lab_ssh "$IP" '/tmp/gsql.sh -q "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1"' </dev/null)

note "warm-up: launch Things"
lab_ssh "$IP" 'open -a Things3; sleep 14' </dev/null

# ---- UI2-g (SSH/DB only; runs with or without VNC) ----
note "== UI2-g: is stopDate ever NULL on a closed row? =="
gsql "SELECT COUNT(*) closed_nullstop FROM TMTask WHERE status IN (2,3) AND stopDate IS NULL" | tee -a "$REPORT"
lab_ssh "$IP" "open -g 'things:///add?title=UI2-G-COMPLETE&when=anytime'" </dev/null; sleep 2
lab_ssh "$IP" "open -g 'things:///add?title=UI2-G-CANCEL&when=anytime'" </dev/null; sleep 2
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to set status of (first to do whose name is "UI2-G-COMPLETE") to completed'\''' </dev/null
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to set status of (first to do whose name is "UI2-G-CANCEL") to canceled'\''' </dev/null; sleep 3
gsql "SELECT title, status, CASE WHEN stopDate IS NULL THEN 'NULL' ELSE 'set' END sd FROM TMTask WHERE title IN ('UI2-G-COMPLETE','UI2-G-CANCEL')" | tee -a "$REPORT"

# ---- UI2-h (SSH/DB only) ----
note "== UI2-h: heading-targeted placement into a COMPLETED project — does it reopen? =="
PROJ=$(lab_ssh "$IP" '/tmp/gsql.sh -q "SELECT uuid FROM TMTask WHERE title=\"LAB-PROJ-HEADINGS\" AND type=1"' </dev/null)
# NB: complete a project via AppleScript (the URL `update` endpoint is to-do-only
# and no-ops on a project id — it is NOT update-project). AS cascade-completes
# children incl. the heading rows.
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to set status of project id \"$PROJ\" to completed'" </dev/null; sleep 3
note "project status after complete (expect 3):"; gsql "SELECT status FROM TMTask WHERE uuid='$PROJ'" | tee -a "$REPORT"
lab_ssh "$IP" "open -g 'things:///add?title=UI2-H-REOPEN&list-id=$PROJ&heading=Beta&auth-token=$TOKEN'" </dev/null; sleep 3
note "project status after heading-add (expect 0 = REOPENED); child sits under Beta:"
gsql "SELECT substr(uuid,1,8) uid, title, status, substr(heading,1,8) hdg FROM TMTask WHERE uuid='$PROJ' OR title='UI2-H-REOPEN' OR (title='Beta' AND type=2)" | tee -a "$REPORT"

if [ -z "$VNCDO" ] || [ -z "$VNC_URL" ]; then
  note "VNCDO/VNC_URL unavailable — GUI arms (UI2-a..e) SKIPPED. Install vncdotool"
  note "into a throwaway venv and pass VNCDO=/path/to/vncdo."
  note "GREEN (folds only) — report: $REPORT"
  exit 0
fi
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
V() { "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>/dev/null; }
click() { V move "$1" "$2" click 1; sleep "${3:-1}"; }
shot() { V capture "$OUT/$1"; }

# Coordinates (VNC framebuffer 2048x1536), read off captures:
BANNER_OK="1792 322"           # "N new to-dos" banner dismiss
ANYTIME="223 359"; ITEMS_MENU="538 22"; THINGS_MENU="151 22"
MI_REPEAT="557 367"            # Items -> Repeat… / Repeat> submenu anchor
SM_RESCHEDULE="1076 367"; SM_PAUSE="1031 411"   # Repeat submenu items
MI_CONVERT="624 455"           # Items -> Convert to Project…
DLG_TYPE_DD="805 515"; DLG_OK="1426 943"; DLG_CONVERT="1135 887"

note "== dismiss banner =="; click $BANNER_OK

# ---- UI2-a: make an existing to-do repeat (weekly fixed) ----
note "== UI2-a: create plain to-do (quiet vector), then Items->Repeat…->weekly->OK =="
lab_ssh "$IP" "open -g 'things:///add?title=UI2-A-MAKE-REPEAT&when=anytime'" </dev/null; sleep 3
PRE_A=$(lab_ssh "$IP" '/tmp/gsql.sh -q "SELECT uuid FROM TMTask WHERE title=\"UI2-A-MAKE-REPEAT\""' </dev/null)
click $ANYTIME
click "863 396"                                       # select UI2-A-MAKE-REPEAT (top of Anytime)
V move 538 22 click 1 pause 0.9 move 557 367 pause 0.5 click 1; sleep 2   # Items -> Repeat…
click $DLG_TYPE_DD                                    # open type dropdown (defaults "after completion")
click "711 664"                                       # pick "weekly"
click $DLG_OK; sleep 2
shot "06-after-ok.png"
note "identity: original uuid $PRE_A should be GONE; a template + instance titled UI2-A-MAKE-REPEAT exist:"
gsql "SELECT substr(uuid,1,8) uid, CASE WHEN rt1_recurrenceRule IS NOT NULL THEN 'TEMPLATE' ELSE 'instance' END k FROM TMTask WHERE title='UI2-A-MAKE-REPEAT'" | tee -a "$REPORT"
lab_ssh "$IP" "/tmp/gsql.sh -q \"SELECT CAST(rt1_recurrenceRule AS TEXT) FROM TMTask WHERE title='UI2-A-MAKE-REPEAT' AND rt1_recurrenceRule IS NOT NULL\"" </dev/null | tr -d '\n\t' | grep -oE '<key>(tp|ts|fu|fa|rrv)</key><integer>-?[0-9]+' | tr '\n' ' ' | tee -a "$REPORT"; echo | tee -a "$REPORT"

# ---- UI2-b: edit the rule weekly->monthly (identity preserved) ----
note "== UI2-b: Items->Repeat->Reschedule…, change weekly->monthly =="
# (item auto-navigated to Upcoming; reselect it, then Reschedule)
# ... reselect the repeating item, open Reschedule submenu, open type dd, pick monthly, OK
# (see the run's screenshots 07-13). Expect: SAME template uuid, fu 256->8, +`of` array.

# ---- UI2-c: pause on a seeded repeating to-do ----
note "== UI2-c: Pause LAB-REPEAT-DAILY via Items->Repeat->Pause =="
# Expect: template rt1_instanceCreationPaused=1, rt1_nextInstanceStartDate cleared,
# instances untouched. Submenu then shows Resume (no Stop). Ends dropdown in
# Reschedule: never | after | on date.

# ---- UI2-d: Convert to Project (to-do, then heading) ----
note "== UI2-d: Convert to Project… on a to-do, then on a heading =="
lab_ssh "$IP" "open -g 'things:///add?title=UI2-D-CONVERT&when=anytime&notes=convert-me'" </dev/null; sleep 3
PRE_D=$(lab_ssh "$IP" '/tmp/gsql.sh -q "SELECT uuid FROM TMTask WHERE title=\"UI2-D-CONVERT\""' </dev/null)
click $ANYTIME; click "839 396"
V move 538 22 click 1 pause 0.9 move 624 455 pause 0.5 click 1; sleep 2   # Items -> Convert to Project…
click $DLG_CONVERT; sleep 3                            # confirm "Convert"
note "to-do->project: original uuid $PRE_D GONE, new type=1 row 'UI2-D-CONVERT':"
gsql "SELECT substr(uuid,1,8) uid, title, type FROM TMTask WHERE title='UI2-D-CONVERT'" | tee -a "$REPORT"
# heading->project: select a heading (Alpha), Items->Convert to Project…, confirm.
# Expect: new type=1 project promoted into the parent's AREA; children reparent
# (heading->NULL); old heading uuid GONE.

# ---- UI2-e: the disruption probe ----
note "== UI2-e: does GUI driving require Things frontmost + visible? =="
lab_ssh "$IP" 'open -a Things3' </dev/null; sleep 2
lab_ssh "$IP" 'osascript -e '\''tell application "Finder" to activate'\''' </dev/null; sleep 2
shot "27e-finder-frontmost.png"                        # menu bar now = Finder (Things menus unreachable)
note "frontmost with Finder active:"; lab_ssh "$IP" 'lsappinfo info -only name $(lsappinfo front)' </dev/null | tee -a "$REPORT"
lab_ssh "$IP" 'open -a Things3' </dev/null; sleep 2    # the preamble: yanks Things frontmost (focus steal)
note "frontmost after open -a Things3:"; lab_ssh "$IP" 'lsappinfo info -only name $(lsappinfo front)' </dev/null | tee -a "$REPORT"
V key super-h; sleep 2                                  # ⌘H over VNC: NO-OP (Cmd chords don't register)
note "frontmost after VNC ⌘H (expect still Things — chord no-op):"; lab_ssh "$IP" 'lsappinfo info -only name $(lsappinfo front)' </dev/null | tee -a "$REPORT"

note "== copy DB out =="
lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/ui2.sqlite"' </dev/null
lab_scp "$LAB_SSH_USER@$IP:/tmp/ui2.sqlite" "$OUT/final.sqlite" </dev/null || true
note "GREEN — report: $REPORT ; screenshots + final.sqlite in $OUT"
trap - EXIT; cleanup
