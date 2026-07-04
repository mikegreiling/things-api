/**
 * Pre-read: everything guards and delta-builders need to know about the
 * world BEFORE a mutation. One read pass, snapshot semantics per statement.
 */
import type { DatabaseSync } from "node:sqlite";

import { encodePackedDate, localToday } from "../model/dates.ts";
import type { AnyTask, Project, TaskStatus, Todo } from "../model/entities.ts";
import { TASK_STATUS_FROM_DB } from "../model/entities.ts";
import { byUuid } from "../read/detail.ts";
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
  /** Requested tag titles absent from TMTag (case-insensitive). */
  missingTags: string[];
  /** tag.add parent resolution. */
  parentTag: ContainerResolution | null;
  /** area.delete / tag.delete target resolution (TMArea/TMTag). */
  entityTarget: ContainerResolution | null;
  /** project.complete: children by pre-status. */
  openChildren: Todo[];
  canceledChildren: Todo[];
  checklistCount: number;
  trashedCount: number;
  /** Pre-existing uuids for entity-created probes. */
  existingEntityUuids: string[];
  /** Scope membership + wire list for the reorder operation. */
  reorder: ReorderPre | null;
}

export function emptyPreState(): PreState {
  return {
    target: null,
    destProject: null,
    destProjectStatus: null,
    destArea: null,
    destHeading: null,
    missingTags: [],
    parentTag: null,
    entityTarget: null,
    openChildren: [],
    canceledChildren: [],
    checklistCount: 0,
    trashedCount: 0,
    existingEntityUuids: [],
    reorder: null,
  };
}

function resolveByTitleOrUuid(
  db: DatabaseSync,
  table: "TMArea" | "TMTag",
  ref: string,
): ContainerResolution {
  const byId = db.prepare(`SELECT uuid, title FROM ${table} WHERE uuid = ?`).get(ref) as
    | ResolvedContainer
    | undefined;
  if (byId !== undefined) return { resolved: byId, matches: 1 };
  const rows = db
    .prepare(`SELECT uuid, title FROM ${table} WHERE title = ? COLLATE NOCASE`)
    .all(ref) as unknown as ResolvedContainer[];
  const first = rows[0];
  return {
    resolved: rows.length === 1 && first !== undefined ? first : null,
    matches: rows.length,
  };
}

export function resolveArea(db: DatabaseSync, ref: ContainerRef): ContainerResolution {
  return resolveByTitleOrUuid(db, "TMArea", ref.uuid ?? ref.title ?? "");
}

export function resolveProject(db: DatabaseSync, ref: ContainerRef): ContainerResolution {
  const key = ref.uuid ?? ref.title ?? "";
  const byId = db
    .prepare("SELECT uuid, title FROM TMTask WHERE uuid = ? AND type = 1 AND trashed = 0")
    .get(key) as ResolvedContainer | undefined;
  if (byId !== undefined) return { resolved: byId, matches: 1 };
  const rows = db
    .prepare(
      "SELECT uuid, title FROM TMTask WHERE title = ? COLLATE NOCASE AND type = 1 AND trashed = 0",
    )
    .all(key) as unknown as ResolvedContainer[];
  const first = rows[0];
  return {
    resolved: rows.length === 1 && first !== undefined ? first : null,
    matches: rows.length,
  };
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

export function missingTagTitles(db: DatabaseSync, titles: string[]): string[] {
  return titles.filter(
    (t) => db.prepare("SELECT 1 FROM TMTag WHERE title = ? COLLATE NOCASE").get(t) === undefined,
  );
}

export function resolveTag(db: DatabaseSync, ref: string): ContainerResolution {
  return resolveByTitleOrUuid(db, "TMTag", ref);
}

export function loadTarget(db: DatabaseSync, uuid: string): AnyTask | null {
  return byUuid(db, uuid);
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
 *  - area:    direct open area to-dos, by "index" (O05/O10).
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
        "type = 0 AND heading IS NULL AND area = ?",
        [containerUuid ?? ""],
        `"index"`,
      );
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

  const requested = new Set(params.uuids);
  const wireList = [
    ...params.uuids,
    ...members.filter((m) => !requested.has(m.uuid)).map((m) => m.uuid),
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
