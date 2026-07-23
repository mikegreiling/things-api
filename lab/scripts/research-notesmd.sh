#!/bin/bash
# NOTESMD — what markdown does the Things notes field render? (up-next §6 NOTESMD)
# Offline single clone, pinned clock. Seeds ONE to-do + ONE project with the same
# full-vocabulary synthetic markdown note, opens each card, screenshots the render.
# Verdict table + findings: docs/lab/notesmd-results.md.
#
# Card-open note: vncdo has no double-click primitive; a slow two-click just
# re-selects. A rapid `click 1 click 1` (no pause) in ONE invocation opens the card.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
VNCDO="${VNCDO:-}"; GOLDEN="${GOLDEN:-things-lab-golden-v1}"; PIN="${PIN:-070512002026}"
RUN="things-run-notesmd-$(date +%Y%m%d-%H%M%S)"; OUT="lab/artifacts/$RUN"; mkdir -p "$OUT"
note(){ echo "[notesmd] $*"; }
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

V(){ local url hp s p; url=$(cat "$OUT/vnc.txt"); hp=${url#vnc://}; hp=${hp##*@}
  s="${hp%%:*}::${hp##*:}"; p=$(echo "$url" | sed -n 's|vnc://[^:]*:\([^@]*\)@.*|\1|p')
  perl -e 'alarm 45; exec @ARGV' "$VNCDO" -s "$s" ${p:+-p "$p"} "$@" 2>>"$OUT/vnc.log" || true; }

# full-vocabulary synthetic note
lab_ssh "$IP" 'cat > /tmp/note.md' <<'NOTE'
# Heading One
## Heading Two
_underscore italic_ and *asterisk italic*
**double-star bold** and __double-underscore bold__
Bare URL: https://example.com/page
Labeled: [Example Label](https://example.com/page)
Angle: <https://example.com/page>
- unordered dash one
- unordered dash two
  - nested dash child
* asterisk bullet
1. ordered one
2. ordered two
   1. nested ordered child
`inline code span` here
```
fenced code block line 1
fenced code block line 2
```
> blockquote line
---
- [ ] unchecked checkbox
- [x] checked checkbox
Hard break above (two spaces)
next line after hard break
NOTE
lab_ssh "$IP" 'N=$(python3 -c "import urllib.parse;print(urllib.parse.quote(open(\"/tmp/note.md\").read()))"); open -g "things:///add?title=NOTESMD-TODO&notes=$N"; sleep 3' </dev/null
lab_ssh "$IP" 'N=$(python3 -c "import urllib.parse;print(urllib.parse.quote(open(\"/tmp/note.md\").read()))"); open -g "things:///add-project?title=NOTESMD-PROJECT&notes=$N"; sleep 3' </dev/null

TODO=$(lab_ssh "$IP" "/tmp/gsql.sh -q \"SELECT uuid FROM TMTask WHERE title='NOTESMD-TODO'\"" </dev/null)
PROJ=$(lab_ssh "$IP" "/tmp/gsql.sh -q \"SELECT uuid FROM TMTask WHERE title='NOTESMD-PROJECT'\"" </dev/null)
# reveal + open the to-do card (Inbox row ~843,317; rapid double-click)
lab_ssh "$IP" "open -g 'things:///show?id=$TODO'; sleep 3" </dev/null
V move 843 317 click 1 click 1; sleep 2; V capture "$OUT/nm-todo-card.png"; note "shot nm-todo-card.png"
# project note renders in the project header
lab_ssh "$IP" "open -g 'things:///show?id=$PROJ'; sleep 3" </dev/null
V capture "$OUT/nm-project.png"; note "shot nm-project.png"
note "GREEN — artifacts in $OUT ; verdict table in docs/lab/notesmd-results.md"
