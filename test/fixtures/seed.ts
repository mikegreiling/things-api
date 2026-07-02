/**
 * Typed seed builders for fixture databases. Encodings mirror the atlas:
 * packed dates via the real codec, epoch REAL timestamps, correct enum ints.
 */
import type { DatabaseSync } from "node:sqlite";

import { encodePackedDate } from "../../src/model/dates.ts";

let seq = 0;
const uid = (prefix: string) => `${prefix}-${(++seq).toString().padStart(4, "0")}`;

const STATUS = { open: 0, canceled: 2, completed: 3 } as const;
const START = { inbox: 0, active: 1, someday: 2 } as const;

export interface SeedTaskOpts {
  uuid?: string;
  title?: string;
  notes?: string;
  status?: keyof typeof STATUS;
  start?: keyof typeof START;
  /** ISO date; encoded to the packed int. */
  startDate?: string | null;
  evening?: boolean;
  deadline?: string | null;
  trashed?: boolean;
  index?: number;
  todayIndex?: number;
  area?: string | null;
  project?: string | null;
  heading?: string | null;
  stopDate?: number | null;
  /** Marks the row as a repeating template. */
  recurrenceRule?: boolean;
  repeatingTemplate?: string | null;
  creationDate?: number;
  modificationDate?: number;
}

function insertTask(db: DatabaseSync, type: 0 | 1 | 2, opts: SeedTaskOpts): string {
  const uuid = opts.uuid ?? uid(type === 1 ? "proj" : type === 2 ? "head" : "todo");
  db.prepare(
    `INSERT INTO TMTask (
       uuid, type, status, stopDate, trashed, title, notes,
       creationDate, userModificationDate,
       start, startDate, startBucket, deadline,
       "index", todayIndex, area, project, heading,
       untrashedLeafActionsCount, openUntrashedLeafActionsCount,
       checklistItemsCount, openChecklistItemsCount,
       rt1_repeatingTemplate, rt1_recurrenceRule, repeater
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, NULL)`,
  ).run(
    uuid,
    type,
    STATUS[opts.status ?? "open"],
    opts.stopDate ?? null,
    opts.trashed ? 1 : 0,
    opts.title ?? uuid,
    opts.notes ?? "",
    opts.creationDate ?? 1_780_000_000,
    opts.modificationDate ?? 1_780_000_000,
    START[opts.start ?? "active"],
    opts.startDate ? encodePackedDate(opts.startDate) : null,
    opts.evening ? 1 : 0,
    opts.deadline ? encodePackedDate(opts.deadline) : null,
    opts.index ?? 0,
    opts.todayIndex ?? 0,
    opts.area ?? null,
    opts.project ?? null,
    opts.heading ?? null,
    opts.repeatingTemplate ?? null,
    opts.recurrenceRule ? new Uint8Array([0x62, 0x70]) : null,
  );
  return uuid;
}

export const seedTodo = (db: DatabaseSync, opts: SeedTaskOpts = {}) => insertTask(db, 0, opts);
export const seedProject = (db: DatabaseSync, opts: SeedTaskOpts = {}) => insertTask(db, 1, opts);
export const seedHeading = (db: DatabaseSync, opts: SeedTaskOpts = {}) => insertTask(db, 2, opts);

export function seedArea(db: DatabaseSync, title: string, index = 0): string {
  const uuid = uid("area");
  db.prepare(`INSERT INTO TMArea (uuid, title, visible, "index") VALUES (?, ?, 1, ?)`).run(
    uuid,
    title,
    index,
  );
  return uuid;
}

export function seedTag(db: DatabaseSync, title: string, parent: string | null = null): string {
  const uuid = uid("tag");
  db.prepare(
    `INSERT INTO TMTag (uuid, title, shortcut, usedDate, parent, "index") VALUES (?, ?, NULL, NULL, ?, 0)`,
  ).run(uuid, title, parent);
  return uuid;
}

export function tagTask(db: DatabaseSync, taskUuid: string, tagUuid: string): void {
  db.prepare(`INSERT INTO TMTaskTag (tasks, tags) VALUES (?, ?)`).run(taskUuid, tagUuid);
}

export function tagArea(db: DatabaseSync, areaUuid: string, tagUuid: string): void {
  db.prepare(`INSERT INTO TMAreaTag (areas, tags) VALUES (?, ?)`).run(areaUuid, tagUuid);
}
