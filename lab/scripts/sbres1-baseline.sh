#!/bin/bash
# SBRES1 — the FLOOR: what does an osascript JXA hop cost before it does any
# work at all? Anything the snapshot spends below this is not the driver's to
# save; it is process launch, the ObjC bridge, and the one System Events event
# that resolves Things' pid.
set -uo pipefail
cd "$(dirname "$0")/../.."
source lab/scripts/env.sh
OUT="lab/artifacts/${VM:-sbres1-lab}"
source "$OUT/session.env"

lab_ssh "$IP" "cat > /tmp/floor1.js" </dev/null <<'JS'
'OK'
JS
lab_ssh "$IP" "cat > /tmp/floor2.js" </dev/null <<'JS'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
'OK'
JS
lab_ssh "$IP" "cat > /tmp/floor3.js" </dev/null <<'JS'
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
var pid = Application('System Events').processes.byName('Things3').unixId();
String(pid)
JS
for f in floor1 floor2 floor3; do
  echo -n "$f: "
  lab_ssh "$IP" "{ /usr/bin/time -p /usr/bin/osascript -l JavaScript /tmp/$f.js >/dev/null ; } 2>&1 | tr '\n' ' '; echo" </dev/null
done
