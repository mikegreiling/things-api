import { afterEach, describe, expect, it } from "vitest";

import { runDoctor } from "../../src/cli/commands/doctor.ts";
import { diagnose } from "../../src/diagnose.ts";
import type { EnvironmentTracker, EnvironmentTuple } from "../../src/write/environment.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { bplistScalarDouble, seedSyncronyMetadata, seedTodo } from "../fixtures/seed.ts";

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

  it("counts repeating templates and flags undecodable rule blobs (format canary)", () => {
    fixture = buildFixtureDb();
    // One healthy corpus-shaped rule, one future-format rule (rrv=5).
    const ruleXml = (rrv: number) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>fa</key><integer>1</integer>
  <key>fu</key><integer>16</integer>
  <key>rc</key><integer>0</integer>
  <key>rrv</key><integer>${rrv}</integer>
  <key>tp</key><integer>0</integer>
  <key>ts</key><integer>0</integer>
</dict>
</plist>`;
    seedTodo(fixture.db, { title: "healthy", recurrenceRuleXml: ruleXml(4) });
    seedTodo(fixture.db, { title: "future-format", recurrenceRuleXml: ruleXml(5) });
    const { report } = diagnose(fixture.path, {
      environment: fixedTracker(null, TUPLE_A),
    });
    expect(report?.recurrence.templates).toBe(2);
    expect(report?.recurrence.undecodable).toBe(1);
    expect(report?.recurrence.detail).toContain("rrv=5");
  });

  it("emits a structured syncHealth object; empty BSSyncronyMetadata = no-account, no crash", () => {
    fixture = buildFixtureDb();
    seedTodo(fixture.db, { title: "edited", modificationDate: 1_783_900_000 });
    const now = 1_783_966_462_000; // fixed clock
    const { report, exitCode } = diagnose(fixture.path, {
      environment: fixedTracker(null, TUPLE_A),
      syncHealth: {
        now: () => now,
        isAppRunning: () => true,
        walMtimeMs: () => now - 5_000,
        readForegroundMs: () => null,
      },
    });
    expect(exitCode).toBe(0);
    const sh = report?.syncHealth;
    expect(sh?.appRunning.running).toBe(true);
    expect(sh?.wal.stale).toBe(false);
    expect(sh?.wal.ageSeconds).toBe(5);
    expect(sh?.lastLocalEdit.at).toBe(new Date(1_783_900_000 * 1000).toISOString());
    expect(sh?.lastForeground.at).toBeNull();
    // The pristine fixture has the BSSyncronyMetadata table but zero rows.
    expect(sh?.cloud.accountAttached).toBe(false);
    expect(sh?.cloud.lastSyncAttempt).toBeNull();
    expect(sh?.cloud.verdict).toContain("no Things Cloud account");
  });

  it("surfaces an attached-account last-sync attempt from BSSyncronyMetadata", () => {
    fixture = buildFixtureDb();
    const now = 1_783_966_462_000;
    const nsdate = now / 1000 - 978_307_200 - 30; // 30s ago, NSDate 2001-epoch
    seedSyncronyMetadata(
      fixture.db,
      "GryCJ44xPcJG6go5KeTZp1",
      bplistScalarDouble(nsdate, { date: true }),
    );
    const { report } = diagnose(fixture.path, {
      environment: fixedTracker(null, TUPLE_A),
      syncHealth: {
        now: () => now,
        isAppRunning: () => true,
        walMtimeMs: () => now,
        readForegroundMs: () => null,
      },
    });
    expect(report?.syncHealth.cloud.accountAttached).toBe(true);
    expect(report?.syncHealth.cloud.keySource).toBe("known-key");
    expect(report?.syncHealth.cloud.ageSeconds).toBe(30);
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
