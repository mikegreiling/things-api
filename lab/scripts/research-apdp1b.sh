#!/bin/bash
# APDP1 phase 2 — the two failure modes a BOUNDED-CHILD provocation must
# survive, measured against the SAME clone phase 1 left running
# (`research-apdp1.sh --keep`; guest helpers already installed under
# ~/labh/apdp1).
#
#   Stage A (kill)  a child provokes the modal, the parent gives up and SIGKILLs
#                   it while the dialog is still on screen. Does the dialog
#                   survive the requester's death? Does a late Allow still land
#                   the grant for the responsible app? Does a sibling then read?
#   Stage B (deny)  a child provokes the modal and the human answers Don't Allow.
#                   Is the refusal recorded against the responsible app for the
#                   whole instance — i.e. does a second attempt fail SILENTLY
#                   rather than re-prompt?
#
# Usage: bash lab/scripts/research-apdp1b.sh [--keep]
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="apdp1"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1
OUT="lab/artifacts/$VM"; mkdir -p "$OUT/dlg" "$OUT/tcc"
REPORT="$OUT/report-b.txt"; : > "$REPORT"
note() { echo "[apdp1b] $*" | tee -a "$REPORT"; }
cleanup() {
  if [ "$KEEP" = "1" ]; then echo "[apdp1b] --keep: leaving $VM running"; return; fi
  echo "[apdp1b] teardown: $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

IP=$(tart ip "$VM") || { note "FATAL: $VM is not running — run research-apdp1.sh --keep first"; exit 1; }
D=/Users/admin/labh/apdp1
note "reusing clone $VM at $IP (phase-1 helpers expected under $D)"
lab_ssh "$IP" "test -f $D/tryopen.py" </dev/null || { note "FATAL: phase-1 helpers missing"; exit 1; }

dlgdump() { lab_ssh "$IP" "osascript -l JavaScript $D/axsys.jxa dump" </dev/null > "$OUT/dlg/$1.txt" 2>&1; }
press()   { lab_ssh "$IP" "osascript -l JavaScript $D/axsys.jxa press $(printf '%q' "$1")" </dev/null 2>&1; }
modalup() { dlgdump "$1"; grep -qE 'ttl=Allow' "$OUT/dlg/$1.txt" && echo YES || echo NO; }
tccrow()  {
  lab_ssh "$IP" "sqlite3 -noheader -list \"file:\$HOME/Library/Application Support/com.apple.TCC/TCC.db?mode=ro\" \"SELECT 'client='||client||' auth='||auth_value||' reason='||auth_reason||' pid='||pid||' pidver='||pid_version FROM access WHERE service='kTCCServiceSystemPolicyAppData';\"" </dev/null
}
mkparent() { # mkparent <file> <banner> <cell...>
  local file="$1" banner="$2"; shift 2
  {
    echo '#!/bin/bash'
    echo "D=$D"
    echo 'DB="$(cat $D/dbpath.txt)"'
    echo 'exec >>"$D/parent.log" 2>&1'
    echo "echo \"=== $banner pid=\$\$ ppid=\$PPID ts=\$(date +%s) ===\""
    for c in "$@"; do
      echo "while [ ! -f \"\$D/go-$c\" ]; do sleep 1; done"
      echo "echo \"MARK $c begin ts=\$(date +%s) shellpid=\$\$\""
      echo "/usr/bin/python3 \"\$D/tryopen.py\" $c \"\$DB\""
      echo "echo \"MARK $c end rc=\$? ts=\$(date +%s)\""
    done
    echo "echo \"$banner-DONE ts=\$(date +%s)\""
  } | lab_ssh "$IP" "cat > $D/$file && chmod +x $D/$file"
}

fresh_terminal() { # fresh_terminal <parent-file>
  # Stale go-* gates would make a freshly launched parent run its cells before
  # the host is watching for the modal.
  lab_ssh "$IP" "rm -f $D/go-*" </dev/null
  lab_ssh "$IP" 'killall -9 Terminal >/dev/null 2>&1; sleep 4; true' </dev/null
  lab_ssh "$IP" "open -a Terminal $D/$1" </dev/null
  sleep 8
  note "  Terminal pid: $(lab_ssh "$IP" 'pgrep -x Terminal | head -1' </dev/null)"
}
startcell() { lab_ssh "$IP" "rm -f $D/$1.json $D/$1.start; touch $D/go-$1" </dev/null; }
ended()    { lab_ssh "$IP" "grep -q '^MARK $1 end' $D/parent.log" </dev/null; }
result()   { lab_ssh "$IP" "cat $D/$1.json 2>/dev/null || echo NO-RESULT" </dev/null; }
cellpid()  { lab_ssh "$IP" "python3 -c \"import json;print(json.load(open('$D/$1.start'))['pid'])\" 2>/dev/null" </dev/null; }

# ── Stage A: the parent gives up and kills the blocked child ─────────────────
note "==== STAGE A — SIGKILL the blocked child while the modal is up ===="
mkparent parentA.command PARENTA k1 k2
fresh_terminal parentA.command
note "  TCC AppData row before: $(tccrow)"
startcell k1
sleep 10
note "  [k1] modal up after 10s: $(modalup a1-modal-up)"
KPID=$(cellpid k1)
note "  [k1] blocked child pid=$KPID — SIGKILL it (this is the bounded-wait giving up)"
lab_ssh "$IP" "kill -9 $KPID; sleep 3; ps -p $KPID >/dev/null 2>&1 && echo STILL-ALIVE || echo REAPED" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
note "  [k1] modal STILL up after the requester died: $(modalup a2-after-kill)"
note "  [k1] cell result after the kill: $(result k1)"
note "  [k1] TCC AppData row after the kill: $(tccrow)"
note "  [k1] now answer the orphaned dialog: $(press Allow)"
sleep 3
note "  [k1] modal after the late Allow: $(modalup a3-after-late-allow)"
note "  [k1] TCC AppData row after the late Allow: $(tccrow)"
note "  ---- k2: a sibling child in the SAME Terminal instance, after the late Allow ----"
startcell k2
for i in 1 2 3 4 5 6 7 8; do ended k2 && break; sleep 2; done
note "  [k2] modal appeared: $(modalup a4-k2)"
note "  [k2] result: $(result k2)"

# ── Stage B: the human answers Don't Allow ───────────────────────────────────
note "==== STAGE B — Don't Allow, then a second attempt in the same instance ===="
mkparent parentB.command PARENTB d1 d2 d3
fresh_terminal parentB.command
note "  TCC AppData row before: $(tccrow)"
startcell d1
sleep 10
note "  [d1] modal up: $(modalup b1-modal-up)"
note "  [d1] press Don't Allow -> $(press "Don’t Allow")"
for i in 1 2 3 4 5 6 7 8; do ended d1 && break; sleep 2; done
note "  [d1] result: $(result d1)"
note "  [d1] TCC AppData row after the refusal: $(tccrow)"
note "  ---- d2: a second child in the SAME Terminal instance ----"
startcell d2
for i in 1 2 3 4 5 6 7 8; do ended d2 && break; sleep 2; done
note "  [d2] modal appeared: $(modalup b2-d2)"
note "  [d2] result: $(result d2)"
note "  ---- d3: a third child, after a 5s pause ----"
sleep 5
startcell d3
for i in 1 2 3 4 5 6 7 8; do ended d3 && break; sleep 2; done
note "  [d3] modal appeared: $(modalup b3-d3)"
note "  [d3] result: $(result d3)"
note "  TCC AppData row at the end: $(tccrow)"

# ── Stage C: does SIGTERM reap a child stalled in the TCC-held open(2)? ──────
# `execFileSync(..., {timeout})` defaults to SIGTERM; if the stalled syscall
# ignores it the bounded wait would leak a process, and the implementation must
# use SIGKILL instead.
note "==== STAGE C — SIGTERM against a child stalled in the modal-held open(2) ===="
mkparent parentC.command PARENTC t1
fresh_terminal parentC.command
startcell t1
sleep 10
note "  [t1] modal up: $(modalup c1-modal-up)"
TPID=$(cellpid t1)
note "  [t1] stalled child pid=$TPID — SIGTERM"
lab_ssh "$IP" "kill -TERM $TPID; sleep 3; ps -p $TPID >/dev/null 2>&1 && echo SURVIVED-SIGTERM || echo REAPED-BY-SIGTERM" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
lab_ssh "$IP" "ps -p $TPID >/dev/null 2>&1 && { kill -9 $TPID; sleep 2; echo 'needed SIGKILL'; } || echo 'SIGTERM was enough'" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
note "  [t1] dismissing the orphaned dialog: $(press "Don’t Allow")"

note "==== raw parent.log (phase 2 tail) ===="
lab_ssh "$IP" "sed -n '/PARENTA/,\$p' $D/parent.log" </dev/null | sed 's/^/    /' | tee -a "$REPORT"
note "APDP1-B DONE."
