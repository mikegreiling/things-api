#!/bin/bash
# PERF1 — session-reachability probe before/after measurement (probe scoping).
#
# The dialog-class UI-drive preflight (SESSGATE) runs an osascript that reports
# three window counts ("AS AX ALL") to tell locked / wrong-Space / healthy apart.
# The OLD shape ALWAYS enumerates AX windows across every foreground process
# (summing allAx); the NEW shape runs that walk ONLY when Things has no AX window
# (thingsAx=0) and SHORT-CIRCUITS on the first window-bearing app. This proves the
# two shapes yield BYTE-IDENTICAL verdicts on the same live state, times both, and
# demonstrates the reachable-case walk-skip (allAx=-1, never consulted) — the exact
# path that costs ~8s on a busy real desktop and is now bypassed.
#
# METHOD: ONE disposable clone of things-lab-golden-v3 (golden untouched),
# airgapped, clock pinned. golden-v3 carries the baked L3-accessibility grant so
# osascript AX enumeration works over SSH. No CLI bundle is shipped — this measures
# the raw probe scripts only. Teardown at the end (single-VM courtesy).
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="perf1probe"
OUT="lab/artifacts/perf1-probe"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"; : > "$REPORT"
note() { echo "[perf1] $*" | tee -a "$REPORT"; }
KEEP="${KEEP:-0}"
REPS="${REPS:-7}"

FREEGB=$(df -g /Volumes/Workspace | awk 'NR==2{print $4}')
note "preflight: free ${FREEGB}GB"
[ "${FREEGB:-0}" -lt 5 ] && { note "FATAL: <5GB free. Abort."; exit 1; }

GOLDEN="${GOLDEN:-things-lab-golden-v3}"
note "cloning $GOLDEN -> $VM"
tart delete "$VM" >/dev/null 2>&1 || true
tart clone "$GOLDEN" "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300) || { note "FATAL: no SSH"; exit 1; }
note "ssh up at $IP"

cleanup() {
  if [ "$KEEP" = "1" ]; then note "KEEP=1 — leaving $VM running at $IP"; return; fi
  note "teardown: stop+delete $VM"
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
}
trap cleanup EXIT

lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true' </dev/null
AG=$(lab_ssh "$IP" 'ping -c1 -t2 1.1.1.1 >/dev/null 2>&1 && echo AIRGAP-FAIL || echo AIRGAP-OK' </dev/null)
note "airgap: $AG"
[ "$AG" = "AIRGAP-OK" ] || { note "FATAL: airgap failed"; exit 1; }
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null' </dev/null
note "clock: $(lab_ssh "$IP" 'date +%Y-%m-%dT%H:%M' </dev/null)"
GRANT=$(lab_ssh "$IP" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "SELECT auth_value FROM access WHERE service LIKE '\''%Accessibility%'\''"' </dev/null)
note "AX grant=$GRANT (want 2)"
[ "$GRANT" = "2" ] || { note "FATAL: AX grant missing"; exit 1; }
TVER=$(lab_ssh "$IP" 'defaults read /Applications/Things3.app/Contents/Info CFBundleShortVersionString' </dev/null)
MVER=$(lab_ssh "$IP" 'sw_vers -productVersion' </dev/null)

# ---------------- probe scripts on the guest ----------------
# OLD: unconditional app-wide walk, summed allAx.
lab_ssh "$IP" 'cat > ~/probe-old.applescript' <<'EOF'
set thingsAs to -1
try
	tell application "Things3" to set thingsAs to count windows
end try
set thingsAx to -1
set allAx to -1
tell application "System Events"
	try
		set thingsAx to count (windows of process "Things3")
	end try
	try
		set allAx to 0
		repeat with proc in (application processes whose background only is false)
			try
				set allAx to allAx + (count (windows of proc))
			end try
		end repeat
	end try
end tell
return ((thingsAs as integer) as text) & " " & ((thingsAx as integer) as text) & " " & ((allAx as integer) as text)
EOF
# NEW: walk gated behind thingsAx=0, short-circuit on the first window-bearing app.
lab_ssh "$IP" 'cat > ~/probe-new.applescript' <<'EOF'
set thingsAs to -1
try
	tell application "Things3" to set thingsAs to count windows
end try
set thingsAx to -1
set allAx to -1
tell application "System Events"
	try
		set thingsAx to count (windows of process "Things3")
	end try
	if thingsAx is 0 then
		try
			set allAx to 0
			repeat with proc in (application processes whose background only is false)
				try
					if (count (windows of proc)) > 0 then
						set allAx to 1
						exit repeat
					end if
				end try
			end repeat
		end try
	end if
end tell
return ((thingsAs as integer) as text) & " " & ((thingsAx as integer) as text) & " " & ((allAx as integer) as text)
EOF

# Guest-side timed runner: prints "<stdout>\t<ms>" per rep (perl HiRes, always present).
lab_ssh "$IP" 'cat > ~/timeprobe.sh && chmod +x ~/timeprobe.sh' <<'EOF'
#!/bin/bash
f="$1"; reps="$2"
for i in $(seq 1 "$reps"); do
  perl -MTime::HiRes=time -e '
    my $t0=time; my $o=`osascript "$ARGV[0]" 2>/dev/null`; my $ms=(time-$t0)*1000;
    chomp $o; printf "%s\t%.0f\n", $o, $ms;
  ' "$f"
done
EOF

warm() { lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to quit'\'' 2>&1 >/dev/null; sleep 3; open -a Things3; sleep 14; osascript -e '\''tell application "System Events" to tell process "Things3" to set value of attribute "AXEnhancedUserInterface" to false'\'' 2>/dev/null' </dev/null; }

fgcount() { lab_ssh "$IP" 'osascript -e '\''tell application "System Events" to count (application processes whose background only is false)'\''' </dev/null; }

stats() { # <tsvfile> -> "verdicts=[...] ms(min/median/max over N)=.../.../..." (portable: no gawk asort)
  local f="$1" verds ms n mn mx md
  verds=$(cut -f1 "$f" | sort | uniq -c | sed 's/^ *//' \
    | awk '{c=$1; $1=""; sub(/^ /,""); printf "%s\"%s\"x%d", (NR>1?", ":""), $0, c}')
  ms=$(cut -f2 "$f" | sort -n)
  n=$(printf '%s\n' "$ms" | grep -c .)
  mn=$(printf '%s\n' "$ms" | head -1)
  mx=$(printf '%s\n' "$ms" | tail -1)
  md=$(printf '%s\n' "$ms" | sed -n "$(((n + 1) / 2))p")
  echo "verdicts=[$verds] ms(min/median/max over $n)=$mn/$md/$mx"
}

run_pair() { # <label>
  local label="$1"
  local oldf="$OUT/${label}-old.tsv" newf="$OUT/${label}-new.tsv"
  lab_ssh "$IP" "~/timeprobe.sh ~/probe-old.applescript $REPS" </dev/null > "$oldf"
  lab_ssh "$IP" "~/timeprobe.sh ~/probe-new.applescript $REPS" </dev/null > "$newf"
  note "  OLD: $(stats "$oldf")"
  note "  NEW: $(stats "$newf")"
}

note ""; note "env: Things $TVER / macOS $MVER / $GOLDEN / clock 2026-07-05"
note "foreground app processes on this golden desktop: $(fgcount)"

note ""; note "############### STATE A: Things reachable (window open) ###############"
warm
note "state check (new probe once): $(lab_ssh "$IP" 'osascript ~/probe-new.applescript' </dev/null)"
run_pair "reachableA"

note ""; note "############### STATE B: Things windows closed (thingsAx=0 path) ###############"
lab_ssh "$IP" 'osascript -e '\''tell application "Things3" to close windows'\'' 2>/dev/null; sleep 2' </dev/null
note "state check (new probe once): $(lab_ssh "$IP" 'osascript ~/probe-new.applescript' </dev/null)"
run_pair "closedB"

note ""; note "############### PERF1 PROBE MEASUREMENT COMPLETE ###############"
note "artifacts under $OUT (report.txt, *.tsv)"
