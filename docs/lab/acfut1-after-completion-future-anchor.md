# ACFUT1 — the future-anchored after-completion series: when its first occurrence actually appears

**Probed under: `things-lab-golden-v4` · Things 3.23 (CFBundleVersion 32300036, direct-download channel) · macOS 15.7.7 · `Meta.databaseVersion` 27 · guest clock pinned 2026-07-05 12:00 UTC (a Sunday), rolled to 2026-07-10 and then 2026-07-11.** ONE disposable clone of golden-v4 (the golden was never booted; every write inside the clone), airgapped (default route deleted, `ping 1.1.1.1` asserted UNREACHABLE before Things was launched), clock pinned before Things launched and re-pinned before every relaunch. Ground truth = read-only guest SQLite (`~/labh/rsum.py`, the VMRES1 decoder extended with `rt1_afterCompletionReferenceDate`; a read-only side-car dumped the instance rows). CLI exit 0 proves nothing on its own. Fixtures fully synthetic (`ACFUT1-*`). Fixture-building CLI built from released HEAD (`cf14266`, v0.19.3). Driver: [`lab/scripts/research-acfut1.sh`](../../lab/scripts/research-acfut1.sh). Artifacts (gitignored): `lab/artifacts/acfut1-lab/`.

Immutable snapshot per the [harness](harness.md) version-stamping policy; version *confirmations* accrue in the [assumption register](../reference/assumption-register.md), never here.

Packed dates decode `y<<16|m<<12|d<<7`. `next` = `rt1_nextInstanceStartDate`, `icStart` = `rt1_instanceCreationStartDate` (the spawn watermark), `icCount` = `rt1_instanceCreationCount`, `acRef` = `rt1_afterCompletionReferenceDate` (the after-completion anchor, [REPX1 §2.5](repx1-instance-semantics.md); not in the depended-column manifest).

> **Dates re-anchored inside the trial wall — deliberately, and it costs the question nothing.** The brief asked for `--when 2026-07-20` with rolls to 07-20/07-21. Golden-v4's `firstAppLaunchDate` is 2026-07-03 03:14 UTC on a 15-day trial, so **2026-07-18 is the wall** ([harness](harness.md) THE TRIAL WALL): past it the app runs read-only and **stops spawning occurrences**, which is *exactly* the observation this campaign is hunting — REPX3 already shipped a fake "the series stops spawning" result down this hole, and the state is sticky. The rollable cells therefore use **2026-07-10 / 07-11**, still strictly future relative to the pinned clock, which is the entire content of the question. **Cell V keeps the verbatim 07-20 date** for the at-rest reproduction, since it never rolls. The driver's `setclock` refuses any roll at or past `20260718` rather than trusting the operator.

---

## Verdicts at a glance

| Cell | Question | Verdict |
|---|---|---|
| **V** | Do VMRES1 §1's at-rest numbers reproduce, and what is `acRef` at rest? | **REPRODUCED EXACTLY** — and `acRef` is populated: **the requested date minus one interval** |
| **R** | Does the first occurrence of a future-anchored after-completion series appear on the cursor date? | **YES.** On the 07-10 roll the series minted one instance dated **2026-07-10**, `icCount` 0→1 |
| **R2** | Same shape via `make-repeating` on a 07-11 seed | **YES, identically** — one instance dated **2026-07-11** on the 07-11 roll; **inert** through the 07-10 roll |
| **C** (positive control) | Does a FIXED rule on the same future date spawn on the same roll? | **YES** — the roll itself is proven to spawn, so R/R2's silence before their dates is a real negative |
| **A2b** | An after-completion promote whose source date is in the PAST | **UNREACHABLE** — the app normalizes a past `when` to today; the promote then takes the today-anchored branch |
| — | Beep sentinel across all three phases | **0 / 0 / 0** — clean |

**The headline: the promise is TRUE.** "No instance yet — the first occurrence appears \<the cursor date\>" is exactly what the app does, on the nose, in both creation shapes, and it does not fire early, late, or twice.

---

## 1. At rest (clock 2026-07-05) — VMRES1 reproduced, and the missing column read

Five fixtures, all built on the pinned Sunday. All five drives exit **0**, no crash, no `.ips`.

| fixture | built by | rule | `next` | `icStart` | `icCount` | `acRef` | instances |
|---|---|---|---|---|---|---|---|
| **V** | `add-repeating --after-completion … --when 2026-07-20` | `tp=1 fu=256 fa=1 of=[]` | **2026-07-20** | **2026-07-06** | **0** | **2026-07-13** | **0** |
| **R** | `add-repeating --after-completion … --when 2026-07-10` | `tp=1 fu=256 fa=1 of=[]` | 2026-07-10 | 2026-07-06 | 0 | **2026-07-03** | 0 |
| **R2** | seed `--when 2026-07-11` → `make-repeating --after-completion` | `tp=1 fu=256 fa=1 of=[]` | 2026-07-11 | 2026-07-06 | 0 | **2026-07-04** | 0 |
| **C** | `add-repeating --frequency weekly … --when 2026-07-10` (FIXED) | `tp=0 fu=256 fa=1 of=[{wd=5}]` | 2026-07-10 | **2026-07-10** | 0 | None | 0 |
| **A2b** | seed `--when 2026-07-01` → `make-repeating --after-completion` | `tp=1 fu=256 fa=1 of=[]` | **None** | 2026-07-06 | **1** | None | **1** |

**V reproduces [VMRES1 §1](vmres1-residuals.md) field for field**: `tp=1 fu=256 fa=1`, `next` = the requested date verbatim, `icStart` = the pinned clock + 1 day, `icCount = 0`, and **zero non-trashed rows** linking back to the template.

### 1.1 `rt1_afterCompletionReferenceDate` at rest — a BACK-DATED synthetic anchor

VMRES1's helper never selected this column, so its at-rest value was unknown. It is **populated, and it is the requested date minus exactly one interval**:

| fixture | requested date | `acRef` | requested − `acRef` |
|---|---|---|---|
| V | 2026-07-20 | 2026-07-13 | 7 days = 1 week |
| R | 2026-07-10 | 2026-07-03 | 7 days = 1 week |
| R2 | 2026-07-11 | 2026-07-04 | 7 days = 1 week |

This is the **mechanism** behind VMRES1's observation that `next` "holds the requested date verbatim even though the recipe never drives Next:". The recipe drives ten steps and none of them is a date (`frequency = after completion → after-completion unit = weekly → interval = 1 → OK`). The app instead **fabricates a completion that never happened**, back-dating the anchor to `requested − interval`, and then derives the cursor by its ordinary law `next := acRef + interval` — which lands on the requested date. It is how "start this after-completion series on a future date" is made expressible in a model whose only native concept is "one interval after the last completion."

Note that the fabricated anchor is not constrained to be in the past: R's `acRef` (07-03) precedes the pinned clock, V's (07-13) is eight days in its future. The app simply solves the equation.

### 1.2 The two rule kinds are already distinguishable at rest by `icStart`

The fixed control's watermark is **the occurrence date itself** (`icStart = 2026-07-10`), while all three after-completion shapes sit at **clock + 1** (`2026-07-06`). This is the column #508's pre-fix oracle read, and it is the reason it misfired only on the after-completion side.

### 1.3 The shipped disclosure is accurate

Every future-anchored promote — after-completion *and* the fixed control — emitted:

```
warning: could not derive the spawned instance: no row links back to the new repeating
         template (the app may not have materialized the current occurrence)
```

The parenthetical is the correct reading: the occurrence has not been materialized *yet*.

---

## 2. Cell R — the decisive roll to 2026-07-10

The clock was rolled with Things **killed** (`pkill -x Things3`, never a graceful quit — a modal survives one, [URLEN1](harness.md)), then re-pinned, then the app relaunched.

**Read with Things NOT running: every fixture byte-identical to the at-rest table.** A clock change alone moves nothing; the database is only ever mutated by the app.

**After the warm relaunch:**

| fixture | `next` | `icStart` | `icCount` | `acRef` | instances |
|---|---|---|---|---|---|
| **R** | 2026-07-10 → **None** | 07-06 → 07-11 | **0 → 1** | 07-03 → **None** | **0 → 1** |
| **C** (control) | 2026-07-10 → **2026-07-17** | 07-10 → 07-11 | **0 → 1** | None | **0 → 1** |
| R2 (not yet due) | 2026-07-11 (unchanged) | 07-06 → 07-11 | 0 | 07-04 (unchanged) | **0** |
| V (not yet due) | 2026-07-20 (unchanged) | 07-06 → 07-11 | 0 | 07-13 (unchanged) | **0** |
| A2b | None | 07-06 → 07-11 | 1 | None | 1 |

The minted rows:

```
ACFUT1-R | inst=R4jEVcnD sd=132805888 (2026-07-10) status=0 trashed=0 bkt=0 created=1783641600.0
ACFUT1-C | inst=WcFyjF5m sd=132805888 (2026-07-10) status=0 trashed=0 bkt=0 created=1783641600.0
```

> **R's first occurrence appeared on the cursor date, carrying that date as its `startDate`.** Not the watermark date (07-06), not the roll instant — `2026-07-10`, the date the caller asked for and the date the shipped copy promises.

**The positive control did its job.** C — a fixed rule on the *same* future date — spawned on the *same* relaunch, so the roll is proven to spawn. R2's and V's silence on this roll is therefore a real negative and not a dead oracle ([CNCAC1](cncac1-after-completion-checkoff.md)/[URLEN1](harness.md): *a negative result from an oracle that has never been shown a positive is not evidence*).

### 2.1 On spawning, the fabricated anchor is CONSUMED

R's transition is the whole story in three columns: `acRef` 2026-07-03 → **NULL**, `next` 2026-07-10 → **NULL**, `icCount` 0 → 1. The synthetic anchor exists only to place the first occurrence; once that occurrence is real the app discards it and the series drops into the ordinary never-completed after-completion state — **exactly [CNCAC1 §7.1](cncac1-after-completion-checkoff.md)'s shape** (`next = None`, `icCount = 1`, one live occurrence), which is also where the today-anchored A2b sat from birth. The two creation paths converge the moment the future-anchored one's first occurrence lands.

The fixed control does the opposite, as it must: C's `next` **advances to the next rule date** (07-17) rather than clearing, because a fixed rule always knows where its next occurrence goes.

### 2.2 The spawn happens at app LAUNCH, and stamps `creationDate` at the day's midnight

The read-only side-car caught the transition inside a 16-second window straddling the relaunch — absent at `app=DEAD`, present at `app=ALIVE`. And `creationDate` is `1783641600.0` = **2026-07-10 00:00:00 UTC**, the *midnight of the start day*, not the 12:00 relaunch instant. That differs from the GUI check-off's just-in-time mint, which [CNCAC1 §3](cncac1-after-completion-checkoff.md) measured stamping `creationDate = stopDate = the click instant`. A clock spawn back-dates to the day it belongs to; a gesture mint stamps the gesture.

### 2.3 The watermark advances on every template the launch touches

`icStart` moved to **clock + 1** (07-11) on all five templates — spawned, not-yet-due and already-settled alike. It is a housekeeping watermark, not per-series state, and it carries no information about whether anything was minted.

---

## 3. Cell R2 and the second roll to 2026-07-11 — not early, not twice

| fixture | after 07-11 relaunch | instances |
|---|---|---|
| **R2** | `next` 2026-07-11 → **None** · `acRef` 07-04 → **None** · `icCount` **0 → 1** · `icStart` → 07-12 | **0 → 1** |
| **R** | unchanged (`next=None`, `acRef=None`, `icCount=1`) · `icStart` → 07-12 | **1** (still) |
| C | `next` 2026-07-17 (unchanged) · `icCount` 1 | 1 |
| V | `next` 2026-07-20 (unchanged) · `acRef` 07-13 (unchanged) · `icCount` 0 | **0** |

```
ACFUT1-R2 | inst=M9C2chSg sd=132806016 (2026-07-11) status=0 trashed=0 bkt=0 created=1783728000.0
```

Three separate confirmations in one roll:

- **`make-repeating` behaves identically to `add-repeating`.** R2's instance is dated **2026-07-11**, its own requested date, with the same anchor-consumption transition. Both entry points into a future-anchored after-completion series honour their cursor.
- **Not early.** R2 sat through the entire 07-10 roll with `icCount = 0` and zero rows while R spawned beside it.
- **Not twice, and not late.** R, now one day past its date, still has **exactly one** instance and did not mint a second. V, thirteen days out, remains at zero with its anchor intact — the state is stable across relaunches rather than decaying.

---

## 4. Cell A2b — a past-dated source is not reachable through the scheduling surface

The premise could not be constructed:

```
$ things todo add 'ACFUT1-A2B' --when 2026-07-01   ->  exit 3
  seed startDate = 2026-07-05          <- TODAY, not the requested 2026-07-01
```

**The app normalizes a past `when` to today.** The row lands on the pinned clock date and the shipped verifier correctly reports the mismatch (exit 3). Things has no notion of a start date in the past — a date that has gone by *is* Today — so "an after-completion promote whose source date is in the past" is not a state the scheduling surface can produce.

Promoting that (now today-dated) seed took the ordinary today-anchored branch: `next = None`, `icCount = 1`, `acRef = None`, **one live occurrence** dated 2026-07-05 — [CNCAC1 §7.1](cncac1-after-completion-checkoff.md) again, and unmoved by both rolls. The question is answered by being dissolved, not by measurement of the shape the brief imagined.

---

## 5. Beeps

Sentinel default-ON, report-only (research driver), post-hoc `log show` windowed against its own marks and pinned to `bootUUID`:

| phase | marks | beeps |
|---|---|---|
| build (5 drives: 3 after-completion promotes, 1 fixed promote, 2 plain adds) | 5 | **0** |
| roll1 (07-10, kill + re-pin + relaunch) | 2 | **0** |
| roll2 (07-11, kill + re-pin + relaunch) | 2 | **0** |

**Zero across the campaign.** The after-completion count agrees with [CERTSWEEP1](certsweep1-repeat-certification.md) (an after-completion promote raises none, 2/2). The **fixed-rule promote does NOT reproduce CERTSWEEP1's "exactly ONE alert beep per drive (3/3)"** — cell C's 13-step drive, which includes the `Next:` pop-up leg, beeped zero times. One sample against three, on the same golden; recorded as a non-reproduction, not a refutation.

---

## What this does NOT establish

- **Nothing past 2026-07-18 on golden-v4.** Every roll here stops well short of the trial wall. Whether a series whose cursor is months out still spawns correctly is untested and *cannot* be tested on this golden — it needs one with a fresh trial clock.
- **Only weekly, interval 1, no deadline, no end bound.** `fu=256 fa=1 ts=0 ed=<no-end sentinel>` throughout. Daily/monthly/yearly after-completion units, intervals > 1, and the `ts` deadline-offset shapes are unprobed here; the `acRef = requested − interval` law is measured at interval = 1 only and its generalization to other intervals is inferred, not shown.
- **Single-device only.** No Things Cloud account was attached and the clone was airgapped. How a fabricated `acRef` and a NULL-ing cursor merge across devices is unmeasured — `rt1_afterCompletionReferenceDate` is not in the depended-column manifest and [CNCAC1 §11](cncac1-after-completion-checkoff.md) already flags its sync behavior as open. SYNCX1's `umd`-keyed arbitration was not exercised.
- **Launch-triggered spawn only.** Every observation is "kill, re-pin the clock, relaunch". Whether a *continuously running* app crosses midnight and spawns on its own timer was not tested, and neither was a spawn on wake or on a date change without a relaunch.
- **No GUI reading of the pre-spawn state.** Whether Upcoming draws a future-anchored, instance-less series under its real day header (as a genuine projection) or parks it in the `Repeating To-Dos` / `Waiting` section ([CNCAC1 §7.1](cncac1-after-completion-checkoff.md), [craft 6k](../things-app-craft.md)) was not dumped. The DB says it has a real cursor, which argues for a day header, but that is inference — no AX census was taken.
- **The instance's non-date columns were not diffed.** The side-car captured `uuid / startDate / status / trashed / startBucket / creationDate`; this is not a full 41-column row diff of the kind REPX3/CNC1/CNCAC1 run, so claims about `index`, `todayIndexReferenceDate`, `umd` or tag inheritance on a clock-spawned first occurrence are not supported here.
- **One clone, one pass per cell.** No repeat run; the R/R2 agreement across two independent shapes and dates is the only replication.
