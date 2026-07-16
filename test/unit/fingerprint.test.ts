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
  it("fixture DDL reproduces the live-captured v26 fingerprint exactly", () => {
    // This is the load-bearing equivalence: the checked-in DDL snapshot IS
    // the real schema for every depended column. If this fails, either the
    // fixture drifted or the manifest/baseline changed without re-capture.
    fixture = buildFixtureDb();
    const obs = observeSchema(fixture.db);
    expect(obs.fingerprint).toBe(DB_V26.fingerprint);
    expect(obs.databaseVersion).toBe(26);
  });

  it("parses databaseVersion from the plist blob", () => {
    fixture = buildFixtureDb();
    expect(readDatabaseVersion(fixture.db)).toBe(26);
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

  it("unknown databaseVersion is its own status", () => {
    fixture = buildFixtureDb();
    fixture.db.exec(
      "UPDATE Meta SET value = replace(value, '26', '27') WHERE key = 'databaseVersion'",
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
      "UPDATE Meta SET value = replace(value, '26', '27') WHERE key = 'databaseVersion'",
    );
    const status = toSchemaStatus(compareToBaseline(observeSchema(fixture.db), BASELINES));
    expect(status.status).toBe("unknown-version");
    expect(status.detail[0]).toContain("27");
  });
});
