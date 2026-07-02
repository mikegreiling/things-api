/**
 * Tag reads: taxonomy, and inherited-tag resolution.
 *
 * The DB stores DIRECT tags only (TMTaskTag/TMAreaTag). The native UI's tag
 * filtering also honors tags inherited from ancestor area/project (validated
 * T18: things.py misses this). inheritedTagsFor() reconstructs that chain:
 * task -> heading's project -> project -> area, collecting each ancestor's
 * direct tags.
 */
import type { DatabaseSync } from "node:sqlite";

import { q, selectList } from "../db/schema.ts";
import type { Area, Ref, Tag } from "../model/entities.ts";
import type { TaskRow } from "../model/mappers.ts";
import { fetchTagsForTasks, fetchTaskByUuid } from "./queries.ts";

interface TagRow {
  uuid: string;
  title: string | null;
  shortcut: string | null;
  usedDate: number | null;
  parent: string | null;
  index: number | null;
}

export function tagsView(db: DatabaseSync): Tag[] {
  const rows = db
    .prepare(`SELECT ${selectList("TMTag")} FROM TMTag ORDER BY ${q("index")} ASC`)
    .all() as unknown as TagRow[];
  const byUuid = new Map(rows.map((r) => [r.uuid, r]));
  return rows.map((row) => {
    const parentRow = row.parent ? byUuid.get(row.parent) : undefined;
    return {
      uuid: row.uuid,
      title: row.title ?? "",
      shortcut: row.shortcut,
      parent: parentRow ? { uuid: parentRow.uuid, title: parentRow.title ?? "" } : null,
      index: row.index ?? 0,
    };
  });
}

interface AreaRow {
  uuid: string;
  title: string | null;
  visible: number | null;
  index: number | null;
}

export function areasView(db: DatabaseSync): Area[] {
  const rows = db
    .prepare(`SELECT ${selectList("TMArea")} FROM TMArea ORDER BY ${q("index")} ASC`)
    .all() as unknown as AreaRow[];
  return rows.map((row) => ({
    uuid: row.uuid,
    title: row.title ?? "",
    visible: row.visible !== 0,
    index: row.index ?? 0,
    tags: areaTags(db, row.uuid),
  }));
}

export function areaTags(db: DatabaseSync, areaUuid: string): Ref[] {
  const rows = db
    .prepare(
      `SELECT tg.uuid AS uuid, tg.title AS title
       FROM TMAreaTag at JOIN TMTag tg ON tg.uuid = at.tags
       WHERE at.areas = ? ORDER BY tg.title`,
    )
    .all(areaUuid) as unknown as Array<{ uuid: string; title: string | null }>;
  return rows.map((r) => ({ uuid: r.uuid, title: r.title ?? "" }));
}

/** Tags inherited from ancestors (heading's project, project, area) — direct tags excluded. */
export function inheritedTagsFor(db: DatabaseSync, row: TaskRow): Ref[] {
  const collected = new Map<string, Ref>();
  const addAll = (refs: Ref[]) => {
    for (const ref of refs) collected.set(ref.uuid, ref);
  };

  let projectUuid = row.project;
  if (!projectUuid && row.heading) {
    const heading = fetchTaskByUuid(db, row.heading);
    projectUuid = heading?.project ?? null;
  }
  let areaUuid = row.area;
  if (projectUuid) {
    const project = fetchTaskByUuid(db, projectUuid);
    if (project) {
      addAll(fetchTagsForTasks(db, [project.uuid]).get(project.uuid) ?? []);
      areaUuid = areaUuid ?? project.area;
    }
  }
  if (areaUuid) addAll(areaTags(db, areaUuid));

  const direct = new Set(
    (fetchTagsForTasks(db, [row.uuid]).get(row.uuid) ?? []).map((t) => t.uuid),
  );
  return [...collected.values()].filter((t) => !direct.has(t.uuid));
}
