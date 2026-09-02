# DEFAULTS1 — the Repeat dialog seeds itself from the row, and the drive can read instead of type

**Probed under: `things-lab-golden-v4` · Things **3.23** (CFBundleVersion **32300036**) · macOS **15.7.7** · DB schema **v27** · guest clock pinned **2026-07-05 12:00 (a Sunday)**, trial wall 2026-07-18, never rolled.** ONE disposable clone of golden-v4 (the golden is never booted), airgapped (default route deleted), guest muted, beep sentinel on in report-only mode (`THINGS_LAB_BEEPS_OK=1`), destroyed at teardown. Fixtures fully synthetic (`DEF1-*`). Immutable snapshot per the [harness](harness.md) version-stamping policy.

Driver: [`lab/scripts/research-defaults1.sh`](../../lab/scripts/research-defaults1.sh) — cells `fresh` · `matrix` · `menus` · `partial` · `remind` · `timing` · `commit` · `baseline`. Artifacts (gitignored): `lab/artifacts/defaults1-lab/` (`report.txt`, one full AX shape dump per state in `ax/`, per-hop traces in `trace/`).

**PROBE ONLY.** No `src/` change is proposed here and none was made; the recipe files were owned by a sibling campaign for the duration. §9 is the recommendation.

> **The maintainer's insight, which this campaign was commissioned to turn into a law.** Observed on Things 3.23.2: *the Repeat dialog pre-fills from the to-do's own state when it opens.* A to-do scheduled for date D, switched to weekly, comes up already saying "every 1 week on D's weekday" with `Next:` = D. If that is a law and not a coincidence, it is worth a great deal to us specifically — because our own CLI **mints the seed** (promote-via-clone, [`src/write/promote-clone.ts`](../../src/write/promote-clone.ts) creates the row by URL with the requested `when`/`deadline` and only then drives the dialog). We control the state the dialog seeds itself from. Every control whose pre-fill is already correct is an actuation that becomes a **read** — and on the maintainer's M1 each of those actuations costs about a second of settles and recompute waits.

---

## 0. Headline

**It is a law, it is broader than the insight supposed, and it lands.**

| | measured |
| --- | --- |
| **What the anchor is** | the dialog's whole cadence row is derived from **one date**: the seed's scheduled date if that date is today or later, else **today**. Weekly takes its weekday, monthly its day-of-month, yearly its month + day-of-month, and `Next:` shows the date itself. |
| **When a deadline is on the seed** | the anchor date becomes the **deadline**, `Add deadlines` comes up **pre-ticked**, and `and start N days earlier` is **pre-filled with (deadline − start)** — including under `after completion`, which the maintainer expected to be exempt. It is not. |
| **When a reminder is on the seed** | `Add reminders` comes up **pre-ticked** and the reminder **survives an untouched commit onto the template row** — for every frequency, after-completion included. |
| **Never pre-filled** | interval > 1 · a multi-weekday set · the ordinal-weekday form of a monthly/yearly anchor ("first Monday", "last Friday") · `last` day-of-month · any `Ends:` bound · the after-completion **unit** for anything but weekly. §8. |
| **Does it LAND?** | **11/11 commit cells green, 0 beeps.** Open → select the frequency → wait out the rebuild → OK, touching nothing else, lands a rule blob byte-equivalent to the one the shipped drive produces by clicking every control. |
| **When is it safe to read?** | the cadence group rebuilds **between t+200 ms and t+300 ms** after the frequency click, and **every value is already final the first instant the control exists** — measured at 100 ms resolution for 3 s, four frequencies, no intermediate value ever observed. §7. |
| **What it is worth** | measured through the shipped CLI with the trace on: a fixed-frequency promote is **16–19 hops / 147–202 round-trips / 59–138 elements** today, and the same rule is expressible in **12 hops / 70–78 round-trips / 26–33 elements**. Carried to the field at RDLAT2's fitted constants: **≈13.8–18.1 s → ≈6.2–6.7 s (−54% to −63%)**. The baseline is v0.20.6; VOPAT2 (#687) landed mid-campaign and had already banked two of the seven steps, leaving DEFAULTS1 an incremental **30–104 round-trips and 33–105 elements** per shape. §9. |

One app-side quirk and one unexplained anomaly fell out on the way (§10), and the campaign cost itself a commit pass to the URLEN1 modal blind spot (§11).

---

## 1. Method, and the one control the whole matrix rests on

Reading a pre-fill is easy to get wrong in two ways, and the design closes both.

**(a) Nothing is touched before it is read.** Each cell opens the dialog, selects a frequency, waits, and then reads *every* control the dialog presents — role, row (y), value — for the shell and for the cadence group, and diffs that census against the one taken at the open. The `Next:` menu's item list is the only read that requires a click, so it is taken **last**, after every value is banked, and the shape is re-audited afterwards (harness [§AX-drive scrutiny](harness.md): re-audit the full dialog shape after every input). Nothing is committed; the dialog is escaped and the seed row re-read to prove it is unchanged.

**(b) One seed serves five frequencies — which is only sound if an escape is clean.** That is the `fresh` cell, and it is the load-bearing control for the entire matrix:

```
open  → SHELL popup 1 = after completion   GROUP popup 1 = week   GROUP field 1 = 1
        select monthly (group rebuilds: 4 pop-ups, Next: = Thu, Jul 9, 2026, day/9th)
        ESCAPE
seed row after the escape: startDate=2026-07-09 start=2 — unchanged, no rule
reopen → byte-identical to the first open
```

`ax/shape-fresh-1-open.txt` and `ax/shape-fresh-3-reopen.txt` are **identical files**. An escaped selection leaves nothing behind: the dialog re-seeds itself from the row every time it opens, so every matrix cell is independent and one fixture per seed state is enough. (This is also the first half of the pre-fill law — the dialog has no memory of its own; whatever it shows, it computed from the row.)

Seeds are minted the way the CLI mints its own: one `things:///add` carrying the requested `when` (and `deadline`, and `@HH:MM` reminder). Ground truth for every commit is read-only guest SQLite via the `rsum.py`/`rfull.py` blob decoders; CLI exit 0 and `open` exit 0 prove nothing on their own.

---

## 2. The dialog's own defaults, before the row gets a say

Every one of the 14 seed states opened on exactly this, byte for byte:

```
SHELL popups=1 fields=0 checkboxes=2 buttons=2 groups=1 statics=1
  SHELL popup 1 = after completion
  SHELL checkbox 1 "Add reminders" = 0
  SHELL checkbox 2 "Add deadlines" = 0
GROUP popups=1 fields=1 buttons=0 checkboxes=0 statics=1
  GROUP popup 1 y=328 = week
  GROUP field 1 y=328 = 1
  GROUP static 1 y=331 = after previous item is checked off.
```

Two things worth naming:

- **The opening default is `after completion, every 1 week`** — not *day*. The after-completion **unit** pop-up defaults to `week` on every seed state measured, deadlined or not, reminder or not. So `--after-completion --frequency weekly` is the one after-completion shape whose unit needs no actuation; the other three still need one.
- **The after-completion state carries no first-occurrence control at all** — no `Next:` pop-up exists to pre-fill, and the per-cell recompute timeline reads `(absent)` at all eight sample instants. Nothing about the seed's *date* reaches an after-completion rule. Its *deadline* and *reminder* do (§4, §5).

---

## 3. THE DEFAULTS LAW — seed state × frequency

14 seed states × 5 frequencies, every cell a fresh dialog opening. The pre-filled controls, exactly as read. `Ends:` is `never` and `Add reminders`/`Add deadlines` are both `0` in every non-deadlined, non-reminder cell, and the interval field is `1` in every cell of the whole matrix — those four are omitted from the table and stated once here.

### 3.1 The anchor date

| seed | URL `when` | seed row `startDate` | **the date every control is derived from** |
| --- | --- | --- | --- |
| S1 | `today` | 2026-07-05 | **today** (displayed `Today`) |
| S2 | `tomorrow` | 2026-07-06 | 2026-07-06 |
| S3 | `2026-07-09` (a Thursday) | 2026-07-09 | 2026-07-09 |
| S4 | `2026-11-19` (months out) | 2026-11-19 | 2026-11-19 |
| S5 | *(none — Inbox)* | NULL | **today** |
| S6 | `someday` | NULL | **today** |
| S7 | `evening` | 2026-07-05 | **today** |
| S8 | `2026-06-20` (a past date) | **2026-07-05** | **today** — see the note below |
| S9 | `2026-08-31` (a 31st) | 2026-08-31 | 2026-08-31 |
| S14 | `anytime` | NULL | **today** |

> **The "overdue seed" cell measured the URL scheme, not the dialog.** `things:///add?when=2026-06-20` on a clock pinned to 2026-07-05 stored `startDate = 2026-07-05`: the app **clamps a past `when` to today** at creation. The same happened to `PFEB` (`when=2026-02-28`). So an overdue seed is not a state this seeding route can produce at all, and the dialog was never asked the question. What *is* established is the fallback: **every seed with no usable future date — Inbox, Someday, Anytime, this evening, today — anchors the dialog on today**, which is the same answer an overdue row would need.

### 3.2 The cadence row, per frequency

Writing **D** for the anchor date of §3.1:

| frequency | pre-filled controls | S3 (`2026-07-09`, a Thursday) | S1/S5/S6/S7/S8/S14 (anchor = today, Sunday 07-05) | S9 (`2026-08-31`, a Monday) |
| --- | --- | --- | --- | --- |
| **after completion** | unit, interval | `week`, `1` — nothing from D | `week`, `1` | `week`, `1` |
| **daily** | `Next:` | `Thu, Jul 9, 2026` | `Today` | `Mon, Aug 31, 2026` |
| **weekly** | `Next:`, **weekday = D's weekday** | `Thu, Jul 9, 2026` · `Thursday` | `Today` · `Sunday` | `Mon, Aug 31, 2026` · `Monday` |
| **monthly** | `Next:`, mode = `day`, **ordinal = D's day-of-month** | `Thu, Jul 9, 2026` · `day` · `9th` | `Today` · `day` · `5th` | `Mon, Aug 31, 2026` · `day` · `31st` |
| **yearly** | `Next:`, **month = D's month**, mode = `day`, **ordinal = D's day-of-month** | `Thu, Jul 9, 2026` · `July` · `day` · `9th` | `Today` · `July` · `day` · `5th` | `Mon, Aug 31, 2026` · `August` · `day` · `31st` |

The occurrence-preview static agrees with the pre-fill in every cell and is the app's own confirmation of it — S3 monthly reads `,  8/9/26,  9/9/26,  10/9/26,  11/9/26, …`; S1 weekly reads `,  7/12/26,  7/19/26,  7/26/26,  8/2/26, …`.

**LAW (DEFAULTS1-1).** *The Repeat dialog derives its entire cadence row from one date — `max(the row's scheduled date, today)` — recomputed on every frequency change, with the interval fixed at 1 and `Ends:` fixed at `never`.*

**LAW (DEFAULTS1-2).** *The monthly and yearly anchor is always the day-of-month form (`day` + Nth). The ordinal-weekday form is never pre-filled, whatever weekday the anchor date happens to be.* §6 measures this against seeds chosen to be exactly a "first Monday" and a "last Friday".

---

## 4. Deadlines — pre-filled, offset and all, after-completion included

| seed | URL | seed row | `Add deadlines` | `and start N days earlier` | anchor the cadence row used |
| --- | --- | --- | ---: | ---: | --- |
| S10 | `when=2026-07-09 deadline=2026-07-09` | sd 07-09, dl 07-09 | **1** | **0** | `Thu, Jul 9, 2026` · weekly `Thursday` · monthly `9th` |
| S11 | `when=2026-07-09 deadline=2026-07-12` | sd 07-09, dl 07-12 | **1** | **3** | **`Sun, Jul 12, 2026`** · weekly **`Sunday`** · monthly **`12th`** · yearly `July`/`12th` |
| S12 | `when=2026-07-09 deadline=2026-07-06` | sd 07-09, dl 07-06 | **1** | **0** | `Thu, Jul 9, 2026` · weekly `Thursday` · monthly `9th` |
| S13 | `deadline=2026-07-16`, no `when` | sd NULL, dl 07-16 | **1** | 11 (6 under after-completion) | `Sat, Jul 18, 2026` — **anomalous, §10.3** |

**S11 is the cell that matters, and it is emphatic.** With a 3-day gap between start and due, *everything* the dialog pre-fills is derived from the **deadline**, not the start: `Next:` is Jul 12, the weekly weekday is Jul 12's Sunday, the monthly day is the 12th. That is exactly the geometry the shipped recipe implements by hand — [YANCH1 #493](yanch1-derived-anchor.md) / [NEXTPOP1](nextpop1-deadlined-promote.md): *a deadlined rule anchors the dialog on the DUE date and the app back-shifts each occurrence's start by N*, with `of=` holding the due date and `next`/`icStart` the requested start. The app computes the same shift from the seed row, for free, in one step.

**After completion is not an exception.** S11's after-completion cell reads `Add deadlines = 1` with the offset field at `3`, and the `ACD` commit cell lands `tp=1 … ts=-3`. This corrects the expectation the campaign was briefed with, and it agrees with [CNCAC2](cncac2-deadline-lift.md), which already removed the same belief from the shipped mapping: an after-completion occurrence has a start, and the offset is measured from it like any other.

**A negative offset is silently flattened.** S12 asks for a deadline three days *before* the start. The dialog ticks `Add deadlines` and shows `0` — not `-3`, not an empty field, and no refusal. The deadline date is simply discarded and replaced by the occurrence's own start. Recorded as an app quirk in §10.2.

---

## 5. Reminders — pre-ticked, and they ride the row rather than the rule

Seeds minted as `things:///add?when=2026-07-09@09:30` (`reminderTime = 635437056` on the row).

| seed | frequency | `Add reminders` | shell date areas | reminder time read back |
| --- | --- | ---: | ---: | --- |
| RM1 | after completion | **1** | 1 (y=387) | *(empty through AX — see below)* |
| RM1 | weekly | **1** | 1 (y=417) | *(empty)* |
| RM1 | monthly | **1** | 1 (y=417) | *(empty)* |
| RM2 (`today@18:00`) | all three | **1** | 1 | *(empty)* |

The checkbox is pre-ticked and the reminder's `AXDateTimeArea` is minted with it — exactly the control [RDLG2 §1.3](rdlg2-323-recipe-cert.md) describes appearing when the box is checked by hand. Its **value reads empty** through `value of <element> as text`; this is a limitation of the census, not evidence that the field is blank, and the commit cells settle the question from the other side:

```
CRM3  weekly, defaults accepted untouched
      rule: tp=0 fu=256 fa=1 ts=0 of=[{wd=4}] next=2026-07-09
      row:  reminderTime=635437056          <- the seed's 09:30, intact
CRM4  after completion, defaults accepted untouched
      rule: tp=1 fu=256 fa=1 ts=0 of=[]  next=2026-07-09
      row:  reminderTime=635437056          <- likewise
```

**LAW (DEFAULTS1-3).** *A reminder lives in the row's own `reminderTime` column, not in the recurrence blob, and a promote carries it onto the template untouched. A seed minted with `when=<date>@<HH:MM>` therefore needs **no dialog actuation at all** for its reminder — the two steps the shipped recipe spends on it (`ensure-checkbox "Add reminders"` + `set-datetime reminder`) have nothing left to do.*

Neither reminder template had materialized an instance yet (both are future-dated), so whether each spawned occurrence inherits the time is not settled here; [CNCAC1 §9](cncac1-after-completion-checkoff.md) is the standing evidence that derived fields do reach the mints.

---

## 6. Partial pre-fill — how close a seed date gets to a shape it cannot express

The seed date can express `day N` and `weekday W`. It cannot express `last`, an ordinal weekday, a multi-weekday set, an interval, or an `Ends:` bound. But it can get *close*, and the value of the pre-fill for those shapes is the actuations it removes from the remainder. Each seed below was chosen to be exactly the kind of date the shape is named after.

| seed | the shape it looks like | what the dialog actually pre-fills (monthly) | occurrence preview |
| --- | --- | --- | --- |
| `2026-08-31` (Mon, the 31st, last day of August, its 5th Monday) | "last day of the month" / "5th Monday" | `day` · **`31st`** | `9/30/26, 10/31/26, 11/30/26, 12/31/26` |
| `2026-09-30` (Wed, last day of September) | "last day of the month" | `day` · **`30th`** | `10/30/26, 11/30/26, 12/30/26, 1/30/27` |
| `2026-08-03` (the **first Monday** of August 2026) | "first Monday" | `day` · **`3rd`** | `9/3/26, 10/3/26, 11/3/26, 12/3/26` |
| `2026-08-28` (the **last Friday** of August 2026) | "last Friday" | `day` · **`28th`** | `9/28/26, 10/28/26, 11/28/26, 12/28/26` |

Three findings, and the third is the useful one:

1. **`day 31` is not `last`, but the app clamps it.** A 31st seed pre-fills the literal `31st` and lands `of=[{dy=30}]` (0-indexed — the 31st), yet the app's own preview steps `9/30, 10/31, 11/30, 12/31`: a day-31 rule falls back to the month's last day where the month is shorter. So `31st` and `last` coincide for every month with 31 days and differ nowhere in 2026's preview — but they are **different rules**, and only `last` is stable for a 30-day month. The distinction matters and the pre-fill does not make it.
2. **`day 30` really is day 30** (`10/30/26` in a 31-day October), so there is no "near the end of the month means last" heuristic. Clamping is clamping.
3. **The ordinal-weekday form is never reached by inference.** A seed *on* the first Monday pre-fills `3rd`, not `Monday`/`1st`. Confirms DEFAULTS1-2 from the side that could have falsified it.

### The conversion vocabulary — what a residual actuation actually costs

A residual-actuation count is only meaningful against the menu the actuation must walk, so the `menus` cell dumped every pop-up's full item list at the settled default state (one pop-up at a time, with a shape re-audit after each — the walk left the dialog unchanged in all five states):

| pop-up | items | note |
| --- | --- | --- |
| shell frequency | 6: `after completion` · (sep) · `daily` · `weekly` · `monthly` · `yearly` | |
| after-completion unit | 4: `day` · `week` · `month` · `year` | default `week` |
| `Ends:` | 3: `never` · `after` · `on date` | default `never` |
| `Next:` | 17: `Today` + 15 of the rule's own occurrences + (sep) + `More…` | a bounded menu ([RDLG2 §1.1](rdlg2-323-recipe-cert.md), [NEXTPOP1 §1](nextpop1-deadlined-promote.md)) |
| weekly weekday | 7: `Sunday`…`Saturday` | one row; more rows are inserted at the front ([RDLG2 §1.2](rdlg2-323-recipe-cert.md)) |
| monthly/yearly **mode** | 9: `day` · (sep) · `Sunday`…`Saturday` | switching off `day` is what selects the ordinal-weekday form |
| monthly/yearly **ordinal** | 33: **`last`** · (sep) · `1st`…`31st` | `last` is item 1 |
| yearly month | 12: `January`…`December` | |

So each residual is a single pop-up selection against a menu that already contains the target — no typing, no growth, no geometry. The residual sets fall out directly:

| rule shape the CLI supports | closest seedable default | residual actuations | which controls |
| --- | --- | ---: | --- |
| single weekday, interval 1 | seed on that weekday | **0** | — |
| day-of-month N, interval 1 | seed on the Nth | **0** | — |
| yearly month+day, interval 1 | seed on that month/day | **0** | — |
| daily, interval 1 | any future seed | **0** | — |
| after completion, every 1 **week** | any seed | **0** | — |
| after completion, every 1 day/month/year | any seed | **1** | the unit pop-up |
| **last day of the month** | seed on that month's last day → `day`/`31st` (or `30th`) | **1** | the ordinal pop-up → `last` |
| **ordinal weekday** ("first Monday", "last Friday") | seed on that date → `day`/`Nth` | **2** | mode → the weekday, ordinal → `1st`…`5th`/`last` |
| **multi-weekday** {Mon, Thu} | seed on one of them → that weekday in row 1 | **1 converge** (grow + assign, unchanged) | the weekday converge |
| **interval > 1** | — (always pre-fills 1) | **1** | the interval field (a typing step) |
| **ends after N** | — (always `never`) | **2** | the `Ends:` pop-up + the count field |
| **ends on date** | — (always `never`) | **2** | the `Ends:` pop-up + the date area |
| **deadline offset** | seed carrying the deadline → box ticked + offset filled | **0** | — (but see §9.3 — this one is a design decision, not a free lunch) |
| **reminder** | seed minted `when=<date>@<HH:MM>` | **0** | — |
| **off-rule first occurrence** | — | *inexpressible on 3.23* | the affordance is gone ([RDLG2 §1.1](rdlg2-323-recipe-cert.md)) |

---

## 7. When is the pre-fill complete?

A recipe that replaces an actuation with a read is only correct if it reads *after* the pre-fill. [NEXTPOP1 §2](nextpop1-deadlined-promote.md) is the cautionary tale in the other direction: the `Next:` control recomputes ~0.4 s after a calendar anchor moves, and an **input** inside that window cancels the recompute permanently. So the timing was measured directly — one frequency click, then the cadence group's shape and the `Next:` pop-up's value sampled every 100 ms for 3 s (reads only; no input):

```
weekly    t+100ms popups=1 fields=1 statics=1 Next=(absent)     <- still the after-completion group
          t+200ms popups=1 fields=1 statics=1 Next=(absent)
          t+300ms popups=3 fields=1 statics=7 Next=Thu, Jul 9, 2026
          t+400ms … t+3000ms  identical, all 28 further samples
monthly   t+300ms popups=4 … Next=Thu, Jul 9, 2026   (t+100/200 absent)
yearly    t+300ms popups=5 … Next=Thu, Jul 9, 2026   (t+100/200 absent)
daily     t+300ms popups=2 … Next=Thu, Jul 9, 2026   (t+100/200 absent)
```

**LAW (DEFAULTS1-4).** *The rebuild is atomic with respect to the pre-fill. The cadence group's new children appear between t+200 ms and t+300 ms after the frequency click, and every value they carry is already final the first instant the control exists.* Across 4 frequencies × 30 samples, plus the 8-point timeline every one of the 70 matrix cells carries, **no intermediate or stale value was ever observed** — the control is either absent or correct.

This is a strictly easier gate than the one the shipped drive needs today. `settle-occurrences` exists to watch a value **move** after an anchor change, and it costs 1.6–1.7 s of wall time per drive because it must wait out a recompute it provoked. A verify-by-read recipe provokes no anchor change at all: it waits for the rebuilt group to **exist** — which is precisely what the shipped `probe-dialog-shape` step already does, and what [RDLAT2 §E.4](rdlat2-repeat-dialog-latency.md) taught the cadence settle to wait for. The wait is the shape assertion; there is no second thing to wait for.

The `Next:` pop-up's *menu* is likewise already the new rule's own occurrence series at the first read (§3.2's previews and the menu dumps in §6 agree), so a read of the displayed value needs no menu open to confirm it.

---

## 8. The negative space — what a minimal recipe must still drive

Measured as absences across all 70 matrix cells, not inferred:

- **Interval is always `1`.** Never anything else, on any seed state, under any frequency, including after-completion. `--interval 3` remains a typing step. (And it is a genuinely expensive one: 44 round-trips / 33 elements / 1.2 s in the trace.)
- **`Ends:` is always `never`.** No seed property produces `after N` or `on date`; nothing in a to-do row expresses a series bound.
- **A weekday set is always exactly one row** — the anchor's own weekday. `--weekdays monday,thursday` still needs the converge.
- **The monthly/yearly mode is always `day`.** No ordinal-weekday inference (§6).
- **`last` is never selected.** Only the literal day-of-month.
- **The after-completion unit is always `week`.** Three of the four after-completion frequencies still need it driven.
- **The after-completion state has no `Next:` control**, so the anchor date reaches an after-completion rule not at all — only the deadline offset and the reminder do.
- **No seed property reaches the reminder *time* through a control we can read** (§5); the time rides the row.
- **Nothing is pre-filled from a *past* date**, because the URL scheme will not create such a row (§3.1).

---

## 9. §Recommendation — the minimal recipe, per rule shape

### 9.1 The before-numbers, measured

RDLAT2 §5 counted the field's own `--after-completion` shape. The shapes this recommendation acts on are the **anchor-bearing** ones, which nothing has traced until now — so the `baseline` cell ran the shipped CLI (v0.20.6, `THINGS_API_TRACE=1 THINGS_API_AX_COUNT=1`, `helpers-enabled false`) against seeds this driver minted, one arm per shape, and every arm landed the correct rule with 0 beeps:

| arm | command (`things todo make-repeating <seed>`) | hops | round-trips | elements | clone elapsed |
| --- | --- | ---: | ---: | ---: | ---: |
| **B0** | `--frequency monthly --interval 1 --after-completion` | 13 | 100 | 34 | 3,448 ms |
| **BW** | `--when 2026-07-09 --frequency weekly --interval 1` | 16 | 147 | 59 | 6,174 ms |
| **BM** | `--when 2026-07-09 --frequency monthly --interval 1` | 17 | 168 | 102 | 6,767 ms |
| **BY** | `--when 2026-07-09 --frequency yearly --interval 1` | 18 | 189 | 119 | 7,498 ms |
| **BWD** | `--when 2026-07-09 --deadline --start-days-earlier 3 --frequency weekly --interval 1` | 18 | 195 | 94 | 8,234 ms |
| **BMD** | `--when 2026-07-09 --deadline --start-days-earlier 3 --frequency monthly --interval 1` | 19 | 202 | 138 | 6,763 ms |
| **BM3** | `--when 2026-07-09 --frequency monthly --interval 3` | 17 | 173 | 102 | 6,939 ms |

> B0 reads **100** round-trips where RDLAT2 §5 measured **88** for the same command. The delta is the group-rebuild wait shipped in v0.20.6 ([RDLAT2 §E.4](rdlat2-repeat-dialog-latency.md), #686) — the interval hop went 24 → 29 round-trips and gained the labels wait — plus the AC-unit hop. The element count is unchanged at **34**, exactly as that campaign reported. The two campaigns' numbers are consistent; B0 is the honest baseline for the current bundle.

**The single most striking line in the whole trace.** `set-group-number  interval = 1` costs **39 round-trips, 33 elements and ~1.03 s** on every anchor-bearing drive — and it **types nothing**. The value is already `1` (the read-back-first skip fires, [RDLAT2 §E.5](rdlat2-repeat-dialog-latency.md)'s 0.3 s UIC7 gate included). It is the most expensive hop in the drive and it exists to confirm a default the dialog was never going to get wrong.

> **The baseline is v0.20.6, and VOPAT2 landed on `main` while this campaign was in the VM — read the two together.** [VOPAT2 (#687)](vopat1-screen-reader-pattern.md) shipped notification-driven settles, and in doing so it reached the same derivation from the other end: two of its three field-reported fixes are *"the ~1.5 s stall before `Next:` — a settle that started after the recompute had finished"* (1,656 ms → no hop and no read) and *"the drive opening the `Next:` menu to select the value already shown — **the DEFAULT case, since make-repeating derives the first occurrence from the item's own scheduled date**"* (893 → 79 ms). So the `settle-occurrences` and `select-next-occurrence` rows below are **already banked**, and the field-wall column's *before* numbers are stale by that much. What VOPAT2 changed is **when the drive waits**; what it did not change is **which controls the drive writes** — so every round-trip and element figure for the other five steps stands, and DEFAULTS1's contribution on top of the shipped bundle is:
>
> | shape | incremental hops removed | incremental round-trips | incremental elements | (what VOPAT2 already had) |
> | --- | ---: | ---: | ---: | --- |
> | weekly | 2 | **48** | **33** | settle-occurrences + select-next (29 rt) |
> | monthly day-N | 3 | **69** | **75** | " (29 rt) |
> | yearly | 4 | **88** | **89** | " (29 rt) |
> | weekly + deadline | 4 | **88** | **62** | " (29 rt) |
> | monthly + deadline | 5 | **104** | **105** | " (20 rt) |
> | monthly, interval 3 | 2 | **30** | **42** | " (29 rt) |
>
> The two campaigns are complementary in exactly the way §9.5 describes, and the first step of any implementation is to **re-trace the `baseline` cell on the post-#687 bundle** — the driver's `baseline` cell is written to be re-run as-is.

### 9.2 The minimal recipe

The transformation is small and local: **for each setter, if the rule's requested value equals what the pre-fill will hold, emit no setter.** Nothing about the drive's safety posture changes, because the value is still *verified* — the pre-commit audit ([CGRD1](cgrd1-precommit-audit.md)) already reads every control the recipe cares about and refuses fail-closed on a mismatch, and it reads a pre-filled control at exactly the same cost as a driven one. What goes away is the *writing*, and the settle each write pays for.

| step | today | minimal recipe |
| --- | --- | --- |
| preamble, eligibility, `Items ▸ Repeat…`, `dialog-open` | 9 hops, 23 round-trips | **unchanged** |
| `select-popup frequency` | 1 hop, 11 round-trips | **unchanged** — the one actuation that must happen |
| `probe-dialog-shape` | 1 hop, 15 round-trips | **unchanged**, and it doubles as the rebuild gate (§7) |
| `set-group-number interval` | 39 round-trips, 33 elements | **dropped when `interval === 1`** → verify-by-read |
| `converge-weekdays` (single weekday) | 9–14 round-trips | **dropped when the set is exactly the anchor's weekday** |
| `select-popup` monthly/yearly mode + ordinal | 30–38 round-trips, 42 elements | **dropped when the anchor is `day N` and N is the seed's day-of-month** |
| `select-popup` yearly month | 11 round-trips | **dropped when it is the seed's month** |
| `settle-occurrences` | 7–16 round-trips, **1.6–1.7 s** | **dropped** — nothing provoked a recompute (§7) |
| `select-next-occurrence` | 13 round-trips, **0.9–1.0 s** | **dropped when `next` equals the anchor date** |
| `ensure-checkbox "Add deadlines"` + `set-row-field` offset | 35 round-trips, 30 elements | **dropped iff the seed carries the deadline** — §9.3 |
| `ensure-checkbox "Add reminders"` + `set-datetime` | (not in these arms) | **dropped** — the seed's `reminderTime` already carries it (§5) |
| `audit-dialog` + OK | 21–29 round-trips | **unchanged** — the verification, and it commits |

Keeping every guard, the arithmetic (RDLAT2's fitted field constants: `S_field ≈ 124 ms` per hop, `C_field ≈ 47 ms` per round-trip, the host-independent remainder carried over minus the dropped hops' own in-script settles, plus a 300 ms rebuild gate):

| shape | hops | round-trips | elements | clone | **field (fitted)** |
| --- | --- | --- | --- | --- | --- |
| weekly, interval 1 | 16 → **12** | 147 → **70** (−53%) | 59 → **26** (−56%) | 6,174 → 2,519 ms | 13,793 → **6,410 ms (−54%)** |
| monthly day-N, interval 1 | 17 → **12** | 168 → **70** (−59%) | 102 → **27** (−74%) | 6,767 → 2,343 ms | 15,397 → **6,234 ms (−60%)** |
| yearly month+day, interval 1 | 18 → **12** | 189 → **72** (−62%) | 119 → **30** (−75%) | 7,498 → 2,298 ms | 17,139 → **6,280 ms (−63%)** |
| after completion, weekly | 13 → **11** | 100 → **52** (−48%) | 34 → **13** (−62%) | — | 8,758 → **5,421 ms (−38%)** |
| after completion, other units | 13 → **12** | 100 → **71** (−29%) | 34 → **17** (−50%) | 3,448 → 3,037 ms | 8,758 → **6,973 ms (−20%)** |
| monthly, **interval 3** | 17 → **13** | 173 → **114** (−35%) | 102 → **60** (−42%) | 6,939 → 3,629 ms | 15,795 → **9,573 ms (−39%)** |

**The insight's own claim, checked: it does roughly halve the drive.** For the three single-day cadences it is −54% to −63% of predicted field wall, and −53% to −62% of round-trips. The element term — the one [RDLAT2 §E](rdlat2-repeat-dialog-latency.md) measured independently on the maintainer's M1 — falls by 56–75%, which matters more than the round-trip figure if the sheet turns out to realize like the sidebar.

### 9.3 Deadlined rules — three options, and the one worth taking

The deadline pre-fill is the largest single win available and the only one that needs a **seed-shaping decision**, because [`mapDeadlineOntoRule`](../../src/write/promote-clone.ts) deliberately keeps the seed **deadline-free**: a to-do seed carrying a deadline is SRCFATE-**preserved** as a materialized instance which then double-books the template cursor ([DBLSPAWN1](dblspawn1-preserved-instance.md) cell C). Exploiting §4 means revisiting that.

| option | seed shaping | residual actuations | field (fitted), weekly / monthly |
| --- | --- | --- | --- |
| **A** — seed carries the deadline | `add?when=<start>&deadline=<due>` | **0** | 18,147 → **6,654 ms (−63%)** / 17,053 → **6,545 ms (−62%)** |
| **B** — seed scheduled ON the due date, no seed deadline | `add?when=<due>` | **2** (the checkbox + the offset field) | 18,147 → **9,660 ms (−47%)** / 17,053 → **9,536 ms (−44%)** |
| **C** — seed unchanged | today's shaping | **1** dropped (interval only) | 18,147 → **15,505 ms (−15%)** / 17,053 → **14,433 ms (−15%)** |

**Option B is the recommendation.** It takes 44–47% with **no change to the DBLSPAWN1 invariant at all** — the seed still carries no deadline, so no preserve trigger is armed — and it needs only that the seed's `when` be the date the dialog must anchor on, which the compile already computes (`driveIso = when + startDaysEarlier`, [`promote-clone.ts`](../../src/write/promote-clone.ts) and NEXTPOP1 §3(b)). The landed `next`/`icStart` still hold the requested START, because the app back-shifts by N — proven by the `CWD`/`CMD` commit cells and by NEXTPOP1's own 8/8. Two hazards to name: the seed row is briefly scheduled on the due date rather than the start (invisible unless the promote fails, and the failure path auto-trashes the seed), and an off-rule first occurrence remains inexpressible either way.

**Option A is worth measuring but not worth adopting on this evidence.** The `commit` cells did put a deadlined seed through an in-place dialog promote, and the post-commit row census found **exactly one row per fixture — the template, carrying the `4001-01-01` per-occurrence deadline sentinel — with no preserved instance and `icCount=0`**:

```
DEF1-CWD2  | PbNLLuXH5BZoBpz3QB8VmF | rule=YES | tmpl=- | sd=NULL | dl=4001-01-01 | trashed=0
DEF1-CMD2  | UhSFYDck8msRJnkaU7WjGa | rule=YES | tmpl=- | sd=NULL | dl=4001-01-01 | trashed=0
DEF1-CACD2 | VMETN7xz4LFBSSWHUjuTRj | rule=YES | tmpl=- | sd=NULL | dl=4001-01-01 | trashed=0
```

(By contrast the two seeds anchored on **today** — `CWT2`, `CWN2` — each left a template *plus* one materialized instance dated 2026-07-05, which is ordinary first-occurrence spawning, not a double-booking.) That is suggestive and it is **not** a DBLSPAWN1 re-certification: this drive is raw AX, not the shipped composite, and DBLSPAWN1's cell C was measured on a different path. Adopting A requires re-running the DBLSPAWN1 matrix through the CLI with a deadlined seed. Until then B gets most of the win for none of the risk.

### 9.4 Seed-shaping requirements, and the hazard beside each

For each default to be *right*, the seed the CLI mints must satisfy:

| default relied on | requirement on the seed | hazard if it is not met |
| --- | --- | --- |
| `Next:` = the requested first occurrence | seed `when` **equals** the requested first occurrence (the due date for a deadlined rule), and is **today or later** | a past `when` is clamped to today by the URL scheme (§3.1), so the anchor silently becomes today — **keep the actuation whenever the requested date is not strictly in the future** |
| weekly weekday | the requested weekday **is** the seed date's weekday | otherwise the converge must run (and must run anyway for a multi-weekday set) |
| monthly `day N` | the requested N **is** the seed date's day-of-month | a mismatch, or a `last` / ordinal-weekday anchor, keeps both pop-up actuations |
| yearly month + day | both **are** the seed date's | as above |
| interval | requested interval **is 1** | any other interval keeps the typing step |
| deadline offset | option A: seed carries the deadline · option B: seed `when` = the due date | option C keeps both deadline actuations |
| reminder | seed minted `when=<date>@<HH:MM>` | a reminder added after the promote keeps both actuations |
| a seed with **no** usable date | — | the anchor falls back to **today**; a series that must not start today keeps the `Next:` actuation |

**The rule for the implementation, stated once:** a default may be *relied on* only where the seed's own shape makes it provable arithmetically before the drive starts — the CLI knows the seed's `when`, so it can compute the expected pre-fill exactly. Everything else keeps its actuation. And because the pre-commit audit reads every control regardless, a pre-fill that is somehow *not* what the arithmetic predicted is caught fail-closed before the commit, not after — the fail direction is unchanged.

### 9.5 What this does not touch

- **`reschedule-repeat` opens pre-populated**, not on the after-completion default, so none of §3 applies to it. Its dialog is seeded from the *existing rule*; that is a different (and probably equally interesting) question this campaign did not ask.
- **Projects.** `project.make-repeating` drives the same sheet, and §3's law should hold, but every cell here is a to-do.
- **The `Next:` menu's bounded-ness.** Off-rule first occurrences remain unreachable on 3.23 ([RDLG2 §1.1](rdlg2-323-recipe-cert.md), oddities §11); reading a pre-fill does not change that.
- **The observer redesign, which has now shipped.** [VOPAT1 §4](vopat1-screen-reader-pattern.md) predicted `make-repeating ≈ 2.2 s` with notification-driven settles and VOPAT2 (#687) built it. That and this are **multiplicative, not competing**: VOPAT2 removes the cost of *waiting and polling*, DEFAULTS1 removes the *steps* that wait. They already overlap on two hops (see the note above §9.2) and are disjoint on the other five, which are all writes rather than waits — a step that is never emitted needs no settle, however cheap the settle became.

---

## 10. App behavior worth recording

### 10.1 The pre-fill itself (craft)

Recorded in [things-app-craft.md](../things-app-craft.md). The dialog computes an entire consistent cadence — frequency-appropriate anchor, first occurrence, deadline offset, reminder — from one date on the row, recomputes it atomically on every frequency change (§7), and shows its work in the occurrence preview. It is the difference between a dialog that asks you eight questions and one that answers seven of them and lets you check.

### 10.2 A deadline before the start is silently flattened to a zero offset

`things:///add?when=2026-07-09&deadline=2026-07-06` stores both dates. The Repeat dialog then ticks `Add deadlines` and pre-fills `and start 0 days earlier` — discarding the deadline date and substituting the occurrence's own start, with no refusal and no visible sign that the number it is showing is not the one the row holds. A user who accepts the defaults gets "due on the day it starts" for a to-do whose deadline was three days before its start. Recorded in [things-app-oddities.md](../things-app-oddities.md). (Our own CLI cannot produce the request — `mapDeadlineOntoRule` refuses `--deadline` before `--when` outright — so this is the app's own contradiction handling, adjacent to [DACON1](dacon1-deadline-contradiction.md).)

### 10.3 A deadline with no scheduled date pre-fills an anchor and an offset that agree with neither

S13 (`deadline=2026-07-16`, no `when`, clock at 2026-07-05) pre-fills, for every fixed frequency, `Next: = Sat, Jul 18, 2026` and `and start 11 days earlier` — and under after-completion, an offset of `6`. The `Next:` menu for that state opens on `Thu, Jul 16, 2026` as item [1] (with no `Today` item at all) while the *selected* value is item [3], Jul 18. `Next − offset = Jul 7`, which is neither the deadline (Jul 16) nor today (Jul 5); the offset 11 *is* `deadline − today`, and the internal arithmetic is at least self-consistent, but no reading of the row explains Jul 18 or the after-completion 6. **Unexplained.** Recorded in oddities as a low-severity curiosity rather than a law: the state is one our CLI can never produce (`mapDeadlineOntoRule` requires a concrete `--when` for any deadline), and it was measured once per frequency on one clone.

---

## 11. Two rig lessons

### 11.1 An empty `things:///show?id=` poisons the whole clone — the [URLEN1](urlen1-url-enable.md) blind spot, live

The first `commit` pass reported `FAIL: no dialog` for **all eleven arms**, having minted every seed correctly. The cause was two cells earlier: one fixture's `mkseed` read back an empty uuid, `select_item` dispatched `things:///show?id=` with it, and Things raised a modal error sheet — *"Cannot show the list with ID "" because it does not exist."* — on the Upcoming window. That sheet then swallowed every subsequent `Items ▸ Repeat…` press, silently, for the rest of the run. It was invisible to the driver because the driver asked "did a dialog open?" and a stray sheet is not a dialog; it was invisible to a window census for the reason [URLEN1](urlen1-url-enable.md) already records — **a sheet hangs off a window, so `AXChildren` of the application element never lists it.**

Three guards now in the driver, and all three are worth lifting into any driver that reveals rows:

1. **`select_item` refuses an empty uuid** rather than dispatching the reveal.
2. **`mkseed` retries the read-back** and fails loudly instead of returning empty.
3. **`dismiss_alerts`** walks every window's sheets, discriminates the Repeat dialog **positively** (it has a group and a pop-up) from an alert, presses the alert's own button, and reports what it dismissed — never a blind escape, which would tear down the dialog a cell is driving. `openrepeat` now runs it first and, on failure, prints a per-window sheet census instead of "no dialog".

The re-run with those guards: **11/11 commit arms green, 0 beeps.**

### 11.2 One unexplained seeding anomaly, recorded and not explained

The deadlined arm of the `timing` cell could not be seeded, twice, in the same place in the run. Its three `things:///add?title=DEF1-TIMINGD…&when=2026-07-09&deadline=2026-07-12` dispatches each created a row — with a **deadline, as asked, and the title of the *previous* fixture** (`DEF1-TIMING2`, the same string minus the final `D`), so the read-back for the requested title found nothing:

```
8hTFYDWqe8ofHWZoxdSVHL DEF1-TIMING2 cd=…016 dl=N            <- the legitimate non-deadlined seed
QwmVkik7xAmG5eE2a1fCa3 DEF1-TIMING2 cd=…085 dl=2026-07-12   <- asked for DEF1-TIMINGD2
PRHqjxaBiGR8Rmk6aRsDHm DEF1-TIMING2 cd=…089 dl=2026-07-12   <- asked for DEF1-TIMINGD2
3Eum4NjUdnsrzQJBdFBdW1 DEF1-TIMING2 cd=…094 dl=2026-07-12   <- asked for DEF1-TIMINGD2
```

It **does not reproduce**: the same URL in isolation, the same URL after four Repeat-dialog open/escape cycles on the D-less twin, and three other `D`-suffixed titles all created the row asked for. So it is recorded as an unexplained anomaly with its evidence and no claim attached. The question the arm would have answered — the recompute timing on a deadlined seed — is answered anyway by the eight-point timeline each of the four deadlined matrix states carries, all of which show the pre-fill final at t+0.4 s.

### 11.3 A census gap this campaign shipped and then closed

The first `shape()` enumerated the shell's pop-ups, fields, checkboxes, buttons and statics — and **not its date areas**, which is where the reminder time lives. The reminder cells therefore read `Add reminders = 1` with no sign of a time control, and the honest report would have been "pre-ticked, no time visible". Fixed (the census now walks `every UI element whose role is AXDateTimeArea` on the shell as well as the group) and re-run; the field is real, and its *value* still reads empty through AX (§5), which is why the commit cells exist. The harness's own [census law](harness.md) — *a change to what the driver reads needs a cell that reads it back* — applies to probe drivers too, and the cost of learning that here was one re-run.

---

## 12. Cells and verdicts

| cell | what it establishes | verdict | beeps |
| --- | --- | --- | ---: |
| `fresh` | an escaped dialog leaves the row untouched; a reopen is byte-identical | **PASS** — the matrix is sound | 0 |
| `matrix` | 14 seed states × 5 frequencies, full census at open and after selection | **70/70 cells read** | 0 across all 14 states |
| `menus` | every pop-up's item list in all five states; the menu walk changes nothing | **PASS** | 0 |
| `partial` | 5 near-miss seed dates × monthly/yearly | **PASS** | 0 |
| `remind` | reminder pre-tick + the untouched-commit proof | **PASS** | 0 |
| `timing` | 4 frequencies × 30 samples at 100 ms | **PASS** | 0 |
| `commit` | 11 arms committed with the defaults accepted untouched | **11/11 PASS**, rule blobs decoded | 0 |
| `baseline` | 7 shipped-CLI drives traced for hops / round-trips / elements | **7/7 exit 0**, correct rules | 0 |

**Zero alert beeps across every cell of every sitting** — worth noting against [NEXTPOP1 §4](nextpop1-deadlined-promote.md)'s residual 3–4 beeps per 8-cell promote matrix. Every cell here that touches the dialog either selects one pop-up item and then only reads, or selects one and commits; the BEEP1 class needs a step landing on a group mid-rebuild, and a recipe that stops driving stops beeping. That is a second-order argument for §9 and it is worth re-checking when the minimal recipe is certified.

`crash = ALIVE`, `ips = 0` on every commit and baseline arm.

## 13. What this leaves open

- **`reschedule-repeat`'s pre-populated dialog** (§9.5) — the same question asked of an existing rule.
- **Whether the sheet realizes elements like the sidebar** — the element savings in §9.2 are the largest single term if it does, and a clone cannot tell ([RDLAT2 §E](rdlat2-repeat-dialog-latency.md), and the harness's *do not carry a multiplier across surfaces* corollary). A field trace of one anchor-bearing drive would price it.
- **Option A's DBLSPAWN1 exposure** (§9.3) — needs the DBLSPAWN1 matrix re-run through the CLI with a deadlined seed before it can be adopted.
- **Whether a spawned occurrence inherits the seed's reminder time** (§5) — neither reminder template had materialized an instance under the pinned clock.
- **The reminder time area's AX value** reads empty (§11.3); if a future recipe ever needs to *verify* the time rather than trust the row, that read needs a working spelling.
- **The S13 anomaly** (§10.3) and the seeding anomaly (§11.2), both recorded and neither explained.
