/**
 * MCP container-scope leak surface: the server instructions embed the live
 * area/tag/project inventory (buildInstructions). Under a `--scope`, that
 * inventory must list ONLY in-scope containers — an out-of-scope container name
 * embedded here would leak its existence before the agent calls a single tool
 * (docs/design/container-scope.md §5, leak surface 9).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createThingsMcpServer } from "../../src/mcp/server.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTodo } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");

let fixture: FixtureDb;
let client: Client;
let close: (() => Promise<void>) | null = null;

beforeEach(() => {
  fixture = buildFixtureDb();
  const workArea = seedArea(fixture.db, "Work", 0);
  const personalArea = seedArea(fixture.db, "Personal", 1);
  seedProject(fixture.db, { title: "Work Roadmap", area: workArea });
  seedProject(fixture.db, { title: "Personal Errands", area: personalArea });
  seedTodo(fixture.db, { title: "work loose", area: workArea });
  seedTodo(fixture.db, { title: "personal loose", area: personalArea });
});

afterEach(async () => {
  if (close !== null) await close();
  close = null;
  fixture.close();
});

async function instructionsUnder(scope?: string): Promise<string> {
  const server = createThingsMcpServer({
    dbPath: fixture.path,
    ...(scope !== undefined && { scope }),
    openOptions: { now: () => NOW },
  });
  client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  close = async () => {
    await client.close();
    await server.close();
  };
  return client.getInstructions() ?? "";
}

describe("buildInstructions under a container scope", () => {
  it("lists only in-scope containers; out-of-scope names are absent", async () => {
    const instructions = await instructionsUnder("Work");
    expect(instructions).toContain("Work");
    expect(instructions).toContain("Work Roadmap");
    // The scope note is present.
    expect(instructions).toMatch(/Scope: this server is limited to the area "Work"/);
    // No out-of-scope container name leaks.
    expect(instructions).not.toContain("Personal");
    expect(instructions).not.toContain("Personal Errands");
  });

  it("unscoped: the full inventory is present (control)", async () => {
    const instructions = await instructionsUnder();
    expect(instructions).toContain("Personal");
    expect(instructions).toContain("Personal Errands");
    expect(instructions).not.toMatch(/Scope: this server is limited/);
  });
});
