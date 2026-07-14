#!/bin/bash
# UI1 — the §E½ UI-vector feasibility probe + the deadline-less-repeat
# discriminator follow-up (docs/up-next.md §2/§5). ONE clone, --vnc-experimental.
# Reuses the research-sx6.sh VNC synthetic-input mechanics (tart --vnc-experimental
# + vncdotool → hardware-level HID, no TCC). Accessibility is NOT granted in the
# golden image (osascript System Events → -1719), so ALL GUI driving is VNC clicks
# + VNC keyboard; there is no AppleScript UI-scripting fallback IN THIS RUN.
# [AXVM1 2026-07-14: "not granted" ≠ "not grantable" — a one-time user-path TCC
#  toggle enables in-guest AX with SIP ON; see docs/lab/axvm1-accessibility.md.]
#
#   A (§E½ feasibility): VNC-drive File → New Repeating To-Do end-to-end, create a
#       FIXED daily repeat (deadline-less, the GUI default), save, verify an
#       rt1_recurrenceRule row lands (tp=0 fixed, fu=16 daily, ts=0, of=[{dy:0}],
#       rrv=4). VERDICT: FEASIBLE — see docs/lab/s-campaign-results.md (UI1).
#   B (discriminator): create (1) deadline-less fixed daily, (2) deadlined
#       offset-0, (3) deadlined offset-3 (typed into the "days earlier" field —
#       the datapoint DLREPEAT could not capture), plus after-completion nodl/dl.
#       Dump each template's rt1_recurrenceRule + deadline + t2_deadlineOffset and
#       diff. FINDING: the TEMPLATE row's own `deadline` COLUMN is the
#       discriminator (NULL = deadline-less, 4001-01-01 sentinel = deadlined);
#       nonzero offset also shows as ts=−N in the rule; t2_deadlineOffset stays 0.
#
# COORDINATES are in the golden's VNC framebuffer space (2048x1536). If the golden
# display resolution changes they must be re-read off a fresh `vncdo capture`.
# Discovery: no assertions. Requires $VNCDO (a vncdotool CLI); without it the run
# can only capture the sheet and stops (manual clicks needed).
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}" # path to a vncdotool CLI (REQUIRED for the GUI arms)

VM="things-run-ui1-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[ui1] $*" | tee -a "$REPORT"; }
cleanup() { echo "[ui1] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

REPEAT_DAILY="W3PZB9e7W6BEtKmEKP4deG" # seeded LAB-REPEAT-DAILY (deadline-less control)

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

note "warm-up: launch Things (recomputes Today/instances for the pinned date)"
lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null

if [ -z "$VNCDO" ] || [ -z "$VNC_URL" ]; then
  note "VNCDO/VNC_URL unavailable — cannot drive the GUI. Install vncdotool into a"
  note "throwaway venv and pass VNCDO=/path/to/vncdo. Aborting GUI arms."
  exit 0
fi
HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
V() { "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>/dev/null; }
click() { V move "$1" "$2" click 1; sleep "${3:-1}"; }
shot() { V capture "$OUT/$1"; }

# Coordinates (VNC framebuffer 2048x1536):
FILE_MENU="255 22"; NEW_REPEATING="369 127"
REPEAT_DD="808 556"; OPT_DAILY="698 623"
CHK_DL_DAILY="558 886"; CHK_DL_AFTERCOMP="558 844"; OFF_FIELD="914 888"
OK_TALL="1432 947"; OK_SHORT="1432 905"; BANNER_OK="1799 325"

note "== dismiss the 'N new to-dos' banner (pinned-date recompute) =="
click $BANNER_OK

mktmpl() { # mktmpl <title> <kind: daily|daily-dl0|daily-dl3|ac|ac-dl>
  local title="$1" kind="$2"
  click $FILE_MENU; click $NEW_REPEATING 2
  case "$kind" in
    daily|daily-dl0|daily-dl3)
      click $REPEAT_DD; click $OPT_DAILY ;;
  esac
  case "$kind" in
    daily-dl0) click $CHK_DL_DAILY ;;
    daily-dl3) click $CHK_DL_DAILY; click $OFF_FIELD
               for i in 1 2 3 4 5 6; do V key bsp; done
               for i in 1 2 3 4 5 6; do V key del; done
               V type 3; sleep 1 ;;
    ac-dl)     click $CHK_DL_AFTERCOMP ;;
  esac
  case "$kind" in
    ac|ac-dl) click $OK_SHORT 2 ;;   # after-completion dialog is shorter
    *)        click $OK_TALL 2 ;;
  esac
  V type "$title"; sleep 1
  V key esc; sleep 1
}

note "== [A] FIXED daily, deadline-LESS (GUI default) — the §E½ headline =="
mktmpl "UI-A-FIXED-DAILY-NODL" daily
note "== [B] deadlined offset 0 / offset 3 (nonzero typed into the field) =="
mktmpl "UI-B-DEADLINED-OFF0" daily-dl0
mktmpl "UI-B-DEADLINED-OFF3" daily-dl3
note "== [B'] after-completion nodl / deadlined (discriminator generality) =="
mktmpl "UI-C-AFTERCOMP-NODL" ac
mktmpl "UI-C-AFTERCOMP-DL" ac-dl
shot "final-templates.png"

note "== DISCRIMINATOR: template deadline column (NULL vs 4001-01-01 sentinel) =="
gsql "SELECT substr(uuid,1,6) uid, title, type ty, deadline, CASE WHEN deadline IS NULL THEN 'deadline-LESS' ELSE 'DEADLINED' END verdict, t2_deadlineOffset t2do, (rt1_recurrenceRule IS NOT NULL) tmpl FROM TMTask WHERE title LIKE 'ui-%' OR title='LAB-REPEAT-DAILY' ORDER BY title, tmpl DESC" | tee -a "$REPORT"
note "-- seeded deadline-less control LAB-REPEAT-DAILY should read deadline NULL --"

note "== rt1_recurrenceRule per template (ts=0 collide; offset-3 => ts=-3) =="
for t in UI-A-FIXED-DAILY-NODL UI-B-DEADLINED-OFF0 UI-B-DEADLINED-OFF3; do
  echo "----- $t -----" | tee -a "$REPORT"
  lab_ssh "$IP" "/tmp/gsql.sh -q \"SELECT rt1_recurrenceRule FROM TMTask WHERE title='$t' AND rt1_recurrenceRule IS NOT NULL\"" </dev/null 2>&1 \
    | tr -d '\n\t' | grep -oE '<key>(tp|ts|fu|fa)</key><integer>-?[0-9]+' | tr '\n' ' ' | tee -a "$REPORT"; echo | tee -a "$REPORT"
done

note "== copying DB out =="
lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/ui1.sqlite"' </dev/null
lab_scp "$LAB_SSH_USER@$IP:/tmp/ui1.sqlite" "$OUT/final.sqlite" </dev/null || true
note "GREEN — report: $REPORT ; screenshots + final.sqlite in $OUT"
trap - EXIT; cleanup
