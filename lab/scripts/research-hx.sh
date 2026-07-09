#!/bin/bash
# HX — heading-create escape hatch: relocation + direct-create probes (Mike,
# 2026-07-09). ONE clone.
#
# Premise (Mike): if a heading can be RELOCATED across projects, heading.create
# composes without Shortcuts — TJSON-create an ephemeral project WITH the
# heading, move the heading into the target, trash the ephemeral. The "move is
# dead on four surfaces" verdict has holes: scf P2 was a TEXT-uuid Shortcuts
# probe (P2b later proved text→entity coercion silently fails), P11b's
# `move … to list "Trash"` got error 301 — meaning `move` RESOLVES a heading
# subject and failed on the DESTINATION — and `move … to project id` was
# never tried. AS `duplicate` and TJSON heading shapes are unprobed entirely.
#   HX0   Premise check: things:///json creates a NEW project with a heading
#         item (type=2 row present?). Everything below depends on this.
#   HX1   TJSON TOP-LEVEL heading item with list-id → EXISTING project
#         (direct create, no ephemeral needed — the jackpot shape).
#   HX1b  TJSON project UPDATE (auth) with items:[heading] — does update
#         append items? (docs say update ignores items; never probed here.)
#   HX2   AS `move to do id <H> to project id <TGT>` — childless heading.
#   HX2b  … `to list id <TGT>` spelling if HX2 errors.
#   HX2c  if a move works: repeat with a heading that HAS a child — do
#         children follow?
#   HX3   AS `duplicate to do id <H> to project id <TGT>` (copy ≈ create).
#   HX4   TJSON to-do UPDATE (auth) on a heading uuid, attributes list-id
#         (and a {"type":"heading"} spelling variant).
# Discovery: no assertions.
set -euo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="things-run-hx-$(date +%Y%m%d-%H%M%S)"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
REPORT="$OUT/report.txt"
note() { echo "[hx] $*" | tee -a "$REPORT"; }
cleanup() { echo "[hx] teardown: $VM"; tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT

note "cloning golden -> $VM"
tart clone things-lab-golden-v1 "$VM"
(tart run "$VM" --no-graphics >"$OUT/tart-run.log" 2>&1 &)
IP=$(lab_wait_for_ssh "$VM" 300)
note "ssh up at $IP"
lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true'
lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null'
lab_ssh "$IP" 'cat > /tmp/gsql.sh && chmod +x /tmp/gsql.sh' <<'EOF'
#!/bin/bash
FMT=(-header -column); if [ "$1" = "-q" ]; then FMT=(-noheader -list); shift; fi
DB=$(echo ~/Library/Group\ Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things\ Database.thingsdatabase/main.sqlite)
exec sqlite3 "${FMT[@]}" "file:$DB?mode=ro" "$1"
EOF
gsql() { lab_ssh "$IP" "/tmp/gsql.sh $(printf '%q' "$1")"; }
gq() { lab_ssh "$IP" "/tmp/gsql.sh -q $(printf '%q' "$1")"; }
gas() { note "-- osascript: $1"; lab_ssh "$IP" "osascript -e $(printf '%q' "$1") 2>&1" | tee -a "$REPORT" || true; sleep 1; }
gurl() { lab_ssh "$IP" "open -g $(printf '%q' "$1")"; sleep 2; }
gjson() { # $1 = raw json array (host-side), $2 = "auth" to attach token
  local url
  url=$(python3 -c 'import sys, urllib.parse; print("things:///json?" + (("auth-token=" + sys.argv[2] + "&") if len(sys.argv) > 2 else "") + "data=" + urllib.parse.quote(sys.argv[1], safe=""))' "$1" ${2:+"$TOKEN"})
  note "-- json url: ${url:0:140}…"
  gurl "$url"
}
uuid_of() { local t="$1" typ="${2:-}" w="title='$1' AND trashed=0" u i; [ -n "$typ" ] && w="$w AND type=$typ"; for i in $(seq 1 12); do u=$(gq "SELECT uuid FROM TMTask WHERE $w ORDER BY creationDate DESC LIMIT 1"); [ -n "$u" ] && { echo "$u"; return 0; }; sleep 1; done; return 1; }

note "warm-up: launch Things"
lab_ssh "$IP" 'open -g -a Things3; sleep 12'
TOKEN=$(gq "SELECT uriSchemeAuthenticationToken FROM TMSettings LIMIT 1")
note "auth token in hand (${#TOKEN} chars)"

note "== fixtures: target project HX-TARGET =="
gurl "things:///add-project?title=HX-TARGET"
TGT=$(uuid_of "HX-TARGET" 1)
note "target: $TGT"
state() { gsql "SELECT title, type, status, trashed, project, heading, area FROM TMTask WHERE title LIKE 'HX-%' ORDER BY type DESC, title" | tee -a "$REPORT"; }

# ============================== HX0 — premise: json project WITH heading
note "== [HX0] json create: NEW project with heading + child =="
gjson '[{"type":"project","attributes":{"title":"HX-EPHEMERAL","items":[{"type":"heading","attributes":{"title":"HX-HEAD-1"}},{"type":"to-do","attributes":{"title":"HX-CHILD-1"}}]}}]'
EPH=$(uuid_of "HX-EPHEMERAL" 1 || true)
H1=$(uuid_of "HX-HEAD-1" 2 || true)
note "-- ephemeral=$EPH heading=$H1 (empty heading uuid = PREMISE DEAD):"
state

# ============================== HX1 — top-level heading item, list-id
note "== [HX1] json create: TOP-LEVEL heading with list-id=TARGET (direct create) =="
gjson "[{\"type\":\"heading\",\"attributes\":{\"title\":\"HX-DIRECT\",\"list-id\":\"$TGT\"}}]"
note "-- post (HX-DIRECT type=2 row under target = JACKPOT):"
state

# ============================== HX1b — project update, items append
note "== [HX1b] json UPDATE on TARGET with items:[heading] (append semantics?) =="
gjson "[{\"type\":\"project\",\"operation\":\"update\",\"id\":\"$TGT\",\"attributes\":{\"items\":[{\"type\":\"heading\",\"attributes\":{\"title\":\"HX-APPEND\"}}]}}]" auth
note "-- post (HX-APPEND anywhere?):"
state

# ============================== HX2 — AS move, childless heading
if [ -n "${H1:-}" ]; then
  note "== [HX2] AS move heading -> project id (childless) =="
  gas "tell application \"Things3\" to move to do id \"$H1\" to project id \"$TGT\""
  note "-- post (HX-HEAD-1.project == $TGT = RELOCATION WORKS):"
  state
  H1_PROJ=$(gq "SELECT project FROM TMTask WHERE uuid='$H1'")
  if [ "$H1_PROJ" != "$TGT" ]; then
    note "== [HX2b] AS move heading -> list id spelling =="
    gas "tell application \"Things3\" to move to do id \"$H1\" to list id \"$TGT\""
    note "-- post:"; state
    H1_PROJ=$(gq "SELECT project FROM TMTask WHERE uuid='$H1'")
  fi
  if [ "$H1_PROJ" = "$TGT" ]; then
    note "== [HX2c] move a heading WITH a child (children follow?) =="
    gjson '[{"type":"project","attributes":{"title":"HX-EPHEMERAL-2","items":[{"type":"heading","attributes":{"title":"HX-HEAD-2"}},{"type":"to-do","attributes":{"title":"HX-CHILD-2"}}]}}]'
    H2=$(uuid_of "HX-HEAD-2" 2 || true)
    C2=$(uuid_of "HX-CHILD-2" 0 || true)
    note "-- pre: child HX-CHILD-2 heading=$(gq "SELECT heading FROM TMTask WHERE uuid='$C2'")"
    gas "tell application \"Things3\" to move to do id \"$H2\" to project id \"$TGT\""
    note "-- post (heading moved? child project/heading links?):"
    state
  fi

  # ============================== HX3 — AS duplicate
  note "== [HX3] AS duplicate heading -> target project =="
  gas "tell application \"Things3\" to duplicate to do id \"$H1\" to project id \"$TGT\""
  note "-- post (a SECOND HX-HEAD-1 row in target = copy-create works):"
  gsql "SELECT uuid, title, type, project FROM TMTask WHERE title='HX-HEAD-1'" | tee -a "$REPORT"

  # ============================== HX4 — TJSON update on heading uuid
  note "== [HX4] json UPDATE (to-do spelling) on heading uuid, list-id=TARGET =="
  gjson "[{\"type\":\"to-do\",\"operation\":\"update\",\"id\":\"$H1\",\"attributes\":{\"list-id\":\"$TGT\"}}]" auth
  note "-- post:"; state
  note "== [HX4b] json UPDATE ({\"type\":\"heading\"} spelling) =="
  gjson "[{\"type\":\"heading\",\"operation\":\"update\",\"id\":\"$H1\",\"attributes\":{\"list-id\":\"$TGT\"}}]" auth
  note "-- post:"; state
fi

note "== final full state + app alive check =="
state
lab_ssh "$IP" 'pgrep -x Things3 >/dev/null && echo "Things3 ALIVE" || echo "Things3 DEAD (crash?)"' | tee -a "$REPORT"
note "DONE. Report: $REPORT"
