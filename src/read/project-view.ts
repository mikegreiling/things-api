/**
 * Composite project view mirroring the native UI (validated T17 + "later
 * items" findings): active items, headings with their children, later
 * (scheduled by date / repeating templates / someday), logged. Trashed
 * children are excluded entirely (GUI-faithful — the app filters trashed
 * children out of the project view, §6½/PLOG1-a).
 *
 * Child membership: `project = ? OR heading IN (project's headings)` — the
 * DB invariant is that headed to-dos have project = NULL (atlas §TMTask).
 * This is the dedup-safe alternative to things.py's include_items.
 */
import type { DatabaseSync } from "node:sqlite";

import { encodePackedDate, localToday, decodePackedDate } from "../model/dates.ts";
import type { Heading, IsoDateGroup, Project, Ref, Todo } from "../model/entities.ts";
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

/**
 * An ARCHIVED heading rendered inside the logged region (HEADARC2-A). Unlike a
 * live {@link ProjectHeadingGroup}, an archived heading is itself a logged item,
 * and its children — ALL of them, whatever their own state — nest beneath it as
 * a grouped section (most-recently-completed first). That includes any odd OPEN
 * child a GUI "Put Back" left stranded under the archived heading (HEADARC2-C):
 * the group renders what is there, it does NOT filter to status=3.
 */
export interface LoggedHeadingGroup {
  /** The archived heading (status "completed"); the wire emits its `archived`. */
  heading: Heading;
  /** Every child of the archived heading, most-recently-completed first. */
  items: Todo[];
}

/**
 * A container's full child set for the read-shape v2 wire (PR 2): a heading (any
 * lifecycle class — open, archived-unswept, archived-SWEPT) with EVERY one of its
 * children, live AND logged alike, in project `index` order. The wire boundary
 * ({@link src/read/shape.ts} `shapeProjectView`) buckets these by DERIVED STAGE —
 * logged → the heading's own `children.logbook`, the rest into
 * `anytime`/`upcoming`/`someday` — so one entity lands in exactly one place
 * (doctrine v2 R5 / #V12). The structured render buckets ({@link
 * ProjectView.headings}, {@link ProjectView.loggedHeadings}) are the SAME
 * headings + children re-grouped into the GUI layout for the byte-stable TTY.
 */
export interface ProjectHeadingContainer {
  heading: Heading;
  /** EVERY child of this heading (live AND logged/swept), project `index` order. */
  children: Todo[];
}

export interface ProjectView {
  project: Project;
  /**
   * Read-shape v2 wire (PR 2): the un-headed BODY's children — live AND logged
   * alike — in project `index` order. The wire boundary buckets these by derived
   * stage into the body's `children.{anytime,upcoming,someday,logbook}` record set
   * (one entity, one place — R5/#V12). This is the wire representation of the body;
   * the structured render buckets below (`active`, `scheduled`, `someday`,
   * `repeating`, and the un-headed slice of `logged`) are the SAME children
   * re-grouped into the GUI layout for the byte-stable TTY — the library owns the
   * clock + sweep boundary, so the two are always consistent (one child fetch).
   */
  bodyChildren: Todo[];
  /**
   * Read-shape v2 wire (PR 2): EVERY heading — open, archived-unswept, AND
   * archived-SWEPT — in project `index` order, each carrying ALL its children (R5:
   * all lifecycle classes, one entity one place). Under a content scope
   * (`--overdue` / `--tag`) a heading whose children were all filtered out
   * collapses, exactly as the render groups do. The wire boundary nests each
   * container's stage-bucketed `children` under its heading node; the structured
   * `headings` / `loggedHeadings` below re-group the SAME headings + children into
   * the GUI render layout for the byte-stable TTY.
   */
  headingContainers: ProjectHeadingContainer[];
  /** Open, unscheduled/current UNHEADED children, by index. */
  active: Todo[];
  /** OPEN headings in project order, each with its own sub-buckets. An archived heading never renders here. */
  headings: ProjectHeadingGroup[];
  /** UNHEADED future-dated children grouped by date ascending. */
  scheduled: IsoDateGroup<Todo>[];
  /** UNHEADED someday (incubated, undated) children. */
  someday: Todo[];
  /** UNHEADED repeating template rows owned by this project (invisible in list views). */
  repeating: Todo[];
  /**
   * The flat logged region: swept children of OPEN headings (each carrying its
   * heading ref) plus swept un-headed children, most-recently-completed first.
   * Children of ARCHIVED headings are NOT here — they group under their heading
   * in {@link ProjectView.loggedHeadings}.
   */
  logged: Todo[];
  /**
   * The archived-heading GROUPS of the logged region (HEADARC2-A), in project
   * (heading `index`) order — each an archived heading with its children nested.
   * Rendered only under `--show-logged`, after the flat {@link ProjectView.logged}
   * rows (the flat-then-grouped ordering is a defensible choice, not GUI-probed).
   */
  loggedHeadings: LoggedHeadingGroup[];
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
  /**
   * HEADARC2-C (additive): count of untrashed OPEN (status=0) children buried
   * under an ARCHIVED heading of this project — the heading analog of the §6¾
   * odd state. The GUI's "Put Back" of a trashed open child restores it in place
   * under the archived heading WITHOUT reopening the heading, leaving an open,
   * actionable to-do invisible to every live view (reachable only by expanding
   * this card's logged region). Counted regardless of the PROJECT's own status.
   * 0 when no archived heading holds an open child.
   */
  openChildrenUnderArchivedHeading: number;
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
    `t.type = 0 AND t.trashed = 0 AND (t.project = ? OR t.heading IN (
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

  // TRINARY heading split (the completion≠logged law, applied to headings): an
  // OPEN heading — or an archived one NOT yet past the log-move boundary — stays
  // a LIVE group IN PLACE (an archived-unswept heading carries `archived` yet
  // renders among the live groups, exactly as a completed-unswept to-do row
  // stays checked in place, §above / log-boundary.ts). Only a SWEPT archived
  // heading moves into the logged region as a grouped section (HEADARC2-A).
  const headingSwept = (h: Heading): boolean =>
    h.status !== "open" && h.stopped !== null && h.stopped <= boundary;
  const liveHeadings = headings.filter((h) => !headingSwept(h));
  const sweptHeadings = headings.filter((h) => headingSwept(h));
  const liveHeadingSet = new Set(liveHeadings.map((h) => h.uuid));
  const sweptHeadingSet = new Set(sweptHeadings.map((h) => h.uuid));

  // The owning-project ref stamped on every headed child — so the heading ref a
  // flat logged row carries promotes its `headingUuid` in the project's scope
  // (the round-trip predicate is project-scoped), mirroring the list views.
  const projectRef: Ref = { uuid: project.uuid, title: project.title };

  // Project-level (UNHEADED) buckets.
  const active: Todo[] = [];
  const scheduledRows: ScheduledRow[] = [];
  const repeating: Todo[] = [];
  const someday: Todo[] = [];
  const logged: Todo[] = [];
  // Children of a SWEPT archived heading — grouped under their heading in the
  // logged region (keyed by heading uuid), ALL of them regardless of state.
  const sweptHeadingChildren = new Map<string, Todo[]>();
  // Per-heading LIVE sub-buckets, keyed by heading uuid (§9 fidelity fix): a
  // headed scheduled/someday/repeating child nests under its heading, NOT at the
  // project level.
  const headingItems = new Map<string, Todo[]>();
  const headingScheduled = new Map<string, ScheduledRow[]>();
  const headingSomeday = new Map<string, Todo[]>();
  const headingRepeating = new Map<string, Todo[]>();
  // A child whose heading FK is not a LIVE heading (an unknown/trashed heading,
  // OR a swept archived heading handled above) falls back to the project-level
  // (unheaded) buckets rather than vanishing (mirrors the render's loose fallback).
  const liveHeadingUuidOf = (row: TaskRow): string | null =>
    row.heading !== null && liveHeadingSet.has(row.heading) ? row.heading : null;
  // Every untrashed, non-template OPEN child, regardless of which bucket it
  // lands in below — surfaced (only when the project is itself resolved) as
  // the PLOG1 stranded-open-child count.
  let openChildren = 0;
  // Open children buried under a SWEPT archived heading — the §6¾ odd state for
  // headings (HEADARC2-C), surfaced regardless of the project's own status.
  let openChildrenUnderArchivedHeading = 0;

  for (const { row, todo } of todos) {
    if (todo.heading !== null) todo.headingProject = projectRef;
    // A child of a SWEPT archived heading groups under it in the logged region,
    // WHATEVER its own state — including the odd OPEN child a GUI Put-Back
    // stranded (HEADARC2-C): render what is there, do NOT filter to status=3.
    if (row.heading !== null && sweptHeadingSet.has(row.heading)) {
      pushInto(sweptHeadingChildren, row.heading, todo);
      if (row.status === 0 && !todo.repeating.isTemplate) {
        openChildren += 1; // also stranded when the project itself is resolved
        openChildrenUnderArchivedHeading += 1;
      }
      continue;
    }
    const h = liveHeadingUuidOf(row);
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
  const headingGroups: ProjectHeadingGroup[] = liveHeadings
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

  // The logged-region archived-heading groups, in project (heading index) order;
  // each group's children most-recently-completed first (open odd children, with
  // no stopDate, sort last — the same null-last convention the flat logged list
  // uses). Under a content scope (--overdue / --tag) an empty group collapses.
  const loggedHeadings: LoggedHeadingGroup[] = sweptHeadings
    .map((heading) => ({
      heading,
      items: (sweptHeadingChildren.get(heading.uuid) ?? []).toSorted(
        (a, b) => (b.stopped?.getTime() ?? 0) - (a.stopped?.getTime() ?? 0),
      ),
    }))
    .filter((g) => !contentScoped || g.items.length > 0);

  // Read-shape v2 wire containers (PR 2): partition EVERY child by its heading
  // membership, preserving the `index`-order fetch. A child whose heading FK is
  // not one of THIS project's headings (an unknown/trashed heading, or none) falls
  // back to the un-headed BODY — mirroring the render's loose fallback. Each
  // container's children (live AND swept/logged alike) are bucketed by DERIVED
  // STAGE at the wire boundary (src/read/shape.ts) — logged → its per-container
  // `logbook`, the rest into `anytime`/`upcoming`/`someday` — so one entity lands
  // in exactly one place (R5 / #V12). Built from the SAME `todos` (already
  // `headingProject`-stamped above), so the wire and the render buckets never drift.
  const knownHeadingSet = new Set(headings.map((h) => h.uuid));
  const bodyChildren: Todo[] = [];
  const headingChildren = new Map<string, Todo[]>();
  for (const { row, todo } of todos) {
    const hUuid = row.heading;
    if (hUuid !== null && knownHeadingSet.has(hUuid)) pushInto(headingChildren, hUuid, todo);
    else bodyChildren.push(todo);
  }
  // Every heading in `index` order, ALL lifecycle classes (R5). Under a content
  // scope an emptied heading collapses (matching the live/logged render groups).
  const headingContainers: ProjectHeadingContainer[] = headings
    .map((heading) => ({ heading, children: headingChildren.get(heading.uuid) ?? [] }))
    .filter((c) => !contentScoped || c.children.length > 0);

  return {
    project,
    bodyChildren,
    headingContainers,
    active,
    headings: headingGroups,
    scheduled,
    someday,
    repeating,
    logged,
    loggedHeadings,
    openChildrenWhileResolved: project.status === "open" ? 0 : openChildren,
    openChildrenUnderArchivedHeading,
  };
}
