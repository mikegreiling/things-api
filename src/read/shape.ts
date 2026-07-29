/**
 * The read-payload SHAPING transform: the token-economy rules R6 and R7 (plus
 * the two universal item-DTO reshapes they ride with), applied at the JSON emit
 * boundary of the read surfaces — the CLI `--json` read envelope
 * (src/cli/read-driver.ts) and the MCP read tool results (src/mcp/server.ts),
 * the same two boundaries omit-empty runs at. Shaping runs BEFORE omit-empty: it
 * prunes redundant-but-nonempty facts (R6), reshapes the checklist + repeating
 * fields, and reduces list rows to the compact tier (R7); omit-empty then prunes
 * whatever is left empty. The human-render path keeps the full, unshaped
 * entities, so this is JSON-only.
 *
 * Both rules are deterministic BY VIEW KIND / SECTION — the emitter knows
 * whether it is inside a single-container view, a lifecycle bucket, or a mixed
 * list — never a per-item heuristic.
 *
 * ## Universal item-DTO reshapes (EVERY tier, EVERY read kind incl. `detail`)
 * - **checklist nesting** — the flat `checklistItemsCount` / `openChecklistItemsCount`
 *   are removed from the wire; an item with a checklist carries
 *   `checklist: {open, total}` (presence-keyed — no key at all when there is no
 *   checklist), and a `detail` read that also carries the items nests them at
 *   `checklist.items`.
 * - **repeating omission** — the all-false `repeating` block (a normal,
 *   non-repeating row) is dropped entirely; a real template/instance keeps a
 *   minimal truthful object (only its true booleans and non-null values).
 *
 * ## R6 — no-redundant-ancestry (both tiers)
 * An item never states a fact its enclosing node already states:
 * - **project-view**: every child (in ANY bucket, incl. heading-group members)
 *   drops `project`/`headingProject` and `area` — the project card states both.
 *   Heading-group members additionally drop `heading`. The project CARD keeps
 *   everything (it is the enclosing node children derive from).
 * - **area-view**: every child item and project card drops `area` — the area
 *   card states it. Project-child items keep `project`.
 * - **anytime/someday sections** (`{area, items}`): items drop `area` (including
 *   the explicit `area: null` section); they keep `project`/`heading`.
 * - **detail** and the mixed-provenance lists (inbox, today, upcoming, search,
 *   changes, projects) keep ALL refs.
 *
 * ### Bucket-implied lifecycle flags (both tiers)
 * `logged` / `trashed` are dropped even when TRUE wherever the enclosing view or
 * section states them: the `trash` view (trashed), the `logbook` view (logged),
 * and the `logged` / `trashed` section arrays of the area/project cards. They
 * SURVIVE (when true) on mixed surfaces — search, changes — where a logged or
 * trashed row sits beside live ones and the flag disambiguates. Combined with
 * compact default-pruning (false → omitted) the flags appear ONLY where they
 * carry information.
 *
 * The dropped ancestry fact is provably equal to the enclosing node's fact: the
 * entity's `area` is the EFFECTIVE area (queries.ts `EFFECTIVE_AREA` — own area,
 * else the project's, else the heading's project's), and a project/heading child
 * carries `area = NULL` in the DB (the documented invariant), so its effective
 * area resolves THROUGH the container to exactly the card's area. The sidebar
 * grouper (sidebar-order.ts) buckets by that same effective area. No
 * non-redundant information is deleted.
 *
 * ## R7 — named detail tiers (compact | full)
 * List contexts default to COMPACT; `detail`/`show` and a `--full` / `full:true`
 * request use FULL. Compact is ONE uniform rule — identity + structural facts +
 * non-default facts — layered on TOP of the universal reshapes and R6:
 * - always `uuid`, `title`, `type`, `start`, plus the omit-empty structural
 *   facts (`startDate`, `deadline`, `reminder`, `todaySection`, `stopped`,
 *   `tags`) and the container refs R6 left in place;
 * - default-pruned (absence = the default): `status` (`"open"`), `logged`
 *   (`false`), `trashed` (`false`);
 * - always dropped: `created`, `modified` (get them from `detail`);
 * - `notes` becomes its first line truncated to 120 chars, with a sibling
 *   `notesTruncated: true` present iff that preview differs from the full notes.
 *
 * The FULL tier keeps `created`/`modified`, full `notes`, and the default-valued
 * `status`/`logged`/`trashed` — but still applies R6 (ancestry redundancy is not
 * tier-dependent), the two universal reshapes, and the bucket-implied lifecycle
 * drops.
 */

type Obj = Record<string, unknown>;

const NOTES_PREVIEW_MAX = 120;

/** What a given view context drops from an item: redundant ancestry + bucket-implied lifecycle flags. */
interface ItemDrop {
  project?: boolean;
  area?: boolean;
  heading?: boolean;
  /** Drop `logged` even when true — the enclosing view/section states it. */
  logged?: boolean;
  /** Drop `trashed` even when true — the enclosing view/section states it. */
  trashed?: boolean;
}

/** The R7 compact default-pruning of the notes field. */
function compactNotes(o: Obj): void {
  const full = typeof o["notes"] === "string" ? (o["notes"] as string) : "";
  if (full === "") return; // omit-empty drops it; nothing to preview
  const firstLine = full.split("\n", 1)[0] ?? "";
  const preview =
    firstLine.length > NOTES_PREVIEW_MAX ? firstLine.slice(0, NOTES_PREVIEW_MAX) : firstLine;
  o["notes"] = preview;
  // Presence-keyed marker: present ONLY when the preview hides something.
  if (preview !== full) o["notesTruncated"] = true;
}

/**
 * Reshape the flat checklist counts (and, on a `detail` read, the items array)
 * into ONE presence-keyed `checklist` object — universal across tiers and kinds.
 * No checklist → the `checklist` key is absent entirely; otherwise
 * `{open, total}`, plus `items` when the source carried them (detail reads).
 */
function reshapeChecklist(o: Obj): void {
  const total =
    typeof o["checklistItemsCount"] === "number" ? (o["checklistItemsCount"] as number) : 0;
  const open =
    typeof o["openChecklistItemsCount"] === "number" ? (o["openChecklistItemsCount"] as number) : 0;
  const items = o["checklist"]; // ChecklistItem[] on a detail read; absent on list rows
  delete o["checklistItemsCount"];
  delete o["openChecklistItemsCount"];
  delete o["checklist"];
  const hasItems = Array.isArray(items) && items.length > 0;
  if (total === 0 && !hasItems) return; // no checklist → omit the key
  const cl: Obj = { open, total };
  if (Array.isArray(items)) cl["items"] = items;
  o["checklist"] = cl;
}

/**
 * Reduce a `repeating` block to its minimal truthful object (universal across
 * tiers): the all-false block (a normal, non-repeating row) is dropped; a real
 * template/instance keeps only its true booleans and non-null values. Returns
 * the minimal object, or undefined when the whole block should be omitted.
 */
function reshapeRepeating(rep: unknown): Obj | undefined {
  if (rep === null || typeof rep !== "object") return undefined;
  const r = rep as Obj;
  const isTemplate = r["isTemplate"] === true;
  const isInstance = r["isInstance"] === true;
  if (!isTemplate && !isInstance) return undefined; // all-false → omit
  const out: Obj = {};
  if (isTemplate) out["isTemplate"] = true;
  if (isInstance) out["isInstance"] = true;
  if (typeof r["templateUuid"] === "string") out["templateUuid"] = r["templateUuid"];
  if (r["nextOccurrence"] != null) out["nextOccurrence"] = r["nextOccurrence"];
  if (r["paused"] === true) out["paused"] = true;
  if (r["deadlined"] === true) out["deadlined"] = true;
  if (r["rule"] != null) out["rule"] = r["rule"];
  return out;
}

/**
 * Shape ONE task entity (to-do or project): the universal reshapes, then the R6
 * ancestry + bucket-implied lifecycle drops, then — when `compact` — the R7
 * default-pruning. A shallow copy is taken so unknown sibling keys (`changeKind`
 * on a changes row, `match` on a search hit) pass through untouched.
 * Non-task values (areas, tags, refs, headings) are returned as-is.
 */
function shapeItem(src: unknown, drop: ItemDrop, compact: boolean): unknown {
  if (src === null || typeof src !== "object") return src;
  const s = src as Obj;
  const type = s["type"];
  if (type !== "to-do" && type !== "project") return src; // not a shaped entity
  const o: Obj = { ...s };

  // Universal reshapes (every tier, every kind incl. detail).
  reshapeChecklist(o);
  const rep = reshapeRepeating(o["repeating"]);
  if (rep === undefined) delete o["repeating"];
  else o["repeating"] = rep;

  // R6 — drop redundant ancestry (both tiers).
  if (drop.project === true) {
    delete o["project"];
    delete o["headingProject"];
  }
  if (drop.area === true) delete o["area"];
  if (drop.heading === true) delete o["heading"];
  // Bucket-implied lifecycle: drop even when TRUE (both tiers).
  if (drop.logged === true) delete o["logged"];
  if (drop.trashed === true) delete o["trashed"];

  if (!compact) return o;

  // R7 compact — default-pruning (absence = the default).
  if (o["status"] === "open") delete o["status"];
  if (o["logged"] === false) delete o["logged"];
  if (o["trashed"] === false) delete o["trashed"];
  // A project row keeps its child-count fields, omit-0 (a `0` count is the
  // default, so absence carries it — mirroring the checklist-object omission).
  if (o["untrashedLeafActionsCount"] === 0) delete o["untrashedLeafActionsCount"];
  if (o["openUntrashedLeafActionsCount"] === 0) delete o["openUntrashedLeafActionsCount"];
  delete o["created"];
  delete o["modified"];
  compactNotes(o);
  return o;
}

/** Copy `base` and overwrite `items` with the shaped list (avoids spread-in-map). */
function withShapedItems(base: Obj, drop: ItemDrop, compact: boolean): Obj {
  const out: Obj = { ...base };
  out["items"] = shapeList(base["items"], drop, compact);
  return out;
}

/** Map an IsoDateGroup's items with the item shaper, preserving `date`. */
function shapeDateGroups(groups: unknown, drop: ItemDrop, compact: boolean): unknown {
  if (!Array.isArray(groups)) return groups;
  return groups.map((g) =>
    g === null || typeof g !== "object" ? g : withShapedItems(g as Obj, drop, compact),
  );
}

/** Map a plain array of items with the item shaper. */
function shapeList(items: unknown, drop: ItemDrop, compact: boolean): unknown {
  if (!Array.isArray(items)) return items;
  return items.map((i) => shapeItem(i, drop, compact));
}

/** Merge two drop specs (bucket-implied lifecycle onto the base ancestry drop). */
function withDrop(base: ItemDrop, extra: ItemDrop): ItemDrop {
  return { ...base, ...extra };
}

/** The R6 ref drop for every child bucket of a project view (unheaded members). */
const PROJECT_CHILD_DROP: ItemDrop = { project: true, area: true };
/** Heading-group members drop the heading ref too (the group states it). */
const HEADING_MEMBER_DROP: ItemDrop = { project: true, area: true, heading: true };
/** Area-view children/project-cards drop only their area (the card states it). */
const AREA_CHILD_DROP: ItemDrop = { area: true };
/** Sidebar-section items drop only their area (the section states it). */
const SECTION_DROP: ItemDrop = { area: true };
/** Mixed-provenance lists keep every ref. */
const NO_DROP: ItemDrop = {};

/** Shape every collection bucket of a project view; the card is left untouched (full, enclosing node). */
function shapeProjectView(view: Obj, compact: boolean): Obj {
  const cd = PROJECT_CHILD_DROP;
  const hd = HEADING_MEMBER_DROP;
  const shapeHeadingGroup = (g: unknown): unknown => {
    if (g === null || typeof g !== "object") return g;
    const grp = g as Obj;
    const out: Obj = { ...grp };
    // The heading NODE itself also drops its `project` ref — the enclosing
    // project card states it (same R6 rule its members follow).
    if (grp["heading"] !== null && typeof grp["heading"] === "object") {
      const h = { ...(grp["heading"] as Obj) };
      delete h["project"];
      out["heading"] = h;
    }
    out["items"] = shapeList(grp["items"], hd, compact);
    out["scheduled"] = shapeDateGroups(grp["scheduled"], hd, compact);
    out["someday"] = shapeList(grp["someday"], hd, compact);
    out["repeating"] = shapeList(grp["repeating"], hd, compact);
    return out;
  };
  const headings = Array.isArray(view["headings"])
    ? (view["headings"] as unknown[]).map(shapeHeadingGroup)
    : view["headings"];
  return {
    ...view,
    // The project card is the enclosing node — kept FULL and ancestry-intact
    // (children derive their container from it), but it is still an item DTO, so
    // the two universal reshapes (checklist nesting, repeating omission) apply.
    project: shapeItem(view["project"], NO_DROP, false),
    active: shapeList(view["active"], cd, compact),
    headings,
    scheduled: shapeDateGroups(view["scheduled"], cd, compact),
    someday: shapeList(view["someday"], cd, compact),
    repeating: shapeList(view["repeating"], cd, compact),
    // The card's own `logged`/`trashed` buckets state that fact for their rows.
    logged: shapeList(view["logged"], withDrop(cd, { logged: true }), compact),
    trashed: shapeList(view["trashed"], withDrop(cd, { trashed: true }), compact),
  };
}

/** Shape every collection bucket of an area view; the area card is left untouched. */
function shapeAreaView(view: Obj, compact: boolean): Obj {
  const d = AREA_CHILD_DROP;
  return {
    ...view,
    active: shapeList(view["active"], d, compact),
    projects: shapeList(view["projects"], d, compact),
    scheduled: shapeDateGroups(view["scheduled"], d, compact),
    someday: shapeList(view["someday"], d, compact),
    repeating: shapeList(view["repeating"], d, compact),
    logged: shapeList(view["logged"], withDrop(d, { logged: true }), compact),
    trashed: shapeList(view["trashed"], withDrop(d, { trashed: true }), compact),
  };
}

/** Shape the today/evening split (mixed list — keep all refs). */
function shapeTodayView(view: Obj, compact: boolean): Obj {
  return {
    ...view,
    today: shapeList(view["today"], NO_DROP, compact),
    evening: shapeList(view["evening"], NO_DROP, compact),
  };
}

/** Shape sidebar sections (anytime/someday): drop `area` from items, keep the section's own `area`. */
function shapeSections(sections: unknown, compact: boolean): unknown {
  if (!Array.isArray(sections)) return sections;
  return sections.map((s) =>
    s === null || typeof s !== "object" ? s : withShapedItems(s as Obj, SECTION_DROP, compact),
  );
}

/**
 * The flat, mixed-provenance list kinds, mapped to the lifecycle flag their view
 * states (so a whole-view bucket like `trash`/`logbook` drops the implied flag,
 * while `search`/`changes` keep it to disambiguate a logged/trashed row).
 */
const FLAT_LIST_DROP: ReadonlyMap<string, ItemDrop> = new Map([
  ["inbox", NO_DROP],
  ["upcoming", NO_DROP],
  ["changes", NO_DROP],
  ["search", NO_DROP],
  ["projects", NO_DROP],
  ["trash", { trashed: true }],
  ["logbook", { logged: true }],
]);

/**
 * Apply the universal reshapes + R6 + R7 to a read payload for one view `kind`.
 * `full` forces the FULL tier (R7 default-pruning off, everything else applied);
 * an unrecognized kind passes through unchanged. The input is never mutated
 * (shallow copies throughout), so the human-render path keeps the full entities.
 */
export function shapeReadPayload(kind: string, data: unknown, full: boolean): unknown {
  // `detail` is the FULL record and drops no ancestry — but still gets the two
  // universal reshapes (checklist nesting, repeating omission).
  if (kind === "detail") return shapeItem(data, NO_DROP, false);
  const compact = !full;
  const flatDrop = FLAT_LIST_DROP.get(kind);
  if (flatDrop !== undefined) return shapeList(data, flatDrop, compact);
  if (kind === "today" && data !== null && typeof data === "object") {
    return shapeTodayView(data as Obj, compact);
  }
  if ((kind === "anytime" || kind === "someday") && Array.isArray(data)) {
    return shapeSections(data, compact);
  }
  if (kind === "area-view" && data !== null && typeof data === "object") {
    return shapeAreaView(data as Obj, compact);
  }
  if (kind === "project-view" && data !== null && typeof data === "object") {
    return shapeProjectView(data as Obj, compact);
  }
  // areas / tags / legend / snapshot / diagnostics: not task-entity payloads.
  return data;
}
