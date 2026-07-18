/**
 * The bare-mutation-verb hint (src/cli/verb-hint.ts): a top-level
 * `things <verb> …` is answered with a namespaced-write suggestion instead of
 * the show-sugar's confusing usage error. Never executes the mutation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { resolveInvocation } from "../../src/cli/resolve-invocation.ts";
import { runVerbHint } from "../../src/cli/verb-hint.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTodo } from "../fixtures/seed.ts";

let fixture: FixtureDb;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  fixture = buildFixtureDb();
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  fixture.close();
  process.exitCode = undefined;
});

/** Drive the real resolver → verb-hint dispatch, as runCli does. */
function dispatch(argv: string[]): void {
  const program = buildProgram();
  const resolved = resolveInvocation(program, [...argv, "--db", fixture.path]);
  expect(resolved.form).toBe("verb-hint");
  runVerbHint(program, resolved.argv);
}

function jsonEnvelope(): Record<string, unknown> {
  return JSON.parse(stdout.join("").trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
}

describe("verb-hint suggestions", () => {
  it("a ref that uniquely resolves as an AREA gets one concrete suggestion", () => {
    seedArea(fixture.db, "Health");
    dispatch(["update", "Health", "--tags", "test"]);
    expect(stderr.join("")).toContain("things area update Health --tags test");
    expect(process.exitCode).toBe(2);
  });

  it("a ref that uniquely resolves as a PROJECT gets one concrete suggestion", () => {
    seedProject(fixture.db, { title: "Firmware" });
    dispatch(["update", "Firmware", "--title", "X"]);
    expect(stderr.join("")).toContain("things project update Firmware --title X");
    expect(process.exitCode).toBe(2);
  });

  it("no ref → a hint listing the namespaced forms + writes signpost", () => {
    dispatch(["update"]);
    const out = stderr.join("");
    expect(out).toContain("things todo update");
    expect(out).toContain("things project update");
    expect(out).toContain("things area update");
    expect(out).toContain("things help writes");
    expect(process.exitCode).toBe(2);
  });

  it("an unresolvable ref → the generic namespaced hint (with the ref echoed)", () => {
    dispatch(["delete", "ghostref"]);
    const out = stderr.join("");
    expect(out).toContain("things todo delete ghostref");
    expect(out).toContain("things project delete ghostref");
    expect(process.exitCode).toBe(2);
  });

  it("an ambiguous ref → the generic hint (never guesses)", () => {
    seedProject(fixture.db, { title: "Dup" });
    seedProject(fixture.db, { title: "Dup" });
    dispatch(["update", "Dup"]);
    const out = stderr.join("");
    // No single 'did you mean' guess — the namespaced forms are listed instead.
    expect(out).toContain("writes are namespaced");
    expect(out).toContain("things project update Dup");
    expect(process.exitCode).toBe(2);
  });

  it("add/create with a title-like arg suggests `todo add` first", () => {
    dispatch(["add", "Buy milk"]);
    const out = stderr.join("");
    const todoIdx = out.indexOf('things todo add "Buy milk"');
    const projIdx = out.indexOf('things project add "Buy milk"');
    expect(todoIdx).toBeGreaterThanOrEqual(0);
    expect(projIdx).toBeGreaterThan(todoIdx); // to-do listed before the containers
    expect(out).toContain('things area add "Buy milk"');
  });

  it("create is a synonym routed to add", () => {
    dispatch(["create", "Buy milk"]);
    expect(stderr.join("")).toContain('things todo add "Buy milk"');
  });

  it("--json carries the suggestions in error.details, code usage, exit 2", () => {
    seedArea(fixture.db, "Health");
    dispatch(["update", "Health", "--tags", "test", "--json"]);
    const env = jsonEnvelope();
    expect(env["ok"]).toBe(false);
    const error = env["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("usage");
    const details = error["details"] as { suggestions?: string[] };
    expect(details.suggestions).toEqual(["things area update Health --tags test"]);
    expect(process.exitCode).toBe(2);
  });

  it("move renders a positional destination behind the flag it belongs to (--area)", () => {
    // `todo move` takes --area/--project/--heading, never a positional dest, so
    // the generic `things todo move X Errands` echo would itself be a usage
    // error. The destination resolves to an area → --area.
    seedTodo(fixture.db, { title: "Buy paint", uuid: "todo-move-1" });
    seedArea(fixture.db, "Errands");
    dispatch(["move", "todo-move-1", "Errands"]);
    expect(stderr.join("")).toContain("things todo move todo-move-1 --area Errands");
    expect(process.exitCode).toBe(2);
  });

  it("move maps a project destination to --project", () => {
    seedTodo(fixture.db, { title: "Buy paint", uuid: "todo-move-2" });
    seedProject(fixture.db, { title: "Kitchen remodel" });
    dispatch(["move", "todo-move-2", "Kitchen remodel"]);
    expect(stderr.join("")).toContain('things todo move todo-move-2 --project "Kitchen remodel"');
  });

  it("move that already uses a container flag is echoed unchanged (no double-rewrite)", () => {
    seedTodo(fixture.db, { title: "Buy paint", uuid: "todo-move-3" });
    seedArea(fixture.db, "Errands");
    dispatch(["move", "todo-move-3", "--area", "Errands"]);
    const out = stderr.join("");
    expect(out).toContain("things todo move todo-move-3 --area Errands");
    // The area name must NOT be re-echoed as a stray positional destination.
    expect(out).not.toContain("--area Errands --area");
    expect(out).not.toContain("--project");
  });

  it("never executes the mutation — only a hint is emitted", () => {
    seedProject(fixture.db, { title: "Firmware" });
    dispatch(["delete", "Firmware"]);
    // No mutation envelope, no 'ok' line — just the suggestion on stderr.
    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toContain("things project delete Firmware");
  });
});
