/**
 * CLI surface of the container scope: a scoped read carries the additive
 * `meta.scope` in its --json envelope and prints a one-line "scoped to …"
 * banner on a TTY (never in --json). Driven by THINGS_API_SCOPE so the whole
 * CLI (which reads env/config only — no per-call --scope flag by design) is
 * jailed. See docs/design/container-scope.md.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { resolveInvocation } from "../../src/cli/resolve-invocation.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTodo } from "../fixtures/seed.ts";

let fx: FixtureDb | null = null;
const savedScope = process.env["THINGS_API_SCOPE"];

beforeEach(() => {
  fx = buildFixtureDb();
  const work = seedArea(fx.db, "Work", 0);
  const personal = seedArea(fx.db, "Personal", 1);
  seedProject(fx.db, { title: "Work Project", area: work });
  seedTodo(fx.db, { title: "work loose", area: work });
  seedTodo(fx.db, { title: "personal loose", area: personal });
});
afterEach(() => {
  fx?.close();
  fx = null;
  if (savedScope === undefined) delete process.env["THINGS_API_SCOPE"];
  else process.env["THINGS_API_SCOPE"] = savedScope;
});

const capture =
  (sink: string[]) =>
  (chunk: string | Uint8Array): boolean => {
    sink.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };

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
  } catch {
    return { stdout: out.join(""), stderr: err.join(""), exitCode: Number(process.exitCode ?? 0) };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    process.exitCode = originalExitCode;
  }
}

describe("scoped CLI reads", () => {
  it("emits meta.scope in the --json envelope and hides out-of-scope rows", () => {
    process.env["THINGS_API_SCOPE"] = "Work";
    const { stdout, exitCode } = runCli(["anytime", "--json", "--db", (fx as FixtureDb).path]);
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(true);
    expect(env.meta.scope).toEqual({
      kind: "area",
      uuid: expect.any(String),
      title: "Work",
      source: "env",
    });
    const titles = (env.data as Array<{ items: Array<{ title: string }> }>).flatMap((s) =>
      s.items.map((i) => i.title),
    );
    expect(titles).toContain("work loose");
    expect(titles).not.toContain("personal loose");
  });

  it("omits meta.scope when unscoped", () => {
    const { stdout, exitCode } = runCli(["anytime", "--json", "--db", (fx as FixtureDb).path]);
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout);
    expect("scope" in env.meta).toBe(false);
  });
});
