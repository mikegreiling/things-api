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
import { encodePackedDate, localToday } from "../model/dates.ts";
import {
  fetchChecklistRows,
  fetchTagsForTasks,
  fetchTaskByUuid,
  latestInstanceUuid,
  makeHeadingProjectResolver,
  makeRefResolver,
} from "./queries.ts";
import { logBoundary, markLogged } from "./log-boundary.ts";
import { inheritedTagsFor } from "./tags.ts";

// `now`/`zone` supply the evaluation clock used to gate the today/evening markers
// (and reminder liveness) in the mapper. They default to the host clock —
// matching this module's existing logBoundary default; the client facade passes
// the injected clock so a pinned-clock `show` reads under the consumer's Today.
export function byUuid(
  db: DatabaseSync,
  uuid: string,
  now: Date = new Date(),
  zone?: string,
): AnyTask | null {
  const row = fetchTaskByUuid(db, uuid);
  if (!row) return null;
  return materializeOne(db, row, encodePackedDate(localToday(now, zone)));
}

function materializeOne(db: DatabaseSync, row: TaskRow, packedToday: number): AnyTask {
  const refs = makeRefResolver(db);
  if (row.type === 2) return mapHeading(row, refs);
  const tags = fetchTagsForTasks(db, [row.uuid]).get(row.uuid) ?? [];
  const entity =
    row.type === 1
      ? mapProject(row, refs, tags, packedToday)
      : mapTodo(row, refs, tags, packedToday);
  markLogged([entity], logBoundary(db));
  entity.inheritedTags = inheritedTagsFor(db, row);
  if (entity.type === "to-do") {
    entity.checklist = checklistFor(db, row.uuid);
    // Container parity with list views: resolve the owning project through
    // the heading (project itself stays null — DB truth).
    if (entity.heading !== null) {
      const p = makeHeadingProjectResolver(db)(entity.heading.uuid);
      if (p !== null) entity.headingProject = p;
    }
  }
  if (entity.repeating.isTemplate) {
    if (row.rt1_recurrenceRule !== null) {
      try {
        entity.repeating.rule = decodeRecurrenceRule(row.rt1_recurrenceRule);
      } catch {
        // Unknown rule schema (future Things build) — surface the template
        // without a decoded rule rather than failing the whole read.
      }
    }
    // The GUI "Show Latest" pick (SL1) — detail-only; the shaper emits it NESTED
    // inside the wire `repeating` object. Omitted when the template has none.
    const latest = latestInstanceUuid(db, row.uuid);
    if (latest !== null) entity.repeating.latestInstance = latest;
  }
  return entity;
}

export function checklistFor(db: DatabaseSync, taskUuid: string): ChecklistItem[] {
  return fetchChecklistRows(db, taskUuid).map(mapChecklistItem);
}
