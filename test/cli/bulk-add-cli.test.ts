/**
 * Bulk `todo add` end-to-end through the CLI with the simulator write vector
 * (THINGS_SIM_WRITES fence + a bench-marked fixture), so titles really land and
 * their uuids come back. Covers the variadic / --stdin / --id-only surface, the
 * single-title envelope regression, and the one-undoToken-removes-all summary.
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
  stateDir = mkdtempSync(join(tmpdir(), "things-api-bulk-add-"));
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

function setStdin(text: string): void {
  const readable = Readable.from([Buffer.from(text, "utf8")]);
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

describe("variadic todo add", () => {
  it("creates N to-dos in order with a shared flag on each; prints one ok line per item + a summary", async () => {
    await run(["todo", "add", "First", "Second", "Third", "--notes", "shared"]);
    const out = lines();
    // three ok lines + one summary line
    expect(out).toHaveLength(4);
    expect(out.slice(0, 3).every((l) => l.startsWith("ok todo.add uuid="))).toBe(true);
    expect(out[3]).toMatch(/^added 3\/3 to-dos \(undo all: things undo --txn /);
    // the three rows really landed, in argument order, each with the shared note
    const titles = ["First", "Second", "Third"];
    const uuids = out.slice(0, 3).map((l) => /uuid=([^ ]+)/.exec(l)?.[1] ?? "");
    expect(uuids.map((u) => rowByUuid(u)?.["title"])).toEqual(titles);
    for (const u of uuids) expect(rowByUuid(u)?.["notes"]).toBe("shared");
    expect(process.exitCode).toBe(0);
  });

  it("--id-only prints exactly one uuid per line in creation order and nothing else", async () => {
    await run(["todo", "add", "A", "B", "C", "--id-only"]);
    const out = lines();
    expect(out).toHaveLength(3);
    // every line is a uuid that names a real created row, in order
    expect(out.map((u) => rowByUuid(u)?.["title"])).toEqual(["A", "B", "C"]);
    // no chrome: no "ok "/"added "/JSON leaked onto stdout
    expect(stdout.join("")).not.toMatch(/ok todo\.add|added |summary|\{/);
    expect(process.exitCode).toBe(0);
  });

  it("--json streams a per-line result for each item plus a summary carrying the single undoToken", async () => {
    await run(["todo", "add", "One", "Two", "--json"]);
    const parsed = lines().map((l) => JSON.parse(l));
    expect(parsed.slice(0, 2).map((r) => r.outcome.kind)).toEqual(["ok", "ok"]);
    expect(parsed.slice(0, 2).map((r) => r.index)).toEqual([0, 1]);
    const summary = parsed[2].summary;
    expect(summary.total).toBe(2);
    expect(summary.ok).toBe(2);
    expect(typeof summary.undoToken).toBe("string");
  });

  it("the summary undoToken removes the WHOLE skeleton in one undo", async () => {
    await run(["todo", "add", "keep-a", "keep-b", "--json"]);
    const parsed = lines().map((l) => JSON.parse(l));
    const uuids = parsed.slice(0, 2).map((r) => r.outcome.uuid as string);
    const token = parsed[2].summary.undoToken as string;
    expect(uuids.every((u) => rowByUuid(u)?.["trashed"] === 0)).toBe(true);
    stdout = [];
    await run(["undo", "--txn", token, "--dangerously-permanent"]);
    // both created to-dos are gone (trashed) after the single-token undo
    for (const u of uuids) expect(rowByUuid(u)?.["trashed"]).toBe(1);
  });
});

describe("--stdin titles", () => {
  it("reads newline-delimited titles, skipping blank lines", async () => {
    setStdin("Alpha\n\n   \nBeta\n");
    await run(["todo", "add", "--stdin", "--id-only"]);
    const out = lines();
    expect(out).toHaveLength(2);
    expect(out.map((u) => rowByUuid(u)?.["title"])).toEqual(["Alpha", "Beta"]);
  });
});

describe("single-title regression", () => {
  it("one title keeps today's single mutation-result envelope (not a batch stream)", async () => {
    await run(["todo", "add", "Solo", "--json"]);
    const out = lines();
    expect(out).toHaveLength(1);
    const env = JSON.parse(out[0] as string);
    expect(env.ok).toBe(true);
    expect(env.kind).toBe("mutation-result");
    expect(typeof env.data.uuid).toBe("string");
    expect(rowByUuid(env.data.uuid)?.["title"]).toBe("Solo");
  });

  it("one title with --id-only prints just the new uuid", async () => {
    await run(["todo", "add", "Solo", "--id-only"]);
    const out = lines();
    expect(out).toHaveLength(1);
    expect(rowByUuid(out[0] as string)?.["title"]).toBe("Solo");
  });
});
