/**
 * List views mirroring the Things sidebar. Predicates derived from the
 * validated research plus live probes (docs/atlas/schema-v26.md):
 *
 * - inbox:    start=0
 * - today:    (startDate <= today AND start IN (1, 2)) OR a DUE DEADLINE
 *             with no startDate — a due/overdue deadline pulls an item into
 *             Today even from the Inbox; a FUTURE startDate suppresses it
 *             (UI-oracle research, lab 2026-07-04, two reproducing runs —
 *             docs/lab/today-order-research.md; this CORRECTS the earlier
 *             "deadline-only items never enter Today" badge inference, which
 *             held only while no deadline-only item was actually due).
 *             ORDER: startBucket, then todayIndexReferenceDate DESC (the
 *             date the item ENTERED Today — newest cohorts on top), then
 *             todayIndex ASC, then uuid (observed stable tiebreak). start=2
 *             rows with a past date are "pending promotion" (Things
 *             recomputes on launch; the UI shows them in Today either way).
 *             THIS EVENING expires daily: an item renders in the Evening
 *             section only when startBucket=1 AND startDate == today exactly;
 *             overdue bucket=1 items roll back into Today proper (live-
 *             verified against the UI, 2026-07-02).
 *             Sidebar badge split: red = items with deadline <= today,
 *             gray = the rest (exact 270/122 reconciliation on live data).
 * - anytime:  ALL active items — unscheduled PLUS Today members (the UI
 *             renders Today members with a star; live-verified via screenshot
 *             2026-07-02: starred = in Today, unstarred = unscheduled).
 *             Star equivalence: startDate != NULL && <= today.
 * - upcoming: start=2 AND startDate > today, PLUS each fixed repeating
 *             template's next occurrence synthesized from
 *             rt1_nextInstanceStartDate (UI parity; opt out via
 *             repeats:false). Occurrence deadline = start − rule.ts
 *             (instance-validated 2026-07-04).
 * - someday:  start=2 AND startDate IS NULL
 * - logbook:  status IN (2,3), by stopDate DESC
 * - trash:    trashed=1
 *
 * All views: to-dos + projects (type IN (0,1)), open (unless noted),
 * untrashed (unless trash), repeating TEMPLATE rows excluded.
 */
import type { DatabaseSync } from "node:sqlite";

import { addDaysIso, encodePackedDate, localToday } from "../model/dates.ts";
import type { Project, Todo } from "../model/entities.ts";
import { mapProject, mapTodo, type TaskRow } from "../model/mappers.ts";
import { decodeRecurrenceRule } from "../model/recurrence.ts";
import {
  fetchTagsForTasks,
  fetchTaskRows,
  makeRefResolver,
  NOT_TEMPLATE,
  resolveAreaUuid,
  resolveProjectUuid,
  resolveTagUuid,
  tagScopeBinds,
  tagScopeSql,
  tagWithDescendants,
} from "./queries.ts";

export type ListItem = Todo | Project;

/** Optional list-view filters. */
export interface ViewFilter {
  /**
   * Tag (uuid or unique title): direct OR inherited membership (UI
   * semantics), INCLUDING items tagged with a hierarchy descendant of the
   * given tag (documented app behavior — the UI's tag filter matches
   * child-tagged items; not lab-oracled).
   */
  tag?: string;
  /**
   * Match the given tag ONLY — no hierarchy descendants. Useful when a
   * parent tag has its own direct assignments distinct from its children's.
   */
  exactTag?: boolean;
}

function tagFilter(
  db: DatabaseSync,
  filter: ViewFilter | undefined,
): { sql: string; binds: string[] } {
  if (filter?.tag === undefined) return { sql: "", binds: [] };
  const target = resolveTagUuid(db, filter.tag);
  const uuids = filter.exactTag === true ? [target] : tagWithDescendants(db, target);
  return { sql: ` AND ${tagScopeSql(uuids.length)}`, binds: tagScopeBinds(uuids) };
}

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

export function todayView(db: DatabaseSync, now?: Date, filter?: ViewFilter): TodayView {
  const todayIso = localToday(now);
  const packedToday = encodePackedDate(todayIso);
  const tf = tagFilter(db, filter);
  // Membership + comparator per the UI-oracle research (lab, 2026-07-04;
  // docs/lab/today-order-research.md, two reproducing runs + exact live
  // reconciliation: 405 − 12 suppressed = 393 = the UI's own count):
  //  - a DUE DEADLINE pulls an item into Today even from the Inbox, unless a
  //    FUTURE startDate suppresses it (F-DL-TODAY / F-DL-FUTURE-START) or
  //    the user dismissed the nag (deadlineSuppressionDate stores the
  //    dismissed deadline; all 12 live absentees carried it);
  //  - order = newest-entry cohorts first: todayIndexReferenceDate DESC
  //    (the date the item ENTERED Today: its startDate, or its deadline for
  //    deadline-driven members), then todayIndex ASC, then uuid (observed
  //    stable tiebreak).
  const rows = fetchTaskRows(
    db,
    `${OPEN} AND (
       (t.startDate IS NOT NULL AND t.startDate <= ? AND t.start IN (1, 2))
       OR (t.deadline IS NOT NULL AND t.deadline <= ? AND t.startDate IS NULL
           AND (t.deadlineSuppressionDate IS NULL OR t.deadlineSuppressionDate < t.deadline))
     )${tf.sql}
     ORDER BY t.startBucket ASC,
              COALESCE(t.todayIndexReferenceDate, t.startDate, t.deadline) DESC,
              t.todayIndex ASC, t.uuid ASC`,
    [packedToday, packedToday, ...tf.binds],
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

export function inboxView(db: DatabaseSync, filter?: ViewFilter): ListItem[] {
  const tf = tagFilter(db, filter);
  const rows = fetchTaskRows(
    db,
    `${OPEN} AND t.start = 0${tf.sql} ORDER BY t."index" ASC`,
    tf.binds,
  );
  return materialize(db, rows);
}

export function anytimeView(db: DatabaseSync, now?: Date, filter?: ViewFilter): ListItem[] {
  const packedToday = encodePackedDate(localToday(now));
  const tf = tagFilter(db, filter);
  // Mirrors UI membership: every active item, including Today members
  // (starred in the UI) and pending-promotion rows (start=2, past-dated).
  const rows = fetchTaskRows(
    db,
    `${OPEN} AND (
       (t.start = 1 AND (t.startDate IS NULL OR t.startDate <= ?))
       OR (t.start = 2 AND t.startDate IS NOT NULL AND t.startDate <= ?)
     )${tf.sql} ORDER BY t."index" ASC`,
    [packedToday, packedToday, ...tf.binds],
  );
  return materialize(db, rows);
}

/** The UI's star marker in Anytime: the item is also a Today member. */
export function isTodayMember(item: ListItem, now?: Date): boolean {
  return item.startDate !== null && item.startDate <= localToday(now);
}

export interface UpcomingFilter extends ViewFilter {
  /** Include repeating templates' next occurrences (UI parity; default true). */
  repeats?: boolean;
}

export function upcomingView(db: DatabaseSync, now?: Date, filter?: UpcomingFilter): ListItem[] {
  const packedToday = encodePackedDate(localToday(now));
  const tf = tagFilter(db, filter);
  const rows = fetchTaskRows(
    db,
    `${OPEN} AND t.start = 2 AND t.startDate IS NOT NULL AND t.startDate > ?${tf.sql}
     ORDER BY t.startDate ASC, t."index" ASC`,
    [packedToday, ...tf.binds],
  );
  const items = materialize(db, rows);
  if (filter?.repeats === false) return items;

  // UI parity: repeating templates surface at their app-materialized next
  // occurrence (rt1_nextInstanceStartDate). Fixed rules only — after-
  // completion templates carry no next date until the prior instance
  // resolves; paused templates are excluded. The occurrence deadline follows
  // the instance-validated model: deadline = startDate − rule.startOffsetDays.
  const templateRows = fetchTaskRows(
    db,
    `t.type IN (0, 1) AND t.trashed = 0 AND t.status = 0
     AND (t.rt1_recurrenceRule IS NOT NULL OR t.repeater IS NOT NULL)
     AND t.rt1_instanceCreationPaused = 0
     AND t.rt1_nextInstanceStartDate IS NOT NULL AND t.rt1_nextInstanceStartDate > ?${tf.sql}
     ORDER BY t.rt1_nextInstanceStartDate ASC, t."index" ASC`,
    [packedToday, ...tf.binds],
  );
  const rawByUuid = new Map(templateRows.map((r) => [r.uuid, r.rt1_recurrenceRule]));
  const occurrences = materialize(db, templateRows).map((template) => {
    const startDate = template.repeating.nextOccurrence ?? null;
    // Only the rule-derived deadline is real: the template row's own deadline
    // column carries app-internal sentinels (4001-01-01 observed live).
    let deadline: string | null = null;
    const raw = rawByUuid.get(template.uuid);
    if (startDate !== null && raw !== null && raw !== undefined) {
      try {
        const rule = decodeRecurrenceRule(raw);
        if (rule.startOffsetDays < 0) deadline = addDaysIso(startDate, -rule.startOffsetDays);
      } catch {
        // undecodable rule (future Things build) → occurrence without a derived deadline
      }
    }
    return { ...template, startDate, deadline };
  });

  return [...items, ...occurrences].toSorted(
    (a, b) =>
      (a.startDate ?? "").localeCompare(b.startDate ?? "") ||
      a.index - b.index ||
      a.uuid.localeCompare(b.uuid),
  );
}

export function somedayView(db: DatabaseSync, filter?: ViewFilter): ListItem[] {
  const tf = tagFilter(db, filter);
  const rows = fetchTaskRows(
    db,
    `${OPEN} AND t.start = 2 AND t.startDate IS NULL${tf.sql} ORDER BY t."index" ASC`,
    tf.binds,
  );
  return materialize(db, rows);
}

export function logbookView(
  db: DatabaseSync,
  options?: { limit?: number; tag?: string },
): ListItem[] {
  const limit = options?.limit ?? 100;
  const tf = tagFilter(db, options);
  const rows = fetchTaskRows(
    db,
    `${LIVE} AND t.status IN (2, 3)${tf.sql} ORDER BY t.stopDate DESC LIMIT ?`,
    [...tf.binds, limit],
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

export interface SearchOptions extends ViewFilter {
  limit?: number;
  /** Restrict to one project's children (headed children included). */
  project?: string;
  /** Restrict to one area's direct members. */
  area?: string;
  type?: "to-do" | "project";
  /** Include completed/canceled items (default: open only). */
  logged?: boolean;
  /** Include trashed items (default: untrashed only). */
  trashed?: boolean;
  /** Everything — the legacy behavior (open + logged + trashed). */
  all?: boolean;
}

export type ChangeKind = "created" | "modified";
export type ChangedItem = ListItem & { changeKind: ChangeKind };

/**
 * Everything that changed since a moment — created or modified TMTask rows,
 * INCLUDING trashed, logged, and repeating-template rows (an agent syncing
 * state needs to see deletions and template edits too; check `trashed`,
 * `status`, and `repeating.isTemplate` on each item). Caveats: TMArea/TMTag
 * carry no modification dates, and checklist-item edits do not bump the
 * parent task — those changes are invisible here.
 */
export function changesView(
  db: DatabaseSync,
  options: { since: Date; limit?: number },
): ChangedItem[] {
  const limit = options.limit ?? 200;
  const sinceEpoch = options.since.getTime() / 1000;
  const rows = fetchTaskRows(
    db,
    `t.type IN (0, 1) AND t.userModificationDate > ?
     ORDER BY t.userModificationDate DESC LIMIT ?`,
    [sinceEpoch, limit],
  );
  return materialize(db, rows).map((item, i) => ({
    ...item,
    changeKind:
      (rows[i]?.creationDate ?? 0) > sinceEpoch ? ("created" as const) : ("modified" as const),
  }));
}

export function searchView(db: DatabaseSync, query: string, options?: SearchOptions): ListItem[] {
  const limit = options?.limit ?? 50;
  const needle = `%${query}%`;
  const where: string[] = [`${NOT_TEMPLATE} AND (t.title LIKE ? OR t.notes LIKE ?)`];
  const binds: unknown[] = [needle, needle];

  where.push(
    options?.type === "to-do"
      ? "t.type = 0"
      : options?.type === "project"
        ? "t.type = 1"
        : "t.type IN (0, 1)",
  );

  // Scope: open + untrashed by default; --logged/--trashed widen; --all is
  // the legacy include-everything behavior.
  if (options?.all !== true) {
    const statuses = options?.logged === true ? "(0, 2, 3)" : "(0)";
    where.push(`t.status IN ${statuses}`);
    if (options?.trashed !== true) where.push("t.trashed = 0");
  }

  if (options?.project !== undefined) {
    const uuid = resolveProjectUuid(db, options.project);
    // Children incl. headed ones (heading rows carry the project link).
    where.push(
      "(t.project = ? OR t.heading IN (SELECT uuid FROM TMTask WHERE type = 2 AND project = ?))",
    );
    binds.push(uuid, uuid);
  }
  if (options?.area !== undefined) {
    const uuid = resolveAreaUuid(db, options.area);
    where.push("t.area = ?");
    binds.push(uuid);
  }
  const tf = tagFilter(db, options);
  const rows = fetchTaskRows(
    db,
    `${where.join(" AND ")}${tf.sql}
     ORDER BY t.userModificationDate DESC LIMIT ?`,
    [...binds, ...tf.binds, limit],
  );
  return materialize(db, rows);
}
