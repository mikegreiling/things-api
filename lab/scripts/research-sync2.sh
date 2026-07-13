#!/bin/bash
# SYNC2 — Things Cloud conflict-semantics probe (docs/up-next.md §2). NETWORKED,
# TWO clones (A,B) of things-lab-golden-v1 signed into ONE throwaway Things Cloud
# account. This BREAKS the airgap convention deliberately (sanctioned exception):
# the probe requires the sync server, so network stays UP and the guest clock
# NTP-syncs to real time (verify the golden's trial is still valid at real date
# before running — trial was pinned 2026-07-05, expiry ~2026-07-18).
#
# SAFETY: never touches the host Things app/container. A fresh throwaway account
# (disposable mail.tm inbox + random password) is created INSIDE the VM's Things
# app. No Apple ID. Record + burn the account afterward.
#
# This script is CHOREOGRAPHED: the account-creation + login arms are VNC-driven
# GUI steps (framebuffer 2048x1536; coordinates below), gated on $VNCDO. The
# sync + conflict-induction arms are fully automated over SSH. Run interactively
# and watch the screenshots — the GUI arms are not perfectly unattended (Things
# occasionally throws a transient RBS "Launch failed" on first `open -a` after a
# boot; the immediately-following `open -g -a` succeeds).
#
# 2-concurrent-VM budget: only ONE VM is booted at a time; the clones alternate.
#
# ==== KEY MECHANICS LEARNED THIS RUN (reuse these) ====
# * vncdo modifiers/shift are BROKEN here: `type "@"` sends '2'; `key super-a`
#   types a literal 'a' (no Cmd); chords hang. => drive menus by COORDINATE
#   clicks, and enter text via the CLIPBOARD: `printf %s "$val" | pbcopy` in the
#   guest, then Edit-menu > Select All > Paste (menu clicks, no keyboard chords).
# * Each vncdo invocation is a fresh session, so held modifiers do NOT persist
#   across invocations. Guard every vncdo call with a perl alarm (it sometimes
#   hangs). Digits type fine; the 6-digit verify boxes auto-advance.
# * TRUE OFFLINE needs BOTH default routes: `route delete -inet default` alone
#   leaves the IPv6 default route up and Things Cloud syncs over IPv6 (curl to
#   cloud.culturedcode.com returns 200). Delete -inet AND -inet6, then verify
#   with `curl -m5 https://cloud.culturedcode.com` == 000. Also QUIT Things
#   before dropping routes so no live keep-alive sync socket leaks the edit.
# * Reconnect reliably by REBOOTING the clone (tart stop/start = clean DHCP);
#   `ipconfig set en0 DHCP` mid-session hangs SSH.
# * `sudo log show` works on a normal-clock networked boot (SYNC1's "0 lines"
#   was the zsh `log` builtin shadowing /usr/bin/log, not an absent store).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"                 # path to a vncdotool CLI (REQUIRED for GUI arms)
GOLDEN="${GOLDEN:-things-lab-golden-v1}"
IPV4_GW="${IPV4_GW:-192.168.64.1}" # tart shared-net gateway (for reconnect via route add)

RUN="things-run-sync2-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$RUN"; mkdir -p "$OUT/scenario-snapshots"
REPORT="$OUT/report.txt"
note(){ echo "[sync2] $*" | tee -a "$REPORT"; }

# ---- throwaway account (disposable mail.tm inbox + random password) ----
mailtm(){ curl -s -m 20 "$@"; }
provision_account(){
  local dom email mpass tcpass
  dom=$(mailtm https://api.mail.tm/domains | python3 -c 'import sys,json;print(json.load(sys.stdin)["hydra:member"][0]["domain"])')
  email="sync2lab$(python3 -c 'import secrets;print(secrets.token_hex(4))')@$dom"
  mpass=$(python3 -c 'import secrets;print(secrets.token_urlsafe(12))')
  # Things Cloud password: lowercase+digits only (vncdo type can't do shifted chars)
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
fetch_verify_code(){ # poll inbox, echo the 6-digit code from the culturedcode mail
  local tok id; tok=$(mail_token)
  for _ in $(seq 1 20); do
    id=$(mailtm https://api.mail.tm/messages -H "Authorization: Bearer $tok" \
      | python3 -c 'import sys,json;d=json.load(sys.stdin)["hydra:member"];print(d[0]["id"] if d else "")')
    [ -n "$id" ] && break; sleep 6
  done
  [ -z "$id" ] && { echo "NO-MAIL"; return 1; }
  mailtm "https://api.mail.tm/messages/$id" -H "Authorization: Bearer $tok" \
    | python3 -c 'import sys,json,re;d=json.load(sys.stdin,strict=False);m=re.search(r"----\s*(\d{6})\s*----",d.get("text",""));print(m.group(1) if m else "NO-CODE")'
}

# ---- clone/boot/net helpers (one VM at a time) ----
boot(){ # boot <suffix>  -> echoes IP, installs gsql, records vnc url
  local vm="$RUN-$1"
  (tart run "$vm" --no-graphics --vnc-experimental >"$OUT/tart-run-$1.log" 2>&1 &)
  sleep 3
  local ip; ip=$(lab_wait_for_ssh "$vm" 300)
  grep -o 'vnc://[^ ]*' "$OUT/tart-run-$1.log" | head -1 > "$OUT/vnc-$1.txt" 2>/dev/null || true
  lab_ssh "$ip" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
  echo "$ip"
}
ntp_realtime(){ lab_ssh "$1" 'sudo systemsetup -setnetworktimeserver time.apple.com >/dev/null 2>&1; sudo systemsetup -setusingnetworktime on >/dev/null 2>&1; sleep 5' </dev/null; }
launch_things(){ lab_ssh "$1" 'open -g -a Things3; sleep 12' </dev/null; }
gq(){ lab_ssh "$1" "/tmp/gsql.sh -q $(printf '%q' "$2")" </dev/null; }
# TRUE offline: quit Things (drop live socket), delete BOTH default routes, verify.
go_offline(){ lab_ssh "$1" 'osascript -e "tell application \"Things3\" to quit" 2>/dev/null; sleep 2
  sudo route -n delete -inet default >/dev/null 2>&1; sudo route -n delete -inet6 default >/dev/null 2>&1; sleep 1
  curl -s -m6 -o /dev/null -w "cloud=%{http_code}\n" https://cloud.culturedcode.com 2>&1 || echo cloud=000' </dev/null; }

# ---- VNC helper: ALL args in ONE guarded session (framebuffer 2048x1536) ----
VVAR=""
V(){ local url s p; url=$(cat "$OUT/vnc-$VVAR.txt"); local hp=${url#vnc://}; hp=${hp##*@}
  s="${hp%%:*}::${hp##*:}"; p=$(echo "$url" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
  perl -e 'alarm 40; exec @ARGV' "$VNCDO" -s "$s" ${p:+-p "$p"} "$@" 2>>"$OUT/vnc-$VVAR.log" || true; }
shot(){ V capture "$OUT/$1"; note "   [shot] $1"; }
paste_into(){ # paste_into <ip> <field-x> <field-y> <value>  (clipboard + Edit>Paste)
  V move "$2" "$3" click 1; sleep 1
  lab_ssh "$1" "printf '%s' $(printf '%q' "$4") | pbcopy" </dev/null
  V move 341 22 click 1; sleep 1; V move 353 280 click 1; sleep 1; }  # Edit menu -> Paste

# COORDINATES (golden framebuffer 2048x1536, Settings window centered):
#  Things menu=151,23  Settings item=167,259  ThingsCloud tab=875,261
#  cloud toggle=696,770  LogIn=1008,720  CreateAccount=1008,805
#  email field=1008,604  password field=1008,733  create/login submit=1008,913..959
#  verify first box=807,789  Continue=1008,1005/826  Dont-Allow(localnet)=904,619
#  Settings close(red)=526,187 ; Edit-menu Paste=353,280 SelectAll=376,369

##############################################################################
note "############ SYNC2 — Things Cloud conflict semantics ############"
[ -z "$VNCDO" ] && { note "FATAL: \$VNCDO required (account creation is VNC-driven)"; exit 1; }
provision_account
source "$OUT/account-credentials.env"

note "== clone A + B (both from $GOLDEN) =="
tart clone "$GOLDEN" "$RUN-A"; tart clone "$GOLDEN" "$RUN-B"
cleanup(){ for s in A B; do tart stop "$RUN-$s" >/dev/null 2>&1; tart delete "$RUN-$s" >/dev/null 2>&1; done; }
trap cleanup EXIT

# ---------- PHASE 1: boot A, NTP, PREFLIGHT trial, create account, verify sync ----------
note "== boot A (networked) + NTP to real time =="
IP=$(boot A); VVAR=A; note "A ip=$IP"
ntp_realtime "$IP"; launch_things "$IP"
shot A-01-launch.png
note "   >>> PREFLIGHT: inspect A-01-launch.png — Things MUST be un-nagged (trial"
note "   'N days left' banner, no expired modal). If expired at real date, STOP."
note "== VNC-create the throwaway account: Things menu>Settings>Things Cloud>toggle>Create Account =="
V move 151 23 click 1; sleep 1; V move 167 259 click 1; sleep 2      # Settings
V move 875 261 click 1; sleep 2; V move 696 770 click 1; sleep 3     # Things Cloud tab + toggle
V move 1008 805 click 1; sleep 3                                     # Create Account
paste_into "$IP" 1008 604 "$MAILTM_EMAIL"                            # email (clipboard)
paste_into "$IP" 1008 733 "$THINGS_CLOUD_PASS"                       # password
shot A-08-createaccount.png
V move 1008 959 click 1; sleep 6                                     # Create Account submit
CODE=$(fetch_verify_code); note "   verification code from inbox: $CODE"
V move 807 789 click 1; sleep 1; V type "$CODE"; sleep 1             # enter 6-digit code
V move 1008 1005 click 1; sleep 6                                    # Continue (verify)
V move 1008 826 click 1; sleep 6                                     # Continue (newsletter, unchecked)
V move 904 619 click 1; sleep 3                                      # Dont Allow (local-network)
V move 526 187 click 1; sleep 2                                      # close Settings
shot A-19-cloudsettled.png

note "== confirm sync works: BSSyncronyMetadata should POPULATE (SYNC1 open Q) =="
sleep 20
note "   BSSyncronyMetadata rows: $(gq "$IP" 'SELECT COUNT(*) FROM BSSyncronyMetadata')  (SYNC1 pre-account: 0)"
lab_ssh "$IP" '/tmp/gsql.sh -q "SELECT uuid||\"|\"||quote(value) FROM BSSyncronyMetadata"' </dev/null > "$OUT/bssync-A-raw.txt"
python3 - "$OUT/bssync-A-raw.txt" <<'PY' | tee -a "$REPORT"
import sys,plistlib,datetime
E=datetime.datetime(2001,1,1,tzinfo=datetime.timezone.utc)
for L in open(sys.argv[1]):
  L=L.rstrip("\n"); u,q=L.split("|",1) if "|" in L else (L,"")
  try: v=plistlib.loads(bytes.fromhex(q[2:-1]))
  except Exception as e: v=f"<{e}>"
  x=f" -> {(E+datetime.timedelta(seconds=v)).isoformat()}" if isinstance(v,float) else ""
  print(f"  {u}: {v!r}{x}")
PY
note "== seed marker + confirm last-sync signal advances on sync =="
lab_ssh "$IP" 'open -g "things:///add?title=SYNC2-MARKER-A&notes=seeded-on-A"' </dev/null; sleep 4
note "   last-sync (GryCJ44xPcJG6go5KeTZp1) before/after should advance:"
note "   pre : $(gq "$IP" 'SELECT quote(value) FROM BSSyncronyMetadata WHERE uuid="GryCJ44xPcJG6go5KeTZp1"')"
sleep 15
note "   post: $(gq "$IP" 'SELECT quote(value) FROM BSSyncronyMetadata WHERE uuid="GryCJ44xPcJG6go5KeTZp1"')"
lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/s.sqlite"' </dev/null
lab_scp "$LAB_SSH_USER@$IP:/tmp/s.sqlite" "$OUT/scenario-snapshots/00-A-baseline.sqlite" </dev/null 2>/dev/null

# ---------- PHASE 2: boot B, LOG IN to same account, confirm sync-down ----------
note "== stop A, boot B, LOG IN to the SAME account (merge=Keep all) =="
tart stop "$RUN-A"; sleep 3
IP=$(boot B); VVAR=B; note "B ip=$IP"
ntp_realtime "$IP"; launch_things "$IP"
V move 151 23 click 1; sleep 1; V move 167 259 click 1; sleep 2
V move 875 261 click 1; sleep 2; V move 696 770 click 1; sleep 3
V move 1008 720 click 1; sleep 3                                     # Log In
paste_into "$IP" 1008 604 "$MAILTM_EMAIL"; paste_into "$IP" 1008 733 "$THINGS_CLOUD_PASS"
V move 1008 913 click 1; sleep 8                                     # Log In submit
V move 1008 1156 click 1; sleep 5                                    # "Keep all to-dos" merge > Continue
V move 904 619 click 1; sleep 3; V move 526 187 click 1; sleep 2     # Dont Allow + close
sleep 20
note "   B sees SYNC2-MARKER-A (synced DOWN): $(gq "$IP" 'SELECT title FROM TMTask WHERE title="SYNC2-MARKER-A"')"

# ---------- PHASE 3: conflict induction ----------
# The choreography per scenario: establish common baseline on server; take each
# clone TRULY offline (go_offline) one at a time; edit; then reconnect in a
# controlled order (reboot = reconnect) so timing and arrival can DISAGREE.
# See docs/lab/headless-research.md SYNC2 for the full verdict table. Each edit
# uses the golden's uriSchemeAuthToken for things:///update, and AppleScript
# `delete` for the trash-vs-edit scenario. This section is left as the automated
# skeleton; the run banked its verdicts in scenario-snapshots/*.sqlite.
note "== conflict induction: see docs/lab/headless-research.md SYNC2 verdict table =="
note "   (baseline to-dos -> per-clone offline edits -> ordered reconnect -> DB diff on BOTH)"

note "GREEN — report: $REPORT ; artifacts in $OUT"
note "ACCOUNT IS LIVE — burn it: $MAILTM_EMAIL (creds in $OUT/account-credentials.env)"
trap - EXIT; cleanup
