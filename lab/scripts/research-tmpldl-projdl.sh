#!/bin/bash
# TMPLDL / PROJDL — can the certified deadline-cycle (DLBNC #383/#384) extend to
# the two populations it does not cover: repeating TEMPLATES (ARM 1) and forecast
# PROJECT rows (ARM 2)?  Write-up: docs/lab/tmpldl-projdl-deadline-cycle.md.
#
# Extends DLBNC (docs/lab/dlbnc-deadline-cycle.md), which certified the deadline-
# cycle (URL `deadline=` clear + re-set = a clean, state-preserving todayIndex
# front-insert) for FORECAST TO-DOS ONLY (#384 gates on type=0).
#
#   ARM 1 (TMPLDL, crash-ADJACENT): does URL `update?deadline=` / `update-project?
#     deadline=` on a repeating TEMPLATE crash (§1 schedule-class family), no-op, or
#     accept?  Each probe is ISOLATED and PID-WATCHED (§6 P11e pattern); a process
#     death captures the .ips.  Fixtures are the golden's baked deadline-LESS
#     templates (WITH-offset fixtures need the GUI repeat editor => vncdotool, which
#     is absent on this host; the GUI-offset DB shape is the UI1 reference instead:
#     template `deadline` col = 4001-01-01 sentinel 262213760, rule ts=-N).
#
#   ARM 2 (PROJDL, fully HEADLESS): do someday PROJECT rows (type=1, start=2,
#     startDate NULL, future deadline) carry a distinct todayIndex in the Upcoming
#     day-block, and does the deadline-cycle via `update-project?deadline=` front-
#     insert them cleanly (index/start/startDate/area-FK/tags/star preserved)?
#     Closes #384's forecast-PROJECT exclusion.
#
# ONE disposable offline Tart clone `tmpldl-lab` (pinned clock 2026-07-05 12:00;
# ordering is local — no cloud account). Booted --vnc-experimental only so a future
# residual can screencapture; this campaign is otherwise headless.
#
# Subcommands:
#   research-tmpldl-projdl.sh setup     clone+boot+airgap+clock-pin+warm+read-templates+seed(arm2)+canary
#   research-tmpldl-projdl.sh arm1       TMPLDL — deadline= on repeating templates (PID-watched)
#   research-tmpldl-projdl.sh arm1f      TMPLDL-1f — reschedule-bounce mechanism (GUI-gated; conditional)
#   research-tmpldl-projdl.sh arm2       PROJDL — the deadline-cycle on forecast PROJECT rows
#   research-tmpldl-projdl.sh pulldb <l> copy the guest DB to the host
#   research-tmpldl-projdl.sh teardown   stop + delete the clone
#
# Conventions inherited from research-dlbnc.sh / research-ordfin1.sh:
#   * offline COW clone, guest airgap (delete default route), clock pinned BEFORE
#     Things launches, read-only guest SQLite. Dates SEEDED via URL `deadline=<ISO>`
#     (the app packs the int) — NEVER hand-pack a date integer.
#   * NEVER send URL `when=`/schedule-class to a REPEATING template (§1 CRASH). This
#     campaign sends only `deadline=` to templates — the untested adjacent field.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v1}"
PIN="${PIN:-070512002026}"           # 2026-07-05 12:00 (golden pinnedDate)
TODAY="${TODAY:-2026-07-05}"         # the pinned Today
DLDAY="${DLDAY:-2026-07-08}"         # shared future deadline day (3 days out) -> packs 132805632
OTHERDAY="${OTHERDAY:-2026-07-09}"   # a second deadline day
AA="7Ck4hAXU36jyaBsy2Fkije"          # LAB-AREA-A (seed-manifest)
# Golden baked repeating templates (seed-manifest.json), both DEADLINE-LESS:
TMPL_TODO="W3PZB9e7W6BEtKmEKP4deG"   # LAB-REPEAT-DAILY (repeating to-do template, fixed daily)
TMPL_INST="11NNVsNH9gyTEAiG554nQ"    # its baked spawned instance (pristine deadline-less control)
TMPL_PROJ="759yS6xe6d3a3h2dfVxoMZ"   # LAB-REPEAT-WEEKLY-PROJ (repeating project template, weekly)
SENTINEL="262213760"                 # 4001-01-01 — the GUI "deadlined" template-deadline-column sentinel (UI1)
VM="tmpldl-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/screens"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[tmpldl] $*" | tee -a "$REPORT"; }

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

# FULL byte row for a uuid — every column the campaign cares about, incl. the
# TEMPLATE deadline column + startBucket (PROJSTAR/evening flag).
one() { gq "SELECT title||' type='||type||' tIdx='||todayIndex||' idx='||\"index\"||' start='||start||' sb='||COALESCE(startBucket,'-')||' sd='||COALESCE(startDate,'-')||' tiRef='||COALESCE(todayIndexReferenceDate,'-')||' rem='||COALESCE(reminderTime,'-')||' dl='||COALESCE(deadline,'-')||' dlSup='||COALESCE(deadlineSuppressionDate,'-')||' h='||COALESCE(substr(heading,1,8),'-')||' p='||COALESCE(substr(project,1,8),'-')||' a='||COALESCE(substr(area,1,8),'-')||' cd='||CAST(creationDate AS INT)||' umd='||CAST(COALESCE(userModificationDate,0) AS INT) FROM TMTask WHERE uuid='$1'"; }
# rt1 recurrence state (rule hex + the deadline-ness bytes) for a template.
rt1() { gq "SELECT 'paused='||COALESCE(rt1_instanceCreationPaused,'-')||' next='||COALESCE(rt1_nextInstanceStartDate,'-')||' t2dlOff='||COALESCE(t2_deadlineOffset,'-')||' ruleLen='||COALESCE(length(rt1_recurrenceRule),0)||' ruleHex='||COALESCE(substr(hex(rt1_recurrenceRule),1,80),'-') FROM TMTask WHERE uuid='$1'"; }
tidx_order() { gq "SELECT group_concat(title||':'||todayIndex,' ') FROM (SELECT title,todayIndex FROM TMTask WHERE title IN ($1) AND trashed=0 ORDER BY todayIndex)"; }
idx_order()  { gq "SELECT group_concat(title||':'||\"index\",' ') FROM (SELECT title,\"index\" FROM TMTask WHERE title IN ($1) AND trashed=0 ORDER BY \"index\")"; }

uuid_of() { local t="$1" typ="${2:-}" w u i; w="title='$t' AND trashed=0"; [ -n "$typ" ] && w="$w AND type=$typ"
  for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }

tjson() {
  local url
  url=$(lab_ssh "$IP" "python3 -c 'import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))' $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null)
  lab_ssh "$IP" "open -g $(printf '%q' "$url")" </dev/null; sleep 3
}

# --------- PID watch + crash capture (the §6 P11e / §1 U12 crash-detector shape) -
# pgrep the Things process on the guest; empty => not running.
gpid() { lab_ssh "$IP" 'pgrep -x Things3 || true' </dev/null | tr -d '[:space:]'; }
# ensure Things is up (relaunch after a crash); wait for a live pid.
grelaunch() {
  lab_ssh "$IP" 'open -g -a Things3' </dev/null; local i p
  for i in $(seq 1 10); do p=$(gpid); [ -n "$p" ] && { sleep 4; return 0; }; sleep 2; done
  note "  WARN: Things did not relaunch"; return 1
}
# newest Things .ips crash report filename on the guest (empty if none).
newest_ips() { lab_ssh "$IP" 'ls -t ~/Library/Logs/DiagnosticReports/Things3-*.ips 2>/dev/null | head -1 || true' </dev/null | tr -d '[:space:]'; }
# ISOLATED risky write: $1=label $2=url. Captures pid before/after + any fresh
# .ips, pulls the crash report if the process died, then RELAUNCHES the app.
risky() {
  local label="$1" url="$2" p0 p1 ips0 ips1
  p0=$(gpid); ips0=$(newest_ips)
  note "  [$label] pid-before=$p0"
  note "  [$label] URL: $url"
  lab_ssh "$IP" "open -g $(printf '%q' "$url")" </dev/null
  sleep 4
  p1=$(gpid); ips1=$(newest_ips)
  if [ -z "$p1" ] || { [ -n "$p0" ] && [ "$p1" != "$p0" ]; }; then
    note "  [$label] *** PROCESS DEATH *** pid-after=${p1:-<gone>} (was $p0) — CRASH (§1 family)"
    if [ -n "$ips1" ] && [ "$ips1" != "$ips0" ]; then
      local base; base=$(basename "$ips1")
      lab_scp "$LAB_SSH_USER@$IP:$ips1" "$OUT/screens/$base" </dev/null 2>/dev/null || true
      note "  [$label] .ips captured: $base"
    else
      note "  [$label] no fresh .ips flushed before relaunch (DiagnosticReports lag; process death is the crash signal)"
    fi
    grelaunch
  else
    note "  [$label] alive (pid unchanged $p1) — no crash"
  fi
}

# =============================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "cloning $GOLDEN -> $VM (deadline day $DLDAY, today $TODAY)"
  pkill -f "tart run $VM" >/dev/null 2>&1 || true
  tart stop "$VM" >/dev/null 2>&1 || true
  sleep 3
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM" || { note "clone FAILED"; exit 1; }
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

  note "--- baked template resting bytes (ARM 1 fixtures — BOTH deadline-less) ---"
  note "  TMPL_TODO (LAB-REPEAT-DAILY): $(one "$TMPL_TODO")"
  note "    rt1: $(rt1 "$TMPL_TODO")"
  note "  TMPL_TODO instance (pristine control): $(one "$TMPL_INST")"
  note "  TMPL_PROJ (LAB-REPEAT-WEEKLY-PROJ): $(one "$TMPL_PROJ")"
  note "    rt1: $(rt1 "$TMPL_PROJ")"
  note "  NB: deadline-less templates read dl=NULL; a GUI 'Add deadlines' template reads dl=$SENTINEL (4001-01-01 sentinel, UI1)."

  # ---- ARM 2 fixtures: forecast PROJECT rows + interleaved forecast TO-DOs ----
  note "seed ARM 2: PJ1/PJ2/PJ3 someday PROJECTS with future deadline($DLDAY) in LAB-AREA-A"
  for t in PJ1 PJ2 PJ3; do gurl "things:///add-project?title=$t&when=someday&deadline=$DLDAY&area-id=$AA"; sleep 1; done
  PJ1=$(uuid_of PJ1 1); PJ2=$(uuid_of PJ2 1); PJ3=$(uuid_of PJ3 1)
  note "seed ARM 2: FT1/FT2 forecast TO-DOS (someday+deadline $DLDAY) sharing the block"
  for t in FT1 FT2; do gurl "things:///add?title=$t&when=someday&deadline=$DLDAY&list-id=$AA"; sleep 1; done
  FT1=$(uuid_of FT1 0); FT2=$(uuid_of FT2 0)
  # PT (tagged forecast project) — tag-survival check on the cycle. Tag must pre-exist.
  note "seed ARM 2: PT tagged someday project (tag-survival collateral)"
  gurl "things:///add-project?title=PT&when=someday&deadline=$DLDAY&area-id=$AA&tags=lab-tag-1"; sleep 1
  PT=$(uuid_of PT 1)
  { echo "PJ1=$PJ1"; echo "PJ2=$PJ2"; echo "PJ3=$PJ3"; echo "FT1=$FT1"; echo "FT2=$FT2"; echo "PT=$PT"; } >> "$SESSION"
  note "--- ARM 2 fixture bytes ---"
  for v in PJ1 PJ2 PJ3 FT1 FT2 PT; do eval "u=\$$v"; note "  $v: $(one "$u")"; done
  note "  PT tags: $(gq "SELECT COALESCE(group_concat(t.title),'-') FROM TMTaskTag tt JOIN TMTag t ON t.uuid=tt.tags WHERE tt.tasks='$PT'")"
  note "setup DONE — session in $SESSION"
  exit 0
fi

# =============================================================== arm1
if [ "$CMD" = "arm1" ]; then
  load_session
  note "################## ARM 1 — TMPLDL: deadline= on repeating TEMPLATES (PID-watched) ##################"
  note "  packed reference: DLDAY $DLDAY (a real future date) vs GUI-deadlined sentinel $SENTINEL (4001-01-01)"

  # ---- 1a: URL update?deadline= on the repeating TO-DO template ----
  note "  --- TMPLDL-1a-todo: update?id=<to-do template>&deadline=$DLDAY ---"
  note "    TMPL_TODO before: $(one "$TMPL_TODO")"
  note "    TMPL_TODO rt1 before: $(rt1 "$TMPL_TODO")"
  risky "1a-todo" "things:///update?id=$TMPL_TODO&auth-token=$TOKEN&deadline=$DLDAY"
  note "    TMPL_TODO after:  $(one "$TMPL_TODO")"
  note "    TMPL_TODO rt1 after:  $(rt1 "$TMPL_TODO")"
  note "    VERDICT-1a-todo: crash / no-op / accepted? if accepted: plain dl column (=real DLDAY int) vs recurrence offset (rt1 ts / sentinel)? todayIndex front-insert (0 -> negative)?"

  # ---- 1a: URL update-project?deadline= on the repeating PROJECT template ----
  note "  --- TMPLDL-1a-proj: update-project?id=<project template>&deadline=$DLDAY ---"
  note "    TMPL_PROJ before: $(one "$TMPL_PROJ")"
  note "    TMPL_PROJ rt1 before: $(rt1 "$TMPL_PROJ")"
  risky "1a-proj" "things:///update-project?id=$TMPL_PROJ&auth-token=$TOKEN&deadline=$DLDAY"
  note "    TMPL_PROJ after:  $(one "$TMPL_PROJ")"
  note "    TMPL_PROJ rt1 after:  $(rt1 "$TMPL_PROJ")"
  note "    VERDICT-1a-proj: crash / no-op / accepted? same shape as the to-do template?"

  # ---- 1b: same-value re-set on the to-do template (only meaningful if 1a accepted) ----
  DL_NOW=$(gq "SELECT COALESCE(deadline,'NULL') FROM TMTask WHERE uuid='$TMPL_TODO'")
  if [ "$DL_NOW" != "NULL" ]; then
    note "  --- TMPLDL-1b: same-value RE-SET on TMPL_TODO (deadline already=$DL_NOW) ---"
    note "    TMPL_TODO before re-set: $(one "$TMPL_TODO")"
    risky "1b" "things:///update?id=$TMPL_TODO&auth-token=$TOKEN&deadline=$DLDAY"
    note "    TMPL_TODO after re-set:  $(one "$TMPL_TODO")"
    note "    TMPL_TODO rt1 after re-set: $(rt1 "$TMPL_TODO")"
    note "    VERDICT-1b: does a same-value re-set perturb rt1 bytes / todayIndex / the projection?"
  else
    note "  --- TMPLDL-1b: SKIPPED (1a did not write a deadline — no cycle to re-set) ---"
  fi

  # ---- 1c: deadline CLEAR on the to-do template ----
  note "  --- TMPLDL-1c: deadline CLEAR (empty) on TMPL_TODO ---"
  note "    TMPL_TODO before clear: $(one "$TMPL_TODO")"
  risky "1c" "things:///update?id=$TMPL_TODO&auth-token=$TOKEN&deadline="
  note "    TMPL_TODO after clear:  $(one "$TMPL_TODO")"
  note "    TMPL_TODO rt1 after clear: $(rt1 "$TMPL_TODO")"
  note "    VERDICT-1c: accepted / crash / no-op? does clear restore dl=NULL (deadline-less) or leave residue? rt1 delta?"

  # ---- 1d: instance-contamination check (conditional — only if a clean cycle survived) ----
  note "  --- TMPLDL-1d: spawned-instance contamination check ---"
  note "    pristine baked instance TMPL_INST (control, expect dl=NULL): $(one "$TMPL_INST")"
  note "    (re-set a deadline on the template, then advance the series by completing the current instance, and byte-check the NEXT spawn)"
  risky "1d-reset" "things:///update?id=$TMPL_TODO&auth-token=$TOKEN&deadline=$DLDAY"
  note "    TMPL_TODO after 1d re-set: $(one "$TMPL_TODO")"
  note "    advancing series: complete current instance $TMPL_INST"
  note "    complete result: [$(gas "tell application \"Things3\" to set status of to do id \"$TMPL_INST\" to completed")]"
  sleep 6
  # any NEW instance = an open to-do linked to the template that is not the baked one
  NEWINST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$TMPL_TODO' AND uuid<>'$TMPL_INST' AND trashed=0 ORDER BY creationDate DESC LIMIT 1")
  if [ -n "$NEWINST" ]; then
    note "    NEW spawned instance $NEWINST: $(one "$NEWINST")"
    note "    VERDICT-1d: does the newly spawned instance carry a deadline (=> the cycle CONTAMINATED future instances) or dl=NULL like the pristine control (=> template-only, no instance contamination)?"
  else
    note "    no new instance spawned headless at the pinned clock (spawn is app-tick driven, offline) — instance-contamination check INCONCLUSIVE (flag; the template-row byte delta from 1a stands)"
  fi
  note "  VERDICT-1e: REVIVES the template cell (clean cycle + sortable projection) / DEAD-CONFIRMED (crash or no-op) / ACCEPTED-BUT-SEMANTIC (writes deadline config -> hazard)"
  exit 0
fi

# =============================================================== arm2
if [ "$CMD" = "arm2" ]; then
  load_session
  note "################## ARM 2 — PROJDL: the deadline-cycle on forecast PROJECT rows ##################"

  # ---- 2a: resting axis membership ----
  note "  --- PROJDL-2a: resting axis membership (do forecast PROJECT rows carry a distinct todayIndex?) ---"
  for v in PJ1 PJ2 PJ3 FT1 FT2; do eval "u=\$$v"; note "    $v: $(one "$u")"; done
  note "    todayIndex order (projects+to-dos, ascending): $(tidx_order "'PJ1','PJ2','PJ3','FT1','FT2'")"
  note "    index order      (projects+to-dos, ascending): $(idx_order  "'PJ1','PJ2','PJ3','FT1','FT2'")"
  note "    VERDICT-2a: do PJ rows have NON-ZERO todayIndex (block members, §9o analog for type=1) or todayIndex=0 (off the axis)?"

  # ---- 2b: the deadline-cycle on ONE forecast project (full collateral) ----
  note "  --- PROJDL-2b: deadline-cycle on PJ2 via update-project?deadline= (clear + re-set) ---"
  note "    block context (incumbent todayIndex): $(tidx_order "'PJ1','PJ3','FT1','FT2'")"
  note "    PJ2 before leg:  $(one "$PJ2")"
  gurl "things:///update-project?id=$PJ2&auth-token=$TOKEN&deadline="
  note "    PJ2 after clear: $(one "$PJ2")"
  gurl "things:///update-project?id=$PJ2&auth-token=$TOKEN&deadline=$DLDAY"
  note "    PJ2 after re-set: $(one "$PJ2")"
  note "    VERDICT-2b: front-insert todayIndex at the block min? index/start=2/startDate=NULL/area-FK preserved byte-identical? start NOT flipped to 1 (no accidental star — PROJSTAR)? deadline restored to same int?"
  # PROJSTAR collateral on the tagged project PT (tag + area survival on a cycle)
  note "  --- PROJDL-2b': collateral on PT (tag + area survival on a deadline-cycle) ---"
  note "    PT before: $(one "$PT")  tags: $(gq "SELECT COALESCE(group_concat(t.title),'-') FROM TMTaskTag tt JOIN TMTag t ON t.uuid=tt.tags WHERE tt.tasks='$PT'")"
  gurl "things:///update-project?id=$PT&auth-token=$TOKEN&deadline="
  gurl "things:///update-project?id=$PT&auth-token=$TOKEN&deadline=$DLDAY"
  note "    PT after cycle: $(one "$PT")  tags: $(gq "SELECT COALESCE(group_concat(t.title),'-') FROM TMTaskTag tt JOIN TMTag t ON t.uuid=tt.tags WHERE tt.tasks='$PT'")"
  note "    VERDICT-2b': area FK + tags survive the project deadline-cycle?"

  # ---- 2c: the 3-row protocol proof, mixed project + to-do interleave ----
  note "  --- PROJDL-2c: protocol proof — scramble PJ1/PJ2/PJ3 + interleave FT1 to an exact target block order ---"
  # uniform re-cycle first so all three projects start from a clean identical deadline state
  for u in "$PJ1" "$PJ2" "$PJ3"; do
    gurl "things:///update-project?id=$u&auth-token=$TOKEN&deadline="
    gurl "things:///update-project?id=$u&auth-token=$TOKEN&deadline=$DLDAY"
  done
  note "    todayIndex after uniform re-cycle: $(tidx_order "'PJ1','PJ2','PJ3','FT1'")"
  note "    index BEFORE protocol: $(idx_order "'PJ1','PJ2','PJ3'")"
  note "    TARGET ascending todayIndex := FT1 < PJ3 < PJ1 < PJ2  (mixed to-do+project interleave)"
  note "    REVERSE-target dispatch (front-insert => last-cycled = most-negative = first): PJ2, PJ1, PJ3, FT1"
  gurl "things:///update-project?id=$PJ2&auth-token=$TOKEN&deadline=";  gurl "things:///update-project?id=$PJ2&auth-token=$TOKEN&deadline=$DLDAY"
  gurl "things:///update-project?id=$PJ1&auth-token=$TOKEN&deadline=";  gurl "things:///update-project?id=$PJ1&auth-token=$TOKEN&deadline=$DLDAY"
  gurl "things:///update-project?id=$PJ3&auth-token=$TOKEN&deadline=";  gurl "things:///update-project?id=$PJ3&auth-token=$TOKEN&deadline=$DLDAY"
  # FT1 is a to-do -> the certified to-do deadline-cycle (update?, not update-project?)
  gurl "things:///update?id=$FT1&auth-token=$TOKEN&deadline=";          gurl "things:///update?id=$FT1&auth-token=$TOKEN&deadline=$DLDAY"
  for v in PJ1 PJ2 PJ3 FT1; do eval "u=\$$v"; note "    $v after protocol: $(one "$u")"; done
  note "    FINAL todayIndex order: $(tidx_order "'PJ1','PJ2','PJ3','FT1'")   (target: FT1<PJ3<PJ1<PJ2)"
  note "    index AFTER protocol: $(idx_order "'PJ1','PJ2','PJ3'")   (must be byte-identical to BEFORE)"
  note "  VERDICT-2c: FINAL ascending todayIndex == TARGET AND someday index byte-identical? => the deadline-cycle is a state-preserving block-reorder for forecast PROJECT rows too, mixable with to-dos in one block."
  note "  VERDICT-PROJDL: WIREABLE (#384 type=0 gate can widen in a follow-up) / refused / hazardous."
  exit 0
fi

# =============================================================== arm1f
# TMPLDL-1f — the reschedule-bounce hypothesis (maintainer-directed, CONDITIONAL:
# fires because 1a-1e concluded deadline= cannot cycle a template). Question: when
# a template's next projected occurrence date changes, does its projected row's
# todayIndex get REASSIGNED (front-insert at the destination block min, like the
# deadline-cycle) or does the rank persist; and does D->D+1->D land it at the FRONT
# of D's block (a bounce)? There is NO headless template reschedule (when= CRASHES
# §1; AppleScript `schedule` guards repeating rows 302), so the mechanism can only
# be driven via the GUI (Items > Repeat > Reschedule / the When picker) — which
# needs Accessibility (System Events UI-scripting) or synthetic HID. This host has
# NO vncdotool and the golden does NOT grant Accessibility, so this arm FIRST
# probes the input-driving capability empirically; it drives the mechanism only if
# a coarse path works, else flags blocked-by-VM-input-gating with evidence.
if [ "$CMD" = "arm1f" ]; then
  load_session
  note "################## TMPLDL-1f — reschedule-bounce hypothesis (mechanism; GUI-gated) ##################"

  note "  --- 1f-projection: is the template's Upcoming projection a REAL row or display-only? ---"
  note "    TMPL_TODO row: $(one "$TMPL_TODO")"
  note "    TMPL_TODO rt1: $(rt1 "$TMPL_TODO")"
  NEXT=$(gq "SELECT COALESCE(rt1_nextInstanceStartDate,'-') FROM TMTask WHERE uuid='$TMPL_TODO'")
  note "    next projected occurrence (rt1_nextInstanceStartDate) = $NEXT"
  # count REAL TMTask rows dated on the projection day (excluding the template row)
  ROWSON=$(gq "SELECT COUNT(*) FROM TMTask WHERE startDate=$NEXT AND uuid<>'$TMPL_TODO' AND trashed=0")
  note "    REAL TMTask rows with startDate=$NEXT (excl. template): $ROWSON  (ordfin1: the daily projection is DISPLAY-ONLY, no row => nothing to byte-audit for the projection's todayIndex)"

  note "  --- 1f-headless-levers (control: confirm no headless reschedule exists) ---"
  note "    AppleScript schedule on the template (expect 302 guard): [$(gas "tell application \"Things3\" to schedule to do id \"$TMPL_TODO\" for ((current date) + 1 * days)")]"
  note "    (URL when= is NOT attempted — §1 CRASH, hard rule)"

  note "  --- 1f-input-gating: can System Events DRIVE the GUI without an Accessibility grant? ---"
  lab_ssh "$IP" 'open -g -a Things3; sleep 3' </dev/null
  note "    TCC Accessibility rows (system): $(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT client||'\''=>'\''||auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''" 2>&1 | tr "\n" " " || echo none' </dev/null)"
  note "    SysEvents count windows (expect -1719 if AX denied): [$(gas "tell application \"System Events\" to tell process \"Things3\" to count windows")]"
  note "    SysEvents menu read (expect -1719): [$(gas "tell application \"System Events\" to tell process \"Things3\" to get name of every menu of menu bar 1" | head -c 120)]"
  note "    SysEvents keystroke test (expect -1719): [$(gas "tell application \"System Events\" to keystroke \"x\"")]"

  note "  --- 1f-verdict ---"
  note "    If every System Events call returned -1719 AND vncdotool is absent AND no Accessibility grant, the GUI reschedule flow is UNREACHABLE headlessly on this host."
  note "    Synthetic HID (CGEventPost) is independently gated on this host (DLBNC-1abc: osascript -25211 assistive-access denied, no vncdotool) — so the coarse HID path is closed too."
  note "    => TMPLDL-1f mechanism = BLOCKED-BY-VM-INPUT-GATING (no vncdotool -> no AXVM1 grant -> System Events denied; synthetic HID gated). Recorded as a VNC/AX-grant residual, NOT guessed."
  lab_ssh "$IP" "open 'things:///show?id=upcoming'; sleep 3" </dev/null
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to activate"; sleep 2' </dev/null
  lab_ssh "$IP" 'screencapture -x /tmp/1f-upcoming.png 2>/dev/null || true' </dev/null
  lab_scp "$LAB_SSH_USER@$IP:/tmp/1f-upcoming.png" "$OUT/screens/1f-upcoming.png" </dev/null 2>/dev/null || true
  note "    Upcoming screenshot (projection visible, display-only) -> $OUT/screens/1f-upcoming.png"
  exit 0
fi

# =============================================================== pulldb
if [ "$CMD" = "pulldb" ]; then
  load_session
  LABEL="${2:-snapshot}"; DST="$OUT/db-$LABEL.sqlite"
  RP=$(lab_ssh "$IP" 'echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite' </dev/null)
  lab_scp "$IP:$RP" "$DST"
  note "pulled $(ls -la "$DST" | awk '{print $5}') bytes -> $DST"
  exit 0
fi

# =============================================================== teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: $VM"
  pkill -f "tart run $VM" >/dev/null 2>&1 || true
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  exit 0
fi

echo "usage: $0 setup|arm1|arm1f|arm2|pulldb <label>|teardown" >&2
exit 1
