# Golden Image Runbook — human seeding session

The scripted layers (L0 clone/resize, L1 determinism hardening, Things installed **but never launched**, sdef dumped, metadata skeleton) are done by [`lab/scripts/golden-build.sh`](../../lab/scripts/golden-build.sh). This runbook is the one-time ~half-day human session that finishes the golden image. Every step that needs your eyes/clicks is marked **[CLICK]**; everything else is copy-paste into a host terminal.

**Session rule: the moment you first launch Things (step 2.1) the 15-day trial clock starts.** Do the whole session in one sitting so the golden freezes with a maximally fresh trial. If interrupted, it's fine — clones pin the clock — but fresh is better.

## 0. Boot + connect

```sh
export TART_HOME=/Volumes/Workspace/tart
tart run things-lab-golden-v1 &            # windowed (no --no-graphics): you'll want the screen
IP=$(tart ip things-lab-golden-v1)         # retry until it answers
```

Open **Screen Sharing** → connect to `$IP` → user `admin` / password `admin`. (Or use the Tart window directly.)

## 1. One terminal helper on the host

```sh
alias vmssh='sshpass -p admin ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null admin@'"$IP"
```

## 2. Things first launch + settings — **[CLICK]**

1. In the VM: launch Things (Dock/Spotlight or `vmssh 'open -a Things3'`). **Record the timestamp**:
   ```sh
   vmssh '/Applications/Things3.app/Contents/MacOS/thingscli defaults read firstAppLaunchDate'
   ```
2. **[CLICK]** Walk the welcome flow. **Decline / skip Things Cloud** (no account).
3. **[CLICK]** Things → Settings…:
   - General: **Enable Things URLs** → after enabling, click **Manage** under the URL scheme section and copy the auth token (or read it later from SQLite — both work; record it in metadata).
   - General: uncheck any "check for updates automatically" option.
   - Today: leave "Group to-dos in the Today list by project or area" **ON** (record whatever you choose — it affects probe screenshots).
4. Quit Things (⌘Q).
5. Update metadata (host):
   ```sh
   vmssh 'python3 - <<PY
   import json,subprocess,datetime
   p="/Users/admin/things-lab/metadata.json"
   m=json.load(open(p))
   m["trialFirstLaunch"]="<PASTE ISO TIMESTAMP>"
   m["pinnedDate"]="<trialFirstLaunch + 2 days, YYYY-MM-DD>"
   m["humanLayersDone"]=m.get("humanLayersDone",[])+["L2"]
   json.dump(m,open(p,"w"),indent=2)
   PY'
   ```
   (Or just edit the file over Screen Sharing — content matters, method doesn't.)

## 3. TCC grants — **[CLICK]** (clones inherit these forever)

Push the monitor binary first (host):
```sh
sshpass -p admin scp -o StrictHostKeyChecking=no lab/guest/disruption-monitor/disruption-monitor admin@$IP:/Users/admin/things-lab/bin/
```

1. **Automation (AppleEvents), sshd → Things + System Events.** From the host run:
   ```sh
   vmssh 'osascript -e "tell application \"Things3\" to get name"'          # triggers prompt
   vmssh 'osascript -e "tell application \"System Events\" to get name of first process"'
   ```
   **[CLICK]** In Screen Sharing, click **Allow** on each consent dialog. Re-run the commands; both must return values with no prompt.
2. **Accessibility + Screen Recording for the monitor and sshd.** **[CLICK]** System Settings → Privacy & Security:
   - Accessibility → **+** → add `/Users/admin/things-lab/bin/disruption-monitor` and `/usr/libexec/sshd-keygen-wrapper`
   - Screen & System Audio Recording → **+** → add both again
   - Full Disk Access → **+** → add `/usr/libexec/sshd-keygen-wrapper`
3. **Neutralize Sequoia's monthly screen-capture re-consent** (host):
   ```sh
   vmssh 'defaults write ~/Library/Group\ Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist "/Users/admin/things-lab/bin/disruption-monitor" -date "4321-01-01 00:00:00 +0000"'
   ```
4. Verify monitor runs and emits events:
   ```sh
   vmssh 'nohup ~/things-lab/bin/disruption-monitor >/dev/null 2>&1 & sleep 2; tail -2 ~/things-lab/events.ndjson; pkill -x disruption-monitor'
   ```

## 4. LaunchAgent for the monitor (host, no clicks)

```sh
vmssh 'cat > ~/Library/LaunchAgents/com.thingslab.disruption-monitor.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.thingslab.disruption-monitor</string>
  <key>ProgramArguments</key><array><string>/Users/admin/things-lab/bin/disruption-monitor</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
PLIST
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.thingslab.disruption-monitor.plist
launchctl print gui/501/com.thingslab.disruption-monitor | head -3'
```

## 5. Proxy shortcuts — **[CLICK]** (deferred OK)

Building the ~8 parameterized proxy shortcuts in Shortcuts.app is only needed for the Lab-5 Shortcuts campaign — **you can defer this to a second short session**. When ready: build each proxy per `docs/design/lab.md` §4.4, run each once (absorb consents), then export signed copies back into the repo (`shortcuts sign`).

Minimum for now: **[CLICK]** open Shortcuts.app once, dismiss any first-run dialog, Settings → Advanced → enable **Allow Running Scripts**.

## 6. Seed dataset

Mostly scripted (I run it via URL scheme once Things URLs are enabled), except UI-only structures:

1. Scripted part (host; I do this): areas, tags + hierarchy, projects, to-dos in every state, evening items, checklists, completed/trashed items — via `things:///json` with the auth token, then verified by `things snapshot --db` against the guest DB.
2. **[CLICK]** UI-only part (you, ~10 min, exact spec provided at session time):
   - Headings: in project `LAB-PROJ-HEADINGS`, add headings `Alpha` and `Beta`; drag two seeded to-dos under each.
   - Repeating: create `LAB-REPEAT-DAILY` (to-do, repeats every day) and `LAB-REPEAT-WEEKLY-PROJ` (project, repeats weekly).
   - Complete one project via UI (choose "complete all" at the prompt) so a logged project exists.
3. Quit Things cleanly (⌘Q). I then record the schema fingerprint + UUID→role manifest into metadata.json.

## 7. Freeze

```sh
tart stop things-lab-golden-v1
```

Golden is never booted again — every run clones it. Rebuilds (new Things version / changed proxies) rerun `golden-build.sh v2` + this runbook; budget ~1 hour once the first session's learnings are folded in.

## Sanity checklist before freezing

- [ ] `thingscli defaults read firstAppLaunchDate` recorded in metadata.json
- [ ] Things URLs enabled; auth token recorded (or readable via SQLite `TMSettings.uriSchemeAuthenticationToken`)
- [ ] Both osascript commands run prompt-free
- [ ] Monitor LaunchAgent emits `frontmost` events after a fresh login (`tart stop` + `tart run` + check events.ndjson)
- [ ] Seed dataset present; `things snapshot --db <guest path>` counts match the seed manifest
- [ ] Things is QUIT and the VM stopped
