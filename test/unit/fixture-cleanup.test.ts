/**
 * The fixture builder used to abandon every db it made under os.tmpdir() —
 * 253,291 files / 42.2 GB on the maintainer's machine by 2026-08-24. These
 * tests pin the cleanup contract so the leak cannot come back silently.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildFixtureDb, removeFixtureDb, sweepFixtureDbs } from "../fixtures/build-db.ts";

/** The main db plus the WAL siblings that journal_mode=WAL creates alongside it. */
function fixtureFiles(path: string): string[] {
  return [path, `${path}-wal`, `${path}-shm`];
}

describe("fixture db cleanup", () => {
  it("removeFixtureDb deletes the db and its -wal/-shm siblings", () => {
    const fx = buildFixtureDb();
    // Force the WAL siblings into existence: they appear on first write, and
    // the sibling cleanup is the half that regressed unnoticed.
    fx.db.exec("CREATE TABLE leak_probe (id INTEGER PRIMARY KEY)");
    expect(existsSync(`${fx.path}-wal`)).toBe(true);

    fx.close();
    removeFixtureDb(fx.path);

    for (const f of fixtureFiles(fx.path)) expect(existsSync(f)).toBe(false);
  });

  it("sweepFixtureDbs removes fixtures whose call site never closed them", () => {
    // The leak's actual shape: most call sites build a fixture and simply walk
    // away. The sweep must not depend on close() having been called.
    const abandoned = buildFixtureDb();
    const alsoAbandoned = buildFixtureDb();
    expect(existsSync(abandoned.path)).toBe(true);

    sweepFixtureDbs();

    for (const path of [abandoned.path, alsoAbandoned.path]) {
      for (const f of fixtureFiles(path)) expect(existsSync(f)).toBe(false);
    }
  });

  it("is idempotent — sweeping twice is not an error", () => {
    buildFixtureDb();
    sweepFixtureDbs();
    expect(() => sweepFixtureDbs()).not.toThrow();
  });
});
