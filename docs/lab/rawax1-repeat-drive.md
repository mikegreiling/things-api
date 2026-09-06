# RAWAX1 — the Repeat drive in raw Accessibility calls

**Status: PHASE 0 COMPLETE — the memo, the probe, and every cell measured. Nothing in `src/` has changed. The port (Phase 1) waits on the ruling §3.2 asks for.**

**Probed under:** `things-lab-golden-v4` · Things **3.23** (build 32300036) · macOS **15.7.7** · DB schema **v27** · guest clock pinned **2026-07-05 12:00** (trial wall 2026-07-18, never rolled). ONE disposable clone (`rawax1-lab`) of golden-v4 — the golden is never booted — airgapped, guest muted, beep sentinel on in report-only mode, destroyed at teardown. Fixtures fully synthetic (`RAWAX1-*`). Immutable snapshot per the [harness](harness.md) version-stamping policy.

Driver: [`lab/scripts/research-rawax1.sh`](../../lab/scripts/research-rawax1.sh) — cells `shape` · `prims` · `menu` · `dismissprobe` · `setvalue` · `dates` · `menubar` · `rowselect` · `cost` · `teardown`. Probe rig: [`lab/scripts/rawax1-probe.jxa.js`](../../lab/scripts/rawax1-probe.jxa.js). Artifacts (gitignored): `lab/artifacts/rawax1-lab/`.

Commissioned by the maintainer 2026-09-05 against the open item [RDLAT2](rdlat2-repeat-dialog-latency.md) / [VOPAT1 §8](vopat1-screen-reader-pattern.md) left on the table, and the ruling request in [#687](https://github.com/mikegreiling/things-api/issues/687) / [#695](https://github.com/mikegreiling/things-api/issues/695).

---

## 0. The thesis, in three measured numbers

| | measured | where |
| --- | ---: | --- |
| one Apple event to System Events, maintainer's M1 | **~47 ms** (fitted) | [RDLAT2 §8](rdlat2-repeat-dialog-latency.md) |
| one `osascript` spawn, maintainer's M1 | **~124 ms** (fitted) | RDLAT2 §8 |
| one raw AX attribute read through the JXA ObjC bridge, maintainer's M1 | **0.12 ms** | [VOPAT1 §field law](vopat1-screen-reader-pattern.md) |

The shipped `make-repeating` is **15 hops · 88 Apple events** (§1.4 — RDLAT2 counted 13 before LOCKSCR1's lock probe and VOPAT2's observer spawn existed), so on that machine the transport alone is `15 × 124 + 88 × 47 ≈ 1.9 s + 4.1 s = 6.0 s` of a drive the maintainer clocked at **6.9 s** under v0.20.8. The Accessibility work inside those events is the same work either way — the dialog is 12 controls wide, 22 at its widest, and [RDLAT2 §E.2](rdlat2-repeat-dialog-latency.md) measured content reads on it costing what geometry reads cost, with no realize-and-discard signature. **The drive is not slow because it asks the tree too much. It is slow because of who it asks through.**

Replacing the asker — making the same AX calls in-process from JXA, inside the same `osascript` hops — takes the 4.1 s Apple-event term to `88 × 0.12 ms ≈ 11 ms` and leaves the spawn term and the app's own time. That is the campaign. VOPAT1 §8 predicted **≈ 2.2 s** for this drive on that basis; §4 below re-derives it with the spawn term put back, which VOPAT1's arithmetic understated.

**What a clone can and cannot answer.** A lab clone is ~200× cheaper per realized element than a real display, and its Apple events are ~8 ms rather than ~47 ms ([harness.md §Cost law corollary](harness.md)). So **no wall time in this document transfers to the field**. What transfers is: whether a raw call AGREES with the System Events call it would replace, how many calls each shape costs, and what the app announces. Every cell reports those three; the multiplier is the maintainer's own trace.

---

## 1. The primitive inventory

Every distinct thing the Repeat drive asks of System Events, the generator it lives in, and the raw-AX call that would replace it. `#` is the primitive id used by the probe's equivalence matrix (`prims`, §2), and the VERDICT column carries what the probe measured — an unmeasured primitive would not be portable, and none is left.

**Two of the twenty do not port, and both are the ones the campaign said up front it expected to fail.** That is the shape a good equivalence result has: the transport changes and the two places where AX is not a transport question stay exactly as they were.

### 1.1 Reads

| # | System Events form | where it lives | raw AX equivalent | verdict |
| --- | --- | --- | --- | ---: |
| **P1** | `exists (<path>)` | `axResolveScript`, `axCandidatePrelude`, `axWaitAnyScript`, `axDialogOpenScript`, the canary | resolve the descriptor by walking `AXWindows`/`AXChildren` with role/subrole/title filters; a null resolution is "does not exist" | **AGREES** · 3.87 ms vs 4.67 — the ONE row raw barely wins, and §5.2 says why: bind the shell once per hop |
| **P3** | `value of <el>` | every read-back, the pre-commit audit, `verify-prefill`, `settle-occurrences` | `AXUIElementCopyAttributeValue(el, kAXValueAttribute)` | **AGREES** · 0.082–0.106 ms vs 5.44–5.81 (**55–66×**) |
| **P4** | `value of static texts of <g>` + `position of static texts of <g>` + the same for `text fields` (4 plural events) | `AX_CADENCE_HANDLERS` `cgSnap` — the HXPC1/CGRD1 label-row discrimination's whole input | one `AXChildren` on the group, then one `AXUIElementCopyMultipleAttributeValues` per child (role+value+position+size in ONE call) | **AGREES** · 1.42–4.43 ms vs 24.1–24.4 (**5.5–17×**) |
| **P5** | `count of <class> of <container>` | `converge-weekdays`, the audit's weekday walk, the old census | `AXChildren` + an in-process role filter — **zero** extra calls once the children are in hand | **AGREES** · 0.44–1.55 ms vs 9.69–10.32 |
| **P6** | `position of` / `size of` | every frame resolution, the label-row discrimination | `AXPosition` / `AXSize`, or folded into the batched node read | **AGREES** · 0.217–0.252 ms vs 5.36–6.30 |
| **P15** | `enabled of <el>` | `assert-eligible` | `AXUIElementCopyAttributeValue(el, kAXEnabledAttribute)` | **AGREES** · 0.080–0.081 ms vs 5.20–5.60 (**65–69×**), and on a CLOSED menu bar too (§5.6) |
| **P17** | `value of attribute "AXIdentifier" of <el>` | the Move… picker's identity check | `AXUIElementCopyAttributeValue(el, "AXIdentifier")` | **AGREES** on the verdict — both say absent on a shell that has none; raw returns null where AppleScript throws (§5.2) |
| **P18** | `role of UI elements of <shell>` | the `dialog-open` shell census, the window/focus census | `AXChildren` + `AXRole` per child | **AGREES** · 0.98–1.12 ms vs 6.17–6.24; the whole census is **9 calls / 1.4 ms** |
| **P8** | `focused of <tf>` | `focusedAssertBlock` | `AXUIElementCopyAttributeValue(el, kAXFocusedAttribute)` | **AGREES** · 0.083–0.089 ms vs 6.04–6.45 (**68–78×**) |
| **P22** | `first window whose subrole is "AXStandardWindow"` · `sheet 1 of …` · `windows whose subrole is "AXUnknown" and size is not {40, 40}` | every dialog address, `AX_DIALOG_SHELL_SNIPPET` | already ported twice — `findShell()` in `AX_DATE_AREA_PRELUDE` and `mainWindow()` in `ui-drag.ts`'s JXA prelude | **shipped** |

### 1.2 Actuations

| # | System Events form | where it lives | raw AX equivalent | verdict |
| --- | --- | --- | --- | ---: |
| **P2** | `click <el>` on a menu item / button / checkbox / pop-up | `axPressScript`, `select-popup`, `ensure-checkbox`, the audit's folded commit, `axCancelDialogScript` | `AXUIElementPerformAction(el, kAXPressAction)` — which is what System Events' `click` compiles to | **PORTS** · opens a pop-up's menu in 12.4 ms, selects a menu item, presses OK/Cancel. One state where an enabled Cancel accepts and ignores it (§5.9) — reachable only by a sequence no drive performs |
| **P7** | `set focused of <tf> to true` | `typeLoopBlock` | `AXUIElementSetAttributeValue(el, kAXFocusedAttribute, <true>)` — [VOPAT1-13](vopat1-screen-reader-pattern.md) measured AXError 0 and the notification at 27.6 ms. **CORRECTED in phase 2 — see §5.2.** Phase 0 read `AXError 0` as proof the encoding marshalled; it was not. The write ports via `$(true)`, and focus is proven through the APPLICATION's `kAXFocusedUIElement` as well as the element's flag | **PORTS, loop intact** |
| **P9** | `keystroke "<v>"` | `typeLoopBlock`, `axTypeTextScript` | none. AX has no "type into this element" — the candidate is `AXUIElementSetAttributeValue(tf, AXValue, …)`, and UIC6 measured System Events' `set value` as a REPAINT that never fires the app's edit binding. **MEASURED: it is a REPAINT** (§5.4). Settable `true`, write `AXError 0`, field shows `3`, preview never recomputes, committed rule `fa=1`. So keystrokes stay — `CGEventCreateKeyboardEvent` + `CGEventPost(kCGHIDEventTap)` under the frontmost law, and a `GUARDED_SITES` entry (§3.5) | **DOES NOT PORT** |
| **P10** | `key code 48` (Tab) / `key code 53` (Escape) | the typing loop's commit, `axAbortScript` | `CGEventCreateKeyboardEvent` — already shipped as `postEscape()` in `ui-drag.ts`'s prelude | **shipped** |
| **P11** | `exists menu 1 of <pu>` | the pop-up open poll | the `AXMenu` is a CHILD of the pop-up, which has **no children at all** while closed — so "is the menu open" is one `AXChildren` read and needs no title match | **PORTS**, and gets simpler |
| **P12** | `exists menu item <name> of menu 1 of <pu>` · `click menu item <name>` | `select-popup`, `converge-weekdays` | `AXChildren` of the `AXMenu`, `AXTitle` match, `AXPress`. Items advertise `AXCancel,AXPress,AXPick`; the port uses `AXPress` because that is what `click` sends. The menu carries an empty-titled SEPARATOR, so a title match must be exact | **PORTS** |
| **P13** | `name of every menu item of <menu>` | `select-next-occurrence`'s cascade walk | `AXChildren` + `AXTitle` per item | **PORTS** · 17 live occurrence titles harvested (§5.8) |
| **P14** | `menu 1 of menu item N of <menu>` (the `More…` cascade) | `select-next-occurrence` | **the `More…` submenu is already there** — an `AXChildren` `AXMenu` with **102 items**, no click needed. Removes the shipped script's try-then-click-then-wait-0.5 s ladder outright | **PORTS, and removes a rung** |
| **P16** | `select (row i of <table>)` then `selected of (row i)` | `axSelectRowScript`, `axSelectHeadingRowScript` (the PROJECT arm) | **the attribute write is refused** — settable reports `true`, the write returns `-25201` (`kAXErrorAttributeUnsupported`), the row does not select (§5.7). `select-row` keeps System Events' `select` ACTION, which UIC4-a certified and which is a different verb | **DOES NOT PORT** (attribute route) |
| **P24** | `delay N` | every in-script settle and poll | `$.NSThread.sleepForTimeInterval` — already shipped as `sleep()` in the JXA prelude | **shipped** |
| **P25** | `current date` deadline loops | every in-script poll | `Date.now()` / `NSDate` | **shipped** |
| **P23** | `set value of <AXDateTimeArea>` | `set-datetime` | already JXA (`axSetDateTimeScript`) | **shipped** |

### 1.3 The four things that are NOT Accessibility, and stay

These are the fence. A port that quietly re-implements one of them has changed a certified behavior, not a transport.

| # | what | why it cannot become a raw AX call |
| --- | --- | --- |
| **P20** | `tell application "Things3" to (name \| id) of selected to dos` — `assert-eligible`, `select-row`, `select-heading-row` | An Apple event to **Things' own scripting dictionary**, not to System Events and not to the AX tree. It is the uuid-precise selection oracle ADR1 (#480) exists for; AX can say a row is selected but not that the selected row is the caller's uuid. **One Apple event per drive, and it stays.** |
| **P21** | `tell application "Things3" to activate` | The preamble's foregrounding. `NSRunningApplication.activateWithOptions` is the in-process equivalent and would save one event — but activation behavior is [oddities §26](../things-app-oddities.md) territory (the detached-editor fork turns on it) and it is not this campaign's to re-time. **Out of scope; one event, and it stays.** |
| **P19** | `name of first application process whose frontmost is true` — the keystroke frontmost law | Already has a prompt-free in-process replacement in `ui-pointer-guard.ts` (`NSWorkspace.frontmostApplication`, measured 0 Apple events), which the pointer class already uses. The KEYSTROKE class still uses the System Events form because its host script is AppleScript. It ports for free with the script. |
| **P26/P27** | `date "<localized title>"` and `weekday of <date>` — the occurrence menu's title parsing (`parsedYMD`, `aqYMD`, `aqRelative`) | **MOVED OUT of this table by measurement.** `NSDateFormatter` with a four-format bank under `en_US_POSIX` agrees with AppleScript's `date` on **all 15 live menu titles** and the synthetic corpus, at 0.36 ms (§5.8) — so P26 PORTS. `NSDataDetector` matches nothing and is out; `NSAppleScript` in-process also agrees and stays the named fallback. |

### 1.4 The hop map, before

Rendered from the recipe itself rather than reconstructed — `makeRepeatingRecipe` compiled for three shapes, its steps printed in order.

**`--frequency weekly --interval 1 --when <date>`, with a seed** (the field's own shape; 14 recipe steps):

`reveal · activate · assert-eligible · press Items ▸ Repeat… · dialog-open · select-popup frequency · probe-dialog-shape · verify-prefill · set-group-number interval · settle-occurrences · set-datetime Next *(legacy only)* · select-next-occurrence Next *(next-popup only)* · audit-dialog · press OK`

**`--frequency monthly --interval 1 --after-completion`** (the shape RDLAT2 measured end to end; 10 recipe steps):

`reveal · activate · assert-eligible · press Items ▸ Repeat… · dialog-open · select-popup frequency · select-popup ac-unit · set-group-number interval · audit-dialog · press OK`

Not every step is a HOP, and the difference is where the campaign's arithmetic lives:

| step | dispatches an `osascript`? |
| --- | --- |
| `reveal` | **no** — `open` a `things:///` URL, LaunchServices, no Apple event at all |
| `set-datetime Next` on 3.23 | **no** — `onlyShape: "legacy"`, and the shape probe says `next-popup` |
| `settle-occurrences` with a sidecar | **no** — node awaits the ledger and dispatches nothing (`SETTLE_OCCURRENCE_RECOMPUTE`) |
| `press OK` after an audit | **no** — the audit COMMITS in its own script (RDLAT2 §4d) |
| a setter the verify hop confirmed | **no** — skipped, and still audited |
| everything else | yes |

And the drive adds hops the recipe does not name: the pipeline's pre-drive **census**, the **session-lock** probe (LOCKSCR1, JXA — already raw, 0 Apple events), the **session-reachability** probe, the drive's own open-dialog **census**, the **observer spawn**, and the **canary**. Every one is a separate concern with its own refusal, and every one is its own process.

**So the after-completion shape RDLAT2 measured at 13 hops / 88 events is 15 hops today** — LOCKSCR1's lock probe and VOPAT2's observer spawn both landed after that table was written. The spawn term has grown since the campaign that fitted it, which sharpens §3.2's question rather than softening it.

---

## 2. The probe — what each cell decides

Every cell runs BOTH forms against the SAME live control in the SAME dialog state. The rig is the ObjC bridge for the raw arm and JXA's own `Application('System Events')` for the comparison arm, so one process makes both and no spawn difference contaminates the comparison.

### 2.1 `shape` — the shape trace the scrutiny law requires

[harness.md §AX-drive scrutiny](harness.md): *re-audit the FULL dialog shape after EVERY input step*. The cell dumps role, subrole, title, description, value, `AXIdentifier`, **`AXActions`** and frame for the shell's direct children and for every child of the cadence group, after each of: the dialog opening, the frequency selection, the `Add deadlines` tick, and the `Ends: after` selection — for all five frequencies including after-completion. It prints a per-state diff so a minted or moved control is a line in the report rather than something to notice later.

`AXActions` is new information this project has never dumped, and the port needs it: it is the list of things `AXUIElementPerformAction` may be handed for each control, and it is how `AXPress`-vs-`AXShowMenu`-vs-`AXConfirm` stops being a guess.

### 2.2 `prims` — the equivalence and timing matrix

The §1 table's `#` ids, each measured in three dialog states (after-completion, weekly, monthly), reporting: the raw answer, the System Events answer, **whether they agree**, ms per call for each, and the ratio. Plus:

- **settability** of the four attributes the port might write (`AXValue` and `AXFocused` on the numeric field, `AXValue` on the frequency pop-up and on the deadlines checkbox), read through `AXUIElementIsAttributeSettable` — the API's own statement of what it will accept;
- **the boolean-encoding question** (P7): three spellings of `true` handed to `AXUIElementSetAttributeValue`, reporting the first that returns AXError 0;
- **the raw floor**: ms per attribute read over ≥200 repetitions, the number that stands against RDLAT2's fitted 47 ms.

### 2.3 `menu` — the pop-up

Where the `AXMenu` lands in the raw tree, whether `AXPress` opens it, what actions the pop-up and its items advertise, whether a second `AXPress` closes it without selecting, and — for `select-next-occurrence` — whether the last item's submenu is reachable as an `AXChildren` `AXMenu` **without** being clicked first.

### 2.4 `setvalue` — THE DECISIVE CELL

`AXUIElementSetAttributeValue(interval-field, AXValue, "3")`, then **commit**, then read the landed rule out of the guest's SQLite through `rsum.py`.

The verdict is the rule blob and nothing else:

| landed | means |
| --- | --- |
| `fa=3` | the write FIRED the binding. The typing loop — focus, prove focus, keystroke, Tab-commit, read back, retry, and the whole BEEP1 ⌘A history — collapses to one call, and the keystroke class disappears from the Repeat drive entirely |
| `fa=1` | the write was a REPAINT, exactly as UIC6 measured for the System Events spelling. Keystrokes stay, and the port keeps the typing loop with `CGEvent` in place of `keystroke` |

A read-back cannot answer this: the field SHOWS the new number either way. That is the whole reason the cell commits.

### 2.5 `dates` — the localized title parser

`NSDataDetector` against AppleScript's `date "<s>"`, over the live occurrence menu's own titles plus a synthetic corpus (`Today`, `Tomorrow`, a weekday-prefixed date, a bare date, a bare weekday). **One disagreement disqualifies the replacement**; the fallback is to keep the occurrence-menu parsing in AppleScript, which costs the drive one hop it would otherwise have merged.

### 2.6 `menubar` — enablement with the menu closed

`AXEnabled` of `Items ▸ Repeat…` read cold, read while the menu is open, and read cold again — beside the System Events answer taken at the same moment. If the raw read is only correct once System Events has provoked an AppKit menu update, the eligibility assert keeps its Apple event and says so.

### 2.7 `rowselect` — the PROJECT arm's selection

`AXSelected` on a content-table row (settable? does the write land? does Things' own `selected to dos` agree?) against UIC5's finding that the System Events attribute write is a silent no-op.

### 2.8 `cost` — the whole dialog entry, raw only

Open, census the shell, select a frequency, settle on the group's own shape, read everything the pre-commit audit reads, cancel. Reports the AX call count, the batched-node count and a per-stage timeline. This is the number §4's cost table is built on.

---

## 3. The design memo — what moves where

### 3.1 The shape of the port

Three new modules, so `ui.ts` (5,563 lines, and the merge surface of three concurrent branches) is edited as little as possible.

**`src/write/vectors/ui-rawax.ts` — the primitive layer.** The JXA ObjC-bridge prelude, factored the way `ui-pointer-guard.ts` already factors `POINTER_GUARD_AX_HELPERS`: attribute reads, the batched multi-attribute node read, children/role filters, `AXPress`, attribute writes, the shell locator, the menu walker, the `AXN`/`AXR` counters and the `#AXELEMS` log line. It **reuses** the existing helpers rather than re-declaring them — `POINTER_GUARD_AX_HELPERS` and `POINTER_GUARD_JXA` are imported verbatim, because two copies of a frame reader is how two copies drift.

**`src/write/vectors/ui-rawax-ops.ts` — the transport-agnostic op list.** This is the part the maintainer asked to keep a door open on, and it is the reason the port is not simply "rewrite each script in JXA".

A recipe step compiles to an ordered list of **AX operations**, each a plain JSON value:

```
{ op: "read",        target: <ElementRef>, attrs: [...],      as: "<binding>" }
{ op: "press",       target: <ElementRef>, action: "AXPress" }
{ op: "setAttr",     target: <ElementRef>, attr: "AXFocused", value: true }
{ op: "selectMenu",  target: <ElementRef>, titles: [...],     settle: <SettleSpec> }
{ op: "awaitShape",  target: <ElementRef>, expect: <CadenceExpectation>, budgetMs: n }
{ op: "assert",      subject: "<binding>", equals: [...],     refusal: "<sentence>" }
{ op: "keystroke",   text: "3", guard: "frontmost" }
```

and an `ElementRef` is a STRUCTURED address rather than an AppleScript path string:

```
{ from: "shell",  pick: { role: "AXPopUpButton", ordinal: 1 } }
{ from: "shell",  pick: { role: "AXCheckBox",    title: "Add deadlines" } }
{ from: "group",  pick: { role: "AXTextField",   labelRow: "Every", tolerance: 8 } }
{ from: "menuBar", path: ["Items", "Repeat…"] }
```

Two properties follow, and both are the point:

1. **The executor is data-driven.** `renderRawAxScript(ops)` emits ONE JXA script: the prelude, the op list as a JSON literal, and a small interpreter. A future **deputy-side executor** — Swift, in-process, no `osascript` at all — interprets the identical list, because the list carries no AppleScript and no JavaScript. That is the door the maintainer wants left open, and it is left open by construction rather than by intention.
2. **Every discrimination law is preserved as DATA.** `labelRow: "Every"` is the CGRD1 §A law, `tolerance: 8` is `ROW_TOLERANCE`, and the interpreter fails closed on anything but exactly one match, reporting the whole numeric-field inventory in the same words. The positional fence moves with it (§3.5).

**`src/write/vectors/ui-rawax-report.ts` — the structured hop report.** The executor writes one JSON record per op to stdout: label, `durationMs`, `axCalls`, `axElems`, the settle that fired and its latency, and the verdict. Node parses it into the same `trace()` records the per-hop dispatch already emits.

This is what unlocks the hop merge, and it is worth saying why. [RDLAT2 §10](rdlat2-repeat-dialog-latency.md) explicitly declined to fold the frequency / unit / interval hops into one process: *"it costs the per-step trace granularity and the per-step failure attribution that make the field reports readable"*. With a structured per-op report, folding costs neither — node gets a richer record than a hop boundary ever gave it. **The reason not to merge evaporates; the decision becomes purely about which boundaries a DECISION or a SETTLE genuinely needs.**

### 3.2 What keeps its hop, and what could stop having one

> **RULED 2026-09-05: merge, and apply the test to every boundary — a hop boundary survives only where node must DECIDE or SETTLE between operations.** §3.2a below is that test applied to the recipe as it actually stands, which turned out to protect two boundaries this memo had listed as merge candidates. One of them was created by [DEPOBS3](depobs3-skip-poll-and-inprocess.md) (#736) the commit before this campaign started.

### 3.2a The test, applied

| boundary | verdict | why |
| --- | --- | --- |
| census ×2 · session lock · reachability · reveal · activate · canary · assert-eligible | **keep** | separate concerns, each with its own refusal; `assert-eligible` also holds P20, the Things-dictionary oracle |
| → press `Items ▸ Repeat…` | **keep** | SETTLE: `AXSheetCreated` |
| → `dialog-open` | **keep** | DECIDE: the shape-manifest refusal, and it banks `shellIndex` for every later address |
| → `select-popup` frequency | **keep** | DECIDE, from the census just banked |
| **frequency → `probe-dialog-shape`** | **KEEP — and this is the one the memo had wrong** | SETTLE, and a brand-new one: the step carries `crossHopSettle: "cadence-rebuild"`, which on a ROUTED host is node absorbing the group's rebuild over the deputy-hosted ledger so the probe's script can drop its polling rounds (DEPOBS3, #736). **Folding the frequency selection into the probe would put that wait back inside the script**, where a routed host cannot settle on a socket — regressing #736 one commit after it landed. The boundary is load-bearing on exactly the host class the campaign exists for. |
| shape probe → verify-prefill → every setter up to the occurrence settle | **FOLD** | every decision here is made from a read the executor has just taken: the shape verdict picks the shaped addresses, the verify verdict picks which setters run. Node decides nothing it is not told afterwards, and the per-op report tells it more than the hop boundary did. |
| **→ `settle-occurrences`** | **KEEP** | SETTLE, and node-side by construction: with any observer this step dispatches NOTHING — node awaits the ledger — and its two skips (`seen === 0`, and `setterSinceShape`) are facts about the drive that only node holds. |
| the remaining setters → audit → commit | **FOLD** | no decision, no settle; the audit already commits in its own script, and in a raw-AX executor its JXA date-area leg stops being a separate hop because everything is one language |

**What that is worth, measured against the rendered recipes rather than estimated.** The full vocabulary (yearly · weekdays · anchors · deadline · offset · ends-after · reminder · Next) dispatches **16 hops** today between the frequency selection and the commit; merged it dispatches **3**. The field's own weekly-with-seed shape dispatches 5–6 and merges to 3.

| shape | dispatched hops today | merged | spawns saved | M1 at ~124 ms |
| --- | ---: | ---: | ---: | ---: |
| full vocabulary | 16 | **3** | 13 | **≈ 1.6 s** |
| weekly + `--when` + seed (the field's) | 5–6 | **3** | 2–3 | ≈ 0.25–0.37 s |

**So §4's single ~0.75 s figure was too coarse in both directions**, and the honest statement is that the merge is worth little on the narrow shape and a great deal on the wide one. The narrow shape is the one the maintainer runs.

**The hop structure is FIXED across every quadrant, deliberately.** It would be possible to fold the frequency selection in on a host with no observer (its settle is in-script there anyway) and keep the boundary only when routed — and that would make the drive's hop structure a function of its transport, which is precisely the shape the [quadrant law](harness.md) exists to forbid. One structure, certified once per quadrant.

### 3.2b The original boundary list, kept for the record

A hop boundary exists today only where a settle or a decision needed node (the brief's own rule). Sorted:

| boundary | keep? | why |
| --- | --- | --- |
| census (×2), session lock, reachability | **keep** | separate concerns with their own refusals; two are already raw |
| reveal | **keep** | `open`, not `osascript` — no Apple event at all |
| activate | **keep** | P21, one event |
| canary · assert-eligible · dialog-open | **keep** | three DECISION nodes with three distinct refusals, and `assert-eligible` is where the Things-dictionary oracle (P20) lives |
| press `Items ▸ Repeat…` | **keep** | the `AXSheetCreated` settle boundary |
| **frequency → shape probe → verify-prefill → every setter → audit + commit** | **MERGE CANDIDATE** | every decision in this run is made from a read the executor itself just took, and every settle is either a notification the executor can wait on or a shape poll it can run. Folding it is `~6 × 124 ms ≈ 0.7 s` on the M1 |

The merge is a **Phase 1 decision the orchestrator should rule on**, not something to do silently, because it changes the failure-attribution surface even though it does not lose it. Phase 1 will build the executor so that the boundary is a parameter — one op list per step, or one op list for the whole dialog entry — with the same generated interpreter either way, so the ruling can be made against measured numbers rather than in advance.

### 3.3 The settle injector, and the door NOT to open in this campaign

`settleInjectorFor` has three states today: **live sidecar** (in-script socket client), **deputy-hosted** (inert — the in-script client reaches its socket through `do shell script`, which the broker refuses by design, #695/DEPOBS1), and **none** (inert). DEPOBS3 is adding a third injector state for node-side settles.

A JXA executor could speak to the sidecar's unix socket through `NSFileHandle`/BSD sockets with **no shell at all**, which would pass the broker's lint and give a routed host in-script settles for the first time. **This campaign will not build that.** Three reasons, in order:

1. It is DEPOBS3's surface, and two branches editing the injector is how they conflict.
2. It multiplies the certification matrix again — the [quadrant law](harness.md) is on record precisely because #700 shipped in the corner nobody crossed.
3. The port's value does not depend on it. The polling forms stay byte-equivalent in behavior, and the raw-AX polls are ~400× cheaper than the Apple-event polls they replace, so the observer-down quadrant gets FASTER without any new transport.

Recorded here as a follow-up so it is not rediscovered: **a JXA-native socket client would lift the #695 stand-down.** It belongs to whoever owns the observer next.

### 3.4 What does NOT change, and is re-certified rather than re-argued

- **The AX-scrutiny doctrine**: full dialog-shape re-audit after every input step, deterministic fast-fail, over-caution as the fail direction.
- **The CGRD1 pre-commit audit** and its folded commit — every control re-read through its own discriminated address, the OK press inside the same script, `COMMIT_FAILED_TAG` keeping "the audit refused" distinct from "OK would not press".
- **The DEFAULTS2 verify-by-read**: arithmetic nominates, the surface decides, a skipped actuation is never an unaudited one.
- **PTRGD1's pointer guard** on any gesture, unchanged and imported rather than reimplemented.
- **LOCKSCR1's session gate**, and the keystroke frontmost law wherever a keystroke survives §2.4.
- **Every refusal sentence.** The port is a transport change; a caller must not be able to tell from a refusal which transport produced it. Phase 2 asserts this by diffing the refusal strings across `THINGS_API_REPEAT_RAWAX=0|1`.

### 3.5 The guards that must be extended, not just satisfied

| guard | today | what the port owes it |
| --- | --- | --- |
| `test/unit/positional-addressing.test.ts` | scans `ui-recipes.ts` / `ui.ts` / `ui-drag.ts` for `<class> <N>` AppleScript selectors | the new files, AND a rule for the descriptor form (`{ role, ordinal }`) — otherwise the fence has a hole exactly where the addresses moved |
| `test/unit/ui-script-broker-safety.test.ts` + `helpers/ui-script-catalog.ts` | renders every acting script and asserts no banned phrase | the raw-AX scripts must be in the catalog, in BOTH settle shapes, in both `RAWAX=0|1` — a script only one guard knows about is how #695 shipped |
| `test/unit/ui-script-syntax.test.ts` | `osacompile`s every script | **nothing** — it already branches on `lang` and compiles JXA with `-l JavaScript`. Checked rather than assumed: the port owes it catalog entries and no code |
| `test/unit/pointer-gesture-guard.test.ts` | censuses **every `.ts` in the vector directory** for `kCGHIDEventTap` / `CGEventCreateMouseEvent` / `postHID(`, and refuses any declaration not in its `GUARDED_SITES` allowlist | a `GUARDED_SITES` entry per new posting declaration, with the sentence saying how it satisfies the law. **This bites the keystroke path, and correctly**: if §2.4 says the numeric field needs typing, the port's `CGEventCreateKeyboardEvent` goes out through `CGEventPost($.kCGHIDEventTap, …)`, which the census matches — a key through the HID tap leaks exactly as a click does, and the suite makes that a deliberate act rather than a diff nobody read |
| `test/unit/import-boundary.test.ts` | the consumer air gap | new modules stay library-internal |

### 3.6 The switch

`THINGS_API_REPEAT_RAWAX=0|1`, defaulting ON when Phase 2 is green. `0` regenerates today's AppleScript **byte-identically** — asserted by a unit cell that renders the whole catalog under both and diffs, not by inspection. This is the fourth optional switch on this drive, so per the quadrant law Phase 2 states the crossing explicitly: `{rawax on/off} × {observer up/down} × {prefill on/off}` is eight shapes, and the certification names which were driven and which were argued from the unit matrix.

---

## 4. The cost model, re-derived

RDLAT2's model, with the raw-AX term substituted:

```
wall  =  spawns × S  +  round-trips × C  +  in-script settles  +  the app's own time
```

| term | today | after the port |
| --- | --- | --- |
| `spawns × S` | 15 × 124 ms = **1.86 s** (13 when RDLAT2 fitted it; LOCKSCR1's lock probe and VOPAT2's observer spawn landed since — §1.4) | unchanged, or ~9 × 124 ms = **1.12 s** if the dialog entry merges (§3.2) |
| `round-trips × C` | 88 × 47 ms = **4.14 s** | **measured: 413–419 raw calls** for the whole dialog entry (§5.5) × 0.12 ms ≈ **0.05 s** — five times the calls this memo guessed, and still 1/80th of one Apple event's worth of the old term |
| the app's own time | ≈ 1.79 s (VOPAT1 §8: sheet 438 ms, two menu opens, two group rebuilds at 535 ms, focus 28 ms, type-and-confirm 79 ms, commit ~150 ms) | unchanged — it is the app |
| in-script settles | ~0.5 s unconditional (RDLAT2 §E.5) | **unchanged — §5.4 says the typing loop stays** |

| | predicted M1 | of which is the app |
| --- | ---: | ---: |
| v0.20.8, measured | **6.9 s** | ~1.8 s |
| raw-AX, hop boundaries unchanged | **≈ 3.7 s** | ~1.8 s |
| raw-AX + the dialog entry merged (§3.2) | **≈ 2.9 s** | ~1.8 s |
| VOPAT1 §8's own prediction, for comparison | ≈ 2.2 s | 1.79 s |

**The third row is the honest target, and it is 2.9 s rather than 2.4 s** — because §5.4 measured the raw `AXValue` write to be a repaint, so the typing loop and its ~0.5 s of certified settles stay. The memo's earlier fourth row assumed that write might fire the binding; it does not, and the row is gone rather than hedged.

**VOPAT1's 2.2 s understated the spawn term** — it priced the drive at ~77 raw calls ≈ 9 ms plus 1.79 s of app time and carried no process spawns at all. Put them back at the count the drive actually has (§1.4) and the floor with today's hop boundaries is ~3.7 s.

Three things follow for the ruling §3.2 asks for.

- **Reaching 2.0–2.5 s requires the hop merge and probably more than it.** The merge is worth ~0.75 s; the remaining gap is the app's own 1.8 s plus the certified settles, and neither is a transport problem.
- **After this port the SPAWN term is the drive's largest controllable cost** — 1.86 s of ~3.7 s, against an Apple-event term of ~0.05 s. That inverts the standing order of the two remaining levers: [DEPOBS2](depobs2-deputy-steps.md)'s option (B), in-process execution in the deputy, is worth the whole spawn term and becomes the larger one the moment this lands.
- **And the drive becomes app-bound**, which is where VOPAT1 §8 said the right answer ends up. The `cost` cell measured 622 ms of a 993 ms dialog-entry segment as the cadence group's own rebuild; the lever there is the notification (VOPAT1-12, ~535 ms), not a cheaper read.

---

## 5. Findings

### 5.1 `shape` — the tree the port will address, in all five states

The full inventory, `AXChildren` order, after each input. Only the cadence group is shown (the shell's roles are constant and given below it); `@n` is the control's y.

| state | after the frequency selection |
| --- | --- |
| after completion | `PopUp=week@328 · Static="after previous item is checked off."@331 · Field=1@328` |
| daily | `Static=<preview>@329 · PopUp=never@372 · Static=Ends:@375 · Static=Next:@330 · Static=@314 · PopUp=Today@327 · Static=days@286 · Field=1@283 · Static=Every@286` |
| weekly | … + `Button@284 · PopUp=Sunday@283 · Static=on@286` (and `weeks` for `days`) |
| monthly | … + `Static=on the@286 · PopUp=day@283 · Button@284 · PopUp=5th@283` |
| yearly | … + `Static=on the@286 · PopUp=July@283 · Static=in@286 · PopUp=day@283 · Button@284 · PopUp=5th@283` |

**Every label-row RELATIONSHIP CGRD1 §A measured through System Events reproduces exactly through the raw API** — `Every`@286 against the interval field @283, `Ends:`@375 against the ends count @372, `Next:`@330, the after-completion field @328 — so the HXPC1/CGRD1 label-row discrimination and its 8 pt `ROW_TOLERANCE` port unchanged.

**It is the DELTA that reproduces, not the absolute y, and that distinction is load-bearing.** The shell's start-offset field sits at **y=439 with its `days earlier` / `and start` labels at 443** here, where CGRD1 §B recorded **409 against 413** — the same 4 pt baseline offset, on a sheet the window manager put somewhere else. A port that pinned the absolute positions CGRD1 published would have been wrong on its first run; `cgOnRow`'s `|dy| ≤ tol` is right by construction, and the raw form must keep exactly that shape.

**LAW (RAWAX1-1) — the role-filtered `AXChildren` ordinal IS System Events' `<class> N` index.** Filtering the cadence group's children to `AXPopUpButton` in `AXChildren` order gives, per state (read back out of the run's own JSON, not from the summary line):

| state | pop-ups, in `AXChildren` order | the recipe's index | agrees |
| --- | --- | --- | :---: |
| after completion | `1=week@328` | `DIALOG_AC_UNIT` = 1 | ✓ |
| daily | `1=never@372` · `2=Today@327` | `DIALOG_ENDS` = 1, `DIALOG_NEXT_POPUP` = 2 | ✓ |
| weekly | " · `3=Sunday@283` | `WEEKDAY_BASE["next-popup"]` = 3 | ✓ |
| monthly | " · `3=day@283` · `4=5th@283` | `DIALOG_MONTH_MODE` = 3, `_ORDINAL` = 4 | ✓ |
| yearly | " · `3=July@283` · `4=day@283` · `5=5th@283` | `DIALOG_YEAR_MONTH` = 3, `_MODE` = 4, `_ORDINAL` = 5 | ✓ |

This is the finding the port most needed. **Every measured positional index in `ui-recipes.ts` carries across the transport unchanged**, so the port is not re-deriving a single certified address — it is re-expressing the same ones. (They stay fenced, and they stay `positional-ok:`-justified, by the same census.)

**The ends-after insertion reproduces too**, in all four fixed frequencies: the group's text fields become `1=1@372` (the count) then `2=1@283` (the interval) — HXPC1/#589's law, seen from the raw side.

**The deadlines tick PREPENDS to the shell**, it does not append: `[CheckBox, CheckBox, Group, StaticText, PopUpButton, Button, Button, Image]` becomes `[TextField, StaticText, StaticText, CheckBox, …]`, and the minted field is `AXChildren[0]`. CGRD1 §B recorded the COUNT going 0 → 1; this records the POSITION. It is a fresh argument for the label-row address the campaign already converted to: an appended field would have been index 1 either way, so the old `text field 1` spelling was right for a reason nobody had checked.

Two controls carry values the port must handle deliberately:

- **an empty `AXStaticText` at y=314** — value absent, not "". `cgTexts` maps `missing value` → `""`, and the raw form must do the same or the settle's shape signature is not byte-identical to the one BEEP1 certified.
- **the weekday/anchor row-add `AXButton`'s `AXTitle` is a non-string object** (it stringifies as `[object NSObject]`). `converge-weekdays` already addresses it by smallest-x geometry rather than by title, which is now measured to be the only thing that could have worked.

### 5.2 `prims` — the equivalence matrix

Median of 50 repetitions per row, three dialog states, both arms in one process. **Every read primitive AGREES**, in every state.

| # | what | agree | raw ms | System Events ms | ratio |
| --- | --- | :---: | ---: | ---: | ---: |
| P3 | `value` of the frequency pop-up | **YES** | 0.082–0.106 | 5.44–5.81 | **55–66×** |
| P15 | `enabled` of the frequency pop-up | **YES** | 0.080–0.081 | 5.20–5.60 | **65–69×** |
| P18 | the shell's direct-child role list | **YES** | 0.98–1.12 | 6.17–6.24 | 5.6–6.3× |
| P4 | the cadence group's whole inventory (values + y for statics and fields) | **YES** | 1.42–4.43 | 24.1–24.4 | **5.5–17×** |
| P8 | `focused` of the numeric field | **YES** | 0.083–0.089 | 6.04–6.45 | **68–78×** |
| P6 | position + size | **YES** | 0.217–0.252 | 5.36–6.30 | 21–29× |
| P17 | `AXIdentifier` of the shell | *(both say absent)* | 0.053–0.058 | 5.11–5.25 | 88–99× |
| P5 | count of the group's pop-ups | **YES** | 0.44–1.55 | 9.69–10.32 | 6.7–22× |
| P1 | does the attached-sheet shell exist | **YES** | 3.87–4.01 | 4.67–4.71 | **1.2×** |

**The raw floor is 0.083–0.094 ms per attribute read** on the clone, against 5.1–6.4 ms for the same addressed read through System Events on the same clone in the same process. RDLAT2 fitted the FIELD's System Events round-trip at ~47 ms and VOPAT1 measured the field's raw read at 0.12 ms; the clone's ratio (≈60×) and the field's (≈390×) differ because the clone is cheap at the thing the field is expensive at, which is the corollary this lab lives under. **What transfers is that the raw form is the same answer.**

Three rows deserve their own note.

- **P17 is not a disagreement.** The dialog shell carries no `AXIdentifier` at all: the raw read answers `(none)` and the System Events read THROWS (`Can't get object.`). Both say absent; only the shapes of "absent" differ, and the port's reader returns null exactly where the AppleScript form's `try` swallowed. The Move… picker's identity check — the one caller that actually reads an identifier — is on a window that HAS one, and is unaffected.
- **P1 is the one place raw is barely faster (1.2×), and it is the port's own fault, not the API's.** The raw form re-resolves the main window on every call (`AXWindows`, then `AXSubrole` per window) where the System Events form re-resolves it inside one event. **The port must resolve the shell ONCE per hop and bind it**, which is free — and is what every other row already does.
- **P4, the cadence snapshot, is the single most valuable row.** It is `cgSnap` — the input to every label-row discrimination the drive makes, run twice per settle and again in the audit — at 1.4–4.4 ms against 24 ms, from ONE `AXChildren` plus one batched `AXUIElementCopyMultipleAttributeValues` per child instead of four plural Apple events.

**Settability — the API's own statement of what it will accept:**

| control | attribute | settable | `AXActions` |
| --- | --- | :---: | --- |
| the cadence numeric field | `AXValue` | **true** | `AXShowMenu, AXConfirm` |
| the cadence numeric field | `AXFocused` | **true** | " |
| the frequency pop-up | `AXValue` | **false** | `AXShowMenu, AXPress` |
| `Add deadlines` | `AXValue` | **false** | `AXPress` |

The two `false`s are UIC1's "setting `value` on a Things pop-up is a silent no-op" and the checkbox's equivalent, **stated by the API rather than inferred from a failed drive** — the port may not even try, and the menu-open/`AXPress` route is the only one.

**P7, asking for focus — AND THIS ENTRY WAS WRONG, which is the most useful thing in the campaign.**

Phase 0 tried three encodings, took `AXError 0` from the first (`$.kCFBooleanTrue`) as proof it marshalled, and reported the read-back coming back `false` 60 ms later as *"the exact condition FGRD1's closed loop exists for"* — a reading that was tidy, consistent with VOPAT1-13, and false.

**`$.kCFBooleanTrue` is exposed by the JXA bridge as a FUNCTION, not a value** (`typeof` is `'function'`; `String()` gives `[object Ref]`). Passing it to `AXUIElementSetAttributeValue` marshals a function object, the call returns **`AXError 0`**, and the app does nothing. So the write never happened, the flag was never going to read back true, and the retry loop could never succeed — every raw drive refused with FGRD1's sentence, on every dialog state, which is precisely what phase 2's first routed run found (§5c).

`$(true)` and `NSNumber.numberWithBool(true)` both produce a real `__NSCFBoolean`, which is what a `CFBooleanRef` attribute wants.

**LAW (RAWAX1-5). On this bridge, a zero return code proves the CALL was made and never that the VALUE arrived.** An attribute write is believed only once something reads it back — and where the element's own flag is not how the app reports the state, the read-back has to ask the app instead (§5c: focus is proven through `kAXFocusedUIElement` as well as `AXFocused`).

The read-back was saying all of this in phase 0. What went wrong was not the measurement but the interpretation: a result that contradicted the success code was explained away instead of being treated as the finding. **A probe that reports both an error code and a read-back has already told you which one to believe.**

### 5.3 `menu` — the pop-up

| question | answer |
| --- | --- |
| does `AXPress` open the menu? | **yes**, `AXError 0`, menu present in **12.4 ms** |
| where does the `AXMenu` live? | as a CHILD of the `AXPopUpButton` — which has **no children at all** while closed, so "is the menu open" is one `AXChildren` read and needs no title match |
| the pop-up's actions | `AXShowMenu, AXPress` |
| a menu item's actions | `AXCancel, AXPress, AXPick` |
| does a second `AXPress` close it? | **yes**, without selecting |
| item titles (frequency menu) | `after completion`, `` (a separator), `daily`, `weekly`, `monthly`, `yearly` |

`AXPick` is the canonical selection action and `AXPress` is what System Events' `click` sends; **the port uses `AXPress`, because equivalence with the certified drive is worth more than canonicality**. The empty-titled separator is why a title match must be exact and must not treat `""` as a wildcard.

### 5.4 `setvalue` — THE DECISIVE CELL, and the answer is no

`AXUIElementSetAttributeValue(interval-field, AXValue, "3")` on a weekly rule at interval 1:

| | |
| --- | --- |
| `AXUIElementIsAttributeSettable` | **true** |
| the write | `AXError 0` |
| the field afterwards | shows **`3`** |
| the occurrence preview afterwards | `7/12/26, 7/19/26, 7/26/26, 8/2/26, …` — **still weekly at interval 1** |
| the COMMITTED rule (guest SQLite, `rsum.py`) | `fa=1 fu=256 of=[{wd=0}]` — **interval 1** |

**LAW (RAWAX1-2). The raw AX write to a Repeat-dialog numeric field is a REPAINT, not an edit.** The API reports the attribute settable and the write successful, the control displays the new number, and the app's binding never fires — so the rule that lands is the one the field held before. That is UIC6's finding for System Events' `set value`, confirmed to be a property of the AX write itself rather than of System Events' spelling of it, and confirmed against the only oracle that can tell them apart: the committed rule.

**The typing loop therefore survives the port, entire** — focus, prove focus, keystroke, Tab-commit, read back, retry, and BEEP1's reason for sending no ⌘A. What changes is the transport of the reads around it and nothing else. It also means `P9` keeps a `CGEvent` keystroke under the frontmost law, which is what makes §3.5's `GUARDED_SITES` entry a Phase 1 obligation rather than a hypothetical.

**And the in-dialog tell agreed with the database**, which is worth keeping: the occurrence preview is recomputed on a real edit and was not recomputed here, so a future cell can read the verdict without committing. It is corroboration, not the oracle — §2.4's rule stands.

### 5.5 `cost` — the whole dialog entry, in raw calls

Open → shell census → select a frequency → settle the rebuilt group → read every control the pre-commit audit reads → cancel. Nothing committed, **0 alert beeps**, both frequencies.

| stage | weekly | monthly |
| --- | ---: | ---: |
| shell resolved | 34 calls · 15.2 ms | 34 · 14.9 ms |
| + shell census (the `dialog-open` assertion) | 43 · 16.6 ms | 43 · 16.1 ms |
| + menu opened | 56 · 25.9 ms | 56 · 25.8 ms |
| + item pressed | 62 · 26.8 ms | 63 · 27.0 ms |
| + **the group's rebuild settled** (8 polling rounds) | 262 · **622.4 ms** | 267 · **631.3 ms** |
| + the audit's whole read, every control | 293 · 646.6 ms | 299 · 648.1 ms |
| + cancelled | **413 · 993.0 ms** | **419 · 997.8 ms** |

Three things fall out of that table.

1. **The AX work has become invisible.** The shell census is **9 calls / 1.4 ms**. The pre-commit audit's ENTIRE read — every control in the group and every control on the shell, values, titles and positions — is **31 calls / ~24 ms**, against the shipped audit hop's 15 Apple events (≈ 705 ms on the M1 at RDLAT2's fitted rate).
2. **The drive becomes app-bound, exactly where VOPAT1 §8 said it should.** 622 ms of a 993 ms segment is the cadence group's rebuild — the app's own time, unchanged by any transport — and the campaign's remaining lever there is not fewer reads but the notification VOPAT1-12 measured (`AXValueChanged` on the pop-up + the destroy burst, ~535 ms), which the observer already knows how to wait for.
3. **The settle polled 8 rounds at 50 ms.** With cheap reads a poll is no longer expensive, but it is still a poll: this is the same "the gate was sized by the driver's own read cost" hazard RDLAT2 §7c names, arriving pre-emptively. The port's settle must stay a POSITIVE shape wait (the labels appearing), never an interval.

The audit inventory the cell read back is the recipe's own control set, in full:

```
weekly:  preview@329 · never(Ends)@372 · "Ends:"@375 · "Next:"@330 · ""@314 · Today(Next)@327
         · Button@284 · Sunday@283 · "weeks"@286 · Field=1@283 · "Every"@286 · "on"@286
         · ☐"Add reminders"=0 · ☐"Add deadlines"=0 · "Repeat" · weekly · OK · Cancel · Image
```

### 5.6 `menubar` — the raw tree answers with the menu shut

| read | items | `Repeat…` present | `AXEnabled` |
| --- | ---: | :---: | :---: |
| cold (menu never opened) | 20 | yes | **true** |
| while the menu is open | 20 | yes | true |
| cold again | 20 | yes | true |
| System Events, same moment | — | — | `enabled=true` |

**No AppKit menu update needs provoking.** The `Items` menu's items are populated in the raw tree with the menu closed, `AXEnabled` is answered, and it agrees with System Events. So the eligibility assert's MENU half (P15) ports; its SELECTION half does not, because that half is P20 — `id of selected to dos`, an Apple event to Things' own dictionary, which is what makes the check uuid-precise and which stays either way.

### 5.7 `rowselect` — the raw attribute write does NOT select a row

| | |
| --- | --- |
| rows in the content table | 15 |
| the row's `AXActions` | **(empty)** |
| `AXUIElementIsAttributeSettable(row, AXSelected)` | true |
| `AXUIElementIsAttributeSettable(table, AXSelectedRows)` | true |
| the write | **`-25201`** (`kAXErrorAttributeUnsupported`) |
| the row afterwards | not selected; Things' own selection unchanged |

**The API says settable and then refuses the write** — UIC5's "setting the table's `AXSelectedRows` is a silent no-op through System Events" seen from the raw side, and worse, because here it is not even silent. So **P16 does not port on this evidence**: `select-row` / `select-heading-row` keep System Events' `select` action, which is a different verb from an attribute write and is the one UIC4-a certified.

**Stated as the limitation it is:** the cell sampled `AXRows[1]` without first proving that row is a selectable entity row rather than a header or a spacer, and the row it got advertised no actions at all — which is what a non-selectable row looks like. So this rules the ATTRIBUTE write out (a `-25201` is an answer about the attribute, not about the row) and leaves the ACTION route unmeasured. The project arm is not this campaign's target; the follow-up is one cell against a row whose identity is proven first.

### 5.8 `dates` — the format bank agrees with AppleScript on every live title

The `Next:` pop-up's OWN menu, harvested live: **17 items** — `Today`, then fifteen `Sun, Jul 12, 2026`-shaped dates, then `More…`. Each candidate parser against AppleScript's `date` operator as the reference:

| candidate | disagreements over 21 titles (15 of them live) | ms/call |
| --- | ---: | ---: |
| `NSDataDetector`, range from the JS string length | **17** | 0.29 |
| `NSDataDetector`, range from the NSString length | **17** | 0.29 |
| **`NSDateFormatter`, format bank, `en_US_POSIX`** | **0** | **0.36** |
| `NSAppleScript` in-process (the shipped parser itself) | 0 | 0.87 |

**LAW (RAWAX1-4). `NSDataDetector` parses none of this dialog's dates** — not the app's own `Sun, Jul 12, 2026`, not a bare `Jan 1, 2027`, not `7/12/26` — in either spelling, in an airgapped guest. Run 1 called that a rig smell; two independent spellings and 17 live titles make it a finding. It is out.

**The format bank wins outright.** `["EEE, MMM d, yyyy", "MMM d, yyyy", "MMMM d, yyyy", "M/d/yy"]` under `en_US_POSIX` agrees with AppleScript on **every** title the menu actually produced and on the synthetic corpus, including returning nothing for the relative words (`Today`, `Tomorrow`, `Wednesday`, `More…`) that the shipped code resolves separately through `aqRelative`. It is 2.4× faster than `NSAppleScript` — and, more to the point, **it removes the capability question §5.5 raised entirely**: no OSA execution enters a brokered script, so there is nothing for a reviewer to weigh.

The reference column is worth keeping: `NSAppleScript` DOES work in-process and DOES agree, so if a future Things build renders a shape the bank misses, the fallback is the shipped parser itself rather than a guess. The port carries the bank and refuses on a title no format matches — never a best-effort parse, because a first occurrence that parses differently is a series that starts on the wrong day (#625).

**And the `More…` cascade is reachable without a click.** The last item exposes its `AXMenu` as an `AXChildren` child with **102 items** in it, already populated, actions `AXCancel,AXPress,AXPick`. The shipped `axSelectNextOccurrenceScript` has a ladder for this — try `menu 1 of menu item N`, and if that is missing, CLICK the item, wait 0.5 s, and try again — because System Events could not always see it. Raw AX just reads it, which removes a click, a fixed 0.5 s delay and a failure mode from the deepest part of the occurrence walk.

### 5.9 The dialog that would not take Cancel — measured, and it is about the PROBE

Run 1 lost its last four cells to this, and chasing it down changed the conclusion completely. The sequence, all of it measured:

1. The `menu` cell opened the frequency pop-up's menu with `AXPress` and closed it with a second `AXPress`; the pop-up's `AXChildren` reported the `AXMenu` gone.
2. The cell's teardown pressed the dialog's own **Cancel**. `AXError 0`. **The sheet stayed.**
3. Asked again by hand, through **raw AX**: `AXError 0`, sheet stays. Through **System Events** (`click button "Cancel" of sheet 1 …`): the click reports the button it clicked, exit 0, **sheet stays**.
4. The tree at that moment: exactly ONE `AXSheet`, no stacked sheet, no detached editor, no open `AXMenu` anywhere in the app, Things frontmost, and the Cancel button reading `AXEnabled=true` with `AXActions=AXPress`.
5. A **synthesized Escape** (`CGEventCreateKeyboardEvent(53)` → `kCGHIDEventTap`) dismissed it **immediately**.

Meanwhile every AX READ answered instantly, and `tell application "Things3" to activate` — an Apple event to Things' own dictionary — **hung until the sheet went**, then hung again the next time a sheet was open, and eventually returned `AppleEvent timed out (-1712)`.

Two things follow, and they are different in kind.

**(a) The sheet gate is real, and it is a rig law before it is a finding.** Things gates its own AppleScript port on an open Repeat sheet — the behavior the drive's own refusal copy already asserts ("while one is open the app … holds Things Cloud sync") — so **any rig step that sends an Apple event to Things while a dialog may be open hangs forever**, and an `ssh` with no deadline hangs the driver with it. That is what cost run 1 its tail. The rig now clears the dialog before it ever activates, and every guest `osascript` runs under a guest-side timeout (macOS ships no `timeout(1)`; `lab/scripts/research-rawax1.sh` installs one).

**(b) `AXPress` on Cancel was inert, and Escape was not — but ONLY after a menu was closed the way the probe closed it.** The `dismissprobe` cell was built to settle exactly that, because run 1's sequence was not a drive's sequence: it closed the pop-up's menu by pressing the pop-up a SECOND time, where `select-popup` closes it by pressing a menu ITEM. Two variants, three rounds each, **0 alert beeps throughout**:

| how the menu was closed | Cancel | Escape needed |
| --- | :---: | :---: |
| **re-press the pop-up** (run 1's accident) | **refuses 3/3** — `AXError 0`, sheet stands | yes, 3/3 |
| **pick an item** (what every drive does) | **works 3/3** | no |

**LAW (RAWAX1-3). A Repeat-dialog pop-up menu closed by re-pressing its pop-up leaves the sheet unable to take an addressed `Cancel` press; the same menu closed by picking an item does not.** The button reads `AXEnabled=true` with `AXActions=AXPress` in both cases, the press returns `AXError 0` in both cases, and only the sheet's behavior differs. A synthesized Escape clears it either way.

**So the alarming reading is the wrong one, and this is why the cell exists.** Run 1's sighting would have supported a claim that the shipped cleanup ladder's first rung — press the dialog's own Cancel, the ONE rung that works with Things in the background — is useless in practice, because every drive opens a pop-up. It is not: every drive also CLOSES its pop-ups by selection, which is the case where Cancel works. The ladder's Cancel rung is sound for the drives that ship, and its Escape rung earns its place for the state something else can leave behind. **A single sighting could not tell those apart, and stopping to discriminate them turned a false alarm about production into a fact about a probe.**

It is still an app quirk worth recording — an enabled button whose own press is accepted and ignored, in a state reachable through nothing but Accessibility — and it belongs in [oddities](../things-app-oddities.md) with this sequence attached.

**(c) And the sheet gate is what made (b) fatal rather than annoying.** Because `activate` hangs while any sheet is open, a failed dismissal does not merely leave a dialog — it wedges every later cell that touches Things' dictionary, with no error, until the ssh is killed. The rig's timeout and its ladder-with-re-warm are the fix; both are §6.

### 5.10 The candidate that was a rig smell, and then was not

Run 1 asked one date-parsing candidate — `NSDataDetector` — and it matched **nothing**, including a well-formed `Jan 1, 2027`. That is a rig smell, so run 1 concluded nothing from it and the cell was re-armed with four candidates instead of one. Run 2 asked both `NSDataDetector` spellings against 15 of the app's OWN live menu titles and got the same answer: nothing, 17 times. **A second look turned a suspected rig bug into a finding** (§5.8), which is the opposite of what a first look would have been entitled to claim.

The re-arming also settled the capability question run 1's reference column had raised. `NSAppleScript` in-process works and agrees — so it was a real option, and it carries neither of the deputy's banned phrases (the broker's lint is textual: `do shell script`, `do script`, read out of `scriptGuard` in `deputy/src/server.swift`, and it accepts `lang: "javascript"` already). It would have been within the guard's intent rather than around it, and it would still have been a capability worth a reviewer's attention. **The format bank makes the question moot**, agreeing on every live title at 2.4× the speed with no OSA execution anywhere near a brokered script — so the port takes it, and `NSAppleScript` stays a named fallback for a future build whose rendering the bank misses rather than a thing anyone has to approve.

## 5b. Phase 1 — what the port became, and what the merge is worth

**Ruled 2026-09-05: merge, and apply the DECIDE-or-SETTLE test to every boundary.** §3.2a is that test applied; §5b.1 is what it produced.

### 5b.1 The boundary that survives, and why it is conditional

The frequency selection ends its merge group **when, and only when, the recipe arms `crossHopSettle: "cadence-rebuild"`** — which `ui-recipes.ts` does on the SEEDED make/add path alone, because that is the only path where the announcement node waits for is certain to come (DEFAULTS1 §2: a freshly minted seed's dialog opens on `after completion, every 1 week` byte for byte, so any other frequency is necessarily a change and `AXValueChanged` fires; a reschedule opens on an existing rule and proves nothing).

Tracking that exactly is what keeps both directions right:

| | boundary | why |
| --- | --- | --- |
| **with** the marker | **survives** | folding would put node's cross-hop wait back inside a script that cannot settle on a socket — the [#736](https://github.com/mikegreiling/things-api/pull/736) regression, one commit old |
| **without** it | **folds** | `nodeSettled` could never carry the observable, so the probe was always going to poll in-script; folding costs nothing and saves a spawn |

`settle-occurrences` survives unconditionally: with any observer it dispatches nothing at all, and its two skips are facts only node holds.

**What that is worth**, counted off the rendered recipes rather than estimated:

| shape | dispatched hops before | after | saved | M1 at ~124 ms |
| --- | ---: | ---: | ---: | ---: |
| full vocabulary (reschedule, no seed) | 16 | **2** | 14 | **≈ 1.7 s** |
| the field's weekly + `--when` + seed | 5–6 | **3** | 2–3 | ≈ 0.25–0.37 s |

So §4's single ~0.75 s figure was too coarse in both directions: the merge is worth a great deal on the wide shape and little on the narrow one, and **the narrow one is what the maintainer runs**.

### 5b.2 The shape fork moved in-script, and had to

The probe runs INSIDE the merged hop, so at compile time there is no verdict to resolve a shaped address against. Ops and audit CONTROLS therefore both carry every shape's address as data and the interpreter picks with the verdict it produced a few ops earlier. The first cut resolved controls at compile time against a null shape and silently dropped every `onlyShape` one — caught by a unit cell, before the guest ever saw it.

## 5c. Phase 2 — the field-shaped arm, and the three defects it found

Run 1 on a routed golden-v4h guest (helpers 1.4.0, `helpers-enabled true`, the deputy carrying every script) came back **RED: 21 of 25 cells**. Everything upstream of the typing step worked — the merged hop opened the dialog, selected the frequency, probed the shape, ran the verify-by-read, and reported every op into the trail — which is what made the three defects underneath it legible.

**None of the three was visible to any unit suite**, and the reason is the same each time: a unit test renders ONE program and reads its text; a drive runs a SEQUENCE of them against a live app.

| # | defect | what it looked like |
| --- | --- | --- |
| **1** | **focus was never proven, so nothing was ever typed** | every drive: `refused to type "3": the field did not take keyboard focus` |
| **2** | **a hop with no probe never learned the shape** | the committing tail: `the Repeat dialog's shape was never measured … (recipe bug)` |
| **3** | **the weekday titles compiled empty** | `converge-weekdays: the weekday pop-up offers no item "undefined"` |

**(1) is the one worth reading twice.** Writing the ELEMENT's own `AXFocused` returns `AXError 0` and reads back **false** — every attempt, every dialog state. Phase 0 §5.2 had already measured that read-back coming back false and drew the right conclusion from it (keep FGRD1's retry loop); what it could not see is that the loop can never SUCCEED, because that flag is not how this app reports focus. The fix asks the APPLICATION's `kAXFocusedUIElement` — the canonical Accessibility spelling — and proves focus by either answer: the element saying it is focused, or the app naming it as its focused one. The second is the stronger claim, not a weaker one, and nothing is typed without one of them.

**(2)** `RAWAX_SHAPE` is per-SCRIPT. The committing tail holds the occurrence pick and the audit — both shape-forked — and no probe, so it started at null and refused with a sentence that was true about that script and false about the drive: node had measured the shape one hop earlier and passed it in. The program's own field now seeds it.

**(3) exposed something worse than itself.** The compiler read the top-level `value` where the recipe carries the weekday titles in a SHAPE-SELECTED one — but the reason it survived unit testing is that the test called `forShape` before compiling, which copies `shaped[shape].value` onto the step and hands the compiler a value **the driver never gives it**. The harness was kinder than the caller, so it certified a function nobody calls. It now compiles raw recipe steps, and a new cell rejects any op that compiles with nothing in the field it acts on — verified for teeth by reverting the fix and watching it fire.

### 5c.2 A defect in the SHIPPED path, surfaced by the A/B pair

Run 3's `weekly --interval 1 --weekdays monday,thursday` pair **diverged**: the raw arm landed, and the **AppleScript arm refused at its own pre-commit audit** —

```
1 control(s) differ: Next (first occurrence) = 2026-07-09
  (intended "2026-07-09", dialog shows "Mon, Jul 6, 2026" = 2026-07-06)
```

The mechanism is a pre-existing hazard in the certified path, and the port is not part of it.

1. `make-repeating` derives its first occurrence from the seed row's scheduled date — here Thursday **2026-07-09**.
2. The `verify-prefill` hop reads the `Next:` pop-up before any setter, finds it already showing that date, and CONFIRMS the `next` key. DEFAULTS2's tag then skips the `select-next-occurrence` actuation.
3. The **weekday converge runs afterwards** and adds Monday to the set, so the rule's first occurrence moves to **Monday 2026-07-06** — the earliest matching day.
4. The pre-commit audit re-reads the pop-up, finds Jul 6 against an intended Jul 9, and correctly refuses. Nothing is committed.

So the audit does its job and the drive fails closed — but it fails closed on a request that is perfectly satisfiable, because a pre-fill was confirmed and then invalidated by a later step. **A verify-by-read verdict is only valid until something changes the control it read**, and the weekday converge is such a something.

The raw arm passed the same cell, and **run 4's trace says why, which is not what run 3 assumed**. The assumption on record was that the raw arm's verify simply did not confirm the key. It did. What the raw arm does not do is CARRY that confirmation across a hop boundary — §5c.3 — so the occurrence op dispatched in the committing tail, re-read the pop-up for itself, found Jul 6 where Jul 9 was wanted, and re-selected it. It is still not design; but the mechanism is a second defect, in the port, and not luck about the read.

**FIXED HERE.** Run 4 re-opened the question with a whole transcript instead of one cell, and the answer changed the disposition. Three facts moved it:

- the request is not exotic. `things todo make-repeating <uuid> --frequency weekly --weekdays monday,thursday` is ordinary CLI vocabulary, and it refuses on the released build (`base-weekly`, §5c.4);
- the fix is not a reordering. Nothing about the certified drive's step order changes. What changes is a CLAIM: `provenPrefills` no longer nominates `next` when the drive will actuate something that reshapes the rule. The recipe, the audit and every setter are untouched, and the failure direction is the safe one — the occurrence step simply runs, as it did before DEFAULTS2 existed;
- and it is not weekly-only. The same arithmetic produces the same defect for `--on-day 20`, for `--on-weekday tuesday --on-ordinal 2`, and for a `--yearly-month` that is not the seed's: any control that moves the rule's first occurrence invalidates a `Next:` read taken before it. Leaving one shape broken while certifying a transport over it is the trade RDLAT2 §E.4 warned about.

**The law, stated once:** *a verify-by-read verdict is valid only until something changes the control it read.* `Next:` is the one control in this dialog that is not independent — it displays the rule's first occurrence, so the app rewrites it whenever the rule's shape changes. Its key is therefore decided LAST, after every rule-shaping key, and only when each one that applies is itself pre-filled. The cadence interval is deliberately not in that set: run 4's daily cell typed `3` into `Every [n] days` and the pop-up stayed on the anchor.

**Why the release gate never saw it.** `lab/guest/stage5-cells.sh` cell `07b` drives `--frequency weekly --interval 1` — no `--weekdays`, so no converge, so nothing invalidates the read. Every weekly shape the gate has ever certified is the one shape of the family that cannot reproduce this. The gate's cell is now joined by the reshaping shapes (`monthlast`, `monthord`, `monthday`, `yearmonth`), which is the actual repair to the gate: a family is not certified by its degenerate member.

**And it is an argument for the A/B cell's design.** A campaign that had only certified "the raw arm lands a correct rule" would have seen nothing here; running the same request both ways and comparing is what turned a passing cell into a defect report about the path that was not being ported.

### 5c.3 The port defect underneath it: a verdict that dies at the hop boundary

`RAWAX_CONFIRMED` is a per-SCRIPT global, exactly as `RAWAX_SHAPE` was (§5c defect 2) — and the fix that landed for the shape was never applied to the pre-fill verdicts. So on the raw transport:

| | AppleScript | raw-AX, before this fix |
| --- | --- | --- |
| verify confirms `next` in the probe hop | node adds it to `prefilled` | the executor sets it in that script's own `RAWAX_CONFIRMED` |
| the occurrence setter, one hop later | node skips the step | the tail script starts with an EMPTY confirmed set and **dispatches it** |

Measured on run 4's `daily` cell, which is the clean case: the occurrence op ran in the committing tail and reported `skipped — the Next: pop-up already showed 2026-07-09`, its own idempotence guard. Nothing wrong was ever driven, which is why 43 cells could not see it; but **the two transports made different decisions from the same verdict**, and that is precisely what a transport change must not do. The program now carries `confirmed` the way it carries `shape`, and the executor seeds from it.

It was also invisible: the AppleScript arm emits `ui-prefill/verify` with the keys it confirmed, and the merged hop's op records dropped `confirmed` and `missed` on the floor. A drive on the new transport could not be asked which pre-fills it had claimed. Both fields now reach the trace, which is how §5c.4's cells prove a quadrant rather than trusting the switch that was set.

### 5c.4 Asking the RELEASED build, in the same guest

An A/B pair compares two transports inside ONE build, so it cannot say whether a defect is ours. `stage5-rc-run.sh` already ships a second dist for exactly this (`RC_DIST_BASELINE`, `$BASELINE_APP` in the cells), so the question is answered the only way it can be: origin/main's own CLI, driving the same request, over the same fixtures, on the same boot, against the same app.

Three cells, and each one is a different claim:

| cell | request | what a pass means |
| --- | --- | --- |
| `base-gate` | `--frequency weekly --interval 1` | the gate's own shape (stage5 cell `07b`) still lands on the released build — this is the blind spot, not the bug |
| `base-weekly` | `--frequency weekly --interval 1 --weekdays monday,thursday` | the released build REPRODUCES the refusal ⇒ the defect is shipped, not introduced here |
| `base-nopf` | the same, with `THINGS_API_PREFILL=0` | it lands with the pre-fill machinery off ⇒ the mechanism is the confirmed skip, and not the converge, the audit or the shape |

The three together localize the defect without reading a line of the released source.

### 5c.5 One operational rule, paid for

**`npm run check` must not run while a Tart guest is up.** A concurrent run took **3,255 s** and produced five spurious failures — `osacompile` and `osascript` suites timing out at their 5 s budgets under starvation. The same suites take **6.7 s** with the slot empty. A red suite under contention looks exactly like a red suite from a defect, and this campaign spent an hour on the difference.

### 5c.6 What the fold takes away, and where it has to be given back

Run 5's `endson` cell — `--ends-on 2026-09-30`, a shape no earlier cell had driven — refused on the raw arm at `set-datetime ends`:

```
op select-popup   ends = on date                    ok
op set-datetime   ends on = 2026-09-30              refused
   set-datetime ends: this Repeat-dialog state presents 0 date area(s) [(none)]
```

Selecting `Ends: on date` MINTS the picker the next op writes to. On the AppleScript path those two steps are two `osascript` spawns, and ~124 ms of process teardown and startup pays for the app's rebuild by accident. Merged into one hop they are adjacent statements, and the census ran on the tree as it was a millisecond earlier.

**This is the fold's real debt, and it is not the one RDLAT2 §10 named.** §10 worried about failure attribution, which the per-op record answers. The debt that is actually owed is that *every hop boundary was also an implicit settle*, bought with a spawn nobody was buying it for. §3.2a's test — keep a boundary where node must DECIDE or SETTLE — is about the settles NODE performs; it says nothing about the ones the operating system was performing for free.

The repair is in the executor rather than in the hop map, because raw reads are ~0.1 ms: a resolve for a control that a preceding op reveals POLLS for it (2 s ceiling, 50 ms period), so the wait costs one census when the control is already present and the refusal is unchanged when the shape genuinely has none. **The general lesson for any future fold: an op that reveals a control has a settle, and folding it means writing that settle down.**

### 5c.7 The monthly family cannot reach §5c.2's defect, and the yearly one can

The reshaping cells were meant to prove the §5c.2 fix across all three families. The monthly ones instead measured a fence: `--on-day 20`, `--on-day last` and `--on-weekday tuesday --on-ordinal 2` are all REFUSED before anything is driven —

```
a monthly rule cannot start off its anchor: the Repeat dialog snaps the first
occurrence to day 20, so a first occurrence on 2026-07-09 would not hold.
```

— so the `next` claim the fix withdraws was never reachable there. The withdrawal is correct and defensive for that family, and the cells now assert the FENCE (both transports, same sentence) rather than a drive that cannot happen.

**The yearly family has no such fence**, and the same request drove for 20 s before refusing deep in the occurrence menu (`this Repeat dialog offers only the rule's own upcoming occurrences … searched 6 level(s)`). That asymmetry is not this campaign's to settle — the refusal is correct and legible, and the caller's remedy (`--when` on a date the rule produces) is the same either way — but it is a real inconsistency between two families of the same verb, and it belongs on the queue rather than in a footnote.

### 5c.8 The DIRECT arm: the raw client is not in the GUI session, and the tree it gets says so

The direct arm — the same cells on a golden-v4 clone with no helpers, every script run by an `osascript` the CLI spawns under an **ssh** session — came back **RED: 32 of 70**, and the shape of it is a fact rather than an opinion:

```
FAIL [1] daily-raw   — ui drive stopped at "measure the Repeat dialog's shape"
   (its first-occurrence row ("Next:") holds neither an occurrence pop-up nor a
    date field, so the dialog matched neither known shape)
ok   [15] aftercomp  — blobs BYTE-IDENTICAL across transports
```

Every cell that PROBES the dialog shape refused on the raw arm; `aftercomp`, the one recipe whose `needsShape` is false, passed. The AppleScript arm passed all of them, in the same dialog, on the same boot, seconds apart.

**The control experiment settles what that means.** The same 70 cells were run in the same rig against **origin/main's dist**, which has no raw transport at all: **zero** shape-probe refusals, on any cell. So this is not the guest, not the clone, not the clock, and not the dialog — it is the raw client.

**What the raw client does not have is the GUI session.** System Events runs as an agent inside the user's Aqua session, so an Apple event to it is executed there however the caller got in; an `osascript` spawned over ssh is executed in the ssh session. Every read the shipped drive has ever made was made from inside the login session by a process that was already there, and the port moved those reads into a process that is not.

**Two claims are NOT supported by this evidence and are recorded as refuted rather than left hanging.** The first hypothesis was `AXEnhancedUserInterface` — the flag an assistive client sets to ask AppKit for the full tree, which System Events sets on every process it attaches to and which the direct rig's warm-up deliberately pokes to `false`. It is a good story and it is wrong: a build that asked for the flag explicitly, once per hop before anything read, changed the failure count from 32 to 34. A standalone probe then measured the write itself returning **`-25208`** from that process. Recorded here, and the code reverted, because §6.3's discipline cuts both ways: an unverified fix that ships is worse than a defect that is understood.

**What this costs, and who pays it.** The maintainer's own `things` runs in Terminal — inside the Aqua session — and the deputy is a launchd agent in that session too, which is why the routed arm certifies 74 cells and this one does not. What the port takes away is a case that used to work: driving the Repeat dialog from an ssh session, or from anything else outside the login session, where System Events would carry the request in and a raw client cannot follow. `THINGS_API_REPEAT_RAWAX=0` restores it exactly, which is what that switch is for — but **the drive should detect the condition and say so, rather than reporting "a Things update has redesigned it again" about a dialog that is fine.** That is a ruling to take, not one to make here: an automatic fall-back to the certified transport is a different contract from a refusal that names the cause, and the two are worth choosing between deliberately.

**Both remaining unknowns are cheap to close and neither is closed yet**: whether the missing controls are the whole reduced tree or only the sheet's, and whether a GUI-session `osascript` on the same guest (launched through the deputy, or through a `launchctl asuser` shim) sees them. The direct arm keeps its cells so both are one run away.

## 6. Run log

Four runs, all destroyed; **0 alert beeps** in every window run 2 and run 3 measured, no crash, no `.ips`.

| run | cells | outcome |
| --- | --- | --- |
| **1** | `shape` · `prims` · `menu` | complete (§5.1–5.3). `dates` degraded, `menubar`/`rowselect`/`cost`/`setvalue` **not reached** — the driver wedged on the sheet gate. **No beep evidence**: `beep_reset` without a `mark` measures nothing, and every cell printed `ORACLE FAIL`. |
| **2** | `dismissprobe` · `dates` · `menubar` · `rowselect` · `cost` · `setvalue` | complete (§5.4–5.9), on a fresh clone with the rig fixed |
| **3** | `dismissprobe --how=pick` · `dates` | complete — the two follow-ups run 2 earned (§5.8, §5.9) |
| **4** (routed, golden-v4h) | the full Phase 2 cell script, 43 cells | **RED — 2**, and both were findings rather than port failures: `weekly-old` reproduced §5c.2's shipped-path refusal, and `endsafter-old` hit §6.4's promote-composite race. Every A/B blob that landed was byte-identical across transports; all eight quadrants agreed on one blob; both DLSEED1 promote cells passed. Harvested from the live guest before teardown (the driver outlived its author), so the traces §5c.2/§5c.3 are argued from are run 4's own. |

### 6.1 Rig defects found, and why each is worth carrying

Five, four of them general to every driver in `lab/scripts/`.

1. **Never send an Apple event to Things while a dialog may be open.** Things gates its own AppleScript port on an open sheet, so `tell application "Things3" to activate` hangs — indefinitely, then `-1712` — and an `ssh` with no deadline hangs the driver with it. That is what cost run 1 its tail. The rig clears the dialog first, and verifies.
2. **Every guest `osascript` needs a deadline.** macOS ships no `timeout(1)`; the rig installs one. **And the watchdog must detach its own fds**: `ssh host 'cmd'` does not return until every process holding the session's stdout has exited, so the first cut's watchdog `sleep` turned a 150 s ceiling into a 150 s FLOOR on every call — measured, mid-run, and fixed by scp'ing the corrected helper into the live guest rather than restarting.
3. **Tear down through the LADDER, not through Cancel** — Cancel, then Escape, then a verified re-warm, never an unchecked press.
4. **`beep_reset` without a `mark` measures nothing.** Run 1 claims no beep evidence for exactly this reason.
5. **A detached `tart run` is an orphan that holds the VM name.** One survived 50 minutes after its driver was stopped; `tart list` read "stopped" while the name was taken, and the next run's clone never opened sshd and died at the 600 s wait. The pre-clone guard now clears it (scoped to our own VM's argv, so a concurrent campaign is never touched), and the teardown trap is armed BEFORE the SSH wait rather than after — the one failure path that most needs a teardown had none.

### 6.2 One probe defect that is a PORTING requirement

A batched `AXUIElementCopyMultipleAttributeValues` returns an **error placeholder object** in the slot of every attribute the element lacks, and a naive `String()` renders it `[object NSObject]`. Absent must read as `""` — the mapping `cgTexts` makes for AppleScript's `missing value` — or the settle's shape signature is not byte-identical to the one BEEP1 certified. Fixed in the probe; §3.1's primitive layer owes it a test.

### 6.3 What run 1 would have concluded, and did not

Run 1 saw an addressed Cancel press refused and was one sentence away from a claim about production: that the shipped cleanup ladder's background-safe first rung is useless in practice, since every drive opens a pop-up. Run 3 measured the discriminator and the claim was false — the refusal needs a menu closed by re-pressing its pop-up, and every drive closes menus by SELECTING. Two disciplines did that work and both are cheap: **record a single sighting as an observation, never a law**, and **when a probe's own sequence differs from the drive's, the difference is the first hypothesis, not the last**.

The same shape appears twice more in this campaign, which is why it is worth naming. `NSDataDetector` matching nothing looked like a rig bug in run 1 and was a finding in run 2 (two spellings, 17 live titles). The `AXFocused` write returning `AXError 0` looked like a success and reads back `false` — a one-shot `set focused; type` would have shipped, and FGRD1's loop is what catches it. **Neither a pass nor a failure is self-certifying on this surface.**

### 6.4 A second shipped defect the pair found, and did NOT fix

`endsafter-old` refused with `no to-do matching uuid or partial-uuid "E3EX88P3mtXCYUkGWWoKsP"` — a uuid the cell never named. Run 4's trace says the whole story in four `result` records:

```
result todo.add    ok  uuid E3EX88P3mtXCYUkGWWoKsP  vector url-scheme   (+337ms)
result todo.delete ok  uuid LXsGrT2kfVGoVYBdYbQwSV  vector applescript  (+456ms)
result todo.restore ok uuid LXsGrT2kfVGoVYBdYbQwSV  vector applescript  (+9560ms)
result todo.update  ok uuid LXsGrT2kfVGoVYBdYbQwSV  vector url-scheme   (+9715ms)
invocation-end exitCode 2
```

So `make-repeating … --ends-after 4` took the clone-and-replace leg, minted the replacement through the URL scheme, deleted the original — and the promote leg it handed the fresh uuid to could not resolve it. The rollback is exemplary: the original is restored and re-patched, and nothing is left half-done. But the operation refused a request it should have landed, and the refusal names an internal uuid the caller has no use for.

**AND IT IS NOT A TRANSPORT DIFFERENCE AT ALL — the control run says so.** Running the same cells against origin/main's dist, where BOTH arms of every pair are the same AppleScript drive, `endsafter` reported the identical asymmetry: the first promote landed and the second refused. So the discriminator is not which transport drives it. It is that this is the SECOND consecutive `--ends-after` promote, and something the first one leaves behind is what the second one's verify does not survive. Every earlier reading of this — including the one two paragraphs down, and the cell's own name for it — attributed to the transport what belongs to the sequence.

**Runs 5, 6 and 7 reproduced it exactly, and run 7 asked the released build.** `base-endsafter` drives the same shape with origin/main's own CLI, in the same guest, on the same boot: it refuses too, exit 2. So the AppleScript arm's behaviour is the SHIPPED behaviour and the raw arm is the one that departs from it — by landing the rule. Four sightings also retire §6.3's one-sighting caution: this is a report.

The trace pair says where to look. The drive itself SUCCEEDS on both transports — `execute-done, exitCode 0`, the pre-commit audit agreeing the dialog holds what was entered — and the two diverge in the POST-DRIVE verify: `stage todo.make-repeating ok` in 421 ms on the raw arm against `stage verify mismatch attempts=30 recovered=false` on the shipped one. So the dialog held the right rule and the oracle did not find what it asked for; the `not-found` the caller reads is the rollback re-reading the clone that the promote had already replaced.

**Not this campaign's to fix, and genuinely not**: it is in `promote-clone.ts`'s composite, it is transport-independent (the raw arm ran the same shape successfully on the same boot), and the one-sighting discipline of §6.3 applies — a single occurrence is an observation. The cell stays in the set, as `endsafter_pair`, and asserts the KNOWN shape — raw lands, the shipped path refuses — so a change in either direction is a failure rather than a surprise. What the evidence does NOT support is calling it a commit race: the drive completes and the audit passes, so it is the verify's oracle that wants the look, not the resolver.

## 7. Handoff — where the certification stands

**Branch** `mg/rawax1-repeat-drive`, draft PR [#734](https://github.com/mikegreiling/things-api/pull/734). `npm run check` green at every commit; it must not be run while a guest is up (§5c.5).

### 7.1 What is certified

**The ROUTED arm — the release gate's own arm (b) — at 74 cells.** Every A/B pair lands a byte-identical blob on both transports (daily, weekly incl. multi-weekday, monthly, yearly, after-completion, ends-on-date, deadline offset incl. a named zero, reminders, a named `--when`, an off-anchor monthly and yearly). All eight `{rawax} x {observer} x {prefill}` quadrants land one blob and each is PROVEN from its own trace file rather than from the switch the cell set. Both no-commit refusals hold on both transports; all four pre-dispatch fences (three off-anchor monthly shapes and the DEFAULTS1 clamp) refuse with the same sentence on both. Both DLSEED1 promote cells pass. The three `BASELINE_APP` cells run origin/main's own CLI in the same guest and localize §5c.2 to the shipped build.

The one pair that does not agree is `endsafter`, and §6.4 is why: it reproduces with both arms AppleScript on origin/main, so it is a sequencing defect in the promote composite rather than anything this port touches.

### 7.2 What is NOT certified, and the one thing that blocks it

**The DIRECT arm is RED and the reason is understood but not repaired (§5c.8).** The raw transport's reads happen in the process the CLI spawns; over ssh that process is outside the Aqua session, and the Repeat dialog's `Next:` row comes back without the control the shape probe needs. `origin/main` runs the identical cells in the identical rig with zero such refusals, so this is the port and not the rig. The maintainer's Terminal and the deputy are both inside that session, which is why the routed arm is green — but a drive from outside it now refuses where it used to work, and it refuses by blaming the dialog.

**`npm run lab:regress` in both arms has NOT been run**, and running it before §5c.8 has a ruling would only re-measure §5c.8 eight more times.

### 7.3 The ruling §5c.8 wants

Three options, and they are genuinely different contracts:

1. **detect and fall back** — the drive notices the reduced tree and re-runs the step on the certified AppleScript transport, silently. Cheapest for callers, and it makes the raw path's coverage depend on where the process happens to be;
2. **detect and refuse, naming the cause** — "this drive reads the Accessibility tree directly and must run inside the login session; re-run it from the Mac's own terminal, or set `THINGS_API_REPEAT_RAWAX=0`". Honest, and it costs the ssh case a working command;
3. **certify the port as session-bound** and make the direct lab arm route its scripts through the GUI session (a `launchctl asuser` shim), so the arm measures the field shape rather than an ssh shape.

(3) is the one that makes the direct arm meaningful again; (1) or (2) is still needed for the field. They are not exclusive.

### 7.4 The measured cost, so far

From run 7's trace summary across all its drives — the numbers §4's model wanted, though the multiplier to the maintainer's M1 is his own trace and not this one:

| | run 7 (routed, 74 cells) |
| --- | ---: |
| dispatched `osascript` hops, all drives | 481 |
| merged raw-AX hops | 50 |
| ops executed inside them | 173 |
| raw AX calls | 11,259 |
| elements realized | 1,912 |
| ops per merged hop | 3.5 |
| raw calls per merged hop | 225.2 |

Per-op wall times are in each drive's `out/<cell>.trace.jsonl`, kept beside its JSON since run 5. On the routed guest the raw arm is faster than the AppleScript one on every A/B pair but two (`yearly`, where they tie, and the first cell of a run, which pays the warm-up): typically 3.2–4.9 s against 3.2–6.1 s. That is a clone's arithmetic, not the field's.
