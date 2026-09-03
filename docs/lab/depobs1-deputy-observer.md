# DEPOBS1 — the deputy-hosted AX settle observer

**Campaign:** move the settle observer into the helpers, so a deputy-routed Mac can wait on the app's own Accessibility notifications instead of on fixed timers.
**Refs:** #695 (the broker refusal that grounded the sidecar), #676 (the settle programme), #698 (the fix this supersedes for routed hosts).
**Version stamp:** built and certified against **helpers 1.4.0**, `things-api` at `0.20.8+` (`## Unreleased`), macOS 15.7.7 (Darwin 24.6.0), Swift toolchain from Xcode CLT, on the maintainer's Intel workstation. The live broker cells ran against a **child deputy** built by `scripts/build-helpers.sh` and signed *Developer ID Application*, never the installed bundle. **No arm of this campaign ran against the maintainer's live helper socket, his production Things database, or a real display.** The field measurement is deliberately NOT part of this document — see §6.

---

## 1. The problem, exactly

VOPAT2 shipped an `AXObserver` settle mechanism: the app announces `AXMenuOpened`, `AXSheetCreated`, `AXValueChanged` and so on, and a settle waits for the announcement rather than for a duration. `AXObserverCreate` takes a C function pointer, which JXA's ObjC bridge cannot marshal (VOPAT1 §4), so the observer cannot live inside an osascript hop. It lives in a `python3` + ctypes **sidecar**, spawned from inside the hop so it inherits the Accessibility identity that already holds the grant.

Both of that sidecar's transports reach their socket through `do shell script`:

- the **spawn hop** backgrounds `python3` from AppleScript;
- the **in-script client** talks to the socket with `printf | nc -U`.

The deputy's broker lints every script it is handed and refuses any containing `do shell script` (`scriptGuard`, `deputy/src/server.swift`), because a broker that will shell out is no longer "drive the Things GUI" but "run arbitrary shell under the helper's grants". That lint is correct and stays. 0.20.7 shipped the sidecar without a gate for it and `todo add-repeating --dangerously-drive-gui` died in ~2 s on every helpers-routed Mac; #698 made deputy routing one more `observerAvailable() = false` reason, which restored the certified polling settles there.

So the state before this campaign: **the observer existed on every Mac that drives Things directly, and on none that routes through the helpers** — including the maintainer's, which is the only field host there is. `make-repeating` measured **6.87 s** routed against a modelled ~5 s with settles, and the area-reorder ladder's fold/scroll/drag settles are the same story at a larger scale.

## 2. The ruling: host the observer where the grant already lives

An `AXObserver` needs a process that (a) holds Accessibility trust and (b) can own a C function pointer and a CFRunLoop. On a routed Mac, one process satisfies both by construction: **the deputy**. It is already trusted — it is what every drive's clicks and keystrokes go through — and it is already listening on a socket this library already talks to. Nothing needs to be spawned, and no new consent class is touched.

Recorded as a ruling in [design/decisions.md](../design/decisions.md) (2026-09-03).

## 3. What was built

**`deputy/src/observer.swift`** — an `ObserverSession` per drive:

| piece | shape | why |
|---|---|---|
| observer | `AXObserverCreate` on Things' pid, the same 16 notification classes as the sidecar, registered on the **application element** | VOPAT2 measured application-element registration as sufficient: sheet, menu and pop-up arrivals all appear, each tagged with its own role |
| run loop | **its own thread**, pumping `CFRunLoopRunInMode` in 50 ms slices | the deputy's main thread sits in `dispatchMain()`, which services the main dispatch queue and **never runs a CFRunLoop** — a source added to the main run loop would never fire. This is the one non-obvious port detail |
| ledger | sequence-numbered arrivals, 4000 cap, trimmed count reported as `dropped` | idle chatter is zero (VOPAT1-6) and the largest measured burst is 65, so this is a whole drive with room to spare; a waiter is never silently answered out of a ledger that lost evidence |
| matcher | ANY-OF `want`, ALL-OF `all`, both `Notification[:Role]`; `quietMs` debounce | identical semantics to the sidecar, including the one place the quiet window is load-bearing (two indistinguishable `AXValueChanged:AXPopUpButton` arrivals, NEXTPOP1) |
| marks | timestamped, keyed by the sequence returned, 64 kept | so a reported latency is measured **from the actuation** rather than from the wait request — the confusion that made the sidecar's first traces report negative latencies |
| content | a notification **name** and an element **role**. Nothing else | a public repo's evidence trail cannot carry task titles. The brief's optional `elementTitle` was deliberately not implemented |
| bounds | explicit `observer-stop`, 120 s idle reaper on a `DispatchSource` timer, 4-session cap, and `stopAll()` on the deputy's drain | a crashed client cannot leak an observer, and no observer outlives the deputy that hosts it |

**Protocol** (`deputy/src/server.swift` + `src/deputy/protocol.ts`), kebab verbs matching the deputy's existing vocabulary:

```
observer-start  {pid?, selfTest?}  -> {observer, seq0, registered, asked, pid, selfTest}
observer-mark   {observer}         -> {seq}
observer-wait   {observer, after, want[], all?, quietMs?, timeoutMs}
                                   -> {seq, seen, timedOut, fired?, latencyMs?, waitedMs, hits?, dropped, events[]}
observer-stop   {observer}         -> {stopped}
observer-inject {observer, events[]}  -> {added}      # self-test sessions only
```

Four notes on the shape, each a decision:

1. **`observer-mark` is its own message.** The brief specified three, with `after`/`seq` cursors making "the next X after step N" race-free. It does — but only if the cursor is read *fresh, immediately before the actuation*. A cursor cached from an earlier reply would let arrivals between that reply and the actuation satisfy the settle, which is the exact defect the mark exists to prevent.
2. **`count` needs no message.** A wait with an empty `want` and `timeoutMs: 0` reports what landed since the cursor and returns — that is the non-blocking "did the previous step actuate anything?" question, which is only meaningful because Things is silent when nothing happens (VOPAT1-6).
3. **`observer-wait` is dispatched off the connection's read loop**, with a per-connection write lock and a `DispatchGroup` that keeps the descriptor alive until offloaded writers finish. Both TS transports match responses by id, so out-of-order replies are safe; a 1.2 s settle holding the read loop would have stalled the drive's next osascript behind it.
4. **`observer-inject` + a self-test session** (no AXObserver at all) is the seam that lets the matcher, the debounce, the cursor semantics and every bounded exit be certified against the **real Swift binary** on a host where the child deputy is not Accessibility-trusted — CI included. It refuses on any session not *started* as a self-test, so nothing can put a fabricated arrival in front of a real settle. Precedent: the sidecar's `--self-test`.

**Capability handshake.** `hello` gains `capabilities: ["observer"]`; `PROTOCOL_VERSION` deliberately does **not** move. Bumping it deactivates routing outright on hosts with an older helper (`reconcileVersions`), which is the opposite of the graceful degrade this needs; testing the *version line* would make every unrelated helper bump a settle regression. Helpers 1.3.0 advertise no list, `deputyHostsObserver()` reads that as "no observer", and the drive runs the certified polling settles. This is capability detection, which the permissions doctrine requires anyway — not compatibility machinery under ALPHA-CONTRACT: there is no alias map, no legacy reader, nothing to delete at 1.0.

**Library side** (`src/write/vectors/ui-observer.ts`). `observerAvailable()` is replaced by `observerTransport()` → `sidecar | deputy | none` + a reason, decided once per drive and traced. `ObserverSession` is now a discriminated union; `startObserver` / `observerMark` / `observerCount` / `observerAwait` / `stopObserver` branch on it. Every deputy failure traces and returns null-or-miss — never a throw into a drive, and never a refusal, exactly as an absent sidecar behaves.

## 4. The half this does NOT restore, stated plainly

`settleInjectorFor()` returns the **inert** injector for a deputy-hosted session. The in-script client reaches its socket through `do shell script` — the banned phrase — so on a routed host **every generated script is still byte-identical to the polling version**.

What the routed transport therefore carries is the settles **node** performs:

| settle | routed before | routed after |
|---|---|---|
| per-step ledger mark | — | one socket round-trip |
| "did that step actuate anything?" | a whole polling hop | one socket round-trip |
| the `Next:` pop-up absorbing the rule change (a whole hop; up to **1.66 s**, and the pause the maintainer could see) | polling hop, up to 13 content reads | no osascript, no read — a wait on the ledger |

and what it does not carry:

| settle | routed after |
|---|---|
| the pop-up's menu opening / closing on an unchanged value | still the `exists menu 1` poll |
| a field taking focus | still `delay 0.15` |
| a field taking a typed value | still `delay 0.1` |

This keeps #698's four certified quadrants ({observer up/down} × {pre-fill on/off}, DEFAULTS3) intact, because a routed drive produces exactly one of the two script shapes those quadrants were certified against. `test/unit/ui-script-broker-safety.test.ts` asserts it positively: a deputy-hosted session renders the whole script catalog clean of the banned phrases, and the sidecar shape is kept as the negative control that proves the guard still has teeth.

**The remaining lever, for the maintainer to rule on rather than for this campaign to assume.** An in-script settle needs a transport an AppleScript can use that a broker will pass. The one prompt-free candidate is a **file rendezvous** via StandardAdditions `read`/`write`: the script writes a request file into the session's own directory and polls for the response file at ~20 ms granularity, with no shell and no Apple event. That trades a chain of Accessibility tree polls for a cheap local file poll — real, but it reintroduces a polling granularity the notification path had removed, and it adds a second protocol to keep in step across the seam. Not implemented, deliberately.

## 5. Certification

All by exit code; `npm run check` green.

| suite | what it proves | result |
|---|---|---|
| `test/deputy/broker-integration.test.ts` (`THINGS_DEPUTY_LIVE=1`, real Swift binary, child deputy, temp state dir) | the capability in `hello`; session mint → cursor → stop, and a stopped token refusing by name (`no-session`); a wait satisfied past the cursor with `fired` reported; **role discrimination** (the wrong role for the same notification is not the arrival — VOPAT1 §4.2 g's 366-ms-too-early defect); ALL-OF requirements, including `missing` named on timeout; the no-matcher count; a wait timing out inside its budget **with the connection still good afterwards**; malformed input (7 shapes) each refused by code; a real session that cannot attach refusing `observer-unavailable` **without prompting** | **22/22** |
| `test/unit/deputy-protocol.test.ts` | the capability string pinned across the language seam (parsed out of `main.swift`); `deputyHostsObserver` on a 1.4.0 hello, a 1.3.0 hello, an empty list and null; **the notification list pinned between `observer.swift` and the sidecar** (a class present in one and absent from the other is a settle that fires on one host class only) | **9/9** |
| `test/unit/ui-script-broker-safety.test.ts` | a routed host answers from routing rather than from a tool probe; the spawn hop is never generated there; a **deputy-hosted session still renders the polling catalog**; the sidecar shape is still what the broker refuses | **6/6** |
| `test/unit/ui-observer.test.ts` | the sync and async transport decisions cannot disagree; the off switch beats everything; a routed host with nothing installed reports routing's reason — plus the whole pre-existing sidecar protocol suite | **41/41** |

## 6. What is NOT certified here, and by whom it must be

- **No field measurement.** The before/after on the maintainer's M1 (`things todo add-repeating … --dangerously-drive-gui --json` with `THINGS_API_TRACE=1`, three runs each side) requires writing synthetic rows to the production database and installing helpers 1.4.0 on a live host. Both are the maintainer's to perform. What to expect, honestly: the fixed-timer settles that disappear from a routed run are the **node-side** ones — principally the `Next:` recompute hop — so the credible delta on `make-repeating` is roughly that hop's cost, not the full modelled ~2 s.
- **No consent-dialog verdict on hardware.** The transport decision is prompt-free *by construction* — the routed branch reads the handshake activation already performed, and nothing in `observer.swift` calls `AXIsProcessTrustedWithOptions` (the one prompting API lives in `tcc.swift`, reached only by `prime-ax` inside a ceremony). An untrusted deputy refuses `observer-unavailable` and the drive falls back to polling. That is the design; a rebuilt-and-reinstalled 1.4.0 raising nothing is the maintainer's to confirm.
- **No routed lab arm.** The lab certifies direct execution; the routed arm is still the maintainer's-host RC smoke (see the open "Helpers IN THE GUEST" queue item — this campaign is another reason it is worth building).

## 7. One incident, and the guard it bought

A unit run in this campaign's worktree **bounced the maintainer's running deputy twice**. `test/unit/ui-script-broker-safety.test.ts` asserts the routed decision with `THINGS_API_HELPERS=true` and, as written, the **default** state dir — so `deputyRouting` handshook the *live* helper; the worktree's version line was already at 1.4.0 while the installed bundle was 1.3.0, and `reconcileVersions` responded exactly as designed: `launchctl kickstart -k`. Twice, because the suite resets the routing memo per case. Nothing was installed or replaced; the audit log records the stop/start pairs.

Two fixes, both in this batch: the suite mints its own temp state dir, and **`vitest.config.ts` now pins `THINGS_API_STATE_DIR` at a throwaway** for the whole suite — the same blast-shield pattern already applied to `THINGS_API_LAUNCH_AGENTS_DIR` after it deleted the live helpers' plists mid-check in August. A routing-opt-in suite now resolves to "not installed" instead of finding the developer's live helper.

The live broker suite taught the same lesson one layer up: a bare `observer-start` there **succeeded against the running Things**, because the child deputy is signed with the same identity as the installed bundle and TCC hands it the same Accessibility grant. Passive or not, a test does not attach an observer to the user's running app; that cell now passes a pid that cannot exist, which exercises the refusal path on a trusted host and an untrusted one alike.
