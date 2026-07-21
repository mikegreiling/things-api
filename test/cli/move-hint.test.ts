/**
 * The scheduling-intent hint for a namespaced `move` (src/cli/move-hint.ts):
 * `things todo move <ref>` / `things project move <ref>` carrying scheduling
 * vocabulary are answered with the command that actually schedules an item
 * (`update --when`) or returns it to the Inbox (`move --inbox`), instead of a
 * bare unknown-option / excess-argument usage error. A valid container move is
 * never intercepted. The hint reads the argv only — it never opens the db.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { detectMoveHint, runMoveHint } from "../../src/cli/move-hint.ts";

let stdout: string[];
let stderr: string[];

beforeEach(() => {
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
  process.exitCode = undefined;
});

/** Classify + (when trapped) emit, exactly as runCli does before commander parses. */
function dispatch(argv: string[]): ReturnType<typeof detectMoveHint> {
  const program = buildProgram();
  const hint = detectMoveHint(program, argv);
  if (hint !== null) runMoveHint(hint);
  return hint;
}

function jsonEnvelope(): Record<string, unknown> {
  return JSON.parse(stdout.join("").trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
}

describe("todo move scheduling-intent hint", () => {
  // Every unknown-flag spelling an agent reaches for when it means "schedule".
  const SCHEDULING_FLAGS: [string[], string][] = [
    [["--to", "someday"], "someday"],
    [["--when", "today"], "today"],
    [["--when=evening"], "evening"],
    [["--someday"], "someday"],
    [["--today"], "today"],
    [["--evening"], "evening"],
    [["--anytime"], "anytime"],
    [["--date", "2026-07-20"], "2026-07-20"],
    [["--schedule", "someday"], "someday"],
  ];

  it.each(SCHEDULING_FLAGS)("flag %s → update --when %s, exit 2", (flag, expectedWhen) => {
    const hint = dispatch(["todo", "move", "todo-1", ...flag]);
    expect(hint).not.toBeNull();
    const out = stderr.join("");
    expect(out).toContain(`things todo update todo-1 --when ${expectedWhen}`);
    expect(out).toContain("changes an item's container, not its schedule");
    expect(process.exitCode).toBe(2);
  });

  // Every bare positional destination an agent reaches for when it means "schedule".
  const SCHEDULING_POSITIONALS = ["someday", "today", "evening", "anytime", "2026-07-20"];

  it.each(SCHEDULING_POSITIONALS)("positional %s → update --when, exit 2", (term) => {
    const hint = dispatch(["todo", "move", "todo-1", term]);
    expect(hint).not.toBeNull();
    expect(stderr.join("")).toContain(`things todo update todo-1 --when ${term}`);
    expect(process.exitCode).toBe(2);
  });

  it("bare `inbox` positional points at the real Inbox-return flag (--inbox)", () => {
    const hint = dispatch(["todo", "move", "todo-1", "inbox"]);
    expect(hint?.intent).toBe("inbox");
    const out = stderr.join("");
    expect(out).toContain("things todo move todo-1 --inbox");
    expect(out).not.toContain("--when inbox"); // not a thing
    expect(process.exitCode).toBe(2);
  });

  it("a missing ref renders the `<ref>` placeholder", () => {
    dispatch(["todo", "move", "--when", "someday"]);
    expect(stderr.join("")).toContain("things todo update <ref> --when someday");
  });

  it("--json carries the suggestion in error.details, code usage, exit 2", () => {
    const hint = dispatch(["todo", "move", "todo-1", "--when", "today", "--json"]);
    expect(hint).not.toBeNull();
    const env = jsonEnvelope();
    expect(env["ok"]).toBe(false);
    const error = env["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("usage");
    const details = error["details"] as { suggestions?: string[] };
    expect(details.suggestions).toEqual(["things todo update todo-1 --when today"]);
    expect(process.exitCode).toBe(2);
  });

  it("leading global flags are transparent (`--json todo move …`)", () => {
    const hint = dispatch(["--json", "todo", "move", "todo-1", "--someday"]);
    expect(hint).not.toBeNull();
    const details = (jsonEnvelope()["error"] as { details?: { suggestions?: string[] } }).details;
    expect(details?.suggestions).toEqual(["things todo update todo-1 --when someday"]);
  });
});

describe("project move scheduling-intent hint", () => {
  it("a scheduling flag → project update --when, exit 2", () => {
    const hint = dispatch(["project", "move", "proj-1", "--when", "someday"]);
    expect(hint).not.toBeNull();
    expect(stderr.join("")).toContain("things project update proj-1 --when someday");
    expect(process.exitCode).toBe(2);
  });

  it("a scheduling positional → project update --when, exit 2", () => {
    dispatch(["project", "move", "proj-1", "anytime"]);
    expect(stderr.join("")).toContain("things project update proj-1 --when anytime");
    expect(process.exitCode).toBe(2);
  });

  it("`inbox` is NOT trapped for a project (no project Inbox) — commander handles it", () => {
    const hint = dispatch(["project", "move", "proj-1", "inbox"]);
    expect(hint).toBeNull();
    expect(process.exitCode).toBeUndefined();
  });
});

describe("valid moves are never intercepted", () => {
  it.each([
    ["container area move", ["todo", "move", "todo-1", "--area", "Errands"]],
    ["container project move", ["todo", "move", "todo-1", "--project", "Kitchen"]],
    ["real --inbox flag", ["todo", "move", "todo-1", "--inbox"]],
    ["real --detach flag", ["todo", "move", "todo-1", "--detach"]],
    ["a heading literally named 'someday'", ["todo", "move", "todo-1", "--heading", "someday"]],
    ["an area literally named 'today'", ["todo", "move", "todo-1", "--area", "today"]],
    ["a plain ref with no destination", ["todo", "move", "todo-1"]],
    ["project area move", ["project", "move", "proj-1", "--area", "Work"]],
    ["a non-move todo subcommand", ["todo", "update", "todo-1", "--when", "someday"]],
  ])("%s → not trapped (falls through to commander)", (_label, argv) => {
    const hint = dispatch(argv);
    expect(hint).toBeNull();
    expect(process.exitCode).toBeUndefined();
  });
});

describe("hint copy passes the surface-copy banned vocabulary", () => {
  // Rule 2 (docs/design/surface-copy.md): no pipeline vocabulary in the copy a
  // consumer reads. The hint is diagnostic output, but it should still be clean.
  const BANNED = [
    /\bH-[A-Z][A-Z-]+\b/,
    /\b[A-Z]\d{2}[A-Z]?\b/,
    /vector:/,
    /\btier \d\b/i,
    /\bhazard/i,
    /read-after-write/,
    /\baudit\b/i,
    /\b(?:unprobed|probed|unvalidated|validated)\b/i,
    /\bsdef\b/,
    /\bpipeline\b/i,
    /\bfingerprint\b/i,
    /\bdrift\b/i,
    /\bprobe\b/i,
  ];

  it.each([
    ["schedule flag", ["todo", "move", "todo-1", "--when", "today"]],
    ["schedule positional", ["todo", "move", "todo-1", "someday"]],
    ["inbox positional", ["todo", "move", "todo-1", "inbox"]],
    ["project schedule", ["project", "move", "proj-1", "--when", "someday"]],
  ])("%s hint text is clean", (_label, argv) => {
    dispatch(argv);
    const text = stderr.join("");
    for (const pattern of BANNED) expect(text).not.toMatch(pattern);
  });
});
