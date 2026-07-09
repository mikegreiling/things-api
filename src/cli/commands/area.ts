/**
 * `things area show <ref>` — the composite area view (the write subcommands
 * under `things area` are registered by writes.ts on the same group).
 */
import type { Command } from "commander";

import type { AreaView } from "../../read/area-view.ts";
import { bold, dim } from "../style.ts";
import { formatItem, withClient } from "./reads.ts";

function renderAreaView(view: AreaView): string[] {
  const everyItem = [
    ...view.active,
    ...view.projects,
    ...view.later.scheduled.flatMap((d) => d.items),
    ...view.later.repeating,
    ...view.later.someday,
    ...view.logged.slice(0, 10),
  ];
  const w = everyItem.reduce((max, i) => Math.max(max, i.uuid.length), 0);
  const fmt = (i: (typeof everyItem)[number]) => formatItem(i, w);
  const tags = view.area.tags.length
    ? ` ${dim(`#${view.area.tags.map((t) => t.title).join(" #")}`)}`
    : "";
  const lines: string[] = [`${view.area.uuid}  ${view.area.title}${tags}`];
  lines.push(bold("── Active ──"), ...(view.active.length ? view.active.map(fmt) : ["(none)"]));
  lines.push(
    bold("── Projects ──"),
    ...(view.projects.length ? view.projects.map(fmt) : ["(none)"]),
  );
  if (view.later.scheduled.length || view.later.repeating.length || view.later.someday.length) {
    lines.push(bold("── Later ──"));
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
    lines.push(bold(`── Logged (${view.logged.length}) ──`), ...view.logged.slice(0, 10).map(fmt));
  if (view.trashed.length) lines.push(bold(`── Trashed (${view.trashed.length}) ──`));
  return lines;
}

export function registerAreaCommands(program: Command): void {
  const area = program.command("area").description("Area-scoped operations");
  area
    .command("show <ref>")
    .description(
      "Composite area view mirroring the native UI: the area's direct to-dos (active " +
        "first), its projects in sidebar order, later (scheduled/repeating/someday), " +
        "logged. Target by uuid or unique name.",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((ref: string, opts: { json?: boolean; db?: string }) => {
      withClient(
        opts,
        "area-view",
        (c) => c.read.areaView(ref),
        renderAreaView as (d: never) => string[],
      );
    });
}
