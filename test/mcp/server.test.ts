/**
 * MCP surface tests — a real MCP client over an in-memory transport against
 * the real server, backed by a fixture DB and fake write vectors. Proves the
 * third surface is a faithful window onto ThingsClient, that the grouped v2
 * tools route to the right operations, and that every description obeys the
 * consumer-voice contract (docs/design/surface-copy.md).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createThingsMcpServer } from "../../src/mcp/server.ts";
import { OPERATION_KINDS } from "../../src/write/operations.ts";
import type { VectorId, VectorMatrix, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTag, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");

let fixture: FixtureDb;
let stateDir: string;
let client: Client;
let close: () => Promise<void>;

const DEFAULT_OPS = ["todo.add", "todo.update", "todo.complete"];

function fakeVector(
  effect: ((payload: string) => void) | null,
  opts: { id?: VectorId; ops?: string[] } = {},
) {
  const matrix = Object.fromEntries(
    (opts.ops ?? DEFAULT_OPS).map((op) => [
      op,
      { support: "yes", disruption: 0, validation: "validated" },
    ]),
  ) as VectorMatrix;
  const calls: string[] = [];
  const vector: WriteVector = {
    id: opts.id ?? "url-scheme",
    matrix,
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

const EXPECTED_TOOLS = [
  "add_logged_todo",
  "backdate_todo",
  "archive_heading",
  "get_area",
  "create_heading",
  "rename_heading",
  "unarchive_heading",
  "clear_reminder",
  // reads
  "read_view",
  "search",
  "changes_since",
  "get_item",
  "get_project",
  "list_collections",
  // to-dos
  "add_todo",
  "update_todo",
  "set_todo_status",
  "move_todo",
  "set_tags",
  "edit_checklist",
  // to-dos AND projects
  "delete_item",
  "restore_item",
  "duplicate_item",
  // projects
  "add_project",
  "update_project",
  "set_project_status",
  "move_project",
  // areas
  "add_area",
  "update_area",
  "delete_area",
  // tags
  "add_tag",
  "update_tag",
  "delete_tag",
  // generic + discovery
  "run_operation",
  "batch",
  "reorder",
  "undo",
  "capabilities",
  "doctor",
];

describe("things MCP server", () => {
  it("exposes the full tool surface", async () => {
    await connect([fakeVector(null).vector]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual(EXPECTED_TOOLS.toSorted());
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

  it("read_view caps at 50 by default and reports pagination in a second block", async () => {
    for (let i = 0; i < 60; i++)
      seedTodo(fixture.db, { title: `cap ${i}`, start: "inbox", index: i });
    await connect([fakeVector(null).vector]);
    const result = await client.callTool({ name: "read_view", arguments: { view: "inbox" } });
    const data = textOf(result) as unknown[];
    expect(data).toHaveLength(50);
    const content = (result as { content: { text: string }[] }).content;
    const meta = JSON.parse(content[1]?.text ?? "{}") as {
      pagination: { shown: number; total: number; truncated: boolean };
      note: string;
    };
    expect(meta.pagination).toEqual({ shown: 50, total: 60, limit: 50, truncated: true });
    expect(meta.note).toContain("showing 50 of 60");
  });

  it("read_view all: true lifts the cap; limit overrides it", async () => {
    for (let i = 0; i < 60; i++)
      seedTodo(fixture.db, { title: `cap ${i}`, start: "inbox", index: i });
    await connect([fakeVector(null).vector]);
    const all = textOf(
      await client.callTool({ name: "read_view", arguments: { view: "inbox", all: true } }),
    ) as unknown[];
    expect(all).toHaveLength(60);
    const limited = textOf(
      await client.callTool({ name: "read_view", arguments: { view: "inbox", limit: 10 } }),
    ) as unknown[];
    expect(limited).toHaveLength(10);
    const conflict = await client.callTool({
      name: "read_view",
      arguments: { view: "inbox", limit: 10, all: true },
    });
    expect(conflict.isError).toBe(true);
    expect((textOf(conflict) as { code: string }).code).toBe("usage");
  });

  it("read_view anytime previews 3 per project block by default; all lifts every cap", async () => {
    const area = seedArea(fixture.db, "Hobbies");
    const proj = seedProject(fixture.db, { title: "Firmware", area, index: 1 });
    for (let i = 0; i < 8; i++) seedTodo(fixture.db, { title: `fw ${i}`, project: proj, index: i });
    await connect([fakeVector(null).vector]);

    const result = await client.callTool({ name: "read_view", arguments: { view: "anytime" } });
    const content = (result as { content: { text: string }[] }).content;
    const meta = JSON.parse(content[1]?.text ?? "{}") as {
      grouped: {
        truncated: boolean;
        blocks: { title: string; shown: number; total: number; limit: number | null }[];
      };
      note: string;
    };
    expect(meta.grouped.truncated).toBe(true);
    expect(meta.grouped.blocks).toContainEqual(
      expect.objectContaining({ kind: "project", title: "Firmware", shown: 3, total: 8, limit: 3 }),
    );
    expect(meta.note).toContain("per block");

    const wider = await client.callTool({
      name: "read_view",
      arguments: { view: "anytime", project_limit: 5 },
    });
    const widerMeta = JSON.parse(
      (wider as { content: { text: string }[] }).content[1]?.text ?? "{}",
    ) as { grouped: { blocks: { title: string | null; shown: number }[] } };
    expect(widerMeta.grouped.blocks.find((b) => b.title === "Firmware")?.shown).toBe(5);

    const all = await client.callTool({
      name: "read_view",
      arguments: { view: "anytime", all: true },
    });
    const allMeta = JSON.parse(
      (all as { content: { text: string }[] }).content[1]?.text ?? "{}",
    ) as { grouped: { truncated: boolean } };
    expect(allMeta.grouped.truncated).toBe(false);
  });

  it("read_view someday: numeric active_project_items caps that section; limit rejected on grouped views", async () => {
    const area = seedArea(fixture.db, "Hobbies");
    const active = seedProject(fixture.db, { title: "Active Proj", area, index: 1 });
    for (let i = 0; i < 4; i++) {
      seedTodo(fixture.db, {
        title: `parked ${i}`,
        project: active,
        start: "someday",
        index: 10 + i,
      });
    }
    await connect([fakeVector(null).vector]);

    const capped = await client.callTool({
      name: "read_view",
      arguments: { view: "someday", active_project_items: 2 },
    });
    const meta = JSON.parse(
      (capped as { content: { text: string }[] }).content[1]?.text ?? "{}",
    ) as {
      grouped: { blocks: { kind: string; title: string | null; shown: number; total: number }[] };
    };
    expect(meta.grouped.blocks).toContainEqual(
      expect.objectContaining({ kind: "project", title: "Active Proj", shown: 2, total: 4 }),
    );

    // Absent toggle: no children in the data at all.
    const hidden = textOf(
      await client.callTool({ name: "read_view", arguments: { view: "someday" } }),
    ) as { items: { title: string }[] }[];
    expect(hidden.flatMap((s) => s.items.map((i) => i.title))).not.toContain("parked 0");

    for (const args of [
      { view: "anytime", limit: 10 },
      { view: "someday", limit: 10 },
      { view: "inbox", area_limit: 10 },
      { view: "someday", project_limit: 5 },
      { view: "inbox", active_project_items: true },
    ]) {
      const bad = await client.callTool({ name: "read_view", arguments: args });
      expect(bad.isError, JSON.stringify(args)).toBe(true);
      expect((textOf(bad) as { code: string }).code).toBe("usage");
    }
  });

  it("get_item returns a not-found error for unknown uuids", async () => {
    await connect([fakeVector(null).vector]);
    const result = await client.callTool({ name: "get_item", arguments: { uuid: "nope" } });
    expect(result.isError).toBe(true);
    expect((textOf(result) as { code: string }).code).toBe("not-found");
  });

  it("add_todo executes and returns the created uuid", async () => {
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

  it("set_todo_status routes each status to the matching operation", async () => {
    const uuid = seedTodo(fixture.db, { title: "status me" });
    await connect([
      fakeVector(null, { ops: ["todo.complete", "todo.cancel", "todo.reopen"] }).vector,
    ]);
    for (const [status, op] of [
      ["completed", "todo.complete"],
      ["canceled", "todo.cancel"],
    ] as const) {
      const outcome = textOf(
        await client.callTool({
          name: "set_todo_status",
          arguments: { uuid, status, dry_run: true },
        }),
      ) as { kind: string; op: string };
      expect(outcome.kind).toBe("dry-run");
      expect(outcome.op).toBe(op);
    }
  });

  it("move_todo demands exactly one destination", async () => {
    await connect([fakeVector(null).vector]);
    for (const args of [
      { uuid: "X" },
      { uuid: "X", to_inbox: true, detach: true },
      { uuid: "X", project: "P", detach: true },
    ]) {
      const result = await client.callTool({ name: "move_todo", arguments: args });
      expect(result.isError).toBe(true);
      expect((textOf(result) as { code: string }).code).toBe("usage");
    }
  });

  it("edit_checklist add plans a stateful rewrite; missing fields are usage errors", async () => {
    const uuid = seedTodo(fixture.db, { title: "listy" });
    await connect([fakeVector(null, { ops: ["todo.replace-checklist"] }).vector]);
    const outcome = textOf(
      await client.callTool({
        name: "edit_checklist",
        arguments: { uuid, action: "add", title: "step one", dry_run: true },
      }),
    ) as { kind: string; op: string; plan: { invocation: string } };
    expect(outcome.kind).toBe("dry-run");
    // The granular edit is audited as its own op; its delivery is the rewrite.
    expect(outcome.op).toBe("todo.edit-checklist-item");
    expect(outcome.plan.invocation).toContain("things:///json");

    const missing = await client.callTool({
      name: "edit_checklist",
      arguments: { uuid, action: "rename", item: "step one" },
    });
    expect(missing.isError).toBe(true);
    expect((textOf(missing) as { code: string }).code).toBe("usage");
  });

  it("delete_item dispatches on the item's type", async () => {
    const todo = seedTodo(fixture.db, { title: "trash to-do" });
    const proj = seedProject(fixture.db, { title: "trash project" });
    await connect([
      fakeVector(null, { id: "applescript", ops: ["todo.delete", "project.delete"] }).vector,
    ]);
    for (const [uuid, op] of [
      [todo, "todo.delete"],
      [proj, "project.delete"],
    ] as const) {
      const outcome = textOf(
        await client.callTool({ name: "delete_item", arguments: { uuid, dry_run: true } }),
      ) as { kind: string; op: string };
      expect(outcome.kind).toBe("dry-run");
      expect(outcome.op).toBe(op);
    }
    const unknown = await client.callTool({
      name: "delete_item",
      arguments: { uuid: "missing", dry_run: true },
    });
    expect(unknown.isError).toBe(true);
    expect((textOf(unknown) as { code: string }).code).toBe("usage");
  });

  it("set_project_status enforces the children policy per status", async () => {
    const proj = seedProject(fixture.db, { title: "lifecycle" });
    await connect([
      fakeVector(null, { ops: ["project.complete", "project.cancel", "project.reopen"] }).vector,
    ]);
    const noPolicy = await client.callTool({
      name: "set_project_status",
      arguments: { uuid: proj, status: "completed" },
    });
    expect(noPolicy.isError).toBe(true);
    expect((textOf(noPolicy) as { message: string }).message).toContain("require-resolved");

    const wrongPolicy = await client.callTool({
      name: "set_project_status",
      arguments: { uuid: proj, status: "canceled", children: "auto-complete" },
    });
    expect(wrongPolicy.isError).toBe(true);

    const completed = textOf(
      await client.callTool({
        name: "set_project_status",
        arguments: { uuid: proj, status: "completed", children: "auto-complete", dry_run: true },
      }),
    ) as { kind: string; op: string };
    expect(completed.kind).toBe("dry-run");
    expect(completed.op).toBe("project.complete");
  });

  it("set_project_status open returns the reopen outcome with children detail", async () => {
    const proj = seedProject(fixture.db, { title: "reopen me", status: "completed" });
    await connect([fakeVector(null, { ops: ["project.reopen"] }).vector]);
    const outcome = textOf(
      await client.callTool({
        name: "set_project_status",
        arguments: { uuid: proj, status: "open", dry_run: true },
      }),
    ) as { project: { kind: string; op: string }; children: unknown[] };
    expect(outcome.project.kind).toBe("dry-run");
    expect(outcome.project.op).toBe("project.reopen");
    expect(outcome.children).toEqual([]);
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

  it("capabilities dumps the support matrix for every op kind", async () => {
    await connect([fakeVector(null).vector]);
    const table = textOf(await client.callTool({ name: "capabilities", arguments: {} })) as {
      op: string;
      vectors: { vector: string }[];
    }[];
    expect(table).toHaveLength(OPERATION_KINDS.length);
    expect(table[0]?.vectors.map((v) => v.vector)).toEqual([
      "url-scheme",
      "applescript",
      "shortcuts",
    ]);
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

  it("get_project caps item rows at 50 by default; limit/all adjust; conflict is usage", async () => {
    const proj = seedProject(fixture.db, { title: "Big Proj" });
    for (let i = 0; i < 60; i++) {
      seedTodo(fixture.db, { title: `task ${i}`, project: proj, index: i });
    }
    await connect([fakeVector(null).vector]);
    const capped = await client.callTool({ name: "get_project", arguments: { uuid: proj } });
    const view = textOf(capped) as { active: unknown[] };
    expect(view.active).toHaveLength(50);
    const meta = JSON.parse(
      (capped as { content: { text: string }[] }).content[1]?.text ?? "{}",
    ) as { pagination: { shown: number; total: number; truncated: boolean }; note: string };
    expect(meta.pagination).toEqual({ shown: 50, total: 60, limit: 50, truncated: true });
    expect(meta.note).toContain("showing 50 of 60");

    const all = textOf(
      await client.callTool({ name: "get_project", arguments: { uuid: proj, all: true } }),
    ) as { active: unknown[] };
    expect(all.active).toHaveLength(60);

    const conflict = await client.callTool({
      name: "get_project",
      arguments: { uuid: proj, limit: 5, all: true },
    });
    expect(conflict.isError).toBe(true);
  });

  it("undo with an empty audit trail returns an empty item list", async () => {
    await connect([fakeVector(null).vector]);
    const items = textOf(
      await client.callTool({ name: "undo", arguments: { dry_run: true } }),
    ) as unknown[];
    expect(items).toEqual([]);
  });

  it("annotations mark reads read-only and permanent deletes destructive", async () => {
    await connect([fakeVector(null).vector]);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("read_view")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("capabilities")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("delete_tag")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("delete_area")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("add_todo")?.annotations?.destructiveHint).toBe(false);
  });

  describe("server instructions", () => {
    it("carry conventions plus the live area/tag/project inventory", async () => {
      seedArea(fixture.db, "Home");
      const parent = seedTag(fixture.db, "energy");
      seedTag(fixture.db, "low", parent);
      seedProject(fixture.db, { title: "Renovate kitchen" });
      await connect([fakeVector(null).vector]);
      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("dry_run");
      expect(instructions).toContain("today | evening | anytime | someday | YYYY-MM-DD");
      expect(instructions).toContain("Areas (1): Home");
      expect(instructions).toContain("energy > low");
      expect(instructions).toContain("Renovate kitchen");
    });

    it("degrade gracefully when the database is unreadable", async () => {
      const server = createThingsMcpServer({ dbPath: join(stateDir, "nope.sqlite") });
      const localClient = new Client({ name: "test-client", version: "0.0.0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), localClient.connect(ct)]);
      const instructions = localClient.getInstructions() ?? "";
      expect(instructions).toContain("not readable");
      expect(instructions).toContain("doctor");
      await localClient.close();
      await server.close();
    });
  });

  describe("surface copy contract", () => {
    // docs/design/surface-copy.md rule 2: descriptions state behavior, never
    // mechanism. Internals belong in docs/ and the capabilities OUTPUT.
    const BANNED = [
      /\b(audit|verified|verification|read-after-write|pipeline|hazard|pre-read|drift|fingerprint|probe|sdef)\b/i,
      /\bH-[A-Z][A-Z-]+\b/, // hazard ids
      /\b[A-Z]\d{2}\b/, // probe-evidence ids (P16, E06, R20, ...)
      /\btier\b/i,
      /\bvector\b/i,
    ];

    it("no tool description, parameter description, or instruction leaks internals", async () => {
      await connect([fakeVector(null).vector]);
      const { tools } = await client.listTools();
      const surfaces: [string, string][] = [
        ["instructions", client.getInstructions() ?? ""],
        ...tools.map((t): [string, string] => [
          t.name,
          `${t.description} ${JSON.stringify(t.inputSchema)}`,
        ]),
      ];
      for (const [name, text] of surfaces) {
        for (const pattern of BANNED) {
          const match = text.match(pattern);
          expect(match, `"${name}" leaks "${match?.[0] ?? ""}" (${pattern})`).toBeNull();
        }
      }
    });
  });
});
