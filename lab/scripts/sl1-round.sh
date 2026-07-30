#!/bin/bash
# SL1 Show-Latest round driver. Reuses the running sl1-lab VM.
#  1. read the instance matrix (ground truth BEFORE Show Latest)
#  2. re-select the repeating TEMPLATE (things:///show?id=<TPL>) so Items ▸ Repeat
#     ▸ Show Latest is available (AXVM1 recipe)
#  3. clear the pasteboard, click Items ▸ Repeat ▸ Show Latest (AX menu, by name)
#  4. read the PICK via TWO oracles:
#       o1 = Things AppleScript `id of selected to dos`
#       o2 = Copy Link -> pasteboard `things:///show?id=<uuid>`
# Args: LABEL.  Env: SEL (override the item to select before Show Latest; default TPL).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/sl1-lab"; REPORT="$OUT/report.txt"
source "$OUT/state.env"
note() { echo "[sl1] $*" | tee -a "$REPORT"; }
imatrix() { lab_ssh "$IP" "~/things-lab/helpers/imatrix.sh $1" </dev/null | tee -a "$REPORT"; }

LABEL="$1"; SEL="${SEL:-$TPL}"
note ""; note "############### SL1 ROUND: $LABEL (select=$SEL) ###############"
note "  --- instance matrix BEFORE Show Latest ---"; imatrix "$TPL"

# re-select the template (or override) and confirm the app frontmost + AX-usable
lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; open 'things:///show?id=$SEL'; sleep 3" </dev/null
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null || true
PRESEL=$(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "Things3" to get id of selected to dos'\'' 2>&1' </dev/null)
note "  pre-Show-Latest selection (should be the selected template/item): $PRESEL"

# clear pasteboard sentinel
lab_ssh "$IP" 'printf "SENTINEL-NOCHANGE" | pbcopy' </dev/null

# click Items ▸ Repeat ▸ Show Latest (AX by name)
SLRES=$(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to click menu item "Show Latest" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1'\'' 2>&1' </dev/null)
note "  Show Latest click result: ${SLRES:-<ok>}"
sleep 3

# oracle o1
O1=$(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "Things3" to get id of selected to dos'\'' 2>&1' </dev/null)
note "  PICK o1 (id of selected to dos): $O1"

# oracle o2 — Copy Link -> pasteboard
lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to click menu item "Copy Link" of menu 1 of menu item "Share…" of menu "Items" of menu bar 1'\'' 2>&1' </dev/null | sed 's/^/  [copylink] /' | tee -a "$REPORT"
sleep 2
O2=$(lab_ssh "$IP" 'pbpaste' </dev/null)
note "  PICK o2 (pasteboard): $O2"
note "  ROUND $LABEL PICK => o1=$O1 ; o2=$O2"
