#!/bin/bash
# APDG1 — does a SHIPPED verb reach the Things group container with its own
# syscall instead of routing through the reader, and what does that cost?
# (issue #664)
#
# The field report: `things rescue relaunch --yes --dangerously-force-quit
# --json`, run from a CLI hosted under an app with no Full Disk Access, put the
# macOS "access data from other apps" modal on screen — outside any ceremony,
# which the permissions doctrine (Article I) makes a constitutional bug — and
# then produced NO output at all before the caller's wait elapsed. Things had
# relaunched by then, so the verb's own job had already happened.
#
# THE FIELD MACHINE HAS THE HELPERS INSTALLED AND GRANTED. That is what makes
# this a ROUTING BYPASS rather than a missing degradation path: reads on that
# machine are authorized — the reader holds a durable grant over the container —
# and the code touched the container ANYWAY, on the host's own lineage, which
# holds nothing. Two shipped call sites do it:
#
#   `rescue relaunch` rung 5   locateThingsDb() globs inside the container and
#                              openConnection() opens the database there, with
#                              no consultation of the routing seam at all
#   `doctor` sync-health       defaultWalMtimeMs() stats `<db>-wal` directly,
#                              after the surrounding reads were routed
#
# Under a host holding FDA both are answered silently, which is why they lived
# so long: every terminal this project was developed in holds it.
#
# THE RIG. ONE disposable golden-v4 clone. An ssh-descended process in a clone
# inherits sshd-keygen-wrapper's FDA (SANDBOX1 probe-fidelity note; APDP1
# header), which is exactly the standing that HIDES this bug — so every measured
# cell runs inside its own fresh **Terminal.app** instance, which holds nothing.
# The reader is stood in for by `lab/guest/standin-reader.mjs`, launched over
# ssh so that IT holds the access, with the client pointed at it through
# THINGS_API_READER_DIR + THINGS_API_HELPERS=true. That split — grant in one
# process, caller in another — is the field's.
#
# One Terminal instance PER CELL, because a denial is pinned to the app instance
# (APDP1/TCCDUR1) and a reused instance would answer the next cell's question
# for it.
#
# Phase H — the field shape (helpers enabled, reader serving, client no FDA):
#   h0  PRE-FIX doctor    — expect a modal at sync-health's bare `stat`
#   h1  PRE-FIX relaunch  — expect a modal at locate's glob, and a PARKED process
#   h2  FIXED   relaunch  — expect no modal, and the check RUN through the reader
#   h3  FIXED   doctor    — expect no modal, the WAL line degraded honestly
#
# Phase N — the secondary shape (no helpers at all, client no FDA):
#   n1  PRE-FIX relaunch  — modal + park
#   n2  PRE-FIX relaunch again, SAME instance — post-deny fast-fail, no re-ask
#   n3  FIXED   relaunch  — no modal, the skip disclosed on the ladder
#   n4  FIXED   rescue status — the read-only verb, prompt-free
#
# Controls: c0 (PRE-FIX over ssh, holds FDA) and c6 (FIXED over ssh) — the
# behavior on a granted host, which must be identical before and after.
#
# NOTHING IS EVER GRANTED. Every modal is DENIED: what is under test is our
# behavior on a machine whose caller holds nothing.
#
# Usage: bash lab/scripts/research-apdg1.sh [--keep]
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="apdg1"
GOLDEN="things-lab-golden-v4"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1
OUT="lab/artifacts/$VM"
rm -rf "$OUT"; mkdir -p "$OUT/dlg" "$OUT/tcc" "$OUT/cells"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[apdg1] $*" | tee -a "$REPORT"; }
cleanup() {
  if [ "$KEEP" = "1" ]; then echo "[apdg1] --keep: leaving $VM running"; return; fi
  echo "[apdg1] teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

DIST_PRE="${APDG1_DIST_PRE:-/tmp/dist-prefix}"
DIST_FIX="${APDG1_DIST_FIX:-/tmp/dist-fixed}"
for d in "$DIST_PRE" "$DIST_FIX"; do
  [ -d "$d" ] || { note "FATAL: missing build at $d"; exit 1; }
done
NODE_BIN=$(node -e 'console.log(process.execPath)')

# ── clone + boot ─────────────────────────────────────────────────────────────
tart delete "$VM" >/dev/null 2>&1 || true
note "clone $GOLDEN -> $VM"
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 360) || { note "FATAL: no ssh"; exit 1; }
note "ssh up at $IP"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
note "airgap: $(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo FAIL || echo OK' </dev/null)"
# Clock pin BEFORE Things is ever launched. golden-v4's trial wall is
# 2026-07-18 and its pinned date is 2026-07-05 (harness.md).
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date' </dev/null)"
note "macOS: $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)  Things: $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)"

# ── ship both builds + the stand-in reader ───────────────────────────────────
D=/Users/admin/labh/apdg1
lab_ssh "$IP" "rm -rf $D ~/things-lab; mkdir -p $D ~/things-lab/bin" </dev/null
lab_scp "$NODE_BIN" "admin@$IP:things-lab/bin/node" >/dev/null
for pair in "pre:$DIST_PRE" "fix:$DIST_FIX"; do
  tag="${pair%%:*}"; src="${pair#*:}"
  lab_ssh "$IP" "mkdir -p ~/things-lab/app-$tag/node_modules ~/things-lab/app-$tag/bin" </dev/null
  lab_scp -r "$src" "admin@$IP:things-lab/app-$tag/dist" >/dev/null
  lab_scp -r node_modules/commander "admin@$IP:things-lab/app-$tag/node_modules/commander" >/dev/null
  lab_scp package.json "admin@$IP:things-lab/app-$tag/package.json" >/dev/null
  lab_scp bin/things.js "admin@$IP:things-lab/app-$tag/bin/things.js" >/dev/null
done
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
lab_scp lab/guest/standin-reader.mjs "admin@$IP:things-lab/standin-reader.mjs" >/dev/null
lab_scp lab/guest/beep-sentinel.sh "admin@$IP:things-lab/beep-sentinel.sh" >/dev/null
lab_scp lab/scripts/apdg1-axsys.jxa "admin@$IP:$D/axsys.jxa" >/dev/null
lab_ssh "$IP" 'chmod +x ~/things-lab/beep-sentinel.sh; bash ~/things-lab/beep-sentinel.sh reset' </dev/null
note "shipped: node + app-pre + app-fix + stand-in reader"
note "build identities: pre=$(lab_ssh "$IP" 'grep -c "was not checked" ~/things-lab/app-pre/dist/rescue.js' </dev/null)  fix=$(lab_ssh "$IP" 'grep -c "was not checked" ~/things-lab/app-fix/dist/rescue.js' </dev/null)  (0=pre-fix, 1=fixed)"

lab_ssh "$IP" "cat > $D/tccdump.sh && chmod +x $D/tccdump.sh" <<'EOF'
#!/bin/bash
UDB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
sqlite3 -line "file:$UDB?mode=ro" "SELECT service,client,client_type,auth_value,auth_reason FROM access WHERE service='kTCCServiceSystemPolicyAppData';" 2>&1
EOF
# Terminal must not restore prior windows: a restored session would blur "a new
# app instance" (a fresh grant question) with "the same shells back again".
lab_ssh "$IP" 'defaults write com.apple.Terminal NSQuitAlwaysKeepsWindows -bool false' </dev/null

# The container must exist and Things must be up before any relaunch cell.
lab_ssh "$IP" 'open -g -a Things3; sleep 10' </dev/null
DBPATH=$(lab_ssh "$IP" 'ls "$HOME/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/"ThingsData-*/"Things Database.thingsdatabase/main.sqlite"' </dev/null)
note "container db: $DBPATH"
note "wal present (over ssh, which holds FDA): $(lab_ssh "$IP" "test -f '$DBPATH-wal' && echo YES || echo NO" </dev/null)"

# ── host-side primitives ─────────────────────────────────────────────────────
dlgdump() { lab_ssh "$IP" "osascript -l JavaScript $D/axsys.jxa dump" </dev/null > "$OUT/dlg/$1.txt" 2>&1; }
presspfx() { lab_ssh "$IP" "osascript -l JavaScript $D/axsys.jxa pressprefix $(printf '%q' "$1")" </dev/null 2>&1; }
tccdump() { lab_ssh "$IP" "bash $D/tccdump.sh" </dev/null > "$OUT/tcc/$1.txt" 2>&1
  note "  [tcc $1] AppData rows: $(grep -c 'kTCCServiceSystemPolicyAppData' "$OUT/tcc/$1.txt")$(grep -E 'auth_value' "$OUT/tcc/$1.txt" | tr -s ' ' | tr '\n' ' ' | sed 's/^/  /')"; }
ensure_things() { lab_ssh "$IP" 'pgrep -x Things3 >/dev/null || { open -g -a Things3; sleep 8; }' </dev/null; }

# cell <label> <app: pre|fix> <expect-modal: yes|no> <envprefix> <args...>
# Runs ONE invocation inside its OWN fresh Terminal.app instance.
cell() {
  local L="$1" APP="$2" EXPECT="$3" ENVP="$4"; shift 4
  local t=0 modal=NO parked=NO
  note "---- cell $L [$APP] expect-modal=$EXPECT ----"
  lab_ssh "$IP" "bash ~/things-lab/beep-sentinel.sh mark $L" </dev/null >/dev/null 2>&1
  lab_ssh "$IP" 'killall -9 Terminal >/dev/null 2>&1; sleep 3' </dev/null
  {
    echo '#!/bin/bash'
    echo "exec >>\"$D/term.log\" 2>&1"
    echo "echo \$\$ > \"$D/$L.pid\""
    echo "echo \"MARK $L BEGIN ts=\$(date +%s)\""
    echo "( $ENVP \$HOME/things-lab/bin/node \$HOME/things-lab/app-$APP/bin/things.js $* ) > \"$D/$L.out\" 2> \"$D/$L.err\""
    echo "echo \"MARK $L END rc=\$? ts=\$(date +%s)\""
    echo "touch \"$D/done-$L\""
  } | lab_ssh "$IP" "cat > $D/$L.command && chmod +x $D/$L.command"
  lab_ssh "$IP" "rm -f $D/done-$L $D/$L.out $D/$L.err; open -a Terminal $D/$L.command" </dev/null
  while [ "$t" -lt 150 ]; do
    lab_ssh "$IP" "test -f $D/done-$L" </dev/null && break
    sleep 2; t=$((t + 2))
    if [ "$t" -ge 20 ] && [ "$modal" = "NO" ]; then
      dlgdump "$L"
      if grep -q 'access data from other apps' "$OUT/dlg/$L.txt"; then
        modal=YES; parked=YES
        note "  [$L] MODAL after ${t}s, and the verb has not returned:"
        grep -E 'access data from other apps|ttl=(Allow|Don)' "$OUT/dlg/$L.txt" | head -4 | sed 's/^/      /' | tee -a "$REPORT"
        # THE PARKED-SYSCALL EVIDENCE: what the process is doing while it waits.
        local shellpid kids
        shellpid=$(lab_ssh "$IP" "cat $D/$L.pid 2>/dev/null" </dev/null | tr -d ' \n')
        if [ -n "$shellpid" ]; then
          kids=$(lab_ssh "$IP" "pgrep -P $shellpid | tr '\n' ',' | sed 's/,\$//'" </dev/null | tr -d ' \n')
          [ -n "$kids" ] && lab_ssh "$IP" "ps -o pid,ppid,stat,command -p $kids" </dev/null | sed 's/^/      /' | tee -a "$REPORT"
          lab_ssh "$IP" "sudo launchctl procinfo $shellpid 2>&1 | grep -iE 'responsible (pid|path)' | head -3" </dev/null | sed 's/^/      /' | tee -a "$REPORT"
        fi
        note "  [$L] DENYING -> $(presspfx "Don")"
      else
        note "  [$L] no modal at ${t}s and no result yet"
      fi
    fi
  done
  lab_ssh "$IP" "test -f $D/done-$L" </dev/null || { parked="TIMEOUT"; note "  [$L] NEVER RETURNED in 150s"; }
  lab_scp "admin@$IP:$D/$L.out" "$OUT/cells/$L.out" >/dev/null 2>&1 || true
  note "  [$L] modal=$modal parked=$parked"
  note "  [$L] result: $(lab_ssh "$IP" "head -c 1400 $D/$L.out 2>/dev/null || echo NO-OUTPUT" </dev/null)"
  if [ "$modal" = "NO" ]; then
    dlgdump "$L-after"
    note "  [$L] any consent dialog left on screen? $(grep -q 'access data from other apps' "$OUT/dlg/$L-after.txt" && echo FOUND-ONE || echo CLEAN)"
  fi
}

RELAUNCH="rescue relaunch --yes --dangerously-force-quit --json"

# ── C0: the GRANTED control, PRE-FIX ─────────────────────────────────────────
note "==== c0: PRE-FIX over ssh (holds FDA) — the behavior to preserve ===="
tccdump 00-baseline
lab_ssh "$IP" "\$HOME/things-lab/bin/node \$HOME/things-lab/app-pre/bin/things.js $RELAUNCH" </dev/null \
  > "$OUT/cells/c0.out" 2>"$OUT/cells/c0.err"
note "  [c0] $(head -c 900 "$OUT/cells/c0.out")"

# ── PHASE H: the field shape ─────────────────────────────────────────────────
note "==== PHASE H — helpers enabled, reader serving, client without FDA ===="
RDIR="$D/reader"
lab_ssh "$IP" "mkdir -p $RDIR && printf 'labtoken-apdg1' > $RDIR/token && chmod 600 $RDIR/token" </dev/null
# The stand-in is started over ssh, so IT is the process holding the container
# access — exactly as the real reader holds the bookmark. Nothing detaches: the
# server runs under a wrapper that dies with the run.
lab_ssh "$IP" "nohup \$HOME/things-lab/bin/node \$HOME/things-lab/standin-reader.mjs --socket $RDIR/reader.sock --token labtoken-apdg1 --db '$DBPATH' > $D/reader.log 2>&1 & echo \$! > $D/reader.pid" </dev/null
sleep 3
note "  stand-in reader: $(lab_ssh "$IP" "cat $D/reader.log" </dev/null)"
HELPERS_ENV="THINGS_API_HELPERS=true THINGS_API_READER_DIR=$RDIR"
note "  client env: $HELPERS_ENV"
# Prove the routing is live from a host that HAS access, before testing one that has not.
lab_ssh "$IP" "$HELPERS_ENV \$HOME/things-lab/bin/node \$HOME/things-lab/app-fix/bin/things.js doctor --json" </dev/null \
  > "$OUT/cells/h-routing-probe.out" 2>&1
note "  routing live? $(grep -o '"mode":"helpers"' "$OUT/cells/h-routing-probe.out" | head -1) $(grep -o '"read":{"mode":"[a-z-]*"' "$OUT/cells/h-routing-probe.out" | head -1)"

ensure_things
cell h0 pre yes "$HELPERS_ENV" doctor --json
tccdump 01-after-h0
ensure_things
cell h1 pre yes "$HELPERS_ENV" $RELAUNCH
tccdump 02-after-h1
ensure_things
cell h2 fix no "$HELPERS_ENV" $RELAUNCH
ensure_things
cell h3 fix no "$HELPERS_ENV" doctor --json
tccdump 03-after-fixed-helpers

# ── PHASE N: no helpers at all ───────────────────────────────────────────────
note "==== PHASE N — no helpers (the secondary shape), client without FDA ===="
lab_ssh "$IP" "kill \$(cat $D/reader.pid) 2>/dev/null; sleep 1; rm -f $RDIR/reader.sock" </dev/null
NOHELP_ENV="THINGS_API_HELPERS=false"
ensure_things
cell n1 pre yes "$NOHELP_ENV" $RELAUNCH
# n2 deliberately REUSES n1's instance is impossible (cell() always restarts
# Terminal), so the post-deny law is measured by running n1's cell twice in one
# instance instead — see n2 below, which is driven inline.
note "---- cell n2 [pre] the SAME Terminal instance, immediately after n1's deny ----"
lab_ssh "$IP" "rm -f $D/done-n2 $D/n2.out; cat > $D/n2.command" <<EOF && lab_ssh "$IP" "chmod +x $D/n2.command"
#!/bin/bash
exec >>"$D/term.log" 2>&1
echo "MARK n2 BEGIN ts=\$(date +%s)"
( $NOHELP_ENV \$HOME/things-lab/bin/node \$HOME/things-lab/app-pre/bin/things.js $RELAUNCH ) > "$D/n2.out" 2>"$D/n2.err"
echo "MARK n2 END rc=\$? ts=\$(date +%s)"
touch "$D/done-n2"
EOF
ensure_things
N2_START=$(date +%s)
lab_ssh "$IP" "open -a Terminal $D/n2.command" </dev/null
for _ in $(seq 1 30); do lab_ssh "$IP" "test -f $D/done-n2" </dev/null && break; sleep 2; done
note "  [n2] elapsed ~$(( $(date +%s) - N2_START ))s (a post-deny fast-fail costs no dialog)"
dlgdump n2-after
note "  [n2] dialog on screen? $(grep -q 'access data from other apps' "$OUT/dlg/n2-after.txt" && echo FOUND-ONE || echo CLEAN)"
note "  [n2] result: $(lab_ssh "$IP" "head -c 900 $D/n2.out 2>/dev/null || echo NO-OUTPUT" </dev/null)"

ensure_things
cell n3 fix no "$NOHELP_ENV" $RELAUNCH
ensure_things
cell n4 fix no "$NOHELP_ENV" rescue status --json
tccdump 04-final

# ── C6: the GRANTED control, FIXED ───────────────────────────────────────────
note "==== c6: FIXED over ssh (holds FDA) — full behavior must be preserved ===="
ensure_things
lab_ssh "$IP" "bash ~/things-lab/beep-sentinel.sh mark c6" </dev/null >/dev/null 2>&1
lab_ssh "$IP" "\$HOME/things-lab/bin/node \$HOME/things-lab/app-fix/bin/things.js $RELAUNCH" </dev/null \
  > "$OUT/cells/c6.out" 2>"$OUT/cells/c6.err"
note "  [c6] $(head -c 900 "$OUT/cells/c6.out")"

# ── the beep sentinel ────────────────────────────────────────────────────────
note "==== beep sentinel ===="
lab_ssh "$IP" "THINGS_LAB_BEEPS_OK=1 bash ~/things-lab/beep-sentinel.sh assert --json $D/beeps.json" </dev/null \
  2>&1 | sed 's/^/      /' | tee -a "$REPORT"
lab_scp "admin@$IP:$D/beeps.json" "$OUT/beeps.json" >/dev/null 2>&1 || true
lab_scp "admin@$IP:$D/reader.log" "$OUT/reader.log" >/dev/null 2>&1 || true

note "==== guest terminal log ===="
lab_ssh "$IP" "cat $D/term.log" </dev/null | sed 's/^/      /' | tee -a "$REPORT"
note "APDG1 DONE — artifacts in $OUT"
