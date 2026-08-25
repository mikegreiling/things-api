/**
 * ThingsClient — the library entry point. Reads via direct SQLite; writes
 * via the verified mutation pipeline (official app surfaces only).
 */
import type { AuditWriter } from "./audit/log.ts";
import { createAuditWriter } from "./audit/log.ts";
import { loadConfig, type ThingsApiConfig } from "./config.ts";
import { resolveClock, clockMeta as buildClockMeta, type ClockMeta } from "./model/clock.ts";
import { PKG_VERSION, type GroupBlock, type Truncation } from "./contracts.ts";
import { BASELINES } from "./db/baselines/index.ts";
import { openConnection, type ThingsConnection } from "./db/connection.ts";
import { createDeputyDbFacade } from "./deputy/db-facade.ts";
import { deputyDbPath, deputyRoutesDb } from "./deputy/routing.ts";
import { readAllowed, readCapability, ReadCapabilityError } from "./capability.ts";
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
import {
  makeRefPromoter,
  resolveAreaUuid,
  resolveHeadingUuid,
  resolveProjectUuid,
  resolveTaskUuidPrefix,
} from "./read/queries.ts";
import type { RefPromoter } from "./read/shape.ts";
import { areaView, type AreaView } from "./read/area-view.ts";
import { isLooseRef, looseShadowNotice, shadowingLooseArea } from "./read/pseudo-area.ts";
import { logState, type LogState } from "./read/log-boundary.ts";
import { projectView, type ProjectView } from "./read/project-view.ts";
import { snapshotView, type Snapshot } from "./read/snapshot.ts";
import { classifyShowTarget, type ShowTarget } from "./read/show-target.ts";
import { areasView, tagsView } from "./read/tags.ts";
import {
  anytimeView,
  areaLoggedCount,
  changesView,
  deadlinesView,
  inboxView,
  liteTitleSearch,
  logbookView,
  projectsView,
  repeatersView,
  searchView,
  somedayView,
  todayView,
  trashView,
  upcomingView,
  type ChangedItem,
  type DeadlinesFilter,
  type InboxFilter,
  type LiteSearchResult,
  type ListItem,
  type LogbookFilter,
  type RepeatersFilter,
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
  upcomingBlockTotals,
  type TodayBucketTotals,
  type AreaBucketTotals,
  type SectionTotals,
  type UpcomingBlockTotals,
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
  CloneParams,
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
  TodoAddRepeatingParams,
  TagUpdateParams,
  HeadingArchiveParams,
  HeadingUnarchiveParams,
  HeadingPlacement,
  TodoAddParams,
  TodoMoveParams,
  TodoUpdateParams,
} from "./write/operations.ts";
import {
  readAuthToken,
  replayResultFromRecord,
  runMutation,
  type MutationResult,
  type WriteDeps,
  type WriteOptions,
} from "./write/pipeline.ts";
import { findAppliedOpId } from "./write/opid.ts";
import {
  runBatch,
  type BatchItemResult,
  type BatchOp,
  type BatchOptions,
  type BatchResult,
} from "./write/batch.ts";
import { planTagCreation } from "./write/tag-refs.ts";
import { createEnvironmentTracker, type EnvironmentTracker } from "./write/environment.ts";
import {
  runAddHeading,
  runHeadingArchive,
  runHeadingUnarchive,
  type HeadingArchiveResult,
  type HeadingUnarchiveResult,
} from "./write/heading.ts";
import { runClearReminder } from "./write/clear-reminder.ts";
import { runEditChecklist } from "./write/edit-checklist.ts";
import {
  runAddRepeatingProject,
  runAddRepeatingTodo,
  runMakeRepeatingProject,
  runMakeRepeatingTodo,
} from "./write/promote-clone.ts";
import { runCloneProject, runCloneTodo } from "./write/clone.ts";
import {
  runCancelWithDate,
  runCompleteWithDate,
  runUpdateDates,
} from "./write/resolution-timestamps.ts";
import { runTemplateExceptionWrite } from "./write/template-mutation.ts";
import type { ChecklistEdit } from "./write/checklist.ts";
import { runReorder, type ReorderResult } from "./write/reorder.ts";
import {
  runInPlaceReorder,
  runProjectMove,
  runTodoMove,
  runUniversalReorder,
  type MoveResult,
  type ProjectMoveRequest,
  type ReorderRequest,
  type TodoMoveRequest,
} from "./write/move.ts";
import { readAuditRecords, runUndo, type UndoItemResult, type UndoOptions } from "./write/undo.ts";
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
 * A bounded Logbook list: the shown logged rows plus the view-level log-move
 * cadence fact ({@link LogState}) — surfaced as `meta.logging`, rendered as the
 * card header on a TTY. A sibling of `filter`, never part of the JSON `data`.
 */
export interface BoundedLogbook extends BoundedList<ListItem> {
  logging: LogState;
}

/**
 * A bounded global `upcoming` list: the flat {@link truncateList} slice (rendered
 * as-is, grouped by day in the renderer) plus `upcomingTotals` — the PRE-cap
 * per-day-block sizes keyed by `when`, from which each `data.sections` day block's
 * inline `total` derives (present iff the flat row cap straddled that day, R1).
 */
export interface BoundedUpcomingList extends BoundedList<ListItem> {
  /** Pre-cap day-block sizes for the wire's inline `total` (see {@link UpcomingBlockTotals}). */
  upcomingTotals: UpcomingBlockTotals;
}

/**
 * A bounded Today view: `view` is the shown split (capped in render order —
 * Today, then This Evening), `truncation` the exact global counts, and `totals`
 * the PRE-cap Today/This-Evening bucket sizes — the renderer keeps This Evening
 * honest under the single global cap, and each `children` bucket's inline `total`
 * (present iff capped, read-shape v2 R1) derives from them.
 */
export interface BoundedTodayView {
  view: TodayView;
  truncation: Truncation;
  /** Pre-cap Today / This-Evening bucket sizes (see {@link TodayBucketTotals}). */
  totals: TodayBucketTotals;
  /** The active `area` scope, when one was applied (surfaced as `meta.filter`). */
  filter?: ViewFilterMeta;
}

/**
 * A bounded sidebar catalogue (anytime/someday): `view` is the
 * per-block-capped sections and `truncation` the WHOLE-VIEW completeness rollup
 * (`{shown,total,limit,truncated}`). Per-section completeness rides its inline
 * `total` on the wire (stamped from `sectionTotals`, R1); `blocks` carries the
 * identity-bearing per-block counts (project blocks nested under their area/loose
 * block) as INTERNAL render plumbing only — the grouped renderers' "… N more"
 * drill-downs — never on the wire (doctrine v2 PR 5: the sidecar retired).
 */
export interface BoundedSectionsView {
  view: SidebarSection[];
  truncation: Truncation;
  /** Per-block render detail (TTY drill-downs); never serialized. */
  blocks: GroupBlock[];
  /**
   * Pre-cap per-section sizes keyed by area uuid (`null` = loose) — the inline
   * `total` a consumer stamps on each capped section ({@link withSectionTotals},
   * R1), so completeness is answerable locally with no `blocks[]` sidecar.
   */
  sectionTotals: SectionTotals;
  /** The active `area` scope, when one was applied (surfaced as `meta.filter`). */
  filter?: ViewFilterMeta;
}

/** A bounded composite area card: the per-section-capped view and the whole-view rollup. */
export interface BoundedAreaView {
  view: AreaView;
  truncation: Truncation;
  /** Per-block render detail (the `area show` "… N more" footers); never serialized. */
  blocks: GroupBlock[];
  /**
   * Pre-cap scope sizes (read-shape v2 R1, PR 3) — the direct-to-dos and
   * project-rows counts a consumer stamps as each capped scope's inline `total`
   * ({@link withAreaBucketTotals}), so completeness is answerable locally with no
   * `meta.truncation.blocks[]` sidecar.
   */
  totals: AreaBucketTotals;
  /**
   * A resolution disclosure — present ONLY on the `loose` pseudo-area read when
   * a real area shadows the reserved word (names it, by uuid, for targeting).
   * Surfaced by the consumers as a `meta.warnings` advisory.
   */
  notice?: string;
  /**
   * The live count of the area's logged rows (subtree-inclusive, past the
   * log-move boundary — the population `things logbook --area <ref>` returns).
   * Present for a real area, absent for the `loose` pseudo-area. A DISPLAY
   * sibling of `view`: it feeds the TTY card's logbook footer and never enters
   * the JSON area-view `data`.
   */
  loggedCount?: number;
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

/**
 * Resolution-timestamp flags (plan §2): an ISO date (`2025-01-15`) or datetime
 * (`2025-01-15T09:30`). `completedAt` sets the completion timestamp (also the
 * "Completed on" stamp for canceled items); `createdAt` backdates creation. A
 * date-only value normalizes to noon in the effective zone (§5).
 */
export interface ResolutionDates {
  createdAt?: string;
  completedAt?: string;
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
  /**
   * Reference resolvers the consumer surfaces (CLI/MCP) call to turn a project
   * ref + heading selector into uuids before invoking a heading verb. Both
   * throw {@link ReferenceResolutionError} (uuid candidates on ambiguity),
   * scope-aware when a container scope is active. `heading` shares the one
   * heading-selector core (title | uuid | empty-string literal; no ordinal).
   */
  resolve: {
    project(ref: string): { uuid: string; title: string };
    heading(projectUuid: string, sel: string): { uuid: string; title: string };
  };
  /**
   * A fresh {@link RefPromoter} (fresh memo) the consumer surfaces hand to
   * {@link shapeReadPayload} so the flat `area`/`project`/`heading` refs promote
   * a `*Uuid` sibling exactly when their bare title would not resolve back — the
   * JSON round-trip law. Build one per response emission (the memo is scoped to
   * that one shaping pass).
   */
  refPromoter(): RefPromoter;
  read: {
    /**
     * The Today list (Today + This Evening split) plus the whole-view `counts`
     * aggregate (the app's sidebar count), bounded to `limit` rows (default 50)
     * counted in render order — Today first, then This Evening. `all`/`limit:
     * null` returns every row; `totals` carries the pre-cap Today/This-Evening
     * bucket sizes (the two `children` bucket records project from the split).
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
    /** Future-scheduled items in date order, bounded (default 50); day-block totals for R1. */
    upcoming(
      options?: UpcomingFilter & ListBound & ClockScopedRead & AreaScopedRead,
    ): BoundedUpcomingList;
    /**
     * Someday catalogue: `areaLimit` (default 30) caps each group; with
     * `activeProjectItems`, `projectLimit` (default: every item) caps each
     * active project's trailing child list. `all` lifts both. `area` restricts
     * the catalogue to one area.
     */
    someday(
      options?: SomedayFilter & GroupedBound & ClockScopedRead & AreaScopedRead,
    ): BoundedSectionsView;
    /**
     * Logbook entries (most recent first), bounded (default 50), plus the
     * view-level log-move cadence fact ({@link LogState}) surfaced as
     * `meta.logging` — the "Move completed items to Logbook" setting in CC's own
     * words, and the last-logged instant under Manually.
     */
    logbook(options?: Omit<LogbookFilter, "limit"> & ListBound & ClockScopedRead): BoundedLogbook;
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
    /**
     * The deadline-horizon view: every live to-do AND project carrying a
     * deadline, ordered deadline ASC (most-overdue first), then todayIndex, then
     * uuid; deadline-bearing repeating templates project at their next
     * occurrence's deadline. Bounded (default 50). `todayOnly` restricts to
     * current Today members (evening-inclusive); `overdue` keeps only open,
     * past-deadline rows (and excludes projections); `project`/`area` scope to a
     * container; the tag filters compose.
     */
    deadlines(options?: DeadlinesFilter & ListBound & ClockScopedRead): BoundedList<ListItem>;
    /**
     * The repeating-template catalogue: every live repeating template in the
     * library — to-do and project — each carrying its DECODED rule, ordered by
     * next occurrence (the ones that project nowhere last). Paused and ended
     * series are included and say so. Bounded (default 50). Templates appear in
     * no other list view, and a series' rule is otherwise reachable only through
     * a detail read of a uuid this view is the way to learn.
     */
    repeaters(options?: RepeatersFilter & ListBound & ClockScopedRead): BoundedList<ListItem>;
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
      patch: Omit<TodoUpdateParams, "uuid"> & ResolutionDates,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    /**
     * Change ONLY the next occurrence of a repeating to-do, leaving the series
     * itself alone — the app's "make a one-time exception". The occurrence is
     * created if the series has not spawned it yet, then the patch is applied to
     * it. Refuses when the requested day is one the series already lands on (the
     * app would leave two copies there), when the series repeats a fixed time
     * after each completion (it has no upcoming occurrence until the current one
     * is done), and for repeating projects. Undo restores the occurrence's own
     * change but cannot remove the occurrence or rewind the series.
     */
    updateTodoOccurrence(
      uuid: string,
      patch: Omit<TodoUpdateParams, "uuid">,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    /**
     * Complete a to-do. With `resolution.completedAt` (ISO date or datetime) the
     * to-do lands completed and BACKDATED — resolving it first if needed, then
     * an AppleScript completion-date write; a date-only value normalizes to noon
     * in the effective zone (§5). Multi-leg, disclosed in the result / dry-run.
     */
    completeTodo(
      uuid: string,
      resolution?: ResolutionDates,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    /**
     * Cancel a to-do. With `resolution.completedAt` it lands canceled and
     * BACKDATED via the certified flip-dance (→completed · AS backdate · →canceled)
     * — the only headless path that keeps a canceled item canceled.
     */
    cancelTodo(
      uuid: string,
      resolution?: ResolutionDates,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    reopenTodo(uuid: string, options?: WriteOptions): Promise<MutationResult>;
    moveTodo(
      uuid: string,
      dest: Omit<TodoMoveParams, "uuid">,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    /**
     * Move one or more to-dos as an ordered block (spec §4). Give a destination
     * (--to-project / --to-heading / --to-area / --no-heading / --loose) and an
     * optional position (first/last/before/after), or a position alone to
     * reposition items already sharing a container. Membership always succeeds;
     * placement is guaranteed top-of-bucket only where a reorder protocol exists
     * (the result states the placement class). Compiles onto the todo.move +
     * reorder wire primitives — no new op kind.
     */
    moveTodos(request: TodoMoveRequest, options?: WriteOptions): Promise<MoveResult>;
    /**
     * Reorder to-dos IN PLACE within their shared container+bucket (spec §4).
     * Bare (no position) assembles the movees as a contiguous block at the
     * earliest movee's current slot, in argument order. Cross-container operands
     * fail closed.
     */
    reorderTodos(request: ReorderRequest, options?: WriteOptions): Promise<MoveResult>;
    /**
     * The ONE reorder verb (`things reorder`). Rearranges a single-KIND set IN
     * PLACE — to-dos, projects, headings, OR sidebar areas — dispatching the
     * protocol by kind: the index/day/view engine for to-dos and projects (a
     * to-do+project set intermixes only on the shared Today/Evening/day axes), the
     * certified heading-block wire for a project's headings (archived headings
     * reorderable, reopens disclosed — #V11), and the sidebar-drag driver for
     * areas. A mixed-kind set, a cross-container set, and a non-member anchor each
     * get one precise refusal. Bare (no position) assembles the block at the
     * earliest movee's slot; --start/--end/--before/--after position it.
     */
    reorderAny(request: ReorderRequest, options?: WriteOptions): Promise<MoveResult>;
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
    /**
     * Clone a to-do — a faithful content copy through official write surfaces
     * (title, notes, tags, when stage, reminder, deadline, checklist items incl.
     * checked state, container, and completed/canceled terminal state with the
     * exact stopDate). A NEW capture: new uuid, born now (pass
     * `preserveCreated` to copy the source's creation date at minute resolution),
     * landing at its container's native position. Refuses a trashed source and a
     * repeating template. The clone's uuid is on the result; undo trashes it.
     */
    cloneTodo(
      uuid: string,
      clone?: Omit<CloneParams, "uuid">,
      options?: WriteOptions,
    ): Promise<MutationResult>;
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
     * Create a heading inside an EXISTING project; the new heading's uuid is
     * on the result. Delivered through the Things proxy shortcuts (run
     * `things setup` once first). A `placement` positions the new
     * heading among the project's headings via a native `move-heading` leg
     * (requires allow-experimental); omitted, it appends. Anchor uuids in the
     * placement are resolved by the caller.
     */
    addHeading(
      project: ContainerRef,
      title: string,
      placement?: HeadingPlacement,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    /** Rename a heading in place (works on archived headings too). */
    renameHeading(uuid: string, title: string, options?: WriteOptions): Promise<MutationResult>;
    /**
     * Reposition one or more of a project's headings as an ordered block
     * (selection order = resulting order; children follow). `headings` and the
     * placement anchors are resolved heading uuids. Native reorder wire
     * (requires allow-experimental).
     */
    moveHeading(
      project: ContainerRef,
      headings: string[],
      placement: HeadingPlacement,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    /**
     * Relocate ONE heading (with its children) to a DIFFERENT project — the
     * cross-project move the within-project `moveHeading` reorder cannot express
     * (HEADXPROJ). GUI-only: drives the heading row's `…` ellipsis → Move… →
     * keyboard-driven project picker, so it needs `ui.enabled` + the
     * `dangerouslyDriveGui` acknowledgement. `heading` is an exact title or uuid
     * within `project`; both same-titled source headings AND a same-titled
     * destination project fail closed (the drive addresses by title). No wired
     * undo — it is app-reversible by moving it back.
     */
    moveHeadingToProject(
      project: ContainerRef,
      heading: string,
      toProject: ContainerRef,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    /**
     * Dissolve a heading: remove it while its to-dos SURVIVE as direct children
     * of the project (heading→NULL, keeping their order) — NOT trashed (DISS1).
     * This is the OPPOSITE of a delete cascade (contrast the Shortcuts heading
     * delete, P12, which trashes the children). GUI-only (heading row's `…`
     * ellipsis → Delete), so it needs `ui.enabled` + `dangerouslyDriveGui`. Fails
     * closed on a title shared by another heading in the project. No wired undo —
     * the children are kept, so re-create the heading and move them back to
     * reverse. `uuid` is the heading.
     */
    dissolveHeading(uuid: string, options?: WriteOptions): Promise<MutationResult>;
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
      patch: Omit<ProjectUpdateParams, "uuid"> & ResolutionDates,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    /** Complete a project; `resolution.completedAt` backdates it (see completeTodo). */
    completeProject(
      uuid: string,
      policy: Pick<ProjectCompleteParams, "children"> & ResolutionDates,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    /** Move a project to another area. */
    moveProject(uuid: string, area: ContainerRef, options?: WriteOptions): Promise<MutationResult>;
    /** Detach a project from its current area. */
    detachProject(uuid: string, options?: WriteOptions): Promise<MutationResult>;
    /**
     * Move one or more projects as an ordered block (spec §4/§5): --to-area, or
     * --no-area to leave the area, plus an optional position — or a position
     * alone to reorder them among their siblings.
     */
    moveProjects(request: ProjectMoveRequest, options?: WriteOptions): Promise<MoveResult>;
    /** Reorder projects IN PLACE among their siblings (spec §4). */
    reorderProjects(request: ReorderRequest, options?: WriteOptions): Promise<MoveResult>;
    /** Cancel a project — open children are canceled with it, so the children policy is mandatory. `resolution.completedAt` backdates it (flip-dance). */
    cancelProject(
      uuid: string,
      policy: Pick<ProjectCancelParams, "children"> & ResolutionDates,
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
    /**
     * Clone a project — a faithful content copy through official write surfaces:
     * area membership, headings, headed + root children (one `things:///json`
     * import), notes/deadline, plus logged/canceled children and the project's own
     * terminal state reproduced with exact stopDates. A NEW capture (new uuid,
     * born now; `preserveCreated` copies the creation date at minute resolution).
     * Refuses a trashed source, a repeating template, and a subtree holding a live
     * nested repeating template (named in the refusal). Undo trashes the clone
     * and every child it minted.
     */
    cloneProject(
      uuid: string,
      clone?: Omit<CloneParams, "uuid">,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    deleteProject(uuid: string, options?: WriteOptions): Promise<MutationResult>;
    /**
     * Turn an existing project into a repeating series (promote-via-clone). A
     * disposable copy is made, the copy is promoted (driving the local Things app
     * through the Accessibility API — two-key gated: `ui.enabled` config +
     * `dangerouslyDriveGui`), and the ORIGINAL is moved to the Trash. The result
     * carries the minted template uuid plus the trashed original's uuid; unlike
     * before, `things undo` reverses it — it removes the new series (trash-both)
     * and restores the original. Refuses a project holding a nested repeating
     * template (H-CLONE-SOURCE, no --flatten).
     */
    makeRepeatingProject(
      uuid: string,
      rule: Omit<RepeatRuleParams, "uuid">,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    /**
     * Create a project and, in the same call, turn it into a repeating series.
     * TWO legs: the project is created with the FULL project add vocabulary (notes,
     * area, deadline, `when`, structured `items`) — and persists even if the
     * promote refuses — then it is promoted (driving the GUI — two-key gated, same
     * as makeRepeatingProject). Give an `area` to place it, or omit it to create in
     * Someday. The new template's uuid is on the result; `things undo` removes the
     * created series (trash-both).
     */
    addRepeatingProject(
      params: ProjectAddRepeatingParams,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    /**
     * Turn an existing to-do into a repeating series (promote-via-clone). A
     * disposable copy is made, the copy is promoted (driving the local Things app —
     * two-key gated), and the ORIGINAL is moved to the Trash. The result carries
     * the minted template uuid plus the trashed original's uuid; `things undo`
     * reverses it (removes the new series and restores the original).
     */
    makeRepeatingTodo(
      uuid: string,
      rule: Omit<RepeatRuleParams, "uuid">,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    /**
     * Create a to-do and, in the same call, turn it into a repeating series. TWO
     * legs: the to-do is created with the full to-do add vocabulary (notes, tags,
     * when, deadline, reminder, checklist, `--created-at`, container) — and persists
     * even if the promote refuses — then it is promoted (driving the GUI — two-key
     * gated). The new template's uuid is on the result; `things undo` removes the
     * created series (trash-both).
     */
    addRepeatingTodo(
      params: TodoAddRepeatingParams,
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
     * Move completed items into the Logbook now (`log completed now`). The result
     * discloses how many items were logged (`observed.logged`); when nothing is
     * pending it is a clean no-op (`logged: 0`, not an error). IRREVERSIBLE — the
     * log-move boundary cannot be rewound by any official surface, so no undo token
     * is emitted.
     */
    logNow(options?: WriteOptions): Promise<MutationResult>;
    /**
     * Reorder within Today / This Evening / a project / an area. Partial
     * uuid lists are placed on top; the rest keep their current order.
     */
    reorder(params: ReorderParams, options?: WriteOptions): Promise<ReorderResult>;
    /**
     * Run N ops sequentially and independently — no transactions, a failure
     * does not roll back earlier ops. Per-op results stream through `onResult`;
     * the resolved {@link BatchResult} adds the temp-id → uuid mapping and the
     * batch-level undo token (undo the whole submission as one unit). An op may
     * carry a `tempId` (a handle bound to its created uuid, referenceable as
     * `"$name"` by a later op) and/or an `opId` (idempotency id — a resubmitted
     * op with a matching applied id is skipped, not re-created).
     */
    batch(
      ops: BatchOp[],
      options?: BatchOptions,
      onResult?: (result: BatchItemResult) => void,
    ): Promise<BatchResult>;
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
  const env = options.env ?? process.env;
  // THE READ GATE (docs/design/permissions-doctrine.md, Articles I–III). Asked
  // BEFORE anything touches the group container — even the discovery glob is a
  // container access, and under direct mode the first access is what raises the
  // app-data consent. The verdict is ground truth for this invocation: one
  // open(2) in the common case, no stored "onboarded" flag anywhere.
  //
  // An explicit dbPath/THINGS_DB short-circuits the whole doctrine (Article VI)
  // and gets plain file semantics: ordinary ENOENT/EPERM, no consent vocabulary.
  const readGate = readCapability(options.dbPath !== undefined ? { dbPath: options.dbPath } : {}, {
    env,
  });
  if (!readAllowed(readGate)) throw new ReadCapabilityError(readGate);
  // Deputy routing (docs/design/agent-daemon.md §β1): when the broker is
  // active and the caller wants the default container database, reads flow
  // through the deputy's read-only connection so the TCC grant is the
  // deputy's, not this process's. An explicit dbPath/THINGS_DB always opens
  // locally — the deputy only ever brokers the real container db.
  const routedDbPath = deputyRoutesDb(
    options.dbPath !== undefined ? { dbPath: options.dbPath } : undefined,
    env,
  )
    ? deputyDbPath(env)
    : null;
  const located =
    routedDbPath !== null
      ? { path: routedDbPath, source: "deputy" as const, otherCandidates: [] }
      : locateThingsDb(options.dbPath ? { dbPath: options.dbPath } : undefined);
  const conn: ThingsConnection =
    routedDbPath !== null
      ? { db: createDeputyDbFacade(env), path: routedDbPath, close() {} }
      : openConnection(located.path);
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
    // The resolved DB path — backs the default launch's WAL-advance readiness
    // signal (#486) as well as vector construction.
    dbPath: located.path,
    vectors:
      options.vectors ??
      defaultVectors(
        config,
        createUiDriveAux(conn.db),
        located.path,
        options.dbPath !== undefined || (env["THINGS_DB"] ?? "") !== "",
      ),
    config,
    audit,
    fingerprint,
    lockPath: mutationLockPath(env),
    // Read by runBatch for the opId idempotency lookback (same trail undo reads).
    auditDirPath: auditDir(env),
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
    // Single-op idempotency (--op-id): before doing anything, check whether a
    // prior submission carrying this opId already applied. On a match, SKIP
    // execution entirely and replay the ORIGINAL result's identity with
    // `alreadyApplied: true` (never re-running the create/tag-prep). Scoped to
    // real runs — a dry-run mints/records nothing, so it never dedups. Matching
    // is against VERIFIED-OK records only (phase 1). Bypassed by the batch and
    // the compound move/reorder orchestrators, which own their own dispatch.
    if (
      writeOptions?.opId !== undefined &&
      writeOptions.dryRun !== true &&
      writeDeps.auditDirPath !== undefined
    ) {
      const applied = findAppliedOpId(
        readAuditRecords(writeDeps.auditDirPath),
        writeOptions.opId,
        now(),
      );
      if (applied !== undefined) return replayResultFromRecord(applied);
    }
    // --create-tags: create any missing tag named in this op's tags (clean
    // `make new tag` path, mkdir-p for parent/child) before applying. Skipped
    // on a dry run (no side effects). A failed creation leg short-circuits and
    // is returned as this op's result. The opId is NOT carried onto the
    // tag-prep legs — it identifies the MAIN mutation (recorded on its record).
    const tags = (params as { tags?: unknown }).tags;
    if (writeOptions?.createTags === true && writeOptions.dryRun !== true && Array.isArray(tags)) {
      const { opId: _opId, ...rest } = writeOptions;
      const legOptions: WriteOptions = { ...rest, createTags: false };
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

  // update dispatcher: the resolution-timestamp flags route through the
  // multi-leg orchestrator; plain attribute edits stay on `todo/project.update`.
  // When BOTH are present the attribute edit lands first (its own undo), then
  // the timestamp legs — two independently-undoable changes.
  const runUpdate = async (
    kind: "todo" | "project",
    uuid: string,
    patch: Record<string, unknown> & ResolutionDates,
    o?: WriteOptions,
  ): Promise<MutationResult> => {
    const { createdAt, completedAt, ...attrs } = patch;
    const op = kind === "project" ? "project.update" : "todo.update";
    if (createdAt === undefined && completedAt === undefined) {
      return run(op, { uuid, ...attrs } as never, o);
    }
    if (Object.keys(attrs).length > 0) {
      const attrResult = await run(op, { uuid, ...attrs } as never, o);
      if (attrResult.kind !== "ok" && attrResult.kind !== "dry-run") return attrResult;
    }
    return runUpdateDates(
      writeDeps,
      kind,
      uuid,
      {
        ...(createdAt !== undefined && { createdAt }),
        ...(completedAt !== undefined && { completedAt }),
      },
      o ?? {},
    );
  };

  return {
    dbPath: located.path,
    config,
    ...(scope !== undefined && { scope: scopeMeta(scope) }),
    fingerprint,
    schemaStatus: () => toSchemaStatus(fingerprint()),
    clockMeta: (zoneOverride) => buildClockMeta(clock, zoneOverride),
    resolve: {
      project: (ref) => {
        const uuid = resolveProjectUuid(conn.db, ref, {
          ...(scopeClauses !== undefined && {
            scopeWhere: scopeClauses.namedProject.where,
            scopeBinds: scopeClauses.namedProject.binds,
          }),
        });
        const row = conn.db.prepare("SELECT title FROM TMTask WHERE uuid = ?").get(uuid) as
          | { title: string | null }
          | undefined;
        return { uuid, title: row?.title ?? "" };
      },
      // Headings inside a scoped project are in-scope by construction (the
      // project ref was scope-checked), so no extra clause is threaded here.
      heading: (projectUuid, sel) => resolveHeadingUuid(conn.db, projectUuid, sel),
    },
    refPromoter: () => makeRefPromoter(conn.db),
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
        const { data, truncation, totals } = truncateToday(view, listCap(o));
        return { view: data, truncation, totals, ...(filter !== undefined && { filter }) };
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
        const { data, truncation, blocks, totals } = previewSections(
          sections,
          groupedCaps(o, AREA_PREVIEW_LIMIT, PROJECT_PREVIEW_LIMIT),
        );
        return {
          view: data,
          truncation,
          blocks,
          sectionTotals: totals,
          ...(filter !== undefined && { filter }),
        };
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
        // Pre-cap per-day-block sizes for the wire's inline `total` (R1): counted
        // over the in-scope, area-filtered stream BEFORE the flat row cap slices it.
        const upcomingTotals = upcomingBlockTotals(items);
        const { data, truncation } = truncateList(items, listCap(o));
        return { items: data, truncation, upcomingTotals, ...(filter !== undefined && { filter }) };
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
        const { data, truncation, blocks, totals } = previewSomedaySections(
          sections,
          groupedCaps(o, AREA_PREVIEW_LIMIT, null),
        );
        return {
          view: data,
          truncation,
          blocks,
          sectionTotals: totals,
          ...(filter !== undefined && { filter }),
        };
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
        return {
          items: data,
          truncation,
          logging: logState(conn.db),
          ...(areaFilter !== undefined && { filter: areaFilter }),
        };
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
        // nonexistent one does. The `loose` pseudo-area is the NULL area — it
        // lies outside every container jail, so a scope resolves it not-found
        // (the reserved word never matches an in-scope area name).
        if (scope !== undefined) {
          const clause =
            scope.kind === "area"
              ? scopeClauses!.namedArea
              : { where: "0", binds: [] as (string | number)[] };
          resolveAreaUuid(conn.db, ref, { scopeWhere: clause.where, scopeBinds: clause.binds });
        }
        const { data, truncation, blocks, totals } = capAreaSections(
          areaView(conn.db, ref, now(), o ?? {}, zoneOf(o)),
          groupedCaps(o, AREA_PREVIEW_LIMIT, AREA_PREVIEW_LIMIT),
          now(),
          zoneOf(o),
        );
        // Reserved-word disclosure: `loose` ALWAYS wins over a real area named
        // "Loose"; when one shadows, name it (by uuid) so it stays targetable.
        const shadow = isLooseRef(ref) ? shadowingLooseArea(conn.db) : undefined;
        // The live logbook-footer count — a real area only (the loose
        // pseudo-area accumulates no `logbook --area` archive). A display
        // sibling of the view; never part of the JSON `data`.
        const loggedCount =
          data.area !== null
            ? areaLoggedCount(conn.db, data.area.uuid, now(), zoneOf(o))
            : undefined;
        return {
          view: data,
          truncation,
          blocks,
          totals,
          ...(shadow !== undefined && { notice: looseShadowNotice(shadow) }),
          ...(loggedCount !== undefined && { loggedCount }),
        };
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
      deadlines: (o) => {
        const { limit: _limit, ...filter } = o ?? {};
        // The view is computed UNBOUNDED (project/area/tag/overdue/today scoping
        // happens inside it); the whole-view truncation is applied here so the
        // total behind the cut is honest.
        let items = deadlinesView(conn.db, now(), filter, zoneOf(o));
        // A container jail is an additive post-filter (parity with search): keep
        // only in-scope rows so an out-of-scope deadline never leaks.
        if (scope !== undefined) items = items.filter((i) => inScopeItem(i, scope));
        const { data, truncation } = truncateList(items, listCap(o));
        return { items: data, truncation };
      },
      repeaters: (o) => {
        const { limit: _limit, ...filter } = o ?? {};
        let items = repeatersView(conn.db, now(), filter, zoneOf(o));
        if (scope !== undefined) items = items.filter((i) => inScopeItem(i, scope));
        const { data, truncation } = truncateList(items, listCap(o));
        return { items: data, truncation };
      },
      showTarget: (ref) => classifyShowTarget(conn.db, ref, scope),
      byUuid: (uuid) => {
        // Prefix-friendly: unknown refs keep the null contract; ambiguity throws.
        // The injected clock gates the today/evening markers (and reminder
        // liveness) under the consumer's own today (a pinned-clock/lab run reads
        // honestly). Under a
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
      updateTodo: (uuid, patch, o) =>
        runUpdate("todo", uuid, patch as ResolutionDates & Record<string, unknown>, o),
      updateTodoOccurrence: (uuid, patch, o) =>
        runTemplateExceptionWrite(
          writeDeps,
          resolveTaskUuidPrefix(conn.db, uuid, "to-do", scopeClauses?.task),
          patch as Record<string, unknown>,
          o ?? {},
        ),
      completeTodo: (uuid, resolution, o) =>
        runCompleteWithDate(writeDeps, "todo", uuid, resolution ?? {}, o ?? {}),
      cancelTodo: (uuid, resolution, o) =>
        runCancelWithDate(writeDeps, "todo", uuid, resolution ?? {}, o ?? {}),
      reopenTodo: (uuid, o) => run("todo.reopen", { uuid }, o),
      moveTodo: (uuid, dest, o) => run("todo.move", { uuid, ...dest }, o),
      moveTodos: (request, o) => runTodoMove(writeDeps, request, o ?? {}),
      reorderTodos: (request, o) => runInPlaceReorder(writeDeps, "todo.move", request, o ?? {}),
      reorderAny: (request, o) => runUniversalReorder(writeDeps, request, o ?? {}),
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
      cloneTodo: (uuid, clone, o) => runCloneTodo(writeDeps, { uuid, ...clone }, o ?? {}),
      restoreTodo: (uuid, o) => run("todo.restore", { uuid }, o),
      addHeading: (project, title, placement, o) =>
        runAddHeading(writeDeps, project, title, placement, o ?? {}),
      renameHeading: (uuid, title, o) => run("project.rename-heading", { uuid, title }, o),
      moveHeading: (project, headings, placement, o) =>
        run("project.move-heading", { project, headings, placement }, o),
      moveHeadingToProject: (project, heading, toProject, o) =>
        run("project.move-heading-to-project", { project, heading, toProject }, o),
      dissolveHeading: (uuid, o) => run("project.dissolve-heading", { uuid }, o),
      clearReminder: (uuid, o) => runClearReminder(writeDeps, { uuid }, o ?? {}),
      archiveHeading: (uuid, policy, o) =>
        runHeadingArchive(writeDeps, { uuid, ...policy }, o ?? {}),
      unarchiveHeading: (uuid, policy, o) =>
        runHeadingUnarchive(writeDeps, { uuid, ...policy }, o ?? {}),
      detachTodo: (uuid, o) => run("todo.move", { uuid, loose: true }, o),
      editChecklist: (uuid, edit, o) => runEditChecklist(writeDeps, uuid, edit, o ?? {}),
      addProject: (params, o) => run("project.add", params, o),
      updateProject: (uuid, patch, o) =>
        runUpdate("project", uuid, patch as ResolutionDates & Record<string, unknown>, o),
      completeProject: (uuid, policy, o) =>
        runCompleteWithDate(
          writeDeps,
          "project",
          uuid,
          {
            children: policy.children,
            ...(policy.completedAt !== undefined && { completedAt: policy.completedAt }),
          },
          o ?? {},
        ),
      moveProject: (uuid, area, o) => run("project.move", { uuid, area }, o),
      detachProject: (uuid, o) => run("project.move", { uuid, noArea: true }, o),
      moveProjects: (request, o) => runProjectMove(writeDeps, request, o ?? {}),
      reorderProjects: (request, o) =>
        runInPlaceReorder(writeDeps, "project.move", request, o ?? {}),
      cancelProject: (uuid, policy, o) =>
        runCancelWithDate(
          writeDeps,
          "project",
          uuid,
          {
            children: policy.children,
            ...(policy.completedAt !== undefined && { completedAt: policy.completedAt }),
          },
          o ?? {},
        ),
      reopenProject: (uuid, o) => runProjectReopen(writeDeps, uuid, o ?? {}),
      restoreProject: (uuid, o) => run("project.restore", { uuid }, o),
      duplicateProject: (uuid, o) => run("project.duplicate", { uuid }, o),
      cloneProject: (uuid, clone, o) => runCloneProject(writeDeps, { uuid, ...clone }, o ?? {}),
      deleteProject: (uuid, o) => run("project.delete", { uuid }, o),
      makeRepeatingProject: (uuid, rule, o) =>
        runMakeRepeatingProject(writeDeps, { uuid, ...rule }, o ?? {}),
      addRepeatingProject: (params, o) => runAddRepeatingProject(writeDeps, params, o ?? {}),
      makeRepeatingTodo: (uuid, rule, o) =>
        runMakeRepeatingTodo(writeDeps, { uuid, ...rule }, o ?? {}),
      addRepeatingTodo: (params, o) => runAddRepeatingTodo(writeDeps, params, o ?? {}),
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
      logNow: (o) => run("log-now", {}, o),
      reorder: (params, o) => runReorder(writeDeps, params, o ?? {}),
      batch: (ops, o, onResult) => runBatch(writeDeps, ops, o ?? {}, onResult),
      undo: (o, onItem) => runUndo(writeDeps, auditDir(env), o ?? {}, onItem),
    },
    close: () => conn.close(),
  };
}
