#!/bin/bash
# RRX1 re-cert — re-ship the FIXED dist and confirm the shipped CLI renders the
# exhausted / born-ended templates as "ended", the active one as scheduled, and
# refuses clear-reminder on a template with a committed reminder.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/rrx1-lab"; REPORT="$OUT/recert.txt"; : > "$REPORT"
source "$OUT/state.env"
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
note() { echo "[rrx1-recert] $*" | tee -a "$REPORT"; }

# pick a self-contained node (rem1 lesson)
CANDS=( $(ls -d "$HOME"/.asdf/installs/nodejs/*/bin 2>/dev/null | sort -t/ -k7 -V -r) /opt/homebrew/bin )
for cand in "${CANDS[@]}"; do
  [ -x "$cand/node" ] || continue
  otool -L "$cand/node" 2>/dev/null | grep -q '/opt/homebrew/' && continue
  export PATH="$cand:$PATH"; break
done
note "build + re-ship fixed dist"
npm run build >"$OUT/build2.log" 2>&1 || { note "FATAL build"; exit 1; }
NODE_BIN=$(node -e 'console.log(process.execPath)')
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null 2>&1
note "shipped."

sh(){ local n="$1"; shift; lab_ssh "$IP" "$CLI $* ; echo EXIT=\$?" </dev/null 2>&1 | grep -vE "ExperimentalWarning|trace-warnings"; }

note ""; note "### show EA (exhausted ends-after, cursor NULL) — expect 'ended' ###"
sh EA todo show "$EA" | grep -iE "repeat|ended|waiting|scheduled|EXIT" | sed 's/^/  /' | tee -a "$REPORT"
note ""; note "### show EO (exhausted ends-on, cursor NULL) — expect 'ended' ###"
sh EO todo show "$EO" | grep -iE "repeat|ended|waiting|scheduled|EXIT" | sed 's/^/  /' | tee -a "$REPORT"
note ""; note "### show EP (born-ended ends-on-past) — expect 'ended' ###"
sh EP todo show "$EP" | grep -iE "repeat|ended|waiting|scheduled|EXIT" | sed 's/^/  /' | tee -a "$REPORT"
note ""; note "### show RW (weekly, active, next=07-12) — expect 'scheduled' ###"
sh RW todo show "$RW" | grep -iE "repeat|ended|waiting|scheduled|reminder|EXIT" | sed 's/^/  /' | tee -a "$REPORT"
note ""; note "### show RC (daily, active, next=07-10) — expect 'scheduled' ###"
sh RC todo show "$RC" | grep -iE "repeat|ended|waiting|scheduled|reminder|EXIT" | sed 's/^/  /' | tee -a "$REPORT"

note ""; note "### upcoming (repeats horizon 5) — EA/EO/EP must NOT appear; RC/RD/RW active ###"
lab_ssh "$IP" "$CLI upcoming --horizon 5 --until 2026-07-20 ; echo EXIT=\$?" </dev/null 2>&1 | grep -vE "ExperimentalWarning|trace-warnings" | grep -iE "RRX-|EXIT" | sed 's/^/  /' | tee -a "$REPORT"

note ""; note "### clear-reminder RW (template w/ committed reminder) — expect clean refusal, not verify-fail ###"
sh CLR todo clear-reminder "$RW" | sed 's/^/  /' | tee -a "$REPORT"
note "DONE."
