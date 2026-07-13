/**
 * `things open` — view-keyword launching. The GUI launch (execFileSync of
 * /usr/bin/open) is mocked so nothing foregrounds during tests; assertions
 * check the exact things:///show URL the command would launch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { execFileSync } from "node:child_process";

import { buildProgram } from "../../src/cli/main.ts";
import { resolveInvocation } from "../../src/cli/resolve-invocation.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedTodo } from "../fixtures/seed.ts";

let fx: FixtureDb | null = null;
afterEach(() => {
  fx?.close();
  fx = null;
  vi.mocked(execFileSync).mockClear();
});

/** Run the CLI in-process, capturing stdout (same harness as e2e.test.ts). */
function runCli(argv: string[]): { stdout: string; exitCode: number } {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  const originalExitCode = process.exitCode;
  try {
    const program = buildProgram();
    program.exitOverride();
    program.parse(resolveInvocation(program, argv).argv, { from: "user" });
    return { stdout: chunks.join(""), exitCode: Number(process.exitCode ?? 0) };
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = originalExitCode;
  }
}

const launchedUri = (): string => {
  const args = vi.mocked(execFileSync).mock.calls.at(-1)?.[1] as string[] | undefined;
  return args?.[0] ?? "";
};

describe("things open — view keywords", () => {
  it("launches things:///show?id=<keyword> directly for every view keyword", () => {
    fx = buildFixtureDb();
    for (const kw of ["inbox", "today", "anytime", "upcoming", "someday", "logbook", "trash"]) {
      const { stdout, exitCode } = runCli(["open", kw, "--json", "--db", fx.path]);
      expect(exitCode, kw).toBe(0);
      expect(JSON.parse(stdout).data.uri).toBe(`things:///show?id=${kw}`);
      expect(launchedUri()).toBe(`things:///show?id=${kw}`);
    }
  });

  it("a keyword beats a same-named area; uuids stay the escape hatch", () => {
    fx = buildFixtureDb();
    const areaUuid = seedArea(fx.db, "Anytime");
    const { stdout } = runCli(["open", "anytime", "--json", "--db", fx.path]);
    expect(JSON.parse(stdout).data.uri).toBe("things:///show?id=anytime");
    // Opening the shadowed area works by uuid.
    const byUuid = runCli(["open", areaUuid, "--json", "--db", fx.path]);
    expect(JSON.parse(byUuid.stdout).data.uri).toBe(`things:///show?id=${areaUuid}`);
  });

  it("non-keyword refs resolve as before; unknown refs error loudly with no launch", () => {
    fx = buildFixtureDb();
    const todo = seedTodo(fx.db, { title: "openable", index: 1 });
    const ok = runCli(["open", todo.slice(0, 8), "--json", "--db", fx.path]);
    expect(JSON.parse(ok.stdout).data.uri).toBe(`things:///show?id=${todo}`);

    vi.mocked(execFileSync).mockClear();
    const bad = runCli(["open", "frobnicate", "--json", "--db", fx.path]);
    expect(bad.exitCode).not.toBe(0);
    expect(JSON.parse(bad.stdout).error.message).toContain("frobnicate");
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });
});
