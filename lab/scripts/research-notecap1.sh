#!/bin/bash
# NOTECAP1 — the notes ceiling: its exact value, its UNIT, and what lands when
# a write exceeds it, per vector.
#
# THE PROBLEM (#621). A field append took a notes body to ~10,245 bytes; Things
# stored only a prefix, cut mid-word near an apparent 10,000-unit boundary. The
# CLI's read-after-write caught it — as a generic `verify-failed:mismatch` —
# but the mutation had PARTIALLY LANDED and nothing named truncation or a limit.
#
# WHAT MUST BE MEASURED:
#   UNIT-*  The ceiling and its unit. Binary-search the largest payload that
#           survives intact, for three payload classes whose byte/scalar/utf16
#           ratios differ (ascii 1:1:1, emoji 4:1:2, combining 3:2:2). The
#           triple identifies the unit uniquely.
#   CUT     Where the cut falls inside a straddling scalar/grapheme — the stored
#           tail BYTES, in hex.
#   V-*     Per vector: AppleScript set / AppleScript make / URL add / URL
#           update / URL add-project / things:///json. Each vector's own
#           practical ceiling (a transport limit may bite before the app's), the
#           error it produces, and the row-level delta.
#   P-*     Project notes vs to-do notes.
#   CLI-*   The SHIPPED CLI: `todo update --notes` over-limit, and the
#           `--append-notes` case where the JOINED result overflows.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (Things 3.23 / dbv27; the
# golden is NEVER booted). Airgapped, clock pinned 2026-07-05 — the TRIAL WALL is
# 2026-07-18 and this campaign NEVER rolls the clock. Payloads fully synthetic
# (cycling digits / U+1F600 / "e"+U+0301). Beep sentinel on, report-only per
# driver convention; counts printed.
#
# Usage:  lab/scripts/research-notecap1.sh setup
#         lab/scripts/research-notecap1.sh run
#         lab/scripts/research-notecap1.sh teardown
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-notecap1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="${OUT:-lab/artifacts/$VM}"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"
CMD="${1:-run}"

note() { echo "[notecap1] $*" | tee -a "$REPORT"; }
cell() { note ""; note "========== $1 =========="; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

# ==================================================================== teardown
if [ "$CMD" = "teardown" ]; then
  tart stop "$VM" >/dev/null 2>&1 || true
  sleep 3
  tart delete "$VM" >/dev/null 2>&1 || true
  note "teardown: $VM stopped + deleted"
  tart list 2>/dev/null | sed 's/^/    /'
  exit 0
fi

# ======================================================================= setup
if [ "$CMD" = "setup" ]; then
  note ""
  note "################ NOTECAP1 SETUP $(date -u +%Y-%m-%dT%H:%M:%SZ) ################"
  tart list 2>/dev/null | sed 's/^/    /' | tee -a "$REPORT"
  RUNNING=$(tart list 2>/dev/null | awk '$5=="running"{n++} END{print n+0}')
  if [ "${RUNNING:-0}" -ge 2 ]; then note "FATAL: $RUNNING VMs already running (2-VM ceiling)"; exit 1; fi

  if [ "${SKIP_BUILD:-0}" = "1" ]; then note "SKIP_BUILD=1 — reusing dist/"; else
    note "building dist"
    npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
  fi
  [ -f dist/cli/main.js ] || { note "FATAL: no dist/cli/main.js"; exit 1; }

  note "cloning $GOLDEN -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 420) || { note "FATAL: no SSH"; exit 1; }
  note "ssh up at $IP"

  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  [ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null) (trial wall 2026-07-18 — never rolled)"

  lab_ssh "$IP" 'mkdir -p ~/labh ~/things-lab/run' </dev/null
  lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<<"$GSQL"
  lab_scp lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/things-lab/run/beep-sentinel.sh" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/run/beep-sentinel.sh' </dev/null
  lab_scp lab/scripts/notecap1-nc.py "admin@$IP:/Users/admin/labh/nc.py" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/labh/nc.py' </dev/null

  note "warm-up launch/quit/relaunch (background only)"
  lab_ssh "$IP" 'open -g -a Things3; sleep 16; osascript -e "tell application \"Things3\" to quit"; sleep 4; open -g -a Things3; sleep 14' </dev/null

  TOKEN=$(lab_ssh "$IP" "~/labh/gsql.sh -q 'SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1'" </dev/null)
  echo "IP=$IP" > "$SESSION"; echo "TOKEN=$TOKEN" >> "$SESSION"
  note "auth token in hand (${#TOKEN} chars)"

  TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
  TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
  MOS=$(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)
  note "env: Things $TVER ($TBLD) / macOS $MOS / golden $GOLDEN"
  { echo "TVER=$TVER"; echo "TBLD=$TBLD"; echo "MOS=$MOS"; } >> "$SESSION"

  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  lab_scp "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  lab_scp -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  COMMANDER=$(node -e "console.log(require('node:path').dirname(require.resolve('commander')))")
  lab_scp -r "$COMMANDER" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  lab_scp package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
  note "shipped dist; ui-enabled=true"

  note "setup DONE — session in $SESSION"
  exit 0
fi

# ========================================================================= run
[ -f "$SESSION" ] || { note "FATAL: no session ($SESSION) — run setup first"; exit 1; }
# shellcheck disable=SC1090
source "$SESSION"
lab_ssh "$IP" true 2>/dev/null || { note "FATAL: no SSH to $IP"; exit 1; }

# always re-push the helper so a later phase drives the CURRENT oracle
lab_scp lab/scripts/notecap1-nc.py "admin@$IP:/Users/admin/labh/nc.py" >/dev/null
lab_ssh "$IP" 'chmod +x ~/labh/nc.py' </dev/null

CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
gq()  { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt()  { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
G()   { lab_ssh "$IP" "$LAB_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
nc_()  { lab_ssh "$IP" "python3 ~/labh/nc.py $*" </dev/null 2>&1; }
bs()    { lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 ~/things-lab/run/beep-sentinel.sh $*" </dev/null 2>&1; }
bmark() { lab_ssh "$IP" "~/things-lab/run/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null 2>&1; }
alive(){ lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo ALIVE || echo DEAD' </dev/null; }
rowcount(){ gq "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'NOTECAP1%' OR title LIKE 'NC%'"; }
# every run stamps its own fixture titles, so a re-run never collides with the
# rows a previous run left behind
RUNTAG="${RUNTAG:-$(date -u +%H%M%S)}"

# jq-free json field pluck (guest helper output is one flat object)
jf() { python3 -c 'import json,sys; print(json.loads(sys.stdin.read().strip().splitlines()[-1]).get(sys.argv[1],""))' "$1"; }

# measure(uuid) -> "scalars bytes tailhex"
measure(){ gq "SELECT length(notes)||' '||length(CAST(notes AS BLOB))||' '||hex(substr(CAST(notes AS BLOB),-16)) FROM TMTask WHERE uuid='$1'"; }
# wait until the notes column carries the tag prefix (or timeout)
waittag(){ local u="$1" tag="$2" i
  for i in $(seq 1 30); do
    [ "$(gq "SELECT COUNT(*) FROM TMTask WHERE uuid='$u' AND notes LIKE '$tag|%'")" = "1" ] && return 0
    sleep 1
  done; return 1; }
waittitle(){ local t="$1" i
  for i in $(seq 1 30); do
    [ "$(gq "SELECT COUNT(*) FROM TMTask WHERE title='$t'")" -ge 1 ] && return 0
    sleep 1
  done; return 1; }
uuidof(){ gq "SELECT uuid FROM TMTask WHERE title='$1' ORDER BY creationDate DESC LIMIT 1"; }

note ""
note "################ NOTECAP1 RUN $(date -u +%Y-%m-%dT%H:%M:%SZ) ################"
note "env: Things ${TVER:-?} (${TBLD:-?}) / macOS ${MOS:-?} / golden $GOLDEN / VM $VM @ $IP"
bs reset >/dev/null

# ------------------------------------------------------------------ primitives
# trial <kind> <n> <uuid> — write a payload of size n and report what landed.
#   status=INTACT   stored == requested
#   status=TRUNC    stored is shorter than requested (prefix-accept)
#   status=REJECT   nothing landed inside the poll window
trial(){
  local kind="$1" n="$2" u="$3" tag st ws wb wu m gs gb gh status
  tag="NC${kind}${n}"
  st=$(nc_ gen "$kind" "$n" "$tag")
  ws=$(echo "$st" | jf scalars); wb=$(echo "$st" | jf bytes); wu=$(echo "$st" | jf utf16)
  bmark "$kind-$n"
  nc_ as-set "$u" >/dev/null
  if waittag "$u" "$tag"; then
    m=$(measure "$u"); gs=$(echo "$m" | cut -d' ' -f1); gb=$(echo "$m" | cut -d' ' -f2); gh=$(echo "$m" | cut -d' ' -f3)
    status=TRUNC; [ "$gs" = "$ws" ] && [ "$gb" = "$wb" ] && status=INTACT
    echo "n=$n want[scalars=$ws bytes=$wb utf16=$wu] got[scalars=$gs bytes=$gb] tail=$gh status=$status"
  else
    echo "n=$n want[scalars=$ws bytes=$wb utf16=$wu] got[-] status=REJECT"
  fi
}

# bsearch <kind> <lo-good> <hi-bad> <uuid>
bsearch(){
  local kind="$1" lo="$2" hi="$3" u="$4" mid r
  while [ $((hi - lo)) -gt 1 ]; do
    mid=$(( (lo + hi) / 2 ))
    r=$(trial "$kind" "$mid" "$u")
    note "    $r"
    case "$r" in *status=INTACT*) lo=$mid ;; *) hi=$mid ;; esac
  done
  note "    -> largest INTACT n = $lo ; smallest non-intact n = $hi"
}

# ============================================================ SANITY + fixtures
cell "SANITY — the URL vector is alive on this clone (URLEN1 gate)"
bmark "sanity"
nc_ gen ascii 20 NCSANITY >/dev/null
note "  $(nc_ url-add "NOTECAP1-sanity-$RUNTAG")"
if waittitle "NOTECAP1-sanity-$RUNTAG"; then note "  PASS url add landed"; else note "  FAIL url add did NOT land — Enable Things URLs may be OFF"; fi

cell "FIXTURES — one to-do + one project to mutate (run tag $RUNTAG)"
bmark "fixtures"
nc_ gen ascii 5 NCSEED >/dev/null
nc_ url-add "NOTECAP1-todo-$RUNTAG" >/dev/null; waittitle "NOTECAP1-todo-$RUNTAG"
nc_ url-addp "NOTECAP1-proj-$RUNTAG" >/dev/null; waittitle "NOTECAP1-proj-$RUNTAG"
TODO=$(uuidof "NOTECAP1-todo-$RUNTAG"); PROJ=$(uuidof "NOTECAP1-proj-$RUNTAG")
note "  todo=$TODO  project=$PROJ"
note "  app $(alive)"

# ============================================================= URL-vector cells
# utrial <verb> <kind> <n> <uuid> [titlepad] — a URL-vector write, same report
# shape as `trial`, plus the dispatched URL's own size.
utrial(){
  local verb="$1" kind="$2" n="$3" u="$4" pad="${5:-}" tag st ws wb wu d ux m gs gb gh status
  tag="NC${kind}${n}"
  st=$(nc_ gen "$kind" "$n" "$tag")
  ws=$(echo "$st" | jf scalars); wb=$(echo "$st" | jf bytes); wu=$(echo "$st" | jf utf16)
  bmark "$verb-$kind-$n"
  d=$(nc_ "$verb" "$u" "$TOKEN" "$pad")
  ux=$(echo "$d" | jf urlchars)
  if waittag "$u" "$tag"; then
    m=$(measure "$u"); gs=$(echo "$m" | cut -d' ' -f1); gb=$(echo "$m" | cut -d' ' -f2); gh=$(echo "$m" | cut -d' ' -f3)
    status=TRUNC; [ "$gs" = "$ws" ] && [ "$gb" = "$wb" ] && status=INTACT
    echo "$verb n=$n url=${ux}ch want[scalars=$ws bytes=$wb utf16=$wu] got[scalars=$gs bytes=$gb] tail=$gh status=$status"
  else
    echo "$verb n=$n url=${ux}ch want[scalars=$ws bytes=$wb utf16=$wu] got[-] status=REJECT"
  fi
}

# The FIELD-matrix oracles: `title` is the column in TMTask (to-dos, projects,
# headings), TMArea, TMTag and TMChecklistItem alike, so one pair of helpers
# covers every non-notes content field.
waitcol(){ local t="$1" p="$2" i
  for i in $(seq 1 25); do
    [ "$(gq "SELECT COUNT(*) FROM $t WHERE title LIKE '$p|%'")" -ge 1 ] && return 0
    sleep 1
  done; return 1; }
measurecol(){ gq "SELECT length(title)||' '||length(CAST(title AS BLOB)) FROM $1 WHERE title LIKE '$2|%' LIMIT 1"; }
# gtrial <table> <verb> <kind> <n> [verb args…]
gtrial(){
  local tbl="$1" verb="$2" kind="$3" n="$4"; shift 4
  local tag st ws wb d ux m gs gb status
  tag="NC${kind}${n}"
  st=$(nc_ gen "$kind" "$n" "$tag")
  ws=$(echo "$st" | jf scalars); wb=$(echo "$st" | jf bytes)
  bmark "$verb-$kind-$n"
  d=$(nc_ "$verb" "$@"); ux=$(echo "$d" | jf urlchars); [ -z "$ux" ] && ux="n/a"
  if waitcol "$tbl" "$tag"; then
    m=$(measurecol "$tbl" "$tag"); gs=$(echo "$m" | cut -d' ' -f1); gb=$(echo "$m" | cut -d' ' -f2)
    status=TRUNC; [ "$gs" = "$ws" ] && [ "$gb" = "$wb" ] && status=INTACT
    echo "$verb n=$n url=${ux}ch want[scalars=$ws bytes=$wb] got[scalars=$gs bytes=$gb] status=$status"
  else
    echo "$verb n=$n url=${ux}ch want[scalars=$ws bytes=$wb] got[-] status=REJECT"
  fi
}

# ubsearch <verb> <kind> <lo-good> <hi-bad> <uuid>
ubsearch(){
  local verb="$1" kind="$2" lo="$3" hi="$4" u="$5" mid r
  while [ $((hi - lo)) -gt 1 ]; do
    mid=$(( (lo + hi) / 2 ))
    r=$(utrial "$verb" "$kind" "$mid" "$u")
    note "    $r"
    case "$r" in *status=INTACT*) lo=$mid ;; *) hi=$mid ;; esac
  done
  note "    -> largest INTACT n = $lo ; smallest non-intact n = $hi"
}

if [ "${P3:-0}" != "1" ]; then
if [ "${SKIP_P1:-0}" != "1" ]; then
# ============================================== AS-CONTROL: the roomy vector
# Measured first, and it reframed the whole campaign: AppleScript `set notes`
# has NO ceiling anywhere near 10k. The ~10,000-unit cut is a URL-VECTOR law.
cell "AS-ASCII — AppleScript set notes, 15000 ascii scalars (1 byte : 1 scalar : 1 utf16)"
note "  $(trial ascii 15000 "$TODO")"

cell "AS-EMOJI — 15000 x U+1F600 (4 bytes : 1 scalar : 2 utf16)"
note "  $(trial emoji 15000 "$TODO")"

cell "AS-COMB — 15000 x (e + U+0301) (3 bytes : 2 scalars : 2 utf16 : 1 grapheme)"
note "  $(trial comb 15000 "$TODO")"

cell "URL-UNIT-ASCII — things:///update?notes= over the ceiling (15000 ascii)"
note "  $(utrial url-upd ascii 15000 "$TODO")"

cell "URL-UNIT-EMOJI — 15000 x U+1F600 (percent-encodes to 12 URL chars each)"
note "  $(utrial url-upd emoji 15000 "$TODO")"

cell "URL-UNIT-COMB — 15000 x (e + U+0301)"
note "  $(utrial url-upd comb 15000 "$TODO")"

cell "URL-BSEARCH-ASCII — the exact boundary"
ubsearch url-upd ascii 9000 11000 "$TODO"

cell "URL-BSEARCH-EMOJI — the same boundary in a 4-byte/2-utf16 payload"
ubsearch url-upd emoji 2000 11000 "$TODO"

cell "URL-BSEARCH-COMB — the same boundary in a 2-scalar/1-grapheme payload"
ubsearch url-upd comb 2000 11000 "$TODO"

cell "URL-FIELD-VS-TRANSPORT — identical notes payload, +5000 chars of title"
note "  no pad:  $(utrial url-upd ascii 15000 "$TODO")"
note "  pad5000: $(utrial url-upd ascii 15000 "$TODO" 5000)"

cell "URL-STRADDLE — an ascii run that ends 2 scalars short of the cut, then emoji"
note "  $(utrial url-upd strad 9998 "$TODO")"

cell "URL-XXL — how big a URL the transport itself carries"
for N in 50000 200000 1000000; do
  note "  $(utrial url-upd ascii "$N" "$TODO")"
done

# ================================================== per-vector / per-entity cells
cell "V-URL-ADD — things:///add?notes= (a NEW to-do), 15000 ascii"
bmark "v-url-add"
R0=$(rowcount)
nc_ gen ascii 15000 NCADD >/dev/null
note "  $(nc_ url-add NOTECAP1-add-$RUNTAG)"
if waittitle NOTECAP1-add-$RUNTAG; then
  A=$(uuidof NOTECAP1-add-$RUNTAG); note "  landed: $(measure "$A")  (scalars bytes tailhex)"
else note "  REJECT — no row"; fi
note "  rowdelta: $R0 -> $(rowcount)"

cell "V-URL-ADDP — things:///add-project?notes= (a NEW project), 15000 ascii"
bmark "v-url-addp"
R0=$(rowcount)
nc_ gen ascii 15000 NCADDP >/dev/null
note "  $(nc_ url-addp NOTECAP1-addp-$RUNTAG)"
if waittitle NOTECAP1-addp-$RUNTAG; then
  A=$(uuidof NOTECAP1-addp-$RUNTAG); note "  landed: $(measure "$A")"
else note "  REJECT — no row"; fi
note "  rowdelta: $R0 -> $(rowcount)"

cell "V-URL-UPDP — things:///update-project?notes= on an existing project"
note "  $(utrial url-updp ascii 15000 "$PROJ")"

cell "V-JSON-UPD — things:///json update, notes= 15000 ascii"
note "  $(utrial json-upd ascii 15000 "$TODO")"

cell "V-JSON-ADD — things:///json add, notes= 15000 ascii"
bmark "v-json-add"
R0=$(rowcount)
nc_ gen ascii 15000 NCJSONADD >/dev/null
note "  $(nc_ json-add NOTECAP1-jsonadd-$RUNTAG "$TOKEN")"
if waittitle NOTECAP1-jsonadd-$RUNTAG; then
  A=$(uuidof NOTECAP1-jsonadd-$RUNTAG); note "  landed: $(measure "$A")"
else note "  REJECT — no row"; fi
note "  rowdelta: $R0 -> $(rowcount)"

cell "V-URL-APPEND — the SERVER-SIDE join: notes already near the ceiling, append more"
bmark "v-url-append-base"
nc_ gen ascii 9000 NCAPPBASE >/dev/null
nc_ url-upd "$TODO" "$TOKEN" >/dev/null
waittag "$TODO" NCAPPBASE && note "  base: $(measure "$TODO")"
bmark "v-url-append-add"
nc_ gen ascii 3000 NCAPPADD >/dev/null
note "  $(nc_ url-app "$TODO" "$TOKEN")"
sleep 8
note "  after append: $(measure "$TODO")"
note "  (base 9013 + newline + 3013 = 12027 requested)"

cell "V-URL-APPEND-XXL — is the CEILING on the parameter value or on the JOINED body?"
bmark "v-url-append-xxl-base"
nc_ gen ascii 500 NCAPPXBASE >/dev/null
nc_ url-upd "$TODO" "$TOKEN" >/dev/null
waittag "$TODO" NCAPPXBASE && note "  base: $(measure "$TODO")"
bmark "v-url-append-xxl"
nc_ gen ascii 15000 NCAPPXADD >/dev/null
note "  $(nc_ url-app "$TODO" "$TOKEN")"
sleep 8
note "  after append: $(measure "$TODO")   (requested 510 + 1 + 15013 = 15524)"

fi  # SKIP_P1

# ===================================================================== CLI cells
cell "CLI-UPDATE-NOTES — the shipped CLI, --notes - over the ceiling"
bmark "cli-update"
nc_ gen ascii 15000 NCCLIUPD >/dev/null
note "$(lab_ssh "$IP" "$LAB_DIRECT $CLI todo update $TODO --notes - --json < /tmp/nc.txt; echo EXIT=\$?" </dev/null 2>&1 | grep -v ExperimentalWarning | grep -v trace-warnings | sed 's/^/    /')"
note "  landed: $(measure "$TODO")"

cell "CLI-ADD-NOTES — the shipped CLI, todo add --notes - over the ceiling"
bmark "cli-add"
R0=$(rowcount)
nc_ gen ascii 15000 NCCLIADD >/dev/null
note "$(lab_ssh "$IP" "$LAB_DIRECT $CLI todo add NOTECAP1-cliadd-$RUNTAG --notes - --json < /tmp/nc.txt; echo EXIT=\$?" </dev/null 2>&1 | grep -v ExperimentalWarning | grep -v trace-warnings | sed 's/^/    /')"
note "  rowdelta: $R0 -> $(rowcount)"
if waittitle NOTECAP1-cliadd-$RUNTAG; then A=$(uuidof NOTECAP1-cliadd-$RUNTAG); note "  landed: $(measure "$A")"; fi

cell "CLI-APPEND-NOTES — the JOINED result crosses 10k (the #621 field case)"
bmark "cli-append-base"
nc_ gen ascii 9000 NCCLIAPPB >/dev/null
nc_ url-upd "$TODO" "$TOKEN" >/dev/null
waittag "$TODO" NCCLIAPPB && note "  base: $(measure "$TODO")"
bmark "cli-append"
nc_ gen ascii 3000 NCCLIAPPA >/dev/null
note "$(lab_ssh "$IP" "$LAB_DIRECT $CLI todo update $TODO --append-notes \"\$(cat /tmp/nc.txt)\" --json" </dev/null 2>&1 | grep -v ExperimentalWarning | grep -v trace-warnings | sed 's/^/    /')"
note "  landed: $(measure "$TODO")"

# ==================================================== the GRAPHEME discriminators
# ascii/emoji/comb pin the ceiling at 10,000 GRAPHEME CLUSTERS. These four ask
# whether the app's cluster is UAX#29's *extended grapheme cluster* (what
# Intl.Segmenter counts, and therefore what the shipped guard would count) or
# Foundation's older *composed character sequence*, which splits ZWJ sequences,
# flags and skin-tone modifiers that UAX#29 keeps whole. Each payload repeats
# ONE sequence whose scalar count is known, so the stored scalar count says
# exactly how many units the app charged per sequence.
cell "G-ZWJ — 15000 x family (4 emoji + 3 ZWJ = 7 scalars / 25 bytes / 1 UAX#29 cluster)"
note "  $(utrial url-upd zwj 15000 "$TODO")"

cell "G-FLAG — 15000 x regional-indicator pair (2 scalars / 8 bytes / 1 cluster)"
note "  $(utrial url-upd flag 15000 "$TODO")"

cell "G-SKIN — 15000 x thumbs-up + skin-tone modifier (2 scalars / 8 bytes / 1 cluster)"
note "  $(utrial url-upd skin 15000 "$TODO")"

cell "G-CRLF — 15000 x CR LF (2 scalars / 2 bytes / 1 cluster)"
note "  $(utrial url-upd crlf 15000 "$TODO")"

cell "G-EXACT — the boundary in graphemes: 9999 / 10000 / 10001 ascii (tag makes the total)"
# the tag prefix is 13 chars for a 5-digit n, so n=9987 is exactly 10000 clusters
for N in 9987 9988 9989; do
  note "  $(utrial url-upd ascii "$N" "$TODO")"
done

# ================================================ the FIELD-LENGTH matrix (#621
# scope extension, maintainer 2026-08-27): every other content field a caller
# can overrun. Same payload machinery; `title` is the column in TMTask (to-dos,
# projects, headings), TMArea, TMTag and TMChecklistItem alike.
cell "F-TODO-TITLE-URL — things:///add?title= ladder (1k / 5k / 15k / 100k)"
for N in 1000 5000 15000 100000; do note "  $(gtrial TMTask url-add-t ascii "$N")"; done

cell "F-TODO-TITLE-URL-UNIT — the same ceiling in emoji + combining payloads"
note "  $(gtrial TMTask url-add-t emoji 15000)"
note "  $(gtrial TMTask url-add-t comb 15000)"

cell "F-TODO-TITLE-URL-EXACT — the boundary (tag is 12 chars, so n=9988 is 10000 clusters)"
for N in 9987 9988 9989; do note "  $(gtrial TMTask url-add-t ascii "$N")"; done

cell "F-TODO-TITLE-URL-UPD — things:///update?title="
note "  $(gtrial TMTask url-upd-t ascii 15000 "$TODO" "$TOKEN")"

cell "F-TODO-TITLE-AS — AppleScript set name (the roomy-vector control)"
note "  $(gtrial TMTask as-name ascii 15000 "$TODO")"
note "  $(gtrial TMTask as-name ascii 100000 "$TODO")"

cell "F-PROJ-TITLE-URL — things:///add-project?title="
note "  $(gtrial TMTask url-addp-t ascii 15000)"

cell "F-CHECKLIST-URL — things:///add?checklist-items= (one item, the payload)"
note "  $(gtrial TMChecklistItem url-add-ck ascii 15000 "NOTECAP1-ck-$RUNTAG")"

cell "F-HEADING-JSON — things:///json project update, one heading item"
note "  $(gtrial TMTask json-head ascii 15000 "$PROJ" "$TOKEN")"

cell "F-TAG-URL — things:///add?tags= (tag NAME on a new to-do)"
note "  $(gtrial TMTag url-add-tag ascii 15000 "NOTECAP1-tagged-$RUNTAG")"

cell "F-AREA-AS — AppleScript make new area (the only vector area.add has)"
note "  $(gtrial TMArea as-area ascii 15000)"
note "  $(gtrial TMArea as-area ascii 100000)"

cell "F-TAG-AS — AppleScript make new tag (the only vector tag.add has)"
note "  $(gtrial TMTag as-tag ascii 15000)"
note "  $(gtrial TMTag as-tag ascii 100000)"

fi  # P3

# ================================================== phase 3 — the exact boundaries
# The F-* ladder put the title-class ceiling at 4,000 and — unlike notes — the
# emoji and combining payloads say the unit is UTF-16 CODE UNITS, not clusters.
# These cells pin both boundaries to the unit.
cell "CK-COUNT-OTHER-VECTORS — is the 100-item cap the add URL's, or the app's?"
bmark "ck-count-upd"
T="NOTECAP1-ckupd-$RUNTAG"
nc_ gen ascii 5 NCCKU >/dev/null
nc_ url-add "$T" >/dev/null; waittitle "$T" >/dev/null
U=$(uuidof "$T")
nc_ url-upd-ckn "$U" "$TOKEN" 150 6 CKU >/dev/null
sleep 8
note "  things:///update?checklist-items= 150 items -> landed $(gq "SELECT COUNT(*) FROM TMChecklistItem WHERE task='$U'")"
bmark "ck-count-json"
TJ="NOTECAP1-ckjson-$RUNTAG"
nc_ json-ckn "$TJ" "$TOKEN" 150 6 CKJ >/dev/null
waittitle "$TJ" >/dev/null
UJ=$(uuidof "$TJ")
sleep 8
note "  things:///json 150 checklist items -> landed $(gq "SELECT COUNT(*) FROM TMChecklistItem WHERE task='$UJ'")"

cell "T-EXACT-ASCII — title at 3999 / 4000 / 4001 UTF-16 units (tag is 12 chars)"
for N in 3987 3988 3989; do note "  $(gtrial TMTask url-add-t ascii "$N")"; done

cell "T-EXACT-EMOJI — title where 12 + 2n UTF-16 units straddles 4000"
for N in 1993 1994 1995; do note "  $(gtrial TMTask url-add-t emoji "$N")"; done

cell "G-ZWJ — the SECOND notes ceiling. A family is 1 cluster but ELEVEN UTF-16"
note "  units, so a family payload crosses a unit ceiling long before the cluster one."
note "  n=3000: 3011 clusters / 33011 units — under both, expect INTACT"
note "  $(utrial url-upd zwj 3000 "$TODO")"
note "  n=4000: 4011 clusters / 44011 units — over a 40000-unit ceiling only"
note "  $(utrial url-upd zwj 4000 "$TODO")"
note "  n=3630/3636: 39941 / 40007 units — the boundary itself"
note "  $(utrial url-upd zwj 3630 "$TODO")"
note "  $(utrial url-upd zwj 3636 "$TODO")"

cell "CK-COUNT — how many checklist items ONE things:///add carries"
bmark "ck-count"
for SPEC in "50 6" "100 6" "101 6" "150 6"; do
  set -- $SPEC
  T="NOTECAP1-ckn-$1-$RUNTAG"
  D=$(nc_ url-add-ckn "$T" "$1" "$2" "CKN")
  waittitle "$T" >/dev/null
  U=$(uuidof "$T")
  sleep 6
  note "  requested $1 items (joined $(echo "$D" | jf joined) chars) -> landed $(gq "SELECT COUNT(*) FROM TMChecklistItem WHERE task='$U'")"
done

# ======================================================================= closeout
cell "CLOSEOUT"
note "  app $(alive)"
note "  rows: $(rowcount)"
note "  --- beep sentinel ---"
bs assert --name NOTECAP1 | sed 's/^/    /' | tee -a "$REPORT"
note ""
note "NOTECAP1 RUN COMPLETE $(date -u +%Y-%m-%dT%H:%M:%SZ)"
