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
import { areaView, type AreaView } from "./read/area-view.ts";
import { projectView, type ProjectView } from "./read/project-view.ts";
import { snapshotView, type Snapshot } from "./read/snapshot.ts";
import { areasView, tagsView } from "./read/tags.ts";
import {
  anytimeView,
  changesView,
  inboxView,
  logbookView,
  projectsView,
  searchView,
  somedayView,
  todayView,
  trashView,
  upcomingView,
  type ChangedItem,
  type ListItem,
  type SearchOptions,
  type SidebarSection,
  type SomedayFilter,
  type TodayView,
  type UpcomingFilter,
  type ViewFilter,
} from "./read/views.ts";
import type {
  AreaAddParams,
  AreaUpdateParams,
  ChecklistItemSpec,
  ContainerRef,
  ProjectCancelParams,
  OperationKind,
  OperationParamsMap,
  ProjectAddParams,
  ProjectCompleteParams,
  ProjectUpdateParams,
  ReorderParams,
  TagAddParams,
  TagUpdateParams,
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
import { createEnvironmentTracker, type EnvironmentTracker } from "./write/environment.ts";
import { runReorder, type ReorderResult } from "./write/reorder.ts";
import { runUndo, type UndoItemResult, type UndoOptions } from "./write/undo.ts";
import {
  runProjectReopen,
  type ProjectReopenOptions,
  type ProjectReopenResult,
} from "./write/reopen.ts";
import { defaultVectors } from "./write/vectors/registry.ts";
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
    today(filter?: ViewFilter): TodayView;
    inbox(filter?: ViewFilter): ListItem[];
    anytime(filter?: ViewFilter): SidebarSection[];
    upcoming(filter?: UpcomingFilter): ListItem[];
    someday(filter?: SomedayFilter): SidebarSection[];
    logbook(options?: { limit?: number; tag?: string; exactTag?: boolean }): ListItem[];
    trash(options?: { limit?: number }): ListItem[];
    projects(options?: { areaUuid?: string }): Project[];
    projectView(uuid: string): ProjectView;
    /** Composite area view: direct to-dos, projects in sidebar order, later, logged. */
    areaView(ref: string): AreaView;
    areas(): Area[];
    tags(): Tag[];
    search(query: string, options?: SearchOptions): ListItem[];
    /** Rows created/modified since a moment — incl. trashed/logged/templates. */
    changes(options: { since: Date; limit?: number }): ChangedItem[];
    byUuid(uuid: string): AnyTask | null;
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
     * Undo the last N changes made through this client, newest first, by
     * applying the inverse change. Irreversible changes are reported as
     * such, never guessed at.
     */
    undo(options?: UndoOptions, onItem?: (item: UndoItemResult) => void): Promise<UndoItemResult[]>;
  };
  close(): void;
}

/** One granular checklist edit; every other item's checked state is preserved. */
export type ChecklistEdit =
  | { action: "add"; title: string; /** 1-based insert position (default: append). */ at?: number }
  | { action: "remove"; item: string }
  | { action: "check"; item: string }
  | { action: "uncheck"; item: string }
  | { action: "rename"; item: string; title: string }
  | { action: "move"; item: string; /** 1-based target position. */ to: number };

/** Resolve an item by exact title — loud on missing/ambiguous (never guess). */
function checklistIndex(items: ChecklistItemSpec[], ref: string): number {
  const matches = items.map((c, i) => ({ c, i })).filter(({ c }) => c.title === ref);
  if (matches.length === 1) return (matches[0] as { i: number }).i;
  throw new RangeError(
    matches.length === 0
      ? `no checklist item titled "${ref}"`
      : `checklist item title "${ref}" is ambiguous (${matches.length} matches) — rename first`,
  );
}

export function applyChecklistEdit(
  items: ChecklistItemSpec[],
  edit: ChecklistEdit,
): ChecklistItemSpec[] {
  const next = items.map((c) => ({ ...c }));
  switch (edit.action) {
    case "add": {
      const at =
        edit.at === undefined ? next.length : Math.max(0, Math.min(next.length, edit.at - 1));
      next.splice(at, 0, { title: edit.title, completed: false });
      return next;
    }
    case "remove":
      next.splice(checklistIndex(next, edit.item), 1);
      return next;
    case "check":
    case "uncheck": {
      const target = next[checklistIndex(next, edit.item)] as ChecklistItemSpec;
      target.completed = edit.action === "check";
      return next;
    }
    case "rename": {
      const target = next[checklistIndex(next, edit.item)] as ChecklistItemSpec;
      target.title = edit.title;
      return next;
    }
    case "move": {
      const from = checklistIndex(next, edit.item);
      const [moved] = next.splice(from, 1);
      next.splice(Math.max(0, Math.min(next.length, edit.to - 1)), 0, moved as ChecklistItemSpec);
      return next;
    }
  }
}

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
    vectors: options.vectors ?? defaultVectors(),
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

  const run = <K extends OperationKind>(
    op: K,
    params: OperationParamsMap[K],
    writeOptions?: WriteOptions,
  ): Promise<MutationResult> => runMutation(writeDeps, op, params, writeOptions ?? {});

  return {
    dbPath: located.path,
    config,
    fingerprint,
    read: {
      today: (f) => todayView(conn.db, now(), f),
      inbox: (f) => inboxView(conn.db, f),
      anytime: (f) => anytimeView(conn.db, now(), f),
      upcoming: (f) => upcomingView(conn.db, now(), f),
      someday: (f) => somedayView(conn.db, now(), f),
      logbook: (o) => logbookView(conn.db, o),
      trash: (o) => trashView(conn.db, o),
      projects: (o) => projectsView(conn.db, o),
      projectView: (uuid) => projectView(conn.db, uuid, now()),
      areaView: (ref) => areaView(conn.db, ref, now()),
      areas: () => areasView(conn.db),
      tags: () => tagsView(conn.db),
      search: (query, o) => searchView(conn.db, query, o),
      changes: (o) => changesView(conn.db, o),
      byUuid: (uuid) => byUuid(conn.db, uuid),
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
      detachTodo: (uuid, o) => run("todo.move", { uuid, detach: true }, o),
      editChecklist(uuid, edit, o) {
        const current = byUuid(conn.db, uuid);
        if (current === null || current.type !== "to-do") {
          throw new RangeError(`no to-do with uuid ${uuid}`);
        }
        const items: ChecklistItemSpec[] = (current.checklist ?? []).map((c) => ({
          title: c.title,
          completed: c.status === "completed",
        }));
        const next = applyChecklistEdit(items, edit);
        return run(
          "todo.replace-checklist",
          { uuid, items: next },
          { ...o, acknowledgeChecklistReset: true },
        );
      },
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
