/**
 * `things project show <uuid>` — the composite project view.
 */
import type { Command } from "commander";

import type { ProjectView } from "../../read/project-view.ts";
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
  const w = uuidDisplayWidth(everyItem);
  const fmt = (i: (typeof everyItem)[number]) => formatItem(i, w);
  const lines: string[] = [
    `${view.project.uuid}  ${view.project.title}`,
    `  area: ${view.project.area?.title ?? "—"}  open: ${view.project.openUntrashedLeafActionsCount}/${view.project.untrashedLeafActionsCount}`,
  ];
  lines.push("── Active ──", ...(view.active.length ? view.active.map(fmt) : ["(none)"]));
  for (const group of view.headings) {
    lines.push(
      `── ${group.heading.title} ──`,
      ...(group.items.length ? group.items.map(fmt) : ["(none)"]),
    );
  }
  if (view.later.scheduled.length || view.later.repeating.length || view.later.someday.length) {
    lines.push("── Later ──");
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
    lines.push(`── Logged (${view.logged.length}) ──`, ...view.logged.slice(0, 10).map(fmt));
  if (view.trashed.length) lines.push(`── Trashed (${view.trashed.length}) ──`);
  return lines;
}

export function registerProjectCommands(program: Command): void {
  const project = program.command("project").description("Project-scoped operations");
  project
    .command("show <uuid>")
    .description(
      "Composite project view mirroring the native UI: active items, headings, later (scheduled/repeating/someday), logged, trashed",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((uuid: string, opts: { json?: boolean; db?: string }) => {
      withClient(
        opts,
        "project-view",
        (c) => c.read.projectView(uuid),
        renderProjectView as (d: never) => string[],
      );
    });
}
