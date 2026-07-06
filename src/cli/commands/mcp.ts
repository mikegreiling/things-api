/**
 * `things mcp` — serve the MCP surface over stdio. Agents configure this as
 * their MCP server command: { "command": "things", "args": ["mcp"] }.
 * MCP protocol traffic owns stdout; all logging goes to stderr.
 */
import type { Command } from "commander";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createThingsMcpServer } from "../../mcp/server.ts";

export function registerMcp(program: Command): void {
  program
    .command("mcp")
    .description(
      "Serve the Things MCP server on stdio (Model Context Protocol). Tools mirror the " +
        "library/CLI surface: read views, search, changes, verified mutations (add/update/" +
        "complete + generic run_operation), batch, reorder, undo, capabilities, doctor. " +
        'Configure in an MCP client as command `things` with args ["mcp"].',
    )
    .option("--db <path>", "explicit database path")
    .action(async (opts: { db?: string }) => {
      const server = createThingsMcpServer(opts.db !== undefined ? { dbPath: opts.db } : {});
      const transport = new StdioServerTransport();
      await server.connect(transport);
      process.stderr.write("things-api MCP server listening on stdio\n");
      // The transport keeps the process alive; exit cleanly when it closes.
      transport.onclose = () => process.exit(0);
    });
}
