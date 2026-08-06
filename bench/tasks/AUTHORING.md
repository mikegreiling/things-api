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
- **jq gotcha**: `things show <ref> --json` nests the record under `.data.detail` (not `.data`) — `.data.detail.repeating.templateUuid` is the template-discovery path from a visible instance. **(SUPERSEDED by v2 — see below: `show` detail is now `.data.item`, and the repeating sub-shape exposes `.rule` + `.latestInstance`, not `.templateUuid`.)**

## v2 corpus migration (0.14.0 round, 2026-08-06)

The read-shape doctrine v2 (0.14.0) + the one-vocabulary audit reshaped nearly every read envelope and one write flag; the corpus's `pseudoScript` golden paths (authored against v1 shapes) all went stale. All were migrated to v2; the pseudo smoke is green again (33 legacy + 3 new = 36 tasks, `--pseudo --split all`). What changed, verified empirically against the CLI read path under the sim fence:

- **List views are RECORDS now, not bare arrays.** `inbox` / `search` / `projects` / `areas` / `trash` are `data.items[…]` (were `data[…]`). Every `.data[0].uuid` / `.data[]|select(…)` jq path became `.data.items[…]`. A row is a bare `{uuid, title}` (plus optional `hasNotes`, `tags`, `deadline`, `area`, `project`, `type`, `todos`, `stage`) — **`type` is OMITTED for a to-do**, present for `project`/`heading`/`area`/`tag`.
- **`today`** is `data.children.{today,evening}.items[…]` (was `data.today[…]`), with the due-split on **`meta.counts.{dueOrOverdue, other}`** (deadline ≤ today → `dueOrOverdue`; the two counts span today+evening; world contributes nothing to Today, so counts are deterministic — see `reads-today-counts-holdout`).
- **`upcoming`** is `data.sections = [{when, items} …]`, chronological, with a trailing `{when: null}` **resting block** for undated repeating templates. Day-block key law: `startDate ?? (template ? null : deadline)`.
- **`anytime` / `someday`** are `data.sections = [{area, items, total?} …]`; the section `total` is present **iff** that section was capped (`items.length < total`). Projects appear inline as `{type:"project", todos:{open,total}}` rows followed by their child to-dos (each carrying a `project:"<title>"` back-ref) — dual-citizen single-seating.
- **project-view / area-view recursion.** `project show` is `data.view.{project, children:{anytime,upcoming,someday,logbook}, headings:[{uuid,title,children:{…}}]}` — stage-keyed buckets, a per-container `logbook`, recursive `headings[]`, no advisories. `area show` is `data.view.{area, children:{anytime,upcoming:[{when,items}],someday}, projects:{items,total?}}`. The old `.data.view.active[]` is gone.
- **UNSWEPT-RESOLVED trap.** A completed (or canceled) child that has NOT yet been swept to the Logbook stays IN its stage bucket (e.g. `children.anytime.items`) carrying a `status:"completed"` marker — it does NOT move to `logbook` until swept. So "count the OPEN items" in a bucket must filter `select(.status==null)`. This bit the migration itself (`compound-tag-sweep-holdout` over-tagged the unswept item) and is the deliberate discriminator in `reads-project-heading-recursion`. (An already-SWEPT resolved item — old `stopDate` — does land in `logbook`.)
- **`show` detail** is `data.item` (was `data.detail`); a repeating item's `.item.repeating` carries `{rule, latestInstance}`.
- **Write vocab**: the `move` verb's destination flag is `--to-area` / `--to-project` / `--to-heading` (was `--area`/…); `todo add` KEEPS `--area`/`--project`/`--heading` as ADD-destinations. Headings are created via `things project add-heading <project> <title>` (there is no `things heading` group). `--created-at` / `--completed-at` are accepted on add/update/complete/cancel.

### New v2 tasks (this round)

- `reads-project-heading-recursion` · reads · dev — recursive `headings[].children.anytime.items` read; must exclude the unswept-resolved `status` row (count open under a heading).
- `reads-upcoming-dayblock` · reads · validation — area-view `children.upcoming = [{when, items}]` day-block reading (soonest date, its count, distinct-date count); an anytime distractor must not be counted.
- `reads-today-counts-holdout` · reads · holdout — `meta.counts.{dueOrOverdue, other}` split over today+evening.

Seeding note: **heading membership is seeded via `container: "<heading-key>"`** (the `container` field resolves a heading key to `{heading: uuid}`; a bare `heading:` field on a todo seed is still ignored). Answer-only read tasks synthesize their answer in `--pseudo` (the golden `pseudoScript` runs for side-effects / `db-unchanged` only), so a read task's pseudoScript need only be a valid, read-only golden path.

### Simulator WRITE-coverage gap (blocks the round's write-side scope)

The bench simulator (`src/write/vectors/simulator.ts`, last extended for recurrence in RSIM, 2026-07-18) has **no applier for the universal `reorder` op** (any reorder leg reports "unsupported"), and **does not apply the `--created-at` / `--completed-at` timestamp params** (`todo add --completed-at`/`--created-at` verify-fail; `complete --completed-at` applies the flip but the backdate leg fails to verify, leaving the item mid-sequence). So the 0.14.0 write novelties — **universal reorder across kinds, and backdating flows** — cannot currently be graded in the bench. Per the "corpus stays within simulator coverage" rail and the "unsupported beats guessed" applier doctrine (no speculative appliers without VM-probe-grounded row shapes, like the RSIM arc did for recurrence), these tasks are DEFERRED until timestamp + reorder appliers land in the simulator (parked — see bench/ROADMAP.md). The round's write coverage is limited to the simulator-supported `move --to-area` rename (exercised by the migrated `writes-move-to-area`).
