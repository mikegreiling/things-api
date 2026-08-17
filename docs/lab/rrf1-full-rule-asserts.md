# RRF1 — full-fidelity recurrence-rule assertions (issue #491)

**Context stamp:** `things-lab-golden-v3` · Things 3.22.14 (build 32214000) · DB v26 · macOS 15.7.7 · pinned clock 2026-07-05. Immutable snapshot (harness version-stamping policy). The recurrence codec this fix compares against is the same `decodeRecurrenceRule` / `composeRepeatRuleSpec` model validated on the 91-rule live corpus + RSIM probes (golden-v1→v3, `rrv=4` unchanged). Landed evidence = CI (unit + engine); the live-app drive cells are the queued VM residual (see §Live certification, PENDING).

## The report (#491)

`todo|project reschedule-repeat`'s `expectedDelta` asserted only the decoded rule's **unit + interval** (the RSIM5-era shallow subset). Two consequences:

1. **False idempotent no-op.** The pre-drive idempotency check (`pipeline.ts` step 5a½, `evaluateDelta(delta, preReader, preCapture).satisfied`) declares "already in the requested state" whenever unit+interval match — even when the monthly anchor, weekday set, start-days-earlier (`ts`), ends bound, or requested first occurrence differ. Live-repro shape on the maintainer's host (synthetic equivalent): a template rule `{monthly/1, of:[{dy:-1}] (last day), ts=-14, deadlined}`, request `--frequency monthly --interval 1 --on-weekday tuesday --on-ordinal 4 --when <future Tue> --deadline --start-days-earlier 21` → `ok` + "idempotent no-op" warning, exit 0, **no drive**.
2. **Blind post-verify.** The post-drive verify used the same shallow asserts, so a drive that landed a wrong anchor would silently pass.

## The fix

Full-fidelity expected-rule assertions built from the COMPLETE requested vocabulary, compared against the DECODED rule (`decodeRecurrenceRule` shapes) + the template `deadline` column — never a blob/string compare (`src/write/repeat-asserts.ts` `expectedRuleAssertions`).

| Requested field | Assertion (decoded) | Notes |
| --- | --- | --- |
| `frequency` | `repeating.rule.unit` | always |
| `interval` | `repeating.rule.interval` | always |
| `afterCompletion` | `repeating.rule.type` (fixed / after-completion) | always (absent ⇒ fixed) |
| `weekdays` / `monthly` / `yearly` | `repeating.rule.anchorKey` | order-insensitive canonical key over the decoded offsets |
| `ends` | `repeating.rule.endDate` + `.occurrenceCount` | RRX1: after→count/no ed, on-date→ed/no count, never→both null |
| `startDaysEarlier` | `repeating.rule.startOffsetDays` (= −N) | |
| `deadline` (or startDaysEarlier>0) | `repeating.deadlined` | template deadline column |
| `next` (`--when`) | `repeating.nextOccurrence` (cursor) | reschedule only (ANCH2); make/add cursors follow the ANCH1 spawn law |
| `reminder` | — SKIP — | not stored in the rule blob; set on spawned instances (RRX1) |

**Requested-fields-only law:** a field the caller did not set contributes no assertion, so a bare `{frequency, interval}` reschedule never trips on an untouched anchor/ends/deadline; the idempotency precheck skips the drive iff EVERY requested field already holds. The same builder deepens `make-repeating`/`add-repeating`'s post-drive verify (previously `repeating.isTemplate` only) — a template minted with a dropped anchor/ends/deadline is a `verify-failed:mismatch` naming the successor uuid for cleanup.

**Structural hardening (maintainer-ratified).** The builder is an EXHAUSTIVE `Record<keyof Omit<RepeatRuleParams,"uuid">, FieldAssertSpec>` — every field is an assert-producer or an explicit skip with a written reason — so a newly added rule param breaks compilation until consciously handled. The CLI flag→param mapper (`repeat-flags.ts`) is the same shape, which also closes **UIC6-l** (a wrong-frequency anchor flag is now refused, not silently dropped).

## Landed certification (CI — the assert-set behavior)

These certify the assert set itself against the composer/decoder model, exercising the exact production `evaluateDelta` / precheck.

- **Discrimination + coherence + requested-fields-only property test** — `test/unit/repeat-asserts.test.ts`. Seeds a real template row per bag (composed rule blob + deadline column + cursor), reads it back through the production decode (`byUuid`), and evaluates the production `evaluateDelta`:
  - COHERENCE: asserts(bag) SATISFIED against bag's own state (every base + single-field mutant).
  - DISCRIMINATION: for a base and each single-field-value mutant (same footprint), asserts(base) UNSATISFIED against state(mutant) and vice-versa — the property #491 lacked. Plus minimal-footprint axes (unit, fixed-vs-after-completion type, deadline flag) and a 24-bag deterministic fuzz over canonical weekly bags (distinct bags never satisfy each other's state; identical ones do).
  - REQUESTED-FIELDS-ONLY: a bare `{frequency, interval}` bag is satisfied by a richly-configured state, but a different interval still fails; a reminder-only difference does not change the assert set.
- **Precheck drive-vs-no-drive cells** — `test/engine/write-ui-vector.test.ts` (`#491` block), full pipeline + scripted ui vector:
  - a monthly anchor/offset/cursor-only reschedule (the maintainer's synthetic shape, `PREV`→`NEW`) DRIVES (`scripted.ran() === true`) — no false no-op — and the row shows the requested cursor + deadline;
  - a genuine same-command re-run is a zero-drive idempotent no-op ("already in the requested state", no undoToken).
- **Mapper completeness + UIC6-l refusal** — `test/cli/repeat-flags.test.ts`: every rule param is flag-reachable, every declared flag maps to a param (no silent drop), and a wrong-frequency anchor flag throws.

## Live certification (VM — PENDING, rides the next AX-vector run)

CI covers the assert set against the model; a live golden-v3 clone is still owed to confirm the REAL app stores what the model predicts for the deepened POST-drive verify (the divergence-risk the deeper asserts introduce). Cells, synthetic `RRF1-*` fixtures, read-only guest SQLite as ground truth:

- **(a)** monthly last-day deadlined `ts=-14` template → `reschedule-repeat --frequency monthly --interval 1 --on-weekday tuesday --on-ordinal 4 --when <future Tue> --deadline --start-days-earlier 21`: the drive DRIVES (no false no-op); DB oracle `of=[{wd:2,wdo:4}]`, `ts=-21`, `deadline` sentinel set, `rt1_nextInstanceStartDate` = the requested date.
- **(b)** re-run the SAME command → `ok` no-op warning, ZERO drive (no dialog opens).
- **(c)** breadth: one weekly weekday-set change and one ends-bound change (`--ends-after`→`--ends-on`) land the decoded `of` / `ed` / `rc` the asserts predict.

Any real-app divergence on a cell is a genuine finding to reconcile in the anchorKey/decoder model (not a reason to weaken the assert). Driver TBD: `lab/scripts/research-rrf1.sh` on the UIC/ANCH2 recipe pattern. Queued in [up-next.md](../up-next.md) (VM-batchable).
