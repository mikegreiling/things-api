# ANCH1 — fixed-recurrence ANCHOR law + phase-correction viability (issue #476)

**Probed under: `things-lab-golden-v2` · Things 3.22.12 (build 32212016) · macOS 15.7.7 · DB schema v26 · pinned clock 2026-07-05 12:00 (a SUNDAY), advanced only in +1-day steps.** ONE disposable clone `anch1-lab` of golden-v2 (golden untouched; every write inside the clone), airgapped (default route deleted, ping fails), clock pinned before Things launched. golden-v2 carries the baked L3-accessibility grant, so the ui-vector promote drove via System Events over SSH — no VNC. Ground truth = read-only guest SQLite row deltas (decoded `rt1_recurrenceRule` + cursor `rt1_nextInstanceStartDate`) driven through the **production CLI** (guest e2e bundle). Fixtures fully synthetic (`AN*` titles). Branch `mg/476-repeat-anchor`; script [`lab/scripts/research-anch1.sh`](../../lab/scripts/research-anch1.sh); Phase-B re-cert [`lab/scripts/research-anch1b.sh`](../../lab/scripts/research-anch1b.sh); artifacts (gitignored) `lab/artifacts/anch1-lab/` + `lab/artifacts/anch1b-lab/`.

The issue was reported on Things **3.22.13**; this campaign confirms the CORE bug reproduces on golden-v2's **3.22.12**, and characterizes the exact anchor law + whether the phase can be corrected programmatically. Packed dates decode `y<<16|m<<12|d<<7`; rule `ia`/`sr` are unix-epoch seconds; `fu` 16=daily/256=weekly/8=monthly/4=yearly; `ed=64092211200`=the year-4001 "forever" sentinel.

## HEADLINE VERDICTS

1. **The core bug REPRODUCES under 3.22.12 (A2).** A fixed rule anchors its FIRST occurrence to the **next calendar match ON OR AFTER TODAY** and **IGNORES the item's own scheduled `when` entirely**. `sr` (anchor start-reference) = today; `ia` (first occurrence) = cursor = the next match. It is **INTERVAL-INDEPENDENT** — interval 1 and interval 2 place the first occurrence identically.
2. **The weekly weekday default is SUNDAY (A3), constant.** With no explicit weekday the dialog defaults a weekly rule to Sunday (`of=[{wd:0}]`), independent of today AND of the item's scheduled weekday — explaining the issue's "anchored on Sunday" surprise.
3. **There is NO drivable first-occurrence control** (UIC6 field map; A1 fresh census attempted) and **NO post-promote phase-correction vector** (A5): AS `schedule` on the template → error 302; moving the instance does NOT move the template cursor; `reschedule-repeat` re-anchors to the existing cursor. So a requested first occurrence the app would drop **cannot be honoured programmatically** → the fix is fail-closed refusal (branch 3), not a correction leg (branch 2) or a driven control (branch 1).
4. **`--ends-on <date>` on a fixed rule is a SEPARATE 3.22.12 anomaly (P0):** it anchors `ia`/`sr`/cursor to the ENDS date (a degenerate series). This does NOT reproduce on 3.22.13 (the reporter saw a near-future first occurrence) — a version-specific app difference, flagged in [things-app-oddities.md](../things-app-oddities.md). VM re-certification of the fix therefore avoids `--ends-on` on 3.22.12 (uses `--ends-after` / no-ends).

## Phase 0 — reproduce the issue repro under 3.22.12

Issue analogue on the pinned clock (Sunday 2026-07-05): source `--when 2026-07-15` (a Wednesday, 10 days out), `--frequency weekly --interval 2 --weekdays wednesday --ends-on 2026-12-30`. Divergent predictions: **date-anchor (what the user wants) → first occurrence 2026-07-15; today-anchor (the bug) → 2026-07-08** (the next Wednesday from today).

| Cell | rule bytes | verdict |
|---|---|---|
| P0 `make-repeating` | `tp=0 fu=256 fa=2 of=[{wd:3}]` · `ed`/`ia`/`sr`/`next`/`icStart` **all = 2026-12-30** · icCount=0 · 0 instances | today-anchor CONFIRMED indirectly + the `--ends-on` anomaly (all anchors collapse to the ends date) |
| P0b `add-repeating` | identical to P0 (`ia=sr=next=2026-12-30`, icCount=0) | shared behavior (issue item 6): make/add-repeating anchor identically |

P0 uses `--ends-on` and so also exhibits the ends-on anomaly (verdict 4). The CLEAN anchor probes (A2, no `--ends-on`) show the bug without the ends-on confound.

## Phase A2 — anchor-derivation matrix (weekly/2/wednesday unless noted)

Every cell landed the **same** first occurrence regardless of the source's `when` — proving the source date is ignored:

| Cell | source `when` | `ia` (first occ) | `sr` | `next` (cursor) | instances |
|---|---|---|---|---|---|
| a2-today | today (Sun 07-05) | 2026-07-08 | 2026-07-05 | 2026-07-08 | 0 (future) |
| a2-aligned | 2026-07-15 (Wed) | 2026-07-08 | 2026-07-05 | 2026-07-08 | 0 |
| a2-misalign | 2026-07-16 (Thu) | 2026-07-08 | 2026-07-05 | 2026-07-08 | 0 |
| a2-someday | someday (no date) | 2026-07-08 | 2026-07-05 | 2026-07-08 | 0 |
| a2-int1 (weekly/**1**) | 2026-07-15 | 2026-07-08 | 2026-07-05 | 2026-07-08 | 0 |

**Law:** `ia` = cursor = the next occurrence ≥ today matching the rule's weekday(s) (Sun 07-05 → next Wed = 07-08); `sr` = today. The source `when` (07-15, 07-16, someday) is entirely ignored. Interval 1 and 2 place the first occurrence identically (a2-int1 vs a2-aligned) — the interval only sets the CADENCE, not the anchor. No instance spawns when the first occurrence is in the future (icCount=0), per the UIC8 spawn-shape law.

## Phase A3 — the weekday default (NO `--weekdays`)

| Cell | today | source `when` | `of` | `ia` | `next` | instances |
|---|---|---|---|---|---|---|
| a3-today | Sun 07-05 | today | `[{wd:0}]` Sunday | 2026-07-05 | 2026-07-19 | 1 (@07-05) |
| a3-align | Sun 07-05 | 2026-07-15 (Wed) | `[{wd:0}]` Sunday | 2026-07-05 | 2026-07-19 | 1 (@07-05) |
| a3-mon (clock +1) | **Mon 07-06** | today | `[{wd:0}]` Sunday | 2026-07-12 | 2026-07-12 | 0 |

**Law:** the dialog defaults a weekly rule's weekday to **SUNDAY (wd 0, start of week)**, constant. a3-align (source scheduled a Wednesday) still gets Sunday → NOT derived from the source. The Monday probe (today = 07-06) still gets Sunday (`ia`=next Sunday 07-12) → NOT derived from today (would be Monday) and NOT "tomorrow" (would be Tuesday). Combined with the issue's Saturday→Sunday observation, constant-Sunday is the only hypothesis consistent with all cells. This is why the issue's no-`--weekdays` attempt anchored on Sunday 08-16.

## Phase A1 — dialog census (first-occurrence control?)

A fresh AX dump of the fixed-weekly Repeat sheet returned `NO-SHEET` in the headless SSH-driven context (the dialog materializes as a DETACHED `AXUnknown` top-level window, not an attached `AXSheet`; the first census tool looked only for `AXSheet`). The Phase-B census (detached-window-aware) is best-effort. The AUTHORITATIVE inventory is the **UIC6 certified field map** ([uic6-rule-vocabulary.md](uic6-rule-vocabulary.md)): the dialog exposes frequency, interval, weekday set, monthly/yearly anchors, the Ends bound, reminder time, and the deadline offset — **and NO first-occurrence / anchor-date control**. Branch 1 (drive an anchor control) is therefore impossible.

## Phase A4 — after-completion Ends census (issue item 5)

The fresh AC-mode census hit the same detached-window issue (NO-DIALOG). The DECISIVE evidence is behavioral (Phase B FIX4, CLI-driven): in after-completion mode **NEITHER end bound can be applied** — `ends: on-date` dies (the issue's `none of the candidate menu items exist: on date`) AND `ends: after` (count) silently fails to set (`verify-failed:silent-noop`, exit 3). The recipe reason: in fixed mode the Ends pop-up is `pop up button 1 of group 1`, but in after-completion mode that slot is the cadence-UNIT pop-up (day/week/…), so the ends drive targets the wrong control. Whether after-completion has a reachable Ends control at a different index (a recipe-index fix) is unprobed — the census couldn't confirm it. So the fix **refuses `afterCompletion` + any non-`never` ends** (both on-date and after) before any mutation; no-end (the default, unbounded) is fine.

## Phase A5 — phase-correction viability (the decisive experiment)

Can a wrong-phase template's cursor be moved to the requested phase after promotion? A daily/2 template (baseline: `ia=sr=07-05`, cursor `next=07-07`, on the 2-day grid) was probed:

| Vector | result |
|---|---|
| **(a)** AS `schedule` the TEMPLATE to 07-08 (off-grid) | **error 302 "Cannot schedule to-do"** — refused; rule UNCHANGED (same immutability wall as template children, RSIM-S S4) |
| **(b)** AS `schedule` the current INSTANCE to 07-08 | the instance's `startDate` moved to 07-08, **but the template cursor was UNCHANGED** (`next` still 07-07) — moving the instance does NOT re-anchor the series |
| **(c)** `reschedule-repeat` daily/2 → daily/3 | rewrote `ia=sr=next=07-07` (the **existing cursor**), preserving the today-derived phase — it cannot inject an arbitrary requested phase (refines RSIM5: reschedule re-anchors to the current cursor, not today+interval) |
| URL vector | NOT attempted (known crash, H-REPEAT-SCHEDULE) |

**Verdict: no viable phase-correction vector.** Combined with A1 (no drivable control), the ONLY correct fix is fail-closed refusal (branch 3).

## The fix (branch 3 + weekday derivation + AC-ends refusal), landed on `mg/476-repeat-anchor`

- **Weekday derivation (item 3).** For a fixed weekly rule with `--weekdays` omitted and a concrete anchor date known (source `when` for make-repeating / `--when` for add-repeating), the promote derives `weekdays = [weekdayOf(anchorDate)]` and drives it — so the series fires on the intended weekday, not the app's Sunday default. For interval 1 this fully fixes the no-weekdays case (right weekday, phase irrelevant). `src/write/repeat-anchor.ts` `deriveWeeklyWeekdays`; wired in `src/write/promote-clone.ts`.
- **Phase refusal (item 1).** When a concrete first-occurrence date is supplied and the app's today-anchored series (daily/weekly, interval > 1) would NOT contain it, the promote verbs refuse fail-closed with `H-REPEAT-ANCHOR` (a `blocked` result, zero mutation, before the clone/add leg), naming where the app WILL place the series and how to proceed. Interval 1 is never refused (every match is an occurrence). MONTHLY/YEARLY phase is NOT guarded (their default-anchor law is unprobed — residual below). `requestedPhaseHonored`; the refusal message is in `promote-clone.ts`.
- **AC-ends refusal (item 5).** `assertRepeatRule` now refuses `afterCompletion` + any non-`never` ends (on-date AND after) before any mutation — Phase B proved BOTH fail to drive; `never` / no-end stays allowed.
- **Reminder preflight (item 4).** `--reminder` was already refused by `assertRepeatRule` (which runs first in both orchestrators, before the clone/add leg) — locked by a regression test asserting zero mutation.
- **Simulator reconciliation.** `src/write/vectors/simulator.ts` `applyMakeRepeatingFixed` now models the proven law for daily/weekly: first occurrence = next match ≥ today (`fixedSpawnPlan`), an instance spawns ONLY when today is itself an occurrence, and the weekday-less weekly default is Sunday. Monthly/yearly keep the prior today+interval model (unprobed). Prior RSIM tests (source scheduled with today=Sunday, no weekdays) are unchanged because today-was-the-occurrence there.

## Phase B — re-certification of the fix (`anch1b-lab`, fresh golden-v2 clone, shipping the FIXED dist)

Driven through the production CLI (the FIXED build), same pinned Sun 2026-07-05 clock:

| Cell | verdict |
|---|---|
| **FIX1** wrong-phase repro (when=07-15, weekly/2/Wed) | **REFUSED `blocked:H-REPEAT-ANCHOR` (exit 4), zero mutation** — for BOTH make-repeating (X untouched: `trashed=0`, no rule) AND add-repeating (`AB-F1b` never created). |
| **FIX2** on-phase request (when=**2026-07-08** = the app anchor) | **OK.** Template `of=[{wd:3}]`, cursor `next=2026-07-08` = the requested first occurrence. Advancing the clock to 07-08 spawned the instance at 07-08 and advanced the cursor to **2026-07-22 (+14, the interval-2 cadence)**, icCount 0→1 — first occurrence = requested date, cadence correct. |
| **FIX3** weekday derivation (when=07-15 Wed, weekly/1, NO `--weekdays`) | **OK.** Template `of=[{wd:3}]` (Wednesday, NOT the app's Sunday default), cursor `next=2026-07-08`. Interval-1 → not refused (phase irrelevant). |
| **FIX4** after-completion + `--ends-after 5` | **`verify-failed:silent-noop` (exit 3)** — the drive could NOT set the count in after-completion mode (recipe targets the unit pop-up). Broadened the refusal to cover this (see A4). |
| **FIX4** after-completion + `--ends-on 2026-12-30` | **REFUSED (exit 1)** by `assertRepeatRule` (`after-completion repeat can't be given an end bound`), X untouched. |
| **CEN** dialog census | NO-DIALOG again (the menu-driven open didn't materialize a findable window headlessly) — census inconclusive; rely on UIC6 (no first-occurrence control) + FIX4's behavioral evidence. |

**Verdict: the fix is certified.** The wrong-phase series is refused fail-closed instead of silently created; an on-phase request yields the requested first occurrence with the correct cadence; the weekday is derived from the item's date; after-completion end bounds are refused before any side effect.

## Residuals / open items

- **MONTHLY/YEARLY phase not guarded.** ANCH1 probed daily/weekly only. A monthly/2 (or yearly/2) rule with a concrete `--when` on the wrong parity month would still be created wrong-phase silently. Their DEFAULT anchor law (what day-of-month/month the dialog picks with no `--on-day`) is also unprobed. A follow-up matrix (source `when` × monthly/2 anchor) would close it.
- **`--ends-on` fixed-rule anchor corruption (3.22.12 only).** The P0 anomaly (ia/sr/cursor collapse to the ends date) needs isolating on 3.22.13 vs 3.22.12 to confirm it's a version regression the app fixed; the fix's re-cert avoids `--ends-on` on this golden.
- **Reschedule re-anchors to the current cursor (A5c).** A refinement of RSIM5 worth folding into any future reschedule-anchor work; not changed here (out of #476 scope).
