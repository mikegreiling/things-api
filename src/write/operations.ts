/**
 * Operation catalog: every mutation the write layer can express, plus the
 * typed parameter shapes. Vector support for each operation lives in the
 * per-vector matrices (data, produced by the lab), not here.
 */
import type { IsoDate, ReminderTime } from "../model/dates.ts";

export const OPERATION_KINDS = [
  "todo.add",
  "todo.update",
  "todo.complete",
  "todo.cancel",
  "todo.reopen",
  "todo.move",
  "todo.set-tags",
  "todo.replace-checklist",
  "todo.edit-checklist-item",
  "todo.delete",
  "project.add",
  "project.update",
  "project.complete",
  "project.delete",
  "area.add",
  "area.delete",
  "tag.add",
  "tag.delete",
  "trash.empty",
  "reorder",
  "todo.duplicate",
  "area.update",
  "tag.update",
  "project.move",
  "todo.restore",
  "project.duplicate",
  "project.cancel",
  "project.reopen",
  "project.restore",
  "project.set-tags",
  "todo.backdate",
  "todo.add-logged",
  "heading.rename",
  "heading.archive",
  "heading.unarchive",
  "heading.create",
  "todo.clear-dated-reminder",
  "todo.make-repeating",
  "todo.reschedule-repeat",
  "todo.pause-repeat",
  "todo.resume-repeat",
  "todo.convert-to-project",
  "heading.convert-to-project",
  "project.reschedule-repeat",
  "project.pause-repeat",
  "project.resume-repeat",
  "area.reorder-sidebar",
  "project.make-repeating",
  "project.create-repeating",
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];

/**
 * Operations delivered EXCLUSIVELY through the Accessibility GUI ("ui")
 * vector — GUI-only transforms with no headless spelling. Each drives the
 * local Things app, so all are two-key gated: the `ui.enabled` config plus a
 * per-call `dangerouslyDriveGui` acknowledgement (H-UI-DRIVE). Kept as data so
 * the guard and the pipeline agree on the set.
 */
export const UI_DRIVE_OPS: readonly OperationKind[] = [
  "todo.make-repeating",
  "todo.reschedule-repeat",
  "todo.pause-repeat",
  "todo.resume-repeat",
  "todo.convert-to-project",
  "heading.convert-to-project",
  "project.reschedule-repeat",
  "project.pause-repeat",
  "project.resume-repeat",
  "area.reorder-sidebar",
  // Pure-AX (UIC4): the project is selected as a content-table ROW via a
  // settable AXSelectedRows, then Items ▸ Repeat… drives the same dialog. The
  // area-less-anytime taxonomy needs a Someday coercion first, orchestrated by
  // runMakeRepeatingProject — but the drive itself is a ui-vector op.
  "project.make-repeating",
] as const;

export function isUiDriveOp(op: OperationKind): boolean {
  return UI_DRIVE_OPS.includes(op);
}

/** Recurrence frequency the minimal v1 GUI rule vocabulary supports. */
export type RepeatFrequency = "daily" | "weekly" | "monthly" | "yearly";

/** `when` scheduling value: list keyword or a concrete date. */
export type WhenValue = "today" | "evening" | "anytime" | "someday" | IsoDate;

/** Container reference by uuid or (unique, case-insensitive) title. */
export interface ContainerRef {
  uuid?: string;
  title?: string;
}

export interface TodoAddParams {
  title: string;
  notes?: string;
  when?: WhenValue;
  /**
   * Time-of-day reminder, `HH:mm` 24h. Requires a schedulable `when`
   * (today, evening, or a date) in the same call.
   */
  reminder?: ReminderTime;
  deadline?: IsoDate;
  tags?: string[];
  checklistItems?: string[];
  project?: ContainerRef;
  area?: ContainerRef;
  /** Existing heading inside the target project (placement only). */
  heading?: string;
}

export interface TodoUpdateParams {
  uuid: string;
  title?: string;
  notes?: string;
  /** Append to the existing notes (newline-joined). Exclusive with notes/prependNotes. */
  appendNotes?: string;
  /** Prepend to the existing notes (newline-joined). Exclusive with notes/appendNotes. */
  prependNotes?: string;
  when?: WhenValue;
  /**
   * `HH:mm` sets a reminder (requires when: today|evening in the same call);
   * null clears it (today/evening only — a dated reminder can only be
   * changed, not cleared). When re-scheduling with this OMITTED, an existing
   * reminder is auto-preserved.
   */
  reminder?: ReminderTime | null;
  deadline?: IsoDate | null;
}

export interface UuidParams {
  uuid: string;
}

export interface HeadingCreateParams {
  /** Existing project to create the heading in (uuid or unique, case-insensitive title). */
  project: ContainerRef;
  title: string;
}

export interface HeadingRenameParams {
  uuid: string;
  title: string;
}

export interface HeadingArchiveParams {
  uuid: string;
  /**
   * What happens to the heading's OPEN children (required when any exist):
   * - "complete": the archive cascade completes them (app behavior);
   * - "cancel":   the app's cancel-cascade marks them canceled (the heading
   *               itself still stores as completed — the app has no canceled
   *               heading state);
   * - "reparent": children move to the project root first (each a verified
   *               mutation), then the empty heading is archived.
   * Children already completed/canceled are never touched.
   */
  children?: "complete" | "cancel" | "reparent";
}

export interface HeadingUnarchiveParams {
  uuid: string;
  /**
   * Also reopen children the archive cascade resolved (identified by the
   * <2s stopDate window; someday state survives the round-trip). Children
   * resolved at other times are never touched.
   */
  restoreChildren?: boolean;
}

export interface TodoBackdateParams {
  uuid: string;
  /**
   * Rewrite the completion timestamp to noon (local) on this date. The
   * to-do must already be completed or canceled.
   */
  completionDate?: IsoDate;
  /** Rewrite the creation timestamp to noon (local) on this date. */
  creationDate?: IsoDate;
}

export interface TodoAddLoggedParams {
  title: string;
  notes?: string;
  /** The completion timestamp the created row carries (logged in the past). */
  completionDate: IsoDate;
  /** Optional backdated creation timestamp (must be <= completionDate). */
  creationDate?: IsoDate;
}

export interface TodoMoveParams {
  uuid: string;
  project?: ContainerRef;
  area?: ContainerRef;
  /** Existing heading inside the destination project. */
  heading?: string;
  /** Move back to the Inbox — removes any schedule. Exclusive with the others. */
  inbox?: boolean;
  /**
   * Detach from the current project/area/heading, keeping the schedule and
   * everything else. Exclusive with the others.
   */
  detach?: boolean;
}

export interface TodoSetTagsParams {
  uuid: string;
  /** Full replacement set (an empty list clears all tags). */
  tags: string[];
}

/** One checklist item in a stateful replacement. */
export interface ChecklistItemSpec {
  title: string;
  /** Recreate the item pre-checked. */
  completed?: boolean;
}

export interface TodoReplaceChecklistParams {
  uuid: string;
  /**
   * Full replacement list. Plain strings recreate items unchecked; object
   * entries can recreate items pre-checked. Item uuids are NOT stable
   * across a rewrite.
   */
  items: (string | ChecklistItemSpec)[];
}

/** One granular checklist action (audited as INTENT, not a full snapshot). */
export type ChecklistItemAction = "add" | "remove" | "check" | "uncheck" | "rename" | "move";

/**
 * ONE granular checklist edit. Delivered as a full `todo.replace-checklist`
 * rewrite (the only surface Things offers) but audited as the intent + the
 * targeted item's pre-state, so undo can apply a TARGETED inverse against the
 * current list instead of clobbering it. Orchestrated by `runEditChecklist`;
 * never dispatched directly through the pipeline (no atomic surface exists).
 */
export interface TodoEditChecklistItemParams {
  uuid: string;
  action: ChecklistItemAction;
  /** Targeted item title (add: the new item's title). */
  title?: string;
  /** 1-based target index; exact, overrides `title`. */
  index?: number;
  /** add: 1-based insert position (default: append). */
  at?: number;
  /** move: 1-based destination position. */
  to?: number;
  /** rename: the new title. */
  newTitle?: string;
}

export interface ProjectAddParams {
  title: string;
  notes?: string;
  area?: ContainerRef;
  when?: WhenValue;
  deadline?: IsoDate;
  todos?: string[];
}

export interface ProjectUpdateParams {
  uuid: string;
  title?: string;
  notes?: string;
  /** Append to the existing notes (newline-joined). Exclusive with notes/prependNotes. */
  appendNotes?: string;
  /** Prepend to the existing notes (newline-joined). Exclusive with notes/appendNotes. */
  prependNotes?: string;
  when?: WhenValue;
  /**
   * `HH:mm` sets a reminder (requires when: today|evening|YYYY-MM-DD in the
   * same call); null clears it (today/evening only — a dated reminder can
   * only be changed, not cleared). Same semantics as to-do reminders.
   */
  reminder?: ReminderTime | null;
  deadline?: IsoDate | null;
}

export interface ProjectSetTagsParams {
  uuid: string;
  /** Full replacement set (an empty list clears all tags). */
  tags: string[];
}

export interface ProjectMoveParams {
  uuid: string;
  /** Destination area (uuid or unique name). */
  area?: ContainerRef;
  /** Detach from the current area. Exclusive with area. */
  detach?: boolean;
}

export interface ProjectCompleteParams {
  uuid: string;
  /**
   * Open-children policy — REQUIRED, no default: completing a project also
   * completes its open children.
   */
  children: "require-resolved" | "auto-complete";
}

export interface ProjectCancelParams {
  uuid: string;
  /**
   * Open-children policy — REQUIRED, no default: canceling a project also
   * cancels its open children; completed children are untouched.
   */
  children: "require-resolved" | "auto-cancel";
}

export interface AreaAddParams {
  title: string;
  tags?: string[];
}

export interface TagAddParams {
  title: string;
  /** Existing parent tag title to nest under. */
  parent?: string;
}

export interface NameOrUuidParams {
  /** uuid or unique case-insensitive title. */
  target: string;
}

export interface AreaUpdateParams {
  /** uuid or unique case-insensitive title. */
  target: string;
  title?: string;
  /** Full replacement set of EXISTING tag titles. */
  tags?: string[];
}

export interface TagUpdateParams {
  /** uuid or unique case-insensitive title. */
  target: string;
  title?: string;
  /** Existing tag to nest under. Exclusive with unnest. */
  parent?: string;
  /** Un-nest the tag to the root of the hierarchy. Exclusive with parent. */
  unnest?: boolean;
  /** Single character to bind. Exclusive with clearShortcut. */
  shortcut?: string;
  /** Remove the tag's keyboard shortcut. Exclusive with shortcut. */
  clearShortcut?: boolean;
}

export type ReorderScope =
  | "today"
  | "evening"
  | "project"
  | "area"
  | "inbox"
  | "headings"
  | "someday"
  | "projects";
export type ReorderStrategy = "native" | "bounce";

export interface ReorderParams {
  scope: ReorderScope;
  /**
   * Required for project/area/headings scopes (headings: the project whose
   * heading rows are being reordered); must be omitted for
   * today/evening/inbox/someday/projects.
   */
  container?: ContainerRef;
  /**
   * Desired order, top-first. May be a SUBSET of the scope's members: the
   * requested uuids are placed at the top in this order and every remaining
   * member keeps its current relative order below them.
   */
  uuids: string[];
  /**
   * Omit for the default per scope: native for today/project/area/inbox/
   * headings/someday (requires allowExperimental), bounce for evening and
   * projects. Today accepts an explicit "bounce" fallback; evening is
   * bounce-only; "projects" (top-level sidebar order) is bounce-only — each
   * project takes a when=someday -> when=anytime round-trip, which
   * front-inserts it (P8e).
   */
  strategy?: ReorderStrategy;
}

export type EmptyParams = Record<string, never>;

/**
 * Move an area to a new position in the sidebar. Sidebar area order has no
 * headless spelling at all (P6/O13) — this is delivered by the ui vector's
 * drag driver. Exactly ONE of before / after / position is required.
 */
export interface AreaReorderSidebarParams {
  /** The area to move: uuid or unique case-insensitive title. */
  target: string;
  /** Place it immediately ABOVE this area (uuid or unique title). */
  before?: string;
  /** Place it immediately BELOW this area (uuid or unique title). */
  after?: string;
  /** Move it to the first or last area slot. Exclusive with before/after. */
  position?: "first" | "last";
}

/** Weekday name (weekly day-of-week set; monthly/yearly nth-weekday anchor). */
export type Weekday =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";

export const WEEKDAYS: readonly Weekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** The ordinal a monthly/yearly nth-weekday anchor selects (1st..5th, or last). */
export type WeekdayOrdinal = 1 | 2 | 3 | 4 | 5 | "last";

/**
 * A monthly (or yearly) day anchor — the mutually-exclusive forms the Repeat
 * dialog's month row offers (UIC1 field map). Exactly one shape:
 *  - `{ day }`     — a day-of-month (1..31, or "last" = the month's last day);
 *  - `{ weekday, ordinal }` — the nth (or last) weekday of the month.
 */
export type MonthlyAnchor =
  | { day: number | "last" }
  | { weekday: Weekday; ordinal: WeekdayOrdinal };

/** A yearly anchor: a month (1..12) plus the monthly-style day anchor. */
export type YearlyAnchor = { month: number } & MonthlyAnchor;

/**
 * The Repeat dialog's "Ends" bound (single-choice pop-up, UIC1). Omit for the
 * dialog default (`never`). `on-date` is the date picker; `after` the count
 * field (the ORIGINAL number of occurrences, not the remaining tally).
 */
export type RepeatEnds =
  | { kind: "never" }
  | { kind: "on-date"; date: IsoDate }
  | { kind: "after"; count: number };

/**
 * Set (make-repeating) or edit (reschedule-repeat) a to-do's or project's
 * recurrence rule through the GUI's Repeat dialog. The BASE vocabulary is
 * `frequency` + `interval`; every other field is OPTIONAL and defaults to the
 * dialog's own default, so a `{ uuid, frequency, interval }` call is unchanged.
 *
 * The optional fields cover the full UIC1 dialog field map. Combinations are
 * validated (assertRepeatRule): a per-frequency field on the wrong frequency is
 * refused, and the modal month anchor is a discriminated shape (day-of-month OR
 * nth-weekday, never a contradictory bag).
 */
export interface RepeatRuleParams {
  uuid: string;
  /** The recurrence unit (also the "after completion" cadence when afterCompletion). */
  frequency: RepeatFrequency;
  /** "every N units", 1–99. */
  interval: number;
  /**
   * After-COMPLETION cadence instead of a fixed schedule (rule type tp=1): the
   * next occurrence is N units after the prior instance RESOLVES. Mutually
   * exclusive with the calendar anchors (weekdays/monthly/yearly) — an
   * after-completion rule has no calendar day.
   */
  afterCompletion?: boolean;
  /**
   * WEEKLY only: the set of weekdays the rule fires on (dialog day-of-week
   * toggles + "+"). Omit for the single anchor weekday the dialog defaults to.
   */
  weekdays?: Weekday[];
  /** MONTHLY only: the day-of-month or nth-weekday anchor (dialog month row). */
  monthly?: MonthlyAnchor;
  /** YEARLY only: the month + day anchor (dialog year row). */
  yearly?: YearlyAnchor;
  /** The "Ends" bound (dialog default: never). */
  ends?: RepeatEnds;
  /** "Add reminders" time-of-day (`HH:mm`, 24h) on the spawned instances. */
  reminder?: ReminderTime;
  /** "Add deadlines": the template deadlines its instances. */
  deadline?: boolean;
  /**
   * With deadline: start the instance N days BEFORE its deadline (the dialog's
   * "start N days earlier" field, revealed by "Add deadlines"). Integer ≥ 0;
   * implies `deadline` (a start offset only exists on a deadlined template).
   */
  startDaysEarlier?: number;
}

/**
 * Create a project and, in the same call, promote it to a repeating series
 * (the two-step composite of UIC4-f). The create seeds a pure-AX taxonomy —
 * an `area` lands the project as a selectable AREA-view row; otherwise it is
 * created in Someday — so the promote never needs a coercion. The two legs are
 * NOT atomic: the created project persists even if the promote refuses.
 */
export interface ProjectCreateRepeatingParams {
  title: string;
  notes?: string;
  /** Destination area (uuid or unique name); when omitted the project is created in Someday. */
  area?: ContainerRef;
  deadline?: IsoDate;
  todos?: string[];
  frequency: RepeatFrequency;
  /** "every N units", 1–99. */
  interval: number;
}

export interface OperationParamsMap {
  "todo.add": TodoAddParams;
  "todo.update": TodoUpdateParams;
  "todo.complete": UuidParams;
  "todo.cancel": UuidParams;
  "todo.reopen": UuidParams;
  "todo.move": TodoMoveParams;
  "todo.set-tags": TodoSetTagsParams;
  "todo.replace-checklist": TodoReplaceChecklistParams;
  "todo.edit-checklist-item": TodoEditChecklistItemParams;
  "todo.delete": UuidParams;
  "project.add": ProjectAddParams;
  "project.update": ProjectUpdateParams;
  "project.complete": ProjectCompleteParams;
  "project.delete": UuidParams;
  "area.add": AreaAddParams;
  "area.delete": NameOrUuidParams;
  "tag.add": TagAddParams;
  "tag.delete": NameOrUuidParams;
  "trash.empty": EmptyParams;
  reorder: ReorderParams;
  "todo.duplicate": UuidParams;
  "area.update": AreaUpdateParams;
  "tag.update": TagUpdateParams;
  "project.move": ProjectMoveParams;
  "todo.restore": UuidParams;
  "project.duplicate": UuidParams;
  "project.cancel": ProjectCancelParams;
  "project.reopen": UuidParams;
  "project.restore": UuidParams;
  "project.set-tags": ProjectSetTagsParams;
  "todo.backdate": TodoBackdateParams;
  "todo.add-logged": TodoAddLoggedParams;
  "heading.rename": HeadingRenameParams;
  "heading.archive": HeadingArchiveParams;
  "heading.unarchive": HeadingUnarchiveParams;
  "heading.create": HeadingCreateParams;
  "todo.clear-dated-reminder": UuidParams;
  "todo.make-repeating": RepeatRuleParams;
  "todo.reschedule-repeat": RepeatRuleParams;
  "todo.pause-repeat": UuidParams;
  "todo.resume-repeat": UuidParams;
  "todo.convert-to-project": UuidParams;
  "heading.convert-to-project": UuidParams;
  "project.reschedule-repeat": RepeatRuleParams;
  "project.pause-repeat": UuidParams;
  "project.resume-repeat": UuidParams;
  "area.reorder-sidebar": AreaReorderSidebarParams;
  "project.make-repeating": RepeatRuleParams;
  "project.create-repeating": ProjectCreateRepeatingParams;
}

/** Explicit confirmations for operations with cascading or permanent effects (never defaulted). */
export interface Acknowledgements {
  /** Confirm a wholesale checklist replacement that discards existing items and their checked states. */
  acknowledgeChecklistReset?: boolean;
  /** Confirm adding/moving an open item into a completed/canceled project (this reopens the project). */
  acknowledgeProjectReopen?: boolean;
  /** Confirm a permanent deletion: area/tag delete and empty-trash skip the Trash entirely. */
  dangerouslyPermanent?: boolean;
  /** Confirm that deleting a parent tag permanently deletes ALL of its descendant tags. */
  acknowledgeTagSubtree?: boolean;
  /**
   * Confirm a GUI-driven ("ui" vector) operation: it drives the LOCAL Things
   * app through the Accessibility API, may foreground Things and briefly take
   * over UI focus on this machine, and requires an unlocked session. The
   * second of the two keys (the first is the `ui.enabled` config).
   */
  dangerouslyDriveGui?: boolean;
}
