/**
 * `things mcp` — serve the MCP surface over stdio. Agents configure this as
 * their MCP server command: { "command": "things", "args": ["mcp"] }.
 * MCP protocol traffic owns stdout; all logging goes to stderr.
 */
import type { Command } from "commander";

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
      // LAZY imports: the MCP SDK + zod load only when `things mcp` actually
      // runs. Every other CLI command must work in environments that ship a
      // minimal dependency set (the guest e2e bundle carries only commander).
      const [{ createThingsMcpServer }, { StdioServerTransport }] = await Promise.all([
        import("../../mcp/server.ts"),
        import("@modelcontextprotocol/sdk/server/stdio.js"),
      ]);
      const server = createThingsMcpServer(opts.db !== undefined ? { dbPath: opts.db } : {});
      const transport = new StdioServerTransport();
      await server.connect(transport);
      process.stderr.write("things-api MCP server listening on stdio\n");
      // The transport keeps the process alive; exit cleanly when it closes.
      transport.onclose = () => process.exit(0);
    });
}
