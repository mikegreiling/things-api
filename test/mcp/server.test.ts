/**
 * Phase 17: MCP surface tests — a real MCP client over an in-memory
 * transport against the real server, backed by a fixture DB and fake write
 * vectors. Proves the third surface is a faithful window onto ThingsClient.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createThingsMcpServer } from "../../src/mcp/server.ts";
import { OPERATION_KINDS } from "../../src/write/operations.ts";
import type { VectorMatrix, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedProject, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");

let fixture: FixtureDb;
let stateDir: string;
let client: Client;
let close: () => Promise<void>;

const URL_MATRIX: VectorMatrix = Object.fromEntries(
  ["todo.add", "todo.update", "todo.complete"].map((op) => [
    op,
    { support: "yes", disruption: 0, validation: "validated" },
  ]),
) as VectorMatrix;

function fakeVector(effect: ((payload: string) => void) | null) {
  const calls: string[] = [];
  const vector: WriteVector = {
    id: "url-scheme",
    matrix: URL_MATRIX,
    async execute(invocation) {
      calls.push(invocation.payload);
      effect?.(invocation.payload);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

async function connect(vectors: WriteVector[]): Promise<void> {
  const env = {
    ...process.env,
    THINGS_DB: fixture.path,
    THINGS_API_STATE_DIR: stateDir,
    THINGS_API_CONFIG_DIR: join(stateDir, "config"),
  };
  const server = createThingsMcpServer({
    dbPath: fixture.path,
    openOptions: {
      env,
      vectors,
      now: () => NOW,
      writeOverrides: { isAppRunning: () => true, ensureRunning: async () => true },
    },
  });
  client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  close = async () => {
    await client.close();
    await server.close();
  };
}

function textOf(result: unknown): unknown {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]?.text ?? "null");
}

beforeEach(() => {
  fixture = buildFixtureDb();
  stateDir = mkdtempSync(join(tmpdir(), "things-api-mcp-test-"));
});
afterEach(async () => {
  await close();
  fixture.close();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("things MCP server", () => {
  it("exposes the full tool surface", async () => {
    await connect([fakeVector(null).vector]);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).toSorted();
    expect(names).toEqual(
      [
        "read_view",
        "search",
        "changes_since",
        "get_item",
        "get_project",
        "list_collections",
        "add_todo",
        "update_todo",
        "complete_todo",
        "add_project",
        "run_operation",
        "batch",
        "reorder",
        "undo",
        "capabilities",
        "doctor",
      ].toSorted(),
    );
  });

  it("read_view today returns the split view with seeded members", async () => {
    seedTodo(fixture.db, { title: "MCP-Today", startDate: "2026-07-05" });
    await connect([fakeVector(null).vector]);
    const result = await client.callTool({ name: "read_view", arguments: { view: "today" } });
    const view = textOf(result) as { today: { title: string }[]; evening: unknown[] };
    expect(view.today.map((i) => i.title)).toContain("MCP-Today");
    expect(result.isError ?? false).toBe(false);
  });

  it("search respects the open-by-default scope", async () => {
    seedTodo(fixture.db, { title: "findable open" });
    seedTodo(fixture.db, { title: "findable done", status: "completed" });
    await connect([fakeVector(null).vector]);
    const open = textOf(
      await client.callTool({ name: "search", arguments: { query: "findable" } }),
    ) as { title: string }[];
    expect(open.map((i) => i.title)).toEqual(["findable open"]);
    const logged = textOf(
      await client.callTool({ name: "search", arguments: { query: "findable", logged: true } }),
    ) as { title: string }[];
    expect(logged).toHaveLength(2);
  });

  it("get_item returns a not-found error for unknown uuids", async () => {
    await connect([fakeVector(null).vector]);
    const result = await client.callTool({ name: "get_item", arguments: { uuid: "nope" } });
    expect(result.isError).toBe(true);
    expect((textOf(result) as { code: string }).code).toBe("not-found");
  });

  it("add_todo executes through the verified pipeline and returns the created uuid", async () => {
    const { vector, calls } = fakeVector(() => {
      seedTodo(fixture.db, {
        uuid: "MCP-NEW",
        title: "From MCP",
        creationDate: Math.floor(NOW.getTime() / 1000),
      });
    });
    await connect([vector]);
    const result = await client.callTool({
      name: "add_todo",
      arguments: { title: "From MCP" },
    });
    expect(result.isError ?? false).toBe(false);
    const outcome = textOf(result) as { kind: string; uuid: string };
    expect(outcome.kind).toBe("ok");
    expect(outcome.uuid).toBe("MCP-NEW");
    expect(calls[0]).toContain("things:///add?title=From%20MCP");
  });

  it("add_todo dry_run plans without executing", async () => {
    const { vector, calls } = fakeVector(null);
    await connect([vector]);
    const result = await client.callTool({
      name: "add_todo",
      arguments: { title: "Plan me", dry_run: true },
    });
    const outcome = textOf(result) as { kind: string; plan: { invocation: string } };
    expect(outcome.kind).toBe("dry-run");
    expect(outcome.plan.invocation).toContain("things:///add?title=Plan%20me");
    expect(calls).toHaveLength(0);
  });

  it("hazard blocks surface as tool errors with remediation", async () => {
    await connect([fakeVector(null).vector]);
    const result = await client.callTool({
      name: "run_operation",
      arguments: { op: "trash.empty", params: {} },
    });
    expect(result.isError).toBe(true);
    const error = textOf(result) as { code: string; remediation: string };
    expect(error.code).toBe("blocked:H-PERMANENT-DELETE");
    expect(error.remediation).toContain("dangerouslyPermanent");
  });

  it("run_operation rejects unknown op kinds at the schema layer", async () => {
    await connect([fakeVector(null).vector]);
    const result = await client.callTool({
      name: "run_operation",
      arguments: { op: "todo.explode", params: {} },
    });
    expect(result.isError).toBe(true);
  });

  it("capabilities dumps the lab matrix for every op kind", async () => {
    await connect([fakeVector(null).vector]);
    const table = textOf(await client.callTool({ name: "capabilities", arguments: {} })) as {
      op: string;
      vectors: { vector: string }[];
    }[];
    expect(table).toHaveLength(OPERATION_KINDS.length);
    expect(table[0]?.vectors.map((v) => v.vector)).toEqual(["url-scheme", "applescript"]);
  });

  it("get_project renders the heading-grouped project view", async () => {
    const proj = seedProject(fixture.db, { title: "MCP Proj" });
    seedTodo(fixture.db, { title: "child", project: proj });
    await connect([fakeVector(null).vector]);
    const view = textOf(
      await client.callTool({ name: "get_project", arguments: { uuid: proj } }),
    ) as { project: { title: string } };
    expect(view.project.title).toBe("MCP Proj");
  });

  it("undo with an empty audit trail returns an empty item list", async () => {
    await connect([fakeVector(null).vector]);
    const items = textOf(
      await client.callTool({ name: "undo", arguments: { dry_run: true } }),
    ) as unknown[];
    expect(items).toEqual([]);
  });
});
