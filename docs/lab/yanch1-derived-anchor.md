# YANCH1 — derived calendar anchor + deadline-mode dialog census (issue #493)

**Probed under: `things-lab-golden-v3` · Things 3.22.14 (build 32214000) · macOS 15.7.7 · DB schema v26 · pinned clock 2026-07-05 12:00 (a SUNDAY).** ONE disposable clone `yanch1-lab` of golden-v3 (golden untouched; every write inside the clone), airgapped (default route deleted, ping fails), clock pinned before Things launched. golden-v3 carries the baked L3-accessibility grant; the dialog was driven via System Events / the ObjC AX bridge over SSH. Ground truth = read-only guest SQLite (decoded `rt1_recurrenceRule` + cursor + `rt1_instanceCreationStartDate` + `deadline` column) plus a full-app AX-tree census. Fixtures fully synthetic (`YC-*` titles); the maintainer's host titles/domains never left the host. Scripts: [`lab/scripts/yanch1-setup.sh`](../../lab/scripts/yanch1-setup.sh) + [`yanch1-ax.sh`](../../lab/scripts/yanch1-ax.sh); artifacts (gitignored) `lab/artifacts/yanch1-lab/` (AX dumps under `ax/`).

Packed dates decode `y<<16|m<<12|d<<7`; `ia`/`sr` are the anchor epochs; monthly/yearly `of` day/month indices are 0-based (`dy=15,mo=9` = Oct 16); `ts` = the deadline-relative start offset (≤ 0).

## The report (#493) and the two failure flavors

The maintainer's host produced two distinct wrong terminal states from the same `--dangerously-drive-gui` deadline family:

1. **yearly MAKE with `--deadline`** (`make-repeating … --frequency yearly --interval 1 --when 2027-10-16 --deadline --start-days-earlier 14`): the original was trashed and replaced, but the landed template carried the dialog's **untouched January-1 default anchor** (`of={day:1,month:1}`), and the command returned no structured terminal result. The user's later notes ("2027-10-16 → 2028-01-01", "2028-05-08 → 2029-01-01") are the **first January-1 strictly after the requested first occurrence** — the deterministic Jan-1 cursor, not garbling.
2. **monthly RESCHEDULE on an already-deadlined rule** (`reschedule-repeat … --frequency monthly --interval 1 --on-weekday tuesday --on-ordinal 4 --when 2026-09-22 --deadline --start-days-earlier 21`): completed frequency→interval→weekday→ordinal, then FAILED at the "Next (first occurrence)" step with `-[__NSArray0 objectAtIndex:] index 0 beyond bounds for empty array (-2700)`. The post-#492 asserts then correctly reported the observed state UNCHANGED (anchorKey d-1, ts -14, next 2026-09-16) — fail-closed worked.

## Reconciliation-matrix verdict — ANCH2 cell (c) WAS the repro, mislabelled a pass

ANCH2 (docs/lab/anch2-next-field.md) cell (c) drove `yearly/2, Next=2028-03-10, anchor default` and recorded `of=[{dy=0,mo=0}]` (**January 1**), `icStart=sr=2028-03-10`, `ia=next=2029-01-01`, "✓ first occ = Next; subsequent on Jan 1". That is BYTE-IDENTICAL to the #493 host outcome: driving "Next:" fixes the first occurrence, but the **recurring anchor stays the dialog's untouched Jan-1 default** because ANCH2 drove Next ONLY, never the yearly month/day pop-ups. ANCH2's invariant was "first occurrence = requested" (`rt1_instanceCreationStartDate == requested`), so it accepted the Jan-1 recurrence as correct-by-design for an anchorless rule. **The delta between "ANCH2-c passed" and "the host failed" is nil** — both drop the recurring anchor to the default; the host merely EXPECTED an Oct-16 recurrence that was never driven. The deadline/start-earlier flags are NOT the cause of the wrong anchor (the anchor drops for ANY anchorless yearly drive, deadlined or not). What the deadline flags DID change is the semantics of what "Next:" means and where the first occurrence lands — see the census + semantics below.

## Deadline-mode date-area census (authoritative; supersedes the ANCH2 census for deadline states)

Full-app AX inventory of every `AXDateTimeArea` in the Repeat dialog, golden-v3 / 3.22.14, both dialog shells:

| Dialog | frequency | deadline | ends | reminders | `AXDateTimeArea` count | areas (DFS) |
|---|---|---|---|---|---|---|
| MAKE (sheet) | yearly | off | never | off | **1** | Next `@[322,338]` (val = Jan 01 default) |
| MAKE (sheet) | yearly | **on** | never | off | **1** | Next `@[322,338]` (unchanged) |
| RESCHEDULE (sheet) | yearly (deadlined rule) | on (pre-set) | never | off | **1** | Next `@[322,338]` (val = the deadline date) |

**Verdict: deadline mode does NOT restructure the date areas.** "Add deadlines" reveals a "start N days earlier" NUMBER field (a stepper), not a date picker — the date-area inventory is unchanged (still the single Next area; the Ends / reminder areas appear only when THOSE controls are enabled, exactly as ANCH2 charted). Therefore the host's flavour-2 **empty date-area collection was a TIMING / AX-bridge artifact**, not a structural absence: the Next area exists in the deadlined reschedule dialog (censused directly). The `-2700` was OUR set-datetime script indexing an empty poll result (or an ObjC exception surfaced during traversal), NOT the app. (A related `-1728` "Can't get to do id" AppleScript flake recurred on the trash leg after heavy single-session churn — RESID1 class, clone-local, not a product regression.)

## Deadline anchoring semantics (the crux — golden-v3 probe)

A DEADLINED fixed rule anchors on the **DEADLINE**, and each instance's START = anchor − `startDaysEarlier`:

- Drive anchor pop-ups + "Next:" to **Oct-16**, `--start-days-earlier 14` → `of=[{dy=15,mo=9}]` (Oct 16), `ts=-14`, deadline set, but `icStart=sr=next=2027-10-02` = **Oct 16 − 14**. The instance STARTS Oct 2 (deadline Oct 16). The formula `start = anchor − N` holds uniformly (N = 0 for a non-deadlined rule ⇒ start = anchor).

`--when` in this CLI is the scheduled **START**. So to land the user's intent (start = Oct 16, deadline = Oct 30 = when + 14), the dialog's anchor pop-ups AND "Next:" field must be driven with **`when + startDaysEarlier`** (the deadline), and the app back-shifts the start to `when`. Confirmed on the FIXED build (below).

## The fixes (branch `mg/493-derived-anchor-drive`)

1. **Derived-anchor driving** (`repeat-anchor.ts` `deriveFixedAnchor`, folded into both promote legs of `promote-clone.ts`). When a fixed weekly/monthly/yearly rule is requested with a first-occurrence date and NO explicit anchor, derive the anchor from that date (weekly→weekday, monthly→day-of-month, yearly→month+day — the same refIso law `composeOffsets` uses) and DRIVE the anchor pop-ups. Completes the derive-and-drive family the weekly weekday-derivation began post-ANCH1. Demotes "Next:" to first-occurrence/cursor duty.
2. **Deadline-mode Next shift** (`deadlineDriveNext`). The anchor + "Next:" drive date = `when + startDaysEarlier` for a deadlined rule; the verify then expects the START to land on `when`. Applied upstream for make/add (`promote-clone.ts`) and via `reschedRuleExtras` for reschedule (`commands.ts`).
3. **`ruleParamsFor` deadline carry** (`promote-clone.ts`). The shared promote helper was keyed to `AddRepeatingRuleFields`, silently STRIPPING rule-level `deadline`/`startDaysEarlier` from `make-repeating` — a `make-repeating --deadline` landed a NON-deadlined series (probe: `ts=0, deadline=None` before the fix). Now carried through (same class as the RRX1 reminder drop).
4. **Verify hole closed** (`repeat-asserts.ts` + the derivation). The derived-or-explicit anchor now rides `expectedRuleAssertions`, so a dropped Jan-1 / Sunday / 1st-of-month anchor is a `verify-failed:mismatch`, not a silent ok. `includeCursor` stays FALSE for make/add (the cursor is the first RULE-ALIGNED occurrence, distinct from the driven first occurrence, which is verified via `rt1_instanceCreationStartDate`); the map reason is refined.
5. **set-datetime rejection detection + named error** (`ui.ts` `axSetDateTimeScript`). The poll guards the empty set and throws a NAMED, structured error naming the target + the dialog's date-area inventory (never an uncaught `-2700`); after the write it READS THE CONTROL BACK and fails loudly when the committed value differs from the request (the macOS error beep = a rejected write, now caught rather than verified as ok).
6. **Result echo** (`landedRuleEcho`). The promote ok-result echoes the landed cadence + first-occurrence START + deadline offset so a caller can eyeball what committed.
7. **Skill + CLI hardening** ([`skills/things-cli/SKILL.md`](../../skills/things-cli/SKILL.md), `--dangerously-drive-gui` help): ≥180s wrapper timeout; a timeout / empty output / silent no-op is NOT success — re-read `things show <uuid>` + the trace before retrying; never fire an identical retry; STOP and file a bug on wrong/ambiguous state.

## Re-certification on the FIXED build (golden-v3, production CLI, clock pinned 2026-07-05)

| Cell | command (synthetic) | landed rule | verdict |
|---|---|---|---|
| **HOST** — the #493 shape | `make-repeating … --frequency yearly --interval 1 --when 2027-10-16 --deadline --start-days-earlier 14` | `fu=4 fa=1 ts=-14 of=[{dy=29,mo=9}]` (Oct 30 deadline anchor) · `ia=2027-10-30` · `sr=next=icStart=2027-10-16` (start = `--when`) · deadline set | ✅ first occurrence STARTS Oct 16 with a deadline Oct 30 (14 days later), recurring yearly — exactly the issue's expected outcome (was: silent Jan-1) |
| **HOST (pre-shift build)** | same | `of=[{dy=15,mo=9}]` (Oct 16) · `icStart=2027-10-02` | fail-closed `verify-failed:mismatch` (start Oct 2 ≠ requested Oct 16) — NEVER a silent wrong series; drove the derived Oct-16 anchor, exposing the deadline-shift need |
| **deadline drop (pre-ruleParamsFor-fix)** | `make-repeating … monthly --on-day last --deadline --start-days-earlier 14` | `ts=0 deadline=None` | the bug: deadline/start-earlier dropped — fixed by #3 |
| **RESCHEDULE fail-closed** | `reschedule-repeat` on a template whose row is unselectable (no materialized instance at the pinned clock) | observed state UNCHANGED, per-field `observed` diff | ✅ the #492 full-fidelity asserts caught it honestly — no false ok (positive finding) |

Positive finding (record): the post-#492 asserts fail CLOSED with a per-field observed diff and leave the state untouched — the fail-closed layer works; it is what turned the host's crash into an honest "nothing landed" rather than a silent partial promotion.

## Residual (queued)

- **Reschedule end-to-end drive on a deadlined rule** could not be cleanly driven in-lab: a repeating template with no materialized instance at the pinned clock is not selectable (the reveal URL selects to-dos with a current row), and the `-1728` AppleScript flake recurred after heavy churn. The reschedule uses the IDENTICAL deadline-mode sheet the MAKE host-shape re-cert drove successfully (censused byte-identical), and the reschedule deadline-shift is a pure function (`deadlineDriveNext`, unit-tested); a fresh-clone live drive of `reschedule-repeat` on a deadlined series with a materialized instance is queued in [up-next.md](up-next.md).
