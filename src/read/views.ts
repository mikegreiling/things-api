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
 *             CONTAINER CASCADE (live-verified 2026-07-09): children of a
 *             project that is not itself anytime-visible (someday/future/
 *             logged/trashed) are excluded — the project row represents
 *             them. Result is grouped in sidebar order (SidebarSection[]).
 * - upcoming: start=2 AND startDate > today, PLUS each fixed repeating
 *             template's next occurrence synthesized from
 *             rt1_nextInstanceStartDate (UI parity; opt out via
 *             repeats:false). Occurrence deadline = start − rule.ts
 *             (instance-validated 2026-07-04).
 * - someday:  start=2 AND startDate IS NULL, container-less members only
 *             (project children appear ONLY via the activeProjectItems
 *             toggle, and only for anytime-active projects — mirrors the
 *             UI's "Show items from active projects"). Grouped in sidebar
 *             order like anytime.
 * - logbook:  status IN (2,3), by stopDate DESC
 * - trash:    trashed=1
 *
 * All views: to-dos + projects (type IN (0,1)), open (unless noted),
 * untrashed (unless trash), repeating TEMPLATE rows excluded.
 */
import type { DatabaseSync } from "node:sqlite";

import { addDaysIso, encodePackedDate, localToday, type IsoDate } from "../model/dates.ts";
import { logBoundary, markLogged } from "./log-boundary.ts";
import type { Project, Ref, Todo } from "../model/entities.ts";
import { mapProject, mapTodo, type TaskRow } from "../model/mappers.ts";
import { projectOccurrences } from "../model/occurrences.ts";
import { decodeRecurrenceRule } from "../model/recurrence.ts";
import {
  fetchTagsForTasks,
  fetchTaskRows,
  makeHeadingProjectResolver,
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
  const headingProject = makeHeadingProjectResolver(db);
  const tags = fetchTagsForTasks(
    db,
    rows.map((r) => r.uuid),
  );
  const items = rows.map((row) => {
    if (row.type === 1) return mapProject(row, refs, tags.get(row.uuid) ?? []);
    const todo = mapTodo(row, refs, tags.get(row.uuid) ?? []);
    if (todo.heading !== null) {
      const p = headingProject(todo.heading.uuid);
      if (p !== null) todo.headingProject = p;
    }
    return todo;
  });
  return markLogged(items, logBoundary(db));
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
    `${OPEN} AND ${CONTAINER_UNTRASHED} AND (
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

/**
 * One sidebar-ordered block of a grouped view (anytime/someday): the area
 * (null = the top-level, area-less block, which the UI renders first) and its
 * members in UI order — direct to-dos first, then each project block (the
 * project row immediately followed by its member to-dos).
 */
export interface SidebarSection {
  area: Ref | null;
  items: ListItem[];
}

/** An item's own anytime membership: unscheduled-active, or dated <= today. */
const ANYTIME_SELF = (col: string) =>
  `((${col}.start = 1 AND (${col}.startDate IS NULL OR ${col}.startDate <= ?))
    OR (${col}.start = 2 AND ${col}.startDate IS NOT NULL AND ${col}.startDate <= ?))`;

/**
 * The item's effective project: its own link, or its heading's project for
 * headed children (heading rows carry the project link).
 */
const EFF_PROJECT = `COALESCE(t.project, (SELECT h.project FROM TMTask h WHERE h.uuid = t.heading))`;

/**
 * Container cascade (live-verified against the UI, 2026-07-09): a to-do
 * inside a project that is NOT itself anytime-visible (someday or
 * future-scheduled, logged, or trashed) is absent from Anytime regardless of
 * the to-do's own start state — the project row alone represents it.
 * Projects and container-less to-dos pass through. Two binds (packedToday ×2).
 */
const PROJECT_ANYTIME_ACTIVE = `(${EFF_PROJECT} IS NULL OR EXISTS (
     SELECT 1 FROM TMTask p WHERE p.uuid = ${EFF_PROJECT}
     AND p.trashed = 0 AND p.status = 0 AND ${ANYTIME_SELF("p")}))`;

/**
 * DERIVED-trash exclusion: project deletion is SHALLOW (A24B — only the
 * project row flips trashed=1; children keep trashed=0 and their links, so
 * their Trash membership is derived through the container chain). Every live
 * view must therefore check the chain, not just the row's own flag: the
 * heading (if any) and the effective project (direct or via heading) must
 * both be untrashed. Areas cannot be trashed (they delete permanently), so
 * the chain is at most heading → project. Trash-adjacent surfaces stay
 * exempt on purpose: `things trash` lists directly-flagged rows, and a
 * trashed project's OWN view shows its would-be-recovered children.
 */
const CONTAINER_UNTRASHED = `(t.heading IS NULL OR EXISTS (
     SELECT 1 FROM TMTask hh WHERE hh.uuid = t.heading AND hh.trashed = 0))
 AND (${EFF_PROJECT} IS NULL OR EXISTS (
     SELECT 1 FROM TMTask cc WHERE cc.uuid = ${EFF_PROJECT} AND cc.trashed = 0))`;

export function anytimeView(db: DatabaseSync, now?: Date, filter?: ViewFilter): SidebarSection[] {
  const packedToday = encodePackedDate(localToday(now));
  const tf = tagFilter(db, filter);
  // Mirrors UI membership: every active item, including Today members
  // (starred in the UI) and pending-promotion rows (start=2, past-dated) —
  // MINUS children of non-active containers (the project cascade).
  const rows = fetchTaskRows(
    db,
    `${OPEN} AND ${ANYTIME_SELF("t")}
     AND ${PROJECT_ANYTIME_ACTIVE}${tf.sql} ORDER BY t."index" ASC`,
    [packedToday, packedToday, packedToday, packedToday, ...tf.binds],
  );
  return groupBySidebar(db, materialize(db, rows));
}

/**
 * Arranges view members into the UI's flat sidebar-mirroring order: the
 * area-less block first (direct to-dos, then each top-level project followed
 * by its members), then each area by its sidebar index (direct to-dos, then
 * its projects). Project and area order here mirrors the sidebar exactly —
 * both read the same "index" columns.
 */
function groupBySidebar(db: DatabaseSync, items: ListItem[]): SidebarSection[] {
  if (items.length === 0) return [];
  const inList = (n: number) => Array.from({ length: n }, () => "?").join(", ");

  // Headed children: resolve heading -> project.
  const headingUuids = [
    ...new Set(
      items.flatMap((i) => (i.type === "to-do" && i.heading !== null ? [i.heading.uuid] : [])),
    ),
  ];
  const headingProject = new Map<string, string | null>();
  if (headingUuids.length > 0) {
    for (const row of db
      .prepare(`SELECT uuid, project FROM TMTask WHERE uuid IN (${inList(headingUuids.length)})`)
      .all(...headingUuids) as Array<{ uuid: string; project: string | null }>) {
      headingProject.set(row.uuid, row.project);
    }
  }
  const effProject = (i: ListItem): string | null =>
    i.type !== "to-do"
      ? null
      : (i.project?.uuid ??
        (i.heading !== null ? (headingProject.get(i.heading.uuid) ?? null) : null));

  // Sidebar rank + title for areas; index + area for every referenced project
  // (a tag-filtered list can contain a child whose project row didn't match).
  const areaRows = db
    .prepare(`SELECT uuid, title, "index" FROM TMArea ORDER BY "index" ASC, uuid ASC`)
    .all() as Array<{ uuid: string; title: string | null }>;
  const areaRank = new Map(areaRows.map((a, rank) => [a.uuid, rank]));
  const areaTitle = new Map(areaRows.map((a) => [a.uuid, a.title ?? ""]));
  const projectUuids = [
    ...new Set([
      ...items.flatMap((i) => (i.type === "project" ? [i.uuid] : [])),
      ...items.flatMap((i) => {
        const p = effProject(i);
        return p === null ? [] : [p];
      }),
    ]),
  ];
  const projectMeta = new Map<string, { index: number; area: string | null }>();
  if (projectUuids.length > 0) {
    for (const row of db
      .prepare(
        `SELECT uuid, "index", area FROM TMTask WHERE uuid IN (${inList(projectUuids.length)})`,
      )
      .all(...projectUuids) as Array<{ uuid: string; index: number | null; area: string | null }>) {
      projectMeta.set(row.uuid, { index: row.index ?? 0, area: row.area });
    }
  }

  // items arrive in SQL "index" order, so array position IS the per-container
  // rank (the internal index is no longer exposed on the entity).
  const sortKey = (i: ListItem, pos: number) => {
    const project = i.type === "project" ? i.uuid : effProject(i);
    const meta = project === null ? undefined : projectMeta.get(project);
    const area = i.area?.uuid ?? meta?.area ?? null;
    return {
      areaRank: area === null ? -1 : (areaRank.get(area) ?? areaRows.length),
      area: area ?? "",
      inProject: project === null ? 0 : 1,
      projectIndex: meta?.index ?? 0,
      project: project ?? "",
      headerFirst: i.type === "project" ? 0 : 1,
      pos,
      uuid: i.uuid,
    };
  };
  const keyed = items.map((item, pos) => ({ item, k: sortKey(item, pos) }));
  keyed.sort(
    (a, b) =>
      a.k.areaRank - b.k.areaRank ||
      a.k.area.localeCompare(b.k.area) ||
      a.k.inProject - b.k.inProject ||
      a.k.projectIndex - b.k.projectIndex ||
      a.k.project.localeCompare(b.k.project) ||
      a.k.headerFirst - b.k.headerFirst ||
      a.k.pos - b.k.pos ||
      a.k.uuid.localeCompare(b.k.uuid),
  );

  const sections: SidebarSection[] = [];
  for (const { item, k } of keyed) {
    const areaUuid = k.area === "" ? null : k.area;
    const last = sections.at(-1);
    if (last === undefined || (last.area?.uuid ?? null) !== areaUuid) {
      sections.push({
        area: areaUuid === null ? null : { uuid: areaUuid, title: areaTitle.get(areaUuid) ?? "" },
        items: [],
      });
    }
    sections.at(-1)?.items.push(item);
  }
  return sections;
}

/** The UI's star marker in Anytime: the item is also a Today member. */
export function isTodayMember(item: ListItem, now?: Date): boolean {
  return item.startDate !== null && item.startDate <= localToday(now);
}

export interface UpcomingFilter extends ViewFilter {
  /** Include repeating templates' next occurrences (UI parity; default true). */
  repeats?: boolean;
  /**
   * Occurrences to surface per repeating template (default 1 = only the
   * app-materialized next instance, exactly the UI). Higher values PROJECT
   * later occurrences from the decoded rule (fixed rules only; capped at
   * 10) — projections are host math the app has not materialized yet.
   */
  horizon?: number;
  /**
   * Only rows scheduled on/before this date (inclusive). Dated rows and
   * template occurrences beyond it are dropped; the dateless resting
   * templates (the trailing Repeating To-Dos section) always survive —
   * a date bound cannot apply to rows with no date.
   */
  until?: IsoDate;
  /**
   * Only rows scheduled on/after this date (inclusive) — skip occurrences
   * before it. The dateless resting templates always survive, as with
   * `until` (a date bound cannot apply to rows with no date).
   */
  since?: IsoDate;
}

export function upcomingView(db: DatabaseSync, now?: Date, filter?: UpcomingFilter): ListItem[] {
  const packedToday = encodePackedDate(localToday(now));
  const until = filter?.until;
  const since = filter?.since;
  const untilSql = until === undefined ? "" : " AND t.startDate <= ?";
  const untilBinds = until === undefined ? [] : [encodePackedDate(until)];
  const sinceSql = since === undefined ? "" : " AND t.startDate >= ?";
  const sinceBinds = since === undefined ? [] : [encodePackedDate(since)];
  const tf = tagFilter(db, filter);
  const rows = fetchTaskRows(
    db,
    `${OPEN} AND ${CONTAINER_UNTRASHED}
     AND t.start = 2 AND t.startDate IS NOT NULL AND t.startDate > ?${untilSql}${sinceSql}${tf.sql}
     ORDER BY t.startDate ASC, t."index" ASC`,
    [packedToday, ...untilBinds, ...sinceBinds, ...tf.binds],
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
    `t.type IN (0, 1) AND t.trashed = 0 AND t.status = 0 AND ${CONTAINER_UNTRASHED}
     AND (t.rt1_recurrenceRule IS NOT NULL OR t.repeater IS NOT NULL)
     AND t.rt1_instanceCreationPaused = 0
     AND t.rt1_nextInstanceStartDate IS NOT NULL AND t.rt1_nextInstanceStartDate > ?${until === undefined ? "" : " AND t.rt1_nextInstanceStartDate <= ?"}${since === undefined ? "" : " AND t.rt1_nextInstanceStartDate >= ?"}${tf.sql}
     ORDER BY t.rt1_nextInstanceStartDate ASC, t."index" ASC`,
    [packedToday, ...untilBinds, ...sinceBinds, ...tf.binds],
  );
  const horizon = Math.max(1, Math.min(10, Math.trunc(filter?.horizon ?? 1)));
  const rawByUuid = new Map(templateRows.map((r) => [r.uuid, r.rt1_recurrenceRule]));
  const occurrences = materialize(db, templateRows).flatMap((template) => {
    const startDate = template.repeating.nextOccurrence ?? null;
    if (startDate === null) return [];
    // Whether occurrences deadline is the TEMPLATE's property, not the rule's:
    // a deadline-less template (repeating.deadlined false) spawns instances
    // with NO deadline even for fixed ts=0 rules — its rt1_recurrenceRule is
    // byte-identical to a deadlined ts=0 rule (oddities §8a, UI1 2026-07-12).
    const deadlined = template.repeating.deadlined === true;
    let rule: ReturnType<typeof decodeRecurrenceRule> | null = null;
    const raw = rawByUuid.get(template.uuid);
    if (raw !== null && raw !== undefined) {
      try {
        rule = decodeRecurrenceRule(raw);
      } catch {
        // undecodable rule (future Things build) → occurrence without a derived deadline
      }
    }
    if (rule === null || horizon === 1 || rule.type !== "fixed") {
      // Deadlined templates deadline the occurrence at the event date
      // (start − ts, incl. ts=0); deadline-less ones carry no deadline.
      const deadline =
        rule !== null && deadlined ? addDaysIso(startDate, -rule.startOffsetDays) : null;
      return [{ ...template, startDate, deadline }];
    }
    // horizon > 1: later occurrences PROJECTED from the decoded rule,
    // anchored on the app's own materialized next instance. The until bound
    // clips projections the same way it clips stored rows.
    return (
      projectOccurrences(
        rule,
        startDate,
        {
          count: horizon,
          ...(until !== undefined && { until }),
        },
        deadlined,
      )
        .filter((o) => until === undefined || o.startDate <= until)
        .filter((o) => since === undefined || o.startDate >= since)
        // oxlint-disable-next-line no-map-spread -- building fresh occurrence objects, not mutating
        .map((o) => ({
          ...template,
          startDate: o.startDate,
          deadline: o.deadline,
        }))
    );
  });

  // Within a day the UI's drag order is todayIndex ASC (live-verified
  // 2026-07-11 against the GUI: plain `index` disagrees, todayIndex matches
  // exactly), so the sortable Upcoming order survives the CLI.
  const todayIndexOf = new Map<string, number>(
    [...rows, ...templateRows].map((r) => [r.uuid, r.todayIndex ?? 0]),
  );
  const dated = [...items, ...occurrences]
    .map((item, pos) => ({ item, pos }))
    .toSorted(
      (a, b) =>
        (a.item.startDate ?? "").localeCompare(b.item.startDate ?? "") ||
        (todayIndexOf.get(a.item.uuid) ?? 0) - (todayIndexOf.get(b.item.uuid) ?? 0) ||
        a.pos - b.pos ||
        a.item.uuid.localeCompare(b.item.uuid),
    )
    .map((x) => x.item);

  // The UI's trailing "Repeating To-Dos" section: templates with NO set
  // next occurrence (after-completion rules between instances, rules past
  // their end date) plus paused ones — startDate stays null, the decoded
  // rule rides along so consumers can derive waiting/paused/ended.
  const restingRows = fetchTaskRows(
    db,
    `t.type IN (0, 1) AND t.trashed = 0 AND t.status = 0 AND ${CONTAINER_UNTRASHED}
     AND (t.rt1_recurrenceRule IS NOT NULL OR t.repeater IS NOT NULL)
     AND (t.rt1_nextInstanceStartDate IS NULL OR t.rt1_nextInstanceStartDate <= ?
          OR t.rt1_instanceCreationPaused = 1)${tf.sql}
     ORDER BY t.todayIndex ASC, t."index" ASC`,
    [packedToday, ...tf.binds],
  );
  const resting = materialize(db, restingRows).map((item) => {
    const raw = restingRows.find((r) => r.uuid === item.uuid)?.rt1_recurrenceRule;
    if (raw !== null && raw !== undefined) {
      try {
        item.repeating.rule = decodeRecurrenceRule(raw);
      } catch {
        // undecodable rule (future Things build) — surface without it
      }
    }
    return item;
  });
  return [...dated, ...resting];
}

export interface SomedayFilter extends ViewFilter {
  /**
   * Also list someday to-dos that live inside ACTIVE projects — the UI's
   * "Show items from active projects" toggle (default false, the UI's
   * default). Children of someday projects are never listed either way: the
   * project row stands for them.
   */
  activeProjectItems?: boolean;
}

export function somedayView(
  db: DatabaseSync,
  now?: Date,
  filter?: SomedayFilter,
): SidebarSection[] {
  const tf = tagFilter(db, filter);
  const packedToday = encodePackedDate(localToday(now));
  // Default membership excludes ALL project children (the UI shows only
  // container-less someday to-dos, area members, and someday project rows);
  // the toggle adds someday children of anytime-ACTIVE projects only.
  const withActiveChildren = filter?.activeProjectItems === true;
  const childArm = withActiveChildren
    ? `EXISTS (SELECT 1 FROM TMTask p WHERE p.uuid = ${EFF_PROJECT}
         AND p.trashed = 0 AND p.status = 0 AND ${ANYTIME_SELF("p")})`
    : "0";
  const rows = fetchTaskRows(
    db,
    `${OPEN} AND t.start = 2 AND t.startDate IS NULL
     AND (${EFF_PROJECT} IS NULL OR ${childArm})${tf.sql} ORDER BY t."index" ASC`,
    [...(withActiveChildren ? [packedToday, packedToday] : []), ...tf.binds],
  );
  const sections = groupBySidebar(db, materialize(db, rows));
  // GUI order within a Someday group (live side-by-side, 2026-07-12):
  // PROJECT rows first (their sidebar order preserved), then direct to-dos in
  // drag order. Someday children of active projects (the activeProjectItems
  // toggle) trail the group, still clustered by their project — surfaces
  // present them as a separate "From active projects" section.
  const isChild = (i: ListItem) =>
    i.type === "to-do" && (i.project !== null || i.headingProject !== null);
  return sections.map((s) => ({
    area: s.area,
    items: [
      ...s.items.filter((i) => i.type === "project"),
      ...s.items.filter((i) => i.type === "to-do" && !isChild(i)),
      ...s.items.filter(isChild),
    ],
  }));
}

export interface LogbookFilter extends ViewFilter {
  /** Row cap; `null` returns every match (surfaces slice for display). */
  limit?: number | null;
  /**
   * Area scope: the area's direct items, its project rows, and every to-do
   * of its projects — INCLUDING heading-nested ones (heading → project →
   * area). Uuid or unique name.
   */
  area?: string;
  /** Project scope: ALL children, heading-nested included. Uuid or unique name. */
  project?: string;
  /** Only entries logged at/after this instant. */
  since?: Date;
  /** Only entries logged at/before this instant. */
  until?: Date;
}

export function logbookView(db: DatabaseSync, options?: LogbookFilter): ListItem[] {
  const cap = options?.limit === null ? null : (options?.limit ?? 100);
  const tf = tagFilter(db, options);
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (options?.project !== undefined) {
    where.push(`${EFF_PROJECT} = ?`);
    binds.push(resolveProjectUuid(db, options.project));
  }
  if (options?.area !== undefined) {
    const areaUuid = resolveAreaUuid(db, options.area);
    where.push(
      `(t.area = ? OR EXISTS (SELECT 1 FROM TMTask p WHERE p.uuid = ${EFF_PROJECT} AND p.area = ?))`,
    );
    binds.push(areaUuid, areaUuid);
  }
  if (options?.since !== undefined) {
    where.push("t.stopDate >= ?");
    binds.push(options.since.getTime() / 1000);
  }
  if (options?.until !== undefined) {
    where.push("t.stopDate <= ?");
    binds.push(options.until.getTime() / 1000);
  }
  const extra = where.length > 0 ? ` AND ${where.join(" AND ")}` : "";
  // Completion ≠ logged: closed items past the log-move boundary still sit
  // checked in their original lists, exactly like the GUI's Logbook.
  const rows = fetchTaskRows(
    db,
    `${LIVE} AND t.status IN (2, 3) AND t.stopDate <= ?${extra}${tf.sql} ORDER BY t.stopDate DESC${cap === null ? "" : " LIMIT ?"}`,
    [logBoundary(db).getTime() / 1000, ...binds, ...tf.binds, ...(cap === null ? [] : [cap])],
  );
  return materialize(db, rows);
}

export function trashView(db: DatabaseSync, options?: { limit?: number | null }): ListItem[] {
  const cap = options?.limit === null ? null : (options?.limit ?? 200);
  const rows = fetchTaskRows(
    db,
    `t.type IN (0, 1) AND t.trashed = 1 AND ${NOT_TEMPLATE}
     ORDER BY t.userModificationDate DESC${cap === null ? "" : " LIMIT ?"}`,
    cap === null ? [] : [cap],
  );
  return materialize(db, rows);
}

export function projectsView(
  db: DatabaseSync,
  options?: { areaUuid?: string; later?: boolean; now?: Date },
): Project[] {
  // areaUuid accepts a uuid OR a unique (case-insensitive) title; ambiguous
  // or unknown references throw like every other ref resolver.
  const area = options?.areaUuid === undefined ? null : resolveAreaUuid(db, options.areaUuid);
  const packedToday = encodePackedDate(localToday(options?.now));
  // Sidebar default: LATER (someday + future-scheduled) projects are hidden —
  // active means ANYTIME_SELF (a scheduled project whose date has arrived
  // counts active, exactly the Anytime membership test). With later=true they
  // append AFTER the active block of their group, never intermingled.
  const laterSql = options?.later === true ? "" : ` AND ${ANYTIME_SELF("t")}`;
  const laterBinds = options?.later === true ? [] : [packedToday, packedToday];
  // "Active first" within each group needs the same test as an ORDER key
  // (two more binds when later projects are included).
  const activeFirst =
    options?.later === true ? `(CASE WHEN ${ANYTIME_SELF("t")} THEN 0 ELSE 1 END) ASC, ` : "";
  const activeFirstBinds = options?.later === true ? [packedToday, packedToday] : [];
  // Sidebar order, not raw global index (which interleaves areas): loose
  // (area-less) projects first in their own drag order — the GUI lists them
  // above the areas — then each area by ITS sidebar rank (TMArea."index"),
  // projects within an area by their drag order.
  const where = area
    ? `${OPEN} AND t.type = 1 AND t.area = ?${laterSql}
       ORDER BY ${activeFirst}t."index" ASC`
    : `${OPEN} AND t.type = 1${laterSql} ORDER BY (t.area IS NOT NULL) ASC,
       (SELECT a."index" FROM TMArea a WHERE a.uuid = t.area) ASC, ${activeFirst}t."index" ASC`;
  const rows = fetchTaskRows(db, where, [
    ...(area ? [area] : []),
    ...laterBinds,
    ...activeFirstBinds,
  ]);
  const items = materialize(db, rows) as Project[];
  if (options?.later !== true) return items;
  // Each group's later sub-block reads like Upcoming: SCHEDULED projects
  // first — date ascending, todayIndex within a day (the UI's drag order,
  // hidden on entities but present on the raw rows) — then someday in drag
  // order. The SQL already made group runs contiguous with actives leading,
  // so only the later runs are re-sorted (stable within someday).
  const todayIso = localToday(options?.now);
  const ti = new Map(rows.map((r) => [r.uuid, r.todayIndex ?? 0]));
  const isLater = (p: Project) =>
    p.startDate !== null ? p.startDate > todayIso : p.start === "someday";
  const out: Project[] = [];
  let run: Project[] = [];
  let runArea: string | null | undefined;
  const flush = () => {
    out.push(
      ...run
        .map((item, pos) => ({ item, pos }))
        .toSorted((a, b) => {
          const ad = a.item.startDate;
          const bd = b.item.startDate;
          if (ad !== null && bd !== null)
            return (
              ad.localeCompare(bd) ||
              (ti.get(a.item.uuid) ?? 0) - (ti.get(b.item.uuid) ?? 0) ||
              a.pos - b.pos
            );
          if (ad !== null) return -1;
          if (bd !== null) return 1;
          return a.pos - b.pos; // someday keeps drag order
        })
        .map((x) => x.item),
    );
    run = [];
  };
  for (const item of items) {
    const key = item.area?.uuid ?? null;
    if (!isLater(item) || key !== runArea) flush();
    runArea = key;
    if (isLater(item)) run.push(item);
    else out.push(item);
  }
  flush();
  return out;
}

export interface SearchOptions extends ViewFilter {
  /** Row cap; `null` returns every match (surfaces slice for display). */
  limit?: number | null;
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
  options: { since: Date; limit?: number | null },
): ChangedItem[] {
  const cap = options.limit === null ? null : (options.limit ?? 200);
  const sinceEpoch = options.since.getTime() / 1000;
  const rows = fetchTaskRows(
    db,
    `t.type IN (0, 1) AND t.userModificationDate > ?
     ORDER BY t.userModificationDate DESC${cap === null ? "" : " LIMIT ?"}`,
    [sinceEpoch, ...(cap === null ? [] : [cap])],
  );
  // oxlint-disable-next-line no-map-spread -- building fresh change objects, not mutating
  return materialize(db, rows).map((item, i) => ({
    ...item,
    changeKind:
      (rows[i]?.creationDate ?? 0) > sinceEpoch ? ("created" as const) : ("modified" as const),
  }));
}

export function searchView(db: DatabaseSync, query: string, options?: SearchOptions): ListItem[] {
  const cap = options?.limit === null ? null : (options?.limit ?? 50);
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
  // the legacy include-everything behavior. Untrashed means the whole
  // container chain (derived trash, A24B), not just the row's own flag.
  if (options?.all !== true) {
    const statuses = options?.logged === true ? "(0, 2, 3)" : "(0)";
    where.push(`t.status IN ${statuses}`);
    if (options?.trashed !== true) where.push(`t.trashed = 0 AND ${CONTAINER_UNTRASHED}`);
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
     ORDER BY t.userModificationDate DESC${cap === null ? "" : " LIMIT ?"}`,
    [...binds, ...tf.binds, ...(cap === null ? [] : [cap])],
  );
  return materialize(db, rows);
}
