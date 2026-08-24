# The permissions doctrine — consent, capability, and the two provenances

**Status: RATIFIED 2026-08-24 (Mike).** This is constitutional: every surface — library, CLI, MCP — is bound by these articles, and a change here requires the maintainer's explicit sign-off. Companion documents: [helpers-onboarding.md](helpers-onboarding.md) (the helpers ceremony mechanics), [architecture.md](architecture.md).

## Article I — Consent is raised only inside setup ceremonies

No `things` command, MCP tool, or library call may cause a macOS consent dialog (TCC prompt, file panel, Accessibility registration) **except** the two setup ceremonies: `things setup` (the current host app) and `things helpers setup` (the helper pair). Every other entry point must determine capability **prompt-free** and, when capability is missing, refuse with a reason and the exact remediation command. A user is never surprised by a modal mid-session; an agent never hangs on a dialog nobody is present to answer.

Corollary: capability probes must themselves be prompt-free. Opening the Things group container in direct mode is NOT a probe — the open is what raises the app-data consent. The probes are: the reader/deputy `hello` (helpers path), and the FDA probe + TCC introspection (direct path, Article III).

## Article II — Detect early, refuse loudly

Capability is assessed at entry, not mid-flight:

- **CLI**: each command preflights the vector class it needs (read / write / ui) before touching the app or container. A refusal names the missing grant, the identity that must hold it, and the setup command that gathers it.
- **MCP**: capabilities are baked at server startup — the vector set is detected before the daemon accepts a tool call, stated in the server instructions, and tools outside it refuse immediately with "restart after setup" remediation. Never re-assessed per call.
- **`things doctor`**: renders the effective mode and the per-vector grant state with provenance (which identity holds each grant), plus remediation lines.
- **`things --help`**: one autodetectable stanza naming the two provenances and the detected host app (Article III).

## Article III — Two provenances, one rule

Grants attach to a *responsible process identity*. The package supports exactly two:

1. **Helpers** (recommended; least privilege): grants attach to the signed helper identities, durable across rebuilds/reboots/upgrades. Onboard once with `things helpers setup`.
2. **Direct** (convenience): grants attach to the host app (terminal emulator, agent harness, MCP host — named in copy by best-effort detection).

**Detection never requires FDA and never touches the container.** The prompt-free probe chain, valid from ANY process: (a) helpers hello — reader/deputy grant state, no dialog possible; (b) the FDA probe — a read attempt on `~/Library/Application Support/com.apple.TCC/TCC.db` succeeds iff the host app holds FDA and fails with a plain, silent EPERM otherwise (FDA-class files never raise a dialog); (c) direct Automation state — `AEDeterminePermissionToAutomateTarget(askUserIfNeeded: false)` under the host app's own attribution (JXA/ObjC probe). The Things group container is opened only AFTER one of these proves it safe; "try the read and see" is forbidden as a probe because the open is itself what raises the app-data consent (Article I corollary).

**Capability for direct reads requires FDA on the host app** — not for detection, but because no durable alternative exists: the sub-FDA consent class for the container ("access data from other apps", `kTCCServiceSystemPolicyAppData`) is MEASURED allow-once-per-process (pid-pinned; [tcc semantics arc]), and a fresh CLI invocation is a fresh process, so there is nothing durable beneath FDA to detect or rely on. That measurement is why the sandboxed reader exists. Direct Automation grants ARE durable per host identity, but a write-capable/read-incapable process is useless in practice — every write read-verifies — so direct mode's real floor is FDA (or the helpers).

Routing (`helpers-mode auto`): helpers when onboarded → else direct when the FDA probe passes → else refuse with both setup commands offered. `true`/`false` force/forbid the helpers as today. The intended end-state for a helpers household is deliberately supported: onboard the helpers, then REVOKE the terminal's FDA — probe (b) silently reports no, and reads keep flowing through the reader.

## Article IV — The UI vector requires the helpers

GUI-driving (Accessibility + Automation→System Events) is granted only to the helper identity, never to a terminal or agent harness — the blast radius of AX on a general host app is unacceptable, per-host churn violates Article I over time, and sshd-hosted sessions have no sane direct story. Consequences: `--dangerously-drive-gui` (and `ui.enabled`) without an onboarded `--gui` tier refuses, pointing at `things helpers setup --gui` — never a surprise dialog. The lab's in-guest direct driving keeps a documented escape hatch (`THINGS_API_UI_DIRECT=1`) that is not consumer surface.

## Article V — Ceremonies: idempotent, resumable, tiered, mode-aware

- **Idempotent + resumable**: already-satisfied legs are detected prompt-free and skipped; a partial ceremony exits nonzero naming what is outstanding, and rerunning resumes exactly there.
- **Tiered**: the base tier gathers read + write capability. The `--gui` tier adds Accessibility + Automation→System Events and sets `ui.enabled true` on success; `ui.enabled` already true implies the tier without the flag. Base-tier success hints at the tier ("some features drive the app window — `things helpers setup --gui`").
- **Mode-aware**: at a TTY the ceremony is a guided wizard — it explains each dialog before raising it ("a file panel will open; click Grant Access"), asks the tier question interactively, and waits at human pace. Non-TTY is strict mode: an upfront banner counts the dialogs about to be raised, waits are bounded, and an unanswered leg fails the run. No env-based agent sniffing anywhere — TTY-ness selects wizard vs strict *within* ceremonies only; ordinary commands behave identically for everyone (Article I makes agent detection unnecessary).
- **Denials are never auto-cleared**: a `-1743` means macOS will not re-ask; remediation copy names both the System Settings toggle and the `tccutil reset AppleEvents <id>` re-arm, and leaves the choice to the human.

## Article VI — An explicit `--db <path>` is outside the doctrine

A caller who hands us a database path (a Desktop copy, a backup, a lab artifact) gets plain file semantics: no capability gates, no ceremonies, no TCC vocabulary in errors — an unreadable file is an ordinary ENOENT/EPERM. The doctrine governs access to the *live library*, not files the user already owns.

## The four onboarding personas

| persona | path |
|---|---|
| TypeScript-only, no GUI-driving | host app FDA + `things setup` |
| TypeScript-only, wants GUI-driving | not supported directly (Article IV) → install helpers |
| Helpers, no GUI-driving | `things helpers setup` |
| Helpers, GUI-driving | `things helpers setup --gui` |

## Enforcement inventory

Article I/II are enforced by: read gating (container opens only behind reader-granted or FDA-probe capability), write gating (AppleScript vector only behind deputy-granted or TCC-introspected host grant; URL-scheme and Shortcuts vectors carry their own consent classes — inventory and gate likewise), MCP startup detection, doctor's provenance table, and refusal-copy regression tests. The banned outcome — a TCC dialog raised outside a ceremony — is the bug class this document exists to make reportable on sight.
