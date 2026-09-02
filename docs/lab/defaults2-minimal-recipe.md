# DEFAULTS2 — the minimal recipe, built: the drive READS what the dialog already holds

**Probed under: `things-lab-golden-v4` · Things **3.23** (CFBundleVersion **32300036**) · macOS **15.7.7** · DB schema **v27** · guest clock pinned **2026-07-05 12:00 (a Sunday)**, trial wall 2026-07-18, never rolled.** ONE disposable clone of golden-v4 (the golden is never booted), airgapped (default route deleted), beep sentinel on in report-only mode (`THINGS_LAB_BEEPS_OK=1`), destroyed at teardown. Fixtures fully synthetic (`DEF2-*`). Immutable snapshot per the [harness](harness.md) version-stamping policy.

Driver: [`lab/scripts/research-defaults2.sh`](../../lab/scripts/research-defaults2.sh) — cells `clamp` · `baseline` · `after` · `states` · `mismatch` · `refuse` · `cells`. Ledger extractor: [`lab/scripts/defaults2-ledger.py`](../../lab/scripts/defaults2-ledger.py). Artifacts (gitignored): `lab/artifacts/defaults2-lab/` (`report.txt`, per-drive traces in `trace/`, CLI output in `drive/`).

This is the BUILD campaign [DEFAULTS1 (#689)](defaults1-repeat-dialog-defaults.md) was the probe for, on top of [VOPAT2 (#687)](vopat2-screen-reader-build.md). DEFAULTS1 measured the law and changed nothing in `src/`; this one ships the mechanism, certifies it, and **corrects DEFAULTS1 where the build proved it incomplete** (§2, §3).

---

## 0. Headline

| | |
| --- | --- |
| **What shipped** | the defaults law as ARITHMETIC (`ui-prefill.ts`), one VERIFY-BY-READ hop that turns each provable actuation into a read, and SEED SHAPING that schedules a deadlined rule's seed on the due date |
| **Does it land?** | **8/8 traced arms + 6/6 state arms land rule blobs BYTE-IDENTICAL to the same drive with the reliance switched off.** 0 alert beeps on every certification cell |
| **What it is worth** | −2 to −4 hops, **−13 % to −43 % of round-trips, −19 % to −56 % of elements realized**, measured through the shipped CLI on the post-#687 bundle (§4) |
| **The correction the maintainer called** | the after-completion deadline offset is **CLAMPED to (the period in days − 1)**, and a typed value above it is silently replaced. DEFAULTS1 §4's "including under after-completion" is true only up to that cap (§2) |
| **A second correction the build found** | a seed that carries a DEADLINE re-anchors the whole cadence row onto the due date (DEFAULTS1 §4 says so) — so the anchor is `max(scheduled, deadline, today)`, not `max(scheduled, today)`. Getting this wrong would have been this module's one wrong claim (§3) |
| **DEFAULTS1 §11.2, explained** | its "unexplained seeding anomaly" is a DRIVER bug — a `local title="$1" … url="…$title…"` that expands the CALLER's `title` — not an app behavior (§7) |
| **A pre-existing defect, found and NOT fixed here** | promoting a to-do that already carries a deadline produces a deadlined series with a back-shifted first occurrence; it fails closed (`verify-failed`), identically with the reliance on and off (§6) |

---

## 1. What shipped

| file | what it does |
| --- | --- |
| [`src/write/vectors/ui-prefill.ts`](../../src/write/vectors/ui-prefill.ts) | the law as arithmetic: which controls a given seed PROVES, version-keyed like the shape manifest, with an off switch (`THINGS_API_PREFILL=0`) |
| [`ui-recipes.ts`](../../src/write/vectors/ui-recipes.ts) | each provable setter TAGGED with its key, one `verify-prefill` hop spliced in after the shape probe, and the pre-commit audit still derived from EVERY setter — tagged or not |
| [`ui.ts`](../../src/write/vectors/ui.ts) | the verify hop's two read legs (System Events + the ObjC date-area bridge), the driver's skip/fallback ledger, and the `settle-occurrences` dependency gate |
| [`promote-clone.ts`](../../src/write/promote-clone.ts) | SEED SHAPING: a deadlined rule's seed is scheduled ON THE DUE DATE and stays deadline-free (DEFAULTS1 §9.3 option B) |
| [`repeat-rule.ts`](../../src/write/repeat-rule.ts) | the after-completion offset cap, refused before dispatch (§2) |

**The safety property, stated once.** The arithmetic only ever NOMINATES a control; the dialog decides, by being read. A control that disagrees — or that will not read at all — comes back `miss` and its setter runs exactly as before. The pre-commit audit (CGRD1) then re-reads EVERY control of the requested rule, pre-filled or driven, at the same cost as before, and still refuses the commit fail-closed on any mismatch. There is no state of the world in which a wrong pre-fill becomes a wrong rule: either the read confirms the value the audit will later demand, or the certified setter writes it.

---

## 2. §clamp — the maintainer's correction, measured

Observed by the maintainer on Things 3.23.2 and commissioned as a cell: the pre-filled `and start N days earlier` is FREQUENCY-DEPENDENT. A fixed cadence preserves a far-future offset while `after completion` shows a much smaller number, and switching back restores it. Two hypotheses were offered — the clamp is the interval expressed in days, or a start cannot precede the item's creation.

**The first is right, and it is exact.** Six seed deadline offsets × six after-completion unit/interval pairs, each read without touching anything else (the dialog is escaped, never committed):

| seed offset | `1 day` | `3 days` | `1 week` | `2 weeks` | `1 month` | `1 year` | fixed weekly/monthly/yearly |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | 0 | 2 | 3 | 3 | 3 | 3 | 3 |
| 7 | 0 | 2 | **6** | 7 | 7 | 7 | 7 |
| 8 | 0 | 2 | **6** | 8 | 8 | 8 | 8 |
| 14 | 0 | 2 | **6** | **13** | 14 | 14 | 14 |
| 30 | 0 | 2 | **6** | **13** | **29** | 30 | 30 |
| 45 | 0 | 2 | **6** | **13** | **29** | 45 | 45 |

**LAW (DEFAULTS2-1).** *Under `after completion, every N <unit>`, the pre-filled start offset is `min(the row's own deadline − start, P − 1)`, where P is the period in days with a month taken as **30** and a year as **365**. A FIXED cadence has no cap at all.* Every cell above is that expression; `1 month → 29` and `1 year → 364` are what fix the two calendar-naive constants.

Semantically it is a coherent constraint rather than a bug: a start `P` days before the due date would fall on or before the PREVIOUS occurrence's due date, so the series would overlap itself. It is presented, though, in a way that is not coherent (§2.1).

### 2.1 The clamp is applied SILENTLY to a typed value, and the landed rule carries the replacement

The decisive question was whether the cap is a pre-fill heuristic or a hard rule. It is a hard rule, enforced by substitution:

```
after completion, every 1 week   pre-filled 6   typed 30 → field shows 6   landed tp=1 fu=256 fa=1 ts=-6
after completion, every 3 days   pre-filled 2   typed 30 → field shows 0   landed tp=1 fu=16  fa=3 ts=0
```

No refusal, no visible sign that the number shown is not the number typed, and the committed rule carries the substitute. (The two substitutions differ — the clamp in one arm, zero in the other — which is consistent with per-keystroke validation of `3` then `0` against different ceilings; the campaign did not chase it further, because either way the value is not the one entered.) Recorded in [things-app-oddities.md](../things-app-oddities.md) §32.

And the fixed-cadence arms committed cleanly at 30 and 45 days — `ts=-30` and `ts=-45` — confirming there is no cap there.

### 2.2 What the build does about it

**Three things, and the third is the one that matters.**

1. **The offset is never claimed under after-completion.** The fixed-cadence arithmetic is simply not the after-completion value, and a wrong prediction must never become a claim — so `start-earlier` keeps its actuation there whatever the seed holds. (This also disposes of a subtler hazard the cell exposed: the clamp is applied when the unit or interval CHANGES, not continuously, so switching to a fixed cadence and back leaves an un-clamped value sitting in an after-completion state. A read taken under the opening after-completion default is not a fact about the fixed-cadence state, and vice versa. The verify hop runs only AFTER the frequency is selected, which is what makes every other key's read a fact about the state that will be committed.)
2. **The request is REFUSED before dispatch** when `--after-completion` asks for an offset at or above its period, naming the cap and the two ways out. The drive would in fact have caught it — the pre-commit audit re-reads the offset field, and the post-drive oracle asserts the landed `startOffsetDays` against the requested one — but both of those fail a drive that never had a chance. The over-caution fail direction says refuse the request.
3. **It closes a latent defect that predates this campaign.** `--after-completion --frequency weekly --interval 1 --start-days-earlier 7` used to be accepted; the app clamped it to 6, and the drive then failed closed on the audit. Two engine cells were asserting exactly that shape (offset 7 under `every 1 week`) and are re-pitched at 5, inside the cap.

---

## 3. §anchor — a seed's DEADLINE re-anchors the row, and the arithmetic has to say so

DEFAULTS1 §4 cell S11 is emphatic: with a 3-day gap between start and due, *everything* the dialog pre-fills is derived from the DEADLINE — `Next:` is the due date, the weekly weekday is the due date's, the monthly day is the due date's. The first cut of `ui-prefill.ts` computed the anchor as `max(scheduled, today)` and ignored the deadline entirely.

**That would have been this module's one wrong claim, on an ordinary shape.** `things todo make-repeating <a to-do that already has a deadline>` clones the deadline along with the content, so the dialog opens anchored on the due date while the rule asks for the start's geometry. The arithmetic would have nominated `Next:` and the weekday for the START — and the read would have caught it (that is the design working), but a module whose contract is "prove it before you claim it" should not have needed catching.

**LAW (DEFAULTS2-2).** *The anchor is `max(the row's scheduled date, the row's deadline, today)*. One maximum fits every measured cell of DEFAULTS1 §4, the flattened case included: S11 (deadline after the start) anchors on the deadline, S12 (deadline BEFORE the start — discarded by the dialog, oddities §31) anchors on the start, S10 (equal) on either.

One state is excluded outright: **a deadline with NO scheduled date proves nothing at all.** DEFAULTS1 §10.3 measured a pre-filled anchor and offset that agree with neither date and could not explain the arithmetic, so there is no prediction to make and none is made.

---

## 4. What the build is worth, measured

Both columns are the SHIPPED CLI on the SAME clone, same fixtures, same golden: `off` is `THINGS_API_PREFILL=0` (the drive exactly as it stood on the post-#687 bundle — this is DEFAULTS1 §9.1's `baseline` cell re-run as its own note asks), `on` is the reliance live.

| arm | command (`things todo make-repeating <seed>`) | off hops/rt/el | on hops/rt/el | delta |
| --- | --- | ---: | ---: | --- |
| **0** | `--frequency monthly --interval 1 --after-completion` | 14 / 111 / 36 | 14 / 97 / 24 | 0 hops · **−14 rt (−13 %)** · **−12 el (−34 %)** |
| **W** | `--when 2026-07-09 --frequency weekly --interval 1` | 16 / 119 / 73 | **14 / 93 / 53** | −2 hops · **−26 rt (−22 %)** · **−20 el (−28 %)** |
| **M** | `--when 2026-07-09 --frequency monthly --interval 1` | 17 / 146 / 119 | **14 / 93 / 55** | −3 hops · **−53 rt (−37 %)** · **−64 el (−54 %)** |
| **Y** | `--when 2026-07-09 --frequency yearly --interval 1` | 18 / 165 / 140 | **14 / 95 / 62** | −4 hops · **−70 rt (−43 %)** · **−78 el (−56 %)** |
| **WD** | `--when 2026-07-09 --deadline --start-days-earlier 3 --frequency weekly --interval 1` | 18 / 168 / 108 | **16 / 142 / 88** | −2 hops · **−26 rt (−16 %)** · **−20 el (−19 %)** |
| **MD** | the same, monthly | 19 / 195 / 155 | **16 / 142 / 91** | −3 hops · **−53 rt (−28 %)** · **−64 el (−42 %)** |
| **M3** | `--when 2026-07-09 --frequency monthly --interval 3` | 17 / 157 / 119 | **15 / 131 / 93** | −2 hops · **−26 rt (−17 %)** · **−26 el (−22 %)** |
| **R** | `--when 2026-07-09 --reminder 09:30 --frequency weekly --interval 1` | 19 / 124 / 75 | **16 / 95 / 55** | −3 hops · **−29 rt (−24 %)** · **−20 el (−27 %)** |

Every arm exited 0 and landed the correct rule; §5 has the byte-comparison.

### 4.1 Reading the numbers against DEFAULTS1's prediction — and where they differ

DEFAULTS1 §9.2 predicted **16 → 12 hops / 147 → 70 round-trips / 59 → 26 elements** for the weekly shape. The measured landing is **16 → 14 / 119 → 93 / 73 → 53**, and the three gaps have three separate, nameable causes.

- **The BEFORE column moved, because VOPAT2 landed in between.** DEFAULTS1's baseline was v0.20.6 (147 rt); on the post-#687 bundle the same arm is 119 rt, because `settle-occurrences` now dispatches no hop at all and `select-next-occurrence` costs 7 round-trips instead of 16. That is the two hops DEFAULTS1's own note said were "already banked". Elements went the other way (59 → 73) — VOPAT2's plural reads realize more elements per event, which is exactly the trade its §4 describes and the reason RDLAT2's cost law insists the two terms are never collapsed.
- **The recipe spends ONE hop that DEFAULTS1's arithmetic did not budget: the verify-by-read hop itself** (19 round-trips, 19 elements on the weekly shape). DEFAULTS1 assumed the reads could be folded into the existing steps. They cannot be, cheaply: the controls it must read are addressed at SHAPE-MEASURED indices, so the read has to follow `probe-dialog-shape`, and it must precede every setter. Folding it INTO the shape probe would fuse a structural question with a rule-specific one and put the probe's fail-closed refusal — the thing that stops the driver pressing indices into a redesigned dialog (VOPAT2 §6.3, and a standing ruling) — behind a rule-dependent script. It is one hop against the three to five it removes, and it is the honest place for it.
- **A 12-hop drive was never reachable for the weekly shape**, because the preamble (census, reachability, reveal, activate, census, observer arm, menu resolve, eligibility, press, dialog-open) is 10 hops before the dialog is even open. 14 is frequency + shape probe + verify + audit-with-folded-commit on top of that, which is the floor this recipe has.

**What DEFAULTS1 got right is the shape of the win**: the interval hop is gone, and it was the most expensive one in the drive (29 round-trips and 38 elements on the post-#687 bundle, typing nothing); so are the weekday converge, both monthly/yearly anchor pop-ups, the yearly month, `select-next-occurrence`, and — where nothing was driven — the occurrence settle.

### 4.2 Predicted M1 delta

Arithmetic, not measurement (RDLAT2's fitted field constants: ~47 ms per round-trip, ~124 ms per hop of process/settle overhead, and the element term left to a field trace per the harness's do-not-carry-a-multiplier corollary):

| shape | round-trips saved | hops saved | **predicted M1 saving** |
| --- | ---: | ---: | ---: |
| weekly | 26 | 2 | **≈1.5 s** |
| monthly day-N | 53 | 3 | **≈2.9 s** |
| yearly | 70 | 4 | **≈3.8 s** |
| weekly + deadline | 26 | 2 | **≈1.5 s** |
| monthly + deadline | 53 | 3 | **≈2.9 s** |
| monthly, interval 3 | 26 | 2 | **≈1.5 s** |
| reminder (weekly) | 29 | 3 | **≈1.7 s** |
| after-completion | 14 | 0 | **≈0.7 s** |

Against VOPAT2 §7's predicted ≈7.5–8.0 s post-#687 baseline for the field's own weekly command, that is **≈6.0–6.5 s** — within DEFAULTS1's 6.2–6.7 s prediction for the same shape, reached by a different route. The element term is not in that arithmetic and is the largest remaining unknown: 20 to 78 fewer elements realized per drive, at the sidebar's measured ~115 ms apiece, would be seconds more — but RDLAT2 measured the Repeat SHEET's content reads costing what geometry reads cost, so the sidebar figure is an upper bound here, not a prediction. **A field trace of one anchor-bearing drive is what would price it**, and it remains the open item DEFAULTS1 §13 left.

### 4.3 The ledger, per drive

Every drive records what the read confirmed and which setters it therefore skipped (`phase: "ui-prefill"`). The weekly arm:

```
confirmed: interval, weekdays, next
skipped:   interval = 1 [interval]; weekdays = thursday [weekdays]; Next (first occurrence) = 2026-07-09 [next]
drove:     frequency = weekly (select-popup)
settles skipped: the first-occurrence pop-up absorbing the rule change: nothing-driven
```

and the yearly one confirms five keys (`interval, yearly-month, yearly-mode, yearly-ordinal, next`), leaving the frequency selection as the drive's only actuation before the audit commits.

**The deadlined arms are where the seed shaping shows.** `WD` confirms `next = 2026-07-12` — the DUE date — and `weekdays = sunday`, which is the due date's weekday: the clone was rescheduled onto the due date before the dialog opened, so the anchor came up right and only the deadline checkbox and the offset field were driven. The landed rule is the requested one, `of=[{wd=0}] ts=-3 next=2026-07-09 icStart=2026-07-09` — the app back-shifting the start by N, exactly as YANCH1/NEXTPOP1 describe.

### 4.4 The reminder time is READABLE after all — DEFAULTS1 §13's open item, closed

DEFAULTS1 §5 could read `Add reminders` but not the time: `value of <element> as text` returns empty, and §13 recorded that "if a future recipe ever needs to VERIFY the time rather than trust the row, that read needs a working spelling". The spelling already shipped. The control's value is an NSDate — unreachable from System Events, read directly by the ObjC bridge the pre-commit audit's own date-area leg has always used. So the reminder is not trusted, it is verified like every other key: the `R` arm's ledger confirms `add-reminders` AND `reminder-time`, both actuations are skipped, and the template lands `reminderTime=635437056` — the seed's 09:30, intact, which is DEFAULTS1-3 re-confirmed through the shipped CLI rather than a raw drive.

---

## 5. Certification

Everything below through the production CLI against the guest SQLite oracle, and everything **run twice** — once with the reliance live (`on`) and once with `THINGS_API_PREFILL=0` (`off`), because the full recipe is the fallback and a fallback that is not certified is not a fallback.

### The rule blobs (`baseline` + `after`)

**8/8 arms byte-identical between the two paths** (`quote(rt1_recurrenceRule)` compared in full):

| arm | 0 | W | M | Y | WD | MD | M3 | R |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| blob `on` == `off` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### The state matrix (`states`)

| cell | drive | landed rule | on | off | blob on==off |
| --- | --- | --- | --- | --- | --- |
| S1 fixed | `make-repeating --when 2026-07-09 --frequency monthly --interval 2` | `fa=2 fu=8 of=[{dy=8}]` | **PASS** | **PASS** | ✅ |
| S2 after-completion | `--frequency weekly --interval 3 --after-completion` | `tp=1 fu=256 fa=3` | **PASS** | **PASS** | ✅ |
| S3 deadlines (the #646 shape) | `--when 2026-07-09 --frequency weekly --interval 1 --deadline --start-days-earlier 2` | `fa=1 fu=256 ts=-2 of=[{wd=6}]`, deadline sentinel set | **PASS** | **PASS** | ✅ |
| S4 ends-count (HXPC1) | `reschedule-repeat --frequency daily --interval 3 --ends-after 4` | `fa=3 fu=16 rc=4` | **PASS** | **PASS** | ✅ |
| S5 paused | `pause-repeat` then `resume-repeat` | rule intact across both, `paused=1` → `0` | **PASS** | **PASS** | — |
| S6 reminder | `add-repeating --when 2026-07-09 --reminder 09:30 --frequency weekly --interval 1` | `of=[{wd=4}]`, template `reminderTime=635437056` | **PASS** | **PASS** | ✅ |

S3 is the seed-shaping cell: `of=[{wd=6}]` is SATURDAY, the weekday of the DUE date (2026-07-09 + 2), while `next`/`icStart` hold the requested start 2026-07-09. **S4 is the reschedule cell and it is deliberately untouched by this campaign** — a reschedule dialog opens PRE-POPULATED from the existing rule, so none of the defaults law applies to it (DEFAULTS1 §9.5) and no seed is threaded to it; the cell proves that path is unmoved.

### The guard cells (`cells`, both TAGs)

| cell | what it proves | on | off |
| --- | --- | --- | --- |
| census 2×2 | `sheetKind: "repeat"`, `sheetForm: "attached"`, `sheetControls: "cb:2 pu:1 bt:2 gp:1 tf:0"` — printed in full in all four quadrants, identical in both paths | **PASS** | **PASS** |
| C2 | a drive started with a stranded dialog refuses, commits nothing | **PASS** — exit 4 `blocked:environment`, bravo non-repeating (0) | **PASS** |
| S | an already-set rule drives and discloses | **PASS** — exit 0, template minted (1) | **PASS** |
| T | focus theft mid-drive refuses with nothing typed | **PASS** — exit 3, **wording unchanged** (`ui drive stopped at "interval = 3"`), charlie non-repeating (0) | **PASS** |
| X | the MODALX1 open-dialog preflight refuses before anything is pressed | **PASS** — exit 4, delta non-repeating (0) | **PASS** |
| beeps | every certification cell | **0** | **0** |

The **T cell** is the one that could have broken: this campaign inserts a READ where setters used to be, and the per-step focus guard rides the setters. It refuses at the same step with the same sentence.

### The refusals (`refuse`)

| request | verdict | rows created |
| --- | --- | ---: |
| `--when 2026-07-16 --deadline 2026-07-12` (oddities §31 — a deadline BEFORE the start) | exit 1, `--deadline (2026-07-12) must be on or after --when (2026-07-16) — a deadline cannot precede the occurrence's own start` | **0** |
| `--start-days-earlier -3` | exit 1, `invalid startDaysEarlier -3 — expected an integer ≥ 0` | **0** |
| a deadline with no concrete `--when` | exit 1, `a repeating --deadline or --start-days-earlier needs a concrete --when date …` | **0** |

The §31 refusal is load-bearing for this campaign specifically: `ui-prefill.ts`'s offset arithmetic assumes the seed's `deadline − start` gap is non-negative, and the app's own handling of a negative one is to tick the box and show `0`, discarding the date. The CLI cannot produce the request, and that is now certified rather than asserted.

The after-completion cap (§2.2) is refused by the same validator and covered in the unit matrix (`assertRepeatRule — the after-completion offset cap`), including the property that the cap scales with the interval rather than being a constant.

### The fallback (`mismatch`)

Three arms, each landing the requested rule, each with 0 beeps:

| arm | seed | what it proves | ledger |
| --- | --- | --- | --- |
| **1** | an EVENING row (the shaping declines to move it), asked for `--when 2026-07-16` | the arithmetic DECLINES to nominate what it cannot prove, and every anchor setter runs | `confirmed: interval` · `drove: frequency, weekdays = thursday, Next = 2026-07-16` · settle NOT skipped |
| **2** | the same, with `THINGS_TZ=Pacific/Kiritimati` splitting the CLI's today from the app's | **the shaping is strong enough that even a deliberately split clock cannot produce a wrong claim** — the clone was rescheduled onto the requested date, so the read CONFIRMED | `confirmed: interval, weekdays, next` |
| **3** | a source that already carries a DEADLINE (the §3 shape) | the deadline-aware anchor declines both anchor keys, and both setters run | `confirmed: interval` · `drove: frequency, weekdays = thursday, Next = 2026-07-09` |

Arms 1 and 3 land `of=[{wd=4}]` (Thursday — the request's weekday, not the pre-fill's Sunday) and arm 2 lands `of=[{wd=1}]` with `next`/`icStart` on the requested date. **The settle gate proves itself in both directions**: skipped as `nothing-driven` where nothing was driven, and dispatched where a setter moved the anchor.

**The read-level miss branch — a key nominated and then read WRONG — is certified in the unit matrix, not here, and that is the honest place for it.** With the arithmetic correct and the seed shaping in play, the campaign could not construct a CLI invocation on 3.23 that produces one; arm 2 was built to force it and the shaping defeated it. `test/engine/write-ui-vector.test.ts` injects a `miss` verdict into the driver directly and asserts the consequence: only that control's setter dispatches, the other skips stand, the audit still runs, and the drive still commits. A verify hop that fails outright is covered by the same suite (every setter runs).

---

## 6. A pre-existing defect this campaign found and did NOT fix

`things todo make-repeating <a to-do that carries a deadline>`, with no `--deadline` in the request, produces a DEADLINED series with a back-shifted first occurrence:

```
seed: startDate=2026-07-09 deadline=2026-07-12   ·   make-repeating --frequency weekly --interval 1
landed: tp=0 fu=256 fa=1 ts=-3 of=[{wd=4}] next=2026-07-06 icStart=2026-07-06, template deadline=4001-01-01
exit 3 · verify-failed:mismatch — "its first occurrence landed on 2026-07-06, not the requested 2026-07-09"
```

The clone inherits the source's deadline, so the dialog opens with `Add deadlines` already ticked and an offset already filled; the recipe is requested-fields-only and correctly does not touch a control the caller did not address, so the deadline rides into the committed rule and the app back-shifts the start by 3 days. **It fails CLOSED and it is not a DEFAULTS2 regression** — run both ways on the same clone it produces exit 3 and a byte-identical rule blob with the reliance on and off.

The symmetric fix exists in the add path already: `mapDeadlineOntoRule` lifts a concrete deadline OFF the seed and onto the rule precisely so the seed cannot carry one (DBLSPAWN1 cell C). The make path has no equivalent because it does not mint the content — it clones it. Whether promoting a deadlined to-do SHOULD produce a deadlined series is a maintainer decision, not a build detail, so it is recorded here and left.

---

## 7. Two rig lessons

### 7.1 DEFAULTS1 §11.2's "unexplained seeding anomaly" is a driver bug, and here it is

That campaign recorded three `things:///add?title=DEF1-TIMINGD2…` dispatches each creating a row titled `DEF1-TIMING2` — the PREVIOUS fixture's title — with the requested deadline, and could not reproduce it in isolation. This campaign reproduced the same signature (4/4 retries), chased it as an app behavior through four probe scripts, and then found it in the shared `mkseed` helper both drivers use:

```sh
mkseed() {
  local title="$1" when="$2" dl="$3" url="things:///add?title=$title&auth-token=$TOKEN" u i
```

Bash expands a `local` command's entire word list BEFORE performing any of its assignments, and its scoping is DYNAMIC — so `$title` in the `url=` assignment is the CALLER's `title`, not `$1`. DEFAULTS1's `cell_timing` mints `DEF1-TIMING2` into a local named `title` and then calls `mkseed "$t2"` for the D-suffixed fixture, which builds a url for `DEF1-TIMING2` carrying `$3`'s deadline — precisely the three rows §11.2 records. **The app was doing exactly as it was told.** A caller with no `title` in scope dies instead, with `title: unbound variable` under `set -u`, which is how it was finally cornered.

The helper here splits the assignments, and `mkseed` now prints the last three rows created when a read-back misses, so a seed that lands under the wrong title is named in one line instead of hiding behind "no row". (DEFAULTS1 is an immutable snapshot per the version-stamping policy and is not edited; the correction lives here.)

### 7.2 An interval typed into a field swallows the pop-up click that follows it

The clamp cell first walked its unit/interval pairs interval-first. Every pop-up selection after a `settf` was SWALLOWED — the unit never moved, and the beep count trebled — while unit-first worked every time. That is [VOPAT2 §5.2](vopat2-screen-reader-build.md)'s swallowed-click class arriving from a third direction: the field is still committing its keystroke when the click arrives. Recorded because the shipped recipe drives the after-completion unit BEFORE the interval, and now there is a measured reason for that order rather than a historical one.

Also worth naming: the after-completion unit pop-up PLURALIZES by interval (`week` at 1, `weeks` above), so a cell that walks intervals must offer BOTH spellings or it silently stops selecting exactly where the interval moves — the 0½ defect (c) the shipped `selectPopupAny` already handles, met again in a probe.

---

## 8. Cells and verdicts

| cell | what it establishes | verdict | beeps |
| --- | --- | --- | ---: |
| `clamp` | the after-completion offset cap, its exact expression, and what a typed value above it does | **PASS** — `min(offset, P−1)` fits 36/36 read cells; typed values silently replaced | 6/arm (a probe driving 12 pop-ups per dialog; the committed arms were 0) |
| `baseline` | the shipped drive with the reliance OFF, traced | **8/8 exit 0**, correct rules | 0 |
| `after` | the same arms with verify-by-read live, traced | **8/8 exit 0**, correct rules, **8/8 byte-identical blobs** | 0 |
| `states` | the manifest's dialog states, both paths | **6/6 × 2 PASS**, 4/4 comparable blobs identical | 0 |
| `mismatch` | the fallback path, three forcings | **3/3 PASS** — the requested rule landed every time | 0 |
| `refuse` | the pre-dispatch refusals incl. oddities §31 | **3/3 refused, 0 rows created** | — |
| `cells` | census 2×2 + C2/S/T/X, both paths | **PASS × 2**, wording unchanged | 0 |

`crash = ALIVE`, `ips = 0` on every cell.

## 9. What this leaves open

- **The element term on real hardware.** 20–78 fewer elements realized per drive is the largest saving this campaign makes and the one a clone is systematically blind to (RDLAT2 §E's corollary). A field trace of one anchor-bearing drive would price it, and it is the same open item DEFAULTS1 §13 left.
- **Option A (the deadline ON the seed).** DEFAULTS1 §9.3 measured it at −62 % against option B's −44/−47 %, and it needs the DBLSPAWN1 matrix re-run through the CLI with a deadlined seed before it can be adopted. Nothing here changes that; `ui-prefill.ts` already computes the two deadline keys correctly for the day it is.
- **Promoting a deadlined to-do** (§6) — a maintainer decision about what the verb should MEAN, not a defect in this build.
- **`reschedule-repeat`'s pre-populated dialog** (DEFAULTS1 §9.5) — the same question asked of an existing rule, untouched here and deliberately given no seed.
- **Projects.** `project.make-repeating` is wired to the same arithmetic and drives the same sheet, but every cell here is a to-do.
- **The two substitutions a typed over-cap offset produces** (§2.1) — 6 in one arm and 0 in another; the campaign recorded both and did not explain the difference, because the CLI refuses the shape either way.
