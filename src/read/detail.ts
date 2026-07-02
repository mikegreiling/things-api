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
  if (row.type === 1) {
    const project = mapProject(row, refs, tags);
    project.inheritedTags = inheritedTagsFor(db, row);
    return project;
  }
  const todo = mapTodo(row, refs, tags);
  todo.inheritedTags = inheritedTagsFor(db, row);
  todo.checklist = checklistFor(db, row.uuid);
  return todo;
}

export function checklistFor(db: DatabaseSync, taskUuid: string): ChecklistItem[] {
  return fetchChecklistRows(db, taskUuid).map(mapChecklistItem);
}
