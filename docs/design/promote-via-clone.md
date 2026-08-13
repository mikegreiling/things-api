# Promote-via-clone — repeating items become recoverable and deterministic

**Status:** direction RATIFIED (maintainer, 2026-08-11); the specifics below are the design of record, with two flagged rulings pending (§6). Evidence: the CLONE campaign ([lab/clone-fidelity-and-template-trash.md](../lab/clone-fidelity-and-template-trash.md), golden-v2 / Things 3.22.12) plus the standing recurrence laws ([lab/rsim-results.md](../lab/rsim-results.md) §RSIM-R/T/U).

## 1. Why

The native promote (the GUI Repeat… dialog, our only template-minting surface — E13/AS-302/Shortcuts all disproven) is destructive and nondeterministic from the caller's seat: the source row is usually hard-deleted (identity replacement, oddities §8g), and whether it survives depends on the RSIM source-fate lottery (a to-do preserves iff it carries a deadline; a project iff its subtree holds a nested repeater or has no open child). Reimplementing promote as a compound over a disposable clone fixes both at once:

```
clone(X) → native-promote(the clone) → trash(X)
```

- **Recoverable:** X survives in the trash with its uuid and content intact; restore-from-trash is the undo.
- **Deterministic:** the promote's fate lottery lands on a row *we* minted and were going to discard either way. CLONE verdict B proved all four RSIM fate laws hold byte-for-byte on minted, backdated clone rows — nothing about cloning perturbs the fate axis, and `templateUuid` discovery binds correctly.
- **Unifying:** the same `add → promote` composite closes both catalog gaps — `todo.add-repeating` (§0.2, previously absent entirely) and full write-vocabulary `project.add-repeating` (§0.3) — and powers the rewired promote ops. One primitive, four operations.

A side benefit for the nested-repeater case: native promote FLATTENS a nested repeating to-do inside a promoted project (template hard-deleted, rule dropped — RSIM-P2 A1/A2, irreversibly). Under promote-via-clone the original project, sitting recoverable in the trash, keeps its working nested repeater.

## 2. First-class clone operations

`todo.clone` and `project.clone` ship as standalone catalog ops and CLI commands (maintainer, 2026-08-12: "a proper todo clone and project clone might be useful on their own — let's expose it").

**Semantics.** A faithful content copy via official write surfaces, per the CLONE verdict-A matrix: title, notes, tags, every `when` stage (today / evening / someday / date), reminder time, deadline, checklist item titles, area, headings, headed and root children — plus `--created-at` backdating of the copy's creation date and `--completed-at` reproduction of logged/canceled terminal state. Fields in the CAVEAT set are reproduced by follow-up legs inside the one compound: pre-checked checklist items (post-`--check`), logged children in a mixed project (post-`complete`/`cancel` with `--completed-at`), a trashed copy (post-`delete`).

**Defaults.** The clone keeps the source's title (no " copy" suffix — the caller can pass `--title`); it keeps the source's creation date only when `--preserve-created` is passed (default: a clone is a new capture, created now); it lands at the container's native landing position (no implicit reorder leg — callers place it with the certified `reorder` machinery if they care).

**Refusals (fail-closed).** A project containing a live nested repeating template refuses, naming the child and the reason (`rt1_recurrenceRule` is only mintable via the GUI promote, which creates a new series identity — a faithful copy is impossible). A repeating template as the clone TARGET likewise refuses (same reason). No `--flatten` best-effort in v1 (§6b).

## 3. The rewired promote and the add-repeating composites

- **`todo.make-repeating` / `project.make-repeating`** become: `clone(X, --preserve-created) → native-promote(clone) → trash(X)`, returning the template uuid (unchanged contract) plus the trashed original's uuid in the result and audit record. The old direct-promote behavior is deleted outright (ALPHA-CONTRACT; the native dialog remains the internal mechanism, not a user-facing mode).
- **`todo.add-repeating`** (new) and **`project.add-repeating`** (rewired): `add(full write vocabulary) → native-promote(the fresh row)`. No trash leg — there is no original.
- **Vector and gating:** the promote leg stays ui-vector (`--dangerously-drive-gui`, tier 3) exactly as today; the clone/add/trash legs are pure headless. The compound inherits the promote gating unchanged.
- **Placement:** after promote, the series' current instance occupies a list slot. The compound restores the instance to X's prior slot best-effort via the certified reorder scopes where the containing scope is wired, and discloses when it cannot (same disclosure discipline as heading reorder #V11).

## 4. Undo — scoped honestly

Forward record captures: X's uuid (now trashed), the minted template uuid, the current instance uuid. **Undo v1 restores X from the trash and discloses that the minted series must be deleted manually in the app**, naming both uuids. The other half — automated series removal — is deliberately NOT built: CLONE verdict C showed trashing a project template is lossy and non-restorable (cursor cleared, instance orphaned, AS restore → error 301), and a to-do template trash is guard-blocked. A dedicated, validated series-removal primitive is possible later (parked in up-next as part of the banked evidence item); generic `delete`/`restore` must never be the vehicle.

**Evidence for that later primitive (SERDEL, golden-v2/3.22.12 — [lab/serdel-series-removal.md](../lab/serdel-series-removal.md)):** the app itself has **no delete-confirmation dialog and no dedicated "remove series" command** — the GUI-native removal IS **trash-both** (trash the template → cursor cleared + instance orphaned; then trash the orphaned instance), which the primitive reproduces headlessly as `raw-AS delete(template) + delete(instance)` *behind* the guard (never generic `delete`). It stops generation immediately (cursor NULL) and is byte-coherent. Two disclosure refinements for this section's honesty: (i) trash-both is losslessly reversible **only until the Trash is emptied** — GUI **Put Back in Inbox** restores the template + its cursor (resume), but each row is an independent trash entry so restoring the series needs BOTH put back; and (ii) on empty-trash only the **instance** tombstones (`leavesTombstone=1`), the **template** does not (`leavesTombstone=0`) — so the undo disclosure should name both uuids and note the template leaves no sync-visible trace when hard-deleted. Where "suspend, don't remove" suffices, the already-shipped **`pause-repeat`** (sets `paused=1` + clears the cursor, rule + anchor preserved; **Resume re-anchors to today**, no back-fill) is the lower-blast-radius lever.

Prerequisite already in flight: the `H-REPEAT-SCHEDULE` guard extends to `project.delete` (WG-8 parity fix), so neither kind's template is trashable through the generic delete path.

## 5. Implementation phases

1. **WG-8 guard parity** — `project.delete` refuses templates like `todo.delete` does (separate small PR, already dispatched).
2. **Clone ops** — `todo.clone` / `project.clone` + the fidelity matrix as refusal logic + tests (fidelity matrix rows become the e2e cases).
3. **Composites** — `todo.add-repeating`, full-vocab `project.add-repeating`, rewired `make-repeating` ×2, the scoped undo record + disclosure, skill/help/MCP copy per surface-copy.md, capability-matrix + up-next bookkeeping.

Each phase lands via the usual PR flow with `npm run check` green; phase 3 additionally re-runs the recurrence e2e suite against a lab VM before merge.

## 6. Flagged rulings (maintainer)

- **(a) Undo scope:** accept "restore X + disclosed manual series cleanup" as the shipped undo story (automated series removal parked)?
- **(b) Nested-repeater refusal:** confirm fail-closed refusal with no `--flatten` escape in v1 (per the advisories doctrine — corner cases get honest refusals, not machinery)?
