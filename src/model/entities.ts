/**
 * Public entity types. Enum encodings per docs/atlas/schema-v26.md
 * (verified live against schema v26).
 */
import type { IsoDate, ReminderTime } from "./dates.ts";
import type { RepeatRule } from "./recurrence.ts";

export type TaskStatus = "open" | "canceled" | "completed"; // status 0 | 2 | 3
export type StartState = "inbox" | "active" | "someday"; // start 0 | 1 | 2
export type TodaySection = "today" | "evening"; // startBucket 0 | 1
export type TaskType = "to-do" | "project" | "heading"; // type 0 | 1 | 2

/** Lightweight reference to another entity. */
export interface Ref {
  uuid: string;
  title: string;
  /**
   * Set (and only ever `true`) when this ref points at a repeating-template
   * PROJECT — the blueprint row whose `rt1_recurrenceRule`/`repeater` is
   * non-null (probe-verified: the template's CHILDREN are plain rows, so the
   * fact lives on the parent project). Only container/project refs ever carry
   * it — area and heading refs never do — so a consumer reads its absence as
   * "not a template". It disambiguates the two identical-looking same-title
   * copies a project conversion leaves behind (the template blueprint vs. its
   * spawned instance; see RepeatingInfo). Omitted when false (never `false`).
   */
  isRepeatingTemplate?: true;
}

/**
 * A surfaced tag: its NAME only. Tag uuids are a fully internal implementation
 * detail (like checklist item ids) — names are app-enforced-unique (TAGW1-c),
 * so a name is a sufficient reference, and no surface emits or accepts a tag
 * uuid. Nested-tag context, where it matters, is conveyed by the tag listing's
 * `parent` field, not here on the pill.
 */
export interface TagRef {
  title: string;
}

export interface RepeatingInfo {
  /** This row is a repeating template (rt1_recurrenceRule / repeater present). Invisible in normal lists. */
  isTemplate: boolean;
  /** This row was generated from a template. */
  isInstance: boolean;
  templateUuid: string | null;
  /** Templates: the app-materialized next occurrence date (null for after-completion rules until spawned). */
  nextOccurrence?: IsoDate | null;
  /** Templates: instance creation paused in the app UI. */
  paused?: boolean;
  /**
   * Templates: whether the repeat deadlines its spawned instances ("Add
   * deadlines" was ticked in the repeat editor). The discriminator is the
   * template row's own `deadline` column — a non-null far-future sentinel
   * (4001-01-01) when deadlined, NULL when deadline-less. It is NOT derivable
   * from the recurrence rule alone: a deadlined ts=0 rule is byte-identical to
   * a deadline-less one. VM-probed 2026-07-12 (UI1, oddities §8a).
   */
  deadlined?: boolean;
  /** Templates, detail reads only: the decoded repeat rule (read-only; undecodable rules are omitted). */
  rule?: RepeatRule;
}

interface TaskCommon {
  uuid: string;
  title: string;
  notes: string;
  status: TaskStatus;
  /**
   * In the GUI's Logbook. Completion and logged are SEPARATE states: a
   * closed item stays checked in its original list until the app's
   * log-move sweep passes it (TMSettings.logInterval / manualLogDate).
   */
  logged: boolean;
  trashed: boolean;
  start: StartState;
  /** The "When" date (packed int in DB), null when unscheduled. */
  startDate: IsoDate | null;
  /**
   * Today-view section ("today" | "evening"), emitted ONLY for items actually
   * in Today under the evaluation clock: start=active, dated, and not
   * future-scheduled (overdue rows stay in Today). Anytime (undated) and
   * Upcoming (future startDate) rows carry a raw startBucket in the DB but are
   * NOT in Today, so the field is null (omitted) for them. Use
   * TodayView.evening for UI-faithful placement.
   */
  todaySection: TodaySection | null;
  deadline: IsoDate | null;
  /** Time-of-day reminder (`HH:mm`, 24h); requires a scheduled startDate. */
  reminder: ReminderTime | null;
  area: Ref | null;
  /** Direct tags only, by name — mirrors DB truth (inherited tags are computed; see inheritedTags). */
  tags: TagRef[];
  /**
   * Tags inherited from an ancestor project/area, by NAME — a plain list
   * parallel to {@link tags} (native UI tag filtering includes these — T18).
   * Populated on the detail/card reads (`todo show`, `project show`) as an
   * array (empty when there are none); the emit-time omit-empty transform (#163)
   * drops it from JSON when empty, and it is absent (undefined) on list rows,
   * which surface direct tags only. Never merged into {@link tags}.
   */
  inheritedTags?: TagRef[];
  repeating: RepeatingInfo;
  created: Date;
  modified: Date;
  stopped: Date | null;
}

export interface Todo extends TaskCommon {
  type: "to-do";
  project: Ref | null;
  /** When set, project is reached via the heading (DB invariant: project column is NULL). */
  heading: Ref | null;
  /**
   * Owning project resolved THROUGH the heading (`project` itself stays
   * null — DB truth). Computed opt-in: list views populate it so consumers
   * get the GUI's container label without a second lookup.
   */
  headingProject?: Ref;
  checklist?: ChecklistItem[];
  checklistItemsCount: number;
  openChecklistItemsCount: number;
}

export interface Project extends TaskCommon {
  type: "project";
  untrashedLeafActionsCount: number;
  openUntrashedLeafActionsCount: number;
}

export interface Heading {
  uuid: string;
  type: "heading";
  title: string;
  /** "completed" = archived (a canceled heading is stored as completed). */
  status: TaskStatus;
  /** The owning project. */
  project: Ref | null;
}

export interface Area {
  uuid: string;
  title: string;
  visible: boolean;
  tags: TagRef[];
}

/**
 * A tag in the `things tags` taxonomy listing. Uuid-free (an internal detail):
 * the tree is conveyed by `parent` — the parent tag's NAME (null for a root) —
 * so a consumer can reconstruct the hierarchy, and by indentation in the human
 * render. Names are globally unique (TAGW1-c), so the leaf name alone is a
 * usable tag reference.
 */
export interface Tag {
  title: string;
  shortcut: string | null;
  /** Parent tag's NAME, or null for a root tag. */
  parent: string | null;
}

/**
 * A checklist item as the API surfaces it: title + status only. The DB uuid
 * is deliberately omitted — it is regenerated on every checklist rewrite and
 * is never a valid mutation target (address items by title or 1-based
 * position; see docs/design/reference-resolution.md). `status` is open |
 * completed | canceled (canceled exists in real data); items have no
 * trashed/logged state — they live and move with their parent to-do.
 */
export interface ChecklistItem {
  title: string;
  status: TaskStatus;
}

export type AnyTask = Todo | Project | Heading;

/** Items grouped under one ISO date (Upcoming days, project "later" groups). */
export interface IsoDateGroup<T> {
  date: string;
  items: T[];
}

// Raw-value mapping tables (DB integer -> public union), used by mappers.
export const TASK_TYPE_FROM_DB: Record<number, TaskType> = {
  0: "to-do",
  1: "project",
  2: "heading",
};
export const TASK_STATUS_FROM_DB: Record<number, TaskStatus> = {
  0: "open",
  2: "canceled",
  3: "completed",
};
export const START_STATE_FROM_DB: Record<number, StartState> = {
  0: "inbox",
  1: "active",
  2: "someday",
};
export const TODAY_SECTION_FROM_DB: Record<number, TodaySection> = {
  0: "today",
  1: "evening",
};
