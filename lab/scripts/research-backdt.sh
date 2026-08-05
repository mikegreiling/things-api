#!/bin/bash
# BACKDT — project backdating + resolution-flip stopDate semantics.
# Extends the scf2 P4a-P4d backdating evidence (to-dos) to PROJECTS, and settles
# the resolution-flip stopDate laws the maintainer needs for the planned API
# redesign (folding todo.backdate/todo.add-logged into --created-at/--completed-at
# on add/update/complete/cancel for BOTH kinds). Write-up:
#   docs/lab/backdt-project-backdating-and-flips.md
#
# Prior certified laws (to-dos, scf2/scf3, s-campaign-results.md):
#   P4b AS `set completion date`/`set creation date` WORK (only existing-item surface).
#   P4c URL update?completion-date=/creation-date= silent no-ops (oddity 2g).
#   P4a Shortcuts set-detail dead.  P4d things:///json at-creation attrs honored exactly.
# GUI ground truth (maintainer, prod, 2026-08-05): toggling a swept resolved item
# Completed<->Canceled PRESERVES stopDate and sweep state.
#
# PROBE MATRIX (byte-diff discipline; capture status/stopDate/creationDate/index/umd):
#   B-PROJ-AS       AS set completion/creation date on a RESOLVED project (+child byte-diff)
#   B-PROJ-AS-OPEN  AS set completion/creation date on an OPEN project (H-BACKDATE-OPEN analogue)
#   B-PROJ-JSON     things:///json project create w/ completed+completion-date+creation-date
#   B-DATEONLY      date-only values (no time-of-day) via json + AS -> what clock stamped?
#   B-FLIP          (a) URL update?completed=true on CANCELED to-do
#                   (b) URL update?canceled=true on COMPLETED to-do
#                   (c) AS set status flips on resolved items, SWEPT and UNSWEPT
#                   (d) re-complete an already-completed item (idempotency)
#                   + one project leg (update-project + AS)
#   B-SWEEP         does a preserving flip keep a SWEPT item swept? does a restamp un-sweep?
#
# ONE disposable clone of things-lab-golden-v2 (Things 3.22.12), pinned clock
# 2026-07-05 12:00. VM lifecycle owned by the CALLER (tart clone + tracked
# background `tart run`); this script drives an already-booted guest.
# Subcommands (session.env carries IP+TOKEN across calls):
#   setup  projas  projasopen  projjson  dateonly  loginterval  flip  dump
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="${VM:-backdt-lab}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[backdt] $*" | tee -a "$REPORT"; }
CMD="${1:-}"

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }
gq()  { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gsql(){ lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" </dev/null; }
gurl(){ lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; sleep 2; }
# AppleScript, capturing guest-side exit so an error (-1728 no-such-obj etc.) is
# distinguished from a silent no-op. NO `|| true`.
gas() { # $1 applescript
  lab_ssh "$IP" "osascript -e $(printf '%q' "$1") >/tmp/as.out 2>&1; echo \"EXIT=\$?\"; cat /tmp/as.out" </dev/null
  sleep 1
}
pid_of() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND trashed=0"; }
tid()    { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=0 AND trashed=0"; }

gupd() { gurl "things:///update?id=$1&auth-token=$TOKEN&$2"; }
gupdp(){ gurl "things:///update-project?id=$1&auth-token=$TOKEN&$2"; }

# Full row: status/index/stopDate(raw+human)/creationDate(raw+human)/umd/trashed.
row() { gq "SELECT 'st='||status||' idx='||printf('%.1f',\"index\")||' stop='||COALESCE(printf('%.2f',stopDate),'NULL')||' stopH='||COALESCE(datetime(stopDate,'unixepoch'),'-')||' crt='||printf('%.2f',creationDate)||' crtH='||datetime(creationDate,'unixepoch')||' umd='||printf('%.3f',userModificationDate)||' tr='||trashed FROM TMTask WHERE uuid='$1'"; }
# terse child line
kids() { local p; p=$(pid_of "$1"); gq "SELECT title||' st='||status||' stop='||COALESCE(printf('%.2f',stopDate),'NULL')||' crt='||printf('%.2f',creationDate)||' umd='||printf('%.3f',userModificationDate) FROM TMTask WHERE project='$p' AND trashed=0 ORDER BY \"index\""; }
boundary() { gq "SELECT 'logInterval='||logInterval||' manualLogDate='||COALESCE(printf('%.2f',manualLogDate),'NULL')||' now='||strftime('%s','now') FROM TMSettings LIMIT 1"; }
setstatus() { local cls="$1"; [ "$cls" = todo ] && cls="to do"; gas "tell application \"Things3\" to set status of $cls id \"$2\" to $3"; }

tjson() { # $1 json-array-string
  local url
  url=$(lab_ssh "$IP" "python3 -c 'import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))' $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null)
  lab_ssh "$IP" "open -g $(printf '%q' "$url")" </dev/null; sleep 3
}

# ============================================================ setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  IP=$(lab_wait_for_ssh "$VM" 300) || exit 1
  note "ssh up at $IP (VM $VM)"
  echo "IP=$IP" > "$SESSION"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo route -n delete -inet6 default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null; date' </dev/null | tee -a "$REPORT"
  note "guest timezone: $(lab_ssh "$IP" 'systemsetup -gettimezone 2>/dev/null || readlink /etc/localtime' </dev/null)"
  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"
  note "warm-up: launch/quit/relaunch Things on the pinned date"
  lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3' </dev/null
  lab_ssh "$IP" 'open -g -a Things3; sleep 8' </dev/null
  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  echo "TOKEN=$TOKEN" >> "$SESSION"
  note "token in hand (${#TOKEN} chars)"
  AREA_A=$(gq "SELECT uuid FROM TMArea WHERE title='LAB-AREA-A'")
  echo "AREA_A=$AREA_A" >> "$SESSION"
  note "LAB-AREA-A=$AREA_A"
  note "sweep state at setup: $(boundary)"
  note "setup DONE"
  exit 0
fi

# ============================================================ B-PROJ-AS
if [ "$CMD" = "projas" ]; then
  load_session
  note "################## B-PROJ-AS — AS set completion/creation date on a RESOLVED project ##################"
  note "  seed BD-PAS project with 2 open children C1,C2 (+ tests child byte-diff on project backdate)"
  tjson '[{"type":"project","attributes":{"title":"BD-PAS","area-id":"'"$AREA_A"'","items":[
    {"type":"to-do","attributes":{"title":"C1"}},{"type":"to-do","attributes":{"title":"C2"}}]}}]'
  sleep 1
  P=$(pid_of BD-PAS)
  note "  BD-PAS=$P"
  note "  project PRE (open): $(row "$P")"
  note "  children PRE:"; kids BD-PAS | tee -a "$REPORT"
  note "  -- complete the project via AS set status (children cascade-complete, H-PROJECT-COMPLETE-CHILDREN) --"
  setstatus project "$P" completed
  note "  project POST-complete (must be status=3 w/ a 2026 stopDate before backdate means anything): $(row "$P")"
  note "  children POST-complete (cascade): $(kids BD-PAS | tr '\n' ' ')"
  note "  -- [B-PROJ-AS.1] set completion date of project to (current date) - 200 days (~2025-12-17, locale-proof) --"
  gas "tell application \"Things3\" to set completion date of project id \"$P\" to ((current date) - (200 * days))" | tee -a "$REPORT"
  note "  project AFTER comp-date: $(row "$P")"
  note "  children AFTER comp-date (side-effect? stopDate should be UNCHANGED):"; kids BD-PAS | tee -a "$REPORT"
  note "  -- [B-PROJ-AS.2] set creation date of project to (current date) - 400 days (~2025-06-01) --"
  gas "tell application \"Things3\" to set creation date of project id \"$P\" to ((current date) - (400 * days))" | tee -a "$REPORT"
  note "  project AFTER crt-date: $(row "$P")"
  note "  children AFTER crt-date:"; kids BD-PAS | tee -a "$REPORT"
  note "  -- [B-PROJ-AS.3] date-literal spelling: set completion date to date \"1/15/2025\" --"
  gas "tell application \"Things3\" to set completion date of project id \"$P\" to date \"1/15/2025\"" | tee -a "$REPORT"
  note "  project AFTER date-literal comp: $(row "$P")"
  exit 0
fi

# ============================================================ B-PROJ-AS-OPEN
if [ "$CMD" = "projasopen" ]; then
  load_session
  note "################## B-PROJ-AS-OPEN — AS set completion/creation date on an OPEN project ##################"
  tjson '[{"type":"project","attributes":{"title":"BD-POPEN","area-id":"'"$AREA_A"'","items":[
    {"type":"to-do","attributes":{"title":"OC1"}}]}}]'
  sleep 1
  P=$(pid_of BD-POPEN)
  note "  BD-POPEN=$P"
  note "  project PRE (open, status=0, stop=NULL): $(row "$P")"
  note "  child PRE:"; kids BD-POPEN | tee -a "$REPORT"
  note "  -- [B-PROJ-AS-OPEN.1] set completion date on an OPEN project — silently completes? errors? no-ops? --"
  gas "tell application \"Things3\" to set completion date of project id \"$P\" to date \"1/15/2025\"" | tee -a "$REPORT"
  note "  project AFTER (status flip? stopDate set while open? nothing?): $(row "$P")"
  note "  child AFTER (cascade if it completed?):"; kids BD-POPEN | tee -a "$REPORT"
  note "  -- [B-PROJ-AS-OPEN.2] set creation date on an OPEN project (creation date not status-gated?) --"
  gas "tell application \"Things3\" to set creation date of project id \"$P\" to date \"6/1/2024\"" | tee -a "$REPORT"
  note "  project AFTER crt-date on open: $(row "$P")"
  exit 0
fi

# ============================================================ B-PROJ-JSON
if [ "$CMD" = "projjson" ]; then
  load_session
  note "################## B-PROJ-JSON — things:///json project create w/ completed + dates ##################"
  note "  -- [B-PROJ-JSON.1] bare project completed=true + completion-date + creation-date (second precision) --"
  tjson '[{"type":"project","attributes":{"title":"BD-PJSON","area-id":"'"$AREA_A"'",
    "completed":true,"creation-date":"2024-06-01T08:00:00Z","completion-date":"2025-01-15T09:00:00Z"}}]'
  sleep 1
  P=$(pid_of BD-PJSON)
  if [ -n "$P" ]; then
    note "  BD-PJSON=$P  (did completed/dates stick, exact values? logbook = status 3 + swept):"
    note "  $(row "$P")"
    note "  sweep state: $(boundary)  (swept iff stopDate<=manualLogDate; golden logInterval=0 => boundary=now)"
  else
    note "  BD-PJSON row never appeared — json project add w/ completed rejected?"
  fi
  note "  -- [B-PROJ-JSON.2] completed project WITH child to-dos carrying their OWN completed+dates --"
  tjson '[{"type":"project","attributes":{"title":"BD-PJSON2","area-id":"'"$AREA_A"'",
    "completed":true,"creation-date":"2024-03-01T08:00:00Z","completion-date":"2025-02-01T09:00:00Z",
    "items":[
      {"type":"to-do","attributes":{"title":"JC1","completed":true,"creation-date":"2024-03-02T08:00:00Z","completion-date":"2025-01-20T09:00:00Z"}},
      {"type":"to-do","attributes":{"title":"JC2"}}]}}]'
  sleep 1
  P2=$(pid_of BD-PJSON2)
  if [ -n "$P2" ]; then
    note "  BD-PJSON2=$P2 project row: $(row "$P2")"
    note "  children (JC1 has own dates+completed; JC2 plain — does an open child reopen the project? §5b):"
    kids BD-PJSON2 | tee -a "$REPORT"
    JC1=$(tid JC1); note "  JC1 full: $(row "$JC1")"
  else
    note "  BD-PJSON2 row never appeared"
  fi
  exit 0
fi

# ============================================================ B-DATEONLY
if [ "$CMD" = "dateonly" ]; then
  load_session
  note "################## B-DATEONLY — date-only values (no time-of-day): what clock gets stamped? ##################"
  note "  guest TZ: $(lab_ssh "$IP" 'systemsetup -gettimezone 2>/dev/null || readlink /etc/localtime' </dev/null)"
  # --- json bare date (no T) on a to-do ---
  note "  -- [B-DATEONLY.1] json to-do completion-date='2025-01-15' (bare date, no time) --"
  tjson '[{"type":"to-do","attributes":{"title":"BD-DO-JSON","completed":true,"completion-date":"2025-01-15","creation-date":"2024-06-01"}}]'
  sleep 1
  DJ=$(tid BD-DO-JSON)
  if [ -n "$DJ" ]; then
    note "  BD-DO-JSON=$DJ  (accepted? what time-of-day? UTC vs local):"
    note "  $(gq "SELECT 'stop='||printf('%.2f',stopDate)||' stopUTC='||datetime(stopDate,'unixepoch')||' stopLOC='||datetime(stopDate,'unixepoch','localtime')||' crtUTC='||datetime(creationDate,'unixepoch')||' crtLOC='||datetime(creationDate,'unixepoch','localtime') FROM TMTask WHERE uuid='$DJ'")"
  else
    note "  BD-DO-JSON never appeared — bare date rejected? (contrast oddity 4a milliseconds)"
  fi
  # --- AS date-literal (no time) on a completed to-do ---
  note "  -- [B-DATEONLY.2] AS set completion date to date \"1/15/2025\" (date literal, no time) --"
  gurl "things:///add?title=BD-DO-AS"
  DA=$(tid BD-DO-AS)
  setstatus todo "$DA" completed
  note "  pre (completed, 2026 stop): $(row "$DA")"
  gas "tell application \"Things3\" to set completion date of to do id \"$DA\" to date \"1/15/2025\"" | tee -a "$REPORT"
  note "  AFTER date-literal (midnight? noon? clock time):"
  note "  $(gq "SELECT 'stop='||printf('%.2f',stopDate)||' stopUTC='||datetime(stopDate,'unixepoch')||' stopLOC='||datetime(stopDate,'unixepoch','localtime') FROM TMTask WHERE uuid='$DA'")"
  note "  -- [B-DATEONLY.3] AS set creation date to date \"6/1/2024\" --"
  gas "tell application \"Things3\" to set creation date of to do id \"$DA\" to date \"6/1/2024\"" | tee -a "$REPORT"
  note "  $(gq "SELECT 'crt='||printf('%.2f',creationDate)||' crtUTC='||datetime(creationDate,'unixepoch')||' crtLOC='||datetime(creationDate,'unixepoch','localtime') FROM TMTask WHERE uuid='$DA'")"
  exit 0
fi

# ============================================================ todoopen (to-do parallel of B-PROJ-AS-OPEN)
if [ "$CMD" = "todoopen" ]; then
  load_session
  note "################## TODO-OPEN — AS set completion date on an OPEN TO-DO (H-BACKDATE-OPEN rationale) ##################"
  gurl "things:///add?title=BD-TODO-OPENCD"
  T=$(tid BD-TODO-OPENCD)
  note "  BD-TODO-OPENCD=$T"
  note "  PRE (open): $(row "$T")"
  gas "tell application \"Things3\" to set completion date of to do id \"$T\" to date \"1/15/2025\"" | tee -a "$REPORT"
  note "  POST set-completion-date-on-OPEN-todo (silently completes like the open project? status 0->3, stop=backdated?): $(row "$T")"
  note "  -- also: set creation date on an OPEN to-do (should NOT complete it) --"
  gurl "things:///add?title=BD-TODO-OPENCRT"
  T2=$(tid BD-TODO-OPENCRT)
  gas "tell application \"Things3\" to set creation date of to do id \"$T2\" to date \"6/1/2024\"" | tee -a "$REPORT"
  note "  POST set-creation-date-on-OPEN-todo (status stays 0? crt backdated?): $(row "$T2")"
  exit 0
fi

# ============================================================ axdebug (introspect settings window)
if [ "$CMD" = "axdebug" ]; then
  load_session
  lab_ssh "$IP" 'open -a Things3; sleep 3' </dev/null
  lab_ssh "$IP" "cat > /tmp/axdbg.scpt" <<'AS'
tell application "Things3" to activate
delay 1.5
tell application "System Events"
  tell process "Things3"
    set frontmost to true
    delay 0.5
    set out to ""
    -- describe the untitled window (is it a blocking sheet?)
    try
      set w0 to window 1
      set out to out & "w1 name=[" & (name of w0) & "] subrole=[" & (subrole of w0) & "] sheets=" & (count of sheets of w0) & " | "
    end try
    click menu bar item 2 of menu bar 1
    delay 1
    click menu item "Settings…" of menu 1 of menu bar item 2 of menu bar 1
    repeat with i from 1 to 6
      delay 1
      set out to out & i & ":"
      repeat with w in windows
        set out to out & "[" & (name of w) & "]"
      end repeat
      set out to out & " "
    end repeat
    return out
  end tell
end tell
AS
  note "  $(lab_ssh "$IP" 'osascript /tmp/axdbg.scpt 2>&1' </dev/null)"
  exit 0
fi

# ============================================================ loginterval (AX -> logInterval=4)
if [ "$CMD" = "loginterval" ]; then
  load_session
  note "################## set logInterval=4 (Manually) via System Events AX (golden-v2 L3 grant) ##################"
  note "  before: $(boundary)"
  lab_ssh "$IP" 'open -a Things3; sleep 3' </dev/null
  lab_ssh "$IP" "cat > /tmp/setlog.scpt" <<'AS'
tell application "Things3" to activate
delay 1.5
tell application "System Events"
  tell process "Things3"
    set frontmost to true
    delay 0.5
    -- open Settings via the app menu (keystroke "," is unreliable headless)
    click menu item "Settings…" of menu 1 of menu bar item 2 of menu bar 1
    delay 2.5
    set report to "windows="
    repeat with w in windows
      set report to report & "[" & (name of w) & "]"
    end repeat
    -- the settings window is the frontmost non-empty-named one; try "General" then window 1
    set sw to missing value
    try
      set sw to window "General"
    end try
    if sw is missing value then set sw to window 1
    try
      click button "General" of toolbar 1 of sw
    end try
    delay 0.8
    repeat with pb in (UI elements of sw)
      if (role of pb) is "AXPopUpButton" then
        set v to ""
        try
          set v to (value of pb) as string
        end try
        if v is "Immediately" then
          set report to report & " found-log-popup=[" & v & "]"
          click pb
          delay 0.9
          key code 125
          delay 0.3
          key code 125
          delay 0.3
          key code 36
          delay 0.8
          set report to report & "<2down+return>"
          exit repeat
        end if
      end if
    end repeat
    delay 0.5
    try
      keystroke "w" using command down
    end try
    return report
  end tell
end tell
AS
  note "  AX result: $(lab_ssh "$IP" 'osascript /tmp/setlog.scpt 2>&1' </dev/null)"
  sleep 2
  note "  after: $(boundary)  (need logInterval=4; if still 0 the flip failed — swept/unswept legs blocked)"
  exit 0
fi

# ============================================================ B-FLIP + B-SWEEP
if [ "$CMD" = "flip" ]; then
  load_session
  note "################## B-FLIP + B-SWEEP — resolution-flip stopDate semantics per surface ##################"
  # NOTE on sweep manufacturing: logInterval=4 (Manually) is only settable in the
  # GUI Settings popup, driven by System Events synthetic clicks — which did NOT
  # land headless in this sitting (Settings window never opened; AX residual, see
  # write-up). So we cannot hold an UNSWEPT resolved item. INSTEAD we answer the
  # preserve-vs-restamp question by VALUE: every resolved fixture is first
  # BACKDATED (stopDate -> 2025-03-01 via AS) so a post-flip stopDate reads
  # UNAMBIGUOUSLY as either PRESERVED (still 2025-03-01) or RESTAMPED (jumps to
  # 'now' 2026-07-05). Under the golden default logInterval=0 the Logbook boundary
  # is 'now', so EVERY resolved item is swept (stop<=now); preservation is
  # therefore sweep-INVARIANT, whereas a restamp to 'now' is exactly what would
  # un-sweep the item under a manual-log boundary (the B-SWEEP consequence).
  note "  boundary at flip start: $(boundary)  (logInterval=0 => boundary=now => all resolutions swept)"
  BD='date "3/1/2025"'   # AS date literal, distinctive 2025 backdate (midnight)

  note "  -- seed 5 to-dos + resolve + BACKDATE stopDate to 2025-03-01 --"
  for t in F-CANCELED F-COMPLETED C-COMP2CANC C-CANC2COMP RE-COMP; do gurl "things:///add?title=BD-$t"; done
  sleep 1
  FCA=$(tid BD-F-CANCELED); FCO=$(tid BD-F-COMPLETED)
  UCO=$(tid BD-C-COMP2CANC); UCA=$(tid BD-C-CANC2COMP); REC=$(tid BD-RE-COMP)
  # resolve: FCA canceled, FCO completed, UCO completed, UCA canceled, REC completed
  setstatus todo "$FCA" canceled; setstatus todo "$FCO" completed
  setstatus todo "$UCO" completed; setstatus todo "$UCA" canceled; setstatus todo "$REC" completed
  # backdate every fixture's stopDate to 2025-03-01 (works on completed AND canceled?)
  for u in "$FCA" "$FCO" "$UCO" "$UCA" "$REC"; do
    gas "tell application \"Things3\" to set completion date of to do id \"$u\" to $BD" >/dev/null
  done
  note "  --- fixtures after backdate (stopH should read 2025-03-01 for all — incl. the CANCELED ones) ---"
  for v in "F-CANCELED=$FCA" "F-COMPLETED=$FCO" "C-COMP2CANC=$UCO" "C-CANC2COMP=$UCA" "RE-COMP=$REC"; do
    note "  ${v%%=*}: $(row "${v##*=}")"
  done

  note "  ================= B-FLIP(a) — URL update?completed=true on a CANCELED backdated to-do ================="
  note "  F-CANCELED BEFORE: $(row "$FCA")"
  gupd "$FCA" "completed=true"
  note "  F-CANCELED AFTER (status 2->3? stop 2025-03-01 preserved or restamped to 2026?): $(row "$FCA")"

  note "  ================= B-FLIP(b) — URL update?canceled=true on a COMPLETED backdated to-do ================="
  note "  F-COMPLETED BEFORE: $(row "$FCO")"
  gupd "$FCO" "canceled=true"
  note "  F-COMPLETED AFTER (status 3->2? stop preserved or restamped?): $(row "$FCO")"

  note "  ================= B-FLIP(c) — AppleScript set status flip on backdated resolved items ================="
  note "  C-COMP2CANC (completed) -> canceled:"
  note "    BEFORE: $(row "$UCO")"
  setstatus todo "$UCO" canceled
  note "    AFTER (stop preserved=GUI parity, or restamped?): $(row "$UCO")"
  note "  C-CANC2COMP (canceled) -> completed:"
  note "    BEFORE: $(row "$UCA")"
  setstatus todo "$UCA" completed
  note "    AFTER: $(row "$UCA")"

  note "  ================= B-FLIP(d) — idempotency: re-resolve an already-completed backdated item ================="
  note "  RE-COMP (completed, stop 2025-03-01) — re-complete via AppleScript set status:"
  note "    BEFORE: $(row "$REC")"
  setstatus todo "$REC" completed
  note "    AFTER AS re-complete (no-op/preserve? restamp? error?): $(row "$REC")"
  note "  RE-COMP — re-complete via URL update?completed=true:"
  gupd "$REC" "completed=true"
  note "    AFTER URL re-complete (preserve? restamp?): $(row "$REC")"

  note "  ================= B-FLIP project leg — flip a resolved backdated PROJECT ================="
  tjson '[{"type":"project","attributes":{"title":"BD-FPROJ","area-id":"'"$AREA_A"'"}}]'
  sleep 1
  FP=$(pid_of BD-FPROJ)
  note "  BD-FPROJ=$FP  (childless project so no cascade noise)"
  setstatus project "$FP" canceled
  gas "tell application \"Things3\" to set completion date of project id \"$FP\" to $BD" >/dev/null
  note "  project canceled + backdated to 2025-03-01: $(row "$FP")"
  gupdp "$FP" "completed=true"
  note "  project AFTER update-project?completed=true (status 2->3? stop preserve/restamp?): $(row "$FP")"
  setstatus project "$FP" canceled
  note "  project AFTER AS set status canceled (3->2, stop preserve/restamp?): $(row "$FP")"
  exit 0
fi

# ============================================================ B-FLIP2 — canceled-origin flips + set-comp-date-recompletes
if [ "$CMD" = "flip2" ]; then
  load_session
  note "################## B-FLIP2 — CANCELED-origin flips (exact-stopDate compare, no backdate) ##################"
  note "  (the backdate-via-completion-date trick FLIPS a canceled item to completed — see SCD below —"
  note "   so the canceled-origin legs compare the EXACT stopDate value before/after: a restamp advances"
  note "   stopDate by the elapsed seconds, a preserve leaves it byte-identical.)"
  for t in CA-URL CA-AS SCD; do gurl "things:///add?title=BD-$t"; done
  sleep 1
  CAU=$(tid BD-CA-URL); CAA=$(tid BD-CA-AS); SCD=$(tid BD-SCD)

  note "  ================= B-FLIP(a) — URL update?completed=true on a genuinely CANCELED to-do ================="
  setstatus todo "$CAU" canceled
  note "  CA-URL canceled, BEFORE: $(row "$CAU")"
  sleep 3
  gupd "$CAU" "completed=true"
  note "  CA-URL AFTER URL completed=true (flip 2->3? stop preserved to the exact cancel instant, or restamped +~3s?): $(row "$CAU")"

  note "  ================= B-FLIP(c) — AppleScript set status canceled->completed ================="
  setstatus todo "$CAA" canceled
  note "  CA-AS canceled, BEFORE: $(row "$CAA")"
  sleep 3
  setstatus todo "$CAA" completed
  note "  CA-AS AFTER AS set completed (flip 2->3? stop preserved or restamped?): $(row "$CAA")"

  note "  ================= set-completion-date RE-COMPLETES a canceled item (the backdate contamination) ================="
  setstatus todo "$SCD" canceled
  note "  SCD canceled (status=2), BEFORE: $(row "$SCD")"
  gas "tell application \"Things3\" to set completion date of to do id \"$SCD\" to date \"3/1/2025\"" | tee -a "$REPORT"
  note "  SCD AFTER set completion date (status 2->3 flip? stop=2025-03-01?): $(row "$SCD")"
  note "  -- contrast: set CREATION date on a canceled item (should NOT flip status) --"
  gurl "things:///add?title=BD-SCRT"
  SCR=$(tid BD-SCRT); setstatus todo "$SCR" canceled
  note "  SCRT canceled, BEFORE: $(row "$SCR")"
  gas "tell application \"Things3\" to set creation date of to do id \"$SCR\" to date \"6/1/2024\"" | tee -a "$REPORT"
  note "  SCRT AFTER set creation date (status stays 2? crt backdated?): $(row "$SCR")"
  exit 0
fi

# ============================================================ dump
if [ "$CMD" = "dump" ]; then
  load_session
  note "== crash / version =="
  lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo "Things3 ALIVE" || echo "Things3 DEAD"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | grep -i things || echo "no Things crash reports"' </dev/null | tee -a "$REPORT"
  note "Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)"
  note "== final boundary: $(boundary) =="
  lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/backdt.sqlite"' </dev/null
  lab_scp "$LAB_SSH_USER@$IP:/tmp/backdt.sqlite" "$OUT/final.sqlite" </dev/null 2>/dev/null || true
  note "DONE — report: $REPORT"
  exit 0
fi

echo "usage: $0 setup|projas|projasopen|projjson|dateonly|loginterval|flip|dump" >&2
exit 1
