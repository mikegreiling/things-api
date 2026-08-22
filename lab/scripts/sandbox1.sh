#!/bin/bash
# SANDBOX1 — sandboxed-reader feasibility: does a powerbox-granted security-
# scoped bookmark give a sandboxed tool DURABLE access to ANOTHER app's group
# container (Things), immune to the per-process AppData consent churn measured
# live on the maintainer's host 2026-08-21?
# Write-up: docs/lab/sandbox1-scoped-reader.md. Golden: things-lab-golden-v3
# (Things 3.22.14, macOS 15.7.7 Sequoia).
#
# Legs (in order):
#   setup     clone golden-v3, boot, wait for ssh
#   build     host-side: swiftc cross-build sandbox-probe, ad-hoc sign WITH
#             entitlements, push to guest (plus the launchd plist templates)
#   grant     guest: run probe in grant mode in the Aqua session; AX-drive the
#             NSOpenPanel (⌘⇧G → container path → Return → Open) via the
#             golden's L3 accessibility grant; assert GRANT-OK
#   read      guest: run probe read mode UNDER LAUNCHD (fresh process, no sshd
#             TCC inheritance); assert READ-OK with a plausible TMTask count,
#             measure wall-time (a TCC stall would show as seconds-long)
#   cycle     read again under launchd (two more fresh processes) — per-process
#             durability
#   noscope   launchd run WITHOUT the bookmark — expect immediate sandbox denial
#   serve     probe serve mode under launchd; connect + echo round-trip
#   reboot    tart stop / run, wait ssh, read again — cross-boot durability
#   teardown  stop + delete the clone
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh

GOLDEN="${GOLDEN:-things-lab-golden-v3}"
VM="${VM:-sandbox1-lab}"
OUT="lab/artifacts/$VM"; mkdir -p "$OUT"
SESSION="$OUT/session.env"
REPORT="$OUT/report.txt"
note() { echo "[sandbox1] $*" | tee -a "$REPORT"; }
CMD="${1:-}"

CONTAINER='/Users/admin/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac'
GUEST_PROBE=/Users/admin/probe.app/Contents/MacOS/sandbox-probe
LABEL=com.pixelcog.sandbox1-probe
PLIST=/Users/admin/Library/LaunchAgents/$LABEL.plist

load_session() { [ -f "$SESSION" ] || { echo "no session — run setup first" >&2; exit 1; }; source "$SESSION"; }

# Render a one-shot launchd plist that runs the probe with ARGS and tees
# stdout/stderr to /Users/admin/probe-out.txt, then exits (RunAtLoad, no
# KeepAlive). Bootstrapping it is the launchd-hosted execution path.
launchd_run() { # launchd_run <ip> <args...> -> echoes probe output
  local ip="$1"; shift
  local args_xml=""
  for a in "$@"; do args_xml+="<string>$a</string>"; done
  lab_ssh "$ip" "rm -f /Users/admin/probe-out.txt; cat > $PLIST <<EOF
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$GUEST_PROBE</string>$args_xml</array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/Users/admin/probe-out.txt</string>
  <key>StandardErrorPath</key><string>/Users/admin/probe-out.txt</string>
</dict></plist>
EOF
launchctl bootout gui/501/$LABEL 2>/dev/null; launchctl bootstrap gui/501 $PLIST"
  # Wait for output (the read cells finish in ms unless a TCC stall bites).
  local waited=0
  while [ "$waited" -lt 60 ]; do
    if lab_ssh "$ip" "test -s /Users/admin/probe-out.txt" 2>/dev/null; then
      lab_ssh "$ip" "cat /Users/admin/probe-out.txt"
      lab_ssh "$ip" "launchctl bootout gui/501/$LABEL 2>/dev/null" || true
      return 0
    fi
    sleep 2; waited=$((waited + 2))
  done
  note "launchd_run: no output after 60s (TCC stall or crash)"
  lab_ssh "$ip" "launchctl bootout gui/501/$LABEL 2>/dev/null" || true
  return 1
}

case "$CMD" in
setup)
  live=$(TART_HOME="$TART_HOME" tart list 2>/dev/null | grep -c running || true)
  [ "$live" -ge 2 ] && { note "2-VM ceiling reached — refusing to clone"; exit 1; }
  tart clone "$GOLDEN" "$VM"
  (tart run --no-graphics "$VM" > "$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 240) || exit 1
  # Airgap (delete default route; ssh survives on the vmnet subnet).
  lab_ssh "$IP" "sudo route -n delete default >/dev/null 2>&1 || true"
  echo "IP=$IP" > "$SESSION"
  note "setup complete: VM=$VM IP=$IP"
  ;;
build)
  load_session
  BUILD="$OUT/build"; mkdir -p "$BUILD"
  swiftc -O lab/guest/sandbox-probe/main.swift -o "$BUILD/sandbox-probe" || exit 1
  # amfid REFUSES ad-hoc signatures on sandboxed binaries (AMFI error -423,
  # probed 2026-08-21): App Sandbox entitlements demand a real certificate
  # chain. Sign with the host's Developer ID (falls back to Apple Development).
  IDENTITY=""
  for candidate in "Developer ID Application" "Apple Development"; do
    security find-identity -v -p codesigning 2>/dev/null | grep -q "$candidate" && { IDENTITY="$candidate"; break; }
  done
  [ -n "$IDENTITY" ] || { echo "no Apple-chain signing identity — sandboxed probe cannot run" >&2; exit 1; }
  # secinit refuses to sandbox a BARE executable (libsecinit trap, probed
  # 2026-08-21): package as a minimal .app bundle and sign the bundle.
  rm -rf "$BUILD/probe.app"; mkdir -p "$BUILD/probe.app/Contents/MacOS"
  cat > "$BUILD/probe.app/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.pixelcog.sandbox1-probe</string>
  <key>CFBundleName</key><string>sandbox-probe</string>
  <key>CFBundleExecutable</key><string>sandbox-probe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
EOF
  cp "$BUILD/sandbox-probe" "$BUILD/probe.app/Contents/MacOS/sandbox-probe"
  codesign --force --sign "$IDENTITY" \
    --options runtime --timestamp \
    --entitlements lab/guest/sandbox-probe/entitlements.plist \
    "$BUILD/probe.app" || exit 1
  tar -C "$BUILD" -czf "$BUILD/probe.app.tgz" probe.app
  lab_scp "$BUILD/probe.app.tgz" "$LAB_SSH_USER@$IP:/Users/admin/probe.app.tgz"
  lab_ssh "$IP" "rm -rf /Users/admin/probe.app && tar -C /Users/admin -xzf probe.app.tgz"
  note "build+push complete ($(shasum -a 256 "$BUILD/probe.app/Contents/MacOS/sandbox-probe" | cut -c1-16)…)"
  ;;
grant)
  load_session
  # Launch grant mode via LAUNCHD so the panel gets a genuine Aqua context
  # (ssh-spawned AppKit has no reliable WindowServer standing).
  lab_ssh "$IP" "rm -f /Users/admin/grant-out.txt; cat > $PLIST <<EOF
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$GUEST_PROBE</string><string>grant</string><string>$CONTAINER</string></array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/Users/admin/grant-out.txt</string>
  <key>StandardErrorPath</key><string>/Users/admin/grant-out.txt</string>
</dict></plist>
EOF
launchctl bootout gui/501/$LABEL 2>/dev/null; launchctl bootstrap gui/501 $PLIST"
  sleep 5
  # ⌘⇧G → type the path → Return (accept the go-to sheet) → Return (Open).
  lab_ssh "$IP" "osascript <<'AS'
tell application \"System Events\"
  tell process \"sandbox-probe\"
    set frontmost to true
    delay 1
    keystroke \"g\" using {command down, shift down}
    delay 1
    keystroke \"$CONTAINER\"
    delay 0.5
    key code 36
    delay 1.5
    key code 36
  end tell
end tell
AS"
  sleep 3
  RES=$(lab_ssh "$IP" "cat /Users/admin/grant-out.txt")
  lab_ssh "$IP" "launchctl bootout gui/501/$LABEL 2>/dev/null" || true
  note "grant: $RES"
  echo "$RES" | grep -q "GRANT-OK" || { note "grant leg FAILED"; exit 1; }
  ;;
read|cycle)
  load_session
  START=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')
  RES=$(launchd_run "$IP" read) || { note "$CMD leg FAILED (no output)"; exit 1; }
  END=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')
  note "$CMD (${END}-${START} wall incl. bootstrap): $RES"
  echo "$RES" | grep -q "READ-OK" || { note "$CMD leg FAILED"; exit 1; }
  ;;
noscope)
  load_session
  RES=$(launchd_run "$IP" noscope "$CONTAINER") || true
  note "noscope: ${RES:-<none>}"
  echo "${RES:-}" | grep -q "NOSCOPE-DENIED" || { note "noscope leg FAILED (expected sandbox denial)"; exit 1; }
  ;;
serve)
  load_session
  lab_ssh "$IP" "rm -f /Users/admin/probe-out.txt; cat > $PLIST <<EOF
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$GUEST_PROBE</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/Users/admin/probe-out.txt</string>
  <key>StandardErrorPath</key><string>/Users/admin/probe-out.txt</string>
</dict></plist>
EOF
launchctl bootout gui/501/$LABEL 2>/dev/null; launchctl bootstrap gui/501 $PLIST"
  sleep 3
  SOCK=$(lab_ssh "$IP" "cat /Users/admin/probe-out.txt" | grep "SERVE-OK" | cut -d' ' -f2)
  [ -n "$SOCK" ] || { note "serve leg FAILED (no SERVE-OK)"; exit 1; }
  RES=$(lab_ssh "$IP" "printf 'ping\n' | nc -U -w 3 '$SOCK'")
  note "serve: socket=$SOCK echo=$RES"
  lab_ssh "$IP" "launchctl bootout gui/501/$LABEL 2>/dev/null" || true
  echo "$RES" | grep -q "ECHO:ping" || { note "serve leg FAILED (echo mismatch)"; exit 1; }
  ;;
reboot)
  load_session
  tart stop "$VM" 2>/dev/null || true
  sleep 3
  (tart run --no-graphics "$VM" >> "$OUT/tart-run.log" 2>&1 &)
  IP=$(lab_wait_for_ssh "$VM" 240) || exit 1
  lab_ssh "$IP" "sudo route -n delete default >/dev/null 2>&1 || true"
  echo "IP=$IP" > "$SESSION"
  RES=$(launchd_run "$IP" read) || { note "reboot leg FAILED (no output)"; exit 1; }
  note "reboot read: $RES"
  echo "$RES" | grep -q "READ-OK" || { note "reboot leg FAILED"; exit 1; }
  ;;
teardown)
  tart stop "$VM" 2>/dev/null || true
  sleep 2
  tart delete "$VM" 2>/dev/null || true
  note "teardown complete"
  ;;
*)
  echo "usage: $0 setup|build|grant|read|cycle|noscope|serve|reboot|teardown" >&2
  exit 2
  ;;
esac
