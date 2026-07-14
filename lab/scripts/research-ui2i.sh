#!/bin/bash
# UI2-i — the hidden "Stop" action: where it lives and what it does.
#
# Mike FALSIFIED the UI2-c verdict ("no Stop command exists") with GUI
# screenshots (2026-07-14): Stop DOES exist, in EXACTLY ONE place — open the
# to-do CARD (double-click the row), click the "↻ Repeat every …" bar, and the
# popover shows Change… / Pause / Stop / Show Latest. UI2 drove only the Items
# menu and the row CONTEXT menu (both of which genuinely lack Stop), so it
# missed the card-only surface. This script corroborates the asymmetry and
# characterizes Stop's DB semantics.
#
#   UI2-i1  asymmetry: the row context-menu Repeat submenu (Reschedule… / Pause /
#           Show Latest — NO Stop) vs the open-card repeat-bar popover (Change… /
#           Pause / STOP / Show Latest). Screenshots i-13 (submenu) + i-15 (popover).
#   UI2-i2  Stop semantics (headline). Stop on a fixed-rule template that has a
#           spawned instance:
#           FINDING — Stop is CONFIRMATION-GUARDED ("Stop To-Do from Repeating —
#           Are you sure…?", Cancel / Stop) AND is an IDENTITY REPLACEMENT that
#           UN-REPEATS: the template uuid is HARD-DELETED (not trashed) and
#           REPLACED by a NEW PLAIN to-do (rt1_recurrenceRule = NULL — the rule is
#           fully cleared, NOT an end-bounded rule). rt1_nextInstanceStartDate /
#           rt1_instanceCreationPaused die with the template (the replacement plain
#           row carries only inert defaults). The already-spawned instance SURVIVES
#           untouched as an independent plain to-do. uuid NOT preserved.
#           => "un-repeat back to a plain to-do" DOES exist (UI2-c was wrong), but
#           as identity replacement, exactly like make-repeat (UI2-a).
#   UI2-i3  Stop vs Pause→Resume: Stop is TERMINAL. The demoted card is a plain
#           to-do with NO repeat bar → no popover, no Resume. (Contrast UI2-c Pause:
#           keeps template + rule, offers Resume.) The only way back is to make it
#           repeat again from scratch (another identity replacement).
#   UI2-i4  reachability recipe (the ONLY way to reach Stop, for the ui vector):
#           DOUBLE-CLICK the row title → the card opens in place → CLICK the
#           "↻ Repeat every …" bar → popover with Stop. Confirmed VNC-drivable.
#
# MECHANICS (learned the hard way this run; reuse for any card/popover driving):
#  * tart --vnc-experimental is a SINGLE-CLIENT RFB server. Rapid back-to-back
#    vncdo PROCESSES wedge it (a capture then hangs; a 2-min hang SIGTERMs the
#    client and can leave the server unable to serve a fresh framebuffer). RULE:
#    one vncdo invocation per logical step, ALWAYS wrapped in `timeout`, with a
#    ~3s settle before a capture. If it wedges, restart `tart run` (disk state
#    persists) for a fresh VNC port — but re-pin the clock and RE-INSTALL /tmp
#    helpers (a reboot clears /tmp).
#  * Menus/popovers CLOSE between vncdo sessions; a menu-nav must be chained
#    INSIDE ONE invocation (move…click…pause…click / …capture).
#  * The Repeat-dialog TYPE dropdown ("after completion") is picked with KEYBOARD
#    ARROWS, not a second click: open it, then `key down`×N + `key return`
#    (after completion=0, daily=1, weekly=2, monthly=3, yearly=4). A second CLICK
#    fires before the popup renders and lands on the underlying control.
#  * VNC framebuffer 2048×1536; coords below are framebuffer px.
#
# This is a DISCOVERY script (adaptive driving; no assertions). Ground truth is
# the DB row deltas + the screenshot sequence (gitignored under the run dir).
# Requires $VNCDO (a vncdotool CLI in a throwaway venv) + sshpass.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}" # path to a vncdotool CLI (REQUIRED)

VM="things-run-ui2i-$(date +%Y%m%d-%H%M%S)"
OUT="$PWD/lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[ui2i] $*" | tee -a "$REPORT"; }
cleanup() {
  echo "[ui2i] teardown: $VM"
  # kill the detached `tart run` first so the VM can be deleted
  ps aux | grep "tart run $VM" | grep -v grep | awk '{print $2}' | xargs -r kill 2>/dev/null || true
  sleep 2
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ -z "$VNCDO" ]; then
  note "VNCDO unavailable — this campaign is ENTIRELY GUI-driven (the Stop popover"
  note "has no non-GUI spelling). Install vncdotool into a throwaway venv and pass"
  note "VNCDO=/path/to/vncdo. Aborting."
  exit 0
fi

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
gsql()  { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")"    </dev/null; }
gsqlq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
# ONE vncdo invocation per step, always timeout-wrapped; settle before captures.
V()     { sleep 1; timeout 40 "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>/dev/null; }
shot()  { sleep 3; timeout 25 "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} capture "$OUT/$1" 2>/dev/null; }

note "warm-up: launch Things"
lab_ssh "$IP" 'open -a Things3; sleep 14' </dev/null
V move 1799 324 click 1   # dismiss the "N new to-dos" banner

# ---- Build a fixed-weekly TEMPLATE via the UI2-a path (clean future instance) ----
note "== seed: create plain to-do, then Items->Repeat…->weekly (fixed) =="
lab_ssh "$IP" "open -g 'things:///add?title=UI2I-STOP&when=anytime'" </dev/null; sleep 3
note "BEFORE make-repeat, plain uuid:"; gsqlq "SELECT uuid FROM TMTask WHERE title='UI2I-STOP'" | tee -a "$REPORT"
V move 205 360 click 1                                   # Anytime
V move 783 397 click 1 pause 1.2 move 538 22 click 1     # select row, open Items menu
V move 560 369 click 1                                   # Items -> Repeat… (dialog opens)
# type dropdown -> weekly via KEYBOARD ARROWS (down x2 + return):
V move 806 556 click 1 pause 1.5 key down pause 0.5 key down pause 0.5 key return
shot "i-10-weeklyset.png"
V move 1430 946 click 1                                   # OK
sleep 2
note "AFTER make-repeat (expect original uuid GONE; TEMPLATE + instance, deadline NULL):"
gsql "SELECT substr(uuid,1,8) uid, CASE WHEN rt1_recurrenceRule IS NOT NULL THEN 'TEMPLATE' ELSE 'instance' END k, status, CASE WHEN deadline IS NULL THEN 'NULL' ELSE 'set' END dl FROM TMTask WHERE title='UI2I-STOP'" | tee -a "$REPORT"
TPL=$(gsqlq "SELECT uuid FROM TMTask WHERE title='UI2I-STOP' AND rt1_recurrenceRule IS NOT NULL")
note "template rule bytes (expect fu=256 weekly, tp=0 fixed, +of Sunday array):"
gsqlq "SELECT CAST(rt1_recurrenceRule AS TEXT) FROM TMTask WHERE uuid='$TPL'" | tr -d '\n\t' | grep -oE '<key>(tp|ts|fu|fa|rrv|ed|of)</key>(<integer>-?[0-9]+|<array)' | tr '\n' ' ' | tee -a "$REPORT"; echo | tee -a "$REPORT"

# ---- UI2-i1a: the ROW CONTEXT MENU Repeat submenu (NO Stop) ----
note "== UI2-i1a: right-click row -> Repeat submenu (expect Reschedule/Pause/Show Latest; NO Stop) =="
# item is on its next instance date in Upcoming after OK; row near bottom.
V move 814 1317 click 3 pause 1.2 move 883 1008 pause 1.5 capture "$OUT/i-13-ctx-repeat-submenu.png"

# ---- UI2-i1b + i4: open the CARD, click the repeat BAR -> popover WITH Stop ----
note "== UI2-i1b/i4: double-click row -> card -> click repeat bar -> popover (expect Stop) =="
V key esc pause 1 move 900 1317 click 1 click 1          # esc menu, double-click row title -> card opens
shot "i-14-card-open.png"
V move 950 1151 click 1 pause 1.5 capture "$OUT/i-15-repeatbar-popover.png"  # click "↻ Repeat every …" bar

# ---- UI2-i2: click Stop (confirmation-guarded), dump BEFORE/AFTER ----
note "== UI2-i2: click Stop (expect confirmation dialog) =="
V move 778 1337 click 1                                   # Stop in popover
shot "i-16-after-stop.png"                                # the "Stop To-Do from Repeating" confirm
note "BEFORE-confirm rows (rule still present — confirm pending):"
gsql "SELECT substr(uuid,1,8) uid, CASE WHEN rt1_recurrenceRule IS NOT NULL THEN 'RULE' ELSE 'plain' END k FROM TMTask WHERE title='UI2I-STOP'" | tee -a "$REPORT"
V move 1140 890 click 1                                    # confirm Stop
sleep 2
note "AFTER Stop CONFIRMED — template uuid $TPL should be HARD GONE (not trashed):"
gsql "SELECT substr(uuid,1,8) uid, trashed, status FROM TMTask WHERE uuid='$TPL'" | tee -a "$REPORT"
note "surviving UI2I-STOP rows (expect a NEW plain row rule=NULL + the surviving instance):"
gsql "SELECT substr(uuid,1,8) uid, start, CASE WHEN startDate IS NULL THEN 'NULL' ELSE 'set' END sd, status, CASE WHEN rt1_recurrenceRule IS NULL THEN 'NULL' ELSE 'PRESENT' END rule, rt1_instanceCreationPaused pz FROM TMTask WHERE title='UI2I-STOP'" | tee -a "$REPORT"

# ---- UI2-i3: Stop is terminal — demoted card has NO repeat bar (no Resume) ----
note "== UI2-i3: open demoted card (expect plain to-do, NO repeat bar / no Resume) =="
V move 205 360 click 1                                     # Anytime
V move 850 397 click 1 click 1 pause 1.5 capture "$OUT/i-19-plaincard.png"  # double-click demoted UI2I-STOP

note "== copy DB out =="
lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/ui2i.sqlite"' </dev/null
lab_scp "$LAB_SSH_USER@$IP:/tmp/ui2i.sqlite" "$OUT/final.sqlite" </dev/null || true
note "GREEN — report: $REPORT ; screenshots + final.sqlite in $OUT"
trap - EXIT; cleanup
