/**
 * The read-payload SHAPING transform: the token-economy rules R6 and R7, the
 * universal item-DTO reshapes (R9), and the R10 lifecycle taxonomy — applied at
 * the JSON emit boundary of the read surfaces (the CLI `--json` read envelope,
 * src/cli/read-driver.ts, and the MCP read tool results, src/mcp/server.ts), the
 * same boundaries omit-empty runs at. Shaping runs BEFORE omit-empty. The
 * human-render path keeps the full, unshaped entities, so this is JSON-only.
 *
 * Both R6/R7 are deterministic BY VIEW KIND / SECTION — the emitter knows whether
 * it is inside a single-container view, a lifecycle bucket, or a mixed list —
 * never a per-item heuristic.
 *
 * ## R10 — the `stage` lifecycle taxonomy (every tier, every kind incl. detail)
 * The three former wire fields `start` / `logged` / `trashed` are DELETED from
 * every item and replaced by ONE derived `stage` ∈ `inbox | upcoming | anytime |
 * someday | logbook | trash` (src/read/stage.ts `deriveStage`, the single pure
 * derivation reused by the card bucketing so `stage` can never disagree with the
 * bucket a view puts an item in). Today/evening membership is a SEPARATE
 * presence-keyed axis — `today: true` / `evening: true` (evening implies today) —
 * derived in the mapper with the Today view's own two-arm predicate.
 * - `stage` is DROPPED only where the enclosing node PROVABLY states it — the R6
 *   rule (drop only what the node provably says). That is the stage-PURE flat
 *   views (inbox, `anytime`, someday, logbook, trash) and the stage-named card
 *   sub-buckets (anytime/upcoming/someday/logbook/trash, which the bucketer splits
 *   BY stage). The `anytime` catalogue is stage-PURE (R10.2): every member is an
 *   Anytime-view row (ANYTIME_SELF) — undated-active, arrived-active, or arrived
 *   someday-scheduled — and an ARRIVED dated row derives `anytime` (Upcoming is
 *   STRICTLY FUTURE, UPC1), so the field is redundant there.
 *   `stage` is KEPT on the stage-MIXED or derived surfaces: the `upcoming` view
 *   carries deadline-forecast stage-`anytime`/`someday` rows alongside its
 *   future-dated stage-`upcoming` ones — dropping `stage` there would delete
 *   non-redundant information — plus `today` (mixes upcoming + anytime-deadline
 *   rows), search, changes, the projects/areas listings, the card NODE, and
 *   detail.
 * - the `today`/`evening` markers are DROPPED inside the `today` view's own
 *   sections (the section key states it) and KEPT everywhere else. A logbook/trash
 *   item is never a Today member, so its markers are dropped with it.
 * - the former `todaySection` field is RETIRED from the wire entirely (R10.1):
 *   `todaySection: "evening"` merely duplicated the `evening: true` marker. It
 *   remains an internal entity field (the human render and the write-verify delta
 *   still read it); shaping deletes it from the JSON copy.
 *
 * ## Universal item-DTO reshapes (R9 — EVERY tier, EVERY read kind incl. detail)
 * - **checklist nesting** — flat counts → presence-keyed `checklist: {open,total}`.
 * - **todos counts** — a project's flat leaf-action counts → presence-keyed
 *   `todos: {open, total}` (omit when total 0).
 * - **repeating template/instance split (R11)** — the wire drops the
 *   `isTemplate`/`isInstance` discriminators; key presence carries the fact. A
 *   TEMPLATE keeps a nested `repeating: {nextOccurrence, paused?, deadlined?,
 *   rule?, latestInstance?}` — the complete series object (rule config + forward
 *   pointer + backward pointer + state flags); presence MEANS template;
 *   `nextOccurrence` explicit-null when unprojected; `latestInstance` is
 *   detail-only (SL1). An INSTANCE keeps a flat `instanceOf: <templateUuid>` and
 *   no `repeating`. A plain row keeps neither. See {@link reshapeRepeatingWire}.
 * - **string tags** — `tags`/`inheritedTags` become plain arrays of names.
 * - **one project key** — a headed item's owning project (formerly
 *   `headingProject`) is merged into `project`; `headingProject` never appears.
 *
 * ## R6 — no-redundant-ancestry (both tiers)
 * project-view children drop `project`+`area` (heading-group members also drop
 * `heading`); area-view children/project-cards drop `area`; anytime/someday
 * section items drop `area`. Mixed lists keep every ref. (In the COMPACT tier the
 * `heading` ref is additionally dropped everywhere — R7.)
 *
 * ## R7 — named detail tiers (compact | full)
 * List contexts default to COMPACT; `detail`/`show` and `--full` / `full:true`
 * use FULL. Compact drops `created`/`modified`, the full `notes` string (a
 * presence-keyed `hasNotes: true` marks a row with notes), and the `heading` ref;
 * `status` is omitted when `open`. FULL keeps them but still applies R6, the
 * universal reshapes, and R10.
 */
import { deriveStage } from "./stage.ts";

type Obj = Record<string, unknown>;

/** What a given view context drops from an item: redundant ancestry + R10 bucket/marker implications. */
interface ItemDrop {
  project?: boolean;
  area?: boolean;
  heading?: boolean;
  /** Drop the `stage` field — the enclosing view/section states it. */
  stage?: boolean;
  /** Drop the `today`/`evening` markers — the today view's section key states them. */
  markers?: boolean;
}

/**
 * Fold the flat `tags` / `inheritedTags` arrays of `{title}` objects into plain
 * arrays of tag NAMES (universal across tiers and kinds). Tag uuids were never
 * on the wire; the title is the identity. A missing key is left missing; an
 * empty array stays `[]` (omit-empty prunes it later).
 */
function flattenTags(o: Obj): void {
  for (const key of ["tags", "inheritedTags"]) {
    const v = o[key];
    if (!Array.isArray(v)) continue;
    o[key] = v.map((t) =>
      t !== null && typeof t === "object" && "title" in (t as Obj) ? (t as Obj)["title"] : t,
    );
  }
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
 * Reshape a project's flat leaf-action counts into ONE presence-keyed `todos`
 * object — universal across tiers and kinds, mirroring {@link reshapeChecklist}.
 * The source columns are the app-maintained materialized child counts
 * (`untrashedLeafActionsCount` / `openUntrashedLeafActionsCount`), which count
 * to-do children only (headings and checklist items excluded by construction).
 * No to-do children (total 0) → the `todos` key is absent entirely; otherwise
 * `{open, total}`. A no-op on to-dos (they carry no such columns).
 */
function reshapeTodos(o: Obj): void {
  const total =
    typeof o["untrashedLeafActionsCount"] === "number"
      ? (o["untrashedLeafActionsCount"] as number)
      : 0;
  const open =
    typeof o["openUntrashedLeafActionsCount"] === "number"
      ? (o["openUntrashedLeafActionsCount"] as number)
      : 0;
  delete o["untrashedLeafActionsCount"];
  delete o["openUntrashedLeafActionsCount"];
  if (total === 0) return; // presence-keyed: no to-do children → omit the key
  o["todos"] = { open, total };
}

/**
 * R11 — rewrite the internal `repeating` block into the wire's template/instance
 * split, mutating `o` in place. The internal entity carries the full
 * RepeatingInfo (`isTemplate`/`isInstance`/`templateUuid`/…); the wire loses the
 * `isTemplate`/`isInstance` discriminators entirely and instead lets KEY
 * PRESENCE carry the fact:
 *
 * - **Template** (`isTemplate`) → a nested `repeating` object — the complete
 *   series state: `{nextOccurrence, paused?, deadlined?, rule?, latestInstance?}`.
 *   Presence of `repeating` MEANS template. The inner false booleans are
 *   default-pruned (presence-keyed); `nextOccurrence` stays an EXPLICIT null when
 *   there is no projected date (paused / after-completion — the `area: null`
 *   section precedent, since absence would be ambiguous). `rule` and
 *   `latestInstance` are detail-only (populated by src/read/detail.ts on
 *   `entity.repeating`); `latestInstance` is the backward pointer symmetric to the
 *   forward `nextOccurrence`. The nested object is not a recognized entity, so
 *   omit-empty does NOT prune its `nextOccurrence: null`.
 * - **Instance** (`isInstance`) → a flat presence-keyed `instanceOf:
 *   <templateUuid>` and NO `repeating` object. Presence of `instanceOf` MEANS
 *   instance.
 * - **Plain** (neither) → neither key.
 */
function reshapeRepeatingWire(o: Obj): void {
  const rep = o["repeating"];
  delete o["repeating"];
  if (rep === null || typeof rep !== "object") return;
  const r = rep as Obj;
  if (r["isTemplate"] === true) {
    const out: Obj = { nextOccurrence: r["nextOccurrence"] ?? null }; // explicit null
    if (r["paused"] === true) out["paused"] = true;
    if (r["deadlined"] === true) out["deadlined"] = true;
    if (r["rule"] != null) out["rule"] = r["rule"]; // detail read only
    // The SL1 "Show Latest" pick — detail-only; nested inside `repeating` so the
    // object is the complete series state (rule config + forward pointer
    // `nextOccurrence` + backward pointer `latestInstance` + state flags).
    if (typeof r["latestInstance"] === "string") out["latestInstance"] = r["latestInstance"];
    o["repeating"] = out;
  } else if (r["isInstance"] === true) {
    if (typeof r["templateUuid"] === "string") o["instanceOf"] = r["templateUuid"];
  }
}

/** The R10 stage input read straight off a materialized task entity. */
function stageOf(s: Obj): ReturnType<typeof deriveStage> {
  const repeating = s["repeating"];
  const isTemplate =
    repeating !== null &&
    typeof repeating === "object" &&
    (repeating as Obj)["isTemplate"] === true;
  return deriveStage({
    trashed: s["trashed"] === true,
    logged: s["logged"] === true,
    start: s["start"] as "inbox" | "active" | "someday",
    startDate: (s["startDate"] as string | null) ?? null,
    repeating: { isTemplate },
    // The presence-keyed Today marker (stamped at materialize with the response
    // clock) discriminates an ARRIVED dated row (→ anytime) from a strictly-
    // future one (→ upcoming). Read BEFORE the marker is stripped downstream.
    today: s["today"] === true,
  });
}

/**
 * Shape ONE task entity (to-do or project): the universal reshapes, the R10
 * stage/marker rewrite, then the R6 ancestry drops, then — when `compact` — the
 * R7 default-pruning. A shallow copy is taken so unknown sibling keys
 * (`changeKind` on a changes row, `match` on a search hit) pass through
 * untouched. Non-task values (areas, tags, refs, headings) are returned as-is.
 */
function shapeItem(src: unknown, drop: ItemDrop, compact: boolean): unknown {
  if (src === null || typeof src !== "object") return src;
  const s = src as Obj;
  const type = s["type"];
  if (type !== "to-do" && type !== "project") return src; // not a shaped entity
  const stage = stageOf(s); // from the ORIGINAL fields, before any reshape
  const o: Obj = { ...s };

  // R9 universal reshapes (every tier, every kind incl. detail).
  reshapeChecklist(o);
  reshapeTodos(o);
  flattenTags(o);
  reshapeRepeatingWire(o);
  if (o["project"] == null && o["headingProject"] != null) o["project"] = o["headingProject"];
  delete o["headingProject"];

  // R10 — the three lifecycle fields are replaced by the one derived `stage`.
  delete o["start"];
  delete o["logged"];
  delete o["trashed"];
  // R10.1 — `todaySection` is retired from the wire (it duplicated `evening`);
  // the internal entity keeps it for the render / write-verify paths.
  delete o["todaySection"];
  if (drop.stage !== true) o["stage"] = stage;
  // Today/evening markers: dropped where the section states them, and never on a
  // logbook/trash row (which is not a Today member).
  if (drop.markers === true || stage === "logbook" || stage === "trash") {
    delete o["today"];
    delete o["evening"];
  }

  // R6 — drop redundant ancestry (both tiers).
  if (drop.project === true) delete o["project"];
  if (drop.area === true) delete o["area"];
  if (drop.heading === true) delete o["heading"];

  if (!compact) return o;

  // R7 compact — default-pruning (absence = the default).
  if (o["status"] === "open") delete o["status"];
  delete o["created"];
  delete o["modified"];
  const notes = typeof o["notes"] === "string" ? (o["notes"] as string) : "";
  delete o["notes"];
  if (notes !== "") o["hasNotes"] = true;
  // The heading ref is compact-dropped everywhere (the GUI shows the project,
  // never the heading, outside a project view). Full tier / detail keep it.
  delete o["heading"];
  return o;
}

/** Map a plain array of items with the item shaper. */
function shapeList(items: unknown, drop: ItemDrop, compact: boolean): unknown {
  if (!Array.isArray(items)) return items;
  return items.map((i) => shapeItem(i, drop, compact));
}

/** Copy `base` and overwrite `items` with the shaped list (avoids spread-in-map). */
function withShapedItems(base: Obj, drop: ItemDrop, compact: boolean): Obj {
  const out: Obj = { ...base };
  out["items"] = shapeList(base["items"], drop, compact);
  return out;
}

/** A child entity carrying the fields the R10 re-bucketer needs. */
interface Child extends Obj {
  startDate?: string | null;
  todayIndex?: number;
}

/** An IsoDate group on the wire — `date` is a real string, or `null` for the resting-templates group. */
interface WireDateGroup {
  date: string | null;
  items: unknown[];
}

/**
 * Re-bucket a project's / area's / heading's live (non-logbook/trash) children
 * into the R10 card shape by their derived {@link deriveStage} — so the bucket an
 * item lands in ALWAYS equals its `stage`:
 * - `anytime` — stage anytime, in encounter order;
 * - `upcoming` — stage upcoming, date-grouped `[{date, items}]` (a dated row under
 *   its `startDate`, a template under its `nextOccurrence`), date ASC; date-LESS
 *   templates (after-completion / paused) form a trailing `{date: null, items}`
 *   group (explicit null per the `area: null` section precedent);
 * - `someday` — stage someday.
 * Items are already in view order (index / date+todayIndex) from the read layer,
 * so encounter order within a date group preserves that ordering. Each item is
 * then run through {@link shapeItem} with the section drop (ancestry + `stage`,
 * since the bucket states it).
 */
function rebucketChildren(
  children: unknown[],
  drop: ItemDrop,
  compact: boolean,
): { anytime: unknown[]; upcoming: WireDateGroup[]; someday: unknown[] } {
  const anytime: unknown[] = [];
  const someday: unknown[] = [];
  const datedByKey = new Map<string, unknown[]>();
  const datedOrder: string[] = [];
  const restingTemplates: unknown[] = [];
  const shape = (c: unknown) => shapeItem(c, drop, compact);
  for (const raw of children) {
    if (raw === null || typeof raw !== "object") continue;
    const c = raw as Child;
    const stage = stageOf(c);
    if (stage === "anytime") {
      anytime.push(shape(c));
    } else if (stage === "someday") {
      someday.push(shape(c));
    } else if (stage === "upcoming") {
      const repeating = c["repeating"] as Obj | undefined;
      const nextOcc =
        repeating != null && typeof repeating === "object"
          ? ((repeating["nextOccurrence"] as string | null | undefined) ?? null)
          : null;
      const date = (c.startDate ?? null) !== null ? c.startDate! : nextOcc;
      if (date === null) {
        restingTemplates.push(shape(c));
      } else {
        if (!datedByKey.has(date)) {
          datedByKey.set(date, []);
          datedOrder.push(date);
        }
        datedByKey.get(date)!.push(shape(c));
      }
    } else {
      // inbox / logbook / trash should not appear among a card's live children;
      // route defensively to anytime rather than drop the row.
      anytime.push(shape(c));
    }
  }
  const upcoming: WireDateGroup[] = datedOrder
    .toSorted((a, b) => a.localeCompare(b))
    .map((date) => ({ date, items: datedByKey.get(date)! }));
  if (restingTemplates.length > 0) upcoming.push({ date: null, items: restingTemplates });
  return { anytime, upcoming, someday };
}

/** Flatten an internal IsoDateGroup[] (`[{date, items}]`) to its items, in order. */
function flattenGroups(groups: unknown): unknown[] {
  if (!Array.isArray(groups)) return [];
  const out: unknown[] = [];
  for (const g of groups) {
    if (g !== null && typeof g === "object" && Array.isArray((g as Obj)["items"])) {
      out.push(...((g as Obj)["items"] as unknown[]));
    }
  }
  return out;
}

/** Coerce an unknown value to an array (empty when absent). */
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The R6 ref drop for every child bucket of a project view (unheaded members). */
const PROJECT_CHILD_DROP: ItemDrop = { project: true, area: true, stage: true };
/** Heading-group members drop the heading ref too (the group states it). */
const HEADING_MEMBER_DROP: ItemDrop = { project: true, area: true, heading: true, stage: true };
/** Area-view child-item buckets drop their area (the card states it) + the bucket-implied stage. */
const AREA_CHILD_DROP: ItemDrop = { area: true, stage: true };
/** Area-view PROJECTS list: a mixed listing of the area's project rows — keep `stage`, drop area. */
const AREA_PROJECTS_DROP: ItemDrop = { area: true };
/**
 * Anytime sidebar-section items: stage-PURE → drop area + the section-implied
 * stage (R10.2). Every Anytime-view member (ANYTIME_SELF: undated-active,
 * arrived-active, arrived someday-scheduled) derives `anytime` — an ARRIVED
 * dated row is Anytime, not Upcoming (Upcoming is STRICTLY FUTURE, UPC1) — and
 * repeating templates are excluded from the view (NOT_TEMPLATE), so no
 * stage-`upcoming` row can appear here.
 */
const ANYTIME_SECTION_DROP: ItemDrop = { area: true, stage: true };
/** Someday sidebar-section items: stage-PURE → drop area + the bucket-implied stage. */
const SOMEDAY_SECTION_DROP: ItemDrop = { area: true, stage: true };
/** The card NODE / detail / mixed lists: keep every ref, `stage`, and markers. */
const NO_DROP: ItemDrop = {};
/** The today view's own sections: keep `stage` (mixed), drop the section-implied markers. */
const TODAY_SECTION_DROP: ItemDrop = { markers: true };

/** Shape every collection bucket of a project view; the card node is left full + ancestry-intact. */
function shapeProjectView(view: Obj, compact: boolean): Obj {
  const cd = PROJECT_CHILD_DROP;
  const hd = HEADING_MEMBER_DROP;
  const shapeHeadingGroup = (g: unknown): unknown => {
    if (g === null || typeof g !== "object") return g;
    const grp = g as Obj;
    const out: Obj = {};
    // The heading NODE itself drops its `project` ref — the card states it.
    if (grp["heading"] !== null && typeof grp["heading"] === "object") {
      const h = { ...(grp["heading"] as Obj) };
      delete h["project"];
      out["heading"] = h;
    } else {
      out["heading"] = grp["heading"];
    }
    const members = [
      ...asArray(grp["items"]),
      ...flattenGroups(grp["scheduled"]),
      ...asArray(grp["someday"]),
      ...asArray(grp["repeating"]),
    ];
    const { anytime, upcoming, someday } = rebucketChildren(members, hd, compact);
    out["anytime"] = anytime;
    out["upcoming"] = upcoming;
    out["someday"] = someday;
    return out;
  };
  const headings = Array.isArray(view["headings"])
    ? (view["headings"] as unknown[]).map(shapeHeadingGroup)
    : view["headings"];
  const looseMembers = [
    ...asArray(view["active"]),
    ...flattenGroups(view["scheduled"]),
    ...asArray(view["someday"]),
    ...asArray(view["repeating"]),
  ];
  const { anytime, upcoming, someday } = rebucketChildren(looseMembers, cd, compact);
  const out: Obj = { ...view };
  delete out["active"];
  delete out["scheduled"];
  delete out["repeating"];
  delete out["logged"];
  delete out["trashed"];
  // The project card NODE keeps everything (children derive their container from
  // it), but is still an item DTO, so the universal + R10 reshapes apply.
  out["project"] = shapeItem(view["project"], NO_DROP, false);
  out["anytime"] = anytime;
  out["upcoming"] = upcoming;
  out["someday"] = someday;
  out["headings"] = headings;
  out["logbook"] = shapeList(view["logged"], cd, compact);
  out["trash"] = shapeList(view["trashed"], cd, compact);
  return out;
}

/** Shape every collection bucket of an area view; the area node keeps its identity (tags folded). */
function shapeAreaView(view: Obj, compact: boolean): Obj {
  const looseMembers = [
    ...asArray(view["active"]),
    ...flattenGroups(view["scheduled"]),
    ...asArray(view["someday"]),
    ...asArray(view["repeating"]),
  ];
  const { anytime, upcoming, someday } = rebucketChildren(looseMembers, AREA_CHILD_DROP, compact);
  const out: Obj = { ...view };
  delete out["active"];
  delete out["scheduled"];
  delete out["repeating"];
  delete out["logged"];
  delete out["trashed"];
  out["area"] = shapeArea(view["area"]);
  out["anytime"] = anytime;
  // The projects list is a mixed listing of the area's project rows — keep stage.
  out["projects"] = shapeList(view["projects"], AREA_PROJECTS_DROP, compact);
  out["upcoming"] = upcoming;
  out["someday"] = someday;
  out["logbook"] = shapeList(view["logged"], AREA_CHILD_DROP, compact);
  out["trash"] = shapeList(view["trashed"], AREA_CHILD_DROP, compact);
  return out;
}

/** Fold an area entity's tags to string names in place (returns a shallow copy). */
function shapeArea(src: unknown): unknown {
  if (src === null || typeof src !== "object") return src;
  const o: Obj = { ...(src as Obj) };
  flattenTags(o);
  return o;
}

/** Shape the today/evening split (mixed list — keep refs + stage; drop the section-implied markers). */
function shapeTodayView(view: Obj, compact: boolean): Obj {
  return {
    ...view,
    today: shapeList(view["today"], TODAY_SECTION_DROP, compact),
    evening: shapeList(view["evening"], TODAY_SECTION_DROP, compact),
  };
}

/** Shape sidebar sections (anytime/someday catalogues) with the section's drop spec. */
function shapeSections(sections: unknown, drop: ItemDrop, compact: boolean): unknown {
  if (!Array.isArray(sections)) return sections;
  return sections.map((s) =>
    s === null || typeof s !== "object" ? s : withShapedItems(s as Obj, drop, compact),
  );
}

/**
 * The flat, mixed-provenance list kinds mapped to their drop spec. Only the
 * stage-PURE catalogues (inbox/someday/logbook/trash; the section-based `anytime`
 * is pure too, handled via shapeSections below) drop the bucket-implied `stage`.
 * `upcoming` KEEPS it (R10.2): the Upcoming view is stage-mixed — it carries
 * deadline-forecast stage-`anytime`/`someday` rows alongside future-dated
 * stage-`upcoming` ones. The mixed/derived surfaces (search/changes/projects)
 * keep it too.
 */
const FLAT_LIST_DROP: ReadonlyMap<string, ItemDrop> = new Map([
  ["inbox", { stage: true }],
  ["upcoming", NO_DROP],
  ["logbook", { stage: true }],
  ["trash", { stage: true }],
  ["changes", NO_DROP],
  ["search", NO_DROP],
  ["projects", NO_DROP],
]);

/**
 * Apply the universal reshapes + R6 + R7 + R10 to a read payload for one view
 * `kind`. `full` forces the FULL tier (R7 default-pruning off, everything else
 * applied); an unrecognized kind passes through unchanged. The input is never
 * mutated (shallow copies throughout), so the human-render path keeps the full
 * entities.
 */
export function shapeReadPayload(kind: string, data: unknown, full: boolean): unknown {
  // `detail` is the FULL record and drops no ancestry / stage / markers.
  if (kind === "detail") return shapeItem(data, NO_DROP, false);
  const compact = !full;
  const flatDrop = FLAT_LIST_DROP.get(kind);
  if (flatDrop !== undefined) return shapeList(data, flatDrop, compact);
  if (kind === "today" && data !== null && typeof data === "object") {
    return shapeTodayView(data as Obj, compact);
  }
  if (kind === "anytime" && Array.isArray(data)) {
    return shapeSections(data, ANYTIME_SECTION_DROP, compact); // stage-pure → drop stage
  }
  if (kind === "someday" && Array.isArray(data)) {
    return shapeSections(data, SOMEDAY_SECTION_DROP, compact); // stage-pure → drop stage
  }
  if (kind === "area-view" && data !== null && typeof data === "object") {
    return shapeAreaView(data as Obj, compact);
  }
  if (kind === "project-view" && data !== null && typeof data === "object") {
    return shapeProjectView(data as Obj, compact);
  }
  // The `areas` listing carries Area entities whose tags fold to names.
  if (kind === "areas" && Array.isArray(data)) return data.map(shapeArea);
  // tags / legend / snapshot / diagnostics: not tag-carrying entity payloads.
  return data;
}
