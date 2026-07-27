#!/bin/bash
# TOMB1 — TMTombstone lifecycle map (docs/up-next.md §6 "changes --since deletion
# visibility"; answers atlas schema-v26.md open-question 5). When exactly does a
# TMTombstone row appear, and is `deletionDate` trustworthy as a `--since` cursor?
#
# Verdict table + BUILD/DON'T-BUILD recommendation: docs/lab/tomb1-results.md.
#
# THREE PHASES (run interactively; the networked phases are VNC-choreographed):
#   0. AIRGAP CONTROL   — one clone, no account, pinned clock. Reconfirm ZERO
#                         tombstones across every delete path (extends A25/A27).
#   1. ACCOUNT (single) — one clone signed into a throwaway Things Cloud account.
#                         Re-run the delete matrix; does a LOCAL delete tombstone?
#   2. REMOTE (two clone)— A=observer, B=deleter on ONE account. Delete on B ->
#                         does A's TMTombstone gain the row (with B's deletionDate)?
#
# ==== KEY MECHANICS (verified 2026-07-26; reuse; see also SYNC2/SYNCLAT) ====
# * CLOCK: networked phases run on the PINNED clock (2026-07-05), NEVER NTP. The
#   golden's 15-day trial (first launch 2026-07-03) is EXPIRED at real time
#   (~2026-07-18); under the pinned clock it reads "13 days left", TLS to
#   cloud.culturedcode.com returns 200, and account create + BSSyncronyMetadata
#   populate + two-clone sync all work. NTP-ing to real time trips a STICKY
#   "Your Trial Period Has Ended" read-only modal (re-pinning does NOT clear it).
# * vncdo can't do shifted chars: text entry is via CLIPBOARD (pbcopy in guest +
#   Edit-menu Paste); the 6-digit verify code types fine (digits). Guard every
#   vncdo call with a perl alarm. Menu-bar dropdowns MUST be one vncdo invocation.
# * mail.tm is polled from the HOST (unreachable in-guest); Things Cloud is
#   reachable in-guest. Burn the account afterward (Syncrony DELETE, see bottom).
# * APNs is unavailable in the VM (SYNC2): the OBSERVER pulls on a slow timer, so
#   force an on-demand pull with `open -g things:///show?id=<uuid>` and poll.
# * 2-VM budget: phase 0 and phase 1 use ONE clone; phase 2 uses exactly A+B.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"                          # vncdotool CLI (REQUIRED for phases 1-2)
GOLDEN="${GOLDEN:-things-lab-golden-v1}"
PIN="${PIN:-070512002026}"                  # `date` MMDDhhmmYYYY = 2026-07-05 12:00
TOKEN="${TOKEN:-9dFi9fY-QBuqFq59yAUxOg}"    # golden uriSchemeAuthToken
PHASE="${PHASE:-all}"                        # airgap | account | remote | all
RUN="things-run-tomb1-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$RUN"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note(){ echo "[tomb1] $*" | tee -a "$REPORT"; }

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

boot_common(){ # boot_common <vm> <tag> [--airgap]  -> echoes ip
  local vm="$1" tag="$2" mode="${3:-}" ip
  (tart run "$vm" --no-graphics --vnc-experimental >"$OUT/tart-$tag.log" 2>&1 &); sleep 3
  ip=$(lab_wait_for_ssh "$vm" 300)
  grep -o 'vnc://[^ ]*' "$OUT/tart-$tag.log" | head -1 > "$OUT/vnc-$tag.txt" 2>/dev/null || true
  if [ "$mode" = "--airgap" ]; then
    lab_ssh "$ip" "sudo route -n delete default >/dev/null 2>&1; sudo route -n delete -inet6 default >/dev/null 2>&1; sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
  else
    lab_ssh "$ip" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null   # NETWORK UP, pinned
  fi
  lab_ssh "$ip" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"
  lab_ssh "$ip" 'open -g -a Things3; sleep 14' </dev/null
  echo "$ip"; }

# per-ip query + applescript helpers
mkQ(){ eval "$1(){ lab_ssh \"$2\" \"/tmp/gsql.sh -q \$(printf '%q' \"\$1\")\" </dev/null; }"; }
mkAS(){ eval "$1(){ lab_ssh \"$2\" \"osascript -e \$(printf '%q' \"\$1\")\" </dev/null; }"; }

##############################################################################
# ---- throwaway account (mail.tm from HOST + random pass) ----
provision_account(){
  local dom; dom=$(curl -s -m20 https://api.mail.tm/domains | python3 -c 'import sys,json;print(json.load(sys.stdin)["hydra:member"][0]["domain"])')
  MAILTM_EMAIL="tomb1$(python3 -c 'import secrets;print(secrets.token_hex(4))')@$dom"
  MAILTM_PASS=$(python3 -c 'import secrets;print(secrets.token_urlsafe(12))')
  THINGS_CLOUD_PASS=$(python3 -c 'import secrets,string;a=string.ascii_lowercase+string.digits;print("".join(secrets.choice(a) for _ in range(16)))')
  curl -s -m20 -X POST https://api.mail.tm/accounts -H 'Content-Type: application/json' -d "{\"address\":\"$MAILTM_EMAIL\",\"password\":\"$MAILTM_PASS\"}" >/dev/null
  cat > "$OUT/account-credentials.env" <<EOF
MAILTM_EMAIL=$MAILTM_EMAIL
MAILTM_PASS=$MAILTM_PASS
THINGS_CLOUD_PASS=$THINGS_CLOUD_PASS
EOF
  note "account provisioned: $MAILTM_EMAIL (creds in $OUT/account-credentials.env)"; }
fetch_verify_code(){ local tok id
  tok=$(curl -s -m20 -X POST https://api.mail.tm/token -H 'Content-Type: application/json' -d "{\"address\":\"$MAILTM_EMAIL\",\"password\":\"$MAILTM_PASS\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
  for _ in $(seq 1 25); do
    id=$(curl -s -m20 https://api.mail.tm/messages -H "Authorization: Bearer $tok" | python3 -c 'import sys,json;d=json.load(sys.stdin)["hydra:member"];print(d[0]["id"] if d else "")')
    [ -n "$id" ] && break; sleep 6; done
  [ -z "$id" ] && { echo NO-MAIL; return 1; }
  curl -s -m20 "https://api.mail.tm/messages/$id" -H "Authorization: Bearer $tok" | python3 -c 'import sys,json,re;d=json.load(sys.stdin,strict=False);m=re.search(r"----\s*(\d{6})\s*----",d.get("text",""));print(m.group(1) if m else "NO-CODE")'; }

# ---- VNC helper factory (framebuffer 2048x1536, Settings window centered) ----
# COORDS: Things menu=151,23 Settings=167,259 CloudTab=875,261 toggle=696,770
#   LogIn=1008,720 CreateAccount=1008,805 email=1008,604 pass=1008,733
#   create-submit=1008,959 login-submit=1008,913 verify-box1=807,789
#   Continue(verify)=1008,1005 Continue(newsletter)=1008,826 KeepCloud=1008,852
#   Continue(merge)=1008,1156 DontAllow(localnet)=904,619 Settings-close=526,187
mkVNC(){ # mkVNC <fn> <tag>  -> defines fn(...) running vncdo against that clone
  local url pw hp VS; url=$(cat "$OUT/vnc-$2.txt"); pw=$(echo "$url" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
  hp=${url#vnc://}; hp=${hp##*@}; VS="${hp%%:*}::${hp##*:}"
  eval "$1(){ perl -e 'alarm 50; exec @ARGV' \"$VNCDO\" -s \"$VS\" ${pw:+-p \"$pw\"} \"\$@\" 2>>\"$OUT/vnc-$2.log\" || true; }"; }

##############################################################################
# delete matrix used by BOTH airgap + account phases (single clone)
run_delete_matrix(){ # run_delete_matrix <ip> <label>
  local ip="$1" label="$2"; mkQ Q "$ip"; mkAS AS "$ip"
  local settle=3; [ "$label" = "account" ] && settle=12
  note "-- [$label] ARM a/b: to-do trash then empty-trash --"
  AS 'tell application "Things3" to make new to do with properties {name:"TOMB-T1"}' >/dev/null; sleep "$settle"
  local U1; U1=$(Q "SELECT uuid FROM TMTask WHERE title='TOMB-T1'")
  AS 'tell application "Things3" to delete to do "TOMB-T1"'; sleep "$settle"
  note "   trash:  trashed=$(Q "SELECT trashed FROM TMTask WHERE uuid='$U1'") lt=$(Q "SELECT leavesTombstone FROM TMTask WHERE uuid='$U1'") tomb=$(Q 'SELECT COUNT(*) FROM TMTombstone')"
  AS 'tell application "Things3" to empty trash'; sleep "$settle"
  note "   empty:  exists=$(Q "SELECT COUNT(*) FROM TMTask WHERE uuid='$U1'") tomb=$(Q 'SELECT COUNT(*) FROM TMTombstone') for-T1=$(Q "SELECT COUNT(*) FROM TMTombstone WHERE deletedObjectUUID='$U1'")"
  note "-- [$label] ARM c: project(+child) trash+empty (shallow delete) --"
  AS 'tell application "Things3" to make new project with properties {name:"TOMB-P1"}' >/dev/null; sleep "$settle"
  AS 'tell application "Things3" to make new to do with properties {name:"TOMB-C1"} at end of project "TOMB-P1"' >/dev/null; sleep "$settle"
  local PP CC; PP=$(Q "SELECT uuid FROM TMTask WHERE title='TOMB-P1'"); CC=$(Q "SELECT uuid FROM TMTask WHERE title='TOMB-C1'")
  AS 'tell application "Things3" to delete project "TOMB-P1"'; sleep "$settle"
  note "   trash:  P1 trashed=$(Q "SELECT trashed FROM TMTask WHERE uuid='$PP'") C1 trashed=$(Q "SELECT trashed FROM TMTask WHERE uuid='$CC'") tomb=$(Q 'SELECT COUNT(*) FROM TMTombstone')"
  AS 'tell application "Things3" to empty trash'; sleep "$settle"
  note "   empty:  P1 exists=$(Q "SELECT COUNT(*) FROM TMTask WHERE uuid='$PP'") C1 exists=$(Q "SELECT COUNT(*) FROM TMTask WHERE uuid='$CC'") tomb=$(Q 'SELECT COUNT(*) FROM TMTombstone')"
  note "-- [$label] ARM d: area delete (TMArea hard-deleted; children trashed) --"
  AS 'tell application "Things3" to make new area with properties {name:"TOMB-A1"}' >/dev/null; sleep "$settle"
  AS 'tell application "Things3" to make new to do with properties {name:"TOMB-AC1"} at end of area "TOMB-A1"' >/dev/null; sleep "$settle"
  local AR ACU; AR=$(Q "SELECT uuid FROM TMArea WHERE title='TOMB-A1'"); ACU=$(Q "SELECT uuid FROM TMTask WHERE title='TOMB-AC1'")
  note "   TMArea leavesTombstone column exists? $(Q "SELECT COUNT(*) FROM pragma_table_info('TMArea') WHERE name='leavesTombstone'")"
  AS 'tell application "Things3" to delete area "TOMB-A1"'; sleep "$settle"
  note "   delete: A1 exists=$(Q "SELECT COUNT(*) FROM TMArea WHERE uuid='$AR'") AC1 trashed=$(Q "SELECT trashed FROM TMTask WHERE uuid='$ACU'") tomb=$(Q 'SELECT COUNT(*) FROM TMTombstone')"
  note "-- [$label] ARM e: checklist item delete via URL edit --"
  AS 'tell application "Things3" to make new to do with properties {name:"TOMB-CL1"}' >/dev/null; sleep "$settle"
  local UCL; UCL=$(Q "SELECT uuid FROM TMTask WHERE title='TOMB-CL1'")
  lab_ssh "$ip" "open -g 'things:///update?auth-token=$TOKEN&id=$UCL&checklist-items=item-one%0Aitem-two'" </dev/null; sleep "$settle"
  local CLI; CLI=$(Q "SELECT uuid FROM TMChecklistItem WHERE task='$UCL' AND title='item-one'")
  lab_ssh "$ip" "open -g 'things:///update?auth-token=$TOKEN&id=$UCL&checklist-items=item-two'" </dev/null; sleep "$settle"
  note "   edit:   item-one row exists=$(Q "SELECT COUNT(*) FROM TMChecklistItem WHERE uuid='$CLI'") tomb=$(Q "SELECT COUNT(*) FROM TMTombstone WHERE deletedObjectUUID='$CLI'")"
  note "-- [$label] ARM 6: persistence across relaunch --"
  local PRE; PRE=$(Q 'SELECT COUNT(*) FROM TMTombstone')
  AS 'tell application "Things3" to quit'; sleep 4; lab_ssh "$ip" 'open -g -a Things3; sleep 14' </dev/null
  note "   relaunch: tomb pre=$PRE post=$(Q 'SELECT COUNT(*) FROM TMTombstone')"; }

##############################################################################
# PHASE 0 — AIRGAP CONTROL
phase_airgap(){
  note "############ PHASE 0 — AIRGAP CONTROL (no account, pinned clock) ############"
  local VM="$RUN-air" IP; tart clone "$GOLDEN" "$VM"
  local t; t(){ tart stop "$VM" >/dev/null 2>&1; tart delete "$VM" >/dev/null 2>&1; }; trap t RETURN
  IP=$(boot_common "$VM" air --airgap); note "air ip=$IP"; mkQ Q "$IP"
  note "== BASELINE: TMTombstone=$(Q 'SELECT COUNT(*) FROM TMTombstone') BSSyncronyMetadata=$(Q 'SELECT COUNT(*) FROM BSSyncronyMetadata')(expect 0) =="
  note "   TMTombstone schema: $(Q "SELECT replace(sql,char(10),' ') FROM sqlite_master WHERE name='TMTombstone'")"
  note "   leavesTombstone=1 rows (golden): $(Q "SELECT type||':'||substr(title,1,20) FROM TMTask WHERE leavesTombstone=1" | tr '\n' ' ')"
  note "   -> golden's leavesTombstone=1 rows are REPEATING templates/instances, NOT the trashed rows"
  run_delete_matrix "$IP" airgap
  note "== PHASE 0 VERDICT: zero tombstones across ALL delete paths; leavesTombstone never flips on delete =="; }

##############################################################################
# PHASE 1 — ACCOUNT (single clone). Creates the account reused by PHASE 2.
phase_account(){
  [ -z "$VNCDO" ] && { note "FATAL: \$VNCDO required for account phase"; exit 1; }
  provision_account
  note "############ PHASE 1 — ACCOUNT ATTACHED (single clone, pinned) ############"
  local VM="$RUN-A" IP; tart clone "$GOLDEN" "$VM"
  ACCOUNT_VM="$VM"   # kept alive for PHASE 2
  IP=$(boot_common "$VM" A); note "A ip=$IP"; ACCOUNT_IP="$IP"; mkQ Q "$IP"
  mkVNC V A
  shot(){ V capture "$OUT/$1"; note "   [shot] $1"; }
  paste_into(){ V move "$1" "$2" click 1; sleep 1
    lab_ssh "$IP" "printf '%s' $(printf '%q' "$3") | pbcopy" </dev/null
    V move 341 22 click 1; sleep 1; V move 353 280 click 1; sleep 1; }
  note "   TLS reachability (pinned clock): $(lab_ssh "$IP" 'curl -s -m8 -o /dev/null -w cloud=%{http_code} https://cloud.culturedcode.com' </dev/null)"
  shot 01-launch.png   # PREFLIGHT: must show trial VALID ("N days left"), not expired
  note "== VNC-create throwaway account =="
  V move 151 23 click 1; sleep 1; V move 167 259 click 1; sleep 2
  V move 875 261 click 1; sleep 2; V move 696 770 click 1; sleep 3
  V move 1008 805 click 1; sleep 3
  paste_into 1008 604 "$MAILTM_EMAIL"; paste_into 1008 733 "$THINGS_CLOUD_PASS"; shot 05-filled.png
  V move 1008 959 click 1; sleep 8
  local CODE; CODE=$(fetch_verify_code); note "   verify code: $CODE"
  V move 807 789 click 1; sleep 1; V type "$CODE"; sleep 1
  V move 1008 1005 click 1; sleep 6; V move 1008 826 click 1; sleep 6
  V move 904 619 click 1; sleep 3; V move 526 187 click 1; sleep 2; shot 09-cloudsettled.png
  sleep 20
  note "== BSSyncronyMetadata 0->$(Q 'SELECT COUNT(*) FROM BSSyncronyMetadata') (account attached) ; TMTombstone baseline=$(Q 'SELECT COUNT(*) FROM TMTombstone') =="
  run_delete_matrix "$IP" account
  note "== PHASE 1 VERDICT: LOCAL deletes under an account STILL write ZERO tombstones =="; }

##############################################################################
# PHASE 2 — REMOTE (two clones). Reuses the PHASE 1 account. Requires PHASE 1
# to have run in the same invocation (ACCOUNT_VM/creds set) OR RUN_DIR override.
phase_remote(){
  [ -z "$VNCDO" ] && { note "FATAL: \$VNCDO required for remote phase"; exit 1; }
  note "############ PHASE 2 — REMOTE DELETION (A=observer, B=deleter) ############"
  # free budget: stop+delete the single-clone A from PHASE 1 (its data is on the server)
  [ -n "${ACCOUNT_VM:-}" ] && { tart stop "$ACCOUNT_VM" >/dev/null 2>&1; tart delete "$ACCOUNT_VM" >/dev/null 2>&1; }
  local VA="$RUN-rA" VB="$RUN-rB" IPA IPB
  tart clone "$GOLDEN" "$VA"; tart clone "$GOLDEN" "$VB"
  local c; c(){ for v in "$VA" "$VB"; do tart stop "$v" >/dev/null 2>&1; tart delete "$v" >/dev/null 2>&1; done; }; trap c RETURN
  IPA=$(boot_common "$VA" rA); note "A(observer)=$IPA"
  IPB=$(boot_common "$VB" rB); note "B(deleter)=$IPB"
  mkQ QA "$IPA"; mkQ QB "$IPB"; mkAS ASB "$IPB"
  local pullA; pullA(){ lab_ssh "$IPA" "open -g 'things:///show?id=$1' >/dev/null 2>&1" </dev/null; }
  vlogin(){ # vlogin <tag> <ip>
    local tag="$1" ip="$2"; mkVNC W "$tag"
    local pin2; pin2(){ W move "$1" "$2" click 1; lab_ssh "$ip" "printf '%s' $(printf '%q' "$3") | pbcopy" </dev/null
      W move 341 22 click 1 pause 1 move 353 280 click 1; }
    W move 151 23 click 1 pause 1 move 167 259 click 1; sleep 3
    W move 875 261 click 1; sleep 2; W move 696 770 click 1; sleep 3
    W move 1008 720 click 1; sleep 3
    pin2 1008 604 "$MAILTM_EMAIL"; pin2 1008 733 "$THINGS_CLOUD_PASS"
    W move 1008 913 click 1; sleep 10
    W move 1008 852 click 1; sleep 1; W move 1008 1156 click 1; sleep 8
    W move 904 619 click 1; sleep 3; W move 526 187 click 1; sleep 2
    W capture "$OUT/remote-$tag-loggedin.png"; }
  note "== log A in, then B (merge=keep-cloud) =="
  vlogin rA "$IPA"; sleep 20; note "   A LAB=$(QA "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'LAB-%'") BSSync=$(QA 'SELECT COUNT(*) FROM BSSyncronyMetadata')"
  vlogin rB "$IPB"; sleep 20; note "   B LAB=$(QB "SELECT COUNT(*) FROM TMTask WHERE title LIKE 'LAB-%'") BSSync=$(QB 'SELECT COUNT(*) FROM BSSyncronyMetadata')"
  note "   A TMTombstone baseline=$(QA 'SELECT COUNT(*) FROM TMTombstone')"
  note "== TEST 1: create on B, hard-delete on B, observe A =="
  ASB 'tell application "Things3" to make new to do with properties {name:"TOMB-REMOTE-NEW"}' >/dev/null; sleep 15
  local UB; UB=$(QB "SELECT uuid FROM TMTask WHERE title='TOMB-REMOTE-NEW'"); note "   B uuid=$UB"
  local i; for i in $(seq 1 18); do pullA "$UB"; sleep 8; [ "$(QA "SELECT COUNT(*) FROM TMTask WHERE uuid='$UB'")" = 1 ] && break; done
  note "   arrived on A (~$((i*8))s): $(QA "SELECT COUNT(*) FROM TMTask WHERE uuid='$UB'")"
  ASB 'tell application "Things3" to delete to do "TOMB-REMOTE-NEW"'; sleep 6
  ASB 'tell application "Things3" to empty trash'; sleep 15
  local DELB; DELB=$(lab_ssh "$IPB" 'date +%s' </dev/null)
  local T=0 E=1; for i in $(seq 1 22); do pullA "$UB"; sleep 8
    T=$(QA "SELECT COUNT(*) FROM TMTombstone WHERE deletedObjectUUID='$UB'"); E=$(QA "SELECT COUNT(*) FROM TMTask WHERE uuid='$UB'"); [ "$T" = 1 ] && break; done
  note "   A after ~$((i*8))s: item-exists=$E tomb-for-UB=$T A-total=$(QA 'SELECT COUNT(*) FROM TMTombstone')"
  note "   ARM4 deletionDate=$(QA "SELECT quote(deletionDate) FROM TMTombstone WHERE deletedObjectUUID='$UB'") (B-delete-epoch=$DELB; Jul5-anchor=1783252800)"
  note "== TEST 2: hard-delete a PRE-EXISTING synced seed item on B =="
  local SEED; SEED=$(QB "SELECT uuid FROM TMTask WHERE title='LAB-TODAY-1' AND trashed=0 LIMIT 1")
  ASB 'tell application "Things3" to delete to do "LAB-TODAY-1"'; sleep 6
  ASB 'tell application "Things3" to empty trash'; sleep 15
  T=0; for i in $(seq 1 22); do pullA "$SEED"; sleep 8; T=$(QA "SELECT COUNT(*) FROM TMTombstone WHERE deletedObjectUUID='$SEED'"); [ "$T" = 1 ] && break; done
  note "   A after ~$((i*8))s: seed-on-A=$(QA "SELECT COUNT(*) FROM TMTask WHERE uuid='$SEED'") tomb-for-seed=$T A-total=$(QA 'SELECT COUNT(*) FROM TMTombstone')"
  note "== ARM 6: persistence across relaunch =="
  local PRE; PRE=$(QA 'SELECT COUNT(*) FROM TMTombstone')
  lab_ssh "$IPA" 'osascript -e "tell application \"Things3\" to quit"; sleep 4; open -g -a Things3; sleep 16' </dev/null; sleep 10
  note "   A tomb pre-relaunch=$PRE post=$(QA 'SELECT COUNT(*) FROM TMTombstone')"
  note "   A tombstone dump:"; QA 'SELECT deletedObjectUUID,quote(deletionDate) FROM TMTombstone' | sed 's/^/     /' | tee -a "$REPORT"
  for pair in "rA:$IPA" "rB:$IPB"; do local tg=${pair%%:*} ipx=${pair##*:}
    lab_ssh "$ipx" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/s.sqlite"' </dev/null
    lab_scp "$LAB_SSH_USER@$ipx:/tmp/s.sqlite" "$OUT/remote-final-$tg.sqlite" </dev/null 2>/dev/null; done; }

##############################################################################
ACCOUNT_VM=""; ACCOUNT_IP=""
case "$PHASE" in
  airgap)  phase_airgap ;;
  account) phase_account ;;
  remote)  phase_remote ;;
  all)     phase_airgap; phase_account; phase_remote ;;
  *) note "unknown PHASE=$PHASE"; exit 2 ;;
esac

note "GREEN — report: $REPORT ; artifacts in $OUT"
if [ -f "$OUT/account-credentials.env" ]; then
  note "ACCOUNT WAS LIVE — burn it (Syncrony DELETE):"
  note "  source $OUT/account-credentials.env"
  note "  curl -s -o /dev/null -w '%{http_code}\\n' -X DELETE \\"
  note "    https://cloud.culturedcode.com/version/1/account/\$MAILTM_EMAIL \\"
  note "    -H \"Authorization: Password \$THINGS_CLOUD_PASS\"   # 202, then 404 confirms"
fi
