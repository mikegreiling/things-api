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

**Amendment (2026-08-24, Mike) — ground truth, never a marker.** Capability answers come from the SOURCE at use time, never from a recorded "onboarded" state, which can drift the moment anything outside our flows revokes or relocates a grant:

- *Helpers reads*: there is no pre-read probe, because the read itself is the check — the reader live-resolves its security-scoped bookmark per request and opens the actual database file, returning typed `not-granted`/`not-found` errors. When the helpers are ENABLED (mode `true`, or `auto` with the bundle installed), a reader access failure fails the read LOUDLY, naming `things helpers setup` — never a silent fall-through to direct. Direct is `auto`'s answer only when the helpers are absent.
- *Direct reads*: the FDA probe runs per invocation (one silent `open()`, microseconds — no persistent cache). The session app-data grant (the "access data from other apps" modal) is NOT prompt-free-detectable — TCC asks on access by design, and the grant is measured allow-once-per-responsible-process-instance — so it is supported only through an INSTANCE-SCOPED record written by `things setup` at the moment the ceremony deliberately provokes the modal, keyed to the responsible app's (pid, pid start time, boot time). The record cannot outlive the fact it describes — the grant dies with the app instance, and so does the key. Known, documented hole: an external mid-session `tccutil reset` re-arms the prompt on the next open; that is user-caused and stands as the doctrine's one best-effort edge.
- The read preflight is stateless and runs before every read; its cost budget is microseconds (one `open()`, one `stat`+`sysctl`), and the helpers case adds nothing at all.

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

### What is enforced today (Wave A, 2026-08-24)

The single verdict source is `src/capability.ts`; the marker backing the sub-FDA tier is `src/session-grant.ts`; the ceremony is `src/direct-setup.ts`.

| Surface | Gate | Where |
|---|---|---|
| Reads (library, so every CLI + MCP read) | `readCapability` at `openThings`, BEFORE the discovery glob — the glob is itself a container access | `src/client.ts` |
| `things doctor` | the same gate, plus the verdict rendered as `host app` / `read access` / `app control` rows; refuses with remediation instead of opening the container | `src/diagnose.ts`, `src/cli/commands/doctor.ts` |
| AppleScript vector | `writeCapability` pre-dispatch; `direct-denied` and `direct-unknown` both BLOCK (`environment`) with remediation, before the app is touched | `src/write/pipeline.ts` (step 5c) |
| `things --help` | the autodetectable stanza naming both provenances + the detected host | `src/cli/help.ts` |
| Refusal copy | pinned by regression cells | `test/cli/permission-gates.test.ts`, `test/engine/write-capability-gate.test.ts` |

**Read capability is ground truth per invocation.** Nothing is memoized across calls and no "onboarded" flag is ever stored — the common path costs one `open(2)`. The helpers path adds nothing at all: the reader resolves its security-scoped bookmark on every verb and returns typed `not-granted` / `not-found` errors, so *the read is the check*. Consequently there is a **no-fallback rule**: when the helpers are expected (mode `true`, or `auto` with the bundle installed) and cannot serve, the read fails loudly rather than silently re-attaching consent to the terminal. Direct fallback under `auto` exists only when the helpers are absent.

**The sub-FDA tier.** The "would like to access data from other apps" grant (`kTCCServiceSystemPolicyAppData`) is not detectable without FDA — TCC's ask-on-access design means the only way to learn whether you hold it is to open the file, and the open is the modal. It is therefore *witnessed*, not detected: `things setup` provokes it deliberately, and on success records a marker keyed to (host bundle id, host pid, that pid's start time, boot time). The marker self-invalidates when the app instance dies, because the grant dies with it. **Known hole:** a `tccutil reset` performed by the user mid-session revokes the grant while the app keeps running, so the marker stays valid and the next container open re-prompts. That is user-caused and visible; it is not worked around.

### Consent classes per write vector

| Vector | macOS consent class | Gated how |
|---|---|---|
| **AppleScript** | `kTCCServiceAppleEvents` (client = host app or deputy, target = `com.culturedcode.ThingsMac`) | Wave A gate above. Prompt-free standing from the deputy handshake, or from the host's own TCC Automation row |
| **URL scheme** | **none** — `open -g things:///…` is a LaunchServices dispatch, not an Apple Event; it needs no Automation grant and no FDA | The only consent is *Things' own* in-app authorization, the "Enable Things URLs" setting. Its state is already read prompt-free off disk (`uriSchemeEnabled` in the group-container prefs plist) by `readUrlSchemeEnabled()`, reported by `doctor`, and used for failure attribution. An untouched install has no key at all, and the app then holds the first URL command behind its own enable dialog — raised by Things, not by TCC, so it is outside this doctrine's scope. Nothing further to gate |
| **Shortcuts** | **none** — the `shortcuts` CLI talks to the Shortcuts service directly | Consent is *Shortcuts'* own per-shortcut authorization on first run ("Always Allow"), already pre-gated prompt-free on proxy presence (`shortcuts list`, then a blocked result naming `things setup`). The two delete proxies re-ask on every run by design; Apple offers no always-allow for deletion |
| **UI (Accessibility)** | `kTCCServiceAccessibility` + Automation → System Events | Helpers-only (Article IV). Unchanged in Wave A; enforcement is Wave B |

### Not yet enforced (Wave B)

The helpers `--gui` tier and its ceremony, the TTY wizard of Article V (Wave A ships strict mode only), UI-requires-helpers enforcement, MCP startup baking, and doctor's fuller per-vector provenance table.

### Measured: the direct Automation probe is not reachable from JXA

Article III names `AEDeterminePermissionToAutomateTarget(askUserIfNeeded: false)` as the direct-path probe, which is what the deputy calls (`deputy/src/tcc.swift`). From a JXA/ObjC host it is **not usable**: JavaScriptCore's bridge cannot marshal an `AEDesc` struct. Measured 2026-08-24 on macOS 24.6 — `AECreateDesc` fills an untyped `Ref()`, but passing that Ref to any function taking `^{AEDesc=…}` throws "Ref has incompatible type" (every explicit type spelling fails at creation too), and the one form the bridge accepts — `ref[0]`, a dereferenced copy — arrives zeroed: `AEGetDescDataSize` reports 0 bytes for a 36-byte bundle id, and every target then answers `-50` paramErr. The call is prompt-free but returns the same wrong answer for every input, so it is not shipped. Direct Automation standing instead comes from **TCC introspection** — the other probe the Article I corollary names — reading the `kTCCServiceAppleEvents` row for (host bundle id → Things) out of the same TCC database the FDA probe opens. Equally prompt-free, and free of extra cost because direct mode's floor is FDA anyway. Where the row cannot be read the verdict is an honest `direct-unknown`, which refuses rather than resolving with a dialog.
