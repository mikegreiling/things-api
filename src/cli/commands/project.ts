/**
 * `things project show <uuid>` — the composite project view.
 */
import type { Command } from "commander";

import type { ProjectView } from "../../read/project-view.ts";
import { bold, dim, underline } from "../style.ts";
import { formatItem, uuidDisplayWidth, withClient } from "./reads.ts";

function renderProjectView(view: ProjectView): string[] {
  const everyItem = [
    ...view.active,
    ...view.headings.flatMap((g) => g.items),
    ...view.later.scheduled.flatMap((d) => d.items),
    ...view.later.repeating,
    ...view.later.someday,
    ...view.logged.slice(0, 10),
  ];
  const w = uuidDisplayWidth([...everyItem, ...view.headings.map((g) => g.heading)]);
  // Rows inside this view never repeat the project's own name.
  const fmt = (i: (typeof everyItem)[number]) =>
    formatItem(i, w, { suppressProject: view.project.uuid });
  const lines: string[] = [
    `${view.project.uuid}  ${bold(underline(view.project.title))}`,
    `  area: ${view.project.area?.title ?? "—"}  open: ${view.project.openUntrashedLeafActionsCount}/${view.project.untrashedLeafActionsCount}`,
  ];
  lines.push("", bold("── Active ──"), ...(view.active.length ? view.active.map(fmt) : ["(none)"]));
  for (const group of view.headings) {
    // Headings are the GUI's dim in-project subheads, not structural
    // sections — rendered like item rows (their uuid IS addressable:
    // heading rename/archive), title dim+underlined.
    lines.push(
      "",
      `${dim(group.heading.uuid.slice(0, w))}  ${dim(underline(group.heading.title))}`,
      ...(group.items.length ? group.items.map(fmt) : ["(none)"]),
    );
  }
  if (view.later.scheduled.length || view.later.repeating.length || view.later.someday.length) {
    lines.push("", bold("── Later ──"));
    for (const day of view.later.scheduled) {
      lines.push(`  ${day.date}:`, ...day.items.map(fmt));
    }
    if (view.later.repeating.length) {
      lines.push("  repeating templates:", ...view.later.repeating.map(fmt));
    }
    if (view.later.someday.length) {
      lines.push("  someday:", ...view.later.someday.map(fmt));
    }
  }
  if (view.logged.length)
    lines.push(
      "",
      bold(`── Logged (${view.logged.length}) ──`),
      ...view.logged.slice(0, 10).map(fmt),
    );
  if (view.trashed.length) lines.push("", bold(`── Trashed (${view.trashed.length}) ──`));
  return lines;
}

export function registerProjectCommands(program: Command): void {
  const project = program.command("project").description("Project-scoped operations");
  project
    .command("show <ref>")
    .description(
      "Composite project view mirroring the native UI: active items, headings, later (scheduled/repeating/someday), logged, trashed. Target by uuid or unique name.",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((ref: string, opts: { json?: boolean; db?: string }) => {
      withClient(
        opts,
        "project-view",
        (c) => c.read.projectView(ref),
        renderProjectView as (d: never) => string[],
      );
    });
}
