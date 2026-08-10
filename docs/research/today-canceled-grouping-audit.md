# Today canceled-row grouping field audit (2026-08-10)

## Scope and evidence handling

This report reconstructs a production Things cleanup from the CLI audit trail and the originating Codex session log. It is a field report, not immutable probe evidence: no disposable-VM reproduction has run yet.

The exact source artifacts contain production task titles, notes, project/area names, UUIDs, and local paths. This repository is public, so those files are intentionally **not committed**. Exact copies are retained locally under the gitignored `lab/artifacts/today-canceled-grouping-2026-08-10/` directory:

| Local-only artifact | Contents | SHA-256 |
| --- | --- | --- |
| `today-before.json` | Exact `things today --all --full --json` output before cleanup | `d1446b743816ec8f0eb65b24b79bc0082126e1b40a48a4c45802bbf434c595e6` |
| `today-after.json` | Exact output after the grouping was reported | `dda2f70a6f7eabbcf0a929de454c72e1623741a0c7e36811159296c60269a075` |
| `session-tool-calls.ndjson` | All 68 exact tool calls from the session window, including every shell command | `33f197869366d49ef426ed0064687119a99e541ac29f94576e78d5edae6d7672` |
| `things-mutation-audit.jsonl` | All 441 exact Things audit records in the window | `eb2aa7012aca76f27621aba81003d44efb53a8dbec7500795b821b2c1ba7a4b1` |

The public report gives the complete causal command sequence with private operands replaced by typed placeholders. This is the most evidence the public-repository safety rail permits; the hashes bind it to the retained exact files.

## Finding

The grouping was not limited to canceled rows. The session caused a broad Today-order rewrite.

The strongest causal event is the one-item container move at `21:22:45Z`. `todo move` automatically ran its default placement leg at `21:22:46Z`: a native `_private_experimental_ reorder to dos in list "Today"` invocation. The wire named the moved row first and then **all 277 open Today members**, ordered by the reorder planner's open-only `todayIndex ASC` census. It named none of the 127 unswept canceled rows.

That order differs materially from the user-visible Today order before cleanup. The Today reader follows Things' two-level comparator: entry cohort (`todayIndexReferenceDate` descending), then `todayIndex` ascending. The move placement pre-read instead enumerates open rows by raw `todayIndex` alone. Among the 267 open rows common to the pre-cleanup snapshot and the reorder wire:

- the longest common subsequence was only **57 of 267**;
- **16,191 of 35,511** row pairs inverted (**45.6%**);
- therefore the wire was not merely the old visible order with canceled rows removed.

For the 267 rows common to the reorder wire and the later snapshot, relative order matched **exactly**: longest common subsequence 267, zero pair inversions. Ten rows existed only in each side because additional creates/completions/scheduling mutations occurred after the reorder.

This establishes a deterministic low-level rule for the reorder wire: **moved row first, followed by then-current open Today members in raw `todayIndex ASC` order**. It does **not** establish a semantic/native canonical rule such as title, recurrence lineage, date, or task kind. The apparent series grouping is a consequence of the raw index population the app already held, not a planner rule that groups related tasks. Because the session did not save a snapshot between batch 2 and the move, it cannot prove that all 16,191 inversions first arose during the reorder rather than during the preceding cancellations or other writes; it proves that the move sent and enforced a whole-open-list order materially different from the pre-cleanup visible order.

The user's four observed recurring cohorts corroborate the whole-list effect (labels anonymized because their production titles cannot enter the repository):

| Cohort | Before | After |
| --- | --- | --- |
| A | 5 instances across 4 runs | one contiguous 5-row block |
| B | 10 instances across 10 runs | one contiguous 10-row block |
| C | three lineages of 10–11 instances, each spread across 10–11 runs | each reduced to 2 runs (one main block plus an outlier) |
| D | 10 instances across 10 runs | 2 runs (one 9-row block plus an outlier) |

Across every multi-instance recurring lineage, the pre-cleanup open list had **17 lineages / 203 rows, with 0 lineages contiguous**. The later open list had **11 lineages / 74 rows, with 6 lineages contiguous**. Because intervening mutations and cancellations changed membership, these aggregate counts are descriptive rather than a controlled proof.

## Before and after

All positions below are zero-based positions in the exact Today JSON arrays.

### Before

- 404 Today rows, all open.
- The 77 rows subsequently selected for cancellation batch 1 occupied positions 3–348 in 68 separate runs; representative positions: 3, 6, 12, 13, 17.
- The 50 batch-2 rows occupied positions 5–355 in 42 runs; representative positions: 5, 14, 19, 33, 34.
- Combined, the future 127-row canceled cohort occupied 73 runs across positions 3–355. It was strongly interleaved, not pre-grouped.

### After the move/reorder and later session mutations

- 406 rows: 277 open, 127 canceled, 2 completed.
- Exact status runs: open 0; completed 1; open 2–268; canceled 269–271; completed 272; canceled 273–396; open 397–405.
- Thus 124 canceled rows formed one near-bottom contiguous block, with three more immediately above it separated by one completed row.

## Chronology

Times are UTC. The mutation audit records write attempts/finals; ordinary reads come from the session tool-call log.

| Time | Event and evidence |
| --- | --- |
| 20:42:26 | Initial compact Today read. |
| 20:45:29 | Saved the exact full pre-cleanup Today snapshot; counted 404 rows and analyzed recurring duplicates. |
| 20:45:33–20:45:43 | Inspected representative rows and duplicate cohorts from the saved snapshot. |
| 20:46:38–20:46:44 | Read cancel help, batch help, and capability metadata. |
| 20:46:52 | Dry-ran all 77 batch-1 cancellations; all plans returned OK. |
| 20:47:18 | Started the 77-item cancellation loop. |
| 20:47:52 | Read Today to check the two targeted duplicate families while the long loop was still active. |
| 20:47:57 | Issued one explicit single-row cancellation retry. |
| 20:48:04 | Re-selected the same families from a fresh Today read without an open-status predicate and re-ran the cancellation loop. Since unswept canceled rows remain in Today, this redundantly re-canceled the same rows. |
| 20:47:18–20:48:31 | Audit result: 155 successful cancel finals across 77 unique UUIDs (77 intended + one overlapping explicit retry + 77-row retry, with one row hit in all three paths). No reorder operation was recorded. |
| 20:48:41–20:48:48 | Read duplicate summaries first across all statuses, then open-only. |
| 21:03:23 | Read open Today rows matching the second cleanup subject. |
| 21:06:50–21:06:53 | Ran two searches to distinguish the retained item and related supply task. |
| 21:07:08 | Read update/add help. |
| 21:07:19–21:07:24 | Updated one retained row and created one replacement action. |
| 21:07:29 | Canceled batch 2: 50 successful finals across 50 unique UUIDs. No reorder operation was recorded. |
| 21:07:58–21:09:52 | Read repeat help; dry-ran a repeat conversion; enabled the UI vector; attempted, retried, and verified the conversion. |
| 21:12:35–21:12:47 | Two searches, one notes update, and one completion unrelated to the grouping. |
| 21:18:31 | Read area names. |
| 21:22:04–21:22:34 | Read project/heading/move help; created and inspected a project; issued one malformed help lookup and then the correct move help. |
| 21:22:42 | Updated the single pre-existing task later moved into the project. |
| 21:22:45 | `todo move` changed that one task's container. |
| 21:22:46 | Automatic placement leg recorded as `op: reorder`: native Today reorder, one named movee, wire expanded to all 277 open Today members, zero canceled members. |
| 21:23:10–21:24:30 | Completed the moved task, added a completed historical task, edited tags/schedules, and scheduled a reminder. These explain the ten-row set difference between the reorder wire and final open snapshot but preserve the 267 common rows' exact wire-relative order. |
| 21:24:23 | User first reported that canceled rows and other task families had suddenly grouped after the move. |
| 21:25:30 | Saved the exact full post-event Today snapshot. |
| 21:25:34–21:25:42 | Ran three status-transition analyses, including one erroneous exploratory expression followed by two corrected expressions. |

## Complete public command ledger

This lists every Things-related shell call in order, including help, inspection, dry-run, retry, and mutation calls. `<…>` placeholders replace production content. The exact 68-call session ledger, including the 22 non-Things orchestration/documentation calls, is retained in the hashed local artifact above.

1. Read the installed Things CLI skill file.
2. `things today --json`.
3. `things today --all --full --json > <before-snapshot>` plus duplicate aggregation and row count.
4. Inspect the first three saved rows with `jq`.
5. Aggregate all repeated-instance title groups with `jq`.
6. `things todo cancel --help`.
7. `things batch --help`.
8. `things capabilities --json` filtered to cancel/to-do operations.
9. Select 77 batch-1 UUIDs from the saved snapshot; run `things todo cancel <uuid> --dry-run --json` for each; aggregate results.
10. Repeat the same 77-UUID selection; run the real `things todo cancel <uuid> --json` loop; aggregate successes/failures/undo tokens.
11. Fresh `things today --all --full --json` filtered to the two batch-1 families.
12. `things todo cancel <one-private-uuid> --json` retry.
13. Fresh Today read; re-select the batch-1 families; run the 77-item cancel loop again; aggregate results.
14. Fresh Today read; summarize the eight largest repeated-instance groups across all statuses.
15. Repeat the summary with an open-status predicate.
16. Fresh Today read filtered to open rows matching batch 2; aggregate dates/counts.
17. `things search <batch-2-term> --full --json > <search-snapshot>` and inspect open hits.
18. `things search <related-term> --full --json` and inspect open hits/notes.
19. `things todo update --help` and `things todo add --help`.
20. `things todo update <retained-uuid> --title <private-title> --json`.
21. `things todo add <private-title> --area <private-area> --when today --notes <private-notes> --json`.
22. Fresh Today read; select 50 open repeated batch-2 rows except the retained UUID; run `things todo cancel <uuid> --json`; aggregate results.
23. `things todo make-repeating --help`.
24. `things todo make-repeating <uuid> --frequency monthly --interval 4 --after-completion --dry-run --json`.
25. `things config set ui-enabled true`.
26. `things todo make-repeating <uuid> --frequency monthly --interval 3 --after-completion --dangerously-drive-gui --json`.
27. `things show <original-uuid> --json` with a focused repeating/status projection.
28. Retry the same interval-3 repeat conversion.
29. `things show <successor-uuid> --json` with a focused repeating projection.
30. `things search <private-two-term-query> --full --json`.
31. `things search <private-one-term-query> --full --json`.
32. `things todo update <uuid> --append-notes <private-notes> --json`.
33. `things todo complete <uuid> --json`.
34. `things areas --json` projected to titles.
35. `things project add --help` and `things project heading --help`.
36. `things project heading add --help`.
37. `things project add <private-title> --area <private-area> --notes <private-notes> --todo <eight-private-titles> --json`.
38. `things project show <project-uuid> --full --json` projected to child UUID/title pairs.
39. `things project show <project-uuid> --full --json`.
40. `things todo move <malformed-ref> --help`.
41. `things todo move --help`.
42. `things todo update <movee-uuid> --title <private-title> --append-notes <private-notes> --json`.
43. `things todo move <movee-uuid> --to-project <project-uuid> --json` — this triggered the automatic native Today reorder.
44. `things todo complete <movee-uuid> --json` and `things todo add <private-title> --project <project-uuid> --completed-at 2026-08-10 --notes <private-notes> --json`.
45. `things todo tags --help`.
46. `things todo tags <uuid> --add <private-tag> --json`.
47. `things todo update <uuid> --when today --json`.
48. `things todo update <uuid> --when 2026-09-24 --json`.
49. Read the locally created workflow skill; save `things today --all --full --json` as the after snapshot; summarize totals, status counts, and the first 20 rows.
50. Run the first exploratory `jq` status-transition expression (incorrect transition clause).
51. Run a corrected `jq` expression for first canceled/completed positions and transition indexes.
52. Run the final corrected `jq` expression emitting every status-run start.

Some numbered entries contain multiple shell commands because the original tool call contained a newline or pipeline. No Things call in the session window is omitted.

## Assessment and required reproduction

Confidence is high that the automatic move-placement path can reorder the whole open Today population and exclude unswept resolved rows. Confidence is not yet sufficient to say which underlying Things columns the private command rewrote, because the session did not capture a DB snapshot immediately before and after the native reorder.

Run a disposable-VM campaign with interleaved entry-date cohorts, multiple repeat lineages, and open + canceled-unswept rows:

1. Capture GUI order and raw `todayIndexReferenceDate`, `todayIndex`, status, and UUID.
2. Cancel a subset and capture again before any reorder.
3. Perform the equivalent raw container move without the CLI placement leg; capture again.
4. Run the CLI `todo move`; capture the exact compiled reorder wire and full DB diff.
5. Test whether the native Today reorder changes `todayIndex` only, normalizes `todayIndexReferenceDate`, or both.
6. Assert that a one-item container move does not alter unrelated rows unless an explicit position was requested.

If the VM isolates the CLI placement leg as the cause, likely remedies are: omit the default reorder when a container-only move has no explicit position, or build a GUI-faithful full order that includes eligible unswept resolved rows and respects the Today entry-cohort comparator. Do not choose between those fixes until the byte-level reproduction establishes the private command's write set.
