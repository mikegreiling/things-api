# Upcoming membership & deadline forecasting — UI-oracle research (UPC1)

**Why.** The GUI's Upcoming view forecasts deadline-carrying items the CLI's `upcoming` misses: `upcomingView` (src/read/views.ts) selects only scheduled rows (`start=2 AND startDate > today`) plus repeating-template occurrences, so **every deadline-only future item is invisible to the CLI**. Live-prod observations (Mike) established two anchors: a SOMEDAY project with a future deadline (no when-date) DOES appear in GUI Upcoming on its deadline date; an INBOX to-do with a future deadline does NOT. This campaign mapped the full membership matrix before touching the view.

**Method.** One golden clone (`things-run-upc1-20260713-172846`), airgapped, clock pinned to the golden's 2026-07-05 and advanced in stages to manufacture deadline-crossing. Setup writes go through official surfaces only (URL scheme `add`/`add-project`/`update`/`update-project`). Membership is read two ways: the GUI's own **AppleScript list oracle** (`get name of to dos of list "Upcoming"/"Today"/"Someday"` — a pure read against the running app, the [today-order-research](today-order-research.md) technique) **and** VNC screenshots of the rendered GUI (row anatomy + circle colour, the parts the oracle can't see). DB dumps give ground-truth field values. Script: [lab/scripts/research-upc1.sh](../../lab/scripts/research-upc1.sh); artifacts (gitignored): `lab/artifacts/things-run-upc1-20260713-172846/` (screenshots + `final.sqlite`).

Packed-date decode (`y<<16 | m<<12 | d<<7`): 07-07=132805504, 07-08=132805632, 07-09=132805760, 07-10=132805888, 07-11=132806016, 07-14=132806400.

## Verdict table

| Probe | Setup | GUI verdict | Evidence |
|---|---|---|---|
| **UPC1-A** anytime + deadline | `start=1`, no startDate, deadline 07-08 | **PRESENT** in Upcoming under the **07-08 (deadline) header**; solid checkbox + red "3 days left" flag | `upc1a-upcoming.png`; AS Upcoming lists it |
| **UPC1-A** someday to-do + deadline | `start=2`, no startDate, deadline 07-08 | **PRESENT** under 07-08 header; **dashed** checkbox + red flag | same |
| **UPC1-A** someday **project** + deadline (control) | `type=1 start=2`, no startDate, deadline 07-08 | **PRESENT** under 07-08 header; **dashed progress circle** + red flag — matches prod | same |
| **UPC1-A** inbox to-do + deadline | `start=0`, no startDate, deadline 07-08 | **ABSENT** from Upcoming — matches prod | same (A4 not in AS list) |
| **UPC1-B** grouping (when+deadline) | LATEDL when 07-07/dl 07-10; EARLYDL when 07-10/dl 07-07 | Grouped by the **WHEN-date**, **one row**, deadline shown as a right-side red "N days left" flag. EARLYDL sits under 07-10 (its when) even though its deadline 07-07 is earlier | `upc1b-upcoming.png`; AS order |
| **UPC1-B** future-start suppression | advance to 07-08 (past EARLYDL's dl 07-07, before its when 07-10) | EARLYDL **ABSENT from Today** — the future startDate wins (F-DL-FUTURE-START); still in **Upcoming** under 07-10. `deadlineSuppressionDate` stays NULL (suppression is from the future start, not a dismissed nag) | `upc1b-today-at0708.png`; DB |
| **UPC1-C** (i) deadline pull | someday proj+todo, deadline 07-09; advance to 07-10 | Both **PULLED INTO Today** (F-DL). They **leave the Someday list** while there | `upc1c-today-s1-0710.png`; AS |
| **UPC1-C** (ii) blue circle | reach suppressed state, re-observe Someday | **Suppressed past-due PROJECT → BLUE dashed circle; suppressed past-due TO-DO → GRAY dashed checkbox** (both carry the red overdue flag) | `upc1c-someday-SUPPRESSED.png`; DB supp==deadline |
| **UPC1-D** re-arm | edit suppressed project's deadline to future 07-14 | **Reappears in Upcoming**; **re-enters Today** when 07-14 arrives (stale supp cleared) | `upc1d-today-reentry-0714.png`; DB |

## The ratified Upcoming membership rule

An open, untrashed, non-repeating row appears in the GUI **Upcoming** (grouped/sorted by `groupKey = COALESCE(startDate, deadline)`, `groupKey > today`) iff **either**:

- **Scheduled** — `startDate > today` (any `start`; scheduled rows are `start=2` with a `startDate`). Groups under its **when-date (startDate)**. *(This is the only cohort the CLI currently emits.)* If it also carries a deadline, the deadline rides along as a flag.
- **Deadline-forecast** — `startDate IS NULL AND start IN (1,2) AND deadline > today AND (deadlineSuppressionDate IS NULL OR deadlineSuppressionDate < deadline)`. Groups under its **deadline date**. **This is the entire cohort the CLI MISSES**: anytime (`start=1`) and someday (`start=2`) to-dos, and someday projects, that carry a future deadline and no when-date. **Inbox (`start=0`) is excluded** — a future deadline does not forecast an Inbox item into Upcoming (though a *due* deadline still pulls it into Today; see below).

Symmetry with the Today model ([today-order-research](today-order-research.md), atlas `schema-v26.md`): Today pulls `deadline <= today AND startDate IS NULL AND start IN (0,1,2) AND not-suppressed` (Inbox included); Upcoming forecasts the same predicate one step earlier (`deadline > today`) but with **Inbox excluded**. The suppression clause is identical, so a re-armed deadline (supp < deadline) reappears in Upcoming and, on arrival, in Today (UPC1-D).

## The blue-circle verdict (UPC1-C)

**Blue dashed circle = a PROJECT with a PAST-DUE (overdue) deadline** — the project's progress ring rendered in the app **accent colour**, the list-view analog of the red overdue deadline flag. It is a coherent indicator, **not a bug**.

Discriminators, all directly observed:

- **NOT "currently in Today".** The two prod blue projects are *suppressed* (dismissed nag), so they are **not** in Today, yet render blue. Falsified. (And the reason a past-due someday project appears in the Someday list *at all* is suppression — an unsuppressed past-due someday item is pulled into Today and leaves the Someday list, UPC1-C(i).)
- **NOT "suppressed per se".** The suppressed past-due **to-do** in the very same list is **GRAY**. If blue tracked the suppression flag, the to-do would change too. It doesn't — only the **project** circle goes blue. Suppression is *why the overdue project stays in Someday*, not *why it is blue*.
- **YES "overdue deadline".** Baseline: a future-deadline someday project renders **gray** (`upc1c-someday-baseline-0708.png`); once its deadline is past it renders **blue** (`upc1c-someday-SUPPRESSED.png`). No-deadline someday projects render gray. The flip is the deadline crossing today.
- **Scope = projects only.** A to-do's checkbox has no analogous colour change (stays gray); the effect is specific to the project progress circle. (In the *Today* content pane a project also renders a blue ring — same accent colour, signalling "active today".)

No `docs/things-app-oddities.md` bug entry is warranted for the blue circle (coherent indicator — recorded there as §8f "NOT a bug" for completeness). See the two genuine quirks below.

## Two mechanism findings (new)

**1. `deadlineSuppressionDate` is stamped by rescheduling an overdue item, not by a "dismiss" button (oddities §8e).** Things 3.22.11 has **no dedicated dismiss-deadline command** — the Items-menu / context-menu / row "Deadline…" popover only lets you *set* a date or *Clear* (=delete) the deadline; clicking the red flag merely selects the row. `deadlineSuppressionDate := deadline` is set as a **side effect of rescheduling an OVERDUE-deadline item to a no-startDate bucket** — verified for both **Someday** (`update`/`update-project when=someday`) and **Anytime** (`update ... when=anytime`). The app records the suppression so the already-past deadline stops re-pulling the item into Today. Rescheduling to a **future date** instead relies on the future `startDate` to suppress Today and does **not** stamp `deadlineSuppressionDate` (UPC1-B, EARLYDL: supp stayed NULL). This is the true nature of the "dismissed nag" the [today-order-research](today-order-research.md) F-DL notes named — a reschedule side-effect, coherent with the todayView predicate. (Projects require `update-project`; a plain `update` no-ops on a project row.)

**2. Overdue deadline-only members are COMPUTED overlays until the Today "new to-dos" banner is acknowledged, which MATERIALIZES them (oddities §8d).** Immediately after launching at a clock past the deadline, a deadline-pulled item is still `start` unchanged (0/1/2) with `startDate IS NULL` — the Today membership is a pure computed overlay, but `todayIndexReferenceDate` has been stamped = the deadline (its entry-cohort date). Clicking **OK** on the yellow "You have N new to-dos" banner **materializes** every such member: `start → 1`, `startDate := deadline`, `todayIndexReferenceDate := deadline` (isolated clean pre/post: `upc1e-today-before-OK.png` at `start=2` → after-OK DB at `start=1`). Implication for readers: a deadline-pulled item's own `start`/`startDate` change the moment the user acknowledges the banner — the deadline-overlay is not a stable DB signal on its own. (This is orthogonal to suppression; suppressed items are never in the banner, so they keep `start=2`, matching the prod blue-circle rows.)

## Repro

```sh
export TART_HOME=/Volumes/Workspace/tart
VNCDO=/path/to/vncdo lab/scripts/research-upc1.sh   # VNCDO optional (screenshots only)
```

Discovery script, no assertions. Without `$VNCDO` the full membership matrix still lands (AS oracle + DB dumps); screenshots (row anatomy + blue circle) need VNC.

## Repo impact (deferred to the fix PR — this campaign is evidence-only)

- `upcomingView` (src/read/views.ts) gains the **deadline-forecast** cohort: union in `startDate IS NULL AND start IN (1,2) AND deadline > today AND not-suppressed`, grouped by `deadline`; keep Inbox (`start=0`) out. Sort/group key becomes `COALESCE(startDate, deadline)`. The occurrence-synthesis and `--until/--since/--repeats` paths are unaffected.
- atlas `schema-v26.md`: add an **Upcoming** membership row mirroring the Today row.
- Fixtures: anytime/someday/someday-project deadline-forecast present, inbox absent, when+deadline groups by when-date, suppressed absent, re-armed present.
- Tracked as an unblocked code item in [docs/up-next.md](../up-next.md) §5.
