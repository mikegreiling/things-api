#!/usr/bin/env bash
# PreToolUse guard (Bash tool). Maintainer's law (2026-09-03): ALL AUTOMATED
# TESTING RUNS IN A GUEST OS IN THE VM. Nothing non-read-only touches his
# PRODUCTION Things unless he is LIVE-DEBUGGING with the agent in real time and
# asked for it in that conversation. Automated regression tests, release smokes,
# probes and measurements against production are NEVER run and NOT sanctionable.
#
# So this hook refuses, for every agent in the session: host-side `things` write
# verbs, GUI drives, config/helpers changes, osascript at Things3 / System Events,
# raw things:// opens, launchctl/pkill at the deputy, and the live deputy suite.
# Tart/ssh lab commands pass. Reads pass.
#
# The ONLY release: the maintainer, in HIS OWN terminal, runs
#     touch ~/.local/state/things-api/live-debugging
# while he is live-debugging with the agent. It is honoured for 2 hours from its
# mtime, and any agent command that names that file is refused, so an agent can
# never create it. It is for live debugging ONLY — never for tests.
#
# Exit 2 + stderr = block (the reason is fed back to the agent). Exit 0 = allow.
set -u
LIVE="${HOME}/.local/state/things-api/live-debugging"

cmd="$(python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print(""); sys.exit(0)
ti=d.get("tool_input") or {}
print(ti.get("command","") if isinstance(ti,dict) else "")' 2>/dev/null || true)"
[ -z "$cmd" ] && exit 0

deny() {
  if [ -f "$LIVE" ]; then
    age=$(( $(date +%s) - $(stat -f %m "$LIVE" 2>/dev/null || echo 0) ))
    if [ "$age" -ge 0 ] && [ "$age" -lt 7200 ]; then
      exit 0   # the maintainer is live-debugging with the agent (marker < 2 h old)
    fi
  fi
  printf 'BLOCKED by .claude/hooks/prod-things-guard.sh: %s\nThis command would touch the maintainer'"'"'s PRODUCTION Things (or the installed helpers) on this host. Agents only READ production. ALL automated testing runs in the Tart guest (with the helpers installed there). Do not rephrase to get past this — stop and report the refused command. The only release is the maintainer live-debugging with you in real time, in which case HE creates the live-debugging marker from his own terminal.\n' "$1" >&2
  exit 2
}

# 1. An agent may never create the live-debugging marker.
case "$cmd" in
  *live-debugging*) deny "attempt to create or touch the live-debugging marker" ;;
esac

# 2. Lab/VM-targeted commands pass (the guest CLI is not production).
if printf '%s' "$cmd" | grep -Eq '(^|[^A-Za-z0-9_-])(tart|ssh|scp)([[:space:]]|$)|lab/scripts/|lab/guest|npm run lab|lab_'; then
  exit 0
fi

# 2b. Signalling / unloading the installed helper (launchd job or process).
#     The signalling tool must sit at COMMAND POSITION (start of the command or
#     of a ; && || | ( segment, optionally after sudo), so prose inside a quoted
#     commit message cannot trip it (a delegate's `git commit -m "... a kill
#     timer the deputy owns"` was refused, 2026-09-03). Matched on the RAW
#     command because the helper's name is usually quoted.
if printf '%s' "$cmd" | grep -Eq '(^|[;&|(`][[:space:]]*)(sudo[[:space:]]+)?(launchctl[[:space:]]+(kickstart|bootout|unload|kill|stop|remove)|pkill|killall|kill)[[:space:]][^;&|]*(things-deputy|Things API Helper|deputy)'; then
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
