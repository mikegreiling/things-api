# VMQ1 — VM-batchable probe queue closeout

**Probed under: `things-lab-golden-v3` · Things 3.22.14 (build 32214000) · macOS 15.7.7 · DB schema v26 · pinned clock 2026-07-05 12:00 (a SUNDAY).** Disposable clones of golden-v3 (golden untouched; every write inside the clone), airgapped (default route deleted, ping fails), clock pinned before Things launched. golden-v3 carries the baked L3-accessibility grant; the Repeat dialog was driven by the SHIPPED production CLI (`--dangerously-drive-gui`) over SSH. Ground truth = read-only guest SQLite (`~/labh/rsum.py` decodes `rt1_recurrenceRule` + cursor + `deadline` column; `OFCOUNT` = number of `of` offset entries). Fixtures fully synthetic (`I1-*`/`I2-*`/`I3`/`C1-*`/`C2`/`C6`). Drivers: [`lab/scripts/vmq1-diag.sh`](../../lab/scripts/vmq1-diag.sh), [`lab/scripts/vmq1-validate.sh`](../../lab/scripts/vmq1-validate.sh), [`lab/scripts/vmq1-sessgate.sh`](../../lab/scripts/vmq1-sessgate.sh), [`lab/scripts/vmq1-clone.sh`](../../lab/scripts/vmq1-clone.sh). Artifacts (gitignored) under `lab/artifacts/vmq1-*`.

Packed dates decode `y<<16|m<<12|d<<7`; `of` day/month indices are 0-based (`dy=19,mo=6` = July 20); weekday `wd` 0=Sun…6=Sat; `ts` = deadline-relative start offset (≤ 0); `deadline` sentinel `262213760` (`4001-01-01`) = deadlined.

---

## 1. Lone-Next-write commit inertness — **FALSIFIED** (the maintainer's priority close)

**Question (up-next, added 2026-08-19):** the live host's reschedule failure committed NOTHING (rule byte-identical, 120s zero-movement) when the drive's only material dialog interaction was the Next `AXDateTimeArea` write (the anchor pop-ups were SKIPPED by the since-fixed derivation gap). Hypothesis: a lone `AXValue` Next write does not mark the dialog dirty, so OK discards it. Probe: does a lone-Next reschedule commit or discard?

**Verdict: a lone-Next write is NOT inert — it commits.** Two decisive cells, driven by the shipped CLI on golden-v3:

| Cell | fixture / command | drove | result | landed |
|---|---|---|---|---|
| **1B — DAILY pure lone-Next** | daily template, `reschedule-repeat --frequency daily --interval 1 --when 2030-03-15` | freq=daily (no-op) → interval=1 (no-op) → **Next=2030-03-15** → OK (8 steps, **zero anchor pop-ups**) | **`ok`** in 4086 ms | `nextOccurrence=2030-03-15` — COMMITTED |
| **1A — yearly same-anchor lone-Next** | yearly template anchored Jul 20, `reschedule-repeat --frequency yearly --interval 1 --when 2030-07-20` | freq/interval/yearly-month=7/monthly-day=20 (all no-ops, same values) → **Next=2030-07-20** → OK | **`ok`** in 6324 ms | `nextOccurrence=2030-07-20` — COMMITTED |
| **1C — control (different anchor)** | same template, `--when 2031-09-15` (anchor Jul20→Sep15, a REAL pop-up change) | anchor pop-ups drive a real change → Next → OK | **`ok`** | `anchorKey=m9d15`, `nextOccurrence=2031-09-15` — COMMITTED (discriminator) |
| **1DL — DEADLINED same-anchor lone-Next** | deadlined yearly `ts=-14` anchored Jul 20, `reschedule --when 2030-07-06 --deadline --start-days-earlier 14` | freq/interval/anchor/deadline-checkbox/start-14 (all no-ops) → **Next=2030-07-20** → OK | **`ok`** | `of=[{dy=19,mo=6}]` anchor unchanged, `ts=-14` held, `nextOccurrence=2030-07-06` — COMMITTED |

Cell **1B is decisive**: a DAILY reschedule drives NO anchor pop-ups at all — frequency and interval re-selected to their current values (proven no-ops on the live host), and the ONLY value-changing interaction is the Next `AXDateTimeArea` write. It **committed** (`nextOccurrence=2030-03-15`). Cell 1A confirms the same for a yearly rule whose derived anchor is unchanged (anchor pop-ups driven as no-ops); cell 1DL confirms it once more for a DEADLINED yearly whose every rule field (anchor, deadline checkbox, start-offset) is a no-op — the closest reproduction of the live-failure conditions — which also COMMITTED. The "lone `AXValue` Next write does not dirty the dialog" hypothesis is **falsified across daily, yearly-non-deadlined, and yearly-deadlined** — the app commits a Next-only change.

**Why the live 2026-08-19 failure is now unreachable.** The live drive ran at commit `9299a94` (PERF2), BEFORE the reschedule anchor-derivation fix shipped (#503, `ab377a5`). At that commit a `--when`-only yearly reschedule did NOT derive/drive the calendar anchor, so the dialog opened pre-populated and the drive touched only Next. Post-#503 (`reschedEffParams` / `deriveFixedAnchor`), a `--when`-only reschedule DRIVES the derived anchor pop-ups for weekly/monthly/yearly (daily needs none); RSPA1 cell (a) already certified that the on-rule `--when`-only deadlined reschedule commits. The exact failing drive shape (a yearly reschedule with the anchor pop-ups SKIPPED) is no longer produced by the shipped CLI. **No deterministic-dirtying fix is warranted — the entry is closed by falsification.**

**Note — a SEPARATE deadlined off-rule Next-SNAP (not inertness).** While confirming item 4, a deadlined-yearly template with NO materialized instance (`icCount=0`) driven off-rule (`--yearly-month 10 --on-day 16 --when 2028-11-05`, anchor ≠ --when) FAILED at the Next drive: the control committed `2029-10-16` (the next on-anchor occurrence), not the requested `2028-11-05`, and the set-datetime read-back rejected it (-2700) → the drive aborted (verify-failed:silent-noop, nothing landed). RSPA1 cell (b) drove the same command shape and COMMITTED, the difference being RSPA1's template had a MATERIALIZED instance (`icCount=1`). This is an off-rule-first Next-SNAP on a deadlined yearly (kin to the DACON1 monthly snap), **not** the lone-Next inertness this entry asked about, and it fails CLOSED (the #491 asserts + set-datetime read-back catch it). Flagged for a possible follow-up probe; it does not reopen the inertness question.

---

## 2. RRF1 breadth + RRD1 blind-"+" idempotence

### RRF1 breadth (cell c) — the decoded `of`/`ed`/`rc` the asserts predict: **GREEN**

| Cell | command (on a pre-populated dialog) | landed | verdict |
|---|---|---|---|
| **2W — weekly weekday-SET change** | template `{monday}`, `reschedule --frequency weekly --interval 1 --weekdays tuesday,thursday` | `of=[{wd=2},{wd=4}]` `OFCOUNT=2` `anchorKey=w2,w4` | ✅ the weekday SET moved {mon}→{tue,thu}, exactly the predicted anchorKey |
| **2E — ends-bound change** | template `ends:after 5` (daily), `reschedule --frequency daily --interval 1 --ends-on 2027-12-31` | `endDate=2027-12-31`, `occurrenceCount=null` (`rc` cleared, `ed` set) | ✅ ends:after→ends:on-date lands the predicted `ed`/`rc` |

The full-fidelity `expectedRuleAssertions` (#491) verify the real app stores what the model predicts for the deepened POST-drive verify. No divergence — the anchorKey/decoder model is correct.

### RRD1 blind-"+" — **CONFIRMED BROKEN** (fails CLOSED)

The recipe's weekly multi-weekday path drives the FIRST weekday into `pop up button 2 of group 1`, then for each additional weekday presses "+" and RE-DRIVES the SAME `pop up button 2`. On a pre-populated multi-weekday dialog this leaves stale pre-existing rows untouched:

| Cell | pre `of` | command | landed `of` | verdict |
|---|---|---|---|---|
| **2Wb** — 1→2 rows | `[{wd=1}]` (mon) | `--weekdays tuesday,thursday` | `[{wd=2},{wd=4}]` `OFCOUNT=2` | ✅ clean (single pre-existing row overwritten) |
| **2Mb** — pre {mon,wed}, keep {mon,wed} | `[{wd=1},{wd=3}]` | `--interval 2 --weekdays monday,wednesday` | `[{wd=1},{wd=3}]` `OFCOUNT=2` | ✅ clean — the app stores weekdays as a DEDUP SET, so a transient duplicate row does not persist |
| **2Tb** — pre {mon,wed} → {tue,thu,sat} | `[{wd=1},{wd=3}]` | `--weekdays tuesday,thursday,saturday` | `[{wd=1},{wd=2},{wd=4},{wd=6}]` `OFCOUNT=4` | ❌ **BUG**: the pre-existing MONDAY row survived un-overwritten → `{mon,tue,thu,sat}`. Caught fail-closed as **verify-failed:mismatch** (`anchorKey` observed `w1,w2,w4,w6` ≠ expected `w2,w4,w6`) |

**Reconciliation:** the app's weekday storage is a dedup SET (2Mb: a duplicate weekday row does NOT persist — so the original "duplicate rows" fear is not the failure mode). The REAL defect is **stale pre-existing weekday rows** (2Tb): when the target set does not align with the pre-populated rows, rows the recipe never re-drives are left in the rule. It is not a silent corruption — the #491 full-fidelity assert catches it as `verify-failed:mismatch`, so the write fails loudly and lands nothing wrong.

### Multi-weekday dialog AX census (the fix's structure)

Census of a 3-weekday (`mon,wed,fri`) reschedule dialog, `group 1` children in AX order:

```
AXPopUpButton val=never       ← Ends (pop up button 1)
AXButton · AXButton           ← Friday row's add/remove pair
AXPopUpButton val=Friday      ← pop up button 2  (NEWEST-added row is FIRST)
AXButton · AXButton           ← Wednesday row's pair
AXPopUpButton val=Wednesday   ← pop up button 3
AXButton · AXButton           ← Monday row's pair
AXPopUpButton val=Monday      ← pop up button 4  (oldest row LAST)
AXTextField val=1             ← interval
```

Key facts the fix must use: (i) the weekday pop-ups are `pop up button 2..(N+1) of group 1` (Ends is always button 1); (ii) they are in **REVERSE creation order** — `pop up button 2` is the most-recently-added row, so pressing "+" and re-driving `button 2` sets the NEWEST row each time (why make-repeating from a fresh single-row dialog works: each "+" makes `button 2` the new empty row, and the K distinct targets fill the K rows); (iii) each weekday row carries its OWN add/remove **button pair** (title-less `AXButton`s) — so a closed-loop converge CAN shrink as well as grow, but which of the pair adds vs removes (and whether the pop-ups renumber after a remove) is **UNCERTIFIED** by this census.

### Disposition — CONFIRMED bug; fix TRIMMED to a scoped follow-up (not shipped here)

A correct closed-loop weekday-row converge (read the live pop-up count → set each of the K rows by its own distinct index → add/remove to reach K) is implementable against the structure above, BUT the shrink path needs the per-row add/remove button semantics + post-action renumbering certified — a dedicated ui-certification arm. Shipping an uncertified AX-drive rework risks regressing the **working** make-repeating multi-weekday path (which builds from a fresh dialog and is UIC/RRD1-certified). Because the bug fails CLOSED (`verify-failed:mismatch`, no silent corruption or wrong landing), the safe disposition is to record it with this census evidence and TRIM the up-next entry to the scoped "blind-'+' closed-loop converge" residual, rather than ship a half-certified drive change. The RRF1 breadth half of the entry (cells 2W/2E above) is CLOSED.

*(Adjacent observation, out of scope: the recipe also never REMOVES rows when the target set is SMALLER than the pre-populated set — e.g. pre {mon,wed,fri} → {mon} would leave {wed,fri} stale. Same root cause, same fail-closed containment; folds into the same follow-up.)*

---

## 3. After-completion Ends control — **NO SUCH CONTROL; the #476 refusal is PERMANENT**

AX census of the after-completion reschedule dialog (`I3` = weekly `--after-completion`). The sheet's complete control set:

```
AXSheet
  AXCheckBox "Add reminders"  (val=0)
  AXCheckBox "Add deadlines"  (val=0)
  AXGroup
    AXPopUpButton  val=week                              ← cadence UNIT pop-up
    AXStaticText   "after previous item is checked off."
    AXTextField    val=1                                 ← interval
  AXStaticText   "Repeat"
  AXPopUpButton  val=after completion                    ← FREQUENCY pop-up
  AXButton "OK"  ·  AXButton "Cancel"
```

The after-completion dialog exposes **exactly two pop-ups** — the cadence unit (`week`) and the frequency (`after completion`) — plus the "Add reminders"/"Add deadlines" checkboxes and the interval field. **There is NO "Ends" pop-up at any index.** The recipe's `DIALOG_ENDS = pop up button 1 of group 1` resolves in this mode to the cadence-UNIT pop-up (`week`), exactly as ANCH1-B FIX4 diagnosed — there is nothing else it could resolve to. An after-completion repeat therefore CANNOT be given an end bound through the dialog: the existing `assertRepeatRule` refusal (`src/write/repeat-rule.ts`, "an after-completion repeat can't be given an end bound through this command") is **permanent, not a targeting gap**. No recipe change, no refusal lift.

---

## 4. RSPA1-D — off-rule-first disclosure blind to a PRESERVED deadline

**Fix (code):** `assessOffRuleFirst` now accepts the template's preserved deadline offset (threaded from the reschedule pre-state at the pipeline disclosure call sites when the request carries no `--deadline`/`--start-days-earlier`). When a reschedule PRESERVES an existing deadline, the driven Next is the DUE date and the START back-shifts by the preserved offset, so the disclosure states the true `appears`/`due` dates (e.g. RSPA1 cell (b): `--when 2028-11-05` on a `ts=-14` template now discloses "appears 2028-10-22, due 2028-11-05", not "appears 2028-11-05"). An explicit deadline still wins (--when = start, due later); no preserved offset ⇒ unchanged copy. Unit-tested (`test/unit/repeat-anchor.test.ts`, the RSPA1-D cases); the whole assessment stays disclosure-only (the landed DATA was already correct).

**Live confirm — BLOCKED by an unrelated Next-snap.** Re-running RSPA1 cell (b) on a FRESH deadlined template (`icCount=0`) hit the deadlined off-rule Next-SNAP documented in §1 (the control snapped Next to `2029-10-16` and rejected the write), so the drive never reached the OK-path disclosure. RSPA1 cell (b)'s own committing run used a MATERIALIZED template; re-materializing was not re-run here. The disclosure logic is covered by the unit test; the live string was not re-observed under VMQ1.

---

## 5. SESSGATE stuck-modal → AS-mutation-block → close+reopen recovery (entry (b))

**The prior INCONCLUSIVE run's real bug found + fixed.** `research-sessgate-modal.sh` (and the first VMQ1 attempt) revealed the seed with `osascript -e 'open "things:///show?id=…"'` — but AppleScript's bare `open` does NOT dispatch a URL scheme, so the reveal never navigated and the row was never list-selected (`id of selected to dos` came back empty across an 8× poll → `Items ▸ Repeat…`, being selection-dependent, never opened a sheet). Using the **shell** `open 'things:///show?id=…'` (the URL dispatcher the CLI drive uses) selects the row on **attempt 1** and the Repeat sheet opens (`sheet-visible`).

**Modal-block — CONFIRMED LIVE IN-LAB (first time).** With the Repeat sheet open, an AppleScript `delete (to do id …)` is **BLOCKED** — `trashed` stays `0` — both UNLOCKED and under a locked session. This reproduces the §9cc modal-block law in-lab (the prior campaigns could only get it from the live host + ADR1's corroboration); it is lock-INDEPENDENT (an open modal blocks AS object-model mutations app-wide regardless of lock state).

**Two findings that DIVERGE from the live-host recovery narrative:**
1. **The live-host `1 0 0` AX-BLIND-sheet state is NOT establishable in-lab.** Locking a session that ALREADY has a sheet open yields reachability `1 1` (Things AS=1, AX=1) with the sheet still AX-reachable (`sheet-visible` under lock), not the live-host `1 0 0` (sheet on an AX-unreachable window). The lab lock does not blind the AX view of an already-open sheet.
2. **`close window 1` + `reopen` did NOT unblock the delete in-lab** — `trashed` stayed `0` after the recovery, in BOTH the locked and unlocked runs. The most likely mechanism: with a modal sheet attached to window 1, `close window 1` is itself an app-wide AS object-model action the open modal SWALLOWS (or it targets a non-sheet window), so the sheet is never taken down and mutations stay blocked. The documented live-host recovery cleared an AX-BLIND sheet (state #1, which the lab can't reproduce); for an AX-REACHABLE lab sheet the correct dismissal is `key code 53`/Cancel (which the CLI cleanup already does) — so `close window 1` is the wrong lever for the lab's reachable-sheet state, and the AX-blind recovery it targets stays live-host-only.

**Disposition:** the AS-mutation BLOCK half of entry (b) is CLOSED (now in-lab certified). The AX-blind-sheet + `close window 1`/`reopen` RECOVERY half remains NOT in-lab-reproducible — the AX-blind-sheet state cannot be established in a headless clone (locking keeps the sheet reachable), so that maneuver stays live-host + ADR1 ground-truthed. Entry (b) trims to that recovery residual, plus a flag for the maintainer: does `close window 1` genuinely take down an ATTACHED modal sheet, or did the live-host recovery rely on the sheet being on a separate/blind window? (`lab/scripts/vmq1-sessgate.sh`; `LOCK=1` for the locked variant.)

---

## 6. Template-direct clone certification (cells a, f live; b confirmed; c/d/e residual)

Source = a fixed weekly template `C6` (`--weekdays tuesday`, `of=[{wd=2}]`); clock 2026-07-05 (its first occurrence Tue Jul 7 is FUTURE, so `icCount=0` on the source).

| Cell | action | result |
|---|---|---|
| **(a) fixed template clone** | `todo clone <C6-template> --dangerously-drive-gui` | **`ok`**: a NEW template row minted (2 rows titled C6), rule bytes EXACT (`of=[{wd=2}]` = Tuesday, matching the source), **source template UNTOUCHED**, the new-series-identity warning verbatim ("cloning a repeating template mints a NEW repeating series with its own identity — it is not linked to the source template…"). Recorded as `todo.add-repeating` with an undo token. |
| **(b) spawn-shape** | (same clone) | **0 instances** spawned — the fixture's first occurrence is FUTURE-dated, so the clone mints template + cursor with no current-occurrence instance, exactly the UIC8 fixed-future-dated spawn law (the "could not derive the spawned instance" disclosure is the honest no-instance case, not a defect). This confirms cell (b)'s shape as a byproduct. |
| **(f) undo trash-both** | `things undo` | **`ok`**: the clone's template row is trashed (back to 1 row titled C6 = source only), 0 new-series instances, and the **source template stays present + untouched** (`of=[{wd=2}]`). Trash-both removes the new series and leaves the source. |

**(c) inexpressible-rule refusal — NOT live-reachable.** An inexpressible rule (two simultaneous end bounds, or a multi-anchor month/year) cannot be MINTED through any app surface — the Repeat dialog is single-choice for Ends and single-anchor for month/year, and direct SQLite writes are forbidden. So there is no way to stand up an inexpressible TEMPLATE to clone in-lab; the `H-CLONE-SOURCE` refusal stays CI-covered (`test/engine/write-promote-clone.test.ts`), not live-certifiable. **(d)** project-template row-select disambiguation and **(e)** paused-source-clones-unpaused were not run this pass — they remain the entry's residual.
