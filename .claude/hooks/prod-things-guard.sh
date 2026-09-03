#!/usr/bin/env bash
# PreToolUse guard (Bash tool): no agent writes to, drives the GUI of, or sends
# AppleEvents/keystrokes/pointer events to the maintainer's PRODUCTION Things on
# this host — and no agent changes the installed helpers — without the
# maintainer's explicit, time-boxed sanction (scripts/sanction-prod.sh, run by
# him in his own terminal). Lab/VM commands pass. Reads pass. Over-blocking is
# the correct fail direction: a refused command is reported, never worked around.
#
# Exit 2 + stderr = block (the reason is fed back to the agent). Exit 0 = allow.
set -u
SANCTION="${HOME}/.local/state/things-api/prod-sanction"

cmd="$(python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print(""); sys.exit(0)
ti=d.get("tool_input") or {}
print(ti.get("command","") if isinstance(ti,dict) else "")' 2>/dev/null || true)"
[ -z "$cmd" ] && exit 0

deny() {
  if [ -f "$SANCTION" ]; then
    exp="$(awk 'NR==1{print $1}' "$SANCTION" 2>/dev/null || echo 0)"
    now="$(date +%s)"
    if [ "${exp:-0}" -gt "$now" ] 2>/dev/null; then
      exit 0   # maintainer's sanction is live
    fi
  fi
  printf 'BLOCKED by .claude/hooks/prod-things-guard.sh: %s\nThis command would touch the maintainer'"'"'s PRODUCTION Things (or the installed helpers) on this host. Agents may only READ production. Do not rephrase to get past this — stop, report the refused command, and let the maintainer run it himself or grant a time-boxed sanction with scripts/sanction-prod.sh in HIS terminal. Lab work belongs in a Tart clone.\n' "$1" >&2
  exit 2
}

# 1. Self-sanction attempts.
case "$cmd" in
  *sanction-prod*|*prod-sanction*) deny "attempt to create or edit the production sanction" ;;
esac

# 2. Lab/VM-targeted commands pass (the guest CLI is not production).
if printf '%s' "$cmd" | grep -Eq '(^|[^A-Za-z0-9_-])(tart|ssh|scp)([[:space:]]|$)|lab/scripts/|lab/guest|npm run lab|lab_'; then
  exit 0
fi

# 2b. Signalling / unloading the installed helper (launchd job or process).
if printf '%s' "$cmd" | grep -Eq '(launchctl[[:space:]]+(kickstart|bootout|unload|kill|stop|remove)|pkill|killall|kill[[:space:]]).*(things-deputy|Things API Helper|deputy)'; then
  deny "signalling or unloading the installed helper"
fi

# 2c. The live deputy test suite. A child deputy built from source carries the
#     SAME signing identity as the installed helper, so TCC hands it the same
#     Accessibility grant: a test that "just asks the deputy" can reach the real
#     Things app (DEPOBS1, 2026-09-03 — an observer-start registered against the
#     maintainer's running Things). Live-deputy runs are production interaction.
if printf '%s' "$cmd" | grep -Eq 'THINGS_DEPUTY_LIVE'; then
  deny "live deputy suite: a source-built child deputy inherits the installed helper's Accessibility grant"
fi

# 3. Raw URL-scheme opens against the production app.
if printf '%s' "$cmd" | grep -Eq 'things://'; then
  deny "raw things:/// URL against production"
fi

# Strip quoted strings so search terms / commit messages cannot false-match.
stripped="$(printf '%s' "$cmd" | sed -E 's/"[^"]*"//g; s/'"'"'[^'"'"']*'"'"'//g')"

# 4. Direct GUI / AppleEvent interaction with the production app.
if printf '%s' "$stripped" | grep -Eq '(^|[^A-Za-z0-9_-])osascript([[:space:]]|$)' \
   && printf '%s' "$cmd" | grep -Eq 'Things3|Things([^A-Za-z]|$)|System Events|CGEvent|AXUIElement'; then
  deny "osascript against the production Things app / System Events"
fi

# 5. The things CLI (npm-linked, temp-prefix install, or the source/dist entry)
#    invoked with a WRITE verb, a GUI drive, or a host-state change.
if printf '%s' "$stripped" | grep -Eq '(^|[^A-Za-z0-9_./-])things([[:space:]]|$)|/bin/things([[:space:]]|$)|dist/cli/index\.js|src/cli/index\.ts'; then
  if printf '%s' "$stripped" | grep -Eq -- '--dangerously-drive-gui|(^|[[:space:]])(add|add-heading|add-repeating|archive-heading|batch|cancel|checklist|clear-reminder|clone|complete|delete|dismiss|dissolve-heading|duplicate|empty|make-repeating|move|move-heading|move-heading-to-project|promote-heading|relaunch|rename-heading|reopen|reorder|reschedule-repeat|rescue|restart|restore|undo|unarchive-heading|update|log-now|open|setup)([[:space:]]|$)|config[[:space:]]+set|helpers[[:space:]]+(install|uninstall|enable|disable|update|restart)'; then
    deny "things CLI write / GUI drive / host-state change against production"
  fi
fi

exit 0
