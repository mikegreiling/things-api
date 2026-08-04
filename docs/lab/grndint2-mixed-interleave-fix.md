# GRNDINT-2 — the mixed-KIND + template interleave gate fix + the H-REORDER-SCOPE surfacing fix (PR 3 certification)

**Probed under:** golden `things-lab-golden-v2` · Things **3.22.12** (build 32212016) · macOS Sequoia · DB schema v26 · guest clock pinned **2026-07-05 12:00**. Two clean o-suite passes on fresh golden-v2 clones (headless, airgapped, NAT) + the guest write-layer e2e-write-smoke through the SHIPPED CLI. This is the **successor** to [grndint-grand-interleave.md](grndint-grand-interleave.md) (PR 2, immutable evidence): PR 2 CAPTURED the two warts as §BUG + §Secondary and deliberately left them unpatched per its brief; PR 3 fixes both and re-certifies. The PR-2 doc's §5/§BUG statements ("NOT patched here", "Fix location for a follow-up PR") remain accurate history — this doc closes the loop.

## What PR 2 left open (both now fixed)

1. **The mixed-KIND + template gate bug** (PR-2 §5/§BUG). `globalAxisIntermix` ([src/write/move.ts](../../src/write/move.ts), `runInPlaceReorder`) gated the mixed-kind day relaxation on `scheduleBucket`/`forecastDeadlineDay` per row and was NOT taught templates in #393. A repeating-template row (startDate NULL, no deadline) satisfied neither branch → failed the `.every()` predicate → `globalAxisIntermix=false` → with a wrong-kind movee present (a project on `todo reorder`), the upstream `indexKindRefusal` fired ("one kind at a time") BEFORE the #393 day-axis resolver ran. So Mike's headline "both kinds + template, ONE op" interleave was unreachable via the CLI.
2. **The H-REORDER-SCOPE surfacing wart** (PR-2 §Secondary). The ratified template refusals (project-template suffix non-conformant, experimental-off) surfaced NESTED under a generic top-level `verify-failed` / "the reorder leg did not complete (blocked)" with a non-canonical exit code (3), because a `blocked` reorder placement from a pure in-place reposition was wrapped in `move-leg-failed`. The helpful copy was present but buried, and the exit code was wrong (verify-failed, not the blocked-hazard exit 4).

## The fix

- **Gate:** the `globalAxisIntermix` `.every()` predicate gains a **template-with-strictly-future-projection disjunct** (mirrors `rowDayKey`'s template branch): `r.isTemplate && r.templateProjectionDay !== null && r.templateProjectionDay > packedToday`. A template-bearing mixed-kind set now falls through to the day-axis resolver exactly like a template-free one. The relaxation stays day-axis-scoped — a forced INDEX token (`--in someday`/`anytime`/`inbox`/`<container>`) still refuses a mixed set "one kind at a time" (the `!inForcesIndex` guard is unchanged), so the template disjunct never leaks the relaxation onto an index axis.
- **Surfacing:** a new `MoveRefused.hazard` field; a `repositionFailed(op, placement)` helper hoists a `blocked` placement (from the two pure-reposition sites — `runDayGroupReposition`, `repositionInPlaceCore`) to a canonical top-level `move-refused` (`refusal: "blocked"` → exit 4) carrying the hazard + detail + remediation. The CLI + MCP renderers emit `blocked:<hazard>` (`BLOCKED (<hazard>)` on TTY) when the hazard is present — the SAME surface a direct `things reorder` hazard block gets. A genuine mid-leg failure (`bounce-aborted`, `verify-failed`) still surfaces as `move-leg-failed`. The membership-then-place path (`finishPlacement`) is untouched: there, membership already landed, so a placement block is an honest app-default degrade, not a refusal.

## The new o-suite rows (the full mixed inventory the fix unblocks)

Two DB-diff probes (O31–O37 precedent — the app-mechanics drift detector), the whole 07-06 Upcoming inventory sorted TOGETHER in ONE `day`-scope op, then reversed:

| Row | What | Result |
|---|---|---|
| **O38** (`order.grand-interleave-mixed-fwd`) | 11 movables + the baked to-do template: SCHEDULED to-dos (loose + in-project unheaded + HEADED-under-Alpha + area-direct) + SCHEDULED projects (area-less + `LAB-AREA-B`) + DEADLINE-FORECAST to-dos (loose/`LAB-PROJ-PLAIN`/`LAB-AREA-A`) + FORECAST projects (area-less + `LAB-AREA-B`) + `LAB-REPEAT-DAILY`, reverse-target dispatch to a decisively-non-default interleaved target. Per-class legs: to-do `when=` bounce / project `update-project` when= bounce / to-do deadline-cycle / project `update-project` deadline-cycle / template single-id `list "Upcoming"` front-insert. | Lands the exact target order (12-item `todayIndex` `<` chain). Collateral byte-preserved: heading-FK on the headed to-do, area-FK on the area rows + area'd projects, forecast `index`/`deadline`, scheduled `startDate`, and the template's `index`/`start`/`startDate`/`deadline`/`rt1_recurrenceRule`/`rt1_nextInstanceStartDate`/`userModificationDate` ALL byte-identical (umd-silent). |
| **O39** (`order.grand-interleave-mixed-rev`) | The same inventory (own `GY-*` fixture) re-sorted to the REVERSED interleaved target. | Lands the reversed order — proves the interleave is decisively re-orderable, template repositioned again umd-silent, same collateral byte-asserts. |

## Certification (this change)

- **o-suite:** TWO clean passes on fresh golden-v2 clones — runs **`o-20260804-201734`** + **`o-20260804-202132`**, all **38** probes `ok` (O01–O39 `supported`/`partial`/`unsupported` as locked, tier 0, no crash — O38/O39 `supported`/tier-0), **`lab:compare` identical across all 38 probes**. Teardown verified (no leaked run-VMs). O38/O39 ride `npm run lab:regress` (the full o-suite).
- **e2e-write-smoke:** GREEN — **132 steps, 0 failures** (up from 130). New/changed steps: the mixed-kind grand interleave (`things reorder <to-do> <PROJECT> <to-do-template> --in 2026-07-06`, exit 0 + umd-silent disclosure — was refused "one kind at a time" pre-fix); the project-template suffix REFUSE and the experimental-off refusal now surface the **canonical top-level `blocked:H-REORDER-SCOPE`** (exit 4), asserted directly.
- **Engine locks** (`test/engine/write-move.test.ts`, host, no VM): the full mixed inventory (all leg families) compiles on the day axis; the reversed target re-sorts; a dry-run mixed to-do+project+template set routes `scope=day` (was refused pre-fix); the fix is day-axis-scoped (a forced INDEX token still refuses "one kind at a time"); the §1 crash-path lock holds (the template never receives a dated `when=`/`deadline=` leg — its start/startDate/deadline/rule/projection/umd byte-identical); the experimental-off template block HOISTS to `move-refused` (`refusal: "blocked"`, `hazard: "H-REORDER-SCOPE"`), never `move-leg-failed`.

## Reproduce

```sh
export TART_HOME=/Volumes/Workspace/tart
npm run lab:run -- --suite lab/suites/o-suite.json   # O01-O39 (run twice)
npm run lab:compare -- <runA> <runB>                 # the acceptance gate
bash lab/scripts/e2e-write-smoke.sh                  # the SHIPPED-CLI locks (132/0)
```
