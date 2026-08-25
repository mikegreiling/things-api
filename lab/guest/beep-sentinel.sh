#!/bin/bash
# THE BEEP SENTINEL — a macOS alert beep is a FAILURE STATE for lab automation.
#
# A beep means the app was sent a gesture it declined to handle (BEEP1: a ⌘A
# swallowed by a disabled menu item; a keystroke landing on a control that was
# mid-rebuild). The drive can still "succeed" — the value lands, the probe goes
# green — while the user hears an error tone. So every lab suite counts beeps
# and a nonzero count is red, exactly like a failed assertion.
#
# THE ORACLE (BEEP1 §1, validated positively, muted AND unmuted, golden-v4):
# `systemsoundserverd` logs exactly one
#     SSServerImp.cpp:733  -> Incoming Request : actionID 4096
# per system-sound play request. Three deliberate `osascript -e beep` calls read
# exactly 3; a matched quiet control reads 0. Crucially it is NOT blinded by
# `lab_mute_guest` (every clone-boot path mutes) — a muted guest logs the full
# request and adds `SSServerImp.cpp:774  Device is currently muted` beside it.
# The predicate must be process/subsystem-scoped: the app never plays its own
# alert, it asks systemsoundserverd to, so `process == "Things3"` matches
# nothing.
#
# POST-HOC, NEVER A LIVE LISTENER. BEEP1's rig ran `log stream` in the
# background; the harness must not, because a detached listener can be orphaned
# by any abort. Instead: `mark` stamps the guest clock, and `assert` reads the
# window back out of the already-written unified log with `log show`. Nothing
# runs between the two.
#
#   beep-sentinel.sh reset                       # drop marks from a prior run
#   beep-sentinel.sh mark <label>                # stamp; the FIRST mark opens the window
#   beep-sentinel.sh assert [--allow N] [--json PATH] [--name NAME]
#
# `assert` counts every beep since the first mark and attributes each one to the
# most recent mark at or before it, so the output names the step that beeped and
# prints the matched log line. Exit 0 = clean, 1 = unallowed beeps, 2 = the
# oracle itself failed (no marks, `log show` error) — fail closed.
#
# OPT-OUT (probe/research drivers only): THINGS_LAB_BEEPS_OK=1 makes `assert`
# report-only. It NEVER silences the accounting — the count still prints. Probes
# are exempt from failing, not from counting. Test suites never set it.
set -u

BEEP_MARKS="${BEEP_MARKS:-$HOME/things-lab/run/beep-marks.tsv}"

# Deliberately narrow: the 1:1 signature BEEP1 validated is `systemsoundserverd`
# logging SSServerImp.cpp:733 with actionID 4096 (the play-alert action; it is
# the action id, not the chosen sound, so it holds whatever alert sound is set).
# Other actionIDs on the same line are other system sounds — real, but not the
# alert beep this sentinel is about.
BEEP_PREDICATE='process == "systemsoundserverd"'
BEEP_SIGNATURE='SSServerImp.cpp:733'
BEEP_ACTION='actionID 4096'

usage() {
  echo "usage: beep-sentinel.sh reset | mark <label> | assert [--allow N] [--json PATH] [--name NAME]" >&2
  exit 2
}

cmd_reset() {
  mkdir -p "$(dirname "$BEEP_MARKS")" 2>/dev/null
  : >"$BEEP_MARKS"
}

cmd_mark() {
  local label="${1:-unlabelled}"
  mkdir -p "$(dirname "$BEEP_MARKS")" 2>/dev/null
  # epoch <TAB> "YYYY-MM-DD HH:MM:SS" <TAB> label   (log show's --start format)
  printf '%s\t%s\t%s\n' "$(date +%s)" "$(date '+%Y-%m-%d %H:%M:%S')" "$label" >>"$BEEP_MARKS"
}

cmd_assert() {
  local allow=0 json="" name="run"
  while [ $# -gt 0 ]; do
    case "$1" in
      --allow) allow="${2:-0}"; shift 2 ;;
      --json) json="${2:-}"; shift 2 ;;
      --name) name="${2:-run}"; shift 2 ;;
      *) usage ;;
    esac
  done

  local optout=0
  [ "${THINGS_LAB_BEEPS_OK:-}" = "1" ] && optout=1

  if [ ! -s "$BEEP_MARKS" ]; then
    echo "BEEP-SENTINEL [$name]: ORACLE FAIL — no marks recorded ($BEEP_MARKS); nothing was measured"
    return 2
  fi

  # Flush margin: the unified log is written asynchronously, so a beep from the
  # last gesture can land in the store a moment after the gesture returns. This
  # is log-store settling, not a UI timing dependency.
  sleep 2

  local start until_epoch boot out err code
  start="$(head -n1 "$BEEP_MARKS" | cut -f2)"
  until_epoch="$(date +%s)"
  boot="$(sysctl -n kern.bootsessionuuid 2>/dev/null)"
  out="$(mktemp -t beep-sentinel)"
  err="$(mktemp -t beep-sentinel-err)"

  # --info: the play-request line is an info-level message, so the default
  # (default/error/fault only) `log show` would show nothing.
  #
  # `--start` is a CHEAP PREFILTER ONLY — never the window. A lab clone's log
  # store carries entries from the golden's EARLIER boots, and because every
  # clone pins its clock to the same date those entries are stamped with times
  # that fall in (or straddle) this run's window; `log show`'s own time bounds
  # do not exclude them (measured BEEPSEN1: `--last 30m` and an explicit
  # `--start/--end` pair both returned three beeps from a boot months earlier).
  # The window is applied below, against the marks, and every record is pinned
  # to the CURRENT boot session by bootUUID.
  if ! log show --style ndjson --info \
    --start "$start" \
    --predicate "$BEEP_PREDICATE" >"$out" 2>"$err"; then
    echo "BEEP-SENTINEL [$name]: ORACLE FAIL — log show exited nonzero:"
    sed 's/^/    /' <"$err"
    rm -f "$out" "$err"
    return 2
  fi

  BEEP_NAME="$name" BEEP_ALLOW="$allow" BEEP_OPTOUT="$optout" BEEP_JSON="$json" \
    BEEP_SIG="$BEEP_SIGNATURE" BEEP_ACT="$BEEP_ACTION" BEEP_LOG="$out" \
    BEEP_MARKS="$BEEP_MARKS" BEEP_BOOT="$boot" BEEP_UNTIL="$until_epoch" \
    python3 - <<'PYEOF'
import json, os, re, sys, time

name = os.environ["BEEP_NAME"]
allow = int(os.environ["BEEP_ALLOW"] or 0)
optout = os.environ["BEEP_OPTOUT"] == "1"
sig = os.environ["BEEP_SIG"]
action = os.environ["BEEP_ACT"]
boot = os.environ["BEEP_BOOT"]
until = int(os.environ["BEEP_UNTIL"])
json_path = os.environ["BEEP_JSON"]

marks = []
with open(os.environ["BEEP_MARKS"]) as f:
    for line in f:
        parts = line.rstrip("\n").split("\t")
        if len(parts) == 3:
            marks.append((int(parts[0]), parts[1], parts[2]))

TS = re.compile(r"(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)")


def epoch_of(ts):
    m = TS.match(ts or "")
    if not m:
        return None
    return time.mktime(
        (int(m.group(1)), int(m.group(2)), int(m.group(3)),
         int(m.group(4)), int(m.group(5)), int(m.group(6)), 0, 0, -1)
    )


def attribute(when):
    """The most recent mark at or before this beep — i.e. the step that beeped."""
    label = marks[0][2]
    for epoch, _iso, lbl in marks:
        if epoch <= when + 1:
            label = lbl
        else:
            break
    return label


beeps = []
with open(os.environ["BEEP_LOG"], errors="replace") as f:
    for line in f:
        line = line.strip().rstrip(",")
        if not line.startswith("{"):
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        msg = d.get("eventMessage") or ""
        if sig not in msg or action not in msg:
            continue
        # Pin to THIS boot session: the golden's own log history is stamped
        # with the same pinned clock and would otherwise alias into the window.
        if boot and (d.get("bootUUID") or boot) != boot:
            continue
        ts = d.get("timestamp", "")
        when = epoch_of(ts)
        if when is None:
            continue
        # The real window: from the first mark to the moment assert ran.
        if not (marks[0][0] - 1 <= when <= until + 2):
            continue
        beeps.append({
            "ts": ts[:19],
            "step": attribute(when),
            "message": "%s: %s" % (
                os.path.basename(d.get("processImagePath", "") or "?"), msg.strip()[:90]),
        })

count = len(beeps)
over = count > allow
window = "%s → %s, %d marks" % (
    marks[0][1], time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(until)), len(marks))

if json_path:
    with open(json_path, "w") as f:
        json.dump({
            "name": name, "beeps": count, "allowed": allow,
            "optOut": optout, "ok": (not over) or optout,
            "window": window, "events": beeps,
        }, f, indent=2)

if not over:
    print("BEEP-SENTINEL [%s]: %d alert beep(s) in the window (allowed %d; %s) — clean"
          % (name, count, allow, window))
    sys.exit(0)

verdict = "REPORT-ONLY (THINGS_LAB_BEEPS_OK=1)" if optout else "FAIL"
print("BEEP-SENTINEL [%s]: %s — %d alert beep(s) in the window (allowed %d; %s)"
      % (name, verdict, count, allow, window))
for b in beeps:
    print("    · %s · %s · %s" % (b["ts"], b["step"], b["message"]))
if optout:
    print("    (opted out: counted, not failing — probes are exempt from failing, "
          "never from accounting)")
sys.exit(0 if optout else 1)
PYEOF
  code=$?
  rm -f "$out" "$err"
  return "$code"
}

case "${1:-}" in
  reset) shift; cmd_reset "$@" ;;
  mark) shift; cmd_mark "$@" ;;
  assert) shift; cmd_assert "$@" ;;
  *) usage ;;
esac
