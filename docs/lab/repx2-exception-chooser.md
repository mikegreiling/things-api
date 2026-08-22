# REPX2 — the Things 3.23 Make-Exception chooser, JIT edge cases, and the template-`when` crash re-probe

**Version stamp:** `things-lab-golden-v4` · Things **3.23** (CFBundleVersion **32300036**, direct-download channel) · macOS **15.7.7 (24G720)** · `Meta.databaseVersion` **27** · two airgapped clones, guest clock pinned **2026-07-05 12:00 (a Sunday)** and advanced by the clock-roll cells · AXVM1 accessibility grant baked. Campaign run 2026-08-22, unattended. Immutable snapshot per the [harness](harness.md) version-stamping policy.

Driver: [`lab/scripts/research-repx2.sh`](../../lab/scripts/research-repx2.sh) (cells selected by `CELLS=…`; `REUSE=1` attaches to a live clone). Fixtures fully synthetic (`REPX2-*`), plus the golden's own `LAB-*` seed as the tag/move census corpus. Artifacts: `lab/artifacts/repx2-a/` and `lab/artifacts/repx2-b/` (gitignored) — `report.txt`, per-gesture full-row snapshots in `snap/`, AX dumps in `ax/`.

**DB oracle:** every gesture is bracketed by a **full-row snapshot** of every `TMTask` column for the fixture's rows (`rowsnap.py` → `uuid⇥column⇥value`, packed dates decoded, blobs hashed), diffed field by field. "No field changed on any surviving row" means all 41 columns of every row compared, not a spot check.

Predecessor: [repx1-instance-semantics.md](repx1-instance-semantics.md). REPX1 concluded that the Make Exception / Update Rule chooser was "not on the automation path" after five negative vectors. **All five hit a materialized INSTANCE.** The maintainer found the real trigger — a scheduling edit on a **PROJECTION** row — and this campaign drives it. One REPX1 verdict is refined and one [oddities](../things-app-oddities.md) entry is softened as a result.

---

## 0. Headline

1. **The chooser is real, and it is reachable headlessly.** Select the Upcoming **projection row** (which IS the template), `Items ▸ When…`, commit a date, and the app raises a standard `AXSheet` alert with `Make Exception` / `Update Rule` / `Cancel` on the ordinary `action-button-N` identifiers the certified ui recipes already speak. **No framebuffer rig, no drag** (§1.2).
2. **`Make Exception` has TRUE exception semantics — it CONSUMES the rule slot.** It mints a real instance at the new date *and* advances the cursor past the original slot; when the clock reaches that slot, **nothing spawns**. Measured against a Cancel control on the same clock roll, which spawns normally (§1.3, §1.5). [Oddities §13](../things-app-oddities.md)'s "nothing we drive can express an exception" gets a **dated softening** — and the defect it reports gets *sharper*, because the app demonstrably owns the reconciliation it fails to apply on the instance path.
3. **`Update Rule` is NOT `Edit Rule…`.** It rewrites the rule blob **and re-anchors the cursor** to the chosen date; `Edit Rule…` (= our shipped `reschedule-repeat`) rewrites the blob and leaves the cursor where it was (REPX1 §4). The REPX1 "one operation, confirmed by equivalence" claim is **falsified** (§1.4).
4. **The chooser's shape is chosen by whether the RULE COULD EXPRESS THE TARGET.** A calendar date → three buttons (exception *or* rule). A list bucket the rule cannot name — `Today`, `Someday` — → two buttons, exception-only, with different copy. Time-of-day is irrelevant to the split (§2.3, five arms).
5. **Deadline edits raise the same chooser; reminder edits ride the When picker's.** An exception deadline is an ordinary `deadline` column value on a freshly minted instance (no `t2_deadlineOffset`); `Update Rule` on a deadline writes the deadline-mode template shape (`ts=-14`, `deadline = 4001-01-01`) and does **not** re-anchor (§2).
6. **The maintainer's "title/notes/tag/checklist do nothing" is FALSE — they do something worse than nothing.** Every content-class edit made on a highlighted projection lands **silently on the TEMPLATE**, with **no chooser at all**, while the series' already-materialized current occurrence keeps the old content. New [oddity §14](../things-app-oddities.md) (§3).
7. **JIT check-off has no guard.** Four consecutive projection check-offs march the cursor from 07-06 to 07-10 at a frozen clock, minting four completed instances (§4.1). The sanctioned `Create Next Copy` + complete approximation is **byte-equivalent** to a direct check-off (§4.2), and `Create Next Copy`'s birth stamp is **gesture wall-clock** — closing REPX1 §7 open cell 2 at three of three (§4.2).
8. **The app's own ⌘Z is a PERFECT inverse of a JIT materialization** — the minted row is deleted and the cursor, watermark and count all rewind, durably. **Ours could not be** (§4.3).
9. **The template-`when` crash is ALIVE on 3.23.** `update?when=today` and `update?when=today@18:00` on a repeating template both kill the process with `EXC_BREAKPOINT` and a fresh `.ips`; AppleScript still refuses cleanly with 302; `deadline=` is still silently dropped (§5). No engine unblock.
10. **The URL scheme's `when=` parses natural language** — `next thursday`, `second tuesday in november`, `in 3 days`, `next week` all land correct dates, 6/6 (§6.2). Undocumented, and evidence for a future CLI design question only.

---

## 1. Cell A — the chooser for a WHEN edit

### 1.1 The trigger path, censused (A0)

Seed shape used by every cell below: `things:///add?title=…&when=2026-07-05` then `Items ▸ Repeat… → daily → OK`. That lands the documented series — a materialized instance dated today (07-05) plus a template with `next = icStart = 2026-07-06`, `icCount = 1` — and Upcoming renders **one** projection row for the series, at the cursor day (REPX1 §1.1).

The projection row is selected by a `CGEventPost` click at its title element's AX frame, then **verified by uuid** (REPX1 §5.1's lesson — a series shares one title):

```
CLICKED TITLE of the REPX2-A0-DAILY row at (444,237.75) [row 6 of 51]
PROJECTION selected — selection uuid == TEMPLATE uuid (GD2XUSL6Gv8DznCtJipjRP)
```

`Items` with the projection highlighted, against an ordinary to-do as control:

| item | projection (= template) | ordinary to-do |
|---|---|---|
| `When…` | **enabled** | enabled |
| `Deadline…` | **enabled** | enabled |
| `Tags…` | enabled | enabled |
| `Move…` | enabled | enabled |
| `Repeat` | **enabled, SUBMENU** | — |
| `Repeat…` | — | enabled, no submenu |
| `Convert to Project…` | **DISABLED** | enabled |
| `Complete` / `Shortcuts` / `Get Info` / `Share…` | enabled | enabled |

So the schedule-class verbs are offered on a projection exactly as on any row — which is why the chooser was always one menu click away and five instance-targeted vectors never found it. (The `Repeat` vs `Repeat…` split re-confirms REPX1 §5.1's template-only menu finding from the other direction.)

Both pickers open on a projection and are **inert until committed** — opening and pressing Escape produced *(no field changed on any surviving row)* for `When…` and again for `Deadline…`.

The 3.23 `When` picker is a detached `WhenPopUpDialog-<uuid>` window (341×396) holding `Today` · `This Evening` · a calendar scroll area · `Someday` · **`Add Reminder`** · a `Clear` button, plus an `AXTextField` search field. `Deadline…` is its sibling `DeadlinePopUpDialog-<uuid>` (346×421) — calendar + text field, no bucket rows and no reminder row.

### 1.2 The chooser, captured

`Items ▸ When…` on the projection, `9 jul 2026` typed into the search field (read back as a resolved `July 9 · Thu` row), **Return**:

```
=== AXSheet (child 30 of window 2 "Upcoming") ===
[30] role=AXSheet | desc=alert | id=_NS:91 | @[382,212 260x310]
  [1] role=AXImage      desc=Things alert            id=_NS:35
  [2] role=AXStaticText val=Repeating To-Do          id=_NS:78
  [3] role=AXStaticText val=You’re editing a repeating to-do. Would you like to
                            make a one-time exception, or update the repeating rule?
  [4] role=AXButton     ttl=Make Exception           id=action-button-1
  [5] role=AXButton     ttl=Update Rule              id=action-button-2
  [6] role=AXButton     ttl=Cancel                   id=action-button-3
```

Two mechanics worth carrying forward:

- **It is a plain modal sheet on the main window** with the `action-button-N` identifiers the shipped ui recipes already use for `Stop Them` / confirm sheets — i.e. the drive is ordinary, and the [SESSGATE](sessgate-session-reachability.md) DIALOG-class precondition (a reachable window on the current Space) applies unchanged.
- **With the chooser open, the DB is untouched** — the row delta between "before the gesture" and "chooser on screen" is empty on every arm. Nothing is written speculatively.

The picker's text field is a **natural-language date parser**, and it must be driven closed-loop: typing filters the list to exactly one resolved row whose `AXDescription` names the resolution, so the recipe types → reads the row back → *then* commits (`pickdate` in the driver). Typing blind is not safe: `next thursday` at a Sunday clock resolves to **Jul 16**, not Jul 9.

### 1.3 A1 — `Make Exception` mints an occurrence AND consumes the slot

Fixture `REPX2-A1-DAILY`: daily, instance on 07-05, cursor 07-06, `icCount = 1`. Projection moved **07-06 → 07-09** (a free day), branch = `Make Exception`:

```
INSERTED row TFADK56XLdbF5eSTmDkCL
  status                   = 0                       <- born OPEN
  start                    = 2
  startDate                = 2026-07-09              <- the CHOSEN day
  startBucket              = 0
  todayIndexReferenceDate  = 2026-07-09
  creationDate             = 1783252909.3339338      <- 2026-07-05 12:01:49, the gesture
  userModificationDate     = 1783252909.337111
  rt1_repeatingTemplate    = VQajVRrDWrfoGptgGpqb8B  <- a true instance of the series
  rt1_instanceCreationCount= 0
  leavesTombstone          = 1

CHANGED template.rt1_instanceCreationCount     : 1 -> 2
CHANGED template.rt1_instanceCreationStartDate : 2026-07-06 -> 2026-07-07
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-06 -> 2026-07-07
CHANGED template.todayIndexReferenceDate       : 2026-07-06 -> 2026-07-07
```

Three readings:

- The rule blob is **byte-untouched** and the template's `userModificationDate` **does not move** — the cursor bookkeeping is `umd`-silent, exactly as it is for a clock spawn and a projection check-off (§9r's discipline).
- The current pending instance (07-05) is **byte-identical**.
- The new row's `creationDate` is the **gesture wall-clock**, not occurrence midnight — a fourth member of REPX1 §1.3's gesture-materialization cohort.

Durable across a +20 s settle and a relaunch (zero delta).

**Then the key question.** The clock was rolled to the ORIGINAL slot:

| guest clock | result |
|---|---|
| **2026-07-06** — the vacated slot | **NOTHING SPAWNS.** The only delta in the whole series is `template.todayIndex: -1589 → 385` (the daily rank recompute). Untrashed series rows dated 2026-07-06: **0** |
| **2026-07-07** — the next slot | spawns normally: a new instance dated 07-07, `creationDate = 1783382400.0` = **exactly 2026-07-07 00:00 UTC** (occurrence midnight), cursor → 07-08, `icCount` 2 → 3 |

So `Make Exception` is a genuine exception: **the occurrence was MOVED, not copied.** The 07-09 row is the 07-06 occurrence, the slot is consumed, and the series resumes its ordinary cadence at the next slot. This is the semantics REPX1 §3.2 proved no *instance* re-date can reach, and it is the semantics [oddities §13](../things-app-oddities.md) says the app needs.

### 1.4 A2 — `Update Rule` rewrites the rule AND re-anchors the cursor

Same gesture, same target date, branch = `Update Rule`, on a fresh series:

```
CHANGED template.rt1_recurrenceRule            : sha256:3b34361cc5aa9175 (627 B) -> sha256:b9a58999d5b4072c (627 B)
CHANGED template.rt1_instanceCreationStartDate : 2026-07-06 -> 2026-07-09
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-06 -> 2026-07-09
CHANGED template.todayIndexReferenceDate       : 2026-07-06 -> 2026-07-09
CHANGED template.userModificationDate          : …
(no instance minted; no other row touched; icCount unchanged at 1)
```

`rsum` reads the rule identically before and after (`tp=0 fu=16 fa=1 ts=0 rc=0 of=[{dy=0}]`) — the 627-byte blob is the same length with different bytes, i.e. the change is the rule's own **start anchor**, a field `rsum` does not surface. The visible consequence is the phase shift: rolling to **2026-07-06 produces zero delta** — the old phase is gone.

**This falsifies REPX1 §4's vocabulary tie.** REPX1 could not press the chooser's button and instead argued by equivalence that "the chooser's *Update Rule* branch, `Items ▸ Repeat ▸ Edit Rule…`, and `things todo reschedule-repeat` are one operation". They are not:

| | rule blob | cursor (`next`) | watermark | `umd` | instances |
|---|---|---|---|---|---|
| `Edit Rule…` / `reschedule-repeat` (REPX1 §4) | rewritten | **unmoved** | unmoved | bumped | untouched |
| chooser `Update Rule` (here) | rewritten | **re-anchored to the chosen date** | re-anchored | bumped | untouched |

Same *class* of write, different *anchoring contract*. Anything reasoning about "the Update Rule branch" must use this measurement, not the equivalence.

### 1.5 A3 — `Cancel`, and the control spawn

Same gesture, branch = `Cancel`: **zero delta** across all 41 columns of both rows; rule, cursor, watermark and count untouched; app alive.

This fixture is then the control A1 needs. Rolling the untouched series to **2026-07-06**:

```
INSERTED row LPKbuW2WBpFehUTWELodje  startDate = 2026-07-06  status = 0
CHANGED template.rt1_instanceCreationCount     : 1 -> 2
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-06 -> 2026-07-07
```

The slot spawns normally on the same clock roll on which A1's vacated slot produced nothing — so A1's silence is the exception's doing, not an artifact of the roll.

---

## 2. Cell B — the chooser for DEADLINE and REMINDER edits

### 2.1 B1 — a deadline edit raises the SAME chooser

`Items ▸ Deadline…` on the projection, `in 15 days` typed (read back as `Mon, Jul 20`), Return: **byte-identical sheet** — same title, same body copy, same three `action-button-N` buttons. Row delta with the chooser open: empty.

**`Make Exception` on a deadline** mints the occurrence at its *own* day and hangs the deadline on it:

```
INSERTED row BT1DtuAY1YbTSxUDvHwdkB
  status      = 0
  start       = 2
  startDate   = 2026-07-06          <- the projection day, UNCHANGED (only the deadline was edited)
  deadline    = 2026-07-20          <- an ordinary deadline COLUMN value
  t2_deadlineOffset = 0             <- NOT the rule's offset encoding
  rt1_repeatingTemplate = W5JPLVHP2JsQXF6Y7vW6vE

CHANGED template.rt1_instanceCreationCount     : 1 -> 2
CHANGED template.rt1_instanceCreationStartDate : 2026-07-06 -> 2026-07-07
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-06 -> 2026-07-07
```

So "an exception deadline" is nothing exotic: **the occurrence is materialized early and given a plain item deadline**, and the slot is consumed exactly as in §1.3. Answering the cell's question directly — it writes neither a `t2_deadlineOffset` nor any template state.

**`Update Rule` on a deadline** writes the deadline-mode template shape instead:

```
CHANGED template.deadline           : None -> 262213760 (4001-01-01)      <- the sentinel
CHANGED template.rt1_recurrenceRule : sha256:3b34361cc5aa9175 (627 B) -> sha256:118ae321569cb8ce (629 B)
CHANGED template.userModificationDate : …
rule after: tp=0 fu=16 fa=1 ts=-14 rc=0 of=[{dy=0}]   next=2026-07-06 (UNCHANGED)
```

`ts=-14` is the 14-day start→deadline offset (07-06 + 14 = 07-20) and `deadline = 4001-01-01` is the sentinel [oddities §8a](../things-app-oddities.md) and [RDLG2](rdlg2-323-recipe-cert.md) §5.5 already describe. Note the asymmetry with §1.4: **`Update Rule` re-anchors the cursor for a WHEN edit and leaves it alone for a DEADLINE edit** — coherent, since a deadline is not a schedule.

### 2.2 B2 — a reminder edit raises a DIFFERENT, two-button chooser

Driving the reminder through the When picker (`6pm` typed, resolving to a `Today · 6:00 PM` row) and committing:

```
=== AXSheet desc=alert id=_NS:91 ===
  AXStaticText val=Repeating To-Do
  AXStaticText val=You’re editing a repeating to-do. Would you like to make a
                   one-time exception? This will not change its repeating rule.
  AXButton     ttl=Make Exception   id=action-button-1
  AXButton     ttl=Cancel           id=action-button-2
```

Different body copy, **no `Update Rule` branch**, and `Cancel` slides to `action-button-2` — so a recipe must address these buttons by TITLE, never by index. `Make Exception`:

```
INSERTED row 4VLxc9t7L7uHvPCGLCEz2M
  status       = 0
  start        = 1                  <- Today
  startDate    = 2026-07-05
  reminderTime = 1207959552         <- 18:00, the ordinary to-do codec (18<<26)
  rt1_repeatingTemplate = FVymTy15osAaxLgPqok8xA

CHANGED template.rt1_instanceCreationCount     : 1 -> 2
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-06 -> 2026-07-07
```

Same slot-consuming materialization; the reminder is a plain `reminderTime` column value on the minted instance. (The series now holds two rows dated 07-05 — the pre-existing pending instance and the exception the user moved onto today. That is the user's own request, not a reconciliation failure.)

### 2.3 B3 — what actually selects the two-button chooser

B2's commit was `Today · 6:00 PM`, which conflates "the edit carries a time" with "the target is the Today bucket". Five fresh series separate them; every arm ends in `Cancel` (all five verified inert, zero delta), so the census is the whole product:

| arm | committed target | buttons | body copy |
|---|---|---|---|
| B3A | `in 4 days` → **Jul 9** (a date) | **3** | "…make a one-time exception, **or update the repeating rule**?" |
| B3B | `today` (bucket, no time) | **2** | "…make a one-time exception? **This will not change its repeating rule.**" |
| B3C | `in 4 days 6pm` → **Jul 9 · 6:00 PM** | **3** | the three-button copy |
| B3D | `today 6pm` (bucket + time) | **2** | the two-button copy |
| B3E | `someday` (bucket) | **2** | the two-button copy |

> **The `Update Rule` branch is offered exactly when the target is a CALENDAR DATE the rule could be re-anchored to.** A list bucket the rule cannot name — `Today`, `Someday` — gets exception-only, with copy that says so. Time-of-day makes no difference.

That is a coherent design rather than an inconsistency, and it is a hard precondition for any op we build: a recipe must read the button set back, not assume three.

---

## 3. Cell C — projection CONTENT edits are silent TEMPLATE edits

The maintainer's report was that title/note/checklist/tag edits on a projection "do not do anything". Measured on one fixture, one edit at a time, full row diff each: **every one of them writes, none of them prompts, and all of them hit the TEMPLATE.**

| edit | how it was driven | chooser? | row delta |
|---|---|---|---|
| **title** | select projection → Return (opens the row editor) → type → Return | **none** (0 containers beyond the menu bar) | `template.title` `REPX2-C-DAILY` → `REPX2-C-DAILY EDITED`; `template.umd` bumped |
| **notes** | Return → Tab into the notes area → type | **none** | `template.notes` `""` → `note-from-projection`; `template.umd` bumped |
| **tag** | `Items ▸ Tags…` → type `Home` → Return | **none** | `template.cachedTags` blob `len0` → `len16`; `template.umd` bumped; **one `TMTaskTag` row, on the TEMPLATE uuid** |
| **checklist** | Return → ⌘⇧C in the open editor → type | **none** | `template.checklistItemsCount` 0 → 2, `openChecklistItemsCount` 0 → 2; **2 `TMChecklistItem` rows**; `template.umd` **NOT** bumped |

On every arm the **materialized current instance is byte-identical** — the diff compared both rows and only the template moved.

Notes on method, so the table is not over-read:
- The checklist count is 2 because the drive typed one title and pressed Return, and the editor opens a fresh empty checklist row on Return; one of the two rows is that trailing empty. The finding is that the write lands on the template at all.
- The notes value carries the trailing newline the commit Return inserted.
- The first pass drove `Items ▸ Add Tags…`, which **does not exist** (`-1728`); its zero delta was a driver failure, not an app measurement. Re-driven correctly as `Items ▸ Tags…` (cell C3B) — the row above is the corrected measurement. The `Tags…` popover is a detached window listing every tag as an `AXUnknown desc=<tag>` row plus a search `AXTextField`; `Move…` is its structural twin (`No Project` + every project/area as rows) and was censused open-and-escape only: **zero delta**.

**Why this matters.** The same row, the same selection, the same menu: a *date* edit stops and asks "exception or rule?", a *title* edit silently answers "rule" and rewrites every future occurrence — while the occurrence the user can actually see in Today keeps the old text, so the edit looks like it did nothing. Filed as [oddities §14](../things-app-oddities.md).

---

## 4. Cell D — JIT chaining, the sanctioned approximation, and undo

### 4.1 D1 — the cursor marches arbitrarily far, with no guard

`REPX2-D1-DAILY`, daily, clock frozen at 2026-07-05. Four consecutive check-offs of whatever projection row is currently rendered:

| click | minted row | template after |
|---|---|---|
| 1 | 2026-07-06, `status=3`, `stopDate` = the click | `next = icStart = 07-07`, `icCount = 2` |
| 2 | 2026-07-07, `status=3` | `next = icStart = 07-08`, `icCount = 3` |
| 3 | 2026-07-08, `status=3` | `next = icStart = 07-09`, `icCount = 4` |
| 4 | 2026-07-09, `status=3` | `next = icStart = 07-10`, `icCount = 5` |

End state — six rows: the pending 07-05 instance (byte-identical throughout), the template, and **four completed instances dated 07-06 … 07-09**, all born at the click wall-clock while the guest clock never left 2026-07-05.

```
CHANGED template.rt1_instanceCreationCount     : 1 -> 5
CHANGED template.rt1_instanceCreationStartDate : 2026-07-06 -> 2026-07-10
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-06 -> 2026-07-10
```

**No guard of any kind** — no horizon, no confirmation, no rate limit. Each click replaces the projection row with the next one, so the gesture is trivially repeatable and a user can walk a daily series years into the future by clicking one screen position. (Each individual step is coherent — that is §6d's craft — but nothing bounds the chain.)

### 4.2 D2 — the sanctioned path is byte-equivalent, and `Create Next Copy` is born at the gesture

Two identically-built fixtures at the same clock:

- **arm X** — one direct projection check-off.
- **arm Y** — `Items ▸ Repeat ▸ Create Next Copy`, then `set status to completed` on the minted row.

Arm Y's two legs:

```
Create Next Copy:
  INSERTED  startDate = 2026-07-06  status = 0  creationDate = 1783252918.5331879
            rt1_repeatingTemplate set;  userModificationDate = NULL (unstamped at birth)
  CHANGED   template  icCount 1 -> 2 ;  next / icStart  07-06 -> 07-07
complete:
  CHANGED   instance.status 0 -> 3 ;  stopDate = 1783252928.10 ;  umd stamped
```

Normalizing away the columns that cannot match across two fixtures by construction (uuid, title, FK, `creationDate`, `umd`, `stopDate`, `index`, `todayIndex`, `cachedTags`), the two final states are compared row by row in creation order:

```
rows: A=3 B=3
VERDICT: BYTE-EQUIVALENT (modulo identity + wall-clock columns) — 31 comparable columns/row, 0 differing
```

So **the direct projection check-off has a fully sanctioned two-step equivalent**: any op we might build could use `Create Next Copy` + `complete` and land the same shape — with the one honest caveat that the intermediate state differs (arm Y is briefly an *open* future instance, which a concurrent viewer or a sync peer can observe, and its `umd` is NULL until the completion leg stamps it).

`creationDate = 1783252918.53` is 2026-07-05 12:01:58 — the gesture, not the 1783296000.0 occurrence midnight. That **closes [REPX1 §7 open cell 2](repx1-instance-semantics.md)** and makes it three of three: projection check-off, bulk `Stop` materialization, and `Create Next Copy` are all born at gesture wall-clock, while only the clock-arrival spawner uses occurrence midnight.

### 4.3 D3 — the app's own ⌘Z is a perfect inverse; ours could not be

After one projection check-off, `Edit ▸ Undo` reports `enabled=true` (the item is a bare "Undo" — no operation name). ⌘Z:

```
DELETED row Y8CqxxEMuETZWL77BDgzJ3                              <- the minted instance is GONE
CHANGED template.rt1_instanceCreationCount     : 2 -> 1
CHANGED template.rt1_instanceCreationStartDate : 2026-07-07 -> 2026-07-06
CHANGED template.rt1_nextInstanceStartDate     : 2026-07-07 -> 2026-07-06
CHANGED template.todayIndexReferenceDate       : 2026-07-07 -> 2026-07-06
```

Net effect versus the pre-gesture snapshot, after a relaunch: **(no field changed on any surviving row)**. The undo is complete — the row is hard-deleted (not trashed), and the cursor, watermark and count all rewind — and it is durable.

**What OUR `things undo` could and could not do, stated honestly.** If a `check-off-projection` (or the §1.3 exception-move) op were ever built, its undo would be strictly weaker than the app's, on two independent walls:

1. **No headless hard-delete of one row.** Single-item permanent delete exists only as an interactive Shortcuts action with no Always-Allow ([oddities §5i](../things-app-oddities.md) / §5j). The best available inverse is `uncomplete` (leaving an **extra open instance** on a day the series never scheduled) or `delete` (leaving a **trashed row** and a tombstone). Neither restores the pre-gesture row set.
2. **No write verb for the cursor.** `rt1_nextInstanceStartDate`, `rt1_instanceCreationStartDate` and `rt1_instanceCreationCount` are written by the app alone; nothing on any official surface moves them backwards (`Pause`/`Resume` clears and re-derives, it does not rewind). So **the cursor stays advanced** whatever we do, and the series has permanently skipped a slot.

The one honest mitigation is that ⌘Z itself is drivable — but only as the app's *own* undo stack, i.e. only if nothing else has been done in the app since, which no audit-trail-based undo can assume. **Any such op must therefore be built irreversible and disclose it**, exactly like `Stop` (REPX1 §5.4) and template delete (SERDEL).

---

## 5. Cell E — the template-`when` crash, re-probed on 3.23

The capability matrix hard-blocks Schedule on repeating templates with "crash". The historical cells: [oddities §1](../things-app-oddities.md) / [§7 C1](../things-app-oddities.md); suites **U12** (`u-suite`, `when=today`), **R09** (`r-suite`, `when=today@18:00`), **A21** (`a-suite`, the AppleScript guard contrast). All three run against the golden's `LAB-REPEAT-DAILY` seed; this cell re-runs their shapes against a **synthetic series built on 3.23**, with `.ips` accounting.

| arm | vector | result |
|---|---|---|
| **E1** | AppleScript `schedule to do id <TEMPLATE> for July 8, 2026` | **guarded** — `Things3 got an error: Cannot schedule to-do (302)`, app alive, `.ips` count unchanged, **zero row delta** |
| **E2** | `things:///update?id=<TEMPLATE>&when=today` | **CRASH** — pid 1450 → gone, `.ips` 0 → 1, signature **`EXC_BREAKPOINT`**, `Things3-2026-07-05-120127.ips` (`app_version 3.23`, `build_version 32300036`). After relaunch: **zero row delta**, template byte-identical |
| **E3** | `things:///update?id=<TEMPLATE>&when=today@18:00` | **CRASH** — pid 1624 → gone, `.ips` 1 → 2. Zero row delta |
| **E4** | `things:///update?id=<TEMPLATE>&deadline=2026-07-20` | **silently dropped** — app alive, zero row delta (oddities §2i, re-confirmed on 3.23) |
| **E5** | `things:///update?id=<INSTANCE>&when=2026-07-09` (control) | **fine** — `start 1→2`, `startDate` 07-05 → 07-09, `todayIndexReferenceDate`, `umd`; no crash |

> **Verdict: NOT fixed.** The crash reproduces on Things 3.23 / build 32300036 exactly as recorded — process death with a Swift runtime trap, no data corruption, and the AppleScript guard still present one surface over. The `H-REPEAT-SCHEDULE` refusal stays; there is **no engine unblock to follow up**. (This also independently re-confirms the U12/R09 suite expectations that the golden-v4 certification recorded as still-crashing, against a template minted under 3.23 rather than a v1-era seed.)

The repeating **PROJECT** twin (§7 C2, `update-project?when=`) was deliberately **not** re-probed: promoting a project to a series needs the repeat-bar popover reveal, itself an uncertified 3.23 cell ([RDLG2](rdlg2-323-recipe-cert.md) §7.3). It stays open.

---

## 6. Cell F — the 3.23 When picker, reminders, and natural-language `when=`

### 6.1 F1 — the reminder affordance is re-shaped, not removed

The maintainer's impression that "an add-reminder checkbox may be gone" is half right — there are two different reminder affordances and neither disappeared:

| surface | 3.23 affordance |
|---|---|
| the **When picker** (`Items ▸ When…`, `WhenPopUpDialog-*`) | a list ROW: `AXUnknown desc="Add Reminder"` with a `Dialog AddAlarm Template` icon, sitting below `Someday`. **No `AXCheckBox` anywhere in the dialog** — that is what changed |
| the **Repeat dialog** (`Items ▸ Repeat ▸ Edit Rule…`) | real checkboxes: `AXCheckBox ttl="Add reminders" val=0` and `AXCheckBox ttl="Add deadlines" val=0` |

A reminder is also reachable in the When picker purely by typing — `6pm` filters the list to `Today · 6:00 PM` / `Tomorrow · 6:00 PM` rows.

Our shipped reminder paths were re-certified on 3.23 in place:

```
F1b  URL update?id=<todo>&when=2026-07-05@18:00
       reminderTime NULL -> 1207959552 (18<<26) ;  start 2->1 ;  startDate -> 2026-07-05 ;  index re-ranked ;  umd
F1c  the RC01/RC02 clear bounce (when=today, then when=2026-07-06)
       reminderTime 1207959552 -> NULL ;  start 1->2 ;  startDate -> 2026-07-06 ;  umd
```

Both land exactly as the suites lock them. Suite rows that already cover this ground, named as the cell asked: **r-suite R01/R02** (dated reminder set), **R17/R18** (undo re-sets the reminder via `when=<date>@<time>`), **R20/R21** (bare same-date `when=` stickiness), **RC01/RC02** (the dated clear bounce), **R09** (the template hazard, §5). Nothing needs re-locking.

### 6.2 F2 — the URL scheme's `when=` accepts natural language

Six `things:///add?title=…&when=<phrase>` calls at a guest clock of **Sunday 2026-07-05**:

| `when=` phrase | `start` | `startDate` | reading |
|---|---|---|---|
| `next thursday` | 2 | **2026-07-16** | the *following* week's Thursday, not the coming one (07-09) |
| `tomorrow` | 2 | 2026-07-06 | ✔ |
| `second tuesday in november` | 2 | **2026-11-10** | ✔ (Nov 2026 Tuesdays: 3, 10, 17, 24) |
| `in 3 days` | 2 | 2026-07-08 | ✔ |
| `july 9` | 2 | 2026-07-09 | ✔ — bare month/day resolves to the coming occurrence |
| `next week` | 2 | 2026-07-12 | the following Sunday (week starts Sunday) |

**6 of 6 parsed**, every one landing `start = 2`, `startBucket = 0`, no spurious reminder. The URL handler is evidently sharing the same natural-language date parser as the When picker (whose filtered rows resolve the identical phrases, §1.2).

This is **undocumented** — the Things URL-scheme documentation specifies `today`, `tomorrow`, `evening`, `anytime`, `someday` and an ISO date — and it is recorded here as evidence for a **future CLI design question only**. Nothing was built, and two properties make it a poor thing to depend on blindly: the resolution is **relative to the device clock and locale**, and `next thursday` demonstrates that the app's reading of a common phrase is not the one many users would predict. Any future surface would want the picker's read-back discipline (§1.2), not blind emission.

---

## 7. What this campaign changes elsewhere

| document | change |
|---|---|
| [things-app-oddities.md](../things-app-oddities.md) §13 | **dated addendum** — the exception the entry says is unreachable IS reachable, on the projection path, with true slot-consuming semantics (§1.3). The body is unchanged and the defect stands; it is *sharpened*, because the app owns the reconciliation it fails to apply to a materialized instance |
| [things-app-oddities.md](../things-app-oddities.md) | **new §14** — content-class edits on a projection silently rewrite the TEMPLATE with no chooser, while the visible current occurrence keeps the old content (§3) |
| [things-app-oddities.md](../things-app-oddities.md) §7 C1 | dated **3.23 re-confirmation** of the URL `when=`-on-a-template crash (§5) |
| [things-app-craft.md](../things-app-craft.md) | **new 6f** (the chooser consumes the slot — a real exception, and its branch set is chosen by what the rule could express) and **new 6g** (⌘Z is a complete inverse of a JIT materialization, cursor included) |
| [capability-matrix.md](../capability-matrix.md) | the Schedule row gains the **exception-move** path as reachable-but-unbuilt with its gaps named, and a **dated 3.23 status** on the template-`when` crash note (§5) |
| [repx1-instance-semantics.md](repx1-instance-semantics.md) §4 | its `Update Rule` ≡ `Edit Rule…` equivalence is **falsified** — the chooser branch re-anchors the cursor, `Edit Rule…` does not (§1.4). Recorded here, not by editing that immutable snapshot |
| [repx1-instance-semantics.md](repx1-instance-semantics.md) §7 | open cell 2 (`Create Next Copy`'s `creationDate`) is **closed** — gesture wall-clock, three of three (§4.2) |
| [rdlg2-323-recipe-cert.md](rdlg2-323-recipe-cert.md) §5.4 / §7 cell 1 | **closed** — the chooser is captured and both branches driven; it never needed the framebuffer rig, only the right target row |

## 8. Open cells this campaign did NOT close

1. **The chooser on a repeating PROJECT template.** Not attempted — the project promote reveal (the repeat-bar popover) is itself uncertified on 3.23 (RDLG2 §7.3), and §7 C5 records a 3.22.11 crash when a stop-repeated project is selected.
2. **An exception on a NON-daily rule.** Every arm here used a daily series, where the watermark and the cursor coincide. On a weekly rule they diverge (REPX1 §2.3); whether `Make Exception` advances both to the next *rule* date or the watermark to spawned-day+1 is unmeasured.
3. **Whether an exception SURVIVES a rule change.** `Update Rule` after a `Make Exception` on the same series was not driven; nor was a second exception on a series that already holds one.
4. **The exception's sync behavior.** All measurements are single-device. Whether a slot consumed on device A suppresses the spawn on device B (which materializes independently — craft §4c) is unknown and is the question any shipped op would most need answered.
5. **`Make Exception` onto an ALREADY-OCCUPIED day.** §2.2 incidentally produced two rows on 07-05 by moving an occurrence onto the pending instance's day; whether the app dedupes at the *next* clock arrival was not rolled forward.
6. **Undo of the chooser branches.** ⌘Z was measured only against a projection check-off (§4.3), not against `Make Exception` or `Update Rule`.
7. **The repeating-PROJECT `when=` crash twin** (§7 C2) on 3.23 (§5).
