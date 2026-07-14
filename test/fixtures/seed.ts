/**
 * Typed seed builders for fixture databases. Encodings mirror the atlas:
 * packed dates via the real codec, epoch REAL timestamps, correct enum ints.
 */
import type { DatabaseSync } from "node:sqlite";

import { encodePackedDate, encodeReminderTime } from "../../src/model/dates.ts";

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
  /** HH:mm; encoded to the packed reminderTime int. */
  reminder?: string | null;
  deadline?: string | null;
  /** ISO date; dismissed-deadline suppression marker. */
  deadlineSuppressionDate?: string | null;
  trashed?: boolean;
  index?: number;
  todayIndex?: number;
  /** ISO date for todayIndexReferenceDate (cohort ordering). */
  todayIndexReferenceDate?: string | null;
  area?: string | null;
  project?: string | null;
  heading?: string | null;
  stopDate?: number | null;
  /** Marks the row as a repeating template. */
  recurrenceRule?: boolean;
  /** Real XML plist rule blob (implies template); overrides recurrenceRule. */
  recurrenceRuleXml?: string;
  /** ISO date for rt1_nextInstanceStartDate (templates). */
  nextInstanceStartDate?: string | null;
  instanceCreationPaused?: boolean;
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
       start, startDate, startBucket, reminderTime, deadline, deadlineSuppressionDate,
       "index", todayIndex, todayIndexReferenceDate, area, project, heading,
       untrashedLeafActionsCount, openUntrashedLeafActionsCount,
       checklistItemsCount, openChecklistItemsCount,
       rt1_repeatingTemplate, rt1_recurrenceRule,
       rt1_nextInstanceStartDate, rt1_instanceCreationPaused, repeater
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, NULL)`,
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
    opts.reminder ? encodeReminderTime(opts.reminder) : null,
    opts.deadline ? encodePackedDate(opts.deadline) : null,
    opts.deadlineSuppressionDate ? encodePackedDate(opts.deadlineSuppressionDate) : null,
    opts.index ?? 0,
    opts.todayIndex ?? 0,
    opts.todayIndexReferenceDate ? encodePackedDate(opts.todayIndexReferenceDate) : null,
    opts.area ?? null,
    opts.project ?? null,
    opts.heading ?? null,
    opts.repeatingTemplate ?? null,
    opts.recurrenceRuleXml !== undefined
      ? new TextEncoder().encode(opts.recurrenceRuleXml)
      : opts.recurrenceRule
        ? new Uint8Array([0x62, 0x70])
        : null,
    opts.nextInstanceStartDate ? encodePackedDate(opts.nextInstanceStartDate) : null,
    opts.instanceCreationPaused ? 1 : 0,
  );
  return uuid;
}

export const seedTodo = (db: DatabaseSync, opts: SeedTaskOpts = {}) => insertTask(db, 0, opts);
export const seedProject = (db: DatabaseSync, opts: SeedTaskOpts = {}) => insertTask(db, 1, opts);
export const seedHeading = (db: DatabaseSync, opts: SeedTaskOpts = {}) => insertTask(db, 2, opts);

/**
 * Control the log-move boundary (src/read/log-boundary.ts): logInterval
 * (0=Immediately, 1=Daily, 4=Manually) + manualLogDate (epoch REAL seconds).
 * With no TMSettings row logBoundary falls back to logInterval 0 (boundary =
 * now), so an explicit row is needed to hold closed items unswept for a test.
 */
export function seedSettings(
  db: DatabaseSync,
  opts: { logInterval?: number; manualLogDate?: number | null } = {},
): void {
  db.prepare(`INSERT INTO TMSettings (uuid, logInterval, manualLogDate) VALUES (?, ?, ?)`).run(
    uid("settings"),
    opts.logInterval ?? 0,
    opts.manualLogDate ?? null,
  );
}

export function seedArea(db: DatabaseSync, title: string, index = 0): string {
  const uuid = uid("area");
  db.prepare(`INSERT INTO TMArea (uuid, title, visible, "index") VALUES (?, ?, 1, ?)`).run(
    uuid,
    title,
    index,
  );
  return uuid;
}

export function seedTag(
  db: DatabaseSync,
  title: string,
  parent: string | null = null,
  index = 0,
): string {
  const uuid = uid("tag");
  db.prepare(
    `INSERT INTO TMTag (uuid, title, shortcut, usedDate, parent, "index") VALUES (?, ?, NULL, NULL, ?, ?)`,
  ).run(uuid, title, parent, index);
  return uuid;
}

export function tagTask(db: DatabaseSync, taskUuid: string, tagUuid: string): void {
  db.prepare(`INSERT INTO TMTaskTag (tasks, tags) VALUES (?, ?)`).run(taskUuid, tagUuid);
}

export function tagArea(db: DatabaseSync, areaUuid: string, tagUuid: string): void {
  db.prepare(`INSERT INTO TMAreaTag (areas, tags) VALUES (?, ?)`).run(areaUuid, tagUuid);
}

/**
 * Encode a bplist whose top object is a single scalar double — either a real
 * (marker 0x23) or an NSDate (marker 0x33). Mirrors the on-disk shape of the
 * BSSyncronyMetadata values (a scalar per row); consumed by the sync-health
 * decoder and the fixtures below.
 */
export function bplistScalarDouble(value: number, opts: { date?: boolean } = {}): Uint8Array {
  const marker = opts.date ? 0x33 : 0x23;
  const buf = Buffer.alloc(8 + 9 + 1 + 32);
  buf.write("bplist00", 0, "latin1");
  buf[8] = marker;
  buf.writeDoubleBE(value, 9); // object body: 8-byte big-endian IEEE double
  const offsetTableOffset = 17;
  buf[offsetTableOffset] = 8; // one offset entry (offsetIntSize=1): object at byte 8
  const trailer = offsetTableOffset + 1;
  buf[trailer + 6] = 1; // offsetIntSize
  buf[trailer + 7] = 1; // objectRefSize
  writeU64BE(buf, trailer + 8, 1); // numObjects
  writeU64BE(buf, trailer + 16, 0); // topObject
  writeU64BE(buf, trailer + 24, offsetTableOffset);
  return new Uint8Array(buf);
}

function writeU64BE(buf: Buffer, offset: number, value: number): void {
  for (let i = 7; i >= 0; i--) {
    buf[offset + i] = value & 0xff;
    value = Math.floor(value / 256);
  }
}

/** Insert one BSSyncronyMetadata key/value row (value = raw bplist BLOB). */
export function seedSyncronyMetadata(db: DatabaseSync, uuid: string, value: Uint8Array): void {
  db.prepare("INSERT INTO BSSyncronyMetadata (uuid, value) VALUES (?, ?)").run(uuid, value);
}

export function seedChecklistItem(
  db: DatabaseSync,
  taskUuid: string,
  title: string,
  opts: { status?: keyof typeof STATUS; index?: number } = {},
): string {
  const uuid = uid("cli");
  db.prepare(
    `INSERT INTO TMChecklistItem (uuid, userModificationDate, creationDate, title, status, stopDate, "index", task, leavesTombstone)
     VALUES (?, 1780000000, 1780000000, ?, ?, NULL, ?, ?, 0)`,
  ).run(uuid, title, STATUS[opts.status ?? "open"], opts.index ?? 0, taskUuid);
  return uuid;
}
