#!/bin/bash
# LOCK1 + SYNC1 — headless "closet Mac mini" research (docs/up-next.md §2,
# "Queued 2026-07-13"). ONE clone, --vnc-experimental. Reuses the research-ui1.sh
# / research-sx6.sh VNC synthetic-input mechanics (tart --vnc-experimental +
# vncdotool → hardware-level HID, no TCC; Accessibility is NOT granted in the
# golden, so there is no AppleScript UI-scripting fallback).
#
# LOCK1 — locked-session vector probe. Enable a screensaver password, LOCK the
#   session (ctrl+cmd+Q via VNC keystroke → loginwindow), screenshot the lock
#   screen as evidence, then fire each vector over SSH and diff the guest DB:
#     (a) SQLite read           — expect WORKS (read is not gated by lock)
#     (b) open -a Things3 launch — expect WORKS (arm 2: quit, then launch locked)
#     (c) things:/// URL mutation — expect WORKS
#     (d) AppleScript mutation    — expect WORKS
#     (e) shortcuts run proxy mut — expect WORKS
#     (f) VNC coordinate click at a Things UI location — expect HITS LOCK SCREEN
#   Prediction (session architecture): a–e work because a locked session still
#   executes everything (lock = presentation/input barrier owned by loginwindow,
#   not an execution barrier); f fails against the console. Unlock-over-VNC
#   (typing the password into the lock field) is noted LAST — not relied on.
#
# SYNC1 — last-sync signal archaeology (no cloud account). Inventory every
#   machine-readable freshness/sync signal: DB (BSSyncronyMetadata / Meta /
#   TMMetaItem / TMSettings / TMTombstone / max userModificationDate), Things3
#   defaults + container plists, group-container files, the unified-log
#   subsystem/category taxonomy (com.culturedcode.*), and the WAL-mtime
#   freshness proxy. Documents the "unverifiable without a cloud account" list.
#
# COORDINATES are in the golden's VNC framebuffer space (2048x1536).
# Discovery: no assertions. Requires $VNCDO (a vncdotool CLI) for the lock +
# VNC-click + unlock arms; without it those arms are skipped (SSH vectors and
# all of SYNC1 still run).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}" # path to a vncdotool CLI (REQUIRED for the lock/VNC arms)

VM="things-run-lock1-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[lock1] $*" | tee -a "$REPORT"; }
cleanup() { echo "[lock1] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

PROJ_HEADINGS="Dwr1MiANqMFvAWddgGgzVX" # LAB-PROJ-HEADINGS (heading.create target)

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300)
note "ssh up at $IP"
VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
note "vnc url: ${VNC_URL:-<none>}"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN: still online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null

lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gsql() { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" </dev/null; }
gq()   { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gas()  { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" </dev/null || true; }
gurl() { lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; sleep 2; }
proxy(){ note "-- shortcuts run $1  $2"
  lab_ssh "$IP" "printf '%s' $(printf '%q' "$2") > /tmp/l1-in.json; rm -f /tmp/l1-out.txt; perl -e 'alarm 60; exec @ARGV' shortcuts run $(printf '%q' "$1") --input-path /tmp/l1-in.json --output-path /tmp/l1-out.txt 2>&1; echo \"[exit \$?]\"; cat /tmp/l1-out.txt 2>/dev/null; echo" </dev/null 2>&1 | tee -a "$REPORT" || true
  sleep 1; }
pid_now() { lab_ssh "$IP" 'pgrep -x Things3 || echo DEAD' </dev/null; }
seen() { gq "SELECT COUNT(*) FROM TMTask WHERE title='$1' AND trashed=0"; } # DB diff probe
wal_mtime() { lab_ssh "$IP" 'W=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite-wal); stat -f "%Sm %z" -t "%H:%M:%S" "$W" 2>/dev/null || echo "no-wal"' </dev/null; }

# ---- VNC helpers (present only if $VNCDO + a vnc url are available) ----
HAVE_VNC=0
if [ -n "$VNCDO" ] && [ -n "$VNC_URL" ]; then
  HP="${VNC_URL#vnc://}"; HP="${HP##*@}"; SERVER="${HP%%:*}::${HP##*:}"
  PASS=$(echo "$VNC_URL" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
  V() { "$VNCDO" -s "$SERVER" ${PASS:+-p "$PASS"} "$@" 2>>"$OUT/vnc.log"; }
  shot() { V capture "$OUT/$1"; note "   [shot] $1"; }
  md5shot() { V capture "$OUT/$1"; md5 -q "$OUT/$1" 2>/dev/null; } # capture + echo md5 (framebuffer-change probe)
  HAVE_VNC=1
else
  note "WARN: VNCDO/VNC_URL unavailable — lock + VNC-click + unlock arms SKIPPED."
fi

note "== warm-up: launch Things (recomputes Today for the pinned date) =="
lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null
note "Things pid after launch: $(pid_now)"
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
note "auth token in hand (${#TOKEN} chars)"

##############################################################################
# LOCK1
##############################################################################
note ""
note "############ LOCK1 — locked-session vector probe ############"

note "== enable the password gate via the SUPPORTED CLI: sysadminctl -screenLock immediate =="
note "   (the legacy 'defaults com.apple.screensaver askForPassword' is IGNORED on Sequoia;"
note "   sysadminctl -screenLock is the modern, unblocked way to require the password"
note "   immediately when the screensaver/lock begins — turning the screensaver into a"
note "   genuine password-gated lock rather than a dismiss-on-touch overlay.)"
UID_ADMIN=$(lab_ssh "$IP" 'id -u' </dev/null | tr -d '[:space:]')
lab_ssh "$IP" 'sudo sysadminctl -screenLock immediate -password admin 2>&1; sudo sysadminctl -screenLock status -password admin 2>&1' </dev/null | tee -a "$REPORT"

LOCKED=0
if [ "$HAVE_VNC" = 1 ]; then
  note "== pre-lock desktop capture =="
  PRE_MD5=$(md5shot 01-prelock.png); note "   01-prelock.png md5=$PRE_MD5 (Things desktop)"

  note "== lock attempt A: ctrl+cmd+Q via VNC keydown/keyup (super=Cmd) =="
  V keydown ctrl; V keydown super; V keydown q; sleep 1; V keyup q; V keyup super; V keyup ctrl
  sleep 5
  A_MD5=$(md5shot 02a-after-vnc-ctrlcmdq.png)
  if [ "$A_MD5" = "$PRE_MD5" ]; then
    note "   02a md5=$A_MD5 == prelock -> VNC ctrl+cmd+Q did NOT change the framebuffer (chord not honored)"
  else
    note "   02a md5=$A_MD5 != prelock -> framebuffer CHANGED"; LOCKED=1
  fi

  note "== lock attempt B: SACLockScreenImmediate in the GUI session (launchctl asuser $UID_ADMIN) =="
  note "   (loginwindow immediate-lock; run inside the console user's bootstrap so it is not EINVAL/rc=22)"
  lab_ssh "$IP" "sudo launchctl asuser $UID_ADMIN sudo -u admin python3 -c 'import ctypes; lf=ctypes.CDLL(\"/System/Library/PrivateFrameworks/login.framework/Versions/Current/login\"); print(\"rc=\",lf.SACLockScreenImmediate())' 2>&1 || echo SAC-failed" </dev/null | tee -a "$REPORT"
  sleep 7
  B_MD5=$(md5shot 02b-locked.png)
  if [ "$B_MD5" = "$PRE_MD5" ]; then
    note "   02b md5=$B_MD5 == prelock -> SAC did NOT change the framebuffer"
  else
    note "   02b md5=$B_MD5 != prelock -> CHANGED = loginwindow lock shown. Evidence: 02b-locked.png"; LOCKED=1
  fi

  note "== lock attempt C: open -a ScreenSaverEngine (NOW password-gated by sysadminctl) =="
  lab_ssh "$IP" 'open -a ScreenSaverEngine 2>&1 || echo "ss-launch-failed"' </dev/null | tee -a "$REPORT"
  sleep 8
  C_MD5=$(md5shot 02c-screensaver.png)
  if [ "$C_MD5" != "$PRE_MD5" ]; then
    note "   02c md5=$C_MD5 != prelock -> screensaver engaged. With screenLock=immediate this is a"
    note "   password-gated lock; vector (f) below verifies a click does NOT fall through to the desktop."
    [ "$LOCKED" = 0 ] && LOCKED=2
    LOCKFRAME="$C_MD5"
  else
    note "   02c md5=$C_MD5 == prelock -> screensaver did not engage"
    LOCKFRAME="$B_MD5"
  fi
  case "$LOCKED" in
    1) note "   >>> LOCK via loginwindow. Vectors below run UNDER LOCK." ;;
    2) note "   >>> LOCK via password-gated screensaver. Vectors below run UNDER LOCK (verify (f))." ;;
    *) note "   >>> WARNING: no lock method changed the framebuffer; vectors run UNLOCKED (invalid for LOCK1)." ;;
  esac
else
  note "no VNC — cannot lock/verify; the SSH vectors below run against the"
  note "UNLOCKED session (still valid for a/b/c/d/e; f + lock evidence need VNC)."
fi

note ""
note "== [a] SQLite READ under lock (expect WORKS) =="
gsql "SELECT COUNT(*) AS tmtask_rows FROM TMTask" | tee -a "$REPORT"

note ""
note "== [c] things:/// URL mutation under lock (expect WORKS) =="
note "   pre  seen(LOCK-URL)=$(seen LOCK-URL)"
gurl "things:///add?title=LOCK-URL"
sleep 2
note "   post seen(LOCK-URL)=$(seen LOCK-URL)  (1 = URL add worked under lock)"

note ""
note "== [d] AppleScript mutation under lock (expect WORKS) =="
note "   pre  seen(LOCK-AS)=$(seen LOCK-AS)"
gas 'tell application "Things3" to make new to do with properties {name:"LOCK-AS"}' | tee -a "$REPORT"
sleep 2
note "   post seen(LOCK-AS)=$(seen LOCK-AS)  (1 = AppleScript make worked under lock)"

note ""
note "== [e] shortcuts run proxy mutation under lock (heading.create) =="
note "   pre  headings named LOCK-SC in LAB-PROJ-HEADINGS: $(gq "SELECT COUNT(*) FROM TMTask WHERE title='LOCK-SC' AND type=2 AND project='$PROJ_HEADINGS' AND trashed=0")"
proxy things-proxy-create-heading "{\"title\":\"LOCK-SC\",\"project\":\"$PROJ_HEADINGS\"}"
sleep 2
note "   post headings named LOCK-SC: $(gq "SELECT COUNT(*) FROM TMTask WHERE title='LOCK-SC' AND type=2 AND project='$PROJ_HEADINGS' AND trashed=0")  (1 = Shortcuts proxy worked under lock)"

if [ "$HAVE_VNC" = 1 ]; then
  note ""
  note "== [f] VNC coordinate click at a Things UI location (expect HITS LOCK SCREEN) =="
  note "   clicking ~center (1024,760) where a Things window/to-do would be:"
  V move 1024 760 click 1; sleep 3
  F_MD5=$(md5shot 03-after-uiclick.png)
  note "   03-after-uiclick.png md5=$F_MD5 (lock frame=${LOCKFRAME:-n/a})"
  note "   AUTHORITATIVE CHECK IS VISUAL (03 = lock/password screen => click hit the lock; 03 ="
  note "   Things desktop => click fell through). md5 alone is unreliable: the desktop's own"
  note "   content changes between captures (new to-dos), so md5!=prelock does NOT prove a lock."
fi

note ""
note "== ARM 2 — launch Things under lock =="
note "   quitting Things (session stays locked)..."
gas 'tell application "Things3" to quit'; sleep 4
note "   pid after quit: $(pid_now)"
[ "$HAVE_VNC" = 1 ] && shot "04-locked-noapp.png"
note "   open -a Things3 over SSH while locked..."
lab_ssh "$IP" 'open -a Things3' </dev/null; sleep 12
note "   pid after launch-under-lock: $(pid_now)  (non-DEAD = app LAUNCHED under lock)"
[ "$HAVE_VNC" = 1 ] && shot "05-locked-relaunched.png"
note "   URL mutation against the fresh locked instance:"
note "   pre  seen(LOCK-RELAUNCH-URL)=$(seen LOCK-RELAUNCH-URL)"
gurl "things:///add?title=LOCK-RELAUNCH-URL"; sleep 2
note "   post seen(LOCK-RELAUNCH-URL)=$(seen LOCK-RELAUNCH-URL)  (1 = fresh locked instance accepts writes)"

if [ "$HAVE_VNC" = 1 ]; then
  note ""
  note "== unlock-over-VNC note (LAST; not relied on for the vectors) =="
  note "   typing guest password into the lock field via VNC, then Return:"
  V move 1024 760 click 1; sleep 1   # focus the password field
  V type admin; sleep 1
  V key enter; sleep 6
  shot "06-after-unlock-attempt.png"
  note "   (06: desktop back = VNC keystrokes reach the password field / unlock path;"
  note "    still lock screen = they do not. Evidence only.)"
fi

##############################################################################
# SYNC1
##############################################################################
note ""
note "############ SYNC1 — last-sync signal archaeology (no cloud account) ############"

note "== [DB] BSSyncronyMetadata (Cultured Code 'Syncrony' sync framework) =="
gsql "SELECT COUNT(*) AS rows FROM BSSyncronyMetadata" | tee -a "$REPORT"
note "   uuid + value length + hex preview (BLOBs):"
gsql "SELECT uuid, length(value) AS bytes, quote(substr(value,1,48)) AS head FROM BSSyncronyMetadata" | tee -a "$REPORT"

note "== [DB] Meta table (all key/value rows) =="
gsql "SELECT key, substr(value,1,80) AS value FROM Meta ORDER BY key" | tee -a "$REPORT"

note "== [DB] TMMetaItem (count + preview) =="
gsql "SELECT COUNT(*) AS rows FROM TMMetaItem" | tee -a "$REPORT"
gsql "SELECT uuid, length(value) AS bytes FROM TMMetaItem LIMIT 10" | tee -a "$REPORT"

note "== [DB] TMSettings full row (no sync/account/lastSync column exists in v26) =="
gsql "SELECT * FROM TMSettings" | tee -a "$REPORT"

note "== [DB] TMTombstone (deletion tracking for sync) count =="
gsql "SELECT COUNT(*) AS tombstones FROM TMTombstone" | tee -a "$REPORT"

note "== [DB] freshness proxy: max(userModificationDate) across TMTask =="
gsql "SELECT datetime(MAX(userModificationDate),'unixepoch') AS last_local_edit_utc, COUNT(*) AS rows FROM TMTask" | tee -a "$REPORT"

note ""
note "== [defaults] com.culturedcode.ThingsMac — full key inventory =="
lab_ssh "$IP" 'defaults read com.culturedcode.ThingsMac 2>/dev/null || echo "(no defaults domain)"' </dev/null | tee -a "$OUT/defaults-ThingsMac.txt"
note "   sync/account/cloud/push/last-ish keys:"
lab_ssh "$IP" 'defaults read com.culturedcode.ThingsMac 2>/dev/null' </dev/null | grep -iE "sync|account|cloud|push|last|token|server|login|mail|delta" | tee -a "$REPORT" || note "   (none matched)"
note "   (full dump saved to defaults-ThingsMac.txt)"

note ""
note "== [container] group-container file inventory (Cloud-state-shaped files) =="
lab_ssh "$IP" 'ls -la ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ 2>/dev/null; echo "--- ThingsData tree ---"; find ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac -maxdepth 3 -not -path "*.thingsdatabase/*" 2>/dev/null' </dev/null | tee -a "$OUT/container-tree.txt"
note "   sync/cloud/push/account-shaped names in the group container:"
lab_ssh "$IP" 'find ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac ~/Library/Containers/com.culturedcode.ThingsMac 2>/dev/null | grep -iE "sync|cloud|push|account|syncrony|server|token"' </dev/null | tee -a "$REPORT" || note "   (none matched)"
note "   container Preferences plists:"
lab_ssh "$IP" 'ls -la ~/Library/Preferences/com.culturedcode.ThingsMac*.plist ~/Library/Containers/com.culturedcode.ThingsMac/Data/Library/Preferences/*.plist 2>/dev/null || echo "(none)"' </dev/null | tee -a "$REPORT"
note "   group-container preferences plist — full key dump (any Cloud/Syncrony/account keys?):"
lab_ssh "$IP" 'defaults read ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist 2>/dev/null || echo "(unreadable)"' </dev/null | tee -a "$OUT/group-prefs.txt"
note "   sync/account/cloud/push-ish keys in the group-container plist:"
lab_ssh "$IP" 'defaults read ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist 2>/dev/null' </dev/null | grep -iE "sync|account|cloud|push|last|token|server|login|mail|delta|syncrony" | tee -a "$REPORT" || note "   (none matched)"

note ""
note "== [unified log] generate app activity, then capture the Things3 taxonomy =="
note "   NOTE: guest clock is pinned to 2026-07-05, so --last windows anchor there;"
note "   we use an absolute --start covering the pinned session to dodge the skew."
gurl "things:///add?title=SYNC-LOGGEN"; sleep 2
gas 'tell application "Things3" to make new to do with properties {name:"SYNC-LOGGEN-2"}'; sleep 3
note "   guest date now: $(lab_ssh "$IP" 'date' </dev/null)"
LOGSTART="2026-07-05 00:00:00"
note "   sanity: total --info log lines since $LOGSTART (no predicate):"
lab_ssh "$IP" "log show --start '$LOGSTART' --info 2>/dev/null | wc -l" </dev/null | tee -a "$REPORT"
note "   Things3 lines (predicate process==Things3), count + save:"
lab_ssh "$IP" "log show --start '$LOGSTART' --info --predicate 'process == \"Things3\"' --style compact 2>/dev/null > /tmp/l1-things.log; wc -l /tmp/l1-things.log" </dev/null | tee -a "$REPORT"
lab_scp "$LAB_SSH_USER@$IP:/tmp/l1-things.log" "$OUT/log-things3.txt" </dev/null 2>/dev/null || true
note "   subsystem/category taxonomy (top 40 by count):"
lab_ssh "$IP" "log show --start '$LOGSTART' --info --predicate 'process == \"Things3\"' --style ndjson 2>/dev/null | python3 -c 'import sys,json,collections
c=collections.Counter()
for line in sys.stdin:
  try: o=json.loads(line)
  except: continue
  c[(o.get(\"subsystem\",\"\"),o.get(\"category\",\"\"))]+=1
for (s,cat),n in c.most_common(40): print(f\"{n:6d}  {s!r} / {cat!r}\")'" </dev/null | tee -a "$REPORT"
note "   sync-flavored Things3 log lines (grep sync/cloud/push/syncrony/server), sample:"
lab_ssh "$IP" "log show --start '$LOGSTART' --info --predicate 'process == \"Things3\"' --style compact 2>/dev/null | grep -iE 'sync|cloud|push|syncrony|server' | head -25" </dev/null | tee -a "$REPORT" || note "   (none matched)"
note "   fallback (no predicate; grep the raw stream for Things3/culturedcode):"
lab_ssh "$IP" "log show --start '$LOGSTART' --info --style compact 2>/dev/null | grep -iE 'things3|culturedcode' | head -15" </dev/null | tee -a "$REPORT" || note "   (none matched)"
note "   any com.culturedcode.* subsystem from ANY process:"
lab_ssh "$IP" "log show --start '$LOGSTART' --info --predicate 'subsystem BEGINSWITH \"com.culturedcode\"' --style compact 2>/dev/null | head -20" </dev/null | tee -a "$REPORT" || note "   (none / empty)"

note ""
note "== [WAL] main.sqlite-wal mtime tracks app writes (freshness proxy) =="
note "   wal before write: $(wal_mtime)"
gurl "things:///add?title=SYNC-WAL-TOUCH"; sleep 3
note "   wal after  write: $(wal_mtime)  (mtime advanced = WAL is a live freshness proxy)"

note ""
note "== copying DB + full log out =="
lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/lock1.sqlite"' </dev/null
lab_scp "$LAB_SSH_USER@$IP:/tmp/lock1.sqlite" "$OUT/final.sqlite" </dev/null 2>/dev/null || true

note "GREEN — report: $REPORT ; screenshots + dumps + final.sqlite in $OUT"
ls -la "$OUT" | tee -a "$REPORT"
trap - EXIT; cleanup
