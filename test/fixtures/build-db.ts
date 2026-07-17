/**
 * Build a throwaway SQLite database from the sanitized schema fixture.
 * WAL mode for realism (the real Things DB is WAL).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_SQL = readFileSync(new URL("./schema-v26.sql", import.meta.url), "utf8");

export interface FixtureDb {
  db: DatabaseSync;
  path: string;
  close(): void;
}

export function buildFixtureDb(opts: { benchMarker?: boolean } = {}): FixtureDb {
  // Path must be unique across TEST FILES, not just within one: a pid+counter
  // scheme resets per file (module isolation) while the worker pid persists,
  // so a later file reopened an earlier file's leftover db — "table already
  // exists" flakes. randomUUID is collision-free by construction.
  const path = join(tmpdir(), `things-api-fixture-${randomUUID()}.sqlite`);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA_SQL);
  seedMeta(db, opts.benchMarker === true);
  return { db, path, close: () => db.close() };
}

function seedMeta(db: DatabaseSync, benchMarker: boolean): void {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><integer>26</integer></plist>`;
  db.prepare("INSERT INTO Meta (key, value) VALUES ('databaseVersion', ?)").run(plist);
  // The bench-harness marker is OPT-IN: it brands a DB as a synthetic bench
  // fixture, which (a) the simulator fence requires and (b) defaultVectors
  // treats as fail-closed — a marked DB may NEVER be paired with real write
  // transports. Ordinary unit-test fixtures must stay unmarked: they exercise
  // the real-vector code paths through their own seams.
  if (benchMarker) {
    db.prepare("INSERT INTO Meta (key, value) VALUES ('benchFixture', '1')").run();
  }
}
