# Reversibility matrix — test-suite plan

Written 2026-07-11. Motivation: `todo.clear-dated-reminder` was mislabeled IRREVERSIBLE on a false premise ("setting a dated reminder is dead on every surface" — actually only the Shortcuts set-detail path is dead; URL `when=<date>@<time>` sets one fine, R18). The existing undo tests (`test/unit/undo-plan.test.ts`, ~40 scenario cases) never caught it because they're **scenario-based**, not a **systematic per-op matrix** — and the one test that touched clear-reminder asserted its (wrong) irreversibility, locking the bug in. This plan builds the reversibility analog of `docs/capability-matrix.md`: a single source-of-truth table over every `OperationKind`, driving round-trip tests and an exhaustiveness guard so no op can ship unclassified.

## Goal

For **all 36** `OperationKind`s (`src/write/operations.ts`), assert a declared reversibility CLASS and prove it with a do→undo→verify round-trip in a fixture DB, plus an out-of-band precondition test. A new op added to `OPERATION_KINDS` must FAIL the suite until it's classified and round-trip-tested.

## Reversibility classes

- **`reversible`** — undo restores the pre-op state exactly (round-trip is identity on the touched fields).
- **`reversible-with-loss`** — undo restores the intent but a documented dimension is unrecoverable; the test asserts BOTH the restore AND the specific loss.
- **`conditional`** — reversibility depends on captured/current state; the test covers both the invertible and the irreversible branch.
- **`irreversible`** — no validated inverse; `planUndo` returns `kind:"irreversible"` with a reason; the test asserts the reason.

## Initial classification (from `undo.ts`, to be encoded as the table)

| Class | Ops |
|---|---|
| reversible | todo.add, project.add, todo.duplicate, project.duplicate, todo.complete, todo.cancel, todo.reopen, project.complete, project.cancel, project.reopen, project.delete, project.restore, todo.restore, todo.set-tags, project.set-tags, area.update, tag.update, heading.rename, heading.unarchive, reorder (native), area.add\*, tag.add\* |
| reversible-with-loss | todo.delete (restores to Inbox de-scheduled, E15), todo.replace-checklist (per-item completion lost, T07), todo.backdate (day precision), todo.update (evening bucket for stale items; schedule/reminder entanglement), project.update (same), heading.archive (cascade children reopen), todo.clear-dated-reminder (reminder restored against CURRENT schedule; see below) |
| conditional | todo.move (prior container may be uncaptured), project.move (prior area may be uncaptured), todo.clear-dated-reminder (irreversible when the item is now repeating/unscheduled), reorder (bounce summary vs native), any create whose uuid was never discovered |
| irreversible | area.delete, tag.delete, trash.empty, heading.create |

\* `area.add`/`tag.add` invert to a PERMANENT delete requiring `--dangerously-permanent` — classify `reversible` but tag the ack requirement in the table.

Note the overlap: `todo.clear-dated-reminder` and `todo.move` appear twice — they are genuinely `conditional`, with a `reversible-with-loss` happy path. The table's class is the *worst realistic* case; the test exercises every listed branch.

## Deliverables

1. **`src/write/reversibility.ts`** — the source-of-truth table: `Record<OperationKind, { class: ReversibilityClass; note: string; ack?: "permanent" | "checklist-reset" }>`. Typed as a total record over `OperationKind` so a new op is a COMPILE error until added. Optionally surfaced later (a `things capabilities` reversibility column / a docs generator) — out of scope here, but shape it for that.
2. **`test/unit/reversibility-matrix.test.ts`**:
   - **Exhaustiveness guard**: iterate `OPERATION_KINDS`; assert each has a table entry AND a round-trip fixture in the suite's case map. Fail loudly on any unclassified/untested op. (This is the test that would have caught the clear-reminder bug.)
   - **Per-op round-trip**: for each `reversible`/`reversible-with-loss` op — seed a fixture, run the forward mutation through the real pipeline (mocked WriteDeps executor), run `runUndo`, assert the touched fields returned to pre-values (and, for `-with-loss`, assert the documented loss). Reuse `test/fixtures/` builders + the engine harness in `test/engine/write-*.test.ts`.
   - **Precondition (anti-clobber)**: for each reversible op, after the forward mutation mutate the targeted field OUT OF BAND in the fixture, then `runUndo`; assert it REFUSES (blocked/precondition) and the out-of-band value survives. Proves the guard from the bounce-clear change generalizes.
   - **Irreversible**: assert `planUndo` returns `kind:"irreversible"` with the expected reason substring.
   - **Conditional**: both branches (e.g. `todo.move` with vs without a captured prior container; `clear-dated-reminder` on a still-dated vs now-repeating item).
3. **Cross-check test**: assert every key in `undo.ts`'s `IRREVERSIBLE` map is classified `irreversible` in the table, and vice-versa — the two can't drift.

## Sequencing

Land AFTER the bounce-clear/undo-precondition change (that change establishes the precondition-guard mechanics and flips clear-dated-reminder to reversible; the matrix then locks the whole surface). One branch, `mg/reversibility-matrix`, PR without merge.

## Open questions (resolve during implementation)

- Whether the table should live next to `operations.ts` or `undo.ts` (undo owns the semantics; operations owns the enum — lean undo-adjacent, importing the enum).
- How to round-trip ops that need a discovered uuid (creates) under mocked executors — the engine harness already fakes uuid discovery for `todo.add`; reuse that seam.
- Whether `reorder` needs two entries (native vs bounce) or one `conditional` with both branches tested — lean one entry, two branch tests.
- Surfacing the matrix in `things capabilities` / a generated docs table — deferred; shape the data for it but don't wire it here.
