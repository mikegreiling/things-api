# RAWAX1 — the Repeat drive in raw Accessibility calls

**Status: PHASE 0 (design memo + probe plan). The measured columns below are marked `pending` until the probe runs; nothing in `src/` has changed yet.**

**Probed under:** `things-lab-golden-v4` · Things **3.23** (build 32300036) · macOS **15.7.7** · DB schema **v27** · guest clock pinned **2026-07-05 12:00** (trial wall 2026-07-18, never rolled). ONE disposable clone (`rawax1-lab`) of golden-v4 — the golden is never booted — airgapped, guest muted, beep sentinel on in report-only mode, destroyed at teardown. Fixtures fully synthetic (`RAWAX1-*`). Immutable snapshot per the [harness](harness.md) version-stamping policy.

Driver: [`lab/scripts/research-rawax1.sh`](../../lab/scripts/research-rawax1.sh) — cells `shape` · `prims` · `menu` · `setvalue` · `dates` · `menubar` · `rowselect` · `cost` · `teardown`. Probe rig: [`lab/scripts/rawax1-probe.jxa.js`](../../lab/scripts/rawax1-probe.jxa.js). Artifacts (gitignored): `lab/artifacts/rawax1-lab/`.

Commissioned by the maintainer 2026-09-05 against the open item [RDLAT2](rdlat2-repeat-dialog-latency.md) / [VOPAT1 §8](vopat1-screen-reader-pattern.md) left on the table, and the ruling request in [#687](https://github.com/mikegreiling/things-api/issues/687) / [#695](https://github.com/mikegreiling/things-api/issues/695).

---

## 0. The thesis, in three measured numbers

| | measured | where |
| --- | ---: | --- |
| one Apple event to System Events, maintainer's M1 | **~47 ms** (fitted) | [RDLAT2 §8](rdlat2-repeat-dialog-latency.md) |
| one `osascript` spawn, maintainer's M1 | **~124 ms** (fitted) | RDLAT2 §8 |
| one raw AX attribute read through the JXA ObjC bridge, maintainer's M1 | **0.12 ms** | [VOPAT1 §field law](vopat1-screen-reader-pattern.md) |

The shipped `make-repeating` is **13 hops · 88 Apple events**, so on that machine the transport alone is `13 × 124 + 88 × 47 ≈ 1.6 s + 4.1 s = 5.7 s` of a drive the maintainer clocked at **6.9 s** under v0.20.8. The Accessibility work inside those events is the same work either way — the dialog is 12 controls wide, 22 at its widest, and [RDLAT2 §E.2](rdlat2-repeat-dialog-latency.md) measured content reads on it costing what geometry reads cost, with no realize-and-discard signature. **The drive is not slow because it asks the tree too much. It is slow because of who it asks through.**

Replacing the asker — making the same AX calls in-process from JXA, inside the same `osascript` hops — takes the 4.1 s Apple-event term to `88 × 0.12 ms ≈ 11 ms` and leaves the spawn term and the app's own time. That is the campaign. VOPAT1 §8 predicted **≈ 2.2 s** for this drive on that basis; §4 below re-derives it with the spawn term put back, which VOPAT1's arithmetic understated.

**What a clone can and cannot answer.** A lab clone is ~200× cheaper per realized element than a real display, and its Apple events are ~8 ms rather than ~47 ms ([harness.md §Cost law corollary](harness.md)). So **no wall time in this document transfers to the field**. What transfers is: whether a raw call AGREES with the System Events call it would replace, how many calls each shape costs, and what the app announces. Every cell reports those three; the multiplier is the maintainer's own trace.

---

## 1. The primitive inventory

Every distinct thing the Repeat drive asks of System Events, the generator it lives in, and the raw-AX call that would replace it. `#` is the primitive id used by the probe's equivalence matrix (`prims`, §2). "Verdict" is filled by the probe; `pending` means unmeasured, and an unmeasured primitive is not portable.

### 1.1 Reads

| # | System Events form | where it lives | raw AX equivalent | verdict |
| --- | --- | --- | --- | ---: |
| **P1** | `exists (<path>)` | `axResolveScript`, `axCandidatePrelude`, `axWaitAnyScript`, `axDialogOpenScript`, the canary | resolve the descriptor by walking `AXWindows`/`AXChildren` with role/subrole/title filters; a null resolution is "does not exist" | pending |
| **P3** | `value of <el>` | every read-back, the pre-commit audit, `verify-prefill`, `settle-occurrences` | `AXUIElementCopyAttributeValue(el, kAXValueAttribute)` | pending |
| **P4** | `value of static texts of <g>` + `position of static texts of <g>` + the same for `text fields` (4 plural events) | `AX_CADENCE_HANDLERS` `cgSnap` — the HXPC1/CGRD1 label-row discrimination's whole input | one `AXChildren` on the group, then one `AXUIElementCopyMultipleAttributeValues` per child (role+value+position+size in ONE call) | pending |
| **P5** | `count of <class> of <container>` | `converge-weekdays`, the audit's weekday walk, the old census | `AXChildren` + an in-process role filter — **zero** extra calls once the children are in hand | pending |
| **P6** | `position of` / `size of` | every frame resolution, the label-row discrimination | `AXPosition` / `AXSize`, or folded into the batched node read. Measured FREE on both hosts | pending |
| **P15** | `enabled of <el>` | `assert-eligible` | `AXUIElementCopyAttributeValue(el, kAXEnabledAttribute)` | pending |
| **P17** | `value of attribute "AXIdentifier" of <el>` | the Move… picker's identity check | `AXUIElementCopyAttributeValue(el, "AXIdentifier")` | pending |
| **P18** | `role of UI elements of <shell>` | the `dialog-open` shell census, the window/focus census | `AXChildren` + `AXRole` per child | pending |
| **P8** | `focused of <tf>` | `focusedAssertBlock` | `AXUIElementCopyAttributeValue(el, kAXFocusedAttribute)` | pending |
| **P22** | `first window whose subrole is "AXStandardWindow"` · `sheet 1 of …` · `windows whose subrole is "AXUnknown" and size is not {40, 40}` | every dialog address, `AX_DIALOG_SHELL_SNIPPET` | already ported twice — `findShell()` in `AX_DATE_AREA_PRELUDE` and `mainWindow()` in `ui-drag.ts`'s JXA prelude | **shipped** |

### 1.2 Actuations

| # | System Events form | where it lives | raw AX equivalent | verdict |
| --- | --- | --- | --- | ---: |
| **P2** | `click <el>` on a menu item / button / checkbox / pop-up | `axPressScript`, `select-popup`, `ensure-checkbox`, the audit's folded commit, `axCancelDialogScript` | `AXUIElementPerformAction(el, kAXPressAction)` — which is what System Events' `click` compiles to | pending |
| **P7** | `set focused of <tf> to true` | `typeLoopBlock` | `AXUIElementSetAttributeValue(el, kAXFocusedAttribute, <true>)` — [VOPAT1-13](vopat1-screen-reader-pattern.md) measured AXError 0 and the notification at 27.6 ms. **The open question is the BOOLEAN ENCODING the JXA bridge marshals**, which the probe decides rather than guesses | pending |
| **P9** | `keystroke "<v>"` | `typeLoopBlock`, `axTypeTextScript` | none. AX has no "type into this element" — the candidate is `AXUIElementSetAttributeValue(tf, AXValue, …)`, and UIC6 measured System Events' `set value` as a REPAINT that never fires the app's edit binding. **The `setvalue` cell decides it against the landed rule** (§2.4). If it is a repaint, keystrokes stay: `CGEventCreateKeyboardEvent` + `CGEventPost(kCGHIDEventTap)`, under the existing frontmost law | pending |
| **P10** | `key code 48` (Tab) / `key code 53` (Escape) | the typing loop's commit, `axAbortScript` | `CGEventCreateKeyboardEvent` — already shipped as `postEscape()` in `ui-drag.ts`'s prelude | **shipped** |
| **P11** | `exists menu 1 of <pu>` | the pop-up open poll | `AXChildren` of the pop-up, filtered to `AXMenu`. [VOPAT1-11](vopat1-screen-reader-pattern.md) measured `AXMenuOpened` 5.1 ms after an `AXPress`, so the open itself is known good; the probe establishes WHERE the menu lands in the raw tree | pending |
| **P12** | `exists menu item <name> of menu 1 of <pu>` · `click menu item <name>` | `select-popup`, `converge-weekdays` | `AXChildren` of the `AXMenu`, `AXTitle` match, `AXPress`. [VOPAT1 §4.2 g](vopat1-screen-reader-pattern.md) drove exactly this and measured the group rebuild that followed | pending |
| **P13** | `name of every menu item of <menu>` | `select-next-occurrence`'s cascade walk | `AXChildren` + `AXTitle` per item | pending |
| **P14** | `menu 1 of menu item N of <menu>` (the `More…` cascade) | `select-next-occurrence` | `AXChildren` of the `AXMenuItem` filtered to `AXMenu` — the probe asks whether the submenu materializes WITHOUT a click, which is what the shipped script's `try`-then-click ladder exists to handle | pending |
| **P16** | `select (row i of <table>)` then `selected of (row i)` | `axSelectRowScript`, `axSelectHeadingRowScript` (the PROJECT arm) | `AXUIElementSetAttributeValue(row, kAXSelectedAttribute, true)`, or an `AXPress`/`AXSelect` action if the row advertises one. UIC5 measured the TABLE's `AXSelectedRows` as a silent no-op *through System Events*; the raw API is a different door on the same attribute | pending |
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
| **P26/P27** | `date "<localized title>"` and `weekday of <date>` — the occurrence menu's title parsing (`parsedYMD`, `aqYMD`, `aqRelative`) | AppleScript's `date` operator is the SYSTEM parser and has no JXA operator. The candidate is `NSDataDetector`; the `dates` cell (§2.5) runs both against the live menu's own titles, and **a single disagreement disqualifies the replacement** — a first occurrence that parses differently is a series that starts on the wrong day (#625's error class). |

### 1.4 The hop map, before

`todo make-repeating <uuid> --frequency weekly --interval 1 --when <date>` — the field's own shape, with a seed row so the pre-fill is live and a settle sidecar armed (the direct-execution quadrant).

| # | hop | Apple events (RDLAT2 arithmetic) | why it is its own hop |
| ---: | --- | ---: | --- |
| 1 | census — the pipeline's pre-drive window/focus read | 4 | a separate concern, before the drive |
| 2 | session-lock probe (LOCKSCR1) | 0 (JXA) | already raw |
| 3 | session-reachability probe | 2 | a separate concern |
| 4 | reveal (`things:///show?id=`) | 0 (`open`) | LaunchServices, never an Apple event |
| 5 | activate | 1 | P21 |
| 6 | census — the drive's open-dialog precondition | 4 | a DECISION node (MODALX1 refusal) |
| 7 | observer spawn | 0 | the sidecar's own hop |
| 8 | canary — `Items ▸ Repeat…` resolves | 2 | a DECISION node (preflight refusal) |
| 9 | assert-eligible | 3 | a DECISION node, and P20 lives here |
| 10 | press `Items ▸ Repeat…` | 1 | a SETTLE boundary (`AXSheetCreated`) |
| 11 | dialog-open — wait + shell census | 4 | a DECISION node (shape-manifest refusal; banks `shellIndex`) |
| 12 | select-popup — frequency | 9 | a SETTLE boundary (the cadence-group rebuild) |
| 13 | probe-dialog-shape | 3 | a DECISION node (the `next-popup`/`legacy` fork) |
| 14 | verify-prefill (+ a JXA leg when a reminder is asked for) | 4 | a DECISION node (which setters are skipped) |
| 15 | the setters that survive the pre-fill | 0–39 each | a SETTLE boundary each |
| 16 | audit-dialog + the folded OK press | 15 | the commit |

**Totals for the `--after-completion` shape RDLAT2 measured end to end: 13 hops · 88 events · 3,335 ms on the clone · ≈ 7.6 s predicted / 6.9 s measured on the M1.**

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
| `test/unit/pointer-gesture-guard.test.ts` | requires `PTRGD1_MARKER` in every script that posts a mouse event | unchanged if the guard is imported; broken the moment it is copied |
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
| `spawns × S` | 13 × 124 ms = **1.61 s** | 13 × 124 ms = **1.61 s** (unchanged), or ~7 × 124 ms = **0.87 s** if the dialog entry merges (§3.2) |
| `round-trips × C` | 88 × 47 ms = **4.14 s** | ~90 raw calls × 0.12 ms ≈ **0.01 s** |
| the app's own time | ≈ 1.79 s (VOPAT1 §8: sheet 438 ms, two menu opens, two group rebuilds at 535 ms, focus 28 ms, type-and-confirm 79 ms, commit ~150 ms) | unchanged — it is the app |
| in-script settles | ~0.5 s unconditional (RDLAT2 §E.5) | unchanged unless §2.4 removes the typing loop |

| | predicted M1 |
| --- | ---: |
| v0.20.8, measured | **6.9 s** |
| raw-AX, hop boundaries unchanged | **≈ 3.4 s** |
| raw-AX + the dialog entry merged | **≈ 2.7 s** |
| raw-AX + merged + `setvalue` fires the binding (§2.4) | **≈ 2.4 s** |
| VOPAT1 §8's own prediction, for comparison | ≈ 2.2 s |

**VOPAT1's 2.2 s understated the spawn term** — it priced the drive at ~77 raw calls ≈ 9 ms plus 1.79 s of app time and did not carry 13 process spawns. Put those back and the honest floor with today's hop count is ~3.4 s. **Reaching the brief's 2.0–2.5 s therefore REQUIRES the hop merge**, which is why §3.2 asks for a ruling on it rather than treating it as an optimization to take or leave. The `cost` cell measures the raw arm's call count so this table can be re-derived against a measured number rather than an arithmetic one.

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

**P7, asking for focus: `AXError 0`, on the FIRST encoding tried — `$.kCFBooleanTrue`.** `NSNumber.numberWithBool` and a bare JS boolean were never reached. **But the read-back 60 ms later was `false` in every state.** That is not a contradiction of VOPAT1-13 (which measured the notification, not a read-back) and it is not a reason to distrust the write; it is the exact condition FGRD1's closed loop exists for — *ask for focus, look, and if the field has not taken it, ask again on the next attempt* — and it says plainly that **the port must keep that loop.** A one-shot `set focused; type` would have been wrong here, measurably, in the lab, before it ever reached a real machine.

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

### 5.4 The dialog that would not take Cancel — and the sheet gate behind it

Run 1 lost its last four cells to this, and it is the most operationally important thing the campaign has found so far. The sequence, all of it measured:

1. The `menu` cell opened the frequency pop-up's menu with `AXPress` and closed it with a second `AXPress`; the pop-up's `AXChildren` reported the `AXMenu` gone.
2. The cell's teardown pressed the dialog's own **Cancel**. `AXError 0`. **The sheet stayed.**
3. Asked again by hand, through **raw AX**: `AXError 0`, sheet stays. Through **System Events** (`click button "Cancel" of sheet 1 …`): the click reports the button it clicked, exit 0, **sheet stays**.
4. The tree at that moment: exactly ONE `AXSheet`, no stacked sheet, no detached editor, no open `AXMenu` anywhere in the app, Things frontmost, and the Cancel button reading `AXEnabled=true` with `AXActions=AXPress`.
5. A **synthesized Escape** (`CGEventCreateKeyboardEvent(53)` → `kCGHIDEventTap`) dismissed it **immediately**.

Meanwhile every AX READ answered instantly, and `tell application "Things3" to activate` — an Apple event to Things' own dictionary — **hung until the sheet went**, then hung again the next time a sheet was open, and eventually returned `AppleEvent timed out (-1712)`.

Two things follow, and they are different in kind.

**(a) The sheet gate is real, and it is a rig law before it is a finding.** Things gates its own AppleScript port on an open Repeat sheet — the behavior the drive's own refusal copy already asserts ("while one is open the app … holds Things Cloud sync") — so **any rig step that sends an Apple event to Things while a dialog may be open hangs forever**, and an `ssh` with no deadline hangs the driver with it. That is what cost run 1 its tail. The rig now clears the dialog before it ever activates, and every guest `osascript` runs under a guest-side timeout (macOS ships no `timeout(1)`; `lab/scripts/research-rawax1.sh` installs one).

**(b) `AXPress` on Cancel was inert, and Escape was not.** This is the #629 family — the detached editor that "resisted every dismissal this project has" ([oddities §26](../things-app-oddities.md)) — observed on an **attached sheet**, in a headless clone, after a pop-up menu had been opened and closed. It is direct, independent evidence for the shipped cleanup ladder's ORDER (its own Cancel, then Escape, then close-and-reopen), which until now rested on the field incident alone.

It is recorded as an OBSERVATION and not yet as a law, because run 1 saw it after one particular sequence and a single sighting cannot separate "the sheet refuses Cancel in this state" from "the press was swallowed by a menu-tracking run loop that had not finished unwinding". The `dismissprobe` cell exists to settle that: it opens the dialog, opens and closes a pop-up menu, then tries the rungs in order and reports which one dismissed, three times.

### 5.5 `dates` — INCONCLUSIVE in run 1, and re-armed

Run 1 asked one candidate (`NSDataDetector`) and it matched **nothing** — not `Sun, Jul 12, 2026`, not `Jan 1, 2027`. A detector that cannot parse a well-formed date is a rig smell, not a finding, so nothing is concluded from it. What run 1 *did* establish is the reference column: AppleScript's own `date` operator, reached in-process through `NSAppleScript`, returned `2026-07-12` / `2026-08-03` / `2027-01-01` correctly and `NOPARSE` for the relative words — which is exactly the shipped `parsedYMD` behavior, relative words being resolved separately by `aqRelative`.

That points at the answer the re-armed cell will confirm or refute: **`NSAppleScript` is available in-process to a JXA script, sends no Apple event to System Events, and shells out to nothing.** If it holds, P26/P27 port not by finding a parser that agrees with AppleScript's but by keeping AppleScript's — the strongest equivalence claim available. The cell now runs four candidates (two `NSDataDetector` spellings, an `NSDateFormatter` bank, and `NSAppleScript`) against the live occurrence menu's own titles plus a synthetic corpus, and times each.

**Said plainly, because it should be reviewed rather than slipped past: `$.NSAppleScript` carries neither of the deputy's two banned phrases.** The broker's lint is textual (`do shell script`, `do script` — `scriptGuard`, `deputy/src/server.swift`, verified against the source), and it accepts `lang: "javascript"` already, so a JXA script that calls `NSAppleScript` on a FIXED, generated source string brokers cleanly. That is within the guard's intent, not around it: the guard exists to keep "drive the Things GUI" from becoming "run arbitrary shell under the helper's grants", and a compiled OSA script whose text this repo generates is neither shell nor arbitrary. It is still a capability worth naming in a review, so it is named here; if the orchestrator would rather the port keep the date parsing in an AppleScript hop of its own, that costs one hop and no correctness.

The occurrence menu's `More…` cascade was not reached in run 1 (the cell ran with no dialog open, because the wedge above had already eaten the selection step). The re-armed cell reports it.

## 6. Run log

**Run 1 (2026-09-05, clone `rawax1-lab` on golden-v4).** Cells `shape` · `prims` · `menu` complete and reported in §5.1–5.3; `dates` degraded (no dialog, see §5.5); `menubar` · `rowselect` · `cost` · `setvalue` **not reached** — the driver hung on the sheet gate (§5.4). Clone destroyed. Four rig defects found and fixed before run 2, each of which is worth carrying to the next campaign that drives this dialog:

1. **No Apple event to Things while a dialog may be open.** `tell application "Things3" to activate` hangs indefinitely on the sheet gate. Clear the dialog first, and verify.
2. **Every guest `osascript` needs a deadline.** macOS has no `timeout(1)`; the rig installs one (`~/labh/tmo.sh`) and every `axq`/`probe` call runs under it, so a wedged guest costs one cell rather than the run.
3. **Tear down through the LADDER, not through Cancel.** `probe dismiss` = Cancel, then Escape, then a verified re-warm of the app — never an unchecked press.
4. **`beep_reset` alone measures nothing.** The sentinel needs a `mark` to bound its window; run 1 printed `ORACLE FAIL — no marks recorded` on every cell, so run 1 has **no beep evidence at all** and none is claimed.

And one probe defect: a batched `AXUIElementCopyMultipleAttributeValues` returns an **error placeholder object** in the slot of every attribute the element lacks, which a naive `String()` renders `[object NSObject]`. Absent must read as `""` — the same mapping `cgTexts` makes for AppleScript's `missing value` — or the settle's shape signature is not byte-identical to the one BEEP1 certified. Fixed in the probe; **it is a porting requirement, not just a rig one**, and §3.1's primitive layer owes it a test.
