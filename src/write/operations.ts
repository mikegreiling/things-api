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
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];

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

export type ReorderScope = "today" | "evening" | "project" | "area" | "inbox";
export type ReorderStrategy = "native" | "bounce";

export interface ReorderParams {
  scope: ReorderScope;
  /** Required for project/area scopes; must be omitted for today/evening/inbox. */
  container?: ContainerRef;
  /**
   * Desired order, top-first. May be a SUBSET of the scope's members: the
   * requested uuids are placed at the top in this order and every remaining
   * member keeps its current relative order below them.
   */
  uuids: string[];
  /**
   * Omit for the default per scope: native for today/project/area (requires
   * allowExperimental), bounce for evening. Today accepts an explicit
   * "bounce" fallback; project/area are native-only; evening is bounce-only.
   */
  strategy?: ReorderStrategy;
}

export type EmptyParams = Record<string, never>;

export interface OperationParamsMap {
  "todo.add": TodoAddParams;
  "todo.update": TodoUpdateParams;
  "todo.complete": UuidParams;
  "todo.cancel": UuidParams;
  "todo.reopen": UuidParams;
  "todo.move": TodoMoveParams;
  "todo.set-tags": TodoSetTagsParams;
  "todo.replace-checklist": TodoReplaceChecklistParams;
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
}
