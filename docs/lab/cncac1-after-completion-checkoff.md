# CNCAC1 — checking off an AFTER-COMPLETION series, and whether the composite reaches it

**Version stamp:** `things-lab-golden-v4` · Things **3.23** (CFBundleVersion **32300036**, direct-download channel) · macOS **15.7.7 (24G720)** · `Meta.databaseVersion` **27** · airgapped clones, guest clock pinned **2026-07-05 12:00 (a Sunday)** and rolled by the phase-2 cells · AXVM1 accessibility grant baked. Campaign run 2026-08-24, unattended, over **three** clones (see §1.2). Immutable snapshot per the [harness](harness.md) version-stamping policy.

Driver: [`lab/scripts/research-cncac1.sh`](../../lab/scripts/research-cncac1.sh) (cells selected by `CELLS=…`; `REUSE=1` attaches to a live clone). Fixtures fully synthetic (`CNCAC1-*`), each title chosen so no title is a PREFIX of another — the click primitive matches an `AXDescription` by substring. Artifacts: `lab/artifacts/cncac1-lab-pass{1,2,3}/` (gitignored) — `report.txt`, per-gesture full-row snapshots in `snap/`, AX dumps in `ax/`, per-command CLI output in `log/`.

**DB oracle:** every gesture is bracketed by a **full-row snapshot** of every `TMTask` column for the fixture's rows (`rowsnap.py` → `uuid⇥column⇥value`, packed dates decoded, blobs hashed), diffed field by field. "No field changed on any surviving row" means all 41 columns of every row compared.

Predecessors: [cnc1-template-mutations.md](cnc1-template-mutations.md) §5 (CNC on an after-completion template duplicates — [oddities §18](../things-app-oddities.md)), [repx1-instance-semantics.md](repx1-instance-semantics.md) §1.3 (the fixed-rule projection check-off = JIT mint + cursor advance) and §2.5 (an after-completion series anchors on completion), [repx3-chooser-residuals.md](repx3-chooser-residuals.md) §4.1 (⌘Z is a perfect inverse).

**Result: 16 assertions, 0 failures** (5 + 7 + 4 across the three passes).

---

## 0. Headline

1. **The GUI check-off of an after-completion projection is answer (a), both halves: a just-in-time mint, born COMPLETE, dated the projection day and stamped with the gesture wall-clock, AND a re-anchor of the next spawn to completion + interval.** One `INSERTED` row with `status = 3`, `startDate` = the cursor's own day, `creationDate` = `stopDate` = the click instant, `rt1_instanceCreationCount +1`, and `rt1_afterCompletionReferenceDate := the gesture day` with the cursor re-derived from it. Nothing is relocated and no existing row is touched (§3, §10).
2. **`Create Next Copy` + a status write reproduces it, and there is NO §18 twin.** On an after-completion series that HAS a cursor, CNC mints the pending occurrence correctly — one row, on the cursor's day — and the composite's end state is field-for-field the GUI's (§4). The §18 duplicate belongs to the CURSOR-LESS case alone.
3. **The #573 refusal was measuring the wrong thing.** An after-completion series **acquires a real cursor the moment its current occurrence is resolved** — completed, canceled, *or trashed* (§7.3) — which is exactly the state the refusal fired in. Its copy ("no upcoming occurrence to work on until the current one is done") describes a series that still HAS an unfinished occurrence, and in that state the refusal never fires, because the composite resolves the open row directly. The guard was inverted with respect to its own justification (§2).
4. **The precondition is the CURSOR, not the rule kind.** `rt1_nextInstanceStartDate` is what separates "materialize the pending occurrence" from "mint a spurious extra one", on every rule shape (§7, §8).
5. **Cancel behaves exactly as complete, and re-anchors the series too** — `status 0→2` + `stopDate`, and the after-completion anchor is set from the cancel just as from a completion (§5). Cancelling an occurrence of an after-completion series restarts the interval.
6. **⌘Z is a PERFECT inverse of the GUI check-off** — the minted row is hard-deleted, `rt1_instanceCreationCount` rewound, and the net against the pre-gesture state is **zero fields over 82 compared** (§6.1). `things undo` after the composite is RIG-BLOCKED in a clone and its plan is nonetheless correct (§6.2).
7. **A per-occurrence deadline IS expressible on an after-completion rule, and it rides the composite intact** — the Repeat dialog offers `Add deadlines` under `after completion`, the rule lands `ts = -3` + the `4001-01-01` sentinel, the derived cursor becomes *anchor + interval − 3*, and the mint carries the derived deadline (§9). This is the maintainer's own shape.
8. **CNC on a PAUSED series does not duplicate — it quietly defeats the pause** and strands the anchor (§8). New [oddities §19](../things-app-oddities.md).
9. **[Oddities §18](../things-app-oddities.md)'s open question is closed: the spurious copy is dated TODAY**, not the current occurrence (§7.2).
10. **A rig lesson that invalidated an entire first pass, now fixed in the primitive.** A row scrolled out of a list still resolves a perfectly good AX frame, so a `CGEventPost` at that frame lands on the DESKTOP and the cell reports a confident zero delta (§1.2). The click helper now walks up to the row's own `AXScrollArea` and refuses rather than click outside it.

---

## 1. The fixture, and the pass that had to be thrown away

### 1.1 Mike's shape, built and verified

Every after-completion fixture is built the REPX2/REPX3/CNC1 way — `things:///add?title=…&when=2026-07-05`, then `Items ▸ Repeat…` → **after completion** → OK — because the AppleScript write vector is unconditionally gated in a guest ([CNC1 §9.2](cnc1-template-mutations.md)). The dialog's own default cadence is **every 1 week**.

At birth the series is the [CNC1 §5](cnc1-template-mutations.md) shape — `tp=1 fu=256 fa=1 of=[]`, **`next = NULL`**, `icStart = 2026-07-06`, `icCount = 1`, one live instance dated 2026-07-05. The campaign then **completes that seed occurrence** through the shipped URL-vector verb, which is what turns it into the maintainer's shape:

```
CNCAC1-GUI at birth:      next=None       icCount=1  acRef=None
  things todo complete <seed occurrence>
CNCAC1-GUI with history:  next=2026-07-12 icCount=1  acRef=2026-07-05
```

— [REPX1 §2.5](repx1-instance-semantics.md)'s law, reconfirmed on every arm: completion **anchors** the series (`rt1_afterCompletionReferenceDate := the completion day`) and **derives** the cursor from it.

Three assertions lock the fixture as the thing #573 refuses:

| assertion | result |
|---|---|
| the completed history gave the series a real cursor (`next=2026-07-12`) | **PASS** |
| the completion anchored the series (`acRef=2026-07-05`) | **PASS** |
| there is **NO open occurrence** — the #573 refusal's exact trigger | **PASS** (0) |

### 1.2 The false negative, named — because the first pass reported one

Pass 1's cell G clicked the projection's checkbox and produced *"(no field changed on any surviving row)"* — a clean, confident, and completely wrong answer. The Upcoming window was `@[44,25 935x684]` with its scroll area `@[284,63 695x610]` (visible bottom **673**), and the projection row's checkbox resolved at **y = 818**. The AX frame is real whether or not the row is scrolled into view, so the synthesized click went to the **desktop**.

This is the trap [REPX3](repx3-chooser-residuals.md) already warned about ("an off-screen row's AX frame still resolves, so a blind click hits whatever is drawn there"), and it is worth restating because the failure mode is indistinguishable from an app finding: *nothing happened* reads identically to *the app ignored the gesture*.

Two fixes, both now in the driver:

- **`clickrow.jxa` walks `AXParent` up to the row's own `AXScrollArea`** and returns `OFF-SCREEN: …` instead of clicking when the target centre is outside that rect. Nothing is clicked, and the cell fails loudly.
- **`revealclick()` reveals first** — `things:///show?id=<uuid>` both selects the row and scrolls it into view — then re-resolves the frame and clicks.

Pass 2 re-ran every click cell behind a **positive control** (§2), on a second clone; pass 3 ran the two cells added after pass 2's results (§7.4, §10) on a third. Cells whose gesture is a MENU press (C, X, N, E, P, EXC, N2, DL2) were unaffected and stand from pass 1/2 as recorded.

---

## 2. Cell CTRL — the click vector, proven live before anything is believed

A zero delta is worthless without a control ([REPX1 §1.2](repx1-instance-semantics.md) doctrine). `CNCAC1-CONTROL` is a fixed **daily** series (`next = icStart = 2026-07-06`, `icCount = 1`); its projection is revealed and its checkbox clicked with the same primitive every other click cell uses:

```
CLICKED Checkbox of the CNCAC1-CONTROL row at (354,238) [row 6 of 51]
```

| assertion | result |
|---|---|
| the click MINTED an occurrence (`icCount 1 → 2`) | **PASS** |
| the cursor advanced one day (`next=2026-07-07`) | **PASS** |

REPX1 §1.3 reproduced exactly. **The vector actuates a projection checkbox in this clone, in this window** — so from here a zero delta means the app did nothing.

---

## 3. Cell G — what the GUI's checkbox actually does (the load-bearing cell)

`CNCAC1-GUI`, the §1.1 fixture: `next = 2026-07-12`, `acRef = 2026-07-05`, `icCount = 1`, zero open occurrences, one completed occurrence on 07-05.

**Upcoming renders a projection for it**, under the 07-12 day header, with an ordinary checkbox:

```
[20] AXRow  desc=12. Sunday                       <- the day header
[21] AXRow
      [4]  AXUnknown desc=‎CNCAC1-GUI      ACTIONS=AXIncrement,AXDecrement,AXCancel,AXPress
      [7]  AXUnknown desc=Checkbox        ACTIONS=…  @[344,808 20x20]
      [13] AXImage   desc=Task NewForToday Template
      [15] AXImage   desc=Repeating Circle Fill FullColo
      [16] AXImage   desc=Task Repeat Template
```

AppleScript agrees: `to dos of list "Upcoming"` enumerates `CNCAC1-GUI`. **The series the shipped code calls "no upcoming occurrence" is drawn by the app as an upcoming occurrence.**

The click:

```
CLICKED Checkbox of the CNCAC1-GUI row at (354,659) [row 22 of 52]

INSERTED row HzrruYcSADR61o37cSN61G
  status                    = 3                    <- born COMPLETE
  stopDate                  = 1783252983.2404819   <- the click instant
  creationDate              = 1783252983.237459    <- the click instant, NOT occurrence midnight
  userModificationDate      = 1783252983.2405229
  start                     = 2
  startDate                 = 2026-07-12           <- the PROJECTION day
  startBucket               = 0
  todayIndexReferenceDate   = 2026-07-12
  leavesTombstone           = 1
  rt1_repeatingTemplate     = Rz8NFarbpKxoR9x3pNyCRU
  rt1_instanceCreationCount = 0

CHANGED template.rt1_instanceCreationCount : 1 -> 2
CHANGED template.todayIndex                : -1543 -> -2016     (rank recompute)
(nothing else on the template — acRef still 2026-07-05, cursor still 2026-07-12)
```

Durable: zero delta across a +25 s settle **and** a relaunch. App alive, crash reports 0 → 0, no sheet in the AX dump.

### 3.1 The answer, in the maintainer's own terms

> **(a), both halves.** It DOES just-in-time mint a COMPLETED instance stamped with the gesture wall-clock, AND it DOES re-anchor the next spawn to completion + interval. It is emphatically **not (b)** — no existing row is relocated, completed, or touched in any way; the pre-existing completed occurrence is byte-identical afterwards.

The re-anchor is invisible in *this* cell's delta, and the reason is a confound worth stating rather than glossing: the anchor was already `2026-07-05` and the gesture also happened on 2026-07-05, so "re-anchor to the completion day" and "leave the anchor alone" are the same write, and a same-value write does not appear in a diff. **[§10](#10-cell-sh--the-re-anchor-and-the-equivalence-proved-without-a-confound) removes the confound** by rolling the clock to 2026-07-08 before the gesture, and the answer there is unambiguous: `acRef 07-05 → 07-08`, `next 07-12 → 07-15`. Read §3 and §10 together — the anchor moves.

---

## 4. Cell C — the headless equivalent, and the twin check

`CNCAC1-CNC`, an identical fixture (`next=2026-07-12`, `acRef=2026-07-05`, PASS on the fixture-match assertion). The submenu is the ordinary one, and the item is enabled:

```
Items ▸ Repeat = Edit Rule… · (sep) · Show Previous Copy · Create Next Copy · (sep) · Pause · Stop
```

**Gesture 1 — `Create Next Copy`:**

```
INSERTED row Tdk9fhd6UnnHcAw1iuqceW
  status = 0 ; start = 2 ; startDate = 2026-07-12   <- the CURSOR's own day, not today
  todayIndexReferenceDate = 2026-07-12
  creationDate = 1783253037.832292                  <- the gesture
  rt1_repeatingTemplate = GhGihy6N… ; rt1_instanceCreationCount = 0

CHANGED template.rt1_afterCompletionReferenceDate : 2026-07-05 -> None
CHANGED template.rt1_instanceCreationCount        : 1 -> 2
CHANGED template.rt1_nextInstanceStartDate        : 2026-07-12 -> None
CHANGED template.todayIndexReferenceDate          : 2026-07-12 -> None
```

**No duplicate.** The series holds exactly the completed 07-05 occurrence and the new open 07-12 one:

| check | value |
|---|---|
| open occurrences after the mint | **1** (a §18 twin would be 2) |
| rows dated 2026-07-12 | **1** |
| rows dated 2026-07-05 | **1** (the completed seed) |

The template delta is the honest bookkeeping for a rule with no calendar: the pending occurrence now EXISTS, so the series goes back to "waiting for a completion" — cursor and anchor both cleared, `icCount` bumped.

**Gesture 2 — `things todo complete <minted>` (URL vector, tier 0):**

```
CHANGED Tdk9fhd6.status               : 0 -> 3
CHANGED Tdk9fhd6.stopDate             : None -> 1783253049.838488
CHANGED Tdk9fhd6.userModificationDate : None -> 1783253049.83852
CHANGED template.rt1_afterCompletionReferenceDate : None -> 2026-07-05   <- re-anchored to the completion day
CHANGED template.rt1_nextInstanceStartDate        : None -> 2026-07-12
CHANGED template.todayIndexReferenceDate          : None -> 2026-07-12
```

Durable across a relaunch (zero delta, 123 fields).

### 4.1 The equivalence, column by column

| | GUI check-off (§3) | CNC + complete (§4) |
|---|---|---|
| rows inserted | 1 | 1 |
| minted `status` | 3 | 3 |
| minted `startDate` | 2026-07-12 | 2026-07-12 |
| minted `todayIndexReferenceDate` | 2026-07-12 | 2026-07-12 |
| minted `rt1_repeatingTemplate` | the template | the template |
| minted `rt1_instanceCreationCount` | 0 | 0 |
| minted `userModificationDate` | **stamped** | **stamped** |
| template `rt1_instanceCreationCount` | 1 → 2 | 1 → 2 |
| template `rt1_nextInstanceStartDate` (end) | 2026-07-12 | 2026-07-12 |
| template `rt1_afterCompletionReferenceDate` (end) | 2026-07-05 | 2026-07-05 |
| template rule blob | untouched | untouched |
| live twin | **none** | **none** |

> **EQUIVALENT.** The end states match on every column that carries meaning. Two differences remain, both cosmetic: the composite performs two acts, so the mint's `creationDate` and `stopDate` differ by the seconds between the legs (the GUI's are the same instant); and the composite's *intermediate* state briefly has the cursor and anchor cleared, which the GUI never shows. Note that the CNC1 §1.3 `userModificationDate` divergence — the composite's one residual column against the chooser — **does not arise here at all**: the GUI's own check-off stamps `umd` too, so the two paths agree on that column as well.

---

## 5. Cell X — cancel is completion's shape, and it re-anchors too

`CNCAC1-CANX`, same fixture, CNC then `things todo cancel <minted>`:

```
CHANGED 5VvHeWro.status               : 0 -> 2
CHANGED 5VvHeWro.stopDate             : None -> 1783253119.717946
CHANGED 5VvHeWro.userModificationDate : None -> 1783253119.717974
CHANGED template.rt1_afterCompletionReferenceDate : None -> 2026-07-05
CHANGED template.rt1_nextInstanceStartDate        : None -> 2026-07-12
CHANGED template.todayIndexReferenceDate          : None -> 2026-07-12
```

Open occurrences afterwards: **0**. The Logbook holds a completed 07-05 row and a canceled 07-12 row.

> **A cancel counts as a resolution for the after-completion anchor.** This is new: [CNC1 §6](cnc1-template-mutations.md) measured cancel on a FIXED rule, where the template is byte-unchanged and the cadence is unaffected. On an after-completion rule cancel is not inert — it **restarts the interval**, exactly as a completion does. A user who cancels "this week's" occurrence has moved the next one, and the shipped verb must say so.

---

## 6. Cells UZ / UT — the two undos

### 6.1 ⌘Z after the GUI check-off is a PERFECT inverse

`CNCAC1-UNDOZ`, the §1.1 fixture, revealed and checked off (delta identical to §3: mint inserted, `icCount 1 → 2`, `todayIndex` recompute), then ⌘Z:

```
---- after ⌘Z ----
DELETED row Bi5EUnT9JvrQRUYrjPJ28P                    <- the mint, hard-deleted
CHANGED WSbMjCDc.rt1_instanceCreationCount : 2 -> 1
CHANGED WSbMjCDc.todayIndex                : -1711 -> -1555

---- NET of ⌘Z against the PRE-GESTURE state ----
(no field changed on any surviving row)
(rows in both: 2; fields compared: 82)
```

Rule afterwards: `next=2026-07-12 icCount=1 acRef=2026-07-05` — untouched. This is [REPX3 §4.1](repx3-chooser-residuals.md)'s result for the chooser, holding for the after-completion check-off: the app's own undo is complete, down to the rank column.

### 6.2 `things undo` after the composite — RIG-BLOCKED, plan correct

`CNCAC1-UNDOT`, CNC + complete, then `things undo`. The undo selects the only recorded leg (the CNC is a raw menu press no shipped surface performed) and plans the exact inverse:

```
plan: todo.reopen { uuid: MDfxTUnQ… }  kind: invertible  guardFields: [status]
result: blocked:environment — "this operation drives the Things app, and this process does not
        descend from an application bundle …"          EXIT=3
row delta after the undo: (no field changed on any surviving row)
```

`todo.reopen` is an **AppleScript-vector** op, and the Wave A write gate refuses that vector in any guest shell ([CNC1 §9.2](cnc1-template-mutations.md), [up-next](../up-next.md)). So the undo could not execute in-lab: this is a lab-capability limit, **not** an app finding, and it re-confirms the standing write-vector-escape item from a second campaign. The plan itself is evidence that the composite is classed correctly.

What §6.1 does establish is the shape of the remaining exposure: the app can un-mint, and nothing we drive can. The shipped half-reversibility disclosure ([CNC1 §7](cnc1-template-mutations.md)) is unchanged and still required.

---

## 7. The cursor-less family — where oddities §18 actually lives

### 7.1 Cell N — CNC1 §5 reproduced exactly

`CNCAC1-FRESH`, an after-completion series that has NEVER been completed: `next = None`, `icCount = 1`, one live occurrence dated 07-05.

| assertion | result |
|---|---|
| a never-completed after-completion template has **NO cursor** | **PASS** (`next=None`) |

CNC on it:

```
INSERTED row N8KuSWna…  start = 1  startDate = 2026-07-05  status = 0
CHANGED template.rt1_instanceCreationCount : 1 -> 2
(and NOTHING else)

open occurrences after CNC: 2      rows dated 2026-07-05: 2
```

[CNC1 §5](cnc1-template-mutations.md) / [oddities §18](../things-app-oddities.md), reproduced on a fresh clone: one menu press, two live copies.

**Upcoming draws the two states apart.** A cursor-less after-completion series is NOT filed under a day header — it is parked in a trailing **`Repeating To-Dos`** section and labelled **`Waiting`**:

```
[38] AXRow   desc=Repeating To-Dos              <- a section header, not a date
[39] AXRow
       [4]  AXUnknown desc=‎CNCAC1-FRESH
       [7]  AXUnknown desc=Checkbox   @[344,1462 20x20]
       [10] AXUnknown desc=Waiting
```

That is the app's own honest rendering of "this series has no next date", and it matches `rt1_nextInstanceStartDate` exactly. A row under a **day header** is a real projection; a row under **Repeating To-Dos / Waiting** is not.

### 7.2 Cell N2 — the §18 copy is dated TODAY

CNC1 §5 could not separate "dated today" from "dated the current occurrence", because its fixture's live occurrence sat on the pinned today. `CNCAC1-OFFDAY` re-dates the live occurrence to **2026-07-09** first, which splits the hypotheses:

```
series before CNC:  S28j7s5r  status 0  startDate 2026-07-09

INSERTED row 7XCF8ohy…  start = 1  startDate = 2026-07-05     <- TODAY
CHANGED template.rt1_instanceCreationCount : 1 -> 2

rows dated 2026-07-05 (TODAY): 1     rows dated 2026-07-09 (the OCCURRENCE): 1
```

> **Dated TODAY.** The spurious copy is not a duplicate *of* the current occurrence at all — it is a fresh occurrence dated the day of the gesture, sitting alongside an existing one wherever that happens to be. [Oddities §18](../things-app-oddities.md)'s open question is closed, and its wording is corrected by a dated addendum.

### 7.3 Cell E — the state the shipped refusal described is not reachable that way

`CNCAC1-EMPTY`, a never-completed after-completion series whose only occurrence is **trashed** through the GUI (⌘⌫), aiming at "no open occurrence AND no cursor":

```
CHANGED TBwSk1kA.trashed : 0 -> 1
CHANGED template.rt1_afterCompletionReferenceDate : None -> 2026-07-05
CHANGED template.rt1_nextInstanceStartDate        : None -> 2026-07-12
CHANGED template.todayIndexReferenceDate          : None -> 2026-07-12

open occurrences: 0    live rows: 0
```

> **Trashing the occurrence ANCHORS the series exactly as completing it would.** So the attempt to build the empty corner lands back in §1.1's shape — a real cursor, a projection in Upcoming, and no open occurrence. Combined with §7.1 (a never-resolved series always HAS an open occurrence, which the composite resolves directly), there is **no ordinary route to an after-completion series that has neither an occurrence nor a cursor.** The one state the #573 refusal copy describes is, for this rule kind, a fiction. §8 finds the state that is real.

### 7.4 Cell WAIT — the GUI has its own route into §18, and it is worse

§7.1 found that Upcoming still draws a checkbox on the `Waiting` row of a cursor-less series. `CNCAC1-WAITING` is a never-completed after-completion series (`next=None`, one open occurrence dated 07-05); the row is revealed and that checkbox clicked:

```
CLICKED Checkbox of the CNCAC1-WAITING row at (354,659) [row 34 of 53]

INSERTED row VWH8Jq2RL1Q3isDzqwTFJV
  status                  = 3                     <- born COMPLETE
  stopDate                = 1783252903.35485      <- the click
  creationDate            = 1783252903.3517818
  start = 1 ; startDate   = 2026-07-05            <- TODAY, not any projection
  rt1_repeatingTemplate   = UwE3ts89… ; rt1_instanceCreationCount = 0

CHANGED template.rt1_afterCompletionReferenceDate : None -> 2026-07-05
CHANGED template.rt1_instanceCreationCount        : 1 -> 2
CHANGED template.rt1_nextInstanceStartDate        : None -> 2026-07-12
CHANGED template.todayIndexReferenceDate          : None -> 2026-07-12

series afterwards:
  GaB4vWuF  status 0  2026-07-05    the ORIGINAL occurrence — still OPEN, byte-identical
  VWH8Jq2R  status 3  2026-07-05    the click's mint — the SAME DAY
```

> **One click, and the series believes it was completed while the occurrence the user actually has to do is still sitting there open.** The app anchors the series (`acRef := today`) and derives a cursor a week out, so Today now shows an unfinished copy that the rule no longer has any interest in, plus a Logbook entry for work nobody did. It is the same shape as [oddities §18](../things-app-oddities.md) — an extra row dated TODAY, `icCount` bumped — reached without the `Items ▸ Repeat` submenu at all, and it is worse than the CNC version in one respect: CNC's copy is born OPEN and merely duplicates, while this one is born COMPLETE and strands its twin.

Two consequences. For the report: §18 is not a `Create Next Copy` defect, it is a **cursor-less-series** defect with (at least) two sanctioned entrances. For us: it is a second, independent reason the shipped guard must refuse a cursor-less series rather than try to be clever — every app gesture available in that state is broken.

---

## 8. Cell P — the PAUSED corner, and a new oddity

Pause is the route that genuinely reaches "no cursor, no open occurrence": it clears `rt1_nextInstanceStartDate` ([REPX1 §5.3](repx1-instance-semantics.md)). `CNCAC1-PAUSED` is the §1.1 fixture, then `things todo pause-repeat`:

```
CHANGED rt1_instanceCreationPaused : 0 -> 1
CHANGED rt1_nextInstanceStartDate  : 2026-07-12 -> None
CHANGED userModificationDate       : …
```

| assertion | result |
|---|---|
| pausing CLEARS the cursor | **PASS** (`next=None`) |
| and there is no open occurrence | **PASS** (0) |

The submenu carries `Resume` in place of `Pause`, and **`Create Next Copy` is present and enabled**:

```
Items ▸ Repeat = Edit Rule… · (sep) · Show Previous Copy · Create Next Copy · (sep) · Resume · Stop
```

Pressing it:

```
INSERTED row XWFeVH9Q…  status = 0  start = 2  startDate = 2026-07-12   <- the cursor the PAUSE removed
CHANGED template.rt1_afterCompletionReferenceDate : 2026-07-05 -> None
CHANGED template.rt1_instanceCreationCount        : 1 -> 2
(rt1_instanceCreationPaused stays 1)
```

> **It does not duplicate — it defeats the pause.** With no cursor to read, the app re-derives the occurrence from the stale anchor (`acRef 07-05` + 1 week = 07-12), mints it, and **consumes the anchor**, leaving a series that is still flagged paused but now has neither an anchor nor a cursor. A user who paused a series and then pressed one menu item gets an occurrence anyway, and the series' only memory of where it was in its cycle is gone. Filed as [oddities §19](../things-app-oddities.md).
>
> The roll confirms the pause otherwise holds: at 2026-07-12 the paused arm spawns nothing (`icCount` still 2, `paused` still 1) while its watermark drifts to 07-12.

This also closes the standing "CNC on a PAUSED template" cell ([up-next](../up-next.md), CNC template-mutation residue): the item is **present, enabled, and not inert**.

---

## 9. Cells DLC / DL2 — the maintainer's shape, with a per-occurrence deadline

### 9.1 A deadline IS expressible on an after-completion rule

Census of `Items ▸ Repeat…` with the frequency set to **after completion**:

```
checkboxes: Add reminders, Add deadlines || popups: 1 || textfields(sheet): 0 || groups: 1
ticked Add deadlines ; start-days-earlier read back = 3
```

The rule lands the deadline-mode shape — `tp=1 fu=256 fa=1 ts=-3 of=[] tmplDeadline=4001-01-01` — and the seed occurrence is born with `startDate 2026-07-05`, `deadline 2026-07-08` (start + 3).

> Worth flagging against the shipped catalogue: `promote-clone.ts` refuses `--start-days-earlier` with `--after-completion` on the grounds that an after-completion repeat "has no calendar start to count back from", and the DBLSPAWN1 project residual refuses `--deadline` with `--after-completion` because the minted instance was believed to be deadline-free. **The app's own dialog accepts both, and the offset is honored.** That is a validation gap, not a behavior we need — recorded in [up-next](../up-next.md) rather than changed here, since nothing in this campaign exercised the promote path.

### 9.2 The derived cursor is start-shifted, and the mint carries the deadline

`CNCAC1-DEADLINED`, after-completion + `deadline:3`, seed completed:

```
with history: ts=-3 next=2026-07-09 icStart=2026-07-06 acRef=2026-07-05 tmplDeadline=4001-01-01
```

Note the cursor: **anchor + interval − 3** = 07-05 + 7 − 3 = **2026-07-09**. For a deadlined rule the interval lands on the DUE date and the cursor is the START, `ts` days earlier — so a deadlined after-completion series' projection day is not the anniversary of the completion.

CNC:

```
INSERTED row 9wXuJyqb…
  startDate = 2026-07-09          <- the cursor
  deadline  = 2026-07-12          <- DERIVED: start + 3
  status = 0 ; rt1_instanceCreationCount = 0

CHANGED template.rt1_afterCompletionReferenceDate : 2026-07-05 -> None
CHANGED template.rt1_instanceCreationCount        : 1 -> 2
CHANGED template.rt1_nextInstanceStartDate        : 2026-07-09 -> None
```

`things todo complete <minted>` then re-anchors to 07-05 and restores `next=2026-07-09`. **The mint is fully formed** — [CNC1 §3](cnc1-template-mutations.md)'s derived-deadline law holds for after-completion rules too — so the composite handles the maintainer's exact shape end to end.

---

## 10. Cell SH — the re-anchor, and the equivalence proved without a confound

Every fixture up to here was built on the pinned 2026-07-05 and gestured on the same day, so "the check-off re-anchors the series to the completion" and "the check-off leaves the anchor alone" predict **the same numbers** (`acRef = 2026-07-05` either way). That confound is fatal to the equivalence claim: if the GUI does not re-anchor and the composite does, the two agree only on the anchor's own day and diverge on every other one. So: build both arms, **roll to 2026-07-08 first**, then gesture.

The roll itself is inert apart from the dormant watermark drift REPX1 records — `rt1_instanceCreationStartDate` 07-06 → 07-09 on both arms, cursor unmoved at 07-12, no spawn.

**Arm 1 — the GUI check-off, on 07-08:**

```
CLICKED Checkbox of the CNCAC1-SHIFTGUI row at (354,469) [row 11 of 49]

INSERTED row SB9L6tke…  status = 3  start = 2  startDate = 2026-07-12    <- still the PROJECTION day
                        creationDate = 1783512058.963486                 <- 2026-07-08, the click
                        stopDate     = 1783512058.969213

CHANGED template.rt1_afterCompletionReferenceDate : 2026-07-05 -> 2026-07-08   <- RE-ANCHORED
CHANGED template.rt1_instanceCreationCount        : 1 -> 2
CHANGED template.rt1_nextInstanceStartDate        : 2026-07-12 -> 2026-07-15   <- anchor + 1 week
CHANGED template.todayIndexReferenceDate          : 2026-07-12 -> 2026-07-15
```

**Arm 2 — CNC + `todo complete`, in the same roll:** CNC mints `AqhUiXJ7…` dated 2026-07-12 and clears anchor + cursor as always; the completion then writes `acRef := 2026-07-08` and `next := 2026-07-15`.

**The discrimination:**

```
GUI: tp=1 fu=256 fa=1 ts=0 of=[] next=2026-07-15 icStart=2026-07-09 icCount=2 acRef=2026-07-08
CNC: tp=1 fu=256 fa=1 ts=0 of=[] next=2026-07-15 icStart=2026-07-09 icCount=2 acRef=2026-07-08
```

| assertion | GUI | CNC |
|---|---|---|
| re-anchors to the GESTURE day (`acRef=2026-07-08`) | **PASS** | **PASS** |
| derives the cursor from the new anchor (`next=2026-07-15`) | **PASS** | **PASS** |

> **The check-off DOES re-anchor, and the two paths are identical.** §3's "the anchor was left alone" was the confound speaking: on 07-05 the re-anchor was a write of the value already there. Measured on a day that separates them, both the GUI gesture and the composite move the anchor to the day the work was done and re-derive the cursor from it — **byte-identical template state, and minted rows that agree on every column but their two-legged timestamps.** The minted occurrence keeps the *projection's* date (2026-07-12) in both arms, so the row that lands in the Logbook is dated when it was due, while the series counts from when it was actually finished.
>
> This is what makes the shipped disclosure honest: resolving an after-completion series **restarts the interval from today**, and the composite does so in exactly the way the app's own checkbox does.

---

## 11. Cell EXC — the exception arm

The one after-completion refusal constant is shared by `update --exception`, so lifting half a guard would have been arbitrary. `CNCAC1-EXCEPT`, the §1.1 fixture, CNC then `things todo update <minted> --when 2026-07-09`:

```
CHANGED Xiz1HXfb.startDate               : 2026-07-12 -> 2026-07-09
CHANGED Xiz1HXfb.todayIndexReferenceDate : 2026-07-12 -> 2026-07-09
CHANGED Xiz1HXfb.userModificationDate    : None -> 1783253240.0631208
(the template: byte-identical — cursor still None, anchor still None, rule blob unmoved)

open occurrences: 1     rows dated 2026-07-09: 1
```

[REPX1 §3.1](repx1-instance-semantics.md)'s plain-instance-re-date delta exactly, as expected of a row the rule no longer has an opinion about.

> **The live-slot collision check has nothing to check here, by construction.** An after-completion rule has no calendar: the only future date it owns is the cursor this mint just consumed, so there is no second slot for the moved occurrence to land on. The [CNC1 §2](cnc1-template-mutations.md) / [oddities §17](../things-app-oddities.md) hazard cannot form. The roll confirms it — at 07-12 this arm holds **0** rows and spawns nothing, because its cursor is (correctly) NULL while the moved occurrence is unfinished.

---

## 12. Phase 2 — the roll to 2026-07-12

Every arm rolled in one monotonic advance (well inside golden-v4's 2026-07-18 trial wall):

| arm | state before the roll | at 07-12 | reading |
|---|---|---|---|
| **GUI** (checked off) | `next=07-12 acRef=07-05 icCount=2` | +1 spawn; 2 rows dated 07-12, **1 open**; cursor → None | the series continues on schedule |
| **CNC** (composite, pass 1) | `next=07-12 acRef=07-05 icCount=2` | +1 spawn; 2 rows dated 07-12, **1 open**; cursor → None | identical to GUI |
| **CANX** (cancelled, pass 1) | `next=07-12 acRef=07-05 icCount=2` | +1 spawn; **1 open** | cancel does not stop the series |
| **UNDOZ** (⌘Z'd back) | `next=07-12 acRef=07-05 icCount=1` | +1 spawn; 1 row, 1 open | the undone arm behaves like one that never gestured |
| **EXCEPT** | `next=None` (occurrence pending on 07-09) | **0** rows on 07-12, no spawn | correct: an unfinished occurrence blocks the next |
| **OFFDAY / FRESH** | `next=None` | **0** rows, no spawn | ditto |
| **DEADLINED** | `next=None` (occurrence resolved, then CNC'd) | no spawn on 07-12 | its cursor is start-shifted, §9.2 |
| **PAUSED** | `paused=1 next=None` | no spawn, `icCount` unmoved, watermark drifts to 07-12 | the pause holds |
| **CONTROL** (fixed daily) | `next=07-07` | daily catch-up, `icCount` → 7 | the ordinary fixed-rule behavior |

> **Two rows dated 07-12, one of them open, is not the §17 double-book.** The completed occurrence the gesture minted carries that date because that is the day it was *scheduled* for; the fresh spawn is the next cycle, arriving because the user resolved the previous one on 07-05 and the interval is a week. Exactly one occurrence is ever live.

---

## 13. Verdict per cell

| cell | question | verdict |
|---|---|---|
| **CTRL** | does the click vector actuate a projection checkbox in this clone? | **YES** — REPX1 §1.3 reproduced (mint, cursor advance). Without it §3's result would be unreadable |
| **G** | what does the GUI checkbox do on an after-completion projection? | **(a)** — a JIT mint born `status=3`, dated the projection day, `creationDate`=`stopDate`=the click; `icCount +1`; NO existing row touched; anchor/cursor left alone. Durable across settle + relaunch |
| **C** | is CNC + a status write equivalent, and twin-free? | **YES to both** — end state field-for-field the GUI's; 1 open occurrence, no §18 twin |
| **X** | the cancel variant? | **CLEAN, and it re-anchors** — `status 0→2` + `stopDate`, anchor set from the cancel. First measurement on an after-completion rule |
| **UZ** | ⌘Z after the GUI check-off? | **PERFECT INVERSE** — mint hard-deleted, `icCount` rewound, net zero over 82 fields |
| **UT** | `things undo` after the composite? | **RIG-BLOCKED** — the `todo.reopen` inverse is AppleScript-vector and the Wave A gate refuses it in a guest. The plan is correct (`invertible`, `guardFields:[status]`) |
| **N** | CNC on a never-completed after-completion series? | **DUPLICATES** — CNC1 §5 / oddities §18 reproduced (2 live rows). Upcoming files such a series under `Repeating To-Dos` / `Waiting`, not a day |
| **N2** | is that copy dated TODAY or dated the current occurrence? | **TODAY** — closes oddities §18's open question |
| **E** | is "no occurrence AND no cursor" reachable by trashing? | **NO** — trashing ANCHORS the series exactly as completing does; the corner the refusal copy describes is a fiction for this rule kind |
| **P** | CNC on a PAUSED series? | **DEFEATS THE PAUSE** — mints from the stale anchor and consumes it, paused flag intact. New oddities §19; closes the standing paused-CNC cell |
| **EXC** | the `update --exception` arm? | **CLEAN** — a plain instance re-date, template byte-untouched; no slot can collide by construction |
| **DLC/DL2** | is a per-occurrence deadline expressible, and does it ride the composite? | **YES to both** — `Add deadlines` is offered, the cursor is start-shifted by `ts`, and the mint carries the derived deadline |
| **WAIT** | checking off a cursor-less series' "Waiting" row? | **STRANDS THE REAL OCCURRENCE** — mints an extra row dated TODAY born COMPLETE, anchors the series, and leaves the genuine open occurrence untouched. A second, GUI-only entrance to the §18 class |
| **SH** | does the check-off re-anchor when the gesture day ≠ the anchor? | **YES, and both paths agree** — gestured on 07-08, GUI and composite both land `acRef=2026-07-08`, `next=2026-07-15`, `icCount=2`; identical template state, mint still dated the projection day |

---

## 14. What this campaign changes elsewhere

| document | change |
|---|---|
| `src/write/template-mutation.ts` | the after-completion refusal is **replaced by a cursor-based one** — the measured precondition. `complete`/`cancel`/`update --exception` now work on an after-completion series with a pending occurrence, with the re-anchor disclosed |
| [things-app-oddities.md](../things-app-oddities.md) §18 | dated addendum: the duplicate is dated **TODAY** (§7.2), and the defect is **scoped to the cursor-less state** — an after-completion series WITH a cursor mints correctly (§4) |
| [things-app-oddities.md](../things-app-oddities.md) | **new §19** — `Create Next Copy` on a PAUSED series defeats the pause and strands the anchor (§8) |
| [things-app-craft.md](../things-app-craft.md) | Upcoming's `Repeating To-Dos` / `Waiting` section — the app renders "this series has no next date" honestly rather than inventing one (§7.1) |
| [capability-matrix.md](../capability-matrix.md) | the after-completion refusal row is replaced by the measured cursor precondition |
| [reference/README.md](../reference/README.md) | CNCAC1 index entry |
| [up-next.md](../up-next.md) | the paused-CNC cell and the §18 TODAY-vs-occurrence cell are CLOSED; the promote-path after-completion deadline validation gap is opened (§9.1) |
| [harness.md](harness.md) | the off-screen-click false negative and the viewport guard (§1.2) |

## 15. Open cells this campaign did NOT close

1. **`things undo` after the composite, executed** (§6.2) — blocked behind the lab's missing write-vector escape, the same item CNC1 §9.2 opened.
2. **Resume after a paused CNC** (§8). The paused arm ends with `paused=1`, no anchor and no cursor; what `resume-repeat` derives from that state is untested, and it is the state a user reaches by pressing one enabled menu item.
3. **The composite's SYNC behavior on an after-completion series.** All of CNCAC1 is single-device. The after-completion anchor (`rt1_afterCompletionReferenceDate`) is not in the depended-column manifest and its merge behavior is unmeasured.
4. **A guest certification cell driving the SHIPPED verbs** — this campaign measured the app's primitives and the shipped `complete`/`cancel`/`update` on ordinary rows, but never `things todo complete <after-completion series>` end to end, because the fixture's own construction needs the gestures under test. It rides the queued CNC guest-certification cell.
