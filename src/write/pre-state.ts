/**
 * Pre-read: everything guards and delta-builders need to know about the
 * world BEFORE a mutation. One read pass, snapshot semantics per statement.
 */
import type { DatabaseSync } from "node:sqlite";

import type { AnyTask, Project, TaskStatus, Todo } from "../model/entities.ts";
import { TASK_STATUS_FROM_DB } from "../model/entities.ts";
import { byUuid } from "../read/detail.ts";
import type { ContainerRef } from "./operations.ts";

export interface ResolvedContainer {
  uuid: string;
  title: string;
}

export interface ContainerResolution {
  resolved: ResolvedContainer | null;
  /** 0 = not found, 1 = ok, >1 = ambiguous title. */
  matches: number;
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

export function projectOf(task: AnyTask | null): Project | null {
  return task !== null && task.type === "project" ? task : null;
}
