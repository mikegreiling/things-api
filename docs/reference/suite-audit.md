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

## Shortcuts write vector — two new op kinds, recurring coverage PARKED (2026-07-11)

The Shortcuts write vector landed (§A.2): `heading.create` and `todo.clear-dated-reminder` are shipped op kinds (**catalog now 36**), delivered through `things-proxy-create-heading` / `things-proxy-set-detail`. Neither is in the guest e2e: the e2e/`lab:regress` runner has no Shortcuts-vector arm yet (it can't `shortcuts run` a proxy and answer first-run consent), so these two are **the only shipped ops without a recurring live check** — PARKED in probe-backlog §C alongside the s-suite. They ARE covered at the seam level (`test/engine/write-shortcuts.test.ts`: success + verified delta, missing-proxy blocked, first-run-timeout→consent, silent-noop verify-fail; plus compile goldens and guard tests). When the runner grows a Shortcuts arm, wire an e2e step for both (a golden clone with the proxies installed + Always-Allow pre-granted).

## Granular checklist edit — one new op kind, live delivery already covered (2026-07-12)

`todo.edit-checklist-item` shipped (**catalog now 37**): one granular checklist edit (add/remove/check/uncheck/rename/move) orchestrated as a read-current → apply-one → `todo.replace-checklist` rewrite, audited as intent so `things undo` can apply a targeted 3-way-merge inverse. It has NO atomic surface (the CommandSpec throws if dispatched directly) — its DELIVERY is the url-scheme `todo.replace-checklist` primitive, which is ALREADY in the recurring live coverage (the checklist-replace suite probe + guest e2e). The orchestration + intent capture + the current-state-aware undo (granular 3-way merge and the upgraded wholesale precondition) are seam-tested in `test/engine/write-edit-checklist.test.ts` (maintainer scenario, targeted/ambiguity refusals, per-action inverses, wholesale states + refusal) and `test/unit/undo-plan.test.ts`. No new live-coverage gap: nothing to park.

## Suite-level notes

- **s-suite** (Shortcuts) is defined but NOT auto-runnable (proxy runs need the lab runner's Shortcuts-vector support; delete-class probes need a human). Its output-class probes (S01–S03) could ride `lab:regress` once the runner ships guest input files — parked in probe-backlog §C. The two wired Shortcuts ops (`heading.create`, `todo.clear-dated-reminder`) ride the same parked track for recurring live coverage.
- **Probe-id vocabularies differ by layer**: suite JSON `operation` fields are probe-level primitives (`todo.create`, `order.today-partial`); the write API uses catalog kinds (`todo.add`, `reorder`). The [README](README.md) maps the families.
- Read-side regression is carried by the unit corpus (fixture DBs; UI-oracle-derived expectations) — views have no VM suite, by design (SQLite reads don't drift with app behavior, only with schema, which the fingerprint gate owns).
