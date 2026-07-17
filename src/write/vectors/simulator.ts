/**
 * The SIMULATOR write vector (bench harness, Phase 0). It presents to the
 * pipeline exactly like the real `url-scheme` transport but, instead of handing
 * a payload to the OS, applies the mutation with SQL against a SYNTHETIC fixture
 * database — so the whole write pipeline (guards → plan → execute → verified
 * read-after-write → audit) can run end-to-end with no Things app installed.
 *
 * It NEVER parses the compiled payload: every applier reads the STRUCTURED
 * `invocation.op` / `invocation.opParams` the pipeline attaches after compile.
 * Its own read-write `node:sqlite` connection is separate from the pipeline's
 * (which stays read-only); both point at the same WAL file, so the pipeline's
 * verification poller observes each committed applier write.
 *
 * SAFETY — a triple fence (checked at creation AND on first execute) keeps this
 * pointed only at a disposable bench DB, never at a real Things database:
 *   1. env `THINGS_SIM_WRITES=1`,
 *   2. env `THINGS_DB` set and byte-equal to the dbPath in use (never a
 *      container-glob-located production path),
 *   3. the DB's `Meta` table carries `benchFixture` = "1".
 * When any check fails, {@link defaultVectors} omits the simulator and
 * {@link createSimulatorVector} refuses (throws at creation; execute refuses
 * defensively should the environment change underneath a live instance).
 */
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { encodePackedDate, encodeReminderTime, localToday } from "../../model/dates.ts";
import type { ContainerRef, OperationKind, OperationParamsMap, WhenValue } from "../operations.ts";
import { resolveArea, resolveHeading, resolveProject, resolveTag } from "../pre-state.ts";
import { resolveTagRefs } from "../tag-refs.ts";
import type {
  CompiledInvocation,
  ExecuteResult,
  VectorMatrix,
  VectorSupport,
  WriteVector,
} from "./types.ts";

// Enum encodings mirror test/fixtures/seed.ts / docs/atlas/schema-v26.md.
const STATUS = { open: 0, canceled: 2, completed: 3 } as const;
const START = { inbox: 0, active: 1, someday: 2 } as const;

/** Substring signature of the production group container — never a bench path. */
const PROD_CONTAINER = "Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac";

interface ApplyCtx {
  nowEpoch: number;
  todayIso: string;
}

// --------------------------------------------------------------- fence

/**
 * The fence reason, or null when the simulator may run against `dbPath`. Pure
 * with respect to `env`; opens `dbPath` READ-ONLY only to read the marker.
 */
export function simulatorFenceReason(
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env["THINGS_SIM_WRITES"] !== "1") {
    return "THINGS_SIM_WRITES is not set to 1";
  }
  const thingsDb = env["THINGS_DB"];
  if (thingsDb === undefined || thingsDb.trim() === "") {
    return "THINGS_DB is not set";
  }
  if (thingsDb !== dbPath) {
    return `THINGS_DB (${thingsDb}) does not equal the simulator dbPath (${dbPath})`;
  }
  if (dbPath.includes(PROD_CONTAINER)) {
    return "the dbPath points at the production Things group container";
  }
  if (!hasBenchMarker(dbPath)) {
    return `the database at ${dbPath} carries no Meta.benchFixture marker`;
  }
  return null;
}

/** Whether the simulator's triple fence is satisfied for `dbPath`. */
export function simulatorFenceActive(
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return simulatorFenceReason(dbPath, env) === null;
}

/**
 * Whether the simulator fence is active for the ambient environment — the
 * single signal every host-escaping code path (reveal `open`, setup install
 * sheets, the live-app doctor probes, the pipeline's app-launch) consults so a
 * bench run never touches the real Things/Shortcuts app. True only when
 * THINGS_SIM_WRITES=1 AND THINGS_DB names a fenced bench fixture (marker
 * present, not the production container); false — the ordinary path — otherwise.
 */
export function simFenceActive(env: NodeJS.ProcessEnv = process.env): boolean {
  const dbPath = env["THINGS_DB"];
  if (dbPath === undefined || dbPath.trim() === "") return false;
  return simulatorFenceActive(dbPath, env);
}

function hasBenchMarker(dbPath: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
    const row = db.prepare("SELECT value FROM Meta WHERE key = 'benchFixture'").get() as
      | { value: string | null }
      | undefined;
    return row?.value === "1";
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

// ------------------------------------------------------------- uuids

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A fresh 22-char base62 id — the shape of a real Things object uuid. */
function genUuid(): string {
  const bytes = randomBytes(22);
  let out = "";
  for (let i = 0; i < 22; i++) out += BASE62[(bytes[i] ?? 0) % 62];
  return out;
}

// ---------------------------------------------------- shared appliers

/** Full TMTask row insert, mirroring test/fixtures/seed.ts insertTask columns. */
function insertTask(
  sim: DatabaseSync,
  type: 0 | 1 | 2,
  ctx: ApplyCtx,
  opts: {
    uuid: string;
    title: string;
    notes?: string;
    status?: keyof typeof STATUS;
    start?: number;
    startDate?: number | null;
    startBucket?: number;
    reminderTime?: number | null;
    deadline?: number | null;
    area?: string | null;
    project?: string | null;
    heading?: string | null;
    checklistItemsCount?: number;
    openChecklistItemsCount?: number;
  },
): void {
  sim
    .prepare(
      `INSERT INTO TMTask (
         uuid, type, status, stopDate, trashed, title, notes,
         creationDate, userModificationDate,
         start, startDate, startBucket, reminderTime, deadline, deadlineSuppressionDate,
         "index", todayIndex, todayIndexReferenceDate, area, project, heading,
         untrashedLeafActionsCount, openUntrashedLeafActionsCount,
         checklistItemsCount, openChecklistItemsCount,
         rt1_repeatingTemplate, rt1_recurrenceRule,
         rt1_nextInstanceStartDate, rt1_instanceCreationPaused, repeater
       ) VALUES (?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, NULL, ?, ?, ?, 0, 0, ?, ?, NULL, NULL, NULL, 0, NULL)`,
    )
    .run(
      opts.uuid,
      type,
      STATUS[opts.status ?? "open"],
      opts.title,
      opts.notes ?? "",
      ctx.nowEpoch,
      ctx.nowEpoch,
      opts.start ?? START.active,
      opts.startDate ?? null,
      opts.startBucket ?? 0,
      opts.reminderTime ?? null,
      opts.deadline ?? null,
      opts.area ?? null,
      opts.project ?? null,
      opts.heading ?? null,
      opts.checklistItemsCount ?? 0,
      opts.openChecklistItemsCount ?? 0,
    );
}

/** The (start, startDate, startBucket) triple a `when` value materializes. */
function scheduleColumns(
  when: WhenValue | undefined,
  todayIso: string,
  hasContainer: boolean,
): { start: number; startDate: number | null; startBucket: number } {
  const today = encodePackedDate(todayIso);
  switch (when) {
    case undefined:
      // No schedule requested — Inbox for a bare add, the container's Anytime
      // otherwise (only startDate is ever asserted, so this is plausibility).
      return { start: hasContainer ? START.active : START.inbox, startDate: null, startBucket: 0 };
    case "today":
      return { start: START.active, startDate: today, startBucket: 0 };
    case "evening":
      return { start: START.active, startDate: today, startBucket: 1 };
    case "anytime":
      return { start: START.active, startDate: null, startBucket: 0 };
    case "someday":
      return { start: START.someday, startDate: null, startBucket: 0 };
    default:
      // A concrete YYYY-MM-DD: only the date is invariant (start-state semantics
      // differ for past/future dates and are not asserted).
      return { start: START.active, startDate: encodePackedDate(when), startBucket: 0 };
  }
}

function containerUuid(
  sim: DatabaseSync,
  ref: ContainerRef | undefined,
  kind: "project" | "area",
): string | null {
  if (ref === undefined || (ref.uuid === undefined && ref.title === undefined)) return null;
  const res = kind === "project" ? resolveProject(sim, ref) : resolveArea(sim, ref);
  if (res.resolved === null) throw new Error(`simulator: unresolved ${kind} reference`);
  return res.resolved.uuid;
}

/** Resolve each tag ref to a TMTag uuid (leaf title match), skipping unknowns. */
function tagUuids(sim: DatabaseSync, refs: string[]): string[] {
  const { titles } = resolveTagRefs(sim, refs);
  const uuids: string[] = [];
  for (const title of titles) {
    const row = sim
      .prepare("SELECT uuid FROM TMTag WHERE title = ? COLLATE NOCASE LIMIT 1")
      .get(title) as { uuid: string } | undefined;
    if (row !== undefined) uuids.push(row.uuid);
  }
  return uuids;
}

function setTaskTags(sim: DatabaseSync, taskUuid: string, refs: string[]): void {
  sim.prepare("DELETE FROM TMTaskTag WHERE tasks = ?").run(taskUuid);
  for (const tagUuid of tagUuids(sim, refs)) {
    sim.prepare("INSERT INTO TMTaskTag (tasks, tags) VALUES (?, ?)").run(taskUuid, tagUuid);
  }
}

/** Recreate a to-do's checklist wholesale (all items open unless flagged). */
function replaceChecklist(
  sim: DatabaseSync,
  taskUuid: string,
  items: (string | { title: string; completed?: boolean })[],
  ctx: ApplyCtx,
): void {
  sim.prepare("DELETE FROM TMChecklistItem WHERE task = ?").run(taskUuid);
  let open = 0;
  items.forEach((item, i) => {
    const title = typeof item === "string" ? item : item.title;
    const completed = typeof item !== "string" && item.completed === true;
    if (!completed) open++;
    sim
      .prepare(
        `INSERT INTO TMChecklistItem (uuid, userModificationDate, creationDate, title, status, stopDate, "index", task, leavesTombstone)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 0)`,
      )
      .run(
        genUuid(),
        ctx.nowEpoch,
        ctx.nowEpoch,
        title,
        completed ? STATUS.completed : STATUS.open,
        i,
        taskUuid,
      );
  });
  sim
    .prepare(
      "UPDATE TMTask SET checklistItemsCount = ?, openChecklistItemsCount = ?, userModificationDate = ? WHERE uuid = ?",
    )
    .run(items.length, open, ctx.nowEpoch, taskUuid);
}

/** The joined notes an append/prepend update should leave (mirrors expectedNotes). */
function joinedNotes(
  sim: DatabaseSync,
  uuid: string,
  params: { appendNotes?: string; prependNotes?: string },
): string | undefined {
  if (params.appendNotes === undefined && params.prependNotes === undefined) return undefined;
  const row = sim.prepare("SELECT notes FROM TMTask WHERE uuid = ?").get(uuid) as
    | { notes: string | null }
    | undefined;
  const current = row?.notes ?? "";
  if (params.appendNotes !== undefined) {
    return current === "" ? params.appendNotes : `${current}\n${params.appendNotes}`;
  }
  const prepend = params.prependNotes ?? "";
  return current === "" ? prepend : `${prepend}\n${current}`;
}

/** The reminderTime packed value an update leaves (mirrors effectiveReminder). */
function effectiveReminderValue(
  sim: DatabaseSync,
  uuid: string,
  params: { when?: WhenValue; reminder?: string | null },
): number | null {
  if (params.reminder !== undefined) {
    return params.reminder === null ? null : encodeReminderTime(params.reminder);
  }
  const when = params.when;
  const schedulable =
    when === "today" ||
    when === "evening" ||
    (typeof when === "string" && /^\d{4}-\d{2}-\d{2}$/.test(when));
  if (!schedulable) return null;
  // Preserve the existing reminder across a bare re-schedule.
  const row = sim.prepare("SELECT reminderTime FROM TMTask WHERE uuid = ?").get(uuid) as
    | { reminderTime: number | null }
    | undefined;
  return row?.reminderTime ?? null;
}

/** Shared to-do/project field update (title/notes/when+reminder/deadline). */
function applyEntityUpdate(
  sim: DatabaseSync,
  params: {
    uuid: string;
    title?: string;
    notes?: string;
    appendNotes?: string;
    prependNotes?: string;
    when?: WhenValue;
    reminder?: string | null;
    deadline?: string | null;
  },
  ctx: ApplyCtx,
): void {
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (params.title !== undefined) {
    sets.push("title = ?");
    binds.push(params.title);
  }
  if (params.notes !== undefined) {
    sets.push("notes = ?");
    binds.push(params.notes);
  } else {
    const joined = joinedNotes(sim, params.uuid, params);
    if (joined !== undefined) {
      sets.push("notes = ?");
      binds.push(joined);
    }
  }
  if (params.when !== undefined) {
    const s = scheduleColumns(params.when, ctx.todayIso, true);
    sets.push("start = ?", "startDate = ?", "startBucket = ?");
    binds.push(s.start, s.startDate, s.startBucket);
    sets.push("reminderTime = ?");
    binds.push(effectiveReminderValue(sim, params.uuid, params));
  } else if (params.reminder !== undefined) {
    sets.push("reminderTime = ?");
    binds.push(params.reminder === null ? null : encodeReminderTime(params.reminder));
  }
  if (params.deadline !== undefined) {
    sets.push("deadline = ?");
    binds.push(params.deadline === null ? null : encodePackedDate(params.deadline));
  }
  sets.push("userModificationDate = ?");
  binds.push(ctx.nowEpoch);
  sim.prepare(`UPDATE TMTask SET ${sets.join(", ")} WHERE uuid = ?`).run(...binds, params.uuid);
}

function setStatus(
  sim: DatabaseSync,
  uuid: string,
  status: number,
  stopDate: number | null,
  ctx: ApplyCtx,
): void {
  sim
    .prepare("UPDATE TMTask SET status = ?, stopDate = ?, userModificationDate = ? WHERE uuid = ?")
    .run(status, stopDate, ctx.nowEpoch, uuid);
}

// --------------------------------------------------- applier registry

type Applier = (sim: DatabaseSync, params: unknown, ctx: ApplyCtx) => void;

/** Typed applier helper — narrows the params for one operation kind. */
function op<K extends OperationKind>(
  fn: (sim: DatabaseSync, params: OperationParamsMap[K], ctx: ApplyCtx) => void,
): Applier {
  return (sim, params, ctx) => fn(sim, params as OperationParamsMap[K], ctx);
}

const APPLIERS: Partial<Record<OperationKind, Applier>> = {
  "todo.add": op<"todo.add">((sim, params, ctx) => {
    let project: string | null = null;
    let heading: string | null = null;
    let area: string | null = null;
    if (params.heading !== undefined && params.project !== undefined) {
      const projUuid = containerUuid(sim, params.project, "project");
      if (projUuid === null) throw new Error("simulator: to-do heading needs a project");
      const h = resolveHeading(sim, projUuid, params.heading);
      if (h.resolved === null) throw new Error("simulator: unresolved heading");
      heading = h.resolved.uuid; // project reached via the heading (project col NULL)
    } else if (params.project !== undefined) {
      project = containerUuid(sim, params.project, "project");
    } else if (params.area !== undefined) {
      area = containerUuid(sim, params.area, "area");
    }
    const hasContainer = project !== null || heading !== null || area !== null;
    const s = scheduleColumns(params.when, ctx.todayIso, hasContainer);
    const uuid = genUuid();
    insertTask(sim, 0, ctx, {
      uuid,
      title: params.title,
      notes: params.notes ?? "",
      start: s.start,
      startDate: s.startDate,
      startBucket: s.startBucket,
      reminderTime: params.reminder !== undefined ? encodeReminderTime(params.reminder) : null,
      deadline: params.deadline !== undefined ? encodePackedDate(params.deadline) : null,
      area,
      project,
      heading,
    });
    if (params.tags !== undefined) setTaskTags(sim, uuid, params.tags);
    if (params.checklistItems !== undefined)
      replaceChecklist(sim, uuid, params.checklistItems, ctx);
  }),

  "todo.update": op<"todo.update">((sim, params, ctx) => applyEntityUpdate(sim, params, ctx)),

  "todo.complete": op<"todo.complete">((sim, params, ctx) =>
    setStatus(sim, params.uuid, STATUS.completed, ctx.nowEpoch, ctx),
  ),
  "todo.cancel": op<"todo.cancel">((sim, params, ctx) =>
    setStatus(sim, params.uuid, STATUS.canceled, ctx.nowEpoch, ctx),
  ),
  "todo.reopen": op<"todo.reopen">((sim, params, ctx) =>
    setStatus(sim, params.uuid, STATUS.open, null, ctx),
  ),

  "todo.delete": op<"todo.delete">((sim, params, ctx) =>
    sim
      .prepare("UPDATE TMTask SET trashed = 1, userModificationDate = ? WHERE uuid = ?")
      .run(ctx.nowEpoch, params.uuid),
  ),

  "todo.restore": op<"todo.restore">((sim, params, ctx) =>
    // Put Back → un-trash into the Inbox, de-scheduled (E15).
    sim
      .prepare(
        "UPDATE TMTask SET trashed = 0, start = 0, startDate = NULL, startBucket = 0, userModificationDate = ? WHERE uuid = ?",
      )
      .run(ctx.nowEpoch, params.uuid),
  ),

  "todo.move": op<"todo.move">((sim, params, ctx) => {
    if (params.inbox === true) {
      sim
        .prepare(
          "UPDATE TMTask SET start = 0, startDate = NULL, startBucket = 0, project = NULL, area = NULL, heading = NULL, userModificationDate = ? WHERE uuid = ?",
        )
        .run(ctx.nowEpoch, params.uuid);
      return;
    }
    if (params.detach === true) {
      sim
        .prepare(
          "UPDATE TMTask SET project = NULL, area = NULL, heading = NULL, userModificationDate = ? WHERE uuid = ?",
        )
        .run(ctx.nowEpoch, params.uuid);
      return;
    }
    if (params.heading !== undefined && params.project !== undefined) {
      const projUuid = containerUuid(sim, params.project, "project");
      if (projUuid === null) throw new Error("simulator: move heading needs a project");
      const h = resolveHeading(sim, projUuid, params.heading);
      if (h.resolved === null) throw new Error("simulator: unresolved heading");
      sim
        .prepare(
          "UPDATE TMTask SET heading = ?, project = NULL, area = NULL, userModificationDate = ? WHERE uuid = ?",
        )
        .run(h.resolved.uuid, ctx.nowEpoch, params.uuid);
      return;
    }
    if (params.project !== undefined) {
      const projUuid = containerUuid(sim, params.project, "project");
      sim
        .prepare(
          "UPDATE TMTask SET project = ?, heading = NULL, area = NULL, userModificationDate = ? WHERE uuid = ?",
        )
        .run(projUuid, ctx.nowEpoch, params.uuid);
      return;
    }
    if (params.area !== undefined) {
      const areaUuid = containerUuid(sim, params.area, "area");
      sim
        .prepare(
          "UPDATE TMTask SET area = ?, project = NULL, heading = NULL, userModificationDate = ? WHERE uuid = ?",
        )
        .run(areaUuid, ctx.nowEpoch, params.uuid);
    }
  }),

  "todo.set-tags": op<"todo.set-tags">((sim, params, ctx) => {
    setTaskTags(sim, params.uuid, params.tags);
    sim
      .prepare("UPDATE TMTask SET userModificationDate = ? WHERE uuid = ?")
      .run(ctx.nowEpoch, params.uuid);
  }),

  "todo.replace-checklist": op<"todo.replace-checklist">((sim, params, ctx) =>
    replaceChecklist(sim, params.uuid, params.items, ctx),
  ),

  "project.add": op<"project.add">((sim, params, ctx) => {
    const area = containerUuid(sim, params.area, "area");
    const s = scheduleColumns(params.when, ctx.todayIso, area !== null);
    const uuid = genUuid();
    insertTask(sim, 1, ctx, {
      uuid,
      title: params.title,
      notes: params.notes ?? "",
      start: s.start,
      startDate: s.startDate,
      startBucket: s.startBucket,
      deadline: params.deadline !== undefined ? encodePackedDate(params.deadline) : null,
      area,
    });
    // `todos` seed children are not asserted by the delta and are omitted.
  }),

  "project.update": op<"project.update">((sim, params, ctx) => applyEntityUpdate(sim, params, ctx)),

  "project.complete": op<"project.complete">((sim, params, ctx) => {
    // Cascade open children to completed; canceled children are untouched (T08).
    const children = sim
      .prepare(
        `SELECT uuid FROM TMTask WHERE type = 0 AND trashed = 0 AND status = 0
         AND (project = ? OR heading IN (SELECT uuid FROM TMTask WHERE type = 2 AND project = ?))`,
      )
      .all(params.uuid, params.uuid) as { uuid: string }[];
    for (const c of children) setStatus(sim, c.uuid, STATUS.completed, ctx.nowEpoch, ctx);
    setStatus(sim, params.uuid, STATUS.completed, ctx.nowEpoch, ctx);
  }),

  "area.add": op<"area.add">((sim, params) => {
    const uuid = genUuid();
    sim
      .prepare(`INSERT INTO TMArea (uuid, title, visible, "index") VALUES (?, ?, 1, 0)`)
      .run(uuid, params.title);
    if (params.tags !== undefined) {
      for (const tagUuid of tagUuids(sim, params.tags)) {
        sim.prepare("INSERT INTO TMAreaTag (areas, tags) VALUES (?, ?)").run(uuid, tagUuid);
      }
    }
  }),

  "area.update": op<"area.update">((sim, params) => {
    const res = resolveArea(sim, { uuid: params.target, title: params.target });
    if (res.resolved === null) throw new Error("simulator: unresolved area target");
    const uuid = res.resolved.uuid;
    if (params.title !== undefined) {
      sim.prepare("UPDATE TMArea SET title = ? WHERE uuid = ?").run(params.title, uuid);
    }
    if (params.tags !== undefined) {
      sim.prepare("DELETE FROM TMAreaTag WHERE areas = ?").run(uuid);
      for (const tagUuid of tagUuids(sim, params.tags)) {
        sim.prepare("INSERT INTO TMAreaTag (areas, tags) VALUES (?, ?)").run(uuid, tagUuid);
      }
    }
  }),

  "tag.add": op<"tag.add">((sim, params) => {
    let parent: string | null = null;
    if (params.parent !== undefined) {
      const res = resolveTag(sim, params.parent);
      if (res.resolved === null) throw new Error("simulator: unresolved parent tag");
      parent = res.resolved.uuid;
    }
    sim
      .prepare(
        `INSERT INTO TMTag (uuid, title, shortcut, usedDate, parent, "index") VALUES (?, ?, NULL, NULL, ?, 0)`,
      )
      .run(genUuid(), params.title, parent);
  }),

  "heading.create": op<"heading.create">((sim, params, ctx) => {
    const projUuid = containerUuid(sim, params.project, "project");
    if (projUuid === null) throw new Error("simulator: heading.create needs a project");
    insertTask(sim, 2, ctx, { uuid: genUuid(), title: params.title, project: projUuid });
  }),
};

/** The ops this simulator can apply — the ONLY entries in its honest matrix. */
export const SIMULATOR_COVERAGE: OperationKind[] = Object.keys(APPLIERS) as OperationKind[];

function simulatorMatrix(): VectorMatrix {
  const support: VectorSupport = {
    support: "yes",
    disruption: 0,
    validation: "validated",
    notes: "simulated",
  };
  const matrix: VectorMatrix = {};
  for (const kind of SIMULATOR_COVERAGE) matrix[kind] = { ...support };
  return matrix;
}

// ------------------------------------------------------------- vector

/**
 * Build the simulator vector for `dbPath`. Throws at creation if the fence is
 * not satisfied (so a misconfigured harness fails loud, never silently writing
 * to a wrong DB). `now` is injectable for tests; production reads the effective
 * clock from the environment (THINGS_NOW) so applier timestamps align with the
 * pipeline's, which the create-probe verification depends on.
 */
export function createSimulatorVector(
  dbPath: string,
  opts: { now?: () => Date } = {},
): WriteVector {
  const reason = simulatorFenceReason(dbPath);
  if (reason !== null) {
    throw new Error(`simulator write vector refused: ${reason}`);
  }
  const now = opts.now ?? resolveEnvNow();
  let sim: DatabaseSync | undefined;

  return {
    id: "url-scheme",
    matrix: simulatorMatrix(),
    simulates: true,
    async execute(invocation: CompiledInvocation): Promise<ExecuteResult> {
      // Defensive re-check: the environment could have changed underneath a
      // live instance. Refuse rather than write to a now-unfenced DB.
      const liveReason = simulatorFenceReason(dbPath);
      if (liveReason !== null) {
        return { exitCode: 1, stdout: "", stderr: `simulator fence inactive: ${liveReason}` };
      }
      const kind = invocation.op;
      if (kind === undefined) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "simulator: invocation carries no structured op",
        };
      }
      const applier = APPLIERS[kind];
      if (applier === undefined) {
        return { exitCode: 1, stdout: "", stderr: `simulator: no applier for op ${kind}` };
      }
      sim ??= new DatabaseSync(dbPath);
      const when = now();
      const ctx: ApplyCtx = {
        nowEpoch: Math.floor(when.getTime() / 1000),
        todayIso: localToday(when),
      };
      try {
        applier(sim, invocation.opParams, ctx);
      } catch (err) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `simulator applier for ${kind} failed: ${(err as Error).message}`,
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

/** Read the pinned THINGS_NOW instant, if any; else real time per call. */
function resolveEnvNow(): () => Date {
  const raw = process.env["THINGS_NOW"];
  if (raw !== undefined && raw.trim() !== "") {
    const ms = new Date(raw).getTime();
    if (!Number.isNaN(ms)) return () => new Date(ms);
  }
  return () => new Date();
}
