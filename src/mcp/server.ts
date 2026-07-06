/**
 * MCP surface over ThingsClient — the third thin layer (CLI, library, MCP),
 * all consuming the same client. Tools return the SAME JSON objects the
 * library returns (and the CLI wraps in --json envelopes); mutation failures
 * surface as MCP tool errors carrying the machine-readable code + the
 * remediation text the guards produce. Nothing here contains Things logic.
 *
 * Serve over stdio with `things mcp`.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { openThings, type OpenOptions, type ThingsClient } from "../client.ts";
import { diagnose } from "../diagnose.ts";
import { capabilitiesTable } from "../write/capabilities.ts";
import { OPERATION_KINDS, type OperationKind } from "../write/operations.ts";
import type { MutationResult, WriteOptions } from "../write/pipeline.ts";
import type { ReorderResult } from "../write/reorder.ts";
import type { BatchOp } from "../write/batch.ts";

export interface McpServerOptions {
  dbPath?: string;
  /** Test seam: forwarded to openThings (fake vectors, pinned clock, env). */
  openOptions?: OpenOptions;
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function errorResult(error: { code: string; message: string; remediation?: string }): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(error) }], isError: true };
}

/** Map a mutation outcome to an MCP result (errors carry remediation). */
function mutationResult(result: MutationResult | ReorderResult): ToolResult {
  switch (result.kind) {
    case "ok":
    case "dry-run":
      return jsonResult(result);
    case "blocked":
      return errorResult({
        code: `blocked:${result.hazard ?? result.reason}`,
        message: result.detail,
        remediation: result.remediation,
      });
    case "verify-failed":
      return errorResult({ code: `verify-failed:${result.reason}`, message: result.detail });
    case "unsupported":
      return errorResult({
        code: "unsupported",
        message: `no validated vector supports ${result.op}`,
        remediation: JSON.stringify(result.considered),
      });
    case "bounce-aborted":
      return errorResult({
        code: "bounce-aborted",
        message: result.detail,
        remediation: `placed: ${result.placed.join(",") || "none"}; remaining: ${result.remaining.join(",")}`,
      });
  }
}

const tagFilterShape = {
  tag: z
    .string()
    .optional()
    .describe("Filter by tag (uuid or unique name): direct, inherited, or descendant-tagged"),
  exact_tag: z.boolean().optional().describe("Match the named tag only — exclude descendants"),
};

const dryRunShape = {
  dry_run: z
    .boolean()
    .optional()
    .describe("Plan only: compiled invocation, tier, hazards, expected delta — nothing executes"),
};

const containerRef = (ref: string): { uuid: string; title: string } => ({ uuid: ref, title: ref });

export function createThingsMcpServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "things-api", version: "0.2.0" });

  // One lazily-opened client for the server's lifetime; SQLite read
  // snapshots are per-statement, so fresh reads see external commits.
  let client: ThingsClient | null = null;
  const getClient = (): ThingsClient => {
    client ??= openThings({
      ...(options.dbPath !== undefined && { dbPath: options.dbPath }),
      ...options.openOptions,
    });
    return client;
  };

  /** Run a handler, mapping environment/usage throws to tool errors. */
  const guard = async (fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> => {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof RangeError ? "usage" : "environment";
      return errorResult({ code, message });
    }
  };

  const writeOptions = (args: {
    dry_run?: boolean | undefined;
    verify_timeout_ms?: number | undefined;
    acknowledge_checklist_reset?: boolean | undefined;
    acknowledge_project_reopen?: boolean | undefined;
    dangerously_permanent?: boolean | undefined;
  }): WriteOptions => ({
    actor: "mcp",
    ...(args.dry_run === true && { dryRun: true }),
    ...(args.verify_timeout_ms !== undefined && { verifyTimeoutMs: args.verify_timeout_ms }),
    ...(args.acknowledge_checklist_reset === true && { acknowledgeChecklistReset: true }),
    ...(args.acknowledge_project_reopen === true && { acknowledgeProjectReopen: true }),
    ...(args.dangerously_permanent === true && { dangerouslyPermanent: true }),
  });

  // ------------------------------------------------------------------ reads

  server.registerTool(
    "read_view",
    {
      description:
        "Read a Things list view exactly as the app renders it. today = Today/This Evening " +
        "split with the badge; upcoming includes each repeating item's next occurrence " +
        "(horizon > 1 additionally PROJECTS later occurrences from the decoded rule, max 10).",
      inputSchema: {
        view: z.enum(["today", "inbox", "anytime", "upcoming", "someday", "logbook", "trash"]),
        ...tagFilterShape,
        horizon: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("upcoming only: occurrences per repeating item (default 1 = UI parity)"),
        limit: z.number().int().min(1).optional().describe("logbook/trash only (default 50)"),
      },
    },
    async (args) =>
      guard(() => {
        const c = getClient();
        const filter = {
          ...(args.tag !== undefined && { tag: args.tag }),
          ...(args.exact_tag === true && { exactTag: true }),
        };
        switch (args.view) {
          case "today":
            return jsonResult(c.read.today(filter));
          case "inbox":
            return jsonResult(c.read.inbox(filter));
          case "anytime":
            return jsonResult(c.read.anytime(filter));
          case "upcoming":
            return jsonResult(
              c.read.upcoming({
                ...filter,
                ...(args.horizon !== undefined && { horizon: args.horizon }),
              }),
            );
          case "someday":
            return jsonResult(c.read.someday(filter));
          case "logbook":
            return jsonResult(
              c.read.logbook({ ...filter, ...(args.limit !== undefined && { limit: args.limit }) }),
            );
          case "trash":
            return jsonResult(c.read.trash(args.limit !== undefined ? { limit: args.limit } : {}));
        }
      }),
  );

  server.registerTool(
    "search",
    {
      description:
        "Substring search over titles/notes. Defaults to OPEN + untrashed items; widen with " +
        "logged/trashed/all. Unknown project/area/tag references fail loudly (never " +
        "silently-empty).",
      inputSchema: {
        query: z.string(),
        ...tagFilterShape,
        project: z.string().optional().describe("Restrict to one project's children"),
        area: z.string().optional().describe("Restrict to one area's direct members"),
        type: z.enum(["to-do", "project"]).optional(),
        logged: z.boolean().optional().describe("Also include completed/canceled items"),
        trashed: z.boolean().optional().describe("Also include trashed items"),
        all: z.boolean().optional().describe("Everything: open + logged + trashed"),
        limit: z.number().int().min(1).optional().describe("Default 50"),
      },
    },
    async (args) =>
      guard(() =>
        jsonResult(
          getClient().read.search(args.query, {
            ...(args.tag !== undefined && { tag: args.tag }),
            ...(args.exact_tag === true && { exactTag: true }),
            ...(args.project !== undefined && { project: args.project }),
            ...(args.area !== undefined && { area: args.area }),
            ...(args.type !== undefined && { type: args.type }),
            ...(args.logged === true && { logged: true }),
            ...(args.trashed === true && { trashed: true }),
            ...(args.all === true && { all: true }),
            ...(args.limit !== undefined && { limit: args.limit }),
          }),
        ),
      ),
  );

  server.registerTool(
    "changes_since",
    {
      description:
        "Rows created or modified since a moment — INCLUDING trashed, logged, and " +
        "repeating-template rows (check trashed/status/repeating.isTemplate per item). " +
        "Invisible here: tag/area edits and checklist-item edits (they don't bump the task).",
      inputSchema: {
        since: z.string().describe("ISO date-time, e.g. 2026-07-06T08:00:00"),
        limit: z.number().int().min(1).optional().describe("Default 200"),
      },
    },
    async (args) =>
      guard(() => {
        const since = new Date(args.since);
        if (Number.isNaN(since.getTime())) {
          return errorResult({
            code: "usage",
            message: `since is not a parseable date: ${args.since}`,
          });
        }
        return jsonResult(
          getClient().read.changes({
            since,
            ...(args.limit !== undefined && { limit: args.limit }),
          }),
        );
      }),
  );

  server.registerTool(
    "get_item",
    {
      description:
        "Full detail for one item by uuid: notes, schedule, reminder, tags (direct + " +
        "inherited), checklist with per-item state, repeat rule, container links.",
      inputSchema: { uuid: z.string() },
    },
    async (args) =>
      guard(() => {
        const item = getClient().read.byUuid(args.uuid);
        return item === null
          ? errorResult({ code: "not-found", message: `no record with uuid ${args.uuid}` })
          : jsonResult(item);
      }),
  );

  server.registerTool(
    "get_project",
    {
      description: "A project's full view: metadata plus children grouped under their headings.",
      inputSchema: { uuid: z.string().describe("Project uuid") },
    },
    async (args) => guard(() => jsonResult(getClient().read.projectView(args.uuid))),
  );

  server.registerTool(
    "list_collections",
    {
      description: "List all projects, areas, or tags (tags include hierarchy parents).",
      inputSchema: { kind: z.enum(["projects", "areas", "tags"]) },
    },
    async (args) =>
      guard(() => {
        const c = getClient();
        return jsonResult(
          args.kind === "projects"
            ? c.read.projects()
            : args.kind === "areas"
              ? c.read.areas()
              : c.read.tags(),
        );
      }),
  );

  // ----------------------------------------------------------------- writes

  const whenSchema = z
    .string()
    .optional()
    .describe("today | evening | anytime | someday | YYYY-MM-DD");

  server.registerTool(
    "add_todo",
    {
      description:
        "Create a to-do (verified read-after-write; the created uuid is returned). Tags must " +
        "already exist (unknown tags block loudly — the app would silently drop them). " +
        "reminder (HH:mm 24h) requires when today|evening|YYYY-MM-DD.",
      inputSchema: {
        title: z.string(),
        notes: z.string().optional(),
        when: whenSchema,
        reminder: z.string().optional().describe("HH:mm 24h; requires a schedulable when"),
        deadline: z.string().optional().describe("YYYY-MM-DD"),
        tags: z.array(z.string()).optional().describe("EXISTING tag names"),
        checklist_items: z.array(z.string()).optional(),
        project: z.string().optional().describe("Destination project (uuid or unique name)"),
        area: z.string().optional().describe("Destination area (uuid or unique name)"),
        heading: z.string().optional().describe("Existing heading in the destination project"),
        acknowledge_project_reopen: z
          .boolean()
          .optional()
          .describe("Allow adding into a completed/canceled project (reopens it)"),
        ...dryRunShape,
      },
    },
    async (args) =>
      guard(async () =>
        mutationResult(
          await getClient().write.addTodo(
            {
              title: args.title,
              ...(args.notes !== undefined && { notes: args.notes }),
              ...(args.when !== undefined && { when: args.when as never }),
              ...(args.reminder !== undefined && { reminder: args.reminder }),
              ...(args.deadline !== undefined && { deadline: args.deadline }),
              ...(args.tags !== undefined && { tags: args.tags }),
              ...(args.checklist_items !== undefined && { checklistItems: args.checklist_items }),
              ...(args.project !== undefined && { project: containerRef(args.project) }),
              ...(args.area !== undefined && { area: containerRef(args.area) }),
              ...(args.heading !== undefined && { heading: args.heading }),
            },
            writeOptions(args),
          ),
        ),
      ),
  );

  server.registerTool(
    "update_todo",
    {
      description:
        "Update a to-do's fields (verified). append_notes/prepend_notes join with a newline " +
        "(exclusive with notes). Re-scheduling WITHOUT reminder auto-preserves an existing " +
        "reminder; clear_reminder works on today/evening only (dated reminders are sticky).",
      inputSchema: {
        uuid: z.string(),
        title: z.string().optional(),
        notes: z.string().optional().describe("REPLACE the notes"),
        append_notes: z.string().optional(),
        prepend_notes: z.string().optional(),
        when: whenSchema,
        reminder: z.string().optional().describe("HH:mm 24h"),
        clear_reminder: z.boolean().optional(),
        deadline: z.string().optional().describe("YYYY-MM-DD"),
        clear_deadline: z.boolean().optional(),
        ...dryRunShape,
      },
    },
    async (args) =>
      guard(async () =>
        mutationResult(
          await getClient().write.updateTodo(
            args.uuid,
            {
              ...(args.title !== undefined && { title: args.title }),
              ...(args.notes !== undefined && { notes: args.notes }),
              ...(args.append_notes !== undefined && { appendNotes: args.append_notes }),
              ...(args.prepend_notes !== undefined && { prependNotes: args.prepend_notes }),
              ...(args.when !== undefined && { when: args.when as never }),
              ...(args.reminder !== undefined && { reminder: args.reminder }),
              ...(args.clear_reminder === true && { reminder: null }),
              ...(args.deadline !== undefined && { deadline: args.deadline }),
              ...(args.clear_deadline === true && { deadline: null }),
            },
            writeOptions(args),
          ),
        ),
      ),
  );

  server.registerTool(
    "complete_todo",
    {
      description: "Complete a to-do (verified). Blocked on repeating templates.",
      inputSchema: { uuid: z.string(), ...dryRunShape },
    },
    async (args) =>
      guard(async () =>
        mutationResult(await getClient().write.completeTodo(args.uuid, writeOptions(args))),
      ),
  );

  server.registerTool(
    "add_project",
    {
      description: "Create a project, optionally in an area and with initial child to-dos.",
      inputSchema: {
        title: z.string(),
        notes: z.string().optional(),
        area: z.string().optional().describe("Destination area (uuid or unique name)"),
        when: whenSchema,
        deadline: z.string().optional().describe("YYYY-MM-DD"),
        todos: z.array(z.string()).optional().describe("Initial child to-do titles"),
        ...dryRunShape,
      },
    },
    async (args) =>
      guard(async () =>
        mutationResult(
          await getClient().write.addProject(
            {
              title: args.title,
              ...(args.notes !== undefined && { notes: args.notes }),
              ...(args.area !== undefined && { area: containerRef(args.area) }),
              ...(args.when !== undefined && { when: args.when as never }),
              ...(args.deadline !== undefined && { deadline: args.deadline }),
              ...(args.todos !== undefined && { todos: args.todos }),
            },
            writeOptions(args),
          ),
        ),
      ),
  );

  server.registerTool(
    "run_operation",
    {
      description:
        "Run ANY cataloged mutation through the verified pipeline — the generic entry for " +
        "operations without a dedicated tool (complete/cancel/reopen/move/restore/duplicate, " +
        "set-tags, checklist, project/area/tag lifecycle, trash). Call `capabilities` first " +
        "for the op kinds, their params, and per-vector caveats. Params are validated by the " +
        "pipeline's pre-read and hazard guards (loud, with remediation).",
      inputSchema: {
        op: z.enum(OPERATION_KINDS as unknown as [string, ...string[]]),
        params: z
          .record(z.string(), z.unknown())
          .describe('Operation params, e.g. {"uuid": "..."} — shapes per `capabilities`'),
        acknowledge_checklist_reset: z.boolean().optional(),
        acknowledge_project_reopen: z.boolean().optional(),
        dangerously_permanent: z
          .boolean()
          .optional()
          .describe("Required for area/tag delete and trash.empty (PERMANENT)"),
        ...dryRunShape,
      },
    },
    async (args) =>
      guard(async () =>
        mutationResult(
          await getClient().write.run(
            args.op as OperationKind,
            args.params as never,
            writeOptions(args),
          ),
        ),
      ),
  );

  server.registerTool(
    "batch",
    {
      description:
        "Run MANY mutations sequentially, each through the full pipeline (guards, verified " +
        "read-after-write, audit). No transactions — per-op results are returned in order.",
      inputSchema: {
        ops: z
          .array(
            z.object({
              op: z.enum(OPERATION_KINDS as unknown as [string, ...string[]]),
              params: z.record(z.string(), z.unknown()),
              options: z
                .object({
                  acknowledgeChecklistReset: z.boolean().optional(),
                  acknowledgeProjectReopen: z.boolean().optional(),
                  dangerouslyPermanent: z.boolean().optional(),
                })
                .optional(),
            }),
          )
          .describe("Ops in execution order"),
        fail_fast: z.boolean().optional().describe("Skip remaining ops after the first failure"),
        ...dryRunShape,
      },
    },
    async (args) =>
      guard(async () => {
        const results = await getClient().write.batch(args.ops as BatchOp[], {
          ...(args.dry_run === true && { dryRun: true }),
          ...(args.fail_fast === true && { failFast: true }),
          actor: "mcp",
        });
        return jsonResult(results);
      }),
  );

  server.registerTool(
    "reorder",
    {
      description:
        "Reorder items within Today, This Evening, a project, or an area — uuids land at the " +
        "TOP in the given order; unlisted members keep their relative order. Native strategy " +
        "requires config allow-experimental; Evening always uses verified when= round-trips. " +
        "Area scope takes to-dos OR projects, never mixed.",
      inputSchema: {
        scope: z.enum(["today", "evening", "project", "area"]),
        container: z
          .string()
          .optional()
          .describe("Project/area (uuid or unique name) — required for those scopes"),
        uuids: z.array(z.string()).describe("Desired order, top first (may be a subset)"),
        strategy: z.enum(["native", "bounce"]).optional(),
        ...dryRunShape,
      },
    },
    async (args) =>
      guard(async () =>
        mutationResult(
          await getClient().write.reorder(
            {
              scope: args.scope,
              uuids: args.uuids,
              ...(args.container !== undefined && { container: containerRef(args.container) }),
              ...(args.strategy !== undefined && { strategy: args.strategy }),
            },
            writeOptions(args),
          ),
        ),
      ),
  );

  server.registerTool(
    "undo",
    {
      description:
        "Undo the last N successful mutations by replaying INVERSE ops from the audit trail, " +
        "each through the verified pipeline. Irreversible ops (permanent deletes, project " +
        "complete/delete, uncaptured pre-state) are reported, never guessed. Undoing a " +
        "CREATED area/tag deletes it permanently — requires dangerously_permanent.",
      inputSchema: {
        last: z.number().int().min(1).optional().describe("How many to unwind (default 1)"),
        dangerously_permanent: z.boolean().optional(),
        ...dryRunShape,
      },
    },
    async (args) =>
      guard(async () => {
        const items = await getClient().write.undo({
          ...(args.last !== undefined && { last: args.last }),
          ...(args.dry_run === true && { dryRun: true }),
          ...(args.dangerously_permanent === true && { dangerouslyPermanent: true }),
          actor: "mcp",
        });
        return jsonResult(items);
      }),
  );

  // ---------------------------------------------------------------- discovery

  server.registerTool(
    "capabilities",
    {
      description:
        "The lab-validated operation × vector support matrix: what is possible, at which " +
        "disruption tier, with which caveats and probe-evidence ids. Consult before " +
        "run_operation.",
      inputSchema: {
        op: z
          .enum(OPERATION_KINDS as unknown as [string, ...string[]])
          .optional()
          .describe("Limit to one operation kind"),
      },
    },
    async (args) => guard(() => jsonResult(capabilitiesTable(args.op as OperationKind))),
  );

  server.registerTool(
    "doctor",
    {
      description:
        "Environment health: database location, schema fingerprint vs baseline, app " +
        "presence, whether writes are enabled, experimental-surface canary.",
      inputSchema: {},
    },
    async () =>
      guard(() => {
        const { report, error } = diagnose(options.dbPath);
        return report !== null
          ? jsonResult(report)
          : errorResult(error ?? { code: "unexpected", message: "no report" });
      }),
  );

  return server;
}
