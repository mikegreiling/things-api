# DEPOBS2 — deputy-stepped scripts, priced and DECLINED

**Campaign:** close [DEPOBS1](depobs1-deputy-observer.md) §4's in-script-settle gap by letting the deputy run a brokered script in STEPS, waiting on its own observer between them — and, before building it, price a step.
**Refs:** [#695](https://github.com/mikegreiling/things-api/issues/695) (the broker refusal that grounded the sidecar), [#676](https://github.com/mikegreiling/things-api/issues/676) (the settle programme).
**Verdict: NOT BUILT.** A brokered step costs a `/usr/bin/osascript` PROCESS SPAWN, because the deputy executes every script as a child process. The in-script waits a step boundary could remove are worth 5–150 ms each, they sit INSIDE retry loops that cannot be split without moving the loop into node, and the waits that are worth having are already at hop boundaries where node's deputy-hosted observer reaches them today. Modelled on the field's own command, stepping is **200–400 ms SLOWER** per drive.

**Version stamp:** modelled against `things-api` 0.20.8+ (`## Unreleased`), helpers **1.4.0** (`deputy/VERSION`), the 13-hop / 88-round-trip `make-repeating` trace of [RDLAT2 §5](rdlat2-repeat-dialog-latency.md), and RDLAT2 §8's fitted field constants. Timings taken on the maintainer's Intel workstation, macOS 15.7.4 (24G517), Node 24.14.1, 2026-09-03. **Nothing in this campaign ran a deputy binary, touched the installed helpers, opened Things, or sent an Apple event to any application** — see §3.1 for what that costs the measurement and §7 for what the maintainer must run to falsify it.

---

## 1. The design that was commissioned

Split a recipe's step scripts at their wait boundaries and let the deputy run the pieces:

```
run-steps {observer, steps: [{lang, script, settle?: {want, all?, quietMs?, timeoutMs}}]}
```

For each step the deputy takes an observer mark, executes the script exactly as the single-script broker does, waits on its own ledger past the mark, and records the outcome; a settle TIMEOUT is soft (report and continue — the client keeps its certified polling gate), an execution failure stops the run. Client-side, a recipe's generators would emit step lists only when `observerTransport() === "deputy"`, byte-identically otherwise.

The design is sound. The question this campaign was commissioned to answer first is what a STEP COSTS, because the whole proposition is *a step boundary is cheaper than the wait it removes*.

## 2. How the deputy executes a script — the finding that decides it

**It spawns a child process, one per script.** `deputy/src/server.swift`'s `osascript` verb screens the script, then calls `runOsascript` on the serial `osaQueue`; `runOsascript` calls `runChildTool` (`deputy/src/osascript.swift`), which builds a `Process` at `/usr/bin/osascript` with one of two fixed argv shapes, drains both pipes off-thread, waits for exit, and owns a kill timer (SIGTERM at the deadline, SIGKILL 2 s later).

There is no OSAKit, no `NSAppleScript`, no in-process execution anywhere in the deputy. That is a deliberate posture, not an oversight — the child is how the deputy bounds a hung script it cannot otherwise interrupt, how argv stays a fixed shape the client never supplies, and how a wedged AppleScript cannot take the helper down with it (`deputy/src/main.swift` § security posture; [design/agent-daemon.md](../design/agent-daemon.md) §β1).

So the commissioning brief's favourable branch does not exist here:

| if the deputy ran a script… | a step costs | verdict |
| --- | --- | --- |
| in-process (OSAKit / `NSAppleScript`) | ~one socket round-trip + a compile | the design wins |
| **as a child process (what it does)** | **a process spawn + a compile + re-addressing** | the design must beat the polls it removes, and does not |

## 3. What a step costs — measured

### 3.1 Method, and its honest boundary

The two terms are `S` (one brokered script) and `C` (one deputy socket round-trip). Both were measured on this host WITHOUT running a deputy: a child deputy built from source carries the same signing identity as the installed bundle, so TCC hands it the same Accessibility grant, and a live-deputy run is production interaction on this machine — never run by an agent and not sanctionable (the maintainer's law of 2026-09-03, AGENTS.md § Safety rails; the same lesson DEPOBS1 §7 learned the hard way). So:

- **`S` was measured directly against `/usr/bin/osascript`**, in the shape `runChildTool` uses it — spawn, two drained pipes, wait for exit — with a script that computes a constant. No application is addressed, so no Apple event leaves the process and nothing in this measurement can reach Things or System Events.
- **`C` was measured over the REAL client** (`src/deputy/client.ts`, `DeputyAsyncClient`) against a stub JSON-lines server on a throwaway socket. It is therefore a FLOOR: the stub answers on the same event loop where the Swift deputy parses, dispatches on a per-connection thread, and logs asynchronously. The floor is enough, because the finding is that `C` is not the term that matters.

What is NOT measured here: the deputy's own Swift-side dispatch, and the field host's spawn cost. Both are the maintainer's to take (§7).

### 3.2 The numbers

| term | shape | median | spread |
| --- | --- | ---: | --- |
| `S` — spawn + run a constant AppleScript (`return 42`) | 25 samples, warm | **26.8 ms** | 26.1 / 28.1 / 28.5 (min / p90 / max) |
| `S` — the same in JXA (`-l JavaScript`) | 25 samples, warm | 12.1 ms | 11.2 / 13.3 / 13.5 |
| `C` — one request/response over the async client | 200 samples, warm | **0.015 ms** | 0.014 / 0.020 / 0.273 |

**`C` is free and `S` is not.** A socket round-trip is three orders of magnitude below a spawn, which retires the brief's assumption that a step would cost "~one socket round-trip (C_field ≈ 47 ms)" — 47 ms is the cost of an APPLE EVENT to System Events (RDLAT2 §8), not of a message to the deputy.

And a step's fixed cost is not only the launch: every step re-ships and re-COMPILES its script, including the handler prelude the hop it was split out of compiled once.

| script size | median wall (spawn + compile + run) |
| ---: | ---: |
| 44 B | 26.4 ms |
| 804 B | 28.1 ms |
| 3.1 KB | 32.3 ms |
| 7.7 KB | 34.2 ms |

≈ **1 ms per KB** on top of the launch floor. The generated scripts this drive splits are not small: `select-popup` is 904 B, `probe-dialog-shape` 2.2 KB, and `set-group-number` — the hop whose focus/typed waits are the design's best case — is **12.6 KB**, because it carries `AX_CADENCE_HANDLERS`. Splitting that hop in two re-compiles all 12.6 KB a second time.

### 3.3 The field constant

This host is not the field host. RDLAT2 §8 fitted the maintainer's M1 at **`S_field` ≈ 124 ms** per brokered script and **`C_field` ≈ 47 ms** per Apple event, from a real 9.3 s field wall; DEPOBS2's socket measurement now shows the socket half of that 124 ms is ~0, so the fit attributes essentially all of it to the spawn. VOPAT2 independently measured an `osascript` spawn at 30.4 ms on a clone and 143.9 ms in the sidecar rig. The model below is run at **`S_field` = 124 ms** and re-checked at this host's optimistic **26.8 ms** — the verdict does not change, only its margin.

## 4. Where the in-script waits actually are

Every wait in the Repeat drive, and who could remove it (routed host, observer up per DEPOBS1, `settleInjectorFor` inert):

| wait | where it lives | polling cost | the observable | reachable by a STEP? |
| --- | --- | ---: | --- | --- |
| the sheet appears | `dialog-open` — a hop of its own, waiting on the PREVIOUS hop's press | ~4 events, mostly app time | `AXSheetCreated` (582 ms) | **no — cross-hop, node reaches it today** |
| the pop-up's menu opens | inside `select-popup`'s self-healing `repeat 20` loop | 1–2 events (47–94 ms field) | `AXMenuOpened` (5.1 ms) | yes, at −124 ms |
| the menu closes on an unchanged value | NOT EMITTED on the polling path — the NEXT hop's first click is swallowed and its open loop retries | ~300–400 ms, in the next hop | `AXMenuClosed` (348 ms) | **no — cross-hop, node reaches it today** |
| the cadence group rebuilds | `cgSettle` / `probe-dialog-shape`'s poll, at the START of a hop, waiting on the PREVIOUS hop's selection | 3–6 rounds × (3–4 events + 100 ms) | `AXValueChanged:AXPopUpButton` (535 ms) | **no — cross-hop, node reaches it today** |
| a field takes focus | inside `typeLoopBlock`'s `repeat attempts` loop | `delay 0.15` | `AXFocusedUIElementChanged` (27.6 ms) | yes, at −122 ms saved |
| a field takes the typed value | same loop, after the keystroke | `delay 0.1` | `AXValueChanged:AXTextField` (78.6 ms) | yes, at −21 ms saved |
| the tab-out read-back | same loop | `delay 0.2` + a read | — (no observable claimed) | no |

Two structural facts fall out of that table, and they matter more than the arithmetic.

**(a) The waits worth having are at HOP boundaries, not inside scripts.** The three expensive ones — sheet creation, the menu closing, the cadence rebuild — are all *cross-hop*: the actuation happened in the previous osascript and the wait sits at the start (or the implied start) of the next one. Node already marks before every step and already owns `observerCount` / `observerAwait` against the deputy-hosted ledger (`src/write/vectors/ui.ts`, the `settle-occurrences` branch). Reaching them needs no new verb, no new hop, and no stepped execution — only permission for a generator to emit its non-polling form when NODE did the waiting.

**(b) Every wait a step COULD remove sits inside a bounded retry loop.** `select-popup` opens the menu inside `repeat 20 times { if exists menu 1 then exit; click; poll }`, one click per round, because a second click into an opening menu is exactly what BEEP1 forbids. `typeLoopBlock` asks for focus, asserts `focused`, types, tabs out and reads back inside `repeat attempts times`, with `fgAssertFront` at the top of each round. Splitting those at their wait boundaries does not yield "step, settle, step" — it yields a LOOP whose body is now three brokered spawns, driven from node, with the closed-loop verdict (the `exists` check, the focus assertion, the value read-back) that is what refuses today spread across processes. On the unhappy path the cost multiplies by the retry count, which is the exact path the loops exist for.

## 5. The model

The field's own command (`--frequency monthly --interval 1 --after-completion`), against RDLAT2 §5's shipped 13-hop / 88-round-trip trace, at `S_field` = 124 ms and `C_field` = 47 ms:

| | hops | Apple events | modelled transport wall |
| --- | ---: | ---: | ---: |
| today, routed | 13 | 88 | 13×124 + 88×47 = **5,748 ms** |
| stepped (split both pop-up hops at the menu-open boundary) | 15 | 88 (2 poll events out, 2 re-address events in) | 15×124 + 88×47 = **5,996 ms** |

**+248 ms, and nothing else changes** — the drive's measured 6.9 s field wall would become ~7.1 s. The interval hop contributes nothing to the "after" column on this shape because `--interval 1` is pre-filled: DEFAULTS2 skips the typing entirely, so the focus/typed waits — the design's best case — do not even run on the maintainer's own command.

On a shape that DOES type (an interval > 1, a weekday set, an ends-after count), each typed field is two more splits:

- removed: `delay 0.15` + `delay 0.1` = 250 ms, minus the notifications' own 27.6 + 78.6 = **143 ms saved**
- added: 2 × (124 ms spawn + ≥47 ms to re-address the field) + a second compile of the 12.6 KB prelude = **≥342 ms**
- **net +199 ms per typed field**, before the retry-loop restructuring in §4(b) costs anything.

Re-run at this host's optimistic spawn (26.8 ms) the typed field nets **+5 ms** and the pop-up splits net **−90 ms** — i.e. even if the field host turned out to spawn as cheaply as this workstation, the whole design would be worth **~50 ms on a 6,900 ms drive (0.7 %)**, in exchange for a new broker verb, a stepped execution path, a state-threading protocol between step scripts, and a new certification quadrant on every generator it touches.

**There is no version of this that pays.** Stopped here, per the commissioning brief: *if the model does not beat the polling path, do not ship a slower design.*

## 6. What this retires, and what to build instead

**It retires the in-script-settle gap as a PRIORITY, not just this design for closing it.** DEPOBS1 §4 left the gap open and named a StandardAdditions file rendezvous as the one prompt-free in-script transport a broker would pass. That option is untouched by this result and is still the only candidate — but §4's table prices the whole prize: the in-script waits removable across the field's command are worth **~100–350 ms of a 6,900 ms drive**. Any in-script transport, rendezvous or otherwise, is competing for 1.5–5 % while 4.1 s of the drive is Apple events and 1.6 s is process spawns.

The two levers that are actually the size of the problem:

**(A) Node-side settles at the remaining CROSS-HOP boundaries — no new verb, no new hop.** Today the routed transport carries exactly one of them (`settle-occurrences`, the `Next:` recompute). The other three are in §4's table. What it needs is not machinery but a DECISION: a third injector state that separates *"the script may talk to a socket"* (false on a routed host, forever — the broker refuses the phrase) from *"the script still has to poll"* (false when node has already waited). `axProbeDialogShapeScript` is the clean case — its `obs.live` branch injects no handler text at all, only the choice between a polling round and a single read — so a routed host could generate the already-certified non-polling form once node has absorbed the rebuild. Modelled saving: the rebuild poll (~8–16 events, **375–750 ms** field), the swallowed click after an unchanged selection (~6–10 events, **280–470 ms**), the sheet poll (~2–3 events, 100–140 ms). Cost: new script shapes on the routed host, so it is a DEFAULTS3 quadrant campaign, and it must not resurrect #700 (the probe polls for a reason when nothing waited).

**(B) In-process script execution in the deputy.** The spawn term is 13 × 124 ms ≈ **1.6 s of the field drive**, and it is the term this campaign measured rather than modelled. Removing it means `NSAppleScript`/OSAKit inside the helper, which trades away the deadline-owned child, the fixed-argv shape, and crash isolation, and brings AppleScript's own thread and run-loop requirements into a process whose main thread sits in `dispatchMain()`. It would also make stepping viable — a step would then cost a compile (bounded above by this host's whole 26.8 ms `osascript` wall). That is a helpers-architecture ruling, not a refactor, and it belongs beside the standing raw-AX commission (which attacks the larger 4.1 s transport term).

## 7. Certification handoff (maintainer)

Nothing shipped, so there is nothing to certify: no Swift changed, no TypeScript changed, and the live broker suite gains no cell. What the model rests on that this host cannot supply is ONE number — `S_field`, the cost of a brokered script on a real routed Mac — and under the maintainer's law of 2026-09-03 it is NOT something an agent goes and measures. There are exactly two honest sources for it, and neither is a probe against production:

**(a) The routed GUEST arm, once it exists (HELPGST1 / golden-v4h).** This is the proper home for every routed measurement, and it is free once the helpers can be installed and granted inside a clone: the same drive, run twice in the guest — helpers enabled, then `helpers-enabled false` — reads the same hop from three sides.

| read it from | what it contains |
| --- | --- |
| the CLI trace's per-hop `durationMs`, routed | socket + deputy + spawn + script |
| the deputy's audit log (`<state-dir>/deputy/deputy.log`), one JSON line per request with `ms` | spawn + script, no socket |
| the CLI trace's per-hop `durationMs`, direct | spawn + script, no deputy |

`routed − direct` on a hop that makes ONE Apple event (`press`, `activate`) is the deputy adder; `routed − (deputy-side ms)` is the socket, which §3.2 predicts is ~0. Round-trip COUNTS need the direct arm regardless: `THINGS_API_AX_COUNT` rides the environment of the process that SPAWNS osascript, which on a routed host is the deputy ([RDLAT2 §1](rdlat2-repeat-dialog-latency.md)). A guest number is not a field number, but the RATIO of the three readings is portable, and it is the ratio the model needs.

**(b) The maintainer's own post-release trace, at his discretion.** `THINGS_API_TRACE=1` per-hop `durationMs` from a routed `make-repeating` he was going to run anyway carries `S_field` in it, no probe required — the same evidence stream that produced the 10.5 s and 6.9 s field numbers.

**What either one decides.** If a brokered step's fixed cost on a real routed Mac is well under ~50 ms, §5's margin narrows and the verdict still holds (the drive would gain ~50 ms for a whole new execution path); the design becomes worth re-opening only if that number falls far below ~50 ms **and** §4(b)'s retry loops are restructured first. Lever (A) in §6 is the one worth commissioning off the same traces — the hops to watch are `dialog-open`, the second `select-popup`, and `set-group-number` / `probe-dialog-shape`.

## 8. What was NOT done, deliberately

- **No deputy binary was executed on this host** — not the installed one, not a child built from source. The live broker suite (`THINGS_DEPUTY_LIVE=1`) is production interaction here and the PreToolUse guard refuses it; the Swift sources were read, not run.
- **No `run-steps` verb, no protocol change, no helpers version bump.** `PROTOCOL_VERSION` stays 1 and `hello.capabilities` stays `["observer"]`.
- **No script was executed against Things or System Events.** The `S` measurements address no application; the generated-script SIZES in §3.2 come from calling the generators for their strings and measuring `.length`.
- **No VM.** Another campaign held the lab slot; nothing here needed one, since nothing was built to certify.
