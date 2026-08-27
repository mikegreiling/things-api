import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { runDoctor } from "../../src/cli/commands/doctor.ts";
import { diagnose, type DiagnoseOptions, type DiagnoseReport } from "../../src/diagnose.ts";
import type { DeputyHalfStatus, HelpersStatus } from "../../src/deputy/install.ts";
import { EXPECTED_HELPERS_VERSION } from "../../src/deputy/protocol.ts";
import { resetDeputyRoutingForTests, type HelpersRouting } from "../../src/deputy/routing.ts";
import type { AuditRecord } from "../../src/audit/schema.ts";
import type { EnvironmentTracker, EnvironmentTuple } from "../../src/write/environment.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { bplistScalarDouble, seedSyncronyMetadata, seedTodo } from "../fixtures/seed.ts";

/** Minimal audit record for the integrity-scan fixtures. */
function auditLine(over: Partial<AuditRecord>): string {
  const rec: AuditRecord = {
    v: 1,
    ts: "2026-07-16T12:00:00.000Z",
    actor: "mike",
    host: "test-host",
    op: "todo.update",
    uuid: "U-1",
    vector: "url-scheme",
    disruption: 0,
    invocation: null,
    requested: {},
    pre: null,
    observed: null,
    result: "ok",
    verify: null,
    durationMs: 1,
    env: { pkg: "0.0.0", dbVersion: 26, fingerprint: "ok" },
    ...over,
  };
  return JSON.stringify(rec);
}

let fixture: FixtureDb | null = null;
afterEach(() => {
  fixture?.close();
  fixture = null;
});

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

describe("doctor core", () => {
  it("reports healthy against a pristine fixture DB", () => {
    fixture = buildFixtureDb();
    const { report, exitCode, meta } = runDoctor(fixture.path);
    expect(exitCode).toBe(0);
    expect(report?.db.databaseVersion).toBe(27);
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

  it("counts orphaned intent records (a change may have landed unrecorded — M3)", () => {
    fixture = buildFixtureDb();
    const auditDir = mkdtempSync(join(tmpdir(), "things-api-doctor-audit-"));
    try {
      writeFileSync(
        join(auditDir, "2026-07.jsonl"),
        [
          // A completed write: intent + final pair → not orphaned.
          auditLine({ ts: "2026-07-16T09:00:00.000Z", op: "todo.update", result: "intent" }),
          auditLine({ ts: "2026-07-16T09:00:00.000Z", op: "todo.update", result: "ok" }),
          // A crashed write: intent with no final → orphaned.
          auditLine({ ts: "2026-07-16T10:30:00.000Z", op: "todo.complete", result: "intent" }),
        ].join("\n"),
      );
      const { report } = diagnose(fixture.path, {
        environment: fixedTracker(null, TUPLE_A),
        auditDir,
      });
      expect(report?.audit.orphanedIntents).toBe(1);
      expect(report?.audit.newestOrphanIntent).toBe("2026-07-16T10:30:00.000Z");
    } finally {
      rmSync(auditDir, { recursive: true, force: true });
    }
  });

  it("reports zero orphans against an empty/absent audit trail", () => {
    fixture = buildFixtureDb();
    const { report } = diagnose(fixture.path, {
      environment: fixedTracker(null, TUPLE_A),
      auditDir: "/nonexistent/audit",
    });
    expect(report?.audit).toEqual({ orphanedIntents: 0, newestOrphanIntent: null });
  });

  it("reports the URL-scheme standing and proxy-shortcut presence", () => {
    fixture = buildFixtureDb();
    const { report } = diagnose(fixture.path, {
      environment: fixedTracker(null, TUPLE_A),
      availability: { listShortcuts: () => "things-proxy-find-items\n" },
      capability: {
        // A standing that reaches the container, then a plist whose extract
        // seam answers "off" — no host file and no plutil spawn.
        readStanding: () => ({
          mode: "direct-fda",
          detail: "test",
          remediation: [],
          host: { bundleId: null, name: "this terminal" },
        }),
        readPrefsPlist: () => Buffer.from("irrelevant — the extract seam decides"),
        extractUriSchemeEnabled: () => "0",
      },
    });
    expect(report?.availability.urlScheme.mode).toBe("disabled");
    expect(report?.availability.urlScheme.detail).toContain("Enable Things URLs");
    expect(report?.availability.shortcuts.present).toEqual(["things-proxy-find-items"]);
    expect(report?.availability.shortcuts.missing).toHaveLength(5);
  });
});

describe("doctor CLI — orphaned-intent advisory line", () => {
  let stateDir: string;
  let stdout: string[];
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    fixture = buildFixtureDb();
    stateDir = mkdtempSync(join(tmpdir(), "things-api-doctor-cli-"));
    for (const key of ["THINGS_DB", "THINGS_API_STATE_DIR", "THINGS_API_CONFIG_DIR"]) {
      envBackup[key] = process.env[key];
    }
    process.env["THINGS_DB"] = fixture.path;
    process.env["THINGS_API_STATE_DIR"] = stateDir;
    process.env["THINGS_API_CONFIG_DIR"] = join(stateDir, "config");
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(stateDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  async function runDoctorCli(): Promise<string> {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "things", "doctor"]);
    return stdout.join("");
  }

  it("prints the one-line advisory (count + newest) when an intent has no recorded result", async () => {
    mkdirSync(join(stateDir, "audit"), { recursive: true });
    writeFileSync(
      join(stateDir, "audit", "2026-07.jsonl"),
      `${auditLine({ ts: "2026-07-16T10:30:00.000Z", op: "todo.complete", result: "intent" })}\n`,
    );
    const out = await runDoctorCli();
    expect(out).toContain("1 change(s) were started but their result was not recorded");
    expect(out).toContain("2026-07-16T10:30:00.000Z");
    expect(out).toContain("review your recent changes in Things");
  });

  /**
   * Doctor's provenance table (docs/design/permissions-doctrine.md, Article II).
   * Doctor is what someone runs when access is broken, so this section must
   * answer WHOSE grant each vector rides on — and it must render without a
   * single probe that could prompt (doctor was an Article I violation once).
   */
  it("renders the per-vector provenance table, naming who holds each grant", async () => {
    const out = await runDoctorCli();
    expect(out).toContain("── Permissions (per vector) ──");
    for (const vector of ["read", "applescript", "url-scheme", "shortcuts", "ui"]) {
      expect(out).toMatch(new RegExp(`^\\s+${vector}\\s`, "m"));
    }
    // THINGS_DB is set here, so reads are Article VI's explicit-path case: the
    // table must say so rather than implying a TCC grant is in play.
    expect(out).toContain("none needed (an explicit --db path)");
    // The two consent-free vectors state what their real gate is.
    expect(out).toContain("the app's own 'Enable Things URLs' setting");
    expect(out).toContain("each shortcut's own Always Allow");
    // GUI-driving is off in this scratch config, and the row says whose grant
    // it would be — never "grant Accessibility to this terminal".
    expect(out).toContain("helpers only (Article IV)");
    expect(out).toContain("things helpers setup --gui");
  });

  it("omits the advisory entirely when the trail is clean", async () => {
    mkdirSync(join(stateDir, "audit"), { recursive: true });
    writeFileSync(
      join(stateDir, "audit", "2026-07.jsonl"),
      [
        auditLine({ ts: "2026-07-16T09:00:00.000Z", op: "todo.update", result: "intent" }),
        auditLine({ ts: "2026-07-16T09:00:00.000Z", op: "todo.update", result: "ok" }),
      ].join("\n"),
    );
    const out = await runDoctorCli();
    expect(out).not.toContain("were started but their result was not recorded");
  });
});

describe("doctor — behavioral-drift notice (certified-app-version)", () => {
  let configDir: string;
  const backup = process.env["THINGS_API_CONFIG_DIR"];
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "things-api-doctor-behav-"));
    process.env["THINGS_API_CONFIG_DIR"] = configDir;
  });
  afterEach(() => {
    if (backup === undefined) delete process.env["THINGS_API_CONFIG_DIR"];
    else process.env["THINGS_API_CONFIG_DIR"] = backup;
    rmSync(configDir, { recursive: true, force: true });
  });

  function writeCertified(version: string | null): void {
    writeFileSync(
      join(configDir, "config.json"),
      `${JSON.stringify(version === null ? {} : { certifiedAppVersion: version })}\n`,
    );
  }

  it("flags behavioralDrift when the installed version differs from certified", () => {
    fixture = buildFixtureDb();
    writeCertified("3.22.11");
    const { report } = diagnose(fixture.path, {
      environment: fixedTracker(null, { ...TUPLE_A, thingsVersion: "3.22.12" }),
    });
    expect(report?.app.version).toBe("3.22.12");
    expect(report?.app.certifiedVersion).toBe("3.22.11");
    expect(report?.app.behavioralDrift).toBe(true);
    // Non-blocking: the behavioral mismatch never disables writes.
    expect(report?.writes.enabled).toBe(true);
  });

  it("does NOT flag drift when installed matches certified", () => {
    fixture = buildFixtureDb();
    writeCertified("3.22.11");
    const { report } = diagnose(fixture.path, {
      environment: fixedTracker(null, { ...TUPLE_A, thingsVersion: "3.22.11" }),
    });
    expect(report?.app.behavioralDrift).toBe(false);
  });

  it("does NOT flag drift when no certified version is set (never certified)", () => {
    fixture = buildFixtureDb();
    writeCertified(null);
    const { report } = diagnose(fixture.path, {
      environment: fixedTracker(null, { ...TUPLE_A, thingsVersion: "3.22.12" }),
    });
    expect(report?.app.certifiedVersion).toBeNull();
    expect(report?.app.behavioralDrift).toBe(false);
  });

  it("does NOT flag drift when the installed version is unreadable", () => {
    fixture = buildFixtureDb();
    writeCertified("3.22.11");
    const { report } = diagnose(fixture.path, {
      environment: fixedTracker(null, { ...TUPLE_A, thingsVersion: null }),
    });
    expect(report?.app.version).toBeNull();
    expect(report?.app.behavioralDrift).toBe(false);
  });
});

/**
 * The helpers section. Every cell injects a synthetic status + routing
 * resolution: the real probes read this machine's launchd, sockets, and code
 * signatures — right for a diagnostic, useless for an assertion, since the host
 * running the suite may have live helpers of its own.
 */
function half(over: Partial<DeputyHalfStatus> = {}): DeputyHalfStatus {
  return {
    plistInstalled: true,
    loaded: true,
    running: true,
    socketPath: "/tmp/synthetic/deputy.sock",
    hungSocket: false,
    hello: { protocol: 1, deputyVersion: EXPECTED_HELPERS_VERSION, pid: 4242, uptimeMs: 1000 },
    signing: { state: "signed", authority: "Developer ID Application: Synthetic" },
    detail: "running",
    ...over,
  };
}

const absentHalf = half({
  plistInstalled: false,
  loaded: false,
  running: false,
  hello: null,
  signing: null,
  detail: "not running (no socket)",
});

function status(over: Partial<HelpersStatus> = {}): HelpersStatus {
  return {
    mode: "auto",
    bundleInstalled: true,
    installedVersion: EXPECTED_HELPERS_VERSION,
    deputy: half(),
    reader: { ...half(), installed: true, granted: true },
    ...over,
  };
}

function routing(over: Partial<HelpersRouting> = {}): HelpersRouting {
  return {
    mode: "auto",
    automation: true,
    files: true,
    deputyReason: null,
    readerReason: null,
    ...over,
  };
}

describe("doctor — helpers section", () => {
  function helpersOf(deps: NonNullable<DiagnoseOptions["helpers"]>): DiagnoseReport["helpers"] {
    fixture = buildFixtureDb();
    const { report } = diagnose(fixture.path, { helpers: deps });
    if (report === null) throw new Error("expected a report");
    return report.helpers;
  }

  it("reports a healthy pair: both halves carrying traffic, nothing to fix", () => {
    const helpers = helpersOf({ status: status(), routing: routing() });
    expect(helpers.routing.automation).toBe(true);
    expect(helpers.routing.files).toBe(true);
    expect(helpers.versionSkew).toBe(false);
    expect(helpers.hungSocket).toBe(false);
    expect(helpers.remedy).toBeNull();
    expect(helpers.detail).toContain("both halves");
  });

  it("flags version skew and names the rebuild + reinstall remedy", () => {
    const helpers = helpersOf({
      status: status({ installedVersion: "0.9.0" }),
      routing: routing(),
    });
    expect(helpers.versionSkew).toBe(true);
    expect(helpers.expectedVersion).toBe(EXPECTED_HELPERS_VERSION);
    expect(helpers.remedy).toContain("build-helpers.sh");
    expect(helpers.remedy).toContain("things helpers setup");
  });

  it("detects a hung socket (present, no handshake) and asks for a restart", () => {
    const helpers = helpersOf({
      status: status({
        deputy: half({
          running: false,
          hungSocket: true,
          hello: null,
          detail: "socket present but not answering",
        }),
      }),
      routing: routing({ automation: false, deputyReason: "handshake failed: timeout" }),
    });
    expect(helpers.hungSocket).toBe(true);
    expect(helpers.remedy).toContain("things helpers restart");
    expect(helpers.detail).toContain("automation");
  });

  it("an ungranted reader points at the ceremony", () => {
    const helpers = helpersOf({
      status: status({
        reader: { ...half(), installed: true, granted: false },
      }),
      routing: routing({ files: false, readerReason: "reader running but NOT granted" }),
    });
    expect(helpers.remedy).toContain("things helpers setup");
    expect(helpers.detail).toContain("database reads");
  });

  it("under auto, an un-onboarded machine reads as normal — with a setup pointer", () => {
    const helpers = helpersOf({
      status: status({
        bundleInstalled: false,
        installedVersion: null,
        deputy: absentHalf,
        reader: { ...absentHalf, installed: false, granted: false },
      }),
      routing: routing({
        automation: false,
        files: false,
        deputyReason: "deputy not installed",
        readerReason: "reader not installed",
      }),
    });
    expect(helpers.versionSkew).toBe(false);
    expect(helpers.detail).toContain("normal state");
    expect(helpers.remedy).toContain("things helpers setup");
  });

  it("mode false reports fully direct and asks for nothing", () => {
    // The mode itself comes from config, which the suite pins to false.
    const helpers = helpersOf({
      status: status({ mode: "false", bundleInstalled: false, installedVersion: null }),
      routing: routing({
        mode: "false",
        automation: false,
        files: false,
        deputyReason: "disabled",
        readerReason: "disabled",
      }),
    });
    expect(helpers.mode).toBe("false");
    expect(helpers.detail).toContain("routing off");
    expect(helpers.remedy).toBeNull();
  });
});

describe("doctor CLI — helpers section render", () => {
  let stateDir: string;
  let stdout: string[];
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    fixture = buildFixtureDb();
    stateDir = mkdtempSync(join(tmpdir(), "things-api-doctor-helpers-"));
    for (const key of [
      "THINGS_DB",
      "THINGS_API_STATE_DIR",
      "THINGS_API_CONFIG_DIR",
      "THINGS_API_READER_DIR",
      "THINGS_API_HELPERS",
      "HOME",
    ]) {
      envBackup[key] = process.env[key];
    }
    process.env["THINGS_DB"] = fixture.path;
    process.env["THINGS_API_STATE_DIR"] = stateDir;
    process.env["THINGS_API_CONFIG_DIR"] = join(stateDir, "config");
    // Never handshake this machine's real reader socket from a test.
    process.env["THINGS_API_READER_DIR"] = join(stateDir, "reader");
    process.env["THINGS_API_HELPERS"] = "auto";
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDeputyRoutingForTests();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(stateDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it("renders the section with the mode, what it resolved to, and the bundle state", async () => {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "things", "doctor"]);
    const out = stdout.join("");
    expect(out).toContain("── Helpers ──");
    expect(out).toContain("mode:        auto");
    expect(out).toContain("routing:     automation DIRECT, database reads DIRECT");
    expect(out).toContain("bundle:      not installed");
    expect(out).toContain("next:        `things helpers setup`");
  });

  it("answers identically from a host with no grants at all — nothing is gated", async () => {
    // The rendezvous left the reader's sandbox container in helpers 1.3.0, so
    // a host with no Full Disk Access and no witnessed app-data grant reaches
    // the same verdict an FDA one does: it looks, finds nothing installed, and
    // says so. There is no third `unreachable` state left to report.
    process.env["HOME"] = join(stateDir, "home");
    mkdirSync(join(stateDir, "deputy/bin/Things API Helper.app/Contents/MacOS"), {
      recursive: true,
    });
    writeFileSync(
      join(stateDir, "deputy/bin/Things API Helper.app/Contents/MacOS/things-deputy"),
      "#!/bin/sh\n",
    );
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "things", "doctor"]);
    const out = stdout.join("");
    expect(out).not.toContain("UNREACHABLE");
    expect(out).not.toContain("host-gated");
    expect(out).toContain("reader:      not installed");
  });

  it("--json carries the section in the envelope", async () => {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "things", "doctor", "--json"]);
    const envelope = JSON.parse(stdout.join("").trim()) as {
      data: {
        helpers: { mode: string; expectedVersion: string; status: { bundleInstalled: boolean } };
      };
    };
    expect(envelope.data.helpers.mode).toBe("auto");
    expect(envelope.data.helpers.expectedVersion).toBe(EXPECTED_HELPERS_VERSION);
    expect(envelope.data.helpers.status.bundleInstalled).toBe(false);
  });
});
