# Shared environment for lab scripts. Source this; do not execute.
export TART_HOME="${TART_HOME:-/Volumes/Workspace/tart}"

# THE LAB ESCAPES (docs/design/permissions-doctrine.md Articles I/II + IV;
# docs/lab/harness.md §The lab escapes).
#
# A shipped host may reach Things only through grants a golden clone cannot
# have: it has no helper bundle and no human to answer a consent dialog. What it
# DOES have is the AXVM1 layer — an in-guest Accessibility + Automation grant
# held by the runner's own sshd-descended processes. Each escape below restores
# DIRECT availability of one vector for exactly that situation. Neither is
# consumer surface.
#
# $LAB_UI_DIRECT — the ui vector (GUI-driving). Does NOT bypass `ui-enabled`; a
# clone still runs `things config set ui-enabled true`.
#
#   lab_ssh "$IP" "$LAB_UI_DIRECT $CLI todo reschedule-repeat … "
#
LAB_UI_DIRECT="THINGS_API_UI_DIRECT=1"

# $LAB_WRITE_DIRECT — the AppleScript vector. An sshd-descended shell has no
# bundle id, so macOS has no identity to have recorded an Automation grant
# against and `writeCapability` reads `direct-unknown` in EVERY clone: without
# this prefix every AppleScript-vector verb, and every composite with an
# AppleScript leg (`make-repeating`, `add-repeating`), refuses `blocked:
# environment`. The URL scheme, Shortcuts and reads are unaffected.
#
#   lab_ssh "$IP" "$LAB_WRITE_DIRECT $CLI todo delete … "
#
LAB_WRITE_DIRECT="THINGS_API_WRITE_DIRECT=1"

# $LAB_DIRECT — both, for a driver that exercises composites (a URL/AppleScript
# leg plus a dialog drive) and does not want to reason about which is which.
LAB_DIRECT="$LAB_UI_DIRECT $LAB_WRITE_DIRECT"

LAB_BASE_IMAGE="ghcr.io/cirruslabs/macos-sequoia-vanilla:latest"
LAB_SSH_USER="admin"
LAB_SSH_PASS="admin"

# Password-only auth: a loaded ssh-agent can exhaust the server's auth
# attempts with key offers before sshpass's password is ever tried
# ("Too many authentication failures").
LAB_SSH_OPTS=(
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o LogLevel=ERROR
  -o PreferredAuthentications=password
  -o PubkeyAuthentication=no
  -o IdentitiesOnly=yes
)

lab_ssh() {
  # lab_ssh <ip> <command...> — fresh clones flap password auth in their
  # first seconds (exit 255); retry that specific failure like the TS runner.
  local ip="$1" attempt code
  shift
  for attempt in 1 2 3; do
    sshpass -p "$LAB_SSH_PASS" ssh "${LAB_SSH_OPTS[@]}" -o ConnectTimeout=10 \
      "$LAB_SSH_USER@$ip" "$@"
    code=$?
    [ "$code" -ne 255 ] && return "$code"
    [ "$attempt" -lt 3 ] && sleep 2
  done
  return 255
}

lab_scp() {
  # lab_scp <src> <ip>:<dst>  (or any scp arg pair)
  sshpass -p "$LAB_SSH_PASS" scp "${LAB_SSH_OPTS[@]}" "$@"
}

lab_mute_guest() {
  # lab_mute_guest <ip> — silence the guest's audio output.
  #
  # A Tart guest plays through the HOST's speakers, so a single alert beep from
  # an unattended overnight clone wakes whoever is asleep next to the machine.
  # Every clone-boot path mutes; best-effort, never fatal.
  lab_ssh "$1" "osascript -e 'set volume output muted true'" >/dev/null 2>&1 || true
}

lab_wait_for_ssh() {
  # lab_wait_for_ssh <vm-name> [timeout-seconds] -> echoes IP on success
  #
  # This is the shared clone-boot chokepoint for every bash campaign driver, so
  # it MUTES the guest the moment SSH answers (see lab_mute_guest).
  #
  # The deadline is WALL-CLOCK, not iteration count: each probe can itself burn
  # ~30s (lab_ssh retries a 10s-ConnectTimeout three times), so counting loops
  # turned a nominal 300s wait into ~55 minutes on a VM that never opened
  # sshd (observed while minting golden-v4, 2026-08-22).
  local vm="$1" timeout="${2:-180}" ip="" start="$SECONDS"
  while [ $((SECONDS - start)) -lt "$timeout" ]; do
    ip="$(tart ip "$vm" 2>/dev/null || true)"
    # cheap TCP probe first, so a dead guest costs 3s per loop, not 30
    if [ -n "$ip" ] && nc -z -G 3 "$ip" 22 2>/dev/null; then
      if lab_ssh "$ip" true 2>/dev/null; then
        lab_mute_guest "$ip"
        echo "$ip"
        return 0
      fi
    fi
    sleep 3
  done
  echo "timed out waiting for SSH on $vm after ${timeout}s" >&2
  return 1
}
