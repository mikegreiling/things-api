# DACON1 — off-rule first occurrence + deadline anchoring + cursor skip

**Probed under: `things-lab-golden-v3` · Things 3.22.14 (build 32214000) · macOS 15.7.7 · DB schema v26 · pinned clock 2026-07-05 12:00 (a SUNDAY).** ONE disposable clone `dacon1-lab` of golden-v3 (golden untouched; every write inside the clone), airgapped (default route deleted, ping fails), clock pinned before Things launched. golden-v3 carries the baked L3-accessibility grant; the Repeat dialog was driven by the SHIPPED production CLI (`todo make-repeating … --dangerously-drive-gui`) over SSH. Ground truth = read-only guest SQLite (`~/labh/rsum.py` decodes `rt1_recurrenceRule` + `rt1_nextInstanceStartDate` cursor + `rt1_instanceCreationStartDate` + `deadline`). Fixtures fully synthetic (`DC-*` titles); the maintainer's host titles/domains never left the host. Driver: [`lab/scripts/dacon1-matrix.sh`](../../lab/scripts/dacon1-matrix.sh) (self-contained: clone → boot → airgap → pin → ship dist → drive → verify → teardown-on-EXIT). Artifacts (gitignored) `lab/artifacts/dacon1-lab/`.

Packed dates decode `y<<16|m<<12|d<<7`; `ia`/`sr` are the anchor epochs; monthly/yearly `of` day/month indices are 0-based (`dy=15,mo=9` = Oct 16); `ts` = the deadline-relative start offset (≤ 0); `fu` 256=weekly/8=monthly/4=yearly.

## The question

A concrete `--when` together with an EXPLICIT calendar anchor can DISAGREE (the anchor names one placement, `--when` lands elsewhere). ANCH2 ([anch2-next-field.md](anch2-next-field.md)) proved the dialog's "Next:" field accepts an OFF-SCHEDULE first occurrence for a weekly/create/no-deadline series (cell b: a Monday Next on a Sunday rule lands Monday-first, Sundays thereafter). The maintainer wants that pattern as a first-class feature (`--weekdays wednesday --when <a thursday>` = Thursday first, Wednesdays after). But a live host `reschedule-repeat` on a yearly deadlined template with a pending materialized instance produced a cursor that skipped a year (landed 2029-10-02). Does the app honor an off-rule first ACROSS {create, reschedule} × {weekly, monthly, yearly} × {no-deadline, deadline+start-earlier}, and where does the 2029 skip come from?

## CREATE matrix — DB-verified (this campaign)

Each cell: seed a plain to-do (`--when`), then `todo make-repeating` with the shown flags; read the landed template.

| Cell | request (synthetic) | landed rule | verdict |
|---|---|---|---|
| **DC1** weekly / no-deadline | `--weekdays wednesday --when 2026-07-16` (a Thursday) | `fu=256 of=[{wd=3}]` · `icStart=sr=2026-07-16` (Thu, verbatim) · `ia=next=2026-07-22` (next Wed) | **HONORED** — appears Thu 07-16, Wednesdays thereafter (the maintainer's example) |
| **DC2** monthly / no-deadline | `--on-day 20 --when 2026-08-10` | — no template landed — | **DISHONORED** — the month row SNAPPED Next 08-10 → **08-20** (the anchor day); the CLI's set-datetime read-back rejected it (`-2700`), verify → silent-noop, clone trashed, original restored |
| **DC3** yearly / no-deadline | `--yearly-month 10 --on-day 16 --when 2028-11-05` | `fu=4 of=[{dy=15,mo=9}]` (Oct 16) · `icStart=sr=2028-11-05` (verbatim) · `ia=next=2029-10-16` | **HONORED** — appears Nov 5 2028, Oct 16 thereafter |
| **DC4** yearly / **deadline** (the live-host CREATE shape) | `--yearly-month 10 --on-day 16 --when 2028-10-16 --deadline --start-days-earlier 14` | `fu=4 of=[{dy=15,mo=9}]` (due Oct 16) · `ts=-14` · `sr=icStart=2028-10-16` (start = --when) · `ia=2029-10-16` · **`next=2029-10-02`** · deadline set | **HONORED** — first appears Oct 16 2028 / due Oct 30 2028; thereafter due Oct 16, appearing Oct 2 (14 days earlier). The cursor `2029-10-02` = the rule-correct next START (Oct 16 − 14). |
| **DC5** weekly / **deadline** | `--weekdays wednesday --when 2026-07-16 --deadline --start-days-earlier 2` | `fu=256 of=[{wd=3}]` · `ts=-2` · `sr=icStart=2026-07-16` (Thu) · `ia=2026-07-22` · `next=2026-07-20` · deadline set | **HONORED** — appears Thu 07-16 / due 07-18; thereafter Wed, appearing Mon |

## Verdicts

1. **Off-rule first is HONORED for WEEKLY and YEARLY**, deadlined or not (DC1/DC5, DC3/DC4). The typed `--when` lands verbatim as the first instance's START (`rt1_instanceCreationStartDate`); the explicit anchor drives the recurring grid; the cursor (`rt1_nextInstanceStartDate`) is the next RULE-ALIGNED start. In deadline mode `--when` is the start and the anchor names the DUE date (`start = anchor − startDaysEarlier`), reconfirming the YANCH1 law.

2. **Off-rule first is DISHONORED for MONTHLY** (DC2). The month row's "Next:" field SNAPS to the anchor day — driving Next 08-10 under a day-20 anchor committed 08-20. A monthly first occurrence off the anchor day is INEXPRESSIBLE. (The old shipped path only discovered this mid-drive as a `-2700` set-datetime rejection + rollback; DACON1 fail-closes it at validation instead.)

3. **Where 2029-10-02 comes from.** DC4 (the live shape on CREATE) lands cursor `next=2029-10-02` = the rule-correct next START (due Oct 16, minus the 14-day start offset). This is NORMAL, not a skip: on create the FIRST occurrence is `icStart=2028-10-16` and the cursor points at the following year's start. The live-host "2028 skip" was a **reschedule + pending-materialized-instance** interaction (the pending 2027 instance occupied the current slot; the freshly-driven 2028 off-rule first did not yield a cursor pointing into 2028) — NOT a property of the off-rule-first pattern, which create honors cleanly.

## App craft / oddity

- **Monthly Repeat dialog snaps "Next:" to the anchor day** (DC2) — recorded in [things-app-oddities.md](../things-app-oddities.md). Weekly and yearly accept an off-anchor Next; monthly constrains it to the anchor's day-of-month.

## Shipped (branch `mg/dacon1-deadline-contradiction`)

1. `assessOffRuleFirst` (`repeat-anchor.ts`) classifies a request: on-rule (null) / honored off-rule (weekly, yearly → disclose) / dishonored (monthly → refuse). Deadline-shift-aware (compares the anchor to `deadlineDriveNext` = when + startDaysEarlier).
2. Fail-closed monthly refusal at validation (`assertRepeatRule`) with the two nearest expressible alternatives (on-rule `--when`, or omit the anchor to derive it).
3. Off-rule-first DISCLOSURE — a `warnings[]` entry + `--dry-run` note stating BOTH halves ("appears `<when>`[, due `<when+N>`]; thereafter `<rule pattern>`[, appearing N days earlier]") for make / add / reschedule.
4. Reschedule verify drops the `cursor == --when` assertion for an off-rule first (the cursor is the next aligned start, DC4), keeping the rule-anchor assertion.
5. Poller stable-mismatch early exit (`verify/poller.ts`) — returns `mismatch` once an asserted field settles on a stable wrong value for ≥3 identical polls spanning ≥5s (the live-host 120s never-converging poll), never firing while state changes.

## Residual (QUEUED — see [up-next.md](up-next.md))

- **Reschedule + pending materialized instance, live drive.** The decisive live-failure shape (reschedule a deadlined yearly template that already has a pending materialized instance, off-rule first → the 2028 cursor skip) could not be re-driven in-lab this campaign: a repeating template with no CURRENT materialized instance is not reveal-selectable, and materializing one needs multi-step clock advancement (ANCH2 spawn caveat: a single large clock jump does not retroactively materialize). This is the same residual YANCH1 queued. CREATE (DC4) characterizes the mechanism (2029-10-02 = rule-correct next start; the skip is the pending-instance interaction); a fresh-clone live reschedule with a materialized instance is queued to confirm whether a validation refusal is warranted for that specific shape or the current fail-closed verify + poller early-exit suffice.
