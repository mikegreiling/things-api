# UIC6 — the FULL repeat-rule vocabulary + reschedule reversibility

**Status (2026-07-15): CODE + DESIGN + TESTS COMPLETE; in-VM certification NOT YET RUN.** This is the final build item of the AX initiative ([ax-initiative.md](../design/ax-initiative.md) build item 2). The full rule vocabulary is built against the [UIC1 dialog field map](uic1-certification.md), wired through the production CLI, and unit-tested end to end through the injectable seams (no GUI fires). What remains is the **in-VM sitting** that discovers/corrects the provisional structural paths of the NEW controls (exactly as UIC1/UIC5 corrected the base controls) and DB-verifies the recurrence-rule JSON for the coverage matrix below. Branch `mg/full-repeat-vocabulary`.

Companions: [uic1-certification.md](uic1-certification.md) (the field map this is built against), [uic5-build-certification.md](uic5-build-certification.md) (the sitting mechanics + the dual-form dialog addressing this reuses), [ui-certification-runbook.md](ui-certification-runbook.md), [axvm1-accessibility.md](axvm1-accessibility.md) (the grant recipe).

## What shipped (code)

- **Param schema** (`src/write/operations.ts`) — `RepeatRuleParams` extended BACKWARD-COMPATIBLY. A bare `{ uuid, frequency, interval }` is unchanged; every new field is optional:
  - `afterCompletion?: boolean` — rule type tp=1 (after each occurrence resolves) vs the fixed schedule.
  - `weekdays?: Weekday[]` — WEEKLY only: the day-of-week set.
  - `monthly?: MonthlyAnchor` — MONTHLY only: a DISCRIMINATED `{ day: number | "last" }` OR `{ weekday, ordinal }` (never a contradictory bag).
  - `yearly?: YearlyAnchor` — YEARLY only: `{ month } & MonthlyAnchor`.
  - `ends?: RepeatEnds` — `never | { on-date, date } | { after, count }` (single-choice, like the dialog's Ends pop-up).
  - `reminder?: HH:mm`, `deadline?: boolean`, `startDaysEarlier?: number` (implies deadline).
- **Validation** (`src/write/repeat-rule.ts` `assertRepeatRule`) — the full combination matrix with behavioral refusals (a per-frequency field on the wrong frequency; a contradictory month anchor; after-completion + a calendar anchor; out-of-range day/ordinal/month/count; a start offset without a deadline). Unit-tested (every refusal): `test/unit/repeat-rule.test.ts`.
- **Recipes** (`src/write/vectors/ui-recipes.ts`) — a UNIFIED dual-form dialog-entry builder (`repeatDialogEntry`) drives every control addressed in BOTH editor shapes (attached `AXSheet` + detached `AXUnknown`, UIC4-a/UIC5-e). The base controls (frequency pop-up, interval field, OK) are LAB-CERTIFIED (UIC1/UIC5); the new controls are **PROVISIONAL-pending-this-sitting** (see the path table). Shared by to-do make/reschedule + project make/reschedule. Shape-tested per control: `test/unit/repeat-recipe.test.ts`.
- **CLI** (`src/cli/commands/repeat-flags.ts`) — `--after-completion / --weekdays / --on-day / --on-weekday / --on-ordinal / --yearly-month / --ends-after / --ends-on / --reminder / --deadline / --start-days-earlier` on all four commands. Mapper-tested: `test/cli/repeat-flags.test.ts`.

## Reschedule reversibility — the re-evaluation (verdict: RECLASSIFIED to `conditional`)

The roadmap asked whether the richer vocabulary makes reschedule-undo faithful. It does, conditionally.

**Mechanism.** The reschedule pre-read now CAPTURES the whole prior rule — the decoded `repeating.rule` object + the template's `repeating.deadlined` flag — via a capture-only field on the `update` DeltaSpec (recorded in the audit trail, not asserted post-op). `planUndo` reconstructs the inverse with `ruleToInverseParams(priorRule, deadlined)` and re-drives reschedule with it.

**Faithfulness condition (the analysis).** For the captured-rule inverse to be sound, every rule the DB can hold must be expressible in the new vocabulary. Mapping every DB-rule dimension (`src/model/recurrence.ts` `RepeatRule`) onto the vocabulary:

| DB rule dimension | Vocabulary field | Expressible? |
|---|---|---|
| `tp` fixed / after-completion | `afterCompletion` | ✅ |
| `fu` unit + `fa` interval | `frequency` + `interval` | ✅ |
| weekly `of` weekday set (`wd`) | `weekdays[]` | ✅ (multi-day) |
| monthly `of` (`dy` incl −1; `wd`+`wdo`) | `monthly` (day / last / nth-weekday) | ✅ (single anchor) |
| yearly `of` (`mo` + day/nth-weekday) | `yearly` | ✅ (single anchor) |
| `ed` end date | `ends: on-date` | ✅ (day precision) |
| `rc` remaining count | `ends: after` | ✅ |
| `ts` start offset (≤0) | `startDaysEarlier` (+ `deadline`) | ✅ |
| deadline-ness (template `deadline` column) | `deadline` | ✅ (captured separately) |

**The expressibility boundary.** The ONLY DB rules the vocabulary cannot express are shapes the Repeat DIALOG itself cannot produce, so they never arise from normal Things use:
1. a rule carrying BOTH an end date AND a remaining count (the dialog's Ends is single-choice);
2. a monthly/yearly rule with MULTIPLE `of` anchors (the dialog sets one);
3. an after-completion rule carrying a calendar offset (after-completion has no calendar day).

`ruleToInverseParams` returns `null` for all three (and the undo reports irreversible), plus the ordinary irreversible cases: the prior rule was never captured, or is undecodable (`rrv` drift). **This is the classic `conditional`**: invertible in the normal case (every rule the app's own editor created), irreversible for the pathological/foreign shapes. A per-instance reminder time is NOT part of the recurrence rule blob, so a reminder the reschedule set/changed is not restored by the inverse (documented note).

Wired: `reversibility.ts` (both reschedule ops `conditional`), `undo.ts` (dropped from IRREVERSIBLE; the `ruleToInverseParams` cases), cross-checked by `test/unit/reversibility-matrix.test.ts` — BOTH branches, the invertible one a real do/undo DB round-trip (a monthly last-Friday rule captured, reschedule undone, the DB rule decodes back to monthly).

## PROVISIONAL control paths (the sitting corrects these)

The `_NS:` identifiers regenerate per layout (the interval field's id even changes with the frequency — UIC1), so addressing stays STRUCTURAL + title-pinned, never `_NS`. Best-guess indices from the field-map layout; the sitting confirms/corrects each exactly as UIC1/UIC5 did the base three. All are dual-form (`… of sheet 1 of <mainwin>` | `… of <detached AXUnknown>`).

| Control | Provisional path (inner) | Drive |
|---|---|---|
| frequency pop-up | `pop up button 1` | select-popup (CERTIFIED) |
| interval field | `text field 1 of group 1` | set-value (CERTIFIED) |
| after-completion unit pop-up | `pop up button 2 of group 1` | select-popup |
| weekly weekday pop-up | `pop up button 1 of group 1` | select-popup |
| weekly "+" (add day) | `button "+" of group 1` | press |
| monthly/yearly mode pop-up | `pop up button 1 of group 1` (yearly: pop-up 2) | select-popup |
| monthly/yearly ordinal pop-up | `pop up button 2 of group 1` (yearly: 3) | select-popup |
| yearly month pop-up | `pop up button 1 of group 1` | select-popup |
| Ends pop-up | `pop up button "Ends" of group 1` | select-popup |
| Ends after count / on date | `text field 2` / `date field 1 of group 1` | set-value |
| Add reminders checkbox + time | `checkbox "Add reminders"` + `text field 3` | press + set-value |
| Add deadlines checkbox + offset | `checkbox "Add deadlines"` + `text field 4` | press + set-value |
| OK | `button "OK"` | press (CERTIFIED) |

If the sitting finds the field map stale vs. live AX reality, TRUST live reality and correct [uic1-certification.md](uic1-certification.md) with a strikethrough note (the field map's own warning). The KEY unknown to resolve at the sitting: **what the "after completion" frequency choice exposes** (a secondary unit pop-up? — the analysis assumes so) and **whether an after-completion rule can carry calendar offsets** (the expressibility boundary depends on it).

## The certification matrix (to run — a coverage matrix, not exhaustive)

Reproduce the UIC5 harness: ONE disposable `--vnc-experimental` clone `uic6-lab` of `things-lab-golden-v1` (airgapped, clock-pinned, SIP on), Accessibility granted via the AXVM1 rung-b VNC toggle (`$VNCDO` from a throwaway `vncdotool` venv — the host has no `vncdo`), everything else over SSH; ground truth = guest Things-DB row deltas (read-only SQLite) + the production CLI's `--json` envelope. Build this branch's `dist` into the guest and run each case through the production CLI (`ui.enabled` + `--dangerously-drive-gui`). DB-verify the decoded `rt1_recurrenceRule` (`fu`, `fa`, `of`, `ed`, `rc`, `ts`, `tp`) for every case.

| Case | Subject | Command (extract) | DB assertion |
|---|---|---|---|
| **UIC6-a** weekly multi-day | to-do | `todo make-repeating … --frequency weekly --weekdays monday,wednesday,friday` | `fu`=256, `of`=[{wd:1},{wd:3},{wd:5}] |
| **UIC6-b** monthly nth-weekday | to-do | `--frequency monthly --on-weekday friday --on-ordinal last` | `fu`=8, `of`=[{wd:5,wdo:−1}] |
| **UIC6-c** monthly last day | to-do | `--frequency monthly --on-day last` | `fu`=8, `of`=[{dy:−1}] |
| **UIC6-d** yearly | to-do | `--frequency yearly --yearly-month 10 --on-day 8` | `fu`=4, `of`=[{mo:9,dy:7}] |
| **UIC6-e** after-completion | to-do | `--frequency weekly --interval 2 --after-completion` | `tp`=1, `fu`=256, `fa`=2 |
| **UIC6-f** ends-after-N | to-do | `--frequency daily --ends-after 5` | `rc`=5 |
| **UIC6-g** reminders on | to-do | `--frequency daily --reminder 09:00` | spawned instance carries reminderTime 09:00 |
| **UIC6-h** deadline offset | to-do | `--frequency weekly --deadline --start-days-earlier 3` | template `deadline` non-null; `ts`=−3 |
| **UIC6-i** PROJECT weekly multi-day | project | `project make-repeating … --frequency weekly --weekdays monday,thursday` | new template `of`=[{wd:1},{wd:4}] (editor is byte-identical, UIC2) |
| **UIC6-j** PROJECT monthly last | project | `project make-repeating … --frequency monthly --on-day last` | new template `of`=[{dy:−1}] |
| **UIC6-k** reschedule round-trip undo | to-do | reschedule weekly→monthly-nth-weekday, then `undo --txn` | after undo, the DB rule decodes back to the PRIOR rule (identity preserved throughout) |
| **UIC6-l** negative: contradictory params | — | `--frequency weekly --on-day 15` (monthly anchor on weekly) | **blocked**, NO drive, exit 4, item unchanged |
| **UIC6-m** negative: ends-on-date in the past | to-do | `--frequency daily --ends-on 2020-01-01` | record what the dialog/DB does (accepts a past bound → `ended` immediately? refuses?) — VERDICT to fill in |

Also confirm gating (unsupported with `ui.enabled` unset; blocked `H-UI-DRIVE` without `--dangerously-drive-gui`). On success: flip nothing in the certification manifest that is not proven; capture any AXIdentifiers the discovery finds; correct the provisional paths in `ui-recipes.ts`; add the executed verdicts ABOVE this plan; update the capability-matrix / ax-initiative / CHANGELOG certification wording; mark the AX-initiative build list CLOSED.
