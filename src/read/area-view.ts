/**
 * Composite area view mirroring the native UI: the area's direct to-dos
 * (active first), its projects as rows in sidebar order, later items
 * (scheduled by date / repeating templates / someday). Trashed children are
 * excluded entirely (GUI-faithful — §6½/PLOG1-a) and the area logbook is a
 * bounded QUERY (`things logbook --area <ref>`), not a view section.
 * Structural twin of project-view.ts; area to-dos are never headed.
 */
import type { DatabaseSync } from "node:sqlite";

import { encodePackedDate, localToday, decodePackedDate } from "../model/dates.ts";
import type { Area, IsoDateGroup, Project, Todo } from "../model/entities.ts";
import { mapProject, mapTodo, type TaskRow } from "../model/mappers.ts";
import { fetchTagsForTasks, fetchTaskRows, makeRefResolver, resolveAreaUuid } from "./queries.ts";
import { logBoundary, markLogged } from "./log-boundary.ts";
import { OVERDUE } from "./predicates.ts";
import { isLooseRef } from "./pseudo-area.ts";
import { areaTags } from "./tags.ts";
import { tagFilter, type ViewFilter } from "./views.ts";

export interface AreaView {
  /** The area, or `null` for the `loose` pseudo-area (the NULL-area composite). */
  area: Area | null;
  /**
   * ALL live (non-logbook) DIRECT to-dos of the area, in `index` order, each
   * carrying `stage` + `when` — the flat wire representation (read-shape doctrine
   * §3.13's area-view `items[]`). Area direct to-dos are never headed and never
   * project-nested, so they are fully self-describing once `area` (the card
   * states it) is dropped. The structured buckets below (`active`, `scheduled`,
   * `someday`, `repeating`) re-group the SAME to-dos into the GUI render layout
   * for the byte-stable TTY (the library owns the clock + `todayIndex`).
   * `projects[]` is the SEPARATE order axis (sidebar rank) and is NOT folded in.
   */
  items: Todo[];
  /** Open, unscheduled/current direct to-dos, by index. */
  active: Todo[];
  /** The area's open projects in sidebar order (someday projects included). */
  projects: Project[];
  /** Future-dated direct to-dos grouped by date ascending. */
  scheduled: IsoDateGroup<Todo>[];
  /** Someday (incubated, undated) direct to-dos. */
  someday: Todo[];
  /** Repeating template rows owned by this area (invisible in list views). */
  repeating: Todo[];
}

// The area card splits its open projects into three display buckets by their
// own schedule (the card mirrors the GUI: active projects as rows, scheduled
// ones under Upcoming, someday ones under Someday). Closed-but-unswept projects
// stay "active" (checked in place) — start/startDate only classify OPEN rows.
// Shared by the bounding layer (capAreaSections keeps scheduled/someday whole
// while capping the active rows) and the human renderer, so the split is
// defined ONCE and the two never drift.

/** A someday project row: open, incubated, no start date. */
export const isSomedayProjectRow = (p: Project): boolean =>
  p.status === "open" && p.start === "someday" && p.startDate === null;

/** A future-scheduled project row (start date strictly after `todayIso`). */
export const isScheduledProjectRow = (p: Project, todayIso: string): boolean =>
  p.status === "open" && p.startDate !== null && p.startDate > todayIso;

/** An active project row — everything that is neither someday nor future-scheduled. */
export const isActiveProjectRow = (p: Project, todayIso: string): boolean =>
  !isSomedayProjectRow(p) && !isScheduledProjectRow(p, todayIso);

/** Resolves by uuid or unique (case-insensitive) title; throws like the ref resolvers. */
export function areaView(
  db: DatabaseSync,
  ref: string,
  now?: Date,
  filter: ViewFilter = {},
  zone?: string,
): AreaView {
  const overdue = filter.overdue === true;
  // The reserved `loose` ref addresses the NULL area (area-less items) as a
  // pseudo-area: `area === null`, and the per-kind area predicates swap to the
  // NULL-area membership rule (projects with no area; direct to-dos with no area
  // AND no project AND not in the Inbox). Every other filter/section behaves
  // identically, so the two paths differ ONLY in the area clause + the synthetic
  // null area object.
  const loose = isLooseRef(ref);
  let area: Area | null;
  // The per-kind area membership: PROJECTS filter on the area FK; DIRECT to-dos
  // additionally exclude project-nested rows and Inbox captures (start=0) — a
  // real area's `t.area = ?` gets those exclusions for free (an inbox/nested row
  // carries no area FK), so they only appear in the NULL-area branch.
  let projectAreaSql: string;
  let projectAreaBinds: (string | number)[];
  let todoAreaSql: string;
  let todoAreaBinds: (string | number)[];
  if (loose) {
    area = null;
    projectAreaSql = "t.area IS NULL";
    projectAreaBinds = [];
    todoAreaSql = "t.area IS NULL AND t.project IS NULL AND t.start != 0";
    todoAreaBinds = [];
  } else {
    const uuid = resolveAreaUuid(db, ref);
    const row = db
      .prepare(`SELECT uuid, title, visible, "index" FROM TMArea WHERE uuid = ?`)
      .get(uuid) as
      | { uuid: string; title: string | null; visible: number | null; index: number | null }
      | undefined;
    if (row === undefined) throw new Error(`no area with uuid ${uuid}`);
    area = {
      uuid: row.uuid,
      title: row.title ?? "",
      visible: row.visible !== 0,
      // Area tags by NAME only (tag uuids are internal).
      tags: areaTags(db, uuid).map((t) => ({ title: t.title })),
    };
    projectAreaSql = "t.area = ?";
    projectAreaBinds = [uuid];
    todoAreaSql = "t.area = ?";
    todoAreaBinds = [uuid];
  }

  const refs = makeRefResolver(db);
  const tagsOf = (rows: TaskRow[]) =>
    fetchTagsForTasks(
      db,
      rows.map((r) => r.uuid),
    );

  const boundary = logBoundary(db, now, zone);
  // The view's injected clock — gates `todaySection` to Today members in the
  // mapper AND drives the scheduled/overdue bucketing below.
  const packedToday = encodePackedDate(localToday(now, zone));
  // OWN-DEADLINE UNIFORM: `--overdue` filters BOTH displayed row kinds by each
  // row's OWN deadline (open, strictly before today) via the shared OVERDUE
  // predicate — the area's child PROJECTS by the project's own deadline AND the
  // loose to-dos by theirs. There is NO descent into project contents (an
  // overdue to-do inside a non-overdue project never surfaces here — that is
  // `project show --overdue`). Sections with no surviving rows collapse.
  const overdueSql = overdue ? ` AND ${OVERDUE}` : "";
  const overdueBinds = overdue ? [encodePackedDate(localToday(now, zone))] : [];
  // Tag scope (§9a): BOTH displayed row kinds — the child PROJECTS and the
  // loose to-dos — are filtered by a tag carried DIRECTLY on the row (the
  // container semantics). The area's own tags are inherited by every row it
  // holds, so an inheritance-inclusive `--tag` would be vacuous; suppressing the
  // container hop makes `--tag` mean "rows with this tag on themselves" (still
  // descendant-expanded) and `--untagged` "rows with no direct tag". Computed
  // once, spliced into both queries; NO descent into project contents (a child
  // of a matching project is never inspected here). The tag binds trail each
  // query's own binds.
  const tf = tagFilter(db, filter, { container: true });
  // Open projects PLUS closed ones the log-move sweep has not passed — the
  // GUI keeps those checked in place (completion ≠ logged). Under --overdue the
  // OVERDUE predicate's own `status = 0` narrows this to open overdue projects.
  const projectRows = fetchTaskRows(
    db,
    `t.type = 1 AND ${projectAreaSql} AND t.trashed = 0
     AND (t.status = 0 OR t.stopDate > ?)${overdueSql}${tf.sql} ORDER BY t."index" ASC`,
    [...projectAreaBinds, boundary.getTime() / 1000, ...overdueBinds, ...tf.binds],
  );
  const projectTags = tagsOf(projectRows);
  const projects = markLogged(
    projectRows.map((r) => mapProject(r, refs, projectTags.get(r.uuid) ?? [], packedToday)),
    boundary,
  );

  const todoRows = fetchTaskRows(
    db,
    `t.type = 0 AND t.trashed = 0 AND ${todoAreaSql}${overdueSql}${tf.sql} ORDER BY t."index" ASC`,
    [...todoAreaBinds, ...overdueBinds, ...tf.binds],
  );
  const todoTags = tagsOf(todoRows);
  const todos = todoRows.map((r) => ({
    row: r,
    todo: mapTodo(r, refs, todoTags.get(r.uuid) ?? [], packedToday),
  }));
  markLogged(
    todos.map((t) => t.todo),
    boundary,
  );

  const active: Todo[] = [];
  const scheduledRows: Array<{ date: string; ti: number; todo: Todo }> = [];
  const repeating: Todo[] = [];
  const someday: Todo[] = [];

  for (const { row: todoRow, todo } of todos) {
    if (todo.repeating.isTemplate) {
      repeating.push(todo);
      continue;
    }
    if (todoRow.status !== 0) {
      // Completion ≠ logged: closed-but-unswept items stay checked in the
      // active block, like the GUI. Logged rows (past the log boundary) are
      // NOT a view section — they live in `things logbook --area <ref>`.
      if (!todo.logged) active.push(todo);
      continue;
    }
    if (todoRow.start === 2 && todoRow.startDate === null) {
      someday.push(todo);
      continue;
    }
    if (todoRow.startDate !== null && todoRow.startDate > packedToday) {
      scheduledRows.push({
        date: decodePackedDate(todoRow.startDate) ?? "",
        ti: todoRow.todayIndex ?? 0,
        todo,
      });
      continue;
    }
    active.push(todo);
  }

  const scheduled: IsoDateGroup<Todo>[] = [];
  // Within a day the UI sorts by todayIndex ASC (Upcoming drag order).
  for (const { date, todo } of scheduledRows.toSorted(
    (a, b) => a.date.localeCompare(b.date) || a.ti - b.ti,
  )) {
    const last = scheduled[scheduled.length - 1];
    if (last && last.date === date) last.items.push(todo);
    else scheduled.push({ date, items: [todo] });
  }

  // The flat wire `items[]`: every LIVE direct to-do in area index order (the
  // `todos` fetch is already `ORDER BY index ASC`). Excludes swept logged rows
  // (the area view has no logbook section — they live in `things logbook --area`).
  const items = todos.map((t) => t.todo).filter((td) => !td.logged);

  return { area, items, active, projects, scheduled, someday, repeating };
}
