# ANCH2 — the Repeat dialog's "Next:" first-occurrence control (issue #476 follow-up)

**Probed under: `things-lab-golden-v2` · Things 3.22.12 (build 32212016) · macOS 15.7.7 · DB schema v26 · pinned clock 2026-07-05 12:00 (a SUNDAY).** ONE disposable clone `anch2-lab` of golden-v2 (golden untouched; every write inside the clone), airgapped (default route deleted, ping fails), clock pinned before Things launched. golden-v2 carries the baked L3-accessibility grant; the dialog was driven via System Events over SSH — no VNC. Ground truth = read-only guest SQLite (decoded `rt1_recurrenceRule` + `rt1_nextInstanceStartDate` cursor + `rt1_instanceCreationStartDate` + `reminderTime`) plus a full-app AX-tree census. Fixtures fully synthetic (`AN-*` titles). Branch `mg/476-anchor-next`; interactive driver [`lab/scripts/anch2-ax.sh`](../../lab/scripts/anch2-ax.sh) + [`anch2-setup.sh`](../../lab/scripts/anch2-setup.sh) / [`anch2-helpers.sh`](../../lab/scripts/anch2-helpers.sh); artifacts (gitignored) `lab/artifacts/anch2-lab/` (AX dumps under `ax/`).

Packed dates decode `y<<16|m<<12|d<<7`; `ia`/`sr` are unix-epoch seconds; `reminderTime` decodes `hour<<26 | minute<<20`; `fu` 16=daily/256=weekly/8=monthly/4=yearly; `ed=64092211200`=the year-4001 "forever" sentinel; monthly/yearly `of` day/month indices are 0-based.

## Why ANCH1 was wrong (the correction)

ANCH1 concluded there was "NO drivable first-occurrence control" and shipped a fail-closed `H-REPEAT-ANCHOR` refusal (#477). That conclusion rested on a **failed live census**: ANCH1's census returned NO-DIALOG/NO-SHEET in its headless context and fell back to the **UIC6 certified field map** — which never recorded a first-occurrence control. **The control exists.** The Things Repeat dialog HAS a **"Next:" date field** inside the cadence group, showing the projected-occurrence list beside it (the maintainer confirmed this from GUI screenshots). ANCH2 censused it live, proved it honors programmatic writes, and reproduced every screenshot semantic. The "anchor law" ANCH1 proved is merely the **default value** of Next.

**What still stands from ANCH1** (unchanged): the DEFAULT value of Next = next calendar match on/after today (the today-anchor default); the weekly weekday default = SUNDAY; after-completion + an end bound is refused. **What is retracted:** "no drivable first-occurrence control" → Next IS drivable and honored; the `H-REPEAT-ANCHOR` phase refusal → replaced by driving Next; app-oddities **§8v** (`--ends-on` collapse) → **our set-datetime targeting defect, not an app anomaly**; **UIC6-g** reminder "undrivable" → **also a targeting artifact** — the reminder honors deterministic writes.

## HEADLINE VERDICTS

1. **The "Next:" control exists and honors AX writes.** It is an `AXDateTimeArea` (id `_NS:140`, drifts) on the "Next:"-labelled row of the cadence group. Typing a date into it sets the series' first occurrence verbatim (write test: default Next Wed 07-08 overwritten to 07-22 → `ia=sr=next=icStart=2026-07-22`).
2. **Arbitrary / off-rule first-occurrence phase IS expressible** (screenshot semantics reproduced): a first occurrence off the rule's calendar lands on the typed date verbatim; subsequent occurrences snap to the rule.
3. **§8v (`--ends-on` collapse) is OUR defect**, not a 3.22.12 app anomaly. The app handles a distinct Next + ends-date perfectly (cell d). The shipped recipe collapsed the series because the `set-datetime` primitive targeted "the first AXDateTimeArea by role" — non-deterministic once >1 date area exists.
4. **The reminder-time control is drivable too** (UIC6-g retracted): with deterministic targeting it commits the requested time exactly (`reminderTime = hour<<26 | minute<<20`). UIC6-g's "ignored" was the same first-by-role targeting writing into Next, never the reminder.

## Phase A1 — the census (fixed weekly, both Ends/reminder states)

Full-app AX tree dumped from the app root (walks every window; captures the attached `AXSheet` and would capture a detached `AXUnknown` dialog). The dialog presents as an `AXSheet` of the standard window; frequency pop-up items = `after completion · daily · weekly · monthly · yearly`; Ends pop-up items = `never · after · on date`.

| Dialog state | # `AXDateTimeArea` | DFS order & position (id) | source dump |
|---|---|---|---|
| weekly, Ends=never | **1** | Next `@[322,338]` (`_NS:140`) | `ax/cen-weekly-neverends.txt` |
| weekly, Ends=on-date | **2** | DT#0 **Ends** `@[406,360]` (`_NS:116`) · DT#1 **Next** `@[322,338]` (`_NS:140`) | `ax/cen-weekly-endsondate.txt` |
| weekly, Ends=on-date + reminders | **3** | DT#0 **Ends** `@360` · DT#1 **Next** `@338` · DT#2 **Reminder** `@[386,408]` (`_NS:147`, value carries a 12:00 time) | `ax/cen-weekly-ends-reminders.txt` |

**The Next field carries the projected-occurrence list** in the adjacent `AXStaticText` (e.g. weekly/2/Wed with Next=07-08 → `,  7/22/26,  8/5/26,  8/19/26,  9/2/26, …`). Deterministic targeting keys off the census: the **reminder** is the only area with a non-midnight time-of-day (and sits below the group); among the midnight date pickers, **Next** is the smaller-y (top) row and **Ends** the larger-y row. (`_NS:` ids drift; geometry + the time-of-day discriminator do not.)

Both-shell note: backgrounding Things (Finder-activate) kept the sheet attached rather than detaching it, so the detached `AXUnknown` form was not forced in this sitting; the controls are addressed by role from the app root, so the same census/targeting applies to either shell (UIC5-e).

## Phase A2 — write test (does Next honor writes?)

weekly/2/Wed, default Next = Wed 07-08. Set Next → 2026-07-22 (an aligned future Wednesday), OK. DB: `ia=sr=next=icStart=2026-07-22` — **HONORED, verbatim.** (Note the app REPLACES the to-do's identity on promote — a new template uuid is born.)

## Phase A3 — semantics matrix (each cell DB-verified, clock pinned Sun 2026-07-05)

| Cell | drive | decoded rule (post-OK) | verdict |
|---|---|---|---|
| **a** weekly/2/Wed, Next=07-22 (aligned) | interval 2 (typed), wd=Wed, Next=07-22 | `fu=256 fa=2 of=[{wd=3}] ia=sr=next=icStart=2026-07-22`; projection `7/22, 8/5, 8/19, 9/2` | first occ = Next; cadence +14 (from the app's own projection) ✓ |
| **b** weekly/1/Sun, Next=Mon 07-13 (off-rule) | wd=Sunday (default), Next=07-13 | `fu=256 fa=1 of=[{wd=0}]` · `icStart=sr=2026-07-13` (first instance = typed Monday, verbatim) · `ia=next=2026-07-19` (first aligned Sunday); projection `7/13 → 7/19, 7/26, 8/2` | off-rule first occ verbatim; subsequent snap to the rule ✓ (screenshot semantics) |
| **c** monthly/2, Next=09-15 | interval 2, anchor default (1st/day), Next=09-15 | `fu=8 fa=2 of=[{dy=0}]` · `icStart=sr=2026-09-15` · `ia=next=2026-10-01`; projection `10/1, 12/1, 2/1` | first occ = Next; subsequent on the 1st every 2 months ✓ |
| **c** yearly/2, Next=2028-03-10 | interval 2, anchor default (Jan/1st), Next=2028-03-10 | `fu=4 fa=2 of=[{dy=0,mo=0}]` · `icStart=sr=2028-03-10` · `ia=next=2029-01-01`; projection `1/1/29, 1/1/31` | first occ = Next; subsequent on Jan 1 every 2 years ✓ (monthly/yearly residual CLOSED) |
| **d** weekly/2/Wed, Next=07-22 + Ends-on 12-30 (deterministic targeting) | Next(DT#1)=07-22, Ends(DT#0)=12-30 | `fu=256 fa=2 of=[{wd=3}] ed=2026-12-30 ia=sr=next=icStart=2026-07-22` | ends in `ed`, Next in `ia/sr/next`, **NO cross-contamination** ✓ |
| **e** reschedule-repeat driving Next on an EXISTING template | template was `next=07-08`; Reschedule… → Next=07-22 | `ia=sr=next=icStart=2026-07-22`, template identity preserved | post-creation phase correction WORKS ✓ (refines ANCH1 A5) |

DB-model note (from cell b): the app stores TWO anchors — `rt1_instanceCreationStartDate`/`sr` = the typed first occurrence (verbatim, even off-rule), and `ia`/cursor = the first rule-aligned occurrence. For an on-rule Next they coincide. So the invariant "first occurrence = requested" maps to `rt1_instanceCreationStartDate == requested`.

Spawn caveat: advancing the clock in one large jump (07-05 → 07-22) did NOT retroactively materialize the due instance (`icCount` stayed 0); ANCH1 advanced in +1-day steps for this reason. Cadence/phase here are proven by the decoded rule bytes + the app's own projection list, exactly as ANCH1's matrix relied on `ia/sr/next`. (A large clock jump also triggers the macOS /tmp cleaner — helper scripts live in `~/labh`, not `/tmp`.)

## Phase A4 — the §8v disambiguation (`--ends-on` collapse)

- **Repro (shipped recipe):** `todo make-repeating … --frequency weekly --interval 1 --weekdays wednesday --ends-on 2026-12-30` (via the production CLI) → `ed=2026-12-30` **AND** `ia=sr=next=icStart=2026-12-30` — the whole series collapsed to the ends date (§8v reproduced).
- **Controlled (deterministic index targeting):**
  - Set ONLY the Ends field (DT#0) to 12-30, leave Next → `ed=2026-12-30, ia=next=2026-07-08` — **clean, no collapse.**
  - Set ONLY Next (DT#1) to 12-30, leave Ends default → `ia=2026-12-30, ed=2026-07-08, next=None` (a degenerate "starts after it ends" series) — the ends field mirrors Next until decoupled, which is how the shipped first-by-role primitive produced `ed=ia=12-30`.
  - Set BOTH deterministically (cell d) → clean separation.

**Verdict: §8v is our `set-datetime` targeting defect** (first-AXDateTimeArea-by-role is ambiguous once Ends adds a second date area). It is NOT a 3.22.12 app anomaly. Oddities §8v is retracted/reclassified accordingly (see docs/things-app-oddities.md).

## Phase A5 — reminder re-probe (deterministic targeting; UIC6-g re-examination)

weekly rule, "Add reminders" checked, reminder area (the time-bearing `AXDateTimeArea`, DT#2/DT#1) set deterministically:

| set | `reminderTime` (raw) | decodes | verdict |
|---|---|---|---|
| default (untouched) | 805306368 | `12<<26` = 12:00 | the picker's default |
| 09:00 | 603979776 | `9<<26` = 09:00 | **honored** |
| 14:30 | 970981376 | `14<<26 \| 30<<20` = 14:30 | **honored** |

**Verdict: the reminder time IS drivable with deterministic targeting.** UIC6-g's "the reminder picker ignores programmatic time entry" was the same first-by-role primitive writing into Next (never the reminder), leaving the reminder at its 12:00 default — indistinguishable from "ignored". Corrected here (UIC6 is immutable evidence; the correction lives in this doc + the assumption register). Encoding: `reminderTime = hour<<26 | minute<<20`.

## The fix (branch `mg/476-anchor-next`)

- **`set-datetime` primitive gains deterministic targeting** (`next` / `ends` / `reminder`) — reminder = the time-bearing area; among midnight date pickers, next = top row, ends = bottom row. Replaces "first AXDateTimeArea by role". (`src/write/vectors/ui.ts`.)
- **The Repeat recipes drive Next** with the requested first occurrence: source item's `when` for make-repeating, `--when` for add-repeating, `--when` for reschedule-repeat. Post-drive verify: `rt1_instanceCreationStartDate == requested` (fail closed on mismatch). (`src/write/vectors/ui-recipes.ts`, `src/write/promote-clone.ts`.)
- **`H-REPEAT-ANCHOR` deleted** (its false premise is gone). Weekday-derivation-from-date is KEPT (still sets the recurring weekday so a weekly series fires on the intended day, not the Sunday default). (`src/write/repeat-anchor.ts`.)
- **`--reminder` un-refused** and driven deterministically (issue #476 item 4). (`src/write/repeat-rule.ts`.)
- **Simulator** fixed applier anchors from the requested Next when given, else the proven default law. (`src/write/vectors/simulator.ts`.)

## Phase B — re-certification (fresh clone, shipping the FIXED dist)

Fresh golden-v2 clone, the FIXED production CLI, pinned Sun 2026-07-05. Two fix bugs surfaced in the FIRST re-cert pass and were corrected, then all cells passed:

- **RC4 first pass collapsed** (`ed=ia=sr=next=2026-12-30`): the recipe drove "Next:" while it was the SOLE date area, then selected "Ends: on date" — the same collapse §8v named. Fix: the recipe now selects the Ends bound FIRST (revealing its date area) BEFORE driving Next, so both areas exist when each is set through its own target — the proven-clean cell-(d) order. (`ui-recipes.ts`.)
- **RC5 reminder dropped** (`reminderTime` NULL): `ruleParamsFor` copied only `AddRepeatingRuleFields`, silently stripping the rule-level `reminder` from the make-repeating promote. Fix: it now carries `reminder` through. (`promote-clone.ts`.)

Final re-cert (all green, decoded rule bytes via the read-only DB oracle):

| Cell | command (production CLI) | result | verdict |
|---|---|---|---|
| **RC1** make-repeating (the #476 repro) | source `--when 2026-08-26` (Wed), `make-repeating --frequency weekly --interval 2 --weekdays wednesday` | `fu=256 fa=2 of=[{wd=3}] ia=sr=next=icStart=2026-08-26` | first occurrence = the requested date (was 07/08-anchored) ✓ |
| **RC1b** add-repeating (the #476 repro) | `add-repeating --when 2026-08-26 --frequency weekly --interval 2 --weekdays wednesday` | same: `ia=sr=next=icStart=2026-08-26` | shared behavior confirmed ✓ |
| **RC2** off-rule (b) | `add-repeating --when 2026-08-24` (Mon) `--frequency weekly --interval 1 --weekdays sunday` | `of=[{wd=0}] icStart=sr=2026-08-24 ia=next=2026-08-30` | Monday verbatim first, then Sundays ✓ |
| **RC3** monthly/2 (c) | `add-repeating --when 2026-09-15 --frequency monthly --interval 2` | `fu=8 fa=2 of=[{dy=0}] icStart=sr=2026-09-15 ia=next=2026-10-01` | first occurrence honored ✓ |
| **RC4** Next + ends-on (d) | `add-repeating --when 2026-08-26 --frequency weekly --interval 2 --weekdays wednesday --ends-on 2026-12-30` | `ed=2026-12-30 ia=sr=next=icStart=2026-08-26` | ends in `ed`, Next distinct — NO collapse ✓ |
| **RC5** reminder | `make-repeating --frequency weekly --interval 1 --reminder 18:00` | `reminderTime=1207959552` = `18<<26` = 18:00 | reminder honored (UIC6-g artifact confirmed) ✓ |

**Verdict: the fix is certified.** The #476 repro now yields the requested first occurrence; off-rule/monthly phases honored; ends-on coexists with Next; the reminder is driven. Re-cert script: [`lab/scripts/anch2-recert.sh`](../../lab/scripts/anch2-recert.sh).
