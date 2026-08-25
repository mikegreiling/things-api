# The helpers command surface and onboarding ceremony (`things helpers setup`)

**Status: shipped, helpers v1.3.0.** The design of record for the ONE sitting that settles every macOS permission the helper pair will ever need. Companion to [agent-daemon.md](agent-daemon.md) §3b/§3c (the pair itself) and [../lab/sandbox1-scoped-reader.md](../lab/sandbox1-scoped-reader.md) (the reader's scoped-read certification).

**Constitutional context: [permissions-doctrine.md](permissions-doctrine.md).** This ceremony is one of exactly TWO places in the package permitted to raise a macOS consent dialog (Article I); the other is `things setup`, the direct-path ceremony for the host app itself. The doctrine's Article III names the two provenances a grant can attach to — the helpers (here) or the host app — Article IV reserves the UI vector to the helpers, and Article V sets the ceremony rules this document implements (idempotent, resumable, tiered, mode-aware). Everywhere outside these two ceremonies, capability is detected prompt-free and a missing grant is refused with remediation rather than prompted for.

## The claim it makes

On a host where this ceremony has completed, **first-write consent prompts are extinct**. No `things` command — from a terminal, from an agent harness, from a launchd job — can raise a TCC dialog for the automation or file-read paths, because every event and every read is issued by a helper whose grants are already on record. The consent surface moved from "whichever process ran `things` this week" to two stable signed identities, and this ceremony is where those two identities collect what they need, while a human is sitting there.

That is the point of the whole helpers project stated as one testable sentence. Anything that reintroduces a mid-workflow prompt on an onboarded host is a bug against this document.

## The surface

Four subcommands, and no fifth (ratified 2026-08-24). `install`, `grant`, and `reset` are gone: the first two were always run back-to-back and the third was a `--revoke` flag wearing a command's clothes.

| command | what it does |
|---|---|
| `things helpers status` | prompt-free report: both halves' liveness, launchd registration, installed version, signing, the reader's grant, the deputy's TCC standing, and what routing resolved to on this machine. Read-only. |
| `things helpers restart` | `launchctl kickstart -k` both halves (picks up a rebuilt installed bundle). |
| `things helpers setup [--gui]` | install-or-update the bundle, then run the ceremony below. Idempotent end to end; `--bundle <path>` names a bundle explicitly; `--gui` adds the GUI-driving tier (§Tiers). **Exits nonzero while anything is outstanding** (§Exit semantics). |
| `things helpers uninstall [--revoke]` | stop both halves and remove their launchd registrations and the bundle. `--revoke` additionally revokes both identities' macOS grants and deletes their local state (§Uninstall and revocation). |

`setup` is one command because install and the ceremony are one intention. The install leg is a wholesale copy every time — install owns `<state>/deputy/bin/` outright — so "install" and "update" are the same operation, and on an already-current, already-granted machine the whole command is an all-skip no-op that raises nothing.

**Open naming question (for Mike, not implemented).** The top-level `things setup` (the bundled-Shortcuts importer) now sits awkwardly beside `things helpers setup` — two unrelated commands one word apart. Options: fold the Shortcuts import into the helpers ceremony's leg 5 (it deliberately does *not* run today, see below), rename the top-level one (`things shortcuts import`?), or leave both and accept the collision. Left open on purpose.

## Why the ceremony grew

The reader's folder panel used to be the whole of it. The remaining consents — Automation to Things, Automation to System Events, Accessibility — were left to be discovered the hard way: the first write of each kind stalled behind a modal, at whatever moment the user happened to be doing something else. The maintainer's framing (2026-08-22): *"Why can't we have the prompts all taken care of at the same time we register the reader?"*

They can, because macOS lets a process both **ask** for each of these and **check** each of them, and the deputy is the process that has to hold them. In 2026-08-24's reshape the install step joined them, so one command takes a machine from nothing to onboarded.

## The TCC facts this is built on

**Attribution.** An AppleEvent's Automation consent is recorded against the *responsible* code — the process that sent it, resolved to its signing identity. When the CLI sends the event itself, the record is against the terminal or agent runtime (and churns whenever that updates). When the deputy sends it, the record is against `Things API Helper.app`'s Developer ID signature, which is stable across rebuilds, restarts, reboots, and package upgrades. Every leg below therefore prompts *as the deputy*, which is the only reason a one-time ceremony is possible at all.

**Prompt-free status.** `AEDeterminePermissionToAutomateTarget(target, typeWildCard, typeWildCard, askUserIfNeeded: false)` answers from the existing consent record without showing anything. Its returns map to the four states the protocol carries (`deputy/src/tcc.swift`):

| return | state | meaning |
|---|---|---|
| `noErr` | `granted` | consent on record |
| `-1743` `errAEEventNotPermitted` | `denied` | the user (or MDM) said no; the dialog will not come back |
| `-600` `procNotFound` | `not-running` | target is down, so macOS has no answer to give |
| anything else (notably `-1744` `errAEEventWouldRequireUserConsent`) | `unknown` | never asked |

Only `granted` lets a leg be skipped. `not-running` and `unknown` both mean "ask" — the ceremony's benign event launches the target, which is exactly what has to happen for macOS to have an opinion.

`AXIsProcessTrusted()` is the equivalent prompt-free read for Accessibility.

Both ride the deputy's `hello` response (`axTrusted`, `automation.{things,systemEvents}`), so status, doctor, the routing gate, and the ceremony all read the same handshake and none of them can raise a dialog by asking.

**Prompting.** Automation consent is raised by *sending a real event* — there is no "ask without doing". The ceremony sends the most harmless event each target has: `tell application "Things3" to count of areas` and `tell application "System Events" to name of first process`. **Trap (hit live, 2026-08-24):** a handful of application-object properties — `version`, `name`, `id`, `running` — are answered *locally* by the AppleScript runtime from the target's bundle; no Apple event is dispatched, so no dialog is raised and no grant is minted while the script still exits 0. The first ceremony probed `version` and reported a grant it never obtained; the first real write then prompted. Two defenses now stand: the probe is a genuine event (`count of areas`), and a 0 exit is no longer believed on its own — the leg re-reads `AEDeterminePermission` off a fresh hello and reports only what macOS reports (an old deputy without the hello fields keeps the 0-exit best-effort reading). The request blocks while the dialog is up, so answering it right there completes the leg in the same breath. Accessibility is different in kind: `AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt: true])` shows a dialog that only *offers* a Settings deep-link — the grant itself is a switch the user flips in System Settings ▸ Privacy & Security ▸ Accessibility, and it can only arrive later. So that leg is fire-and-forget plus a poll.

**The rendezvous is not a TCC fact at all — and that is new (helpers 1.3.0, 2026-08-24).** How a client FINDS the reader used to be a consent question, because the reader bound its own socket and a sandboxed process can only bind inside its container: `stat`ting `~/Library/Containers/com.pixelcog.things-reader/Data/reader.sock` was a cross-app container access, the same `kTCCServiceSystemPolicyAppData` class that guards the Things data folder, evaluated against the calling app's lineage. Under a terminal with Full Disk Access macOS answered it silently, so nothing showed for the whole arc; from a sandboxed host it was a modal outside any ceremony, and a *Don't Allow* turned the token read into a raw EPERM.

So the rendezvous moved out. The reader binds its socket ITSELF at `<state>/reader/reader.sock` under a raw-SBPL network-bind entitlement plus a file exception for that one directory (launchd socket activation is unusable from inside the App Sandbox — error 159, measured), and its LaunchAgent carries the access token in `EnvironmentVariables`, minted by the installer, which writes the matching 0600 file for clients beside the socket. Both files are ordinary things this user owns. **Reaching the helpers now costs the caller nothing**, which is what the pair was always supposed to buy: the helpers hold the durable grant, and no host app needs one of its own to talk to them. Mechanics in [agent-daemon.md](agent-daemon.md) § The rendezvous; the container placement and its symptoms are on record in [permissions-doctrine.md](permissions-doctrine.md) § RESOLVED 2026-08-24.

## The ceremony

`setup` installs first, so by the time the ceremony starts the bundle is on disk and launchd has been told to (re)start both halves. The channel therefore waits up to 15s for the deputy's socket to reappear rather than refusing a helper that is still coming up; after that it reports loudly. There is no partial ceremony against a helper that isn't there.

**The upfront banner.** Before the first leg runs, the ceremony surveys — entirely prompt-free — which legs are about to put something on screen, and says so: *"about to raise 3 macOS consent dialogs (the reader's folder panel, app control for Things, the Accessibility switch) — someone must be at the screen to answer them."* Nothing has been raised at the point that line prints, which is the whole value: whoever started the command learns they need to be present *before* a modal is waiting on them. A leg macOS already records as `denied` is NOT counted — its dialog is spent and will not reappear — and when the count is zero the banner says so instead (*"nothing to raise — every permission the helpers need is already on record"*). The survey rides `hello` and the reader's `granted`+`locate` probe, so it costs nothing and cannot prompt. It is carried in the result as `outstanding[]`.

| # | leg | already-granted signal (prompt-free) | how it is raised | outcomes |
|---|---|---|---|---|
| 1 | reader read grant | reader `hello.granted` AND a `locate` that resolves a database inside the granted scope | the reader's own `NSOpenPanel`, opened inside the Things data folder | `granted` · `pending` (canceled/timed out) · `skipped-not-installed` (bundle built without an Apple-issued chain) |
| 2 | automation → Things | `hello.automation.things === "granted"` | `tell application "Things3" to count of areas` through the deputy's `osascript` verb, 120s | `granted` (confirmed by a post-probe `AEDeterminePermission` re-read) · `denied` (-1743) · `pending` (unanswered, or probe-ok-but-no-grant) |
| 3 | automation → System Events | `hello.automation.systemEvents === "granted"` | `tell application "System Events" to name of first process`, same shape | as above |
| 4 | accessibility | `hello.axTrusted === true` | deputy `prime-ax` verb, then the Settings deep-link, then poll `hello.axTrusted` every 2s for 120s | `granted` · `pending` (not toggled yet) |
| 5 | shortcuts | — | `shortcuts list` through the deputy, compared against the six bundled `things-proxy-*` names | `granted` (all present) · `skipped-not-installed` (names the missing ones) |

Legs 3 and 4 are the **GUI tier** and run only when it was asked for — see §Tiers below. The banner counts only the legs the selected tier will actually run.

## Tiers — the base sitting, and the GUI one (Article V)

Legs 3 and 4 are the **GUI tier**, and they run only when GUI-driving was asked for. They are the two widest grants the pair ever holds — Accessibility lets the helper read and press any app's UI, and Automation → System Events is the delivery mechanism for it — and most households never drive the Things window at all. Gathering them by default would mean asking every user for the biggest grant in the set to enable a capability they are not using, which is precisely the "ask for everything up front" instinct the least-privilege half of Article III exists to resist.

| tier | legs | how it is selected |
|---|---|---|
| **base** (default) | 1 reader read grant · 2 automation → Things · 5 shortcuts | nothing asked for |
| **gui** | base plus 3 automation → System Events · 4 accessibility | `--gui`, OR `ui-enabled` already true, OR a yes to the wizard's question |

Three ways in, one meaning. The flag is the non-interactive spelling (`--yes`-style tier selection is the flag, and nothing else — there is no env sniffing anywhere). **`ui-enabled` already true implies the tier without the flag** (Mike's ruling): a machine that has opted into GUI-driving is asking for the grants by definition, and the ceremony says so rather than doing it silently — *"ui.enabled is on — including GUI-driving permissions."* At a TTY with neither signal, the wizard asks:

> Some Things features have no programmatic surface and are driven through the app's own window (editing repeat rules, reordering areas). Enable GUI-driving permissions? [y/N]

**A completed GUI tier turns `ui-enabled` on** and says so (*"GUI-driving turned on in config (`ui-enabled` is now true)"*) — the capability you just granted is the capability the engine will use. Only on FULL success: switching the key on over a half-granted tier would manufacture exactly the "enabled but refuses" state Article IV exists to prevent.

**A base-tier success hints at the tier, once:**

> GUI-driving is not set up — some features drive the app window (repeat-rule edits, area reorder); run `things helpers setup --gui` to enable.

Under `--json` every step carries its `tier`, and the result carries `tier`, `guiRequestedBy` (`flag` | `config` | `wizard` | `null`) and `uiEnabledSet`.

## Wizard mode — at a TTY, the ceremony explains itself (Article V)

When stdin *and* stderr are terminals, both ceremonies run as a guided sitting through one shared module (`src/wizard.ts`). Before each leg that is actually going to raise something — the upfront survey already knows which — it prints one plain-language explainer in the words macOS will use, and waits for Enter:

```
Next: permission for the helper to control Things.
  A macOS dialog will appear: "Things API Helper" wants access to control "Things" —
  click Allow. Things opens if it was closed; that is expected.
  press Enter when you are ready (Ctrl-C to stop — rerunning resumes here)
```

The reader's leg is described as what it actually is (*a file panel opens, already inside the Things data folder — click Grant Access*), and Accessibility as what it actually is (*a switch you flip in System Settings, not a dialog you answer, so setup waits and watches for it*). A leg that will be skipped is never explained.

Off a TTY it is **strict mode, unchanged**: no explainers, no gates, the upfront banner's count stands alone, waits stay bounded, and an unanswered leg fails the run. TTY-ness is the only signal, it is consulted **inside these two ceremonies only**, and there is no env-based agent detection anywhere in the package — Article I makes it unnecessary, because no ordinary command can raise a dialog for an agent to hang on.

Leg 5 deliberately does **not** run `things setup` — that opens an import screen per shortcut, which is a different kind of interruption and the user's call. It reports and points. It also does not run a proxy end-to-end: the input/output-path plumbing buys nothing the census does not already prove.

## Idempotency — the property that makes rerunning safe

Every leg is gated on a signal read without prompting, so **a rerun on a fully onboarded host raises nothing**. The only request such a rerun makes is the shortcuts census; no AppleEvent is sent, no `prime-ax` is called, no panel opens, and the report comes back all-green. This is asserted directly in `test/unit/helpers-onboard.test.ts` ("the ONLY request a green rerun may make is the shortcuts census").

That property is what lets `setup` be the standing answer to "did onboarding finish?" — the user can run it any time, including after a `tccutil reset`, a macOS major, or a new Things version, and it will do exactly the work that is still outstanding. The install leg is idempotent in the same spirit (a fresh wholesale copy, no migration logic), so rerunning `setup` after every rebuild is the intended flow.

## Exit semantics

**A setup that ends with anything outstanding exits nonzero** (`ExitCode.Environment`) — `pending` as well as `denied` (Mike's ruling, 2026-08-24; this REVERSES the v1.2.0 rule that `pending` exited 0).

`pending` is still a human-pace outcome and still resumable: a dialog left unanswered, a switch not yet flipped, a panel dismissed. Nothing is broken and rerunning picks up exactly there. But it is also an **unfinished setup**, and the caller that most needs to know is an agent driving `things helpers setup` for a human who has wandered off. Exit 0 told that agent the machine was ready when it was not. The closing line names what is outstanding and says that rerunning resumes there:

> setup did not finish — accessibility still needs you. Rerun `things helpers setup` to resume exactly there; everything already granted is skipped.

A `denied` leg names **both** ways out, always together: the System Settings ▸ Privacy & Security ▸ Automation ▸ *target* switch, and `tccutil reset AppleEvents com.pixelcog.things-api-helper` to re-arm the dialog. The ceremony never clears a denial itself — throwing away a recorded refusal is the user's call, not a tool's.

Exit **0** requires an all-granted ceremony, where `skipped-not-installed` counts as granted: a reader that was never built (no Apple-issued signing chain on the build host) and missing bundled shortcuts are both legitimate configurations with working direct fallbacks.

## Old helpers

The new `hello` fields and the `prime-ax` verb are **additive** — `DEPUTY_PROTOCOL_VERSION` is unchanged, because an old CLI ignores unknown fields and a new CLI must not assume them. Against a deputy older than 1.2.0: absent fields read as *unknown* (never as `false`), every leg is attempted rather than skipped, `prime-ax` comes back `bad-request` and leaves Accessibility `pending`, and the existing version-drift line tells the user to rebuild and reinstall. Nothing is guessed about a helper that did not answer the question.

## The routing gate — no "installed but unpermissioned" auto state

Under `helpers-enabled: auto`, installed-and-healthy is **not** enough to carry traffic (ruling 2026-08-24). Routing writes through a deputy that has no app-control grant does not move the consent surface anywhere — it relocates the dialog onto the helper, where nobody is watching for it, which is the exact failure mode this whole pair exists to end. So `auto` engages only when the requisite grant is on record, and the halves are gated **independently along the seams they already had**:

| half | verbs | requisite | gate site |
|---|---|---|---|
| deputy | `osascript`, `shortcuts` (writes) | `hello.automation.things === "granted"` | `activate()` in `src/deputy/routing.ts` |
| reader | `sql`, `read-file`, `locate` (reads) | the reader's own `granted` bookmark | `activateReader()` / `fileTransport()` |

Reads were already gated on the reader's bookmark, so the new gate is the deputy's. A machine that finished half the ceremony gets exactly the half it earned: a granted reader serves reads while an unonboarded deputy stays dormant and writes run direct.

`axTrusted` and `automation.systemEvents` are deliberately **not** requisite — the UI vector is separately double-gated and refuses on its own, so holding all routing hostage to the Accessibility switch would punish a machine for a capability it is not using.

An OLD deputy whose `hello` carries no TCC fields is **not provably onboarded**, so `auto` fails CLOSED there rather than guessing, with the version-drift line pointing at a rebuild. Mode `true` is an explicit instruction and routes regardless (loud on failure, unchanged); mode `false` never routes.

A dormant machine is never silent about it. The routing layer spends its one stderr notice on a line naming `things helpers setup`, `things helpers status` renders `routing: auto — dormant: onboarding incomplete (missing: automation → Things (unknown))` against `auto — routing (onboarded)`, and doctor's helpers section carries the same reason through `helpersRouting().deputyReason`. (The disk-only passive notice in `src/deputy/notices.ts` cannot see grant state — it computes without a handshake by design — so the loud line is the routing layer's, emitted through the shared one-notice-per-process channel in `src/deputy/notice.ts`.)

## Where the copy lives

The per-step progress lines and the closing report are **runtime output**, not description copy, so they may name mechanisms as operational fact ([surface-copy.md](surface-copy.md) §Scope). Under `--json` the progress lines move to stderr and stdout carries the `helpers-setup` envelope alone: `install` (the install result) and `ceremony` (`steps[]` — leg, label, **tier**, state, `alreadyGranted`, detail — plus `outstanding[]`, `tier`, `guiRequestedBy`, `uiEnabledSet`, `denied`, `pending`, `closing`). The wizard's explainers and questions always go to stderr, so `--json` stdout stays the envelope alone in wizard mode too. `uninstall --json` carries a `helpers-uninstall` envelope: `removed[]`, `warnings[]`, and `revocation` (null unless `--revoke`).

## Uninstall and revocation (`things helpers uninstall [--revoke]`)

**Plain uninstall keeps everything that was expensive to get.** It stops both halves, removes the two LaunchAgents and the installed bundle, and stops there: the local state (tokens, logs, the reader's bookmark) stays, and the macOS grants stay on record. TCC rows are keyed to the two *signing identities*, not to a path or an installation, so they simply go dormant — a later `things helpers setup` picks them straight back up with no second ceremony. Routing config is untouched; commands fall back to direct execution. No confirmation is asked for, because nothing irreversible happens.

**`--revoke` is the ceremony's full inverse**, and the one thing here that needs a confirmation gate (type `revoke`, or `--yes`; `--json` requires `--yes`). Its order is load-bearing:

1. **Revoke first, while a bundle still resolves.** `tccutil reset All <id>` resolves the identifier through LaunchServices and refuses with `-10814` (`kLSApplicationNotFoundErr`) once no app on disk carries it. So both identities (`com.pixelcog.things-api-helper`, `com.pixelcog.things-reader`) are reset *before* the uninstall tears the bundle down.
2. **When nothing is installed, register the packaged bundle first.** MEASURED on a live host 2026-08-24: `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f -R "<packaged bundle>"` — the bundle `helpersDefaultBuildPath()` resolves, prebuilt or build — makes **both** identifiers resolvable again (the reader nests inside the helper bundle, so one registration covers the pair), after which `tccutil reset All` succeeds for each. The bundle is left registered: the file legitimately exists, so `lsregister -u` afterwards would be a lie about the machine. This is what makes `--revoke` idempotent from a machine that was already uninstalled — Mike's explicit pin.
3. **With no bundle anywhere**, the resets still run (LaunchServices may hold an older registration) and a `-10814` is reported as the honest limit it is: *no app carries this identifier and none is packaged here — reinstall the helpers, or clear the grants in System Settings ▸ Privacy & Security*. Never a warning; nothing is broken.
4. **Then delete the local state** — the reader's container (the read grant is a security-scoped bookmark FILE, so revoking it means deleting it), the reader's rendezvous directory (`<state>/reader`: the access token), and the deputy's state dir (tokens, logs).

Idempotent by construction: every leg is independent and best-effort, absent directories are fine, `-10814` with a bundle in hand is the no-op it looks like, and a rerun is an all-no-op exit 0. Two honest limits stay: the bundled `things-proxy-*` shortcuts have no removable tool surface (Apple's `shortcuts` CLI has no delete) and are reported as a manual Shortcuts.app step, and one legacy path-keyed AppData row from the pre-bundle layout is invisible to `tccutil`'s bundle-id addressing (harmless). System Settings may show stale rows until reopened.
