# Reference compendium — everything probed, in one navigable place

The index over ALL evidence this project has produced (roadmap §F). The two **living rollups** remain the primary lookups — this compendium is the map that gets you to raw evidence fast:

- **[capability-matrix.md](../capability-matrix.md)** — the CRUD × vector wish-list/checklist (what works, where, with evidence ids)
- **[things-app-oddities.md](../things-app-oddities.md)** — every app bug/quirk/hazard, report-ready for Cultured Code (incl. §7, the consolidated crash catalog)

Companions in this directory: **[novel-paths.md](novel-paths.md)** (the surprising capabilities that work) and **[suite-audit.md](suite-audit.md)** (op catalog × recurring-coverage, with the open gaps).

## How evidence ids work

Every claim in the living docs carries a probe id. Families, by prefix:

| Prefix | Campaign | Results doc |
|---|---|---|
| T01–T20 | pre-lab URL-scheme validation (Codex sessions, March 2026) | [research/validation-notes-step3.md](../research/validation-notes-step3.md) (provenance: [research/PROVENANCE.md](../research/PROVENANCE.md)) |
| U01–U20 | URL re-validation of the T-matrix, instrumented | [lab/u-suite-results.md](../lab/u-suite-results.md) |
| A00–A54 | AppleScript campaign (+ private sdef discoveries) | [lab/a-suite-results.md](../lab/a-suite-results.md) |
| X01–X05 | cross-vector identity/interleave | in a-suite-results.md |
| E01–E19 | editing-completeness (renames, notes modes, duplicates, restores) | [lab/e-suite-results.md](../lab/e-suite-results.md) |
| O01–O14 | ordering (private reorder + bounce) | [lab/o-suite-results.md](../lab/o-suite-results.md) |
| P01–P30 | gap-closure Phase 18/19 (cascades, container clears, checklists, tag un-nest) | [lab/p-suite-results.md](../lab/p-suite-results.md) |
| P6–P14 (2026-07-09 series) | aggregate-list ordering, crash sweep, backdating — distinct from P01–P30 | [lab/o-suite-results.md](../lab/o-suite-results.md) §P7–P9/P13, [lab/s-campaign-results.md](../lab/s-campaign-results.md) (scf/scf2), oddities §7 (P14) |
| R01–R21 | reminders (codec + time-parser classes + dated stickiness) | [lab/r-suite-results.md](../lab/r-suite-results.md) |
| S01–S05, S-detail, S-delperm, scf/scf2/scf3 | Shortcuts campaign (proxies, consent model, backdating; scf3 = round-3 reconfirm + Someday convention lock, logInterval enum, deadline-less repeat, repeating-reminder clear, oddity-6½ screenshots) | [lab/s-campaign-results.md](../lab/s-campaign-results.md) |
| P10–P12, HX0–HX4b | heading verb matrix + escape-hatch sweep | [lab/heading-research.md](../lab/heading-research.md) |
| F-DL-* | Today membership/ordering UI-oracle | [lab/today-order-research.md](../lab/today-order-research.md) |
| A1–A6, B0–B4 (21b series) | environment/TCC/uriSchemeEnabled + wish-list piggybacks | [lab/phase21b-research.md](../lab/phase21b-research.md) |
| SX0–SX4 | shortcut extraction/signing distribution pipeline | lab/scripts/research-sx*.sh + [roadmap §A](../roadmap.md) |
| SX5 | find-items filter repair (consent-preserving DB surgery) + malformed-predicate crash family (oddities §7 C4) | [lab/s-campaign-results.md](../lab/s-campaign-results.md) "VM repair campaign results" |
| SX6 | repaired-asset import validation in a fresh clone via VNC synthetic click (first §E½ demonstration) | [lab/s-campaign-results.md](../lab/s-campaign-results.md) "VM repair campaign results" |
| UI1 | §E½ UI-vector feasibility (VNC-drive `File → New Repeating To-Do`) + the deadline-less-repeat discriminator (template `deadline` column) | [lab/s-campaign-results.md](../lab/s-campaign-results.md) "UI-vector campaign (UI1)"; `lab/scripts/research-ui1.sh` |
| UI2-a…h | Hybrid ui-vector: make-repeat / edit-rule / pause / convert-to-project (to-do AND heading) are all VNC-drivable and all IDENTITY REPLACEMENT except edit (preserves) + pause (`rt1_instanceCreationPaused`; no "Stop" command exists); the frontmost/focus-steal disruption profile (dedicated-Mac zero-cost vs own-Mac most-disruptive); folds: closed rows always carry `stopDate` (UI2-g), heading-targeted placement into a completed project auto-reopens it (UI2-h) | [lab/ui-vector-research.md](../lab/ui-vector-research.md); `lab/scripts/research-ui2.sh` |
| LOCK1, SYNC1 | headless "closet Mac" research: locked-session vector verdicts (a–e work under lock, f hits the lock screen; headless-lock mechanism) + last-sync/freshness signal archaeology without a cloud account | [lab/headless-research.md](../lab/headless-research.md); `lab/scripts/research-lock1.sh` |
| SYNC2 | Things Cloud ("Syncrony") conflict-resolution semantics, live-probed (two clones, one throwaway account): per-attribute merge; same-field TEXT conflicts (notes, title) = timestamp-ordered **3-way merge** with `--` separator — NOT last-writer-wins, nothing dropped, both devices converge; checklists merge as union; delete-vs-edit loses nothing; `BSSyncronyMetadata` populates once an account attaches (last-sync-ATTEMPT NSDate at stable key `GryCJ44xPcJG6go5KeTZp1`) | [lab/headless-research.md](../lab/headless-research.md) §SYNC2; `lab/scripts/research-sync2.sh` |
| UPC1-A/B/C/D | Upcoming membership & deadline forecasting (UI-oracle + VNC): future-deadline anytime/someday to-dos AND someday projects forecast into Upcoming under the DEADLINE date (Inbox excluded); when+deadline groups by the WHEN-date (one row); the **blue Someday circle = a PROJECT with an OVERDUE deadline** (not "in Today", not "suppressed" — the equally-suppressed to-do stays gray); `deadlineSuppressionDate` is stamped by rescheduling an overdue item to Someday/Anytime (no dismiss button); the "new to-dos" banner OK **materializes** deadline overlays (start→1, startDate:=deadline) | [lab/upcoming-research.md](../lab/upcoming-research.md); `lab/scripts/research-upc1.sh` |
| PLOG1-a/b/c/d | Completed project + restored (open) trashed child (VNC GUI + DB): the completion **modal ignores trashed children** (project completes silently; a non-trashed open child DOES raise the sheet — control-proven), so restoring the trashed child (GUI **Put Back**) yields a COMPLETED project holding an OPEN to-do; **Put Back does NOT reopen the project** (contra §5b); the Logbook sweep is a **derived time-boundary** (`log completed now` mutates no rows) so the open child rides into the Logbook still `status=0`, absent from Anytime/Today/Inbox (reachable only by drilling into the logged project); restore before vs after the sweep converge; URL project-complete cascade shares the trashed-child blind spot. Report-ready = oddities §6¾ | [lab/plog1-research.md](../lab/plog1-research.md); `lab/scripts/research-plog1.sh` |

Recurring, autonomously-runnable encodings of the locked verdicts live in `lab/suites/*.json` (a/e/o/p/r/s/u/x) and run via `npm run lab:regress`; the guest e2e (`lab/guest/e2e-write-smoke.sh`) exercises the shipped CLI surface end-to-end (106 steps). Coverage gaps: [suite-audit.md](suite-audit.md).

## Campaign map (what to read for what)

| Question | Doc |
|---|---|
| Does op X work on vector Y? | [capability-matrix.md](../capability-matrix.md), then the campaign doc its evidence id names |
| Why is this write guarded/blocked? | [things-app-oddities.md](../things-app-oddities.md) (hazards §1/§2/§6/§7) |
| Anything about headings | [lab/heading-research.md](../lab/heading-research.md) — the consolidated verb matrix |
| Ordering/reorder semantics (any scope) | [lab/o-suite-results.md](../lab/o-suite-results.md) (incl. someday anchor-stack models, Anytime non-determinism) |
| Reminder time parsing/encoding | [lab/r-suite-results.md](../lab/r-suite-results.md) (codec `hour<<26 | minute<<20`; three lexical classes) |
| Today membership & sort | [lab/today-order-research.md](../lab/today-order-research.md) |
| What forecasts into Upcoming? (deadline-driven membership by bucket, both-dates grouping, the someday blue-circle indicator) | [lab/upcoming-research.md](../lab/upcoming-research.md) — UPC1 verdicts |
| Completing a project with a trashed child / Logbook-sweep semantics / open child stranded in a logged project | [lab/plog1-research.md](../lab/plog1-research.md) — PLOG1 verdicts; oddities §6¾ |
| Sync & conflict behavior (Things Cloud / "Syncrony": what merges, is it LWW (no), last-sync signal, locked-screen/headless operation) | [lab/headless-research.md](../lab/headless-research.md) — LOCK1/SYNC1/SYNC2 verdicts |
| Consent/TCC/"Enable Things URLs" | [lab/phase21b-research.md](../lab/phase21b-research.md) |
| Shortcuts vector & proxies | [lab/s-campaign-results.md](../lab/s-campaign-results.md); build cards [lab/l5-build-cards.md](../lab/l5-build-cards.md); signed files `shortcuts/` (extraction pipeline: roadmap §A) |
| Deletes (heterogeneous!) | [lab/a-suite-results.md](../lab/a-suite-results.md) A24–A27, s-campaign P12, oddities 5i |
| DB schema ↔ UI meaning | [atlas/schema-v26.md](../atlas/schema-v26.md) |
| Harness mechanics / how probes run | [lab/harness.md](../lab/harness.md) |
| Golden image / VM lab conventions | [lab/golden-runbook.md](../lab/golden-runbook.md), [lab/drift-runbook.md](../lab/drift-runbook.md), [lab/things-update-runbook.md](../lab/things-update-runbook.md) |
| What's parked/queued | [roadmap.md](../roadmap.md), [lab/probe-backlog.md](../lab/probe-backlog.md) |
| Pre-lab history (March 2026 Codex research) | [research/](../research/README.md) — historical; matrix v1 superseded by capability-matrix |

## Certified environment

Things **3.22.11** · macOS **15.7.7** · DB schema **v26** · golden `things-lab-golden-v1` (clock-pinned 2026-07-05). Recertification for any new Things version: [lab/things-update-runbook.md](../lab/things-update-runbook.md).
