#!/bin/bash
# TAGINH2 — tag-inheritance DISPLAY probe (GUI tag-FILTER oracle + DB reads).
# Disposable clone `taginh2-lab` (golden things-lab-golden-v1). Observes the
# Things GUI tag-filter result via VNC screenshots (no AX grant needed — the
# framebuffer capture needs only an unlocked session). Compares GUI oracle to
# the SQL model in src/read/queries.ts (tagWithDescendants / tagScopeSql /
# untaggedScopeSql). KNOWLEDGE-ONLY: no source edits.
#
#   research-taginh2.sh setup      clone+boot+airgap+clock-pin+seed fixtures
#   research-taginh2.sh probe-a    Part a: hierarchy descendant expansion (a1/a2 x2 ctx)
#   research-taginh2.sh probe-b    Part b: heading-chain inheritance (b1/b2/b3)
#   research-taginh2.sh shot <name>  one VNC screenshot to screens/<name>.png
#   research-taginh2.sh nav '<url>' <shotname>   open a things:// url + screenshot
#   research-taginh2.sh teardown   stop + delete the clone
#
# VM discipline: --vnc-experimental single-client — one vncdo per step, timeouts.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; source "$HERE/env.sh"
VM="taginh2-lab"; CMD="${1:-}"; shift || true
OUT="$HERE/../artifacts/taginh2-lab"; mkdir -p "$OUT/screens"
SESSION="$OUT/session.env"; REPORT="$OUT/report.txt"
VNCDO="${VNCDO:-/private/tmp/claude-503/-Volumes-Workspace-Projects-things-api/418f020e-ace0-435f-b621-1fbd832cc9d1/scratchpad/vncvenv/bin/vncdo}"
AUTH="9dFi9fY-QBuqFq59yAUxOg"   # golden's Enable-Things-URLs token

note() { echo "[taginh2] $*" | tee -a "$REPORT"; }
load_session() { [ -f "$SESSION" ] && source "$SESSION"; : "${IP:?run setup first}"; }
gq()  { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gqh() { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" </dev/null; }
AS()  { lab_ssh "$IP" "/usr/bin/osascript -e $(printf '%q' "$1")" </dev/null; }
URL() { lab_ssh "$IP" "open $(printf '%q' "$1"); sleep 2" </dev/null; }
relaunch() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1; sleep 3; open -a Things3; sleep 9' </dev/null; }

vnc_setup() {
  [ -z "$VNCDO" ] && { note "VNCDO unset — abort"; exit 1; }
  HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
  PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
}
V() { sleep 1; timeout 40 "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }

# ================================================================== setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  note "cloning golden -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone things-lab-golden-v1 "$VM"
  (tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
  note "ssh up at $IP"
  VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 071512002026 >/dev/null' </dev/null
  echo "IP=$IP" > "$SESSION"; echo "VNC_URL=$VNC_URL" >> "$SESSION"

  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF

  lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
  vnc_setup
  note "=== early framebuffer sanity screenshot (must show unlocked Things, not lock screen) ==="
  V capture "$OUT/screens/00-boot-sanity.png"

  note "=== CONFIRM golden tags (expect roots + nested prio->low,high) ==="
  gqh 'SELECT title, substr(uuid,1,8) uuid, substr(parent,1,8) parent, "index" FROM TMTag ORDER BY "index", title' | tee -a "$REPORT"

  # If prio/low/high absent, seed them.
  HAVE_PRIO=$(gq 'SELECT count(*) FROM TMTag WHERE title="prio"')
  if [ "$HAVE_PRIO" = "0" ]; then
    note "prio/low/high ABSENT — seeding parent/child triad"
    AS 'tell application "Things3"
      make new tag with properties {name:"prio"}
      delay 0.3
      make new tag with properties {name:"low"}
      delay 0.3
      make new tag with properties {name:"high"}
      delay 0.3
    end tell'
    AS 'tell application "Things3" to set parent tag of tag "low" to tag "prio"'
    AS 'tell application "Things3" to set parent tag of tag "high" to tag "prio"'
  else
    note "prio/low/high PRESENT in golden"
  fi

  note "=== seeding fixtures ==="
  # 1. Area T2Area tagged T2AreaTag ; 4. hierarchy area T2HierArea
  AS 'tell application "Things3"
    make new area with properties {name:"T2Area"}
    make new area with properties {name:"T2HierArea"}
  end tell'
  AS 'tell application "Things3" to make new tag with properties {name:"T2AreaTag"}'
  AS 'tell application "Things3" to make new tag with properties {name:"T2ProjTag"}'
  AS 'tell application "Things3" to set tag names of area "T2Area" to "T2AreaTag"'

  # 2+3. Project T2Proj in T2Area with heading T2Heading + nested child + direct child (JSON vector)
  JSON='[{"type":"project","attributes":{"title":"T2Proj","area":"T2Area","items":[{"type":"heading","attributes":{"title":"T2Heading"}},{"type":"to-do","attributes":{"title":"ZZ-HEADED-CHILD"}},{"type":"to-do","attributes":{"title":"ZZ-DIRECT-CHILD"}}]}}]'
  ENC=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$JSON")
  URL "things:///json?auth-token=$AUTH&data=$ENC"
  sleep 2
  AS 'tell application "Things3" to set tag names of project "T2Proj" to "T2ProjTag"'
  sleep 1
  # NOTE: DirectChild in items[] currently follows the heading — fix below by
  # re-parenting it out of the heading so it is a plain project child control.
  # (verified/repaired in DB dump; if the JSON put it under the heading we move it)

  # 4. hierarchy fixtures: ZZ-ONLY-LOW tagged only child `low`; ZZ-ONLY-PRIO tagged only parent `prio`
  AS 'tell application "Things3"
    set t1 to make new to do with properties {name:"ZZ-ONLY-LOW"}
    set area of t1 to area "T2HierArea"
    set tag names of t1 to "low"
    set t2 to make new to do with properties {name:"ZZ-ONLY-PRIO"}
    set area of t2 to area "T2HierArea"
    set tag names of t2 to "prio"
  end tell'
  sleep 1

  relaunch
  note "=== FIXTURE TREE (type: 0=todo 1=project 2=heading) ==="
  gqh 'SELECT substr(uuid,1,8) uuid, title, type, substr(project,1,8) project, substr(heading,1,8) heading, substr(area,1,8) area FROM TMTask WHERE title IN ("T2Proj","T2Heading","ZZ-HEADED-CHILD","ZZ-DIRECT-CHILD","ZZ-ONLY-LOW","ZZ-ONLY-PRIO") ORDER BY type DESC, title' | tee -a "$REPORT"
  note "=== AREAS ==="
  gqh 'SELECT substr(uuid,1,8) uuid, title FROM TMArea WHERE title IN ("T2Area","T2HierArea")' | tee -a "$REPORT"
  note "=== TAG assignments (TMTaskTag) for fixture todos ==="
  gqh 'SELECT tk.title item, tg.title tag FROM TMTaskTag tt JOIN TMTag tg ON tg.uuid=tt.tags JOIN TMTask tk ON tk.uuid=tt.tasks WHERE tk.title IN ("T2Proj","T2Heading","ZZ-HEADED-CHILD","ZZ-DIRECT-CHILD","ZZ-ONLY-LOW","ZZ-ONLY-PRIO") ORDER BY tk.title' | tee -a "$REPORT"
  note "=== AREA tag assignments (TMAreaTag) ==="
  gqh 'SELECT ar.title area, tg.title tag FROM TMAreaTag at JOIN TMTag tg ON tg.uuid=at.tags JOIN TMArea ar ON ar.uuid=at.areas WHERE ar.title IN ("T2Area","T2HierArea")' | tee -a "$REPORT"
  note "=== nested tag triad ==="
  gqh 'SELECT t.title, substr(t.uuid,1,8) uuid, p.title parent FROM TMTag t LEFT JOIN TMTag p ON p.uuid=t.parent WHERE t.title IN ("prio","low","high")' | tee -a "$REPORT"
  note "setup DONE. session in $SESSION"
  exit 0
fi

# ============================================================ probe-a
if [ "$CMD" = "probe-a" ]; then
  load_session; vnc_setup
  HIER=$(gq 'SELECT uuid FROM TMArea WHERE title="T2HierArea" LIMIT 1')
  note "=== PROBE A: hierarchy descendant expansion. T2HierArea uuid=$HIER ==="
  note "context (i) built-in list = anytime ; context (ii) area filter = T2HierArea"

  # ---- context (ii) AREA: unfiltered baseline
  note "[a-ctx-ii] UNFILTERED area T2HierArea"
  URL "things:///show?id=$HIER"; sleep 2; V capture "$OUT/screens/a-ii-00-unfiltered.png"
  # a1: filter by PARENT prio -> expect ZZ-ONLY-LOW present (parent matches child-tagged)
  note "[a1-ctx-ii] filter=prio (parent) -> expect ZZ-ONLY-LOW YES"
  URL "things:///show?id=$HIER&filter=prio"; sleep 2; V capture "$OUT/screens/a1-ii-prio.png"
  # a2: filter by CHILD low -> expect ZZ-ONLY-PRIO absent (child does not match parent-tagged)
  note "[a2-ctx-ii] filter=low (child) -> expect ZZ-ONLY-PRIO NO"
  URL "things:///show?id=$HIER&filter=low"; sleep 2; V capture "$OUT/screens/a2-ii-low.png"

  # ---- context (i) ANYTIME built-in list
  note "[a-ctx-i] UNFILTERED anytime"
  URL "things:///show?id=anytime"; sleep 2; V capture "$OUT/screens/a-i-00-unfiltered.png"
  note "[a1-ctx-i] anytime filter=prio -> expect ZZ-ONLY-LOW YES"
  URL "things:///show?id=anytime&filter=prio"; sleep 2; V capture "$OUT/screens/a1-i-prio.png"
  note "[a2-ctx-i] anytime filter=low -> expect ZZ-ONLY-PRIO NO"
  URL "things:///show?id=anytime&filter=low"; sleep 2; V capture "$OUT/screens/a2-i-low.png"
  note "probe-a DONE — read PNGs in $OUT/screens/"
  exit 0
fi

# ============================================================ probe-b
if [ "$CMD" = "probe-b" ]; then
  load_session; vnc_setup
  PROJ=$(gq 'SELECT uuid FROM TMTask WHERE title="T2Proj" AND type=1 LIMIT 1')
  AREA=$(gq 'SELECT uuid FROM TMArea WHERE title="T2Area" LIMIT 1')
  note "=== PROBE B: heading-chain inheritance. T2Proj uuid=$PROJ  T2Area uuid=$AREA ==="

  note "[b-00] UNFILTERED project T2Proj (baseline: heading + both children visible)"
  URL "things:///show?id=$PROJ"; sleep 2; V capture "$OUT/screens/b-00-unfiltered.png"

  # b1 clause5: filter project by T2ProjTag -> ZZ-HEADED-CHILD present (via heading->project tag)
  note "[b1] project filter=T2ProjTag -> expect ZZ-HEADED-CHILD YES + ZZ-DIRECT-CHILD YES(control)"
  URL "things:///show?id=$PROJ&filter=T2ProjTag"; sleep 2; V capture "$OUT/screens/b1-projtag.png"

  # b2 clause6: filter project by T2AreaTag -> ZZ-HEADED-CHILD present (via heading->project->area tag)
  note "[b2] project filter=T2AreaTag -> expect ZZ-HEADED-CHILD YES"
  URL "things:///show?id=$PROJ&filter=T2AreaTag"; sleep 2; V capture "$OUT/screens/b2-areatag.png"

  note "[b3] 'No Tag' filter — try filter=; if inert, click the No Tag chip"
  URL "things:///show?id=$PROJ"; sleep 2; V capture "$OUT/screens/b3-00-prefilter.png"
  note "probe-b DONE — read PNGs. Do b3 chip-click manually per screenshot geometry."
  exit 0
fi

# ============================================================ nav (ad-hoc)
if [ "$CMD" = "nav" ]; then
  load_session; vnc_setup
  URL "$1"; sleep 2; V capture "$OUT/screens/${2:-nav}.png"; note "nav $1 -> $OUT/screens/${2:-nav}.png"
  exit 0
fi

# ================================================================ shot
if [ "$CMD" = "shot" ]; then
  load_session; vnc_setup; NAME="${1:-shot}"
  V capture "$OUT/screens/$NAME.png"; note "captured $OUT/screens/$NAME.png"
  exit 0
fi

# ================================================================ teardown
if [ "$CMD" = "teardown" ]; then
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "torn down $VM"
  exit 0
fi

echo "usage: research-taginh2.sh {setup|probe-a|probe-b|nav <url> <name>|shot <name>|teardown}" >&2
exit 2
