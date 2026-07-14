# Setup — what things-api needs before it works

Everything a user (or an agent provisioning a machine) must configure before the `things` CLI / library works properly: macOS consent modals, Things settings, and environment requirements. `things doctor` is the runtime companion to this document — run it first; it validates most of this and prints remediation for what's missing.

> **Scope note:** the read layer is live today; write vectors land with the write layer (Phase 5). Write-related setup is documented here proactively and marked accordingly, so a machine can be fully provisioned in one sitting.

## Requirements (all uses)

| Requirement | Detail |
|---|---|
| macOS | Apple Silicon or Intel; the tool reads Apple-specific paths and drives macOS-only automation surfaces. |
| Things 3 | Installed at `/Applications/Things3.app` and **launched at least once** — the database (`~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/…/main.sqlite`) is created on first launch. MAS and direct-download builds are interchangeable (verified: identical container layout and schema fingerprint). |
| Node.js | ≥ 24 (`node:sqlite` is built in — no native dependencies). |

## Reads (current)

Reads open the Things database directly, read-only, WAL-aware. Things does **not** need to be running.

1. **File access to the Things group container.** macOS may gate access to another app's data depending on the host process:
   - If `things` commands fail with a permission error opening the DB (or macOS shows an "…access data from other apps" consent), either click **Allow**, or grant your terminal/host app **Full Disk Access** (System Settings → Privacy & Security → Full Disk Access). One-time, per host app.
   - For SSH-driven use (e.g. a dedicated automation Mac), the grantee is `/usr/libexec/sshd-keygen-wrapper` — add it to Full Disk Access.
   - **A read that HANGS (rather than errors) means a consent modal is pending** somewhere it can't be seen — the OS blocks the file read synchronously while the prompt is unanswered. Common when driving the CLI from an agent/remote session with nobody at the screen. Approve the modal (Screen Sharing on a headless box) or pre-grant FDA and it never recurs. Field-diagnosed 2026-07-05: metadata (`ls`) succeeds while data reads block; everything outside the protected container reads fine.
   - **The grant is per host app and persists** — but macOS may re-prompt after the host app UPDATES (the grant is tied to the app bundle). If reads suddenly hang again after months of working, suspect a host-app update and re-approve once. FDA is the set-and-forget alternative.
2. That's it. Verify with:
   ```sh
   things doctor        # db found, schema fingerprint ok, app installed
   things today         # your Today list, This Evening split, UI order
   ```

## Writes — URL-scheme vector *(applies when the write layer lands)*

1. **Enable Things URLs** (OFF by default): Things → Settings → General → **Enable Things URLs**. Required for all URL-based mutation of existing items; without it, updates fail with a modal.
   - The auth token is auto-discovered from the local database — no manual copying.
2. **A logged-in GUI session is required.** `things:///…` commands are LaunchServices handoffs into the user's Aqua session. SSH-driven writes work *only when that same user is logged into the Mac's GUI*. Fully headless / logged-out operation is unsupported.
3. **Disruption expectations:** URL commands can launch Things and may bring it to the foreground. The CLI gates these behaviors behind disruption tiers — on a workstation profile, focus-stealing operations require `--allow-disruptive`.

## Writes — AppleScript vector *(lab-validated 2026-07-03; ships with the write layer)*

1. **One-time Automation consent.** The first AppleEvent to Things from a given controlling app triggers a macOS consent modal ("*X* wants access to control Things3"). Click **Allow** once; the grant persists per controlling app.
   - Terminal use: the grantee is your terminal app. SSH use: the grantee is `sshd-keygen-wrapper`.
   - On a dedicated/remote Mac, this click must happen in a GUI session once — Screen Sharing works fine.
   - Trigger it deliberately during setup: `osascript -e 'tell application "Things3" to get name'` — should return `Things3` with no prompt afterward.
2. No auth token needed for AppleScript.
3. **Disruption expectation:** AppleScript operations are invisible (tier 0) when Things is already running — but an AppleEvent to a *closed* Things launches it **and steals focus**. The CLI/library handles this by background-launching Things (`open -g`) before dispatching AppleScript operations.

## Writes — Shortcuts vector *(applies if/when the lab validates it)*

1. Things → Settings: check **"Allow Shortcuts app to edit large amounts of data without confirmation"** — otherwise bulk edits raise confirmation dialogs no automation can click.
2. Shortcuts.app must have been opened once (first-run dialog dismissed); required proxy shortcuts and their per-app consents will be documented with the vector.

## Writes — ui vector (Closet-mini) *(ships UNCERTIFIED; ratified 2026-07-14)*

The fourth write vector drives the real Things GUI through the macOS **Accessibility API** (semantic element paths, no coordinate clicks) for the handful of transforms that exist on no headless surface — make/reschedule/pause/resume/stop a repeat rule, and to-do/heading → project conversion. It is the **most-disruptive tier**: driving foregrounds Things and briefly takes over UI focus on the machine, so its home is a **dedicated always-on Mac ("closet mini")** that runs things-api and drives its own GUI locally, not a machine anyone is working on. Architecture: [design/ui-vector.md](design/ui-vector.md). The ops ship **uncertified** (fail-closed, per-op certification pending a one-time real-hardware sitting, [lab/ui-certification-runbook.md](lab/ui-certification-runbook.md)).

Two keys must BOTH be present for any ui op to run:

1. **Enable the vector**: `things config set ui-enabled true`. Unset/false ⇒ every ui op reports unsupported with a remediation pointing here.
2. **Per-call acknowledgment**: pass `--dangerously-drive-gui` (CLI) / `dangerouslyDriveGui: true` (MCP/library) on every call — without it the op is blocked, because it drives the local GUI and briefly foregrounds Things.

Environment requirements for the closet mini:

- **Keep the session unlocked.** A locked session presents only the lock screen and the driver cannot reach Things behind it — disable screen lock and display/system sleep (as in the dedicated-Mac checklist below).
- **Grant Accessibility to the driving process** (System Settings → Privacy & Security → **Accessibility**). Like the Full Disk Access and Automation grants, the grantee is the process running things-api: your terminal app for interactive use, `/usr/libexec/sshd-keygen-wrapper` for SSH-driven use. The grant attaches to that host identity and persists.
- **Screen Sharing / remote access** enabled as for any dedicated automation Mac (also how you click the one-time Accessibility consent).
- **Verify the grant**: `things doctor --probe-accessibility` — an opt-in probe (mirrors `--probe-automation`) that actively tests Accessibility and will summon the consent dialog on an ungranted machine; it never triggers a surprise TCC prompt otherwise. The doctor ui-vector section also reports config-enabled, Things-running, the recipe canary, and each op's certification status.

**Certification note:** every ui op ships `uncertified` — the recipes' element paths are lab-derived but not yet confirmed end-to-end on this build. Uncertified ops still run and self-verify by DB diff, but their result carries a warning naming the status; `things capabilities` and `things doctor` show it too. Certification is a lab operation (AXVM1 proved Accessibility is grantable in a VM guest, so the suite runs in a clone per Things version) with a final confirmation on the target hardware — both against a scratch/test database, never a prod library. See [ui-certification-runbook.md](lab/ui-certification-runbook.md).

## Dedicated automation Mac (headless-ish) checklist

For a Mac mini in a closet driven over SSH:

- [ ] Auto-login enabled for the automation user (GUI session must exist)
- [ ] Screen lock / display sleep disabled; system sleep disabled (`pmset -a sleep 0`)
- [ ] Remote Login (SSH) + Screen Sharing enabled (Screen Sharing is how you click one-time consents)
- [ ] Full Disk Access: `sshd-keygen-wrapper`
- [ ] Automation consent: sshd → Things3 (trigger via `osascript` over SSH, click Allow via Screen Sharing)
- [ ] Things URLs enabled in Things settings
- [ ] Config profile set to `dedicated-server` (raises the default allowed disruption tier — nobody is watching the screen)
- [ ] *(ui vector only)* Session kept UNLOCKED (screen lock disabled) — the GUI driver hits the lock screen otherwise
- [ ] *(ui vector only)* `things config set ui-enabled true`
- [ ] *(ui vector only)* Accessibility granted to the driving process (`sshd-keygen-wrapper` for SSH), verified via `things doctor --probe-accessibility`

## Hardening against consent prompts (headless / automation Macs)

macOS TCC consent is orthogonal to Unix privilege — sudo/root does not bypass it, and there is no user-editable whitelist. What you CAN control is **which identity the grant attaches to**: macOS attributes each request to the outermost *responsible process* (your terminal app, Claude Desktop, sshd, or — for launchd jobs — the binary itself), and grants last as long as that identity is stable. Note the asymmetry: Things updates do NOT churn Automation grants (the target is keyed by bundle id); it's the *requester's* identity and macOS major upgrades (which occasionally add whole consent categories, e.g. Sonoma's "access data from other apps") that re-prompt.

The ladder, cheapest first:

1. **Interactive Macs**: grant Full Disk Access to the terminal hosts you use (Terminal, iTerm, Claude Desktop). Covers database reads and the "data from other apps" prompt for everything they run, and is immune to node/things-api updates because the grant attaches to the host app, not our binary. Approve each host's Automation prompt (host → Things3) once.
2. **Headless over SSH**: enable Remote Login's "Allow full disk access for remote users" (grants sshd — an Apple-signed identity that never changes). Apple Events prompts cannot render headless (they auto-deny with error `-1743`), so pre-grant by running one Things AppleScript over SSH **while a GUI session is active** and clicking Allow (Screen Sharing works). `ssh localhost things …` is also a legitimate way to launder interactive runs through the stable sshd identity.
3. **launchd/cron jobs** (no host app shields you): the grant keys on the binary's code requirement, so an unsigned node re-prompts whenever its path or hash changes. Pin the real node binary path (no version-manager shims in the job definition) — or, the durable fix, a compiled `things` binary codesigned with a stable identity, which keeps grants across updates (roadmap).
4. **MDM + PPPC profile**: the fully supported zero-prompt path — a Privacy Preferences Policy Control payload pre-grants Full Disk Access and Apple Events to a code requirement. Only honored when delivered via user-approved MDM (a self-hosted NanoMDM is viable for a dedicated automation Mac).
5. **SIP off + direct TCC.db writes**: the CI-image pattern. It works; reserve it for disposable or single-purpose machines.

Operational rules that make grants stick: turn off Things auto-updates on the automation Mac, defer macOS upgrades to scheduled windows, and treat both as re-onboarding events. `things doctor` reports when the environment tuple (Things version, macOS version, things-api version, node binary) changed since the last successful write — the tripwire for "the next call may prompt" — and `things doctor --probe-automation` actively tests the Automation grant (expect it to summon the prompt on an unauthorized machine; that is its onboarding use). Mutation failures carry a `likelyCause` when the signals point at consent (`permission-denied`, `permission-pending`), a disabled feature, or an app update.

## Ongoing operational notes

- **Things app updates can change the database schema.** When that happens, `things doctor` reports **drift** and all writes hard-block until a things-api release ships a matching baseline — this is deliberate safety, not breakage. Reads keep working with a warning. (Impatient escape hatch: `things config set accepted-fingerprint <hash>` — loud, audited, your responsibility.)
- **Sync needs nothing from you.** All writes go through official app surfaces, so Things Cloud sync picks them up exactly as if you'd used the app.
- **Audit trail** lives at `~/.local/state/things-api/audit/YYYY-MM.jsonl` (default ON; every mutation attempt, token-redacted).
