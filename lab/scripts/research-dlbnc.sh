#!/bin/bash
# DLBNC — the deadline-forecast day-block ordering axis: GUI drag ground truth +
# the deadline-set / deadline-cycle todayIndex law. Extends UPCDL (#382).
# Write-up: docs/lab/dlbnc-deadline-cycle.md.
#
# MAINTAINER-ESTABLISHED MODEL (ground truth for this campaign):
#   The Upcoming view's day blocks order on todayIndex, period. Deadline-forecast
#   rows (someday/anytime + deadline, startDate NULL) are dual citizens:
#     * `index`       orders them in their project's someday/anytime bucket
#     * `todayIndex`  orders them within the ROOT Upcoming day block ONLY
#   So the render axis is settled; the open question is whether that todayIndex is
#   *user-controllable in a state-preserving way* (a wireable reorder protocol) or
#   whether every path that writes it also drags a startDate (UPCDL's finding for
#   the hidden-list specifiers). This campaign tests two fresh levers UPCDL did not:
#   the GUI drag (DLBNC-1) and the deadline-set / deadline-cycle (DLBNC-2/3).
#
# ONE disposable offline Tart clone `dlbnc-lab` (pinned clock 2026-07-05 12:00;
# ordering is local — no cloud account). Boots with --vnc-experimental so the
# guest has a framebuffer for `screencapture -x` (the HEADARC2/SX6 capture path —
# NO vncdotool required). Deadline set/clear via URL `deadline=` AND AppleScript
# `due date`; byte deltas from read-only guest SQLite are ground truth.
#
# Subcommands:
#   research-dlbnc.sh setup      clone+boot(vnc)+airgap+clock-pin+warm+seed+canary
#   research-dlbnc.sh caps       DLBNC-cap — screencapture + AX availability probe
#   research-dlbnc.sh arm1obs    DLBNC-1d — GUI observe (screencapture Upcoming, default placement)
#   research-dlbnc.sh arm1drag   DLBNC-1abc — GUI drag ground truth (gated on caps)
#   research-dlbnc.sh arm2        DLBNC-2 — deadline-set todayIndex assignment law
#   research-dlbnc.sh arm3        DLBNC-3 — the deadline-cycle bounce (+ collateral, protocol proof)
#   research-dlbnc.sh arm4        DLBNC-4 — (conditional) characterize the protocol
#   research-dlbnc.sh pulldb <l>  copy the guest DB to the host
#   research-dlbnc.sh teardown    stop + delete the clone
#
# Conventions inherited from research-upcdl.sh / research-ordfin1.sh:
#   * offline COW clone, guest airgap (delete default route), clock pinned BEFORE
#     Things launches, read-only guest SQLite.
#   * dates SEEDED via URL `when=`/`deadline=<ISO>` (the APP packs the ints) —
#     NEVER hand-pack a date integer; preservation asserted by DB read comparison.
#   * NEVER send URL `when=`/schedule-class to a REPEATING template row (§1 CRASH).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v1}"
PIN="${PIN:-070512002026}"           # 2026-07-05 12:00 (golden pinnedDate)
TODAY="${TODAY:-2026-07-05}"         # the pinned Today
TMRW="${TMRW:-2026-07-06}"           # tomorrow (first upcoming day)
DLDAY="${DLDAY:-2026-07-08}"         # shared future deadline day (3 days out; NOT tomorrow)
OTHERDAY="${OTHERDAY:-2026-07-09}"   # a second scheduled/deadline day
AA="7Ck4hAXU36jyaBsy2Fkije"          # LAB-AREA-A (seed-manifest)
VM="dlbnc-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/screens"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[dlbnc] $*" | tee -a "$REPORT"; }

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
# FULL byte row for a uuid — every column the campaign cares about.
one() { gq "SELECT title||' tIdx='||todayIndex||' idx='||\"index\"||' start='||start||' sb='||COALESCE(startBucket,'-')||' sd='||COALESCE(startDate,'-')||' tiRef='||COALESCE(todayIndexReferenceDate,'-')||' rem='||COALESCE(reminderTime,'-')||' dl='||COALESCE(deadline,'-')||' dlSup='||COALESCE(deadlineSuppressionDate,'-')||' h='||COALESCE(substr(heading,1,8),'-')||' p='||COALESCE(substr(project,1,8),'-')||' a='||COALESCE(substr(area,1,8),'-')||' cd='||CAST(creationDate AS INT)||' umd='||CAST(COALESCE(userModificationDate,0) AS INT) FROM TMTask WHERE uuid='$1'"; }
tidx_order() { gq "SELECT group_concat(title||':'||todayIndex,' ') FROM (SELECT title,todayIndex FROM TMTask WHERE title IN ($1) AND trashed=0 ORDER BY todayIndex)"; }
idx_order()  { gq "SELECT group_concat(title||':'||\"index\",' ') FROM (SELECT title,\"index\" FROM TMTask WHERE title IN ($1) AND trashed=0 ORDER BY \"index\")"; }

tjson() {
  local url
  url=$(lab_ssh "$IP" "python3 -c 'import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))' $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null)
  lab_ssh "$IP" "open -g $(printf '%q' "$url")" </dev/null; sleep 3
}

# private reorder (arm6 index-repair leg — the UPCDL-3 clean `index` re-rank).
# `with ids` is a comma-separated string; re-ranks the addressed key ASCENDING in
# the sent id order. Captures the AppleScript transport result.
reord() { gas "tell application \"Things3\" to _private_experimental_ reorder to dos in $1 with ids \"$2\""; sleep 2; }
# private-reorder functional canary (arm6 only) — re-rank the throwaway pair via
# the CONTAINER specifier; a clean return proves the private surface is live.
canaryP() {
  [ -n "${P:-}" ] && [ -n "${CANA:-}" ] && [ -n "${CANB:-}" ] || { note "canaryP: missing P/CANA/CANB"; return 0; }
  local r; r=$(reord "project id \"$P\"" "$CANB,$CANA")
  if echo "$r" | grep -qiE "understand|-1708|-1728|-2740"; then note "PRIVATE-REORDER canary FAILED: [$r]"; return 1; fi
  note "private-reorder canary OK [${r:-clean}]"; return 0
}

# deadline set/clear vectors --------------------------------------------------
dl_url_set()   { gurl "things:///update?id=$1&auth-token=$TOKEN&deadline=$2"; }
dl_url_clear() { gurl "things:///update?id=$1&auth-token=$TOKEN&deadline="; }
# AppleScript: `due date` is the sdef property for the deadline; guest clock is
# pinned 2026-07-05 12:00, so (current date)+N*days lands on midnight-normalized
# deadline day N. NOTE (DLBNC finding): AS CANNOT clear a deadline —
# `set due date ... to missing value` errors -1700 ("Can't make missing value
# into type date"); the clear vector is URL `deadline=` (empty). AS `due date`
# set works fine (a valid second SET vector alongside URL).
dl_as_set()   { gas "tell application \"Things3\" to set due date of to do id \"$1\" to ((current date) + $2 * days)"; sleep 2; }
dl_as_clear() { gas "tell application \"Things3\" to set due date of to do id \"$1\" to missing value"; sleep 2; }

# functional canary (public verbs only — DLBNC uses no private reorder verb):
# round-trip a deadline on the throwaway pair via URL set + URL clear (the protocol
# vectors), and separately confirm AS `due date` set writes the same byte.
canary() {
  [ -n "${CANA:-}" ] || { note "canary: no CANA — skipping"; return 0; }
  dl_url_set "$CANA" "$DLDAY"; local d; d=$(gq "SELECT COALESCE(deadline,'NULL') FROM TMTask WHERE uuid='$CANA'")
  dl_url_clear "$CANA"; local c; c=$(gq "SELECT COALESCE(deadline,'NULL') FROM TMTask WHERE uuid='$CANA'")
  dl_as_set "$CANA" 3; local a; a=$(gq "SELECT COALESCE(deadline,'NULL') FROM TMTask WHERE uuid='$CANA'")
  dl_url_clear "$CANA"
  if [ "$d" = "NULL" ] || [ "$c" != "NULL" ] || [ "$a" = "NULL" ]; then note "FUNCTIONAL canary FAILED — deadline set/clear not working (urlSet=$d urlClear=$c asSet=$a)"; return 1; fi
  note "functional canary OK (url set=$d url clear=$c; AS set=$a)"; return 0
}

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "cloning $GOLDEN -> $VM (deadline day $DLDAY, other $OTHERDAY, today $TODAY) [vnc-experimental for screencapture]"
  pkill -f "tart run $VM" >/dev/null 2>&1 || true
  tart stop "$VM" >/dev/null 2>&1 || true
  sleep 3
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM" || { note "clone FAILED"; exit 1; }
  (tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
  note "ssh up at $IP"
  VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
  note "vnc url: ${VNC_URL:-<none>}"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo route -n delete -inet6 default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"
  { echo "IP=$IP"; echo "VNC_URL=$VNC_URL"; } > "$SESSION"

  note "warm-up: launch/quit/relaunch Things on the pinned date"
  lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3' </dev/null
  lab_ssh "$IP" 'open -g -a Things3; sleep 8' </dev/null

  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  echo "TOKEN=$TOKEN" >> "$SESSION"
  note "auth token in hand (${#TOKEN} chars)"

  # ---- Fixture: project P with heading P-H ----
  note "seed project P (with heading P-H)"
  tjson '[{"type":"project","attributes":{"title":"DLBNC-P","area-id":"'$AA'","items":[{"type":"heading","attributes":{"title":"P-H"}}]}}]'; sleep 2
  P=$(gq "SELECT uuid FROM TMTask WHERE title='DLBNC-P' AND type=1")
  echo "P=$P" >> "$SESSION"; note "  P=$P"

  # canary pair (public due-date round-trip)
  note "seed canary pair CAN-A/CAN-B in P"
  for t in CAN-A CAN-B; do gurl "things:///add?title=$t&list-id=$P"; sleep 1; done
  CANA=$(uuid_of CAN-A); CANB=$(uuid_of CAN-B)
  { echo "CANA=$CANA"; echo "CANB=$CANB"; } >> "$SESSION"
  canary || { note "CANARY FAILED — aborting setup"; exit 1; }

  # SCH1/SCH2 — loose SCHEDULED rows for the deadline day (startDate=DLDAY): the
  # scheduled cohort of the DLDAY Upcoming block (todayIndex axis members).
  note "seed SCH1/SCH2 — loose scheduled @$DLDAY (block scheduled cohort)"
  for t in SCH1 SCH2; do gurl "things:///add?title=$t&when=$DLDAY"; sleep 1; done
  SCH1=$(uuid_of SCH1); SCH2=$(uuid_of SCH2)

  # DF1/DF2/DF3 — someday+deadline(DLDAY), no startDate: the forecast cohort in P.
  note "seed DF1/DF2/DF3 — someday+deadline($DLDAY) forecast rows in P"
  for t in DF1 DF2 DF3; do gurl "things:///add?title=$t&when=someday&deadline=$DLDAY&list-id=$P"; sleep 1; done
  DF1=$(uuid_of DF1); DF2=$(uuid_of DF2); DF3=$(uuid_of DF3)

  # ND1/ND2/ND3 — plain SOMEDAY, NO deadline (start=2, startDate NULL): arm2 targets.
  note "seed ND1/ND2/ND3 — plain someday, NO deadline (deadline-set targets)"
  for t in ND1 ND2 ND3; do gurl "things:///add?title=$t&when=someday&list-id=$P"; sleep 1; done
  ND1=$(uuid_of ND1); ND2=$(uuid_of ND2); ND3=$(uuid_of ND3)

  # HDF — HEADED someday+deadline row under P-H (heading-rip control for arm3d).
  note "seed HDF — someday+deadline($DLDAY) headed under P-H"
  gurl "things:///add?title=HDF&when=someday&deadline=$DLDAY&list-id=$P&heading=P-H"; sleep 1
  HDF=$(uuid_of HDF)

  { echo "SCH1=$SCH1"; echo "SCH2=$SCH2"; echo "DF1=$DF1"; echo "DF2=$DF2"; echo "DF3=$DF3";
    echo "ND1=$ND1"; echo "ND2=$ND2"; echo "ND3=$ND3"; echo "HDF=$HDF"; } >> "$SESSION"

  note "--- fixture bytes ---"
  for v in SCH1 SCH2 DF1 DF2 DF3 ND1 ND2 ND3 HDF; do eval "u=\$$v"; note "  $v: $(one "$u")"; done
  note "setup DONE — session in $SESSION"
  exit 0
fi

# ==================================================================== caps
if [ "$CMD" = "caps" ]; then
  load_session
  note "################## DLBNC-cap — GUI capability probe (screencapture + AX) ##################"
  lab_ssh "$IP" "open 'things:///show?id=upcoming'; sleep 4" </dev/null
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to activate"; sleep 2' </dev/null
  note "-- screencapture -x probe --"
  lab_ssh "$IP" 'screencapture -x /tmp/cap-probe.png 2>&1 || echo "screencapture-rc=$?"' </dev/null | tee -a "$REPORT"
  lab_scp "$LAB_SSH_USER@$IP:/tmp/cap-probe.png" "$OUT/screens/cap-probe.png" </dev/null 2>/dev/null || true
  if [ -f "$OUT/screens/cap-probe.png" ]; then
    SZ=$(stat -f%z "$OUT/screens/cap-probe.png" 2>/dev/null || echo 0)
    note "  screencapture pulled: $SZ bytes -> $OUT/screens/cap-probe.png (inspect for black-frame)"
  else
    note "  screencapture NOT pulled (empty/failed)"
  fi
  note "-- Screen Recording / Accessibility TCC state (system) --"
  lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT service,client,auth_value FROM access WHERE service LIKE '\''%ScreenCapture%'\'' OR service LIKE '\''%Accessibility%'\''" 2>&1 || echo "sys-tcc-rc=$?"' </dev/null | tee -a "$REPORT"
  note "-- AX read probe (does osascript System Events see Things3 UI without a grant?) --"
  lab_ssh "$IP" 'osascript -e "tell application \"System Events\" to tell process \"Things3\" to count windows" 2>&1' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'osascript -e "tell application \"System Events\" to tell process \"Things3\" to get name of every menu of menu bar 1" 2>&1 | head -c 200' </dev/null | tee -a "$REPORT"; echo | tee -a "$REPORT"
  note "VERDICT-cap: screencapture usable? (non-black) / AX readable without grant? -> decides arm1drag depth."
  exit 0
fi

# ==================================================================== arm1obs
if [ "$CMD" = "arm1obs" ]; then
  load_session
  note "################## DLBNC-1d — GUI observe: default placement in the DLDAY block ##################"
  note "  DF/SCH resting bytes (pristine, pre-drag):"
  for v in SCH1 SCH2 DF1 DF2 DF3; do eval "u=\$$v"; note "    $v: $(one "$u")"; done
  note "  todayIndex order (SCH+DF, ascending): $(tidx_order "'SCH1','SCH2','DF1','DF2','DF3'")"
  note "  index order      (SCH+DF, ascending): $(idx_order  "'SCH1','SCH2','DF1','DF2','DF3'")"
  lab_ssh "$IP" "open 'things:///show?id=upcoming'; sleep 4" </dev/null
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to activate"; sleep 3' </dev/null
  lab_ssh "$IP" 'screencapture -x /tmp/dlbnc-upcoming.png 2>/dev/null || true' </dev/null
  lab_scp "$LAB_SSH_USER@$IP:/tmp/dlbnc-upcoming.png" "$OUT/screens/upcoming.png" </dev/null 2>/dev/null || true
  note "  screenshot -> $OUT/screens/upcoming.png (read visually: DF rows interleaved with SCH on todayIndex, or clustered?)"
  exit 0
fi

# ==================================================================== arm2
# DLBNC-2 — set a deadline on a NO-deadline someday row: what todayIndex is
# assigned (front/global-min vs back), across URL and AppleScript vectors, and is
# it deterministic/repeatable? ND rows are plain someday (todayIndex resting).
if [ "$CMD" = "arm2" ]; then
  load_session; canary || exit 1
  note "################## DLBNC-2 — deadline-set todayIndex assignment law ##################"
  note "  block context — existing forecast rows' todayIndex (the incumbents): $(tidx_order "'DF1','DF2','DF3'")"
  note "  --- 2a: ND1 via URL deadline=$DLDAY ---"
  note "    ND1 before: $(one "$ND1")"
  dl_url_set "$ND1" "$DLDAY"
  note "    ND1 after URL set: $(one "$ND1")"
  note "  --- 2b: ND2 via AppleScript due date ((current date)+3 days = $DLDAY) ---"
  note "    ND2 before: $(one "$ND2")"
  dl_as_set "$ND2" 3
  note "    ND2 after AS set: $(one "$ND2")"
  note "  --- 2c: determinism/repeatability — clear ND1 then re-set, twice, compare todayIndex ---"
  dl_url_clear "$ND1"; note "    ND1 after clear:   $(one "$ND1")"
  dl_url_set "$ND1" "$DLDAY"; T_A=$(gq "SELECT todayIndex FROM TMTask WHERE uuid='$ND1'"); note "    ND1 re-set #1 tIdx=$T_A"
  dl_url_clear "$ND1"; dl_url_set "$ND1" "$DLDAY"; T_B=$(gq "SELECT todayIndex FROM TMTask WHERE uuid='$ND1'"); note "    ND1 re-set #2 tIdx=$T_B"
  note "    determinism: re-set#1=$T_A re-set#2=$T_B (equal => repeatable insertion point)"
  note "  post-state todayIndex order (DF+ND1+ND2, ascending): $(tidx_order "'DF1','DF2','DF3','ND1','ND2'")"
  note "  VERDICT-2: (i) is a distinct non-zero todayIndex ASSIGNED on deadline-set? (ii) FRONT (more-negative than all incumbents = global min) or BACK? (iii) URL == AppleScript law? (iv) deterministic/repeatable? (v) index/start/startDate collateral?"
  exit 0
fi

# ==================================================================== arm3
# DLBNC-3 — the deadline-cycle bounce: clear deadline then re-set same deadline.
# (a) does re-set re-enter at the DLBNC-2 insertion point deterministically?
# (b) FULL collateral per leg (index, dlSup, reminders, start/startDate, umd,
#     heading/project FKs, atomicity).  (c) protocol proof: scrambled -> target.
# (d) headed-row rip control on a deadline= leg.
if [ "$CMD" = "arm3" ]; then
  load_session; canary || exit 1
  note "################## DLBNC-3 — the deadline-cycle bounce ##################"
  note "  seed C1/C2/C3 — someday+deadline($DLDAY) forecast rows in P"
  for t in C1 C2 C3; do gurl "things:///add?title=$t&when=someday&deadline=$DLDAY&list-id=$P"; sleep 1; done
  C1=$(uuid_of C1); C2=$(uuid_of C2); C3=$(uuid_of C3)
  { echo "C1=$C1"; echo "C2=$C2"; echo "C3=$C3"; } >> "$SESSION"
  for v in C1 C2 C3; do eval "u=\$$v"; note "    $v resting: $(one "$u")"; done
  note "  resting todayIndex order: $(tidx_order "'C1','C2','C3'")"
  note "  resting index order:      $(idx_order  "'C1','C2','C3'")"

  note "  --- 3b: FULL collateral on ONE representative leg (C2), URL vector ---"
  note "    C2 before leg:        $(one "$C2")"
  dl_url_clear "$C2"; note "    C2 after clear:       $(one "$C2")"
  dl_url_set "$C2" "$DLDAY"; note "    C2 after re-set:      $(one "$C2")"
  note "    VERDICT-3b: index preserved? dlSup? reminder? start/startDate? umd bumps per leg? heading/project FK? (deadline is not a containment write — expect FK-safe)"

  note "  --- 3d: headed-row rip control (HDF) on a deadline= clear+set leg ---"
  note "    HDF before: $(one "$HDF")"
  dl_url_clear "$HDF"; dl_url_set "$HDF" "$DLDAY"
  note "    HDF after:  $(one "$HDF")"
  note "    VERDICT-3d: heading FK preserved (h=) — deadline= is not a containment write?"

  note "  --- 3c: PROTOCOL PROOF — scramble C1/C2/C3, deadline-cycle to an exact target block order ---"
  note "    (arm2 establishes whether deadline-set FRONT-inserts at global min; if so, dispatch REVERSE target order so the last-cycled lands most-negative = first)"
  note "    someday-bucket index BEFORE protocol: $(idx_order "'C1','C2','C3'")"
  # Re-cycle all three from a clean deadline so the protocol proof starts uniform
  # (3b churned C2 only; make the starting deadline state identical across C1/C2/C3).
  for u in "$C1" "$C2" "$C3"; do dl_url_clear "$u"; dl_url_set "$u" "$DLDAY"; done
  note "    todayIndex after uniform re-cycle: $(tidx_order "'C1','C2','C3'")"
  note "    TARGET block order (ascending todayIndex) := C2 < C1 < C3 (scrambled vs creation C1<C2<C3)."
  note "    REVERSE-target dispatch (front-insert => last dispatched = most-negative = first): C3, C1, C2"
  for u in "$C3" "$C1" "$C2"; do dl_url_clear "$u"; dl_url_set "$u" "$DLDAY"; done
  for v in C1 C2 C3; do eval "u=\$$v"; note "    $v after protocol: $(one "$u")"; done
  note "    FINAL todayIndex order: $(tidx_order "'C1','C2','C3'")   (target: C2<C1<C3)"
  note "    someday-bucket index AFTER protocol: $(idx_order "'C1','C2','C3'")   (must be byte-identical to BEFORE)"
  note "  VERDICT-3c: is FINAL ascending todayIndex == TARGET (C2<C1<C3) AND is the someday-bucket index order byte-identical before/after? (=> a working state-preserving block-reorder protocol via deadline-cycle)"
  exit 0
fi

# ==================================================================== arm4
if [ "$CMD" = "arm4" ]; then
  load_session; canary || exit 1
  note "################## DLBNC-4 — characterize the deadline-cycle protocol (conditional) ##################"
  note "  seed G1/G2/G3 — fresh someday+deadline rows"
  for t in G1 G2 G3; do gurl "things:///add?title=$t&when=someday&deadline=$DLDAY&list-id=$P"; sleep 1; done
  G1=$(uuid_of G1); G2=$(uuid_of G2); G3=$(uuid_of G3)
  for v in G1 G2 G3; do eval "u=\$$v"; note "    $v resting: $(one "$u")"; done
  note "  --- atomicity: single leg (G2), count umd bumps + measure whether clear and set are separate txns ---"
  U0=$(gq "SELECT CAST(userModificationDate AS INT) FROM TMTask WHERE uuid='$G2'")
  dl_url_clear "$G2"; U1=$(gq "SELECT CAST(userModificationDate AS INT) FROM TMTask WHERE uuid='$G2'")
  dl_url_set "$G2" "$DLDAY"; U2=$(gq "SELECT CAST(userModificationDate AS INT) FROM TMTask WHERE uuid='$G2'")
  note "    umd: rest=$U0 afterClear=$U1 afterSet=$U2 (clear and set each bump => 2 txns per leg)"
  note "  VERDICT-4: insertion-law name, leg op (clear+set deadline), atomicity (2 URL txns/leg), undo shape, gates — per novel-paths standard. (Characterize ONLY; wiring is a maintainer-gated follow-up.)"
  exit 0
fi

# ==================================================================== arm5
# DLBNC-5 — the when-cycle variant (maintainer follow-up): does a
# when=today -> when=someday round-trip on a FORECAST row preserve both axes
# (like UPCDL-7 Q2's someday->DATE->someday) or front-insert todayIndex?
# Full collateral: reminderTime (R07/§9n clear-on-when= audit), start/startDate,
# deadline/tiRef, index, umd.
if [ "$CMD" = "arm5" ]; then
  load_session; canary || exit 1
  note "################## DLBNC-5 — the when=today<->someday round-trip on a forecast row ##################"
  note "  seed E1/E2/E3 — someday+deadline($DLDAY) forecast rows in P"
  for t in E1 E2 E3; do gurl "things:///add?title=$t&when=someday&deadline=$DLDAY&list-id=$P"; sleep 1; done
  E1=$(uuid_of E1); E2=$(uuid_of E2); E3=$(uuid_of E3)
  for v in E1 E2 E3; do eval "u=\$$v"; note "    $v resting: $(one "$u")"; done
  note "  resting todayIndex order: $(tidx_order "'E1','E2','E3'")"
  note "  resting index order:      $(idx_order  "'E1','E2','E3'")"

  note "  --- 5-collateral: single row E1, full one() before / after when=today / after when=someday ---"
  note "    E1 before:           $(one "$E1")"
  gurl "things:///update?id=$E1&auth-token=$TOKEN&when=today"
  note "    E1 after when=today: $(one "$E1")"
  gurl "things:///update?id=$E1&auth-token=$TOKEN&when=someday"
  note "    E1 after when=someday: $(one "$E1")"
  note "    VERDICT-5collateral: back to forecast (start=2, startDate NULL, deadline/tiRef intact)? todayIndex preserved or front-inserted? index byte-identical? reminderTime (R07/§9n)? umd bumps?"

  note "  --- 5-protocol: scramble E1/E2/E3 via when=today->when=someday, dispatched REVERSE target order ---"
  note "    someday-bucket index BEFORE: $(idx_order "'E1','E2','E3'")"
  note "    TARGET block order (ascending todayIndex) := E2 < E1 < E3.  REVERSE dispatch: E3, E1, E2"
  for u in "$E3" "$E1" "$E2"; do
    gurl "things:///update?id=$u&auth-token=$TOKEN&when=today"
    gurl "things:///update?id=$u&auth-token=$TOKEN&when=someday"
  done
  for v in E1 E2 E3; do eval "u=\$$v"; note "    $v after when-cycle: $(one "$u")"; done
  note "    FINAL todayIndex order: $(tidx_order "'E1','E2','E3'")   (target: E2<E1<E3)"
  note "    someday-bucket index AFTER: $(idx_order "'E1','E2','E3'")   (must be byte-identical to BEFORE)"
  note "  VERDICT-5: does when=today->someday PRESERVE todayIndex (closed door, like Q2) or FRONT-INSERT it deterministically (a second protocol candidate)? index byte-identical either way?"
  exit 0
fi

# ==================================================================== arm1drag
# DLBNC-1abc — GUI drag byte audit. Requires the GUI; AX is DENIED on this host
# (no vncdotool, no Accessibility grant), so this is a BEST-EFFORT fixed-coordinate
# CGEventPost drag (the axdrag2 posting primitive WITHOUT AX reads). If Sequoia
# gates synthetic events for a non-trusted process, the drag is a no-op (zero DB
# delta) and the byte audit falls back to logical inference + the deadline-cycle
# reproduction. Two steps:
#   arm1drag seed            seed DG1/DG2/DG3 (frontmost forecast rows) + screenshot
#   arm1drag go <sx> <sy> <ty>   post a drag from (sx,sy) to (sx,ty), screenshot, audit
if [ "$CMD" = "arm1drag" ]; then
  load_session
  SUB="${2:-}"
  if [ "$SUB" = "seed" ]; then
    note "################## DLBNC-1abc — GUI drag byte audit (seed) ##################"
    note "  seed DG1/DG2/DG3 — someday+deadline($DLDAY) forecast rows (will be the MOST-negative = TOP of the $DLDAY block)"
    for t in DG1 DG2 DG3; do gurl "things:///add?title=$t&when=someday&deadline=$DLDAY&list-id=$P"; sleep 1; done
    DG1=$(uuid_of DG1); DG2=$(uuid_of DG2); DG3=$(uuid_of DG3)
    { echo "DG1=$DG1"; echo "DG2=$DG2"; echo "DG3=$DG3"; } >> "$SESSION"
    for v in DG1 DG2 DG3; do eval "u=\$$v"; note "    $v: $(one "$u")"; done
    note "  ascending todayIndex (top of block first): $(tidx_order "'DG1','DG2','DG3'")"
    lab_ssh "$IP" "open 'things:///show?id=upcoming'; sleep 3" </dev/null
    lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to activate"; sleep 3' </dev/null
    lab_ssh "$IP" 'screencapture -x /tmp/dlbnc-drag-before.png 2>/dev/null || true' </dev/null
    lab_scp "$LAB_SSH_USER@$IP:/tmp/dlbnc-drag-before.png" "$OUT/screens/drag-before.png" </dev/null 2>/dev/null || true
    note "  before-screenshot -> $OUT/screens/drag-before.png (read it for DG3/DG2/DG1 row pixel coords, then run: arm1drag go <sx> <sy> <ty>)"
    exit 0
  fi
  if [ "$SUB" = "go" ]; then
    SX="${3:?sx}"; SY="${4:?sy}"; TY="${5:?ty}"
    note "################## DLBNC-1abc — GUI drag byte audit (go: grab $SX,$SY -> drop $SX,$TY) ##################"
    for v in DG1 DG2 DG3; do eval "u=\$$v"; note "    $v before drag: $(one "$u")"; done
    note "    todayIndex BEFORE: $(tidx_order "'DG1','DG2','DG3'")"
    # ship the fixed-coordinate CGEvent drag JXA (no AX reads)
    lab_ssh "$IP" 'cat > /tmp/dlbnc-drag.js' <<'EOF'
ObjC.import('CoreGraphics');
function sleep(ms){ $.NSThread.sleepForTimeInterval(ms/1000) }
var MOVED=5, DOWN=1, UP=2, DRAG=6;
function mev(t,x,y){ var e=$.CGEventCreateMouseEvent($(), t, $.CGPointMake(x,y), 0); $.CGEventSetIntegerValueField(e,1,1); return e }
function post(ev){ $.CGEventPost($.kCGHIDEventTap, ev) }
function run(argv){
  var sx=+argv[0], sy=+argv[1], ty=+argv[2];
  post(mev(MOVED,sx,sy)); sleep(120);
  post(mev(DOWN,sx,sy)); sleep(250);
  post(mev(DRAG,sx,sy-4)); sleep(120);
  for(var s=1;s<=24;s++){ post(mev(DRAG,sx,sy+(ty-sy)*s/24)); sleep(35) }
  post(mev(DRAG,sx,ty)); sleep(400);
  post(mev(UP,sx,ty)); sleep(500);
  return 'DRAG_POSTED';
}
EOF
    note "    drag result: [$(lab_ssh "$IP" "/usr/bin/osascript -l JavaScript /tmp/dlbnc-drag.js $SX $SY $TY 2>&1" </dev/null)]"
    sleep 2
    for v in DG1 DG2 DG3; do eval "u=\$$v"; note "    $v after drag: $(one "$u")"; done
    note "    todayIndex AFTER: $(tidx_order "'DG1','DG2','DG3'")"
    lab_ssh "$IP" 'screencapture -x /tmp/dlbnc-drag-after.png 2>/dev/null || true' </dev/null
    lab_scp "$LAB_SSH_USER@$IP:/tmp/dlbnc-drag-after.png" "$OUT/screens/drag-after.png" </dev/null 2>/dev/null || true
    note "    after-screenshot -> $OUT/screens/drag-after.png"
    note "  VERDICT-1abc: did the drag land (todayIndex order changed)? if yes — todayIndex ONLY (pure re-rank) or startDate/start/tiRef collateral? if zero delta — synthetic events gated (fixed-coord CGEventPost not delivered without Accessibility)."
    exit 0
  fi
  echo "usage: $0 arm1drag seed|go <sx> <sy> <ty>" >&2; exit 1
fi

# ==================================================================== arm5b
# DLBNC-5 (reworked) — the when-cycle on a PROPER fixture: 3 forecast rows with
# distinct ranks on BOTH axes + a BYSTANDER forecast row (WB) in the same day
# block, so front-insertion is observable against WB. Measures BOTH the
# when=<DATE> round-trip (re-tests UPCDL-7 Q2's "preserves both axes" on a
# multi-row fixture) AND the when=today variant, per axis.
if [ "$CMD" = "arm5b" ]; then
  load_session; canary || exit 1
  note "################## DLBNC-5 (reworked) — when-cycle on a proper multi-row fixture + bystander ##################"
  note "  seed W1/W2/W3 (cycled) + WB (BYSTANDER, never touched) — all someday+deadline($DLDAY) in P"
  for t in W1 W2 W3 WB; do gurl "things:///add?title=$t&when=someday&deadline=$DLDAY&list-id=$P"; sleep 1; done
  W1=$(uuid_of W1); W2=$(uuid_of W2); W3=$(uuid_of W3); WB=$(uuid_of WB)
  for v in W1 W2 W3 WB; do eval "u=\$$v"; note "    $v resting: $(one "$u")"; done
  note "  resting todayIndex order: $(tidx_order "'W1','W2','W3','WB'")"
  note "  resting index order:      $(idx_order  "'W1','W2','W3','WB'")"

  note "  --- 5b-DATE: single row W1, when=$OTHERDAY -> when=someday round-trip (re-tests Q2 on a multi-row block; WB is the bystander) ---"
  note "    W1 before:               $(one "$W1")"
  gurl "things:///update?id=$W1&auth-token=$TOKEN&when=$OTHERDAY"
  note "    W1 after when=$OTHERDAY:  $(one "$W1")"
  gurl "things:///update?id=$W1&auth-token=$TOKEN&when=someday"
  note "    W1 after when=someday:   $(one "$W1")"
  note "    WB (bystander) now:      $(one "$WB")"
  note "    VERDICT-5b-DATE: did W1's todayIndex FRONT-INSERT below the untouched WB (=> Q2 is a degenerate single-row artifact, front-insert is the law) or PRESERVE its resting value (=> Q2 holds)? index preserve/front-insert?"

  note "  --- 5b-TODAY: single row W2, when=today -> when=someday round-trip ---"
  note "    W2 before:               $(one "$W2")"
  gurl "things:///update?id=$W2&auth-token=$TOKEN&when=today"
  note "    W2 after when=today:     $(one "$W2")"
  gurl "things:///update?id=$W2&auth-token=$TOKEN&when=someday"
  note "    W2 after when=someday:   $(one "$W2")"
  note "    VERDICT-5b-TODAY: today-leg materializes (start 2->1, startDate->today)? someday-restore front-inserts BOTH axes?"

  note "  --- 5b-order snapshot (W1/W2 cycled, W3/WB untouched) ---"
  note "    todayIndex order: $(tidx_order "'W1','W2','W3','WB'")"
  note "    index order:      $(idx_order  "'W1','W2','W3','WB'")"
  note "  VERDICT-5b: state both vectors' per-axis behavior (preserve / re-derive / front-insert), measured against the WB bystander."
  exit 0
fi

# ==================================================================== arm6
# DLBNC-6 — the COMPOUND protocol (maintainer-proposed): when=-cycle the rows in
# REVERSE target order (front-inserts todayIndex to the exact target block order,
# clobbering index) THEN REPAIR index with ONE `project id` reorder to the
# captured original order (UPCDL-3 clean re-rank). End-to-end proof on a scrambled
# 3-row block + full collateral (R07 reminder, dlSup, umd, undo shape).
if [ "$CMD" = "arm6" ]; then
  load_session; canary && canaryP || exit 1
  note "################## DLBNC-6 — the compound when-cycle + index-repair protocol ##################"
  note "  seed X1/X2/X3 (cycled) + XB (bystander) — someday+deadline($DLDAY) in P"
  for t in X1 X2 X3 XB; do gurl "things:///add?title=$t&when=someday&deadline=$DLDAY&list-id=$P"; sleep 1; done
  X1=$(uuid_of X1); X2=$(uuid_of X2); X3=$(uuid_of X3); XB=$(uuid_of XB)
  for v in X1 X2 X3 XB; do eval "u=\$$v"; note "    $v resting: $(one "$u")"; done
  IDX_BEFORE=$(idx_order "'X1','X2','X3'")
  note "  CAPTURED original someday index order: $IDX_BEFORE"
  note "  resting todayIndex order: $(tidx_order "'X1','X2','X3'")"

  note "  --- R07 reminder audit: seed CR (scheduled today WITH a reminder), run a when=someday leg, does the reminder survive? ---"
  gurl "things:///add?title=CR&when=today@14:00&list-id=$P"; sleep 1; CR=$(uuid_of CR)
  note "    CR before (reminder set): $(one "$CR")"
  gurl "things:///update?id=$CR&auth-token=$TOKEN&when=someday"
  note "    CR after when=someday:    $(one "$CR")"
  note "    VERDICT-R07: did when=someday CLEAR reminderTime? (=> the when= legs are reminder-LOSSY; a forecast fixture row carries none, but a reminder-bearing row would lose it)"

  note "  --- STEP 1: when=-cycle X1/X2/X3 in REVERSE target order to set the block todayIndex order ---"
  note "    TARGET block order (ascending todayIndex) := X2 < X1 < X3.  REVERSE dispatch: X3, X1, X2"
  U_R07=""
  for u in "$X3" "$X1" "$X2"; do
    U0=$(gq "SELECT CAST(userModificationDate AS INT) FROM TMTask WHERE uuid='$u'")
    gurl "things:///update?id=$u&auth-token=$TOKEN&when=$OTHERDAY"
    U1=$(gq "SELECT CAST(userModificationDate AS INT) FROM TMTask WHERE uuid='$u'")
    gurl "things:///update?id=$u&auth-token=$TOKEN&when=someday"
    U2=$(gq "SELECT CAST(userModificationDate AS INT) FROM TMTask WHERE uuid='$u'")
    note "    cycled $(gq "SELECT title FROM TMTask WHERE uuid='$u'"): umd rest=$U0 afterDate=$U1 afterSomeday=$U2 (2 legs/row)"
  done
  for v in X1 X2 X3; do eval "u=\$$v"; note "    $v after step1: $(one "$u")"; done
  note "    todayIndex order after step1: $(tidx_order "'X1','X2','X3'")   (target: X2<X1<X3)"
  note "    index order after step1 (CLOBBERED): $(idx_order "'X1','X2','X3'")"

  note "  --- STEP 2: REPAIR index with ONE project id reorder to the captured order ($IDX_BEFORE) ---"
  # dispatch ids in the captured ASCENDING original index order (X1<X2<X3 by creation, idx ascending)
  ORDER_IDS=$(gq "SELECT group_concat(uuid, ',') FROM (SELECT uuid FROM TMTask WHERE title IN ('X1','X2','X3') AND trashed=0 ORDER BY CASE title WHEN 'X1' THEN 1 WHEN 'X2' THEN 2 WHEN 'X3' THEN 3 END)")
  note "    reorder to dos in project id P with ids <X1,X2,X3> (original order): [$(reord "project id \"$P\"" "$X1,$X2,$X3")]"
  for v in X1 X2 X3; do eval "u=\$$v"; note "    $v after repair: $(one "$u")"; done
  note "    FINAL todayIndex order: $(tidx_order "'X1','X2','X3'")   (target: X2<X1<X3)"
  note "    FINAL index order:      $(idx_order "'X1','X2','X3'")   (original: $IDX_BEFORE)"
  note "  VERDICT-6: final todayIndex == target (X2<X1<X3)? final index ORDER == original ($IDX_BEFORE)? deadline/start/startDate/FKs untouched? (note: repair restores index ORDER, integers differ — contrast the deadline-cycle which keeps integers byte-identical). dlSup/reminder? undo = 2N URL legs + 1 private reorder (non-atomic)."
  exit 0
fi

# ==================================================================== pulldb
if [ "$CMD" = "pulldb" ]; then
  load_session
  LABEL="${2:-snapshot}"; DST="$OUT/db-$LABEL.sqlite"
  RP=$(lab_ssh "$IP" 'echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite' </dev/null)
  lab_scp "$IP:$RP" "$DST"
  note "pulled $(ls -la "$DST" | awk '{print $5}') bytes -> $DST"
  exit 0
fi

# ================================================================= teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: $VM"
  pkill -f "tart run $VM" >/dev/null 2>&1 || true
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  exit 0
fi

echo "usage: $0 setup|caps|arm1obs|arm1drag|arm2|arm3|arm4|arm5|arm5b|arm6|pulldb <label>|teardown" >&2
exit 1
