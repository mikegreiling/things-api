/**
 * Composite area view mirroring the native UI: the area's direct to-dos
 * (active first), its projects as rows in sidebar order, later items
 * (scheduled by date / repeating templates / someday), logged, trashed.
 * Structural twin of project-view.ts; area to-dos are never headed.
 */
import type { DatabaseSync } from "node:sqlite";

import { encodePackedDate, localToday, decodePackedDate } from "../model/dates.ts";
import type { Area, IsoDateGroup, Project, Todo } from "../model/entities.ts";
import { mapProject, mapTodo, type TaskRow } from "../model/mappers.ts";
import { fetchTagsForTasks, fetchTaskRows, makeRefResolver, resolveAreaUuid } from "./queries.ts";
import { areaTags } from "./tags.ts";

export interface AreaView {
  area: Area;
  /** Open, unscheduled/current direct to-dos, by index. */
  active: Todo[];
  /** The area's open projects in sidebar order (someday projects included). */
  projects: Project[];
  later: {
    /** Future-dated direct to-dos grouped by date ascending. */
    scheduled: IsoDateGroup<Todo>[];
    /** Repeating template rows owned by this area (invisible in list views). */
    repeating: Todo[];
    someday: Todo[];
  };
  logged: Todo[];
  trashed: Todo[];
}

/** Resolves by uuid or unique (case-insensitive) title; throws like the ref resolvers. */
export function areaView(db: DatabaseSync, ref: string, now?: Date): AreaView {
  const uuid = resolveAreaUuid(db, ref);
  const row = db
    .prepare(`SELECT uuid, title, visible, "index" FROM TMArea WHERE uuid = ?`)
    .get(uuid) as
    | { uuid: string; title: string | null; visible: number | null; index: number | null }
    | undefined;
  if (row === undefined) throw new Error(`no area with uuid ${uuid}`);
  const area: Area = {
    uuid: row.uuid,
    title: row.title ?? "",
    visible: row.visible !== 0,
    index: row.index ?? 0,
    tags: areaTags(db, uuid),
  };

  const refs = makeRefResolver(db);
  const tagsOf = (rows: TaskRow[]) =>
    fetchTagsForTasks(
      db,
      rows.map((r) => r.uuid),
    );

  const projectRows = fetchTaskRows(
    db,
    `t.type = 1 AND t.area = ? AND t.trashed = 0 AND t.status = 0 ORDER BY t."index" ASC`,
    [uuid],
  );
  const projectTags = tagsOf(projectRows);
  const projects = projectRows.map((r) => mapProject(r, refs, projectTags.get(r.uuid) ?? []));

  const todoRows = fetchTaskRows(db, `t.type = 0 AND t.area = ? ORDER BY t."index" ASC`, [uuid]);
  const todoTags = tagsOf(todoRows);
  const todos = todoRows.map((r) => ({
    row: r,
    todo: mapTodo(r, refs, todoTags.get(r.uuid) ?? []),
  }));

  const packedToday = encodePackedDate(localToday(now));
  const active: Todo[] = [];
  const scheduledRows: Array<{ date: string; todo: Todo }> = [];
  const repeating: Todo[] = [];
  const someday: Todo[] = [];
  const logged: Todo[] = [];
  const trashed: Todo[] = [];

  for (const { row, todo } of todos) {
    if (row.trashed === 1) {
      trashed.push(todo);
      continue;
    }
    if (todo.repeating.isTemplate) {
      repeating.push(todo);
      continue;
    }
    if (row.status !== 0) {
      logged.push(todo);
      continue;
    }
    if (row.start === 2 && row.startDate === null) {
      someday.push(todo);
      continue;
    }
    if (row.startDate !== null && row.startDate > packedToday) {
      scheduledRows.push({ date: decodePackedDate(row.startDate) ?? "", todo });
      continue;
    }
    active.push(todo);
  }

  logged.sort((a, b) => (b.stopped?.getTime() ?? 0) - (a.stopped?.getTime() ?? 0));
  const scheduled: IsoDateGroup<Todo>[] = [];
  for (const { date, todo } of scheduledRows.sort((a, b) => a.date.localeCompare(b.date))) {
    const last = scheduled[scheduled.length - 1];
    if (last && last.date === date) last.items.push(todo);
    else scheduled.push({ date, items: [todo] });
  }

  return { area, active, projects, later: { scheduled, repeating, someday }, logged, trashed };
}
