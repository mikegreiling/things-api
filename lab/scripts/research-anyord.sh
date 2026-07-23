#!/bin/bash
# ANYORD — settle the Anytime aggregate-reorder wire convention (up-next §0 item 4).
# Offline single clone, pinned clock. Seeds loose anytime to-dos across 2 areas +
# area-less, then probes `_private_experimental_ reorder to dos in list "Anytime"`.
# VERDICT: no operable convention — the aggregate reorder is DESTRUCTIVE (strips
# area membership) AND non-deterministic (repeated identical calls never converge).
# The clean path is the CONTAINER (area) specifier. Full write-up + semantics map:
# docs/lab/anyord-results.md.
#
# The `with ids` parameter takes a COMMA-SEPARATED STRING, not an AppleScript list:
#   ... reorder to dos in list "Anytime" with ids "uuid1,uuid2,uuid3"
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"; GOLDEN="${GOLDEN:-things-lab-golden-v1}"; PIN="${PIN:-070512002026}"
RUN="things-run-anyord-$(date +%Y%m%d-%H%M%S)"; OUT="lab/artifacts/$RUN"; mkdir -p "$OUT"
note(){ echo "[anyord] $*"; }
GSQL='#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"'

tart clone "$GOLDEN" "$RUN-c"; trap 'tart stop "$RUN-c" >/dev/null 2>&1; tart delete "$RUN-c" >/dev/null 2>&1' EXIT
(tart run "$RUN-c" --no-graphics --vnc-experimental >"$OUT/tart-run.log" 2>&1 &); sleep 3
IP=$(lab_wait_for_ssh "$RUN-c" 300); note "ip=$IP"
grep -o 'vnc://[^ ]*' "$OUT/tart-run.log" | head -1 > "$OUT/vnc.txt"
lab_ssh "$IP" "sudo route -n delete default >/dev/null 2>&1; sudo route -n delete -inet6 default >/dev/null 2>&1; sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date $PIN >/dev/null" </dev/null
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<<"$GSQL"
lab_ssh "$IP" 'open -g -a Things3; sleep 12' </dev/null

q(){ lab_ssh "$IP" "$1" </dev/null; }
uid(){ q "/tmp/gsql.sh -q \"SELECT uuid FROM TMTask WHERE title='$1'\""; }
areaid(){ q "/tmp/gsql.sh -q \"SELECT uuid FROM TMArea WHERE title='$1'\""; }
reord_list(){ q "osascript -e 'tell application \"Things3\" to _private_experimental_ reorder to dos in list \"Anytime\" with ids \"$1\"'"; sleep 2; }
reord_area(){ q "osascript -e 'tell application \"Things3\" to _private_experimental_ reorder to dos in area \"$1\" with ids \"$2\"'"; sleep 2; }
dump(){ q "/tmp/gsql.sh -q \"SELECT title||' area='||COALESCE(substr(area,1,8),'NULL')||' idx='||\\\"index\\\" FROM TMTask WHERE title LIKE '$1' ORDER BY \\\"index\\\"\""; }

AA=$(areaid LAB-AREA-A); AB=$(areaid LAB-AREA-B)
for t in AO-A1 AO-A2 AO-A3; do q "open -g 'things:///add?title=$t&when=anytime&list-id=$AA'; sleep 1"; done
for t in AO-B1 AO-B2; do q "open -g 'things:///add?title=$t&when=anytime&list-id=$AB'; sleep 1"; done
for t in AO-X1 AO-X2; do q "open -g 'things:///add?title=$t&when=anytime'; sleep 1"; done
sleep 2
A1=$(uid AO-A1); A2=$(uid AO-A2); A3=$(uid AO-A3); B1=$(uid AO-B1); B2=$(uid AO-B2)

# baseline grouped GUI view
q "open -g 'things:///show?id=anytime'; sleep 2"
V(){ local url hp s p; url=$(cat "$OUT/vnc.txt"); hp=${url#vnc://}; hp=${hp##*@}
  s="${hp%%:*}::${hp##*:}"; p=$(echo "$url" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
  perl -e 'alarm 45; exec @ARGV' "$VNCDO" -s "$s" ${p:+-p "$p"} "$@" 2>>"$OUT/vnc.log" || true; }
[ -n "$VNCDO" ] && V capture "$OUT/ao-01-anytime-baseline.png"

note "== non-determinism: send identical request A1,A2,A3 five times (never converges) =="
for i in 1 2 3 4 5; do reord_list "$A1,$A2,$A3"; note "  call $i: $(dump 'AO-A%' | tr '\n' ' ')"; done

note "== DESTRUCTIVE area-strip: single reorder of the pristine AO-B pair =="
note "  before: $(dump 'AO-B%' | tr '\n' ' ')"
reord_list "$B1,$B2"
note "  after (area NULL?): $(dump 'AO-B%' | tr '\n' ' ')"

note "== CONTROL: container (area) specifier is deterministic + area-preserving =="
for t in AC-1 AC-2 AC-3; do q "open -g 'things:///add?title=$t&when=anytime&list-id=$AA'; sleep 1"; done
sleep 2; C1=$(uid AC-1); C2=$(uid AC-2); C3=$(uid AC-3)
reord_area LAB-AREA-A "$C1,$C2,$C3"; note "  C1,C2,C3 -> $(dump 'AC-%' | tr '\n' ' ')"
reord_area LAB-AREA-A "$C1,$C2,$C3"; note "  repeat   -> $(dump 'AC-%' | tr '\n' ' ')"
reord_area LAB-AREA-A "$C3,$C1,$C2"; note "  C3,C1,C2 -> $(dump 'AC-%' | tr '\n' ' ')"
[ -n "$VNCDO" ] && { q "open -g 'things:///show?id=anytime'; sleep 2"; V capture "$OUT/ao-02-areaA-gui.png"; }
note "GREEN — verdict + semantics map in docs/lab/anyord-results.md ; artifacts in $OUT"
