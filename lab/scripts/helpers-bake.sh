#!/bin/bash
# Mint things-lab-golden-v4h — the HELPERS-GRANTED layer over golden-v4
# (HELPGST1). One-time, resumable, verb-driven; see
# docs/lab/helpgst1-helpers-in-guest.md for the sitting this recipe came from.
#
#   bash lab/scripts/helpers-bake.sh boot     clone v4 -> scratch and RUN it in the
#                                             FOREGROUND (its own terminal / a
#                                             supervised background task — never a
#                                             detached process nobody can reap)
#   bash lab/scripts/helpers-bake.sh up       airgap, pin the clock, ship
#                                             node + dist + the signed bundle
#   bash lab/scripts/helpers-bake.sh setup    run `things helpers setup --gui`
#                                             (blocks on the consent dialogs)
#   bash lab/scripts/helpers-bake.sh ax …     drive lab/guest/ax-any.jxa in the guest
#   bash lab/scripts/helpers-bake.sh shot N   screenshot the guest to the artifacts dir
#   bash lab/scripts/helpers-bake.sh tcc      the guest's TCC rows for the helper pair
#   bash lab/scripts/helpers-bake.sh status   `things helpers status`
#   bash lab/scripts/helpers-bake.sh bake     stop, then clone the STOPPED scratch to
#                                             things-lab-golden-v4h (never booted)
#   bash lab/scripts/helpers-bake.sh down     delete the scratch clone
#
# WHY A GOLDEN LAYER AND NOT AN INSTALL-AT-CLONE. Installing the bundle is cheap
# and scriptable; GRANTING it is not — each grant is either a consent dialog or a
# System Settings switch, and macOS gives no scriptable way to mint one (the
# SYSTEM TCC.db is read-only under SIP, reconfirmed by AXVM1-c). But a TCC row is
# keyed to the client's code-signing REQUIREMENT — bundle identifier plus team —
# so a grant given ONCE to `com.pixelcog.things-api-helper` survives every later
# rebuild of that bundle by the same team. Pay the sitting once, freeze it in a
# golden, and every later clone just copies today's binary into the granted
# identity. Exactly how v2 added the AXVM1 L3 layer over v1.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

VM="helpgst1-bake"
GOLDEN_SRC="${GOLDEN_SRC:-things-lab-golden-v4}"
GOLDEN_DST="${GOLDEN_DST:-things-lab-golden-v4h}"
OUT="lab/artifacts/$VM"
mkdir -p "$OUT"
CLI='~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js'

note() { echo "[bake] $*"; }

vm_ip() {
  local ip
  ip=$(tart ip "$VM" 2>/dev/null || true)
  [ -n "$ip" ] || {
    echo "[bake] $VM has no IP — is it running? (\`helpers-bake.sh up\`)" >&2
    exit 1
  }
  echo "$ip"
}

cmd_boot() {
  # BLOCKING BY DESIGN. `tart run` owns the guest for as long as it runs, so this
  # verb never returns and never backgrounds itself: run it in its own terminal
  # (or as a supervised background task) and drive the rest from another. A
  # detached `tart run` is an orphan holding a 50 GB image that nothing is left
  # to stop — the lab has been bitten by exactly that.
  if tart list | grep -q "^local[[:space:]]\+$VM[[:space:]]"; then
    note "$VM already exists — reusing it"
  else
    note "cloning $GOLDEN_SRC -> $VM"
    tart clone "$GOLDEN_SRC" "$VM" || exit 1
  fi
  # --vnc-experimental, not --no-graphics: this is the one sitting in the whole
  # lab that may need a human at the screen, and a headless clone has no screen
  # to fall back to. Everything else still drives over ssh; the VNC display is
  # the safety net (and what `shot` captures).
  note "running $VM with a VNC display (blocking — Ctrl-C stops the guest)"
  exec tart run "$VM" --vnc-experimental
}

cmd_up() {
  IP=$(lab_wait_for_ssh "$VM" 600) || exit 1
  note "ssh up at $IP"
  note "airgap + clock pin (before Things is ever launched — the trial wall)"
  lab_ssh "$IP" 'sudo route -n delete default >/dev/null 2>&1 || true'
  lab_ssh "$IP" 'sudo systemsetup -setusingnetworktime off >/dev/null 2>&1; sudo date 070512002026 >/dev/null'
  note "guest clock: $(lab_ssh "$IP" date)"

  note "building dist + the helper bundle on the HOST"
  npm run build >/dev/null || exit 1
  bash scripts/build-helpers.sh >/dev/null || exit 1

  local node_bin
  node_bin=$(node -e 'console.log(process.execPath)')
  note "shipping node + dist + commander + the helper bundle"
  lab_ssh "$IP" 'mkdir -p ~/things-lab/bin ~/things-lab/things-api/node_modules'
  lab_scp "$node_bin" "admin@$IP:things-lab/bin/node"
  lab_scp -r dist "admin@$IP:things-lab/things-api/dist"
  lab_scp -r node_modules/commander "admin@$IP:things-lab/things-api/node_modules/commander"
  lab_scp package.json "admin@$IP:things-lab/things-api/package.json"
  lab_scp lab/guest/ax-any.jxa "admin@$IP:things-lab/ax-any.jxa"
  lab_ssh "$IP" 'chmod +x ~/things-lab/bin/node'
  lab_ssh "$IP" 'rm -rf ~/things-lab/"Things API Helper.app"'
  lab_scp -r "deputy/build/Things API Helper.app" "admin@$IP:things-lab/Things API Helper.app"
  # scp never sets com.apple.quarantine, so the bundle is not Gatekeeper-held;
  # prove it rather than assume it, because a quarantined helper would fail to
  # launch under launchd with nothing on screen to say why.
  note "quarantine xattr on the shipped bundle: $(lab_ssh "$IP" 'xattr -r ~/things-lab/"Things API Helper.app" 2>/dev/null | wc -l | tr -d " "') attrs"
  note "signature in the guest:"
  lab_ssh "$IP" 'codesign -dv --verbose=2 ~/things-lab/"Things API Helper.app" 2>&1 | grep -E "Identifier|TeamIdentifier|Authority=Developer"'
  note "ready — next: helpers-bake.sh setup"
}

cmd_setup() {
  local ip
  ip=$(vm_ip)
  # Things must be RUNNING before the automation leg: the ceremony's probe reads
  # a determination macOS only answers for a live app (#617), and a background
  # launch keeps the consent dialog off a stolen foreground.
  lab_ssh "$ip" 'pgrep -x Things3 >/dev/null || open -g -a Things3; sleep 8; true'
  note "driving \`things helpers setup --gui\` — answer the dialogs with the ax verb"
  lab_ssh "$ip" "$CLI helpers setup --gui --bundle ~/things-lab/'Things API Helper.app'" 2>&1 |
    tee "$OUT/setup-transcript.log"
  return "${PIPESTATUS[0]}"
}

cmd_ax() {
  local ip
  ip=$(vm_ip)
  local args=""
  for a in "$@"; do args="$args $(printf '%q' "$a")"; done
  lab_ssh "$ip" "osascript -l JavaScript ~/things-lab/ax-any.jxa$args" </dev/null 2>&1
}

cmd_shot() {
  local ip name
  ip=$(vm_ip)
  name="${1:-shot}"
  lab_ssh "$ip" 'screencapture -x /tmp/shot.png' </dev/null
  lab_scp "admin@$ip:/tmp/shot.png" "$OUT/$name.png"
  note "screenshot -> $OUT/$name.png"
}

cmd_tcc() {
  local ip
  ip=$(vm_ip)
  note "USER TCC rows for the helper pair (auth_value 2 = granted):"
  lab_ssh "$ip" 'sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db \
    "SELECT service, client, auth_value, indirect_object_identifier FROM access WHERE client LIKE \"%pixelcog%\" OR indirect_object_identifier LIKE \"%pixelcog%\";"' </dev/null
  note "SYSTEM TCC rows (Accessibility lives here):"
  lab_ssh "$ip" 'sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
    "SELECT service, client, auth_value FROM access;"' </dev/null
}

cmd_status() {
  local ip
  ip=$(vm_ip)
  lab_ssh "$ip" "$CLI helpers status" </dev/null
}

cmd_bake() {
  local ip
  ip=$(vm_ip)
  # A golden is a FROZEN artifact: it is cloned from a cleanly STOPPED VM and is
  # never itself booted. Quit the app first so the image does not carry a dirty
  # Things process state into every future clone.
  note "quitting Things and stopping the deputy's traffic"
  lab_ssh "$ip" 'osascript -e "tell application \"Things3\" to quit" >/dev/null 2>&1; sleep 4; pkill -x Things3 2>/dev/null; true' </dev/null
  note "shutting the guest down cleanly"
  lab_ssh "$ip" 'sudo shutdown -h now' </dev/null 2>/dev/null || true
  local waited=0
  while tart list | grep "^local[[:space:]]\+$VM[[:space:]]" | grep -q running; do
    sleep 5
    waited=$((waited + 5))
    if [ "$waited" -gt 180 ]; then
      note "guest did not stop in 180s — forcing"
      tart stop "$VM" || true
      break
    fi
  done
  note "cloning the stopped $VM -> $GOLDEN_DST"
  tart clone "$VM" "$GOLDEN_DST" || exit 1
  note "baked: $GOLDEN_DST"
  tart list | grep -E "golden|$VM"
  df -h /Volumes/Workspace | tail -1
}

cmd_down() {
  tart stop "$VM" >/dev/null 2>&1 || true
  tart delete "$VM" >/dev/null 2>&1 || true
  note "scratch clone $VM destroyed"
}

case "${1:-}" in
  boot) cmd_boot ;;
  up) cmd_up ;;
  setup) cmd_setup ;;
  ax)
    shift
    cmd_ax "$@"
    ;;
  shot)
    shift
    cmd_shot "$@"
    ;;
  tcc) cmd_tcc ;;
  status) cmd_status ;;
  bake) cmd_bake ;;
  down) cmd_down ;;
  *)
    sed -n '2,28p' "$0"
    exit 2
    ;;
esac
