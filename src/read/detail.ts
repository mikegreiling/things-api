/**
 * Single-record reads by UUID — includes repeating templates (which list
 * views hide), checklist items, and inherited tags.
 */
import type { DatabaseSync } from "node:sqlite";

import type { AnyTask, ChecklistItem } from "../model/entities.ts";
import {
  mapChecklistItem,
  mapHeading,
  mapProject,
  mapTodo,
  type TaskRow,
} from "../model/mappers.ts";
import { decodeRecurrenceRule } from "../model/recurrence.ts";
import {
  fetchChecklistRows,
  fetchTagsForTasks,
  fetchTaskByUuid,
  makeRefResolver,
} from "./queries.ts";
import { inheritedTagsFor } from "./tags.ts";

export function byUuid(db: DatabaseSync, uuid: string): AnyTask | null {
  const row = fetchTaskByUuid(db, uuid);
  if (!row) return null;
  return materializeOne(db, row);
}

function materializeOne(db: DatabaseSync, row: TaskRow): AnyTask {
  const refs = makeRefResolver(db);
  if (row.type === 2) return mapHeading(row, refs);
  const tags = fetchTagsForTasks(db, [row.uuid]).get(row.uuid) ?? [];
  const entity = row.type === 1 ? mapProject(row, refs, tags) : mapTodo(row, refs, tags);
  entity.inheritedTags = inheritedTagsFor(db, row);
  if (entity.type === "to-do") entity.checklist = checklistFor(db, row.uuid);
  if (entity.repeating.isTemplate && row.rt1_recurrenceRule !== null) {
    try {
      entity.repeating.rule = decodeRecurrenceRule(row.rt1_recurrenceRule);
    } catch {
      // Unknown rule schema (future Things build) — surface the template
      // without a decoded rule rather than failing the whole read.
    }
  }
  return entity;
}

export function checklistFor(db: DatabaseSync, taskUuid: string): ChecklistItem[] {
  return fetchChecklistRows(db, taskUuid).map(mapChecklistItem);
}
