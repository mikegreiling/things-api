# REANCH1 — the dated URL `when=` on a repeating template, measured as a SERIES RE-ANCHOR

**Version stamp:** `things-lab-golden-v4` · Things **3.23** (CFBundleVersion **32300036**, direct-download channel) · macOS **15.7.7 (24G720)** · `Meta.databaseVersion` **27** · four airgapped clones, guest clock pinned **2026-07-05 12:00 (a Sunday)** and advanced by the roll cells · guest audio muted at boot · AXVM1 accessibility grant baked. The version-provenance cell (§6) ran on `things-lab-golden-v3` · Things **3.22.14** (build **32214000**) · DB v26. Campaign run 2026-08-23, unattended. Immutable snapshot per the [harness](harness.md) version-stamping policy.

Driver: [`lab/scripts/research-reanch1.sh`](../../lab/scripts/research-reanch1.sh) (cells selected by `CELLS=…`; `KEEP=1` keeps the clone, `REUSE=1` attaches). Fixtures fully synthetic (`REANCH1-*`); the golden's own `LAB-REPEAT-WEEKLY-PROJ` seed is the project arm and `LAB-REPEAT-DAILY` the 3.22 arm. Artifacts (gitignored): `lab/artifacts/reanch1-lab/`, `reanch1b-lab/`, `reanch1w3-lab/`, `reanch1v3-lab/` — `report.txt` plus per-gesture full-row snapshots in `snap/`.

**DB oracle:** every gesture is bracketed by a **full-row snapshot** of every `TMTask` column for the fixture's rows (`rowsnap.py` → `uuid⇥column⇥value`, packed dates decoded, blobs hashed), diffed field by field, plus a decoded rule summary (`rsum.py`, extended here to print the rule BLOB HASH and the blob's own `ia`/`sr` anchors — the field ODDS1-F2 could not see). "No field changed on any surviving row" means all 41 columns of every row compared.

Predecessors: [odds1-323-revalidation.md](odds1-323-revalidation.md) §3.1 (which found the write and named it a cursor re-anchor), [repx2-exception-chooser.md](repx2-exception-chooser.md) §1.4 (the GUI `Update Rule` branch this turns out to equal), [repx1-instance-semantics.md](repx1-instance-semantics.md) §2.3 (cursor vs watermark), [anch2-next-field.md](anch2-next-field.md) cell (e) (the Repeat dialog's already-shipped re-anchor).

---

## 0. Headline

1. **The write is not a cursor nudge — it is a full rule re-anchor, byte-identical to the GUI's `Update Rule` branch.** ODDS1-F2 saw `rt1_nextInstanceStartDate` + `rt1_instanceCreationStartDate` move because it did not snapshot the rule blob. It moves too: the blob's own start anchor (`ia`) is rewritten, and **so is the rule's calendar anchor** — a weekly rule's weekday, a monthly rule's day-of-month, a yearly rule's month+day (§2, §7). On a daily series seeded 07-05 and re-anchored to 07-09 the resulting 627-byte blob hashes `sha256:b9a58999d5b4072c` — **the exact blob REPX2 §1.4 measured after pressing `Update Rule` in the app** on the same seed and target. Same operation, no prompt, no GUI.
2. **The spawn lands on the re-anchored date, and the skipped slots are not backfilled.** A daily series re-anchored 07-06 → 07-09 minted exactly one instance on 07-09 at the clock roll (`icCount` 1→2), against an untouched control on the same roll that backfilled 07-06…07-09 as four instances (`icCount` 1→5). A weekly Sunday series re-anchored to a Thursday spawned on the **Thursday** and then set `next = 2026-07-16`, the following Thursday — the phase really moved (§2.3).
3. **The `@<time>` component writes a rule-level reminder that every later spawn inherits, and no dated re-anchor clears it** (§3). `when=<date>@18:00` sets the template's `reminderTime`; the instances minted on 07-09 and 07-10 both carry it; a bare dated re-anchor to a LATER date leaves it in place. [Oddities §8b](../things-app-oddities.md)'s no-CLEAR claim survives with a measured SET path beside it.
4. **A repeating PROJECT template takes it on `update-project`, identically** — same five-column delta, same rule-anchor rewrite, and the project instance spawns on the re-anchored day (§4). The to-do route `update?id=<project>` aimed at a project row is a **silent no-op** (wrong route, no crash).
5. **An AFTER-COMPLETION template CRASHES — the calendar-date branch is not universally safe.** `update?when=<date>` and `when=<date>@<time>` on a `tp=1` template both kill the process with a fresh `.ips`, row byte-identical, 2/2 (§4.2). New [oddity §15](../things-app-oddities.md).
6. **The real crash boundary is FUTURE-vs-NOT, not bucket-vs-date** (§5). Six arms: a target strictly after today re-anchors; a target **equal to today** kills the app (2/2); a target **in the past** kills the app; a target **equal to the current cursor** is an inert no-op that never reaches the fatal path. That reframes ODDS1 §3.1 and [oddities §1](../things-app-oddities.md): `today`/`evening` are fatal because they resolve to *today*, `tomorrow` survives because it resolves to *today+1*, and `2026-07-05` typed on 2026-07-05 is every bit as fatal as the word.
7. **It is NEW IN 3.23.** On Things **3.22.14** every one of the four dated spellings — future date, future date@time, past date, today — kills the process with zero delta, exactly as §1 always claimed (§6). So this is a behavior CHANGE between builds, in the unusual direction: a branch that used to crash now works. Anything built on it needs a version gate, not a capability assumption.
8. **A MULTI-weekday weekly rule does not survive it.** `{Mon, Wed, Fri}` re-anchored to a Thursday comes back `{Wed, Thu, Fri}` — same cardinality, two days silently swapped for days the user never chose (§7). New [oddity §16](../things-app-oddities.md).
9. **Nothing was shipped.** The briefed flag (`--starting` on `reschedule-repeat`) would duplicate a re-anchor the shipped op already has, and finding 8 is a data-loss class no disclosure line can honestly cover — see §8.

---

## 1. Method

Four disposable clones, each airgapped (default route deleted, ping verified failing), clock-pinned before Things launched, guest audio muted at boot, destroyed on exit.

| clone | golden | what it covered |
|---|---|---|
| `reanch1-lab` | v4 / 3.23 | the main matrix: daily + weekly re-anchor, reminder, after-completion, project, safety edges, two clock rolls |
| `reanch1b-lab` | v4 / 3.23 | the crash-boundary discriminators + the crash re-confirmations (2/2) |
| `reanch1w3-lab` | v4 / 3.23 | what the re-anchor does to a monthly / yearly / multi-weekday / deadlined rule |
| `reanch1v3-lab` | v3 / 3.22.14 | version provenance: the same minimal cell on the previous line |

**Fixture shape.** Every to-do fixture is `things:///add?title=…&when=2026-07-05` promoted through `Items ▸ Repeat…` (the REPX1/REPX2 recipe), which lands the documented series: a materialized instance dated 07-05 plus a template with `next = icStart = 2026-07-06`, `icCount = 1`. The project arm uses the golden's own weekly-Sunday project template.

**Crash discipline.** Every write is bracketed by a pid oracle and a `.ips` count, with a full relaunch after any death and the target row re-snapshotted. Twelve process deaths were provoked across the campaign (4 · 3 · 0 · 5 by clone, matching each clone's final `.ips` count); every one left the target row byte-identical.

**The one write shape**, throughout:

```
things:///update?id=<template-uuid>&auth-token=<token>&when=<value>
things:///update-project?id=<template-uuid>&auth-token=<token>&when=<value>
```

---

## 2. Cell 1 — the rewrite, and where the spawn lands

### 2.1 What a dated `when=` actually writes

A fixed DAILY template (`REANCH1-DAILY`, `next = icStart = 2026-07-06`), `update?when=2026-07-09`:

```
CHANGED rt1_instanceCreationStartDate : 2026-07-06 -> 2026-07-09
CHANGED rt1_nextInstanceStartDate     : 2026-07-06 -> 2026-07-09
CHANGED rt1_recurrenceRule            : sha256:3b34361cc5aa9175 (627 B) -> sha256:b9a58999d5b4072c (627 B)
CHANGED todayIndexReferenceDate       : 2026-07-06 -> 2026-07-09
CHANGED userModificationDate          : …
(no other row touched; icCount unchanged at 1; every existing instance byte-identical)
```

Five columns, not two. `start`/`startDate` are untouched — which is exactly why the write reads as a no-op through the row's own schedule columns and why ODDS1 §3.1, snapshotting only the `rt1_*` pair, described a *cursor* re-anchor. The blob moved as well, and decoding it shows what changed inside:

| | before | after |
|---|---|---|
| `tp` / `fu` / `fa` / `ts` / `rc` | 0 / 16 / 1 / 0 / 0 | unchanged |
| `of` (calendar anchor) | `[{dy=0}]` | unchanged (daily has none) |
| `ed` (the year-4001 "forever" sentinel) | 64092211200 | unchanged |
| `sr` | 1783209600 (2026-07-05) | **unchanged** |
| `ia` (the rule's own anchor epoch) | 1783209600 (2026-07-05) | **1783555200 (2026-07-09)** |

**`sha256:b9a58999d5b4072c` is the same 627-byte blob REPX2 §1.4 recorded after pressing `Update Rule`** on a daily series with the same seed and the same 07-09 target. The URL path and the chooser's rule branch produce identical bytes.

### 2.2 The same write on a WEEKLY rule moves the rule's weekday

`REANCH1-WEEKLY` (weekly, seeded Sunday 07-05, `of=[{wd=0}]`, `next = 2026-07-12`), `update?when=2026-07-09` — a **Thursday**:

```
CHANGED rt1_instanceCreationStartDate : 2026-07-12 -> 2026-07-09
CHANGED rt1_nextInstanceStartDate     : 2026-07-12 -> 2026-07-09
CHANGED rt1_recurrenceRule            : sha256:4a52076bf78643ec (628 B) -> sha256:a0459a57aebe9583 (628 B)
CHANGED todayIndexReferenceDate       : 2026-07-12 -> 2026-07-09
CHANGED userModificationDate          : …
rule after: fu=256 fa=1  of=[{wd=4}]  ia=2026-07-09   <- wd 0 (Sunday) -> 4 (Thursday)
```

The rule's WEEKDAY is rewritten, not just the cursor. This is a genuine schedule change, and it is the fact that makes the write dangerous to expose naively (§5, §8).

### 2.3 The spawn — cell 1's actual question

Clock rolled 2026-07-05 → 2026-07-09, app relaunched:

| series | re-anchored to | instances minted on the roll | template after |
|---|---|---|---|
| `REANCH1-DAILY` (daily) | 07-09 | **one, dated 2026-07-09** | `icCount 1→2`, `next = 2026-07-10` |
| `REANCH1-WEEKLY` (weekly, was Sundays) | 07-09 | **one, dated 2026-07-09 (a Thursday)** | `icCount 1→2`, `next = 2026-07-16` — the following **Thursday** |
| `REANCH1-TODAY` (control — its write crashed, cursor never moved) | — | **four**, dated 07-06, 07-07, 07-08, 07-09 | `icCount 1→5` |

Three things fall out of that table. The minted occurrence lands **on** the re-anchored date. The weekly series spawns **off its original weekday phase and keeps the new one** — a true re-anchor, matching REPX2 §1.4's `Update Rule` and not `Edit Rule…`/`reschedule-repeat`'s phase-preserving rule rewrite. And the control shows what the re-anchor *prevents*: an untouched daily series backfills every slot the clock skipped, while a re-anchored one skips them silently. A caller moving a series forward is therefore also discarding the occurrences in between, with no signal.

A second roll (07-09 → 07-10) confirmed the series simply continues on its new phase: the daily series minted 07-10 (`icCount 2→3`), the weekly one minted nothing and kept `next = 2026-07-16`.

### 2.4 Repeatability and idempotency

Re-anchoring the same template twice works (`07-06 → 07-20 → 07-10`, both full five-column rewrites — REANCH1-B3). Re-anchoring to the date the cursor **already holds** is an **inert no-op**: zero delta across all 41 columns, app alive (`REANCH1-B2`, target 07-06 == cursor 07-06; and the R10 arm, target 07-10 == cursor 07-10). That no-op short-circuit matters more than it looks — see §5.

---

## 3. Cell 2 — the reminder

`REANCH1-REM` (daily, no reminder), `update?when=2026-07-09@18:00`:

```
CHANGED reminderTime                  : None -> 1207959552   (= 18:00, hour<<26 | minute<<20)
CHANGED rt1_instanceCreationStartDate : 2026-07-06 -> 2026-07-09
CHANGED rt1_nextInstanceStartDate     : 2026-07-06 -> 2026-07-09
CHANGED rt1_recurrenceRule            : sha256:3b34361cc5aa9175 -> sha256:b9a58999d5b4072c
CHANGED todayIndexReferenceDate       : 2026-07-06 -> 2026-07-09
CHANGED userModificationDate          : …
```

The rule-blob delta is **identical** to the bare dated form (same target hash) — the reminder rides the `reminderTime` COLUMN, not the rule blob.

**Inheritance, at spawn level (the question ODDS1-F2's roll could not reach):**

| roll | instance minted | its `reminderTime` |
|---|---|---|
| → 2026-07-09 | `ReHHd7eq`, `startDate = 2026-07-09` | **1207959552 (18:00)** |
| → 2026-07-10 | `XxAbPCqi`, `startDate = 2026-07-10` | **1207959552 (18:00)** |

Every spawned occurrence carries it. And a **bare** dated re-anchor to a LATER date does not clear it (`REANCH1-B4`: `@18:00` → 07-09, then bare → 07-12; `rem = 18:00` throughout, and the 07-12 spawn carries it). [Oddities §8b](../things-app-oddities.md) — "a template's reminder cannot be cleared in place" — is untouched; what it gains is a measured SET path and the confirmation that the set is inherited, not merely stored.

> **Methodological note for a re-runner.** The first pass's follow-up arm chose a bare re-anchor to `2026-07-10` at a clock of 2026-07-10 with the cursor *already* on 07-10 — which is the §2.4 no-op, so it proved nothing about clearing. The B-clone arm (a LATER, distinct date) is the one that answers the question.

---

## 4. Cells 3 and 4 — projects, and after-completion

### 4.1 A repeating PROJECT template: accepted, same shape, spawn lands

`LAB-REPEAT-WEEKLY-PROJ` (weekly Sundays, `of=[{wd=0}]`, `next = 2026-07-12`, watermark 07-06):

```
update-project?when=2026-07-13   ->  icStart 2026-07-06 -> 2026-07-13
                                     next    2026-07-12 -> 2026-07-13
                                     rule    sha256:0f4953a217dce69d -> sha256:d624c990676c665c
                                     of=[{wd=0}] -> of=[{wd=1}]   (Sunday -> Monday)
                                     tiRef, umd
update-project?when=2026-07-09   ->  … of=[{wd=1}] -> of=[{wd=4}]  (Monday -> Thursday), next=2026-07-09
update?when=2026-07-11           ->  (no field changed on any surviving row)   <- the TO-DO route is inert on a project row
```

Clock rolled to 2026-07-09: the series minted **one project instance dated 2026-07-09** (`type = 1`, `rt1_repeatingTemplate` FK set), `icCount 1→2`, `next = 2026-07-16` — the following Thursday. Identical semantics to the to-do arm, on the route that matches the row's type. The app stayed alive through all three writes (`ips 4→4`).

This is worth naming against [oddities §7 C2 / §8k](../things-app-oddities.md): `update-project?when=anytime|someday` **kills** the app on 3.23, while `update-project?when=<future date>` re-anchors it cleanly. The project route has exactly the same guarded/unguarded split as the to-do route.

### 4.2 An AFTER-COMPLETION template: CRASH (2/2 on both spellings)

`REANCH1-AC` / `REANCH1-BAC` — promoted with the Repeat dialog's `after completion` cadence (`tp=1`, `fu=256`, `of=[]`, `next = NULL`, `icStart = 2026-07-06`):

| write | result |
|---|---|
| `update?when=2026-07-09` | **process death**, fresh `.ips`, row byte-identical (2 runs, 2 clones) |
| `update?when=2026-07-11@07:30` | **process death**, fresh `.ips`, row byte-identical |

Decisive for scope, and coherent with §5's law: an after-completion rule has no calendar anchor at all — `rt1_nextInstanceStartDate` is NULL — so there is no "current cursor" to compare the target against and no anchor to rewrite. The handler takes the same unguarded branch the bucket spellings take. The clock roll confirms the template is otherwise healthy: its watermark tracks the clock (`icStart` 07-06 → 07-10 → 07-13) and it spawns nothing, waiting on a completion, exactly as REPX1 §2 describes.

**New [oddity §15](../things-app-oddities.md).**

---

## 5. Cell 6 — the safety edges, and the real boundary

ODDS1 §3.1 drew the line at **bucket vs calendar date**. That is not where it is. Six arms, all on fresh daily series with the cursor at 2026-07-06 and the clock pinned 2026-07-05:

| arm | target | vs today (07-05) | vs cursor (07-06) | result |
|---|---|---|---|---|
| C6a | `when=today` (bucket) | == | < | **process death**, zero delta |
| C6b | `when=2026-07-09` on the SAME row | > | > | full five-column re-anchor, app alive |
| C6c / B5 | `when=2026-07-05` | **==** | < | **process death**, zero delta, **2/2** (two clones) |
| B1 | `when=2026-07-04` | **<** | < | **process death**, zero delta |
| B2 | `when=2026-07-06` | > | **==** | **inert no-op**, zero delta, app alive |
| B3b | `when=2026-07-10` (cursor first pushed to 07-20) | > | **<** | full re-anchor, app alive |

Read together the handler has three branches, in this order:

1. **target == the current cursor** → return, write nothing. (B2; and the R10 arm at a different clock.)
2. **target > today** → re-anchor, whether that moves the cursor forward (B3a, C1) or **backwards** (B3b). Direction is irrelevant.
3. **anything else — target ≤ today** → `EXC_BREAKPOINT`, process death, row untouched.

So "backwards is fatal" is falsified, and "a calendar date is safe" is too broad. The rule is **the resolved target must be a strictly FUTURE day**, and it explains the whole family at once: `today` and `evening` resolve to today (fatal), `anytime`/`someday`/empty name a bucket with no day at all (fatal), `tomorrow` resolves to today+1 (safe), and an ISO date is safe or fatal purely by where it falls relative to the device's current day. A caller writing `2026-07-05` on 2026-07-05 gets the identical crash as one writing the word `today` — which is a materially better bug report than the spelling-based split, and a materially harder trap, because the *same literal string* is safe on Friday and fatal on Sunday.

**Re-anchoring onto today does NOT mint an occurrence** — the question [oddities §13](../things-app-oddities.md) (the double-spawn class) suggested. It cannot: the write never lands. The C6c arm's template was byte-identical after the crash, after a relaunch, and its series still held exactly the one 07-05 instance it started with. There is no double-book route here.

---

## 6. Cell 5 — version provenance: this is NEW in 3.23

Same minimal cell, one clone of `things-lab-golden-v3` (Things **3.22.14**, build 32214000, DB v26), same pinned clock, on the golden's own `LAB-REPEAT-DAILY` template (`next = icStart = 2026-07-06`, `icCount = 3`):

| write | 3.22.14 | 3.23 (for contrast) |
|---|---|---|
| `update?when=2026-07-09` (a future date) | **process death**, zero delta | five-column re-anchor |
| `update?when=2026-07-11@18:00` | **process death**, zero delta | re-anchor + `reminderTime` |
| `update?when=2026-07-04` (past) | **process death**, zero delta | process death |
| `update?when=2026-07-05` (today) | **process death**, zero delta | process death |
| `update?when=today` (bucket) | **process death**, zero delta | process death |

Five deaths, five fresh `.ips`, every row byte-identical; the clock roll to 07-11 then backfilled 07-07…07-11 exactly as an untouched series should.

**[Oddities §1](../things-app-oddities.md)'s original blanket claim — "the whole `when=` family crashes a repeating template" — was CORRECT for the 3.22 line.** It is 3.23 that split the family, by adding a future-date branch that works. ODDS1 §3.1 was right to record its finding as a 3.23 *measurement* rather than a change and right to flag the provenance caution; the caution is now resolved in the direction it feared least — this is a real, unannounced behavior change, and the capability did not exist one build earlier.

The consequence for any code that would use it: a **version gate**, not a capability assumption. The same shape `privateReorderIsNoOp` uses (`src/write/experimental.ts` `compareAppVersions`), pinned at ≥ 3.23, with the sub-3.23 answer being the existing hard refusal.

---

## 7. What the re-anchor does to a rule's CALENDAR ANCHOR

§2.2 showed a weekly rule's weekday being rewritten. That generalizes across frequencies — every arm re-anchored to **2026-09-17** (a Thursday, day-of-month 17, month 9), a date sharing nothing with the seeded 2026-07-05 anchor:

| fixture | rule before | rule after `update?when=2026-09-17` | verdict |
|---|---|---|---|
| `REANCH1-WMON` monthly, day-of-month | `fu=8 of=[{dy=4}]` (the 5th) · `ia = 2026-07-05` · `next = 2026-08-05` | `fu=8 of=[{dy=16}]` (**the 17th**) · `ia = 2026-09-17` · `next = 2026-09-17` | anchor REWRITTEN |
| `REANCH1-WYEAR` yearly, month+day | `fu=4 of=[{dy=4,mo=6}]` (July 5) · `next = 2027-07-05` | `fu=4 of=[{dy=16,mo=8}]` (**September 17**) · `next = 2026-09-17` | anchor REWRITTEN |
| `REANCH1-WMULTI` weekly, **{Mon, Wed, Fri}** | `fu=256 of=[{wd=1},{wd=3},{wd=5}]` · `next = 2026-07-06` | `fu=256 of=[{wd=3},{wd=4},{wd=5}]` — **{Wed, Thu, Fri}** · `next = 2026-09-17` | set **REWRITTEN, not collapsed** |
| `REANCH1-WDL` daily + "Add deadlines" | `fu=16 of=[{dy=0}] ts=0` · `deadline = 4001-01-01` (the sentinel) | `of=[{dy=0}] ts=0` · `deadline = 4001-01-01` — **both preserved** · `next = 2026-09-17` | deadline mode SURVIVES |

Every arm produced the same five-column row delta and left the app alive (`ips 0→0`). Three readings:

- **The rule's calendar anchor is recomputed from the target date on every frequency.** Monthly moves its day-of-month, yearly its month AND day. This is not a cursor pointer being nudged; it is the schedule being redefined. A caller who thinks they are moving one occurrence is moving the whole series.
- **The deadline mode is preserved** — the year-4001 sentinel and the `ts` start offset both survive, so a deadlined series stays deadlined. (Its spawned instances' deadlines were not observed; see §9 cell 3.)
- **A MULTI-weekday set is neither preserved nor collapsed — it is REWRITTEN into a different set of the same size.** `{Monday, Wednesday, Friday}` re-anchored to a Thursday came back `{Wednesday, Thursday, Friday}`. The cardinality is kept and the target's weekday is a member, but two of the three original days are gone and a day the user never chose is in. Read against the single-weekday arm (§2.2: `{Sunday}` → `{Thursday}`), the shape that fits both is **a contiguous run of the original cardinality, centred on the target weekday** — `{t−1, t, t+1}` for three, `{t}` for one. That is a hypothesis from two data points (cardinalities 1 and 3), not a law; what is *measured*, and sufficient, is that a multi-weekday rule does not survive a re-anchor intact. **New [oddity §16](../things-app-oddities.md).**

> **The W-block clock roll produced no spawn on any of the four fixtures — including the daily one — and is recorded as a RIG ARTIFACT, not a finding.** The roll jumped 74 days (2026-07-05 → 2026-09-17) where every other roll in this campaign moved 1–7 days, and a daily series sitting on its own cursor date must mint. Nothing about the pre-roll anchor measurements above depends on it. Whoever re-runs this block should shorten the jump or add a second relaunch before trusting the spawn column.

---

## 8. Verdict — why nothing shipped, and what a build would need

The brief allowed shipping a `--starting <date>` flag on `things todo reschedule-repeat`, driven through this URL path, **if** cells 1–2 came back clean and deterministic and nothing bled in from the project / after-completion arms. Cells 1–2 ARE clean and deterministic. Nothing shipped anyway, for three reasons that are about the SHAPE of the surface rather than the quality of the measurement.

**1. The briefed flag would duplicate a re-anchor `reschedule-repeat` already has.** The up-next item this campaign serves says our `reschedule-repeat` "leaves `rt1_nextInstanceStartDate` on the OLD phase". That is true only of a rule-ONLY reschedule. `reschedule-repeat --when <date>` drives the Repeat dialog's `Next:` first-occurrence control, and ANCH2 cell (e) measured exactly this shape on an EXISTING template — `next = 07-08`, drive `Next = 07-22`, result `ia = sr = next = icStart = 2026-07-22`, identity preserved — with RSPA1 re-driving it live through the shipped CLI on golden-v3. The op's own `expectedDelta` asserts the landed cursor against `--when`. So a `--starting` flag would be a **second flag on the same command setting the same field through a different vector**, which is a worse surface than either alternative.

**2. What the evidence newly unlocks is a different op, and that is Mike's call.** The URL path is not a new capability; it is a dramatically cheaper *vector* for one we have, plus one thing the shipped op cannot do:

| | `reschedule-repeat --when <date>` (shipped) | the URL re-anchor (measured here) |
|---|---|---|
| vector | `ui` — drives the Repeat dialog | URL, one background `open` |
| gate | `H-UI-DRIVE` + `ui.enabled` + `--dangerously-drive-gui` | none today (the write is hard-refused) |
| cost | seconds, app focus, a fail-closed read-back verify | one dispatch, tier 0–1 |
| must restate the rule? | **yes** — `--frequency` and `--interval` are required options | **no** — the rule is preserved except its anchor |
| app versions | 3.22 and 3.23 | **3.23 only** |
| after-completion template | supported | **crashes the app** |
| target ≤ today | the dialog's own validation | **crashes the app** |

The honest shape is therefore a **new, narrow op** — "move a repeating series' next occurrence to `<date>`, without restating its rule" — on to-dos and projects, URL vector, version-gated ≥ 3.23. Whether that op is worth its disclosure burden is a design decision, not a measurement, so it is left to Mike.

**3. A multi-weekday rule is silently rewritten, and that is not disclosable.** §7: `{Monday, Wednesday, Friday}` re-anchored to a Thursday becomes `{Wednesday, Thursday, Friday}`. This was the campaign's last open precondition and it came back worse than the feared answer — not a collapse to one day (which a disclosure line could at least *name*), but a substitution into a different set of the same size, by a rule the evidence can only hypothesise (a contiguous run centred on the target). An op cannot honestly tell a caller what their series will fire on afterwards. Either the op refuses a rule with more than one weekday, or it reads the rule back and refuses to report success when the set moved — and either way that is a shape decision, not a measurement.

**If the op IS built, these are the guards the evidence names**, each fail-closed and each with a probe id behind it:

- **≥ 3.23 only** (§6) — below it, the current hard refusal stands unchanged.
- **The target must be strictly after the device's current day** (§5). Not "not in the past" — `today` itself is fatal. The check has to run against the *device's* today (TIMEZ: `when=` resolves against the device's local day), and it has to be re-checked as late as possible, because a request composed before midnight and dispatched after it changes class.
- **Refuse an after-completion template** (§4.2), read from the decoded rule (`tp = 1`) before dispatch — the repo already decodes rules for `repeat-asserts.ts`.
- **Route by row type** (§4.1): `update-project` for a project template, `update` for a to-do template. The wrong route is a silent no-op, so a read-back verify is mandatory anyway.
- **Read back BOTH cursor columns and the rule blob** after the write. The `target == cursor` no-op (§2.4) is indistinguishable from a refused write at the transport layer — `open` exits 0 either way.
- **Refuse a rule carrying more than one weekday** (§7) until the rewrite is a law rather than a hypothesis — or read the whole `of` set back and fail the write when it moved.
- **Disclosure copy must say three things**, all measured: it re-anchors the SERIES (existing occurrences are untouched but every slot between the old cursor and the new date is silently skipped, §2.3); it rewrites the rule's calendar anchor, so a weekly series moved to a Thursday becomes a Thursday series and a monthly series moved to the 17th becomes a 17th-of-the-month series (§2.2, §7); and it is irreversible headlessly — there is no inverse write, only the app's own ⌘Z (REPX2 §4.3's asymmetry applies unchanged).
- **The existing `H-REPEAT-SCHEDULE` refusal stays** for every other `when=` spelling on a template. It is carved, not lifted.

---

## 9. Open cells this campaign did NOT close

1. **The multi-weekday rewrite's actual LAW.** §7 measured one multi-weekday case (cardinality 3) and one single-weekday case, which are together consistent with "a contiguous run of the original cardinality centred on the target weekday" — and with several other rules. Cardinalities 2, 4 and 7, and a target weekday already in the set, would settle it. Only worth doing if an op is going to be built.
2. **A rule with an ENDS bound** (`rc = N` "after N occurrences", or an `ed` end date that is not the year-4001 sentinel). Every fixture here carried the forever sentinel, which survives untouched; a real bound is unmeasured, and an occurrence COUNT that silently resets would be another data-loss class.
3. **A deadlined series' SPAWNED instances after a re-anchor.** §7 shows the template's deadline mode surviving (`ts` and the 4001-01-01 sentinel both intact), but the W-block clock roll was a rig artifact (§7's note), so no post-re-anchor instance was observed carrying its deadline.
4. **A monthly nth-weekday anchor** (`{wdo=…, wd=…}`, "the second Tuesday") — §7 covered day-of-month monthly only, and the nth-weekday encoding is the one most likely to be rebuilt into something the user did not ask for.
5. **A PAUSED template** (`rt1_instanceCreationPaused = 1`). Unattempted; whether the re-anchor lands, and whether it silently resumes, is unknown.
6. **Sync.** Every measurement is single-device. A re-anchor is an ordinary field write on the template row, so it should merge like any other — but the *skipped* occurrences are the interesting half: a second Mac whose own cursor has not moved will reach the old slot and mint there (craft §4c, SYNC2B/SYNC3). Whether the merge reconciles that against the re-anchored series or leaves a stray is exactly the question REPX2 §8 asks of `Make Exception`, and it has the same rig (the durable Things Cloud account).
7. **`when=` natural-language phrases on a template.** `tomorrow` is known to survive (ODDS1-E1); `next thursday` and friends were not aimed at a template here. Since the crash boundary is the RESOLVED day (§5), a phrase that resolves to today would presumably be fatal — presumed, not measured.
8. **The app's own ⌘Z against a URL re-anchor.** REPX2 §4.3 found ⌘Z a perfect inverse of a JIT materialization; whether it rewinds this write is unmeasured, and it is the only candidate inverse.

---

## 10. What this campaign changes elsewhere

| document | change |
|---|---|
| [things-app-oddities.md](../things-app-oddities.md) §1 | **dated appendix** — the crash boundary is FUTURE-vs-NOT, not bucket-vs-date: an ISO date equal to today is as fatal as the word `today`, on 3.23; and on the 3.22 line the entry's original blanket claim was simply correct |
| [things-app-oddities.md](../things-app-oddities.md) | **new §16** — re-anchoring a MULTI-weekday weekly rule silently rewrites which weekdays the series fires on |
| [things-app-oddities.md](../things-app-oddities.md) | **new §15** — a dated `when=` on an AFTER-COMPLETION template kills the app on 3.23, where the same spelling on a fixed template is an accepted write |
| [things-app-oddities.md](../things-app-oddities.md) §8b | **dated appendix** — the SET path measured, and the spawn-level inheritance the entry did not have |
| [things-app-craft.md](../things-app-craft.md) | **new entry** — the URL re-anchor and the GUI `Update Rule` branch produce byte-identical rule blobs, and the handler short-circuits an anchor that is already where it is asked to go |
| [capability-matrix.md](../capability-matrix.md) | the *Schedule/deadline edits on templates* row records the re-anchor as a reachable-but-unbuilt path with its measured semantics, its three crash classes and its version gate |
| [odds1-323-revalidation.md](odds1-323-revalidation.md) §3.1 | its two-column description is **widened** (five columns, rule blob included) and its bucket-vs-date boundary **corrected**. Recorded here, not by editing that immutable snapshot |
| [reference/novel-paths.md](../reference/novel-paths.md) | the URL-scheme section gains the dated re-anchor |
| [up-next.md](../up-next.md) | the REANCH probe item is deleted; the `reschedule-repeat` re-anchor item is rewritten around what the evidence now supports |
