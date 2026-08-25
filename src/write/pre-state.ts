/**
 * Pre-read: everything guards and delta-builders need to know about the
 * world BEFORE a mutation. One read pass, snapshot semantics per statement.
 */
import type { DatabaseSync } from "node:sqlite";

import { encodePackedDate, localToday, type IsoDate } from "../model/dates.ts";
import {
  TEMPLATE_PROJECTION_COLUMNS,
  type TemplateProjectionRow,
  templateProjectionDay,
} from "../model/template-projection.ts";
import type { AnyTask, TaskStatus, TaskType, Todo } from "../model/entities.ts";
import { TASK_STATUS_FROM_DB } from "../model/entities.ts";
import { byUuid } from "../read/detail.ts";
import { logBoundary } from "../read/log-boundary.ts";
import { todayOrderBy } from "../read/predicates.ts";
import { deadNameMatchHint, resolveHeadingRef, resolveNamedRef } from "../read/queries.ts";
import type { ContainerRef, HeadingPlacement, ReorderParams } from "./operations.ts";

export interface ResolvedContainer {
  uuid: string;
  title: string;
}

export interface ContainerResolution {
  resolved: ResolvedContainer | null;
  /** 0 = not found, 1 = ok, >1 = ambiguous title. */
  matches: number;
  /**
   * An honest not-found tail (`resolved === null && matches === 0`) when the NAME
   * matched only non-open destination rows the resolver deliberately excludes —
   * e.g. a completed/canceled project (which would strand an open child, PLOG1).
   * Surfaced by H-UNKNOWN-DESTINATION so the caller learns the row exists and how
   * to reach it (by uuid). Absent when the miss is a genuine no-match.
   */
  deadHint?: string;
}

export interface ReorderMember {
  uuid: string;
  title: string;
  /** Current rank on the scope's ordering key (todayIndex or "index"). */
  rank: number;
  /** Raw startBucket (0 = today, 1 = evening); today/evening scopes only. */
  startBucket: number | null;
  /** 0 = to-do, 1 = project. */
  type: number;
  /**
   * Repeating TEMPLATE row (rt1_recurrenceRule or repeater set). Only the day-block
   * scopes (`day`/`tomorrow`) admit templates as members (their projection is a
   * first-class todayIndex member — TMPLSORT/PTMPL); every other scope's query keeps
   * `NOT_TEMPLATE_ROW`, so this is always false there. The `day`/`tomorrow` dispatch
   * reads it to split the per-class leg family (a TO-DO template rides a single-id
   * `list "Upcoming"`/`list "Tomorrow"` native front-insert; a PROJECT template is
   * byte-untouched under the suffix rule — never a when=/deadline leg, the §1 crash).
   */
  isTemplate: boolean;
}

export interface ReorderPre {
  /** Ordering key the scope ranks on. */
  key: "index" | "todayIndex";
  /** Eligible members in current order (wire-list extension source). */
  members: ReorderMember[];
  /** Requested uuids that are not eligible members, with the reason. */
  rejected: { uuid: string; reason: string }[];
  /** Requested uuids appearing more than once. */
  duplicates: string[];
  /** Requested project-type members (bounce cannot move projects). */
  projectMembers: string[];
  /**
   * Area scope only: the request mixes to-do and project members. Same-type
   * area reorders are validated (O05/O10 to-dos, O14 projects); a mixed wire
   * list is unprobed, so the guard rejects it.
   */
  mixedTypes: boolean;
  /** Full wire list: requested order first, remaining members after. */
  wireList: string[];
  /**
   * TODWIRE — the MINIMAL native `list "Today"` wire (today scope only; null on
   * every other scope). The native reorder re-stamps every NAMED row's
   * `todayIndexReferenceDate → today` and rewrites its `todayIndex`, so the OLD
   * full {@link wireList} fused ALL entry-date cohorts and rewrote the whole
   * visible order on any subset reorder (MOVPLC). The today axis obeys the same
   * partial-wire law as headings — `result = [named in wire order] ++ [unnamed in
   * prior VISIBLE order]` — so the smallest wire realizing the request is
   * `minimalReorderWire(currentVisibleOrder, targetVisibleOrder)` computed on the
   * READER's Today comparator (share {@link todayOrderBy}, one law). The native
   * compile ([commands.ts]) sends THIS; unnamed rows stay byte-untouched, their
   * cohorts intact. Empty wire (request already satisfied) falls back to the full
   * target order so the invocation is concrete (mirrors the heading builder).
   */
  todayWire: string[] | null;
  /**
   * TODWIRE — the current Today VISIBLE order (open bucket-0 members, reader
   * comparator; today scope only, else null). {@link buildReorderOrder} splices an
   * anchored placement against THIS (not the raw `todayIndex` order) so the target
   * is the visible-order target the minimal wire realizes.
   */
  todayVisibleOrder: string[] | null;
  /**
   * TODWIRE disclosure (#V11 pattern) — the NON-movee rows the {@link todayWire}
   * must name to realize a `--before`/`--after`/`--last` placement (the visible
   * prefix down to the insertion point). Re-ranking each re-stamps its
   * `todayIndexReferenceDate → today`, silently collapsing its entry cohort — so
   * the result + `--dry-run` disclose the count. Empty for a `--first`/`--start`
   * wire (names only the movees, which re-stamp inherently — a doc/help note, not
   * a warning). Empty on every non-today scope.
   */
  todayRestampNonMovees: string[];
  /**
   * Requested movees that are UNSWEPT-RESOLVED to-dos ADMITTED as members under
   * the LOGSORT ORD-13 permit (only ever non-empty on the pure-native `index`
   * wire — the exact leg family LOGSORT certified). Carries each row's pre-op
   * `status` (completed/canceled) and host-local `stoppedDate` so the reorder
   * delta can lock the byte-level invariant (index-only, no reopen: status +
   * stoppedDate + umd unchanged). Empty on every non-native / day-axis / swept
   * path, where a resolved movee stays refused.
   */
  resolvedMembers: { uuid: string; status: TaskStatus; stoppedDate: IsoDate | null }[];
}

/** area.delete: live member census of the area (non-trashed direct rows). */
export interface AreaMemberCounts {
  /** Projects whose area FK is this area (trashed = 0). */
  projects: number;
  /** Direct to-dos in the area (trashed = 0, any status). */
  todos: number;
}

export interface PreState {
  /** Primary target for uuid-addressed operations. */
  target: AnyTask | null;
  /**
   * The response clock's local calendar date (guest/host clock), captured at
   * pre-read. Feeds §9n reminder-liveness: the `when=` reminder auto-preserve
   * (commands.ts `effectiveReminder`) gates a STALE reminder byte out against
   * the target's CURRENT startDate under this date, rather than resurrecting a
   * presentation-dead reminder. Defaults to the host today (emptyPreState); the
   * date-bearing update preReads stamp the injected clock.
   */
  todayIso: IsoDate;
  destProject: ContainerResolution | null;
  /** Status of the resolved destination project (reopen hazard, T19). */
  destProjectStatus: TaskStatus | null;
  destArea: ContainerResolution | null;
  /** Heading resolution inside the destination (or target's) project. */
  destHeading: ContainerResolution | null;
  /** Requested tag refs that resolve to no tag (unknown tags). */
  missingTags: string[];
  /**
   * Resolved leaf titles for the tag SET ops (todo.add/set-tags,
   * project.set-tags, area.add/update) — name/path refs de-duplicated. What
   * actually gets applied (by name, app-resolved) + asserted.
   */
  resolvedTagTitles: string[];
  /** tag.add parent resolution. */
  parentTag: ContainerResolution | null;
  /** area.delete / tag.delete target resolution (TMArea/TMTag). */
  entityTarget: ContainerResolution | null;
  /** tag.delete: descendant tags that a delete would CASCADE onto (P16). */
  childTags: string[];
  /**
   * area.delete: live (non-trashed) member counts, direct to-dos and projects
   * carrying the area's FK. A non-empty area's delete trashes its to-dos and
   * takes its projects with it (A25/A25B), so the delete refuses unless the
   * caller allows it. Null for non-area ops (and when the area did not resolve).
   */
  areaMembers: AreaMemberCounts | null;
  /** project.complete / project.cancel: children by pre-status. */
  openChildren: Todo[];
  canceledChildren: Todo[];
  completedChildren: Todo[];
  checklistCount: number;
  trashedCount: number;
  /** Pre-existing uuids for entity-created probes. */
  existingEntityUuids: string[];
  /** Pre-existing same-title/type rows (add create-probe exclusion). */
  sameTitleUuids: string[];
  /** Scope membership + wire list for the reorder operation. */
  reorder: ReorderPre | null;
  /**
   * area.reorder: the FULL area uuid list ordered by TMArea."index"
   * (the canonical area order once materialized) — feeds the ordering delta's
   * capture list so undo can restore the exact previous position.
   */
  areaOrder: string[] | null;
  /** project.make-repeating: the row-selection taxonomy (UIC4-f). */
  projectRepeat: ProjectRepeatTaxonomy | null;
  /**
   * project.make-repeating: the uuids of the source subtree rows (non-trashed
   * to-dos + headings) captured pre-write — the result's `childrenReplaced`
   * counts how many of these are dead post-op. Null for non-project ops.
   */
  repeatSubtreeUuids: string[] | null;
  /** project.promote-heading: the project-reveal + heading-row ordinal (HEADCERT1). */
  headingConvert: HeadingConvertTaxonomy | null;
  /** project.move-heading: current heading order + computed target order. */
  headingMove: HeadingMovePre | null;
  /** project.move-heading-to-project: source reveal + heading + destination (HEADXPROJ). */
  headingMoveToProject: HeadingMoveToProjectTaxonomy | null;
  /** project.dissolve-heading: parent reveal + heading title + children (DISS1). */
  headingDissolve: HeadingDissolveTaxonomy | null;
  /**
   * log-now: the resolved-but-unlogged census the `log completed now` verb will
   * move (`pending`) and the pre-op `TMSettings.manualLogDate` (epoch seconds) the
   * delta compares against. Null for every other op.
   */
  logNow: { pending: number; manualLogDatePre: number | null } | null;
}

/** project.move-heading pre-computation (spec §2/§4). */
export interface HeadingMovePre {
  /** Destination project resolution (the container the headings live in). */
  project: ContainerResolution;
  /** The project's non-trashed heading uuids in current display (index) order. */
  current: string[];
  /** Full target order after moving the block — the verified END state (delta). */
  targetOrder: string[];
  /**
   * The MINIMAL native re-rank wire (#V11): the shortest front-clustered id list
   * that realizes {@link targetOrder}. A partial wire re-ranks only its ids and
   * clusters them above the un-named headings, which keep their current relative
   * order (HEADSORT partial-wire law) — so an ARCHIVED heading that need not move
   * stays OUT of the wire and is provably untouched (H-UNSWEPT). The compile sends
   * THIS, not the full order, so archived bystanders are never reopened.
   */
  wire: string[];
  /**
   * Archived headings FORCED into the wire (wire ∩ archived). Re-ranking an
   * archived heading REOPENS it (HEADSORT: status 3→0, stopDate→NULL, umd bump,
   * heading-only — children stay resolved). Non-empty only when the target order
   * cannot be reached without moving an archived heading; disclosed in the result
   * and dry-run, never silent, never guarded (#V11).
   */
  reopened: string[];
  /** Reasons the move is illegal (empty = ok). */
  problems: string[];
}

/**
 * Row-selection taxonomy for `project.make-repeating` (UIC4-f). A project is
 * made repeating by selecting it as a content-table ROW (settable
 * AXSelectedRows), reachable in its AREA view or the SOMEDAY view but NOT the
 * Anytime view (an area-less anytime project renders as a header there). The
 * classifier resolves which view reveals a selectable row, or refuses.
 */
export type ProjectRepeatRefusal =
  | "not-a-project"
  | "trashed"
  | "logged"
  | "already-repeating"
  | "ambiguous-row"
  | "unexpected-start";

export type ProjectRepeatTaxonomy =
  | {
      /** Selectable row in the project's AREA view — reveal the area, then select the row. */
      kind: "area";
      /** The area uuid revealed via things:///show?id= to render the row. */
      containerReveal: string;
      title: string;
    }
  | {
      /** Area-less someday project — a selectable row in the SOMEDAY view. */
      kind: "someday";
      /** Literal "someday" (things:///show?id=someday). */
      containerReveal: "someday";
      title: string;
    }
  | {
      /**
       * Area-less ANYTIME project — no selectable row in the Anytime view
       * (renders as a header, UIC4-d). Reachable only after a cleanup-free
       * coercion to Someday; the orchestrator does that leg, never the drive.
       */
      kind: "anytime";
      title: string;
    }
  | { kind: "refuse"; refusal: ProjectRepeatRefusal; detail: string };

export function emptyPreState(): PreState {
  return {
    target: null,
    todayIso: localToday(new Date()),
    destProject: null,
    destProjectStatus: null,
    destArea: null,
    destHeading: null,
    missingTags: [],
    resolvedTagTitles: [],
    parentTag: null,
    entityTarget: null,
    childTags: [],
    areaMembers: null,
    openChildren: [],
    canceledChildren: [],
    completedChildren: [],
    checklistCount: 0,
    trashedCount: 0,
    existingEntityUuids: [],
    sameTitleUuids: [],
    reorder: null,
    areaOrder: null,
    projectRepeat: null,
    repeatSubtreeUuids: null,
    headingConvert: null,
    headingMove: null,
    headingMoveToProject: null,
    headingDissolve: null,
    logNow: null,
  };
}

/**
 * Read a project's current heading order and compute the FULL target order
 * after moving `headings` (an ordered block) to the requested placement. The
 * block lands contiguously in selection order; every other heading keeps its
 * relative order. Children follow their heading on the wire (scf P1). Illegal
 * requests (unknown/duplicated movee, an anchor that is a movee or absent)
 * collect problems and leave the order unchanged.
 */
export function computeHeadingMovePre(
  db: DatabaseSync,
  project: ContainerResolution,
  headings: string[],
  placement: HeadingPlacement,
): HeadingMovePre {
  const projectUuid = project.resolved?.uuid ?? "";
  const rows = db
    .prepare(
      `SELECT uuid, status FROM TMTask WHERE type = 2 AND trashed = 0 AND project = ? ORDER BY "index"`,
    )
    .all(projectUuid) as { uuid: string; status: number }[];
  const current = rows.map((r) => r.uuid);
  // Archived = the heading is completed/canceled (any closed status). All lifecycle
  // classes — open, archived-unswept, archived-swept — sit in this ONE index axis
  // (HEADSORT, read-shape v2 R5); only `archived` marks the closed ones, and only
  // they reopen when re-ranked (#V11).
  const archived = new Set(rows.filter((r) => r.status !== 0).map((r) => r.uuid));
  const problems: string[] = [];
  const currentSet = new Set(current);
  const movees = new Set<string>();
  for (const h of headings) {
    if (movees.has(h)) problems.push(`heading ${h} listed more than once`);
    movees.add(h);
  }
  if (headings.length === 0) problems.push("no headings given");
  for (const h of headings) {
    if (!currentSet.has(h)) problems.push(`${h} is not a heading of this project`);
  }
  let anchor: string | null = null;
  if ("before" in placement || "after" in placement) {
    anchor = "before" in placement ? placement.before : placement.after;
    if (!currentSet.has(anchor)) {
      problems.push(`anchor heading ${anchor} is not a heading of this project`);
    }
    if (movees.has(anchor)) {
      problems.push("the anchor heading cannot also be one of the moved headings");
    }
  }
  if (problems.length > 0) {
    return { project, current, targetOrder: current, wire: [], reopened: [], problems };
  }

  const rest = current.filter((u) => !movees.has(u));
  let targetOrder: string[];
  if ("position" in placement) {
    targetOrder = placement.position === "first" ? [...headings, ...rest] : [...rest, ...headings];
  } else {
    const idx = rest.indexOf(anchor as string);
    const insertAt = "before" in placement ? idx : idx + 1;
    targetOrder = [...rest.slice(0, insertAt), ...headings, ...rest.slice(insertAt)];
  }
  // Minimal front-cluster wire (#V11). An empty wire means the request is already
  // satisfied (target == current); fall back to the full order so the pipeline has
  // a concrete invocation that reproduces it (and any forced reopen is disclosed).
  const minimal = minimalReorderWire(current, targetOrder);
  const wire = minimal.length > 0 ? minimal : [...targetOrder];
  const reopened = wire.filter((u) => archived.has(u));
  return { project, current, targetOrder, wire, reopened, problems: [] };
}

/**
 * The MINIMAL front-cluster wire that realizes `target` from `current` under the
 * native reorder's partial-wire law (HEADSORT / LOGSORT): a wire `W` re-ranks the
 * result to `[W in wire order] ++ [headings not in W, in current order]`. So the
 * smallest wire is the shortest PREFIX of `target` whose removal leaves a suffix
 * that already equals the current relative order of the un-named rows. Everything
 * genuinely out of place ends up in the wire; every already-correct trailing row
 * (open OR archived) stays out and untouched. An already-sorted request yields the
 * empty wire (a true no-op — the caller substitutes the movee block).
 */
export function minimalReorderWire(current: string[], target: string[]): string[] {
  const n = target.length;
  for (let k = 0; k <= n; k++) {
    const suffix = target.slice(k);
    const suffixSet = new Set(suffix);
    const currentFiltered = current.filter((u) => suffixSet.has(u));
    if (
      currentFiltered.length === suffix.length &&
      currentFiltered.every((u, i) => u === suffix[i])
    ) {
      return target.slice(0, k);
    }
  }
  return [...target];
}

/**
 * The uuids of a project's source subtree rows (non-trashed to-dos AND
 * headings, direct or heading-nested). `childrenReplaced` counts how many of
 * these are dead post-op — the whole subtree in the delete-remint fate, just
 * the flattened nested-template row in the nested-repeater preserve fate.
 */
export function projectSubtreeUuids(db: DatabaseSync, projectUuid: string): string[] {
  return (
    db
      .prepare(
        `SELECT uuid FROM TMTask
         WHERE trashed = 0 AND (
           (type = 0 AND (project = ? OR heading IN
             (SELECT uuid FROM TMTask WHERE type = 2 AND project = ?)))
           OR (type = 2 AND project = ?))`,
      )
      .all(projectUuid, projectUuid, projectUuid) as { uuid: string }[]
  ).map((r) => r.uuid);
}

/**
 * Taxonomy for `project.promote-heading`'s pure-AX drive (HEADCERT1). A
 * heading is not selectable via `things:///show` (the reveal URL selects to-dos
 * only — the UIC1 blocker), but revealing the heading's PARENT PROJECT shows its
 * content table, in which the heading renders as a selectable ROW. The row
 * exposes no stable AX title handle (its title lives only in a hover-dependent
 * "More" affordance), so identity is POSITIONAL: `ordinal` is the heading's
 * 0-based position among the project's non-trashed headings in display (`index`)
 * order, and the select-heading-row primitive walks the content table selecting
 * the Nth row that is selectable AND has an empty `selected to dos` readback (a
 * heading, not a to-do). Two same-titled headings are therefore unambiguous.
 */
export type HeadingConvertTaxonomy =
  | { kind: "ok"; projectReveal: string; ordinal: number }
  | {
      kind: "refuse";
      refusal: "not-a-heading" | "no-project" | "not-found";
      detail: string;
    };

export function classifyHeadingConvert(
  db: DatabaseSync,
  target: AnyTask | null,
): HeadingConvertTaxonomy {
  if (target === null || target.type !== "heading") {
    return { kind: "refuse", refusal: "not-a-heading", detail: "target is not a heading" };
  }
  const project = target.project;
  if (project === null) {
    return {
      kind: "refuse",
      refusal: "no-project",
      detail: "the heading has no owning project — cannot reveal a project view to select its row",
    };
  }
  const rows = db
    .prepare(
      `SELECT uuid FROM TMTask WHERE type = 2 AND project = ? AND trashed = 0 ORDER BY "index"`,
    )
    .all(project.uuid) as { uuid: string }[];
  const ordinal = rows.findIndex((r) => r.uuid === target.uuid);
  if (ordinal < 0) {
    return {
      kind: "refuse",
      refusal: "not-found",
      detail: "the heading was not found among its project's non-trashed headings",
    };
  }
  return { kind: "ok", projectReveal: project.uuid, ordinal };
}

/**
 * Taxonomy for `project.move-heading-to-project`'s ellipsis-`Move…` drive
 * (HEADXPROJ). Unlike the promote drive (positional), the heading row is
 * TITLE-addressable: its `…` button is an AXUnknown whose AXDescription is
 * `"More. <title>"`, so the recipe HID-clicks that button, then `Move…`, then
 * TYPES the destination project title into the search picker and presses Return.
 * Two collision surfaces therefore fail closed: (a) the SOURCE heading title is
 * shared by another heading in the same project (the `"More. <title>"` node
 * matches both — indistinguishable), and (b) the DESTINATION title is shared by
 * another project (the picker is search-by-title — Return would pick the wrong
 * row). A titleless heading is refused (its `"More. "` description matches every
 * titleless heading). Verify oracle: the heading row's `project` FK becomes the
 * destination (children follow via their intact heading FK — a single-row change).
 */
export interface HeadingMoveToProjectPre {
  /** Source project revealed via things:///show?id= to render the heading row. */
  sourceProjectUuid: string;
  /** The heading being moved (the verify oracle's target row). */
  headingUuid: string;
  /** The heading title — the `"More. <title>"` click target. */
  headingTitle: string;
  /** The destination project — the heading's `project` FK becomes this post-op. */
  destProjectUuid: string;
  /** The destination title typed into the Move… search picker. */
  destProjectTitle: string;
}

export type HeadingMoveToProjectRefusal =
  | "no-source"
  | "heading-not-found"
  | "heading-ambiguous"
  | "empty-heading-title"
  | "no-dest"
  | "dest-ambiguous"
  | "same-project";

export type HeadingMoveToProjectTaxonomy =
  | { kind: "ok"; pre: HeadingMoveToProjectPre }
  | { kind: "refuse"; refusal: HeadingMoveToProjectRefusal; detail: string; candidates?: string[] };

export function classifyHeadingMoveToProject(
  db: DatabaseSync,
  project: ContainerRef,
  headingSel: string,
  toProject: ContainerRef,
): HeadingMoveToProjectTaxonomy {
  const src = resolveProject(db, project);
  if (src.resolved === null) {
    return {
      kind: "refuse",
      refusal: "no-source",
      detail:
        src.matches > 1
          ? "the source project title is ambiguous — pass its uuid"
          : "the source project did not resolve",
    };
  }
  const h = resolveHeading(db, src.resolved.uuid, headingSel);
  if (h.resolved === null) {
    return {
      kind: "refuse",
      refusal: h.matches > 1 ? "heading-ambiguous" : "heading-not-found",
      detail:
        h.matches > 1
          ? `the heading selector "${headingSel}" matches ${h.matches} headings in the project — disambiguate with a uuid`
          : `no heading matching "${headingSel}" in the source project`,
    };
  }
  const headingRow = db
    .prepare("SELECT title FROM TMTask WHERE uuid = ? AND type = 2 AND trashed = 0")
    .get(h.resolved.uuid) as { title: string | null } | undefined;
  if (headingRow === undefined) {
    return { kind: "refuse", refusal: "heading-not-found", detail: "the heading no longer exists" };
  }
  const title = headingRow.title ?? "";
  if (title === "") {
    return {
      kind: "refuse",
      refusal: "empty-heading-title",
      detail:
        "the heading has no title — the Move… drive addresses the heading by its title-carrying " +
        '"More. <title>" button, which cannot pick one titleless heading out of several',
    };
  }
  // Source title-collision: the "More. <title>" node cannot tell two same-titled
  // headings in one project apart, even when the SELECTOR resolved by uuid.
  const twins = db
    .prepare(
      "SELECT uuid FROM TMTask WHERE type = 2 AND trashed = 0 AND project = ? AND title = ? AND uuid != ?",
    )
    .all(src.resolved.uuid, title, h.resolved.uuid) as { uuid: string }[];
  if (twins.length > 0) {
    return {
      kind: "refuse",
      refusal: "heading-ambiguous",
      detail:
        `the heading title "${title}" is shared by ${twins.length + 1} headings in this project — ` +
        "the ellipsis Move… drive addresses headings by title and cannot disambiguate; " +
        "rename one first",
      candidates: [h.resolved.uuid, ...twins.map((t) => t.uuid)],
    };
  }
  const dest = resolveProject(db, toProject);
  if (dest.resolved === null) {
    return {
      kind: "refuse",
      refusal: "no-dest",
      detail:
        dest.matches > 1
          ? "the destination project title is ambiguous — pass its uuid"
          : "the destination project did not resolve",
    };
  }
  if (dest.resolved.uuid === src.resolved.uuid) {
    return {
      kind: "refuse",
      refusal: "same-project",
      detail:
        "the destination is the heading's current project — use `project move-heading` to reorder " +
        "a heading WITHIN its project",
    };
  }
  // Destination picker-collision: the picker searches BY TITLE, so a shared dest
  // title would filter to >1 project and Return would pick the wrong one — fail
  // closed even though the destination itself resolved (possibly by uuid).
  const destTitle = dest.resolved.title;
  const destTwins = db
    .prepare(
      "SELECT COUNT(*) AS n FROM TMTask WHERE type = 1 AND trashed = 0 AND title = ? AND uuid != ?",
    )
    .get(destTitle, dest.resolved.uuid) as { n: number };
  if (destTwins.n > 0) {
    return {
      kind: "refuse",
      refusal: "dest-ambiguous",
      detail:
        `the destination title "${destTitle}" is shared by ${destTwins.n + 1} projects — the ` +
        "Move… picker searches by title and would land the heading in the wrong one; rename or " +
        "merge the duplicates first",
    };
  }
  return {
    kind: "ok",
    pre: {
      sourceProjectUuid: src.resolved.uuid,
      headingUuid: h.resolved.uuid,
      headingTitle: title,
      destProjectUuid: dest.resolved.uuid,
      destProjectTitle: destTitle,
    },
  };
}

/**
 * Taxonomy for `project.dissolve-heading`'s ellipsis-`Delete` drive (DISS1). Same
 * title-addressed `"More. <title>"` reveal as the cross-project move, driving the
 * popover's Delete instead of Move…. DISS1 (2026-07-28, Things 3.22.11): Delete
 * HARD-DELETES the heading row (removed from TMTask) while its children become
 * DIRECT project children (heading→NULL, project→the parent, index preserved,
 * NOT trashed) — no confirm sheet. Contrast the Shortcuts delete cascade (P12),
 * which TRASHES the children. Fails closed on a title shared by another heading in
 * the project (the drive addresses by title) and on a titleless heading.
 */
export interface HeadingDissolvePre {
  /** Parent project revealed via things:///show?id= to render the heading row. */
  projectReveal: string;
  /** The heading being dissolved (the verify oracle's gone-target). */
  headingUuid: string;
  /** The heading title — the `"More. <title>"` click target. */
  headingTitle: string;
  /** Open children that become direct project children (for the result note). */
  childUuids: string[];
}

export type HeadingDissolveRefusal =
  | "not-a-heading"
  | "no-project"
  | "title-ambiguous"
  | "empty-title";

export type HeadingDissolveTaxonomy =
  | { kind: "ok"; pre: HeadingDissolvePre }
  | { kind: "refuse"; refusal: HeadingDissolveRefusal; detail: string; candidates?: string[] };

export function classifyHeadingDissolve(
  db: DatabaseSync,
  target: AnyTask | null,
): HeadingDissolveTaxonomy {
  if (target === null || target.type !== "heading") {
    return { kind: "refuse", refusal: "not-a-heading", detail: "target is not a heading" };
  }
  const project = target.project;
  if (project === null) {
    return {
      kind: "refuse",
      refusal: "no-project",
      detail: "the heading has no owning project — cannot reveal a project view to drive its row",
    };
  }
  const title = target.title;
  if (title === "") {
    return {
      kind: "refuse",
      refusal: "empty-title",
      detail:
        "the heading has no title — the Delete drive addresses the heading by its title-carrying " +
        '"More. <title>" button, which cannot pick one titleless heading out of several',
    };
  }
  const twins = db
    .prepare(
      "SELECT uuid FROM TMTask WHERE type = 2 AND trashed = 0 AND project = ? AND title = ? AND uuid != ?",
    )
    .all(project.uuid, title, target.uuid) as { uuid: string }[];
  if (twins.length > 0) {
    return {
      kind: "refuse",
      refusal: "title-ambiguous",
      detail:
        `the heading title "${title}" is shared by ${twins.length + 1} headings in this project — ` +
        "the ellipsis Delete drive addresses headings by title and cannot disambiguate; " +
        "rename one first",
      candidates: [target.uuid, ...twins.map((t) => t.uuid)],
    };
  }
  const childUuids = (
    db
      .prepare(
        'SELECT uuid FROM TMTask WHERE type = 0 AND trashed = 0 AND status = 0 AND heading = ? ORDER BY "index"',
      )
      .all(target.uuid) as { uuid: string }[]
  ).map((r) => r.uuid);
  return {
    kind: "ok",
    pre: { projectReveal: project.uuid, headingUuid: target.uuid, headingTitle: title, childUuids },
  };
}

/**
 * Count non-trashed projects with the given title that share the target's
 * row-selection container, EXCLUDING the target itself. A non-zero count is a
 * row-selection ambiguity: the AREA/SOMEDAY row exposes no title text or uuid
 * to disambiguate (UIC4-b), so two same-titled projects cannot be told apart —
 * the drive refuses fail-closed rather than guess which row to select.
 */
function sameTitleRowCount(
  db: DatabaseSync,
  title: string,
  excludeUuid: string,
  container: { areaUuid: string } | { somedayAreaLess: true },
): number {
  const containerWhere =
    "areaUuid" in container ? "area = ?" : "area IS NULL AND start = 2 AND startDate IS NULL";
  const binds: (string | number)[] =
    "areaUuid" in container ? [title, excludeUuid, container.areaUuid] : [title, excludeUuid];
  // Repeating TEMPLATE rows (rt1_recurrenceRule / repeater set) are HIDDEN — they
  // never render as selectable rows in a list view, so a same-titled template
  // sibling cannot create a row-selection ambiguity. Exclude them from the count
  // (this is what lets a template-direct clone re-promote a clone that keeps the
  // source template's title + area — the source template is invisible).
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM TMTask
       WHERE type = 1 AND trashed = 0 AND title = ? COLLATE NOCASE AND uuid != ?
         AND rt1_recurrenceRule IS NULL AND repeater IS NULL AND ${containerWhere}`,
    )
    .get(...binds) as { n: number };
  return row.n;
}

/**
 * Classify a project for `project.make-repeating`'s pure-AX row-selection
 * recipe (UIC4-f), or refuse. Reads DB truth (area / start / template / status)
 * — the orchestrator uses it to decide the Someday coercion; the command spec
 * uses it (post-coercion) to build the reveal + row-select recipe.
 */
export function classifyProjectRepeat(
  db: DatabaseSync,
  target: AnyTask | null,
): ProjectRepeatTaxonomy {
  if (target === null || target.type !== "project") {
    return { kind: "refuse", refusal: "not-a-project", detail: "target is not a project" };
  }
  if (target.derived.trashed) {
    return { kind: "refuse", refusal: "trashed", detail: "the project is in the Trash" };
  }
  if (target.status !== "open" || target.derived.logged) {
    return {
      kind: "refuse",
      refusal: "logged",
      detail: `the project is ${target.derived.logged ? "logged" : target.status} — only an open project can be made repeating`,
    };
  }
  if (target.repeating.isTemplate) {
    return {
      kind: "refuse",
      refusal: "already-repeating",
      detail: "the project is already a repeating template",
    };
  }
  const title = target.title;
  if (target.area !== null) {
    const areaUuid = target.area.uuid;
    if (sameTitleRowCount(db, title, target.uuid, { areaUuid }) > 0) {
      return {
        kind: "refuse",
        refusal: "ambiguous-row",
        detail: `another project titled "${title}" shares this area — its selectable row cannot be disambiguated`,
      };
    }
    return { kind: "area", containerReveal: areaUuid, title };
  }
  // Area-less: someday renders a selectable row; anytime needs coercion first.
  if (target.derived.start === "someday") {
    if (sameTitleRowCount(db, title, target.uuid, { somedayAreaLess: true }) > 0) {
      return {
        kind: "refuse",
        refusal: "ambiguous-row",
        detail: `another area-less Someday project titled "${title}" exists — its row cannot be disambiguated`,
      };
    }
    return { kind: "someday", containerReveal: "someday", title };
  }
  if (target.derived.start === "active") {
    // Post-coercion the project joins the Someday cohort; refuse if that would
    // collide with an existing same-titled area-less Someday project.
    if (sameTitleRowCount(db, title, target.uuid, { somedayAreaLess: true }) > 0) {
      return {
        kind: "refuse",
        refusal: "ambiguous-row",
        detail: `an area-less Someday project titled "${title}" already exists — coercing this one there would make its row ambiguous`,
      };
    }
    return { kind: "anytime", title };
  }
  return {
    kind: "refuse",
    refusal: "unexpected-start",
    detail: `the project has an unexpected schedule state (${target.derived.start}) with no area — cannot resolve a selectable row`,
  };
}

/**
 * The lookup key of a container reference. UNREACHABLE-but-throwing (#580): the
 * parameter schema proves a present ref names a uuid or a title, so the old
 * `?? ""` degradation — which quietly queried the empty key and reported
 * "not found" for input that was in fact malformed — can no longer be reached
 * silently.
 */
function containerKey(ref: ContainerRef): string {
  const key = ref.uuid ?? ref.title;
  if (key === undefined || key === "") {
    throw new RangeError("a container reference must name a uuid or a title — it names neither");
  }
  return key;
}

export function resolveArea(db: DatabaseSync, ref: ContainerRef): ContainerResolution {
  return resolveNamedRef(db, "TMArea", "1=1", [], containerKey(ref));
}

/**
 * Resolve a project DESTINATION (`--to-project` / `--project` on add/move). NAME
 * resolution is OPEN-only (`status = 0`) — a completed/canceled project is not a
 * valid live destination by name: placing an open child there strands it (PLOG1,
 * "a completed-in-place project strands children identically, one sweep later").
 * A UUID / partial-uuid still reaches a completed project (explicit intent —
 * `nameExtraWhere` narrows the NAME tiers only). When a name matches ONLY non-open
 * projects, the resolution carries a `deadHint` so the destination not-found says
 * the row exists and how to reach it (by uuid), instead of a bare "project not
 * found".
 */
export function resolveProject(db: DatabaseSync, ref: ContainerRef): ContainerResolution {
  const key = containerKey(ref);
  const r = resolveNamedRef(db, "TMTask", "type = 1 AND trashed = 0", [], key, {
    nameExtraWhere: "status = 0",
  });
  if (r.resolved === null && r.matches === 0) {
    const completed = resolveNamedRef(
      db,
      "TMTask",
      "type = 1 AND trashed = 0 AND status != 0",
      [],
      key,
      {
        prefixTier: false,
      },
    ).matches;
    if (completed > 0) return { ...r, deadHint: deadNameMatchHint({ completed }) };
  }
  return r;
}

export function resolveHeading(
  db: DatabaseSync,
  projectUuid: string,
  headingSel: string,
): ContainerResolution {
  // Shares the one heading-selector core (title | uuid | empty-string literal,
  // no ordinal) with the project heading verbs — see resolveHeadingRef.
  const r = resolveHeadingRef(db, projectUuid, headingSel);
  return { resolved: r.resolved, matches: r.matches };
}

export function projectStatus(db: DatabaseSync, uuid: string): TaskStatus | null {
  const row = db.prepare("SELECT status FROM TMTask WHERE uuid = ? AND type = 1").get(uuid) as
    | { status: number }
    | undefined;
  if (row === undefined) return null;
  return TASK_STATUS_FROM_DB[row.status] ?? null;
}

export function resolveTag(db: DatabaseSync, ref: string): ContainerResolution {
  return resolveNamedRef(db, "TMTag", "1=1", [], ref);
}

export function loadTarget(
  db: DatabaseSync,
  uuid: string,
  now?: Date,
  zone?: string,
): AnyTask | null {
  return byUuid(db, uuid, now ?? new Date(), zone);
}

/**
 * Uuids of pre-existing TMTask rows matching a create-probe's (title, type),
 * captured in the pre-read and threaded into the probe as `excludeUuids`.
 * Create-mode verification discovers the row the app just made by (title,
 * type); without this exclusion the probe could bind to a DIFFERENT same-title
 * row that merely appeared in the trailing sinceEpoch window (a concurrent add,
 * a repeat-template spawn, a sync insert), recording the wrong discoveredUuid —
 * and a later undo would then trash the wrong item. Matches `findCreated`'s
 * exact `title = ? AND type = ?` filter (case-sensitive) so the captured set is
 * precisely the pre-existing rows that discovery would otherwise consider.
 */
export function sameTitleTaskUuids(db: DatabaseSync, title: string, type: TaskType): string[] {
  const dbType = type === "project" ? 1 : type === "heading" ? 2 : 0;
  return (
    db.prepare("SELECT uuid FROM TMTask WHERE title = ? AND type = ?").all(title, dbType) as {
      uuid: string;
    }[]
  ).map((r) => r.uuid);
}

export function projectChildren(db: DatabaseSync, projectUuid: string): Todo[] {
  const rows = db
    .prepare(
      "SELECT uuid FROM TMTask WHERE type = 0 AND trashed = 0 AND (project = ? OR heading IN " +
        "(SELECT uuid FROM TMTask WHERE type = 2 AND project = ?))",
    )
    .all(projectUuid, projectUuid) as { uuid: string }[];
  const todos: Todo[] = [];
  for (const r of rows) {
    const t = byUuid(db, r.uuid);
    if (t !== null && t.type === "to-do") todos.push(t);
  }
  return todos;
}

/**
 * Titles of every DESCENDANT tag under the given tag (excluding itself).
 * Deleting the parent CASCADE-DELETES all of these (P16) — the guard lists
 * them. UNION (not UNION ALL): a parent cycle must terminate, not hang.
 */
export function childTagTitles(db: DatabaseSync, tagUuid: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE d(uuid) AS (
         SELECT ? UNION SELECT t.uuid FROM TMTag t JOIN d ON t.parent = d.uuid
       )
       SELECT t.title FROM TMTag t JOIN d ON t.uuid = d.uuid WHERE t.uuid != ?`,
    )
    .all(tagUuid, tagUuid) as { title: string }[];
  return rows.map((r) => r.title);
}

/**
 * Live member census for `area.delete` (A25/A25B). Counts the area's non-trashed
 * DIRECT members: to-dos carrying the area FK (any status — a logged to-do is
 * still trashed by the delete) and projects carrying the area FK. Deleting a
 * non-empty area trashes the to-dos and takes the projects with it, so the guard
 * uses these counts to refuse fail-closed unless the caller allows it.
 */
export function areaMemberCounts(db: DatabaseSync, areaUuid: string): AreaMemberCounts {
  const todos = (
    db
      .prepare("SELECT COUNT(*) AS n FROM TMTask WHERE type = 0 AND trashed = 0 AND area = ?")
      .get(areaUuid) as { n: number }
  ).n;
  const projects = (
    db
      .prepare("SELECT COUNT(*) AS n FROM TMTask WHERE type = 1 AND trashed = 0 AND area = ?")
      .get(areaUuid) as { n: number }
  ).n;
  return { projects, todos };
}

export function trashedCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM TMTask WHERE trashed = 1").get() as {
    n: number;
  };
  return row.n;
}

export function isRepeatingTemplate(task: AnyTask | null): boolean {
  return task !== null && task.type !== "heading" && task.repeating.isTemplate;
}

/**
 * Every row of one series — the template plus every occurrence it has spawned,
 * trashed ones included. All of them carry the template's title, so this is the
 * exclusion set that makes "the row Create Next Copy just minted" unambiguous
 * (CNC1). Trashed rows stay IN: a create probe must not rediscover an occurrence
 * the user trashed a moment ago and call it the new one.
 */
export function seriesRowUuids(db: DatabaseSync, templateUuid: string): string[] {
  const rows = db
    .prepare("SELECT uuid FROM TMTask WHERE uuid = ? OR rt1_repeatingTemplate = ?")
    .all(templateUuid, templateUuid) as { uuid: string }[];
  return rows.map((r) => r.uuid);
}

const NOT_TEMPLATE_ROW = "(rt1_recurrenceRule IS NULL AND repeater IS NULL)";

const TEMPLATE_ROW = "(rt1_recurrenceRule IS NOT NULL OR repeater IS NOT NULL)";

/**
 * DERIVED-trash exclusion for the reorder census — the bare-column mirror of the
 * reader's `CONTAINER_UNTRASHED` ([src/read/predicates.ts]). Project deletion is
 * SHALLOW (A24B): only the project row flips `trashed=1`; its children keep
 * `trashed=0` and their links, so their Trash membership is DERIVED through the
 * container chain. Filtering the row's own `trashed` flag alone (as every census
 * scope did) LEAKS a trashed project's Today-scheduled children into the wire, and
 * the native `list "Today"` reorder is a blind writer (§9p) that mutates their
 * `todayIndex`/`todayIndexReferenceDate` even though the reader hides them
 * (MOVPLC / ORD-21). Excluding them here matches the reader: the row's heading (if
 * any) AND its effective project (direct, or via its heading) must both be
 * untrashed. Areas cannot be trashed, so the chain is at most heading → project.
 */
// Every OUTER column is qualified `TMTask.` so the nested `FROM TMTask cc/hh/h`
// subqueries never rebind an unqualified `project`/`heading` to the inner alias.
const EFF_PROJECT =
  "COALESCE(TMTask.project, (SELECT h.project FROM TMTask h WHERE h.uuid = TMTask.heading))";
const CONTAINER_UNTRASHED =
  "(TMTask.heading IS NULL OR EXISTS (SELECT 1 FROM TMTask hh WHERE hh.uuid = TMTask.heading AND hh.trashed = 0)) " +
  `AND (${EFF_PROJECT} IS NULL OR EXISTS (SELECT 1 FROM TMTask cc WHERE cc.uuid = ${EFF_PROJECT} AND cc.trashed = 0))`;

interface MemberRow {
  uuid: string;
  title: string;
  rank: number;
  startBucket: number | null;
  type: number;
  isTemplate: boolean;
}

/**
 * Scope membership + full wire list for `reorder`. Eligibility mirrors the
 * lab evidence exactly:
 *  - today:   Today members with raw startBucket=0, to-dos AND projects
 *             (O01/O03/O12), by todayIndex. Bucket-1 members are listed as
 *             rejected candidates — including one silently de-evenings it
 *             (O03), so the guard refuses.
 *  - evening: raw startBucket=1 AND startDate == today exactly (evening
 *             membership expires daily), by todayIndex. Bounce-only (O03).
 *  - project: un-headed open to-do children, by "index" (O04/O09/O11);
 *             headed children are rejected candidates (O06 rips them out).
 *  - area:    direct open area to-dos (O05/O10) AND projects (O14), by
 *             "index" — but only SAME-TYPE requests; mixed wire lists are
 *             unprobed and the guard rejects them.
 *  - inbox:   unscheduled to-dos with no container (start=0), by "index"
 *             (A6/P8a — the command ranks the sent list in order).
 *  - someday: loose someday to-dos AND area-less someday projects, by
 *             "index"; same-type requests only. The Someday list handler is
 *             anchor-stacked with OPPOSITE stack directions by row type:
 *             to-dos ascend (P6h/P7e/P8b), projects DESCEND (P9e) — the
 *             compiler emits the matching validated two-call protocol.
 *  - projects: TOP-LEVEL sidebar projects (type=1, no area, start=1,
 *             undated), by "index". Bounce-only: a when=someday ->
 *             when=anytime round-trip front-inserts (P8e).
 */
/**
 * A precise refusal reason for a RESOLVED (completed/canceled) to-do handed to a
 * reorder that could NOT be admitted, or null when the row is not a resolved
 * to-do (LOGSORT ORD-13 / doctrine R6). Two distinct refusals:
 *
 *  - SWEPT (in the Logbook): reorder has no Logbook order axis, so point at
 *    reactivation (`things todo reopen`) or `--completed-at` to re-date it.
 *  - UNSWEPT-resolved (a live-body resident): LOGSORT proves it re-ranks cleanly
 *    index-only, and the permit ADMITS it — but ONLY on the pure-native `index`
 *    wire (the exact leg family LOGSORT certified). This refusal fires when the
 *    row reaches a NON-native / day-axis protocol (a move/bounce/materialization
 *    leg is uncertified for resolved rows and could reopen or misfile it), so it
 *    is refused honestly, distinct from a plain non-member.
 *
 * Sweptness is derived at CALL time against the live log boundary
 * ({@link logBoundary}) under the consumer `zone`, the same derivation reads use.
 */
function resolvedTodoReorderReason(
  db: DatabaseSync,
  uuid: string,
  now: Date,
  zone?: string,
): string | null {
  const r = db
    .prepare("SELECT type, status, stopDate FROM TMTask WHERE uuid = ? AND trashed = 0")
    .get(uuid) as { type: number; status: number; stopDate: number | null } | undefined;
  if (r === undefined || r.type !== 0 || r.status === 0) return null;
  const verb = r.status === 2 ? "canceled" : "completed";
  const boundaryEpoch = logBoundary(db, now, zone).getTime() / 1000;
  const swept = r.stopDate !== null && r.stopDate <= boundaryEpoch;
  return swept
    ? `is a swept ${verb} to-do (in the Logbook) — reorder has no Logbook order to change; ` +
        "reactivate it first (`things todo reopen`), or use `--completed-at` to re-date it in the Logbook"
    : `is a ${verb} (resolved) to-do — reordering a resolved to-do is only certified on the native ` +
        "in-place index reorder (LOGSORT ORD-13); this path uses an uncertified protocol for resolved " +
        "rows (reopen it first with `things todo reopen`)";
}

export function computeReorderPre(
  db: DatabaseSync,
  params: ReorderParams,
  containerUuid: string | null,
  now: Date,
  opts: { admitResolved?: boolean; zone?: string | undefined } = {},
): ReorderPre {
  const todayIso = localToday(now);
  const packedToday = encodePackedDate(todayIso);
  const key: "index" | "todayIndex" =
    params.scope === "today" ||
    params.scope === "evening" ||
    params.scope === "container-day" ||
    params.scope === "day" ||
    params.scope === "tomorrow" ||
    params.scope === "upcoming"
      ? "todayIndex"
      : "index";

  // LOGSORT ORD-13 permit: admit UNSWEPT-resolved to-do movees ONLY on the pure-
  // native `index` wire (the private-verb in-place reorder — the exact leg family
  // LOGSORT certified). `admitResolved` is passed true ONLY by the native `reorder`
  // op's preRead (the sole caller that runs that wire); every bounce/move/day-axis
  // orchestrator leaves it false, so a resolved movee reaching an uncertified
  // protocol stays refused. The `key === "index"` gate additionally excludes the
  // day-axis scopes (today/container-day/tomorrow — todayIndex), so `--in <date>`
  // day-axis targets never admit a resolved row.
  const boundaryEpoch = logBoundary(db, now, opts.zone).getTime() / 1000;
  const admitResolved = (opts.admitResolved ?? false) && key === "index";
  // Admitted rows: open (status 0) PLUS — under the permit — UNSWEPT-resolved
  // to-dos (type 0, closed, stopDate strictly ABOVE the live log boundary). SWEPT
  // resolved rows (stopDate <= boundary) are NEVER admitted (a re-rank reopens
  // them); they fall through to the swept refusal.
  const statusClause = admitResolved
    ? "(status = 0 OR (type = 0 AND status != 0 AND stopDate IS NOT NULL AND stopDate > ?))"
    : "status = 0";
  const statusBinds: number[] = admitResolved ? [boundaryEpoch] : [];

  const rowsOf = (
    where: string,
    binds: (string | number)[],
    rankCol: string,
    templateClause: string,
    statusExpr: string,
    statusExprBinds: number[],
    // When set, the query also fetches the projection inputs and keeps only rows
    // whose PROJECTION DAY equals this packed day (see selectTemplatesProjectingOn).
    projectionDay?: number,
  ): MemberRow[] =>
    (
      db
        .prepare(
          `SELECT uuid, title, ${rankCol} AS rank, startBucket, type, ${TEMPLATE_ROW} AS isTemplate${
            projectionDay === undefined ? "" : `, ${TEMPLATE_PROJECTION_COLUMNS}`
          }
           FROM TMTask
           WHERE trashed = 0 AND ${CONTAINER_UNTRASHED} AND ${statusExpr} AND ${templateClause} AND ${where}
           ORDER BY ${rankCol} ASC`,
        )
        .all(...statusExprBinds, ...binds) as unknown as (Omit<MemberRow, "isTemplate"> & {
        isTemplate: number;
      } & Partial<TemplateProjectionRow>)[]
    )
      .filter(
        (r) =>
          projectionDay === undefined ||
          templateProjectionDay(r as TemplateProjectionRow) === projectionDay,
      )
      .map((r) => {
        const m: MemberRow = {
          uuid: r.uuid,
          title: r.title,
          rank: r.rank,
          startBucket: r.startBucket,
          type: r.type,
          isTemplate: r.isTemplate === 1,
        };
        return m;
      });

  // Every scope EXCEPT the day-block scopes excludes templates (NOT_TEMPLATE_ROW).
  // The index-scope `select` carries the permit's relaxed status clause; the
  // day-block `selectWithTemplates` never does (todayIndex axis — resolved rows
  // are refused there per LOGSORT ORD-13).
  const select = (where: string, binds: (string | number)[], rankCol: string): MemberRow[] =>
    rowsOf(where, binds, rankCol, NOT_TEMPLATE_ROW, statusClause, statusBinds);
  // The `day`/`tomorrow` day-block scopes ADMIT templates as first-class members
  // (their strictly-future projection sits on the block todayIndex axis — TMPLSORT/
  // PTMPL); the leg family in reorder.ts splits per class (never a when=/deadline leg
  // on a template — the §1 crash).
  const selectWithTemplates = (where: string, binds: (string | number)[]): MemberRow[] =>
    rowsOf(where, binds, "todayIndex", "1=1", "status = 0", []);
  // The day-block TEMPLATE cohort: every template row (to-do or project) whose
  // PROJECTION DAY is the packed day D. The day cannot be a SQL predicate any more
  // — `rt1_nextInstanceStartDate` is NULL on the paused / trashed / never-populated
  // template cohort every app version carries (GV4 §2.1), so the day is derived per
  // row from the rule + spawn cursor (templateProjectionDay) and matched in host
  // math. Templates are a tiny cohort (the v27 partial index on
  // `rt1_recurrenceRule IS NOT NULL` covers the scan), and a template that
  // projects nowhere is simply not a member — the fail-closed contract.
  const selectTemplatesProjectingOn = (dayPacked: number): MemberRow[] =>
    rowsOf(
      `type IN (0, 1) AND ${TEMPLATE_ROW}`,
      [],
      "todayIndex",
      "1=1",
      "status = 0",
      [],
      dayPacked,
    );

  let members: MemberRow[] = [];
  const rejectedCandidates = new Map<string, string>();

  switch (params.scope) {
    case "today":
    case "evening": {
      const all = select(
        "type IN (0, 1) AND startDate IS NOT NULL AND startDate <= ? AND start IN (1, 2)",
        [packedToday],
        "todayIndex",
      );
      if (params.scope === "today") {
        members = all.filter((m) => m.startBucket === 0);
        for (const m of all) {
          if (m.startBucket === 1) {
            rejectedCandidates.set(
              m.uuid,
              "is an evening-bucket item — a native Today reorder would silently de-evening " +
                "it (O03); use scope 'evening' for it instead",
            );
          }
        }
      } else {
        // Evening membership expires daily: only exact-today bucket-1 rows.
        members = all.filter(
          (m) => m.startBucket === 1 && rowStartDate(db, m.uuid) === packedToday,
        );
        for (const m of all) {
          if (!members.some((e) => e.uuid === m.uuid)) {
            rejectedCandidates.set(
              m.uuid,
              m.startBucket === 1
                ? "is a STALE evening item (startDate in the past) — it renders in Today " +
                    "proper; re-schedule it before reordering"
                : "is in the Today section, not This Evening — use scope 'today'",
            );
          }
        }
      }
      break;
    }
    case "project": {
      members = select(
        "type = 0 AND heading IS NULL AND project = ?",
        [containerUuid ?? ""],
        `"index"`,
      );
      const headed = db
        .prepare(
          `SELECT t.uuid FROM TMTask t JOIN TMTask h ON t.heading = h.uuid
           WHERE t.trashed = 0 AND t.type = 0 AND h.project = ?`,
        )
        .all(containerUuid ?? "") as { uuid: string }[];
      for (const r of headed) {
        rejectedCandidates.set(
          r.uuid,
          "is inside a heading — a project-scope reorder RIPS headed children out of " +
            "their heading (O06); heading-scoped ordering is not automatable",
        );
      }
      break;
    }
    case "area": {
      members = select(
        "type IN (0, 1) AND heading IS NULL AND area = ?",
        [containerUuid ?? ""],
        `"index"`,
      );
      break;
    }
    case "inbox": {
      // Inbox = unscheduled to-dos with no container (start=0, A6). Ranks on
      // "index"; the private command re-ranks the full wire list exactly.
      members = select("type = 0 AND start = 0", [], `"index"`);
      break;
    }
    case "someday": {
      // Loose someday to-dos AND area-less someday projects (P9e locked the
      // project protocol) — same-type requests only, like the area scope.
      members = select(
        "((type = 0 AND project IS NULL AND area IS NULL AND heading IS NULL) " +
          "OR (type = 1 AND area IS NULL)) AND start = 2 AND startDate IS NULL",
        [],
        `"index"`,
      );
      const areaProjects = db
        .prepare(
          `SELECT uuid FROM TMTask WHERE trashed = 0 AND status = 0 AND type = 1
           AND start = 2 AND startDate IS NULL AND area IS NOT NULL`,
        )
        .all() as { uuid: string }[];
      for (const r of areaProjects) {
        rejectedCandidates.set(
          r.uuid,
          "is a someday project INSIDE an area — only area-less someday projects were " +
            "probed (P8c/P9e); order it within its area via scope 'area'",
        );
      }
      break;
    }
    case "projects": {
      members = select(
        "type = 1 AND area IS NULL AND start = 1 AND startDate IS NULL",
        [],
        `"index"`,
      );
      const others = db
        .prepare(
          `SELECT uuid, area, start, startDate FROM TMTask
           WHERE trashed = 0 AND status = 0 AND type = 1
           AND NOT (area IS NULL AND start = 1 AND startDate IS NULL)`,
        )
        .all() as { uuid: string; area: string | null; start: number; startDate: number | null }[];
      for (const r of others) {
        rejectedCandidates.set(
          r.uuid,
          r.area !== null
            ? "lives in an area — use scope 'area' (projects within an area reorder natively, O14)"
            : "is not a plain Anytime project — the bounce round-trip (when=someday -> " +
                "when=anytime) only preserves state for undated start=anytime projects (P8e)",
        );
      }
      break;
    }
    case "heading": {
      // A heading's ANYTIME children, ranked on "index". The forward-order
      // bounce back-inserts each (BOUNCE2-h); templates + scheduled/someday
      // children are not members of this bucket.
      members = select(
        "type = 0 AND heading = ? AND start = 1 AND startDate IS NULL",
        [containerUuid ?? ""],
        `"index"`,
      );
      break;
    }
    case "area-someday": {
      // An area's SOMEDAY direct members (unheaded), ranked on "index". The
      // reverse-order bounce front-inserts each (SOMEBNC-area) — the state-
      // preserving surface the destructive area reorder command lacks (§9f).
      members = select(
        "type = 0 AND area = ? AND heading IS NULL AND start = 2 AND startDate IS NULL",
        [containerUuid ?? ""],
        `"index"`,
      );
      break;
    }
    case "anytime": {
      // Area-less loose ANYTIME to-dos, ranked on "index". The reverse-order
      // bounce front-inserts each below the running global min (ANYBNC).
      members = select(
        "type = 0 AND project IS NULL AND area IS NULL AND heading IS NULL " +
          "AND start = 1 AND startDate IS NULL",
        [],
        `"index"`,
      );
      break;
    }
    case "container-day": {
      // A container's (project OR area) same-day scheduled children, ranked on
      // todayIndex, date-preserving (DAYORD-b). The day is read off the first
      // requested uuid — the planner guarantees every movee shares the bucket
      // (rule 4). startBucket=0 (today-proper / a future day); the evening
      // sub-bucket stays app-default (unprobed for the container specifier).
      const firstUuid = params.uuids[0];
      const first =
        firstUuid !== undefined
          ? (db
              .prepare("SELECT startDate, startBucket FROM TMTask WHERE uuid = ?")
              .get(firstUuid) as { startDate: number | null; startBucket: number } | undefined)
          : undefined;
      if (first?.startDate != null && first.startBucket === 0) {
        members = select(
          "type = 0 AND heading IS NULL AND (project = ? OR area = ?) " +
            "AND startBucket = 0 AND startDate = ?",
          [containerUuid ?? "", containerUuid ?? "", first.startDate],
          "todayIndex",
        );
      }
      break;
    }
    case "day": {
      // The DATED BOUNCE (SIT4 DAYBNC): a whole ARBITRARY future day-group across
      // ALL containers, ranked on todayIndex. SCHEDULED members are every to-do on
      // the day (loose, project-child, headed-child, area-direct — the when= round-
      // trip preserves each container FK, incl. the heading FK, §2e/R21) PLUS every
      // scheduled PROJECT row on the day (type=1 rows front-insert on the SAME
      // global todayIndex axis, DAYBNC DP-1/DP-2 — the leg is update-project).
      // DEADLINE-FORECAST members (DLBNC / #383) are ALSO first-class day-block
      // members: someday/anytime-stage to-dos (start IN (1,2)) whose future
      // `deadline` == D and whose `startDate` is NULL rest on the SAME Upcoming
      // day-block todayIndex axis (§9o / DLBNC-1d), reordered by the deadline-cycle
      // (URL deadline= clear + re-set) rather than the when= bounce. The two classes
      // are merged and re-sorted by todayIndex into the true interleaved block order.
      // The whole group is one bounce unit (a reverse-target pass re-bases it below
      // the day's global min), so every same-day member is enumerated — an
      // untouched row is just an unrequested member (co-bounced + disclosed as
      // `touched`), never a strand. The day D is read off the first requested uuid
      // (its startDate when scheduled, else its deadline when forecast). Templates
      // are excluded by NOT_TEMPLATE_ROW.
      const firstUuid = params.uuids[0];
      const first =
        firstUuid !== undefined
          ? (db
              .prepare(
                "SELECT startDate, startBucket, deadline, start, " +
                  `${TEMPLATE_PROJECTION_COLUMNS}, ${TEMPLATE_ROW} AS isTemplate ` +
                  "FROM TMTask WHERE uuid = ?",
              )
              .get(firstUuid) as
              | ({
                  startDate: number | null;
                  startBucket: number;
                  deadline: number | null;
                  start: number;
                  isTemplate: number;
                } & TemplateProjectionRow)
              | undefined)
          : undefined;
      // The day D read off the first requested uuid: a scheduled row's startDate, a
      // forecast row's deadline, or a TEMPLATE's projection day (TMPLSORT/PTMPL —
      // cached, else derived). Threaded into all three member cohorts below.
      const dayPacked: number | null =
        first === undefined
          ? null
          : first.isTemplate === 1
            ? templateProjectionDay(first)
            : first.startDate !== null && first.startBucket === 0
              ? first.startDate
              : first.startDate === null && (first.start === 1 || first.start === 2)
                ? first.deadline
                : null;
      if (dayPacked !== null) {
        const scheduled = select(
          "type IN (0, 1) AND startBucket = 0 AND startDate = ?",
          [dayPacked],
          "todayIndex",
        );
        // §9o deadline-forecast cohort: start IN (1,2), startDate NULL, deadline == D.
        // To-dos AND PROJECTS (type IN (0,1)) — forecast projects are first-class
        // members of the SAME block todayIndex axis, interleaved with forecast to-dos
        // (PROJDL-2a/2c, #385), reordered by the update-project deadline-cycle.
        const forecast = select(
          "type IN (0, 1) AND startDate IS NULL AND deadline = ? AND start IN (1, 2)",
          [dayPacked],
          "todayIndex",
        );
        // Repeating TEMPLATE projections on day D (TMPLSORT-3c / PTMPL-B5): to-do AND
        // project templates whose PROJECTION DAY == D render on the SAME block
        // todayIndex axis. Admitted as members so the dispatch can split the
        // per-class leg family; a PROJECT template is byte-untouched under the suffix
        // rule, a TO-DO template front-inserts via a single-id `list "Upcoming"` leg.
        const templates = selectTemplatesProjectingOn(dayPacked);
        // One shared todayIndex axis (DLBNC-1d / TMPLSORT-2): merge + re-sort to block order.
        members = [...scheduled, ...forecast, ...templates].toSorted((a, b) => a.rank - b.rank);
      }
      // An INBOX-stage row (start=0) carrying this deadline is OFF the block axis
      // (todayIndex=0, §9o — the axis assignment is gated on start IN (1,2), not the
      // bare deadline), so it is refused with an honest, unprobed-membership reason.
      // Templates are NO LONGER rejected — they are first-class day-block members above
      // (their leg family, never a dated when= leg, is compiled in reorder.ts). Area-
      // direct project rows are scheduled members (SIT5 AREAPROJDAY).
      for (const uuid of params.uuids) {
        const t = db
          .prepare(
            "SELECT start, startDate, deadline, rt1_recurrenceRule AS rule, repeater " +
              "FROM TMTask WHERE uuid = ?",
          )
          .get(uuid) as
          | {
              start: number;
              startDate: number | null;
              deadline: number | null;
              rule: unknown;
              repeater: unknown;
            }
          | undefined;
        if (t === undefined) continue;
        if (t.rule !== null || t.repeater !== null) continue;
        if (
          dayPacked !== null &&
          t.start === 0 &&
          t.startDate === null &&
          t.deadline !== null &&
          t.deadline === dayPacked
        ) {
          rejectedCandidates.set(
            uuid,
            "is an INBOX-stage row (start=0) with this deadline — it rests OFF the Upcoming " +
              "day-block axis (todayIndex=0, §9o: the block axis is gated on start IN (1,2), " +
              "not the bare deadline), so its position there is unprobed; schedule it or move it " +
              "out of the Inbox before reordering it on the day axis",
          );
        }
      }
      break;
    }
    case "tomorrow": {
      // The whole TOMORROW day-group across ALL containers (ORDFIN2 TOMORROWLIST),
      // ranked on todayIndex. `list "Tomorrow"` is a clean one-call native surface
      // that ACCEPTS a scheduled PROJECT row inline (type=1, O12 analog) and re-
      // ranks it in position — so members are type IN (0,1), and a project row is a
      // valid MOVEE here (the ONLY reorder scope that accepts one on the day axis).
      // The day is read off the first requested uuid; the planner guarantees it is
      // tomorrow. Repeating TEMPLATES whose projection == tomorrow are ALSO first-
      // class members of this one-call wire (TMPLSORT-3c-Tomorrow to-do templates /
      // PTMPL-B5 project templates: the native `list "Tomorrow"` reorder places a
      // template at its exact sent slot, umd-silent, no reparent, no crash) — the
      // native surface is the ONE safe way to position a template on the day axis.
      const firstUuid = params.uuids[0];
      const first =
        firstUuid !== undefined
          ? (db
              .prepare(
                "SELECT startDate, startBucket, " +
                  `${TEMPLATE_PROJECTION_COLUMNS}, ${TEMPLATE_ROW} AS isTemplate ` +
                  "FROM TMTask WHERE uuid = ?",
              )
              .get(firstUuid) as
              | ({
                  startDate: number | null;
                  startBucket: number;
                  isTemplate: number;
                } & TemplateProjectionRow)
              | undefined)
          : undefined;
      const dayPacked: number | null =
        first === undefined
          ? null
          : first.isTemplate === 1
            ? templateProjectionDay(first)
            : first.startBucket === 0
              ? first.startDate
              : null;
      if (dayPacked !== null) {
        const scheduled = select(
          "type IN (0, 1) AND startBucket = 0 AND startDate = ?",
          [dayPacked],
          "todayIndex",
        );
        const templates = selectTemplatesProjectingOn(dayPacked);
        members = [...scheduled, ...templates].toSorted((a, b) => a.rank - b.rank);
      }
      break;
    }
    case "heading-someday": {
      // A heading's SOMEDAY children, ranked on "index" (HEADSUB1 Arm B-someday /
      // Arm C). Re-heading the block in forward target order BACK-INSERTS each
      // deterministically (start=2 preserved) — the move-to-heading sort. Same
      // bucket shape as the `heading` anytime scope, `start=2` instead of `start=1`.
      members = select(
        "type = 0 AND heading = ? AND start = 2 AND startDate IS NULL",
        [containerUuid ?? ""],
        `"index"`,
      );
      break;
    }
    case "upcoming": {
      // INTERNAL per-template front-insert leg (the `day` dispatch, TMPLSORT-1). The
      // sent id(s) are TRUSTED day-block members already validated by the day
      // dispatch — populate directly (so the H-REORDER-SCOPE guard passes) and let
      // the wire be the sent id(s) only (no extension). Never a user scope.
      if (params.uuids.length > 0) {
        members = selectWithTemplates(
          `uuid IN (${params.uuids.map(() => "?").join(", ")})`,
          params.uuids,
        );
      }
      break;
    }
  }

  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const uuid of params.uuids) {
    if (seen.has(uuid) && !duplicates.includes(uuid)) duplicates.push(uuid);
    seen.add(uuid);
  }

  const memberSet = new Map(members.map((m) => [m.uuid, m]));
  const rejected: { uuid: string; reason: string }[] = [];
  const projectMembers: string[] = [];
  for (const uuid of params.uuids) {
    const member = memberSet.get(uuid);
    if (member === undefined) {
      rejected.push({
        uuid,
        // O06 heading-child protection (rejectedCandidates) takes precedence over
        // the resolved-to-do refusal — a headed resolved child rejects for the
        // reparent hazard, not the reorder-permit condition.
        reason:
          rejectedCandidates.get(uuid) ??
          resolvedTodoReorderReason(db, uuid, now, opts.zone) ??
          "is not an open member of this scope",
      });
      continue;
    }
    if (member.type === 1) projectMembers.push(uuid);
  }

  // LOGSORT ORD-13: the requested movees ADMITTED as members that are UNSWEPT-
  // resolved to-dos (only ever non-empty under the pure-native `index` permit).
  // Their pre-op status + host-local stoppedDate feed the delta byte-lock.
  const resolvedMembers: ReorderPre["resolvedMembers"] = [];
  if (admitResolved) {
    for (const uuid of params.uuids) {
      if (!memberSet.has(uuid)) continue;
      const r = db.prepare("SELECT status, stopDate FROM TMTask WHERE uuid = ?").get(uuid) as
        | { status: number; stopDate: number | null }
        | undefined;
      if (r === undefined || r.status === 0) continue;
      resolvedMembers.push({
        uuid,
        status: TASK_STATUS_FROM_DB[r.status] ?? "completed",
        stoppedDate: r.stopDate === null ? null : hostLocalIsoDate(r.stopDate),
      });
    }
  }

  const requestedTypes = new Set(
    params.uuids.map((u) => memberSet.get(u)?.type).filter((t) => t !== undefined),
  );
  const mixedTypes =
    (params.scope === "area" || params.scope === "someday") && requestedTypes.size > 1;

  // Area scope pins ONLY the requested type's cohort: to-dos and projects
  // rank on "index" independently in the sidebar, and a mixed wire list is
  // unprobed (O05/O10 vs O14) — same-type extension keeps the send inside
  // validated territory. Other scopes extend with every member (today's
  // mixed to-do+project wire list IS validated, O12).
  const uniformType =
    (params.scope === "area" || params.scope === "someday") && requestedTypes.size === 1;
  const requestedType = [...requestedTypes][0];
  const requested = new Set(params.uuids);
  const wireList = [
    ...params.uuids,
    ...members
      .filter((m) => !requested.has(m.uuid))
      .filter((m) => !uniformType || m.type === requestedType)
      .map((m) => m.uuid),
  ];

  // TODWIRE — the today-axis MINIMAL wire. The native `list "Today"` reorder
  // re-stamps every NAMED row's `todayIndexReferenceDate → today` and rewrites its
  // `todayIndex`, so the full `wireList` above (raw `todayIndex` order) fused every
  // entry-date cohort and rewrote the whole visible order on ANY subset reorder
  // (MOVPLC/ORD-20). The today axis obeys the same partial-wire law as headings —
  // `result = [named in wire order] ++ [unnamed in prior VISIBLE order]` (TODWIRE
  // EXP1/EXP2) — so the smallest wire realizing the request is
  // `minimalReorderWire(currentVisibleOrder, targetVisibleOrder)` on the reader's
  // Today comparator. currentVisibleOrder = the open bucket-0 members in visible
  // order (unswept-canceled / stale-evening rows are never named and stay put); the
  // target = the requested prefix (`params.uuids`) followed by the remaining members
  // in visible order (mirrors the full-`wireList` model, but visible not raw).
  let todayVisibleOrder: string[] | null = null;
  let todayWire: string[] | null = null;
  let todayRestampNonMovees: string[] = [];
  if (params.scope === "today") {
    todayVisibleOrder = (
      db
        .prepare(
          `SELECT uuid FROM TMTask
           WHERE trashed = 0 AND ${CONTAINER_UNTRASHED} AND status = 0 AND ${NOT_TEMPLATE_ROW}
             AND type IN (0, 1) AND startDate IS NOT NULL AND startDate <= ? AND start IN (1, 2)
             AND startBucket = 0
           ORDER BY ${todayOrderBy()}`,
        )
        .all(packedToday) as { uuid: string }[]
    ).map((r) => r.uuid);
    const requestedInBucket = params.uuids.filter((u) => todayVisibleOrder?.includes(u));
    const requestedSet = new Set(requestedInBucket);
    const targetVisibleOrder = [
      ...requestedInBucket,
      ...todayVisibleOrder.filter((u) => !requestedSet.has(u)),
    ];
    const minimal = minimalReorderWire(todayVisibleOrder, targetVisibleOrder);
    todayWire = minimal.length > 0 ? minimal : [...targetVisibleOrder];
    const namedMovees = new Set(params.named ?? params.uuids);
    todayRestampNonMovees = todayWire.filter((u) => !namedMovees.has(u));
  }

  return {
    key,
    members: members.map((m) => ({
      uuid: m.uuid,
      title: m.title,
      rank: m.rank,
      startBucket: m.startBucket,
      type: m.type,
      isTemplate: m.isTemplate,
    })),
    rejected,
    duplicates,
    projectMembers,
    mixedTypes,
    wireList,
    todayWire,
    todayVisibleOrder,
    todayRestampNonMovees,
    resolvedMembers,
  };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Host-local calendar date (`YYYY-MM-DD`) of a stored epoch-seconds timestamp — matches the verify layer's `stoppedDate` day view (delta getField). */
function hostLocalIsoDate(epochSeconds: number): IsoDate {
  const d = new Date(epochSeconds * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` as IsoDate;
}

function rowStartDate(db: DatabaseSync, uuid: string): number | null {
  const row = db.prepare("SELECT startDate FROM TMTask WHERE uuid = ?").get(uuid) as
    | { startDate: number | null }
    | undefined;
  return row?.startDate ?? null;
}

/**
 * A row's live Today/Evening flag — `"today"`, `"evening"`, or `null` — read
 * from the SAME marker the `today`/`evening` reorder membership uses
 * ({@link computeReorderPre}, O01/O03/§9n): an ARRIVED scheduled row
 * (`start IN (1,2)` AND `startDate <= today`) carries the flag — `evening` at
 * raw `startBucket=1` (a live evening flag expires daily, so a stale past-dated
 * bucket-1 row reads `today` proper), `today` otherwise. Someday, anytime,
 * inbox, and future-scheduled rows carry NO flag. Single-sourced here so any
 * de-Today guard (e.g. the `projects` bounce's de-star refusal in reorder.ts)
 * keys off the one marker and can never drift from the membership query.
 */
export function todayEveningFlagOf(
  db: DatabaseSync,
  uuid: string,
  now: Date,
): "today" | "evening" | null {
  const packedToday = encodePackedDate(localToday(now));
  const row = db
    .prepare("SELECT start, startDate, startBucket FROM TMTask WHERE uuid = ?")
    .get(uuid) as { start: number; startDate: number | null; startBucket: number } | undefined;
  if (row === undefined) return null;
  if (row.start !== 1 && row.start !== 2) return null; // inbox (start=0)
  if (row.startDate === null || row.startDate > packedToday) return null; // someday / anytime / future
  return row.startBucket === 1 && row.startDate === packedToday ? "evening" : "today";
}
