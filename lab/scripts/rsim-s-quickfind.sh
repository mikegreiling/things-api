#!/bin/bash
# RSIM-S Q2 — Quick Find visibility of template-side children (AX drive).
# Uses the running rsim-s-lab VM (Accessibility granted). For each search term:
# activate Things3, Cmd-F (Quick Find), type the term, dump the AX tree of every
# Things window, and record which of {template-side child, instance-side child,
# template project row} appear. Also snaps a VNC screenshot for human review.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/rsim-s-lab"; REPORT="$OUT/report.txt"; mkdir -p "$OUT/ax"
source "$OUT/state.env"
VNCDO="${VNCDO:-}"
note() { echo "[rsims] $*" | tee -a "$REPORT"; }
gq() { lab_ssh "$IP" "~/things-lab/helpers/gsql.sh -q $(printf '%q' "$1")" </dev/null; }

# ship an AX dumper to the guest (entire contents of every Things3 window)
lab_ssh "$IP" "cat > ~/things-lab/helpers/axdump.scpt" <<'AS'
tell application "System Events" to tell process "Things3"
  set out to ""
  repeat with w in windows
    set out to out & "=== WINDOW " & (name of w) & " ===" & linefeed
    try
      set ec to entire contents of w
      repeat with e in ec
        set ln to ""
        try
          set ln to (role of e as string)
        end try
        try
          set ln to ln & " | val=" & (value of e as string)
        end try
        try
          set ln to ln & " | desc=" & (description of e as string)
        end try
        try
          set ln to ln & " | ttl=" & (title of e as string)
        end try
        set out to out & ln & linefeed
      end repeat
    on error errm
      set out to out & "(entire contents error: " & errm & ")" & linefeed
    end try
  end repeat
  return out
end tell
AS

# also list front/overlay via a lighter path if entire-contents is slow
qf() {
  local term="$1" tag="$2"
  note ""; note "--- Quick Find search: '$term' ($tag) ---"
  lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to activate'\'' ; sleep 2' </dev/null
  # open Quick Find (Cmd-F) and clear any prior text, then type the term
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to keystroke "f" using command down'\''; sleep 1.5; osascript -e '\''tell application "System Events" to keystroke "a" using command down'\''; osascript -e '\''tell application "System Events" to key code 51'\''; sleep 0.5' </dev/null
  lab_ssh "$IP" "osascript -e 'tell application \"System Events\" to keystroke \"$term\"'; sleep 3" </dev/null
  # AX dump
  lab_ssh "$IP" 'osascript ~/things-lab/helpers/axdump.scpt' </dev/null > "$OUT/ax/qf-$tag.txt" 2>&1
  note "  AX dump -> $OUT/ax/qf-$tag.txt ($(wc -l <"$OUT/ax/qf-$tag.txt"|tr -d ' ') lines)"
  # VNC screenshot for human review
  if [ -n "$VNCDO" ] && [ -n "${SERVER:-}" ]; then
    timeout 30 "$VNCDO" -s "$SERVER" -p "$PASS" capture "$OUT/ax/qf-$tag.png" 2>>"$OUT/vnc.log" && note "  screenshot -> $OUT/ax/qf-$tag.png" || note "  (screenshot failed)"
  fi
  # summarize hits for the term
  note "  hits for '$term' in AX dump (role|val lines containing the term):"
  grep -n -- "$term" "$OUT/ax/qf-$tag.txt" | sed 's/^/    /' | head -40 | tee -a "$REPORT"
  local n; n=$(grep -c -- "$term" "$OUT/ax/qf-$tag.txt" || true); note "  total lines mentioning '$term': $n"
  # close Quick Find
  lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to key code 53'\''; sleep 1' </dev/null
}

"$@"
