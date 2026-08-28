# DRVLAT1 — where a GUI drive's seconds go, and the hop collapse that removes them

**Probed under: `things-lab-golden-v4` · Things 3.23 (build 32300036) · macOS 15.7.7 · DB schema v27 · pinned clock 2026-07-05 12:00 (trial wall 2026-07-18, never rolled).** ONE disposable clone of golden-v4 (the golden is never booted), airgapped, guest muted, beep sentinel default-on. Fixtures fully synthetic (`DRVLAT1 *` titles). Both lab escapes exported (`THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1`). Driver: [`lab/scripts/research-drvlat1.sh`](../../lab/scripts/research-drvlat1.sh) (`setup` · `ship` · `shipnew` · `profile` · `cells` · `chord` · `bgpress` · `teardown`); per-hop table renderer [`lab/scripts/drvlat1-table.mjs`](../../lab/scripts/drvlat1-table.mjs). Artifacts (gitignored): `lab/artifacts/drvlat1/`.

Occasioned by field measurement M1 ([#633](https://github.com/mikegreiling/things-api/issues/633)): a SUCCESSFUL 10-step `todo make-repeating … --after-completion` took **11,337 ms** on the maintainer's desktop under v0.19.3. Sibling to [PERF1](perf1-drive-overhead.md) (reachability-probe scoping) and [PERF2](perf2-step-latency.md) (the set-datetime collect scoping + the first delay audit); this is the campaign that stopped trimming individual delays and went after the HOP COUNT.

> **What a clone can and cannot say.** In a clone the escapes run osascript DIRECT, so the deputy IPC the field pays on every hop is not measurable here, and the golden's database is tiny next to the maintainer's. Both make the absolute numbers below smaller than the field's. Neither changes the SHAPE of the budget — which hops exist, and what each one waits for — and the shape is what this campaign moves. The field adder is discussed in §6, honestly, as an adder.

## 1. The command shape

The field's exact invocation, on a synthetic seed:

```
todo make-repeating <uuid> --frequency monthly --interval 1 --after-completion --dangerously-drive-gui
```

It compiles to **10 recipe steps** — reveal · activate · assert-eligible · press Items ▸ Repeat… · wait for the dialog · frequency = after completion · after-completion unit = monthly · interval = 1 · pre-commit audit · press OK — and, before this campaign, **dispatched 20 osascript hops** to run them. That gap between steps and hops is the whole finding.

`--interval 1` is the default the dialog already shows, so the interval step exercises the read-back-first skip (#620 item 7) and types NOTHING. The drive therefore sends **zero keystrokes**: everything here is element-addressed, which is worth keeping in mind reading §5.

## 2. BEFORE — the per-hop budget (old bundle, v0.19.3 as shipped)

Traced with `THINGS_API_TRACE=true`; two reps, `elapsedMs` 5,519 and 5,486, both `ok: true`, **0 alert beeps**. The rep-2 table (the median shape; rep 1 differs only in census noise):

| # | at ms | gap ms | dur ms | primitive | what it is |
| ---: | ---: | ---: | ---: | --- | --- |
| 1 | 15 | 15 | 127 | resolve | census — the pipeline's pre-drive window/focus read |
| 2 | 142 | 0 | 81 | resolve | session-reachability probe (PERF1 pre-seed gate) |
| — | — | **341** | — | — | *the composite's two headless legs: `todo.add` (url-scheme) + `todo.delete` (applescript), each verified* |
| 3 | 564 | 0 | 19 | reveal | `things:///show?id=` |
| 4 | 583 | 0 | 57 | activate | bring Things to the foreground |
| — | — | **1003** | — | — | *`SETTLE_AFTER_REVEAL_MS` — a FIXED sleep* |
| 5 | 1643 | 0 | 103 | resolve | census — the drive's open-dialog precondition |
| 6 | 1746 | 0 | 79 | resolve | canary: does `Items ▸ Repeat…` resolve? |
| 7 | 1826 | 1 | 84 | assert-eligible | the reveal landed an eligible selection |
| 8 | 1910 | 0 | 71 | press | `Items ▸ Repeat…` |
| 9 | 1981 | 0 | 407 | wait | the Repeat dialog appears |
| 10 | 2388 | 0 | 63 | resolve | which shell holds the frequency pop-up? |
| 11 | 2451 | 0 | 414 | select-popup | frequency = after completion |
| 12 | 2865 | 0 | 64 | resolve | which shell holds the unit pop-up? |
| 13 | 2929 | 0 | 719 | select-popup | after-completion unit = monthly |
| 14 | 3648 | 0 | 59 | resolve | which shell holds the cadence group? |
| 15 | 3707 | 0 | 269 | resolve | census — the per-step FOCUS GUARD |
| 16 | 3976 | 0 | 627 | set-group-number | interval = 1 (read-back-first: types nothing) |
| 17 | 4604 | 1 | 56 | resolve | which shell does the audit read? |
| 18 | 4661 | 1 | 294 | audit-dialog | the pre-commit audit (CGRD1) |
| 19 | 4955 | 0 | 50 | resolve | which shell holds OK? |
| 20 | 5006 | 1 | 57 | press | press "OK" |
| — | — | — | **423** | — | *verify poll (5 attempts, 408 ms) + the template read-back* |

**Totals: 20 hops · 3,700 ms of osascript wall · 1,348 ms of inter-hop gaps · 5,486 ms end to end.**

### Where the milliseconds actually were

| bucket | ms | share | what it is |
| --- | ---: | ---: | --- |
| the fixed post-preamble settle | 1,003 | 18% | ONE sleep, paid unconditionally |
| the two pop-up selections | 1,133 | 21% | each opens with a click then a flat `delay 0.3` before looking again |
| the interval step | 627 | 11% | cadence-group walk + the read-back-first skip's own 0.3 s settle |
| its focus-guard census | 269 | 5% | a whole extra osascript process, to decide whether to type |
| six auxiliary `resolve` hops | 371 | 7% | "which of the two dialog shells is live?", asked once per step, as its own process |
| the dialog wait | 407 | 7% | the app animating the sheet in — genuinely the app's time |
| the pre-commit audit | 294 | 5% | the CGRD1 read-back of every control |
| the composite's headless legs | 341 | 6% | `todo.add` + `todo.delete` and their verifies |
| the verify poll + read-back | 423 | 8% | 5 polls at the 100 ms cadence |
| everything else | 598 | 11% | reveal, activate, canary, eligibility, both presses, both censuses |

Read that as a sentence: **roughly a third of the drive was the driver waiting on its own fixed timers, and another sixth was osascript process startup for hops that answered questions the acting hop could have answered itself.** The app's own time — the sheet animating in, the menus rendering, the commit — is the minority.

## 3. What changed

Four changes, in the issue's own preference order. No guard, audit or read-back was removed; every one of them moved INTO the hop it belongs to.

### (a) Guard + resolution + action, in ONE script per step

**The focus guard.** A keystroke-class hop used to dispatch the census as its own osascript, judge the result in TypeScript, and then dispatch the keystroke. That is a process per typed control AND a TOCTOU window — the screen can change between the census that approved the keystroke and the keystroke itself. The census is now the PRELUDE of the very script that types (`axFocusGuardPrelude`, `src/write/vectors/ui-state.ts`): the same probes, in the same order, under the same per-Apple-event budgets, compiled ahead of the same typing body. Nothing is dispatched in between, because there is nothing in between.

The judgement stays single-sourced. The prelude LOGS its census record (one stderr line) and refuses with a bare machine tag, never a sentence; the driver recovers that record, parses it into the same `UiState` the stand-alone census yields, and asks `judgeFocusGuard` — unchanged — for the wording. So the DECISION is made in-script, before the keystroke, and every refusal a caller can read is still built in exactly one place. Pointer-class hops keep the separate census: they dispatch JXA, which cannot carry an AppleScript prelude.

**The element resolution.** A candidate-addressed step (the attached-sheet vs detached-window disjunction, UIC4-a) used to dispatch one `resolve` per candidate per poll round before the hop that acted. `axCandidatePrelude` now polls those candidates in the same priority order inside the acting script, binds the first that exists to one reference, and the addressed body acts on THAT — so the element a step acts on is the one it just proved exists, with nothing dispatched in between. A miss raises the driver's own wording (`CANDIDATES_MISSED`) and lands on the step's ordinary fail-closed path, cleanup and all.

**The waits.** `waitForElement` / `waitForAnyElement` polled from TypeScript, paying a process per round; `axWaitAnyScript` does the whole wait in one hop and answers `"true"`/`"false"`, leaving the driver's abort path untouched.

### (b) Fixed sleeps → closed loops

- **`SETTLE_AFTER_REVEAL_MS` (1,000 ms) is gone.** It existed so the menu bar could repopulate around the new selection before the canary read it (UIC1) — PERF2 measured that repopulation at ~92 ms median / 116 ms max and trimmed the settle 1500 → 1000, i.e. it kept spending ~900 ms of every drive on margin. The canary and the eligibility assertion now POLL, on a bounded deadline, in their own hops (`axWaitAnyScript`, and `axAssertEligibleScript`'s `repeat until verdict is "OK"`). Strictly better on both ends: it proceeds the moment the menu answers, and it tolerates a host slower than any fixed settle would have covered.
- **The pop-up open loop's flat `delay 0.3`** became a 0.05 s poll on the menu's existence. The CLICK cadence is unchanged — one click per round, never a second click into a menu that is already opening (BEEP1) — only the looking is finer.
- Deliberately NOT touched: the read-back-first skip's two-reads-a-settle-apart gate (0.3 s), which exists to catch the UIC7 re-layout revert; and the typing loop's own settles, which are only paid when a keystroke actually goes out.

### (c) The activation step — measured, and KEPT

See §5. It stays, on evidence.

### (d) The verify poll

Left alone, measured rather than assumed: the successful drive's post-OK tail is 423 ms over 5 polls, and the poller's first evaluation is immediate with a 100 ms cadence for the first 2 s. The tail is the app committing the rule, not the poller waiting — there is nothing here to win, and a finer cadence would only add database reads.

## 4. AFTER — the same fixture, the same trace

Three reps on the new bundle: `elapsedMs` 3,677 / 3,643 / 3,777, all `ok: true`, all landing the same monthly after-completion rule, **0 alert beeps**. The rep matching the table above:

| # | at ms | gap ms | dur ms | primitive | what it is |
| ---: | ---: | ---: | ---: | --- | --- |
| 1 | 12 | 12 | 197 | resolve | census — the pipeline's pre-drive read |
| 2 | 210 | 1 | 65 | resolve | session-reachability probe |
| — | — | **313** | — | — | *the composite's two headless legs* |
| 3 | 588 | 0 | 17 | reveal | `things:///show?id=` |
| 4 | 605 | 0 | 51 | activate | bring Things to the foreground |
| 5 | 656 | 0 | 95 | resolve | census — the drive's open-dialog precondition |
| 6 | 751 | 0 | 75 | resolve | canary, POLLED (this is where the settle went) |
| 7 | 826 | 0 | 80 | assert-eligible | eligibility, POLLED |
| 8 | 906 | 0 | 66 | press | `Items ▸ Repeat…` |
| 9 | 972 | 0 | 392 | wait | the Repeat dialog appears |
| 10 | 1365 | 1 | 128 | select-popup | frequency = after completion *(+ its own resolution)* |
| 11 | 1493 | 0 | 580 | select-popup | unit = monthly *(+ its own resolution)* |
| 12 | 2073 | 0 | 847 | set-group-number | interval = 1 *(+ its own resolution AND its focus guard)* |
| 13 | 2921 | 1 | 59 | resolve | which shell does the audit read? |
| 14 | 2981 | 1 | 303 | audit-dialog | the pre-commit audit |
| 15 | 3284 | 0 | 67 | press | press "OK" *(+ its own resolution)* |
| — | — | — | **326** | — | *verify poll + template read-back* |

**Totals: 15 hops · 3,022 ms of osascript wall · 317 ms of inter-hop gaps · 3,677 ms end to end.**

### The delta, honestly

| | OLD | NEW | delta |
| --- | ---: | ---: | ---: |
| osascript hops | 20 | **15** | −5 (−25%) |
| osascript wall | 3,700 ms | 3,022 ms | −678 ms |
| inter-hop gaps (driver sleeps) | 1,348 ms | **317 ms** | −1,031 ms |
| **end to end** (`elapsedMs`) | 5,519 / 5,486 | **3,677 / 3,643 / 3,777** | **≈ −1,800 ms, −33%** |

Per step, where it came from:

| step | OLD (hops → ms) | NEW (hops → ms) | delta |
| --- | ---: | ---: | ---: |
| post-preamble settle | — → 1,003 | — → 0 | **−1,003** |
| frequency pop-up | 2 → 477 | 1 → 128 | −349 |
| unit pop-up | 2 → 783 | 1 → 580 | −203 |
| interval (guard + resolve + set) | 3 → 955 | 1 → 847 | −108 |
| press OK | 2 → 107 | 1 → 67 | −40 |
| canary + eligibility | 2 → 163 | 2 → 155 | −8 |
| dialog wait | 1 → 407 | 1 → 392 | −15 |
| audit (shell resolve + read) | 2 → 350 | 2 → 362 | +12 |

Two of those are worth naming individually. The **frequency pop-up went 477 → 128 ms**: one process instead of two, and the menu is looked at again 50 ms after the click rather than 300 ms. The **interval step went 955 → 847 ms across three hops → one** — a smaller win in the clone precisely because the clone's census is cheap; on a host where the census is expensive, that hop is where the fold pays most.

Nothing in the audit moved, which is the point: it is the same read of the same controls.

## 5. The activation step: does the Repeat drive work BACKGROUNDED? (issue item 3)

The preamble's `activate` step has carried the label *"skipped once background press is certified"* since UIC1. Measured rather than assumed, with **Finder frontmost and Things in the background** the whole way (`bgpress` cell):

| rung | what was driven, with Finder frontmost | result |
| --- | --- | --- |
| R0 | who owns the screen | `Finder` |
| R1 | `things:///show` selection · `enabled of menu item "Repeat…"` · AXPress it | selection = the seed uuid · **enabled = true** · **press lands** |
| R2 | did Things come forward? which form did the dialog take? | frontmost still `Finder` · attached sheet **false** · detached AXUnknown window **1** |
| R3 | open the frequency pop-up and click `after completion` (element-addressed) | **works** — the pop-up reads back `after completion` |
| R4 | focus the interval field, `keystroke "7"`, read it back | `before=1 focused=true` **`after=1`** — the field took FOCUS and the keystroke did **not** land |
| R5 | dismiss it: AXPress its own Cancel | **inert** — the dialog is still there |

So: **element-addressed steps work backgrounded, and everything that needs the screen does not.** R4 is the decisive rung — the field genuinely accepted keyboard focus (`focused=true`, so the element half of the guard is satisfied) and the digit still never arrived, because System Events `keystroke` is delivered to whatever owns the screen. It went to Finder. That is [HEADORD1 1h](headord1-heading-order.md) measured directly on this dialog, and it is why the focus guard exists at all.

Pruning the activation step would therefore break every drive that types — which is every drive except the ones whose values already match. That alone settles it. But R5 turned up a second, harder reason:

**A Repeat editor opened while Things is BACKGROUNDED cannot be dismissed by any route this project has.** Follow-up probes on that stuck editor — confirmed to BE the Repeat dialog by its control census (`cb:2 pu:1 bt:2 gp:1 tf:0`, buttons `OK`/`Cancel`, 545×233 at 239/139) and by the shipped census (`the Repeat dialog is open (detached)`):

| dismissal route | result |
| --- | --- |
| AXPress `button "Cancel"`, Things backgrounded | dialog remains |
| AXPress `button "Cancel"`, Things activated first | dialog remains |
| AXPress `button "Cancel"` after `AXRaise` on the window | dialog remains |
| `key code 53` (Escape) | dialog remains |
| ⌘W then re-activate (the close+reopen rung) | dialog remains |
| a real HID click at the AX-resolved Cancel centre (646, 342) | dialog remains |

Every rung of the cleanup ladder is inert against it. The shipped driver never meets this because the recipe ACTIVATES first, so its dialog is always the ATTACHED sheet — whose Cancel dismisses reliably, including with another app frontmost (re-certified in the T cell today, §7). Recorded as [oddities §26](../things-app-oddities.md).

**Verdict: the activation step STAYS, and its label is corrected.** It was marked *"skipped once background press is certified"*; background press IS certified — and the drive still needs the foreground, for the keystrokes and for the ability to abort. The label now says which.

## 6. The field adder this clone cannot measure

Two costs the maintainer's desktop pays that a clone does not, both per-hop, so both scale with the hop count this campaign cut:

1. **The deputy round-trip.** On a shipped host every osascript is routed through the helper over a UNIX socket (`src/deputy/osa.ts` → `deputyAsyncRequest`), which spawns the interpreter in the deputy's process rather than the CLI's. In a clone the lab escape runs it DIRECT. The adder is small per hop — a socket round-trip on a warm connection — but it is paid 20 times in the old shape and 15 in the new.
2. **The tree the hop walks.** Every addressed read is answered by System Events against the live Things process. On a large, actively-syncing database with a big list window that costs more per call than it does against the golden's near-empty one — the same mechanism PERF2 measured directly (an app-root walk: 125 ms on the golden, ~4.4 s on the field host).

So the honest statement of the field expectation is a SHAPE, not a number: the fixed 1,003 ms settle is removed identically on every host, and five of twenty hops are removed — each of which the field pays more for than the clone does. The clone's −33% is therefore a conservative floor for the field, not an estimate of it. The next field trace on this shape is what settles it, and it is worth taking.

## 7. Guard re-certification (the semantics that must not have moved)

Every cell below re-run against the NEW bundle in the same clone. **0 alert beeps** across the whole cell set (5 marks), the chord cell and the bgpress cell.

| cell | what it proves | verdict |
| --- | --- | --- |
| U1–U4 | the census reads the same in all four quadrants (dialog none\|repeat × frontmost us\|other) | **PASS** — `Things is frontmost; no dialog` · `Finder is frontmost; no dialog` · `Things is frontmost; the Repeat dialog is open (attached)` · `Finder is frontmost; the Repeat dialog is open (attached)` |
| C2 | a drive started with a stranded dialog standing refuses, commits nothing, and the census still names what is open | **PASS** — exit 4 `blocked:environment`, "nothing was created", bravo non-repeating (0), census still names the open dialog |
| S | an already-set rule discloses the skip and types nothing | **PASS** — exit 0, template minted, the disclosure warnings intact |
| T | focus theft mid-drive refuses with nothing typed, nothing mutated, dialog cleared by its own Cancel | **PASS** — see below |
| X | the MODALX1 open-dialog preflight refuses before anything is pressed | **PASS** — exit 4 `blocked:environment`, delta non-repeating (0) |
| chord | one #606-family chord op (`project move-heading … --first`) still reorders — the shared dispatch seam is unmoved | **PASS** — `Alpha \| Bravo \| Charlie` → `Charlie \| Alpha \| Bravo`, exit 0 |

The **T cell is the one that certifies the guard fold**, because it is the cell the fold could have broken. A drive that MUST type (`--interval 3`, so the read-back-first skip cannot apply) is started, and Finder is activated the instant the dialog appears — a closed loop on the dialog's existence, never a sleep. With the census now compiled INTO the keystroke's own script, the drive refused at exactly the right step with exactly the wording it had before:

```
ui drive stopped at "interval = 3" (refused to run "interval = 3": Finder is frontmost and
keyboard focus is on a AXGroup, so the input would go there instead of to Things — nothing
was sent. Leave Things in front while it is being driven, then run the same command again).
Completed: … → frequency = weekly. the repeat dialog was closed with its own Cancel button,
confirmed closed (Finder is frontmost and keyboard focus is on a AXGroup when cleanup
started). — and a follow-up re-read found no landed change
```

Byte-identical wording is the deliberate consequence of §3(a): the prelude refuses with a bare tag and `judgeFocusGuard` — untouched — still writes every sentence. Nothing was typed, `charlie` is not repeating, and the census afterwards reports no dialog open.

## 8. What this campaign did NOT do

- **The pre-commit audit still resolves its shell in its own hop.** Folding it needs the audit plan to carry shell-RELATIVE control paths, which is a recipe-level refactor for ~56 ms in the clone. Left open deliberately.
- **The composite's two headless legs (~320 ms)** are a `todo.add` + `todo.delete` pair with their own verifies. Not touched — that is the promote-clone identity mechanism, not latency to shave.
- **The dialog wait (~400 ms) is the app.** It is already one closed-loop hop; the time is Things animating its sheet in.
- **It did not measure the deputy.** §6 names that adder from the code path rather than from a stopwatch; a clone has no deputy to time. The next field trace is what quantifies it.
- **It found one app defect and did not fix it** (nothing here can): the detached Repeat editor of §5 / [oddities §26](../things-app-oddities.md) is un-dismissable. Unreachable from the shipped driver as long as the activation step stands, which is now one of the reasons it stands.
