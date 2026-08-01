#!/bin/bash
# SITTING 7 — experimental-reorder CONTINGENCY backups: INBOXBACK / SOMEBACK / PROJROOT / AREABACK.
#
# THEME (Mike-driven 2026-07-31): several shipped reorder scopes rest ENTIRELY on
# the UNDOCUMENTED `_private_experimental_ reorder to dos in` command — no
# non-experimental backup. Hedge against Cultured Code breaking it. Each arm hunts
# the missing backup LAW using the move-re-entry family SIT6 proved (move legs
# preserve all flags/FKs; loose re-entry FRONT-inserts in dispatch order; heading
# re-entry BACK-inserts). Goal per scope: a documented CONTINGENCY protocol —
# proven, recorded in the assumption register's BACKUP column, wired only if the
# private surface ever dies.
#
#   ARM 1 INBOXBACK  inbox order backup. `move to do id X to list "Inbox"` on a row
#                    ALREADY in the inbox — no-op or re-insert? If no-op: park an
#                    inbox row OUT (list-id=scratch project) and BACK IN (move to
#                    list "Inbox"). Re-entry index law (front/back, determinism x2)?
#                    Round-trip preserve inbox state (start=0)?
#   ARM 2 SOMEBACK   LOOSE someday order backup (to-dos AND area-less someday
#                    projects). when= round-trip anytime<->someday on LOOSE rows:
#                    re-entry insertion law on index (SOMEBNC proved container
#                    variants front/back; loose unprobed). Projects via update-
#                    project legs. CAUTION: when= bounce — someday rows can't be
#                    Today-flagged except deadline-PULLS; test a deadline-pulled
#                    someday row separately, record pull-state fate
#                    (deadlineSuppressionDate?) — exclude flagged-pull rows if it
#                    corrupts.
#   ARM 3 PROJROOT   project unheaded-children backup. Park an unheaded ANYTIME
#                    child OUT to a scratch project and BACK (list-id=original P) —
#                    PROJECT-ROOT move re-entry index law (back-insert like heading,
#                    or front like loose?) x2, flags preserved (one starred). Also
#                    the when= someday<->anytime bounce on an unheaded child (does
#                    re-entry back-insert into the project's anytime bucket like
#                    BOUNCE2-h?). Verdict: which backup serves project children.
#   ARM 4 AREABACK   area-member order backup. (a) reconfirm the when= bounce is
#                    index-inert for an area-direct ANYTIME member (URL sequential,
#                    not just json — §9i(c)); (b) the MOVE round-trip: park an area
#                    member OUT (list-id=scratch project) and BACK (list-id=areaUuid)
#                    — re-entry index law x2, flags + area FK preserved (one
#                    starred); (c) same for a PROJECT in an area (park to a DIFFERENT
#                    scratch area and back) — within-area project order (O14 backup).
#
# ONE offline COW clone `sit7-lab`, clock pinned to the golden's 2026-07-05 12:00.
# ALL ARMS HEADLESS (URL scheme + AppleScript move/reorder) — no Accessibility,
# no VNC. Raw before/after DB reads for every touched row, every leg. `encodePacked
# Date` discipline — ISO dates to the URL scheme, the app encodes; raw values read
# back. Synthetic seeds only (S7-* prefix) — public repo.
# Write-up: docs/lab/sit7-backup-laws.md.
#
#   research-sit7.sh setup      clone+boot+airgap+clock-pin+warm-up+token
#   research-sit7.sh arm1       INBOXBACK inbox park/re-enter
#   research-sit7.sh arm2       SOMEBACK loose someday to-dos + projects + deadline-pull
#   research-sit7.sh arm3       PROJROOT project unheaded-child park round-trip + bounce
#   research-sit7.sh arm4       AREABACK area member/project move round-trip + bounce inertness
#   research-sit7.sh teardown   stop + delete the clone
#
# Conventions inherited from research-sit6.sh:
#   * offline COW clone, guest airgap (delete default route), clock pinned BEFORE
#     Things launches, read-only guest SQLite.
#   * NEVER send URL when=/schedule-class to a REPEATING template row (§1 CRASH).
#   * NO clock advance anywhere.
#   TODAY = 2026-07-05 (pinned); DL = 2026-07-10 (a deadline date, never a when=).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v1}"
PIN="${PIN:-070512002026}"           # 2026-07-05 12:00 (golden pinnedDate)
DL="${DL:-2026-07-10}"               # a deadline date (NOT a schedule when=)
TODAY="${TODAY:-2026-07-05}"         # pinned today (deadline-pull date)
VM="sit7-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[sit7] $*" | tee -a "$REPORT"; }

CMD="${1:-}"

# --------------------------------------------------------------- guest SQLite
GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

gq()  { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gsql(){ lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" </dev/null; }
gas() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" </dev/null || true; }
gurl(){ lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; sleep 2; }
uuid_of() { local t="$1" typ="${2:-}" w u i; w="title='$t' AND trashed=0"; [ -n "$typ" ] && w="$w AND type=$typ"
  for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }
areaid() { gq "SELECT uuid FROM TMArea WHERE title='$1'"; }

# FULL raw row for a title glob (index-ordered). Columns per the brief: uuid,type,
# start,startDate,startBucket,todayIndex,index,heading,project,area,reminderTime +
# deadline,status,trashed for context.
dumprow() { gq "SELECT title
  ||' uuid='||substr(uuid,1,8)
  ||' ty='||type
  ||' st='||start
  ||' sd='||COALESCE(startDate,'-')
  ||' sb='||COALESCE(startBucket,'-')
  ||' tIdx='||COALESCE(todayIndex,'-')
  ||' idx='||\"index\"
  ||' hd='||COALESCE(substr(heading,1,8),'-')
  ||' p='||COALESCE(substr(project,1,8),'-')
  ||' a='||COALESCE(substr(area,1,8),'-')
  ||' rem='||COALESCE(reminderTime,'-')
  ||' dl='||COALESCE(deadline,'-')
  ||' status='||status
  ||' tr='||trashed
  FROM TMTask WHERE title LIKE '$1' AND trashed IN (0,1) ORDER BY \"index\", todayIndex"; }
# compact index-order line for quick order reads (the anytime/someday/inbox index axis)
idxord() { gq "SELECT title||'('||\"index\"||')' FROM TMTask WHERE title LIKE '$1' AND trashed=0 ORDER BY \"index\""; }
# pull-state flags for the SOMEBACK deadline-pull row (adds deadlineSuppressionDate)
pullflags() { gq "SELECT 'st='||start||' sd='||COALESCE(startDate,'-')||' sb='||COALESCE(startBucket,'-')||' dl='||COALESCE(deadline,'-')||' dsd='||COALESCE(deadlineSuppressionDate,'-')||' tIdx='||COALESCE(todayIndex,'-')||' idx='||\"index\" FROM TMTask WHERE title='$1' AND trashed=0"; }

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "cloning $GOLDEN -> $VM (TODAY=pinned $TODAY, DL=$DL)"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
  note "ssh up at $IP"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo route -n delete -inet6 default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"
  echo "IP=$IP" > "$SESSION"

  note "warm-up: launch/quit/relaunch Things on the pinned date"
  lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3' </dev/null
  lab_ssh "$IP" 'open -g -a Things3; sleep 8' </dev/null

  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  echo "TOKEN=$TOKEN" >> "$SESSION"
  note "auth token in hand (${#TOKEN} chars)"
  note "guest date: $(lab_ssh "$IP" 'date' </dev/null)"
  note "setup DONE — session in $SESSION"
  exit 0
fi

# ==================================================================== ARM 1 INBOXBACK
if [ "$CMD" = "arm1" ]; then
  load_session
  note "############################################################"
  note "########## ARM 1 — INBOXBACK (inbox order backup) ##########"
  note "############################################################"
  note "seed: 4 INBOX to-dos IB1..IB4 (bare add -> Inbox, start=0); scratch project S7-ISCR"
  gurl "things:///add?title=S7-IB1"
  gurl "things:///add?title=S7-IB2"
  gurl "things:///add?title=S7-IB3"
  gurl "things:///add?title=S7-IB4"
  gurl "things:///add-project?title=S7-ISCR"
  sleep 2
  IB1=$(uuid_of S7-IB1); IB2=$(uuid_of S7-IB2); IB3=$(uuid_of S7-IB3); IB4=$(uuid_of S7-IB4)
  ISCR=$(uuid_of S7-ISCR 1)
  note "  uuids IB1=$IB1 IB2=$IB2 IB3=$IB3 IB4=$IB4 ISCR(proj)=$ISCR"
  note "--- seeded inbox roster (raw; expect st=0) ---"
  dumprow 'S7-IB_' | tee -a "$REPORT"

  note "===== (a) NO-OP test: 'move to do id IB1 to list \"Inbox\"' on a row ALREADY in the inbox — index re-insert or no-op? ====="
  note "  IB1 before: $(dumprow 'S7-IB1' | tr '\n' ' ')"
  gas "tell application \"Things3\" to move to do id \"$IB1\" to list \"Inbox\""
  sleep 2
  note "  IB1 after move-to-Inbox (idx changed = re-insert; unchanged = no-op): $(dumprow 'S7-IB1' | tr '\n' ' ')"
  note "  inbox index order now: $(idxord 'S7-IB_' | tr '\n' ' ')"

  note "===== (b) PARK all OUT into scratch project ISCR (update?list-id=ISCR) — does inbox state (start=0) survive the park? ====="
  for u in "$IB1" "$IB2" "$IB3" "$IB4"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$ISCR"
    note "  parked $t (project=ISCR? start now?): $(dumprow "$t" | tr '\n' ' ')"
  done
  note "  in-scratch index order after park: $(idxord 'S7-IB_' | tr '\n' ' ')"

  note "===== (c) RE-ENTER via 'move to do id X to list \"Inbox\"' in dispatch order IB3,IB1,IB4,IB2 — re-entry index law? start=0 restored? ====="
  for u in "$IB3" "$IB1" "$IB4" "$IB2"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    gas "tell application \"Things3\" to move to do id \"$u\" to list \"Inbox\""
    sleep 2
    note "  re-entered $t (project->NULL? start=0? idx?): $(dumprow "$t" | tr '\n' ' ')"
  done
  note "  FINAL inbox index order after dispatch IB3,IB1,IB4,IB2: $(idxord 'S7-IB_' | tr '\n' ' ')"
  note "  INTERPRET c: FRONT-insert => final == reverse dispatch (IB2,IB4,IB1,IB3); BACK-insert => final == dispatch (IB3,IB1,IB4,IB2)."

  note "===== (d) DETERMINISM x2: park all OUT again, re-enter SAME dispatch IB3,IB1,IB4,IB2 — reproducible final order? ====="
  for u in "$IB1" "$IB2" "$IB3" "$IB4"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$ISCR"; done
  note "  re-parked in-scratch order: $(idxord 'S7-IB_' | tr '\n' ' ')"
  for u in "$IB3" "$IB1" "$IB4" "$IB2"; do gas "tell application \"Things3\" to move to do id \"$u\" to list \"Inbox\""; sleep 2; done
  note "  PASS2 FINAL inbox index order (want == PASS1): $(idxord 'S7-IB_' | tr '\n' ' ')"
  note "  IB roster raw (start=0 for all? inbox state fully restored?): "
  dumprow 'S7-IB_' | tee -a "$REPORT"
  note "  VERDICT-1: is park-out (list-id=scratch) + re-enter (move to list \"Inbox\" in the front/back-derived order) a wireable non-experimental inbox-order backup, restoring start=0?"
  exit 0
fi

# ==================================================================== ARM 2 SOMEBACK
if [ "$CMD" = "arm2" ]; then
  load_session
  note "############################################################"
  note "########## ARM 2 — SOMEBACK (loose someday order backup) ##########"
  note "############################################################"
  note "=== 2a: LOOSE SOMEDAY to-dos SM1..SM4 (add + when=someday -> start=2); bounce anytime<->someday ==="
  gurl "things:///add?title=S7-SM1&when=someday"
  gurl "things:///add?title=S7-SM2&when=someday"
  gurl "things:///add?title=S7-SM3&when=someday"
  gurl "things:///add?title=S7-SM4&when=someday"
  sleep 2
  SM1=$(uuid_of S7-SM1); SM2=$(uuid_of S7-SM2); SM3=$(uuid_of S7-SM3); SM4=$(uuid_of S7-SM4)
  note "  uuids SM1=$SM1 SM2=$SM2 SM3=$SM3 SM4=$SM4"
  note "--- seeded loose someday roster (raw; expect st=2 sd=-) ---"
  dumprow 'S7-SM_' | tee -a "$REPORT"
  note "  BOUNCE each in dispatch order SM3,SM1,SM4,SM2: leg1 when=anytime (out of someday), leg2 when=someday (RE-ENTRY placement). index law?"
  for u in "$SM3" "$SM1" "$SM4" "$SM2"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    gurl "things:///update?id=$u&auth-token=$TOKEN&when=anytime"
    gurl "things:///update?id=$u&auth-token=$TOKEN&when=someday"
    note "    bounced $t (st back to 2? idx?): $(dumprow "$t" | tr '\n' ' ')"
  done
  note "  FINAL someday index order after dispatch SM3,SM1,SM4,SM2: $(idxord 'S7-SM_' | tr '\n' ' ')"
  note "  INTERPRET 2a: FRONT-insert => final == reverse dispatch (SM2,SM4,SM1,SM3); BACK-insert => final == dispatch (SM3,SM1,SM4,SM2)."
  note "  DETERMINISM x2: repeat SAME dispatch SM3,SM1,SM4,SM2"
  for u in "$SM3" "$SM1" "$SM4" "$SM2"; do
    gurl "things:///update?id=$u&auth-token=$TOKEN&when=anytime"
    gurl "things:///update?id=$u&auth-token=$TOKEN&when=someday"
  done
  note "  PASS2 FINAL someday index order (want == PASS1): $(idxord 'S7-SM_' | tr '\n' ' ')"

  note "=== 2b: AREA-LESS SOMEDAY PROJECTS SP1..SP3 (add-project + update-project?when=someday); bounce via update-project legs ==="
  gurl "things:///add-project?title=S7-SP1"
  gurl "things:///add-project?title=S7-SP2"
  gurl "things:///add-project?title=S7-SP3"
  sleep 2
  SP1=$(uuid_of S7-SP1 1); SP2=$(uuid_of S7-SP2 1); SP3=$(uuid_of S7-SP3 1)
  for u in "$SP1" "$SP2" "$SP3"; do gurl "things:///update-project?id=$u&auth-token=$TOKEN&when=someday"; done
  note "--- seeded area-less someday projects (raw; expect st=2) ---"
  dumprow 'S7-SP_' | tee -a "$REPORT"
  note "  BOUNCE each project in dispatch order SP3,SP1,SP2: update-project?when=anytime then when=someday. index law?"
  for u in "$SP3" "$SP1" "$SP2"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    gurl "things:///update-project?id=$u&auth-token=$TOKEN&when=anytime"
    gurl "things:///update-project?id=$u&auth-token=$TOKEN&when=someday"
    note "    bounced $t (st back to 2? idx?): $(dumprow "$t" | tr '\n' ' ')"
  done
  note "  FINAL project someday index order after dispatch SP3,SP1,SP2: $(idxord 'S7-SP_' | tr '\n' ' ')"
  note "  INTERPRET 2b: FRONT-insert => reverse (SP2,SP1,SP3); BACK-insert => dispatch (SP3,SP1,SP2). (Contrast native ORD-3 area-less someday projects DESCEND.)"

  note "=== 2c: DEADLINE-PULLED someday to-do SD1 (when=someday + deadline=$TODAY -> pulled into Today); what does the anytime<->someday round-trip do to the pull state? ==="
  gurl "things:///add?title=S7-SD1&when=someday&deadline=$TODAY"
  sleep 2
  SD1=$(uuid_of S7-SD1)
  note "  SD1=$SD1 seeded pull-state (dsd=deadlineSuppressionDate): $(pullflags 'S7-SD1')"
  note "  SD1 full raw: $(dumprow 'S7-SD1' | tr '\n' ' ')"
  note "  run the bounce: leg1 when=anytime, leg2 when=someday"
  gurl "things:///update?id=$SD1&auth-token=$TOKEN&when=anytime"
  note "    after when=anytime: $(pullflags 'S7-SD1')"
  gurl "things:///update?id=$SD1&auth-token=$TOKEN&when=someday"
  note "    after when=someday: $(pullflags 'S7-SD1')"
  note "  SD1 final full raw: $(dumprow 'S7-SD1' | tr '\n' ' ')"
  note "  VERDICT-2c: does the round-trip preserve the deadline-pull state (deadline + deadlineSuppressionDate + start=2) or CORRUPT it? If corrupt => flagged-pull someday rows are EXCLUDED from the bounce backup."
  note "  VERDICT-2: is the anytime<->someday when= bounce a wireable loose-someday order backup for to-dos AND area-less someday projects (front/back per kind)?"
  exit 0
fi

# ==================================================================== ARM 3 PROJROOT
if [ "$CMD" = "arm3" ]; then
  load_session
  note "############################################################"
  note "########## ARM 3 — PROJROOT (project unheaded-children backup) ##########"
  note "############################################################"
  note "seed: project S7-PR with 4 UNHEADED anytime children pc1..pc4 (pc2 STARRED Today+09:00 reminder+deadline $DL); scratch project S7-PSCR"
  gurl "things:///add-project?title=S7-PR"
  sleep 1
  PR=$(uuid_of S7-PR 1)
  gurl "things:///add?title=S7-pc1&list-id=$PR"
  gurl "things:///add?title=S7-pc2&list-id=$PR&when=today@09:00&deadline=$DL"
  gurl "things:///add?title=S7-pc3&list-id=$PR"
  gurl "things:///add?title=S7-pc4&list-id=$PR"
  gurl "things:///add-project?title=S7-PSCR"
  sleep 2
  PC1=$(uuid_of S7-pc1); PC2=$(uuid_of S7-pc2); PC3=$(uuid_of S7-pc3); PC4=$(uuid_of S7-pc4)
  PSCR=$(uuid_of S7-PSCR 1)
  note "  uuids pc1=$PC1 pc2=$PC2(starred) pc3=$PC3 pc4=$PC4 PR(proj)=$PR PSCR(scratch)=$PSCR"
  note "--- seeded unheaded project-child roster (raw) ---"
  dumprow 'S7-pc_' | tee -a "$REPORT"

  note "===== (a) PARK OUT to scratch project PSCR then BACK to PR (update?list-id=) — PROJECT-ROOT move re-entry index law? flags on pc2? ====="
  note "  dispatch OUT order pc1,pc2,pc3,pc4 -> PSCR"
  for u in "$PC1" "$PC2" "$PC3" "$PC4"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$PSCR"
    note "    parked $t (project=PSCR? idx? pc2 star kept?): $(dumprow "$t" | tr '\n' ' ')"
  done
  note "  BACK to PR in dispatch order pc3,pc1,pc4,pc2 (update?list-id=PR, no heading) — re-entry index law?"
  for u in "$PC3" "$PC1" "$PC4" "$PC2"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$PR"
    note "    back-to-PR $t (project=PR? idx? pc2 star st/sd/tIdx/rem/dl kept?): $(dumprow "$t" | tr '\n' ' ')"
  done
  note "  FINAL PR-root index order after dispatch pc3,pc1,pc4,pc2: $(idxord 'S7-pc_' | tr '\n' ' ')"
  note "  INTERPRET a: FRONT (like loose) => reverse (pc2,pc4,pc1,pc3); BACK (like heading) => dispatch (pc3,pc1,pc4,pc2)."
  note "  DETERMINISM x2: park OUT again, BACK SAME dispatch pc3,pc1,pc4,pc2"
  for u in "$PC1" "$PC2" "$PC3" "$PC4"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$PSCR"; done
  for u in "$PC3" "$PC1" "$PC4" "$PC2"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$PR"; done
  note "  PASS2 FINAL PR-root index order (want == PASS1): $(idxord 'S7-pc_' | tr '\n' ' ')"
  note "  pc2 star check: $(dumprow 'S7-pc2' | tr '\n' ' ')"

  note "===== (b) when= someday<->anytime BOUNCE on an unheaded project child (pc3): does re-entry BACK-insert into PR's anytime bucket like BOUNCE2-h? ====="
  note "  pc3 before bounce: $(dumprow 'S7-pc3' | tr '\n' ' ')"
  note "  index order before: $(idxord 'S7-pc_' | tr '\n' ' ')"
  gurl "things:///update?id=$PC3&auth-token=$TOKEN&when=someday"
  note "    pc3 after when=someday: $(dumprow 'S7-pc3' | tr '\n' ' ')"
  gurl "things:///update?id=$PC3&auth-token=$TOKEN&when=anytime"
  note "    pc3 after when=anytime (re-entry into PR anytime bucket — back-insert at bucket max? front? project FK kept?): $(dumprow 'S7-pc3' | tr '\n' ' ')"
  note "  FINAL index order after pc3 bounce: $(idxord 'S7-pc_' | tr '\n' ' ')"
  note "  VERDICT-3: which backup serves PROJECT unheaded children — the MOVE round-trip (park to scratch project + back) or the when= bounce? front/back law of each; flags preserved? (native ORD-1 project scope is experimental-only.)"
  exit 0
fi

# ==================================================================== ARM 4 AREABACK
if [ "$CMD" = "arm4" ]; then
  load_session
  note "############################################################"
  note "########## ARM 4 — AREABACK (area-member order backup) ##########"
  note "############################################################"
  note "seed: area S7-AREA with 4 DIRECT anytime members am1..am4 (am2 STARRED Today+09:00 reminder+deadline $DL) + a project S7-apj in the area; scratch project S7-ASCR; DIFFERENT scratch area S7-AREA2"
  gas "tell application \"Things3\" to make new area with properties {name:\"S7-AREA\"}"
  gas "tell application \"Things3\" to make new area with properties {name:\"S7-AREA2\"}"
  sleep 1
  AREA=$(areaid S7-AREA); AREA2=$(areaid S7-AREA2)
  note "  area S7-AREA=$AREA  scratch area S7-AREA2=$AREA2"
  gurl "things:///add?title=S7-am1&list-id=$AREA"
  gurl "things:///add?title=S7-am2&list-id=$AREA&when=today@09:00&deadline=$DL"
  gurl "things:///add?title=S7-am3&list-id=$AREA"
  gurl "things:///add?title=S7-am4&list-id=$AREA"
  gurl "things:///add-project?title=S7-apj&area-id=$AREA"
  gurl "things:///add-project?title=S7-ASCR"
  sleep 2
  AM1=$(uuid_of S7-am1); AM2=$(uuid_of S7-am2); AM3=$(uuid_of S7-am3); AM4=$(uuid_of S7-am4)
  APJ=$(uuid_of S7-apj 1); ASCR=$(uuid_of S7-ASCR 1)
  note "  uuids am1=$AM1 am2=$AM2(starred) am3=$AM3 am4=$AM4 apj(area proj)=$APJ ASCR(scratch proj)=$ASCR"
  note "--- seeded area-member roster (raw; expect a=$AREA on am*, apj) ---"
  dumprow 'S7-am_' | tee -a "$REPORT"
  dumprow 'S7-apj' | tee -a "$REPORT"

  note "===== (a) when= BOUNCE INERTNESS on an area-direct ANYTIME member (am1), URL sequential (§9i(c) measured json frozen; reconfirm URL) ====="
  note "  am1 before: $(dumprow 'S7-am1' | tr '\n' ' ')"
  note "  area index order before: $(idxord 'S7-am_' | tr '\n' ' ')"
  gurl "things:///update?id=$AM1&auth-token=$TOKEN&when=someday"
  note "    am1 after when=someday (st=2? area FK kept? idx changed?): $(dumprow 'S7-am1' | tr '\n' ' ')"
  gurl "things:///update?id=$AM1&auth-token=$TOKEN&when=anytime"
  note "    am1 after when=anytime (re-entry: idx moved or FROZEN?): $(dumprow 'S7-am1' | tr '\n' ' ')"
  note "  area index order after am1 round-trip (unchanged for am1 => bounce is index-INERT => NO bounce backup for area members): $(idxord 'S7-am_' | tr '\n' ' ')"

  note "===== (b) MOVE round-trip: park am OUT to scratch project ASCR (update?list-id=ASCR) then BACK to area (update?list-id=AREA) — re-entry index law x2, flags + area FK on am2? ====="
  note "  dispatch OUT am1,am2,am3,am4 -> ASCR"
  for u in "$AM1" "$AM2" "$AM3" "$AM4"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$ASCR"
    note "    parked $t (project=ASCR? area cleared? idx? am2 star kept?): $(dumprow "$t" | tr '\n' ' ')"
  done
  note "  BACK to AREA in dispatch am3,am1,am4,am2 (update?list-id=$AREA) — re-entry index law? area FK restored?"
  for u in "$AM3" "$AM1" "$AM4" "$AM2"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$AREA"
    note "    back-to-area $t (area=AREA? project cleared? idx? am2 star st/sd/tIdx/rem/dl kept?): $(dumprow "$t" | tr '\n' ' ')"
  done
  note "  FINAL area index order after dispatch am3,am1,am4,am2: $(idxord 'S7-am_' | tr '\n' ' ')"
  note "  INTERPRET b: FRONT => reverse (am2,am4,am1,am3); BACK => dispatch (am3,am1,am4,am2)."
  note "  DETERMINISM x2: park OUT again, BACK SAME dispatch am3,am1,am4,am2"
  for u in "$AM1" "$AM2" "$AM3" "$AM4"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$ASCR"; done
  for u in "$AM3" "$AM1" "$AM4" "$AM2"; do gurl "things:///update?id=$u&auth-token=$TOKEN&list-id=$AREA"; done
  note "  PASS2 FINAL area index order (want == PASS1): $(idxord 'S7-am_' | tr '\n' ' ')"
  note "  am2 star check: $(dumprow 'S7-am2' | tr '\n' ' ')"

  note "===== (c) PROJECT in an area (apj): park to a DIFFERENT scratch area AREA2 (update-project?area-id=AREA2) then BACK (area-id=AREA) — within-area project order re-entry law (O14 backup)? ====="
  note "  seed 2 more area projects so there is a within-area project ORDER to observe: S7-apj2, S7-apj3 in AREA"
  gurl "things:///add-project?title=S7-apj2&area-id=$AREA"
  gurl "things:///add-project?title=S7-apj3&area-id=$AREA"
  sleep 2
  APJ2=$(uuid_of S7-apj2 1); APJ3=$(uuid_of S7-apj3 1)
  note "  uuids apj=$APJ apj2=$APJ2 apj3=$APJ3 (all in AREA)"
  note "  within-area project index order before: $(idxord 'S7-apj%' | tr '\n' ' ')"
  note "  park each to AREA2 (dispatch apj,apj2,apj3), then detach-back to AREA in dispatch apj2,apj,apj3"
  for u in "$APJ" "$APJ2" "$APJ3"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    gurl "things:///update-project?id=$u&auth-token=$TOKEN&area-id=$AREA2"
    note "    parked-to-AREA2 $t (area=AREA2? idx?): $(dumprow "$t" | tr '\n' ' ')"
  done
  for u in "$APJ2" "$APJ" "$APJ3"; do
    t=$(gq "SELECT title FROM TMTask WHERE uuid='$u'")
    gurl "things:///update-project?id=$u&auth-token=$TOKEN&area-id=$AREA"
    note "    back-to-AREA $t (area=AREA? idx?): $(dumprow "$t" | tr '\n' ' ')"
  done
  note "  FINAL within-AREA project index order after back-dispatch apj2,apj,apj3: $(idxord 'S7-apj%' | tr '\n' ' ')"
  note "  INTERPRET c: FRONT => reverse (apj3,apj,apj2); BACK => dispatch (apj2,apj,apj3)."
  note "  VERDICT-4: (a) area-direct member bounce inertness (bounce backup viable?); (b) area member MOVE round-trip law + flag safety; (c) within-area project MOVE round-trip law (O14 backup)."
  exit 0
fi

# ==================================================================== teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  exit 0
fi

echo "usage: $0 setup|arm1|arm2|arm3|arm4|teardown" >&2
exit 1
