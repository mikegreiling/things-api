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
   * Time-of-day reminder, `HH:mm` 24h. Requires when: today|evening (the
   * only probed combinations, R01–R16); compiled through the deterministic
   * URL emitter (the app's bare-hour parser is a trap — oddity 2d).
   */
  reminder?: ReminderTime;
  deadline?: IsoDate;
  tags?: string[];
  checklistItems?: string[];
  project?: ContainerRef;
  area?: ContainerRef;
  /** Existing heading inside the target project (placement-only; U09). */
  heading?: string;
}

export interface TodoUpdateParams {
  uuid: string;
  title?: string;
  notes?: string;
  /** Append to the existing notes (newline-joined; E04/E11). Exclusive with notes/prependNotes. */
  appendNotes?: string;
  /** Prepend to the existing notes (newline-joined; E05/E12). Exclusive with notes/appendNotes. */
  prependNotes?: string;
  when?: WhenValue;
  /**
   * `HH:mm` sets a reminder (requires when: today|evening in the same call);
   * null clears it. When `when` is today/evening and this is OMITTED, an
   * existing reminder is auto-preserved — a bare when= would silently clear
   * it (R07).
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
  /** Move back to the Inbox (de-schedules; E06). Exclusive with the others. */
  inbox?: boolean;
  /**
   * Detach from the current project/area/heading, keeping schedule and
   * everything else (URL `list-id=` empty, P21/P22). Exclusive with the others.
   */
  detach?: boolean;
}

export interface TodoSetTagsParams {
  uuid: string;
  /** Full replacement set (validated semantics, U04). */
  tags: string[];
}

/** One checklist item in a stateful replacement (P18: json carries states). */
export interface ChecklistItemSpec {
  title: string;
  /** Recreate the item pre-checked (json vector only). */
  completed?: boolean;
}

export interface TodoReplaceChecklistParams {
  uuid: string;
  /**
   * Full replacement list. Plain strings ride the classic `checklist-items=`
   * URL param (all items recreated OPEN — T07); any object entry switches to
   * the `things:///json` form, which applies per-item completed states (P18).
   * Item uuids are NOT stable across a rewrite either way.
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
  /** Append to the existing notes (newline-joined; E18). Exclusive with notes/prependNotes. */
  appendNotes?: string;
  /** Prepend to the existing notes (newline-joined; E18). Exclusive with notes/appendNotes. */
  prependNotes?: string;
  when?: WhenValue;
  deadline?: IsoDate | null;
}

export interface ProjectMoveParams {
  uuid: string;
  /** Destination area (uuid or unique name). E14 (AppleScript) / P23 (URL). */
  area?: ContainerRef;
  /** Detach from the current area (URL `area-id=` empty, P24). Exclusive with area. */
  detach?: boolean;
}

export interface ProjectCompleteParams {
  uuid: string;
  /**
   * Open-children policy — REQUIRED, no default (T08/U08: URL completion
   * silently auto-completes open children, unlike the UI prompt).
   */
  children: "require-resolved" | "auto-complete";
}

export interface ProjectCancelParams {
  uuid: string;
  /**
   * Open-children policy — REQUIRED, no default (P01: URL cancellation
   * silently auto-cancels open children; completed children are untouched).
   */
  children: "require-resolved" | "auto-cancel";
}

export interface AreaAddParams {
  title: string;
  tags?: string[];
}

export interface TagAddParams {
  title: string;
  /** Existing parent tag title (hierarchy; A05). */
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
  /** Existing tag to nest under (un-nesting to root is unprobed — not offered). */
  parent?: string;
  /** Single character (clearing to none is unprobed — not offered). */
  shortcut?: string;
}

export type ReorderScope = "today" | "evening" | "project" | "area";
export type ReorderStrategy = "native" | "bounce";

export interface ReorderParams {
  scope: ReorderScope;
  /** Required for project/area scopes; must be omitted for today/evening. */
  container?: ContainerRef;
  /**
   * Desired order, top-first. May be a SUBSET of the scope's members: the
   * requested uuids are placed at the top in this order and every remaining
   * member keeps its current relative order below them (the wire list sent
   * to the app is always the full member list — O01 proved partial sends
   * work but leave placement underdetermined).
   */
  uuids: string[];
  /**
   * Omit for the default per scope: native for today/project/area (requires
   * allowExperimental + the sdef canary), bounce for evening. Today accepts
   * an explicit "bounce" fallback; project/area are native-only; evening is
   * bounce-only (O03: native reorder silently de-evenings bucket-1 members).
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
}

/** Explicit acknowledgements for guarded operations (never defaulted). */
export interface Acknowledgements {
  /** H-CHECKLIST-REPLACE: checklist replacement destroys per-item state (T07). */
  acknowledgeChecklistReset?: boolean;
  /** H-REOPEN-RESOLVED-PROJECT: adding an open child reopens a resolved project (T19). */
  acknowledgeProjectReopen?: boolean;
  /** H-PERMANENT-DELETE: area/tag delete and empty-trash skip the Trash entirely. */
  dangerouslyPermanent?: boolean;
  /** H-TAG-SUBTREE-DELETE: deleting a parent tag cascade-deletes its children (P16). */
  acknowledgeTagSubtree?: boolean;
}
