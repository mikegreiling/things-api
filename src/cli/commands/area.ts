/**
 * `things area show <ref>` — the composite area view (the write subcommands
 * under `things area` are registered by writes.ts on the same group).
 */
import type { Command } from "commander";

import type { AreaView } from "../../read/area-view.ts";
import { bold, dim } from "../style.ts";
import { formatItem, uuidDisplayWidth, withClient } from "./reads.ts";

/**
 * GUI parity: later rows (scheduled / repeating / someday) render inline at
 * the bottom of the Active block — dimmed boxes and date chips carry the
 * state. `--hide-later` mirrors the GUI's toggle in its hidden position.
 */
function renderAreaView(view: AreaView, hideLater: boolean): string[] {
  const later = hideLater
    ? []
    : [
        ...view.later.scheduled.flatMap((d) => d.items),
        ...view.later.repeating,
        ...view.later.someday,
      ];
  const everyItem = [...view.active, ...later, ...view.projects, ...view.logged.slice(0, 10)];
  const w = uuidDisplayWidth(everyItem);
  // Rows inside this view never repeat the area's own name.
  const fmt = (i: (typeof everyItem)[number]) => formatItem(i, w, { suppressArea: view.area.uuid });
  const fmtProject = (i: (typeof everyItem)[number]) =>
    formatItem(i, w, { projectTitle: true, suppressArea: view.area.uuid });
  const tags = view.area.tags.length
    ? ` ${dim(`#${view.area.tags.map((t) => t.title).join(" #")}`)}`
    : "";
  const lines: string[] = [`${view.area.uuid}  ${bold(view.area.title)}${tags}`];
  const section = (header: string, rows: string[]) => {
    lines.push("", bold(header), ...rows);
  };
  const activeRows = [...view.active, ...later];
  section("── Active ──", activeRows.length ? activeRows.map(fmt) : ["(none)"]);
  section("── Projects ──", view.projects.length ? view.projects.map(fmtProject) : ["(none)"]);
  if (view.logged.length)
    section(`── Logged (${view.logged.length}) ──`, view.logged.slice(0, 10).map(fmt));
  if (view.trashed.length) lines.push("", bold(`── Trashed (${view.trashed.length}) ──`));
  return lines;
}

export function registerAreaCommands(program: Command): void {
  const area = program.command("area").description("Area-scoped operations");
  area
    .command("show <ref>")
    .description(
      "Composite area view mirroring the native UI: the area's direct to-dos (active " +
        "first, scheduled/repeating/someday inline after), its projects in sidebar " +
        "order, logged. Target by uuid or unique name.",
    )
    .option("--hide-later", "omit scheduled, repeating, and someday rows")
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((ref: string, opts: { hideLater?: boolean; json?: boolean; db?: string }) => {
      withClient(opts, "area-view", (c) => c.read.areaView(ref), ((d: AreaView) =>
        renderAreaView(d, opts.hideLater === true)) as (d: never) => string[]);
    });
}
