# Corpus authoring notes (v1)

Facts verified against source at authoring time (2026-07-17), plus schema assumptions to reconcile when the scaffolding worktree merges.

## Verified encodings (sources: `src/model/dates.ts`, `test/fixtures/seed.ts`)

- **Packed dates** (`TMTask.startDate` / `deadline`): `y<<16 | m<<12 | d<<7` (`encodePackedDate`, checked against the documented live sample 132803712 → 2026-06-25). Literals used in v1 (all clocks pinned to `2026-07-20T09:00:00-05:00`, `America/Chicago` — a Monday): 2026-07-15 → 132806528 · 07-20 (today) → 132807168 · 07-21 (tomorrow) → 132807296 · 07-22 (Wed) → 132807424 · 07-24 (Fri) → 132807680 · 07-30 → 132808448.
- **Status** (`TMTask.status`, `TMChecklistItem.status`): open 0, canceled 2, completed 3. **Start** (`TMTask.start`): inbox 0, active 1, someday 2. **Evening**: `startBucket=1` (with `start=1` + `startDate=today`). **Type**: to-do 0, project 1, heading 2. **Trashed**: int 0/1.
- **Reminder time** (`TMTask.reminderTime`): `(h*64+m)<<20` — no v1 task asserts one.
- **Tags**: join tables `TMTaskTag(tasks,tags)`, `TMAreaTag(areas,tags)`; `TMTag(uuid,title,parent,"index")`. Areas: `TMArea(uuid,title,visible,"index")`.

## Assertion pattern

Seed UUIDs are generated per run, so SQL assertions never use UUID literals — they join through titles (`TMTask t JOIN TMArea a ON t.area=a.uuid WHERE a.title='…'`, `t JOIN TMTask p ON t.project=p.uuid`, `t JOIN TMTask h ON t.heading=h.uuid`). Negative membership via `NOT EXISTS` on the tag join. List-answer tasks close the over-listing loophole by pairing `answer-includes` with an exact `count` field in the required answer shape (no set-equality matcher exists yet — worth adding later).

## Schema assumptions to reconcile at merge

- Field spellings follow the scaffolding brief: `finalAnswer {required, shape}`, assertion types `sql` (`expect` = array of rows, each an array of column values), `db-unchanged`, `answer` (dotted `path`, `equals`), `answer-includes` (`path`, `values`).
- `clock.now` is a full ISO-8601 instant with offset (CDT = -05:00) intended to be passed to `THINGS_NOW` verbatim; `clock.tz` → `THINGS_TZ`.
- SeedSpec: `{kind, key, title, ...}` with container references by KEY (`area`, `project`, `heading` fields name another seed entry's key, not a title) and `tags: [tag titles]` on todos/projects/areas; `kind:"tag"` entries must be seeded before use. Fields mirror `SeedTaskOpts` (`status`, `start`, `startDate`, `evening`, `deadline`, `notes`, `index`).
- No corpus task carries a `pseudoScript` — the two scaffolding sample tasks own the zero-cost smoke path.

## Design deviations & open questions

- **writes-move-to-area** asserts `start=1` after an inbox→area move (inbox membership IS `start=0`, so a "move" leaving `start=0` didn't happen). If the pipeline's move op encodes this differently, fix the assertion, not the op.
- **compound-garden-shed** asserts heading children via `t.heading` joins only — deliberately no assumption about whether a heading child also carries `t.project`.
- **recovery-missing-area** grades recovery (report not-found, change nothing), not refusal etiquette; true refusal-semantics tasks are deferred (defining "correct refusal" needs Mike's input).
- **Long-tail families** (recurrence, reorders, undo) are deferred until simulator coverage lands — see bench/ROADMAP.md known-limits.
- `LIKE` is ASCII-case-insensitive in SQLite — title matches on `%potting soil%`/`%214%` tolerate case variance; exact-title assertions are case-sensitive on purpose (seeded titles are unambiguous).
