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
import { PKG_VERSION, type GroupedPagination, type Pagination } from "../contracts.ts";
import { diagnose } from "../diagnose.ts";
import {
  AREA_PREVIEW_LIMIT,
  DEFAULT_LIST_LIMIT,
  PROJECT_PREVIEW_LIMIT,
  capAreaSections,
  paginateList,
  paginateToday,
  previewSections,
  previewSomedaySections,
  type GroupedLimits,
} from "../read/pagination.ts";
import { resolveCap } from "../read/caps.ts";
import {
  ALL_DESC,
  AREA_LIMIT_DESC,
  DATE_FORMAT,
  LIMIT_DESC,
  PROJECT_LIMIT_DESC,
  REF_FORMAT,
  REMINDER_FORMAT,
  WHEN_VALUES,
} from "../surface-copy.ts";
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

/**
 * A read result carrying truncation metadata: the data (already limited) in
 * the first content block, and a second block with the {@link Pagination}
 * numbers plus a one-line note the agent can read when rows were dropped.
 */
function paginatedResult(data: unknown, pagination: Pagination): ToolResult {
  const note = pagination.truncated
    ? `showing ${pagination.shown} of ${pagination.total} items — pass limit (or all: true) to see more`
    : undefined;
  return {
    content: [
      { type: "text", text: JSON.stringify(data) },
      { type: "text", text: JSON.stringify({ pagination, ...(note !== undefined && { note }) }) },
    ],
  };
}

/**
 * Grouped read result (anytime/someday): the per-block-truncated sections plus
 * a second block carrying the {@link GroupedPagination} counts and, when
 * anything was hidden, a one-line note the agent can read.
 */
function groupedResult(data: unknown, grouped: GroupedPagination): ToolResult {
  const note = grouped.truncated
    ? "some blocks are previews — raise area_limit/project_limit for more per block, or all: true for every item"
    : undefined;
  return {
    content: [
      { type: "text", text: JSON.stringify(data) },
      { type: "text", text: JSON.stringify({ grouped, ...(note !== undefined && { note }) }) },
    ],
  };
}

/** Resolve MCP limit/all (flat read tools) into a row cap (null = every row). */
function resolveLimit(args: {
  limit?: number | undefined;
  all?: boolean | undefined;
}): number | null | "conflict" {
  return resolveCap(args.limit, args.all, DEFAULT_LIST_LIMIT);
}

/** Shared limit/all input schema fragment for the flat read tools. */
const limitShape = {
  limit: z.number().int().min(1).optional().describe(LIMIT_DESC),
  all: z.boolean().optional().describe(ALL_DESC),
};

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
  untagged: z
    .boolean()
    .optional()
    .describe("Only items with no tag (direct or inherited); not combinable with tag/exact_tag"),
};

/** untagged inverts tag, so pairing them is contradictory (surface guard). */
function untaggedConflict(args: {
  untagged?: boolean | undefined;
  tag?: string | undefined;
  exact_tag?: boolean | undefined;
}): boolean {
  return args.untagged === true && (args.tag !== undefined || args.exact_tag === true);
}

const dryRunShape = {
  dry_run: z.boolean().optional().describe("Preview the planned change without applying anything"),
};

const containerRef = (ref: string): { uuid: string; title: string } => ({ uuid: ref, title: ref });

/** Cap on project titles inlined into the server instructions. */
const INSTRUCTIONS_MAX_PROJECTS = 100;

/** A tag's display label: nested tags show `parent > child`. */
const tagLabel = (t: { title: string; parent: { title: string } | null }): string =>
  t.parent === null ? t.title : `${t.parent.title} > ${t.title}`;

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
    "- Items are identified by uuid (returned by every read tool); uuid parameters accept " +
      "unique prefixes of at least 6 characters (ambiguity returns an error listing the " +
      "candidates); a Things share link (things:///show?id=<uuid>) is also accepted and " +
      "stripped to its id. Where a parameter says " +
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

/** Build a checklist edit target from MCP args (index wins over title). */
function checklistTarget(args: { item?: string | undefined; index?: number | undefined }): {
  item?: string;
  index?: number;
} {
  return args.index !== undefined ? { index: args.index } : { item: args.item ?? "" };
}

/** Translate the shared MCP write-tool args into pipeline WriteOptions. */
const writeOptions = (args: {
  dry_run?: boolean | undefined;
  verify_timeout_ms?: number | undefined;
  acknowledge_checklist_reset?: boolean | undefined;
  acknowledge_project_reopen?: boolean | undefined;
  dangerously_permanent?: boolean | undefined;
  acknowledge_tag_subtree?: boolean | undefined;
  dangerously_drive_gui?: boolean | undefined;
}): WriteOptions => ({
  actor: "mcp",
  ...(args.dry_run === true && { dryRun: true }),
  ...(args.verify_timeout_ms !== undefined && { verifyTimeoutMs: args.verify_timeout_ms }),
  ...(args.acknowledge_checklist_reset === true && { acknowledgeChecklistReset: true }),
  ...(args.acknowledge_project_reopen === true && { acknowledgeProjectReopen: true }),
  ...(args.dangerously_permanent === true && { dangerouslyPermanent: true }),
  ...(args.acknowledge_tag_subtree === true && { acknowledgeTagSubtree: true }),
  ...(args.dangerously_drive_gui === true && { dangerouslyDriveGui: true }),
});

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
        "from anytime — the project row represents them; someday lists each group's " +
        "project rows before its to-dos. Flat views (today/inbox/upcoming/logbook/trash) " +
        `return at most ${DEFAULT_LIST_LIMIT} items by default (raise with limit); ` +
        "anytime/someday always return every group and cap per block instead — " +
        `area_limit (default ${AREA_PREVIEW_LIMIT}) per area block, and on anytime ` +
        `project_limit (default ${PROJECT_PREVIEW_LIMIT}) per project block. ` +
        "all: true lifts every cap; the result's second block reports the counts.",
      inputSchema: {
        view: z.enum(["today", "inbox", "anytime", "upcoming", "someday", "logbook", "trash"]),
        ...tagFilterShape,
        evening: z.boolean().optional().describe("today only: show only the This Evening section"),
        show_active_project_items: z
          .union([z.boolean(), z.number().int().min(1)])
          .optional()
          .describe(
            "someday only: include someday to-dos inside active projects, clustered per " +
              "project after each group; a number caps each project's list (true: every item)",
          ),
        active_project_items: z
          .union([z.boolean(), z.number().int().min(1)])
          .optional()
          .describe("compatibility alias for show_active_project_items"),
        horizon: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("upcoming only: occurrences shown per repeating item (default 1)"),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`flat views only (not anytime/someday): ${LIMIT_DESC}`),
        area_limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`anytime/someday only: ${AREA_LIMIT_DESC}`),
        project_limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`anytime only: ${PROJECT_LIMIT_DESC}`),
        all: z
          .boolean()
          .optional()
          .describe(
            "show everything (flat views: no row limit; anytime/someday: no per-block caps)",
          ),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      guard(() => {
        if (untaggedConflict(args)) return usage("pass untagged, or tag/exact_tag — not both");
        // show_active_project_items is the preferred name; active_project_items
        // stays accepted as a compatibility alias.
        const showActiveProjectItems = args.show_active_project_items ?? args.active_project_items;
        const isGrouped = args.view === "anytime" || args.view === "someday";
        if (isGrouped && args.limit !== undefined) {
          return usage(
            `limit does not apply to ${args.view} — cap blocks with area_limit` +
              `${args.view === "anytime" ? "/project_limit" : ""}, or pass all: true`,
          );
        }
        if (!isGrouped && (args.area_limit !== undefined || args.project_limit !== undefined)) {
          return usage(`area_limit/project_limit apply only to anytime/someday, not ${args.view}`);
        }
        if (args.view !== "someday" && showActiveProjectItems !== undefined) {
          return usage("show_active_project_items applies only to someday");
        }
        if (args.view !== "today" && args.evening === true) {
          return usage(`evening applies only to today, not ${args.view}`);
        }
        if (args.view === "someday" && args.project_limit !== undefined) {
          return usage(
            "project_limit does not apply to someday — pass a number as show_active_project_items " +
              "to cap that section's project lists",
          );
        }
        const limit = resolveLimit(args);
        if (limit === "conflict") return usage("pass at most one of limit / all");
        const areaLimit = resolveCap(args.area_limit, args.all, AREA_PREVIEW_LIMIT);
        const projectLimit = resolveCap(args.project_limit, args.all, PROJECT_PREVIEW_LIMIT);
        if (areaLimit === "conflict" || projectLimit === "conflict") {
          return usage("pass at most one of area_limit/project_limit / all");
        }
        const c = getClient();
        const filter = {
          ...(args.tag !== undefined && { tag: args.tag }),
          ...(args.exact_tag === true && { exactTag: true }),
          ...(args.untagged === true && { untagged: true }),
        };
        switch (args.view) {
          case "today": {
            const { data, pagination } = paginateToday(
              c.read.today({ ...filter, ...(args.evening === true && { eveningOnly: true }) }),
              limit,
            );
            return paginatedResult(data, pagination);
          }
          case "inbox": {
            const { data, pagination } = paginateList(c.read.inbox(filter), limit);
            return paginatedResult(data, pagination);
          }
          case "anytime": {
            const limits: GroupedLimits = { area: areaLimit, project: projectLimit };
            const { data, grouped } = previewSections(c.read.anytime(filter), limits);
            return groupedResult(data, grouped);
          }
          case "upcoming": {
            const { data, pagination } = paginateList(
              c.read.upcoming({
                ...filter,
                ...(args.horizon !== undefined && { horizon: args.horizon }),
              }),
              limit,
            );
            return paginatedResult(data, pagination);
          }
          case "someday": {
            const active = showActiveProjectItems;
            if (typeof active === "number" && args.all === true) {
              return usage("pass at most one of a numeric show_active_project_items / all");
            }
            const limits: GroupedLimits = {
              area: areaLimit,
              // true = every item per project; a number caps each list.
              project: typeof active === "number" ? active : null,
            };
            const { data, grouped } = previewSomedaySections(
              c.read.someday({
                ...filter,
                ...((active === true || typeof active === "number") && {
                  activeProjectItems: true,
                }),
              }),
              limits,
            );
            return groupedResult(data, grouped);
          }
          case "logbook": {
            const { data, pagination } = paginateList(
              c.read.logbook({ ...filter, limit: null }),
              limit,
            );
            return paginatedResult(data, pagination);
          }
          case "trash": {
            const { data, pagination } = paginateList(c.read.trash({ limit: null }), limit);
            return paginatedResult(data, pagination);
          }
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
        all: z
          .boolean()
          .optional()
          .describe("Everything, unbounded: open + logged + trashed, no row limit"),
        limit: z.number().int().min(1).optional().describe(LIMIT_DESC),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      guard(() => {
        if (untaggedConflict(args)) return usage("pass untagged, or tag/exact_tag — not both");
        const limit = resolveLimit(args);
        if (limit === "conflict") return usage("pass at most one of limit / all");
        const { data, pagination } = paginateList(
          getClient().read.search(args.query, {
            limit: null,
            ...(args.tag !== undefined && { tag: args.tag }),
            ...(args.exact_tag === true && { exactTag: true }),
            ...(args.untagged === true && { untagged: true }),
            ...(args.project !== undefined && { project: args.project }),
            ...(args.area !== undefined && { area: args.area }),
            ...(args.type !== undefined && { type: args.type }),
            ...(args.logged === true && { logged: true }),
            ...(args.trashed === true && { trashed: true }),
            ...(args.all === true && { all: true }),
          }),
          limit,
        );
        return paginatedResult(data, pagination);
      }),
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
        ...limitShape,
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      guard(() => {
        const limit = resolveLimit(args);
        if (limit === "conflict") return usage("pass at most one of limit / all");
        const since = new Date(args.since);
        if (Number.isNaN(since.getTime())) {
          return usage(`since is not a parseable date: ${args.since}`);
        }
        const { data, pagination } = paginateList(
          getClient().read.changes({ since, limit: null }),
          limit,
        );
        return paginatedResult(data, pagination);
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
      inputSchema: { uuid: z.string().describe("Project uuid or unique name") },
      annotations: READ_ONLY,
    },
    async (args) => guard(() => jsonResult(getClient().read.projectView(args.uuid))),
  );

  server.registerTool(
    "get_area",
    {
      description:
        "One area's contents: metadata plus its direct to-dos (active first), its " +
        "projects in sidebar order, later (scheduled/repeating/someday), and logged items. " +
        `The project-rows and direct-to-dos sections are capped at ${AREA_PREVIEW_LIMIT} each ` +
        "by default (project_limit / area_limit adjust them; all: true lifts both); the " +
        "second result block reports the counts.",
      inputSchema: {
        ref: z.string().describe("Area uuid or unique name"),
        area_limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`maximum direct to-dos to return (default ${AREA_PREVIEW_LIMIT})`),
        project_limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`maximum project rows to return (default ${AREA_PREVIEW_LIMIT})`),
        all: z.boolean().optional().describe("return both sections in full (no caps)"),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      guard(() => {
        const areaLimit = resolveCap(args.area_limit, args.all, AREA_PREVIEW_LIMIT);
        const projectLimit = resolveCap(args.project_limit, args.all, AREA_PREVIEW_LIMIT);
        if (areaLimit === "conflict" || projectLimit === "conflict") {
          return usage("pass at most one of area_limit/project_limit / all");
        }
        const limits: GroupedLimits = { area: areaLimit, project: projectLimit };
        const { data, grouped } = capAreaSections(getClient().read.areaView(args.ref), limits);
        return groupedResult(data, grouped);
      }),
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
        "Replace or extend a to-do's or project's tags. mode 'replace' (default) sets exactly " +
        "the given list — an empty list removes all tags; mode 'add' merges with the current " +
        "tags. Tags must name existing tags (create them first with add_tag).",
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
        const isProject = itemType(args.uuid) === "project";
        const opts = writeOptions(args);
        if (args.mode === "add") {
          return mutationResult(
            isProject
              ? await c.write.addProjectTags(args.uuid, args.tags, opts)
              : await c.write.addTags(args.uuid, args.tags, opts),
          );
        }
        return mutationResult(
          isProject
            ? await c.write.setProjectTags(args.uuid, args.tags, opts)
            : await c.write.setTags(args.uuid, args.tags, opts),
        );
      }),
  );

  server.registerTool(
    "edit_checklist",
    {
      description:
        "Edit a to-do's checklist. The single-item actions add / remove / check / uncheck " +
        "/ rename / move change one item — targeted by title or 1-based index — and leave " +
        "every other item and its checked state untouched (duplicate titles resolve " +
        "best-effort). The replace action swaps in a whole new " +
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
          .describe("remove/check/uncheck/rename/move: the existing item's title"),
        index: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "remove/check/uncheck/rename/move: target by 1-based position instead of title",
          ),
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
            if (args.item === undefined && args.index === undefined) {
              return usage(`action "${args.action}" requires item or index`);
            }
            edit = { action: args.action, ...checklistTarget(args) };
            break;
          case "rename":
            if (args.title === undefined || (args.item === undefined && args.index === undefined)) {
              return usage('action "rename" requires title and (item or index)');
            }
            edit = { action: "rename", ...checklistTarget(args), title: args.title };
            break;
          case "move":
            if (args.to === undefined || (args.item === undefined && args.index === undefined)) {
              return usage('action "move" requires to and (item or index)');
            }
            edit = { action: "move", ...checklistTarget(args), to: args.to };
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
    "backdate_todo",
    {
      description:
        "Rewrite a to-do's completion and/or creation timestamp to noon (local) on the " +
        "given date. completion_date requires the to-do to already be completed or " +
        "canceled; the Logbook re-sorts to the new date.",
      inputSchema: {
        uuid: z.string(),
        completion_date: z.string().optional().describe(DATE_FORMAT),
        creation_date: z.string().optional().describe(DATE_FORMAT),
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () =>
        mutationResult(
          await getClient().write.backdateTodo(
            args.uuid,
            {
              ...(args.completion_date !== undefined && { completionDate: args.completion_date }),
              ...(args.creation_date !== undefined && { creationDate: args.creation_date }),
            },
            writeOptions(args),
          ),
        ),
      ),
  );

  server.registerTool(
    "add_logged_todo",
    {
      description:
        "Create a to-do directly in the Logbook: completed, with the given past " +
        "completion date (and optionally a past creation date). For importing history " +
        "from another system.",
      inputSchema: {
        title: z.string(),
        completion_date: z.string().describe(DATE_FORMAT),
        creation_date: z.string().optional().describe(`${DATE_FORMAT}; <= completion_date`),
        notes: z.string().optional(),
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () =>
        mutationResult(
          await getClient().write.addLoggedTodo(
            {
              title: args.title,
              completionDate: args.completion_date,
              ...(args.creation_date !== undefined && { creationDate: args.creation_date }),
              ...(args.notes !== undefined && { notes: args.notes }),
            },
            writeOptions(args),
          ),
        ),
      ),
  );

  server.registerTool(
    "create_heading",
    {
      description:
        "Create a heading inside an existing project; its uuid is returned. The project " +
        "must name an existing project. Uses the Things proxy shortcuts — set them up once " +
        "with `things setup shortcuts`.",
      inputSchema: {
        project: z.string().describe(`Existing project (${REF_FORMAT})`),
        title: z.string(),
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () =>
        mutationResult(
          await getClient().write.createHeading(
            containerRef(args.project),
            args.title,
            writeOptions(args),
          ),
        ),
      ),
  );

  server.registerTool(
    "clear_reminder",
    {
      description:
        "Clear a to-do's time-of-day reminder while keeping its scheduled date. Uses the " +
        "Things proxy shortcuts when installed (in place, and the only path for a repeating " +
        "to-do); otherwise a non-repeating dated to-do falls back to a URL re-schedule that " +
        "briefly moves it to Today and back. Reversible with the undo tool.",
      inputSchema: { uuid: z.string(), ...dryRunShape },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () =>
        mutationResult(await getClient().write.clearReminder(args.uuid, writeOptions(args))),
      ),
  );

  server.registerTool(
    "rename_heading",
    {
      description: "Rename a heading in place (works on archived headings too).",
      inputSchema: { uuid: z.string(), title: z.string(), ...dryRunShape },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () =>
        mutationResult(
          await getClient().write.renameHeading(args.uuid, args.title, writeOptions(args)),
        ),
      ),
  );

  server.registerTool(
    "archive_heading",
    {
      description:
        "Archive a heading — it leaves the active project view (reversible with " +
        "unarchive_heading). The preferred way to retire a heading: row deletion only " +
        "exists in the app's UI / Shortcuts behind a per-run consent dialog. With open " +
        "children the children policy is required: complete or cancel resolve them with " +
        "the heading in one cascade; reparent moves them to the project root first, " +
        "keeping them open (a compound sequence that undo reverses as one unit).",
      inputSchema: {
        uuid: z.string(),
        children: z
          .enum(["complete", "cancel", "reparent"])
          .optional()
          .describe("Required when the heading has open children"),
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        const r = await getClient().write.archiveHeading(
          args.uuid,
          args.children !== undefined ? { children: args.children } : {},
          writeOptions(args),
        );
        return r.heading.kind === "ok" || r.heading.kind === "dry-run"
          ? jsonResult(r)
          : mutationResult(r.heading);
      }),
  );

  server.registerTool(
    "unarchive_heading",
    {
      description:
        "Un-archive a heading. restore_children also reopens the children the archive " +
        "cascade resolved with it (matching resolution timestamps; someday state " +
        "survives). Children resolved at other times are never touched.",
      inputSchema: {
        uuid: z.string(),
        restore_children: z.boolean().optional(),
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        const r = await getClient().write.unarchiveHeading(
          args.uuid,
          args.restore_children === true ? { restoreChildren: true } : {},
          writeOptions(args),
        );
        return r.heading.kind === "ok" || r.heading.kind === "dry-run"
          ? jsonResult(r)
          : mutationResult(r.heading);
      }),
  );

  // -------------------------------------------- GUI-driven (Accessibility)

  const driveGuiShape = {
    dangerously_drive_gui: z
      .boolean()
      .optional()
      .describe(
        "Required: this drives the local Things app through its accessibility interface to " +
          "make a change the app offers nowhere else. It briefly interacts with the app's UI " +
          "on the machine running this server, and must be turned on first with `things config " +
          "set ui-enabled true`. Intended for a dedicated always-on Mac.",
      ),
  };
  const repeatRuleShape = {
    frequency: z.enum(["daily", "weekly", "monthly", "yearly"]).describe("How often it repeats"),
    interval: z.number().int().min(1).max(99).describe("Every N units (1–99)"),
  };

  server.registerTool(
    "make_repeating",
    {
      description:
        "Turn a plain to-do into a repeating one. This REPLACES the to-do with a new recurring " +
        "series — the original disappears and a fresh repeating item takes its place, so it " +
        "cannot be undone. Only a frequency and an interval are supported. Returns the new " +
        "item's uuid.",
      inputSchema: {
        uuid: z.string().describe("The to-do to make repeating"),
        ...repeatRuleShape,
        ...driveGuiShape,
        ...dryRunShape,
      },
      annotations: DESTRUCTIVE,
    },
    async (args) =>
      guard(async () =>
        mutationResult(
          await getClient().write.run(
            "todo.make-repeating",
            { uuid: args.uuid, frequency: args.frequency, interval: args.interval },
            writeOptions(args),
          ),
        ),
      ),
  );

  server.registerTool(
    "reschedule_repeat",
    {
      description:
        "Change a repeating to-do's frequency and interval, keeping the same item. Only a " +
        "frequency and an interval are supported; other repeat details (weekday choices, end " +
        "bounds) are left as they are and cannot be changed here.",
      inputSchema: {
        uuid: z.string().describe("The repeating to-do to reschedule"),
        ...repeatRuleShape,
        ...driveGuiShape,
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () =>
        mutationResult(
          await getClient().write.run(
            "todo.reschedule-repeat",
            { uuid: args.uuid, frequency: args.frequency, interval: args.interval },
            writeOptions(args),
          ),
        ),
      ),
  );

  server.registerTool(
    "set_repeat_state",
    {
      description:
        "Pause or resume a repeating to-do. 'pause' stops it spawning new occurrences but keeps " +
        "its rule; 'resume' starts it again. The two are inverses of each other.",
      inputSchema: {
        uuid: z.string().describe("The repeating to-do"),
        state: z.enum(["pause", "resume"]),
        ...driveGuiShape,
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        const op = args.state === "pause" ? "todo.pause-repeat" : "todo.resume-repeat";
        return mutationResult(
          await getClient().write.run(op, { uuid: args.uuid }, writeOptions(args)),
        );
      }),
  );

  server.registerTool(
    "reschedule_project_repeat",
    {
      description:
        "Change a repeating project's frequency and interval, keeping the same project. Only a " +
        "frequency and an interval are supported; other repeat details (weekday choices, end " +
        "bounds) are left as they are and cannot be changed here.",
      inputSchema: {
        uuid: z.string().describe("The repeating project to reschedule"),
        ...repeatRuleShape,
        ...driveGuiShape,
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () =>
        mutationResult(
          await getClient().write.run(
            "project.reschedule-repeat",
            { uuid: args.uuid, frequency: args.frequency, interval: args.interval },
            writeOptions(args),
          ),
        ),
      ),
  );

  server.registerTool(
    "set_project_repeat_state",
    {
      description:
        "Pause or resume a repeating project. 'pause' stops it spawning new occurrences but keeps " +
        "its rule; 'resume' starts it again. The two are inverses of each other.",
      inputSchema: {
        uuid: z.string().describe("The repeating project"),
        state: z.enum(["pause", "resume"]),
        ...driveGuiShape,
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        const op = args.state === "pause" ? "project.pause-repeat" : "project.resume-repeat";
        return mutationResult(
          await getClient().write.run(op, { uuid: args.uuid }, writeOptions(args)),
        );
      }),
  );

  server.registerTool(
    "move_area_in_sidebar",
    {
      description:
        "Move an area to a new position in the Things sidebar. Give the area plus exactly one " +
        "destination: before/after another area, or position first/last. The move is made by " +
        "driving the Things window with the pointer — the app comes to the front and the " +
        "sidebar may scroll while the area is dragged; the area's projects and to-dos are " +
        "untouched. Area references are a uuid or a unique name.",
      inputSchema: {
        target: z.string().describe("The area to move (uuid or unique name)"),
        before: z
          .string()
          .optional()
          .describe("Place it immediately above this area (uuid or unique name)"),
        after: z
          .string()
          .optional()
          .describe("Place it immediately below this area (uuid or unique name)"),
        position: z
          .enum(["first", "last"])
          .optional()
          .describe("Move it to the top or bottom of the area list"),
        ...driveGuiShape,
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () =>
        mutationResult(
          await getClient().write.run(
            "area.reorder-sidebar",
            {
              target: args.target,
              ...(args.before !== undefined && { before: args.before }),
              ...(args.after !== undefined && { after: args.after }),
              ...(args.position !== undefined && { position: args.position }),
            },
            writeOptions(args),
          ),
        ),
      ),
  );

  server.registerTool(
    "make_project_repeating",
    {
      description:
        "Turn an existing project into a repeating one. This REPLACES the project with a new " +
        "recurring series — the original disappears and a fresh repeating project takes its place " +
        "(its area is kept), so it cannot be undone. An area-less project scheduled for Anytime is " +
        "moved to Someday first (a cleanup-free intermediate step, shown by dry_run). Only a " +
        "frequency and an interval are supported. Returns the new project's uuid.",
      inputSchema: {
        uuid: z.string().describe("The project to make repeating"),
        ...repeatRuleShape,
        ...driveGuiShape,
        ...dryRunShape,
      },
      annotations: DESTRUCTIVE,
    },
    async (args) =>
      guard(async () =>
        mutationResult(
          await getClient().write.makeRepeatingProject(
            args.uuid,
            { frequency: args.frequency, interval: args.interval },
            writeOptions(args),
          ),
        ),
      ),
  );

  server.registerTool(
    "create_repeating_project",
    {
      description:
        "Create a project and make it repeating in one call. TWO operations: the project is " +
        "created first and PERSISTS even if the make-repeating step refuses; then it is promoted " +
        "(which drives the GUI). Give an area to place it, or omit it to create in Someday. Only a " +
        "frequency and an interval are supported. Returns the new repeating project's uuid.",
      inputSchema: {
        title: z.string(),
        notes: z.string().optional(),
        area: z.string().optional().describe(`Destination area (${REF_FORMAT})`),
        deadline: z.string().optional().describe(DATE_FORMAT),
        todos: z.array(z.string()).optional().describe("Initial child to-do titles"),
        ...repeatRuleShape,
        ...driveGuiShape,
        ...dryRunShape,
      },
      annotations: DESTRUCTIVE,
    },
    async (args) =>
      guard(async () =>
        mutationResult(
          await getClient().write.createRepeatingProject(
            {
              title: args.title,
              ...(args.notes !== undefined && { notes: args.notes }),
              ...(args.area !== undefined && { area: containerRef(args.area) }),
              ...(args.deadline !== undefined && { deadline: args.deadline }),
              ...(args.todos !== undefined && { todos: args.todos }),
              frequency: args.frequency,
              interval: args.interval,
            },
            writeOptions(args),
          ),
        ),
      ),
  );

  server.registerTool(
    "convert_to_project",
    {
      description:
        "Convert a to-do or a heading into a project. This REPLACES the original with a new " +
        "project (a converted to-do keeps its notes; a converted heading is promoted alongside " +
        "its project and its to-dos move under the new project). The original is gone and this " +
        "cannot be undone. Returns the new project's uuid.",
      inputSchema: {
        uuid: z.string().describe("The to-do or heading to convert"),
        ...driveGuiShape,
        ...dryRunShape,
      },
      annotations: DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        const item = getClient().read.byUuid(args.uuid);
        if (item === null) throw new RangeError(`no item with uuid ${args.uuid}`);
        const op =
          item.type === "heading" ? "heading.convert-to-project" : "todo.convert-to-project";
        return mutationResult(
          await getClient().write.run(op, { uuid: args.uuid }, writeOptions(args)),
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
        "Update a project's title, notes, schedule, reminder, or deadline. " +
        "append_notes/prepend_notes add a line to the existing notes (exclusive with notes). " +
        "Changing the schedule keeps an existing reminder unless the call sets a new one. " +
        "clear_reminder works while the project is scheduled for today or this evening; a " +
        "reminder on a future date can only be changed, not cleared.",
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
          await getClient().write.updateProject(
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
        "existing tag, un-nest it to the top level, and set or clear its keyboard shortcut. " +
        "parent and unnest are exclusive; shortcut and clear_shortcut are exclusive.",
      inputSchema: {
        target: z.string().describe(`Tag to update (${REF_FORMAT})`),
        title: z.string().optional().describe("New name"),
        parent: z.string().optional().describe("Existing tag to nest under"),
        unnest: z.boolean().optional().describe("Move the tag to the top level"),
        shortcut: z.string().optional().describe("Keyboard shortcut character"),
        clear_shortcut: z.boolean().optional().describe("Remove the keyboard shortcut"),
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
          args.shortcut === undefined &&
          args.clear_shortcut === undefined
        ) {
          return usage("pass title, parent, unnest, shortcut, and/or clear_shortcut");
        }
        if (args.parent !== undefined && args.unnest === true) {
          return usage("parent and unnest are exclusive");
        }
        if (args.shortcut !== undefined && args.clear_shortcut === true) {
          return usage("shortcut and clear_shortcut are exclusive");
        }
        return mutationResult(
          await getClient().write.updateTag(
            args.target,
            {
              ...(args.title !== undefined && { title: args.title }),
              ...(args.parent !== undefined && { parent: args.parent }),
              ...(args.unnest === true && { unnest: true }),
              ...(args.shortcut !== undefined && { shortcut: args.shortcut }),
              ...(args.clear_shortcut === true && { clearShortcut: true }),
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
        "Reorder items within Today, This Evening, the Inbox, Someday (loose to-dos or " +
        "area-less someday projects — one kind per call), a " +
        "project's to-dos, a project's headings (scope=headings — children move with " +
        "their heading), an area, or the top-level sidebar projects (scope=projects — " +
        "each project takes a brief someday/anytime round-trip) — the given uuids move " +
        "to the TOP in the given order; unlisted items keep their relative order below. " +
        "Today/inbox/someday/project/headings/area ordering must first be enabled once " +
        "via `things config set allow-experimental true`. This Evening and " +
        `scope=projects handle at most ${BOUNCE_MAX_ITEMS} items per call. An area's ` +
        "to-dos and projects are ordered separately — one kind per call.",
      inputSchema: {
        scope: z.enum([
          "today",
          "evening",
          "inbox",
          "someday",
          "project",
          "headings",
          "area",
          "projects",
        ]),
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
        "Undo the last N changes, newest first (changes made directly in the Things app " +
        "cannot be undone here). By default this undoes only changes made through THIS " +
        'interface (by="mcp") — it will not touch the user\'s own edits unless you pass ' +
        'by="*" (all authors) or a specific author name; pass a txn token to undo one exact ' +
        "change. Some changes cannot be reversed — permanent deletions, or changes whose " +
        "prior state is unknown — and are reported as irreversible; a to-do brought back " +
        "from an undone delete returns to the Inbox without its schedule. Undoing the " +
        "creation of an area or tag deletes it permanently — requires dangerously_permanent.",
      inputSchema: {
        last: z.number().int().min(1).optional().describe("How many to unwind (default 1)"),
        by: z
          .string()
          .optional()
          .describe(
            'Whose changes to undo: an exact author name, or "*" for everyone. Defaults to ' +
              '"mcp" (only changes made through this interface). Matches exactly — "mcp" ' +
              'never matches an "undo:mcp" record. Selects WHICH changes to undo; the undo ' +
              'itself is always recorded as "undo:mcp". Not combinable with txn.',
          ),
        txn: z
          .string()
          .optional()
          .describe(
            "Undo exactly the one change with this undo token (the undoToken field returned " +
              "by the mutation); immune to interleaving. Not combinable with last/by.",
          ),
        dangerously_permanent: z.boolean().optional(),
        ...dryRunShape,
      },
      annotations: DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        if (args.txn !== undefined && (args.last !== undefined || args.by !== undefined)) {
          return usage("txn cannot be combined with last or by");
        }
        const items = await getClient().write.undo({
          ...(args.last !== undefined && { last: args.last }),
          ...(args.txn !== undefined && { txn: args.txn }),
          // Asymmetric default: agents must not clobber the user's own edits
          // without explicitly opting in via by:"*".
          ...(args.txn === undefined && { by: args.by ?? "mcp" }),
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
        "the app's 'Enable Things URLs' setting), whether the environment changed since " +
        "the last successful write, and a sync-health summary (whether the app is running, how " +
        "recently the data changed, and — when a Things Cloud account is attached — the last " +
        "sync attempt), with steps to fix.",
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
