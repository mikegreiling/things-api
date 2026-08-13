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
import { createSimulatorVector } from "../../src/write/vectors/simulator.ts";
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

/** Like {@link connect}, but with a pinned instant and extra clock env (THINGS_TZ/THINGS_NOW). */
async function connectClock(
  vectors: WriteVector[],
  now: Date,
  envExtra: Record<string, string> = {},
): Promise<void> {
  const env = {
    ...process.env,
    THINGS_DB: fixture.path,
    THINGS_API_STATE_DIR: stateDir,
    THINGS_API_CONFIG_DIR: join(stateDir, "config"),
    ...envExtra,
  };
  const server = createThingsMcpServer({
    dbPath: fixture.path,
    openOptions: {
      env,
      vectors,
      now: () => now,
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

/** The meta.clock block appended to a read result, if any. */
function clockOf(result: unknown): { timezone: string; today: string } | undefined {
  const content = (result as { content: { text: string }[] }).content;
  for (const block of content) {
    try {
      const parsed = JSON.parse(block.text) as {
        meta?: { clock?: { timezone: string; today: string } };
      };
      if (parsed.meta?.clock !== undefined) return parsed.meta.clock;
    } catch {
      // non-JSON block: skip
    }
  }
  return undefined;
}

/** The today view's `counts` aggregate from the result's metadata block, if any. */
function countsOf(result: unknown): { dueOrOverdue: number; other: number } | undefined {
  const content = (result as { content: { text: string }[] }).content;
  for (const block of content) {
    try {
      const parsed = JSON.parse(block.text) as {
        counts?: { dueOrOverdue: number; other: number };
      };
      if (parsed.counts !== undefined) return parsed.counts;
    } catch {
      // non-JSON block: skip
    }
  }
  return undefined;
}

/** The logbook view's `logging` cadence fact from the result's metadata block, if any. */
function loggingOf(result: unknown): { cadence: string; lastLoggedAt?: string } | undefined {
  const content = (result as { content: { text: string }[] }).content;
  for (const block of content) {
    try {
      const parsed = JSON.parse(block.text) as {
        logging?: { cadence: string; lastLoggedAt?: string };
      };
      if (parsed.logging !== undefined) return parsed.logging;
    } catch {
      // non-JSON block: skip
    }
  }
  return undefined;
}

/** The meta.filter block appended to a read result, if any. */
function filterOf(result: unknown): { area: { uuid: string; title: string } } | undefined {
  const content = (result as { content: { text: string }[] }).content;
  for (const block of content) {
    try {
      const parsed = JSON.parse(block.text) as {
        meta?: { filter?: { area: { uuid: string; title: string } } };
      };
      if (parsed.meta?.filter !== undefined) return parsed.meta.filter;
    } catch {
      // non-JSON block: skip
    }
  }
  return undefined;
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
  "get_area",
  "clear_reminder",
  // verb-parameterized merges
  "update", // update_todo/update_project/update_area/update_tag
  "set_status", // set_todo_status/set_project_status
  "delete", // delete_item/delete_area/delete_tag
  "heading", // add/rename/archive/unarchive/promote/move-heading
  "convert_to_project", // promote a to-do into a project
  "repeat", // the 7 recurrence singletons (todo + project)
  // reads
  "read_view",
  "search",
  "changes_since",
  "get_item",
  "get_project",
  "list_collections",
  // to-dos
  "add_todo",
  "move_todo",
  "set_tags",
  "edit_checklist",
  // to-dos AND projects
  "restore_item",
  "duplicate_item",
  "clone_item",
  // projects
  "add_project",
  "move_project",
  // areas
  "add_area",
  // tags
  "add_tag",
  // system
  "log_now",
  // generic + discovery
  "run_operation",
  "batch",
  "reorder", // the ONE universal reorder (to-dos/projects/headings/areas; mirrors `things reorder`)
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

  it("read_view today returns the two children buckets with seeded members; counts on the metadata block", async () => {
    seedTodo(fixture.db, { title: "MCP-Today", startDate: "2026-07-05" });
    await connect([fakeVector(null).vector]);
    const result = await client.callTool({ name: "read_view", arguments: { view: "today" } });
    const view = textOf(result) as {
      today: { items: { title: string; when?: string }[] };
      evening: { items: unknown[] };
    };
    expect(view.today.items.map((i) => i.title)).toContain("MCP-Today");
    // The bucket key states today/evening — `when` is dropped inside the buckets.
    expect(view.today.items.find((i) => i.title === "MCP-Today")?.when).toBeUndefined();
    // The whole-view counts ride the metadata block (the CLI meta.counts analog).
    expect(countsOf(result)).toEqual({ dueOrOverdue: 0, other: 1 });
    expect(result.isError ?? false).toBe(false);
  });

  it("read_view logbook carries the log-move cadence on the metadata block (meta.logging analog)", async () => {
    const manual = Math.floor(NOW.getTime() / 1000) - 60;
    fixture.db
      .prepare("INSERT INTO TMSettings (uuid, logInterval, manualLogDate) VALUES ('S', 4, ?)")
      .run(manual);
    seedTodo(fixture.db, { title: "MCP-logged", status: "completed", stopDate: manual - 3600 });
    await connect([fakeVector(null).vector]);
    const result = await client.callTool({ name: "read_view", arguments: { view: "logbook" } });
    const logging = loggingOf(result);
    expect(logging?.cadence).toBe("Manually");
    expect(typeof logging?.lastLoggedAt).toBe("string");
    const items = textOf(result) as { title: string }[];
    expect(items.map((i) => i.title)).toContain("MCP-logged");
    expect(result.isError ?? false).toBe(false);
  });

  it("read_view logbook carries lastLoggedAt under Daily too (manual stamp is boundary-live)", async () => {
    const manual = Math.floor(NOW.getTime() / 1000) - 60;
    fixture.db
      .prepare("INSERT INTO TMSettings (uuid, logInterval, manualLogDate) VALUES ('S', 1, ?)")
      .run(manual);
    await connect([fakeVector(null).vector]);
    const result = await client.callTool({ name: "read_view", arguments: { view: "logbook" } });
    const logging = loggingOf(result);
    expect(logging?.cadence).toBe("Daily");
    expect(typeof logging?.lastLoggedAt).toBe("string");
    expect(result.isError ?? false).toBe(false);
  });

  it("log_now moves nothing under the default Immediately cadence and reports logged: 0", async () => {
    seedTodo(fixture.db, { title: "already-logged", status: "completed", stopDate: 1_700_000_000 });
    await connect([fakeVector(null, { id: "applescript", ops: ["log-now"] }).vector]);
    const result = await client.callTool({ name: "log_now", arguments: {} });
    expect(result.isError ?? false).toBe(false);
    const wire = textOf(result) as { op: string; observed: { logged: number }; undoToken?: string };
    expect(wire.op).toBe("log-now");
    expect(wire.observed.logged).toBe(0);
    expect(wire.undoToken).toBeUndefined(); // irreversible
  });

  it("read_view upcoming returns day-block sections (when-keyed), rows keep stage and drop the block's when (v2 PR 4)", async () => {
    // NOW is pinned to 2026-07-05; both rows are strictly future.
    seedTodo(fixture.db, {
      title: "MCP-up-a",
      start: "someday",
      startDate: "2026-07-10",
      index: 0,
    });
    seedTodo(fixture.db, {
      title: "MCP-up-b",
      start: "someday",
      startDate: "2026-07-10",
      index: 1,
    });
    seedTodo(fixture.db, {
      title: "MCP-up-c",
      start: "someday",
      startDate: "2026-07-14",
      index: 2,
    });
    await connect([fakeVector(null).vector]);
    const secs = textOf(
      await client.callTool({ name: "read_view", arguments: { view: "upcoming" } }),
    ) as Array<{ when: string | null; items: Array<Record<string, unknown>>; total?: number }>;
    // Chronological day blocks keyed by `when`.
    expect(secs.map((s) => s.when)).toEqual(["2026-07-10", "2026-07-14"]);
    expect(secs[0]!.items.map((i) => i["title"])).toEqual(["MCP-up-a", "MCP-up-b"]);
    // A dated-block row keeps `stage` (stage-mixed view) and drops the block's `when`.
    expect(secs[0]!.items[0]!["stage"]).toBe("upcoming");
    expect("when" in secs[0]!.items[0]!).toBe(false);
  });

  it("read_view surfaces the R13 provisional marker; today buckets drop stage; pulled row re-files to anytime", async () => {
    // A deadline-pulled SOMEDAY row (unmaterialized) is a provisional Today member.
    seedTodo(fixture.db, {
      title: "MCP-Pull",
      start: "someday",
      startDate: null,
      deadline: "2026-07-05",
    });
    // A materialized member (user-placed when=today) is NOT provisional.
    seedTodo(fixture.db, { title: "MCP-Placed", start: "active", startDate: "2026-07-05" });
    await connect([fakeVector(null).vector]);

    const today = textOf(
      await client.callTool({ name: "read_view", arguments: { view: "today" } }),
    ) as { today: { items: Array<Record<string, unknown>> }; evening: { items: unknown[] } };
    const pull = today.today.items.find((i) => i["title"] === "MCP-Pull")!;
    const placed = today.today.items.find((i) => i["title"] === "MCP-Placed")!;
    expect(pull["provisional"]).toBe(true); // the banner pip, as data
    expect("stage" in pull).toBe(false); // today buckets are stage-pure (R13)
    expect(placed["provisional"]).toBeUndefined(); // materialized → not provisional

    // GUI fidelity: the pulled row is GONE from someday, PRESENT in anytime.
    const someday = textOf(
      await client.callTool({ name: "read_view", arguments: { view: "someday" } }),
    ) as Array<{ items: Array<Record<string, unknown>> }>;
    expect(someday.flatMap((s) => s.items).some((i) => i["title"] === "MCP-Pull")).toBe(false);
    const anytime = textOf(
      await client.callTool({ name: "read_view", arguments: { view: "anytime" } }),
    ) as Array<{ items: Array<Record<string, unknown>> }>;
    const anyPull = anytime.flatMap((s) => s.items).find((i) => i["title"] === "MCP-Pull")!;
    expect(anyPull).toBeDefined();
    expect(anyPull["provisional"]).toBe(true); // marker rides the anytime catalogue too
    expect(anyPull["when"]).toBe("today");
  });

  it("read_view defaults to the compact tier; full: true restores the full record (R7)", async () => {
    seedTodo(fixture.db, { title: "MCP-compact", start: "inbox" });
    await connect([fakeVector(null).vector]);

    const compact = textOf(
      await client.callTool({ name: "read_view", arguments: { view: "inbox" } }),
    ) as Array<Record<string, unknown>>;
    const crow = compact.find((i) => i["title"] === "MCP-compact")!;
    expect("status" in crow).toBe(false); // open default-pruned
    expect("created" in crow).toBe(false);
    expect("repeating" in crow).toBe(false);

    const full = textOf(
      await client.callTool({ name: "read_view", arguments: { view: "inbox", full: true } }),
    ) as Array<Record<string, unknown>>;
    const frow = full.find((i) => i["title"] === "MCP-compact")!;
    expect(frow["status"]).toBe("open");
    expect("created" in frow).toBe(true);
    expect("modified" in frow).toBe(true);
  });

  it("get_project honors the full param and applies R6 ancestry stripping", async () => {
    const area = seedArea(fixture.db, "MCP-Area", 0);
    const proj = seedProject(fixture.db, { title: "MCP-Proj", area });
    seedTodo(fixture.db, { title: "child", project: proj });
    await connect([fakeVector(null).vector]);

    type PView = { children: { anytime: { items: Array<Record<string, unknown>> } } };
    const compact = textOf(
      await client.callTool({ name: "get_project", arguments: { uuid: proj } }),
    ) as PView;
    const child = compact.children.anytime.items[0]!;
    // R6: a project-view child drops project + area (the card states them).
    expect("project" in child).toBe(false);
    expect("area" in child).toBe(false);
    expect("created" in child).toBe(false); // compact

    const full = textOf(
      await client.callTool({ name: "get_project", arguments: { uuid: proj, full: true } }),
    ) as PView;
    const fchild = full.children.anytime.items[0]!;
    expect("created" in fchild).toBe(true); // full restores density
    expect("project" in fchild).toBe(false); // R6 still applies under --full
  });

  describe("read_view deadlines", () => {
    it("returns the deadline-ordered items (most-overdue first) with `stage` kept", async () => {
      seedTodo(fixture.db, { title: "MCP-overdue", deadline: "2026-06-30", start: "active" });
      seedProject(fixture.db, { title: "MCP-future", deadline: "2026-07-20" });
      seedTodo(fixture.db, { title: "MCP-none", start: "active" }); // no deadline → excluded
      await connect([fakeVector(null).vector]);
      const result = await client.callTool({ name: "read_view", arguments: { view: "deadlines" } });
      const items = textOf(result) as { title: string; stage?: string }[];
      expect(items.map((i) => i.title)).toEqual(["MCP-overdue", "MCP-future"]);
      expect(items[0]?.stage).toBeDefined(); // stage-mixed view keeps stage
      expect(result.isError ?? false).toBe(false);
    });

    it("honors `today` and `overdue`; both compose", async () => {
      seedTodo(fixture.db, {
        title: "today-dl",
        startDate: "2026-07-05",
        deadline: "2026-06-30",
        start: "active",
      });
      seedTodo(fixture.db, { title: "someday-dl", start: "someday", deadline: "2026-07-25" });
      await connect([fakeVector(null).vector]);
      const scoped = await client.callTool({
        name: "read_view",
        arguments: { view: "deadlines", today: true, overdue: true },
      });
      expect((textOf(scoped) as { title: string }[]).map((i) => i.title)).toEqual(["today-dl"]);
    });

    it("`today` and `project` are deadlines-only (usage error elsewhere)", async () => {
      await connect([fakeVector(null).vector]);
      const badToday = await client.callTool({
        name: "read_view",
        arguments: { view: "anytime", today: true },
      });
      expect(badToday.isError).toBe(true);
      expect(textOf(badToday)).toMatchObject({ code: "usage" });
      const badProject = await client.callTool({
        name: "read_view",
        arguments: { view: "inbox", project: "whatever" },
      });
      expect(badProject.isError).toBe(true);
      expect(textOf(badProject)).toMatchObject({ code: "usage" });
    });
  });

  describe("read_view area filter", () => {
    it("scopes anytime to the target area and reports meta.filter", async () => {
      const alpha = seedArea(fixture.db, "Alpha", 0);
      const beta = seedArea(fixture.db, "Beta", 1);
      const pAlpha = seedProject(fixture.db, { title: "p-alpha", area: alpha });
      seedTodo(fixture.db, { title: "a-loose", area: alpha });
      seedTodo(fixture.db, { title: "p-alpha-child", project: pAlpha });
      seedTodo(fixture.db, { title: "b-loose", area: beta });
      seedTodo(fixture.db, { title: "orphan" });
      await connect([fakeVector(null).vector]);
      const result = await client.callTool({
        name: "read_view",
        arguments: { view: "anytime", area: "Alpha" },
      });
      expect(result.isError ?? false).toBe(false);
      const sections = textOf(result) as Array<{ items: { title: string }[] }>;
      expect(sections.flatMap((s) => s.items.map((i) => i.title)).toSorted()).toEqual([
        "a-loose",
        "p-alpha",
        "p-alpha-child",
      ]);
      expect(filterOf(result)).toEqual({ area: { uuid: alpha, title: "Alpha" } });
    });

    it("emits no meta.filter when unscoped", async () => {
      seedArea(fixture.db, "Alpha", 0);
      seedTodo(fixture.db, { title: "x", startDate: "2026-07-05" });
      await connect([fakeVector(null).vector]);
      const result = await client.callTool({ name: "read_view", arguments: { view: "anytime" } });
      expect(filterOf(result)).toBeUndefined();
    });

    it("fails closed on an unresolvable area ref", async () => {
      seedArea(fixture.db, "Alpha", 0);
      await connect([fakeVector(null).vector]);
      const result = await client.callTool({
        name: "read_view",
        arguments: { view: "anytime", area: "Nope" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatchObject({ code: "not-found" });
    });

    it("rejects area on a view it does not apply to (inbox)", async () => {
      await connect([fakeVector(null).vector]);
      const result = await client.callTool({
        name: "read_view",
        arguments: { view: "inbox", area: "Alpha" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatchObject({ code: "usage" });
    });
  });

  describe("loose pseudo-area shadow disclosure (meta.warnings parity, #333/#346)", () => {
    // When a real area named "Loose" shadows the reserved `loose` ref, the reads
    // that address the null area must disclose it (by uuid) in meta.warnings, the
    // same advisory the CLI surfaces — so an MCP consumer can still target it.
    it("read_view --area loose warns when a real 'Loose' area shadows the reserved word", async () => {
      const shadow = seedArea(fixture.db, "Loose", 0);
      seedTodo(fixture.db, { title: "orphan", startDate: "2026-07-05" }); // an area-less Today row
      await connect([fakeVector(null).vector]);
      const result = await client.callTool({
        name: "read_view",
        arguments: { view: "anytime", area: "loose" },
      });
      expect(result.isError ?? false).toBe(false);
      const warnings = warningsOf(result);
      expect(warnings?.some((w) => w.includes("loose pseudo-area") && w.includes(shadow))).toBe(
        true,
      );
    });

    it("read_view --area loose emits no shadow warning when nothing shadows it", async () => {
      seedArea(fixture.db, "Real Area", 0);
      seedTodo(fixture.db, { title: "orphan", startDate: "2026-07-05" });
      await connect([fakeVector(null).vector]);
      const result = await client.callTool({
        name: "read_view",
        arguments: { view: "anytime", area: "loose" },
      });
      expect(warningsOf(result)).toBeUndefined();
    });

    it("search --area loose threads the same shadow disclosure", async () => {
      const shadow = seedArea(fixture.db, "Loose", 0);
      seedTodo(fixture.db, { title: "findme" });
      await connect([fakeVector(null).vector]);
      const result = await client.callTool({
        name: "search",
        arguments: { query: "findme", area: "loose" },
      });
      expect(result.isError ?? false).toBe(false);
      const warnings = warningsOf(result);
      expect(warnings?.some((w) => w.includes("loose pseudo-area") && w.includes(shadow))).toBe(
        true,
      );
    });

    it("get_area loose surfaces the area-view's own placement notice", async () => {
      const shadow = seedArea(fixture.db, "Loose", 0);
      seedTodo(fixture.db, { title: "orphan" }); // an area-less to-do (the loose composite)
      await connect([fakeVector(null).vector]);
      const result = await client.callTool({
        name: "get_area",
        arguments: { ref: "loose" },
      });
      expect(result.isError ?? false).toBe(false);
      const warnings = warningsOf(result);
      expect(warnings?.some((w) => w.includes("loose pseudo-area") && w.includes(shadow))).toBe(
        true,
      );
    });
  });

  describe("consumer timezone (per-call tz)", () => {
    // One instant, two calendars two days apart: Kiritimati (UTC+14) is Jul 3,
    // Midway (UTC-11) is Jul 1. A startDate of Jul 2 is thus a past-or-today
    // (Today member) date in Kiritimati but a FUTURE date in Midway.
    const NOW_TZ = new Date("2026-07-02T10:00:00Z");

    it("per-call tz overrides THINGS_TZ, flipping today membership + meta.clock", async () => {
      seedTodo(fixture.db, { title: "TZ-item", startDate: "2026-07-02" });
      await connectClock([fakeVector(null).vector], NOW_TZ, { THINGS_TZ: "Pacific/Midway" });

      // Per-call Kiritimati (ahead): the item is a Today member; clock re-scoped.
      const ahead = await client.callTool({
        name: "read_view",
        arguments: { view: "today", tz: "Pacific/Kiritimati" },
      });
      expect(
        (textOf(ahead) as { today: { items: { title: string }[] } }).today.items.map(
          (i) => i.title,
        ),
      ).toContain("TZ-item");
      expect(clockOf(ahead)).toEqual({ timezone: "Pacific/Kiritimati", today: "2026-07-03" });

      // No per-call tz → the server default (THINGS_TZ=Midway): NOT yet today.
      const behind = await client.callTool({ name: "read_view", arguments: { view: "today" } });
      expect(
        (textOf(behind) as { today: { items: { title: string }[] } }).today.items.map(
          (i) => i.title,
        ),
      ).not.toContain("TZ-item");
      expect(clockOf(behind)).toEqual({ timezone: "Pacific/Midway", today: "2026-07-01" });
    });

    it("emits no meta.clock on the host clock (no zone / no pinned now)", async () => {
      seedTodo(fixture.db, { title: "Plain", startDate: "2026-07-02" });
      await connectClock([fakeVector(null).vector], NOW_TZ);
      const result = await client.callTool({ name: "read_view", arguments: { view: "today" } });
      expect(clockOf(result)).toBeUndefined();
    });

    it("refuses when: evening fail-closed when the consumer's date differs from the host", async () => {
      await connectClock([fakeVector(null).vector], NOW_TZ);
      // The host's date for this instant matches at most ONE of these far-apart
      // zones, so at least one evening write is refused with blocked:clock.
      const results = await Promise.all(
        ["Pacific/Kiritimati", "Pacific/Midway"].map((tz) =>
          client.callTool({
            name: "add_todo",
            arguments: { title: `Ev-${tz}`, when: "evening", tz },
          }),
        ),
      );
      const refused = results.filter((r) => r.isError === true);
      expect(refused.length).toBeGreaterThanOrEqual(1);
      for (const r of refused) {
        const err = textOf(r) as { code: string; message: string };
        expect(err.code).toBe("blocked:clock");
        expect(err.message).toMatch(/This Evening/i);
      }
    });

    it("rejects an invalid per-call tz with a usage error", async () => {
      await connectClock([fakeVector(null).vector], NOW_TZ);
      const result = await client.callTool({
        name: "read_view",
        arguments: { view: "today", tz: "Bogus/Zone" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatchObject({ code: "usage" });
    });
  });

  it("read_view today with evening: true returns only the This-Evening bucket members", async () => {
    seedTodo(fixture.db, { title: "MCP-Day", startDate: "2026-07-05" });
    seedTodo(fixture.db, { title: "MCP-Night", startDate: "2026-07-05", evening: true });
    await connect([fakeVector(null).vector]);
    const result = await client.callTool({
      name: "read_view",
      arguments: { view: "today", evening: true },
    });
    const view = textOf(result) as {
      today: { items: unknown[] };
      evening: { items: { title: string }[] };
    };
    expect(view.today.items).toEqual([]);
    expect(view.evening.items.map((i) => i.title)).toEqual(["MCP-Night"]);
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
    ) as { today: { items: { title: string }[] } };
    expect(view.today.items.map((i) => i.title)).toEqual(["MCP bare"]);
    const conflict = await client.callTool({
      name: "read_view",
      arguments: { view: "today", untagged: true, tag: ["focus"] },
    });
    expect(conflict.isError).toBe(true);
    expect(textOf(conflict)).toMatchObject({ code: "usage" });
  });

  it("update kind todo edits a to-do (dry-run routes to todo.update)", async () => {
    const uuid = seedTodo(fixture.db, { title: "editable" });
    await connect([fakeVector(null, { ops: ["todo.update"] }).vector]);
    const outcome = textOf(
      await client.callTool({
        name: "update",
        arguments: { kind: "todo", uuid, title: "renamed", dry_run: true },
      }),
    ) as { op: string };
    expect(outcome.op).toBe("todo.update");
  });

  it("update kind project on an ambiguous NAME returns structured candidates (name sugar + machine detail)", async () => {
    // MCP inherits the name/partial-uuid write-target sugar via the shared
    // pipeline: passing a NAME (not a uuid) resolves it — proven by the
    // ambiguity, which also proves the structured candidates ride the result.
    seedProject(fixture.db, { title: "Dup" });
    seedProject(fixture.db, { title: "Dup" });
    await connect([fakeVector(null, { ops: ["project.update"] }).vector]);
    const result = await client.callTool({
      name: "update",
      arguments: { kind: "project", uuid: "Dup", title: "x" },
    });
    expect(result.isError).toBe(true);
    const err = textOf(result) as {
      code: string;
      details?: { candidates?: Record<string, unknown>[] };
    };
    expect(err.code).toBe("ambiguous");
    expect(err.details?.candidates).toHaveLength(2);
    // Library shape flows through unchanged: the MCP candidate is the SAME fixed
    // {@link CandidateRef} the CLI emits — type-tagged, allowed keys only.
    const cand = err.details?.candidates?.[0] ?? {};
    expect(cand).toHaveProperty("title", "Dup");
    expect(cand).toHaveProperty("type", "project");
    const allowed = new Set(["uuid", "title", "type", "area", "project", "stage", "when"]);
    for (const k of Object.keys(cand)) expect(allowed.has(k)).toBe(true);
  });

  it("a not-found write target returns code=not-found (structured, empty candidates)", async () => {
    await connect([fakeVector(null, { ops: ["project.update"] }).vector]);
    const result = await client.callTool({
      name: "update",
      arguments: { kind: "project", uuid: "ghost", title: "x" },
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
    ) as { today: { items: { title: string }[] } };
    expect(anded.today.items.map((i) => i.title)).toEqual(["MCP both"]);
    // Flat tag foo is inheritance-inclusive: direct AND area-inherited rows.
    const single = textOf(
      await client.callTool({
        name: "read_view",
        arguments: { view: "today", tag: ["foo"] },
      }),
    ) as { today: { items: { title: string }[] } };
    expect(single.today.items.map((i) => i.title).toSorted()).toEqual([
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
    ) as { today: { items: { title: string }[] } };
    expect(removed.today.items.map((i) => i.title).toSorted()).toEqual([
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
    ) as { children: { anytime: { items: { title: string }[] } } };
    expect(proj.children.anytime.items.map((i) => i.title)).toEqual(["child-focus"]);
    // get_area tag → single-container semantics: loose to-dos + child projects
    // carrying focus DIRECTLY (Home's inherited focus is suppressed, so PBare —
    // which only inherits — is excluded).
    const areaRes = textOf(
      await client.callTool({
        name: "get_area",
        arguments: { ref: "Home", tag: ["focus"] },
      }),
    ) as {
      children: { anytime: { items: { title: string }[] } };
      projects: { items: { title: string }[] };
    };
    expect(areaRes.children.anytime.items.map((i) => i.title)).toEqual(["loose-focus"]);
    expect(areaRes.projects.items.map((i) => i.title)).toEqual(["P"]);
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
    ) as { today: { items: { title: string }[] }; evening: { items: unknown[] } };
    expect(view.today.items.map((i) => i.title)).toEqual(["MCP overdue"]);
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

  it("search inherits the match-provenance annotation from the library (checklist arm, no uuid)", async () => {
    const todo = seedTodo(fixture.db, { title: "wire the cab" });
    const cli = seedChecklistItem(fixture.db, todo, "solder the jamma harness");
    await connect([fakeVector(null).vector]);
    const result = await client.callTool({ name: "search", arguments: { query: "jamma" } });
    const hits = textOf(result) as Array<{ uuid: string; match?: { field: string; text: string } }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]?.uuid).toBe(todo);
    expect(hits[0]?.match).toEqual({ field: "checklist", text: "solder the jamma harness" });
    // The checklist-item uuid appears on NO surface.
    expect(JSON.stringify(result)).not.toContain(cli);
  });

  it("search limit + all normalizes to all winning (no usage error)", async () => {
    for (let i = 0; i < 4; i++) seedTodo(fixture.db, { title: `bulk ${i}`, index: i });
    await connect([fakeVector(null).vector]);
    const capped = textOf(
      await client.callTool({ name: "search", arguments: { query: "bulk", limit: 2 } }),
    ) as { title: string }[];
    expect(capped).toHaveLength(2);
    // all wins and limit is ignored — the call succeeds returning every match.
    const both = await client.callTool({
      name: "search",
      arguments: { query: "bulk", limit: 2, all: true },
    });
    expect(both.isError ?? false).toBe(false);
    expect(textOf(both) as { title: string }[]).toHaveLength(4);
  });

  it("read_view caps at 50 by default and reports truncation in a second block", async () => {
    for (let i = 0; i < 60; i++)
      seedTodo(fixture.db, { title: `cap ${i}`, start: "inbox", index: i });
    await connect([fakeVector(null).vector]);
    const result = await client.callTool({ name: "read_view", arguments: { view: "inbox" } });
    const data = textOf(result) as unknown[];
    expect(data).toHaveLength(50);
    const content = (result as { content: { text: string }[] }).content;
    const meta = JSON.parse(content[1]?.text ?? "{}") as {
      truncation: { shown: number; total: number; truncated: boolean };
      note: string;
    };
    expect(meta.truncation).toEqual({ shown: 50, total: 60, limit: 50, truncated: true });
    expect(meta.note).toContain("showing 50 of 60");
  });

  it("read_view all: true lifts the cap; limit + all normalizes to all winning", async () => {
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
    // Both set: all wins and limit is ignored — the call succeeds with every row,
    // never a usage error (the ergonomics fix for the observed limit+all misuse).
    const both = await client.callTool({
      name: "read_view",
      arguments: { view: "inbox", limit: 10, all: true },
    });
    expect(both.isError ?? false).toBe(false);
    expect(textOf(both) as unknown[]).toHaveLength(60);
  });

  it("read_view anytime previews 3 per project block by default; all lifts every cap", async () => {
    const area = seedArea(fixture.db, "Hobbies");
    const proj = seedProject(fixture.db, { title: "Firmware", area, index: 1 });
    for (let i = 0; i < 8; i++) seedTodo(fixture.db, { title: `fw ${i}`, project: proj, index: i });
    await connect([fakeVector(null).vector]);

    type Section = {
      area: { title?: string } | null;
      items: { title?: string }[];
      total?: number;
    };
    const result = await client.callTool({ name: "read_view", arguments: { view: "anytime" } });
    const content = (result as { content: { text: string }[] }).content;
    const meta = JSON.parse(content[1]?.text ?? "{}") as {
      truncation: { truncated: boolean };
      note: string;
    };
    expect(meta.truncation.truncated).toBe(true);
    // The per-block `blocks[]` sidecar is retired from the wire (PR 5): each
    // capped section carries its inline `total` in the data block instead.
    expect("blocks" in meta.truncation).toBe(false);
    const hobbies = (textOf(result) as Section[]).find((s) => s.area?.title === "Hobbies");
    // 4 shown (1 project row + 3 children) of a 9-row scope → inline `total: 9`.
    expect(hobbies?.total).toBe(9);
    expect(meta.note).toContain("per block");

    const wider = await client.callTool({
      name: "read_view",
      arguments: { view: "anytime", project_limit: 5 },
    });
    const widerHobbies = (textOf(wider) as Section[]).find((s) => s.area?.title === "Hobbies");
    // A higher per-project cap shows 5 children: 1 project row + 5 = 6 items.
    expect(widerHobbies?.items).toHaveLength(6);
    expect(widerHobbies?.total).toBe(9);

    const all = await client.callTool({
      name: "read_view",
      arguments: { view: "anytime", all: true },
    });
    const allMeta = JSON.parse(
      (all as { content: { text: string }[] }).content[1]?.text ?? "{}",
    ) as { truncation: { truncated: boolean } };
    expect(allMeta.truncation.truncated).toBe(false);
    // Uncapped: the whole section shows, so no inline `total` (R1).
    expect(
      (textOf(all) as Section[]).find((s) => s.area?.title === "Hobbies")?.total,
    ).toBeUndefined();
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
      ) as { truncation: { truncated: boolean } };
      // The `blocks[]` sidecar is retired (PR 5): the capped section carries its
      // inline `total` in the data block. Hobbies holds only Active Proj's 4
      // someday children (no own someday rows); capped at 2, so 2 shown of 4.
      expect("blocks" in meta.truncation).toBe(false);
      const hobbies = (
        textOf(capped) as Array<{
          area: { title?: string } | null;
          items: unknown[];
          total?: number;
        }>
      ).find((s) => s.area?.title === "Hobbies");
      expect(hobbies?.items).toHaveLength(2);
      expect(hobbies?.total).toBe(4);
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
    expect("type" in item).toBe(false); // absent `type` = to-do
    expect(item["title"]).toBe("bare mcp item");
    // Empty optional fields are absent (absent = unset), mirroring the CLI.
    for (const gone of ["deadline", "startDate", "reminder", "area", "project", "tags"]) {
      expect(gone in item).toBe(false);
    }
    // The reversal: an empty inherited-tag set is absent, not [].
    expect("inheritedTags" in item).toBe(false);
    // R10: start/logged/trashed are gone; the derived `stage` is kept on a detail.
    expect(item["stage"]).toBe("anytime");
    expect("logged" in item).toBe(false);
    expect("start" in item).toBe(false);
    // Checklist nesting (universal): the flat counts are gone from the wire, and
    // an item with no checklist carries NO `checklist` key at all (presence-keyed).
    expect("checklistItemsCount" in item).toBe(false);
    expect("openChecklistItemsCount" in item).toBe(false);
    expect("checklist" in item).toBe(false);
    // Repeating omission (universal): the all-false block is dropped entirely.
    expect("repeating" in item).toBe(false);
  });

  it("get_item — R11 template/instance split rides the shared library shaping", async () => {
    const tmpl = seedTodo(fixture.db, {
      title: "mcp tpl",
      recurrenceRule: true,
      nextInstanceStartDate: "2026-08-01",
    });
    const newest = seedTodo(fixture.db, {
      title: "occ",
      repeatingTemplate: tmpl,
      creationDate: 1_783_468_800,
    });
    await connect([fakeVector(null).vector]);
    const template = textOf(
      await client.callTool({ name: "get_item", arguments: { uuid: tmpl } }),
    ) as Record<string, unknown>;
    // Template wire: presence of `repeating` MEANS template; the discriminators
    // are gone. R12: the forward pointer `nextOccurrence` moved to the top-level
    // `when`; `repeating` keeps the backward pointer `latestInstance` (detail).
    expect(template["repeating"]).toEqual({ latestInstance: newest });
    expect(template["when"]).toBe("2026-08-01");
    expect("instanceOf" in template).toBe(false);
    // Instance wire: flat instanceOf only, no `repeating`.
    const instance = textOf(
      await client.callTool({ name: "get_item", arguments: { uuid: newest } }),
    ) as Record<string, unknown>;
    expect(instance["instanceOf"]).toBe(tmpl);
    expect("repeating" in instance).toBe(false);
  });

  it("get_item — an INSTANCE's `repeats` context rides the shared detail shaping (MCP parity)", async () => {
    // A FIXED weekly rule (tp=0) so the mirror join decodes it and projects `next`.
    const FIXED_WEEKLY_XML =
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>` +
      `<key>fa</key><integer>1</integer><key>fu</key><integer>256</integer>` +
      `<key>of</key><array><dict><key>wd</key><integer>0</integer></dict></array>` +
      `<key>rc</key><integer>0</integer><key>rrv</key><integer>4</integer>` +
      `<key>tp</key><integer>0</integer><key>ts</key><integer>0</integer></dict></plist>`;
    const tmpl = seedTodo(fixture.db, {
      title: "mcp fixed tpl",
      recurrenceRuleXml: FIXED_WEEKLY_XML,
      nextInstanceStartDate: "2026-08-19",
    });
    const occ = seedTodo(fixture.db, { title: "mcp occ", repeatingTemplate: tmpl });
    await connect([fakeVector(null).vector]);
    const instance = textOf(
      await client.callTool({ name: "get_item", arguments: { uuid: occ } }),
    ) as Record<string, unknown>;
    // The instance marker + write handle is unchanged; the joined repeat context
    // rides beside it as `repeats` (same shaping path the CLI detail uses).
    expect(instance["instanceOf"]).toBe(tmpl);
    const repeats = instance["repeats"] as Record<string, unknown>;
    expect((repeats["rule"] as Record<string, unknown>)["type"]).toBe("fixed");
    expect(repeats["next"]).toBe("2026-08-19"); // FIXED mode → the projected next occurrence
    expect("repeating" in instance).toBe(false);
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
    const outcome = textOf(result) as { op: string; uuid: string };
    // ok framing (phase 2): the content block carries no `kind`/`result`
    // discriminator (call success is the tool result's own not-an-error signal),
    // but the library payload fields pass straight through.
    expect("kind" in outcome).toBe(false);
    expect("result" in outcome).toBe(false);
    expect(outcome.op).toBe("todo.add");
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
    const outcome = textOf(result) as { op: string; invocation: string };
    expect(outcome.invocation).toContain("things:///add?title=Plan%20me");
    expect(calls).toHaveLength(0);
  });

  it("set_status scope todo routes each status to the matching operation", async () => {
    const uuid = seedTodo(fixture.db, { title: "status me" });
    await connect([
      fakeVector(null, { ops: ["todo.complete", "todo.cancel", "todo.reopen"] }).vector,
    ]);
    for (const [status, op] of [
      ["completed", "todo.complete"],
      ["canceled", "todo.cancel"],
      ["open", "todo.reopen"],
    ] as const) {
      const outcome = textOf(
        // each call shares one MCP client/transport; concurrent calls would race on it
        await client.callTool({
          name: "set_status",
          arguments: { scope: "todo", uuid, status, dry_run: true },
        }),
      ) as { kind: string; op: string };
      expect(outcome.op).toBe(op);
    }

    // scope todo rejects the project-only children policy fields
    const rejected = await client.callTool({
      name: "set_status",
      arguments: { scope: "todo", uuid, status: "completed", children: "auto-complete" },
    });
    expect(rejected.isError).toBe(true);
    expect((textOf(rejected) as { code: string }).code).toBe("usage");
  });

  it("move_todo refuses multiple destinations and the bare invocation (spec §4)", async () => {
    await connect([fakeVector(null).vector]);
    for (const args of [
      { uuids: ["some-uuid"] }, // bare: no destination, no position
      { uuids: ["some-uuid"], to_inbox: true, loose: true },
      { uuids: ["some-uuid"], to_project: "P", to_area: "A" },
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
    ) as { op: string; invocation: string };
    // The granular edit is audited as its own op; its delivery is the rewrite.
    expect(outcome.op).toBe("todo.edit-checklist-item");
    expect(outcome.invocation).toContain("things:///json");

    const missing = await client.callTool({
      name: "edit_checklist",
      arguments: { uuid, action: "rename", item: "step one" },
    });
    expect(missing.isError).toBe(true);
    expect((textOf(missing) as { code: string }).code).toBe("usage");
  });

  it("delete kind item dispatches on the item's type", async () => {
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
        await client.callTool({
          name: "delete",
          arguments: { kind: "item", uuid, dry_run: true },
        }),
      ) as { kind: string; op: string };
      expect(outcome.op).toBe(op);
    }
    const unknown = await client.callTool({
      name: "delete",
      arguments: { kind: "item", uuid: "missing", dry_run: true },
    });
    expect(unknown.isError).toBe(true);
    expect((textOf(unknown) as { code: string }).code).toBe("usage");
  });

  it("set_status scope project enforces the children policy per status", async () => {
    const proj = seedProject(fixture.db, { title: "lifecycle" });
    await connect([
      fakeVector(null, { ops: ["project.complete", "project.cancel", "project.reopen"] }).vector,
    ]);
    const noPolicy = await client.callTool({
      name: "set_status",
      arguments: { scope: "project", uuid: proj, status: "completed" },
    });
    expect(noPolicy.isError).toBe(true);
    expect((textOf(noPolicy) as { message: string }).message).toContain("require-resolved");

    const wrongPolicy = await client.callTool({
      name: "set_status",
      arguments: { scope: "project", uuid: proj, status: "canceled", children: "auto-complete" },
    });
    expect(wrongPolicy.isError).toBe(true);

    const completed = textOf(
      await client.callTool({
        name: "set_status",
        arguments: {
          scope: "project",
          uuid: proj,
          status: "completed",
          children: "auto-complete",
          dry_run: true,
        },
      }),
    ) as { op: string };
    expect(completed.op).toBe("project.complete");
  });

  it("set_status scope project open returns the reopen outcome with children detail", async () => {
    const proj = seedProject(fixture.db, { title: "reopen me", status: "completed" });
    await connect([fakeVector(null, { ops: ["project.reopen"] }).vector]);
    const outcome = textOf(
      await client.callTool({
        name: "set_status",
        arguments: { scope: "project", uuid: proj, status: "open", dry_run: true },
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
    const view = textOf(capped) as {
      projects: { items: unknown[]; total?: number };
      children: { anytime: { items: unknown[]; total?: number } };
    };
    // v2: each capped scope's completeness rides its INLINE `total` (R1) — the
    // `blocks[]` sidecar retires from the metadata block (PR 3).
    expect(view.projects.items).toHaveLength(30);
    expect(view.projects.total).toBe(35);
    expect(view.children.anytime.items).toHaveLength(30);
    expect(view.children.anytime.total).toBe(35);
    const meta = JSON.parse(
      (capped as { content: { text: string }[] }).content[1]?.text ?? "{}",
    ) as {
      truncation: { truncated: boolean; blocks?: unknown };
    };
    expect(meta.truncation.truncated).toBe(true);
    expect("blocks" in meta.truncation).toBe(false);

    const all = textOf(
      await client.callTool({ name: "get_area", arguments: { ref: "Busy", all: true } }),
    ) as { projects: { items: unknown[]; total?: number } };
    expect(all.projects.items).toHaveLength(35);
    expect("total" in all.projects).toBe(false); // uncapped → no inline total

    const narrowed = textOf(
      await client.callTool({ name: "get_area", arguments: { ref: "Busy", project_limit: 2 } }),
    ) as {
      projects: { items: unknown[] };
      children: { anytime: { items: unknown[] } };
    };
    expect(narrowed.projects.items).toHaveLength(2);
    expect(narrowed.children.anytime.items).toHaveLength(30);

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
      children: { anytime: { items: { title: string }[] } };
      headings: {
        uuid: string;
        title: string;
        children: { anytime: { items: { title: string }[] } };
      }[];
    };
    expect(view.project.title).toBe("MCP Launch");
    expect(view.children.anytime.items.map((i) => i.title)).toEqual(["loose-overdue"]);
    // v2: the heading node IS the headings[] entry ({uuid, title, archived?, children}).
    expect(view.headings).toHaveLength(1);
    expect(view.headings[0]?.title).toBe("Phase 1");
    expect(view.headings[0]?.children.anytime.items.map((i) => i.title)).toEqual(["p1-overdue"]);
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
    ) as {
      children: { anytime: { items: { title: string }[] } };
      projects: { items: { title: string }[] };
    };
    expect(view.children.anytime.items.map((i) => i.title)).toEqual(["todo-overdue"]);
    expect(view.projects.items.map((i) => i.title)).toEqual(["proj-overdue"]);
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
    expect(byName.get("delete")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("repeat")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("update")?.annotations?.destructiveHint).toBe(false);
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
    // The merged write tools that can target a project resolve a unique NAME through the
    // shared pipeline (#157) — their shared uuid arg advertises name acceptance. (move_project
    // is now variadic — its `uuids` items carry the ref format instead of a single `uuid`.)
    for (const name of ["update", "set_status", "repeat"]) {
      expect(uuidDesc(name), name).toContain("unique name");
    }
    // To-do-only write targets are identity-addressed — the target must never claim name acceptance.
    for (const name of ["move_todo"]) {
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
        name: "update",
        arguments: { kind: "todo", uuid, title: "renamed", dry_run: true },
      });
      expect(result.isError).toBe(true);
      const error = textOf(result) as { code: string };
      expect(error.code).toBe("blocked:disruption-tier");
    });

    it("permits the same op when the daemon was started with the ceiling raised", async () => {
      const uuid = seedTodo(fixture.db, { title: "ceiling" });
      await connect([tierVector("todo.update", 2)], { maxDisruption: 2 });
      const result = await client.callTool({
        name: "update",
        arguments: { kind: "todo", uuid, title: "renamed", dry_run: true },
      });
      expect(result.isError ?? false).toBe(false);
      // Permitted (not tier-blocked): a dry-run plan comes back, carrying the op.
      const outcome = textOf(result) as { op: string };
      expect(outcome.op).toBe("todo.update");
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
      // "badge" is GUI-chrome vocabulary — the read-shape doctrine forbids
      // describing how the app looks; the today counts are self-explanatory data.
      /\bbadge\b/i,
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
      const blockedResults = textOf(blocked) as { outcome: string }[];
      expect(blockedResults[0]?.outcome).toBe("blocked");

      const allowed = await client.callTool({
        name: "batch",
        arguments: {
          ops: [{ op: "trash.empty", params: {}, options: { dangerously_permanent: true } }],
          dry_run: true,
        },
      });
      const allowedResults = textOf(allowed) as { outcome: string }[];
      expect(allowedResults[0]?.outcome).toBe("dry-run");
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

  // Each batch line is FLATTENED to the wire shape (parity with the CLI JSONL):
  // { index, op, outcome: "<tag>", ...hoisted variant fields }. A failure that is
  // not the last op leaves the rest "skipped" under fail_fast.
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
      ) as { index: number; op: string; outcome: string }[];
      expect(results.map((r) => r.op)).toEqual(["todo.add", "todo.add"]);
      expect(results.map((r) => r.outcome)).toEqual(["dry-run", "dry-run"]);
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
      ) as { outcome: string }[];
      expect(results[0]?.outcome).toBe("blocked");
      expect(results[1]?.outcome).toBe("skipped");
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
      ) as { outcome: string }[];
      expect(blocked[0]?.outcome).toBe("blocked");

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
      ) as { outcome: string }[];
      expect(allowed[0]?.outcome).toBe("dry-run");
    });

    it("mirrors the op_id field and surfaces the batch summary block (undo_token)", async () => {
      // A real (non-dry-run) leg the fake vector applies: completing a seeded
      // to-do, carrying an op_id (temp_id needs a minting op — covered by the
      // engine suite and the declaration test below).
      const uuid = seedTodo(fixture.db, { title: "mirror me" });
      await connect([
        fakeVector((payload) => {
          if (payload.includes(`id=${uuid}`)) {
            fixture.db
              .prepare("UPDATE TMTask SET status = 3, stopDate = 1783300000 WHERE uuid = ?")
              .run(uuid);
          }
        }).vector,
      ]);
      const result = await client.callTool({
        name: "batch",
        arguments: {
          ops: [{ op: "todo.complete", params: { uuid }, op_id: "mirror-1" }],
        },
      });
      // First content block: the per-op results (existing array shape, plus the
      // additive opId echo).
      const results = textOf(result) as { outcome: string; opId?: string }[];
      expect(results[0]?.outcome).toBe("ok");
      expect(results[0]?.opId).toBe("mirror-1");
      // Second content block: the batch summary additions (undo the whole batch).
      const content = (result as { content: { text: string }[] }).content;
      const summary = JSON.parse(content[1]?.text ?? "{}") as { undoToken?: string };
      expect(typeof summary.undoToken).toBe("string");
    });

    it("mirrors temp-id declaration usage errors (duplicate temp_id rejects the whole batch)", async () => {
      await connect([fakeVector(null).vector]);
      const results = textOf(
        await client.callTool({
          name: "batch",
          arguments: {
            ops: [
              { op: "todo.add", params: { title: "A" }, temp_id: "x" },
              { op: "todo.add", params: { title: "B" }, temp_id: "x" },
            ],
            dry_run: true,
          },
        }),
      ) as { outcome: string; detail?: string }[];
      // The duplicate line is invalid; the first is skipped — nothing runs.
      expect(results.map((r) => r.outcome)).toEqual(["skipped", "invalid"]);
      expect(results[1]?.detail).toMatch(/duplicate tempId "x"/);
    });
  });

  describe("reorder — planner form + sidebar areas", () => {
    it("plans a Today reorder without mutating (dry-run); the plan is the content block (no discriminator)", async () => {
      const a = seedTodo(fixture.db, { title: "T-a", startDate: "2026-07-05", todayIndex: 0 });
      const b = seedTodo(fixture.db, { title: "T-b", startDate: "2026-07-05", todayIndex: 1 });
      // allow-experimental now defaults on, so today prefers the native re-rank;
      // supply the applescript reorder vector so the plan resolves regardless of
      // whether this host's sdef declares the private command (native) or falls
      // back to the url-scheme bounce.
      await connect([
        fakeVector(null).vector,
        fakeVector(null, { id: "applescript", ops: ["reorder"] }).vector,
      ]);
      // A loose Today set is now DUAL-AXIS (the loose Anytime index is flag-safe via
      // SIT6 LOOSEPARK), so name the view axis explicitly — `in: today`.
      const result = await client.callTool({
        name: "reorder",
        arguments: { refs: [b, a], dry_run: true, in: "today" },
      });
      expect(result.isError ?? false).toBe(false);
      // Phase-2 framing: a dry-run content block IS the plan — no `kind`/`result`.
      const plan = textOf(result) as { placement: string; placementClass: string };
      expect("kind" in plan).toBe(false);
      expect(plan.placement).toContain("scope=today");
    });

    it("passes the library dual-axis refusal through, and resolves it when `in` names the axis", async () => {
      // Two same-project Today members are coherent on BOTH the Today axis and the
      // project's index axis — a bare reorder is refused (library planner), and the
      // refusal reaches the MCP consumer as a blocked tool error naming both axes.
      const proj = seedProject(fixture.db, { title: "Work" });
      const a = seedTodo(fixture.db, {
        title: "a",
        project: proj,
        startDate: "2026-07-05",
        todayIndex: 1,
      });
      const b = seedTodo(fixture.db, {
        title: "b",
        project: proj,
        startDate: "2026-07-05",
        todayIndex: 2,
      });
      await connect([
        fakeVector(null).vector,
        fakeVector(null, { id: "applescript", ops: ["reorder"] }).vector,
      ]);
      const refused = await client.callTool({
        name: "reorder",
        arguments: { refs: [a, b], dry_run: true },
      });
      expect(refused.isError).toBe(true);
      const err = textOf(refused) as { code: string; message: string };
      expect(err.code).toBe("blocked");
      expect(err.message).toContain("ambiguous");

      // `in: today` compiles the cross-container Today axis; `in: "Work"` the
      // project's own index axis — DIFFERENT plans on the SAME rows.
      const view = textOf(
        await client.callTool({
          name: "reorder",
          arguments: { refs: [a, b], in: "today", dry_run: true },
        }),
      ) as { placement: string };
      expect(view.placement).toContain("scope=today");
      const index = textOf(
        await client.callTool({
          name: "reorder",
          arguments: { refs: [a, b], in: "Work", dry_run: true },
        }),
      ) as { placement: string };
      expect(index.placement).toContain("scope=project");
    });

    it("the unified reorder tool repositions a sidebar area, gates the drive, and needs a position", async () => {
      const target = seedArea(fixture.db, "Move Me", 0);
      seedArea(fixture.db, "Anchor", 1);
      await connect([fakeVector(null, { id: "ui", ops: ["area.reorder"] }).vector]);
      // Without the drive ack the ui-vector leg blocks (H-UI-DRIVE, a pre-vector hazard).
      const blocked = await client.callTool({
        name: "reorder",
        arguments: { refs: [target], end: true },
      });
      expect((textOf(blocked) as { code: string }).code).toBe("blocked:H-UI-DRIVE");

      // With the ack it plans through the sidebar-drag driver (move-dry-run plan).
      const outcome = textOf(
        await client.callTool({
          name: "reorder",
          arguments: { refs: [target], end: true, dangerously_drive_gui: true, dry_run: true },
        }),
      ) as { placement: string; note: string };
      expect(outcome.placement).toContain("area re-rank");
      expect(outcome.note).toContain("sidebar-drag");

      // Two positions is a usage error (start/end/before/after are exclusive).
      const twoDest = await client.callTool({
        name: "reorder",
        arguments: { refs: [target], before: "a", end: true, dangerously_drive_gui: true },
      });
      expect(twoDest.isError).toBe(true);
      expect((textOf(twoDest) as { code: string }).code).toBe("usage");

      // No position at all is a usage error (an area reorder needs a position).
      const noDest = await client.callTool({
        name: "reorder",
        arguments: { refs: [target], dangerously_drive_gui: true },
      });
      expect(noDest.isError).toBe(true);
      expect((textOf(noDest) as { code: string }).code).toBe("usage");
    });
  });

  describe("heading tool (action-parameterized)", () => {
    it("action add_heading plans through the proxy (dry-run), rejects an unknown project, and needs title", async () => {
      const project = seedProject(fixture.db, { title: "H-Proj" });
      await connect([fakeVector(null, { id: "shortcuts", ops: ["project.add-heading"] }).vector]);
      const outcome = textOf(
        await client.callTool({
          name: "heading",
          arguments: { action: "add_heading", project, title: "Phase 1", dry_run: true },
        }),
      ) as { kind: string; op: string };
      expect(outcome.op).toBe("project.add-heading");

      const unknown = await client.callTool({
        name: "heading",
        arguments: { action: "add_heading", project: "ghost-project", title: "x", dry_run: true },
      });
      expect(unknown.isError).toBe(true);

      const missing = await client.callTool({
        name: "heading",
        arguments: { action: "add_heading", project, dry_run: true },
      });
      expect(missing.isError).toBe(true);
      expect((textOf(missing) as { code: string }).code).toBe("usage");
    });

    it("action rename_heading resolves the selector and plans an in-place rename (dry-run)", async () => {
      const project = seedProject(fixture.db, { title: "R-Proj" });
      const heading = seedHeading(fixture.db, { title: "old", project });
      await connect([
        fakeVector(null, { id: "applescript", ops: ["project.rename-heading"] }).vector,
      ]);
      const outcome = textOf(
        await client.callTool({
          name: "heading",
          arguments: { action: "rename_heading", project, heading, title: "new", dry_run: true },
        }),
      ) as { kind: string; op: string };
      expect(outcome.op).toBe("project.rename-heading");
    });

    it("action archive_heading plans a childless archive; open children without a policy block", async () => {
      const project = seedProject(fixture.db, { title: "A-Proj" });
      const bare = seedHeading(fixture.db, { title: "Bare", project, index: 1 });
      await connect([
        fakeVector(null, { id: "applescript", ops: ["project.archive-heading"] }).vector,
      ]);
      const outcome = textOf(
        await client.callTool({
          name: "heading",
          arguments: { action: "archive_heading", project, heading: bare, dry_run: true },
        }),
      ) as { heading: { kind: string; op: string } };
      expect(outcome.heading.kind).toBe("dry-run");
      expect(outcome.heading.op).toBe("project.archive-heading");

      const withChild = seedHeading(fixture.db, { title: "Full", project, index: 2 });
      seedTodo(fixture.db, { title: "child", heading: withChild, project: null });
      const blocked = await client.callTool({
        name: "heading",
        arguments: { action: "archive_heading", project, heading: withChild, dry_run: true },
      });
      expect(blocked.isError).toBe(true);
      expect((textOf(blocked) as { code: string }).code).toBe("blocked:H-HEADING-CHILDREN");
    });

    it("action unarchive_heading plans an in-place restore (dry-run)", async () => {
      const project = seedProject(fixture.db, { title: "U-Proj" });
      const heading = seedHeading(fixture.db, { title: "Archived", project });
      await connect([
        fakeVector(null, { id: "applescript", ops: ["project.unarchive-heading"] }).vector,
      ]);
      const outcome = textOf(
        await client.callTool({
          name: "heading",
          arguments: { action: "unarchive_heading", project, heading, dry_run: true },
        }),
      ) as { heading: { kind: string; op: string } };
      expect(outcome.heading.kind).toBe("dry-run");
      expect(outcome.heading.op).toBe("project.unarchive-heading");
    });

    it("convert_to_project tool promotes a to-do and gates the drive", async () => {
      const uuid = seedTodo(fixture.db, { title: "promote me" });
      await connect([fakeVector(null, { id: "ui", ops: ["todo.convert-to-project"] }).vector]);
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
      expect(outcome.op).toBe("todo.convert-to-project");
    });
  });

  // The GUI-driven repeat ops are two-key gated: without the drive acknowledgement
  // they block (H-UI-DRIVE, a pre-vector hazard, so the default vector suffices);
  // with it + a fake ui vector, dry_run compiles a plan without ever executing. The
  // merged `repeat` tool routes on (scope, action) — every old singleton maps to one.
  describe("repeat tool (scope + action parameterized)", () => {
    const uiVector = (op: string) => fakeVector(null, { id: "ui", ops: [op] }).vector;

    it("scope todo action start blocks without the drive ack, and plans with it (was make_repeating)", async () => {
      const uuid = seedTodo(fixture.db, { title: "recur me" });
      await connect([uiVector("todo.make-repeating")]);
      const blocked = await client.callTool({
        name: "repeat",
        arguments: { scope: "todo", action: "start", uuid, frequency: "daily", interval: 1 },
      });
      expect(blocked.isError).toBe(true);
      const err = textOf(blocked) as { code: string; remediation: string };
      expect(err.code).toBe("blocked:H-UI-DRIVE");
      expect(err.remediation.length).toBeGreaterThan(0);

      const outcome = textOf(
        await client.callTool({
          name: "repeat",
          arguments: {
            scope: "todo",
            action: "start",
            uuid,
            frequency: "daily",
            interval: 1,
            dangerously_drive_gui: true,
            dry_run: true,
          },
        }),
      ) as { kind: string; op: string };
      expect(outcome.op).toBe("todo.make-repeating");
    });

    it("scope todo action reschedule blocks without the ack, and plans with it (was reschedule_repeat)", async () => {
      const uuid = seedTodo(fixture.db, { title: "rule", recurrenceRule: true });
      await connect([uiVector("todo.reschedule-repeat")]);
      const blocked = await client.callTool({
        name: "repeat",
        arguments: { scope: "todo", action: "reschedule", uuid, frequency: "weekly", interval: 2 },
      });
      expect((textOf(blocked) as { code: string }).code).toBe("blocked:H-UI-DRIVE");

      const outcome = textOf(
        await client.callTool({
          name: "repeat",
          arguments: {
            scope: "todo",
            action: "reschedule",
            uuid,
            frequency: "weekly",
            interval: 2,
            dangerously_drive_gui: true,
            dry_run: true,
          },
        }),
      ) as { kind: string; op: string };
      expect(outcome.op).toBe("todo.reschedule-repeat");
    });

    it("scope todo action pause routes and gates the drive; start/reschedule need frequency+interval (was set_repeat_state)", async () => {
      const uuid = seedTodo(fixture.db, { title: "paused?", recurrenceRule: true });
      await connect([uiVector("todo.pause-repeat")]);
      const blocked = await client.callTool({
        name: "repeat",
        arguments: { scope: "todo", action: "pause", uuid },
      });
      expect((textOf(blocked) as { code: string }).code).toBe("blocked:H-UI-DRIVE");

      const outcome = textOf(
        await client.callTool({
          name: "repeat",
          arguments: {
            scope: "todo",
            action: "pause",
            uuid,
            dangerously_drive_gui: true,
            dry_run: true,
          },
        }),
      ) as { kind: string; op: string };
      expect(outcome.op).toBe("todo.pause-repeat");

      // a rule action with no frequency/interval is a usage error naming what's missing
      const missingRule = await client.callTool({
        name: "repeat",
        arguments: { scope: "todo", action: "start", uuid, dangerously_drive_gui: true },
      });
      expect(missingRule.isError).toBe(true);
      const err = textOf(missingRule) as { code: string; message: string };
      expect(err.code).toBe("usage");
      expect(err.message).toContain("frequency");
    });

    it("scope project action reschedule blocks without the ack, and plans with it (was reschedule_project_repeat)", async () => {
      const uuid = seedProject(fixture.db, { title: "Recurring Proj", recurrenceRule: true });
      await connect([uiVector("project.reschedule-repeat")]);
      const blocked = await client.callTool({
        name: "repeat",
        arguments: {
          scope: "project",
          action: "reschedule",
          uuid,
          frequency: "monthly",
          interval: 1,
        },
      });
      expect((textOf(blocked) as { code: string }).code).toBe("blocked:H-UI-DRIVE");

      const outcome = textOf(
        await client.callTool({
          name: "repeat",
          arguments: {
            scope: "project",
            action: "reschedule",
            uuid,
            frequency: "monthly",
            interval: 1,
            dangerously_drive_gui: true,
            dry_run: true,
          },
        }),
      ) as { kind: string; op: string };
      expect(outcome.op).toBe("project.reschedule-repeat");
    });

    it("scope project action resume routes and gates the drive (was set_project_repeat_state)", async () => {
      const uuid = seedProject(fixture.db, { title: "Proj paused?", recurrenceRule: true });
      await connect([uiVector("project.resume-repeat")]);
      const blocked = await client.callTool({
        name: "repeat",
        arguments: { scope: "project", action: "resume", uuid },
      });
      expect((textOf(blocked) as { code: string }).code).toBe("blocked:H-UI-DRIVE");

      const outcome = textOf(
        await client.callTool({
          name: "repeat",
          arguments: {
            scope: "project",
            action: "resume",
            uuid,
            dangerously_drive_gui: true,
            dry_run: true,
          },
        }),
      ) as { kind: string; op: string };
      expect(outcome.op).toBe("project.resume-repeat");
    });

    it("scope project action start blocks without the ack, and plans with it (was make_project_repeating)", async () => {
      const area = seedArea(fixture.db, "Repeat Area");
      const uuid = seedProject(fixture.db, { title: "Promote Proj", area });
      await connect([fakeVector(null).vector]);
      const blocked = await client.callTool({
        name: "repeat",
        arguments: { scope: "project", action: "start", uuid, frequency: "weekly", interval: 1 },
      });
      expect((textOf(blocked) as { code: string }).code).toBe("blocked:H-UI-DRIVE");

      const outcome = textOf(
        await client.callTool({
          name: "repeat",
          arguments: {
            scope: "project",
            action: "start",
            uuid,
            frequency: "weekly",
            interval: 1,
            dangerously_drive_gui: true,
            dry_run: true,
          },
        }),
      ) as { kind: string; op: string };
      expect(outcome.op).toBe("project.make-repeating");
    });

    it("scope project action add blocks before creating, plans with the ack, and requires scope project (was create_repeating_project)", async () => {
      await connect([fakeVector(null).vector]);
      const blocked = await client.callTool({
        name: "repeat",
        arguments: {
          scope: "project",
          action: "add",
          title: "Weekly review",
          frequency: "weekly",
          interval: 1,
        },
      });
      expect((textOf(blocked) as { code: string }).code).toBe("blocked:H-UI-DRIVE");

      const outcome = textOf(
        await client.callTool({
          name: "repeat",
          arguments: {
            scope: "project",
            action: "add",
            title: "Weekly review",
            frequency: "weekly",
            interval: 1,
            dangerously_drive_gui: true,
            dry_run: true,
          },
        }),
      ) as { kind: string; op: string };
      expect(outcome.op).toBe("project.add-repeating");

      const wrongScope = await client.callTool({
        name: "repeat",
        arguments: {
          scope: "todo",
          action: "add",
          title: "x",
          frequency: "weekly",
          interval: 1,
          dangerously_drive_gui: true,
        },
      });
      expect(wrongScope.isError).toBe(true);
      expect((textOf(wrongScope) as { code: string }).code).toBe("usage");
    });
  });

  describe("area & tag CRUD", () => {
    it("add_area plans a create (dry-run) and blocks on an unknown tag", async () => {
      await connect([fakeVector(null, { id: "applescript", ops: ["area.add"] }).vector]);
      const outcome = textOf(
        await client.callTool({ name: "add_area", arguments: { title: "Garage", dry_run: true } }),
      ) as { kind: string; op: string };
      expect(outcome.op).toBe("area.add");

      const blocked = await client.callTool({
        name: "add_area",
        arguments: { title: "Garage", tags: ["ghost"], dry_run: true },
      });
      expect(blocked.isError).toBe(true);
      expect((textOf(blocked) as { code: string }).code).toBe("blocked:H-UNKNOWN-TAG");
    });

    it("update kind area plans a rename (dry-run) and requires title and/or tags", async () => {
      const area = seedArea(fixture.db, "Old Area");
      await connect([fakeVector(null, { id: "applescript", ops: ["area.update"] }).vector]);
      const outcome = textOf(
        await client.callTool({
          name: "update",
          arguments: { kind: "area", uuid: area, title: "New Area", dry_run: true },
        }),
      ) as { kind: string; op: string };
      expect(outcome.op).toBe("area.update");

      const empty = await client.callTool({
        name: "update",
        arguments: { kind: "area", uuid: area, dry_run: true },
      });
      expect(empty.isError).toBe(true);
      expect((textOf(empty) as { code: string }).code).toBe("usage");
    });

    it("delete kind area requires the permanent-delete ack, then plans (dry-run)", async () => {
      const area = seedArea(fixture.db, "Doomed");
      await connect([fakeVector(null, { id: "applescript", ops: ["area.delete"] }).vector]);
      const blocked = await client.callTool({
        name: "delete",
        arguments: { kind: "area", uuid: area },
      });
      expect(blocked.isError).toBe(true);
      const err = textOf(blocked) as { code: string; remediation: string };
      expect(err.code).toBe("blocked:H-PERMANENT-DELETE");
      expect(err.remediation).toContain("dangerouslyPermanent");

      const outcome = textOf(
        await client.callTool({
          name: "delete",
          arguments: { kind: "area", uuid: area, dangerously_permanent: true, dry_run: true },
        }),
      ) as { kind: string; op: string };
      expect(outcome.op).toBe("area.delete");
    });

    it("delete kind area refuses a non-empty area until allow_non_empty_area (then plans, dry-run)", async () => {
      const area = seedArea(fixture.db, "Busy");
      seedProject(fixture.db, { title: "P", area });
      seedTodo(fixture.db, { title: "t", area });
      await connect([fakeVector(null, { id: "applescript", ops: ["area.delete"] }).vector]);

      // Even under --dry-run with the permanent ack, a non-empty area refuses
      // fail-closed — the guard surfaces before any plan, like every other guard.
      const blocked = await client.callTool({
        name: "delete",
        arguments: { kind: "area", uuid: area, dangerously_permanent: true, dry_run: true },
      });
      expect(blocked.isError).toBe(true);
      const err = textOf(blocked) as { code: string; message: string; remediation: string };
      expect(err.code).toBe("blocked:H-AREA-NOT-EMPTY");
      expect(err.message).toContain("1 project and 1 to-do");
      expect(err.remediation).toContain("--allow-non-empty");

      // allow_non_empty_area threads through the param; with both acks it plans.
      const outcome = textOf(
        await client.callTool({
          name: "delete",
          arguments: {
            kind: "area",
            uuid: area,
            allow_non_empty_area: true,
            dangerously_permanent: true,
            dry_run: true,
          },
        }),
      ) as { op: string };
      expect(outcome.op).toBe("area.delete");
    });

    it("add_tag plans a create (dry-run)", async () => {
      await connect([fakeVector(null, { id: "applescript", ops: ["tag.add"] }).vector]);
      const outcome = textOf(
        await client.callTool({ name: "add_tag", arguments: { title: "focus", dry_run: true } }),
      ) as { kind: string; op: string };
      expect(outcome.op).toBe("tag.add");
    });

    it("update kind tag plans a rename (dry-run) and refuses exclusive parent/unnest", async () => {
      const tag = seedTag(fixture.db, "wip");
      await connect([fakeVector(null, { id: "applescript", ops: ["tag.update"] }).vector]);
      const outcome = textOf(
        await client.callTool({
          name: "update",
          arguments: { kind: "tag", uuid: tag, title: "in-progress", dry_run: true },
        }),
      ) as { kind: string; op: string };
      expect(outcome.op).toBe("tag.update");

      const conflict = await client.callTool({
        name: "update",
        arguments: { kind: "tag", uuid: tag, parent: "wip", unnest: true },
      });
      expect(conflict.isError).toBe(true);
      expect((textOf(conflict) as { code: string }).code).toBe("usage");
    });

    it("delete kind tag guards the permanent delete and the child subtree, then plans", async () => {
      const parent = seedTag(fixture.db, "energy");
      seedTag(fixture.db, "low", parent);
      const solo = seedTag(fixture.db, "solo");
      await connect([fakeVector(null, { id: "applescript", ops: ["tag.delete"] }).vector]);

      const noPerm = await client.callTool({
        name: "delete",
        arguments: { kind: "tag", uuid: solo },
      });
      expect((textOf(noPerm) as { code: string }).code).toBe("blocked:H-PERMANENT-DELETE");

      const subtree = await client.callTool({
        name: "delete",
        arguments: { kind: "tag", uuid: parent, dangerously_permanent: true },
      });
      expect(subtree.isError).toBe(true);
      expect((textOf(subtree) as { code: string }).code).toBe("blocked:H-TAG-SUBTREE-DELETE");

      const outcome = textOf(
        await client.callTool({
          name: "delete",
          arguments: { kind: "tag", uuid: solo, dangerously_permanent: true, dry_run: true },
        }),
      ) as { kind: string; op: string };
      expect(outcome.op).toBe("tag.delete");
    });
  });

  describe("remaining item / project / discovery tools", () => {
    it("add_project plans a create (dry-run)", async () => {
      await connect([fakeVector(null, { ops: ["project.add"] }).vector]);
      const outcome = textOf(
        await client.callTool({
          name: "add_project",
          arguments: { title: "Launch", dry_run: true },
        }),
      ) as { kind: string; op: string };
      expect(outcome.op).toBe("project.add");
    });

    it("move_project plans a move (dry-run) and refuses conflicting/bare invocations", async () => {
      const area = seedArea(fixture.db, "Dest Area");
      const project = seedProject(fixture.db, { title: "Wanderer" });
      await connect([fakeVector(null, { ops: ["project.move"] }).vector]);
      const outcome = textOf(
        await client.callTool({
          name: "move_project",
          arguments: { uuids: [project], to_area: area, dry_run: true },
        }),
      ) as { placementClass: string; note: string };
      // Move dry-run framing (phase 2): the content block IS the move plan — the
      // placement-honesty fields pass through, with no `kind`/`result` discriminator.
      expect("kind" in outcome).toBe(false);
      expect(outcome.placementClass).toBeDefined();
      expect(outcome.note.length).toBeGreaterThan(0);

      for (const args of [
        { uuids: [project] }, // bare
        { uuids: [project], to_area: area, no_area: true }, // two destinations
      ]) {
        const bad = await client.callTool({ name: "move_project", arguments: args });
        expect(bad.isError, JSON.stringify(args)).toBe(true);
        expect((textOf(bad) as { code: string }).code).toBe("usage");
      }
    });

    it("duplicate_item dispatches on the item's type (dry-run)", async () => {
      const todo = seedTodo(fixture.db, { title: "copy me" });
      const project = seedProject(fixture.db, { title: "copy proj" });
      await connect([fakeVector(null, { ops: ["todo.duplicate", "project.duplicate"] }).vector]);
      for (const [uuid, op] of [
        [todo, "todo.duplicate"],
        [project, "project.duplicate"],
      ] as const) {
        const outcome = textOf(
          await client.callTool({ name: "duplicate_item", arguments: { uuid, dry_run: true } }),
        ) as { kind: string; op: string };
        expect(outcome.op).toBe(op);
      }
    });

    it("clone_item dispatches on the item's type (dry-run)", async () => {
      const todo = seedTodo(fixture.db, { title: "clone me" });
      const project = seedProject(fixture.db, { title: "clone proj" });
      await connect([fakeVector(null).vector]);
      for (const [uuid, op] of [
        [todo, "todo.clone"],
        [project, "project.clone"],
      ] as const) {
        const outcome = textOf(
          await client.callTool({ name: "clone_item", arguments: { uuid, dry_run: true } }),
        ) as { kind: string; op: string };
        expect(outcome.op).toBe(op);
      }
    });

    it("restore_item dispatches on the trashed item's type (dry-run)", async () => {
      const todo = seedTodo(fixture.db, { title: "trashed to-do", trashed: true });
      const project = seedProject(fixture.db, { title: "trashed proj", trashed: true });
      await connect([
        fakeVector(null, { id: "applescript", ops: ["todo.restore", "project.restore"] }).vector,
      ]);
      for (const [uuid, op] of [
        [todo, "todo.restore"],
        [project, "project.restore"],
      ] as const) {
        const outcome = textOf(
          await client.callTool({ name: "restore_item", arguments: { uuid, dry_run: true } }),
        ) as { kind: string; op: string };
        expect(outcome.op).toBe(op);
      }
    });

    it("changes_since lists modified items and rejects an unparseable date", async () => {
      seedTodo(fixture.db, { title: "recently touched" });
      await connect([fakeVector(null).vector]);
      const hits = textOf(
        await client.callTool({
          name: "changes_since",
          arguments: { since: "2020-01-01T00:00:00" },
        }),
      ) as { title: string }[];
      expect(hits.map((i) => i.title)).toContain("recently touched");

      const bad = await client.callTool({
        name: "changes_since",
        arguments: { since: "not-a-date" },
      });
      expect(bad.isError).toBe(true);
      expect((textOf(bad) as { code: string }).code).toBe("usage");
    });

    it("changes_since limit + all normalizes to all winning (no usage error)", async () => {
      for (let i = 0; i < 3; i++) seedTodo(fixture.db, { title: `touched ${i}`, index: i });
      await connect([fakeVector(null).vector]);
      const capped = textOf(
        await client.callTool({
          name: "changes_since",
          arguments: { since: "2020-01-01T00:00:00", limit: 1 },
        }),
      ) as { title: string }[];
      expect(capped).toHaveLength(1);
      // all wins and limit is ignored — the call succeeds returning every change.
      const both = await client.callTool({
        name: "changes_since",
        arguments: { since: "2020-01-01T00:00:00", limit: 1, all: true },
      });
      expect(both.isError ?? false).toBe(false);
      expect((textOf(both) as { title: string }[]).length).toBeGreaterThanOrEqual(3);
    });

    // --- resolution-timestamp parity (plan PR B): created_at/completed_at folded
    //     onto add_todo/add_project, update, and set_status. -----------------

    it("add_todo completed_at plans a logbook import (dry-run)", async () => {
      await connect([fakeVector(null, { ops: ["todo.add"] }).vector]);
      const outcome = textOf(
        await client.callTool({
          name: "add_todo",
          arguments: { title: "did it", completed_at: "2026-01-15", dry_run: true },
        }),
      ) as { op: string };
      expect(outcome.op).toBe("todo.add");
    });

    it("add_project completed_at refuses seeding an open child (§5b)", async () => {
      await connect([fakeVector(null, { ops: ["project.add"] }).vector]);
      const bad = await client.callTool({
        name: "add_project",
        arguments: { title: "logged proj", completed_at: "2026-01-15", todos: ["still open"] },
      });
      expect(bad.isError).toBe(true);
    });

    it("set_status completed_at on a canceled to-do plans the flip + backdate (dry-run)", async () => {
      const uuid = seedTodo(fixture.db, { title: "was canceled", status: "canceled" });
      await connect([
        fakeVector(null, { ops: ["todo.complete"] }).vector,
        fakeVector(null, { id: "applescript", ops: ["todo.set-dates"] }).vector,
      ]);
      const plan = textOf(
        await client.callTool({
          name: "set_status",
          arguments: {
            scope: "todo",
            uuid,
            status: "completed",
            completed_at: "2025-01-15",
            dry_run: true,
          },
        }),
      ) as { op: string; invocation: string };
      expect(plan.op).toBe("todo.complete");
      expect(plan.invocation).toContain("flip → completed");
      expect(plan.invocation).toContain("AS set completion=2025-01-15");
    });

    it("update completed_at on a canceled to-do plans the 3-leg flip-dance (dry-run)", async () => {
      const uuid = seedTodo(fixture.db, { title: "was canceled", status: "canceled" });
      await connect([
        fakeVector(null, { ops: ["todo.complete", "todo.cancel"] }).vector,
        fakeVector(null, { id: "applescript", ops: ["todo.set-dates"] }).vector,
      ]);
      const plan = textOf(
        await client.callTool({
          name: "update",
          arguments: { kind: "todo", uuid, completed_at: "2025-01-15", dry_run: true },
        }),
      ) as { op: string; invocation: string };
      expect(plan.op).toBe("todo.update");
      expect(plan.invocation).toContain("flip → completed");
      expect(plan.invocation).toContain("AS set completion=2025-01-15");
      expect(plan.invocation).toContain("flip → canceled");
    });

    it("set_status canceled with completed_at on a completed project plans the backdate + flip (dry-run)", async () => {
      const proj = seedProject(fixture.db, { title: "wrap up", status: "completed" });
      await connect([
        fakeVector(null, { ops: ["project.cancel"] }).vector,
        fakeVector(null, { id: "applescript", ops: ["project.set-dates"] }).vector,
      ]);
      const plan = textOf(
        await client.callTool({
          name: "set_status",
          arguments: {
            scope: "project",
            uuid: proj,
            status: "canceled",
            children: "require-resolved",
            completed_at: "2025-01-15",
            dry_run: true,
          },
        }),
      ) as { op: string; invocation: string };
      expect(plan.op).toBe("project.cancel");
      expect(plan.invocation).toContain("AS set completion=2025-01-15");
      expect(plan.invocation).toContain("flip → canceled");
    });

    it("update completed_at on an OPEN to-do is refused — the boundary belongs to set_status", async () => {
      const uuid = seedTodo(fixture.db, { title: "still open", status: "open" });
      await connect([fakeVector(null, { ops: ["todo.update"] }).vector]);
      const bad = await client.callTool({
        name: "update",
        arguments: { kind: "todo", uuid, completed_at: "2025-01-15" },
      });
      expect(bad.isError).toBe(true);
      expect((textOf(bad) as { code: string }).code).toBe("blocked:H-BACKDATE-OPEN");
    });

    it("set_status rejects completed_at when reopening (status open)", async () => {
      const uuid = seedTodo(fixture.db, { title: "done", status: "completed" });
      await connect([fakeVector(null, { ops: ["todo.reopen"] }).vector]);
      const bad = await client.callTool({
        name: "set_status",
        arguments: { scope: "todo", uuid, status: "open", completed_at: "2025-01-15" },
      });
      expect(bad.isError).toBe(true);
      expect((textOf(bad) as { code: string }).code).toBe("usage");
    });

    it("clear_reminder plans a clear for a dated reminder, and blocks when there is none", async () => {
      const withReminder = seedTodo(fixture.db, {
        title: "ping me",
        startDate: "2026-07-05",
        reminder: "09:00",
      });
      const bare = seedTodo(fixture.db, { title: "no reminder", startDate: "2026-07-05" });
      await connect([
        fakeVector(null, { id: "shortcuts", ops: ["todo.clear-dated-reminder"] }).vector,
      ]);
      const outcome = textOf(
        await client.callTool({
          name: "clear_reminder",
          arguments: { uuid: withReminder, dry_run: true },
        }),
      ) as { kind: string; op: string };
      expect(outcome.op).toBe("todo.clear-dated-reminder");

      const blocked = await client.callTool({
        name: "clear_reminder",
        arguments: { uuid: bare, dry_run: true },
      });
      expect(blocked.isError).toBe(true);
      expect((textOf(blocked) as { code: string }).code).toBe("blocked:H-NO-REMINDER");
    });

    it("doctor reports the fixture environment", async () => {
      await connect([fakeVector(null).vector]);
      const report = textOf(await client.callTool({ name: "doctor", arguments: {} })) as {
        db: { databaseVersion: number };
        fingerprint: { status: string };
      };
      expect(report.db.databaseVersion).toBe(26);
      expect(typeof report.fingerprint.status).toBe("string");
    });
  });
});

describe("MCP single-op idempotency (op_id)", () => {
  const simEnvBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    // The simulator vector really applies the write (so it verifies ok and a
    // record is recorded) — but only behind its env fence + a bench-marked
    // fixture. Replace the shared fixture with one the fence accepts.
    fixture.close();
    fixture = buildFixtureDb({ benchMarker: true });
    for (const key of [
      "THINGS_SIM_WRITES",
      "THINGS_DB",
      "THINGS_API_STATE_DIR",
      "THINGS_API_CONFIG_DIR",
    ]) {
      simEnvBackup[key] = process.env[key];
    }
    process.env["THINGS_SIM_WRITES"] = "1";
    process.env["THINGS_DB"] = fixture.path;
    process.env["THINGS_API_STATE_DIR"] = stateDir;
    process.env["THINGS_API_CONFIG_DIR"] = join(stateDir, "config");
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(simEnvBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("a resubmitted op_id replays the original result with alreadyApplied (via the simulator)", async () => {
    await connect([createSimulatorVector(fixture.path, { now: () => NOW })]);
    const first = textOf(
      await client.callTool({
        name: "add_todo",
        arguments: { title: "MCP-idem", op_id: "mcp-key" },
      }),
    ) as { uuid: string; undoToken?: string; alreadyApplied?: boolean };
    expect(first.alreadyApplied).toBeUndefined();

    const second = textOf(
      await client.callTool({
        name: "add_todo",
        arguments: { title: "MCP-idem", op_id: "mcp-key" },
      }),
    ) as { uuid: string; undoToken?: string; alreadyApplied?: boolean };
    expect(second.alreadyApplied).toBe(true);
    expect(second.uuid).toBe(first.uuid);
    expect(second.undoToken).toBe(first.undoToken);
  });

  it("a malformed op_id is a usage error", async () => {
    await connect([fakeVector(null).vector]);
    const bad = await client.callTool({
      name: "add_todo",
      arguments: { title: "x", op_id: "not a valid key!" },
    });
    expect(bad.isError).toBe(true);
    expect((textOf(bad) as { code: string }).code).toBe("usage");
  });
});
