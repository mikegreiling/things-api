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
    /** Restore a TRASHED to-do (E15): un-trashes into the Inbox, de-scheduled. */
    restoreTodo(uuid: string, options?: WriteOptions): Promise<MutationResult>;
    /** Detach a to-do from its project/area/heading, keeping the schedule (P21/P22). */
    detachTodo(uuid: string, options?: WriteOptions): Promise<MutationResult>;
    /**
     * One granular checklist edit (add/remove/check/uncheck/rename/move) —
     * reads the current items+states, applies the edit, writes the full list
     * back via things:///json with per-item states preserved (P18). Item
     * uuids are NOT stable across the rewrite. The checklist-reset ack is
     * implied: state is preserved by construction.
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
    /** Move a project to another area (E14 AppleScript / P23 URL). */
    moveProject(uuid: string, area: ContainerRef, options?: WriteOptions): Promise<MutationResult>;
    /** Detach a project from its area, one verified write (P24 — URL only). */
    detachProject(uuid: string, options?: WriteOptions): Promise<MutationResult>;
    /** Cancel a project; the URL write auto-cancels open children (P01) — policy mandatory. */
    cancelProject(
      uuid: string,
      policy: Pick<ProjectCancelParams, "children">,
      options?: WriteOptions,
    ): Promise<MutationResult>;
    /**
     * Reopen a completed/canceled project (P02/P05). Children stay resolved
     * unless restoreChildren reopens the cascade-resolved ones (P03 window).
     */
    reopenProject(uuid: string, options?: ProjectReopenOptions): Promise<ProjectReopenResult>;
    /** Restore a TRASHED project IN PLACE (P06) — nothing relocates. */
    restoreProject(uuid: string, options?: WriteOptions): Promise<MutationResult>;
    /** Duplicate a project INCLUDING children (E17) — copy discovered by verification. */
    duplicateProject(uuid: string, options?: WriteOptions): Promise<MutationResult>;
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
    /**
     * Undo the last N successful mutations by replaying inverse ops from the
     * audit trail (each inverse runs the full guarded+verified pipeline).
     * Irreversible ops are reported as such, never guessed at.
     */
    undo(options?: UndoOptions, onItem?: (item: UndoItemResult) => void): Promise<UndoItemResult[]>;
  };
  close(): void;
}

/** One granular checklist edit, applied over a stateful wholesale rewrite (P18). */
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
      restoreTodo: (uuid, o) => run("todo.restore", { uuid }, o),
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
