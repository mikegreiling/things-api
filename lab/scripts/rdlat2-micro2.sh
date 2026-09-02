#!/bin/bash
# RDLAT2 — second calibration pass: WHERE inside one addressed read the time goes.
#
# The first pass measured ~8-20 ms per addressed read against the open Repeat
# dialog and ~64 ms per osascript process. That per-read number is what the whole
# campaign turns on, so this pass decomposes it:
#
#   M6  the `whose`-clause shell address — which AppleScript re-evaluates on
#       EVERY access through it, because the binding is a lazy specifier — against
#       the same read through a window addressed by INDEX
#   M7  plural vs singular property reads with the cadence group in its WIDEST
#       state (a fixed monthly frequency: five static texts)
#   M8  the shell's control census: five `count of <class>` reads against one
#       `role of UI elements` list
#   M9  nesting depth: a deep inline address against one with the group bound
#   M10 how many windows the `whose` clause has to walk, and their subroles
#
# The caller opens a Repeat dialog and sets the frequency to monthly first.
set -uo pipefail
say() { echo "  [micro2] $*"; }
ms() { python3 -c 'import time;print(time.time())'; }
el() { python3 -c "print(round(($2-$1)*1000,1))"; }

# The MAIN window's index is resolved once, by subrole — the same discrimination
# the shipped `whose` clause makes, paid once instead of per read. Everything
# below then compares the two spellings of the SAME element.
WIN=$(osascript -e 'tell application "System Events" to tell process "Things3"
  set idx to 0
  repeat with i from 1 to (count of windows)
    if (subrole of window i) is "AXStandardWindow" then set idx to i
  end repeat
  return idx
end tell' 2>/dev/null)
say "M10 windows=$(osascript -e 'tell application "System Events" to tell process "Things3" to return (count of windows)' 2>&1) subroles=$(osascript -e 'tell application "System Events" to tell process "Things3" to return (subrole of windows) as text' 2>&1 | head -c 200) → standard window index=$WIN"
[ "${WIN:-0}" -ge 1 ] || { say "FATAL: no standard window resolved"; exit 1; }

WHOSE="sheet 1 of (first window whose subrole is \"AXStandardWindow\")"
INDEXED="sheet 1 of window $WIN"
say "M0 sanity: whose→$(osascript -e "tell application \"System Events\" to tell process \"Things3\" to return (count of checkboxes of ($WHOSE))" 2>&1 | head -c 80) indexed→$(osascript -e "tell application \"System Events\" to tell process \"Things3\" to return (count of checkboxes of ($INDEXED))" 2>&1 | head -c 80)"

timed() { # timed <label> <n> <script-body>
  local s e
  s=$(ms)
  osascript >/dev/null 2>&1 <<OSA
tell application "System Events" to tell process "Things3"
$3
end tell
OSA
  e=$(ms)
  say "$1 x$2 : $(el "$s" "$e") ms"
}

# ---- M6: what the `whose` clause costs when it is paid per read -------------
timed "M6 whose-addressed read"   60 "  set sh to ($WHOSE)
  repeat 60 times
    set n to (count of checkboxes of sh)
  end repeat"
timed "M6 index-addressed read"   60 "  set sh to ($INDEXED)
  repeat 60 times
    set n to (count of checkboxes of sh)
  end repeat"
timed "M6 whose INLINE per read"  60 "  repeat 60 times
    set n to (count of checkboxes of ($WHOSE))
  end repeat"
timed "M6 detached-candidate probe" 60 "  repeat 60 times
    set n to (count of (windows whose subrole is \"AXUnknown\" and size is not {40, 40}))
  end repeat"

# ---- M7: plural vs singular over the WIDE (monthly) cadence group -----------
say "M7 group statics: $(osascript -e "tell application \"System Events\" to tell process \"Things3\" to return (value of static texts of (group 1 of ($INDEXED))) as text" 2>&1 | head -c 200)"
say "M7 group fields:  $(osascript -e "tell application \"System Events\" to tell process \"Things3\" to return (value of text fields of (group 1 of ($INDEXED))) as text" 2>&1 | head -c 200)"
say "M7 field positions: $(osascript -e "tell application \"System Events\" to tell process \"Things3\" to return (position of text fields of (group 1 of ($INDEXED))) as text" 2>&1 | head -c 200)"
timed "M7 singular scan" 20 "  set g to (group 1 of ($INDEXED))
  repeat 20 times
    set n to (count of static texts of g)
    repeat with i from 1 to n
      set sv to \"\"
      try
        set sv to (value of static text i of g) as text
      end try
    end repeat
    set m to (count of text fields of g)
    repeat with i from 1 to m
      set fp to position of text field i of g
    end repeat
  end repeat"
timed "M7 plural scan"   20 "  set g to (group 1 of ($INDEXED))
  repeat 20 times
    set sv to (value of static texts of g)
    set sp to (position of static texts of g)
    set fv to (value of text fields of g)
    set fp to (position of text fields of g)
  end repeat"
timed "M7 singular scan WHOSE" 20 "  set g to (group 1 of ($WHOSE))
  repeat 20 times
    set n to (count of static texts of g)
    repeat with i from 1 to n
      set sv to \"\"
      try
        set sv to (value of static text i of g) as text
      end try
    end repeat
    set m to (count of text fields of g)
    repeat with i from 1 to m
      set fp to position of text field i of g
    end repeat
  end repeat"
timed "M7 plural scan WHOSE"   20 "  set g to (group 1 of ($WHOSE))
  repeat 20 times
    set sv to (value of static texts of g)
    set sp to (position of static texts of g)
    set fv to (value of text fields of g)
    set fp to (position of text fields of g)
  end repeat"

# ---- M8: the shell control census, five counts vs one role list -------------
timed "M8 five counts"  30 "  set sh to ($INDEXED)
  repeat 30 times
    set a to (count of checkboxes of sh)
    set b to (count of pop up buttons of sh)
    set c to (count of buttons of sh)
    set d to (count of groups of sh)
    set e to (count of text fields of sh)
  end repeat"
timed "M8 one role list" 30 "  set sh to ($INDEXED)
  repeat 30 times
    set rs to (role of UI elements of sh)
  end repeat"
say "M8 role list: $(osascript -e "tell application \"System Events\" to tell process \"Things3\" to return (role of UI elements of ($INDEXED)) as text" 2>&1 | head -c 300)"
say "M8 counts: cb=$(osascript -e "tell application \"System Events\" to tell process \"Things3\" to return (count of checkboxes of ($INDEXED))" 2>&1 | head -c 20) pu=$(osascript -e "tell application \"System Events\" to tell process \"Things3\" to return (count of pop up buttons of ($INDEXED))" 2>&1 | head -c 20) bt=$(osascript -e "tell application \"System Events\" to tell process \"Things3\" to return (count of buttons of ($INDEXED))" 2>&1 | head -c 20) gp=$(osascript -e "tell application \"System Events\" to tell process \"Things3\" to return (count of groups of ($INDEXED))" 2>&1 | head -c 20) tf=$(osascript -e "tell application \"System Events\" to tell process \"Things3\" to return (count of text fields of ($INDEXED))" 2>&1 | head -c 20)"

# ---- M9: nesting depth ------------------------------------------------------
timed "M9 deep inline"   40 "  repeat 40 times
    set v to (value of pop up button 1 of group 1 of ($INDEXED))
  end repeat"
timed "M9 bound group"   40 "  set g to (group 1 of ($INDEXED))
  repeat 40 times
    set v to (value of pop up button 1 of g)
  end repeat"

# ---- M11: the shipped census's own probes, as they stand -------------------
timed "M11 process-frontmost probe" 40 "  repeat 40 times
    set f to (frontmost as boolean)
  end repeat"
say "calibration 2 complete"
