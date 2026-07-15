# Suite-completeness audit — op catalog × recurring coverage

Part of the hardening pass (roadmap §G → §F): when a new Things version drops, `lab:regress` + the guest e2e are the behavioral safety net — so every shipped operation kind must appear in at least one recurring, autonomously-runnable check. Audited 2026-07-09 against `src/write/operations.ts` (34 op kinds), `lab/suites/*.json` (8 suites), and `lab/guest/e2e-write-smoke.sh`.

## Covered (27/34 op kinds in the guest e2e, most also suite-backed)

`todo.add` `todo.update` `todo.complete` `todo.reopen` `todo.move` `todo.set-tags` `todo.replace-checklist` `todo.delete` `todo.duplicate` `todo.restore` `project.add` `project.update` `project.complete` `project.cancel` `project.reopen` `project.move` `project.delete` `project.duplicate` `project.restore` `area.add` `area.update` `area.delete` `tag.add` `tag.update` `tag.delete` `trash.empty` `reorder` (all eight scopes since the §C additions)

The e2e also exercises the non-op verbs: doctor, batch, changes, undo, config.

## Former gaps — CLOSED 2026-07-09 (all 34/34 op kinds now e2e-covered)

Seven op kinds had no recurring autonomous coverage: `todo.cancel`, `todo.backdate`, `todo.add-logged`, `project.set-tags`, `heading.rename`, `heading.archive`, `heading.unarchive`. All seven got e2e steps in the same change as this audit (heading fixtures were already seeded via the §C json path). Final run: **GREEN, 118 steps, 0 failures** (`things-run-e2e-20260709-181620`).

**The new coverage immediately caught two SHIPPED bugs** — the audit's raison d'être, vindicated on its first run:
1. `todo.add-logged` NEVER worked live: its dates carried fractional seconds, which the app's json date parser rejects — whole command errored (modal), zero rows (oddity **2h**; the lingering modal also broke a later `trash.empty` in the same run). Fixed: second-precision timestamps.
2. `heading.archive`/`unarchive` always reported verify-failure despite succeeding: the result check reads the mapped entity, and `Heading` didn't expose `status`. Fixed: headings now carry `status` (completed = archived) — also a useful public API addition.

Moral, now policy: **an op ships with a recurring live check, not just unit-level compile/verify tests** — unit seams can't see an app-side parser rejection or a mapper gap.

## Shortcuts write vector — two new op kinds, recurring coverage CLOSED (2026-07-12)

The Shortcuts write vector landed (§A.2): `heading.create` and `todo.clear-dated-reminder` are shipped op kinds (**catalog now 36**), delivered through `things-proxy-create-heading` / `things-proxy-set-detail`. **Recurring live coverage now exists**: the lab runner grew a Shortcuts arm (a `shortcut` DSL step — guest input file + `shortcuts run --input-path`/`--output-path`, output captured for `stdoutMatches`; docs/lab/harness.md) and **s-suite is now an autonomous recurring suite in `lab:regress`**. S02 locks `heading.create` (type=2 row with `project=<uuid>`) and S-detail locks `todo.clear-dated-reminder` (`reminderTime`→NULL, `startDate` untouched) — both run headless on the golden's inherited output-class Always-Allow. S01 (find echo) + S03 (heading.rename via edit-title) ride along; the delete-class probes S04/S-delperm are `group:interactive` (auto-skipped — no Always-Allow, human sitting only). Seam tests remain (`test/engine/write-shortcuts.test.ts`: success + verified delta, missing-proxy blocked, first-run-timeout→consent, silent-noop verify-fail). Every shipped op kind now has a recurring live check.

## Granular checklist edit — one new op kind, live delivery already covered (2026-07-12)

`todo.edit-checklist-item` shipped (**catalog now 37**): one granular checklist edit (add/remove/check/uncheck/rename/move) orchestrated as a read-current → apply-one → `todo.replace-checklist` rewrite, audited as intent so `things undo` can apply a targeted 3-way-merge inverse. It has NO atomic surface (the CommandSpec throws if dispatched directly) — its DELIVERY is the url-scheme `todo.replace-checklist` primitive, which is ALREADY in the recurring live coverage (the checklist-replace suite probe + guest e2e). The orchestration + intent capture + the current-state-aware undo (granular 3-way merge and the upgraded wholesale precondition) are seam-tested in `test/engine/write-edit-checklist.test.ts` (maintainer scenario, targeted/ambiguity refusals, per-action inverses, wholesale states + refusal) and `test/unit/undo-plan.test.ts`. No new live-coverage gap: nothing to park.

## Reversibility matrix — per-op undo classification, systematized (2026-07-12)

`test/unit/reversibility-matrix.test.ts` + `src/write/reversibility.ts` add a SYSTEMATIC layer over undo coverage: a total `Record<OperationKind, {class, note, ack?}>` classifying all 37 op kinds (`reversible` / `reversible-with-loss` / `conditional` / `irreversible`), plus a suite that (a) EXHAUSTIVENESS-guards every op kind to a table entry AND a registered case (a new op is a compile error in the table and a runtime failure in the guard until classified + round-tripped), (b) proves each `reversible`/`-with-loss` op with a do/undo round-trip driving the inverse through the real pipeline (fake WriteDeps executor; forward audit modeled as the pipeline captures it — the write-undo/clear-reminder/edit-checklist harness pattern), (c) probes anti-clobber on every inverse that writes a CLOBBER_FIELD, (d) exercises BOTH branches of every conditional op, and (e) cross-checks that undo.ts's `IRREVERSIBLE` keys === the table's `irreversible` rows so the two can't drift. This is unit-level (fixture DBs, mocked vectors) — it complements, not replaces, the recurring live e2e coverage above. The scenario-based `test/unit/undo-plan.test.ts` stays as-is.

## o-suite someday-reorder consistency rows — ADDED 2026-07-14 (UI2 fold-in)

The `reorder --scope someday` verdicts were already s-suite/e2e-locked (PR mg/someday-reorder); the o-suite lacked explicit rows for them. Added **O15** (someday to-dos) and **O16** (someday area-less projects) as recurring consistency locks encoding the validated two-call anchor-stack protocol per the compiler (`src/write/commands.ts` someday branch) and its unit goldens (`write-compile.test.ts` P8b, `write-reorder.test.ts` P8b/P9e):
- **O15 (to-dos, P8b — later-sent higher)**: create 3 loose someday to-dos; the two calls are `list "Someday" with ids "<bottom>"` then the **REVERSED** wire list; asserts final index order == the requested order [O-SD1,O-SD2,O-SD3] and start/startDate/status unchanged (order-only).
- **O16 (area-less projects, P9e — the INVERTED protocol, earlier-sent higher)**: create 3 area-less someday projects; call 1 pushes the desired-bottom to top, call 2 is anchor + **FORWARD** rest; asserts final index order == [O-SP1,O-SP2,O-SP3] and type/area/start unchanged. (Someday projects show in the Someday view only, not the sidebar.)

Both created their own targets (no new seeds). Verified GREEN in a fresh clone: run `o-20260714-065940`, all 15 o-suite probes `ok` (O15/O16 `supported`, tier 0). `reorder` was already listed as covered above; these rows deepen the someday-scope coverage specifically.

## ui-vector ops — coverage model is per-version CERTIFICATION, not lab:regress (noted 2026-07-15)

The GUI-driven op kinds (the repeat family, the converts, and now **`area.reorder-sidebar`** — catalog now 47) are NOT in the autonomous recurring suites: the golden image carries no Accessibility grant (AXVM1 rung-b is applied per campaign via VNC), so `lab:regress` cannot drive them headlessly. Their recurring safety net is the **per-Things-version certification campaign** instead — `lab/scripts/research-uic1.sh` / `research-uic3.sh` / **`research-axdrag2.sh`** re-run the ops through the production CLI in a disposable clone and re-flip `src/write/vectors/ui-certification.ts`, per the [things-update-runbook](../lab/things-update-runbook.md) discipline. Unit-level coverage for `area.reorder-sidebar` is `test/unit/ui-drag.test.ts` (geometry + the full ladder against a scripted sidebar simulator through the injectable runner seam) plus the reversibility-matrix case; the drag driver's own per-hop DB asserts are the in-op live verification. If a future golden bakes the AX grant (AXVM1's optional L3 layer), promoting a rung-1 smoke move into `lab:regress` is the follow-up.

## Suite-level notes

- **s-suite** (Shortcuts) is auto-runnable and part of `lab:regress` (2026-07-12): its output-class probes (S01–S03 + S-detail) run headless via the runner's `shortcut` DSL step on the golden's inherited Always-Allow; the delete-class probes (S04, S-delperm) are `group:interactive` and skipped by the runner (human sitting via `lab/scripts/l5-consent-absorb.sh`). Backs recurring live coverage of `heading.create` + `todo.clear-dated-reminder`.
- **Probe-id vocabularies differ by layer**: suite JSON `operation` fields are probe-level primitives (`todo.create`, `order.today-partial`); the write API uses catalog kinds (`todo.add`, `reorder`). The [README](README.md) maps the families.
- Read-side regression is carried by the unit corpus (fixture DBs; UI-oracle-derived expectations) — views have no VM suite, by design (SQLite reads don't drift with app behavior, only with schema, which the fingerprint gate owns).
