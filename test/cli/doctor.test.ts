import { afterEach, describe, expect, it } from "vitest";

import { runDoctor } from "../../src/cli/commands/doctor.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";

let fixture: FixtureDb | null = null;
afterEach(() => {
  fixture?.close();
  fixture = null;
});

describe("doctor core", () => {
  it("reports healthy against a pristine fixture DB", () => {
    fixture = buildFixtureDb();
    const { report, exitCode, meta } = runDoctor(fixture.path);
    expect(exitCode).toBe(0);
    expect(report?.db.databaseVersion).toBe(26);
    expect(report?.fingerprint.status).toBe("ok");
    expect(report?.writes.enabled).toBe(true);
    expect(meta.fingerprint).toBe("ok");
  });

  it("drift-blocks writes when a depended column is missing (exit 5)", () => {
    fixture = buildFixtureDb();
    fixture.db.exec("ALTER TABLE TMTask DROP COLUMN todayIndex;");
    const { report, exitCode } = runDoctor(fixture.path);
    expect(exitCode).toBe(5);
    expect(report?.fingerprint.status).toBe("drift");
    expect(report?.fingerprint.detail).toContain("column missing: TMTask.todayIndex");
    expect(report?.writes.enabled).toBe(false);
  });

  it("environment error when the db path does not exist (exit 7)", () => {
    const { report, error, exitCode } = runDoctor("/nonexistent/things.sqlite");
    expect(exitCode).toBe(7);
    expect(report).toBeNull();
    expect(error?.code).toBe("environment");
  });
});
