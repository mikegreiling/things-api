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

## Writes — AppleScript vector *(applies when validated by the lab)*

1. **One-time Automation consent.** The first AppleEvent to Things from a given controlling app triggers a macOS consent modal ("*X* wants access to control Things3"). Click **Allow** once; the grant persists per controlling app.
   - Terminal use: the grantee is your terminal app. SSH use: the grantee is `sshd-keygen-wrapper`.
   - On a dedicated/remote Mac, this click must happen in a GUI session once — Screen Sharing works fine.
   - Trigger it deliberately during setup: `osascript -e 'tell application "Things3" to get name'` — should return `Things3` with no prompt afterward.
2. No auth token needed for AppleScript.

## Writes — Shortcuts vector *(applies if/when the lab validates it)*

1. Things → Settings: check **"Allow Shortcuts app to edit large amounts of data without confirmation"** — otherwise bulk edits raise confirmation dialogs no automation can click.
2. Shortcuts.app must have been opened once (first-run dialog dismissed); required proxy shortcuts and their per-app consents will be documented with the vector.

## Dedicated automation Mac (headless-ish) checklist

For a Mac mini in a closet driven over SSH:

- [ ] Auto-login enabled for the automation user (GUI session must exist)
- [ ] Screen lock / display sleep disabled; system sleep disabled (`pmset -a sleep 0`)
- [ ] Remote Login (SSH) + Screen Sharing enabled (Screen Sharing is how you click one-time consents)
- [ ] Full Disk Access: `sshd-keygen-wrapper`
- [ ] Automation consent: sshd → Things3 (trigger via `osascript` over SSH, click Allow via Screen Sharing)
- [ ] Things URLs enabled in Things settings
- [ ] Config profile set to `dedicated-server` (raises the default allowed disruption tier — nobody is watching the screen)

## Ongoing operational notes

- **Things app updates can change the database schema.** When that happens, `things doctor` reports **drift** and all writes hard-block until a things-api release ships a matching baseline — this is deliberate safety, not breakage. Reads keep working with a warning. (Impatient escape hatch: `things config set accepted-fingerprint <hash>` — loud, audited, your responsibility.)
- **Sync needs nothing from you.** All writes go through official app surfaces, so Things Cloud sync picks them up exactly as if you'd used the app.
- **Audit trail** lives at `~/.local/state/things-api/audit/YYYY-MM.jsonl` (default ON; every mutation attempt, token-redacted).
