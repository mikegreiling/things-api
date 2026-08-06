#!/bin/bash
# RESID1 — batched residual probes (four legs, shared sweep/settings machinery).
# Write-up: docs/lab/resid1-batched-residuals.md.
#
# ONE disposable clone of things-lab-golden-v2 (Things 3.22.12), pinned clock
# 2026-07-05 12:00 (guest TZ UTC => unixepoch == localtime). This script OWNS the
# VM lifecycle (clone + tracked background `tart run` + teardown). The REMREV
# campaign may hold the 2nd VM slot — setup refuses to boot a 2nd clone only if a
# SIBLING clone (not ours) is live AND the ceiling is hit; caller polls.
#
# Legs (executed in order: AX gate -> clock-independent JSONPAR while settings are
# pristine -> DAILYMAN mutates settings -> RESTAGE advances the clock LAST):
#   axretry   (R-AXRETRY, leg 4) retry the HEADSORT Settings-window AX recipe on a
#             fresh clone; read-only (does NOT flip logInterval). If it opens the
#             panel + reaches the log-interval AXPopUpButton, the BACKDT flake was
#             clone-local. Tries 3 open methods (Cmd-, / menu-click / preferences URL).
#   jsonpar   (R-JSONPAR, leg 1) drive the REAL guest CLI `todo add`/`project add`
#             with --completed-at/--created-at COMBINED with when/deadline/tags/
#             checklist/container/heading; byte-verify every attribute landed.
#             Run under the pristine golden logInterval=0 (boundary=now) so a
#             born-completed item's Logbook landing is unambiguous.
#   dailyman  (R-DAILYMAN, leg 3) set logInterval=1 (Daily) via AX, complete items
#             inside today's window (unswept), flip Daily->Manually via AX, read
#             TMSettings.manualLogDate: flip-time (forward-sweep, TIMEZ prediction)
#             or last-daily-edge (preserve)? + sweep state of the pending window.
#   restage   (R-RESTAGE, leg 2) complete->sweep->reactivate for DATED items whose
#             date passes WHILE SWEPT. (a) future-dated to-do; (b) someday+deadline
#             that goes overdue; (c) L-RESTORE re-cert. Clock advances here (one-way).
#             App-Today oracle via AppleScript `to dos of list "Today"` + guest CLI.
#   dump      crash/version + copy DB out
#   teardown  stop + delete the clone
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v2}"
PIN="${PIN:-070512002026}"          # 2026-07-05 12:00 (golden pinnedDate)
VM="${VM:-resid1-lab}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[resid1] $*" | tee -a "$REPORT"; }
CMD="${1:-}"

GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }
gq()  { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")" </dev/null; }
gsql(){ lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")" </dev/null; }
gas() { lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" </dev/null || true; }
gurl(){ lab_ssh "$IP" "open -g $(printf '%q' "$1")" </dev/null; sleep 2; }
uuid_of() { local t="$1" typ="${2:-}" w u i; w="title='$t' AND trashed=0"; [ -n "$typ" ] && w="$w AND type=$typ"
  for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }
pid_of() { gq "SELECT uuid FROM TMTask WHERE title='$1' AND type=1 AND trashed=0"; }
areaid() { gq "SELECT uuid FROM TMArea WHERE title='$1'"; }
boundary() { gq "SELECT 'logInterval='||logInterval||' manualLogDate='||COALESCE(printf('%.2f',manualLogDate),'NULL')||' mldUTC='||COALESCE(datetime(manualLogDate,'unixepoch'),'-')||' now='||strftime('%s','now') FROM TMSettings LIMIT 1"; }
clk() { lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null; }

# guest CLI (self-contained node bundle shipped in setup)
G() { lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js $*" </dev/null; }

# full task row snapshot by title (all leg-relevant columns)
row() { # $1 title  (most-recent by creation)
  gq "SELECT 'st='||status||' start='||start||' sb='||COALESCE(startBucket,'-')||' idx='||\"index\"||' sd='||COALESCE(startDate,'-')||' dl='||COALESCE(deadline,'-')||' stop='||COALESCE(printf('%.2f',stopDate),'-')||' stopUTC='||COALESCE(datetime(stopDate,'unixepoch'),'-')||' crt='||printf('%.2f',creationDate)||' crtUTC='||datetime(creationDate,'unixepoch')||' rem='||COALESCE(reminderTime,'-')||' h='||COALESCE(substr(heading,1,8),'-')||' p='||COALESCE(substr(project,1,8),'-')||' a='||COALESCE(substr(area,1,8),'-')||' tr='||trashed FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"
}
byid() { # $1 uuid
  gq "SELECT 'st='||status||' start='||start||' sb='||COALESCE(startBucket,'-')||' idx='||\"index\"||' sd='||COALESCE(startDate,'-')||' dl='||COALESCE(deadline,'-')||' stop='||COALESCE(printf('%.2f',stopDate),'-')||' stopUTC='||COALESCE(datetime(stopDate,'unixepoch'),'-')||' rem='||COALESCE(reminderTime,'-')||' h='||COALESCE(substr(heading,1,8),'-')||' p='||COALESCE(substr(project,1,8),'-')||' a='||COALESCE(substr(area,1,8),'-')||' umd='||printf('%.4f',userModificationDate) FROM TMTask WHERE uuid='$1'"
}
tags_of() { gq "SELECT COALESCE(GROUP_CONCAT(tg.title,','),'-') FROM TMTaskTag tt JOIN TMTag tg ON tg.uuid=tt.tags WHERE tt.tasks=(SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1)"; }
checklist_of() { gq "SELECT COALESCE(GROUP_CONCAT(title,'|'),'-') FROM TMChecklistItem WHERE task=(SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1) ORDER BY \"index\""; }

# app's OWN list membership (the GUI-equivalent oracle)
applist() { # $1 list-name -> comma-separated to-do names
  gas "tell application \"Things3\" to return name of to dos of list \"$1\""
}

tjson() {
  local url
  url=$(lab_ssh "$IP" "python3 -c 'import sys,urllib.parse; print(\"things:///json?auth-token=\"+sys.argv[1]+\"&data=\"+urllib.parse.quote(sys.argv[2],safe=\"\"))' $(printf '%q' "$TOKEN") $(printf '%q' "$1")" </dev/null)
  lab_ssh "$IP" "open -g $(printf '%q' "$url")" </dev/null; sleep 3
}

# ============================================================ setup
if [ "$CMD" = "setup" ]; then
  : > "$REPORT"
  SIB=$(pgrep -fl 'tart run' | grep -v "$VM" || true)
  [ -n "$SIB" ] && note "sibling tart run live (expected: remrev-lab): $SIB"
  note "cloning $GOLDEN -> $VM"
  tart delete "$VM" >/dev/null 2>&1 || true
  tart clone "$GOLDEN" "$VM" || { note "FATAL: tart clone failed (ceiling?)"; exit 2; }
  (tart run "$VM" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: SSH never came up"; tail -20 "$OUT/tart-run.log" | tee -a "$REPORT"; exit 1; }
  note "ssh up at $IP (VM $VM)"
  echo "IP=$IP" > "$SESSION"
  VNC_URL=$(grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 || true)
  echo "VNC_URL=$VNC_URL" >> "$SESSION"
  note "VNC: ${VNC_URL:-<none>}"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true; sudo route -n delete -inet6 default >/dev/null 2>&1 || true' </dev/null
  lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo "WARN online" || echo "airgapped"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" "sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null; date" </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"

  note "warm-up: launch/quit/relaunch Things on the pinned date"
  lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3' </dev/null
  lab_ssh "$IP" 'open -g -a Things3; sleep 8' </dev/null
  TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
  echo "TOKEN=$TOKEN" >> "$SESSION"
  note "token in hand (${#TOKEN} chars)"

  # ---- ship the guest CLI bundle (self-contained node + dist + commander) ----
  note "shipping guest CLI bundle (node + dist + commander)…"
  NODE_BIN=$(node -e 'console.log(process.execPath)')
  otool -L "$NODE_BIN" 2>/dev/null | grep -q '/opt/homebrew/' && note "WARN: node links homebrew dylibs (may SIGABRT on guest)"
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules' </dev/null
  scpO() { sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" -O "$@"; }
  scpO "$NODE_BIN" "$LAB_SSH_USER@$IP:/Users/$LAB_SSH_USER/things-lab/bin/node"
  lab_ssh "$IP" 'rm -rf ~/things-lab/things-api/dist' </dev/null
  scpO -r dist "$LAB_SSH_USER@$IP:/Users/$LAB_SSH_USER/things-lab/things-api/"
  scpO -r node_modules/commander "$LAB_SSH_USER@$IP:/Users/$LAB_SSH_USER/things-lab/things-api/node_modules/commander"
  scpO package.json "$LAB_SSH_USER@$IP:/Users/$LAB_SSH_USER/things-lab/things-api/package.json"
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node' </dev/null
  lab_ssh "$IP" '~/things-lab/bin/node --version' </dev/null >/dev/null 2>&1 || { note "FATAL: guest node not runnable"; exit 1; }
  note "guest CLI node: $(lab_ssh "$IP" '~/things-lab/bin/node --version' </dev/null)"
  note "guest CLI doctor exit: $(G doctor >/dev/null 2>&1; echo $?)"

  # ---- JSONPAR fixtures: a destination project WITH a heading (for --heading) ----
  AREA_A=$(areaid LAB-AREA-A); AREA_B=$(areaid LAB-AREA-B)
  note "areas A=$AREA_A B=$AREA_B"
  note "seed JP-PROJ (open project + heading JP-HEAD) for the JSONPAR container/heading cases"
  tjson '[{"type":"project","attributes":{"title":"JP-PROJ","area-id":"'"$AREA_A"'","items":[
    {"type":"heading","attributes":{"title":"JP-HEAD"}}]}}]'
  sleep 2
  note "JP-PROJ=$(pid_of JP-PROJ)  JP-HEAD=$(gq "SELECT uuid FROM TMTask WHERE title='JP-HEAD' AND type=2 AND trashed=0")"
  note "sweep state (pristine golden): $(boundary)"
  note "setup DONE — session in $SESSION"
  exit 0
fi

# ============================================================ axretry (LEG 4 R-AXRETRY)
if [ "$CMD" = "axretry" ]; then
  load_session
  note "################## R-AXRETRY (leg 4) — retry the Settings-window AX recipe (READ-ONLY) ##################"
  note "  golden-v2 L3 grant baked; BACKDT could not OPEN the Settings panel (menu-click ran, no window)."
  note "  HEADSORT/LOGSORT clones COULD (Cmd-,). Retry the exact HEADSORT recipe here; characterize 3 open methods."
  note "  before: $(boundary)"
  lab_ssh "$IP" 'open -a Things3; sleep 3' </dev/null

  # Method A — the HEADSORT recipe: keystroke "," using command down
  lab_ssh "$IP" "cat > /tmp/axA.scpt" <<'AS'
tell application "Things3" to activate
delay 1.5
tell application "System Events"
  tell process "Things3"
    set frontmost to true
    delay 0.5
    keystroke "," using command down
    delay 2.5
    set report to "windows="
    repeat with w in windows
      set report to report & "[" & (name of w) & "]"
    end repeat
    set sw to missing value
    try
      set sw to window "General"
    end try
    if sw is missing value then
      try
        set sw to window 1
      end try
    end if
    if sw is not missing value then
      set report to report & " sw=[" & (name of sw) & "]"
      set popcount to 0
      repeat with pb in (UI elements of sw)
        if (role of pb) is "AXPopUpButton" then
          set popcount to popcount + 1
          set v to ""
          try
            set v to (value of pb) as string
          end try
          set report to report & " popup[" & v & "]"
        end if
      end repeat
      set report to report & " (#popups=" & popcount & ")"
    else
      set report to report & " NO-SETTINGS-WINDOW"
    end if
    try
      keystroke "w" using command down
    end try
    return report
  end tell
end tell
AS
  note "  [A cmd-,]  $(lab_ssh "$IP" 'osascript /tmp/axA.scpt 2>&1' </dev/null)"
  sleep 1

  # Method B — the BACKDT recipe: click menu item "Settings…"
  lab_ssh "$IP" "cat > /tmp/axB.scpt" <<'AS'
tell application "Things3" to activate
delay 1.5
tell application "System Events"
  tell process "Things3"
    set frontmost to true
    delay 0.5
    try
      click menu item "Settings…" of menu 1 of menu bar item 2 of menu bar 1
    on error e
      return "menu-click ERROR: " & e
    end try
    delay 2.5
    set report to "windows="
    repeat with w in windows
      set report to report & "[" & (name of w) & "]"
    end repeat
    try
      keystroke "w" using command down
    end try
    return report
  end tell
end tell
AS
  note "  [B menu-click]  $(lab_ssh "$IP" 'osascript /tmp/axB.scpt 2>&1' </dev/null)"
  sleep 1

  # Method C — the preferences URL scheme
  note "  [C prefs-url]  opening things:///preferences (does the panel appear as a window?)"
  lab_ssh "$IP" "open -g 'things:///preferences'" </dev/null; sleep 2
  lab_ssh "$IP" "cat > /tmp/axC.scpt" <<'AS'
tell application "System Events"
  tell process "Things3"
    set report to "windows="
    repeat with w in windows
      set report to report & "[" & (name of w) & "]"
    end repeat
    return report
  end tell
end tell
AS
  note "  [C prefs-url windows]  $(lab_ssh "$IP" 'osascript /tmp/axC.scpt 2>&1' </dev/null)"
  lab_ssh "$IP" 'osascript -e "tell application \"System Events\" to tell process \"Things3\" to try
    keystroke \"w\" using command down
  end try" 2>/dev/null' </dev/null
  note "  after (logInterval UNCHANGED — read-only): $(boundary)"
  exit 0
fi

# ---- identify the Settings AXPopUpButtons (index / value / description / position) ----
if [ "$CMD" = "axid" ]; then
  load_session
  note "################## AXID — reliability of Cmd-, + identify the General-tab AXPopUpButtons ##################"
  # quit+relaunch for a clean window state, then retry Cmd-, up to 5x, reporting
  # which attempt (if any) surfaces the settings window + its popup inventory.
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit" 2>/dev/null; sleep 3; open -a Things3; sleep 6' </dev/null
  lab_ssh "$IP" "cat > /tmp/axid.scpt" <<'AS'
tell application "Things3" to activate
delay 1.0
tell application "System Events"
  tell process "Things3"
    set frontmost to true
    delay 0.5
    set out to ""
    repeat with attempt from 1 to 5
      keystroke "," using command down
      delay 2.0
      set sw to missing value
      try
        set sw to window "General"
      end try
      if sw is missing value then
        -- any window that is not the main [] / [Today] window?
        repeat with w in windows
          set nm to (name of w)
          if nm is not "" and nm is not "Today" then set sw to w
        end repeat
      end if
      if sw is not missing value then
        set out to out & "attempt " & attempt & ": OPENED sw=[" & (name of sw) & "] "
        set idx to 0
        repeat with pb in (UI elements of sw)
          if (role of pb) is "AXPopUpButton" then
            set idx to idx + 1
            set v to ""
            try
              set v to (value of pb) as string
            end try
            set out to out & idx & ":[" & v & "] "
          end if
        end repeat
        try
          keystroke "w" using command down
        end try
        return out
      else
        set wl to ""
        repeat with w in windows
          set wl to wl & "[" & (name of w) & "]"
        end repeat
        set out to out & "attempt " & attempt & ": no-settings-window (windows=" & wl & ") | "
        delay 1.5
      end if
    end repeat
    return out & "ALL 5 ATTEMPTS FAILED"
  end tell
end tell
AS
  note "  $(lab_ssh "$IP" 'osascript /tmp/axid.scpt 2>&1' </dev/null)"
  exit 0
fi

# ---- reusable Settings log-interval flip (Cmd-, open; N downs from current) ----
# $1 = down-count; $2 = 1-based AXPopUpButton index to target (log-interval = 3
# per AXID: Today/Automatic/[Immediately=logInterval]/Daily). Targeting by INDEX
# avoids the duplicate "Daily" popup ambiguity once logInterval is set to Daily.
axflip() {
  local downs="$1" target="${2:-3}"
  # quit+relaunch for a clean window state (AXID: the Cmd-, flake is stale-window,
  # cleared by a fresh launch — the panel then opens on attempt 1).
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit" 2>/dev/null; sleep 3; open -a Things3; sleep 6' </dev/null
  lab_ssh "$IP" "cat > /tmp/axflip.scpt" <<AS
on run
  set downs to $downs
  set targetIdx to $target
  tell application "Things3" to activate
  delay 1.0
  tell application "System Events"
    tell process "Things3"
      set frontmost to true
      delay 0.5
      set sw to missing value
      repeat with attempt from 1 to 4
        keystroke "," using command down
        delay 2.0
        try
          set sw to window "General"
        end try
        if sw is missing value then
          repeat with w in windows
            set nm to (name of w)
            if nm is not "" and nm is not "Today" then set sw to w
          end repeat
        end if
        if sw is not missing value then exit repeat
        delay 1.5
      end repeat
      if sw is missing value then return "FLIP-FAIL no settings window after 4 attempts"
      set report to "sw=[" & (name of sw) & "]"
      set idx to 0
      repeat with pb in (UI elements of sw)
        if (role of pb) is "AXPopUpButton" then
          set idx to idx + 1
          if idx is targetIdx then
            set v to ""
            try
              set v to (value of pb) as string
            end try
            set report to report & " popup#" & idx & "=[" & v & "] downs=" & downs
            click pb
            delay 0.9
            repeat downs times
              key code 125
              delay 0.3
            end repeat
            key code 36
            delay 0.8
            set report to report & " FLIPPED"
            exit repeat
          end if
        end if
      end repeat
      delay 0.4
      try
        keystroke "w" using command down
      end try
      return report
    end tell
  end tell
end run
AS
  lab_ssh "$IP" 'osascript /tmp/axflip.scpt 2>&1' </dev/null
  sleep 2
}

# ============================================================ jsonpar (LEG 1 R-JSONPAR)
if [ "$CMD" = "jsonpar" ]; then
  load_session
  note "################## R-JSONPAR (leg 1) — timestamped-add json attribute parity (REAL CLI) ##################"
  note "  boundary (expect pristine logInterval=0 => born-completed lands in Logbook): $(boundary)"
  JPP=$(pid_of JP-PROJ); JPH=$(gq "SELECT uuid FROM TMTask WHERE title='JP-HEAD' AND type=2 AND trashed=0")
  AREA_A=$(areaid LAB-AREA-A); AREA_B=$(areaid LAB-AREA-B)
  note "  JP-PROJ=$JPP JP-HEAD=$JPH area-A=$AREA_A area-B=$AREA_B"

  note "  ---- Case A: to-do BORN-COMPLETED, rich (completed-at + created-at + tags + checklist + project + heading) ----"
  note "     cmd: todo add JP-A --completed-at 2025-01-15T09:00 --created-at 2024-06-01T08:00 --tags JP-T1,JP-T2 --create-tags --checklist-item ck1 --checklist-item ck2 --project JP-PROJ --heading JP-HEAD"
  G todo add JP-A --completed-at 2025-01-15T09:00 --created-at 2024-06-01T08:00 --tags JP-T1,JP-T2 --create-tags --checklist-item ck1 --checklist-item ck2 --project JP-PROJ --heading JP-HEAD --json 2>&1 | tee -a "$REPORT"
  sleep 3
  note "     A row     : $(row JP-A)"
  note "     A tags    : $(tags_of JP-A)   (expect JP-T1,JP-T2)"
  note "     A checklist: $(checklist_of JP-A)   (expect ck1|ck2)"
  note "     A expect  : status=3(completed) stopUTC=2025-01-15 09:00:00 crtUTC=2024-06-01 08:00:00 h=$JPH (heading placement)"

  note "  ---- Case B: to-do BORN-COMPLETED into an AREA (+ tag) ----"
  note "     cmd: todo add JP-B --completed-at 2025-02-20T14:30 --area LAB-AREA-A --tags JP-T1 --create-tags"
  G todo add JP-B --completed-at 2025-02-20T14:30 --area LAB-AREA-A --tags JP-T1 --create-tags --json 2>&1 | tee -a "$REPORT"
  sleep 3
  note "     B row  : $(row JP-B)"
  note "     B tags : $(tags_of JP-B)   (expect JP-T1)"
  note "     B expect: status=3 stopUTC=2025-02-20 14:30:00 a=$AREA_A"

  note "  ---- Case C: to-do BORN-OPEN, backdated creation, SCHEDULED + deadline + tag + checklist + project ----"
  note "     cmd: todo add JP-C --created-at 2024-03-01T08:00 --when 2026-07-20 --deadline 2026-07-25 --tags JP-T2 --create-tags --checklist-item ckc --project JP-PROJ"
  G todo add JP-C --created-at 2024-03-01T08:00 --when 2026-07-20 --deadline 2026-07-25 --tags JP-T2 --create-tags --checklist-item ckc --project JP-PROJ --json 2>&1 | tee -a "$REPORT"
  sleep 3
  note "     C row     : $(row JP-C)"
  note "     C tags    : $(tags_of JP-C)   (expect JP-T2)"
  note "     C checklist: $(checklist_of JP-C)   (expect ckc)"
  note "     C expect  : status=0(open) crtUTC=2024-03-01 08:00:00 sd=2026-07-20 dl=2026-07-25 p=$JPP start=2"

  note "  ---- Case D: PROJECT BORN-COMPLETED (completed-at + created-at + area) ----"
  note "     cmd: project add JP-D --completed-at 2025-04-10T10:00 --created-at 2024-01-01T12:00 --area LAB-AREA-B"
  G project add JP-D --completed-at 2025-04-10T10:00 --created-at 2024-01-01T12:00 --area LAB-AREA-B --json 2>&1 | tee -a "$REPORT"
  sleep 3
  note "     D row (type=1): $(gq "SELECT 'st='||status||' type='||type||' start='||start||' stop='||COALESCE(printf('%.2f',stopDate),'-')||' stopUTC='||COALESCE(datetime(stopDate,'unixepoch'),'-')||' crtUTC='||datetime(creationDate,'unixepoch')||' a='||COALESCE(substr(area,1,8),'-') FROM TMTask WHERE title='JP-D' AND type=1 AND trashed=0 ORDER BY creationDate DESC LIMIT 1")"
  note "     D expect: status=3 type=1 stopUTC=2025-04-10 10:00:00 crtUTC=2024-01-01 12:00:00 a=$AREA_B"

  note "  ---- Case E: bare-DATE normalization end-to-end (engine expands to local NOON; json rejects bare dates, B-DATEONLY) ----"
  note "     cmd: todo add JP-E --completed-at 2025-05-05 --created-at 2024-05-05"
  G todo add JP-E --completed-at 2025-05-05 --created-at 2024-05-05 --json 2>&1 | tee -a "$REPORT"
  sleep 3
  note "     E row  : $(row JP-E)"
  note "     E expect: status=3 stopUTC=2025-05-05 12:00:00 crtUTC=2024-05-05 12:00:00 (NOON — TZ-proof normalization; guest TZ=UTC)"

  note "  ---- app Logbook oracle: which JP-* are in the app's Logbook list ----"
  note "     app 'to dos of list \"Logbook\"' JP filter: $(gas "tell application \"Things3\" to return name of to dos of list \"Logbook\"" | tr ',' '\n' | grep -i '^ *JP-' | tr '\n' ' ')"
  note "     app 'to dos of list \"Anytime\"'  JP filter: $(applist Anytime | tr ',' '\n' | grep -i '^ *JP-' | tr '\n' ' ')"
  exit 0
fi

# ============================================================ jsonpar2 (LEG 1 isolation)
if [ "$CMD" = "jsonpar2" ]; then
  load_session
  note "################## R-JSONPAR isolation — why did A (proj+heading) & C (proj+when) no-op? ##################"
  note "  A/C common factor = list-id -> a PROJECT; B(area)/D(area)/E(none) worked. Isolate: project vs when vs heading."
  JPP=$(pid_of JP-PROJ)
  note "  ---- F: completed + PROJECT, no heading/when (isolates project-as-list-id, completed) ----"
  G todo add JP-F --completed-at 2025-06-06T10:00 --project JP-PROJ --json 2>&1 | grep -v Experimental | grep -o '"ok":[a-z]*\|verify-failed[^"]*' | head -1 | sed 's/^/     /' | tee -a "$REPORT"
  sleep 2; note "     F row: $(row JP-F)"
  note "  ---- I: created-at OPEN + PROJECT, no when/heading (isolates project-as-list-id, open) ----"
  G todo add JP-I --created-at 2024-08-08T10:00 --project JP-PROJ --json 2>&1 | grep -v Experimental | grep -o '"ok":[a-z]*\|verify-failed[^"]*' | head -1 | sed 's/^/     /' | tee -a "$REPORT"
  sleep 2; note "     I row: $(row JP-I)"
  note "  ---- G: created-at OPEN + WHEN, no container (isolates the when attr) ----"
  G todo add JP-G --created-at 2024-07-07T10:00 --when 2026-07-20 --json 2>&1 | grep -v Experimental | grep -o '"ok":[a-z]*\|verify-failed[^"]*' | head -1 | sed 's/^/     /' | tee -a "$REPORT"
  sleep 2; note "     G row: $(row JP-G)"
  note "  ---- K: created-at OPEN + WHEN + AREA (when with a working area container) ----"
  G todo add JP-K --created-at 2024-09-09T10:00 --when 2026-07-20 --area LAB-AREA-A --json 2>&1 | grep -v Experimental | grep -o '"ok":[a-z]*\|verify-failed[^"]*' | head -1 | sed 's/^/     /' | tee -a "$REPORT"
  sleep 2; note "     K row: $(row JP-K)"
  note "  ---- control: does a PLAIN (non-timestamped) add into JP-PROJ work? (baseline that list-id=project is normally fine) ----"
  G todo add JP-PLAIN --project JP-PROJ --json 2>&1 | grep -v Experimental | grep -o '"ok":[a-z]*\|verify-failed[^"]*' | head -1 | sed 's/^/     /' | tee -a "$REPORT"
  sleep 2; note "     PLAIN row: $(row JP-PLAIN)"
  note "  ---- direct probe: raw things:///json with a completed to-do + list-id=PROJECT (bypass the CLI verify) ----"
  tjson '[{"type":"to-do","attributes":{"title":"JP-RAW","completed":true,"completion-date":"2025-06-06T10:00:00Z","list-id":"'"$JPP"'"}}]'
  note "     RAW (completed+list-id=project via raw json): $(row JP-RAW)"
  note "  ---- direct probe: raw json completed to-do + list (project by NAME) instead of list-id ----"
  tjson '[{"type":"to-do","attributes":{"title":"JP-RAWNAME","completed":true,"completion-date":"2025-06-06T10:00:00Z","list":"JP-PROJ"}}]'
  note "     RAWNAME (completed+list=name via raw json): $(row JP-RAWNAME)"
  exit 0
fi

# ============================================================ jsonpar3 (checklist isolation)
if [ "$CMD" = "jsonpar3" ]; then
  load_session
  note "################## R-JSONPAR checklist isolation — A & C are the ONLY cases with a checklist ##################"
  note "  hypothesis: a timestamped json import + checklist-items silently no-ops. Isolate checklist x timestamp x completed."
  note "  ---- L: completed-at + checklist ONLY (CLI) ----"
  G todo add JP-L --completed-at 2025-06-06T10:00 --checklist-item ck1 --json 2>&1 | grep -v Experimental | grep -o '"ok":[a-z]*\|verify-failed[^"]*' | head -1 | sed 's/^/     /' | tee -a "$REPORT"
  sleep 2; note "     L row: $(row JP-L)  checklist: $(checklist_of JP-L)"
  note "  ---- M: created-at OPEN + checklist ONLY (CLI) ----"
  G todo add JP-M --created-at 2024-06-06T10:00 --checklist-item ck1 --json 2>&1 | grep -v Experimental | grep -o '"ok":[a-z]*\|verify-failed[^"]*' | head -1 | sed 's/^/     /' | tee -a "$REPORT"
  sleep 2; note "     M row: $(row JP-M)  checklist: $(checklist_of JP-M)"
  note "  ---- RAW-a: raw json completed + completion-date + checklist-items (timestamped completed + checklist) ----"
  tjson '[{"type":"to-do","attributes":{"title":"JP-RA","completed":true,"completion-date":"2025-06-06T10:00:00Z","checklist-items":["x1","x2"]}}]'
  note "     RA row: $(row JP-RA)  checklist: $(checklist_of JP-RA)"
  note "  ---- RAW-b: raw json completed + checklist-items, NO date (completed + checklist) ----"
  tjson '[{"type":"to-do","attributes":{"title":"JP-RB","completed":true,"checklist-items":["x1","x2"]}}]'
  note "     RB row: $(row JP-RB)  checklist: $(checklist_of JP-RB)"
  note "  ---- RAW-c: raw json creation-date + checklist-items (open + timestamp + checklist) ----"
  tjson '[{"type":"to-do","attributes":{"title":"JP-RC","creation-date":"2024-06-06T10:00:00Z","checklist-items":["x1","x2"]}}]'
  note "     RC row: $(row JP-RC)  checklist: $(checklist_of JP-RC)"
  note "  ---- RAW-d: raw json plain open + checklist-items (baseline: does json checklist work at all?) ----"
  tjson '[{"type":"to-do","attributes":{"title":"JP-RD","checklist-items":["x1","x2"]}}]'
  note "     RD row: $(row JP-RD)  checklist: $(checklist_of JP-RD)"
  exit 0
fi

# ============================================================ jsonpar4 (correct-shape confirm)
if [ "$CMD" = "jsonpar4" ]; then
  load_session
  note "################## R-JSONPAR shape fix — does the OBJECT-array checklist shape work? ##################"
  note "  engine commands.ts:446 (timestamped add) emits checklist-items as a bare STRING array;"
  note "  commands.ts:837 (checklist UPDATE path) emits the OBJECT array [{type:checklist-item,attributes:{title}}]."
  JPP=$(pid_of JP-PROJ)
  note "  ---- OBJ: raw json completed + completion-date + OBJECT-array checklist ----"
  tjson '[{"type":"to-do","attributes":{"title":"JP-OBJ","completed":true,"completion-date":"2025-06-06T10:00:00Z","checklist-items":[{"type":"checklist-item","attributes":{"title":"x1"}},{"type":"checklist-item","attributes":{"title":"x2"}}]}}]'
  note "     OBJ row      : $(row JP-OBJ)"
  note "     OBJ checklist: $(checklist_of JP-OBJ)   (expect x1|x2 if the object-array shape is the correct one)"
  note "  ---- OBJ2: raw json OPEN + OBJECT-array checklist (no timestamp) — baseline the shape ----"
  tjson '[{"type":"to-do","attributes":{"title":"JP-OBJ2","checklist-items":[{"type":"checklist-item","attributes":{"title":"y1"}}]}}]'
  note "     OBJ2 row      : $(row JP-OBJ2)"
  note "     OBJ2 checklist: $(checklist_of JP-OBJ2)"
  note "  ---- OBJ3: full Case-A analogue via raw json (completed + dates + project + heading + tags + OBJECT checklist) ----"
  tjson '[{"type":"to-do","attributes":{"title":"JP-OBJ3","completed":true,"completion-date":"2025-01-15T09:00:00Z","creation-date":"2024-06-01T08:00:00Z","list-id":"'"$JPP"'","heading":"JP-HEAD","tags":["JP-T1","JP-T2"],"checklist-items":[{"type":"checklist-item","attributes":{"title":"ck1"}},{"type":"checklist-item","attributes":{"title":"ck2"}}]}}]'
  note "     OBJ3 row      : $(row JP-OBJ3)"
  note "     OBJ3 tags     : $(tags_of JP-OBJ3)   (expect JP-T1,JP-T2)"
  note "     OBJ3 checklist: $(checklist_of JP-OBJ3)   (expect ck1|ck2)"
  note "     OBJ3 heading placement: h= should equal JP-HEAD=$(gq "SELECT uuid FROM TMTask WHERE title='JP-HEAD' AND type=2 AND trashed=0")"
  exit 0
fi

# ============================================================ dailyman (LEG 3 R-DAILYMAN)
if [ "$CMD" = "dailyman" ]; then
  load_session
  note "################## R-DAILYMAN (leg 3) — Daily->Manually manualLogDate stamp timing ##################"
  note "  Q: with logInterval=1 (Daily) + completions pending inside today's window, flip to Manually —"
  note "     does manualLogDate stamp at FLIP TIME (forward-sweep the pending window, TIMEZ prediction)"
  note "     or at the LAST DAILY EDGE (today 00:00, preserving the pending state)?"
  note "  clock now: $(clk)  (pinned 2026-07-05 12:00; last daily edge = 2026-07-05 00:00)"
  note "  S0 boundary (pristine): $(boundary)"

  note "  -- FLIP 1: Immediately(0) -> Daily(1) via AX (1 down) --"
  note "     axflip result: $(axflip 1)"
  note "     S1 boundary after 0->1: $(boundary)   (logInterval should be 1; note manualLogDate stamp)"
  LI1=$(gq "SELECT logInterval FROM TMSettings LIMIT 1")
  if [ "$LI1" != "1" ]; then
    note "  ⚠ logInterval is $LI1 not 1 — AX flip to Daily FAILED. Leg 3 BLOCKED (needs Settings AX). Aborting leg."
    note "  (see R-AXRETRY verdict; if AX is blocked on this clone leg 3 cannot manufacture the Daily state)"
    exit 3
  fi

  note "  -- create 3 to-dos and COMPLETE them NOW (stopDate ~12:xx today => inside today's window, after the 00:00 edge) --"
  for t in DMAN-1 DMAN-2 DMAN-3; do gurl "things:///add?title=$t&auth-token=$TOKEN"; done
  sleep 2
  for t in DMAN-1 DMAN-2 DMAN-3; do
    U=$(uuid_of "$t"); gas "tell application \"Things3\" to set status of to do id \"$U\" to completed"; sleep 1
  done
  sleep 2
  note "     S2 boundary (Daily, completions pending): $(boundary)"
  note "     DMAN-1: $(row DMAN-1)"
  note "     DMAN-2: $(row DMAN-2)"
  note "     DMAN-3: $(row DMAN-3)"
  note "     -- swept? under Daily boundary=max(today-00:00, manualLogDate); a completion is SWEPT iff stopDate<=boundary --"
  note "     app Logbook (pending items should NOT be here yet if unswept): $(gas "tell application \"Things3\" to return name of to dos of list \"Logbook\"" | tr ',' '\n' | grep -i '^ *DMAN-' | tr '\n' ' ')"
  note "     computed boundary vs stopDates:"
  gq "SELECT title||': stop='||printf('%.2f',stopDate)||' stopUTC='||datetime(stopDate,'unixepoch')||' <=mld('||COALESCE(printf('%.2f',(SELECT manualLogDate FROM TMSettings LIMIT 1)),'NULL')||')? '||CASE WHEN stopDate<=(SELECT COALESCE(manualLogDate,0) FROM TMSettings LIMIT 1) THEN 'SWEPT-by-mld' ELSE 'after-mld' END FROM TMTask WHERE title LIKE 'DMAN-%' AND trashed=0" | tee -a "$REPORT"

  note "  -- FLIP 2: Daily(1) -> Manually(4) via AX (1 down from Daily) — THE PROBE --"
  note "     manualLogDate BEFORE flip2: $(gq "SELECT COALESCE(printf('%.2f',manualLogDate),'NULL')||' ('||COALESCE(datetime(manualLogDate,'unixepoch'),'-')||')' FROM TMSettings LIMIT 1")"
  note "     axflip result: $(axflip 1)"
  LI2=$(gq "SELECT logInterval FROM TMSettings LIMIT 1")
  note "     S3 boundary after 1->4: $(boundary)   (logInterval should be 4)"
  note "     manualLogDate AFTER flip2: $(gq "SELECT COALESCE(printf('%.2f',manualLogDate),'NULL')||' ('||COALESCE(datetime(manualLogDate,'unixepoch'),'-')||')' FROM TMSettings LIMIT 1")"
  note "     VERDICT DISCRIMINATOR: manualLogDate ~= 2026-07-05 12:xx (FLIP-TIME => forward-swept the window, TIMEZ confirmed)"
  note "                            OR   manualLogDate ~= 2026-07-05 00:00 (LAST-DAILY-EDGE => preserved the pending window)"
  note "     -- sweep state of the pending window AFTER flip2 --"
  gq "SELECT title||': stop='||datetime(stopDate,'unixepoch')||' vs mld='||COALESCE(datetime((SELECT manualLogDate FROM TMSettings LIMIT 1),'unixepoch'),'NULL')||' => '||CASE WHEN stopDate<=(SELECT COALESCE(manualLogDate,0) FROM TMSettings LIMIT 1) THEN 'SWEPT' ELSE 'UNSWEPT' END FROM TMTask WHERE title LIKE 'DMAN-%' AND trashed=0" | tee -a "$REPORT"
  note "     app Logbook after flip2 (swept => present): $(gas "tell application \"Things3\" to return name of to dos of list \"Logbook\"" | tr ',' '\n' | grep -i '^ *DMAN-' | tr '\n' ' ')"
  note "  (leaves logInterval=4/Manually for RESTAGE)"
  exit 0
fi

# ============================================================ restage (LEG 2 R-RESTAGE) — CLOCK ADVANCES
if [ "$CMD" = "restage" ]; then
  load_session
  note "################## R-RESTAGE (leg 2) — swept DATED items whose date passes while swept ##################"
  note "  ALL fixtures built + completed + swept at the pinned clock FIRST, THEN the clock advances (one-way)."
  note "  boundary at start: $(boundary)  clock: $(clk)"
  JPP=$(pid_of JP-PROJ); JPH=$(gq "SELECT uuid FROM TMTask WHERE title='JP-HEAD' AND type=2 AND trashed=0")

  # ---- build fixtures at the pinned clock (2026-07-05) ----
  note "  -- seed RS-A: to-do scheduled FUTURE (when=2026-07-08), inside a project heading, at a known index --"
  tjson '[{"type":"to-do","attributes":{"title":"RS-A","when":"2026-07-08","list-id":"'"$JPP"'","heading":"JP-HEAD"}}]'
  sleep 2
  RSA=$(uuid_of RS-A)
  note "     RS-A=$RSA  PRE: $(byid "$RSA")"
  note "  -- seed RS-B: SOMEDAY to-do with a deadline (2026-07-07) that will go overdue while swept --"
  gurl "things:///add?title=RS-B&when=someday&deadline=2026-07-07&auth-token=$TOKEN"
  sleep 2
  RSB=$(uuid_of RS-B)
  note "     RS-B=$RSB  PRE: $(byid "$RSB")"
  note "  -- seed RS-C: L-RESTORE re-cert — plain to-do under a heading at a known index --"
  tjson '[{"type":"to-do","attributes":{"title":"RS-C","list-id":"'"$JPP"'","heading":"JP-HEAD"}}]'
  sleep 2
  RSC=$(uuid_of RS-C)
  note "     RS-C=$RSC  PRE: $(byid "$RSC")"

  note "  -- COMPLETE all three at the pinned clock (2026-07-05) --"
  for U in "$RSA" "$RSB" "$RSC"; do gas "tell application \"Things3\" to set status of to do id \"$U\" to completed"; sleep 1; done
  note "  -- SWEEP: log completed now (advances manualLogDate to now => all three swept regardless of logInterval) --"
  gas "tell application \"Things3\" to log completed now"; sleep 2
  note "     boundary after sweep: $(boundary)"
  note "     RS-A swept: $(byid "$RSA")"
  note "     RS-B swept: $(byid "$RSB")"
  note "     RS-C swept: $(byid "$RSC")"
  note "     app Logbook (all three should be present=swept): $(gas "tell application \"Things3\" to return name of to dos of list \"Logbook\"" | tr ',' '\n' | grep -i '^ *RS-' | tr '\n' ' ')"
  IDXA=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$RSA'"); HA=$(gq "SELECT COALESCE(heading,'-') FROM TMTask WHERE uuid='$RSA'"); SDA=$(gq "SELECT COALESCE(startDate,'-') FROM TMTask WHERE uuid='$RSA'")
  IDXC=$(gq "SELECT \"index\" FROM TMTask WHERE uuid='$RSC'"); HC=$(gq "SELECT COALESCE(heading,'-') FROM TMTask WHERE uuid='$RSC'")
  note "     retained refs: RS-A idx=$IDXA heading=$HA startDate=$SDA | RS-C idx=$IDXC heading=$HC"

  # ---- ADVANCE THE CLOCK past the dates (one-way) ----
  note "  ================= ADVANCE CLOCK 2026-07-05 -> 2026-07-09 (past RS-A's 07-08 and RS-B's 07-07 deadline) ================="
  lab_ssh "$IP" 'sudo date 070912002026 >/dev/null; date' </dev/null | tee -a "$REPORT"
  note "  -- relaunch Things so it recomputes Today/Upcoming buckets for the new date --"
  lab_ssh "$IP" 'osascript -e "tell application \"Things3\" to quit"; sleep 3; open -g -a Things3; sleep 10' </dev/null
  note "  clock now: $(clk)"
  note "  app lists BEFORE reactivation (baseline):"
  note "     Today   : $(applist Today)"
  note "     Upcoming: $(applist Upcoming)"

  note "  ================= (a) REACTIVATE RS-A (future-dated, date now PAST) ================="
  note "     RS-A pre-reactivate (still swept): $(byid "$RSA")"
  gas "tell application \"Things3\" to set status of to do id \"$RSA\" to open"; sleep 3
  note "     RS-A POST-reactivate: $(byid "$RSA")"
  note "     RS-A idx retained? was $IDXA  heading retained? was $HA  startDate? was $SDA"
  note "     app Today   contains RS-A? : $(applist Today | tr ',' '\n' | grep -c 'RS-A')  [$(applist Today)]"
  note "     app Anytime contains RS-A? : $(applist Anytime | tr ',' '\n' | grep -c 'RS-A')"
  note "     app Upcoming contains RS-A?: $(applist Upcoming | tr ',' '\n' | grep -c 'RS-A')"
  note "     guest CLI today (RS-A?): $(G today --json 2>/dev/null | grep -o 'RS-A' | head -1 || echo none)"
  note "     VERDICT(a): startDate 2026-07-08 now in the PAST — does RS-A land in TODAY (arrived-dated) or ANYTIME?"

  note "  ================= (b) REACTIVATE RS-B (someday + deadline now OVERDUE) ================="
  note "     RS-B pre-reactivate (still swept): $(byid "$RSB")"
  gas "tell application \"Things3\" to set status of to do id \"$RSB\" to open"; sleep 3
  note "     RS-B POST-reactivate: $(byid "$RSB")"
  note "     app Today    contains RS-B? : $(applist Today | tr ',' '\n' | grep -c 'RS-B')  [deadline 2026-07-07 overdue at 07-09]"
  note "     app Anytime  contains RS-B? : $(applist Anytime | tr ',' '\n' | grep -c 'RS-B')"
  note "     guest CLI today (RS-B due/overdue?): $(G today --json 2>/dev/null | grep -o 'RS-B' | head -1 || echo none)"
  note "     VERDICT(b): does an overdue-deadline someday item surface in TODAY's due/overdue on reactivation?"

  note "  ================= (c) REACTIVATE RS-C (L-RESTORE re-cert: index/heading retention) ================="
  note "     RS-C pre-reactivate (still swept): $(byid "$RSC")"
  gas "tell application \"Things3\" to set status of to do id \"$RSC\" to open"; sleep 3
  note "     RS-C POST-reactivate: $(byid "$RSC")"
  note "     RS-C idx retained? was $IDXC (expect UNCHANGED)  heading retained? was $HC (expect UNCHANGED)"
  note "     VERDICT(c): L-RESTORE — index-SILENT + heading-retained + when-retained still holds under golden-v2 3.22.12?"
  exit 0
fi

# ============================================================ dump / teardown
if [ "$CMD" = "dump" ]; then
  load_session
  note "== crash / version =="
  lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo "Things3 ALIVE" || echo "Things3 DEAD"' </dev/null | tee -a "$REPORT"
  lab_ssh "$IP" 'ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | grep -i things || echo "no Things crash reports"' </dev/null | tee -a "$REPORT"
  note "Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / clock $(clk)"
  note "final TMSettings: $(boundary)"
  lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); sqlite3 "$DB" ".backup /tmp/resid1.sqlite"' </dev/null
  lab_scp "$LAB_SSH_USER@$IP:/tmp/resid1.sqlite" "$OUT/final.sqlite" </dev/null 2>/dev/null || true
  note "DONE — report: $REPORT"
  exit 0
fi

if [ "$CMD" = "teardown" ]; then
  note "teardown: stop + delete $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "teardown DONE"
  exit 0
fi

echo "usage: $0 setup|axretry|axid|jsonpar|jsonpar2|jsonpar3|jsonpar4|dailyman|restage|dump|teardown" >&2
exit 1
