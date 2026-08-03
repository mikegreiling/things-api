# Read-shape doctrine — JSON models semantic state; TTY projects GUI placement

**Status: RATIFIED.** This is the doctrine of record for every primary read view's JSON `data` payload, plus the per-view verdicts it produces. The maintainer's rulings on the contentious calls (§4) are final and are baked into the per-view verdicts (§3). The doctrine is being implemented across five sequential PRs (§6); a per-view verdict marked **landed** already ships, one marked **planned** is ratified design the code is catching up to.

This document extends [api-doctrine.md](api-doctrine.md) (the design canon) and is the *why/what* behind the contract change it drives. It obeys api-doctrine §1 (the ten-sentence grammar): every target shape still fits an existing `data` wrapper (`item` / `items` / `sections` / `view`) — no sixth container is invented.

## 1. The doctrine

> **JSON models semantic state; TTY projects GUI placement.** A JSON bucket may exist only if it encodes a STATE of the data (stage, schedule axis, archived-ness, order structure). Anything encoding WHERE the GUI renders something (a toggle, a visual grouping, a section split that duplicates information already on the rows) belongs to the TTY projection, derived from row attributes. Corollaries: agents value completeness-per-query (one bucket per semantic question), stable documented orderings, and self-describing rows (refs per the #362 flat-ref conventions); duplicated or split state across buckets is a defect; a bucket whose membership is derivable from an attribute already on its rows must justify itself by ORDER structure (like live heading groups, which encode the project's real index axis) or die.

### 1.1 The operational test (applied uniformly below)

A JSON bucket **survives** iff it encodes an **order axis or a state that is NOT already recoverable from attributes on its own rows**. It **dies** — dissolving into a flat list whose rows each carry the distinguishing attribute — iff both its *membership* and its *ordering* are recoverable from row attributes.

This single test resolves the whole surface into two families:

- **KEEP (order-axis buckets).** The bucket's *ordering* is a user-controlled axis the rows do not carry: a heading's `index`, an area's sidebar rank, a project's sidebar rank. Membership may be a row attribute, but the *order* is not, so the bucket earns its place. (This is exactly why the doctrine names live heading groups.)
- **DISSOLVE (attribute-split buckets).** The bucket partitions rows by an attribute each row already carries (or can carry): `stage`, `when`, `heading`, `changeKind`, `type`. Both membership and order fall out of the attribute + a documented sort. The split is GUI placement → it belongs to the TTY.

The two axes that already exist to make rows self-describing — `stage` (the sidebar bucket) and `when` (the time position) — are the workhorses: every stage-split bucket dissolves because `stage`/`when` re-derive it. The flat-ref conventions (#362: `project`/`area`/`heading` as bare-title strings with `*Uuid` siblings when the title would not round-trip) are what let a dissolved row still name its container.

## 2. Legend for the tables

Each row: **bucket/key** → **encodes** (semantic state / order structure / GUI placement / mixed) → **verdict** → **target shape** → **migration note** (what breaks for a consumer).

Verdicts: **KEEP** (survives unchanged) · **KEEP (order axis)** (survives, justified by ordering) · **DISSOLVE** (→ flat list + attribute) · **MERGE** (folds into another bucket) · **RESHAPE** (survives but changes form).

"Already clean" = the current shape already satisfies the doctrine; listed for completeness and to lock it against future drift.

---

## 3. Per-view audit (ratified verdicts)

### 3.1 `today` — **landed (PR 1)**

Was: `data: { sections:[{key:"today"},{key:"evening"}], badge }`. Now: `data: { items }`, with the whole-view counts on `meta.counts`.

| bucket/key | encodes | verdict | target shape | migration note |
|---|---|---|---|---|
| `today` / `evening` sections | GUI placement — the Today-proper and This-Evening render sub-regions. Each member's section is exactly its `when` (`"today"` / `"evening"`). | **DISSOLVE** | one flat `items[]` (the `items` wrapper) in comparator order, each row carrying `when` + `provisional`; `stage` still dropped (stage-pure `anytime`). | `data.sections` disappears; read `data.items`. `when` reappears on the row (was section-dropped). This-Evening membership = `when === "evening"`. |
| `badge {dueOrOverdue, other}` | derived aggregate (the app's sidebar count). Recoverable per-row (`deadline <= today`, open-membership). | **KEEP as `meta.counts`** (ruling #C1) | moved to `meta.counts = {dueOrOverdue, other}`; the word "badge" is purged from all consumer copy. | read `meta.counts`, not `data.badge`. |

Order (now documented in [../contract.md](../contract.md)): `startBucket ASC, COALESCE(todayIndexReferenceDate, startDate, deadline) DESC, todayIndex ASC, uuid ASC`. The TTY re-projects the two GUI sections from `when`, renders the counts as card-style metadata lines at the top, and keeps its clean `── ★ Today ──` header (ruling #C1). `meta.truncation.sections` (the per-render-section shown/total breakdown) survives — it is completeness metadata for the two TTY sections, not a data bucket, and keeps This Evening honest under a single global cap.

### 3.2 `inbox` — `data: { items }`

| bucket/key | encodes | verdict | target shape | migration note |
|---|---|---|---|---|
| flat `items[]` | stage-pure (`inbox`) list; `stage` dropped as implied. | **KEEP (already clean)** | unchanged. | none. |

Order: `index ASC`.

### 3.3 `anytime` — `data: { sections:[{area, items}] }`

Sidebar sections by area (loose/null-area block first), rows drop `area` + `stage` (pure).

| bucket/key | encodes | verdict | target shape | migration note |
|---|---|---|---|---|
| `sections[].area` grouping | order structure — the area **sidebar rank** (`TMArea.index`), a user-controlled axis NOT carried on any row. Analogous to heading `index`. | **KEEP (order axis)** — ruling #C2 KEEP | unchanged (`sections` wrapper, `{area, items}`), area rank = array order. | none. |
| within-section project clustering | order structure — a project row followed by its children (project sidebar order). | **KEEP (order axis)** | unchanged; children carry `project`, drop `area`. | none. |
| `items[]` rows | stage-pure Anytime members; `stage`/`area` dropped as implied. | **KEEP (already clean)** | unchanged. | none. |

Order: sidebar (area rank → within-area drag order → project-then-children).

### 3.4 `someday` — `data: { sections:[{area, items}] }`

Same wire shape as `anytime`. The "own block" / active-project-children partition (`partitionSomedaySection`) is a **render-only** structure — it is NOT in the JSON. The JSON is area sections whose `items` are ordered `projects, direct to-dos, then active-project children`.

| bucket/key | encodes | verdict | target shape | migration note |
|---|---|---|---|---|
| `sections[].area` grouping | order structure — area sidebar rank. | **KEEP (order axis)** — ruling #C2 KEEP | unchanged. | none. |
| in-section ordering (projects → direct → children) | GUI placement — a within-section visual ordering derivable from `type` + `project`/`when`. | **KEEP** (documented order) | keep the documented order; the TTY re-clusters. | none. |
| `items[]` rows | stage-pure Someday members; `stage`/`area` dropped. | **KEEP (already clean)** | unchanged. | none. |

Order: sidebar.

### 3.5 `upcoming` — `data: { items }`

The GLOBAL upcoming view is **already flat** — one `items[]`, each row carrying `when` (a future ISO date), `stage` KEPT (mixed: future-dated `upcoming` rows + deadline-forecast `anytime`/`someday` rows). Resting templates trail with no `when`.

| bucket/key | encodes | verdict | target shape | migration note |
|---|---|---|---|---|
| flat `items[]` | mixed-stage, date-ordered by `COALESCE(startDate, deadline)`; the date is carried per-row as `when`. | **KEEP (already clean)** | unchanged. The reference precedent: the global upcoming already chose `when`-per-row over date-group buckets. | none. |

Order: `COALESCE(startDate, deadline) ASC, todayIndex ASC, uuid`. This view is the exemplar the card date-groups (§3.12) are conformed to.

### 3.6 `logbook` — `data: { items }`

| bucket/key | encodes | verdict | target shape | migration note |
|---|---|---|---|---|
| flat `items[]` | stage-pure (`logbook`); `stage` dropped. | **KEEP (already clean)** | unchanged. | none. |

Order: `stopDate DESC` (semantic: recency of completion).

### 3.7 `trash` — `data: { items }`

| bucket/key | encodes | verdict | target shape | migration note |
|---|---|---|---|---|
| flat `items[]` | stage-pure (`trash`); `stage` dropped. | **KEEP (already clean)** | unchanged. | none. |

Order: `userModificationDate DESC` — a **presentation-derived** recency order (not a user-controlled axis). Stated as such in the contract.

### 3.8 `search` — `data: { items }`

| bucket/key | encodes | verdict | target shape | migration note |
|---|---|---|---|---|
| flat `items[]` | mixed provenance; `stage` KEPT (mixed), refs kept (mixed list). | **KEEP (already clean)** | unchanged. | none. |
| per-row `match {field,text}` | semantic — match provenance (heading/notes/checklist). | **KEEP** | unchanged; presence-keyed. | none. |

Order: relevance rank (`compareSearchMatches`) — presentation-derived by nature, appropriate for search; stated as such.

### 3.9 `changes` — `data: { items }`

| bucket/key | encodes | verdict | target shape | migration note |
|---|---|---|---|---|
| flat `items[]` | mixed (incl. trashed/logged/templates); `stage` KEPT. | **KEEP (already clean)** | unchanged. | none. |
| per-row `changeKind` | semantic state — created vs modified. | **KEEP** | unchanged. | none. |

Order: `userModificationDate DESC`.

### 3.10 `projects` (listing) — `data: { items }`

| bucket/key | encodes | verdict | target shape | migration note |
|---|---|---|---|---|
| flat `items[]` (Project rows) | mixed-stage listing in sidebar order; `stage` KEPT; rows carry `area` (self-describing). | **KEEP (already clean)** | unchanged. | none. |

Order: sidebar (area rank → active-first → drag order); `--later` appends scheduled/someday per group. The area-rank ordering is an order axis NOT on the rows (same class as #C2).

### 3.11 `areas` (listing) — `data: { items }`

| bucket/key | encodes | verdict | target shape | migration note |
|---|---|---|---|---|
| flat `items[]` (Area rows) | catalog; tags folded to names; no lifecycle buckets. | **KEEP (already clean)** | unchanged. | none. |

Order: `TMArea.index` (sidebar rank). This listing is the natural home for the area-rank axis §3.3/§3.4/§3.10 depend on.

### 3.12 `project-view` (`data: { view }`) — **landed (PRs 2–3)**

The end-state shape is live: PR 2 dissolved the unheaded + per-heading stage sub-buckets into one flat `items[]` (index order, each headed row carrying its `heading` ref); PR 3 flattened `headings[]` to the catalog `[{uuid,title,archived?}]` (ALL headings — live + swept archived — in index order, collapsing empties under a content scope), dissolved `logbookHeadings`, and merged all swept children into ONE flat `logbook` (`stopDate DESC`, each carrying its `heading` ref, `stage` KEPT since the bucket is mixed — it can hold an odd open child stranded under an archived heading).

Current buckets: `project` (card node) · `anytime[]` · `upcoming[{date,items}]` · `someday[]` (all UNHEADED) · `headings[{heading:{uuid,title,archived?}, anytime[], upcoming[{date,items}], someday[]}]` (live heading groups with per-heading stage sub-buckets) · `logbook[]` (flat swept rows) · `logbookHeadings[{heading, items[]}]` (archived-heading groups) · `openChildrenWhileResolved` · `openChildrenUnderArchivedHeading`.

| bucket/key | encodes | verdict | target shape | migration note |
|---|---|---|---|---|
| `project` (card node) | the entity. | **KEEP** | full DTO, unchanged. | none. |
| unheaded `anytime`/`upcoming`/`someday` | stage/date split of unheaded live children — `stage`/`when` are row attributes. | **DISSOLVE** → live `items[]` (PR 2) | fold into ONE flat `items[]` of all LIVE children, project `index` order, each carrying `stage` + `when` (+ `heading` ref if headed). | three buckets → one; membership re-derived from `stage`/`when`. |
| `headings[]` (live groups) | order structure — the heading `index` axis (which headings exist, in order, incl. EMPTY ones); PLUS per-heading stage sub-buckets (attribute splits). | **RESHAPE** → index-ordered catalog (PR 3, ruling #C3) | `headings[]` becomes a flat catalog `[{uuid, title, archived?}]` in index order; heading membership rides each row's `heading` ref in the flat `items[]`. | nested per-heading buckets gone; reconstruct a heading's members by filtering `items[]` on `heading` (uuid) in catalog order. |
| per-heading stage sub-buckets | stage split within a heading — no independent order axis (within-heading order is `index`). | **DISSOLVE** (PR 2) | headed rows join the flat `items[]` carrying `heading` + `stage` + `when`. | see above. |
| `logbook[]` (flat swept) | stage-pure (all logged); KEEPS `heading` ref (two-view sublabel asymmetry, HEADARC2-B). | **RESHAPE / MERGE target** (PR 3, ruling #C4) | key stays **`logbook`** (matches the stage word and the global view kind); absorbs the swept children of ARCHIVED headings too, each with its `heading` ref; one flat `stopDate DESC` list. | swept-heading children now appear here, not in a separate group. |
| `logbookHeadings[{heading,items}]` | GUI placement — the logged-region grouping of archived-heading children. Membership = each child's `heading` ref; archived-ness = the catalog's `archived`. | **DISSOLVE** (PR 3) | gone. Archived-heading children move into flat `logbook[]` (heading ref per row); the archived heading itself is a `headings[]` catalog row with `archived` set. | consumers reading `logbookHeadings` now read `logbook[]` + join on `heading`, and read archived-ness from the `headings[]` catalog. |
| `openChildrenWhileResolved` / `openChildrenUnderArchivedHeading` | semantic advisories (§6¾ / HEADARC2-C). | **KEEP** | unchanged (presence/count). | none. |

**Ratified project-view shape (end state after PRs 2–3):**
```
view: {
  project: {…full node…},
  headings: [ {uuid, title, archived?} … ],   // index-ordered catalog (all headings, live + archived); archived only, no stage/status (ruling #C3a)
  items:    [ …all LIVE children, project index order, each row: stage, when?, heading? (uuid ref if headed) … ],
  logbook:  [ …all SWEPT children, stopDate DESC, each row: heading? (uuid ref if under a heading) … ],
  openChildrenWhileResolved: N,
  openChildrenUnderArchivedHeading: N
}
```
One bucket per semantic question: the heading **order axis** (`headings`), the live children (`items`), the done children (`logbook`), and the two advisories. Every row is self-describing (stage/when/heading refs). The TTY reconstructs the exact current GUI-faithful rendering (heading groups, sub-bucket placement, HEADARC2 logged-region fidelity) from row attributes — byte-stable across PRs 2–3.

Orderings: `headings` = heading `index ASC`; `items` = child `index ASC`; `logbook` = `stopDate DESC` (open odd children null-last).

### 3.13 `area-view` (`data: { view }`) — **planned (PR 4)**

Current buckets: `area` (node, or `null` for loose) · `anytime[]` (direct to-dos) · `projects[]` (mixed-stage project rows) · `upcoming[{date,items}]` · `someday[]`.

| bucket/key | encodes | verdict | target shape | migration note |
|---|---|---|---|---|
| `area` (node, or `null`) | the entity (or the loose pseudo-area). | **KEEP** | unchanged. | none. |
| `anytime`/`upcoming`/`someday` (direct) | stage/date split of direct to-dos. | **DISSOLVE** → `items[]` (PR 4) | fold direct-to-do buckets into ONE flat `items[]`, index order, `stage`+`when` per row (drop `area`, node states it). | three buckets → one; re-derive from `stage`/`when`. |
| `projects[]` | order structure — the area's child-project **sidebar rank**, a distinct axis from the direct-to-do `index`; mixed-stage (rows carry `stage`, someday/scheduled projects included). | **KEEP (order axis)** | unchanged (flat, mixed-stage, sidebar order). The someday-projects / active-projects render split is TTY-only. | none. The area-show "projects vs someday-projects vs direct vs upcoming vs loose" *variants* collapse to TTY renderings of `projects[]` + `items[]`. |

**Ratified area-view shape (end state after PR 4):**
```
view: {
  area: {…} | null,
  projects: [ …child projects, sidebar order, each row: stage, when? … ],   // KEEP — distinct order axis
  items:    [ …direct to-dos, index order, each row: stage, when? … ]        // DISSOLVED from anytime/upcoming/someday
}
```
The deliberate asymmetry with project-view: an area has TWO order axes (project sidebar rank, direct-to-do index), so it keeps two flat lists; a project has one (child index), so it keeps one `items[]` + the heading catalog.

Orderings: `projects` = sidebar rank (active-first within group); `items` = `index ASC`.

### 3.14 `detail` / `show` card nodes — `data: { item }`

`show` is a router (to-do → `detail`, project → `project-view`, area → `area-view`); it introduces no distinct shape. `detail` is the FULL record with every ref, `stage`, `when`, and raw `startDate` — maximally self-describing.

| bucket/key | encodes | verdict | target shape | migration note |
|---|---|---|---|---|
| the single item DTO | full entity state; no buckets. | **KEEP (already clean)** | unchanged. | none. |

### 3.15 tag views

`things tags` returns a flat `Tag[]` catalog with no lifecycle buckets — nothing to audit under this doctrine. A `--tag` FILTER is a scope on the views above, not a view. **KEEP (out of scope / already clean).**

---

## 4. Ratified rulings (the contentious calls, decided)

The audit surfaced six contentious calls; the maintainer's rulings are final and are baked into §3.

- **#C1 — `today.badge` → `meta.counts`, and purge "badge".** The whole-view count moves to `meta.counts = {dueOrOverdue, other}` so `data` stays pure domain rows. The word "badge" is eliminated from all consumer-facing surfaces (JSON keys, TTY output, help copy, MCP descriptions, skill, contract) and added to the banned-vocabulary regression lists ([surface-copy.md](surface-copy.md) rule 6). Evidence docs describing the app's GUI banner/badge stay as they are. TTY: the today header is clean (`── ★ Today ──`) and the counts render at the TOP as card-style metadata lines (indented `key: value`), matching the `things area show` / `things project show` header-metadata convention.
- **#C2 — anytime/someday area grouping: KEEP `sections`.** The area **sidebar rank** is a real user-controlled order axis not carried on any row, and it is the axis per-block truncation (`meta.truncation.blocks[]`) hangs on — so it earns its place exactly like live heading groups. The section order IS the area rank (documented). This applies equally to the `projects` listing's area-rank ordering.
- **#C3 — project-view `headings[]`: flat catalog + refs.** `headings[]` = `[{uuid, title, archived?}]` in index order; membership rides each row's `heading` ref in a single `items[]`.
- **#C3a — swept-heading sweep axis: `archived` only.** A heading emits `archived` (the archive timestamp) and nothing else — no `stage`, no `status` on heading nodes. Sweptness (archived AND past the logbook boundary) is pure GUI placement, TTY-derived from `archived` + the boundary.
- **#C4 — flattened logged bucket key is `logbook`.** The project-view's flat swept bucket keeps the key **`logbook`** (matches the stage word and the global `logbook` view kind), carries ALL swept children (of open AND archived headings) each with its `heading` ref, and `logbookHeadings` is deleted. The two-view sublabel asymmetry (HEADARC2-B) is preserved and extends uniformly to archived-heading children.
- **#C5 — wrapper machinery: prune only what dies naturally.** Dissolving `today` moved it to the `items` wrapper; because #C2 KEEPS anytime/someday on the `sections` wrapper, the `sections` wrapper still has users and stays. Only machinery that loses its last user is pruned.
- **#C6 — ordering contract.** Every surviving bucket's ordering is documented in [../contract.md](../contract.md); presentation-derived orders (trash recency, search rank) are documented as such.

---

## 5. Ordering audit

For every surviving bucket, its order and whether it is a user-controlled axis or presentation-derived. All are documented in [../contract.md](../contract.md) (ruling #C6).

| view / bucket | order | user-axis or presentation-derived |
|---|---|---|
| today items | startBucket, referenceDate DESC, todayIndex, uuid | mixed (index axis + recency) |
| inbox | `index ASC` | user axis (drag order) |
| anytime / someday sections | area rank → within-area drag → project-then-children | user axis (sidebar) |
| upcoming | `COALESCE(startDate,deadline) ASC`, todayIndex, uuid | schedule axis |
| logbook | `stopDate DESC` | recency (semantic: completion time) |
| trash | `userModificationDate DESC` | **presentation-derived** (recency) |
| search | relevance rank | **presentation-derived** (appropriate) |
| changes | `userModificationDate DESC` | recency |
| projects listing | sidebar (area rank → active-first → drag) | user axis |
| areas listing | `TMArea.index` | user axis (sidebar rank) |
| project-view `headings` | heading `index ASC` | user axis |
| project-view `items` | child `index ASC` | user axis |
| project-view `logbook` | `stopDate DESC`, open-odd null-last | recency |
| area-view `projects` | sidebar rank, active-first | user axis |
| area-view `items` | `index ASC` | user axis |

Two orders are purely presentation-derived (trash recency, search rank) and are documented as such; the rest are real user-controlled axes pinned in the contract.

---

## 6. Migration — five sequential PRs

Ordered so each step is independently green and self-merged before the next (ALPHA-CONTRACT: break freely, no shims). Each PR carries its own contract + schema regen + CHANGELOG, per-view snapshot/fixture updates, JSON-shape regression tests, and (PRs 2–4) TTY byte-stability tests.

1. **`mg/today-dissolve` — today dissolve (§3.1) + this doctrine doc.** `sections` → flat `items[]` + `when`; `badge` → `meta.counts`; the "badge" vocabulary purge; the TTY redesign (clean header + counts at top). **Landed.**
2. **`mg/project-children-dissolve` — project-view children dissolve (§3.12).** Unheaded + per-heading stage sub-buckets → one flat `items[]` in project index order, every row carrying `stage`/`when`/`heading` ref; `headings[]` becomes the memberless live-heading catalog. TTY byte-stable (the library retains the structured groups for the GUI-faithful projection — it owns the clock + `todayIndex`; the wire is flat). **Landed.**
3. **`mg/headings-catalog-logbook-flatten` — headings catalog + logbook flatten (§3.12, rulings #C3/#C3a/#C4).** `headings[]` → index-ordered catalog `[{uuid,title,archived?}]` (all headings, live + swept archived); `logbookHeadings` dissolves; single flat `logbook` bucket (stopDate DESC) absorbing archived-heading children, each with its `heading` ref, `stage` kept (mixed). All HEADARC2 TTY invariants preserved (byte-stable — the library keeps its structured logged-region grouping for the projection). **Landed.**
4. **`mg/area-view-dissolve` — area-view dissolve (§3.13).** Direct `anytime`/`upcoming`/`someday` → one flat `items[]`; `projects[]` KEPT (sidebar-rank axis). TTY byte-stable.
5. **`mg/ordering-contract-docs` — ordering contract + skill sweep (ruling #C6).** Document every kept bucket's ordering in [../contract.md](../contract.md) (+ envelope schema description strings); flag presentation-derived orders as such; sweep [contracts.md](contracts.md) and the skill for the new shapes across all five PRs; fix the §5o "the desktop GUI is stricter" lede to platform-accurate wording.

Living-doc updates ride each PR (per AGENTS.md): [../contract.md](../contract.md), [contracts.md](contracts.md), `CHANGELOG.md` (Unreleased, breaking), and the capability-matrix if a read verdict changes.
