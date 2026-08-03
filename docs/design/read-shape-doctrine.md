# Read-shape doctrine — JSON models semantic state; TTY projects GUI placement

**Status: DRAFT for maintainer review — do not implement from this yet.** This is an exhaustive audit of every primary read view's JSON `data` payload against a ratified doctrine. It proposes per-view target shapes, flags the calls that need a decision, and estimates the implementation. Nothing here is built; the code still ships the shapes described in [docs/contract.md](../contract.md) and `src/read/shape.ts`.

This document extends [api-doctrine.md](api-doctrine.md) (the design canon) and is the *why/what* behind a future contract change. It obeys api-doctrine §1 (the ten-sentence grammar): every proposed shape still fits an existing `data` wrapper (`item` / `items` / `sections` / `view`) — no sixth container is invented.

## 1. The doctrine

> **JSON models semantic state; TTY projects GUI placement.** A JSON bucket may exist only if it encodes a STATE of the data (stage, schedule axis, archived-ness, order structure). Anything encoding WHERE the GUI renders something (a toggle, a visual grouping, a section split that duplicates information already on the rows) belongs to the TTY projection, derived from row attributes. Corollaries: agents value completeness-per-query (one bucket per semantic question), stable documented orderings, and self-describing rows (refs per the #362 flat-ref conventions); duplicated or split state across buckets is a defect; a bucket whose membership is derivable from an attribute already on its rows must justify itself by ORDER structure (like live heading groups, which encode the project's real index axis) or die.

### 1.1 The operational test (applied uniformly below)

A JSON bucket **survives** iff it encodes an **order axis or a state that is NOT already recoverable from attributes on its own rows**. It **dies** — dissolving into a flat list whose rows each carry the distinguishing attribute — iff both its *membership* and its *ordering* are recoverable from row attributes.

This single test resolves the whole surface into two families:

- **KEEP (order-axis buckets).** The bucket's *ordering* is a user-controlled axis the rows do not carry: a heading's `index`, an area's sidebar rank, a project's sidebar rank. Membership may be a row attribute, but the *order* is not, so the bucket earns its place. (This is exactly why the doctrine names live heading groups.)
- **DISSOLVE (attribute-split buckets).** The bucket partitions rows by an attribute each row already carries (or can carry): `stage`, `when`, `heading`, `changeKind`, `type`. Both membership and order fall out of the attribute + a documented sort. The split is GUI placement → it belongs to the TTY.

The two axes that already exist to make rows self-describing — `stage` (the sidebar bucket) and `when` (the time position) — are the workhorses: every stage-split bucket dissolves because `stage`/`when` re-derive it. The flat-ref conventions (#362: `project`/`area`/`heading` as bare-title strings with `*Uuid` siblings when the title would not round-trip) are what let a dissolved row still name its container.

## 2. Legend for the tables

Each row: **bucket/key** → **encodes** (semantic state / order structure / GUI placement / mixed) → **verdict** → **proposed shape** → **migration note** (what breaks for a consumer).

Verdicts: **KEEP** (survives unchanged) · **KEEP (order axis)** (survives, justified by ordering) · **DISSOLVE** (→ flat list + attribute) · **MERGE** (folds into another bucket) · **RESHAPE** (survives but changes form).

"Already clean" = the current shape already satisfies the doctrine; listed for completeness and to lock it against future drift.

---

## 3. Per-view audit

### 3.1 `today` — `data: { sections:[{key:"today"},{key:"evening"}], badge }`

Current: two render-sections (`today`, `evening`), each a flat list with `stage` AND `when` dropped (both section-implied), plus a `badge {dueOrOverdue, other}`.

| bucket/key | encodes | verdict | proposed shape | migration note |
|---|---|---|---|---|
| `today` section | GUI placement — the "today-proper" sub-region. Every member is `when:"today"`. | **DISSOLVE** | one flat `items[]` (existing `items` wrapper), comparator order preserved, each row carrying `when` (`"today"`\|`"evening"`) + `provisional`. | `data.sections` disappears; read `data.items`. `when` reappears on the row (was dropped). Evening membership = `when === "evening"`. |
| `evening` section | semantic flag, but ALREADY captured by `when:"evening"`. The *section* is placement; the *state* is the attribute. | **DISSOLVE** (into the same `items[]`) | (as above) — evening rows are the `when:"evening"` subset, still contiguous in comparator order. | Consumers that keyed on the evening section now filter `when === "evening"`. No state lost — `when` carries it. |
| `badge {dueOrOverdue, other}` | derived aggregate (the sidebar count). Recoverable per-row (`deadline <= today`, open-membership). | **KEEP (as meta aggregate)** — arguable; see contentious #C1. | leave on the payload (or move to `meta`); it is a convenience count, not a bucket. | none if kept in place. |

Order to document: `startBucket ASC, COALESCE(todayIndexReferenceDate, startDate, deadline) DESC, todayIndex ASC, uuid ASC` (currently in `views.ts`, not in the contract).

### 3.2 `inbox` — `data: { items }`

| bucket/key | encodes | verdict | proposed shape | migration note |
|---|---|---|---|---|
| flat `items[]` | stage-pure (`inbox`) list; `stage` dropped as implied. | **KEEP (already clean)** | unchanged. | none. |

Order: `index ASC`. **Undocumented in contract** — flag.

### 3.3 `anytime` — `data: { sections:[{area, items}] }`

Sidebar sections by area (loose/null-area block first), rows drop `area` + `stage` (pure).

| bucket/key | encodes | verdict | proposed shape | migration note |
|---|---|---|---|---|
| `sections[].area` grouping | order structure — the area **sidebar rank** (`TMArea.index`), a user-controlled axis NOT carried on any row. Analogous to heading `index`. | **KEEP (order axis)** — but see contentious #C2. | unchanged (`sections` wrapper, `{area, items}`), area rank = array order. | none (if kept). |
| within-section project clustering | order structure — a project row followed by its children (project sidebar order). | **KEEP (order axis)** | unchanged; children carry `project`, drop `area`. | none. |
| `items[]` rows | stage-pure Anytime members; `stage`/`area` dropped as implied. | **KEEP (already clean)** | unchanged. | none. |

Order: sidebar (area rank → within-area drag order → project-then-children). **Undocumented** — flag.

### 3.4 `someday` — `data: { sections:[{area, items}] }`

Same wire shape as `anytime`. Note: the "own block" / active-project-children partition (`partitionSomedaySection`) is a **render-only** structure — it is NOT in the JSON. The JSON is area sections whose `items` are ordered `projects, direct to-dos, then active-project children`.

| bucket/key | encodes | verdict | proposed shape | migration note |
|---|---|---|---|---|
| `sections[].area` grouping | order structure — area sidebar rank. | **KEEP (order axis)** — tied to #C2. | unchanged. | none (if kept). |
| in-section ordering (projects → direct → children) | GUI placement — a within-section visual ordering derivable from `type` + `project`/`when`. | **RESHAPE (arguable)** | either keep the documented order, or emit a single index-ordered `items[]` and let the TTY re-cluster. | if reshaped, the "active-project children last" grouping is re-derived from `project` + `stage:"someday"`. |
| `items[]` rows | stage-pure Someday members; `stage`/`area` dropped. | **KEEP (already clean)** | unchanged. | none. |

Order: sidebar. **Undocumented** — flag.

### 3.5 `upcoming` — `data: { items }`

The GLOBAL upcoming view is **already flat** — one `items[]`, each row carrying `when` (a future ISO date), `stage` KEPT (mixed: future-dated `upcoming` rows + deadline-forecast `anytime`/`someday` rows). Resting templates trail with no `when`.

| bucket/key | encodes | verdict | proposed shape | migration note |
|---|---|---|---|---|
| flat `items[]` | mixed-stage, date-ordered by `COALESCE(startDate, deadline)`; the date is carried per-row as `when`. | **KEEP (already clean)** | unchanged. This is the reference precedent: the global upcoming already chose `when`-per-row over date-group buckets. | none. |

Order: `COALESCE(startDate, deadline) ASC, todayIndex ASC, uuid`. **Undocumented** — flag. This view's design is the exemplar the card date-groups (§3.12, §3.13) should be conformed to.

### 3.6 `logbook` — `data: { items }`

| bucket/key | encodes | verdict | proposed shape | migration note |
|---|---|---|---|---|
| flat `items[]` | stage-pure (`logbook`); `stage` dropped. | **KEEP (already clean)** | unchanged. | none. |

Order: `stopDate DESC`. **Undocumented** — flag. (Semantic: recency of completion.)

### 3.7 `trash` — `data: { items }`

| bucket/key | encodes | verdict | proposed shape | migration note |
|---|---|---|---|---|
| flat `items[]` | stage-pure (`trash`); `stage` dropped. | **KEEP (already clean)** | unchanged. | none. |

Order: `userModificationDate DESC` — a **presentation-derived** recency order (not a user-controlled axis). **Undocumented** — flag; state it explicitly if kept.

### 3.8 `search` — `data: { items }`

| bucket/key | encodes | verdict | proposed shape | migration note |
|---|---|---|---|---|
| flat `items[]` | mixed provenance; `stage` KEPT (mixed), refs kept (mixed list). | **KEEP (already clean)** | unchanged. | none. |
| per-row `match {field,text}` | semantic — match provenance (heading/notes/checklist). | **KEEP** | unchanged; presence-keyed. | none. |

Order: relevance rank (`compareSearchMatches`). Presentation-derived by nature — appropriate for search. **Rank contract undocumented** — flag.

### 3.9 `changes` — `data: { items }`

| bucket/key | encodes | verdict | proposed shape | migration note |
|---|---|---|---|---|
| flat `items[]` | mixed (incl. trashed/logged/templates); `stage` KEPT. | **KEEP (already clean)** | unchanged. | none. |
| per-row `changeKind` | semantic state — created vs modified. | **KEEP** | unchanged. | none. |

Order: `userModificationDate DESC`. **Undocumented** — flag.

### 3.10 `projects` (listing) — `data: { items }`

| bucket/key | encodes | verdict | proposed shape | migration note |
|---|---|---|---|---|
| flat `items[]` (Project rows) | mixed-stage listing in sidebar order; `stage` KEPT; rows carry `area` (self-describing). | **KEEP (already clean)** | unchanged. | none. |

Order: sidebar (area rank → active-first → drag order); `--later` appends scheduled/someday per group. **Undocumented** — flag. Note the area-rank ordering is an order axis NOT on the rows (same class as #C2) — so this flat list already relies on a presentation order the contract does not pin.

### 3.11 `areas` (listing) — `data: { items }`

| bucket/key | encodes | verdict | proposed shape | migration note |
|---|---|---|---|---|
| flat `items[]` (Area rows) | catalog; tags folded to names; no lifecycle buckets. | **KEEP (already clean)** | unchanged. | none. |

Order: `TMArea.index` (sidebar rank). **Undocumented** — flag. This listing is the natural home for the area-rank axis that §3.3/§3.4/§3.10 depend on.

### 3.12 `project-view` (`data: { view }`) — the exemplar

Current buckets: `project` (card node) · `anytime[]` · `upcoming[{date,items}]` · `someday[]` (all UNHEADED) · `headings[{heading:{uuid,title,archived?}, anytime[], upcoming[{date,items}], someday[]}]` (live heading groups with per-heading stage sub-buckets) · `logbook[]` (flat swept rows, KEEP heading ref) · `logbookHeadings[{heading, items[]}]` (archived-heading groups) · `openChildrenWhileResolved` · `openChildrenUnderArchivedHeading`.

| bucket/key | encodes | verdict | proposed shape | migration note |
|---|---|---|---|---|
| `project` (card node) | the entity. | **KEEP** | full DTO, unchanged. | none. |
| unheaded `anytime[]` | stage split of unheaded live children — `stage` is a row attribute. | **DISSOLVE** → live `items[]` | fold into ONE flat `items[]` of all UNHEADED live children, in project `index` order, each carrying `stage` + `when`. | three buckets become one; membership re-derived from `stage`. |
| unheaded `upcoming[{date,items}]` | date-group; the date IS `when` on each row; date-order = sorting `when`. | **DISSOLVE** (into the same `items[]`) | rows carry `when`; resting templates carry no `when` + a `repeating` object. Matches the global `upcoming` precedent (§3.5). | date-group nesting gone; group by `when` client-side. |
| unheaded `someday[]` | stage split. | **DISSOLVE** (into the same `items[]`) | `stage:"someday"` rows in `items[]`. | as above. |
| `headings[]` (live groups) | **order structure** — the heading `index` axis (which headings exist, in what order, incl. EMPTY ones); PLUS per-heading stage sub-buckets (attribute splits). | **RESHAPE** — see #C3 for the two shapes. | Leading recommendation: `headings[]` becomes a flat **index-ordered catalog** `[{uuid, title, archived?}]`; heading membership moves onto the flat `items[]` rows via each headed row's `heading` ref. | nested per-heading buckets gone; reconstruct a heading's members by filtering `items[]` on `heading` (uuid) in catalog order. |
| per-heading `anytime`/`upcoming`/`someday` sub-buckets | stage split within a heading — attribute splits, no independent order axis (within-heading order is `index`). | **DISSOLVE** | headed rows join the flat `items[]` carrying `heading` + `stage` + `when`. | see above. |
| `logbook[]` (flat swept) | stage-pure (all logged); KEEPS `heading` ref (two-view sublabel asymmetry, HEADARC2-B). | **RESHAPE / MERGE target** — see #C4 | rename to `logged[]`; absorb the swept children of ARCHIVED headings too (each carrying `heading`), one flat `stopDate DESC` list. | `logbook` → `logged`; swept-heading children now appear here, not in a separate group. |
| `logbookHeadings[{heading,items}]` | GUI placement — the logged-region grouping of archived-heading children. Membership = each child's `heading` ref; archived-ness = the catalog's `archived`. | **DISSOLVE** | gone. Archived-heading children move into flat `logged[]` (heading ref per row); the archived heading itself is a row in the `headings[]` catalog with `archived` set. | biggest break: consumers reading `logbookHeadings` now read `logged[]` + join on `heading`, and read archived-ness from the `headings[]` catalog. |
| `openChildrenWhileResolved` (count) | semantic — stranded-open-child advisory (§6¾). | **KEEP** | unchanged (presence/count). | none. |
| `openChildrenUnderArchivedHeading` (count) | semantic — HEADARC2-C advisory. | **KEEP** | unchanged. | none. |

**Reconciled project-view shape (leading recommendation):**
```
view: {
  project: {…full node…},
  headings: [ {uuid, title, archived?} … ],   // index-ordered catalog (all headings, live + archived)
  items:    [ …all LIVE children, project index order, each row: stage, when?, heading? (uuid ref if headed) … ],
  logged:   [ …all SWEPT children, stopDate DESC, each row: heading? (uuid ref if under a heading) … ],
  openChildrenWhileResolved: N,
  openChildrenUnderArchivedHeading: N
}
```
This is one bucket per semantic question: the heading **order axis** (`headings`), the live children (`items`), the done children (`logged`), and the two advisories. Every row is self-describing (stage/when/heading refs). See #C3/#C4 for the alternatives.

Orderings to document: `headings` = heading `index ASC`; `items` = child `index ASC`; `logged` = `stopDate DESC` (open odd children null-last).

### 3.13 `area-view` (`data: { view }`) — variants: projects / someday-projects / direct / upcoming / loose

Current buckets: `area` (node, or `null` for loose) · `anytime[]` (direct to-dos) · `projects[]` (mixed-stage project rows) · `upcoming[{date,items}]` · `someday[]`.

| bucket/key | encodes | verdict | proposed shape | migration note |
|---|---|---|---|---|
| `area` (node, or `null`) | the entity (or the loose pseudo-area). | **KEEP** | unchanged. | none. |
| `anytime[]` (direct) | stage split of direct to-dos. | **DISSOLVE** → `items[]` | fold direct-to-do buckets into ONE flat `items[]`, index order, `stage`+`when` per row (drop `area`, node states it). | three buckets → one; re-derive from `stage`. |
| `upcoming[{date,items}]` (direct) | date-group = `when`. | **DISSOLVE** (into `items[]`) | rows carry `when`. | as §3.12. |
| `someday[]` (direct) | stage split. | **DISSOLVE** (into `items[]`) | `stage:"someday"` in `items[]`. | as above. |
| `projects[]` | **order structure** — the area's child-project **sidebar rank**, a distinct axis from the direct-to-do `index`; mixed-stage (rows carry `stage`, someday/scheduled projects included). | **KEEP (order axis)** | unchanged (flat, mixed-stage, sidebar order). The someday-projects / active-projects render split is TTY-only. | none. The area-show "projects vs someday-projects vs direct vs upcoming vs loose" *variants* collapse: they are TTY renderings of `projects[]` + `items[]`, distinguished by row `stage`/`type`. |

**Reconciled area-view shape (leading recommendation):**
```
view: {
  area: {…} | null,
  projects: [ …child projects, sidebar order, each row: stage, when? … ],   // KEEP — distinct order axis
  items:    [ …direct to-dos, index order, each row: stage, when? … ]        // DISSOLVED from anytime/upcoming/someday
}
```
Note the deliberate asymmetry with project-view: an area has TWO order axes (project sidebar rank, direct-to-do index), so it keeps two flat lists; a project has one (child index), so it keeps one `items[]` + the heading catalog.

Orderings to document: `projects` = sidebar rank (active-first within group); `items` = `index ASC`.

### 3.14 `detail` / `show` card nodes — `data: { item }`

`show` is a router (to-do → `detail`, project → `project-view`, area → `area-view`); it introduces no distinct shape. `detail` is the FULL record with every ref, `stage`, `when`, and raw `startDate` — maximally self-describing.

| bucket/key | encodes | verdict | proposed shape | migration note |
|---|---|---|---|---|
| the single item DTO | full entity state; no buckets. | **KEEP (already clean)** | unchanged. | none. |

### 3.15 tag views

`things tags` returns a flat `Tag[]` catalog (name/uuid, hierarchy) with no lifecycle buckets — nothing to audit under this doctrine. A `--tag` FILTER is a scope on the views above, not a view; its output is whichever view it filtered. **KEEP (out of scope / already clean).**

---

## 4. Contentious calls — need a maintainer decision

**#C1 — `today.badge`: keep, move to `meta`, or dissolve?** The badge is a derived count (due/overdue vs other, open members only). It duplicates information recoverable per-row. *Keep in place* (one sentence): it is a cheap completeness-per-query aggregate an agent would otherwise recompute. *Dissolve* (one sentence): it is GUI chrome (the sidebar pill) and every input is on the rows, so the TTY/consumer can sum it. Recommendation: keep, but as a `meta`-level aggregate rather than beside `data.items`, so `data` stays pure domain rows (api-doctrine §2).

**#C2 — anytime/someday (and, implicitly, `projects`) area grouping: keep `sections` or dissolve to flat `items[]`?** *Keep sections* (one sentence): the area **sidebar rank** is a real user-controlled order axis not carried on any row, and the `{area, items}` structure is what per-block truncation (`meta.truncation.blocks[]`) hangs on — so it earns its place exactly like live heading groups. *Dissolve to flat* (one sentence): the area is a row attribute (#362 refs), so the grouping duplicates row state and belongs to the TTY — at the cost of re-adding `area`/`project` refs to every row and pushing area-rank lookup to the `areas` listing. Recommendation: **keep sections** (parity with the heading-group precedent the doctrine itself cites), and document that the section order IS the area rank. This is the one place the doctrine's "one bucket per semantic question" and "no split that duplicates row info" pull in opposite directions; the tie-breaker is that rank is genuinely not on the rows.

**#C3 — project-view `headings[]`: flat catalog + refs, or retained nested live groups?** *Flat catalog (Option B, recommended)*: `headings[]` = `[{uuid,title,archived?}]` in index order; membership rides each row's `heading` ref in a single `items[]` — maximally flat, one bucket per question, fully self-describing rows. *Nested live groups (Option A, conservative)*: keep `headings[{heading, items[]}]` with members nested (dropping the redundant per-heading stage sub-buckets), because it co-locates a heading with its members for the common "render this project" query. Trade-off: Option B is one join away from grouped display but avoids duplicating the heading node and keeps a single child list; Option A saves the client join but reintroduces a member-holding bucket whose membership is a row attribute. The doctrine's "completeness-per-query + self-describing rows" leans B; "co-location convenience" leans A.

**#C3a — swept-heading sweep axis: how to encode it in the flat catalog?** If `headings[]` merges live + swept headings, sweptness (archived AND past the logbook boundary) becomes underivable on the wire (the boundary is not emitted). Options: (a) **do NOT add a stage** — keep only `archived` (the timestamp); the region split (live vs logged) is TTY-derived from `archived` + boundary; this respects the stage glossary, which says a heading emits neither `status` nor `stage` (its lifecycle is archive/unarchive only). (b) add a presence-keyed `swept: true`. (c) add `stage:"logbook"` — **rejected**: it violates the heading glossary rule. Recommendation: **(a)** — `archived` is the whole story for a heading; sweptness is pure GUI placement.

**#C4 — `logbook`/`logged` naming + absorbing archived-heading children.** Recommendation: rename the flat swept bucket `logbook` → `logged` (avoids clashing with the top-level `logbook` VIEW kind and reads as a stage, not a view), and have it carry ALL swept children — of open headings AND archived headings — each with its `heading` ref; `logbookHeadings` is deleted. The one subtlety to confirm: the two-view sublabel asymmetry (HEADARC2-B, a swept child of an OPEN heading keeps its heading ref in compact) is preserved, and now extends uniformly to archived-heading children.

**#C5 — should `today`/`area-view`/`project-view` moving lists change their `data` wrapper?** Dissolving `today`'s sections moves it from the `sections` wrapper toward `items` (with `badge` as the wrinkle, see #C1). If #C2 keeps anytime/someday as sections, the `sections` wrapper still has users; if #C2 dissolves them too AND today dissolves, the `sections` wrapper is left with no users and the grammar shrinks by one wrapper. Decide #C1/#C2 first; the wrapper question falls out.

**#C6 — ordering contract.** The doctrine values "stable documented orderings," but the contract (`docs/contract.md`) documents NONE of the per-view orderings — they live only in `views.ts` comments (see §5). Adopting the doctrine should include pinning every kept bucket's order in the contract. This is a documentation obligation, not a code change, but it is part of "done."

---

## 5. Ordering audit

For every bucket that survives, its order and whether the CONTRACT documents it. **All are currently undocumented in `docs/contract.md`** — the orderings are specified only in `src/read/views.ts` / `project-view.ts` / `area-view.ts` comments. Presentation-derived orders are flagged.

| view / bucket | order | user-axis or presentation-derived | documented in contract? |
|---|---|---|---|
| today items | startBucket, referenceDate DESC, todayIndex, uuid | mixed (index axis + recency) | **no** |
| inbox | `index ASC` | user axis (drag order) | **no** |
| anytime / someday sections | area rank → within-area drag → project-then-children | user axis (sidebar) | **no** |
| upcoming | `COALESCE(startDate,deadline) ASC`, todayIndex, uuid | schedule axis | **no** |
| logbook | `stopDate DESC` | recency (semantic: completion time) | **no** |
| trash | `userModificationDate DESC` | **presentation-derived** (recency) | **no** |
| search | relevance rank | **presentation-derived** (appropriate) | **no** |
| changes | `userModificationDate DESC` | recency | **no** |
| projects listing | sidebar (area rank → active-first → drag) | user axis | **no** |
| areas listing | `TMArea.index` | user axis (sidebar rank) | **no** |
| project-view `headings` | heading `index ASC` | user axis | **no** |
| project-view `items` (proposed) | child `index ASC` | user axis | **no** |
| project-view `logged` (proposed) | `stopDate DESC`, open-odd null-last | recency | **no** |
| area-view `projects` | sidebar rank, active-first | user axis | **no** |
| area-view `items` (proposed) | `index ASC` | user axis | **no** |

**Finding:** the ordering contract is entirely implicit. Two orders are purely presentation-derived (trash recency, search rank) and should be either documented as such or reconsidered; the rest are real user-controlled axes that simply need pinning in the contract.

---

## 6. Migration checklist

Ordered so each step is independently shippable (ALPHA-CONTRACT: break freely, no shims).

1. **Dissolve `today` sections → flat `items[]` + `when` (+decide badge, #C1).** Touches `shape.ts` (`shapeTodayView`, `TODAY_SECTION_DROP` → keep `when`), `read-driver.ts` (`wrapEnvelopeData` today branch), the today renderer, `contract.md`, envelope-schema test envelopes, unit tests (`stage.test.ts` today-purity property — it asserts stage-drop, still fine; add `when`-kept assertions).
2. **Dissolve project-view stage sub-buckets (unheaded + per-heading) → flat `items[]`.** Touches `project-view.ts` (still produce the internal buckets for the renderer, OR flatten), `shape.ts` (`shapeProjectView`, `rebucketChildren` — replace with a flat index-ordered mapper), renderer (re-project buckets from rows), contract, tests.
3. **Reshape project-view `headings[]` → index-ordered catalog; move membership to row `heading` refs (#C3).** Touches `project-view.ts` (`ProjectView.headings` type), `shape.ts` (`shapeHeadingNode`, `shapeProjectView`), renderer, contract, tests. Depends on step 2.
4. **Dissolve `logbookHeadings` into flat `logged[]`; rename `logbook`→`logged`; encode sweep via `archived` only (#C3a/#C4).** Touches `project-view.ts` (`loggedHeadings`, `LoggedHeadingGroup`), `shape.ts` (`PROJECT_LOGBOOK_DROP`, `LOGGED_HEADING_MEMBER_DROP`, `shapeLoggedHeadingGroup`), renderer, contract, tests. Depends on step 3.
5. **Dissolve area-view direct stage buckets → flat `items[]`; keep `projects[]` (#C2 for the sidebar-section views is separate).** Touches `area-view.ts`, `shape.ts` (`shapeAreaView`, `AREA_CHILD_DROP`), renderer, contract, tests.
6. **(If #C2 = dissolve) flatten anytime/someday sections; else document the section order.** Touches `views.ts` (unchanged if kept), `shape.ts` (`shapeSections` path), `sections.ts`, `sidebar-order.ts`, truncation blocks, renderer, contract.
7. **Document every surviving bucket's ordering in `contract.md` (#C6).** Docs only.
8. **Regenerate `schema/envelope.schema.json`** (`npm run schema:gen`) and update the representative envelopes in `test/contract/envelope-schema.test.ts` in the SAME change as each shape step.

Living-doc updates required alongside (per AGENTS.md): `docs/contract.md`, `docs/design/contracts.md` (the per-kind `data` reference), `CHANGELOG.md` (Unreleased, breaking), and the capability-matrix if any read verdict changes.

## 7. Implementation size estimate

- **Files touched (core):** `src/read/shape.ts` (the hub — every step), `src/read/project-view.ts`, `src/read/area-view.ts`, `src/read/views.ts` (today), possibly `src/read/sections.ts` + `sidebar-order.ts` (only if #C2 dissolves). **Renderers:** `src/cli/render.ts` (each dissolved view must re-project buckets from flat rows for the TTY — this is where "TTY projects GUI placement" is actually implemented and is the bulk of the non-trivial work). **Consumer edges:** `src/cli/read-driver.ts` (`wrapEnvelopeData`). **Contract/schema:** `docs/contract.md`, `docs/design/contracts.md`, `schema/envelope.schema.json` (generated).
- **Tests touched:** `test/contract/envelope-schema.test.ts` (representative envelopes), `test/unit/stage.test.ts` (today-purity property), the shape unit tests, and the per-view snapshot/integration tests for today/project-view/area-view/anytime/someday. Expect meaningful churn in golden/snapshot fixtures.
- **PR split (recommended: 5 PRs, each independently green + shippable):**
  1. **today dissolve** (§6 step 1) — smallest, self-contained, validates the pattern.
  2. **project-view children dissolve** (step 2) — flat `items[]`, sub-buckets gone.
  3. **project-view headings catalog + logged flatten** (steps 3–4) — the heaviest; the HEADARC2 logged-region logic concentrates here.
  4. **area-view dissolve** (step 5).
  5. **anytime/someday decision + ordering documentation** (steps 6–7) — gated on the #C2 ruling; may be docs-only if #C2 = keep.

Each PR carries its own contract + schema regen + CHANGELOG. Rough scale: PRs 1/4/5 are S; PR 2 is M; PR 3 is M–L (the archived-heading/logged-region invariants and their tests). The renderer re-projection work is the load-bearing risk — the JSON simplification is straightforward, but the TTY must reconstruct the exact GUI grouping it previously read from the buckets, from row attributes alone.
