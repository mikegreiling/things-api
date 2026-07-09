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
 * same chain inheritedTagsFor() walks). Takes a SET of tag uuids (the target
 * plus its hierarchy descendants) — each of the six clauses gets the full
 * set, so callers bind `uuids.length * 6` values via tagScopeBinds().
 */
export function tagScopeSql(uuidCount: number): string {
  const set = `(${Array.from({ length: uuidCount }, () => "?").join(", ")})`;
  return `(
  EXISTS (SELECT 1 FROM TMTaskTag tt WHERE tt.tasks = t.uuid AND tt.tags IN ${set})
  OR EXISTS (SELECT 1 FROM TMTaskTag tt WHERE tt.tasks = t.project AND tt.tags IN ${set})
  OR EXISTS (SELECT 1 FROM TMAreaTag at WHERE at.areas = t.area AND at.tags IN ${set})
  OR EXISTS (SELECT 1 FROM TMTask p JOIN TMAreaTag at ON at.areas = p.area
             WHERE p.uuid = t.project AND at.tags IN ${set})
  OR EXISTS (SELECT 1 FROM TMTask h JOIN TMTaskTag tt ON tt.tasks = h.project
             WHERE h.uuid = t.heading AND tt.tags IN ${set})
  OR EXISTS (SELECT 1 FROM TMTask h JOIN TMTask p ON p.uuid = h.project
             JOIN TMAreaTag at ON at.areas = p.area WHERE h.uuid = t.heading AND at.tags IN ${set})
)`;
}

export function tagScopeBinds(uuids: string[]): string[] {
  return Array.from({ length: 6 }, () => uuids).flat();
}

/**
 * A tag plus every hierarchy descendant. Filtering by a parent tag matches
 * child-tagged items — DOCUMENTED app behavior (the UI's tag filter works
 * this way), not lab-oracled: the UI's filter clicks aren't automatable.
 * UNION (not UNION ALL): dedupes, so a parent cycle in TMTag data can't
 * recurse forever.
 */
export function tagWithDescendants(db: DatabaseSync, uuid: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE d(uuid) AS (
         SELECT ? UNION
         SELECT tg.uuid FROM TMTag tg JOIN d ON tg.parent = d.uuid
       ) SELECT uuid FROM d`,
    )
    .all(uuid) as { uuid: string }[];
  return rows.map((r) => r.uuid);
}

/** Resolve a tag reference (uuid or unique case-insensitive title) — loud on miss. */
/**
 * Resolve a full TMTask uuid from a uuid OR a unique prefix (>= 6 chars).
 * Exact matches win outright (a 21-char uuid can prefix a 22-char one);
 * otherwise an indexed range scan finds prefix matches — zero throws
 * not-found, several throw with the candidates listed. Uuid params across
 * the CLI/MCP/library accept prefixes through this.
 */
export function resolveTaskUuidPrefix(db: DatabaseSync, ref: string): string {
  const exact = db.prepare("SELECT uuid FROM TMTask WHERE uuid = ?").get(ref) as
    | { uuid: string }
    | undefined;
  if (exact !== undefined) return exact.uuid;
  if (ref.length < 6) {
    throw new RangeError(`no record with uuid "${ref}" (prefixes need at least 6 characters)`);
  }
  const upper = ref.slice(0, -1) + String.fromCharCode(ref.charCodeAt(ref.length - 1) + 1);
  const rows = db
    .prepare("SELECT t.uuid, t.title FROM TMTask t WHERE t.uuid >= ? AND t.uuid < ? LIMIT 6")
    .all(ref, upper) as { uuid: string; title: string | null }[];
  if (rows.length === 0) throw new RangeError(`no record with uuid or prefix "${ref}"`);
  if (rows.length > 1) {
    const list = rows.map((r) => `${r.uuid} (${r.title ?? ""})`).join("; ");
    throw new RangeError(`uuid prefix "${ref}" is ambiguous — matches: ${list}`);
  }
  return rows[0]?.uuid ?? ref;
}

/**
 * Fold a name to its match key: NFC + case-fold + strip all whitespace and
 * dashes/hyphens (ASCII hyphen, the U+2010–2015 dash block, U+2212 minus).
 * Nothing else is removed, so emoji/symbols stay significant — see
 * docs/design/reference-resolution.md.
 */
export function normalizeNameKey(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s‐-―−-]+/gu, "");
}

const BASE62 = /^[0-9A-Za-z]+$/;

export interface NamedResolution {
  resolved: { uuid: string; title: string } | null;
  /** 0 = not found, 1 = ok, >1 = ambiguous at the deciding tier. */
  matches: number;
}

/**
 * Tiered reference resolution (docs/design/reference-resolution.md): exact
 * uuid → exact title → case-insensitive title → normalized title → uuid
 * prefix. The FIRST tier with exactly one match wins; a tier with several is
 * ambiguous; no tier is not-found. Shared by the read-side `resolve*Uuid`
 * throwers and the write-side `resolve*` (ContainerResolution) helpers.
 */
export function resolveNamedRef(
  db: DatabaseSync,
  table: string,
  extraWhere: string,
  extraBinds: (string | number)[],
  ref: string,
): NamedResolution {
  type Row = { uuid: string; title: string };
  const sel = (cond: string, extra: (string | number)[] = []): Row[] =>
    db
      .prepare(`SELECT uuid, title FROM ${table} WHERE ${extraWhere} AND ${cond}`)
      .all(...extraBinds, ...extra) as unknown as Row[];

  const byId = sel("uuid = ?", [ref]);
  if (byId.length === 1) return { resolved: byId[0] ?? null, matches: 1 };

  for (const cond of ["title = ?", "title = ? COLLATE NOCASE"]) {
    const rows = sel(cond, [ref]);
    if (rows.length === 1) return { resolved: rows[0] ?? null, matches: 1 };
    if (rows.length > 1) return { resolved: null, matches: rows.length };
  }

  const key = normalizeNameKey(ref);
  if (key !== "") {
    const hits = sel("title IS NOT NULL").filter((r) => normalizeNameKey(r.title) === key);
    if (hits.length === 1) return { resolved: hits[0] ?? null, matches: 1 };
    if (hits.length > 1) return { resolved: null, matches: hits.length };
  }

  if (ref.length >= 6 && BASE62.test(ref)) {
    const upper = ref.slice(0, -1) + String.fromCharCode(ref.charCodeAt(ref.length - 1) + 1);
    const rows = sel("uuid >= ? AND uuid < ?", [ref, upper]);
    if (rows.length === 1) return { resolved: rows[0] ?? null, matches: 1 };
    if (rows.length > 1) return { resolved: null, matches: rows.length };
  }

  return { resolved: null, matches: 0 };
}

function resolveUuidOrThrow(
  db: DatabaseSync,
  table: string,
  extraWhere: string,
  ref: string,
  kind: string,
  listCmd: string,
): string {
  const r = resolveNamedRef(db, table, extraWhere, [], ref);
  if (r.resolved !== null) return r.resolved.uuid;
  throw new RangeError(
    r.matches === 0
      ? `${kind} not found: ${ref} (list ${kind}s with \`${listCmd}\`)`
      : `${kind} reference is ambiguous: ${ref} (${r.matches} matches — use the exact name or uuid)`,
  );
}

export function resolveTagUuid(db: DatabaseSync, ref: string): string {
  return resolveUuidOrThrow(db, "TMTag", "1=1", ref, "tag", "things tags");
}

export function resolveProjectUuid(db: DatabaseSync, ref: string): string {
  return resolveUuidOrThrow(
    db,
    "TMTask",
    "type = 1 AND trashed = 0",
    ref,
    "project",
    "things projects",
  );
}

export function resolveAreaUuid(db: DatabaseSync, ref: string): string {
  return resolveUuidOrThrow(db, "TMArea", "1=1", ref, "area", "things areas");
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
