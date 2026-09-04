# Helpers-in-the-guest: ship the host-built helper bundle into a clone and put
# it back under launchd (HELPGST1). Source this after lab/scripts/env.sh; do not
# execute it.
#
# WHY THE BUNDLE IS BUILT ON THE HOST. `scripts/build-helpers.sh` needs a Swift
# toolchain and, more importantly, a Developer ID identity — the guest has
# neither, and a bundle signed with a DIFFERENT identity would be a different
# TCC subject, so every grant baked into the golden would miss it. The bundle
# therefore crosses the airgap the same way node + dist do, and the guest runs
# the CLI's OWN install path over it.
#
# WHY THE GRANTS SURVIVE. macOS keys a TCC row to the client's code-signing
# REQUIREMENT (bundle identifier + team identifier), not to a file hash, so a
# rebuild of `com.pixelcog.things-api-helper` signed by the same team inherits
# every row the golden was baked with. That is the whole reason golden-v4h can
# be a frozen layer while the bundle it grants is rebuilt on every run.
#
# The clone this runs against MUST be a clone of a helpers-granted golden
# (things-lab-golden-v4h). On a bare v4 clone the install succeeds and the
# ceremony then sits waiting for consent dialogs nobody can answer.

# Where the guest keeps the shipped bundle, and where the CLI installs it to.
GUEST_BUNDLE_STAGE='$HOME/things-lab/Things API Helper.app'
GUEST_DEPUTY_SOCK='$HOME/.local/state/things-api/deputy/deputy.sock'

guest_helpers_ship() {
  # guest_helpers_ship <ip> — copy the host-built bundle into the guest's
  # staging dir. Built here, never in the guest.
  local ip="$1"
  local built="deputy/build/Things API Helper.app"
  if [ ! -x "$built/Contents/MacOS/things-deputy" ]; then
    echo "[helpers] no built bundle at $built — run: bash scripts/build-helpers.sh" >&2
    return 1
  fi
  if [ ! -d "$built/Contents/Helpers/things-reader.app" ]; then
    echo "[helpers] the built bundle carries no things-reader (no Apple-chain identity?) —" >&2
    echo "[helpers] the routed arm needs it: the reader holds the read grant the golden was baked with." >&2
    return 1
  fi
  lab_ssh "$ip" 'rm -rf ~/things-lab/"Things API Helper.app"; mkdir -p ~/things-lab'
  lab_scp -r "$built" "admin@$ip:things-lab/Things API Helper.app"
}

guest_helpers_install() {
  # guest_helpers_install <ip> <cli-invocation> — run the CLI's own install +
  # onboarding path over the shipped bundle. On a v4h clone every leg is
  # already granted, so the ceremony detects each one prompt-free, raises
  # nothing, and exits 0; `--gui` keeps the two GUI-tier legs in the survey so
  # a lapsed Accessibility or System Events grant is reported here rather than
  # discovered mid-drive.
  local ip="$1" cli="$2"
  lab_ssh "$ip" "$cli helpers setup --gui --bundle ~/things-lab/'Things API Helper.app'"
}

guest_helpers_enable() {
  # guest_helpers_enable <ip> <cli-invocation> — the explicit routing mode.
  # `true`, never `auto`: auto falls back to direct execution the moment a
  # grant cannot be proven, which is exactly the silence this arm exists to
  # break. Under `true` an unroutable hop refuses and the run goes red.
  local ip="$1" cli="$2"
  lab_ssh "$ip" "$cli config set helpers-enabled true"
}

guest_helpers_wait_socket() {
  # guest_helpers_wait_socket <ip> [seconds] — the deputy is launchd-managed and
  # takes a moment to come back after an install; wait for the real thing (its
  # socket) rather than sleeping a guess.
  local ip="$1" timeout="${2:-30}" start="$SECONDS"
  while [ $((SECONDS - start)) -lt "$timeout" ]; do
    if lab_ssh "$ip" "test -S $GUEST_DEPUTY_SOCK" 2>/dev/null; then return 0; fi
    sleep 2
  done
  echo "[helpers] the deputy socket never appeared in ${timeout}s" >&2
  return 1
}

guest_helpers_assert_routed() {
  # guest_helpers_assert_routed <ip> <cli-invocation> — fail closed before a
  # single probe runs. A routed arm that quietly ran direct would certify the
  # wrong identity, which is the exact failure mode this whole layer exists to
  # end (0.20.7).
  local ip="$1" cli="$2" line
  line=$(lab_ssh "$ip" "$cli helpers status --json" | python3 -c "
import json, sys
d = json.load(sys.stdin)['data']
hello = d['deputy']['hello'] or {}
print(d['mode'], d['deputy']['running'], (hello.get('automation') or {}).get('things'),
      hello.get('axTrusted'), (hello.get('automation') or {}).get('systemEvents'),
      d['reader']['granted'], hello.get('deputyVersion'))
")
  echo "[helpers] mode/running/automation-things/axTrusted/automation-SE/reader/version: $line"
  case "$line" in
    "true True granted True granted True "*) return 0 ;;
    *)
      echo "[helpers] the clone is NOT routed with the full GUI tier — refusing to certify it" >&2
      return 1
      ;;
  esac
}

guest_helpers_provision() {
  # guest_helpers_provision <ip> <cli-invocation> — the whole per-run sequence,
  # in the order a field host would have done it once by hand.
  local ip="$1" cli="$2"
  echo "[helpers] shipping the host-built bundle"
  guest_helpers_ship "$ip" || return 1
  echo "[helpers] installing + onboarding in the guest"
  guest_helpers_install "$ip" "$cli" || return 1
  guest_helpers_wait_socket "$ip" || return 1
  echo "[helpers] switching routing on"
  guest_helpers_enable "$ip" "$cli" >/dev/null || return 1
  guest_helpers_assert_routed "$ip" "$cli"
}
