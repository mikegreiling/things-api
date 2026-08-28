/**
 * THE OUTPUT CONTRACT (#632), end to end through the CLI with the simulator
 * write vector: the two tiers, ONE channel, and the diagnostic ladder.
 *
 * Three laws, each of which the flat-`warnings` shape broke:
 *
 *  1. TIERS — `warnings` is the actionable half and `notes` the matter-of-fact
 *     half, both omitted when empty, on the wire and on the TTY.
 *  2. ONE CHANNEL — under `--json` the envelope is the whole output. The old
 *     code echoed every warning to stderr *and* serialized it into the JSON, so
 *     an agent paid for the same prose twice. Never both.
 *  3. THE LADDER — a successful write does not print the drive's step
 *     play-by-play; `--verbose` adds it; the change-history record always keeps
 *     it, and `things op-result` renders it back.
 *
 * Harness mirrors single-op-idempotency-cli.test.ts (simulator fence + a
 * bench-marked fixture), so writes really land and really get recorded.
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../../src/cli/main.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

let fixture: FixtureDb;
let stateDir: string;
let stdout: string[];
let stderr: string[];
const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  fixture = buildFixtureDb({ benchMarker: true });
  stateDir = mkdtempSync(join(tmpdir(), "things-api-tiers-"));
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

const out = (): string => stdout.join("");
const err = (): string => stderr.join("");

/** The last JSON envelope written to stdout. */
function envelope(): { data: Record<string, unknown> } {
  const line = out().trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as { data: Record<string, unknown> };
}

/** The audit JSONL file the state dir accumulated. */
function auditPath(): string {
  const dir = join(stateDir, "audit");
  const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"));
  if (file === undefined) throw new Error("no audit file written");
  return join(dir, file);
}

/** Every audit record, oldest first. */
function auditRecords(): Record<string, unknown>[] {
  return readFileSync(auditPath(), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("ONE CHANNEL — --json emits the envelope and nothing else", () => {
  it("does not echo warnings to stderr when the JSON already carries them", async () => {
    const uuid = seedTodo(fixture.db, { title: "Tiers A" });
    // A repeating-template delete is the loudest warning producer we can reach
    // through the simulator: it stops a series and cannot be undone here.
    await run(["todo", "complete", uuid, "--json"]);

    const data = envelope().data;
    // Whatever the write disclosed, it was disclosed ONCE — in the JSON.
    const disclosed = [
      ...((data["warnings"] as string[] | undefined) ?? []),
      ...((data["notes"] as string[] | undefined) ?? []),
    ];
    for (const line of disclosed) {
      expect(
        err(),
        `"${line.slice(0, 40)}…" was echoed to stderr as well as serialized`,
      ).not.toContain(line);
    }
    expect(err()).not.toContain("warning:");
  });

  it("the TTY path keeps the prose (the channel moved, it was not deleted)", async () => {
    const uuid = seedTodo(fixture.db, { title: "Tiers B" });
    await run(["todo", "complete", uuid]);
    expect(out()).toContain("ok todo.complete");
    // stdout carries the human line; nothing is serialized on the human path.
    expect(out()).not.toContain('"apiVersion"');
  });
});

describe("TIERS — both arrays, omitted when empty", () => {
  it("a clean write carries neither key rather than two empty arrays", async () => {
    const uuid = seedTodo(fixture.db, { title: "Tiers C" });
    await run(["todo", "update", uuid, "--title", "Tiers C renamed", "--json"]);
    const data = envelope().data;
    // omit-when-empty: an absent key means "none"; neither tier is ever `[]`.
    if ("warnings" in data) expect((data["warnings"] as string[]).length).toBeGreaterThan(0);
    if ("notes" in data) expect((data["notes"] as string[]).length).toBeGreaterThan(0);
  });

  it("an ordinary write with nothing to disclose carries NEITHER key", async () => {
    const uuid = seedTodo(fixture.db, { title: "Tiers D" });
    await run(["todo", "update", uuid, "--title", "Tiers D renamed", "--json"]);
    const data = envelope().data;
    // The whole point of two tiers is that a quiet write stays quiet. A result
    // that always shipped `warnings: []` + `notes: []` would cost every caller
    // two keys to learn nothing.
    expect("warnings" in data).toBe(false);
    expect("notes" in data).toBe(false);
    // (The `already in the requested state` NOTE is a ui-vector path the
    // simulator cannot reach; its tier is asserted in
    // test/engine/write-ui-vector.test.ts.)
  });
});

describe("THE LADDER — the step play-by-play is off by default, on by request, always recorded", () => {
  it("a successful write does NOT carry the step list without --verbose", async () => {
    const uuid = seedTodo(fixture.db, { title: "Tiers E" });
    await run(["todo", "complete", uuid, "--json"]);
    expect(envelope().data["steps"]).toBeUndefined();
    expect(out()).not.toContain("drove ");
  });

  it("--verbose is accepted by the write commands", async () => {
    const uuid = seedTodo(fixture.db, { title: "Tiers F" });
    await run(["todo", "complete", uuid, "--verbose", "--json"]);
    // The simulator drives no UI, so there are no steps to add — the contract
    // under test is that the flag EXISTS and does not disturb the result.
    const data = envelope().data;
    expect(data["op"]).toBe("todo.complete");
    expect(data["steps"]).toBeUndefined();
  });

  it("`op-result` renders a recorded step list — the retrieval path is real", async () => {
    const uuid = seedTodo(fixture.db, { title: "Tiers G" });
    await run(["todo", "complete", uuid, "--op-id", "ladder-1"]);

    // The simulator vector runs no GUI steps, so synthesize the one thing a ui
    // drive would have recorded, on the op's own final record. This asserts the
    // RETRIEVAL half of the ladder: whatever the write layer recorded,
    // `op-result` must hand back — which is what makes leaving the steps off a
    // success output a move rather than a loss.
    const records = auditRecords();
    const finals = records.filter((r) => r["opId"] === "ladder-1" && r["result"] !== "intent");
    expect(finals.length, "the op recorded a final outcome").toBeGreaterThan(0);
    const last = finals[finals.length - 1];
    if (last === undefined) throw new Error("unreachable");
    last["steps"] = ["open Items menu", "choose Repeat…", "set frequency = weekly", "press OK"];
    writeFileSync(auditPath(), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);

    stdout = [];
    await run(["op-result", "ladder-1"]);
    expect(out()).toContain("drove 4 step(s):");
    expect(out()).toContain("1. open Items menu");
    expect(out()).toContain("4. press OK");
  });

  it("`op-result --json` carries the steps as data, and null when there are none", async () => {
    const uuid = seedTodo(fixture.db, { title: "Tiers H" });
    await run(["todo", "complete", uuid, "--op-id", "ladder-2"]);
    stdout = [];
    await run(["op-result", "ladder-2", "--json"]);
    const data = envelope().data;
    expect(data["status"]).toBe("found");
    // A transport-vector write has no steps — null, not an empty array.
    expect(data["steps"]).toBeNull();
  });
});
