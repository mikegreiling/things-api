# HELPGST1 — the helper pair, installed and granted INSIDE the guest

**Probed under `things-lab-golden-v4` · Things 3.23 (build 32300036) · DB v27 · macOS 15.7.7 · pinned clock 2026-07-05 · helpers 1.4.0 · package 0.20.8 (2026-09-03).** Output: the new golden **`things-lab-golden-v4h`**, and the ROUTED arm of `npm run lab:regress`.

## The gap this closes

Every lab arm the harness has ever run executed its scripts **direct** — in the guest's own sshd-descended shell, under the AXVM1 grant, with `THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1` restoring the vectors a bare golden cannot hold. Every FIELD host does the opposite: the same primitives are brokered by `things-deputy`, reads are served by the sandboxed `things-reader`, and the grants belong to a signed bundle rather than to whatever ran `things`.

"Which identity executes this script" was therefore a certification dimension with exactly one value, and two releases shipped through the blind spot inside five weeks:

- **0.19.2** — a window/focus census that stalled ~15 s per inspection on real hardware and did not reproduce headless at all ([fgrd2-census-hardening](fgrd2-census-hardening.md), [#629](https://github.com/mikegreiling/things-api/issues/629)).
- **0.20.7** — the AX settle sidecar reached its socket through `do shell script`, which the deputy's broker refuses **by design** (`scriptGuard`, `deputy/src/server.swift`). Green on every lab probe; dead on every helpers-enabled Mac ([#695](https://github.com/mikegreiling/things-api/issues/695), hotfixed in #698, then hosted inside the deputy by [DEPOBS1](depobs1-deputy-observer.md)).

Until this campaign the routed half of the release gate had nowhere to run but the maintainer's own machine, and on 2026-09-03 a delegate did exactly that — GUI-driving his production Things while he was working at it. His ruling, which this campaign implements: **all automated testing runs in a guest OS in the VM; production is never a test target.**

## What was actually hard — and what turned out not to be

| | Expected | Measured |
|---|---|---|
| Building the bundle in the guest | needs a Swift toolchain + a Developer ID identity, neither of which a clone has | **not needed.** The bundle is built and signed on the HOST and crosses the airgap like node + dist. `scp` sets no `com.apple.quarantine`, so Gatekeeper never holds it (0 xattrs measured) and launchd runs it unremarkably |
| `launchctl bootstrap gui/<uid>` from an sshd session | the classic "wrong bootstrap domain" failure | **works.** `things helpers setup` bootstrapped both LaunchAgents over ssh on the first attempt; the guest auto-logs-in, so there is a real Aqua session for `gui/501` to name |
| The four consent prompts | a human at a VNC screen | **fully scriptable** under the golden's existing AXVM1 Accessibility grant — see the recipe below. No human clicked anything |
| Making the grants durable | the hard part | **it is the easy part, once given.** A TCC row is keyed to the client's code-signing REQUIREMENT (bundle id + team), not a file hash |

## The grant recipe (all four legs, driven over ssh)

`things helpers setup --gui` runs the legs serially and blocks on each. The driver runs it in one shell and answers from another; `lab/scripts/helpers-bake.sh` wraps both halves, and `lab/guest/ax-any.jxa` is the process-agnostic AX tool the answers go through (the lab's existing `axtool.jxa` is hard-pinned to Things3, and not one of these dialogs belongs to Things).

The guest's screen is **1024×768 logical with `backingScaleFactor` 2**, so a point read off a `screencapture` frame is HALVED before it is posted. That conversion is the whole trick to the coordinate legs.

| Leg | Owner | How it was answered |
|---|---|---|
| **reader read grant** | AppKit's out-of-process open-panel service | The panel opens already inside the Things group container, so *Grant read access* is the only click. It is **invisible to AX**: `things-reader` reports zero windows and so does `com.apple.appkit.xpc.openAndSavePanelService`, so this leg is a raw `CGEventPost` at a coordinate read off a screenshot — the one place in the ceremony where AX addressing is unavailable |
| **automation → Things** | the system consent alert | *Allow* pressed by `CGEventPost` at the screenshot coordinate. The alert is likewise not enumerable through the usual `procs` census (it belongs to no foreground application), so it is answered by coordinate too |
| **automation → System Events** | the system consent alert | identical, one dialog later |
| **accessibility** | System Settings ▸ Privacy & Security ▸ Accessibility | **This one has a trap, below.** The row's switch is `AXCheckBox`/`AXSwitch` with `AXIdentifier` = `Things API Helper_Toggle`; the commit needs the admin auth sheet (`admin`, then Return) |

### The trap: an `AXPress` on the Accessibility switch flips the UI and grants NOTHING

`AXUIElementPerformAction(switch, AXPress)` returns `AXError=0`, the switch's `AXValue` goes `0 → 1`, the pane looks exactly like a granted machine — and the SYSTEM `TCC.db` row stays `auth_value = 0`. No auth sheet is raised, the deputy's `AXIsProcessTrusted()` never flips, and the ceremony times out at 120 s reporting *"still off"* while the screen says otherwise.

A **synthetic click at the switch's own AX frame** takes the other path: the auth sheet (*"Privacy & Security is trying to modify your system settings"*) appears, the password commits it, and the row goes to `auth_value = 2`. So:

> **A privacy switch is only granted when the TCC row says so.** Read the row, never the widget — an `AXPress` on a System Settings privacy toggle is a UI-only mutation, and the pane's own rendering is not evidence. This is the [CNCAC1](cncac1-after-completion-checkoff.md)/[URLEN1](urlen1-url-scheme-consent.md) law again, in a new pane: an oracle that has never been shown its opposite proves nothing.

The corollary for any future ceremony driver: **AX-press the buttons, real-click the switches.** Buttons in a consent alert commit on `AXPress` (the two Automation legs prove it); a privacy switch does not.

The deputy also needs a **restart** after the Accessibility row lands (`things helpers restart`); the re-run of `helpers setup --gui` then reports *"nothing to raise — every permission the helpers need is already on record"* and turns `ui-enabled` on.

### The state a granted guest holds

```
USER   TCC.db  kTCCServiceAppleEvents    com.pixelcog.things-api-helper  2  com.culturedcode.ThingsMac
USER   TCC.db  kTCCServiceAppleEvents    com.pixelcog.things-api-helper  2  com.apple.systemevents
SYSTEM TCC.db  kTCCServiceAccessibility  com.pixelcog.things-api-helper  2
```

plus the reader's security-scoped bookmark inside `~/Library/Containers/com.pixelcog.things-reader/Data` (not a TCC row — a bookmark the sandboxed process minted for itself, which is exactly why the panel must be presented BY the reader). The six proxy shortcuts were already in golden-v4 and are inherited.

`things doctor` in the granted guest, which is the whole point of the campaign in five lines:

```
read access: helpers — database reads are served by the sandboxed reader
app control: deputy — the deputy is onboarded and holds app control for Things
  read         helpers    reader bookmark (things-reader)
  applescript  deputy     deputy TCC Automation (Things API Helper)
  ui           helpers    deputy TCC Accessibility + System Events (Things API Helper)
```

## Grants survive a rebuild — which is what makes the golden a LAYER

The row is keyed to the signing requirement, so a rebuilt bundle with the same identity (`com.pixelcog.things-api-helper`, team `VNJWARH2W7`, Developer ID) inherits every grant. Measured three ways in this campaign, in ascending strength:

1. A second `helpers setup --gui` inside the bake sitting — which **deletes and re-creates the install dir wholesale** and re-copies the bundle — reported every leg *already granted* and raised nothing.
2. Every later routed clone re-runs that install over a bundle shipped fresh from the host, and `helpers status` reads `granted` on all four legs before a single probe runs.
3. A deliberately **rebuilt** bundle (new `swiftc` output, new signature, new file hash, same identity) installed into a v4h clone and drove the GUI leg green.

Had any of these failed, the design would have had to change (a golden per bundle build, which is unaffordable). They did not.

## `things-lab-golden-v4h`

Cut exactly the way v2 added the AXVM1 L3 layer over v1: clone the active golden, configure it in place, quit the app, shut the guest down cleanly, and `tart clone` the STOPPED clone to the golden name. The result is never booted.

- **Cost on disk: ~0.** APFS copy-on-write means the new golden shares v4's blocks; `df` on `/Volumes/Workspace` read **22 GiB free before the clone and 22 GiB after**. A helpers layer is a few tens of megabytes of bundle, plists and TCC rows.
- **Config left at the golden defaults** — `helpersMode: auto`, `uiEnabled: false`. Each arm sets what it needs; a golden that arrived pre-routed would hide a provisioning step that failed.
- **The `~/things-lab` staging directory is deleted before the bake**, so a clone that forgets to ship its own `dist` fails loudly instead of certifying a stale build.
- The Things database, fixtures and AXVM1 layer are inherited from v4 untouched.

Recipe: [`lab/scripts/helpers-bake.sh`](../../lab/scripts/helpers-bake.sh) (`boot` · `up` · `setup` · `ax` · `shot` · `tcc` · `status` · `bake` · `down`).

## The routed arm

`npm run lab:regress` now runs the write-layer e2e **twice**, and reports each result by name:

| Arm | Golden | Identity | Escapes |
|---|---|---|---|
| `direct` | `things-lab-golden-v4` | the guest's own sshd-descended shell | `THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1` |
| `routed` | `things-lab-golden-v4h` | `things-deputy` + `things-reader`, `helpers-enabled true` | **none** |

```sh
bash lab/scripts/e2e-write-smoke.sh --arm routed          # write layer + the GUI leg
bash lab/scripts/e2e-write-smoke.sh --arm routed --gui-only --dist <dir>
```

Three things make the routed arm honest rather than decorative:

1. **`helpers-enabled true`, never `auto`.** Under `auto` a machine whose grant lapsed silently reverts to direct execution — the exact silence being closed. Under `true` an unroutable hop refuses and the run goes red.
2. **A positive identity check before any probe** — mode, deputy liveness, both Automation standings, `axTrusted`, and the reader's grant, all read out of `things helpers status --json` and required to be the full GUI tier.
3. **A negative control at the end.** Every "the step passed" above proves the write worked, not that the DEPUTY made it work. So the arm stops the deputy, runs one AppleScript-vector write, and requires it to REFUSE. Two fail-closed layers can catch it and either is a pass: the write gate refuses first (exit 4 — with the deputy down the capability read falls to the host, and an sshd-descended shell has no bundle id, so `direct-unknown` blocks pre-dispatch), with the osascript seam's no-fallback refusal ([#620](https://github.com/mikegreiling/things-api/issues/620)) behind it. A **success** there would mean the arm was never routed.

`ui-enabled` is switched OFF for the write-layer smoke in both arms — its two heading gates assert that refusal, and the arms have to run the same steps to be comparable at all. The real GUI drive is its own leg.

### The GUI leg — where identity changes the SCRIPT

[`lab/guest/routed-gui-smoke.sh`](../../lab/guest/routed-gui-smoke.sh) switches `ui-enabled` on and drives one real Repeat dialog end to end through the broker (`todo add-repeating … --dangerously-drive-gui`), then asserts against the database that the series landed, and against the **deputy's own log** that it refused nothing. The client only ever sees "the drive failed"; `rejected-script` in `deputy.log` is what turns that into "the broker refused the script we generated", which is the finding 0.20.7 needed and no arm could produce.

## The arm's acceptance test — v0.20.7 goes RED

An arm that has never caught anything is not evidence. So the v0.20.7 tag's own `dist` was built and put back under the routed arm (`--gui-only --dist …`; the protocol version is unchanged at 1, so routing stays active and only a version-skew notice is printed):

```
== the drive: a repeating series through the deputy ==
     repeating templates before: 2
FAIL [2] todo add-repeating (drives the Repeat dialog, brokered) — exit 1 (expected 0)
     output: {"ok":false,"error":{"code":"unexpected","message":"script rejected: contains \"do shell script\"
              — the deputy only brokers GUI/AppleEvent scripts, never shell execution"},
              "meta":{"dbVersion":27,"elapsedMs":14166}}
     repeating templates after: 2
FAIL no new repeating template (2 -> 2) — the drive did not land
FAIL the deputy refused 1 script(s) — the generator emitted something the broker bans:
{"event":"rejected-script","reason":"script rejected: contains \"do shell script\" …","peerPid":762}
```

The field bug, reproduced in a headless clone, by the ordinary CLI command a caller types. The same leg on current `main` is green in **3 s** with one new template and zero refusals.

## Results — current `main` (0.20.8 + DEPOBS1), 2026-09-03

| Leg | Result |
|---|---|
| write-layer e2e, `direct` arm | GREEN |
| write-layer e2e, `routed` arm | GREEN — 136 steps, 0 failures, 0 alert beeps |
| routed GUI smoke | GREEN — the series lands, 0 broker refusals, 0 beeps, drive 3 s |
| routing negative control | REFUSED as required (exit 4, names the absent socket) |
| v0.20.7 under the routed arm | RED on the broker refusal — the acceptance test |

## What this arm still does NOT certify

**Real hardware.** A headless clone renders and settles at a speed no Mac reproduces — the lab has measured itself ~25× optimistic on sidebar snapshot cost — so latency numbers from this arm are not field numbers, and 0.19.2's class of regression (a stall that only appears under real rendering) remains invisible here. That is the maintainer's own post-release measurement on his M1, made at his discretion; it is evidence for the 5 s bar, never a gate step an agent performs.

**The direct arm still matters.** Both identities ship: a user with no helpers installed runs the direct path, and the escapes are how a clone stands in for that host. Neither arm subsumes the other, which is why both run and both are reported by name.

## Reusable pieces

- [`lab/scripts/helpers-bake.sh`](../../lab/scripts/helpers-bake.sh) — mint (or re-mint) the granted golden.
- [`lab/scripts/helpers-guest.sh`](../../lab/scripts/helpers-guest.sh) — ship the host-built bundle into a clone, install it through the CLI's own path, switch routing on, assert it.
- [`lab/guest/ax-any.jxa`](../../lab/guest/ax-any.jxa) — process-agnostic AX driver: `procs`, `dump`, `sheets`, `find`, `press`, `toggle`, `clicklabel`, `click`, `type`, `key`, `screen`.
- [`lab/guest/routed-gui-smoke.sh`](../../lab/guest/routed-gui-smoke.sh) — the brokered GUI drive plus the deputy-log verdict.
