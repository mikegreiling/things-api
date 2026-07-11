/**
 * `things show <ref>` / `things open <ref>` — the loose routers: paste any
 * uuid (full or >=6-char prefix), share link, or area name copied from any
 * view, and get the right show view (or the Things GUI) without naming the
 * resource class. Headings route to their containing project; tags and
 * checklist items have no show view and are rejected.
 */
import type { Command } from "commander";

import type { AnyTask } from "../../model/entities.ts";
import type { AreaView } from "../../read/area-view.ts";
import type { ProjectView } from "../../read/project-view.ts";
import { renderAreaView, type AreaShowOpts } from "./area.ts";
import { renderProjectView } from "./project.ts";
import { renderDetail } from "./todo.ts";
import { openInThings, withClient } from "./reads.ts";

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
        "name. Tags and checklist items have no show view.",
    )
    .option("--show-later", "projects/areas: include scheduled, repeating, and someday rows")
    .option("--show-logged [n]", "projects/areas: include logged items (optionally capped at n)")
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((ref: string, opts: AreaShowOpts & { json?: boolean; db?: string }) => {
      withClient(
        opts,
        "show",
        (c): ShowPayload => {
          const t = c.read.showTarget(ref);
          if (t.kind === "project") return { type: "project", view: c.read.projectView(t.uuid) };
          if (t.kind === "area") return { type: "area", view: c.read.areaView(t.uuid) };
          return { type: "to-do", detail: c.read.byUuid(t.uuid) };
        },
        ((d: ShowPayload) =>
          d.type === "project"
            ? renderProjectView(d.view, opts)
            : d.type === "area"
              ? renderAreaView(d.view, opts)
              : renderDetail(d.detail)) as (d: never) => string[],
      );
    });

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
