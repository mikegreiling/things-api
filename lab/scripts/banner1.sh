#!/bin/bash
# BANNER1 dispatcher — drive the questions after research-banner1.sh leaves the VM
# running. Reads lab/artifacts/banner1-lab/state.env for IP/SERVER/PASS/AUTH.
# Subcommands:
#   env                         env line (Things/macOS/clock)
#   quit | launch | relaunch <DDHHMM2026>
#   clock <DDHHMM2026>          set guest date (app should be CLOSED)
#   url '<things:///...>'       fire a URL-scheme write (auto-appends auth-token)
#   rawurl '<url>'              fire a URL verbatim (no auth append)
#   aslist <List>              AppleScript membership oracle (Today/Someday/Upcoming)
#   rows [glob]                 per-row DB dump (default BAN-%)
#   repeater <title>            make-repeating (daily fixed) via CLI ui-vector
#   axdump                      dump the Things window AX subtree (banner discovery)
#   banner                      read the "N new to-dos" banner text via AX
#   ok                          click the banner OK button (AX by name)
#   okvnc <x> <y>               click OK via VNC HID (coordinate fallback)
#   shot <name>                 VNC screenshot -> snaps/<name>.png
#   dbdump <label> | cdump <label>    before/after-OK snapshots (in guest)
#   pull <label>                copy guest dumps/<label>.* to host artifacts
#   sel <uuid> | oracle         selection oracle
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/banner1-lab"
source "$OUT/state.env"
VNCDO="${VNCDO:-}"
V() { sleep 1; timeout 40 "$VNCDO" -s "$SERVER" -p "$PASS" "$@" 2>>"$OUT/vnc.log"; }
AX() { lab_ssh "$IP" "/usr/bin/osascript -e $(printf '%q' "$1") 2>&1" </dev/null; }
mkdir -p "$OUT/snaps"

cmd="${1:-}"; shift || true
case "$cmd" in
  env)
    echo "Things $(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null) / macOS $(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null) / clock $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)" ;;
  quit)   lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\''; sleep 4' </dev/null ;;
  launch) lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null ;;
  clock)  lab_ssh "$IP" "sudo date $1 >/dev/null; date" </dev/null ;;
  relaunch)
    lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\''; sleep 4' </dev/null
    lab_ssh "$IP" "sudo date $1 >/dev/null; date" </dev/null
    lab_ssh "$IP" 'open -g -a Things3; sleep 14' </dev/null ;;
  url)    lab_ssh "$IP" "open -g $(printf '%q' "$1&auth-token=$AUTH"); sleep 2" </dev/null ;;
  rawurl) lab_ssh "$IP" "open -g $(printf '%q' "$1"); sleep 2" </dev/null ;;
  aslist) AX "tell application \"Things3\" to get name of to dos of list \"$1\"" ;;
  rows)   lab_ssh "$IP" "~/things-lab/helpers/rows.sh $(printf '%q' "${1:-BAN-%}")" </dev/null ;;
  sql)    lab_ssh "$IP" "~/things-lab/helpers/gsql.sh $(printf '%q' "$1")" </dev/null ;;
  metaitem) # decode the TMMetaItem bplist blob(s) to XML (candidate reviewed-state store)
    lab_ssh "$IP" 'DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite); for u in $(sqlite3 "file:$DB?mode=ro" "SELECT uuid FROM TMMetaItem"); do echo "== $u =="; sqlite3 "file:$DB?mode=ro" "SELECT writefile('"'"'/tmp/mi.bin'"'"', value) FROM TMMetaItem WHERE uuid='"'"'$u'"'"'" >/dev/null; plutil -convert xml1 -o - /tmp/mi.bin 2>&1 || (echo "(plutil failed; hexdump)"; xxd /tmp/mi.bin | head -40); done' </dev/null ;;
  sqll)   lab_ssh "$IP" "DB=\$(echo ~/Library/Group\\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\\ Database.thingsdatabase/main.sqlite); sqlite3 -line \"file:\$DB?mode=ro\" $(printf '%q' "$1")" </dev/null ;;
  repeater)
    # repeater <uuid-or-ref> : make an existing to-do a daily FIXED repeater (ui-vector)
    lab_ssh "$IP" "~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js todo make-repeating $(printf '%q' "$1") --frequency daily --interval 1 --dangerously-drive-gui" </dev/null ;;
  axdump)
    AX 'tell application "System Events" to tell process "Things3" to get entire contents of window 1' ;;
  banner)
    # discover: any static text / button under window 1 mentioning "new"
    AX 'tell application "System Events" to tell process "Things3"
          set out to ""
          repeat with w in windows
            try
              set sts to every static text of w whose value contains "new"
              repeat with s in sts
                set out to out & "TXT:" & (value of s) & linefeed
              end repeat
            end try
          end repeat
          return out
        end tell' ;;
  ok)
    AX 'tell application "System Events" to tell process "Things3"
          set done to "no-ok-found"
          repeat with w in windows
            try
              click (first button of w whose title is "OK")
              set done to "clicked-OK"
            end try
          end repeat
          return done
        end tell' ;;
  okvnc) V move "$1" "$2" click 1 ;;
  shot)  V capture "$OUT/snaps/$1.png"; echo "snap: $OUT/snaps/$1.png" ;;
  dbdump) lab_ssh "$IP" "~/things-lab/helpers/dbdump.sh $1" </dev/null; echo "dbdump $1 done" ;;
  cdump)  lab_ssh "$IP" "~/things-lab/helpers/cdump.sh $1" </dev/null; echo "cdump $1 done" ;;
  pull)
    for ext in dump settings container defaults; do
      lab_scp "$LAB_SSH_USER@$IP:/Users/admin/things-lab/dumps/$1.$ext" "$OUT/" 2>/dev/null || true
    done; echo "pulled $1.* -> $OUT/" ;;
  sel)    lab_ssh "$IP" "open 'things:///show?id=$1'; sleep 2" </dev/null ;;
  oracle) AX 'tell application "Things3" to get id of selected to dos' ;;
  *) echo "unknown: $cmd"; exit 2 ;;
esac
