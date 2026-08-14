#!/bin/bash
# SYNC2B — durable-account Things Cloud sync probes (docs/lab/sync2-*.md).
#
# The long-blocked SYNC2 follow-on: with a ONE-TIME durable throwaway account
# (NO churn — minted once, kept alive for all future sync probes), two NETWORKED
# clones of things-lab-golden-v2 (Things 3.22.12) on the PINNED clock 2026-07-05
# (trial valid, cloud reachable — the SYNCLAT recipe), measure:
#   sy1  baseline convergence sanity (A<->B) + BSSyncronyMetadata signals
#   sy2  THE GATE: --preserve-modified / AS `set modification date` vs Things Cloud
#   sy3  spawn dedupe (same daily occurrence on two devices) + creationDate zone
#
# ==== HARD RAILS ====
# * DURABLE account: creds live ONLY in lab/artifacts/sync-durable-account/ (gitignored).
#   Minted once (mail.tm inbox for the one-time 6-digit code + random TC password,
#   no Apple ID). NEVER burned, NEVER re-registered per run. Kept alive at teardown.
# * NEVER touches the host Things app/container or Mike's real Things Cloud account.
# * EXACTLY two clones, both deleted at teardown (cleanup trap). Golden is immutable.
# * Deliberately network-enabled (overrides the harness airgap) — documented deviation.
#
# ==== KEY MECHANICS (inherited from SYNC2 / SYNCLAT / TOMB1) ====
# * CLOCK pinned 2026-07-05 (070512002026): trial valid ("13 days left"), TLS to
#   cloud.culturedcode.com == 200, account create + BSSyncronyMetadata + sync work.
#   Pinned clock ticks at real rate. Advancing (+1 day steps, sy3) stays < ~07-17 expiry.
# * VNC (framebuffer 2048x1536): menus in ONE vncdo invocation; text via clipboard
#   (pbcopy + Edit>Paste — vncdo can't type shifted chars). TC password is lowercase+digits.
# * On login MERGE dialog choose "Keep only the to-dos from Things Cloud" (both clones
#   share the identical golden seed; "Keep all" duplicates it). Decline "find devices
#   on local networks" so sync rides the CLOUD not LAN peer discovery.
# * APNs push unavailable in the VM -> a receiver PULLS only on relaunch / things:///show,
#   not spontaneously. Force B's pull with a Things quit+relaunch (TOMB1 reliable point).
# * TRUE offline (sy2/sy3): quit Things FIRST, then delete BOTH -inet and -inet6 default
#   routes; verify curl cloud == 000. Reconnect by REBOOTING the clone (clean DHCP) and
#   re-pinning the clock.
# * --preserve-modified restore leg == AS `set modification date of <addressor> id X to
#   <floor(preUmd) as local wall-clock date>` (src/write/preserve-modified.ts). Reproduced
#   in-guest verbatim (restore_umd), so sy2 exercises the shipped flag's exact mechanism.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"
GOLDEN="${GOLDEN:-things-lab-golden-v2}"
AUTH_TOKEN="${AUTH_TOKEN:-9dFi9fY-QBuqFq59yAUxOg}"   # golden-v2 uriSchemeAuthToken
PIN_DATE="${PIN_DATE:-070512002026}"                 # MMDDhhmmYYYY = 2026-07-05 12:00
PHASE="${1:-sy1}"

DURABLE_DIR="lab/artifacts/sync-durable-account"
DURABLE_ENV="$DURABLE_DIR/account-credentials.env"
RUN="things-run-sync2b-$PHASE-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$RUN"; mkdir -p "$OUT/snapshots"
REPORT="$OUT/report.txt"
note(){ echo "[sync2b:$PHASE] $*" | tee -a "$REPORT"; }
[ -z "$VNCDO" ] && { note "FATAL: \$VNCDO required (account attach is VNC-driven)"; exit 1; }

# ---------------- durable account (mail.tm one-time code + random TC password) ----------------
mailtm(){ curl -s -m 20 "$@"; }
provision_account(){   # mint the durable account credentials ONCE
  mkdir -p "$DURABLE_DIR"
  local dom email mpass tcpass
  dom=$(mailtm https://api.mail.tm/domains | python3 -c 'import sys,json;print(json.load(sys.stdin)["hydra:member"][0]["domain"])')
  email="thingslabsync$(python3 -c 'import secrets;print(secrets.token_hex(4))')@$dom"
  mpass=$(python3 -c 'import secrets;print(secrets.token_urlsafe(12))')
  tcpass=$(python3 -c 'import secrets,string;a=string.ascii_lowercase+string.digits;print("".join(secrets.choice(a) for _ in range(16)))')
  mailtm -X POST https://api.mail.tm/accounts -H 'Content-Type: application/json' \
    -d "{\"address\":\"$email\",\"password\":\"$mpass\"}" >/dev/null
  cat > "$DURABLE_ENV" <<EOF
# DURABLE Things Cloud lab account — minted $(date -u +%Y-%m-%dT%H:%M:%SZ) for the SYNC2B campaign.
# NO CHURN: reuse this for ALL future sync probes; do NOT re-register or burn it.
# mail.tm inbox is only needed for the one-time 6-digit verify code at mint time.
MAILTM_EMAIL=$email
MAILTM_PASS=$mpass
THINGS_CLOUD_PASS=$tcpass
EOF
  note "DURABLE account provisioned: $email (creds in $DURABLE_ENV)"
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
# BSSyncronyMetadata last-sync-attempt signal (bplist double nearest-to-now, excl now+31y sentinel)
SIGSH='#!/bin/bash
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
sqlite3 -noheader -list "file:$DB?mode=ro" "SELECT quote(value) FROM BSSyncronyMetadata" | python3 -c "
import sys,plistlib,time
best=None; now2001=time.time()-978307200
for line in sys.stdin:
    line=line.strip()
    if not (line.startswith(chr(88)+chr(39)) and line.endswith(chr(39))): continue
    try: v=plistlib.loads(bytes.fromhex(line[2:-1]))
    except Exception: continue
    if isinstance(v,float) and v < now2001 + 5*365*86400:
        if best is None or v>best: best=v
print(f\"{best:.3f}\" if best is not None else \"NONE\")
"'
# restore_umd <addressor> <uuid> <epoch> — reproduces preserve-modified.ts date block in the GUEST zone
RESTORESH='#!/bin/bash
ADDR="$1"; UUID="$2"; EP="$3"
comps=$(python3 -c "import time;t=time.localtime(int(float(\"$EP\")));print(t.tm_hour,t.tm_min,t.tm_sec,t.tm_year,t.tm_mon,t.tm_mday)")
set -- $comps; H=$1; M=$2; S=$3; YR=$4; MON=$5; DAY=$6
osascript -e "tell application \"Things3\"
set d to current date
set time of d to $H * hours + $M * minutes + $S
set day of d to 1
set year of d to $YR
set month of d to $MON
set day of d to $DAY
set modification date of $ADDR id \"$UUID\" to d
end tell"'

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
  lab_ssh "$ip" 'cat > /tmp/sig.sh && chmod +x /tmp/sig.sh' <<<"$SIGSH"
  lab_ssh "$ip" 'cat > /tmp/restore.sh && chmod +x /tmp/restore.sh' <<<"$RESTORESH"
  echo "$ip"
}
repin(){ lab_ssh "$1" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date ${2:-$PIN_DATE} >/dev/null" </dev/null; }
launch_things(){ lab_ssh "$1" 'open -g -a Things3; sleep 14' </dev/null; }
relaunch_things(){ lab_ssh "$1" 'osascript -e "tell application \"Things3\" to quit" 2>/dev/null; sleep 3; open -g -a Things3; sleep 14' </dev/null; }
gq(){ lab_ssh "$1" "/tmp/gsql.sh -q $(printf '%q' "$2")" </dev/null; }
sig(){ lab_ssh "$1" 'bash /tmp/sig.sh' </dev/null; }
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
# COORDINATES (golden-v2 framebuffer 2048x1536, Settings window centered) — SYNCLAT-verified:
#  Things menu=151,23 Settings=167,259 ThingsCloud tab=875,261 toggle=696,770
#  LogIn=1008,720 CreateAccount=1008,805 email=1008,604 password=1008,733
#  create-submit=1008,959 login-submit=1008,913 verify box1=807,789
#  Continue(verify)=1008,1005 Continue(newsletter)=1008,826 KeepCloud card=1008,852
#  Continue(merge)=1008,1156 DontAllow(localnet)=904,619 Settings close=526,187 Edit>Paste=353,280

vnc_create_account(){ # A only, mint path
  local ip="$1"; VVAR=A
  note "== A: CREATE the durable account (Settings>Things Cloud>toggle>Create) =="
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
vnc_login(){ # vnc_login <ip> <A|B>
  local ip="$1"; VVAR="$2"
  note "== $2: LOG IN to the durable account (merge=Keep only cloud) =="
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

##############################################################################
note "############ SYNC2B phase=$PHASE  golden=$GOLDEN ############"
NEEDCREATE=0
if [ ! -f "$DURABLE_ENV" ]; then provision_account; NEEDCREATE=1; else note "durable account present ($DURABLE_ENV) — LOGIN path"; fi
source "$DURABLE_ENV"

note "== clone A + B from $GOLDEN =="
tart clone "$GOLDEN" "$RUN-A"; tart clone "$GOLDEN" "$RUN-B"
cleanup(){ for s in A B; do tart stop "$RUN-$s" >/dev/null 2>&1; tart delete "$RUN-$s" >/dev/null 2>&1; done; note "clones deleted (account kept alive)"; }
trap cleanup EXIT

# B is pinned to America/Chicago (non-UTC) for the zone questions; A keeps guest default.
note "== boot BOTH concurrently (2-VM budget), pinned clock; B tz=America/Chicago =="
IPA=$(boot A); IPB=$(boot B America/Chicago); note "A=$IPA  B=$IPB"
note "   A tz: $(tz_of "$IPA" | tr '\n' ' ')"
note "   B tz: $(tz_of "$IPB" | tr '\n' ' ')"
launch_things "$IPA"; launch_things "$IPB"
VVAR=A; shot A-00-launch.png; VVAR=B; shot B-00-launch.png
note "   >>> PREFLIGHT: A-00-launch.png / B-00-launch.png must show trial VALID (~13 days left)."
note "   TLS under pinned clock: A=$(lab_ssh "$IPA" 'curl -s -m8 -o /dev/null -w "%{http_code}" https://cloud.culturedcode.com' </dev/null) B=$(lab_ssh "$IPB" 'curl -s -m8 -o /dev/null -w "%{http_code}" https://cloud.culturedcode.com' </dev/null)"

# ---- attach account ----
if [ "$NEEDCREATE" = 1 ]; then vnc_create_account "$IPA"; else vnc_login "$IPA" A; fi
sleep 20
note "   A BSSyncronyMetadata rows (pre-account SYNC1=0): $(gq "$IPA" 'SELECT COUNT(*) FROM BSSyncronyMetadata')"
if [ "$NEEDCREATE" = 1 ]; then
  # persist the durable account's shared sync UUID coordinates for future campaigns
  lab_ssh "$IPA" '/tmp/gsql.sh -q "SELECT uuid||\"=\"||quote(value) FROM BSSyncronyMetadata"' </dev/null > "$OUT/bssync-A-raw.txt"
  {
    echo "# --- durable account BSSyncronyMetadata coordinates (recorded $(date -u +%FT%TZ), golden-v2/3.22.12) ---"
    echo "# account-specific last-sync key + shared sync-history UUID (opaque, app-deterministic). Raw dump: $OUT/bssync-A-raw.txt"
  } >> "$DURABLE_ENV"
  note "   bssync raw -> $OUT/bssync-A-raw.txt (account UUID coordinates)"
fi
vnc_login "$IPB" B
sleep 20
note "   B LAB- seed synced down: $(gq "$IPB" "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'LAB-%'")"
snapshot "$IPA" 00-A-attached; snapshot "$IPB" 00-B-attached

##############################################################################
run_sy1(){
  note "##### SY-1 — baseline convergence sanity #####"
  local T; T=$(date +%H%M%S)
  local titleA="SY1-A-$T" titleB="SY1-B-$T"
  note "-- A creates $titleA -> expect on B after B pulls --"
  lab_ssh "$IPA" "open -g 'things:///add?title=$titleA&notes=fromA&auth-token=$AUTH_TOKEN'" </dev/null; sleep 6
  note "   A push signal: $(sig "$IPA")"
  relaunch_things "$IPB"
  note "   B has $titleA? -> [$(gq "$IPB" "SELECT title FROM TMTask WHERE title='$titleA'")]"
  note "-- B creates $titleB -> expect on A after A pulls --"
  lab_ssh "$IPB" "open -g 'things:///add?title=$titleB&notes=fromB&auth-token=$AUTH_TOKEN'" </dev/null; sleep 6
  note "   B push signal: $(sig "$IPB")"
  relaunch_things "$IPA"
  note "   A has $titleB? -> [$(gq "$IPA" "SELECT title FROM TMTask WHERE title='$titleB'")]"
  note "   A BSSync signal: $(sig "$IPA")  B BSSync signal: $(sig "$IPB")"
  snapshot "$IPA" sy1-A-final; snapshot "$IPB" sy1-B-final
}

run_sy2(){
  note "##### SY-2 — --preserve-modified / AS set-modification-date vs Things Cloud (THE GATE) #####"
  local R RTITLE
  RTITLE=$(gq "$IPA" "SELECT title FROM TMTask WHERE title LIKE 'LAB-%' AND trashed=0 AND type=0 AND status=0 ORDER BY title LIMIT 1")
  R=$(gq "$IPA" "SELECT uuid FROM TMTask WHERE title='$RTITLE' LIMIT 1")
  note "-- target synced row R: '$RTITLE' uuid=$R --"
  note "   present on A? $(gq "$IPA" "SELECT COUNT(*) FROM TMTask WHERE uuid='$R'")  on B? $(gq "$IPB" "SELECT COUNT(*) FROM TMTask WHERE uuid='$R'")"
  local umdA0 umdB0; umdA0=$(gq "$IPA" "SELECT userModificationDate FROM TMTask WHERE uuid='$R'"); umdB0=$(gq "$IPB" "SELECT userModificationDate FROM TMTask WHERE uuid='$R'")
  note "   umd baseline A=$umdA0  B=$umdB0"

  note "== P1: preserve-modified TAG APPLY on A (mutate + AS restore umd), then sync to B =="
  local umdPre; umdPre=$(gq "$IPA" "SELECT userModificationDate FROM TMTask WHERE uuid='$R'")
  lab_ssh "$IPA" "open -g 'things:///update?id=$R&add-tags=SYNC2B-P1&auth-token=$AUTH_TOKEN'" </dev/null; sleep 5
  local umdMut; umdMut=$(gq "$IPA" "SELECT userModificationDate FROM TMTask WHERE uuid='$R'")
  note "   A umd pre=$umdPre  post-tag(mut)=$umdMut  (bump expected)"
  lab_ssh "$IPA" "bash /tmp/restore.sh 'to do' '$R' '$umdPre'" </dev/null; sleep 3
  local umdRest; umdRest=$(gq "$IPA" "SELECT userModificationDate FROM TMTask WHERE uuid='$R'")
  note "   A umd restored=$umdRest  (expect floor($umdPre))"
  note "   A tag on R now: [$(gq "$IPA" "SELECT T.title FROM TMTaskTag TT JOIN TMTag T ON T.uuid=TT.tags WHERE TT.tasks='$R'" | tr '\n' ',')]"
  sleep 5; relaunch_things "$IPB"; sleep 4
  local umdBaft tagB; umdBaft=$(gq "$IPB" "SELECT userModificationDate FROM TMTask WHERE uuid='$R'")
  tagB=$(gq "$IPB" "SELECT T.title FROM TMTaskTag TT JOIN TMTag T ON T.uuid=TT.tags WHERE TT.tasks='$R'" | tr '\n' ',')
  note "   >>> (a) tag propagated to B? B tags on R: [$tagB]"
  note "   >>> (c) umd landed on B: $umdBaft"
  relaunch_things "$IPA"; sleep 4
  local umdAaft; umdAaft=$(gq "$IPA" "SELECT userModificationDate FROM TMTask WHERE uuid='$R'")
  note "   >>> (b) A restored umd survived round-trip? A umd now=$umdAaft (restored was $umdRest)"
  note "   >>> (d) dup/ghost? rows titled '$RTITLE' — A=$(gq "$IPA" "SELECT COUNT(*) FROM TMTask WHERE title='$RTITLE'") B=$(gq "$IPB" "SELECT COUNT(*) FROM TMTask WHERE title='$RTITLE'")"
  snapshot "$IPA" sy2-P1-A; snapshot "$IPB" sy2-P1-B

  note "== P2: plain AS set-modification-date BACKDATE on A -> sync to B =="
  local R2T R2; R2T=$(gq "$IPA" "SELECT title FROM TMTask WHERE title LIKE 'LAB-%' AND trashed=0 AND type=0 AND status=0 AND title<>'$RTITLE' ORDER BY title LIMIT 1")
  R2=$(gq "$IPA" "SELECT uuid FROM TMTask WHERE title='$R2T' LIMIT 1")
  note "   R2='$R2T' uuid=$R2  baseline umd A=$(gq "$IPA" "SELECT userModificationDate FROM TMTask WHERE uuid='$R2'") B=$(gq "$IPB" "SELECT userModificationDate FROM TMTask WHERE uuid='$R2'")"
  lab_ssh "$IPA" "bash /tmp/restore.sh 'to do' '$R2' '1577836800'" </dev/null; sleep 3   # backdate to 2020-01-01
  note "   A R2 umd backdated -> $(gq "$IPA" "SELECT userModificationDate FROM TMTask WHERE uuid='$R2'")"
  sleep 5; relaunch_things "$IPB"; sleep 4
  note "   >>> B R2 umd after sync: $(gq "$IPB" "SELECT userModificationDate FROM TMTask WHERE uuid='$R2'")  (did backdate propagate?)"
  relaunch_things "$IPA"; sleep 4
  note "   >>> A R2 umd after round-trip: $(gq "$IPA" "SELECT userModificationDate FROM TMTask WHERE uuid='$R2'")"
  snapshot "$IPA" sy2-P2-A; snapshot "$IPB" sy2-P2-B

  note "== P3: plain AS set-modification-date BACKDATE on B -> sync to A (reverse direction) =="
  local R3T R3; R3T=$(gq "$IPB" "SELECT title FROM TMTask WHERE title LIKE 'LAB-%' AND trashed=0 AND type=0 AND status=0 AND title NOT IN ('$RTITLE','$R2T') ORDER BY title LIMIT 1")
  R3=$(gq "$IPB" "SELECT uuid FROM TMTask WHERE title='$R3T' LIMIT 1")
  note "   R3='$R3T' uuid=$R3  baseline umd A=$(gq "$IPA" "SELECT userModificationDate FROM TMTask WHERE uuid='$R3'") B=$(gq "$IPB" "SELECT userModificationDate FROM TMTask WHERE uuid='$R3'")"
  lab_ssh "$IPB" "bash /tmp/restore.sh 'to do' '$R3' '1577836800'" </dev/null; sleep 3
  note "   B R3 umd backdated -> $(gq "$IPB" "SELECT userModificationDate FROM TMTask WHERE uuid='$R3'")"
  sleep 5; relaunch_things "$IPA"; sleep 4
  note "   >>> A R3 umd after sync: $(gq "$IPA" "SELECT userModificationDate FROM TMTask WHERE uuid='$R3'")  (did reverse backdate propagate?)"
  relaunch_things "$IPB"; sleep 4
  note "   >>> B R3 umd after round-trip: $(gq "$IPB" "SELECT userModificationDate FROM TMTask WHERE uuid='$R3'")"
  snapshot "$IPA" sy2-P3-A; snapshot "$IPB" sy2-P3-B
}

run_sy3(){
  note "##### SY-3 — spawn dedupe + creationDate zone #####"
  # Reference epochs for the 07-06 occurrence:
  #  UTC midnight 2026-07-06 = 1783296000 (SERDEL S5); Chicago(CDT,-5) midnight = 1783296000+18000 = 1783314000
  note "-- daily template lineage present on both? (LAB-REPEAT-DAILY) --"
  local tmplA tmplB
  tmplA=$(gq "$IPA" "SELECT uuid FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
  tmplB=$(gq "$IPB" "SELECT uuid FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NOT NULL LIMIT 1")
  note "   template uuid A=$tmplA  B=$tmplB  (same = synced lineage)"
  note "   pre-existing LAB-REPEAT-DAILY instances: A=$(gq "$IPA" "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL") B=$(gq "$IPB" "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL")"

  note "== take BOTH offline, advance BOTH clocks +1 day (07-06), spawn independently =="
  go_offline "$IPA"; go_offline "$IPB"
  repin "$IPA" "070612002026"; repin "$IPB" "070612002026"
  note "   A date: $(lab_ssh "$IPA" 'date' </dev/null)  B date: $(lab_ssh "$IPB" 'date' </dev/null)"
  relaunch_things "$IPA"; relaunch_things "$IPB"; sleep 6
  note "   A newest LAB-REPEAT-DAILY instance creationDate: $(gq "$IPA" "SELECT creationDate FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL ORDER BY creationDate DESC LIMIT 1")"
  local bInst bCreate
  bInst=$(gq "$IPB" "SELECT uuid FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL ORDER BY creationDate DESC LIMIT 1")
  bCreate=$(gq "$IPB" "SELECT creationDate FROM TMTask WHERE uuid='$bInst'")
  note "   B (America/Chicago) newest instance uuid=$bInst creationDate=$bCreate"
  note "   >>> ZONE (SERDEL S5): B creationDate=$bCreate  vs UTC-midnight 1783296000  vs Chicago-midnight 1783314000"
  note "   instance counts pre-reconnect: A=$(gq "$IPA" "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL") B=$(gq "$IPB" "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL")"
  snapshot "$IPA" sy3-preRC-A; snapshot "$IPB" sy3-preRC-B

  note "== RECONNECT both (reboot -> re-pin 07-06 -> relaunch) and let them converge =="
  tart stop "$RUN-A"; tart stop "$RUN-B"; sleep 4
  (tart run "$RUN-A" --no-graphics --vnc-experimental >>"$OUT/tart-run-A.log" 2>&1 &)
  (tart run "$RUN-B" --no-graphics --vnc-experimental >>"$OUT/tart-run-B.log" 2>&1 &)
  sleep 3
  IPA=$(lab_wait_for_ssh "$RUN-A" 300); IPB=$(lab_wait_for_ssh "$RUN-B" 300)
  echo "$IPA" > "$OUT/ip-A.txt"; echo "$IPB" > "$OUT/ip-B.txt"
  lab_ssh "$IPA" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"; lab_ssh "$IPB" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"
  repin "$IPA" "070612002026"; repin "$IPB" "070612002026"; lab_ssh "$IPB" "sudo systemsetup -settimezone America/Chicago >/dev/null 2>&1" </dev/null
  note "   reconnected A=$IPA B=$IPB  cloud: A=$(lab_ssh "$IPA" 'curl -s -m8 -o /dev/null -w "%{http_code}" https://cloud.culturedcode.com' </dev/null) B=$(lab_ssh "$IPB" 'curl -s -m8 -o /dev/null -w "%{http_code}" https://cloud.culturedcode.com' </dev/null)"
  relaunch_things "$IPA"; relaunch_things "$IPB"; sleep 8
  relaunch_things "$IPA"; relaunch_things "$IPB"; sleep 8   # second round to settle the merge
  note "   >>> DEDUPE: 07-06 LAB-REPEAT-DAILY instance count after reconvergence: A=$(gq "$IPA" "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL AND creationDate>=1783296000") B=$(gq "$IPB" "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL AND creationDate>=1783296000")"
  note "   winning instance rows (uuid|creationDate) after converge — A view:"
  lab_ssh "$IPA" "/tmp/gsql.sh -q \"SELECT uuid||'|'||creationDate FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL AND creationDate>=1783296000\"" </dev/null | tee -a "$REPORT"
  note "   B view:"
  lab_ssh "$IPB" "/tmp/gsql.sh -q \"SELECT uuid||'|'||creationDate FROM TMTask WHERE title LIKE 'LAB-REPEAT-DAILY%' AND rt1_recurrenceRule IS NULL AND creationDate>=1783296000\"" </dev/null | tee -a "$REPORT"
  snapshot "$IPA" sy3-postRC-A; snapshot "$IPB" sy3-postRC-B
}

run_sy2m(){
  note "##### SY-2M — CONTENT-mutation propagation under preserve-modified (AS vector) #####"
  # Answers SY-2 sub-question (a): does a real content edit propagate to the peer
  # even after its umd is restored to an OLDER value — i.e. is propagation driven by
  # something OTHER than umd? (sy2 P1's URL `add-tags` no-oped, so the mutation never
  # happened there; here the mutation is the token-free AS vector, which is also the
  # surface the shipped flag's restore leg uses.)
  local R RTITLE MARK
  RTITLE=$(gq "$IPA" "SELECT title FROM TMTask WHERE title LIKE 'LAB-%' AND trashed=0 AND type=0 AND status=0 ORDER BY title LIMIT 1")
  R=$(gq "$IPA" "SELECT uuid FROM TMTask WHERE title='$RTITLE' LIMIT 1")
  MARK="SY2M-$(date +%H%M%S)"
  note "-- target synced row R: '$RTITLE' uuid=$R ; marker=$MARK --"
  note "   umd baseline A=$(gq "$IPA" "SELECT userModificationDate FROM TMTask WHERE uuid='$R'") B=$(gq "$IPB" "SELECT userModificationDate FROM TMTask WHERE uuid='$R'")"

  note "== diag: does URL things:///update work on the clone? (explains sy2 P1 no-op) =="
  local umdU0; umdU0=$(gq "$IPA" "SELECT userModificationDate FROM TMTask WHERE uuid='$R'")
  lab_ssh "$IPA" "open -g 'things:///update?id=$R&notes=URLDIAG-$MARK&auth-token=$AUTH_TOKEN'" </dev/null; sleep 5
  note "   after URL update: A notes=[$(gq "$IPA" "SELECT notes FROM TMTask WHERE uuid='$R'")] umd=$(gq "$IPA" "SELECT userModificationDate FROM TMTask WHERE uuid='$R'") (was $umdU0)"

  note "== M1: AS set notes on A (bumps umd) -> restore umd -> sync to B =="
  local umdPre; umdPre=$(gq "$IPA" "SELECT userModificationDate FROM TMTask WHERE uuid='$R'")
  lab_ssh "$IPA" "osascript -e 'tell application \"Things3\" to set notes of to do id \"$R\" to \"NOTESMUT-$MARK\"'" </dev/null; sleep 3
  local umdMut; umdMut=$(gq "$IPA" "SELECT userModificationDate FROM TMTask WHERE uuid='$R'")
  note "   A notes now=[$(gq "$IPA" "SELECT notes FROM TMTask WHERE uuid='$R'")]  umd pre=$umdPre mut=$umdMut (bump expected)"
  lab_ssh "$IPA" "bash /tmp/restore.sh 'to do' '$R' '$umdPre'" </dev/null; sleep 3
  note "   A umd restored=$(gq "$IPA" "SELECT userModificationDate FROM TMTask WHERE uuid='$R'") (expect floor($umdPre))"
  sleep 5; relaunch_things "$IPB"; sleep 4
  note "   >>> (a) content propagated to B? B notes=[$(gq "$IPB" "SELECT notes FROM TMTask WHERE uuid='$R'")]  B umd=$(gq "$IPB" "SELECT userModificationDate FROM TMTask WHERE uuid='$R'")"
  relaunch_things "$IPA"; sleep 4
  note "   >>> (b) A after round-trip: notes=[$(gq "$IPA" "SELECT notes FROM TMTask WHERE uuid='$R'")] umd=$(gq "$IPA" "SELECT userModificationDate FROM TMTask WHERE uuid='$R'")"
  snapshot "$IPA" sy2m-M1-A; snapshot "$IPB" sy2m-M1-B

  note "== M2: AS tag apply on A (canonical preserve-modified case) -> restore umd -> sync to B =="
  local TAG; TAG=$(gq "$IPA" "SELECT title FROM TMTag ORDER BY title LIMIT 1")
  note "   applying existing seed tag '$TAG' to R via AS"
  local umdT0; umdT0=$(gq "$IPA" "SELECT userModificationDate FROM TMTask WHERE uuid='$R'")
  lab_ssh "$IPA" "osascript -e 'tell application \"Things3\" to set tag names of to do id \"$R\" to \"$TAG\"'" </dev/null; sleep 3
  local umdT1; umdT1=$(gq "$IPA" "SELECT userModificationDate FROM TMTask WHERE uuid='$R'")
  note "   A tags now=[$(gq "$IPA" "SELECT group_concat(T.title) FROM TMTaskTag TT JOIN TMTag T ON T.uuid=TT.tags WHERE TT.tasks='$R'")] umd $umdT0->$umdT1"
  lab_ssh "$IPA" "bash /tmp/restore.sh 'to do' '$R' '$umdT0'" </dev/null; sleep 3
  note "   A umd restored=$(gq "$IPA" "SELECT userModificationDate FROM TMTask WHERE uuid='$R'")"
  sleep 5; relaunch_things "$IPB"; sleep 4
  note "   >>> (a-tag) tag propagated to B? B tags=[$(gq "$IPB" "SELECT group_concat(T.title) FROM TMTaskTag TT JOIN TMTag T ON T.uuid=TT.tags WHERE TT.tasks='$R'")] B umd=$(gq "$IPB" "SELECT userModificationDate FROM TMTask WHERE uuid='$R'")"
  note "   >>> dup/ghost? rows titled '$RTITLE' — A=$(gq "$IPA" "SELECT COUNT(*) FROM TMTask WHERE title='$RTITLE'") B=$(gq "$IPB" "SELECT COUNT(*) FROM TMTask WHERE title='$RTITLE'")"
  snapshot "$IPA" sy2m-M2-A; snapshot "$IPB" sy2m-M2-B
}

case "$PHASE" in
  sy1) run_sy1 ;;
  sy2) run_sy2 ;;
  sy2m) run_sy2m ;;
  sy3) run_sy3 ;;
  all) run_sy1; run_sy2; run_sy3 ;;
  *) note "unknown phase '$PHASE' (sy1|sy2|sy2m|sy3|all)"; exit 1 ;;
esac

note "GREEN — report: $REPORT ; artifacts in $OUT"
note "ACCOUNT KEPT ALIVE (durable, no churn): creds in $DURABLE_ENV"
trap - EXIT; cleanup
