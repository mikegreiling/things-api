/**
 * ThingsClient — the library entry point. Reads via direct SQLite; writes
 * via the verified mutation pipeline (official app surfaces only).
 */
import type { AuditWriter } from "./audit/log.ts";
import { createAuditWriter } from "./audit/log.ts";
import { loadConfig, type ThingsApiConfig } from "./config.ts";
import { PKG_VERSION } from "./contracts.ts";
import { BASELINES } from "./db/baselines/index.ts";
import { openConnection, type ThingsConnection } from "./db/connection.ts";
import { compareToBaseline, observeSchema, type FingerprintStatus } from "./db/fingerprint.ts";
import { locateThingsDb } from "./db/locate.ts";
import type { AnyTask, Area, Project, Tag } from "./model/entities.ts";
import { auditDir, mutationLockPath } from "./paths.ts";
import { byUuid } from "./read/detail.ts";
import { resolveProjectUuid, resolveTaskUuidPrefix } from "./read/queries.ts";
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
import type {
  AreaAddParams,
  AreaUpdateParams,
  ContainerRef,
  ProjectCancelParams,
  OperationKind,
  OperationParamsMap,
  ProjectAddParams,
  ProjectCompleteParams,
  ProjectCreateRepeatingParams,
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
import {
  runCreateRepeatingProject,
  runMakeRepeatingProject,
} from "./write/make-repeating-project.ts";
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
  /** Injectable write vectors (tests: FakeVector; lab: probe vectors). */
  vectors?: WriteVector[];
  /** Env for config/state-dir resolution (tests). */
  env?: NodeJS.ProcessEnv;
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

export interface ThingsClient {
  dbPath: string;
  config: ThingsApiConfig;
  fingerprint(): FingerprintStatus;
  read: {
    today(filter?: TodayFilter): TodayView;
    inbox(filter?: InboxFilter): ListItem[];
    anytime(filter?: ViewFilter): SidebarSection[];
    upcoming(filter?: UpcomingFilter): ListItem[];
    someday(filter?: SomedayFilter): SidebarSection[];
    logbook(options?: LogbookFilter): ListItem[];
    trash(options?: { limit?: number | null }): ListItem[];
    /**
     * Projects in sidebar order. LATER (someday + future-scheduled) projects
     * are excluded by default — `later: true` appends them after the active
     * block of their group (loose block / area), never intermingled.
     */
    projects(
      options?: { areaUuid?: string; later?: boolean; overdue?: boolean } & ViewFilter,
    ): Project[];
    /**
     * Composite project view. Targets by uuid, unique name, or uuid prefix.
     * `overdue: true` keeps only child to-dos whose own deadline is overdue
     * (open, before today); the tag filters (`tags`/`untagged`) keep only the
     * child to-dos carrying the tag DIRECTLY (the container semantics — tags
     * inherited from this project are ignored). Any content scope collapses
     * headings left with no surviving child.
     */
    projectView(ref: string, options?: ViewFilter): ProjectView;
    /**
     * Composite area view: direct to-dos, projects in sidebar order, later,
     * logged. `overdue: true` keeps only the loose to-dos AND child projects
     * whose OWN deadline is overdue; the tag filters keep only the rows
     * matching by their own tags — no descent into project contents.
     */
    areaView(ref: string, options?: ViewFilter): AreaView;
    areas(): Area[];
    tags(): Tag[];
    search(query: string, options?: SearchOptions): SearchResultItem[];
    /**
     * Did-you-mean fallback: case-insensitive title-only substring match over
     * areas/projects/to-dos (open + untrashed), ordered and capped. `type`
     * scopes to one class.
     */
    liteTitleSearch(
      query: string,
      options?: { type?: "to-do" | "project" | "area"; limit?: number },
    ): LiteSearchResult;
    /** Rows created/modified since a moment — incl. trashed/logged/templates. */
    changes(options: { since: Date; limit?: number | null }): ChangedItem[];
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
    createHeading(
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
    createRepeatingProject(
      params: ProjectCreateRepeatingParams,
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
     * such, never guessed at.
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
  const now = options.now ?? (() => new Date());
  const env = options.env ?? process.env;
  const config = loadConfig(env);
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
    vectors: options.vectors ?? defaultVectors(config, createUiDriveAux(conn.db)),
    config,
    audit,
    fingerprint,
    lockPath: mutationLockPath(env),
    now,
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
        // oxlint-disable-next-line no-await-in-loop -- parents must land before children (mkdir-p ordering)
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
    return runMutation(writeDeps, op, params, writeOptions ?? {});
  };

  return {
    dbPath: located.path,
    config,
    fingerprint,
    read: {
      today: (f) => todayView(conn.db, now(), f),
      inbox: (f) => inboxView(conn.db, now(), f),
      anytime: (f) => anytimeView(conn.db, now(), f),
      upcoming: (f) => upcomingView(conn.db, now(), f),
      someday: (f) => somedayView(conn.db, now(), f),
      logbook: (o) => logbookView(conn.db, o),
      trash: (o) => trashView(conn.db, o),
      // Thread the injected clock so `--overdue`'s (and later's) today boundary
      // rides the same clock as every other view — never a hardcoded date.
      projects: (o) => projectsView(conn.db, { ...o, now: now() }),
      projectView: (ref, o) =>
        projectView(conn.db, resolveProjectUuid(conn.db, ref, { trashed: true }), now(), o ?? {}),
      areaView: (ref, o) => areaView(conn.db, ref, now(), o ?? {}),
      areas: () => areasView(conn.db),
      tags: () => tagsView(conn.db),
      search: (query, o) => searchView(conn.db, query, o, now()),
      liteTitleSearch: (query, o) => liteTitleSearch(conn.db, query, o),
      changes: (o) => changesView(conn.db, o),
      showTarget: (ref) => classifyShowTarget(conn.db, ref),
      byUuid: (uuid) => {
        // Prefix-friendly: unknown refs keep the null contract; ambiguity throws.
        try {
          return byUuid(conn.db, resolveTaskUuidPrefix(conn.db, uuid));
        } catch (err) {
          if (err instanceof RangeError && !err.message.includes("ambiguous")) return null;
          throw err;
        }
      },
      snapshot: () => snapshotView(conn.db),
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
      createHeading: (project, title, o) => run("heading.create", { project, title }, o),
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
      createRepeatingProject: (params, o) => runCreateRepeatingProject(writeDeps, params, o ?? {}),
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
