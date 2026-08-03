/**
 * The `--area` view filter on the list commands (today/anytime/someday/
 * upcoming/logbook): a POST-FILTER restricting a view to one area, with the
 * resolved target echoed in the additive `meta.filter` under --json. An
 * unresolvable ref fails closed as a usage error, like every other ref.
 */
import { afterEach, describe, expect, it } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { resolveInvocation } from "../../src/cli/resolve-invocation.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTodo } from "../fixtures/seed.ts";

let fx: FixtureDb | null = null;
afterEach(() => {
  fx?.close();
  fx = null;
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

function seedWorld(): void {
  fx = fx as FixtureDb;
  const alpha = seedArea(fx.db, "Alpha", 0);
  const beta = seedArea(fx.db, "Beta", 1);
  const pAlpha = seedProject(fx.db, { title: "p-alpha", area: alpha });
  seedTodo(fx.db, { title: "a-loose", area: alpha });
  seedTodo(fx.db, { title: "p-alpha-child", project: pAlpha });
  seedTodo(fx.db, { title: "b-loose", area: beta });
  seedTodo(fx.db, { title: "orphan-loose" });
}

describe("anytime --area (CLI/--json)", () => {
  it("adds meta.filter and returns only the target area's rows", () => {
    fx = buildFixtureDb();
    seedWorld();
    const { stdout, exitCode } = runCli(["anytime", "--area", "Alpha", "--json", "--db", fx.path]);
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(true);
    expect(env.meta.filter).toEqual({ area: { uuid: expect.any(String), title: "Alpha" } });
    const titles = (env.data as { sections: Array<{ items: Array<{ title: string }> }> }).sections
      .flatMap((s) => s.items.map((i) => i.title))
      .toSorted();
    expect(titles).toEqual(["a-loose", "p-alpha", "p-alpha-child"]);
  });

  it("omits meta.filter when unscoped", () => {
    fx = buildFixtureDb();
    seedWorld();
    const { stdout, exitCode } = runCli(["anytime", "--json", "--db", fx.path]);
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout);
    expect("filter" in env.meta).toBe(false);
  });

  it("fails closed on an unresolvable area (--json error envelope, exit 2)", () => {
    fx = buildFixtureDb();
    seedWorld();
    const { stdout, exitCode } = runCli(["anytime", "--area", "Nope", "--json", "--db", fx.path]);
    expect(exitCode).toBe(2);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("not-found");
  });

  it("fails closed on an unresolvable area (human mode, STDERR, exit 2)", () => {
    fx = buildFixtureDb();
    seedWorld();
    const { stderr, exitCode } = runCli(["anytime", "--area", "Nope", "--db", fx.path]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("no area matching");
  });
});

describe("today --area (CLI/--json)", () => {
  it("adds meta.filter and returns only the target area's Today members", () => {
    fx = buildFixtureDb();
    const alpha = seedArea(fx.db, "Alpha", 0);
    const beta = seedArea(fx.db, "Beta", 1);
    seedTodo(fx.db, { title: "t-alpha", area: alpha, startDate: "2026-07-02" });
    seedTodo(fx.db, { title: "t-beta", area: beta, startDate: "2026-07-02" });
    const { stdout, exitCode } = runCli(["today", "--area", "Alpha", "--json", "--db", fx.path]);
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.meta.filter.area.title).toBe("Alpha");
    const titles = (env.data.items as Array<{ title: string }>).map((i) => i.title);
    expect(titles).toEqual(["t-alpha"]);
  });
});

describe("--area loose (the area-less filter)", () => {
  it("anytime --area loose keeps only the area-less rows; meta.filter.area = loose", () => {
    fx = buildFixtureDb();
    const work = seedArea(fx.db, "Work", 0);
    seedTodo(fx.db, { title: "loose-any" });
    seedTodo(fx.db, { title: "work-any", area: work });
    const { stdout, exitCode } = runCli(["anytime", "--area", "loose", "--json", "--db", fx.path]);
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.meta.filter).toEqual({ area: { uuid: "loose", title: "Loose" } });
    const titles = (env.data.sections as Array<{ items: { title: string }[] }>).flatMap((s) =>
      s.items.map((i) => i.title),
    );
    expect(titles).toEqual(["loose-any"]);
  });

  it("logbook --area loose keeps area-less logged rows (direct + loose-project child)", () => {
    fx = buildFixtureDb();
    const work = seedArea(fx.db, "Work", 0);
    const loosePrj = seedProject(fx.db, { title: "loose-prj" });
    const STOP = 1_500_000_000;
    seedTodo(fx.db, { title: "loose-done", status: "completed", stopDate: STOP });
    seedTodo(fx.db, {
      title: "loose-childdone",
      project: loosePrj,
      status: "completed",
      stopDate: STOP,
    });
    seedTodo(fx.db, { title: "work-done", area: work, status: "completed", stopDate: STOP });
    const { stdout, exitCode } = runCli(["logbook", "--area", "loose", "--json", "--db", fx.path]);
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.meta.filter).toEqual({ area: { uuid: "loose", title: "Loose" } });
    const titles = (env.data.items as Array<{ title: string }>).map((i) => i.title).toSorted();
    expect(titles).toEqual(["loose-childdone", "loose-done"]);
  });

  it("reserved word wins over a real area named Loose, and discloses it in meta.warnings", () => {
    fx = buildFixtureDb();
    const shadow = seedArea(fx.db, "Loose", 0);
    seedTodo(fx.db, { title: "loose-done", status: "completed", stopDate: 1_500_000_000 });
    seedTodo(fx.db, {
      title: "shadow-done",
      area: shadow,
      status: "completed",
      stopDate: 1_500_000_000,
    });
    const { stdout } = runCli(["logbook", "--area", "loose", "--json", "--db", fx.path]);
    const env = JSON.parse(stdout);
    // Filters the NULL area, not the real "Loose" area.
    expect((env.data.items as Array<{ title: string }>).map((i) => i.title)).toEqual([
      "loose-done",
    ]);
    expect((env.meta.warnings as string[]).join(" ")).toContain("loose pseudo-area");
  });
});
