/**
 * Schema fingerprinting for drift detection.
 *
 * The fingerprint is SHA-256 over a canonical JSON structure derived from
 * PRAGMA table_info for exactly the tables/columns in the dependency
 * manifest (src/db/schema.ts). Extra columns are recorded (warn-only);
 * missing tables/columns change the hash (drift → writes blocked).
 * Enum domains are runtime probes, not part of the hash.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { DEPENDED_TABLES, type DependedTable, q, TABLE_NAMES } from "./schema.ts";

export interface ColumnShape {
  name: string;
  declaredType: string;
  notnull: 0 | 1;
  pk: number;
}

export interface TableShape {
  table: DependedTable;
  present: boolean;
  /** Depended columns in manifest order; absent ones recorded as null. */
  columns: Array<ColumnShape | null>;
  /** Columns present in the DB but not in the manifest (informational). */
  extraColumns: string[];
}

export interface SchemaObservation {
  databaseVersion: number | null;
  tables: TableShape[];
  fingerprint: string;
}

interface PragmaRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

export function observeSchema(db: DatabaseSync): SchemaObservation {
  const tables: TableShape[] = TABLE_NAMES.map((table) => {
    const rows = db.prepare(`PRAGMA table_info(${q(table)})`).all() as unknown as PragmaRow[];
    const byName = new Map(rows.map((r) => [r.name, r]));
    const declared = DEPENDED_TABLES[table];
    const columns = declared.map((name): ColumnShape | null => {
      const row = byName.get(name);
      if (!row) return null;
      return {
        name: row.name,
        declaredType: row.type.toUpperCase(),
        notnull: row.notnull ? 1 : 0,
        pk: row.pk,
      };
    });
    const declaredSet = new Set<string>(declared);
    const extraColumns = rows
      .map((r) => r.name)
      .filter((name) => !declaredSet.has(name))
      .sort();
    return { table, present: rows.length > 0, columns, extraColumns };
  });

  const canonical = tables.map((t) => ({
    table: t.table,
    present: t.present,
    columns: t.columns,
    // extraColumns intentionally excluded from the hash: additions warn, not block
  }));
  const fingerprint = `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")}`;

  return { databaseVersion: readDatabaseVersion(db), tables, fingerprint };
}

/** Meta.databaseVersion is a plist blob/text wrapping an <integer>. */
export function readDatabaseVersion(db: DatabaseSync): number | null {
  try {
    const row = db.prepare(`SELECT value FROM Meta WHERE key = 'databaseVersion'`).get() as
      | { value: string | Uint8Array | null }
      | undefined;
    if (!row || row.value == null) return null;
    const text = typeof row.value === "string" ? row.value : new TextDecoder().decode(row.value);
    const match = /<integer>(\d+)<\/integer>/.exec(text);
    if (match?.[1]) return Number(match[1]);
    const bare = /^\s*(\d+)\s*$/.exec(text);
    return bare?.[1] ? Number(bare[1]) : null;
  } catch {
    return null;
  }
}

export type FingerprintStatus =
  | { kind: "ok"; observation: SchemaObservation }
  | { kind: "drift"; observation: SchemaObservation; expected: string; detail: string[] }
  | { kind: "unknown-version"; observation: SchemaObservation };

export interface Baseline {
  databaseVersion: number;
  fingerprint: string;
  knownThingsAppVersions: string[];
}

export function compareToBaseline(
  observation: SchemaObservation,
  baselines: readonly Baseline[],
): FingerprintStatus {
  const baseline = baselines.find((b) => b.databaseVersion === observation.databaseVersion);
  if (!baseline) return { kind: "unknown-version", observation };
  if (baseline.fingerprint === observation.fingerprint) return { kind: "ok", observation };
  const detail = observation.tables.flatMap((t) => {
    if (!t.present) return [`table missing: ${t.table}`];
    const declared = DEPENDED_TABLES[t.table];
    const lines: string[] = [];
    t.columns.forEach((c, i) => {
      if (c === null) lines.push(`column missing: ${t.table}.${declared[i] ?? `#${i}`}`);
    });
    return lines;
  });
  return { kind: "drift", observation, expected: baseline.fingerprint, detail };
}
