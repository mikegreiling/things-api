/**
 * Build a throwaway SQLite database from the sanitized schema fixture.
 * WAL mode for realism (the real Things DB is WAL).
 */
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_SQL = readFileSync(new URL("./schema-v26.sql", import.meta.url), "utf8");

/**
 * Every fixture path handed out by this module, so nothing on disk depends on a
 * call site remembering to clean up. Vitest isolates the module graph per test
 * file, so the registry would otherwise be per-file while the WORKER PROCESS
 * outlives it — the exit backstop below has to see every file's paths, hence the
 * process-global home.
 */
const REGISTRY_KEY = Symbol.for("things-api.test.fixture-paths");
const registry: Set<string> = ((globalThis as Record<symbol, unknown>)[REGISTRY_KEY] ??=
  new Set<string>()) as Set<string>;

const EXIT_HOOK_KEY = Symbol.for("things-api.test.fixture-exit-hook");
if ((globalThis as Record<symbol, unknown>)[EXIT_HOOK_KEY] === undefined) {
  (globalThis as Record<symbol, unknown>)[EXIT_HOOK_KEY] = true;
  // Backstop only: the per-file afterAll sweep (test/setup/fixture-sweep.ts)
  // does the real work. This catches processes that never reach it — a crashed
  // vitest worker, or a bench run that throws before `cleanup()`.
  process.on("exit", () => sweepFixtureDbs());
}

export interface FixtureDb {
  db: DatabaseSync;
  path: string;
  /**
   * Release the SQLite handle. Deliberately does NOT delete the file: callers
   * close to flush WAL and then keep using the path (bench hands it to a child
   * process). Deletion is the registry sweep's job.
   */
  close(): void;
}

export function buildFixtureDb(opts: { benchMarker?: boolean } = {}): FixtureDb {
  // Path must be unique across TEST FILES, not just within one: a pid+counter
  // scheme resets per file (module isolation) while the worker pid persists,
  // so a later file reopened an earlier file's leftover db — "table already
  // exists" flakes. randomUUID is collision-free by construction.
  const path = join(tmpdir(), `things-api-fixture-${randomUUID()}.sqlite`);
  registry.add(path);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA_SQL);
  seedMeta(db, opts.benchMarker === true);
  return { db, path, close: () => db.close() };
}

/**
 * Delete a fixture db and its WAL siblings. Unlinking an open SQLite file is
 * fine on POSIX — the handle keeps working until it is closed, and the bytes are
 * reclaimed at that point.
 */
export function removeFixtureDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
  registry.delete(path);
}

/**
 * Delete every fixture db built by this process so far. Safe to call repeatedly
 * — `removeFixtureDb` deletes the entry it is visiting, which Set iteration
 * defines as fine, and a path already gone is a no-op.
 */
export function sweepFixtureDbs(): void {
  for (const path of registry) removeFixtureDb(path);
}

function seedMeta(db: DatabaseSync, benchMarker: boolean): void {
  // Stamped 27 (Things 3.23) since 2026-08-22. v26 and v27 share this DDL — and
  // therefore the schema fingerprint — because the 26→27 delta is index-only; the
  // stamp is what the simulator's SIMULATED_DATABASE_VERSION fence keys on, so it
  // moves in lockstep with the appliers' modeled generation.
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><integer>27</integer></plist>`;
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
