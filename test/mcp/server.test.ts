/**
 * MCP surface tests — a real MCP client over an in-memory transport against
 * the real server, backed by a fixture DB and fake write vectors. Proves the
 * third surface is a faithful window onto ThingsClient, that the grouped v2
 * tools route to the right operations, and that every description obeys the
 * consumer-voice contract (docs/design/surface-copy.md).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { AuditRecord } from "../../src/audit/schema.ts";
import { createThingsMcpServer } from "../../src/mcp/server.ts";
import { OPERATION_KINDS } from "../../src/write/operations.ts";
import type { VectorId, VectorMatrix, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import {
  seedArea,
  seedChecklistItem,
  seedHeading,
  seedProject,
  seedTag,
  seedTodo,
  tagArea,
  tagTask,
} from "../fixtures/seed.ts";

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

/**
 * A validated vector whose only op sits at a raised disruption tier — the
 * config profile's default ceiling (workstation: 1) blocks it, and only the
 * daemon-startup flag lifts that. url-scheme so the invocation compiles.
 */
function tierVector(op: string, disruption: number): WriteVector {
  return {
    id: "url-scheme",
    matrix: { [op]: { support: "yes", disruption, validation: "validated" } } as VectorMatrix,
    async execute() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

async function connect(
  vectors: WriteVector[],
  opts: { maxDisruption?: 0 | 1 | 2 | 3 } = {},
): Promise<void> {
  const env = {
    ...process.env,
    THINGS_DB: fixture.path,
    THINGS_API_STATE_DIR: stateDir,
    THINGS_API_CONFIG_DIR: join(stateDir, "config"),
  };
  const server = createThingsMcpServer({
    dbPath: fixture.path,
    ...(opts.maxDisruption !== undefined && { maxDisruption: opts.maxDisruption }),
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

/** Collect every property name at any depth of a JSON-schema object (arg names). */
function schemaArgNames(schema: unknown): string[] {
  const names: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const props = obj["properties"];
    if (props !== undefined && typeof props === "object" && props !== null) {
      for (const [key, child] of Object.entries(props as Record<string, unknown>)) {
        names.push(key);
        walk(child);
      }
    }
    walk(obj["items"]);
    for (const composite of ["anyOf", "oneOf", "allOf"]) {
      const arr = obj[composite];
      if (Array.isArray(arr)) for (const el of arr) walk(el);
    }
  };
  walk(schema);
  return names;
}

function textOf(result: unknown): unknown {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]?.text ?? "null");
}

/** The warnings array from whichever result block carries meta.warnings. */
function warningsOf(result: unknown): string[] | undefined {
  const content = (result as { content: { text: string }[] }).content;
  for (const block of content) {
    try {
      const parsed = JSON.parse(block.text) as { meta?: { warnings?: string[] } };
      if (parsed.meta?.warnings !== undefined) return parsed.meta.warnings;
    } catch {
      // non-JSON block: skip
    }
  }
  return undefined;
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
  // ui vector (Accessibility GUI)
  "make_repeating",
  "reschedule_repeat",
  "set_repeat_state",
  "convert_to_project",
  "reschedule_project_repeat",
  "set_project_repeat_state",
  "reorder_area",
  "make_project_repeating",
  "create_repeating_project",
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

  it("read_view today with evening: true returns only the This Evening section", async () => {
    seedTodo(fixture.db, { title: "MCP-Day", startDate: "2026-07-05" });
    seedTodo(fixture.db, { title: "MCP-Night", startDate: "2026-07-05", evening: true });
    await connect([fakeVector(null).vector]);
    const result = await client.callTool({
      name: "read_view",
      arguments: { view: "today", evening: true },
    });
    const view = textOf(result) as { today: unknown[]; evening: { title: string }[] };
    expect(view.today).toEqual([]);
    expect(view.evening.map((i) => i.title)).toEqual(["MCP-Night"]);
    expect(result.isError ?? false).toBe(false);
  });

  it("read_view rejects evening on a non-today view", async () => {
    await connect([fakeVector(null).vector]);
    const result = await client.callTool({
      name: "read_view",
      arguments: { view: "inbox", evening: true },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatchObject({ code: "usage" });
  });

  it("read_view untagged returns only untagged items; conflicts with tag", async () => {
    const focus = seedTag(fixture.db, "focus");
    const tagged = seedTodo(fixture.db, { title: "MCP tagged", startDate: "2026-07-05" });
    tagTask(fixture.db, tagged, focus);
    seedTodo(fixture.db, { title: "MCP bare", startDate: "2026-07-05" });
    await connect([fakeVector(null).vector]);
    const view = textOf(
      await client.callTool({
        name: "read_view",
        arguments: { view: "today", untagged: true },
      }),
    ) as { today: { title: string }[] };
    expect(view.today.map((i) => i.title)).toEqual(["MCP bare"]);
    const conflict = await client.callTool({
      name: "read_view",
      arguments: { view: "today", untagged: true, tag: ["focus"] },
    });
    expect(conflict.isError).toBe(true);
    expect(textOf(conflict)).toMatchObject({ code: "usage" });
  });

  it("update_project on an ambiguous NAME returns structured candidates (name sugar + machine detail)", async () => {
    // MCP inherits the name/partial-uuid write-target sugar via the shared
    // pipeline: passing a NAME (not a uuid) resolves it — proven by the
    // ambiguity, which also proves the structured candidates ride the result.
    seedProject(fixture.db, { title: "Dup" });
    seedProject(fixture.db, { title: "Dup" });
    await connect([fakeVector(null, { ops: ["project.update"] }).vector]);
    const result = await client.callTool({
      name: "update_project",
      arguments: { uuid: "Dup", title: "x" },
    });
    expect(result.isError).toBe(true);
    const err = textOf(result) as { code: string; details?: { candidates?: unknown[] } };
    expect(err.code).toBe("ambiguous");
    expect(err.details?.candidates).toHaveLength(2);
    expect(err.details?.candidates?.[0]).toHaveProperty("title", "Dup");
  });

  it("a not-found write target returns code=not-found (structured, empty candidates)", async () => {
    await connect([fakeVector(null, { ops: ["project.update"] }).vector]);
    const result = await client.callTool({
      name: "update_project",
      arguments: { uuid: "ghost", title: "x" },
    });
    expect(result.isError).toBe(true);
    const err = textOf(result) as { code: string; details?: { candidates?: unknown[] } };
    expect(err.code).toBe("not-found");
    expect(err.details?.candidates).toEqual([]);
  });

  it("set_tags with an unknown tag returns the blocked hazard naming the missing tag", async () => {
    const todo = seedTodo(fixture.db, { title: "t" });
    await connect([fakeVector(null, { ops: ["todo.set-tags"] }).vector]);
    const result = await client.callTool({
      name: "set_tags",
      arguments: { uuid: todo, tags: ["ghost"] },
    });
    expect(result.isError).toBe(true);
    const err = textOf(result) as { code: string; message: string };
    expect(err.code).toBe("blocked:H-UNKNOWN-TAG");
    expect(err.message).toContain("ghost");
  });

  it("search untagged narrows results; conflicts with exact_tag", async () => {
    const focus = seedTag(fixture.db, "focus");
    const tagged = seedTodo(fixture.db, { title: "note tagged" });
    tagTask(fixture.db, tagged, focus);
    seedTodo(fixture.db, { title: "note bare" });
    await connect([fakeVector(null).vector]);
    const hits = textOf(
      await client.callTool({
        name: "search",
        arguments: { query: "note", untagged: true },
      }),
    ) as { title: string }[];
    expect(hits.map((i) => i.title)).toEqual(["note bare"]);
    const conflict = await client.callTool({
      name: "search",
      arguments: { query: "note", untagged: true, exact_tag: true },
    });
    expect(conflict.isError).toBe(true);
    expect(textOf(conflict)).toMatchObject({ code: "usage" });
  });

  it("read_view tag is an array that ANDs (flat inheritance-inclusive); no direct_tag input exists", async () => {
    const foo = seedTag(fixture.db, "foo");
    const bar = seedTag(fixture.db, "bar");
    const work = seedArea(fixture.db, "Work");
    tagArea(fixture.db, work, foo);
    const both = seedTodo(fixture.db, { title: "MCP both", area: work, startDate: "2026-07-05" });
    tagTask(fixture.db, both, bar); // inherits foo (area) + direct bar
    const directFoo = seedTodo(fixture.db, {
      title: "MCP direct-foo",
      startDate: "2026-07-05",
    });
    tagTask(fixture.db, directFoo, foo);
    seedTodo(fixture.db, { title: "MCP inherited-only", area: work, startDate: "2026-07-05" });
    await connect([fakeVector(null).vector]);
    // AND: foo (inherited or direct) AND bar (direct) → only "MCP both".
    const anded = textOf(
      await client.callTool({
        name: "read_view",
        arguments: { view: "today", tag: ["foo", "bar"] },
      }),
    ) as { today: { title: string }[] };
    expect(anded.today.map((i) => i.title)).toEqual(["MCP both"]);
    // Flat tag foo is inheritance-inclusive: direct AND area-inherited rows.
    const single = textOf(
      await client.callTool({
        name: "read_view",
        arguments: { view: "today", tag: ["foo"] },
      }),
    ) as { today: { title: string }[] };
    expect(single.today.map((i) => i.title).toSorted()).toEqual([
      "MCP both",
      "MCP direct-foo",
      "MCP inherited-only",
    ]);
    // The removed direct_tag input is no longer part of the schema — zod strips
    // the unknown key, so the call behaves as an unfiltered view (every member),
    // NOT as the old direct-only filter.
    const removed = textOf(
      await client.callTool({
        name: "read_view",
        arguments: { view: "today", direct_tag: ["foo"] },
      }),
    ) as { today: { title: string }[] };
    expect(removed.today.map((i) => i.title).toSorted()).toEqual([
      "MCP both",
      "MCP direct-foo",
      "MCP inherited-only",
    ]);
    // untagged + tag is refused.
    const conflict = await client.callTool({
      name: "read_view",
      arguments: { view: "today", untagged: true, tag: ["foo"] },
    });
    expect(conflict.isError).toBe(true);
    expect(textOf(conflict)).toMatchObject({ code: "usage" });
  });

  it("get_project / get_area / list_collections carry the container tag filters (direct-on-row) with guards", async () => {
    const focus = seedTag(fixture.db, "focus");
    const area = seedArea(fixture.db, "Home");
    const project = seedProject(fixture.db, { title: "P", area });
    const childHit = seedTodo(fixture.db, { title: "child-focus", project });
    tagTask(fixture.db, childHit, focus);
    seedTodo(fixture.db, { title: "child-bare", project });
    // Home is area-tagged focus (every project/row inherits it); P is ALSO
    // directly tagged focus, PBare only inherits it from Home.
    tagArea(fixture.db, area, focus);
    tagTask(fixture.db, project, focus);
    seedProject(fixture.db, { title: "PBare", area });
    const looseHit = seedTodo(fixture.db, { title: "loose-focus", area });
    tagTask(fixture.db, looseHit, focus);
    await connect([fakeVector(null).vector]);
    // get_project tag → single-container semantics: only the child with its own
    // focus tag (the project's/area's focus is inherited by every child, and
    // suppressed).
    const proj = textOf(
      await client.callTool({
        name: "get_project",
        arguments: { uuid: "P", tag: ["focus"] },
      }),
    ) as { active: { title: string }[] };
    expect(proj.active.map((i) => i.title)).toEqual(["child-focus"]);
    // get_area tag → single-container semantics: loose to-dos + child projects
    // carrying focus DIRECTLY (Home's inherited focus is suppressed, so PBare —
    // which only inherits — is excluded).
    const areaRes = textOf(
      await client.callTool({
        name: "get_area",
        arguments: { ref: "Home", tag: ["focus"] },
      }),
    ) as { active: { title: string }[]; projects: { title: string }[] };
    expect(areaRes.active.map((i) => i.title)).toEqual(["loose-focus"]);
    expect(areaRes.projects.map((i) => i.title)).toEqual(["P"]);
    // list_collections projects tag → FLAT/inheritance-inclusive: BOTH the
    // directly-tagged P and the area-inheriting PBare (the projects list is not a
    // single-container view — contrast get_area above).
    const list = textOf(
      await client.callTool({
        name: "list_collections",
        arguments: { kind: "projects", tag: ["focus"] },
      }),
    ) as { title: string }[];
    expect(list.map((p) => p.title).toSorted()).toEqual(["P", "PBare"]);
    // areas kind rejects the tag filters.
    const rejected = await client.callTool({
      name: "list_collections",
      arguments: { kind: "areas", tag: ["focus"] },
    });
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toMatchObject({ code: "usage" });
  });

  it("read_view overdue narrows to open, past-deadline members; rejects forward/closed views", async () => {
    // NOW is pinned to 2026-07-05, so 07-04 is overdue, 07-05 is due-today.
    seedTodo(fixture.db, { title: "MCP overdue", start: "active", deadline: "2026-07-04" });
    seedTodo(fixture.db, { title: "MCP due", start: "active", deadline: "2026-07-05" });
    seedTodo(fixture.db, { title: "MCP future", start: "active", deadline: "2026-07-08" });
    await connect([fakeVector(null).vector]);
    const view = textOf(
      await client.callTool({ name: "read_view", arguments: { view: "today", overdue: true } }),
    ) as { today: { title: string }[]; evening: unknown[] };
    expect(view.today.map((i) => i.title)).toEqual(["MCP overdue"]);
    const rejections = await Promise.all(
      ["upcoming", "logbook", "trash"].map((bad) =>
        client
          .callTool({ name: "read_view", arguments: { view: bad, overdue: true } })
          .then((rej) => [bad, rej] as const),
      ),
    );
    for (const [bad, rej] of rejections) {
      expect(rej.isError, bad).toBe(true);
      expect(textOf(rej)).toMatchObject({ code: "usage" });
    }
  });

  it("search overdue narrows to open, past-deadline matches; refuses status-widening flags", async () => {
    seedTodo(fixture.db, { title: "widget overdue", start: "active", deadline: "2026-07-04" });
    seedTodo(fixture.db, { title: "widget due", start: "active", deadline: "2026-07-05" });
    await connect([fakeVector(null).vector]);
    const hits = textOf(
      await client.callTool({ name: "search", arguments: { query: "widget", overdue: true } }),
    ) as { title: string }[];
    expect(hits.map((i) => i.title)).toEqual(["widget overdue"]);
    const rejections = await Promise.all(
      ["logged", "trashed", "all"].map((flag) =>
        client
          .callTool({ name: "search", arguments: { query: "widget", overdue: true, [flag]: true } })
          .then((rej) => [flag, rej] as const),
      ),
    );
    for (const [flag, rej] of rejections) {
      expect(rej.isError, flag).toBe(true);
      expect(textOf(rej)).toMatchObject({ code: "usage" });
    }
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

  it("read_view someday: numeric show_active_project_items caps that section; limit rejected on grouped views", async () => {
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

    const capsWith = async (arg: Record<string, unknown>) => {
      const capped = await client.callTool({
        name: "read_view",
        arguments: { view: "someday", ...arg },
      });
      const meta = JSON.parse(
        (capped as { content: { text: string }[] }).content[1]?.text ?? "{}",
      ) as {
        grouped: {
          blocks: { kind: string; title: string | null; shown: number; total: number }[];
        };
      };
      expect(meta.grouped.blocks).toContainEqual(
        expect.objectContaining({ kind: "project", title: "Active Proj", shown: 2, total: 4 }),
      );
    };
    // Preferred name and its compatibility alias behave identically.
    await capsWith({ show_active_project_items: 2 });
    await capsWith({ active_project_items: 2 });

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
      { view: "inbox", show_active_project_items: true },
      { view: "inbox", active_project_items: true },
    ]) {
      // each call shares one MCP client/transport; concurrent calls would race on it
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
    expect((textOf(result) as { message: string }).message).toContain(
      'no item matching uuid or partial-uuid "nope"',
    );
  });

  it("get_item applies omit-empty: a bare item omits empty optional fields", async () => {
    const uuid = seedTodo(fixture.db, { title: "bare mcp item" });
    await connect([fakeVector(null).vector]);
    const item = textOf(await client.callTool({ name: "get_item", arguments: { uuid } })) as Record<
      string,
      unknown
    >;
    // Identity always present.
    expect(item["uuid"]).toBe(uuid);
    expect(item["type"]).toBe("to-do");
    expect(item["title"]).toBe("bare mcp item");
    // Empty optional fields are absent (absent = unset), mirroring the CLI.
    for (const gone of ["deadline", "startDate", "reminder", "area", "project", "tags"]) {
      expect(gone in item).toBe(false);
    }
    // The reversal: an empty inherited-tag set is absent, not [].
    expect("inheritedTags" in item).toBe(false);
    // Meaningful false/0 survive.
    expect(item["logged"]).toBe(false);
    expect(item["checklistItemsCount"]).toBe(0);
  });

  it("get_item keeps inheritedTags when non-empty (reversal guard)", async () => {
    const area = seedArea(fixture.db, "InhArea");
    const areaTag = seedTag(fixture.db, "inh-area-tag");
    tagArea(fixture.db, area, areaTag);
    const project = seedProject(fixture.db, { title: "InhProj", area });
    const uuid = seedTodo(fixture.db, { title: "inh child", project });
    await connect([fakeVector(null).vector]);
    const item = textOf(await client.callTool({ name: "get_item", arguments: { uuid } })) as Record<
      string,
      unknown
    >;
    expect("inheritedTags" in item).toBe(true);
    expect(item["inheritedTags"]).toHaveLength(1);
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

  it("attributes a write to the client's derived actor (mcp:<client-name>)", async () => {
    const { vector } = fakeVector(() => {
      seedTodo(fixture.db, {
        uuid: "MCP-ACTOR",
        title: "Attributed",
        creationDate: Math.floor(NOW.getTime() / 1000),
      });
    });
    await connect([vector]);
    const result = await client.callTool({ name: "add_todo", arguments: { title: "Attributed" } });
    expect(result.isError ?? false).toBe(false);
    // The in-process client connects as { name: "test-client" }; every write it
    // makes is recorded under the sanitized handshake identity, not a bare "mcp".
    const lines = readFileSync(join(stateDir, "audit", "2026-07.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const records = lines.map((l) => JSON.parse(l) as AuditRecord);
    const add = records.find((r) => r.op === "todo.add");
    expect(add?.actor).toBe("mcp:test-client");
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
        // each call shares one MCP client/transport; concurrent calls would race on it
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
      // each call shares one MCP client/transport; concurrent calls would race on it
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
        // each call shares one MCP client/transport; concurrent calls would race on it
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
      "ui",
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

  it("get_area caps project rows and direct to-dos at 30 each; all lifts; conflict is usage", async () => {
    const area = seedArea(fixture.db, "Busy");
    for (let i = 0; i < 35; i++) {
      seedProject(fixture.db, { title: `proj ${i}`, area, index: i });
    }
    for (let i = 0; i < 35; i++) {
      seedTodo(fixture.db, { title: `direct ${i}`, area, index: 100 + i });
    }
    await connect([fakeVector(null).vector]);
    const capped = await client.callTool({ name: "get_area", arguments: { ref: "Busy" } });
    const view = textOf(capped) as { projects: unknown[]; active: unknown[] };
    expect(view.projects).toHaveLength(30);
    expect(view.active).toHaveLength(30);
    const meta = JSON.parse(
      (capped as { content: { text: string }[] }).content[1]?.text ?? "{}",
    ) as {
      grouped: { truncated: boolean; blocks: { kind: string; shown: number; total: number }[] };
    };
    expect(meta.grouped.truncated).toBe(true);
    expect(meta.grouped.blocks).toEqual([
      expect.objectContaining({ kind: "projects", shown: 30, total: 35 }),
      expect.objectContaining({ kind: "area", shown: 30, total: 35 }),
    ]);

    const all = textOf(
      await client.callTool({ name: "get_area", arguments: { ref: "Busy", all: true } }),
    ) as { projects: unknown[] };
    expect(all.projects).toHaveLength(35);

    const narrowed = textOf(
      await client.callTool({ name: "get_area", arguments: { ref: "Busy", project_limit: 2 } }),
    ) as { projects: unknown[]; active: unknown[] };
    expect(narrowed.projects).toHaveLength(2);
    expect(narrowed.active).toHaveLength(30);

    const conflict = await client.callTool({
      name: "get_area",
      arguments: { ref: "Busy", area_limit: 5, all: true },
    });
    expect(conflict.isError).toBe(true);
  });

  it("get_project overdue filters children and collapses empty headings", async () => {
    // NOW is 2026-07-05, so 07-04 is overdue and 07-05 is due-today.
    const proj = seedProject(fixture.db, { title: "MCP Launch" });
    const hHit = seedHeading(fixture.db, { title: "Phase 1", project: proj, index: 1 });
    seedHeading(fixture.db, { title: "Phase 2", project: proj, index: 2 });
    seedTodo(fixture.db, {
      title: "loose-overdue",
      project: proj,
      deadline: "2026-07-04",
      index: 1,
    });
    seedTodo(fixture.db, { title: "loose-due", project: proj, deadline: "2026-07-05", index: 2 });
    seedTodo(fixture.db, {
      title: "p1-overdue",
      heading: hHit,
      project: null,
      deadline: "2026-07-01",
    });
    await connect([fakeVector(null).vector]);
    const view = textOf(
      await client.callTool({
        name: "get_project",
        arguments: { uuid: proj, overdue: true },
      }),
    ) as {
      project: { title: string };
      active: { title: string }[];
      headings: { heading: { title: string }; items: { title: string }[] }[];
    };
    expect(view.project.title).toBe("MCP Launch");
    expect(view.active.map((i) => i.title)).toEqual(["loose-overdue"]);
    expect(view.headings).toHaveLength(1);
    expect(view.headings[0]?.heading.title).toBe("Phase 1");
  });

  it("get_area overdue filters loose to-dos AND child projects; no recursion", async () => {
    const area = seedArea(fixture.db, "MCP Home");
    seedTodo(fixture.db, { title: "todo-overdue", area, deadline: "2026-07-04", index: 1 });
    seedTodo(fixture.db, { title: "todo-due", area, deadline: "2026-07-05", index: 2 });
    const projOverdue = seedProject(fixture.db, {
      title: "proj-overdue",
      area,
      deadline: "2026-07-01",
      index: 3,
    });
    const projClean = seedProject(fixture.db, { title: "proj-clean", area, index: 4 });
    seedTodo(fixture.db, { title: "buried-overdue", project: projClean, deadline: "2026-06-01" });
    seedTodo(fixture.db, { title: "buried-clean", project: projOverdue });
    await connect([fakeVector(null).vector]);
    const view = textOf(
      await client.callTool({
        name: "get_area",
        arguments: { ref: "MCP Home", overdue: true },
      }),
    ) as { active: { title: string }[]; projects: { title: string }[] };
    expect(view.active.map((i) => i.title)).toEqual(["todo-overdue"]);
    expect(view.projects.map((i) => i.title)).toEqual(["proj-overdue"]);
  });

  it("list_collections overdue narrows projects; rejects it on areas/tags", async () => {
    const area = seedArea(fixture.db, "MCP Zone");
    seedProject(fixture.db, { title: "proj-overdue", area, deadline: "2026-07-04", index: 1 });
    seedProject(fixture.db, { title: "proj-due", area, deadline: "2026-07-05", index: 2 });
    seedProject(fixture.db, { title: "proj-none", area, index: 3 });
    await connect([fakeVector(null).vector]);
    const projects = textOf(
      await client.callTool({
        name: "list_collections",
        arguments: { kind: "projects", overdue: true },
      }),
    ) as { title: string }[];
    expect(projects.map((p) => p.title)).toEqual(["proj-overdue"]);
    // areas/tags carry no deadline — overdue is rejected fail-closed.
    const rejections = await Promise.all(
      ["areas", "tags"].map((kind) =>
        client
          .callTool({ name: "list_collections", arguments: { kind, overdue: true } })
          .then((rej) => [kind, rej] as const),
      ),
    );
    for (const [kind, rej] of rejections) {
      expect(rej.isError, kind).toBe(true);
      expect(textOf(rej)).toMatchObject({ code: "usage" });
    }
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

  it("project write tools accept a project name; to-do write tools stay uuid-only", async () => {
    await connect([fakeVector(null).vector]);
    const { tools } = await client.listTools();
    const uuidDesc = (name: string): string => {
      const schema = tools.find((t) => t.name === name)?.inputSchema as {
        properties?: Record<string, { description?: string }>;
      };
      return schema?.properties?.["uuid"]?.description ?? "";
    };
    // Project write targets resolve a unique NAME through the shared pipeline (#157).
    for (const name of [
      "update_project",
      "set_project_status",
      "move_project",
      "make_project_repeating",
      "reschedule_project_repeat",
      "set_project_repeat_state",
    ]) {
      expect(uuidDesc(name), name).toContain("uuid or unique name");
    }
    // To-do write targets are identity-addressed — the target must never claim name acceptance.
    for (const name of ["update_todo", "set_todo_status", "move_todo", "backdate_todo"]) {
      expect(uuidDesc(name), name).not.toContain("unique name");
    }
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

  describe("undo scoping", () => {
    function seedAuditTrail(records: Partial<AuditRecord>[]): void {
      const dir = join(stateDir, "audit");
      mkdirSync(dir, { recursive: true });
      const full = records.map((r) => ({
        v: 1,
        ts: "2026-07-05T10:00:00.000Z",
        actor: "mike",
        host: "test-host",
        op: "todo.update",
        uuid: null,
        vector: "url-scheme",
        disruption: 0,
        invocation: "x",
        requested: {},
        pre: null,
        observed: null,
        result: "ok",
        verify: null,
        durationMs: 1,
        env: { pkg: "0.1.0", dbVersion: 26, fingerprint: "ok" },
        ...r,
      }));
      writeFileSync(join(dir, "2026-07.jsonl"), full.map((r) => JSON.stringify(r)).join("\n"));
    }

    it("defaults to this client's derived actor — skips a NEWER human record, reverses its own", async () => {
      // The in-process test client connects as { name: "test-client" }, so its
      // writes are attributed to "mcp:test-client" and the default `by` scopes
      // undo to exactly that — never the human's edits, never a bare "mcp".
      const mcpTodo = seedTodo(fixture.db, { title: "Agent", status: "completed" });
      const humanTodo = seedTodo(fixture.db, { title: "Human" });
      seedAuditTrail([
        {
          ts: "2026-07-05T09:00:00Z",
          op: "todo.complete",
          uuid: mcpTodo,
          actor: "mcp:test-client",
          pre: { status: "open" },
        },
        { ts: "2026-07-05T09:30:00Z", op: "todo.add", uuid: humanTodo, actor: "mike" },
      ]);
      const { vector } = fakeVector(
        (payload) => {
          if (payload.includes(mcpTodo)) {
            fixture.db.prepare("UPDATE TMTask SET status = 0 WHERE uuid = ?").run(mcpTodo);
          }
        },
        { ops: ["todo.reopen", "todo.delete"] },
      );
      await connect([vector]);
      const result = await client.callTool({ name: "undo", arguments: {} });
      const items = textOf(result) as { plan: { target: { uuid: string; actor: string } } }[];
      expect(items).toHaveLength(1);
      expect(items[0]?.plan.target.uuid).toBe(mcpTodo);
      expect(items[0]?.plan.target.actor).toBe("mcp:test-client");
    });

    it("by:'*' reaches the human record (newest wins)", async () => {
      const humanTodo = seedTodo(fixture.db, { title: "Human" });
      seedAuditTrail([
        { ts: "2026-07-05T09:30:00Z", op: "todo.add", uuid: humanTodo, actor: "mike" },
      ]);
      const { vector } = fakeVector(null, { ops: ["todo.delete"] });
      await connect([vector]);
      const result = await client.callTool({
        name: "undo",
        arguments: { by: "*", dry_run: true },
      });
      const items = textOf(result) as { plan: { target: { uuid: string } } }[];
      expect(items[0]?.plan.target.uuid).toBe(humanTodo);
    });

    it("txn combined with last/by is a usage error", async () => {
      await connect([fakeVector(null).vector]);
      const bad = await client.callTool({
        name: "undo",
        arguments: { txn: "m-abc", last: 2 },
      });
      expect(bad.isError).toBe(true);
      expect(JSON.stringify(bad)).toContain("txn cannot be combined");
    });
  });

  describe("daemon-startup disruption ceiling", () => {
    it("blocks a tier-gated op when the daemon was started without the flag", async () => {
      const uuid = seedTodo(fixture.db, { title: "ceiling" });
      await connect([tierVector("todo.update", 2)]);
      const result = await client.callTool({
        name: "update_todo",
        arguments: { uuid, title: "renamed", dry_run: true },
      });
      expect(result.isError).toBe(true);
      const error = textOf(result) as { code: string };
      expect(error.code).toBe("blocked:disruption-tier");
    });

    it("permits the same op when the daemon was started with the ceiling raised", async () => {
      const uuid = seedTodo(fixture.db, { title: "ceiling" });
      await connect([tierVector("todo.update", 2)], { maxDisruption: 2 });
      const result = await client.callTool({
        name: "update_todo",
        arguments: { uuid, title: "renamed", dry_run: true },
      });
      expect(result.isError ?? false).toBe(false);
      const outcome = textOf(result) as { kind: string };
      expect(outcome.kind).toBe("dry-run");
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

  describe("tool-argument casing", () => {
    // The MCP surface convention is snake_case for every tool argument (CLI
    // flags stay kebab-case; internal WriteOptions/BatchOp stay camelCase).
    it("every tool argument is snake_case (no camelCase leaks)", async () => {
      await connect([fakeVector(null).vector]);
      const { tools } = await client.listTools();
      for (const tool of tools) {
        for (const name of schemaArgNames(tool.inputSchema)) {
          expect(name, `${tool.name}.${name} is not snake_case`).not.toMatch(/[a-z0-9][A-Z]/);
        }
      }
    });

    it("batch maps snake_case per-op acknowledgements into the engine option names", async () => {
      // trash.empty is refused without the permanent-delete acknowledgement; the
      // snake_case per-op option must reach the engine and lift that refusal.
      // (trash.empty compiles only for the applescript vector.)
      await connect([fakeVector(null, { id: "applescript", ops: ["trash.empty"] }).vector]);
      const blocked = await client.callTool({
        name: "batch",
        arguments: { ops: [{ op: "trash.empty", params: {} }], dry_run: true },
      });
      const blockedResults = textOf(blocked) as { outcome: { kind: string } }[];
      expect(blockedResults[0]?.outcome.kind).toBe("blocked");

      const allowed = await client.callTool({
        name: "batch",
        arguments: {
          ops: [{ op: "trash.empty", params: {}, options: { dangerously_permanent: true } }],
          dry_run: true,
        },
      });
      const allowedResults = textOf(allowed) as { outcome: { kind: string } }[];
      expect(allowedResults[0]?.outcome.kind).toBe("dry-run");
    });
  });

  describe("schema warning (non-blocking, read meta)", () => {
    it("a dropped depended column surfaces a warning in a read tool's meta", async () => {
      // Drop a depended column before the server opens its connection; the read
      // itself (areas only touch TMArea) still succeeds — reads warn, never block.
      fixture.db.exec("ALTER TABLE TMTask DROP COLUMN startBucket;");
      await connect([fakeVector(null).vector]);
      const result = await client.callTool({
        name: "list_collections",
        arguments: { kind: "areas" },
      });
      expect(result.isError).toBeFalsy();
      const warnings = warningsOf(result);
      expect(warnings).toBeDefined();
      expect(warnings?.[0]).toContain("schema has changed");
      expect(warnings?.[0]).toContain("things doctor");
    });

    it("an unrecognized databaseVersion surfaces a warning in a read tool's meta", async () => {
      fixture.db.exec(
        "UPDATE Meta SET value = replace(value, '26', '27') WHERE key = 'databaseVersion'",
      );
      await connect([fakeVector(null).vector]);
      const result = await client.callTool({ name: "read_view", arguments: { view: "today" } });
      expect(result.isError).toBeFalsy();
      const warnings = warningsOf(result);
      expect(warnings).toBeDefined();
      expect(warnings?.[0]).toContain("database version");
      expect(warnings?.[0]).toContain("things doctor");
    });

    it("a healthy schema adds no warnings block", async () => {
      await connect([fakeVector(null).vector]);
      const result = await client.callTool({
        name: "list_collections",
        arguments: { kind: "areas" },
      });
      expect(result.isError).toBeFalsy();
      expect(warningsOf(result)).toBeUndefined();
    });
  });

  // Each element of a batch result is { index, op, outcome: { kind } }; a
  // failure that is not the last op leaves the rest "skipped" under fail_fast.
  describe("batch — op cast + per-op option mapping", () => {
    it("runs several ops in order, each independently (dry-run)", async () => {
      await connect([fakeVector(null).vector]);
      const results = textOf(
        await client.callTool({
          name: "batch",
          arguments: {
            ops: [
              { op: "todo.add", params: { title: "A" } },
              { op: "todo.add", params: { title: "B" } },
            ],
            dry_run: true,
          },
        }),
      ) as { index: number; op: string; outcome: { kind: string } }[];
      expect(results.map((r) => r.op)).toEqual(["todo.add", "todo.add"]);
      expect(results.map((r) => r.outcome.kind)).toEqual(["dry-run", "dry-run"]);
    });

    it("fail_fast skips every op after the first failure", async () => {
      // trash.empty without the permanent-delete ack blocks (a pre-vector
      // hazard); with fail_fast the trailing add is never attempted.
      await connect([
        fakeVector(null, { id: "applescript", ops: ["trash.empty", "todo.add"] }).vector,
      ]);
      const results = textOf(
        await client.callTool({
          name: "batch",
          arguments: {
            ops: [
              { op: "trash.empty", params: {} },
              { op: "todo.add", params: { title: "never" } },
            ],
            fail_fast: true,
            dry_run: true,
          },
        }),
      ) as { outcome: { kind: string } }[];
      expect(results[0]?.outcome.kind).toBe("blocked");
      expect(results[1]?.outcome.kind).toBe("skipped");
    });

    it("maps a second snake_case per-op acknowledgement (checklist reset) into the engine", async () => {
      // todo.replace-checklist over an existing checklist is refused without the
      // acknowledgement; the snake_case per-op option must reach the engine.
      const uuid = seedTodo(fixture.db, { title: "listy" });
      seedChecklistItem(fixture.db, uuid, "existing");
      await connect([fakeVector(null, { ops: ["todo.replace-checklist"] }).vector]);
      const blocked = textOf(
        await client.callTool({
          name: "batch",
          arguments: {
            ops: [{ op: "todo.replace-checklist", params: { uuid, items: ["new"] } }],
            dry_run: true,
          },
        }),
      ) as { outcome: { kind: string } }[];
      expect(blocked[0]?.outcome.kind).toBe("blocked");

      const allowed = textOf(
        await client.callTool({
          name: "batch",
          arguments: {
            ops: [
              {
                op: "todo.replace-checklist",
                params: { uuid, items: ["new"] },
                options: { acknowledge_checklist_reset: true },
              },
            ],
            dry_run: true,
          },
        }),
      ) as { outcome: { kind: string } }[];
      expect(allowed[0]?.outcome.kind).toBe("dry-run");
    });
  });

  describe("reorder — scope-specific validation", () => {
    it("plans a Today bounce reorder without mutating (dry-run)", async () => {
      const a = seedTodo(fixture.db, { title: "T-a", startDate: "2026-07-05", todayIndex: 0 });
      const b = seedTodo(fixture.db, { title: "T-b", startDate: "2026-07-05", todayIndex: 1 });
      await connect([fakeVector(null).vector]);
      const outcome = textOf(
        await client.callTool({
          name: "reorder",
          arguments: { scope: "today", uuids: [b, a], dry_run: true },
        }),
      ) as { kind: string; op: string };
      expect(outcome.kind).toBe("dry-run");
      expect(outcome.op).toBe("reorder");
    });

    it("refuses a native strategy on the bounce-only evening scope", async () => {
      const ev = seedTodo(fixture.db, { title: "E-a", startDate: "2026-07-05", evening: true });
      await connect([fakeVector(null).vector]);
      const result = await client.callTool({
        name: "reorder",
        arguments: { scope: "evening", uuids: [ev], strategy: "native" },
      });
      expect(result.isError).toBe(true);
      const err = textOf(result) as { code: string; remediation: string };
      expect(err.code).toBe("blocked:H-REORDER-SCOPE");
      expect(err.remediation.length).toBeGreaterThan(0);
    });

    it("rejects a container on a scope that takes none (Today)", async () => {
      const a = seedTodo(fixture.db, { title: "T-c", startDate: "2026-07-05" });
      await connect([fakeVector(null).vector]);
      const result = await client.callTool({
        name: "reorder",
        arguments: { scope: "today", uuids: [a], container: "somewhere" },
      });
      expect(result.isError).toBe(true);
      expect((textOf(result) as { code: string }).code).toBe("blocked:H-REORDER-SCOPE");
      expect((textOf(result) as { message: string }).message).toContain("container is only valid");
    });
  });

  describe("heading tools", () => {
    it("create_heading plans through the proxy (dry-run) and rejects an unknown project", async () => {
      const project = seedProject(fixture.db, { title: "H-Proj" });
      await connect([fakeVector(null, { id: "shortcuts", ops: ["heading.create"] }).vector]);
      const outcome = textOf(
        await client.callTool({
          name: "create_heading",
          arguments: { project, title: "Phase 1", dry_run: true },
        }),
      ) as { kind: string; op: string };
      expect(outcome.kind).toBe("dry-run");
      expect(outcome.op).toBe("heading.create");

      const unknown = await client.callTool({
        name: "create_heading",
        arguments: { project: "ghost-project", title: "x", dry_run: true },
      });
      expect(unknown.isError).toBe(true);
    });

    it("rename_heading plans an in-place rename (dry-run)", async () => {
      const project = seedProject(fixture.db, { title: "R-Proj" });
      const heading = seedHeading(fixture.db, { title: "old", project });
      await connect([fakeVector(null, { id: "applescript", ops: ["heading.rename"] }).vector]);
      const outcome = textOf(
        await client.callTool({
          name: "rename_heading",
          arguments: { uuid: heading, title: "new", dry_run: true },
        }),
      ) as { kind: string; op: string };
      expect(outcome.kind).toBe("dry-run");
      expect(outcome.op).toBe("heading.rename");
    });

    it("archive_heading plans a childless archive; open children without a policy block", async () => {
      const project = seedProject(fixture.db, { title: "A-Proj" });
      const bare = seedHeading(fixture.db, { title: "Bare", project, index: 1 });
      await connect([fakeVector(null, { id: "applescript", ops: ["heading.archive"] }).vector]);
      const outcome = textOf(
        await client.callTool({
          name: "archive_heading",
          arguments: { uuid: bare, dry_run: true },
        }),
      ) as { heading: { kind: string; op: string } };
      expect(outcome.heading.kind).toBe("dry-run");
      expect(outcome.heading.op).toBe("heading.archive");

      const withChild = seedHeading(fixture.db, { title: "Full", project, index: 2 });
      seedTodo(fixture.db, { title: "child", heading: withChild, project: null });
      const blocked = await client.callTool({
        name: "archive_heading",
        arguments: { uuid: withChild, dry_run: true },
      });
      expect(blocked.isError).toBe(true);
      expect((textOf(blocked) as { code: string }).code).toBe("blocked:H-HEADING-CHILDREN");
    });

    it("unarchive_heading plans an in-place restore (dry-run)", async () => {
      const project = seedProject(fixture.db, { title: "U-Proj" });
      const heading = seedHeading(fixture.db, { title: "Archived", project });
      await connect([fakeVector(null, { id: "applescript", ops: ["heading.unarchive"] }).vector]);
      const outcome = textOf(
        await client.callTool({
          name: "unarchive_heading",
          arguments: { uuid: heading, dry_run: true },
        }),
      ) as { heading: { kind: string; op: string } };
      expect(outcome.heading.kind).toBe("dry-run");
      expect(outcome.heading.op).toBe("heading.unarchive");
    });
  });

  // The GUI-driven ops are two-key gated: without the drive acknowledgement they
  // block (H-UI-DRIVE, a pre-vector hazard, so the default vector suffices); with
  // it + a fake ui vector, dry_run compiles a plan without ever executing.
  describe("repeat / ui-vector cluster", () => {
    const uiVector = (op: string) => fakeVector(null, { id: "ui", ops: [op] }).vector;

    it("make_repeating blocks without the drive ack, and plans with it (dry-run)", async () => {
      const uuid = seedTodo(fixture.db, { title: "recur me" });
      await connect([fakeVector(null).vector]);
      const blocked = await client.callTool({
        name: "make_repeating",
        arguments: { uuid, frequency: "daily", interval: 1 },
      });
      expect(blocked.isError).toBe(true);
      const err = textOf(blocked) as { code: string; remediation: string };
      expect(err.code).toBe("blocked:H-UI-DRIVE");
      expect(err.remediation.length).toBeGreaterThan(0);

      await close();
      await connect([uiVector("todo.make-repeating")]);
      const uuid2 = seedTodo(fixture.db, { title: "recur me 2" });
      const outcome = textOf(
        await client.callTool({
          name: "make_repeating",
          arguments: {
            uuid: uuid2,
            frequency: "daily",
            interval: 1,
            dangerously_drive_gui: true,
            dry_run: true,
          },
        }),
      ) as { kind: string; op: string };
      expect(outcome.kind).toBe("dry-run");
      expect(outcome.op).toBe("todo.make-repeating");
    });

    it("reschedule_repeat blocks without the ack, and plans with it (dry-run)", async () => {
      const uuid = seedTodo(fixture.db, { title: "rule", recurrenceRule: true });
      await connect([uiVector("todo.reschedule-repeat")]);
      const blocked = await client.callTool({
        name: "reschedule_repeat",
        arguments: { uuid, frequency: "weekly", interval: 2 },
      });
      expect(blocked.isError).toBe(true);
      expect((textOf(blocked) as { code: string }).code).toBe("blocked:H-UI-DRIVE");

      const outcome = textOf(
        await client.callTool({
          name: "reschedule_repeat",
          arguments: {
            uuid,
            frequency: "weekly",
            interval: 2,
            dangerously_drive_gui: true,
            dry_run: true,
          },
        }),
      ) as { kind: string; op: string };
      expect(outcome.kind).toBe("dry-run");
      expect(outcome.op).toBe("todo.reschedule-repeat");
    });

    it("set_repeat_state routes pause/resume and gates the drive", async () => {
      const uuid = seedTodo(fixture.db, { title: "paused?", recurrenceRule: true });
      await connect([uiVector("todo.pause-repeat")]);
      const blocked = await client.callTool({
        name: "set_repeat_state",
        arguments: { uuid, state: "pause" },
      });
      expect((textOf(blocked) as { code: string }).code).toBe("blocked:H-UI-DRIVE");

      const outcome = textOf(
        await client.callTool({
          name: "set_repeat_state",
          arguments: { uuid, state: "pause", dangerously_drive_gui: true, dry_run: true },
        }),
      ) as { kind: string; op: string };
      expect(outcome.kind).toBe("dry-run");
      expect(outcome.op).toBe("todo.pause-repeat");
    });

    it("convert_to_project dispatches on type and gates the drive", async () => {
      const uuid = seedTodo(fixture.db, { title: "promote me" });
      await connect([uiVector("todo.convert-to-project")]);
      const blocked = await client.callTool({
        name: "convert_to_project",
        arguments: { uuid },
      });
      expect((textOf(blocked) as { code: string }).code).toBe("blocked:H-UI-DRIVE");

      const outcome = textOf(
        await client.callTool({
          name: "convert_to_project",
          arguments: { uuid, dangerously_drive_gui: true, dry_run: true },
        }),
      ) as { kind: string; op: string };
      expect(outcome.kind).toBe("dry-run");
      expect(outcome.op).toBe("todo.convert-to-project");
    });

    it("reschedule_project_repeat blocks without the ack, and plans with it (dry-run)", async () => {
      const uuid = seedProject(fixture.db, { title: "Recurring Proj", recurrenceRule: true });
      await connect([uiVector("project.reschedule-repeat")]);
      const blocked = await client.callTool({
        name: "reschedule_project_repeat",
        arguments: { uuid, frequency: "monthly", interval: 1 },
      });
      expect((textOf(blocked) as { code: string }).code).toBe("blocked:H-UI-DRIVE");

      const outcome = textOf(
        await client.callTool({
          name: "reschedule_project_repeat",
          arguments: {
            uuid,
            frequency: "monthly",
            interval: 1,
            dangerously_drive_gui: true,
            dry_run: true,
          },
        }),
      ) as { kind: string; op: string };
      expect(outcome.kind).toBe("dry-run");
      expect(outcome.op).toBe("project.reschedule-repeat");
    });

    it("set_project_repeat_state routes pause/resume and gates the drive", async () => {
      const uuid = seedProject(fixture.db, { title: "Proj paused?", recurrenceRule: true });
      await connect([uiVector("project.resume-repeat")]);
      const blocked = await client.callTool({
        name: "set_project_repeat_state",
        arguments: { uuid, state: "resume" },
      });
      expect((textOf(blocked) as { code: string }).code).toBe("blocked:H-UI-DRIVE");

      const outcome = textOf(
        await client.callTool({
          name: "set_project_repeat_state",
          arguments: { uuid, state: "resume", dangerously_drive_gui: true, dry_run: true },
        }),
      ) as { kind: string; op: string };
      expect(outcome.kind).toBe("dry-run");
      expect(outcome.op).toBe("project.resume-repeat");
    });

    it("reorder_area gates the drive, plans with it, and demands exactly one destination", async () => {
      const target = seedArea(fixture.db, "Move Me", 0);
      seedArea(fixture.db, "Anchor", 1);
      await connect([uiVector("area.reorder")]);
      const blocked = await client.callTool({
        name: "reorder_area",
        arguments: { target, position: "last" },
      });
      expect((textOf(blocked) as { code: string }).code).toBe("blocked:H-UI-DRIVE");

      const outcome = textOf(
        await client.callTool({
          name: "reorder_area",
          arguments: { target, position: "last", dangerously_drive_gui: true, dry_run: true },
        }),
      ) as { kind: string; op: string };
      expect(outcome.kind).toBe("dry-run");
      expect(outcome.op).toBe("area.reorder");

      const twoDest = await client.callTool({
        name: "reorder_area",
        arguments: { target, before: "a", after: "b", dangerously_drive_gui: true },
      });
      expect(twoDest.isError).toBe(true);
      expect((textOf(twoDest) as { code: string }).code).toBe("usage");
    });

    it("make_project_repeating blocks without the ack, and plans with it (dry-run)", async () => {
      const area = seedArea(fixture.db, "Repeat Area");
      const uuid = seedProject(fixture.db, { title: "Promote Proj", area });
      await connect([fakeVector(null).vector]);
      const blocked = await client.callTool({
        name: "make_project_repeating",
        arguments: { uuid, frequency: "weekly", interval: 1 },
      });
      expect((textOf(blocked) as { code: string }).code).toBe("blocked:H-UI-DRIVE");

      const outcome = textOf(
        await client.callTool({
          name: "make_project_repeating",
          arguments: {
            uuid,
            frequency: "weekly",
            interval: 1,
            dangerously_drive_gui: true,
            dry_run: true,
          },
        }),
      ) as { kind: string; op: string };
      expect(outcome.kind).toBe("dry-run");
      expect(outcome.op).toBe("project.make-repeating");
    });

    it("create_repeating_project blocks without the ack (before creating), and plans with it", async () => {
      await connect([fakeVector(null).vector]);
      const blocked = await client.callTool({
        name: "create_repeating_project",
        arguments: { title: "Weekly review", frequency: "weekly", interval: 1 },
      });
      expect((textOf(blocked) as { code: string }).code).toBe("blocked:H-UI-DRIVE");

      const outcome = textOf(
        await client.callTool({
          name: "create_repeating_project",
          arguments: {
            title: "Weekly review",
            frequency: "weekly",
            interval: 1,
            dangerously_drive_gui: true,
            dry_run: true,
          },
        }),
      ) as { kind: string; op: string };
      expect(outcome.kind).toBe("dry-run");
      expect(outcome.op).toBe("project.create-repeating");
    });
  });
});
