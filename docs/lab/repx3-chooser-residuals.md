# REPX3 — the exception chooser's residual cells: a NON-DAILY rule, exceptions against rule changes, occupied days, and ⌘Z

**Version stamp:** `things-lab-golden-v4` · Things **3.23** (CFBundleVersion **32300036**, direct-download channel) · macOS **15.7.7 (24G720)** · `Meta.databaseVersion` **27** · one airgapped clone, guest clock pinned **2026-07-05 12:00 (a Sunday)** and advanced by the clock-roll cells · AXVM1 accessibility grant baked. Campaign run 2026-08-23, unattended. Immutable snapshot per the [harness](harness.md) version-stamping policy.

Driver: [`lab/scripts/research-repx3.sh`](../../lab/scripts/research-repx3.sh) (cells selected by `CELLS=…`; `REUSE=1` attaches to a live clone, `FIXTAG=<n>` suffixes the fixture titles so a retry on the same clone cannot collide). Fixtures fully synthetic (`REPX3-*`). Artifacts: `lab/artifacts/repx3-lab/` (gitignored) — `report.txt`, per-gesture full-row snapshots in `snap/`, AX dumps in `ax/`.

**DB oracle:** every gesture is bracketed by a **full-row snapshot** of every `TMTask` column for the fixture's rows (`rowsnap.py` → `uuid⇥column⇥value`, packed dates decoded, blobs hashed), diffed field by field. "No field changed on any surviving row" means all 41 columns of every row compared, not a spot check.

Predecessor: [repx2-exception-chooser.md](repx2-exception-chooser.md), which captured the chooser and drove both branches but used a **daily** series on every arm. This campaign closes four of its [§8](repx2-exception-chooser.md) open cells (2, 3, 5, 6) and adds one lab-discipline finding the hard way (§5).

---

## 0. Headline

1. **On a non-daily rule the exception splits the two cursor columns exactly as the clock spawner does.** A fixed weekly series' `Make Exception` sends the **projection cursor to the next RULE date** and the **scan watermark to the consumed slot + 1** — *not* to the chosen day + 1. The three candidates were separated by construction and only one landed (§1).
2. **`Make Exception` is byte-for-byte the SAME bookkeeping as an ordinary clock spawn.** Measured against a Cancel control rolled to its own slot, the template delta is identical field for field (`icCount +1`, watermark → slot+1, cursor → next rule date, `todayIndexReferenceDate` → cursor, `umd` silent). Only the minted row differs: the exception's `startDate` is the chosen day and its `creationDate` is the gesture wall-clock; the spawn's is the slot day at occurrence midnight (§1.3).
3. **An exception SURVIVES a later rule change, untouched.** `Update Rule` on a series that already holds an exception rewrites the rule blob and re-anchors both cursor columns to the chosen date, leaves `icCount` alone, and the exception instance is byte-identical afterwards — it has become an ordinary dated row that the rule no longer has any opinion about (§2.1).
4. **Exceptions stack.** A second exception on a series holding one is accepted with no prompt and no ceiling: each consumes the slot it was made from, both vacated slots stay silent when the clock reaches them, and the first unconsumed slot spawns normally (§2.2).
5. **An exception onto an occupied day DOUBLE-BOOKS — and the sanctioned chooser path is the route.** Moving the projection onto the rule's own next slot leaves the cursor pointing at the day that now holds the occurrence, and when the clock arrives the spawner mints a **second copy of the same series on that day** (§3.2). Stacking two exceptions on one free day and then letting the spawner arrive at it yields **three** (§3.1). New [oddities §17](../things-app-oddities.md) — a fresh, one-gesture route into the [§13](../things-app-oddities.md) class that qualifies §13's own addendum: the app's reconciliation is **slot-keyed, not date-keyed**.
6. **⌘Z is a PERFECT inverse of BOTH chooser branches, and durably so.** After `Make Exception` the minted row is hard-deleted and cursor, watermark, count and `todayIndexReferenceDate` all rewind — and the slot is genuinely un-consumed: rolling to it spawns normally, **reissuing the very uuid the deleted exception row had** (§4.1). After `Update Rule` the rule blob is restored byte-identically and even `userModificationDate` is rewound to its exact prior value (§4.2). Neither is reproducible by anything we can drive (§4.3).
7. **The lab has a wall nobody had hit before: golden-v4's Things is a 15-day TRIAL build that expires 2026-07-18.** Rolling the guest clock past it puts the app in read-only mode — it stops spawning occurrences and silently drops writes, which reads exactly like an app-behavior finding and is not one — and the state is **sticky**: rolling the clock back does not clear it, so the clone is burned. The driver now refuses the roll (§5).

---

## 1. Cell G1 — the load-bearing cell: an exception on a NON-DAILY rule

### 1.1 Why daily could not answer this

`rt1_nextInstanceStartDate` is the projection cursor and `rt1_instanceCreationStartDate` is a scan watermark; they diverge on every non-daily rule ([REPX1](repx1-instance-semantics.md) §2.3/§2.4 — on a weekly clock spawn the watermark goes to spawned-day **+1** while the cursor goes to the next **rule** date). Every REPX2 arm used a daily series, where the two coincide, so REPX2's "`Make Exception` advances the cursor" said nothing about which column means what.

**Fixture.** `REPX3-G1-WEEKLY` (exception arm) and `REPX3-G1C-WEEKLY` (Cancel control), both built the same way: `things:///add?…&when=2026-07-05` then `Items ▸ Repeat… → weekly → OK`. Both land

```
tp=0 fu=256 fa=1 ts=0 rc=0 of=[{wd=0}]   next = icStart = 2026-07-12   icCount = 1
rows: the materialized instance dated 2026-07-05 (start=1) + the template
```

so the two columns still coincide **at birth** — they part on the first advance, which is exactly the event under test.

**The target is chosen to separate the candidates.** The projection sits on **07-12**; it is moved to **2026-07-15 (Wed)**, three days past the slot. That makes the three hypotheses land on three different days:

| candidate | date |
|---|---|
| consumed slot + 1 | **2026-07-13** |
| chosen day + 1 | 2026-07-16 |
| next RULE date | **2026-07-19** |

### 1.2 The measurement

`Items ▸ When…` on the uuid-verified projection, `July 15, 2026` typed and read back as a resolved row, Return → the **same three-button sheet** REPX2 §1.2 captured (`Repeating To-Do`, "…make a one-time exception, or update the repeating rule?", `Make Exception`/`Update Rule`/`Cancel` on `action-button-1/2/3`). `Make Exception`:

```
INSERTED row MxzSpjFBoEKnXw5nV2DBVM
  status                   = 0                          <- born OPEN
  start                    = 2
  startDate                = 2026-07-15                 <- the CHOSEN day
  todayIndexReferenceDate  = 2026-07-15
  creationDate             = 1783252927.106121          <- 2026-07-05 12:02:07, the GESTURE
  rt1_repeatingTemplate    = 6tn5aXLZfFnRUgRGoEUfx7
  rt1_instanceCreationCount= 0

CHANGED template.rt1_instanceCreationCount     : 1 -> 2
CHANGED template.rt1_instanceCreationStartDate : 2026-07-12 -> 2026-07-13   <- WATERMARK: consumed slot + 1
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-12 -> 2026-07-19   <- CURSOR: the next RULE date
CHANGED template.todayIndexReferenceDate       : 2026-07-12 -> 2026-07-19
```

> **The answer, stated flatly.** `rt1_nextInstanceStartDate` advances to the **next rule date** (07-19); `rt1_instanceCreationStartDate` advances to **the consumed slot + 1** (07-13). Neither column knows or cares that the occurrence landed on 07-15 — *chosen day + 1* (07-16) appears nowhere.

Two riders carried from REPX2 and re-confirmed here: the rule blob is **byte-untouched** and the template's `userModificationDate` **does not move** (the cursor bookkeeping is `umd`-silent), and the current pending instance is byte-identical. Durable: a relaunch produces *(no field changed on any surviving row)*.

The **control** arm — the identical gesture on the identical fixture, branch `Cancel` — is inert across all 41 columns of both rows.

### 1.3 The vacated slot, and the identity with an ordinary spawn

Clock rolled to **2026-07-12**, the weekly rule's own slot, with both arms in the same roll:

| arm | delta | untrashed series rows dated 2026-07-12 |
|---|---|---|
| exception | **(no field changed on any surviving row)** | **0** |
| control (Cancel) | a normal spawn | 1 |

The control's spawn:

```
INSERTED row 2twxwrhzVhTyLxuGP4be6m  startDate = 2026-07-12  status = 0
  creationDate = 1783814400.0                                   <- exactly 2026-07-12 00:00 UTC
CHANGED template.rt1_instanceCreationCount     : 1 -> 2
CHANGED template.rt1_instanceCreationStartDate : 2026-07-12 -> 2026-07-13
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-12 -> 2026-07-19
CHANGED template.todayIndexReferenceDate       : 2026-07-12 -> 2026-07-19
```

Set the two template deltas side by side and they are **the same four fields with the same four values**. So `Make Exception` is not a special cursor operation at all: **it is the ordinary spawn of that slot, performed early and dated elsewhere.** The only differences are on the minted row — `startDate` (chosen day vs slot day) and `creationDate` (gesture wall-clock vs occurrence midnight, REPX1 §1.3's cohort).

### 1.4 What is NOT measured here, and why

Watching a *weekly* series resume would need the clock at **2026-07-19**, which is past golden-v4's trial wall (§5) — the roll is refused by the driver rather than producing an app-behavior claim from a read-only app. The resumption half is measured instead on an every-2-days rule, whose slots all fall inside the window (§1.5), and the daily arms of §2–§3 resume normally at every unconsumed slot.

### 1.5 G1B — the resumption, on an every-2-days rule

A second non-daily shape, chosen so that **both** of the slots the cell needs fall inside the trial window: `Items ▸ Repeat… → daily` with the interval field driven to **2**, giving `tp=0 fu=16 fa=2 of=[{dy=0}]`, `next = icStart = 2026-07-07`, slots on 07-07 / 07-09 / 07-11. Exception arm plus a Cancel control, as in §1. The projection (07-07) is moved to **2026-07-10**, which again separates the three candidates — slot+1 = **07-08**, next rule date = **07-09**, chosen day+1 = 07-11.

```
INSERTED row SjBQsufBgVSZqWT1prFGwo
  startDate                = 2026-07-10                 <- the chosen day
  status = 0 ; start = 2 ; rt1_instanceCreationCount = 0
  creationDate             = 1783252941.973195          <- the gesture
  rt1_repeatingTemplate    = 4aBvQdqGDBmQXxBhjm4kVC

CHANGED template.rt1_instanceCreationCount     : 1 -> 2
CHANGED template.rt1_instanceCreationStartDate : 2026-07-07 -> 2026-07-08   <- WATERMARK: slot + 1
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-07 -> 2026-07-09   <- CURSOR: the next RULE date
CHANGED template.todayIndexReferenceDate       : 2026-07-07 -> 2026-07-09
```

Same law as §1.2, on a rule whose cadence is two days rather than seven. Rolled forward, both arms in the same roll:

| clock | exception arm | control arm |
|---|---|---|
| **2026-07-07** (the vacated slot) | **nothing spawns** — the only delta in the whole series is `template.todayIndex -18448 → -14995`, the rank recompute. Rows on 07-07: **0** | spawns normally; rows on 07-07: 1; cursor → 07-09, watermark → 07-08 |
| **2026-07-09** (the next rule date) | **SPAWNS** — `icCount 2→3`, watermark 07-08 → 07-10, cursor 07-09 → 07-11. Rows on 07-09: **1** | spawns; the same four template fields with the same four values |

> **The series resumes its ordinary cadence at the next rule date, and from there is indistinguishable from a series that never had an exception** — the two arms' template rows agree field for field from 07-09 onward.

---

## 2. Cell G2 — an exception meets a rule change

### 2.1 G2A — `Update Rule` AFTER a `Make Exception` on the same series

Daily fixture, cursor 07-06. Step 1 is an ordinary exception (projection 07-06 → **07-09**), which lands REPX2 §1.3's shape exactly (`icCount 1→2`, cursor and watermark both 07-06 → 07-07, minted row `2kWSZkxB` dated 07-09 at gesture wall-clock).

Step 2 drives the **next** projection (now 07-07) to **07-11** and presses `Update Rule`:

```
CHANGED template.rt1_recurrenceRule            : sha256:3b34361cc5aa9175 (627 B) -> sha256:eb381871d98d8945 (627 B)
CHANGED template.rt1_instanceCreationStartDate : 2026-07-07 -> 2026-07-11
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-07 -> 2026-07-11
CHANGED template.todayIndexReferenceDate       : 2026-07-07 -> 2026-07-11
CHANGED template.userModificationDate          : 1783252858.75 -> 1783252944.04
(icCount unchanged at 2; NO row inserted; the 07-09 exception instance byte-identical)
```

Three readings:

- **The exception is not revisited.** The rule change does not move it, re-date it, delete it or re-parent it; it keeps its `rt1_repeatingTemplate` FK and its date. Once minted, an exception is just a dated row of the series.
- **Both cursor columns re-anchor** to the chosen date (they coincide here because the rule is daily; §1 shows what "both" means on a rule where they differ).
- Same `umd`-bumping, blob-rewriting shape REPX2 §1.4 measured — so `Update Rule` behaves identically whether or not the series holds an exception.

Rolled forward:

| clock | delta | rows on that day |
|---|---|---|
| **2026-07-09** (the exception's own day) | **(no field changed on any surviving row)** | 1 — the exception, and nothing joins it |
| **2026-07-11** (the re-anchored rule's first date) | normal spawn (`icCount 2→3`, cursor+watermark → 07-12) | 1 |

So a series that holds an exception and is then re-ruled behaves exactly like one that never had an exception: the exception stands where the user put it, and the new rule runs from its new anchor.

### 2.2 G2B — a SECOND exception on a series that already holds one

Same fixture shape; exception #1 moves 07-06 → **07-09**, exception #2 moves the next projection (07-07) → **07-10**. Both are accepted with the ordinary three-button chooser and no additional prompt:

| gesture | minted row | template after |
|---|---|---|
| exception #1 | 2026-07-09 | `icCount 2`, cursor = watermark = 07-07 |
| exception #2 | 2026-07-10 | `icCount 3`, cursor = watermark = 07-08 |

| clock | result |
|---|---|
| **2026-07-07** | **nothing spawns** — rows dated 07-06: **0**, rows dated 07-07: **0**. Both vacated slots stay consumed |
| **2026-07-08** (first unconsumed slot) | normal spawn, `icCount 3→4`, cursor → 07-09 |

**There is no ceiling and no interaction.** Exceptions accumulate one per consumed slot; the series' cadence continues from the first slot nobody took.

---

## 3. Cell G3 — an exception onto an ALREADY-OCCUPIED day

### 3.1 G3A — two exceptions onto the same free day, then the spawner arrives

Exception #1 moves 07-06 → 07-09 (07-09 now holds one occurrence). Exception #2 moves the next projection (07-07) onto **the same 07-09**:

```
INSERTED row FptrLSxVANoAXZEa2dmf5t  startDate = 2026-07-09
CHANGED template.rt1_instanceCreationCount     : 2 -> 3
CHANGED template.rt1_instanceCreationStartDate : 2026-07-07 -> 2026-07-08
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-07 -> 2026-07-08

untrashed series rows dated 2026-07-09 = 2
```

**No dedupe, no prompt, no merge** — the app stacks them. (This half is the user's own explicit request twice over, so it is not by itself a defect.) Then the clock is rolled:

| clock | delta | rows on 07-09 |
|---|---|---|
| 2026-07-08 | normal spawn for the 07-08 slot (`creationDate = 1783468800.0`, occurrence midnight) | 2 |
| **2026-07-09** | **another spawn**, `PXXBoHXt`, `creationDate = 1783555200.0` (occurrence midnight), `icCount 4→5`, cursor → 07-10 | **3** |

End state of the series — six rows, three of them on one day:

```
B33yzSE1  2026-07-05  the original pending instance
XSFQRB51  (template)
TQU22USf  2026-07-09  exception #1        created 1783252903.80 (gesture)
FptrLSxV  2026-07-09  exception #2        created 1783252951.46 (gesture)
Guu8kvtd  2026-07-08  clock spawn         created 1783468800.0  (midnight)
PXXBoHXt  2026-07-09  clock spawn         created 1783555200.0  (midnight)
```

### 3.2 G3B — the minimal case: ONE exception, parked on the rule's own next slot

This is the sharp cell. A fresh daily series' projection (07-06) is moved onto **07-07** — the slot the cursor is about to advance to. `Make Exception`:

```
INSERTED row MQPG1nxpEsuKv7eWYMYgdv  startDate = 2026-07-07  creationDate = 1783252902.48 (gesture)
CHANGED template.rt1_instanceCreationCount     : 1 -> 2
CHANGED template.rt1_instanceCreationStartDate : 2026-07-06 -> 2026-07-07
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-06 -> 2026-07-07     <- the cursor now points AT the occupied day
```

Clock → **2026-07-07**:

```
INSERTED row B4Pcd3hKq9YfBmvoU5borR  startDate = 2026-07-07  creationDate = 1783382400.0 (occurrence midnight)
CHANGED template.rt1_instanceCreationCount     : 2 -> 3
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-07 -> 2026-07-08

untrashed series rows dated 2026-07-07 = 2     <- DOUBLE-BOOKED
```

**One sanctioned gesture, one day later, two copies.** The next day (07-08) spawns exactly one row, so the series is otherwise healthy — the duplicate is specific to the day the exception was parked on.

### 3.3 Why: the reconciliation is SLOT-keyed, not date-keyed

§4.1 supplies the mechanism. When an exception is undone, the vacated slot spawns again **with the very uuid the deleted exception row had** — instance uuids are derived from the template and the SLOT (the deterministic-uuid law behind cross-device dedupe, [SYNC3](sync3-dedupe-tiebreak.md) SY-3b), not from the date the row ends up on. So:

- an exception is the slot's own occurrence, carried to another date (which is why the slot then produces nothing — §1.3), and
- the 07-07 spawn in §3.2 is a **different slot's** occurrence with a **different uuid**, and nothing anywhere compares the two rows' `startDate`.

That qualifies [oddities §13](../things-app-oddities.md)'s REPX2 addendum, which reads the chooser as "exactly the reconciliation this entry asks for, one code path over". It is the reconciliation for **slot consumption**; it is not a reconciliation for **day occupancy**, and the chooser path double-books just as the instance re-date path does whenever the two disagree. Filed as [oddities §17](../things-app-oddities.md).

---

## 4. Cell G4 — ⌘Z against the chooser's branches

REPX2 §4.3 measured the app's undo only against a projection check-off. Both chooser branches are measured here, each on its own fresh fixture, each followed by a relaunch and a clock roll onto the slot in question.

In both cells `Edit ▸ Undo` reads `enabled=true` and is the bare, unnamed **`Undo`** (no operation name), with `Redo` disabled.

### 4.1 G4A — undo of `Make Exception`

```
gesture:  projection 07-06 -> 07-09, Make Exception
          INSERTED QxUwx3rpiQEmiS4KPy6fLg (07-09); icCount 1->2; cursor+watermark 07-06 -> 07-07

⌘Z:       DELETED row QxUwx3rpiQEmiS4KPy6fLg
          CHANGED template.rt1_instanceCreationCount     : 2 -> 1
          CHANGED template.rt1_instanceCreationStartDate : 2026-07-07 -> 2026-07-06
          CHANGED template.rt1_nextInstanceStartDate     : 2026-07-07 -> 2026-07-06
          CHANGED template.todayIndex                    : -9100 -> -8539
          CHANGED template.todayIndexReferenceDate       : 2026-07-07 -> 2026-07-06

relaunch: (no field changed on any surviving row)
NET vs the pre-gesture snapshot: (no field changed on any surviving row)
```

The row is **hard-deleted** (not trashed), every cursor column rewinds, and the daily rank rewinds too. Then the proof that the slot is genuinely un-consumed — clock → **2026-07-06**:

```
INSERTED row QxUwx3rpiQEmiS4KPy6fLg   startDate = 2026-07-06
```

**The same uuid as the deleted exception row.** The undo did not merely delete a row and decrement counters; it returned the slot to unspawned, and the slot's deterministic uuid was reissued to its ordinary occurrence. Rows on 07-06 = 1, rows on 07-09 = 0.

### 4.2 G4B — undo of `Update Rule`

```
gesture:  projection 07-06 -> 07-09, Update Rule
          rt1_recurrenceRule            : sha256:3b34361cc5aa9175 -> sha256:b9a58999d5b4072c (627 B both)
          rt1_instanceCreationStartDate : 2026-07-06 -> 2026-07-09
          rt1_nextInstanceStartDate     : 2026-07-06 -> 2026-07-09
          todayIndexReferenceDate       : 2026-07-06 -> 2026-07-09
          userModificationDate          : 1783252858.644477 -> 1783252904.646

⌘Z:       rt1_recurrenceRule            : sha256:b9a58999d5b4072c -> sha256:3b34361cc5aa9175   <- byte-identical restore
          rt1_instanceCreationStartDate : 2026-07-09 -> 2026-07-06
          rt1_nextInstanceStartDate     : 2026-07-09 -> 2026-07-06
          todayIndexReferenceDate       : 2026-07-09 -> 2026-07-06
          userModificationDate          : 1783252904.646 -> 1783252858.644477                  <- REWOUND, not re-bumped

relaunch: (no field changed on any surviving row)
NET vs the pre-gesture snapshot: (no field changed on any surviving row)
```

Two things stand out. The rule blob comes back with its **original hash**, so the undo restores the stored bytes rather than re-deriving an equivalent rule. And `userModificationDate` is **rewound to its exact prior value** — the app treats undo as a restoration of the record, not as a new edit. (Sync-wise that is the same lever TAGMOD's capture-and-restore recipe uses, applied by the app itself.)

Clock → **2026-07-06** afterwards: the ORIGINAL phase spawns (`icCount 1→2`, cursor → 07-07, one row on 07-06). The re-anchor is fully undone.

### 4.3 What this does and does not buy us

The app's undo is a **complete** inverse of both branches — better than REPX2 §4.3 could claim, since it now covers a row insert *and* a rule-blob rewrite *and* a `umd` rewind. None of it changes REPX2's conclusion for a shipped op, and it sharpens the second wall:

1. **No headless hard-delete of one row** — unchanged ([oddities §5i/§5j](../things-app-oddities.md)).
2. **No write verb for the cursor OR the watermark** — and §1 shows an exception moves *two* independent columns, one of which (`rt1_instanceCreationStartDate`) nothing shipped even reads. An undo would have to restore both.
3. **No way to restore a rule blob byte-identically** — our `reschedule-repeat` re-derives a rule through the dialog, which is a different write; and nothing we drive can rewind `umd` on the *template* row while leaving the rest alone.

So any `move-occurrence` op stays **irreversible-and-disclosed**, exactly as REPX2 §4.3 concluded — with the one honest mitigation that the app's own ⌘Z, driven immediately and only if nothing else has happened in the app since, is a real inverse.

---

## 5. The trial wall — a lab-discipline finding, measured the hard way

The first G1 pass rolled the clock to **2026-07-19** to watch the weekly series resume. Neither arm spawned — not the exception arm, and **not the untouched control**. Re-rolls to 07-20 and 07-26 with 60-second settles changed nothing, and an AppleScript `set status to completed` reported success while the database did not move.

The cause is not repeat semantics:

```
=== DETACHED WINDOW 1 sub=AXDialog ===
  AXTextArea  val=Your Trial Period Has Ended …
  AXButton    ttl=Quit | ttl=Read-Only Mode | ttl=Buy on the App Store
```

golden-v4 carries a **trial** build with `firstAppLaunchDate = 2026-07-03 03:14:28 +0000` and a 15-day window ([gv4-323-campaign](gv4-323-campaign.md) §Trial clock), i.e. it expires **2026-07-18**. Past that date the app runs read-only: **it does not spawn repeat occurrences and it silently drops writes** — a state that mimics an app-behavior finding precisely enough to have been written up as one. Worse, it is **sticky**: rolling the guest clock back to 2026-07-05 does *not* clear the dialog, so the clone is burned and everything after the crossing has to be re-run. (The whole campaign was re-run on a fresh clone; G1's numbers reproduced identically on both, which is the only good thing about the incident.)

**Standing rule for every clock-rolling campaign on golden-v4: no guest date on or after 2026-07-18.** The driver enforces it — `setclock` refuses the roll and says why rather than letting the run produce false negatives — and [harness.md](harness.md) now carries the note.

---

## 6. Mechanics notes for the next sitting

- **Select the projection with `show?id=<template>` FIRST, then click.** REPX2's recipe clicked the projection row's title straight after opening Upcoming. With two fixtures whose projections sit on the same far-down day, the `CGEventPost` click **selected the wrong series' row**: an off-screen row still reports an AX frame, and the click lands on whatever is actually drawn at that point. `things:///show?id=<uuid>` scrolls the list to the row *and* selects it, after which the click is a visible-row click; every selection is still uuid-verified, and the show?id= selection is the fallback (the A0 census established the projection row IS the template).
- **The picker's resolved row is TWO AX labels, not one.** REPX2 read the commit target back by grepping for `desc=Thu, Jul 9`. On this clone the resolved row renders as `desc=July 15` **plus** a separate `desc=Wed`, so a "weekday, month day" needle never matches and the read-back loop aborts the gesture. Match on `desc=<Month> <day>` alone.
- **The Repeat dialog's interval field is `text field 1 of GROUP 1`.** Three other addressings were measured and all fail: `text field 1 of sh` (it is not a direct child), a walk of `entire contents of sh` (System Events reports no text field at all), and a `CGEventPost` click at its raw-AX frame — the click lands and typed digits appear in the AX value, but the caret sits at position 0 so the digit **prepends** (`"1"` + `"2"` = `"21"`) and ⌘A, End and Backspace do nothing to it. The shipped ui recipe's path plus its `set focused` + ⌘A + type + Tab mechanic (`ui-recipes.ts` `DIALOG_INTERVAL`, `axSetValueScript`) is what commits.
- **The chooser is identical on every arm measured here** — same title, same body copy, same three `action-button-N` ids, on a weekly rule as on a daily one. REPX2 §2.3's rule (the branch set is chosen by whether the target is a calendar date the rule could be re-anchored to) is unchanged by rule shape.

---

## 7. What this campaign changes elsewhere

| document | change |
|---|---|
| [things-app-oddities.md](../things-app-oddities.md) | **new §17** — `Make Exception` onto a day the series already occupies double-books it, because the reconciliation is slot-keyed rather than date-keyed (§3) |
| [things-app-oddities.md](../things-app-oddities.md) §13 | dated pointer to §17: the addendum's "the app implements exactly this reconciliation one code path over" needs the qualifier — the chooser path double-books too whenever slot and day disagree |
| [things-app-craft.md](../things-app-craft.md) | **new 6j** — ⌘Z is a complete inverse of BOTH chooser branches, including a byte-identical rule-blob restore, a `umd` rewind, and the reissue of the slot's deterministic uuid (§4) |
| [capability-matrix.md](../capability-matrix.md) | the exception-move path's gap list gains the non-daily two-column fact and the double-book hazard (§1, §3) |
| [harness.md](harness.md) | the golden-v4 **trial wall** (no guest clock ≥ 2026-07-18; crossing it burns the clone) (§5) |
| [repx2-exception-chooser.md](repx2-exception-chooser.md) §8 | open cells 2, 3, 5 and 6 are **closed** (recorded here, not by editing that immutable snapshot); cells 1, 4 and 7 stay open |

## 8. Open cells this campaign did NOT close

1. **The exception's SYNC behavior** (REPX2 §8 cell 4) — still the question a shipped op most needs answered, and untouched here: all of REPX3 is single-device.
2. **The chooser on a repeating PROJECT template** (REPX2 §8 cell 1) and **the repeating-PROJECT `when=` crash twin** (cell 7) — both still blocked on the 3.23 project promote reveal.
3. **Whether a WEEKLY series specifically resumes at its next rule date after an exception.** Measured on an every-2-days rule (§1.5) and inferred for the weekly arm (its cursor reads 07-19 and the two rules' bookkeeping is identical in every other respect), but not watched on the weekly fixture itself, because 07-19 is past the trial wall. It needs a golden with a fresh trial clock. Low value — nothing suggests the cadence unit matters — and recorded only so the gap is not mistaken for a measurement.
