# Shared environment for lab scripts. Source this; do not execute.
export TART_HOME="${TART_HOME:-/Volumes/Workspace/tart}"

LAB_BASE_IMAGE="ghcr.io/cirruslabs/macos-sequoia-vanilla:latest"
LAB_SSH_USER="admin"
LAB_SSH_PASS="admin"

lab_ssh() {
  # lab_ssh <ip> <command...>
  local ip="$1"
  shift
  sshpass -p "$LAB_SSH_PASS" ssh \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR \
    -o ConnectTimeout=10 \
    "$LAB_SSH_USER@$ip" "$@"
}

lab_scp() {
  # lab_scp <src> <ip>:<dst>  (or any scp arg pair)
  sshpass -p "$LAB_SSH_PASS" scp \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR \
    "$@"
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
