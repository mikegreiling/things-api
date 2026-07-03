#!/bin/bash
# Record the L2 human layer into the golden's metadata.json — paste-free.
# Reads the trial clock from thingscli on the guest, computes the pinned
# date (+2 days, GUEST wall-clock), stores the auth token and settings.
# Idempotent: merges into existing metadata.
#
# Usage: ./record-l2.sh <auth-token> [vm-name]
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=env.sh
source ./env.sh

TOKEN="${1:?usage: record-l2.sh <auth-token> [vm-name]}"
VM="${2:-things-lab-golden-v1}"
IP="$(tart ip "$VM")"

# Quoted heredocs end-to-end: parameters travel as env vars, never via
# shell interpolation (no escaping pitfalls).
lab_ssh "$IP" "LAB_TOKEN=$(printf %q "$TOKEN") LAB_VM=$(printf %q "$VM") bash -s" <<'GUEST'
set -e
cp /Applications/Things3.app/Contents/Resources/Things.sdef ~/things-lab/artifacts/Things.sdef
python3 - <<'PY'
import json, subprocess, datetime, re, os
cli = "/Applications/Things3.app/Contents/MacOS/thingscli"
raw = subprocess.run([cli, "defaults", "read", "firstAppLaunchDate"], capture_output=True, text=True).stdout.strip()
m = re.match(r"(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})", raw)
assert m, f"unparseable firstAppLaunchDate: {raw!r}"
first = datetime.datetime.strptime(f"{m.group(1)} {m.group(2)}", "%Y-%m-%d %H:%M:%S")
p = "/Users/admin/things-lab/metadata.json"
meta = json.load(open(p)) if os.path.exists(p) else {}
meta.update({
    "golden": os.environ["LAB_VM"],
    "thingsVersion": "3.22.11",
    "trialFirstLaunch": raw,
    "trialFirstLaunchIso": first.isoformat() + "Z",
    "pinnedDate": (first + datetime.timedelta(days=2)).strftime("%Y-%m-%d"),
    "guestClockNote": "guest free-runs (networktime off); all trial math uses GUEST wall-clock",
    "uriSchemeAuthToken": os.environ["LAB_TOKEN"],
    "settings": {
        "groupTodayByParent": False,
        "thingsCloudDeclined": True,
        "thingsUrlsEnabled": True,
        "shortcutsBulkEditWithoutConfirmation": True,
        "thingsAutoUpdateDisabled": True,
    },
})
layers = meta.get("humanLayersDone", [])
if "L2" not in layers:
    layers.append("L2")
meta["humanLayersDone"] = layers
json.dump(meta, open(p, "w"), indent=2)
print("recorded L2:", meta["trialFirstLaunch"], "| pinned:", meta["pinnedDate"])
PY
sync
wc -c ~/things-lab/artifacts/Things.sdef
GUEST
echo "L2 RECORDED OK"
