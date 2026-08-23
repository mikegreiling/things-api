# VMRES1 — four residual cells: the #508 certification, the clone residuals (d)/(e), the Today axis under a PROJECT row, and the off-rule Next

**Probed under: `things-lab-golden-v4` · Things 3.23 (CFBundleVersion 32300036, direct-download channel) · macOS 15.7.7 · `Meta.databaseVersion` 27 · guest clock pinned 2026-07-05 12:00 (a Sunday), rolled to 2026-07-06 for cell 4.** ONE disposable clone of golden-v4 (the golden was never booted; every write inside the clone), airgapped (default route deleted), clock pinned before Things launched. Ground truth = read-only guest SQLite (`~/labh/rsum.py` decodes the rule blob + cursor + pause flag; `~/labh/today.py` dumps the Today comparator triple `todayIndexReferenceDate DESC, todayIndex ASC, uuid` — `src/read/views.ts`). CLI exit 0 and `open` exit 0 both prove nothing on their own. Fixtures fully synthetic (`VMRES1-*`). Driver: [`lab/scripts/research-vmres1.sh`](../../lab/scripts/research-vmres1.sh) (`KEEP=1` holds the clone, `REUSE=1` re-attaches to it, `RTAG=` scopes cell 3c's fixture titles). Artifacts (gitignored): `lab/artifacts/vmres1-lab/`.

Immutable snapshot per the [harness](harness.md) version-stamping policy; version *confirmations* accrue in the [assumption register](../reference/assumption-register.md), never here.

Packed dates decode `y<<16|m<<12|d<<7`. `next` = `rt1_nextInstanceStartDate`, `icStart` = `rt1_instanceCreationStartDate` (the spawn cursor), `icCount` = `rt1_instanceCreationCount`, `tIdx`/`tRef` = `todayIndex`/`todayIndexReferenceDate`.

---

## Verdicts at a glance

| Cell | Question | Verdict |
|---|---|---|
| **1** | Does the shipped #508 fix (#540) make `add-repeating --after-completion` exit 0? | **CERTIFIED** — 3/3 shapes exit 0; the pre-fix oracle value is reproduced verbatim in the same rows |
| **2 (d)** | Does a PROJECT-template clone keeping the source's title+area land cleanly? | **CERTIFIED — after fixing a real shipped bug** the cell exposed (a select-row readback race; 0/3 → 4/4) |
| **2 (e)** | Does a PAUSED source clone UNPAUSED, disclosed? | **CERTIFIED** |
| **3** | What does `update-project?when=<today>` do to a project's `todayIndex`? | **FRONT-INSERT at the cohort minimum** — the ORD-12 / SIT3 EVEPROJ "mid-pack" caveat does NOT hold on 3.23 |
| **3b/3c** | Does a per-KIND today bounce land the requested order? | **DETERMINISTIC 2/2** (protocol) and **CERTIFIED** through the shipped `things reorder --in today` — the leg SHIPPED |
| **4** | Is the deadlined off-rule Next-SNAP `icCount`-dependent? | **MOOT on 3.23** — the Next control is an occurrence POP-UP, so an off-rule first occurrence has no surface at any `icCount`. A separate 3.23 regression surfaced (§4.3) |

---

## 1. #508 — the after-completion verify oracle: CERTIFIED

The shipped fix (#540, `landedFirstStart` in `promote-clone.ts`) picks the post-drive first-occurrence oracle by rule kind. Three after-completion shapes, all with a FUTURE `--when`:

| shape | command | exit | landed template |
|---|---|---|---|
| **add-repeating** | `todo add-repeating VMRES1-AC --after-completion --frequency weekly --interval 1 --when 2026-07-20` | **0** | `tp=1 fu=256 fa=1 next=2026-07-20 icStart=2026-07-06 icCount=0` |
| **make-repeating** | seed `--when 2026-07-21`, then `todo make-repeating … --after-completion --frequency weekly --interval 1` | **0** | `next=2026-07-21 icStart=2026-07-06 icCount=0` |
| **make-repeating, deadlined source** | seed `--when 2026-07-20 --deadline 2026-07-25`, then the same promote | **0** | `ts=-5` deadline sentinel · `next=2026-07-20 icStart=2026-07-06 icCount=0` |

**The cell reproduces the exact pre-fix failure condition.** `firstOccurrenceOf` — the oracle the fix replaced — reads `rt1_instanceCreationStartDate`, and in all three rows that column is **`2026-07-06` = the pinned clock + 1 day**, while `--when` was `2026-07-20`/`2026-07-21`. That is precisely #508's live report ("the first occurrence landed on \<today+1\>"), so these rows would have exited 3 with `verify-failed:mismatch` under the old oracle and exit 0 under the shipped one. Nine-step drive each (`frequency = after completion → after-completion unit = weekly → interval = 1 → OK`), no Next drive, no crash, no `.ips`.

**Which branch of the fix actually runs, and why the other is unreachable here.** All three templates carry **zero materialized instances**, so `landedFirstStart` returns `null` and the check is SKIPPED — the fix's "an unverifiable after-completion series skips rather than fail a sound creation" branch. The instance branch could not be exercised: the deadlined-source shape was chosen precisely because a deadline is a SRCFATE *preserve* trigger, and on 3.23 it did not preserve — the promote mapped the concrete `--deadline` onto the RULE (`ts=-5`, the DBLSPAWN1 derivation) and moved the seed to the Trash like any DELETE-fate promote. So on this golden **no after-completion promote leaves an instance to verify against**, and the skip branch is the whole live surface. The instance oracle stays unit-covered (`test/engine/write-promote-clone.test.ts`).

**Observation worth its own line — an after-completion template DOES carry a cursor column, just not the one the old oracle read.** `rt1_nextInstanceStartDate` holds the requested date verbatim (`2026-07-20` / `2026-07-21` / `2026-07-20`) even though the recipe never drives "Next:" — the app anchors it from the seed's own `startDate`. The `RSIM2` / `RSIM-P P4` reading that an after-completion template has "no next/reference dates until a completion happens" is therefore half-true on 3.23: `icStart` is today+1 and `next` is the seed's date. This does NOT argue for changing the shipped oracle — skipping is strictly safer than trusting a column whose provenance is the seed rather than the drive — but a future reader should not be surprised to find `next` populated. (`todo pause-repeat` clears it to NULL, cell 2(e).)

---

## 2. Template-direct clone — residual cells (d) and (e)

### 2(e) — a PAUSED source clones UNPAUSED, disclosed: CERTIFIED

`todo make-repeating VMRES1-PAUSE --frequency weekly --interval 1 --weekdays tuesday` → `todo pause-repeat` → `todo clone`.

| | rule |
|---|---|
| source after pause | `of=[{wd=2}] next=None icStart=2026-07-07 icCount=0 **paused=1**` |
| clone | `of=[{wd=2}] next=2026-07-07 icStart=2026-07-07 icCount=0 **paused=0**` |
| source after clone | unchanged (`paused=1`, `next=None`) |

Exit 0. Rule bytes EXACT (`of=[{wd=2}]` = Tuesday), the clone is a new series with its own identity, the source is untouched and stays paused, and the disclosure is verbatim: *"the source template was PAUSED; the new series is created UNPAUSED and begins spawning — pause it with `things todo pause-repeat` if you want it suspended"*. Note in passing that `pause-repeat` CLEARS `rt1_nextInstanceStartDate` (`2026-07-07` → NULL) and `resume` is what restores it — the pause is a cursor clear, not a flag alone.

### 2(d) — a PROJECT-template clone keeping the source's title + area: CERTIFIED, after a real bug

`things area add VMRES1-AREA` → `project add-repeating VMRES1-PT --area VMRES1-AREA --when 2026-07-07 --frequency weekly --interval 1 --weekdays tuesday` → `project clone <template>`.

Final state: exit 0, a second template row minted in the SAME area with the SAME title, rule bytes exact on both, source untouched.

| row | type | area | template? | rule |
|---|---|---|---|---|
| `YQxXp5Zk` (source) | project | `QtF2oMxe…` | yes | `of=[{wd=2}] next=2026-07-07 icStart=2026-07-07 icCount=0` |
| `8GPsD1pt` (clone) | project | `QtF2oMxe…` | yes | `of=[{wd=2}] next=2026-07-07 icStart=2026-07-07 icCount=0` |

The `sameTitleRowCount` template-exclusion this cell was written to exercise (pre-state.ts — hidden template rows are excluded from the project promote's row-select ambiguity check) works as designed: the pre-clone count of VISIBLE same-titled projects is 0, the promote is not refused, and when a *visible* duplicate does exist the check correctly refuses (`BLOCKED (H-PROJECT-REPEAT): another project titled "VMRES1-PT" shares this area`, observed while cleaning up between attempts).

#### 2(d) found a shipped bug: `select-row` could return a false OK and leave NOTHING selected

**The first attempt failed** — `verify-failed:silent-noop`, the drive stopping at *"Items ▸ Repeat… (enabled once the project row is selected)"*, the plain clone created and the promote not landing (fail-closed, with the correct "trash the clone and retry" remediation). It then reproduced **deterministically**, and the pattern was not the disambiguation the cell was probing:

| attempt | preceded by a Things relaunch? | result |
|---|---|---|
| 1 | no (ran right after `project add-repeating`'s dialog) | exit 3 `verify-failed:silent-noop` |
| 2 | **yes** | exit 0 |
| 3 | no | exit 3 |
| 6 | **yes** | exit 0 |
| 7 | no | exit 3 |

**0/3 without a relaunch, 2/2 with one** — the signature of a race, not of app state. Two measurements localized it:

1. **After a FAILED drive, `id of selected to dos` is `-none-`.** The table had nothing selected, which is exactly why `Items ▸ Repeat…` never materialized — so the drive's `wait` was reporting the truth. Its predecessor was lying.
2. **A row-by-row walk shows the selection readback LAGS the `select` action.** Selecting row 3 (the clone) leaves `selected of row 3` true; selecting row 4 — a blank spacer that takes no selection — leaves `selected of row 4` FALSE while `name of selected to dos` still reports row 3's title. The dev-mode trace confirms the drive's own step order and timing (`select-row` ok, then the Repeat… wait polling every ~300ms for the full 5s in the failing run, satisfied on the first poll in the passing one).

So `axSelectRowScript` — which selected each row and read the title back with **no settle and no per-row selection check** — matched on a stale readback, returned `"OK"` one row LATE, and left the table with the selection cleared by that last `select`. A warm app races there; a freshly relaunched one does not, which is the whole of the relaunch correlation.

**Fix (shipped in this change, `src/write/vectors/ui.ts`):** settle after `select`, then require `selected of (row i of theTable)` — the row THIS iteration targeted must itself hold the selection — before trusting the title readback. This is exactly the guard its sibling `axSelectHeadingRowScript` already carried; the two primitives were simply not written to the same standard. Certification after the fix, all in ONE Things session with no relaunch between drives:

| drive | exit | post-drive selection | clone rule / area |
|---|---|---|---|
| 1 | 0 | the new template | `of=[{wd=2}]` · same area |
| 2 | 0 | the new template | `of=[{wd=2}]` · same area |
| 3 | 0 | the new template | `of=[{wd=2}]` · same area |
| 4 (in the final clean run) | 0 | the new template | `of=[{wd=2}]` · same area |

**4/4 where it was 0/3.** The bug affected every project row-select drive — `project.make-repeating`, `project.add-repeating`, and the project template clone — not just this cell; it simply had never been driven twice in one app session before. It failed CLOSED throughout (nothing wrong ever landed).

---

## 3. `reorder --in today` with a PROJECT row — the refusal's premise is false on 3.23

The open question ([gv4-323-certification](gv4-323-certification.md) §1.5) was what `update-project?when=<today>` does to a project row's `todayIndex` relative to the day group, and whether any park+re-enter MOVE protocol reaches the Today axis for a project. Fixtures: four to-dos and two projects, all `when=today` at the pinned clock, measured against the full Today cohort.

### 3.1–3.6 — the placement leg

| cell | gesture | `tIdx` before → after | cohort min before | reading |
|---|---|---|---|---|
| **3.1** | `update-project?when=today` on a row ALREADY in Today | −2488 → **−2488** | −3123 | **NO-OP** — every column byte-identical. The row must leave the day first |
| **3.2** | park `when=anytime` (tIdx held, `tRef`/`startDate` cleared) then `when=today` | −2488 → **−3548** | −3123 | **FRONT-INSERT** below the cohort minimum |
| **3.3** | three more identical round-trips | −3548 → **−3548** ×3 | −3548 | idempotent AT the front (the app front-inserts against the min of the OTHER members) |
| **3.4** | control: the same bounce on a TO-DO | −417 → **−3957** | −3548 | front-insert — projects and to-dos behave identically |
| **3.5** | the DATED spelling `when=2026-07-05` on a project | −3123 → **−4412** | −3957 | front-insert — the dated and keyword spellings agree |
| **3.6** | `when=evening` then back to `when=today` | +659 → **−5022** | −4412 | front-insert (the SHIPPED bounce's away leg is `evening`, so this is the shipped shape) |

Every re-entry lands strictly below the current cohort minimum. The gap the app leaves varies (425, 409, 1289, 610, 450) — it is not a fixed decrement — but the ORDER is deterministic, which is all a reverse-order bounce needs. `tRef` is re-stamped to today on each re-entry, i.e. the movee joins the newest entry cohort, exactly as the TODWIRE disclosure already describes for to-dos. (Noted in passing: the `when=evening` leg re-stamps `tRef` to the PREVIOUS day and sets `startBucket=1`; the return leg restores both.)

**This RETIRES the caveat the refusal rested on.** ORD-12 / SIT3 EVEPROJ recorded that "a project's `when=today` leg does NOT front-insert to the global Today minimum the way a to-do's does (project landed mid-pack)". On Things 3.23 it does front-insert, measured over five separate re-entries across both spellings and both away-legs.

### 3.7–3.8 — the two protocols that do NOT reach the Today axis

| cell | protocol | result |
|---|---|---|
| **3.7** | park+re-enter MOVE, the AREABACK/PROJROOT shape (`update-project?area-id=<scratch>` then back to the home area) | `tIdx` **UNCHANGED** (−5472) across both legs — a MOVE round-trip re-ranks the AREA `index` axis and never touches `todayIndex` |
| **3.8** | the DLBNC deadline-cycle on a project row (`deadline=` set → clear → re-set) | `tIdx` **UNCHANGED** (−4412) across all three legs — the deadline cycle is inert for a *scheduled* project's Today rank (it is a deadline-FORECAST-row mechanism, and these rows are startDate-driven members) |

So the `when=` bounce is the only surface here — and it works. Recorded so no one re-derives these negatives.

### 3b — the mixed reverse-order protocol: DETERMINISTIC 2/2

Five fresh rows (`VMRES1-M-{T1,T2,T3,P1,P2}`), target order `P1, T2, P2, T3, T1` with the projects deliberately interleaved, dispatched in REVERSE target order, each movee bounced with the leg op picked by its KIND (`update` for a to-do, `update-project` for a project):

```
before  : P2 P1 T3 T2 T1
round 1 : P1 T2 P2 T3 T1   ← target
round 2 : P1 T2 P2 T3 T1   ← target
```

### 3c — the shipped `things reorder --in today` carrying a project: CERTIFIED

With the per-type leg shipped (below), the production CLI was driven end to end:

```
$ things reorder <P1> <T2> <P2> <T3> <T1> --in today
ok todo.move: moved 5 item(s) — VMRES1-R3-P1, VMRES1-R3-T2, VMRES1-R3-P2, VMRES1-R3-T3, VMRES1-R3-T1
  placement: guaranteed — reordered within the today list (today scope — placement guaranteed)
```

| row | kind | `tIdx` |
|---|---|---|
| VMRES1-R3-P1 | project | −30433 |
| VMRES1-R3-T2 | to-do | −29933 |
| VMRES1-R3-P2 | project | −29315 |
| VMRES1-R3-T3 | to-do | −28964 |
| VMRES1-R3-T1 | to-do | −28442 |

Exit 0, the landed Today order is the requested order exactly. Pre-fix the same command exited 4 (`blocked:H-REORDER-SCOPE`, "`<uuid>` is a project — bounce re-schedules via todo.update…"), observed in this same clone before the change.

### What shipped

`bounceSpecOf("today")` now carries `legOp: "per-type"` — joining `evening` (EVEORD) and `day` (DAYBNC), which were already mixed-kind. The project refusal is keyed off `legOp === "todo.update"` and therefore lifts itself; it remains in force for the index-axis someday/anytime/heading bounces, which have no measured project front-insert law. Tests: `test/engine/write-reorder.test.ts` ("today scope: PROJECT movees (VMRES1 …)"), mirroring the existing evening-scope pair.

---

## 4. The deadlined off-rule Next — MOOT on 3.23, and a new regression

The queued question (from [vmq1-probe-closeout](vmq1-probe-closeout.md) §1) was whether the deadlined off-rule Next-SNAP is `icCount`-dependent: VMQ1's `icCount=0` template snapped and was rejected, while RSPA1 cell (b) drove the same command shape on an `icCount=1` template and COMMITTED. Both were measured on **golden-v3 / Things 3.22.14**, where "Next:" was a free `AXDateTimeArea`.

### 4.1 The 3.23 Next: control is an occurrence POP-UP, and its menu is closed

AX census of the Repeat dialog on a yearly template anchored July 7 (`pop up button 2 of group 1`):

```
Today · Tue, Jul 7, 2026 · Wed, Jul 7, 2027 · Fri, Jul 7, 2028 · … · Thu, Jul 7, 2039 · (separator) · More…
```

The menu is exactly **the rule's own upcoming occurrences, plus `Today`, plus a `More…` escape**. It is recomputed as the rule changes (setting a 14-day deadline offset dropped `Today` and appended `Jul 7, 2040`), and there is no free date entry at this level.

### 4.2 The verdict: the discrimination is moot

An off-rule first occurrence is therefore **not selectable at all** on 3.23 — independent of `icCount`, and independent of the deadline. Measured directly:

| arm | fixture | command | result |
|---|---|---|---|
| **4C** | yearly, NON-deadlined, `icCount=0`, anchor Jul 7 | `reschedule-repeat --frequency yearly --interval 1 --yearly-month 10 --on-day 16 --when 2028-11-05` | **exit 3**, `verify-failed:silent-noop`, template rule byte-unchanged, 0 instances |

with the refusal naming the cause precisely:

> `select-next-occurrence: this Repeat dialog offers only the rule's own upcoming occurrences (and today) as the first occurrence, and 2028-11-05 is not one of them — searched 6 level(s) of the Next: menu. Ask for a date the rule actually produces, or change the rule.`

The drive gets as far as the anchor pop-ups (`yearly month = 10 → monthly mode = day → monthly day = 16`), refuses at Next, Escapes, and lands nothing. **So there is no snap to be `icCount`-dependent about**: the ≤3.22 free date area accepted an off-rule date and the app silently snapped it (VMQ1) or honored it (RSPA1); the 3.23 pop-up refuses it up front, loudly and accurately. **No `assessOffRuleFirst` / validation change is warranted** — the failure is already closed, already explicit, and already names the remedy, which is more than a pre-dispatch refusal would add. The up-next entry's "kin to the DACON1 monthly snap" framing does not carry to this app version.

Recorded honestly: the arms that would have discriminated `icCount=0` from `icCount=1` **could not be staged**, because building a deadlined yearly template on 3.23 is itself broken —

### 4.3 NEW — `add-repeating --deadline <date>` on a monthly/yearly rule fails closed on 3.23

Both deadlined fixtures failed identically (2/2) while staging cell 4:

```
$ things todo add-repeating VMRES1-N1 --when 2026-07-06 --deadline 2026-07-20 \
    --frequency yearly --interval 1 --dangerously-drive-gui
VERIFY FAILED (silent-noop): … stopped at "Next (first occurrence) = 2026-07-20"
  (select-next-occurrence: … 2026-07-20 is not one of them …)
  Completed: … frequency = yearly → interval = 1 → next-popup → yearly month = 7 →
  monthly mode = day → monthly day = 20 → Add deadlines → start 14 days earlier.
… the seeded to-do was created but the promote did not land, so it was moved to the Trash
```

The drive is doing what `deadlineDriveNext` (`src/write/repeat-anchor.ts`) specifies: for a deadlined rule it drives `next + startDaysEarlier` — the DUE date — because on ≤3.22 the free date area took the deadline and the app back-shifted the start (YANCH1 #493, RSPA1 cell (a) landed `sr=2028-10-16` from a driven `2028-10-30`). Against the 3.23 pop-up that parameter does not resolve. The control discriminates cleanly: the same command WITHOUT `--deadline` (`VMRES1-NX`, `--when 2026-07-07`, anchor derived to Jul 7) succeeded, exit 0, `of=[{dy=6,mo=6}] next=2026-07-07`.

This is OUR bug, not the app's — the app's Next control changed shape (already recorded by RDLG1) and the deadlined branch of the drive was never re-certified against the new one. **Not fixed here** (cell 4's brief is recommend-don't-implement, and the fix needs its own certification arm): the open question is whether the pop-up enumerates the rule's START dates or its DUE dates once a real offset is set — the census could not separate them, because at `ts=0` the two coincide, and after setting the offset the menu still listed the anchor date. The `More…` item at the end of the menu is the other candidate route (a free picker the recipe does not currently open). Queued in [up-next](../up-next.md).

---

## Cross-references

- Cell 1 closes the VM half of #508 ([decisions.md](../design/decisions.md) 2026-08-23, the oracle-by-rule-kind ruling).
- Cell 2 closes VMQ1 §6's (d)/(e) residual; (c) remains not-live-reachable and CI-only.
- Cell 3 supersedes the [gv4-323-certification](gv4-323-certification.md) §1.5 finding's open half — that doc's refusal transcript is the honest record of 3.23-before-this-change and is left untouched, per the immutability policy.
- Cell 4 answers the vmq1-probe-closeout §1 follow-up by obsolescence and opens §4.3.
