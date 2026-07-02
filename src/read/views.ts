/**
 * List views mirroring the Things sidebar. Predicates derived from the
 * validated research plus live probes (docs/atlas/schema-v26.md):
 *
 * - inbox:    start=0
 * - today:    startDate <= today AND start IN (1, 2) — start=2 rows with a
 *             past date are "pending promotion" (Things recomputes on launch;
 *             the UI shows them in Today either way; promotion observed live
 *             2026-07-02). Ordered by todayIndex (validated comparator).
 *             THIS EVENING expires daily: an item renders in the Evening
 *             section only when startBucket=1 AND startDate == today exactly;
 *             overdue bucket=1 items roll back into Today proper (live-
 *             verified against the UI, 2026-07-02).
 *             Sidebar badge split: red = items with deadline <= today,
 *             gray = the rest (exact 270/122 reconciliation on live data).
 *             Deadline-only items (no qualifying startDate) do NOT enter
 *             Today — proven by that same badge-sum reconciliation.
 * - anytime:  start=1 AND startDate IS NULL (strictly unscheduled active).
 * - upcoming: start=2 AND startDate > today (matches things.py semantics;
 *             repeating templates' next occurrences are NOT included — they
 *             are template rows, surfaced separately later).
 * - someday:  start=2 AND startDate IS NULL
 * - logbook:  status IN (2,3), by stopDate DESC
 * - trash:    trashed=1
 *
 * All views: to-dos + projects (type IN (0,1)), open (unless noted),
 * untrashed (unless trash), repeating TEMPLATE rows excluded.
 */
import type { DatabaseSync } from "node:sqlite";

import { encodePackedDate, localToday } from "../model/dates.ts";
import type { Project, Todo } from "../model/entities.ts";
import { mapProject, mapTodo, type TaskRow } from "../model/mappers.ts";
import { fetchTagsForTasks, fetchTaskRows, makeRefResolver, NOT_TEMPLATE } from "./queries.ts";

export type ListItem = Todo | Project;

const LIVE = `t.type IN (0, 1) AND t.trashed = 0 AND ${NOT_TEMPLATE}`;
const OPEN = `${LIVE} AND t.status = 0`;

function materialize(db: DatabaseSync, rows: TaskRow[]): ListItem[] {
  const refs = makeRefResolver(db);
  const tags = fetchTagsForTasks(
    db,
    rows.map((r) => r.uuid),
  );
  return rows.map((row) =>
    row.type === 1
      ? mapProject(row, refs, tags.get(row.uuid) ?? [])
      : mapTodo(row, refs, tags.get(row.uuid) ?? []),
  );
}

export interface TodayView {
  today: ListItem[];
  evening: ListItem[];
  /** Mirrors the sidebar badge: red = deadline due/overdue, gray = the rest. */
  badge: { dueOrOverdue: number; other: number };
}

export function todayView(db: DatabaseSync, now?: Date): TodayView {
  const todayIso = localToday(now);
  const packedToday = encodePackedDate(todayIso);
  const rows = fetchTaskRows(
    db,
    `${OPEN} AND t.startDate IS NOT NULL AND t.startDate <= ? AND t.start IN (1, 2)
     ORDER BY t.startBucket ASC, t.todayIndex ASC`,
    [packedToday],
  );
  const items = materialize(db, rows);
  // Evening membership expires daily: raw startBucket=1 counts only while
  // startDate is exactly today; stale evening items belong to Today proper.
  const isEvening = (i: ListItem) => i.todaySection === "evening" && i.startDate === todayIso;
  const dueOrOverdue = items.filter((i) => i.deadline !== null && i.deadline <= todayIso).length;
  return {
    today: items.filter((i) => !isEvening(i)),
    evening: items.filter(isEvening),
    badge: { dueOrOverdue, other: items.length - dueOrOverdue },
  };
}

export function inboxView(db: DatabaseSync): ListItem[] {
  const rows = fetchTaskRows(db, `${OPEN} AND t.start = 0 ORDER BY t."index" ASC`);
  return materialize(db, rows);
}

export function anytimeView(db: DatabaseSync): ListItem[] {
  const rows = fetchTaskRows(
    db,
    `${OPEN} AND t.start = 1 AND t.startDate IS NULL ORDER BY t."index" ASC`,
  );
  return materialize(db, rows);
}

export function upcomingView(db: DatabaseSync, now?: Date): ListItem[] {
  const packedToday = encodePackedDate(localToday(now));
  const rows = fetchTaskRows(
    db,
    `${OPEN} AND t.start = 2 AND t.startDate IS NOT NULL AND t.startDate > ?
     ORDER BY t.startDate ASC, t."index" ASC`,
    [packedToday],
  );
  return materialize(db, rows);
}

export function somedayView(db: DatabaseSync): ListItem[] {
  const rows = fetchTaskRows(
    db,
    `${OPEN} AND t.start = 2 AND t.startDate IS NULL ORDER BY t."index" ASC`,
  );
  return materialize(db, rows);
}

export function logbookView(db: DatabaseSync, options?: { limit?: number }): ListItem[] {
  const limit = options?.limit ?? 100;
  const rows = fetchTaskRows(
    db,
    `${LIVE} AND t.status IN (2, 3) ORDER BY t.stopDate DESC LIMIT ?`,
    [limit],
  );
  return materialize(db, rows);
}

export function trashView(db: DatabaseSync, options?: { limit?: number }): ListItem[] {
  const limit = options?.limit ?? 200;
  const rows = fetchTaskRows(
    db,
    `t.type IN (0, 1) AND t.trashed = 1 AND ${NOT_TEMPLATE}
     ORDER BY t.userModificationDate DESC LIMIT ?`,
    [limit],
  );
  return materialize(db, rows);
}

export function projectsView(db: DatabaseSync, options?: { areaUuid?: string }): Project[] {
  const where = options?.areaUuid
    ? `${OPEN} AND t.type = 1 AND t.area = ? ORDER BY t."index" ASC`
    : `${OPEN} AND t.type = 1 ORDER BY t."index" ASC`;
  const rows = fetchTaskRows(db, where, options?.areaUuid ? [options.areaUuid] : []);
  return materialize(db, rows) as Project[];
}

export function searchView(
  db: DatabaseSync,
  query: string,
  options?: { limit?: number },
): ListItem[] {
  const limit = options?.limit ?? 50;
  const needle = `%${query}%`;
  const rows = fetchTaskRows(
    db,
    `t.type IN (0, 1) AND ${NOT_TEMPLATE} AND (t.title LIKE ? OR t.notes LIKE ?)
     ORDER BY t.userModificationDate DESC LIMIT ?`,
    [needle, needle, limit],
  );
  return materialize(db, rows);
}
