/**
 * SINGLE SOURCE OF TRUTH for every table and column things-api depends on.
 *
 * - Read queries name columns exclusively from this manifest (loud failure
 *   when a column disappears).
 * - The schema fingerprint (./fingerprint.ts) hashes exactly this structure
 *   as observed via PRAGMA table_info.
 * - docs/atlas/schema-v26.md documents the semantics of every entry.
 */

export const DEPENDED_TABLES = {
  TMTask: [
    "uuid",
    "type",
    "status",
    "stopDate",
    "trashed",
    "title",
    "notes",
    "creationDate",
    "userModificationDate",
    "start",
    "startDate",
    "startBucket",
    "reminderTime",
    "deadline",
    "deadlineSuppressionDate",
    "index",
    "todayIndex",
    "todayIndexReferenceDate",
    "area",
    "project",
    "heading",
    "untrashedLeafActionsCount",
    "openUntrashedLeafActionsCount",
    "checklistItemsCount",
    "openChecklistItemsCount",
    "rt1_repeatingTemplate",
    "rt1_recurrenceRule",
    "rt1_nextInstanceStartDate",
    "rt1_instanceCreationPaused",
    "repeater",
  ],
  TMArea: ["uuid", "title", "visible", "index"],
  TMTag: ["uuid", "title", "shortcut", "usedDate", "parent", "index"],
  TMTaskTag: ["tasks", "tags"],
  TMAreaTag: ["areas", "tags"],
  TMChecklistItem: [
    "uuid",
    "title",
    "status",
    "stopDate",
    "index",
    "task",
    "creationDate",
    "userModificationDate",
  ],
  TMSettings: [
    "uuid",
    "uriSchemeAuthenticationToken",
    "groupTodayByParent",
    "logInterval",
    "manualLogDate",
  ],
  Meta: ["key", "value"],
} as const;

export type DependedTable = keyof typeof DEPENDED_TABLES;

export const TABLE_NAMES = Object.keys(DEPENDED_TABLES) as DependedTable[];

/**
 * Enum domains checked as runtime probes (not part of the structural hash;
 * out-of-domain values raise drift warnings). Verified live 2026-07-02.
 */
export const ENUM_DOMAINS = {
  "TMTask.type": [0, 1, 2], // to-do | project | heading
  "TMTask.status": [0, 2, 3], // open | canceled | completed
  "TMTask.start": [0, 1, 2], // inbox | active | someday
  "TMTask.startBucket": [0, 1], // today | evening
  "TMTask.trashed": [0, 1],
  "TMChecklistItem.status": [0, 2, 3],
} as const;

/** Quote an identifier for SQL ("index" is a keyword and a real column name). */
export function q(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Explicit select list for a depended table (never `SELECT *`). */
export function selectList(table: DependedTable): string {
  return DEPENDED_TABLES[table].map(q).join(", ");
}
