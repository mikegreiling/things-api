# DEPOBS3 — the poll node already waited out, and the spawn that is most of the drive

**Campaign:** the two routed-latency levers [DEPOBS2](depobs2-deputy-steps.md) §6 left on the table, after that campaign declined the stepped-execution design it was commissioned to price. **(a)** was BUILT: a third injector state that lets a routed drive drop an opening poll node has already satisfied. **(b)** was PROBED only, to a memo: can the deputy execute a brokered script IN-PROCESS, and can such a script still be bounded?

**Refs:** [#695](https://github.com/mikegreiling/things-api/issues/695) (the broker refusal that grounded the sidecar), [#676](https://github.com/mikegreiling/things-api/issues/676) (the settle programme), [#700](https://github.com/mikegreiling/things-api/issues/700) / [DEFAULTS3](defaults3-observer-down.md) (the four quadrants a change to the shape probe must keep).

**Version stamp:** (a) built against `things-api` 0.20.11 + `## Unreleased`, helpers **1.4.0**, and certified in a routed **`things-lab-golden-v4h`** clone — Things 3.23 (build 32300036), DB v27, macOS 15.7.7, pinned clock 2026-07-05. (b) measured on the maintainer's Intel workstation, macOS 15.7.4 (24G517), 2026-09-05, **without building or running a deputy binary** (§B.1). Field constants throughout are RDLAT2 §8's fit: `S_field` ≈ 124 ms per brokered script, `C_field` ≈ 47 ms per Apple event.

---

# PART A — the third injector state (BUILT)

## A.1 The state that was missing

Before this campaign the settle injector had two states, and the second was inferred from the absence of the first:

| `obs.live` | means | what a generator emits |
| --- | --- | --- |
| `true` | a sidecar is live; a script may reach a socket | the settled form: no polls |
| `false` | there is no sidecar | the polling form, byte-identical to pre-VOPAT2 |

A deputy-routed Mac is described by neither. Its scripts may not reach a socket — the broker refuses `do shell script` and that lint is correct and staying ([DEPOBS1](depobs1-deputy-observer.md)) — so it takes `live: false` and, with it, every poll. But its NODE side owns a ledger the deputy has been keeping since before the hop was dispatched. The thing an opening poll exists to discover has, on that host, frequently *already been reported*.

So the injector grew a third state. Not a third SCRIPT SHAPE — that is the point — but a second licence for the shape that already exists:

```ts
export type NodeSettledObservable = "cadence-rebuild";
readonly nodeSettled: ReadonlySet<NodeSettledObservable>;
```

`settleInjectorFor(session, nodeSettled)` carries a claim only for a `deputy` session: a sidecar settles in-script (and already selects the non-polling form off `live`), and a host with no observer has nothing that could have been waited for. With an empty claim it returns the inert singleton **itself**, so "nothing was waited out" and "there is no observer" are the same object and can never become two script shapes.

## A.2 Which waits node took, and which it deliberately did not

DEPOBS2 §4 tabulated every wait in the Repeat drive and marked three as CROSS-HOP: the sheet appearing, the menu closing, the cadence group rebuilding. All three were nominated as node-side settles. **Only two were built, and the arithmetic for the third is the interesting part.**

### (i) the cadence rebuild → the shape probe's poll is DROPPED

`axProbeDialogShapeScript` polls because #700 taught it to: the frequency selection rebuilds the cadence group asynchronously and the field once read the group mid-rebuild — one static text, no `Next:` row — and refused with *"a Things update has redesigned it again"*. The polling rounds hold a positive verdict across two reads a tick apart, which is the certified gate.

A live sidecar has always skipped those rounds, because the selection's own in-script settle waited for `AXValueChanged` on the pop-up it set — which VOPAT1-12 measured arriving in the SAME MILLISECOND as the `AXUIElementDestroyed` burst that tears the old children down (535.1 / 535.2 ms). A routed drive can now establish exactly that precondition in node, against the deputy's ledger, and then emit the same single-round script.

**The generated text is identical to the sidecar's**, asserted rather than asserted-to: the only lines the settled form drops are the five that make the loop, and the only line it adds is the single-round verdict the sidecar form has always carried (`test/unit/ui-observer.test.ts`, *drops the shape probe's poll — and ONLY the poll*).

### (ii) the menu closing → the next hop's first click is no longer eaten

No script changes for this one. A pop-up's menu takes 348 ms to close (VOPAT1 §4.2 g) and a following hop's first click into it is SWALLOWED — VOPAT2 watched that hop's menu-open settle time out at 1515 ms and the retry open the menu in 4.1 ms; RDLAT2's shipped trace shows the same hop at **17 AX round-trips against the 9** the identical primitive costs with nothing in its way. So node waits for `AXMenuClosed` before dispatching a hop that is ITSELF a pop-up selection, and the script's own `exists menu 1` retry — still the oracle, still what refuses — no longer has to run twice.

It is armed only where that hazard is, and a step that will not dispatch at run time is not that hop: a pre-filled setter (DEFAULTS2) and a shape-gated alternative (RDLG2) both disarm it.

### (iii) the sheet appearing → NOT BUILT, because it is a LOSS

DEPOBS2 §6(A) modelled the `dialog-open` hop's poll as worth 100–140 ms. Costing it against a real dispatch reverses the sign, and the reason generalizes.

The polling form's process spawn OVERLAPS the app's own presentation time. `Items ▸ Repeat…` is pressed; the press hop returns; the `dialog-open` hop spawns (124 ms field) and starts probing while the app is still building the sheet, which takes **438 ms of the app's own time** (VOPAT1 §4.2 e). A node-side await serializes what was concurrent: node waits the 438 ms out, and only THEN pays the spawn.

| | field wall from the press |
| --- | ---: |
| poll (today): spawn 124, probe rounds at 124 / 268 / 412 / 556 | ≈ **556 ms** |
| node awaits `AXSheetCreated` (438), then spawns (124), then one probe | ≈ **609 ms** |

**LAW (DEPOBS3-1).** *A node-side settle is only a win where the poll it removes is not already overlapping the app's own latency.* The rebuild qualifies because the probe must ALSO hold its verdict across two reads a tick apart — that extra round is pure overshoot, and it is what node's await removes. The sheet does not qualify: its poll's first probe is the answer, and everything before it was free.

## A.3 Where the wait is armed, and why it can never be a regression

`AXValueChanged` means the value CHANGED. Re-selecting the frequency a dialog already shows announces nothing at all — VOPAT2 measured exactly that on the maintainer's own `--after-completion` command, where a settle armed on the unchanged path timed out at 2005 ms having seen three unrelated arrivals. A node-side wait armed there would cost its whole budget and the probe would still have to poll: a pure regression, on a real shape.

So the wait is armed only where the recipe can PROVE the announcement is coming, and the proof is measured:

> **DEFAULTS1 §2, all fourteen seed states, byte for byte:** a Repeat dialog opened on a freshly minted seed row shows `after completion, every 1 week`.

`make-repeating` and `add-repeating` both promote a row the command itself just minted, so `rule.seed` is present and the dialog's opening frequency is known. Any other frequency is therefore necessarily a change. A dialog opened on an EXISTING rule — both reschedule recipes, which carry no seed — proves nothing and is left exactly as it was.

Four conditions, all of them, or the step carries no tag:

1. the recipe has a `seed` (the make/add path);
2. the rule is not `after-completion` (that selection IS the dialog's default);
3. a shape probe actually follows (`needsShape`) — otherwise there is no poll to drop;
4. `dialogDefaultsRelied()`: `THINGS_API_PREFILL` is not off, and the shape manifest covers the installed build. The two switches that govern every other reliance on the dialog's own defaults govern this one.

And at run time, two more gates stand in front of the wait itself:

- **the liveness gate.** `observerCount` past the mark, first, and free. A pop-up selection cannot have happened without the app announcing something (`AXMenuOpened` lands 5.1 ms after the press, VOPAT1-11), so an empty ledger here is not a quiet app — it is an observer that is not seeing this process, and waiting on it would cost a budget per pop-up to find that out. Silence means: change nothing, poll as before.
- **the miss is soft.** A wait that times out records the miss in the trace and returns an EMPTY claim, so the next hop is generated with its poll. The fallback is the certified polling gate, never an optimistic read — #700's lesson, kept.

## A.4 What the lab measured

Two runs in a routed `things-lab-golden-v4h` clone, `lab/guest/depobs3-cells.sh` through `lab/scripts/stage5-rc-run.sh`, helpers 1.4.0 installed and granted in the guest, `helpers-enabled true`, normal CLI syntax throughout. The shape is `todo make-repeating --frequency monthly --interval 1 --on-weekday monday --on-ordinal 3` on a seed scheduled 2026-07-20 (the third Monday, so the anchor guard passes and the ordinal-weekday form is never pre-filled — DEFAULTS1-2 — which keeps BOTH monthly pop-ups dispatching). It is the smallest shape carrying both levers: a probe hop immediately after the frequency selection, and two consecutive pop-up selections.

**The A/B is PAIRED and INTERLEAVED, in one guest, on one boot.** `stage5-rc-run.sh` grew an optional `RC_DIST_BASELINE` that ships a second dist beside the RC's, and the cells alternate `base / rc / base / rc`. The first run had them in blocks and handed the whole cold-app warm-up to the baseline arm; the numbers below are the interleaved run.

### The two hops, measured

Medians of three pairs, per-hop `durationMs` out of `THINGS_API_TRACE=1`:

| hop | baseline (`origin/main`) | with the claim | Δ |
| --- | ---: | ---: | ---: |
| `probe-dialog-shape` — **the poll that is dropped** | **660 ms** | **92 ms** | **−568 ms** |
| `select-popup` — frequency (the first pop-up) | 128 ms | 128 ms | 0 |
| `select-popup` — monthly weekday | 147 ms | 144 ms | −3 ms |
| `select-popup` — monthly ordinal — **the swallowed click** | **565 ms** | **175 ms** | **−390 ms** |
| all 17 hops, in-hop wall (successful drives only) | 3,156 / 6,343 ms | 2,045 / 2,067 / 2,107 ms | — |

Reproduced in the block-ordered run: 921 → 265 ms on the probe, 734 → 358 ms on the second pop-up.

**And a cleaner A/B still, on ONE binary and one boot** — the quadrant cell, where the claim is armed or not by environment alone:

| quadrant | probe hop | node-side claims |
| --- | ---: | --- |
| observer deputy, prefill on | **88 ms** | 2 (cadence-rebuild, menu-closed) |
| observer deputy, `THINGS_API_PREFILL=0` | **657 ms** | 1 (menu-closed only) |
| `THINGS_API_AX_OBSERVER=0`, prefill on | 746 ms | 0 |
| `THINGS_API_AX_OBSERVER=0`, prefill off | 647 ms | 0 |

The second row is the design working: with the defaults switch off, `dialogDefaultsRelied()` is false, the recipe cannot prove the frequency will change, the tag is not emitted — and the probe polls, exactly as it must. The menu-close wait is not a reliance on the dialog's defaults and correctly stays armed.

### What it cost, and the honest accounting

`axOps` is unavailable on a routed host by construction: `THINGS_API_AX_COUNT` rides the environment of the process that SPAWNS osascript, which on a routed Mac is the deputy (RDLAT2 §1). So the counts below are reconstructed from the app-announcement latencies the settles themselves record, which DO transfer.

The node-side waits, `latencyMs` measured from the mark taken before the actuation:

| wait | app's own announcement latency | node blocked for ≈ |
| --- | ---: | ---: |
| the cadence rebuild (`AXValueChanged:AXPopUpButton`) | 630–642 ms | latency − the 128 ms hop ≈ **514 ms** |
| the menu closing (`AXMenuClosed`) | 490–502 ms | latency − the 144 ms hop ≈ **358 ms** |

**So on the clone the two levers are close to a wash, and that is the expected result.** Taken from the mark, the rebuild boundary is `128 + 514 + 92 = 734 ms` with the claim against `128 + 660 = 788 ms` without it, and the menu boundary is `144 + 358 + 175 = 677 ms` against `147 + 565 = 712 ms`. About 90 ms, on a drive whose end-to-end wall varies by more than that between repetitions. A headless clone answers an Apple event in ~8 ms; the polls it removes are therefore cheap, while the app's announcement latency is the app's and does not shrink.

**The field is where the sign is decisive, and it is an extrapolation, not a measurement.** At RDLAT2 §8's fitted constants (`C_field` ≈ 47 ms per Apple event, `S_field` ≈ 124 ms per brokered script), a probe round costs `3 × 47 + 100 = 241 ms` instead of the clone's ~124 ms, and the swallowed click's retry costs `8 × 47 + 300 = 676 ms` instead of ~364 ms — while the 535 ms rebuild and the 348 ms menu close cost the same everywhere:

| boundary | field, polling | field, node waited | Δ |
| --- | ---: | ---: | ---: |
| the cadence rebuild → the probe | ≈ 988 ms | ≈ 676 ms | **≈ −310 ms** |
| the menu close → the next pop-up | ≈ 941 ms | ≈ 723 ms | **≈ −220 ms** |

**This is BELOW DEPOBS2 §6(A)'s modelled 0.8–1.4 s, and the discrepancy is the same error DEPOBS3-1 catches for the sheet.** That sketch priced the whole poll as removable. It is not: a poll waiting on the app runs CONCURRENTLY with the app, so what a node-side wait actually removes is the overshoot past the settle point plus the extra agreeing round — not the wait itself. On the maintainer's own `make-repeating` shape (`--after-completion`, no shape probe) only the menu-close boundary applies at all, so the honest expectation there is **≈ 200 ms of a 6.9 s drive**, not a second.

### The certification cells

| cell | result |
| --- | --- |
| the four DEFAULTS3 quadrants, routed, on the shape that probes | **GREEN** — series landed in all four; claims carried exactly where §A.3 says |
| `add-repeating`, routed | **GREEN** — template landed, both claims absorbed |
| `area reorder --first`, routed | **GREEN** — 0 claims (a drag recipe has no `select-popup`) |
| the DIRECT arm (helpers off + the lab's UI escape), both dists | **UNCHANGED** — probe hop 88 ms baseline, 87–89 ms with the change, 0 claims either side |
| the deputy's own log | 0 `rejected-script` across both runs |
| the beep sentinel | 0 alert beeps in every window (16 marks) |

Run 1 (block-ordered) was GREEN across all 14 steps. Run 2 (interleaved) reported one failure, and it is **in the BASELINE binary**: `base/3` refused at the pre-commit audit with `Next (first occurrence) … dialog shows "Mon, Jul 27, 2026"` — the NEXTPOP1 recompute landing on the fourth Monday instead of the third. The RC binary passed 7/7 across both runs on the identical shape and fixtures. One occurrence is not a claim of a fix, and it is recorded here as an observation, not as evidence: the audit caught it and committed nothing, which is the behaviour that matters.

### What this arm does NOT certify

Real hardware, as ever. The clone's ~8 ms Apple events are what make the lever look like a wash here, and the field's ~47 ms are what make it a win; the actual number is the maintainer's own post-release trace on his M1, at his discretion. The extrapolation above names exactly which two boundaries to read off it (`probe-dialog-shape`'s `durationMs`, and the `select-popup` that follows another `select-popup`).

## A.5 What changed, in files

| file | change |
| --- | --- |
| `src/write/vectors/ui-observer.ts` | `NodeSettledObservable`, `NO_NODE_SETTLES`, `SettleInjector.nodeSettled`, `nodeSettledInjector`, `settleInjectorFor(session, nodeSettled)` |
| `src/write/vectors/ui.ts` | `absorbPopupSelection` (the two node-side waits), `nextHopClicksAPopup`, the `awaited`/`pendingSettled` thread through `driveSteps`, and one line in `axProbeDialogShapeScript`: `const poll = !obs.live && !obs.nodeSettled.has("cadence-rebuild")` |
| `src/write/vectors/ui-recipes.ts` | the frequency `select-popup` carries `crossHopSettle: "cadence-rebuild"` where §A.3's four conditions hold |
| `src/write/vectors/ui-prefill.ts` | `dialogDefaultsRelied()` — the two gates, split out from `provenPrefills` so a reliance that is not about a pre-filled control can honour the same switches |
| `src/write/vectors/types.ts` | `UiStep.crossHopSettle` |

Certified by `test/unit/ui-observer.test.ts` (the state machine, the script diff, where the menu-close wait arms), `test/unit/repeat-recipe.test.ts` (the tag's six conditions), and the shared script catalog's new `ROUTED_SETTLED_SHAPE`, which puts the settled variant through `osacompile` and through the broker-safety lint like every other script a routed Mac dispatches.

---

# PART B — in-process script execution in the deputy (PROBED; a memo, no product code)

## B.1 What was run, and what was deliberately not

**No deputy binary was executed on this host — not the installed one, not a child built from source.** A source-built child carries the installed bundle's signing identity, so TCC hands it the same Accessibility grant, and a live-deputy run is production interaction on this machine (AGENTS.md § Safety rails; the maintainer's law of 2026-09-03, which [DEPOBS2 §3.1](depobs2-deputy-steps.md) also observed). The commissioning brief offered a throwaway child deputy in the scratchpad; it was declined for the same reason DEPOBS2 declined it, and it turned out not to be needed: **every question below is answerable without one.**

Instead the in-process path was exercised through the ObjC bridge inside a plain `osascript -l JavaScript`, which reaches `NSAppleScript`, OSAKit's `OSAScript`, and the ObjC runtime with nothing built and nothing signed. **Nothing measured here addresses an application.** The timed scripts compute a constant or sleep; the real generated scripts (§B.3) are COMPILED only — a pure parse, no Apple event — because executing one would drive an app.

Harness: `osascript -l JavaScript` for the in-process cells, `python3` `subprocess` in the shape `runChildTool` uses (spawn, drain both pipes, wait for exit) for the spawn baseline, both in a scratch directory.

## B.2 The spawn is essentially the whole cost

25 warm samples each, medians:

| | AppleScript | JXA |
| --- | ---: | ---: |
| **spawn** `/usr/bin/osascript -e '<arith>'` — what the deputy does today | **28.8 ms** | 12.4 ms |
| **in-process** `NSAppleScript` compile | 0.15 ms | — |
| **in-process** `NSAppleScript` execute | 0.06 ms | — |
| **in-process** `NSAppleScript` re-execute (same compiled script) | 0.06 ms | — |
| **in-process** `OSAKit.OSAScript` compile + execute | 0.14 + 0.06 ms | 0.70 + 0.19 ms |

The spawn baseline reproduces DEPOBS2 §3.2 (26.8 ms / 12.1 ms) on the same machine, which is what makes the two campaigns' numbers comparable. **In-process compile+execute of an arithmetic script is 0.21 ms against a 28.8 ms spawn — 137×.**

## B.3 …and it does not get worse with the scripts we actually generate

DEPOBS2 measured ~1 ms per KB on top of the spawn's launch floor, and named `set-group-number` (12.6 KB, because it carries `AX_CADENCE_HANDLERS`) as the hop a step boundary would re-compile. So the whole shipped catalog was compiled in-process — all 112 scripts a drive can emit, in every settle shape, AppleScript and JXA, 15 samples each:

| | bytes | in-process compile (median) |
| --- | ---: | ---: |
| the pre-commit audit (largest AppleScript) | 16,026 | **7.2 ms** |
| `set-group-number`, observed shape | 15,905 | 6.8 ms |
| the sidebar live-aim drag (largest JXA) | 39,822 | **1.1 ms** |
| median over all 89 AppleScript scripts | — | **2.3 ms** |
| the smallest menu presses | 38–128 | 0.2–0.5 ms |

All 112 compiled. The worst script in the catalog costs **7.2 ms** to compile in-process, against a **28.8 ms** spawn on this workstation and a fitted **124 ms** on the field host.

**The prize, at field constants.** RDLAT2 §5's shipped trace is 13 hops. `13 × 124 ms ≈ 1.6 s` of the 6.9 s field drive is process launch. In-process compilation would replace it with `13 × ~3 ms ≈ 40 ms`. That is the largest single lever left that is not the Apple-event transport itself (4.1 s, which is the standing raw-AX commission's target).

## B.4 The boundedness answer: NO. There is no way to stop an in-process script.

This is the finding that decides the design, and it is an enumeration, not a reading of the documentation. Every instance method of the four candidate classes, read straight out of the ObjC runtime:

| class | instance methods | any of `cancel` / `stop` / `abort` / `terminate` / `interrupt` / `setActiveProc` |
| --- | ---: | --- |
| `NSAppleScript` | 16 | **none** |
| `OSAScript` | 56 | **none** — it publishes `isExecuting`, so a host may ASK, and that is all |
| `OSALanguage` | 21 | none |
| `OSALanguageInstance` | 9 | none |

`executeAndReturnError:` is synchronous, takes no deadline, and has no companion that stops it. Measured, against a 2 s budget:

| script | today (child process) | in-process |
| --- | --- | --- |
| `delay 60` | **SIGTERM at 2006 ms**, exit −15 | ran on; the only way out was SIGKILLing the whole host process |
| a 40-million-iteration `repeat` loop (5.2 s of CPU) | (same mechanism) | ran to completion; likewise |

So the deputy's `Process` is not an implementation detail it could refactor away — **it IS the deadline.** `runChildTool`'s SIGTERM-then-SIGKILL timer, the fixed argv shape, and the crash isolation are one posture with one mechanism, and moving execution in-process removes the mechanism.

Two further consequences the memo has to name:

- **A hung script would hold every other brokered request.** `server.swift` runs every script on the serial `osaQueue`, so a hang already blocks other script verbs today — but today it is bounded, and the observer verbs are deliberately kept OFF that queue so a settle wait cannot be starved. In-process on the same queue, a hang is unbounded and permanent. Moving it to a worker thread lets the host answer the client at its deadline, but the thread and the script live on: a leaked thread per hang, inside a process whose main thread sits in `dispatchMain()`, holding whatever OSA state the wedged script holds.
- **A modal has no in-process refusal either.** `kOSAModeNeverInteract` — the flag that makes `display dialog` fail instead of blocking — is a mode flag on the Carbon `OSAExecute`, and neither `NSAppleScript` nor OSAKit exposes it (`NSAppleScript` has a PRIVATE `_executeWithMode:andReturnError:`, which a shipped helper may not use). Today the child simply dies at its deadline, dialog and all. *(This cell was not run against a real modal on this host: `display dialog` from a CLI `osascript` draws a window on the maintainer's screen, and the probe would not put one there unattended. It belongs in the guest.)*

## B.5 The third option, measured: a PERSISTENT child that executes in-process

The choice is not "spawn per script" versus "in-process in the helper". There is a shape that takes the speed and keeps the mechanism: **one child process per drive**, which reads scripts over a pipe and executes each one in-process, and which the deputy can still SIGKILL.

Measured with a stock-tools stand-in — a single `osascript -l JavaScript` reading base64 script lines on stdin, compiling and executing each through OSAKit, and writing the result back — timed from the PARENT, which is what the deputy would measure:

| | median |
| --- | ---: |
| launch + first script (the once-per-drive cost) | **57.3 ms** |
| each subsequent script, AppleScript, round trip | **2.84 ms** |
| each subsequent script, JXA, round trip | **2.93 ms** |
| a wedged runner (`delay 60`) killed at a 2 s budget | **SIGTERM at 2013 ms**, exit −15, no orphan |

2.84 ms includes this probe's deliberately naive byte-at-a-time stdin read; a length-prefixed frame would be lower. Against 28.8 ms per spawn, the persistent runner recovers **~90 % of the saving while keeping the deadline, the fixed argv shape and the crash isolation exactly as they are.**

At field constants, over RDLAT2's 13-hop drive:

| posture | per-script | 13 hops | boundable? | crash-isolated? |
| --- | ---: | ---: | --- | --- |
| today — spawn per script | 124 ms | **1,612 ms** | yes (SIGTERM/SIGKILL) | yes |
| in-process in the helper (`NSAppleScript` / OSAKit) | ~3 ms | ~40 ms | **NO** | **no** |
| in-process in the helper via Carbon `OSAExecute` + `OSASetActiveProc` | ~3 ms | ~40 ms | *probably* — unprobed | no |
| **persistent child, in-process inside it** | ~3 ms + one launch | **~90 ms** | yes, unchanged | yes, unchanged |

*(The field's per-script constant is a fit, not a launch measurement; the persistent runner's own launch on the field would be one `S_field` rather than this host's 57 ms. The ranking does not depend on which.)*

## B.6 Recommendation

**Do not put `NSAppleScript`/OSAKit inside the deputy.** It buys ~1.5 s of the field drive and pays for it with the one property the whole helper posture is built on: a script the deputy cannot stop. §B.4 is not a caveat to engineer around — there is no API.

**If the spawn term is to be attacked, attack it with a persistent child script runner** (the deputy's own binary re-execed in a runner mode, or a small sibling tool in the same bundle), owned by the deputy exactly the way `runChildTool`'s child is owned today: a fixed argv shape, a deadline the parent enforces with SIGTERM-then-SIGKILL, and a fresh runner per drive so a wedged one is discarded rather than reused. It keeps every guard — `scriptGuard`'s lint runs deputy-side on the text before it is ever handed over, and `MAX_REQUEST_BYTES` still bounds it — and it recovers ~1.5 s of the 6.9 s field drive.

**The open cells, for the guest** (they need a Swift harness and a real Things, and neither belongs on the maintainer's host):

1. Does `OSASetActiveProc` actually fire during `delay`, during a tight loop, and during a blocked Apple event? That is the difference between "in-process is unboundable" and "in-process is boundable through a deprecated C API", and it is the only thing that could reopen §B.6's first paragraph.
2. `kOSAModeNeverInteract` against a real `display dialog`, and against an Apple event to a hung app.
3. Do the grants ride the process? (Expected yes — Accessibility and Automation are process/identity properties, not per-`Process`-spawn ones, which is exactly why the deputy's child inherits them today — but it is one `AXIsProcessTrusted()` + one addressed read apart, inside a granted guest.)
4. The persistent runner's per-script cost with the real generated scripts, measured through a real deputy, in the guest.

**Nothing was implemented.** `PROTOCOL_VERSION` stays 1, `hello.capabilities` stays `["observer"]`, and no Swift changed.
