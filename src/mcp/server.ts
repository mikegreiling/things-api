/**
 * MCP surface over ThingsClient — the third thin layer (CLI, library, MCP),
 * all consuming the same client. Tools return the SAME JSON objects the
 * library returns (and the CLI wraps in --json envelopes); mutation failures
 * surface as MCP tool errors carrying the machine-readable code + the
 * remediation text the guards produce. Nothing here contains Things logic.
 *
 * Tool descriptions and the server instructions follow the consumer-voice
 * contract in docs/design/surface-copy.md: behavior and side effects only,
 * no pipeline/audit/lab vocabulary (enforced by test/mcp/server.test.ts).
 *
 * Serve over stdio with `things mcp`.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { openThings, type ChecklistEdit, type OpenOptions, type ThingsClient } from "../client.ts";
import { PKG_VERSION } from "../contracts.ts";
import { diagnose } from "../diagnose.ts";
import { DATE_FORMAT, REF_FORMAT, REMINDER_FORMAT, WHEN_VALUES } from "../surface-copy.ts";
import { capabilitiesTable } from "../write/capabilities.ts";
import { OPERATION_KINDS, type OperationKind } from "../write/operations.ts";
import type { MutationResult, WriteOptions } from "../write/pipeline.ts";
import { BOUNCE_MAX_ITEMS, type ReorderResult } from "../write/reorder.ts";
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

function errorResult(error: {
  code: string;
  message: string;
  likelyCause?: string;
  remediation?: string;
}): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(error) }], isError: true };
}

function usage(message: string): ToolResult {
  return errorResult({ code: "usage", message });
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
        ...(result.likelyCause !== undefined && { likelyCause: result.likelyCause }),
        remediation: result.remediation,
      });
    case "verify-failed":
      return errorResult({
        code: `verify-failed:${result.reason}`,
        message: result.detail,
        ...(result.likelyCause !== undefined && { likelyCause: result.likelyCause }),
        ...(result.hint !== undefined && { remediation: result.hint }),
      });
    case "unsupported":
      return errorResult({
        code: "unsupported",
        message: `${result.op} is not supported`,
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

const READ_ONLY = { readOnlyHint: true } as const;
const NON_DESTRUCTIVE = { destructiveHint: false } as const;
const DESTRUCTIVE = { destructiveHint: true } as const;

const tagFilterShape = {
  tag: z
    .string()
    .optional()
    .describe(`Filter by tag (${REF_FORMAT}); includes items carrying any nested child tag`),
  exact_tag: z.boolean().optional().describe("Match only the named tag, not its nested children"),
};

const dryRunShape = {
  dry_run: z.boolean().optional().describe("Preview the planned change without applying anything"),
};

const containerRef = (ref: string): { uuid: string; title: string } => ({ uuid: ref, title: ref });

/** Cap on project titles inlined into the server instructions. */
const INSTRUCTIONS_MAX_PROJECTS = 100;

/**
 * Live-inventory preamble: conventions plus the user's actual areas, tags,
 * and open projects, read once at server start so models can reference real
 * names without a discovery round-trip. Degrades to conventions-only when
 * the database is not readable.
 */
function buildInstructions(getClient: () => ThingsClient): string {
  const lines = [
    "This server reads and modifies the user's Things 3 data: to-dos, projects, areas, and tags.",
    "",
    "Conventions:",
    "- Items are identified by uuid (returned by every read tool). Where a parameter says " +
      `"${REF_FORMAT}", projects, areas, and tags may also be referenced by exact name.`,
    "- References must name existing items; unknown or ambiguous references return an error " +
      "rather than being guessed at. Create missing tags/areas/projects first (add_tag, " +
      "add_area, add_project).",
    `- Scheduling vocabulary: when = ${WHEN_VALUES}; deadlines are ${DATE_FORMAT}; reminders ` +
      `are ${REMINDER_FORMAT}.`,
    "- Every write tool accepts dry_run: true to preview the change without applying it. " +
      "Operations with cascading or permanent effects require the explicit confirmation " +
      "parameter named in their description; refused calls return an error saying what to pass.",
  ];
  try {
    const c = getClient();
    const areas = c.read.areas();
    const tags = c.read.tags();
    const projects = c.read.projects();
    const tagLabel = (t: { title: string; parent: { title: string } | null }): string =>
      t.parent === null ? t.title : `${t.parent.title} > ${t.title}`;
    const shown = projects.slice(0, INSTRUCTIONS_MAX_PROJECTS);
    const overflow = projects.length - shown.length;
    lines.push(
      "",
      "Current inventory (read at server start — refresh with list_collections):",
      `- Areas (${areas.length}): ${areas.map((a) => a.title).join(", ") || "none"}`,
      `- Tags (${tags.length}): ${tags.map(tagLabel).join(", ") || "none"}`,
      `- Open projects (${projects.length}): ${shown.map((p) => p.title).join("; ") || "none"}` +
        (overflow > 0 ? `; …and ${overflow} more (list_collections for all)` : ""),
    );
  } catch {
    lines.push(
      "",
      "The Things database was not readable when this server started, so no area/tag/project " +
        "inventory is included. Run the doctor tool to diagnose, then list_collections for " +
        "the live inventory.",
    );
  }
  return lines.join("\n");
}

export function createThingsMcpServer(options: McpServerOptions = {}): McpServer {
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

  const server = new McpServer(
    { name: "things-api", version: PKG_VERSION },
    { instructions: buildInstructions(getClient) },
  );

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
    acknowledge_tag_subtree?: boolean | undefined;
  }): WriteOptions => ({
    actor: "mcp",
    ...(args.dry_run === true && { dryRun: true }),
    ...(args.verify_timeout_ms !== undefined && { verifyTimeoutMs: args.verify_timeout_ms }),
    ...(args.acknowledge_checklist_reset === true && { acknowledgeChecklistReset: true }),
    ...(args.acknowledge_project_reopen === true && { acknowledgeProjectReopen: true }),
    ...(args.dangerously_permanent === true && { dangerouslyPermanent: true }),
    ...(args.acknowledge_tag_subtree === true && { acknowledgeTagSubtree: true }),
  });

  /** Resolve a uuid to to-do/project for the type-generic item tools. */
  const itemType = (uuid: string): "to-do" | "project" => {
    const item = getClient().read.byUuid(uuid);
    if (item === null) throw new RangeError(`no item with uuid ${uuid}`);
    if (item.type === "heading") {
      throw new RangeError(`${uuid} is a heading — only to-dos and projects can be targeted`);
    }
    return item.type;
  };

  // ------------------------------------------------------------------ reads

  server.registerTool(
    "read_view",
    {
      description:
        "Read a Things list as the app presents it: today (split into Today and This " +
        "Evening), inbox, anytime, upcoming, someday, logbook, or trash. For upcoming, " +
        "horizon > 1 also includes future occurrences of repeating items (up to 10 each). " +
        "anytime/someday return sidebar-ordered sections (area + items; null area = the " +
        "top-level block); children of someday/future-scheduled projects are excluded " +
        "from anytime — the project row represents them.",
      inputSchema: {
        view: z.enum(["today", "inbox", "anytime", "upcoming", "someday", "logbook", "trash"]),
        ...tagFilterShape,
        active_project_items: z
          .boolean()
          .optional()
          .describe("someday only: also list someday to-dos inside active projects"),
        horizon: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("upcoming only: occurrences shown per repeating item (default 1)"),
        limit: z.number().int().min(1).optional().describe("logbook/trash only (default 50)"),
      },
      annotations: READ_ONLY,
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
            return jsonResult(
              c.read.someday({
                ...filter,
                ...(args.active_project_items === true && { activeProjectItems: true }),
              }),
            );
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
        "Find items by title/notes substring. Returns open, untrashed items by default; " +
        "include more with logged/trashed/all. Scope with project/area/tag — scope " +
        "references must name existing items.",
      inputSchema: {
        query: z.string(),
        ...tagFilterShape,
        project: z
          .string()
          .optional()
          .describe(`Restrict to one project's children (${REF_FORMAT})`),
        area: z
          .string()
          .optional()
          .describe(`Restrict to one area's direct members (${REF_FORMAT})`),
        type: z.enum(["to-do", "project"]).optional(),
        logged: z.boolean().optional().describe("Also include completed/canceled items"),
        trashed: z.boolean().optional().describe("Also include trashed items"),
        all: z.boolean().optional().describe("Everything: open + logged + trashed"),
        limit: z.number().int().min(1).optional().describe("Default 50"),
      },
      annotations: READ_ONLY,
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
        "List items created or modified since a moment — including trashed, logged, and " +
        "repeating items (inspect each item's fields to tell them apart). Edits to tags, " +
        "areas, and checklist items do not mark the containing item as modified.",
      inputSchema: {
        since: z.string().describe("ISO date-time, e.g. 2026-07-06T08:00:00"),
        limit: z.number().int().min(1).optional().describe("Default 200"),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      guard(() => {
        const since = new Date(args.since);
        if (Number.isNaN(since.getTime())) {
          return usage(`since is not a parseable date: ${args.since}`);
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
        "Full detail for one item by uuid: notes, schedule, reminder, deadline, tags " +
        "(direct and inherited), checklist with per-item state, repeat schedule, and its " +
        "project/area/heading.",
      inputSchema: { uuid: z.string() },
      annotations: READ_ONLY,
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
      description:
        "One project's full contents: metadata plus its to-dos grouped under their headings.",
      inputSchema: { uuid: z.string().describe("Project uuid") },
      annotations: READ_ONLY,
    },
    async (args) => guard(() => jsonResult(getClient().read.projectView(args.uuid))),
  );

  server.registerTool(
    "list_collections",
    {
      description:
        "List every project, area, or tag (tags include their parent-tag nesting). Use to " +
        "refresh the inventory summarized in the server instructions.",
      inputSchema: { kind: z.enum(["projects", "areas", "tags"]) },
      annotations: READ_ONLY,
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

  // ---------------------------------------------------------------- to-dos

  const whenSchema = z.string().optional().describe(WHEN_VALUES);

  server.registerTool(
    "add_todo",
    {
      description:
        "Create a to-do and return its uuid. Optionally schedule it, set a reminder or " +
        "deadline, tag it, give it a checklist, and place it in a project or area " +
        "(optionally under an existing heading). Tags must name existing tags. A reminder " +
        "requires when = today, evening, or a date. Adding into a completed or canceled " +
        "project reopens that project — pass acknowledge_project_reopen to confirm.",
      inputSchema: {
        title: z.string(),
        notes: z.string().optional(),
        when: whenSchema,
        reminder: z.string().optional().describe(REMINDER_FORMAT),
        deadline: z.string().optional().describe(DATE_FORMAT),
        tags: z.array(z.string()).optional().describe("Existing tag names"),
        checklist_items: z.array(z.string()).optional(),
        project: z.string().optional().describe(`Destination project (${REF_FORMAT})`),
        area: z.string().optional().describe(`Destination area (${REF_FORMAT})`),
        heading: z.string().optional().describe("Existing heading in the destination project"),
        acknowledge_project_reopen: z
          .boolean()
          .optional()
          .describe("Confirm adding into a completed/canceled project (this reopens it)"),
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
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
        "Update a to-do's title, notes, schedule, reminder, or deadline. " +
        "append_notes/prepend_notes add a line to the existing notes (exclusive with " +
        "notes). Changing the schedule keeps an existing reminder unless the call sets a " +
        "new one. clear_reminder works while the to-do is scheduled for today or this " +
        "evening; a reminder on a future date can only be changed, not cleared " +
        "(re-schedule to today first). Schedule and deadline changes are not available " +
        "for repeating to-dos.",
      inputSchema: {
        uuid: z.string(),
        title: z.string().optional(),
        notes: z.string().optional().describe("Replaces the whole notes body"),
        append_notes: z.string().optional(),
        prepend_notes: z.string().optional(),
        when: whenSchema,
        reminder: z.string().optional().describe(REMINDER_FORMAT),
        clear_reminder: z.boolean().optional(),
        deadline: z.string().optional().describe(DATE_FORMAT),
        clear_deadline: z.boolean().optional(),
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        const notesModes = [args.notes, args.append_notes, args.prepend_notes].filter(
          (v) => v !== undefined,
        );
        if (notesModes.length > 1) {
          return usage("notes, append_notes, prepend_notes are exclusive");
        }
        if (args.reminder !== undefined && args.clear_reminder === true) {
          return usage("pass at most one of reminder / clear_reminder");
        }
        if (args.deadline !== undefined && args.clear_deadline === true) {
          return usage("pass at most one of deadline / clear_deadline");
        }
        return mutationResult(
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
        );
      }),
  );

  server.registerTool(
    "set_todo_status",
    {
      description:
        "Set a to-do's status: completed, canceled, or open (reopening a " +
        "completed/canceled to-do). Not available for repeating to-dos.",
      inputSchema: {
        uuid: z.string(),
        status: z.enum(["completed", "canceled", "open"]),
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        const c = getClient();
        const opts = writeOptions(args);
        return mutationResult(
          args.status === "completed"
            ? await c.write.completeTodo(args.uuid, opts)
            : args.status === "canceled"
              ? await c.write.cancelTodo(args.uuid, opts)
              : await c.write.reopenTodo(args.uuid, opts),
        );
      }),
  );

  server.registerTool(
    "move_todo",
    {
      description:
        "Move a to-do. Pass exactly one destination: a project and/or area (optionally an " +
        "existing heading within the project), to_inbox, or detach. Moving to the Inbox " +
        "removes any schedule; detach removes the project/area/heading assignment while " +
        "keeping the schedule. Moving into a completed or canceled project reopens that " +
        "project — pass acknowledge_project_reopen to confirm.",
      inputSchema: {
        uuid: z.string(),
        project: z.string().optional().describe(`Destination project (${REF_FORMAT})`),
        area: z.string().optional().describe(`Destination area (${REF_FORMAT})`),
        heading: z.string().optional().describe("Existing heading in the destination project"),
        to_inbox: z.boolean().optional().describe("Move back to the Inbox (removes any schedule)"),
        detach: z
          .boolean()
          .optional()
          .describe("Remove the project/area/heading assignment, keeping the schedule"),
        acknowledge_project_reopen: z
          .boolean()
          .optional()
          .describe("Confirm moving into a completed/canceled project (this reopens it)"),
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        const dest =
          args.project !== undefined || args.area !== undefined || args.heading !== undefined;
        const modes = [dest, args.to_inbox === true, args.detach === true].filter(Boolean).length;
        if (modes !== 1) {
          return usage("pass exactly one destination: project/area/heading, to_inbox, or detach");
        }
        return mutationResult(
          await getClient().write.moveTodo(
            args.uuid,
            {
              ...(args.project !== undefined && { project: containerRef(args.project) }),
              ...(args.area !== undefined && { area: containerRef(args.area) }),
              ...(args.heading !== undefined && { heading: args.heading }),
              ...(args.to_inbox === true && { inbox: true }),
              ...(args.detach === true && { detach: true }),
            },
            {
              ...writeOptions(args),
              ...(args.to_inbox === true && { vector: "applescript" as const }),
            },
          ),
        );
      }),
  );

  server.registerTool(
    "set_tags",
    {
      description:
        "Replace or extend a to-do's tags. mode 'replace' (default) sets exactly the given " +
        "list — an empty list removes all tags; mode 'add' merges with the current tags. " +
        "Tags must name existing tags (create them first with add_tag).",
      inputSchema: {
        uuid: z.string(),
        tags: z.array(z.string()).describe("Existing tag names"),
        mode: z.enum(["replace", "add"]).optional().describe("Default: replace"),
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        const c = getClient();
        return mutationResult(
          args.mode === "add"
            ? await c.write.addTags(args.uuid, args.tags, writeOptions(args))
            : await c.write.setTags(args.uuid, args.tags, writeOptions(args)),
        );
      }),
  );

  server.registerTool(
    "edit_checklist",
    {
      description:
        "Edit a to-do's checklist. The single-item actions add / remove / check / uncheck " +
        "/ rename / move change one item — matched by exact title — and leave every other " +
        "item and its checked state untouched. The replace action swaps in a whole new " +
        "list (items), discarding the existing items and their checked states — pass " +
        "acknowledge_checklist_reset to confirm when items already exist; entries may be " +
        "strings or {title, completed} objects to create items pre-checked. Positions are " +
        "1-based.",
      inputSchema: {
        uuid: z.string(),
        action: z.enum(["add", "remove", "check", "uncheck", "rename", "move", "replace"]),
        title: z.string().optional().describe("add: the new item's title; rename: the new title"),
        item: z
          .string()
          .optional()
          .describe("remove/check/uncheck/rename/move: the existing item's exact title"),
        at: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("add: 1-based insert position (default: end)"),
        to: z.number().int().min(1).optional().describe("move: 1-based target position"),
        items: z
          .array(
            z.union([
              z.string(),
              z.object({ title: z.string(), completed: z.boolean().optional() }),
            ]),
          )
          .optional()
          .describe("replace: the full new checklist, in order"),
        acknowledge_checklist_reset: z
          .boolean()
          .optional()
          .describe("replace: confirm discarding the existing items and their checked states"),
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        const c = getClient();
        if (args.action === "replace") {
          if (args.items === undefined) return usage('action "replace" requires items');
          const items = args.items.map((i) =>
            typeof i === "string"
              ? i
              : { title: i.title, ...(i.completed !== undefined && { completed: i.completed }) },
          );
          return mutationResult(
            await c.write.run(
              "todo.replace-checklist",
              { uuid: args.uuid, items },
              writeOptions(args),
            ),
          );
        }
        let edit: ChecklistEdit;
        switch (args.action) {
          case "add":
            if (args.title === undefined) return usage('action "add" requires title');
            edit = {
              action: "add",
              title: args.title,
              ...(args.at !== undefined && { at: args.at }),
            };
            break;
          case "remove":
          case "check":
          case "uncheck":
            if (args.item === undefined) return usage(`action "${args.action}" requires item`);
            edit = { action: args.action, item: args.item };
            break;
          case "rename":
            if (args.item === undefined || args.title === undefined) {
              return usage('action "rename" requires item and title');
            }
            edit = { action: "rename", item: args.item, title: args.title };
            break;
          case "move":
            if (args.item === undefined || args.to === undefined) {
              return usage('action "move" requires item and to');
            }
            edit = { action: "move", item: args.item, to: args.to };
            break;
        }
        return mutationResult(await c.write.editChecklist(args.uuid, edit, writeOptions(args)));
      }),
  );

  // ------------------------------------------------- to-dos AND projects

  server.registerTool(
    "delete_item",
    {
      description:
        "Move a to-do or project to the Trash (recoverable via restore_item until the " +
        "Trash is emptied). Deleting a project sends its to-dos to the Trash with it. Not " +
        "available for repeating to-dos.",
      inputSchema: { uuid: z.string(), ...dryRunShape },
      annotations: DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        const c = getClient();
        return mutationResult(
          itemType(args.uuid) === "to-do"
            ? await c.write.deleteTodo(args.uuid, writeOptions(args))
            : await c.write.deleteProject(args.uuid, writeOptions(args)),
        );
      }),
  );

  server.registerTool(
    "restore_item",
    {
      description:
        "Restore a trashed to-do or project. A to-do returns to the Inbox without its " +
        "previous schedule or project/area. A project is restored in place: its schedule, " +
        "area, and children come back exactly as they were.",
      inputSchema: { uuid: z.string(), ...dryRunShape },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        const c = getClient();
        return mutationResult(
          itemType(args.uuid) === "to-do"
            ? await c.write.restoreTodo(args.uuid, writeOptions(args))
            : await c.write.restoreProject(args.uuid, writeOptions(args)),
        );
      }),
  );

  server.registerTool(
    "duplicate_item",
    {
      description:
        "Duplicate a to-do or project and return the copy's uuid; a duplicated project " +
        "includes its children. Not available for repeating items.",
      inputSchema: { uuid: z.string(), ...dryRunShape },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        const c = getClient();
        return mutationResult(
          itemType(args.uuid) === "to-do"
            ? await c.write.duplicateTodo(args.uuid, writeOptions(args))
            : await c.write.duplicateProject(args.uuid, writeOptions(args)),
        );
      }),
  );

  // -------------------------------------------------------------- projects

  server.registerTool(
    "add_project",
    {
      description:
        "Create a project and return its uuid. Optionally place it in an area, schedule " +
        "it, set a deadline, and seed it with initial to-dos.",
      inputSchema: {
        title: z.string(),
        notes: z.string().optional(),
        area: z.string().optional().describe(`Destination area (${REF_FORMAT})`),
        when: whenSchema,
        deadline: z.string().optional().describe(DATE_FORMAT),
        todos: z.array(z.string()).optional().describe("Initial child to-do titles"),
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
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
    "update_project",
    {
      description:
        "Update a project's title, notes, schedule, or deadline. " +
        "append_notes/prepend_notes add a line to the existing notes (exclusive with notes).",
      inputSchema: {
        uuid: z.string(),
        title: z.string().optional(),
        notes: z.string().optional().describe("Replaces the whole notes body"),
        append_notes: z.string().optional(),
        prepend_notes: z.string().optional(),
        when: whenSchema,
        deadline: z.string().optional().describe(DATE_FORMAT),
        clear_deadline: z.boolean().optional(),
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        const notesModes = [args.notes, args.append_notes, args.prepend_notes].filter(
          (v) => v !== undefined,
        );
        if (notesModes.length > 1) {
          return usage("notes, append_notes, prepend_notes are exclusive");
        }
        if (args.deadline !== undefined && args.clear_deadline === true) {
          return usage("pass at most one of deadline / clear_deadline");
        }
        return mutationResult(
          await getClient().write.updateProject(
            args.uuid,
            {
              ...(args.title !== undefined && { title: args.title }),
              ...(args.notes !== undefined && { notes: args.notes }),
              ...(args.append_notes !== undefined && { appendNotes: args.append_notes }),
              ...(args.prepend_notes !== undefined && { prependNotes: args.prepend_notes }),
              ...(args.when !== undefined && { when: args.when as never }),
              ...(args.deadline !== undefined && { deadline: args.deadline }),
              ...(args.clear_deadline === true && { deadline: null }),
            },
            writeOptions(args),
          ),
        );
      }),
  );

  server.registerTool(
    "set_project_status",
    {
      description:
        "Complete, cancel, or reopen a project. Completing or canceling requires a " +
        "children policy: 'require-resolved' errors if open to-dos remain; " +
        "'auto-complete'/'auto-cancel' resolves them together with the project (canceling " +
        "never alters already-completed children). status 'open' reopens a completed or " +
        "canceled project; its children stay completed/canceled unless restore_children " +
        "also reopens the ones that were resolved together with the project.",
      inputSchema: {
        uuid: z.string().describe("Project uuid"),
        status: z.enum(["completed", "canceled", "open"]),
        children: z
          .enum(["require-resolved", "auto-complete", "auto-cancel"])
          .optional()
          .describe("Required for completed/canceled: what to do with the project's open to-dos"),
        restore_children: z
          .boolean()
          .optional()
          .describe("open only: also reopen the to-dos that were resolved with the project"),
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        const c = getClient();
        if (args.status !== "open" && args.restore_children !== undefined) {
          return usage("restore_children applies only to status 'open'");
        }
        if (args.status === "completed") {
          if (args.children !== "require-resolved" && args.children !== "auto-complete") {
            return usage(
              "status 'completed' requires children: 'require-resolved' or 'auto-complete'",
            );
          }
          return mutationResult(
            await c.write.completeProject(
              args.uuid,
              { children: args.children },
              writeOptions(args),
            ),
          );
        }
        if (args.status === "canceled") {
          if (args.children !== "require-resolved" && args.children !== "auto-cancel") {
            return usage(
              "status 'canceled' requires children: 'require-resolved' or 'auto-cancel'",
            );
          }
          return mutationResult(
            await c.write.cancelProject(args.uuid, { children: args.children }, writeOptions(args)),
          );
        }
        if (args.children !== undefined) {
          return usage("children applies only to status 'completed' or 'canceled'");
        }
        const outcome = await c.write.reopenProject(args.uuid, {
          ...writeOptions(args),
          ...(args.restore_children === true && { restoreChildren: true }),
        });
        return outcome.project.kind === "ok" || outcome.project.kind === "dry-run"
          ? jsonResult(outcome)
          : mutationResult(outcome.project);
      }),
  );

  server.registerTool(
    "move_project",
    {
      description:
        "Move a project into an area, or detach it from its current area. Pass exactly " +
        "one of area / detach. The project's status and schedule are unaffected.",
      inputSchema: {
        uuid: z.string().describe("Project uuid"),
        area: z.string().optional().describe(`Destination area (${REF_FORMAT})`),
        detach: z.boolean().optional().describe("Remove the current area assignment"),
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        if ((args.detach === true) === (args.area !== undefined)) {
          return usage("pass exactly one of area / detach");
        }
        const c = getClient();
        return mutationResult(
          args.detach === true
            ? await c.write.detachProject(args.uuid, writeOptions(args))
            : await c.write.moveProject(
                args.uuid,
                containerRef(args.area as string),
                writeOptions(args),
              ),
        );
      }),
  );

  // ----------------------------------------------------------------- areas

  server.registerTool(
    "add_area",
    {
      description: "Create an area. Tags, when given, must name existing tags.",
      inputSchema: {
        title: z.string(),
        tags: z.array(z.string()).optional().describe("Existing tag names"),
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () =>
        mutationResult(
          await getClient().write.addArea(
            { title: args.title, ...(args.tags !== undefined && { tags: args.tags }) },
            writeOptions(args),
          ),
        ),
      ),
  );

  server.registerTool(
    "update_area",
    {
      description:
        "Rename an area and/or replace its tags (the full set; tags must name existing tags).",
      inputSchema: {
        target: z.string().describe(`Area to update (${REF_FORMAT})`),
        title: z.string().optional().describe("New name"),
        tags: z.array(z.string()).optional().describe("Existing tag names (full replacement)"),
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        if (args.title === undefined && args.tags === undefined) {
          return usage("pass title and/or tags");
        }
        return mutationResult(
          await getClient().write.updateArea(
            args.target,
            {
              ...(args.title !== undefined && { title: args.title }),
              ...(args.tags !== undefined && { tags: args.tags }),
            },
            writeOptions(args),
          ),
        );
      }),
  );

  server.registerTool(
    "delete_area",
    {
      description:
        "Delete an area PERMANENTLY — areas do not go to the Trash, so this cannot be " +
        "undone; requires dangerously_permanent. The area's to-dos move to the Trash; its " +
        "projects remain, no longer assigned to any area.",
      inputSchema: {
        target: z.string().describe(`Area to delete (${REF_FORMAT})`),
        dangerously_permanent: z
          .boolean()
          .optional()
          .describe("Confirm permanent, unrecoverable deletion"),
        ...dryRunShape,
      },
      annotations: DESTRUCTIVE,
    },
    async (args) =>
      guard(async () =>
        mutationResult(await getClient().write.deleteArea(args.target, writeOptions(args))),
      ),
  );

  // ------------------------------------------------------------------ tags

  server.registerTool(
    "add_tag",
    {
      description: "Create a tag, optionally nested under an existing parent tag.",
      inputSchema: {
        title: z.string(),
        parent: z.string().optional().describe("Existing parent tag name"),
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () =>
        mutationResult(
          await getClient().write.addTag(
            { title: args.title, ...(args.parent !== undefined && { parent: args.parent }) },
            writeOptions(args),
          ),
        ),
      ),
  );

  server.registerTool(
    "update_tag",
    {
      description:
        "Rename a tag (existing assignments follow the rename), nest it under another " +
        "existing tag, un-nest it to the top level, and/or set its keyboard shortcut. " +
        "parent and unnest are exclusive.",
      inputSchema: {
        target: z.string().describe(`Tag to update (${REF_FORMAT})`),
        title: z.string().optional().describe("New name"),
        parent: z.string().optional().describe("Existing tag to nest under"),
        unnest: z.boolean().optional().describe("Move the tag to the top level"),
        shortcut: z.string().optional().describe("Keyboard shortcut character"),
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        if (
          args.title === undefined &&
          args.parent === undefined &&
          args.unnest === undefined &&
          args.shortcut === undefined
        ) {
          return usage("pass title, parent, unnest, and/or shortcut");
        }
        if (args.parent !== undefined && args.unnest === true) {
          return usage("parent and unnest are exclusive");
        }
        return mutationResult(
          await getClient().write.updateTag(
            args.target,
            {
              ...(args.title !== undefined && { title: args.title }),
              ...(args.parent !== undefined && { parent: args.parent }),
              ...(args.unnest === true && { unnest: true }),
              ...(args.shortcut !== undefined && { shortcut: args.shortcut }),
            },
            writeOptions(args),
          ),
        );
      }),
  );

  server.registerTool(
    "delete_tag",
    {
      description:
        "Delete a tag PERMANENTLY — tags do not go to the Trash, so this cannot be undone; " +
        "requires dangerously_permanent. The tag is removed from every item. If the tag " +
        "has nested child tags they are ALL permanently deleted with it — pass " +
        "acknowledge_tag_subtree to confirm.",
      inputSchema: {
        target: z.string().describe(`Tag to delete (${REF_FORMAT})`),
        dangerously_permanent: z
          .boolean()
          .optional()
          .describe("Confirm permanent, unrecoverable deletion"),
        acknowledge_tag_subtree: z
          .boolean()
          .optional()
          .describe("Confirm permanent deletion of ALL nested child tags too"),
        ...dryRunShape,
      },
      annotations: DESTRUCTIVE,
    },
    async (args) =>
      guard(async () =>
        mutationResult(await getClient().write.deleteTag(args.target, writeOptions(args))),
      ),
  );

  // -------------------------------------------------- generic + discovery

  server.registerTool(
    "run_operation",
    {
      description:
        "Run any cataloged operation by kind — the generic entry for operations without a " +
        "dedicated tool (e.g. trash.empty). Call capabilities first for the catalog of " +
        "operation kinds and their parameter shapes.",
      inputSchema: {
        op: z.enum(OPERATION_KINDS as unknown as [string, ...string[]]),
        params: z
          .record(z.string(), z.unknown())
          .describe('Operation params, e.g. {"uuid": "..."} — shapes per `capabilities`'),
        acknowledge_checklist_reset: z.boolean().optional(),
        acknowledge_project_reopen: z.boolean().optional(),
        acknowledge_tag_subtree: z
          .boolean()
          .optional()
          .describe("tag.delete: confirm permanent deletion of ALL nested child tags"),
        dangerously_permanent: z
          .boolean()
          .optional()
          .describe("Required for area/tag delete and trash.empty (PERMANENT, no Trash)"),
        ...dryRunShape,
      },
      annotations: DESTRUCTIVE,
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
        "Run several operations in order, each independently — there are no transactions, " +
        "and a failure does not roll back earlier operations. Per-operation results return " +
        "in order; fail_fast skips the remainder after the first failure.",
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
                  acknowledgeTagSubtree: z.boolean().optional(),
                })
                .optional(),
            }),
          )
          .describe("Ops in execution order"),
        fail_fast: z.boolean().optional().describe("Skip remaining ops after the first failure"),
        ...dryRunShape,
      },
      annotations: DESTRUCTIVE,
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
        "Reorder items within Today, This Evening, a project, or an area — the given " +
        "uuids move to the TOP in the given order; unlisted items keep their relative " +
        "order below. Today/project/area ordering must first be enabled once via `things " +
        `config set allow-experimental true\`. This Evening handles at most ${BOUNCE_MAX_ITEMS} ` +
        "items per call. An area's to-dos and projects are ordered separately — one kind " +
        "per call.",
      inputSchema: {
        scope: z.enum(["today", "evening", "project", "area"]),
        container: z
          .string()
          .optional()
          .describe(`Project/area (${REF_FORMAT}) — required for those scopes`),
        uuids: z.array(z.string()).describe("Desired order, top first (may be a subset)"),
        strategy: z.enum(["native", "bounce"]).optional(),
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
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
        "Undo the last N changes made through this interface, newest first (changes made " +
        "directly in the Things app cannot be undone here). Some changes cannot be " +
        "reversed — permanent deletions, or changes whose prior state is unknown — and are " +
        "reported as irreversible; a to-do brought back from an undone delete returns to " +
        "the Inbox without its schedule. Undoing the creation of an area or tag deletes it " +
        "permanently — requires dangerously_permanent.",
      inputSchema: {
        last: z.number().int().min(1).optional().describe("How many to unwind (default 1)"),
        dangerously_permanent: z.boolean().optional(),
        ...dryRunShape,
      },
      annotations: DESTRUCTIVE,
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

  server.registerTool(
    "capabilities",
    {
      description:
        "Support reference for every operation kind usable with run_operation and batch: " +
        "whether it is available, its caveats, and the confirmation parameters it needs.",
      inputSchema: {
        op: z
          .enum(OPERATION_KINDS as unknown as [string, ...string[]])
          .optional()
          .describe("Limit to one operation kind"),
      },
      annotations: READ_ONLY,
    },
    async (args) => guard(() => jsonResult(capabilitiesTable(args.op as OperationKind))),
  );

  server.registerTool(
    "doctor",
    {
      description:
        "Check the environment: whether the Things app and its database are reachable, " +
        "whether changes can be made, any one-time setup still needed (macOS permissions, " +
        "the app's 'Enable Things URLs' setting), and whether the environment changed since " +
        "the last successful write, with steps to fix.",
      inputSchema: {
        probe_automation: z
          .boolean()
          .optional()
          .describe(
            "Also actively test whether automation of Things is authorized. May show a " +
              "one-time macOS consent prompt on the machine; skipped when Things is not " +
              "running.",
          ),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      guard(() => {
        const { report, error } = diagnose(options.dbPath, {
          ...(args.probe_automation === true && { probeAutomation: true }),
        });
        return report !== null
          ? jsonResult(report)
          : errorResult(error ?? { code: "unexpected", message: "no report" });
      }),
  );

  return server;
}
