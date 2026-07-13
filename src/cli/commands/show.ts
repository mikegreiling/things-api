/**
 * `things show <ref>` / `things open <ref>` — the loose routers: paste any
 * uuid (full or >=6-char prefix), share link, or area name copied from any
 * view, and get the right show view (or the Things GUI) without naming the
 * resource class. Headings route to their containing project; tags and
 * checklist items have no show view and are rejected.
 */
import { Option, type Command } from "commander";

import type { AnyTask } from "../../model/entities.ts";
import type { AreaView } from "../../read/area-view.ts";
import type { ProjectView } from "../../read/project-view.ts";
import { capAreaSections, type GroupedLimits } from "../../read/pagination.ts";
import { AREA_PREVIEW_LIMIT, GROUPED_ALL_DESC } from "../../surface-copy.ts";
import { renderAreaView, type AreaShowOpts } from "./area.ts";
import { renderProjectView, showToggleFlags } from "./project.ts";
import { renderDetail } from "./todo.ts";
import {
  invocation,
  openInThings,
  parseCap,
  runRead,
  shellQuote,
  VIEW_KEYWORDS,
  withClient,
} from "./reads.ts";

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
        "view's name). `things show inbox|today|anytime|upcoming|someday|logbook|trash` " +
        "opens those views.",
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
    .addOption(new Option("--via-shorthand").hideHelp())
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
          viaShorthand?: boolean;
        },
      ) => {
        if (opts.limit !== undefined) {
          process.stderr.write(
            "error: --limit is not available on show — areas cap per section with " +
              "--area-limit / --project-limit; project and to-do cards are uncapped\n",
          );
          process.exitCode = 2;
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
              // Bare-shorthand invocations (`things foo`) could equally be a
              // mistyped command — say so alongside the resolution failure.
              if (opts.viaShorthand === true && err instanceof Error) {
                throw new RangeError(`no command or item named "${ref}" — ${err.message}`);
              }
              throw err;
            }
            // Projects and to-do cards are uncapped: headings are true
            // containers, so no strict total limit applies.
            if (t.kind === "project") {
              const view = c.read.projectView(t.uuid);
              return { data: { type: "project", view }, lines: renderProjectView(view, opts) };
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
        "keyword wins over a same-named project or area (open those by uuid).",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((ref: string, opts: { json?: boolean; db?: string }) => {
      // View keywords launch things:///show?id=<keyword> directly (the URL
      // scheme accepts these ids natively) — no reference resolution.
      const keyword = VIEW_KEYWORDS.has(ref.toLowerCase()) ? ref.toLowerCase() : null;
      withClient(
        opts,
        "open",
        (c) => ({
          uri: keyword !== null ? openInThings(keyword) : openInThings(c.read.showTarget(ref).uuid),
        }),
        ((d: { uri: string }) => [`opened ${d.uri}`]) as (d: never) => string[],
      );
    });
}
