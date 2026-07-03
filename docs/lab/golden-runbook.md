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

## 5. Proxy shortcuts — **[CLICK]** (the L5 sitting, ~30–45 min)

Scoped to the one gap only Shortcuts fills — the **heading lifecycle in existing projects** — plus a structured-output read probe. Four proxies, built by hand in the golden's Shortcuts.app (Apple provides no programmatic import; runtime execution via `shortcuts run` is fully scriptable afterwards).

### 5.1 First-run + settings **[CLICK]**

1. In the golden (Screen Sharing): open **Shortcuts.app**; dismiss any welcome/first-run dialog. Ignore/decline any iCloud sign-in nag — shortcuts stay local.
2. Shortcuts → Settings → **Advanced** → check **Allow Running Scripts**.

### L5 status (paused 2026-07-03, resume checklist below)

First sitting done through §5.1 + first-draft proxies. **Key finding:** the Things actions' Items/Project fields are **app-entity parameters** — the field's popover is a live picker of existing Things records and does **not** accept a raw string variable (screenshots in session notes). The established pattern is a **Find → act chain**: a `Find Items` action resolves name→entity and its *output* binds into the entity field. The four proxies exist in the golden in draft state (`shortcuts list` confirms) but with picker-bound/static entity fields — **they need restructuring per §5.2, not rebuilding**. Also noted: browsing those pickers launches Things in the golden (entity queries go through the app), so the golden's task data ran one maintenance pass at guest 2026-07-03 — post-sitting `lab:regress` re-validated the golden green. Resume: restructure the three mutation proxies with Find-chains (gestures in §5.2a), check whether Find Items offers an **ID** filter (upgrades addressing from name to uuid), then §5.3 consent runs.

### 5.2 Build the four proxies **[CLICK]**

Each proxy: File → New Shortcut, name it EXACTLY as shown, add the actions listed in order. The pattern is always: take a JSON dictionary as input → feed fields into one Things action → return the result. In each action's field, insert the **Shortcut Input** variable and pick **Get Value for Key** (or insert a "Get Dictionary Value" action) for the named key.

Entity fields (Items/Project) never take raw string variables — always resolve through a **Find Items** action and bind its output (the "Items" magic variable) into the entity field.

**§5.2a — inserting the magic variable into an entity field** (first gesture that works, use everywhere):
1. Click the field → look at the very top of the popover, above the entity list (empty row = variable slot), scroll up for a "Select Variable" entry.
2. Right-click (ctrl-click) the blue field chip → "Select Variable"/"Insert Variable".
3. Click the Find Items action so its result token is visible, then drag the "Items" pill onto the entity field below.

**`things-proxy-create-heading`** — input `{"title": …, "project": …}`
1. *Get Dictionary from Input*
2. **Find Items**: (Show More) Type = Project, Name is ← dictionary `project`, Limit 1
3. **Create Heading**: Title ← dictionary `title`; Project ← step 2's output
4. Output the result

**`things-proxy-edit-title`** — input `{"find": …, "title": …}`
1. *Get Dictionary from Input*
2. **Find Items**: Name is ← dictionary `find`, Limit 1
3. **Set Title of** ← step 2's output **to** ← dictionary `title`
4. Output the result

**`things-proxy-delete-items`** — input `{"find": …}`
1. *Get Dictionary from Input*
2. **Find Items**: Name is ← dictionary `find`, Limit 1
3. **Delete** ← step 2's output (leave any "immediately delete" toggle OFF — Trash, not hard delete)
4. Output the result

**`things-proxy-find-items`** — input `{"search": …}` — built ✓ (search key bound; no filters/sort). The S-campaign inspects what identifiers its structured output carries.

While editing: check whether Find Items' filter list offers **ID** as a filter field and note it. If even Find-chained output refuses to bind into an entity field, stop — that finding means parameterized proxies are infeasible (headings stay UI-only; document and shrink the campaign).

### 5.3 Consent absorption + export (scripted assist)

Run each proxy once so macOS's per-shortcut consents fire; click **Allow** on each prompt in Screen Sharing. The driver creates a sacrificial `L5-CONSENT-PROJ` in Things for the runs and trashes it afterwards (residue: one trashed project — probe assertions tolerate it; recorded in metadata). Then it exports signed copies to `lab/shortcuts/` in the repo.

### 5.4 Freeze checklist (scripted)

Quit Shortcuts + Things, verify `shortcuts list` shows the four proxies, truncate `~/things-lab/events.ndjson`, update `golden-v1-metadata.json` (humanLayersDone += L5, note consent residue), `tart stop`.

## 6. Seed dataset

Mostly scripted, with a 3-item UI-only remainder:

1. Scripted part: `lab/guest/seed-dataset.py <auth-token>` (pushed + run over SSH) — areas + tag hierarchy via AppleScript (URL scheme can't create them), projects/to-dos in every list state via URL scheme incl. **headings inside the new-project `things:///json` payload** (works — no dragging needed), status updates via token, delete-to-trash via AppleScript. Every mutation DB-verified; emits `~/things-lab/seed-manifest.json`.
2. **[CLICK]** UI-only remainder (~5 min):
   - `LAB-REPEAT-DAILY`: new to-do → Items → Repeat… → every 1 day (fixed schedule, no reminders/deadline).
   - `LAB-REPEAT-WEEKLY-PROJ`: new project → Items → Repeat… → every 1 week (v1: Sundays, starting 2026-07-05).
   - Complete `LAB-PROJ-COMPLETED` via its completion circle → prompt appears (open children) → choose **"mark as completed"**.
3. Quit Things cleanly (⌘Q). Verify + record: repeat templates land as `rt1_recurrenceRule` blobs with `start=2`; fingerprint the pulled guest DB with `things doctor --db`; update manifest + metadata (see session transcript for the exact queries — fold into a `record-l6.sh` for v2).

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
- [ ] `events.ndjson` truncated (seeding-session noise removed)
- [ ] Things is QUIT and the VM stopped

## Golden v1 status (completed 2026-07-03)

Layers done: L2 (trial + settings + token), L3 (AppleEvents + Full Disk Access were **image defaults**; Screen Recording granted for monitor + sshd; Accessibility proved unnecessary — monitor uses CGWindowList), L4 (monitor LaunchAgent verified), L6 (37-record scripted seed + 3 UI items, all DB-verified). **Deferred: L5** (Shortcuts first-run + Allow Running Scripts + proxy imports — second sitting, required before the S-probe campaign). Repo copies: [`seed-manifest.json`](seed-manifest.json), [`golden-v1-metadata.json`](golden-v1-metadata.json).
