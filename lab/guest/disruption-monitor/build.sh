#!/bin/bash
# Host-side build of the disruption monitor (arm64 macOS guest target).
# Output: lab/guest/disruption-monitor/disruption-monitor (scp'd into the
# golden image during the seeding session; ad-hoc signed for a stable TCC
# identity).
set -euo pipefail
cd "$(dirname "$0")"
swiftc -O -target arm64-apple-macos15.0 main.swift -o disruption-monitor
codesign --force --sign - --identifier com.thingslab.disruption-monitor disruption-monitor
echo "built: $(pwd)/disruption-monitor"
codesign -dv disruption-monitor 2>&1 | grep -E 'Identifier|Signature'
