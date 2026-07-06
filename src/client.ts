/**
 * ThingsClient — the library entry point. Reads via direct SQLite; writes
 * via the verified mutation pipeline (official app surfaces only).
 */
import type { AuditWriter } from "./audit/log.ts";
import { createAuditWriter } from "./audit/log.ts";
import { loadConfig, type ThingsApiConfig } from "./config.ts";
import { BASELINES } from "./db/baselines/index.ts";
import { openConnection, type ThingsConnection } from "./db/connection.ts";
import { compareToBaseline, observeSchema, type FingerprintStatus } from "./db/fingerprint.ts";
import { locateThingsDb } from "./db/locate.ts";
import type { AnyTask, Area, Project, Tag } from "./model/entities.ts";
import { auditDir, mutationLockPath } from "./paths.ts";
import { byUuid } from "./read/detail.ts";
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
  type TodayView,
  type UpcomingFilter,
  type ViewFilter,
} from "./read/views.ts";
import type {
  AreaAddParams,
  AreaUpdateParams,
  OperationKind,
  OperationParamsMap,
  ProjectAddParams,
  ProjectCompleteParams,
  ProjectUpdateParams,
  ReorderParams,
  TagAddParams,
  TagUpdateParams,
  TodoAddParams,
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
import { runReorder, type ReorderResult } from "./write/reorder.ts";
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
  };
}

export interface ThingsClient {
  dbPath: string;
  config: ThingsApiConfig;
  fingerprint(): FingerprintStatus;
  read: {
    today(filter?: ViewFilter): TodayView;
    inbox(filter?: ViewFilter): ListItem[];
    anytime(filter?: ViewFilter): ListItem[];
    upcoming(filter?: UpcomingFilter): ListItem[];
    someday(filter?: ViewFilter): ListItem[];
    logbook(options?: { limit?: number; tag?: string; exactTag?: boolean }): ListItem[];
    trash(options?: { limit?: number }): ListItem[];
    projects(options?: { areaUuid?: string }): Project[];
    projectView(uuid: string): ProjectView;
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
    /** Full tag replacement (validated semantics, U04). */
    setTags(uuid: string, tags: string[], options?: WriteOptions): Promise<MutationResult>;
    /** Merge: current direct tags + new ones, then replace. */
    addTags(uuid: string, tags: string[], options?: WriteOptions): Promise<MutationResult>;
    replaceChecklist(
      uuid: string,
      items: string[],
      options?: WriteOptions,
    ): Promise<MutationResult>;
    deleteTodo(uuid: string, options?: WriteOptions): Promise<MutationResult>;
    /** Duplicate via URL `duplicate=true` (E07) — the copy's uuid is discovered by verification. */
    duplicateTodo(uuid: string, options?: WriteOptions): Promise<MutationResult>;
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
    deleteProject(uuid: string, options?: WriteOptions): Promise<MutationResult>;
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
     * Run N ops sequentially through the full pipeline (each guarded,
     * verified, audited). No transactional semantics — per-op results.
     */
    batch(
      ops: BatchOp[],
      options?: BatchOptions,
      onResult?: (result: BatchItemResult) => void,
    ): Promise<BatchItemResult[]>;
  };
  close(): void;
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
      someday: (f) => somedayView(conn.db, f),
      logbook: (o) => logbookView(conn.db, o),
      trash: (o) => trashView(conn.db, o),
      projects: (o) => projectsView(conn.db, o),
      projectView: (uuid) => projectView(conn.db, uuid, now()),
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
      addProject: (params, o) => run("project.add", params, o),
      updateProject: (uuid, patch, o) => run("project.update", { uuid, ...patch }, o),
      completeProject: (uuid, policy, o) =>
        run("project.complete", { uuid, children: policy.children }, o),
      deleteProject: (uuid, o) => run("project.delete", { uuid }, o),
      addArea: (params, o) => run("area.add", params, o),
      updateArea: (target, patch, o) => run("area.update", { target, ...patch }, o),
      deleteArea: (target, o) => run("area.delete", { target }, o),
      addTag: (params, o) => run("tag.add", params, o),
      updateTag: (target, patch, o) => run("tag.update", { target, ...patch }, o),
      deleteTag: (target, o) => run("tag.delete", { target }, o),
      emptyTrash: (o) => run("trash.empty", {}, o),
      reorder: (params, o) => runReorder(writeDeps, params, o ?? {}),
      batch: (ops, o, onResult) => runBatch(writeDeps, ops, o ?? {}, onResult),
    },
    close: () => conn.close(),
  };
}
