/**
 * Low-level row fetchers. Every SELECT names columns exclusively from the
 * schema manifest so removed columns fail loudly (drift), never silently.
 */
import type { DatabaseSync } from "node:sqlite";

import { q, selectList } from "../db/schema.ts";
import type { Ref } from "../model/entities.ts";
import type { ChecklistRow, TaskRow } from "../model/mappers.ts";

/** Rows that repeat via a template are normal; template rows are invisible in list views. */
export const NOT_TEMPLATE = "(t.rt1_recurrenceRule IS NULL AND t.repeater IS NULL)";

/**
 * UI-faithful tag membership for list filtering: direct tag, or inherited
 * through the ancestor chain heading → project → area (T18/U18/A13 — the
 * same chain inheritedTagsFor() walks). Binds the tag uuid SIX times.
 */
export const TAG_SCOPE = `(
  EXISTS (SELECT 1 FROM TMTaskTag tt WHERE tt.tasks = t.uuid AND tt.tags = ?)
  OR EXISTS (SELECT 1 FROM TMTaskTag tt WHERE tt.tasks = t.project AND tt.tags = ?)
  OR EXISTS (SELECT 1 FROM TMAreaTag at WHERE at.areas = t.area AND at.tags = ?)
  OR EXISTS (SELECT 1 FROM TMTask p JOIN TMAreaTag at ON at.areas = p.area
             WHERE p.uuid = t.project AND at.tags = ?)
  OR EXISTS (SELECT 1 FROM TMTask h JOIN TMTaskTag tt ON tt.tasks = h.project
             WHERE h.uuid = t.heading AND tt.tags = ?)
  OR EXISTS (SELECT 1 FROM TMTask h JOIN TMTask p ON p.uuid = h.project
             JOIN TMAreaTag at ON at.areas = p.area WHERE h.uuid = t.heading AND at.tags = ?)
)`;

export const TAG_SCOPE_BINDS = 6;

/** Resolve a tag reference (uuid or unique case-insensitive title) — loud on miss. */
export function resolveTagUuid(db: DatabaseSync, ref: string): string {
  const byId = db.prepare("SELECT uuid FROM TMTag WHERE uuid = ?").get(ref) as
    | { uuid: string }
    | undefined;
  if (byId !== undefined) return byId.uuid;
  const rows = db.prepare("SELECT uuid FROM TMTag WHERE title = ? COLLATE NOCASE").all(ref) as {
    uuid: string;
  }[];
  if (rows.length === 1 && rows[0] !== undefined) return rows[0].uuid;
  throw new RangeError(
    rows.length === 0
      ? `tag not found: ${ref} (list tags with \`things tags\`)`
      : `tag reference is ambiguous: ${ref} (${rows.length} matches — use the uuid)`,
  );
}

export function fetchTaskRows(db: DatabaseSync, where: string, params: unknown[] = []): TaskRow[] {
  const sql = `SELECT ${selectList("TMTask")
    .split(", ")
    .map((c) => `t.${c}`)
    .join(", ")} FROM TMTask t WHERE ${where}`;
  return db.prepare(sql).all(...(params as never[])) as unknown as TaskRow[];
}

export function fetchTaskByUuid(db: DatabaseSync, uuid: string): TaskRow | null {
  const rows = fetchTaskRows(db, "t.uuid = ?", [uuid]);
  return rows[0] ?? null;
}

export function fetchChecklistRows(db: DatabaseSync, taskUuid: string): ChecklistRow[] {
  const sql = `SELECT ${selectList("TMChecklistItem")} FROM TMChecklistItem WHERE task = ? ORDER BY ${q("index")} ASC`;
  return db.prepare(sql).all(taskUuid) as unknown as ChecklistRow[];
}

/** Direct tags for a set of tasks, in one query. Returns uuid -> Ref[] (sorted by tag title). */
export function fetchTagsForTasks(db: DatabaseSync, taskUuids: string[]): Map<string, Ref[]> {
  const map = new Map<string, Ref[]>();
  if (taskUuids.length === 0) return map;
  const placeholders = taskUuids.map(() => "?").join(",");
  const sql = `SELECT tt.tasks AS task, tg.uuid AS uuid, tg.title AS title
               FROM TMTaskTag tt JOIN TMTag tg ON tg.uuid = tt.tags
               WHERE tt.tasks IN (${placeholders})
               ORDER BY tg.title`;
  const rows = db.prepare(sql).all(...taskUuids) as unknown as Array<{
    task: string;
    uuid: string;
    title: string;
  }>;
  for (const row of rows) {
    const list = map.get(row.task) ?? [];
    list.push({ uuid: row.uuid, title: row.title });
    map.set(row.task, list);
  }
  return map;
}

/** Lazy uuid -> Ref resolver over TMTask + TMArea titles, cached per instance. */
export function makeRefResolver(db: DatabaseSync): (uuid: string | null) => Ref | null {
  const cache = new Map<string, Ref | null>();
  const taskStmt = db.prepare("SELECT uuid, title FROM TMTask WHERE uuid = ?");
  const areaStmt = db.prepare("SELECT uuid, title FROM TMArea WHERE uuid = ?");
  return (uuid) => {
    if (uuid === null) return null;
    const cached = cache.get(uuid);
    if (cached !== undefined) return cached;
    const hit = (taskStmt.get(uuid) ?? areaStmt.get(uuid)) as
      | { uuid: string; title: string | null }
      | undefined;
    const ref = hit ? { uuid: hit.uuid, title: hit.title ?? "" } : null;
    cache.set(uuid, ref);
    return ref;
  };
}
