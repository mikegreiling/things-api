# Read-shape doctrine v2 — buckets are reorder scopes

**Status: DRAFT — pending maintainer ratification.** One open probe dependency: **HEADSORT** (heading lifecycle reorder, in flight) decides the single carve-out sentence in §2 R5. The *shape* below is invariant to its outcome; only the scope-completeness prose and the capability-matrix cells depend on it.

This document supersedes [read-shape-doctrine.md](read-shape-doctrine.md) (v1, **REVERTED** 2026-08-04, retained as re-audit input). It extends [api-doctrine.md](api-doctrine.md) and obeys its §1 grammar: every shape fits an existing `data` wrapper (`item` / `items` / `sections` / `view`).

## 0. Lineage — what v1 got right and where it failed

v1's detachment principle stands and is re-affirmed: **the data model serves programmatic/agentic consumers first; the TTY is a separate audience whose GUI-faithful presentation is derived, never encoded.** Its row conventions also stand: self-describing rows, #362 flat refs with round-trip `*Uuid` promotion, presence-keyed fields, documented orderings.

v1's *survival test* failed: "a bucket dies iff its membership and order are recoverable from row attributes" asked a read-side question about what the ordering campaigns proved is **write-side structure**. Sortability is a property of a *group*, not of any row: which (container × stage × kind × day) sets form atomic reorder scopes is exactly the probe-built map, and it is not recoverable from a flat array even in principle. Flattening forced every consumer to re-derive that map from skill prose at read time. v2 replaces the test.

## 1. The doctrine

> **JSON structure mirrors the write surface.** A nested bucket exists iff it is (a) a **reorder scope** — a group whose rows can be handed to `things reorder` and permuted — or (b) an **order-axis grouping** whose order is not carried on its rows (v1 ruling #C2, kept). Bucket keys are the stage vocabulary and double as `--in` tokens; a day block's `when` is its `--in` token. Array order is the current axis order. Non-sortable collections never nest: they are flat lists with documented presentation orders. The TTY projection remains fully derivable from the data and fully detached from it.

Corollary inherited from v1: structure a consumer can cheaply discard (flatten) beats structure a consumer must expensively reconstruct. Every row remains self-describing, so flattening is always one expression away; scope boundaries are not.

## 2. Shape rules

- **R1 — bucket record.** Every bucket is `{ items, total? }`. `total` is present **iff** `items` is capped (`items.length < total`); an untruncated bucket does not restate its own length. Completeness is always answerable locally — no sidecar join.
- **R2 — `children` is the stage vocabulary.** A container's `children` object has fixed keys drawn from the stage words: `anytime`, `upcoming` (a day-block **array**), `someday`, `logbook`. Keys (and day-block `when` values) are exactly the `--in` tokens of `things reorder`.
- **R3 — day blocks are arrays.** `upcoming: [ { when, items, total? } … ]`, chronological. Never dynamic object keys: JSON object key order is not semantically meaningful across serializers, dynamic keys degrade schema/typing, and a bare keyed array leaves no home for `when`-adjacent or truncation metadata.
- **R4 — recursion, no sentinels.** A heading is a sub-container: `{ uuid, title, archived?, children }` with the same `children` shape. The un-headed region is the container's **own** `children` (the project body), not a `null`-heading pseudo-entity. The degenerate (heading-less) project stays flat and obvious.
- **R5 — `headings[]` is the heading axis.** Array order = heading `index` order. ALL headings appear here — open, archived-unswept, archived-swept — one entity, one place, `archived` (ISO datetime, presence-keyed) as the sole lifecycle mark (v1 #C3a kept: never `stage`/`status` on headings). *Scope completeness pending HEADSORT:* if all three lifecycle classes reorder index-only, `headings[]` is a complete reorder scope with no exceptions; if the swept class refuses, the scope is the non-swept prefix classes and the carve-out is stated here in one line.
- **R6 — `logbook` is the one non-sortable stage key.** Per-container (project body and each heading own their `children.logbook`). Completed rows have no user order axis; `--in logbook` refuses. The GUI's unified logbook region — loose logged rows interleaved with swept-archived-heading groups (HEADARC2/HEADARC3 laws) — is **TTY-derived**: coalesce `children.logbook` across the body and all headings, order per the certified laws. Both GUI presentations (muted heading sublabel for live-heading children; group header for swept headings) are renderings of the same structural fact and are not encoded.
- **R7 — dual citizens appear once per view, seated GUI-faithfully.** A someday/anytime row with a deadline (or any row with membership on both axes) is seated in its **canonical stage bucket** in container views (project/area: the someday item is in `someday`, never also in a day block) and at its **projected day** in projection views (global `upcoming`). Template projections seat at their projected day wherever they render — the projection *is* their seat. No uuid appears twice in one view; every bucket is therefore a complete, non-overlapping scope for its view.
- **R8 — metadata lives on the node it describes.** Bucket-local completeness rides the bucket (`total`, R1). View-level aggregates ride `meta` (today's `counts { dueOrOverdue, other }`; v1 #C1 re-lands — the word "badge" stays banned from all consumer surfaces). The `meta.truncation.blocks[]` descriptor-join sidecar retires in favor of inline `total`.
- **R9 — flat list views stay flat.** Single-scope views (`inbox`; the `areas` listing = the area sidebar-rank scope) keep bare `items[]` — the whole list is the scope. Non-sortable views (`logbook`, `trash`, `search`, `changes`; the `projects` listing) keep bare `items[]` — declared non-scopes. Scope-ness per view is declared in the contract's shapes-and-orderings table; the structural `children` machinery is for mixed container/projection views.

## 3. Per-view verdicts

"Unchanged" = the pre-v1 shape (current `main`, post-#398) already satisfies v2.

| view | v2 shape | change vs main |
|---|---|---|
| `today` | `data.children = { today: {items}, evening: {items} }`; counts on `meta.counts` | RESHAPE: `sections[]` → keyed records (`--in today` / `--in evening`); `badge` → `meta.counts` + vocabulary ban (re-land v1 #C1, incl. the ratified TTY header/counts treatment) |
| `inbox` | `data.items` | unchanged (single scope, `--in inbox`) |
| `anytime` (global) | `data.sections = [ { area, items, total? } … ]` | record-ized only. Order-axis grouping (#C2): area sidebar rank; NOT reorder scopes (a projection across containers) |
| `someday` (global) | same as `anytime` | same; dual citizens seat here canonically (R7) |
| `upcoming` (global) | `data.view = { days: [ { when, items, total? } … ], resting: {items} }` | RESHAPE: flat list → day blocks (each block = the complete global day scope, `--in <when>`); date-less resting templates get their own non-sentinel bucket |
| `logbook` (global) | `data.items` (`stopDate DESC`) | unchanged (non-scope) |
| `trash` | `data.items` | unchanged (non-scope, presentation order) |
| `search` | `data.items` + per-row `match` | unchanged (non-scope) |
| `changes` | `data.items` + per-row `changeKind` | unchanged (non-scope) |
| `projects` listing | `data.items` | unchanged (non-scope; the sidebar-rank scopes live in `area-view.projects`) |
| `areas` listing | `data.items` | unchanged (IS the area-rank scope — `reorder_areas`) |
| `project-view` | `data.view = { project, children, headings[], …advisories }` per §2 R2–R6 | RESHAPE: stage buckets return under `children` (+ per-container `logbook`); `headings[]` recursive, all lifecycle classes, no `logbookHeadings`, no root logbook |
| `area-view` | `data.view = { area \| null, children: { anytime, upcoming[], someday }, projects: {items, total?} }` | RESHAPE: direct to-dos under `children` records; `projects` record-ized (a real scope: child-project sidebar rank). NO `logbook` key — the area logbook stays a query view (#346) |
| `detail` / `show` router | `data.item` | unchanged |
| `tags` | flat catalog | unchanged / out of scope |

Advisories (`openChildrenWhileResolved`, `openChildrenUnderArchivedHeading`) are kept unchanged — semantic advisories, not buckets.

## 4. Rulings log (maintainer, 2026-08-04 → 05)

- **#V1 — headings option A.** Un-headed children are the container's own `children`; `headings[]` holds real entities only. Rejected: `{uuid: null}` pseudo-heading sentinel (unreorderable, non-self-describing, taxes the degenerate case).
- **#V2 — day blocks as arrays** (upcoming option A). Rejected: dynamic date keys (key-order fragility, schema degradation, no metadata home) and uniform stage-record arrays (loses `children.anytime` addressing; order carries no information).
- **#V3 — uniform bucket records with inline `total`.** Presence ⟺ capped. Retires the truncation sidecar join.
- **#V4 — logbook as a per-container stage bucket** (maintainer's shape). Rejected: the union-timeline counter-proposal — its live/archived two-family asymmetry re-encoded GUI placement as structure.
- **#V5 — dual citizens once per view, canonical stage in containers.** GUI-faithful; keeps every bucket a complete non-overlapping scope.
- **#V6 — v1 rulings #C1 (counts + "badge" ban), #C2 (area sections), #C3a (heading lifecycle = `archived` only), #C6 (ordering contract) re-land on v2 shapes.**
- **#V7 — HEADSORT** resolves R5's scope-completeness sentence when it lands.

## 5. Migration

Five sequential PRs, each independently green (ALPHA-CONTRACT: break freely, no shims, no dual shapes). Each carries contract + schema regen + CHANGELOG (Unreleased, breaking — all land in **0.14.0**), per-view fixtures, JSON-shape regression tests, and TTY byte-stability tests wherever the TTY is not being deliberately changed.

1. **Doctrine ratify + today reshape** — `children` records, `meta.counts`, "badge" ban re-landed, v1's ratified today-TTY treatment restored.
2. **project-view recursion** — `children` (incl. `logbook`), recursive `headings[]`, `logbookHeadings`/root-logbook gone; HEADARC2/3 TTY fidelity re-derived and byte-locked.
3. **area-view** — `children` records + `projects` record.
4. **global upcoming day blocks** — `view.days` + `resting`; dual-citizen seating (R7) enforced across all views with regression locks.
5. **inline truncation sweep** — `total` everywhere, retire `meta.truncation.blocks[]`, ordering-contract table (#C6) + skill sweep for v2 shapes.

Living-doc updates ride each PR per AGENTS.md. On ratification, this doc's status flips to RATIFIED and v1 gains a "superseded by v2" banner; when HEADSORT lands, §2 R5 loses its pending clause and the capability matrix gains the verdict.
