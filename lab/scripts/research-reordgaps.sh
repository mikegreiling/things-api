#!/bin/bash
# REORDGAPS — five ordering probes closing the remaining reorder unknowns in
# ONE Tart-clone campaign (offline, pinned clock; ordering is local, no cloud
# account needed). Full write-up + verdict table: docs/lab/reordgaps-results.md.
#
# Subcommand-driven so the session survives host-side iteration; ONE disposable
# clone `reordgaps-lab` lives across phases (explicit teardown):
#
#   research-reordgaps.sh setup       clone+boot+airgap+clock-pin+seed (+AX grant &
#                                     e2e bundle when $VNCDO is set, for the gui phase)
#   research-reordgaps.sh headless    the no-Accessibility arms (URL / AppleScript):
#                                     HEADORD-a/b/c · DAYORD-b · ANYBNC · SOMEORD-a/b · TMPLORD-b
#   research-reordgaps.sh gui         the GUI-drag ORACLE arms (need AX grant + $VNCDO):
#                                     HEADORD-d · DAYORD-a · SOMEORD-c · TMPLORD-a
#   research-reordgaps.sh teardown    stop + delete the clone
#
# The FIVE probe ids and their arms (see the task brief / probe-backlog):
#   HEADORD  within-heading child order (the O06 gap)
#            a reconfirm O06 (project specifier RIPS headed children: heading->NULL)
#            b heading AS the container specifier (unexplored: heading uuid/object as the list)
#            c bounce a headed anytime to-do someday->anytime: does the heading FK survive?
#            d GUI oracle: drag two to-dos within a heading, diff which column encodes order
#   DAYORD   scheduled day-bucket order
#            a GUI oracle: drag within one future Upcoming day, confirm todayIndex
#            b headless day-scoped reorder spelling hunt (list "Upcoming"/"Tomorrow"/date-shaped/project)
#   ANYBNC   area-less loose anytime to-do via someday->anytime bounce (queued spec, exactly)
#   SOMEORD  someday buckets INSIDE containers
#            a area specifier reorder of that area's SOMEDAY to-dos (DESTRUCTIVE-RISK: start-field)
#            b project specifier with someday children
#            c GUI oracle: within-container someday order (same `index` column?)
#   TMPLORD  repeating templates within a container's repeating bucket
#            a GUI: are templates drag-sortable in the resting bucket at all (oddities 9e)?
#            b if sortable, which column + any headless spelling
#
# Conventions inherited from research-p7.sh / research-anyord.sh / research-axdrag2.sh:
#   * offline COW clone, guest-side airgap (delete default route), clock pinned to
#     the golden's 2026-07-05T12:00 BEFORE Things launches, read-only guest SQLite.
#   * the `with ids` parameter is a COMMA-SEPARATED STRING, not an AppleScript list.
#   * heading rows (type=2) and repeating templates are addressed BY id (oddity 5e):
#     `to do id "<uuid>"` resolves them though list enumeration hides them.
#   * headings are only creatable headlessly via TJSON new-project-with-heading (HX0);
#     to-do items following a heading item in the project's `items` array nest under it.
#   * GUI drags are CGEvent mouse-synthesis over SSH (no vncdo) — vncdo is needed ONLY
#     for the one-time Accessibility TCC grant (AXVM1 rung-b). AXEnhancedUserInterface
#     stays false; --vnc-experimental single client, one vncdo per step, sleeps between.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v1}"
PIN="${PIN:-070512002026}"          # 2026-07-05 12:00 (golden pinnedDate)
VNCDO="${VNCDO:-}"                    # vncdotool venv — only for the AX grant
VM="reordgaps-lab"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/screens"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[reordgaps] $*" | tee -a "$REPORT"; }

CMD="${1:-}"

# --------------------------------------------------------------- guest SQLite
GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

# per-session helpers (need $IP)
gq()  { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gsql(){ lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" </dev/null; }
gas() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" </dev/null || true; }
gurl(){ lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; sleep 2; }
# resolve a freshly-created title -> uuid (retry; optional type filter)
uuid_of() { local t="$1" typ="${2:-}" w u i; w="title='$t' AND trashed=0"; [ -n "$typ" ] && w="$w AND type=$typ"
  for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }
areaid() { gq "SELECT uuid FROM TMArea WHERE title='$1'"; }
# private reorder command (comma-separated ids string)
reord()  { gas "tell application \"Things3\" to _private_experimental_ reorder to dos in $1 with ids \"$2\""; sleep 2; }
# full within-container state dump for a title glob: index/todayIndex/start/startDate/heading/project/area
dumpstate() { gq "SELECT title||' idx='||\"index\"||' tIdx='||todayIndex||' start='||start||' sd='||COALESCE(substr(startDate,1,10),'-')||' h='||COALESCE(substr(heading,1,8),'-')||' p='||COALESCE(substr(project,1,8),'-')||' a='||COALESCE(substr(area,1,8),'-') FROM TMTask WHERE title LIKE '$1' ORDER BY \"index\""; }
globalmin() { gq "SELECT MIN(\"index\") FROM TMTask WHERE trashed=0"; }

# TJSON new-project-with-heading-and-headed-children (HX0 pattern). $1=json payload
tjson() {
  local url
  url=$(lab_ssh "$IP" "python3 -c 'import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))' $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null)
  lab_ssh "$IP" "open -g $(printf '%q' "$url")" </dev/null; sleep 3
}

# ==================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "cloning $GOLDEN -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
  note "ssh up at $IP"
  VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo route -n delete -inet6 default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"
  echo "IP=$IP" > "$SESSION"; echo "VNC_URL=$VNC_URL" >> "$SESSION"

  note "warm-up: launch Things, quit, relaunch (steady state on the pinned date)"
  lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3' </dev/null
  lab_ssh "$IP" 'open -g -a Things3; sleep 8' </dev/null

  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  echo "TOKEN=$TOKEN" >> "$SESSION"
  note "auth token in hand (${#TOKEN} chars)"
  AA=$(areaid LAB-AREA-A); AB=$(areaid LAB-AREA-B)
  note "areas: A=$AA B=$AB"

  # ---- SEED --------------------------------------------------------------
  # HEADORD: a project with ONE heading + 3 headed anytime children (HX0 shape).
  note "seed HEADORD: project RG-HEAD with heading H1 + HC1/HC2/HC3 (headed, anytime)"
  tjson '[{"type":"project","attributes":{"title":"RG-HEAD","items":[{"type":"heading","attributes":{"title":"H1"}},{"type":"to-do","attributes":{"title":"HC1"}},{"type":"to-do","attributes":{"title":"HC2"}},{"type":"to-do","attributes":{"title":"HC3"}}]}}]'
  # DAYORD: a project with 3 children all scheduled the SAME future day (07-10),
  # plus 3 loose to-dos scheduled 07-10, plus 3 loose scheduled 07-06 (Tomorrow).
  note "seed DAYORD: DP-1/2/3 scheduled 2026-07-10 (loose); RG-DAYPROJ children DPC1..3 @07-10; TM1/2/3 @07-06"
  for t in DP-1 DP-2 DP-3; do gurl "things:///add?title=$t&when=2026-07-10"; done
  for t in TM-1 TM-2 TM-3; do gurl "things:///add?title=$t&when=2026-07-06"; done
  tjson '[{"type":"project","attributes":{"title":"RG-DAYPROJ","items":[{"type":"to-do","attributes":{"title":"DPC1","when":"2026-07-10"}},{"type":"to-do","attributes":{"title":"DPC2","when":"2026-07-10"}},{"type":"to-do","attributes":{"title":"DPC3","when":"2026-07-10"}}]}}]'
  # ANYBNC: 3 area-less loose anytime to-dos.
  note "seed ANYBNC: AB-1/2/3 area-less loose anytime"
  for t in AB-1 AB-2 AB-3; do gurl "things:///add?title=$t&when=anytime"; done
  # SOMEORD-a: 3 someday to-dos in LAB-AREA-A (expendable — destructive-risk arm).
  note "seed SOMEORD-a: SA-1/2/3 someday to-dos in LAB-AREA-A"
  for t in SA-1 SA-2 SA-3; do gurl "things:///add?title=$t&when=someday&list-id=$AA"; done
  # SOMEORD-b: a project with 3 someday children.
  note "seed SOMEORD-b: project RG-SOMEPROJ with someday children PS1/PS2/PS3"
  tjson '[{"type":"project","attributes":{"title":"RG-SOMEPROJ","items":[{"type":"to-do","attributes":{"title":"PS1","when":"someday"}},{"type":"to-do","attributes":{"title":"PS2","when":"someday"}},{"type":"to-do","attributes":{"title":"PS3","when":"someday"}}]}}]'
  sleep 2

  note "--- seed verification (heading FK, start fields, day scheduling) ---"
  note "RG-HEAD children (expect h=<H1 uuid>, start=1): $(dumpstate 'HC%' | tr '\n' ' ')"
  note "H1 heading row: $(gq "SELECT title||' type='||type||' uuid='||substr(uuid,1,8) FROM TMTask WHERE title='H1'")"
  note "DAYORD loose @07-10: $(dumpstate 'DP-%' | tr '\n' ' ')"
  note "DAYORD proj children @07-10: $(dumpstate 'DPC%' | tr '\n' ' ')"
  note "Tomorrow @07-06: $(dumpstate 'TM-%' | tr '\n' ' ')"
  note "ANYBNC area-less anytime (expect a=-, start=1): $(dumpstate 'AB-%' | tr '\n' ' ')"
  note "SOMEORD-a area someday (expect a=<A>, start=2): $(dumpstate 'SA-%' | tr '\n' ' ')"
  note "SOMEORD-b proj someday (expect start=2): $(dumpstate 'PS%' | tr '\n' ' ')"
  note "existing golden repeating templates: $(gq "SELECT title||' project='||COALESCE(substr(project,1,8),'-')||' heading='||COALESCE(substr(heading,1,8),'-') FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL" | tr '\n' ' ')"

  # ---- optional AX grant + e2e bundle for the gui phase -------------------
  if [ -n "$VNCDO" ] && [ -x "$VNCDO" ] && [ -n "$VNC_URL" ]; then
    note "granting Accessibility (AXVM1 rung-b) for the gui phase"
    HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
    PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
    V() { sleep 2; timeout 40 "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }
    lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
    lab_ssh "$IP" "open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'" </dev/null; sleep 10
    V capture "$OUT/screens/00-ax-pane.png"
    V move 1642 332 click 1; sleep 3
    V move 1017 870 click 1 pause 0.5 type admin pause 0.5 move 1017 963 click 1; sleep 3
    GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
    note "  AX grant auth_value=$GRANT (2=granted)"
    echo "AX_GRANTED=$([ "$GRANT" = 2 ] && echo 1 || echo 0)" >> "$SESSION"
    # ship the guest e2e bundle so the gui phase can seed repeating templates
    # via the production make-repeating (ui vector) — TMPLORD needs >=2 templates
    # in one container and there is NO headless template-create.
    note "building + shipping the guest e2e bundle (for TMPLORD template seeding via ui-vector make-repeating)"
    npm run build >/dev/null 2>&1 || note "  WARN: build failed — gui TMPLORD seeding will be skipped"
    if [ -d dist ]; then
      NODE_BIN=$(node -e 'console.log(process.execPath)')
      lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
      scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
      scpO "$NODE_BIN" "$LAB_SSH_USER@$IP:/Users/$LAB_SSH_USER/things-lab/bin/node"
      scpO -r dist "$LAB_SSH_USER@$IP:/Users/$LAB_SSH_USER/things-lab/things-api/dist"
      scpO -r node_modules/commander "$LAB_SSH_USER@$IP:/Users/$LAB_SSH_USER/things-lab/things-api/node_modules/commander"
      scpO package.json "$LAB_SSH_USER@$IP:/Users/$LAB_SSH_USER/things-lab/things-api/package.json"
      lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
      lab_ssh "$IP" '~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js config set ui-enabled true' </dev/null 2>&1 | tee -a "$REPORT"
    fi
    lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null || true
  else
    note "NOTE: \$VNCDO unset/missing — Accessibility NOT granted; the gui phase (HEADORD-d, DAYORD-a, SOMEORD-c, TMPLORD-a) will be SKIPPED. Headless arms are unaffected."
    echo "AX_GRANTED=0" >> "$SESSION"
  fi
  note "setup DONE — session in $SESSION"
  exit 0
fi

# ================================================================= headless
if [ "$CMD" = "headless" ]; then
  load_session
  note "################################ HEADLESS ARMS ################################"
  AA=$(areaid LAB-AREA-A)
  PHEAD=$(gq "SELECT uuid FROM TMTask WHERE title='RG-HEAD' AND type=1"); H1=$(gq "SELECT uuid FROM TMTask WHERE title='H1' AND type=2")
  HC1=$(uuid_of HC1); HC2=$(uuid_of HC2); HC3=$(uuid_of HC3)

  note "########## HEADORD-a — reconfirm O06: project specifier RIPS headed children ##########"
  note "  before: $(dumpstate 'HC%' | tr '\n' ' ')"
  reord "project id \"$PHEAD\"" "$HC3,$HC2,$HC1"
  note "  after  (O06 predicts heading h=-, i.e. NULL): $(dumpstate 'HC%' | tr '\n' ' ')"

  note "########## HEADORD-b — heading AS the container specifier (UNEXPLORED) ##########"
  # Re-seed clean headed children (HEADORD-a may have de-headed them). Fresh project.
  tjson '[{"type":"project","attributes":{"title":"RG-HEAD2","items":[{"type":"heading","attributes":{"title":"H2"}},{"type":"to-do","attributes":{"title":"HB1"}},{"type":"to-do","attributes":{"title":"HB2"}},{"type":"to-do","attributes":{"title":"HB3"}}]}}]'
  sleep 2
  H2=$(gq "SELECT uuid FROM TMTask WHERE title='H2' AND type=2"); HB1=$(uuid_of HB1); HB2=$(uuid_of HB2); HB3=$(uuid_of HB3)
  note "  before: $(dumpstate 'HB%' | tr '\n' ' ')"
  note "  -- b1: reorder to dos in to do id <H2> (heading addressed as a to do) --"
  note "     result: $(reord "to do id \"$H2\"" "$HB3,$HB2,$HB1")"
  note "     after : $(dumpstate 'HB%' | tr '\n' ' ')"
  note "  -- b2: reorder to dos in list id <H2> --"
  note "     result: $(reord "list id \"$H2\"" "$HB3,$HB2,$HB1")"
  note "     after : $(dumpstate 'HB%' | tr '\n' ' ')"
  note "  -- b3: reorder to dos in heading id <H2> (bare heading class term) --"
  note "     result: $(reord "heading id \"$H2\"" "$HB3,$HB2,$HB1")"
  note "     after : $(dumpstate 'HB%' | tr '\n' ' ')"
  note "  INTERPRET: a clean index re-rank with heading FK PRESERVED = within-heading order is automatable (breakthrough). Error/no-op = the specifier class is list/project only (expected)."

  note "########## HEADORD-c — bounce a headed anytime to-do someday->anytime ##########"
  tjson '[{"type":"project","attributes":{"title":"RG-HEAD3","items":[{"type":"heading","attributes":{"title":"H3"}},{"type":"to-do","attributes":{"title":"HD1"}},{"type":"to-do","attributes":{"title":"HD2"}}]}}]'
  sleep 2
  HD1=$(uuid_of HD1)
  note "  before (full state): $(dumpstate 'HD%' | tr '\n' ' ')"
  gurl "things:///update?id=$HD1&auth-token=$TOKEN&when=someday"
  note "  after someday leg: $(dumpstate 'HD%' | tr '\n' ' ')"
  gurl "things:///update?id=$HD1&auth-token=$TOKEN&when=anytime"
  note "  after anytime leg: $(dumpstate 'HD%' | tr '\n' ' ')"
  note "  INTERPRET: heading h= still <H3>? -> FK survived; front-insert index below the heading-group min = usable within-heading placement. h=- -> bounce is DESTRUCTIVE of heading membership (drops to unheaded block), useless for within-heading order."

  note "########## DAYORD-b — headless day-scoped reorder spelling hunt ##########"
  DP1=$(uuid_of DP-1); DP2=$(uuid_of DP-2); DP3=$(uuid_of DP-3)
  TM1=$(uuid_of TM-1); TM2=$(uuid_of TM-2); TM3=$(uuid_of TM-3)
  DAYPROJ=$(gq "SELECT uuid FROM TMTask WHERE title='RG-DAYPROJ' AND type=1")
  DPC1=$(uuid_of DPC1); DPC2=$(uuid_of DPC2); DPC3=$(uuid_of DPC3)
  note "  -- b1: list \"Upcoming\" with the 07-10 loose items --"
  note "     result: $(reord "list \"Upcoming\"" "$DP3,$DP1,$DP2")"
  note "     after (watch index vs todayIndex): $(dumpstate 'DP-%' | tr '\n' ' ')"
  note "  -- b2: list \"Tomorrow\" with the 07-06 items (HEADCERT reconfirm: expect todayIndex) --"
  note "     result: $(reord "list \"Tomorrow\"" "$TM3,$TM1,$TM2")"
  note "     after: $(dumpstate 'TM-%' | tr '\n' ' ')"
  note "  -- b3: date-shaped list specifiers (expect error/no such list) --"
  note "     list \"2026-07-10\": $(reord "list \"2026-07-10\"" "$DP3,$DP1,$DP2")"
  note "     list \"July 10, 2026\": $(reord "list \"July 10, 2026\"" "$DP3,$DP1,$DP2")"
  note "  -- b4: project specifier with SAME-DAY children (writes index, not todayIndex?) --"
  note "     result: $(reord "project id \"$DAYPROJ\"" "$DPC3,$DPC1,$DPC2")"
  note "     after (index re-rank but todayIndex/day-order UNCHANGED?): $(dumpstate 'DPC%' | tr '\n' ' ')"
  note "  VERDICT feeds DAYORD: only list \"Tomorrow\" (next-day, todayIndex) is a headless day spelling; no arbitrary-future-day spelling; project specifier writes index (project order), NOT the day bucket's todayIndex."

  note "########## ANYBNC — area-less loose anytime to-do via someday->anytime bounce ##########"
  AB1=$(uuid_of AB-1); AB2=$(uuid_of AB-2); AB3=$(uuid_of AB-3)
  note "  global MIN(index) before: $(globalmin)"
  note "  before: $(dumpstate 'AB-%' | tr '\n' ' ')"
  # reverse desired order -> each round-trip front-inserts, so send LAST-desired first.
  # target order AB-1,AB-2,AB-3 => bounce AB-3, then AB-2, then AB-1.
  for u in "$AB3" "$AB2" "$AB1"; do
    gurl "things:///update?id=$u&auth-token=$TOKEN&when=someday"
    gurl "things:///update?id=$u&auth-token=$TOKEN&when=anytime"
    note "    after bounce $u: min(index)=$(globalmin) | $(dumpstate 'AB-%' | tr '\n' ' ')"
  done
  note "  INTERPRET: front-insert (index below prior global min each leg), start=1 restored, sd=- , a=- (area stays NULL), final order AB-1<AB-2<AB-3 by index. State-preserving => the area-LESS loose anytime reorder gap (ANYORD) is closed via bounce."

  note "########## SOMEORD-a — area specifier reorder of that area's SOMEDAY to-dos (DESTRUCTIVE-RISK) ##########"
  SA1=$(uuid_of SA-1); SA2=$(uuid_of SA-2); SA3=$(uuid_of SA-3)
  note "  before (expect start=2, a=<A>): $(dumpstate 'SA-%' | tr '\n' ' ')"
  note "  result: $(reord "area \"LAB-AREA-A\"" "$SA3,$SA1,$SA2")"
  note "  after : $(dumpstate 'SA-%' | tr '\n' ' ')"
  note "  BLAST RADIUS: (clean) start=2 + a=<A> preserved, index re-ranked SA3<SA1<SA2 -> within-area someday order automatable. (corruption) start 2->1 = de-someday'd -> destructive, report as oddity. (reject) no-op/error -> gap stands. NOTE ANYORD proved area specifier on ANYTIME to-dos is clean+area-preserving; the open question is whether SOMEDAY start survives."

  note "########## SOMEORD-b — project specifier with someday children ##########"
  SOMEPROJ=$(gq "SELECT uuid FROM TMTask WHERE title='RG-SOMEPROJ' AND type=1")
  PS1=$(uuid_of PS1); PS2=$(uuid_of PS2); PS3=$(uuid_of PS3)
  note "  before (expect start=2): $(dumpstate 'PS%' | tr '\n' ' ')"
  note "  result: $(reord "project id \"$SOMEPROJ\"" "$PS3,$PS1,$PS2")"
  note "  after : $(dumpstate 'PS%' | tr '\n' ' ')"
  note "  INTERPRET: O04 project reorder writes index; question is whether start=2 survives (expected clean) -> within-project someday order automatable."

  note "########## TMPLORD-b — headless repeating-template reorder spelling ##########"
  # Templates are born ONLY via the ui vector (make-repeating). If the gui phase
  # seeded RG-RPT with 2+ templates, probe them; else fall back to the golden's
  # existing templates IF two share a container.
  RPTPROJ=$(gq "SELECT uuid FROM TMTask WHERE title='RG-RPT' AND type=1")
  note "  templates + containers: $(gq "SELECT substr(uuid,1,8)||' \"'||title||'\" p='||COALESCE(substr(project,1,8),'-')||' h='||COALESCE(substr(heading,1,8),'-')||' idx='||\"index\" FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL ORDER BY project,\"index\"" | tr '\n' ' ')"
  if [ -n "$RPTPROJ" ]; then
    mapfile -t TMPL < <(gq "SELECT uuid FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL AND project='$RPTPROJ' ORDER BY \"index\"")
    if [ "${#TMPL[@]}" -ge 2 ]; then
      note "  before: $(gq "SELECT title||' idx='||\"index\" FROM TMTask WHERE project='$RPTPROJ' AND rt1_recurrenceRule IS NOT NULL ORDER BY \"index\"" | tr '\n' ' ')"
      # reversed wire list (last template first)
      REV="${TMPL[-1]}"; for ((i=${#TMPL[@]}-2;i>=0;i--)); do REV="$REV,${TMPL[$i]}"; done
      note "  result: $(reord "project id \"$RPTPROJ\"" "$REV")"
      note "  after : $(gq "SELECT title||' idx='||\"index\" FROM TMTask WHERE project='$RPTPROJ' AND rt1_recurrenceRule IS NOT NULL ORDER BY \"index\"" | tr '\n' ' ')"
      note "  INTERPRET: templates are invisible to 'to dos' enumeration (oddity 5e) -> the private command likely NO-OPs on them (they are not in the addressed container's to-do set). A landed index re-rank would be the surprise."
    else
      note "  SKIP: RG-RPT has <2 templates. TMPLORD-b needs >=2 co-located templates (gui phase must seed via make-repeating)."
    fi
  else
    note "  SKIP: no RG-RPT project (gui phase not run / no template seed). Headless template create is impossible (make-repeating is ui-vector); TMPLORD-b depends on the gui phase."
  fi
  note "headless DONE — full log in $REPORT"
  exit 0
fi

# ====================================================================== gui
if [ "$CMD" = "gui" ]; then
  load_session
  note "################################ GUI-DRAG ORACLE ARMS ################################"
  if [ "${AX_GRANTED:-0}" != "1" ]; then note "FATAL: Accessibility NOT granted (setup needs \$VNCDO). GUI oracles cannot run."; exit 1; fi

  # content-row AX + CGEvent drag kit (adapted from research-axdrag2.sh, which
  # targets the SIDEBAR table; here we target the WIDE CONTENT table).
  lab_ssh "$IP" 'cat > /tmp/reordgaps.js' <<'EOF'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId() }
function sleep(ms){ $.NSThread.sleepForTimeInterval(ms/1000) }
function attr(el,name){ var out=Ref(); if($.AXUIElementCopyAttributeValue(el,$(name),out)!==0) return null; return ObjC.castRefToObject(out[0]) }
function sv(el,name){ var v=attr(el,name); return v? v.js : '' }
function frame(el){ var p=attr(el,'AXPosition'), z=attr(el,'AXSize'); if(!p||!z) return null;
  var pd=ObjC.castRefToObject($.CFCopyDescription(p)).js, zd=ObjC.castRefToObject($.CFCopyDescription(z)).js;
  var pm=pd.match(/x:([-0-9.]+) y:([-0-9.]+)/), zm=zd.match(/w:([-0-9.]+) h:([-0-9.]+)/);
  return (pm&&zm)?{x:+pm[1],y:+pm[2],w:+zm[1],h:+zm[2]}:null }
function kids(el){ var c=attr(el,'AXChildren'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a }
function findAll(el, role, depth, acc){ acc=acc||[]; if(depth<0) return acc; var ch=kids(el);
  for(var i=0;i<ch.length;i++){ if(sv(ch[i],'AXRole')===role) acc.push(ch[i]); findAll(ch[i],role,depth-1,acc) } return acc }
function appEl(){ return $.AXUIElementCreateApplication(pidOf('Things3')) }
function stdWindow(){ var ws=kids(appEl()); for(var i=0;i<ws.length;i++){ if(sv(ws[i],'AXSubrole')==='AXStandardWindow') return ws[i] } return ws.length?ws[0]:null }
// the CONTENT list is the WIDE table (>=400px); the sidebar is the narrow one.
function contentTable(){ var w=stdWindow(); if(!w) return null; var ts=findAll(w,'AXTable',14,[]); var best=null;
  for(var i=0;i<ts.length;i++){ var f=frame(ts[i]); if(!f) continue; if(f.w>=400){ if(!best||f.w>best.f.w) best={el:ts[i],f:f} } } return best?best.el:null }
function allText(el,acc,d){ acc=acc||[]; d=d==null?6:d; if(d<0) return acc;
  var v=sv(el,'AXValue'); if(v) acc.push(v); var t=sv(el,'AXTitle'); if(t) acc.push(t); var dd=sv(el,'AXDescription'); if(dd) acc.push(dd);
  var ch=kids(el); for(var i=0;i<ch.length;i++) allText(ch[i],acc,d-1); return acc }
function rowsOf(t){ var out=[]; var ch=kids(t); for(var r=0;r<ch.length;r++){ var role=sv(ch[r],'AXRole');
  if(role==='AXRow'||role==='AXTableRow') out.push({el:ch[r], text:allText(ch[r],[],6).join('|'), f:frame(ch[r])}) } return out }
function rowByTitle(sub){ var t=contentTable(); if(!t) return null; var rs=rowsOf(t);
  for(var i=0;i<rs.length;i++){ var segs=rs[i].text.split('|'); for(var j=0;j<segs.length;j++){ if(segs[j]===sub) return rs[i] } } return null }
var MOVED=5, DOWN=1, UP=2, DRAG=6;
function mev(t,x,y,cs){ var e=$.CGEventCreateMouseEvent($(),t,$.CGPointMake(x,y),0); if(cs) $.CGEventSetIntegerValueField(e,1,cs); return e }
function postHID(ev){ $.CGEventPost($.kCGHIDEventTap, ev) }
function run(argv){
  var cmd=argv[0];
  if(cmd==='rows'){ var t=contentTable(); if(!t) return 'NO_CONTENT_TABLE'; var rs=rowsOf(t);
    var out=[]; for(var i=0;i<rs.length;i++) out.push({i:i, text:rs[i].text, f:rs[i].f}); return JSON.stringify(out); }
  if(cmd==='drag'){ // drag <srcTitle> <dstTitle> [above|below] — drop src near dst
    var src=rowByTitle(argv[1]); if(!src||!src.f) return 'SRC_NOT_FOUND';
    var dst=rowByTitle(argv[2]); if(!dst||!dst.f) return 'DST_NOT_FOUND';
    var sx=src.f.x+src.f.w*0.5, sy=src.f.y+src.f.h/2;
    var side=argv[3]||'below'; var ty=dst.f.y+(side==='above'?2:dst.f.h-2);
    var tx=dst.f.x+dst.f.w*0.5;
    postHID(mev(MOVED,sx,sy,0)); sleep(40);
    postHID(mev(DOWN,sx,sy,1)); sleep(140);
    postHID(mev(DRAG,sx,sy-4,1)); sleep(40);
    for(var s=1;s<=24;s++){ postHID(mev(DRAG,sx+(tx-sx)*s/24,sy+(ty-sy)*s/24,1)); sleep(22) }
    postHID(mev(DRAG,tx,ty,1)); sleep(400);
    postHID(mev(UP,tx,ty,1)); sleep(300);
    return JSON.stringify({grab:{x:sx,y:sy}, drop:{x:tx,y:ty}});
  }
  return 'UNKNOWN_CMD';
}
EOF
  AXR() { lab_ssh "$IP" "/usr/bin/osascript -l JavaScript /tmp/reordgaps.js $*" </dev/null; }
  relaunch() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1; sleep 3; open -a Things3; sleep 9' </dev/null; }
  axoff() { lab_ssh "$IP" '/usr/bin/osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null || true; }
  show() { lab_ssh "$IP" "open -g $(printf '%q' "$1"); sleep 3" </dev/null; }

  note "########## HEADORD-d — drag two to-dos WITHIN a heading; diff the order column ##########"
  # NOTE: HEADORD-a in the headless phase may have de-headed HC*. Seed a fresh headed pair for the drag.
  tjson '[{"type":"project","attributes":{"title":"RG-HEADG","items":[{"type":"heading","attributes":{"title":"HG"}},{"type":"to-do","attributes":{"title":"HGa"}},{"type":"to-do","attributes":{"title":"HGb"}}]}}]'
  sleep 2
  HEADG=$(gq "SELECT uuid FROM TMTask WHERE title='RG-HEADG' AND type=1")
  relaunch; axoff; show "things:///show?id=$HEADG"
  lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; sleep 2" </dev/null
  note "  before: $(dumpstate 'HG%' | tr '\n' ' ')"
  AXR rows > "$OUT/headord-d-rows.json"; head -c 800 "$OUT/headord-d-rows.json"; echo
  AXR drag HGa HGb below | tee "$OUT/headord-d-drag.json"; echo
  sleep 2
  note "  after (which column changed? expect index; heading FK must stay): $(dumpstate 'HG%' | tr '\n' ' ')"

  note "########## DAYORD-a — Upcoming: drag within one future day; confirm todayIndex ##########"
  relaunch; axoff; show "things:///show?id=upcoming"
  lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; sleep 2" </dev/null
  note "  before (DP-* @07-10): $(dumpstate 'DP-%' | tr '\n' ' ')"
  AXR rows > "$OUT/dayord-a-rows.json"; head -c 800 "$OUT/dayord-a-rows.json"; echo
  AXR drag DP-1 DP-3 below | tee "$OUT/dayord-a-drag.json"; echo
  sleep 2
  note "  after (expect todayIndex changed, index untouched): $(dumpstate 'DP-%' | tr '\n' ' ')"

  note "########## SOMEORD-c — within-container someday order drag; same index column? ##########"
  SOMEPROJ=$(gq "SELECT uuid FROM TMTask WHERE title='RG-SOMEPROJ' AND type=1")
  relaunch; axoff; show "things:///show?id=$SOMEPROJ"
  lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; sleep 2" </dev/null
  note "  before (PS* someday): $(dumpstate 'PS%' | tr '\n' ' ')"
  AXR rows > "$OUT/someord-c-rows.json"; head -c 800 "$OUT/someord-c-rows.json"; echo
  AXR drag PS1 PS3 below | tee "$OUT/someord-c-drag.json"; echo
  sleep 2
  note "  after (expect index changed, start=2 preserved): $(dumpstate 'PS%' | tr '\n' ' ')"

  note "########## TMPLORD-a — are resting templates drag-sortable in the repeating bucket? (oddities 9e) ##########"
  # seed >=2 templates in one project via the production make-repeating (ui vector).
  G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }
  if lab_ssh "$IP" 'test -x ~/things-lab/bin/node' </dev/null; then
    tjson '[{"type":"project","attributes":{"title":"RG-RPT","items":[{"type":"to-do","attributes":{"title":"RT-a"}},{"type":"to-do","attributes":{"title":"RT-b"}},{"type":"to-do","attributes":{"title":"RT-c"}}]}}]'
    sleep 2
    RTA=$(uuid_of RT-a); RTB=$(uuid_of RT-b); RTC=$(uuid_of RT-c)
    for u in "$RTA" "$RTB" "$RTC"; do
      G todo make-repeating "$u" --frequency daily --interval 1 --after-completion --dangerously-drive-gui --json 2>&1 | head -c 300; echo
    done
    RPTPROJ=$(gq "SELECT uuid FROM TMTask WHERE title='RG-RPT' AND type=1")
    relaunch; axoff; show "things:///show?id=$RPTPROJ"
    lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to activate'; sleep 2" </dev/null
    note "  templates in RG-RPT before: $(gq "SELECT title||' idx='||\"index\" FROM TMTask WHERE project='$RPTPROJ' AND rt1_recurrenceRule IS NOT NULL ORDER BY \"index\"" | tr '\n' ' ')"
    AXR rows > "$OUT/tmplord-a-rows.json"; head -c 900 "$OUT/tmplord-a-rows.json"; echo
    AXR drag RT-a RT-c below | tee "$OUT/tmplord-a-drag.json"; echo
    sleep 2
    note "  after (oddities 9e predicts: no interleave — drop lands at TOP of the resting sub-bucket; check index deltas): $(gq "SELECT title||' idx='||\"index\" FROM TMTask WHERE project='$RPTPROJ' AND rt1_recurrenceRule IS NOT NULL ORDER BY \"index\"" | tr '\n' ' ')"
  else
    note "  SKIP TMPLORD-a: e2e bundle absent (setup did not ship it). Re-run setup with \$VNCDO to seed templates via make-repeating."
  fi
  note "gui DONE — screenshots + row dumps + drag records in $OUT"
  exit 0
fi

# ================================================================= teardown
if [ "$CMD" = "teardown" ]; then
  note "teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  exit 0
fi

echo "usage: $0 setup|headless|gui|teardown" >&2
exit 1
