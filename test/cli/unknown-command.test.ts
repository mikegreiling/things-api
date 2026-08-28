/**
 * The unknown-command error (src/cli/unknown-command.ts): a top-level
 * `things <token> <more…>` whose first token names no command CANNOT be the
 * bare-noun sugar — a reference occupies exactly one positional — so it is
 * answered by name with a did-you-mean over the command vocabulary instead of
 * an arity error against a `things show` the caller never typed.
 *
 * The neighbours it must NOT disturb are pinned here too: an explicit
 * `things show <bad-ref>` keeps its ref-flavored did-you-mean, a genuine
 * implied-show still renders, and a lone unmatched token still resolves as a
 * reference (and fails as a not-found when nothing matches).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { resolveInvocation } from "../../src/cli/resolve-invocation.ts";
import { runUnknownCommand } from "../../src/cli/unknown-command.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject } from "../fixtures/seed.ts";

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

/**
 * Drive the real router exactly as `runCli` does: resolve, dispatch the
 * unknown-command form to its handler, otherwise let commander parse.
 */
function run(argv: string[]): void {
  const program = buildProgram();
  program.exitOverride();
  const resolved = resolveInvocation(program, [...argv, "--db", fixture.path]);
  if (resolved.form === "unknown-command") {
    runUnknownCommand(program, resolved.argv);
    return;
  }
  try {
    program.parse(resolved.argv, { from: "user" });
  } catch {
    // commander's exitOverride throws on usage errors; the exit code is asserted
  }
}

function jsonEnvelope(): Record<string, unknown> {
  return JSON.parse(stdout.join("").trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
}

describe("an unmatched first token with trailing arguments", () => {
  it("`things to-do <ref>` names the token and suggests the command (the ruled case)", () => {
    seedArea(fixture.db, "Hobbies");
    run(["to-do", "Hobbies"]);
    const out = stderr.join("");
    expect(out).toContain("error: invalid command or ref: 'to-do'");
    expect(out).toContain("did you mean: things todo Hobbies");
    // The old arity message named a command the caller never typed.
    expect(out).not.toContain("things show");
    expect(process.exitCode).toBe(2);
  });

  it("the suggestion echoes the caller's own trailing tokens verbatim", () => {
    run(["todya", "Hobbies", "--json"]);
    const message = String((jsonEnvelope()["error"] as Record<string, unknown>)["message"] ?? "");
    expect(message).toContain("invalid command or ref: 'todya'");
    expect(message).toContain("things today Hobbies --json");
  });

  it("a token near NO command gets the bare error, never a misleading guess", () => {
    run(["zzzqqq", "Hobbies"]);
    const out = stderr.join("");
    expect(out).toContain("error: invalid command or ref: 'zzzqqq'");
    expect(out).not.toContain("did you mean");
    expect(process.exitCode).toBe(2);
  });

  it("a SHORT token is held to a tighter radius (two edits is most of the word)", () => {
    run(["ibx", "Hobbies"]);
    const out = stderr.join("");
    expect(out).toContain("error: invalid command or ref: 'ibx'");
    expect(out).not.toContain("did you mean");
  });

  it("`--json` carries the suggestions on error.detail, code usage", () => {
    run(["to-do", "Hobbies", "--json"]);
    const envelope = jsonEnvelope();
    const error = envelope["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("usage");
    expect(String(error["message"])).toContain("invalid command or ref: 'to-do'");
    const detail = error["detail"] as { suggestions?: string[] };
    expect(detail.suggestions?.[0]).toContain("things todo Hobbies");
    expect(process.exitCode).toBe(2);
  });

  it("a leading global flag does not hide the token (`things --json to-do <ref>`)", () => {
    run(["--json", "to-do", "Hobbies"]);
    const error = jsonEnvelope()["error"] as Record<string, unknown>;
    expect(String(error["message"])).toContain("invalid command or ref: 'to-do'");
    expect(process.exitCode).toBe(2);
  });

  it("a ref-shaped token with a stray extra positional is named too", () => {
    seedArea(fixture.db, "Hobbies");
    run(["Hobbies", "extra"]);
    expect(stderr.join("")).toContain("error: invalid command or ref: 'Hobbies'");
    expect(process.exitCode).toBe(2);
  });
});

describe("the neighbours it must not disturb", () => {
  it("a genuine implied-show still renders the entity", () => {
    seedProject(fixture.db, { title: "Firmware" });
    run(["Firmware"]);
    expect(stdout.join("")).toContain("Firmware");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("a lone unmatched token keeps the bare-noun not-found + did-you-mean", () => {
    seedArea(fixture.db, "Hobbies");
    run(["to-do"]);
    const out = stderr.join("");
    expect(out).toContain('no command or item named "to-do"');
    expect(out).toContain("things search 'to-do'");
    expect(out).not.toContain("invalid command or ref");
    expect(process.exitCode).toBe(2);
  });

  it("explicit `things show <bad-ref>` keeps its ref-flavored error", () => {
    seedArea(fixture.db, "Hobbies");
    run(["show", "to-do"]);
    const out = stderr.join("");
    expect(out).not.toContain("invalid command or ref");
    expect(out).not.toContain("no command or item named");
    expect(out).toContain("things search 'to-do'");
    expect(process.exitCode).toBe(2);
  });

  it("flag values are not positionals: a bare ref with option arguments still routes", () => {
    seedArea(fixture.db, "Hobbies");
    run(["Hobbies", "--area-limit", "3"]);
    expect(stderr.join("")).not.toContain("invalid command or ref");
    expect(stdout.join("")).toContain("Hobbies");
  });
});
