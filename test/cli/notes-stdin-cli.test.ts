/**
 * `--notes -` — the note body read from STDIN — end-to-end through the CLI with
 * the simulator write vector, so the body really lands on the row. Covers the
 * happy path on an add and an update, the TTY refusal (nothing is piped in, so
 * the command must say so rather than hang), the collision with `todo add
 * --stdin` (both want the same stream), and the plain `--notes <text>` path,
 * which must be untouched — including a literal value that merely starts with a
 * dash-free body and one containing real newlines.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";

let fixture: FixtureDb;
let stateDir: string;
let stdout: string[];
let stderr: string[];
const envBackup: Record<string, string | undefined> = {};
let stdinDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  fixture = buildFixtureDb({ benchMarker: true });
  stateDir = mkdtempSync(join(tmpdir(), "things-api-notes-stdin-"));
  for (const key of [
    "THINGS_DB",
    "THINGS_SIM_WRITES",
    "THINGS_API_STATE_DIR",
    "THINGS_API_CONFIG_DIR",
  ]) {
    envBackup[key] = process.env[key];
  }
  process.env["THINGS_DB"] = fixture.path;
  process.env["THINGS_SIM_WRITES"] = "1";
  process.env["THINGS_API_STATE_DIR"] = stateDir;
  process.env["THINGS_API_CONFIG_DIR"] = join(stateDir, "config");
  stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
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
  if (stdinDescriptor !== undefined) Object.defineProperty(process, "stdin", stdinDescriptor);
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fixture.close();
  rmSync(stateDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

async function run(argv: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(["node", "things", ...argv]);
}

/** A piped stdin carrying `text` (never a TTY). */
function setStdin(text: string): void {
  const readable = Readable.from([Buffer.from(text, "utf8")]);
  Object.defineProperty(process, "stdin", { value: readable, configurable: true });
}

/** A stdin that IS a terminal: readable in principle, but nobody is typing. */
function setTtyStdin(): void {
  const readable = Readable.from([]) as Readable & { isTTY?: boolean };
  readable.isTTY = true;
  Object.defineProperty(process, "stdin", { value: readable, configurable: true });
}

const lines = (): string[] =>
  stdout
    .join("")
    .trim()
    .split("\n")
    .filter((l) => l !== "");

const rowByUuid = (uuid: string): Record<string, unknown> | undefined =>
  fixture.db.prepare("SELECT * FROM TMTask WHERE uuid = ?").get(uuid) as
    | Record<string, unknown>
    | undefined;

/** Create via `todo add --json` and return the new uuid. */
async function addTodo(argv: string[]): Promise<string> {
  await run(["todo", "add", ...argv, "--json"]);
  const env = JSON.parse(lines()[0] as string);
  expect(env.ok, JSON.stringify(env)).toBe(true);
  stdout = [];
  return env.data.uuid as string;
}

const MULTILINE = "# Heading\n\n- one\n- two\n\nhttps://example.com/page";

describe("--notes - reads the body from stdin", () => {
  it("todo add lands the whole piped body, newlines intact", async () => {
    setStdin(`${MULTILINE}\n`);
    const uuid = await addTodo(["Piped", "--notes", "-"]);
    expect(rowByUuid(uuid)?.["notes"]).toBe(MULTILINE);
    expect(process.exitCode).toBe(0);
  });

  it("exactly ONE trailing newline is dropped; interior blank lines survive", async () => {
    setStdin("first\n\nlast\n\n");
    const uuid = await addTodo(["Trailing", "--notes", "-"]);
    // the heredoc's own final newline goes; the blank line before "last" and the
    // one after it stay, because they are content.
    expect(rowByUuid(uuid)?.["notes"]).toBe("first\n\nlast\n");
  });

  it("todo update replaces the notes body from stdin", async () => {
    const uuid = await addTodo(["Target", "--notes", "old body"]);
    setStdin("new body\nsecond line\n");
    await run(["todo", "update", uuid, "--notes", "-"]);
    expect(rowByUuid(uuid)?.["notes"]).toBe("new body\nsecond line");
    expect(process.exitCode).toBe(0);
  });

  it("project add lands the piped body too", async () => {
    setStdin(`${MULTILINE}\n`);
    await run(["project", "add", "Piped project", "--notes", "-", "--json"]);
    const env = JSON.parse(lines()[0] as string);
    expect(env.ok).toBe(true);
    expect(rowByUuid(env.data.uuid)?.["notes"]).toBe(MULTILINE);
  });

  it("an empty stdin is an empty note, not a refusal", async () => {
    setStdin("");
    const uuid = await addTodo(["Empty", "--notes", "-"]);
    expect(rowByUuid(uuid)?.["notes"]).toBe("");
    expect(process.exitCode).toBe(0);
  });
});

describe("--notes - refusals", () => {
  it("refuses when stdin is a terminal, naming both working spellings (exit 2)", async () => {
    setTtyStdin();
    await run(["todo", "add", "Nope", "--notes", "-"]);
    const err = stderr.join("");
    expect(err).toContain("--notes - reads the note body from stdin");
    expect(err).toContain("stdin is a terminal");
    expect(err).toContain("--notes $'line 1\\nline 2'");
    expect(process.exitCode).toBe(2);
    // nothing was created
    expect(stdout.join("")).toBe("");
  });

  it("refuses --notes - together with --stdin: both read the same stream (exit 2)", async () => {
    setStdin("A\nB\n");
    await run(["todo", "add", "--stdin", "--notes", "-"]);
    expect(stderr.join("")).toContain("--notes - and --stdin both read stdin");
    expect(process.exitCode).toBe(2);
  });

  it("the TTY refusal rides --json as a usage envelope on stdout", async () => {
    setTtyStdin();
    await run(["todo", "add", "Nope", "--notes", "-", "--json"]);
    const env = JSON.parse(lines()[0] as string);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("usage");
    expect(env.error.message).toContain("stdin is a terminal");
    expect(process.exitCode).toBe(2);
  });
});

describe("plain --notes is unchanged", () => {
  it("a literal value lands verbatim and never touches stdin", async () => {
    setTtyStdin(); // a TTY stdin must not matter when the value is not "-"
    const uuid = await addTodo(["Literal", "--notes", "just a body"]);
    expect(rowByUuid(uuid)?.["notes"]).toBe("just a body");
    expect(process.exitCode).toBe(0);
  });

  it("a value with real newlines (the $'…' idiom) lands verbatim", async () => {
    setTtyStdin();
    const uuid = await addTodo(["Inline", "--notes", "line 1\nline 2"]);
    expect(rowByUuid(uuid)?.["notes"]).toBe("line 1\nline 2");
  });

  it("a value that merely CONTAINS a dash is not a stdin request", async () => {
    setTtyStdin();
    const uuid = await addTodo(["Dashy", "--notes", "- a bullet"]);
    expect(rowByUuid(uuid)?.["notes"]).toBe("- a bullet");
  });
});
