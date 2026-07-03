/**
 * Operation catalog: every mutation the write layer can express, plus the
 * typed parameter shapes. Vector support for each operation lives in the
 * per-vector matrices (data, produced by the lab), not here.
 */
import type { IsoDate } from "../model/dates.ts";

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
  when?: WhenValue;
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
}

export interface TodoSetTagsParams {
  uuid: string;
  /** Full replacement set (validated semantics, U04). */
  tags: string[];
}

export interface TodoReplaceChecklistParams {
  uuid: string;
  items: string[];
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
  when?: WhenValue;
  deadline?: IsoDate | null;
}

export interface ProjectCompleteParams {
  uuid: string;
  /**
   * Open-children policy — REQUIRED, no default (T08/U08: URL completion
   * silently auto-completes open children, unlike the UI prompt).
   */
  children: "require-resolved" | "auto-complete";
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
}

/** Explicit acknowledgements for guarded operations (never defaulted). */
export interface Acknowledgements {
  /** H-CHECKLIST-REPLACE: checklist replacement destroys per-item state (T07). */
  acknowledgeChecklistReset?: boolean;
  /** H-REOPEN-RESOLVED-PROJECT: adding an open child reopens a resolved project (T19). */
  acknowledgeProjectReopen?: boolean;
  /** H-PERMANENT-DELETE: area/tag delete and empty-trash skip the Trash entirely. */
  dangerouslyPermanent?: boolean;
}
