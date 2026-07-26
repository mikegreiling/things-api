/**
 * `things mcp` — serve the MCP surface over stdio. Agents configure this as
 * their MCP server command: { "command": "things", "args": ["mcp"] }.
 * MCP protocol traffic owns stdout; all logging goes to stderr.
 */
import type { Command } from "commander";

import { loadMcpServer, type DisruptionTier } from "../../index.ts";

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
    .option(
      "--scope <ref>",
      "limit the whole server to one area or project (uuid or unique name): only items within " +
        "it are readable, every change is confined to it, and references outside it return " +
        "not-found. Set at launch by whoever controls this server; no tool can widen it. " +
        "Outranks the THINGS_API_SCOPE environment variable.",
    )
    .action(
      async (opts: {
        db?: string;
        allowDisruptive?: boolean;
        allowVeryDisruptive?: boolean;
        scope?: string;
      }) => {
        // LAZY imports: the MCP SDK + zod load only when `things mcp` actually
        // runs. Every other CLI command must work in environments that ship a
        // minimal dependency set (the guest e2e bundle carries only commander).
        // The server surface is reached through the library's lazy loader
        // (loadMcpServer), keeping the air-gap boundary intact.
        const [{ createThingsMcpServer }, { StdioServerTransport }] = await Promise.all([
          loadMcpServer(),
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
          ...(opts.scope !== undefined && { scope: opts.scope }),
        });
        const transport = new StdioServerTransport();
        await server.connect(transport);
        // Log the active scope loudly at startup so the jail is never silently on.
        if (opts.scope !== undefined) {
          process.stderr.write(`things-api MCP server scoped to "${opts.scope}"\n`);
        }
        process.stderr.write("things-api MCP server listening on stdio\n");
        // The transport keeps the process alive; exit cleanly when it closes.
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP SDK Transport exposes an onclose property, not an EventTarget
        transport.onclose = () => process.exit(0);
      },
    );
}
