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
import type { Area, InheritedTag, Ref, Tag } from "../model/entities.ts";
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

/**
 * The `things tags` listing: the tag TREE, depth-first, so a child always
 * FOLLOWS its parent. Siblings (and roots) order by canonical `TMTag."index"`
 * (the app's Tags-window rank), UUID tiebreak (TAGORD1 oracle — the Tags-window
 * order for index-tied tags is uuid-ascending, not alphabetical; see
 * fetchTagsForTasks).
 *
 * DFS is unambiguous here and matches the Tags window: this is a listing of the
 * hierarchy itself, where the parent→child relationship is the structure. That
 * is DISTINCT from a flat multi-tag pill row (fetchTagsForTasks / areaTags),
 * where the ratified order is flat ascending `index` and the nested-tag
 * interleave is an open question — see fetchTagsForTasks for that caveat.
 */
export function tagsView(db: DatabaseSync): Tag[] {
  const rows = db
    .prepare(`SELECT ${selectList("TMTag")} FROM TMTag ORDER BY ${q("index")} ASC, uuid ASC`)
    .all() as unknown as TagRow[];
  const byUuid = new Map(rows.map((r) => [r.uuid, r]));
  // Children grouped under their parent uuid, each list already in index/title
  // order (the SQL sort is stable and preserves the sibling ordering).
  const childrenOf = new Map<string, TagRow[]>();
  for (const row of rows) {
    if (!row.parent) continue;
    (childrenOf.get(row.parent) ?? childrenOf.set(row.parent, []).get(row.parent)!).push(row);
  }
  const out: Tag[] = [];
  const seen = new Set<string>();
  const visit = (row: TagRow): void => {
    if (seen.has(row.uuid)) return; // cycle guard (bad parent data can't loop)
    seen.add(row.uuid);
    const parentRow = row.parent ? byUuid.get(row.parent) : undefined;
    out.push({
      title: row.title ?? "",
      shortcut: row.shortcut,
      // Parent tag's NAME (null for a root) — the tree is reconstructable from
      // names alone; tag uuids are never surfaced.
      parent: parentRow ? (parentRow.title ?? "") : null,
    });
    for (const child of childrenOf.get(row.uuid) ?? []) visit(child);
  };
  // Roots first (no parent, or an orphan whose parent uuid is absent), in index
  // order; DFS pulls each subtree. A final pass emits any row a parent cycle
  // left unreached, so the listing never silently drops a tag.
  for (const row of rows) if (!row.parent || !byUuid.has(row.parent)) visit(row);
  for (const row of rows) visit(row);
  return out;
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
    // Surface area tags by NAME only (tag uuids are internal).
    tags: areaTags(db, row.uuid).map((t) => ({ title: t.title })),
  }));
}

export function areaTags(db: DatabaseSync, areaUuid: string): Ref[] {
  // Canonical pill order: ascending TMTag."index" (the app's Tags-window rank),
  // UUID tiebreak. Same comparator + nested-tag caveat as fetchTagsForTasks.
  const rows = db
    .prepare(
      `SELECT tg.uuid AS uuid, tg.title AS title
       FROM TMAreaTag at JOIN TMTag tg ON tg.uuid = at.tags
       WHERE at.areas = ? ORDER BY tg.${q("index")}, tg.uuid`,
    )
    .all(areaUuid) as unknown as Array<{ uuid: string; title: string | null }>;
  return rows.map((r) => ({ uuid: r.uuid, title: r.title ?? "" }));
}

/**
 * Tags inherited from ancestors (the heading's project, the project, the area),
 * each carrying its provenance {@link InheritedTag}. The item's OWN direct tags
 * are excluded (they render on the `tags:` line, not here).
 *
 * PROVENANCE: sources are ONLY `project`/`area` — a heading cannot be tagged
 * (TAGINH1, VM-verified), so it is never a source even for a heading-nested
 * to-do (its project link lives on the heading; the tag still comes from the
 * project). NEAREST ancestor wins when a tag sits on both the project and its
 * area: the project (nearer) is collected first and not overwritten.
 *
 * ORDER: the merged inherited set is returned in the app's CANONICAL tag order
 * — `TMTag."index"`, uuid tiebreak (TAGORD1) — the SAME comparator the direct
 * pill row uses (fetchTagsForTasks), applied across the project+area union.
 */
export function inheritedTagsFor(db: DatabaseSync, row: TaskRow): InheritedTag[] {
  // Work with uuid-carrying rows INTERNALLY (dedup + canonical ranking need the
  // uuid); the surfaced InheritedTag carries the tag NAME only.
  const collected = new Map<string, { ref: Ref; source: InheritedTag["source"] }>();
  const addAll = (refs: Ref[], source: InheritedTag["source"]) => {
    for (const ref of refs) if (!collected.has(ref.uuid)) collected.set(ref.uuid, { ref, source });
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
      addAll(fetchTagsForTasks(db, [project.uuid]).get(project.uuid) ?? [], {
        type: "project",
        uuid: project.uuid,
        title: project.title ?? "",
      });
      areaUuid = areaUuid ?? project.area;
    }
  }
  if (areaUuid) {
    const areaRow = db.prepare("SELECT title FROM TMArea WHERE uuid = ?").get(areaUuid) as
      | { title: string | null }
      | undefined;
    addAll(areaTags(db, areaUuid), { type: "area", uuid: areaUuid, title: areaRow?.title ?? "" });
  }

  const direct = new Set(
    (fetchTagsForTasks(db, [row.uuid]).get(row.uuid) ?? []).map((t) => t.uuid),
  );
  const result = [...collected.values()].filter((i) => !direct.has(i.ref.uuid));
  if (result.length > 1) {
    // Re-rank the project+area union in one canonical `index, uuid` pass so the
    // merged inherited chips match the GUI's tag order (the per-source lists
    // arrive already ordered, but their concatenation is not globally sorted).
    const rank = new Map<string, number>();
    const uuids = result.map((i) => i.ref.uuid);
    const rows = db
      .prepare(
        `SELECT uuid FROM TMTag WHERE uuid IN (${uuids.map(() => "?").join(", ")})
         ORDER BY ${q("index")}, uuid`,
      )
      .all(...uuids) as { uuid: string }[];
    rows.forEach((r, i) => rank.set(r.uuid, i));
    result.sort((a, b) => (rank.get(a.ref.uuid) ?? 0) - (rank.get(b.ref.uuid) ?? 0));
  }
  // Surface the tag NAME only (uuid stays internal).
  return result.map((i) => ({ tag: { title: i.ref.title }, source: i.source }));
}
