# SIMFID — simulator-fidelity replay suite

**What it is.** SIMFID certifies [`src/write/vectors/simulator.ts`](../../src/write/vectors/simulator.ts) against the REAL Things app, op by op. For every simulator-covered op it compares two row-level DB deltas — the op replayed on the host through the full write pipeline with the simulator vector, and the same op driven through the guest CLI against the real app — after NORMALIZING away the differences that are not fidelity facts (uuids, wall-clock jitter, list positions), with declared TOLERANCES for the app's probe-proven nondeterminism. A residual difference is a **divergence the suite REPORTS** (a simulator bug OR newly-discovered app behaviour); SIMFID never edits the appliers. This is the automation of exactly the class of bug caught by hand on 2026-07-17 (the inbox-promotion filing semantics).

Spec: [probe-backlog §C](probe-backlog.md) (SIMFID). Laws + tolerances: [rsim-results.md](rsim-results.md). Wired into the drift runbook step 5 (re-certify after every golden rebuild).

## Suite architecture (in brief)

Two deltas per op, one normalizer, one comparator — all host-side and unit-tested ([`test/unit/simfid-normalize.test.ts`](../../test/unit/simfid-normalize.test.ts)).

- **SIM delta (host, real).** [`lab/simfid/replay.ts`](../../lab/simfid/replay.ts) drives each case ([`cases.ts`](../../lab/simfid/cases.ts)) through the SAME end-to-end path `test/engine/write-simulator.test.ts` exercises — guards → plan → execute → verified read-after-write → audit — against a fresh synthetic fixture, and snapshots the DB before/after ([`snapshot.ts`](../../lab/simfid/snapshot.ts)).
- **APP delta (clone, real).** [`lab/scripts/simfid.sh`](../../lab/scripts/simfid.sh) clones the golden, airgaps, pins the clock (2026-07-05, the RSIM clock), and drives each headless case's op through the guest CLI against the real app ([`guest-driver.py`](../../lab/simfid/guest-driver.py) + [`clone-manifest.json`](../../lab/simfid/clone-manifest.json)), collecting title-scoped before/after snapshots. The host ingests them into normalized deltas ([`ingest-clone.ts`](../../lab/simfid/ingest-clone.ts)).
- **Normalize** ([`normalize.ts`](../../lab/simfid/normalize.ts)): uuids → placeholders keyed by (kind, title, **container-aware** discovery order) — a template project and its instance are distinguished by their rule/template columns, children by their resolved container placeholder, so the same logical row lands on the same placeholder on BOTH sides even when titles collide (the make-repeating duplication is exactly this case). Wall-clock epochs (creation/modification/stop) → local-DATE buckets. List indexes → ranks.
- **Compare** ([`compare.ts`](../../lab/simfid/compare.ts)) + **tolerances** ([`tolerances.ts`](../../lab/simfid/tolerances.ts)): field-by-field; every difference is checked against the declared tolerances; verdict = MATCH / TOLERATED(&lt;which&gt;) / DIVERGENT(&lt;detail&gt;).

Run: `npm run lab:simfid` (report-only; `--gate` exits 1 on any DIVERGENT for the drift-runbook re-certification; `--filter <substr>` scopes cases). A fresh clone drive: `bash lab/scripts/simfid.sh`, whose per-case app deltas override the banked-evidence goldens for those cases.

### App-side provenance (honesty about this run)

The strongest app-side truth is a fresh clone drive. This certification run (and the 2026-07-22 RSIM-T/RSIM-U extension) was executed **host-side** — the clone leg remains **blocked on disk**: the tart volume was at **9.76 GB free**, below `simfid.sh`'s own 12 GB preflight floor (the script aborts, exit 3). So the app deltas here come from **banked probe evidence**, tagged per row:

> **Clone-leg scope note (why the two new preserve laws stay evidence-derived even once disk frees up).** [`clone-manifest.json`](../../lab/simfid/clone-manifest.json) is the *headless-drivable* subset — pure single-row CRUD flips and inserts. The whole recurrence/subtree family, including the two source-preserve laws added here, is **tier-3 ui-vector** (`make-repeating` is driven through the GUI and needs the AXVM1 rung-b Accessibility grant), which the headless guest driver deliberately does not attempt. Their app-side ground truth already comes from a **real app capture** — RSIM-T/RSIM-U were driven through the production CLI in an AX-granted `--vnc` clone ([`lab/scripts/research-parked.sh`](../../lab/scripts/research-parked.sh), rsim-results §RSIM-T/§RSIM-U) — it is simply not re-captured through the headless `simfid.sh` path. A future AX-capable clone driver (or hand-authored `app-golden/*.json` transcribed from the RSIM raw shapes, follow-up 4) is what would upgrade these rows to a fresh SIMFID capture.

- **CRUD ops (`suite-evidence`).** The app behaviour is the modeled behaviour, already certified by the a/e/o/u/r/p/s suites (they drove the real app). These rows are regression anchors, not independent re-captures this run; a clone drive upgrades them.
- **recurrence / subtree ops (`rsim-evidence`).** The golden is the modeled delta PLUS the documented app-only extras RSIM/RSIM-P/RSIM-R/RSIM-S observed but the simulator deliberately does not emit — the junk instance `rt1_nextInstanceStartDate=69760` sentinel and the nondeterministic per-child instance→template back-link. Layering these in is what exercises the tolerances against the real app's observed shape.

A hand-authored golden file (`lab/simfid/app-golden/<id>.json`) or a clone drive's `--app-deltas` dir overrides the derivation entirely.

## Declared tolerances

| Tolerance | What it absorbs | Evidence |
|---|---|---|
| `rt1-child-backlink` | On a subtree CHILD row, `rt1_repeatingTemplate` present on one side and absent on the other. The app stamps a per-child instance→template link on a NONDETERMINISTIC subset of children (6/7, 5/7, 6/6 across consecutive spawns of one series; headings never linked); the simulator emits plain children. | RSIM-R C2 / RSIM-S S1d |
| `instance-next-sentinel` | On an INSTANCE row, any `rt1_nextInstanceStartDate` value. The app leaves a junk `69760` sentinel; only the TEMPLATE's next-date drives generation; the simulator leaves it NULL. | RSIM |
| `index-rank` | A residual `index`/`todayIndex` rank difference (the app assigns real list positions, the simulator hardcodes 0). | SIMFID spec |
| `wallclock-bucket` | A residual date-bucket difference on `creationDate`/`userModificationDate`/`stopDate` (the app backdates a minted instance to occurrence midnight; the simulator stamps write-time). | SIMFID spec |

The top-level instance row's OWN `rt1_repeatingTemplate` link is NOT tolerated (asserted) — only subtree children are, because that is where the nondeterminism was proven.

## First certification run (2026-07-22) — per-op verdict table

35 cases across the 21 covered ops: **30 MATCH · 5 TOLERATED · 0 DIVERGENT · 0 replay-error.** Full artifacts (gitignored): `lab/artifacts/simfid-<stamp>/` (per-case `simNorm`/`golden`/`verdict`, `results.md`, `summary.json`).

**Extended 2026-07-22** with the two newly-isolated fixed-conversion source-PRESERVE laws — `todo-make-repeating-deadline-preserve` (§RSIM-T: a source deadline is the sole to-do preserve trigger) and `project-make-repeating-terminal-children-preserve` (§RSIM-U: a plain project with all-terminal children preserves). Both land **MATCH** host-side, exactly like the other source-preserve case (`project-make-repeating-nested-flatten`): a preserve mints only the template and relinks the source as the instance (a CHANGE, no minted top-level instance), so no `instance-next-sentinel` layering applies and golden == modeled. **Both remain evidence-derived, not clone-captured** — see the app-side-provenance note below.

| Case | Op | Family | Verdict | App-side provenance |
|---|---|---|---|---|
| `todo-add-scheduled` | `todo.add` | crud | MATCH | suite-evidence (a-suite) |
| `todo-add-area` | `todo.add` | crud | MATCH | suite-evidence (a/e-suite) |
| `todo-update` | `todo.update` | crud | MATCH | suite-evidence (u/e-suite) |
| `todo-complete` | `todo.complete` | crud | MATCH | suite-evidence (u-suite) |
| `todo-cancel` | `todo.cancel` | crud | MATCH | suite-evidence (u-suite) |
| `todo-reopen` | `todo.reopen` | crud | MATCH | suite-evidence (u-suite) |
| `todo-delete` | `todo.delete` | crud | MATCH | suite-evidence (x-suite) |
| `todo-restore` | `todo.restore` | crud | MATCH | suite-evidence (e-suite E15) |
| `todo-move-project` | `todo.move` | crud | MATCH | suite-evidence (o/e-suite) |
| `todo-move-inbox-promote` | `todo.move` | crud | MATCH | suite-evidence (filing-semantics fix) |
| `todo-move-inbox` | `todo.move` | crud | MATCH | suite-evidence (e-suite) |
| `todo-move-heading` | `todo.move` | crud | MATCH | suite-evidence (o-suite) |
| `todo-set-tags` | `todo.set-tags` | crud | MATCH | suite-evidence (e-suite) |
| `todo-replace-checklist` | `todo.replace-checklist` | crud | MATCH | suite-evidence (p-suite P18) |
| `project-add-area` | `project.add` | crud | MATCH | suite-evidence (a-suite) |
| `project-update` | `project.update` | crud | MATCH | suite-evidence (u-suite) |
| `project-complete-cascade` | `project.complete` | crud | MATCH | suite-evidence (p-suite T08) |
| `area-add` | `area.add` | crud | MATCH | suite-evidence (a-suite) |
| `area-update-tags` | `area.update` | crud | MATCH | suite-evidence (e-suite) |
| `tag-add-root` | `tag.add` | crud | MATCH | suite-evidence (e-suite) |
| `tag-add-nested` | `tag.add` | crud | MATCH | suite-evidence (e-suite) |
| `heading-create` | `heading.create` | crud | MATCH | suite-evidence (s-suite S02 / HX) |
| `todo-make-repeating-fixed` | `todo.make-repeating` | recurrence | **TOLERATED(instance-next-sentinel)** | rsim-evidence (RSIM1) |
| `todo-make-repeating-deadline-preserve` | `todo.make-repeating` | recurrence | MATCH | rsim-evidence (RSIM-T) |
| `todo-make-repeating-after-completion` | `todo.make-repeating` | recurrence | MATCH | rsim-evidence (RSIM2) |
| `todo-complete-after-completion-instance` | `todo.complete` | recurrence | MATCH | rsim-evidence (RSIM4) |
| `todo-reschedule-repeat` | `todo.reschedule-repeat` | recurrence | MATCH | rsim-evidence (RSIM5) |
| `project-make-repeating-fixed` | `project.make-repeating` | recurrence | **TOLERATED(instance-next-sentinel)** | rsim-evidence (RSIM6) |
| `project-reschedule-repeat` | `project.reschedule-repeat` | recurrence | MATCH | rsim-evidence (RSIM5 / UIC6) |
| `project-make-repeating-children` | `project.make-repeating` | subtree | **TOLERATED(instance-next-sentinel, rt1-child-backlink)** | rsim-evidence (RSIM-P P1) |
| `project-make-repeating-after-completion-children` | `project.make-repeating` | subtree | **TOLERATED(instance-next-sentinel, rt1-child-backlink)** | rsim-evidence (RSIM-R / was P4) |
| `project-make-repeating-nested-flatten` | `project.make-repeating` | subtree | MATCH | rsim-evidence (RSIM-R flatten / RSIM-P2 A1) |
| `project-make-repeating-terminal-children-preserve` | `project.make-repeating` | subtree | MATCH | rsim-evidence (RSIM-U) |
| `project-make-repeating-trashed-child` | `project.make-repeating` | subtree | **TOLERATED(instance-next-sentinel, rt1-child-backlink)** | rsim-evidence (RSIM-S S-R1) |
| `project-complete-instance-heading-cascade` | `project.complete` | subtree | MATCH | rsim-evidence (RSIM-P P2) |

## Reading the verdicts (divergence analysis)

- **No DIVERGENT** in the covered catalog. The simulator's PR #232 appliers, as corrected by RSIM-R/RSIM-S and completed by RSIM-T/RSIM-U, reproduce every documented app row shape — including the fully reconciled source-fate law: delete-by-default, but PRESERVE-and-relink the source when a fixed **to-do carries a deadline** (`todo-make-repeating-deadline-preserve` MATCHes, §RSIM-T) or a fixed **project's subtree holds a nested repeater OR has no open child** (`project-make-repeating-nested-flatten` + `project-make-repeating-terminal-children-preserve` MATCH, §RSIM-R C1 + §RSIM-U) — plus the after-completion project delete + plain-children shape and the RSIM-S S-R1 trashed-child hard-delete. This is the expected result: the appliers were WRITTEN from this evidence, and SIMFID confirms they stayed faithful.
- **The 5 TOLERATED verdicts** are the two headline app nondeterminisms, and their presence is the point: they prove the tolerances FIRE (present-or-absent both pass) rather than mis-reporting a bug. `instance-next-sentinel` fires wherever a top-level instance is minted (fixed to-do/project + subtree cases); `rt1-child-backlink` additionally fires on the subtree cases (one instance-side child modelled as stamped, per RSIM-S's nondeterministic draw).
- **What this run does NOT prove.** Because the app deltas are banked-evidence-derived (not a fresh independent capture this run), an UNDOCUMENTED simulator divergence would not surface here — golden == modeled for the un-extended fields. That detection power is realized by `lab/scripts/simfid.sh` on a fresh clone. This run certifies: (a) the sim reproduces the documented app shapes, (b) the tolerances behave, (c) the harness runs end-to-end. The unit tests independently prove DIVERGENT detection on synthetic deltas.

## Follow-up worklist (implied by the run + the tolerances)

1. **Run the clone leg** (`bash lab/scripts/simfid.sh`) once tart-volume headroom (≥ 12 GB) and a free VM slot are available (still blocked 2026-07-22: 9.76 GB free). Upgrades the headless-manifest CRUD cases from `suite-evidence` to a fresh `clone-drive` capture and would surface any undocumented CRUD divergence. Then expand `clone-manifest.json` beyond the pre-state-immune starter set (the CRUD cases with subtler pre-states: inbox-promotion start values, tag/checklist joins), confirming CLI seeding case-by-case. (The recurrence/subtree family — incl. the two preserve laws — stays out of the headless manifest; it needs an AX-capable driver, see the clone-leg scope note above.)
2. **To-do & project fixed source-PRESERVE laws — LANDED (2026-07-22, §RSIM-T + §RSIM-U).** The parked to-do trigger is now ISOLATED (a source **deadline**, cleanly 1/1 vs 4/4; notes/tag/checklist excluded) and MODELLED, and the project law gained its **second** trigger (all-terminal children, no open child). `applyMakeRepeatingFixed` now preserves-source on both; cases `todo-make-repeating-deadline-preserve` + `project-make-repeating-terminal-children-preserve` added (both MATCH). No new tolerance was needed — a preserve is a source CHANGE, not a minted top-level instance, so it carries no `instance-next-sentinel`.
3. **Next-occurrence spawn (RSIM-S).** The spawn applier is fully specified (RSIM-S) but is NOT a covered write op (no `simulator.ts` applier; the bench does not materialize occurrences across time). If/when the bench simulates a series across a clock advance, add a spawn case — and note the per-child link tolerance already covers its nondeterminism.
4. **Recurrence app-golden hand-authoring.** Replace the layered-extras derivation for the recurrence/subtree cases with hand-authored `lab/simfid/app-golden/*.json` transcribed uuid-by-uuid from the RSIM raw shapes (the raw snapshots have since been GC'd from `lab/artifacts/`, so this transcription is from the results-doc row tables) — a stronger, non-derived independent reference than the current sim+extras layering.
