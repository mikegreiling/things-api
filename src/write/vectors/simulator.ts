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
  ReorderParams,
  WhenValue,
} from "../operations.ts";
import { resolveResolutionInstant } from "../commands.ts";
import {
  computeReorderPre,
  resolveArea,
  resolveHeading,
  resolveProject,
  resolveTag,
} from "../pre-state.ts";
import { fixedSpawnPlan, isIsoDate } from "../repeat-anchor.ts";
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
  /**
   * The effective consumer IANA zone (from THINGS_TZ), threaded so the
   * resolution-timestamp appliers resolve a date-only backdate to the SAME
   * instant the pipeline's expectedDelta computed (both land at noon in this
   * zone, §5). Undefined = process-local zone, which for a local run is the
   * app's own zone.
   */
  zone?: string | undefined;
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
    /** Born-backdated creation stamp (add --created-at); default the write clock. */
    creationDate?: number | undefined;
    /** Born-resolved completion stamp (add --completed-at); default NULL (open). */
    stopDate?: number | null | undefined;
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
       ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, NULL, ?, ?, ?, 0, 0, ?, ?, NULL, NULL, NULL, 0, NULL)`,
    )
    .run(
      opts.uuid,
      type,
      STATUS[opts.status ?? "open"],
      opts.stopDate ?? null,
      opts.title,
      opts.notes ?? "",
      opts.creationDate ?? ctx.nowEpoch,
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

// -------------------------------------------- resolution timestamps (BACKDT)
//
// The `--completed-at` / `--created-at` surface (docs/design/resolution-
// timestamp-surface.md; assumption-register BACKDT / WG-7). Backdating has no
// single-shot headless move on an existing row, so the CLI sequences legs:
//   complete --completed-at  = [complete] → todo.set-dates(completedAt)
//   cancel   --completed-at  = [complete] → todo.set-dates(completedAt) → cancel
//   update   --completed-at  = todo.set-dates (completed row) or the flip-dance
//   add --created-at/--completed-at = a single json import (folded into *.add)
// The simulator applies the STRUCTURED op each leg carries: the flip legs are
// the existing complete/cancel appliers (extended below to PRESERVE an existing
// stopDate — the WG-7 "flip preserves stopDate" law), and todo.set-dates /
// project.set-dates write the exact backdated column value.

/**
 * The Unix-epoch second-precision value a resolution timestamp materializes,
 * resolved through the SAME `resolveResolutionInstant` the compile + expected-
 * delta use (a date-only value lands at noon in the effective zone, §5), so the
 * stored `stopDate` / `creationDate` decodes back to the asserted host-local
 * date exactly.
 */
function resolutionEpoch(input: string, zone: string | undefined): number {
  return Math.floor(resolveResolutionInstant(input, zone).getTime() / 1000);
}

/**
 * The born creation/completion stamps for a timestamped `add` (--created-at /
 * --completed-at, the single-leg json-import path folded into *.add). A
 * born-resolved add lands COMPLETED with the exact backdated stopDate; both
 * stamps resolve through the shared instant resolver so the create-probe verify
 * (status + stoppedDate + createdDate) reads back the asserted host-local dates.
 */
function bornTimestamps(
  params: { createdAt?: string; completedAt?: string },
  ctx: ApplyCtx,
): { completed: boolean; creationDate: number | undefined; stopDate: number | undefined } {
  return {
    completed: params.completedAt !== undefined,
    creationDate:
      params.createdAt !== undefined ? resolutionEpoch(params.createdAt, ctx.zone) : undefined,
    stopDate:
      params.completedAt !== undefined ? resolutionEpoch(params.completedAt, ctx.zone) : undefined,
  };
}

/**
 * The stopDate a complete/cancel FLIP leg leaves (WG-7 flip-preserves-stopDate +
 * idempotent re-resolve): a row that is ALREADY resolved (has a stopDate) keeps
 * it — the flip only rewrites `status` — so the backdated stamp a preceding
 * set-dates leg wrote survives the flip-dance (e.g. cancel --completed-at:
 * complete → set-dates(backdate) → cancel must NOT clobber the backdated stop).
 * A row crossing FROM open (stopDate NULL) is freshly stamped at the write clock.
 */
function flipStopDate(sim: DatabaseSync, uuid: string, ctx: ApplyCtx): number {
  const row = sim.prepare("SELECT stopDate FROM TMTask WHERE uuid = ?").get(uuid) as
    | { stopDate: number | null }
    | undefined;
  return row?.stopDate ?? ctx.nowEpoch;
}

/**
 * todo.set-dates / project.set-dates (kind-agnostic — one TMTask row): rewrite
 * the completion and/or creation stamp to the exact backdated value. The
 * completion leg fires only against a verified-completed row (the H-BACKDATE-OPEN
 * guard + the orchestrator's flip legs guarantee it upstream), so this is a pure
 * column write — status is untouched here.
 */
function applySetDates(
  sim: DatabaseSync,
  params: { uuid: string; completedAt?: string; createdAt?: string },
  ctx: ApplyCtx,
): void {
  const sets: string[] = [];
  const binds: (number | null)[] = [];
  if (params.completedAt !== undefined) {
    sets.push("stopDate = ?");
    binds.push(resolutionEpoch(params.completedAt, ctx.zone));
  }
  if (params.createdAt !== undefined) {
    sets.push("creationDate = ?");
    binds.push(resolutionEpoch(params.createdAt, ctx.zone));
  }
  if (sets.length === 0) return;
  sets.push("userModificationDate = ?");
  binds.push(ctx.nowEpoch);
  sim.prepare(`UPDATE TMTask SET ${sets.join(", ")} WHERE uuid = ?`).run(...binds, params.uuid);
}

// --------------------------------------------------------- reorder (ORD-*)
//
// The universal `reorder` op IS the native private-command index wire (runReorder
// dispatches strategy=native here; the bounce-only scopes never reach this op).
// ORD-1 (native forward, o-suite O01/O04/O05/O09/O10/O11): the listed rows re-rank
// into the sent order on their bucket axis — `todayIndex` for the Today/day scopes,
// `index` elsewhere (ORD-18 axis-isolation). The wire list is the full target
// order (requested subset first, remaining members after, computed by the SHARED
// computeReorderPre the command's preRead + guard use), so a partial request keeps
// the unrequested tail's relative order below the block. Refusal/eligibility (mixed
// kinds, non-member anchors, duplicates, swept-resolved rows, evening→native) is
// enforced by the H-REORDER-SCOPE guard BEFORE this applier runs — an admitted
// request has a clean wire list, so re-ranking it is the whole job. The re-rank is
// userModificationDate-SILENT (LOGSORT ORD-13 byte-lock: an admitted unswept-
// resolved movee must read back index-only, status/stopDate/umd unchanged).

/** Resolve the reorder scope's container uuid exactly as the command's preRead does. */
function reorderContainerUuid(sim: DatabaseSync, params: ReorderParams): string | null {
  if (params.scope === "project")
    return resolveProject(sim, params.container ?? {}).resolved?.uuid ?? null;
  if (params.scope === "area")
    return resolveArea(sim, params.container ?? {}).resolved?.uuid ?? null;
  if (params.scope === "container-day") {
    // The container may be a project OR an area (DAYORD-b) — resolve whichever it names.
    const asProject = resolveProject(sim, params.container ?? {});
    if (asProject.resolved !== null) return asProject.resolved.uuid;
    return resolveArea(sim, params.container ?? {}).resolved?.uuid ?? null;
  }
  return null;
}

function applyReorder(sim: DatabaseSync, params: ReorderParams, ctx: ApplyCtx): void {
  const now = new Date(ctx.nowEpoch * 1000);
  const container = reorderContainerUuid(sim, params);
  // The SAME membership + wire-list computation the pipeline's preRead/guard use;
  // admitResolved mirrors the native op's preRead (LOGSORT ORD-13 permit).
  const pre = computeReorderPre(sim, params, container, now, {
    admitResolved: true,
    zone: ctx.zone,
  });
  // TODWIRE — the `today` scope's native `list "Today"` wire is MINIMAL and it
  // FRONT-INSERTS: the named block gets a fresh `todayIndex` min-space BELOW every
  // current Today member AND every named row's `todayIndexReferenceDate` is
  // re-stamped → today (EXP1/EXP4), while unnamed rows stay byte-untouched (their
  // cohorts + positions preserved). Model that directly, so the simulator's Today
  // order matches the native app for both partial and full wires.
  if (params.scope === "today" && pre.todayWire !== null) {
    const wire = pre.todayWire;
    if (wire.length === 0) return;
    const min =
      (
        sim
          .prepare(
            "SELECT MIN(todayIndex) AS m FROM TMTask WHERE trashed = 0 AND status = 0 " +
              "AND type IN (0, 1) AND startBucket = 0 AND startDate IS NOT NULL AND start IN (1, 2)",
          )
          .get() as { m: number | null }
      ).m ?? 0;
    const base = min - wire.length;
    const packedToday = encodePackedDate(localToday(now));
    for (let i = 0; i < wire.length; i++) {
      sim
        .prepare("UPDATE TMTask SET todayIndex = ?, todayIndexReferenceDate = ? WHERE uuid = ?")
        .run(base + i, packedToday, wire[i] as string);
    }
    return;
  }
  const wire = pre.wireList;
  if (wire.length === 0) return; // a guard-admitted request always has members
  const col = pre.key === "todayIndex" ? "todayIndex" : `"index"`;
  // Re-rank into wire order using the members' OWN current rank slots (permuted),
  // so nothing outside the scope shifts. Guarantee strict ascension for the verify.
  const existing = wire
    .map((u) => {
      const r = sim.prepare(`SELECT ${col} AS rank FROM TMTask WHERE uuid = ?`).get(u) as
        | { rank: number | null }
        | undefined;
      return r?.rank ?? null;
    })
    .filter((r): r is number => r !== null)
    .toSorted((a, b) => a - b);
  const pool: number[] = [];
  for (let i = 0; i < wire.length; i++) {
    const cand = existing[i] ?? (pool[i - 1] ?? -1) + 1;
    const prev = pool[i - 1];
    pool.push(prev !== undefined && cand <= prev ? prev + 1 : cand);
  }
  // umd-SILENT: touch ONLY the rank column (LOGSORT ORD-13 byte-lock).
  for (let i = 0; i < wire.length; i++) {
    sim
      .prepare(`UPDATE TMTask SET ${col} = ? WHERE uuid = ?`)
      .run(pool[i] as number, wire[i] as string);
  }
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
): {
  title: string;
  notes: string;
  area: string | null;
  startDate: number | null;
  deadline: number | null;
} {
  const src = sim
    .prepare("SELECT title, notes, area, startDate, deadline FROM TMTask WHERE uuid = ?")
    .get(uuid) as
    | {
        title: string | null;
        notes: string | null;
        area: string | null;
        startDate: number | null;
        deadline: number | null;
      }
    | undefined;
  if (src === undefined) throw new Error("simulator: make-repeating target not found");
  return {
    title: src.title ?? "",
    notes: src.notes ?? "",
    area: src.area,
    startDate: src.startDate,
    // §RSIM-T: a non-NULL source deadline is the sole to-do fixed-preserve trigger.
    deadline: src.deadline,
  };
}

// ------------------------------------------------- project subtree copy
//
// RSIM-P (docs/lab/rsim-results.md §RSIM-P): making a PROJECT repeat
// deep-duplicates its entire child subtree. A project make-repeating (fixed OR
// after-completion) HARD-DELETES the source project and every descendant
// (headings + to-dos + those to-dos' tags + checklist items) and mints TWO
// independent plain copies of the whole subtree — one under the hidden template
// project, one under the instance project. The helpers below read the source
// subtree ONCE (before deletion), materialize a plain copy under a new project,
// and delete the source subtree.

interface SubtreeChecklistItem {
  title: string;
  status: number;
  index: number;
}
interface SubtreeTodo {
  uuid: string;
  title: string;
  notes: string;
  status: number;
  stopDate: number | null;
  deadline: number | null;
  index: number;
  /** RSIM-S S-R1: trashed rows ride along for DELETION but are excluded from COPIES. */
  trashed: boolean;
  /** Source heading uuid for a headed to-do; null for a direct child. */
  headingUuid: string | null;
  /** RSIM-R: rt1_recurrenceRule — non-null marks a NESTED template (repeater). */
  recurrenceRule: unknown;
  /** RSIM-R: rt1_repeatingTemplate — non-null marks a NESTED repeater instance. */
  repeatingTemplate: string | null;
  tags: string[];
  checklist: SubtreeChecklistItem[];
}
interface SubtreeHeading {
  uuid: string;
  title: string;
  notes: string;
  status: number;
  stopDate: number | null;
  index: number;
  /** RSIM-S S-R1: trashed rows ride along for DELETION but are excluded from COPIES. */
  trashed: boolean;
}
interface ProjectSubtree {
  headings: SubtreeHeading[];
  todos: SubtreeTodo[];
}

/**
 * Read a project's full containment subtree (headings + direct/headed to-dos,
 * with tags + checklist) before any mutation.
 *
 * RSIM-S (§RSIM-S S-R1): trashed rows are INCLUDED (each tagged `trashed`) so a
 * source-DELETE conversion can hard-delete the WHOLE subtree — reality destroys
 * a pre-trashed child along with the source, leaving no orphan. Copy paths
 * (`materializeSubtreeCopy`) filter these back out — a spawned/template copy
 * never carries trashed rows (RSIM-P2 A3, probe-verified).
 */
function readProjectSubtree(sim: DatabaseSync, projectUuid: string): ProjectSubtree {
  const headingRows = sim
    .prepare(
      `SELECT uuid, title, notes, status, stopDate, trashed, "index" AS idx
         FROM TMTask WHERE type = 2 AND project = ? ORDER BY "index"`,
    )
    .all(projectUuid) as {
    uuid: string;
    title: string | null;
    notes: string | null;
    status: number;
    stopDate: number | null;
    trashed: number;
    idx: number;
  }[];
  const headings: SubtreeHeading[] = headingRows.map((h) => ({
    uuid: h.uuid,
    title: h.title ?? "",
    notes: h.notes ?? "",
    status: h.status,
    stopDate: h.stopDate,
    index: h.idx,
    trashed: h.trashed === 1,
  }));
  const headingUuids = headings.map((h) => h.uuid);
  // A direct child has project=<projectUuid>; a headed child has project=NULL
  // and heading=<one of this project's headings> — this union captures both.
  const placeholders = headingUuids.map(() => "?").join(", ");
  const todoRows = sim
    .prepare(
      `SELECT uuid, title, notes, status, stopDate, deadline, heading, trashed,
              rt1_recurrenceRule AS recurrenceRule, rt1_repeatingTemplate AS repeatingTemplate,
              "index" AS idx
         FROM TMTask WHERE type = 0
           AND (project = ?${headingUuids.length > 0 ? ` OR heading IN (${placeholders})` : ""})
         ORDER BY "index"`,
    )
    .all(projectUuid, ...headingUuids) as {
    uuid: string;
    title: string | null;
    notes: string | null;
    status: number;
    stopDate: number | null;
    deadline: number | null;
    heading: string | null;
    trashed: number;
    recurrenceRule: unknown;
    repeatingTemplate: string | null;
    idx: number;
  }[];
  const todos: SubtreeTodo[] = todoRows.map((t) => ({
    uuid: t.uuid,
    title: t.title ?? "",
    notes: t.notes ?? "",
    status: t.status,
    stopDate: t.stopDate,
    deadline: t.deadline,
    index: t.idx,
    trashed: t.trashed === 1,
    headingUuid: t.heading,
    recurrenceRule: t.recurrenceRule,
    repeatingTemplate: t.repeatingTemplate,
    tags: (
      sim.prepare("SELECT tags FROM TMTaskTag WHERE tasks = ?").all(t.uuid) as { tags: string }[]
    ).map((r) => r.tags),
    checklist: (
      sim
        .prepare(
          `SELECT title, status, "index" AS idx FROM TMChecklistItem WHERE task = ? ORDER BY "index"`,
        )
        .all(t.uuid) as { title: string | null; status: number; idx: number }[]
    ).map((c) => ({ title: c.title ?? "", status: c.status, index: c.idx })),
  }));
  return { headings, todos };
}

/** UPDATE a row's list index (insertTask hardcodes 0; the copy preserves source order). */
function setRowIndex(sim: DatabaseSync, uuid: string, index: number): void {
  sim.prepare(`UPDATE TMTask SET "index" = ? WHERE uuid = ?`).run(index, uuid);
}

/**
 * Materialize a PLAIN copy of `subtree` under `newProjectUuid` (fresh uuids for
 * every heading/to-do; tags + checklist duplicated; index order + heading
 * membership preserved; children `start=1`, `rt1_recurrenceRule`/
 * `rt1_repeatingTemplate` NULL).
 *
 * RSIM-R: copied children are ALWAYS plain — both fixed and after-completion
 * instance/template sides. (RSIM-P P4's per-child instance→template links are a
 * non-reproducible anomaly; A5/R7/R8 = 3/3 plain — so no linkMap parameter.)
 */
function materializeSubtreeCopy(
  sim: DatabaseSync,
  ctx: ApplyCtx,
  subtree: ProjectSubtree,
  newProjectUuid: string,
): void {
  const headingIdMap = new Map<string, string>();
  for (const h of subtree.headings) {
    if (h.trashed) continue; // RSIM-S S-R1: copies exclude trashed rows (RSIM-P2 A3).
    const newUuid = genUuid();
    insertTask(sim, 2, ctx, {
      uuid: newUuid,
      title: h.title,
      notes: h.notes,
      start: START.active, // RSIM-P P1: copied children are start=1
      project: newProjectUuid,
    });
    setRowIndex(sim, newUuid, h.index);
    if (h.status !== STATUS.open)
      setStatus(sim, newUuid, h.status, h.stopDate ?? ctx.nowEpoch, ctx);
    headingIdMap.set(h.uuid, newUuid);
  }
  for (const t of subtree.todos) {
    if (t.trashed) continue; // RSIM-S S-R1: copies exclude trashed rows (RSIM-P2 A3).
    const newUuid = genUuid();
    // Preserve the containment invariant: a headed child points at the COPIED
    // heading with project NULL; a direct child points at the new project.
    const heading = t.headingUuid !== null ? (headingIdMap.get(t.headingUuid) ?? null) : null;
    const project = heading !== null ? null : newProjectUuid;
    const openChecklist = t.checklist.filter((c) => c.status === STATUS.open).length;
    insertTask(sim, 0, ctx, {
      uuid: newUuid,
      title: t.title,
      notes: t.notes,
      start: START.active, // RSIM-P P1: start=1
      startDate: null,
      deadline: t.deadline,
      project,
      heading,
      checklistItemsCount: t.checklist.length,
      openChecklistItemsCount: openChecklist,
    });
    setRowIndex(sim, newUuid, t.index);
    if (t.status !== STATUS.open)
      setStatus(sim, newUuid, t.status, t.stopDate ?? ctx.nowEpoch, ctx);
    for (const tag of t.tags) {
      sim.prepare("INSERT INTO TMTaskTag (tasks, tags) VALUES (?, ?)").run(newUuid, tag);
    }
    for (const c of t.checklist) {
      sim
        .prepare(
          `INSERT INTO TMChecklistItem (uuid, userModificationDate, creationDate, title, status, stopDate, "index", task, leavesTombstone)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 0)`,
        )
        .run(genUuid(), ctx.nowEpoch, ctx.nowEpoch, c.title, c.status, c.index, newUuid);
    }
  }
}

/**
 * Hard-DELETE a source subtree: each to-do's tags + checklist + row, then the
 * heading rows.
 *
 * RSIM-S (§RSIM-S S-R1): the subtree includes already-trashed rows, and they are
 * destroyed here too — a source-DELETE conversion hard-deletes the WHOLE source
 * subtree, so a pre-trashed child does NOT survive as a dangling row pointing at
 * the deleted source (it is neither copied nor left in the Trash).
 */
function deleteProjectSubtree(sim: DatabaseSync, subtree: ProjectSubtree): void {
  for (const t of subtree.todos) {
    sim.prepare("DELETE FROM TMTaskTag WHERE tasks = ?").run(t.uuid);
    sim.prepare("DELETE FROM TMChecklistItem WHERE task = ?").run(t.uuid);
    sim.prepare("DELETE FROM TMTask WHERE uuid = ?").run(t.uuid);
  }
  for (const h of subtree.headings) {
    sim.prepare("DELETE FROM TMTaskTag WHERE tasks = ?").run(h.uuid);
    sim.prepare("DELETE FROM TMTask WHERE uuid = ?").run(h.uuid);
  }
}

/**
 * RSIM-R C1: a NESTED repeater in a project's subtree is a to-do carrying either
 * `rt1_recurrenceRule` (the nested hidden template) or `rt1_repeatingTemplate`
 * (the nested repeater's instance). Its presence flips the fixed project
 * make-repeating from delete-and-mint-both to the source-preserving path.
 */
function subtreeHasNestedRepeater(subtree: ProjectSubtree): boolean {
  // RSIM-S S-R1: consider only live rows — a trashed nested repeater does not
  // flip source-fate (a trashed child alone leaves the delete-default intact).
  return subtree.todos.some(
    (t) => !t.trashed && (t.recurrenceRule !== null || t.repeatingTemplate !== null),
  );
}

/**
 * RSIM-U (2026-07-22): the SECOND fixed-project source-preserve trigger — a plain
 * project (no nested repeater) PRESERVES its source when EVERY live child to-do is
 * TERMINAL (completed/canceled); a single OPEN child DELETES it (U-open). An empty
 * subtree also deletes (needs ≥1 terminal child). Trashed children do not count —
 * a trashed child alone leaves the delete-default intact (RSIM-S SR Proj). Headed
 * children ride in `subtree.todos`, so headed terminal children count too.
 */
function subtreeAllChildrenTerminal(subtree: ProjectSubtree): boolean {
  const live = subtree.todos.filter((t) => !t.trashed);
  return (
    live.length > 0 &&
    live.every((t) => t.status === STATUS.completed || t.status === STATUS.canceled)
  );
}

/**
 * The two INDEPENDENT fixed-project source-PRESERVE triggers (RSIM-R C1 + RSIM-U):
 * a nested repeater in the subtree, OR every child terminal (no open child).
 * Either one preserves the source (relink in place, mint only the template);
 * otherwise the source is deleted and both template + instance are minted fresh.
 */
function fixedProjectPreservesSource(subtree: ProjectSubtree): boolean {
  return subtreeHasNestedRepeater(subtree) || subtreeAllChildrenTerminal(subtree);
}

/**
 * FIXED make-repeating (RSIM1 to-do / RSIM6 project / RSIM3 create leg): the
 * source is DESTROYED (identity replacement) and replaced by a hidden template
 * (start=someday, rule tp=0, next-occurrence dates) plus EXACTLY ONE instance
 * dated at the current occurrence. Area/title/notes/tags copy to both. For a
 * PROJECT (type=1) with children, the source subtree is hard-deleted and a plain
 * copy is minted under BOTH new projects (RSIM-P P1).
 *
 * Source-PRESERVE branches (probe-verified — the source is relinked in place as the
 * current-occurrence instance and ONLY the hidden template is minted, no separate
 * instance):
 *   - TO-DO (type=0, §RSIM-T): preserve IFF the source carries a non-NULL `deadline`
 *     (deadline-only preserved 1/1; bare/notes-only/tag-only/checklist-only each
 *     DELETE 4/4). The preserved source keeps its own deadline; the template drops it.
 *   - PROJECT (type=1, §RSIM-R C1 + §RSIM-U): preserve IFF the subtree contains a
 *     NESTED repeater (flatten path) OR every child is TERMINAL (completed/canceled,
 *     no open child). An open child, an empty subtree, plain-open children, area, and
 *     schedule all DELETE. See `applyMakeRepeatingFixedProjectPreserve`.
 * Every other case deletes-and-remints (identity replacement).
 */
function applyMakeRepeatingFixed(
  sim: DatabaseSync,
  type: 0 | 1,
  params: RepeatRuleParams,
  ctx: ApplyCtx,
): void {
  const src = loadRepeatSource(sim, params.uuid);
  // RSIM-P P1: a project's child subtree is captured BEFORE any mutation so the
  // hidden template and the instance each receive a plain copy. To-dos have none.
  const subtree = type === 1 ? readProjectSubtree(sim, params.uuid) : null;
  const todayIso = ctx.todayIso;
  const deadlined = params.deadline === true || (params.startDaysEarlier ?? 0) > 0;
  const startEarlier = params.startDaysEarlier ?? 0;

  // ANCH2 (issue #476, docs/lab/anch2-next-field.md): the app's "Next:" field
  // fixes the first occurrence. When the promote drives it (params.next), the
  // series anchors there verbatim — the instance materializes only when that date
  // is today. Left to its DEFAULT (no params.next), a FIXED rule anchors to the
  // next calendar match ≥ today (ANCH1 fixedSpawnPlan for daily/weekly; monthly/
  // yearly keep the today+interval model, their default-anchor law being unprobed).
  const nextIso = isIsoDate(params.next) ? params.next : null;
  const plan =
    nextIso !== null
      ? {
          refIso: nextIso,
          instanceStartIso: (nextIso === todayIso ? todayIso : null) as string | null,
          cursorIso: nextIso,
          instanceCount: (nextIso === todayIso ? 1 : 0) as 0 | 1,
        }
      : params.frequency === "daily" || params.frequency === "weekly"
        ? fixedSpawnPlan(params, todayIso)
        : {
            refIso: todayIso,
            instanceStartIso: todayIso as string | null,
            cursorIso: addUnitsIso(todayIso, params.frequency, params.interval),
            instanceCount: 1 as 0 | 1,
          };

  // A PRESERVED source is relinked as the current-occurrence instance (count 1); a
  // DELETE-fate source spawns a fresh instance only when today is an occurrence.
  const sourceBecomesInstance =
    (type === 0 && src.deadline !== null) ||
    (subtree !== null && fixedProjectPreservesSource(subtree));
  const instanceCount: 0 | 1 = sourceBecomesInstance ? 1 : plan.instanceCount;

  const spec = composeRepeatRuleSpec(params, plan.refIso, epochOfIso(plan.refIso));
  const templateUuid = genUuid();

  // The hidden template row is identical in both fixed-project fates.
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
    instanceCreationCount: instanceCount,
    instanceCreationStartDate: encodePackedDate(plan.cursorIso),
    nextInstanceStartDate: encodePackedDate(plan.cursorIso),
  });
  copyTaskTags(sim, params.uuid, templateUuid);

  // The current occurrence date (the app dates the instance here; a preserved
  // source is relinked at this date). Deadlined series back off `startDaysEarlier`
  // (decode identity deadline = startDate − ts).
  const occIso = plan.instanceStartIso ?? plan.refIso;
  const instStartIso = deadlined ? addDaysIso(occIso, -startEarlier) : occIso;

  // §RSIM-T: a fixed TO-DO carrying a deadline PRESERVES its source — relink it in
  // place as the current-occurrence instance; only the template was minted above.
  // The source keeps its own deadline (the template row already dropped it).
  if (type === 0 && src.deadline !== null) {
    sim
      .prepare(
        `UPDATE TMTask SET start = ?, startDate = ?, rt1_repeatingTemplate = ?, userModificationDate = ? WHERE uuid = ?`,
      )
      .run(START.someday, encodePackedDate(instStartIso), templateUuid, ctx.nowEpoch, params.uuid);
    return;
  }

  // RSIM-R C1 + RSIM-U: a fixed PROJECT with a nested repeater OR all-terminal
  // children PRESERVES the source (relink in place; flatten any nested repeater).
  if (subtree !== null && fixedProjectPreservesSource(subtree)) {
    applyMakeRepeatingFixedProjectPreserve(
      sim,
      ctx,
      params.uuid,
      subtree,
      templateUuid,
      instStartIso,
    );
    return;
  }

  // RSIM-P P1: template-side children are completely PLAIN (no per-child link).
  if (subtree !== null) materializeSubtreeCopy(sim, ctx, subtree, templateUuid);

  // ANCH1: a fixed rule materializes its current-occurrence instance ONLY when
  // today is itself an occurrence (plan.instanceStartIso non-null). When the first
  // occurrence is in the future, NO instance spawns — the template + cursor stand
  // alone until that date (A2). (start=someday pending maintenance promotion; a
  // deadlined series dates the instance's deadline at the occurrence.)
  if (plan.instanceStartIso !== null) {
    const instanceUuid = genUuid();
    insertRecurrenceRow(sim, ctx, {
      uuid: instanceUuid,
      type,
      title: src.title,
      notes: src.notes,
      area: src.area,
      start: START.someday,
      startDate: encodePackedDate(instStartIso),
      deadline: deadlined ? encodePackedDate(occIso) : null,
      repeatingTemplate: templateUuid,
    });
    copyTaskTags(sim, params.uuid, instanceUuid);
    // RSIM-P P1: FIXED instance-side children are ALSO plain — no per-child link.
    if (subtree !== null) materializeSubtreeCopy(sim, ctx, subtree, instanceUuid);
  }

  // RSIM-P P1: hard-delete the whole source subtree, then the source project.
  if (subtree !== null) deleteProjectSubtree(sim, subtree);
  sim.prepare("DELETE FROM TMTaskTag WHERE tasks = ?").run(params.uuid);
  sim.prepare("DELETE FROM TMTask WHERE uuid = ?").run(params.uuid);
}

/**
 * Fixed PROJECT source-PRESERVE path — either trigger (RSIM-R C1 nested repeater,
 * A1/A2/A3/S2/S2b; or RSIM-U all-terminal children, U-comp/U-canc/U-both). The
 * source project is PRESERVED and relinked as the current-occurrence instance
 * rather than deleted; any nested repeater is FLATTENED in place (a no-op for the
 * all-terminal trigger, which has none); and only the (already-minted) hidden
 * template project is populated — there is NO separate instance project. Row-level
 * shape (S2/U-comp, re-derived uuid-by-uuid):
 *   - source project CHANGED: `start → 2` (someday), `startDate → currentOccurrence`,
 *     `rt1_repeatingTemplate → template`. All other source columns (title, notes,
 *     area, deadline) are left untouched, and the source's children ride along
 *     UNCHANGED under the preserved instance (RSIM-U: childrenReplaced=0).
 *   - nested template row hard-deleted; nested instance demoted to PLAIN
 *     (`rt1_repeatingTemplate → NULL`).
 *   - the template project receives a PLAIN copy of the FLATTENED subtree (the
 *     nested template rows excluded; the demoted instance copied as a plain to-do;
 *     terminal children copy with their status preserved).
 */
function applyMakeRepeatingFixedProjectPreserve(
  sim: DatabaseSync,
  ctx: ApplyCtx,
  sourceUuid: string,
  subtree: ProjectSubtree,
  templateUuid: string,
  instStartIso: string,
): void {
  // The template project gets a plain copy of the FLATTENED subtree — nested
  // template rows are dropped; every surviving to-do copies plain via
  // materializeSubtreeCopy (start=1, no recurrence/template links).
  // RSIM-S S-R1: the copy excludes trashed rows; materializeSubtreeCopy also
  // skips them, but keep the flattened set clean for clarity.
  const flattened: ProjectSubtree = {
    headings: subtree.headings.filter((h) => !h.trashed),
    todos: subtree.todos.filter((t) => t.recurrenceRule === null && !t.trashed),
  };
  materializeSubtreeCopy(sim, ctx, flattened, templateUuid);

  // Flatten the nested repeater IN the preserved source subtree. Trashed rows
  // ride along untouched under the preserved source (RSIM-S S-R2, inferred).
  for (const t of subtree.todos) {
    if (t.trashed) continue;
    if (t.recurrenceRule !== null) {
      // Nested hidden template: hard-delete its tags + checklist + row.
      sim.prepare("DELETE FROM TMTaskTag WHERE tasks = ?").run(t.uuid);
      sim.prepare("DELETE FROM TMChecklistItem WHERE task = ?").run(t.uuid);
      sim.prepare("DELETE FROM TMTask WHERE uuid = ?").run(t.uuid);
    } else if (t.repeatingTemplate !== null) {
      // Nested instance: demote to a plain to-do.
      sim.prepare("UPDATE TMTask SET rt1_repeatingTemplate = NULL WHERE uuid = ?").run(t.uuid);
    }
  }

  // Preserve the source project AS the current-occurrence instance.
  sim
    .prepare(
      `UPDATE TMTask SET start = ?, startDate = ?, rt1_repeatingTemplate = ?, userModificationDate = ? WHERE uuid = ?`,
    )
    .run(START.someday, encodePackedDate(instStartIso), templateUuid, ctx.nowEpoch, sourceUuid);
}

/**
 * AFTER-COMPLETION make-repeating.
 *
 * TO-DO (type=0, RSIM2): the source is PRESERVED and relinked as the sole first
 * instance (identity kept — §8g: identity replacement is fixed-only). A new tp=1
 * template is created with NO next/reference dates (unknown until a completion).
 * No fresh instance row is minted.
 *
 * PROJECT (type=1, RSIM-P P4): the type-0 path does NOT hold — the source is
 * DELETED (like the fixed case) and BOTH a template and a fresh instance are
 * minted, each with a full plain child copy, and each instance-side to-do child
 * carries a per-child rt1_repeatingTemplate. Split out to a dedicated applier.
 */
function applyMakeRepeatingAfterCompletion(
  sim: DatabaseSync,
  type: 0 | 1,
  params: RepeatRuleParams,
  ctx: ApplyCtx,
): void {
  // RSIM-P P4: the after-completion PROJECT path is NOT the to-do path.
  if (type === 1) {
    applyMakeRepeatingAfterCompletionProject(sim, params, ctx);
    return;
  }
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

/**
 * AFTER-COMPLETION make-repeating for a PROJECT (RSIM-P P4). Unlike the to-do
 * path (RSIM2, source preserved), the source project is DELETED and both a
 * template and a fresh instance are minted — the same delete+duplicate shape as
 * the fixed project case, but with:
 *   - a tp=1 (after-completion) rule and NO next/reference dates
 *     (`rt1_nextInstanceStartDate` / `rt1_afterCompletionReferenceDate` NULL);
 *   - the template's `rt1_instanceCreationCount` = 1 (P4 observed, vs 0 for the
 *     after-completion TO-DO template);
 *   - the instance's `startDate` = the SOURCE project's startDate (not the
 *     current occurrence used by the fixed case).
 *
 * RSIM-R: instance-side children (to-dos AND headings) are PLAIN — no per-child
 * `rt1_repeatingTemplate` link. RSIM-P P4's per-child links are a NON-reproducible
 * anomaly (A5/R7/R8 = 3/3 plain); only the project row carries the instance→
 * template link.
 */
function applyMakeRepeatingAfterCompletionProject(
  sim: DatabaseSync,
  params: RepeatRuleParams,
  ctx: ApplyCtx,
): void {
  const src = loadRepeatSource(sim, params.uuid);
  const subtree = readProjectSubtree(sim, params.uuid);
  const refIso = decodePackedDate(src.startDate) ?? ctx.todayIso;
  const deadlined = params.deadline === true || (params.startDaysEarlier ?? 0) > 0;
  const spec = composeRepeatRuleSpec(params, refIso, epochOfIso(refIso));
  const templateUuid = genUuid();
  const instanceUuid = genUuid();

  // Template: tp=1 rule, hidden, icCount=1, NO next/reference dates (P4).
  insertRecurrenceRow(sim, ctx, {
    uuid: templateUuid,
    type: 1,
    title: src.title,
    notes: src.notes,
    area: src.area,
    start: START.someday,
    startDate: null,
    deadline: deadlined ? encodePackedDate(DEADLINE_SENTINEL_ISO) : null,
    recurrenceRuleXml: ruleXml(spec),
    instanceCreationCount: 1, // RSIM-P P4
  });
  copyTaskTags(sim, params.uuid, templateUuid);
  // Template-side children are PLAIN.
  materializeSubtreeCopy(sim, ctx, subtree, templateUuid);

  // Instance: fresh row (source is deleted, unlike the to-do path), tmpl link,
  // startDate = the SOURCE project's startDate (P4).
  insertRecurrenceRow(sim, ctx, {
    uuid: instanceUuid,
    type: 1,
    title: src.title,
    notes: src.notes,
    area: src.area,
    start: START.someday,
    startDate: src.startDate,
    deadline: null,
    repeatingTemplate: templateUuid,
  });
  copyTaskTags(sim, params.uuid, instanceUuid);
  // RSIM-R: instance-side children are PLAIN — no per-child template link
  // (P4's links do not reproduce; pass null exactly as the fixed case does).
  materializeSubtreeCopy(sim, ctx, subtree, instanceUuid);

  // Hard-delete the source subtree + the source project (P4 deletes the source).
  deleteProjectSubtree(sim, subtree);
  sim.prepare("DELETE FROM TMTaskTag WHERE tasks = ?").run(params.uuid);
  sim.prepare("DELETE FROM TMTask WHERE uuid = ?").run(params.uuid);
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
    // Born-resolved (--completed-at, §5b): a completed json import lands straight
    // in the Logbook — no active schedule (when/reminder are refused alongside it).
    const born = bornTimestamps(params, ctx);
    const s = born.completed
      ? { start: START.active, startDate: null, startBucket: 0 }
      : scheduleColumns(params.when, ctx.todayIso, hasContainer);
    const uuid = genUuid();
    insertTask(sim, 0, ctx, {
      uuid,
      title: params.title,
      notes: params.notes ?? "",
      status: born.completed ? "completed" : "open",
      start: s.start,
      startDate: s.startDate,
      startBucket: s.startBucket,
      reminderTime:
        !born.completed && params.reminder !== undefined
          ? encodeReminderTime(params.reminder)
          : null,
      deadline: params.deadline !== undefined ? encodePackedDate(params.deadline) : null,
      area,
      project,
      heading,
      creationDate: born.creationDate,
      stopDate: born.stopDate,
    });
    if (params.tags !== undefined) setTaskTags(sim, uuid, params.tags);
    if (params.checklistItems !== undefined)
      replaceChecklist(sim, uuid, params.checklistItems, ctx);
  }),

  "todo.update": op<"todo.update">((sim, params, ctx) => applyEntityUpdate(sim, params, ctx)),

  "todo.complete": op<"todo.complete">((sim, params, ctx) => {
    // WG-7 flip-preserves-stopDate: a resolved→completed flip keeps the existing
    // stopDate (so a backdate leg's stamp survives); an open→completed flip stamps
    // the write clock.
    setStatus(sim, params.uuid, STATUS.completed, flipStopDate(sim, params.uuid, ctx), ctx);
    // RSIM4: completing an after-completion instance schedules the next
    // occurrence on its template without materializing it.
    stampAfterCompletionTemplate(sim, params.uuid, ctx);
  }),
  "todo.cancel": op<"todo.cancel">((sim, params, ctx) =>
    // WG-7 flip-preserves-stopDate (the flip-dance's closing leg must not clobber
    // the backdated stopDate set-dates wrote).
    setStatus(sim, params.uuid, STATUS.canceled, flipStopDate(sim, params.uuid, ctx), ctx),
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
    if (params.loose === true) {
      sim
        .prepare(
          "UPDATE TMTask SET project = NULL, area = NULL, heading = NULL, userModificationDate = ? WHERE uuid = ?",
        )
        .run(ctx.nowEpoch, params.uuid);
      return;
    }
    if (params.noHeading === true) {
      // Leave the heading, keep the current project (unheaded block). Resolve
      // the current project (direct, or via the heading) then re-assert it.
      const row = sim
        .prepare("SELECT project, heading FROM TMTask WHERE uuid = ?")
        .get(params.uuid) as { project: string | null; heading: string | null } | undefined;
      const current =
        row?.project ??
        (row?.heading != null
          ? ((
              sim.prepare("SELECT project FROM TMTask WHERE uuid = ?").get(row.heading) as
                | { project: string | null }
                | undefined
            )?.project ?? null)
          : null);
      sim
        .prepare(
          "UPDATE TMTask SET heading = NULL, project = ?, area = NULL, userModificationDate = ? WHERE uuid = ?",
        )
        .run(current, ctx.nowEpoch, params.uuid);
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
    // Born-resolved project (--completed-at, B-PROJ-JSON): lands completed in the
    // Logbook. The command refuses a completedAt project carrying OPEN child specs
    // (§5b), and this applier omits seed children anyway — so nothing strands.
    const born = bornTimestamps(params, ctx);
    const s = born.completed
      ? { start: START.active, startDate: null, startBucket: 0 }
      : scheduleColumns(params.when, ctx.todayIso, area !== null);
    const uuid = genUuid();
    insertTask(sim, 1, ctx, {
      uuid,
      title: params.title,
      notes: params.notes ?? "",
      status: born.completed ? "completed" : "open",
      start: s.start,
      startDate: s.startDate,
      startBucket: s.startBucket,
      deadline: params.deadline !== undefined ? encodePackedDate(params.deadline) : null,
      area,
      creationDate: born.creationDate,
      stopDate: born.stopDate,
    });
    // Structured `items` (the clone / rich-import path): headings + children born
    // OPEN in project `index` order, positional heading inheritance (A4). The
    // flat `todos` seed list is not asserted by the delta and stays omitted.
    if (params.items !== undefined) {
      let currentHeading: string | null = null;
      for (const it of params.items) {
        if (it.kind === "heading") {
          currentHeading = genUuid();
          insertTask(sim, 2, ctx, { uuid: currentHeading, title: it.title, project: uuid });
          continue;
        }
        const childUuid = genUuid();
        const cs = scheduleColumns(it.when, ctx.todayIso, true);
        insertTask(sim, 0, ctx, {
          uuid: childUuid,
          title: it.title,
          notes: it.notes ?? "",
          start: cs.start,
          startDate: cs.startDate,
          startBucket: cs.startBucket,
          deadline: it.deadline !== undefined ? encodePackedDate(it.deadline) : null,
          // A child reached via a heading has project NULL (DB invariant); a root
          // child sits directly under the project.
          project: currentHeading === null ? uuid : null,
          heading: currentHeading,
        });
        if (it.tags !== undefined) setTaskTags(sim, childUuid, it.tags);
        if (it.checklistItems !== undefined)
          replaceChecklist(sim, childUuid, it.checklistItems, ctx);
      }
    }
  }),

  "project.update": op<"project.update">((sim, params, ctx) => applyEntityUpdate(sim, params, ctx)),

  "project.complete": op<"project.complete">((sim, params, ctx) => {
    // Cascade open children to completed; canceled children are untouched (T08).
    // RSIM-P P2: completion also flips the containing HEADING rows (type=2)
    // status 0→3, not just the to-dos (type=0).
    const children = sim
      .prepare(
        `SELECT uuid FROM TMTask WHERE trashed = 0 AND status = 0
         AND (
           (type = 0 AND (project = ? OR heading IN (SELECT uuid FROM TMTask WHERE type = 2 AND project = ?)))
           OR (type = 2 AND project = ?)
         )`,
      )
      .all(params.uuid, params.uuid, params.uuid) as { uuid: string }[];
    for (const c of children) setStatus(sim, c.uuid, STATUS.completed, ctx.nowEpoch, ctx);
    // WG-7 flip-preserves-stopDate for the project's own row (idempotent re-resolve).
    setStatus(sim, params.uuid, STATUS.completed, flipStopDate(sim, params.uuid, ctx), ctx);
    // RSIM-P P2: completing an INSTANCE project also promotes its own start 2→1
    // (observed only for instance projects — a plain project is left untouched).
    sim
      .prepare("UPDATE TMTask SET start = 1 WHERE uuid = ? AND rt1_repeatingTemplate IS NOT NULL")
      .run(params.uuid);
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

  "project.add-heading": op<"project.add-heading">((sim, params, ctx) => {
    const projUuid = containerUuid(sim, params.project, "project");
    if (projUuid === null) throw new Error("simulator: project.add-heading needs a project");
    insertTask(sim, 2, ctx, { uuid: genUuid(), title: params.title, project: projUuid });
  }),

  // Recurrence ops (RSIM1–6). project.add-repeating is delivered by the
  // runAddRepeatingProject orchestrator over project.add + project.make-repeating
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

  // Universal reorder (ORD-1 native-wire re-rank). The bounce-only scopes
  // (evening / anytime / projects / heading / area-someday / day) never dispatch
  // this op — they run when=/move legs the update/move appliers already model —
  // so this covers exactly the native index/todayIndex scopes (today / project /
  // area / inbox / someday / container-day / tomorrow).
  reorder: op<"reorder">((sim, params, ctx) => applyReorder(sim, params, ctx)),

  // Resolution-timestamp writes (BACKDT / WG-7). Kind-agnostic (one TMTask row).
  // Reached as the AS-backdate leg of complete/cancel/update --completed-at/
  // --created-at; the born-timestamped add path folds into *.add above.
  "todo.set-dates": op<"todo.set-dates">((sim, params, ctx) => applySetDates(sim, params, ctx)),
  "project.set-dates": op<"project.set-dates">((sim, params, ctx) =>
    applySetDates(sim, params, ctx),
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
      const tz = process.env["THINGS_TZ"];
      const ctx: ApplyCtx = {
        nowEpoch: Math.floor(when.getTime() / 1000),
        todayIso: localToday(when),
        zone: tz !== undefined && tz.trim() !== "" ? tz : undefined,
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
