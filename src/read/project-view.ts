/**
 * Composite project view mirroring the native UI (validated T17 + "later
 * items" findings): active items, headings with their children, later
 * (scheduled by date / repeating templates / someday), logged, trashed.
 *
 * Child membership: `project = ? OR heading IN (project's headings)` — the
 * DB invariant is that headed to-dos have project = NULL (atlas §TMTask).
 * This is the dedup-safe alternative to things.py's include_items.
 */
import type { DatabaseSync } from "node:sqlite";

import { encodePackedDate, localToday, decodePackedDate } from "../model/dates.ts";
import type { Heading, IsoDateGroup, Project, Todo } from "../model/entities.ts";
import { mapHeading, mapProject, mapTodo, type TaskRow } from "../model/mappers.ts";
import { fetchTagsForTasks, fetchTaskByUuid, fetchTaskRows, makeRefResolver } from "./queries.ts";
import { logBoundary, markLogged } from "./log-boundary.ts";
import { OVERDUE } from "./predicates.ts";
import { inheritedTagsFor } from "./tags.ts";
import { tagFilter, type ViewFilter } from "./views.ts";

/**
 * A heading group inside a project view. Mirrors the GUI: the heading owns its
 * OWN display sub-buckets (§1 of the demotion/move design) — the anytime/current
 * `items`, its future-dated `scheduled` children grouped per day, its resting
 * `repeating` templates, and its `someday` children. The project-level buckets
 * (below) hold ONLY the UNHEADED members; a headed child lives here, under its
 * heading, never pooled at the project level.
 */
export interface ProjectHeadingGroup {
  heading: Heading;
  /** Open/current children under this heading, by index. */
  items: Todo[];
  /** This heading's future-dated children grouped by date ascending. */
  scheduled: IsoDateGroup<Todo>[];
  /** This heading's someday (incubated, undated) children. */
  someday: Todo[];
  /** This heading's repeating template rows (invisible in list views). */
  repeating: Todo[];
}

export interface ProjectView {
  project: Project;
  /** Open, unscheduled/current UNHEADED children, by index. */
  active: Todo[];
  /** Headings in project order, each with its own sub-buckets. */
  headings: ProjectHeadingGroup[];
  /** UNHEADED future-dated children grouped by date ascending. */
  scheduled: IsoDateGroup<Todo>[];
  /** UNHEADED someday (incubated, undated) children. */
  someday: Todo[];
  /** UNHEADED repeating template rows owned by this project (invisible in list views). */
  repeating: Todo[];
  logged: Todo[];
  trashed: Todo[];
  /**
   * PLOG1 (additive): count of untrashed OPEN (status=0) children this project
   * still holds while it is ITSELF completed or canceled — including once swept
   * to the Logbook. Such items are invisible in every live app view (Today /
   * Anytime / Inbox / Upcoming), reachable only by drilling into this card
   * (the app's GUI "Put Back" into a completed parent can strand them —
   * docs/lab/plog1-research.md). 0 when the project is open, or holds no such
   * child.
   */
  openChildrenWhileResolved: number;
}

export class ProjectNotFoundError extends Error {
  constructor(uuid: string) {
    super(`no project with uuid ${uuid}`);
    this.name = "ProjectNotFoundError";
  }
}

/** A scheduled child, pre-grouping: its ISO date + within-day sort key. */
type ScheduledRow = { date: string; ti: number; todo: Todo };

/** Append `value` to the list at `key`, creating it on first use. */
function pushInto<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

/** Group scheduled rows into per-day buckets (date ASC, within-day todayIndex ASC). */
function groupByDate(rows: ScheduledRow[]): IsoDateGroup<Todo>[] {
  const out: IsoDateGroup<Todo>[] = [];
  for (const { date, todo } of rows.toSorted(
    (a, b) => a.date.localeCompare(b.date) || a.ti - b.ti,
  )) {
    const last = out[out.length - 1];
    if (last && last.date === date) last.items.push(todo);
    else out.push({ date, items: [todo] });
  }
  return out;
}

export function projectView(
  db: DatabaseSync,
  uuid: string,
  now?: Date,
  filter: ViewFilter = {},
  zone?: string,
): ProjectView {
  const overdue = filter.overdue === true;
  const projectRow = fetchTaskByUuid(db, uuid);
  if (!projectRow || projectRow.type !== 1) throw new ProjectNotFoundError(uuid);

  const refs = makeRefResolver(db);
  // The view's injected clock — gates `todaySection` to Today members in the
  // mapper AND drives the scheduled/overdue bucketing below.
  const packedToday = encodePackedDate(localToday(now, zone));
  const tagsOf = (rows: TaskRow[]) =>
    fetchTagsForTasks(
      db,
      rows.map((r) => r.uuid),
    );
  const projectTags = tagsOf([projectRow]);
  const project = mapProject(projectRow, refs, projectTags.get(projectRow.uuid) ?? [], packedToday);
  // The card view surfaces area-inherited tags (the UI's tag filter honors them).
  project.inheritedTags = inheritedTagsFor(db, projectRow);

  const headingRows = fetchTaskRows(
    db,
    `t.type = 2 AND t.project = ? AND t.trashed = 0 ORDER BY t."index" ASC`,
    [uuid],
  );
  const headings = headingRows.map((h) => mapHeading(h, refs));

  // OWN-DEADLINE UNIFORM: `--overdue` narrows the child TO-DOS to those whose
  // OWN deadline is overdue (open, strictly before today) via the shared
  // OVERDUE predicate — NO recursion into anything, and the project header
  // itself always renders. Headings that keep no surviving child collapse
  // (below). Its single packed-today bind trails the two uuid binds.
  const overdueSql = overdue ? ` AND ${OVERDUE}` : "";
  const overdueBinds = overdue ? [encodePackedDate(localToday(now, zone))] : [];
  // Tag scope (§9a): the child to-dos are filtered by a tag carried DIRECTLY on
  // the row — the container semantics. The project's own tags are inherited by
  // EVERY child, so an inheritance-inclusive `--tag` would be vacuous here;
  // suppressing the container hop makes `--tag` mean "children with this tag on
  // themselves" (still descendant-expanded), and `--untagged` "children with no
  // direct tag". No recursion; the header always renders. The tag binds trail
  // the two uuid binds and lead the overdue bind, matching their left-to-right
  // order in the SQL.
  const tf = tagFilter(db, filter, { container: true });
  const childRows = fetchTaskRows(
    db,
    `t.type = 0 AND (t.project = ? OR t.heading IN (
       SELECT uuid FROM TMTask WHERE type = 2 AND project = ?
     ))${tf.sql}${overdueSql}
     ORDER BY t."index" ASC`,
    [uuid, uuid, ...tf.binds, ...overdueBinds],
  );
  const childTags = tagsOf(childRows);
  const boundary = logBoundary(db, now, zone);
  const todos = childRows.map((r) => ({
    row: r,
    todo: mapTodo(r, refs, childTags.get(r.uuid) ?? [], packedToday),
  }));
  markLogged([project, ...todos.map((t) => t.todo)], boundary);

  // Project-level (UNHEADED) buckets.
  const active: Todo[] = [];
  const scheduledRows: ScheduledRow[] = [];
  const repeating: Todo[] = [];
  const someday: Todo[] = [];
  const logged: Todo[] = [];
  const trashed: Todo[] = [];
  // Per-heading sub-buckets, keyed by heading uuid (§9 fidelity fix): a headed
  // scheduled/someday/repeating child nests under its heading, NOT at the
  // project level.
  const headingItems = new Map<string, Todo[]>();
  const headingScheduled = new Map<string, ScheduledRow[]>();
  const headingSomeday = new Map<string, Todo[]>();
  const headingRepeating = new Map<string, Todo[]>();
  // Known (fetched, untrashed) headings — a child whose heading FK is not one
  // of these falls back to the project-level (unheaded) buckets rather than
  // vanishing (mirrors the render's historical loose fallback).
  const headingSet = new Set(headings.map((h) => h.uuid));
  const headingUuidOf = (row: TaskRow): string | null =>
    row.heading !== null && headingSet.has(row.heading) ? row.heading : null;
  // Every untrashed, non-template OPEN child, regardless of which bucket it
  // lands in below — surfaced (only when the project is itself resolved) as
  // the PLOG1 stranded-open-child count.
  let openChildren = 0;

  for (const { row, todo } of todos) {
    if (row.trashed === 1) {
      trashed.push(todo);
      continue;
    }
    const h = headingUuidOf(row);
    if (todo.repeating.isTemplate) {
      if (h !== null) pushInto(headingRepeating, h, todo);
      else repeating.push(todo);
      continue;
    }
    if (row.status === 0) openChildren += 1;
    if (row.status !== 0) {
      // Completion ≠ logged: closed items the log-move sweep has not
      // passed stay checked IN PLACE (their heading / the active block),
      // exactly like the GUI — only logged ones join the Logbook bucket.
      if (todo.logged) {
        logged.push(todo);
        continue;
      }
      if (h !== null) pushInto(headingItems, h, todo);
      else active.push(todo);
      continue;
    }
    if (row.start === 2 && row.startDate === null) {
      if (h !== null) pushInto(headingSomeday, h, todo);
      else someday.push(todo);
      continue;
    }
    if (row.startDate !== null && row.startDate > packedToday) {
      const sr: ScheduledRow = {
        date: decodePackedDate(row.startDate) ?? "",
        ti: row.todayIndex ?? 0,
        todo,
      };
      if (h !== null) pushInto(headingScheduled, h, sr);
      else scheduledRows.push(sr);
      continue;
    }
    if (h !== null) pushInto(headingItems, h, todo);
    else active.push(todo);
  }

  logged.sort((a, b) => (b.stopped?.getTime() ?? 0) - (a.stopped?.getTime() ?? 0));
  // Within a day the UI sorts by todayIndex ASC (Upcoming drag order).
  const scheduled = groupByDate(scheduledRows);

  // Under any content scope (`--overdue` or a tag filter), a heading whose
  // children were all filtered out collapses rather than rendering an empty
  // section; a heading with any surviving child (in ANY sub-bucket) is kept.
  // With no scope active every heading renders (its own empty state).
  const contentScoped = overdue || tf.sql !== "";
  const headingGroups: ProjectHeadingGroup[] = headings
    .map((heading) => ({
      heading,
      items: headingItems.get(heading.uuid) ?? [],
      scheduled: groupByDate(headingScheduled.get(heading.uuid) ?? []),
      someday: headingSomeday.get(heading.uuid) ?? [],
      repeating: headingRepeating.get(heading.uuid) ?? [],
    }))
    .filter(
      (g) =>
        !contentScoped ||
        g.items.length > 0 ||
        g.scheduled.length > 0 ||
        g.someday.length > 0 ||
        g.repeating.length > 0,
    );

  return {
    project,
    active,
    headings: headingGroups,
    scheduled,
    someday,
    repeating,
    logged,
    trashed,
    openChildrenWhileResolved: project.status === "open" ? 0 : openChildren,
  };
}
