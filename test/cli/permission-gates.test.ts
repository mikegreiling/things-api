/**
 * The read gate at the CLI surface (docs/design/permissions-doctrine.md,
 * Articles I, II, VI).
 *
 * SAFETY: these cells run the real CLI, so they point HOME and the state
 * directory at throwaway temp dirs and force `--no-helpers`. That makes the
 * capability verdict "none" by construction — the refusal happens BEFORE any
 * container access, which is exactly the property under test — and no cell can
 * reach the host's real Things library or its consent state.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { renderTopLevelHelp } from "../../src/cli/help.ts";
import { resolveInvocation } from "../../src/cli/resolve-invocation.ts";
import { resetCapabilityForTests } from "../../src/capability.ts";
import { resetDeputyRoutingForTests } from "../../src/deputy/routing.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

function runCli(argv: string[]): { stdout: string; stderr: string; exitCode: number } {
  const out: string[] = [];
  const err: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const originalExitCode = process.exitCode;
  process.stdout.write = ((c: string | Uint8Array) => {
    out.push(typeof c === "string" ? c : new TextDecoder().decode(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    err.push(typeof c === "string" ? c : new TextDecoder().decode(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    const program = buildProgram();
    program.exitOverride();
    try {
      program.parse(resolveInvocation(program, argv).argv, { from: "user" });
    } catch {
      // commander's help/error exits throw; the exit code is read below.
    }
    return {
      stdout: out.join(""),
      stderr: err.join(""),
      exitCode: Number(process.exitCode ?? 0),
    };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    process.exitCode = originalExitCode;
  }
}

const saved: Record<string, string | undefined> = {};
const OVERRIDDEN = ["HOME", "THINGS_API_STATE_DIR", "THINGS_API_HELPERS", "THINGS_DB"];

beforeEach(() => {
  for (const key of OVERRIDDEN) saved[key] = process.env[key];
  const sandbox = mkdtempSync(join(tmpdir(), "things-gate-"));
  // No TCC.db under this HOME, so the Full Disk Access check fails; no marker
  // under this state dir, so no witnessed session grant; helpers forced off.
  process.env["HOME"] = sandbox;
  process.env["THINGS_API_STATE_DIR"] = sandbox;
  process.env["THINGS_API_HELPERS"] = "false";
  delete process.env["THINGS_DB"];
  resetCapabilityForTests();
  resetDeputyRoutingForTests();
});

afterEach(() => {
  for (const key of OVERRIDDEN) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetCapabilityForTests();
  resetDeputyRoutingForTests();
});

describe("a read with no capability refuses loudly (Article II)", () => {
  it("exits 7 and names the host app, both provenances, and both commands", () => {
    const { stderr, exitCode } = runCli(["today"]);
    expect(exitCode).toBe(7);
    expect(stderr).toContain("the Things database cannot be read");
    expect(stderr).toContain("things helpers setup");
    expect(stderr).toContain("Full Disk Access");
    expect(stderr).toContain("things setup");
  });

  it("the refusal carries no stack trace and no internal vocabulary", () => {
    const { stderr } = runCli(["inbox"]);
    expect(stderr).not.toContain("at Object.");
    expect(stderr).not.toMatch(/ENOENT|EPERM/);
  });

  it("--json emits an environment error envelope with remediation and the verdict", () => {
    const { stdout, exitCode } = runCli(["today", "--json"]);
    expect(exitCode).toBe(7);
    const envelope = JSON.parse(stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("environment");
    expect(envelope.error.likelyCause).toBe("permission-denied");
    expect(envelope.error.remediation).toContain("things helpers setup");
    expect(envelope.error.detail.capability.mode).toBe("none");
    expect(envelope.error.detail.capability.remediation.length).toBeGreaterThan(1);
  });

  it("every read view refuses the same way — the gate is at the client, not per command", () => {
    for (const view of ["today", "inbox", "upcoming", "anytime", "logbook", "tags"]) {
      expect(runCli([view]).exitCode, view).toBe(7);
    }
  });
});

describe("an explicit --db is outside the doctrine entirely (Article VI)", () => {
  let fx: FixtureDb;

  beforeEach(() => {
    fx = buildFixtureDb();
    seedTodo(fx.db, { title: "a synthetic to-do" });
  });

  afterEach(() => {
    fx.close();
  });

  it("reads a caller-supplied database with zero ceremony talk", () => {
    const { stdout, stderr, exitCode } = runCli(["inbox", "--db", fx.path, "--json"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
    expect(stderr).not.toMatch(/Full Disk Access|helpers setup|permission/i);
  });

  it("an unreadable explicit path is an ordinary file error, with NO consent vocabulary", () => {
    const { stdout, stderr, exitCode } = runCli([
      "inbox",
      "--db",
      join(fx.path, "..", "definitely-not-here.sqlite"),
      "--json",
    ]);
    expect(exitCode).not.toBe(0);
    const text = stdout + stderr;
    expect(text).not.toMatch(/Full Disk Access/i);
    expect(text).not.toMatch(/things helpers setup/);
    expect(text).not.toMatch(/things setup/);
  });

  it("THINGS_DB is the same bypass", () => {
    process.env["THINGS_DB"] = fx.path;
    resetCapabilityForTests();
    expect(runCli(["inbox", "--json"]).exitCode).toBe(0);
  });
});

/** Just the `Permissions` block of the top-level index, for a given host name. */
function stanza(host: string): string {
  const text = renderTopLevelHelp(buildProgram(), 100, host);
  const start = text.indexOf("Permissions");
  return text.slice(start, text.indexOf("\n\n", start));
}

describe("the --help permissions stanza (Articles II + III)", () => {
  it("names both provenances, the detected host, and both setup commands", () => {
    const text = stanza("Ghostty");
    expect(text).toContain("things helpers setup");
    expect(text).toContain("things setup");
    expect(text).toContain("Ghostty");
    expect(text).toContain("Full Disk Access");
    expect(text).toContain("things doctor");
  });

  it("stays inside the index line budget at every common width", () => {
    const program = buildProgram();
    for (const width of [70, 80, 100, 120]) {
      const n = renderTopLevelHelp(program, width, "Visual Studio Code").split("\n").length;
      expect(n, `width ${width}`).toBeLessThanOrEqual(65);
    }
  });
});
