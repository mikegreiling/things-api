/**
 * Build a throwaway SQLite database from the sanitized schema fixture.
 * WAL mode for realism (the real Things DB is WAL).
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_SQL = readFileSync(new URL("./schema-v26.sql", import.meta.url), "utf8");

let counter = 0;

export interface FixtureDb {
  db: DatabaseSync;
  path: string;
  close(): void;
}

export function buildFixtureDb(): FixtureDb {
  const path = join(tmpdir(), `things-api-fixture-${process.pid}-${counter++}.sqlite`);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA_SQL);
  seedMeta(db);
  return { db, path, close: () => db.close() };
}

function seedMeta(db: DatabaseSync): void {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><integer>26</integer></plist>`;
  db.prepare("INSERT INTO Meta (key, value) VALUES ('databaseVersion', ?)").run(plist);
}
