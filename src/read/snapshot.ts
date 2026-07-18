/**
 * Full normalized dump of the library — every TMTask row (all types and
 * states, including repeating templates and trashed rows), all areas, tags,
 * and checklist items. UUID-ordered for stable diffing; the lab harness and
 * pre/post-mutation forensics both consume this.
 */
import type { DatabaseSync } from "node:sqlite";

import { q, selectList } from "../db/schema.ts";
import type { AnyTask, Area, ChecklistItem, Tag } from "../model/entities.ts";
import {
  mapChecklistItem,
  mapHeading,
  mapProject,
  mapTodo,
  type ChecklistRow,
} from "../model/mappers.ts";
import { encodePackedDate, localToday } from "../model/dates.ts";
import { fetchTagsForTasks, fetchTaskRows, makeRefResolver } from "./queries.ts";
import { logBoundary, markLogged } from "./log-boundary.ts";
import { areasView, tagsView } from "./tags.ts";

export interface Snapshot {
  areas: Area[];
  tags: Tag[];
  tasks: AnyTask[];
  checklistItems: ChecklistItem[];
  counts: {
    areas: number;
    tags: number;
    todos: number;
    projects: number;
    headings: number;
    checklistItems: number;
    trashed: number;
    repeatingTemplates: number;
  };
}

// `now`/`zone` supply the evaluation clock used to gate `todaySection` to Today
// members (mappers.mapTodaySection); they default to the host clock, matching
// this module's existing logBoundary default.
export function snapshotView(db: DatabaseSync, now: Date = new Date(), zone?: string): Snapshot {
  const areas = areasView(db);
  const tags = tagsView(db);
  const rows = fetchTaskRows(db, "1=1 ORDER BY t.uuid ASC");
  const refs = makeRefResolver(db);
  const packedToday = encodePackedDate(localToday(now, zone));
  const tagMap = fetchTagsForTasks(
    db,
    rows.map((r) => r.uuid),
  );
  const tasks: AnyTask[] = rows.map((row) => {
    if (row.type === 2) return mapHeading(row, refs);
    const rowTags = tagMap.get(row.uuid) ?? [];
    return row.type === 1
      ? mapProject(row, refs, rowTags, packedToday)
      : mapTodo(row, refs, rowTags, packedToday);
  });
  markLogged(
    tasks.filter((t): t is Exclude<AnyTask, { type: "heading" }> => t.type !== "heading"),
    logBoundary(db),
  );
  const checklistRows = db
    .prepare(
      `SELECT ${selectList("TMChecklistItem")} FROM TMChecklistItem ORDER BY ${q("uuid")} ASC`,
    )
    .all() as unknown as ChecklistRow[];
  const checklistItems = checklistRows.map(mapChecklistItem);

  return {
    areas,
    tags,
    tasks,
    checklistItems,
    counts: {
      areas: areas.length,
      tags: tags.length,
      todos: rows.filter((r) => r.type === 0).length,
      projects: rows.filter((r) => r.type === 1).length,
      headings: rows.filter((r) => r.type === 2).length,
      checklistItems: checklistItems.length,
      trashed: rows.filter((r) => r.trashed === 1).length,
      repeatingTemplates: rows.filter((r) => r.rt1_recurrenceRule !== null || r.repeater !== null)
        .length,
    },
  };
}
