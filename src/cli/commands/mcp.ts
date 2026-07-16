/**
 * `things mcp` — serve the MCP surface over stdio. Agents configure this as
 * their MCP server command: { "command": "things", "args": ["mcp"] }.
 * MCP protocol traffic owns stdout; all logging goes to stderr.
 */
import type { Command } from "commander";

import type { DisruptionTier } from "../../index.ts";

export function registerMcp(program: Command): void {
  program
    .command("mcp")
    .description(
      "Serve the Things MCP server on stdio (Model Context Protocol). Tools cover the full " +
        "surface: read views, search, changes, item detail, to-do/project/area/tag " +
        "mutations, batch, reorder, undo, capabilities, doctor; the server instructions " +
        "carry the user's live area/tag/project inventory. By default the server only makes " +
        "changes that keep the app in the background; --allow-disruptive / " +
        "--allow-very-disruptive raise that ceiling for the whole session (there is no " +
        'per-request override). Configure in an MCP client as command `things` with args ["mcp"].',
    )
    .option("--db <path>", "explicit database path")
    .option("--allow-disruptive", "permit changes that briefly steal window focus")
    .option("--allow-very-disruptive", "permit changes that visibly drive the Things UI")
    .action(
      async (opts: { db?: string; allowDisruptive?: boolean; allowVeryDisruptive?: boolean }) => {
        // LAZY imports: the MCP SDK + zod load only when `things mcp` actually
        // runs. Every other CLI command must work in environments that ship a
        // minimal dependency set (the guest e2e bundle carries only commander).
        const [{ createThingsMcpServer }, { StdioServerTransport }] = await Promise.all([
          import("../../mcp/server.ts"),
          import("@modelcontextprotocol/sdk/server/stdio.js"),
        ]);
        // Same mapping the CLI's per-call write flags use (writeOptionsFrom):
        // --allow-very-disruptive → 3, --allow-disruptive → 2, else the config
        // default. Fixed for the process — the server has no per-request escalation.
        const maxDisruption: DisruptionTier | undefined = opts.allowVeryDisruptive
          ? 3
          : opts.allowDisruptive
            ? 2
            : undefined;
        const server = createThingsMcpServer({
          ...(opts.db !== undefined && { dbPath: opts.db }),
          ...(maxDisruption !== undefined && { maxDisruption }),
        });
        const transport = new StdioServerTransport();
        await server.connect(transport);
        process.stderr.write("things-api MCP server listening on stdio\n");
        // The transport keeps the process alive; exit cleanly when it closes.
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP SDK Transport exposes an onclose property, not an EventTarget
        transport.onclose = () => process.exit(0);
      },
    );
}
