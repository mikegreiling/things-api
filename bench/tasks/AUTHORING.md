# Corpus authoring notes (v1)

Facts verified against source at authoring time (2026-07-17), plus schema assumptions to reconcile when the scaffolding worktree merges.

## Verified encodings (sources: `src/model/dates.ts`, `test/fixtures/seed.ts`)

- **Packed dates** (`TMTask.startDate` / `deadline`): `y<<16 | m<<12 | d<<7` (`encodePackedDate`, checked against the documented live sample 132803712 → 2026-06-25). Literals used in v1 (all clocks pinned to `2026-07-20T09:00:00-05:00`, `America/Chicago` — a Monday): 2026-07-15 → 132806528 · 07-20 (today) → 132807168 · 07-21 (tomorrow) → 132807296 · 07-22 (Wed) → 132807424 · 07-24 (Fri) → 132807680 · 07-30 → 132808448.
- **Status** (`TMTask.status`, `TMChecklistItem.status`): open 0, canceled 2, completed 3. **Start** (`TMTask.start`): inbox 0, active 1, someday 2. **Evening**: `startBucket=1` (with `start=1` + `startDate=today`). **Type**: to-do 0, project 1, heading 2. **Trashed**: int 0/1.
- **Reminder time** (`TMTask.reminderTime`): `(h*64+m)<<20` — no v1 task asserts one.
- **Tags**: join tables `TMTaskTag(tasks,tags)`, `TMAreaTag(areas,tags)`; `TMTag(uuid,title,parent,"index")`. Areas: `TMArea(uuid,title,visible,"index")`.

## Assertion pattern

Seed UUIDs are generated per run, so SQL assertions never use UUID literals — they join through titles (`TMTask t JOIN TMArea a ON t.area=a.uuid WHERE a.title='…'`, `t JOIN TMTask p ON t.project=p.uuid`, `t JOIN TMTask h ON t.heading=h.uuid`). Negative membership via `NOT EXISTS` on the tag join. List-answer tasks close the over-listing loophole by pairing `answer-includes` with an exact `count` field in the required answer shape (no set-equality matcher exists yet — worth adding later).

## Schema reconciliation (settled 2026-07-17, pseudoScript pass)

The three assumptions below were authored against the scaffolding brief but did NOT match the merged runtime (`bench/fixture.ts`, `bench/grade.ts`). All three were reconciled to the runtime — the corpus now matches what actually seeds and grades. See "v1 corpus corrections" for the reconciliation log.

- `finalAnswer {required, shape}`, assertion types `sql`, `db-unchanged`, `answer` (dotted `path`, `equals`), `answer-includes` (`path`, `values`).
- **`sql.expect` is an array of ROW OBJECTS keyed by column name** — `grade.ts` runs `db.prepare(query).all()`, which yields `{col: value}` objects, never positional arrays. Every count assertion aliases its aggregate (`SELECT COUNT(*) AS n …`) and expects `[{ "n": N }]`. (Original brief said "array of column values" / `[[N]]` — that shape can never match and was corrected corpus-wide.)
- `clock.now` is a full ISO-8601 instant with offset (CDT = -05:00) passed to `THINGS_NOW` verbatim; `clock.tz` → `THINGS_TZ`.
- SeedSpec: `{kind, key, title, ...}`. **Container references use the `container` field** naming another seed entry's key (`fixture.ts` reads `s.container` only — a `kind`-appropriate `area`/`project`/`heading` field is silently ignored). `tags: [tag titles]` on todos/projects/areas; `kind:"tag"` entries must be seeded before use. Fields mirror `SeedTaskOpts` (`status`, `start`, `startDate`, `evening`, `deadline`, `notes`, `index`).
- Every corpus task now carries a `pseudoScript` (the golden-path `things …` sequence). The two scaffolding sample tasks were the seed of the zero-cost smoke path; the rest were added in the pseudoScript pass and verified green via `--pseudo --split all`.

## v1 corpus corrections (pseudoScript pass, 2026-07-17)

Adding a `pseudoScript` to every task surfaced three genuine corpus bugs (the scripts execute the real CLI against the seeded fixture, so any mismatch between authored assumptions and runtime shows up as a grade failure). Fixed the TASKS, not the ops — no assertion was weakened:

1. **Seed container field ignored.** Seeds used `"area"/"project"/"heading"` keys for container refs, but `fixture.ts` reads only `container`, so those todos/projects seeded with NO container. Broke `recovery-ambiguous-call` and `compound-tag-sweep-holdout` (assertions join through the project) and left several decorative seeds mis-filed. Renamed all such keys to `container` across the corpus.
2. **`sql.expect` row shape.** All bare-`COUNT(*)` assertions used `expect: [[N]]`; the grader returns column-keyed objects. Aliased each aggregate `AS n` and switched to `expect: [{ "n": N }]` (the shape the two sample tasks already used).
3. **`writes-move-to-area` asserted `start=1`.** Initially reconciled to `start=0` because the `todo.move` simulator branches did not promote an inbox item on filing — but that was a simulator-faithfulness gap, not an authoring slip, and it was CLOSED the same day: the area/project/heading move branches now promote `start` 0→1 (someday and active starts preserved), matching the app, and the assertion is back to `start=1` with a regression test in `test/engine/write-simulator.test.ts`.

## Design deviations & open questions

- **writes-move-to-area** asserts `start=1` after an inbox→area move (inbox promotion — see "v1 corpus corrections" #3 for the history: the op briefly lacked the promotion and the assertion was temporarily reconciled before the op was fixed).
- **compound-garden-shed** asserts heading children via `t.heading` joins only — deliberately no assumption about whether a heading child also carries `t.project`.
- **recovery-missing-area** grades recovery (report not-found, change nothing), not refusal etiquette; true refusal-semantics tasks are deferred (defining "correct refusal" needs Mike's input).
- **Long-tail families** (recurrence, reorders, undo) are deferred until simulator coverage lands — see bench/ROADMAP.md known-limits.
- `LIKE` is ASCII-case-insensitive in SQLite — title matches on `%potting soil%`/`%214%` tolerate case variance; exact-title assertions are case-sensitive on purpose (seeded titles are unambiguous).

## World-profile reconciliation (2026-07-17)

The evergreen world (`bench/world.ts`) layers a lived-in library under every task's seeds. Reconciliations: **reads-inbox-count** was redesigned — its global "count the Inbox" assertion cannot coexist with a rotating world (the true count varies by world seed), so it became a scoped inbox lookup ("is there something about calling a plumber?") preserving its tier-1 read/answer-grading smoke purpose. All other tasks passed unchanged on top of the world (their SQL was already title/container-scoped). World-side guarantees the corpus relies on: world rows contribute nothing to Today and carry no non-future startDate/deadline; world titles are fenced against corpus strings (normalized equality + LIKE patterns) by `validateWorld`, which runs on every fixture build.
