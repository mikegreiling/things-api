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
 *             gray = the rest (exact 270/122 reconciliation on live data). The
 *             badge counts OPEN members only — a checked-but-unswept row is in
 *             the list but out of the count (the GUI badge is remaining work).
 *             CHECKED-BUT-UNSWEPT (GUI-parity ruling 2026-07-14, Mike — "this
 *             is the behavior of the Things GUI and I like it"): membership is
 *             OPEN_OR_UNSWEPT, not OPEN — a completed/canceled row the log-move
 *             sweep has NOT yet passed (completion ≠ logged; see
 *             log-boundary.ts) stays in Today IN PLACE, keeping the exact
 *             comparator slot (startBucket / referenceDate / todayIndex) it held
 *             open. It leaves when the sweep boundary advances past its stopDate
 *             (boundary-relative, no new state). Mixed-context resolved styling
 *             (dim / dim+strike) applies automatically in formatItem.
 * - anytime:  ALL active items — unscheduled PLUS Today members (the UI
 *             renders Today members with a star; live-verified via screenshot
 *             2026-07-02: starred = in Today, unstarred = unscheduled).
 *             Star equivalence: startDate != NULL && <= today.
 *             CONTAINER CASCADE (live-verified 2026-07-09): children of a
 *             project that is not itself anytime-visible (someday/future/
 *             logged/trashed) are excluded — the project row represents
 *             them. Result is grouped in sidebar order (SidebarSection[]).
 *             CHECKED-BUT-UNSWEPT (GUI-parity ruling 2026-07-14, Mike): like
 *             Today, membership is OPEN_OR_UNSWEPT — a closed row the sweep has
 *             not passed keeps its index slot until the boundary moves past its
 *             stopDate. A closed-but-unswept PROJECT row shows in place and its
 *             children stay cascade-excluded (PROJECT_ANYTIME_ACTIVE still tests
 *             p.status = 0): the checked project row represents its children,
 *             the same precedent as a logged/someday container.
 * - upcoming: TWO cohorts merged, grouped/sorted by COALESCE(startDate,
 *             deadline) (UPC1, GUI-verified, docs/lab/upcoming-research.md):
 *             (1) SCHEDULED — start=2 AND startDate > today, grouped under its
 *             when-date (a deadline it also carries rides along as a flag);
 *             (2) DEADLINE-FORECAST — startDate IS NULL AND start IN (1, 2)
 *             AND deadline > today AND (deadlineSuppressionDate IS NULL OR
 *             deadlineSuppressionDate < deadline), grouped under its DEADLINE
 *             date (both to-dos and projects). INBOX (start=0) is EXCLUDED — a
 *             future deadline does not forecast an Inbox item into Upcoming,
 *             though a DUE one still pulls it into Today. The suppression guard
 *             drops a dismissed-nag deadline (supp == deadline) and lets a
 *             re-armed one (supp < deadline) reappear — the todayView clause
 *             one step earlier (deadline > today). A when+deadline row appears
 *             ONCE under its when-date, never double-emitted (the forecast
 *             cohort requires startDate IS NULL). Forecast rows keep
 *             startDate=null (no faked when-date). PLUS each fixed repeating
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
  directTagScopeSql,
  directUntaggedScopeSql,
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
  untaggedScopeSql,
} from "./queries.ts";
import {
  ANYTIME_SELF,
  CONTAINER_UNTRASHED,
  EFF_PROJECT,
  LIVE,
  OPEN,
  OPEN_OR_UNSWEPT,
  OVERDUE,
  PROJECT_ANYTIME_ACTIVE,
} from "./predicates.ts";
import { groupBySidebar } from "./sidebar-order.ts";
import type { Area } from "../model/entities.ts";
import { areasView } from "./tags.ts";
import { compareSearchMatches, type MatchField, type SearchMatch } from "./search-rank.ts";

export type ListItem = Todo | Project;

/** Optional list-view filters. */
export interface ViewFilter {
  /**
   * Convenience shorthand for a single-element {@link tags} — a lone
   * inheritance-inclusive tag ref. Production surfaces (CLI `--tag`, MCP
   * `tag`) always pass the array form; this exists for internal/test callers.
   */
  tag?: string;
  /**
   * Tag refs (uuid or unique title). In FLAT views (today/inbox/anytime/
   * someday/upcoming/search/logbook) this is direct OR inherited membership (UI
   * semantics), INCLUDING items tagged with a hierarchy descendant of each
   * given tag (documented app behavior — the UI's tag filter matches
   * child-tagged items; not lab-oracled). In CONTAINER views (`project show`,
   * `area show`, the `projects` list) the same ref instead matches rows carrying
   * the tag DIRECTLY (still with descendant expansion) — the view's own
   * container-inheritance hop is suppressed, since every child inherits the
   * container's tags and an inheritance-inclusive filter there is vacuous. The
   * host view selects the behavior via {@link tagFilter}'s `container` option.
   * Multiple refs AND together — an item must match EVERY ref (each
   * independently expanded to its descendant set, OR-matched within,
   * AND-combined across).
   */
  tags?: string[];
  /**
   * Match each given tag ref ONLY — no hierarchy descendants. Useful when a
   * parent tag has its own direct assignments distinct from its children's.
   */
  exactTag?: boolean;
  /**
   * Only items with NO tag (the GUI's "No Tag"). In FLAT views this negates the
   * WHOLE direct+inherited membership relation — an item is untagged iff no
   * possible `tag` value could ever match it. In CONTAINER views it instead
   * means "no DIRECT tag" (the container's own inherited tags are suppressed,
   * matching the container `tag` semantics). Mutually exclusive with
   * `tag`/`exactTag` (the surfaces reject the combination).
   */
  untagged?: boolean;
  /**
   * Only OPEN items whose deadline is strictly BEFORE today (due-today is NOT
   * overdue — it mirrors the app's Today badge, where an equal-to-today
   * deadline is "due" and only an earlier one is "overdue"). A content scope
   * like `tag`: it narrows, never lifts a default, and composes as AND with
   * `tag`/`untagged`. The boundary rides the view's injected clock (see
   * {@link OVERDUE}). Honored by the current-work views (today, inbox, anytime,
   * someday, search); the forward-looking `upcoming` and the closed-item
   * `logbook` deliberately do not accept it (see docs/design/cli-grammar.md).
   */
  overdue?: boolean;
}

/**
 * Compose the tag scope for a filter into an AND-chained SQL fragment plus its
 * binds. Every clause AND-combines: the `untagged` negation and each `--tag`
 * ref (each ref independently resolved and descendant-expanded per `exactTag`).
 * The mutually-exclusive combination (`untagged` with a tag-presence flag) is
 * refused at the CLI/MCP surfaces; here it would simply AND to an empty result.
 * Splices in before {@link overdueFilter} so the tag binds precede the overdue
 * bind.
 *
 * `options.container` selects the CONTAINER semantics (`project show` /
 * `area show` / the `projects` list): the view's own inheritance hop is dropped,
 * so `--tag` matches a DIRECT assignment (still descendant-expanded) and
 * `--untagged` means "no direct tag". Every child inherits its container's tags,
 * so an inheritance-inclusive filter there is vacuous — direct-on-the-row is the
 * useful, GUI-faithful behavior. FLAT views omit the option and keep the
 * inheritance-inclusive relation.
 */
export function tagFilter(
  db: DatabaseSync,
  filter: ViewFilter | undefined,
  options?: { container?: boolean },
): { sql: string; binds: string[] } {
  const container = options?.container === true;
  const clauses: string[] = [];
  const binds: string[] = [];
  if (filter?.untagged === true)
    clauses.push(container ? directUntaggedScopeSql() : untaggedScopeSql());
  const exact = filter?.exactTag === true;
  const tagRefs = [...(filter?.tags ?? []), ...(filter?.tag !== undefined ? [filter.tag] : [])];
  const expand = (ref: string): string[] => {
    const target = resolveTagUuid(db, ref);
    return exact ? [target] : tagWithDescendants(db, target);
  };
  for (const ref of tagRefs) {
    const uuids = expand(ref);
    if (container) {
      clauses.push(directTagScopeSql(uuids.length));
      binds.push(...uuids);
    } else {
      clauses.push(tagScopeSql(uuids.length));
      binds.push(...tagScopeBinds(uuids));
    }
  }
  if (clauses.length === 0) return { sql: "", binds: [] };
  return { sql: ` AND ${clauses.join(" AND ")}`, binds };
}

/**
 * The `--overdue` content scope as a spliceable SQL fragment (empty when off).
 * Appended AFTER {@link tagFilter} in every host view so it intersects with the
 * tag scope, and its single packed-today bind trails the tag binds in the same
 * order. `packedToday` is encodePackedDate(localToday(now)) — the caller's
 * injected clock — never a hardcoded date.
 */
function overdueFilter(
  filter: ViewFilter | undefined,
  packedToday: number,
): { sql: string; binds: number[] } {
  if (filter?.overdue !== true) return { sql: "", binds: [] };
  return { sql: ` AND ${OVERDUE}`, binds: [packedToday] };
}

function materialize(db: DatabaseSync, rows: TaskRow[], boundary = logBoundary(db)): ListItem[] {
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
  // The caller may pass the boundary it already used for the SQL membership
  // filter so the `logged` flag and the row's presence agree (a checked-unswept
  // row must materialize with logged=false).
  return markLogged(items, boundary);
}

export interface TodayView {
  today: ListItem[];
  evening: ListItem[];
  /** Mirrors the sidebar badge: red = deadline due/overdue, gray = the rest. */
  badge: { dueOrOverdue: number; other: number };
}

export interface TodayFilter extends ViewFilter {
  /**
   * Restrict to the This-Evening section: the Today section is filtered out
   * (returned empty) and the badge counts only the evening members. A section
   * visibility toggle, not a volume change — the row limit still applies.
   */
  eveningOnly?: boolean;
}

/** Badge = OPEN members only (the GUI badge counts remaining work). */
const isOpen = (i: ListItem) => i.status === "open";

export function todayView(db: DatabaseSync, now?: Date, filter?: TodayFilter): TodayView {
  const todayIso = localToday(now);
  const packedToday = encodePackedDate(todayIso);
  const tf = tagFilter(db, filter);
  const of = overdueFilter(filter, packedToday);
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
  // Membership is OPEN_OR_UNSWEPT (not OPEN): a checked row the log-move sweep
  // has not yet passed keeps its comparator slot in place (GUI-parity ruling
  // 2026-07-14). The boundary is threaded into both the SQL filter and
  // materialize so the row's presence and its `logged` flag agree.
  const boundary = logBoundary(db, now);
  const rows = fetchTaskRows(
    db,
    `${OPEN_OR_UNSWEPT} AND ${CONTAINER_UNTRASHED} AND (
       (t.startDate IS NOT NULL AND t.startDate <= ? AND t.start IN (1, 2))
       OR (t.deadline IS NOT NULL AND t.deadline <= ? AND t.startDate IS NULL
           AND (t.deadlineSuppressionDate IS NULL OR t.deadlineSuppressionDate < t.deadline))
     )${tf.sql}${of.sql}
     ORDER BY t.startBucket ASC,
              COALESCE(t.todayIndexReferenceDate, t.startDate, t.deadline) DESC,
              t.todayIndex ASC, t.uuid ASC`,
    [boundary.getTime() / 1000, packedToday, packedToday, ...tf.binds, ...of.binds],
  );
  const items = materialize(db, rows, boundary);
  // Evening membership expires daily: raw startBucket=1 counts only while
  // startDate is exactly today; stale evening items belong to Today proper.
  const isEvening = (i: ListItem) => i.todaySection === "evening" && i.startDate === todayIso;
  const evening = items.filter(isEvening);
  const dueIn = (list: ListItem[]) =>
    list.filter((i) => i.deadline !== null && i.deadline <= todayIso).length;
  // Badge = OPEN members only (the GUI badge counts remaining work). A
  // checked-but-unswept row is present in the list but never moves the badge —
  // this preserves the exact live reconciliation computed under OPEN membership.
  // The evening filter mirrors the tag filter's badge treatment: the badge
  // reflects exactly the members the view now returns (here, evening only).
  if (filter?.eveningOnly === true) {
    const openEvening = evening.filter(isOpen);
    const eveningDue = dueIn(openEvening);
    return {
      today: [],
      evening,
      badge: { dueOrOverdue: eveningDue, other: openEvening.length - eveningDue },
    };
  }
  const openItems = items.filter(isOpen);
  const dueOrOverdue = dueIn(openItems);
  return {
    today: items.filter((i) => !isEvening(i)),
    evening,
    badge: { dueOrOverdue, other: openItems.length - dueOrOverdue },
  };
}

export interface InboxFilter extends ViewFilter {
  /**
   * Only captures created at/after this instant. Keyed on the item's CREATION
   * timestamp (the raw Cocoa/Unix-epoch creationDate, compared like
   * `changes`/`logbook` do their epoch columns — NOT the packed startDate
   * encoding). A demoted item keeps its original creation date, so this is
   * arrival-into-Things, not arrival-into-the-Inbox.
   */
  since?: Date;
  /** Only captures created at/before this instant (creation timestamp). */
  until?: Date;
}

export function inboxView(db: DatabaseSync, now?: Date, filter?: InboxFilter): ListItem[] {
  const tf = tagFilter(db, filter);
  // `now` is threaded only for the `--overdue` boundary (the inbox order and
  // the since/until window key on epoch creationDate, not on today).
  const of = overdueFilter(filter, encodePackedDate(localToday(now)));
  const where = [OPEN, "t.start = 0"];
  const binds: (string | number)[] = [];
  // creationDate is an epoch REAL (Unix seconds) — mirror the changes/logbook
  // comparison (getTime()/1000 against the raw column), never encodePackedDate.
  if (filter?.since !== undefined) {
    where.push("t.creationDate >= ?");
    binds.push(filter.since.getTime() / 1000);
  }
  if (filter?.until !== undefined) {
    where.push("t.creationDate <= ?");
    binds.push(filter.until.getTime() / 1000);
  }
  const rows = fetchTaskRows(
    db,
    `${where.join(" AND ")}${tf.sql}${of.sql} ORDER BY t."index" ASC`,
    [...binds, ...tf.binds, ...of.binds],
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

export function anytimeView(db: DatabaseSync, now?: Date, filter?: ViewFilter): SidebarSection[] {
  const packedToday = encodePackedDate(localToday(now));
  const tf = tagFilter(db, filter);
  const of = overdueFilter(filter, packedToday);
  // Mirrors UI membership: every active item, including Today members
  // (starred in the UI) and pending-promotion rows (start=2, past-dated) —
  // MINUS children of non-active containers (the project cascade). Membership
  // is OPEN_OR_UNSWEPT (GUI-parity ruling 2026-07-14): a checked row the sweep
  // has not passed keeps its index slot. PROJECT_ANYTIME_ACTIVE still requires
  // the parent project be open, so a closed-but-unswept project's children stay
  // cascade-excluded — the checked project row represents them. The boundary is
  // threaded into the SQL filter and materialize so presence and `logged` agree.
  const boundary = logBoundary(db, now);
  const rows = fetchTaskRows(
    db,
    `${OPEN_OR_UNSWEPT} AND ${ANYTIME_SELF("t")}
     AND ${PROJECT_ANYTIME_ACTIVE}${tf.sql}${of.sql} ORDER BY t."index" ASC`,
    [
      boundary.getTime() / 1000,
      packedToday,
      packedToday,
      packedToday,
      packedToday,
      ...tf.binds,
      ...of.binds,
    ],
  );
  return groupBySidebar(db, materialize(db, rows, boundary));
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

/**
 * The merged date-ordered stream keys on COALESCE(startDate, deadline) — a
 * scheduled row groups under its when-date, a forecast row under its deadline.
 */
const groupKey = (i: ListItem): string => i.startDate ?? i.deadline ?? "";

export function upcomingView(db: DatabaseSync, now?: Date, filter?: UpcomingFilter): ListItem[] {
  const packedToday = encodePackedDate(localToday(now));
  const until = filter?.until;
  const since = filter?.since;
  const untilBinds = until === undefined ? [] : [encodePackedDate(until)];
  const sinceBinds = since === undefined ? [] : [encodePackedDate(since)];
  const tf = tagFilter(db, filter);

  // Cohort 1 — SCHEDULED: start=2 with a future startDate. The bounds clip the
  // APPEARANCE date, which for these rows is the startDate (when-date).
  const schedUntilSql = until === undefined ? "" : " AND t.startDate <= ?";
  const schedSinceSql = since === undefined ? "" : " AND t.startDate >= ?";
  const rows = fetchTaskRows(
    db,
    `${OPEN} AND ${CONTAINER_UNTRASHED}
     AND t.start = 2 AND t.startDate IS NOT NULL AND t.startDate > ?${schedUntilSql}${schedSinceSql}${tf.sql}
     ORDER BY t.startDate ASC, t."index" ASC`,
    [packedToday, ...untilBinds, ...sinceBinds, ...tf.binds],
  );

  // Cohort 2 — DEADLINE-FORECAST (UPC1, GUI-verified): anytime/someday to-dos
  // and someday projects carrying a FUTURE deadline and no when-date. Inbox
  // (start=0) is excluded; a dismissed-nag deadline (deadlineSuppressionDate ==
  // deadline) is dropped while a re-armed one (supp < deadline) survives — the
  // todayView suppression clause one step earlier (deadline > today, not <=).
  // These rows keep startDate NULL (JSON honesty) and APPEAR under their
  // deadline, so the bounds clip on deadline, exactly as cohort 1 clips on
  // startDate.
  const fcUntilSql = until === undefined ? "" : " AND t.deadline <= ?";
  const fcSinceSql = since === undefined ? "" : " AND t.deadline >= ?";
  const forecastRows = fetchTaskRows(
    db,
    `${OPEN} AND ${CONTAINER_UNTRASHED}
     AND t.startDate IS NULL AND t.start IN (1, 2)
     AND t.deadline IS NOT NULL AND t.deadline > ?
     AND (t.deadlineSuppressionDate IS NULL OR t.deadlineSuppressionDate < t.deadline)${fcUntilSql}${fcSinceSql}${tf.sql}
     ORDER BY t.deadline ASC, t."index" ASC`,
    [packedToday, ...untilBinds, ...sinceBinds, ...tf.binds],
  );

  const scheduled = materialize(db, rows);
  const forecast = materialize(db, forecastRows);

  // The merged date-ordered stream keys on COALESCE(startDate, deadline) — a
  // scheduled row groups under its when-date, a forecast row under its deadline
  // — then the UI's within-day drag order (todayIndex ASC; live-verified
  // 2026-07-11 against the GUI — plain `index` disagrees), then a stable
  // seed-order/uuid tiebreak.
  const sortDated = (list: ListItem[], indexRows: TaskRow[]): ListItem[] => {
    const todayIndexOf = new Map<string, number>(indexRows.map((r) => [r.uuid, r.todayIndex ?? 0]));
    return list
      .map((item, pos) => ({ item, pos }))
      .toSorted(
        (a, b) =>
          groupKey(a.item).localeCompare(groupKey(b.item)) ||
          (todayIndexOf.get(a.item.uuid) ?? 0) - (todayIndexOf.get(b.item.uuid) ?? 0) ||
          a.pos - b.pos ||
          a.item.uuid.localeCompare(b.item.uuid),
      )
      .map((x) => x.item);
  };

  if (filter?.repeats === false)
    return sortDated([...scheduled, ...forecast], [...rows, ...forecastRows]);

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

  // The scheduled + forecast + occurrence rows share one date-ordered stream
  // (COALESCE(startDate, deadline), then the UI's within-day drag order).
  const dated = sortDated(
    [...scheduled, ...forecast, ...occurrences],
    [...rows, ...forecastRows, ...templateRows],
  );

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

/** A someday to-do nested under a project (directly or via a heading). */
const isChild = (i: ListItem) =>
  i.type === "to-do" && (i.project !== null || i.headingProject !== null);

export function somedayView(
  db: DatabaseSync,
  now?: Date,
  filter?: SomedayFilter,
): SidebarSection[] {
  const tf = tagFilter(db, filter);
  const packedToday = encodePackedDate(localToday(now));
  const of = overdueFilter(filter, packedToday);
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
     AND (${EFF_PROJECT} IS NULL OR ${childArm})${tf.sql}${of.sql} ORDER BY t."index" ASC`,
    [...(withActiveChildren ? [packedToday, packedToday] : []), ...tf.binds, ...of.binds],
  );
  const sections = groupBySidebar(db, materialize(db, rows));
  // GUI order within a Someday group (live side-by-side, 2026-07-12):
  // PROJECT rows first (their sidebar order preserved), then direct to-dos in
  // drag order. Someday children of active projects (the activeProjectItems
  // toggle) trail the group, still clustered by their project — surfaces
  // present them as a separate "From active projects" section.
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
  options?: { areaUuid?: string; later?: boolean; overdue?: boolean; now?: Date } & ViewFilter,
): Project[] {
  // areaUuid accepts a uuid OR a unique (case-insensitive) title; ambiguous
  // or unknown references throw like every other ref resolver.
  const area = options?.areaUuid === undefined ? null : resolveAreaUuid(db, options.areaUuid);
  const packedToday = encodePackedDate(localToday(options?.now));
  // Tag scope (§9a): the projects LIST is a FLAT view (like `anytime` restricted
  // to project rows), NOT a single-container view — projects sit in different
  // areas with heterogeneous inheritance, there is no universally-inherited tag
  // set, and inherited tags are opaque here (area headers don't show what they
  // confer), so filtering by an inherited tag is useful. `--tag`/`--untagged`
  // are INHERITANCE-INCLUSIVE (a project inherits its area's tags). Its binds sit
  // in the WHERE, after the overdue bind and before the active-first binds.
  const tf = tagFilter(db, options);
  // OWN-DEADLINE UNIFORM: `--overdue` keeps only projects whose OWN deadline is
  // overdue (open, strictly before today) — projects carry a `deadline` column
  // exactly like to-dos, so the shared OVERDUE predicate applies to project
  // rows verbatim. A content scope: it narrows the list, never lifts a limit.
  const overdueSql = options?.overdue === true ? ` AND ${OVERDUE}` : "";
  const overdueBinds = options?.overdue === true ? [packedToday] : [];
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
    ? `${OPEN} AND t.type = 1 AND t.area = ?${laterSql}${overdueSql}${tf.sql}
       ORDER BY ${activeFirst}t."index" ASC`
    : `${OPEN} AND t.type = 1${laterSql}${overdueSql}${tf.sql} ORDER BY (t.area IS NOT NULL) ASC,
       (SELECT a."index" FROM TMArea a WHERE a.uuid = t.area) ASC, ${activeFirst}t."index" ASC`;
  const rows = fetchTaskRows(db, where, [
    ...(area ? [area] : []),
    ...laterBinds,
    ...overdueBinds,
    ...tf.binds,
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

/** One did-you-mean candidate: an area, or a task (project / to-do). */
export type LiteCandidate = { kind: "area"; area: Area } | { kind: "task"; task: ListItem };

export interface LiteSearchResult {
  /** Ordered (containers first, then to-dos; within a group: active before someday, then most-recently-modified) and capped. */
  candidates: LiteCandidate[];
  /** Total matches before the cap. */
  total: number;
}

/**
 * The did-you-mean fallback search: a case-insensitive SUBSTRING match on
 * TITLES ONLY (never notes, headings, or checklist items), across areas,
 * projects, and to-dos — open + untrashed only. Ordered per the house
 * doctrine: containers (areas, then projects) first, then to-dos; within a
 * group active rows precede someday rows, then most-recently-modified. `type`
 * scopes to a single class (the typed-namespace paths). Results are capped
 * (default 10); `total` reports the pre-cap match count so the caller can
 * append a "… n more" tail.
 */
const somedayRank = (i: ListItem): number => (i.start === "someday" ? 1 : 0);

/** Lite-search order within a task group: active before someday, then most-recently-modified. */
function byStatusThenRecent(a: ListItem, b: ListItem): number {
  return somedayRank(a) - somedayRank(b) || b.modified.getTime() - a.modified.getTime();
}

export function liteTitleSearch(
  db: DatabaseSync,
  query: string,
  options?: { type?: "to-do" | "project" | "area"; limit?: number },
): LiteSearchResult {
  const cap = options?.limit ?? 10;
  const type = options?.type;
  const needle = query.toLowerCase();

  const areas =
    type === undefined || type === "area"
      ? areasView(db)
          .filter((a) => a.title.toLowerCase().includes(needle))
          .toSorted((a, b) => a.title.localeCompare(b.title))
      : [];

  let tasks: ListItem[] = [];
  if (type === undefined || type === "to-do" || type === "project") {
    const typeSql =
      type === "to-do" ? "t.type = 0" : type === "project" ? "t.type = 1" : "t.type IN (0, 1)";
    const rows = fetchTaskRows(
      db,
      `${OPEN} AND ${CONTAINER_UNTRASHED} AND ${typeSql} AND t.title LIKE ?`,
      [`%${query}%`],
    );
    tasks = materialize(db, rows);
  }

  const projects = tasks.filter((t) => t.type === "project").toSorted(byStatusThenRecent);
  const todos = tasks.filter((t) => t.type === "to-do").toSorted(byStatusThenRecent);

  const ordered: LiteCandidate[] = [
    ...areas.map((area): LiteCandidate => ({ kind: "area", area })),
    ...projects.map((task): LiteCandidate => ({ kind: "task", task })),
    ...todos.map((task): LiteCandidate => ({ kind: "task", task })),
  ];
  return { candidates: ordered.slice(0, cap), total: ordered.length };
}

/** A search result annotated with WHY it surfaced (additive; `matchedVia` present only for heading-credited projects). */
export type SearchResultItem = ListItem & { matchedVia?: { kind: "heading"; title: string } };

export function searchView(
  db: DatabaseSync,
  query: string,
  options?: SearchOptions,
  now?: Date,
): SearchResultItem[] {
  const cap = options?.limit === null ? null : (options?.limit ?? 50);
  const needle = `%${query}%`;
  // `--overdue` narrows to OPEN, past-deadline matches. Its open-only predicate
  // is contradictory with the status-widening flags (logged/trashed/all); the
  // CLI/MCP surfaces reject that combination, so here it simply intersects.
  const of = overdueFilter(options, encodePackedDate(localToday(now)));

  // The scope predicates (everything except the match needle), reused verbatim
  // for the needle query AND the heading-credited-project query so both honor
  // the same type/status/scope constraints.
  const scope: string[] = [NOT_TEMPLATE];
  const scopeBinds: unknown[] = [];
  scope.push(
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
    scope.push(`t.status IN ${statuses}`);
    if (options?.trashed !== true) scope.push(`t.trashed = 0 AND ${CONTAINER_UNTRASHED}`);
  }
  if (options?.project !== undefined) {
    const uuid = resolveProjectUuid(db, options.project);
    // Children incl. headed ones (heading rows carry the project link).
    scope.push(
      "(t.project = ? OR t.heading IN (SELECT uuid FROM TMTask WHERE type = 2 AND project = ?))",
    );
    scopeBinds.push(uuid, uuid);
  }
  if (options?.area !== undefined) {
    const uuid = resolveAreaUuid(db, options.area);
    scope.push("t.area = ?");
    scopeBinds.push(uuid);
  }
  const tf = tagFilter(db, options);

  // Needle matches: title OR notes. No SQL LIMIT — ranking runs before the cap.
  const rows = fetchTaskRows(
    db,
    `${scope.join(" AND ")} AND (t.title LIKE ? OR t.notes LIKE ?)${tf.sql}${of.sql}`,
    [...scopeBinds, needle, needle, ...tf.binds, ...of.binds],
  );
  const needleLower = query.toLowerCase();
  const matches = new Map<string, SearchMatch>();
  for (const item of materialize(db, rows)) {
    // Field credit: title beats notes when both carry the substring.
    const field: MatchField = item.title.toLowerCase().includes(needleLower) ? "title" : "notes";
    matches.set(item.uuid, { item, field });
  }

  // Heading titles are treated as if they lived in the parent PROJECT's notes:
  // a heading-title match surfaces the parent project (never a bare heading
  // row), credited at the heading-via-project field rank. A to-do-only search
  // has no project rows, so headings do not apply there.
  if (options?.type !== "to-do") {
    const headingRows = db
      .prepare(
        `SELECT project AS projectUuid, title FROM TMTask
         WHERE type = 2 AND project IS NOT NULL AND trashed = 0 AND title LIKE ?`,
      )
      .all(needle) as unknown as Array<{ projectUuid: string; title: string | null }>;
    const headingTitleFor = new Map<string, string>();
    for (const h of headingRows) {
      if (!headingTitleFor.has(h.projectUuid)) headingTitleFor.set(h.projectUuid, h.title ?? "");
    }
    // Surface only the projects NOT already matched by their own title/notes
    // (a higher-ranked field already represents them), and only those passing
    // the view's scope.
    const wanted = [...headingTitleFor.keys()].filter((uuid) => !matches.has(uuid));
    if (wanted.length > 0) {
      const placeholders = wanted.map(() => "?").join(", ");
      const projectRows = fetchTaskRows(
        db,
        `${scope.join(" AND ")} AND t.type = 1 AND t.uuid IN (${placeholders})${tf.sql}${of.sql}`,
        [...scopeBinds, ...wanted, ...tf.binds, ...of.binds],
      );
      for (const item of materialize(db, projectRows)) {
        const matchedVia = {
          kind: "heading" as const,
          title: headingTitleFor.get(item.uuid) ?? "",
        };
        // Annotate the freshly materialized entity in place (owned here).
        (item as SearchResultItem).matchedVia = matchedVia;
        matches.set(item.uuid, { item, field: "heading", matchedVia });
      }
    }
  }

  const ranked = [...matches.values()].toSorted(compareSearchMatches);
  const sliced = cap === null ? ranked : ranked.slice(0, cap);
  return sliced.map((m) => m.item as SearchResultItem);
}
