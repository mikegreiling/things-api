/**
 * Pure row → entity mappers. Rows are the explicit-column SELECTs defined by
 * the schema manifest; encodings per docs/atlas/schema-v26.md.
 */
import {
  START_STATE_FROM_DB,
  TASK_STATUS_FROM_DB,
  TODAY_SECTION_FROM_DB,
  type ChecklistItem,
  type Heading,
  type Project,
  type Ref,
  type RepeatingInfo,
  type StartState,
  type TaskStatus,
  type Todo,
  type TodaySection,
} from "./entities.ts";
import { decodeEpochReal, decodePackedDate, decodeReminderTime } from "./dates.ts";

/** Raw TMTask row shape (subset per schema manifest). */
export interface TaskRow {
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
  index: number | null;
  todayIndex: number | null;
  area: string | null;
  project: string | null;
  heading: string | null;
  untrashedLeafActionsCount: number | null;
  openUntrashedLeafActionsCount: number | null;
  checklistItemsCount: number | null;
  openChecklistItemsCount: number | null;
  rt1_repeatingTemplate: string | null;
  rt1_recurrenceRule: unknown;
  rt1_nextInstanceStartDate: number | null;
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

function mapTodaySection(row: { startBucket: number | null; uuid: string }): TodaySection | null {
  if (row.startBucket === null) return null;
  const section = TODAY_SECTION_FROM_DB[row.startBucket];
  if (!section) throw new EnumDomainError("startBucket", row.startBucket, row.uuid);
  return section;
}

function mapRepeating(row: TaskRow): RepeatingInfo {
  const isTemplate = row.rt1_recurrenceRule !== null || row.repeater !== null;
  const templateUuid = row.rt1_repeatingTemplate;
  const info: RepeatingInfo = { isTemplate, isInstance: templateUuid !== null, templateUuid };
  if (isTemplate) {
    info.nextOccurrence = decodePackedDate(row.rt1_nextInstanceStartDate);
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

function commonFields(row: TaskRow, refs: RefResolver, tags: Ref[]) {
  return {
    uuid: row.uuid,
    title: row.title ?? "",
    notes: row.notes ?? "",
    status: mapStatus(row),
    // Refined by markLogged (read layer): closed AND past the log-move
    // boundary. Defaulting to closed-implies-logged keeps paths that skip
    // the boundary (writes' result checks) on the old semantics.
    logged: mapStatus(row) !== "open",
    trashed: row.trashed === 1,
    start: mapStart(row),
    startDate: decodePackedDate(row.startDate),
    todaySection: mapTodaySection(row),
    // A template's own `deadline` column is not a real date: it is NULL
    // (deadline-less) or a far-future sentinel (4001-01-01, deadlined) that
    // flags whether spawned instances deadline. Surface it via
    // repeating.deadlined, never as a phantom deadline on the template row.
    deadline:
      row.rt1_recurrenceRule !== null || row.repeater !== null
        ? null
        : decodePackedDate(row.deadline),
    reminder: decodeReminderTime(row.reminderTime),
    area: refs(row.area),
    // Surface tags by NAME only — tag uuids are an internal detail (TAGW1-c).
    tags: tags.map((t) => ({ title: t.title })),
    repeating: mapRepeating(row),
    created: decodeEpochReal(row.creationDate) ?? new Date(0),
    modified: decodeEpochReal(row.userModificationDate) ?? new Date(0),
    stopped: decodeEpochReal(row.stopDate),
  };
}

export function mapTodo(row: TaskRow, refs: RefResolver, tags: Ref[]): Todo {
  return {
    ...commonFields(row, refs, tags),
    type: "to-do",
    project: refs(row.project),
    heading: refs(row.heading),
    checklistItemsCount: row.checklistItemsCount ?? 0,
    openChecklistItemsCount: row.openChecklistItemsCount ?? 0,
  };
}

export function mapProject(row: TaskRow, refs: RefResolver, tags: Ref[]): Project {
  return {
    ...commonFields(row, refs, tags),
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
    project: refs(row.project),
  };
}

export function mapChecklistItem(row: ChecklistRow): ChecklistItem {
  return {
    title: row.title ?? "",
    status: mapStatus(row),
  };
}
