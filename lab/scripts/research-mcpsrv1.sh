#!/bin/bash
# MCPSRV1 phase 2 — enable Things' own MCP server in a guest and speak MCP to it.
#
# THE QUESTION. Phase 1 (docs/lab/mcpsrv1-static-recon.md) read the whole thing
# out of the bundle: Things 3.23+ carries an in-process MCP server
# (`THCThingsMCPServerComponent`), speaking MCP 2025-06-18 as newline-delimited
# JSON-RPC over a unix socket at `mcp.sock` inside the app group container
# (JLMPQHK86H.com.culturedcode.ThingsMac), with exactly one capability (`tools`)
# and exactly one tool (`GetTodayList`, a paginated ThingsJSON READ). It is off
# behind the internal feature toggle `THCFeature.mcpServer`, whose activation is
# `.explicitThroughUserDefaults(obfuscatedUUID: "88c6…")` — an NSUserDefaults
# boolean whose key is that hex XOR-ed against a 12-byte constant in the binary
# and formatted as a UUID (recon §5.3).
#
# What nobody has measured is whether flipping that default actually brings the
# socket up, and what the server says when you talk to it. That is this script.
#
# THE CELLS:
#   A  BASELINE       — no mcp.sock in the container; Things holds 0 unix sockets.
#   B  DERIVE + FLIP  — derive the defaults key IN THE GUEST from the guest's own
#                       ThingsCommon, then try the candidate domains ONE AT A
#                       TIME (recon §5.4 is MEDIUM-HIGH, not HIGH) so that which
#                       domain enables it is itself a finding.
#   C  SOCKET         — does mcp.sock appear? stat it; re-read the socket list;
#                       does it survive a quit/relaunch, and does it precede the
#                       main window?
#   D  HANDSHAKE      — initialize / notifications/initialized / tools/list.
#   E  CALL           — GetTodayList, first page and full pagination over a
#                       seeded ~40-item synthetic Today list; page size, cursor
#                       contract, ThingsJSON shape, ordering vs the app's.
#   F  CURSOR TTL     — hold a cursor, sleep, re-call; measure the expiry window.
#   G  NEGATIVES      — unknown tool; wrong-typed cursor; extra property
#                       (additionalProperties:false); resources/list; prompts/list;
#                       ping; a JSON-RPC batch; a malformed line; a second
#                       concurrent client; an older protocolVersion; a plausible
#                       write name. Expect refusals, and a full-row DB diff
#                       showing the whole session wrote nothing.
#   H  LATENCY        — cold (connect+initialize+first call) and warm per-call.
#
# RESULT (2026-09-14, golden-v5 / Things 3.24 32400006 / macOS 15.7.7 / dbv 29,
# written up in docs/lab/mcpsrv1-guest-probe.md): cells A, B, C and the CONTROL
# ran; D–H did NOT, because the socket never came up. The defaults key derives
# correctly and lands in the app's own app-group preferences, but no domain, no
# value type and no launch shape brings `mcp.sock` into existence — and two
# OTHER `.explicitThroughUserDefaults` flags are equally inert, so this is a
# property of the feature-toggle machinery on a stock build, not of mcpServer.
# The `speak` cell and lab/scripts/mcpsrv1-probe.js are written and unexercised;
# they are the instrument for a phase 3 that first finds the real gate.
#
# METHOD: ONE disposable clone at a time (the goldens are NEVER booted).
# Airgapped, clock pinned inside the trial wall, fixtures fully synthetic.
# PROBE ONLY — nothing here is a shipped operation, and nothing in this script
# runs against the maintainer's host: every command below is `lab_ssh` into the
# clone. DIRECT execution is correct here (lab probes are direct by design).
#
#   TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-mcpsrv1.sh setup
#                                                                    … baseline
#                                                                    … flip
#                                                                    … control
#                                                                    … speak
#                                                                    … lifecycle
#                                                                    … diff
#                                                                    … teardown
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-mcpsrv1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v5}"   # 3.24; the server is the same bytes on v4/3.23
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — inside the trial wall (2026-07-18)
GROUP="JLMPQHK86H.com.culturedcode.ThingsMac"
SOCKPATH="\$HOME/Library/Group Containers/$GROUP/mcp.sock"

note() { echo "[mcpsrv1] $*" | tee -a "$REPORT"; }
fatal() { note "FATAL: $*"; exit 1; }
load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }
# `lab_scp` (env.sh) already retries the clone-boot auth flap AND removes the
# remote destination before retrying a RECURSIVE copy — without which a flap
# mid-transfer lands `dist/dist` and the guest CLI silently has no entry point.
# Do not hand-roll a retry here; just add `-O` and report a hard failure.
scpO() { lab_scp -O "$@" || fatal "scp failed: $*"; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

TJSON='#!/bin/bash
URL=$(python3 -c "import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))" "$1" "$2")
open -g "$URL"'

# A full-fidelity row dump of every live TMTask, for the zero-mutation diff.
# Every column, dates decoded, blobs hashed — the same shape ORD19 used.
ROWSNAP='import sqlite3, glob, hashlib
db=glob.glob("/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite")[0]
c=sqlite3.connect("file:%s?mode=ro"%db, uri=True); c.row_factory=sqlite3.Row
for t in ("TMTask","TMArea","TMTag","TMChecklistItem"):
    try: rows=c.execute("SELECT * FROM %s ORDER BY uuid"%t).fetchall()
    except Exception as e: print("%s\tERROR\t%s"%(t,e)); continue
    for r in rows:
        for k in r.keys():
            v=r[k]
            if isinstance(v,bytes): v="blob:sha256:"+hashlib.sha256(v).hexdigest()[:16]+":len"+str(len(v))
            print("%s\t%s\t%s\t%s"%(t,r["uuid"],k,v))'

# ---------------------------------------------------------------------------
# The key derivation, run IN THE GUEST against the guest's own binary. The
# recipe travels; the key does not (recon §5.3). Reads two constants:
#   * the 32-hex obfuscated id of THCFeature.mcpServer (a literal in the binary)
#   * __FAStringObfuscationDefaultKey, the 12-byte XOR key (six identical copies)
# and reproduces FADeobfuscatedUUID: hex -> 16 bytes, XOR key[i % 12], NSUUID.
FEATKEY='#!/usr/bin/env python3
import re, subprocess, sys, uuid
TC = "/Applications/Things3.app/Contents/Frameworks/ThingsCommon.framework/Versions/A/ThingsCommon"
# THCFeature.mcpServer (recon 5.2) by default; any other flag'"'"'s obfuscated id
# may be passed as argv[1] (see the `control` cell).
OBF = sys.argv[1] if len(sys.argv) > 1 else "88c69644b0ee3912446353d03e99de8c"
blob = open(TC, "rb").read()
if OBF.encode() not in blob:
    sys.exit("obfuscated id not present in this build — re-derive from the initializer")
# __FAStringObfuscationDefaultKey is a local symbol; nm -a still names it.
out = subprocess.run(["nm", "-arch", "arm64", "-n", "-a", TC], capture_output=True, text=True).stdout
addrs = [int(l.split()[0], 16) for l in out.splitlines() if l.endswith("__FAStringObfuscationDefaultKey")]
if not addrs:
    sys.exit("no __FAStringObfuscationDefaultKey symbol")
# fat file: locate the arm64 slice offset so vmaddr -> file offset
fat = subprocess.run(["otool", "-f", "-arch", "all", TC], capture_output=True, text=True).stdout
offs = [int(m) for m in re.findall(r"offset (\d+)", fat)]
base = offs[-1] if len(offs) > 1 else 0
keys = {blob[base + a: base + a + 12] for a in addrs}
if len(keys) != 1:
    sys.exit("obfuscation key copies disagree: %r" % keys)
k = keys.pop()
h = bytes.fromhex(OBF)
print(str(uuid.UUID(bytes=bytes(h[i] ^ k[i % 12] for i in range(16)))).upper())'

# ---------------------------------------------------------------------------
# Launch Things and record, at 0.4s resolution, WHEN the socket appears versus
# when the first standard window does. Answers "is the socket up before the UI".
MCPWATCH='#!/bin/bash
SOCK="$HOME/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/mcp.sock"
T0=$(python3 -c "import time;print(time.time())")
now() { python3 -c "import time,sys;print(round(time.time()-float(sys.argv[1]),2))" "$T0"; }
open -g -a Things3
S=""; W=""
for i in $(seq 1 100); do
  [ -z "$S" ] && [ -S "$SOCK" ] && S=$(now)
  if [ -z "$W" ]; then
    N=$(osascript -e "tell application \"System Events\" to count windows of process \"Things3\"" 2>/dev/null)
    [ -n "$N" ] && [ "$N" != "0" ] && W=$(now)
  fi
  [ -n "$S" ] && [ -n "$W" ] && break
  sleep 0.4
done
echo "socket_at=${S:-never} window_at=${W:-never}"'

gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
sockls() { lab_ssh "$IP" "ls -la ~/Library/Group\\ Containers/$GROUP/ | grep -i sock || echo '(no socket)'" </dev/null 2>&1; }
sockstat() { lab_ssh "$IP" "stat -f '%Sp %Su:%Sg %z bytes' \"$SOCKPATH\" 2>/dev/null || echo '(no socket)'" </dev/null 2>&1; }
thsock() { lab_ssh "$IP" 'P=$(pgrep -x Things3); [ -n "$P" ] && (lsof -U -a -p "$P" | tail -n +2 | wc -l | tr -d " ") || echo "(Things not running)"' </dev/null 2>&1; }
thsockls() { lab_ssh "$IP" 'P=$(pgrep -x Things3); [ -n "$P" ] && lsof -U -a -p "$P" || echo "(Things not running)"' </dev/null 2>&1; }
dbmark() { gq "SELECT (SELECT count(*) FROM TMTask)||'/'||(SELECT count(*) FROM TMTag)||'/'||COALESCE((SELECT max(userModificationDate) FROM TMTask),0)"; }
# Graceful quit, then the URLEN1 `pkill -x Things3` rule, then cfprefsd — the
# preferences daemon caches the app's defaults and will write its own copy back
# over the plist, so it has to go before any out-of-app `defaults write`.
quitthings() { lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit" >/dev/null 2>&1; sleep 5; pkill -x Things3 >/dev/null 2>&1; sleep 3; killall cfprefsd >/dev/null 2>&1; sleep 2' </dev/null; }
# A FULL activation, not `open -g`. A background launch leaves parts of the
# reactive graph unbuilt, which would make a negative result unfalsifiable.
launchthings() { lab_ssh "$IP" 'open -a Things3; sleep 18; osascript -e "tell application \"Things3\" to activate" >/dev/null 2>&1; sleep 8' </dev/null; }
relaunch() { quitthings; launchthings; }
waitsock() { # waitsock <seconds>
  local n=$((${1:-30} / 2))
  for _ in $(seq 1 "$n"); do
    lab_ssh "$IP" "test -S \"$SOCKPATH\"" </dev/null 2>/dev/null && return 0
    sleep 2
  done
  return 1
}
snap() { lab_ssh "$IP" 'python3 ~/labh/rowsnap.py' </dev/null > "$OUT/$1.tsv" 2>"$OUT/$1.err"; note "snapshot $1: $(wc -l < "$OUT/$1.tsv" | tr -d ' ') cells"; }

case "$CMD" in

setup)
  : > "$REPORT"
  RUNNING=$(tart list 2>/dev/null | awk 'NR>1 && $NF=="running" {print $2}')
  [ -z "$RUNNING" ] || fatal "a VM is already running ($RUNNING) — ONE at a time"
  AVAIL=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
  [ "$AVAIL" -ge 11 ] || fatal "only ${AVAIL}GiB free on /Volumes/Workspace — refusing to clone"
  note "disk before: ${AVAIL}GiB free"

  [ -f dist/cli/main.js ] || npm run build >"$OUT/build.log" 2>&1 || fatal "build failed"

  note "cloning $GOLDEN -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM" || fatal "clone failed"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 600) || fatal "no SSH"
  note "ssh up at $IP"

  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  [ "$AG" = "AIRGAP-OK" ] || fatal "airgap failed"
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"

  lab_ssh "$IP" 'mkdir -p ~/labh ~/things-lab/bin ~/things-lab/things-api/node_modules ~/labh/art' </dev/null
  lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<<"$GSQL"
  lab_ssh "$IP" 'cat > ~/labh/tjson.sh && chmod +x ~/labh/tjson.sh' <<<"$TJSON"
  lab_ssh "$IP" 'cat > ~/labh/featkey.py' <<<"$FEATKEY"
  lab_ssh "$IP" 'cat > ~/labh/rowsnap.py' <<<"$ROWSNAP"
  lab_ssh "$IP" 'cat > ~/labh/mcpwatch.sh && chmod +x ~/labh/mcpwatch.sh' <<<"$MCPWATCH"
  scpO lab/scripts/mcpsrv1-probe.js "admin@$IP:/Users/admin/labh/mcpsrv1-probe.js" >/dev/null

  NODE_BIN=$(node -e 'console.log(process.execPath)')
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO -r "$(lab_commander_dir)" "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  note "shipped node + dist + the probe helpers"

  note "warm-up launch"
  lab_ssh "$IP" 'open -g -a Things3; sleep 16' </dev/null

  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  [ -n "$TOKEN" ] || fatal "no auth token"
  TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
  TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
  MACOS=$(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)
  # The schema stamp lives in Meta as a plist-encoded integer, not in
  # PRAGMA user_version (which is 0 in every Things database we have seen).
  DBV=$(gq "SELECT value FROM Meta WHERE key LIKE '%ersion%' LIMIT 1" | grep -o '<integer>[0-9]*' | grep -o '[0-9]*')
  note "env: Things $TVER ($TBLD) / macOS $MACOS / dbv $DBV / golden $GOLDEN"

  CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
  lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1

  # ---- fixtures: ~40 synthetic Today items, deliberately varied ------------
  STAMP=$(date +%H%M%S)
  note "seeding fixtures (stamp $STAMP)"
  # Tags must pre-exist — the URL scheme applies tags, it does not create them.
  lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to make new tag with properties {name:\"MCP1-tag-$STAMP\"}'" </dev/null >/dev/null 2>&1
  lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to make new tag with properties {name:\"MCP1-other-$STAMP\"}'" </dev/null >/dev/null 2>&1
  sleep 2

  # An AREA cannot be seeded through ThingsJSON. Things' importer accepts only
  # `to-do` and `project` at top level, and — this is the trap — it rejects the
  # WHOLE payload atomically when it meets an element it does not know: a single
  # `{"type":"area"}` silently took all 40 items down with it on the first run
  # of this probe. Areas come from AppleScript; the project then references one
  # by title.
  lab_ssh "$IP" "osascript -e 'tell application \"Things3\" to make new area with properties {name:\"MCP1-Area-$STAMP\"}'" </dev/null >/dev/null 2>&1
  sleep 2

  # Seeded in BATCHES, each verified. Same reason: one bad element loses the lot,
  # so a batch that fails names itself instead of leaving a mystery zero.
  seed_batch() { # seed_batch <label> <json-array> <expected-title-prefix> <expected-count>
    lab_ssh "$IP" "~/labh/tjson.sh $(printf '%q' "$TOKEN") $(printf '%q' "$2")" </dev/null
    sleep 6
    local got
    got=$(gq "SELECT count(*) FROM TMTask WHERE title LIKE '$3%' AND trashed=0")
    note "  batch $1: $got/$4"
    [ "${got:-0}" -ge "$4" ] || fatal "batch $1 did not land ($got/$4)"
  }

  # 28 plain Today to-dos, to force pagination
  ITEMS=""
  for i in $(seq -w 1 28); do
    ITEMS="$ITEMS{\"type\":\"to-do\",\"attributes\":{\"title\":\"MCP1-T$i-$STAMP\",\"when\":\"today\"}},"
  done
  seed_batch plain "[${ITEMS%,}]" "MCP1-T" 28

  # a Today project in that area, with a heading and two Today children
  seed_batch project \
    "[{\"type\":\"project\",\"attributes\":{\"title\":\"MCP1-Proj-$STAMP\",\"when\":\"today\",\"area\":\"MCP1-Area-$STAMP\",\"notes\":\"synthetic project note\",\"items\":[{\"type\":\"heading\",\"attributes\":{\"title\":\"MCP1-Head-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"MCP1-PChild1-$STAMP\",\"when\":\"today\",\"heading\":\"MCP1-Head-$STAMP\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"MCP1-PChild2-$STAMP\",\"when\":\"today\"}}]}}]" \
    "MCP1-P" 3

  # the rich one: notes, two tags, a deadline, a checklist
  seed_batch rich \
    "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"MCP1-Rich-$STAMP\",\"when\":\"today\",\"notes\":\"synthetic note line one\\nline two\",\"tags\":[\"MCP1-tag-$STAMP\",\"MCP1-other-$STAMP\"],\"deadline\":\"2026-07-10\",\"checklist-items\":[{\"type\":\"checklist-item\",\"attributes\":{\"title\":\"MCP1-CL1\"}},{\"type\":\"checklist-item\",\"attributes\":{\"title\":\"MCP1-CL2\",\"completed\":true}}]}}]" \
    "MCP1-Rich" 1

  # an overdue deadline, an evening item, a completed item, a canceled item,
  # and two that become repeating templates below
  seed_batch states \
    "[{\"type\":\"to-do\",\"attributes\":{\"title\":\"MCP1-Overdue-$STAMP\",\"when\":\"today\",\"deadline\":\"2026-07-01\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"MCP1-Evening-$STAMP\",\"when\":\"evening\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"MCP1-Done-$STAMP\",\"when\":\"today\",\"completed\":true}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"MCP1-Cancelled-$STAMP\",\"when\":\"today\",\"canceled\":true}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"MCP1-Rep1-$STAMP\",\"when\":\"today\"}},{\"type\":\"to-do\",\"attributes\":{\"title\":\"MCP1-Rep2-$STAMP\",\"when\":\"today\"}}]" \
    "MCP1-" 38

  N=$(gq "SELECT count(*) FROM TMTask WHERE title LIKE 'MCP1-%-$STAMP' AND trashed=0")
  note "fixture rows landed: $N"

  # Repeating templates, through the UI vector — ThingsJSON cannot express a
  # repeat rule at all. `make-repeating` addresses a to-do by uuid (or partial
  # uuid), never by title, so resolve first.
  for R in Rep1 Rep2; do
    RU=$(gq "SELECT uuid FROM TMTask WHERE title='MCP1-$R-$STAMP' AND trashed=0 LIMIT 1")
    OUT_R=$(lab_ssh "$IP" "$LAB_DIRECT $CLI todo make-repeating $RU --frequency daily --interval 1 --dangerously-drive-gui 2>&1; echo EXIT=\$?" </dev/null 2>&1)
    note "make-repeating $R ($RU): $(echo "$OUT_R" | tail -2 | tr '\n' ' ')"
  done
  sleep 4
  TMPL=$(gq "SELECT count(*) FROM TMTask WHERE title LIKE 'MCP1-Rep%-$STAMP' AND rt1_recurrenceRule IS NOT NULL")
  note "repeating templates: $TMPL"

  { echo "IP=$IP"; echo "TOKEN=$TOKEN"; echo "STAMP=$STAMP"; echo "TVER=$TVER"; echo "TBLD=$TBLD"; echo "MACOS=$MACOS"; echo "DBV=$DBV"; echo "GOLDEN=$GOLDEN"; } > "$SESSION"
  note "setup DONE"
  ;;

baseline)
  load_session
  note "=== A BASELINE (flag OFF) ==="
  note "container:      $(sockls)"
  note "socket stat:    $(sockstat)"
  note "Things sockets: $(thsock)"
  note "unix socket list:"; thsockls | tee -a "$REPORT"
  note "db mark:        $(dbmark)"
  snap baseline-rows
  note "today (app order, from SQLite):"
  lab_ssh "$IP" "~/labh/gsql.sh \"SELECT todayIndex, title FROM TMTask WHERE trashed=0 AND status=0 AND start=1 AND startDate IS NOT NULL ORDER BY todayIndex\"" </dev/null 2>&1 | tee -a "$REPORT" | head -60
  ;;

flip)
  load_session
  note "=== B DERIVE + FLIP ==="
  KEY=$(lab_ssh "$IP" 'python3 ~/labh/featkey.py' </dev/null 2>&1) || fatal "key derivation failed: $KEY"
  case "$KEY" in
    [0-9A-F]*-*-*-*-*) : ;;
    *) fatal "key derivation did not yield a UUID: $KEY" ;;
  esac
  note "derived defaults key: ${KEY:0:8}-… (the full value stays in the guest; recon §5.3 judgement call)"
  echo "KEY=$KEY" >> "$SESSION"

  # Candidates in descending order of prior probability (recon §5.4). One at a
  # time, each cleaned up if it fails, so that WHICH domain works is a finding.
  #
  # ORDER MATTERS: Things is quit BEFORE each write and launched after. A write
  # made while the app is running is not a fair test — cfprefsd holds the app's
  # cached prefs and rewrites the plist on quit, which can silently drop a key
  # an outside `defaults write` had just added.
  GC="\$HOME/Library/Group Containers/$GROUP/Library/Preferences/$GROUP"
  CC="\$HOME/Library/Containers/com.culturedcode.ThingsMac/Data/Library/Preferences/com.culturedcode.ThingsMac"
  ENABLED_BY=""
  try_domain() { # try_domain <label> <defaults-domain-arg>
    note "--- trying domain: $1"
    quitthings
    lab_ssh "$IP" "defaults write $2 $(printf '%q' "$KEY") -bool true" </dev/null 2>&1 | tee -a "$REPORT"
    note "    readback (pre-launch): $(lab_ssh "$IP" "defaults read $2 $(printf '%q' "$KEY") 2>&1" </dev/null)"
    launchthings
    note "    readback (post-launch): $(lab_ssh "$IP" "defaults read $2 $(printf '%q' "$KEY") 2>&1" </dev/null)"
    # The decisive readback is the APP-GROUP CONTAINER plist — the app's real
    # preferences home (it is where `uriSchemeEnabled` and `onboardingDidComplete`
    # live). A shell `defaults write <app-group-suite>` lands in
    # ~/Library/Preferences/<group>.plist instead, which the sandboxed app does
    # not read; checking only that copy would have made a failed flip look set.
    note "    in group-container plist: $(lab_ssh "$IP" "plutil -p \"$GC.plist\" | grep -c $(printf '%q' "$KEY")" </dev/null)"
    if waitsock 30; then
      note "    SOCKET UP under $1"
      ENABLED_BY="$1"
      return 0
    fi
    note "    no socket under $1 — reverting and moving on"
    lab_ssh "$IP" "defaults delete $2 $(printf '%q' "$KEY") >/dev/null 2>&1" </dev/null
    return 1
  }

  try_domain "app-group-suite ($GROUP)" "$GROUP" ||
    try_domain "app-group container plist" "\"$GC\"" ||
    try_domain "app sandbox container plist" "\"$CC\"" ||
    try_domain "plain standard domain (com.culturedcode.ThingsMac)" "com.culturedcode.ThingsMac" ||
    true

  # Last resort: every domain at once, and with an integer rather than a boolean
  # (the lookup casts to NSNumber, which both satisfy). If the socket is still
  # down after this, no single-domain mistake explains it.
  if [ -z "$ENABLED_BY" ]; then
    note "--- all four domains at once, -bool true then -int 1"
    for V in "-bool true" "-int 1"; do
      quitthings
      lab_ssh "$IP" "defaults write $GROUP $KEY $V; defaults write \"$GC\" $KEY $V; defaults write \"$CC\" $KEY $V; defaults write com.culturedcode.ThingsMac $KEY $V" </dev/null
      launchthings
      waitsock 20 && { ENABLED_BY="all-domains ($V)"; break; }
      note "    no socket with $V"
    done
  fi

  note "=== C SOCKET ==="
  note "enabled by:     ${ENABLED_BY:-NOTHING — the flag is necessary-but-not-sufficient}"
  note "container:      $(sockls)"
  note "socket stat:    $(sockstat)"
  note "Things sockets: $(thsock)"
  note "unix socket list:"; thsockls | tee -a "$REPORT"
  note "where the group-suite write actually landed:"
  lab_ssh "$IP" "ls -la ~/Library/Preferences/$GROUP.plist \"\$HOME/Library/Group Containers/$GROUP/Library/Preferences/\" 2>&1 | head -20" </dev/null 2>&1 | tee -a "$REPORT"
  echo "ENABLED_BY=$ENABLED_BY" >> "$SESSION"
  [ -n "$ENABLED_BY" ] || note "STOP: socket never came up; nothing to speak to"
  ;;

control)
  # THE CONTROL for a NEGATIVE flip result. If the mcpServer key does not bring
  # the socket up, the next question is whether the defaults-key mechanism works
  # AT ALL on a stock build, or whether we simply have the wrong domain. Two
  # other `.explicitThroughUserDefaults` flags carry visible oracles:
  #   copySelectionAsJSON  "Copy Selection as JSON"  -> an Edit-menu item
  #   experimentalNewMenus "Experimental New Menus"  -> the menu bar itself
  # Their obfuscated ids come out of the same initializers (recon §5.2 method);
  # the derivation is identical, so only the id changes.
  load_session
  note "=== CONTROL: do OTHER defaults-activated flags flip? ==="
  CSJ=$(lab_ssh "$IP" 'python3 ~/labh/featkey.py c82f61d3e087324553ae782c33adb4c3' </dev/null 2>&1)
  ENM=$(lab_ssh "$IP" 'python3 ~/labh/featkey.py 64469cf4c3d93200595365414292c175' </dev/null 2>&1)
  note "control keys derived: ${CSJ:0:8}-… / ${ENM:0:8}-…"
  EDIT='tell application "System Events" to tell process "Things3" to get name of every menu item of menu 1 of menu bar item "Edit" of menu bar 1'
  BAR='tell application "System Events" to tell process "Things3" to get name of every menu bar item of menu bar 1'
  note "Edit menu BEFORE: $(lab_ssh "$IP" "osascript -e $(printf '%q' "$EDIT") 2>&1" </dev/null)"
  note "menu bar BEFORE:  $(lab_ssh "$IP" "osascript -e $(printf '%q' "$BAR") 2>&1" </dev/null)"
  quitthings
  lab_ssh "$IP" "defaults write $GROUP $CSJ -bool true; defaults write $GROUP $ENM -bool true" </dev/null
  launchthings
  note "Edit menu AFTER:  $(lab_ssh "$IP" "osascript -e $(printf '%q' "$EDIT") 2>&1" </dev/null)"
  note "menu bar AFTER:   $(lab_ssh "$IP" "osascript -e $(printf '%q' "$BAR") 2>&1" </dev/null)"
  note "(identical before/after => the defaults-key mechanism itself is inert on a stock build,"
  note " and the mcpServer result is not a domain mistake specific to that one flag)"
  ;;

speak)
  load_session
  note "=== D–H SPEAK MCP ==="
  lab_ssh "$IP" "rm -rf ~/labh/art; mkdir -p ~/labh/art; ~/things-lab/bin/node ~/labh/mcpsrv1-probe.js \"$SOCKPATH\" ~/labh/art 2>&1" </dev/null 2>&1 | tee -a "$REPORT"
  mkdir -p "$OUT/art"
  scpO -r "admin@$IP:/Users/admin/labh/art/" "$OUT/" >/dev/null 2>&1 || note "artifact pull failed"
  note "artifacts: $(ls "$OUT/art" 2>/dev/null | tr '\n' ' ')"
  ;;

lifecycle)
  load_session
  note "=== C2 SOCKET LIFECYCLE ==="
  note "before quit: $(sockstat)"
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit" >/dev/null 2>&1; sleep 6' </dev/null
  note "after quit:  $(sockstat)   (acceptor is built with unlinkPathOnClose, recon §4.2)"
  note "relaunch timeline: $(lab_ssh "$IP" '~/labh/mcpwatch.sh' </dev/null 2>&1 | tail -1)"
  note "after relaunch: $(sockstat)"
  note "Things sockets: $(thsock)"
  # a hard kill leaves no chance to unlink — does a stale socket survive?
  lab_ssh "$IP" 'pkill -9 -x Things3; sleep 4' </dev/null
  note "after SIGKILL: $(sockstat)"
  note "relaunch after SIGKILL: $(lab_ssh "$IP" '~/labh/mcpwatch.sh' </dev/null 2>&1 | tail -1)"
  ;;

diff)
  load_session
  note "=== ZERO-MUTATION DIFF ==="
  snap after-rows
  if diff -u "$OUT/baseline-rows.tsv" "$OUT/after-rows.tsv" > "$OUT/rows.diff"; then
    note "row diff: IDENTICAL — zero mutation"
  else
    note "row diff: $(grep -c '^[+-][^+-]' "$OUT/rows.diff") changed cells"
    note "changed columns: $(grep '^[+-][^+-]' "$OUT/rows.diff" | awk -F'\t' '{print $3}' | sort | uniq -c | sort -rn | tr '\n' ' ')"
    head -60 "$OUT/rows.diff" | tee -a "$REPORT"
  fi
  note "db mark after: $(dbmark)"
  note "write probe landed? $(gq "SELECT count(*) FROM TMTask WHERE title='MCP1-WRITE-PROBE'")   (must be 0)"
  ;;

teardown)
  tart stop "$VM" >/dev/null 2>&1 || true
  sleep 3
  tart delete "$VM" >/dev/null 2>&1 || true
  note "clone deleted; disk now: $(df -g /Volumes/Workspace | awk 'NR==2{print $4}')GiB free"
  ;;

*)
  echo "usage: research-mcpsrv1.sh <setup|baseline|flip|control|speak|lifecycle|diff|teardown>" >&2; exit 2 ;;
esac
