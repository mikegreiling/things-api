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

import {
  ALL_DESC,
  AREA_LIMIT_DESC,
  AREA_PREVIEW_LIMIT,
  blockedCode,
  BOUNCE_MAX_ITEMS,
  capabilitiesTable,
  DATE_FORMAT,
  DEFAULT_LIST_LIMIT,
  diagnose,
  FILTER_CONTRACT,
  hasTagPresence,
  isValidTimeZone,
  LIMIT_DESC,
  MCP_WHEN_LABELS,
  noUuidMatch,
  omitEmpty,
  OMIT_EMPTY_NOTE,
  OPERATION_KINDS,
  openThings,
  PKG_VERSION,
  PROJECT_LIMIT_DESC,
  PROJECT_PREVIEW_LIMIT,
  REF_FORMAT,
  ReferenceResolutionError,
  REMINDER_FORMAT,
  schemaWarnings,
  splitWhenSugar,
  tagFilterFields,
  tagFlagConflict,
  validateViewArgs,
  verifyFailedCode,
  WHEN_VALUES,
  type BatchOp,
  type ChecklistEdit,
  type DisruptionTier,
  type GroupedTruncation,
  type MonthlyAnchor,
  type MutationResult,
  type OpenOptions,
  type OperationKind,
  type RepeatFrequency,
  type RepeatRuleParams,
  type ReorderResult,
  type TagPresence,
  type ThingsClient,
  type Truncation,
  type ViewName,
  type Weekday,
  type WriteOptions,
  type YearlyAnchor,
} from "../index.ts";

export interface McpServerOptions {
  dbPath?: string;
  /**
   * The disruption ceiling for EVERY write this server makes, fixed for the
   * whole process lifetime (set once by `things mcp`'s startup flags). Caps
   * vector selection exactly like the CLI's per-call --allow-disruptive /
   * --allow-very-disruptive, but there is no per-request escalation over MCP.
   * Undefined leaves the config profile's default in force.
   */
  maxDisruption?: DisruptionTier;
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
 * A read result: like {@link jsonResult}, but the entity payload passes through
 * the omit-empty transform (docs/design/contracts.md) so an empty optional
 * field is absent, not null/[]. Mutation results keep their own shape and use
 * jsonResult directly.
 */
function readResult(data: unknown): ToolResult {
  return jsonResult(omitEmpty(data));
}

/**
 * A read result carrying truncation metadata: the data (already limited) in
 * the first content block, and a second block with the {@link Truncation}
 * numbers plus a one-line note the agent can read when rows were dropped.
 */
function truncatedResult(data: unknown, truncation: Truncation): ToolResult {
  const note = truncation.truncated
    ? `showing ${truncation.shown} of ${truncation.total} items — pass limit (or all: true) to see more`
    : undefined;
  return {
    content: [
      { type: "text", text: JSON.stringify(omitEmpty(data)) },
      { type: "text", text: JSON.stringify({ truncation, ...(note !== undefined && { note }) }) },
    ],
  };
}

/**
 * Grouped read result (anytime/someday): the per-block-truncated sections plus
 * a second block carrying the {@link GroupedTruncation} counts and, when
 * anything was hidden, a one-line note the agent can read.
 */
function groupedResult(data: unknown, grouped: GroupedTruncation): ToolResult {
  const note = grouped.truncated
    ? "some blocks are previews — raise area_limit/project_limit for more per block, or all: true for every item"
    : undefined;
  return {
    content: [
      { type: "text", text: JSON.stringify(omitEmpty(data)) },
      { type: "text", text: JSON.stringify({ grouped, ...(note !== undefined && { note }) }) },
    ],
  };
}

/**
 * Resolve one MCP cap (limit / area_limit / project_limit) against `all` into a
 * row cap for the client: `null` = every row, `"conflict"` when an explicit
 * value is combined with `all: true` (the tool returns a usage error), else the
 * value or the default. The client re-applies the same semantics on what it
 * receives; this copy owns the conflict detection the MCP surface reports.
 */
function resolveCap(
  value: number | undefined,
  all: boolean | undefined,
  defaultLimit: number,
): number | null | "conflict" {
  if (all === true && value !== undefined) return "conflict";
  if (all === true) return null;
  return value ?? defaultLimit;
}

/**
 * Resolve MCP limit/all (flat read tools) into a row cap (null = every row).
 * all:true wins: it lifts the cap and takes precedence over a limit passed
 * alongside it — an explicit "everything" request resolves the contradiction
 * rather than erroring — so the pair is never a usage error on the flat tools.
 */
function resolveLimit(args: {
  limit?: number | undefined;
  all?: boolean | undefined;
}): number | null {
  if (args.all === true) return null;
  return args.limit ?? DEFAULT_LIST_LIMIT;
}

/** Precedence notes appended to `limit`/`all` wherever a flat tool accepts both. */
const LIMIT_IGNORED_NOTE = "ignored when all is set";
const ALL_WINS_NOTE = "wins over limit if both are set";

/** Shared limit/all input schema fragment for the flat read tools. */
const limitShape = {
  limit: z.number().int().min(1).optional().describe(`${LIMIT_DESC}; ${LIMIT_IGNORED_NOTE}`),
  all: z.boolean().optional().describe(`${ALL_DESC}; ${ALL_WINS_NOTE}`),
};

/**
 * The per-call time-zone knob for date-sensitive tools: an IANA zone that
 * evaluates every date boundary (today/evening/upcoming/logbook/overdue/…) for
 * the consumer's calendar, overriding the server's THINGS_TZ for THIS call.
 */
const TZ_DESC =
  "IANA time zone (e.g. Asia/Tokyo) to evaluate date boundaries in for this call — " +
  "overrides the server default. Reminder times stay wall-clock and are never shifted.";
const tzShape = { tz: z.string().optional().describe(TZ_DESC) };

/** A usage result when `tz` is present but not a recognized IANA zone; null when it is valid/absent. */
function badTz(tz: string | undefined): ToolResult | null {
  if (tz !== undefined && !isValidTimeZone(tz)) {
    return usage(
      `tz is not a valid IANA time zone: "${tz}" — expected e.g. "America/New_York" or "Asia/Tokyo"`,
    );
  }
  return null;
}

function errorResult(error: {
  code: string;
  message: string;
  likelyCause?: string;
  remediation?: string;
  /** Machine-readable disambiguation context, mirroring the CLI envelope's error.details. */
  details?: { candidates?: unknown[]; suggestions?: string[] };
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
        code: blockedCode(result),
        message: result.detail,
        ...(result.likelyCause !== undefined && { likelyCause: result.likelyCause }),
        remediation: result.remediation,
      });
    case "verify-failed":
      return errorResult({
        code: verifyFailedCode(result),
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

/**
 * The three tag-filter inputs shared by every tag-accepting tool. `tag` is an
 * ARRAY — repeat a tag to AND several together (both keep hierarchy-descendant
 * expansion, which `exact_tag` disables). In FLAT views (read_view, search, and
 * the projects list of list_collections) `tag` honors container inheritance; in
 * the SINGLE-CONTAINER tools (get_project, get_area) it matches a tag carried
 * DIRECTLY on the item — that container's own inherited tags are ignored (every
 * child inherits them, so an inheritance-inclusive match would be vacuous).
 */
const tagOnlyShape = {
  tag: z
    .array(z.string())
    .optional()
    .describe(
      `Filter by tag (${REF_FORMAT}); repeat to AND several tags. Matches a direct, ` +
        "container-inherited, or descendant tag (in a container tool the container's own " +
        "inherited tags are ignored — the tag must be on the item itself)",
    ),
  exact_tag: z
    .boolean()
    .optional()
    .describe("Match only the named tag(s), not their nested children"),
  untagged: z
    .boolean()
    .optional()
    .describe(
      "Only items with no tag (direct or inherited); not combinable with tag/exact_tag " +
        "(in a container tool: no tag on the item itself, ignoring inherited tags)",
    ),
};

const tagFilterShape = {
  ...tagOnlyShape,
  overdue: z
    .boolean()
    .optional()
    .describe("Only open items past their deadline (due today is not overdue)"),
};

/** The parsed shape of the three tag-filter inputs on any tag-accepting tool. */
interface TagArgs {
  tag?: string[] | undefined;
  exact_tag?: boolean | undefined;
  untagged?: boolean | undefined;
}

/**
 * Map the MCP tool's snake_case tag inputs onto the shared {@link TagPresence}
 * shape (canonical CLI-flag spelling) so the one set of contract predicates —
 * {@link hasTagPresence}, {@link tagFlagConflict}, {@link tagFilterFields},
 * {@link validateViewArgs} — serves both surfaces. The only difference is
 * `exact_tag` → `exactTag`.
 */
function tagPresence(args: TagArgs): TagPresence {
  return {
    ...(args.tag !== undefined && { tag: args.tag }),
    ...(args.exact_tag !== undefined && { exactTag: args.exact_tag }),
    ...(args.untagged !== undefined && { untagged: args.untagged }),
  };
}

/** The MCP-voiced usage copy for the tag-filter mutual-exclusivity conflict. */
const MCP_UNTAGGED_CONFLICT = "untagged does not combine with tag/exact_tag";

const dryRunShape = {
  dry_run: z.boolean().optional().describe("Preview the planned change without applying anything"),
};

/** How a tag value may be expressed on any tag-accepting tool. */
const TAG_REF_FORMAT =
  "each a tag name or a parent/child path; must exist unless create_tags is set";

/** create_tags param, shared by every tag-accepting write tool. */
const createTagsShape = {
  create_tags: z
    .boolean()
    .optional()
    .describe(
      "Create any named tag that does not exist yet (nesting parent/child) before applying, " +
        "instead of stopping on an unknown tag",
    ),
};

const containerRef = (ref: string): { uuid: string; title: string } => ({ uuid: ref, title: ref });

/** Cap on project titles inlined into the server instructions. */
const INSTRUCTIONS_MAX_PROJECTS = 100;

/** A tag's display label: nested tags show `parent > child`. */
const tagLabel = (t: { title: string; parent: string | null }): string =>
  t.parent === null ? t.title : `${t.parent} > ${t.title}`;

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
      `are ${REMINDER_FORMAT}. Resolve relative calendar phrases against the Calendar context ` +
      `below (or a date-sensitive read result's meta.clock.today), then pass the explicit date.`,
    "- Every write tool accepts dry_run: true to preview the change without applying it. " +
      "A preview creates no state, so later calls cannot reference an item that only appeared in " +
      "a dry-run result. Operations with cascading or permanent effects require the explicit " +
      "confirmation parameter named in their description; refused calls return an error saying " +
      "what to pass.",
    "- Read-result semantics: an item's tags are its direct tags; its effective tags also include " +
      "tags inherited from its containing project and area. todaySection appears only for an item " +
      "in Today, naming its section there (today or evening); an unscheduled start=active item is " +
      "in Anytime and omits the field. Completing an item makes it findable in Logbook.",
    "- For capped reads, pass limit to cap rows or all: true for everything; if both are set, all wins.",
    `- Read results are compact: ${OMIT_EMPTY_NOTE}`,
  ];
  try {
    const c = getClient();
    const areas = c.read.areas();
    const tags = c.read.tags();
    const projects = c.read.projects();
    const clock = c.clockMeta();
    const shown = projects.slice(0, INSTRUCTIONS_MAX_PROJECTS);
    const overflow = projects.length - shown.length;
    lines.push(
      "",
      "Current inventory (read at server start — refresh with list_collections):",
      ...(clock !== undefined
        ? [`- Calendar context at server start: ${JSON.stringify(clock)}`]
        : []),
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

/**
 * Derive the audit author for a client's writes from the MCP initialize
 * handshake's clientInfo.name: lowercased, every run of non-alphanumerics
 * collapsed to a single "-", leading/trailing dashes trimmed, capped at 32
 * characters. An absent (or empty-after-sanitizing) client name falls back to
 * the bare "mcp". The result is never caller-settable — it is the connecting
 * client's own identity, so each client's writes are attributed to it.
 */
const MCP_ACTOR_PREFIX = "mcp";
function deriveMcpActor(clientName: string | undefined): string {
  const slug = (clientName ?? "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 32)
    .replaceAll(/-+$/g, "");
  return slug === "" ? MCP_ACTOR_PREFIX : `${MCP_ACTOR_PREFIX}:${slug}`;
}

/** The shape of the shared MCP write-tool args mapped into WriteOptions. */
interface WriteOptionArgs {
  dry_run?: boolean | undefined;
  verify_timeout_ms?: number | undefined;
  acknowledge_checklist_reset?: boolean | undefined;
  acknowledge_project_reopen?: boolean | undefined;
  dangerously_permanent?: boolean | undefined;
  acknowledge_tag_subtree?: boolean | undefined;
  dangerously_drive_gui?: boolean | undefined;
  create_tags?: boolean | undefined;
  /** Per-call IANA zone (write tools that accept `when`): normalizes today/evening to the zone. */
  tz?: string | undefined;
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

  // The audit author for every write on this connection, derived once from the
  // client's handshake identity (clientInfo.name). Read per call: clientInfo is
  // populated when the initialize handshake completes, before any tool can run.
  // Not caller-settable — no tool argument overrides it.
  const mcpActor = (): string => deriveMcpActor(server.server.getClientVersion()?.name);

  /** Translate the shared MCP write-tool args into pipeline WriteOptions. */
  const writeOptions = (args: WriteOptionArgs): WriteOptions => ({
    actor: mcpActor(),
    ...(options.maxDisruption !== undefined && { maxDisruption: options.maxDisruption }),
    ...(args.dry_run === true && { dryRun: true }),
    ...(args.verify_timeout_ms !== undefined && { verifyTimeoutMs: args.verify_timeout_ms }),
    ...(args.acknowledge_checklist_reset === true && { acknowledgeChecklistReset: true }),
    ...(args.acknowledge_project_reopen === true && { acknowledgeProjectReopen: true }),
    ...(args.dangerously_permanent === true && { dangerouslyPermanent: true }),
    ...(args.acknowledge_tag_subtree === true && { acknowledgeTagSubtree: true }),
    ...(args.dangerously_drive_gui === true && { dangerouslyDriveGui: true }),
    ...(args.create_tags === true && { createTags: true }),
    ...(args.tz !== undefined && { zone: args.tz }),
  });

  /** Run a handler, mapping environment/usage throws to tool errors. */
  const guard = async (fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> => {
    try {
      return await fn();
    } catch (err) {
      // An unresolved reference (ambiguous or not-found uuid/partial-uuid/name)
      // carries machine-readable candidates so a consumer can disambiguate as
      // data, not by re-parsing the prose message.
      if (err instanceof ReferenceResolutionError) {
        return errorResult({
          code: err.code,
          message: err.message,
          details: { candidates: err.candidates },
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof RangeError ? "usage" : "environment";
      return errorResult({ code, message });
    }
  };

  /**
   * A read handler wrapper: run through {@link guard}, then — on a successful
   * result — append a meta block carrying any non-blocking schema warning (the
   * same note the CLI prints), so a consumer sees when the Things database no
   * longer matches the validated schema and its data may be incomplete. No
   * block is added when the schema checks out or the read itself errored.
   */
  const readGuard = async (
    fn: () => Promise<ToolResult> | ToolResult,
    tz?: string,
  ): Promise<ToolResult> => {
    const result = await guard(fn);
    if (result.isError === true) return result;
    let warnings: string[] = [];
    let clock: ReturnType<ThingsClient["clockMeta"]>;
    try {
      const c = getClient();
      warnings = schemaWarnings(c.schemaStatus());
      // The clock honesty field for this call's effective zone (the per-call
      // tz over the server default) — present only when a consumer zone /
      // pinned now is in effect.
      clock = c.clockMeta(tz);
    } catch {
      warnings = [];
    }
    const meta = {
      ...(warnings.length > 0 && { warnings }),
      ...(clock !== undefined && { clock }),
    };
    if (Object.keys(meta).length === 0) return result;
    return {
      ...result,
      content: [...result.content, { type: "text", text: JSON.stringify({ meta }) }],
    };
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
        "anytime/someday return sections in canonical order (area + items; null area = the " +
        "top-level block); children of someday/future-scheduled projects are excluded " +
        "from anytime — the project row represents them; someday lists each group's " +
        "project rows before its to-dos. Flat views (today/inbox/upcoming/logbook/trash) " +
        `return at most ${DEFAULT_LIST_LIMIT} items by default (raise with limit); ` +
        "anytime/someday always return every group and cap per block instead — " +
        `area_limit (default ${AREA_PREVIEW_LIMIT}) per area block, and on anytime ` +
        `project_limit (default ${PROJECT_PREVIEW_LIMIT}) per project block. ` +
        "all: true lifts every cap; the result's second block reports the counts. " +
        OMIT_EMPTY_NOTE,
      inputSchema: {
        view: z.enum(["today", "inbox", "anytime", "upcoming", "someday", "logbook", "trash"]),
        ...tagFilterShape,
        ...tzShape,
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
          .describe(`flat views only (not anytime/someday): ${LIMIT_DESC}; ${LIMIT_IGNORED_NOTE}`),
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
            "show everything (flat views: no row limit; anytime/someday: no per-block caps); " +
              ALL_WINS_NOTE,
          ),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      readGuard(() => {
        const badZone = badTz(args.tz);
        if (badZone !== null) return badZone;
        // Tag-conflict AND overdue-applicability both derive from the shared
        // contract: read_view honors overdue only on today/inbox/anytime/someday
        // (the current-work views), matching FILTER_CONTRACT.
        const validated = validateViewArgs(
          args.view as ViewName,
          { ...tagPresence(args), overdue: args.overdue },
          {
            untaggedConflict: MCP_UNTAGGED_CONFLICT,
            overdueRejected: `overdue applies to today/inbox/anytime/someday, not ${args.view}`,
            overdueStatusWiden: "",
          },
        );
        if (!validated.ok) return usage(validated.message);
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
        const areaLimit = resolveCap(args.area_limit, args.all, AREA_PREVIEW_LIMIT);
        const projectLimit = resolveCap(args.project_limit, args.all, PROJECT_PREVIEW_LIMIT);
        if (areaLimit === "conflict" || projectLimit === "conflict") {
          return usage("pass at most one of area_limit/project_limit / all");
        }
        const c = getClient();
        const filter = validated.filter;
        const zone = args.tz !== undefined ? { zone: args.tz } : {};
        switch (args.view) {
          case "today": {
            const { view, truncation } = c.read.today({
              ...filter,
              ...zone,
              ...(args.evening === true && { eveningOnly: true }),
              limit,
            });
            return truncatedResult(view, truncation);
          }
          case "inbox": {
            const { items, truncation } = c.read.inbox({ ...filter, ...zone, limit });
            return truncatedResult(items, truncation);
          }
          case "anytime": {
            const { view, grouped } = c.read.anytime({
              ...filter,
              ...zone,
              areaLimit,
              projectLimit,
            });
            return groupedResult(view, grouped);
          }
          case "upcoming": {
            const { items, truncation } = c.read.upcoming({
              ...filter,
              ...zone,
              ...(args.horizon !== undefined && { horizon: args.horizon }),
              limit,
            });
            return truncatedResult(items, truncation);
          }
          case "someday": {
            const active = showActiveProjectItems;
            if (typeof active === "number" && args.all === true) {
              return usage("pass at most one of a numeric show_active_project_items / all");
            }
            const { view, grouped } = c.read.someday({
              ...filter,
              ...zone,
              ...((active === true || typeof active === "number") && {
                activeProjectItems: true,
              }),
              areaLimit,
              // true = every item per project; a number caps each list.
              projectLimit: typeof active === "number" ? active : null,
            });
            return groupedResult(view, grouped);
          }
          case "logbook": {
            const { items, truncation } = c.read.logbook({ ...filter, ...zone, limit });
            return truncatedResult(items, truncation);
          }
          case "trash": {
            const { items, truncation } = c.read.trash({ ...zone, limit });
            return truncatedResult(items, truncation);
          }
        }
      }, args.tz),
  );

  server.registerTool(
    "search",
    {
      description:
        "Find items by title/notes substring. Returns open, untrashed items by default; " +
        "include more with logged/trashed/all. Scope with project/area/tag — scope " +
        "references must name existing items. " +
        OMIT_EMPTY_NOTE,
      inputSchema: {
        query: z.string(),
        ...tagFilterShape,
        ...tzShape,
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
          .describe(
            `Everything, unbounded: open + logged + trashed, no row limit; ${ALL_WINS_NOTE}`,
          ),
        limit: z.number().int().min(1).optional().describe(`${LIMIT_DESC}; ${LIMIT_IGNORED_NOTE}`),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      readGuard(() => {
        const badZone = badTz(args.tz);
        if (badZone !== null) return badZone;
        // Tag-conflict AND the overdue/status-widening incompatibility both
        // derive from the shared contract (search: statusWidening = true).
        const validated = validateViewArgs(
          "search",
          {
            ...tagPresence(args),
            overdue: args.overdue,
            logged: args.logged,
            trashed: args.trashed,
            all: args.all,
          },
          {
            untaggedConflict: MCP_UNTAGGED_CONFLICT,
            overdueRejected: "overdue does not apply to search",
            overdueStatusWiden:
              "overdue lists open items; it does not combine with logged/trashed/all",
          },
        );
        if (!validated.ok) return usage(validated.message);
        const limit = resolveLimit(args);
        const { items, truncation } = getClient().read.search(args.query, {
          limit,
          ...validated.filter,
          ...(args.tz !== undefined && { zone: args.tz }),
          ...(args.project !== undefined && { project: args.project }),
          ...(args.area !== undefined && { area: args.area }),
          ...(args.type !== undefined && { type: args.type }),
          ...(args.logged === true && { logged: true }),
          ...(args.trashed === true && { trashed: true }),
          ...(args.all === true && { all: true }),
        });
        return truncatedResult(items, truncation);
      }, args.tz),
  );

  server.registerTool(
    "changes_since",
    {
      description:
        "List items created or modified since a moment — including trashed, logged, and " +
        "repeating items (inspect each item's fields to tell them apart). Edits to tags, " +
        "areas, and checklist items do not mark the containing item as modified. " +
        OMIT_EMPTY_NOTE,
      inputSchema: {
        since: z.string().describe("ISO date-time, e.g. 2026-07-06T08:00:00"),
        ...limitShape,
        ...tzShape,
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      readGuard(() => {
        const badZone = badTz(args.tz);
        if (badZone !== null) return badZone;
        const limit = resolveLimit(args);
        const since = new Date(args.since);
        if (Number.isNaN(since.getTime())) {
          return usage(`since is not a parseable date: ${args.since}`);
        }
        const { items, truncation } = getClient().read.changes({
          since,
          limit,
          ...(args.tz !== undefined && { zone: args.tz }),
        });
        return truncatedResult(items, truncation);
      }, args.tz),
  );

  server.registerTool(
    "get_item",
    {
      description:
        "Full detail for one item by uuid: notes, schedule, reminder, deadline, tags " +
        "(direct and inherited), checklist with per-item state, repeat schedule, and its " +
        "project/area/heading. " +
        OMIT_EMPTY_NOTE,
      inputSchema: { uuid: z.string() },
      annotations: READ_ONLY,
    },
    async (args) =>
      readGuard(() => {
        const item = getClient().read.byUuid(args.uuid);
        return item === null
          ? errorResult({ code: "not-found", message: noUuidMatch("item", args.uuid) })
          : readResult(item);
      }),
  );

  server.registerTool(
    "get_project",
    {
      description:
        "One project's full contents: metadata plus its to-dos grouped under their headings. " +
        "The tag filters keep only the child to-dos matching by their own tags (a heading left " +
        "with none is dropped). " +
        OMIT_EMPTY_NOTE,
      inputSchema: {
        uuid: z.string().describe("Project uuid or unique name"),
        ...tagOnlyShape,
        ...tzShape,
        overdue: z
          .boolean()
          .optional()
          .describe(
            "Keep only child to-dos past their deadline (due today is not overdue); headings left empty are dropped",
          ),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      readGuard(() => {
        const badZone = badTz(args.tz);
        if (badZone !== null) return badZone;
        if (tagFlagConflict(tagPresence(args))) return usage(MCP_UNTAGGED_CONFLICT);
        return readResult(
          getClient().read.projectView(args.uuid, {
            overdue: args.overdue === true,
            ...tagFilterFields(tagPresence(args)),
            ...(args.tz !== undefined && { zone: args.tz }),
          }),
        );
      }, args.tz),
  );

  server.registerTool(
    "get_area",
    {
      description:
        "One area's contents: metadata plus its direct to-dos (active first), its " +
        "projects in canonical order, later (scheduled/repeating/someday), and logged items. " +
        `The project-rows and direct-to-dos sections are capped at ${AREA_PREVIEW_LIMIT} each ` +
        "by default (project_limit / area_limit adjust them; all: true lifts both); the " +
        "second result block reports the counts. " +
        OMIT_EMPTY_NOTE,
      inputSchema: {
        ref: z.string().describe("Area uuid or unique name"),
        ...tagOnlyShape,
        ...tzShape,
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
        overdue: z
          .boolean()
          .optional()
          .describe(
            "Keep only rows (loose to-dos AND child projects) whose own deadline is past (due today is not overdue); no descent into project contents",
          ),
        all: z.boolean().optional().describe("return both sections in full (no caps)"),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      readGuard(() => {
        const badZone = badTz(args.tz);
        if (badZone !== null) return badZone;
        if (tagFlagConflict(tagPresence(args))) return usage(MCP_UNTAGGED_CONFLICT);
        const areaLimit = resolveCap(args.area_limit, args.all, AREA_PREVIEW_LIMIT);
        const projectLimit = resolveCap(args.project_limit, args.all, AREA_PREVIEW_LIMIT);
        if (areaLimit === "conflict" || projectLimit === "conflict") {
          return usage("pass at most one of area_limit/project_limit / all");
        }
        const { view, grouped } = getClient().read.areaView(args.ref, {
          overdue: args.overdue === true,
          ...tagFilterFields(tagPresence(args)),
          ...(args.tz !== undefined && { zone: args.tz }),
          areaLimit,
          projectLimit,
        });
        return groupedResult(view, grouped);
      }, args.tz),
  );

  server.registerTool(
    "list_collections",
    {
      description:
        "List every project, area, or tag (tags include their parent-tag nesting). Use to " +
        "refresh the inventory summarized in the server instructions. The tag filters scope " +
        "the projects list by each project's own tags (areas/tags reject them). " +
        OMIT_EMPTY_NOTE,
      inputSchema: {
        kind: z.enum(["projects", "areas", "tags"]),
        ...tagOnlyShape,
        ...tzShape,
        overdue: z
          .boolean()
          .optional()
          .describe(
            "projects only: keep only projects past their deadline (due today is not overdue); areas/tags carry no deadline and reject it",
          ),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      readGuard(() => {
        const badZone = badTz(args.tz);
        if (badZone !== null) return badZone;
        const c = getClient();
        // areas/tags are not dated entities and have no per-row tag list to
        // filter — overdue and the tag filters are vacuous there, rejected
        // fail-closed (the same style read_view uses for the wrong views). The
        // decision derives from the contract: only the `projects` list carries
        // a deadline (overdue) and per-row (inheritance-inclusive) tags; the
        // `areas` list rejects both, and `tags` has no contract row.
        const kindSpec =
          args.kind === "projects"
            ? FILTER_CONTRACT.projects
            : args.kind === "areas"
              ? FILTER_CONTRACT.areas
              : null;
        if (args.overdue === true && (kindSpec === null || !kindSpec.overdue)) {
          return usage(`overdue applies only to projects, not ${args.kind}`);
        }
        if (
          (kindSpec === null || kindSpec.tag === "rejected") &&
          (hasTagPresence(tagPresence(args)) || args.untagged === true)
        ) {
          return usage(`the tag filters apply only to projects, not ${args.kind}`);
        }
        if (tagFlagConflict(tagPresence(args))) return usage(MCP_UNTAGGED_CONFLICT);
        return readResult(
          args.kind === "projects"
            ? c.read.projects({
                overdue: args.overdue === true,
                ...tagFilterFields(tagPresence(args)),
                ...(args.tz !== undefined && { zone: args.tz }),
              })
            : args.kind === "areas"
              ? c.read.areas()
              : c.read.tags(),
        );
      }, args.tz),
  );

  // ---------------------------------------------------------------- to-dos

  const whenSchema = z.string().optional().describe(WHEN_VALUES);

  server.registerTool(
    "add_todo",
    {
      description:
        "Create a to-do and return its uuid. Optionally schedule it, set a reminder or " +
        "deadline, tag it, give it a checklist, and place it in a project or area " +
        "(optionally under an existing heading). A reminder " +
        "requires when = today, evening, or a date. Adding into a completed or canceled " +
        "project reopens that project — pass acknowledge_project_reopen to confirm.",
      inputSchema: {
        title: z.string(),
        notes: z.string().optional(),
        when: whenSchema,
        reminder: z.string().optional().describe(REMINDER_FORMAT),
        deadline: z.string().optional().describe(DATE_FORMAT),
        tags: z.array(z.string()).optional().describe(`Tags — ${TAG_REF_FORMAT}`),
        checklist_items: z.array(z.string()).optional(),
        project: z.string().optional().describe(`Destination project (${REF_FORMAT})`),
        area: z.string().optional().describe(`Destination area (${REF_FORMAT})`),
        heading: z.string().optional().describe("Existing heading in the destination project"),
        acknowledge_project_reopen: z
          .boolean()
          .optional()
          .describe("Confirm adding into a completed/canceled project (this reopens it)"),
        ...createTagsShape,
        ...tzShape,
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        const badZone = badTz(args.tz);
        if (badZone !== null) return badZone;
        const sugar = splitWhenSugar(args.when, args.reminder !== undefined, MCP_WHEN_LABELS);
        if (sugar.kind === "error") return usage(sugar.message);
        const when = sugar.kind === "split" ? sugar.when : args.when;
        const reminder = sugar.kind === "split" ? sugar.reminder : args.reminder;
        return mutationResult(
          await getClient().write.addTodo(
            {
              title: args.title,
              ...(args.notes !== undefined && { notes: args.notes }),
              ...(when !== undefined && { when: when as never }),
              ...(reminder !== undefined && { reminder }),
              ...(args.deadline !== undefined && { deadline: args.deadline }),
              ...(args.tags !== undefined && { tags: args.tags }),
              ...(args.checklist_items !== undefined && { checklistItems: args.checklist_items }),
              ...(args.project !== undefined && { project: containerRef(args.project) }),
              ...(args.area !== undefined && { area: containerRef(args.area) }),
              ...(args.heading !== undefined && { heading: args.heading }),
            },
            writeOptions(args),
          ),
        );
      }),
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
        ...tzShape,
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        const badZone = badTz(args.tz);
        if (badZone !== null) return badZone;
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
        const sugar = splitWhenSugar(args.when, args.reminder !== undefined, MCP_WHEN_LABELS);
        if (sugar.kind === "error") return usage(sugar.message);
        const when = sugar.kind === "split" ? sugar.when : args.when;
        const reminder = sugar.kind === "split" ? sugar.reminder : args.reminder;
        return mutationResult(
          await getClient().write.updateTodo(
            args.uuid,
            {
              ...(args.title !== undefined && { title: args.title }),
              ...(args.notes !== undefined && { notes: args.notes }),
              ...(args.append_notes !== undefined && { appendNotes: args.append_notes }),
              ...(args.prepend_notes !== undefined && { prependNotes: args.prepend_notes }),
              ...(when !== undefined && { when: when as never }),
              ...(reminder !== undefined && { reminder }),
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
        "tags. Tags must exist unless create_tags is set (or create them first with add_tag).",
      inputSchema: {
        uuid: z.string(),
        tags: z.array(z.string()).describe(`Tags — ${TAG_REF_FORMAT}`),
        mode: z.enum(["replace", "add"]).optional().describe("Default: replace"),
        ...createTagsShape,
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
  const WEEKDAY_ENUM = z.enum([
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ]);
  // The base rule (also used by create_repeating_project, which stays minimal —
  // its own `deadline` is the project's due DATE, not the repeat's Add-deadlines).
  const baseRepeatShape = {
    frequency: z.enum(["daily", "weekly", "monthly", "yearly"]).describe("How often it repeats"),
    interval: z.number().int().min(1).max(99).describe("Every N units (1–99)"),
  };
  const repeatRuleShape = {
    ...baseRepeatShape,
    after_completion: z
      .boolean()
      .optional()
      .describe(
        "Repeat N units AFTER each occurrence is completed, instead of on a fixed schedule",
      ),
    weekdays: z.array(WEEKDAY_ENUM).optional().describe("Weekly only: the weekdays it repeats on"),
    monthly_day: z
      .union([z.number().int(), z.literal("last")])
      .optional()
      .describe('Monthly/yearly only: a day of the month (1–31, or "last")'),
    monthly_weekday: WEEKDAY_ENUM.optional().describe(
      "Monthly/yearly only: a weekday for an nth-weekday rule (with monthly_ordinal)",
    ),
    monthly_ordinal: z
      .union([z.number().int(), z.literal("last")])
      .optional()
      .describe('Monthly/yearly only: which weekday (1–5, or "last") with monthly_weekday'),
    yearly_month: z
      .number()
      .int()
      .min(1)
      .max(12)
      .optional()
      .describe("Yearly only: the month (1–12)"),
    ends_after: z.number().int().optional().describe("Stop after N occurrences"),
    ends_on: z.string().optional().describe("YYYY-MM-DD — stop after this date"),
    reminder: z.string().optional().describe("HH:mm — a reminder time on each occurrence"),
    deadline: z.boolean().optional().describe("Give each occurrence a deadline"),
    start_days_earlier: z
      .number()
      .int()
      .optional()
      .describe("With deadline: start each occurrence N days before its deadline"),
  };

  /** Map the flat repeat-rule args to the extended fields (present keys only). */
  type RepeatArgs = {
    after_completion?: boolean | undefined;
    weekdays?: Weekday[] | undefined;
    monthly_day?: number | "last" | undefined;
    monthly_weekday?: Weekday | undefined;
    monthly_ordinal?: number | "last" | undefined;
    yearly_month?: number | undefined;
    ends_after?: number | undefined;
    ends_on?: string | undefined;
    reminder?: string | undefined;
    deadline?: boolean | undefined;
    start_days_earlier?: number | undefined;
  };
  // oxlint-disable-next-line consistent-function-scoping -- kept beside repeatRuleShape it mirrors
  const repeatExtras = (
    a: RepeatArgs,
    frequency: RepeatFrequency,
  ): Omit<RepeatRuleParams, "uuid" | "frequency" | "interval"> => {
    const fields: Omit<RepeatRuleParams, "uuid" | "frequency" | "interval"> = {};
    if (a.after_completion === true) fields.afterCompletion = true;
    if (a.weekdays !== undefined) fields.weekdays = a.weekdays;
    const anchor: MonthlyAnchor | undefined =
      a.monthly_day !== undefined
        ? { day: a.monthly_day }
        : a.monthly_weekday !== undefined || a.monthly_ordinal !== undefined
          ? ({ weekday: a.monthly_weekday, ordinal: a.monthly_ordinal } as MonthlyAnchor)
          : undefined;
    if (frequency === "monthly" && anchor !== undefined) fields.monthly = anchor;
    if (frequency === "yearly" && (a.yearly_month !== undefined || anchor !== undefined)) {
      fields.yearly = { month: a.yearly_month, ...anchor } as YearlyAnchor;
    }
    if (a.ends_after !== undefined) fields.ends = { kind: "after", count: a.ends_after };
    else if (a.ends_on !== undefined) fields.ends = { kind: "on-date", date: a.ends_on };
    if (a.reminder !== undefined) fields.reminder = a.reminder;
    if (a.deadline === true) fields.deadline = true;
    if (a.start_days_earlier !== undefined) fields.startDaysEarlier = a.start_days_earlier;
    return fields;
  };

  server.registerTool(
    "make_repeating",
    {
      description:
        "Turn a plain to-do into a repeating one. This REPLACES the to-do with a new recurring " +
        "series — the original disappears and a fresh repeating item takes its place, so it " +
        "cannot be undone. Set the frequency and interval, and optionally the weekday set, " +
        "monthly/yearly day, end bound, reminders, or deadline. Returns the new item's uuid.",
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
            {
              uuid: args.uuid,
              frequency: args.frequency,
              interval: args.interval,
              ...repeatExtras(args, args.frequency),
            },
            writeOptions(args),
          ),
        ),
      ),
  );

  server.registerTool(
    "reschedule_repeat",
    {
      description:
        "Change a repeating to-do's rule in place, keeping the same item. Set the frequency and " +
        "interval, and optionally the weekday set, monthly/yearly day, end bound, reminders, or " +
        "deadline. This can be undone — it restores the previous rule.",
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
            {
              uuid: args.uuid,
              frequency: args.frequency,
              interval: args.interval,
              ...repeatExtras(args, args.frequency),
            },
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
        "Change a repeating project's rule in place, keeping the same project. Set the frequency " +
        "and interval, and optionally the weekday set, monthly/yearly day, end bound, reminders, " +
        "or deadline. This can be undone — it restores the previous rule.",
      inputSchema: {
        uuid: z.string().describe(`The repeating project to reschedule (${REF_FORMAT})`),
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
            {
              uuid: args.uuid,
              frequency: args.frequency,
              interval: args.interval,
              ...repeatExtras(args, args.frequency),
            },
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
        uuid: z.string().describe(`The repeating project (${REF_FORMAT})`),
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
    "reorder_area",
    {
      description:
        "Move an area to a new position in the area order. Give the area plus exactly one " +
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
            "area.reorder",
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
        "moved to Someday first (a cleanup-free intermediate step, shown by dry_run). Set the " +
        "frequency and interval, and optionally the weekday set, monthly/yearly day, end bound, " +
        "reminders, or deadline. Returns the new project's uuid.",
      inputSchema: {
        uuid: z.string().describe(`The project to make repeating (${REF_FORMAT})`),
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
            {
              frequency: args.frequency,
              interval: args.interval,
              ...repeatExtras(args, args.frequency),
            },
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
        ...baseRepeatShape,
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
        ...tzShape,
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        const badZone = badTz(args.tz);
        if (badZone !== null) return badZone;
        return mutationResult(
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
        );
      }),
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
        uuid: z.string().describe(`The project to update (${REF_FORMAT})`),
        title: z.string().optional(),
        notes: z.string().optional().describe("Replaces the whole notes body"),
        append_notes: z.string().optional(),
        prepend_notes: z.string().optional(),
        when: whenSchema,
        reminder: z.string().optional().describe(REMINDER_FORMAT),
        clear_reminder: z.boolean().optional(),
        deadline: z.string().optional().describe(DATE_FORMAT),
        clear_deadline: z.boolean().optional(),
        ...tzShape,
        ...dryRunShape,
      },
      annotations: NON_DESTRUCTIVE,
    },
    async (args) =>
      guard(async () => {
        const badZone = badTz(args.tz);
        if (badZone !== null) return badZone;
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
        uuid: z.string().describe(`The project (${REF_FORMAT})`),
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
        uuid: z.string().describe(`The project to move (${REF_FORMAT})`),
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
      description: "Create an area, optionally tagged. Tags must exist unless create_tags is set.",
      inputSchema: {
        title: z.string(),
        tags: z.array(z.string()).optional().describe(`Tags — ${TAG_REF_FORMAT}`),
        ...createTagsShape,
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
        "Rename an area and/or replace its tags (the full set). Tags must exist unless " +
        "create_tags is set.",
      inputSchema: {
        target: z.string().describe(`Area to update (${REF_FORMAT})`),
        title: z.string().optional().describe("New name"),
        tags: z
          .array(z.string())
          .optional()
          .describe(`Tags (full replacement) — ${TAG_REF_FORMAT}`),
        ...createTagsShape,
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
                  acknowledge_checklist_reset: z.boolean().optional(),
                  acknowledge_project_reopen: z.boolean().optional(),
                  dangerously_permanent: z.boolean().optional(),
                  acknowledge_tag_subtree: z.boolean().optional(),
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
        // Map each op's snake_case acknowledgements into the batch engine's
        // option names, and apply the process-wide disruption ceiling — batch
        // takes it per-op, and MCP exposes no per-op override, so it is uniform.
        const ceiling = options.maxDisruption;
        const ops: BatchOp[] = args.ops.map((op) => {
          const o = op.options;
          const opts: NonNullable<BatchOp["options"]> = {
            ...(o?.acknowledge_checklist_reset === true && { acknowledgeChecklistReset: true }),
            ...(o?.acknowledge_project_reopen === true && { acknowledgeProjectReopen: true }),
            ...(o?.dangerously_permanent === true && { dangerouslyPermanent: true }),
            ...(o?.acknowledge_tag_subtree === true && { acknowledgeTagSubtree: true }),
            ...(ceiling !== undefined && { maxDisruption: ceiling }),
          };
          return {
            op: op.op as OperationKind,
            params: op.params,
            ...(Object.keys(opts).length > 0 && { options: opts }),
          };
        });
        const results = await getClient().write.batch(ops, {
          ...(args.dry_run === true && { dryRun: true }),
          ...(args.fail_fast === true && { failFast: true }),
          actor: mcpActor(),
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
        "their heading), an area, or the top-level projects (scope=projects — " +
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
        "connection — this client's own writes; it will not touch the user's own edits, or " +
        'another client\'s, unless you pass by="*" (all authors) or a specific author name; ' +
        "pass a txn token to undo one exact change. Some changes cannot be reversed — " +
        "permanent deletions, or changes whose prior state is unknown — and are reported as " +
        "irreversible; a to-do brought back from an undone delete returns to the Inbox " +
        "without its schedule. Undoing the creation of an area or tag deletes it " +
        "permanently — requires dangerously_permanent. An undo is refused when the item " +
        "changed outside this interface since (its list or project, status, schedule, " +
        "trashed state, or a field like the title moved) — pass " +
        "acknowledge_out_of_band_changes to overwrite it anyway.",
      inputSchema: {
        last: z.number().int().min(1).optional().describe("How many to unwind (default 1)"),
        by: z
          .string()
          .optional()
          .describe(
            'Whose changes to undo: an exact author name, or "*" for everyone. Defaults to ' +
              "this client's own writes (only changes made through this connection). Matches " +
              "exactly. Selects WHICH changes to undo, and never a change already undone. Not " +
              "combinable with txn.",
          ),
        txn: z
          .string()
          .optional()
          .describe(
            "Undo exactly the one change with this undo token (the undoToken field returned " +
              "by the mutation); immune to interleaving. Not combinable with last/by.",
          ),
        dangerously_permanent: z.boolean().optional(),
        acknowledge_out_of_band_changes: z
          .boolean()
          .optional()
          .describe(
            "Proceed even when the item changed outside this interface since (in the Things app " +
              "or by another tool) — overwrites whatever the out-of-band change left, instead of " +
              "refusing.",
          ),
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
          // Asymmetric default: agents must not clobber the user's own edits (or
          // another client's) without explicitly opting in via by:"*". Scoped to
          // this client's own handshake identity, so each session undoes its own.
          ...(args.txn === undefined && { by: args.by ?? mcpActor() }),
          ...(args.dry_run === true && { dryRun: true }),
          ...(args.dangerously_permanent === true && { dangerouslyPermanent: true }),
          ...(args.acknowledge_out_of_band_changes === true && {
            acknowledgeOutOfBandChanges: true,
          }),
          actor: mcpActor(),
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
