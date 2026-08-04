#!/bin/bash
# TDRAG — the AX-dependent ordering residuals on golden-v2 (Things 3.22.12).
# The follow-up the AXVM1 layer (#388) was built to unblock. Write-up:
# docs/lab/tdrag-ax-residuals.md.
#
# GUI input is synthesized via vncdotool ($VNCDO) against the --vnc-experimental
# framebuffer (2048x1536), single-client (one vncdo per step). The golden bakes
# the AXVM1 Accessibility grant (sshd-keygen-wrapper auth_value=2), so System
# Events by-name menu driving AND VNC PostEvent HID both land.
#
# Arms:
#   TDRAG-1  template drag full write-set + persistence (vncdo drag of the
#            LAB-REPEAT-DAILY projection within its Upcoming day block).
#   TDRAG-2  forecast-row drag write-set (DLBNC-1b) + between-block (DLBNC-1c).
#   TDRAG-3  TMPLIDX REVISIT — headless template todayIndex wire probes
#            (private reorder specifiers w/ template ids; PID-watched, §1 risk).
#   TDRAG-4  reschedule-bounce mechanism (TMPLDL-1f) via the AX When picker.
#   TDRAG-5  ORD-18 pending byte probe (scheduled-row dated day bounce index
#            survival) — HEADLESS, cheap rider.
#   TDRAG-6  the §6 .ips crash capture (AppleScript schedule on a heading).
#
# Subcommands:
#   setup            clone golden-v2 + boot(--vnc-experimental) + airgap +
#                    clock-pin + warm + capture VNC_URL + resting bytes
#   caps             VNC capture + AX + HID smoke (de-risk before the drags)
#   arm5             TDRAG-5 ORD-18 (headless)
#   arm6             TDRAG-6 §6 schedule-on-heading crash + .ips capture
#   arm3             TDRAG-3 headless template todayIndex wire probes (PID-watched)
#   arm1-seed        TDRAG-1 seed 07-06 scheduled rows sharing the template block
#   arm1-shot <lbl>  open Upcoming frontmost + VNC capture -> host PNG
#   arm1-drag sx sy tx ty   perform ONE vncdo drag
#   arm1-read <lbl>  template-row full write-set + collateral snapshot
#   arm2-seed        TDRAG-2 seed forecast rows in an Upcoming block
#   arm2-shot/-drag/-read  as arm1
#   arm4             TDRAG-4 reschedule-bounce via the When picker (AX)
#   snapshot <lbl>   full normalized DB dump -> host (before/after diff)
#   pulldb <lbl>     copy the guest DB to the host
#   teardown         stop + delete the clone
#
# Requires $VNCDO (vncdotool venv) for the drag/capture arms — pass e.g.
#   VNCDO=/Volumes/Workspace/Projects/things-api/lab/vncvenv/bin/vncdo
# (the venv is gitignored, lives in the primary checkout).
#
# Conventions inherited from research-tmpldl-projdl.sh / research-dlbnc.sh:
#   offline COW clone, guest airgap, clock pinned BEFORE Things launches,
#   read-only guest SQLite, dates SEEDED via URL when=/deadline= (app packs the
#   int) — NEVER hand-pack a date integer. NEVER send URL when= to a repeating
#   template (§1 CRASH); TDRAG-3 sends only private-reorder wires (untested).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v2}"
PIN="${PIN:-070512002026}"           # 2026-07-05 12:00 (golden pinnedDate)
TODAY="${TODAY:-2026-07-05}"         # the pinned Today
TMRW="${TMRW:-2026-07-06}"           # LAB-REPEAT-DAILY's next projection (rt1_next=132805376)
DAY3="${DAY3:-2026-07-08}"           # a future deadline/schedule day (packs 132805632)
DAY4="${DAY4:-2026-07-09}"           # a second future day
AA="7Ck4hAXU36jyaBsy2Fkije"          # LAB-AREA-A
PROJ="933TCvzMgM3MLvpKPcjheC"        # LAB-PROJ-PLAIN (in LAB-AREA-A)
HEADING="5saDdJcodvWARN9Ct2nQsT"     # heading "Alpha" in LAB-PROJ-HEADINGS
TMPL_TODO="W3PZB9e7W6BEtKmEKP4deG"   # LAB-REPEAT-DAILY (repeating to-do template, daily)
TMPL_INST="11NNVsNH9gyTEAiG554nQ"    # its baked spawned instance
TMPL_PROJ="759yS6xe6d3a3h2dfVxoMZ"   # LAB-REPEAT-WEEKLY-PROJ (repeating project template)
VM="tdrag-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/screens"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[tdrag] $*" | tee -a "$REPORT"; }

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
one() { gq "SELECT title||' type='||type||' tIdx='||todayIndex||' idx='||\"index\"||' start='||start||' sb='||COALESCE(startBucket,'-')||' sd='||COALESCE(startDate,'-')||' tiRef='||COALESCE(todayIndexReferenceDate,'-')||' rem='||COALESCE(reminderTime,'-')||' dl='||COALESCE(deadline,'-')||' dlSup='||COALESCE(deadlineSuppressionDate,'-')||' h='||COALESCE(substr(heading,1,8),'-')||' p='||COALESCE(substr(project,1,8),'-')||' a='||COALESCE(substr(area,1,8),'-')||' cd='||CAST(creationDate AS INT)||' umd='||CAST(COALESCE(userModificationDate,0) AS INT) FROM TMTask WHERE uuid='$1'"; }
# rt1 recurrence state (rule hex + deadline bytes + pause/next) for a template.
rt1() { gq "SELECT 'paused='||COALESCE(rt1_instanceCreationPaused,'-')||' next='||COALESCE(rt1_nextInstanceStartDate,'-')||' t2dlOff='||COALESCE(t2_deadlineOffset,'-')||' ruleLen='||COALESCE(length(rt1_recurrenceRule),0)||' ruleHex='||COALESCE(substr(hex(rt1_recurrenceRule),1,80),'-') FROM TMTask WHERE uuid='$1'"; }
tidx_order() { gq "SELECT group_concat(title||':'||todayIndex,' ') FROM (SELECT title,todayIndex FROM TMTask WHERE title IN ($1) AND trashed=0 ORDER BY todayIndex)"; }
idx_order()  { gq "SELECT group_concat(title||':'||\"index\",' ') FROM (SELECT title,\"index\" FROM TMTask WHERE title IN ($1) AND trashed=0 ORDER BY \"index\")"; }

uuid_of() { local t="$1" typ="${2:-}" w u i; w="title='$t' AND trashed=0"; [ -n "$typ" ] && w="$w AND type=$typ"
  for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }

# ---------- full normalized DB dump (collateral / write-set diff) ----------
# Every mutable TMTask column, uuid-ordered, plus per-table row counts, so a
# host-side `diff before after` surfaces EVERY byte a drag writes.
snapshot_to() {
  local dst="$1"
  gq "SELECT uuid||'|t='||type||'|ti='||todayIndex||'|ix='||\"index\"||'|st='||start||'|sb='||COALESCE(startBucket,'')||'|sd='||COALESCE(startDate,'')||'|tir='||COALESCE(todayIndexReferenceDate,'')||'|rem='||COALESCE(reminderTime,'')||'|dl='||COALESCE(deadline,'')||'|dls='||COALESCE(deadlineSuppressionDate,'')||'|h='||COALESCE(heading,'')||'|p='||COALESCE(project,'')||'|a='||COALESCE(area,'')||'|tr='||trashed||'|status='||status||'|umd='||CAST(COALESCE(userModificationDate,0) AS INT)||'|rtp='||COALESCE(rt1_instanceCreationPaused,'')||'|rtn='||COALESCE(rt1_nextInstanceStartDate,'')||'|rtl='||COALESCE(length(rt1_recurrenceRule),0) FROM TMTask WHERE trashed=0 ORDER BY uuid" > "$dst"
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
# one vncdo invocation (single-client discipline). Pass raw vncdo CMDs.
V() { sleep 1; timeout 60 "$VNCDO" -s "$VSERVER" ${VPASS:+-p "$VPASS"} "$@" 2>>"$OUT/vnc.log"; }
# bring Things frontmost showing a list, then settle.
front() { lab_ssh "$IP" "open 'things:///show?id=$1'; sleep 2; osascript -e 'tell application \"Things3\" to activate'; sleep 3" </dev/null; }

# --------- PID watch + crash capture (the §6 P11e / §1 U12 detector shape) ----
gpid() { lab_ssh "$IP" 'pgrep -x Things3 || true' </dev/null | tr -d '[:space:]'; }
grelaunch() {
  lab_ssh "$IP" 'open -g -a Things3' </dev/null; local i p
  for i in $(seq 1 10); do p=$(gpid); [ -n "$p" ] && { sleep 4; return 0; }; sleep 2; done
  note "  WARN: Things did not relaunch"; return 1
}
newest_ips() { lab_ssh "$IP" 'ls -t ~/Library/Logs/DiagnosticReports/Things3-*.ips 2>/dev/null | head -1 || true' </dev/null | tr -d '[:space:]'; }
capture_ips() {
  local label="$1" ips0="$2" ips1; ips1=$(newest_ips)
  if [ -n "$ips1" ] && [ "$ips1" != "$ips0" ]; then
    local base; base=$(basename "$ips1")
    lab_scp "$LAB_SSH_USER@$IP:$ips1" "$OUT/screens/$base" </dev/null 2>/dev/null || true
    note "  [$label] .ips captured: $base"
    echo "$ips1"
  else
    note "  [$label] no fresh .ips flushed yet"
    echo ""
  fi
}
# ISOLATED risky write via a supplied driver (URL or AppleScript closure).
# $1=label $2='url:<u>' or 'as:<script>'. PID before/after + .ips + relaunch.
risky() {
  local label="$1" spec="$2" p0 p1 ips0
  p0=$(gpid); ips0=$(newest_ips)
  note "  [$label] pid-before=$p0"
  case "$spec" in
    url:*) note "  [$label] URL: ${spec#url:}"; lab_ssh "$IP" "open -g $(printf '%q' "${spec#url:}")" </dev/null ;;
    as:*)  note "  [$label] AS: ${spec#as:}";  gas "${spec#as:}" | sed 's/^/    /' | tee -a "$REPORT" >/dev/null ;;
  esac
  sleep 4
  p1=$(gpid)
  if [ -z "$p1" ] || { [ -n "$p0" ] && [ "$p1" != "$p0" ]; }; then
    note "  [$label] *** PROCESS DEATH *** pid-after=${p1:-<gone>} (was $p0) — CRASH (§1/§6 family)"
    capture_ips "$label" "$ips0" >/dev/null
    grelaunch
  else
    note "  [$label] alive (pid unchanged $p1) — no crash"
  fi
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
  note "  template next projection day (rt1_nextInstanceStartDate) = $(gq "SELECT rt1_nextInstanceStartDate FROM TMTask WHERE uuid='$TMPL_TODO'")"
  note "setup DONE — session in $SESSION"
  exit 0
fi

# =============================================================== caps
if [ "$CMD" = "caps" ]; then
  load_session; vnc_init || exit 1
  note "################## CAPS — de-risk: VNC capture + AX + HID ##################"
  note "  AX menu read (expect exit 0 / menu names): [$(gas "tell application \"System Events\" to tell process \"Things3\" to get name of every menu of menu bar 1" | head -c 120)]"
  note "  AX count windows (expect >=1): [$(gas "tell application \"System Events\" to tell process \"Things3\" to count windows")]"
  front "today"
  V capture "$OUT/screens/caps-today.png" && note "  VNC capture OK -> screens/caps-today.png ($(ls -la "$OUT/screens/caps-today.png" 2>/dev/null | awk '{print $5}') bytes)" || note "  VNC capture FAILED (see vnc.log)"
  exit 0
fi

# =============================================================== arm5 (ORD-18)
# TDRAG-5: does a SCHEDULED row's dated when= `day` bounce perturb its stored
# `index` bytes? Seed >=2 scheduled same-day rows w/ distinct index (in a
# project bucket), bounce the middle one (when=D+1 -> when=D), assert index
# byte-identical before/after on ALL of them. HEADLESS.
if [ "$CMD" = "arm5" ]; then
  load_session
  note "################## TDRAG-5 — ORD-18: scheduled day-bounce index-byte isolation ##################"
  note "  seeding 3 scheduled to-dos in LAB-PROJ-PLAIN, all dated $TMRW (distinct project-bucket index)"
  for t in OD1 OD2 OD3; do gurl "things:///add?title=$t&when=$TMRW&list-id=$PROJ"; sleep 1; done
  OD1=$(uuid_of OD1 0); OD2=$(uuid_of OD2 0); OD3=$(uuid_of OD3 0)
  note "  OD1: $(one "$OD1")"
  note "  OD2: $(one "$OD2")"
  note "  OD3: $(one "$OD3")"
  IX1B=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$OD1'")
  IX2B=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$OD2'")
  IX3B=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$OD3'")
  TI2B=$(gq "SELECT todayIndex FROM TMTask WHERE uuid='$OD2'")
  note "  index BEFORE: OD1=$IX1B OD2=$IX2B OD3=$IX3B ; OD2 todayIndex=$TI2B"
  note "  --- dated day-bounce on OD2: when=$DAY4 (stage) then when=$TMRW (restore) ---"
  gurl "things:///update?id=$OD2&auth-token=$TOKEN&when=$DAY4"
  note "  OD2 after stage (when=$DAY4): $(one "$OD2")"
  gurl "things:///update?id=$OD2&auth-token=$TOKEN&when=$TMRW"
  note "  OD2 after restore (when=$TMRW): $(one "$OD2")"
  IX1A=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$OD1'")
  IX2A=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$OD2'")
  IX3A=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$OD3'")
  TI2A=$(gq "SELECT todayIndex FROM TMTask WHERE uuid='$OD2'")
  note "  index AFTER:  OD1=$IX1A OD2=$IX2A OD3=$IX3A ; OD2 todayIndex=$TI2A"
  note "  VERDICT-ORD18: stored index byte-identical before/after on OD2 (and OD1/OD3)? => the day bounce is index-isolated (invariant holds at the byte level). Any OD2 index delta => the day bounce DOES perturb index."
  exit 0
fi

# =============================================================== arm5b (ORD-18, distinct-index)
# Can a SCHEDULED row even carry a DISTINCT (non-zero) index? Seed anytime rows
# in a project (distinct project-bucket index via native reorder), then schedule
# them (when=D). If the schedule PRESERVES a distinct index, bounce one and
# assert the index byte survives; if scheduling ZEROES index, the register's
# "distinct index" premise is unsatisfiable and the gap resolves that way.
if [ "$CMD" = "arm5b" ]; then
  load_session
  note "################## TDRAG-5b — ORD-18: can a scheduled row carry a DISTINCT index? ##################"
  note "  seeding OE1/OE2/OE3 ANYTIME to-dos in LAB-PROJ-PLAIN"
  for t in OE1 OE2 OE3; do gurl "things:///add?title=$t&when=anytime&list-id=$PROJ"; sleep 1; done
  OE1=$(uuid_of OE1 0); OE2=$(uuid_of OE2 0); OE3=$(uuid_of OE3 0)
  note "  anytime index: OE1=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$OE1'") OE2=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$OE2'") OE3=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$OE3'")"
  note "  native reorder in project (scrambled OE3,OE1,OE2) to force distinct index"
  gas "tell application \"Things3\" to _private_experimental_ reorder to dos in project id \"$PROJ\" with ids {\"$OE3\",\"$OE1\",\"$OE2\"}" | sed 's/^/    /' | tee -a "$REPORT" >/dev/null
  sleep 2
  note "  index after reorder (anytime): OE1=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$OE1'") OE2=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$OE2'") OE3=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$OE3'")"
  note "  now SCHEDULE all three to $TMRW (when=$TMRW)"
  for u in "$OE1" "$OE2" "$OE3"; do gurl "things:///update?id=$u&auth-token=$TOKEN&when=$TMRW"; done
  IXB=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$OE2'")
  note "  index after scheduling: OE1=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$OE1'") OE2=$IXB OE3=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$OE3'")"
  note "  OE2 now: $(one "$OE2")"
  note "  --- dated day-bounce on OE2: when=$DAY4 then when=$TMRW ---"
  gurl "things:///update?id=$OE2&auth-token=$TOKEN&when=$DAY4"
  gurl "things:///update?id=$OE2&auth-token=$TOKEN&when=$TMRW"
  IXA=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$OE2'")
  note "  OE2 index BEFORE bounce=$IXB  AFTER bounce=$IXA"
  note "  OE2 after: $(one "$OE2")"
  note "  VERDICT-ORD18b: (1) does scheduling PRESERVE a distinct index or zero it? (2) if distinct, does the day bounce leave the index byte identical?"
  exit 0
fi

# =============================================================== arm6 (§6 .ips)
# TDRAG-6: reproduce the §6 crash (AppleScript `schedule` on a HEADING row kills
# the app) and collect the .ips narrative for the Cultured Code report.
if [ "$CMD" = "arm6" ]; then
  load_session
  note "################## TDRAG-6 — §6 AppleScript schedule-on-heading crash + .ips ##################"
  note "  heading Alpha ($HEADING) resting: $(one "$HEADING")"
  lab_ssh "$IP" 'open -g -a Things3; sleep 3' </dev/null
  IPS0=$(newest_ips); P0=$(gpid)
  note "  pid-before=$P0 ; newest .ips before=${IPS0:-<none>}"
  note "  driving: schedule to do id <heading> for (current date)+1*days (expect -609 + process death)"
  gas "tell application \"Things3\" to schedule to do id \"$HEADING\" for ((current date) + 1 * days)" | sed 's/^/    /' | tee -a "$REPORT" >/dev/null
  sleep 5
  P1=$(gpid)
  note "  pid-after=${P1:-<gone>} (was $P0)"
  # poll DiagnosticReports up to ~60s for the flush
  note "  polling DiagnosticReports for the .ips flush (up to 60s)..."
  IPSNEW=""
  for i in $(seq 1 12); do
    cand=$(newest_ips)
    if [ -n "$cand" ] && [ "$cand" != "$IPS0" ]; then IPSNEW="$cand"; break; fi
    sleep 5
  done
  if [ -n "$IPSNEW" ]; then
    base=$(basename "$IPSNEW")
    lab_scp "$LAB_SSH_USER@$IP:$IPSNEW" "$OUT/screens/$base" </dev/null 2>/dev/null || true
    note "  .ips captured -> screens/$base"
    note "  --- narrative excerpt (exception type + faulting frame) ---"
    lab_ssh "$IP" "python3 - <<PYEOF
import json,sys
p='$IPSNEW'
raw=open(p).read()
parts=raw.split('\n',1)
try: body=json.loads(parts[1])
except Exception as e: print('parse-fail',e); sys.exit()
print('exception:', body.get('exception'))
print('termination:', body.get('termination'))
print('asi:', str(body.get('asi'))[:300])
for t in body.get('threads',[]):
    if t.get('triggered'):
        for f in t.get('frames',[])[:6]:
            print('  frame', f.get('imageIndex'), hex(f.get('imageOffset',0)), f.get('symbol',''))
        break
PYEOF" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
    grelaunch >/dev/null
    note "  heading row after relaunch (expect byte-identical — no corruption): $(one "$HEADING")"
  else
    note "  .ips did NOT flush within 60s — process death IS the crash signal (§6); skip gracefully"
    grelaunch >/dev/null
  fi
  note "  VERDICT-TDRAG6: §6 crash reproduced (process death) + .ips $( [ -n "$IPSNEW" ] && echo CAPTURED || echo not-flushed )"
  exit 0
fi

# =============================================================== arm3 (TMPLIDX)
# TDRAG-3: is a repeating template's todayIndex writable by ANY headless
# private-reorder specifier? Wire the template id into every reorder surface and
# byte-audit (todayIndex? crash? collateral rt1/start/startDate?). PID-watched.
if [ "$CMD" = "arm3" ]; then
  load_session
  note "################## TDRAG-3 — TMPLIDX revisit: headless template todayIndex wires ##################"
  note "  TMPL_TODO resting: $(one "$TMPL_TODO")"
  note "  TMPL_TODO rt1:     $(rt1 "$TMPL_TODO")"
  note "  seeding SC1/SC2 scheduled to-dos on $TMRW (mixed-wire fixtures)"
  for t in SC1 SC2; do gurl "things:///add?title=$t&when=$TMRW&list-id=$PROJ"; sleep 1; done
  SC1=$(uuid_of SC1 0); SC2=$(uuid_of SC2 0)
  note "  SC1: $(one "$SC1")"
  note "  SC2: $(one "$SC2")"

  # (a) single-template wires across every private reorder specifier
  note "  --- (a) template-only reorder wires (PID-watched; expect skip/no-op/crash/write) ---"
  for spec in 'list "Upcoming"' 'list "Today"' 'list "Tomorrow"' "project id \"$PROJ\"" "area id \"$AA\""; do
    lbl="tmpl-in:${spec}"
    note "  -- wire: reorder to dos in $spec with ids {template} --"
    note "     before: $(one "$TMPL_TODO")  rt1: $(rt1 "$TMPL_TODO")"
    risky "$lbl" "as:tell application \"Things3\" to _private_experimental_ reorder to dos in $spec with ids {\"$TMPL_TODO\"}"
    note "     after:  $(one "$TMPL_TODO")  rt1: $(rt1 "$TMPL_TODO")"
  done

  # (b) mixed wire: template interleaved with scheduled rows (Upcoming + project)
  note "  --- (b) MIXED wires (template + scheduled rows) ---"
  note "  -- wire: reorder to dos in list \"Upcoming\" with ids {SC2, template, SC1} --"
  note "     before SC1/SC2/tmpl todayIndex: $(tidx_order "'SC1','SC2','LAB-REPEAT-DAILY'")"
  risky "mixed-upcoming" "as:tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Upcoming\" with ids {\"$SC2\",\"$TMPL_TODO\",\"$SC1\"}"
  note "     after  SC1/SC2/tmpl todayIndex: $(tidx_order "'SC1','SC2','LAB-REPEAT-DAILY'")"
  note "     tmpl after: $(one "$TMPL_TODO")  rt1: $(rt1 "$TMPL_TODO")"
  note "  -- wire: reorder to dos in project id <P> with ids {SC2, template, SC1} --"
  risky "mixed-project" "as:tell application \"Things3\" to _private_experimental_ reorder to dos in project id \"$PROJ\" with ids {\"$SC2\",\"$TMPL_TODO\",\"$SC1\"}"
  note "     tmpl after: $(one "$TMPL_TODO")  rt1: $(rt1 "$TMPL_TODO")"
  note "     SC1/SC2 after (collateral): $(one "$SC1") ; $(one "$SC2")"

  TI_NOW=$(gq "SELECT todayIndex FROM TMTask WHERE uuid='$TMPL_TODO'")
  note "  --- template todayIndex now = $TI_NOW (resting was 0) ---"
  note "  VERDICT-TDRAG3: any specifier that writes template todayIndex CLEANLY (rt1/start/startDate untouched, no crash, no instance contamination) => template-cell PROTOCOL CANDIDATE (characterize, do NOT wire). All skip/no-op/crash => TMPLIDX stands headless-unreachable; the cell is GUI-only (per the maintainer prod drag + TDRAG-1)."
  exit 0
fi

# =============================================================== arm3b (TMPLIDX clean re-probe)
# arm3 found `reorder to dos in list "Upcoming" with ids {template}` WRITES the
# template todayIndex, but the sequence contaminated the template (the project-id
# wire reparented it). This is a CLEAN, focused re-probe on a PRISTINE template:
#  1. single-element `list "Upcoming"` write from rest (tIdx=0) — clean writer?
#  2. MID-BLOCK positioning: mixed wire {SA, template, SB} — lands BETWEEN them?
#  3. project-id reparent HAZARD confirm.
#  4. instance-spawn contamination (TMPLDL-1d): advance the series, check spawn.
if [ "$CMD" = "arm3b" ]; then
  load_session
  note "################## TDRAG-3b — TMPLIDX clean re-probe (pristine template) ##################"
  note "  TMPL_TODO resting: $(one "$TMPL_TODO")   rt1: $(rt1 "$TMPL_TODO")"
  note "  seeding SA/SB scheduled to-dos on $TMRW (loose Upcoming block members)"
  for t in SA SB; do gurl "things:///add?title=$t&when=$TMRW"; sleep 1; done
  SA=$(uuid_of SA 0); SB=$(uuid_of SB 0)
  note "  SA: $(one "$SA")"
  note "  SB: $(one "$SB")"
  note "  block todayIndex order (ascending): $(tidx_order "'SA','SB'")"

  note "  --- (1) single-element list \"Upcoming\" write on the PRISTINE template ---"
  note "     tmpl before: $(one "$TMPL_TODO")"
  risky "1-upcoming-clean" "as:tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Upcoming\" with ids {\"$TMPL_TODO\"}"
  note "     tmpl after:  $(one "$TMPL_TODO")"
  note "     tmpl rt1 after: $(rt1 "$TMPL_TODO")"
  note "     VERDICT-1: todayIndex written (front-insert below SA/SB min)? rt1/start/startDate/tiRef/index/umd byte-identical? p stays NULL (no reparent)?"
  note "     block order now: $(tidx_order "'SA','SB','LAB-REPEAT-DAILY'")"

  note "  --- (2) MID-BLOCK positioning: reorder {SA, template, SB} in list \"Upcoming\" ---"
  note "     want ascending todayIndex = SA < template < SB (template MID)"
  note "     before: $(tidx_order "'SA','SB','LAB-REPEAT-DAILY'")"
  risky "2-midblock" "as:tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Upcoming\" with ids {\"$SA\",\"$TMPL_TODO\",\"$SB\"}"
  note "     after:  $(tidx_order "'SA','SB','LAB-REPEAT-DAILY'")"
  note "     tmpl after: $(one "$TMPL_TODO")"
  note "     VERDICT-2: does the template land BETWEEN SA and SB (arbitrary-position control) or only front-insert? rt1/start/startDate byte-identical? p still NULL?"

  note "  --- (3) project-id reparent HAZARD confirm ---"
  note "     tmpl before: p=$(gq "SELECT COALESCE(substr(project,1,8),'NULL') FROM TMTask WHERE uuid='$TMPL_TODO'") umd=$(gq "SELECT CAST(userModificationDate AS INT) FROM TMTask WHERE uuid='$TMPL_TODO'")"
  risky "3-projid-reparent" "as:tell application \"Things3\" to _private_experimental_ reorder to dos in project id \"$PROJ\" with ids {\"$TMPL_TODO\"}"
  note "     tmpl after:  $(one "$TMPL_TODO")"
  note "     tmpl rt1 after: $(rt1 "$TMPL_TODO")"
  note "     VERDICT-3: does project-id reorder REPARENT the template (project NULL->P) + bump umd = containment HAZARD? todayIndex touched?"

  note "  --- (4) instance-spawn contamination (TMPLDL-1d): advance the series ---"
  note "     pristine baked instance $TMPL_INST: $(one "$TMPL_INST")"
  note "     complete current instance to advance the daily series"
  note "     complete result: [$(gas "tell application \"Things3\" to set status of to do id \"$TMPL_INST\" to completed")]"
  sleep 6
  NEWINST=$(gq "SELECT uuid FROM TMTask WHERE rt1_repeatingTemplate='$TMPL_TODO' AND uuid<>'$TMPL_INST' AND trashed=0 ORDER BY creationDate DESC LIMIT 1")
  if [ -n "$NEWINST" ]; then
    note "     NEW spawned instance $NEWINST: $(one "$NEWINST")"
    note "     VERDICT-4: does the new instance carry a NON-ZERO todayIndex (=> the template todayIndex write CONTAMINATED the spawn) or tIdx=0 (clean spawn)?"
  else
    note "     no new instance spawned headless (spawn is app-tick driven, offline) — contamination check INCONCLUSIVE (flag)"
  fi
  note "  VERDICT-TDRAG3b: if list \"Upcoming\" reorder writes+positions the template todayIndex CLEANLY (mid-block control, rt1/start/startDate/umd untouched, NO reparent, NO instance contamination) => TEMPLATE-CELL PROTOCOL CANDIDATE (characterize per novel-paths, do NOT wire). project-id is a reparent hazard (never use for a template)."
  exit 0
fi

# =============================================================== arm1 (template drag)
if [ "$CMD" = "arm1-seed" ]; then
  load_session
  note "################## TDRAG-1 — template drag: seed the $TMRW block ##################"
  note "  seeding TB1..TB4 scheduled to-dos on $TMRW (loose) to share the template's projection block"
  for t in TB1 TB2 TB3 TB4; do gurl "things:///add?title=$t&when=$TMRW"; sleep 1; done
  for v in TB1 TB2 TB3 TB4; do u=$(uuid_of "$v" 0); echo "$v=$u" >> "$SESSION"; note "  $v: $(one "$u")"; done
  note "  TMPL_TODO (drag target): $(one "$TMPL_TODO")   rt1: $(rt1 "$TMPL_TODO")"
  note "  block todayIndex order (ascending): $(tidx_order "'TB1','TB2','TB3','TB4'")"
  note "  seed DONE — now: arm1-shot before ; inspect PNG ; arm1-drag sx sy tx ty ; arm1-read after"
  exit 0
fi

if [ "$CMD" = "arm1-shot" ] || [ "$CMD" = "arm2-shot" ]; then
  load_session; vnc_init || exit 1
  LBL="${2:-shot}"
  front "upcoming"
  V capture "$OUT/screens/$LBL.png" && note "  captured screens/$LBL.png ($(ls -la "$OUT/screens/$LBL.png" | awk '{print $5}') bytes)" || note "  capture FAILED"
  exit 0
fi

if [ "$CMD" = "arm1-drag" ] || [ "$CMD" = "arm2-drag" ]; then
  load_session; vnc_init || exit 1
  SX="$2"; SY="$3"; TX="$4"; TY="$5"
  note "  DRAG ($SX,$SY) -> ($TX,$TY)"
  # ONE session, EXPLICIT move waypoints (NOT vncdo's `drag` command — that
  # command triggers an early twisted reactor-stop on py3.14 that drops the
  # trailing mouseup, so the row lifts but never commits). `mousedown 1` sets
  # the button mask; each subsequent `move` re-sends it (button stays held);
  # `mouseup 1` clears it. Interpolated waypoints make it a real drag gesture.
  # Trailing `capture` forces a server round-trip that flushes the release.
  mid=$(( (SY + TY) / 2 ))
  V move "$SX" "$SY" pause 0.7 mousedown 1 pause 0.8 \
    move "$SX" $((SY-12)) pause 0.35 \
    move "$TX" "$mid" pause 0.35 \
    move "$TX" $((TY-3)) pause 0.35 \
    move "$TX" "$TY" pause 0.9 \
    mouseup 1 pause 0.7 capture "$OUT/screens/${6:-drag}-drop.png"
  sleep 3
  note "  drag issued (see vnc.log for transport)"
  exit 0
fi

if [ "$CMD" = "arm1-persist" ]; then
  load_session
  note "  --- TDRAG-1 PERSISTENCE: quit + relaunch, does the block re-render the dragged order? ---"
  note "  before quit: $(one "$TMPL_TODO")"
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 4' </dev/null
  lab_ssh "$IP" 'open -g -a Things3; sleep 10' </dev/null
  note "  after relaunch: $(one "$TMPL_TODO")"
  note "  block todayIndex order after relaunch: $(tidx_order "'TB1','TB2','TB3','TB4','LAB-REPEAT-DAILY'")"
  note "  VERDICT-PERSIST: template todayIndex survives quit/relaunch (byte-identical) AND the block re-renders in dragged order => the drag persists to DB and the app re-reads it."
  exit 0
fi

if [ "$CMD" = "arm1-read" ]; then
  load_session
  LBL="${2:-after}"
  note "  --- TDRAG-1 read ($LBL) ---"
  note "  TMPL_TODO: $(one "$TMPL_TODO")"
  note "  TMPL_TODO rt1: $(rt1 "$TMPL_TODO")"
  note "  block todayIndex order: $(tidx_order "'TB1','TB2','TB3','TB4','LAB-REPEAT-DAILY'")"
  exit 0
fi

# =============================================================== arm2 (forecast drag)
if [ "$CMD" = "arm2-seed" ]; then
  load_session
  note "################## TDRAG-2 — forecast-row drag: seed a deadline-forecast block ##################"
  note "  seeding FB1..FB4 someday+deadline($DAY3) to-dos in LAB-AREA-A (forecast block on $DAY3)"
  for t in FB1 FB2 FB3 FB4; do gurl "things:///add?title=$t&when=someday&deadline=$DAY3&list-id=$AA"; sleep 1; done
  for v in FB1 FB2 FB3 FB4; do u=$(uuid_of "$v" 0); echo "$v=$u" >> "$SESSION"; note "  $v: $(one "$u")"; done
  note "  seeding XB1 someday+deadline($DAY4) (a DIFFERENT forecast block, for the between-block drag)"
  gurl "things:///add?title=XB1&when=someday&deadline=$DAY4&list-id=$AA"; sleep 1
  XB1=$(uuid_of XB1 0); echo "XB1=$XB1" >> "$SESSION"; note "  XB1: $(one "$XB1")"
  note "  forecast block ($DAY3) todayIndex order: $(tidx_order "'FB1','FB2','FB3','FB4'")"
  exit 0
fi

if [ "$CMD" = "arm2-read" ]; then
  load_session
  note "  --- TDRAG-2 read ---"
  for v in FB1 FB2 FB3 FB4 XB1; do eval "u=\${$v:-}"; [ -n "$u" ] && note "  $v: $(one "$u")"; done
  note "  forecast block todayIndex order: $(tidx_order "'FB1','FB2','FB3','FB4'")"
  exit 0
fi

# =============================================================== arm4 (reschedule-bounce)
# TDRAG-4: GUI-reschedule the template's next occurrence via the When picker
# (Cmd-S). byte-capture what it writes + test the away-and-back bounce.
# Mechanism characterization only (parked ui-vector, not a wiring candidate).
if [ "$CMD" = "arm4" ]; then
  load_session; vnc_init || exit 1
  note "################## TDRAG-4 — reschedule-bounce (TMPLDL-1f) via the When picker ##################"
  note "  TMPL_TODO before: $(one "$TMPL_TODO")   rt1: $(rt1 "$TMPL_TODO")"
  note "  next projection day = $(gq "SELECT rt1_nextInstanceStartDate FROM TMTask WHERE uuid='$TMPL_TODO'")"
  front "$TMPL_TODO"
  note "  Items menu items (for the When entry name): [$(gas "tell application \"System Events\" to tell process \"Things3\" to get name of menu items of menu \"Items\" of menu bar item \"Items\" of menu bar 1" | head -c 300)]"
  V capture "$OUT/screens/arm4-selected.png" && note "  captured arm4-selected.png"
  note "  (interactive: drive the When picker via arm4-when <ISO> once the menu name is known)"
  exit 0
fi

if [ "$CMD" = "arm4-drive" ]; then
  load_session; vnc_init || exit 1
  WHEN="$2"          # natural-language date to type into the When popover
  note "  --- TDRAG-4 reschedule the template's occurrence to '$WHEN' (Items > When...) ---"
  note "  before: $(one "$TMPL_TODO")"
  note "  before rt1: $(rt1 "$TMPL_TODO")"
  note "  before next-projection = $(gq "SELECT rt1_nextInstanceStartDate FROM TMTask WHERE uuid='$TMPL_TODO'")"
  lab_ssh "$IP" "open 'things:///show?id=$TMPL_TODO'; sleep 2; osascript -e 'tell application \"Things3\" to activate'; sleep 2" </dev/null
  note "  clicking Items > When... via AX: [$(gas "tell application \"System Events\" to tell process \"Things3\" to click menu item \"When…\" of menu \"Items\" of menu bar item \"Items\" of menu bar 1")]"
  sleep 2
  V type "$WHEN" pause 1.0 key "enter" pause 0.6 capture "$OUT/screens/arm4-when-popover.png"
  sleep 3
  note "  after:  $(one "$TMPL_TODO")"
  note "  after rt1: $(rt1 "$TMPL_TODO")"
  note "  after next-projection = $(gq "SELECT rt1_nextInstanceStartDate FROM TMTask WHERE uuid='$TMPL_TODO'")"
  note "  VERDICT-4-leg: what did the reschedule write? rt1 rule bytes? startDate stamp? todayIndex reassign? next-projection change?"
  exit 0
fi

if [ "$CMD" = "arm4-when" ]; then
  load_session; vnc_init || exit 1
  WHEN="$2"   # ISO date to type into the When picker
  note "  --- TDRAG-4 reschedule to $WHEN ---"
  note "  before: $(one "$TMPL_TODO")  rt1: $(rt1 "$TMPL_TODO")"
  V key "super-s" pause 1.0 type "$WHEN" pause 0.8 key "enter"
  sleep 3
  note "  after:  $(one "$TMPL_TODO")  rt1: $(rt1 "$TMPL_TODO")"
  note "  next projection day now = $(gq "SELECT rt1_nextInstanceStartDate FROM TMTask WHERE uuid='$TMPL_TODO'")"
  exit 0
fi

# =============================================================== snapshot / pulldb
if [ "$CMD" = "snapshot" ]; then
  load_session
  LBL="${2:-snap}"; DST="$OUT/snap-$LBL.txt"
  snapshot_to "$DST"
  note "snapshot -> $DST ($(wc -l < "$DST") lines)"
  exit 0
fi

if [ "$CMD" = "pulldb" ]; then
  load_session
  LABEL="${2:-snapshot}"; DST="$OUT/db-$LABEL.sqlite"
  RP=$(lab_ssh "$IP" 'echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite' </dev/null)
  lab_scp "$IP:$RP" "$DST"
  note "pulled -> $DST"
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

echo "usage: $0 setup|caps|arm5|arm6|arm3|arm1-seed|arm1-shot <l>|arm1-drag sx sy tx ty|arm1-read <l>|arm2-seed|arm2-shot <l>|arm2-drag ...|arm2-read|arm4|arm4-when <iso>|snapshot <l>|pulldb <l>|teardown" >&2
exit 1
