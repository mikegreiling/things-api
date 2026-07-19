#!/bin/bash
# RSIM-S S2 — edge-state children established WHILE PLAIN (settable), then convert +
# spawn, to observe copy/skip/RESET at BOTH conversion and next-occurrence spawn.
# (Template children can't be given these states post-conversion — the app blocks it —
# so we bake them in before converting.) Reuses the running rsim-s-lab VM. Clock is at
# 2026-07-07; convert -> instance@07-07, next@07-08; advance +1 -> spawn @ 07-08.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/rsim-s-lab"; REPORT="$OUT/report.txt"
source "$OUT/state.env"
note() { echo "[rsims] $*" | tee -a "$REPORT"; }
gq() { lab_ssh "$IP" "~/things-lab/helpers/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
snap() { lab_ssh "$IP" 'python3 ~/things-lab/helpers/rsnap.py' </dev/null > "$OUT/snaps/$1.json"; note "  snap $1"; }
kids() { lab_ssh "$IP" "python3 ~/things-lab/helpers/kids.py $1" </dev/null | tee -a "$REPORT"; }
diff_c() { python3 "$OUT/diff_snaps.py" "$OUT/snaps/$1.json" "$OUT/snaps/$2.json" "${3:-}" | tee -a "$REPORT"; }
drive() { local l="$1"; shift; lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $* ; echo EXIT=\$?" </dev/null > "$OUT/drive-$l.log" 2>&1; { grep -m1 '"ok"' "$OUT/drive-$l.log" || grep -m1 '"error"\|error:' "$OUT/drive-$l.log" || echo '(no ok/err)'; } | sed "s/^/  [$l] /" | tee -a "$REPORT"; grep -m1 'EXIT=' "$OUT/drive-$l.log" | sed "s/^/  [$l] /" | tee -a "$REPORT"; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 16; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }
settle() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>/dev/null; sleep 3' </dev/null; }
nudge() { lab_ssh "$IP" "open 'things:///show?id=upcoming'; sleep 5; open 'things:///show?id=today'; sleep 8" </dev/null; }
uidp() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NULL AND rt1_repeatingTemplate IS NULL AND trashed=0 LIMIT 1"; }
uidt() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND rt1_repeatingTemplate IS NULL AND rt1_recurrenceRule IS NULL AND trashed=0 LIMIT 1"; }
tmplp() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND rt1_recurrenceRule IS NOT NULL AND trashed=0 LIMIT 1"; }

note ""; note "############### S2: edge-state children set WHILE PLAIN, then convert + spawn ###############"
drive S2seed project add \"RS2\" --todo \"RS2 Done\" --todo \"RS2 Cancel\" --todo \"RS2 Sched\" --todo \"RS2 Deadline\" --todo \"RS2 Someday\" --todo \"RS2 Plain\" --json
P2=$(uidp "RS2"); note "  seed RS2 uuid=$P2"
D=$(uidt "RS2 Done"); C=$(uidt "RS2 Cancel"); S=$(uidt "RS2 Sched"); DL=$(uidt "RS2 Deadline"); SM=$(uidt "RS2 Someday")
note "  set states while PLAIN (a normal project — these are settable):"
drive S2done   todo complete "$D" --json
drive S2cancel todo cancel   "$C" --json
drive S2sched  todo update   "$S" --when 2026-07-25 --json
drive S2deadl  todo update   "$DL" --deadline 2026-07-30 --json
drive S2someday todo update  "$SM" --when someday --json
note "  verify states landed (plain project):"
gq "SELECT title,status,startBucket,startDate,deadline FROM TMTask WHERE project='$P2' AND type=0 ORDER BY title" | sed 's/^/    /' | tee -a "$REPORT"
settle; snap s2-pre
note "  --- RS2 plain subtree ---"; kids "$P2"

note ""; note "############### S2: convert RS2 -> daily fixed repeating ###############"
warm
drive S2convert project make-repeating "$P2" --frequency daily --interval 1 --dangerously-drive-gui --json
settle; snap s2-post
note "  --- S2 conversion delta ---"; diff_c s2-pre s2-post "RS2"
T2=$(tmplp "RS2"); I2=$(gq "SELECT uuid FROM TMTask WHERE title='RS2' AND type=1 AND rt1_repeatingTemplate IS NOT NULL AND trashed=0 ORDER BY startDate LIMIT 1")
note "  RS2 template=$T2  instance=$I2"
note "  --- TEMPLATE-side RS2 subtree (did states copy / reset at conversion?) ---"; [ -n "$T2" ] && kids "$T2"
note "  --- template-side child states table ---"
gq "SELECT title,status,startBucket,startDate,deadline,trashed FROM TMTask WHERE project='$T2' AND type=0 ORDER BY title" | sed 's/^/    /' | tee -a "$REPORT"
echo "T2=$T2" >> "$OUT/state.env"; echo "I2=$I2" >> "$OUT/state.env"

note ""; note "############### S2: advance +1 -> 2026-07-08, spawn ###############"
settle
lab_ssh "$IP" 'sudo date 070812002026 >/dev/null' </dev/null
note "  clock now: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
warm; nudge; settle; snap s2-spawn
note "  --- S2 spawn delta (s2-post -> s2-spawn) ---"; diff_c s2-post s2-spawn "RS2"
NEWI2=$(gq "SELECT uuid FROM TMTask WHERE title='RS2' AND type=1 AND rt1_repeatingTemplate='$T2' AND uuid!='$I2' AND trashed=0 ORDER BY startDate DESC LIMIT 1")
if [ -n "$NEWI2" ]; then
  note "  *** S2 new instance spawned: $NEWI2 — subtree (states in the spawned occurrence?) ***"; kids "$NEWI2"
  note "  --- spawned-instance child states table ---"
  gq "SELECT title,status,startBucket,startDate,deadline,trashed,rt1_repeatingTemplate FROM TMTask WHERE project='$NEWI2' AND type=0 ORDER BY title" | sed 's/^/    /' | tee -a "$REPORT"
else
  note "  *** S2 NO new instance spawned. ***"
fi
note "  S2 done."
