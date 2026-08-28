/**
 * Pure row → entity mappers. Rows are the explicit-column SELECTs defined by
 * the schema manifest; encodings per docs/atlas/schema-v26.md.
 */
import {
  START_STATE_FROM_DB,
  TASK_STATUS_FROM_DB,
  type ChecklistItem,
  type Heading,
  type Project,
  type Ref,
  type RepeatingInfo,
  type StartState,
  type TaskStatus,
  type Todo,
} from "./entities.ts";
import { decodeEpochReal, decodePackedDate, decodeReminderTime, type IsoDate } from "./dates.ts";
import { templateProjectionDay, type TemplateProjectionRow } from "./template-projection.ts";
import { reminderIsLive } from "../read/stage.ts";

/**
 * Raw TMTask row shape (subset per schema manifest) PLUS the aliased template
 * projection inputs ({@link TemplateProjectionRow}) every read query splices in
 * (queries.ts `fetchTaskRows`). The raw `rt1_nextInstanceStartDate` is
 * deliberately absent from this shape: a template's next occurrence is read
 * ONLY through {@link templateProjectionDay} (the app's cached day where the
 * template carries one, the derived day where it does not — the paused /
 * trashed / never-populated cohort every app version has, GV4 §2.1), never off
 * the raw column.
 */
export interface TaskRow extends TemplateProjectionRow {
  uuid: string;
  type: number;
  status: number;
  stopDate: number | null;
  trashed: number;
  title: string | null;
  notes: string | null;
  creationDate: number | null;
  userModificationDate: number | null;
  start: number | null;
  startDate: number | null;
  startBucket: number | null;
  reminderTime: number | null;
  deadline: number | null;
  /** Dismissed-deadline suppression marker (packed date) — gates the Today deadline arm. */
  deadlineSuppressionDate: number | null;
  index: number | null;
  todayIndex: number | null;
  area: string | null;
  /**
   * The row's EFFECTIVE area (queries.ts EFFECTIVE_AREA): its own `area`, else
   * its project's, else its heading's project's. Equals `area` for projects and
   * for area-direct to-dos; resolves the container's area for nested to-dos
   * (whose own `area` is NULL). Surfaced as the entity's `area` Ref.
   */
  effectiveArea: string | null;
  project: string | null;
  heading: string | null;
  untrashedLeafActionsCount: number | null;
  openUntrashedLeafActionsCount: number | null;
  checklistItemsCount: number | null;
  openChecklistItemsCount: number | null;
  rt1_repeatingTemplate: string | null;
  rt1_recurrenceRule: unknown;
  rt1_instanceCreationPaused: number | null;
  repeater: unknown;
}

export interface ChecklistRow {
  uuid: string;
  title: string | null;
  status: number;
  stopDate: number | null;
  index: number | null;
  task: string;
  creationDate: number | null;
  userModificationDate: number | null;
}

/** Resolves uuid -> Ref for area/project/heading/tag links; null-safe. */
export type RefResolver = (uuid: string | null) => Ref | null;

export class EnumDomainError extends RangeError {
  constructor(field: string, value: unknown, uuid: string) {
    super(
      `unexpected ${field}=${String(value)} on ${uuid} — out of the validated enum domain; ` +
        `possible schema drift (run \`things doctor\`)`,
    );
    this.name = "EnumDomainError";
  }
}

function mapStatus(row: { status: number; uuid: string }): TaskStatus {
  const status = TASK_STATUS_FROM_DB[row.status];
  if (!status) throw new EnumDomainError("status", row.status, row.uuid);
  return status;
}

function mapStart(row: { start: number | null; uuid: string }): StartState {
  const start = START_STATE_FROM_DB[row.start ?? 0];
  if (!start) throw new EnumDomainError("start", row.start, row.uuid);
  return start;
}

/** A packed day column as an ISO date, or null when it is absent or undecodable. */
function packedDayOrNull(value: number | null): IsoDate | null {
  try {
    return decodePackedDate(value);
  } catch {
    return null;
  }
}

function mapRepeating(row: TaskRow): RepeatingInfo {
  const isTemplate = row.rt1_recurrenceRule !== null || row.repeater !== null;
  const templateUuid = row.rt1_repeatingTemplate;
  const info: RepeatingInfo = { isTemplate, isInstance: templateUuid !== null, templateUuid };
  if (isTemplate) {
    // The projection day — the app's own cache while it maintains it (Things
    // ≤ 3.22), else derived from the rule + spawn cursor (3.23 retired the
    // cache). Null when the series projects nowhere: paused, after-completion
    // between instances, ended, or underivable. Never a guessed date.
    info.nextOccurrence = decodePackedDate(templateProjectionDay(row));
    // The RAW spawn cursor beside the projection — the write engine's second
    // read-back column for a series re-anchor (REANCH1 §8). Fails CLOSED to null
    // on an out-of-domain packed value, exactly as templateProjectionDay does:
    // this is a verification input, and a throwing read would turn a corrupt
    // column into an unreadable row.
    info.spawnCursor = packedDayOrNull(row.tpCursor);
    info.paused = row.rt1_instanceCreationPaused === 1;
    // A deadlined template carries a far-future sentinel (4001-01-01) in its
    // own `deadline` column; a deadline-less one carries NULL. This — NOT the
    // recurrence rule — is what says whether spawned instances get a deadline
    // (a deadlined ts=0 rule is byte-identical to a deadline-less one). See
    // oddities §8a (UI1, 2026-07-12).
    info.deadlined = row.deadline !== null;
  }
  return info;
}

/**
 * The presence-keyed Today / This-Evening markers, derived with the Today view's
 * OWN two-arm membership (src/read/views.ts todayView) so a marked item always
 * agrees with the view: a SCHEDULED arm (a `startDate <= today` on a start=active
 * or start=someday row) OR a DEADLINE arm (an undated row whose deadline is
 * due/overdue and not dismissed — the `deadlineSuppressionDate` guard, oddities
 * §8e). Evening is the This-Evening sub-section (`startBucket=1` AND `startDate`
 * exactly today), and implies today. Repeating templates are never in Today
 * (the view excludes them), so they never mark. The closed-and-swept (logged)
 * gate is applied downstream at the emit boundary (which knows `stage`), since
 * the logbook boundary is not visible here.
 */
function todayMarkers(row: TaskRow, packedToday: number): { today?: true; evening?: true } {
  const isTemplate = row.rt1_recurrenceRule !== null || row.repeater !== null;
  if (isTemplate) return {};
  const start = row.start ?? 0;
  const scheduledArm =
    row.startDate !== null && row.startDate <= packedToday && (start === 1 || start === 2);
  const deadlineArm =
    row.startDate === null &&
    row.deadline !== null &&
    row.deadline <= packedToday &&
    (row.deadlineSuppressionDate === null || row.deadlineSuppressionDate < row.deadline);
  if (!scheduledArm && !deadlineArm) return {};
  const evening = row.startBucket === 1 && start === 1 && row.startDate === packedToday;
  return evening ? { today: true, evening: true } : { today: true };
}

function commonFields(row: TaskRow, refs: RefResolver, tags: Ref[], packedToday: number) {
  const startDate = decodePackedDate(row.startDate);
  // The RAW stored reminder byte — kept in `derived` verbatim (possibly stale)
  // for the write engine's pre-state/delta predictions (§9n: a stale byte is
  // revived by re-scheduling, so the raw value must survive on the substrate).
  const rawReminder = decodeReminderTime(row.reminderTime);
  // §9n: a reminder byte renders only while startDate is today-or-future — a
  // strictly-past startDate leaves the byte in the DB but presentation-dead. The
  // top-level `reminder` a consumer sees is the LIVE value only (null when
  // stale), live-gated here under the response clock (as todayMarkers gates
  // Today/Evening). decodePackedDate(packedToday) is today's ISO; reminderIsLive
  // keeps null-startDate reminders (defensive).
  const reminderLive =
    rawReminder !== null && reminderIsLive(startDate, decodePackedDate(packedToday) ?? "");
  const reminder = reminderLive ? rawReminder : null;
  return {
    uuid: row.uuid,
    title: row.title ?? "",
    notes: row.notes ?? "",
    status: mapStatus(row),
    startDate,
    // A template's own `deadline` column is not a real date: it is NULL
    // (deadline-less) or a far-future sentinel (4001-01-01, deadlined) that
    // flags whether spawned instances deadline. Surface it via
    // repeating.deadlined, never as a phantom deadline on the template row.
    deadline:
      row.rt1_recurrenceRule !== null || row.repeater !== null
        ? null
        : decodePackedDate(row.deadline),
    reminder,
    // The EFFECTIVE area: a to-do nested in a project (own `area` NULL) reports
    // its container's area, restoring useful area info omit-empty (#163) would
    // otherwise hide. Projects and area-direct to-dos are unaffected (effective
    // == direct). Direct-vs-inherited stays derivable from project/heading.
    area: refs(row.effectiveArea),
    // Surface tags by NAME only — tag uuids are an internal detail (TAGW1-c).
    tags: tags.map((t) => ({ title: t.title })),
    repeating: mapRepeating(row),
    created: decodeEpochReal(row.creationDate) ?? new Date(0),
    modified: decodeEpochReal(row.userModificationDate) ?? new Date(0),
    stopped: decodeEpochReal(row.stopDate),
    // The internal derivation substrate — never on the wire (DerivedSubstrate).
    derived: {
      ...todayMarkers(row, packedToday),
      // The RAW reminder byte (possibly stale) — the write engine's substrate.
      reminder: rawReminder,
      // Refined by markLogged (read layer): closed AND past the log-move
      // boundary. Defaulting to closed-implies-logged keeps paths that skip
      // the boundary (writes' result checks) on the old semantics.
      logged: mapStatus(row) !== "open",
      trashed: row.trashed === 1,
      start: mapStart(row),
    },
  };
}

export function mapTodo(row: TaskRow, refs: RefResolver, tags: Ref[], packedToday: number): Todo {
  return {
    ...commonFields(row, refs, tags, packedToday),
    type: "to-do",
    project: refs(row.project),
    heading: refs(row.heading),
    checklistItemsCount: row.checklistItemsCount ?? 0,
    openChecklistItemsCount: row.openChecklistItemsCount ?? 0,
  };
}

export function mapProject(
  row: TaskRow,
  refs: RefResolver,
  tags: Ref[],
  packedToday: number,
): Project {
  return {
    ...commonFields(row, refs, tags, packedToday),
    type: "project",
    untrashedLeafActionsCount: row.untrashedLeafActionsCount ?? 0,
    openUntrashedLeafActionsCount: row.openUntrashedLeafActionsCount ?? 0,
  };
}

export function mapHeading(row: TaskRow, refs: RefResolver): Heading {
  return {
    uuid: row.uuid,
    type: "heading",
    title: row.title ?? "",
    // Archived headings carry status "completed" (a canceled heading is
    // stored as completed too — oddity 6a). Needed by consumers AND by the
    // archive/unarchive result checks.
    status: mapStatus(row),
    // The archive timestamp — the read wire emits it as presence-keyed
    // `archived` on a heading GROUP node (status "completed" ⇒ archived).
    stopped: decodeEpochReal(row.stopDate),
    project: refs(row.project),
  };
}

export function mapChecklistItem(row: ChecklistRow): ChecklistItem {
  return {
    title: row.title ?? "",
    status: mapStatus(row),
  };
}
