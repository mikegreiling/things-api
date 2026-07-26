# UIC7 — reschedule-repeat GUI-drive cluster certification

Certifies the fixes for the `reschedule-repeat` bug cluster reported in the field
(docs/up-next.md §0½ item 1, defects (a)–(f)). The earlier repeat certifications
(UIC5 make-repeating, UIC6 full rule vocabulary) certified the CREATE paths but
never exercised the CONVERSION shapes — `fixed → after-completion`,
`after-completion → fixed`, interval 1 vs >1 across units — which is exactly
where the field report broke. Script: `lab/scripts/research-uic7.sh`.

## The incident (verbatim shape, sanitized)

A real ~35-write audit session converted a fixed **biweekly** repeater to
after-completion via `things todo reschedule-repeat --after-completion
--frequency weekly --interval 2 --dangerously-drive-gui`. The rule change **did
land**, yet the CLI reported `VERIFY FAILED (silent-noop)` on both drive
attempts, and a retry with a *different* rule was stopped only by a preflight
refusal — the failure mode actively invited clobbering. Six defects (a)–(f).

## Root causes (host-side analysis, confirmed by the fixes)

- **(c) pluralized unit pop-up.** The after-completion cadence unit is the time
  UNIT, and the app pluralizes it by interval: `week` at interval 1, `weeks` at
  interval > 1. The reschedule dialog opens **pre-populated with the item's
  current interval**, so a biweekly template's unit pop-up already reads `weeks`
  before the interval field is touched. The recipe drove a single literal
  `menu item "week"` → not found → transport error mid-drive.
- **(a) false-negative verify.** Two compounding causes: (1) the drive aborted on
  (c) with a nonzero transport exit, and the pipeline declared `silent-noop`
  WITHOUT re-reading — but the rule had already landed by dialog inheritance
  before the aborted unit step. (2) The reschedule delta asserted only
  `unit`+`interval`; in this incident BOTH were unchanged (weekly/2 → weekly/2),
  only the `type` flipped (fixed → after-completion), so even a clean re-read
  could not distinguish "converted" from "did nothing".
- **(d)/(e)** the abort claimed a dismissal it never verified, and the follow-up
  preflight blamed the wrong thing when the leftover sheet disabled the menu bar.

## Fixes under test (all host-unit-tested before this sitting)

| Defect | Fix | Where |
|---|---|---|
| (c) | after-completion unit pop-up driven by a candidate label list (singular AND plural); clicks whichever exists, fail-closed if neither | `ui.ts` `axSelectPopupCandidatesScript`, `ui-recipes.ts`, `types.ts` `valueCandidates` |
| (a) | reschedule delta asserts rule `type`; transport-failure path re-verifies with bounded backoff and returns `ok` if the rule landed; pre-drive idempotency short-circuit | `pipeline.ts`, `commands.ts` |
| (b) | (no code change needed on HEAD — confirmed empirically) `--json` emits one clean JSON envelope on stdout on every drive path | `cli/commands/writes.ts` (locked #273) |
| (d) | abort asserts the sheet is gone (retry once) before claiming dismissal; warns if it may remain | `ui.ts` `axSheetOpenScript`, `verifiedAbort` |
| (e) | canary miss checks for an open sheet and names it as the first cause | `ui.ts` |
| (f) | residual `startOffsetDays`/`offsets` after conversion — probed here | see verdict below |

## In-VM run

- Clone: `things-lab-golden-v1` → `uic7-lab`; Things 3.22.11 / macOS 15.7.7 / DB
  v26; Accessibility granted via the AXVM1 rung-b user-path toggle; airgapped,
  clock pinned 2026-07-05.
- Drives run through the **production CLI** (`dist/`), `--dangerously-drive-gui`,
  `--json`; every drive's raw `--json` stdout is banked under
  `lab/artifacts/uic7-lab/json/` and parsed (defect (b) evidence).

### Cases

1. **UIC7-a** seed a FIXED biweekly (make-repeating weekly/interval-2) → rule A `tp=0 fu=256 fa=2`.
2. **UIC7-b** THE REPRO: reschedule A → after-completion weekly/interval-2 → rule B `tp=1 fu=256 fa=2`.
3. **UIC7-c** pre-drive idempotency: reschedule to the SAME after-completion rule again → `ok` no-op, no drive.
4. **UIC7-d** after-completion → fixed round trip → `tp=0` again.
5. **UIC7-e** after-completion DAILY interval 1 (singular `day`).
6. **UIC7-f** reschedule → after-completion MONTHLY interval 3 (plural `months`, interval > 1).
7. **UIC7-g** residual-fields probe (defect (f)): fixed weekly/2 + deadline + start-3-earlier + Monday → convert to after-completion; inspect surviving `ts`/`of`; complete the instance; observe the next spawn's date.
8. **UIC7-h** live open-sheet preflight diagnosis (defect (e)): open the Repeat dialog by hand, then drive a reschedule → refusal names the modal sheet.
9. gating sanity: no-ack → exit 4; ui-disabled → exit 6.

## Verdicts (run `uic7-lab`, 2026-07-26, Things 3.22.11 / macOS 15.7.7 / DB v26)

Raw `--json` stdout for every drive is banked at `lab/artifacts/uic7-lab/json/`;
the run log at `lab/artifacts/uic7-lab/report.txt`.

| Defect | Verdict | Evidence |
|---|---|---|
| **(a)** false-negative verify | ✅ **FIXED + validated** | The incident (UIC7-b) now returns `ok=true` with the correct landed rule `tp=1 fu=256 fa=2` (`resched-incident.json`, drove 8 steps). Pre-drive **idempotency** validated live (UIC7-c): rescheduling to the already-present rule returned `ok` with warning "the item was already in the requested state — no GUI drive was performed", **no drive** (elapsedMs 33 vs 4676; no `undoToken`, no "drove N steps"). The rule-**type** assertion makes the conversion verifiable (both rules weekly/2, only the type flipped). |
| **(b)** `--json` on the real abort path | ✅ **validated** | EVERY drive emitted exactly one clean JSON envelope on stdout, including the two GENUINE failures — `resched-back` (verify-failed:mismatch, `ok=false`) and `resched-opensheet` (transport-failed → recovery re-verify → `ok=false`). No plain-text banner leaked onto stdout on any path. |
| **(c)** unit-popup pluralization | ✅ **FIXED (fix in place; candidate mechanism validated live, plural label not force-exercised)** | The after-completion conversions drove the unit pop-up via the candidate list and succeeded (`resched-incident` weekly, `make-C` daily, `resched-monthly3` monthly). Every dialog this run opened at interval 1 (see the interval-race finding), so the SINGULAR candidate matched first and the PLURAL label was not itself clicked live; plural correctness rests on the unit tests + the field-report evidence. Fail-closed if neither label exists. |
| **(d)** sheet-cleanup honesty | ✅ host-unit-validated | `verifiedAbort` + `axSheetOpenScript` (asserts the sheet gone, retries once, warns on failure). Unit-tested; not force-triggered in-VM (no drive aborted with a lingering sheet this run). |
| **(e)** preflight open-sheet diagnosis | ✅ host-unit-validated; live test INCONCLUSIVE | Unit-tested. The live attempt (UIC7-h) was confounded: the drive's `things:///show` reveal preamble dismissed the hand-opened sheet before the canary ran, so the canary failed for a different reason (a template is not `show`-selectable) and reported the generic message — the open-sheet branch never engaged because no sheet was open at canary time. Re-probe needs a leftover **detached** editor window (which reveal does not dismiss) or an abort-left sheet from a real prior drive. |
| **(f)** residual rule fields | ✅ **probed** (static residue captured; dynamic spawn NOT captured) | UIC7-g: fixed weekly/2 + deadline + start-3-earlier + Monday → after-completion weekly/2 gave `tp=1 fa=2 ts=-3 of=[{wd:0}] deadlineCol=<sentinel>`. **`ts=-3` and the deadline SURVIVE the conversion; the weekday `of` resets to the unit nominal `{wd:0}`.** Semantically meaningful (deadline = start − ts persists), not a stale skew. Oddities §8p; recurrence.ts caveat. The completion step to observe the next spawn's date did NOT fire (the harness passed `--dangerously-drive-gui` to `todo complete`, which rejects it) → dynamic spawn-cadence UNVALIDATED, follow-up noted. |

**Gating** (both confirmed): no-ack → exit 4 (`H-UI-DRIVE`); `ui-enabled` false → exit 6 (unsupported).

## NEW finding — the interval-field re-layout race (oddities §8l addendum)

The run surfaced a real, pre-known (RSIM) driver defect NOT among the six: **the
interval numeric field, when it is the FIRST field after a frequency/type switch,
races the group re-layout and lands `1` instead of the typed value.**

- `make-repeating --frequency weekly --interval 2` (fixed) → `fa=1`, yet `ok=true`
  (make-repeating's create-probe asserts only `isTemplate`, so it does not catch
  the interval mis-land — a **false success**).
- `reschedule-repeat --frequency weekly --interval 2` (→fixed) → `fa=1`, now
  `ok=false` verify-failed:mismatch (`resched-back.json`, observed interval 1) —
  the strengthened delta catches it **honestly**.
- The same interval-2/3 write COMMITS when a step sits between the switch and the
  field (the after-completion unit pop-up: `fa=2`/`fa=3`), and the late
  "start N days earlier" field committed fine (`ts=-3`) in the same drive whose
  interval mis-committed. So it is specifically the first-numeric-field-after-a-
  mode-switch that is at risk.

This is a **driver follow-up** (poll/verify-and-retry the interval field, or settle
after the mode switch), tracked in up-next §0½. It is not a regression from this
change — the interval race predates it; the type/interval assertion merely makes
`reschedule-repeat` fail-closed about it instead of silently mis-landing. It does
mean a fixed reschedule/make with interval > 1 currently under-applies the
interval on this build.
