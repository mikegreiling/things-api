#!/bin/bash
# TAGMOD — userModificationDate (umd) side-effects of tag + area lifecycle ops,
# and whether AppleScript `set modification date` enables a capture-and-restore
# recipe. Knowledge/evidence campaign — DB row bytes are the ground truth (no
# assertions). ONE disposable clone `tagmod-lab` of things-lab-golden-v2
# (Things 3.22.12). Airgapped, clock-pinned. No AX/VNC needed.
#
#   research-tagmod.sh setup       clone+boot+airgap+clock-pin+ship CLI+seed
#   research-tagmod.sh t1          tag apply/remove umd (CLI url+as, AS, URL)
#   research-tagmod.sh t2          tag rename umd (CLI + raw AS set name of tag)
#   research-tagmod.sh t3          tag delete umd (leaf + parent subtree)
#   research-tagmod.sh t4          area delete umd + FK fate
#   research-tagmod.sh t5          set modification date: stick/relaunch/restore
#   research-tagmod.sh t6          do TAG / AREA own rows bump umd
#   research-tagmod.sh dump        full task/tag/area state dump
#   research-tagmod.sh teardown    stop + delete the clone
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; source "$HERE/env.sh"
REPO="$(cd "$HERE/../.." && pwd)"
VM="tagmod-lab"; CMD="${1:-}"; shift || true
OUT="$HERE/../artifacts/tagmod-lab"; mkdir -p "$OUT/fp"
SESSION="$OUT/session.env"; REPORT="$OUT/report.txt"
GOLDEN="things-lab-golden-v2"
AUTH="9dFi9fY-QBuqFq59yAUxOg"   # golden-v2 Enable-Things-URLs token (metadata)

note() { echo "[tagmod] $*" | tee -a "$REPORT"; }
load_session() { [ -f "$SESSION" ] && source "$SESSION"; : "${IP:?run setup first}"; }
# DB reads (read-only) --------------------------------------------------------
gq()   { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }        # scalar/list
gqh()  { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" </dev/null; }           # table
gql()  { lab_ssh "$IP" "/tmp/gsql.sh -line $(printf '%q' "$1")" </dev/null; }     # line mode
umd()  { gq "SELECT printf('%.3f', userModificationDate) FROM TMTask WHERE uuid='$1'"; }
# write vectors ---------------------------------------------------------------
AS()   { lab_ssh "$IP" "/usr/bin/osascript -e $(printf '%q' "$1")" </dev/null; }
URL()  { lab_ssh "$IP" "open -g $(printf '%q' "$1"); sleep 2" </dev/null; }
tcli() { local q; q=$(printf '%q ' "$@"); lab_ssh "$IP" "/tmp/tcli.sh $q" </dev/null; }
relaunch() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1; sleep 3; open -g -a Things3; sleep 8' </dev/null; }
uuid_of() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
# full-row fingerprint (all columns, line mode) to a file
fp() { gql "SELECT * FROM TMTask WHERE uuid='$1'" > "$OUT/fp/$2.txt"; }
fpdiff() { # fpdiff <labelA> <labelB> -> prints diff (empty == byte-identical)
  if diff -u "$OUT/fp/$1.txt" "$OUT/fp/$2.txt" > "$OUT/fp/diff-$1-$2.txt"; then
    echo "BYTE-IDENTICAL ($1 vs $2)"
  else
    echo "DIFF ($1 vs $2):"; cat "$OUT/fp/diff-$1-$2.txt"
  fi
}

# ================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "building dist on host"
  ( cd "$REPO" && npm run build >/dev/null )
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  note "cloning $GOLDEN -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
  note "ssh up at $IP"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
  echo "IP=$IP" > "$SESSION"

  # gsql helper (RO reads), with -line mode added
  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column)
case "${1:-}" in
  -q) FMT=(-noheader -list); shift;;
  -line) FMT=(-line); shift;;
esac
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF

  note "shipping node + dist + commander (production CLI guest bundle)"
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  lab_scp "$NODE_BIN" "admin@$IP:things-lab/bin/node" >/dev/null
  lab_scp -r "$REPO/dist" "admin@$IP:things-lab/things-api/dist" >/dev/null
  lab_scp -r "$REPO/node_modules/commander" "admin@$IP:things-lab/things-api/node_modules/commander" >/dev/null
  lab_scp "$REPO/package.json" "admin@$IP:things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  lab_ssh "$IP" 'cat > /tmp/tcli.sh && chmod +x /tmp/tcli.sh' <<'EOF'
#!/bin/bash
exec ~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js "$@"
EOF

  lab_ssh "$IP" 'open -g -a Things3; sleep 10' </dev/null
  note "CLI doctor:"; tcli doctor --json 2>&1 | head -c 400 | tee -a "$REPORT"; echo | tee -a "$REPORT"

  note "=== seeding tags ==="
  tcli tag add TM-APPLY  >/dev/null
  tcli tag add TM-REN    >/dev/null
  tcli tag add TM-DEL    >/dev/null
  tcli tag add TM-PARENT >/dev/null
  tcli tag add TM-CHILD --parent TM-PARENT >/dev/null

  note "=== seeding tag members (open+logged todo, open+logged project) ==="
  tcli todo add M-TODO-O --tags "TM-REN,TM-DEL,TM-CHILD" >/dev/null
  tcli todo add M-TODO-L --tags "TM-REN,TM-DEL"          >/dev/null
  tcli project add M-PROJ-O >/dev/null
  tcli project add M-PROJ-L >/dev/null
  sleep 1
  MPO=$(uuid_of M-PROJ-O); MPL=$(uuid_of M-PROJ-L); MTL=$(uuid_of M-TODO-L)
  tcli project tags "$MPO" --set "TM-REN,TM-DEL,TM-PARENT" >/dev/null
  tcli project tags "$MPL" --set "TM-REN,TM-DEL" >/dev/null
  tcli todo complete "$MTL" >/dev/null
  tcli project complete "$MPL" --children auto-complete >/dev/null

  note "=== seeding area-delete fixtures ==="
  tcli area add TM-AREA >/dev/null
  tcli project add AP-OPEN --area TM-AREA --todo AP-CHILD >/dev/null
  tcli project add AP-LOG  --area TM-AREA >/dev/null
  tcli todo add AD-OPEN --area TM-AREA >/dev/null
  tcli todo add AD-LOG  --area TM-AREA >/dev/null
  sleep 1
  APLOG=$(uuid_of AP-LOG); ADLOG=$(uuid_of AD-LOG)
  tcli project complete "$APLOG" --children auto-complete >/dev/null
  tcli todo complete "$ADLOG" >/dev/null

  note "=== seeding T5 (modification-date) fixtures ==="
  tcli todo add T5-TODO >/dev/null
  tcli project add T5-PROJ >/dev/null
  tcli todo add T5-LOG >/dev/null
  sleep 1
  T5LOG=$(uuid_of T5-LOG); tcli todo complete "$T5LOG" >/dev/null

  relaunch
  note "setup DONE — sweeping logged items to Logbook via relaunch"
  note "=== seeded task inventory ==="
  gqh "SELECT substr(uuid,1,8) uuid, title, type, status, trashed, printf('%.3f',userModificationDate) umd FROM TMTask WHERE title LIKE 'M-%' OR title LIKE 'AP-%' OR title LIKE 'AD-%' OR title LIKE 'T5-%' ORDER BY title" | tee -a "$REPORT"
  note "=== seeded tags ==="
  gqh "SELECT title, substr(uuid,1,8) uuid, substr(parent,1,8) parent FROM TMTag WHERE title LIKE 'TM-%' ORDER BY title" | tee -a "$REPORT"
  exit 0
fi

# ============================================================ helper: report the 4 members
report_members() {
  gqh "SELECT title, status, trashed, printf('%.3f',userModificationDate) umd,
       (SELECT group_concat(tg.title,',') FROM TMTaskTag tt JOIN TMTag tg ON tg.uuid=tt.tags WHERE tt.tasks=t.uuid) tags
       FROM TMTask t WHERE title IN ('M-TODO-O','M-TODO-L','M-PROJ-O','M-PROJ-L') ORDER BY title" | tee -a "$REPORT"
}

# ================================================================== T1
if [ "$CMD" = "t1" ]; then
  load_session
  note "############ T1 — tag apply/remove umd side-effect ############"
  MTO=$(uuid_of M-TODO-O); MTL=$(uuid_of M-TODO-L); MPO=$(uuid_of M-PROJ-O); MPL=$(uuid_of M-PROJ-L)
  note "members: M-TODO-O=$MTO M-TODO-L=$MTL M-PROJ-O=$MPO M-PROJ-L=$MPL"

  for surface in cli-url cli-as as-raw url-raw; do
    note "===== T1 surface: $surface — APPLY TM-APPLY ====="
    declare -A B
    for u in "$MTO" "$MTL" "$MPO" "$MPL"; do B[$u]=$(umd "$u"); done
    case "$surface" in
      cli-url)
        tcli todo tags "$MTO" --set "TM-REN,TM-DEL,TM-CHILD,TM-APPLY" --vector url-scheme >/dev/null
        tcli todo tags "$MTL" --set "TM-REN,TM-DEL,TM-APPLY" --vector url-scheme >/dev/null
        tcli project tags "$MPO" --set "TM-REN,TM-DEL,TM-PARENT,TM-APPLY" --vector url-scheme >/dev/null
        tcli project tags "$MPL" --set "TM-REN,TM-DEL,TM-APPLY" --vector url-scheme >/dev/null ;;
      cli-as)
        tcli todo tags "$MTO" --set "TM-REN,TM-DEL,TM-CHILD,TM-APPLY" --vector applescript >/dev/null
        tcli todo tags "$MTL" --set "TM-REN,TM-DEL,TM-APPLY" --vector applescript >/dev/null
        tcli project tags "$MPO" --set "TM-REN,TM-DEL,TM-PARENT,TM-APPLY" --vector applescript >/dev/null
        tcli project tags "$MPL" --set "TM-REN,TM-DEL,TM-APPLY" --vector applescript >/dev/null ;;
      as-raw)
        AS "tell application \"Things3\" to set tag names of to do id \"$MTO\" to \"TM-REN, TM-DEL, TM-CHILD, TM-APPLY\""
        AS "tell application \"Things3\" to set tag names of to do id \"$MTL\" to \"TM-REN, TM-DEL, TM-APPLY\""
        AS "tell application \"Things3\" to set tag names of project id \"$MPO\" to \"TM-REN, TM-DEL, TM-PARENT, TM-APPLY\""
        AS "tell application \"Things3\" to set tag names of project id \"$MPL\" to \"TM-REN, TM-DEL, TM-APPLY\"" ;;
      url-raw)
        URL "things:///update?auth-token=$AUTH&id=$MTO&tags=TM-REN,TM-DEL,TM-CHILD,TM-APPLY"
        URL "things:///update?auth-token=$AUTH&id=$MTL&tags=TM-REN,TM-DEL,TM-APPLY"
        URL "things:///update?auth-token=$AUTH&id=$MPO&tags=TM-REN,TM-DEL,TM-PARENT,TM-APPLY"
        URL "things:///update?auth-token=$AUTH&id=$MPL&tags=TM-REN,TM-DEL,TM-APPLY" ;;
    esac
    sleep 2
    for u in "$MTO" "$MTL" "$MPO" "$MPL"; do
      a=$(umd "$u"); [ "$a" != "${B[$u]}" ] && d="BUMP" || d="silent"
      note "  APPLY $u  umd ${B[$u]} -> $a  [$d]"
    done
    note "  -- now REMOVE TM-APPLY (same surface) --"
    for u in "$MTO" "$MTL" "$MPO" "$MPL"; do B[$u]=$(umd "$u"); done
    case "$surface" in
      cli-url)
        tcli todo tags "$MTO" --set "TM-REN,TM-DEL,TM-CHILD" --vector url-scheme >/dev/null
        tcli todo tags "$MTL" --set "TM-REN,TM-DEL" --vector url-scheme >/dev/null
        tcli project tags "$MPO" --set "TM-REN,TM-DEL,TM-PARENT" --vector url-scheme >/dev/null
        tcli project tags "$MPL" --set "TM-REN,TM-DEL" --vector url-scheme >/dev/null ;;
      cli-as)
        tcli todo tags "$MTO" --set "TM-REN,TM-DEL,TM-CHILD" --vector applescript >/dev/null
        tcli todo tags "$MTL" --set "TM-REN,TM-DEL" --vector applescript >/dev/null
        tcli project tags "$MPO" --set "TM-REN,TM-DEL,TM-PARENT" --vector applescript >/dev/null
        tcli project tags "$MPL" --set "TM-REN,TM-DEL" --vector applescript >/dev/null ;;
      as-raw)
        AS "tell application \"Things3\" to set tag names of to do id \"$MTO\" to \"TM-REN, TM-DEL, TM-CHILD\""
        AS "tell application \"Things3\" to set tag names of to do id \"$MTL\" to \"TM-REN, TM-DEL\""
        AS "tell application \"Things3\" to set tag names of project id \"$MPO\" to \"TM-REN, TM-DEL, TM-PARENT\""
        AS "tell application \"Things3\" to set tag names of project id \"$MPL\" to \"TM-REN, TM-DEL\"" ;;
      url-raw)
        URL "things:///update?auth-token=$AUTH&id=$MTO&tags=TM-REN,TM-DEL,TM-CHILD"
        URL "things:///update?auth-token=$AUTH&id=$MTL&tags=TM-REN,TM-DEL"
        URL "things:///update?auth-token=$AUTH&id=$MPO&tags=TM-REN,TM-DEL,TM-PARENT"
        URL "things:///update?auth-token=$AUTH&id=$MPL&tags=TM-REN,TM-DEL" ;;
    esac
    sleep 2
    for u in "$MTO" "$MTL" "$MPO" "$MPL"; do
      a=$(umd "$u"); [ "$a" != "${B[$u]}" ] && d="BUMP" || d="silent"
      note "  REMOVE $u  umd ${B[$u]} -> $a  [$d]"
    done
  done
  note "T1 final member state:"; report_members
  exit 0
fi

# ================================================================== T2
if [ "$CMD" = "t2" ]; then
  load_session
  note "############ T2 — tag rename umd side-effect ############"
  note "-- pre: member state (all carry TM-REN) --"; report_members
  declare -A B
  for t in M-TODO-O M-TODO-L M-PROJ-O M-PROJ-L; do u=$(uuid_of "$t"); B[$t]=$(umd "$u"); done
  note "===== rename TM-REN -> TM-REN2 via CLI (tag update) ====="
  tcli tag update TM-REN --title TM-REN2 2>&1 | head -c 300 | tee -a "$REPORT"; echo | tee -a "$REPORT"
  sleep 2
  for t in M-TODO-O M-TODO-L M-PROJ-O M-PROJ-L; do
    u=$(uuid_of "$t"); a=$(umd "$u"); [ "$a" != "${B[$t]}" ] && d="BUMP" || d="silent"
    note "  $t  umd ${B[$t]} -> $a  [$d]"
  done
  note "-- tag row after CLI rename --"
  gqh "SELECT title, printf('%.3f',IFNULL(usedDate,0)) usedDate, \"index\" idx FROM TMTag WHERE title IN ('TM-REN2','TM-DEL')" | tee -a "$REPORT"
  note "===== rename TM-REN2 -> TM-REN3 via raw AS (set name of tag) ====="
  for t in M-TODO-O M-TODO-L M-PROJ-O M-PROJ-L; do u=$(uuid_of "$t"); B[$t]=$(umd "$u"); done
  AS 'tell application "Things3" to set name of tag "TM-REN2" to "TM-REN3"' 2>&1 | tee -a "$REPORT"
  sleep 2
  for t in M-TODO-O M-TODO-L M-PROJ-O M-PROJ-L; do
    u=$(uuid_of "$t"); a=$(umd "$u"); [ "$a" != "${B[$t]}" ] && d="BUMP" || d="silent"
    note "  $t  umd ${B[$t]} -> $a  [$d]"
  done
  exit 0
fi

# ================================================================== T3
if [ "$CMD" = "t3" ]; then
  load_session
  note "############ T3 — tag delete umd side-effect ############"
  note "-- pre state: members carry TM-DEL; M-TODO-O carries TM-CHILD; M-PROJ-O carries TM-PARENT --"
  report_members
  note "-- TMTaskTag join rows before delete --"
  gqh "SELECT tk.title item, tg.title tag FROM TMTaskTag tt JOIN TMTag tg ON tg.uuid=tt.tags JOIN TMTask tk ON tk.uuid=tt.tasks WHERE tk.title LIKE 'M-%' ORDER BY tk.title,tg.title" | tee -a "$REPORT"
  declare -A B
  for t in M-TODO-O M-TODO-L M-PROJ-O M-PROJ-L; do u=$(uuid_of "$t"); B[$t]=$(umd "$u"); done
  note "===== delete LEAF tag TM-DEL via CLI (tag delete --dangerously-permanent) ====="
  tcli tag delete TM-DEL --dangerously-permanent 2>&1 | head -c 300 | tee -a "$REPORT"; echo | tee -a "$REPORT"
  sleep 2
  for t in M-TODO-O M-TODO-L M-PROJ-O M-PROJ-L; do
    u=$(uuid_of "$t"); a=$(umd "$u"); [ "$a" != "${B[$t]}" ] && d="BUMP" || d="silent"
    note "  $t  umd ${B[$t]} -> $a  [$d]"
  done
  note "-- TMTag row for TM-DEL gone? --"
  gq "SELECT count(*) FROM TMTag WHERE title='TM-DEL'" | tee -a "$REPORT"
  note "-- TMTaskTag join rows after delete --"
  gqh "SELECT tk.title item, tg.title tag FROM TMTaskTag tt JOIN TMTag tg ON tg.uuid=tt.tags JOIN TMTask tk ON tk.uuid=tt.tasks WHERE tk.title LIKE 'M-%' ORDER BY tk.title,tg.title" | tee -a "$REPORT"

  note "===== delete PARENT tag TM-PARENT (subtree) via CLI (--acknowledge-subtree) ====="
  for t in M-TODO-O M-PROJ-O; do u=$(uuid_of "$t"); B[$t]=$(umd "$u"); done
  gq "SELECT count(*) FROM TMTag WHERE title IN ('TM-PARENT','TM-CHILD')" | tee -a "$REPORT"
  tcli tag delete TM-PARENT --dangerously-permanent --acknowledge-subtree 2>&1 | head -c 300 | tee -a "$REPORT"; echo | tee -a "$REPORT"
  sleep 2
  note "-- TM-PARENT / TM-CHILD rows remaining (subtree fate) --"
  gqh "SELECT title, substr(uuid,1,8) uuid, substr(parent,1,8) parent FROM TMTag WHERE title IN ('TM-PARENT','TM-CHILD')" | tee -a "$REPORT"
  for t in M-TODO-O M-PROJ-O; do
    u=$(uuid_of "$t"); a=$(umd "$u"); [ "$a" != "${B[$t]}" ] && d="BUMP" || d="silent"
    note "  $t (carried TM-CHILD/TM-PARENT)  umd ${B[$t]} -> $a  [$d]"
  done
  note "-- residual join rows for M-TODO-O / M-PROJ-O --"
  gqh "SELECT tk.title item, tg.title tag FROM TMTaskTag tt JOIN TMTag tg ON tg.uuid=tt.tags JOIN TMTask tk ON tk.uuid=tt.tasks WHERE tk.title IN ('M-TODO-O','M-PROJ-O') ORDER BY tk.title" | tee -a "$REPORT"
  exit 0
fi

# ================================================================== T4
if [ "$CMD" = "t4" ]; then
  load_session
  note "############ T4 — area delete umd + FK fate ############"
  note "-- pre: area members --"
  gqh "SELECT title, type, status, trashed, substr(area,1,8) area, substr(project,1,8) proj, printf('%.3f',userModificationDate) umd FROM TMTask WHERE title IN ('AP-OPEN','AP-CHILD','AP-LOG','AD-OPEN','AD-LOG') ORDER BY title" | tee -a "$REPORT"
  AREA=$(gq "SELECT uuid FROM TMArea WHERE title='TM-AREA'")
  note "area uuid=$AREA"
  declare -A B
  for t in AP-OPEN AP-CHILD AP-LOG AD-OPEN AD-LOG; do u=$(uuid_of "$t"); B[$t]=$(umd "$u"); done
  note "===== delete area TM-AREA via CLI (--dangerously-permanent --allow-non-empty) ====="
  tcli area delete TM-AREA --dangerously-permanent --allow-non-empty 2>&1 | head -c 400 | tee -a "$REPORT"; echo | tee -a "$REPORT"
  sleep 2
  note "-- TMArea row gone? --"
  gq "SELECT count(*) FROM TMArea WHERE title='TM-AREA'" | tee -a "$REPORT"
  note "-- post: member state + FK fate --"
  gqh "SELECT title, type, status, trashed, substr(area,1,8) area, substr(project,1,8) proj, printf('%.3f',userModificationDate) umd FROM TMTask WHERE title IN ('AP-OPEN','AP-CHILD','AP-LOG','AD-OPEN','AD-LOG') ORDER BY title" | tee -a "$REPORT"
  for t in AP-OPEN AP-CHILD AP-LOG AD-OPEN AD-LOG; do
    u=$(uuid_of "$t"); a=$(umd "$u"); [ "$a" != "${B[$t]}" ] && d="BUMP" || d="silent"
    note "  $t  umd ${B[$t]} -> $a  [$d]"
  done
  exit 0
fi

# ================================================================== T5
if [ "$CMD" = "t5" ]; then
  load_session
  note "############ T5 — set modification date: stick / relaunch / restore ############"
  for pair in "T5-TODO:to do" "T5-PROJ:project" "T5-LOG:to do"; do
    TITLE="${pair%%:*}"; KLASS="${pair##*:}"; U=$(uuid_of "$TITLE")
    note "===== $TITLE ($KLASS) uuid=$U ====="
    PRE=$(umd "$U"); note "  pre umd = $PRE"
    fp "$U" "${TITLE}-pre"
    # T5a: set to a PAST datetime, does it stick on immediate re-read?
    note "  -- T5a set modification date to 2025-03-01 09:15:20 --"
    AS "tell application \"Things3\" to set modification date of $KLASS id \"$U\" to (date \"3/1/2025 9:15:20 AM\")" 2>&1 | tee -a "$REPORT"
    sleep 1
    A1=$(umd "$U"); note "  after set-past umd = $A1 (2025-03-01 09:15:20 UTC == 1740820520)"
    fp "$U" "${TITLE}-setpast"
    note "  byte-diff pre vs setpast (should show ONLY userModificationDate):"
    fpdiff "${TITLE}-pre" "${TITLE}-setpast" | tee -a "$REPORT"
    # T5b: survive relaunch?
    relaunch
    A2=$(umd "$U"); note "  after RELAUNCH umd = $A2 (stuck? == $A1)"
    # T5f: set FORWARD
    note "  -- T5f set modification date FORWARD to 2027-06-15 10:00 --"
    AS "tell application \"Things3\" to set modification date of $KLASS id \"$U\" to (date \"6/15/2027 10:00:00 AM\")" 2>&1 | tee -a "$REPORT"
    sleep 1
    A3=$(umd "$U"); note "  after set-forward umd = $A3 (2027-06-15 10:00 UTC == 1813658400)"
    # T5c: surgical + reversible restore to the exact captured second (floor of PRE)
    PREFLOOR=${PRE%.*}
    note "  -- T5c restore umd to floor(pre)=$PREFLOOR via epoch->AS date --"
    AS "tell application \"Things3\" to set modification date of $KLASS id \"$U\" to ((date \"1/1/1970\") + ($PREFLOOR) + (time to GMT))" 2>&1 | tee -a "$REPORT"
    sleep 1
    A4=$(umd "$U"); note "  after restore umd = $A4 (target floor $PREFLOOR; pre was $PRE — sub-second delta expected)"
    fp "$U" "${TITLE}-restored"
    note "  byte-diff pre vs restored (goal: identical modulo sub-second umd):"
    fpdiff "${TITLE}-pre" "${TITLE}-restored" | tee -a "$REPORT"
  done

  note "===== T5d — REAL restore recipe: mutate (set-tags) then null the umd bump ====="
  U=$(uuid_of T5-TODO)
  PRE=$(umd "$U"); PREFLOOR=${PRE%.*}
  note "  T5-TODO pre umd=$PRE"
  fp "$U" "recipe-pre"
  tcli tag add T5-RECIPE-TAG >/dev/null
  tcli todo tags "$U" --set T5-RECIPE-TAG >/dev/null
  sleep 1
  MID=$(umd "$U"); note "  after set-tags umd=$MID (bumped)"
  AS "tell application \"Things3\" to set modification date of to do id \"$U\" to ((date \"1/1/1970\") + ($PREFLOOR) + (time to GMT))" >/dev/null
  sleep 1
  POST=$(umd "$U"); note "  after umd-restore umd=$POST (target $PREFLOOR)"
  fp "$U" "recipe-post"
  note "  byte-diff pre vs post (expect ONLY the intended tag change: cachedTags + umd sub-second):"
  fpdiff "recipe-pre" "recipe-post" | tee -a "$REPORT"
  note "  -- T5e does restored umd survive UNRELATED app activity (relaunch + a write to a DIFFERENT row)? --"
  tcli todo add T5-NOISE >/dev/null; relaunch
  SURV=$(umd "$U"); note "  T5-TODO umd after relaunch+unrelated writes = $SURV (survives? == $POST)"
  exit 0
fi

# ================================================================== T6
if [ "$CMD" = "t6" ]; then
  load_session
  note "############ T6 — do TAG / AREA own rows carry/bump umd? ############"
  note "-- TMTag columns (schema: no userModificationDate expected) --"
  lab_ssh "$IP" '/tmp/gsql.sh -q "SELECT name FROM pragma_table_info(\"TMTag\")"' </dev/null | tr '\n' ' ' | tee -a "$REPORT"; echo | tee -a "$REPORT"
  note "-- TMArea columns --"
  lab_ssh "$IP" '/tmp/gsql.sh -q "SELECT name FROM pragma_table_info(\"TMArea\")"' </dev/null | tr '\n' ' ' | tee -a "$REPORT"; echo | tee -a "$REPORT"
  note "-- TMTag full row for a surviving tag (TM-APPLY) --"
  gql "SELECT * FROM TMTag WHERE title='TM-APPLY'" | tee -a "$REPORT"
  exit 0
fi

# ================================================================== dump
if [ "$CMD" = "dump" ]; then
  load_session
  gqh "SELECT substr(uuid,1,8) uuid, title, type, status, trashed, printf('%.3f',userModificationDate) umd FROM TMTask WHERE title LIKE 'M-%' OR title LIKE 'AP-%' OR title LIKE 'AD-%' OR title LIKE 'T5-%' ORDER BY title" | tee -a "$REPORT"
  gqh "SELECT title, substr(uuid,1,8) uuid, substr(parent,1,8) parent FROM TMTag WHERE title LIKE 'TM-%' OR title LIKE 'T5-%' ORDER BY title" | tee -a "$REPORT"
  exit 0
fi

# ================================================================ teardown
if [ "$CMD" = "teardown" ]; then
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "torn down $VM"
  exit 0
fi

echo "usage: research-tagmod.sh {setup|t1|t2|t3|t4|t5|t6|dump|teardown}" >&2
exit 2
