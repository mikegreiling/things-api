#!/bin/bash
# TMPLSORT — prove (or refute) the FULL template-sorting protocol that TDRAG-3's
# single-template front-insert primitive makes plausible. Golden-v2 / Things
# 3.22.12. Write-up: docs/lab/tmplsort-template-protocol.md.
#
# TDRAG-3 (#390) proved `_private_experimental_ reorder to dos in list "Upcoming"
# with ids {<template>}` cleanly FRONT-INSERTS one template's todayIndex (byte-
# clean; a MIXED wire is a no-op; the `project id` specifier REPARENTS). This
# campaign asks: does a REVERSE-target dispatch of one front-insert per row land
# an exact block order (like the deadline-cycle), for a pure-template block AND a
# scheduled+forecast+template MIXED block; and it maps the safety boundaries a
# future wiring must guard.
#
# Arms:
#   TMPLSORT-1  templates-only protocol proof (3+ templates in ONE day block,
#               reverse-target single-id Upcoming front-insert -> exact order;
#               per-leg byte audit; instance-contamination check). Repeat for a
#               repeating PROJECT template (single front-insert cleanliness).
#   TMPLSORT-2  mixed-block interleave: scheduled (when= bounce) + forecast
#               (deadline-cycle) + template (Upcoming front-insert) in ONE global
#               reverse-target dispatch -> do the three families share a min-space?
#   TMPLSORT-3  safety boundaries: (a) mixed-wire no-op is harmless (no partial
#               writes); (b) project-id reparent hazard byte-shape + RESTORE;
#               (c) template id in list "Today"/"Tomorrow" wires — blind-writer
#               collateral on the OTHER ids, or template-specific? (crash-watched)
#
# Templates cannot be created headlessly (URL/AS/Shortcuts all dead — only
# File>New Repeating To-Do via VNC works, UI1). arm1-seed VNC-creates the extra
# daily to-do templates for the block. GUI input is synthesized via vncdotool
# ($VNCDO) against the --vnc-experimental framebuffer (2048x1536), single-client.
#
# Requires $VNCDO (vncdotool venv, lives in the PRIMARY checkout, gitignored):
#   VNCDO=/Volumes/Workspace/Projects/things-api/lab/vncvenv/bin/vncdo
#
# Conventions (inherited from research-tdrag.sh / research-ui1.sh): offline COW
# clone, guest airgap, clock pinned BEFORE Things launches, read-only guest
# SQLite, dates SEEDED via URL when=/deadline= (app packs the int). NEVER send
# URL when= to a repeating template (§1 CRASH). Reorder wires are PID-watched
# (templates are crash-adjacent). NEVER the host DB; teardown verified.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v2}"
PIN="${PIN:-070512002026}"           # 2026-07-05 12:00 (golden pinnedDate)
TODAY="${TODAY:-2026-07-05}"         # the pinned Today
TMRW="${TMRW:-2026-07-06}"           # daily templates project here (rt1_next=132805376)
DAY2="${DAY2:-2026-07-07}"           # when=/deadline= staging neighbour (bounce/cycle)
DAY3="${DAY3:-2026-07-08}"           # a spare future day
AA="7Ck4hAXU36jyaBsy2Fkije"          # LAB-AREA-A
PROJ="933TCvzMgM3MLvpKPcjheC"        # LAB-PROJ-PLAIN (in LAB-AREA-A)
TMPL_TODO="W3PZB9e7W6BEtKmEKP4deG"   # LAB-REPEAT-DAILY (repeating to-do template, daily)
TMPL_INST="11NNVsNH9gyTEAiG554nQ"    # its baked spawned instance
TMPL_PROJ="759yS6xe6d3a3h2dfVxoMZ"   # LAB-REPEAT-WEEKLY-PROJ (repeating project template)
VM="tmplsort-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/screens"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[tmplsort] $*" | tee -a "$REPORT"; }

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

# FULL byte row for a uuid — every column the campaign cares about.
one() { gq "SELECT title||' type='||type||' tIdx='||todayIndex||' idx='||\"index\"||' start='||start||' sb='||COALESCE(startBucket,'-')||' sd='||COALESCE(startDate,'-')||' tiRef='||COALESCE(todayIndexReferenceDate,'-')||' rem='||COALESCE(reminderTime,'-')||' dl='||COALESCE(deadline,'-')||' h='||COALESCE(substr(heading,1,8),'-')||' p='||COALESCE(substr(project,1,8),'-')||' a='||COALESCE(substr(area,1,8),'-')||' cd='||CAST(creationDate AS INT)||' umd='||CAST(COALESCE(userModificationDate,0) AS INT) FROM TMTask WHERE uuid='$1'"; }
# rt1 recurrence state (rule hex + pause/next) for a template.
rt1() { gq "SELECT 'paused='||COALESCE(rt1_instanceCreationPaused,'-')||' next='||COALESCE(rt1_nextInstanceStartDate,'-')||' ruleLen='||COALESCE(length(rt1_recurrenceRule),0)||' ruleHex='||COALESCE(substr(hex(rt1_recurrenceRule),1,80),'-') FROM TMTask WHERE uuid='$1'"; }
tidx_order() { gq "SELECT group_concat(title||':'||todayIndex,' ') FROM (SELECT title,todayIndex FROM TMTask WHERE title IN ($1) AND trashed=0 ORDER BY todayIndex)"; }
# uuid-based order (avoids title collision with repeating-template INSTANCES)
torder() { gq "SELECT group_concat(title||':'||todayIndex,' ') FROM (SELECT title,todayIndex FROM TMTask WHERE uuid IN ($1) AND trashed=0 ORDER BY todayIndex, uuid)"; }
tidx_of() { gq "SELECT todayIndex FROM TMTask WHERE uuid='$1'"; }
proj_of() { gq "SELECT COALESCE(substr(project,1,8),'NULL') FROM TMTask WHERE uuid='$1'"; }

uuid_of() { local t="$1" typ="${2:-}" w u i; w="title='$t' AND trashed=0"; [ -n "$typ" ] && w="$w AND type=$typ"
  for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }
# newest template row (rt1_recurrenceRule NOT NULL) with this title
tmpl_uuid_of() { local t="$1" u i; for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE title='$t' AND trashed=0 AND rt1_recurrenceRule IS NOT NULL ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }

# ---------- full normalized DB dump (collateral / write-set diff) ----------
snapshot_to() {
  local dst="$1"
  gq "SELECT uuid||'|t='||type||'|ti='||todayIndex||'|ix='||\"index\"||'|st='||start||'|sb='||COALESCE(startBucket,'')||'|sd='||COALESCE(startDate,'')||'|tir='||COALESCE(todayIndexReferenceDate,'')||'|rem='||COALESCE(reminderTime,'')||'|dl='||COALESCE(deadline,'')||'|h='||COALESCE(heading,'')||'|p='||COALESCE(project,'')||'|a='||COALESCE(area,'')||'|tr='||trashed||'|status='||status||'|umd='||CAST(COALESCE(userModificationDate,0) AS INT)||'|rtp='||COALESCE(rt1_instanceCreationPaused,'')||'|rtn='||COALESCE(rt1_nextInstanceStartDate,'')||'|rtl='||COALESCE(length(rt1_recurrenceRule),0) FROM TMTask WHERE trashed=0 ORDER BY uuid" > "$dst"
  {
    echo "=== counts ==="
    for T in TMTask TMArea TMTag TMTaskTag TMChecklistItem; do
      echo "$T=$(gq "SELECT COUNT(*) FROM $T")"
    done
  } >> "$dst"
}

# --------------------------------------------------------------- VNC helpers
vnc_init() {
  [ -n "${VNC_URL:-}" ] || { note "VNC_URL missing — re-run setup"; return 1; }
  [ -n "${VNCDO:-}" ] || VNCDO="lab/vncvenv/bin/vncdo"
  [ -x "$VNCDO" ] || { note "VNCDO not executable ($VNCDO) — pass VNCDO=/abs/path/to/vncdo"; return 1; }
  local hp; hp="${VNC_URL#vnc://}"; hp="${hp##*@}"
  VSERVER="${hp%%:*}::${hp##*:}"
  VPASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
}
V() { sleep 1; timeout 60 "$VNCDO" -s "$VSERVER" ${VPASS:+-p "$VPASS"} "$@" 2>>"$OUT/vnc.log"; }
click() { V move "$1" "$2" click 1; sleep "${3:-1}"; }
front() { lab_ssh "$IP" "open 'things:///show?id=$1'; sleep 2; osascript -e 'tell application \"Things3\" to activate'; sleep 3" </dev/null; }

# UI1 repeat-create coordinates (2048x1536 golden framebuffer), env-overridable.
FILE_MENU="${FILE_MENU:-255 22}";       NEW_REPEATING="${NEW_REPEATING:-369 127}"
REPEAT_DD="${REPEAT_DD:-808 556}";      OPT_DAILY="${OPT_DAILY:-698 623}"
OK_TALL="${OK_TALL:-1432 947}";         BANNER_OK="${BANNER_OK:-1799 325}"

# --------- PID watch (§1/§6 detector shape) ----------
gpid() { lab_ssh "$IP" 'pgrep -x Things3 || true' </dev/null | tr -d '[:space:]'; }
grelaunch() { lab_ssh "$IP" 'open -g -a Things3' </dev/null; local i p; for i in $(seq 1 10); do p=$(gpid); [ -n "$p" ] && { sleep 4; return 0; }; sleep 2; done; note "  WARN: Things did not relaunch"; return 1; }
newest_ips() { lab_ssh "$IP" 'ls -t ~/Library/Logs/DiagnosticReports/Things3-*.ips 2>/dev/null | head -1 || true' </dev/null | tr -d '[:space:]'; }

# reorder_wire <label> <specifier> <comma-ids> — PID-watched private reorder.
# <comma-ids> is a BARE comma-joined uuid string (e.g. "$u" or "$a,$b,$c"); the
# helper wraps it in the ONE quoted-TEXT form the shipped op emits
# (`with ids "id1,id2,id3"`, src/write/commands.ts). NEVER an AppleScript LIST
# literal `{"id1","id2"}` — a multi-item list coerces to text by CONCATENATION
# (TID=""), so `{"a","b"} as text` = "ab", one non-existent id → silent no-op;
# the app never receives a valid multi-id wire (the TMPLSORT-2 syntax artifact,
# see docs/lab/tmplsort-template-protocol.md § the coercion law).
reorder_wire() {
  local label="$1" spec="$2" ids="$3" p0 p1
  p0=$(gpid)
  note "  [$label] wire: reorder to dos in $spec with ids \"$ids\"  (pid-before=$p0)"
  gas "tell application \"Things3\" to _private_experimental_ reorder to dos in $spec with ids \"$ids\"" | sed 's/^/      AS: /' | tee -a "$REPORT" >/dev/null
  sleep 3
  p1=$(gpid)
  if [ -z "$p1" ] || { [ -n "$p0" ] && [ "$p1" != "$p0" ]; }; then
    note "  [$label] *** PROCESS DEATH *** pid-after=${p1:-<gone>} (was $p0) — CRASH (§1/§6 family)"
    grelaunch
    return 1
  fi
  note "  [$label] alive (pid $p1) — no crash"
  return 0
}

# =============================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "cloning $GOLDEN -> $VM (today $TODAY, tmpl-projection $TMRW)"
  pkill -f "tart run $VM" >/dev/null 2>&1 || true
  tart stop "$VM" >/dev/null 2>&1 || true
  sleep 3
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM" || { note "clone FAILED"; exit 1; }
  (tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
  note "ssh up at $IP"
  sleep 3
  VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
  note "VNC_URL=${VNC_URL:-<none captured>}"
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

  note "--- baked template resting bytes ---"
  note "  TMPL_TODO (LAB-REPEAT-DAILY): $(one "$TMPL_TODO")"
  note "    rt1: $(rt1 "$TMPL_TODO")"
  note "  TMPL_PROJ (LAB-REPEAT-WEEKLY-PROJ): $(one "$TMPL_PROJ")"
  note "    rt1: $(rt1 "$TMPL_PROJ")"
  note "  daily-template next projection (rt1_next) = $(gq "SELECT rt1_nextInstanceStartDate FROM TMTask WHERE uuid='$TMPL_TODO'") (07-06=132805376)"
  note "  proj-template next projection (rt1_next)  = $(gq "SELECT rt1_nextInstanceStartDate FROM TMTask WHERE uuid='$TMPL_PROJ'")"
  note "setup DONE — session in $SESSION"
  exit 0
fi

# =============================================================== caps
if [ "$CMD" = "caps" ]; then
  load_session; vnc_init || exit 1
  note "################## CAPS — VNC capture + AX smoke ##################"
  note "  AX menu read: [$(gas "tell application \"System Events\" to tell process \"Things3\" to get name of every menu of menu bar 1" | head -c 120)]"
  front "upcoming"
  V capture "$OUT/screens/caps-upcoming.png" && note "  VNC capture OK -> screens/caps-upcoming.png ($(ls -la "$OUT/screens/caps-upcoming.png" 2>/dev/null | awk '{print $5}') bytes)" || note "  VNC capture FAILED"
  exit 0
fi

# =============================================================== mktmpl (VNC repeat-create)
# mktmpl <title> — create a FIXED daily deadline-less repeating TO-DO template
# (UI1 recipe). Captures each step so coordinates can be verified on golden-v2.
if [ "$CMD" = "mktmpl" ]; then
  load_session; vnc_init || exit 1
  TITLE="$2"
  note "  --- mktmpl '$TITLE' (fixed daily deadline-less) ---"
  lab_ssh "$IP" 'open -g -a Things3; sleep 2; osascript -e "tell application \"Things3\" to activate"; sleep 2' </dev/null
  note "  dismiss the 'N new to-dos' banner (best-effort)"
  click $BANNER_OK 1
  click $FILE_MENU 1; V capture "$OUT/screens/mk-filemenu.png"
  click $NEW_REPEATING 2; V capture "$OUT/screens/mk-dialog.png"
  click $REPEAT_DD 1; V capture "$OUT/screens/mk-freqdd.png"
  click $OPT_DAILY 1
  click $OK_TALL 2; V capture "$OUT/screens/mk-created.png"
  # A brand-new blank-title to-do is DISCARDED on Escape, so type an inline marker
  # first (VNC lowercases it — novel-paths #22), THEN esc keeps the row; rename by
  # uuid via AppleScript afterwards (novel-paths #2 — robust).
  MARK="tsmark$(date +%s)"
  V type "$MARK"; sleep 1
  V key esc; sleep 2
  U=$(gq "SELECT uuid FROM TMTask WHERE title='$MARK' AND trashed=0 AND rt1_recurrenceRule IS NOT NULL ORDER BY creationDate DESC LIMIT 1")
  if [ -z "$U" ]; then
    note "  *** '$TITLE' NOT created (no 'New To-Do' rt1 row) — check screens/mk-*.png, adjust coords ***"
    exit 0
  fi
  note "  created template $U (title 'New To-Do') — renaming to '$TITLE' via AppleScript"
  gas "tell application \"Things3\" to set name of to do id \"$U\" to \"$TITLE\"" | sed 's/^/    AS: /' | tee -a "$REPORT" >/dev/null
  sleep 2
  if [ "$(gq "SELECT title FROM TMTask WHERE uuid='$U'")" = "$TITLE" ]; then
    note "  CREATED $TITLE = $U"
    note "    $(one "$U")"
    note "    rt1: $(rt1 "$U")"
    echo "TMPL_${TITLE//-/_}=$U" >> "$SESSION"
  else
    note "  *** rename FAILED (title still $(gq "SELECT title FROM TMTask WHERE uuid='$U'")) ***"
  fi
  exit 0
fi

# =============================================================== capview (front a view, optional scroll, capture)
# capview <show-id> <label> [pgdn-count]
if [ "$CMD" = "capview" ]; then
  load_session; vnc_init || exit 1
  ID="$2"; LBL="$3"; N="${4:-0}"
  front "$ID"
  V move 1200 800
  for i in $(seq 1 "$N"); do V key pgdn; sleep 0.5; done
  V capture "$OUT/screens/$LBL.png" && note "  captured screens/$LBL.png" || note "  capture FAILED"
  exit 0
fi

# =============================================================== q (ad-hoc SQL)
if [ "$CMD" = "q" ]; then
  load_session; gq "$2"; exit 0
fi

# =============================================================== claim (rename an untitled template)
# claim <title> — rename the newest 'New To-Do' rt1 template row to <title>
# (AppleScript by uuid). For adopting a template created by a prior mktmpl whose
# inline-title-type failed.
if [ "$CMD" = "claim" ]; then
  load_session; TITLE="$2"
  # newest rt1 template that is NOT one of the two baked ones (and not already claimed)
  U=$(gq "SELECT uuid FROM TMTask WHERE trashed=0 AND rt1_recurrenceRule IS NOT NULL AND uuid NOT IN ('$TMPL_TODO','$TMPL_PROJ') AND title GLOB '[a-z]*' ORDER BY creationDate DESC LIMIT 1")
  [ -z "$U" ] && { note "  no unclaimed template found"; exit 1; }
  note "  claiming $U -> '$TITLE'"
  gas "tell application \"Things3\" to set name of to do id \"$U\" to \"$TITLE\"" | sed 's/^/    AS: /' | tee -a "$REPORT" >/dev/null
  sleep 2
  note "  $(one "$U")"
  echo "TMPL_${TITLE//-/_}=$U" >> "$SESSION"
  exit 0
fi

# =============================================================== arm1-seed
# Report the 07-06 block after the extra daily templates (TS-A, TS-B) exist.
if [ "$CMD" = "arm1-seed" ]; then
  load_session
  note "################## TMPLSORT-1 seed — extra daily templates ##################"
  note "  (run: mktmpl TS-A ; mktmpl TS-B — VNC — then this arm reports the block)"
  TA=$(tmpl_uuid_of TS-A || true); TB=$(tmpl_uuid_of TS-B || true)
  note "  TS-A=$TA  TS-B=$TB  LAB-REPEAT-DAILY=$TMPL_TODO"
  note "  TS-A: $(one "$TA")"
  note "  TS-B: $(one "$TB")"
  note "  LAB-REPEAT-DAILY: $(one "$TMPL_TODO")"
  note "  next-projection days: TS-A=$(gq "SELECT rt1_nextInstanceStartDate FROM TMTask WHERE uuid='$TA'") TS-B=$(gq "SELECT rt1_nextInstanceStartDate FROM TMTask WHERE uuid='$TB'") DAILY=$(gq "SELECT rt1_nextInstanceStartDate FROM TMTask WHERE uuid='$TMPL_TODO'")"
  note "  block todayIndex order (ascending): $(tidx_order "'TS-A','TS-B','LAB-REPEAT-DAILY'")"
  exit 0
fi

# =============================================================== arm1 (templates-only protocol)
if [ "$CMD" = "arm1" ]; then
  load_session
  note "################## TMPLSORT-1 — templates-only protocol proof ##################"
  TA=$(tmpl_uuid_of TS-A); TB=$(tmpl_uuid_of TS-B); TD="$TMPL_TODO"
  UIDS="'$TA','$TB','$TD'"
  note "  templates: TS-A=$TA TS-B=$TB DAILY=$TD"
  note "  resting block: $(torder "$UIDS")"
  # TARGET ascending todayIndex order: TS-B < LAB-REPEAT-DAILY < TS-A
  # Front-insert => last-dispatched = most-negative = first. Dispatch REVERSE:
  #   TS-A (goes to min), DAILY (below TS-A), TS-B (below DAILY) => TS-B<DAILY<TS-A.
  note "  TARGET ascending todayIndex: TS-B < LAB-REPEAT-DAILY < TS-A"
  note "  reverse-target dispatch order: TS-A, LAB-REPEAT-DAILY, TS-B"
  snapshot_to "$OUT/snap-arm1-before.txt"
  for leg in "TS-A:$TA" "DAILY:$TD" "TS-B:$TB"; do
    lbl="${leg%%:*}"; u="${leg##*:}"
    note "  == leg $lbl ($u) =="
    note "     before: $(one "$u")"
    note "     before rt1: $(rt1 "$u")"
    reorder_wire "leg-$lbl" 'list "Upcoming"' "$u"
    note "     after:  $(one "$u")"
    note "     after rt1: $(rt1 "$u")"
    note "     block now: $(torder "$UIDS")"
  done
  snapshot_to "$OUT/snap-arm1-after.txt"
  note "  --- FINAL block todayIndex order: $(torder "$UIDS") ---"
  note "  VERDICT-TMPLSORT1: final order == TARGET (TS-B<DAILY<TS-A)? each leg wrote todayIndex ONLY (rt1/start/startDate/tiRef/index/umd/project byte-identical)? => templates-only protocol PROVEN."
  note "  (host: diff snap-arm1-before.txt snap-arm1-after.txt — expect ONLY the 3 template todayIndex bytes changed)"
  exit 0
fi

# =============================================================== arm1-contam
if [ "$CMD" = "arm1-contam" ]; then
  load_session
  note "################## TMPLSORT-1 — instance contamination check ##################"
  note "  baked instance $TMPL_INST: $(one "$TMPL_INST")"
  note "  LAB-REPEAT-DAILY (mutated tIdx): $(one "$TMPL_TODO")"
  note "  complete the current instance to advance the daily series"
  note "  complete: [$(gas "tell application \"Things3\" to set status of to do id \"$TMPL_INST\" to completed")]"
  sleep 8
  NEW=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$TMPL_TODO' AND uuid<>'$TMPL_INST' AND trashed=0 ORDER BY creationDate DESC LIMIT 1")
  if [ -n "$NEW" ]; then
    note "  NEW spawned instance $NEW: $(one "$NEW")"
    note "  VERDICT-CONTAM: new instance tIdx=0 (clean spawn, template todayIndex write did NOT contaminate)?"
  else
    note "  no new instance spawned headless (offline, app-tick driven) — INCONCLUSIVE (flag)"
  fi
  exit 0
fi

# =============================================================== arm1-proj (project template)
if [ "$CMD" = "arm1-proj" ]; then
  load_session
  note "################## TMPLSORT-1 — project-template single front-insert ##################"
  note "  TMPL_PROJ (LAB-REPEAT-WEEKLY-PROJ) before: $(one "$TMPL_PROJ")"
  note "  TMPL_PROJ rt1 before: $(rt1 "$TMPL_PROJ")"
  note "  next projection (rt1_next): $(gq "SELECT rt1_nextInstanceStartDate FROM TMTask WHERE uuid='$TMPL_PROJ'")"
  snapshot_to "$OUT/snap-arm1proj-before.txt"
  reorder_wire "proj-tmpl-upcoming" 'list "Upcoming"' "$TMPL_PROJ"
  snapshot_to "$OUT/snap-arm1proj-after.txt"
  note "  TMPL_PROJ after: $(one "$TMPL_PROJ")"
  note "  TMPL_PROJ rt1 after: $(rt1 "$TMPL_PROJ")"
  note "  VERDICT-TMPLSORT1-PROJ: single-id Upcoming reorder writes the PROJECT template's todayIndex cleanly (rt1/start/startDate/tiRef/index/umd/area byte-identical, no reparent, no crash)? => project-template front-insert certified (extends TDRAG-3 to type=1)."
  note "  (host: diff snap-arm1proj-before.txt snap-arm1proj-after.txt)"
  exit 0
fi

# =============================================================== arm1-proj2 (project template WITH co-resident block rows)
# The bare arm1-proj no-oped: the project template is ALONE in its 07-12 block,
# so front-inserting the only member is idempotent. Seed scheduled rows into the
# SAME block (when=DAY12) so the front-insert has somewhere to land.
if [ "$CMD" = "arm1-proj2" ]; then
  load_session
  DAY12="${DAY12:-2026-07-12}"
  note "################## TMPLSORT-1 — project-template front-insert (co-resident block) ##################"
  note "  seeding PJ1/PJ2 scheduled to-dos on $DAY12 (the project template's block)"
  for t in PJ1 PJ2; do gurl "things:///add?title=$t&when=$DAY12"; sleep 1; done
  PJ1=$(uuid_of PJ1 0); PJ2=$(uuid_of PJ2 0)
  UIDS="'$TMPL_PROJ','$PJ1','$PJ2'"
  note "  PJ1=$PJ1 PJ2=$PJ2 TMPL_PROJ=$TMPL_PROJ"
  note "  resting block ($DAY12): $(torder "$UIDS")"
  note "  TMPL_PROJ before: $(one "$TMPL_PROJ")"
  snapshot_to "$OUT/snap-arm1proj2-before.txt"
  reorder_wire "proj-tmpl-upcoming2" 'list "Upcoming"' "$TMPL_PROJ"
  snapshot_to "$OUT/snap-arm1proj2-after.txt"
  note "  TMPL_PROJ after: $(one "$TMPL_PROJ")"
  note "  TMPL_PROJ rt1 after: $(rt1 "$TMPL_PROJ")"
  note "  block now: $(torder "$UIDS")"
  note "  VERDICT: project template todayIndex front-inserts below the block min, cleanly (rt1/start/startDate/tiRef/index/umd/area byte-identical)? => type=1 front-insert certified."
  exit 0
fi

# =============================================================== arm2 (mixed interleave)
if [ "$CMD" = "arm2" ]; then
  load_session
  note "################## TMPLSORT-2 — mixed-block interleave ##################"
  note "  seeding scheduled SCH1/SCH2 (when=$TMRW) + forecast FC1/FC2 (someday+deadline=$TMRW)"
  for t in SCH1 SCH2; do gurl "things:///add?title=$t&when=$TMRW"; sleep 1; done
  for t in FC1 FC2; do gurl "things:///add?title=$t&when=someday&deadline=$TMRW&list-id=$AA"; sleep 1; done
  SCH1=$(uuid_of SCH1 0); SCH2=$(uuid_of SCH2 0); FC1=$(uuid_of FC1 0); FC2=$(uuid_of FC2 0)
  TA=$(tmpl_uuid_of TS-A); TB=$(tmpl_uuid_of TS-B)
  note "  SCH1=$SCH1 SCH2=$SCH2 FC1=$FC1 FC2=$FC2 TS-A=$TA TS-B=$TB DAILY=$TMPL_TODO"
  note "  SCH1: $(one "$SCH1")"
  note "  FC1:  $(one "$FC1")"
  NAMES="'SCH1','SCH2','FC1','FC2','TS-A','TS-B','LAB-REPEAT-DAILY'"
  note "  resting block ($TMRW) todayIndex order: $(tidx_order "$NAMES")"
  # TARGET ascending todayIndex interleave (first->last in the block):
  #   FC1 < SCH1 < TS-A < FC2 < SCH2 < TS-B < LAB-REPEAT-DAILY
  note "  TARGET ascending: FC1 < SCH1 < TS-A < FC2 < SCH2 < TS-B < LAB-REPEAT-DAILY"
  note "  reverse dispatch: DAILY(tmpl) TS-B(tmpl) SCH2(when) FC2(dl) TS-A(tmpl) SCH1(when) FC1(dl)"
  snapshot_to "$OUT/snap-arm2-before.txt"
  tmpl_leg() { reorder_wire "mix-$1" 'list "Upcoming"' "$2"; note "     $1 after: $(one "$2")"; }
  sched_leg() { note "  == when-bounce $1 ($2) =="; gurl "things:///update?id=$2&auth-token=$TOKEN&when=$DAY2"; gurl "things:///update?id=$2&auth-token=$TOKEN&when=$TMRW"; note "     $1 after: $(one "$2")"; }
  fc_leg() { note "  == deadline-cycle $1 ($2) =="; gurl "things:///update?id=$2&auth-token=$TOKEN&deadline="; gurl "things:///update?id=$2&auth-token=$TOKEN&deadline=$TMRW"; note "     $1 after: $(one "$2")"; }
  tmpl_leg DAILY "$TMPL_TODO"
  tmpl_leg TS-B "$TB"
  sched_leg SCH2 "$SCH2"
  fc_leg FC2 "$FC2"
  tmpl_leg TS-A "$TA"
  sched_leg SCH1 "$SCH1"
  fc_leg FC1 "$FC1"
  snapshot_to "$OUT/snap-arm2-after.txt"
  note "  --- FINAL block todayIndex order: $(tidx_order "$NAMES") ---"
  note "  VERDICT-TMPLSORT2: final == TARGET interleave? => the 3 front-insert families SHARE ONE min-space (universal day-block protocol). If not, characterize divergence + try per-family phased composition."
  exit 0
fi

# =============================================================== arm3a (mixed-wire no-op harmless)
if [ "$CMD" = "arm3a" ]; then
  load_session
  note "################## TMPLSORT-3a — mixed-wire no-op harmlessness ##################"
  SCH1=$(uuid_of SCH1 0 || true); SCH2=$(uuid_of SCH2 0 || true)
  [ -z "$SCH1" ] && { for t in SCH1 SCH2; do gurl "things:///add?title=$t&when=$TMRW"; sleep 1; done; SCH1=$(uuid_of SCH1 0); SCH2=$(uuid_of SCH2 0); }
  TA=$(tmpl_uuid_of TS-A)
  note "  mixed wire: {SCH1, TS-A(template), SCH2} in list \"Upcoming\""
  note "  SCH1 before: $(one "$SCH1")"
  note "  TS-A before: $(one "$TA")"
  note "  SCH2 before: $(one "$SCH2")"
  snapshot_to "$OUT/snap-arm3a-before.txt"
  reorder_wire "mixed-noop" 'list "Upcoming"' "$SCH1,$TA,$SCH2"
  snapshot_to "$OUT/snap-arm3a-after.txt"
  note "  SCH1 after: $(one "$SCH1")"
  note "  TS-A after: $(one "$TA")"
  note "  SCH2 after: $(one "$SCH2")"
  note "  full-DB diff lines: $(diff "$OUT/snap-arm3a-before.txt" "$OUT/snap-arm3a-after.txt" | grep -c '^[<>]' || true)"
  note "  VERDICT-TMPLSORT3a: mixed wire incl. a template = FULL no-op (zero DB delta, no partial write)? => planner can safely refuse-or-split."
  exit 0
fi

# =============================================================== arm3b (reparent hazard + restore)
if [ "$CMD" = "arm3b" ]; then
  load_session
  note "################## TMPLSORT-3b — project-id reparent hazard + RESTORE ##################"
  TB=$(tmpl_uuid_of TS-B)
  note "  victim template TS-B=$TB"
  note "  before: $(one "$TB")   proj=$(proj_of "$TB")"
  note "  before rt1: $(rt1 "$TB")"
  snapshot_to "$OUT/snap-arm3b-before.txt"
  reorder_wire "projid-reparent" "project id \"$PROJ\"" "$TB"
  note "  after reparent: $(one "$TB")   proj=$(proj_of "$TB")"
  note "  after rt1: $(rt1 "$TB")"
  note "  --- RESTORE attempt 1: URL update?list-id= (empty, detach from project) ---"
  gurl "things:///update?id=$TB&auth-token=$TOKEN&list-id="
  note "  after URL list-id= clear: proj=$(proj_of "$TB")   $(one "$TB")"
  if [ "$(proj_of "$TB")" != "NULL" ]; then
    note "  --- RESTORE attempt 2: AppleScript move to list \"Anytime\" ---"
    note "  AS move: [$(gas "tell application \"Things3\" to move to do id \"$TB\" to list \"Anytime\"")]"
    sleep 2
    note "  after AS move: proj=$(proj_of "$TB")   $(one "$TB")"
  fi
  snapshot_to "$OUT/snap-arm3b-after.txt"
  note "  VERDICT-TMPLSORT3b: project-id reorder REPARENTS (project NULL->P + umd bump, todayIndex untouched, rt1 identical)? RESTORE possible (project->NULL)?"
  exit 0
fi

# =============================================================== arm3c (Today/Tomorrow blind-writer)
if [ "$CMD" = "arm3c" ]; then
  load_session
  note "################## TMPLSORT-3c — template id in list \"Today\"/\"Tomorrow\" wires ##################"
  note "  seeding TODAY rows TD1/TD2 (when=today) and TOMORROW rows TM1/TM2 (when=$TMRW)"
  for t in TD1 TD2; do gurl "things:///add?title=$t&when=today"; sleep 1; done
  for t in TM1 TM2; do gurl "things:///add?title=$t&when=$TMRW"; sleep 1; done
  TD1=$(uuid_of TD1 0); TD2=$(uuid_of TD2 0); TM1=$(uuid_of TM1 0); TM2=$(uuid_of TM2 0)
  TA=$(tmpl_uuid_of TS-A)
  note "  TD1=$TD1 TD2=$TD2 TM1=$TM1 TM2=$TM2 TS-A=$TA"
  note "  --- list \"Today\" MIXED wire {TD2, TS-A(template), TD1} ---"
  note "     TD1/TD2 before: $(tidx_order "'TD1','TD2'")"
  note "     TS-A before: $(one "$TA")"
  snapshot_to "$OUT/snap-arm3c-today-before.txt"
  reorder_wire "today-mixed" 'list "Today"' "$TD2,$TA,$TD1"
  snapshot_to "$OUT/snap-arm3c-today-after.txt"
  note "     TD1/TD2 after: $(tidx_order "'TD1','TD2'")"
  note "     TS-A after: $(one "$TA")"
  note "     full-DB diff lines (today): $(diff "$OUT/snap-arm3c-today-before.txt" "$OUT/snap-arm3c-today-after.txt" | grep -c '^[<>]' || true)"
  note "  --- list \"Tomorrow\" MIXED wire {TM2, TS-A(template), TM1} ---"
  note "     TM1/TM2 before: $(tidx_order "'TM1','TM2'")"
  snapshot_to "$OUT/snap-arm3c-tmrw-before.txt"
  reorder_wire "tmrw-mixed" 'list "Tomorrow"' "$TM2,$TA,$TM1"
  snapshot_to "$OUT/snap-arm3c-tmrw-after.txt"
  note "     TM1/TM2 after: $(tidx_order "'TM1','TM2'")"
  note "     TS-A after: $(one "$TA")"
  note "     full-DB diff lines (tmrw): $(diff "$OUT/snap-arm3c-tmrw-before.txt" "$OUT/snap-arm3c-tmrw-after.txt" | grep -c '^[<>]' || true)"
  note "  VERDICT-TMPLSORT3c: mixed Today/Tomorrow wire RE-RANKS TD/TM (blind-writer collateral, template skipped) or FULL no-op? crash? => what the wiring must guard."
  exit 0
fi

# ============================================================================
# RE-PROBE ARMS (TMPLSORT-2, the wire-syntax audit recovery). These use the
# BAKED LAB-REPEAT-DAILY template + URL-seeded rows only — NO VNC template
# creation — and the CORRECT comma-text `with ids` form. They re-run the multi-id
# findings the list-literal artifact invalidated (arm3a/arm3c above, TDRAG-3-2,
# ORD-18) with a wire the app actually receives.
# ============================================================================
ix() { gq "SELECT \"index\" FROM TMTask WHERE uuid='$1'"; }

# rp-coerce — THE COERCION LAW + the positive/negative control that anchors the
# whole re-probe: a multi-item AppleScript list literal vs the shipped comma-text.
if [ "$CMD" = "rp-coerce" ]; then
  load_session
  note "################## RP-COERCE — the list-literal coercion law (positive/negative control) ##################"
  note "  [as-text coercion] osascript '({\"aa\",\"bb\",\"cc\"}) as text' = [$(gas '({"aa","bb","cc"}) as text')]"
  note "     (AppleScript's default text-item-delimiter is \"\" → a multi-item list coerces by CONCATENATION → ONE garbage id)"
  note "  seeding CE1/CE2/CE3 anytime in LAB-PROJ-PLAIN (a clean deterministic index-reorder surface — SOMEORD-b)"
  for t in CE1 CE2 CE3; do gurl "things:///add?title=$t&when=anytime&list-id=$PROJ"; sleep 1; done
  CE1=$(uuid_of CE1 0); CE2=$(uuid_of CE2 0); CE3=$(uuid_of CE3 0)
  note "  CE1=$CE1 CE2=$CE2 CE3=$CE3"
  note "  resting index: CE1=$(ix "$CE1") CE2=$(ix "$CE2") CE3=$(ix "$CE3")"
  note "  --- NEGATIVE: LIST-LITERAL wire {CE3,CE1,CE2} (the OLD malformed probe shape) ---"
  RES=$(gas "tell application \"Things3\" to _private_experimental_ reorder to dos in project id \"$PROJ\" with ids {\"$CE3\",\"$CE1\",\"$CE2\"}")
  note "     AS result/err: [$RES]"
  note "     index after list-literal: CE1=$(ix "$CE1") CE2=$(ix "$CE2") CE3=$(ix "$CE3")  (EXPECT unchanged = the artifact)"
  sleep 2
  note "  --- POSITIVE: COMMA-TEXT wire \"CE3,CE1,CE2\" (the shipped op shape, src/write/commands.ts) ---"
  RES=$(gas "tell application \"Things3\" to _private_experimental_ reorder to dos in project id \"$PROJ\" with ids \"$CE3,$CE1,$CE2\"")
  note "     AS result/err: [$RES]"
  sleep 2
  note "     index after comma-text: CE1=$(ix "$CE1") CE2=$(ix "$CE2") CE3=$(ix "$CE3")  (EXPECT distinct, ascending CE3<CE1<CE2)"
  note "  VERDICT-COERCE: list-literal = no-op (silent concat to one non-id) AND comma-text = real multi-id re-rank => every multi-id list-literal probe never reached the app."
  { echo "CE1=$CE1"; echo "CE2=$CE2"; echo "CE3=$CE3"; } >> "$SESSION"
  exit 0
fi

# rp-ord18 — ORD-18 (TDRAG-5) re-verify with a VALID reorder: distinct index
# survives scheduling + the dated day-bounce is index-byte-isolated. Needs the
# CE rows made index-distinct by rp-coerce's comma-text reorder.
if [ "$CMD" = "rp-ord18" ]; then
  load_session; source "$SESSION"
  note "################## RP-ORD18 — ORD-18/TDRAG-5 re-verify (VALID reorder provenance) ##################"
  note "  CE index (post comma-text reorder in rp-coerce): CE1=$(ix "$CE1") CE2=$(ix "$CE2") CE3=$(ix "$CE3")"
  note "  --- schedule all three to $TMRW (when=$TMRW) ---"
  for u in "$CE1" "$CE2" "$CE3"; do gurl "things:///update?id=$u&auth-token=$TOKEN&when=$TMRW"; done
  note "  index after scheduling: CE1=$(ix "$CE1") CE2=$(ix "$CE2") CE3=$(ix "$CE3")  (does scheduling PRESERVE distinct index?)"
  note "  CE2 now: $(one "$CE2")"
  IXB=$(ix "$CE2")
  note "  --- dated day-bounce on CE2: when=$DAY2 then when=$TMRW ---"
  gurl "things:///update?id=$CE2&auth-token=$TOKEN&when=$DAY2"
  gurl "things:///update?id=$CE2&auth-token=$TOKEN&when=$TMRW"
  IXA=$(ix "$CE2")
  note "  CE2 index BEFORE bounce=$IXB AFTER bounce=$IXA  (EXPECT byte-identical); CE2 now: $(one "$CE2")"
  note "  VERDICT-ORD18: (1) native comma-text reorder GIVES distinct index (was the list-literal claim — corrected); (2) scheduling preserves it; (3) the dated day-bounce is index-byte-isolated (todayIndex front-inserts, index untouched)."
  exit 0
fi

# rp-mixed — the REAL TDRAG-3-2 / TMPLSORT-3a: a VALID multi-id list "Upcoming"
# wire carrying the baked template in the MIDDLE. PID-watched (crash-adjacent).
if [ "$CMD" = "rp-mixed" ]; then
  load_session
  note "################## RP-MIXED — VALID multi-id Upcoming wire carrying a TEMPLATE (corrects TDRAG-3-2 / TMPLSORT-3a) ##################"
  TD="$TMPL_TODO"
  note "  template (baked LAB-REPEAT-DAILY) resting: $(one "$TD")   proj=$(proj_of "$TD")"
  note "  seeding SA/SB scheduled to-dos on $TMRW (loose 07-06 Upcoming block, shared with the template projection)"
  for t in SA SB; do gurl "things:///add?title=$t&when=$TMRW"; sleep 1; done
  SA=$(uuid_of SA 0); SB=$(uuid_of SB 0)
  note "  SA=$SA SB=$SB TEMPLATE=$TD"
  note "  block todayIndex order before: $(tidx_order "'SA','SB','LAB-REPEAT-DAILY'")"
  note "  SA before: $(one "$SA")"
  note "  SB before: $(one "$SB")"
  note "  template before: $(one "$TD")"
  snapshot_to "$OUT/snap-rpmixed-before.txt"
  reorder_wire "rp-mixed-upcoming" 'list "Upcoming"' "$SA,$TD,$SB"
  snapshot_to "$OUT/snap-rpmixed-after.txt"
  note "  SA after: $(one "$SA")"
  note "  SB after: $(one "$SB")"
  note "  template after: $(one "$TD")   proj=$(proj_of "$TD")"
  note "  block todayIndex order after: $(tidx_order "'SA','SB','LAB-REPEAT-DAILY'")"
  note "  full-DB diff lines: $(diff "$OUT/snap-rpmixed-before.txt" "$OUT/snap-rpmixed-after.txt" | grep -c '^[<>]' || true)"
  note "  --- changed rows (full-DB diff, before→after this wire) ---"
  diff "$OUT/snap-rpmixed-before.txt" "$OUT/snap-rpmixed-after.txt" | grep '^[<>]' | sed 's/^/     /' | tee -a "$REPORT" >/dev/null
  note "  VERDICT-RP-MIXED: does the VALID wire position all three (SA<tmpl<SB)? re-rank ONLY the ordinary rows (template skipped)? full no-op? crash? => the REAL verdict."
  exit 0
fi

# rp-tt — the REAL TMPLSORT-3c: VALID Today + Tomorrow multi-id wires carrying
# the baked template. The Tomorrow wire is the decisive all-valid-member case.
if [ "$CMD" = "rp-tt" ]; then
  load_session
  note "################## RP-TT — VALID Today/Tomorrow multi-id wires with a TEMPLATE (corrects TMPLSORT-3c) ##################"
  TD="$TMPL_TODO"
  note "  seeding TD1/TD2 (when=today) + TM1/TM2 (when=$TMRW)"
  for t in TD1 TD2; do gurl "things:///add?title=$t&when=today"; sleep 1; done
  for t in TM1 TM2; do gurl "things:///add?title=$t&when=$TMRW"; sleep 1; done
  TD1=$(uuid_of TD1 0); TD2=$(uuid_of TD2 0); TM1=$(uuid_of TM1 0); TM2=$(uuid_of TM2 0)
  note "  TD1=$TD1 TD2=$TD2 TM1=$TM1 TM2=$TM2 TEMPLATE=$TD"
  note "  --- list \"Today\" wire \"TD2,TEMPLATE,TD1\" (template is NOT a Today member) ---"
  note "     TD order before: $(tidx_order "'TD1','TD2'")"
  snapshot_to "$OUT/snap-rptt-today-before.txt"
  reorder_wire "rp-today" 'list "Today"' "$TD2,$TD,$TD1"
  snapshot_to "$OUT/snap-rptt-today-after.txt"
  note "     TD order after: $(tidx_order "'TD1','TD2'")"
  note "     template after: $(one "$TD")   proj=$(proj_of "$TD")"
  note "     full-DB diff lines (today): $(diff "$OUT/snap-rptt-today-before.txt" "$OUT/snap-rptt-today-after.txt" | grep -c '^[<>]' || true)"
  note "  --- list \"Tomorrow\" wire \"TM2,TEMPLATE,TM1\" (ALL THREE are 07-06 members — DECISIVE) ---"
  note "     TM order before: $(tidx_order "'TM1','TM2'")"
  snapshot_to "$OUT/snap-rptt-tmrw-before.txt"
  reorder_wire "rp-tmrw" 'list "Tomorrow"' "$TM2,$TD,$TM1"
  snapshot_to "$OUT/snap-rptt-tmrw-after.txt"
  note "     TM order after: $(tidx_order "'TM1','TM2'")"
  note "     template after: $(one "$TD")   proj=$(proj_of "$TD")"
  note "     full-DB diff lines (tmrw): $(diff "$OUT/snap-rptt-tmrw-before.txt" "$OUT/snap-rptt-tmrw-after.txt" | grep -c '^[<>]' || true)"
  note "  --- changed rows (tomorrow full-DB diff) ---"
  diff "$OUT/snap-rptt-tmrw-before.txt" "$OUT/snap-rptt-tmrw-after.txt" | grep '^[<>]' | sed 's/^/     /' | tee -a "$REPORT" >/dev/null
  note "  VERDICT-RP-TT: Today wire (template not a member) + Tomorrow wire (all valid members) — re-rank ordinary rows? no-op? template positioned/skipped? crash? => the REAL TMPLSORT-3c verdict."
  exit 0
fi

# =============================================================== snapshot / pulldb / teardown
if [ "$CMD" = "snapshot" ]; then
  load_session; LBL="${2:-snap}"; DST="$OUT/snap-$LBL.txt"; snapshot_to "$DST"
  note "snapshot -> $DST ($(wc -l < "$DST") lines)"; exit 0
fi
if [ "$CMD" = "pulldb" ]; then
  load_session; LABEL="${2:-snapshot}"; DST="$OUT/db-$LABEL.sqlite"
  RP=$(lab_ssh "$IP" 'echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite' </dev/null)
  lab_scp "$IP:$RP" "$DST"; note "pulled -> $DST"; exit 0
fi
if [ "$CMD" = "teardown" ]; then
  note "teardown: $VM"
  pkill -f "tart run $VM" >/dev/null 2>&1 || true
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  tart list 2>/dev/null | sed 's/^/  /' | tee -a "$REPORT"
  exit 0
fi

echo "usage: $0 setup|caps|mktmpl <title>|arm1-seed|arm1|arm1-contam|arm1-proj|arm2|arm3a|arm3b|arm3c|rp-coerce|rp-ord18|rp-mixed|rp-tt|snapshot <l>|pulldb <l>|teardown" >&2
exit 1
