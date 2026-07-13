/**
 * `things show <ref>` / `things open <ref>` — the loose routers: paste any
 * uuid (full or >=6-char prefix), share link, or area name copied from any
 * view, and get the right show view (or the Things GUI) without naming the
 * resource class. Headings route to their containing project; tags and
 * checklist items have no show view and are rejected.
 */
import { type Command, Option } from "commander";

import type { AnyTask } from "../../model/entities.ts";
import type { AreaView } from "../../read/area-view.ts";
import { ExitCode } from "../../contracts.ts";
import type { ProjectView } from "../../read/project-view.ts";
import type { ShowTarget } from "../../read/show-target.ts";
import { capAreaSections, type GroupedLimits } from "../../read/pagination.ts";
import { stripThingsUri } from "../../read/queries.ts";
import { AREA_PREVIEW_LIMIT, GROUPED_ALL_DESC } from "../../surface-copy.ts";
import {
  getInvocation,
  OPEN_KEYWORDS,
  setInvocationCanonical,
  SHOW_KEYWORDS,
} from "../resolve-invocation.ts";
import { renderAreaView, type AreaShowOpts } from "./area.ts";
import { renderProjectView, showToggleFlags } from "./project.ts";
import { renderDetail } from "./todo.ts";
import { openInThings } from "./reads.ts";
import { invocation, parseCap, runRead, shellQuote, withClient } from "../read-driver.ts";
import { DidYouMeanError } from "../did-you-mean.ts";

/**
 * The canonical typed command a loose/bare reference resolved to, for the
 * normalized-form echo. Uses the resolved TYPE plus the reference the user
 * gave: a name stays a name (`things area show "Hobbies"`), a uuid prefix
 * stays that prefix (every typed show accepts prefixes), a share link is
 * stripped to its id, and a heading (resolved to its project) echoes the
 * project uuid so the command is runnable.
 */
function typedShowCommand(t: ShowTarget, ref: string, opts: ProjectShowFlags): string {
  const cmd = t.kind === "area" ? "area show" : t.kind === "project" ? "project show" : "todo show";
  const echoRef = t.viaHeading === true ? t.uuid : stripThingsUri(ref);
  // The loose router's --show-later/--show-logged toggles only apply to the
  // area/project cards — never echo them onto `todo show`, which lacks them.
  const flags = t.kind === "to-do" ? [] : showToggleFlags(opts);
  return invocation(cmd, [shellQuote(echoRef), ...flags]);
}

type ProjectShowFlags = { showLater?: boolean; showLogged?: boolean | string };

/**
 * The routing sugars whose canonical form is worth echoing: a verb-omitted
 * bare noun, or an opaque token (uuid prefix / share link) routed to a typed
 * card. A loose `show` given a plain NAME is not echoed — the verb is already
 * typed and the name is already on screen. A name that merely looks base-62
 * ("Firmware") won't prefix a random uuid, so the uuid-route test stays honest.
 */
function isRoutingSugar(t: ShowTarget, ref: string): boolean {
  if (getInvocation()?.form === "bare-noun") return true;
  const stripped = stripThingsUri(ref);
  if (stripped !== ref) return true; // a things:/// share link
  return /^[0-9A-Za-z]{6,}$/.test(stripped) && t.uuid.startsWith(stripped);
}

type ShowPayload =
  | { type: "project"; view: ProjectView }
  | { type: "area"; view: AreaView }
  | { type: "to-do"; detail: AnyTask | null };

export function registerShowCommands(program: Command): void {
  program
    .command("show <ref>")
    .description(
      "Render whatever the reference points at: a to-do, a project (a heading reference " +
        "shows its containing project), or an area. Accepts a uuid, a >=6-char uuid " +
        "prefix (as printed in every list view), a things:/// share link, or an area " +
        "name. Tags and checklist items have no show view. The word `show` may be " +
        "omitted: `things <ref>` works whenever <ref> is not a command name (command " +
        "names always win — `things area show <name>` targets an item that shares a " +
        "view's name). A list-view name is that view: " +
        "`things show inbox|today|anytime|upcoming|someday|logbook|trash|projects|areas|tags` " +
        "IS the matching list command.",
    )
    .option("--show-later", "projects/areas: include scheduled, repeating, and someday rows")
    .option("--show-logged [n]", "projects/areas: include logged items (optionally capped at n)")
    .option(
      "--project-limit <n>",
      `areas: maximum project rows to show (default ${AREA_PREVIEW_LIMIT})`,
    )
    .option(
      "--area-limit <n>",
      `areas: maximum direct to-dos to show (default ${AREA_PREVIEW_LIMIT})`,
    )
    .option("--all", `areas: ${GROUPED_ALL_DESC}`)
    .addOption(new Option("--limit <n>").hideHelp())
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action(
      (
        ref: string,
        opts: AreaShowOpts & {
          json?: boolean;
          db?: string;
          limit?: string;
          areaLimit?: string;
          projectLimit?: string;
          all?: boolean;
        },
      ) => {
        if (opts.limit !== undefined) {
          process.stderr.write(
            "error: --limit is not available on show — areas cap per section with " +
              "--area-limit / --project-limit; project and to-do cards are uncapped\n",
          );
          process.exitCode = ExitCode.Usage;
          return;
        }
        const areaCap = parseCap(
          "--area-limit",
          opts.areaLimit,
          AREA_PREVIEW_LIMIT,
          opts.all === true,
        );
        if (!areaCap.ok) return;
        const projectCap = parseCap(
          "--project-limit",
          opts.projectLimit,
          AREA_PREVIEW_LIMIT,
          opts.all === true,
        );
        if (!projectCap.ok) return;
        const limits: GroupedLimits = { area: areaCap.limit, project: projectCap.limit };
        const hintBase = invocation("show", [shellQuote(ref), ...showToggleFlags(opts)]);
        runRead<ShowPayload>(
          opts,
          "show",
          (c) => {
            let t: ReturnType<typeof c.read.showTarget>;
            try {
              t = c.read.showTarget(ref);
            } catch (err) {
              // An ambiguous reference lists its candidates — surface verbatim.
              if (err instanceof RangeError && err.message.includes("ambiguous")) throw err;
              if (!(err instanceof Error)) throw err;
              // Not-found: fall back to a lite title-search (did-you-mean),
              // untyped/mixed for the loose forms. A bare-noun invocation
              // (`things foo`) could equally be a mistyped command — say so.
              const message =
                getInvocation()?.form === "bare-noun"
                  ? `no command or item named "${ref}" — ${err.message}`
                  : err.message;
              throw new DidYouMeanError(message, ref, c.read.liteTitleSearch(ref));
            }
            // Record the canonical typed command for the echo + resolvedCommand,
            // but only for the routing sugars (a loose show by name is not one).
            if (isRoutingSugar(t, ref)) setInvocationCanonical(typedShowCommand(t, ref, opts));
            // Projects and to-do cards are uncapped: headings are true
            // containers, so no strict total limit applies.
            if (t.kind === "project") {
              const view = c.read.projectView(t.uuid);
              // --all reveals the project card's hidden later rows (charter),
              // matching `things project show … --all`.
              const projectOpts = {
                ...opts,
                showLater: opts.showLater === true || opts.all === true,
              };
              return {
                data: { type: "project", view },
                lines: renderProjectView(view, projectOpts),
              };
            }
            if (t.kind === "area") {
              const view = c.read.areaView(t.uuid);
              const { data, grouped } = capAreaSections(view, limits);
              return {
                data: { type: "area", view: data },
                grouped,
                lines: renderAreaView(view, { ...opts, limits, hintBase }),
              };
            }
            const detail = c.read.byUuid(t.uuid);
            return { data: { type: "to-do", detail }, lines: renderDetail(detail) };
          },
          () => [],
        );
      },
    );

  program
    .command("open <ref>")
    .description(
      "Open the referenced resource in the Things app — foregrounds the GUI on this Mac " +
        "(NOT headless). Resolves references exactly like `things show` (a heading " +
        "reference opens its containing project), and the view keywords " +
        "(inbox, today, anytime, upcoming, someday, logbook, trash) open that view — a " +
        "keyword wins over a same-named project or area (open those by uuid). The app " +
        "has no projects/areas/tags list screen, so those names are not openable — open " +
        "a specific one by ref.",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((ref: string, opts: { json?: boolean; db?: string }) => {
      const lower = ref.toLowerCase();
      // Open's vocabulary belongs to the app: only the seven URL-scheme ids
      // launch directly. The plural list-view names (projects/areas/tags) are
      // valid `show` keywords but have no app screen to open — reject them with
      // the fix, rather than resolving an item that happens to share the name.
      if (SHOW_KEYWORDS.has(lower) && !OPEN_KEYWORDS.has(lower)) {
        // `evening` is not a valid `things:///show?id=` id — the app has no
        // This Evening screen to foreground — so point at the CLI section
        // filter instead of a resource ref (as the plurals do).
        const message =
          lower === "evening"
            ? "the app has no This Evening screen to open — use `things today --evening`"
            : `the app has no ${lower} list to open — open a specific ${
                lower === "projects" ? "project" : lower === "areas" ? "area" : "item"
              }: \`things open <ref>\``;
        withClient(
          opts,
          "open",
          () => {
            throw new RangeError(message);
          },
          () => [],
        );
        return;
      }
      // A view keyword launches things:///show?id=<keyword> directly (the URL
      // scheme accepts these ids natively) — no reference resolution.
      const keyword = OPEN_KEYWORDS.has(lower) ? lower : null;
      withClient(
        opts,
        "open",
        (c) => ({
          uri: keyword !== null ? openInThings(keyword) : openInThings(c.read.showTarget(ref).uuid),
        }),
        (d) => [`opened ${d.uri}`],
      );
    });
}
