/**
 * Pre-read: everything guards and delta-builders need to know about the
 * world BEFORE a mutation. One read pass, snapshot semantics per statement.
 */
import type { DatabaseSync } from "node:sqlite";

import { encodePackedDate, localToday } from "../model/dates.ts";
import type { AnyTask, Project, TaskStatus, TaskType, Todo } from "../model/entities.ts";
import { TASK_STATUS_FROM_DB } from "../model/entities.ts";
import { byUuid } from "../read/detail.ts";
import { resolveNamedRef } from "../read/queries.ts";
import type { ContainerRef, ReorderParams } from "./operations.ts";

export interface ResolvedContainer {
  uuid: string;
  title: string;
}

export interface ContainerResolution {
  resolved: ResolvedContainer | null;
  /** 0 = not found, 1 = ok, >1 = ambiguous title. */
  matches: number;
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
}

export interface PreState {
  /** Primary target for uuid-addressed operations. */
  target: AnyTask | null;
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
  /** project.complete / project.cancel: children by pre-status. */
  openChildren: Todo[];
  canceledChildren: Todo[];
  completedChildren: Todo[];
  checklistCount: number;
  trashedCount: number;
  /** Pre-existing uuids for entity-created probes. */
  existingEntityUuids: string[];
  /** Pre-existing same-title/type rows (todo.add-logged create-probe exclusion). */
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
  /** heading.convert-to-project: the project-reveal + heading-row ordinal (HEADCERT1). */
  headingConvert: HeadingConvertTaxonomy | null;
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
    destProject: null,
    destProjectStatus: null,
    destArea: null,
    destHeading: null,
    missingTags: [],
    resolvedTagTitles: [],
    parentTag: null,
    entityTarget: null,
    childTags: [],
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
    headingConvert: null,
  };
}

/**
 * Taxonomy for `heading.convert-to-project`'s pure-AX drive (HEADCERT1). A
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
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM TMTask
       WHERE type = 1 AND trashed = 0 AND title = ? COLLATE NOCASE AND uuid != ? AND ${containerWhere}`,
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
  if (target.trashed) {
    return { kind: "refuse", refusal: "trashed", detail: "the project is in the Trash" };
  }
  if (target.status !== "open" || target.logged) {
    return {
      kind: "refuse",
      refusal: "logged",
      detail: `the project is ${target.logged ? "logged" : target.status} — only an open project can be made repeating`,
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
  if (target.start === "someday") {
    if (sameTitleRowCount(db, title, target.uuid, { somedayAreaLess: true }) > 0) {
      return {
        kind: "refuse",
        refusal: "ambiguous-row",
        detail: `another area-less Someday project titled "${title}" exists — its row cannot be disambiguated`,
      };
    }
    return { kind: "someday", containerReveal: "someday", title };
  }
  if (target.start === "active") {
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
    detail: `the project has an unexpected schedule state (${target.start}) with no area — cannot resolve a selectable row`,
  };
}

export function resolveArea(db: DatabaseSync, ref: ContainerRef): ContainerResolution {
  return resolveNamedRef(db, "TMArea", "1=1", [], ref.uuid ?? ref.title ?? "");
}

export function resolveProject(db: DatabaseSync, ref: ContainerRef): ContainerResolution {
  return resolveNamedRef(db, "TMTask", "type = 1 AND trashed = 0", [], ref.uuid ?? ref.title ?? "");
}

export function resolveHeading(
  db: DatabaseSync,
  projectUuid: string,
  headingTitle: string,
): ContainerResolution {
  const rows = db
    .prepare(
      "SELECT uuid, title FROM TMTask WHERE type = 2 AND trashed = 0 AND project = ? AND title = ? COLLATE NOCASE",
    )
    .all(projectUuid, headingTitle) as unknown as ResolvedContainer[];
  const first = rows[0];
  return {
    resolved: rows.length === 1 && first !== undefined ? first : null,
    matches: rows.length,
  };
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

export function loadTarget(db: DatabaseSync, uuid: string): AnyTask | null {
  return byUuid(db, uuid);
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

export function trashedCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM TMTask WHERE trashed = 1").get() as {
    n: number;
  };
  return row.n;
}

export function isRepeatingTemplate(task: AnyTask | null): boolean {
  return task !== null && task.type !== "heading" && task.repeating.isTemplate;
}

const NOT_TEMPLATE_ROW = "(rt1_recurrenceRule IS NULL AND repeater IS NULL)";

interface MemberRow {
  uuid: string;
  title: string;
  rank: number;
  startBucket: number | null;
  type: number;
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
 *  - headings: the HEADING rows (type=2) of a project, by "index" (scf P1 —
 *             the private command accepts heading uuids; children follow).
 *  - someday: loose someday to-dos AND area-less someday projects, by
 *             "index"; same-type requests only. The Someday list handler is
 *             anchor-stacked with OPPOSITE stack directions by row type:
 *             to-dos ascend (P6h/P7e/P8b), projects DESCEND (P9e) — the
 *             compiler emits the matching validated two-call protocol.
 *  - projects: TOP-LEVEL sidebar projects (type=1, no area, start=1,
 *             undated), by "index". Bounce-only: a when=someday ->
 *             when=anytime round-trip front-inserts (P8e).
 */
export function computeReorderPre(
  db: DatabaseSync,
  params: ReorderParams,
  containerUuid: string | null,
  now: Date,
): ReorderPre {
  const todayIso = localToday(now);
  const packedToday = encodePackedDate(todayIso);
  const key: "index" | "todayIndex" =
    params.scope === "today" || params.scope === "evening" ? "todayIndex" : "index";

  const select = (where: string, binds: (string | number)[], rankCol: string): MemberRow[] =>
    db
      .prepare(
        `SELECT uuid, title, ${rankCol} AS rank, startBucket, type FROM TMTask
         WHERE trashed = 0 AND status = 0 AND ${NOT_TEMPLATE_ROW} AND ${where}
         ORDER BY ${rankCol} ASC`,
      )
      .all(...binds) as unknown as MemberRow[];

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
    case "headings": {
      members = select("type = 2 AND project = ?", [containerUuid ?? ""], `"index"`);
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
        reason: rejectedCandidates.get(uuid) ?? "is not an open member of this scope",
      });
      continue;
    }
    if (member.type === 1) projectMembers.push(uuid);
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

  return {
    key,
    members: members.map((m) => ({
      uuid: m.uuid,
      title: m.title,
      rank: m.rank,
      startBucket: m.startBucket,
      type: m.type,
    })),
    rejected,
    duplicates,
    projectMembers,
    mixedTypes,
    wireList,
  };
}

function rowStartDate(db: DatabaseSync, uuid: string): number | null {
  const row = db.prepare("SELECT startDate FROM TMTask WHERE uuid = ?").get(uuid) as
    | { startDate: number | null }
    | undefined;
  return row?.startDate ?? null;
}

export function projectOf(task: AnyTask | null): Project | null {
  return task !== null && task.type === "project" ? task : null;
}
