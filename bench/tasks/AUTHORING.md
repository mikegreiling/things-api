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

## Standalone (container-less) to-dos — reasoning-standalone (2026-07-17, round-1 prep)

New dev task `reasoning-standalone.json` (family `domain-reasoning`, tier 2) probes whether an agent understands that a to-do can live in **no** project/area and still be actionable. Seeds one standalone active to-do (`Sharpen the mower blade`, no `container`) plus a distractor project-contained to-do (`Caulk the tub surround` in project `Bathroom reno` in area `Homestead`) with distinct titles; the prompt asks which project/area the standalone item is filed under. Required answer `{container, view, actionable}` must say `container:"none"`, `view:"anytime"`, `actionable:true` (read-only — carries `db-unchanged`).

Encoding facts verified against the CLI read path (`things show`/`things search`/`things anytime` with the sim fence), authored 2026-07-17:

- **A standalone to-do has no container columns set:** `TMTask.area`, `TMTask.project`, and `TMTask.heading` are all NULL. The "no container" SQL assertion is `project IS NULL AND area IS NULL AND heading IS NULL` (plus `start=1` for anytime-actionable, `startDate IS NULL` for undated).
- **`things show <uuid> --json`** returns a `detail` object that simply **omits** the `project` and `area` keys for a standalone item; a project-contained item's detail carries both `project:{uuid,title}` and (inherited) `area:{uuid,title}`. Their presence/absence is the golden signal the agent reads — that's the task's `pseudoScript` golden path (`things show "$(things search … | jq -r '.data[0].uuid')" --json`).
- **`things anytime --json`** groups the standalone item under the `area:null` group (project-filed items sit under their area's group), and `things today` is empty for it — so `view:"anytime"`, not `today`. A `start=active` (start=1) to-do with no `startDate` is "Anytime" (actionable now), distinct from `start=someday` (start=2, deferred). `todaySection:"today"` appears in the detail JSON but is an internal label — it does NOT place an undated anytime item in the Today view.

## World-profile reconciliation (2026-07-17)

The evergreen world (`bench/world.ts`) layers a lived-in library under every task's seeds. Reconciliations: **reads-inbox-count** was redesigned — its global "count the Inbox" assertion cannot coexist with a rotating world (the true count varies by world seed), so it became a scoped inbox lookup ("is there something about calling a plumber?") preserving its tier-1 read/answer-grading smoke purpose. All other tasks passed unchanged on top of the world (their SQL was already title/container-scoped). World-side guarantees the corpus relies on: world rows contribute nothing to Today and carry no non-future startDate/deadline; world titles are fenced against corpus strings (normalized equality + LIKE patterns) by `validateWorld`, which runs on every fixture build.

## Corpus v2 (2026-07-18, round 2 step 1)

12 new tasks (corpus 15 → 27; splits now dev 17 / **validation 6** / holdout 4 — the validation gate rests on 18 runs at reps 3, not 6). Verified facts added:

- New packed-date literal: 2026-07-27 → 132808064 (codec-verified alongside re-verification of 07-20/24/30).
- **Checklist granular verbs** (`things todo checklist <uuid> --check <title>` / `--add <title>`) preserve other items' states — no reset acknowledgment needed (wholesale `--item` replacement is the one that requires `--acknowledge-checklist-reset`). `todo add --checklist-item` (repeatable) builds a checklist at creation.
- **`project complete` requires an explicit `--children` policy** (`require-resolved` | `auto-complete`) whenever used; the bare call errors with the policy named — the recovery-project-children-policy task grades reading that error and choosing the user-sanctioned policy.
- **`things undo` works inside a bench run** (the per-run scratch `THINGS_API_STATE_DIR` holds the audit trail for the run's own writes; global newest-first, non-interactive).
- **`tag add --parent <name>`** nests; parent join asserted via `TMTag c JOIN TMTag p ON c.parent=p.uuid`.
- **World collision fence in practice**: seeding an area literally named "Household" collides with the world's fixed area pool (`validateWorld` throws at fixture build) — corpus areas were renamed ("Home base"). When authoring, grep `bench/world.ts` for candidate names first.
- **Batch task DROPPED (infeasible)**: `things batch` reads JSONL from a real file or stdin, but the sandbox's `things` command neither materializes VFS files for the child nor forwards stdin (`bench/sandbox.ts` `runThings` passes args only). A batch task needs a sandbox stdin/tempfile bridge first — noted for the coverage backlog.

Task inventory (id · family · split): validation-reads-deadlines · reads · validation — open-only deadline listing + soonest-date reasoning inside one project; validation-writes-set-deadline · writes · validation — deadline set via todo.update; validation-compound-trip-checklist · compound · validation — area-filed scheduled todo with 3 checklist items in one create; validation-reasoning-heading-inheritance · domain-reasoning · validation — inheritance THROUGH a heading (area+project+own = 3) + headings-carry-no-tags; longtail-checklist-edit · writes · dev — granular check + append, others preserved; longtail-cancel-not-complete · writes · dev — canceled (status=2) NOT completed, + logbook answer; longtail-trash-restore · recovery-safety · dev — restore from trash; longtail-tag-nesting · writes · dev — nested tag create + apply; recovery-project-children-policy · recovery-safety · dev — bare complete errors → `--children auto-complete`; longtail-undo-rename · recovery-safety · dev — rename then undo restores exact prior title; gui-evening-tonight · gui-perception · dev — `--when evening` → startBucket=1 + "evening" section answer; gui-upcoming-locate-holdout · gui-perception · holdout — future-dated add + "upcoming" view answer.

## Recurrence family (v3 corpus, RSIM-grounded)

- **Rule-blob assertions**: `rt1_recurrenceRule` is the XML plist composed by `src/write/recurrence-rule-blob.ts` (`ruleXml`); assert decoded-shape essentials with `CAST(rt1_recurrenceRule AS TEXT) LIKE '%<key>K</key><integer>V</integer>%'` fragments — the serializer renders each key contiguously, so these are stable. Key vocab: `fu` 16 daily · 256 weekly · 8 monthly · 4 yearly; `fa` interval; `tp` 0 fixed · 1 after-completion; offsets `wd` 0=Sun…6=Sat (monday=1, thursday=4, friday=5), `dy` 0-based day (-1 last), `mo` 0-based month, `wdo` 1..5 (-1 last).
- **Identity assertions** (RSIM doctrine): FIXED make-repeating is identity-REPLACING — assert the plain source row is GONE (`rule IS NULL AND rt1_repeatingTemplate IS NULL` count 0) plus template (start=2) + exactly one linked instance. AFTER-COMPLETION and reschedule PRESERVE identity — pin the seed `uuid` and assert that uuid survived (as instance / as retargeted template).
- **Multi-weekday CLI verdict**: `--weekdays thursday,friday` expresses a multi-day weekly rule in ONE template (offsets `wd:4` + `wd:5`). `recurrence-multi-weekday` grades exactly one template carrying both — decomposition into two todos is the failure mode, testing capability discovery.
- **The GUI gate under the fence**: the recurrence verbs require `--dangerously-drive-gui` even under the simulator (the H-UI-DRIVE refusal names the flag — a legitimate recovery hurdle); the `ui-enabled` config key is NOT required under the fence.
- **Seed extensions**: task-like seeds accept a pinned `uuid`; todo seeds accept `repeat` (raw RuleSpec sans anchor — seeds a TEMPLATE: start forced someday, blob via the shared serializer, fixed anchor for determinism) and `instanceOf: <todo-key>` (seeds a live INSTANCE linked to that template).
- **jq gotcha**: `things show <ref> --json` nests the record under `.data.detail` (not `.data`) — `.data.detail.repeating.templateUuid` is the template-discovery path from a visible instance.
