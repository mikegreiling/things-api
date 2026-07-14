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
import { inheritedTagsFor } from "./tags.ts";

export interface ProjectView {
  project: Project;
  /** Open, unscheduled/current children not under a heading, by index. */
  active: Todo[];
  /** Headings in project order, each with its open children. */
  headings: Array<{ heading: Heading; items: Todo[] }>;
  later: {
    /** Future-dated children grouped by date ascending. */
    scheduled: IsoDateGroup<Todo>[];
    /** Repeating template rows owned by this project (invisible in list views). */
    repeating: Todo[];
    someday: Todo[];
  };
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

export function projectView(db: DatabaseSync, uuid: string, now?: Date): ProjectView {
  const projectRow = fetchTaskByUuid(db, uuid);
  if (!projectRow || projectRow.type !== 1) throw new ProjectNotFoundError(uuid);

  const refs = makeRefResolver(db);
  const tagsOf = (rows: TaskRow[]) =>
    fetchTagsForTasks(
      db,
      rows.map((r) => r.uuid),
    );
  const projectTags = tagsOf([projectRow]);
  const project = mapProject(projectRow, refs, projectTags.get(projectRow.uuid) ?? []);
  // The card view surfaces area-inherited tags (the UI's tag filter honors them).
  project.inheritedTags = inheritedTagsFor(db, projectRow);

  const headingRows = fetchTaskRows(
    db,
    `t.type = 2 AND t.project = ? AND t.trashed = 0 ORDER BY t."index" ASC`,
    [uuid],
  );
  const headings = headingRows.map((h) => mapHeading(h, refs));

  const childRows = fetchTaskRows(
    db,
    `t.type = 0 AND (t.project = ? OR t.heading IN (
       SELECT uuid FROM TMTask WHERE type = 2 AND project = ?
     ))
     ORDER BY t."index" ASC`,
    [uuid, uuid],
  );
  const childTags = tagsOf(childRows);
  const boundary = logBoundary(db, now);
  const todos = childRows.map((r) => ({
    row: r,
    todo: mapTodo(r, refs, childTags.get(r.uuid) ?? []),
  }));
  markLogged([project, ...todos.map((t) => t.todo)], boundary);

  const packedToday = encodePackedDate(localToday(now));
  const active: Todo[] = [];
  const byHeading = new Map<string, Todo[]>();
  const scheduledRows: Array<{ date: string; ti: number; todo: Todo }> = [];
  const repeating: Todo[] = [];
  const someday: Todo[] = [];
  const logged: Todo[] = [];
  const trashed: Todo[] = [];
  // Every untrashed, non-template OPEN child, regardless of which bucket it
  // lands in below — surfaced (only when the project is itself resolved) as
  // the PLOG1 stranded-open-child count.
  let openChildren = 0;

  for (const { row, todo } of todos) {
    if (row.trashed === 1) {
      trashed.push(todo);
      continue;
    }
    if (todo.repeating.isTemplate) {
      repeating.push(todo);
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
      if (row.heading) {
        const list = byHeading.get(row.heading) ?? [];
        list.push(todo);
        byHeading.set(row.heading, list);
      } else {
        active.push(todo);
      }
      continue;
    }
    if (row.start === 2 && row.startDate === null) {
      someday.push(todo);
      continue;
    }
    if (row.startDate !== null && row.startDate > packedToday) {
      scheduledRows.push({
        date: decodePackedDate(row.startDate) ?? "",
        ti: row.todayIndex ?? 0,
        todo,
      });
      continue;
    }
    if (row.heading) {
      const list = byHeading.get(row.heading) ?? [];
      list.push(todo);
      byHeading.set(row.heading, list);
      continue;
    }
    active.push(todo);
  }

  logged.sort((a, b) => (b.stopped?.getTime() ?? 0) - (a.stopped?.getTime() ?? 0));
  const scheduled: IsoDateGroup<Todo>[] = [];
  // Within a day the UI sorts by todayIndex ASC (Upcoming drag order).
  for (const { date, todo } of scheduledRows.toSorted(
    (a, b) => a.date.localeCompare(b.date) || a.ti - b.ti,
  )) {
    const last = scheduled[scheduled.length - 1];
    if (last && last.date === date) last.items.push(todo);
    else scheduled.push({ date, items: [todo] });
  }

  return {
    project,
    active,
    headings: headings.map((heading) => ({
      heading,
      items: byHeading.get(heading.uuid) ?? [],
    })),
    later: { scheduled, repeating, someday },
    logged,
    trashed,
    openChildrenWhileResolved: project.status === "open" ? 0 : openChildren,
  };
}
