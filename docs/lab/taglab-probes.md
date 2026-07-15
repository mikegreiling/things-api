# TAGLAB — tag-ordering (TAGORD1) + tag-inheritance (TAGINH1) knowledge probes

**Campaign date:** 2026-07-15. **Env:** one disposable clone `taglab-lab` of `things-lab-golden-v1` (Things 3.22.11 / macOS 15.7.7 / DB v26), airgapped, clock-pinned 2026-07-05, SIP on; Accessibility granted via the AXVM1 rung-b VNC toggle (auth_value 2 for `sshd-keygen-wrapper`); everything else over SSH. Reproducible: [`lab/scripts/research-taglab.sh`](../../lab/scripts/research-taglab.sh) (`setup` / `tagord` / `taginh` / `shot <name>` / `teardown`; envelopes + screenshots under the gitignored `lab/artifacts/taglab-lab/`).

**These were KNOWLEDGE probes, not an automation-unblock campaign.** `tag.reorder` stays **abandoned by decision** (Mike, 2026-07-15 — see [ax-initiative.md](../design/ax-initiative.md) build item 3); nothing here reopens it.

## Headline verdicts

1. **Tie-break oracle = UUID, not title.** Never-dragged tags ubiquitously tie at `TMTag."index" = 0`; the app breaks that tie by the tag's **UUID (ascending ASCII)**, NOT alphabetically. → the CLI's `ORDER BY "index", title` was WRONG; **fixed to `ORDER BY "index", uuid`** in `fetchTagsForTasks` / `areaTags` / `tagsView`, with a corrected unit test.
2. **`TMTag."index"` is a single GLOBAL space**, not per-parent — child indexes interleave with roots.
3. **Materialization = same as areas** (AXDRAG1-e): first drag renumbers the whole list, later drags reassign one row. Not re-dragged here (decision-abandoned); a *nesting* op was independently observed to trigger a partial renumber.
4. **A heading CANNOT be tagged** on any surface (URL, AppleScript, GUI) — so heading→child tag inheritance does not exist, and our SQL (which has no heading-direct-tag clause) is correct by omission.

---

## TAGORD1 — tag-ordering semantics

### Seed
8 root tags created in reverse-alphabetical creation order (`Zeta` first … `Alfa` last) so title-order ≠ creation-order, plus a nested triad (`Nest-Parent` with children `Nest-Child-A`, `Nest-Child-B` via `set parent tag of tag … to tag "Nest-Parent"`). The golden already carried root tags (`Errand`, `Home`, `Office`, `Important`, `Pending`, `lab-tag-1/2`) and a nested pair (`prio` → `low`, `high`).

### (a) Tie-break oracle → **UUID ascending, consistent across three surfaces**

TMTag has columns `uuid, title, shortcut, usedDate, parent, index, experimental` — **no creation-date column**, so creation order is not even a candidate comparator; `usedDate` was NULL for every seeded tag. All 8 seeded roots landed tied at `index = 0` (15 tags total tied at 0).

Observed root order in the **Tags window** (VNC screenshot, negative-index tags first in ascending index, then the tied-at-0 group):

```
Errand(-498) Home(-180) Office(-67) Important(-35)
Victor Alfa lab-tag-1 Tango Pending Yankee Uniform Nest-Parent Xray lab-tag-2 Zeta prio Whiskey   ← all index 0
```

The tied-at-0 sequence is byte-for-byte the **uuid-ascending** order (uuid first chars `2,5,9,B,B,C,C,D,D,H,M,P,R`; within-group ties resolve too: `BU4T`(Tango) < `BULf`(Pending), `D3ot`(Nest-Parent) < `D7jX`(Xray)). Direct SQL confirmation against the guest DB:

```
SELECT title FROM TMTag WHERE parent IS NULL ORDER BY "index", uuid
 → Errand,Home,Office,Important,Victor,Alfa,lab-tag-1,Tango,Pending,Yankee,Uniform,Nest-Parent,Xray,lab-tag-2,Zeta,prio,Whiskey   ✅ matches GUI exactly
SELECT title FROM TMTag WHERE parent IS NULL ORDER BY "index", title
 → …,Alfa,Nest-Parent,Pending,Tango,Uniform,Victor,…   ❌ diverges (title puts Alfa before Victor)
```

**Cross-surface check (same uuid tie-break):**
- **Pill row on a to-do:** two to-dos tagged `{Victor(2Bxb), Alfa(5T4J), Zeta(M8SC)}` — one added `Victor,Alfa,Zeta`, the other `Zeta,Victor,Alfa` — **both display `Victor Alfa Zeta`** (uuid order; title order would be `Alfa Victor Zeta`). Input-order independent.
- **List filter-bar chips:** the Inbox filter bar rendered `All | Victor | Alfa | Zeta` — same uuid order.

Tag names are **NOT AX-exposed** in the Tags window (every row reads `AXDescription "Dialog Tag Template"`; parent rows additionally carry `Dialog Chevron Template`) — reconfirms AXDRAG1-e; the oracle came from the screenshot + DB, not AX.

### (b) Nested scope → **GLOBAL index space, not per-parent**

Children carry indexes drawn from the same numeric space as roots and interleave with them:

```
low          -593   parent=prio
Nest-Child-B -378   parent=Nest-Parent
high            0   parent=prio
Nest-Parent     0   (root)
Nest-Child-A    0   parent=Nest-Parent
```

`Nest-Child-B` (-378) sits numerically **among the root tags** (roots at -498/-180/-67/-35/0). This confirms the long-standing code caveat: a flat-index sort can place a child before its parent, which is why `tagsView` uses a DFS (parent then subtree) rather than a flat sort, and why the pill-row nested-tag interleave stays a documented open question.

### (c) Materialization → **as areas (AXDRAG1-e); not re-dragged**

Per the abandon decision no production drag was performed. AXDRAG1-e already established tag drag behaves like the area drag: first drag renumbers the whole (tied) list, each later drag reassigns one row / may renumber a neighbour. Bonus observation: **nesting** `Nest-Child-B` under `Nest-Parent` (an AppleScript `set parent tag`) itself materialized an index (-378) on that child while its sibling `Nest-Child-A` stayed at 0 — i.e. re-parenting, not only dragging, can assign indexes.

### (d) CLI divergence → **FIXED**

Canonical order is `ORDER BY tg."index"` with a secondary key. The code had `, tg.title` (an unoracled assumption, ratified 2026-07-14 on an index-*distinct* live example that never exercised a tie). TAGORD1 supplies the missing tie oracle: the key is **uuid**. Changed the three clauses (`fetchTagsForTasks`, `areaTags`, `tagsView`) from `title` → `uuid` and rewrote the tie-break unit test. Primary index ordering and the nested-tag caveat are untouched.

---

## TAGINH1 — tag inheritance

### (a) Heading tags → **a heading CANNOT be tagged on any surface**

Fixture: area `InhArea` (tagged `Alfa`), project `InhProj` in it (tagged `Tango`), a heading `InhHeading` (created via the `things:///json` add-project payload, HX0) with two heading-nested to-dos `ChildUnderHeading` + `DirectChild` (both `project=NULL, heading=InhHeading`, `type` 0). Heading uuid resolved from `TMTask WHERE type=2`.

| Attempt | Result |
|---|---|
| URL `things:///update?id=<heading>&tags=Victor` | **no `TMTaskTag` row** — silent no-op |
| AppleScript `set tag names of to do id "<heading>" to "Whiskey"` | **no `TMTaskTag` row** |
| GUI: heading render | **no tag affordance** — the project view shows `InhProj`'s `Tango` pill directly under the title, but the heading is just a title + a `…` menu, no pill area |
| GUI: Items ▸ Tags… with a heading in focus | Tags… item exists in the menu but **never enables** for a heading; the heading is not a selectable/taggable element in the content AX tree (rows/static-text search did not locate it, consistent with UIC1 "headings not `things:///show`-selectable") |

The only `TMTaskTag` rows that ever existed for the fixture were `InhProj → Tango`. **Verdict: headings are not taggable** (Mike had never seen it; now confirmed it does not exist). Because no heading tag can exist, **heading→child inheritance is moot**, and our `tagScopeSql` — which has **no clause for a heading's OWN direct tags**, only clauses that inherit the heading's PROJECT and AREA tags down to heading-nested children — is correct by omission.

### (b) GUI inheritance semantics vs our SQL — per axis

Our filter model (`src/read/queries.ts` `tagScopeSql`, 6 EXISTS clauses; `untaggedScopeSql` its negation; `tagWithDescendants` expands the target set with hierarchy descendants):

| Axis | Our SQL | GUI oracle | Match |
|---|---|---|---|
| Direct tag on the item | clause 1 (`TMTaskTag tt.tasks = t.uuid`) | trivially shown | ✅ |
| **Project** tag → child to-do | clause 2 (`tt.tasks = t.project`) | T18 (native UI shows the child under its project's tag filter) | ✅ |
| **Area** tag → direct area item | clause 3 (`TMAreaTag at.areas = t.area`) | T18 (native UI shows the child under its area's tag filter) | ✅ |
| **Area** tag → project's children | clause 4 (`p.uuid = t.project` join area) | T18 (same principle through the project) | ✅ |
| **Heading**-nested child → heading's project tag | clause 5 (`h.uuid = t.heading` join `h.project`'s TMTaskTag) | extends T18 to heading-nested children (whose project link lives on the heading, not `t.project`); **not independently GUI-oracled here** — heading nesting is a DB-only distinction the GUI does not surface, so the child is "in" the project visually | ✅ (by construction; models the same T18 principle) |
| **Heading**-nested child → heading's project's area tag | clause 6 (`h → project → area`'s TMAreaTag) | same as clause 5 | ✅ (by construction) |
| **Tag hierarchy**: parent tag matches child-tagged items | `tagWithDescendants` set expansion (caller side) | documented Things behavior; the code comment already flags it "not lab-oracled" (UI filter clicks aren't automatable). TAGINH1 did not add an independent oracle | ⚠️ modeled = documented; not independently oracled |

**No divergence found.** The two axes never GUI-oracled before (heading-chain clauses 5/6; tag-hierarchy expansion) remain modeled-by-analogy against T18's established principle and Things' documented hierarchy filtering; this campaign did not contradict them. (Direct GUI filter-click observation stays impractical — the filter bar isn't reliably drivable and the heading-chain distinction is DB-only.)

### (c) Current-surface audit (code) — what show/MCP surface for inherited tags today

- **`things show <todo>`** (`src/read/detail.ts:38`) sets `entity.inheritedTags = inheritedTagsFor(...)`; the CLI renders a separate `inherited: #…` line (`src/cli/commands/todo.ts:93`). **Direct tags and inherited tags are distinct lines.**
- **Project card** (`src/read/project-view.ts:66`) likewise sets `project.inheritedTags` and renders an `inherited:` line (`src/cli/commands/project.ts:109`).
- **List views** surface **direct tags only** — the row `tags` field is "Direct tags only — mirrors DB truth" (`src/model/entities.ts:67`); `inheritedTags` is opt-in and computed only for the detail/card renderers.
- **MCP / JSON**: entities carry an additive `inheritedTags?` field (`entities.ts:70`); the detail tool description says tags "(direct and inherited)" (`mcp/server.ts:572`). The `--tag` / `untagged` **filters** honor the full direct+inherited+descendant membership (`tagScopeSql`/`untaggedScopeSql`/`tagWithDescendants`) even though list rows render only direct tags.

`inheritedTagsFor` (`src/read/tags.ts:104`) walks task → heading's project → project → area, collecting each ancestor's direct tags and excluding the item's own — i.e. the same chain as the filter SQL. No rendering changes were made (out of scope).
