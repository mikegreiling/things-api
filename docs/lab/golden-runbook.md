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
alias vmssh='sshpass -p admin ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PreferredAuthentications=password -o PubkeyAuthentication=no -o IdentitiesOnly=yes admin@'"$IP"
```

(The password-only options matter: a loaded ssh-agent can exhaust the server's auth attempts with key offers before the password is tried — "Too many authentication failures".)

## 2. Things first launch + settings — **[CLICK]**

1. In the VM: launch Things (Dock/Spotlight or `vmssh 'open -a Things3'`). This starts the 15-day trial clock (guest wall-clock — the guest free-runs with network time off; that's fine, clones pin to it).
2. **[CLICK]** Walk the welcome flow. **Decline / skip Things Cloud** (no account).
3. **[CLICK]** Things → Settings…:
   - General: **Enable Things URLs** → click **Manage** and copy the auth token (needed for step 4).
   - General: uncheck any "check for updates automatically" option.
   - Today: leave "Group to-dos in the Today list by project or area" **OFF** (flat list = cleaner ordering probes; matches production).
   - Shortcuts/General: CHECK "Allow Shortcuts app to edit large amounts of data without confirmation" (a confirmation dialog mid-probe is a harness wedge; the unchecked behavior is a deferred S-probe).
4. Quit Things (⌘Q), then record everything from the host — reads the trial clock via thingscli, computes the pinned date, stores token + settings:
   ```sh
   lab/scripts/record-l2.sh '<AUTH-TOKEN>'
   ```

## 3. TCC grants

**Empirically revised (2026-07-03):** the two grants that matter — **AppleEvents automation** (sshd → Things3 + System Events) and **Full Disk Access** (sshd, for DB reads) — are **already present in the Cirrus vanilla image** (`auth_value=2`, SIP enabled, so genuine). Both `osascript` calls return prompt-free; no clicks were needed. **Accessibility is not needed** — the disruption-monitor uses CGWindowList + NSWorkspace, not the AX API.

Verify (host), no clicks expected:
```sh
lab/scripts/tcc-check.sh            # asserts AppleEvents + FDA present; reports Screen Recording
```

Push the monitor binary (host) — scripted; run from the repo root:
```sh
source lab/scripts/env.sh; IP="$(tart ip things-lab-golden-v1)"
lab_scp lab/guest/disruption-monitor/disruption-monitor "admin@$IP:/Users/admin/things-lab/bin/"
```

### Screen Recording — **[CLICK]**, OPTIONAL (window titles + screenshots only)

Without it, the monitor still captures every NSWorkspace event (launch/activate/terminate/frontmost = tier 0/1/2) **and** window-new/window-close (a modal/window appeared = tier 3). What it *cannot* do without it: read window **title strings** (they come back `""`) or take `screencapture` screenshots. DB-delta verdicts and disruption tiers do not depend on it, so **the U-probe campaign can run without this.**

To enable (recommended before the AppleScript/Shortcuts campaigns, where modal-title identification and screenshot evidence add real value):
1. **[CLICK]** System Settings → Privacy & Security → **Screen & System Audio Recording** → **+** → add both `/Users/admin/things-lab/bin/disruption-monitor` and `/usr/libexec/sshd-keygen-wrapper` (⌘⇧G to type the paths).
2. Neutralize Sequoia's monthly re-consent (host):
   ```sh
   lab/scripts/suppress-screencapture-nag.sh
   ```

## 4. LaunchAgent for the monitor — scripted, done (2026-07-03)

Installed and verified emitting in the Aqua session:
```sh
lab/scripts/install-monitor-agent.sh    # bootstrap + kickstart + emission check
```
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
