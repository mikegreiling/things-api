#!/bin/bash
# SYNCLAT — do programmatic writes trigger a Things Cloud push? (docs/up-next.md §6)
# NETWORKED, TWO clones (A=writer, B=observer) of things-lab-golden-v1 signed into
# ONE throwaway Things Cloud account, BOTH running concurrently with a live GUI.
#
# HEADLINE QUESTION (Mike, 2026-07-23): a `things` CLI (URL-scheme) to-do appeared
# in the desktop GUI instantly but did NOT reach the phone for minutes, and the
# Things Cloud settings panel showed the last sync 15-20 min prior. Hypothesis:
# GUI edits push immediately; URL-scheme / AppleScript writes ride only the
# periodic sync timer. This probe measures, per write vector, whether clone A's
# BSSyncronyMetadata last-sync-ATTEMPT signal advances promptly (= A pushed).
#
# ==== KEY MECHANICS (verified 2026-07-23; reuse these) ====
# * CLOCK: run on the PINNED clock (2026-07-05), NOT NTP-realtime. Verified this
#   run: under the pinned clock the trial is valid ("13 days left"), TLS to
#   cloud.culturedcode.com returns 200, account creation + BSSyncronyMetadata
#   populate + two-clone sync ALL work. This sidesteps trial expiry entirely
#   (the golden's ~2026-07-18 real-date expiry is moot). The last-attempt signal
#   is stamped in PINNED-guest-clock seconds; the pinned clock ticks at real rate,
#   so signal deltas == real elapsed seconds. Measurement axis = HOST wall-clock.
# * VNC menu-bar dropdowns (Things > Settings) MUST be driven in ONE vncdo
#   invocation (`move x y click 1 pause 1 move x2 y2 click 1`) — a menu opened by
#   one connection closes when that connection exits. Persistent WINDOWS (the
#   Settings dialog, its fields/buttons) tolerate separate per-op clicks.
# * vncdo `type` sends letters LOWERCASE and cannot do shifted chars; text entry
#   into fields is via the CLIPBOARD (`pbcopy` in guest + Edit-menu Paste). GUI
#   marker titles are therefore all-lowercase (typed directly).
# * On B's login MERGE dialog choose "Keep only the to-dos from Things Cloud"
#   (both clones share the identical golden seed; "Keep all" duplicates it).
# * Decline the "find devices on local networks" prompt on BOTH clones so sync
#   rides the CLOUD, not LAN peer discovery (which would confound push latency).
# * APNs push is unavailable in the VM (SYNC2) -> clone B PULLS on a slow polling
#   timer, so B-arrival latency reflects B's polling, NOT a real APNs phone.
#   Interpret A's push-signal (the clean core-hypothesis test) and B-arrival
#   SEPARATELY. A `things:///show?id=` invocation on B can force an on-demand pull.
# * NO "Sync Now" menu item exists (UIC1 File/Items/app-menu dumps) -> no AX sync
#   trigger; the sync-nudge mitigation must be a benign URL/AppleScript op.
#
# SAFETY: never touches the host Things app/container. Throwaway account (mail.tm
# inbox + random password, no Apple ID) recorded ONLY in the gitignored run dir.
# BURN the account afterward (Syncrony DELETE recipe, see bottom).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"                 # path to a vncdotool CLI (REQUIRED)
GOLDEN="${GOLDEN:-things-lab-golden-v1}"
PIN_DATE="${PIN_DATE:-070512002026}"   # `date` MMDDhhmmYYYY = 2026-07-05 12:00

RUN="things-run-synclat-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$RUN"; mkdir -p "$OUT/scenario-snapshots"
REPORT="$OUT/report.txt"
note(){ echo "[synclat] $*" | tee -a "$REPORT"; }
[ -z "$VNCDO" ] && { note "FATAL: \$VNCDO required (account creation is VNC-driven)"; exit 1; }

# ---- throwaway account (disposable mail.tm inbox + random password) ----
mailtm(){ curl -s -m 20 "$@"; }
provision_account(){
  local dom email mpass tcpass
  dom=$(mailtm https://api.mail.tm/domains | python3 -c 'import sys,json;print(json.load(sys.stdin)["hydra:member"][0]["domain"])')
  email="synclat$(python3 -c 'import secrets;print(secrets.token_hex(4))')@$dom"
  mpass=$(python3 -c 'import secrets;print(secrets.token_urlsafe(12))')
  tcpass=$(python3 -c 'import secrets,string;a=string.ascii_lowercase+string.digits;print("".join(secrets.choice(a) for _ in range(16)))')
  mailtm -X POST https://api.mail.tm/accounts -H 'Content-Type: application/json' \
    -d "{\"address\":\"$email\",\"password\":\"$mpass\"}" >/dev/null
  cat > "$OUT/account-credentials.env" <<EOF
MAILTM_EMAIL=$email
MAILTM_PASS=$mpass
THINGS_CLOUD_PASS=$tcpass
EOF
  note "account provisioned: $email (creds in $OUT/account-credentials.env)"
}
mail_token(){ source "$OUT/account-credentials.env"; mailtm -X POST https://api.mail.tm/token \
  -H 'Content-Type: application/json' -d "{\"address\":\"$MAILTM_EMAIL\",\"password\":\"$MAILTM_PASS\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'; }
fetch_verify_code(){ local tok id; tok=$(mail_token)
  for _ in $(seq 1 20); do
    id=$(mailtm https://api.mail.tm/messages -H "Authorization: Bearer $tok" \
      | python3 -c 'import sys,json;d=json.load(sys.stdin)["hydra:member"];print(d[0]["id"] if d else "")')
    [ -n "$id" ] && break; sleep 6
  done
  [ -z "$id" ] && { echo "NO-MAIL"; return 1; }
  mailtm "https://api.mail.tm/messages/$id" -H "Authorization: Bearer $tok" \
    | python3 -c 'import sys,json,re;d=json.load(sys.stdin,strict=False);m=re.search(r"(\d{6})",d.get("text","")+d.get("subject",""));print(m.group(1) if m else "NO-CODE")'; }

# ---- clone/boot/net helpers (BOTH clones run concurrently) ----
GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'
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
boot(){ # boot <suffix>  -> echoes IP, installs helpers, records vnc url
  local vm="$RUN-$1" ip
  (tart run "$vm" --no-graphics --vnc-experimental >"$OUT/tart-run-$1.log" 2>&1 &)
  sleep 3
  ip=$(lab_wait_for_ssh "$vm" 300)
  grep -o 'vnc://[^ ]*' "$OUT/tart-run-$1.log" | head -1 > "$OUT/vnc-$1.txt" 2>/dev/null || true
  echo "$ip" > "$OUT/ip-$1.txt"
  lab_ssh "$ip" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN_DATE >/dev/null" </dev/null
  lab_ssh "$ip" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"
  lab_ssh "$ip" 'cat > /tmp/sig.sh && chmod +x /tmp/sig.sh' <<<"$SIGSH"
  echo "$ip"
}
launch_things(){ lab_ssh "$1" 'open -g -a Things3; sleep 14' </dev/null; }

# ---- VNC helpers (framebuffer 2048x1536) ----
VVAR=""
V(){ local url hp s p; url=$(cat "$OUT/vnc-$VVAR.txt"); hp=${url#vnc://}; hp=${hp##*@}
  s="${hp%%:*}::${hp##*:}"; p=$(echo "$url" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
  perl -e 'alarm 60; exec @ARGV' "$VNCDO" -s "$s" ${p:+-p "$p"} "$@" 2>>"$OUT/vnc-$VVAR.log" || true; }
shot(){ V capture "$OUT/$1"; note "   [shot] $1"; }
paste_into(){ # paste_into <ip> <x> <y> <value>  (clipboard + Edit>Paste)
  V move "$2" "$3" click 1
  lab_ssh "$1" "printf '%s' $(printf '%q' "$4") | pbcopy" </dev/null
  V move 341 22 click 1 pause 1 move 353 280 click 1; }
Asig(){ lab_ssh "$(cat "$OUT/ip-A.txt")" 'bash /tmp/sig.sh' </dev/null; }

# COORDINATES (golden framebuffer 2048x1536, Settings window centered):
#  Things menu=151,23  Settings item=167,259  ThingsCloud tab=875,261  toggle=696,770
#  LogIn=1008,720  CreateAccount=1008,805  email=1008,604  password=1008,733
#  create-submit=1008,959  login-submit=1008,913  verify box1=807,789
#  Continue(verify)=1008,1005  Continue(newsletter)=1008,826  KeepCloud card=1008,852
#  Continue(merge)=1008,1156  DontAllow(localnet)=904,619  Settings close=526,187
#  Today "+" new-to-do toolbar button=998,1382

##############################################################################
note "############ SYNCLAT — programmatic-write sync push ############"
provision_account; source "$OUT/account-credentials.env"
note "== clone A (writer) + B (observer) =="
tart clone "$GOLDEN" "$RUN-A"; tart clone "$GOLDEN" "$RUN-B"
cleanup(){ for s in A B; do tart stop "$RUN-$s" >/dev/null 2>&1; tart delete "$RUN-$s" >/dev/null 2>&1; done; }
trap cleanup EXIT

note "== boot BOTH concurrently (2-VM budget = exactly A+B), pinned clock =="
IPA=$(boot A); IPB=$(boot B); note "A=$IPA  B=$IPB"
launch_things "$IPA"; launch_things "$IPB"
VVAR=A; shot A-01-launch.png
note "   >>> PREFLIGHT: A-01-launch.png must show the trial VALID (e.g. '13 days"
note "   left'), NOT an expired modal. If expired at the pinned date, STOP."
note "   TLS reachability under pinned clock:"
lab_ssh "$IPA" 'curl -s -m8 -o /dev/null -w "cloud=%{http_code}\n" https://cloud.culturedcode.com' </dev/null | tee -a "$REPORT"

note "== A: create the throwaway account (Settings > Things Cloud > toggle > Create) =="
V move 151 23 click 1 pause 1 move 167 259 click 1; sleep 3   # Settings (single invocation!)
V move 875 261 click 1; sleep 2                                # Things Cloud tab
V move 696 770 click 1; sleep 3                                # enable toggle
V move 1008 805 click 1; sleep 3                               # Create Account
paste_into "$IPA" 1008 604 "$MAILTM_EMAIL"
paste_into "$IPA" 1008 733 "$THINGS_CLOUD_PASS"
V move 1008 959 click 1; sleep 6                               # submit
CODE=$(fetch_verify_code); note "   verify code: $CODE"
V move 807 789 click 1 pause 1 type "$CODE"; sleep 2           # 6-digit code (auto-advance)
V move 1008 1005 click 1; sleep 6                              # Continue (verify)
V move 1008 826 click 1; sleep 6                               # Continue (newsletter, unchecked)
V move 904 619 click 1; sleep 3                                # Don't Allow (local network)
V move 526 187 click 1; sleep 2                                # close Settings
shot A-02-cloudsettled.png
sleep 20
note "   A BSSyncronyMetadata rows (SYNC1 pre-account: 0): $(lab_ssh "$IPA" '/tmp/gsql.sh -q "SELECT COUNT(*) FROM BSSyncronyMetadata"' </dev/null)"

note "== B: LOG IN to the same account (merge = Keep only cloud) =="
VVAR=B
V move 151 23 click 1 pause 1 move 167 259 click 1; sleep 3
V move 875 261 click 1; sleep 2; V move 696 770 click 1; sleep 3
V move 1008 720 click 1; sleep 3                               # Log In
paste_into "$IPB" 1008 604 "$MAILTM_EMAIL"; paste_into "$IPB" 1008 733 "$THINGS_CLOUD_PASS"
V move 1008 913 click 1; sleep 8                               # Log In submit
V move 1008 852 click 1; sleep 1                               # "Keep only cloud" card
V move 1008 1156 click 1; sleep 6                              # Continue
V move 904 619 click 1; sleep 3; V move 526 187 click 1; sleep 2  # Don't Allow + close
sleep 20
note "   B sees the seed synced down (LAB- count): $(lab_ssh "$IPB" "/tmp/gsql.sh -q \"SELECT COUNT(*) FROM TMTask WHERE title LIKE 'LAB-%'\"" </dev/null)"

##############################################################################
# The arms + poller are documented in docs/lab/synclat-results.md. The poller
# (poll.sh, emitted per-run alongside this script) samples A's push signal and
# B's arrival for a marker title, on the HOST wall-clock axis. The measured
# sequence (see results doc): no-write cadence baseline -> GUI control ->
# URL someday (no nudge, ride to periodic) -> URL today -> AppleScript make ->
# Shortcuts heading -> mitigation nudges (things:///show, AS read touch,
# activate). Each arm: capture BASE=$(Asig); do the write; T0=$(date +%s.%N);
# poll. See docs/lab/synclat-results.md for the arm-by-arm verdict table.
note "== arms: see docs/lab/synclat-results.md (poll.sh drives the per-arm sampling) =="

note "GREEN — report: $REPORT ; artifacts in $OUT"
note "ACCOUNT IS LIVE — burn it (Syncrony DELETE recipe):"
note "  curl -s -o /dev/null -w '%{http_code}' -X DELETE \\"
note "    https://cloud.culturedcode.com/version/1/account/\$MAILTM_EMAIL \\"
note "    -H \"Authorization: Password \$THINGS_CLOUD_PASS\"   # -> 202, then 404 confirms"
trap - EXIT; cleanup
