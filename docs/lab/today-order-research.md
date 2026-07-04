# Today ordering & membership — UI-oracle research (Phase 10c)

**Method.** The UI's own ordering is readable via AppleScript (`get id of to dos of list "Today"` — a pure read against a running app). Two reproducing VM runs used a golden clone booted **two days past** the golden's pin date (2026-07-07 vs 07-05) to manufacture stale `todayIndexReferenceDate` cohorts, promoted upcoming seeds, spawned repeat instances, freshly-added items, and deadline-membership edge probes. Live reconciliation then confirmed the model against the real library. Script: [lab/scripts/research-today-order.sh](../../lab/scripts/research-today-order.sh); artifacts `things-run-todayorder-20260704-021325` / `-021640` (UI order + DB backup each).

## The membership rule

Open, untrashed, non-template, type to-do/project, AND:

- `startDate ≤ today AND start IN (1, 2)` — the classic rule; **OR**
- `deadline ≤ today AND startDate IS NULL AND NOT suppressed` — **a due deadline pulls an item into Today even from the Inbox** (F-DL-TODAY entered from `start=0`, top of list). Suppression:
  - a **future startDate** wins (F-DL-FUTURE-START, start 07-10 + deadline 07-06 overdue → absent);
  - a **dismissed nag**: `deadlineSuppressionDate` stores the dismissed deadline — membership requires `deadlineSuppressionDate IS NULL OR < deadline`. All 12 live absentees carried `suppressionDate = deadline` exactly; a later deadline re-arms the nag.

This **corrects** the earlier "deadline-only items never enter Today" claim (2026-07-02 badge inference): every due deadline-only item on the live library happened to be nag-dismissed, so the badge math coincidentally held.

## The comparator

```
startBucket ASC,
COALESCE(todayIndexReferenceDate, startDate, deadline) DESC,   -- newest ENTRY cohorts on top
todayIndex ASC,                                                -- manual order within a cohort
uuid ASC                                                       -- observed stable tiebreak
```

`todayIndexReferenceDate` = the date the item **entered** Today: its startDate when scheduled, its deadline when deadline-driven; re-stamped on manual reorder. The app does **not** normalize on launch — the live library carries reference dates spanning 18 months, which is why the old `(bucket, todayIndex)` comparator mis-ordered multi-cohort lists.

Every VM observation fit (both runs, 14 and 16 rows): fresh URL-adds front-insert within today's cohort; repeat instances and stale promotions sit at `todayIndex = 0` in their entry-date cohort; equal-`todayIndex` ties resolved by uuid in all five observed cases (provisional but consistent).

## Live reconciliation (the acceptance test)

Against the real library, same moment as a UI read:

- **Member count: ours 393 = UI 393** exactly (AppleScript `to dos` includes projects — `project` inherits from `to do`, O12). The delta that closed the books: 12 suppressed deadline items excluded.
- **Top-10 positions: 10/10 identical.**

## Repo impact

`todayView` predicate + ORDER BY rewritten (src/read/views.ts); `deadlineSuppressionDate` added to the schema manifest (fingerprint recomputed); atlas Today row corrected. Fixture tests cover the cohort comparator, uuid tiebreak, inbox-pull, future-start suppression, and nag suppression (incl. the stale-suppression re-arm case).

## Open edges

- The uuid tiebreak is observed-stable (5 cases), not proven — a future probe could seed many idx-0 rows.
- Whether deadline-driven entry stamps `todayIndexReferenceDate` at the deadline day or at first launch after it: indistinguishable in these runs (both were launch-after).
