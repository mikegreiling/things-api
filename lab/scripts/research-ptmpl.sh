#!/bin/bash
# PTMPL — repeating PROJECT-template projections in Upcoming day blocks + the
# `list "Upcoming"` multi-id placement law. Golden-v2 / Things 3.22.12.
# Write-up: docs/lab/ptmpl-project-templates.md.
#
# The maintainer (daily app user) reports that repeating PROJECT templates DO
# appear INSIDE Upcoming day blocks, contradicting #391's project-INERT claim
# ("renders in the sidebar, not as a day-block projection row") — a claim that
# arm never verified eyes-on. This sitting settles three things:
#
#   ARM A  project-template projection GROUND TRUTH (eyes-on + bytes):
#          (a) does the macOS Upcoming view render the LAB-REPEAT-WEEKLY-PROJ
#              projection INSIDE its 07-12 day block (VNC screenshot)?
#          (b) if rendered, is it GUI drag-sortable within the block (TDRAG-1
#              drag recipe -> FULL byte capture: does todayIndex lazy-assign
#              like to-do templates? any other store)?
#          (c) quit/relaunch persistence.
#   ARM B  headless REACH for the project-template projection (crash-watched):
#          (a) single-id comma-text wires per specifier: list "Upcoming"
#              (re-confirm #391 no-op), list "Tomorrow" (repin so proj day ==
#              tomorrow), list "Today"; (b) MULTI-id member wire incl. the
#              project template ("S1,PROJTMPL,S2"); (c) area id specifier IF the
#              template carries an area FK; (d) full byte audit + instance
#              contamination after any accepted write.
#   ARM C  the list "Upcoming" multi-id PLACEMENT LAW (resolves RP-MIXED): a
#          block of 4-5 ordinary scheduled rows, comma-text member wires,
#          permutations (reverse / rotation / no-op / subset). Derive the law
#          (sent-order? batch-front-insert? min-moves?), confirm no re-date + no
#          collateral, then ONE trial re-running RP-MIXED's shape (to-do template
#          mid-wire) to confirm the law explains its anomaly. Compare vs
#          list "Tomorrow" exact-sent-order.
#
# Conventions (inherited from research-tmplsort.sh / research-tdrag.sh): offline
# COW clone, guest airgap, clock pinned BEFORE Things launches, read-only guest
# SQLite, dates SEEDED via URL when=. NEVER send URL when= to a repeating
# template (§1 CRASH). Reorder wires are PID-watched (templates §1/§6 crash-
# adjacent). NEVER the host DB; no Things-DB SQLite writes; teardown verified.
#
# Requires $VNCDO (vncdotool venv, lives in the PRIMARY checkout, gitignored):
#   VNCDO=/Volumes/Workspace/Projects/things-api/lab/vncvenv/bin/vncdo
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v2}"
PIN="${PIN:-070512002026}"           # 2026-07-05 12:00 (golden pinnedDate)
TODAY="${TODAY:-2026-07-05}"
TMRW="${TMRW:-2026-07-06}"           # daily-template projection / tomorrow @ default pin
DAY12="${DAY12:-2026-07-12}"         # LAB-REPEAT-WEEKLY-PROJ projects here (rt1_next)
DAYC="${DAYC:-2026-07-09}"           # ARM C ordinary-row block (a clean spare future day)
PIN_T="${PIN_T:-071112002026}"       # 2026-07-11 12:00 — repin so 07-12 == Tomorrow (ARM B)
TODAY_T="2026-07-11"
AA="7Ck4hAXU36jyaBsy2Fkije"          # LAB-AREA-A
PROJ="933TCvzMgM3MLvpKPcjheC"        # LAB-PROJ-PLAIN
TMPL_TODO="W3PZB9e7W6BEtKmEKP4deG"   # LAB-REPEAT-DAILY (repeating to-do template)
TMPL_PROJ="759yS6xe6d3a3h2dfVxoMZ"   # LAB-REPEAT-WEEKLY-PROJ (repeating project template)
VM="ptmpl-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/screens"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[ptmpl] $*" | tee -a "$REPORT"; }

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
rt1() { gq "SELECT 'paused='||COALESCE(rt1_instanceCreationPaused,'-')||' next='||COALESCE(rt1_nextInstanceStartDate,'-')||' ruleLen='||COALESCE(length(rt1_recurrenceRule),0)||' ruleHex='||COALESCE(substr(hex(rt1_recurrenceRule),1,80),'-') FROM TMTask WHERE uuid='$1'"; }
tidx_order() { gq "SELECT group_concat(title||':'||todayIndex,' ') FROM (SELECT title,todayIndex FROM TMTask WHERE title IN ($1) AND trashed=0 ORDER BY todayIndex)"; }
torder() { gq "SELECT group_concat(title||':'||todayIndex,' ') FROM (SELECT title,todayIndex FROM TMTask WHERE uuid IN ($1) AND trashed=0 ORDER BY todayIndex, uuid)"; }
tidx_of() { gq "SELECT todayIndex FROM TMTask WHERE uuid='$1'"; }
ix() { gq "SELECT \"index\" FROM TMTask WHERE uuid='$1'"; }
proj_of() { gq "SELECT COALESCE(substr(project,1,8),'NULL') FROM TMTask WHERE uuid='$1'"; }
area_of() { gq "SELECT COALESCE(substr(area,1,8),'NULL') FROM TMTask WHERE uuid='$1'"; }

uuid_of() { local t="$1" typ="${2:-}" w u i; w="title='$t' AND trashed=0"; [ -n "$typ" ] && w="$w AND type=$typ"
  for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }

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
diffsnap() { diff "$1" "$2" | grep '^[<>]' | sed 's/^/     /' | tee -a "$REPORT" >/dev/null; }
diffcount() { diff "$1" "$2" | grep -c '^[<>]' || true; }

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
front() { lab_ssh "$IP" "open 'things:///show?id=$1'; sleep 2; osascript -e 'tell application \"Things3\" to activate'; sleep 3" </dev/null; }

# --------- PID watch (§1/§6 detector shape) ----------
gpid() { lab_ssh "$IP" 'pgrep -x Things3 || true' </dev/null | tr -d '[:space:]'; }
grelaunch() { lab_ssh "$IP" 'open -g -a Things3' </dev/null; local i p; for i in $(seq 1 10); do p=$(gpid); [ -n "$p" ] && { sleep 4; return 0; }; sleep 2; done; note "  WARN: Things did not relaunch"; return 1; }

# reorder_wire <label> <specifier> <comma-ids> — PID-watched private reorder.
# <comma-ids> is a BARE comma-joined uuid string; the helper wraps it in the ONE
# quoted-TEXT form the shipped op emits (`with ids "id1,id2,id3"`,
# src/write/commands.ts). NEVER an AppleScript LIST literal {"a","b"} — a
# multi-item list literal throws -1700 at the AppleEvent boundary (the app never
# runs; the TMPLSORT wire-syntax artifact, docs/lab/tmplsort-template-protocol.md).
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
  note "cloning $GOLDEN -> $VM (today $TODAY, proj-tmpl projection $DAY12)"
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

  note "--- baked project-template resting bytes ---"
  note "  TMPL_PROJ (LAB-REPEAT-WEEKLY-PROJ): $(one "$TMPL_PROJ")"
  note "    rt1: $(rt1 "$TMPL_PROJ")"
  note "    area FK = $(area_of "$TMPL_PROJ")   project FK = $(proj_of "$TMPL_PROJ")"
  note "    next projection (rt1_next) = $(gq "SELECT rt1_nextInstanceStartDate FROM TMTask WHERE uuid='$TMPL_PROJ'")"
  note "  TMPL_TODO (LAB-REPEAT-DAILY): $(one "$TMPL_TODO")"
  note "    rt1: $(rt1 "$TMPL_TODO")"
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

# =============================================================== q (ad-hoc SQL)
if [ "$CMD" = "q" ]; then load_session; gq "$2"; exit 0; fi

# =============================================================== pushgsql (restore /tmp helper)
if [ "$CMD" = "pushgsql" ]; then
  load_session
  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"
  note "re-pushed /tmp/gsql.sh; smoke: $(gq "SELECT 'ok'")"
  exit 0
fi

# =============================================================== A-seed
# Seed co-resident scheduled rows PA1/PA2/PA3 on DAY12 (the project-template's
# projection block) so the block has observable order + a drop target.
if [ "$CMD" = "A-seed" ]; then
  load_session
  note "################## ARM A seed — 07-12 co-resident block ##################"
  note "  seeding PA1/PA2/PA3 scheduled to-dos on $DAY12 (the project template's block)"
  for t in PA1 PA2 PA3; do gurl "things:///add?title=$t&when=$DAY12"; sleep 1; done
  for v in PA1 PA2 PA3; do u=$(uuid_of "$v" 0); echo "$v=$u" >> "$SESSION"; note "  $v: $(one "$u")"; done
  source "$SESSION"
  note "  TMPL_PROJ: $(one "$TMPL_PROJ")   rt1: $(rt1 "$TMPL_PROJ")"
  note "  block todayIndex order (ascending, incl. proj tmpl): $(torder "'$PA1','$PA2','$PA3','$TMPL_PROJ'")"
  note "  seed DONE — now: A-shot before ; inspect PNG (does the proj tmpl render IN the 07-12 block?) ; A-drag ... ; A-read after"
  exit 0
fi

# =============================================================== A-shot
if [ "$CMD" = "A-shot" ]; then
  load_session; vnc_init || exit 1
  LBL="${2:-shot}"; N="${3:-0}"
  front "upcoming"
  V move 1200 800
  for i in $(seq 1 "$N"); do V key pgdn; sleep 0.5; done
  V capture "$OUT/screens/$LBL.png" && note "  captured screens/$LBL.png ($(ls -la "$OUT/screens/$LBL.png" | awk '{print $5}') bytes)" || note "  capture FAILED"
  exit 0
fi

# =============================================================== A-drag
if [ "$CMD" = "A-drag" ]; then
  load_session; vnc_init || exit 1
  SX="$2"; SY="$3"; TX="$4"; TY="$5"; LBL="${6:-drag}"
  note "  ARM A DRAG ($SX,$SY) -> ($TX,$TY) [$LBL]"
  snapshot_to "$OUT/snap-Adrag-before.txt"
  # ONE session, EXPLICIT move waypoints (NOT vncdo `drag` — py3.14/Twisted drops
  # the trailing mouseup). mousedown sets the mask; each move re-sends it; trailing
  # capture flushes the release. (TDRAG-1 recipe.)
  mid=$(( (SY + TY) / 2 ))
  V move "$SX" "$SY" pause 0.7 mousedown 1 pause 0.8 \
    move "$SX" $((SY-12)) pause 0.35 \
    move "$TX" "$mid" pause 0.35 \
    move "$TX" $((TY-3)) pause 0.35 \
    move "$TX" "$TY" pause 0.9 \
    mouseup 1 pause 0.7 capture "$OUT/screens/${LBL}-drop.png"
  sleep 3
  snapshot_to "$OUT/snap-Adrag-after.txt"
  note "  drag issued. TMPL_PROJ after: $(one "$TMPL_PROJ")"
  note "  full-DB diff lines: $(diffcount "$OUT/snap-Adrag-before.txt" "$OUT/snap-Adrag-after.txt")"
  note "  --- changed rows (full-DB diff) ---"; diffsnap "$OUT/snap-Adrag-before.txt" "$OUT/snap-Adrag-after.txt"
  exit 0
fi

# =============================================================== A-read
if [ "$CMD" = "A-read" ]; then
  load_session; LBL="${2:-read}"
  note "  --- ARM A read ($LBL) ---"
  note "  TMPL_PROJ: $(one "$TMPL_PROJ")"
  note "  TMPL_PROJ rt1: $(rt1 "$TMPL_PROJ")"
  [ -n "${PA1:-}" ] && note "  block: $(torder "'$PA1','$PA2','$PA3','$TMPL_PROJ'")"
  exit 0
fi

# =============================================================== A-persist
if [ "$CMD" = "A-persist" ]; then
  load_session
  note "  --- ARM A PERSISTENCE: quit + relaunch ---"
  note "  before quit: $(one "$TMPL_PROJ")"
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 4' </dev/null
  lab_ssh "$IP" 'open -g -a Things3; sleep 10' </dev/null
  note "  after relaunch: $(one "$TMPL_PROJ")"
  [ -n "${PA1:-}" ] && note "  block after relaunch: $(torder "'$PA1','$PA2','$PA3','$TMPL_PROJ'")"
  note "  VERDICT-A-PERSIST: proj-tmpl todayIndex survives quit/relaunch (byte-identical) AND block re-renders in dragged order?"
  exit 0
fi

# =============================================================== B-single
# Single-id comma-text wires per specifier with the PROJECT template id.
if [ "$CMD" = "B-single" ]; then
  load_session
  note "################## ARM B single — single-id wires per specifier (project template) ##################"
  # ensure the 07-12 block has co-residents (a front-insert needs somewhere to land)
  if [ -z "${PA1:-}" ]; then
    for t in PA1 PA2 PA3; do gurl "things:///add?title=$t&when=$DAY12"; sleep 1; done
    PA1=$(uuid_of PA1 0); PA2=$(uuid_of PA2 0); PA3=$(uuid_of PA3 0)
    { echo "PA1=$PA1"; echo "PA2=$PA2"; echo "PA3=$PA3"; } >> "$SESSION"
  fi
  note "  block before: $(torder "'$PA1','$PA2','$PA3','$TMPL_PROJ'")"
  for spec in 'list "Upcoming"' 'list "Today"' 'list "Tomorrow"'; do
    lbl=$(echo "$spec" | tr -d ' "')
    note "  == specifier $spec =="
    note "     TMPL_PROJ before: $(one "$TMPL_PROJ")   proj=$(proj_of "$TMPL_PROJ") area=$(area_of "$TMPL_PROJ")"
    snapshot_to "$OUT/snap-Bsingle-$lbl-before.txt"
    reorder_wire "B-$lbl" "$spec" "$TMPL_PROJ"
    snapshot_to "$OUT/snap-Bsingle-$lbl-after.txt"
    note "     TMPL_PROJ after:  $(one "$TMPL_PROJ")   proj=$(proj_of "$TMPL_PROJ") area=$(area_of "$TMPL_PROJ")"
    note "     full-DB diff lines: $(diffcount "$OUT/snap-Bsingle-$lbl-before.txt" "$OUT/snap-Bsingle-$lbl-after.txt")"
    diffsnap "$OUT/snap-Bsingle-$lbl-before.txt" "$OUT/snap-Bsingle-$lbl-after.txt"
    note "     block now: $(torder "'$PA1','$PA2','$PA3','$TMPL_PROJ'")"
  done
  note "  VERDICT-B-single: which specifiers (if any) write the project template's todayIndex? re-confirm #391 list Upcoming no-op with fresh eyes."
  exit 0
fi

# =============================================================== B-multi
# MULTI-id member wire including the project template in the MIDDLE.
if [ "$CMD" = "B-multi" ]; then
  load_session
  note "################## ARM B multi — multi-id member wire incl. project template ##################"
  note "  seeding S1/S2 scheduled to-dos on $DAY12 (share the proj-tmpl 07-12 block)"
  for t in S1 S2; do gurl "things:///add?title=$t&when=$DAY12"; sleep 1; done
  S1=$(uuid_of S1 0); S2=$(uuid_of S2 0)
  { echo "S1=$S1"; echo "S2=$S2"; } >> "$SESSION"
  note "  S1=$S1 S2=$S2 TMPL_PROJ=$TMPL_PROJ"
  note "  block before: $(torder "'$S1','$S2','$TMPL_PROJ'")"
  note "  S1 before: $(one "$S1")"
  note "  S2 before: $(one "$S2")"
  note "  TMPL_PROJ before: $(one "$TMPL_PROJ")   proj=$(proj_of "$TMPL_PROJ")"
  snapshot_to "$OUT/snap-Bmulti-before.txt"
  reorder_wire "B-multi-upcoming" 'list "Upcoming"' "$S1,$TMPL_PROJ,$S2"
  snapshot_to "$OUT/snap-Bmulti-after.txt"
  note "  S1 after: $(one "$S1")"
  note "  S2 after: $(one "$S2")"
  note "  TMPL_PROJ after: $(one "$TMPL_PROJ")   proj=$(proj_of "$TMPL_PROJ")"
  note "  block after: $(torder "'$S1','$S2','$TMPL_PROJ'")"
  note "  full-DB diff lines: $(diffcount "$OUT/snap-Bmulti-before.txt" "$OUT/snap-Bmulti-after.txt")"
  note "  --- changed rows ---"; diffsnap "$OUT/snap-Bmulti-before.txt" "$OUT/snap-Bmulti-after.txt"
  note "  VERDICT-B-multi: does the wire place the project template as a member (S1<tmpl<S2)? re-rank only S1/S2 (tmpl skipped)? full no-op? crash?"
  exit 0
fi

# =============================================================== B-area
# area id specifier IF the template carries an area FK. REPARENT-watched.
if [ "$CMD" = "B-area" ]; then
  load_session
  note "################## ARM B area — area id specifier (project template) ##################"
  A=$(area_of "$TMPL_PROJ")
  note "  TMPL_PROJ area FK = $A"
  if [ "$A" = "NULL" ]; then
    note "  project template carries NO area FK — area id specifier is N/A. Testing with LAB-AREA-A anyway (does it REPARENT into the area?)."
  fi
  note "  before: $(one "$TMPL_PROJ")   area=$(area_of "$TMPL_PROJ") proj=$(proj_of "$TMPL_PROJ")"
  snapshot_to "$OUT/snap-Barea-before.txt"
  reorder_wire "B-area" "area id \"$AA\"" "$TMPL_PROJ"
  snapshot_to "$OUT/snap-Barea-after.txt"
  note "  after: $(one "$TMPL_PROJ")   area=$(area_of "$TMPL_PROJ") proj=$(proj_of "$TMPL_PROJ")"
  note "  full-DB diff lines: $(diffcount "$OUT/snap-Barea-before.txt" "$OUT/snap-Barea-after.txt")"
  diffsnap "$OUT/snap-Barea-before.txt" "$OUT/snap-Barea-after.txt"
  # RESTORE if it reparented into the area
  if [ "$(area_of "$TMPL_PROJ")" != "$A" ]; then
    note "  *** area FK CHANGED — attempting RESTORE via URL list-id= (empty) ***"
    gurl "things:///update-project?id=$TMPL_PROJ&auth-token=$TOKEN&list-id="
    note "  after restore: area=$(area_of "$TMPL_PROJ") proj=$(proj_of "$TMPL_PROJ")"
  fi
  note "  VERDICT-B-area: area id reorder places todayIndex? REPARENT (area FK write)? no-op? crash?"
  exit 0
fi

# =============================================================== B-contam
if [ "$CMD" = "B-contam" ]; then
  load_session
  note "################## ARM B — project-template instance contamination check ##################"
  note "  TMPL_PROJ (mutated?): $(one "$TMPL_PROJ")"
  note "  existing instances of TMPL_PROJ:"
  gq "SELECT uuid||' '||title||' t='||type||' tIdx='||todayIndex||' sd='||COALESCE(startDate,'-') FROM TMTask WHERE rt1_repeatingTemplate='$TMPL_PROJ' AND trashed=0" | sed 's/^/     /' | tee -a "$REPORT" >/dev/null
  note "  VERDICT-B-contam: no accepted write => nothing to contaminate; if a write landed, is the next spawned instance clean (tIdx=0)?"
  exit 0
fi

# =============================================================== repin (ARM B Tomorrow)
# Re-pin the guest clock to PIN_T (2026-07-11) so 07-12 == Tomorrow, quit+relaunch
# Things, and report the new projection state. Instance churn (the DAILY template
# spawns 07-06..07-11 instances) is expected + isolated by snapshots.
if [ "$CMD" = "repin" ]; then
  load_session
  note "################## REPIN — clock -> $TODAY_T so 07-12 == Tomorrow ##################"
  note "  quit Things, re-pin clock, relaunch"
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 4' </dev/null
  lab_ssh "$IP" "sudo date $PIN_T >/dev/null; date" </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null
  note "  TMPL_PROJ after repin: $(one "$TMPL_PROJ")   rt1: $(rt1 "$TMPL_PROJ")"
  note "  proj-tmpl next projection = $(gq "SELECT rt1_nextInstanceStartDate FROM TMTask WHERE uuid='$TMPL_PROJ'") (expect still 07-12 = tomorrow)"
  echo "REPINNED=1" >> "$SESSION"
  exit 0
fi

# =============================================================== B-tomorrow
# list "Tomorrow" wires (single + multi) with the project template, AFTER repin
# so 07-12 == Tomorrow. Does the Tomorrow specifier address a PROJECT template?
if [ "$CMD" = "B-tomorrow" ]; then
  load_session
  note "################## ARM B Tomorrow — list \"Tomorrow\" wires (proj day == tomorrow) ##################"
  note "  seeding TM1/TM2 scheduled to-dos on $DAY12 (now the Tomorrow block)"
  for t in TM1 TM2; do gurl "things:///add?title=$t&when=$DAY12"; sleep 1; done
  TM1=$(uuid_of TM1 0); TM2=$(uuid_of TM2 0)
  note "  TM1=$TM1 TM2=$TM2 TMPL_PROJ=$TMPL_PROJ"
  note "  block before: $(torder "'$TM1','$TM2','$TMPL_PROJ'")"
  note "  --- single-id list \"Tomorrow\" with the project template ---"
  note "     TMPL_PROJ before: $(one "$TMPL_PROJ")"
  snapshot_to "$OUT/snap-Btmrw-single-before.txt"
  reorder_wire "B-tmrw-single" 'list "Tomorrow"' "$TMPL_PROJ"
  snapshot_to "$OUT/snap-Btmrw-single-after.txt"
  note "     TMPL_PROJ after: $(one "$TMPL_PROJ")   proj=$(proj_of "$TMPL_PROJ")"
  note "     full-DB diff lines: $(diffcount "$OUT/snap-Btmrw-single-before.txt" "$OUT/snap-Btmrw-single-after.txt")"
  diffsnap "$OUT/snap-Btmrw-single-before.txt" "$OUT/snap-Btmrw-single-after.txt"
  note "  --- multi-id list \"Tomorrow\" wire \"TM2,TMPL_PROJ,TM1\" (all 07-12 members) ---"
  note "     TM order before: $(torder "'$TM1','$TM2'")"
  snapshot_to "$OUT/snap-Btmrw-multi-before.txt"
  reorder_wire "B-tmrw-multi" 'list "Tomorrow"' "$TM2,$TMPL_PROJ,$TM1"
  snapshot_to "$OUT/snap-Btmrw-multi-after.txt"
  note "     TM order after: $(torder "'$TM1','$TM2'")"
  note "     TMPL_PROJ after: $(one "$TMPL_PROJ")   proj=$(proj_of "$TMPL_PROJ")"
  note "     block after: $(torder "'$TM1','$TM2','$TMPL_PROJ'")"
  note "     full-DB diff lines: $(diffcount "$OUT/snap-Btmrw-multi-before.txt" "$OUT/snap-Btmrw-multi-after.txt")"
  diffsnap "$OUT/snap-Btmrw-multi-before.txt" "$OUT/snap-Btmrw-multi-after.txt"
  note "  VERDICT-B-tomorrow: does list \"Tomorrow\" address the project template (single front-insert? member of multi-wire? skipped)?"
  exit 0
fi

# =============================================================== C-seed
# Seed 5 ordinary loose scheduled rows on the FIRST-UPCOMING day (07-06). ARM B
# proved `list "Upcoming"` re-dates a wired row to the first upcoming day (§9g);
# seeding ON that day makes the re-date a no-op so the PLACEMENT law is studied
# clean (matches RP-MIXED's condition — its SA/SB were on 07-06).
if [ "$CMD" = "C-seed" ]; then
  load_session
  DAYC="${DAYC:-$TMRW}"
  note "################## ARM C seed — 5 ordinary scheduled rows on $DAYC (first-upcoming day) ##################"
  for t in C1 C2 C3 C4 C5; do gurl "things:///add?title=$t&when=$DAYC"; sleep 1; done
  for v in C1 C2 C3 C4 C5; do u=$(uuid_of "$v" 0); echo "$v=$u" >> "$SESSION"; note "  $v: $(one "$u")"; done
  source "$SESSION"
  note "  resting block todayIndex order: $(torder "'$C1','$C2','$C3','$C4','$C5'")"
  note "  seed DONE — drive: C-trial <label> <specifier-key up|tm> <C-label wire e.g. C5,C3,C1>"
  exit 0
fi

# C-trial <label> <up|tm> <C-label,wire> — one placement trial. Resolves C-labels
# to uuids, runs the comma-text wire on `list "Upcoming"` (up) or `list "Tomorrow"`
# (tm), reports landed order + full byte deltas + re-date/collateral check.
if [ "$CMD" = "C-trial" ]; then
  load_session; source "$SESSION"
  LBL="$2"; SPECKEY="$3"; CWIRE="$4"
  case "$SPECKEY" in
    up) SPEC='list "Upcoming"';;
    tm) SPEC='list "Tomorrow"';;
    *) note "  unknown specifier key '$SPECKEY' (use up|tm)"; exit 1;;
  esac
  # resolve C-labels -> uuids
  ids=""
  IFS=',' read -ra parts <<< "$CWIRE"
  for p in "${parts[@]}"; do eval "u=\${$p}"; ids="${ids:+$ids,}$u"; done
  note "################## ARM C trial [$LBL] — $SPEC wire \"$CWIRE\" ##################"
  note "  block BEFORE (asc todayIndex): $(torder "'$C1','$C2','$C3','$C4','$C5'")"
  snapshot_to "$OUT/snap-C-$LBL-before.txt"
  reorder_wire "C-$LBL" "$SPEC" "$ids"
  snapshot_to "$OUT/snap-C-$LBL-after.txt"
  note "  block AFTER  (asc todayIndex): $(torder "'$C1','$C2','$C3','$C4','$C5'")"
  note "  full-DB diff lines: $(diffcount "$OUT/snap-C-$LBL-before.txt" "$OUT/snap-C-$LBL-after.txt")"
  note "  --- changed rows (full-DB diff) ---"; diffsnap "$OUT/snap-C-$LBL-before.txt" "$OUT/snap-C-$LBL-after.txt"
  note "  per-row bytes (sd/tir stable == no re-date):"
  for v in C1 C2 C3 C4 C5; do eval "u=\${$v}"; note "     $v: $(one "$u")"; done
  exit 0
fi

# C-rpmixed — ONE trial re-running RP-MIXED's exact shape (to-do template mid-wire)
# on a fresh 07-06 block, to confirm the ARM C law explains RP-MIXED's anomaly
# (sent SA,TEMPLATE,SB but landed TEMPLATE<SA<SB).
if [ "$CMD" = "C-rpmixed" ]; then
  load_session
  note "################## ARM C — RP-MIXED replication (to-do template mid-wire) ##################"
  TD="$TMPL_TODO"
  note "  seeding SA/SB scheduled to-dos on $TMRW (the daily-template 07-06 block)"
  for t in SA SB; do gurl "things:///add?title=$t&when=$TMRW"; sleep 1; done
  SA=$(uuid_of SA 0); SB=$(uuid_of SB 0)
  note "  SA=$SA SB=$SB TEMPLATE(to-do)=$TD"
  note "  block before: $(torder "'$SA','$SB','$TMPL_TODO'")"
  note "  SA before: $(one "$SA")"
  note "  SB before: $(one "$SB")"
  note "  TEMPLATE before: $(one "$TD")"
  snapshot_to "$OUT/snap-Crpmixed-before.txt"
  reorder_wire "C-rpmixed" 'list "Upcoming"' "$SA,$TD,$SB"
  snapshot_to "$OUT/snap-Crpmixed-after.txt"
  note "  SA after: $(one "$SA")"
  note "  SB after: $(one "$SB")"
  note "  TEMPLATE after: $(one "$TD")   proj=$(proj_of "$TD")"
  note "  block after: $(torder "'$SA','$SB','$TMPL_TODO'")"
  note "  full-DB diff lines: $(diffcount "$OUT/snap-Crpmixed-before.txt" "$OUT/snap-Crpmixed-after.txt")"
  diffsnap "$OUT/snap-Crpmixed-before.txt" "$OUT/snap-Crpmixed-after.txt"
  note "  VERDICT-C-rpmixed: does the ARM C law explain the landed order? (sent SA,TEMPLATE,SB)"
  exit 0
fi

# =============================================================== move-tmpl-area (put the template in an area)
# The baked project template is area-less, so it can't render in an AREA view.
# Move it into LAB-AREA-A (URL update-project list-id) to verify the maintainer's
# area-view render + characterize the area-view ordering axis. Disposable clone.
if [ "$CMD" = "move-tmpl-area" ]; then
  load_session
  note "################## move-tmpl-area — TMPL_PROJ -> LAB-AREA-A ##################"
  note "  before: $(one "$TMPL_PROJ")   area=$(area_of "$TMPL_PROJ")"
  snapshot_to "$OUT/snap-movearea-before.txt"
  gurl "things:///update-project?id=$TMPL_PROJ&auth-token=$TOKEN&list-id=$AA"
  snapshot_to "$OUT/snap-movearea-after.txt"
  note "  after:  $(one "$TMPL_PROJ")   area=$(area_of "$TMPL_PROJ")"
  note "  full-DB diff lines: $(diffcount "$OUT/snap-movearea-before.txt" "$OUT/snap-movearea-after.txt")"
  diffsnap "$OUT/snap-movearea-before.txt" "$OUT/snap-movearea-after.txt"
  exit 0
fi

# =============================================================== LP-seed (control later projects)
# Area-less someday + future-scheduled projects populate the Later Projects view.
if [ "$CMD" = "LP-seed" ]; then
  load_session
  note "################## LP-seed — control later/someday projects ##################"
  gurl "things:///add-project?title=LP-SOMEDAY1&when=someday"; sleep 1
  gurl "things:///add-project?title=LP-SOMEDAY2&when=someday"; sleep 1
  gurl "things:///add-project?title=LP-FUTURE1&when=2026-07-20"; sleep 1
  LPS1=$(uuid_of LP-SOMEDAY1 1); LPS2=$(uuid_of LP-SOMEDAY2 1); LPF1=$(uuid_of LP-FUTURE1 1)
  { echo "LPS1=$LPS1"; echo "LPS2=$LPS2"; echo "LPF1=$LPF1"; } >> "$SESSION"
  note "  LPS1=$LPS1 LPS2=$LPS2 LPF1=$LPF1"
  for u in "$LPS1" "$LPS2" "$LPF1"; do note "    $(one "$u")"; done
  note "  all area-less active projects (Later Projects candidates), ordered by todayIndex then index:"
  gq "SELECT title||' ti='||todayIndex||' ix='||\"index\"||' st='||start||' sd='||COALESCE(startDate,'-') FROM TMTask WHERE type=1 AND trashed=0 AND status=0 AND area IS NULL ORDER BY todayIndex, \"index\"" | sed 's/^/    /' | tee -a "$REPORT" >/dev/null
  exit 0
fi

# =============================================================== LP-shot (capture Later Projects / area views)
if [ "$CMD" = "LP-shot" ]; then
  load_session; vnc_init || exit 1
  ID="$2"; LBL="${3:-lp}"
  front "$ID"
  V capture "$OUT/screens/$LBL.png" && note "  captured screens/$LBL.png ($(ls -la "$OUT/screens/$LBL.png" | awk '{print $5}') bytes)" || note "  capture FAILED"
  exit 0
fi

# =============================================================== B-later (list "Later Projects" reorder specifier)
# B-later <label> <specifier-string> <comma-ids> — generic PID-watched reorder in
# an arbitrary specifier, full byte audit. Used to probe `list "Later Projects"`
# and `list id "later-projects"` with project-template + control later-project ids.
if [ "$CMD" = "B-later" ]; then
  load_session; source "$SESSION"
  LBL="$2"; SPEC="$3"; IDS="$4"
  note "################## B-LATER [$LBL] — reorder in ($SPEC) ids \"$IDS\" ##################"
  note "  area-less projects BEFORE (ti/ix):"
  gq "SELECT title||' ti='||todayIndex||' ix='||\"index\" FROM TMTask WHERE type=1 AND trashed=0 AND status=0 AND area IS NULL ORDER BY todayIndex, \"index\"" | sed 's/^/    /' | tee -a "$REPORT" >/dev/null
  snapshot_to "$OUT/snap-BL-$LBL-before.txt"
  reorder_wire "BL-$LBL" "$SPEC" "$IDS"
  snapshot_to "$OUT/snap-BL-$LBL-after.txt"
  note "  area-less projects AFTER (ti/ix):"
  gq "SELECT title||' ti='||todayIndex||' ix='||\"index\" FROM TMTask WHERE type=1 AND trashed=0 AND status=0 AND area IS NULL ORDER BY todayIndex, \"index\"" | sed 's/^/    /' | tee -a "$REPORT" >/dev/null
  note "  full-DB diff lines: $(diffcount "$OUT/snap-BL-$LBL-before.txt" "$OUT/snap-BL-$LBL-after.txt")"
  note "  --- changed rows ---"; diffsnap "$OUT/snap-BL-$LBL-before.txt" "$OUT/snap-BL-$LBL-after.txt"
  exit 0
fi

# =============================================================== snapshot / pulldb / teardown
if [ "$CMD" = "snapshot" ]; then
  load_session; LBL="${2:-snap}"; DST="$OUT/snap-$LBL.txt"; snapshot_to "$DST"
  note "snapshot -> $DST ($(wc -l < "$DST") lines)"; exit 0
fi
if [ "$CMD" = "teardown" ]; then
  note "teardown: $VM"
  pkill -f "tart run $VM" >/dev/null 2>&1 || true
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  tart list 2>/dev/null | sed 's/^/  /' | tee -a "$REPORT"
  exit 0
fi

echo "usage: $0 setup|caps|q <sql>|A-seed|A-shot <l> [pgdn]|A-drag sx sy tx ty <l>|A-read <l>|A-persist|B-single|B-multi|B-area|B-contam|repin|B-tomorrow|C-seed|C-trial <l> <ids>|C-rpmixed|snapshot <l>|teardown" >&2
exit 1
