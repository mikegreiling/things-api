/**
 * `things mcp` — serve the MCP surface over stdio. Agents configure this as
 * their MCP server command: { "command": "things", "args": ["mcp"] }.
 * MCP protocol traffic owns stdout; all logging goes to stderr.
 */
import type { Command } from "commander";

import { ExitCode, loadMcpServer, type DisruptionTier } from "../../index.ts";
import { installServerSignalHandlers } from "../interrupt.ts";

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
        dryRun?: boolean;
      }) => {
        // Universal `--dry-run` (../dry-run.ts) means "guarantee nothing
        // changes". `mcp` serves a live surface whose tools make changes on
        // demand, with nothing to plan up front — so there is no honest preview.
        // Refuse loudly rather than launch a server that silently ignores the
        // promise (its controls are --scope and the disruption ceilings instead).
        if (opts.dryRun === true) {
          process.stderr.write(
            "error: things mcp does not support --dry-run — it serves a live surface whose tools " +
              "make changes on request; scope it with --scope to confine what it can touch\n",
          );
          process.exitCode = ExitCode.Usage;
          return;
        }
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
        // The one place a lifetime-long signal handler is legitimate: from here
        // the process is event-loop-resident, so a supervisor's SIGTERM
        // dispatches immediately, and one landing mid-write still gets the
        // honest "outcome uncertain" line on stderr (never stdout — that is the
        // JSON-RPC channel). One-shot commands arm the same guard only for the
        // span of a write; see ../interrupt.ts.
        installServerSignalHandlers();
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
