#!/bin/bash
# HEADSUB2 — confirm two inference gaps left by HEADSUB1 that the shipped #327
# scopes rely on. Write-up: docs/lab/headsub1-heading-subbuckets.md (§HEADSUB2).
#
# ONE disposable offline Tart clone `headsub2-lab` (pinned clock 2026-07-05 12:00;
# ordering is local — no cloud account). Fully HEADLESS (URL + AppleScript); no
# Accessibility, no VNC. Reuses the HEADSUB1 harness conventions verbatim.
#
#   research-headsub2.sh setup     clone+boot+airgap+clock-pin+seed both questions
#   research-headsub2.sh q1        re-head an ALREADY-headed member (someday + anytime)
#   research-headsub2.sh q1fix     the fix law: unhead -> re-head round-trip (someday)
#   research-headsub2.sh q2        AREA-child evening bounce (front-insert + area FK)
#   research-headsub2.sh teardown  stop + delete the clone
#
# Q1 — the load-bearing one. The shipped `heading-someday` scope (src/write/
#   reorder.ts runHeadingSomeday) sorts a heading's someday children by RE-HEADING
#   them in forward target order via `update?id=<u>&list-id=<project>&heading=<H>`
#   on rows ALREADY under that same heading — WITHOUT unheading first. HEADSUB1
#   proved the deterministic back-insert only for loose->heading (Arm B) and
#   unhead->re-head (Arm C); it never tested re-heading an item ALREADY under the
#   target heading. Verdict:
#     (a) BACK-INSERT per leg (final order == target) => shipped protocol correct;
#     (b) same-heading NO-OP (order unchanged) => shipped protocol BROKEN, needs
#         the unhead->re-head round-trip (probed by q1fix).
#   Also run the ANYTIME already-headed direct re-head (its shipped path is the
#   `heading` bounce, but the direct-re-head law is worth banking).
#
# Q2 — HEADSUB1 Arm D proved the child-evening bounce front-insert for a PROJECT
#   child only; #327 routes AREA-DIRECT evening children to the same evening scope
#   by INFERENCE. Bounce an area-direct this-evening to-do (away when=today, back
#   when=evening) among loose evening controls: same front-insert law with the
#   AREA FK + startBucket=1 + startDate preserved, or divergent?
#
# Conventions inherited from research-headsub1.sh: offline COW clone, guest airgap,
# clock pinned BEFORE Things launches, read-only guest SQLite, `with ids` comma-
# separated, NO clock advance (evening items live on today=2026-07-05).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v1}"
PIN="${PIN:-070512002026}"          # 2026-07-05 12:00 (golden pinnedDate)
VM="headsub2-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[headsub2] $*" | tee -a "$REPORT"; }

CMD="${1:-}"

# --------------------------------------------------------------- guest SQLite
GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

gq()  { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gas() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" </dev/null || true; }
gurl(){ lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; sleep 2; }
uuid_of() { local t="$1" typ="${2:-}" w u i; w="title='$t' AND trashed=0"; [ -n "$typ" ] && w="$w AND type=$typ"
  for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }
areaid() { gq "SELECT uuid FROM TMArea WHERE title='$1'"; }
# full within-container state for a title glob, ORDERED BY index (the anytime/someday axis)
dumpi() { gq "SELECT title||' idx='||\"index\"||' tIdx='||todayIndex||' start='||start||' sb='||COALESCE(startBucket,'-')||' sd='||COALESCE(substr(startDate,1,10),'-')||' h='||COALESCE(substr(heading,1,8),'-')||' p='||COALESCE(substr(project,1,8),'-')||' a='||COALESCE(substr(area,1,8),'-') FROM TMTask WHERE title LIKE '$1' AND trashed=0 ORDER BY \"index\""; }
# same, ORDERED BY todayIndex (the day/evening axis)
dumpt() { gq "SELECT title||' tIdx='||todayIndex||' idx='||\"index\"||' start='||start||' sb='||COALESCE(startBucket,'-')||' sd='||COALESCE(substr(startDate,1,10),'-')||' h='||COALESCE(substr(heading,1,8),'-')||' p='||COALESCE(substr(project,1,8),'-')||' a='||COALESCE(substr(area,1,8),'-') FROM TMTask WHERE title LIKE '$1' AND trashed=0 ORDER BY todayIndex, \"index\""; }
# ordered TITLE list (index ascending) — the visible order within an index bucket
ordi() { gq "SELECT group_concat(title,'<') FROM (SELECT title FROM TMTask WHERE title LIKE '$1' AND trashed=0 ORDER BY \"index\")"; }
# ordered TITLE list (todayIndex ascending) — the visible order within a day bucket
ordt() { gq "SELECT group_concat(title,'<') FROM (SELECT title FROM TMTask WHERE title LIKE '$1' AND trashed=0 ORDER BY todayIndex, \"index\")"; }
# area FK exact hex (byte-for-byte pre/post compare)
fkhex() { gq "SELECT title||' a='||COALESCE(hex(area),'NULL')||' p='||COALESCE(hex(project),'NULL')||' h='||COALESCE(hex(heading),'NULL') FROM TMTask WHERE title LIKE '$1' AND trashed=0 ORDER BY title"; }

tjson() {
  local url
  url=$(lab_ssh "$IP" "python3 -c 'import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))' $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null)
  lab_ssh "$IP" "open -g $(printf '%q' "$url")" </dev/null; sleep 3
}

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "cloning $GOLDEN -> $VM (evening day=2026-07-05)"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
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
  AA=$(areaid LAB-AREA-A)
  note "area A=$AA"

  # ---- SEED ----------------------------------------------------------------
  # Q1 someday: project Q1S-P, heading Q1S-H, FOUR someday children ALREADY under
  # the heading (Q1-s1..s4). This is the exact shipped-scope precondition.
  note "seed Q1 someday: project Q1S-P heading Q1S-H; Q1-s1..s4 someday headed children"
  tjson '[{"type":"project","attributes":{"title":"Q1S-P","items":[{"type":"heading","attributes":{"title":"Q1S-H"}},{"type":"to-do","attributes":{"title":"Q1-s1","when":"someday"}},{"type":"to-do","attributes":{"title":"Q1-s2","when":"someday"}},{"type":"to-do","attributes":{"title":"Q1-s3","when":"someday"}},{"type":"to-do","attributes":{"title":"Q1-s4","when":"someday"}}]}}]'

  # Q1 anytime: project Q1A-P, heading Q1A-H, FOUR anytime children already headed.
  note "seed Q1 anytime: project Q1A-P heading Q1A-H; Q1-a1..a4 anytime headed children"
  tjson '[{"type":"project","attributes":{"title":"Q1A-P","items":[{"type":"heading","attributes":{"title":"Q1A-H"}},{"type":"to-do","attributes":{"title":"Q1-a1"}},{"type":"to-do","attributes":{"title":"Q1-a2"}},{"type":"to-do","attributes":{"title":"Q1-a3"}},{"type":"to-do","attributes":{"title":"Q1-a4"}}]}}]'

  # Q1 fix group: project Q1F-P, heading Q1F-H, FOUR someday children already
  # headed (Q1-f1..f4) — reserved for the unhead->re-head round-trip fix probe so
  # the direct-re-head evidence (s-group) is never disturbed.
  note "seed Q1 fix: project Q1F-P heading Q1F-H; Q1-f1..f4 someday headed children"
  tjson '[{"type":"project","attributes":{"title":"Q1F-P","items":[{"type":"heading","attributes":{"title":"Q1F-H"}},{"type":"to-do","attributes":{"title":"Q1-f1","when":"someday"}},{"type":"to-do","attributes":{"title":"Q1-f2","when":"someday"}},{"type":"to-do","attributes":{"title":"Q1-f3","when":"someday"}},{"type":"to-do","attributes":{"title":"Q1-f4","when":"someday"}}]}}]'

  # Q2: area-direct this-evening children in LAB-AREA-A (Q2-ae1..3) + loose evening
  # controls (Q2-le1..3, no area — the shipped evening scope's proven front-insert).
  note "seed Q2: Q2-ae1..3 area-direct evening (LAB-AREA-A); Q2-le1..3 loose evening controls"
  for t in Q2-ae1 Q2-ae2 Q2-ae3; do gurl "things:///add?title=$t&when=evening&list-id=$AA"; done
  for t in Q2-le1 Q2-le2 Q2-le3; do gurl "things:///add?title=$t&when=evening"; done
  sleep 2

  note "--- seed verification ---"
  note "Q1 someday headed (expect h=<Q1S-H>, start=2, sd=-, idx ascending s1<s2<s3<s4): $(dumpi 'Q1-s%' | tr '\n' ' ')"
  note "Q1 anytime headed (expect h=<Q1A-H>, start=1, idx ascending a1<a2<a3<a4): $(dumpi 'Q1-a%' | tr '\n' ' ')"
  note "Q1 fix headed (expect h=<Q1F-H>, start=2, idx ascending f1<f2<f3<f4): $(dumpi 'Q1-f%' | tr '\n' ' ')"
  note "Q2 area-direct evening (expect sb=1, sd=2026-07-05, a=<$AA>, p=-, h=-): $(dumpt 'Q2-ae%' | tr '\n' ' ')"
  note "Q2 loose evening controls (expect sb=1, sd=2026-07-05, a=-,p=-,h=-): $(dumpt 'Q2-le%' | tr '\n' ' ')"
  note "setup DONE — session in $SESSION"
  exit 0
fi

# ==================================================================== Q1
if [ "$CMD" = "q1" ]; then
  load_session
  note "################## Q1 — re-head an ALREADY-headed member (direct, no unhead) ##################"

  # ----- Q1a someday (the load-bearing shipped path) -----
  SP=$(gq "SELECT uuid FROM TMTask WHERE title='Q1S-P' AND type=1")
  S1=$(uuid_of Q1-s1); S2=$(uuid_of Q1-s2); S3=$(uuid_of Q1-s3); S4=$(uuid_of Q1-s4)
  note "  Q1S-P=$SP (heading param takes TITLE 'Q1S-H')"
  # direct re-head leg: EXACTLY the shipped todo.move re-head (list-id=project & heading=title)
  rehead_s() { gurl "things:///update?id=$1&auth-token=$TOKEN&list-id=$SP&heading=Q1S-H"; }
  note "  ===== SOMEDAY already-headed ====="
  note "  BEFORE (index order): $(ordi 'Q1-s%')  || $(dumpi 'Q1-s%' | tr '\n' ' ')"
  note "  target (scrambled)  : Q1-s3<Q1-s1<Q1-s4<Q1-s2 ; re-head in that FORWARD order (shipped protocol)"
  note "    re-head Q1-s3..."; rehead_s "$S3"; note "      -> $(ordi 'Q1-s%')"
  note "    re-head Q1-s1..."; rehead_s "$S1"; note "      -> $(ordi 'Q1-s%')"
  note "    re-head Q1-s4..."; rehead_s "$S4"; note "      -> $(ordi 'Q1-s%')"
  note "    re-head Q1-s2..."; rehead_s "$S2"; note "      -> $(ordi 'Q1-s%')"
  note "  AFTER (index order) : $(ordi 'Q1-s%')  || $(dumpi 'Q1-s%' | tr '\n' ' ')"
  note "  VERDICT-Q1-someday: final == Q1-s3<Q1-s1<Q1-s4<Q1-s2 => (a) BACK-INSERT per leg, shipped heading-someday CORRECT. final == original s1<s2<s3<s4 (or unchanged) => (b) same-heading NO-OP, shipped protocol BROKEN (needs unhead->re-head, see q1fix)."

  # ----- Q1b anytime already-headed (direct re-head law; shipped path is the bounce) -----
  AP=$(gq "SELECT uuid FROM TMTask WHERE title='Q1A-P' AND type=1")
  A1=$(uuid_of Q1-a1); A2=$(uuid_of Q1-a2); A3=$(uuid_of Q1-a3); A4=$(uuid_of Q1-a4)
  rehead_a() { gurl "things:///update?id=$1&auth-token=$TOKEN&list-id=$AP&heading=Q1A-H"; }
  note "  ===== ANYTIME already-headed (direct re-head law) ====="
  note "  Q1A-P=$AP"
  note "  BEFORE (index order): $(ordi 'Q1-a%')  || $(dumpi 'Q1-a%' | tr '\n' ' ')"
  note "  target (scrambled)  : Q1-a3<Q1-a1<Q1-a4<Q1-a2 ; re-head FORWARD"
  note "    re-head Q1-a3..."; rehead_a "$A3"; note "      -> $(ordi 'Q1-a%')"
  note "    re-head Q1-a1..."; rehead_a "$A1"; note "      -> $(ordi 'Q1-a%')"
  note "    re-head Q1-a4..."; rehead_a "$A4"; note "      -> $(ordi 'Q1-a%')"
  note "    re-head Q1-a2..."; rehead_a "$A2"; note "      -> $(ordi 'Q1-a%')"
  note "  AFTER (index order) : $(ordi 'Q1-a%')  || $(dumpi 'Q1-a%' | tr '\n' ' ')"
  note "  VERDICT-Q1-anytime: final == Q1-a3<Q1-a1<Q1-a4<Q1-a2 => direct re-head back-inserts for anytime too; == original => same-heading no-op."
  exit 0
fi

# ==================================================================== q1fix
# The fix law (needed only if Q1 == (b)): unhead the whole block first (clean, per
# Arm C — heading->NULL, index/start preserved), then re-head in forward target
# order (Arm B loose->heading back-insert). Probed on the reserved f-group so it is
# independent of the q1 direct-re-head evidence.
if [ "$CMD" = "q1fix" ]; then
  load_session
  note "################## Q1 FIX — unhead -> re-head round-trip (someday, same heading) ##################"
  FP=$(gq "SELECT uuid FROM TMTask WHERE title='Q1F-P' AND type=1")
  F1=$(uuid_of Q1-f1); F2=$(uuid_of Q1-f2); F3=$(uuid_of Q1-f3); F4=$(uuid_of Q1-f4)
  unhead_f() { gurl "things:///update?id=$1&auth-token=$TOKEN&list-id=$FP"; }
  rehead_f() { gurl "things:///update?id=$1&auth-token=$TOKEN&list-id=$FP&heading=Q1F-H"; }
  note "  Q1F-P=$FP"
  note "  BEFORE (index order): $(ordi 'Q1-f%')  || $(dumpi 'Q1-f%' | tr '\n' ' ')"
  note "  ---- step 1: unhead ALL four (expect h=NULL, p=<Q1F-P>, start=2, index preserved) ----"
  unhead_f "$F1"; unhead_f "$F2"; unhead_f "$F3"; unhead_f "$F4"
  note "     after unhead: $(dumpi 'Q1-f%' | tr '\n' ' ')"
  note "  ---- step 2: re-head in FORWARD target order Q1-f3,Q1-f1,Q1-f4,Q1-f2 ----"
  rehead_f "$F3"; note "      -> $(ordi 'Q1-f%')"
  rehead_f "$F1"; note "      -> $(ordi 'Q1-f%')"
  rehead_f "$F4"; note "      -> $(ordi 'Q1-f%')"
  rehead_f "$F2"; note "      -> $(ordi 'Q1-f%')"
  note "  AFTER (index order) : $(ordi 'Q1-f%')  || $(dumpi 'Q1-f%' | tr '\n' ' ')"
  note "  VERDICT-Q1-fix: final == Q1-f3<Q1-f1<Q1-f4<Q1-f2 with h=<Q1F-H>, start=2 => the unhead->re-head round-trip IS the sort protocol for already-headed someday children (the wiring fix)."
  exit 0
fi

# ==================================================================== Q2
if [ "$CMD" = "q2" ]; then
  load_session
  note "################## Q2 — AREA-child evening bounce (front-insert + area FK) ##################"
  AA=$(areaid LAB-AREA-A)
  AE1=$(uuid_of Q2-ae1); AE2=$(uuid_of Q2-ae2); AE3=$(uuid_of Q2-ae3)
  LE1=$(uuid_of Q2-le1); LE2=$(uuid_of Q2-le2); LE3=$(uuid_of Q2-le3)
  note "  LAB-AREA-A=$AA"
  note "  BounceSpec 'evening': away=today, back=evening, direction=front, rankKey=todayIndex, legOp=todo.update"
  note "  area-direct evening BEFORE (todayIndex order): $(dumpt 'Q2-ae%' | tr '\n' ' ')"
  note "  loose evening controls BEFORE: $(dumpt 'Q2-le%' | tr '\n' ' ')"

  ebounce() { # the evening bounce legs: away when=today, back when=evening
    gurl "things:///update?id=$1&auth-token=$TOKEN&when=today"
    gurl "things:///update?id=$1&auth-token=$TOKEN&when=evening"
  }

  note "  ---- Q2.1 bounce ONE area child (Q2-ae2): re-entry position + area FK + flag preserved? ----"
  note "     Q2-ae2 FK before: $(fkhex 'Q2-ae2' | tr '\n' ' ')"
  ebounce "$AE2"
  note "     after bounce Q2-ae2 (sb still 1? sd still 2026-07-05? a=<$AA>? tIdx front/back?): $(dumpt 'Q2-ae%' | tr '\n' ' ')"
  note "     Q2-ae2 FK after: $(fkhex 'Q2-ae2' | tr '\n' ' ')"

  note "  ---- Q2.2 full-block bounce FORWARD order Q2-ae1,ae2,ae3 (front-insert => reverse final; back-insert => same) ----"
  ebounce "$AE1"; note "       after ae1: $(ordt 'Q2-ae%')"
  ebounce "$AE2"; note "       after ae2: $(ordt 'Q2-ae%')"
  ebounce "$AE3"; note "       after ae3: $(ordt 'Q2-ae%')"
  note "     FINAL area-child tIdx order: $(ordt 'Q2-ae%')  || $(dumpt 'Q2-ae%' | tr '\n' ' ')"

  note "  ---- Q2.3 loose evening control (shipped evening scope) — same forward bounce ----"
  ebounce "$LE1"; ebounce "$LE2"; ebounce "$LE3"
  note "     FINAL loose control tIdx order: $(ordt 'Q2-le%')  || $(dumpt 'Q2-le%' | tr '\n' ' ')"
  note "  VERDICT-Q2: area child FINAL == Q2-ae3<Q2-ae2<Q2-ae1 (front-insert) with sb=1 + a=<$AA> (FK byte-identical) + sd=2026-07-05 preserved, SAME direction as loose control (Q2-le3<le2<le1) => the evening scope's front-insert law holds for area-direct children unchanged (#327 inference CONFIRMED). Divergent order/lost FK/lost flag => note the divergence."
  exit 0
fi

# ================================================================= teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  exit 0
fi

echo "usage: $0 setup|q1|q1fix|q2|teardown" >&2
exit 1
