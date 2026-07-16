/**
 * README contract tests — pin the README's falsifiable claims to code so the
 * top-level doc cannot silently rot. Each assertion re-derives its truth from
 * source (PKG_VERSION, OPERATION_KINDS, the live MCP tool registry, the repo
 * tree) rather than from a hard-coded copy. Extraction is tolerant of prose
 * reflow (no hard-wrap assumptions) but strict on the numbers and names.
 */
import { describe, expect, it } from "vitest";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { PKG_VERSION } from "../../src/contracts.ts";
import { createThingsMcpServer } from "../../src/mcp/server.ts";
import { OPERATION_KINDS } from "../../src/write/operations.ts";
import { buildFixtureDb } from "../fixtures/build-db.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const README_PATH = join(REPO_ROOT, "README.md");
const README = readFileSync(README_PATH, "utf8");

/**
 * Snake_case backtick tokens in the README that are MCP tool ARGUMENTS, not
 * registered tools — the only such tokens exempt from the tool-existence
 * check. Keep this list minimal; a new tool name must never be added here.
 */
const NON_TOOL_ARGS = new Set(["dry_run", "dangerously_drive_gui"]);

/** Every distinct backtick-quoted `snake_case` token (has ≥1 underscore). */
function snakeBacktickTokens(md: string): string[] {
  const matches = md.match(/`[a-z]+(?:_[a-z]+)+`/g) ?? [];
  return [...new Set(matches.map((m) => m.replaceAll("`", "")))];
}

/** Registered MCP tool names, read from a live in-process server. */
async function registeredMcpTools(): Promise<string[]> {
  const fixture = buildFixtureDb();
  const client = new Client({ name: "readme-contract-test", version: "0.0.0" });
  try {
    const server = createThingsMcpServer({ dbPath: fixture.path });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();
    return tools.map((t) => t.name);
  } finally {
    fixture.close();
  }
}

describe("README contract", () => {
  it("every `vX.Y.Z` version string equals PKG_VERSION", () => {
    const versions = [...README.matchAll(/\bv(\d+\.\d+\.\d+)\b/g)].map((m) => m[1]);
    expect(versions.length).toBeGreaterThan(0); // README must state a version
    for (const v of versions) expect(v).toBe(PKG_VERSION);
  });

  it("every `<N>-op` catalog claim equals OPERATION_KINDS.length", () => {
    const counts = [...README.matchAll(/\b(\d+)-op\b/g)].map((m) => Number(m[1]));
    expect(counts.length).toBeGreaterThan(0); // README must state the catalog size
    for (const n of counts) expect(n).toBe(OPERATION_KINDS.length);
  });

  it("every backtick-quoted MCP tool name is a registered tool", async () => {
    const registered = new Set(await registeredMcpTools());
    const claimed = snakeBacktickTokens(README).filter((t) => !NON_TOOL_ARGS.has(t));
    expect(claimed.length).toBeGreaterThan(0); // README must enumerate tools
    const missing = claimed.filter((t) => !registered.has(t));
    expect(missing, `README names tools that are not registered: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("every relative markdown link points at an existing file", () => {
    const targets = [...README.matchAll(/\]\(([^)]+)\)/g)]
      .map((m) => m[1] ?? "")
      .filter((t) => !/^[a-z]+:\/\//i.test(t) && !t.startsWith("#"))
      .map((t) => t.split("#")[0] ?? "") // strip anchors
      .filter((t) => t.length > 0);
    expect(targets.length).toBeGreaterThan(0);
    const missing = targets.filter((t) => !existsSync(join(REPO_ROOT, t)));
    expect(missing, `README links to missing paths: ${missing.join(", ")}`).toEqual([]);
  });
});
