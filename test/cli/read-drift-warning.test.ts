/**
 * Reads never block on a schema change — they warn (non-blocking, one line).
 * When the Things database no longer matches the schema this build was
 * validated against (a depended column dropped, or an unrecognized
 * databaseVersion), a read still serves best-effort data and flags it: on
 * STDERR in human mode, and in `meta.warnings` under --json. A healthy schema
 * carries no warnings key at all (omit-empty semantics).
 */
import { afterEach, describe, expect, it } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { resolveInvocation } from "../../src/cli/resolve-invocation.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea } from "../fixtures/seed.ts";

let fx: FixtureDb | null = null;
afterEach(() => {
  fx?.close();
  fx = null;
});

/** A `write`-shaped sink that appends every chunk (decoded) to `sink`. */
const capture =
  (sink: string[]) =>
  (chunk: string | Uint8Array): boolean => {
    sink.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };

/** Run the CLI in-process, capturing stdout AND stderr and the exit code. */
function runCli(argv: string[]): { stdout: string; stderr: string; exitCode: number } {
  const out: string[] = [];
  const err: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = capture(out) as typeof process.stdout.write;
  process.stderr.write = capture(err) as typeof process.stderr.write;
  const originalExitCode = process.exitCode;
  try {
    const program = buildProgram();
    program.exitOverride();
    program.parse(resolveInvocation(program, argv).argv, { from: "user" });
    return { stdout: out.join(""), stderr: err.join(""), exitCode: Number(process.exitCode ?? 0) };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    process.exitCode = originalExitCode;
  }
}

describe("read schema warning (non-blocking)", () => {
  it("--json: a dropped depended column adds meta.warnings, read still succeeds", () => {
    fx = buildFixtureDb();
    seedArea(fx.db, "Work");
    // areas read touches only TMArea, so the read survives a dropped TMTask column.
    fx.db.exec("ALTER TABLE TMTask DROP COLUMN startBucket;");

    const { stdout, exitCode } = runCli(["areas", "--json", "--db", fx.path]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.meta.warnings).toBeDefined();
    expect(envelope.meta.warnings[0]).toContain("schema has changed");
    expect(envelope.meta.warnings[0]).toContain("things doctor");
  });

  it("human mode: the warning goes to STDERR, never into the stdout rows", () => {
    fx = buildFixtureDb();
    seedArea(fx.db, "Work");
    fx.db.exec("ALTER TABLE TMTask DROP COLUMN startBucket;");

    const { stdout, stderr, exitCode } = runCli(["areas", "--db", fx.path]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("warning:");
    expect(stderr).toContain("schema has changed");
    expect(stdout).not.toContain("schema has changed");
  });

  it("--json: an unrecognized databaseVersion adds meta.warnings", () => {
    fx = buildFixtureDb();
    seedArea(fx.db, "Work");
    fx.db.exec("UPDATE Meta SET value = replace(value, '26', '27') WHERE key = 'databaseVersion'");

    const { stdout, exitCode } = runCli(["areas", "--json", "--db", fx.path]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout);
    expect(envelope.meta.warnings).toBeDefined();
    expect(envelope.meta.warnings[0]).toContain("database version");
    expect(envelope.meta.warnings[0]).toContain("things doctor");
  });

  it("healthy schema: no warnings key at all, and STDERR stays clean", () => {
    fx = buildFixtureDb();
    seedArea(fx.db, "Work");

    const { stdout, stderr, exitCode } = runCli(["areas", "--json", "--db", fx.path]);
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout);
    expect(envelope.meta.fingerprint).toBe("ok");
    expect("warnings" in envelope.meta).toBe(false);
    expect(stderr).toBe("");
  });
});
