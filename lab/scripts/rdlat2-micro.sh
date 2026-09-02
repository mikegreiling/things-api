#!/bin/bash
# RDLAT2 — the cost model's CALIBRATION, run on the guest against a LIVE Repeat
# dialog (the caller opens one before invoking this).
#
# The model this feeds is
#
#     hop wall  =  spawn  +  (Apple events x c_ae)  +  fixed in-script delays
#
# and the field prediction rescales `c_ae` by the ratio of per-RAW-AX-call cost
# between hosts (the maintainer measured ~20ms/call on his M1 against ~1.7ms
# here). So four numbers are needed, and each one is measured rather than
# assumed:
#
#   M1  osascript spawn cost                — a script that does no AX work
#   M2  cost of ONE addressed Apple event   — slope of N reads in one process
#   M3  cost of ONE raw AX call (ObjC)      — slope of N AXUIElementCopy… calls
#   M4  plural vs singular property reads   — what a batched read actually saves
#   M5  the `whose`-clause shell resolution — paid by EVERY dialog-addressed hop
#
# Every measurement is a repeat count divided out, never a single sample.
set -uo pipefail
say() { echo "  [micro] $*"; }

SHEET='sheet 1 of (first window whose subrole is "AXStandardWindow")'

# ---- M1: what one osascript process costs before it touches anything --------
t0=$(python3 -c 'import time;print(time.time())')
for _ in $(seq 1 20); do osascript -e 'return 1' >/dev/null 2>&1; done
t1=$(python3 -c 'import time;print(time.time())')
say "M1 osascript spawn (no AX): $(python3 -c "print(round(($t1-$t0)*1000/20,1))") ms/process (20 reps)"

# ---- M2: the per-Apple-event cost against the open Repeat dialog ------------
# One process, N addressed reads of the same element. The intercept is the
# process + the one `whose` resolution; the SLOPE is the per-event cost.
ae_run() { # ae_run <n>
  osascript <<OSA 2>/dev/null
set t0 to (current date)
tell application "System Events" to tell process "Things3"
  set sh to ($SHEET)
  set acc to 0
  repeat $1 times
    set acc to acc + (count of checkboxes of sh)
  end repeat
end tell
return (round (((current date) - t0) * 1000))
OSA
}
for n in 1 25 100 250; do
  # `current date` has 1s granularity, so time the WHOLE process from the shell.
  s=$(python3 -c 'import time;print(time.time())')
  ae_run "$n" >/dev/null
  e=$(python3 -c 'import time;print(time.time())')
  say "M2 n=$n : $(python3 -c "print(round(($e-$s)*1000,1))") ms total"
done

# ---- M3: the per-RAW-AX-call cost through the ObjC bridge -------------------
# The unit the field measured. Same shape: N calls in one process, timed from
# the shell, so the slope is the per-call cost.
ax_run() { # ax_run <n>
  osascript -l JavaScript <<OSA 2>/dev/null
ObjC.import('Foundation'); ObjC.import('ApplicationServices');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId(); }
function attr(el,name){ var out=Ref(); if(\$.AXUIElementCopyAttributeValue(el,\$(name),out)!==0) return null; return ObjC.castRefToObject(out[0]); }
var app = \$.AXUIElementCreateApplication(pidOf('Things3'));
var acc = 0;
for (var i=0;i<$1;i++){ var v = attr(app,'AXRole'); if(v) acc++; }
acc;
OSA
}
for n in 1 50 250 1000; do
  s=$(python3 -c 'import time;print(time.time())')
  ax_run "$n" >/dev/null
  e=$(python3 -c 'import time;print(time.time())')
  say "M3 n=$n : $(python3 -c "print(round(($e-$s)*1000,1))") ms total"
done

# ---- M4: plural vs singular property reads over the cadence group ----------
# The single change with the largest call-count leverage: AppleScript answers
# `value of static texts of g` in ONE event and `value of static text i of g`
# in one event PER CONTROL.
GRP="group 1 of ($SHEET)"
sing() {
  osascript <<OSA 2>/dev/null
tell application "System Events" to tell process "Things3"
  set g to ($GRP)
  repeat $1 times
    set n to (count of static texts of g)
    repeat with i from 1 to n
      set sv to ""
      try
        set sv to (value of static text i of g) as text
      end try
    end repeat
    set m to (count of text fields of g)
    repeat with i from 1 to m
      set fp to position of text field i of g
    end repeat
  end repeat
end tell
return "ok"
OSA
}
plur() {
  osascript <<OSA 2>/dev/null
tell application "System Events" to tell process "Things3"
  set g to ($GRP)
  repeat $1 times
    set sv to (value of static texts of g)
    set sp to (position of static texts of g)
    set fv to (value of text fields of g)
    set fp to (position of text fields of g)
  end repeat
end tell
return "ok"
OSA
}
for rounds in 10 40; do
  s=$(python3 -c 'import time;print(time.time())'); sing "$rounds" >/dev/null; e=$(python3 -c 'import time;print(time.time())')
  say "M4 singular scan x$rounds : $(python3 -c "print(round(($e-$s)*1000,1))") ms"
  s=$(python3 -c 'import time;print(time.time())'); plur "$rounds" >/dev/null; e=$(python3 -c 'import time;print(time.time())')
  say "M4 plural   scan x$rounds : $(python3 -c "print(round(($e-$s)*1000,1))") ms"
done
say "M4 plural readback sanity: $(osascript -e "tell application \"System Events\" to tell process \"Things3\" to return (value of static texts of ($GRP)) as text" 2>&1 | head -c 200)"

# ---- M5: the `whose`-clause shell resolution, paid per dialog-addressed hop -
whose_run() {
  osascript <<OSA 2>/dev/null
tell application "System Events" to tell process "Things3"
  repeat $1 times
    set sh to ($SHEET)
  end repeat
end tell
return "ok"
OSA
}
for n in 10 50; do
  s=$(python3 -c 'import time;print(time.time())'); whose_run "$n" >/dev/null; e=$(python3 -c 'import time;print(time.time())')
  say "M5 whose-resolution x$n : $(python3 -c "print(round(($e-$s)*1000,1))") ms"
done
say "calibration complete"
