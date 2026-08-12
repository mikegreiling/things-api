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
import { decodePackedDate, encodePackedDate, localToday } from "../model/dates.ts";
import type { RepeatContext } from "../model/entities.ts";
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
  // The mirror of the template's Show-Latest join, from the INSTANCE side: the
  // GUI's lower-corner repeat caption ("Repeats on Aug 19" / "Repeats 1 day after
  // completion") is the instance's TEMPLATE context. Resolve `templateUuid` back
  // to the template row and read its rule + projected next occurrence, so the
  // wire `repeats` sibling of `instanceOf` (and the TTY line) render from the same
  // decoded rule the template card emits — one recurrence vocabulary, byte-
  // consistent. Detail-only (never on list/card rows — token economy).
  if (entity.repeating.isInstance && entity.repeating.templateUuid !== null) {
    const ctx = repeatContextFor(db, entity.repeating.templateUuid);
    if (ctx !== null) entity.repeating.repeats = ctx;
  }
  return entity;
}

/**
 * Join a repeating INSTANCE'S template context: fetch the template row by uuid,
 * decode its rule, and project its next occurrence. Returns null on a DANGLING
 * FK (the template row is gone — the instance still renders, just without the
 * caption) OR when the template carries nothing surfaceable. `next` is the
 * template's app-materialized next occurrence and rides ONLY for a FIXED rule
 * (after-completion has no successor date until the current instance completes —
 * absence is the honest expression; the mode stays readable from `rule.type`).
 * The `paused` flag is surfaced so the card can render honestly.
 */
function repeatContextFor(db: DatabaseSync, templateUuid: string): RepeatContext | null {
  const tmpl = fetchTaskByUuid(db, templateUuid);
  if (tmpl === null) return null; // dangling FK — no caption, no crash
  const ctx: RepeatContext = {};
  if (tmpl.rt1_recurrenceRule !== null) {
    try {
      ctx.rule = decodeRecurrenceRule(tmpl.rt1_recurrenceRule);
    } catch {
      // Undecodable rule (future Things build) — mirror the template card and
      // surface the instance without a decoded rule rather than failing.
    }
  }
  // FIXED mode only: the template's projected next occurrence IS the "Aug 19".
  if (ctx.rule?.type === "fixed") {
    const next = decodePackedDate(tmpl.rt1_nextInstanceStartDate);
    if (next !== null) ctx.next = next;
  }
  if (tmpl.rt1_instanceCreationPaused === 1) ctx.paused = true;
  // Presence-keyed: an instance of a template with no decodable rule, no next,
  // and not paused carries no caption — omit `repeats` entirely (like a dangling FK).
  return ctx.rule === undefined && ctx.next === undefined && ctx.paused === undefined ? null : ctx;
}

export function checklistFor(db: DatabaseSync, taskUuid: string): ChecklistItem[] {
  return fetchChecklistRows(db, taskUuid).map(mapChecklistItem);
}
