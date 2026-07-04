# Shared environment for lab scripts. Source this; do not execute.
export TART_HOME="${TART_HOME:-/Volumes/Workspace/tart}"

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

lab_wait_for_ssh() {
  # lab_wait_for_ssh <vm-name> [timeout-seconds] -> echoes IP on success
  local vm="$1" timeout="${2:-180}" ip="" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    ip="$(tart ip "$vm" 2>/dev/null || true)"
    if [ -n "$ip" ]; then
      if lab_ssh "$ip" true 2>/dev/null; then
        echo "$ip"
        return 0
      fi
    fi
    sleep 3
    waited=$((waited + 3))
  done
  echo "timed out waiting for SSH on $vm" >&2
  return 1
}
