// Host-side DB snapshot for SIMFID: dump the fidelity-relevant tables into the
// same keyed-rows shape the lab differ consumes (lab/runner/types.ts DbSnapshot),
// so the host sim replay and the guest CLI drive produce byte-comparable
// captures. The guest side (lab/scripts/simfid.sh's python helper) mirrors this
// exact column set + key scheme + rule canonicalization.
//
// A recurrence rule BLOB is stored as its DECODED canonical form
// (`rule:<type>;<unit>;<interval>;<offsets>`), never raw bytes: the app's and
// the simulator's rule plists carry different (decoder-ignored) anchor epochs,
// so a byte compare would false-diverge while the schedule is identical.

import type { DatabaseSync } from "node:sqlite";

import { decodeRecurrenceRule } from "../../src/model/recurrence.ts";
import type { CellValue, DbSnapshot } from "../runner/types.ts";

/**
 * Curated TMTask columns. Excludes the denormalized leaf-action counters
 * (`untrashedLeafActionsCount` / `openUntrashedLeafActionsCount`): the app
 * maintains them, the per-row seed builders + the simulator do not, and the
 * bench reconciles them separately (bench/fixture.ts reconcileLeafActionCounts)
 * — comparing them would report a known bench-fixture gap, not an applier
 * fidelity fact. `deadlineSuppressionDate` is likewise omitted (dismissed-
 * deadline UI state, not a write-applier output).
 */
const TASK_COLUMNS = [
  "type",
  "status",
  "stopDate",
  "trashed",
  "title",
  "notes",
  "start",
  "startDate",
  "startBucket",
  "reminderTime",
  "deadline",
  "index",
  "todayIndex",
  "area",
  "project",
  "heading",
  "checklistItemsCount",
  "openChecklistItemsCount",
  "rt1_repeatingTemplate",
  "rt1_recurrenceRule",
  "rt1_instanceCreationCount",
  "rt1_instanceCreationStartDate",
  "rt1_nextInstanceStartDate",
  "rt1_afterCompletionReferenceDate",
  "creationDate",
  "userModificationDate",
] as const;

/** Canonicalize any cell for the snapshot: rule blobs → decoded schedule; other BLOBs → marker. */
function canonCell(column: string, value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) {
    if (column === "rt1_recurrenceRule") return canonRule(value);
    return `blob:${value.length}`;
  }
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" || typeof value === "string") return value;
  return String(value);
}

/** Decode a recurrence rule to a stable, anchor-free string, or a fallback marker. */
export function canonRule(blob: unknown): string {
  try {
    const r = decodeRecurrenceRule(blob);
    const offsets = r.offsets
      .map(
        (o) => `d${o.day ?? "_"}m${o.month ?? "_"}w${o.weekday ?? "_"}o${o.weekdayOrdinal ?? "_"}`,
      )
      .join(",");
    return `rule:${r.type};${r.unit};${r.interval};ts${r.startOffsetDays};[${offsets}]`;
  } catch {
    return "rule:undecodable";
  }
}

function taskRows(db: DatabaseSync): Record<string, Record<string, CellValue>> {
  const cols = TASK_COLUMNS.map((c) => `"${c}"`).join(", ");
  const rows = db.prepare(`SELECT uuid, ${cols} FROM TMTask`).all() as Record<string, unknown>[];
  const out: Record<string, Record<string, CellValue>> = {};
  for (const row of rows) {
    const uuid = row["uuid"] as string;
    const rec: Record<string, CellValue> = {};
    for (const c of TASK_COLUMNS) rec[c] = canonCell(c, row[c]);
    out[uuid] = rec;
  }
  return out;
}

function simpleRows(
  db: DatabaseSync,
  table: string,
  columns: string[],
): Record<string, Record<string, CellValue>> {
  const cols = columns.map((c) => `"${c}"`).join(", ");
  const rows = db.prepare(`SELECT uuid, ${cols} FROM ${table}`).all() as Record<string, unknown>[];
  const out: Record<string, Record<string, CellValue>> = {};
  for (const row of rows) {
    const uuid = row["uuid"] as string;
    const rec: Record<string, CellValue> = {};
    for (const c of columns) rec[c] = canonCell(c, row[c]);
    out[uuid] = rec;
  }
  return out;
}

function joinRows(
  db: DatabaseSync,
  table: string,
  a: string,
  b: string,
): Record<string, Record<string, CellValue>> {
  const rows = db.prepare(`SELECT "${a}", "${b}" FROM ${table}`).all() as Record<string, unknown>[];
  const out: Record<string, Record<string, CellValue>> = {};
  for (const row of rows) {
    const av = row[a] as string;
    const bv = row[b] as string;
    out[`${av}|${bv}`] = { [a]: av, [b]: bv };
  }
  return out;
}

/** Snapshot the SIMFID-relevant tables of an open fixture DB. */
export function snapshotDb(db: DatabaseSync): DbSnapshot {
  return {
    TMTask: taskRows(db),
    TMArea: simpleRows(db, "TMArea", ["title", "visible", "index"]),
    TMTag: simpleRows(db, "TMTag", ["title", "parent", "shortcut", "index"]),
    TMChecklistItem: simpleRows(db, "TMChecklistItem", ["title", "status", "index", "task"]),
    TMTaskTag: joinRows(db, "TMTaskTag", "tasks", "tags"),
    TMAreaTag: joinRows(db, "TMAreaTag", "areas", "tags"),
  };
}

/** The tables SIMFID compares, with their key scheme (for the guest helper + docs). */
export const SIMFID_TABLES = [
  "TMTask",
  "TMArea",
  "TMTag",
  "TMChecklistItem",
  "TMTaskTag",
  "TMAreaTag",
] as const;
