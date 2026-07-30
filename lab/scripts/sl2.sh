#!/bin/bash
# SL2 dispatcher — drives the running sl2-lab VM set up by research-sl2.sh.
# All writes go through official surfaces only:
#   trash    UUID   AppleScript `delete to do id X`         (move to Trash; trashed=1)
#   restore  UUID   AppleScript `move to do id X to "Inbox"`(scripted Put Back, E15)
#   empty           AppleScript `empty trash`               (GLOBAL hard delete)
#   complete UUID   URL scheme  update?completed=true       (fire after-completion spawn)
#   convert  UUID [ac]  CLI ui-vector make-repeating (fixed | after-completion)
#   putback  VNCROW    GUI Put Back via VNC right-click in the Trash view (faithful)
# Reads:
#   imatrix TPL / tmatrix TPL / sel / tomb UUID / uuidof T / tmplof T
# Clock:
#   clock DAY LABEL  (+1-day RSIM-S increments; warm relaunch + Upcoming/Today nudge)
# Show Latest:
#   showlatest TPL   select template, report menu ENABLED state, click, read oracle
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/sl2-lab"; REPORT="$OUT/report.txt"
source "$OUT/state.env"
VNCDO="${VNCDO:-}"
note() { echo "[sl2] $*" | tee -a "$REPORT"; }
gq() { lab_ssh "$IP" "~/things-lab/helpers/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
imatrix() { lab_ssh "$IP" "~/things-lab/helpers/imatrix.sh $1" </dev/null | tee -a "$REPORT"; }
tmatrix() { lab_ssh "$IP" "~/things-lab/helpers/tmatrix.sh $1" </dev/null | tee -a "$REPORT"; }
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
nudge() { lab_ssh "$IP" "open 'things:///show?id=upcoming'; sleep 5; open 'things:///show?id=today'; sleep 8" </dev/null; }
sel() { lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "Things3" to get id of selected to dos'\'' 2>&1' </dev/null; }
uuidof() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
tmplof() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND rt1_recurrenceRule IS NOT NULL LIMIT 1"; }

CMD="${1:-}"; shift || true
case "$CMD" in
  imatrix) imatrix "$1" ;;
  tmatrix) note "  tmatrix $1:"; tmatrix "$1" ;;
  sel)     note "  id of selected to dos: $(sel)" ;;
  uuidof)  uuidof "$1" ;;
  tmplof)  tmplof "$1" ;;

  add)  # add TITLE -> create plain to-do, echo uuid
    lab_ssh "$IP" "open 'things:///add?title=$(printf '%s' "$1" | sed 's/ /%20/g')&auth-token=$AUTH'; sleep 3" </dev/null
    U=$(uuidof "$1"); note "  add '$1' -> $U"; echo "$U" ;;

  convert)  # convert UUID [ac]  (ac => after-completion)
    U="$1"; MODE="${2:-fixed}"; warm
    if [ "$MODE" = "ac" ]; then
      note "  make-repeating AFTER-COMPLETION daily/1 on $U"
      G todo make-repeating "$U" --frequency daily --interval 1 --after-completion --dangerously-drive-gui --json 2>&1 | tee -a "$REPORT"
    else
      note "  make-repeating FIXED daily/1 on $U"
      G todo make-repeating "$U" --frequency daily --interval 1 --dangerously-drive-gui --json 2>&1 | tee -a "$REPORT"
    fi
    settle ;;

  clock)  # clock DAY LABEL
    DAY="$1"; LABEL="$2"
    note ""; note "### clock advance -> $DAY ($LABEL) ###"
    settle
    lab_ssh "$IP" "sudo date $DAY >/dev/null" </dev/null
    note "  clock now: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
    warm; nudge; settle
    note "  done $LABEL." ;;

  trash)  # trash UUID  (AppleScript delete = move to Trash)
    U="$1"
    R=$(lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"Things3\" to delete to do id \"$U\"' 2>&1" </dev/null)
    note "  trash $U -> ${R:-<ok>}  now: $(gq "SELECT 'trashed='||trashed||' status='||status FROM TMTask WHERE uuid='$U'")" ;;

  restore)  # restore UUID  (scripted Put Back: move to Inbox, E15)
    U="$1"
    R=$(lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"Things3\" to move to do id \"$U\" to list \"Inbox\"' 2>&1" </dev/null)
    note "  restore(move->Inbox) $U -> ${R:-<ok>}  now: $(gq "SELECT 'trashed='||trashed||' status='||status||' start='||start FROM TMTask WHERE uuid='$U'")" ;;

  empty)  # empty  (AppleScript empty trash — GLOBAL)
    note "  trashed rows BEFORE empty: $(gq 'SELECT count(*) FROM TMTask WHERE trashed=1')"
    R=$(lab_ssh "$IP" "/usr/bin/osascript -e 'tell application \"Things3\" to empty trash' 2>&1" </dev/null)
    sleep 2
    note "  empty trash -> ${R:-<ok>}  trashed rows AFTER: $(gq 'SELECT count(*) FROM TMTask WHERE trashed=1')" ;;

  complete)  # complete UUID  (URL scheme)
    U="$1"
    lab_ssh "$IP" "open 'things:///update?id=$U&completed=true&auth-token=$AUTH'; sleep 3" </dev/null
    note "  complete $U -> now: $(gq "SELECT 'status='||status||' trashed='||trashed FROM TMTask WHERE uuid='$U'")" ;;

  tomb)  # tomb UUID  (TMTombstone lookup + leavesTombstone snapshot pre-delete)
    U="$1"
    note "  leavesTombstone on $U (pre-delete): $(gq "SELECT COALESCE((SELECT leavesTombstone FROM TMTask WHERE uuid='$U'),'ROW-GONE')")"
    note "  TMTombstone rows for $U: $(gq "SELECT count(*) FROM TMTombstone WHERE deletedObjectUUID='$U'")"
    note "  TMTombstone total: $(gq 'SELECT count(*) FROM TMTombstone')" ;;

  showlatest)  # showlatest TPL
    TPL="$1"
    note ""; note "### Show Latest on template $TPL ###"
    note "  --- instance matrix BEFORE ---"; imatrix "$TPL"
    lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; open 'things:///show?id=$TPL'; sleep 3" </dev/null
    lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null || true
    note "  pre-selection (should be the template): $(sel)"
    EN=$(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to get enabled of menu item "Show Latest" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1'\'' 2>&1' </dev/null)
    note "  Show Latest menu-item ENABLED = $EN"
    R=$(lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to click menu item "Show Latest" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1'\'' 2>&1' </dev/null)
    note "  click result: ${R:-<ok>}"; sleep 3
    P=$(sel); note "  PICK (id of selected to dos): $P"
    if [ -n "$P" ]; then
      note "  PICK row facts: $(gq "SELECT 'trashed='||trashed||' status='||status||' created='||CAST(creationDate AS INT) FROM TMTask WHERE uuid='$P'")"
    fi ;;

  putback)  # putback VNCX VNCY  — GUI Put Back via VNC right-click in Trash view
    X="$1"; Y="$2"
    [ -x "$VNCDO" ] || { note "FATAL: VNCDO not set"; exit 1; }
    HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
    V() { timeout 40 "$VNCDO" -s "$SERVER" -p "$PASS" "$@" 2>>"$OUT/vnc.log"; }
    lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; open 'things:///show?id=trash'; sleep 3" </dev/null
    V capture "$OUT/snaps/putback-before.png"
    note "  right-click trash row @ $X,$Y then Put Back (top of context menu)"
    # click the row, right-click to open context menu, click Put Back item just below cursor
    V move "$X" "$Y" click 1 pause 0.5 click 3 pause 1
    V capture "$OUT/snaps/putback-menu.png"
    # Put Back is the top item; approx +30px down from cursor. Caller may re-run with menu coords.
    V move "$3" "$4" click 1 pause 1.5
    sleep 1
    V capture "$OUT/snaps/putback-after.png"
    note "  putback done (see snaps/putback-*.png)" ;;

  capture)  # capture NAME
    HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
    timeout 40 "$VNCDO" -s "$SERVER" -p "$PASS" capture "$OUT/snaps/$1.png" 2>>"$OUT/vnc.log"
    note "  captured snaps/$1.png" ;;

  *) echo "usage: sl2.sh {imatrix|tmatrix|sel|uuidof|tmplof|add|convert|clock|trash|restore|empty|complete|tomb|showlatest|putback|capture} ..." ;;
esac
