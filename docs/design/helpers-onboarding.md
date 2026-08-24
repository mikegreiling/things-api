# The helpers onboarding ceremony (`things helpers grant`)

**Status: shipped, helpers v1.2.0.** The design of record for the ONE sitting that settles every macOS permission the helper pair will ever need. Companion to [agent-daemon.md](agent-daemon.md) §3b/§3c (the pair itself) and [../lab/sandbox1-scoped-reader.md](../lab/sandbox1-scoped-reader.md) (the reader's scoped-read certification).

## The claim it makes

On a host where this ceremony has completed, **first-write consent prompts are extinct**. No `things` command — from a terminal, from an agent harness, from a launchd job — can raise a TCC dialog for the automation or file-read paths, because every event and every read is issued by a helper whose grants are already on record. The consent surface moved from "whichever process ran `things` this week" to two stable signed identities, and this ceremony is where those two identities collect what they need, while a human is sitting there.

That is the point of the whole helpers project stated as one testable sentence. Anything that reintroduces a mid-workflow prompt on an onboarded host is a bug against this document.

## Why the grant command grew

`things helpers grant` used to be the reader's folder panel and nothing else. The remaining consents — Automation to Things, Automation to System Events, Accessibility — were left to be discovered the hard way: the first write of each kind stalled behind a modal, at whatever moment the user happened to be doing something else. The maintainer's framing (2026-08-22): *"Why can't we have the prompts all taken care of at the same time we register the reader?"*

They can, because macOS lets a process both **ask** for each of these and **check** each of them, and the deputy is the process that has to hold them.

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

Both ride the deputy's `hello` response (`axTrusted`, `automation.{things,systemEvents}`), so status, doctor, and the ceremony all read the same handshake and none of them can raise a dialog by asking.

**Prompting.** Automation consent is raised by *sending a real event* — there is no "ask without doing". The ceremony sends the most harmless event each target has: `tell application "Things3" to count of areas` and `tell application "System Events" to name of first process`. **Trap (hit live, 2026-08-24):** a handful of application-object properties — `version`, `name`, `id`, `running` — are answered *locally* by the AppleScript runtime from the target's bundle; no Apple event is dispatched, so no dialog is raised and no grant is minted while the script still exits 0. The first ceremony probed `version` and reported a grant it never obtained; the first real write then prompted. Two defenses now stand: the probe is a genuine event (`count of areas`), and a 0 exit is no longer believed on its own — the leg re-reads `AEDeterminePermission` off a fresh hello and reports only what macOS reports (an old deputy without the hello fields keeps the 0-exit best-effort reading). The request blocks while the dialog is up, so answering it right there completes the leg in the same breath. Accessibility is different in kind: `AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt: true])` shows a dialog that only *offers* a Settings deep-link — the grant itself is a switch the user flips in System Settings ▸ Privacy & Security ▸ Accessibility, and it can only arrive later. So that leg is fire-and-forget plus a poll.

## The ceremony

Preflight refuses loudly — pointing at `things helpers install` — when the bundle is not installed or the deputy does not answer. There is no partial ceremony against a helper that isn't there.

| # | leg | already-granted signal (prompt-free) | how it is raised | outcomes |
|---|---|---|---|---|
| 1 | reader read grant | reader `hello.granted` AND a `locate` that resolves a database inside the granted scope | the reader's own `NSOpenPanel`, opened inside the Things data folder | `granted` · `pending` (canceled/timed out) · `skipped-not-installed` (bundle built without an Apple-issued chain) |
| 2 | automation → Things | `hello.automation.things === "granted"` | `tell application "Things3" to count of areas` through the deputy's `osascript` verb, 120s | `granted` (confirmed by a post-probe `AEDeterminePermission` re-read) · `denied` (-1743) · `pending` (unanswered, or probe-ok-but-no-grant) |
| 3 | automation → System Events | `hello.automation.systemEvents === "granted"` | `tell application "System Events" to name of first process`, same shape | as above |
| 4 | accessibility | `hello.axTrusted === true` | deputy `prime-ax` verb, then the Settings deep-link, then poll `hello.axTrusted` every 2s for 120s | `granted` · `pending` (not toggled yet) |
| 5 | shortcuts | — | `shortcuts list` through the deputy, compared against the six bundled `things-proxy-*` names | `granted` (all present) · `skipped-not-installed` (names the missing ones) |

Leg 5 deliberately does **not** run `things setup` — that opens an import screen per shortcut, which is a different kind of interruption and the user's call. It reports and points. It also does not run a proxy end-to-end: the input/output-path plumbing buys nothing the census does not already prove.

## Idempotency — the property that makes rerunning safe

Every leg is gated on a signal read without prompting, so **a rerun on a fully onboarded host raises nothing**. The only request such a rerun makes is the shortcuts census; no AppleEvent is sent, no `prime-ax` is called, no panel opens, and the report comes back all-green. This is asserted directly in `test/unit/helpers-onboard.test.ts` ("the ONLY request a green rerun may make is the shortcuts census").

That property is what lets the ceremony be the standing answer to "did onboarding finish?" — the user can run it any time, including after a `tccutil reset`, a macOS major, or a new Things version, and it will do exactly the work that is still outstanding.

## Exit semantics

`pending` is a **human-pace** outcome, not a failure: a dialog left unanswered, a switch not yet flipped, a panel dismissed. The ceremony exits **0** on it, because the remedy is "finish the thing and rerun", not "something is broken". Only `denied` — macOS or the user actually refusing — exits nonzero (`ExitCode.Environment`), alongside a preflight refusal or a transport error.

`skipped-not-installed` is also exit 0: a reader that was never built (no Apple-issued signing chain on the build host) and missing shortcuts are both legitimate configurations with working direct fallbacks.

## Old helpers

The new `hello` fields and the `prime-ax` verb are **additive** — `DEPUTY_PROTOCOL_VERSION` is unchanged, because an old CLI ignores unknown fields and a new CLI must not assume them. Against a deputy older than 1.2.0: absent fields read as *unknown* (never as `false`), every leg is attempted rather than skipped, `prime-ax` comes back `bad-request` and leaves Accessibility `pending`, and the existing version-drift line tells the user to rebuild and reinstall. Nothing is guessed about a helper that did not answer the question.

## Where the copy lives

The per-step progress lines and the closing report are **runtime output**, not description copy, so they may name mechanisms as operational fact ([surface-copy.md](surface-copy.md) §Scope). Under `--json` the progress lines move to stderr and stdout carries the `helpers-onboard` envelope alone: `steps[]` (leg, label, state, `alreadyGranted`, detail), `denied`, `pending`, `closing`.
