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
#                       ThingsCommon, write it to BOTH candidate domains (recon
#                       §5.4 is MEDIUM-HIGH, not HIGH), relaunch Things.
#   C  SOCKET         — does mcp.sock appear? stat it; re-read the socket list.
#   D  HANDSHAKE      — initialize / notifications/initialized / tools/list.
#   E  CALL           — GetTodayList, first page and full pagination over a
#                       seeded ~40-item synthetic Today list; page size, cursor
#                       contract, ThingsJSON shape.
#   F  CURSOR TTL     — hold a cursor, sleep, re-call; measure the expiry window.
#   G  NEGATIVES      — unknown tool; wrong-typed cursor; extra property
#                       (additionalProperties:false); resources/list; prompts/list;
#                       a plausible write name. Expect refusals, and a DB diff
#                       showing the whole session wrote nothing.
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
#                                                                    … speak
#                                                                    … teardown
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

CMD="${1:-}"
VM="${VM:-mcpsrv1-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"   # v5 once minted; the server is the same bytes on 3.23
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
SESSION="$OUT/session.env"
PIN="070512002026"   # 2026-07-05 12:00 — inside the trial wall (2026-07-18)
GROUP="JLMPQHK86H.com.culturedcode.ThingsMac"

note() { echo "[mcpsrv1] $*" | tee -a "$REPORT"; }
fatal() { note "FATAL: $*"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; exit 1; }
load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

TJSON='#!/bin/bash
URL=$(python3 -c "import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))" "$1" "$2")
open -g "$URL"'

# ---------------------------------------------------------------------------
# The key derivation, run IN THE GUEST against the guest's own binary. The
# recipe travels; the key does not (recon §5.3). Reads two constants:
#   * the 32-hex obfuscated id of THCFeature.mcpServer (a literal in the binary)
#   * __FAStringObfuscationDefaultKey, the 12-byte XOR key (six identical copies)
# and reproduces FADeobfuscatedUUID: hex -> 16 bytes, XOR key[i % 12], NSUUID.
FEATKEY='#!/usr/bin/env python3
import re, subprocess, sys, uuid
TC = "/Applications/Things3.app/Contents/Frameworks/ThingsCommon.framework/Versions/A/ThingsCommon"
OBF = "88c69644b0ee3912446353d03e99de8c"          # THCFeature.mcpServer, recon 5.2
blob = open(TC, "rb").read()
if OBF.encode() not in blob:
    sys.exit("obfuscated id not present in this build — re-derive from the initializer")
# __FAStringObfuscationDefaultKey is a local symbol; nm -a still names it.
out = subprocess.run(["nm", "-arch", "arm64", "-n", TC], capture_output=True, text=True).stdout
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
# The MCP client: raw JSON-RPC 2.0 over net.connect, NDJSON framing (recon §4.3).
# Dependency-free on purpose — the guest bundle carries node + dist + commander
# only, and the SDK would add nothing but a transport we already know the shape
# of. Prints one line per exchange: "> <sent>" / "< <received>".
MCPCLIENT='"use strict";
const net = require("net");
const path = process.argv[2];
const script = JSON.parse(process.argv[3]);   // [{method, params, id?, sleepBefore?}, ...]
const sock = net.connect(path);
let buf = "", id = 0, step = 0, pending = null;
const send = (o) => { const s = JSON.stringify(o); console.log("> " + s); sock.write(s + "\n"); };
function next() {
  if (step >= script.length) { sock.end(); return; }
  const s = script[step++];
  const go = () => {
    const msg = { jsonrpc: "2.0", method: s.method };
    if (s.params !== undefined) msg.params = s.params;
    if (!/^notifications\//.test(s.method)) { msg.id = ++id; pending = msg.id; }
    else pending = null;
    send(msg);
    if (pending === null) setImmediate(next);
  };
  if (s.sleepBefore) { console.log("# sleeping " + s.sleepBefore + "s"); setTimeout(go, s.sleepBefore * 1000); }
  else go();
}
sock.on("connect", () => { console.log("# connected " + path); next(); });
sock.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    console.log("< " + line);
    let m = null; try { m = JSON.parse(line); } catch (e) {}
    if (m && pending !== null && m.id === pending) { pending = null; next(); }
  }
});
sock.on("error", (e) => { console.log("# ERROR " + e.message); process.exitCode = 1; });
sock.on("close", () => console.log("# closed"));'

gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
mcp() { # mcp <json-script>
  lab_ssh "$IP" "~/things-lab/bin/node ~/labh/mcp-client.js ~/Library/Group\\ Containers/$GROUP/mcp.sock $(printf '%q' "$1")" </dev/null 2>&1
}
sockls() { lab_ssh "$IP" "ls -la ~/Library/Group\\ Containers/$GROUP/ | grep -i sock || echo '(no socket)'" </dev/null 2>&1; }
thsock() { lab_ssh "$IP" 'P=$(pgrep -x Things3); [ -n "$P" ] && (lsof -U -a -p "$P" | tail -n +2 | wc -l | tr -d " ") || echo "(Things not running)"' </dev/null 2>&1; }
dbmark() { gq "SELECT (SELECT count(*) FROM TMTask)||'/'||(SELECT count(*) FROM TMTag)||'/'||COALESCE((SELECT max(userModificationDate) FROM TMTask),0)"; }

case "$CMD" in

setup)
  : > "$REPORT"
  if tart list 2>/dev/null | awk '{print $NF}' | grep -q running; then
    note "FATAL: a VM is already running — ONE at a time"; exit 1
  fi
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

  lab_ssh "$IP" 'mkdir -p ~/labh ~/things-lab/bin' </dev/null
  lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<<"$GSQL"
  lab_ssh "$IP" 'cat > ~/labh/tjson.sh && chmod +x ~/labh/tjson.sh' <<<"$TJSON"
  lab_ssh "$IP" 'cat > ~/labh/featkey.py && chmod +x ~/labh/featkey.py' <<<"$FEATKEY"
  lab_ssh "$IP" 'cat > ~/labh/mcp-client.js' <<<"$MCPCLIENT"
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  note "shipped node + the probe helpers"

  note "warm-up launch"
  lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null

  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  [ -n "$TOKEN" ] || fatal "no auth token"
  TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
  TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
  MACOS=$(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)
  note "env: Things $TVER ($TBLD) / macOS $MACOS / golden $GOLDEN"

  # ---- fixtures: ~40 synthetic Today to-dos, to force pagination -----------
  STAMP=$(date +%H%M%S)
  ITEMS=""
  for i in $(seq -w 1 40); do
    ITEMS="$ITEMS{\"type\":\"to-do\",\"attributes\":{\"title\":\"MCP1-T$i-$STAMP\",\"when\":\"today\"}},"
  done
  lab_ssh "$IP" "~/labh/tjson.sh $(printf '%q' "$TOKEN") $(printf '%q' "[${ITEMS%,}]")" </dev/null; sleep 8
  N=$(gq "SELECT count(*) FROM TMTask WHERE title LIKE 'MCP1-T%-$STAMP' AND trashed=0")
  [ "$N" = "40" ] || fatal "fixtures did not land (got $N/40)"
  note "fixtures: 40 synthetic Today to-dos MCP1-T*-$STAMP"

  { echo "IP=$IP"; echo "TOKEN=$TOKEN"; echo "STAMP=$STAMP"; } > "$SESSION"
  note "setup DONE"
  ;;

baseline)
  load_session
  note "=== A BASELINE ==="
  note "container:      $(sockls)"
  note "Things sockets: $(thsock)"
  note "db mark:        $(dbmark)"
  ;;

flip)
  load_session
  note "=== B DERIVE + FLIP ==="
  KEY=$(lab_ssh "$IP" 'python3 ~/labh/featkey.py' </dev/null 2>&1) || fatal "key derivation failed: $KEY"
  case "$KEY" in
    [0-9A-F]*-*-*-*-*) : ;;
    *) fatal "key derivation did not yield a UUID: $KEY" ;;
  esac
  note "derived defaults key: ${KEY:0:8}-… (full value stays in the guest transcript only)"
  echo "KEY=$KEY" >> "$SESSION"
  # BOTH candidate domains (recon §5.4): the app-group suite is the likely one,
  # standard defaults is the unit-test branch. Writing both costs one command.
  lab_ssh "$IP" "defaults write $GROUP $(printf '%q' "$KEY") -bool true" </dev/null
  lab_ssh "$IP" "defaults write com.culturedcode.ThingsMac $(printf '%q' "$KEY") -bool true" </dev/null
  note "wrote both domains; relaunching Things"
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 5; open -g -a Things3; sleep 15' </dev/null

  note "=== C SOCKET ==="
  for i in $(seq 1 15); do
    S=$(sockls); case "$S" in *mcp.sock*) break;; esac; sleep 2
  done
  note "container:      $S"
  note "Things sockets: $(thsock)"
  case "$S" in
    *mcp.sock*) note "SOCKET UP" ;;
    *) note "SOCKET ABSENT — the flag is necessary-but-not-sufficient; record this and stop here" ;;
  esac
  ;;

speak)
  load_session
  note "=== D HANDSHAKE + tools/list ==="
  mcp '[{"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcpsrv1-probe","version":"0"}}},
        {"method":"notifications/initialized"},
        {"method":"tools/list","params":{}}]' | tee -a "$REPORT"

  note "=== E CALL: GetTodayList, first page ==="
  mcp '[{"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcpsrv1-probe","version":"0"}}},
        {"method":"notifications/initialized"},
        {"method":"tools/call","params":{"name":"GetTodayList","arguments":{}}}]' | tee -a "$REPORT"
  note "(pagination: re-run the call step with the returned cursor until nextCursor is absent —"
  note " the cursor is opaque and per-session, so the loop has to be driven from the transcript)"

  note "=== F CURSOR TTL ==="
  mcp '[{"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcpsrv1-probe","version":"0"}}},
        {"method":"notifications/initialized"},
        {"method":"tools/call","params":{"name":"GetTodayList","arguments":{}}},
        {"method":"tools/call","params":{"name":"GetTodayList","arguments":{"cursor":"REPLACE-WITH-CURSOR"}},"sleepBefore":120}]' | tee -a "$REPORT"

  note "=== G NEGATIVES ==="
  mcp '[{"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcpsrv1-probe","version":"0"}}},
        {"method":"notifications/initialized"},
        {"method":"tools/call","params":{"name":"NoSuchTool","arguments":{}}},
        {"method":"tools/call","params":{"name":"AddTodo","arguments":{"title":"MCP1-WRITE-PROBE"}}},
        {"method":"tools/call","params":{"name":"GetTodayList","arguments":{"cursor":123}}},
        {"method":"tools/call","params":{"name":"GetTodayList","arguments":{"cursor":"x","extra":true}}},
        {"method":"resources/list","params":{}},
        {"method":"prompts/list","params":{}}]' | tee -a "$REPORT"

  note "db mark after the whole session: $(dbmark)   (must equal the baseline mark)"
  note "write probe landed? $(gq "SELECT count(*) FROM TMTask WHERE title='MCP1-WRITE-PROBE'")   (must be 0)"
  ;;

teardown)
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "clone deleted"
  ;;

*)
  echo "usage: research-mcpsrv1.sh <setup|baseline|flip|speak|teardown>" >&2; exit 2 ;;
esac
