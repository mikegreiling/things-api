#!/bin/bash
# SYNC3 — SY-3b dedupe-tiebreak re-probe (docs/lab/sync3-dedupe-tiebreak.md).
#
# The SY-3 residual: two devices independently materialize the SAME occurrence of a
# synced daily repeater; on reconvergence Things Cloud DEDUPES them to ONE row. In the
# single SYNC2B run, B's row (non-UTC / numerically-later creationDate) survived — but
# sync-arrival order was confounded (B reconnected second). This campaign forces OPPOSITE
# reconnect orders across runs to separate the laws:
#   * winner follows reconnect order    -> ARRIVAL-ORDER law
#   * same device's row survives always  -> creationDate / device-stable law
#   * zone-swap flips the winner         -> later-timestamp (creationDate/umd), NOT device
#
# ==== HARD RAILS (unchanged from SYNC2B) ====
# * DURABLE account #2 (accidental-loss replacement of #1, authorized 2026-08-14). Creds
#   live ONLY in the PRIMARY checkout's gitignored dir, by ABSOLUTE path (never a worktree
#   copy — that is what destroyed account #1). NEVER burned, NEVER re-registered per run.
# * NEVER touches the host Things app/container or Mike's real Things Cloud account.
# * EXACTLY two clones, both deleted at teardown (cleanup trap). Golden is immutable.
# * Deliberately network-enabled (overrides the harness airgap) — documented deviation.
#
# ==== KEY MECHANICS (inherited from SYNC2B / SYNCLAT / TOMB1) ====
# * CLOCK pinned 2026-07-05 for login (trial valid, cloud TLS 200). Occurrence days are
#   advanced +1/+2/+3 (07-06/07/08), all < ~07-17 trial expiry.
# * A keeps the guest default zone (UTC); B is pinned America/Chicago (CDT, -5). A spawned
#   occurrence stamps creationDate at the occurrence-day 00:00 in the SPAWNING device zone
#   (SY-3): A 07-06 = 1783296000 (UTC midnight); B 07-06 = 1783314000 (CDT midnight, +5h).
# * True offline: quit Things, delete both default routes, curl cloud == 000. Reconnect by
#   REBOOTING the clone (clean DHCP) and re-pinning the clock BEFORE Things relaunches
#   (repin disables NTP; without it the reconnect clock would jump to real time and expire
#   the pinned trial).
# * Per-device MARKER NOTES on the minted instance rows (SY3B-R<n>-A / SY3B-R<n>-B) are the
#   byte-exact provenance identifier of the surviving row (never rely on uuid alone across
#   a dedupe). creationDate (zone-distinct) is the secondary identifier.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"
GOLDEN="${GOLDEN:-things-lab-golden-v2}"
AUTH_TOKEN="${AUTH_TOKEN:-9dFi9fY-QBuqFq59yAUxOg}"   # golden-v2 uriSchemeAuthToken
PIN_DATE="${PIN_DATE:-070512002026}"                 # MMDDhhmmYYYY = 2026-07-05 12:00 (login/trial)
PHASE="${1:-core}"                                   # core | swap

# DURABLE artifacts MUST outlive the run -> PRIMARY checkout, ABSOLUTE path (never worktree).
DURABLE_DIR="/Volumes/Workspace/Projects/things-api/lab/artifacts/sync-durable-account"
DURABLE_ENV="$DURABLE_DIR/account-credentials.env"
RUN="things-run-sync3-$PHASE-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$RUN"; mkdir -p "$OUT/snapshots"
REPORT="$OUT/report.txt"
note(){ echo "[sync3:$PHASE] $*" | tee -a "$REPORT"; }
[ -z "$VNCDO" ] && { note "FATAL: \$VNCDO required (account attach is VNC-driven)"; exit 1; }

# ---------------- durable account (mail.tm one-time code + random TC password) ----------------
mailtm(){ curl -s -m 20 "$@"; }
provision_account(){   # mint the durable account credentials ONCE (authorized replacement of #1)
  mkdir -p "$DURABLE_DIR"
  local dom email mpass tcpass
  dom=$(mailtm https://api.mail.tm/domains | python3 -c 'import sys,json;print(json.load(sys.stdin)["hydra:member"][0]["domain"])')
  email="thingslabsync$(python3 -c 'import secrets;print(secrets.token_hex(4))')@$dom"
  mpass=$(python3 -c 'import secrets;print(secrets.token_urlsafe(12))')
  tcpass=$(python3 -c 'import secrets,string;a=string.ascii_lowercase+string.digits;print("".join(secrets.choice(a) for _ in range(16)))')
  mailtm -X POST https://api.mail.tm/accounts -H 'Content-Type: application/json' \
    -d "{\"address\":\"$email\",\"password\":\"$mpass\"}" >/dev/null
  cat > "$DURABLE_ENV" <<EOF
# DURABLE Things Cloud lab account #2 — minted $(date -u +%Y-%m-%dT%H:%M:%SZ) for SYNC3 (SY-3b).
# Replacement for durable account #1 (SYNC2B), orphaned 2026-08-14 when an orchestration
# worktree cleanup destroyed #1's gitignored creds. #1 was NEVER burned server-side (idle,
# will lapse with its trial). NO CHURN: reuse THIS for all future sync probes; never re-register.
# mail.tm inbox is only needed for the one-time 6-digit verify code at mint time.
MAILTM_EMAIL=$email
MAILTM_PASS=$mpass
THINGS_CLOUD_PASS=$tcpass
EOF
  cat > "$DURABLE_DIR/README.md" <<'EOF'
# Durable Things Cloud lab account (gitignored — never commit credentials)

**No-churn doctrine.** One durable throwaway Things Cloud account serves ALL sync probes so
Cultured Code never sees account churn. Runs use the LOGIN path only — never re-register.

**This is durable account #2.** Account #1 (minted for SYNC2B on 2026-08-13) was orphaned on
2026-08-14 by an orchestration accident: the provisioning agent wrote #1's credentials only to
its ISOLATED worktree's gitignored `lab/artifacts/`, and the orchestrator's worktree cleanup
destroyed them (gitignored files do not travel with a merge). #1 was never burned server-side —
it sits idle and will lapse with its trial. #2 was minted 2026-08-14 as its replacement.

**Process rule (root-cause fix).** Durable artifacts that must OUTLIVE a run — account
credentials above all — are written to the PRIMARY checkout's gitignored `lab/artifacts/` by
ABSOLUTE path, never only to an agent worktree copy. See docs/lab/harness.md "Durable artifacts".

Files here (all gitignored): `account-credentials.env` (mail.tm + Things Cloud creds),
`bssync-A-raw.txt` (the account's BSSyncronyMetadata coordinate dump).
EOF
  note "DURABLE account #2 provisioned: $email (creds+README in $DURABLE_DIR)"
}
mail_token(){ source "$DURABLE_ENV"; mailtm -X POST https://api.mail.tm/token \
  -H 'Content-Type: application/json' -d "{\"address\":\"$MAILTM_EMAIL\",\"password\":\"$MAILTM_PASS\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'; }
fetch_verify_code(){ local tok id; tok=$(mail_token)
  for _ in $(seq 1 25); do
    id=$(mailtm https://api.mail.tm/messages -H "Authorization: Bearer $tok" \
      | python3 -c 'import sys,json;d=json.load(sys.stdin)["hydra:member"];print(d[0]["id"] if d else "")')
    [ -n "$id" ] && break; sleep 6
  done
  [ -z "$id" ] && { echo "NO-MAIL"; return 1; }
  mailtm "https://api.mail.tm/messages/$id" -H "Authorization: Bearer $tok" \
    | python3 -c 'import sys,json,re;d=json.load(sys.stdin,strict=False);m=re.search(r"(\d{6})",d.get("text","")+d.get("subject",""));print(m.group(1) if m else "NO-CODE")'; }

# ---------------- guest helpers (pushed to each clone) ----------------
GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

# ---------------- clone/boot/net ----------------
boot(){ # boot <suffix> [tz] -> echoes IP, pins clock, installs helpers, records vnc url
  local vm="$RUN-$1" ip tz="${2:-}"
  (tart run "$vm" --no-graphics --vnc-experimental >"$OUT/tart-run-$1.log" 2>&1 &)
  sleep 3
  ip=$(lab_wait_for_ssh "$vm" 300)
  grep -o 'vnc://[^ ]*' "$OUT/tart-run-$1.log" | head -1 > "$OUT/vnc-$1.txt" 2>/dev/null || true
  echo "$ip" > "$OUT/ip-$1.txt"
  lab_ssh "$ip" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN_DATE >/dev/null" </dev/null
  [ -n "$tz" ] && lab_ssh "$ip" "sudo systemsetup -settimezone $tz >/dev/null 2>&1" </dev/null
  lab_ssh "$ip" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"
  echo "$ip"
}
repin(){ lab_ssh "$1" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date ${2:-$PIN_DATE} >/dev/null" </dev/null; }
launch_things(){ lab_ssh "$1" 'open -g -a Things3; sleep 14' </dev/null; }
relaunch_things(){ lab_ssh "$1" 'osascript -e "tell application \"Things3\" to quit" 2>/dev/null; sleep 3; open -g -a Things3; sleep 14' </dev/null; }
gq(){ lab_ssh "$1" "/tmp/gsql.sh -q $(printf '%q' "$2")" </dev/null; }
tz_of(){ lab_ssh "$1" 'sudo systemsetup -gettimezone 2>/dev/null; date +%z' </dev/null; }
go_offline(){ lab_ssh "$1" 'osascript -e "tell application \"Things3\" to quit" 2>/dev/null; sleep 2
  sudo route -n delete -inet default >/dev/null 2>&1; sudo route -n delete -inet6 default >/dev/null 2>&1; sleep 1
  curl -s -m6 -o /dev/null -w "cloud=%{http_code}\n" https://cloud.culturedcode.com 2>&1 || echo cloud=000' </dev/null; }
snapshot(){ # snapshot <ip> <label>
  lab_ssh "$1" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/s.sqlite"' </dev/null
  lab_scp "$LAB_SSH_USER@$1:/tmp/s.sqlite" "$OUT/snapshots/$2.sqlite" </dev/null 2>/dev/null
  note "   [snapshot] $2.sqlite"; }

# ---------------- VNC ----------------
VVAR=""
V(){ local url hp s p; url=$(cat "$OUT/vnc-$VVAR.txt"); hp=${url#vnc://}; hp=${hp##*@}
  s="${hp%%:*}::${hp##*:}"; p=$(echo "$url" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
  perl -e 'alarm 60; exec @ARGV' "$VNCDO" -s "$s" ${p:+-p "$p"} "$@" 2>>"$OUT/vnc-$VVAR.log" || true; }
shot(){ V capture "$OUT/$1"; note "   [shot] $1"; }
paste_into(){ V move "$2" "$3" click 1
  lab_ssh "$1" "printf '%s' $(printf '%q' "$4") | pbcopy" </dev/null
  V move 341 22 click 1 pause 1 move 353 280 click 1; }
# COORDINATES (golden-v2 framebuffer 2048x1536, Settings window centered) — SYNCLAT/SYNC2B-verified:
#  Things menu=151,23 Settings=167,259 ThingsCloud tab=875,261 toggle=696,770
#  LogIn=1008,720 CreateAccount=1008,805 email=1008,604 password=1008,733
#  create-submit=1008,959 login-submit=1008,913 verify box1=807,789
#  Continue(verify)=1008,1005 Continue(newsletter)=1008,826 KeepCloud card=1008,852
#  Continue(merge)=1008,1156 DontAllow(localnet)=904,619 Settings close=526,187 Edit>Paste=353,280
vnc_create_account(){ local ip="$1"; VVAR=A
  note "== A: CREATE durable account #2 (Settings>Things Cloud>toggle>Create) =="
  V move 151 23 click 1 pause 1 move 167 259 click 1; sleep 3
  V move 875 261 click 1; sleep 2
  V move 696 770 click 1; sleep 3
  V move 1008 805 click 1; sleep 3
  paste_into "$ip" 1008 604 "$MAILTM_EMAIL"
  paste_into "$ip" 1008 733 "$THINGS_CLOUD_PASS"
  shot A-create-01-form.png
  V move 1008 959 click 1; sleep 6
  local code; code=$(fetch_verify_code); note "   verify code: $code"
  V move 807 789 click 1 pause 1 type "$code"; sleep 2
  V move 1008 1005 click 1; sleep 6
  V move 1008 826 click 1; sleep 6
  V move 904 619 click 1; sleep 3
  V move 526 187 click 1; sleep 2
  shot A-create-02-settled.png
}
vnc_login(){ local ip="$1"; VVAR="$2"
  note "== $2: LOG IN to durable account #2 (merge=Keep only cloud) =="
  V move 151 23 click 1 pause 1 move 167 259 click 1; sleep 3
  V move 875 261 click 1; sleep 2; V move 696 770 click 1; sleep 3
  V move 1008 720 click 1; sleep 3
  paste_into "$ip" 1008 604 "$MAILTM_EMAIL"; paste_into "$ip" 1008 733 "$THINGS_CLOUD_PASS"
  V move 1008 913 click 1; sleep 8
  shot "$2-login-01-submitted.png"
  V move 1008 852 click 1; sleep 1                 # "Keep only cloud" card (present iff merge dialog shown)
  V move 1008 1156 click 1; sleep 6                # Continue
  V move 904 619 click 1; sleep 3; V move 526 187 click 1; sleep 2
  shot "$2-login-02-settled.png"
}

# ---------------- SY-3b dedupe run ----------------
set_note(){ lab_ssh "$1" "osascript -e 'tell application \"Things3\" to set notes of to do id \"$2\" to \"$3\"'" </dev/null; }
dump_day(){ lab_ssh "$1" "/tmp/gsql.sh -q \"SELECT uuid||'|cd='||creationDate||'|umd='||userModificationDate||'|notes='||replace(IFNULL(notes,''),char(10),' ') FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL AND creationDate>=$2 ORDER BY creationDate\"" </dev/null | tr '\n' ';'; }
newest_inst(){ gq "$1" "SELECT uuid FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL AND creationDate>=$2 ORDER BY creationDate DESC LIMIT 1"; }
inst_row(){ gq "$1" "SELECT uuid||'|cd='||creationDate||'|umd='||userModificationDate||'|notes='||IFNULL(notes,'') FROM TMTask WHERE uuid='$2'"; }

CURPIN=""
reconnect_dev(){ # reconnect_dev <A|B> — reboot (clean DHCP) -> repin (NTP off) -> relaunch Things
  local dev="$1" vm ip tz=""
  vm="$RUN-$dev"; [ "$dev" = "$ZONE_B_DEV" ] && tz="America/Chicago"
  note "   -- reconnect $dev (reboot, repin $CURPIN, relaunch) --"
  tart stop "$vm" >/dev/null 2>&1; sleep 4
  (tart run "$vm" --no-graphics --vnc-experimental >>"$OUT/tart-run-$dev.log" 2>&1 &)
  sleep 3
  ip=$(lab_wait_for_ssh "$vm" 300)
  lab_ssh "$ip" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"
  repin "$ip" "$CURPIN"
  [ -n "$tz" ] && lab_ssh "$ip" "sudo systemsetup -settimezone $tz >/dev/null 2>&1" </dev/null
  if [ "$dev" = A ]; then IPA="$ip"; else IPB="$ip"; fi
  echo "$ip" > "$OUT/ip-$dev.txt"
  relaunch_things "$ip"
}

dedupe_run(){ # dedupe_run <runNo> <dayPin> <dayMidEpoch> <firstDev> <secondDev>
  local RN="$1" PIN="$2" MID="$3" FIRST="$4" SECOND="$5"
  CURPIN="$PIN"
  note "########## SY-3b RUN $RN — spawn @ $PIN, reconnect order: $FIRST-first then $SECOND ##########"
  note "== take BOTH offline, advance clocks to $PIN, spawn the occurrence independently =="
  go_offline "$IPA"; go_offline "$IPB"
  repin "$IPA" "$PIN"; repin "$IPB" "$PIN"
  note "   A date: $(lab_ssh "$IPA" 'date' </dev/null)  B date: $(lab_ssh "$IPB" 'date' </dev/null)"
  relaunch_things "$IPA"; relaunch_things "$IPB"; sleep 6
  local ai bi
  ai=$(newest_inst "$IPA" "$MID"); bi=$(newest_inst "$IPB" "$MID")
  note "   spawned instance uuids: A=$ai  B=$bi"
  note "   instance counts (>= day midnight) pre-mark: A=$(gq "$IPA" "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL AND creationDate>=$MID") B=$(gq "$IPB" "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL AND creationDate>=$MID")"
  note "== apply per-device MARKER NOTES on the minted instances =="
  set_note "$IPA" "$ai" "SY3B-R$RN-A"; sleep 2
  set_note "$IPB" "$bi" "SY3B-R$RN-B"; sleep 2
  note "   PRE-RECONVERGENCE candidates (the two rows that will dedupe):"
  note "     A[$FIRST-order=$([ "$FIRST" = A ] && echo first || echo second)]: $(inst_row "$IPA" "$ai")"
  note "     B[$FIRST-order=$([ "$FIRST" = B ] && echo first || echo second)]: $(inst_row "$IPB" "$bi")"
  snapshot "$IPA" sy3b-r$RN-preRC-A; snapshot "$IPB" sy3b-r$RN-preRC-B

  note "== RECONNECT in forced order: $FIRST first (pushes alone), then $SECOND (pulls+pushes -> merge) =="
  reconnect_dev "$FIRST"; sleep 14
  reconnect_dev "$SECOND"; sleep 14
  note "   both online; settle with two relaunch rounds"
  relaunch_things "$IPA"; relaunch_things "$IPB"; sleep 8
  relaunch_things "$IPA"; relaunch_things "$IPB"; sleep 8

  local cntA cntB
  cntA=$(gq "$IPA" "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL AND creationDate>=$MID")
  cntB=$(gq "$IPB" "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL AND creationDate>=$MID")
  note "   >>> DEDUPE: post-reconvergence $PIN instance count: A=$cntA B=$cntB (expect 1 each)"
  note "   >>> SURVIVOR (A view): $(dump_day "$IPA" "$MID")"
  note "   >>> SURVIVOR (B view): $(dump_day "$IPB" "$MID")"
  note "   >>> RUN $RN VERDICT INPUT: reconnect-first=$FIRST ; survivor-notes(A view)=[$(gq "$IPA" "SELECT group_concat(IFNULL(notes,'')) FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL AND creationDate>=$MID")]"
  snapshot "$IPA" sy3b-r$RN-postRC-A; snapshot "$IPB" sy3b-r$RN-postRC-B
}

##############################################################################
note "############ SYNC3 SY-3b phase=$PHASE  golden=$GOLDEN ############"
NEEDCREATE=0
if [ ! -f "$DURABLE_ENV" ]; then provision_account; NEEDCREATE=1; else note "durable account present ($DURABLE_ENV) — LOGIN path"; fi
source "$DURABLE_ENV"

note "== clone A + B from $GOLDEN =="
tart clone "$GOLDEN" "$RUN-A"; tart clone "$GOLDEN" "$RUN-B"
cleanup(){ for s in A B; do tart stop "$RUN-$s" >/dev/null 2>&1; tart delete "$RUN-$s" >/dev/null 2>&1; done; note "clones deleted (durable account kept alive)"; }
trap cleanup EXIT

# Zone assignment. core: A=UTC, B=Chicago. swap: A=Chicago, B=UTC (flips which device holds
# the numerically-later creationDate/umd, to separate later-timestamp from device identity).
if [ "$PHASE" = "swap" ]; then ZONE_A_TZ="America/Chicago"; ZONE_B_TZ=""; ZONE_B_DEV=A
else ZONE_A_TZ=""; ZONE_B_TZ="America/Chicago"; ZONE_B_DEV=B; fi
note "== boot BOTH concurrently; zones: A=[${ZONE_A_TZ:-UTC}] B=[${ZONE_B_TZ:-UTC}] (non-UTC dev=$ZONE_B_DEV) =="
IPA=$(boot A "$ZONE_A_TZ"); IPB=$(boot B "$ZONE_B_TZ"); note "A=$IPA  B=$IPB"
note "   A tz: $(tz_of "$IPA" | tr '\n' ' ')"
note "   B tz: $(tz_of "$IPB" | tr '\n' ' ')"
launch_things "$IPA"; launch_things "$IPB"
VVAR=A; shot A-00-launch.png; VVAR=B; shot B-00-launch.png
note "   TLS under pinned clock: A=$(lab_ssh "$IPA" 'curl -s -m8 -o /dev/null -w "%{http_code}" https://cloud.culturedcode.com' </dev/null) B=$(lab_ssh "$IPB" 'curl -s -m8 -o /dev/null -w "%{http_code}" https://cloud.culturedcode.com' </dev/null)"

# ---- attach account ----
if [ "$NEEDCREATE" = 1 ]; then vnc_create_account "$IPA"; else vnc_login "$IPA" A; fi
sleep 20
note "   A BSSyncronyMetadata rows (pre-account=0): $(gq "$IPA" 'SELECT COUNT(*) FROM BSSyncronyMetadata')"
if [ "$NEEDCREATE" = 1 ]; then
  lab_ssh "$IPA" '/tmp/gsql.sh -q "SELECT uuid||\"=\"||quote(value) FROM BSSyncronyMetadata"' </dev/null > "$DURABLE_DIR/bssync-A-raw.txt"
  note "   bssync raw -> $DURABLE_DIR/bssync-A-raw.txt (account #2 UUID coordinates)"
fi
vnc_login "$IPB" B
sleep 20
note "   B LAB- seed synced down: $(gq "$IPB" "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'LAB-%'")"

# ---- residue cleanup: trash any prior-run spawned occurrences (>= 07-06) so runs start clean ----
note "== residue check: pre-existing spawned occurrences (creationDate >= 1783296000) =="
note "   A: $(gq "$IPA" "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL AND creationDate>=1783296000")  B: $(gq "$IPB" "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL AND creationDate>=1783296000")"
note "   template lineage: A=$(gq "$IPA" "SELECT uuid FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NOT NULL LIMIT 1") B=$(gq "$IPB" "SELECT uuid FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")"
note "   pre-existing base instances (rule NULL, < 07-06): A=$(gq "$IPA" "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL AND creationDate<1783296000") B=$(gq "$IPB" "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL AND creationDate<1783296000")"
snapshot "$IPA" 00-A-attached; snapshot "$IPB" 00-B-attached

case "$PHASE" in
  core)
    dedupe_run 1 "070612002026" 1783296000 A B    # run 1: A reconnects first
    dedupe_run 2 "070712002026" 1783382400 B A    # run 2: B reconnects first (OPPOSITE)
    ;;
  swap)
    # zones already swapped (A=Chicago non-UTC). Reconnect A first: if the winner FOLLOWS the
    # later-timestamp device (now A) rather than device identity, the law is timestamp-based.
    dedupe_run 3 "070812002026" 1783468800 A B
    ;;
  *) note "unknown phase '$PHASE' (core|swap)"; exit 1 ;;
esac

note "GREEN — report: $REPORT ; artifacts in $OUT"
note "DURABLE account #2 KEPT ALIVE (no churn): creds in $DURABLE_ENV"
trap - EXIT; cleanup
