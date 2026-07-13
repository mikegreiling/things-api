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
import { capAreaView, capProjectView } from "../../read/pagination.ts";
import { ALL_DESC, LIMIT_DESC } from "../../surface-copy.ts";
import { renderAreaView, type AreaShowOpts } from "./area.ts";
import { renderProjectView, showToggleFlags } from "./project.ts";
import { renderDetail } from "./todo.ts";
import { invocation, openInThings, parseLimit, runRead, shellQuote, withClient } from "./reads.ts";

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
    .option("--limit <n>", `projects/areas: ${LIMIT_DESC}`)
    .option("--all", ALL_DESC)
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
          all?: boolean;
          viaShorthand?: boolean;
        },
      ) => {
        const lim = parseLimit(opts as { limit?: string; all?: boolean });
        if (!lim.ok) return;
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
            const detailOpts = { ...opts, limit: lim.limit, hintBase };
            if (t.kind === "project") {
              const view = c.read.projectView(t.uuid);
              const { data, pagination } = capProjectView(view, lim.limit);
              return {
                data: { type: "project", view: data },
                pagination,
                lines: renderProjectView(view, detailOpts),
              };
            }
            if (t.kind === "area") {
              const view = c.read.areaView(t.uuid);
              const { data, pagination } = capAreaView(view, lim.limit);
              return {
                data: { type: "area", view: data },
                pagination,
                lines: renderAreaView(view, detailOpts),
              };
            }
            // To-do cards are bounded content — the row cap does not apply.
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
        "reference opens its containing project).",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((ref: string, opts: { json?: boolean; db?: string }) => {
      withClient(opts, "open", (c) => ({ uri: openInThings(c.read.showTarget(ref).uuid) }), ((d: {
        uri: string;
      }) => [`opened ${d.uri}`]) as (d: never) => string[]);
    });
}
