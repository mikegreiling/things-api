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

import { readDatabaseVersion } from "../../db/fingerprint.ts";
import {
  addDaysIso,
  decodePackedDate,
  encodePackedDate,
  encodeReminderTime,
  localToday,
} from "../../model/dates.ts";
import { decodeRecurrenceRule } from "../../model/recurrence.ts";
import type {
  ContainerRef,
  OperationKind,
  OperationParamsMap,
  RepeatFrequency,
  RepeatRuleParams,
  WhenValue,
} from "../operations.ts";
import { resolveArea, resolveHeading, resolveProject, resolveTag } from "../pre-state.ts";
import { composeRepeatRuleSpec, ruleXml } from "../recurrence-rule-blob.ts";
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
  // Scratch state/config dirs are part of the fence (2026-07-17 incident): a
  // simulated run without them appends bench audit records into the operator's
  // real audit trail and reads their real config profile.
  for (const key of ["THINGS_API_STATE_DIR", "THINGS_API_CONFIG_DIR"] as const) {
    const dir = env[key];
    if (dir === undefined || dir.trim() === "") {
      return `${key} is not set — simulated runs must use scratch state/config dirs, never the operator's real ones`;
    }
  }
  const version = fixtureDatabaseVersion(dbPath);
  if (version !== SIMULATED_DATABASE_VERSION) {
    return (
      `the fixture reports databaseVersion ${version ?? "unknown"} but the simulator's ` +
      `appliers model version ${SIMULATED_DATABASE_VERSION} — a Things schema change must be ` +
      `re-modeled in lockstep (atlas → seed builders → simulator appliers → bench world/corpus; ` +
      `see docs/lab/drift-runbook.md) before simulated writes may resume`
    );
  }
  return null;
}

/**
 * The Things schema generation the appliers are written against. When a
 * Things update bumps the real database version, the fence refuses to
 * simulate until the whole modeling chain is consciously re-verified —
 * a schema tripwire, not a compatibility claim.
 */
export const SIMULATED_DATABASE_VERSION = 26;

function fixtureDatabaseVersion(dbPath: string): number | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
    return readDatabaseVersion(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
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

/**
 * Whether the database at `dbPath` carries the bench-fixture marker — i.e. it
 * is a synthetic bench DB by construction. Consulted by defaultVectors as a
 * fail-closed backstop (a marked DB must never be paired with real write
 * transports) and by the reveal gate. False on any read error.
 */
export function dbCarriesBenchMarker(dbPath: string): boolean {
  return hasBenchMarker(dbPath);
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

// ------------------------------------------------- recurrence appliers
//
// The row-level shapes below reproduce the RSIM campaign verdicts
// (docs/lab/rsim-results.md, RSIM1–6): making a to-do/project repeat, the
// fixed-vs-after-completion identity asymmetry, in-place reschedule, and the
// completion-side stamping that schedules the next after-completion occurrence
// without materializing it. Rule blobs come from the SHARED composer
// (recurrence-rule-blob.ts), so every emitted template decodes with the real
// read-path decoder.

/** A deadlined template's own `deadline` column carries this far-future sentinel (§8a). */
const DEADLINE_SENTINEL_ISO = "4001-01-01";

/** Add whole recurrence units to an ISO date (day/week/month/year). */
function addUnitsIso(iso: string, frequency: RepeatFrequency, interval: number): string {
  switch (frequency) {
    case "daily":
      return addDaysIso(iso, interval);
    case "weekly":
      return addDaysIso(iso, 7 * interval);
    case "monthly":
      return addMonthsIso(iso, interval);
    case "yearly":
      return addMonthsIso(iso, 12 * interval);
  }
}

/** Add whole months to an ISO date, clamping the day to the target month's length. */
function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const anchor = new Date(Date.UTC(y, m - 1 + months, 1));
  const year = anchor.getUTCFullYear();
  const month0 = anchor.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return (
    `${String(year).padStart(4, "0")}-` +
    `${String(month0 + 1).padStart(2, "0")}-` +
    `${String(day).padStart(2, "0")}`
  );
}

/** Epoch seconds at UTC-noon of an ISO date — the (decoder-ignored) rule anchor. */
function epochOfIso(iso: string): number {
  return Math.floor(Date.parse(`${iso}T12:00:00Z`) / 1000);
}

interface RecurrenceRowOpts {
  uuid: string;
  type: 0 | 1;
  title: string;
  notes: string;
  area: string | null;
  start: number;
  startDate: number | null;
  deadline: number | null;
  recurrenceRuleXml?: string;
  repeatingTemplate?: string | null;
  instanceCreationCount?: number;
  instanceCreationStartDate?: number | null;
  nextInstanceStartDate?: number | null;
  afterCompletionReferenceDate?: number | null;
}

/** Insert a template or instance row, covering the full rt1_* recurrence column set. */
function insertRecurrenceRow(sim: DatabaseSync, ctx: ApplyCtx, o: RecurrenceRowOpts): void {
  sim
    .prepare(
      `INSERT INTO TMTask (
         uuid, type, status, stopDate, trashed, title, notes,
         creationDate, userModificationDate,
         start, startDate, startBucket, reminderTime, deadline, deadlineSuppressionDate,
         "index", todayIndex, todayIndexReferenceDate, area, project, heading,
         untrashedLeafActionsCount, openUntrashedLeafActionsCount,
         checklistItemsCount, openChecklistItemsCount,
         rt1_repeatingTemplate, rt1_recurrenceRule, rt1_instanceCreationStartDate,
         rt1_instanceCreationPaused, rt1_instanceCreationCount,
         rt1_afterCompletionReferenceDate, rt1_nextInstanceStartDate, repeater
       ) VALUES (?, ?, 0, NULL, 0, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL, 0, 0, NULL, ?, NULL, NULL,
                 0, 0, 0, 0, ?, ?, ?, 0, ?, ?, ?, NULL)`,
    )
    .run(
      o.uuid,
      o.type,
      o.title,
      o.notes,
      ctx.nowEpoch,
      ctx.nowEpoch,
      o.start,
      o.startDate,
      o.deadline,
      o.area,
      o.repeatingTemplate ?? null,
      o.recurrenceRuleXml !== undefined ? new TextEncoder().encode(o.recurrenceRuleXml) : null,
      o.instanceCreationStartDate ?? null,
      o.instanceCreationCount ?? 0,
      o.afterCompletionReferenceDate ?? null,
      o.nextInstanceStartDate ?? null,
    );
}

/** Copy a task's direct tag links onto another task (title/notes/tags/area copy from source). */
function copyTaskTags(sim: DatabaseSync, fromUuid: string, toUuid: string): void {
  const rows = sim.prepare("SELECT tags FROM TMTaskTag WHERE tasks = ?").all(fromUuid) as {
    tags: string;
  }[];
  for (const r of rows) {
    sim.prepare("INSERT INTO TMTaskTag (tasks, tags) VALUES (?, ?)").run(toUuid, r.tags);
  }
}

function loadRepeatSource(
  sim: DatabaseSync,
  uuid: string,
): { title: string; notes: string; area: string | null; startDate: number | null } {
  const src = sim
    .prepare("SELECT title, notes, area, startDate FROM TMTask WHERE uuid = ?")
    .get(uuid) as
    | { title: string | null; notes: string | null; area: string | null; startDate: number | null }
    | undefined;
  if (src === undefined) throw new Error("simulator: make-repeating target not found");
  return {
    title: src.title ?? "",
    notes: src.notes ?? "",
    area: src.area,
    startDate: src.startDate,
  };
}

/**
 * FIXED make-repeating (RSIM1 to-do / RSIM6 project / RSIM3 create leg): the
 * source is DESTROYED (identity replacement) and replaced by a hidden template
 * (start=someday, rule tp=0, next-occurrence dates) plus EXACTLY ONE instance
 * dated at the current occurrence. Area/title/notes/tags copy to both.
 */
function applyMakeRepeatingFixed(
  sim: DatabaseSync,
  type: 0 | 1,
  params: RepeatRuleParams,
  ctx: ApplyCtx,
): void {
  const src = loadRepeatSource(sim, params.uuid);
  const todayIso = ctx.todayIso;
  const nextIso = addUnitsIso(todayIso, params.frequency, params.interval);
  const deadlined = params.deadline === true || (params.startDaysEarlier ?? 0) > 0;
  const startEarlier = params.startDaysEarlier ?? 0;
  const spec = composeRepeatRuleSpec(params, todayIso, epochOfIso(nextIso));
  const templateUuid = genUuid();
  const instanceUuid = genUuid();

  insertRecurrenceRow(sim, ctx, {
    uuid: templateUuid,
    type,
    title: src.title,
    notes: src.notes,
    area: src.area,
    start: START.someday,
    startDate: null,
    deadline: deadlined ? encodePackedDate(DEADLINE_SENTINEL_ISO) : null,
    recurrenceRuleXml: ruleXml(spec),
    instanceCreationCount: 1,
    instanceCreationStartDate: encodePackedDate(nextIso),
    nextInstanceStartDate: encodePackedDate(nextIso),
  });
  copyTaskTags(sim, params.uuid, templateUuid);

  // ONE instance at the current occurrence (start=someday pending maintenance
  // promotion). A deadlined series dates the instance's deadline at the
  // occurrence and starts it `startDaysEarlier` before that (decode identity
  // deadline = startDate − ts; deadlined creation is not itself RSIM-drive-proven).
  const instStartIso = deadlined ? addDaysIso(todayIso, -startEarlier) : todayIso;
  insertRecurrenceRow(sim, ctx, {
    uuid: instanceUuid,
    type,
    title: src.title,
    notes: src.notes,
    area: src.area,
    start: START.someday,
    startDate: encodePackedDate(instStartIso),
    deadline: deadlined ? encodePackedDate(todayIso) : null,
    repeatingTemplate: templateUuid,
  });
  copyTaskTags(sim, params.uuid, instanceUuid);

  sim.prepare("DELETE FROM TMTaskTag WHERE tasks = ?").run(params.uuid);
  sim.prepare("DELETE FROM TMTask WHERE uuid = ?").run(params.uuid);
}

/**
 * AFTER-COMPLETION make-repeating (RSIM2): the source is PRESERVED and relinked
 * as the sole first instance (identity kept — §8g: identity replacement is
 * fixed-only). A new tp=1 template is created with NO next/reference dates
 * (unknown until a completion). No fresh instance row is minted.
 */
function applyMakeRepeatingAfterCompletion(
  sim: DatabaseSync,
  type: 0 | 1,
  params: RepeatRuleParams,
  ctx: ApplyCtx,
): void {
  const src = loadRepeatSource(sim, params.uuid);
  const refIso = decodePackedDate(src.startDate) ?? ctx.todayIso;
  const deadlined = params.deadline === true || (params.startDaysEarlier ?? 0) > 0;
  const spec = composeRepeatRuleSpec(params, refIso, epochOfIso(refIso));
  const templateUuid = genUuid();

  insertRecurrenceRow(sim, ctx, {
    uuid: templateUuid,
    type,
    title: src.title,
    notes: src.notes,
    area: src.area,
    start: START.someday,
    startDate: null,
    deadline: deadlined ? encodePackedDate(DEADLINE_SENTINEL_ISO) : null,
    recurrenceRuleXml: ruleXml(spec),
    instanceCreationCount: 0,
  });
  copyTaskTags(sim, params.uuid, templateUuid);

  // Relink the preserved source as the instance; startDate/start unchanged.
  sim
    .prepare("UPDATE TMTask SET rt1_repeatingTemplate = ?, userModificationDate = ? WHERE uuid = ?")
    .run(templateUuid, ctx.nowEpoch, params.uuid);
}

/** Route a make-repeating to the fixed or after-completion applier by rule type. */
function applyMakeRepeating(
  sim: DatabaseSync,
  type: 0 | 1,
  params: RepeatRuleParams,
  ctx: ApplyCtx,
): void {
  if (params.afterCompletion === true) applyMakeRepeatingAfterCompletion(sim, type, params, ctx);
  else applyMakeRepeatingFixed(sim, type, params, ctx);
}

/**
 * reschedule-repeat (RSIM5, to-do or project): identity PRESERVED, the rule
 * rewritten in place to the target `{frequency, interval, anchors}` with the
 * instance-creation date advanced to the new next occurrence. `tp` and the
 * deadline-ness (ts + the template's deadline column) are preserved unless the
 * reschedule explicitly changes them. (The shipped op's interval-entry app bug
 * — RSIM5 caveat — is NOT modeled here: the simulator applies the TARGET rule.)
 */
function applyReschedule(sim: DatabaseSync, params: RepeatRuleParams, ctx: ApplyCtx): void {
  const row = sim
    .prepare("SELECT rt1_recurrenceRule AS rule FROM TMTask WHERE uuid = ?")
    .get(params.uuid) as { rule: unknown } | undefined;
  if (row === undefined || row.rule === null) {
    throw new Error("simulator: reschedule-repeat target is not a repeating template");
  }
  const existing = decodeRecurrenceRule(row.rule);
  const paramsHasAnchor =
    params.weekdays !== undefined || params.monthly !== undefined || params.yearly !== undefined;
  const preserveAfterCompletion =
    params.afterCompletion === undefined &&
    !paramsHasAnchor &&
    existing.type === "after-completion";
  const effective: RepeatRuleParams = { ...params };
  if (preserveAfterCompletion) effective.afterCompletion = true;

  const todayIso = ctx.todayIso;
  const nextIso = addUnitsIso(todayIso, params.frequency, params.interval);
  const spec = composeRepeatRuleSpec(effective, todayIso, epochOfIso(nextIso));

  const setsDeadline = params.deadline !== undefined || params.startDaysEarlier !== undefined;
  if (!setsDeadline) spec.ts = existing.startOffsetDays; // preserve the prior start offset

  const sets = [
    "rt1_recurrenceRule = ?",
    "rt1_instanceCreationStartDate = ?",
    "rt1_nextInstanceStartDate = ?",
    "userModificationDate = ?",
  ];
  const binds: (string | number | null | Uint8Array)[] = [
    new TextEncoder().encode(ruleXml(spec)),
    encodePackedDate(nextIso),
    encodePackedDate(nextIso),
    ctx.nowEpoch,
  ];
  if (setsDeadline) {
    const deadlined = params.deadline === true || (params.startDaysEarlier ?? 0) > 0;
    sets.push("deadline = ?");
    binds.push(deadlined ? encodePackedDate(DEADLINE_SENTINEL_ISO) : null);
  }
  sim.prepare(`UPDATE TMTask SET ${sets.join(", ")} WHERE uuid = ?`).run(...binds, params.uuid);
}

/**
 * Completion-side scheduling (RSIM4): completing an INSTANCE of an
 * after-completion (tp=1) template stamps the template's reference + next-start
 * dates (completion date, completion date + interval) WITHOUT materializing the
 * next instance — it stays pending until its future start date arrives. A
 * fixed-template instance (or a non-instance) is untouched here.
 */
function stampAfterCompletionTemplate(
  sim: DatabaseSync,
  instanceUuid: string,
  ctx: ApplyCtx,
): void {
  const inst = sim
    .prepare("SELECT rt1_repeatingTemplate AS tmpl FROM TMTask WHERE uuid = ?")
    .get(instanceUuid) as { tmpl: string | null } | undefined;
  const templateUuid = inst?.tmpl;
  if (templateUuid === null || templateUuid === undefined) return;
  const tpl = sim
    .prepare("SELECT rt1_recurrenceRule AS rule FROM TMTask WHERE uuid = ?")
    .get(templateUuid) as { rule: unknown } | undefined;
  if (tpl === undefined || tpl.rule === null) return;
  let rule;
  try {
    rule = decodeRecurrenceRule(tpl.rule);
  } catch {
    return; // undecodable template — leave it untouched
  }
  if (rule.type !== "after-completion") return;
  const completionIso = ctx.todayIso;
  const nextIso = addUnitsIso(completionIso, rule.unit, rule.interval);
  sim
    .prepare(
      "UPDATE TMTask SET rt1_afterCompletionReferenceDate = ?, rt1_nextInstanceStartDate = ?, " +
        "userModificationDate = ? WHERE uuid = ?",
    )
    .run(encodePackedDate(completionIso), encodePackedDate(nextIso), ctx.nowEpoch, templateUuid);
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

  "todo.complete": op<"todo.complete">((sim, params, ctx) => {
    setStatus(sim, params.uuid, STATUS.completed, ctx.nowEpoch, ctx);
    // RSIM4: completing an after-completion instance schedules the next
    // occurrence on its template without materializing it.
    stampAfterCompletionTemplate(sim, params.uuid, ctx);
  }),
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
          "UPDATE TMTask SET heading = ?, project = NULL, area = NULL, start = CASE WHEN start = 0 THEN 1 ELSE start END, userModificationDate = ? WHERE uuid = ?",
        )
        .run(h.resolved.uuid, ctx.nowEpoch, params.uuid);
      return;
    }
    if (params.project !== undefined) {
      const projUuid = containerUuid(sim, params.project, "project");
      sim
        .prepare(
          "UPDATE TMTask SET project = ?, heading = NULL, area = NULL, start = CASE WHEN start = 0 THEN 1 ELSE start END, userModificationDate = ? WHERE uuid = ?",
        )
        .run(projUuid, ctx.nowEpoch, params.uuid);
      return;
    }
    if (params.area !== undefined) {
      const areaUuid = containerUuid(sim, params.area, "area");
      // Filing an inbox item into a container promotes it to Anytime (start
      // 0→1), matching the app; someday (2) and already-active items keep
      // their start. Same promotion on the project/heading branches above.
      sim
        .prepare(
          "UPDATE TMTask SET area = ?, project = NULL, heading = NULL, start = CASE WHEN start = 0 THEN 1 ELSE start END, userModificationDate = ? WHERE uuid = ?",
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

  // Recurrence ops (RSIM1–6). project.create-repeating is delivered by the
  // runCreateRepeatingProject orchestrator over project.add + project.make-repeating
  // (both covered here), so it needs no direct applier. pause/resume/stop-repeat
  // are deliberately OMITTED — no RSIM shape proves their delta, and unsupported
  // beats guessed.
  "todo.make-repeating": op<"todo.make-repeating">((sim, params, ctx) =>
    applyMakeRepeating(sim, 0, params, ctx),
  ),
  "todo.reschedule-repeat": op<"todo.reschedule-repeat">((sim, params, ctx) =>
    applyReschedule(sim, params, ctx),
  ),
  "project.make-repeating": op<"project.make-repeating">((sim, params, ctx) =>
    applyMakeRepeating(sim, 1, params, ctx),
  ),
  "project.reschedule-repeat": op<"project.reschedule-repeat">((sim, params, ctx) =>
    applyReschedule(sim, params, ctx),
  ),
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
