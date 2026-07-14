// DB-snapshot differ: ground-truth mutation detector for probes.
// Transport exit codes prove nothing (`open` exits 0 for invalid commands);
// only a row-level before/after diff distinguishes success, silent no-op,
// and side effects.

import type { DbDelta, DbSnapshot, FieldChange } from "./types.ts";

export function diffSnapshots(before: DbSnapshot, after: DbSnapshot): DbDelta {
  const delta: DbDelta = { inserted: [], deleted: [], changed: [] };
  const tables = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const table of [...tables].toSorted()) {
    const b = before[table] ?? {};
    const a = after[table] ?? {};

    for (const key of Object.keys(a).toSorted()) {
      const rowAfter = a[key];
      if (rowAfter === undefined) continue;
      const rowBefore = b[key];
      if (rowBefore === undefined) {
        delta.inserted.push({ table, key, row: rowAfter });
        continue;
      }
      const fields: FieldChange[] = [];
      for (const field of new Set([...Object.keys(rowBefore), ...Object.keys(rowAfter)])) {
        const beforeVal = rowBefore[field] ?? null;
        const afterVal = rowAfter[field] ?? null;
        if (!cellEquals(beforeVal, afterVal)) {
          fields.push({ field, before: beforeVal, after: afterVal });
        }
      }
      if (fields.length > 0) {
        fields.sort((x, y) => (x.field < y.field ? -1 : 1));
        delta.changed.push({ table, key, fields });
      }
    }

    for (const key of Object.keys(b).toSorted()) {
      const rowBefore = b[key];
      if (rowBefore !== undefined && a[key] === undefined) {
        delta.deleted.push({ table, key, row: rowBefore });
      }
    }
  }

  return delta;
}

/**
 * REAL columns (epoch dates) round-trip through JSON with float noise;
 * compare numbers with a tolerance far below any meaningful date delta.
 */
function cellEquals(a: string | number | null, b: string | number | null): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return a === b || Math.abs(a - b) < 1e-6;
  }
  return a === b;
}
