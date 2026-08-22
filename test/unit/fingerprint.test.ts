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
  it("fixture DDL reproduces the live-captured v26/v27 fingerprint exactly", () => {
    // This is the load-bearing equivalence: the checked-in DDL snapshot IS
    // the real schema for every depended column. If this fails, either the
    // fixture drifted or the manifest/baseline changed without re-capture.
    // v26 and v27 share the hash by construction (DB_V27.fingerprint === DB_V26's)
    // — the 26→27 delta is index-only, and indexes are outside the fingerprint.
    fixture = buildFixtureDb();
    const obs = observeSchema(fixture.db);
    expect(obs.fingerprint).toBe(DB_V26.fingerprint);
    expect(obs.databaseVersion).toBe(27);
  });

  it("parses databaseVersion from the plist blob", () => {
    fixture = buildFixtureDb();
    expect(readDatabaseVersion(fixture.db)).toBe(27);
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

  it("databaseVersion 26 (Things ≤3.22.14) still matches on the identical-DDL v26 baseline", () => {
    // Things 3.23 bumped the version stamp 26 → 27 with a byte-identical set of
    // tables/columns (live-captured 2026-08-22), so the ONE fixture DDL is `ok`
    // against the shipped registry under EITHER stamp. The fixture stamps 27; this
    // is the other direction.
    fixture = buildFixtureDb();
    fixture.db.exec(
      "UPDATE Meta SET value = replace(value, '27', '26') WHERE key = 'databaseVersion'",
    );
    const status = compareToBaseline(observeSchema(fixture.db), BASELINES);
    expect(status.kind).toBe("ok");
  });

  it("unknown databaseVersion is its own status", () => {
    fixture = buildFixtureDb();
    fixture.db.exec(
      "UPDATE Meta SET value = replace(value, '27', '99') WHERE key = 'databaseVersion'",
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
      "UPDATE Meta SET value = replace(value, '27', '99') WHERE key = 'databaseVersion'",
    );
    const status = toSchemaStatus(compareToBaseline(observeSchema(fixture.db), BASELINES));
    expect(status.status).toBe("unknown-version");
    expect(status.detail[0]).toContain("99");
  });
});
