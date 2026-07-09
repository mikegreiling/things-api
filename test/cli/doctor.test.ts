import { afterEach, describe, expect, it } from "vitest";

import { runDoctor } from "../../src/cli/commands/doctor.ts";
import { diagnose } from "../../src/diagnose.ts";
import type { EnvironmentTracker, EnvironmentTuple } from "../../src/write/environment.ts";
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

const TUPLE_A: EnvironmentTuple = {
  thingsVersion: "3.22.11",
  macosVersion: "15.5",
  pkgVersion: "0.3.0",
  nodeBinary: "/usr/local/bin/node",
};

function fixedTracker(
  recorded: EnvironmentTuple | null,
  current: EnvironmentTuple,
): EnvironmentTracker {
  return { capture: () => current, load: () => recorded, record: () => {} };
}

describe("doctor environment & automation sections", () => {
  it("reports tuple changes since the last verified write", () => {
    fixture = buildFixtureDb();
    const { report } = diagnose(fixture.path, {
      environment: fixedTracker(TUPLE_A, { ...TUPLE_A, thingsVersion: "3.22.12" }),
    });
    expect(report?.environment.changes).toEqual([
      { field: "thingsVersion", from: "3.22.11", to: "3.22.12" },
    ]);
    expect(report?.environment.lastVerifiedWrite).toEqual(TUPLE_A);
  });

  it("reports no recorded tuple before the first verified write", () => {
    fixture = buildFixtureDb();
    const { report } = diagnose(fixture.path, {
      environment: fixedTracker(null, TUPLE_A),
    });
    expect(report?.environment.lastVerifiedWrite).toBeNull();
    expect(report?.environment.changes).toEqual([]);
  });

  it("automation is not-probed by default and probed on request", () => {
    fixture = buildFixtureDb();
    const byDefault = diagnose(fixture.path, {
      environment: fixedTracker(null, TUPLE_A),
    });
    expect(byDefault.report?.automation.status).toBe("not-probed");

    const probed = diagnose(fixture.path, {
      environment: fixedTracker(null, TUPLE_A),
      probeAutomation: true,
      probeDeps: { isAppRunning: () => false },
    });
    expect(probed.report?.automation.status).toBe("app-not-running");
  });

  it("reports the on-disk URL-scheme state and proxy-shortcut presence", () => {
    fixture = buildFixtureDb();
    const { report } = diagnose(fixture.path, {
      environment: fixedTracker(null, TUPLE_A),
      availability: {
        plistPath: fixture.path, // any readable file; extract seam decides
        extract: () => "0",
        listShortcuts: () => "things-proxy-find-items\n",
      },
    });
    expect(report?.availability.urlScheme.enabled).toBe(false);
    expect(report?.availability.urlScheme.detail).toContain("Enable Things URLs");
    expect(report?.availability.shortcuts.present).toEqual(["things-proxy-find-items"]);
    expect(report?.availability.shortcuts.missing).toHaveLength(5);
  });
});
