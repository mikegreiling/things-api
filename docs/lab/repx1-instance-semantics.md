# REPX1 — the Things 3.23 repeat-INSTANCE lifecycle, measured

**Version stamp:** `things-lab-golden-v4` · Things **3.23** (CFBundleVersion **32300036**, direct-download channel) · macOS **15.7.7 (24G720)** · `Meta.databaseVersion` **27** · airgapped clone, guest clock pinned **2026-07-05 12:00 (a Sunday)** and advanced by the clock-roll cells · AXVM1 accessibility grant baked. Campaign run 2026-08-22, unattended. Immutable snapshot per the [harness](harness.md) version-stamping policy.

Driver: [`lab/scripts/research-repx1.sh`](../../lab/scripts/research-repx1.sh) (cells selected by `CELLS=…`; `REUSE=1` attaches to a live clone). Fixtures fully synthetic (`REPX1-*`), plus the golden's own `LAB-*` seed as a control row. Artifacts: `lab/artifacts/repx1-lab/` (gitignored) — `report.txt`, per-gesture full-row snapshots in `snap/`, AX dumps in `ax/`.

**DB oracle:** every gesture is bracketed by a **full-row snapshot** of every `TMTask` column for the fixture's rows (`rowsnap.py` → `uuid⇥column⇥value`, packed dates decoded, blobs hashed), diffed field by field. "No field changed on any surviving row" in this document means exactly that — all 41 columns of every row compared, not a spot check.

Predecessor: [rdlg2-323-recipe-cert.md](rdlg2-323-recipe-cert.md) — this campaign answers four of its §7 open cells and **falsifies one long-standing capability verdict** (§6).

---

## 0. Headline

Six results, in descending order of consequence:

1. **A future projection row IS checkable, and checking it mints the occurrence just-in-time and completes it in one gesture** — a new row dated the projection day, born `status=3`, with the cursor advanced and the current pending instance untouched (§1).
2. **A user-gesture materialization is born at GESTURE WALL-CLOCK, not occurrence midnight** — breaking the "spawned occurrences are born at occurrence-midnight" law for every non-clock spawn path (§1.3). The clock-arrival spawner still uses occurrence midnight, measured side by side.
3. **`Items ▸ Repeat ▸ Stop` EXISTS as a menu item on 3.23 and drives cleanly** — falsifying the UIC2-d verdict that killed `todo.stop-repeat` ("card-only, mouse-double-click-only"). Measured semantics: the pending occurrence is materialized as a plain to-do, every instance's FK is severed, and the template row is **hard-deleted** (§5.4).
4. **Re-dating an instance has NO exception semantics whatsoever.** The template is byte-untouched, the FK is kept, and the rule spawns its next occurrence on schedule regardless — so moving an occurrence gives you *two* occurrences, not a moved one (§3).
5. **Re-dating an instance ONTO the cursor's own next slot DOUBLE-BOOKS that day** — the §9ff double-spawn class, now reachable on 3.23 through an ordinary re-date with no preserve trigger. New oddity ([§12](../things-app-oddities.md)) (§3.3).
6. **Neither the Logbook sweep nor mere elapsed time mints anything.** The next copy appears on the rule date and only on the rule date, proven day by day across a seven-day roll with a genuinely pending completion swept in the middle (§2).

Two mechanics findings that the rest of the lab should inherit:

- **`AXPress` on Things' content-row elements is DECORATIVE** — it returns `AXError=0` and changes nothing, on ordinary rows as well as projections. **A synthesized `CGEventPost` click at the element's own AX frame actuates it**, and it works in a headless clone under the AXVM1 grant (§1.2). Several "needs a framebuffer/HID rig" residuals are cheaper than assumed.
- **`rt1_instanceCreationStartDate` is NOT the cursor.** It is a scan watermark; `rt1_nextInstanceStartDate` is the projection cursor, and the two **diverge** on every non-daily rule (§2.3).

---

## 1. Cell A — checking off a FUTURE projection

### 1.1 The census: one projection row per template, and it carries a checkbox

Seed: `REPX1-A-DAILY`, a to-do scheduled 2026-07-05, promoted to a **daily** series through `Items ▸ Repeat…`. The series lands the documented shape — template (`start=2`, no `startDate`) plus a materialized instance dated today — with `next = icStart = 2026-07-06`, `icCount = 1`.

Upcoming, walked with the raw AX API (`rowcensus.jxa`, actions included):

```
[5] AXRow  desc=6. Tomorrow                      <- the day header
[6] AXRow
      [4]  AXUnknown desc=‎REPX1-A-DAILY   ACTIONS=AXIncrement,AXDecrement,AXCancel,AXPress
      [7]  AXUnknown desc=Checkbox        ACTIONS=AXIncrement,AXDecrement,AXCancel,AXPress  @[344,228 20x20]
             [1] AXImage desc=Checkbox Regular
      [15] AXImage  desc=Repeating Circle Fill FullColo
      [16] AXImage  desc=Task Repeat Template
```

Three census facts:

- **There is no `AXCheckBox` role anywhere in the window.** Things' content rows are custom-drawn and every element reports `AXUnknown`; the checkbox is identified by `AXDescription = "Checkbox"`. A census keyed on the ROLE returns an honest-looking but wrong negative — this document's first draft did exactly that.
- **The projection row's checkbox is indistinguishable from an ordinary row's.** `LAB-UPCOMING-1` (a plain materialized future-dated to-do) carries the same `desc=Checkbox` element with the same actions and the same 20×20 frame.
- **Upcoming renders exactly ONE projection row per repeating template** — the template's own next occurrence. Day sections 07-07 … 07-11 hold no row for the daily series even though the rule produces an occurrence on each. The row at 07-06 IS the template, rendered at its cursor day. So "projections beyond the current instance" are not separate rows to check off; there is one, and it moves as the cursor moves.

AppleScript's `to dos of list "Upcoming"` enumerates the template once, agreeing with the render.

### 1.2 The vector correction — `AXPress` is decorative

`AXUIElementPerformAction(checkbox, AXPress)` on the projection row returned **`AXError = 0`** and produced a **zero row delta**, stable across a +25 s settle and a relaunch.

That negative is worthless without a control, and the control kills it: the **same press on an ordinary row** (`LAB-UPCOMING-1`) and on the series' **own materialized instance** in Today also returned `AXError = 0` and also changed nothing. `AXPress` on these elements is a no-op the AX layer accepts.

A synthesized click at the element's AX-resolved frame is a different story:

| vector | target | result |
|---|---|---|
| `AXPress` | projection row checkbox | `AXError=0`, **zero delta** |
| `AXPress` | ordinary row checkbox (control) | `AXError=0`, **zero delta** |
| `AXPress` | materialized instance checkbox (control) | `AXError=0`, **zero delta** |
| **`CGEventPost` click** at the frame centre | materialized instance checkbox (control) | **completes it** — `status 0→3`, `stopDate` set, `umd` bumped |

So the live vector in a **headless** clone is a real HID click, resolved by AX geometry — `clickrow.jxa` in the driver. This matters beyond this campaign: the standing assumption that synthetic HID input "needs a real framebuffer, which the headless clone does not provide" ([rdlg2](rdlg2-323-recipe-cert.md) §5.4, [up-next](../up-next.md)) holds for **drags**, which remain unattempted, but **not for clicks**.

### 1.3 The answer: a just-in-time mint, completed in the same gesture

Clicking the checkbox of the 2026-07-06 projection row on a fresh series (`REPX1-A4-DAILY`; current instance dated 07-05, `next = icStart = 07-06`, `icCount = 1`):

```
INSERTED row Qh3GNwaz…
  status                   = 3                       <- born COMPLETE
  stopDate                 = 1783253354.233906       <- click wall-clock
  creationDate             = 1783253354.2304049      <- click wall-clock, NOT occurrence midnight
  userModificationDate     = 1783253354.233972
  start                    = 2                       <- scheduled
  startDate                = 2026-07-06              <- the PROJECTION day
  startBucket              = 0
  todayIndexReferenceDate  = 2026-07-06
  rt1_repeatingTemplate    = AoNVHphP…               <- a true instance of the series
  rt1_instanceCreationCount= 0
  leavesTombstone          = 1
  trashed                  = 0

CHANGED template.rt1_instanceCreationCount     : 1 -> 2
CHANGED template.rt1_instanceCreationStartDate : 2026-07-06 -> 2026-07-07
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-06 -> 2026-07-07
CHANGED template.todayIndexReferenceDate       : 2026-07-06 -> 2026-07-07
```

Everything the maintainer asked, answered:

| question | measurement |
|---|---|
| does a projection row offer a checkbox? | **yes** — same element, same actions as any row |
| does checking it mint just-in-time? | **yes** — one new `TMTask` row, `rt1_repeatingTemplate` set |
| status / stopDate | `status = 3`, `stopDate` = the click instant |
| creationDate | **the click instant** — see below |
| startDate | **the projection day** (2026-07-06), `start = 2`, `startBucket = 0` |
| cursor / count | `next` and `icStart` advance one period; `icCount` **+1** |
| does the CURRENT pending instance survive? | **yes — byte-identical**, still `status=0` on 07-05 |
| durable? | yes — zero delta across a +25 s settle **and** a relaunch |

**The `creationDate` finding.** The assumption register records that spawned occurrences are "born at **occurrence-midnight** in the spawning device's local zone, NOT wall-clock" ([timestamps](../reference/timestamps.md) §1b; SYNC2B SY-3, on which the cross-device deterministic-uuid merge rests). That law is **confirmed for the clock-arrival spawner and broken for every user-gesture materialization**, measured side by side on the same clone:

| materialization path | occurrence day | `creationDate` | reading |
|---|---|---|---|
| clock reaches the rule date (§2.4, §3.2, §3.3) | 2026-07-06 / 07-12 | `1783296000.0` / `1783814400.0` | **exact occurrence midnight UTC** |
| projection check-off (§1.3) | 2026-07-06 | `1783253354.23` | **2026-07-05 12:09:14** — the click |
| bulk `Stop` materialization (§5.4) | 2026-07-07 | `1783339594.60` | **2026-07-06 12:06:34** — the gesture |

So the midnight anchor is a property of the **launch-time maintenance pass**, not of instance birth. Any consumer that infers an occurrence's day from its `creationDate` — or that relies on two devices deriving the same birth stamp — is correct only for clock-arrival spawns. Recorded in the register (RD-28) and flagged for the SYNC2B/SYNC3 model, which was built entirely on the clock-arrival cohort.

---

## 2. Cell B — early completion, and when the next copy actually appears

### 2.1 Early completion leaves the series untouched (RDLG2 §5.3, at full row width)

`REPX1-B-WEEKLY`: a weekly-Sunday series created 2026-07-05, instance dated 07-05, `next = icStart = 2026-07-12`, `icCount = 1`. Completing that instance **seven days before the next slot**:

```
CHANGED instance.status : 0 -> 3
CHANGED instance.stopDate : None -> 1783253498.83
CHANGED instance.userModificationDate : …
(no other field changed on any row — the template is byte-identical)
```

Three columns on one row. The template's rule blob, cursor, watermark and count are untouched. RDLG2 §5.3 measured this on a daily series with a spot check; it holds under a full 41-column diff and at a seven-day lead.

### 2.2 Nothing mints early — not on settle, not on the sweep

| probe | result |
|---|---|
| **+30 s at the same clock** | zero delta |
| **`log completed now` at the golden's `logInterval = 0`** | zero delta — but this proves nothing (see below) |
| **`log completed now` with a genuinely PENDING completion** | **zero delta on every repeat row** |

The first sweep arm is a trap worth naming: the golden ships `logInterval = 0` ("Immediately"), so a completion is logged *at completion* and `log completed now` has nothing left to do — `manualLogDate` did not even move. Its zero delta is structural, not evidence.

The honest arm (**B3**) flips the preference to **Manually** through the Settings panel (RESID1 R-AXRETRY recipe: quit + relaunch first, target the log-interval popup by enumeration index 3), which lands `logInterval = 4` and — as RESID1 R-DAILYMAN predicts — stamps `manualLogDate` on *leaving* "Immediately". A fresh weekly series is then completed early so a genuinely unswept completion exists (census: 11 resolved-but-unlogged rows), and only then swept:

```
manualLogDate  1783252845.84 -> 1783252902.44      <- the sweep really fired
ROW DELTA: (no field changed on any surviving row)
template: fu=256 fa=1 next=2026-07-12 icStart=2026-07-12 icCount=1   <- byte-identical
```

**The Logbook sweep mints nothing and mutates nothing repeat-related.** It advances the `TMSettings.manualLogDate` singleton and touches zero `TMTask` rows — extending the LOGNOW / [timestamps](../reference/timestamps.md) §2b "log sweep is a pure view projection" law to the repeat family explicitly. (The preference was restored to "Immediately" before the remaining cells.)

### 2.3 The day-by-day roll — the mint is on the rule date, and only there

Clock advanced one day at a time, Things quit and relaunched at each step, full snapshot per day:

| guest clock | new rows | template |
|---|---|---|
| 2026-07-06 (Mon) | — | byte-identical |
| 2026-07-07 (Tue) | — | byte-identical |
| 2026-07-08 (Wed) | — | byte-identical |
| 2026-07-09 (Thu) | — | byte-identical |
| 2026-07-10 (Fri) | — | byte-identical |
| 2026-07-11 (Sat) | — | byte-identical |
| **2026-07-12 (Sun)** | **+1 instance** | cursor + watermark + count all move |

Six launches with an early-completed series and a due-in-the-future cursor produce **zero** mutation. The series is genuinely dormant between slots; the app does not opportunistically top up.

### 2.4 The mint, and the watermark/cursor split

On 2026-07-12:

```
INSERTED row HhqGgEcp…
  creationDate            = 1783814400.0    <- exactly 2026-07-12 00:00 UTC (occurrence midnight)
  status                  = 0
  start                   = 2
  startDate               = 2026-07-12
  todayIndexReferenceDate = 2026-07-12
  rt1_repeatingTemplate   = UYzQnahA…

CHANGED template.rt1_instanceCreationCount     : 1 -> 2
CHANGED template.rt1_instanceCreationStartDate : 2026-07-12 -> 2026-07-13
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-12 -> 2026-07-19
CHANGED template.todayIndex                    : -1697 -> 1019
CHANGED template.todayIndexReferenceDate       : 2026-07-12 -> 2026-07-19
```

Note the two cursor-ish columns **diverge**: the watermark goes to the spawned day **+1 day** (07-13), the projection cursor goes to the **next rule date** (07-19). Every prior campaign probed daily rules, where the two coincide, so this split has not been recorded before. Collating every observation in this campaign:

| column | behavior |
|---|---|
| `rt1_nextInstanceStartDate` | **the projection cursor** — the next occurrence the rule will produce. NULL while paused (§5.3) and while an after-completion series waits (§2.5). This is what `templateProjectionDay` reads, and it is the right column. |
| `rt1_instanceCreationStartDate` | **a scan watermark** — "the earliest day the spawner has not yet considered". Equals the cursor at series birth; on a spawn it becomes *spawned-day + 1*; on a dormant after-completion template it simply **drifts forward with the clock** (§2.5), with no spawn and no other change. |

Nothing shipped reads the watermark as a cursor, so this opens no bug — but it retires the shorthand "`next = icStart` = the cursor" that RDLG2 §5.2 and DBLSPAWN1 both use, which is true only of daily rules.

### 2.5 After-completion: completion sets the anchor, the mint still waits for the date

`REPX1-B-AC`, promoted with frequency **after completion** (default cadence: every 1 week). At birth: `tp=1 fu=256 fa=1`, `of=[]`, **`next = NULL`**, `icStart = 2026-07-06` (today+1), `icCount = 1`, one instance dated today.

Completing the instance:

```
CHANGED template.rt1_afterCompletionReferenceDate : None -> 132805248  (2026-07-05)
CHANGED template.rt1_nextInstanceStartDate        : None -> 2026-07-12
CHANGED template.todayIndexReferenceDate          : None -> 2026-07-12
CHANGED instance.status                           : 0 -> 3
CHANGED instance.stopDate                         : None -> 1783252867.98
CHANGED instance.userModificationDate             : …
```

So completion **anchors** the series (`rt1_afterCompletionReferenceDate := the completion day`) and **derives** the cursor from it (anchor + 1 week = 07-12). **No instance is minted at completion.** Advancing to 2026-07-06 changes exactly one byte-group — the watermark, 07-06 → 07-07 — and mints nothing, as the cursor says it should.

Two consequences worth carrying forward:

- **`rt1_afterCompletionReferenceDate` is the after-completion anchor** and is **not in the depended-column manifest** (`src/db/schema.ts`). Nothing shipped needs it today — the derived cursor is sufficient — but it is the column that explains where an after-completion projection comes from.
- **RDLG2e §6.1's cohort claim needs a qualifier.** It records after-completion templates as a "no cache" cohort ("after-completion: no calendar"). Measured here, an after-completion template has no cached projection **only until its instance is completed**; from the first completion onward it carries a real `rt1_nextInstanceStartDate` like any fixed rule. The RDLG2e corpus simply never completed one. This does not change `templateProjectionDay`'s cache-first-then-derive shape — it makes the cached branch *more* often the live one — but the "27 live templates with no cached projection" cohort in [gv4-323-campaign](gv4-323-campaign.md) §2.1 is now better explained: never-completed after-completion series are a natural member.

---

## 3. Cell C — the "exception", defined by measurement

The GUI's Make Exception / Update Rule chooser has resisted every headless provocation. What the automation surface *does* offer is a clean instance re-date, and this cell measures whether that carries any exception semantics at all. **It carries none.**

### 3.1 The full row delta of a programmatic instance re-date

`REPX1-C-DAILY`: daily series, instance dated 07-05, `next = icStart = 07-06`, `icCount = 1`.

**C1 — AppleScript `schedule to do id <instance> for July 8, 2026`:**

```
CHANGED instance.start                   : 1 -> 2
CHANGED instance.startDate               : 2026-07-05 -> 2026-07-08
CHANGED instance.todayIndexReferenceDate : 2026-07-05 -> 2026-07-08
CHANGED instance.userModificationDate    : …
(the template: byte-identical — rule blob, next, icStart, icCount all unmoved)
rt1_repeatingTemplate: STILL SET
AX containers after the gesture: 0   (no chooser, no sheet)
app: ALIVE
```

**C2 — URL `things:///update?id=<instance>&when=2026-07-09`** on the same row:

```
CHANGED instance.startDate               : 2026-07-08 -> 2026-07-09
CHANGED instance.todayIndexReferenceDate : 2026-07-08 -> 2026-07-09
CHANGED instance.userModificationDate    : …
(template byte-identical; no chooser; no crash — oddities §1 is the TEMPLATE case)
```

So the presumptive "exception" is, byte for byte, **an ordinary `when` write on an ordinary row**:

| | measured |
|---|---|
| fields that move | `startDate`, `todayIndexReferenceDate`, `umd`, plus `start` 1→2 when leaving today |
| `rt1_repeatingTemplate` FK | **kept** — the row stays a member of the series |
| template / rule bytes | **byte-untouched**, on both vectors |
| cursor, watermark, count | **unmoved** |
| chooser | **never appears** |

`todayIndex` moved on two of the three re-dates in this campaign and not on the third (C1's move to 07-08 left it alone; C3b's and C4's moves to 07-06 rewrote it) — the re-date participates in the destination day's ordering rather than preserving a rank, so the rewrite is destination-dependent. Not load-bearing; recorded so a future byte-diff is not surprised.

### 3.2 The semantic heart — the moved occurrence satisfies nothing

With the instance parked on 07-09, the clock was advanced to **07-06**, the cursor's own slot:

```
INSERTED row Q5xxacsA…  startDate = 2026-07-06  status = 0  creationDate = 1783296000.0
CHANGED template.rt1_instanceCreationCount     : 1 -> 2
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-06 -> 2026-07-07
CHANGED template.rt1_instanceCreationStartDate : 2026-07-06 -> 2026-07-07
```

Series afterwards: the moved occurrence on 07-09, a fresh occurrence on 07-06, and the template.

**Slot consumption is tracked by the CURSOR, never by any instance's date.** Re-dating an occurrence does not consume, vacate, suppress or reserve anything. A user who "moves this week's occurrence to Thursday" does not get a moved occurrence — they get their moved to-do *plus* the rule's next occurrence, arriving on schedule. That is the whole reason the app needs a Make Exception chooser in the GUI, and it is precisely the semantics no automation surface can reach.

### 3.3 Re-dating ONTO the next slot DOUBLE-BOOKS it

The complementary construction. `REPX1-C-SLOT`: daily series, instance on 07-05, cursor on 07-06. The instance is re-dated **onto 07-06** — the cursor's own slot:

```
CHANGED instance.start                   : 1 -> 2
CHANGED instance.startDate               : 2026-07-05 -> 2026-07-06
CHANGED instance.todayIndex              : -3220 -> -3862
CHANGED instance.todayIndexReferenceDate : 2026-07-05 -> 2026-07-06
CHANGED instance.userModificationDate    : …
(template byte-identical; cursor still 2026-07-06)
```

Then the clock reaches 07-06:

```
INSERTED row JsNYRpUB…  startDate = 2026-07-06  status = 0  creationDate = 1783296000.0
CHANGED template.rt1_instanceCreationCount : 1 -> 2
CHANGED template.rt1_nextInstanceStartDate : 2026-07-06 -> 2026-07-07

VERDICT: untrashed rows of this series dated 2026-07-06 = 2
```

**Two live occurrences of the same series on the same day.** This is the [oddities §9ff](../things-app-oddities.md) double-spawn class — the app's cursor and its materialized occurrences are not reconciled — but reached by a path §9ff does not cover: **no deadline, no terminal checklist element, no preserve trigger, no composite of ours.** An ordinary occurrence re-date onto the next occurrence's day is enough, and it is a gesture a pure-GUI user makes by dragging a repeating to-do one day forward. Filed as [oddities §13](../things-app-oddities.md).

Note the relationship to RDLG2 §5.5, which found §9ff's *original* precondition (the deadline preserve trigger) no longer forms on 3.23 and declined to call that a fix. This cell settles the question from the other side: **the spawn/materialization reconciliation is NOT fixed in 3.23.** The precondition changed shape; the defect is intact.

### 3.4 The chooser, provoked once more on golden-v4 — still absent

The RDLG2 §5.4 negative was re-run with the keyboard commit path (`Items ▸ When…` → type `tomorrow` → **Return**, rather than `AXPress` on the filtered row, which is now known to be decorative). The picker resolves correctly:

```
=== DETACHED WINDOW  id=WhenPopUpDialog-FCAE9956-… @[57,112 341x173] ===
  AXScrollArea
    AXUnknown desc=Tomorrow
    AXUnknown desc=Jul 6
  AXTextField val=tomorrow
  AXUnknown desc=When
```

Return commits, and the instance re-dates 07-05 → 07-06 with the §3.1 delta exactly. **AX containers afterwards: 0 — no chooser sheet, and the template is byte-untouched.** So the honest negative stands under a fifth vector and on the new golden: the Make Exception / Update Rule chooser is not on the automation path, and every reachable re-date is the plain instance write of §3.1. It remains a framebuffer/HID-**drag** cell — though §1.2 shows a synthetic *click* is now cheap, so the drag arm is the only genuinely blocked half.

---

## 4. Cell D — `Edit Rule…` is the `reschedule-repeat` shape

`REPX1-D3-RULE`, a daily series. `Items ▸ Repeat` submenu on the template, censused: **`Edit Rule…` · (sep) · `Show Previous Copy` · `Create Next Copy` · (sep) · `Pause` · `Stop`**.

`Edit Rule…` opened, interval driven 1 → 4 (typed, read back as `4` **before** the commit), OK:

```
CHANGED template.rt1_recurrenceRule    : sha256:3b34361cc5aa9175 (627 B) -> sha256:6587c0927ede9447 (627 B)
CHANGED template.userModificationDate  : …
(nothing else moved on any row)

rule: fu=16 fa=1 -> fu=16 fa=4     next=2026-07-06  icStart=2026-07-06  icCount=1   (all unchanged)
```

Two columns on one row: the rule blob (same length, new bytes) and `umd`. **The cursor is NOT re-anchored by a rule change** — `next` stays 07-06 even though the rule is now every-four-days, so the first post-change occurrence still lands on the old phase. Instances are untouched.

This is exactly the shape RDLG2c cells C10/C11 certified for the shipped `reschedule-repeat` (which drives this same menu item), so the vocabulary ties: **the chooser's "Update Rule" branch, `Items ▸ Repeat ▸ Edit Rule…`, and `things todo reschedule-repeat` are one operation.** The chooser itself remains unreachable (§3.4), so "Update Rule" is confirmed by equivalence rather than by pressing the button.

---

## 5. Cell E — Show Previous Copy, and the bulk verbs

### 5.1 `Items ▸ Repeat` is a TEMPLATE-only menu

The first attempt at this cell failed with `-1728` and looked like a driver bug. It is not. With the selection verified **by uuid** (`id of selected to dos`, not the shared title):

| selection | `Items` menu has a `Repeat` item? |
|---|---|
| the **instance** `CXAe7JHV…` | **false** — the item is absent from the menu entirely |
| the **template** `ENnBduqk…` | **true** (`enabled=true`, `submenu=true`) |

The instance's `Items` menu also *enables* `Convert to Project…`, which is disabled on the template — the two selections get genuinely different menus. So every verb in this family — `Edit Rule…`, `Show Previous Copy`, `Create Next Copy`, `Pause`, `Stop` — is reached **from the series**, never from an occurrence. (Our shipped ui recipes already resolve templates, so nothing is broken; the census simply explains the failure mode and pins the precondition.)

### 5.2 `Show Previous Copy` is pure navigation

Driven on a series holding a completed 07-05 copy and an open 07-06 copy:

```
ROW DELTA: (no field changed on any surviving row)   — 9 rows, 369 fields compared
selection after: REPX1-E-1     window title after: Today
```

**Zero DB effect.** It is a view/selection action, not a mutation — which is the answer the rdlg2 §7 cell wanted, and it means the verb is uninteresting for the write surface. (What it *reveals* in the UI could not be discriminated here, because the previous copy shares the series title and the window did not change; a visual arm would need distinct per-copy content.)

### 5.3 Bulk pause / resume: atomic, per-row, the SERDEL bytes

A genuine three-template multi-selection was built by CGEvent click + **shift**-click on the three projection rows in Upcoming (`selected to dos` → `REPX1-E-3, REPX1-E-2, REPX1-E-1`), then `Items ▸ Repeat ▸ Pause`:

```
CHANGED 22EC7ebC.rt1_instanceCreationPaused : 0 -> 1
CHANGED 22EC7ebC.rt1_nextInstanceStartDate  : 2026-07-07 -> None
CHANGED 22EC7ebC.userModificationDate       : … -> 1783339447.861433
CHANGED EA2iy3vP.rt1_instanceCreationPaused : 0 -> 1
CHANGED EA2iy3vP.rt1_nextInstanceStartDate  : 2026-07-07 -> None
CHANGED EA2iy3vP.userModificationDate       : … -> 1783339447.8614058
CHANGED ENnBduqk.rt1_instanceCreationPaused : 0 -> 1
CHANGED ENnBduqk.rt1_nextInstanceStartDate  : 2026-07-07 -> None
CHANGED ENnBduqk.userModificationDate       : … -> 1783339447.861453
```

**Exactly the SERDEL / RD-15 single-target pause bytes, applied per row** — `paused` set, cursor cleared, anchor and rule blob untouched — with the three `umd` stamps inside 50 µs of each other, i.e. one transaction. No confirmation, no partial application, no aggregate side effect. Resume inverts it precisely (`paused → 0`, cursor restored to 2026-07-07 on all three).

One honest limit: this run **cannot discriminate "restore the pre-pause cursor" from "re-anchor to today+1"**, because at the guest clock of 2026-07-06 both answers are 2026-07-07. RD-15 records resume as a re-anchor that spawns today's occurrence; here `icCount` did **not** move and no instance was minted — consistent with a re-anchor whose occurrence already exists, and equally consistent with a plain restore. A discriminating cell needs a pause held across several days.

### 5.4 `Stop` — the verdict that killed `todo.stop-repeat` is FALSE on 3.23

The capability matrix records `todo.stop-repeat` as **DROPPED** because "its Stop popover is card-only and the card opens only via a mouse double-click; UIC2-d confirmed no menu/AX surface exposes it" (Things 3.22.11).

On 3.23, `Stop` is a plain item in the `Items ▸ Repeat` submenu, and clicking it raises a standard alert:

```
=== AXSheet desc=alert id=_NS:91 @[382,258 260x218] ===
  AXImage      desc=Things alert
  AXStaticText val=Stop Items from Repeating
  AXStaticText val=Are you sure you want to stop these items from repeating?
  AXButton     ttl=Cancel      id=action-button-2
  AXButton     ttl=Stop Them   id=action-button-1
```

`action-button-1` / `action-button-2` is the same confirm-button convention the certified ui recipes already use. Pressing **Stop Them** on the three-template selection:

```
INSERTED row T3XQhn6o…  title=REPX1-E-1  startDate = 2026-07-07  status = 0
INSERTED row 13PrWkDG…  title=REPX1-E-2  startDate = 2026-07-07  status = 0
INSERTED row EJ15A5Wm…  title=REPX1-E-3  startDate = 2026-07-07  status = 0
      creationDate = 1783339594.60…    <- gesture wall-clock (§1.3)
      rt1_repeatingTemplate: NOT SET   <- born free-standing

CHANGED VAEqf3ru.rt1_repeatingTemplate : ENnBduqk… -> None
CHANGED CXAe7JHV.rt1_repeatingTemplate : ENnBduqk… -> None
CHANGED ToUokpgV.rt1_repeatingTemplate : 22EC7ebC… -> None
CHANGED 7XeWvv3e.rt1_repeatingTemplate : 22EC7ebC… -> None
CHANGED 4BvtoVPK.rt1_repeatingTemplate : EA2iy3vP… -> None
CHANGED 6hVPBoZ9.rt1_repeatingTemplate : EA2iy3vP… -> None

(all three TEMPLATE rows are GONE — hard-deleted, `rsum` reports NO-ROW)
```

Afterwards, nine plain to-dos and zero templates; advancing to 2026-07-07 produces **zero delta**. So:

> **`Stop` = "turn this series into plain to-dos."** It materializes the pending occurrence as a free-standing to-do, severs `rt1_repeatingTemplate` on every existing instance, and **hard-deletes the template row**. Every occurrence — past, present and the just-minted next — survives as an ordinary to-do.

That is a materially different primitive from everything we have: `pause` (reversible, keeps the template), and the SERDEL "trash-both" removal (destroys the template *and* the instance, recoverable via Trash). `Stop` is the **non-destructive series termination** — the one users actually mean by "stop repeating" — and it is now demonstrably reachable through the menu + `action-button-1` path the ui vector already speaks. Recorded in the capability matrix as reachable-but-unbuilt; **no op was built in this campaign**.

Gaps named rather than assumed: the **singular** confirmation (one template selected) was not driven — the copy measured here is the plural variant, so the singular sheet's title/button strings are unknown; the **project** `Stop` was not attempted (UIC2-c / oddities §7 C5 records that stopping a project and then selecting it CRASHES 3.22.11, unre-probed on 3.23); and `Stop` is **irreversible** as measured (a hard-deleted template leaves no Trash row to put back), which any future op must disclose.

---

## 6. What this campaign changes elsewhere

| document | change |
|---|---|
| [things-app-oddities.md](../things-app-oddities.md) | **new §13** — the instance-re-date double-book (§3.3), a §9ff sibling with no preserve trigger, reachable by an ordinary GUI drag |
| [things-app-craft.md](../things-app-craft.md) | **new entry** — the just-in-time projection check-off (§1.3): one click mints an occurrence that never existed, completes it, advances the cursor, and leaves the pending instance alone |
| [capability-matrix.md](../capability-matrix.md) | `todo.stop-repeat`'s DROPPED rationale is **falsified on 3.23** (§5.4) — recorded with measured semantics and the three named gaps; the instance re-date is recorded as reachable-with-no-exception-semantics (§3) |
| [assumption-register.md](../reference/assumption-register.md) | **new RD-28** — the REPX1 instance-lifecycle laws, evidence-only, ⚠ no live lock; and the `creationDate` refinement to the spawn law RD-11/SY-3 rest on |
| [rdlg2-323-recipe-cert.md](rdlg2-323-recipe-cert.md) §7 | cells 1 (partially — the chooser negative re-confirmed, the drag arm still open), 4 (`Show Previous Copy`) and 5 (bulk pause/resume/stop) are answered here; §5.5's open question about whether 3.23 fixed the reconciliation is answered **no** (§3.3) |
| [timestamps.md](../reference/timestamps.md) §1b | the "spawned occurrences are born at occurrence-midnight" row needs the gesture-materialization exception (§1.3) — carried by RD-28 rather than by editing the synthesis doc's cited campaigns |

## 7. Open cells this campaign did NOT close

1. **The Make Exception / Update Rule chooser itself** — five vectors now, all negative (§3.4). Only the in-GUI calendar **drag** is unattempted, and §1.2 shows synthetic clicks work headlessly, so a drag arm is the cheapest remaining shot.
2. **`Create Next Copy`'s `creationDate`.** RDLG2 §5.2 measured its cursor bookkeeping but not the minted row's birth stamp. Given §1.3 it should be gesture wall-clock, which would make three of three gesture paths agree — worth one cheap cell.
3. **Resume after a MULTI-DAY pause** — restore vs re-anchor is undiscriminated (§5.3).
4. **`Stop`'s singular confirmation copy, and `Stop` on a repeating PROJECT** (§5.4).
5. **What `Show Previous Copy` actually reveals** — proven inert in the DB (§5.2); the view effect needs distinguishable per-copy content.
6. **§9ff via the terminal-checklist-element preserve trigger** (rdlg2 §7 cell 2) — untouched here. §3.3 shows the defect class is alive on 3.23 by another route, which lowers the stakes of this cell but does not answer it.
