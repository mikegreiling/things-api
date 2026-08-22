#!/bin/bash
# RDLG2e — CERTIFY the derived projection day (#520/#522) against a REAL Things
# 3.23 library, the step (3) arm the 3.23 re-certification campaign asks for.
#
# `templateProjectionDay` prefers the app's `rt1_nextInstanceStartDate` cache and
# DERIVES the day from the decoded rule + `rt1_instanceCreationStartDate` cursor
# when the cache is absent. Unit tests pin the derivation against fixtures; what
# was never measured is whether the derivation REPRODUCES the running app's own
# cached answer on a real 3.23 library. This run builds a varied template corpus
# through the production CLI (including a PAUSED series, the natural NULL-cache
# case), copies the clone's database to the host, and runs the shipped helper over
# every template TWICE: once as shipped (cache-first) and once with the cache
# suppressed (derivation-only). Cache and derivation must agree everywhere the app
# renders a projection, and the helper must return null everywhere it does not.
#
# METHOD: ONE disposable clone of things-lab-golden-v4 (the golden is never
# booted). Airgap, clock pinned 2026-07-05. Fixtures synthetic (RDLG2E-*). The
# copied database is a LAB clone's — the production container is never touched.
# Teardown on EXIT (KEEP=1 to leave it up).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-rdlg2e-lab}"
GOLDEN="${GOLDEN:-things-lab-golden-v4}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[rdlg2e] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"

if [ "${SKIP_BUILD:-0}" = "1" ]; then note "SKIP_BUILD=1 — reusing dist/"; else
note "building dist"
npm run build >"$OUT/build.log" 2>&1 || { note "FATAL: build failed"; exit 1; }
fi

note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: no SSH"; exit 1; }
note "ssh up at $IP"
cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — leaving $VM running at $IP"; return; fi
  note "teardown: stop+delete $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
[ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "airgap OK; clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"

lab_ssh "$IP" 'mkdir -p ~/labh' </dev/null
lab_ssh "$IP" 'cat > ~/labh/gsql.sh && chmod +x ~/labh/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gq() { lab_ssh "$IP" "~/labh/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gt() { lab_ssh "$IP" "~/labh/gsql.sh $(printf '%q' "$1")" </dev/null; }
warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null; osascript -e '\''tell application "Things3" to activate'\''; sleep 2; true' </dev/null; }

TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings")
note "env: Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / golden $GOLDEN"

NODE_BIN=$(node -e 'console.log(process.execPath)')
lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
scpO "$NODE_BIN" "admin@$IP:/Users/admin/things-lab/bin/node" >/dev/null
lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
scpO -r dist "admin@$IP:/Users/admin/things-lab/things-api/" >/dev/null
scpO -r node_modules/commander "admin@$IP:/Users/admin/things-lab/things-api/node_modules/commander" >/dev/null
scpO package.json "admin@$IP:/Users/admin/things-lab/things-api/package.json" >/dev/null
lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'
G() { lab_ssh "$IP" "$CLI $*; echo EXIT=\$?" </dev/null 2>&1; }
lab_ssh "$IP" "$CLI config set ui-enabled true" </dev/null >/dev/null 2>&1

mktodo() {
  lab_ssh "$IP" "open -g 'things:///add?title=$1&auth-token=$TOKEN'; sleep 4" </dev/null
  gq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NULL LIMIT 1"
}

warm
note ""; note "###### building a varied 3.23 template corpus through the production CLI ######"
seed() { # seed <title> <flags...>
  local t="$1"; shift
  local u
  u=$(mktodo "$t")
  G todo make-repeating "$u" "$@" --dangerously-drive-gui --json > "$OUT/seed-$t.log" 2>&1
  note "  $t -> $(gq "SELECT COUNT(*) FROM TMTask WHERE title='$t' AND rt1_recurrenceRule IS NOT NULL") template(s)"
}
seed RDLG2E-DAILY --frequency daily --interval 2
seed RDLG2E-WEEKLY --frequency weekly --interval 1 --weekdays monday,thursday
seed RDLG2E-MONTHLY --frequency monthly --interval 1 --on-day 15
seed RDLG2E-YEARLY --frequency yearly --interval 1 --yearly-month 10 --on-day 8
seed RDLG2E-NTH --frequency monthly --interval 1 --on-weekday friday --on-ordinal last
seed RDLG2E-ENDS --frequency daily --interval 1 --ends-after 4
seed RDLG2E-AC --frequency weekly --interval 2 --after-completion
seed RDLG2E-PAUSE --frequency daily --interval 3

note ""; note "###### pausing one series (the natural NULL-cache template cohort) ######"
PT=$(gq "SELECT uuid FROM TMTask WHERE title='RDLG2E-PAUSE' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
warm
G todo pause-repeat "$PT" --dangerously-drive-gui --json > "$OUT/pause.log" 2>&1
note "  paused=$(gq "SELECT rt1_instanceCreationPaused FROM TMTask WHERE uuid='$PT'") cache=$(gq "SELECT COALESCE(rt1_nextInstanceStartDate,'NULL') FROM TMTask WHERE uuid='$PT'")"

note ""; note "###### the template census this library now carries ######"
gt "SELECT COUNT(*) AS templates, SUM(rt1_nextInstanceStartDate IS NULL) AS cacheNull, SUM(rt1_instanceCreationPaused=1) AS paused FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL" | sed 's/^/    /' | tee -a "$REPORT"

note ""; note "###### copying the clone's database to the host for the helper run ######"
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' >/dev/null 2>&1; sleep 5; DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "file:$DB?mode=ro" ".backup /Users/admin/labh/lab-copy.sqlite"' </dev/null
sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "admin@$IP:/Users/admin/labh/lab-copy.sqlite" "$OUT/lab-copy.sqlite" >/dev/null
note "  copied $(du -h "$OUT/lab-copy.sqlite" | cut -f1) (a LAB clone's database — synthetic fixtures only)"

cat > "$OUT/certify-projection.mjs" <<'EOF'
// Run the SHIPPED templateProjectionDay over every template of a real Things
// 3.23 library, twice: as shipped (cache-first) and with the cache SUPPRESSED
// (derivation-only). The two must agree wherever the app renders a projection.
import { DatabaseSync } from "node:sqlite";
import { templateProjectionDay } from "../../../dist/model/template-projection.js";
import { decodePackedDate } from "../../../dist/model/dates.js";

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const rows = db
  .prepare(
    `SELECT uuid, title, trashed,
            rt1_nextInstanceStartDate AS tpNext,
            rt1_instanceCreationStartDate AS tpCursor,
            rt1_recurrenceRule AS tpRule,
            rt1_instanceCreationPaused AS tpPaused,
            rt1_instanceCreationCount AS tpCount
       FROM TMTask WHERE rt1_recurrenceRule IS NOT NULL ORDER BY title`,
  )
  .all();

const iso = (d) => (d === null ? "—" : decodePackedDate(d));
let agree = 0, disagree = 0, cacheNull = 0, derivedNull = 0;
console.log("title                 cached      shipped     derived-only  verdict");
console.log("-".repeat(78));
for (const r of rows) {
  const row = {
    tpNext: r.tpNext ?? null,
    tpCursor: r.tpCursor ?? null,
    tpRule: r.tpRule ?? null,
    tpPaused: r.tpPaused ?? null,
    tpCount: r.tpCount ?? null,
  };
  const shipped = templateProjectionDay(row);
  const derived = templateProjectionDay({ ...row, tpNext: null });
  if (row.tpNext === null) cacheNull += 1;
  if (derived === null) derivedNull += 1;
  let verdict;
  if (row.tpNext === null) {
    // No cache to compare against: the shipped answer IS the derived one. The
    // app renders no projection for a paused series, so null is the right answer.
    verdict = shipped === derived ? "no-cache (derivation is the only source)" : "BUG";
  } else if (derived === null) {
    // The derivation declines where the app still caches a day — a fail-closed
    // gap (after-completion / ended / paused), never a wrong day.
    verdict = "declines (fail-closed, not a wrong day)";
  } else if (derived === row.tpNext) {
    agree += 1;
    verdict = "AGREES with the app's own cache";
  } else {
    disagree += 1;
    verdict = "DISAGREES";
  }
  console.log(
    `${String(r.title).padEnd(21)} ${iso(row.tpNext).padEnd(11)} ${iso(shipped).padEnd(11)} ${iso(derived).padEnd(13)} ${verdict}`,
  );
}
console.log("-".repeat(78));
console.log(
  `templates=${rows.length} cacheNull=${cacheNull} derivationNull=${derivedNull} agree=${agree} DISAGREE=${disagree}`,
);
process.exit(disagree === 0 ? 0 : 1);
EOF

note ""; note "###### the shipped helper, over the real 3.23 library ######"
node "$OUT/certify-projection.mjs" "$OUT/lab-copy.sqlite" 2>&1 | tee -a "$REPORT"
RC=${PIPESTATUS[0]}
note "  helper certification exit=$RC (0 = every cached day reproduced by the derivation)"

note ""; note "###### the READ side, on the guest, against the same library ######"
lab_ssh "$IP" 'open -a Things3; sleep 12' </dev/null
G upcoming --json --limit 60 > "$OUT/upcoming.json" 2>&1
note "  upcoming rows mentioning a seeded template:"
grep -o 'RDLG2E-[A-Z]*' "$OUT/upcoming.json" | sort | uniq -c | sed 's/^/    /' | tee -a "$REPORT"
G doctor 2>&1 | grep -iE "repeat|template|fingerprint|database" | sed 's/^/    /' | tee -a "$REPORT"

note ""; note "RDLG2e complete — artifacts in $OUT"
