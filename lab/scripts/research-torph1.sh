#!/bin/bash
# TORPH1 — timeout orphans and the same-key retry, driven by TWO CONCURRENT
# CLI PROCESSES inside one guest (issue #639).
#
# THE PROBLEM. `--op-id` promises that resubmitting a write is safe. The
# lookback that keeps that promise ran BEFORE the mutation lock on every path,
# so a retry fired while the ORIGINAL was still mid-drive found no record (the
# original had not finished writing one), queued behind the lock, and executed
# the whole verb again once the original released it. On a promote that is a
# second clone, a second trashed original and a second series. Nothing could
# see an in-flight keyed write at all: the trail's `intent` marker named no
# process, so "still running" and "died halfway" were one hedged answer.
#
# The fix under test: (a) the lookback is re-run immediately after lock
# acquisition, before the first mutating leg; (b) a keyed write appends a
# write-ahead intent naming its holder (pid + start time), so a live holder is
# REFUSED (`blocked:in-flight`) and a dead one is reconciled or refused
# honestly; (c) `things op-result` answers `in-flight` / `orphaned` instead of
# one `intent-only`.
#
# Unit tests can only simulate the race. These cells run it: two real `things`
# processes, in one guest, against one real Things app.
#
# CELLS
#   A  SAME-KEY RETRY MID-DRIVE. Launch a keyed GUI promote; while it is
#      driving, launch the identical command with the SAME key. The retry must
#      either refuse on the live-holder intent or, where it reached the lock
#      wait, replay on the post-acquire lookback. EXACTLY ONE series after.
#   B  HOLDER KILLED MID-DRIVE. SIGKILL the original mid-drive, then retry the
#      same key. The stale lock must be stolen, `op-result` must read the
#      holder as gone, and the retry must reconcile or refuse honestly —
#      never double-mint. Records what does NOT get cleaned up (the stranded
#      sheet; deputy-side execution, out of scope).
#   C  TWO DIFFERENT KEYS AT ONCE. Two keyed promotes on two different items,
#      launched simultaneously. Must SERIALIZE (one waits, or refuses
#      `blocked:lock`) and both must land exactly once.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (Things 3.23 / dbv27;
# the golden is NEVER booted). Airgap, clock pinned 2026-07-05 — well inside
# the trial wall (2026-07-18, REPX3); this campaign rolls no clocks.
# THINGS_API_UI_DIRECT=1 + THINGS_API_WRITE_DIRECT=1 on every guest CLI call
# (harness.md, The lab escapes). Beep sentinel default-on.
#
# CONCURRENCY DISCIPLINE: every pair of processes is launched, waited on and
# reaped INSIDE ONE ssh invocation, so nothing is ever left orphaned by a
# dropped connection (the BEEP1 measure.sh rule).
#
# Usage: bash lab/scripts/research-torph1.sh [cells…]   (default: A B C)
#   KEEP=1      leave the VM running
#   REUSE=1     attach to an already-running clone
#   SKIP_BUILD=1 reuse dist/
set -uo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=lab/scripts/env.sh
source lab/scripts/env.sh

export TART_HOME="${TART_HOME:-/Volumes/Workspace/tart}"
GOLDEN="things-lab-golden-v4"
VM="things-run-torph1"
RUNID="torph1-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$RUNID"
mkdir -p "$OUT"
KEEP="${KEEP:-0}"
REUSE="${REUSE:-0}"
CELLS=("$@")
[ ${#CELLS[@]} -eq 0 ] && CELLS=(A B C)

PASS=0
FAIL=0
note() { echo "$*" | tee -a "$OUT/log.txt"; }
verdict() { # verdict <name> <needle> <actual>
  if echo "$3" | grep -qF -- "$2"; then
    note "  PASS $1"
    PASS=$((PASS + 1))
  else
    note "  FAIL $1 — expected '$2' in: $3"
    FAIL=$((FAIL + 1))
  fi
}
verdict_eq() { # verdict_eq <name> <expected> <actual>
  if [ "$(echo "$3" | tr -d '[:space:]')" = "$2" ]; then
    note "  PASS $1 (= $2)"
    PASS=$((PASS + 1))
  else
    note "  FAIL $1 — expected exactly '$2', got '$3'"
    FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------- clone + boot
IP=""
if [ "$REUSE" = "1" ]; then
  IP="$(tart ip "$VM" 2>/dev/null || true)"
  if [ -n "$IP" ] && lab_ssh "$IP" true 2>/dev/null; then
    note "REUSE=1 — attached to running $VM at $IP"
  else IP=""; fi
fi

if [ -z "$IP" ]; then
  FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
  note "preflight: free ${FREEGB}GB · slots in use: $(tart list 2>/dev/null | grep -c running || true)"
  [ "${FREEGB:-0}" -lt 5 ] && {
    note "FATAL: <5GB free"
    exit 1
  }
  if [ "${SKIP_BUILD:-0}" = "1" ]; then note "SKIP_BUILD=1 — reusing dist/"; else
    note "building dist"
    npm run build >"$OUT/build.log" 2>&1 || {
      note "FATAL: build failed"
      exit 1
    }
  fi
  [ -f dist/cli/main.js ] || {
    note "FATAL: no dist/cli/main.js"
    exit 1
  }
  note "cloning $GOLDEN -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM"
  (tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 420) || {
    note "FATAL: no SSH"
    exit 1
  }
  note "ssh up at $IP"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
  AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
  [ "$AG" = "AIRGAP-OK" ] || {
    note "FATAL: airgap failed"
    exit 1
  }
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
  lab_mute_guest "$IP"
  note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
  BOOTSTRAP=1
else BOOTSTRAP=0; fi

cleanup() {
  if [ "$KEEP" = "1" ]; then
    note "KEEP=1 — leaving $VM running at $IP"
    return
  fi
  note "teardown: stop+delete $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "teardown done: $(tart list 2>/dev/null | grep -c "$VM" || true) row(s) named $VM remain"
}
trap cleanup EXIT

# ---------------------------------------------------------------- guest helpers
lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

if [ "$BOOTSTRAP" = "1" ]; then
  lab_scp lab/guest/beep-sentinel.sh "admin@$IP:/Users/admin/labh/beep-sentinel.sh" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/labh/beep-sentinel.sh' </dev/null
fi
beep_reset() { lab_ssh "$IP" '~/labh/beep-sentinel.sh reset' </dev/null >/dev/null; }
beep_mark() { lab_ssh "$IP" "~/labh/beep-sentinel.sh mark $(printf '%q' "$1")" </dev/null >/dev/null; }
beep_assert() { # beep_assert <tag> <allow>
  lab_ssh "$IP" "~/labh/beep-sentinel.sh assert --allow ${2:-0} --json ~/labh/beeps-$1.json --name torph1-$1" \
    </dev/null >"$OUT/beeps-$1.txt" 2>&1
  local rc=$?
  note "  BEEPS($1): rc=$rc · $(grep -iE 'beep|count' "$OUT/beeps-$1.txt" | tail -3 | tr '\n' ' ')"
  return $rc
}

# ---- ship the production bundle -------------------------------------------
if [ "$BOOTSTRAP" = "1" ]; then
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
  scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
  scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
  scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
fi
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
G() { lab_ssh "$IP" "$LAB_DIRECT $CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
CLIV=$(lab_ssh "$IP" "$CLI --version 2>&1 | tail -1" </dev/null)
case "$CLIV" in
  [0-9]*) note "guest CLI OK: things $CLIV" ;;
  *)
    note "FATAL: the guest CLI does not run — $CLIV"
    exit 1
    ;;
esac
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
TBLD=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleVersion' </dev/null)
DBV=$(gq "SELECT value FROM Meta WHERE key='databaseVersion'" | grep -o '<integer>[0-9]*' | grep -o '[0-9]*')
note "env: Things $TVER ($TBLD) / dbv $DBV / golden $GOLDEN / CLI $CLIV"

# ---------------------------------------------------------------- primitives
mktodo() { # mktodo <title> -> uuid
  lab_ssh "$IP" "open -g 'things:///add?title=$1&auth-token=$TOKEN'; sleep 4" </dev/null
  gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NULL LIMIT 1"
}
# How many LIVE repeating templates carry this title? The whole campaign's
# headline assertion: a promote that ran twice leaves two.
templates() { gq "SELECT COUNT(*) FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NOT NULL"; }
# Every row (live or trashed) with this title — catches a second clone that was
# trashed rather than promoted.
rows_all() { gq "SELECT COUNT(*) FROM TMTask WHERE title='$1'"; }
audit_lines() { # audit_lines <opId> — the trail rows carrying a key, in file order
  lab_ssh "$IP" "cat ~/.local/state/things-api/audit/*.jsonl 2>/dev/null | ~/things-lab/bin/node -e '
    let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{
      for (const l of s.split(\"\\n\")) { if(!l.trim())continue; let r; try{r=JSON.parse(l)}catch{continue}
        if (r.opId===\"$1\") console.log([r.ts,r.result,r.txn?.role??\"-\",r.vector??\"-\",\"t\"+(r.disruption??\"-\"),
          r.holder?(\"pid\"+r.holder.pid+\"@\"+String(r.holder.start).slice(0,24)):\"noholder\",
          r.expected?\"oracle\":\"no-oracle\",\"dur\"+r.durationMs].join(\" \")); }
    })'" </dev/null
}
reset_app() { # a clean window state between cells (URLEN1: modals survive a graceful quit)
  lab_ssh "$IP" 'pkill -x Things3 >/dev/null 2>&1; sleep 2; open -g -a Things3; sleep 6' </dev/null
}
sheets() { # any modal standing right now?
  lab_ssh "$IP" 'osascript -e "tell application \"System Events\" to tell process \"Things3\" to count (every sheet of every window)" 2>/dev/null || echo ERR' </dev/null
}

RULE="--frequency weekly --interval 1 --dangerously-drive-gui"

# ============================================================== CELL A
cellA() {
  note ""
  note "=== CELL A — same-key retry launched while the original is mid-drive ==="
  reset_app
  local T="TorphA"
  local U
  U=$(mktodo "$T")
  [ -n "$U" ] || {
    note "  FATAL: fixture not created"
    FAIL=$((FAIL + 1))
    return
  }
  note "  fixture $T = $U · templates before = $(templates "$T")"
  beep_reset
  beep_mark "A concurrent same-key promote"

  # BOTH processes live and die inside this ONE ssh invocation.
  #
  # The retry is not fired on a SLEEP but on an OBSERVATION: a third process
  # polls `op-result` until the key stops reading `unknown`, i.e. until the
  # original has actually written its write-ahead intent. A fixed sleep raced
  # the original's own preflight (first run: 2s landed before the intent, and
  # the cell measured nothing), and the whole point is to fire the retry INSIDE
  # the in-flight window rather than near it.
  lab_ssh "$IP" "cd ~ && cat > /tmp/torphA.sh <<'SH'
set -u
export $LAB_UI_DIRECT $LAB_WRITE_DIRECT
CLI=\"\$HOME/things-lab/bin/node \$HOME/things-lab/things-api/dist/cli/main.js\"
\$CLI todo make-repeating $U $RULE --op-id KA --json >/tmp/A-orig.json 2>/tmp/A-orig.err &
P1=\$!
# poll until the key becomes visible in the trail (max ~20s), keeping the FIRST
# non-unknown reading — that is the in-flight observation.
for i in \$(seq 1 60); do
  \$CLI op-result KA --json >/tmp/A-during.json 2>/dev/null
  grep -q '\"status\":\"unknown\"' /tmp/A-during.json || break
  sleep 0.33
done
echo \"POLLED=\$i\"
\$CLI todo make-repeating $U $RULE --op-id KA --json >/tmp/A-retry.json 2>/tmp/A-retry.err
echo \"RETRY_EXIT=\$?\"
wait \$P1
echo \"ORIG_EXIT=\$?\"
\$CLI op-result KA --json >/tmp/A-final.json 2>/dev/null
SH
bash /tmp/torphA.sh" </dev/null >"$OUT/A-run.txt" 2>&1
  note "  $(grep -E 'EXIT=|POLLED=' "$OUT/A-run.txt" | tr '\n' ' ')"
  lab_ssh "$IP" 'cat /tmp/A-orig.json' </dev/null >"$OUT/A-orig.json" 2>&1
  lab_ssh "$IP" 'cat /tmp/A-final.json' </dev/null >"$OUT/A-final.json" 2>&1
  note "  original: $(head -c 260 "$OUT/A-orig.json")"

  local DURING RETRY
  DURING=$(lab_ssh "$IP" 'cat /tmp/A-during.json' </dev/null)
  RETRY=$(lab_ssh "$IP" 'cat /tmp/A-retry.json /tmp/A-retry.err 2>/dev/null' </dev/null)
  printf '%s\n' "$DURING" >"$OUT/A-during.json"
  printf '%s\n' "$RETRY" >"$OUT/A-retry.json"
  note "  op-result WHILE running: $(echo "$DURING" | head -c 400)"
  note "  retry result:            $(echo "$RETRY" | head -c 400)"

  # The third process (op-result), run while the original was mid-drive, must
  # read the key as in flight — that is the whole point of the holder identity.
  verdict "A1 op-result reads in-flight while the original runs" '"status":"in-flight"' "$DURING"
  # The retry either refuses on the live holder (the new fast path) or, if it
  # got as far as the lock, replays on the post-acquire lookback. Both are the
  # fix working; what is forbidden is a second execution.
  if echo "$RETRY" | grep -qF 'in-flight'; then
    note "  PASS A2 retry REFUSED on the live-holder intent (blocked:in-flight)"
    PASS=$((PASS + 1))
  elif echo "$RETRY" | grep -qF '"alreadyApplied":true'; then
    note "  PASS A2 retry REPLAYED via the post-acquire lookback (alreadyApplied)"
    PASS=$((PASS + 1))
  else
    note "  FAIL A2 retry neither refused nor replayed: $RETRY"
    FAIL=$((FAIL + 1))
  fi
  sleep 3
  verdict_eq "A3 EXACTLY ONE series exists afterwards" "1" "$(templates "$T")"
  note "  trail for KA:"
  audit_lines KA | while read -r l; do note "    $l"; done
  beep_assert A 0 || true
}

# ============================================================== CELL B
cellB() {
  note ""
  note "=== CELL B — holder SIGKILLed mid-drive, then the same key retried ==="
  reset_app
  local T="TorphB"
  local U
  U=$(mktodo "$T")
  [ -n "$U" ] || {
    note "  FATAL: fixture not created"
    FAIL=$((FAIL + 1))
    return
  }
  note "  fixture $T = $U · templates before = $(templates "$T")"
  beep_reset
  beep_mark "B kill mid-drive"

  # Kill on an OBSERVATION, not a sleep: poll until the key reads in-flight —
  # i.e. the original holds the lock and has written its write-ahead intent —
  # and only then SIGKILL it. A fixed sleep killed it during its own preflight,
  # before any of the state this cell is about existed.
  lab_ssh "$IP" "cd ~ && cat > /tmp/torphB.sh <<'SH'
set -u
export $LAB_UI_DIRECT $LAB_WRITE_DIRECT
CLI=\"\$HOME/things-lab/bin/node \$HOME/things-lab/things-api/dist/cli/main.js\"
LOCK=\"\$HOME/.local/state/things-api/mutation.lock\"
\$CLI todo make-repeating $U $RULE --op-id KB --json >/tmp/B-orig.json 2>/tmp/B-orig.err &
P1=\$!
for i in \$(seq 1 60); do
  \$CLI op-result KB --json >/tmp/B-inflight.json 2>/dev/null
  grep -q '\"status\":\"in-flight\"' /tmp/B-inflight.json && break
  sleep 0.33
done
echo \"POLLED=\$i\"
echo \"LOCK-BEFORE-KILL: \$(cat \"\$LOCK\" 2>/dev/null || echo NO-LOCKFILE)\"
kill -9 \$P1 2>/dev/null
wait \$P1 2>/dev/null
echo \"ORIG_KILLED=\$?\"
sleep 1
echo \"LOCK-AFTER-KILL: \$(cat \"\$LOCK\" 2>/dev/null || echo NO-LOCKFILE)\"
# the killed node leaves its osascript child behind; reap it so the next cell
# starts clean (the STRANDED SHEET is what we are measuring, not a stray process)
pkill -x osascript >/dev/null 2>&1 || true
\$CLI op-result KB --json >/tmp/B-after-kill.json 2>/dev/null
SH
bash /tmp/torphB.sh" </dev/null >"$OUT/B-kill.txt" 2>&1
  note "  $(grep -E 'POLLED=|ORIG_KILLED=|LOCK-' "$OUT/B-kill.txt" | tr '\n' ' ')"
  lab_ssh "$IP" 'cat /tmp/B-inflight.json' </dev/null >"$OUT/B-inflight.json" 2>&1

  local AFTER
  AFTER=$(lab_ssh "$IP" 'cat /tmp/B-after-kill.json' </dev/null)
  printf '%s\n' "$AFTER" >"$OUT/B-after-kill.json"
  note "  op-result after the kill: $(echo "$AFTER" | head -c 500)"
  verdict "B1 op-result reads the holder as GONE (orphaned)" '"status":"orphaned"' "$AFTER"

  # What the kill did NOT clean up — REPORTED, never asserted. A killed driver
  # runs no abort path, so whatever it had already done to the app stands. Which
  # residue you get depends on which leg the kill landed on: a Repeat sheet if it
  # was mid-dialog, or (more often, since the clone+trash legs come first) a
  # SOURCE ALREADY IN THE TRASH. Both are the same gap — nothing on the app side
  # reaps a dead driver's work — and both are out of scope for #639, which is
  # about the TRAIL telling the truth about them.
  local SH
  SH=$(sheets)
  note "  B-note: modal sheets standing after the kill = $SH (a sheet is stranded"
  note "          only when the kill landed mid-dialog; the clone+trash legs run first)"
  note "  B-note: source row state after the kill: trashed=$(gq "SELECT trashed FROM TMTask WHERE uuid='$U'")"
  note "  B-note: no cleanup happens either way — deputy-side execution would be"
  note "          what reaps a killed drive's residue; out of scope here."

  # The retry, timed: a STOLEN stale lock returns fast; blocking on a dead
  # holder's lock would burn the full 30s wait.
  local T0 T1 RETRY
  T0=$(date +%s)
  RETRY=$(G "todo make-repeating $U $RULE --op-id KB --json")
  T1=$(date +%s)
  printf '%s\n' "$RETRY" >"$OUT/B-retry.json"
  note "  retry took $((T1 - T0))s: $(echo "$RETRY" | head -c 500)"
  if [ $((T1 - T0)) -lt 25 ]; then
    note "  PASS B2 the stale lock was STOLEN, not waited out ($((T1 - T0))s < 25s)"
    PASS=$((PASS + 1))
  else
    note "  FAIL B2 the retry waited out the lock timeout ($((T1 - T0))s)"
    FAIL=$((FAIL + 1))
  fi
  # Reconciled, refused honestly, or refused by the sheet preflight — any is
  # correct. A silent second execution is not.
  if echo "$RETRY" | grep -qE 'alreadyApplied|blocked:reconcile|"reason":"reconcile"|H-UI-DRIVE|ui-unreachable|blocked'; then
    note "  PASS B3 the retry reconciled or refused honestly (never a blind re-drive)"
    PASS=$((PASS + 1))
  else
    note "  NOTE B3 the retry EXECUTED — acceptable only if the oracle said the change was absent"
    note "         (verify B4 below: the count is what decides)"
  fi
  sleep 3
  local N
  N=$(templates "$T")
  if [ "$(echo "$N" | tr -d '[:space:]')" -le 1 ]; then
    note "  PASS B4 NOTHING double-minted (live templates titled $T = $N)"
    PASS=$((PASS + 1))
  else
    note "  FAIL B4 DOUBLE MINT — $N live templates titled $T"
    FAIL=$((FAIL + 1))
  fi
  note "  B-note: all rows (live+trashed) titled $T = $(rows_all "$T")"
  note "  trail for KB:"
  audit_lines KB | while read -r l; do note "    $l"; done
  # A killed GUI drive can beep (a keystroke arriving at a dying process's
  # dialog); count it, do not fail the campaign on it.
  beep_assert B 4 || note "  B-note: beeps over the allowance — see $OUT/beeps-B.txt"
  lab_ssh "$IP" 'pkill -x Things3 >/dev/null 2>&1; true' </dev/null
}

# ============================================================== CELL C
cellC() {
  note ""
  note "=== CELL C — two DIFFERENT keyed promotes launched simultaneously ==="
  reset_app
  local T1N="TorphC1" T2N="TorphC2"
  local U1 U2
  U1=$(mktodo "$T1N")
  U2=$(mktodo "$T2N")
  [ -n "$U1" ] && [ -n "$U2" ] || {
    note "  FATAL: fixtures not created"
    FAIL=$((FAIL + 1))
    return
  }
  note "  fixtures $T1N=$U1 $T2N=$U2"
  beep_reset
  beep_mark "C two concurrent distinct keys"

  lab_ssh "$IP" "cd ~ && cat > /tmp/torphC.sh <<'SH'
set -u
export $LAB_UI_DIRECT $LAB_WRITE_DIRECT
CLI=\"\$HOME/things-lab/bin/node \$HOME/things-lab/things-api/dist/cli/main.js\"
\$CLI todo make-repeating $U1 $RULE --op-id KC1 --json >/tmp/C-1.json 2>/tmp/C-1.err &
P1=\$!
\$CLI todo make-repeating $U2 $RULE --op-id KC2 --json >/tmp/C-2.json 2>/tmp/C-2.err &
P2=\$!
wait \$P1; echo \"C1_EXIT=\$?\"
wait \$P2; echo \"C2_EXIT=\$?\"
SH
bash /tmp/torphC.sh" </dev/null >"$OUT/C-run.txt" 2>&1
  note "  $(grep -E 'EXIT=' "$OUT/C-run.txt" | tr '\n' ' ')"

  local R1 R2
  R1=$(lab_ssh "$IP" 'cat /tmp/C-1.json /tmp/C-1.err 2>/dev/null' </dev/null)
  R2=$(lab_ssh "$IP" 'cat /tmp/C-2.json /tmp/C-2.err 2>/dev/null' </dev/null)
  printf '%s\n' "$R1" >"$OUT/C-1.json"
  printf '%s\n' "$R2" >"$OUT/C-2.json"
  note "  KC1: $(echo "$R1" | head -c 300)"
  note "  KC2: $(echo "$R2" | head -c 300)"

  # SERIALIZATION: two composites must never interleave their legs. Either the
  # second waited out the first (both ok) or it refused blocked:lock. What must
  # NOT happen is two half-promotes, or a promote that picked up the other's
  # clone (the promote selects its row by TITLE).
  local OKS
  OKS=$(printf '%s\n%s\n' "$R1" "$R2" | grep -c '"ok":true' || true)
  local LOCKS
  LOCKS=$(printf '%s\n%s\n' "$R1" "$R2" | grep -c 'blocked:lock' || true)
  note "  ok results = $OKS · blocked:lock refusals = $LOCKS"
  if [ "$((OKS + LOCKS))" -ge 2 ]; then
    note "  PASS C1 the two verbs SERIALIZED (ok+lock accounts for both)"
    PASS=$((PASS + 1))
  else
    note "  FAIL C1 unaccounted outcome — see $OUT/C-1.json / C-2.json"
    FAIL=$((FAIL + 1))
  fi
  sleep 3
  local N1 N2
  N1=$(templates "$T1N")
  N2=$(templates "$T2N")
  note "  live templates: $T1N=$N1 · $T2N=$N2"
  # Whichever landed must have landed EXACTLY once; a refused one is 0 and is
  # retried below so the "both eventually land" half of the cell is real.
  if [ "$(echo "$N1" | tr -d '[:space:]')" -le 1 ] && [ "$(echo "$N2" | tr -d '[:space:]')" -le 1 ]; then
    note "  PASS C2 neither verb landed twice"
    PASS=$((PASS + 1))
  else
    note "  FAIL C2 a verb landed more than once ($N1 / $N2)"
    FAIL=$((FAIL + 1))
  fi
  # Retry whichever was refused, VERBATIM with its own key — the resumption
  # promise. A key that already landed replays; a refused one runs.
  for pair in "KC1:$U1:$T1N" "KC2:$U2:$T2N"; do
    local K=${pair%%:*}
    local rest=${pair#*:}
    local UU=${rest%%:*}
    local TT=${rest#*:}
    if [ "$(templates "$TT" | tr -d '[:space:]')" = "0" ]; then
      note "  $TT was refused — resubmitting VERBATIM with $K"
      reset_app
      G "todo make-repeating $UU $RULE --op-id $K --json" >"$OUT/C-retry-$K.json" 2>&1
      sleep 3
    fi
    verdict_eq "C3 $TT landed exactly once after its own retry" "1" "$(templates "$TT")"
  done
  beep_assert C 0 || true
}

# ---------------------------------------------------------------- run
note "TORPH1 run $RUNID · cells: ${CELLS[*]}"
for c in "${CELLS[@]}"; do
  case "$c" in
    A) cellA ;;
    B) cellB ;;
    C) cellC ;;
    *) note "unknown cell: $c" ;;
  esac
done

note ""
note "================ TORPH1 SUMMARY ================"
note "PASS=$PASS FAIL=$FAIL"
note "artifacts: $OUT"
[ "$FAIL" -eq 0 ] || exit 1
