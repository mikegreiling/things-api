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
  /** Templates, detail reads only: the decoded repeat rule (read-only; undecodable rules are omitted). */
  rule?: RepeatRule;
}

interface TaskCommon {
  uuid: string;
  title: string;
  notes: string;
  status: TaskStatus;
  trashed: boolean;
  start: StartState;
  /** The "When" date (packed int in DB), null when unscheduled. */
  startDate: IsoDate | null;
  /**
   * Raw This-Evening assignment (startBucket). Effective only while
   * startDate == today — the UI rolls stale evening items back into Today
   * proper. Use TodayView.evening for UI-faithful placement.
   */
  todaySection: TodaySection | null;
  deadline: IsoDate | null;
  /** Time-of-day reminder (`HH:mm`, 24h); requires a scheduled startDate. */
  reminder: ReminderTime | null;
  area: Ref | null;
  /** Direct tags only — mirrors DB truth (inherited tags are computed; see inheritedTags). */
  tags: Ref[];
  /** Opt-in: tags inherited from ancestor area/project (native UI filtering includes these). */
  inheritedTags?: Ref[];
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
  /** The owning project. */
  project: Ref | null;
}

export interface Area {
  uuid: string;
  title: string;
  visible: boolean;
  tags: Ref[];
}

export interface Tag {
  uuid: string;
  title: string;
  shortcut: string | null;
  parent: Ref | null;
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
