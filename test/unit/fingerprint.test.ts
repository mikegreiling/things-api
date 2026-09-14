import { afterEach, describe, expect, it } from "vitest";

import { BASELINES } from "../../src/db/baselines/index.ts";
import { DB_V26 } from "../../src/db/baselines/db-v26.ts";
import {
  compareToBaseline,
  observeSchema,
  readDatabaseVersion,
  toSchemaStatus,
} from "../../src/db/fingerprint.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";

let fixture: FixtureDb | null = null;
afterEach(() => {
  fixture?.close();
  fixture = null;
});

describe("schema fingerprint", () => {
  it("fixture DDL reproduces the live-captured v26/v27/v29 fingerprint exactly", () => {
    // This is the load-bearing equivalence: the checked-in DDL snapshot IS
    // the real schema for every depended column. If this fails, either the
    // fixture drifted or the manifest/baseline changed without re-capture.
    // v26, v27 and v29 share the hash by construction (each baseline reuses
    // DB_V26's) — the 26→27 delta is index-only and the 27→29 delta adds only
    // Spotlight-plumbing tables/indexes outside the depended manifest, so none
    // of it is visible to the fingerprint.
    fixture = buildFixtureDb();
    const obs = observeSchema(fixture.db);
    expect(obs.fingerprint).toBe(DB_V26.fingerprint);
    expect(obs.databaseVersion).toBe(29);
  });

  it("parses databaseVersion from the plist blob", () => {
    fixture = buildFixtureDb();
    expect(readDatabaseVersion(fixture.db)).toBe(29);
  });

  it("matches the shipped baseline registry", () => {
    fixture = buildFixtureDb();
    const status = compareToBaseline(observeSchema(fixture.db), BASELINES);
    expect(status.kind).toBe("ok");
  });

  it("reports drift with detail when a depended column disappears", () => {
    fixture = buildFixtureDb();
    fixture.db.exec("ALTER TABLE TMTask DROP COLUMN startBucket;");
    const status = compareToBaseline(observeSchema(fixture.db), BASELINES);
    expect(status.kind).toBe("drift");
    if (status.kind === "drift") {
      expect(status.detail).toContain("column missing: TMTask.startBucket");
    }
  });

  it("added columns do not change the fingerprint (warn-only)", () => {
    fixture = buildFixtureDb();
    fixture.db.exec("ALTER TABLE TMTask ADD COLUMN somethingNew TEXT;");
    const status = compareToBaseline(observeSchema(fixture.db), BASELINES);
    expect(status.kind).toBe("ok");
    const tmtask = status.observation.tables.find((t) => t.table === "TMTask");
    expect(tmtask?.extraColumns).toContain("somethingNew");
  });

  it.each([
    ["26 (Things ≤3.22.14)", "26"],
    ["27 (Things 3.23)", "27"],
  ])("databaseVersion %s still matches on the identical-DDL baseline", (_label, stamp) => {
    // Things 3.23 bumped the stamp 26 → 27 and Things 3.24 bumped it 27 → 29,
    // both with a byte-identical set of depended tables/columns (live-captured
    // 2026-08-22 and 2026-09-14), so the ONE fixture DDL is `ok` against the
    // shipped registry under ANY of the three stamps. The fixture stamps 29;
    // these are the other two directions.
    fixture = buildFixtureDb();
    fixture.db.exec(
      `UPDATE Meta SET value = replace(value, '29', '${stamp}') WHERE key = 'databaseVersion'`,
    );
    const status = compareToBaseline(observeSchema(fixture.db), BASELINES);
    expect(status.kind).toBe("ok");
  });

  it("databaseVersion 29 (Things 3.24) matches on the identical-DDL v29 baseline", () => {
    // The fixture's own stamp — the shipped registry must recognize it.
    fixture = buildFixtureDb();
    const status = compareToBaseline(observeSchema(fixture.db), BASELINES);
    expect(status.kind).toBe("ok");
    expect(status.observation.databaseVersion).toBe(29);
  });

  it("unknown databaseVersion is its own status", () => {
    fixture = buildFixtureDb();
    fixture.db.exec(
      "UPDATE Meta SET value = replace(value, '29', '99') WHERE key = 'databaseVersion'",
    );
    const status = compareToBaseline(observeSchema(fixture.db), BASELINES);
    expect(status.kind).toBe("unknown-version");
  });
});

describe("toSchemaStatus (read-path verdict)", () => {
  it("maps ok to a clean status with no detail", () => {
    fixture = buildFixtureDb();
    const status = toSchemaStatus(compareToBaseline(observeSchema(fixture.db), BASELINES));
    expect(status).toEqual({ status: "ok", detail: [] });
  });

  it("carries the drift detail lines through", () => {
    fixture = buildFixtureDb();
    fixture.db.exec("ALTER TABLE TMTask DROP COLUMN startBucket;");
    const status = toSchemaStatus(compareToBaseline(observeSchema(fixture.db), BASELINES));
    expect(status.status).toBe("drift");
    expect(status.detail).toContain("column missing: TMTask.startBucket");
  });

  it("names the unrecognized databaseVersion", () => {
    fixture = buildFixtureDb();
    fixture.db.exec(
      "UPDATE Meta SET value = replace(value, '29', '99') WHERE key = 'databaseVersion'",
    );
    const status = toSchemaStatus(compareToBaseline(observeSchema(fixture.db), BASELINES));
    expect(status.status).toBe("unknown-version");
    expect(status.detail[0]).toContain("99");
  });
});
