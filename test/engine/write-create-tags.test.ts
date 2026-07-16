/**
 * End-to-end --create-tags orchestration through the client's `run` wrapper:
 * a fake AppleScript vector applies the create + apply legs against a
 * file-backed fixture DB (safe — the no-direct-writes rule protects the real
 * Things DB, not fixtures). Proves the create-then-apply sequencing, mkdir-p
 * nesting, idempotence, and dry-run suppression.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openThings, type ThingsClient } from "../../src/client.ts";
import type { VectorMatrix, WriteVector } from "../../src/write/vectors/types.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");

let fixture: FixtureDb;
let stateDir: string;
let uidSeq = 0;

/**
 * A fake AppleScript vector that MODELS Things: `make new tag` creates a TMTag
 * row (coalescing on same name+parent, TAGW1-c), `set parent tag` nests it,
 * and `set tag names of to do id` replaces the to-do's TMTaskTag rows.
 */
function modelVector(ops: string[]): { vector: WriteVector; calls: string[] } {
  const matrix = Object.fromEntries(
    ops.map((op) => [op, { support: "yes", disruption: 0, validation: "validated" }]),
  ) as VectorMatrix;
  const calls: string[] = [];
  const db = fixture.db;
  const tagUuidByTitle = (title: string, parent: string | null): string | undefined =>
    (
      db
        .prepare(
          `SELECT uuid FROM TMTag WHERE title = ? AND ${parent === null ? "parent IS NULL" : "parent = ?"}`,
        )
        .get(...(parent === null ? [title] : [title, parent])) as { uuid: string } | undefined
    )?.uuid;
  const anyTagUuid = (title: string): string | undefined =>
    (
      db.prepare("SELECT uuid FROM TMTag WHERE title = ?").get(title) as
        | { uuid: string }
        | undefined
    )?.uuid;

  const vector: WriteVector = {
    id: "applescript",
    matrix,
    async execute(invocation) {
      const payload = invocation.payload;
      calls.push(payload);
      const make = payload.match(/make new tag with properties \{name:"([^"]+)"\}/);
      if (make !== null) {
        const title = make[1] as string;
        const parentMatch = payload.match(/set parent tag of tag "[^"]+" to tag "([^"]+)"/);
        const parent = parentMatch !== null ? (anyTagUuid(parentMatch[1] as string) ?? null) : null;
        if (tagUuidByTitle(title, parent) === undefined) {
          const uuid = `made-tag-${uidSeq++}`;
          db.prepare(
            `INSERT INTO TMTag (uuid, title, shortcut, usedDate, parent, "index") VALUES (?, ?, NULL, NULL, ?, 0)`,
          ).run(uuid, title, parent);
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const setTags = payload.match(/set tag names of to do id "([^"]+)" to "([^"]*)"/);
      if (setTags !== null) {
        const todoUuid = setTags[1] as string;
        const titles = (setTags[2] as string)
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
        db.prepare("DELETE FROM TMTaskTag WHERE tasks = ?").run(todoUuid);
        for (const t of titles) {
          const tagUuid = anyTagUuid(t);
          if (tagUuid !== undefined) {
            db.prepare("INSERT INTO TMTaskTag (tasks, tags) VALUES (?, ?)").run(todoUuid, tagUuid);
          }
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { vector, calls };
}

function client(vector: WriteVector): ThingsClient {
  return openThings({
    dbPath: fixture.path,
    now: () => NOW,
    vectors: [vector],
    env: {
      ...process.env,
      THINGS_DB: fixture.path,
      THINGS_API_STATE_DIR: stateDir,
      THINGS_API_CONFIG_DIR: join(stateDir, "config"),
    },
    writeOverrides: { isAppRunning: () => true, ensureRunning: async () => true },
  });
}

function tagTitles(todoUuid: string): string[] {
  return (
    fixture.db
      .prepare(
        "SELECT t.title FROM TMTaskTag tt JOIN TMTag t ON tt.tags = t.uuid WHERE tt.tasks = ? ORDER BY t.title",
      )
      .all(todoUuid) as { title: string }[]
  ).map((r) => r.title);
}

function tagRow(title: string): { uuid: string; parent: string | null } | undefined {
  return fixture.db.prepare("SELECT uuid, parent FROM TMTag WHERE title = ?").get(title) as
    | { uuid: string; parent: string | null }
    | undefined;
}

beforeEach(() => {
  fixture = buildFixtureDb();
  stateDir = mkdtempSync(join(tmpdir(), "things-api-create-tags-"));
});
afterEach(() => {
  fixture.close();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("--create-tags orchestration", () => {
  it("creates a missing tag, then applies it (create-then-apply)", async () => {
    const todo = seedTodo(fixture.db, { title: "t" });
    const { vector } = modelVector(["tag.add", "todo.set-tags"]);
    const c = client(vector);
    const result = await c.write.setTags(todo, ["Fresh"], { createTags: true });
    expect(result.kind).toBe("ok");
    expect(tagRow("Fresh")).toBeDefined();
    expect(tagTitles(todo)).toEqual(["Fresh"]);
    c.close();
  });

  it("mkdir-p's a parent/child path (parent nested before child), then applies the leaf", async () => {
    const todo = seedTodo(fixture.db, { title: "t" });
    const { vector, calls } = modelVector(["tag.add", "todo.set-tags"]);
    const c = client(vector);
    const result = await c.write.setTags(todo, ["Work/Errands"], { createTags: true });
    expect(result.kind).toBe("ok");
    const parent = tagRow("Work");
    const child = tagRow("Errands");
    expect(parent).toBeDefined();
    expect(child?.parent).toBe(parent?.uuid); // nested under the created parent
    expect(tagTitles(todo)).toEqual(["Errands"]); // the leaf title is applied
    // Two create legs (Work, Errands) + one apply leg.
    expect(calls.filter((p) => p.includes("make new tag"))).toHaveLength(2);
    c.close();
  });

  it("is idempotent: no create legs when every tag already exists", async () => {
    const todo = seedTodo(fixture.db, { title: "t" });
    const { vector, calls } = modelVector(["tag.add", "todo.set-tags"]);
    // Pre-create the tag through the same path.
    await client(vector).write.addTag({ title: "Already" });
    const c = client(vector);
    const before = calls.length;
    const result = await c.write.setTags(todo, ["Already"], { createTags: true });
    expect(result.kind).toBe("ok");
    expect(calls.slice(before).filter((p) => p.includes("make new tag"))).toHaveLength(0);
    c.close();
  });

  it("does not create tags on a dry run", async () => {
    const todo = seedTodo(fixture.db, { title: "t" });
    const { vector, calls } = modelVector(["tag.add", "todo.set-tags"]);
    const c = client(vector);
    await c.write.setTags(todo, ["Ghost"], { createTags: true, dryRun: true });
    expect(calls.filter((p) => p.includes("make new tag"))).toHaveLength(0);
    expect(tagRow("Ghost")).toBeUndefined();
    c.close();
  });
});
