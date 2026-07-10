/**
 * `things project show <uuid>` — the composite project view.
 */
import type { Command } from "commander";

import type { Todo } from "../../model/entities.ts";
import type { ProjectView } from "../../read/project-view.ts";
import { bold, dim, underline } from "../style.ts";
import { formatItem, uuidDisplayWidth, withClient } from "./reads.ts";

/**
 * GUI parity: later rows (scheduled / repeating / someday) render INLINE
 * beneath their heading — dimmed boxes and date chips carry the state — not
 * exiled to a separate section that disassociates them from their headings.
 * `--hide-later` mirrors the GUI's toggle in its hidden position.
 */
function renderProjectView(view: ProjectView, hideLater: boolean): string[] {
  const later: Todo[] = hideLater
    ? []
    : [
        ...view.later.scheduled.flatMap((d) => d.items),
        ...view.later.repeating,
        ...view.later.someday,
      ];
  const knownHeadings = new Set(view.headings.map((g) => g.heading.uuid));
  const laterByHeading = new Map<string, Todo[]>();
  const looseLater: Todo[] = [];
  for (const item of later) {
    // A later row whose heading is absent from the view falls back to the
    // loose block rather than vanishing.
    if (item.heading !== null && knownHeadings.has(item.heading.uuid)) {
      const list = laterByHeading.get(item.heading.uuid) ?? [];
      list.push(item);
      laterByHeading.set(item.heading.uuid, list);
    } else {
      looseLater.push(item);
    }
  }
  const everyItem = [
    ...view.active,
    ...later,
    ...view.headings.flatMap((g) => g.items),
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
  const looseRows = [...view.active, ...looseLater];
  if (looseRows.length > 0) lines.push("", ...looseRows.map(fmt));
  for (const group of view.headings) {
    // Headings are the GUI's dim in-project subheads, not structural
    // sections — rendered like item rows (their uuid IS addressable:
    // heading rename/archive), title dim+underlined.
    const members = [...group.items, ...(laterByHeading.get(group.heading.uuid) ?? [])];
    lines.push(
      "",
      `${dim(group.heading.uuid.slice(0, w))}  ${dim(underline(group.heading.title))}`,
      ...(members.length > 0 ? members.map(fmt) : ["(none)"]),
    );
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
      "Composite project view mirroring the native UI: active items and headings, with scheduled/repeating/someday rows inline under their headings, then logged and trashed. Target by uuid or unique name.",
    )
    .option("--hide-later", "omit scheduled, repeating, and someday rows")
    .option("--json", "emit versioned JSON envelope on stdout")
    .option("--db <path>", "explicit database path")
    .action((ref: string, opts: { hideLater?: boolean; json?: boolean; db?: string }) => {
      withClient(opts, "project-view", (c) => c.read.projectView(ref), ((d: ProjectView) =>
        renderProjectView(d, opts.hideLater === true)) as (d: never) => string[]);
    });
}
