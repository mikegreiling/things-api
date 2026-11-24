# cen.sh — the UIFIX census, one pass (guest side, direct arm). Read-only AX except the
# synthetic-fixture setup and the census's own popover/picker opens (each dismissed).
source ~/g.sh
esc() { osascript -e 'tell application "System Events" to key code 53'; sleep 0.6; }
front() { osascript -e 'tell application "Things3" to activate'; sleep 1; }
echo "### Things $(defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString) ($(defaults read /Applications/Things3.app/Contents/Info CFBundleVersion))"

echo; echo "### A. to-do: Items ▸ Repeat submenu, active → pause → label sampling → resume → label sampling"
things todo add "UFC-TD" --when 2026-07-10 --json >/dev/null; sleep 2
U=$(uuid_of UFC-TD)
things todo make-repeating "$U" --frequency weekly --interval 1 --dangerously-drive-gui --json >/dev/null
T=$(tmpl_of UFC-TD); echo "template=$T"
open -g "things:///show?id=$T"; sleep 2
echo "-- active:"; cx menu Items | sed -n '/^Repeat/,/^[A-Z]/p'
things todo pause-repeat "$T" --dangerously-drive-gui --json >/dev/null; echo "paused=$(paused "$T") — label samples (Pause/Resume exists) immediately after the pause returned:"
bash ~/lbl.sh 8
echo "-- paused:"; cx menu Items | sed -n '/^Repeat/,/^[A-Z]/p'

echo; echo "### B. repeating project: the template view's rows, the repeat bar, its popover (active + paused)"
things area add UFC-AREA --json >/dev/null
things project add UFC-PJ --area UFC-AREA --when 2026-07-10 --todo UFC-PJ-CHILD --json >/dev/null; sleep 2
P=$(uuid_of UFC-PJ)
things project make-repeating "$P" --frequency weekly --interval 1 --dangerously-drive-gui --json >/dev/null
PT=$(dbq "SELECT uuid FROM TMTask WHERE title='UFC-PJ' AND type=1 AND trashed=0 AND rt1_recurrenceRule IS NOT NULL LIMIT 1"); echo "project template=$PT"
open -g "things:///show?id=$PT"; sleep 2; front
cx rows 4 3
echo "-- the 'Repeat …' element:"; osascript -l JavaScript ~/bar.jxa find
echo "-- Items menu with the template shown (Repeat present?):"; cx menu Items | grep -n "Repeat" || echo "(no Repeat item)"
osascript -l JavaScript ~/bar.jxa click-text >/dev/null; sleep 1
echo "-- windows after clicking the bar:"; cx windows
cx win 4 | sed -n '/RepeatingTaskPopUp\|AXWindow\/AXUnknown id=/,/AXStandardWindow/p' | grep -v '0x18\|AXImage @.* 2x2' | head -20
osascript -l JavaScript ~/pop.jxa Pause click; sleep 1.5; echo "after popover Pause: paused=$(paused "$PT")"
osascript -l JavaScript ~/bar.jxa find
osascript -l JavaScript ~/bar.jxa click-text >/dev/null; sleep 1
cx win 4 | sed -n '/AXWindow\/AXUnknown id=/,/AXStandardWindow/p' | grep -o 'd="[^"]*"' | head -8
esc

echo; echo "### C. heading ellipsis → Move… picker (rows, roles, typed filter)"
bash ~/hfix.sh UFCM
things project add UFCM-DEST --json >/dev/null; things project add UFCM-DEST-2 --json >/dev/null; sleep 1
HP=$(uuid_of UFCM-HP); open -g "things:///show?id=$HP"; sleep 2; front
cx rows 8 3 | grep 'More'
osascript -l JavaScript ~/clk.jxa row "More. UFCM-HP-H1"; sleep 1
cx windows
cx win 3 | sed -n '/AXWindow\/AXUnknown id=/,/AXScrollArea .*@[0-9]*,63/p' | grep -v '0x18\|AXImage @.* 2x2' | head -8
osascript -l JavaScript ~/clk.jxa win '*' "Move…"; sleep 1
cx windows
osascript -e 'tell application "System Events" to keystroke "UFCM-DEST"'; sleep 1
cx win 6 | sed -n '/MovePopUpDialog/,/AXStandardWindow/p' | grep -v '0x0\|AXImage @.* 2x2\|0x18' | head -30
esc; esc
cx windows
