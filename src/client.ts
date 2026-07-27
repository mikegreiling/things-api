/**
 * ThingsClient — the library entry point. Reads via direct SQLite; writes
 * via the verified mutation pipeline (official app surfaces only).
 */
import type { AuditWriter } from "./audit/log.ts";
import { createAuditWriter } from "./audit/log.ts";
import { loadConfig, type ThingsApiConfig } from "./config.ts";
import { resolveClock, clockMeta as buildClockMeta, type ClockMeta } from "./model/clock.ts";
import { PKG_VERSION, type GroupedTruncation, type Truncation } from "./contracts.ts";
import { BASELINES } from "./db/baselines/index.ts";
import { openConnection, type ThingsConnection } from "./db/connection.ts";
import {
  compareToBaseline,
  observeSchema,
  toSchemaStatus,
  type FingerprintStatus,
  type SchemaStatus,
} from "./db/fingerprint.ts";
import { locateThingsDb } from "./db/locate.ts";
import type { AnyTask, Area, Project, Tag } from "./model/entities.ts";
import { auditDir, mutationLockPath } from "./paths.ts";
import { byUuid } from "./read/detail.ts";
import { resolveAreaUuid, resolveProjectUuid, resolveTaskUuidPrefix } from "./read/queries.ts";
import { areaView, type AreaView } from "./read/area-view.ts";
import { projectView, type ProjectView } from "./read/project-view.ts";
import { snapshotView, type Snapshot } from "./read/snapshot.ts";
import { classifyShowTarget, type ShowTarget } from "./read/show-target.ts";
import { areasView, tagsView } from "./read/tags.ts";
import {
  anytimeView,
  changesView,
  inboxView,
  liteTitleSearch,
  logbookView,
  projectsView,
  searchView,
  somedayView,
  todayView,
  trashView,
  upcomingView,
  type ChangedItem,
  type InboxFilter,
  type LiteSearchResult,
  type ListItem,
  type LogbookFilter,
  type SearchOptions,
  type SearchResultItem,
  type SidebarSection,
  type SomedayFilter,
  type TodayFilter,
  type TodayView,
  type UpcomingFilter,
  type ViewFilter,
} from "./read/views.ts";
import {
  capAreaSections,
  previewSections,
  previewSomedaySections,
  truncateList,
  truncateToday,
} from "./read/truncation.ts";
import {
  filterListByArea,
  filterSectionsByArea,
  filterTodayByArea,
  resolveAreaFilter,
  type AreaScopedRead,
  type ViewFilterMeta,
} from "./read/area-filter.ts";
import {
  filterListByScope,
  filterSectionsByScope,
  filterTodayByScope,
  inScopeItem,
  namedAreaClause,
  namedProjectClause,
  resolveScope,
  scopeMeta,
  taskMembershipClause,
  type ResolvedScope,
  type ScopeMeta,
} from "./read/scope.ts";
import { localToday } from "./model/dates.ts";
import type { GroupedLimits } from "./read/sections.ts";
import { resolveCap } from "./read/caps.ts";
import { AREA_PREVIEW_LIMIT, DEFAULT_LIST_LIMIT, PROJECT_PREVIEW_LIMIT } from "./surface-copy.ts";
import type {
  AreaAddParams,
  AreaUpdateParams,
  ContainerRef,
  ProjectCancelParams,
  OperationKind,
  OperationParamsMap,
  ProjectAddParams,
  ProjectCompleteParams,
  ProjectAddRepeatingParams,
  ProjectUpdateParams,
  RepeatRuleParams,
  ReorderParams,
  TagAddParams,
  TagUpdateParams,
  HeadingArchiveParams,
  HeadingUnarchiveParams,
  TodoAddLoggedParams,
  TodoAddParams,
  TodoBackdateParams,
  TodoMoveParams,
  TodoUpdateParams,
} from "./write/operations.ts";
import {
  readAuthToken,
  runMutation,
  type MutationResult,
  type WriteDeps,
  type WriteOptions,
} from "./write/pipeline.ts";
import { runBatch, type BatchItemResult, type BatchOp, type BatchOptions } from "./write/batch.ts";
import { planTagCreation } from "./write/tag-refs.ts";
import { createEnvironmentTracker, type EnvironmentTracker } from "./write/environment.ts";
import {
  runHeadingArchive,
  runHeadingUnarchive,
  type HeadingArchiveResult,
  type HeadingUnarchiveResult,
} from "./write/heading.ts";
import { runClearReminder } from "./write/clear-reminder.ts";
import { runEditChecklist } from "./write/edit-checklist.ts";
import { runAddRepeatingProject, runMakeRepeatingProject } from "./write/make-repeating-project.ts";
import type { ChecklistEdit } from "./write/checklist.ts";
import { runReorder, type ReorderResult } from "./write/reorder.ts";
import { runUndo, type UndoItemResult, type UndoOptions } from "./write/undo.ts";
import {
  runProjectReopen,
  type ProjectReopenOptions,
  type ProjectReopenResult,
} from "./write/reopen.ts";
import { defaultVectors } from "./write/vectors/registry.ts";
import { createUiDriveAux } from "./write/vectors/ui-drag.ts";
import type { WriteVector } from "./write/vectors/types.ts";
import type { PollerDeps } from "./write/verify/poller.ts";

export interface OpenOptions {
  dbPath?: string;
  /** Injectable clock (tests, pinned-clock lab runs). */
  now?: () => Date;
  /**
   * Default consumer IANA zone for every date boundary (tests / explicit
   * embedding). Overrides `THINGS_TZ` from the environment; a per-read `zone`
   * still overrides this. Absent uses `THINGS_TZ`, else the host zone.
   */
  zone?: string;
  /** Injectable write vectors (tests: FakeVector; lab: probe vectors). */
  vectors?: WriteVector[];
  /** Env for config/state-dir resolution (tests). */
  env?: NodeJS.ProcessEnv;
  /**
   * Container scope: a ref (uuid / uuid-prefix / unique area or project name)
   * that jails this client to one container — reads see only in-scope rows,
   * writes are refused (or redirected) outside it, and out-of-scope refs are
   * indistinguishable from nonexistent ones. This is the MCP `--scope` flag's
   * entry point and OUTRANKS `THINGS_API_SCOPE` / the stored `scope` config
   * (the launcher's boundary must not be agent-overridable). Unresolvable →
   * fail closed (ScopeResolutionError). See docs/design/container-scope.md.
   */
  scope?: string;
  /** Test seams for the mutation pipeline. */
  writeOverrides?: {
    ensureRunning?: (alreadyRunning: boolean) => Promise<boolean>;
    isAppRunning?: () => boolean;
    poller?: PollerDeps;
    audit?: AuditWriter;
    sdefProbe?: () => boolean;
    environment?: EnvironmentTracker;
  };
}

/**
 * Row cap for a bounded FLAT view (inbox/today/upcoming/logbook/trash/search/
 * changes). Resolution follows resolveCap: omitted → the 50-row default,
 * an explicit number caps at it, `null` or `all: true` returns every row.
 */
export interface ListBound {
  limit?: number | null;
  all?: boolean;
}

/**
 * Per-read consumer-zone override (the MCP `tz` argument). Overrides the
 * process default (`THINGS_TZ` / the `OpenOptions.zone` embedding / the host)
 * for THIS read only. Absent uses that default; an invalid zone is rejected by
 * the calling surface before it reaches here.
 */
export interface ClockScopedRead {
  zone?: string;
}

/**
 * Per-block caps for a bounded GROUPED view (anytime/someday) or the composite
 * area card. Each omitted cap falls back to the view's own default (anytime:
 * 30 per area, 3 per project; someday: 30 per area, every active-project item;
 * area card: 30 per section); `null` on a cap, or `all: true`, lifts it.
 */
export interface GroupedBound {
  areaLimit?: number | null;
  projectLimit?: number | null;
  all?: boolean;
}

/** A bounded flat view: the shown rows plus the exact truncation counts. */
export interface BoundedList<T> {
  items: T[];
  truncation: Truncation;
  /** The active `area` scope, when one was applied (surfaced as `meta.filter`). */
  filter?: ViewFilterMeta;
}

/**
 * A bounded Today view: `view` is the shown split (capped in render order —
 * Today, then This Evening) and `truncation` the exact counts, including the
 * per-section (`today`/`evening`) breakdown a renderer needs to stay honest.
 */
export interface BoundedTodayView {
  view: TodayView;
  truncation: Truncation;
  /** The active `area` scope, when one was applied (surfaced as `meta.filter`). */
  filter?: ViewFilterMeta;
}

/**
 * A bounded sidebar catalogue (anytime/someday): `view` is the
 * per-block-capped sections and `grouped` the per-block counts (identity-
 * carrying, project blocks nested under their area/loose block).
 */
export interface BoundedSectionsView {
  view: SidebarSection[];
  grouped: GroupedTruncation;
  /** The active `area` scope, when one was applied (surfaced as `meta.filter`). */
  filter?: ViewFilterMeta;
}

/** A bounded composite area card: the per-section-capped view and the per-block counts. */
export interface BoundedAreaView {
  view: AreaView;
  grouped: GroupedTruncation;
}

/** Resolve a flat-view row cap (omitted → default 50; null or all → unbounded). */
function listCap(bound: ListBound | undefined): number | null {
  if (bound?.limit === null) return null;
  const decision = resolveCap(bound?.limit, bound?.all, DEFAULT_LIST_LIMIT);
  return decision === "conflict" ? null : decision;
}

/** Resolve per-block caps (each omitted → its view default; null on a cap, or all, lifts it). */
function groupedCaps(
  bound: GroupedBound | undefined,
  areaDefault: number,
  projectDefault: number | null,
): GroupedLimits {
  const one = (value: number | null | undefined, dflt: number | null): number | null => {
    if (bound?.all === true) return null;
    if (value === null) return null;
    return value ?? dflt;
  };
  return {
    area: one(bound?.areaLimit, areaDefault),
    project: one(bound?.projectLimit, projectDefault),
  };
}

export interface ThingsClient {
  dbPath: string;
  config: ThingsApiConfig;
  /**
   * The active container scope (pinned at open), or undefined when unscoped.
   * The consumer surfaces surface it as the additive `meta.scope` and the
   * one-line "scoped to …" banner so the jail is never silently on.
   */
  scope?: ScopeMeta;
  fingerprint(): FingerprintStatus;
  /**
   * The read-path schema check: the cached fingerprint comparison reduced to a
   * warn-or-not verdict (ok / drift / unknown-version) with detail. Reuses the
   * SAME lazily-built fingerprint the write path gates on — computed at most
   * once per client, so it costs nothing after the first read.
   */
  schemaStatus(): SchemaStatus;
  /**
   * The additive `meta.clock` honesty field for this client's effective clock,
   * or undefined when the host clock is in force (no `THINGS_TZ`/`THINGS_NOW`
   * and no per-read override). `zoneOverride` reflects a per-read zone (the MCP
   * `tz` argument) so the reported `today` matches what that read computed.
   */
  clockMeta(zoneOverride?: string): ClockMeta | undefined;
  read: {
    /**
     * The Today list (Today + This Evening split) with the sidebar badge,
     * bounded to `limit` rows (default 50) counted in render order — Today
     * first, then This Evening. `all`/`limit: null` returns every row; the
     * `truncation` metadata carries the per-section (`today`/`evening`) counts.
     */
    today(options?: TodayFilter & ListBound & ClockScopedRead & AreaScopedRead): BoundedTodayView;
    /** Inbox captures, bounded (default 50). */
    inbox(options?: InboxFilter & ListBound & ClockScopedRead): BoundedList<ListItem>;
    /**
     * Anytime catalogue: every area header and project row is always present;
     * `areaLimit` (default 30) caps each area/loose block, `projectLimit`
     * (default 3) each project block. `all` lifts both. `area` restricts the
     * catalogue to one area (its rows survive; the rest drop).
     */
    anytime(
      options?: ViewFilter & GroupedBound & ClockScopedRead & AreaScopedRead,
    ): BoundedSectionsView;
    /** Future-scheduled items in date order, bounded (default 50). */
    upcoming(
      options?: UpcomingFilter & ListBound & ClockScopedRead & AreaScopedRead,
    ): BoundedList<ListItem>;
    /**
     * Someday catalogue: `areaLimit` (default 30) caps each group; with
     * `activeProjectItems`, `projectLimit` (default: every item) caps each
     * active project's trailing child list. `all` lifts both. `area` restricts
     * the catalogue to one area.
     */
    someday(
      options?: SomedayFilter & GroupedBound & ClockScopedRead & AreaScopedRead,
    ): BoundedSectionsView;
    /** Logbook entries (most recent first), bounded (default 50). */
    logbook(
      options?: Omit<LogbookFilter, "limit"> & ListBound & ClockScopedRead,
    ): BoundedList<ListItem>;
    /** Trashed items (most recently modified first), bounded (default 50). */
    trash(options?: ListBound & ClockScopedRead): BoundedList<ListItem>;
    /**
     * Projects in sidebar order. LATER (someday + future-scheduled) projects
     * are excluded by default — `later: true` appends them after the active
     * block of their group (loose block / area), never intermingled.
     */
    projects(
      options?: { areaUuid?: string; later?: boolean; overdue?: boolean } & ViewFilter &
        ClockScopedRead,
    ): Project[];
    /**
     * Composite project view. Targets by uuid, unique name, or uuid prefix.
     * `overdue: true` keeps only child to-dos whose own deadline is overdue
     * (open, before today); the tag filters (`tags`/`untagged`) keep only the
     * child to-dos carrying the tag DIRECTLY (the container semantics — tags
     * inherited from this project are ignored). Any content scope collapses
     * headings left with no surviving child.
     */
    projectView(ref: string, options?: ViewFilter & ClockScopedRead): ProjectView;
    /**
     * Composite area view: direct to-dos, projects in sidebar order, later,
     * logged. `overdue: true` keeps only the loose to-dos AND child projects
     * whose OWN deadline is overdue; the tag filters keep only the rows
     * matching by their own tags — no descent into project contents. Bounded
     * per section: `projectLimit`/`areaLimit` (default 30 each) cap the ACTIVE
     * project-rows and direct-to-dos sections (scheduled/someday project rows
     * always survive, routed to the card's later sections); `all` lifts both.
     * The `grouped` metadata carries the per-section counts.
     */
    areaView(ref: string, options?: ViewFilter & GroupedBound & ClockScopedRead): BoundedAreaView;
    areas(): Area[];
    tags(): Tag[];
    /** Title/notes substring search, ranked, bounded (default 50). */
    search(query: string, options?: SearchOptions & ClockScopedRead): BoundedList<SearchResultItem>;
    /**
     * Did-you-mean fallback: case-insensitive title-only substring match over
     * areas/projects/to-dos (open + untrashed), ordered and capped. `type`
     * scopes to one class.
     */
    liteTitleSearch(
      query: string,
      options?: { type?: "to-do" | "project" | "area"; limit?: number },
    ): LiteSearchResult;
    /** Rows created/modified since a moment — incl. trashed/logged/templates — bounded (default 50). */
    changes(options: { since: Date } & ListBound & ClockScopedRead): BoundedList<ChangedItem>;
    byUuid(uuid: string): AnyTask | null;
    /**
     * Classify a loose reference (uuid, >=6-char prefix, share link, or
     * area name) into the resource class that has a show view. Headings
     * resolve to their containing project (viaHeading: true).
     */
    showTarget(ref: string): ShowTarget;
    snapshot(): Snapshot;
  };
  write: {
    /** Generic entry: run any cataloged operation. */
    run<K extends OperationKind>(
      op: K,
      params: OperationParamsMap[K],
      options?: WriteOptions,
    ): Promise<MutationResult>;
    addTodo(params: TodoAddParams, options?: WriteOptions): Promise<MutationResult>;
    updateTodo(
      uuid: string,
      patch: Omit<TodoUpdateParams, "uuid">,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    completeTodo(uuid: string, options?: WriteOptions): Promise<MutationResult>;
    cancelTodo(uuid: string, options?: WriteOptions): Promise<MutationResult>;
    reopenTodo(uuid: string, options?: WriteOptions): Promise<MutationResult>;
    moveTodo(
      uuid: string,
      dest: Omit<TodoMoveParams, "uuid">,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    /** Replace the full tag set (an empty list clears all tags). */
    setTags(uuid: string, tags: string[], options?: WriteOptions): Promise<MutationResult>;
    /** Merge: current direct tags + new ones, then replace. */
    addTags(uuid: string, tags: string[], options?: WriteOptions): Promise<MutationResult>;
    replaceChecklist(
      uuid: string,
      items: string[],
      options?: WriteOptions,
    ): Promise<MutationResult>;
    deleteTodo(uuid: string, options?: WriteOptions): Promise<MutationResult>;
    /** Duplicate a to-do; the copy's uuid is on the result. */
    duplicateTodo(uuid: string, options?: WriteOptions): Promise<MutationResult>;
    /** Restore a TRASHED to-do: it returns to the Inbox, de-scheduled. */
    restoreTodo(uuid: string, options?: WriteOptions): Promise<MutationResult>;
    /**
     * Clear a to-do's time-of-day reminder while keeping its scheduled date.
     * Uses the Things proxy shortcuts when installed (in place, and the only
     * path for repeating to-dos); without them, a non-repeating dated to-do
     * falls back to a URL re-schedule that briefly moves it to Today and back.
     * Reversible with `undo`. Force a path with `vector: "shortcuts" | "url-scheme"`.
     */
    clearReminder(uuid: string, options?: WriteOptions): Promise<MutationResult>;
    /**
     * Rewrite a to-do's completion and/or creation timestamp to noon (local)
     * on the given date. Completion requires the to-do to be completed or
     * canceled already.
     */
    backdateTodo(
      uuid: string,
      dates: Omit<TodoBackdateParams, "uuid">,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    /**
     * Create a to-do directly in the Logbook, completed, with backdated
     * completion (and optionally creation) timestamps.
     */
    addLoggedTodo(params: TodoAddLoggedParams, options?: WriteOptions): Promise<MutationResult>;
    /**
     * Create a heading inside an EXISTING project; the new heading's uuid is
     * on the result. Delivered through the Things proxy shortcuts (run
     * `things setup shortcuts` once first).
     */
    addHeading(
      project: ContainerRef,
      title: string,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    /** Rename a heading in place (works on archived headings too). */
    renameHeading(uuid: string, title: string, options?: WriteOptions): Promise<MutationResult>;
    /**
     * Archive a heading (the UI's Archive — it leaves the active project
     * view, reversibly). With open children the policy is mandatory:
     * complete/cancel ride the app's cascade; reparent moves them to the
     * project root first (compound — undo reverses the whole sequence).
     */
    archiveHeading(
      uuid: string,
      policy?: Pick<HeadingArchiveParams, "children">,
      options?: WriteOptions,
    ): Promise<HeadingArchiveResult>;
    /** Un-archive; restoreChildren reopens cascade-resolved children (someday survives). */
    unarchiveHeading(
      uuid: string,
      policy?: Pick<HeadingUnarchiveParams, "restoreChildren">,
      options?: WriteOptions,
    ): Promise<HeadingUnarchiveResult>;
    /** Detach a to-do from its project/area/heading, keeping the schedule. */
    detachTodo(uuid: string, options?: WriteOptions): Promise<MutationResult>;
    /**
     * One granular checklist edit (add/remove/check/uncheck/rename/move):
     * changes a single item while every other item and its checked state is
     * preserved (no reset acknowledgement needed). Items are matched by
     * exact title; item uuids are NOT stable across an edit.
     */
    editChecklist(
      uuid: string,
      edit: ChecklistEdit,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    addProject(params: ProjectAddParams, options?: WriteOptions): Promise<MutationResult>;
    updateProject(
      uuid: string,
      patch: Omit<ProjectUpdateParams, "uuid">,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    completeProject(
      uuid: string,
      policy: Pick<ProjectCompleteParams, "children">,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    /** Move a project to another area. */
    moveProject(uuid: string, area: ContainerRef, options?: WriteOptions): Promise<MutationResult>;
    /** Detach a project from its current area. */
    detachProject(uuid: string, options?: WriteOptions): Promise<MutationResult>;
    /** Cancel a project — open children are canceled with it, so the children policy is mandatory. */
    cancelProject(
      uuid: string,
      policy: Pick<ProjectCancelParams, "children">,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    /**
     * Reopen a completed/canceled project. Children stay resolved unless
     * restoreChildren reopens the ones resolved together with the project.
     */
    reopenProject(uuid: string, options?: ProjectReopenOptions): Promise<ProjectReopenResult>;
    /** Restore a TRASHED project IN PLACE — nothing relocates. */
    restoreProject(uuid: string, options?: WriteOptions): Promise<MutationResult>;
    /** Duplicate a project INCLUDING its children; the copy's uuid is on the result. */
    duplicateProject(uuid: string, options?: WriteOptions): Promise<MutationResult>;
    deleteProject(uuid: string, options?: WriteOptions): Promise<MutationResult>;
    /**
     * Turn an existing project into a repeating series. Drives the local Things
     * app through the Accessibility API (two-key gated: `ui.enabled` config +
     * `dangerouslyDriveGui`). This REPLACES the project with a new repeating
     * template (its area is kept, its schedule is normalized to Someday); the
     * original's identity is gone and it cannot be undone. The new template's
     * uuid is on the result. An area-less Anytime project is moved to Someday
     * first — a cleanup-free intermediate step surfaced in the plan.
     */
    makeRepeatingProject(
      uuid: string,
      rule: Omit<RepeatRuleParams, "uuid">,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    /**
     * Create a project and, in the same call, turn it into a repeating series.
     * TWO operations: the project is created first (and persists even if the
     * make-repeating step refuses); then it is promoted (which drives the GUI —
     * two-key gated, same as makeRepeatingProject). Give an `area` to place it,
     * or omit it to create in Someday. The new template's uuid is on the result.
     */
    addRepeatingProject(
      params: ProjectAddRepeatingParams,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    /** Replace a project's full tag set (an empty list clears all tags). */
    setProjectTags(uuid: string, tags: string[], options?: WriteOptions): Promise<MutationResult>;
    /** Merge: current project tags + new ones, then replace. */
    addProjectTags(uuid: string, tags: string[], options?: WriteOptions): Promise<MutationResult>;
    addArea(params: AreaAddParams, options?: WriteOptions): Promise<MutationResult>;
    updateArea(
      target: string,
      patch: Omit<AreaUpdateParams, "target">,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    deleteArea(target: string, options?: WriteOptions): Promise<MutationResult>;
    addTag(params: TagAddParams, options?: WriteOptions): Promise<MutationResult>;
    updateTag(
      target: string,
      patch: Omit<TagUpdateParams, "target">,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    deleteTag(target: string, options?: WriteOptions): Promise<MutationResult>;
    emptyTrash(options?: WriteOptions): Promise<MutationResult>;
    /**
     * Reorder within Today / This Evening / a project / an area. Partial
     * uuid lists are placed on top; the rest keep their current order.
     */
    reorder(params: ReorderParams, options?: WriteOptions): Promise<ReorderResult>;
    /**
     * Run N ops sequentially and independently — no transactions, a failure
     * does not roll back earlier ops. Per-op results.
     */
    batch(
      ops: BatchOp[],
      options?: BatchOptions,
      onResult?: (result: BatchItemResult) => void,
    ): Promise<BatchItemResult[]>;
    /**
     * Undo changes made through this client, newest first, by applying the
     * inverse change. Selection: `last` trailing changes (default 1), narrowed
     * to author `by` (exact actor, or `*`/undefined for all), or `txn` for one
     * exact change by its `undoToken`. Irreversible changes are reported as
     * such, never guessed at. An inverse is refused when the item changed
     * outside things-api since (its container, status, schedule, trashed state,
     * or a content field moved); `acknowledgeOutOfBandChanges` overwrites anyway.
     */
    undo(options?: UndoOptions, onItem?: (item: UndoItemResult) => void): Promise<UndoItemResult[]>;
  };
  close(): void;
}

// Granular checklist edit primitives live in ./write/checklist.ts (so the
// write-layer orchestrator can reuse them without importing back through the
// client). One granular edit changes a single item while every other item and
// its checked state is preserved. Re-exported for existing consumers.
export type { ChecklistEdit, ChecklistTarget, ChecklistItemAction } from "./write/checklist.ts";
export { applyChecklistEdit } from "./write/checklist.ts";

export function openThings(options: OpenOptions = {}): ThingsClient {
  const located = locateThingsDb(options.dbPath ? { dbPath: options.dbPath } : undefined);
  const conn: ThingsConnection = openConnection(located.path);
  const env = options.env ?? process.env;
  // The effective clock, resolved once from the environment (THINGS_TZ /
  // THINGS_NOW) plus any explicit embedding overrides. Every read/write date
  // boundary rides `now` + `defaultZone`; a per-read `zone` overrides the zone.
  // Malformed values throw ClockError here (fail closed — never a silent host
  // fallback), surfaced by the CLI/MCP as a usage error.
  const clock = resolveClock({
    env,
    ...(options.now !== undefined && { now: options.now }),
    ...(options.zone !== undefined && { tz: options.zone }),
  });
  const now = clock.now;
  const defaultZone = clock.zone;
  const zoneOf = (o?: { zone?: string }): string | undefined => o?.zone ?? defaultZone;
  const config = loadConfig(env);
  // Resolve the container scope ONCE (pinned for the client's life). Precedence:
  // the explicit OpenOptions.scope (the MCP --scope flag) OUTRANKS the config
  // layer's THINGS_API_SCOPE env / stored `scope`. Fail closed — an unresolvable
  // requested scope throws ScopeResolutionError here (the daemon won't start).
  const scopeRequest =
    options.scope !== undefined ? { ref: options.scope, source: "flag" as const } : config.scope;
  const scope: ResolvedScope | undefined =
    scopeRequest !== null && scopeRequest !== undefined
      ? resolveScope(conn.db, scopeRequest.ref, scopeRequest.source)
      : undefined;
  // Precomputed clauses for the scope-aware read resolvers (built once).
  const scopeClauses =
    scope !== undefined
      ? {
          task: taskMembershipClause(scope),
          namedProject: namedProjectClause(scope),
          namedArea: namedAreaClause(scope),
        }
      : undefined;
  /** Resolve an `--area` filter ref scope-aware: an out-of-scope area is not-found (parity). */
  const areaFilterTarget = (ref: string): ReturnType<typeof resolveAreaFilter> => {
    if (scopeClauses !== undefined) {
      resolveAreaUuid(conn.db, ref, {
        scopeWhere: scopeClauses.namedArea.where,
        scopeBinds: scopeClauses.namedArea.binds,
      });
    }
    return resolveAreaFilter(conn.db, ref);
  };
  let cachedStatus: FingerprintStatus | null = null;
  const fingerprint = (): FingerprintStatus => {
    cachedStatus ??= compareToBaseline(observeSchema(conn.db), BASELINES);
    return cachedStatus;
  };

  const token = readAuthToken(conn.db);
  const audit =
    options.writeOverrides?.audit ??
    createAuditWriter({
      dir: auditDir(env),
      secrets: token === null ? [] : [token],
      enabled: config.auditEnabled,
    });

  const writeDeps: WriteDeps = {
    db: conn.db,
    vectors: options.vectors ?? defaultVectors(config, createUiDriveAux(conn.db), located.path),
    config,
    audit,
    fingerprint,
    lockPath: mutationLockPath(env),
    now,
    // The consumer zone normalizes clock-relative `when` tokens (today/evening)
    // to explicit dates before dispatch; a per-write `zone` overrides it.
    ...(defaultZone !== undefined && { zone: defaultZone }),
    // The pinned container scope: makes uuid targets resolve scope-aware and
    // runs the universal scope gate for every write.
    ...(scope !== undefined && { scope }),
    ...(options.writeOverrides?.ensureRunning !== undefined && {
      ensureRunning: options.writeOverrides.ensureRunning,
    }),
    ...(options.writeOverrides?.isAppRunning !== undefined && {
      isAppRunning: options.writeOverrides.isAppRunning,
    }),
    ...(options.writeOverrides?.poller !== undefined && {
      poller: options.writeOverrides.poller,
    }),
    ...(options.writeOverrides?.sdefProbe !== undefined && {
      sdefProbe: options.writeOverrides.sdefProbe,
    }),
    environment: options.writeOverrides?.environment ?? createEnvironmentTracker(PKG_VERSION, env),
  };

  const run = async <K extends OperationKind>(
    op: K,
    params: OperationParamsMap[K],
    writeOptions?: WriteOptions,
  ): Promise<MutationResult> => {
    // --create-tags: create any missing tag named in this op's tags (clean
    // `make new tag` path, mkdir-p for parent/child) before applying. Skipped
    // on a dry run (no side effects). A failed creation leg short-circuits and
    // is returned as this op's result.
    const tags = (params as { tags?: unknown }).tags;
    if (writeOptions?.createTags === true && writeOptions.dryRun !== true && Array.isArray(tags)) {
      const legOptions: WriteOptions = { ...writeOptions, createTags: false };
      for (const step of planTagCreation(conn.db, tags as string[])) {
        // parents must land before children (mkdir-p ordering)
        const legResult = await runMutation(
          writeDeps,
          "tag.add",
          step.parent === undefined
            ? { title: step.title }
            : { title: step.title, parent: step.parent },
          legOptions,
        );
        if (legResult.kind !== "ok") return legResult;
      }
    }
    // Consumer entry point: normalize a consumer-provided `when` (today/evening)
    // to the effective zone before dispatch (a no-op without a zone).
    return runMutation(writeDeps, op, params, { ...writeOptions, normalizeWhen: true });
  };

  return {
    dbPath: located.path,
    config,
    ...(scope !== undefined && { scope: scopeMeta(scope) }),
    fingerprint,
    schemaStatus: () => toSchemaStatus(fingerprint()),
    clockMeta: (zoneOverride) => buildClockMeta(clock, zoneOverride),
    read: {
      // The list views own their bounding: run the full filtered query, then
      // truncate to the resolved cap (default 50 / per-block 30·3) — the exact
      // move the CLI/MCP surfaces used to make. The bounded shape carries the
      // capped view plus the truncation/grouped metadata (the human renderers
      // derive their hidden-count hints from that metadata alone).
      // The `area` filter (when present) is a pure POST-FILTER applied to the
      // shaped view BEFORE the row cap / per-block preview, so `limit` (and the
      // grouped caps) size the FILTERED result. The resolved area rides back as
      // the additive `filter` field (surfaced as `meta.filter`).
      today: (o) => {
        let view = todayView(conn.db, now(), o, zoneOf(o));
        // Scope filter first (the jail), then the per-call --area filter
        // (an intersection); both size the survivors before the row cap.
        if (scope !== undefined)
          view = filterTodayByScope(view, scope, localToday(now(), zoneOf(o)));
        let filter: ViewFilterMeta | undefined;
        if (o?.area !== undefined) {
          const target = areaFilterTarget(o.area);
          view = filterTodayByArea(view, target.uuid, localToday(now(), zoneOf(o)));
          filter = { area: target };
        }
        const { data, truncation } = truncateToday(view, listCap(o));
        return { view: data, truncation, ...(filter !== undefined && { filter }) };
      },
      inbox: (o) => {
        let items = inboxView(conn.db, now(), o, zoneOf(o));
        // The Inbox is outside every container (captures have no area/project),
        // so it is legitimately always empty under a scope — see the add-redirect.
        if (scope !== undefined) items = filterListByScope(items, scope);
        const { data, truncation } = truncateList(items, listCap(o));
        return { items: data, truncation };
      },
      anytime: (o) => {
        let sections = anytimeView(conn.db, now(), o, zoneOf(o));
        if (scope !== undefined) sections = filterSectionsByScope(sections, scope);
        let filter: ViewFilterMeta | undefined;
        if (o?.area !== undefined) {
          const target = areaFilterTarget(o.area);
          sections = filterSectionsByArea(sections, target.uuid);
          filter = { area: target };
        }
        const { data, grouped } = previewSections(
          sections,
          groupedCaps(o, AREA_PREVIEW_LIMIT, PROJECT_PREVIEW_LIMIT),
        );
        return { view: data, grouped, ...(filter !== undefined && { filter }) };
      },
      upcoming: (o) => {
        let items = upcomingView(conn.db, now(), o, zoneOf(o));
        if (scope !== undefined) items = filterListByScope(items, scope);
        let filter: ViewFilterMeta | undefined;
        if (o?.area !== undefined) {
          const target = areaFilterTarget(o.area);
          items = filterListByArea(items, target.uuid);
          filter = { area: target };
        }
        const { data, truncation } = truncateList(items, listCap(o));
        return { items: data, truncation, ...(filter !== undefined && { filter }) };
      },
      someday: (o) => {
        let sections = somedayView(conn.db, now(), o, zoneOf(o));
        if (scope !== undefined) sections = filterSectionsByScope(sections, scope);
        let filter: ViewFilterMeta | undefined;
        if (o?.area !== undefined) {
          const target = areaFilterTarget(o.area);
          sections = filterSectionsByArea(sections, target.uuid);
          filter = { area: target };
        }
        const { data, grouped } = previewSomedaySections(
          sections,
          groupedCaps(o, AREA_PREVIEW_LIMIT, null),
        );
        return { view: data, grouped, ...(filter !== undefined && { filter }) };
      },
      logbook: (o) => {
        // The bound is the truncation cap; the underlying query stays unbounded
        // (limit: null) so the exact total behind the cut is honest.
        const { limit: _limit, all: _all, ...filter } = o ?? {};
        let items = logbookView(conn.db, now(), { ...filter, limit: null }, zoneOf(o));
        // Post-filter to in-scope logged/resolved rows (their area/project
        // linkage survives logging, so inScopeItem resolves).
        if (scope !== undefined) items = filterListByScope(items, scope);
        const { data, truncation } = truncateList(items, listCap(o));
        // Logbook scopes to an area NATIVELY at the query level (its `area`
        // predicate implements the identical effective-area keep-rule); this
        // only resolves the target for the additive `filter` annotation so the
        // meta shape matches the post-filtered views.
        const areaFilter = o?.area !== undefined ? { area: areaFilterTarget(o.area) } : undefined;
        return { items: data, truncation, ...(areaFilter !== undefined && { filter: areaFilter }) };
      },
      trash: (o) => {
        let items = trashView(conn.db, now(), { limit: null }, zoneOf(o));
        // A trashed row keeps its area/project linkage until emptied, so
        // inScopeItem still resolves — out-of-scope trash is invisible.
        if (scope !== undefined) items = filterListByScope(items, scope);
        const { data, truncation } = truncateList(items, listCap(o));
        return { items: data, truncation };
      },
      // Thread the injected clock so `--overdue`'s (and later's) today boundary
      // rides the same clock as every other view — never a hardcoded date.
      projects: (o) => {
        const zone = zoneOf(o);
        const projects = projectsView(conn.db, {
          ...o,
          now: now(),
          ...(zone !== undefined && { zone }),
        });
        // Area scope → projects in the area; project scope → the one scope project.
        return scope !== undefined ? projects.filter((p) => inScopeItem(p, scope)) : projects;
      },
      projectView: (ref, o) =>
        projectView(
          conn.db,
          // Scope-aware resolve: an out-of-scope project ref is not-found (parity
          // with a nonexistent one). Project scope → only the scope project;
          // area scope → in-area projects; all children are in-scope by construction.
          resolveProjectUuid(conn.db, ref, {
            trashed: true,
            ...(scopeClauses !== undefined && {
              scopeWhere: scopeClauses.namedProject.where,
              scopeBinds: scopeClauses.namedProject.binds,
            }),
          }),
          now(),
          o ?? {},
          zoneOf(o),
        ),
      areaView: (ref, o) => {
        // Area scope → only the scope area is viewable; project scope → an area
        // is broader than the jail, so ANY areaView is not-found. Resolve
        // scope-aware first so an out-of-scope area throws the same not-found a
        // nonexistent one does.
        if (scope !== undefined) {
          const clause =
            scope.kind === "area"
              ? scopeClauses!.namedArea
              : { where: "0", binds: [] as (string | number)[] };
          resolveAreaUuid(conn.db, ref, { scopeWhere: clause.where, scopeBinds: clause.binds });
        }
        const { data, grouped } = capAreaSections(
          areaView(conn.db, ref, now(), o ?? {}, zoneOf(o)),
          groupedCaps(o, AREA_PREVIEW_LIMIT, AREA_PREVIEW_LIMIT),
          now(),
          zoneOf(o),
        );
        return { view: data, grouped };
      },
      areas: () => {
        const areas = areasView(conn.db);
        // Area scope → the one scope area; project scope → the project's own
        // area only (its own context, not an oracle for sibling containers).
        if (scope === undefined) return areas;
        const keep = scope.kind === "area" ? scope.uuid : scope.areaUuid;
        return areas.filter((a) => a.uuid === keep);
      },
      tags: () => tagsView(conn.db),
      search: (query, o) => {
        const { limit: _limit, ...rest } = o ?? {};
        let items = searchView(conn.db, query, { ...rest, limit: null }, now(), zoneOf(o));
        // A title search is the classic oracle — post-filter to in-scope rows and
        // recompute the truncation total over survivors (truncateList does this).
        if (scope !== undefined) items = items.filter((i) => inScopeItem(i, scope));
        const { data, truncation } = truncateList(items, listCap(o));
        return { items: data, truncation };
      },
      liteTitleSearch: (query, o) => {
        const result = liteTitleSearch(conn.db, query, o, now(), defaultZone);
        if (scope === undefined) return result;
        // Did-you-mean candidates are a title-match leak — keep only in-scope
        // tasks; areas keep only the scope's own area context.
        const keepArea = scope.kind === "area" ? scope.uuid : scope.areaUuid;
        const candidates = result.candidates.filter((c) =>
          c.kind === "area" ? c.area.uuid === keepArea : inScopeItem(c.task, scope),
        );
        return { ...result, candidates };
      },
      changes: (o) => {
        let items = changesView(conn.db, now(), { since: o.since, limit: null }, zoneOf(o));
        // No out-of-scope uuid may leak into the delta feed (rows are live
        // TMTask, so the effective container resolves).
        if (scope !== undefined) items = items.filter((i) => inScopeItem(i, scope));
        const { data, truncation } = truncateList(items, listCap(o));
        return { items: data, truncation };
      },
      showTarget: (ref) => classifyShowTarget(conn.db, ref, scope),
      byUuid: (uuid) => {
        // Prefix-friendly: unknown refs keep the null contract; ambiguity throws.
        // The injected clock gates `todaySection` to Today members under the
        // consumer's own today (a pinned-clock/lab run reads honestly). Under a
        // scope, an out-of-scope uuid resolves to not-found → null (parity).
        try {
          return byUuid(
            conn.db,
            resolveTaskUuidPrefix(conn.db, uuid, "to-do", scopeClauses?.task),
            now(),
            defaultZone,
          );
        } catch (err) {
          if (err instanceof RangeError && !err.message.includes("ambiguous")) return null;
          throw err;
        }
      },
      snapshot: () => {
        // A snapshot is a whole-library dump; a silently partial one under a
        // scope is misleading. Refuse (a scoped-dump variant is deferred).
        if (scope !== undefined) {
          throw new RangeError(
            "snapshot is a whole-library dump and is not available under an active container scope",
          );
        }
        return snapshotView(conn.db, now(), defaultZone);
      },
    },
    write: {
      run,
      addTodo: (params, o) => run("todo.add", params, o),
      updateTodo: (uuid, patch, o) => run("todo.update", { uuid, ...patch }, o),
      completeTodo: (uuid, o) => run("todo.complete", { uuid }, o),
      cancelTodo: (uuid, o) => run("todo.cancel", { uuid }, o),
      reopenTodo: (uuid, o) => run("todo.reopen", { uuid }, o),
      moveTodo: (uuid, dest, o) => run("todo.move", { uuid, ...dest }, o),
      setTags: (uuid, tags, o) => run("todo.set-tags", { uuid, tags }, o),
      addTags(uuid, tags, o) {
        const current = byUuid(conn.db, uuid);
        const existing =
          current !== null && current.type !== "heading" ? current.tags.map((t) => t.title) : [];
        const merged = [...new Set([...existing, ...tags])];
        return run("todo.set-tags", { uuid, tags: merged }, o);
      },
      replaceChecklist: (uuid, items, o) => run("todo.replace-checklist", { uuid, items }, o),
      deleteTodo: (uuid, o) => run("todo.delete", { uuid }, o),
      duplicateTodo: (uuid, o) => run("todo.duplicate", { uuid }, o),
      restoreTodo: (uuid, o) => run("todo.restore", { uuid }, o),
      backdateTodo: (uuid, dates, o) => run("todo.backdate", { uuid, ...dates }, o),
      addLoggedTodo: (params, o) => run("todo.add-logged", params, o),
      addHeading: (project, title, o) => run("heading.add", { project, title }, o),
      renameHeading: (uuid, title, o) => run("heading.rename", { uuid, title }, o),
      clearReminder: (uuid, o) => runClearReminder(writeDeps, { uuid }, o ?? {}),
      archiveHeading: (uuid, policy, o) =>
        runHeadingArchive(writeDeps, { uuid, ...policy }, o ?? {}),
      unarchiveHeading: (uuid, policy, o) =>
        runHeadingUnarchive(writeDeps, { uuid, ...policy }, o ?? {}),
      detachTodo: (uuid, o) => run("todo.move", { uuid, detach: true }, o),
      editChecklist: (uuid, edit, o) => runEditChecklist(writeDeps, uuid, edit, o ?? {}),
      addProject: (params, o) => run("project.add", params, o),
      updateProject: (uuid, patch, o) => run("project.update", { uuid, ...patch }, o),
      completeProject: (uuid, policy, o) =>
        run("project.complete", { uuid, children: policy.children }, o),
      moveProject: (uuid, area, o) => run("project.move", { uuid, area }, o),
      detachProject: (uuid, o) => run("project.move", { uuid, detach: true }, o),
      cancelProject: (uuid, policy, o) =>
        run("project.cancel", { uuid, children: policy.children }, o),
      reopenProject: (uuid, o) => runProjectReopen(writeDeps, uuid, o ?? {}),
      restoreProject: (uuid, o) => run("project.restore", { uuid }, o),
      duplicateProject: (uuid, o) => run("project.duplicate", { uuid }, o),
      deleteProject: (uuid, o) => run("project.delete", { uuid }, o),
      makeRepeatingProject: (uuid, rule, o) =>
        runMakeRepeatingProject(writeDeps, { uuid, ...rule }, o ?? {}),
      addRepeatingProject: (params, o) => runAddRepeatingProject(writeDeps, params, o ?? {}),
      setProjectTags: (uuid, tags, o) => run("project.set-tags", { uuid, tags }, o),
      addProjectTags(uuid, tags, o) {
        const current = byUuid(conn.db, uuid);
        const existing =
          current !== null && current.type !== "heading" ? current.tags.map((t) => t.title) : [];
        const merged = [...new Set([...existing, ...tags])];
        return run("project.set-tags", { uuid, tags: merged }, o);
      },
      addArea: (params, o) => run("area.add", params, o),
      updateArea: (target, patch, o) => run("area.update", { target, ...patch }, o),
      deleteArea: (target, o) => run("area.delete", { target }, o),
      addTag: (params, o) => run("tag.add", params, o),
      updateTag: (target, patch, o) => run("tag.update", { target, ...patch }, o),
      deleteTag: (target, o) => run("tag.delete", { target }, o),
      emptyTrash: (o) => run("trash.empty", {}, o),
      reorder: (params, o) => runReorder(writeDeps, params, o ?? {}),
      batch: (ops, o, onResult) => runBatch(writeDeps, ops, o ?? {}, onResult),
      undo: (o, onItem) => runUndo(writeDeps, auditDir(env), o ?? {}, onItem),
    },
    close: () => conn.close(),
  };
}
